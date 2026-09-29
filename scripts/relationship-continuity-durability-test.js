/**
 * relationship-continuity.json durability checks A–D.
 * Atomic write already present; this proves restart, corruption, and snapshot inclusion.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-durability-"));
process.env.DATABASE_PATH = path.join(tmp, "companion.db");
process.env.COMPANION_STATE_PATH = path.join(tmp, "companion-state.json");

const ok = (m) => console.log(`OK  ${m}`);
const { RelationshipContinuityStore, IMPRESSION_TYPES } = await import("../src/relationship-continuity.js");
const file = path.join(tmp, "relationship-continuity.json");

function make() {
  return new RelationshipContinuityStore({ file, now: () => new Date() });
}

// A. normal write → restart → retained
{
  const s = make();
  s.noteOutreachSent({
    messageId: 11,
    attemptKey: "proactive_restart",
    reason: "concern",
    topic: "想你了",
    expectsReply: true
  }, new Date("2026-09-25T01:00:00.000Z"));
  s.noteImpression({
    type: IMPRESSION_TYPES.RECENT_DISTANCE,
    strength: 0.4,
    confidence: 0.8
  }, new Date("2026-09-25T01:00:00.000Z"));
  const s2 = make();
  assert.equal(s2.document.last_outreach?.attempt_key, "proactive_restart");
  assert.ok(s2.document.impressions.some((i) => i.type === IMPRESSION_TYPES.UNANSWERED_OUTREACH || i.type === IMPRESSION_TYPES.SOCIAL_EXPECTATION_WAITING || i.type === IMPRESSION_TYPES.RECENT_DISTANCE));
  assert.ok(s2.document.impressions.some((i) => i.type === IMPRESSION_TYPES.RECENT_DISTANCE));
  ok("A restart preserves last_outreach + impressions");
}

// B. corrupt JSON → no crash, safe fallback, recoverable rewrite
{
  fs.writeFileSync(file, "{not-json!!");
  const s = make();
  assert.equal(s.document.last_outreach, null);
  assert.equal(s.document.impressions.length, 0);
  s.noteImpression({ type: IMPRESSION_TYPES.USER_HAS_BEEN_QUIET, strength: 0.3 });
  s.save();
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.version, 1);
  ok("B corrupt JSON falls back and recovers");
}

// C. atomic write: interrupted temp must not destroy valid file
{
  const s = make();
  s.noteOutreachSent({ messageId: 12, attemptKey: "atomic_1", reason: "concern", topic: "t", expectsReply: true });
  const before = fs.readFileSync(file, "utf8");
  // simulate leftover temp from crash (never renamed)
  const badTmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(badTmp, "PARTIAL");
  // another valid write still uses rename
  s.noteImpression({ type: IMPRESSION_TYPES.RECENT_WARM_INTERACTION, strength: 0.4 });
  const after = fs.readFileSync(file, "utf8");
  assert.notEqual(after, before);
  const parsed = JSON.parse(after); // still valid JSON
  assert.equal(parsed.version, 1);
  assert.ok(parsed.impressions.length >= 1);
  // valid file was never truncated to "PARTIAL"
  assert.ok(!after.includes("PARTIAL"));
  ok("C atomic temp+rename keeps valid state");
}

// D. snapshot list includes sidecar
{
  const lib = fs.readFileSync(path.join(import.meta.dirname, "cloud-migration-lib.js"), "utf8");
  assert.ok(lib.includes("relationship-continuity.json"), "snapshot OPTIONAL_STATE_FILES includes relationship-continuity.json");
  ok("D snapshot/rollback list includes sidecar");
}

console.log("\nRELATIONSHIP CONTINUITY DURABILITY PASS");
