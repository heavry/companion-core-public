import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { companionTime } from "./time-service.js";

const HOUR_MS=3600_000;
const MIN_MS=60_000;

function iso(d=new Date()){return (d instanceof Date?d:new Date(d)).toISOString();}
function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(tmp,file);
}

const LEAVE_KINDS=[
  {kind:"sleep",re:/我去睡|先睡|睡觉了|我要睡了|去躺|晚安(?!好)/,ms:null},
  {kind:"class",re:/去上课|上课了|去学校/,ms:3*HOUR_MS},
  {kind:"bath",re:/我去洗澡|洗澡去了|先洗澡|去洗漱/,ms:28*MIN_MS},
  {kind:"meal",re:/去吃饭|去吃面|出去吃|先吃饭/,ms:50*MIN_MS},
  {kind:"agent",re:/跑\s*agent.{0,20}回来|去跑\s*agent/i,ms:35*MIN_MS},
  {kind:"play",re:/去玩了|去玩会|玩去了|去玩一会儿|那宝贝去玩/,ms:55*MIN_MS},
  {kind:"busy",re:/我先忙会|先忙|去忙|忙去了|开始忙/,ms:45*MIN_MS},
  {kind:"leave",re:/先走了|我先走|出门了|先出门/,ms:40*MIN_MS},
  // Multi-day explained absence — must not be read as ignored/abandoned.
  {kind:"known_busy",re:/这两天(?:可能)?(?:不回|没空|忙|考试|加班|出差)|最近(?:太忙|在忙|比较忙)|可能不回消息|这几天(?:不回|没空|忙)|我要闭关|闭关(?:学习|考试|赶工)/,ms:30*HOUR_MS},
  {kind:"dont_contact",re:/先别找我|别找我|不要找我|让我静静|我想静静|先别烦我|别烦我/,ms:18*HOUR_MS},
  {kind:"tomorrow",re:/明天再聊|明天再说|改天再聊|晚点再聊|回头再聊(?!天?$)/,ms:14*HOUR_MS}
];

const CANCEL_RE=/我不去了|逗你的|开玩笑.{0,6}不去|我回来了|回来了|我在[。.!！]?$/;
const ASSISTANT_CLOSE_RE=/去玩吧|去洗吧|去睡吧|去吧宝贝|去吧[。！!]|回头想找|回头再(?:聊|来)|洗完再来|忙完再|歇一会儿|你去忙|晚安[。！!]|好梦/;

export function classifyLeave(text=""){
  const t=String(text??"").trim();
  if(!t)return null;
  for(const row of LEAVE_KINDS){
    const m=t.match(row.re);
    if(m)return {kind:row.kind,sample:m[0],ms:row.ms};
  }
  return null;
}

/** Multi-day / explicit “don’t contact me” explanations. */
export function classifyExplainedAbsence(text=""){
  const leave=classifyLeave(text);
  if(!leave)return null;
  if(["known_busy","dont_contact","tomorrow","busy"].includes(leave.kind)){
    return {kind:leave.kind,sample:leave.sample,dontContact:leave.kind==="dont_contact",knownBusy:leave.kind!=="dont_contact"};
  }
  return null;
}

export function looksLikeAssistantClosure(text="",pendingKind=null){
  const t=String(text??"").trim();
  if(!t)return false;
  if(ASSISTANT_CLOSE_RE.test(t))return true;
  // Short release without a new question still counts (e.g. 「嗯，去玩。姐姐歇着。」).
  if(pendingKind&&t.length<=80&&!/[?？]|吗[。！!]?$/.test(t))return true;
  return false;
}

function untilMs(kind,at){
  const start=at.getTime();
  if(kind==="sleep"){
    const parts=companionTime.parts(at);
    let eight=companionTime.fromLocalParts({year:parts.year,month:parts.month,day:parts.day,hour:8,minute:0});
    if(eight.getTime()<=start)eight=new Date(eight.getTime()+24*HOUR_MS);
    return Math.min(start+14*HOUR_MS,Math.max(eight.getTime(),start+6*HOUR_MS));
  }
  const table={bath:28*MIN_MS,meal:50*MIN_MS,play:55*MIN_MS,class:3*HOUR_MS,agent:35*MIN_MS,busy:45*MIN_MS,leave:40*MIN_MS,known_busy:30*HOUR_MS,dont_contact:18*HOUR_MS,tomorrow:14*HOUR_MS};
  return start+(table[kind]??40*MIN_MS);
}

export class ContactSuppressionStore{
  constructor({file=null}={}){
    this.file=file||path.resolve(path.dirname(config.databasePath),"contact-suppression.json");
    this.state={version:1,pending:null,active:null};
    this.load();
  }
  load(){
    try{
      const raw=JSON.parse(fs.readFileSync(this.file,"utf8"));
      if(raw?.version===1)this.state={version:1,pending:raw.pending??null,active:raw.active??null};
    }catch{}
  }
  save(){atomic(this.file,this.state);}

  snapshot(at=new Date()){
    const now=(at instanceof Date?at:new Date(at)).getTime();
    if(this.state.active){
      const until=Date.parse(this.state.active.until);
      if(Number.isFinite(until)&&until<=now){
        this.state.active=null;
        this.save();
      }
    }
    return structuredClone(this.state);
  }

  active(at=new Date()){
    const snap=this.snapshot(at);
    return snap.active||null;
  }

  clear(reason="user_return",at=new Date()){
    if(!this.state.active&&!this.state.pending)return null;
    this.state={version:1,pending:null,active:null,cleared_at:iso(at),cleared_reason:reason};
    this.save();
    return {cleared:true,reason};
  }

  observeUser({text="",messageId=null,at=new Date(),armLeave=true}={}){
    const date=at instanceof Date?at:new Date(at);
    const t=String(text??"").trim();
    if(!t)return this.snapshot(date);
    if(this.state.active||this.state.pending){
      this.clear(CANCEL_RE.test(t)?"cancelled_or_returned":"user_message",date);
    }
    const leave=classifyLeave(t);
    if(leave&&armLeave){
      this.state.pending={
        kind:leave.kind,sample:leave.sample,source_message_id:messageId,
        at:iso(date),until_estimate:iso(new Date(untilMs(leave.kind,date)))
      };
      this.save();
    }
    return this.snapshot(date);
  }

  observeAssistant({text="",at=new Date()}={}){
    const date=at instanceof Date?at:new Date(at);
    const pending=this.state.pending;
    if(!pending)return this.snapshot(date);
    if(!looksLikeAssistantClosure(text,pending.kind))return this.snapshot(date);
    const until=iso(new Date(untilMs(pending.kind,date)));
    this.state.active={
      kind:pending.kind,sample:pending.sample,source_message_id:pending.source_message_id,
      closed_at:iso(date),until,assistant_closed:true
    };
    this.state.pending=null;
    this.save();
    console.log("[closure-suppression]",JSON.stringify({active:true,kind:this.state.active.kind,until}));
    return this.snapshot(date);
  }
}

export const contactSuppression=new ContactSuppressionStore();

export function suppressionWait(at=new Date(),{inactivity=null}={}){
  const active=contactSuppression.active(at);
  if(!active)return null;
  return {action:"WAIT",reason:"post_closure_suppression",kind:active.kind,until:active.until,urgency:0};
}
