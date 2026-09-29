import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

const MAX_PER_SESSION=3;
const DEFAULT_TTL_HOURS=12;

function iso(d=new Date()){return (d instanceof Date?d:new Date(d)).toISOString();}
function fileFor(dir,sessionId){
  return path.join(dir,`repair-${String(sessionId).replace(/[^\w.-]/g,"_").slice(0,80)}.json`);
}

function normalizeRecord(raw,now=new Date()){
  if(!raw||typeof raw!=="object")return null;
  const created=raw.created_at||iso(now);
  const ttl=Number(raw.ttl_hours??DEFAULT_TTL_HOURS);
  const expires=raw.expires_at||new Date(Date.parse(created)+ttl*3600_000).toISOString();
  return {
    id:raw.id||`rp_${crypto.randomBytes(4).toString("hex")}`,
    type:raw.type||"REFERENT_CORRECTION",
    original_interpretation:raw.original_interpretation??null,
    corrected_interpretation:raw.corrected_interpretation??null,
    topic:raw.topic??raw.corrected_interpretation??null,
    created_at:created,
    confidence:Number(raw.confidence??0.8),
    source_message_ids:Array.isArray(raw.source_message_ids)?raw.source_message_ids.slice(0,8):[],
    expires_at:expires,
    ttl_hours:ttl,
    intent:raw.intent??raw.corrected_intent??null,
    correction_source:raw.correction_source??"user",
    corrected_subject:raw.corrected_subject??"object",
    requested_action:raw.requested_action??null,
    corrected_intent:raw.corrected_intent??raw.intent??null,
    actor:raw.actor??null,
    error_owner:raw.error_owner??null,
    referent:raw.referent??null,
    suppressTopics:Array.isArray(raw.suppressTopics)?raw.suppressTopics.slice(0,6):[],
    needsClarification:Boolean(raw.needsClarification),
    possible_errors:Array.isArray(raw.possible_errors)?raw.possible_errors.slice(0,4):[],
    active:raw.active!==false
  };
}

function objectReferent(value){
  const text=String(value??"").trim();
  if(!text||["execute","informational","user","assistant"].includes(text))return null;
  return text;
}

function alive(record,now=new Date()){
  if(!record||record.active===false)return false;
  const exp=Date.parse(record.expires_at??"");
  return !Number.isFinite(exp)||exp>(now instanceof Date?now:new Date(now)).getTime();
}

export class RepairStore{
  constructor({dir=null,ttlHours=DEFAULT_TTL_HOURS}={}){
    this.dir=dir||path.join(path.dirname(config.databasePath),"repair");
    this.ttlHours=ttlHours;
    this.memory=new Map();
  }

  load(sessionId){
    if(this.memory.has(sessionId))return this.memory.get(sessionId);
    const file=fileFor(this.dir,sessionId);
    try{
      const raw=JSON.parse(fs.readFileSync(file,"utf8"));
      const list=Array.isArray(raw?.repairs)?raw.repairs.map(r=>normalizeRecord(r)).filter(Boolean):[];
      this.memory.set(sessionId,list);
      return list;
    }catch{
      this.memory.set(sessionId,[]);
      return [];
    }
  }

  save(sessionId){
    const list=this.load(sessionId);
    fs.mkdirSync(this.dir,{recursive:true});
    const tmp=`${fileFor(this.dir,sessionId)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp,JSON.stringify({version:1,sessionId,repairs:list},null,2),{mode:0o600});
    fs.renameSync(tmp,fileFor(this.dir,sessionId));
  }

  list(sessionId,now=new Date()){
    return this.load(sessionId).filter(r=>alive(r,now));
  }

  current(sessionId,now=new Date()){
    return this.list(sessionId,now)[0]??null;
  }

  add(sessionId,input,now=new Date()){
    const prev=this.current(sessionId,now);
    const inherited={...input};
    if(prev){
      const selfRef=objectReferent(inherited.referent)||objectReferent(inherited.corrected_interpretation);
      inherited.referent=selfRef||objectReferent(prev.referent)||objectReferent(prev.corrected_interpretation)||null;
      if(inherited.type==="INTENT_CORRECTION"){
        inherited.topic=inherited.referent||inherited.topic||prev.topic;
      }
    }
    const record=normalizeRecord({...inherited,ttl_hours:inherited.ttl_hours??this.ttlHours,created_at:iso(now)},now);
    const next=[record,...this.load(sessionId).map(r=>({...r,active:false}))].slice(0,MAX_PER_SESSION);
    // previous stay in history but inactive so the newest correction wins
    next[0].active=true;
    this.memory.set(sessionId,next);
    try{this.save(sessionId);}catch{}
    return record;
  }

  deactivate(sessionId,now=new Date()){
    const list=this.load(sessionId).map(r=>({...r,active:false}));
    this.memory.set(sessionId,list);
    try{this.save(sessionId);}catch{}
    return this.current(sessionId,now);
  }
}

export const repairStore=new RepairStore();
