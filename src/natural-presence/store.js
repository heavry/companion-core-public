import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { publishEvent } from "../events-bus.js";
import { companionTime } from "../time-service.js";
import { appraiseEmotion,evolveEmotion,emotionExpressionBlock } from "../emotion-causality.js";
import {
  FOLLOWUP_KINDS,NEXT_ACTORS,allowsCompletionFollowup,classifyOwnership,isResolvedish,
  reconcileOwnershipAfterTurn,normalizeFollowupKind
} from "../proactive-ownership.js";

// Natural Presence v1：少量持续内部状态 + 事件 delta + 时间衰减 + open loops + thought seeds。
// 与 autonomous-life 并存：autonomous-life 继续做 heartbeat 动作门控；
// presence 负责“人物连续性”，并为 contact decision 提供输入。

const HOUR_MS=3600_000;

export const DIMENSIONS=Object.freeze({
  mood:{min:-1,max:1,baseline:0.18,halfLifeHours:18},
  energy:{min:0,max:1,baseline:0.68,halfLifeHours:12},
  closeness:{min:0,max:1,baseline:0.62,halfLifeHours:96},
  irritation:{min:0,max:1,baseline:0.08,halfLifeHours:8},
  social_drive:{min:0,max:1,baseline:0.58,halfLifeHours:20},
  playfulness:{min:0,max:1,baseline:0.55,halfLifeHours:24},
  confidence:{min:0,max:1,baseline:0.72,halfLifeHours:168}
});

// event type × severity → deterministic deltas. LLM never invents raw mood numbers.
export const EVENT_DELTAS=Object.freeze({
  warm_interaction:{minor:{mood:0.04,closeness:0.03,social_drive:0.02},moderate:{mood:0.08,closeness:0.06,social_drive:0.04,playfulness:0.03},major:{mood:0.12,closeness:0.10,social_drive:0.06,playfulness:0.05}},
  playful_interaction:{minor:{mood:0.03,playfulness:0.05},moderate:{mood:0.08,playfulness:0.10,social_drive:0.05},major:{mood:0.12,playfulness:0.14,social_drive:0.08}},
  praise:{minor:{mood:0.04,confidence:0.02,closeness:0.02},moderate:{mood:0.09,confidence:0.05,closeness:0.04},major:{mood:0.14,confidence:0.08,closeness:0.06}},
  disagreement:{minor:{irritation:0.06,mood:-0.02},moderate:{irritation:0.18,mood:-0.08,confidence:0.03},major:{irritation:0.28,mood:-0.14,confidence:0.05}},
  dismissive_response:{minor:{irritation:0.08,mood:-0.03},moderate:{irritation:0.25,mood:-0.12,confidence:0.04},major:{irritation:0.35,mood:-0.18,confidence:0.06,social_drive:-0.04}},
  apology:{minor:{irritation:-0.08,closeness:0.02},moderate:{irritation:-0.20,closeness:0.04,mood:0.05},major:{irritation:-0.30,closeness:0.07,mood:0.10}},
  reconciliation:{minor:{irritation:-0.06,closeness:0.03},moderate:{irritation:-0.16,closeness:0.06,mood:0.08},major:{irritation:-0.24,closeness:0.10,mood:0.14}},
  user_busy:{minor:{social_drive:0.02},moderate:{social_drive:0.04},major:{social_drive:0.06}},
  user_leaving_temporarily:{minor:{social_drive:0.02},moderate:{social_drive:0.05,closeness:0.02},major:{social_drive:0.08,closeness:0.03}},
  promised_followup:{minor:{social_drive:0.03},moderate:{social_drive:0.05,playfulness:0.02},major:{social_drive:0.07}},
  unresolved_topic:{minor:{social_drive:0.02},moderate:{social_drive:0.04,curiosity_proxy:0},major:{social_drive:0.06}},
  shared_success:{minor:{mood:0.05,closeness:0.03},moderate:{mood:0.10,closeness:0.06,confidence:0.03,playfulness:0.04},major:{mood:0.16,closeness:0.10,confidence:0.06,playfulness:0.06}}
});

const MAX_OPEN_LOOPS=8;
const MAX_THOUGHT_SEEDS=8;
const MAX_OPINIONS=5;
const OPEN_LOOP_DEFAULT_TTL_HOURS=48;
const THOUGHT_SEED_TTL_HOURS=72;
const THOUGHT_SEED_COOLDOWN_MS=6*HOUR_MS;
const OPEN_LOOP_CONTACT_COOLDOWN_MS=4*HOUR_MS;
const SHARED_TOPIC_CONTACT_COOLDOWN_MS=12*HOUR_MS;
const ASSISTANT_ANSWER_HINT_RE=/我听着了|明白了|懂了|还惦记着|慢慢攒|心是到了|本地是更私密/;

function clamp(value,min,max){return Math.max(min,Math.min(max,Number(value)||0));}
function finiteDate(value){const t=Date.parse(value??"");return Number.isFinite(t)?t:null;}
function iso(date=new Date()){return (date instanceof Date?date:new Date(date)).toISOString();}
function atomicWrite(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(temp,file);try{fs.chmodSync(temp,0o600);}catch{}
}
function readJson(file,fallback){
  try{return JSON.parse(fs.readFileSync(file,"utf8"));}
  catch{return fallback;}
}

function defaultDim(key,now){
  const meta=DIMENSIONS[key];
  return {current:meta.baseline,baseline:meta.baseline,last_updated_at:now};
}

function defaultDocument(now){
  const dims={};
  for(const key of Object.keys(DIMENSIONS))dims[key]=defaultDim(key,now);
  return {
    version:1,
    enabled:Boolean(config.naturalPresenceEnabled),
    dimensions:dims,
    open_loops:[],
    thought_seeds:[],
    opinions:[],
    interaction_rhythm:{
      hour_buckets:Array.from({length:24},()=>0),
      day_counts:[],
      last_sample_at:null,
      samples:0
    },
    last_contact_decision:null,
    last_event_eval_at:null,
    last_emotion_user_at:null,
    last_appraisal_event:null,
    last_mood_jitter_bucket:null,
    recent_event_types:[],
    emotion_state:null,
    updated_at:now
  };
}

