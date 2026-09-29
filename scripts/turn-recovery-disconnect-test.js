import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root=path.resolve(import.meta.dirname,".."),base=24000+Math.floor(Math.random()*1000),upstreamPort=base,corePort=base+1;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-turn-recovery-")),dbPath=path.join(temp,"companion.db"),key="turn-recovery-test-key",children=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const start=(file,env={})=>{const child=spawn(process.execPath,[file],{cwd:root,env:{...process.env,...env},stdio:["ignore","pipe","pipe"]});children.push(child);return child;};
const stop=async child=>{if(!child||child.exitCode!==null)return;child.kill("SIGTERM");await Promise.race([new Promise(resolve=>child.once("exit",resolve)),sleep(1000)]);if(child.exitCode===null)child.kill("SIGKILL");};
async function wait(url){for(let i=0;i<120;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}

try{
  start(path.join(root,"scripts/mock-upstream.js"),{MOCK_PORT:String(upstreamPort),MOCK_PROVIDER_NAME:"primary"});
  await wait(`http://127.0.0.1:${upstreamPort}/stats`);
  start(path.join(root,"src/server.js"),{
    COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
    DATABASE_PATH:dbPath,COMPANION_MODULES_DIR:path.join(temp,"modules"),COMPANION_MODULES_STATE_PATH:path.join(temp,"modules-state.json"),
    COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(temp,"module-ledger.json"),COMPANION_SCHEDULER_STATE_PATH:path.join(temp,"scheduler.json"),
    COMPANION_TEMPORAL_CONTEXT_PATH:path.join(temp,"temporal.json"),COMPANION_NATURAL_PRESENCE_PATH:path.join(temp,"presence.json"),
    COMPANION_NATURAL_COGNITION_PATH:path.join(temp,"cognition.json"),COMPANION_AUTONOMOUS_LIFE_STATE_PATH:path.join(temp,"autonomous.json"),
    COMPANION_GUIDANCE_QUEUE_PATH:path.join(temp,"guidance.json"),COMPANION_SESSION_PERMISSIONS_PATH:path.join(temp,"permissions.json"),
    PERSONA_SYNC_ON_START:"true",SUMMARY_EVERY_MESSAGES:"9999",EMBEDDING_ENABLED:"false",COMPANION_NATURAL_PRESENCE_ENABLED:"false",
    COMPANION_TEST_FORCED_BUBBLES:'["bubble one","bubble two"]',COMPANION_NATURAL_MESSAGING_MAX_DELAY_MS:"400",
    UPSTREAM_PRIMARY_BASE_URL:`http://127.0.0.1:${upstreamPort}/v1`,UPSTREAM_PRIMARY_MODEL:"primary-model",UPSTREAM_PRIMARY_API_KEY:"mock",
    UPSTREAM_CHAT_BASE_URL:`http://127.0.0.1:${upstreamPort}/v1`,UPSTREAM_CHAT_MODEL:"primary-model",UPSTREAM_CHAT_API_KEY:"mock",
    UPSTREAM_AGENT_BASE_URL:`http://127.0.0.1:${upstreamPort}/v1`,UPSTREAM_AGENT_MODEL:"primary-model",UPSTREAM_AGENT_API_KEY:"mock",
    UPSTREAM_SUMMARY_BASE_URL:`http://127.0.0.1:${upstreamPort}/v1`,UPSTREAM_SUMMARY_MODEL:"primary-model",UPSTREAM_SUMMARY_API_KEY:"mock",
    UPSTREAM_SECONDARY_BASE_URL:`http://127.0.0.1:${upstreamPort}/v1`,UPSTREAM_SECONDARY_MODEL:"secondary-model",UPSTREAM_SECONDARY_API_KEY:"mock",
    UPSTREAM_SECONDARY_CHAT_BASE_URL:`http://127.0.0.1:${upstreamPort}/v1`,UPSTREAM_SECONDARY_CHAT_MODEL:"secondary-model",UPSTREAM_SECONDARY_CHAT_API_KEY:"mock",
    UPSTREAM_SECONDARY_AGENT_BASE_URL:`http://127.0.0.1:${upstreamPort}/v1`,UPSTREAM_SECONDARY_AGENT_MODEL:"secondary-model",UPSTREAM_SECONDARY_AGENT_API_KEY:"mock",
    UPSTREAM_SECONDARY_SUMMARY_BASE_URL:`http://127.0.0.1:${upstreamPort}/v1`,UPSTREAM_SECONDARY_SUMMARY_MODEL:"secondary-model",UPSTREAM_SECONDARY_SUMMARY_API_KEY:"mock",
    NETWORK_RETRY_ATTEMPTS:"1",COMPANION_BLOCK_REAL_UPSTREAM:"1"
  });
  await wait(`http://127.0.0.1:${corePort}/health`);

  const requestId="disconnect-two-bubble",sessionKey="turn-recovery-disconnect",headers={authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"chat","x-companion-session":sessionKey,"x-companion-request-id":requestId};
  const body=JSON.stringify({model:"yuna-chat",stream:true,messages:[{role:"user",content:"disconnect after first bubble"}]});
  const controller=new AbortController(),first=await fetch(`http://127.0.0.1:${corePort}/v1/chat/completions`,{method:"POST",headers,body,signal:controller.signal}),reader=first.body.getReader(),decoder=new TextDecoder();
  let received="";while(!received.includes("companion_bubble_index")){const chunk=await reader.read();assert.equal(chunk.done,false);received+=decoder.decode(chunk.value,{stream:true});}
  controller.abort();try{await reader.read();}catch{}
  await sleep(150);

  // Simulate the persisted partial cache shape produced by the original bug;
  // recovery metadata must win over this stale "complete" response.
  const seedDb=new DatabaseSync(dbPath),seedSession=seedDb.prepare("SELECT id FROM sessions WHERE source=? AND external_key=?").get("chat",sessionKey);
  seedDb.prepare("INSERT OR REPLACE INTO idempotency_cache(session_id,request_key,response_json,created_at) VALUES(?,?,?,?)").run(seedSession.id,requestId,JSON.stringify({id:"stale-partial",object:"chat.completion",model:"yuna-chat",choices:[{index:0,message:{role:"assistant",content:"bubble one"},finish_reason:"stop"}],companion_bubbles:["bubble one"],companion_bubble_plan:[{bubble_index:0,bubble_count:1,text:"bubble one"}],companion_bubble_count:1}),new Date().toISOString());seedDb.close();

  const replay=await fetch(`http://127.0.0.1:${corePort}/v1/chat/completions`,{method:"POST",headers,body}),replayText=await replay.text();
  assert.equal(replay.status,200);assert.match(replayText,/data: \[DONE\]/);assert.match(replayText,/"companion_bubble_index":1/);
  await sleep(100);

  const db=new DatabaseSync(dbPath,{readOnly:true}),session=db.prepare("SELECT id FROM sessions WHERE source=? AND external_key=?").get("chat",sessionKey);
  const rows=db.prepare("SELECT id,role,content_text,content_json FROM messages WHERE session_id=? ORDER BY id").all(session.id),users=rows.filter(row=>row.role==="user"),assistants=rows.filter(row=>row.role==="assistant").map(row=>({...row,json:JSON.parse(row.content_json||"{}")}));db.close();
  assert.equal(users.length,1,"same request ID stores one user row");assert.equal(assistants.length,2,"replay commits the missing second bubble");assert.deepEqual(assistants.map(row=>row.json.bubble_index),[0,1]);assert.equal(new Set(assistants.map(row=>row.id)).size,2,"assistant rows are exactly-once");
  const recovery=JSON.parse(fs.readFileSync(path.join(temp,"turn-recovery.json"),"utf8")),turn=recovery.turns.find(item=>item.session_id===session.id);
  assert.equal(turn.state,"COMMITTED");assert.equal(turn.plan.length,2);assert.equal(turn.committed.length,2);
  const stats=await fetch(`http://127.0.0.1:${upstreamPort}/stats`).then(response=>response.json());assert.equal(stats.total,1,"replay resumes the canonical plan without a second upstream generation");
  console.log("turn recovery disconnect replay: ok (2/2 bubbles, 0 duplicates, 0 partial durable plans)");
}finally{
  for(const child of [...children].reverse())await stop(child);
  await sleep(50);fs.rmSync(temp,{recursive:true,force:true});
}
