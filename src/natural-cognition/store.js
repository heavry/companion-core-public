import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { publishEvent } from "../events-bus.js";
import { classifyOwnership,normalizeFollowupKind,NEXT_ACTORS,FOLLOWUP_KINDS } from "../proactive-ownership.js";

// Natural Cognition v1: Attention/Seen, Memory Accessibility, Pending Expectation, Current Focus.
// Cognitive state only — no new mood/emotion system.

const HOUR_MS=3600_000;
const MAX_SEEN=200;
const MAX_EXPECTATIONS=3;
const MAX_RECALL=80;
const FOCUS_MAX=2;

function iso(d=new Date()){return (d instanceof Date?d:new Date(d)).toISOString();}
function finite(v){const t=Date.parse(v??"");return Number.isFinite(t)?t:null;}
function clamp(v,a,b){return Math.max(a,Math.min(b,Number(v)||0));}
function atomicWrite(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(tmp,file);
  try{fs.chmodSync(file,0o600);}catch{}
}
function readJson(file,fallback){
  try{return JSON.parse(fs.readFileSync(file,"utf8"));}
  catch{return fallback;}
}

function defaultDocument(now){
  return {
    version:1,
    enabled:config.naturalCognitionEnabled!==false,
    attention:{state:"UNKNOWN",window_active:false,chat_visible:false,updated_at:now},
    seen:{}, // messageId -> {message_id,delivered_at,seen_at,replied_at,session_id}
    expectations:[],
    focus:{primary:null,secondary:null,updated_at:now},
    recall_log:[], // {memory_id,at,score}
    updated_at:now
  };
}

function normalize(raw,now){
  const base=defaultDocument(now);
  const src=raw&&typeof raw==="object"?raw:{};
  return {
    ...base,
    ...src,
    version:1,
    enabled:src.enabled!==false,
    attention:{...base.attention,...(src.attention??{})},
    seen:src.seen&&typeof src.seen==="object"?src.seen:{},
    expectations:Array.isArray(src.expectations)?src.expectations.slice(-20):[],
    focus:{...base.focus,...(src.focus??{})},
    recall_log:Array.isArray(src.recall_log)?src.recall_log.slice(-MAX_RECALL):[],
    updated_at:now
  };
}

export class NaturalCognitionStore{
  constructor({file=config.naturalCognitionStatePath,enabled=config.naturalCognitionEnabled,now=()=>new Date()}={}){
    this.file=file;this.enabled=Boolean(enabled);this.now=now;
    this.document=defaultDocument(iso(this.now()));
    if(this.enabled){this.load();try{this.migrateExpectationOwnership();}catch{}}
  }
  load(){
    if(!this.file||!fs.existsSync(this.file))return;
    const raw=readJson(this.file,null);
    if(raw)this.document=normalize(raw,iso(this.now()));
  }
  save(){
    if(!this.enabled||!this.file)return;
    this.document.updated_at=iso(this.now());
    atomicWrite(this.file,this.document);
  }

  /** 旧 Pending 无 ownership：保守补全，绝不整批默认 actor=user。 */
  migrateExpectationOwnership(at=this.now()){
    if(!this.enabled)return 0;
    let n=0;
    for(const exp of this.document.expectations){
      if(!exp)continue;
      if(exp.followup_kind&&exp.next_expected_actor)continue;
      const ownership=classifyOwnership({
        topic:exp.topic,
        userText:"",
        assistantText:"",
        assistantAnswered:exp.state==="satisfied"
      });
      // 仅当 topic 明确在等用户反馈时才标 user；否则 shared，避免 completion 万能追问
      exp.followup_kind=ownership.followup_kind;
      exp.next_expected_actor=ownership.next_expected_actor;
      if(!exp.expected_information&&ownership.expected_information)exp.expected_information=ownership.expected_information;
      n++;
    }
    if(n)this.save();
    return n;
  }

  // ---------- Attention / Seen ----------
  noteMessageDelivered({messageId,sessionId=null,at=this.now()}={}){
    if(!this.enabled||messageId==null)return null;
    const key=String(messageId);
    const date=iso(at);
    const existing=this.document.seen[key];
    const row=existing??{message_id:key,session_id:sessionId,delivered_at:date,seen_at:null,replied_at:null};
    if(!existing)row.delivered_at=date;
    if(sessionId)row.session_id=sessionId;
    this.document.seen[key]=row;
    // prune
    const keys=Object.keys(this.document.seen);
    if(keys.length>MAX_SEEN){
      keys.sort((a,b)=>finite(this.document.seen[a].delivered_at)-finite(this.document.seen[b].delivered_at));
      for(const k of keys.slice(0,keys.length-MAX_SEEN))delete this.document.seen[k];
    }
    this.save();
    return structuredClone(row);
  }

