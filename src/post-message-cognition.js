/**
 * Post-message Cognition / True Multi-Bubble v1
 *
 * After Bubble 1 is durable + emitted, ask once: is there a genuinely new
 * conversational act worth adding? At most one independent follow-up per
 * user turn. Never chain-of-thought. Never force a second bubble.
 */

import crypto from "node:crypto";
import { compactText, textSimilarity } from "./utils.js";

export const POST_MESSAGE_REASONS = Object.freeze({
  ASSOCIATION_AFTERTHOUGHT: "association_afterthought",
  MEMORY_AFTERTHOUGHT: "memory_afterthought",
  EMOTIONAL_AFTERTHOUGHT: "emotional_afterthought",
  CALLBACK_AFTERTHOUGHT: "callback_afterthought",
  IMPORTANT_ADDENDUM: "important_addendum"
});

export const postMessageDiagnostics = {
  primaryTurnCount: 0,
  postMessageEligibleCount: 0,
  postMessageCandidateCount: 0,
  postMessageGeneratedCount: 0,
  postMessageSentCount: 0,
  noFollowupCount: 0,
  suppressedByDuplicate: 0,
  suppressedByUserInterrupt: 0,
  suppressedByStaleTurn: 0,
  followupProviderFailure: 0,
  postMessageDuplicateCount: 0,
  staleFollowupAfterUserInterrupt: 0,
  followupAfterClosureCount: 0,
  autoReconciliationCount: 0,
  legacySplitBubbleCount: 0,
  truePostMessageBubbleCount: 0,
  durableLookupHit: 0,
  durableLookupMiss: 0,
  followupGenerateCount: 0,
  followupDeliverCount: 0,
  duplicateFollowupAfterRestart: 0,
  duplicatePrimary: 0,
  partialDurable: 0,
  firstBubbleLatencyMs: [],
  postMessageDecisionLatencyMs: [],
  followupGenerationLatencyMs: [],
  lastDecision: null,
  lastReason: null
};

export function resetPostMessageDiagnostics() {
  for (const key of Object.keys(postMessageDiagnostics)) {
    if (Array.isArray(postMessageDiagnostics[key])) postMessageDiagnostics[key] = [];
    else if (key === "lastDecision" || key === "lastReason") postMessageDiagnostics[key] = null;
    else postMessageDiagnostics[key] = 0;
  }
}

export function postMessageLimits() {
  return {
    max_followups_per_turn: 1,
    max_primary_bubbles: 3,
    duplicate_similarity: 0.72,
    min_salience: 0.55,
    decision_timeout_ms: 800,
    followup_timeout_ms: 60000,
    short_jitter_ms: [120, 420]
  };
}

export function postMessageAttemptKey(parentTurnId, index = 1) {
  return `postmsg:${String(parentTurnId ?? "").slice(0, 120)}:${index}`;
}

/** Semantic echo: Bubble 2 must not restate Bubble 1. */
export function isSemanticDuplicate(primaryText, followupText) {
  const a = compactText(primaryText);
  const b = compactText(followupText);
  if (!a || !b) return true;
  if (a === b) return true;
  const sim = textSimilarity(a, b);
  if (sim >= 0.72) return true;
  // Same leading bigram run + short follow-up is almost always a restatement.
  if (b.length <= 18 && a.includes(b)) return true;
  return false;
}

/**
 * Lightweight local gate. No second LLM call here.
 * Returns a structured decision only — never free-form reasoning text.
 */
