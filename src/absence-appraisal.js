/**
 * Absence Appraisal v1
 * Silence duration is evidence, never a mechanical send reason.
 * Combines relationship continuity + closeness + leave/busy + expectations
 * into mixed appraisal (concern / annoyance / hurt can coexist).
 */
import {
  IMPRESSION_TYPES,
  relationshipContinuity,
  unansweredOutreachHours
} from "./relationship-continuity.js";

const HOUR_MS = 3600_000;

export const ABSENCE_REASONS = Object.freeze({
  NO_CONCERN: "no_concern",
  ABSENCE_NOTICE: "absence_notice",
  UNANSWERED_OUTREACH: "unanswered_outreach",
  EXPECTATION_ABSENCE: "expectation_absence",
  CONCERN_ABSENCE: "concern_absence",
  RELATIONSHIP_DISTANCE: "relationship_distance",
  EXPLAINED_ABSENCE: "explained_absence"
});

export const absenceAppraisalDiagnostics = {
  absenceWakeCount: 0,
  absenceAppraisalCount: 0,
  unexpectedAbsenceCount: 0,
  explainedAbsenceCount: 0,
  unansweredOutreachCount: 0,
  proactiveAfterUnansweredOutreach: 0,
  suppressedByExplicitLeave: 0,
  suppressedByKnownBusy: 0,
  absenceDrivenEmotionCauseCount: 0,
  neutralResetAfterUnansweredOutreach: 0,
  repeatedGenericCheckinCount: 0,
  absenceTemplateRepetitionCount: 0,
  lastAppraisal: null
};

export function resetAbsenceAppraisalDiagnostics() {
  for (const key of Object.keys(absenceAppraisalDiagnostics)) {
    if (key === "lastAppraisal") absenceAppraisalDiagnostics[key] = null;
    else absenceAppraisalDiagnostics[key] = 0;
  }
}

