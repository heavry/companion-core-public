process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_PRIMARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_BASE_URL="";
process.env.UPSTREAM_SECONDARY_CHAT_BASE_URL="";process.env.UPSTREAM_SECONDARY_AGENT_BASE_URL="";process.env.UPSTREAM_SECONDARY_SUMMARY_BASE_URL="";
process.env.UPSTREAM_API_KEY="";process.env.UPSTREAM_PRIMARY_API_KEY="";process.env.UPSTREAM_SECONDARY_API_KEY="";
process.env.UPSTREAM_CHAT_API_KEY="";process.env.UPSTREAM_AGENT_API_KEY="";process.env.UPSTREAM_SUMMARY_API_KEY="";
process.env.TAVILY_BASE_URL="";process.env.TAVILY_API_KEY="";process.env.SEARXNG_BASE_URL="";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"companion-permissions-")),file=path.join(dir,"permissions.json"),events=[];
process.env.COMPANION_SESSION_PERMISSIONS_PATH=path.join(dir,"singleton.json");
const { createAgentLifecycle }=await import("../src/agent-lifecycle.js");
const { runNativeAgent }=await import("../src/native-agent-runtime.js");
const { SessionPermissionStore,fullAutonomyAllowed,permissionScopeFor,sessionGrantAllowed }=await import("../src/session-permissions.js");
const { GuidanceQueueStore }=await import("../src/guidance-queue.js");
const { ActiveTurnRegistry }=await import("../src/active-turns.js");

