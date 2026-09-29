import { config } from "./config.js";
import { deleteMemoryEmbedding,getMemory,insertMemory,listPinnedMemories,listActiveMemories,listRecentMemoriesAnyStatus,recordMemoryAccess,searchMemoryFts,updateMemory,upsertMemoryEmbedding,listMemoryEmbeddings } from "./db.js";
import { embedText,cosine } from "./embeddings.js";
import { compactText,ngrams,textSimilarity } from "./utils.js";
import { conservativeDuplicate,filterSharedMemoryCandidate,normalizeMemoryType } from "./memory-policy.js";
import { memoryCorrectionDiagnostics } from "./memory-correction-metrics.js";

function ftsQuery(text){return ngrams(text,3).slice(0,24).map(x=>`"${x.replaceAll('"','""')}"`).join(" OR ");}

export async function indexEmbedding(memory){
  if(!memory)return;
  if(!config.embeddingEnabled){deleteMemoryEmbedding(memory.id);return;}
  try{const v=await embedText(memory.content);if(v)upsertMemoryEmbedding(memory.id,config.ollamaEmbedModel,v);}catch(e){console.warn("[memory] embed index unavailable; using FTS5",e.message);}
}

export async function addStagingMemoryDetailed({personaId,content,type="fact",importance=0.5,source="summary",temporalState="current",evidenceMode="derived",sourceMessageId=null}){
  if(!content?.trim()||compactText(content).length<3)return null;
  const normalizedType=normalizeMemoryType(type);
  const similar=listRecentMemoriesAnyStatus(personaId,200).find(m=>conservativeDuplicate(m.content,content)&&(m.status==="retired"||m.type===normalizedType||m.type==="other"||normalizedType==="other"));
  if(similar){
    // A retired fact is history. Extraction/consolidation may encounter its old wording
    // again, but a duplicate must never silently reactivate it.
    if(similar.status==="retired"){
      memoryCorrectionDiagnostics.retiredDuplicateSuppressed++;
      return {memory:similar,created:false,suppressed:true};
    }
    let upgraded=updateMemory(similar.id,{importance:Math.max(Number(similar.importance),Number(importance)||0.5),type:similar.type==="other"?normalizedType:similar.type,source,temporalState,evidenceMode});
    if(upgraded?.status==="staging"&&config.autoPromoteMemory&&Number(upgraded.importance)>=config.autoPromoteMinImportance)upgraded=updateMemory(upgraded.id,{status:"active"});
    if(upgraded?.status==="active")await indexEmbedding(upgraded);
    return {memory:upgraded,created:false};
  }
  let m=insertMemory({personaId,content,type:normalizedType,importance,status:"staging",source,temporalState,evidenceMode,sourceMessageId});if(!m)return null;
  if(config.autoPromoteMemory&&Number(m.importance)>=config.autoPromoteMinImportance){m=updateMemory(m.id,{status:"active"});await indexEmbedding(m);}
  return {memory:m,created:true};
}

export async function addStagingMemory(opts){
  return (await addStagingMemoryDetailed(opts))?.memory??null;
}

/** 冲突更新：把被取代的旧 active memory 置为 retired（保留审计痕迹，检索不再命中） */
export async function retireMemory(id){
  const m=getMemory(id);if(!m||m.status!=="active")return null;
  const r=updateMemory(id,{status:"retired"});
  deleteMemoryEmbedding(id);
  return r;
}

const MANUAL_STATE_TYPES=new Set(["preference","relationship","commitment","project"]);
const safeManualMatch=memory=>({id:memory.id,content:memory.content.slice(0,180),type:memory.type,status:memory.status,source:memory.source,updated_at:memory.updated_at});

export function inspectManualMemory({personaId,content,type="fact"}){
  const safe=filterSharedMemoryCandidate({content,type,source:"manual",agent:false});
  if(!safe.ok)return {disposition:"invalid",reason:safe.reason,duplicate:null,possibleConflicts:[]};
  const rows=listRecentMemoriesAnyStatus(personaId,300);
  const duplicate=rows.find(row=>conservativeDuplicate(row.content,safe.content));
  if(duplicate)return {disposition:"duplicate",reason:"existing_memory",duplicate:safeManualMatch(duplicate),possibleConflicts:[]};
  const possibleConflicts=MANUAL_STATE_TYPES.has(safe.type)
    ? rows.filter(row=>row.status==="active"&&row.type===safe.type).sort((a,b)=>textSimilarity(safe.content,b.content)-textSimilarity(safe.content,a.content)).slice(0,4).map(safeManualMatch)
    : [];
  return {disposition:possibleConflicts.length?"review":"ready",reason:possibleConflicts.length?"stateful_type_review":null,duplicate:null,possibleConflicts};
}

