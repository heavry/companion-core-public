import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { publishEvent } from "./events-bus.js";
import { companionTime } from "./time-service.js";

// Companion Behavior State + Behavior Config。
// 与 Persona 严格分离：Persona 是人格（SQLite），这里是运行状态与行为配置（JSON）。

const STATE_PATH=config.companionStatePath;
const BEHAVIOR_PATH=config.companionBehaviorPath;

const DEFAULT_BEHAVIOR={
  proactiveLevel:"normal",            // low | normal | active
  proactiveMessagesEnabled:true,
  quietHours:{start:"23:00",end:"08:00"},
  weatherAwareness:true,
  followUpEnabled:true,
  proactiveImagesEnabled:true,
  dailyProactiveCap:3,
  dailyProactiveImageCap:1,
  weatherWatchdogEnabled:true,
  weatherWatchdogMinutes:45,
  weatherLocation:null                // {label,lat,lon} 由用户显式设置
};

function readJson(file,fallback){
  try{return JSON.parse(fs.readFileSync(file,"utf8"));}
  catch{try{fs.renameSync(file,`${file}.corrupt-${Date.now()}`);}catch{}return fallback;}
}
function writeJson(file,data){
  try{
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const tmp=`${file}.${process.pid}.tmp`;
    const fd=fs.openSync(tmp,"w");
    try{fs.writeFileSync(fd,JSON.stringify(data,null,1));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(tmp,file);
  }catch(e){console.error("[companion-state] persist failed:",e?.message??e);}
}

export function getBehavior(){
  const stored=readJson(BEHAVIOR_PATH,{});
  return {...DEFAULT_BEHAVIOR,...stored,quietHours:{...DEFAULT_BEHAVIOR.quietHours,...(stored.quietHours??{})}};
}

export function updateBehavior(patch){
  const merged={...getBehavior(),...(patch??{})};
  if(!["low","normal","active"].includes(merged.proactiveLevel))merged.proactiveLevel="normal";
  for(const k of ["proactiveMessagesEnabled","weatherAwareness","followUpEnabled","proactiveImagesEnabled"])merged[k]=Boolean(merged[k]);
  merged.dailyProactiveCap=Math.max(0,Math.min(20,Number(merged.dailyProactiveCap)||0));
  merged.dailyProactiveImageCap=Math.max(0,Math.min(10,Number(merged.dailyProactiveImageCap)||0));
  merged.weatherWatchdogEnabled=Boolean(merged.weatherWatchdogEnabled);
  merged.weatherWatchdogMinutes=Math.max(5,Math.min(720,Number(merged.weatherWatchdogMinutes)||45));
  if(merged.quietHours&&typeof merged.quietHours==="object"){
    merged.quietHours={start:String(merged.quietHours.start??"23:00").slice(0,5),end:String(merged.quietHours.end??"08:00").slice(0,5)};
  }
  if(merged.weatherLocation&&!Number.isFinite(merged.weatherLocation.lat))merged.weatherLocation=null;
  writeJson(BEHAVIOR_PATH,merged);
  return merged;
}

let state=null;
export function getState(){
  if(state)return state;
  const fallback={
    lastUserInteractionAt:null,
    lastProactiveAt:null,
    consecutiveUnansweredProactive:0,
    countedProactiveAttemptKeys:[],
    recentTopics:[],
    pendingFollowups:[],
    proactiveToday:{date:"",count:0},
    imagesToday:{date:"",count:0},
    consumedEventIds:[],
    lastWeatherWatchdogAt:null,
    inactivity:{lastCheck:null,recentAudits:[],simulatedLastUserInteractionAt:null,lastCognitionWakeKey:null}
  };
  const loaded=readJson(STATE_PATH,fallback);
  state={...fallback,...loaded,inactivity:{...fallback.inactivity,...(loaded?.inactivity??{})}};
  if(!Array.isArray(state.countedProactiveAttemptKeys))state.countedProactiveAttemptKeys=[];
  state.countedProactiveAttemptKeys=state.countedProactiveAttemptKeys.slice(-100);
  if(!Array.isArray(state.inactivity.recentAudits))state.inactivity.recentAudits=[];
  state.inactivity.recentAudits=state.inactivity.recentAudits.slice(-50);
  return state;
}
export function saveState(){writeJson(STATE_PATH,state);}

function asDate(value=new Date()){const date=value instanceof Date?value:new Date(value);if(Number.isNaN(date.getTime()))throw new Error("invalid companion state time");return date;}
function today(at=new Date()){return companionTime.localDate(asDate(at));}
function rollDaily(entry,at=new Date()){
  const date=today(at);
  if(entry.date!==date){entry.date=date;entry.count=0;}
  return entry;
}

export function touchUserInteraction(at=new Date().toISOString()){
  const s=getState();
  s.lastUserInteractionAt=asDate(at).toISOString();
  s.consecutiveUnansweredProactive=0;
  // A real reply ends any candidate-only clock simulation immediately.
  if(s.inactivity?.simulatedLastUserInteractionAt)s.inactivity.simulatedLastUserInteractionAt=null;
  saveState();
}

/** 开发/candidate 时间模拟：返回用于 eligibility 的权威 lastUserInteractionAt。 */
export function effectiveLastUserInteractionAt(state=getState()){
  const simulated=state?.inactivity?.simulatedLastUserInteractionAt;
  if(config.inactivityDevOverrideEnabled&&simulated){
    const parsed=Date.parse(simulated);
    if(Number.isFinite(parsed))return new Date(parsed).toISOString();
  }
  return state?.lastUserInteractionAt??null;
}

/** 仅 development/candidate：设置/清除 inactivity 时间模拟。production 始终不可用。 */
export function setInactivitySimulation({hoursAgo=null,lastUserInteractionAt=null,clear=false}={}){
  if(!config.inactivityDevOverrideEnabled){
    throw Object.assign(new Error("inactivity time simulation is disabled"),{statusCode:403});
  }
  const s=getState();
  if(!s.inactivity||typeof s.inactivity!=="object")s.inactivity={lastCheck:null,recentAudits:[],simulatedLastUserInteractionAt:null};
  if(clear||hoursAgo===null&&lastUserInteractionAt===null){
    s.inactivity.simulatedLastUserInteractionAt=null;
    saveState();
    return {enabled:true,simulatedLastUserInteractionAt:null,cleared:true};
  }
  let iso;
  if(lastUserInteractionAt!==null&&lastUserInteractionAt!==undefined){
    iso=asDate(lastUserInteractionAt).toISOString();
  }else{
    const hours=Math.max(0,Math.min(24*365,Number(hoursAgo)));
    if(!Number.isFinite(hours))throw Object.assign(new Error("hoursAgo must be a finite number"),{statusCode:400});
    iso=new Date(Date.now()-hours*3600_000).toISOString();
  }
  s.inactivity.simulatedLastUserInteractionAt=iso;
  saveState();
  return {enabled:true,simulatedLastUserInteractionAt:iso,cleared:false,effectiveLastUserInteractionAt:iso};
}

/** Reconcile durable behavior state with the authoritative SQLite user timestamp. */
export function reconcileUserInteraction(at){
  if(config.inactivityDevOverrideEnabled&&getState().inactivity?.simulatedLastUserInteractionAt)return false;
  const incoming=Date.parse(at??""),current=Date.parse(getState().lastUserInteractionAt??"");
  if(!Number.isFinite(incoming)||(Number.isFinite(current)&&incoming<=current))return false;
  touchUserInteraction(new Date(incoming).toISOString());return true;
}

export function noteProactiveSent(kind="message",{at=new Date(),attemptKey=null}={}){
  const s=getState();
  const key=String(attemptKey??"").slice(0,120);
  if(key&&s.countedProactiveAttemptKeys.includes(key))return false;
  const date=at instanceof Date?at:new Date(at),iso=date.toISOString();
  s.lastProactiveAt=iso;
  s.proactiveCountToday=undefined;
  s.consecutiveUnansweredProactive=(s.consecutiveUnansweredProactive??0)+1;
  if(key)s.countedProactiveAttemptKeys=[...s.countedProactiveAttemptKeys,key].slice(-100);
  if(kind==="message"){rollDaily(s.proactiveToday,date);s.proactiveToday.count++;}
  if(kind==="image"){rollDaily(s.imagesToday,date);s.imagesToday.count++;}
  saveState();
  return true;
}

export function noteInactivityCheck(input={}){
  const s=getState(),at=asDate(input.checkedAt??new Date()).toISOString();
  s.inactivity.lastCheck={
    checkedAt:at,triggerReason:String(input.triggerReason??input.reason??"unknown").slice(0,120),
    inactivityMs:Number.isFinite(Number(input.inactivityMs))?Math.max(0,Math.round(Number(input.inactivityMs))):null,
    inactivityHours:Number.isFinite(Number(input.inactivityHours))?Number(Number(input.inactivityHours).toFixed(3)):null,
    eligible:Boolean(input.eligible),band:input.band??null,
    probability:Number.isFinite(Number(input.probability))?Number(input.probability):0,
    roll:Number.isFinite(Number(input.roll))?Number(input.roll):null,
    opportunityKey:input.opportunityKey??null,attemptKey:input.attemptKey??null,
    cooldownUntil:input.cooldownUntil??null,reasons:Array.isArray(input.reasons)?input.reasons.slice(0,8).map(x=>String(x).slice(0,80)):[]
  };
  saveState();return structuredClone(s.inactivity.lastCheck);
}

export function markCognitionWakeHandled(opportunityKey){
  const key=String(opportunityKey??"").slice(0,160);
  if(!key)return false;
  const s=getState();
  s.inactivity.lastCognitionWakeKey=key;
  saveState();
  return true;
}

export function beginProactiveAttempt(input={}){
  const s=getState(),key=String(input.attemptKey??"").slice(0,120);
  if(!key)throw new Error("proactive attempt key required");
  const existing=s.inactivity.recentAudits.find(item=>item.attemptKey===key);
  if(existing)return {started:false,audit:structuredClone(existing)};
  const audit={
    attemptKey:key,startedAt:asDate(input.startedAt??new Date()).toISOString(),finishedAt:null,status:"generating",
    triggerReason:String(input.triggerReason??"unknown").slice(0,120),
    inactivityMs:Number.isFinite(Number(input.inactivityMs))?Math.max(0,Math.round(Number(input.inactivityMs))):null,
    inactivityHours:Number.isFinite(Number(input.inactivityHours))?Number(Number(input.inactivityHours).toFixed(3)):null,
    band:input.band??null,probability:Number.isFinite(Number(input.probability))?Number(input.probability):0,
    roll:Number.isFinite(Number(input.roll))?Number(input.roll):null,generated:false,delivered:false,
    messageId:null,sessionId:null,cooldownUntil:input.cooldownUntil??null,resultReason:null,error:null
  };
  s.inactivity.recentAudits.push(audit);s.inactivity.recentAudits=s.inactivity.recentAudits.slice(-50);saveState();
  publishEvent("proactive.attempt.started",{attemptKey:key,triggerReason:audit.triggerReason,inactivityHours:audit.inactivityHours,band:audit.band});
  return {started:true,audit:structuredClone(audit)};
}

export function finishProactiveAttempt(attemptKey,patch={}){
  const s=getState(),audit=s.inactivity.recentAudits.find(item=>item.attemptKey===attemptKey);
  if(!audit)return null;
  const wasDelivered=Boolean(audit.delivered),finishedAt=asDate(patch.finishedAt??new Date()),delivered=Boolean(patch.delivered);
  Object.assign(audit,{
    finishedAt:finishedAt.toISOString(),status:delivered?"delivered":String(patch.status??"not_delivered").slice(0,40),
    generated:Boolean(patch.generated),delivered,messageId:patch.messageId??null,sessionId:patch.sessionId??null,
    cooldownUntil:patch.cooldownUntil??audit.cooldownUntil??null,resultReason:patch.resultReason?String(patch.resultReason).slice(0,120):null,
    error:patch.error?String(patch.error).slice(0,160):null
  });
  if(delivered&&!wasDelivered){
    if(!s.countedProactiveAttemptKeys.includes(attemptKey)){
      s.lastProactiveAt=finishedAt.toISOString();s.consecutiveUnansweredProactive=(s.consecutiveUnansweredProactive??0)+1;
      s.countedProactiveAttemptKeys=[...s.countedProactiveAttemptKeys,attemptKey].slice(-100);
      rollDaily(s.proactiveToday,finishedAt);s.proactiveToday.count++;
    }
  }
  saveState();publishEvent("proactive.attempt.finished",{attemptKey:audit.attemptKey,triggerReason:audit.triggerReason,inactivityHours:audit.inactivityHours,generated:audit.generated,delivered:audit.delivered,messageId:audit.messageId,cooldownUntil:audit.cooldownUntil,resultReason:audit.resultReason});
  return structuredClone(audit);
}

export function recentInactivityAudits(limit=20){return structuredClone(getState().inactivity.recentAudits.slice(-Math.max(1,Math.min(50,Number(limit)||20))));}

export function proactiveCountsToday(at=new Date()){
  const s=getState();
  return {messages:rollDaily(s.proactiveToday,at).count,images:rollDaily(s.imagesToday,at).count};
}

export function addPendingFollowup({topic,earliestAt,expiresAt,sourceSessionId}){
  const s=getState();
  const normalized=String(topic??"").trim().slice(0,200);
  if(!normalized)return null;
  if(s.pendingFollowups.some(f=>f.topic===normalized&&f.status==="pending"))return null;
  const followup={id:`fu_${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`,topic:normalized,status:"pending",sourceSessionId,createdAt:new Date().toISOString(),earliestAt,expiresAt};
  s.pendingFollowups.push(followup);
  // 保守上限：最多保留 20 条 pending
  while(s.pendingFollowups.filter(x=>x.status==="pending").length>20)s.pendingFollowups.shift();
  saveState();
  return followup;
}

/** 到期未处理的 follow-up 标记 expired，避免数天后突然追问旧事 */
export function expirePendingFollowups(now=Date.now()){
  const s=getState();
  let changed=false;
  for(const f of s.pendingFollowups){
    if(f.status!=="pending")continue;
    const exp=Date.parse(f.expiresAt);
    if(Number.isFinite(exp)&&now>exp){f.status="expired";f.resolvedAt=new Date().toISOString();changed=true;}
  }
  if(changed)saveState();
  return changed;
}

export function duePendingFollowups(now=Date.now()){
  const s=getState();
  return s.pendingFollowups.filter(f=>{
    if(f.status!=="pending")return false;
    const early=Date.parse(f.earliestAt),exp=Date.parse(f.expiresAt);
    return Number.isFinite(early)&&early<=now&&(!Number.isFinite(exp)||now<=exp);
  });
}
export function completeFollowup(id,status="done"){
  const s=getState();
  const f=s.pendingFollowups.find(x=>x.id===id);
  if(f){f.status=status;f.resolvedAt=new Date().toISOString();saveState();}
  return f??null;
}
export function pushRecentTopic(topic){
  const s=getState();
  s.recentTopics=[topic,...(s.recentTopics??[])].filter((x,i,arr)=>arr.indexOf(x)===i).slice(0,10);
  saveState();
}
export function markEventsConsumed(ids){
  const s=getState();
  s.consumedEventIds=[...new Set([...(s.consumedEventIds??[]),...ids])].slice(-200);
  saveState();
}
export function inQuietHours(d=new Date(),behavior=getBehavior()){
  const {start,end}=behavior.quietHours;
  const toMin=t=>{const [h,m]=String(t).split(":").map(Number);return (h||0)*60+(m||0);};
  const parts=companionTime.parts(d),cur=parts.hour*60+parts.minute,s=toMin(start),e=toMin(end);
  return s<=e?(cur>=s&&cur<e):(cur>=s||cur<e);
}

/** Proactive 决策所需的本地规则评估（绝不在此调用 LLM）。
 * Cooldown 是语义 gate，不是「今天主动过一次就锁到明天」的全局锁：
 * - unanswered_proactive：用户没回上一条主动 → 更克制
 * - after_conversation：用户已回复并聊起来 → 上一次主动不再锁死全天
 * - high_value_reason：新 pending / 等用户结果的 open loop 可更早重获资格
 */
export function evaluateProactiveGate({kind="message",candidateKind="",at=new Date(),candidate=null,highValueReason=false}={}){
  const behavior=getBehavior();
  const s=getState();
  const date=asDate(at),now=date.getTime();
  const reasons=[];
  const enabled=kind==="image"?behavior.proactiveImagesEnabled:behavior.proactiveMessagesEnabled;
  if(!enabled)reasons.push("disabled");
  if(inQuietHours(date,behavior))reasons.push("quiet_hours");
  if((s.consecutiveUnansweredProactive??0)>=3)reasons.push("no_reply_limit");
  const counts=proactiveCountsToday(date);
  if(kind==="message"&&counts.messages>=behavior.dailyProactiveCap)reasons.push("daily_cap");
  if(kind==="image"&&counts.images>=behavior.dailyProactiveImageCap)reasons.push("daily_image_cap");

  const lastProactiveMs=s.lastProactiveAt?Date.parse(s.lastProactiveAt):0;
  const lastUserMs=Date.parse(effectiveLastUserInteractionAt(s)??s.lastUserInteractionAt??"");
  const proactiveAnswered=Number.isFinite(lastUserMs)&&Number.isFinite(lastProactiveMs)&&lastUserMs>lastProactiveMs;
  const unanswered=(s.consecutiveUnansweredProactive??0)>0&&!proactiveAnswered;
  const followupKind=String(candidate?.followup_kind??candidate?.followupKind??"").trim();
  const nextActor=String(candidate?.next_expected_actor??candidate?.nextExpectedActor??"").trim();
  const softShared=followupKind==="shared_topic"||nextActor==="shared";

  let levelCooldownMs;
  if(highValueReason){
    // 新高价值理由可以比普通 rhythm 更早，但仍尊重 suppression / no_reply_limit
    levelCooldownMs=candidateKind==="inactivity"?2*3600_000:45*60_000;
  }else if(unanswered&&candidateKind!=="inactivity"&&!softShared){
    // 用户未回上一条主动：没有新高价值理由时，普通 presence/followup 保持克制
    levelCooldownMs=8*3600_000;
  }else if(unanswered&&candidateKind!=="inactivity"&&softShared){
    // 未回复时 shared topic 更不该像任务机器人反复提起
    levelCooldownMs=12*3600_000;
  }else if(candidateKind==="inactivity"){
    // 未回复：保持长冷却（克制）；已正常聊天：不锁 18h 到第二天
    levelCooldownMs=proactiveAnswered
      ? ({low:8*3600_000,normal:6*3600_000,active:4*3600_000}[behavior.proactiveLevel]??6*3600_000)
      : ({low:24*3600_000,normal:18*3600_000,active:12*3600_000}[behavior.proactiveLevel]??18*3600_000);
  }else if(softShared){
    levelCooldownMs=proactiveAnswered?90*60_000:4*3600_000;
  }else{
    // presence / followup 等：聊天后回到普通 rhythm，而不是全天 quota
    levelCooldownMs=proactiveAnswered
      ? ({low:3*3600_000,normal:90*60_000,active:45*60_000}[behavior.proactiveLevel]??90*60_000)
      : ({low:8*3600_000,normal:4*3600_000,active:90*60_000}[behavior.proactiveLevel]??4*3600_000);
  }
  if(unanswered&&!highValueReason){
    // 用户没回：没有新理由时继续 WAIT 很合理
    const unansweredFloor=candidateKind==="inactivity"?12*3600_000:(softShared?12*3600_000:8*3600_000);
    levelCooldownMs=Math.max(levelCooldownMs,unansweredFloor);
  }
  // A third unanswered contact remains possible, but only after real space.
  // This is a frequency guard, not an emotion or message-content rule.
  if(unanswered){
    const unansweredFloor=(s.consecutiveUnansweredProactive??0)>=2?18*3600_000:12*3600_000;
    levelCooldownMs=Math.max(levelCooldownMs,unansweredFloor);
  }
  const imageCooldownMs=4*3600_000;
  const last=lastProactiveMs;
  const cooldown=kind==="image"?Math.max(imageCooldownMs,unanswered?levelCooldownMs:0):levelCooldownMs;
  if(last&&now-last<cooldown)reasons.push("cooldown");
  const latest=s.inactivity.recentAudits.at(-1),attemptCooldown=Date.parse(latest?.cooldownUntil??"");
  if(candidateKind==="inactivity"&&Number.isFinite(attemptCooldown)&&now<attemptCooldown&&!latest?.delivered)reasons.push("attempt_cooldown");
  return {
    allowed:reasons.length===0,reasons,behavior,counts,cooldownMs:cooldown,
    cooldownUntil:last?new Date(last+cooldown).toISOString():null,
    proactiveAnswered,unansweredProactive:unanswered,highValueReason:Boolean(highValueReason)
  };
}

export function companionStateSummary(){
  const s=getState(),b=getBehavior();
  return {
    lastUserInteractionAt:s.lastUserInteractionAt,lastProactiveAt:s.lastProactiveAt,
    consecutiveUnansweredProactive:s.consecutiveUnansweredProactive??0,
    unanswered_proactive_streak:s.consecutiveUnansweredProactive??0,
    recentTopics:(s.recentTopics??[]).slice(0,5),
    pendingFollowups:s.pendingFollowups.filter(f=>f.status==="pending").length,
    proactiveToday:proactiveCountsToday(),
    quietHours:b.quietHours,proactiveLevel:b.proactiveLevel,
    effectiveLastUserInteractionAt:effectiveLastUserInteractionAt(s),
    inactivityDevOverrideEnabled:Boolean(config.inactivityDevOverrideEnabled),
    inactivity:{lastCheck:s.inactivity.lastCheck,recentAudits:s.inactivity.recentAudits.slice(-20),simulatedLastUserInteractionAt:s.inactivity.simulatedLastUserInteractionAt??null}
  };
}
