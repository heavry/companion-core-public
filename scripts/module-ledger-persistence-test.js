import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-ledger-persist-"));
const modulesDir=path.join(tmp,"modules"),dbPath=path.join(tmp,"companion.db"),ledgerPath=path.join(tmp,"module-execution-ledger.json");
const base=29300+Math.floor(Math.random()*300);
const mockPort=base,corePort=base+1,obsPort=base+2;
const key="ledger-persist-key-long-random";
const children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);}
async function wait(url){for(let i=0;i<140;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}

// ---- 副作用观察器：/hit 计数真实执行；/delay 提供受控慢速 handler ----
const hits=new Map();
const observer=http.createServer((req,res)=>{
  const u=new URL(req.url,`http://127.0.0.1:${obsPort}`);
  if(u.pathname==="/hit"){const k=u.searchParams.get("key")??"";hits.set(k,(hits.get(k)??0)+1);res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({ok:true}));}
  if(u.pathname==="/delay"){const ms=Math.min(5000,Number(u.searchParams.get("ms"))||0);setTimeout(()=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({waited:ms}));},ms);return;}
  if(u.pathname==="/counts"){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({count:hits.get(u.searchParams.get("key")??"")??0}));}
  res.writeHead(404);res.end();
});
const hitCount=k=>hits.get(k)??0;

function writeModule(id,manifest,main){
  const dir=path.join(modulesDir,id);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"module.json"),JSON.stringify(manifest,null,2));
  fs.writeFileSync(path.join(dir,"main.js"),main);
}
const baseManifest=overrides=>({id:"x",name:"X",version:"1",type:"tool",engine:"javascript",permissions:[],tools:[],hooks:[],triggers:[],...overrides});
const OBS=`http://127.0.0.1:${obsPort}`;
writeModule("pingy",baseManifest({id:"pingy",name:"Pingy",permissions:["network.fetch"],tools:[
  {name:"mod_ping",description:"ping once per real execution",parameters:{type:"object",additionalProperties:false,properties:{tag:{type:"string"}},required:["tag"]}},
  {name:"mod_slow_ping",description:"slow side-effecting ping",sideEffect:"non_idempotent",parameters:{type:"object",additionalProperties:false,properties:{tag:{type:"string"}},required:["tag"]}},
  {name:"mod_flaky",description:"reports then fails",parameters:{type:"object",additionalProperties:false,properties:{}},required:[]}
]}),
`async function ping(args){const tag=String(args?.tag??"a");await companion.network.fetch("${OBS}/hit?key=ping:"+encodeURIComponent(tag));return {pong:tag};}
async function slowPing(args){const tag=String(args?.tag??"a");await companion.network.fetch("${OBS}/delay?ms=2500");await companion.network.fetch("${OBS}/hit?key=ping:"+encodeURIComponent(tag));return {pong:tag};}
async function flaky(){await companion.network.fetch("${OBS}/hit?key=flaky");throw new Error("FLAKY_ALWAYS_FAILS");}
module.exports={tools:{mod_ping:ping,mod_slow_ping:slowPing,mod_flaky:flaky}};`);

let core=null;
const coreEnv={
  COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
  DATABASE_PATH:dbPath,PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",
  AGENT_TOOL_MODE:"compat",
  COMPANION_MODULES_DIR:modulesDir,COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),
  COMPANION_MODULE_EXECUTION_LEDGER_PATH:ledgerPath,
  COMPANION_SEARCH_CONFIG_PATH:path.join(tmp,"search-provider.json"),
  COMPANION_INTEGRATIONS_CONFIG_PATH:path.join(tmp,"integrations.json"),
  COMPANION_INTEGRATIONS_SECRETS_PATH:path.join(tmp,"integrations-secrets.json"),
  UPSTREAM_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_API_KEY:"",UPSTREAM_CHAT_MODEL:"mock-chat",UPSTREAM_AGENT_MODEL:"mock-agent",UPSTREAM_SUMMARY_MODEL:"mock-summary",
  UPSTREAM_PRIMARY_BASE_URL:"",UPSTREAM_PRIMARY_API_KEY:"",
  UPSTREAM_CHAT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_CHAT_API_KEY:"",
  UPSTREAM_AGENT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_AGENT_API_KEY:"",
  UPSTREAM_SUMMARY_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_SUMMARY_API_KEY:"",
  UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:"",
  COMPANION_BLOCK_REAL_UPSTREAM:"1"
};
async function startCore(){
  core=spawn(process.execPath,[path.join(root,"src/server.js")],{cwd:root,env:{...process.env,...coreEnv},stdio:["ignore","pipe","pipe"]});
  children.push(core);
  await wait(`http://127.0.0.1:${corePort}/health`);
}
function killCore(){if(core&&core.exitCode===null){core.kill("SIGKILL");}core=null;}
const responses=(input,session)=>fetch(`http://127.0.0.1:${corePort}/v1/responses`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"harness","x-companion-session":session},body:JSON.stringify({model:"yuna-agent",input,tools:[],tool_choice:"auto"})}).then(async r=>({status:r.status,text:await r.text()}));
const answerText=t=>{try{const d=JSON.parse(t);return (d.output??[]).flatMap(x=>x?.content??[]).map(x=>x?.text??"").join("");}catch{return ""}};
const readLedger=()=>{try{return JSON.parse(fs.readFileSync(ledgerPath,"utf8"));}catch{return null;}};
async function waitFor(fn,label){for(let i=0;i<200;i++){if(await fn())return;await sleep(60);}throw new Error(`timeout: ${label}`);}