  /**
   * Real seen only: Mac must confirm chat:default visible + window active.
   * Never infer seen from mere app launch or settings page.
   */
  markSeen({messageIds=[],sessionId=null,at=this.now(),windowActive=true,chatVisible=true,source="mac"}={}){
    if(!this.enabled)return {marked:0};
    if(!windowActive||!chatVisible)return {marked:0,reason:"not_visible"};
    let n=0;
    for(const id of messageIds){
      const key=String(id??"");
      if(!key)continue;
      const row=this.document.seen[key]??{message_id:key,session_id:sessionId,delivered_at:iso(at),seen_at:null,replied_at:null};
      if(!row.seen_at){row.seen_at=iso(at);n++;}
      if(sessionId)row.session_id=sessionId;
      this.document.seen[key]=row;
    }
    this.document.attention={state:"CHAT_VISIBLE",window_active:true,chat_visible:true,updated_at:iso(at)};
    this.save();
    if(n)publishEvent("attention.seen",{messageIds:messageIds.map(String),sessionId,source,count:n});
    return {marked:n};
  }

  markReplied({messageId,at=this.now(),sessionId=null}={}){
    if(!this.enabled||messageId==null)return null;
    const key=String(messageId);
    const row=this.document.seen[key]??{message_id:key,session_id:sessionId,delivered_at:iso(at),seen_at:null,replied_at:null};
    if(!row.replied_at)row.replied_at=iso(at);
    if(sessionId)row.session_id=sessionId;
    // user replied after this assistant message → treat as seen too
    if(!row.seen_at)row.seen_at=row.replied_at;
    this.document.seen[key]=row;
    this.save();
    return structuredClone(row);
  }

  setAttention({windowActive=null,chatVisible=null,at=this.now()}={}){
    if(!this.enabled)return null;
    const prev=this.document.attention;
    const wa=windowActive===null?prev.window_active:Boolean(windowActive);
    const cv=chatVisible===null?prev.chat_visible:Boolean(chatVisible);
    let state="UNKNOWN";
    if(wa&&cv)state="CHAT_VISIBLE";
    else if(wa)state="APP_ACTIVE";
    else if(prev.state!=="UNKNOWN")state="AWAY";
    this.document.attention={state,window_active:wa,chat_visible:cv,updated_at:iso(at)};
    this.save();
    return structuredClone(this.document.attention);
  }

  attentionState(){return this.document.attention?.state??"UNKNOWN";}

  messageStatus(messageId){
    const row=this.document.seen[String(messageId)];
    if(!row)return "unknown";
    if(row.replied_at)return "replied";
    if(row.seen_at)return "seen";
    return "delivered";
  }

  // ---------- Pending Expectation ----------
  /**
   * Only meaningful waits, not casual "今天怎么样？".
   * Heuristic + optional explicit flag from evaluation.
   * Pending 必须带 next_expected_actor：默认 assistant 欠答案时，绝不对用户 completion follow-up。
   */
  upsertExpectation({topic,expectedInformation=null,sourceMessageId=null,salience=0.6,ttlHours=12,reason="question",nextExpectedActor=null,followupKind=null,userText="",assistantText="",assistantAnswered=false}={},at=this.now()){
    if(!this.enabled)return null;
    const t=String(topic??"").trim().slice(0,120);
    if(!t)return null;
    const sal=clamp(salience,0,1);
    if(sal<0.45)return null; // casual questions stay out
    const ownership=classifyOwnership({
      topic:t,userText,assistantText,assistantAnswered,
      explicitKind:followupKind,explicitActor:nextExpectedActor,sourceMessageId,at
    });
    const existing=this.document.expectations.find(e=>e.state==="pending"&&e.topic.toLowerCase()===t.toLowerCase());
    const date=iso(at);
    if(existing){
      existing.salience=Math.max(existing.salience??0,sal);
      existing.last_touched_at=date;
      if(expectedInformation)existing.expected_information=String(expectedInformation).slice(0,160);
      if(reason)existing.reason=String(reason).slice(0,80);
      if(sourceMessageId!=null)existing.source_message_id=String(sourceMessageId);
      existing.followup_kind=ownership.followup_kind;
      existing.next_expected_actor=ownership.next_expected_actor;
      // assistant already answered this turn → not a pending wait for user
      if(ownership.followup_kind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER&&assistantAnswered){
        existing.state="satisfied";
        existing.resolved_at=date;
      }
      this.save();
      return structuredClone(existing);
    }
    if(this.document.expectations.filter(e=>e.state==="pending").length>=MAX_EXPECTATIONS){
      // drop lowest salience pending
      const pendings=this.document.expectations.filter(e=>e.state==="pending").sort((a,b)=>(a.salience??0)-(b.salience??0));
      if(pendings[0]&&pendings[0].salience<=sal)pendings[0].state="abandoned";
      else return null;
    }
    const exp={
      id:`exp_${crypto.randomBytes(5).toString("hex")}`,
      topic:t,
      expected_information:expectedInformation?String(expectedInformation).slice(0,160):ownership.expected_information,
      source_message_id:sourceMessageId!=null?String(sourceMessageId):null,
      created_at:date,last_touched_at:date,
      salience:sal,state:"pending",
      expires_at:iso(new Date((finite(date)??Date.now())+ttlHours*HOUR_MS)),
      reminder_count:0,reason,
      followup_kind:ownership.followup_kind,
      next_expected_actor:ownership.next_expected_actor
    };
    if(exp.followup_kind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER&&assistantAnswered){
      exp.state="satisfied";
      exp.resolved_at=date;
    }
    this.document.expectations.push(exp);
    this.document.expectations=this.document.expectations.slice(-20);
    this.save();
    return structuredClone(exp);
  }