export function evaluatePostMessageGate({
  userText = "",
  primaryText = "",
  primaryBubbles = [],
  closureLikely = false,
  userLeaving = false,
  silenceRequested = false,
  isProactive = false,
  activeMemory = null,
  associationCandidate = null,
  openLoopCandidate = null,
  expectationCandidate = null,
  emotionState = null,
  focusTopics = [],
  recentFollowupCount = 0,
  contactSuppressed = false
} = {}) {
  const decision = {
    should_follow_up: false,
    reason_code: null,
    salience: 0,
    candidate_topic: null,
    related_memory_id: null,
    related_event_id: null,
    confidence: 0
  };

  if (silenceRequested || userLeaving) {
    return { ...decision, reason_code: "user_leaving_or_silence" };
  }
  if (closureLikely) {
    return { ...decision, reason_code: "primary_closed_thought" };
  }
  if (contactSuppressed) {
    return { ...decision, reason_code: "contact_suppressed" };
  }
  if (recentFollowupCount >= 2) {
    return { ...decision, reason_code: "recent_followup_frequency" };
  }

  const primaryJoined = (primaryBubbles.length ? primaryBubbles : [primaryText]).join("\n");
  if (!compactText(primaryJoined)) {
    return { ...decision, reason_code: "empty_primary" };
  }

  // Prefer explicit high-salience structured candidates over emotion alone.
  const candidates = [];
  if (associationCandidate?.salience >= 0.55 && associationCandidate?.topic) {
    candidates.push({
      reason_code: POST_MESSAGE_REASONS.ASSOCIATION_AFTERTHOUGHT,
      salience: Number(associationCandidate.salience),
      candidate_topic: String(associationCandidate.topic).slice(0, 120),
      related_memory_id: associationCandidate.memory_id ?? null,
      related_event_id: associationCandidate.event_id ?? null,
      confidence: Number(associationCandidate.confidence ?? 0.7)
    });
  }
  if (activeMemory?.salience >= 0.55 && activeMemory?.topic) {
    candidates.push({
      reason_code: POST_MESSAGE_REASONS.MEMORY_AFTERTHOUGHT,
      salience: Number(activeMemory.salience),
      candidate_topic: String(activeMemory.topic).slice(0, 120),
      related_memory_id: activeMemory.memory_id ?? null,
      related_event_id: activeMemory.event_id ?? null,
      confidence: Number(activeMemory.confidence ?? 0.7)
    });
  }
  if (openLoopCandidate?.salience >= 0.62 && openLoopCandidate?.topic) {
    candidates.push({
      reason_code: POST_MESSAGE_REASONS.CALLBACK_AFTERTHOUGHT,
      salience: Number(openLoopCandidate.salience),
      candidate_topic: String(openLoopCandidate.topic).slice(0, 120),
      related_memory_id: openLoopCandidate.memory_id ?? null,
      related_event_id: openLoopCandidate.event_id ?? null,
      confidence: Number(openLoopCandidate.confidence ?? 0.75)
    });
  }
  if (expectationCandidate?.salience >= 0.68 && expectationCandidate?.topic) {
    candidates.push({
      reason_code: POST_MESSAGE_REASONS.IMPORTANT_ADDENDUM,
      salience: Number(expectationCandidate.salience),
      candidate_topic: String(expectationCandidate.topic).slice(0, 120),
      related_memory_id: expectationCandidate.memory_id ?? null,
      related_event_id: expectationCandidate.event_id ?? null,
      confidence: Number(expectationCandidate.confidence ?? 0.75)
    });
  }

  // Emotion alone never forces a follow-up (no auto-repair / no vent bubble).
  // It can only lift an already-plausible addendum slightly.
  const emotionLift = emotionState?.intensity >= 0.45 ? 0.04 : 0;
  for (const item of candidates) {
    item.salience = Math.min(1, item.salience + emotionLift);
  }

  if (!candidates.length) {
    return { ...decision, reason_code: "no_new_conversational_act" };
  }

  candidates.sort((a, b) => b.salience - a.salience || b.confidence - a.confidence);
  const top = candidates[0];
  // Bubble2 is never a completeness pad.
  if (topIsSoftPadding(top, primaryJoined)) {
    return { ...decision, reason_code: "no_new_impulse_completeness_pad", salience: top.salience };
  }
  if (top.salience < 0.55) {
    return { ...decision, reason_code: "low_salience_memory" };
  }
  // Topic already fully covered in primary → do not restate.
  if (top.candidate_topic && compactText(primaryJoined).includes(compactText(top.candidate_topic).slice(0, 8))) {
    return { ...decision, reason_code: "already_covered_in_primary", salience: top.salience };
  }

  return {
    should_follow_up: true,
    reason_code: top.reason_code,
    salience: Number(top.salience.toFixed(3)),
    candidate_topic: top.candidate_topic,
    related_memory_id: top.related_memory_id,
    related_event_id: top.related_event_id,
    confidence: Number(top.confidence.toFixed(3))
  };
}

