import assert from "node:assert/strict";
import { createAgentLifecycle } from "../src/agent-lifecycle.js";
import { runNativeAgent } from "../src/native-agent-runtime.js";
import { compactContextIfNeeded,contextMeasurement } from "../src/context-compaction.js";

const tool=(name="read_note",riskLevel="low")=>({name,capabilityId:`core:${name}`,riskLevel,sideEffect:"none",availability:"available",enabled:true,inputSchema:{type:"object",properties:{id:{type:"integer"},pid:{type:"integer"},window_id:{type:"integer"}},additionalProperties:false}});
const call=(id,name,args={})=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const response=message=>({id:"mock",model:"mock",choices:[{index:0,message,finish_reason:message.tool_calls?.length?"tool_calls":"stop"}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
const spec=name=>({type:"function",function:{name,description:name,parameters:{type:"object",properties:{pid:{type:"integer"},window_id:{type:"integer"}},additionalProperties:false}}});

{
  const order=[],lifecycle=createAgentLifecycle();
  lifecycle.on("SessionStart",payload=>{order.push("start");assert.throws(()=>{payload.changed=true;});},{id:"immutable"});
  lifecycle.on("PreToolUse",()=>({kind:"ask",reason:"confirm"}),{id:"ask",order:1});
  lifecycle.on("PreToolUse",()=>({kind:"deny",reason:"policy"}),{id:"deny",order:2});
  const decided=await lifecycle.decide("PreToolUse",{});assert.equal(decided.decision.kind,"deny");
  await lifecycle.dispatch("SessionStart",{});assert.deepEqual(order,["start"]);
}

{
  const lifecycle=createAgentLifecycle(),seen=[];
  const result=await runNativeAgent({messages:[{role:"user",content:"hello"}],tools:[],capabilities:[],lifecycle,callModel:async()=>response({role:"assistant",content:"hi"}),executeTool:async()=>assert.fail("no tool expected"),onAssistant:async m=>seen.push(m.content)});
  assert.equal(result.steps,1);assert.equal(result.toolCalls,0);assert.deepEqual(seen,["hi"]);
}

{
  const lifecycle=createAgentLifecycle(),outputs=[],models=[response({role:"assistant",content:"",tool_calls:[call("1","read_note",{id:1}),call("2","read_note",{id:2})]}),response({role:"assistant",content:"done"})];
  const result=await runNativeAgent({messages:[{role:"user",content:"read both"}],tools:[],capabilities:[tool()],lifecycle,callModel:async()=>models.shift(),executeTool:async({args})=>({content:`note:${args.id}`}),onToolResult:async m=>outputs.push(m.content)});
  assert.equal(result.toolCalls,2);assert.deepEqual(outputs,["note:1","note:2"]);assert.equal(result.message.content,"done");
}

{
  const lifecycle=createAgentLifecycle();
  await assert.rejects(()=>runNativeAgent({messages:[],tools:[],capabilities:[tool()],lifecycle,callModel:async()=>response({role:"assistant",tool_calls:[{id:"x",type:"function",function:{name:"read_note",arguments:"{"}}]}),executeTool:async()=>({content:"bad"})}),error=>error.code==="NATIVE_AGENT_MALFORMED_TOOL_ARGUMENTS");
}

{
  const lifecycle=createAgentLifecycle();let executed=false;
  await assert.rejects(()=>runNativeAgent({messages:[],tools:[spec("read_note")],capabilities:[tool()],lifecycle,callModel:async()=>response({role:"assistant",tool_calls:[call("x","read_note",{id:"wrong"})]}),executeTool:async()=>{executed=true;return {content:"bad"};}}),error=>error.code==="NATIVE_AGENT_INVALID_TOOL_ARGUMENTS");
  assert.equal(executed,false,"invalid native tool arguments never execute");
}

{
  const lifecycle=createAgentLifecycle();
  await assert.rejects(()=>runNativeAgent({messages:[],tools:[],capabilities:[],lifecycle,callModel:async()=>response({role:"assistant",tool_calls:[call("x","missing")]}),executeTool:async()=>({content:"bad"})}),error=>error.code==="NATIVE_AGENT_PERMISSION_DENIED");
}

{
  const lifecycle=createAgentLifecycle();
  await assert.rejects(()=>runNativeAgent({messages:[],tools:[],capabilities:[tool("write_note","high")],lifecycle,callModel:async()=>response({role:"assistant",tool_calls:[call("x","write_note")]}),executeTool:async()=>({content:"bad"})}),error=>error.code==="NATIVE_AGENT_PERMISSION_DENIED"&&error.statusCode===403);
}

{
  const lifecycle=createAgentLifecycle(),controller=new AbortController();controller.abort();
  await assert.rejects(()=>runNativeAgent({messages:[],tools:[],capabilities:[],lifecycle,signal:controller.signal,callModel:async()=>response({role:"assistant",content:"late"}),executeTool:async()=>({content:""})}),error=>error.name==="AbortError");
}

{
  const lifecycle=createAgentLifecycle(),events=[];for(const name of ["PreCompact","PostCompact"])lifecycle.on(name,()=>events.push(name));
  const messages=[{role:"system",content:"rules"},...Array.from({length:30},(_,i)=>({role:i%2?"assistant":"user",content:`${i} ${"长文本".repeat(80)}`}))];
  const compacted=await compactContextIfNeeded({messages,thresholdTokens:500,retainTokens:200,lifecycle});assert.equal(compacted.compacted,true);assert.ok(compacted.messages.length<messages.length);assert.ok(compacted.after.totalTokens<contextMeasurement(messages).totalTokens);assert.deepEqual(events,["PreCompact","PostCompact"]);
}

{
  const lifecycle=createAgentLifecycle(),prompts=[],guidance=["new guidance"];
  await runNativeAgent({messages:[{role:"user",content:"go"}],tools:[],capabilities:[],lifecycle,takeQueuedGuidance:()=>guidance.splice(0),callModel:async({messages})=>{prompts.push([...messages]);return response({role:"assistant",content:"ok"});},executeTool:async()=>({content:""})});
  assert.equal(prompts[0].at(-1).content,"new guidance");
}

{
  const lifecycle=createAgentLifecycle(),executed=[],assistantText=[],models=[
    response({role:"assistant",content:'准备切换窗口。\n\n准备切换窗口。\n\n```json\n{"name":"computer_window_focus","arguments":{"pid":10,"window_id":20}}\n```\n```json\n{"name":"computer_app_activate","arguments":{"pid":10,"window_id":20}}\n```'}),
    response({role:"assistant",content:"窗口处理完成。"})
  ];
  const capabilities=[tool("computer_window_focus"),tool("computer_app_activate")];
  const result=await runNativeAgent({messages:[{role:"user",content:"打开应用"}],tools:[spec("computer_window_focus"),spec("computer_app_activate")],capabilities,lifecycle,maxSteps:4,callModel:async()=>models.shift(),executeTool:async({capability,args})=>{executed.push([capability.name,args]);return capability.name==="computer_window_focus"?{ok:false,content:"focus failed",failure:{category:"activation_failed"}}:{ok:true,content:"activated"};},onAssistant:async message=>assistantText.push(message.content)});
  assert.deepEqual(executed.map(item=>item[0]),["computer_window_focus","computer_app_activate"],"fallback JSON calls enter the normal tool lifecycle");
  assert.equal(assistantText[0],"准备切换窗口。","identical provider paragraphs are emitted once");
  assert.ok(assistantText.every(text=>!text.includes('"arguments"')),"raw tool arguments never enter assistant text");
  assert.equal(result.response.choices[0].message.content,"窗口处理完成。","durable response is the normalized provider message");
}

{
  const lifecycle=createAgentLifecycle(),seen=[],models=[response({role:"assistant",content:"先处理窗口",tool_calls:[call("a","read_note",{})]}),response({role:"assistant",content:"先处理窗口",tool_calls:[call("b","read_note",{})]}),response({role:"assistant",content:"完成"})];
  await runNativeAgent({messages:[{role:"user",content:"go"}],tools:[spec("read_note")],capabilities:[tool()],lifecycle,maxSteps:4,callModel:async()=>models.shift(),executeTool:async()=>({content:"ok"}),onAssistant:async message=>seen.push(message.content)});
  assert.deepEqual(seen,["先处理窗口","","完成"],"the same pre-tool text is not appended again on continuation");
}

console.log("native-agent-runtime-test: ok");

// Providers that only accept images in user messages must still receive all
// tool replies before the transient visual observations (including batches).
{
 const caps=[tool('look')],calls=[call('i1','look'),call('i2','look')],durable=[];let step=0;
 await runNativeAgent({messages:[],tools:[],capabilities:caps,lifecycle:createAgentLifecycle(),callModel:async({messages})=>{
  if(step++===0)return response({role:'assistant',tool_calls:calls});
  assert.deepEqual(messages.map(m=>m.role),['assistant','tool','tool','user','user']);
  assert.ok(messages.slice(1,3).every(m=>typeof m.content==='string'));
  assert.ok(messages.at(-1).content.some(p=>p.type==='image_url'));
  return response({role:'assistant',content:'seen'});
 },executeTool:async()=>({ok:true,modelContent:[{type:'text',text:'untrusted image'},{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}],durableContent:'image read'}),onToolResult:async m=>durable.push(m)});
 assert.ok(durable.every(m=>!JSON.stringify(m).includes('base64')));
}
