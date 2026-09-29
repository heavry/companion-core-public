import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { clamp01, messageSignature, messageText, normalizeMemoryText, uuid } from "./utils.js";
import { publishEvent } from "./events-bus.js";
import { attachMediaToMessage,mediaIdsForContent } from "./media.js";
import { invocationLedger } from "./usage-ledger.js";
import { acquireConfiguredPrimaryLease } from "./instance-identity.js";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
export const primaryInstanceLease = acquireConfiguredPrimaryLease(config);
export const db = new DatabaseSync(config.databasePath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS personas(id TEXT PRIMARY KEY,name TEXT NOT NULL,config_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,persona_id TEXT NOT NULL,source TEXT NOT NULL,external_key TEXT NOT NULL,summary TEXT,summary_through_message_id INTEGER NOT NULL DEFAULT 0,archived_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(persona_id,source,external_key));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,role TEXT NOT NULL,content_json TEXT,content_text TEXT,reasoning TEXT,tool_calls_json TEXT,tool_call_id TEXT,source TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_messages_session_id_id ON messages(session_id,id);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,persona_id TEXT NOT NULL,content TEXT NOT NULL,normalized_content TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'fact',importance REAL NOT NULL DEFAULT 0.5,confidence REAL NOT NULL DEFAULT 0.7,pinned INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'staging',source TEXT NOT NULL DEFAULT 'summary',temporal_state TEXT NOT NULL DEFAULT 'current',evidence_mode TEXT NOT NULL DEFAULT 'derived',last_accessed_at TEXT,access_count INTEGER NOT NULL DEFAULT 0,source_message_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(persona_id,normalized_content));
CREATE INDEX IF NOT EXISTS idx_memories_persona_status ON memories(persona_id,status);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, persona_id UNINDEXED, content, tokenize='trigram');
CREATE TABLE IF NOT EXISTS memory_embeddings(memory_id TEXT PRIMARY KEY,model TEXT NOT NULL,vector_json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,persona_id TEXT NOT NULL,session_id TEXT,source TEXT NOT NULL,content TEXT NOT NULL,importance REAL NOT NULL DEFAULT 0.5,source_message_id TEXT,event_kind TEXT,topic_key TEXT,entity_keys_json TEXT NOT NULL DEFAULT '[]',expectation_id TEXT,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_persona_created ON events(persona_id,created_at DESC);
CREATE TABLE IF NOT EXISTS usage_log(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,source TEXT NOT NULL,public_model TEXT NOT NULL,upstream_model TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'chat',prompt_tokens INTEGER,completion_tokens INTEGER,total_tokens INTEGER,cached_tokens INTEGER,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency_cache(session_id TEXT NOT NULL,request_key TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,request_key));
`);

export const SCHEMA_VERSION = 6;
function hasColumn(table,column){return db.prepare(`PRAGMA table_info(${table})`).all().some(r=>r.name===column);}
function migrateSchema(){
  db.exec("BEGIN IMMEDIATE");
  try{
    if(!hasColumn("sessions","archived_at"))db.exec("ALTER TABLE sessions ADD COLUMN archived_at TEXT");
    if(!hasColumn("memories","last_accessed_at"))db.exec("ALTER TABLE memories ADD COLUMN last_accessed_at TEXT");
    if(!hasColumn("memories","access_count"))db.exec("ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
    if(!hasColumn("memories","confidence"))db.exec("ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7");
    if(!hasColumn("memories","temporal_state"))db.exec("ALTER TABLE memories ADD COLUMN temporal_state TEXT NOT NULL DEFAULT 'current'");
    if(!hasColumn("memories","evidence_mode"))db.exec("ALTER TABLE memories ADD COLUMN evidence_mode TEXT NOT NULL DEFAULT 'derived'");
    if(!hasColumn("usage_log","kind"))db.exec("ALTER TABLE usage_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
    if(!hasColumn("usage_log","cached_tokens"))db.exec("ALTER TABLE usage_log ADD COLUMN cached_tokens INTEGER");
    if(!hasColumn("memories","source_message_id"))db.exec("ALTER TABLE memories ADD COLUMN source_message_id TEXT");
    if(!hasColumn("events","source_message_id"))db.exec("ALTER TABLE events ADD COLUMN source_message_id TEXT");
    if(!hasColumn("events","event_kind"))db.exec("ALTER TABLE events ADD COLUMN event_kind TEXT");
    if(!hasColumn("events","topic_key"))db.exec("ALTER TABLE events ADD COLUMN topic_key TEXT");
    if(!hasColumn("events","entity_keys_json"))db.exec("ALTER TABLE events ADD COLUMN entity_keys_json TEXT NOT NULL DEFAULT '[]'");
    if(!hasColumn("events","expectation_id"))db.exec("ALTER TABLE events ADD COLUMN expectation_id TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_associations(
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL,
        from_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        to_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.7,
        confidence REAL NOT NULL DEFAULT 0.85,
        evidence_message_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(from_event_id,to_event_id,relation_type),
        CHECK(from_event_id<>to_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_event_associations_from ON event_associations(persona_id,from_event_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_event_associations_to ON event_associations(persona_id,to_event_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS event_memory_links(
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        link_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(event_id,memory_id,link_type)
      );
      CREATE INDEX IF NOT EXISTS idx_event_memory_links_memory ON event_memory_links(memory_id,event_id);
      CREATE TABLE IF NOT EXISTS diary_entries(
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL,
        date_local TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_start_at TEXT NOT NULL,
        source_end_at TEXT NOT NULL,
        body TEXT NOT NULL,
        summary TEXT,
        reflection TEXT,
        message_to_user TEXT,
        mood_snapshot REAL,
        energy_snapshot REAL,
        closeness_snapshot REAL,
        irritation_snapshot REAL,
        related_message_ids TEXT,
        related_open_loop_ids TEXT,
        related_expectation_ids TEXT,
        chat_message_count INTEGER NOT NULL DEFAULT 0,
        user_message_count INTEGER NOT NULL DEFAULT 0,
        assistant_message_count INTEGER NOT NULL DEFAULT 0,
        generation_version TEXT NOT NULL,
        evidence_hash TEXT,
        content_json TEXT,
        UNIQUE(persona_id, date_local)
      );
      CREATE INDEX IF NOT EXISTS idx_diary_persona_date ON diary_entries(persona_id,date_local DESC);
      CREATE TABLE IF NOT EXISTS diary_pending(
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL,
        date_local TEXT NOT NULL,
        reason TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_retry_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(persona_id, date_local)
      );
      CREATE TABLE IF NOT EXISTS diary_meta(
        persona_id TEXT PRIMARY KEY,
        origin_date_local TEXT NOT NULL,
        last_tick_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS diary_fts USING fts5(diary_id UNINDEXED, persona_id UNINDEXED, date_local UNINDEXED, body, tokenize='trigram');
      CREATE INDEX IF NOT EXISTS idx_sessions_archived_updated ON sessions(archived_at,updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_filters ON memories(persona_id,status,type,source,pinned,updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_created_source ON usage_log(created_at,source,public_model,upstream_model);
      PRAGMA user_version=${SCHEMA_VERSION};
      COMMIT;
    `);
  }catch(e){try{db.exec("ROLLBACK");}catch{}throw e;}
}
migrateSchema();
invocationLedger.importLegacyRows(db.prepare("SELECT * FROM usage_log ORDER BY id").all());

