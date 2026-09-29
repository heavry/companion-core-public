import { config } from "./config.js";

// Reply Latency Personality (包A)：
// 首条回复的「出场时机」由状态决定，而不是固定 0ms。
// 只影响 user→assistant 的第一条；后续 bubble 仍走 bubbleDelayMs。

const TIERS = Object.freeze({
  snappy: { minMs: 80, maxMs: 700 },
  normal: { minMs: 250, maxMs: 1800 },
  thoughtful: { minMs: 900, maxMs: 4200 },
  drained: { minMs: 1200, maxMs: 6500 }
});

function clamp(n, a, b){ return Math.max(a, Math.min(b, Number(n)||0)); }

function dimValue(presence, key, fallback){
  const raw = presence?.dimensions?.[key]?.current;
  return Number.isFinite(Number(raw)) ? Number(raw) : fallback;
}

function stableJitter(key, span){
  const s = String(key);
  let h = 2166136261;
  for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % Math.max(1, Math.floor(span));
}

/** Detect user urgency that should compress latency. */
export function detectUrgency(userText="", { recentUserTexts=[] }={}){
  const t = String(userText??"").trim();
  const reasons = [];
  if(!t) return { urgent:false, reasons };
  if(/[?？]{2,}/.test(t) || /^[?？!！.。]{1,3}$/.test(t)) reasons.push("punct");
  if(/在吗|在么|快回|回我|急|马上|现在就|怎么还不|不回|人呢|hello/i.test(t)) reasons.push("urge_word");
  if(t.length<=4 && /[?？!！。.]$/.test(t)) reasons.push("short_probe");
  const recent = recentUserTexts.filter(Boolean).slice(-3);
  if(recent.length>=2){
    const last = recent.at(-1);
    if(last && last===t) reasons.push("repeat");
  }
  return { urgent: reasons.length>0, reasons };
}

/** Message weight: heavier content → slightly longer entrance thought. */
export function messageWeight(userText=""){
  const t = String(userText??"");
  if(!t) return "light";
  if(/为什么|怎么看|分析|方案|对比|总结|解释|复盘|建议|要不要|选哪个|还是|冲突|bug|失败|问题出/.test(t)) return "heavy";
  if(t.length>=28 || (t.match(/。|\?|？/g)||[]).length>=2) return "medium";
  return "light";
}

/**
 * Choose latency tier + delayMs for the first assistant bubble.
 * Hard cap always wins; floor prevents robotic 0ms sync.
 */
