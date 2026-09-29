import assert from "node:assert/strict";
import http from "node:http";
import { responsesInputToMessages, normalizeChatCompatibilityMessages } from "../src/responses.js";

const input=[
  {role:"user",content:[{type:"input_text",text:"用户请求"},{type:"input_text",text:"   "},{type:"text",text:""}]},
  {type:"function_call",call_id:"call_1",name:"echo_test",arguments:'{"value":"ok"}'},
  {type:"function_call_output",call_id:"call_1",output:"工具结果"},
  {role:"assistant",content:[{type:"text",text:"最终回答"}]}
];
const normalized=normalizeChatCompatibilityMessages(responsesInputToMessages(input));

assert.deepEqual(normalized[0].content,[{type:"text",text:"用户请求"}],"input_text converts to Chat text and empty blocks are removed");
assert.equal(normalized[1].tool_calls[0].id,"call_1","function_call id is preserved");
assert.equal(normalized[2].tool_call_id,"call_1","function_call_output tool_call_id is preserved");
assert.equal(normalized[2].content,"工具结果","function_call_output content is preserved");
assert.deepEqual(normalized[3].content,[{type:"text",text:"最终回答"}],"final assistant text remains Chat-compatible");

const emptyNormalized=normalizeChatCompatibilityMessages([
  {role:"user",content:[]},
  {role:"assistant",content:[{type:"input_text",text:"  "}],tool_calls:[{id:"call_2",type:"function",function:{name:"echo_test",arguments:"{}"}}]},
  {role:"tool",tool_call_id:"call_2",content:"result"}
]);
assert.equal(Object.hasOwn(emptyNormalized[0],"content"),false,"empty content array is removed");
assert.equal(Object.hasOwn(emptyNormalized[1],"content"),false,"empty text block is removed without dropping tool_calls");
assert.equal(emptyNormalized[1].tool_calls[0].id,"call_2","tool_calls survive empty content cleanup");
assert.equal(emptyNormalized[2].tool_call_id,"call_2","tool result remains linked");

const loop=normalizeChatCompatibilityMessages(responsesInputToMessages([
  {role:"user",content:[{type:"input_text",text:"loop"}]},
  {type:"function_call",call_id:"call_loop",name:"echo_test",arguments:"{}"},
  {type:"function_call_output",call_id:"call_loop",output:"ok"},
  {role:"assistant",content:[{type:"input_text",text:"done"}]}
]));
assert.equal(loop[0].content[0].type,"text","tool loop user message uses Chat text blocks");
assert.equal(loop[1].tool_calls[0].id,"call_loop","tool loop function_call is retained");
assert.equal(loop[2].tool_call_id,"call_loop","tool loop result is retained");
assert.equal(loop[3].content[0].text,"done","tool loop final answer is retained");

let captured;
const server=http.createServer(async(req,res)=>{
  let raw="";for await(const chunk of req)raw+=chunk;
  captured=JSON.parse(raw);
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({choices:[{message:{role:"assistant",content:'{"type":"final_answer","content":"done"}'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=server.address().port;
process.env.UPSTREAM_PRIMARY_BASE_URL=`http://127.0.0.1:${port}/v1`;
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
process.env.UPSTREAM_PRIMARY_MODEL="compat-test-model";
process.env.UPSTREAM_PRIMARY_API_KEY="";
process.env.UPSTREAM_BASE_URL=`http://127.0.0.1:${port}/v1`;
process.env.UPSTREAM_CHAT_MODEL="compat-test-model";
process.env.UPSTREAM_AGENT_MODEL="compat-test-model";
process.env.UPSTREAM_AGENT_BASE_URL=`http://127.0.0.1:${port}/v1`;
process.env.UPSTREAM_SUMMARY_BASE_URL=`http://127.0.0.1:${port}/v1`;
process.env.UPSTREAM_SUMMARY_API_KEY="";
process.env.UPSTREAM_PRIMARY_BASE_URL="";
process.env.UPSTREAM_SECONDARY_BASE_URL="";
process.env.UPSTREAM_SECONDARY_API_KEY="";
process.env.UPSTREAM_SECONDARY_MODEL="";
process.env.UPSTREAM_PRIMARY_API_KEY="";
process.env.UPSTREAM_AGENT_API_KEY="";
const { upstreamCompat }=await import("../src/upstream.js");
const response=await upstreamCompat({max_tokens:32},responsesInputToMessages(input),null);
await new Promise(resolve=>server.close(resolve));
assert.equal(response.status,200,"upstreamCompat accepts the normalized local mock request");
assert.deepEqual(captured.messages[0].content,[{type:"text",text:"用户请求"}],"upstreamCompat sends Chat text blocks");
assert.equal(Object.hasOwn(captured.messages[1],"content"),false,"upstreamCompat removes empty assistant content while retaining function_call");
assert.equal(captured.messages[1].tool_calls[0].id,"call_1","upstreamCompat preserves function_call");
assert.equal(captured.messages[2].tool_call_id,"call_1","upstreamCompat preserves function_call_output");
assert.deepEqual(captured.messages[3].content,[{type:"text",text:"最终回答"}],"upstreamCompat preserves final answer content");

console.log("PASS Responses input_text to Chat text normalization, empty block removal, tool-call preservation, and complete loop shape");
