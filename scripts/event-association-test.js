import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-event-association-"));
fs.mkdirSync(path.join(root,"data"),{recursive:true});
process.env.DATABASE_PATH=path.join(root,"data","companion.db");
process.env.COMPANION_INSTANCE_ID_PATH=path.join(root,"data","instance-identity.json");
process.env.COMPANION_PRIMARY_LOCK_PATH=path.join(root,"data","primary.lock");
process.env.COMPANION_HOST="127.0.0.1";
process.env.COMPANION_PORT="18788";
process.env.COMPANION_INSTANCE_ID="event-association-test";
process.env.EMBEDDING_ENABLED="false";
process.env.AUTO_PROMOTE_MEMORY="0";
process.env.PERSONA_SYNC_ON_START="false";
process.env.COMPANION_NATURAL_COGNITION_ENABLED="false";
process.env.COMPANION_NATURAL_PRESENCE_ENABLED="false";

const [dbmod,association,selection,context]=await Promise.all([
  import("../src/db.js"),import("../src/event-association.js"),import("../src/memory-selection.js"),import("../src/context.js")
]);
const {db,SCHEMA_VERSION,getSqliteStatus,getOrCreateSession,insertMessage,insertMemory,updateMemory,insertEventDetailed,
  linkEventToMemory,insertEventAssociation,listEventAssociatedMemories,listEventMemoryLinksForMemory}=dbmod;
const {createEventForMemoryCandidate,createCorrectionEventForMemory,createCurrentEventAssociations,
  createExpectationTransitionEvents,createTrustedEventAssociations,associatedMemoryCandidatesForMessage,
  createOpenLoopEvents,eventAssociationDiagnostics,resetEventAssociationDiagnostics}=association;
const {selectMemoriesForGeneration,memorySelectionDiagnostics,resetMemorySelectionDiagnostics}=selection;
const {buildInjectedMessages}=context;
const persona={id:"event-association-test",name:"测试",core_identity:"测试角色",personality:[],
  speaking_style:{tone:"自然",verbosity:"简短",emoji_frequency:"少",rules:[]},
  mode_instructions:{chat:"chat",agent:"agent",summary:"summary"},
  memory:{enabled:true,chat_retrieval_limit:8,agent_retrieval_limit:8}};
const passed=[];
const sessionFor=name=>getOrCreateSession(`ea-${name}`,"chat",`event-association-${name}`);
const user=(session,text)=>insertMessage(session.id,"chat",{role:"user",content:text});
const assistant=(session,text)=>insertMessage(session.id,"chat",{role:"assistant",content:text});
function event(session,text,{sourceMessageId=null,eventKind="event",topicKey=null,entityKeys=[],expectationId=null,importance=0.8,source="fixture"}={}){
  const result=insertEventDetailed({personaId:session.persona_id,sessionId:session.id,source,content:text,importance,sourceMessageId,eventKind,topicKey,entityKeys,expectationId});
  return result.event;
}
function memory(personaId,content,sourceMessageId=null,{type="fact",importance=0.8,confidence=0.95,status="active",temporalState="current"}={}){
  return insertMemory({personaId,content,sourceMessageId,type,importance,confidence,status,temporalState,source:"fixture"});
}
async function scenario(name,fn){await fn();passed.push(name);}

