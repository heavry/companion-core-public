import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-module-trig-"));
const modulesDir=path.join(tmp,"modules"),dbPath=path.join(tmp,"companion.db");
const corePort=27100+Math.floor(Math.random()*400),key="trigger-test-key-long-random";
const children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);};
async function wait(url){for(let i=0;i<120;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}
async function api(pathname,options={}){const r=await fetch(`http://127.0.0.1:${corePort}${pathname}`,{headers:{authorization:`Bearer ${key}`,...(options.body?{"content-type":"application/json"}:{})},method:options.method??"GET",body:options.body?JSON.stringify(options.body):undefined});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}return {r,data,text};}
function openDb(){return new DatabaseSync(dbPath,{readOnly:true});}
function eventCount(content){const db=openDb();try{return Number(db.prepare("SELECT COUNT(*) c FROM events WHERE content LIKE ?").get(`%${content}%`).c);}finally{db.close();}}
function waitFor(fn,label){return (async()=>{for(let i=0;i<200;i++){if(await fn())return;await sleep(60);}throw new Error(`timeout: ${label}`);})();}

fs.mkdirSync(modulesDir,{recursive:true});
// 触发器夹具：interval 每秒发 TICK_EVENT；manual 发 FIXED_EV_CONTENT；
// event_created 收到事件后回发 RECUR_<random>（内容随机，绕开内容去重，专测深度/冷却护栏）
const fixDir=path.join(modulesDir,"trig-fixture");
fs.mkdirSync(fixDir,{recursive:true});
fs.writeFileSync(path.join(fixDir,"module.json"),JSON.stringify({id:"trig-fixture",name:"Trig Fixture",version:"1",type:"automation",engine:"javascript",permissions:[],tools:[],hooks:[],triggers:[
  {id:"tick_every_second",type:"interval",everySeconds:1},
  {id:"manual_emit_fixed",type:"manual"},
  {id:"on_any_event",type:"event_created"}
],description:""},null,2));
fs.writeFileSync(path.join(fixDir,"main.js"),`
let manualRuns=0,eventRuns=0,tickRuns=0;
async function tick(){tickRuns++;return {event:{content:"TICK_EVENT",importance:.2}};}
async function manual(){manualRuns++;return {event:{content:"FIXED_EV_CONTENT",importance:.5}};}
async function onEvent(payload){eventRuns++;return {event:{content:"RECUR_"+Date.now()+"_"+Math.floor(Math.random()*1e9),importance:.4}};}
module.exports={tools:{},triggers:{tick_every_second:tick,manual_emit_fixed:manual,on_any_event:onEvent}};`);