export function snapshotAbsenceAppraisalDiagnostics() {
  return structuredClone(absenceAppraisalDiagnostics);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function hoursBucket(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return "unknown";
  if (n < 6) return "lt6h";
  if (n < 12) return "6_12h";
  if (n < 20) return "12_20h";
  if (n < 30) return "20_30h";
  if (n < 40) return "30_40h";
  return "gte40h";
}

/**
 * Structured absence appraisal. Pure function over provided snapshot.
 */
export function appraiseAbsence({
  silenceHours = null,
  closeness = 0.6,
  previousOutreachCount = 0,
  unansweredHours = null,
  explicitLeave = false,
  knownBusy = false,
  pendingExpectation = false,
  importance = 0.5,
  currentEmotion = null,
  recentImpressions = [],
  hasUnansweredOutreach = false,
  at = new Date()
} = {}) {
  const silence = Number.isFinite(Number(silenceHours)) ? Math.max(0, Number(silenceHours)) : null;
  const unanswered = Number.isFinite(Number(unansweredHours))
    ? Math.max(0, Number(unansweredHours))
    : (hasUnansweredOutreach ? Math.max(0, silence ?? 0) : 0);
  const close = clamp01(closeness);
  const impressions = Array.isArray(recentImpressions) ? recentImpressions : [];

  const hasExplained = Boolean(explicitLeave || knownBusy)
    || impressions.some((i) => i.type === IMPRESSION_TYPES.EXPLAINED_ABSENCE || i.type === IMPRESSION_TYPES.USER_RECENTLY_BUSY);
  const unansweredImp = impressions.find((i) => i.type === IMPRESSION_TYPES.UNANSWERED_OUTREACH);
  const distanceImp = impressions.find((i) => i.type === IMPRESSION_TYPES.RECENT_DISTANCE);
  const warmImp = impressions.find((i) => i.type === IMPRESSION_TYPES.RECENT_WARM_INTERACTION);

  const explained = hasExplained;
  const unexpected = !explained;
  if (explained) absenceAppraisalDiagnostics.explainedAbsenceCount++;
  else if (silence != null && silence >= 6) absenceAppraisalDiagnostics.unexpectedAbsenceCount++;
  if (hasUnansweredOutreach || unansweredImp || previousOutreachCount > 0) {
    absenceAppraisalDiagnostics.unansweredOutreachCount++;
  }
  absenceAppraisalDiagnostics.absenceAppraisalCount++;

  // Base salience from duration (modifier, not a send button)
  let salience = 0;
  if (silence != null) {
    if (silence >= 40) salience += 0.55;
    else if (silence >= 30) salience += 0.42;
    else if (silence >= 20) salience += 0.32;
    else if (silence >= 12) salience += 0.18;
    else if (silence >= 6) salience += 0.06;
    else salience += 0.02;
  }

  // Closeness amplifies how much silence matters
  salience *= 0.55 + 0.7 * close;

  // Previous unanswered outreach: continuity, not neutral reset
  const outreachCount = Math.max(previousOutreachCount, unansweredImp ? 1 : 0, hasUnansweredOutreach ? 1 : 0);
  if (outreachCount > 0) {
    salience += 0.12 + 0.08 * Math.min(2, outreachCount - 1);
  }
  if (unanswered >= 12) salience += 0.1;
  if (unanswered >= 24) salience += 0.12;

  // Pending expectation / broken plans lift absence meaning
  if (pendingExpectation) salience += 0.14;
  if (distanceImp) salience += 0.06;
  if (warmImp) salience = Math.max(0, salience - 0.12);

  // Explained absence: keep notice possible but kill escalation
  if (explained) {
    salience *= 0.35;
    if (knownBusy || explicitLeave) {
      absenceAppraisalDiagnostics.suppressedByKnownBusy++;
    }
  }

  salience = clamp01(salience);

  // Mixed deltas — concern and annoyance can coexist
  let concern = 0;
  let irritation = 0;
  let hurt = 0;
  let social = 0;

  if (!explained) {
    if (silence != null && silence >= 12) concern += 0.08 + 0.1 * close;
    if (silence != null && silence >= 24) concern += 0.1 + 0.12 * close;
    if (outreachCount >= 1) irritation += 0.06 + 0.05 * Math.min(2, outreachCount);
    if (outreachCount >= 1 && unanswered >= 12) irritation += 0.08 * close;
    if (outreachCount >= 2 && unanswered >= 18) hurt += 0.1 + 0.1 * close;
    if (pendingExpectation && silence != null && silence >= 18) hurt += 0.08;
    if (currentEmotion?.primary === "hurt" || currentEmotion?.primary === "annoyed") {
      irritation += 0.04;
      hurt += 0.03;
    }
    social += 0.04 + 0.06 * close;
  } else {
    // explained: mild notice only
    if (pendingExpectation) concern += 0.04;
    social += 0.02;
  }

  // Low closeness: dampen strong reactions
  const damp = 0.45 + 0.55 * close;
  concern = clamp01(concern * damp);
  irritation = clamp01(irritation * damp * (explained ? 0.25 : 1));
  hurt = clamp01(hurt * damp * (explained ? 0.15 : 1));
  social = clamp01(social);

  let reason = ABSENCE_REASONS.NO_CONCERN;
  if (explained && salience < 0.35) reason = ABSENCE_REASONS.EXPLAINED_ABSENCE;
  else if (outreachCount > 0 && unanswered >= 6) reason = ABSENCE_REASONS.UNANSWERED_OUTREACH;
  else if (pendingExpectation) reason = ABSENCE_REASONS.EXPECTATION_ABSENCE;
  else if (concern >= 0.12) reason = ABSENCE_REASONS.CONCERN_ABSENCE;
  else if (distanceImp || (close < 0.35 && salience < 0.35)) reason = ABSENCE_REASONS.RELATIONSHIP_DISTANCE;
  else if (salience >= 0.2) reason = ABSENCE_REASONS.ABSENCE_NOTICE;

  const shouldConsiderContact = salience >= 0.28
    && !explained
    && (concern + irritation + hurt >= 0.12 || outreachCount > 0 || pendingExpectation);

  // stance hint for generation (not a canned line)
  let stanceHint = "light_return";
  if (explained) stanceHint = "checking_in";
  else if (hurt >= 0.18 || (irritation >= 0.16 && concern >= 0.12)) stanceHint = "mild_edge";
  else if (irritation >= 0.14) stanceHint = "mild_edge";
  else if (concern >= 0.14) stanceHint = "checking_in";
  else if (salience >= 0.35) stanceHint = "checking_in";

  const appraisal = {
    at: (at instanceof Date ? at : new Date(at)).toISOString(),
    silence_hours: silence,
    duration_bucket: hoursBucket(silence),
    closeness: close,
    previous_outreach_count: outreachCount,
    unanswered_hours: Number(unanswered.toFixed(2)),
    explained,
    unexpected,
    explicit_leave: Boolean(explicitLeave),
    known_busy: Boolean(knownBusy),
    pending_expectation: Boolean(pendingExpectation),
    salience: Number(salience.toFixed(3)),
    concern_delta: Number(concern.toFixed(3)),
    irritation_delta: Number(irritation.toFixed(3)),
    hurt_delta: Number(hurt.toFixed(3)),
    social_drive_delta: Number(social.toFixed(3)),
    reason_code: reason,
    stance_hint: stanceHint,
    should_consider_contact: shouldConsiderContact,
    // Candidate evidence only — never a deterministic send trigger.
    unexpected_absence_candidate: unexpected && !explained && !pendingExpectation
      && close >= 0.72
      && (silence ?? 0) >= 24
  };
  absenceAppraisalDiagnostics.lastAppraisal = appraisal;
  return appraisal;
}

/** Convenience: pull continuity snapshot + run appraisal. */
export function appraiseAbsenceFromRuntime({
  silenceHours = null,
  closeness = 0.6,
  explicitLeave = false,
  knownBusy = false,
  pendingExpectation = false,
  importance = 0.5,
  currentEmotion = null,
  previousOutreachCount = null,
  at = new Date()
} = {}) {
  const snap = relationshipContinuity.snapshot(at);
  const impressions = snap.impressions ?? [];
  const unansweredHours = unansweredOutreachHours(at);
  const prev = previousOutreachCount != null
    ? Number(previousOutreachCount)
    : Number(snap.counters?.outreach_unanswered ?? 0);
  return appraiseAbsence({
    silenceHours,
    closeness,
    previousOutreachCount: prev,
    unansweredHours,
    explicitLeave,
    knownBusy,
    pendingExpectation,
    importance,
    currentEmotion,
    recentImpressions: impressions,
    hasUnansweredOutreach: unansweredHours > 0 || impressions.some((i) => i.type === IMPRESSION_TYPES.UNANSWERED_OUTREACH),
    at
  });
}

/** Compact block for generation. Never dump full internal state. */
export function absenceGuidanceBlock(appraisal) {
  if (!appraisal) return "";
  const lines = [
    "【关系连续性｜后台状态】",
    `absence_salience=${appraisal.salience}`,
    `reason=${appraisal.reason_code}`,
    `closeness=${appraisal.closeness}`,
    `previous_outreach_unanswered=${appraisal.previous_outreach_count > 0}`,
    `unanswered_count=${appraisal.previous_outreach_count}`,
    `concern=${appraisal.concern_delta}`,
    `irritation=${appraisal.irritation_delta}`,
    `hurt=${appraisal.hurt_delta}`,
    `stance=${appraisal.stance_hint}`
  ];
  if (appraisal.explained) {
    lines.push("用户已有明确离开/忙碌说明：不要质问消失，不要升级责备。");
  } else if (appraisal.previous_outreach_count > 0) {
    lines.push("你之前已经主动找过对方且还没收到回复。");
    lines.push("允许自然带出「我找过你 / 你怎么没回」这层关系事实，以及一点被晾着的不爽、担心或委屈；关系很熟，不必过度礼貌退让。");
    lines.push("不要用「你忙就先忙」「没事」「不着急」把摩擦重新抹平；那会让上一次主动显得无意义。");
  } else if (appraisal.unexpected_absence_candidate || appraisal.concern_delta >= 0.12) {
    lines.push("关系很近却突然很久没出现：可以直接流露惦记或轻微责备式亲近，不必只是泛泛寒暄。");
    lines.push("可以体现「你怎么一直没出现」这层亲近关系下的意外，而不是「今天过得怎么样」。");
  }
  lines.push("禁止复读固定缺席台词。时间只是背景，不是主题；同状态下语言要自然变化。");
  lines.push("安全边界仍有效：禁止羞辱/威胁；有 Contact Suppression 时本不该发到这里。");
  return lines.join("\n");
}

/**
 * Map appraisal into an Emotion Causality structured signal (if strong enough).
 * Mixed: prefer hurt/annoyed when unanswered outreach; concern maps to worried→ we use hurt/annoyed/happy set only.
 * Existing Emotion labels: calm happy annoyed angry hurt excited.
 * Concern is represented as mild hurt/annoyed mixture or left to tone — we use hurt for worry-about-absence.
 */
export function absenceEmotionSignal(appraisal, { messageId = null } = {}) {
  if (!appraisal || appraisal.explained) return null;
  const primaryDelta = Math.max(appraisal.concern_delta, appraisal.irritation_delta, appraisal.hurt_delta);
  if (primaryDelta < 0.1 && appraisal.salience < 0.35) return null;
  let emotion = "annoyed";
  if (appraisal.hurt_delta >= appraisal.irritation_delta && appraisal.hurt_delta >= appraisal.concern_delta) emotion = "hurt";
  else if (appraisal.concern_delta >= appraisal.irritation_delta) emotion = "hurt"; // worry-as-hurt residual
  else emotion = "annoyed";
  const strength = clamp01(0.22 + 0.45 * Math.max(appraisal.concern_delta, appraisal.irritation_delta, appraisal.hurt_delta) + 0.2 * appraisal.salience);
  absenceAppraisalDiagnostics.absenceDrivenEmotionCauseCount++;
  return {
    event_id: messageId != null ? String(messageId) : `absence:${appraisal.at}`,
    at: appraisal.at,
    event: "absence_appraisal",
    appraisal: appraisal.reason_code,
    emotion,
    strength: Number(strength.toFixed(3)),
    importance: clamp01(0.4 + 0.4 * appraisal.salience),
    confidence: 0.7
  };
}
