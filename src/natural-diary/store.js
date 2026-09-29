import { db } from "../db.js";
import { config } from "../config.js";
import { uuid } from "../utils.js";
import { companionTime } from "../time-service.js";
import { GENERATION_VERSION, validLocalDate, shiftLocalDate } from "./dates.js";

const nowIso=()=>new Date().toISOString();

function parseJson(value,fallback){
  if(value==null||value==="")return fallback;
  try{return JSON.parse(value);}catch{return fallback;}
}

export function rowToEntry(row){
  if(!row)return null;
  return {
    id:row.id,
    personaId:row.persona_id,
    dateLocal:row.date_local,
    createdAt:row.created_at,
    updatedAt:row.updated_at,
    sourceStartAt:row.source_start_at,
    sourceEndAt:row.source_end_at,
    body:row.body,
    summary:row.summary??"",
    reflection:row.reflection??"",
    messageToUser:row.message_to_user??"",
    moodSnapshot:row.mood_snapshot,
    energySnapshot:row.energy_snapshot,
    closenessSnapshot:row.closeness_snapshot,
    irritationSnapshot:row.irritation_snapshot,
    relatedMessageIds:parseJson(row.related_message_ids,[]),
    relatedOpenLoopIds:parseJson(row.related_open_loop_ids,[]),
    relatedExpectationIds:parseJson(row.related_expectation_ids,[]),
    chatMessageCount:Number(row.chat_message_count)||0,
    userMessageCount:Number(row.user_message_count)||0,
    assistantMessageCount:Number(row.assistant_message_count)||0,
    generationVersion:row.generation_version,
    evidenceHash:row.evidence_hash??null,
    content:parseJson(row.content_json,null)
  };
}

export function getDiaryEntry(dateLocal,personaId=config.defaultPersonaId){
  if(!validLocalDate(dateLocal))return null;
  const row=db.prepare("SELECT * FROM diary_entries WHERE persona_id=? AND date_local=?").get(personaId,dateLocal);
  return rowToEntry(row);
}

export function listDiaryEntries({personaId=config.defaultPersonaId,limit=30,before=null,after=null}={}){
  const where=["persona_id=?"],args=[personaId];
  if(before&&validLocalDate(before)){where.push("date_local<?");args.push(before);}
  if(after&&validLocalDate(after)){where.push("date_local>?");args.push(after);}
  args.push(Math.max(1,Math.min(200,Number(limit)||30)));
  return db.prepare(`SELECT * FROM diary_entries WHERE ${where.join(" AND ")} ORDER BY date_local DESC LIMIT ?`).all(...args).map(rowToEntry);
}

export function adjacentDiaryDates(dateLocal,personaId=config.defaultPersonaId){
  const prev=db.prepare("SELECT date_local FROM diary_entries WHERE persona_id=? AND date_local<? ORDER BY date_local DESC LIMIT 1").get(personaId,dateLocal)?.date_local??null;
  const next=db.prepare("SELECT date_local FROM diary_entries WHERE persona_id=? AND date_local>? ORDER BY date_local ASC LIMIT 1").get(personaId,dateLocal)?.date_local??null;
  return {previousDate:prev,nextDate:next};
}

export function recentDiarySummaries(personaId,beforeDate,limit=3){
  return db.prepare("SELECT date_local,summary,body,user_message_count FROM diary_entries WHERE persona_id=? AND date_local<? ORDER BY date_local DESC LIMIT ?")
    .all(personaId,beforeDate,Math.max(1,Math.min(6,limit)))
    .map(row=>({
      dateLocal:row.date_local,
      summary:String(row.summary??"").trim()||String(row.body??"").replace(/\s+/g," ").slice(0,80),
      userMessageCount:Number(row.user_message_count)||0
    }));
}

function ftsText(entry){
  return [entry.body,entry.summary,entry.reflection,entry.messageToUser].filter(Boolean).join("\n").slice(0,8000);
}

function upsertFts(entry){
  db.prepare("DELETE FROM diary_fts WHERE diary_id=?").run(entry.id);
  db.prepare("INSERT INTO diary_fts(diary_id,persona_id,date_local,body) VALUES(?,?,?,?)").run(entry.id,entry.personaId,entry.dateLocal,ftsText(entry));
}

