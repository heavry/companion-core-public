import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-time-awareness-"));
process.env.TZ="Tokyo";
process.env.COMPANION_API_KEY="test";
process.env.DATABASE_PATH=path.join(root,"db.sqlite");
process.env.COMPANION_DATA_DIR=root;
process.env.COMPANION_TEMPORAL_CONTEXT_PATH=path.join(root,"temporal.json");
process.env.COMPANION_GUIDANCE_QUEUE_PATH=path.join(root,"guidance.json");
process.env.COMPANION_INVOCATION_LEDGER_PATH=path.join(root,"ledger.jsonl");
process.env.COMPANION_INVOCATION_SUMMARY_PATH=path.join(root,"summary.json");
process.env.COMPANION_PRICING_REVISIONS_PATH=path.join(root,"prices.json");
process.env.EMBEDDING_ENABLED="false";
for(const key of ["UPSTREAM_BASE_URL","UPSTREAM_API_KEY","UPSTREAM_CHAT_BASE_URL","UPSTREAM_CHAT_API_KEY","UPSTREAM_AGENT_BASE_URL","UPSTREAM_AGENT_API_KEY","UPSTREAM_SUMMARY_BASE_URL","UPSTREAM_SUMMARY_API_KEY","UPSTREAM_PRIMARY_BASE_URL","UPSTREAM_PRIMARY_API_KEY","UPSTREAM_SECONDARY_BASE_URL","UPSTREAM_SECONDARY_API_KEY","TAVILY_API_KEY","TAVILY_BASE_URL","SEARXNG_BASE_URL"])process.env[key]="";

const { CompanionTimeService }=await import("../src/time-service.js");
let clock=new Date("2026-08-28T12:00:00Z");const time=new CompanionTimeService({clock:()=>clock});
assert.equal(time.localISO(),"2026-08-28T20:00:00+08:00");
assert.equal(time.nowLocal(),"2026-08-28T20:00:00+08:00");assert.equal(time.toLocal("2026-08-28T12:00:00Z").dayPart,"晚上");
clock=new Date("2026-08-28T16:30:00Z");assert.equal(time.localDate(),"2026-08-29");assert.equal(time.localTime(),"00:30");assert.equal(time.timeZone,"Asia/Shanghai","system Tokyo timezone must not change Companion time");
assert.deepEqual(time.localDayBoundsToUTC("2026-08-29"),{start:"2026-08-28T16:00:00.000Z",end:"2026-08-29T16:00:00.000Z"});
assert.deepEqual(time.localMonthBoundsToUTC("2026-08"),{start:"2026-07-31T16:00:00.000Z",end:"2026-08-31T16:00:00.000Z"});

const { InvocationLedger }=await import("../src/usage-ledger.js");
const ledger=new InvocationLedger({ledgerPath:path.join(root,"boundary.jsonl"),summaryPath:path.join(root,"boundary-summary.json"),pricesPath:path.join(root,"boundary-prices.json"),now:()=>clock,timeService:time});
ledger.append({requestKey:"before-day",timestamp:"2026-08-28T15:59:59Z",provider:"mock",model:"m",feature:"chat",usage:{prompt_tokens:1,completion_tokens:1}});
ledger.append({requestKey:"after-day",timestamp:"2026-08-28T16:00:01Z",provider:"mock",model:"m",feature:"chat",usage:{prompt_tokens:1,completion_tokens:1}});
ledger.append({requestKey:"before-month",timestamp:"2026-07-31T15:59:59Z",provider:"mock",model:"m",feature:"chat",usage:{prompt_tokens:1,completion_tokens:1}});
ledger.append({requestKey:"month-start",timestamp:"2026-07-31T16:00:01Z",provider:"mock",model:"m",feature:"chat",usage:{prompt_tokens:1,completion_tokens:1}});
assert.equal(ledger.snapshot().today.requests,1,"Beijing Today excludes the prior Beijing date");
assert.equal(ledger.snapshot().month.requests,3,"Beijing August includes only the UTC July record after local midnight");
assert.equal(ledger.snapshot().todayUtcRange.start,"2026-08-28T16:00:00.000Z");

const { SchedulerStore,nextCronAfter }=await import("../src/scheduler.js");
clock=new Date("2026-08-28T10:00:00Z");const scheduler=new SchedulerStore({file:path.join(root,"scheduler.json"),now:()=>clock,executor:async()=>{}});
const once=scheduler.create({title:"北京时间一次提醒",schedule:{type:"once",at:"2026-08-28T20:00"},target:{type:"conversation",content:"提醒"}});
assert.equal(once.schedule.at,"2026-08-28T12:00:00.000Z");assert.equal(once.schedule.timeZone,"Asia/Shanghai");
assert.equal(nextCronAfter("0 21 * * *",new Date("2026-08-28T12:59:00Z")),"2026-08-28T13:00:00.000Z");
const schedulerRestart=new SchedulerStore({file:path.join(root,"scheduler.json"),now:()=>clock,executor:async()=>{}});assert.equal(schedulerRestart.snapshot().plans[0].schedule.timeZone,"Asia/Shanghai");

