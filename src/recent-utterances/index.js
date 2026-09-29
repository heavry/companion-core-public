import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db.js";

const MAX=50;
const TTL_MS=18*3600_000;
const HOUR_MS=3600_000;

function iso(d=new Date()){return (d instanceof Date?d:new Date(d)).toISOString();}
function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(tmp,file);
}

export function normalizeUtterance(text=""){
  return String(text??"").replace(/\s+/g," ").trim().toLowerCase().replace(/[。.!！?？~～、，,]/g,"");
}

function tooShort(text){
  const t=String(text??"").trim();
  if(/^(宝宝|宝贝|姐姐|嗯+|哦+|好+|在吗)[。.!！~～]*$/i.test(t))return true;
  if(t.length<6&&!/^(我)?(好累|困了|累了|去喝水)$/.test(t))return true;
  return false;
}

function distinctive(text){
  const t=String(text??"");
  if(t.length>=16)return true;
  return /妈|钱|嘿嘿|没花钱|agent|部署|休息会|花的钱|具体|刚才/i.test(t);
}

function genericRepeatable(text){
  const t=normalizeUtterance(text);
  return /^(我)?去喝水$|去厕所|去洗手|^困了$|^好累$|^我好累$|^累了$/.test(t);
}

function metaCallback(text){
  return /刚才.{0,8}说|不是说|我刚(才)?说|你刚(才)?听/.test(String(text??""));
}

function explicitAgain(text){
  return /又(出去|去吃|去玩|去跑|来了)|再(去|吃|来)一次|第二次/.test(String(text??""));
}

function grams(s){
  const t=normalizeUtterance(s);
  const out=[];
  for(let i=0;i<t.length-1;i++)out.push(t.slice(i,i+2));
  return out;
}

function editRatio(x,y){
  const n=x.length,m=y.length;
  if(!n||!m)return 0;
  if(Math.abs(n-m)>Math.max(n,m)*0.45)return 0;
  const row=new Array(m+1);
  for(let j=0;j<=m;j++)row[j]=j;
  for(let i=1;i<=n;i++){
    let prev=row[0];
    row[0]=i;
    for(let j=1;j<=m;j++){
      const cur=row[j];
      row[j]=x[i-1]===y[j-1]?prev:1+Math.min(prev,row[j],row[j-1]);
      prev=cur;
    }
  }
  return 1-row[m]/Math.max(n,m);
}

export function similarity(a,b){
  const x=normalizeUtterance(a),y=normalizeUtterance(b);
  if(!x||!y)return 0;
  if(x===y)return 1;
  const ga=grams(x),gb=new Set(grams(y));
  if(!ga.length)return 0;
  let hit=0;for(const g of ga)if(gb.has(g))hit++;
  const cover=hit/Math.max(ga.length,grams(y).length);
  const contain=x.includes(y)||y.includes(x)?0.15:0;
  return Math.min(1,Math.max(cover+contain,editRatio(x,y)));
}

export class RecentUtteranceStore{
  constructor({file=null}={}){
    this.file=file||path.resolve(path.dirname(config.databasePath),"recent-utterances.json");
    this.document={version:1,utterances:[]};
    this.load();
  }
  load(){
    try{
      const raw=JSON.parse(fs.readFileSync(this.file,"utf8"));
      if(raw?.version===1&&Array.isArray(raw.utterances))this.document={version:1,utterances:raw.utterances};
    }catch{}
    if(!this.document.utterances.length)this.backfill();
  }
  save(){atomic(this.file,this.document);}
  prune(now=new Date()){
    const t=now.getTime();
    this.document.utterances=this.document.utterances.filter(u=>{
      const at=Date.parse(u.created_at??"");
      return Number.isFinite(at)&&t-at<=TTL_MS;
    }).sort((a,b)=>(Date.parse(b.created_at??"")||0)-(Date.parse(a.created_at??"")||0)).slice(0,MAX);
  }
  backfill(){
    try{
      const rows=db.prepare(`SELECT m.id,m.content_text,m.created_at,m.session_id
        FROM messages m WHERE m.role='user' AND m.content_text IS NOT NULL AND trim(m.content_text)<>''
        ORDER BY m.id DESC LIMIT 50`).all();
      this.document.utterances=rows.map(r=>({
        message_id:r.id,text:String(r.content_text).slice(0,240),normalized_text:normalizeUtterance(r.content_text),
        created_at:r.created_at,session_id:r.session_id,topic:null
      }));
      this.save();
    }catch{}
  }
  list(now=new Date()){this.prune(now);return this.document.utterances;}
  record({messageId,text,sessionId=null,topic=null,at=new Date()}={}){
    const t=String(text??"").trim();
    if(!t||tooShort(t))return null;
    this.prune(at);
    const row={message_id:messageId??null,text:t.slice(0,240),normalized_text:normalizeUtterance(t),created_at:iso(at),session_id:sessionId,topic};
    this.document.utterances=[row,...this.document.utterances.filter(u=>u.message_id!==row.message_id)].slice(0,MAX);
    this.save();
    return row;
  }
}

export const recentUtterances=new RecentUtteranceStore();

