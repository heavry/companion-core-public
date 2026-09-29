import { db, getLatestUserMessageAt, listRecentEvents } from "../db.js";
import { config } from "../config.js";
import { companionTime } from "../time-service.js";
import { naturalPresence } from "../natural-presence/index.js";
import { naturalCognition } from "../natural-cognition/index.js";
import { companionStateSummary } from "../companion-state.js";
import { localDayBounds, shiftLocalDate, validLocalDate } from "./dates.js";
import { consecutiveQuietDays, getDiaryMeta, recentDiarySummaries } from "./store.js";

const AGENT_SOURCE_RE=/agent|opencode|harness|code/i;
const HIGHLIGHT_RE=/争执|吵架|对不起|抱歉|和好|回来|agent|测试|tts|修好|弄好|搞定|结果|语音|声音|气泡|沉默|想你|没来/i;
const TRANSIENT_TEMPORAL_RE=/一会回来|一会儿回来|等会儿|等一会|吃完再|吃完饭再|先吃饭|洗完回|今晚再弄|马上回来|等下处理|等下再|回头再|吃完再说/;
const USER_OWN_DIARY_RE=/我(?:自己)?也(?:在)?写日记|我也有日记|我的日记/;

export function extractTransientTemporal(text=""){
  const m=String(text??"").match(TRANSIENT_TEMPORAL_RE);
  return m?m[0]:null;
}

export function temporalAgainstDiary(createdAt,dateLocal,now=new Date()){
  const created=Date.parse(createdAt??"");
  let createdDate=null;
  try{if(Number.isFinite(created))createdDate=companionTime.localDate(new Date(created));}catch{}
  const endMs=Date.parse(localDayBounds(dateLocal).end);
  const ref=Number.isFinite(endMs)?endMs-1:(now instanceof Date?now:new Date(now)).getTime();
  const ageMs=Number.isFinite(created)?Math.max(0,ref-created):null;
  const ageHours=ageMs==null?null:Number((ageMs/3600_000).toFixed(1));
  const ageDays=ageHours==null?null:Number((ageHours/24).toFixed(2));
  const crossedDay=Boolean(createdDate&&createdDate<dateLocal);
  return {createdAt:createdAt??null,ageHours,ageDays,crossedDay,diaryDate:dateLocal,createdDateLocal:createdDate};
}

function annotateUnresolved(item,dateLocal,now,text=""){
  const blob=[item.topic,item.text,item.expected,item.state,text].filter(Boolean).join(" ");
  const temporal=temporalAgainstDiary(item.createdAt??item.created_at,dateLocal,now);
  return {
    ...item,
    createdAt:temporal.createdAt,
    ageHours:temporal.ageHours,
    ageDays:temporal.ageDays,
    crossedDay:temporal.crossedDay,
    diaryDate:dateLocal,
    originalTemporalWording:extractTransientTemporal(blob),
    temporalStatus:temporal.crossedDay?"past_unresolved":"current"
  };
}

export function userClaimsOwnDiary(evidence){
  const blob=[
    ...(evidence?.chat?.excerpts??[]).map(x=>x.text),
    ...(evidence?.recentDiarySummaries??[]).map(x=>x.summary)
  ].join("\n");
  return USER_OWN_DIARY_RE.test(blob);
}

function clip(text,max=240){
  const value=String(text??"").replace(/\s+/g," ").trim();
  return value.length<=max?value:`${value.slice(0,max-1)}…`;
}

function qualitativePresence(dims={}){
  const num=key=>Number(dims?.[key]?.current??dims?.[key]??0);
  const mood=num("mood"),energy=num("energy"),closeness=num("closeness"),irritation=num("irritation");
  const playfulness=num("playfulness"),social=num("social_drive"),confidence=num("confidence");
  return {
    mood:mood>=0.35?"心情不错":mood>=0?"还算平稳":mood>=-0.25?"有点闷":"情绪偏低",
    energy:energy>=0.65?"还好":energy>=0.4?"有点累":"很累",
    closeness:closeness>=0.8?"很亲近":closeness>=0.6?"亲近":"普通",
    irritation:irritation>=0.45?"有点不高兴":irritation>=0.25?"略烦":"平静",
    playfulness:playfulness>=0.7?"想开玩笑":playfulness>=0.45?"轻松":"不太想闹",
    social_drive:social>=0.7?"很想找他":social>=0.45?"偶尔会想起":"不太主动",
    confidence:confidence>=0.8?"挺有把握":"一般"
  };
}