try{
  await scenario("v6 additive schema and unmapped legacy rows",async()=>{
    assert.equal(SCHEMA_VERSION,6);
    assert.equal(getSqliteStatus().user_version,6);
    const memoryColumns=db.prepare("PRAGMA table_info(memories)").all().map(row=>row.name);
    const eventColumns=db.prepare("PRAGMA table_info(events)").all().map(row=>row.name);
    assert.ok(memoryColumns.includes("source_message_id"));
    assert.ok(["source_message_id","event_kind","topic_key","entity_keys_json","expectation_id"].every(key=>eventColumns.includes(key)));
    const s=sessionFor("legacy"),legacy=memory(s.persona_id,"旧 Memory 没有可证明的消息来源");
    assert.equal(legacy.source_message_id,null);
    assert.equal(listEventMemoryLinksForMemory(legacy.id).length,0,"no history link is backfilled");
  });

  let a1Session,a1Memory,a1CurrentMessage;
  await scenario("A1 and DGX exact-source link reaches the existing Memory Gate",async()=>{
    resetEventAssociationDiagnostics();resetMemorySelectionDiagnostics();
    a1Session=sessionFor("a1-budget");
    const oldSource=user(a1Session,"我打算把 A1 和 DGX 的预算一起算。"),oldEvent=event(a1Session,"A1 / DGX 预算计划",{sourceMessageId:oldSource,eventKind:"project",topicKey:"预算",entityKeys:["A1","DGX"]});
    a1Memory=memory(a1Session.persona_id,"我的设备计划是 A1 和 DGX 共用一笔预算",oldSource,{type:"project"});
    assert.ok(createEventForMemoryCandidate({memory:a1Memory,sourceMessageId:oldSource,sessionId:a1Session.id,topicKey:"预算",entityKeys:["A1","DGX"]}));
    const text="A1 降价了，我又在看 DGX 预算。";
    a1CurrentMessage=user(a1Session,text);
    const current=createCurrentEventAssociations({personaId:a1Session.persona_id,sessionId:a1Session.id,sourceMessageId:a1CurrentMessage,text});
    assert.ok(current?.edgeCount>=1);
    const candidates=associatedMemoryCandidatesForMessage(a1Session.persona_id,a1CurrentMessage);
    assert.ok(candidates.some(row=>row.memory.id===a1Memory.id));
    assert.equal(candidates.find(row=>row.memory.id===a1Memory.id).association.hop,1);
    assert.ok(candidates.find(row=>row.memory.id===a1Memory.id).association.activation_score>=0.55);
    const injected=await buildInjectedMessages({persona:{...persona,id:a1Session.persona_id},ctx:{mode:"chat"},sessionId:a1Session.id,
      clientMessages:[{role:"user",content:text}],currentMessageId:a1CurrentMessage});
    assert.ok(injected.some(item=>String(item.content??"").includes(a1Memory.content)),JSON.stringify({lastReasons:memorySelectionDiagnostics.lastReasons,association:eventAssociationDiagnostics.lastSelectedAssociationCount,selected:memorySelectionDiagnostics.lastSelectedCount}));
    assert.ok(memorySelectionDiagnostics.lastReasons.some(row=>row.id===a1Memory.id&&row.association));
    assert.ok(db.prepare("SELECT 1 FROM event_memory_links WHERE memory_id=?").get(a1Memory.id));
    assert.equal(eventAssociationDiagnostics.maxHop,1);
  });

  await scenario("legacy Memory keeps direct retrieval without a graph link",async()=>{
    const s=sessionFor("legacy-direct"),legacy=memory(s.persona_id,"我喜欢吃榴莲冰淇淋");
    const retrieved=await import("../src/memory.js").then(module=>module.retrieveMemoriesDetailed(s.persona_id,"我喜欢吃榴莲冰淇淋",{limit:5,candidateLimit:20}));
    const gated=selectMemoriesForGeneration(retrieved,{query:"我喜欢吃榴莲冰淇淋",max:2});
    assert.ok(gated.some(row=>row.memory.id===legacy.id));
    assert.equal(associatedMemoryCandidatesForMessage(s.persona_id,user(s,"今天吃了面。" )).length,0);
  });

  await scenario("invalid source, cross-session and assistant provenance cannot form links",async()=>{
    const s=sessionFor("source-validation"),other=sessionFor("source-validation-other");
    const assistantId=assistant(s,"助手说 A1 很好");
    const badEvent=event(s,"assistant sourced event",{sourceMessageId:assistantId,entityKeys:["A1"]});
    assert.equal(badEvent.source_message_id,null);
    const wrongSessionId=user(other,"A1 预算");
    const wrongSessionEvent=insertEventDetailed({personaId:s.persona_id,sessionId:s.id,source:"fixture",content:"wrong session event",sourceMessageId:wrongSessionId,eventKind:"project",entityKeys:["A1"]}).event;
    assert.equal(wrongSessionEvent.source_message_id,null);
    const actualId=user(s,"我的 A1 计划");
    const actualEvent=event(s,"actual",{sourceMessageId:actualId,entityKeys:["A1"]});
    const otherPersonaMemory=memory(other.persona_id,"另一用户的 A1 计划",actualId,{type:"project"});
    assert.equal(linkEventToMemory(actualEvent.id,otherPersonaMemory.id),false);
    assert.equal(insertEventAssociation({personaId:s.persona_id,fromEventId:badEvent.id,toEventId:actualEvent.id,relationType:"same_entity",evidenceMessageId:actualId}),false);
  });

  await scenario("one-hop activation never follows A to B to C",async()=>{
    const s=sessionFor("one-hop"),bId=user(s,"B1 事件同时提到 A1 和 B1"),cId=user(s,"C1 事件同时提到 B1 和 C1");
    const b=event(s,"B1",{sourceMessageId:bId,entityKeys:["A1","B1"]}),c=event(s,"C1",{sourceMessageId:cId,entityKeys:["B1","C1"]});
    const mb=memory(s.persona_id,"B 对应的有效记忆",bId),mc=memory(s.persona_id,"C 对应的有效记忆",cId);
    assert.ok(linkEventToMemory(b.id,mb.id));assert.ok(linkEventToMemory(c.id,mc.id));
    assert.ok(insertEventAssociation({personaId:s.persona_id,fromEventId:b.id,toEventId:c.id,relationType:"same_entity",evidenceMessageId:bId}),JSON.stringify({b,c,bId,bSource:dbmod.getVerifiedUserSource(s.persona_id,bId,s.id),cSource:dbmod.getVerifiedUserSource(s.persona_id,cId,s.id)}));
    const msgA=user(s,"A1 项目上线了更新。"),text="A1 项目上线了更新。";
    const current=createCurrentEventAssociations({personaId:s.persona_id,sessionId:s.id,sourceMessageId:msgA,text});
    assert.ok(current?.edges.some(edge=>edge.related_event_id===b.id));
    const oneHop=associatedMemoryCandidatesForMessage(s.persona_id,msgA);
    assert.ok(oneHop.some(row=>row.memory.id===mb.id),"A activates its directly related Event B");
    assert.equal(oneHop.some(row=>row.memory.id===mc.id),false);
  });

  await scenario("expectation creation and completion connect by exact expectation id",async()=>{
    const {NaturalCognitionStore}=await import("../src/natural-cognition/store.js");
    const cognition=new NaturalCognitionStore({file:path.join(root,"data","cognition-fixture.json"),enabled:true});
    const s=sessionFor("expectation"),createId=user(s,"我晚上会回来告诉你测试结果。");
    const expectation=cognition.upsertExpectation({topic:"晚上回来汇报结果",expectedInformation:"return",sourceMessageId:createId,
      salience:0.8,reason:"user_initiated",nextExpectedActor:"user",followupKind:"awaiting_user_update",userText:"我晚上会回来告诉你测试结果。"});
    assert.ok(expectation?.id);
    const created=createExpectationTransitionEvents({personaId:s.persona_id,sessionId:s.id,sourceMessageId:createId,text:"我晚上会回来告诉你测试结果。",transitions:[expectation]});
    const linked=memory(s.persona_id,"我答应晚上回来报告测试结果",createId,{type:"commitment"});
    assert.ok(linkEventToMemory(created[0].id,linked.id));
    const doneId=user(s,"我太累睡着了，没能回来汇报。");
    const violatedIds=cognition.violateExpectations("我太累睡着了，没能回来汇报。");
    assert.deepEqual(violatedIds,[expectation.id]);
    const violated=cognition.document.expectations.find(item=>item.id===expectation.id);
    assert.equal(violated.state,"violated");
    assert.equal(cognition.activeExpectations().some(item=>item.id===expectation.id),false);
    const completed=createExpectationTransitionEvents({personaId:s.persona_id,sessionId:s.id,sourceMessageId:doneId,text:"我太累睡着了，没能回来汇报。",transitions:[violated]});
    assert.ok(completed.length);
    const edge=db.prepare("SELECT relation_type FROM event_associations WHERE from_event_id=? AND to_event_id=?").get(completed[0].id,created[0].id);
    assert.equal(edge?.relation_type,"expectation_related");
    assert.ok(associatedMemoryCandidatesForMessage(s.persona_id,doneId).some(row=>row.memory.id===linked.id));
  });

  await scenario("correction creates a supersedes record without reactivating the retired fact",async()=>{
    const s=sessionFor("correction"),oldId=user(s,"我表弟叫周小舟。"),old=memory(s.persona_id,"我表弟叫周小舟",oldId,{type:"relationship"});
    const oldEvent=createEventForMemoryCandidate({memory:old,sourceMessageId:oldId,sessionId:s.id,entityKeys:["周小舟"]});
    assert.ok(oldEvent,"an explicitly sourced relationship Memory receives a direct Event link");
    updateMemory(old.id,{status:"retired",temporalState:"historical"});
    const newId=user(s,"不是周小舟，是周小川。"),next=memory(s.persona_id,"我表弟叫周小川",newId,{type:"relationship",confidence:0.99});
    const result=createCorrectionEventForMemory({personaId:s.persona_id,sessionId:s.id,sourceMessageId:newId,newMemoryId:next.id,oldMemoryId:old.id});
    assert.ok(result?.supersededEventCount===1);
    assert.equal(db.prepare("SELECT relation_type FROM event_associations WHERE from_event_id=? AND to_event_id=?").get(result.event.id,oldEvent.id)?.relation_type,"supersedes");
    const activated=associatedMemoryCandidatesForMessage(s.persona_id,newId);
    assert.equal(activated.some(row=>row.memory.id===old.id),false);
    assert.equal(selectMemoriesForGeneration(activated,{query:"不是周小舟，是周小川",max:2}).some(row=>row.memory.id===old.id),false);
    assert.equal((await import("../src/db.js")).getMemory(old.id).status,"retired");
    assert.equal((await import("../src/db.js")).getMemory(next.id).status,"active");
  });

  await scenario("plan correction preserves A1 history and activates only the K1C event",async()=>{
    const s=sessionFor("plan"),oldId=user(s,"我准备买 A1，预算还不够。");
    const old=memory(s.persona_id,"用户计划买 A1",oldId,{type:"project"}),oldEvent=event(s,"用户计划买 A1",{sourceMessageId:oldId,eventKind:"project",topicKey:"A1",entityKeys:["A1"]});
    assert.ok(linkEventToMemory(oldEvent.id,old.id));updateMemory(old.id,{status:"retired",temporalState:"historical"});
    const correctionId=user(s,"我之前想买 A1，现在不买了，准备买 K1C。");
    const next=memory(s.persona_id,"用户当前计划买 K1C",correctionId,{type:"project",confidence:0.99});
    const correction=createCorrectionEventForMemory({personaId:s.persona_id,sessionId:s.id,sourceMessageId:correctionId,newMemoryId:next.id,oldMemoryId:old.id,sourceEntityKey:"K1C"});
    assert.equal(correction.supersededEventCount,1);
    const currentText="K1C 最近降价了。",currentId=user(s,currentText);
    assert.ok(createCurrentEventAssociations({personaId:s.persona_id,sessionId:s.id,sourceMessageId:currentId,text:currentText})?.edgeCount>=1);
    const candidates=associatedMemoryCandidatesForMessage(s.persona_id,currentId);
    assert.ok(candidates.some(row=>row.memory.id===next.id));
    assert.equal(candidates.some(row=>row.memory.id===old.id),false);
    assert.equal((await import("../src/db.js")).getMemory(old.id).temporal_state,"historical");
  });

  await scenario("old physics exam activates only through a shared explicit entity",async()=>{
    const s=sessionFor("exam"),oldId=user(s,"我上次物理考试考得很差。"),old=memory(s.persona_id,"上次物理考试让我很受挫",oldId,{type:"event"});
    const oldEvent=event(s,"上次物理考试考得很差",{sourceMessageId:oldId,eventKind:"exam_outcome",topicKey:"物理考试",entityKeys:["物理"]});
    assert.ok(linkEventToMemory(oldEvent.id,old.id));
    const text="明天又要考物理了。",currentId=user(s,text);
    assert.ok(createCurrentEventAssociations({personaId:s.persona_id,sessionId:s.id,sourceMessageId:currentId,text}));
    assert.ok(associatedMemoryCandidatesForMessage(s.persona_id,currentId).some(row=>row.memory.id===old.id));
  });

  await scenario("unrelated lunch produces zero association",async()=>{
    const s=sessionFor("unrelated");
    for(const key of ["打印机","DGX","眼镜"]){
      const id=user(s,`我最近在看${key}。`),e=event(s,`${key}计划`,{sourceMessageId:id,eventKind:"project",topicKey:key,entityKeys:[key]});
      const m=memory(s.persona_id,`${key}是我最近关注的项目`,id,{type:"project"});assert.ok(linkEventToMemory(e.id,m.id));
    }
    const text="今天中午吃了碗面。",id=user(s,text);
    assert.equal(createCurrentEventAssociations({personaId:s.persona_id,sessionId:s.id,sourceMessageId:id,text}),null);
    assert.equal(associatedMemoryCandidatesForMessage(s.persona_id,id).length,0);
  });

  await scenario("Mac, Windows, GPU and DGX similarity does not create permanent edges",async()=>{
    const s=sessionFor("similarity"),oldId=user(s,"我在比较 Mac、Windows、GPU 和 DGX。"),old=event(s,"Mac Windows GPU DGX",{sourceMessageId:oldId,eventKind:"project",entityKeys:["Mac","Windows","GPU","DGX"]});
    const currentId=user(s,"Mac 系统更新了。"),current=event(s,"Mac 系统更新",{sourceMessageId:currentId,eventKind:"milestone",topicKey:"系统更新",entityKeys:["系统更新"]});
    assert.equal(createTrustedEventAssociations(current).length,0);
    assert.equal(insertEventAssociation({personaId:s.persona_id,fromEventId:current.id,toEventId:old.id,relationType:"same_entity",evidenceMessageId:currentId}),false);
    assert.equal(associatedMemoryCandidatesForMessage(s.persona_id,currentId).length,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM event_associations WHERE from_event_id=?").get(current.id).n,0);
  });

  await scenario("a direct event has a hard five-edge cap",async()=>{
    const s=sessionFor("edge-cap");
    for(let i=0;i<7;i++){
      const id=user(s,`A1 项目第 ${i} 次记录`);event(s,`A1 project ${i}`,{sourceMessageId:id,eventKind:"project",topicKey:"A1",entityKeys:["A1"],importance:0.9-i*0.01});
    }
    const text="A1 降价了。",id=user(s,text),result=createCurrentEventAssociations({personaId:s.persona_id,sessionId:s.id,sourceMessageId:id,text});
    assert.ok(result?.edgeCount<=5);
    assert.ok(Number(db.prepare("SELECT COUNT(*) n FROM event_associations WHERE from_event_id=?").get(result.eventId).n)<=5);
    assert.ok(eventAssociationDiagnostics.graphExplosionCount>=1);
  });

  await scenario("associated candidates are capped at five and final Memory injection at two",async()=>{
    const s=sessionFor("memory-cap");
    for(let i=0;i<7;i++){
      const sourceId=user(s,`K1C 计划预算记录 ${i}`),old=event(s,`K1C project ${i}`,{sourceMessageId:sourceId,eventKind:"project",topicKey:"K1C",entityKeys:["K1C"]});
      const item=memory(s.persona_id,`第 ${i} 项安排里用户计划买 K1C`,sourceId,{type:"project"});assert.ok(linkEventToMemory(old.id,item.id));
    }
    const text="K1C 价格变了。",currentId=user(s,text),created=createCurrentEventAssociations({personaId:s.persona_id,sessionId:s.id,sourceMessageId:currentId,text});
    assert.ok(created?.edgeCount<=5);
    const candidates=associatedMemoryCandidatesForMessage(s.persona_id,currentId);
    assert.ok(candidates.length<=5);
    const selected=selectMemoriesForGeneration(candidates,{query:text,max:2,candidateCount:candidates.length});
    assert.ok(selected.length<=2);
    assert.equal(new Set(selected.map(row=>row.memory.id)).size,selected.length);
  });

  await scenario("duplicate source events and edges are idempotent",async()=>{
    const s=sessionFor("duplicate"),oldId=user(s,"A1 budget event"),old=event(s,"A1 budget event",{sourceMessageId:oldId,eventKind:"project",topicKey:"A1",entityKeys:["A1"]});
    const currentId=user(s,"A1 降价了。"),text="A1 降价了。";
    const first=createCurrentEventAssociations({personaId:s.persona_id,sessionId:s.id,sourceMessageId:currentId,text});
    const eventCount1=db.prepare("SELECT COUNT(*) n FROM events WHERE source_message_id=?").get(currentId).n;
    createCurrentEventAssociations({personaId:s.persona_id,sessionId:s.id,sourceMessageId:currentId,text});
    const eventCount2=db.prepare("SELECT COUNT(*) n FROM events WHERE source_message_id=?").get(currentId).n;
    assert.equal(eventCount2,eventCount1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM event_associations WHERE from_event_id=? AND to_event_id=?").get(first.eventId,old.id).n,1);
    assert.ok(eventAssociationDiagnostics.duplicateAssociationCount>=1);
  });

  await scenario("focus and embedding similarity alone cannot produce an edge",async()=>{
    const s=sessionFor("focus"),oldId=user(s,"我还在考虑打印机。"),old=event(s,"打印机预算",{sourceMessageId:oldId,eventKind:"project",topicKey:"打印机",entityKeys:[]});
    const oldMemory=memory(s.persona_id,"我还在考虑打印机预算",oldId,{type:"project"});assert.ok(linkEventToMemory(old.id,oldMemory.id));
    const currentId=user(s,"我现在想聊打印机。"),current=event(s,"打印机话题",{sourceMessageId:currentId,eventKind:"milestone",topicKey:"打印机",entityKeys:[]});
    assert.ok(createTrustedEventAssociations(current).some(edge=>edge.relation_type==="same_topic"));
    const loopId=user(s,"打印机我先等等，还得看一下预算。");
    const loopEvents=createOpenLoopEvents({personaId:s.persona_id,sessionId:s.id,sourceMessageId:loopId,text:"打印机我先等等，还得看一下预算。",
      loops:[{id:"loop-fixture",topic:"打印机",source_message_id:String(loopId),salience:0.8}]});
    assert.ok(loopEvents.length);
    assert.ok(associatedMemoryCandidatesForMessage(s.persona_id,loopId).some(row=>row.memory.id===oldMemory.id));
    const proactiveContext=await buildInjectedMessages({persona:{...persona,id:s.persona_id},ctx:{mode:"chat"},sessionId:s.id,
      clientMessages:[{role:"user",content:"打印机后续怎么样？"}],currentMessageId:loopId});
    assert.ok(proactiveContext.some(item=>String(item.content??"").includes(oldMemory.content)),"an already-selected open-loop context may add a gated associated Memory");
    const focusOnly=event(s,"focus-only",{sourceMessageId:user(s,"当前焦点是 DGX"),eventKind:"focus",topicKey:null,entityKeys:[]});
    const countBefore=db.prepare("SELECT COUNT(*) n FROM event_associations WHERE from_event_id=?").get(focusOnly.id).n;
    assert.equal(countBefore,0,"focus metadata is not persisted as an event relation");
    assert.ok(old);
  });

  assert.equal(eventAssociationDiagnostics.maxHop,1);
  assert.equal(eventAssociationDiagnostics.embeddingOnlyPermanentEdgeCount,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM event_associations WHERE relation_type IN ('caused_by','result_of','contradicts')").get().n,0);
  console.log(JSON.stringify({ok:true,scenario_count:passed.length,scenarios:passed,
    event_association:{...eventAssociationDiagnostics,limits:association.eventAssociationLimits()},
    memory_selection:{...memorySelectionDiagnostics}}));
}finally{
  try{db.close();}catch{}
  fs.rmSync(root,{recursive:true,force:true});
}
