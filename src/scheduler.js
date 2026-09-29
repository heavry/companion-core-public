import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getOrCreateSession,insertEvent,insertMessage } from "./db.js";
import { publishEvent } from "./events-bus.js";
import { uuid } from "./utils.js";
import { attentionStore } from "./attention-store.js";
import { COMPANION_TIME_ZONE,CompanionTimeService } from "./time-service.js";

const EXECUTION_STATES=new Set(["running","queued","dispatched","completed","failed","skipped","interrupted"]);
const cache=new Map();

function formatter(timeZone){
  if(!cache.has(timeZone))cache.set(timeZone,new Intl.DateTimeFormat("en-US",{timeZone,year:"numeric",month:"numeric",day:"numeric",hour:"numeric",minute:"numeric",hourCycle:"h23",weekday:"short"}));
  return cache.get(timeZone);
}
function validTimeZone(value){try{formatter(value).format(new Date());return true;}catch{return false;}}
function zonedParts(date,timeZone){
  const values=Object.fromEntries(formatter(timeZone).formatToParts(date).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return {minute:Number(values.minute),hour:Number(values.hour),day:Number(values.day),month:Number(values.month),weekday:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(values.weekday)};
}
function parseField(raw,min,max,{weekday=false}={}){
  const values=new Set();
  for(const part of String(raw).split(",")){
    const [base,stepRaw]=part.split("/"),step=stepRaw===undefined?1:Number(stepRaw);
    if(!Number.isInteger(step)||step<1)throw new Error("invalid cron step");
    let start,end;
    if(base==="*"){start=min;end=max;}
    else if(base.includes("-")){[start,end]=base.split("-").map(Number);}
    else {start=Number(base);end=start;}
    if(weekday&&base!=="*"&&start===7)start=0;if(weekday&&base!=="*"&&end===7)end=0;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<min||start>max||end<min||end>max||end<start)throw new Error("invalid cron field");
    for(let value=start;value<=end;value+=step)values.add(value);
  }
  return values;
}
export function parseCron(expression){
  const fields=String(expression??"").trim().split(/\s+/);if(fields.length!==5)throw new Error("cron requires five fields");
  return {minutes:parseField(fields[0],0,59),hours:parseField(fields[1],0,23),days:parseField(fields[2],1,31),months:parseField(fields[3],1,12),weekdays:parseField(fields[4],0,7,{weekday:true}),dayWildcard:fields[2]==="*",weekdayWildcard:fields[4]==="*"};
}
function cronMatches(parsed,parts){
  const dayMatch=parsed.days.has(parts.day),weekdayMatch=parsed.weekdays.has(parts.weekday);
  const calendarMatch=parsed.dayWildcard?weekdayMatch:parsed.weekdayWildcard?dayMatch:(dayMatch||weekdayMatch);
  return parsed.minutes.has(parts.minute)&&parsed.hours.has(parts.hour)&&parsed.months.has(parts.month)&&calendarMatch;
}
export function nextCronAfter(expression,after,timeZone=COMPANION_TIME_ZONE){
  if(!validTimeZone(timeZone))throw new Error("invalid IANA time zone");
  const parsed=parseCron(expression),start=new Date(after);if(Number.isNaN(start.getTime()))throw new Error("invalid cron cursor");
  let cursor=new Date(Math.floor(start.getTime()/60000)*60000+60000);
  for(let i=0;i<535680;i++,cursor=new Date(cursor.getTime()+60000))if(cronMatches(parsed,zonedParts(cursor,timeZone)))return cursor.toISOString();
  throw new Error("cron has no occurrence within 372 days");
}