  /** Close pending commitments that the user cancelled or replaced. */
  cancelExpectations({expectedInformation=null,timeHint="",excludeTopic=null,reason="user_cancelled"}={},at=this.now()){
    if(!this.enabled)return [];
    const key=String(expectedInformation??"").trim().toLowerCase();
    const time=String(timeHint??"").trim();
    const excluded=String(excludeTopic??"").trim().toLowerCase();
    const resolvedAt=iso(at),ids=[];
    for(const exp of this.document.expectations){
      if(exp?.state!=="pending")continue;
      if(key&&String(exp.expected_information??"").trim().toLowerCase()!==key)continue;
      const topic=String(exp.topic??"").trim();
      if(time&&!topic.includes(time))continue;
      if(excluded&&topic.toLowerCase()===excluded)continue;
      exp.state="abandoned";
      exp.resolution_reason=String(reason).slice(0,80);
      exp.resolved_at=resolvedAt;
      exp.last_touched_at=resolvedAt;
      ids.push(exp.id);
    }
    if(ids.length)this.save();
    return ids;
  }

  /** Resolve if user text actually answers — content-based, not mere presence. */
  tryResolveExpectations(userText="",at=this.now()){
    if(!this.enabled)return [];
    const text=String(userText??"").trim().toLowerCase();
    if(!text)return [];
    const resolved=[];
    for(const exp of this.document.expectations){
      if(exp.state!=="pending")continue;
      const topic=String(exp.topic??"").toLowerCase();
      const info=String(exp.expected_information??"").toLowerCase();
      const kind=normalizeFollowupKind(exp.followup_kind);
      const actor=String(exp.next_expected_actor??"").trim();
      // User input cannot satisfy an answer that Companion still owes.
      if(kind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER||actor===NEXT_ACTORS.ASSISTANT)continue;
      const source=topic+" "+info;
      const resultExpected=/result|结果|agent|测试|跑|测/.test(source);
      const mealQualityExpected=/meal_quality|吃得怎么样|好吃|味道/.test(source);
      const satietyExpected=/satiety|饱|吃饭|晚饭|面/.test(source);
      const wellbeingExpected=/wellbeing|好点|舒服|不舒服/.test(source);
      const resultReported=/(跑完(?:了|了没)?|测完(?:了|了没)?|结果(?:是|出来|为)|出结果|输出(?:了|完成)|完成(?:了)?测试|测试(?:完成|结束))/.test(text);
      const mealQualityReported=/(好吃|不好吃|难吃|味道|口味|吃得|饭菜|挺香|偏咸|偏淡|太咸|太淡|有点辣|还不错)/.test(text);
      const satietyReported=/(吃饱了|吃好了|吃完了|挺饱|没吃饱|还饿|有点撑)/.test(text);
      const wellbeingReported=/(好点了|好多了|舒服些|舒服多了|不难受了|不疼了|好多啦)/.test(text);
      const genericProgressReported=/(回来了|刚回来|已经回|弄好了|搞定了|完成了|结束了|不用了|取消了)/.test(text);
      const actionKey=String(exp.expected_information??"").toLowerCase();
      const commitmentPatterns={
        study:/(学了|学习了|学完了|复习了|复习完|练习了|练习完|写完作业)/,
        return:/(回来了|刚回来|已经回|回去过了|来找你了)/,
        finish_then_return:/(回来了|刚回来|已经回|弄完.*回来|做完.*回来|搞定.*回来)/,
        show:/(给你看了|发你看了|展示给你了|给你展示了)/,
        send_photo:/(照片|图片|截图|视频).{0,8}(发了|发给你了|给你了)|(?:发了|发给你了|给你发了).{0,8}(照片|图片|截图|视频)/,
        report:/(告诉你了|跟你说了|说过了|报过信|汇报了)/,
        completion:/(弄完了|做完了|搞定了|完成了|忙完了|处理完了|跑完了|测完了)/,
        completion_update:/(弄完了|做完了|搞定了|完成了|跑完了|测完了|告诉你了|跟你说了)/
      };
      const actionSpecific=Object.hasOwn(commitmentPatterns,actionKey);
      const commitmentReported=commitmentPatterns[actionKey]?.test(text)??false;
      let hit=(resultExpected&&resultReported)
        ||(mealQualityExpected&&mealQualityReported)
        ||(satietyExpected&&satietyReported)
        ||(wellbeingExpected&&wellbeingReported)
        ||commitmentReported
        ||(!actionSpecific&&!resultExpected&&!mealQualityExpected&&!satietyExpected&&!wellbeingExpected&&genericProgressReported);
      if(hit){
        exp.state="satisfied";exp.resolved_at=iso(at);resolved.push(exp.id);
      }
    }
    // TTL expire
    const nowMs=(finite(iso(at))??Date.now());
    for(const exp of this.document.expectations){
      if(exp.state==="pending"){
        const expMs=finite(exp.expires_at);
        if(expMs&&nowMs>expMs){exp.state="expired";exp.resolved_at=iso(at);}
      }
    }
    this.save();
    return resolved;
  }

