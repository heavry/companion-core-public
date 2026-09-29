import crypto from "node:crypto";
import { config } from "./config.js";
import { insertMessage } from "./db.js";
import { publishEvent } from "./events-bus.js";
import { enqueueAssistantVoice, voiceAttemptKey, voiceAsyncDiagnostics } from "./voice-async-queue.js";
import { evaluateReplyCoverage, analyzeTurnCoverage } from "./turn-coverage.js";
import { evaluateSocialActCompletion, requiresSocialActCompletion } from "./social-act-completion.js";
import { evaluateCharacterRealization, requiresCharacterRealization } from "./relational-character.js";

// Natural Messaging v1：模型决定 1–3 个独立 utterance，每条都是真实 DB message。
// 不做机械按句号切割；parser 失败时安全 fallback 成单条。

export const NATURAL_MESSAGING_SYSTEM=[
  "【自然即时聊天｜只输出 JSON】",
  "你不是在写完整答案，而是在像真人发即时消息：接话，不是交作业。",
  "只输出一个 JSON 对象，不要 Markdown、不要解释：",
  '{"messages":["第一条气泡","第二条气泡"]}',
  "规则：",
  "- 一个 messages 元素 = 一个 impulse / 一个念头。冲动说完就够，不要扩成完整小作文。",
  "- 通常 1 条；真有另一个独立念头才 2 条；不要硬凑 3 条。",
  "- 允许只抓用户句子里一个最有感觉的点。闲聊碎片可以不提。",
  "- 但同一轮里的明确 question / request / task 不能被情绪或拌嘴吞掉：可以先拌嘴，再自然回答真正的问题；也可以一个文本一个语音。整轮必须完成明确项。",
  "- 允许短句、省略、反问、语气词：啊？/ 又来？/ 行。/ 不是，等会儿。",
  "- 一句话完成 impulse 后就停。不要自动补安慰、建议、总结、收尾。",
  "- 若用户当前确实表达了两件独立的事，可拆成多个 messages 元素。后台 recent event/open loop/pending 不构成第二个念头，不要因此追加气泡。",
  "- 每条是独立念头，不要把一句话机械按句号拆成多条。",
  "- 禁止系统通知口吻、威胁、羞辱、控制、情感勒索。",
  "- 绝不能以悬空开头结束整轮：若以「刚想起来一件事/对了/突然想到/差点忘了/我跟你说个事/还有个事」开头，必须在同一气泡把事情说完，或紧接下一气泡给出真正下文。"
].join("\n");

export const NATURAL_MESSAGING_PROACTIVE_SYSTEM=[
  "【主动消息｜自然即时聊天｜只输出 JSON】",
  "你正在以 Companion 身份主动找用户，像真人刚想到就发消息。",
  "只输出 JSON：{\"messages\":[\"气泡1\",\"气泡2\"]}",
  "- 通常 1 条；若明显是两个念头可 2 条；不要硬拆 3 条。",
  "- 允许轻微想念/轻松抱怨；禁止质问为什么不回复、威胁、羞辱、控制、情感勒索、系统通知口吻。",
  "- 不要标题、引号包装、元信息。",
  "- 禁止悬空结尾：例如不要只发「刚想起来一件事」；必须同一句说完，或第二句立刻说清是什么事。"
].join("\n");

const MAX_BUBBLES=3;

/** Openers that need immediate follow-up; cannot be a turn's last bubble alone. */
const DANGLING_OPENERS=[
  /^刚想起来一件事$/,
  /^对了$/,
  /^突然想到$/,
  /^差点忘了$/,
  /^我跟你说个事$/,
  /^还有个事$/,
  /^对了[，,]?$/,
  /^突然想到[，,]?$/
];

export function isDanglingOpener(text){
  const t=String(text??"").trim();
  if(!t||t.length>24)return false;
  return DANGLING_OPENERS.some(re=>re.test(t));
}

export function hasDanglingLastBubble(bubbles){
  const list=Array.isArray(bubbles)?bubbles.filter(Boolean):[];
  return list.length>0&&isDanglingOpener(list.at(-1));
}

function clampBubble(text){
  return String(text??"").replace(/\r/g,"").trim().slice(0,500);
}