let now=Date.UTC(2026,7,28,4,0,0);
const store=new SessionPermissionStore({filePath:file,ttlMs:60000,pendingTtlMs:30000,clock:()=>now,onEvent:(type,data,meta)=>events.push({type,data,meta})});
const readCap={name:"mcp_notion_search",id:"mcp:notion:search",displayName:"Search pages",integrationName:"Notion",sourceType:"mcp",sourceId:"notion",permissions:["read","network"],riskLevel:"low",sideEffect:"none",enabled:true,availability:"available"};
const writeCap={...readCap,name:"mcp_notion_update",id:"mcp:notion:update",displayName:"Update page",permissions:["write","network"],riskLevel:"high",sideEffect:"non_idempotent"};
assert.equal(permissionScopeFor(readCap),"read");assert.equal(sessionGrantAllowed(readCap),true);assert.equal(sessionGrantAllowed(writeCap),false);
assert.equal(store.snapshot("a").mode,"risk_based");assert.equal(store.policyDecision("a",readCap).kind,"allow");
const workspace=path.join(dir,"workspace");fs.mkdirSync(workspace);store.setWorkspace("a",workspace);assert.equal(store.workspaceRoot("a"),fs.realpathSync(workspace));assert.equal(store.snapshot("a").workspace.name,"workspace");
assert(events.some(event=>event.type==="workspace.changed"&&event.meta.sessionId==="a"&&event.data.workspace.path===fs.realpathSync(workspace)),"workspace selection emits workspace.changed for the existing session");
assert.equal(store.setMode("a","full_autonomy").workspace.path,fs.realpathSync(workspace),"full autonomy does not replace or expand workspace scope");store.setMode("a","risk_based");
store.setMode("autonomous","full_autonomy");assert.equal(store.policyDecision("autonomous",writeCap).kind,"ask","dangerous actions require approval even in full autonomy");const hardBoundary={...writeCap,hardSafetyBoundary:true};assert.equal(fullAutonomyAllowed(hardBoundary),false);assert.equal(store.policyDecision("autonomous",hardBoundary).kind,"ask","full autonomy retains hard safety boundaries");
store.setMode("a","ask");assert.equal(store.policyDecision("a",readCap).kind,"ask");
const oncePromise=store.request({sessionId:"a",callId:"call-once",capability:readCap});
const oncePending=store.snapshot("a").pending[0];store.resolve("a",oncePending.request_id,"allow_once");assert.equal((await oncePromise).action,"allow_once");assert.equal(store.snapshot("a").grants.length,0,"allow once is consumed without a grant");
const sessionPromise=store.request({sessionId:"a",callId:"call-session",capability:readCap});
const sessionPending=store.snapshot("a").pending[0];store.resolve("a",sessionPending.request_id,"allow_session");await sessionPromise;
assert.equal(store.snapshot("a").mode,"session_grant");assert.equal(store.policyDecision("a",readCap).source,"session_grant");assert.equal(store.snapshot("b").grants.length,0,"grants are session isolated");
assert.throws(()=>store.resolve("a","missing","allow_once"),e=>e.code==="PERMISSION_REQUEST_NOT_FOUND");
const restartedEvents=[],restarted=new SessionPermissionStore({filePath:file,ttlMs:60000,pendingTtlMs:30000,clock:()=>now,onEvent:(type,data,meta)=>restartedEvents.push({type,data,meta})});assert.equal(restarted.matchingGrant("a",readCap)?.scope,"read","grant survives restart");assert.equal(restarted.workspaceRoot("a"),fs.realpathSync(workspace),"workspace binding survives restart");restarted.clearWorkspace("a");assert.equal(restarted.snapshot("a").workspace,null,"workspace can be cleared independently of permission mode");assert(restartedEvents.some(event=>event.type==="workspace.changed"&&event.data.workspace===null),"workspace clear emits workspace.changed");
const grantId=restarted.snapshot("a").grants[0].id;assert.equal(restarted.revoke("a",grantId),true);assert.equal(restarted.snapshot("a").grants.length,0);
const interruptedPromise=restarted.request({sessionId:"a",callId:"restart-pending",capability:readCap});
const afterCoreRestart=new SessionPermissionStore({filePath:file,ttlMs:60000,pendingTtlMs:30000,clock:()=>now});
assert.equal(afterCoreRestart.snapshot("a").pending.length,0,"a restarted Core never claims it can resume an in-memory turn");
assert.equal(afterCoreRestart.interruptedFor("a","restart-pending")?.failure_code,"approval_interrupted","orphaned approval is explainable instead of running forever");
restarted.cancel(restarted.snapshot("a").pending[0].request_id);await interruptedPromise;
const expiring=restarted.request({sessionId:"a",callId:"expire",capability:readCap});const pending=restarted.snapshot("a").pending[0];restarted.resolve("a",pending.request_id,"allow_session");await expiring;now+=60001;assert.equal(restarted.snapshot("a").grants.length,0,"expired grants are removed");

