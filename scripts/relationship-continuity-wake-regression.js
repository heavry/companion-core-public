/**
 * Short deterministic wake regression — send-rate protection.
 * 6/12/20/30/40h × closeness / busy. No LLM.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-wake-reg-"));
process.env.DATABASE_PATH = path.join(tmp, "companion.db");
process.env.COMPANION_STATE_PATH = path.join(tmp, "companion-state.json");
process.env.COMPANION_BEHAVIOR_PATH = path.join(tmp, "companion-behavior.json");
process.env.COMPANION_NATURAL_PRESENCE_PATH = path.join(tmp, "natural-presence.json");
process.env.COMPANION_NATURAL_COGNITION_PATH = path.join(tmp, "natural-cognition.json");
process.env.COMPANION_AUTONOMOUS_LIFE_ENABLED = "false";
process.env.COMPANION_AUTONOMOUS_LIFE_STATE_PATH = path.join(tmp, "autonomous-life.json");
process.env.COMPANION_INACTIVITY_DEV_OVERRIDE_ENABLED = "1";
process.env.COMPANION_NATURAL_PRESENCE_ENABLED = "true";
process.env.COMPANION_NATURAL_COGNITION_ENABLED = "true";
process.env.EMBEDDING_ENABLED = "false";

const ok = (m) => console.log(`OK  ${m}`);
const stateMod = await import("../src/companion-state.js");
const { naturalPresence } = await import("../src/natural-presence/index.js");
const { naturalCognition } = await import("../src/natural-cognition/index.js");
const { contactSuppression } = await import("../src/contact-suppression.js");
const proactive = await import("../src/proactive.js");
const { relationshipContinuity, IMPRESSION_TYPES } = await import("../src/relationship-continuity.js");

function reset({ hours, closeness = 0.5, busy = false, suppress = false, lastProactiveHoursAgo = null, unanswered = 0 } = {}) {
  const at = new Date(Date.now() + 60_000);
  const last = new Date(at.getTime() - hours * 3600_000).toISOString();
  const s = stateMod.getState();
  s.lastUserInteractionAt = last;
  s.lastProactiveAt = lastProactiveHoursAgo != null ? new Date(at.getTime() - lastProactiveHoursAgo * 3600_000).toISOString() : null;
  s.consecutiveUnansweredProactive = unanswered;
  s.recentTopics = ["随便聊过的内容"];
  s.pendingFollowups = [];
  s.proactiveToday = { date: "", count: 0 };
  s.inactivity = { ...(s.inactivity ?? {}), simulatedLastUserInteractionAt: last, lastCognitionWakeKey: null };
  stateMod.saveState();
  naturalPresence.document.open_loops = [];
  naturalPresence.document.thought_seeds = [];
  naturalCognition.document.expectations = [];
  naturalCognition.document.focus = { primary: null, secondary: null, updated_at: last };
  naturalCognition.save();
  for (const [k, v] of Object.entries({ mood: 0.1, energy: 0.8, irritation: 0.1, social_drive: 0.55, closeness, playfulness: 0.55, confidence: 0.65 })) {
    const dim = naturalPresence.document.dimensions[k];
    if (dim) { dim.current = v; dim.baseline = v; }
  }
  naturalPresence.document.emotion_state = null;
  naturalPresence.save();
  contactSuppression.state = { version: 1, pending: null, active: null };
  contactSuppression.save();
  relationshipContinuity.document = {
    version: 1, updated_at: new Date().toISOString(), last_outreach: null, impressions: [],
    counters: { outreach_sent: 0, outreach_answered: 0, outreach_unanswered: 0, impressions_created: 0, impressions_resolved: 0 }
  };
  relationshipContinuity.save();
  if (busy) {
    relationshipContinuity.noteUserInteraction({ text: "这两天考试", explainedAbsence: true, busy: true }, new Date(at.getTime() - hours * 3600_000));
    contactSuppression.observeUser({ text: "我这两天考试", messageId: 1, armLeave: true });
    contactSuppression.observeAssistant({ text: "好" });
  }
  if (suppress) {
    contactSuppression.observeUser({ text: "先别找我", messageId: 2, armLeave: true });
    contactSuppression.observeAssistant({ text: "好" });
  }
  return at;
}

function hasAbsenceCandidate(gathered) {
  return (gathered.candidates ?? []).some((c) => c.presenceReason === "absence_contact");
}

const rows = [];
for (const hours of [6, 12, 20, 24, 30, 40]) {
  for (const closeness of [0.25, 0.55, 0.92]) {
    const at = reset({ hours, closeness });
    const g = proactive.gatherCandidateSet({ at });
    const cand = hasAbsenceCandidate(g);
    rows.push({ hours, closeness, busy: false, suppress: false, absenceCandidate: cand, n: g.candidates.length });
  }
}
// busy / suppress
for (const hours of [24, 40]) {
  const atBusy = reset({ hours, closeness: 0.95, busy: true });
  const gBusy = proactive.gatherCandidateSet({ at: atBusy });
  rows.push({ hours, closeness: 0.95, busy: true, suppress: false, absenceCandidate: hasAbsenceCandidate(gBusy), n: gBusy.candidates.length, suppression: Boolean(gBusy.suppressionActive || contactSuppression.active(atBusy)) });
  const atSup = reset({ hours, closeness: 0.95, suppress: true });
  const gSup = proactive.gatherCandidateSet({ at: atSup });
  rows.push({ hours, closeness: 0.95, busy: false, suppress: true, absenceCandidate: hasAbsenceCandidate(gSup), n: gSup.candidates.length, suppression: Boolean(gSup.suppressionActive || contactSuppression.active(atSup)) });
}

console.log(JSON.stringify(rows, null, 2));

// Assertions
const lowClose = rows.filter((r) => r.closeness <= 0.25);
assert.ok(lowClose.every((r) => !r.absenceCandidate), "low closeness never absence-candidate");
const mid6_12 = rows.filter((r) => (r.hours === 6 || r.hours === 12) && !r.busy && !r.suppress);
assert.ok(mid6_12.every((r) => !r.absenceCandidate), "6/12h ordinary silence no absence candidate");
const high20 = rows.find((r) => r.hours === 20 && r.closeness === 0.92 && !r.busy);
assert.equal(high20.absenceCandidate, false, "20h still usually no unexpected candidate (threshold 20h + salience)");
const high24plus = rows.filter((r) => r.hours >= 24 && r.closeness === 0.92 && !r.busy && !r.suppress);
assert.ok(high24plus.some((r) => r.absenceCandidate), "24h+ high closeness unexpected can form candidate");
const busyRows = rows.filter((r) => r.busy);
assert.ok(busyRows.every((r) => !r.absenceCandidate && (r.suppression || r.n === 0)), "known busy / leave does not chase");
const supRows = rows.filter((r) => r.suppress);
assert.ok(supRows.every((r) => r.n === 0 && !r.absenceCandidate), "contact suppression blocks all");

console.log("\nWAKE REGRESSION PASS — NO_ACTION remains common; absence candidate is strict");
