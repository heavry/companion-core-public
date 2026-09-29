import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-memory-gate-test-"));
const data=path.join(root,"data");
fs.mkdirSync(data,{recursive:true});
process.env.DATABASE_PATH=path.join(data,"companion.db");
process.env.COMPANION_INSTANCE_ID_PATH=path.join(data,"instance-identity.json");
process.env.COMPANION_PRIMARY_LOCK_PATH=path.join(data,"primary.lock");
process.env.COMPANION_HOST="127.0.0.1";
process.env.COMPANION_PORT="18779";
process.env.EMBEDDING_ENABLED="false";
process.env.AUTO_PROMOTE_MEMORY="0";
process.env.PERSONA_SYNC_ON_START="false";

const [{insertMemory,getMemory,listRecentMemoriesAnyStatus,getOrCreateSession,insertMessage,db},{applyMemoryCorrection,memoryCorrectionDiagnostics},{addStagingMemoryDetailed,retrieveMemoriesDetailed},{memoryGate},{classifyMemoryCorrection},{memoryRetrievalQuery,selectMemoriesForGeneration,memorySelectionDiagnostics},{textSimilarity}]=await Promise.all([
  import("../src/db.js"),import("../src/memory-correction.js"),import("../src/memory.js"),import("../src/memory-gate.js"),import("../src/memory-correction-classifier.js"),import("../src/memory-selection.js"),import("../src/utils.js")
]);

const personaId="memory-gate-fixture";
const add=(content,{status="active",type="fact",confidence=0.8,importance=0.6,pinned=false}={})=>insertMemory({personaId,content,status,type,confidence,importance,pinned,source:"fixture"});