const runtimeStore=new SessionPermissionStore({filePath:path.join(dir,"runtime.json"),ttlMs:60000,pendingTtlMs:30000,clock:()=>now});runtimeStore.setMode("runtime","ask");
const runtimeGuidance=new GuidanceQueueStore({file:path.join(dir,"runtime-guidance.json"),emit:()=>{}}),runtimeTurns=new ActiveTurnRegistry({id:()=>"runtime-turn"});
const runtimeTurn=runtimeTurns.start("runtime",{status:"streaming",native:true}),runtimeLifecycle=createAgentLifecycle();
runtimeLifecycle.on("PermissionRequest",()=>runtimeTurns.update("runtime",runtimeTurn.turnId,"awaiting_approval"));
runtimeLifecycle.on("PermissionResolved",()=>runtimeTurns.update("runtime",runtimeTurn.turnId,"continuing"));
const responses=[
  {choices:[{message:{role:"assistant",content:"",tool_calls:[{id:"tool-1",type:"function",function:{name:readCap.name,arguments:'{"query":"safe"}'}}]}}]},
  {choices:[{message:{role:"assistant",content:"done"}}]}
];
let assistantRows=0,executions=0,providerCalls=0,continuationMessages=[];
const run=runNativeAgent({messages:[{role:"user",content:"search"}],tools:[],capabilities:[readCap],lifecycle:runtimeLifecycle,permissionStore:runtimeStore,sessionId:"runtime",takeQueuedGuidance:()=>runtimeGuidance.consume("runtime"),callModel:async({messages})=>{providerCalls++;continuationMessages=structuredClone(messages);return responses.shift();},executeTool:async()=>{executions++;return {content:"result"};},onAssistant:async()=>{assistantRows++;}});
await new Promise(resolve=>setImmediate(resolve));const approval=runtimeStore.snapshot("runtime").pending[0];assert.ok(approval,"turn pauses at the tool boundary");assert.equal(runtimeTurns.current("runtime").status,"awaiting_approval");assert.equal(executions,0);
if(runtimeTurns.isActive("runtime"))runtimeGuidance.enqueue("runtime","guidance while awaiting approval");
assert.equal(runtimeGuidance.pendingCount("runtime"),1,"awaiting approval accepts queued guidance");
runtimeStore.resolve("runtime",approval.request_id,"allow_once");const result=await run;runtimeTurns.complete("runtime",runtimeTurn.turnId,"completed");
assert.equal(result.message.content,"done");assert.equal(executions,1);assert.equal(providerCalls,2);assert.equal(assistantRows,2,"assistant tool-call and final messages are each durable once");
assert.equal(runtimeGuidance.pendingCount("runtime"),0,"approval resume consumes guidance at the next safe boundary");
assert.ok(continuationMessages.some(message=>message.role==="user"&&message.content==="guidance while awaiting approval"),"queued approval guidance reaches the original turn continuation");
assert.equal(runtimeTurns.isActive("runtime"),false,"approval continuation completion clears busy state");

const denyStore=new SessionPermissionStore({filePath:path.join(dir,"deny.json"),clock:()=>now});denyStore.setMode("deny","ask");let requests=0;denyStore.onEvent=type=>{if(type==="permission.requested")requests++;};let denyStep=0,executed=0;
const deniedRun=runNativeAgent({messages:[],tools:[],capabilities:[readCap],lifecycle:createAgentLifecycle(),permissionStore:denyStore,sessionId:"deny",callModel:async()=>denyStep++<2?{choices:[{message:{role:"assistant",content:"",tool_calls:[{id:`d${denyStep}`,type:"function",function:{name:readCap.name,arguments:'{"query":"same"}'}}]}}]}:{choices:[{message:{role:"assistant",content:"stopped"}}]},executeTool:async()=>{executed++;return {content:"unexpected"};}});
await new Promise(resolve=>setImmediate(resolve));const denyPending=denyStore.snapshot("deny").pending[0];denyStore.resolve("deny",denyPending.request_id,"deny");const denied=await deniedRun;assert.equal(denied.message.content,"stopped");assert.equal(requests,1,"same denied action does not spam approvals in one turn");assert.equal(executed,0);
assert.ok(events.some(e=>e.type==="permission.requested")&&events.some(e=>e.type==="permission.resolved"));

const cancelStore=new SessionPermissionStore({filePath:path.join(dir,"cancel.json"),clock:()=>now});cancelStore.setMode("cancel","ask");const controller=new AbortController();let cancelledExecution=0;
const cancelledRun=runNativeAgent({messages:[],tools:[],capabilities:[readCap],lifecycle:createAgentLifecycle(),permissionStore:cancelStore,sessionId:"cancel",signal:controller.signal,callModel:async()=>({choices:[{message:{role:"assistant",content:"",tool_calls:[{id:"cancel-call",type:"function",function:{name:readCap.name,arguments:"{}"}}]}}]}),executeTool:async()=>{cancelledExecution++;return {content:"unexpected"};}});
await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelStore.snapshot("cancel").pending.length,1);controller.abort();await assert.rejects(cancelledRun,error=>error.name==="AbortError");assert.equal(cancelStore.snapshot("cancel").pending.length,0);assert.equal(cancelledExecution,0,"cancelling while awaiting approval never executes the tool");
fs.rmSync(dir,{recursive:true,force:true});
console.log("session-permissions-test: ok");