function atomicWrite(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.${uuid()}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}
}
function safeText(value,max){const text=String(value??"").trim();if(!text||text.length>max)throw new Error(`text must be 1-${max} characters`);return text;}
function normalizeSchedule(raw,now){
  const type=raw?.type,timeZone=String(raw?.timeZone??COMPANION_TIME_ZONE);if(!validTimeZone(timeZone))throw new Error("invalid IANA time zone");
  if(type==="once"){
    const text=String(raw.at??"").trim(),hasOffset=/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text),date=hasOffset?new Date(text):new CompanionTimeService({timeZone}).parseLocalDateTime(text);if(Number.isNaN(date.getTime()))throw new Error("valid once.at required");
    return {type,at:date.toISOString(),timeZone};
  }
  if(type==="cron"){
    const expression=String(raw.expression??"").trim();parseCron(expression);nextCronAfter(expression,now,timeZone);
    return {type,expression,timeZone};
  }
  throw new Error("schedule.type must be once or cron");
}
function normalizeTarget(raw){
  if(raw?.type==="conversation")return {type:"conversation",content:safeText(raw.content,4000)};
  if(raw?.type==="internal"&&raw?.operation==="record_event")return {type:"internal",operation:"record_event",content:safeText(raw.content,4000),importance:Math.max(0,Math.min(1,Number(raw.importance??0.6)))};
  throw new Error("target must be conversation or supported internal operation");
}
function publicPlan(plan){return structuredClone(plan);}

