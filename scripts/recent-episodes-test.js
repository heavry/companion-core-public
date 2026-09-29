import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-episodes-"));
process.env.COMPANION_API_KEY="episode-test-key-long-random";
process.env.DATABASE_PATH=path.join(tmp,"companion.db");
process.env.PERSONA_SYNC_ON_START="true";
process.env.EMBEDDING_ENABLED="false";
process.env.COMPANION_MODULES_DIR=path.join(tmp,"modules");
process.env.COMPANION_MODULES_STATE_PATH=path.join(tmp,"ms.json");
process.env.COMPANION_MODULE_EXECUTION_LEDGER_PATH=path.join(tmp,"led.json");
process.env.COMPANION_STATE_PATH=path.join(tmp,"state.json");
process.env.COMPANION_BEHAVIOR_PATH=path.join(tmp,"behavior.json");
process.env.COMPANION_NATURAL_PRESENCE_PATH=path.join(tmp,"presence.json");
process.env.COMPANION_NATURAL_PRESENCE_ENABLED="true";
process.env.COMPANION_NATURAL_COGNITION_PATH=path.join(tmp,"cognition.json");
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
fs.mkdirSync(process.env.COMPANION_MODULES_DIR,{recursive:true});

const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);console.log(`OK  ${m}`);};
const { ensureDefaultPersona }=await import("../src/persona.js");
ensureDefaultPersona();
const { listMemoriesAdmin }=await import("../src/db.js");
const { naturalPresence }=await import("../src/natural-presence/index.js");
const { maybeCreateExpectation,onUserMessage,naturalCognition }=await import("../src/natural-cognition/index.js");
const { recentEpisodes, observeRecentEpisode, episodeContextBlock, contradictsKnownEpisode, rewriteProactiveTopic }=await import("../src/recent-episodes/index.js");