const now = () => new Date().toISOString();
const escapeLike = s => String(s).replace(/[\\%_]/g,m=>`\\${m}`);

export function upsertPersona(p) {
  const t = now();
  db.prepare(`INSERT INTO personas(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config_json=excluded.config_json,updated_at=excluded.updated_at`).run(p.id,p.name,JSON.stringify(p),t,t);
}
export function getPersona(id) {
  const r = db.prepare("SELECT config_json FROM personas WHERE id=?").get(id);
  return r ? JSON.parse(r.config_json) : null;
}
export function listPersonas() { return db.prepare("SELECT config_json FROM personas ORDER BY updated_at DESC").all().map(r => JSON.parse(r.config_json)); }

export function getOrCreateSession(personaId, source, externalKey) {
  let r = db.prepare("SELECT * FROM sessions WHERE persona_id=? AND source=? AND external_key=?").get(personaId,source,externalKey);
  if (r) return r;
  const id=uuid(), t=now();
  db.prepare("INSERT INTO sessions(id,persona_id,source,external_key,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id,personaId,source,externalKey,t,t);
  publishEvent("session.created",{sessionId:id,source,externalKey},{sessionId:id});
  return db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
}
export function getSession(id) { return db.prepare("SELECT * FROM sessions WHERE id=?").get(id) ?? null; }
export function listSessions(personaId=null,limit=100){
  return personaId
    ? db.prepare("SELECT * FROM sessions WHERE persona_id=? ORDER BY updated_at DESC LIMIT ?").all(personaId,limit)
    : db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit);
}
export function getLatestUserSession(personaId){
  return db.prepare(`SELECT s.* FROM sessions s
    JOIN messages m ON m.session_id=s.id
    WHERE s.persona_id=? AND m.role='user' AND m.content_text IS NOT NULL AND trim(m.content_text)<>''
    ORDER BY m.id DESC LIMIT 1`).get(personaId)??null;
}
export function getLatestUserMessageAt(personaId){
  return db.prepare(`SELECT m.created_at FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE s.persona_id=? AND m.role='user'
    ORDER BY m.id DESC LIMIT 1`).get(personaId)?.created_at??null;
}
export function listSessionsAdmin({personaId=null,source=null,search="",archived="all",limit=100}={}){
  const where=[],args=[];
  if(personaId){where.push("s.persona_id=?");args.push(personaId);}
  if(source){where.push("s.source=?");args.push(source);}
  if(archived==="active")where.push("s.archived_at IS NULL");
  if(archived==="archived")where.push("s.archived_at IS NOT NULL");
  if(search){where.push("(s.external_key LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM messages sm WHERE sm.session_id=s.id AND sm.content_text LIKE ? ESCAPE '\\'))");const q=`%${escapeLike(search)}%`;args.push(q,q,q);}
  args.push(Math.max(1,Math.min(500,Number(limit)||100)));
  return db.prepare(`SELECT s.*,p.name persona_name,
    (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) message_count,
    (SELECT substr(content_text,1,240) FROM messages m WHERE m.session_id=s.id ORDER BY m.id DESC LIMIT 1) recent_message,
    (SELECT created_at FROM messages m WHERE m.session_id=s.id ORDER BY m.id DESC LIMIT 1) recent_message_at
    FROM sessions s LEFT JOIN personas p ON p.id=s.persona_id ${where.length?`WHERE ${where.join(" AND ")}`:""}
    ORDER BY s.updated_at DESC LIMIT ?`).all(...args);
}

export function setSessionArchived(id,archived){
  const t=now();db.prepare("UPDATE sessions SET archived_at=?,updated_at=? WHERE id=?").run(archived?t:null,t,id);return getSession(id);
}
export function clearSessionMessages(id){
  const session=getSession(id);if(!session)return null;
  const count=Number(db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id=?").get(id).c);
  db.exec("BEGIN IMMEDIATE");
  try{
    db.prepare("DELETE FROM messages WHERE session_id=?").run(id);
    db.prepare("DELETE FROM idempotency_cache WHERE session_id=?").run(id);
    db.prepare("UPDATE sessions SET summary=NULL,summary_through_message_id=0,updated_at=? WHERE id=?").run(now(),id);
    db.exec("COMMIT");
  }catch(e){try{db.exec("ROLLBACK");}catch{}throw e;}
  return {session_id:id,deleted_messages:count};
}
export function deleteSession(id){
  const session=getSession(id);if(!session)return null;
  db.exec("BEGIN IMMEDIATE");
  try{
    db.prepare("DELETE FROM messages WHERE session_id=?").run(id);
    db.prepare("DELETE FROM usage_log WHERE session_id=?").run(id);
    db.prepare("DELETE FROM idempotency_cache WHERE session_id=?").run(id);
    db.prepare("UPDATE events SET session_id=NULL WHERE session_id=?").run(id);
    db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    db.exec("COMMIT");
  }catch(e){try{db.exec("ROLLBACK");}catch{}throw e;}
  return session;
}

function rowToMessage(r){
  let content = r.content_text ?? "";
  let voiceAsset;
  let voiceMessage;
  if (r.content_json != null) {
    try {
      const parsed = JSON.parse(r.content_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.text === "string") {
        content = parsed.text;
        if (parsed.voice_asset) voiceAsset = parsed.voice_asset;
        if (parsed.voice_message) voiceMessage = parsed.voice_message;
      } else {
        content = parsed;
      }
    } catch {}
  }
  let tool_calls;
  if (r.tool_calls_json) { try { tool_calls = JSON.parse(r.tool_calls_json); } catch {} }
  const out={id:r.id,role:r.role,content,reasoning_content:r.reasoning??undefined,tool_calls,tool_call_id:r.tool_call_id??undefined};
  if(voiceAsset)out.voice_asset=voiceAsset;
  if(voiceMessage)out.voice_message=voiceMessage;
  if(voiceMessage?.type||voiceAsset)out.type=voiceMessage?.type??"voice";
  if (r.content_json != null) {
    try {
      const parsed = JSON.parse(r.content_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (parsed.voice_plan && typeof parsed.voice_plan === "object") out.voice_plan = parsed.voice_plan;
        if (parsed.voice_job && typeof parsed.voice_job === "object") out.voice_job = parsed.voice_job;
      }
    } catch {}
  }
  return out;
}

// web_sources 存放在 content_json 的对象形态 {text, web_sources} 中（无 schema migration）。
export function webSourcesForAdminRow(r){
  if (r.content_json == null) return null;
  try {
    const parsed = JSON.parse(r.content_json);
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.web_sources))
      ? parsed.web_sources : null;
  } catch { return null; }
}

