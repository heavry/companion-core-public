import { config } from "../config.js";
import { companionTime } from "../time-service.js";
import { validLocalDate, shiftLocalDate } from "./dates.js";
import { adjacentDiaryDates, getDiaryEntry, getDiaryMeta, listDiaryEntries, searchDiaryFts } from "./store.js";
import { naturalCognition } from "../natural-cognition/index.js";

const WEEKDAYS=["日","一","二","三","四","五","六"];
const GREETING_RE=/^(宝宝|在吗|在嘛|在不在|你好|嗨|哈喽|hello|hi|早|晚安|在干嘛|干嘛呢)[\s!！?？.。~～]*$/i;
const EXPLICIT_DIARY_RE=/日记|diary|你写过|写过我|你那天写|日记里/;
const RELATIVE_RE=/(今天|今日|昨天|昨日|前天|大前天|上周|上星期)/;

function clip(text,max=360){
  const value=String(text??"").replace(/\s+/g," ").trim();
  return value.length<=max?value:`${value.slice(0,max-1)}…`;
}

export function detectDiaryIntent(text="",now=new Date()){
  const q=String(text??"").trim();
  if(!q)return {explicit:false,search:false,dates:[],greeting:false};
  const greeting=GREETING_RE.test(q);
  const explicit=EXPLICIT_DIARY_RE.test(q);
  const dates=[];
  const today=companionTime.localDate(now);
  if(/今天|今日/.test(q)&&explicit)dates.push(today);
  if(/昨天|昨日/.test(q))dates.push(shiftLocalDate(today,-1));
  if(/前天/.test(q)&&!/大前天/.test(q))dates.push(shiftLocalDate(today,-2));
  if(/大前天/.test(q))dates.push(shiftLocalDate(today,-3));
  const md=q.match(/(\d{1,2})月(\d{1,2})日/);
  if(md){
    const year=Number(companionTime.parts().year);
    const candidate=`${year}-${String(md[1]).padStart(2,"0")}-${String(md[2]).padStart(2,"0")}`;
    if(validLocalDate(candidate))dates.push(candidate);
  }
  const iso=q.match(/(\d{4}-\d{2}-\d{2})/);
  if(iso&&validLocalDate(iso[1]))dates.push(iso[1]);
  const week=q.match(/上?周([日一二三四五六天])/);
  if(week){
    const target=week[1]==="天"?0:WEEKDAYS.indexOf(week[1]);
    if(target>=0){
      const nowParts=companionTime.parts();
      let delta=nowParts.weekday-target;
      if(/上周|上星期/.test(q))delta+=7;
      else if(delta<=0)delta+=7;
      dates.push(shiftLocalDate(today,-delta));
    }
  }
  const search=explicit||/(你之前是不是写过|你还记得你.*日记|哪天写过|日记里写)/.test(q);
  return {explicit,search,dates:[...new Set(dates)],greeting,relative:RELATIVE_RE.test(q)};
}

function searchTopic(query){
  return String(query??"")
    .replace(EXPLICIT_DIARY_RE," ")
    .replace(RELATIVE_RE," ")
    .replace(/你|我|哪天|写过|那个|这个|还记得|是不是|有没有|什么|啥|吗|呢|啊|的|了|吧/g," ")
    .replace(/[？?！!，,。.\s]+/g," ")
    .trim();
}

function searchTerms(query){
  const cleaned=searchTopic(query);
  const terms=new Set();
  if(cleaned.length>=2)terms.add(cleaned);
  for(const token of cleaned.match(/[A-Za-z][A-Za-z0-9_-]{1,24}|[\u4e00-\u9fa5]{2,8}/g)??[])terms.add(token);
  return [...terms];
}

function overlapScore(query,text){
  const q=String(query??"");
  const body=String(text??"");
  if(!q||!body)return 0;
  const grams=[];
  for(let i=0;i<Math.min(q.length-1,48);i++){
    const g=q.slice(i,i+2);
    if(/[\u4e00-\u9fa5A-Za-z0-9]/.test(g))grams.push(g);
  }
  if(!grams.length)return 0;
  const hit=grams.filter(g=>body.includes(g)).length;
  return Math.min(1,hit/Math.max(4,grams.length));
}