const env={
  ...process.env,
  COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
  DATABASE_PATH:dbPath,COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"module-execution-ledger.json"),COMPANION_BLOCK_REAL_UPSTREAM:"1",PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",
  AGENT_TOOL_MODE:"compat",
  COMPANION_MODULES_DIR:modulesDir,COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),
  MODULE_TRIGGER_MIN_SECONDS:"1",MODULE_TRIGGER_MAX_DEPTH:"2",MODULE_TRIGGER_TICK_MS:"250",
  UPSTREAM_BASE_URL:"http://127.0.0.1:9/v1",UPSTREAM_API_KEY:"",UPSTREAM_CHAT_MODEL:"x",UPSTREAM_AGENT_MODEL:"x",
  UPSTREAM_CHAT_BASE_URL:"http://127.0.0.1:9/v1",UPSTREAM_CHAT_API_KEY:"",UPSTREAM_AGENT_BASE_URL:"http://127.0.0.1:9/v1",UPSTREAM_AGENT_API_KEY:"",UPSTREAM_SUMMARY_BASE_URL:"http://127.0.0.1:9/v1",UPSTREAM_SUMMARY_API_KEY:"",
  UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:"",
  UPSTREAM_PRIMARY_BASE_URL:"",UPSTREAM_PRIMARY_API_KEY:""
};
let core;
try{
  core=spawn(process.execPath,[path.join(root,"src/server.js")],{cwd:root,env,stdio:["ignore","pipe","pipe"]});
  children.push(core);
  core.stderr.on("data",d=>process.stderr.write(`[core-err] ${d}`));
  await wait(`http://127.0.0.1:${corePort}/health`);

  // interval trigger：等待第一个 TICK_EVENT 落库
  await waitFor(()=>eventCount("TICK_EVENT")>=1,"interval trigger fires");

  const statusBefore=await api("/admin/modules");
  const trigFixture=statusBefore.data.modules.find(m=>m.id==="trig-fixture");
  assert(trigFixture?.loaded===true,"fixture module loaded");
  assert(trigFixture.triggers.length===3,"admin lists all triggers with types");

  // duplicate suppression：TICK_EVENT 内容恒定 → insertEvent 内容去重，永远只有一条
  await sleep(1500);
  assert(eventCount("TICK_EVENT")===1,"duplicate suppression collapses repeated identical events");

  // manual trigger
  const run1=await api("/admin/modules/trig-fixture/triggers/manual_emit_fixed/run",{method:"POST",body:{}});
  assert(run1.r.ok&&run1.data.ok===true&&run1.data.emitted_event===true,"manual trigger runs and emits event");
  await waitFor(()=>eventCount("FIXED_EV_CONTENT")>=1,"manual emitted event stored");

  // idempotency / duplicate suppression：立即重跑同一 manual trigger → 引擎幂等窗口拦截
  const run2=await api("/admin/modules/trig-fixture/triggers/manual_emit_fixed/run",{method:"POST",body:{}});
  const run3=await api("/admin/modules/trig-fixture/triggers/manual_emit_fixed/run",{method:"POST",body:{}});
  assert(run2.data.ok===false&&["cooldown","duplicate_suppressed"].includes(run2.data.reason),"immediate re-run blocked by cooldown or idempotency");
  assert(run3.data.ok===false,"third rapid re-run also guarded");
  assert(eventCount("FIXED_EV_CONTENT")===1,"exactly one FIXED event despite multiple manual runs");

  // recursion guard：FIXED_EV 入库 → event_created 触发 RECUR 链
  // depth1 允许、depth2 允许、depth3 被 MAX_DEPTH=2 拦截；同 trigger 冷却 1s 进一步限流。
  await sleep(2500);
  const recurCount=eventCount("RECUR_");
  assert(recurCount>=1,"event_created trigger fired from module event");
  assert(recurCount<=3,`recursion bounded by depth guard + cooldown (got ${recurCount})`);

  // disable 后：manual run 拒绝，interval 停止产生新事件
  const disableRes=await api("/admin/modules/trig-fixture/disable",{method:"POST",body:{}});
  assert(disableRes.r.ok&&disableRes.data.module.enabled===false,"module disabled via admin");
  const db=openDb();
  let tickMax;try{const row=db.prepare("SELECT MAX(id) m FROM events").get();tickMax=row.m;}finally{db.close();}
  await sleep(1600);
  const afterDb=openDb();
  let grew;try{grew=Number(afterDb.prepare("SELECT COUNT(*) c FROM events").get().c)>0&&(afterDb.prepare("SELECT MAX(id) m FROM events").get().m>tickMax);}finally{afterDb.close();}
  assert(!grew||eventCount("TICK_EVENT")===0,"disabled module stops producing events (no growth beyond dedup)");
  const disabledRun=await api("/admin/modules/trig-fixture/triggers/manual_emit_fixed/run",{method:"POST",body:{}});
  assert(!disabledRun.r.ok||disabledRun.data.ok===false,"manual run on disabled module is rejected");
  const afterDisable=await api("/admin/modules");
  const disabledModule=afterDisable.data.modules.find(m=>m.id==="trig-fixture");
  assert(disabledModule.enabled===false&&!disabledModule.loaded,"admin reflects disabled state and unloaded instance");

  console.log("\nPASS Module Trigger Engine: interval, manual, duplicate suppression/idempotency, depth+cooldown recursion guard, disable isolation");
}catch(e){throw e;}finally{
  fs.rmSync(tmp,{recursive:true,force:true});
  for(const p of [...children].reverse()){try{p.kill("SIGTERM");}catch{}}
  await sleep(80);
}
