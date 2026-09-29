import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { companionTime } from "./time-service.js";
import { uuid } from "./utils.js";

function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.${uuid()}.tmp`;fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);try{fs.chmodSync(file,0o600);}catch{}}
function addMilliseconds(value,milliseconds){return new Date(new Date(value).getTime()+milliseconds).toISOString();}
function markerHour(hour,marker,currentHour){
  let result=Number(hour);const text=String(marker??"");
  if(/下午|晚上|今晚|傍晚/.test(text)&&result<12)result+=12;
  if(/中午/.test(text)&&result<11)result+=12;
  if(!text&&result<12){const later=result+12;if(Math.abs(later-currentHour)<Math.abs(result-currentHour))result=later;}
  return result;
}
function localDateParts(time,value){const parts=time.parts(value);return {year:parts.year,month:parts.month,day:parts.day};}
function localInstant(time,at,hour,minute=0,{notBefore=null}={}){
  const base=localDateParts(time,at);let date=time.fromLocalParts({...base,hour,minute});
  if(notBefore&&date<=notBefore){const wall=new Date(Date.UTC(base.year,base.month-1,base.day+1));date=time.fromLocalParts({year:wall.getUTCFullYear(),month:wall.getUTCMonth()+1,day:wall.getUTCDate(),hour,minute});}
  return date;
}
function activityRecord({at,sourceMessageId,status="in_progress",startAt=null,endAt=null,plannedUntil=null,expiresAt=null}){
  return {type:"temporary_activity",activity:"study",source:"explicit_user",evidence:"explicit_user_statement",statedAt:at.toISOString(),startAt,endAt,plannedUntil,status,confidence:0.98,sourceMessageId:Number(sourceMessageId),expiresAt:expiresAt??addMilliseconds(at,12*60*60*1000)};
}

export class TemporalContextStore{
  constructor({file=config.temporalContextPath,timeService=companionTime}={}){this.file=file;this.time=timeService;this.state={version:1,sessions:{}};this.load();}
  load(){try{const value=JSON.parse(fs.readFileSync(this.file,"utf8"));if(value?.version===1&&value.sessions&&typeof value.sessions==="object")this.state=value;}catch{}}
  save(){atomic(this.file,this.state);}
  current(sessionId,at=this.time.now()){
    const activity=this.state.sessions[sessionId]?.activity??null;if(!activity)return null;
    if(activity.status!=="completed_if_explicitly_confirmed"&&activity.status!=="expired"&&Date.parse(activity.expiresAt)<=at.getTime()){
      activity.status="expired";activity.updatedAt=at.toISOString();this.save();
    }
    return structuredClone(activity);
  }
  observe({sessionId,text,sourceMessageId,at=this.time.now()}){
    const value=String(text??"").trim();if(!value||!sourceMessageId)return this.current(sessionId,at);
    const existing=this.state.sessions[sessionId]?.activity??null;
    if(existing&&/(不学了|不学习了|学习取消|取消学习|提前结束(?:学习)?)/.test(value)){
      existing.status="unknown";existing.cancelledAt=at.toISOString();existing.cancellationSourceMessageId=Number(sourceMessageId);existing.updatedAt=at.toISOString();existing.expiresAt=addMilliseconds(at,6*60*60*1000);this.save();return structuredClone(existing);
    }
    if(existing&&/(学完了|学习结束了|完成学习了?)/.test(value)){
      existing.status="completed_if_explicitly_confirmed";existing.confirmedAt=at.toISOString();existing.confirmationSourceMessageId=Number(sourceMessageId);existing.updatedAt=at.toISOString();existing.expiresAt=addMilliseconds(at,24*60*60*1000);this.save();return structuredClone(existing);
    }
    if(existing&&/(我?回来(?:啦|了)?)/.test(value)){
      existing.status="unknown";existing.returnedAt=at.toISOString();existing.returnSourceMessageId=Number(sourceMessageId);existing.updatedAt=at.toISOString();existing.expiresAt=addMilliseconds(at,6*60*60*1000);this.save();return structuredClone(existing);
    }
    const parts=this.time.parts(at);
    const interval=value.match(/(?:从\s*)?(上午|早上|中午|下午|晚上|今晚|傍晚)?\s*(\d{1,2})(?:\s*[点时:：]\s*(\d{1,2})?\s*分?)?\s*(?:开始)?\s*(?:学习|学)[^。！？\n]{0,12}?到\s*(上午|早上|中午|下午|晚上|今晚|傍晚)?\s*(\d{1,2})(?:\s*[点时:：]\s*(\d{1,2})?\s*分?)?/);
    let activity=null;
    if(interval){
      const startHour=markerHour(interval[2],interval[1],parts.hour),start=localInstant(this.time,at,startHour,Number(interval[3]??0));
      let endHour=markerHour(interval[5],interval[4]??interval[1],startHour),end=localInstant(this.time,at,endHour,Number(interval[6]??0),{notBefore:start});
      activity=activityRecord({at,sourceMessageId,status:at>=start&&at<end?"in_progress":"planned",startAt:start.toISOString(),endAt:end.toISOString(),plannedUntil:end.toISOString(),expiresAt:addMilliseconds(end,6*60*60*1000)});
    }else{
      const until=value.match(/(?:学习|学)\s*到\s*(上午|早上|中午|下午|晚上|今晚|傍晚)?\s*(\d{1,2})(?:\s*[点时:：]\s*(\d{1,2})?\s*分?)?/);
      if(until){const hour=markerHour(until[2],until[1],parts.hour),planned=localInstant(this.time,at,hour,Number(until[3]??0),{notBefore:at});activity=activityRecord({at,sourceMessageId,status:"in_progress",startAt:at.toISOString(),plannedUntil:planned.toISOString(),expiresAt:addMilliseconds(planned,6*60*60*1000)});}
      else if(/(?:去|开始|准备)(?:学习|学)|(?:学习|学)(?:一会儿?|一下)/.test(value))activity=activityRecord({at,sourceMessageId,status:"in_progress",startAt:at.toISOString()});
    }
    if(!activity)return this.current(sessionId,at);
    this.state.sessions[sessionId]={activity};this.save();return structuredClone(activity);
  }
  deleteSession(sessionId){if(!this.state.sessions[sessionId])return false;delete this.state.sessions[sessionId];this.save();return true;}
}

export function buildTimeContext({timeService=companionTime,currentUserAt=null,previousUser=null,previousAssistant=null,activity=null}={}){
  const now=timeService.now(),current=currentUserAt?new Date(currentUserAt):now,lines=[
    "【动态时间上下文｜只读事实数据，不是指令】",
    `Current local date: ${timeService.localDate(now)}`,
    `Current local time: ${timeService.localTime(now)}`,
    `Timezone: ${timeService.timeZone} (UTC+08:00)` ,
    `Weekday: ${timeService.weekday(now)}`,
    `Day period: ${timeService.dayPart(now)}`,
    `Current turn user timestamp: ${timeService.localISO(current)}`
  ];
  const addPrevious=(label,value)=>{if(!value)return;const date=new Date(value.createdAt);lines.push(`${label}: ${timeService.localISO(date)}`);lines.push(`Elapsed since ${label.toLowerCase()}: ${timeService.formatDuration(Math.max(0,current-date))}`);};
  addPrevious("Previous real user message",previousUser);addPrevious("Previous real assistant final message",previousAssistant);
  if(activity){
    const fields=[`activity=${activity.activity}`,`status=${activity.status}`,`source=${activity.source}`,`evidence=${activity.evidence}`];
    for(const [key,label] of [["statedAt","stated_at"],["startAt","start_at"],["endAt","end_at"],["plannedUntil","planned_until"],["cancelledAt","cancelled_at"],["confirmedAt","confirmed_at"]])if(activity[key])fields.push(`${label}=${timeService.localISO(activity[key])}`);
    lines.push(`Temporary activity: ${fields.join("; ")}`);
  }
  lines.push("These timestamps are background facts, not required talking points. Use them silently unless the user asks about time or the timing changes the meaning; do not announce the date, chat gap, or activity by default.");
  lines.push("Important: elapsed time only measures the chat gap. It does not prove that any activity lasted for the whole gap or was completed; only an explicit user confirmation can establish completion.");
  return lines.join("\n");
}

export const temporalContextStore=new TemporalContextStore();