function pickExcerpts(rows,max=16){
  if(rows.length<=max)return rows.map(toExcerpt);
  const scored=rows.map((row,index)=>{
    const text=String(row.content_text??"");
    const lengthScore=Math.min(1,text.length/180);
    const highlight=HIGHLIGHT_RE.test(text)?1:0;
    const recency=index/Math.max(1,rows.length-1);
    const first=index<2?0.35:0;
    const last=index>=rows.length-6?0.4:0;
    return {row,index,score:lengthScore*0.35+highlight*0.4+recency*0.2+first+last};
  }).sort((a,b)=>b.score-a.score);
  const chosen=new Set();
  for(const item of scored){
    if(chosen.size>=max)break;
    chosen.add(item.index);
  }
  return [...chosen].sort((a,b)=>a-b).map(i=>toExcerpt(rows[i]));
}

function toExcerpt(row){
  return {
    id:row.id,
    role:row.role,
    source:row.source,
    at:row.created_at,
    text:clip(row.content_text,220)
  };
}

export function listDayChatRows({personaId=config.defaultPersonaId,dateLocal,limit=200}={}){
  if(!validLocalDate(dateLocal))return [];
  const {start,end}=localDayBounds(dateLocal);
  return db.prepare(`
    SELECT m.id,m.role,m.content_text,m.created_at,m.source AS message_source,s.source,s.id AS session_id
    FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE s.persona_id=? AND m.created_at>=? AND m.created_at<?
      AND m.role IN ('user','assistant')
      AND m.content_text IS NOT NULL AND trim(m.content_text)<>''
      AND (m.tool_calls_json IS NULL OR m.tool_calls_json='[]')
    ORDER BY m.id ASC LIMIT ?
  `).all(personaId,start,end,limit);
}

function isDailyChat(row){
  return !AGENT_SOURCE_RE.test(String(row.source??""));
}

