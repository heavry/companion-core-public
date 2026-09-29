import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-mod-idem-"));
const modulesDir=path.join(tmp,"modules"),dbPath=path.join(tmp,"companion.db");
const base=27900+Math.floor(Math.random()*300);
const primaryPort=base,secondaryPort=base+1,corePort=base+2,obsPort=base+3;
const key="idem-test-key-long-random";
const children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);};
async function wait(url){for(let i=0;i<140;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}
function start(file,extraEnv={}){const p=spawn(process.execPath,[file],{cwd:root,env:{...process.env,...extraEnv},stdio:["ignore","pipe","pipe"]});children.push(p);p.stderr.on("data",d=>process.stderr.write(`[${path.basename(file)}-err] ${String(d).slice(0,400)}`));return p;}

// ---- 副作用观察器：模块 handler 每次真实执行都会打一次 ----
const hits=new Map();
const observer=http.createServer((req,res)=>{
  const u=new URL(req.url,`http://127.0.0.1:${obsPort}`);
  if(u.pathname==="/hit"){const k=u.searchParams.get("key")??"";hits.set(k,(hits.get(k)??0)+1);res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({ok:true,count:hits.get(k)}));}
  if(u.pathname==="/counts"){const k=u.searchParams.get("key");res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify(k?{count:hits.get(k)??0}:Object.fromEntries(hits)));}
  res.writeHead(404);res.end();
});
const hitCount=k=>hits.get(k)??0;

