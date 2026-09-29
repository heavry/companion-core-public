import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

const MAX_SUBJECTS=80;
const DAY_MS=24*60*60_000;
const empty=()=>({
  version:1,
  counters:{
    heartbeat_ticks:0,no_action:0,proactive_sends:0,
    expectation_driven:0,open_loop_driven:0,callback_driven:0,curiosity_driven:0,
    concern_driven:0,pure_social:0,inactivity_only:0,absence_framed:0,
    repeated_subject:0,duplicate_proactive:0,
    suppression_blocks:0,cooldown_blocks:0,suppression_violations:0,cooldown_violations:0,
    irrelevant_callback:0,forced_question:0,advice_reflex:0
  },
  sendsByReason:{},lastTickAt:null,recentSubjects:[]
});

function safeRead(file){
  try{
    const value=JSON.parse(fs.readFileSync(file,"utf8"));
    if(value?.version!==1||!value.counters||typeof value.counters!=="object")return empty();
    const base=empty();
    return {...base,...value,counters:{...base.counters,...value.counters},sendsByReason:{...(value.sendsByReason??{})},recentSubjects:Array.isArray(value.recentSubjects)?value.recentSubjects.slice(-MAX_SUBJECTS):[]};
  }catch{return empty();}
}

function fingerprint(text){
  const normalized=String(text??"").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,"").slice(0,800);
  if(!normalized)return null;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function topicAppears(topic,text){
  const normalize=value=>String(value??"").toLowerCase().replace(/[^\p{L}\p{N}]+/gu,"");
  const t=normalize(topic),body=normalize(text);
  if(t.length<2||body.length<2)return false;
  if(body.includes(t)||t.includes(body))return true;
  const chars=[...new Set([...t])].filter(ch=>/[\p{L}\p{N}]/u.test(ch));
  if(chars.length<2)return false;
  return chars.filter(ch=>body.includes(ch)).length/Math.min(chars.length,5)>=0.4;
}

export class ProactiveCognitionMetrics{
  constructor({file=null,now=()=>new Date()}={}){
    this.file=file||path.resolve(path.dirname(config.companionStatePath),"proactive-cognition-metrics.json");
    this.now=now;
    this.state=safeRead(this.file);
  }
  save(){
    try{
      fs.mkdirSync(path.dirname(this.file),{recursive:true});
      const tmp=`${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(tmp,JSON.stringify(this.state,null,2),{mode:0o600});
      fs.renameSync(tmp,this.file);
    }catch(error){console.error("[proactive-cognition-metrics] persist failed:",error?.message??error);}
  }
  noteTick({at=this.now(),action="NO_ACTION",reason="nothing_worth_saying"}={}){
    const counters=this.state.counters;
    counters.heartbeat_ticks++;
    if(action==="NO_ACTION")counters.no_action++;
    this.state.lastTickAt=(at instanceof Date?at:new Date(at)).toISOString();
    this.state.lastDecision={action,reason:String(reason??"unknown").slice(0,80),at:this.state.lastTickAt};
    this.save();
  }
  noteGateBlock(reasons=[]){
    const list=Array.isArray(reasons)?reasons:[];
    if(list.some(reason=>String(reason).includes("suppression")||String(reason).includes("closure")))this.state.counters.suppression_blocks++;
    if(list.some(reason=>String(reason).includes("cooldown")))this.state.counters.cooldown_blocks++;
    this.save();
  }
  notePolicyViolation(kind){
    if(kind==="suppression")this.state.counters.suppression_violations++;
    if(kind==="cooldown")this.state.counters.cooldown_violations++;
    this.save();
  }
  noteDuplicateSuppressed(){
    this.state.counters.repeated_subject++;
    this.state.counters.duplicate_proactive++;
    this.save();
  }
  isDuplicateSubject(text,at=this.now()){
    const hash=fingerprint(text);
    if(!hash)return false;
    const time=(at instanceof Date?at:new Date(at)).getTime();
    return this.state.recentSubjects.some(item=>item.hash===hash&&time-Date.parse(item.at)>=0&&time-Date.parse(item.at)<=DAY_MS);
  }
  noteDelivery({reason="unknown",topic="",text="",at=this.now()}={}){
    const counters=this.state.counters,hash=fingerprint(text),time=(at instanceof Date?at:new Date(at)).getTime();
    if(hash){
      const duplicate=this.state.recentSubjects.some(item=>item.hash===hash&&time-Date.parse(item.at)<=DAY_MS);
      if(duplicate){counters.repeated_subject++;counters.duplicate_proactive++;this.save();return {duplicate:true};}
    }
    counters.proactive_sends++;
    this.state.sendsByReason[reason]=(this.state.sendsByReason[reason]??0)+1;
    if(["expectation_followup"].includes(reason))counters.expectation_driven++;
    if(["open_loop_callback","unfinished_thread"].includes(reason))counters.open_loop_driven++;
    if(["open_loop_callback","unfinished_thread","spontaneous_continuation","focus_callback","recent_event_followup"].includes(reason))counters.callback_driven++;
    if(["curiosity"].includes(reason))counters.curiosity_driven++;
    if(["concern"].includes(reason))counters.concern_driven++;
    if(["pure_social_contact","relationship_contact"].includes(reason))counters.pure_social++;
    if(["inactivity","inactivity_only"].includes(reason))counters.inactivity_only++;
    const body=String(text??"");
    if(/在干嘛|在吗|还在吗|吃了没|吃了吗|怎么还没|怎么没回|怎么不回|还没回来|还不回来|怎么这么久|这么久没|好久没|很久没|久没联系|没消息|没来找|多久没|是不是忘了|怎么不理|你不找我|好久不见|人呢|去哪了|消失了/u.test(body))counters.absence_framed++;
    if(/在干嘛|在吗|还在吗|怎么没回|怎么不回|怎么不理|人呢|去哪了|怎么还没|还不回来|回来了吗|回来了没|弄好了没/u.test(body))counters.forced_question++;
    if(/建议|应该|最好|可以试试|记得要|不妨先/.test(body))counters.advice_reflex++;
    if(["open_loop_callback","unfinished_thread","spontaneous_continuation","focus_callback"].includes(reason)&&!topicAppears(topic,body))counters.irrelevant_callback++;
    if(hash)this.state.recentSubjects.push({hash,reason,at:(at instanceof Date?at:new Date(at)).toISOString()});
    this.state.recentSubjects=this.state.recentSubjects.slice(-MAX_SUBJECTS);
    this.save();
    return {duplicate:false};
  }
  snapshot(){
    const {version,counters,sendsByReason,lastTickAt,lastDecision}=this.state;
    const inactivityOnlyRate=counters.proactive_sends?counters.inactivity_only/counters.proactive_sends:0;
    const absenceFramedRate=counters.proactive_sends?counters.absence_framed/counters.proactive_sends:0;
    return structuredClone({version,counters,rates:{inactivity_only:inactivityOnlyRate,absence_framed:absenceFramedRate},sendsByReason,lastTickAt,lastDecision});
  }
}

export const proactiveCognitionMetrics=new ProactiveCognitionMetrics();
