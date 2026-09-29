import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-scheduler-"));
process.env.DATABASE_PATH=path.join(root,"companion.db");process.env.COMPANION_SCHEDULER_STATE_PATH=path.join(root,"scheduler.json");process.env.COMPANION_API_KEY="test";
for(const key of ["UPSTREAM_BASE_URL","UPSTREAM_API_KEY","UPSTREAM_CHAT_BASE_URL","UPSTREAM_AGENT_BASE_URL","UPSTREAM_SUMMARY_BASE_URL","UPSTREAM_PRIMARY_BASE_URL","UPSTREAM_SECONDARY_BASE_URL","TAVILY_API_KEY","SEARXNG_BASE_URL"])process.env[key]="";
const { SchedulerStore,nextCronAfter,parseCron }=await import("../src/scheduler.js");

assert.equal(nextCronAfter("30 9 * * 1",new Date("2026-08-24T00:00:00Z"),"Asia/Shanghai"),"2026-08-24T01:30:00.000Z");
assert.equal(parseCron("*/15 * * * *").minutes.size,4);
assert.throws(()=>parseCron("0 0 * *"),/five fields/);

let clock=new Date("2026-08-27T10:00:00Z"),calls=0;
const file=path.join(root,"once.json"),store=new SchedulerStore({file,now:()=>clock,executor:async()=>{calls++;return {dispatched:true};}});
const once=store.create({title:"一次提醒",schedule:{type:"once",at:"2026-08-27T10:01:00Z",timeZone:"Asia/Shanghai"},target:{type:"conversation",content:"记得喝水"}});
clock=new Date("2026-08-27T10:02:00Z");
await store.tick();await store.tick();
assert.equal(calls,1,"once plan executes exactly once");
assert.equal(store.snapshot().plans[0].enabled,false);
assert.deepEqual(store.snapshot().history[0].transitions.map(x=>x.status),["queued","running","dispatched","completed"]);

const restored=new SchedulerStore({file,now:()=>clock,executor:async()=>{calls++;}});
assert.equal(restored.snapshot().history[0].status,"completed");
assert.equal(restored.snapshot().plans[0].id,once.id);

const recoveryFile=path.join(root,"recovery.json"),recovery=new SchedulerStore({file:recoveryFile,now:()=>clock,executor:async()=>{}});
const recoveryPlan=recovery.create({title:"恢复测试",schedule:{type:"cron",expression:"* * * * *",timeZone:"UTC"},target:{type:"internal",operation:"record_event",content:"检查"}});
recovery.state.executions.push({id:"run-1",planId:recoveryPlan.id,planTitle:recoveryPlan.title,scheduledFor:clock.toISOString(),status:"running",createdAt:clock.toISOString(),startedAt:clock.toISOString(),finishedAt:null,error:null,transitions:[{status:"queued",at:clock.toISOString()},{status:"running",at:clock.toISOString()}]});recovery.save();
clock=new Date("2026-08-27T10:00:20Z");
const afterRestart=new SchedulerStore({file:recoveryFile,now:()=>clock,executor:async()=>{}});
assert.equal(afterRestart.snapshot().history[0].status,"interrupted");

let release,concurrentCalls=0;const gate=new Promise(resolve=>{release=resolve;}),concurrentFile=path.join(root,"concurrent.json");
const concurrent=new SchedulerStore({file:concurrentFile,now:()=>clock,executor:async()=>{concurrentCalls++;await gate;}});
const concurrentPlan=concurrent.create({title:"并发保护",schedule:{type:"once",at:"2026-08-27T10:01:00Z",timeZone:"UTC"},target:{type:"conversation",content:"只执行一次"}});
clock=new Date("2026-08-27T10:02:00Z");
const firstTick=concurrent.tick();await Promise.resolve();await concurrent.tick();assert.equal(concurrentCalls,1);release();await firstTick;await concurrent.tick();assert.equal(concurrentCalls,1);
assert.throws(()=>concurrent.update(concurrentPlan.id,{enabled:true}),/future/);assert.equal(concurrent.update(concurrentPlan.id,{enabled:false}).nextRunAt,null);
assert.equal(concurrent.delete(concurrentPlan.id),true);assert.equal(concurrent.delete(concurrentPlan.id),false);

const { ensureDefaultPersona }=await import("../src/persona.js"),{ db }=await import("../src/db.js");ensureDefaultPersona();
clock=new Date("2026-08-27T11:00:00Z");
const builtIn=new SchedulerStore({file:path.join(root,"built-in.json"),now:()=>clock});
builtIn.create({title:"本地提醒",schedule:{type:"once",at:"2026-08-27T11:01:00Z",timeZone:"UTC"},target:{type:"conversation",content:"这是一条精确提醒"}});
clock=new Date("2026-08-27T11:02:00Z");await builtIn.tick();
assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM messages WHERE source='scheduler' AND content_text='这是一条精确提醒'").get().count),1);
assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM usage_log").get().count),0,"scheduler reminder must not call an LLM");

fs.rmSync(root,{recursive:true,force:true});console.log("scheduler-test: ok");