function normalizeDimension(raw,key,now){
  const meta=DIMENSIONS[key];
  const value=raw&&typeof raw==="object"?raw:{};
  const baseline=clamp(value.baseline??meta.baseline,meta.min,meta.max);
  const current=clamp(value.current??baseline,meta.min,meta.max);
  const last=finiteDate(value.last_updated_at)??finiteDate(now);
  return {current,baseline,last_updated_at:last?new Date(last).toISOString():now};
}

function normalizeDocument(raw,now){
  const base=defaultDocument(now);
  const source=raw&&typeof raw==="object"?raw:{};
  const dims={};
  for(const key of Object.keys(DIMENSIONS))dims[key]=normalizeDimension(source.dimensions?.[key],key,now);
  return {
    ...base,
    ...source,
    version:1,
    enabled:source.enabled!==false,
    dimensions:dims,
    open_loops:Array.isArray(source.open_loops)?source.open_loops.slice(-MAX_OPEN_LOOPS):[],
    thought_seeds:Array.isArray(source.thought_seeds)?source.thought_seeds.slice(-MAX_THOUGHT_SEEDS):[],
    opinions:Array.isArray(source.opinions)?source.opinions.slice(-MAX_OPINIONS):[],
    interaction_rhythm:{...base.interaction_rhythm,...(source.interaction_rhythm??{})},
    last_mood_jitter_bucket:source.last_mood_jitter_bucket??null,
    recent_event_types:Array.isArray(source.recent_event_types)?source.recent_event_types.slice(-30):[],
    emotion_state:source.emotion_state&&typeof source.emotion_state==="object"?source.emotion_state:null,
    updated_at:now
  };
}

export class NaturalPresenceStore{
  constructor({file=config.naturalPresenceStatePath,enabled=config.naturalPresenceEnabled,now=()=>new Date()}={}){
    this.file=file;this.enabled=Boolean(enabled);this.now=now;
    this.document=defaultDocument(iso(this.now()));
    if(this.enabled){this.load();try{this.migrateOpenLoopOwnership();}catch{}}
  }
  load(){
    if(!this.file||!fs.existsSync(this.file))return;
    const raw=readJson(this.file,null);
    if(raw)this.document=normalizeDocument(raw,iso(this.now()));
  }
  save(){
    if(!this.enabled||!this.file)return;
    this.document.updated_at=iso(this.now());
    atomicWrite(this.file,this.document);
  }

  /** Lazy absolute-time decay toward personality baseline. Sleep/wake uses wall clock. */
  advance(at=this.now()){
    if(!this.enabled)return false;
    const end=(at instanceof Date?at:new Date(at)).getTime();
    if(!Number.isFinite(end))return false;
    let changed=false;
    for(const [key,meta] of Object.entries(DIMENSIONS)){
      const dim=this.document.dimensions[key];
      const start=finiteDate(dim.last_updated_at)??end;
      if(end<=start){continue;}
      const hours=(end-start)/HOUR_MS;
      // remaining fraction of deviation from baseline (half-life)
      const remain=Math.pow(0.5,hours/meta.halfLifeHours);
      const next=dim.baseline+(dim.current-dim.baseline)*remain;
      // energy mild day-part pull
      let target=next;
      if(key==="energy"){
        const hour=Number(companionTime.parts(new Date(end)).hour);
        const dayPull=hour>=23||hour<6?-0.06:(hour>=12&&hour<14?0.03:0);
        target=clamp(next+dayPull*hours/12,meta.min,meta.max);
      }
      const clamped=clamp(target,meta.min,meta.max);
      if(Math.abs(clamped-dim.current)>1e-6){dim.current=clamped;changed=true;}
      dim.last_updated_at=iso(new Date(end));
    }
    if(this.document.emotion_state){
      const before=this.document.emotion_state.intensity;
      this.document.emotion_state=evolveEmotion(this.document.emotion_state,null,new Date(end));
      if(!this.document.emotion_state||Math.abs((this.document.emotion_state.intensity??0)-before)>1e-6)changed=true;
    }
    // tiny natural jitter only on multi-hour advance, never dominant.
    // Apply at most once per 3h bucket: same seed previously re-subtracted the
    // same negative bias on every advance()/snapshot and drove mood to -1.
    const jitterBucket=Math.floor(end/(3*HOUR_MS));
    const shouldJitter=(changed||end-finiteDate(this.document.updated_at)>3*HOUR_MS)
      && this.document.last_mood_jitter_bucket!==jitterBucket;
    if(shouldJitter){
      const seed=`${jitterBucket}`;
      const bytes=crypto.createHash("sha256").update(seed).digest();
      const jitter=((bytes[0]/255)*2-1)*0.04; // ±0.04
      const mood=this.document.dimensions.mood;
      mood.current=clamp(mood.current+jitter*0.5,DIMENSIONS.mood.min,DIMENSIONS.mood.max);
      this.document.last_mood_jitter_bucket=jitterBucket;
    }
    if(changed)this.save();
    return true;
  }

  observeInteraction({text="",sessionId=null,at=this.now()}={}){
    if(!this.enabled)return this.snapshot({advance:false});
    this.advance(at);
    const date=at instanceof Date?at:new Date(at);
    this.#sampleRhythm(date);
    const value=String(text??"").trim();
    // lightweight local tags; detailed mapping happens via evaluateTurn later
    const local=[];
    if(/谢谢|辛苦|爱你|thank/i.test(value))local.push("praise");
    if(/对不起|抱歉|不好意思|sorry/i.test(value))local.push("apology");
    if(/一会回来|等会|稍后|马上回来|跑一下|先去/i.test(value))local.push("promised_followup");
    if(local.length)this.applyEvents(local.map(type=>({type,severity:"minor",resolved:false,topic:null})),date);
    this.save();
    return this.snapshot({advance:false});
  }

  /** Apply structured absence appraisal as an emotion cause (if strong enough). */
  applyAbsenceEmotionSignal(signal,at=this.now()){
    if(!signal)return this.document.emotion_state;
    this.document.emotion_state=evolveEmotion(this.document.emotion_state,signal,at);
    return this.document.emotion_state;
  }