/** Soft padding: follow-up topic already the emotional gist of bubble1. */
function topIsSoftPadding(candidate, primaryJoined) {
  if (!candidate?.candidate_topic) return false;
  const topic = compactText(String(candidate.candidate_topic)).slice(0, 12);
  const primary = compactText(String(primaryJoined ?? ""));
  if (!topic || !primary) return false;
  // same emotional reassurance already expressed
  if (/(?:不用证明|待着就|没事|放心|我一直|不会走|不会不理)/.test(String(primaryJoined)) &&
      /(?:证明|待着|放心|一直|不理|走)/.test(String(candidate.candidate_topic))) {
    return true;
  }
  return false;
}

/** In-process idempotency for at-most-one follow-up per parent turn. */
export class PostMessageRegistry {
  constructor() {
    this.entries = new Map();
  }
  key(parentTurnId) {
    return String(parentTurnId ?? "").slice(0, 160);
  }
  begin(parentTurnId) {
    const key = this.key(parentTurnId);
    if (this.entries.has(key)) return { ok: false, reason: "already_started", entry: this.entries.get(key) };
    const entry = {
      parent_turn_id: key,
      attempt_key: postMessageAttemptKey(key, 1),
      state: "PENDING",
      created_at: new Date().toISOString()
    };
    this.entries.set(key, entry);
    return { ok: true, entry };
  }
  mark(parentTurnId, state, patch = {}) {
    const entry = this.entries.get(this.key(parentTurnId));
    if (!entry) return null;
    Object.assign(entry, patch, { state, updated_at: new Date().toISOString() });
    return entry;
  }
  get(parentTurnId) {
    return this.entries.get(this.key(parentTurnId)) ?? null;
  }
  isStale(parentTurnId, latestUserMessageId, parentUserMessageId) {
    if (latestUserMessageId == null || parentUserMessageId == null) return false;
    return Number(latestUserMessageId) > Number(parentUserMessageId);
  }
  prune(keep = 100) {
    if (this.entries.size <= keep) return;
    const items = [...this.entries.entries()].sort((a, b) => String(b[1].updated_at ?? b[1].created_at).localeCompare(String(a[1].updated_at ?? a[1].created_at)));
    for (const [key] of items.slice(keep)) this.entries.delete(key);
  }
}

export const defaultPostMessageRegistry = new PostMessageRegistry();

export function latencyPush(list, ms) {
  if (!Array.isArray(list) || !Number.isFinite(ms)) return;
  list.push(Math.round(ms));
  if (list.length > 200) list.shift();
}

export function latencySummary(list) {
  const values = (list ?? []).filter(x => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!values.length) return { count: 0, p50: null, p95: null, max: null };
  const p = (q) => values[Math.min(values.length - 1, Math.floor(q * (values.length - 1)))];
  return {
    count: values.length,
    p50: p(0.5),
    p95: p(0.95),
    max: values[values.length - 1]
  };
}

export function snapshotPostMessageDiagnostics() {
  return {
    ...postMessageDiagnostics,
    firstBubbleLatency: latencySummary(postMessageDiagnostics.firstBubbleLatencyMs),
    postMessageDecisionLatency: latencySummary(postMessageDiagnostics.postMessageDecisionLatencyMs),
    followupGenerationLatency: latencySummary(postMessageDiagnostics.followupGenerationLatencyMs),
    limits: postMessageLimits()
  };
}

export function buildFollowupPrompt({ userText, primaryText, decision }) {
  const reason = decision?.reason_code ?? "afterthought";
  const topic = decision?.candidate_topic ?? "";
  return [
    "【Post-message｜只有新的 conversational impulse 才说第二句】",
    "Bubble1 的 impulse 已经完成。第二句必须是新的 impulse（callback / 新的好奇 / 真的新念头），不是补完整、不是安慰尾巴、不是收尾。",
    "如果没有新 impulse，输出空字符串。",
    "禁止：反正你不用证明什么 / 待着就行 / 有事叫我 / 再接一句温柔结论。",
    "可以：对了，你昨天那事怎么样了？ / 等等，那你刚才说的那个呢？",
    "要求：最多 1–2 句；不要复述第一句；不要解释你在思考。",
    `user: ${String(userText ?? "").slice(0, 400)}`,
    `bubble1: ${String(primaryText ?? "").slice(0, 600)}`,
    `afterthought_reason: ${reason}`,
    topic ? `afterthought_topic: ${topic}` : "",
    "只输出 afterthought 文本本身。"
  ].filter(Boolean).join("\n");
}

