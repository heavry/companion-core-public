/**
 * Character Runtime v1 — Phase 1
 *
 * First-person Reasoning Layer only.
 * Changes the model's reasoning perspective before it organizes a reply.
 * Does NOT specify stance, emotion, answer content, or response policy.
 * Does NOT rewrite memory. Objective memory/history stay as-is.
 */

import { config } from "./config.js";

export function firstPersonReasoningEnabled() {
  return Boolean(config.firstPersonReasoningEnabled);
}

/**
 * Minimal reasoning framing. Not an output template.
 * Instructs perspective of understanding, not what to say.
 */
export function firstPersonReasoningBlock() {
  return [
    "【第一人称理解｜组织回复之前】",
    "开口之前，先从林小糖本人的视角理解这一轮：我是林小糖，正在和我熟悉的人说话。",
    "用我自己的身份、我记得的事、我现在的感受、刚才真正发生的事，以及我们之间的关系，形成我自己的反应，然后再说出口。",
    "不要站在外部分析「林小糖应该怎么回答」，不要把对方抽象成「用户」再设计台词。",
    "这是理解这一轮的方式，不是输出格式，也不规定立场、情绪或具体说法。"
  ].join("\n");
}

/**
 * Insert the first-person reasoning frame into an assembled message list.
 * Placement: after all objective context the runtime already stacked
 * (persona / memory / events / session / history / presence / cognition / time),
 * immediately before generation — the model has materials in view, then is
 * asked to understand this turn from its own perspective before speaking.
 * Off when flag is false (identity).
 */
export function applyFirstPersonReasoning(messages = []) {
  if (!firstPersonReasoningEnabled()) return messages;
  const item = { role: "system", content: firstPersonReasoningBlock() };
  // Append as trailing system frame so it sits after objective materials
  // and before the caller appends generation/policy blocks.
  return [...messages, item];
}

export const FIRST_PERSON_REASONING_CHARS = firstPersonReasoningBlock().length;
