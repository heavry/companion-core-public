import fs from "node:fs";
import path from "node:path";
import { uuid } from "./utils.js";

const ACTIVE=new Set(["RECEIVED","GENERATING","TOOL_WAIT","GENERATING_FINAL","FINALIZING","RETRY_WAIT","DEGRADED"]);
const TERMINAL=new Set(["COMMITTED","FAILED","CANCELLED"]);

function copy(value){return value==null?value:structuredClone(value);}
function cleanPlan(plan){
  return (Array.isArray(plan)?plan:[]).slice(0,3).map((item,index)=>({
    bubble_index:Number(item?.bubble_index??index),bubble_count:Number(item?.bubble_count??plan.length),
    text:String(item?.text??"").slice(0,12000),generation_route:String(item?.generation_route??"unknown").slice(0,80),
    turn_id:String(item?.turn_id??"").slice(0,160)||null
  })).filter(item=>item.text);
}

export class TurnRecoveryStore{
  constructor(file,{now=()=>new Date(),id=uuid}={}){this.file=file;this.now=now;this.id=id;this.turns=new Map();this.load();}
  load(){
    try{const parsed=JSON.parse(fs.readFileSync(this.file,"utf8"));for(const item of parsed?.turns??[])if(item?.turn_id)this.turns.set(item.turn_id,item);}catch{}
    let changed=false;
    for(const item of this.turns.values()){
      if(TERMINAL.has(item.state))continue;
      const total=item.plan?.length??0,committed=item.committed?.length??0;
      // Cold boot: empty-plan non-terminal turns never produced a durable bubble
      // plan (upstream generation failed). Keep them terminal so a later retry can
      // begin a fresh generation instead of replaying RETRY_WAIT forever.
      if(!total){
        item.state="FAILED";
        item.error_class=item.error_class||"expired_empty_plan";
      }else{
        item.state=committed>=total?"COMMITTED":"FINALIZING";
      }
      item.recovered_at=this.now().toISOString();changed=true;
    }
    if(changed)this.persist();
  }
  persist(){
    fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=`${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(temp,JSON.stringify({version:1,turns:[...this.turns.values()]},null,2),{mode:0o600});fs.renameSync(temp,this.file);
  }
  begin({turnId,sessionId,userMessageId=null,requestId=null,source="chat",generationId=null}={}){
    const key=String(turnId??"").slice(0,160);if(!key)throw new Error("turnId required");
    const existing=this.turns.get(key);if(existing)return copy(existing);
    const at=this.now().toISOString(),item={turn_id:key,generation_id:String(generationId??this.id()).slice(0,160),session_id:String(sessionId??"").slice(0,160),user_message_id:userMessageId==null?null:Number(userMessageId),request_id:requestId?String(requestId).slice(0,160):null,source:String(source).slice(0,40),state:"RECEIVED",plan:[],committed:[],retry_count:0,created_at:at,updated_at:at};
    this.turns.set(key,item);this.persist();return copy(item);
  }
  transition(turnId,state,patch={}){
    if(!ACTIVE.has(state)&&!TERMINAL.has(state))throw new Error("invalid turn recovery state");
    const item=this.turns.get(String(turnId));if(!item)return null;
    Object.assign(item,patch,{state,updated_at:this.now().toISOString()});this.persist();return copy(item);
  }
  setPlan(turnId,plan){const item=this.turns.get(String(turnId));if(!item)return null;item.plan=cleanPlan(plan);item.state="FINALIZING";item.updated_at=this.now().toISOString();this.persist();return copy(item);}
  noteRetry(turnId){const item=this.turns.get(String(turnId));if(!item)return null;item.retry_count=Number(item.retry_count??0)+1;item.state="RETRY_WAIT";item.updated_at=this.now().toISOString();this.persist();return copy(item);}
  noteCommit(turnId,{bubbleIndex,messageId}={}){
    const item=this.turns.get(String(turnId));if(!item)return null;
    const index=Number(bubbleIndex);if(!item.committed.some(entry=>Number(entry.bubble_index)===index))item.committed.push({bubble_index:index,message_id:Number(messageId)});
    item.committed.sort((a,b)=>a.bubble_index-b.bubble_index);item.state=item.plan.length&&item.committed.length>=item.plan.length?"COMMITTED":"FINALIZING";item.updated_at=this.now().toISOString();this.persist();return copy(item);
  }
  get(turnId){return copy(this.turns.get(String(turnId))??null);}
  findByRequest(sessionId,requestId){
    const session=String(sessionId??""),request=String(requestId??"");if(!session||!request)return null;
    const found=[...this.turns.values()].filter(item=>item.session_id===session&&item.request_id===request).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    return copy(found??null);
  }
  pending(){return [...this.turns.values()].filter(item=>!TERMINAL.has(item.state)).map(copy);}
  prune({keep=500}={}){const items=[...this.turns.values()].sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)));for(const item of items.slice(keep))if(TERMINAL.has(item.state))this.turns.delete(item.turn_id);this.persist();}
}