export function shortJitter(seed = "") {
  const [lo, hi] = postMessageLimits().short_jitter_ms;
  const h = crypto.createHash("sha1").update(String(seed)).digest();
  const n = h.readUInt16BE(0) / 0xffff;
  return Math.round(lo + (hi - lo) * n);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Orchestrate at most one true post-message follow-up AFTER primary delivery.
 * Primary success must not depend on this function.
 */
export async function runPostMessagePhase({
  parentTurnId,
  parentUserMessageId = null,
  sessionId,
  source = "chat",
  userText = "",
  primaryText = "",
  primaryBubbles = [],
  closureLikely = false,
  userLeaving = false,
  silenceRequested = false,
  isProactive = false,
  contactSuppressed = false,
  recentFollowupCount = 0,
  gateInputs = {},
  generateFollowup = null,
  deliverFollowup = null,
  deliverFollowupOnEmit = null,
  userInterrupted = null,
  getLatestUserMessageId = null,
  signal = null,
  registry = defaultPostMessageRegistry,
  findDurableFollowup = null,
  now = () => Date.now()
} = {}) {
  const started = now();
  postMessageDiagnostics.primaryTurnCount++;
  postMessageDiagnostics.legacySplitBubbleCount += Math.max(0, (primaryBubbles.length || 1) - 1);

  // Durable idempotency BEFORE any generation: restart-safe across process wipes.
  const attemptKey = postMessageAttemptKey(parentTurnId, 1);
  let durable = null;
  if (typeof findDurableFollowup === "function") {
    try { durable = findDurableFollowup(attemptKey); } catch { durable = null; }
  }
  if (durable?.id != null) {
    postMessageDiagnostics.durableLookupHit++;
    postMessageDiagnostics.duplicateFollowupAfterRestart++;
    registry.mark?.(parentTurnId, "ALREADY_DURABLE", { message_id: durable.id, attempt_key: attemptKey });
    return {
      delivered: false,
      decision: null,
      message: null,
      reason: "ALREADY_DURABLE",
      attempt_key: attemptKey,
      durable_message_id: Number(durable.id)
    };
  }
  postMessageDiagnostics.durableLookupMiss++;

  const gateStarted = now();
  const decision = evaluatePostMessageGate({
    userText,
    primaryText,
    primaryBubbles,
    closureLikely,
    userLeaving,
    silenceRequested,
    isProactive,
    contactSuppressed,
    recentFollowupCount,
    ...gateInputs
  });
  latencyPush(postMessageDiagnostics.postMessageDecisionLatencyMs, now() - gateStarted);
  postMessageDiagnostics.lastDecision = decision.should_follow_up ? "FOLLOWUP_CANDIDATE" : "NO_FOLLOWUP";
  postMessageDiagnostics.lastReason = decision.reason_code;

  if (!decision.should_follow_up) {
    postMessageDiagnostics.noFollowupCount++;
    if (closureLikely || userLeaving) {
      // counted only when we would have otherwise considered follow-up
    }
    return { delivered: false, decision, message: null, reason: decision.reason_code };
  }

  postMessageDiagnostics.postMessageEligibleCount++;
  postMessageDiagnostics.postMessageCandidateCount++;

  const startedEntry = registry.begin(parentTurnId);
  if (!startedEntry.ok) {
    postMessageDiagnostics.suppressedByStaleTurn++;
    return { delivered: false, decision, message: null, reason: "already_started", attempt_key: attemptKey };
  }
  registry.mark(parentTurnId, "DECIDED", { decision });

  if (typeof userInterrupted === "function" && userInterrupted()) {
    registry.mark(parentTurnId, "CANCELLED", { reason: "user_interrupted" });
    postMessageDiagnostics.suppressedByUserInterrupt++;
    postMessageDiagnostics.staleFollowupAfterUserInterrupt++;
    return { delivered: false, decision, message: null, reason: "user_interrupted" };
  }

  try {
    const jitter = shortJitter(`${parentTurnId}|${decision.reason_code}`);
    if (jitter > 0) await sleep(jitter, signal);

    if (typeof userInterrupted === "function" && userInterrupted()) {
      registry.mark(parentTurnId, "CANCELLED", { reason: "user_interrupted" });
      postMessageDiagnostics.suppressedByUserInterrupt++;
      postMessageDiagnostics.staleFollowupAfterUserInterrupt++;
      return { delivered: false, decision, message: null, reason: "user_interrupted" };
    }

    const latestId = typeof getLatestUserMessageId === "function" ? getLatestUserMessageId() : null;
    if (registry.isStale(parentTurnId, latestId, parentUserMessageId)) {
      registry.mark(parentTurnId, "DROPPED_STALE", { latest_user_message_id: latestId });
      postMessageDiagnostics.suppressedByStaleTurn++;
      postMessageDiagnostics.staleFollowupAfterUserInterrupt++;
      return { delivered: false, decision, message: null, reason: "stale_turn" };
    }

    registry.mark(parentTurnId, "GENERATING");
    const genStarted = now();
    postMessageDiagnostics.followupGenerateCount++;
    const raw = typeof generateFollowup === "function" ? await generateFollowup(decision) : "";
    latencyPush(postMessageDiagnostics.followupGenerationLatencyMs, now() - genStarted);
    const text = String(raw ?? "").trim().replace(/^<\|.*?\|>$/g, "").trim();
    if (!text || text === "<|eos|>" || /^<\|.*\|>$/.test(text)) {
      registry.mark(parentTurnId, "NO_OUTPUT");
      postMessageDiagnostics.noFollowupCount++;
      return { delivered: false, decision, message: null, reason: "empty_followup" };
    }
    if (isSemanticDuplicate(primaryText || primaryBubbles.join("\n"), text)) {
      registry.mark(parentTurnId, "SUPPRESSED_DUPLICATE", { preview: text.slice(0, 80) });
      postMessageDiagnostics.suppressedByDuplicate++;
      postMessageDiagnostics.postMessageDuplicateCount++;
      return { delivered: false, decision, message: null, reason: "duplicate" };
    }

    if (typeof userInterrupted === "function" && userInterrupted()) {
      registry.mark(parentTurnId, "CANCELLED", { reason: "user_interrupted_before_delivery" });
      postMessageDiagnostics.suppressedByUserInterrupt++;
      postMessageDiagnostics.staleFollowupAfterUserInterrupt++;
      return { delivered: false, decision, message: null, reason: "user_interrupted" };
    }

    const message = typeof deliverFollowup === "function"
      ? await deliverFollowup({ text, decision, attemptKey: attemptKey || startedEntry.entry.attempt_key, onEmit: deliverFollowupOnEmit })
      : { messageId: null, text };
    if (message?.messageId == null) {
      postMessageDiagnostics.partialDurable++;
      registry.mark(parentTurnId, "PARTIAL_DURABLE", { text: text.slice(0, 80) });
      return { delivered: false, decision, message: null, reason: "partial_durable", attempt_key: attemptKey };
    }
    postMessageDiagnostics.followupDeliverCount++;
    registry.mark(parentTurnId, "SENT", { message_id: message?.messageId ?? null, text: text.slice(0, 120) });
    postMessageDiagnostics.postMessageGeneratedCount++;
    postMessageDiagnostics.postMessageSentCount++;
    postMessageDiagnostics.truePostMessageBubbleCount++;
    if (closureLikely) postMessageDiagnostics.followupAfterClosureCount++;
    return { delivered: true, decision, message: { ...message, text }, reason: decision.reason_code };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    registry.mark(parentTurnId, aborted ? "CANCELLED" : "PROVIDER_FAILURE", {
      error: String(error?.message ?? error).slice(0, 120)
    });
    if (aborted) {
      postMessageDiagnostics.suppressedByUserInterrupt++;
    } else {
      postMessageDiagnostics.followupProviderFailure++;
    }
    return { delivered: false, decision, message: null, reason: aborted ? "aborted" : "provider_failure", error };
  } finally {
    registry.prune(200);
  }
}