export function buildDailyEvidence(dateLocal,{
  personaId=config.defaultPersonaId,
  now=new Date(),
  presence=null,
  cognition=null
}={}){
  if(!validLocalDate(dateLocal))throw new Error("invalid local date");
  const bounds=localDayBounds(dateLocal);
  const rows=listDayChatRows({personaId,dateLocal,limit:220}).filter(isDailyChat);
  const userRows=rows.filter(r=>r.role==="user");
  const assistantRows=rows.filter(r=>r.role==="assistant");
  const proactiveCount=rows.filter(r=>String(r.source??"").startsWith("proactive")||String(r.message_source??"").startsWith("proactive")).length;
  const presenceSnap=presence??(naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null);
  const cognitionSnap=cognition??(naturalCognition.enabled?naturalCognition.snapshot():null);
  const dims=presenceSnap?.dimensions??{};
  const eventsThatDay=(presenceSnap?.recent_event_types??[]).filter(ev=>{
    const t=Date.parse(ev.at??"");
    return Number.isFinite(t)&&t>=Date.parse(bounds.start)&&t<Date.parse(bounds.end);
  });
  const openLoops=(presenceSnap?.open_loops??[]).filter(l=>!l.resolved).slice(0,6)
    .map(l=>annotateUnresolved({id:l.id,topic:l.topic,state:l.state,salience:l.salience,createdAt:l.created_at,expectedAt:l.expected_followup_at},dateLocal,now));
  const thoughtSeeds=(presenceSnap?.thought_seeds??[]).filter(s=>!s.expired).slice(0,5)
    .map(s=>annotateUnresolved({id:s.id,text:s.text,topic:s.topic,salience:s.salience,createdAt:s.created_at},dateLocal,now));
  const expectations=(cognitionSnap?.expectations??[]).filter(e=>e.state==="pending").slice(0,4)
    .map(e=>annotateUnresolved({id:e.id,topic:e.topic,expected:e.expected_information,salience:e.salience,createdAt:e.created_at},dateLocal,now));
  const focus=[cognitionSnap?.focus?.primary,cognitionSnap?.focus?.secondary].filter(Boolean).map(f=>({topic:f.topic,source:f.source,salience:f.salience}));
  const lastUserAt=getLatestUserMessageAt(personaId);
  const endMs=Date.parse(bounds.end);
  const lastUserMs=Date.parse(lastUserAt??"");
  const silenceHours=Number.isFinite(lastUserMs)?Math.max(0,(Math.min(endMs,(now instanceof Date?now:new Date(now)).getTime())-lastUserMs)/3600_000):null;
  const rhythm=presenceSnap?.interaction_rhythm??null;
  const recentDiaries=recentDiarySummaries(personaId,dateLocal,3);
  const meta=getDiaryMeta(personaId);
  const quietStreak=consecutiveQuietDays(personaId,dateLocal);
  const dayEvents=listRecentEvents(personaId,20).filter(ev=>{
    const t=Date.parse(ev.created_at??"");
    return Number.isFinite(t)&&t>=Date.parse(bounds.start)&&t<Date.parse(bounds.end);
  }).slice(0,6).map(ev=>({source:ev.source,content:clip(ev.content,120),importance:ev.importance}));

  const excerpts=pickExcerpts(rows,rows.length<=2?rows.length:16);
  const built={
    dateLocal,
    weekday:companionTime.weekday(companionTime.parseLocalDateTime(`${dateLocal}T12:00:00`)),
    sourceStartAt:bounds.start,
    sourceEndAt:bounds.end,
    chat:{
      userMessageCount:userRows.length,
      assistantMessageCount:assistantRows.length,
      total:rows.length,
      proactiveCount,
      firstAt:rows[0]?.created_at??null,
      lastAt:rows.at(-1)?.created_at??null,
      excerpts
    },
    silence:{
      lastUserAt,
      hours:silenceHours==null?null:Number(silenceHours.toFixed(1)),
      consecutiveQuietDays:quietStreak,
      noChatToday:userRows.length===0&&assistantRows.length===0
    },
    presence:{
      qualitative:qualitativePresence(dims),
      snapshots:{
        mood:dims.mood?.current??null,
        energy:dims.energy?.current??null,
        closeness:dims.closeness?.current??null,
        irritation:dims.irritation?.current??null
      },
      labels:presenceSnap?.labels??[],
      events:eventsThatDay.map(e=>({type:e.type,severity:e.severity,topic:e.topic??null})),
      opinions:(presenceSnap?.opinions??[]).slice(0,2).map(o=>({topic:o.topic,stance:o.stance}))
    },
    openLoops,
    thoughtSeeds,
    expectations,
    focus,
    rhythm:{
      typicalHours:rhythm?.activeHours??[],
      avgPerDay:rhythm?.avgPerDay??0,
      samples:rhythm?.samples??0
    },
    recentDiarySummaries:recentDiaries,
    dayEvents,
    companion:{
      lastProactiveAt:companionStateSummary()?.lastProactiveAt??null
    },
    originDate:meta?.origin_date_local??null
  };
  built.userHasOwnDiary=userClaimsOwnDiary(built);
  return built;
}

export function compactEvidenceForPrompt(evidence){
  const chat=evidence.chat??{};
  const noChat=Boolean(evidence.silence?.noChatToday);
  return {
    date:evidence.dateLocal,
    weekday:evidence.weekday,
    no_chat_today:noChat,
    chat_counts:{user:chat.userMessageCount||0,assistant:chat.assistantMessageCount||0,proactive:chat.proactiveCount||0},
    excerpts:chat.excerpts??[],
    silence:evidence.silence,
    presence_feel:evidence.presence?.qualitative??{},
    presence_events:evidence.presence?.events??[],
    opinions:evidence.presence?.opinions??[],
    unresolved_open_loops:evidence.openLoops??[],
    pending_expectations:evidence.expectations??[],
    thought_seeds:evidence.thoughtSeeds??[],
    current_focus:evidence.focus??[],
    interaction_rhythm:evidence.rhythm??{},
    recent_diary_summaries:evidence.recentDiarySummaries??[],
    user_has_own_diary:Boolean(evidence.userHasOwnDiary),
    diary_owner:"林小糖（写这篇日记的人，不是用户）",
    notes:[
      "以上全部是系统证据。没有出现的事情等于没发生。日记是主观记录，不是用户事实。",
      "按 diary date 重新解释时态。temporalStatus=past_unresolved 的条目只是以前没说完的事，不要复制 originalTemporalWording 里的瞬时时态（一会回来/吃完再弄等）。",
      evidence.userHasOwnDiary?"用户明确说过自己也写日记，可以提到「你的日记」。":"这篇日记是林小糖自己的。不要问用户「你日记写啥了」。"
    ].join(" ")
  };
}

export { shiftLocalDate };
