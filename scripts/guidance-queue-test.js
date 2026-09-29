import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuidanceQueueStore } from "../src/guidance-queue.js";
import { createAgentLifecycle } from "../src/agent-lifecycle.js";
import { runNativeAgent } from "../src/native-agent-runtime.js";
import { ActiveTurnRegistry } from "../src/active-turns.js";

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"companion-guidance-")),file=path.join(dir,"queue.json"),events=[];
let clock=0;const now=()=>new Date(Date.UTC(2026,7,27,0,0,clock++));
const store=new GuidanceQueueStore({file,now,emit:(type,data,meta)=>events.push({type,data,meta})});
const a=store.enqueue("session-a","first"),b=store.enqueue("session-a","second"),other=store.enqueue("session-b","private");
assert.notEqual(a.id,b.id);assert.deepEqual(store.snapshot("session-a").data.map(x=>x.content),["first","second"]);
assert.equal(store.cancel("session-a",b.id).ok,true);assert.equal(store.cancel("session-a",b.id).ok,false);
assert.equal(store.cancel("session-b",a.id),null,"queue ids are session isolated");

const restarted=new GuidanceQueueStore({file,now,emit:(type,data,meta)=>events.push({type,data,meta})});
assert.deepEqual(restarted.snapshot("session-b").data.map(x=>x.content),["private"],"queued guidance survives restart");
const consumed=restarted.consume("session-a");assert.deepEqual(consumed.map(x=>x.content),["first"]);assert.equal(restarted.pendingCount("session-a"),0);
assert.deepEqual(restarted.consume("session-b").map(x=>x.id),[other.id]);

const runtimeStore=new GuidanceQueueStore({file:path.join(dir,"runtime.json"),now,emit:()=>{}});
runtimeStore.enqueue("runtime","before first boundary");let providerCalls=0,toolCalls=0,prompts=[];
const responses=[
  {choices:[{message:{role:"assistant",content:"",tool_calls:[{id:"t1",type:"function",function:{name:"read_note",arguments:"{}"}}]}}]},
  {choices:[{message:{role:"assistant",content:"done"}}]}
];
await runNativeAgent({messages:[{role:"user",content:"start"}],tools:[],capabilities:[{name:"read_note",capabilityId:"core:read_note",riskLevel:"low",sideEffect:"none",availability:"available",enabled:true}],lifecycle:createAgentLifecycle(),sessionId:"runtime",takeQueuedGuidance:()=>runtimeStore.consume("runtime"),callModel:async({messages})=>{providerCalls++;prompts.push(structuredClone(messages));return responses.shift();},executeTool:async()=>{toolCalls++;runtimeStore.enqueue("runtime","after tool");return {content:"note"};}});
assert.equal(providerCalls,2,"guidance endpoint itself never starts a provider turn");assert.equal(toolCalls,1);
assert.equal(prompts[0].at(-1).content,"before first boundary");assert.equal(prompts[1].at(-1).content,"after tool","consumed guidance follows tool result at the next boundary");

const turnClock=()=>new Date(Date.UTC(2026,7,27,1,0,clock++));
const activeTurns=new ActiveTurnRegistry({now:turnClock,id:()=>`turn-${clock}`});
const active=activeTurns.start("runtime",{status:"starting",native:true});
for(const status of ["streaming","tool_running","awaiting_approval","continuing"]){
  assert.equal(activeTurns.update("runtime",active.turnId,status).status,status,`${status} remains guidance-busy`);
  assert.equal(activeTurns.isActive("runtime"),true);
}
assert.equal(activeTurns.complete("runtime",active.turnId,"completed").status,"completed");
assert.equal(activeTurns.isActive("runtime"),false,"completed turn is never guidance-busy");
for(const terminal of ["failed","cancelled","stopped","timed_out"]){
  const item=activeTurns.start(`runtime-${terminal}`,{status:"streaming"});
  activeTurns.complete(`runtime-${terminal}`,item.turnId,terminal);
  assert.equal(activeTurns.isActive(`runtime-${terminal}`),false,`${terminal} turn is never guidance-busy`);
}
assert.equal(activeTurns.count(),0,"terminal paths clear the registry without timers");
assert.ok(events.some(x=>x.type==="guidance.queued")&&events.some(x=>x.type==="guidance.cancelled")&&events.some(x=>x.type==="guidance.consumed"));
assert.equal(JSON.stringify(runtimeStore.snapshot("runtime")).includes("memory"),false,"queue state does not contain Shared Memory material");
fs.rmSync(dir,{recursive:true,force:true});
console.log("guidance-queue-test: ok");
