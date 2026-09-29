/**
 * Crash-window tests for post-message durable idempotency (A–E).
 * Does not re-run 20-turn suite. No voice_plan changes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-idempotency-"));
fs.mkdirSync(path.join(root, "data"), { recursive: true });
process.env.DATABASE_PATH = path.join(root, "data", "companion.db");
process.env.COMPANION_INSTANCE_ID_PATH = path.join(root, "data", "instance-identity.json");
process.env.COMPANION_PRIMARY_LOCK_PATH = path.join(root, "data", "primary.lock");
process.env.COMPANION_DEPLOYMENT_ROLE = "development-test";
process.env.COMPANION_INSTANCE_ID = "pm-idempotency-test";
process.env.EMBEDDING_ENABLED = "false";
process.env.AUTO_PROMOTE_MEMORY = "0";
process.env.PERSONA_SYNC_ON_START = "false";

const {
  runPostMessagePhase,
  PostMessageRegistry,
  postMessageAttemptKey,
  resetPostMessageDiagnostics,
  postMessageDiagnostics
} = await import("../src/post-message-cognition.js");
const dbmod = await import("../src/db.js");
const {
  insertMessage,
  findPostMessageFollowupByAttemptKey,
  getOrCreateSession
} = dbmod;

const session = getOrCreateSession("verify", "chat", `pm-idem-${Date.now()}`);
const passed = [];

function seedPrimary(parentTurnId) {
  return insertMessage(session.id, "chat", {
    role: "assistant",
    content: `Bubble1 ${parentTurnId}`,
    bubble_index: 0,
    bubble_count: 1,
    bubble_turn_id: parentTurnId,
    generation_route: "natural_chat",
    origin: "primary_generation"
  });
}

function deliverDurableFollowup(parentTurnId, attemptKey, text) {
  return insertMessage(session.id, "chat", {
    role: "assistant",
    content: text,
    origin: "post_message_followup",
    generation_route: "post_message_followup",
    post_message: {
      attempt_key: attemptKey,
      parent_turn_id: parentTurnId,
      reason_code: "association_afterthought"
    }
  });
}

async function scenario(name, fn) {
  resetPostMessageDiagnostics();
  await fn();
  passed.push(name);
  console.log("PASS", name);
}

const findDurableFollowup = findPostMessageFollowupByAttemptKey;

try {
  await scenario("A. normal path: miss → generate once → durable once", async () => {
    const parent = "turn-A";
    seedPrimary(parent);
    let gen = 0, del = 0;
    const result = await runPostMessagePhase({
      parentTurnId: parent,
      parentUserMessageId: 1,
      sessionId: session.id,
      userText: "A1又便宜了",
      primaryText: "价格低不少。",
      primaryBubbles: ["价格低不少。"],
      gateInputs: {
        associationCandidate: { salience: 0.85, topic: "DGX 预算优先", memory_id: "m", confidence: 0.9 }
      },
      registry: new PostMessageRegistry(),
      findDurableFollowup,
      generateFollowup: async () => {
        gen += 1;
        return "不过还是想先留给 DGX。";
      },
      deliverFollowup: async ({ text, attemptKey }) => {
        del += 1;
        return { messageId: deliverDurableFollowup(parent, attemptKey, text), text };
      }
    });
    assert.equal(result.delivered, true);
    assert.equal(gen, 1);
    assert.equal(del, 1);
    const rows = dbmod.db.prepare(`
      SELECT COUNT(*) n FROM messages
      WHERE json_extract(content_json,'$.origin')='post_message_followup'
        AND json_extract(content_json,'$.post_message.attempt_key')=?
    `).get(postMessageAttemptKey(parent, 1)).n;
    assert.equal(rows, 1, "exactly one durable follow-up row");
    assert.equal(postMessageDiagnostics.durableLookupMiss, 1);
    assert.equal(postMessageDiagnostics.followupGenerateCount, 1);
    assert.equal(postMessageDiagnostics.followupDeliverCount, 1);
    assert.equal(postMessageDiagnostics.duplicateFollowupAfterRestart, 0);
    assert.equal(postMessageDiagnostics.partialDurable, 0);
  });

  await scenario("B. crash before follow-up durable: restart may retry once, rows<=1", async () => {
    const parent = "turn-B";
    seedPrimary(parent);
    // Simulate crash before durable: generate happened in dead process, no row, new registry.
    const registryAfterRestart = new PostMessageRegistry();
    let gen = 0;
    const result = await runPostMessagePhase({
      parentTurnId: parent,
      parentUserMessageId: 2,
      sessionId: session.id,
      userText: "A1",
      primaryText: "主回复 B",
      primaryBubbles: ["主回复 B"],
      gateInputs: {
        associationCandidate: { salience: 0.85, topic: "DGX", memory_id: "m", confidence: 0.9 }
      },
      registry: registryAfterRestart,
      findDurableFollowup,
      generateFollowup: async () => {
        gen += 1;
        return "补充一句 B。";
      },
      deliverFollowup: async ({ text, attemptKey }) => ({
        messageId: deliverDurableFollowup(parent, attemptKey, text),
        text
      })
    });
    assert.equal(result.delivered, true);
    assert.equal(gen, 1, "allowed one retry after crash-before-durable");
    const rows = dbmod.db.prepare(`
      SELECT COUNT(*) n FROM messages
      WHERE json_extract(content_json,'$.origin')='post_message_followup'
        AND json_extract(content_json,'$.post_message.parent_turn_id')=?
    `).all(parent).length;
    const n = dbmod.db.prepare(`
      SELECT COUNT(*) n FROM messages
      WHERE json_extract(content_json,'$.origin')='post_message_followup'
        AND json_extract(content_json,'$.post_message.attempt_key')=?
    `).get(postMessageAttemptKey(parent, 1)).n;
    assert.ok(n <= 1, "durable rows <= 1");
    assert.equal(rows, n);
    const primaryDup = dbmod.db.prepare(`
      SELECT COUNT(*) n FROM messages
      WHERE role='assistant' AND content_text LIKE ?
    `).get(`%Bubble1 ${parent}%`).n;
    assert.equal(primaryDup, 1, "primary not duplicated");
    assert.equal(postMessageDiagnostics.duplicatePrimary, 0);
  });

  await scenario("C. critical: follow-up durable + registry wiped → no regenerate", async () => {
    const parent = "turn-C";
    const b1 = seedPrimary(parent);
    const attemptKey = postMessageAttemptKey(parent, 1);
    const followId = deliverDurableFollowup(parent, attemptKey, "已经发过的 follow-up C");
    // New process: empty registry
    let gen = 0, del = 0;
    const result = await runPostMessagePhase({
      parentTurnId: parent,
      parentUserMessageId: 3,
      sessionId: session.id,
      userText: "A1",
      primaryText: "主回复 C",
      primaryBubbles: ["主回复 C"],
      gateInputs: {
        associationCandidate: { salience: 0.9, topic: "DGX 预算", memory_id: "m", confidence: 0.9 }
      },
      registry: new PostMessageRegistry(),
      findDurableFollowup,
      generateFollowup: async () => {
        gen += 1;
        return "不该再生成。";
      },
      deliverFollowup: async ({ text }) => {
        del += 1;
        return { messageId: 999, text };
      }
    });
    assert.equal(result.reason, "ALREADY_DURABLE");
    assert.equal(result.delivered, false);
    assert.equal(gen, 0, "generate after restart must be 0");
    assert.equal(del, 0, "deliver after restart must be 0");
    assert.equal(postMessageDiagnostics.durableLookupHit, 1);
    assert.equal(postMessageDiagnostics.followupGenerateCount, 0);
    assert.equal(postMessageDiagnostics.followupDeliverCount, 0);
    assert.equal(postMessageDiagnostics.duplicateFollowupAfterRestart, 1);
    const n = dbmod.db.prepare(`
      SELECT COUNT(*) n FROM messages
      WHERE json_extract(content_json,'$.origin')='post_message_followup'
        AND json_extract(content_json,'$.post_message.attempt_key')=?
    `).get(attemptKey).n;
    assert.equal(n, 1, "still exactly one durable follow-up");
    assert.equal(result.durable_message_id, Number(followId));
    assert.equal(b1 > 0, true);
  });

  await scenario("D. SSE/registry crash after durable: no re-generation", async () => {
    const parent = "turn-D";
    seedPrimary(parent);
    const attemptKey = postMessageAttemptKey(parent, 1);
    deliverDurableFollowup(parent, attemptKey, "D follow-up already durable");
    // Durable done; SSE/registry completion crashed → restart
    let gen = 0;
    const result = await runPostMessagePhase({
      parentTurnId: parent,
      parentUserMessageId: 4,
      sessionId: session.id,
      userText: "A1",
      primaryText: "主回复 D",
      primaryBubbles: ["主回复 D"],
      gateInputs: {
        associationCandidate: { salience: 0.9, topic: "DGX", memory_id: "m", confidence: 0.9 }
      },
      registry: new PostMessageRegistry(),
      findDurableFollowup,
      generateFollowup: async () => {
        gen += 1;
        return "不该。";
      },
      deliverFollowup: async ({ text }) => ({ messageId: 1, text })
    });
    assert.equal(result.reason, "ALREADY_DURABLE");
    assert.equal(gen, 0);
    assert.equal(postMessageDiagnostics.followupGenerateCount, 0);
  });

  await scenario("E. different parent_turn_id keys do not collide", async () => {
    const parentA = "turn-E-A";
    const parentB = "turn-E-B";
    seedPrimary(parentA);
    seedPrimary(parentB);
    const keyA = postMessageAttemptKey(parentA, 1);
    const keyB = postMessageAttemptKey(parentB, 1);
    assert.notEqual(keyA, keyB);
    deliverDurableFollowup(parentA, keyA, "A only");
    assert.ok(findDurableFollowup(keyA), "A hit");
    assert.equal(findDurableFollowup(keyB), null, "B must not hit A's row");
    let genB = 0;
    const resultB = await runPostMessagePhase({
      parentTurnId: parentB,
      parentUserMessageId: 5,
      sessionId: session.id,
      userText: "B 话题",
      primaryText: "主回复 EB",
      primaryBubbles: ["主回复 EB"],
      gateInputs: {
        associationCandidate: { salience: 0.85, topic: "另一个话题", memory_id: "m-b", confidence: 0.9 }
      },
      registry: new PostMessageRegistry(),
      findDurableFollowup,
      generateFollowup: async () => {
        genB += 1;
        return "B 的独立 follow-up。";
      },
      deliverFollowup: async ({ text, attemptKey }) => ({
        messageId: deliverDurableFollowup(parentB, attemptKey, text),
        text
      })
    });
    assert.equal(resultB.delivered, true);
    assert.equal(genB, 1, "B can still generate");
    assert.equal(findDurableFollowup(keyB)?.content_text, "B 的独立 follow-up。");
    // A remains intact
    assert.equal(findDurableFollowup(keyA)?.content_text, "A only");
    assert.equal(postMessageDiagnostics.duplicatePrimary, 0);
    assert.equal(postMessageDiagnostics.partialDurable, 0);
  });

  console.log("\n=== IDEMPOTENCY CRASH WINDOWS ===");
  console.log(JSON.stringify({
    pass: true,
    count: passed.length,
    passed,
    metrics: {
      durableLookupHit: postMessageDiagnostics.durableLookupHit,
      durableLookupMiss: postMessageDiagnostics.durableLookupMiss,
      followupGenerateCount: postMessageDiagnostics.followupGenerateCount,
      followupDeliverCount: postMessageDiagnostics.followupDeliverCount,
      duplicateFollowupAfterRestart: postMessageDiagnostics.duplicateFollowupAfterRestart,
      duplicatePrimary: postMessageDiagnostics.duplicatePrimary,
      partialDurable: postMessageDiagnostics.partialDurable
    }
  }, null, 2));
} catch (error) {
  console.error("FAIL", error);
  process.exit(1);
}
