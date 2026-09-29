import assert from "node:assert/strict";
import {
  detectRelationalActs,
  evaluateCharacterRealization,
  requiresCharacterRealization,
  relationalCharacterBlock
} from "../src/relational-character.js";
import { selectNaturalResponsePolicy } from "../src/natural-response-policy.js";
import { conversationalImpulseBlock } from "../src/conversational-impulse.js";
import { finalizeBubblePlan, ensureRelationalCharacter } from "../src/natural-messaging.js";
import { detectUserSocialActs } from "../src/social-act-completion.js";
import { analyzeTurnCoverage } from "../src/turn-coverage.js";

const happyPresence = {
  dimensions: {
    playfulness: { current: 0.66 },
    closeness: { current: 0.98 },
    confidence: { current: 0.97 },
    irritation: { current: 0.53 },
    mood: { current: 0.99 },
    energy: { current: 0.67 }
  }
};

// ─── 1. Real case: 宝宝亲一个 → 亲一口。 ────────────────────────────────────
const realUser = "宝宝亲一个";
const acts = detectRelationalActs(realUser);
assert.ok(acts.includes("affection_bid"), `acts=${JSON.stringify(acts)}`);
assert.equal(requiresCharacterRealization(realUser), true);

const mechanical = evaluateCharacterRealization(realUser, "亲一口。", happyPresence);
assert.equal(mechanical.complete, false, "亲一口。 is mechanical echo");
assert.equal(mechanical.reason, "character_under_realized");

const realized1 = evaluateCharacterRealization(realUser, "过来，亲一口。", happyPresence);
assert.equal(realized1.complete, true, "stance 过来 realizes");

const realized2 = evaluateCharacterRealization(realUser, "就一下啊。", happyPresence);
assert.equal(realized2.complete, true);

const realized3 = evaluateCharacterRealization(realUser, "真拿你没办法。", happyPresence);
assert.equal(realized3.complete, true);

// ─── 2. Non-overlap with Coverage / Social Act ──────────────────────────────
assert.deepEqual(detectRelationalActs("咋了宝贝不行吗，宝宝你说头怎么会疼呢"), [], "coverage turn not relational");
assert.deepEqual(detectRelationalActs("好好好姐姐没有不耐烦我错了姐姐"), [], "apology not relational");
assert.equal(analyzeTurnCoverage("宝宝亲一个").hasExplicitObligation, false);
assert.deepEqual(detectUserSocialActs("宝宝亲一个"), []);

// ─── 3. Pure casual stays very short — no forced character rewrite ──────────
const casuals = ["嗯", "行行行", "知道了", "晚点说"];
for (const t of casuals) {
  assert.equal(requiresCharacterRealization(t), false, `not relational: ${t}`);
  const ev = evaluateCharacterRealization(t, "嗯");
  assert.equal(ev.complete, true, `casual passes: ${t}`);
  assert.equal(ev.reason, "not_relational");
}

// ─── 4. Other relational cases must not stay mechanical ─────────────────────
const cases = [
  { user: "宝宝你好棒", bad: "谢谢。", good: "少来，今天怎么这么甜。" },
  { user: "嘿嘿宝宝亲一个", bad: "亲一口。", good: "又来？就一下。" },
  { user: "笑死你干嘛", bad: "好的。", good: "干嘛？怕你无聊呗。" },
  { user: "想你了", bad: "嗯。", good: "才不信。过来。" }
];
for (const c of cases) {
  assert.equal(requiresCharacterRealization(c.user), true, `relational: ${c.user}`);
  const bad = evaluateCharacterRealization(c.user, c.bad, happyPresence);
  assert.equal(bad.complete, false, `bad under-realized: ${c.user} → ${c.bad}`);
  const good = evaluateCharacterRealization(c.user, c.good, happyPresence);
  assert.equal(good.complete, true, `good realized: ${c.user} → ${c.good}`);
}

