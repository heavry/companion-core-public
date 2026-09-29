/**
 * Relationship Continuity + Absence Appraisal v1 — targeted scenarios A–O (12–15).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "companion-rel-cont-"));
process.env.COMPANION_API_KEY = "rel-cont-test-key-long-random";
process.env.DATABASE_PATH = path.join(tmp, "companion.db");
process.env.COMPANION_STATE_PATH = path.join(tmp, "companion-state.json");
process.env.COMPANION_BEHAVIOR_PATH = path.join(tmp, "companion-behavior.json");
process.env.COMPANION_NATURAL_COGNITION_PATH = path.join(tmp, "natural-cognition.json");
process.env.COMPANION_NATURAL_PRESENCE_PATH = path.join(tmp, "natural-presence.json");
process.env.COMPANION_INACTIVITY_DEV_OVERRIDE_ENABLED = "1";
process.env.COMPANION_NATURAL_PRESENCE_ENABLED = "true";
process.env.COMPANION_NATURAL_COGNITION_ENABLED = "true";
process.env.COMPANION_SILENCE_RETURN_STANCE_ENABLED = "true";
process.env.EMBEDDING_ENABLED = "false";

const ok = (m) => console.log(`OK  ${m}`);
const HOUR = 3600_000;

const {
  RelationshipContinuityStore,
  IMPRESSION_TYPES,
  hasUnansweredOutreach,
  unansweredOutreachHours
} = await import("../src/relationship-continuity.js");
const {
  appraiseAbsence,
  appraiseAbsenceFromRuntime,
  absenceGuidanceBlock,
  absenceEmotionSignal,
  absenceAppraisalDiagnostics,
  resetAbsenceAppraisalDiagnostics,
  snapshotAbsenceAppraisalDiagnostics,
  ABSENCE_REASONS
} = await import("../src/absence-appraisal.js");
const { selectReturnStance, stanceGuidanceBlock } = await import("../src/silence-return-stance.js");
const { classifyLeave, classifyExplainedAbsence, contactSuppression } = await import("../src/contact-suppression.js");

const storeFile = path.join(tmp, "relationship-continuity.json");
const now = () => new Date();
let store = new RelationshipContinuityStore({ file: storeFile, now });

function freshStore() {
  store = new RelationshipContinuityStore({ file: storeFile, now });
  store.document = {
    version: 1,
    updated_at: new Date().toISOString(),
    last_outreach: null,
    impressions: [],
    counters: { outreach_sent: 0, outreach_answered: 0, outreach_unanswered: 0, impressions_created: 0, impressions_resolved: 0 }
  };
  store.save();
  return store;
}

// --- A. 6h silence, low/medium closeness → NO_ACTION-ish (low salience) ---
{
  freshStore();
  const a = appraiseAbsence({
    silenceHours: 6,
    closeness: 0.35,
    previousOutreachCount: 0,
    unansweredHours: 0,
    recentImpressions: []
  });
  assert.equal(a.should_consider_contact, false, "A 6h low closeness should not force contact");
  assert.ok(a.salience < 0.35, `A salience low (${a.salience})`);
  ok("A 6h low/medium closeness → no forced contact");
}

// --- B. 12h silence, high closeness, no previous outreach → mild notice ---
{
  const b = appraiseAbsence({
    silenceHours: 12,
    closeness: 0.9,
    previousOutreachCount: 0,
    unansweredHours: 0,
    recentImpressions: []
  });
  assert.ok(b.concern_delta > 0 || b.salience >= 0.18, `B mild notice concern=${b.concern_delta} salience=${b.salience}`);
  assert.equal(b.explained, false);
  ok("B 12h high closeness mild notice");
}

// --- C. 24h silence, high closeness, no explanation → stronger appraisal ---
{
  const c = appraiseAbsence({
    silenceHours: 24,
    closeness: 0.95,
    previousOutreachCount: 0,
    unansweredHours: 0,
    recentImpressions: []
  });
  assert.ok(c.salience > b_salience(), `C salience stronger (${c.salience})`);
  assert.ok(c.concern_delta + c.irritation_delta + c.hurt_delta >= 0.12, `C mixed deltas ${JSON.stringify(c)}`);
  assert.equal(c.reason_code !== ABSENCE_REASONS.NO_CONCERN, true);
  ok("C 24h high closeness stronger appraisal");
}
function b_salience() { return 0.25; }

// --- D. First outreach, user silent, next wake knows previous outreach ---
{
  freshStore();
  store.noteOutreachSent({
    messageId: 101,
    attemptKey: "proactive_test_1",
    reason: "concern",
    topic: "你今天怎么了",
    expectsReply: true
  });
  assert.equal(store.document.last_outreach?.expects_reply, true);
  assert.equal(store.document.last_outreach?.answered, false);
  assert.ok(store.findByType(IMPRESSION_TYPES.UNANSWERED_OUTREACH).length >= 1);
  const d = appraiseAbsence({
    silenceHours: 13,
    closeness: 0.85,
    previousOutreachCount: 1,
    unansweredHours: 13,
    recentImpressions: store.activeImpressions(),
    hasUnansweredOutreach: true
  });
  assert.equal(d.previous_outreach_count >= 1, true);
  assert.equal(d.reason_code, ABSENCE_REASONS.UNANSWERED_OUTREACH);
  assert.ok(d.salience > 0.3, `D salience with unanswered outreach ${d.salience}`);
  ok("D previous unanswered outreach known across wake");
}

// --- E. Two unanswered outreaches → not neutral reset ---
{
  store.noteOutreachSent({
    messageId: 102,
    attemptKey: "proactive_test_2",
    reason: "unanswered_outreach",
    topic: "人呢",
    expectsReply: true
  });
  const e1 = appraiseAbsence({
    silenceHours: 22,
    closeness: 0.9,
    previousOutreachCount: 2,
    unansweredHours: 22,
    recentImpressions: store.activeImpressions(),
    hasUnansweredOutreach: true
  });
  const e2 = appraiseAbsence({
    silenceHours: 22,
    closeness: 0.9,
    previousOutreachCount: 2,
    unansweredHours: 22,
    recentImpressions: store.activeImpressions(),
    hasUnansweredOutreach: true
  });
  assert.equal(e1.previous_outreach_count, e2.previous_outreach_count);
  assert.ok(e2.salience >= e1.salience - 0.05, "E repeated wake does not collapse to neutral");
  assert.ok(e2.irritation_delta + e2.hurt_delta > 0.05, "E residual irritation/hurt");
  const stance = selectReturnStance({
    silenceHours: 22,
    presence: { dimensions: { irritation: { current: 0.1 }, energy: { current: 0.7 }, mood: { current: 0.1 }, social_drive: { current: 0.6 }, closeness: { current: 0.9 } } },
    absenceAppraisal: e2,
    candidateKind: "presence",
    presenceReason: "absence_contact"
  });
  assert.ok(["mild_edge", "checking_in"].includes(stance.stance), `E stance not light_reset (${stance.stance})`);
  ok("E second unanswered outreach not neutral");
}

// --- F. Explained absence: exam / busy → no anger escalation ---
{
  const leave = classifyLeave("我这两天考试，可能不回消息");
  assert.equal(leave?.kind, "known_busy", "F leave classified");
  store.noteUserInteraction({ text: "我这两天考试，可能不回消息", explainedAbsence: true, busy: true });
  const f = appraiseAbsence({
    silenceHours: 24,
    closeness: 0.95,
    previousOutreachCount: 1,
    unansweredHours: 24,
    explicitLeave: true,
    knownBusy: true,
    recentImpressions: store.activeImpressions(),
    hasUnansweredOutreach: false
  });
  assert.equal(f.explained, true);
  assert.ok(f.irritation_delta < 0.12, `F no anger escalation (${f.irritation_delta})`);
  assert.ok(f.hurt_delta < 0.12, `F no hurt escalation (${f.hurt_delta})`);
  assert.ok(f.salience < 0.45, `F dampened salience (${f.salience})`);
  ok("F explained absence protected");
}

// --- G. "先别找我" → contact suppression ---
{
  const leave = classifyLeave("先别找我，我想静静");
  assert.equal(leave?.kind, "dont_contact");
  const explained = classifyExplainedAbsence("先别找我，我想静静");
  assert.equal(explained?.dontContact, true);
  contactSuppression.observeUser({ text: "先别找我", messageId: 1, armLeave: true });
  contactSuppression.observeAssistant({ text: "好，我等你。" });
  const active = contactSuppression.active(new Date());
  assert.ok(active?.until, "G suppression active");
  ok("G explicit dont-contact suppression");
}

// --- H. Expectation + absence ---
{
  const h = appraiseAbsence({
    silenceHours: 20,
    closeness: 0.8,
    previousOutreachCount: 0,
    unansweredHours: 0,
    pendingExpectation: true,
    recentImpressions: []
  });
  assert.equal(h.reason_code, ABSENCE_REASONS.EXPECTATION_ABSENCE);
  assert.ok(h.salience > 0.25, `H expectation lifts absence (${h.salience})`);
  ok("H expectation + absence");
}

// --- I. Assistant→user social expectation from real question ---
{
  freshStore();
  store.noteOutreachSent({
    messageId: 201,
    attemptKey: "proactive_q",
    reason: "concern",
    topic: "到家跟我说一声",
    expectsReply: true
  });
  const last = store.document.last_outreach;
  assert.equal(last.expects_reply, true);
  assert.equal(last.answered, false);
  assert.ok(store.findByType(IMPRESSION_TYPES.SOCIAL_EXPECTATION_WAITING).length >= 1);
  ok("I weak social expectation waiting");
}

// --- J. Plain statement → no expectation ---
{
  freshStore();
  store.noteOutreachSent({
    messageId: 202,
    attemptKey: "proactive_plain",
    reason: "pure_social_contact",
    topic: "哈哈",
    expectsReply: false
  });
  assert.equal(store.document.last_outreach.expects_reply, false);
  assert.equal(store.findByType(IMPRESSION_TYPES.UNANSWERED_OUTREACH).length, 0);
  assert.equal(store.findByType(IMPRESSION_TYPES.SOCIAL_EXPECTATION_WAITING).length, 0);
  ok("J plain assistant statement no expectation");
}

// --- K. User returns "刚忙去了" → residual allowed, not forced neutral ---
{
  freshStore();
  store.noteOutreachSent({
    messageId: 203,
    attemptKey: "proactive_k",
    reason: "concern",
    topic: "你还好吗",
    expectsReply: true
  });
  store.noteUserInteraction({ text: "刚忙去了", warm: false, explainedAbsence: true, busy: true });
  // explained resolves hard unanswered, but appraisal of explained keeps mild
  const k = appraiseAbsence({
    silenceHours: 2,
    closeness: 0.9,
    previousOutreachCount: 1,
    explicitLeave: true,
    knownBusy: true,
    recentImpressions: store.activeImpressions()
  });
  assert.equal(k.explained, true);
  // residual emotion signal should be null/minimal for explained
  const sig = absenceEmotionSignal(k);
  assert.equal(sig, null, "K explained return does not force anger emotion cause");
  ok("K return explanation without instant anger");
}

// --- L. Warm chat resolves unanswered/distance ---
{
  freshStore();
  store.noteOutreachSent({
    messageId: 204,
    attemptKey: "proactive_l",
    reason: "concern",
    topic: "想你了",
    expectsReply: true
  });
  store.noteUserInteraction({ text: "我也想你嘿嘿", warm: true });
  assert.equal(store.findByType(IMPRESSION_TYPES.UNANSWERED_OUTREACH).length, 0);
  assert.equal(store.findByType(IMPRESSION_TYPES.SOCIAL_EXPECTATION_WAITING).length, 0);
  assert.ok(store.findByType(IMPRESSION_TYPES.RECENT_WARM_INTERACTION).length >= 1);
  ok("L warm interaction resolves outreach impressions");
}

// --- M. Low closeness + 30h → not necessarily strong ---
{
  const m = appraiseAbsence({
    silenceHours: 30,
    closeness: 0.15,
    previousOutreachCount: 0,
    unansweredHours: 0,
    recentImpressions: []
  });
  assert.ok(m.hurt_delta < 0.12 && m.irritation_delta < 0.12, `M low closeness dampened ${JSON.stringify({h:m.hurt_delta,i:m.irritation_delta})}`);
  ok("M low closeness dampens reaction");
}

// --- N. High closeness + previous unanswered concern → mixed concern+annoyance ---
{
  freshStore();
  store.noteOutreachSent({
    messageId: 205,
    attemptKey: "proactive_n",
    reason: "concern",
    topic: "没事吧",
    expectsReply: true
  });
  const n = appraiseAbsence({
    silenceHours: 26,
    closeness: 0.95,
    previousOutreachCount: 1,
    unansweredHours: 26,
    recentImpressions: store.activeImpressions(),
    hasUnansweredOutreach: true
  });
  assert.ok(n.concern_delta + n.irritation_delta + n.hurt_delta >= 0.18, `N mixed strong ${JSON.stringify(n)}`);
  const stance = selectReturnStance({
    silenceHours: 26,
    presence: { dimensions: { irritation: { current: 0.12 }, energy: { current: 0.7 }, mood: { current: 0.05 }, social_drive: { current: 0.55 }, closeness: { current: 0.95 } } },
    absenceAppraisal: n,
    candidateKind: "presence",
    presenceReason: "absence_contact"
  });
  assert.ok(["mild_edge", "checking_in"].includes(stance.stance), `N stance ${stance.stance}`);
  const guidance = stanceGuidanceBlock(stance);
  assert.ok(!/你死哪去了/.test(guidance), "N no canned death line");
  ok("N high closeness + unanswered → mixed concern/annoyance");
}

// --- O. Same 24h condition → no mechanical identical template in guidance ---
{
  const o1 = appraiseAbsence({
    silenceHours: 24,
    closeness: 0.88,
    previousOutreachCount: 1,
    unansweredHours: 24,
    recentImpressions: [{ type: IMPRESSION_TYPES.UNANSWERED_OUTREACH, strength: 0.6 }]
  });
  const o2 = appraiseAbsence({
    silenceHours: 24.2,
    closeness: 0.88,
    previousOutreachCount: 1,
    unansweredHours: 24.2,
    recentImpressions: [{ type: IMPRESSION_TYPES.UNANSWERED_OUTREACH, strength: 0.55 }]
  });
  const g1 = absenceGuidanceBlock(o1);
  const g2 = absenceGuidanceBlock(o2);
  assert.ok(!/你死哪去了|你去哪了\？?$/.test(g1 + g2), "O no hardcoded absence templates");
  assert.ok(g1.includes("不要像第一次") || g1.includes("复读"), "O continuity guidance present");
  ok("O no mechanical absence template");
}

// Impression decay
{
  freshStore();
  store.noteImpression({ type: IMPRESSION_TYPES.UNANSWERED_OUTREACH, strength: 0.8 }, new Date(Date.now() - 40 * HOUR));
  const active = store.activeImpressions();
  assert.equal(active.length, 0, "impression decayed after 36h");
  ok("impression decay");
}

// Metrics invariants
{
  const snap = snapshotAbsenceAppraisalDiagnostics();
  assert.ok(snap.absenceAppraisalCount >= 10);
  assert.ok(snap.explainedAbsenceCount >= 1);
  assert.equal(snap.neutralResetAfterUnansweredOutreach, 0);
  ok("metrics counters present");
}

console.log("\nRELATIONSHIP CONTINUITY + ABSENCE APPRAISAL V1 TARGETED PASS");
console.log(JSON.stringify(snapshotAbsenceAppraisalDiagnostics(), null, 2));