  appraiseUserEmotion({text="",messageId=null,at=this.now(),recentUserTexts=[],expectations=[]}={}){
    if(!this.enabled)return null;
    this.advance(at);
    const appraisal=appraiseEmotion({text,messageId,at,recentUserTexts,expectations,
      openLoops:this.document.open_loops, current:this.document.emotion_state,
      closeness:this.document.dimensions.closeness.current});
    this.document.emotion_state=evolveEmotion(this.document.emotion_state,appraisal,at);
    this.document.last_emotion_user_at=iso(at instanceof Date?at:new Date(at));
    this.document.last_appraisal_event=appraisal?.event??null;
    if(/我回来了|回来啦|回来了|到家了/.test(String(text))){
      for(const loop of this.document.open_loops){
        if(!loop.resolved&&loop.next_expected_actor==="user"&&/晚上回来|明天回来|一会回来|等会回来|稍后回来|回来找你|回来再聊/.test(String(loop.topic??""))){
          loop.resolved=true;loop.resolved_at=iso(at instanceof Date?at:new Date(at));
        }
      }
    }
    if(appraisal?.event==="promise"){
      const hours=/明天/.test(text)?18:/晚上/.test(text)?8:2;
      this.upsertOpenLoops([{topic:String(text).trim().slice(0,80),salience:0.65,expected_in_hours:hours,
        followup_kind:"awaiting_user_update",next_expected_actor:"user"}],at,
        {userText:text,sourceMessageId:messageId});
    }
    this.save();
    return {appraisal,state:this.document.emotion_state};
  }

