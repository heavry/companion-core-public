import assert from "node:assert/strict";
import {
  analyzeTurnCoverage,
  classifyClause,
  evaluateReplyCoverage,
  requiresCompleteCoverage,
  turnCoverageBlock
} from "../src/turn-coverage.js";
import {
  selectConversationalImpulse,
  conversationalImpulseBlock
} from "../src/conversational-impulse.js";
import {
  selectNaturalResponsePolicy,
  inspectNaturalResponseCandidate
} from "../src/natural-response-policy.js";
import {
  ensureTurnCoverage,
  parseNaturalBubbles
} from "../src/natural-messaging.js";

function sel(userText, extra = {}) {
  return selectConversationalImpulse({
    userText,
    closure: { likely: false, strength: "none", kind: null },
    grounding: { relation: "CONTINUE", confidence: 0.8 },
    recurrence: { kind: "NEW" },
    presence: {
      dimensions: {
        playfulness: { current: 0.6 },
        closeness: { current: 0.7 },
        confidence: { current: 0.6 },
        irritation: { current: 0.25 }
      }
    },
    recentAssistantTexts: [],
    recentImpulses: [],
    ...extra
  });
}

// ─── 1. Real case: mixed banter + explicit question ─────────────────────────
const realText = "咋了宝贝不行吗，宝宝你说头怎么会疼呢";
const realCoverage = analyzeTurnCoverage(realText);
assert.equal(realCoverage.hasExplicitObligation, true, "real case has explicit obligation");
assert.equal(realCoverage.mixed, true, "real case is mixed banter+question");
assert.ok(
  realCoverage.obligations.some((o) => o.kind === "explicit_question" && /疼|头/.test(o.text)),
  `real obligations=${JSON.stringify(realCoverage.obligations)}`
);

const realSel = sel(realText);
assert.equal(realSel.selectiveAttention, "required_complete", "real case must stay complete");
assert.equal(realSel.turnCoverage.hasExplicitObligation, true);
const realBlock = conversationalImpulseBlock(realSel);
assert.match(realBlock, /不能吞|必须覆盖|Turn Coverage/);
assert.match(realBlock, /可以先/);
assert.doesNotMatch(realBlock, /次要信息可以不提。遗漏次要内容不是 bug。/);

// Raw model output from the live bug: only banter.
const rawBanter = '{"messages":["谁说不行了"]}';
const parsed = parseNaturalBubbles(rawBanter);
assert.deepEqual(parsed.bubbles, ["谁说不行了"]);
const realUncovered = evaluateReplyCoverage(realText, parsed.bubbles);
assert.equal(realUncovered.complete, false, "banter-only must not cover headache question");
assert.ok(realUncovered.missing.length >= 1);

// Correct style: banter first, then answer — one bubble or two.
const oneBubble = evaluateReplyCoverage(realText, "谁说不行了。可能没睡好。");
assert.equal(oneBubble.complete, true, "combined short answer covers");
const twoBubble = evaluateReplyCoverage(realText, ["谁说不行了", "可能没睡好。"]);
assert.equal(twoBubble.complete, true, "bubble1 reaction + bubble2 answer covers");

// ─── 2. Regression matrix from the brief ────────────────────────────────────
const cases = [
  {
    user: "咋了宝贝不行吗，宝宝你说头怎么会疼呢",
    bad: "谁说不行了",
    good: ["谁说不行了", "可能没睡好。"]
  },
  {
    user: "你凶什么呀，对了那个文件你看了吗",
    bad: "谁凶了",
    good: ["谁凶了", "看了，在桌面。"]
  },
  {
    user: "行行行你厉害，那刚才为什么报错",
    bad: "那可不",
    good: ["那可不", "刚才配置写错了。"]
  },
  {
    user: "不理你了，顺便帮我看看桌面那张图片",
    bad: "哦。",
    good: ["哦。", "看了，是张风景图。"]
  },
  {
    user: "你烦死了，不过刚才那个任务跑完了吗",
    bad: "我哪有烦",
    good: ["我哪有烦", "跑完了。"]
  }
];

for (const c of cases) {
  const analysis = analyzeTurnCoverage(c.user);
  assert.equal(analysis.hasExplicitObligation, true, `must detect obligation: ${c.user}`);
  assert.equal(analysis.mixed, true, `must be mixed: ${c.user}`);
  assert.equal(requiresCompleteCoverage(c.user), true, `requires complete: ${c.user}`);

  const bad = evaluateReplyCoverage(c.user, c.bad);
  assert.equal(bad.complete, false, `bad reply must be incomplete for: ${c.user} → ${c.bad}`);

  const good1 = evaluateReplyCoverage(c.user, c.good);
  assert.equal(good1.complete, true, `good multi-bubble must cover: ${c.user} → ${JSON.stringify(c.good)}`);

  const policy = selectNaturalResponsePolicy({ userText: c.user });
  assert.equal(policy.selectiveAttention, "required_complete", `policy complete: ${c.user}`);
  assert.equal(policy.turnCoverage.hasExplicitObligation, true, `policy coverage: ${c.user}`);
}