export function bubbleMetadataForAdminRow(r){
  if(r.content_json==null)return {};
  try{
    const parsed=JSON.parse(r.content_json);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return {};
    const bubbleIndex=Number.isFinite(Number(parsed.bubble_index))?Number(parsed.bubble_index):null;
    const bubbleCount=Number.isFinite(Number(parsed.bubble_count))?Number(parsed.bubble_count):null;
    return {
      ...(bubbleIndex!==null?{bubble_index:bubbleIndex}:{}),
      ...(bubbleCount!==null?{bubble_count:bubbleCount}:{}),
      ...(typeof parsed.bubble_turn_id==="string"?{bubble_turn_id:parsed.bubble_turn_id}:{}),
      ...(typeof parsed.generation_route==="string"?{generation_route:parsed.generation_route}:{}),
      ...(typeof parsed.origin==="string"?{origin:parsed.origin}:{}),
      ...(parsed.post_message&&typeof parsed.post_message==="object"?{post_message:parsed.post_message}:{}),
      ...(parsed.voice_plan&&typeof parsed.voice_plan==="object"?{voice_plan:parsed.voice_plan}:{})
    };
  }catch{return {};}
}

export function listRecentMessagesAfter(sessionId,afterId,limit){
  const rows=db.prepare("SELECT * FROM messages WHERE session_id=? AND id>? ORDER BY id DESC LIMIT ?").all(sessionId,afterId,limit).reverse();
  return rows.map(rowToMessage);
}
export function getLastSessionUserText(sessionId){return db.prepare("SELECT content_text FROM messages WHERE session_id=? AND role='user' AND content_text IS NOT NULL AND trim(content_text)<>'' ORDER BY id DESC LIMIT 1").get(sessionId)?.content_text??"";}
export function getPreviousRealInteraction(sessionId){
  const user=db.prepare("SELECT id,created_at FROM messages WHERE session_id=? AND role='user' AND content_text IS NOT NULL AND trim(content_text)<>'' ORDER BY id DESC LIMIT 1").get(sessionId)??null;
  const assistant=db.prepare("SELECT id,created_at FROM messages WHERE session_id=? AND role='assistant' AND content_text IS NOT NULL AND trim(content_text)<>'' AND (tool_calls_json IS NULL OR tool_calls_json='[]') ORDER BY id DESC LIMIT 1").get(sessionId)??null;
  return {user:user?{id:Number(user.id),createdAt:user.created_at}:null,assistant:assistant?{id:Number(assistant.id),createdAt:assistant.created_at}:null};
}
export function listMessagesForAdmin(sessionId,limit=200){
  return db.prepare("SELECT id,role,content_json,content_text,reasoning,tool_calls_json,tool_call_id,source,created_at FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?").all(sessionId,limit).reverse();
}
export function findSessionToolCall(sessionId,callId){
  if(!callId)return null;
  const rows=db.prepare("SELECT tool_calls_json FROM messages WHERE session_id=? AND tool_calls_json IS NOT NULL ORDER BY id DESC LIMIT 200").all(sessionId);
  for(const row of rows){try{const calls=JSON.parse(row.tool_calls_json);const call=Array.isArray(calls)?calls.find(x=>String(x?.id??"")===String(callId)):null;if(call)return call;}catch{}}
  return null;
}
export function hasSessionToolResult(sessionId,callId){
  if(!callId)return false;
  return Boolean(db.prepare("SELECT 1 AS ok FROM messages WHERE session_id=? AND role='tool' AND tool_call_id=? LIMIT 1").get(sessionId,String(callId))?.ok);
}
export function searchMessagesForAdmin(sessionId,{search="",limit=500}={}){
  const n=Math.max(1,Math.min(2000,Number(limit)||500));
  if(!search)return listMessagesForAdmin(sessionId,n);
  return db.prepare("SELECT id,role,content_json,content_text,reasoning,tool_calls_json,tool_call_id,source,created_at FROM messages WHERE session_id=? AND (content_text LIKE ? ESCAPE '\\' OR reasoning LIKE ? ESCAPE '\\' OR tool_calls_json LIKE ? ESCAPE '\\') ORDER BY id DESC LIMIT ?").all(sessionId,...Array(3).fill(`%${escapeLike(search)}%`),n).reverse();
}

