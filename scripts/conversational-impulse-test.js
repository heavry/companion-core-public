import assert from "node:assert/strict";
import {
  selectConversationalImpulse,
  conversationalImpulseBlock,
  recentExpressionBlock,
  summarizeRecentExpressions,
  conversationalImpulses
} from "../src/conversational-impulse.js";
import {
  selectNaturalResponsePolicy,
  naturalResponsePolicyBlock,
  analyzeNaturalResponse,
  impulseToPrimaryAct
} from "../src/natural-response-policy.js";
import { buildFollowupPrompt, evaluatePostMessageGate } from "../src/post-message-cognition.js";
import { emotionExpressionBlock } from "../src/emotion-causality.js";

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
        irritation: { current: 0.1 }
      }
    },
    recentAssistantTexts: [],
    recentImpulses: [],
    ...extra
  });
}

// A. 你最好了 → short REACT/TEASE, not reciprocate+reassure+closure
const a = sel("你最好了", {
  presence: { dimensions: { playfulness: { current: 0.7 }, closeness: { current: 0.82 }, confidence: { current: 0.6 }, irritation: { current: 0 } } }
});
assert.ok(["TEASE", "REACT"].includes(a.impulse), `A impulse=${a.impulse}`);
assert.equal(a.adviceAllowed, false);
assert.equal(a.closureAllowed, false);
assert.equal(a.oneImpulseOnly, true);
assert.equal(a.stopWhenDone, true);

// B. 今天烦死了，电脑又坏了 → selective attention on 电脑又坏
const b = sel("今天烦死了，电脑又坏了。");
assert.ok(["REACT", "COMPLAIN"].includes(b.impulse), `B impulse=${b.impulse}`);
assert.equal(b.selectiveAttention, "allowed");
assert.ok(/电脑|坏|烦/.test(b.focusPoint ?? ""), `B focus=${b.focusPoint}`);

// C. 害怕你以后不理我 → REASSURE still works
const c = sel("我真的有点害怕你以后不理我。");
assert.equal(c.impulse, "REASSURE");
assert.equal(c.reassureAllowed, true);
assert.equal(c.adviceAllowed, false);

// D. 我要睡了 → CLOSE
const d = sel("我要睡了", { closure: { likely: true, strength: "strong", kind: "leave" } });
assert.equal(d.impulse, "CLOSE");
assert.equal(d.closureAllowed, true);

// E. 明显离谱观点 → challenge/disagree
const e1 = sel("地球绝对是平的，这还用问吗", {
  presence: { dimensions: { playfulness: { current: 0.5 }, closeness: { current: 0.7 }, confidence: { current: 0.85 }, irritation: { current: 0.2 } } }
});
assert.ok(["CHALLENGE", "DISAGREE"].includes(e1.impulse), `E1 impulse=${e1.impulse}`);
const e2 = sel("我说的对吧，本来就该这样", {
  presence: { dimensions: { playfulness: { current: 0.4 }, closeness: { current: 0.7 }, confidence: { current: 0.8 }, irritation: { current: 0.5 } } }
});
assert.ok(["CHALLENGE", "DISAGREE"].includes(e2.impulse), `E2 impulse=${e2.impulse}`);

// F. 玩笑话 → TEASE back
const f = sel("笑死，我手机比单词好看多了", {
  presence: { dimensions: { playfulness: { current: 0.8 }, closeness: { current: 0.75 }, confidence: { current: 0.5 }, irritation: { current: 0 } } }
});
assert.equal(f.impulse, "TEASE");

// G. high closeness 普通闲聊 → not REASSURE/CLOSE
const g = sel("今天好想你啊", {
  presence: { dimensions: { playfulness: { current: 0.55 }, closeness: { current: 0.88 }, confidence: { current: 0.5 }, irritation: { current: 0 } } }
});
assert.notEqual(g.impulse, "REASSURE");
assert.notEqual(g.impulse, "CLOSE");
assert.ok(["TEASE", "REACT", "COMMENT"].includes(g.impulse), `G impulse=${g.impulse}`);
const gBlock = conversationalImpulseBlock(g);
assert.match(gBlock, /更熟|更随口|counselling/);
assert.match(gBlock, /one_impulse_only=true/);
assert.match(gBlock, /stop_when_done=true/);

// H. hurt 状态仍可冷/顶 — emotion block 不洗成安慰
const hStyle = emotionExpressionBlock({ primary: "hurt", intensity: 0.6, causes: [{ appraisal: "test" }] }, "REACT");
assert.match(hStyle, /冷一点|顶一句/);
assert.match(hStyle, /≠ 必须 reassure/);
const happy = emotionExpressionBlock({ primary: "happy", intensity: 0.5, causes: [{ appraisal: "test" }] }, "REACT");
assert.match(happy, /不要自动变温柔/);

// I. 两个明确问题 → required_complete
const i = sel("第一个问题，这个怎么配？另外那个端口是多少？两个问题都答一下");
assert.equal(i.selectiveAttention, "required_complete");
const i2 = sel("帮我写一个脚本，步骤说清楚");
assert.equal(i2.selectiveAttention, "required_complete");