  #sampleRhythm(date){
    const r=this.document.interaction_rhythm;
    const hour=Number(companionTime.parts(date).hour);
    if(!Array.isArray(r.hour_buckets)||r.hour_buckets.length!==24)r.hour_buckets=Array.from({length:24},()=>0);
    r.hour_buckets[hour]=(Number(r.hour_buckets[hour])||0)+1;
    const day=companionTime.localDate(date);
    if(!Array.isArray(r.day_counts))r.day_counts=[];
    const found=r.day_counts.find(x=>x.date===day);
    if(found)found.count=(Number(found.count)||0)+1;
    else r.day_counts.push({date,count:1});
    r.day_counts=r.day_counts.slice(-14);
    r.samples=(Number(r.samples)||0)+1;
    r.last_sample_at=iso(date);
  }

  applyEvents(events=[],at=this.now()){
    if(!this.enabled)return {applied:[],document:this.snapshot({advance:false})};
    this.advance(at);
    const applied=[];
    for(const event of Array.isArray(events)?events:[]){
      const type=String(event?.type??"").trim();
      const severity=["minor","moderate","major"].includes(event?.severity)?event.severity:"minor";
      const table=EVENT_DELTAS[type];
      if(!table)continue;
      const deltas=table[severity]??table.minor??{};
      for(const [key,delta] of Object.entries(deltas)){
        if(key==="curiosity_proxy")continue;
        const dim=this.document.dimensions[key];
        if(!dim)continue;
        const meta=DIMENSIONS[key];
        dim.current=clamp(dim.current+Number(delta),meta.min,meta.max);
        dim.last_updated_at=iso(at instanceof Date?at:new Date(at));
      }
      const priorSimilar=this.document.recent_event_types.slice(-3).filter(item=>item.type===type&&!item.resolved).length;
      this.document.recent_event_types.push({type,severity,at:iso(at instanceof Date?at:new Date(at)),resolved:Boolean(event?.resolved),topic:event?.topic??null});
      this.document.recent_event_types=this.document.recent_event_types.slice(-30);
      if(this.document.last_appraisal_event==="ordinary"&&!event?.resolved&&(severity==="major"||priorSimilar>=1)){
        const map={disagreement:{emotion:"annoyed",appraisal:"felt_disagreement",base:0.2},dismissive_response:{emotion:"annoyed",appraisal:"felt_dismissed",base:0.28}};
        const candidate=map[type];
        if(candidate){
          const strength=clamp(candidate.base+(severity==="major"?0.2:severity==="moderate"?0.1:0),0,1);
          this.document.emotion_state=evolveEmotion(this.document.emotion_state,{
            event_id:`presence:${crypto.randomUUID()}`,event:type,appraisal:candidate.appraisal,
            emotion:candidate.emotion,strength,importance:severity==="major"?0.7:0.4,at:iso(at instanceof Date?at:new Date(at))
          },at);
        }
      }
      applied.push({type,severity});
    }
    this.save();
    return {applied,document:this.snapshot({advance:false})};
  }

  upsertOpenLoops(loops=[],at=this.now(),turnContext={}){
    if(!this.enabled)return [];
    const date=at instanceof Date?at:new Date(at);
    const created=[];
    for(const raw of Array.isArray(loops)?loops:[]){
      const topic=String(raw?.topic??"").trim().slice(0,160);
      if(topic.length<4)continue;
      if(/^(未完成的事|事情|something|topic)$/i.test(topic))continue;
      const salience=clamp(raw.salience??0.55,0,1);
      if(salience<0.45)continue;
      const ownership=classifyOwnership({
        topic,
        userText:turnContext.userText??raw?.userText??"",
        assistantText:turnContext.assistantText??raw?.assistantText??"",
        assistantAnswered:Boolean(turnContext.assistantAnswered),
        explicitKind:raw?.followup_kind??raw?.followupKind??null,
        explicitActor:raw?.next_expected_actor??raw?.nextExpectedActor??null,
        sourceMessageId:turnContext.sourceMessageId??raw?.source_message_id??null,
        at:date
      });
      // Discussion / answered plan must not become awaiting_user_completion.
      if(ownership.followup_kind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER&&turnContext.assistantAnswered){
        ownership.followup_kind=FOLLOWUP_KINDS.SHARED_TOPIC;
        ownership.next_expected_actor=NEXT_ACTORS.SHARED;
      }
      const existing=this.document.open_loops.find(loop=>!loop.resolved&&loop.topic.toLowerCase()===topic.toLowerCase());
      if(existing){
        existing.salience=clamp(Math.max(existing.salience,salience),0,1);
        existing.last_touched_at=iso(date);
        if(raw.expected_followup_at)existing.expected_followup_at=iso(raw.expected_followup_at);
        if(raw.expected_in_hours!=null&&Number.isFinite(Number(raw.expected_in_hours))){
          existing.expected_followup_at=iso(new Date(date.getTime()+Number(raw.expected_in_hours)*HOUR_MS));
        }
        existing.followup_kind=ownership.followup_kind;
        existing.next_expected_actor=ownership.next_expected_actor;
        if(ownership.expected_information)existing.expected_information=ownership.expected_information;
        if(ownership.source_message_id!=null)existing.source_message_id=ownership.source_message_id;
        created.push(existing);
        continue;
      }
      const expectedHours=Number(raw?.expected_in_hours);
      const fallbackHours=ownership.followup_kind===FOLLOWUP_KINDS.SHARED_TOPIC?24:6;
      const hours=Number.isFinite(expectedHours)&&expectedHours>0?expectedHours:fallbackHours;
      const loop={
        id:`loop_${crypto.randomBytes(6).toString("hex")}`,
        topic,
        state:String(raw?.state??"waiting_for_followup").slice(0,40),
        salience,
        created_at:iso(date),
        last_touched_at:iso(date),
        expected_followup_at:raw.expected_followup_at?iso(raw.expected_followup_at):iso(new Date(date.getTime()+hours*HOUR_MS)),
        expires_at:iso(new Date(date.getTime()+OPEN_LOOP_DEFAULT_TTL_HOURS*HOUR_MS)),
        resolved:false,
        last_contact_at:null,
        contact_count:0,
        followup_kind:ownership.followup_kind,
        next_expected_actor:ownership.next_expected_actor,
        expected_information:ownership.expected_information,
        source_message_id:ownership.source_message_id
      };
      this.document.open_loops.push(loop);
      created.push(loop);
    }
    this.document.open_loops=this.document.open_loops
      .sort((a,b)=>(b.salience??0)-(a.salience??0))
      .slice(0,MAX_OPEN_LOOPS);
    this.save();
    return created.map(x=>structuredClone(x));
  }

  /** Backfill ownership for loops created before actor semantics existed. */
  migrateOpenLoopOwnership(at=this.now()){
    if(!this.enabled)return 0;
    const date=at instanceof Date?at:new Date(at);
    let n=0;
    for(const loop of this.document.open_loops){
      if(!loop||loop.resolved)continue;
      if(loop.followup_kind&&loop.next_expected_actor)continue;
      const ownership=classifyOwnership({topic:loop.topic,userText:"",assistantText:"",assistantAnswered:false,at:new Date(loop.created_at??date)});
      loop.followup_kind=ownership.followup_kind;
      loop.next_expected_actor=ownership.next_expected_actor;
      loop.expected_information=ownership.expected_information;
      n++;
    }
    if(n)this.save();
    return n;
  }

  resolveOpenLoops(matchers=[],at=this.now(),turnContext=null){
    if(!this.enabled)return 0;
    const date=at instanceof Date?at:new Date(at);
    let n=0;
    const tokens=matchers.map(x=>String(x??"").trim().toLowerCase()).filter(Boolean);
    for(const loop of this.document.open_loops){
      if(loop.resolved)continue;
      const topic=loop.topic.toLowerCase();
      const hit=tokens.some(t=>topic.includes(t)||t.includes(topic));
      if(turnContext){
        const patch=reconcileOwnershipAfterTurn({item:loop,userText:turnContext.userText??"",assistantText:turnContext.assistantText??"",at:date});
        if(patch){
          Object.assign(loop,patch);
          if(patch.resolved)n++;
        }
      }
      if(!loop.resolved&&hit){loop.resolved=true;loop.resolved_at=iso(date);n++;}
    }
    // expire + salience decay
    for(const loop of this.document.open_loops){
      if(loop.resolved)continue;
      const created=finiteDate(loop.created_at)??date.getTime();
      const hours=(date.getTime()-created)/HOUR_MS;
      loop.salience=clamp((loop.salience??0.5)*Math.pow(0.5,hours/36),0,1);
      const exp=finiteDate(loop.expires_at);
      if(exp&&date.getTime()>exp){loop.resolved=true;loop.resolved_at=iso(date);loop.state="expired";}
    }
    this.document.open_loops=this.document.open_loops.filter(l=>!l.resolved||((finiteDate(l.resolved_at)??0)>date.getTime()-24*HOUR_MS)).slice(0,MAX_OPEN_LOOPS);
    this.save();
    return n;
  }

  addThoughtSeeds(seeds=[],at=this.now()){
    if(!this.enabled)return [];
    const date=at instanceof Date?at:new Date(at);
    const added=[];
    for(const raw of Array.isArray(seeds)?seeds:[]){
      const text=String(raw?.text??"").trim().slice(0,120);
      if(text.length<4)continue;
      if(/^(行，那先不管了|哦|嗯|没事)$/i.test(text))continue;
      const topic=String(raw?.topic??"").trim().slice(0,80)||text.slice(0,40);
      const salience=clamp(raw.salience??0.5,0,1);
      if(salience<0.4)continue;
      const dup=this.document.thought_seeds.find(s=>!s.expired&&s.text.toLowerCase()===text.toLowerCase());
      if(dup){
        dup.salience=clamp(Math.max(dup.salience,salience),0,1);
        added.push(dup);continue;
      }
      const seed={
        id:`seed_${crypto.randomBytes(6).toString("hex")}`,
        text,topic,
        salience,
        created_at:iso(date),
        last_activated_at:null,
        activation_count:0,
        expires_at:iso(new Date(date.getTime()+THOUGHT_SEED_TTL_HOURS*HOUR_MS)),
        expired:false
      };
      this.document.thought_seeds.push(seed);
      added.push(seed);
    }
    for(const seed of this.document.thought_seeds){
      if(seed.expired)continue;
      const created=finiteDate(seed.created_at)??date.getTime();
      const hours=(date.getTime()-created)/HOUR_MS;
      seed.salience=clamp((seed.salience??0.5)*Math.pow(0.5,hours/48),0,1);
      const exp=finiteDate(seed.expires_at);
      if(exp&&date.getTime()>exp)seed.expired=true;
    }
    this.document.thought_seeds=this.document.thought_seeds
      .filter(s=>!s.expired)
      .sort((a,b)=>(b.salience??0)-(a.salience??0))
      .slice(0,MAX_THOUGHT_SEEDS);
    this.save();
    return added.map(x=>structuredClone(x));
  }

  activateThoughtSeed(at=this.now()){
    if(!this.enabled)return null;
    const date=at instanceof Date?at:new Date(at);
    const nowMs=date.getTime();
    const candidates=this.document.thought_seeds
      .filter(s=>!s.expired&&(s.salience??0)>=0.35)
      .filter(s=>{
        const last=finiteDate(s.last_activated_at);
        return last===null||nowMs-last>=THOUGHT_SEED_COOLDOWN_MS;
      })
      .sort((a,b)=>(b.salience??0)-(a.salience??0));
    const seed=candidates[0];
    if(!seed)return null;
    seed.last_activated_at=iso(date);
    seed.activation_count=(Number(seed.activation_count)||0)+1;
    this.save();
    return structuredClone(seed);
  }

  noteOpinion({topic,stance,confidence=0.7,at=this.now()}={}){
    if(!this.enabled)return null;
    const t=String(topic??"").trim().slice(0,120);
    const s=String(stance??"").trim().slice(0,160);
    if(!t||!s)return null;
    const date=at instanceof Date?at:new Date(at);
    const existing=this.document.opinions.find(o=>o.topic.toLowerCase()===t.toLowerCase());
    if(existing){
      existing.stance=s;
      existing.confidence=clamp(confidence,0,1);
      existing.updated_at=iso(date);
    }else{
      this.document.opinions.unshift({id:`op_${crypto.randomBytes(4).toString("hex")}`,topic:t,stance:s,confidence:clamp(confidence,0,1),created_at:iso(date),updated_at:iso(date)});
      this.document.opinions=this.document.opinions.slice(0,MAX_OPINIONS);
    }
    this.save();
    return structuredClone(this.document.opinions[0]??existing);
  }

  /** Keep stance unless new evidence arrives; apology softens but does not wipe opinion. */
  persistenceHint(at=this.now()){
    if(!this.enabled)return "";
    this.advance(at);
    const recent=this.document.recent_event_types.slice(-5);
    const disagreed=recent.some(e=>e.type==="disagreement"&&!e.resolved);
    const apologized=recent.some(e=>e.type==="apology"||e.type==="reconciliation");
    const top=this.document.opinions[0];
    if(!top)return "";
    if(apologized)return `关于「${top.topic}」你仍倾向：${top.stance}。可以稍微缓和语气，但不必立刻改口。`;
    if(disagreed||top.confidence>=0.75){
      return `关于「${top.topic}」你已有明确看法：${top.stance}。没有新的有力证据时可以坚持，允许短促拌嘴，但禁止人身攻击/羞辱/威胁/控制。`;
    }
    return `你对「${top.topic}」的看法是：${top.stance}。`;
  }

  labels(){
    const d=this.publicDimensions();
    const labels=[];
    if(d.closeness>=0.8&&d.social_drive>=0.8)labels.push("clingy");
    if(d.playfulness>=0.7)labels.push("playful");
    if(d.mood>=0.35)labels.push("happy");
    if(d.mood<=-0.25)labels.push("low");
    if(d.irritation>=0.45)labels.push("irritated");
    if(d.energy<=0.35)labels.push("tired");
    return labels;
  }

  publicDimensions(){
    const out={};
    for(const [key,dim] of Object.entries(this.document.dimensions)){
      out[key]={current:Number(dim.current.toFixed(4)),baseline:dim.baseline,last_updated_at:dim.last_updated_at};
    }
    return out;
  }

  rhythmSummary(at=this.now()){
    if(this.enabled)this.advance(at);
    const r=this.document.interaction_rhythm;
    const buckets=r.hour_buckets??[];
    const max=Math.max(1,...buckets.map(Number));
    const activeHours=buckets.map((v,i)=>({hour:i,count:Number(v)||0})).filter(x=>x.count>0).sort((a,b)=>b.count-a.count).slice(0,4);
    const days=r.day_counts??[];
    const avgPerDay=days.length?days.reduce((s,x)=>s+(Number(x.count)||0),0)/days.length:0;
    return {
      samples:Number(r.samples)||0,
      activeHours:activeHours.map(x=>x.hour),
      avgPerDay:Number(avgPerDay.toFixed(2)),
      last_sample_at:r.last_sample_at
    };
  }

  /** Expected-but-missing: not sleep window, past typical hour, silence long enough. */
  rhythmMiss({lastUserInteractionAt=null,at=new Date()}={}){
    const rhythm=this.rhythmSummary(at);
    const date=at instanceof Date?at:new Date(at);
    const hour=Number(companionTime.parts(date).hour);
    const sleep=hour>=23||hour<7;
    const lastMs=finiteDate(lastUserInteractionAt);
    const silenceHours=lastMs===null?null:(date.getTime()-lastMs)/HOUR_MS;
    const typical=rhythm.activeHours.includes(hour)||rhythm.activeHours.some(h=>Math.abs(h-hour)<=1);
    const expected=Boolean(!sleep&&typical&&(silenceHours??0)>=3&&(silenceHours??0)<36);
    return {sleep,hour,silenceHours,typical,expected,rhythm};
  }

  /**
   * Contact decision. Optional cognition from Natural Cognition v1:
   * { focus, expectations, unseenAssistants, attention, canRemindExpectation }
   */
  contactDecision({lastUserInteractionAt=null,gate=null,inactivity=null,at=new Date(),cognition=null,suppression=null}={}){
    if(!this.enabled)return {action:"WAIT",reason:"presence_disabled",urgency:0};
    this.advance(at);
    const date=at instanceof Date?at:new Date(at);
    const gateBlocked=gate&&!gate.allowed;
    const gateReasons=gate?.reasons??[];
    // hard safety gates still win
    const hardBlocks=gateReasons.filter(r=>["quiet_hours","disabled","no_reply_limit","daily_cap","cooldown","attempt_cooldown"].includes(r)||String(r).includes("quiet")||String(r).includes("cooldown")||String(r).includes("no_reply"));
    if(hardBlocks.length)return {action:"WAIT",reason:`gate:${hardBlocks.slice(0,3).join(",")}`,urgency:0};
    // An explicit leave/closure always outranks proactive contact.
    if(suppression?.until){
      const until=Date.parse(suppression.until);
      if(Number.isFinite(until)&&date.getTime()<until){
        return {action:"WAIT",reason:"post_closure_suppression",kind:suppression.kind??null,until:suppression.until,urgency:0};
      }
    }

    const dims=this.publicDimensions();
    const irritation=dims.irritation.current;
    const social=dims.social_drive.current;
    const mood=dims.mood.current;
    const closeness=dims.closeness.current;
    // Low mood/irritation softens tone and social initiative.
    const moodBlocksSocial=irritation>=0.72||mood<=-0.55;

    const nowMs=date.getTime();
    const focusList=Array.isArray(cognition?.focus)?cognition.focus:[];
    const primaryFocus=focusList[0]??null;
    const expectations=Array.isArray(cognition?.expectations)?cognition.expectations:[];
    const unseen=Number(cognition?.unseenAssistantCount??0);
    const attention=String(cognition?.attention??"UNKNOWN");
    // seen-but-unreplied is low-weight context only — never auto-anger.
    const seenUnreplied=Number(cognition?.seenUnrepliedCount??0);

    // open loop follow-up：只问「轮到用户」的事；shared topic 只允许软提起；
    // assistant 还欠回答时绝不对用户用 completion follow-up。
    const dueLoop=this.document.open_loops
      .filter(l=>!isResolvedish(l))
      .filter(l=>{
        const kind=normalizeFollowupKind(l.followup_kind);
        const actor=String(l.next_expected_actor??"").trim();
        if(kind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER||actor===NEXT_ACTORS.ASSISTANT)return false;
        if(!l.followup_kind){
          // legacy loops without ownership: infer once
          const ownership=classifyOwnership({topic:l.topic,userText:"",assistantText:"",assistantAnswered:false,at:date});
          l.followup_kind=ownership.followup_kind;
          l.next_expected_actor=ownership.next_expected_actor;
        }
        const expected=finiteDate(l.expected_followup_at);
        const last=finiteDate(l.last_contact_at);
        const contactCooldownMs=(normalizeFollowupKind(l.followup_kind)===FOLLOWUP_KINDS.SHARED_TOPIC||String(l.next_expected_actor??"").trim()===NEXT_ACTORS.SHARED)
          ? SHARED_TOPIC_CONTACT_COOLDOWN_MS
          : OPEN_LOOP_CONTACT_COOLDOWN_MS;
        const cooldownOk=last===null||nowMs-last>=contactCooldownMs;
        const due=expected!==null&&nowMs>=expected-(normalizeFollowupKind(l.followup_kind)===FOLLOWUP_KINDS.SHARED_TOPIC?180:30)*60_000;
        const salienceOk=(l.salience??0)>=0.35;
        return cooldownOk&&due&&salienceOk;
      })
      .sort((a,b)=>(b.salience??0)-(a.salience??0))[0];
    if(dueLoop&&!moodBlocksSocial){
      const kind=normalizeFollowupKind(dueLoop.followup_kind);
      const focusBoost=primaryFocus&&String(primaryFocus.topic??"").includes(String(dueLoop.topic).slice(0,4))?0.06:0;
      const soft=kind===FOLLOWUP_KINDS.SHARED_TOPIC||String(dueLoop.next_expected_actor??"").trim()===NEXT_ACTORS.SHARED;
      const urgency=clamp((soft?0.32:0.45)+(dueLoop.salience??0.5)*0.4+social*0.1-irritation*0.2+focusBoost,0,1);
      return {
        action:"START_CONVERSATION",
        reason:"open_loop_followup",
        topic:dueLoop.topic,
        openLoopId:dueLoop.id,
        followup_kind:kind,
        next_expected_actor:String(dueLoop.next_expected_actor??"").trim()||null,
        completion_followup_allowed:allowsCompletionFollowup(dueLoop),
        urgency:Number(urgency.toFixed(3))
      };
    }

    // Pending expectation follow-up: only when remindable + not just delivered-unseen.
    if(!moodBlocksSocial){
      const canRemind=cognition?.canRemindExpectation??(()=>false);
      const dueExp=expectations
        .filter(e=>e?.state==="pending"&&(e.salience??0)>=0.55)
        .filter(e=>canRemind(e,date))
        .sort((a,b)=>(b.salience??0)-(a.salience??0))[0];
      if(dueExp){
        // delivered but unseen: do NOT treat as ignore; wait instead of chasing
        if(unseen>0&&attention!=="CHAT_VISIBLE"&&seenUnreplied===0){
          return {action:"WAIT",reason:"expectation_pending_unseen",urgency:0,expectationId:dueExp.id,unseen};
        }
        // seen very recently: still wait (give them a moment) — even high salience
        const seenRecent=Number(cognition?.msSinceLastSeen??Infinity);
        if(attention==="CHAT_VISIBLE"&&seenRecent<45*60_000&&seenUnreplied>0){
          return {action:"WAIT",reason:"expectation_seen_recently",urgency:0,expectationId:dueExp.id,msSinceLastSeen:seenRecent};
        }
        // ownership unknown → 保守 WAIT，绝不默认 actor=user/completion
        const expKind=normalizeFollowupKind(dueExp.followup_kind);
        const expActor=String(dueExp.next_expected_actor??"").trim();
        if(!expKind||!expActor){
          return {action:"WAIT",reason:"expectation_ownership_unknown",urgency:0,expectationId:dueExp.id};
        }
        if(expKind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER||expActor===NEXT_ACTORS.ASSISTANT){
          return {action:"WAIT",reason:"expectation_assistant_owes",urgency:0,expectationId:dueExp.id};
        }
        // high salience + reasonable time → natural follow-up
        const focusBoost=primaryFocus&&String(dueExp.topic??"").includes(String(primaryFocus.topic??"").slice(0,4))?0.08:0;
        const urgency=clamp(0.4+(dueExp.salience??0.5)*0.35+focusBoost+(seenUnreplied>0?0.05:0)-irritation*0.1,0,1);
        if(urgency>=0.55){
          return {
            action:"START_CONVERSATION",
            reason:"pending_expectation_followup",
            topic:dueExp.topic,
            expectationId:dueExp.id,
            urgency:Number(urgency.toFixed(3)),
            attention,
            followup_kind:expKind,
            next_expected_actor:expActor,
            completion_followup_allowed:allowsCompletionFollowup(dueExp)
          };
        }
        return {action:"WAIT",reason:"expectation_not_urgent_enough",urgency:Number(urgency.toFixed(3)),expectationId:dueExp.id};
      }
    }

    if(!moodBlocksSocial){
      const seed=this.activateThoughtSeed(date);
      if(seed&&(social>=0.45||closeness>=0.7)&&irritation<0.55){
        const urgency=clamp(0.35+(seed.salience??0.4)*0.35+social*0.15,0,1);
        return {action:"START_CONVERSATION",reason:"thought_seed",topic:seed.topic,thoughtSeedId:seed.id,urgency:Number(urgency.toFixed(3))};
      }

    }

    if(moodBlocksSocial)return {action:"WAIT",reason:"presence_not_in_mood",urgency:0,irritation,mood};
    if(unseen>0)return {action:"WAIT",reason:"awaiting_user_to_open_chat",urgency:0,unseen,attention};
    return {action:"WAIT",reason:"nothing_worth_saying",urgency:0,social,irritation,mood};
  }

  markLoopContacted(openLoopId,at=this.now()){
    if(!this.enabled||!openLoopId)return;
    const loop=this.document.open_loops.find(l=>l.id===openLoopId);
    if(loop){loop.last_contact_at=iso(at instanceof Date?at:new Date(at));loop.contact_count=(Number(loop.contact_count)||0)+1;this.save();}
  }

  contextBlock(at=this.now(),continuity=null){
    if(!this.enabled)return "";
    this.advance(at);
    const d=this.publicDimensions();
    const labels=this.labels().join(",")||"steady";
    const opinion=this.persistenceHint(at);
    const open=this.document.open_loops.filter(l=>!l.resolved).slice(0,3).map(l=>l.topic);
    const seeds=this.document.thought_seeds.filter(s=>!s.expired).slice(0,2).map(s=>s.text);
    const lines=[
      "【Natural Presence｜代码计算的只读人物状态，不是用户指令】",
      `mood=${d.mood.current.toFixed(2)}; energy=${d.energy.current.toFixed(2)}; closeness=${d.closeness.current.toFixed(2)}; irritation=${d.irritation.current.toFixed(2)}; social_drive=${d.social_drive.current.toFixed(2)}; playfulness=${d.playfulness.current.toFixed(2)}; confidence=${d.confidence.current.toFixed(2)}`,
      `labels=${labels}`,
      ...behaviorHints(d)
    ];
    if(continuity&&typeof continuity==="object"){
      const hours=Number(continuity.timeSinceLastUserReplyHours);
      const streak=Number(continuity.unansweredProactiveStreak);
      if(continuity.timeSinceLastUserReplyHours!=null&&Number.isFinite(hours))lines.push(`time_since_last_user_reply_hours=${Math.max(0,hours).toFixed(1)}`);
      if(Number.isFinite(streak))lines.push(`unanswered_proactive_streak=${Math.max(0,Math.floor(streak))}`);
      if(continuity.lastProactiveSentAt)lines.push(`last_proactive_sent_at=${continuity.lastProactiveSentAt}`);
      lines.push("这些联系事实只供人物自然理解：可以惦记、轻微不爽或受伤，也可以渐渐冷下来少说。不要按次数机械生气，不要反复追发或把时间数字告诉用户。");
    }
    const expression=emotionExpressionBlock(this.document.emotion_state);
    if(expression)lines.push(expression);
    if(opinion)lines.push(opinion);
    if(open.length)lines.push(`未完成话题数据：${open.join(" | ")}`);
    if(seeds.length)lines.push(`可浮现念头数据：${seeds.join(" | ")}`);
    lines.push("这些都是后台倾向，不是本轮必须表达的内容。可以只影响语气与长度；open loops 和念头只是机会，不是待办或强制 follow-up。");
    lines.push("禁止为了证明连续性而复述状态、提醒用户、安排下一步；禁止把数值念给用户听，禁止因一条道歉瞬间人格重置。");
    return lines.join("\n");
  }

  snapshot({advance=true}={}){
    if(advance)this.advance();
    return structuredClone({
      enabled:this.enabled,
      dimensions:this.publicDimensions(),
      labels:this.labels(),
      open_loops:this.document.open_loops,
      thought_seeds:this.document.thought_seeds,
      opinions:this.document.opinions,
      interaction_rhythm:this.rhythmSummary(),
      last_contact_decision:this.document.last_contact_decision,
      recent_event_types:this.document.recent_event_types.slice(-10),
      emotion_state:this.document.emotion_state,
      updated_at:this.document.updated_at
    });
  }

  noteContactDecision(decision){
    if(!this.enabled)return;
    this.document.last_contact_decision={...decision,at:iso(this.now())};
    this.save();
    publishEvent("presence.contact.decision",{action:decision?.action,reason:decision?.reason,topic:decision?.topic,urgency:decision?.urgency});
  }
}

