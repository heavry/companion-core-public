/**
 * Memory Accessibility / Active Memory v1
 *
 * Answers: among already-relevant memories, which one is easiest to recall now?
 * Event Association explains "why this came to mind"; accessibility ranks the set.
 * Memory Gate remains the final injection gate (usually 0–2).
 *
 * Design constraints:
 * - explainable lightweight score (no NN / no Bayesian model)
 * - dynamic decay at read time (never scan the full store)
 * - reuse is log/capped so hot memories cannot dominate forever
 * - recency and emotion are modifiers only
 * - low confidence is suppressed
 * - retired/superseded stay blocked by Memory Gate
 * - reinforce only on true activation (selected / explicit recall), not mere retrieval
 */

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;
const HALF_LIFE_DAYS = 21;
const REUSE_CAP = 0.22;
const EMOTION_CAP = 0.35;
const DOMINATION_WINDOW = 6;
const DOMINATION_COOLDOWN_MS = 2 * HOUR_MS;
const ACTIVE_MEMORY_MAX = 64;

export const memoryAccessibilityDiagnostics = {
  accessibilityCandidateCount: 0,
  activatedMemoryCount: 0,
  zeroActiveMemoryRounds: 0,
  topActivationScore: 0,
  lastActivationSource: null,
  reinforcementCount: 0,
  decayAppliedCount: 0,
  retiredHighActivationBlocked: 0,
  lowConfidenceSuppressionCount: 0,
  repeatedMemoryDominationCount: 0,
  wrongMemoryMentionCount: 0,
  lastRoundTopId: null,
  lastRoundScores: [],
  lastReasons: []
};