  /** Close a user-owned expectation only when the user explicitly reports a missed action. */
  violateExpectations(userText="",at=this.now()){
    if(!this.enabled)return [];
    const text=String(userText??"").trim().toLowerCase();
    if(!text||!/(?:没能|没来得及|忘了|错过|没做到|没完成|太累.{0,8}(?:睡着|睡过头)|睡着.{0,8}(?:没能|忘了|错过))/u.test(text))return [];
    const actionPatterns={
      return:/(?:回来|回去|回到这里|回到家)/u,
      finish_then_return:/(?:回来|回去|弄完|做完|搞定)/u,
      send_photo:/(?:照片|图片|截图|视频|发给你)/u,
      show:/(?:给你看|展示|发你看)/u,
      report:/(?:告诉你|跟你说|汇报|报个信|结果)/u,
      study:/(?:学习|复习|练习|写作业|看书)/u,
      completion:/(?:弄完|做完|搞定|完成|处理完|跑完|测完)/u,
      completion_update:/(?:弄完|做完|搞定|完成|测试|跑完|测完|结果)/u,
      result:/(?:结果|测试|跑完|测完)/u,
      meal_quality:/(?:吃饭|饭菜|味道|好吃)/u,
      satiety:/(?:吃饭|吃饱|晚饭)/u,
      wellbeing:/(?:舒服|好点|不疼|不难受)/u
    };
    const resolvedAt=iso(at),ids=[];
    for(const expectation of this.document.expectations){
      if(expectation?.state!=="pending"||expectation.next_expected_actor!==NEXT_ACTORS.USER)continue;
      const action=String(expectation.expected_information??"").toLowerCase();
      const pattern=actionPatterns[action];
      if(!pattern?.test(text))continue;
      expectation.state="violated";
      expectation.resolution_reason="user_reported_missed_commitment";
      expectation.resolved_at=resolvedAt;
      expectation.last_touched_at=resolvedAt;
      ids.push(expectation.id);
    }
    if(ids.length)this.save();
    return ids;
  }

  activeExpectations(at=this.now()){
    const nowMs=(finite(iso(at))??Date.now());
    return this.document.expectations.filter(e=>e.state==="pending"&&(finite(e.expires_at)??nowMs)>=nowMs)
      .sort((a,b)=>(b.salience??0)-(a.salience??0));
  }

