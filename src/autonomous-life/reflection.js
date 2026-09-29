import crypto from "node:crypto";

const count=(events,tag)=>events.filter(event=>event.tags?.includes(tag)).length;
const clamp01=value=>Math.max(0,Math.min(1,Number(value)||0));

export function shouldReflect(document,{now=new Date(),eventThreshold=8,minIntervalMs=6*60*60_000}={}){
  const since=document.lastReflectionAt?Date.parse(document.lastReflectionAt):0;
  const events=(document.recentEvents??[]).filter(event=>!since||Date.parse(event.at)>since);
  if(events.length<eventThreshold)return false;
  return !since||now.getTime()-since>=minIntervalMs||events.length>=eventThreshold*2;
}

export function deriveReflection(document,{now=new Date()}={}){
  const since=document.lastReflectionAt?Date.parse(document.lastReflectionAt):0;
  const events=(document.recentEvents??[]).filter(event=>!since||Date.parse(event.at)>since);
  if(!events.length)return null;
  const switches=count(events,"goal_switch"),pressure=count(events,"boundary_pressure"),appreciation=count(events,"appreciation"),questions=count(events,"curiosity");
  const patterns=[],updates=[];
  if(switches>=2){patterns.push("frequent_goal_switching");updates.push({key:"protect_current_goal",delta:Math.min(0.18,0.04*switches),confidenceDelta:0.1,evidenceCount:switches});}
  if(pressure>=2){patterns.push("repeated_boundary_pressure");updates.push({key:"maintain_clear_boundaries",delta:Math.min(0.16,0.04*pressure),confidenceDelta:0.12,evidenceCount:pressure});}
  if(appreciation>=2){patterns.push("positive_reciprocity");updates.push({key:"warm_reciprocity",delta:Math.min(0.12,0.03*appreciation),confidenceDelta:0.08,evidenceCount:appreciation});}
  if(questions>=3){patterns.push("sustained_curiosity");updates.push({key:"support_exploration",delta:Math.min(0.12,0.02*questions),confidenceDelta:0.08,evidenceCount:questions});}
  const summary=patterns.length
    ? `近期互动形成了 ${patterns.join("、")} 的稳定迹象；后续决策应依据证据逐步调整，不把单次情绪当成长期偏好。`
    : "近期互动没有形成足够稳定的新规律；保留现有长期倾向。";
  return {id:`reflection_${crypto.randomUUID()}`,createdAt:now.toISOString(),summary,patterns,preferenceUpdates:updates,sourceEventIds:events.map(event=>event.id)};
}

export function applyPreferenceUpdates(preferences,updates,at){
  const next={};
  for(const [key,current] of Object.entries(preferences??{})){
    const elapsedRaw=Date.parse(at)-Date.parse(current.updatedAt??at),elapsedMs=Number.isFinite(elapsedRaw)?Math.max(0,elapsedRaw):0,elapsedDays=elapsedMs/86_400_000;
    next[key]={...current,value:clamp01(0.5+(Number(current.value)-0.5)*Math.pow(0.5,elapsedDays/90)),confidence:clamp01(Number(current.confidence)*Math.pow(0.5,elapsedDays/180)),updatedAt:at};
  }
  for(const update of updates??[]){
    const current=next[update.key]??{value:0.5,confidence:0,evidenceCount:0};
    next[update.key]={
      value:clamp01(Number(current.value)+Number(update.delta??0)),
      confidence:clamp01(Number(current.confidence)+Number(update.confidenceDelta??0)),
      evidenceCount:Number(current.evidenceCount??0)+Number(update.evidenceCount??0),updatedAt:at
    };
  }
  return next;
}