export function planFirstReplyLatency({
  userText="",
  recentUserTexts=[],
  presence=null,
  source="chat",
  modality="text",
  seed=null,
  enabled=config.replyLatencyEnabled!==false,
  capMs=config.replyLatencyCapMs,
  floorMs=config.replyLatencyFloorMs
}={}){
  if(!enabled){
    return { enabled:false, tier:"disabled", delayMs:0, reasons:["disabled"], capMs, floorMs };
  }
  // Proactive and agent tool paths keep existing pacing — only daily chat replies personality-delay.
  if(source!=="chat"){
    return { enabled:false, tier:"skipped_source", delayMs:0, reasons:[`source:${source}`], capMs, floorMs };
  }

  const energy = dimValue(presence, "energy", 0.65);
  const irritation = dimValue(presence, "irritation", 0.1);
  const mood = dimValue(presence, "mood", 0.15);
  const emotion=presence?.emotion_state;
  const urgency = detectUrgency(userText, { recentUserTexts });
  const weight = messageWeight(userText);

  const reasons = [];
  let score = 0; // higher → longer

  if(energy <= 0.32){ score += 2.2; reasons.push("low_energy"); }
  else if(energy <= 0.45){ score += 1.1; reasons.push("mid_low_energy"); }

  // Irritation only speeds reply when there is energy to act short/crisp.
  // Alone it must not collapse into snappy fake delay.
  if(irritation >= 0.55 && energy >= 0.45){
    score -= 1.5;
    reasons.push("irritated_snappy");
  }else if(irritation >= 0.55){
    score -= 0.2;
    reasons.push("irritated_but_low_energy");
  }
  if((emotion?.intensity??0)>=0.45){
    if(emotion.primary==="excited"){score-=1.2;reasons.push("excited_quick_reaction");}
    else if(emotion.primary==="angry"&&energy>=0.45){score-=1.1;reasons.push("angry_crisp");}
    else if(emotion.primary==="hurt"){score+=1.0;reasons.push("hurt_withdrawn");}
  }
  // mood is intentionally NOT mapped to speed. Low mood affects expression/social
  // drive elsewhere; using it alone produced large volumes of 100–600ms fake delays.

  if(weight === "heavy"){ score += 1.6; reasons.push("heavy_message"); }
  else if(weight === "medium"){ score += 0.6; reasons.push("medium_message"); }

  if(modality === "voice"){ score += 0.5; reasons.push("voice_modality"); }

  if(urgency.urgent){ score -= 2.5; reasons.push(`urgent:${urgency.reasons.join("+")}`); }

  // Tiering: neutral/normal-chat must land in normal, not snappy.
  // snappy requires urgency or a clearly negative combined score.
  let tier = "normal";
  if(urgency.urgent) tier = "snappy";
  else if(score >= 2.0) tier = "drained";
  else if(score >= 0.9) tier = "thoughtful";
  else if(score >= 0.15) tier = "normal";
  else if(score <= -1.0) tier = "snappy";
  else tier = "normal";

  const band = TIERS[tier] ?? TIERS.normal;
  const span = Math.max(1, band.maxMs - band.minMs);
  const jitterKey = String(seed ?? `${userText}|${tier}|${Math.round(energy*100)}|${Math.round(irritation*100)}`);
  const delayMs = band.minMs + stableJitter(jitterKey, span);

  const hardCap = Math.max(Number(floorMs)||0, Math.min(Number(capMs)||9000, 9000));
  const clamped = Math.round(clamp(delayMs, Math.max(0, Number(floorMs)||0), hardCap));

  return {
    enabled:true,
    tier,
    delayMs:clamped,
    reasons,
    signals:{
      energy:Number(energy.toFixed(3)),
      irritation:Number(irritation.toFixed(3)),
      mood:Number(mood.toFixed(3)),
      emotion:emotion?.primary??null,
      weight,
      urgent:urgency.urgent,
      modality
    },
    capMs:hardCap,
    floorMs:Number(floorMs)||0
  };
}

/** Abortable sleep that rejects early on abort, like natural-messaging sleep. */
export function sleepWithSignal(ms, signal){
  return new Promise((resolve, reject)=>{
    if(signal?.aborted){ reject(Object.assign(new Error("aborted"),{name:"AbortError"})); return; }
    const n = Math.max(0, Number(ms)||0);
    if(n===0){ resolve(); return; }
    const onAbort = ()=>{ clearTimeout(timer); reject(Object.assign(new Error("aborted"),{name:"AbortError"})); };
    const timer = setTimeout(()=>{ signal?.removeEventListener?.("abort", onAbort); resolve(); }, n);
    signal?.addEventListener?.("abort", onAbort, { once:true });
  });
}

/**
 * Wait before first bubble. Safe: never blocks past hard cap; aborts cancel.
 * Returns { waited, interrupted, plan }.
 */
export async function awaitFirstReplyLatency(plan, { signal=null, userInterrupted=null }={}){
  if(!plan?.enabled || !(plan.delayMs>0)) return { waited:0, interrupted:false, plan };
  if(typeof userInterrupted==="function" && userInterrupted()){
    return { waited:0, interrupted:true, plan };
  }
  const started = Date.now();
  try{
    await sleepWithSignal(plan.delayMs, signal);
  }catch(e){
    if(e?.name==="AbortError") return { waited:Date.now()-started, interrupted:true, plan };
    throw e;
  }
  if(typeof userInterrupted==="function" && userInterrupted()){
    return { waited:Date.now()-started, interrupted:true, plan };
  }
  return { waited:Date.now()-started, interrupted:false, plan };
}

export function replyLatencyDebugLine(plan){
  if(!plan) return null;
  return {
    tier:plan.tier,
    delay_ms:plan.delayMs,
    reasons:plan.reasons??[],
    signals:plan.signals??null
  };
}