function stableJitter(key){
  const bytes=crypto.createHash("sha256").update(String(key)).digest();
  return bytes.readUInt16BE(0)%420;
}

/** Parse model output into 1–3 bubbles. JSON preferred; plain text is single-bubble fallback. */
export function parseNaturalBubbles(raw){
  const text=String(raw??"").trim();
  if(!text)return {ok:false,fromJson:false,bubbles:[],raw:text};
  let candidate=text;
  const fenced=candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if(fenced)candidate=fenced[1].trim();
  // Tolerate surrounding prose only when a JSON object is clearly embedded.
  if(!candidate.startsWith("{")&&!candidate.startsWith("[")){
    const start=candidate.indexOf("{"),end=candidate.lastIndexOf("}");
    if(start>=0&&end>start)candidate=candidate.slice(start,end+1);
  }
  try{
    const parsed=JSON.parse(candidate);
    const list=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.messages)?parsed.messages:Array.isArray(parsed?.bubbles)?parsed.bubbles:null);
    if(Array.isArray(list)){
      const bubbles=list.map(clampBubble).filter(Boolean).slice(0,MAX_BUBBLES);
      if(bubbles.length)return {ok:true,fromJson:true,bubbles,raw:text};
    }
  }catch{}
  const fallback=clampBubble(text);
  if(!fallback)return {ok:false,fromJson:false,bubbles:[],raw:text};
  return {ok:false,fromJson:false,bubbles:[fallback],raw:text};
}

/**
 * Turn Coverage guard: if the user turn has explicit question/request/task
 * but the candidate only handled the casual fragment, do not complete the turn.
 * Prefer keeping the reaction and adding a short coverage answer (1 extra bubble).
 */
export async function ensureTurnCoverage({
  bubbles = [],
  userText = "",
  completeFn = null,
  signal = null,
  onDecision = null
} = {}) {
  const list = (Array.isArray(bubbles) ? bubbles : []).map(clampBubble).filter(Boolean).slice(0, MAX_BUBBLES);
  if (!list.length) {
    onDecision?.({ outcome: "empty_reply", complete: true });
    return list;
  }
  const coverage = evaluateReplyCoverage(userText, list);
  if (coverage.complete) {
    onDecision?.({
      outcome: coverage.reason,
      complete: true,
      obligationCount: coverage.analysis?.obligations?.length ?? 0
    });
    return list;
  }
  if (typeof completeFn !== "function") {
    onDecision?.({ outcome: "uncovered_no_repair_fn", complete: false, missing: coverage.missing.map(m => m.text) });
    return list;
  }
  try {
    const rewritten = await completeFn({
      mode: "coverage",
      userText,
      bubbles: list,
      missing: coverage.missing.map(m => ({ kind: m.kind, text: m.text })),
      signal
    });
    const parsed = parseNaturalBubbles(rewritten);
    const next = (parsed.bubbles.length ? parsed.bubbles : [clampBubble(rewritten)]).filter(Boolean);
    if (!next.length) {
      onDecision?.({ outcome: "coverage_repair_empty", complete: false });
      return list;
    }
    const recheck = evaluateReplyCoverage(userText, next);
    if (recheck.complete) {
      onDecision?.({
        outcome: "coverage_repaired",
        complete: true,
        inputCount: list.length,
        outputCount: next.length,
        fromJson: parsed.fromJson
      });
      return next.slice(0, MAX_BUBBLES);
    }
    // Keep repaired text if it at least engaged more of the ask than the original.
    const beforeMissing = coverage.missing.length;
    const afterMissing = recheck.missing.length;
    if (afterMissing < beforeMissing && next.join("").length >= list.join("").length) {
      onDecision?.({
        outcome: "coverage_partial",
        complete: false,
        inputCount: list.length,
        outputCount: next.length,
        missing: recheck.missing.map(m => m.text)
      });
      return next.slice(0, MAX_BUBBLES);
    }
    onDecision?.({
      outcome: "coverage_repair_rejected",
      complete: false,
      missing: recheck.missing.map(m => m.text)
    });
    return list;
  } catch (error) {
    onDecision?.({
      outcome: "coverage_error",
      complete: false,
      errorCode: String(error?.code ?? error?.name ?? "error").slice(0, 80)
    });
    return list;
  }
}