try{
  const t0=new Date("2026-09-13T12:29:40Z");
  observeRecentEpisode({text:"宝宝出去吃面了，我妈花的钱嘿嘿没花钱",role:"user",messageId:1497,at:t0});
  const dinner=recentEpisodes.list(t0).find(e=>e.topic==="dinner");
  assert(dinner&&dinner.known.meal==="noodles"&&dinner.known.meal_started,"A learned noodles");
  const later=new Date(t0.getTime()+20*60*1000);
  assert(contradictsKnownEpisode("宝贝晚饭吃了没，后来到底吃啥了",later),"A blocks 吃了没/吃啥");
  assert(!contradictsKnownEpisode("面吃得咋样，回来没？",later),"A allows quality/return follow-up");
  const rewritten=rewriteProactiveTopic("晚饭吃什么",later);
  assert(!rewritten.suppress&&/面/.test(rewritten.topic),"A proactive topic rewritten off 晚饭吃什么");

  observeRecentEpisode({text:"我去洗澡了。",role:"user",messageId:2,at:t0});
  assert(contradictsKnownEpisode("你在干嘛？",later),"B blocks 你在干嘛");
  assert(!contradictsKnownEpisode("洗完了没？",later),"B allows 洗完了没");

  observeRecentEpisode({text:"我去跑 Agent，一会回来。",role:"user",messageId:3,at:t0});
  const agent=recentEpisodes.list(t0).find(e=>e.topic==="agent");
  assert(agent&&agent.known.agent_running,"C agent episode");
  assert(contradictsKnownEpisode("你现在准备干嘛？",later),"C blocks generic 干嘛");
  assert(!contradictsKnownEpisode("那个测试跑完没？",later),"C allows 跑完没");

  observeRecentEpisode({text:"刚到家。",role:"user",messageId:4,at:t0});
  assert(contradictsKnownEpisode("到家了吗？",later),"D blocks 到家了吗");

  recentEpisodes.document.episodes=recentEpisodes.document.episodes.filter(e=>e.topic!=="dinner");
  observeRecentEpisode({text:"我没吃晚饭。",role:"user",messageId:5,at:t0});
  const skipped=recentEpisodes.list(t0).find(e=>e.topic==="dinner");
  assert(skipped?.known?.not_eaten,"E not_eaten");
  assert(!contradictsKnownEpisode("后来吃东西没？",later),"E can ask 后来吃东西没");
  const eHint=rewriteProactiveTopic("晚饭吃什么",later);
  assert(/后来吃/.test(eHint.topic),"E follow-up is later-ate");

  recentEpisodes.document.episodes=recentEpisodes.document.episodes.filter(e=>e.topic!=="dinner");
  const yesterday=new Date("2026-09-12T12:29:40Z");
  recentEpisodes.upsert({topic:"dinner",fact:"用户出去吃面",status:"in_progress",known:{meal:"noodles",meal_started:true},replace:true},yesterday);
  const nextAfternoon=new Date("2026-09-13T08:00:00Z");
  const nextDay=recentEpisodes.list(nextAfternoon).find(e=>e.topic==="dinner");
  assert(nextDay&&nextDay.stale&&nextDay.temporal_status==="past","F next day is past not current eating");
  const pastBlock=episodeContextBlock(nextAfternoon);
  assert(/不能当成现在仍在发生/.test(pastBlock),"F context warns not current");

  observeRecentEpisode({text:"宝宝出去吃面了",role:"user",messageId:6,at:t0});
  observeRecentEpisode({text:"算了没去，点了饭。",role:"user",messageId:7,at:later});
  const g=recentEpisodes.list(later).find(e=>e.topic==="dinner");
  assert(g.known.meal==="rice_or_takeout","G overwrite noodles with 点了饭");

  observeRecentEpisode({text:"不是，吃面。",role:"user",messageId:8,at:later});
  const h=recentEpisodes.list(later).find(e=>e.topic==="dinner");
  assert(h.known.meal==="noodles","H repair-like 吃面 overwrites");

  observeRecentEpisode({text:"面吃完了，挺饱的。",role:"user",messageId:9,at:later});
  const i=recentEpisodes.list(later).find(e=>e.topic==="dinner");
  assert(i.known.satiety==="full"&&i.status==="completed","I completed+full");
  assert(contradictsKnownEpisode("吃饱没？",later),"I blocks 吃饱没");

  const beforeMem=listMemoriesAdmin({personaId:"yuna",status:"all",limit:50}).length;
  observeRecentEpisode({text:"宝宝出去吃面了",role:"user",messageId:10,at:later});
  assert(listMemoriesAdmin({personaId:"yuna",status:"all",limit:50}).length===beforeMem,"no long-term memory write");

  naturalPresence.upsertOpenLoops([{topic:"晚饭吃什么",salience:0.7}],t0);
  observeRecentEpisode({text:"宝宝出去吃面了",role:"user",messageId:11,at:t0});
  assert(naturalPresence.document.open_loops.find(l=>l.topic==="晚饭吃什么")?.resolved,"dinner open loop resolved by known meal");

  const exp=maybeCreateExpectation({assistantText:"面吃得怎么样，饱了没。刚回来就跟我说一声。",userText:"好。",at:t0});
  assert(exp&&/面|饱/.test(exp.topic),"pending from 面吃得怎么样");
  const resolved=onUserMessage({text:"吃饱了宝宝",at:later});
  assert((resolved.resolvedExpectationIds||[]).length>=1||naturalCognition.document.expectations.some(e=>e.state==="satisfied"),"satiety can resolve meal pending");

  const store2=new (await import("../src/recent-episodes/store.js")).RecentEpisodeStore({file:path.join(tmp,"recent-episodes.json")});
  assert(store2.list(later).some(e=>e.topic==="dinner"),"J persist with TTL file");

  console.log("PASS recent episodes");
}finally{
  fs.rmSync(tmp,{recursive:true,force:true});
}
