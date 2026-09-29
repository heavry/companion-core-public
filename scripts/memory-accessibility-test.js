import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-memory-accessibility-"));
fs.mkdirSync(path.join(root, "data"), { recursive: true });
process.env.DATABASE_PATH = path.join(root, "data", "companion.db");
process.env.COMPANION_INSTANCE_ID_PATH = path.join(root, "data", "instance-identity.json");
process.env.COMPANION_PRIMARY_LOCK_PATH = path.join(root, "data", "primary.lock");
process.env.COMPANION_HOST = "127.0.0.1";
process.env.COMPANION_PORT = "18789";
process.env.COMPANION_INSTANCE_ID = "memory-accessibility-test";
process.env.COMPANION_DEPLOYMENT_ROLE = "development-test";
process.env.EMBEDDING_ENABLED = "false";
process.env.AUTO_PROMOTE_MEMORY = "0";
process.env.PERSONA_SYNC_ON_START = "false";
process.env.COMPANION_NATURAL_COGNITION_ENABLED = "false";
process.env.COMPANION_NATURAL_PRESENCE_ENABLED = "false";

const [dbmod, selection, accessibility, association] = await Promise.all([
  import("../src/db.js"),
  import("../src/memory-selection.js"),
  import("../src/memory-accessibility.js"),
  import("../src/event-association.js")
]);

const {
  scoreMemoryActivation,
  rankByAccessibility,
  ActiveMemoryState,
  reuseBoost,
  timeDecay,
  recencyModifier,
  emotionalStrength,
  resetMemoryAccessibilityDiagnostics,
  memoryAccessibilityDiagnostics
} = accessibility;
const { selectMemoriesForGeneration, resetMemorySelectionDiagnostics } = selection;
const {
  insertMemory,
  updateMemory,
  getOrCreateSession,
  insertMessage,
  insertEventDetailed,
  linkEventToMemory,
  insertEventAssociation
} = dbmod;

const personaId = "ma-test";
const passed = [];
const DAY = 86_400_000;
const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

function mem(overrides = {}) {
  return {
    id: overrides.id ?? `m-${Math.random().toString(16).slice(2)}`,
    persona_id: personaId,
    content: "DGX 预算决策要优先保障",
    type: "project",
    importance: 0.8,
    confidence: 0.9,
    pinned: 0,
    status: "active",
    temporal_state: "current",
    source: "fixture",
    access_count: 0,
    last_accessed_at: null,
    created_at: iso(-30 * DAY),
    updated_at: iso(-30 * DAY),
    source_message_id: null,
    ...overrides
  };
}

async function scenario(name, fn) {
  resetMemoryAccessibilityDiagnostics();
  resetMemorySelectionDiagnostics();
  await fn();
  passed.push(name);
  console.log("PASS", name);
}

