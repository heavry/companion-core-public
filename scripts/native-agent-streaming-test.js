import assert from "node:assert/strict";
import { consumeChatCompletionSse } from "../src/chat-stream.js";
import { createAgentLifecycle } from "../src/agent-lifecycle.js";
import { runNativeAgent } from "../src/native-agent-runtime.js";

function response(frames,{chunkAt=1}={}){
  const text=frames.map(value=>`data: ${typeof value==="string"?value:JSON.stringify(value)}\n\n`).join("");let offset=0;
  return new Response(new ReadableStream({pull(controller){if(offset>=text.length)return controller.close();const end=Math.min(text.length,offset+chunkAt);controller.enqueue(new TextEncoder().encode(text.slice(offset,end)));offset=end;}}),{status:200,headers:{"content-type":"text/event-stream"}});
}
const chunk=(delta,finish_reason=null,usage)=>({id:"c1",object:"chat.completion.chunk",created:1,model:"upstream",choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})});

{
  const seen=[];
  const result=await consumeChatCompletionSse(response([chunk({role:"assistant"}),chunk({content:"你"}),chunk({content:"好"}),chunk({},"stop",{prompt_tokens:2,completion_tokens:2}),"[DONE]"],{chunkAt:3}),{onChunk:value=>seen.push(value.choices?.[0]?.delta?.content??"")});
  assert.equal(result.choices[0].message.content,"你好");assert.deepEqual(seen.filter(Boolean),["你","好"]);assert.equal(result.usage.prompt_tokens,2);
}

{
  const result=await consumeChatCompletionSse(response([
    chunk({tool_calls:[{index:0,id:"call-1",type:"function",function:{name:"read_",arguments:"{\"id\":"}}]}),
    chunk({tool_calls:[{index:0,function:{name:"note",arguments:"7}"}}]}),chunk({},"tool_calls"),"[DONE]"
  ],{chunkAt:2}));
  assert.deepEqual(result.choices[0].message.tool_calls,[{id:"call-1",type:"function",function:{name:"read_note",arguments:"{\"id\":7}"}}]);
}

{
  const order=[],models=[
    response([chunk({tool_calls:[{index:0,id:"t1",type:"function",function:{name:"read_note",arguments:"{}"}}]}),chunk({},"tool_calls"),"[DONE]"],{chunkAt:4}),
    response([chunk({content:"final "}),chunk({content:"answer"}),chunk({},"stop"),"[DONE]"],{chunkAt:5})
  ];
  const result=await runNativeAgent({messages:[{role:"user",content:"go"}],tools:[],capabilities:[{name:"read_note",capabilityId:"core:read_note",riskLevel:"low",sideEffect:"none",availability:"available",enabled:true}],lifecycle:createAgentLifecycle(),callModel:async()=>consumeChatCompletionSse(models.shift(),{onChunk:value=>{const delta=value.choices?.[0]?.delta;if(delta?.content)order.push(`text:${delta.content}`);if(delta?.tool_calls)order.push("tool-delta");}}),executeTool:async()=>{order.push("tool-result");return {content:"ok"};}});
  assert.equal(result.message.content,"final answer");assert.deepEqual(order,["tool-delta","tool-result","text:final ","text:answer"]);
}

{
  const controller=new AbortController();let emitted=false;
  const pending=new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({content:"partial"}))}\n\n`));},cancel(){emitted=true;}}));
  const task=consumeChatCompletionSse(pending,{signal:controller.signal,onChunk:()=>controller.abort()});
  await assert.rejects(task,error=>error.name==="AbortError");assert.equal(emitted,true);
}

await assert.rejects(()=>consumeChatCompletionSse(response([{error:{message:"provider failed"}}])),/provider failed/);
await assert.rejects(()=>consumeChatCompletionSse(response([chunk({content:"unterminated"})])),/before terminal/);

{
  const lifecycle=createAgentLifecycle(),events=[];
  lifecycle.on("PostToolUseFailure",payload=>events.push(payload.message));
  const toolResponse=response([chunk({tool_calls:[{index:0,id:"slow",type:"function",function:{name:"read_note",arguments:"{}"}}]}),chunk({},"tool_calls"),"[DONE]"]);
  let calls=0;
  const recovered=await runNativeAgent({messages:[],tools:[],capabilities:[{name:"read_note",capabilityId:"core:read_note",riskLevel:"low",sideEffect:"none",availability:"available",enabled:true}],lifecycle,callModel:async({messages})=>{if(calls++===0)return consumeChatCompletionSse(toolResponse);assert.match(messages.at(-1).content,/tool timed out/);return {choices:[{message:{role:"assistant",content:"读取超时，未确认完成。"}}]};},executeTool:async()=>{throw Object.assign(new Error("tool timed out"),{name:"TimeoutError"});}});
  assert.equal(recovered.steps,2);
  assert.deepEqual(events,["tool timed out"],"tool timeout is observed by the next model turn without replaying the action");
}
console.log("native-agent-streaming-test: ok");
