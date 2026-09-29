import { compatMessages } from "../src/tool-compat.js";
import { responsesInputToMessages, normalizeChatCompatibilityMessages } from "../src/responses.js";

// 测试1: 空content的assistant消息
const test1 = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_1", content: "Tool result" }
];

console.log("测试1: 空content的assistant消息");
const result1 = compatMessages(test1, "test contract");
console.log("结果:", JSON.stringify(result1, null, 2));

// 测试2: 空content的tool消息
const test2 = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "assistant", content: "Test", tool_calls: [{ id: "call_2", type: "function", function: { name: "test", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_2", content: "" }
];

console.log("\n测试2: 空content的tool消息");
const result2 = compatMessages(test2, "test contract");
console.log("结果:", JSON.stringify(result2, null, 2));

// 测试3: 通过responsesInputToMessages生成的消息
const input = [
  { role: "user", content: [{ type: "input_text", text: "Hello" }] },
  { type: "function_call", call_id: "call_3", name: "test", arguments: "{}" },
  { type: "function_call_output", call_id: "call_3", output: "" },
  { role: "assistant", content: [{ type: "input_text", text: "Response" }] }
];

console.log("\n测试3: 通过responsesInputToMessages生成的消息");
const messages = responsesInputToMessages(input);
console.log("原始消息:", JSON.stringify(messages, null, 2));

const normalized = normalizeChatCompatibilityMessages(messages);
console.log("规范化后:", JSON.stringify(normalized, null, 2));

const result3 = compatMessages(normalized, "test contract");
console.log("compat结果:", JSON.stringify(result3, null, 2));

// 检查是否有空content
console.log("\n检查空content:");
result3.forEach((msg, i) => {
  if (msg.content === "" || msg.content === null || msg.content === undefined) {
    console.log(`❌ 消息${i}有空content:`, msg);
  } else if (typeof msg.content === "string" && msg.content.trim() === "") {
    console.log(`❌ 消息${i}有空白content:`, msg);
  } else {
    console.log(`✅ 消息${i}正常:`, msg.role, typeof msg.content === "string" ? msg.content.substring(0, 50) + "..." : msg.content);
  }
});