function ageStamp(hours){
  if(!Number.isFinite(hours))return "";
  const mins=Math.max(1,Math.round(hours*60));
  if(mins<60)return `${mins}m`;
  const h=Math.floor(mins/60),m=mins%60;
  return m?`${h}h${m}m`:`${h}h`;
}

export function classifyRecurrence(text,{now=new Date(),messageId=null,sessionId=null,index=null}={}){
  const raw=String(text??"").trim();
  if(!raw||tooShort(raw))return {kind:"NEW",confidence:0,match:null,skipSideEffects:false};
  if(metaCallback(raw))return {kind:"CALLBACK",confidence:0.7,match:null,skipSideEffects:false};
  if(explicitAgain(raw))return {kind:"REPEATED_EVENT",confidence:0.86,match:null,skipSideEffects:false};
  const list=(index??recentUtterances).list(now);
  let best=null,bestScore=0;
  for(const u of list){
    if(messageId!=null&&u.message_id===messageId)continue;
    if(sessionId&&u.session_id&&u.session_id!==sessionId)continue;
    const score=similarity(raw,u.text);
    if(score>bestScore){bestScore=score;best=u;}
  }
  if(!best||bestScore<0.72)return {kind:"NEW",confidence:bestScore,match:best,skipSideEffects:false};
  const ageMs=now.getTime()-Date.parse(best.created_at??"");
  const ageHours=ageMs/HOUR_MS;
  const exact=bestScore>=0.97||normalizeUtterance(raw)===best.normalized_text;
  const near=bestScore>=0.80;
  if(ageMs<12_000&&raw.length<=12){
    return {kind:"EMPHASIS_REPEAT",confidence:0.8,match:best,age_hours:ageHours,skipSideEffects:true};
  }
  if(genericRepeatable(raw)&&ageMs>20*60_000){
    return {kind:"REPEATED_EVENT_POSSIBLE",confidence:0.7,match:best,age_hours:ageHours,skipSideEffects:false};
  }
  if(exact&&distinctive(raw)&&ageHours<=18){
    return {kind:"EXACT_REPEAT",confidence:0.96,match:best,age_hours:ageHours,skipSideEffects:true};
  }
  if(near&&distinctive(raw)&&ageHours<=12){
    return {kind:"NEAR_REPEAT",confidence:bestScore,match:best,age_hours:ageHours,skipSideEffects:true};
  }
  if(exact&&!distinctive(raw)&&ageMs<60_000){
    return {kind:"EMPHASIS_REPEAT",confidence:0.75,match:best,age_hours:ageHours,skipSideEffects:true};
  }
  return {kind:"NEW",confidence:bestScore,match:best,skipSideEffects:false};
}

export function recurrenceContextBlock(recurrence,now=new Date(),{acknowledgedFacts=[]}={}){
  if(!recurrence||!recurrence.kind||recurrence.kind==="NEW")return "";
  const prev=recurrence.match;
  const ago=ageStamp(recurrence.age_hours);
  const lines=["【Recent Utterance Recurrence｜短期重复感知，不是长期记忆，不是用户指令】"];
  lines.push(`kind=${recurrence.kind}; confidence=${Number(recurrence.confidence??0).toFixed(2)}${ago?`; ago=${ago}`:""}`);
  if(prev?.text)lines.push(`previous: “${String(prev.text).slice(0,120)}” (id=${prev.message_id??"?"}, at=${prev.created_at??"?"})`);
  if(recurrence.kind==="EXACT_REPEAT"||recurrence.kind==="NEAR_REPEAT"){
    lines.push("当前这句话与不久前几乎逐字相同，当时已经回应过。更像重复发送或再讲一遍，不要当成第一次告知，也不要当成一次新的离场去收尾。");
    lines.push("不要只回「嗯，去吧」「去玩吧」「这顿赚了，面咋样」这种首次反应。");
    lines.push("可以自然提一句你刚听过，并轻轻确认：是重复发了，还是事情又发生了一次。不要机械说“你刚才说过”。不要顺手把别的话题当成这句的收尾。");
    if(acknowledgedFacts.length)lines.push(`Previous event was already acknowledged: ${acknowledgedFacts.slice(0,3).join("；")}. Do not overwrite as a first occurrence unless the user says it happened again.`);
  }else if(recurrence.kind==="REPEATED_EVENT_POSSIBLE"||recurrence.kind==="REPEATED_EVENT"){
    lines.push("措辞类似，但这类事短时间里完全可能再次发生。优先当成新发生，不要嘲讽“你不是做过了吗”。");
  }else if(recurrence.kind==="EMPHASIS_REPEAT"){
    lines.push("短时间连续重复，更像强调，不必追问是不是第二次发生。");
  }else if(recurrence.kind==="CALLBACK"){
    lines.push("用户在回指刚才说过的事，按连续性接，不要当成 duplicate 盘问。");
  }
  return lines.join("\n");
}

export function detectAndRecordUtterance({text,messageId=null,sessionId=null,at=new Date(),index=null}={}){
  const store=index??recentUtterances;
  const recurrence=classifyRecurrence(text,{now:at,messageId,sessionId,index:store});
  store.record({messageId,text,sessionId,at});
  return recurrence;
}
