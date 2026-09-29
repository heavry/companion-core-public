import {
  getVerifiedUserSource,getMemory,listRecentEvents,listEventsForSourceMessage,listEventMemoryLinksForMemory,
  insertEventDetailed,insertEventAssociation,getEventAssociation,linkEventToMemory,listEventAssociatedMemories
} from "./db.js";

const MAX_DIRECT_EVENTS=5;
const MAX_ASSOCIATED_MEMORIES=5;
const MAX_EDGES_PER_EVENT=5;
const RELATIONS=new Set(["same_entity","same_topic","related_plan","supersedes","expectation_related"]);

export const eventAssociationDiagnostics={
  currentEventCount:0,directEventCandidateCount:0,associationCandidateCount:0,
  activatedOneHopCount:0,selectedAssociationCount:0,zeroAssociationCount:0,maxHop:1,
  retiredEventActivationCount:0,contradictionActivationCount:0,irrelevantAssociationCount:0,
  duplicateAssociationCount:0,graphExplosionCount:0,embeddingOnlyPermanentEdgeCount:0,
  lastDirectEventCount:0,lastAssociatedMemoryCount:0,lastSelectedAssociationCount:0
};

function cleanKeys(values){
  return [...new Set((Array.isArray(values)?values:[]).map(value=>String(value??"").trim().slice(0,80)).filter(value=>value.length>=2))].slice(0,8);
}
function parseKeys(value){try{return cleanKeys(JSON.parse(value??"[]"));}catch{return [];}}
function literalIn(text,key){
  const source=String(text??""),needle=String(key??"");
  if(!needle)return false;
  if(/^[A-Za-z0-9][A-Za-z0-9+.#_-]*$/u.test(needle)){
    return new RegExp(`(^|[^A-Za-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?=$|[^A-Za-z0-9])`,"iu").test(source);
  }
  return source.includes(needle);
}
function eventKindForCurrentText(text){
  const value=String(text??"");
  if(/降价|便宜(?:了|一些|不少|很多)?|涨价|价格.{0,5}(?:变|降|涨)/u.test(value))return "price_change";
  if(/改成|换成|改为|改主意|取消|不买了|转而|重新决定/u.test(value))return "plan_change";
  if(/买了|买下|下单|决定买|选定/u.test(value))return "purchase_decision";
  if(/明天.{0,8}考|后天.{0,8}考|又要考|要考.{0,8}(?:物理|数学|英语|化学|考试)/u.test(value))return "exam_upcoming";
  if(/考砸|没考好|考得.{0,6}(?:差|不好)|通过了|没通过|出结果|结果出来/u.test(value))return "exam_outcome";
  if(/完成了|搞定了|失败了|成功了|发布了|上线了|结果是/u.test(value))return "milestone";
  return null;
}
function eventLabel(kind,keys){
  const subject=keys.slice(0,2).join("、");
  const labels={price_change:"价格变化",plan_change:"计划变化",purchase_decision:"购买决定",exam_upcoming:"考试安排",exam_outcome:"考试结果",milestone:"进展结果"};
  return `${subject}${labels[kind]??"事件"}`.slice(0,180);
}
function explicitCausalText(text){return /因为|由于|为了|所以|预算|攒钱|先.{1,16}再|等.{1,16}之后/u.test(String(text??""));}

function verifiedEventSource(personaId,event){
  if(!event?.source_message_id)return null;
  return getVerifiedUserSource(personaId,event.source_message_id,event.session_id??null);
}

function deriveRelation(newEvent,oldEvent,newSource,oldSource){
  const newKeys=parseKeys(newEvent.entity_keys_json);
  const oldKeys=parseKeys(oldEvent.entity_keys_json);
  const shared=newKeys.filter(key=>oldKeys.includes(key)&&literalIn(newSource.content_text,key)&&literalIn(oldSource.content_text,key));
  if(shared.length)return {type:"same_entity",evidence:shared[0],strength:0.86,confidence:0.98};
  const newTopic=String(newEvent.topic_key??"").trim(),oldTopic=String(oldEvent.topic_key??"").trim();
  if(newTopic&&newTopic===oldTopic&&literalIn(newSource.content_text,newTopic)&&literalIn(oldSource.content_text,oldTopic)){
    if(explicitCausalText(`${newSource.content_text} ${oldSource.content_text}`))return {type:"related_plan",evidence:newTopic,strength:0.8,confidence:0.95};
    return {type:"same_topic",evidence:newTopic,strength:0.76,confidence:0.93};
  }
  if(newEvent.expectation_id&&newEvent.expectation_id===oldEvent.expectation_id){
    return {type:"expectation_related",evidence:String(newEvent.expectation_id),strength:0.9,confidence:0.99};
  }
  return null;
}

export function createTrustedEventAssociations(event,{maxEdges=MAX_EDGES_PER_EVENT}={}){
  const source=verifiedEventSource(event?.persona_id,event);
  if(!source)return [];
  const older=listRecentEvents(event.persona_id,200)
    .filter(candidate=>candidate.id!==event.id&&candidate.created_at<=event.created_at)
    .slice(0,200);
  const candidates=[];
  for(const prior of older){
    const priorSource=verifiedEventSource(event.persona_id,prior);
    if(!priorSource)continue;
    const relation=deriveRelation(event,prior,source,priorSource);
    if(relation)candidates.push({prior,relation});
  }
  candidates.sort((a,b)=>Number(b.prior.importance)-Number(a.prior.importance)||String(b.prior.created_at).localeCompare(String(a.prior.created_at)));
  if(candidates.length>maxEdges)eventAssociationDiagnostics.graphExplosionCount++;
  const edges=[];
  for(const {prior,relation} of candidates.slice(0,Math.max(0,Math.min(MAX_EDGES_PER_EVENT,maxEdges)))){
    if(!RELATIONS.has(relation.type))continue;
    const existed=Boolean(getEventAssociation(event.id,prior.id,relation.type));
    insertEventAssociation({personaId:event.persona_id,fromEventId:event.id,toEventId:prior.id,relationType:relation.type,strength:relation.strength,confidence:relation.confidence,evidenceMessageId:event.source_message_id});
    if(existed)eventAssociationDiagnostics.duplicateAssociationCount++;
    else edges.push({event_id:event.id,related_event_id:prior.id,relation_type:relation.type,evidence:relation.evidence,hop:1});
  }
  eventAssociationDiagnostics.embeddingOnlyPermanentEdgeCount=0;
  return edges;
}

export function createEventForMemoryCandidate({memory,sourceMessageId,sessionId=null,source="memory-capture",topicKey=null,entityKeys=[],expectationId=null}={}){
  if(!memory?.id||!sourceMessageId||!memory.source_message_id||String(memory.source_message_id)!==String(sourceMessageId))return null;
  if(!["event","project","commitment","relationship"].includes(memory.type)||Number(memory.importance??0)<0.55)return null;
  const existing=listEventsForSourceMessage(memory.persona_id,sourceMessageId).find(candidate=>
    candidate.event_kind===memory.type
      ||(memory.type==="project"&&["plan_change","purchase_decision"].includes(candidate.event_kind))
      ||(memory.type==="commitment"&&(String(candidate.event_kind??"").startsWith("expectation_")||String(candidate.event_kind??"").startsWith("open_loop_")))
  );
  const inserted=existing?{event:existing,inserted:false}:insertEventDetailed({personaId:memory.persona_id,sessionId,source,content:memory.content,importance:memory.importance,
    sourceMessageId,eventKind:memory.type,topicKey,entityKeys,expectationId});
  const event=inserted.event;
  if(!event)return null;
  if(!linkEventToMemory(event.id,memory.id,{linkType:"source_message"}))return null;
  if(inserted.inserted)eventAssociationDiagnostics.currentEventCount++;
  createTrustedEventAssociations(event);
  return event;
}

export function createCorrectionEventForMemory({personaId,sessionId=null,sourceMessageId,newMemoryId,oldMemoryId,sourceEntityKey=null}={}){
  if(!personaId||!sourceMessageId||!newMemoryId)return null;
  const memory=getMemory(newMemoryId),source=getVerifiedUserSource(personaId,sourceMessageId,sessionId);
  if(!memory||memory.persona_id!==personaId||memory.status!=="active"||String(memory.source_message_id??"")!==String(sourceMessageId)||!source)return null;
  const eventResult=insertEventDetailed({personaId,sessionId,source:"user-correction",content:memory.content,importance:memory.importance,
    sourceMessageId,eventKind:"correction",topicKey:sourceEntityKey,entityKeys:sourceEntityKey?[sourceEntityKey]:[]});
  const event=eventResult.event;
  if(!event||!linkEventToMemory(event.id,memory.id,{linkType:"source_message"}))return null;
  if(eventResult.inserted)eventAssociationDiagnostics.currentEventCount++;
  let superseded=0;
  if(oldMemoryId){
    for(const oldEvent of listEventMemoryLinksForMemory(oldMemoryId).slice(0,MAX_EDGES_PER_EVENT)){
      if(oldEvent.persona_id!==personaId||!verifiedEventSource(personaId,oldEvent))continue;
      if(insertEventAssociation({personaId,fromEventId:event.id,toEventId:oldEvent.id,relationType:"supersedes",strength:1,confidence:1,evidenceMessageId:sourceMessageId}))superseded++;
    }
  }
  return {event,supersededEventCount:superseded};
}

export function createExpectationTransitionEvents({personaId,sessionId=null,sourceMessageId,text="",transitions=[]}={}){
  const source=getVerifiedUserSource(personaId,sourceMessageId,sessionId);
  if(!source)return [];
  const result=[];
  for(const transition of (Array.isArray(transitions)?transitions:[]).slice(0,5)){
    if(!transition?.id)continue;
    const state=String(transition.state??"");
    if(!["pending","satisfied","abandoned","violated"].includes(state))continue;
    const topic=String(transition.topic??"").trim().slice(0,120);
    const inserted=insertEventDetailed({personaId,sessionId,source:"natural-cognition",content:`${topic||"待跟进事项"} · ${state}`,
      importance:Number(transition.salience??0.7),sourceMessageId,eventKind:`expectation_${state}`,
      topicKey:topic&&literalIn(text,topic)?topic:null,expectationId:String(transition.id)});
    const event=inserted.event;
    if(inserted.inserted)eventAssociationDiagnostics.currentEventCount++;
    if(event){createTrustedEventAssociations(event);result.push(event);}
  }
  return result;
}

export function createOpenLoopEvents({personaId,sessionId=null,sourceMessageId,text="",loops=[]}={}){
  const source=getVerifiedUserSource(personaId,sourceMessageId,sessionId);
  if(!source)return [];
  const result=[];
  for(const loop of (Array.isArray(loops)?loops:[]).slice(0,5)){
    if(!loop?.id||String(loop.source_message_id??"")!==String(sourceMessageId))continue;
    const topic=String(loop.topic??"").trim().slice(0,80);
    const known=listRecentEvents(personaId,200);
    const entityKeys=[...new Set(known.flatMap(event=>{
      const prior=verifiedEventSource(personaId,event);
      return prior?parseKeys(event.entity_keys_json).filter(key=>literalIn(source.content_text,key)&&literalIn(prior.content_text,key)):[];
    }))].slice(0,4);
    const inserted=insertEventDetailed({personaId,sessionId,source:"natural-presence",content:source.content_text,
      importance:Number(loop.salience??0.65),sourceMessageId,eventKind:"open_loop_created",
      topicKey:topic&&literalIn(source.content_text,topic)?topic:null,entityKeys});
    if(inserted.inserted)eventAssociationDiagnostics.currentEventCount++;
    if(inserted.event){createTrustedEventAssociations(inserted.event);result.push(inserted.event);}
  }
  return result;
}

export function createOpenLoopCompletionEvent({personaId,sessionId=null,sourceMessageId,text="",topic=null}={}){
  const source=getVerifiedUserSource(personaId,sourceMessageId,sessionId);
  if(!source||!String(text??"").trim())return null;
  const topicKey=topic&&literalIn(source.content_text,topic)?String(topic).trim().slice(0,80):null;
  const inserted=insertEventDetailed({personaId,sessionId,source:"natural-presence",content:source.content_text,
    importance:0.7,sourceMessageId,eventKind:"open_loop_completed",topicKey});
  if(inserted.inserted)eventAssociationDiagnostics.currentEventCount++;
  if(inserted.event)createTrustedEventAssociations(inserted.event);
  return inserted.event;
}

export function createCurrentEventAssociations({personaId,sessionId,sourceMessageId,text=""}={}){
  const kind=eventKindForCurrentText(text);
  if(!personaId||!sessionId||!sourceMessageId||!kind)return null;
  const source=getVerifiedUserSource(personaId,sourceMessageId,sessionId);
  if(!source)return null;
  const known=listRecentEvents(personaId,200);
  const matches=[];
  for(const event of known){
    const candidateSource=verifiedEventSource(personaId,event);
    if(!candidateSource)continue;
    const keys=parseKeys(event.entity_keys_json);
    for(const key of keys){
      if(literalIn(source.content_text,key)&&literalIn(candidateSource.content_text,key))matches.push({event,key,relationType:"same_entity"});
    }
    const topic=String(event.topic_key??"").trim();
    if(topic&&literalIn(source.content_text,topic)&&literalIn(candidateSource.content_text,topic))matches.push({event,key:topic,relationType:explicitCausalText(text)?"related_plan":"same_topic"});
  }
  const unique=new Map();
  for(const match of matches){
    const prior=unique.get(match.event.id)??{event:match.event,keys:[],relationType:match.relationType};
    if(!prior.keys.includes(match.key))prior.keys.push(match.key);
    if(match.relationType==="same_entity")prior.relationType="same_entity";
    unique.set(match.event.id,prior);
  }
  const ranked=[...unique.values()].sort((a,b)=>Number(b.event.importance)-Number(a.event.importance)||String(b.event.created_at).localeCompare(String(a.event.created_at)));
  const direct=ranked.slice(0,MAX_DIRECT_EVENTS);
  if(ranked.length>MAX_DIRECT_EVENTS)eventAssociationDiagnostics.graphExplosionCount++;
  eventAssociationDiagnostics.directEventCandidateCount+=ranked.length;
  eventAssociationDiagnostics.lastDirectEventCount=ranked.length;
  if(!direct.length){eventAssociationDiagnostics.zeroAssociationCount++;return null;}
  const keys=[...new Set(direct.flatMap(item=>item.keys))].slice(0,4);
  const topicKey=keys[0]??null;
  const result=insertEventDetailed({personaId,sessionId,source:"turn-event-association",content:eventLabel(kind,keys),importance:0.72,
    sourceMessageId,eventKind:kind,topicKey,entityKeys:keys});
  if(!result.event)return null;
  if(result.inserted)eventAssociationDiagnostics.currentEventCount++;
  const edges=[];
  for(const prior of direct){
    const shared=prior.keys.find(key=>keys.includes(key));
    if(!shared)continue;
    const relationType=prior.relationType;
    const existed=Boolean(getEventAssociation(result.event.id,prior.event.id,relationType));
    insertEventAssociation({personaId,fromEventId:result.event.id,toEventId:prior.event.id,relationType,strength:relationType==="same_entity"?0.86:0.76,confidence:relationType==="same_entity"?0.98:0.93,evidenceMessageId:sourceMessageId});
    if(existed)eventAssociationDiagnostics.duplicateAssociationCount++;
    else edges.push({event_id:result.event.id,related_event_id:prior.event.id,relation_type:relationType,evidence:shared,hop:1});
  }
  eventAssociationDiagnostics.lastAssociatedMemoryCount=0;
  if(!edges.length)eventAssociationDiagnostics.zeroAssociationCount++;
  eventAssociationDiagnostics.embeddingOnlyPermanentEdgeCount=0;
  return {eventId:result.event.id,directEventCount:direct.length,edgeCount:edges.length,edges};
}

export function associatedMemoryCandidatesForMessage(personaId,messageId){
  if(!personaId||messageId==null)return [];
  const events=listEventsForSourceMessage(personaId,messageId);
  if(!events.length){eventAssociationDiagnostics.zeroAssociationCount++;eventAssociationDiagnostics.lastAssociatedMemoryCount=0;return [];}
  const rows=events.flatMap(event=>listEventAssociatedMemories(event.id,{maxEvents:MAX_DIRECT_EVENTS,maxMemories:MAX_ASSOCIATED_MEMORIES}));
  const activationRelations=new Set(["same_entity","same_topic","related_plan","expectation_related"]);
  const filtered=rows.filter(row=>{
    if(["contradicts","supersedes"].includes(row.association?.relation_type))eventAssociationDiagnostics.contradictionActivationCount++;
    if(row.memory?.status==="retired"||row.memory?.temporal_state==="historical")eventAssociationDiagnostics.retiredEventActivationCount++;
    return row.association?.hop===1&&row.association?.evidence_message_id===String(messageId)
      &&activationRelations.has(row.association?.relation_type)&&row.association?.confidence>=0.85&&row.association?.strength>=0.7;
  });
  for(const row of filtered){
    const ageDays=Math.max(0,(Date.now()-Date.parse(row.association.event_created_at??""))/86_400_000);
    const recency=Number.isFinite(ageDays)?1/(1+ageDays/90):0.5;
    const eventRelevance=row.association.relation_type==="same_entity"||row.association.relation_type==="expectation_related"?1:
      row.association.relation_type==="same_topic"?0.9:0.85;
    row.association.recency=recency;
    row.association.event_relevance=eventRelevance;
    row.association.activation_score=0.4*Number(row.association.strength)+0.3*Number(row.association.confidence)+0.2*recency+0.1*eventRelevance;
  }
  const unique=new Map();
  for(const row of filtered){
    const prior=unique.get(row.memory.id);
    if(!prior||row.association.confidence>prior.association.confidence)unique.set(row.memory.id,row);
  }
  const result=[...unique.values()].slice(0,MAX_ASSOCIATED_MEMORIES);
  eventAssociationDiagnostics.activatedOneHopCount+=new Set(result.map(row=>row.association.event_id)).size;
  eventAssociationDiagnostics.associationCandidateCount+=result.length;
  eventAssociationDiagnostics.lastAssociatedMemoryCount=result.length;
  if(!result.length)eventAssociationDiagnostics.zeroAssociationCount++;
  return result;
}

export function noteAssociationSelection({candidateIds=[],eligibleIds=[],selectedIds=[]}={}){
  const candidates=new Set(candidateIds),eligible=new Set(eligibleIds),selected=new Set(selectedIds);
  const selectedAssociated=[...selected].filter(id=>candidates.has(id)).length;
  eventAssociationDiagnostics.selectedAssociationCount+=selectedAssociated;
  eventAssociationDiagnostics.lastSelectedAssociationCount=selectedAssociated;
  eventAssociationDiagnostics.irrelevantAssociationCount+=Math.max(0,candidates.size-eligible.size);
  eventAssociationDiagnostics.embeddingOnlyPermanentEdgeCount=0;
  return selectedAssociated;
}

export function resetEventAssociationDiagnostics(){
  for(const key of Object.keys(eventAssociationDiagnostics))eventAssociationDiagnostics[key]=key==="maxHop"?1:0;
}

export function eventAssociationLimits(){
  return {max_hop:1,max_direct_events:MAX_DIRECT_EVENTS,max_associated_memories:MAX_ASSOCIATED_MEMORIES,max_edges_per_event:MAX_EDGES_PER_EVENT};
}
