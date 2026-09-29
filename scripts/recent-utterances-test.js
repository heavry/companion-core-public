import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-utter-"));
process.env.COMPANION_API_KEY="utter-test-key-long-random";
process.env.DATABASE_PATH=path.join(tmp,"companion.db");
process.env.PERSONA_SYNC_ON_START="true";
process.env.EMBEDDING_ENABLED="false";
process.env.COMPANION_MODULES_DIR=path.join(tmp,"modules");
process.env.COMPANION_MODULES_STATE_PATH=path.join(tmp,"ms.json");
process.env.COMPANION_MODULE_EXECUTION_LEDGER_PATH=path.join(tmp,"led.json");
process.env.COMPANION_STATE_PATH=path.join(tmp,"st.json");
process.env.COMPANION_BEHAVIOR_PATH=path.join(tmp,"bh.json");
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
fs.mkdirSync(tmp,{recursive:true});

const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);console.log(`OK  ${m}`);};
const { RecentUtteranceStore, classifyRecurrence, recurrenceContextBlock, detectAndRecordUtterance }=await import("../src/recent-utterances/index.js");
const { RecentEpisodeStore }=await import("../src/recent-episodes/store.js");
const { ContactSuppressionStore }=await import("../src/contact-suppression.js");

const idx=new RecentUtteranceStore({file:path.join(tmp,"u.json")});
const noodle="宝宝出去吃面了，我妈花的钱嘿嘿没花钱";
const play="那宝贝去玩了，姐姐休息会去吧";
const t0=new Date("2026-09-13T12:29:40Z");
const t3h=new Date("2026-09-13T15:01:14Z");

try{
  idx.record({messageId:1497,text:noodle,sessionId:"chat:default",at:t0});
  const a=classifyRecurrence(noodle,{now:t3h,index:idx});
  assert(a.kind==="EXACT_REPEAT"&&a.skipSideEffects,"A exact repeat 3h");
  const block=recurrenceContextBlock(a,t3h,{acknowledgedFacts:["用户出去吃面"]});
  assert(/不要当成第一次/.test(block)&&/already acknowledged/.test(block)&&/不要只回/.test(block),"A generation must not treat as first-time");

  idx.record({messageId:1516,text:play,sessionId:"chat:default",at:new Date("2026-09-13T12:43:55Z")});
  const b=classifyRecurrence(play,{now:new Date("2026-09-13T15:12:43Z"),index:idx});
  assert(b.kind==="EXACT_REPEAT"&&b.skipSideEffects,"B play exact repeat");

  idx.record({messageId:10,text:"我去喝水",at:t0});
  const c=classifyRecurrence("我去喝水",{now:t3h,index:idx});
  assert(c.kind==="REPEATED_EVENT_POSSIBLE"&&!c.skipSideEffects,"C 喝水 may be new event");

  idx.record({messageId:11,text:"我好累",at:t0});
  const d=classifyRecurrence("我好累",{now:new Date(t0.getTime()+8_000),index:idx});
  assert(d.kind==="EMPHASIS_REPEAT"&&d.skipSideEffects,"D 10s 我好累 is emphasis");

  const e=classifyRecurrence("宝宝我刚才不是说去吃面嘛",{now:t3h,index:idx});
  assert(e.kind==="CALLBACK"&&!e.skipSideEffects,"E callback not duplicate");

  const f=classifyRecurrence("我又出去吃面了",{now:t3h,index:idx});
  assert(f.kind==="REPEATED_EVENT"&&!f.skipSideEffects,"F 又去 is new occurrence");

  const ep=new RecentEpisodeStore({file:path.join(tmp,"ep.json")});
  ep.observe({text:noodle,role:"user",messageId:1497,at:t0});
  const beforeEp=structuredClone(ep.list(t3h)[0]);
  if(!a.skipSideEffects)ep.observe({text:noodle,role:"user",messageId:1544,at:t3h});
  const afterEp=ep.list(t3h)[0];
  assert(afterEp?.source_message_id===1497&&afterEp?.known?.meal===beforeEp?.known?.meal,"G duplicate does not recreate Recent Episode");
  const cs=new ContactSuppressionStore({file:path.join(tmp,"cs.json")});
  cs.observeUser({text:play,messageId:1516,at:t0});
  cs.observeAssistant({text:"嗯，去玩。姐姐歇着。",at:new Date(t0.getTime()+90_000)});
  assert(cs.active(new Date(t0.getTime()+2*60_000))?.kind==="play","G first leave arms suppression");
  cs.observeUser({text:play,messageId:1547,at:t3h,armLeave:!b.skipSideEffects});
  assert(!cs.state.pending&&!cs.active(t3h),"G exact duplicate does not re-arm Closure suppression");

  idx.record({messageId:1497,text:noodle,sessionId:"chat:default",at:t0});
  const idx2=new RecentUtteranceStore({file:path.join(tmp,"u.json")});
  const h=classifyRecurrence(noodle,{now:t3h,index:idx2});
  assert(h.kind==="EXACT_REPEAT","H persist across reload");
  assert(idx2.list(t3h).some(u=>u.message_id===1497),"I utterance index independent of summary window");
  const expired=classifyRecurrence(noodle,{now:new Date(t0.getTime()+30*3600_000),index:idx2});
  assert(expired.kind==="NEW","H TTL forgets");

  const j1=classifyRecurrence("宝宝",{now:t3h,index:idx});
  idx.record({messageId:20,text:"宝宝",at:t0});
  const j2=classifyRecurrence("宝宝",{now:new Date(t0.getTime()+5000),index:idx});
  assert(j1.kind==="NEW"&&j2.kind==="NEW","J short 宝宝 does not over-trigger");

  const near=classifyRecurrence("宝宝出去吃面了，我妈花的钱嘿嘿一分没花",{now:t3h,index:idx});
  assert(near.kind==="NEAR_REPEAT"&&near.skipSideEffects,"near-repeat still skips first-time overwrite");

  console.log("PASS recent utterances");
}finally{
  fs.rmSync(tmp,{recursive:true,force:true});
}