export function insertMessage(sessionId, source, m) {
  const t=now();
  const hasSources=Array.isArray(m.web_sources)&&m.web_sources.length>0;
  const proactiveAttemptKey=typeof m.proactive_attempt_key==="string"?m.proactive_attempt_key.slice(0,120):"";
  const voiceAsset=m.voice_asset&&typeof m.voice_asset==="object"?m.voice_asset:null;
  const voiceMessage=m.voice_message&&typeof m.voice_message==="object"?m.voice_message:null;
  const voicePlan=m.voice_plan&&typeof m.voice_plan==="object"?m.voice_plan:null;
  const bubbleIndex=Number.isFinite(Number(m.bubble_index))?Number(m.bubble_index):null;
  const bubbleCount=Number.isFinite(Number(m.bubble_count))?Number(m.bubble_count):null;
  const bubbleTurnId=typeof m.bubble_turn_id==="string"?m.bubble_turn_id.slice(0,160):"";
  const generationRoute=typeof m.generation_route==="string"?m.generation_route.slice(0,80):"";
  const origin=typeof m.origin==="string"?m.origin.slice(0,40):"";
  const postMessage=m.post_message&&typeof m.post_message==="object"?m.post_message:null;
  const voiceJob=m.voice_job&&typeof m.voice_job==="object"?m.voice_job:null;
  const needsObject=hasSources||proactiveAttemptKey||voiceAsset||voiceMessage||voicePlan||bubbleIndex!==null||bubbleCount!==null||bubbleTurnId||generationRoute||origin||postMessage||voiceJob;
  const contentJson=needsObject
    ? JSON.stringify({
        text:typeof m.content==="string"?m.content:"",
        ...(hasSources?{web_sources:m.web_sources}:{}),
        ...(proactiveAttemptKey?{proactive_attempt_key:proactiveAttemptKey}:{}),
        ...(voiceAsset?{voice_asset:voiceAsset}:{}),
        ...(voiceMessage?{voice_message:voiceMessage}:{}),
        ...(voicePlan?{voice_plan:voicePlan}:{}),
        ...(voiceJob?{voice_job:voiceJob}:{}),
        ...(bubbleIndex!==null?{bubble_index:bubbleIndex}:{}),
        ...(bubbleCount!==null?{bubble_count:bubbleCount}:{}),
        ...(bubbleTurnId?{bubble_turn_id:bubbleTurnId}:{}),
        ...(generationRoute?{generation_route:generationRoute}:{}),
        ...(origin?{origin}:{}),
        ...(postMessage?{post_message:postMessage}:{})
      })
    : (m.content===undefined?null:JSON.stringify(m.content));
  const info=db.prepare(`INSERT INTO messages(session_id,role,content_json,content_text,reasoning,tool_calls_json,tool_call_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    sessionId, m.role, contentJson, messageText(m.content), typeof m.reasoning_content==="string"?m.reasoning_content:null, m.tool_calls?JSON.stringify(m.tool_calls):null, m.tool_call_id??null, source, t
  );
  for(const mediaId of mediaIdsForContent(m.content))attachMediaToMessage(mediaId,Number(info.lastInsertRowid));
  if(m.voice_asset?.voice_asset_id)attachMediaToMessage(m.voice_asset.voice_asset_id,Number(info.lastInsertRowid));
  db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(t,sessionId);
  return Number(info.lastInsertRowid);
}

export function findProactiveMessageByAttemptKey(attemptKey){
  const key=String(attemptKey??"").slice(0,120);if(!key)return null;
  return db.prepare(`SELECT id,session_id,content_text,created_at FROM messages
    WHERE json_valid(content_json) AND json_type(content_json)='object'
      AND json_extract(content_json,'$.proactive_attempt_key')=?
    ORDER BY id DESC LIMIT 1`).get(key)??null;
}

export function getMessageById(id){
  const n=Number(id);
  if(!Number.isFinite(n)||n<=0)return null;
  return db.prepare("SELECT * FROM messages WHERE id=?").get(n)??null;
}

/**
 * Safe content_json merge. Never clobbers sibling fields
 * (text, post_message, origin, bubble_*, voice_plan, voice_asset, ...).
 */
export function mergeMessageContentJson(messageId, patch){
  const row=getMessageById(messageId);
  if(!row)return null;
  let base={};
  if(row.content_json!=null){
    try{
      const parsed=JSON.parse(row.content_json);
      if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))base={...parsed};
      else if(typeof parsed==="string")base={text:parsed};
    }catch{base={text:row.content_text??""};}
  }else base={text:row.content_text??""};
  if(patch&&typeof patch==="object"){
    for(const [key,value] of Object.entries(patch)){
      if(value===undefined)continue;
      if(value===null){delete base[key];continue;}
      const prev=base[key];
      if(value&&typeof value==="object"&&!Array.isArray(value)&&prev&&typeof prev==="object"&&!Array.isArray(prev)){
        base[key]={...prev,...value};
      }else base[key]=value;
    }
  }
  if(typeof base.text!=="string")base.text=row.content_text??"";
  db.prepare("UPDATE messages SET content_json=? WHERE id=?").run(JSON.stringify(base),Number(row.id));
  return base;
}

export function getMessageContentObject(messageId){
  const row=getMessageById(messageId);
  if(!row)return null;
  if(row.content_json==null)return {text:row.content_text??""};
  try{
    const parsed=JSON.parse(row.content_json);
    if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed;
    if(typeof parsed==="string")return {text:parsed};
  }catch{}
  return {text:row.content_text??""};
}

export function hasUserMessageAfter(sessionId, messageId){
  const sid=String(sessionId??""),mid=Number(messageId);
  if(!sid||!Number.isFinite(mid))return false;
  return Boolean(db.prepare("SELECT 1 AS ok FROM messages WHERE session_id=? AND role='user' AND id>? LIMIT 1").get(sid,mid)?.ok);
}

export function findVoiceJobByAttemptKey(attemptKey){
  const key=String(attemptKey??"").slice(0,160);
  if(!key)return null;
  return db.prepare(`SELECT id,session_id,content_text,created_at FROM messages
    WHERE role='assistant'
      AND json_valid(content_json) AND json_type(content_json)='object'
      AND json_extract(content_json,'$.voice_job.attempt_key')=?
    ORDER BY id DESC LIMIT 1`).get(key)??null;
}

export function listPendingVoiceJobMessages(limit=50){
  const n=Math.max(1,Math.min(200,Number(limit)||50));
  return db.prepare(`SELECT id,session_id,content_text,content_json,created_at FROM messages
    WHERE role='assistant'
      AND json_valid(content_json) AND json_type(content_json)='object'
      AND json_extract(content_json,'$.voice_job.state') IN ('queued','synthesizing')
    ORDER BY id ASC LIMIT ?`).all(n);
}

/** Durable post-message follow-up row: only real follow-up bubbles, never text-similarity. */
export function findPostMessageFollowupByAttemptKey(attemptKey){
  const key=String(attemptKey??"").slice(0,160);if(!key)return null;
  return db.prepare(`SELECT id,session_id,content_text,created_at FROM messages
    WHERE role='assistant'
      AND json_valid(content_json) AND json_type(content_json)='object'
      AND json_extract(content_json,'$.origin')='post_message_followup'
      AND json_extract(content_json,'$.post_message.attempt_key')=?
    ORDER BY id DESC LIMIT 1`).get(key)??null;
}

export function appendIncomingMessages(sessionId,source,messages){
  return appendIncomingMessagesDetailed(sessionId,source,messages).count;
}

export function appendIncomingMessagesDetailed(sessionId,source,messages){
  if(!messages.length)return {count:0,messages:[]};
  const recentRows=db.prepare("SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?").all(sessionId,Math.max(messages.length+8,16)).reverse();
  const recent=recentRows.map(rowToMessage);
  const rs=recent.map(messageSignature), ms=messages.map(messageSignature);
  let overlap=0;
  for(let k=Math.min(rs.length,ms.length);k>=1;k--){
    let ok=true;
    for(let i=0;i<k;i++){if(rs[rs.length-k+i]!==ms[i]){ok=false;break;}}
    if(ok){overlap=k;break;}
  }
  const inserted=[];
  for(const m of messages.slice(overlap)){
    const id=insertMessage(sessionId,source,m),row=db.prepare("SELECT created_at FROM messages WHERE id=?").get(id);
    inserted.push({id,role:m.role,contentText:messageText(m.content),createdAt:row.created_at});
  }
  return {count:inserted.length,messages:inserted};
}

export function listSummarizableMessagesAfter(sessionId,afterId,limit){
  return db.prepare("SELECT id,role,content_text,source,created_at FROM messages WHERE session_id=? AND id>? AND role<>'tool' AND content_text IS NOT NULL AND trim(content_text)<>'' ORDER BY id ASC LIMIT ?").all(sessionId,afterId,limit);
}
export function countSummarizableMessagesAfter(sessionId,afterId){
  return Number(db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id=? AND id>? AND role<>'tool' AND content_text IS NOT NULL AND trim(content_text)<>''").get(sessionId,afterId).c);
}
export function listRecentSummarizableMessages(sessionId,limit){
  return db.prepare("SELECT * FROM (SELECT id,role,content_text,source,created_at FROM messages WHERE session_id=? AND role<>'tool' AND content_text IS NOT NULL AND trim(content_text)<>'' ORDER BY id DESC LIMIT ?) ORDER BY id ASC").all(sessionId,Math.max(1,limit));
}
export function updateSessionSummary(sessionId, summary, throughId) { db.prepare("UPDATE sessions SET summary=?,summary_through_message_id=?,updated_at=? WHERE id=?").run(summary,throughId,now(),sessionId); }

function verifiedUserMessageId(personaId,messageId,sessionId=null){
  if(messageId==null)return null;
  const row=db.prepare("SELECT m.id,m.session_id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=? AND m.role='user' AND s.persona_id=?").get(String(messageId),personaId);
  if(!row||(sessionId&&row.session_id!==sessionId))return null;
  return String(row.id);
}
export function getVerifiedUserSource(personaId,messageId,sessionId=null){
  if(messageId==null)return null;
  const row=db.prepare("SELECT m.id,m.session_id,m.content_text FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=? AND m.role='user' AND s.persona_id=?").get(String(messageId),personaId);
  if(!row||(sessionId&&row.session_id!==sessionId))return null;
  return {id:String(row.id),session_id:row.session_id,content_text:String(row.content_text??"")};
}

export function insertMemory({personaId,content,type="fact",importance=0.5,confidence=0.7,pinned=false,status="staging",source="summary",temporalState="current",evidenceMode="derived",sourceMessageId=null}) {
  const normalized=normalizeMemoryText(content); if (!normalized) return null;
  const id=uuid(), t=now(),sourceId=verifiedUserMessageId(personaId,sourceMessageId);
  try {
    db.prepare("INSERT INTO memories(id,persona_id,content,normalized_content,type,importance,confidence,pinned,status,source,temporal_state,evidence_mode,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,personaId,content.trim(),normalized,type,clamp01(importance),clamp01(confidence),pinned?1:0,status,source,temporalState,evidenceMode,sourceId,t,t);
    db.prepare("INSERT INTO memory_fts(memory_id,persona_id,content) VALUES(?,?,?)").run(id,personaId,content.trim());
    return getMemory(id);
  } catch (e) {
    if (String(e.message).includes("UNIQUE constraint failed")) return null;
    throw e;
  }
}
export function getMemory(id) { return db.prepare("SELECT * FROM memories WHERE id=?").get(id) ?? null; }
export function getEventForSourceMessage(personaId,messageId){
  return db.prepare("SELECT * FROM events WHERE persona_id=? AND source_message_id=? ORDER BY created_at DESC LIMIT 1").get(personaId,String(messageId))??null;
}
export function listEventsForSourceMessage(personaId,messageId){
  return db.prepare("SELECT * FROM events WHERE persona_id=? AND source_message_id=? ORDER BY created_at DESC LIMIT 20").all(personaId,String(messageId));
}
export function listMemories(personaId,status="active") { return db.prepare("SELECT * FROM memories WHERE persona_id=? AND status=? ORDER BY pinned DESC,importance DESC,updated_at DESC").all(personaId,status); }
export function listMemoriesAdmin({personaId,status="all",type="",source="",pinned="all",search="",limit=500}={}){
  const where=["persona_id=?"],args=[personaId];
  if(status&&status!=="all"){where.push("status=?");args.push(status);}
  if(type){where.push("type=?");args.push(type);}
  if(source){where.push("source=?");args.push(source);}
  if(pinned==="true")where.push("pinned=1");else if(pinned==="false")where.push("pinned=0");
  if(search){where.push("content LIKE ? ESCAPE '\\'");args.push(`%${escapeLike(search)}%`);}
  args.push(Math.max(1,Math.min(2000,Number(limit)||500)));
  return db.prepare(`SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY pinned DESC,importance DESC,updated_at DESC LIMIT ?`).all(...args);
}
export function listPinnedMemories(personaId,limit) { return db.prepare("SELECT * FROM memories WHERE persona_id=? AND status='active' AND pinned=1 ORDER BY importance DESC,updated_at DESC LIMIT ?").all(personaId,limit); }
export function listActiveMemories(personaId,limit) { return db.prepare("SELECT * FROM memories WHERE persona_id=? AND status='active' ORDER BY updated_at DESC LIMIT ?").all(personaId,limit); }
export function listRecentMemoriesAnyStatus(personaId,limit){return db.prepare("SELECT * FROM memories WHERE persona_id=? ORDER BY updated_at DESC LIMIT ?").all(personaId,limit);}
export function searchMemoryFts(personaId,query,limit) {
  if (!query.trim()) return [];
  try { return db.prepare(`SELECT m.*,bm25(memory_fts) rank FROM memory_fts JOIN memories m ON m.id=memory_fts.memory_id WHERE memory_fts MATCH ? AND memory_fts.persona_id=? AND m.status='active' ORDER BY rank LIMIT ?`).all(query,personaId,limit); }
  catch { return []; }
}
export function updateMemory(id,patch) {
  const cur=getMemory(id); if(!cur) return null;
  const content=patch.content??cur.content, normalized=normalizeMemoryText(content), type=patch.type??cur.type, importance=patch.importance===undefined?cur.importance:clamp01(patch.importance), confidence=patch.confidence===undefined?clamp01(cur.confidence??0.7):clamp01(patch.confidence), pinned=patch.pinned===undefined?cur.pinned:(patch.pinned?1:0), status=patch.status??cur.status, source=patch.source??cur.source, temporalState=patch.temporalState??patch.temporal_state??cur.temporal_state??"current", evidenceMode=patch.evidenceMode??patch.evidence_mode??cur.evidence_mode??"derived";
  try{
    db.prepare("UPDATE memories SET content=?,normalized_content=?,type=?,importance=?,confidence=?,pinned=?,status=?,source=?,temporal_state=?,evidence_mode=?,updated_at=? WHERE id=?").run(content,normalized,type,importance,confidence,pinned,status,source,temporalState,evidenceMode,now(),id);
  }catch(e){if(String(e.message).includes("UNIQUE constraint failed")){const err=new Error("duplicate memory");err.statusCode=409;throw err;}throw e;}
  db.prepare("DELETE FROM memory_fts WHERE memory_id=?").run(id); db.prepare("INSERT INTO memory_fts(memory_id,persona_id,content) VALUES(?,?,?)").run(id,cur.persona_id,content);
  return getMemory(id);
}
export function deleteMemory(id){ db.prepare("DELETE FROM memory_fts WHERE memory_id=?").run(id); db.prepare("DELETE FROM memory_embeddings WHERE memory_id=?").run(id); db.prepare("DELETE FROM memories WHERE id=?").run(id); }
export function deleteMemoryEmbedding(id){db.prepare("DELETE FROM memory_embeddings WHERE memory_id=?").run(id);}
export function upsertMemoryEmbedding(id,model,vector){ db.prepare("INSERT INTO memory_embeddings(memory_id,model,vector_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET model=excluded.model,vector_json=excluded.vector_json,updated_at=excluded.updated_at").run(id,model,JSON.stringify(vector),now()); }
export function listMemoryEmbeddings(personaId,model,limit){ return db.prepare("SELECT m.*,e.vector_json FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id WHERE m.persona_id=? AND m.status='active' AND e.model=? ORDER BY m.updated_at DESC LIMIT ?").all(personaId,model,limit); }
export function recordMemoryAccess(ids){
  const unique=[...new Set(ids)].filter(Boolean);if(!unique.length)return;
  const stmt=db.prepare("UPDATE memories SET last_accessed_at=?,access_count=access_count+1 WHERE id=?");const t=now();
  db.exec("BEGIN IMMEDIATE");try{for(const id of unique)stmt.run(t,id);db.exec("COMMIT");}catch(e){try{db.exec("ROLLBACK");}catch{}throw e;}
}

const EVENT_RELATION_TYPES=new Set(["same_entity","same_topic","related_plan","supersedes","expectation_related"]);
function exactEventLiteral(text,key){
  const needle=String(key??"");if(!needle)return false;
  if(/^[A-Za-z0-9][A-Za-z0-9+.#_-]*$/u.test(needle))return new RegExp(`(^|[^A-Za-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?=$|[^A-Za-z0-9])`,"iu").test(String(text??""));
  return String(text??"").includes(needle);
}
function eventKeys(event){try{return JSON.parse(event?.entity_keys_json??"[]").map(String);}catch{return [];}}
function eventRelationHasEvidence(relationType,from,to,evidenceId,fromSource,toSource){
  const fromText=fromSource?.content_text??"",toText=toSource?.content_text??"";
  if(relationType==="same_entity")return eventKeys(from).some(key=>eventKeys(to).includes(key)&&exactEventLiteral(fromText,key)&&exactEventLiteral(toText,key));
  if(relationType==="same_topic")return Boolean(from.topic_key&&from.topic_key===to.topic_key&&exactEventLiteral(fromText,from.topic_key)&&exactEventLiteral(toText,to.topic_key));
  if(relationType==="expectation_related")return Boolean(from.expectation_id&&from.expectation_id===to.expectation_id);
  if(relationType==="related_plan"){
    const sharedTopic=Boolean(from.topic_key&&from.topic_key===to.topic_key&&exactEventLiteral(fromText,from.topic_key)&&exactEventLiteral(toText,to.topic_key));
    const explicitPlan=/因为|由于|预算|攒钱|先.{1,16}再|等.{1,16}之后|不买了|改成|改为/u.test(`${fromText} ${toText}`);
    return sharedTopic&&explicitPlan;
  }
  if(relationType==="supersedes"){
    const explicitCorrection=/不是.{1,40}是|改成|改为|不买了|之前.{0,24}现在.{0,24}|说错|纠正|原来.{0,20}现在/u.test(fromText);
    const oldRetired=Number(db.prepare("SELECT COUNT(*) n FROM event_memory_links l JOIN memories m ON m.id=l.memory_id WHERE l.event_id=? AND (m.status='retired' OR m.temporal_state='historical')").get(to.id)?.n??0)>0;
    return from.event_kind==="correction"&&from.source_message_id===evidenceId&&explicitCorrection&&oldRetired;
  }
  // v1 has no deterministic evidence contract for these relations yet.
  return false;
}

export function insertEventDetailed({personaId,sessionId=null,source,content,importance=0.5,sourceMessageId=null,eventKind=null,topicKey=null,entityKeys=[],expectationId=null}) {
  const normalized=normalizeMemoryText(content);
  if(!normalized)return {inserted:false,event:null};
  const sourceRow=getVerifiedUserSource(personaId,sourceMessageId,sessionId),sourceId=sourceRow?.id??null;
  const cleanKey=value=>String(value??"").trim().slice(0,80);
  const containsExact=value=>sourceRow?.content_text.toLocaleLowerCase().includes(value.toLocaleLowerCase());
  const topic=cleanKey(topicKey);
  const verifiedTopic=topic&&containsExact(topic)?topic:"";
  const entities=[...new Set((Array.isArray(entityKeys)?entityKeys:[]).map(cleanKey).filter(key=>key.length>=2&&containsExact(key)))].slice(0,8);
  const recent=db.prepare("SELECT * FROM events WHERE persona_id=? ORDER BY created_at DESC LIMIT 100").all(personaId);
  const duplicate=recent.find(r=>normalizeMemoryText(r.content)===normalized);
  if(duplicate&&sourceId==null)return {inserted:false,event:null};
  const sameCapture=sourceId&&recent.find(r=>r.source_message_id===sourceId&&r.event_kind===(eventKind?cleanKey(eventKind):null)&&normalizeMemoryText(r.content)===normalized);
  if(sameCapture)return {inserted:false,event:sameCapture};
  const id=uuid(),createdAt=now();
  db.prepare("INSERT INTO events(id,persona_id,session_id,source,content,importance,source_message_id,event_kind,topic_key,entity_keys_json,expectation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id,personaId,sessionId,source,content.trim(),clamp01(importance),sourceId,eventKind?cleanKey(eventKind):null,verifiedTopic||null,JSON.stringify(entities),expectationId==null?null:String(expectationId),createdAt);
  const event=db.prepare("SELECT * FROM events WHERE id=?").get(id);
  onEventInserted.fn?.({source,personaId,content:content.trim(),importance,event});
  return {inserted:true,event};
}
export function insertEvent(input){return insertEventDetailed(input).inserted;}

export function linkEventToMemory(eventId,memoryId,{linkType="source_message"}={}){
  const event=db.prepare("SELECT id,persona_id,source_message_id,session_id FROM events WHERE id=?").get(eventId);
  const memory=db.prepare("SELECT id,persona_id,source_message_id FROM memories WHERE id=?").get(memoryId);
  if(!event||!memory||event.persona_id!==memory.persona_id)return false;
  const sourceId=verifiedUserMessageId(event.persona_id,event.source_message_id,event.session_id);
  if(!sourceId||memory.source_message_id!==sourceId||!new Set(["source_message","same_capture"]).has(linkType))return false;
  db.prepare("INSERT OR IGNORE INTO event_memory_links(event_id,memory_id,link_type,created_at) VALUES(?,?,?,?)").run(event.id,memory.id,linkType,now());
  return Boolean(db.prepare("SELECT 1 ok FROM event_memory_links WHERE event_id=? AND memory_id=? AND link_type=?").get(event.id,memory.id,linkType));
}

export function insertEventAssociation({personaId,fromEventId,toEventId,relationType,strength=0.7,confidence=0.85,evidenceMessageId=null}){
  if(!EVENT_RELATION_TYPES.has(relationType)||!fromEventId||!toEventId||fromEventId===toEventId)return false;
  const [from,to]=[fromEventId,toEventId].map(id=>db.prepare("SELECT * FROM events WHERE id=?").get(id));
  if(!from||!to||from.persona_id!==personaId||to.persona_id!==personaId)return false;
  const evidenceId=verifiedUserMessageId(personaId,evidenceMessageId);
  if(!evidenceId||![from.source_message_id,to.source_message_id].includes(evidenceId))return false;
  const [fromSource,toSource]=[from,to].map(event=>getVerifiedUserSource(personaId,event.source_message_id,event.session_id));
  if(!fromSource||!toSource||!eventRelationHasEvidence(relationType,from,to,evidenceId,fromSource,toSource))return false;
  const alreadyExists=getEventAssociation(fromEventId,toEventId,relationType);
  if(!alreadyExists&&Number(db.prepare("SELECT COUNT(*) n FROM event_associations WHERE from_event_id=?").get(fromEventId)?.n??0)>=5)return false;
  db.prepare("INSERT OR IGNORE INTO event_associations(id,persona_id,from_event_id,to_event_id,relation_type,strength,confidence,evidence_message_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(uuid(),personaId,fromEventId,toEventId,relationType,clamp01(strength),clamp01(confidence),evidenceId,now());
  return Boolean(db.prepare("SELECT 1 ok FROM event_associations WHERE from_event_id=? AND to_event_id=? AND relation_type=?").get(fromEventId,toEventId,relationType));
}
export function getEventAssociation(fromEventId,toEventId,relationType){
  return db.prepare("SELECT * FROM event_associations WHERE from_event_id=? AND to_event_id=? AND relation_type=?").get(fromEventId,toEventId,relationType)??null;
}

export function listEventAssociatedMemories(eventId,{maxEvents=5,maxMemories=5}={}){
  const edges=db.prepare("SELECT a.*,e.content event_content,e.importance event_importance,e.event_kind,e.topic_key,e.entity_keys_json,e.created_at event_created_at FROM event_associations a JOIN events e ON e.id=a.to_event_id WHERE a.from_event_id=? ORDER BY a.confidence DESC,a.strength DESC,a.created_at DESC LIMIT ?").all(eventId,Math.max(0,Math.min(5,Number(maxEvents)||5)));
  if(!edges.length)return [];
  const result=[],seen=new Set();
  const stmt=db.prepare("SELECT m.* FROM event_memory_links l JOIN memories m ON m.id=l.memory_id WHERE l.event_id=? ORDER BY m.pinned DESC,m.importance DESC,m.updated_at DESC LIMIT ?");
  for(const edge of edges){
    for(const memory of stmt.all(edge.to_event_id,Math.max(1,Math.min(5,Number(maxMemories)||5)))){
      if(seen.has(memory.id))continue;seen.add(memory.id);
      result.push({memory,association:{event_id:edge.to_event_id,relation_type:edge.relation_type,strength:edge.strength,confidence:edge.confidence,evidence_message_id:edge.evidence_message_id,event_created_at:edge.event_created_at,created_at:edge.created_at,hop:1}});
      if(result.length>=Math.max(0,Math.min(5,Number(maxMemories)||5)))return result;
    }
  }
  return result;
}

export function listEventMemoryLinksForMemory(memoryId){
  return db.prepare("SELECT e.*,l.link_type FROM event_memory_links l JOIN events e ON e.id=l.event_id WHERE l.memory_id=? ORDER BY l.created_at DESC").all(memoryId);
}
export const onEventInserted={fn:null};
export function listRecentEvents(personaId,limit){ return db.prepare("SELECT * FROM events WHERE persona_id=? ORDER BY created_at DESC LIMIT ?").all(personaId,limit); }
export function insertUsage({sessionId,source,publicModel,upstreamModel,kind="chat",usage={}}){
  const prompt=usage.prompt_tokens??usage.input_tokens??null,completion=usage.completion_tokens??usage.output_tokens??null;
  const total=usage.total_tokens??(prompt!=null&&completion!=null?Number(prompt)+Number(completion):null);
  const cached=usage.cached_tokens??usage.prompt_tokens_details?.cached_tokens??usage.input_tokens_details?.cached_tokens??null;
  const createdAt=now(),result=db.prepare("INSERT INTO usage_log(session_id,source,public_model,upstream_model,kind,prompt_tokens,completion_tokens,total_tokens,cached_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(sessionId,source,publicModel,upstreamModel,kind,prompt,completion,total,cached,createdAt);
  invocationLedger.append({timestamp:createdAt,requestKey:`legacy-sql:${result.lastInsertRowid}`,sessionId,source,publicModel,upstreamModel,feature:kind,usage,usageSource:"provider"});
}
export function getLastAgentUsageProvider(sessionId){
  const row=db.prepare("SELECT upstream_model FROM usage_log WHERE session_id=? AND kind='agent' ORDER BY id DESC LIMIT 1").get(sessionId),name=String(row?.upstream_model??"").split(":",1)[0];
  return name==="primary"||name==="secondary"?name:null;
}

export function usageOverview(){
  return db.prepare(`SELECT COUNT(*) requests,COALESCE(SUM(prompt_tokens),0) prompt_tokens,COALESCE(SUM(completion_tokens),0) completion_tokens,COALESCE(SUM(total_tokens),0) total_tokens,COALESCE(SUM(cached_tokens),0) cached_tokens FROM usage_log`).get();
}
export function listUsageStats({from="",to="",source="",publicModel="",upstreamModel="",sessionId="",kind="",groupBy="date"}={}){
  const dimensions={date:"substr(created_at,1,10)",source:"source",public_model:"public_model",upstream_model:"upstream_model",session:"COALESCE(session_id,'')",kind:"kind"};
  const expr=dimensions[groupBy]??dimensions.date,where=[],args=[];
  if(from){where.push("created_at>=?");args.push(from.length===10?`${from}T00:00:00.000Z`:from);}
  if(to){where.push("created_at<=?");args.push(to.length===10?`${to}T23:59:59.999Z`:to);}
  for(const [value,column] of [[source,"source"],[publicModel,"public_model"],[upstreamModel,"upstream_model"],[sessionId,"session_id"],[kind,"kind"]])if(value){where.push(`${column}=?`);args.push(value);}
  return db.prepare(`SELECT ${expr} bucket,COUNT(*) requests,COALESCE(SUM(prompt_tokens),0) prompt_tokens,COALESCE(SUM(completion_tokens),0) completion_tokens,COALESCE(SUM(total_tokens),0) total_tokens,COALESCE(SUM(cached_tokens),0) cached_tokens FROM usage_log ${where.length?`WHERE ${where.join(" AND ")}`:""} GROUP BY ${expr} ORDER BY bucket DESC LIMIT 1000`).all(...args);
}

export function getIdempotentResponse(sessionId,key){
  if(!key)return null;
  const r=db.prepare("SELECT response_json FROM idempotency_cache WHERE session_id=? AND request_key=?").get(sessionId,key);
  return r?JSON.parse(r.response_json):null;
}
export function putIdempotentResponse(sessionId,key,response){
  if(!key)return;
  db.prepare("INSERT OR REPLACE INTO idempotency_cache(session_id,request_key,response_json,created_at) VALUES(?,?,?,?)").run(sessionId,key,JSON.stringify(response),now());
  db.prepare("DELETE FROM idempotency_cache WHERE created_at < datetime('now','-1 day')").run();
}

export function getStatusCounts(){
  const one=q=>Number(db.prepare(q).get().c);
  return {personas:one("SELECT COUNT(*) c FROM personas"),sessions:one("SELECT COUNT(*) c FROM sessions"),archived_sessions:one("SELECT COUNT(*) c FROM sessions WHERE archived_at IS NOT NULL"),messages:one("SELECT COUNT(*) c FROM messages"),memories:one("SELECT COUNT(*) c FROM memories"),active_memories:one("SELECT COUNT(*) c FROM memories WHERE status='active'"),staging_memories:one("SELECT COUNT(*) c FROM memories WHERE status='staging'"),pinned_memories:one("SELECT COUNT(*) c FROM memories WHERE pinned=1"),events:one("SELECT COUNT(*) c FROM events"),usage_records:one("SELECT COUNT(*) c FROM usage_log"),diary_entries:one("SELECT COUNT(*) c FROM diary_entries")};
}
export function getSqliteStatus(){
  return {ok:true,path:config.databasePath,journal_mode:db.prepare("PRAGMA journal_mode").get().journal_mode,user_version:Number(db.prepare("PRAGMA user_version").get().user_version),schema_version:SCHEMA_VERSION,foreign_keys:Boolean(db.prepare("PRAGMA foreign_keys").get().foreign_keys)};
}
