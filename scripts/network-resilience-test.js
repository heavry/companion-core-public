import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { CircuitBreaker,classifyNetworkFailure,parseRetryAfter,retryNetworkOperation } from "../src/network-resilience.js";
import { consumeChatCompletionSse } from "../src/chat-stream.js";
import { executeWebSearchTool,setSearchRuntimeConfig } from "../src/search/index.js";
import { TurnRecoveryStore } from "../src/turn-recovery.js";

const temp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-network-resilience-"));
const turnFile=path.join(temp,"turns.json");

// Classifier contract: transient transport/server failures retry; deterministic
// request/auth/schema failures and exhausted quota do not.
for(const status of [408,425,429,500,502,503,504,520,527])assert.equal(classifyNetworkFailure({status}).retryable,true,`HTTP ${status}`);
for(const status of [400,401,403,404,409,415,422])assert.equal(classifyNetworkFailure({status}).retryable,false,`HTTP ${status}`);
assert.equal(classifyNetworkFailure({status:400}).failoverEligible,true,"HTTP 400 preserves the baseline one-shot provider failover contract");
assert.equal(classifyNetworkFailure({status:401}).failoverEligible,false,"HTTP 401 remains terminal");
assert.equal(classifyNetworkFailure({status:429,body:"insufficient_quota: credits exhausted"}).retryable,false);
assert.equal(classifyNetworkFailure({status:429,body:"insufficient_quota: credits exhausted"}).failoverEligible,true,"quota exhaustion may still fail over to an independently configured provider");
assert.equal(classifyNetworkFailure({error:Object.assign(new Error("socket hang up"),{code:"ECONNRESET"})}).errorClass,"econnreset");
assert.equal(parseRetryAfter("2",{now:0}),2000);

// A. Search first 502, second success.
let mode="first-502",requests=0;
const server=http.createServer((req,res)=>{
  requests++;
  if(mode==="first-502"&&requests===1){res.writeHead(502);return res.end("temporary");}
  if(mode==="timeout"){return setTimeout(()=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"results":[]}');},200);}
  res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({results:[{title:"ok",url:"https://example.com",content:"fresh"}]}));
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const base=`http://127.0.0.1:${server.address().port}`;
setSearchRuntimeConfig({provider:"searxng",searxng_base_url:base});
const searchConfig={searchProvider:"auto",tavilyApiKey:"",searxngBaseUrl:"",webSearchMaxResults:3,searchSnippetMaxChars:200,webSearchTimeoutMs:50,networkRetryAttempts:3,networkRecoveryWindowMs:5000,networkCircuitThreshold:3,networkCircuitOpenMs:1000};
let result=await executeWebSearchTool(searchConfig,{query:"test"},{turnId:"A",generationId:"gen-A",requestId:"req-A"});
assert.equal(result.status,"ok");assert.equal(result.attempts,2);assert.equal(result.results.length,1);

// B. Three search timeouts degrade into a structured tool result; no throw.
mode="timeout";requests=0;
result=await executeWebSearchTool(searchConfig,{query:"timeout"},{turnId:"B",generationId:"gen-B",requestId:"req-B"});
assert.equal(result.status,"temporarily_unavailable");assert.equal(result.attempts,3);assert.equal(result.fresh_data_obtained,false);
assert.match(result.content,/"status":"temporarily_unavailable"/);assert.match(result.content,/"fresh_data_obtained":false/);

// C. Connection reset before generation safely retries once.
let generationAttempts=0;
const generation=await retryNetworkOperation(async()=>{generationAttempts++;if(generationAttempts===1)throw Object.assign(new Error("reset"),{code:"ECONNRESET"});return {answer:"one durable answer"};},{maxAttempts:3,maxElapsedMs:5000,sleep:async()=>{},random:()=>0.5});
assert.equal(generation.attempts,2);assert.equal(generation.value.answer,"one durable answer");

// D. A 50%-like partial stream has no terminal frame and is rejected. The
// consumer returns no candidate that a caller could persist.
const partial=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"half"}}]}\n\n'));controller.close();}}));
await assert.rejects(()=>consumeChatCompletionSse(partial),/ended before terminal/);

// E/H. A crash after bubble 0 preserves the plan and commit identity. Reload
// classifies it as FINALIZING; recording bubble 1 completes exactly once.
let seq=0;const store=new TurnRecoveryStore(turnFile,{id:()=>`gen-${++seq}`});
store.begin({turnId:"turn-E",sessionId:"session",userMessageId:10,requestId:"req-E"});
store.transition("turn-E","GENERATING");
store.setPlan("turn-E",[{bubble_index:0,bubble_count:2,text:"one",turn_id:"turn-E"},{bubble_index:1,bubble_count:2,text:"two",turn_id:"turn-E"}]);
store.noteCommit("turn-E",{bubbleIndex:0,messageId:101});
const restarted=new TurnRecoveryStore(turnFile,{id:()=>"unused"});
assert.equal(restarted.get("turn-E").state,"FINALIZING");assert.equal(restarted.get("turn-E").committed.length,1);
restarted.noteCommit("turn-E",{bubbleIndex:0,messageId:999});
assert.equal(restarted.get("turn-E").committed.length,1,"bubble 0 must not duplicate");
restarted.noteCommit("turn-E",{bubbleIndex:1,messageId:102});
assert.equal(restarted.get("turn-E").state,"COMMITTED");assert.equal(restarted.get("turn-E").committed.length,2);

// F. Local realtime loss is transport-only: the durable turn remains committed.
const afterLocalDisconnect=new TurnRecoveryStore(turnFile);
assert.equal(afterLocalDisconnect.get("turn-E").state,"COMMITTED");

// F2. Cold boot: empty-plan non-terminal recovery is expired to FAILED so a
// later retry can generate fresh content instead of replaying RETRY_WAIT.
const emptyPlanFile=path.join(temp,"empty-plan.json");
const emptyPlanStore=new TurnRecoveryStore(emptyPlanFile,{id:()=>`gen-empty`});
emptyPlanStore.begin({turnId:"turn-empty",sessionId:"session",userMessageId:11,requestId:"req-empty"});
emptyPlanStore.transition("turn-empty","GENERATING");
const emptyReloaded=new TurnRecoveryStore(emptyPlanFile,{id:()=>"unused"});
assert.equal(emptyReloaded.get("turn-empty").state,"FAILED");
assert.equal(emptyReloaded.get("turn-empty").error_class,"expired_empty_plan");

// G. Three consecutive retryable failures open the provider circuit; one
// half-open probe is allowed after the cooldown.
let now=0;const breaker=new CircuitBreaker({threshold:3,openMs:20,now:()=>now});
for(let i=0;i<3;i++)breaker.failure("provider",{retryable:true});
assert.equal(breaker.state("provider").state,"OPEN");assert.equal(breaker.allow("provider"),false);
now=21;assert.equal(breaker.allow("provider"),true);assert.equal(breaker.allow("provider"),false);breaker.success("provider");assert.equal(breaker.state("provider").state,"CLOSED");

server.close();fs.rmSync(temp,{recursive:true,force:true});
console.log("network resilience fault injection A-H: ok");
