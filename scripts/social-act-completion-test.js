import assert from "node:assert/strict";
import {
  detectUserSocialActs,
  evaluateSocialActCompletion,
  requiresSocialActCompletion,
  socialActBlock
} from "../src/social-act-completion.js";
import { selectNaturalResponsePolicy } from "../src/natural-response-policy.js";
import { conversationalImpulseBlock } from "../src/conversational-impulse.js";
import { finalizeBubblePlan, ensureSocialActCompletion } from "../src/natural-messaging.js";

// ─── 1. Real case: apology, hanging deflection ──────────────────────────────
const realUser = "好好好姐姐没有不耐烦我错了姐姐";
const acts = detectUserSocialActs(realUser);
assert.ok(acts.includes("apology"), `acts=${JSON.stringify(acts)}`);
assert.equal(requiresSocialActCompletion(realUser), true);

const hanging = evaluateSocialActCompletion(realUser, "错什么错。");
assert.equal(hanging.complete, false, "错什么错。 must be hanging after apology");
assert.equal(hanging.reason, "social_act_hanging");

const closed1 = evaluateSocialActCompletion(realUser, "错什么错，我又没怪你。");
assert.equal(closed1.complete, true, "deflect + no-blame closes");

const closed2 = evaluateSocialActCompletion(realUser, "错什么错。没生你气。");
assert.equal(closed2.complete, true, "two short clauses close");

const closed3 = evaluateSocialActCompletion(realUser, ["错什么错。", "没生你气。"]);
assert.equal(closed3.complete, true, "two bubbles close");

// ─── 2. Pure casual stays short — no social completion demand ───────────────
const casuals = {
  "嗯知道了": null,
  "行行行": null,
  "你最好了": null
};
for (const t of Object.keys(casuals)) {
  assert.equal(requiresSocialActCompletion(t), false, `no social act: ${t}`);
  assert.equal(evaluateSocialActCompletion(t, "嗯").complete, true, `casual short ok: ${t}`);
  assert.equal(evaluateSocialActCompletion(t, "你现在才知道啊").complete, true, `casual any ok: ${t}`);
}

// Praise reply is fine as short tease — not hanging.
assert.equal(evaluateSocialActCompletion("你最好了", "你现在才知道啊").complete, true);

// ─── 3. Other social regression cases ───────────────────────────────────────
const cases = [
  { user: "对不起嘛", bad: "哼。", good: "知道啦，又没怪你。" },
  { user: "我错了别生气", bad: "错什么错。", good: "谁生气了。笨。" },
  { user: "算了不跟你计较", bad: "哦。", good: "行，这次先放过你。" },
  { user: "好好好姐姐没有不耐烦我错了姐姐", bad: "错什么错。", good: "错什么错，我又没怪你。" }
];
for (const c of cases) {
  assert.equal(requiresSocialActCompletion(c.user), true, `social required: ${c.user}`);
  const bad = evaluateSocialActCompletion(c.user, c.bad);
  assert.equal(bad.complete, false, `bad must hang: ${c.user} → ${c.bad}`);
  const good = evaluateSocialActCompletion(c.user, c.good);
  assert.equal(good.complete, true, `good must close: ${c.user} → ${c.good}`);
}

// ─── 4. Framing / policy ────────────────────────────────────────────────────
const policy = selectNaturalResponsePolicy({
  userText: realUser,
  presence: { dimensions: { playfulness: { current: 0.55 }, closeness: { current: 0.85 }, confidence: { current: 0.5 }, irritation: { current: 0.25 } } }
});
assert.ok(policy.socialActs.includes("apology"));
assert.equal(policy.requiresSocialCompletion, true);
const block = conversationalImpulseBlock(policy);
assert.match(block, /Social Act/);
assert.match(block, /不要机械加第二句|不要写小作文/);

const casualPolicy = selectNaturalResponsePolicy({ userText: "你最好了" });
assert.equal(casualPolicy.requiresSocialCompletion, false);
assert.doesNotMatch(conversationalImpulseBlock(casualPolicy), /Social Act/);

// ─── 5. Repair path (single rewrite, not forced Bubble2) ────────────────────
const decisions = [];
const repaired = await ensureSocialActCompletion({
  bubbles: ["错什么错。"],
  userText: realUser,
  completeFn: async () => '{"messages":["错什么错，我又没怪你。"]}',
  onDecision: (d) => decisions.push(d)
});
assert.deepEqual(repaired, ["错什么错，我又没怪你。"]);
assert.equal(decisions.at(-1)?.outcome, "social_act_completed");
assert.equal(decisions.at(-1)?.complete, true);

// Already closed → no repair.
const noop = await ensureSocialActCompletion({
  bubbles: ["错什么错，我又没怪你。"],
  userText: realUser,
  completeFn: async () => {
    throw new Error("should not run");
  }
});
assert.deepEqual(noop, ["错什么错，我又没怪你。"]);

// ─── 6. finalizeBubblePlan integration ──────────────────────────────────────
let socialCalled = false;
const { plan, trace } = await finalizeBubblePlan({
  rawModelOutput: '{"messages":["错什么错。"]}',
  userText: realUser,
  generationRoute: "verify",
  turnId: "social-turn",
  completeFn: async ({ mode }) => {
    if (mode === "social") {
      socialCalled = true;
      return '{"messages":["错什么错，我又没怪你。"]}';
    }
    throw new Error("unexpected mode " + mode);
  }
});
assert.equal(socialCalled, true);
assert.deepEqual(plan.map((p) => p.text), ["错什么错，我又没怪你。"]);
assert.equal(trace.socialDecision.complete, true);
assert.notDeepEqual(plan.map((p) => p.text), ["错什么错。"]);

// Pure casual through finalize stays one short bubble.
const casualFinal = await finalizeBubblePlan({
  rawModelOutput: '{"messages":["行。"]}',
  userText: "行行行",
  generationRoute: "verify",
  turnId: "casual-turn",
  completeFn: async () => {
    throw new Error("casual must not repair");
  }
});
assert.deepEqual(casualFinal.plan.map((p) => p.text), ["行。"]);
assert.equal(casualFinal.trace.socialDecision.complete ?? true, true);

// ─── 7. socialActBlock ──────────────────────────────────────────────────────
const sb = socialActBlock(realUser);
assert.match(sb, /道歉/);
assert.match(sb, /不要机械加第二句/);

console.log("social-act-completion regression tests passed");
