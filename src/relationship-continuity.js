/**
 * Relationship Continuity v1 — lightweight recent relationship impressions.
 * Internal cognition context only. Context ≠ Required Mention.
 * No schema bump: durable JSON sidecar.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const HOUR_MS = 3600_000;
const MAX_IMPRESSIONS = 24;

export const IMPRESSION_TYPES = Object.freeze({
  UNANSWERED_OUTREACH: "unanswered_outreach",
  USER_HAS_BEEN_QUIET: "user_has_been_quiet",
  USER_RECENTLY_BUSY: "user_recently_busy",
  REPEATED_BROKEN_EXPECTATION: "repeated_broken_expectation",
  RECENT_WARM_INTERACTION: "recent_warm_interaction",
  RECENT_DISTANCE: "recent_distance",
  RECENT_REPAIR: "recent_repair",
  EXPLAINED_ABSENCE: "explained_absence",
  SOCIAL_EXPECTATION_WAITING: "social_expectation_waiting"
});

const DEFAULT_DECAY_HOURS = {
  unanswered_outreach: 36,
  user_has_been_quiet: 24,
  user_recently_busy: 48,
  repeated_broken_expectation: 72,
  recent_warm_interaction: 24,
  recent_distance: 36,
  recent_repair: 36,
  explained_absence: 48,
  social_expectation_waiting: 24
};

function iso(d = new Date()) {
  return (d instanceof Date ? d : new Date(d)).toISOString();
}
function finite(v) {
  const t = Date.parse(v ?? "");
  return Number.isFinite(t) ? t : null;
}
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, Number(v) || 0));
}
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function defaultDocument(now) {
  return {
    version: 1,
    updated_at: now,
    last_outreach: null,
    impressions: [],
    counters: {
      outreach_sent: 0,
      outreach_answered: 0,
      outreach_unanswered: 0,
      impressions_created: 0,
      impressions_resolved: 0
    }
  };
}

function normalize(raw, now) {
  const base = defaultDocument(now);
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    ...base,
    ...src,
    version: 1,
    last_outreach: src.last_outreach && typeof src.last_outreach === "object" ? src.last_outreach : null,
    impressions: Array.isArray(src.impressions) ? src.impressions.slice(-MAX_IMPRESSIONS * 2) : [],
    counters: { ...base.counters, ...(src.counters ?? {}) },
    updated_at: now
  };
}

export class RelationshipContinuityStore {
  constructor({ file = null, now = () => new Date() } = {}) {
    this.file = file || path.resolve(path.dirname(config.companionStatePath), "relationship-continuity.json");
    this.now = now;
    this.document = defaultDocument(iso(this.now()));
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const raw = readJson(this.file, null);
    if (raw) this.document = normalize(raw, iso(this.now()));
  }

  save() {
    if (!this.file) return;
    this.document.updated_at = iso(this.now());
    // prune expired before write
    this.prune();
    atomicWrite(this.file, this.document);
  }

  prune(at = this.now()) {
    const now = (at instanceof Date ? at : new Date(at)).getTime();
    this.document.impressions = this.document.impressions
      .map((imp) => this.applyDecay(imp, now))
      .filter((imp) => imp && imp.state === "active")
      .slice(-MAX_IMPRESSIONS);
  }

  applyDecay(imp, nowMs) {
    if (!imp) return null;
    if (imp.state !== "active") return imp;
    const created = finite(imp.created_at) ?? nowMs;
    const decayHours = Number(imp.decay_hours) > 0 ? Number(imp.decay_hours) : (DEFAULT_DECAY_HOURS[imp.type] ?? 24);
    const ageH = Math.max(0, (nowMs - created) / HOUR_MS);
    if (ageH >= decayHours) {
      return { ...imp, state: "resolved", resolved_at: iso(new Date(nowMs)), resolution_reason: "decay" };
    }
    const strength = Number(imp.strength ?? 0.5) * Math.pow(0.5, ageH / Math.max(1, decayHours));
    return { ...imp, strength: Number(strength.toFixed(4)) };
  }

  activeImpressions(at = this.now()) {
    const now = (at instanceof Date ? at : new Date(at)).getTime();
    return this.document.impressions
      .map((imp) => this.applyDecay(imp, now))
      .filter((imp) => imp && imp.state === "active")
      .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));
  }

  findByType(type, at = this.now()) {
    return this.activeImpressions(at).filter((i) => i.type === type);
  }

  noteImpression({
    type,
    strength = 0.5,
    confidence = 0.7,
    source = null,
    metadata = null,
    decayHours = null
  } = {}, at = this.now()) {
    const t = String(type ?? "").trim();
    if (!t || !Object.values(IMPRESSION_TYPES).includes(t)) return null;
    const date = at instanceof Date ? at : new Date(at);
    // supersede same type unless stacking unanswered_outreach (count)
    const existing = this.document.impressions.find((i) => i.state === "active" && i.type === t);
    if (existing && t !== IMPRESSION_TYPES.UNANSWERED_OUTREACH && t !== IMPRESSION_TYPES.REPEATED_BROKEN_EXPECTATION) {
      existing.strength = Math.max(Number(existing.strength ?? 0), clamp(strength, 0, 1));
      existing.confidence = Math.max(Number(existing.confidence ?? 0), clamp(confidence, 0, 1));
      existing.last_touched_at = iso(date);
      if (source) existing.source = { ...(existing.source ?? {}), ...source };
      if (metadata) existing.metadata = { ...(existing.metadata ?? {}), ...metadata };
      this.save();
      return structuredClone(existing);
    }
    const imp = {
      id: `imp_${crypto.randomBytes(5).toString("hex")}`,
      type: t,
      strength: clamp(strength, 0, 1),
      confidence: clamp(confidence, 0, 1),
      created_at: iso(date),
      last_touched_at: iso(date),
      decay_hours: Number(decayHours) > 0 ? Number(decayHours) : (DEFAULT_DECAY_HOURS[t] ?? 24),
      state: "active",
      source: source ?? null,
      metadata: metadata ?? null
    };
    this.document.impressions.push(imp);
    this.document.counters.impressions_created = (this.document.counters.impressions_created ?? 0) + 1;
    this.save();
    return structuredClone(imp);
  }

  resolveImpressions({ types = [], reason = "user_return", exceptTypes = [] } = {}, at = this.now()) {
    const date = at instanceof Date ? at : new Date(at);
    const wanted = new Set(types.map(String));
    const except = new Set(exceptTypes.map(String));
    const resolved = [];
    for (const imp of this.document.impressions) {
      if (imp.state !== "active") continue;
      if (except.has(imp.type)) continue;
      if (wanted.size && !wanted.has(imp.type)) continue;
      imp.state = "resolved";
      imp.resolved_at = iso(date);
      imp.resolution_reason = String(reason).slice(0, 80);
      resolved.push(imp.id);
    }
    if (resolved.length) {
      this.document.counters.impressions_resolved = (this.document.counters.impressions_resolved ?? 0) + resolved.length;
      this.save();
    }
    return resolved;
  }

  /**
   * Companion proactive send. Optionally expects a reply (question / concern).
   */
  noteOutreachSent({
    messageId = null,
    attemptKey = null,
    reason = "unknown",
    topic = null,
    expectsReply = false,
    tone = null
  } = {}, at = this.now()) {
    const date = at instanceof Date ? at : new Date(at);
    const outreach = {
      message_id: messageId != null ? Number(messageId) : null,
      attempt_key: attemptKey ? String(attemptKey).slice(0, 160) : null,
      reason: String(reason).slice(0, 80),
      topic: topic ? String(topic).slice(0, 120) : null,
      expects_reply: Boolean(expectsReply),
      tone: tone ? String(tone).slice(0, 40) : null,
      sent_at: iso(date),
      answered: false,
      answered_at: null
    };
    this.document.last_outreach = outreach;
    this.document.counters.outreach_sent = (this.document.counters.outreach_sent ?? 0) + 1;
    if (expectsReply) {
      this.noteImpression({
        type: IMPRESSION_TYPES.UNANSWERED_OUTREACH,
        strength: 0.55,
        confidence: 0.75,
        source: { message_id: outreach.message_id, attempt_key: outreach.attempt_key },
        metadata: { reason, topic, tone, unanswered_hours: 0 }
      }, date);
      this.noteImpression({
        type: IMPRESSION_TYPES.SOCIAL_EXPECTATION_WAITING,
        strength: 0.5,
        confidence: 0.65,
        source: { attempt_key: outreach.attempt_key },
        metadata: { reason, topic }
      }, date);
      this.document.counters.outreach_unanswered = (this.document.counters.outreach_unanswered ?? 0) + 1;
    }
    this.save();
    return structuredClone(outreach);
  }

  /** User came back. Resolve answered outreach; keep residual if not a warm repair. */
  noteUserInteraction({ text = "", warm = false, explainedAbsence = false, busy = false } = {}, at = this.now()) {
    const date = at instanceof Date ? at : new Date(at);
    const last = this.document.last_outreach;
    if (last && !last.answered && last.expects_reply) {
      last.answered = true;
      last.answered_at = iso(date);
      this.document.counters.outreach_answered = (this.document.counters.outreach_answered ?? 0) + 1;
    }
    // Resolve waiting social expectation; unanswered_outreach softens but may linger as residual
    this.resolveImpressions({
      types: [IMPRESSION_TYPES.SOCIAL_EXPECTATION_WAITING, IMPRESSION_TYPES.USER_HAS_BEEN_QUIET],
      reason: "user_return"
    }, date);
    if (warm) {
      this.resolveImpressions({
        types: [IMPRESSION_TYPES.UNANSWERED_OUTREACH, IMPRESSION_TYPES.RECENT_DISTANCE],
        reason: "warm_interaction"
      }, date);
      this.noteImpression({
        type: IMPRESSION_TYPES.RECENT_WARM_INTERACTION,
        strength: 0.45,
        confidence: 0.7,
        source: { kind: "user_return" }
      }, date);
    }
    if (explainedAbsence || busy) {
      this.noteImpression({
        type: IMPRESSION_TYPES.EXPLAINED_ABSENCE,
        strength: 0.6,
        confidence: 0.8,
        source: { kind: explainedAbsence ? "explicit_explanation" : "busy" },
        metadata: { sample: String(text).slice(0, 80) }
      }, date);
      this.noteImpression({
        type: IMPRESSION_TYPES.USER_RECENTLY_BUSY,
        strength: 0.55,
        confidence: 0.75,
        metadata: { sample: String(text).slice(0, 80) }
      }, date);
      // Explained: drop hard unanswered anger path
      this.resolveImpressions({
        types: [IMPRESSION_TYPES.UNANSWERED_OUTREACH],
        reason: "explained_absence"
      }, date);
    }
    if (!warm && !explainedAbsence && !busy) {
      // Neutral return still resolves quiet; keep mild residual unanswered if any
      const unanswered = this.findByType(IMPRESSION_TYPES.UNANSWERED_OUTREACH, date);
      for (const imp of unanswered) {
        imp.strength = clamp((imp.strength ?? 0.5) * 0.72, 0, 1);
        imp.last_touched_at = iso(date);
        imp.metadata = { ...(imp.metadata ?? {}), softened_on_return: true };
      }
    }
    this.save();
  }

  snapshot(at = this.now()) {
    const impressions = this.activeImpressions(at);
    return {
      version: 1,
      last_outreach: this.document.last_outreach ? structuredClone(this.document.last_outreach) : null,
      impressions: impressions.map((i) => ({
        id: i.id,
        type: i.type,
        strength: Number(i.strength ?? 0),
        confidence: Number(i.confidence ?? 0),
        created_at: i.created_at,
        decay_hours: i.decay_hours
      })),
      counters: structuredClone(this.document.counters),
      updated_at: this.document.updated_at
    };
  }
}

export const relationshipContinuity = new RelationshipContinuityStore();

/** True when last outreach expects reply and user has not answered yet. */
export function hasUnansweredOutreach(at = new Date()) {
  const last = relationshipContinuity.document.last_outreach;
  if (!last?.expects_reply || last.answered) {
    // still count active unanswered_outreach impressions
    return relationshipContinuity.findByType(IMPRESSION_TYPES.UNANSWERED_OUTREACH, at).length > 0;
  }
  return true;
}

export function unansweredOutreachHours(at = new Date()) {
  const last = relationshipContinuity.document.last_outreach;
  const imps = relationshipContinuity.findByType(IMPRESSION_TYPES.UNANSWERED_OUTREACH, at);
  const anchors = [];
  if (last?.expects_reply && !last.answered && last.sent_at) anchors.push(finite(last.sent_at));
  for (const imp of imps) anchors.push(finite(imp.created_at));
  const valid = anchors.filter(Number.isFinite);
  if (!valid.length) return 0;
  const oldest = Math.min(...valid);
  const now = (at instanceof Date ? at : new Date(at)).getTime();
  return Math.max(0, (now - oldest) / HOUR_MS);
}
