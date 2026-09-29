import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { companionTime } from "../time-service.js";
import { extractEpisodePatches, hoursAgo, ttlHoursFor } from "./detect.js";

const MAX=6;
const HOUR_MS=3600_000;

function iso(d=new Date()){return (d instanceof Date?d:new Date(d)).toISOString();}
function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(tmp,file);
}

function normalize(ep,now=new Date()){
  if(!ep||typeof ep!=="object")return null;
  const learned=ep.learned_at||iso(now);
  const ttl=Number(ep.ttl_hours??ttlHoursFor(ep.topic));
  return {
    id:ep.id||`ep_${crypto.randomBytes(4).toString("hex")}`,
    fact:String(ep.fact??"").slice(0,80),
    subject:ep.subject||"user",
    topic:ep.topic||"other",
    status:ep.status||"unknown",
    known:ep.known&&typeof ep.known==="object"?{...ep.known}:{},
    unknown:Array.isArray(ep.unknown)?[...new Set(ep.unknown)].slice(0,8):[],
    learned_at:learned,
    last_updated_at:ep.last_updated_at||learned,
    source_message_id:ep.source_message_id??null,
    confidence:Number(ep.confidence??0.9),
    ttl_hours:ttl,
    expires_at:ep.expires_at||new Date(Date.parse(learned)+ttl*HOUR_MS).toISOString()
  };
}

export class RecentEpisodeStore{
  constructor({file=null}={}){
    this.file=file||path.resolve(path.dirname(config.databasePath),"recent-episodes.json");
    this.document={version:1,episodes:[]};
    this.load();
  }
  load(){
    try{
      const raw=JSON.parse(fs.readFileSync(this.file,"utf8"));
      if(raw?.version===1&&Array.isArray(raw.episodes))this.document={version:1,episodes:raw.episodes.map(e=>normalize(e)).filter(Boolean)};
    }catch{}
  }
  save(){
    atomic(this.file,this.document);
  }

  prune(now=new Date()){
    const t=now.getTime();
    this.document.episodes=this.document.episodes.filter(ep=>{
      const exp=Date.parse(ep.expires_at??"");
      return !Number.isFinite(exp)||exp>t;
    }).slice(0,MAX);
  }

  list(now=new Date()){
    this.prune(now);
    return this.document.episodes.map(ep=>{
      const age=hoursAgo(ep.learned_at,now);
      const learnedDate=companionTime.localDate(new Date(ep.learned_at));
      const today=companionTime.localDate(now);
      const stale=Boolean(learnedDate&&today&&learnedDate<today);
      return {...ep,age_hours:age,stale,temporal_status:stale?"past":(ep.status||"unknown")};
    });
  }

  upsert(patch,now=new Date()){
    if(!patch?.topic)return null;
    this.prune(now);
    const at=iso(now);
    let ep=this.document.episodes.find(e=>e.topic===patch.topic);
    if(!ep||patch.replace){
      ep=normalize({
        topic:patch.topic,fact:patch.fact,status:patch.status,known:patch.known,unknown:patch.unknown,
        subject:"user",confidence:patch.confidence??0.92,ttl_hours:patch.ttlHours,source_message_id:patch.source_message_id
      },now);
      this.document.episodes=this.document.episodes.filter(e=>e.topic!==patch.topic);
      this.document.episodes.unshift(ep);
    }else{
      if(patch.fact)ep.fact=patch.fact;
      if(patch.status)ep.status=patch.status;
      ep.known={...ep.known,...(patch.known??{})};
      const unknown=new Set(ep.unknown||[]);
      for(const u of patch.unknown??[])unknown.add(u);
      for(const u of patch.unknownRemove??[])unknown.delete(u);
      for(const key of Object.keys(patch.known??{})){
        if(["satiety","returned","finished","meal_completed"].includes(key))unknown.delete(key==="meal_completed"?"satiety":key);
      }
      ep.unknown=[...unknown];
      ep.last_updated_at=at;
      if(patch.source_message_id)ep.source_message_id=patch.source_message_id;
    }
    this.document.episodes=this.document.episodes.slice(0,MAX);
    this.save();
    return structuredClone(ep);
  }

  observe({text="",role="user",messageId=null,at=new Date()}={}){
    const patches=extractEpisodePatches(text,{role});
    const applied=[];
    for(const patch of patches){
      applied.push(this.upsert({...patch,source_message_id:messageId},at));
    }
    return applied;
  }

  applyRepair({userText="",at=new Date()}={}){
    return this.observe({text:userText,role:"user",at});
  }
}

export const recentEpisodes=new RecentEpisodeStore();
