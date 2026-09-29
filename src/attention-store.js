import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { uuid } from "./utils.js";
import { ATTENTION_TYPES,attentionDedupeKey,evaluateDelivery } from "./proactive-delivery-policy.js";
import { companionTime } from "./time-service.js";

const STATUSES=new Set(["unread","read","dismissed","snoozed"]);
const FORBIDDEN=/secret|token|password|authorization|stderr|diff|audio|transcript|screenshot/i;

function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(tmp,file);
  try{fs.chmodSync(file,0o600);}catch{}
}

function safeText(value,max){
  return String(value??"").replace(/\/Users\/[^\s]+/g,"[local path]").replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max);
}

export class AttentionStore{
  constructor({file,now=()=>new Date(),maxItems=200,maxAgeMs=14*24*60*60*1000}={}){
    this.file=file??path.join(path.dirname(config.databasePath),"attention.json");
    this.now=now;this.maxItems=maxItems;this.maxAgeMs=maxAgeMs;
    this.state=this.load();
  }
  empty(){return {version:1,items:[],updated_at:null};}
  load(){
    try{
      const parsed=JSON.parse(fs.readFileSync(this.file,"utf8"));
      if(parsed?.version===1&&Array.isArray(parsed.items))return parsed;
    }catch{}
    return this.empty();
  }
  persist(){this.prune();this.state.updated_at=this.now().toISOString();atomic(this.file,this.state);return this.snapshot();}
  prune(){
    const cutoff=this.now().getTime()-this.maxAgeMs;
    this.state.items=this.state.items.filter(item=>Date.parse(item.created_at)>=cutoff).slice(-this.maxItems);
  }
  snapshot({limit=50,status=null}={}){
    let items=this.state.items;
    if(status)items=items.filter(item=>item.status===status);
    return {
      generatedAt:companionTime.nowUTC(),
      timeZone:companionTime.timeZone,
      unread:this.state.items.filter(item=>item.status==="unread").length,
      items:[...items].reverse().slice(0,Math.max(1,Math.min(200,limit)))
    };
  }
  record(input={},context={}){
    const type=ATTENTION_TYPES.includes(input.type)?input.type:null;
    if(!type)return {ok:false,reason:"unknown_type"};
    const payload={};
    for(const [key,value] of Object.entries(input)){
      if(FORBIDDEN.test(key))continue;
      payload[key]=value;
    }
    const item={
      id:uuid(),
      type,
      source:safeText(payload.source??"core",40),
      resource:safeText(payload.resource??"",120),
      fingerprint:safeText(payload.fingerprint??payload.summary??"",160),
      title:safeText(payload.title??"林小糖",60),
      summary:safeText(payload.summary??"",180),
      destination:safeText(payload.destination??"today",32),
      conversation_id:payload.conversation_id?safeText(payload.conversation_id,120):null,
      turn_id:payload.turn_id?safeText(payload.turn_id,80):null,
      state:safeText(payload.state??"",32),
      status:"unread",
      created_at:this.now().toISOString(),
      delivered_at:null
    };
    item.dedupe_key=attentionDedupeKey(item);
    const decision=evaluateDelivery(item,{now:this.now(),history:this.state.items,settings:context.settings,quietHours:context.quietHours,behavior:context.behavior});
    if(decision.action!=="deliver")return {ok:true,delivered:false,decision,item:null};
    item.delivered_at=item.created_at;
    this.state.items.push(item);
    this.persist();
    return {ok:true,delivered:true,decision,item};
  }
  mark(id,status){
    if(!STATUSES.has(status))return null;
    const item=this.state.items.find(entry=>entry.id===id);
    if(!item)return null;
    item.status=status;
    item.updated_at=this.now().toISOString();
    this.persist();
    return item;
  }
}

export const attentionStore=new AttentionStore();