export function resetMemoryAccessibilityDiagnostics() {
  for (const key of Object.keys(memoryAccessibilityDiagnostics)) {
    memoryAccessibilityDiagnostics[key] = key === "lastRoundScores" || key === "lastReasons" ? [] : key === "lastActivationSource" || key === "lastRoundTopId" ? null : 0;
  }
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function finiteTime(value) {
  if (value == null) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function ageDays(atMs, ts) {
  const t = finiteTime(ts);
  if (t == null) return 90;
  return Math.max(0, (atMs - t) / DAY_MS);
}

/** Recency modifier — recent chatter must not beat older high-importance decisions alone. */
export function recencyModifier(timestamp, atMs = Date.now()) {
  const age = ageDays(atMs, timestamp);
  return 1 / (1 + age / 14);
}

/** Last-access recency is a small bonus, not a hard requirement. */
export function lastAccessModifier(lastAccessedAt, atMs = Date.now()) {
  const t = finiteTime(lastAccessedAt);
  if (t == null) return 0.35;
  const ageH = Math.max(0, (atMs - t) / HOUR_MS);
  return Math.max(0, 1 - Math.min(1, ageH / (7 * 24)));
}

/** Log + cap so access_count cannot grow linearly into permanent top rank. */
export function reuseBoost(accessCount = 0) {
  const n = Math.max(0, Number(accessCount) || 0);
  return Math.min(REUSE_CAP, Math.log1p(n) / 8);
}

/** Read-time decay. Never scan the store; just damp idle memories at compute time. */
export function timeDecay(lastActivatedAt, atMs = Date.now(), importance = 0.5) {
  const t = finiteTime(lastActivatedAt);
  const idleDays = t == null ? 30 : Math.max(0, (atMs - t) / DAY_MS);
  // High-importance decisions decay more slowly than casual chatter.
  const halfLife = HALF_LIFE_DAYS * (0.55 + 0.9 * clamp01(importance));
  const decay = Math.pow(0.5, idleDays / halfLife);
  if (idleDays > 0.25) memoryAccessibilityDiagnostics.decayAppliedCount++;
  return decay;
}

/**
 * Emotional strength from a cause list (Natural Presence emotion_state.causes).
 * Match by source_message_id / event_id; intensity is itself time-decayed.
 */
export function emotionalStrength(memory, emotionState, atMs = Date.now()) {
  if (!emotionState || !memory) return 0;
  const intensity = clamp01(emotionState.intensity ?? emotionState.residual ?? 0);
  if (intensity < 0.12) return 0;
  const causes = Array.isArray(emotionState.causes) ? emotionState.causes : [];
  const memSource = memory.source_message_id == null ? null : String(memory.source_message_id);
  const memId = memory.id == null ? null : String(memory.id);
  let hit = false;
  let causeAt = finiteTime(emotionState.onset_at) ?? finiteTime(emotionState.last_reinforced_at) ?? atMs;
  for (const cause of causes) {
    const cid = cause?.event_id == null ? null : String(cause.event_id);
    if (memSource && cid && (cid === memSource || cid.endsWith(`:${memSource}`) || memSource.endsWith(cid))) {
      hit = true;
      causeAt = finiteTime(cause.at) ?? causeAt;
      break;
    }
  }
  // Soft link: emotional residual can still lift a memory whose source is the
  // active emotional episode only when explicitly matched — never a blanket boost.
  if (!hit) return 0;
  const age = ageDays(atMs, new Date(causeAt).toISOString());
  const emotionDecay = Math.pow(0.5, age / 7);
  return Math.min(EMOTION_CAP, intensity * emotionDecay * EMOTION_CAP * 2);
}

/** Low confidence is suppressed so uncertain crumbs cannot outrank confirmed facts. */
export function confidencePenalty(confidence) {
  const c = clamp01(confidence ?? 0.7);
  if (c < 0.55) {
    memoryAccessibilityDiagnostics.lowConfidenceSuppressionCount++;
    return 0.55 + c * 0.4;
  }
  return 0.85 + (c - 0.55) * 0.35;
}

/**
 * Domination cooldown: if the same memory has topped recent rounds, apply a
 * temporary damp so other relevant candidates can surface (anti-echo-chamber).
 */
function dominationFactor(memoryId, activeState, atMs) {
  if (!memoryId || !activeState) return 1;
  const entry = activeState.get(String(memoryId));
  if (!entry?.domination_hits) return 1;
  const last = finiteTime(entry.last_activated_at);
  if (last != null && atMs - last < DOMINATION_COOLDOWN_MS && entry.domination_hits >= DOMINATION_WINDOW) {
    memoryAccessibilityDiagnostics.repeatedMemoryDominationCount++;
    return 0.72;
  }
  return 1;
}

/**
 * Explainable activation score in [0,1].
 * `row` may be a retrieve row ({memory, text_score, association,...}) or a bare memory.
 */
export function scoreMemoryActivation(row, {
  query = "",
  emotionState = null,
  at = Date.now(),
  associationActivation = null,
  relevance = null,
  activeState = null,
  userExplicitRecall = false
} = {}) {
  const memory = row?.memory ?? row;
  if (!memory?.id) return 0;
  if (memory.status && memory.status !== "active") {
    memoryAccessibilityDiagnostics.retiredHighActivationBlocked++;
    return 0;
  }
  if (memory.temporal_state === "historical") {
    memoryAccessibilityDiagnostics.retiredHighActivationBlocked++;
    return 0;
  }

  const atMs = at instanceof Date ? at.getTime() : Number(at) || Date.now();
  const assoc = associationActivation != null
    ? clamp01(associationActivation)
    : (row?.association?.activation_score != null ? clamp01(row.association.activation_score) : 0);
  const lexical = relevance != null ? clamp01(relevance) : clamp01(row?.text_score ?? row?.lexical ?? 0);
  const direct = Math.max(lexical, assoc);
  const recency = recencyModifier(memory.updated_at ?? memory.created_at, atMs);
  const importance = clamp01(memory.importance ?? 0.5);
  const emotion = emotionalStrength(memory, emotionState, atMs);
  const confidence = clamp01(memory.confidence ?? 0.7);
  const reuse = reuseBoost(memory.access_count);
  const lastAccess = lastAccessModifier(memory.last_accessed_at, atMs);
  const idleSource = memory.last_accessed_at ?? memory.updated_at ?? memory.created_at;
  const decay = timeDecay(idleSource, atMs, importance);
  const stable = (memory.type === "relationship" || memory.type === "persona" || memory.pinned) ? 0.06 : 0;

  // Recency is only a modifier. Importance must be able to beat a fresh casual line
  // and a high-frequency minor topic. Reuse stays tiny + capped.
  let base =
    0.30 * direct +
    0.10 * recency +
    0.30 * importance +
    0.12 * emotion +
    0.10 * confidence +
    0.04 * (reuse / REUSE_CAP) +
    0.03 * lastAccess +
    stable;

  if (userExplicitRecall) base = Math.max(base, 0.78);

  let score = clamp01(base) * Math.max(0.2, decay) * confidencePenalty(confidence);
  score *= dominationFactor(memory.id, activeState, atMs);
  score = clamp01(score);

  return score;
}

/** Lightweight active-memory state. Runtime only; durable truth stays on access_count/last_accessed_at. */
export class ActiveMemoryState {
  constructor(limit = ACTIVE_MEMORY_MAX) {
    this.limit = limit;
    this.map = new Map();
  }

  get(id) {
    return this.map.get(String(id)) ?? null;
  }

  /**
   * True activation only (selected for generation / explicit recall).
   * candidate retrieval must NOT call this.
   */
  reinforce(memoryId, { activation = 0, reason = "selected", at = Date.now() } = {}) {
    const key = String(memoryId);
    const prev = this.map.get(key);
    const nowIso = new Date(at).toISOString();
    // Saturating bump: diminishing returns on repeated hits.
    const nextBase = prev ? Math.min(1, Number(prev.activation) * 0.65 + clamp01(activation) * 0.35) : clamp01(activation);
    const dominationHits = prev && Number(prev.activation) >= 0.55 && clamp01(activation) >= 0.55
      ? Number(prev.domination_hits ?? 0) + 1
      : 0;
    const entry = {
      memory_id: key,
      activation: Number(nextBase.toFixed(4)),
      last_activated_at: nowIso,
      activation_reason: reason,
      domination_hits: dominationHits
    };
    this.map.delete(key);
    this.map.set(key, entry);
    if (this.map.size > this.limit) {
      // Drop coolest entry (Map preserves insertion order; re-insert on reinforce).
      const oldest = this.map.keys().next().value;
      if (oldest !== key) this.map.delete(oldest);
    }
    memoryAccessibilityDiagnostics.reinforcementCount++;
    return entry;
  }

  snapshot() {
    return [...this.map.values()];
  }
}

export const defaultActiveMemory = new ActiveMemoryState();

/**
 * Rank already-relevant candidates by accessibility.
 * Does not inject; Memory Gate still applies its own hard filters and limit.
 */
export function rankByAccessibility(rows = [], options = {}) {
  const {
    at = Date.now(),
    emotionState = null,
    activeState = defaultActiveMemory,
    userExplicitRecall = false,
    topSource = "association"
  } = options;

  memoryAccessibilityDiagnostics.accessibilityCandidateCount += rows.length;

  const scored = rows.map(row => {
    const memory = row?.memory ?? row;
    const activation = scoreMemoryActivation(row, {
      ...options,
      at,
      emotionState,
      activeState,
      userExplicitRecall,
      associationActivation: row?.association?.activation_score,
      relevance: row?.selection_score ?? row?.relevance ?? row?.text_score
    });
    return { row, memory, activation };
  }).filter(x => x.memory?.id);

  scored.sort((a, b) => b.activation - a.activation || String(a.memory.id).localeCompare(String(b.memory.id)));

  const top = scored[0] ?? null;
  if (!top || top.activation <= 0) {
    memoryAccessibilityDiagnostics.zeroActiveMemoryRounds++;
  } else {
    memoryAccessibilityDiagnostics.activatedMemoryCount++;
    memoryAccessibilityDiagnostics.topActivationScore = Math.max(
      memoryAccessibilityDiagnostics.topActivationScore,
      top.activation
    );
    memoryAccessibilityDiagnostics.lastActivationSource = topSource;
    memoryAccessibilityDiagnostics.lastRoundTopId = String(top.memory.id);
  }
  memoryAccessibilityDiagnostics.lastRoundScores = scored.slice(0, 5).map(x => ({
    id: String(x.memory.id),
    activation: Number(x.activation.toFixed(3)),
    content: String(x.memory.content ?? "").slice(0, 60)
  }));
  memoryAccessibilityDiagnostics.lastReasons = memoryAccessibilityDiagnostics.lastRoundScores;

  return scored;
}

export function accessibilityLimits() {
  return {
    half_life_days: HALF_LIFE_DAYS,
    reuse_cap: REUSE_CAP,
    emotion_cap: EMOTION_CAP,
    domination_window: DOMINATION_WINDOW,
    domination_cooldown_ms: DOMINATION_COOLDOWN_MS
  };
}