try{
  const cousin=add("我表弟叫周小舟",{type:"relationship",confidence:0.82,importance:0.65});
  const irrelevant=[
    add("我那辆车一直没还",{confidence:0.98,importance:1,pinned:true}),
    add("我准备买打印机",{confidence:0.98,importance:1,pinned:true}),
    add("我之前关注 DGX 工作站",{confidence:0.98,importance:1,pinned:true})
  ];
  const query="我表弟叫什么？";
  const rows=[cousin,...irrelevant].map((memory,index)=>({memory,embedding_score:index?0.96:0.61,text_score:index?0:textSimilarity(query,memory.content),in_context:true}));
  const selected=selectMemoriesForGeneration(rows,{query,max:2});
  assert.deepEqual(selected.map(row=>row.memory.id),[cousin.id],"only the current entity fact passes the gate; pinned and high-importance side memories do not");

  const longQuery="我之前喜欢什么键盘？ COMPAT_CONTEXT_CHECK COMPAT_SHARED_EVENT";
  const keyboard=add("用户喜欢机械键盘",{confidence:0.9,importance:0.8});
  const longQuerySelection=selectMemoriesForGeneration([
    {memory:keyboard,text_score:textSimilarity(longQuery,keyboard.content)},
    ...irrelevant.map(memory=>({memory,embedding_score:0.96,text_score:textSimilarity(longQuery,memory.content)}))
  ],{query:longQuery,max:2});
  assert.deepEqual(longQuerySelection.map(row=>row.memory.id),[keyboard.id],"a long query still selects the exact fact despite auxiliary markers");

  const unknown=selectMemoriesForGeneration(irrelevant.map(memory=>({memory,embedding_score:0.99,text_score:0})),{query:"我表弟的生日是什么时候？",max:2});
  assert.equal(unknown.length,0,"unrelated high-semantic candidates may yield zero memory");

  const duplicate1={id:"dup1",content:"我表弟叫周小舟",status:"active",confidence:0.9,importance:0.7};
  const duplicate2={id:"dup2",content:"我表弟叫周小川",status:"active",confidence:0.65,importance:0.6};
  const duplicates=selectMemoriesForGeneration([duplicate1,duplicate2].map(memory=>({memory,text_score:0.8})),{query,max:2});
  assert.equal(duplicates.length,1,"conflicting values for one fact slot are not both injected");
  assert.equal(duplicates[0].memory.id,"dup1","the higher-confidence current slot wins");

  const retired={id:"retired-fixture",content:"我表弟叫周小舟",status:"retired",confidence:0.99,importance:1,pinned:true};
  const retiredSelection=selectMemoriesForGeneration([{memory:retired,embedding_score:1,text_score:1}],{query,max:2});
  assert.equal(retiredSelection.length,0,"retired memories are never injected even with a perfect candidate score");

  const planQuestion="我现在准备买哪个？";
  assert.match(memoryRetrievalQuery(planQuestion),/用户计划买/u,"an underspecified current purchase query gets a narrow retrieval alias");
  assert.equal(memoryRetrievalQuery("我今晚吃什么？"),"我今晚吃什么？","unrelated queries are not expanded");
  const currentPlan={id:"current-plan",content:"用户计划买 K1C",status:"active",type:"project",temporal_state:"current",confidence:0.94,importance:0.85};
  const futurePrinter={id:"future-printer",content:"我以后想买一台打印机",status:"active",type:"project",temporal_state:"current",confidence:0.98,importance:1,pinned:true};
  const planSelection=selectMemoriesForGeneration([{memory:currentPlan},{memory:futurePrinter}],{query:planQuestion,max:2});
  assert.deepEqual(planSelection.map(row=>row.memory.id),[currentPlan.id],"the current plan slot selects its matching durable fact without pulling in a possible future purchase");

  const swap=classifyMemoryCorrection("不是周小舟，是周小川。");
  assert.equal(swap?.kind,"fact_correction");
  const session=getOrCreateSession(personaId,"chat","self-fix-fixture");
  insertMessage(session.id,"chat",{role:"user",content:"我表弟叫林小糖"});
  const selfFixOld=add("我表弟叫林小糖");
  const selfFix=await applyMemoryCorrection({personaId,sessionId:session.id,userText:"我刚才说错了，是林晓棠。"});
  assert.equal(selfFix.applied,true,"explicit self-correction uses recent user context to identify the old slot");
  assert.equal(getMemory(selfFixOld.id).status,"retired");
  assert.ok(listRecentMemoriesAnyStatus(personaId,100).some(memory=>memory.content==="我表弟叫林晓棠"&&memory.status==="active"&&memory.confidence>=0.95));

  const factOld=cousin;
  const factCorrection=await applyMemoryCorrection({personaId,userText:"不是周小舟，是周小川。"});
  assert.equal(factCorrection.applied,true);
  assert.equal(getMemory(factOld.id).status,"retired");
  assert.equal(getMemory(factOld.id).temporal_state,"historical");
  const currentCousin=listRecentMemoriesAnyStatus(personaId,100).find(memory=>memory.content==="我表弟叫周小川"&&memory.status==="active");
  assert.ok(currentCousin&&currentCousin.confidence>=0.95,"corrected fact is current and high-confidence");
  const retrieval=await retrieveMemoriesDetailed(personaId,query,{limit:20,candidateLimit:100});
  assert.equal(retrieval.some(row=>row.memory.id===factOld.id),false,"retired fact is absent from vector/FTS/text retrieval");
  assert.equal(retrieval.some(row=>row.memory.id===currentCousin.id),true);
  const oldDuplicate=await addStagingMemoryDetailed({personaId,content:"我表弟叫周小舟",type:"fact",importance:0.9,source:"summary"});
  assert.equal(oldDuplicate.suppressed,true,"re-extracted old wording cannot reactivate a retired fact even if extraction changes its type");
  assert.equal(getMemory(factOld.id).status,"retired");
  assert.equal(listRecentMemoriesAnyStatus(personaId,100).filter(memory=>memory.content==="我表弟叫周小舟"&&memory.status==="active").length,0);

  const ambiguous=await applyMemoryCorrection({personaId,userText:"好像不是周小川吧，我也不确定。"});
  assert.equal(ambiguous.detected,true);
  assert.equal(ambiguous.applied,false);
  assert.equal(getMemory(currentCousin.id).status,"active","ambiguous phrasing cannot retire or replace the current fact");
  assert.ok(getMemory(currentCousin.id).confidence<=0.52,"ambiguous phrasing lowers confidence instead of asserting a new fact");
  assert.equal(memoryCorrectionDiagnostics.ambiguousDestructiveOverwrite,0);
  assert.equal(memoryCorrectionDiagnostics.oldFactResurrection,0);

  const planOld=add("用户计划买 A1",{type:"project",confidence:0.78});
  const planClass=classifyMemoryCorrection("我之前想买A1，现在不买了，准备买K1C。");
  assert.equal(planClass?.kind,"plan_change");
  assert.equal(planClass.from,"A1");
  assert.equal(planClass.to,"K1C");
  const plan=await applyMemoryCorrection({personaId,userText:"我之前想买A1，现在不买了，准备买K1C。"});
  assert.equal(plan.applied,true);
  assert.equal(getMemory(planOld.id).status,"retired");
  assert.equal(getMemory(planOld.id).content,"用户计划买 A1","historical consideration is retained unchanged");
  assert.ok(listRecentMemoriesAnyStatus(personaId,100).some(memory=>memory.content==="用户计划买 K1C"&&memory.status==="active"&&memory.temporal_state==="current"));

  for(const text of ["以后可能买个打印机。","如果明天下雨我就不去了。","我觉得晚上会下雨。","也许过两天再说。","我想以后学一下 Blender。"]){
    assert.equal(memoryGate(text).hit,false,`weak possibility/conditional must not enter immediate memory capture: ${text}`);
  }
  assert.ok(memorySelectionDiagnostics.duplicateInjectionCount>=1);
  assert.ok(memorySelectionDiagnostics.zeroMemorySelectionCount>=2);
  assert.ok(memorySelectionDiagnostics.retiredMemoryInjectionCount>=1);
  console.log(JSON.stringify({ok:true,selection:{candidateCount:memorySelectionDiagnostics.candidateCount,selectedMemoryCount:memorySelectionDiagnostics.selectedMemoryCount,zeroMemorySelectionCount:memorySelectionDiagnostics.zeroMemorySelectionCount,duplicateInjectionCount:memorySelectionDiagnostics.duplicateInjectionCount,retiredMemoryInjectionCount:memorySelectionDiagnostics.retiredMemoryInjectionCount},correction:{correctionDetected:memoryCorrectionDiagnostics.correctionDetected,correctionApplied:memoryCorrectionDiagnostics.correctionApplied,oldFactRetired:memoryCorrectionDiagnostics.oldFactRetired,newFactActive:memoryCorrectionDiagnostics.newFactActive,ambiguousCorrection:memoryCorrectionDiagnostics.ambiguousCorrection,ambiguousDestructiveOverwrite:memoryCorrectionDiagnostics.ambiguousDestructiveOverwrite,oldFactResurrection:memoryCorrectionDiagnostics.oldFactResurrection,retiredDuplicateSuppressed:memoryCorrectionDiagnostics.retiredDuplicateSuppressed}}));
}finally{
  try{db.close();}catch{}
  fs.rmSync(root,{recursive:true,force:true});
}