// ─── 5. Mood / irritation must not force high energy ────────────────────────
const annoyed = { dimensions: { irritation: { current: 0.72 }, mood: { current: 0.35 }, closeness: { current: 0.9 }, playfulness: { current: 0.4 } } };
const coldOk = evaluateCharacterRealization("宝宝亲一个", "哼。给你。", annoyed);
assert.equal(coldOk.complete, true, "annoyed short stance is realized");
const blockAnnoyed = relationalCharacterBlock("宝宝亲一个", annoyed, { acts: ["affection_bid"] });
assert.match(blockAnnoyed, /不必热情|略带刺|偏淡|更熟/);

const calmBlock = relationalCharacterBlock("宝宝亲一个", { dimensions: { mood: { current: 0.3 }, irritation: { current: 0.1 } } }, { acts: ["affection_bid"] });
assert.match(calmBlock, /不要强行兴奋|偏淡|不要强制/);

// ─── 6. Framing / policy ────────────────────────────────────────────────────
const policy = selectNaturalResponsePolicy({ userText: realUser, presence: happyPresence });
assert.ok(policy.relationalActs.includes("affection_bid"));
assert.equal(policy.requiresCharacterRealization, true);
const pblock = conversationalImpulseBlock(policy);
assert.match(pblock, /Relational Character|人物感/);
assert.match(pblock, /不要强制两句/);

const casualPolicy = selectNaturalResponsePolicy({ userText: "知道了" });
assert.equal(casualPolicy.requiresCharacterRealization, false);
assert.doesNotMatch(conversationalImpulseBlock(casualPolicy), /人物感/);

// ─── 7. One rewrite only, same length class ─────────────────────────────────
const decisions = [];
const repaired = await ensureRelationalCharacter({
  bubbles: ["亲一口。"],
  userText: realUser,
  presence: happyPresence,
  completeFn: async () => '{"messages":["过来，亲一口。"]}',
  onDecision: (d) => decisions.push(d)
});
assert.deepEqual(repaired, ["过来，亲一口。"]);
assert.equal(decisions.at(-1)?.outcome, "character_realized");
assert.ok(repaired[0].length <= 20, "same length class");

const noop = await ensureRelationalCharacter({
  bubbles: ["真拿你没办法。"],
  userText: realUser,
  completeFn: async () => {
    throw new Error("should not run");
  }
});
assert.deepEqual(noop, ["真拿你没办法。"]);

// ─── 8. finalizeBubblePlan integration ──────────────────────────────────────
let charCalled = false;
const { plan, trace } = await finalizeBubblePlan({
  rawModelOutput: '{"messages":["亲一口。"]}',
  userText: realUser,
  generationRoute: "verify",
  turnId: "char-turn",
  presence: happyPresence,
  completeFn: async ({ mode }) => {
    if (mode === "character") {
      charCalled = true;
      return '{"messages":["过来，亲一口。"]}';
    }
    throw new Error("unexpected mode " + mode);
  }
});
assert.equal(charCalled, true);
assert.deepEqual(plan.map((p) => p.text), ["过来，亲一口。"]);
assert.equal(trace.characterDecision.complete, true);
assert.notDeepEqual(plan.map((p) => p.text), ["亲一口。"]);

// Casual through finalize stays one short bubble.
const casualFinal = await finalizeBubblePlan({
  rawModelOutput: '{"messages":["嗯。"]}',
  userText: "嗯",
  generationRoute: "verify",
  turnId: "casual-char",
  completeFn: async () => {
    throw new Error("casual must not repair");
  }
});
assert.deepEqual(casualFinal.plan.map((p) => p.text), ["嗯。"]);

// Apology still goes to social, not character.
const socialFinal = await finalizeBubblePlan({
  rawModelOutput: '{"messages":["错什么错。"]}',
  userText: "好好好姐姐没有不耐烦我错了姐姐",
  generationRoute: "verify",
  turnId: "social-char",
  completeFn: async ({ mode }) => {
    if (mode === "social") return '{"messages":["错什么错，我又没怪你。"]}';
    throw new Error("unexpected mode " + mode);
  }
});
assert.deepEqual(socialFinal.plan.map((p) => p.text), ["错什么错，我又没怪你。"]);
assert.ok(
  ["not_run", "not_relational", "not_applicable"].includes(socialFinal.trace.characterDecision.outcome),
  `character must not steal social turn: ${socialFinal.trace.characterDecision.outcome}`
);

console.log("relational-character regression tests passed");