/**
 * Social Act Completion: after an apology / reconciliation / reassurance seek,
 * a pure rhetorical shut (「错什么错。」) can leave the social act hanging.
 * Keep replies short; rewrite once to close the social loop — never force Bubble2.
 */
export async function ensureSocialActCompletion({
  bubbles = [],
  userText = "",
  completeFn = null,
  signal = null,
  onDecision = null
} = {}) {
  const list = (Array.isArray(bubbles) ? bubbles : []).map(clampBubble).filter(Boolean).slice(0, MAX_BUBBLES);
  if (!list.length) {
    onDecision?.({ outcome: "empty_reply", complete: true });
    return list;
  }
  const check = evaluateSocialActCompletion(userText, list);
  if (check.complete) {
    onDecision?.({ outcome: check.reason, complete: true, acts: check.acts ?? [] });
    return list;
  }
  if (typeof completeFn !== "function") {
    onDecision?.({ outcome: "social_incomplete_no_repair_fn", complete: false, acts: check.acts ?? [] });
    return list;
  }
  try {
    const rewritten = await completeFn({
      mode: "social",
      userText,
      bubbles: list,
      acts: check.acts ?? [],
      signal
    });
    const parsed = parseNaturalBubbles(rewritten);
    const next = (parsed.bubbles.length ? parsed.bubbles : [clampBubble(rewritten)]).filter(Boolean);
    if (!next.length) {
      onDecision?.({ outcome: "social_repair_empty", complete: false });
      return list;
    }
    const recheck = evaluateSocialActCompletion(userText, next);
    if (recheck.complete) {
      onDecision?.({
        outcome: "social_act_completed",
        complete: true,
        inputCount: list.length,
        outputCount: next.length,
        acts: recheck.acts ?? []
      });
      // Prefer single natural utterance when the rewrite merged the stance.
      return next.slice(0, MAX_BUBBLES);
    }
    // Keep a longer rewrite only if it at least added social closure cues.
    const beforeJoined = list.join("");
    const afterJoined = next.join("");
    if (afterJoined.length > beforeJoined.length && afterJoined.length <= beforeJoined.length + 24) {
      onDecision?.({
        outcome: "social_act_partial",
        complete: false,
        inputCount: list.length,
        outputCount: next.length
      });
      return next.slice(0, MAX_BUBBLES);
    }
    onDecision?.({ outcome: "social_repair_rejected", complete: false });
    return list;
  } catch (error) {
    onDecision?.({
      outcome: "social_error",
      complete: false,
      errorCode: String(error?.code ?? error?.name ?? "error").slice(0, 80)
    });
    return list;
  }
}

/**
 * Relational Character Realization: pure affection/praise/tease turns may be
 * semantically complete but mechanically echoed (「亲一口。」 after「亲一个」).
 * One light rewrite to sound like this character — never force length or Bubble2.
 */
export async function ensureRelationalCharacter({
  bubbles = [],
  userText = "",
  completeFn = null,
  signal = null,
  presence = null,
  onDecision = null
} = {}) {
  const list = (Array.isArray(bubbles) ? bubbles : []).map(clampBubble).filter(Boolean).slice(0, MAX_BUBBLES);
  if (!list.length) {
    onDecision?.({ outcome: "empty_reply", complete: true });
    return list;
  }
  const check = evaluateCharacterRealization(userText, list, presence);
  if (check.complete) {
    onDecision?.({ outcome: check.reason, complete: true, acts: check.acts ?? [] });
    return list;
  }
  if (typeof completeFn !== "function") {
    onDecision?.({ outcome: "character_incomplete_no_repair_fn", complete: false, acts: check.acts ?? [] });
    return list;
  }
  try {
    const rewritten = await completeFn({
      mode: "character",
      userText,
      bubbles: list,
      acts: check.acts ?? [],
      presence,
      signal
    });
    const parsed = parseNaturalBubbles(rewritten);
    const next = (parsed.bubbles.length ? parsed.bubbles : [clampBubble(rewritten)]).filter(Boolean);
    if (!next.length) {
      onDecision?.({ outcome: "character_repair_empty", complete: false });
      return list;
    }
    const recheck = evaluateCharacterRealization(userText, next, presence);
    if (recheck.complete) {
      onDecision?.({
        outcome: "character_realized",
        complete: true,
        inputCount: list.length,
        outputCount: next.length,
        acts: recheck.acts ?? []
      });
      return next.slice(0, MAX_BUBBLES);
    }
    // Accept only a same-length-class rewrite (not a forced expansion).
    const before = list.join("");
    const after = next.join("");
    if (after.length <= Math.max(before.length + 16, 24) && after.length >= 2) {
      onDecision?.({
        outcome: "character_rewrite_kept",
        complete: recheck.complete,
        inputCount: list.length,
        outputCount: next.length
      });
      return next.slice(0, MAX_BUBBLES);
    }
    onDecision?.({ outcome: "character_repair_rejected", complete: false });
    return list;
  } catch (error) {
    onDecision?.({
      outcome: "character_error",
      complete: false,
      errorCode: String(error?.code ?? error?.name ?? "error").slice(0, 80)
    });
    return list;
  }
}