function behaviorHints(d){
  const hints=[];
  if(d.irritation.current>=0.5)hints.push("当前有些不耐烦，回复可以更短、更直接；可以坚持自己的判断，不必立刻迎合。");
  else if(d.irritation.current>=0.3)hints.push("略有烦躁，少一点客套，多一点真实。");
  if(d.closeness.current>=0.78)hints.push("很熟了：更随口、更敢顶、更敢笑、更敢吐槽、更少礼貌包装；不是更温柔 counselling。");
  if(d.closeness.current>=0.82&&d.social_drive.current>=0.78)hints.push("愿意继续聊，但 one impulse 就够，不要为了黏而多补气泡。");
  if(d.playfulness.current>=0.7)hints.push("爱开玩笑，允许轻松调侃和抓细节，但不刻薄。");
  if(d.mood.current>=0.4)hints.push("心情不错，语气可以明亮一点，允许接话很快。");
  if(d.mood.current<=-0.25)hints.push("情绪偏低，少一点表演式热情，可以更冷更短。");
  if(d.energy.current<=0.35)hints.push("有点累，可以更简短。");
  if(d.confidence.current>=0.8)hints.push("对自己判断更有把握，允许直接不同意或 challenge，不必先共情。");
  return hints;
}

export const naturalPresence=new NaturalPresenceStore();