try{
  const obsServer=await new Promise(r=>observer.listen(obsPort,"127.0.0.1",r));
  function startMock(){const p=spawn(process.execPath,[path.join(root,"scripts/mock-upstream.js")],{cwd:root,env:{...process.env,MOCK_PORT:String(mockPort)},stdio:["ignore","ignore","ignore"]});children.push(p);return p;}
  const mock=startMock();
  await wait(`http://127.0.0.1:${mockPort}/stats`);
  await startCore();

  // ---------- A: pending 已持久化 → 崩溃重启 → uncertain，handler 不重跑 ----------
  {
    const attempt=responses([{role:"user",content:"CALL_SLOW_PING PINGTAG:p1 MODULE_ECHO_LAST_TOOL"}],"A");
    // 等 pending 落盘（handler 尚在 2.5s delay 中）
    await waitFor(()=>{const l=readLedger();return Object.values(l?.records??{}).some(r=>r.status==="pending"&&r.tool==="mod_slow_ping");},"A pending persisted");
    killCore(); // 模拟崩溃：SIGKILL，无任何清理机会
    try{await attempt;}catch{}
    await sleep(150);
    await startCore();
    const r=await responses([{role:"user",content:"CALL_SLOW_PING PINGTAG:p1 MODULE_ECHO_LAST_TOOL"}],"A");
    assert(r.status===200,"A retry after crash returns 200");
    assert(answerText(r.text).includes("[module execution uncertain]"),"A uncertainty result surfaced: "+answerText(r.text).slice(0,160));
    await sleep(200);
    assert(hitCount("ping:p1")===0,`A handler never re-executed after crash (hits=${hitCount("ping:p1")})`);
    const rec=Object.values(readLedger()?.records??{}).find(x=>x.tool==="mod_slow_ping");
    assert(rec?.status==="uncertain","A persisted state becomes uncertain");
  }

  // ---------- B: completed 持久化 → 重启 → 回放，执行次数仍为 1 ----------
  {
    const r1=await responses([{role:"user",content:"CALL_PING PINGTAG:b1 MODULE_ECHO_LAST_TOOL"}],"B");
    assert(r1.status===200&&hitCount("ping:b1")===1,"B first execution ok");
    const storedBefore=readLedger();assert(Object.values(storedBefore.records).some(x=>x.status==="completed"&&x.tool==="mod_ping"),"B completed persisted");
    killCore();await sleep(120);await startCore();
    const r2=await responses([{role:"user",content:"CALL_PING PINGTAG:b1 MODULE_ECHO_LAST_TOOL"}],"B");
    assert(r2.status===200&&hitCount("ping:b1")===1,"B restart replay does not re-execute");
    assert(answerText(r2.text).includes('"pong":"b1"'),"B stored compact result returned after restart");
  }

  // ---------- C: 失败重试预算跨重启保留 ----------
  {
    await responses([{role:"user",content:"CALL_FLAKY"}],"C");           // attempt1
    assert(hitCount("flaky")===1,"C attempt1 executed");
    killCore();await sleep(120);await startCore();
    await responses([{role:"user",content:"CALL_FLAKY"}],"C");           // attempt2（重启不清零）
    assert(hitCount("flaky")===2,"C attempt2 executed after restart");
    let rec;await waitFor(()=>{rec=Object.values(readLedger()?.records??{}).find(x=>x.tool==="mod_flaky");return rec?.status==="failed"&&rec.attempts>=2;},"C terminal failed persisted");
    killCore();await sleep(120);await startCore();
    await responses([{role:"user",content:"CALL_FLAKY"}],"C");           // 终端失败回放
    await sleep(150);
    assert(hitCount("flaky")===2,"C no execution beyond cap after restart");
  }

  // ---------- D: 两轮真正独立、参数完全相同的新调用 → 都执行 ----------
  {
    await responses([{role:"user",content:"CALL_PING PINGTAG:d1"}],"D");
    await responses([
      {role:"user",content:"CALL_PING PINGTAG:d1"},
      {role:"assistant",content:"上一张图已生成。"},
      {role:"user",content:"CALL_PING PINGTAG:d1"}
    ],"D");
    await sleep(150);
    assert(hitCount("ping:d1")===2,"D legitimate repeated user intent executes twice");
  }

  // ---------- E: 同一逻辑请求重试 → 只执行一次 ----------
  {
    await responses([{role:"user",content:"CALL_PING PINGTAG:e1"}],"E");
    await responses([{role:"user",content:"CALL_PING PINGTAG:e1"}],"E");
    await sleep(150);
    assert(hitCount("ping:e1")===1,"E logical-request retry executes once");
  }

  // ---------- F: 状态文件损坏 → fail closed：隔离+阻断副作用执行，Core 本身不受拖累 ----------
  {
    killCore();await sleep(120);
    fs.writeFileSync(ledgerPath,"{definitely-broken-json!!");
    await startCore();
    const health=await (await fetch(`http://127.0.0.1:${corePort}/health`)).json();
    assert(health.ok===true,"F Core boots healthy despite corrupt ledger");
    const quarantine=fs.readdirSync(tmp).some(f=>f.startsWith("module-execution-ledger.json.corrupt-"));
    assert(quarantine,"F corrupt file quarantined");
    let st=await (await fetch(`http://127.0.0.1:${corePort}/admin/status`,{headers:{authorization:`Bearer ${key}`}})).json();
    assert(st.module_execution_ledger.health==="corrupt","F admin reports corrupt health");
    const r=await responses([{role:"user",content:"CALL_PING PINGTAG:f1 MODULE_ECHO_LAST_TOOL"}],"F");
    assert(r.status===200,"F request itself still served");
    assert(answerText(r.text).includes("blocked to avoid duplicate actions"),"F side-effecting execution blocked while corrupt");
    assert(hitCount("ping:f1")===0,"F handler not invoked under corrupt ledger");
    // 显式人工恢复后恢复正常执行
    const reset=await fetch(`http://127.0.0.1:${corePort}/admin/modules/ledger/reset`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify({confirm:true})});
    assert(reset.ok,"F manual reset succeeds");
    const r2=await responses([{role:"user",content:"CALL_PING PINGTAG:f2"}],"F");
    assert(r2.status===200&&hitCount("ping:f2")===1,"F execution resumes only after explicit recovery");
  }

  // ---------- G: GC —— 过期 completed 清理，活跃 uncertain 保留 ----------
  {
    killCore();await sleep(120);
    const now=Date.now();
    fs.writeFileSync(ledgerPath,JSON.stringify({version:1,savedAt:new Date().toISOString(),records:{
      "expired\u0000m\u0000t\u0000{}":{fingerprint:"fp-expired",status:"completed",attempts:0,text:"old",moduleId:"m",tool:"t",session:"s",sideEffect:"non_idempotent",createdAt:now-99999,updatedAt:now-99999,expiresAt:now-1000},
      "active\u0000m\u0000t\u0000{}":{fingerprint:"fp-active",status:"uncertain",attempts:0,text:"",moduleId:"m",tool:"t",session:"s",sideEffect:"non_idempotent",createdAt:now,updatedAt:now,expiresAt:0},
      "fresh\u0000m\u0000t\u0000{}":{fingerprint:"fp-fresh",status:"completed",attempts:0,text:"keep",moduleId:"m",tool:"t",session:"s",sideEffect:"non_idempotent",createdAt:now,updatedAt:now,expiresAt:now+600000}
    }}));
    await startCore();
    await responses([{role:"user",content:"CALL_PING PINGTAG:g1"}],"G"); // 触发一次 persist/sweep
    await sleep(200);
    const after=readLedger();
    const keys=Object.keys(after?.records??{});
    assert(!keys.some(k=>k.startsWith("expired")),"G expired completed entry GC'd");
    assert(keys.some(k=>k.startsWith("active")),"G active uncertain never GC'd");
    assert(keys.some(k=>k.startsWith("fresh")),"G unexpired completed retained");
    const st=(await (await fetch(`http://127.0.0.1:${corePort}/admin/status`,{headers:{authorization:`Bearer ${key}`}})).json()).module_execution_ledger;
    assert(st.persistent===true&&typeof st.uncertain==="number"&&st.path.endsWith(".json"),"admin exposes persistent ledger stats");
  }

  console.log("\nPASS Module Execution Ledger Persistence: pending→uncertain on restart (no re-run), completed restart replay, failed budget preserved, legit new turns execute, retry executes-once, corrupt-file fail-safe, GC keeps active states");
}catch(e){throw e;}finally{
  observer.close();
  fs.rmSync(tmp,{recursive:true,force:true});
  for(const p of [...children].reverse()){try{p.kill("SIGKILL");}catch{}}
  await sleep(100);
}
