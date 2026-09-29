import { db,listRecentMemoriesAnyStatus,listRecentSummarizableMessages,insertMemory,updateMemory,deleteMemoryEmbedding } from "./db.js";
import { normalizeMemoryText,textSimilarity } from "./utils.js";
import { indexEmbedding } from "./memory.js";
import { classifyMemoryCorrection } from "./memory-correction-classifier.js";
import { memoryCorrectionDiagnostics } from "./memory-correction-metrics.js";

const NAME_SLOT_RE=/^(.*?(?:名字是|名叫|叫)\s*)([^，,。！？!?\s（）()【】]{2,16})(.*)$/u;
const CJK_NAME_RE=/[\u4e00-\u9fff]{2,5}/gu;

const clean=value=>String(value??"").replace(/^[\s：:「『“"'（(]+|[\s。！？!?」』”"'）)吧呢啊]+$/gu,"").trim();
export { classifyMemoryCorrection,memoryCorrectionDiagnostics };

function memoryName(memory){
  const content=String(memory?.content??"");
  const slot=content.match(NAME_SLOT_RE);
  if(slot)return clean(slot[2]);
  const names=[...content.matchAll(CJK_NAME_RE)].map(m=>m[0]);
  return names.at(-1)??null;
}

function findOldMemory(memories,correction,{sessionId,userText}={}){
  const active=memories.filter(m=>m.status==="active");
  if(correction.from){
    const direct=active.filter(m=>String(m.content).includes(correction.from));
    if(direct.length===1)return direct[0];
    if(direct.length>1){
      const ranked=direct.map(memory=>({memory,score:textSimilarity(userText,memory.content)})).sort((a,b)=>b.score-a.score);
      if(ranked[0].score-ranked[1].score>=0.12)return ranked[0].memory;
      return null;
    }
  }
  if(correction.kind!=="fact_correction"||!sessionId)return null;
  const recent=listRecentSummarizableMessages(sessionId,12)
    .filter(row=>row.role==="user"&&String(row.content_text??"").trim()&&normalizeMemoryText(row.content_text)!==normalizeMemoryText(userText));
  const ranked=active.map(memory=>{
    const best=Math.max(0,...recent.map(row=>textSimilarity(memory.content,row.content_text)));
    const name=memoryName(memory);
    const recency=recent.some(row=>name&&String(row.content_text).includes(name))?0.35:0;
    return {memory,score:best+recency};
  }).filter(row=>row.score>=0.55).sort((a,b)=>b.score-a.score);
  if(!ranked.length||ranked.length>1&&ranked[0].score-ranked[1].score<0.08)return null;
  return ranked[0].memory;
}

function correctedContent(oldMemory,correction){
  if(!oldMemory)return null;
  let content=String(oldMemory.content??"");
  let oldValue=correction.from;
  if(!oldValue){
    const slot=content.match(NAME_SLOT_RE);
    oldValue=slot?clean(slot[2]):memoryName(oldMemory);
  }
  if(!oldValue||!content.includes(oldValue))return null;
  return content.replace(oldValue,correction.to);
}

function ambiguousOldValue(correction){return correction.from??null;}

export async function applyMemoryCorrection({personaId,sessionId=null,userText="",sourceMessageId=null}={}){
  const correction=classifyMemoryCorrection(userText);
  if(!correction)return {detected:false,applied:false};
  memoryCorrectionDiagnostics.correctionDetected++;
  const memories=listRecentMemoriesAnyStatus(personaId,1000);

  if(correction.kind==="ambiguous"){
    memoryCorrectionDiagnostics.ambiguousCorrection++;
    const oldValue=ambiguousOldValue(correction);
    const targets=oldValue?memories.filter(m=>m.status==="active"&&String(m.content).includes(oldValue)):[];
    for(const target of targets)updateMemory(target.id,{confidence:Math.min(Number(target.confidence??0.7),0.52)});
    const result={detected:true,applied:false,kind:correction.kind,oldConfidenceReduced:targets.length>0,candidatesAffected:targets.length,candidateCreated:false};
    memoryCorrectionDiagnostics.lastOutcome=result;
    return result;
  }

  const oldMemory=findOldMemory(memories,correction,{sessionId,userText});
  let nextContent=oldMemory?correctedContent(oldMemory,correction):null;
  let type=oldMemory?.type??(correction.kind==="plan_change"?"project":"fact");
  let temporalState="current";
  if(correction.kind==="plan_change"){
    nextContent=oldMemory&&correction.from&&String(oldMemory.content).includes(correction.from)
      ?String(oldMemory.content).replace(correction.from,correction.to)
      :`用户当前计划是买${correction.to}，此前考虑过${correction.from}`;
    type=oldMemory&&["project","commitment","preference"].includes(oldMemory.type)?oldMemory.type:"project";
    temporalState="current";
  }
  if(!nextContent){
    const result={detected:true,applied:false,kind:correction.kind,reason:"matching_active_fact_not_found"};
    memoryCorrectionDiagnostics.lastOutcome=result;
    return result;
  }

  const duplicate=memories.find(m=>m.status==="active"&&normalizeMemoryText(m.content)===normalizeMemoryText(nextContent));
  let nextMemory=duplicate??null;
  db.exec("BEGIN IMMEDIATE");
  try{
    if(!nextMemory){
      nextMemory=insertMemory({personaId,content:nextContent,type,importance:Math.max(0.8,Number(oldMemory?.importance??0.8)),confidence:correction.confidence,status:"active",source:"user_correction",temporalState,evidenceMode:"reported",sourceMessageId});
      if(!nextMemory)throw new Error("could not create corrected memory");
    }else{
      nextMemory=updateMemory(nextMemory.id,{confidence:correction.confidence,importance:Math.max(0.8,Number(nextMemory.importance??0.8)),source:"user_correction",temporalState,status:"active"});
    }
    if(oldMemory&&oldMemory.id!==nextMemory.id){
      updateMemory(oldMemory.id,{status:"retired",temporalState:"historical",confidence:Math.min(Number(oldMemory.confidence??0.7),0.15)});
      deleteMemoryEmbedding(oldMemory.id);
    }
    db.exec("COMMIT");
  }catch(error){
    try{db.exec("ROLLBACK");}catch{}
    const result={detected:true,applied:false,kind:correction.kind,reason:String(error?.message??error).slice(0,120)};
    memoryCorrectionDiagnostics.lastOutcome=result;
    return result;
  }
  await indexEmbedding(nextMemory);
  memoryCorrectionDiagnostics.correctionApplied++;
  if(oldMemory&&oldMemory.id!==nextMemory.id)memoryCorrectionDiagnostics.oldFactRetired++;
  memoryCorrectionDiagnostics.newFactActive++;
  const result={detected:true,applied:true,kind:correction.kind,oldFactRetired:Boolean(oldMemory&&oldMemory.id!==nextMemory.id),newFactActive:true,newMemoryId:nextMemory.id,oldMemoryId:oldMemory?.id??null,sourceEntityKey:correction.to??null};
  memoryCorrectionDiagnostics.lastOutcome=result;
  console.log("[memory-correction]",JSON.stringify({kind:result.kind,applied:true,old_fact_retired:result.oldFactRetired,new_fact_active:true}));
  return result;
}
