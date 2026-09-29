import { normalizeChatCompatibilityMessages } from "../src/responses.js";

// 测试各种可能的空content情况
const testCases = [
  // 1. 空字符串content
  { role: "assistant", content: "" },
  
  // 2. 空格字符串content
  { role: "assistant", content: "   " },
  
  // 3. 空数组content
  { role: "user", content: [] },
  
  // 4. 空text block
  { role: "user", content: [{ type: "text", text: "" }] },
  
  // 5. 空格text block
  { role: "user", content: [{ type: "text", text: "   " }] },
  
  // 6. input_text (已修复)
  { role: "user", content: [{ type: "input_text", text: "test" }] },
  
  // 7. 混合空和非空blocks
  { role: "user", content: [
    { type: "text", text: "" },
    { type: "text", text: "valid" },
    { type: "text", text: "   " }
  ]},
  
  // 8. function_call with empty content
  { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: "{}" } }] },
  
  // 9. tool result with empty content
  { role: "tool", tool_call_id: "call_1", content: "" },
  
  // 10. null content
  { role: "user", content: null },
  
  // 11. undefined content
  { role: "user", content: undefined },
  
  // 12. 数字content
  { role: "user", content: 123 },
  
  // 13. 对象content (非数组)
  { role: "user", content: { type: "text", text: "test" } },
  
  // 14. 空对象content
  { role: "user", content: {} },
  
  // 15. 只有空blocks的数组
  { role: "user", content: [
    { type: "text", text: "" },
    { type: "text", text: "   " }
  ]}
];

console.log("测试 normalizeChatCompatibilityMessages 函数：\n");

testCases.forEach((testCase, index) => {
  const result = normalizeChatCompatibilityMessages([testCase]);
  const normalized = result[0];
  
  console.log(`测试 ${index + 1}:`, JSON.stringify(testCase, null, 2));
  console.log(`结果:`, JSON.stringify(normalized, null, 2));
  
  // 检查是否还有空content
  if (normalized && normalized.content !== undefined) {
    if (typeof normalized.content === 'string' && normalized.content.trim() === '') {
      console.log("❌ 仍有空字符串content");
    } else if (Array.isArray(normalized.content) && normalized.content.length === 0) {
      console.log("❌ 仍有空数组content");
    } else if (Array.isArray(normalized.content)) {
      const hasEmptyBlocks = normalized.content.some(block => 
        block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() === ''
      );
      if (hasEmptyBlocks) {
        console.log("❌ 仍有空text block");
      } else {
        console.log("✅ 正确处理");
      }
    } else {
      console.log("✅ 正确处理");
    }
  } else {
    console.log("✅ 正确处理（content被删除或未定义）");
  }
  console.log("---");
});

// 测试完整的消息序列
console.log("\n测试完整消息序列：\n");

const fullSequence = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: [{ type: "input_text", text: "Hello" }] },
  { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_1", content: "Tool result" },
  { role: "assistant", content: [{ type: "input_text", text: "Response" }] }
];

const normalizedSequence = normalizeChatCompatibilityMessages(fullSequence);
console.log("原始序列:", JSON.stringify(fullSequence, null, 2));
console.log("规范化后:", JSON.stringify(normalizedSequence, null, 2));