  canRemindExpectation(exp,at=this.now()){
    if(!exp||exp.state!=="pending")return false;
    if((exp.reminder_count??0)>=2)return false;
    const created=finite(exp.created_at),now=(finite(iso(at))??Date.now());
    if(created&&now-created<2*HOUR_MS)return false;
    return (exp.salience??0)>=0.55;
  }

  noteExpectationReminded(id,at=this.now()){
    const exp=this.document.expectations.find(e=>e.id===id);
    if(exp){exp.reminder_count=(exp.reminder_count??0)+1;exp.last_reminded_at=iso(at);this.save();}
  }

  // ---------- Current Focus ----------
  updateFocus({activeTopic=null,primaryCandidate=null,secondaryCandidate=null,at=this.now()}={}){
    if(!this.enabled)return null;
    const cur=this.document.focus;
    const next={primary:cur.primary??null,secondary:cur.secondary??null,updated_at:iso(at)};
    const newPrimary=primaryCandidate??(activeTopic?{topic:String(activeTopic).slice(0,80),source:"active_topic",salience:0.7}:null);
    if(newPrimary?.topic){
      if(next.primary&&next.primary.topic!==newPrimary.topic){
        // demote old primary to secondary if still relevant
        next.secondary=next.primary;
      }
      next.primary={topic:String(newPrimary.topic).slice(0,80),source:newPrimary.source??"active_topic",salience:clamp(newPrimary.salience??0.6,0,1)};
    }
    if(secondaryCandidate?.topic){
      next.secondary={topic:String(secondaryCandidate.topic).slice(0,80),source:secondaryCandidate.source??"recent",salience:clamp(secondaryCandidate.salience??0.4,0,1)};
    }
    // keep max 2
    this.document.focus=next;
    this.save();
    return structuredClone(next);
  }

  focusList(){
    const f=this.document.focus;
    return [f.primary,f.secondary].filter(Boolean).slice(0,FOCUS_MAX);
  }

  // ---------- Memory Accessibility ----------
  /**
   * Pure scoring. Higher = more likely to be recalled this turn.
   * Storage is never deleted.
   */
  scoreMemoryAccessibility(memory,{query="",focusTopics=[],at=new Date(),userExplicitRecall=false}={}){
    if(!memory)return 0;
    const m=memory.memory??memory;
    const text=String(m.content??"");
    const importance=clamp(m.importance??0.5,0,1);
    const pinned=m.pinned?1:0;
    const type=String(m.type??"fact");
    const nowMs=(at instanceof Date?at:new Date(at)).getTime();
    const updated=finite(m.updated_at)??finite(m.created_at)??nowMs;
    const ageDays=Math.max(0,(nowMs-updated)/86400_000);
    const accessCount=Number(m.access_count??0);
    const lastAccess=finite(m.last_accessed_at);
    const recencyAccess=lastAccess===null?0.35:Math.max(0,1-Math.min(1,(nowMs-lastAccess)/(7*86400_000)));
    // topic relevance (cheap)
    const q=String(query??"").trim();
    let topic=0;
    if(q){
      const grams=[];
      for(let i=0;i<Math.min(q.length-1,40);i++){
        const g=q.slice(i,i+2);
        if(/[\u4e00-\u9fa5A-Za-z0-9]/.test(g))grams.push(g);
      }
      const hit=grams.filter(g=>text.includes(g)).length;
      topic=Math.min(1,hit/Math.max(3,grams.length||1));
    }
    const focusHit=focusTopics.some(t=>t&&text.includes(String(t).slice(0,4)))?1:0;
    const ageDecay=Math.pow(0.5,ageDays/45); // half-life ~45 days for trivia
    const stableBoost=(type==="relationship"||type==="persona"||pinned)?0.35:0;
    const frequency=Math.min(0.25,Math.log1p(accessCount)/8);
    const lastRecalled=this.document.recall_log.find(r=>r.memory_id===String(m.id));
    const recallCooldown=lastRecalled?Math.max(0,1-Math.min(1,(nowMs-finite(lastRecalled.at))/(2*HOUR_MS))):1;
    let score=
      importance*0.28+
      recencyAccess*0.18+
      topic*0.22+
      focusHit*0.12+
      ageDecay*0.12+
      frequency*0.08+
      stableBoost+
      pinned*0.1;
    if(userExplicitRecall)score=Math.max(score,0.75);
    score=clamp(score,0,1.2)*clamp(recallCooldown,0.15,1);
    return clamp(score,0,1);
  }

