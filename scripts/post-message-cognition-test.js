import assert from "node:assert/strict";
import {
  evaluatePostMessageGate,
  runPostMessagePhase,
  isSemanticDuplicate,
  PostMessageRegistry,
  postMessageAttemptKey,
  resetPostMessageDiagnostics,
  postMessageDiagnostics
} from "../src/post-message-cognition.js";
import { originForBubble, createBubblePlan } from "../src/natural-messaging.js";

const passed = [];
async function scenario(name, fn) {
  resetPostMessageDiagnostics();
  await fn();
  passed.push(name);
  console.log("PASS", name);
}

try {
  await scenario("A. short ack → NO_FOLLOWUP", async () => {
    const d = evaluatePostMessageGate({ userText: "好。", primaryText: "嗯。", primaryBubbles: ["嗯。"] });
    assert.equal(d.should_follow_up, false);
  });

  await scenario("B. simple complete answer → no hard addendum", async () => {
    const d = evaluatePostMessageGate({
      userText: "今天周几？",
      primaryText: "今天是周三。",
      primaryBubbles: ["今天是周三。"]
    });
    assert.equal(d.should_follow_up, false);
  });

  await scenario("C. association afterthought is a true second generation", async () => {
    let generations = 0;
    const registry = new PostMessageRegistry();
    const result = await runPostMessagePhase({
      parentTurnId: "turn-C",
      parentUserMessageId: 10,
      sessionId: "s",
      userText: "A1又降价了。",
      primaryText: "这价格确实比你之前看的低不少。",
      primaryBubbles: ["这价格确实比你之前看的低不少。"],
      gateInputs: {
        associationCandidate: {
          salience: 0.82,
          topic: "DGX 预算优先，所以之前没买 A1",
          memory_id: "m-dgx",
          event_id: "e-dgx",
          confidence: 0.9
        }
      },
      registry,
      generateFollowup: async () => {
        generations++;
        return "不过你之前卡住好像也不完全是价格，主要还是想先留钱给 DGX。";
      },
      deliverFollowup: async ({ text, decision, attemptKey }) => ({
        messageId: 200,
        text,
        plan: { origin: "post_message_followup" },
        attemptKey,
        decision
      })
    });
    assert.equal(result.delivered, true);
    assert.equal(generations, 1, "Bubble 2 requires a second generation call");
    assert.equal(result.decision.reason_code, "association_afterthought");
    assert.equal(postMessageDiagnostics.truePostMessageBubbleCount, 1);
    assert.equal(postMessageAttemptKey("turn-C", 1), "postmsg:turn-C:1");
  });

  await scenario("D. memory afterthought can follow once", async () => {
    const result = await runPostMessagePhase({
      parentTurnId: "turn-D",
      parentUserMessageId: 11,
      sessionId: "s",
      userText: "设备那边先这样。",
      primaryText: "行，那我先按这个记着。",
      primaryBubbles: ["行，那我先按这个记着。"],
      gateInputs: {
        activeMemory: { salience: 0.7, topic: "DGX 预算是最高优先", memory_id: "m1", confidence: 0.85 }
      },
      registry: new PostMessageRegistry(),
      generateFollowup: async () => "对了，DGX 预算还是排最前面。",
      deliverFollowup: async ({ text }) => ({ messageId: 1, text })
    });
    assert.equal(result.delivered, true);
    assert.equal(result.decision.reason_code, "memory_afterthought");
  });

  await scenario("E. emotion never auto-repairs with Bubble 2", async () => {
    const d = evaluatePostMessageGate({
      userText: "随便。",
      primaryText: "行。",
      primaryBubbles: ["行。"],
      emotionState: { intensity: 0.8, primary: "hurt" }
    });
    assert.equal(d.should_follow_up, false, "hurt/annoyed alone must not force follow-up");
    assert.equal(postMessageDiagnostics.autoReconciliationCount, 0);
  });

  await scenario("F. user leaving → NO_FOLLOWUP", async () => {
    const d = evaluatePostMessageGate({
      userText: "我睡了。",
      primaryText: "睡吧，晚安。",
      primaryBubbles: ["睡吧，晚安。"],
      userLeaving: true
    });
    assert.equal(d.should_follow_up, false);
    const r = await runPostMessagePhase({
      parentTurnId: "turn-F",
      parentUserMessageId: 12,
      userText: "我睡了。",
      primaryText: "晚安",
      primaryBubbles: ["晚安"],
      userLeaving: true,
      gateInputs: { activeMemory: { salience: 0.9, topic: "还要聊 DGX", memory_id: "m", confidence: 0.9 } },
      registry: new PostMessageRegistry(),
      generateFollowup: async () => "不该出现",
      deliverFollowup: async ({ text }) => ({ messageId: 1, text })
    });
    assert.equal(r.delivered, false);
  });

  await scenario("G. user interrupt cancels pending follow-up", async () => {
    let interrupted = false;
    const result = await runPostMessagePhase({
      parentTurnId: "turn-G",
      parentUserMessageId: 20,
      sessionId: "s",
      userText: "A1",
      primaryText: "收到 A1。",
      primaryBubbles: ["收到 A1。"],
      gateInputs: {
        associationCandidate: { salience: 0.8, topic: "DGX 预算", memory_id: "m", confidence: 0.9 }
      },
      registry: new PostMessageRegistry(),
      userInterrupted: () => interrupted,
      getLatestUserMessageId: () => (interrupted ? 21 : 20),
      generateFollowup: async () => {
        // user speaks mid-generation
        interrupted = true;
        return "旧话题补充";
      },
      deliverFollowup: async ({ text }) => ({ messageId: 1, text })
    });
    assert.equal(result.delivered, false, "must drop after user interrupt");
    assert.ok(
      postMessageDiagnostics.staleFollowupAfterUserInterrupt >= 1 ||
        postMessageDiagnostics.suppressedByUserInterrupt >= 1
    );
    assert.equal(postMessageDiagnostics.postMessageDuplicateCount + postMessageDiagnostics.autoReconciliationCount, 0);
  });

  await scenario("H. semantic duplicate is suppressed", async () => {
    const primary = "这价格确实比你之前看的低不少。";
    assert.equal(isSemanticDuplicate(primary, "这价格确实比你之前看的低不少。"), true);
    const result = await runPostMessagePhase({
      parentTurnId: "turn-H",
      parentUserMessageId: 30,
      userText: "A1便宜了",
      primaryText: primary,
      primaryBubbles: [primary],
      gateInputs: {
        associationCandidate: { salience: 0.8, topic: "DGX 预算优先所以没下单", memory_id: "m", confidence: 0.9 }
      },
      registry: new PostMessageRegistry(),
      generateFollowup: async () => "这价格确实比你之前看的低不少。",
      deliverFollowup: async ({ text }) => ({ messageId: 1, text })
    });
    assert.equal(result.delivered, false);
    assert.equal(result.reason, "duplicate");
    assert.equal(postMessageDiagnostics.postMessageDuplicateCount, 1);
  });

  await scenario("I. provider failure keeps primary success semantics", async () => {
    const result = await runPostMessagePhase({
      parentTurnId: "turn-I",
      parentUserMessageId: 40,
      userText: "A1",
      primaryText: "Bubble1 已成功。",
      primaryBubbles: ["Bubble1 已成功。"],
      gateInputs: {
        associationCandidate: { salience: 0.8, topic: "DGX", memory_id: "m", confidence: 0.9 }
      },
      registry: new PostMessageRegistry(),
      generateFollowup: async () => {
        throw Object.assign(new Error("upstream 429"), { statusCode: 429 });
      },
      deliverFollowup: async ({ text }) => ({ messageId: 1, text })
    });
    assert.equal(result.delivered, false);
    assert.equal(postMessageDiagnostics.followupProviderFailure, 1);
    assert.equal(postMessageDiagnostics.postMessageSentCount, 0);
    // primary is untouched by design
  });

  await scenario("J. restart/idempotency allows at most one follow-up per turn", async () => {
    const registry = new PostMessageRegistry();
    const a = await runPostMessagePhase({
      parentTurnId: "turn-J",
      parentUserMessageId: 50,
      userText: "A1",
      primaryText: "主回复",
      primaryBubbles: ["主回复"],
      gateInputs: {
        associationCandidate: { salience: 0.8, topic: "DGX", memory_id: "m", confidence: 0.9 }
      },
      registry,
      generateFollowup: async () => "补充一句",
      deliverFollowup: async ({ text }) => ({ messageId: 1, text })
    });
    const b = await runPostMessagePhase({
      parentTurnId: "turn-J",
      parentUserMessageId: 50,
      userText: "A1",
      primaryText: "主回复",
      primaryBubbles: ["主回复"],
      gateInputs: {
        associationCandidate: { salience: 0.8, topic: "DGX", memory_id: "m", confidence: 0.9 }
      },
      registry,
      generateFollowup: async () => "再补一句",
      deliverFollowup: async ({ text }) => ({ messageId: 2, text })
    });
    assert.equal(a.delivered, true);
    assert.equal(b.delivered, false);
    assert.equal(b.reason, "already_started");
  });

  await scenario("K. high-salience callback can earn Bubble 2", async () => {
    const result = await runPostMessagePhase({
      parentTurnId: "turn-K",
      parentUserMessageId: 60,
      userText: "打印机搞定了。",
      primaryText: "那就好。",
      primaryBubbles: ["那就好。"],
      gateInputs: {
        openLoopCandidate: { salience: 0.75, topic: "之前卡在师傅报价", memory_id: "m-p", confidence: 0.85 }
      },
      registry: new PostMessageRegistry(),
      generateFollowup: async () => "对了，你之前是不是卡在师傅报价那步？",
      deliverFollowup: async ({ text }) => ({ messageId: 3, text })
    });
    assert.equal(result.delivered, true);
    assert.equal(result.decision.reason_code, "callback_afterthought");
  });

  await scenario("L. low-salience memory → NO_FOLLOWUP", async () => {
    const d = evaluatePostMessageGate({
      userText: "今天中午吃面。",
      primaryText: "听着不错。",
      primaryBubbles: ["听着不错。"],
      activeMemory: { salience: 0.2, topic: "门口绿植", memory_id: "m-low", confidence: 0.8 }
    });
    assert.equal(d.should_follow_up, false);
  });

  await scenario("M. proactive message does not default to afterthought", async () => {
    const d = evaluatePostMessageGate({
      userText: "",
      primaryText: "突然想到你 DGX 预算那事。",
      primaryBubbles: ["突然想到你 DGX 预算那事。"],
      isProactive: true
    });
    assert.equal(d.should_follow_up, false);
  });

  await scenario("N. legacy split vs true post-message origin", async () => {
    const legacy = createBubblePlan(["第一句", "第二句"], { generationRoute: "natural_chat", turnId: "t" });
    assert.equal(legacy[0].origin, "primary_generation");
    assert.equal(legacy[1].origin, "legacy_split");
    const follow = createBubblePlan(["后来想到的"], { generationRoute: "post_message_followup", turnId: "t:pm1", origin: "post_message_followup" });
    assert.equal(follow[0].origin, "post_message_followup");
    assert.equal(originForBubble({ generationRoute: "post_message_followup", index: 0, bubbleCount: 1 }), "post_message_followup");
    assert.equal(originForBubble({ generationRoute: "natural_chat", index: 1, bubbleCount: 2 }), "legacy_split");
  });

  await scenario("O. closure primary suppresses follow-up even with candidate", async () => {
    const d = evaluatePostMessageGate({
      userText: "先这样。",
      primaryText: "好，那先这样。",
      primaryBubbles: ["好，那先这样。"],
      closureLikely: true,
      associationCandidate: { salience: 0.9, topic: "还有很多", memory_id: "m", confidence: 0.9 }
    });
    assert.equal(d.should_follow_up, false);
  });

  console.log("\n=== POST-MESSAGE DIRECTED TESTS ===");
  console.log(JSON.stringify({ pass: true, count: passed.length, passed }, null, 2));
  assert.ok(passed.length >= 12 && passed.length <= 15);
} catch (error) {
  console.error("FAIL", error);
  process.exit(1);
}