/**
 * Dangling opener guard: if the last bubble only opens a thought, generate the
 * real follow-up (model, not template). Returns complete bubbles or original.
 */
export async function ensureCompleteBubbles({bubbles=[],completeFn=null,signal=null}={}){
  let list=(Array.isArray(bubbles)?bubbles:[]).map(clampBubble).filter(Boolean).slice(0,MAX_BUBBLES);
  if(!list.length||!hasDanglingLastBubble(list)||typeof completeFn!=="function")return list;
  if(list.length>=MAX_BUBBLES){
    // cannot add bubble — require same-bubble completion via rewrite
    const rewritten=await completeFn({mode:"rewrite",opener:list.at(-1),bubbles:list,signal});
    const parsed=parseNaturalBubbles(rewritten);
    const next=parsed.bubbles.length?parsed.bubbles:list;
    return next.filter(Boolean).slice(0,MAX_BUBBLES);
  }
  const continuation=await completeFn({mode:"continue",opener:list.at(-1),bubbles:list,signal});
  const parsed=parseNaturalBubbles(continuation);
  const extra=(parsed.bubbles.length?parsed.bubbles:[clampBubble(continuation)]).filter(Boolean);
  // avoid duplicating opener inside continuation
  const opener=list.at(-1);
  const filtered=extra.filter(x=>x!==opener&&!x.startsWith(opener.slice(0,6)));
  if(filtered.length){
    // opener + real content
    list=[...list.slice(0,-1),opener,filtered[0]].filter(Boolean).slice(0,MAX_BUBBLES);
  }else if(extra.length===1&&extra[0]!==opener&&extra[0].length>opener.length){
    list=[...list.slice(0,-1),extra[0]].slice(0,MAX_BUBBLES);
  }
  return list.filter(Boolean);
}