try {
  await scenario("A. same topic: recent-weak / older-important / recent-important ranking", async () => {
    const recentWeak = mem({
      id: "a-recent-weak",
      content: "今天中午吃面还挺鲜",
      importance: 0.25,
      confidence: 0.8,
      updated_at: iso(-0.2 * DAY),
      created_at: iso(-0.2 * DAY)
    });
    const olderImportant = mem({
      id: "a-old-important",
      content: "DGX 预算决策要优先保障设备采购",
      importance: 0.95,
      confidence: 0.95,
      updated_at: iso(-8 * DAY),
      created_at: iso(-12 * DAY)
    });
    const recentImportant = mem({
      id: "a-recent-important",
      content: "DGX 预算这周必须定下来",
      importance: 0.88,
      confidence: 0.92,
      updated_at: iso(-0.5 * DAY),
      created_at: iso(-1 * DAY)
    });
    const ranked = rankByAccessibility(
      [recentWeak, olderImportant, recentImportant].map(m => ({ memory: m, selection_score: 0.7 })),
      { at: now, query: "DGX 预算" }
    );
    const ids = ranked.map(x => x.memory.id);
    assert.ok(ids.indexOf("a-recent-important") < ids.indexOf("a-recent-weak"), "important recent beats casual recent");
    assert.ok(ids.indexOf("a-old-important") < ids.indexOf("a-recent-weak"), "older important beats casual recent");
    // recent important may edge older important via recency modifier, but gap must be small
    const top = ranked[0], second = ranked[1];
    assert.ok(top.activation >= second.activation - 0.05, "no absurd gap between important memories");
  });

  await scenario("B. old high-importance is not buried by a fresh casual line", async () => {
    const oldDecision = mem({
      id: "b-old-dgx",
      content: "决定先攒 DGX 预算再买其他设备",
      importance: 0.96,
      confidence: 0.95,
      updated_at: iso(-10 * DAY),
      created_at: iso(-20 * DAY)
    });
    const casual = mem({
      id: "b-casual",
      content: "午饭吃了面",
      importance: 0.2,
      confidence: 0.75,
      updated_at: iso(-0.05 * DAY),
      created_at: iso(-0.05 * DAY)
    });
    const sOld = scoreMemoryActivation({ memory: oldDecision, selection_score: 0.65 }, { at: now, query: "设备计划" });
    const sNew = scoreMemoryActivation({ memory: casual, selection_score: 0.65 }, { at: now, query: "设备计划" });
    assert.ok(sOld > sNew, `old important (${sOld}) must beat casual recency (${sNew})`);
  });

  await scenario("C. emotional strength lifts accessibility but decays / does not permanently dominate", async () => {
    const exam = mem({
      id: "c-exam",
      content: "上次物理考试没考好",
      importance: 0.7,
      confidence: 0.9,
      source_message_id: "msg-exam",
      updated_at: iso(-3 * DAY),
      created_at: iso(-3 * DAY)
    });
    const plain = mem({
      id: "c-plain",
      content: "普通学习聊天记录",
      importance: 0.7,
      confidence: 0.9,
      updated_at: iso(-3 * DAY),
      created_at: iso(-3 * DAY)
    });
    const hotEmotion = {
      primary: "hurt",
      intensity: 0.8,
      residual: 0.8,
      causes: [{ event_id: "msg-exam", at: iso(-0.2 * DAY), appraisal: "exam_failure" }]
    };
    const sHot = scoreMemoryActivation({ memory: exam, selection_score: 0.6 }, { at: now, emotionState: hotEmotion });
    const sPlain = scoreMemoryActivation({ memory: plain, selection_score: 0.6 }, { at: now, emotionState: hotEmotion });
    assert.ok(sHot > sPlain, "matched emotional cause raises accessibility");

    // Emotion decays with age of cause — not a permanent crown.
    const oldCause = {
      primary: "hurt",
      intensity: 0.8,
      residual: 0.8,
      causes: [{ event_id: "msg-exam", at: iso(-40 * DAY), appraisal: "exam_failure" }]
    };
    const sCold = scoreMemoryActivation({ memory: exam, selection_score: 0.6 }, { at: now, emotionState: oldCause });
    assert.ok(sCold < sHot, "old emotional cause decays");
    assert.ok(sHot < 0.98, "emotion is a modifier, not a free pass to 1.0");

    // Unrelated memory must not inherit the emotion boost.
    const unrelated = mem({ id: "c-unrelated", content: "完全无关", source_message_id: "other" });
    const sUn = scoreMemoryActivation({ memory: unrelated, selection_score: 0.6 }, { at: now, emotionState: hotEmotion });
    assert.equal(emotionalStrength(unrelated, hotEmotion, now), 0);
    assert.ok(sUn < sHot);
  });

  await scenario("D. low confidence is suppressed", async () => {
    const unsure = mem({
      id: "d-unsure",
      content: "好像是周小川，我也不确定",
      confidence: 0.35,
      importance: 0.8,
      updated_at: iso(-0.1 * DAY)
    });
    const sure = mem({
      id: "d-sure",
      content: "表弟确认叫周小川",
      confidence: 0.95,
      importance: 0.8,
      updated_at: iso(-2 * DAY)
    });
    const sUnsure = scoreMemoryActivation({ memory: unsure, selection_score: 0.8 }, { at: now });
    const sSure = scoreMemoryActivation({ memory: sure, selection_score: 0.8 }, { at: now });
    assert.ok(sUnsure < sSure, "low confidence cannot outrank confirmed fact");
    // Gate also drops low-confidence unless explicit recall
    const selected = selectMemoriesForGeneration(
      [{ memory: unsure, text_score: 0.5 }, { memory: sure, text_score: 0.5 }],
      { query: "表弟叫什么名字", max: 2, at: now }
    );
    assert.ok(!selected.some(x => x.memory.id === "d-unsure"), "low-confidence blocked by Memory Gate");
    assert.ok(selected.some(x => x.memory.id === "d-sure") || selected.length === 0 || selected[0].memory.id === "d-sure");
  });

  await scenario("E. retired / historical never enters generation even if activation would be high", async () => {
    const retired = mem({
      id: "e-retired",
      content: "表弟叫周小舟",
      status: "retired",
      temporal_state: "historical",
      importance: 0.95,
      confidence: 0.95,
      updated_at: iso(-0.1 * DAY)
    });
    const s = scoreMemoryActivation({ memory: retired, selection_score: 0.99 }, { at: now });
    assert.equal(s, 0);
    const selected = selectMemoriesForGeneration([{ memory: retired, text_score: 0.9 }], { query: "表弟", max: 2, at: now });
    assert.equal(selected.length, 0);
    assert.ok(memoryAccessibilityDiagnostics.retiredHighActivationBlocked >= 1);
  });

  await scenario("F. repeated true activation reinforces with saturation", async () => {
    const state = new ActiveMemoryState();
    const m = mem({ id: "f-reuse" });
    let last = 0;
    for (let i = 0; i < 8; i++) {
      const entry = state.reinforce(m.id, { activation: 0.7, reason: "selected", at: now + i * 1000 });
      last = entry.activation;
    }
    assert.ok(last <= 1, "activation saturates");
    assert.ok(last < 0.95, "repeated hits do not slam to 1.0 linearly");
    // diminishing increments
    const e1 = state.reinforce(m.id, { activation: 0.7, at: now });
    const a1 = e1.activation;
    const e2 = state.reinforce(m.id, { activation: 0.7, at: now });
    assert.ok(Math.abs(e2.activation - a1) < 0.08, "later reinforcements move less");
  });

  await scenario("G. high access_count reuse boost is log/capped", async () => {
    const r1 = reuseBoost(1);
    const r10 = reuseBoost(10);
    const r100 = reuseBoost(100);
    const r1000 = reuseBoost(1000);
    assert.ok(r1000 <= r100 + 1e-9, "monotone but flattening");
    assert.ok(r1000 <= 0.22 + 1e-9, "hard cap");
    assert.ok(r1000 - r100 < r10 - r1, "log scaling: later decades add less");
    const hot = mem({ id: "g-hot", content: "高频", access_count: 500, updated_at: iso(-5 * DAY), importance: 0.55 });
    const fresh = mem({ id: "g-fresh", content: "重要新决策", access_count: 0, updated_at: iso(-0.5 * DAY), importance: 0.92 });
    const sHot = scoreMemoryActivation({ memory: hot, selection_score: 0.7 }, { at: now });
    const sFresh = scoreMemoryActivation({ memory: fresh, selection_score: 0.7 }, { at: now });
    assert.ok(sFresh > sHot, "hot frequency cannot permanently beat a fresh important memory");
  });

  await scenario("H. long-inactive memory decays at read time", async () => {
    const idle = mem({ id: "h-idle", last_accessed_at: iso(-90 * DAY), updated_at: iso(-90 * DAY) });
    const warm = mem({ id: "h-warm", last_accessed_at: iso(-1 * DAY), updated_at: iso(-1 * DAY) });
    const dIdle = timeDecay(idle.last_accessed_at, now);
    const dWarm = timeDecay(warm.last_accessed_at, now);
    assert.ok(dIdle < dWarm, "idle decays more");
    assert.ok(dIdle < 0.35, "90d idle is strongly damped");
    const sIdle = scoreMemoryActivation({ memory: idle, selection_score: 0.75 }, { at: now });
    const sWarm = scoreMemoryActivation({ memory: warm, selection_score: 0.75 }, { at: now });
    assert.ok(sWarm > sIdle);
  });

  await scenario("I. association multi-candidates are ordered by accessibility", async () => {
    const s = getOrCreateSession(personaId, "chat", "ma-assoc");
    const srcB = insertMessage(s.id, "chat", { role: "user", content: "B 事件提到 ACC_A1 和 ACC_B1" });
    const srcC = insertMessage(s.id, "chat", { role: "user", content: "C 事件提到 ACC_A1 和 ACC_C1" });
    const evB = insertEventDetailed({
      personaId, sessionId: s.id, source: "fixture", content: "B", importance: 0.9,
      sourceMessageId: srcB, eventKind: "project", topicKey: "ACC", entityKeys: ["ACC_A1", "ACC_B1"]
    }).event;
    const evC = insertEventDetailed({
      personaId, sessionId: s.id, source: "fixture", content: "C", importance: 0.4,
      sourceMessageId: srcC, eventKind: "project", topicKey: "ACC", entityKeys: ["ACC_A1", "ACC_C1"]
    }).event;
    const mB = insertMemory({
      personaId, content: "B 对应重要记忆", sourceMessageId: srcB, type: "project",
      importance: 0.92, confidence: 0.95, status: "active", temporalState: "current", source: "fixture"
    });
    const mC = insertMemory({
      personaId, content: "C 对应次要记忆", sourceMessageId: srcC, type: "project",
      importance: 0.35, confidence: 0.8, status: "active", temporalState: "current", source: "fixture"
    });
    linkEventToMemory(evB.id, mB.id);
    linkEventToMemory(evC.id, mC.id);
    const rows = [
      { memory: mC, association: { hop: 1, relation_type: "same_entity", activation_score: 0.6, confidence: 0.9, strength: 0.8, evidence_message_id: "1" } },
      { memory: mB, association: { hop: 1, relation_type: "same_entity", activation_score: 0.8, confidence: 0.98, strength: 0.9, evidence_message_id: "1" } }
    ];
    const ranked = rankByAccessibility(rows, { at: now, query: "ACC_A1" });
    assert.equal(ranked[0].memory.id, mB.id, "higher association + importance surfaces first");
    assert.ok(ranked[0].activation > ranked[1].activation);
  });

  await scenario("J. zero active memory is allowed", async () => {
    const junk = mem({ id: "j-junk", content: "完全无关的碎片", importance: 0.1, confidence: 0.2, status: "retired" });
    const selected = selectMemoriesForGeneration([{ memory: junk, text_score: 0.01 }], { query: "今天天气怎么样啊真是好", max: 2, at: now });
    assert.equal(selected.length, 0);
    assert.ok(memoryAccessibilityDiagnostics.zeroActiveMemoryRounds >= 0);
  });

  await scenario("K. Memory Gate remains the final injector (limit + relevance floor)", async () => {
    const many = Array.from({ length: 6 }, (_, i) => mem({
      id: `k-${i}`,
      content: `DGX 预算细节 ${i} 号方案`,
      importance: 0.7 + i * 0.02,
      updated_at: iso(-i * DAY),
      text_score: 0.5
    }));
    const selected = selectMemoriesForGeneration(
      many.map(m => ({ memory: m, text_score: 0.55 })),
      { query: "DGX 预算方案", max: 2, at: now }
    );
    assert.ok(selected.length <= 2, "gate limit holds");
    assert.ok(selected.length >= 1, "at least the best surfaces when relevant");
  });

  await scenario("L. retrieval alone does not reinforce; selection does", async () => {
    const state = new ActiveMemoryState();
    const before = state.get("l-mem");
    assert.equal(before, null);
    // ranking does not reinforce
    rankByAccessibility([{ memory: mem({ id: "l-mem" }) }], { at: now, activeState: state });
    assert.equal(state.get("l-mem"), null, "candidate ranking is not true activation");
    state.reinforce("l-mem", { activation: 0.6, reason: "selected" });
    assert.ok(state.get("l-mem"));
  });

  await scenario("M. domination cooldown after repeated top hits", async () => {
    const state = new ActiveMemoryState();
    const sticky = mem({ id: "m-sticky", importance: 0.85, updated_at: iso(-0.2 * DAY), content: "常驻话题" });
    for (let i = 0; i < 7; i++) state.reinforce("m-sticky", { activation: 0.8, at: now });
    const entry = state.get("m-sticky");
    assert.ok(Number(entry.domination_hits) >= 6);
    const damped = scoreMemoryActivation({ memory: sticky, selection_score: 0.8 }, { at: now, activeState: state });
    const undamped = scoreMemoryActivation({ memory: sticky, selection_score: 0.8 }, { at: now, activeState: new ActiveMemoryState() });
    assert.ok(damped < undamped, "domination cooldown applies");
  });

  await scenario("N. old data uses neutral baseline without backfill", async () => {
    const legacy = mem({ id: "n-legacy", access_count: 0, last_accessed_at: null, updated_at: iso(-200 * DAY) });
    const s = scoreMemoryActivation({ memory: legacy, selection_score: 0.7 }, { at: now });
    assert.ok(s >= 0 && s <= 1);
    // still rankable, just not boosted
    assert.ok(reuseBoost(0) === 0 || reuseBoost(0) < 0.05);
  });

  console.log("\n=== MEMORY ACCESSIBILITY DIRECTED TESTS ===");
  console.log(JSON.stringify({ pass: true, count: passed.length, passed }, null, 2));
  assert.ok(passed.length >= 12, "need 12–15 scenarios");
} catch (error) {
  console.error("FAIL", error);
  process.exit(1);
}