export function insertDiaryEntry(input,{replace=false}={}){
  const personaId=input.personaId??config.defaultPersonaId;
  const dateLocal=input.dateLocal;
  if(!validLocalDate(dateLocal))throw new Error("invalid diary date");
  const body=String(input.body??"").trim();
  if(!body)throw new Error("diary body required");
  const t=nowIso();
  const id=input.id??uuid();
  const existing=getDiaryEntry(dateLocal,personaId);
  if(existing&&!replace)return {ok:false,reason:"already_exists",entry:existing};
  const row={
    id:existing&&replace?existing.id:id,
    persona_id:personaId,
    date_local:dateLocal,
    created_at:existing&&replace?existing.createdAt:t,
    updated_at:t,
    source_start_at:input.sourceStartAt??t,
    source_end_at:input.sourceEndAt??t,
    body,
    summary:String(input.summary??"").trim().slice(0,400),
    reflection:String(input.reflection??"").trim().slice(0,800),
    message_to_user:String(input.messageToUser??"").trim().slice(0,500),
    mood_snapshot:input.moodSnapshot??null,
    energy_snapshot:input.energySnapshot??null,
    closeness_snapshot:input.closenessSnapshot??null,
    irritation_snapshot:input.irritationSnapshot??null,
    related_message_ids:JSON.stringify(input.relatedMessageIds??[]),
    related_open_loop_ids:JSON.stringify(input.relatedOpenLoopIds??[]),
    related_expectation_ids:JSON.stringify(input.relatedExpectationIds??[]),
    chat_message_count:Number(input.chatMessageCount)||0,
    user_message_count:Number(input.userMessageCount)||0,
    assistant_message_count:Number(input.assistantMessageCount)||0,
    generation_version:input.generationVersion??GENERATION_VERSION,
    evidence_hash:input.evidenceHash??null,
    content_json:JSON.stringify(input.content??null)
  };
  db.exec("BEGIN IMMEDIATE");
  try{
    if(existing&&replace){
      db.prepare(`UPDATE diary_entries SET updated_at=?,source_start_at=?,source_end_at=?,body=?,summary=?,reflection=?,message_to_user=?,
        mood_snapshot=?,energy_snapshot=?,closeness_snapshot=?,irritation_snapshot=?,related_message_ids=?,related_open_loop_ids=?,related_expectation_ids=?,
        chat_message_count=?,user_message_count=?,assistant_message_count=?,generation_version=?,evidence_hash=?,content_json=?
        WHERE persona_id=? AND date_local=?`).run(
        row.updated_at,row.source_start_at,row.source_end_at,row.body,row.summary,row.reflection,row.message_to_user,
        row.mood_snapshot,row.energy_snapshot,row.closeness_snapshot,row.irritation_snapshot,row.related_message_ids,row.related_open_loop_ids,row.related_expectation_ids,
        row.chat_message_count,row.user_message_count,row.assistant_message_count,row.generation_version,row.evidence_hash,row.content_json,
        personaId,dateLocal
      );
    }else{
      db.prepare(`INSERT INTO diary_entries(
        id,persona_id,date_local,created_at,updated_at,source_start_at,source_end_at,body,summary,reflection,message_to_user,
        mood_snapshot,energy_snapshot,closeness_snapshot,irritation_snapshot,related_message_ids,related_open_loop_ids,related_expectation_ids,
        chat_message_count,user_message_count,assistant_message_count,generation_version,evidence_hash,content_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        row.id,row.persona_id,row.date_local,row.created_at,row.updated_at,row.source_start_at,row.source_end_at,row.body,row.summary,row.reflection,row.message_to_user,
        row.mood_snapshot,row.energy_snapshot,row.closeness_snapshot,row.irritation_snapshot,row.related_message_ids,row.related_open_loop_ids,row.related_expectation_ids,
        row.chat_message_count,row.user_message_count,row.assistant_message_count,row.generation_version,row.evidence_hash,row.content_json
      );
    }
    const saved=getDiaryEntry(dateLocal,personaId);
    upsertFts(saved);
    clearDiaryPending(dateLocal,personaId);
    db.exec("COMMIT");
    return {ok:true,replaced:Boolean(existing&&replace),entry:saved};
  }catch(error){
    try{db.exec("ROLLBACK");}catch{}
    if(String(error?.message??error).includes("UNIQUE constraint failed")){
      return {ok:false,reason:"already_exists",entry:getDiaryEntry(dateLocal,personaId)};
    }
    throw error;
  }
}

export function searchDiaryFts(query,personaId=config.defaultPersonaId,limit=8){
  const q=String(query??"").trim().replace(/["']/g,"").slice(0,80);
  if(q.length<2)return [];
  let rows=[];
  try{
    rows=db.prepare(`SELECT e.* FROM diary_fts f JOIN diary_entries e ON e.id=f.diary_id
      WHERE f.persona_id=? AND diary_fts MATCH ? ORDER BY e.date_local DESC LIMIT ?`).all(personaId,q,limit);
  }catch{}
  if(!rows.length){
    const like=`%${q.replace(/[\\%_]/g,"\\$&")}%`;
    rows=db.prepare(`SELECT * FROM diary_entries WHERE persona_id=? AND (body LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR message_to_user LIKE ? ESCAPE '\\')
      ORDER BY date_local DESC LIMIT ?`).all(personaId,like,like,like,limit);
  }
  return rows.map(rowToEntry);
}

export function getDiaryMeta(personaId=config.defaultPersonaId){
  return db.prepare("SELECT * FROM diary_meta WHERE persona_id=?").get(personaId)??null;
}

export function ensureDiaryOrigin(personaId=config.defaultPersonaId,at=new Date()){
  const existing=getDiaryMeta(personaId);
  if(existing?.origin_date_local)return existing;
  const origin=companionTime.localDate(at);
  const t=nowIso();
  db.prepare("INSERT INTO diary_meta(persona_id,origin_date_local,last_tick_at,created_at,updated_at) VALUES(?,?,?,?,?)").run(personaId,origin,t,t,t);
  return getDiaryMeta(personaId);
}

export function touchDiaryTick(personaId=config.defaultPersonaId,at=new Date()){
  ensureDiaryOrigin(personaId,at);
  const t=(at instanceof Date?at:new Date(at)).toISOString();
  db.prepare("UPDATE diary_meta SET last_tick_at=?,updated_at=? WHERE persona_id=?").run(t,t,personaId);
}

export function getDiaryPending(dateLocal,personaId=config.defaultPersonaId){
  return db.prepare("SELECT * FROM diary_pending WHERE persona_id=? AND date_local=?").get(personaId,dateLocal)??null;
}

export function listDiaryPending(personaId=config.defaultPersonaId,limit=20){
  return db.prepare("SELECT * FROM diary_pending WHERE persona_id=? ORDER BY date_local DESC LIMIT ?").all(personaId,limit);
}

export function upsertDiaryPending({personaId=config.defaultPersonaId,dateLocal,reason,error=null,now=new Date()}={}){
  if(!validLocalDate(dateLocal))throw new Error("invalid diary date");
  const t=(now instanceof Date?now:new Date(now)).toISOString();
  const existing=getDiaryPending(dateLocal,personaId);
  const attempts=(existing?.attempts??0)+1;
  const delays=[60_000,5*60_000,15*60_000,60*60_000,6*60*60_000];
  const delay=delays[Math.min(attempts-1,delays.length-1)];
  const nextRetry=new Date(Date.parse(t)+delay).toISOString();
  if(existing){
    db.prepare("UPDATE diary_pending SET reason=?,attempts=?,last_error=?,next_retry_at=?,updated_at=? WHERE persona_id=? AND date_local=?")
      .run(reason,attempts,error?String(error).slice(0,500):null,nextRetry,t,personaId,dateLocal);
  }else{
    db.prepare("INSERT INTO diary_pending(id,persona_id,date_local,reason,attempts,last_error,next_retry_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(uuid(),personaId,dateLocal,reason,attempts,error?String(error).slice(0,500):null,nextRetry,t,t);
  }
  return getDiaryPending(dateLocal,personaId);
}

export function clearDiaryPending(dateLocal,personaId=config.defaultPersonaId){
  db.prepare("DELETE FROM diary_pending WHERE persona_id=? AND date_local=?").run(personaId,dateLocal);
}

export function duePendingDates(personaId,now=new Date()){
  const t=(now instanceof Date?now:new Date(now)).toISOString();
  return db.prepare("SELECT * FROM diary_pending WHERE persona_id=? AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY date_local").all(personaId,t);
}

export function consecutiveQuietDays(personaId,dateLocal){
  let n=0,cursor=shiftLocalDate(dateLocal,-1);
  for(let i=0;i<14;i++){
    const entry=getDiaryEntry(cursor,personaId);
    if(entry){
      if((entry.userMessageCount||0)>0)break;
      n++;
    }else{
      break;
    }
    cursor=shiftLocalDate(cursor,-1);
  }
  return n;
}