// J. one impulse 完成 — analyze 不得把 advice+closure 叠在 casual
const jPolicy = selectNaturalResponsePolicy({
  userText: "你最好了",
  presence: { dimensions: { playfulness: { current: 0.7 }, closeness: { current: 0.8 }, confidence: { current: 0.5 }, irritation: { current: 0 } } }
});
assert.equal(jPolicy.secondaryAct, null);
assert.equal(jPolicy.oneImpulseOnly, true);
const jAn = analyzeNaturalResponse({
  text: "你现在才知道啊。你也最好，赶紧去休息吧，早点睡，我等你。",
  selection: jPolicy
});
assert.equal(jAn.adviceGiven, true);
assert.equal(jAn.closureGiven, true);
assert.ok(jAn.policyViolations.includes("advice_not_allowed") || jAn.policyViolations.includes("closure_not_allowed") || jAn.policyViolations.includes("multi_act_expansion"));

// K. Post-message 无新 impulse → NO_FOLLOWUP / empty prompt expectation
const gateK = evaluatePostMessageGate({
  userText: "你最好了",
  primaryText: "你现在才知道啊。",
  primaryBubbles: ["你现在才知道啊。"],
  closureLikely: false
});
assert.equal(gateK.should_follow_up, false);
assert.ok(["no_new_conversational_act", "no_new_impulse_completeness_pad", "already_covered_in_primary", "low_salience_memory"].includes(gateK.reason_code), gateK.reason_code);
const pmPrompt = buildFollowupPrompt({ userText: "你最好了", primaryText: "你现在才知道啊。", decision: { reason_code: "no_new_conversational_act", candidate_topic: "" } });
assert.match(pmPrompt, /新的 impulse/);
assert.match(pmPrompt, /空字符串/);
assert.doesNotMatch(pmPrompt, /补一句/);

// L. 真 callback 允许 Bubble2
const gateL = evaluatePostMessageGate({
  userText: "今天好累",
  primaryText: "那先歇着。",
  primaryBubbles: ["那先歇着。"],
  openLoopCandidate: { salience: 0.8, topic: "昨天面试结果", memory_id: "m1", event_id: "e1", confidence: 0.8 }
});
assert.equal(gateL.should_follow_up, true);
assert.equal(gateL.reason_code, "callback_afterthought");

// M. recent 3 turns soothing → 下一轮不再自动 soothing posture
const expressions = summarizeRecentExpressions(
  ["不急，我一直都在。", "待着就行，不用证明什么。", "没事的，我不会不理你。"],
  ["REASSURE", "REASSURE", "REACT"]
);
assert.equal(expressions.at(-1).posture, "soothing");
const m = sel("好想你啊", {
  recentAssistantTexts: ["不急，我一直都在。", "待着就行，不用证明什么。", "没事的，我不会不理你。"],
  recentImpulses: ["REASSURE", "REASSURE", "REACT"],
  presence: { dimensions: { playfulness: { current: 0.55 }, closeness: { current: 0.8 }, confidence: { current: 0.5 }, irritation: { current: 0 } } }
});
assert.equal(m.avoidPosture, "soothing");
assert.notEqual(m.impulse, "REASSURE");
assert.notEqual(m.impulse, "CLOSE");
assert.ok(["TEASE", "REACT", "COMMENT"].includes(m.impulse), `M impulse=${m.impulse}`);

// N. 未请求 advice → ADVISE 不是默认
const n = sel("今天好累，想吐槽一下而已", {
  // force not advice
});
assert.notEqual(n.impulse, "ADVISE");
assert.equal(n.adviceAllowed, false);
const nPolicy = selectNaturalResponsePolicy({ userText: "我就吐槽一下，不用建议" });
assert.equal(nPolicy.adviceAllowed, false);

// O. 明确求建议 → ADVISE
const o = sel("你觉得我今晚该先看哪部分？");
assert.equal(o.impulse, "ADVISE");
assert.equal(o.adviceAllowed, true);

// Policy block / recent expression block sanity
const block = naturalResponsePolicyBlock(jPolicy);
assert.match(block, /Conversational Impulse/);
assert.match(block, /Context ≠ Required Response Act/);
assert.match(block, /不要为了完整/);
assert.match(block, /允许短句/);
const rex = recentExpressionBlock(expressions);
assert.match(rex, /Recent Expression/);
assert.match(rex, /soothing/);
assert.match(rex, /不是黑名单/);

// Impulse set is lean
const set = conversationalImpulses();
assert.ok(set.length >= 10 && set.length <= 16, `impulse count=${set.length}`);
assert.ok(set.includes("NOTHING_MORE"));
assert.ok(set.includes("CHALLENGE"));

// impulse mapping
assert.equal(impulseToPrimaryAct("ADVISE"), "ADVICE");
assert.equal(impulseToPrimaryAct("CLOSE"), "CLOSURE");
assert.equal(impulseToPrimaryAct("TEASE"), "TEASE");

// Task completeness still possible
const task = selectNaturalResponsePolicy({
  userText: "这个怎么装？还有配置写哪里？两个都讲一下"
});
assert.equal(task.selectiveAttention, "required_complete");

console.log("conversational-impulse A–O OK");