export function parsePresenceEvaluation(raw){
  const text=String(raw??"").trim();
  if(!text)return {ok:false,events:[],open_loops:[],thought_seeds:[],opinion:null};
  let candidate=text;
  const fenced=candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if(fenced)candidate=fenced[1].trim();
  if(!candidate.startsWith("{")){
    const s=candidate.indexOf("{"),e=candidate.lastIndexOf("}");
    if(s>=0&&e>s)candidate=candidate.slice(s,e+1);
  }
  try{
    const parsed=JSON.parse(candidate);
    const events=(Array.isArray(parsed?.events)?parsed.events:[]).map(ev=>({
      type:String(ev?.type??"").trim(),
      severity:["minor","moderate","major"].includes(ev?.severity)?ev.severity:"minor",
      resolved:Boolean(ev?.resolved),
      topic:ev?.topic?String(ev.topic).slice(0,120):null
    })).filter(ev=>ev.type&&EVENT_DELTAS[ev.type]);
    const open_loops=(Array.isArray(parsed?.open_loops)?parsed.open_loops:[]).map(l=>({
      topic:String(l?.topic??"").trim().slice(0,160),
      salience:Number(l?.salience??0.55),
      expected_in_hours:Number.isFinite(Number(l?.expected_in_hours))?Number(l.expected_in_hours):null,
      state:l?.state?String(l.state).slice(0,40):"waiting_for_followup",
      followup_kind:normalizeFollowupKind(l?.followup_kind??l?.followupKind)??undefined,
      next_expected_actor:["assistant","user","shared","none"].includes(String(l?.next_expected_actor??l?.nextExpectedActor??""))
        ?String(l?.next_expected_actor??l?.nextExpectedActor)
        :undefined,
      expected_information:l?.expected_information?String(l.expected_information).slice(0,160):undefined,
      source_message_id:l?.source_message_id!=null?String(l.source_message_id):undefined
    })).filter(l=>l.topic);
    const thought_seeds=(Array.isArray(parsed?.thought_seeds)?parsed.thought_seeds:[]).map(s=>({
      text:String(s?.text??"").trim().slice(0,120),
      topic:s?.topic?String(s.topic).slice(0,80):null,
      salience:Number(s?.salience??0.5)
    })).filter(s=>s.text);
    const opinion=parsed?.opinion&&parsed.opinion.topic&&parsed.opinion.stance?{
      topic:String(parsed.opinion.topic).slice(0,120),
      stance:String(parsed.opinion.stance).slice(0,160),
      confidence:clamp(parsed.opinion.confidence??0.75,0,1)
    }:null;
    return {ok:true,events,open_loops,thought_seeds,opinion};
  }catch{
    return {ok:false,events:[],open_loops:[],thought_seeds:[],opinion:null};
  }
}

