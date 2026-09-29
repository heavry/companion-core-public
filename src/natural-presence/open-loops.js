import crypto from "node:crypto";
import { clamp01,HOUR_MS } from "./store.js";

const MAX_LOOPS=6;
const MAX_SEEDS=6;
const SEED_COOLDOWN_MS=90*60_000;
const FOLLOWUP_RE=/(一会回来|等会回来|稍等一下?|跑一下|等.{0,6}结果|回来再说|先去忙|去测试|部署|上线|测完)/;
const PROMISE_RE=/(一会|等会|回头|晚点|之后).{0,10}(说|聊|看|回|找)/;

function id(prefix){return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;}

function similar(a,b){
  const x=String(a??"").toLowerCase(),y=String(b??"").toLowerCase();
  if(!x||!y)return false;
  if(x===y)return true;
  const xs=new Set(x),ys=new Set(y);
  let inter=0;for(const ch of xs)if(ys.has(ch))inter++;
  return inter/Math.max(xs.size,ys.size)>=0.72;
}

export function maybeCreateOpenLoop({userText="",at=new Date(),existing=[]}={}){
  const text=String(userText??"").trim();
  if(!text||text.length>200)return null;
  if(!(FOLLOWUP_RE.test(text)||PROMISE_RE.test(text)))return null;
  if(existing.some(loop=>!loop.resolved&&similar(loop.topic,text.slice(0,40))))return null;
  const created=at instanceof Date?at:new Date(at);
  let expected=null;
  if(/一会|等会|稍等|回头|晚点/.test(text)){
    expected=new Date(created.getTime()+45*60_000).toISOString();
  }
  return {
    id:id("loop"),
    topic:text.slice(0,80),
    state:"waiting_for_followup",
    salience:0.65,
    created_at:created.toISOString(),
    expected_followup_at:expected,
    resolved:false,
    resolved_at:null
  };
}

export function upsertOpenLoop(store,loop){
  if(!loop)return null;
  const loops=store.document.open_loops;
  const dup=loops.find(x=>!x.resolved&&similar(x.topic,loop.topic));
  if(dup){
    dup.salience=clamp01(Math.max(dup.salience,loop.salience));
    dup.expected_followup_at=dup.expected_followup_at||loop.expected_followup_at;
    store.save();
    return structuredClone(dup);
  }
  loops.push(loop);
  while(loops.filter(x=>!x.resolved).length>MAX_LOOPS){
    const idx=loops.findIndex(x=>!x.resolved);
    if(idx<0)break;
    loops[idx].resolved=true;loops[idx].resolved_at=new Date().toISOString();loops[idx].resolve_reason="overflow";
  }
  store.save();
  return structuredClone(loop);
}

export function resolveOpenLoops(store,{matchText="",at=new Date()}={}){
  const text=String(matchText??"");
  const now=at instanceof Date?at:new Date(at);
  let resolved=0;
  for(const loop of store.document.open_loops){
    if(loop.resolved)continue;
    const expected=Date.parse(loop.expected_followup_at??"");
    // user returned with related content, or expected time long passed with low salience
    if(text&&similar(loop.topic,text.slice(0,60))){
      loop.resolved=true;loop.resolved_at=now.toISOString();loop.resolve_reason="user_returned";resolved++;
    }else if(Number.isFinite(expected)&&now.getTime()>expected+6*HOUR_MS&&loop.salience<0.35){
      loop.resolved=true;loop.resolved_at=now.toISOString();loop.resolve_reason="stale";resolved++;
    }
  }
  if(resolved)store.save();
  return resolved;
}

export function activeOpenLoops(store,at=new Date()){
  const now=(at instanceof Date?at:new Date(at)).getTime();
  return store.document.open_loops
    .filter(l=>!l.resolved&&Number(l.salience)>=0.2)
    .sort((a,b)=>Number(b.salience)-Number(a.salience));
}

export function maybeCreateThoughtSeed({assistantText="",userText="",topic="",at=new Date(),existing=[]}={}){
  const combined=`${assistantText} ${userText}`.trim();
  if(!combined)return null;
  // only meaningful leftover thoughts
  if(!/(不知道|应该|希望|记得|惦记|结果|跑完|之后|回头|想)/.test(combined))return null;
  if(existing.some(s=>similar(s.text,combined.slice(0,40))))return null;
  const text=combined.length<=36?combined:combined.slice(0,36);
  return {
    id:id("seed"),
    text,
    topic:String(topic||"chat").slice(0,60),
    salience:0.56,
    created_at:(at instanceof Date?at:new Date(at)).toISOString(),
    last_activated_at:null
  };
}

export function upsertThoughtSeed(store,seed){
  if(!seed)return null;
  const seeds=store.document.thought_seeds;
  const dup=seeds.find(s=>similar(s.text,seed.text));
  if(dup){
    dup.salience=clamp01(Math.max(dup.salience,seed.salience));
    store.save();
    return structuredClone(dup);
  }
  seeds.push(seed);
  while(seeds.length>MAX_SEEDS)seeds.shift();
  store.save();
  return structuredClone(seed);
}

export function pickThoughtSeed(store,at=new Date()){
  const now=(at instanceof Date?at:new Date(at)).getTime();
  const candidates=store.document.thought_seeds
    .filter(s=>{
      if(Number(s.salience)<0.25)return false;
      const last=Date.parse(s.last_activated_at??"");
      if(Number.isFinite(last)&&now-last<SEED_COOLDOWN_MS)return false;
      return true;
    })
    .sort((a,b)=>Number(b.salience)-Number(a.salience));
  if(!candidates.length)return null;
  candidates[0].last_activated_at=new Date(now).toISOString();
  store.save();
  return structuredClone(candidates[0]);
}

export { MAX_LOOPS,MAX_SEEDS,SEED_COOLDOWN_MS };