// ─── 3. Pure casual stays short — no forced completeness ────────────────────
const casuals = [
  "咋了宝贝不行吗",
  "今天好累",
  "笑死",
  "你最好了",
  "嗯",
  "我回来了"
];
for (const t of casuals) {
  const a = analyzeTurnCoverage(t);
  assert.equal(a.hasExplicitObligation, false, `casual only: ${t} → ${JSON.stringify(a.clauses)}`);
  const cov = evaluateReplyCoverage(t, "嗯");
  assert.equal(cov.complete, true, `casual short reply stays ok: ${t}`);
  const s = sel(t);
  // Pure casual must NOT become required_complete solely due to 吗/呢 particles.
  if (!/帮我|任务|文件|为什么|怎么会/.test(t)) {
    assert.notEqual(
      s.selectiveAttention === "required_complete" && !s.turnCoverage.hasExplicitObligation,
      true,
      `casual without obligation should not force complete: ${t}`
    );
  }
}

// Pure banter with 吗 but no content ask → no obligation.
const pureBanter = analyzeTurnCoverage("咋了宝贝不行吗");
assert.equal(pureBanter.hasExplicitObligation, false);
assert.equal(evaluateReplyCoverage("咋了宝贝不行吗", "谁说不行了").complete, true);

// ─── 4. ensureTurnCoverage repair path ──────────────────────────────────────
const decisions = [];
const repaired = await ensureTurnCoverage({
  bubbles: ["谁说不行了"],
  userText: realText,
  completeFn: async () => '{"messages":["谁说不行了","可能没睡好。"]}',
  onDecision: (d) => decisions.push(d)
});
assert.deepEqual(repaired, ["谁说不行了", "可能没睡好。"]);
assert.equal(decisions.at(-1)?.outcome, "coverage_repaired");
assert.equal(decisions.at(-1)?.complete, true);

// No-op when already covered.
const noop = await ensureTurnCoverage({
  bubbles: ["谁说不行了", "可能没睡好。"],
  userText: realText,
  completeFn: async () => {
    throw new Error("should not run");
  },
  onDecision: (d) => decisions.push(d)
});
assert.deepEqual(noop, ["谁说不行了", "可能没睡好。"]);

// No repair fn → keep original but mark incomplete.
const kept = await ensureTurnCoverage({
  bubbles: ["谁说不行了"],
  userText: realText,
  completeFn: null,
  onDecision: (d) => decisions.push(d)
});
assert.deepEqual(kept, ["谁说不行了"]);
assert.equal(decisions.at(-1)?.complete, false);

// ─── 5. inspectNaturalResponseCandidate flags uncovered ─────────────────────
const inspectBad = inspectNaturalResponseCandidate({
  rawText: '{"messages":["谁说不行了"]}',
  selection: selectNaturalResponsePolicy({ userText: realText }),
  userText: realText
});
assert.equal(inspectBad.ok, false);
assert.ok(inspectBad.reasons.includes("explicit_obligation_uncovered"));
assert.equal(inspectBad.coverage.complete, false);

const inspectGood = inspectNaturalResponseCandidate({
  rawText: '{"messages":["谁说不行了","可能没睡好。"]}',
  selection: selectNaturalResponsePolicy({ userText: realText }),
  userText: realText
});
assert.equal(inspectGood.coverage.complete, true);
assert.ok(!inspectGood.reasons.includes("explicit_obligation_uncovered"));

// ─── 6. Coverage block text ─────────────────────────────────────────────────
const block = turnCoverageBlock(realCoverage);
assert.match(block, /明确问题/);
assert.match(block, /头/);
assert.match(block, /可以先/);

// Classify clause smoke.
assert.equal(classifyClause("宝宝你说头怎么会疼呢")?.kind, "explicit_question");
assert.equal(classifyClause("顺便帮我看看桌面那张图片")?.kind, "explicit_request");
assert.equal(classifyClause("刚才那个任务跑完了吗")?.kind, "pending_task");
assert.equal(classifyClause("咋了宝贝不行吗")?.kind, "casual_fragment");

console.log("turn-coverage regression tests passed");