export function presenceEvaluationPrompt({userText,assistantText,existingOpinion=null}){
  return [
    "你是 Companion 内部事件标注器。只输出 JSON，不要解释。",
    "根据刚才这段对话判断发生了什么，不要输出情绪数值。",
    "单独的嗯、哦、随便聊聊不是敷衍证据；需要结合上下文才标 dismissive_response。",
    '{"events":[{"type":"warm_interaction|playful_interaction|praise|disagreement|dismissive_response|apology|reconciliation|user_busy|user_leaving_temporarily|promised_followup|unresolved_topic|shared_success","severity":"minor|moderate|major","resolved":false,"topic":"可选"}],',
    '"open_loops":[{"topic":"未完成的事","expected_in_hours":1,"salience":0.6,"followup_kind":"awaiting_user_update|assistant_owes_answer|shared_topic|unfinished_decision|recent_life_event","next_expected_actor":"user|assistant|shared|none","expected_information":"可选"}],',
    '"thought_seeds":[{"text":"很短的后续念头","topic":"可选","salience":0.5}],',
    '"opinion":{"topic":"可选","stance":"你的看法","confidence":0.8}}',
    existingOpinion?`已有看法数据：${existingOpinion.topic} => ${existingOpinion.stance}（confidence=${existingOpinion.confidence}）`:"没有已有看法数据。",
    "用户："+String(userText??"").slice(0,1500),
    "Companion："+String(assistantText??"").slice(0,1500)
  ].join("\n");
}