// ---- 夹具模块：通过受控 bridge network.fetch 上报真实执行次数 ----
function writeModule(id,manifest,main){
  const dir=path.join(modulesDir,id);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"module.json"),JSON.stringify(manifest,null,2));
  fs.writeFileSync(path.join(dir,"main.js"),main);
}
const baseManifest=overrides=>({id:"x",name:"X",version:"1",type:"tool",engine:"javascript",permissions:[],tools:[],hooks:[],triggers:[],...overrides});
writeModule("pingy",baseManifest({id:"pingy",name:"Pingy",permissions:["network.fetch"],tools:[
  {name:"mod_ping",description:"ping observer once per real execution",parameters:{type:"object",additionalProperties:false,properties:{tag:{type:"string"}},required:["tag"]}},
  {name:"mod_flaky",description:"always reports then fails",parameters:{type:"object",additionalProperties:false,properties:{}},required:[]}
]}),
`async function ping(args){const tag=String(args?.tag??"a");await companion.network.fetch("${`http://127.0.0.1:${obsPort}`}/hit?key=ping:"+encodeURIComponent(tag));return {pong:tag};}
async function flaky(){await companion.network.fetch("${`http://127.0.0.1:${obsPort}`}/hit?key=flaky");throw new Error("FLAKY_ALWAYS_FAILS");}
module.exports={tools:{mod_ping:ping,mod_flaky:flaky}};`);
writeModule("note",baseManifest({id:"note",name:"Note",permissions:["network.fetch"],tools:[
  {name:"mod_echo_note",description:"echo a note",parameters:{type:"object",additionalProperties:false,properties:{text:{type:"string"}},required:["text"]}}
]}),
`async function echoNote(args){await companion.network.fetch("${`http://127.0.0.1:${obsPort}`}/hit?key=echo");return {note:"ECHO_NOTE:"+String(args?.text??"")};}
module.exports={tools:{mod_echo_note:echoNote}};`);

// ---- 触发器夹具（验证 Trigger 路径不受台账影响）----
writeModule("trig-lite",baseManifest({id:"trig-lite",name:"TrigLite",type:"automation",tools:[],triggers:[{id:"manual_emit",type:"manual"}]}),
`async function manualEmit(){return {event:{content:"IDEM_TRIGGER_EVENT",importance:.4}};}
module.exports={tools:{},triggers:{manual_emit:manualEmit}};`);

const responses=async(input,session,headers={})=>{const r=await fetch(`http://127.0.0.1:${corePort}/v1/responses`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"harness","x-companion-session":session,...headers},body:JSON.stringify({model:"yuna-agent",input,tools:[],tool_choice:"auto"})});const text=await r.text();let data=null;try{data=JSON.parse(text)}catch{}return {status:r.status,data,text};};

let core;
try{
  const obsServer=await new Promise(r=>observer.listen(obsPort,"127.0.0.1",r));

  const primaryMock=start(path.join(root,"scripts/mock-upstream.js"),{MOCK_PORT:String(primaryPort),MOCK_PROVIDER_NAME:"primary"});
  const secondaryMock=start(path.join(root,"scripts/mock-upstream.js"),{MOCK_PORT:String(secondaryPort),MOCK_PROVIDER_NAME:"secondary"});
  await Promise.all([wait(`http://127.0.0.1:${primaryPort}/stats`),wait(`http://127.0.0.1:${secondaryPort}/stats`)]);

  core=start(path.join(root,"src/server.js"),{
    COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
    DATABASE_PATH:dbPath,COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"module-execution-ledger.json"),PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",
    AGENT_TOOL_MODE:"compat",
    COMPANION_MODULES_DIR:modulesDir,COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),
    UPSTREAM_BASE_URL:`http://127.0.0.1:${primaryPort}/v1`,UPSTREAM_API_KEY:"",UPSTREAM_CHAT_MODEL:"mock-chat",UPSTREAM_AGENT_MODEL:"mock-agent",UPSTREAM_SUMMARY_MODEL:"mock-summary",
    UPSTREAM_PRIMARY_BASE_URL:`http://127.0.0.1:${primaryPort}/v1`,UPSTREAM_PRIMARY_API_KEY:"",
    UPSTREAM_CHAT_BASE_URL:`http://127.0.0.1:${primaryPort}/v1`,UPSTREAM_CHAT_API_KEY:"",
    UPSTREAM_AGENT_BASE_URL:`http://127.0.0.1:${primaryPort}/v1`,UPSTREAM_AGENT_API_KEY:"",
    UPSTREAM_SUMMARY_BASE_URL:`http://127.0.0.1:${primaryPort}/v1`,UPSTREAM_SUMMARY_API_KEY:"",
    UPSTREAM_SECONDARY_BASE_URL:`http://127.0.0.1:${secondaryPort}/v1`,UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:"secondary-model",
    UPSTREAM_SECONDARY_CHAT_BASE_URL:`http://127.0.0.1:${secondaryPort}/v1`,UPSTREAM_SECONDARY_CHAT_API_KEY:"",UPSTREAM_SECONDARY_CHAT_MODEL:"secondary-model",
    UPSTREAM_SECONDARY_AGENT_BASE_URL:`http://127.0.0.1:${secondaryPort}/v1`,UPSTREAM_SECONDARY_AGENT_API_KEY:"",UPSTREAM_SECONDARY_AGENT_MODEL:"secondary-model",
    UPSTREAM_SECONDARY_SUMMARY_BASE_URL:`http://127.0.0.1:${secondaryPort}/v1`,UPSTREAM_SECONDARY_SUMMARY_API_KEY:"",UPSTREAM_SECONDARY_SUMMARY_MODEL:"secondary-model",
    COMPANION_BLOCK_REAL_UPSTREAM:"1"
  });
  children.push(core);
  await wait(`http://127.0.0.1:${corePort}/health`);
  assert((await (await fetch(`http://127.0.0.1:${corePort}/health`,{headers:{authorization:`Bearer ${key}`}})).json()).version==="0.2.8.0","health version");

  // S1: 同一 idempotency-key 重放 → handler 只执行一次，响应逐字节一致
  {
    const headers={"idempotency-key":"s1-key"};
    const r1=await responses([{role:"user",content:"CALL_PING PINGTAG:a"}],"s1",headers);
    assert(r1.status===200,"S1 first request ok: "+r1.text.slice(0,300));
    const r2=await responses([{role:"user",content:"CALL_PING PINGTAG:a"}],"s1",headers);
    await sleep(150);
    assert(hitCount("ping:a")===1,`S1 idempotency replay executes module exactly once (got ${hitCount("ping:a")})`);
    assert(r2.status===200&&JSON.stringify(r2.data)===JSON.stringify(r1.data),"S1 keyed replay returns cached response verbatim");
  }

  // S1b: 无 key 的相同负载重试 → 同样只执行一次且结果一致
  {
    const r1=await responses([{role:"user",content:"CALL_PING PINGTAG:c"}],"s1b");
    const r2=await responses([{role:"user",content:"CALL_PING PINGTAG:c"}],"s1b");
    assert(r1.status===200&&r2.status===200&&hitCount("ping:c")===1,"S1b keyless retry replays stored result");
    const textOf=out=>(out?.output??[]).flatMap(x=>x?.content??[]).map(x=>x?.text??"").join("");
    assert(textOf(r1.data)===textOf(r2.data),"S1b replayed answer text identical");
  }

  // S2: 并发重复 invocation → 只执行一次
  {
    const payload={model:"yuna-agent",input:[{role:"user",content:"CALL_PING PINGTAG:conc"}],tools:[],tool_choice:"auto"};
    const [x,y]=await Promise.all([
      fetch(`http://127.0.0.1:${corePort}/v1/responses`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"harness","x-companion-session":"s2"},body:JSON.stringify(payload)}),
      fetch(`http://127.0.0.1:${corePort}/v1/responses`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"harness","x-companion-session":"s2"},body:JSON.stringify(payload)})
    ]);
    assert(x.status===200&&y.status===200,"S2 both concurrent requests succeed");
    await sleep(150);
    assert(hitCount("ping:conc")===1,`S2 concurrent duplicate executes once (got ${hitCount("ping:conc")})`);
  }

  // S3: 执行后中断（round-2 hang + client cancel）→ 重放不再执行
  {
    const controller=new AbortController();
    const attempt1=fetch(`http://127.0.0.1:${corePort}/v1/responses`,{method:"POST",signal:controller.signal,headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"harness","x-companion-session":"s3"},body:JSON.stringify({model:"yuna-agent",input:[{role:"user",content:"CALL_PING PINGTAG:b MODULE_ROUND2_HANG"}],tools:[],tool_choice:"auto"})}).catch(e=>e);
    for(let i=0;i<100&&hitCount("ping:b")===0;i++)await sleep(50);
    assert(hitCount("ping:b")===1,"S3 execution happened before interruption");
    controller.abort();
    await attempt1;
    await sleep(200);
    // 重放同一负载：执行点命中台账 completed 记录 → 不再调用 handler
    const attempt2=fetch(`http://127.0.0.1:${corePort}/v1/responses`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"harness","x-companion-session":"s3"},body:JSON.stringify({model:"yuna-agent",input:[{role:"user",content:"CALL_PING PINGTAG:b MODULE_ROUND2_HANG"}],tools:[],tool_choice:"auto"})}).catch(e=>e);
    await sleep(900);
    assert(hitCount("ping:b")===1,`S3 continuation replay does not re-execute (still ${hitCount("ping:b")})`);
    const c2=new AbortController();c2.abort();
    try{await attempt2;}catch{}
  }

  // S5: 失败执行有上限（MAX_ATTEMPTS=2），终端失败后回放错误文本不再执行
  {
    await responses([{role:"user",content:"CALL_FLAKY"}],"s5");
    await responses([{role:"user",content:"CALL_FLAKY"}],"s5");
    await responses([{role:"user",content:"CALL_FLAKY"}],"s5");
    await sleep(150);
    assert(hitCount("flaky")===2,`S5 failed execution capped at 2 attempts (got ${hitCount("flaky")})`);
    const db=new DatabaseSync(dbPath,{readOnly:true});
    let errRows;try{errRows=Number(db.prepare("SELECT COUNT(*) c FROM messages WHERE role='tool' AND content_text LIKE '%FLAKY_ALWAYS_FAILS%'").get().c);}finally{db.close();}
    assert(errRows===3,"S5 error text persisted once per request (2 real attempts + 1 terminal replay, no extra executions)");
    const status=await (await fetch(`http://127.0.0.1:${corePort}/admin/status`,{headers:{authorization:`Bearer ${key}`}})).json();
    assert(status.module_execution_ledger?.failed>=1,"ledger exposes terminal failed entries in admin status");
  }

  // S6: 参数完全相同但属于新一轮对话 → 必须执行两次
  {
    await responses([{role:"user",content:"CALL_PING PINGTAG:d"}],"s6");
    await responses([
      {role:"user",content:"CALL_PING PINGTAG:d"},
      {role:"assistant",content:"已处理上一轮。"},
      {role:"user",content:"CALL_PING PINGTAG:d"}
    ],"s6");
    await sleep(150);
    assert(hitCount("ping:d")===2,`S6 identical args in a genuinely new turn execute twice (got ${hitCount("ping:d")})`);
  }

  // S7: client bash 不受影响 —— 返回客户端执行，不产生台账条目、不触发模块
  {
    const ledgerBefore=(await (await fetch(`http://127.0.0.1:${corePort}/admin/status`,{headers:{authorization:`Bearer ${key}`}})).json()).module_execution_ledger.entries;
    const r=await fetch(`http://127.0.0.1:${corePort}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"opencode","x-companion-session":"s7-bash"},body:JSON.stringify({model:"yuna-agent",messages:[{role:"user",content:"COMPAT_SELECT_TOOL:bash"}],tools:[{type:"function",function:{name:"bash",description:"run shell command",parameters:{type:"object",properties:{}}}}],tool_choice:"auto"})});
    const data=await r.json();
    assert(data.choices?.[0]?.message?.tool_calls?.[0]?.function?.name==="bash","S7 client bash returned to client");
    const ledgerAfter=(await (await fetch(`http://127.0.0.1:${corePort}/admin/status`,{headers:{authorization:`Bearer ${key}`}})).json()).module_execution_ledger.entries;
    assert(ledgerAfter===ledgerBefore,"S7 no ledger entry created for client tool");
  }

  // S8: 正常模块多轮 loop 不受影响（MODULE_LOOP → mod_echo_note → 结果回注 → final）
  {
    const echoBefore=hitCount("echo");
    const r=await responses([{role:"user",content:"MODULE_LOOP"}],"s8");
    assert(r.status===200,"S8 loop request ok");
    const text=(r.data.output??[]).flatMap(x=>x?.content??[]).map(x=>x?.text??"").join("");
    assert(text==="MODULE_RESULT_SEEN:yes","S8 multi-tool loop reaches final answer with module result");
    assert(hitCount("echo")===echoBefore+1,"S8 module executed exactly once inside loop");
  }

  // S9: provider failover 不受影响
  {
    const r=await fetch(`http://127.0.0.1:${corePort}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"kelivo","x-companion-session":"s9-failover"},body:JSON.stringify({model:"yuna-chat",messages:[{role:"user",content:"PRIMARY_ONLY_502"}]})});
    const data=await r.json();
    assert(data.choices?.[0]?.message?.content==="SECONDARY_MOCK_OK","S9 primary 502 still fails over to secondary");
  }

  // S10: Trigger 执行不受台账影响
  {
    const run=await fetch(`http://127.0.0.1:${corePort}/admin/modules/trig-lite/triggers/manual_emit/run`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:"{}"});
    assert(run.ok,"S10 manual trigger runs");
    await sleep(300);
    const db=new DatabaseSync(dbPath,{readOnly:true});
    let ev;try{ev=Number(db.prepare("SELECT COUNT(*) c FROM events WHERE content='IDEM_TRIGGER_EVENT'").get().c);}finally{db.close();}
    assert(ev===1,"S10 trigger-emitted event stored outside ledger semantics");
  }

  console.log("\nPASS Module Tool Execution Idempotency: keyed/keyless/concurrent replay execute-once, post-execution interruption safe, failed capped at 2, new-turn re-executes, client bash & failover & triggers untouched");
}catch(e){throw e;}finally{
  observer.close();
  fs.rmSync(tmp,{recursive:true,force:true});
  for(const p of [...children].reverse()){try{p.kill("SIGTERM");}catch{}}
  await sleep(100);
}