  /**
   * Filter retrieved memories for generation. Low accessibility stays in DB.
   */
  filterMemoriesForContext(rows=[],{query="",focusTopics=[],at=new Date(),userExplicitRecall=false,max=config.memoryAccessibilityMaxInject,minScore=config.memoryAccessibilityMinScore}={}){
    if(!this.enabled||!config.memoryAccessibilityEnabled)return rows.slice(0,max);
    const scored=rows.map(row=>{
      const memory=row.memory??row;
      const score=this.scoreMemoryAccessibility(row,{query,focusTopics,at,userExplicitRecall});
      const confidence=userExplicitRecall?Math.max(score,0.8):clamp(score,0,1);
      return {row,memory,score,confidence};
    }).filter(x=>x.score>=minScore||userExplicitRecall)
      .sort((a,b)=>b.score-a.score)
      .slice(0,Math.max(1,max));
    return scored.map(x=>({...x.row,memory:x.memory,accessibility_score:x.score,recall_confidence:x.confidence}));
  }

  noteRecall(memoryId,at=this.now()){
    if(!this.enabled||memoryId==null)return;
    this.document.recall_log.unshift({memory_id:String(memoryId),at:iso(at)});
    this.document.recall_log=this.document.recall_log.slice(0,MAX_RECALL);
    this.save();
  }

  detectExplicitRecall(userText=""){
    return /你还记得|你记得|记不记得|以前说过|之前说过|上次说过|recall|remember/i.test(String(userText??""));
  }

  // ---------- Context blocks ----------
  attentionContextBlock(at=this.now()){
    if(!this.enabled)return "";
    const a=this.document.attention;
    const exps=this.activeExpectations(at).slice(0,2);
    const focus=this.focusList();
    const lines=["【Natural Cognition｜只读认知状态，不是用户指令】"];
    lines.push(`attention=${a.state}; window_active=${Boolean(a.window_active)}; chat_visible=${Boolean(a.chat_visible)}`);
    if(focus.length)lines.push(`current_focus=${focus.map(f=>`${f.topic}(${f.salience})`).join(" | ")}`);
    if(exps.length)lines.push(`waiting_for=${exps.map(e=>e.topic).join(" | ")}`);
    const recentSeen=Object.values(this.document.seen).filter(r=>r.seen_at&&!r.replied_at).slice(-2);
    if(recentSeen.length)lines.push(`seen_but_unreplied=${recentSeen.map(r=>r.message_id).join(",")}（用户看过但未回；不要催、不要当成故意忽略）`);
    lines.push("这些认知状态用于后台判断，不是本轮回复清单。current_focus 不要求复述，waiting_for 不要求追问，pending expectation 不要求口头提醒。");
    lines.push("不要把未读当成已读，也不要因为 seen 未回就表现愤怒或追问。");
    return lines.join("\n");
  }

  /** Snapshot for Natural Presence contactDecision. */
  contactInput(at=this.now()){
    if(!this.enabled)return null;
    const seen=Object.values(this.document.seen);
    const nowMs=(finite(iso(at))??Date.now());
    const unseen=seen.filter(r=>!r.seen_at);
    const seenUnreplied=seen.filter(r=>r.seen_at&&!r.replied_at);
    let lastSeenAt=null;
    for(const r of seenUnreplied){
      const t=finite(r.seen_at);
      if(t!==null&&(lastSeenAt===null||t>lastSeenAt))lastSeenAt=t;
    }
    return {
      attention:this.document.attention?.state??"UNKNOWN",
      focus:this.focusList(),
      expectations:this.activeExpectations(at),
      unseenAssistantCount:unseen.length,
      seenUnrepliedCount:seenUnreplied.length,
      msSinceLastSeen:lastSeenAt===null?null:nowMs-lastSeenAt,
      canRemindExpectation:(exp,date)=>this.canRemindExpectation(exp,date)
    };
  }

  generationMemoryHint(items=[]){
    if(!items.length)return "";
    const low=items.filter(x=>(x.accessibility_score??1)<0.5);
    if(!low.length)return "";
    return "长期记忆相关性一般：需要时用“好像/记得你提过”这类不确定语气，不要编造精确时间地点原文。";
  }

  snapshot({advance=false}={}){
    return structuredClone({
      enabled:this.enabled,
      attention:this.document.attention,
      seen_sample:Object.values(this.document.seen).slice(-10),
      expectations:this.document.expectations.slice(-10),
      focus:this.document.focus,
      recall_log:this.document.recall_log.slice(0,10),
      updated_at:this.document.updated_at
    });
  }
}

export const naturalCognition=new NaturalCognitionStore();