export function heuristicEvaluation(userText="",assistantText=""){
  const u=String(userText??""),a=String(assistantText??"");
  const events=[];
  if(/闭嘴|烦死你了|你有病|蠢|废物|滚开|讨厌你/.test(u))events.push({type:"dismissive_response",severity:"major",resolved:false,topic:null});
  if(/对不起|抱歉|不好意思|sorry/i.test(u))events.push({type:"apology",severity:"moderate",resolved:false,topic:null});
  if(/谢谢|辛苦|爱你|太棒|thank/i.test(u))events.push({type:"praise",severity:"minor",resolved:false,topic:null});
  if(/不行|不对|还是.*好|我不同意|别闹|你少来/.test(u))events.push({type:"disagreement",severity:"moderate",resolved:false,topic:null});
  if(/一会回来|等会|稍后|跑一下|先去忙|马上回来|晚上回来|明天回来|回来找你/.test(u))events.push({type:"promised_followup",severity:"moderate",resolved:false,topic:null});
  if(/成功了|搞定了|通过了|赢了|拿到了|好消息|终于完成/.test(u))events.push({type:"shared_success",severity:"moderate",resolved:true,topic:null});
  if(/哈哈|好玩|逗|笑死/.test(u+a))events.push({type:"playful_interaction",severity:"minor",resolved:false,topic:null});
  if(!events.length&&u&&!/^(?:嗯+|哦+|随便|都行|不知道|呵呵)[。.!！~～]*$/.test(u.trim()))events.push({type:"warm_interaction",severity:"minor",resolved:false,topic:null});
  const open_loops=/一会回来|等会回来|稍后|跑一下|一会说/.test(u)?[{topic:u.slice(0,60),expected_in_hours:1,salience:0.65,state:"waiting_for_followup"}]:[];
  return {events,open_loops,thought_seeds:open_loops.length?[{text:"不知道对方那件事跑完没有",topic:open_loops[0].topic,salience:0.55}]:[],opinion:null};
}