export function retrieveDiariesForQuery(query,{personaId=config.defaultPersonaId,now=new Date(),limit=2}={}){
  if(!config.naturalDiaryEnabled)return {inject:false,reason:"disabled",entries:[]};
  const intent=detectDiaryIntent(query,now);
  const max=Math.max(1,Math.min(3,limit));
  if(intent.greeting&&!intent.explicit)return {inject:false,reason:"greeting",intent,entries:[]};

  const picked=[];
  const seen=new Set();
  const add=(entry,reason,score)=>{
    if(!entry||seen.has(entry.id)||picked.length>=max)return;
    seen.add(entry.id);
    picked.push({...entry,retrievalReason:reason,score});
  };

  for(const date of intent.dates){
    add(getDiaryEntry(date,personaId),"exact_date",1);
  }
  if(intent.explicit&&!intent.dates.length){
    for(const entry of listDiaryEntries({personaId,limit:2}))add(entry,"recent_explicit",0.72);
  }
  if(intent.search||intent.explicit){
    const terms=searchTerms(query);
    for(const term of terms){
      for(const entry of searchDiaryFts(term,personaId,6)){
        add(entry,"fts",0.55+overlapScore(term,`${entry.body} ${entry.summary}`)*0.4);
      }
    }
    if(!picked.length){
      for(const entry of listDiaryEntries({personaId,limit:14})){
        const hay=`${entry.body} ${entry.summary} ${entry.messageToUser}`;
        const score=Math.max(overlapScore(query,hay),...terms.map(term=>overlapScore(term,hay)));
        if(score>=0.2||terms.some(term=>hay.includes(term)))add(entry,"scan",Math.max(score,0.5));
      }
    }
  }

  if(!intent.explicit&&!intent.search&&!intent.dates.length){
    const focusTopics=(naturalCognition.enabled?naturalCognition.focusList():[]).map(f=>f.topic).filter(Boolean);
    const recent=listDiaryEntries({personaId,limit:3});
    const today=companionTime.localDate(now);
    for(const entry of recent){
      const recency=entry.dateLocal>=shiftLocalDate(today,-2);
      const topicHit=Math.max(overlapScore(query,`${entry.body} ${entry.summary}`),...focusTopics.map(t=>overlapScore(t,entry.body)));
      if(recency&&topicHit>=0.42)add(entry,"high_relevance",topicHit);
    }
  }

  picked.sort((a,b)=>(b.score??0)-(a.score??0));
  const entries=picked.slice(0,max);
  return {inject:entries.length>0,reason:entries[0]?.retrievalReason??"none",intent,entries};
}

export function diaryContextBlock(query,{personaId=config.defaultPersonaId,now=new Date()}={}){
  const retrieved=retrieveDiariesForQuery(query,{personaId,now,limit:2});
  if(!retrieved.inject)return "";
  const lines=[
    "【林小糖自己的日记｜主观记录｜不是用户事实】",
    "下面是你自己某天写下的主观感受和回忆，不是经过验证的用户事实。",
    "不能据此认定用户一定如何，也不能把日记内容提升成长期用户记忆。",
    "这是后台理解材料，不是本轮必须提到的话题。只有当前问题确实相关时才可以自然提起；否则 silent-use，不要每次开场都引用日记，也不要朗读数值。"
  ];
  for(const entry of retrieved.entries){
    const aside=entry.messageToUser?`想对他说：${clip(entry.messageToUser,120)}` : "";
    lines.push(`- ${entry.dateLocal}：${clip(entry.body,420)}${aside?`（${aside}）`:""}`);
  }
  return lines.join("\n");
}

export function diaryProductSnapshot(dateLocal,{personaId=config.defaultPersonaId}={}){
  const selected=validLocalDate(dateLocal)?dateLocal:companionTime.localDate();
  const entry=getDiaryEntry(selected,personaId);
  const recent=listDiaryEntries({personaId,limit:8}).map(item=>({
    dateLocal:item.dateLocal,
    summary:item.summary||clip(item.body,72),
    createdAt:item.createdAt,
    userMessageCount:item.userMessageCount
  }));
  const adjacent=adjacentDiaryDates(selected,personaId);
  const today=companionTime.localDate();
  const origin=getDiaryMeta(personaId)?.origin_date_local;
  const floor=origin||shiftLocalDate(today,-7);
  const prevCal=shiftLocalDate(selected,-1);
  const nextCal=shiftLocalDate(selected,1);
  return {
    available:true,
    selectedDate:selected,
    entry:entry?{
      id:entry.id,
      dateLocal:entry.dateLocal,
      body:entry.body,
      summary:entry.summary,
      reflection:entry.reflection,
      messageToUser:entry.messageToUser,
      createdAt:entry.createdAt,
      userMessageCount:entry.userMessageCount,
      assistantMessageCount:entry.assistantMessageCount
    }:null,
    recent,
    previousDate:prevCal>=floor?prevCal:adjacent.previousDate,
    nextDate:nextCal<=today?nextCal:null
  };
}