export async function addManualMemory({personaId,content,type="fact",importance=0.8,temporalState="current",replacesId=null,keepAlongside=false}){
  const assessment=inspectManualMemory({personaId,content,type});
  if(assessment.disposition==="invalid")throw Object.assign(new Error("invalid manual memory"),{statusCode:400,code:assessment.reason});
  if(assessment.duplicate)return {created:false,outcome:"duplicate",memory:getMemory(assessment.duplicate.id),assessment};
  if(assessment.possibleConflicts.length&&!replacesId&&!keepAlongside)throw Object.assign(new Error("possible memory conflict"),{statusCode:409,code:"possible_conflict",assessment});
  let replaced=null;
  if(replacesId){
    replaced=getMemory(replacesId);
    if(!replaced||replaced.persona_id!==personaId||replaced.status!=="active")throw Object.assign(new Error("replacement memory not found"),{statusCode:400,code:"invalid_replacement"});
  }
  const result=await addStagingMemoryDetailed({personaId,content,type,importance,source:"manual",temporalState,evidenceMode:"manual"});
  if(!result?.memory)return {created:false,outcome:"rejected",memory:null,assessment};
  let memory=updateMemory(result.memory.id,{status:"active",source:"manual",temporalState,evidenceMode:"manual"});
  await indexEmbedding(memory);
  if(replaced&&replaced.id!==memory.id)await retireMemory(replaced.id);
  return {created:result.created,outcome:replaced?"replaced":(result.created?"created":"duplicate"),memory,replaced:replaced?{id:replaced.id}:null,assessment};
}

export async function refreshMemoryIndex(memory){await indexEmbedding(memory);}

function recencyScore(date){const ms=Date.now()-Date.parse(date);if(!Number.isFinite(ms)||ms<0)return 1;return 1/(1+ms/86400000/30);}
function usageScore(count){return Math.min(1,Math.log1p(Math.max(0,Number(count)||0))/5);}

export async function retrieveMemoriesDetailed(personaId,query,{limit=6,recordAccess=false,candidateLimit=80}={}){
  const map=new Map();
  const entry=m=>{let x=map.get(m.id);if(!x){x={memory:m,fts_score:0,fts_rank:null,embedding_score:0,text_score:0};map.set(m.id,x);}return x;};
  for(const m of listPinnedMemories(personaId,Math.max(limit,20)))entry(m);

  const q=ftsQuery(query),fts=q?searchMemoryFts(personaId,q,Math.max(30,limit*8)):[];
  fts.forEach((m,i)=>{const x=entry(m);x.fts_score=Math.max(x.fts_score,1-i/Math.max(1,fts.length));x.fts_rank=Number(m.rank);});

  for(const m of listActiveMemories(personaId,Math.max(candidateLimit,limit*20))){const s=textSimilarity(query,m.content);if(s>=0.12){const x=entry(m);x.text_score=Math.max(x.text_score,s);}}

  if(config.embeddingEnabled&&query.trim()){
    try{
      const qv=await embedText(query);
      if(qv)for(const m of listMemoryEmbeddings(personaId,config.ollamaEmbedModel,config.embeddingCandidateLimit)){
        const sim=cosine(qv,JSON.parse(m.vector_json));if(sim>=0.2){const x=entry(m);x.embedding_score=Math.max(x.embedding_score,sim);}
      }
    }catch(e){console.warn("[memory] semantic retrieval unavailable; using FTS5",e.message);}
  }

  const ranked=[...map.values()].map(x=>{
    const m=x.memory,pinned_score=m.pinned?1:0,importance_score=Number(m.importance)||0,confidence_score=Number(m.confidence??0.7),recency_score=recencyScore(m.updated_at),access_score=usageScore(m.access_count);
    const final_score=pinned_score*5+x.fts_score*2.4+x.embedding_score*2.8+x.text_score*1.5+importance_score*0.8+confidence_score*0.5+recency_score*0.35+access_score*0.3;
    const reasons=[];if(pinned_score)reasons.push("pinned");if(x.fts_score)reasons.push("FTS5 match");if(x.embedding_score)reasons.push("embedding similarity");if(x.text_score)reasons.push("text similarity");if(importance_score>=0.7)reasons.push("high importance");if(confidence_score>=0.8)reasons.push("high confidence");if(access_score>0.2)reasons.push("frequently used");
    return {...x,pinned_score,importance_score,confidence_score,recency_score,access_score,final_score,reasons};
  }).sort((a,b)=>b.final_score-a.final_score);
  ranked.forEach((x,i)=>{x.in_context=i<limit;});
  if(recordAccess)recordMemoryAccess(ranked.filter(x=>x.in_context).map(x=>x.memory.id));
  return ranked.slice(0,Math.max(limit,candidateLimit));
}

export async function retrieveMemories(personaId,query,limit){
  const rows=await retrieveMemoriesDetailed(personaId,query,{limit,recordAccess:true});
  return rows.filter(x=>x.in_context).map(x=>x.memory);
}
