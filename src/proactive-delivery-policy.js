import { inQuietHours,getBehavior } from "./companion-state.js";

export const ATTENTION_TYPES=Object.freeze([
  "reminder_due","agent_completed","agent_failed","approval_needed",
  "service_down","service_recovered","plan_due","external_update","self_maintenance"
]);

const CRITICAL=new Set(["approval_needed","service_down","self_maintenance","agent_failed"]);
const ORDINARY=new Set(["reminder_due","agent_completed","plan_due","external_update","service_recovered"]);

export function attentionDedupeKey({source="",type="",resource="",fingerprint=""}={}){
  return [source,type,resource,fingerprint].map(value=>String(value??"").slice(0,120)).join("|");
}

export function notificationCopy(candidate={},preview="summary"){
  const type=String(candidate.type??"");
  if(preview==="private")return {title:"林小糖",body:"有一条新消息。"};
  const title=String(candidate.title??"林小糖").slice(0,60);
  if(preview==="summary")return {title,body:String(candidate.summary??"有一条需要你关注的事。").slice(0,80)};
  return {title,body:String(candidate.body??candidate.summary??"").slice(0,180)};
}

export function evaluateDelivery(candidate={},context={}){
  const type=String(candidate.type??"");
  const reasons=[];
  if(!ATTENTION_TYPES.includes(type))reasons.push("unknown_type");
  const behavior=context.behavior??getBehavior();
  const settings=context.settings??{};
  if(settings.proactiveEnabled===false&&ORDINARY.has(type))reasons.push("proactive_disabled");
  const quiet=context.quietHours===undefined?inQuietHours(context.now??new Date(),behavior):Boolean(context.quietHours);
  if(quiet&&!CRITICAL.has(type))reasons.push("quiet_hours");
  const key=attentionDedupeKey(candidate);
  const history=Array.isArray(context.history)?context.history:[];
  const existing=history.find(item=>item.dedupe_key===key&&item.status!=="dismissed");
  if(existing&&!(candidate.state==="recovered"&&existing.state==="down"))reasons.push("duplicate");
  const windowMs=Number(context.rateWindowMs??30*60*1000);
  const now=context.now?new Date(context.now).getTime():Date.now();
  const recent=history.filter(item=>item.delivered_at&&now-Date.parse(item.delivered_at)<windowMs&&ORDINARY.has(item.type));
  const rateLimit=Number(context.rateLimit??2);
  if(ORDINARY.has(type)&&recent.length>=rateLimit)reasons.push("rate_limit");
  const action=reasons.length?"suppress":"deliver";
  const voice=action==="deliver"&&settings.proactiveVoiceEnabled===true&&!quiet;
  return {action,reasons,dedupe_key:key,voice:Boolean(voice),critical:CRITICAL.has(type)};
}

export function healthTransition(previous,next){
  if(previous==="healthy"&&next==="down")return {notify:true,type:"service_down",state:"down"};
  if(previous==="down"&&next==="down")return {notify:false,type:"service_down",state:"down"};
  if(previous==="down"&&next==="healthy")return {notify:true,type:"service_recovered",state:"recovered"};
  return {notify:false,type:null,state:next};
}