/** True if text is essentially only fenced code/log/json (no real conversational shell). */
export function isMostlyStructuralCode(text){
  const t=String(text??"").trim();
  if(!t)return false;
  if(/^```|^~~~/.test(t))return true;
  // fenced block spanning most of the reply
  const fence=t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if(fence)return true;
  return false;
}

/**
 * True when a single bubble clearly contains multi-paragraph / multi-act structure.
 * Detection only — never split in code. Structural code fences are not acts.
 */
export function looksLikePackedDoubleParagraph(text){
  const t=String(text??"").trim();
  if(isMostlyStructuralCode(t))return false;
  if(t.includes("\n\n")){
    const parts=t.split(/\n{2,}/).map(s=>s.trim()).filter(Boolean);
    if(parts.length>=2&&parts[0].length>=4&&parts[1].length>=4)return true;
  }
  return false;
}

/** Heuristic: likely multiple conversational acts in one reply (not just long prose). */
export function looksLikeMultiActReply(text){
  const t=String(text??"").trim();
  if(t.length<16)return false;
  if(isMostlyStructuralCode(t))return false;
  if(looksLikePackedDoubleParagraph(t))return true;
  // multi-paragraph with single newlines still counts if several non-trivial lines
  const lines=t.split(/\n+/).map(s=>s.trim()).filter(s=>s.length>=6);
  if(lines.length>=3&&t.length>=40)return true;
  // two non-trivial lines separated by newline: treat as multi-act candidate when
  // they look like separate utterances (not a wrapped sentence).
  if(lines.length===2&&t.length>=24){
    const [a,b]=lines;
    const endsWithPunct=s=>/[。.!?！~…]$/.test(s);
    const startsNew=s=>/^(还|你|我|那|这|行|好|嗯|哦|对|方案|报告|如果|要|别|就|而且|另外|不过|或者)/.test(s);
    if((endsWithPunct(a)||startsWithNew(b))&&(endsWithPunct(a)||a.length>=8))return true;
  }
  // clear act markers: reaction + later question/follow-up
  const hasQuestion=/[?？]/.test(t);
  const hasReact=/^(好|行|嗯|哦|啊|改完|看完了|收到|知道了|没事)/.test(t)||/^(改完|看完了|弄好了)/.test(t);
  if(hasReact&&hasQuestion&&t.length>=24&&(t.includes("。")||t.includes("，")||t.includes("\n")))return true;
  return false;
}

export function shouldRunSemanticNormalizer(bubbles){
  const list=Array.isArray(bubbles)?bubbles.filter(Boolean):[];
  if(list.length!==1)return false;
  return looksLikePackedDoubleParagraph(list[0])||looksLikeMultiActReply(list[0]);
}

function joinBubbles(list){
  return list.map(x=>String(x??"").trim()).filter(Boolean).join("\n\n");
}

/** Accept a regroup only if wording is essentially preserved (no new facts). */
export function isFaithfulRegroup(original, next){
  const o=String(original??"").trim();
  const n=Array.isArray(next)?next.map(x=>String(x??"").trim()).filter(Boolean):[];
  if(!o||!n.length||n.length>3)return false;
  if(n.length===1)return n[0]===o||n[0].replace(/\s+/g,"")===o.replace(/\s+/g,"");
  const joined=n.join("\n\n");
  if(joined===o)return true;
  const norm=s=>s.replace(/\s+/g,"");
  if(norm(joined)===norm(o))return true;
  // each original paragraph/segment should appear in some bubble (allow minor punctuation trim)
  const segments=o.split(/\n{2,}|\n/).map(s=>s.trim()).filter(s=>s.length>=2);
  if(!segments.length)return false;
  const covered=segments.every(seg=>{
    const key=norm(seg);
    return n.some(b=>norm(b).includes(key)||key.includes(norm(b))||norm(b).includes(key.slice(0,Math.min(key.length,20))));
  });
  if(!covered)return false;
  // no large new content
  const joinedNorm=norm(joined);
  const oNorm=norm(o);
  if(joinedNorm.length>oNorm.length*1.15+20)return false;
  return true;
}

/**
 * Semantic Bubble Normalizer:
 * final result is still one bubble but clearly multiple conversational acts
 * → ask model once to re-group only (not re-answer).
 */
export async function ensureSemanticBubbles({bubbles=[],completeFn=null,signal=null,userText="",context="",onDecision=null}={}){
  const list=(Array.isArray(bubbles)?bubbles:[]).map(clampBubble).filter(Boolean).slice(0,MAX_BUBBLES);
  if(list.length!==1||typeof completeFn!=="function"){
    onDecision?.({outcome:"not_applicable",inputCount:list.length,outputCount:list.length});
    return list;
  }
  if(!shouldRunSemanticNormalizer(list)){
    onDecision?.({outcome:"single_act",inputCount:1,outputCount:1});
    return list;
  }
  try{
    const rewritten=await completeFn({mode:"split_judge",text:list[0],bubbles:list,userText,context,signal});
    const parsed=parseNaturalBubbles(rewritten);
    const next=parsed.bubbles.map(clampBubble).filter(Boolean).slice(0,MAX_BUBBLES);
    if(next.length===1){
      // model insists one continuous thought — keep original
      onDecision?.({outcome:"kept_by_semantic_judge",inputCount:1,outputCount:1,fromJson:parsed.fromJson});
      return list;
    }
    if(next.length>=2&&isFaithfulRegroup(list[0],next)){
      onDecision?.({outcome:"regrouped",inputCount:1,outputCount:next.length,fromJson:parsed.fromJson});
      return next;
    }
    onDecision?.({outcome:"rejected_unfaithful",inputCount:1,outputCount:next.length,fromJson:parsed.fromJson});
    return list;
  }catch(error){
    onDecision?.({outcome:"normalizer_error",inputCount:1,outputCount:1,errorCode:String(error?.code??error?.name??"error").slice(0,80)});
    return list;
  }
}

/** Origin distinguishes legacy same-generation split from true post-message follow-up. */
export function originForBubble({generationRoute="",index=0,bubbleCount=1}={}){
  const route=String(generationRoute||"");
  if(route.includes("post_message_followup"))return "post_message_followup";
  if(Number(bubbleCount)>1&&Number(index)>0)return "legacy_split";
  return "primary_generation";
}

/** Create the immutable, canonical identity-bearing plan consumed by DB/SSE/UI delivery. */
export function createBubblePlan(bubbles,{generationRoute="unknown",turnId=null,origin=null}={}){
  const list=(Array.isArray(bubbles)?bubbles:[]).map(clampBubble).filter(Boolean).slice(0,MAX_BUBBLES);
  return Object.freeze(list.map((text,index)=>Object.freeze({
    bubble_index:index,
    bubble_count:list.length,
    text,
    generation_route:String(generationRoute||"unknown").slice(0,80),
    turn_id:turnId==null?null:String(turnId).slice(0,160),
    origin:origin??originForBubble({generationRoute,index,bubbleCount:list.length})
  })));
}

/**
 * The only assistant-text -> BubblePlan[] finalization boundary.
 * Parse structured Natural Messaging, fall back to one plain candidate, run the
 * semantic regrouping judge, repair dangling openers, then freeze identities.
 */
export async function finalizeBubblePlan({
  rawModelOutput="",
  completeFn=null,
  signal=null,
  userText="",
  context="",
  generationRoute="unknown",
  turnId=null,
  finalTransform=null,
  presence=null,
  onTrace=null
}={}){
  const raw=String(rawModelOutput??"");
  const parsed=parseNaturalBubbles(raw);
  let bubbles=parsed.bubbles.length?parsed.bubbles:(raw.trim()?[clampBubble(raw)]:[]);
  const parsedMessagesCount=bubbles.length;
  let coverageDecision={outcome:"not_run",complete:true};
  // Coverage floor first: explicit Q/R/T must not be swallowed by casual-only replies.
  bubbles=await ensureTurnCoverage({
    bubbles,userText,completeFn,signal,
    onDecision:decision=>{coverageDecision=decision;}
  });
  let socialDecision={outcome:"not_run",complete:true};
  // Social floor: apology / reconciliation should not stop at a hanging deflection.
  bubbles=await ensureSocialActCompletion({
    bubbles,userText,completeFn,signal,
    onDecision:decision=>{socialDecision=decision;}
  });
  let characterDecision={outcome:"not_run",complete:true};
  // Relational character: pure affection/praise/tease should not be mechanical echo.
  bubbles=await ensureRelationalCharacter({
    bubbles,userText,completeFn,signal,presence,
    onDecision:decision=>{characterDecision=decision;}
  });
  let semanticDecision={outcome:"not_run",inputCount:bubbles.length,outputCount:bubbles.length};
  bubbles=await ensureSemanticBubbles({
    bubbles,completeFn,signal,userText,context,
    onDecision:decision=>{semanticDecision=decision;}
  });
  let danglingDecision="not_needed";
  try{
    const before=bubbles;
    bubbles=await ensureCompleteBubbles({bubbles,completeFn,signal});
    if(hasDanglingLastBubble(before))danglingDecision=hasDanglingLastBubble(bubbles)?"unresolved":"repaired";
  }catch(error){
    danglingDecision=`error:${String(error?.code??error?.name??"error").slice(0,80)}`;
  }
  if(typeof finalTransform==="function"){
    const transformed=await finalTransform(bubbles.slice());
    if(Array.isArray(transformed))bubbles=transformed;
  }
  const plan=createBubblePlan(bubbles,{generationRoute,turnId});
  const trace={
    generationRoute,
    rawFromJson:Boolean(parsed.fromJson),
    rawLength:raw.length,
    rawSha256:crypto.createHash("sha256").update(raw).digest("hex").slice(0,16),
    parsedMessagesCount,
    normalizedMessagesCount:plan.length,
    semanticDecision,
    coverageDecision,
    socialDecision,
    characterDecision,
    danglingDecision,
    packedDouble:looksLikePackedDoubleParagraph(parsed.bubbles[0]??raw),
    multiAct:looksLikeMultiActReply(parsed.bubbles[0]??raw),
    turnCoverage:analyzeTurnCoverage(userText)
  };
  onTrace?.(trace);
  return {plan,trace};
}

/**
 * Natural IM pacing: slightly longer bubble → slightly longer pause, with jitter.
 * index 0 has no delay. Target is IM rhythm, not fake “typing for 30s”.
 */
export function bubbleDelayMs(prevBubble,index){
  if(index<=0)return 0;
  const len=String(prevBubble??"").length;
  const base=Math.min(1800,380+Math.min(len,80)*22);
  return base+stableJitter(`${index}|${prevBubble}`);
}

function sleep(ms,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(Object.assign(new Error("aborted"),{name:"AbortError"}));return;}
    const timer=setTimeout(resolve,ms);
    const onAbort=()=>{clearTimeout(timer);reject(Object.assign(new Error("aborted"),{name:"AbortError"}));};
    signal?.addEventListener?.("abort",onAbort,{once:true});
  });
}

/**
 * Persist each bubble as its own assistant message and broadcast message.created.
 * Text is always durable + delivered BEFORE any TTS work.
 * Voice is an async job attached to the same assistant message_id.
 */
export async function deliverBubbleSequence({
  sessionId,
  source="chat",
  bubbles,
  bubblePlan=null,
  generationRoute="unknown",
  turnId=null,
  proactiveAttemptKey=null,
  extraContentJson=null,
  signal=null,
  hasUserInterrupted=null,
  userModality="text",
  enableModality=false,
  forceModality=null,
  enqueueVoice=null,
  onDelivered=null,
  onTrace=null,
  resumeFrom=0,
  now=()=>Date.now()
}={}){
  const plan=Array.isArray(bubblePlan)&&bubblePlan.length
    ? createBubblePlan(bubblePlan.map(item=>item?.text),{
        generationRoute:bubblePlan[0]?.generation_route??generationRoute,
        turnId:bubblePlan[0]?.turn_id??turnId
      })
    : createBubblePlan(bubbles,{generationRoute,turnId});
  const list=plan.map(item=>item.text);
  if(!plan.length)return {messages:[],interrupted:false,plan};
  let plans=null,presence=null,resolveStyle=null,logStyle=null,logEntry=null;
  if(enableModality&&config.modalityPlannerEnabled){
    try{
      const planner=await import("./modality-planner.js");
      const presenceMod=await import("./natural-presence/index.js");
      presence=presenceMod.naturalPresence.enabled?presenceMod.naturalPresence.snapshot({advance:false}):null;
      plans=planner.planTurnModalities({bubbles:list,userModality,sessionId,presence}).plans;
      resolveStyle=planner.resolveVoiceStyleForPlan;
      logStyle=planner.logVoiceStyle;
      logEntry=planner.styleLogEntry;
    }catch{}
  }
  const delivered=[];
  let prev="",previousStyle="neutral";
  const firstIndex=Math.max(0,Math.min(plan.length,Number(resumeFrom)||0));
  for(let i=firstIndex;i<plan.length;i++){
    if(signal?.aborted)break;
    if(i>0){
      if(typeof hasUserInterrupted==="function"&&hasUserInterrupted())return {messages:delivered,interrupted:true,plan};
      const wait=bubbleDelayMs(prev,i);
      if(wait>0){
        try{await sleep(wait,signal);}
        catch{ return {messages:delivered,interrupted:true,plan}; }
      }
      if(typeof hasUserInterrupted==="function"&&hasUserInterrupted())return {messages:delivered,interrupted:true,plan};
    }
    const bubblePlanItem=plan[i];
    const bubble=bubblePlanItem.text;
    const modalityPlan=plans?.[i]??null;
    let voicePlan=null,modality="TEXT",voiceStyle=null,voiceEligible=false,emotion=null;
    const remoteLocalTts=/^cloud-(?:test|primary)$/.test(String(config.deploymentRole??""));
    // Decide modality only. Never await TTS before text durable + SSE.
    const forcedVoice=forceModality==="VOICE";
    const forcedText=forceModality==="TEXT";
    if(!forcedText&&(forcedVoice||modalityPlan?.modality==="VOICE")&&(remoteLocalTts||typeof enqueueVoice==="function")){
      try{
        const styled=resolveStyle({plan:modalityPlan,presence,previousStyle,bubbleIndex:i});
        previousStyle=styled.style;
        voiceStyle=styled.style;
        emotion=modalityPlan?.emotion??null;
        voiceEligible=true;
        modality="VOICE";
        voicePlan={
          schema_version:1,
          generation_id:`${bubblePlanItem.turn_id}:${i}`,
          bubble_turn_id:bubblePlanItem.turn_id,
          bubble_index:i,
          bubble_count:list.length,
          text:bubble,
          voice_requested:true,
          voice_profile:"linxt30",
          voice_style:styled.style,
          emotion
        };
        logStyle?.(logEntry({style:styled.style,reason:styled.reason,presence,reference:styled.reference,fallback:false,ttsOk:true,text:bubble}));
      }catch{
        voiceEligible=false;
        modality="TEXT";
        logStyle?.(logEntry({style:previousStyle,reason:"tts_failed_fallback_text",presence,reference:null,fallback:true,ttsOk:false,text:bubble}));
      }
    }
    const extra=typeof extraContentJson==="function"
      ? extraContentJson({plan:bubblePlanItem,index:i})
      : extraContentJson;
    onTrace?.("bubble",{bubbleIndex:i,bubbleCount:plan.length,textLength:bubble.length,turnId:bubblePlanItem.turn_id,generationRoute:bubblePlanItem.generation_route});
    const messageId=insertMessage(sessionId,source,{
      role:"assistant",
      content:bubble,
      ...(voicePlan?{voice_plan:voicePlan}:{}),
      ...(voiceEligible&&!remoteLocalTts?{voice_job:{state:"pending",style:voiceStyle}}:{}),
      ...(proactiveAttemptKey?{proactive_attempt_key:proactiveAttemptKey}:{}),
      ...(extra&&typeof extra==="object"?extra:{}),
      bubble_index:i,
      bubble_count:plan.length,
      bubble_turn_id:bubblePlanItem.turn_id,
      generation_route:bubblePlanItem.generation_route,
      origin:bubblePlanItem.origin??originForBubble({generationRoute:bubblePlanItem.generation_route,index:i,bubbleCount:plan.length}),
      modality
    });
    const textDurableAt=now();
    onTrace?.("db",{insertMessageId:messageId,bubbleIndex:i,bubbleCount:plan.length,turnId:bubblePlanItem.turn_id,textDurableAt});
    publishEvent("message.created",{
      messageId,role:"assistant",source,type:modality==="VOICE"?"voice":"text",
      preview:bubble.slice(0,300),
      bubbleIndex:i,bubbleCount:plan.length,bubbleTurnId:bubblePlanItem.turn_id,
      ...(voicePlan?{voice_plan:voicePlan}:{}),
      ...(voiceEligible?{voice_pending:true,voice_style:voiceStyle}:{}),
      deliveryTargets:["mac"]
    },{sessionId});
    // TEXT FIRST: deliver before any TTS enqueue completion / synthesis.
    await onDelivered?.({messageId,index:i,count:plan.length,text:bubble,plan:bubblePlanItem,modality,voicePlan,voiceEligible,textDurableAt});
    const textSseAt=now();
    onTrace?.("text_sse",{messageId,bubbleIndex:i,textSseAt,textDurableAt});
    // THEN enqueue async voice. Never blocks this loop's next bubble text.
    if(voiceEligible&&!remoteLocalTts){
      const enqueue=typeof enqueueVoice==="function"
        ? enqueueVoice
        : (payload)=>enqueueAssistantVoice(payload);
      const queued=enqueue({
        messageId,
        sessionId,
        text:bubble,
        style:voiceStyle,
        voicePlan,
        voiceStyle,
        emotion,
        signal,
        source
      });
      onTrace?.("voice_enqueue",{messageId,attemptKey:voiceAttemptKey(messageId),status:queued?.status,textSseAt});
    }
    delivered.push({messageId,index:i,text:bubble,modality,voiceStyle,voicePlan,voiceEligible,textDurableAt,textSseAt});
    prev=bubble;
  }
  return {messages:delivered,interrupted:false,plan};
}

export function naturalMessagingEnabled(){
  return config.naturalMessagingEnabled!==false;
}