export class SchedulerStore{
  constructor({file=config.schedulerStatePath,now=()=>new Date(),executor=null,tickMs=config.schedulerTickMs}={}){
    this.file=file;this.now=now;this.executor=executor??(plan=>this.executeBuiltIn(plan));this.tickMs=tickMs;this.running=new Set();this.timer=null;this.ticking=false;
    this.state={version:1,plans:[],executions:[]};this.load();this.recoverInterrupted();
  }
  load(){
    if(!fs.existsSync(this.file))return;
    const value=JSON.parse(fs.readFileSync(this.file,"utf8"));
    if(value?.version!==1||!Array.isArray(value.plans)||!Array.isArray(value.executions))throw new Error("invalid scheduler state");
    this.state=value;
  }
  save(){this.state.executions=this.state.executions.slice(-2000);atomicWrite(this.file,this.state);}
  recoverInterrupted(){
    let changed=false,t=this.now().toISOString();
    for(const execution of this.state.executions){
      if(["queued","running","dispatched"].includes(execution.status)){
        execution.status="interrupted";execution.finishedAt=t;execution.transitions.push({status:"interrupted",at:t});changed=true;
      }
    }
    for(const plan of this.state.plans){
      if(!plan.schedule.timeZone){plan.schedule.timeZone=COMPANION_TIME_ZONE;changed=true;}
      if(!plan.enabled)continue;
      if(plan.schedule.type==="cron"&&!plan.nextRunAt){plan.nextRunAt=nextCronAfter(plan.schedule.expression,this.now(),plan.schedule.timeZone);changed=true;}
    }
    if(changed)this.save();
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>this.tick().catch(()=>{}),this.tickMs);this.timer.unref?.();this.tick().catch(()=>{});}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  snapshot(){return {generatedAt:this.now().toISOString(),plans:this.state.plans.map(publicPlan).sort((a,b)=>(a.nextRunAt??"9999").localeCompare(b.nextRunAt??"9999")),history:structuredClone([...this.state.executions].reverse())};}
  create(input){
    const t=this.now(),schedule=normalizeSchedule(input?.schedule,t),target=normalizeTarget(input?.target),enabled=input?.enabled!==false;
    if(enabled&&schedule.type==="once"&&new Date(schedule.at)<=t)throw new Error("enabled once schedule must be in the future");
    const plan={id:uuid(),title:safeText(input?.title,160),schedule,target,enabled,nextRunAt:enabled?(schedule.type==="once"?schedule.at:nextCronAfter(schedule.expression,t,schedule.timeZone)):null,lastRunAt:null,createdAt:t.toISOString(),updatedAt:t.toISOString()};
    this.state.plans.push(plan);this.save();return publicPlan(plan);
  }
  update(id,input){
    const plan=this.state.plans.find(x=>x.id===id);if(!plan)return null;const t=this.now(),next=structuredClone(plan);
    if(input.title!==undefined)next.title=safeText(input.title,160);
    if(input.schedule!==undefined)next.schedule=normalizeSchedule(input.schedule,t);
    if(input.target!==undefined)next.target=normalizeTarget(input.target);
    if(input.enabled!==undefined)next.enabled=Boolean(input.enabled);
    if(next.enabled&&next.schedule.type==="once"&&new Date(next.schedule.at)<=t)throw new Error("enabled once schedule must be in the future");
    next.nextRunAt=next.enabled?(next.schedule.type==="once"?next.schedule.at:nextCronAfter(next.schedule.expression,t,next.schedule.timeZone)):null;
    next.updatedAt=t.toISOString();Object.assign(plan,next);this.save();return publicPlan(plan);
  }
  delete(id){const index=this.state.plans.findIndex(x=>x.id===id);if(index<0)return false;if(this.running.has(id))throw new Error("cannot delete a running plan");this.state.plans.splice(index,1);this.save();return true;}
  transition(execution,status,error=null){
    if(!EXECUTION_STATES.has(status))throw new Error("invalid execution state");const at=this.now().toISOString();execution.status=status;execution.transitions.push({status,at});
    if(status==="running")execution.startedAt=at;if(["completed","failed","skipped","interrupted"].includes(status))execution.finishedAt=at;if(error)execution.error=String(error).slice(0,500);this.save();
  }
  async tick(){
    if(this.ticking)return;this.ticking=true;
    try{
      const now=this.now(),due=this.state.plans.filter(x=>x.enabled&&x.nextRunAt&&new Date(x.nextRunAt)<=now).sort((a,b)=>a.nextRunAt.localeCompare(b.nextRunAt));
      for(const plan of due){
        const scheduledFor=plan.nextRunAt;
        if(this.running.has(plan.id)){
          const execution={id:uuid(),planId:plan.id,planTitle:plan.title,scheduledFor,status:"skipped",createdAt:now.toISOString(),finishedAt:now.toISOString(),transitions:[{status:"skipped",at:now.toISOString()}],error:"previous execution still running"};
          this.state.executions.push(execution);plan.nextRunAt=plan.schedule.type==="cron"?nextCronAfter(plan.schedule.expression,now,plan.schedule.timeZone):null;this.save();continue;
        }
        if(plan.schedule.type==="once"){plan.enabled=false;plan.nextRunAt=null;}else plan.nextRunAt=nextCronAfter(plan.schedule.expression,now,plan.schedule.timeZone);
        plan.lastRunAt=now.toISOString();plan.updatedAt=now.toISOString();
        const execution={id:uuid(),planId:plan.id,planTitle:plan.title,scheduledFor,status:"queued",createdAt:now.toISOString(),startedAt:null,finishedAt:null,error:null,transitions:[{status:"queued",at:now.toISOString()}]};
        this.state.executions.push(execution);this.save();this.running.add(plan.id);
        try{this.transition(execution,"running");const result=await this.executor(publicPlan(plan),execution);if(result?.dispatched)this.transition(execution,"dispatched");this.transition(execution,"completed");}
        catch(error){this.transition(execution,"failed",error?.message??error);}
        finally{this.running.delete(plan.id);}
      }
    }finally{this.ticking=false;}
  }
  async executeBuiltIn(plan){
    if(plan.target.type==="conversation"){
      const session=getOrCreateSession(config.defaultPersonaId,"scheduler","scheduler:default");
      const messageId=insertMessage(session.id,"scheduler",{role:"assistant",content:plan.target.content});
      insertEvent({personaId:config.defaultPersonaId,sessionId:session.id,source:"scheduler",content:plan.target.content,importance:0.7});
      publishEvent("proactive.created",{preview:plan.target.content.slice(0,300),source:"scheduler",scheduled:true,planId:plan.id,messageId},{sessionId:session.id});
      const recorded=attentionStore.record({type:"reminder_due",source:"scheduler",resource:plan.id,fingerprint:plan.id,title:plan.title,summary:plan.target.content.slice(0,180),destination:"plans",conversation_id:session.id,state:"due"});
      if(recorded.delivered)publishEvent("attention.created",{id:recorded.item.id,type:"reminder_due",title:recorded.item.title},{sessionId:session.id});
      return {dispatched:true,sessionId:session.id,messageId};
    }
    if(plan.target.type==="internal"&&plan.target.operation==="record_event"){
      insertEvent({personaId:config.defaultPersonaId,source:"scheduler",content:plan.target.content,importance:plan.target.importance});
      publishEvent("scheduler.internal.completed",{planId:plan.id,operation:plan.target.operation});return {dispatched:true};
    }
    throw new Error("unsupported scheduler target");
  }
}

export const scheduler=new SchedulerStore();