const { ensureDefaultPersona }=await import("../src/persona.js");ensureDefaultPersona();
const { appendIncomingMessagesDetailed,db,getOrCreateSession,getPreviousRealInteraction,insertMessage }=await import("../src/db.js");
const session=getOrCreateSession("yuna","chat","time-test");
insertMessage(session.id,"chat",{role:"user",content:"第一条"});
insertMessage(session.id,"chat",{role:"assistant",content:"第一条最终回复"});
insertMessage(session.id,"chat",{role:"assistant",content:"",tool_calls:[{id:"call_1",type:"function",function:{name:"x",arguments:"{}"}}]});
insertMessage(session.id,"chat",{role:"tool",content:"tool output",tool_call_id:"call_1"});
const previous=getPreviousRealInteraction(session.id);assert.ok(previous.user&&previous.assistant);const priorUserId=previous.user.id,priorAssistantId=previous.assistant.id;
const inserted=appendIncomingMessagesDetailed(session.id,"chat",[{role:"user",content:"第二条"}]);assert.equal(inserted.count,1);
assert.equal(previous.user.id,priorUserId,"captured previous user is not overwritten by current insert");
const after=getPreviousRealInteraction(session.id);assert.equal(after.user.id,inserted.messages[0].id);assert.equal(after.assistant.id,priorAssistantId,"tool and interim tool-call assistant do not replace final assistant interaction");

const { GuidanceQueueStore }=await import("../src/guidance-queue.js");const queue=new GuidanceQueueStore({file:path.join(root,"queue.json"),now:()=>clock,emit:()=>{}});queue.enqueue(session.id,"真实 guidance");assert.equal(getPreviousRealInteraction(session.id).user.id,inserted.messages[0].id,"queued guidance does not overwrite normal user interaction");

const { TemporalContextStore,buildTimeContext }=await import("../src/temporal-context.js");
clock=new Date("2026-08-28T12:00:00Z");const temporalFile=path.join(root,"activity.json"),temporal=new TemporalContextStore({file:temporalFile,timeService:time});
const activity=temporal.observe({sessionId:session.id,text:"我从晚上 8 点学到 9 点",sourceMessageId:inserted.messages[0].id,at:clock});assert.equal(activity.status,"in_progress");assert.equal(activity.startAt,"2026-08-28T12:00:00.000Z");assert.equal(activity.plannedUntil,"2026-08-28T13:00:00.000Z");
clock=new Date("2026-08-28T12:30:00Z");const cancelled=temporal.observe({sessionId:session.id,text:"我不学了",sourceMessageId:inserted.messages[0].id+1,at:clock});assert.equal(cancelled.status,"unknown");assert.ok(cancelled.cancelledAt);assert.equal(cancelled.sourceMessageId,inserted.messages[0].id,"original explicit activity provenance remains intact");
const restartedTemporal=new TemporalContextStore({file:temporalFile,timeService:time});assert.equal(restartedTemporal.current(session.id).status,"unknown","session temporal state survives restart");
const context=buildTimeContext({timeService:time,currentUserAt:clock,previousUser:{createdAt:"2026-08-28T12:00:00Z"},previousAssistant:{createdAt:"2026-08-28T12:01:00Z"},activity:cancelled});
assert.match(context,/Current local time: 20:30/);assert.match(context,/Timezone: Asia\/Shanghai/);assert.match(context,/Elapsed since previous real user message: 30 分钟/);assert.match(context,/does not prove.*completed/);assert.doesNotMatch(context,/completed_if_explicitly_confirmed/);
const beforeMemories=Number(db.prepare("SELECT COUNT(*) count FROM memories").get().count);buildTimeContext({timeService:time,activity});assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM memories").get().count),beforeMemories,"time context and temporary activity never write Shared Memory");

const { buildInjectedMessages }=await import("../src/context.js");
const persona={id:"yuna",name:"Yuna",core_identity:"companion",personality:[],speaking_style:{tone:"natural",verbosity:"short",emoji_frequency:"low",rules:[]},mode_instructions:{chat:"chat",agent:"agent"},memory:{enabled:false,chat_retrieval_limit:0,agent_retrieval_limit:0}};
const injected=await buildInjectedMessages({persona,ctx:{mode:"chat"},sessionId:session.id,clientMessages:[{role:"user",content:"你好"}],timeContext:context});assert.equal(injected.at(-1).content,context,"dynamic time context is the late prompt layer");assert.equal(injected.filter(message=>message.content===context).length,1);

fs.rmSync(root,{recursive:true,force:true});console.log("time-awareness-test: ok");
