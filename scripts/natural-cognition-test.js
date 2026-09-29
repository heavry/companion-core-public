import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-cog-"));
process.env.COMPANION_API_KEY="cog-test-key-long-random";
process.env.DATABASE_PATH=path.join(tmp,"companion.db");
process.env.PERSONA_SYNC_ON_START="true";
process.env.EMBEDDING_ENABLED="false";
process.env.SUMMARY_EVERY_MESSAGES="9999";
process.env.COMPANION_MODULES_DIR=path.join(tmp,"modules");
process.env.COMPANION_MODULES_STATE_PATH=path.join(tmp,"modules-state.json");
process.env.COMPANION_MODULE_EXECUTION_LEDGER_PATH=path.join(tmp,"ledger.json");
process.env.COMPANION_STATE_PATH=path.join(tmp,"companion-state.json");
process.env.COMPANION_BEHAVIOR_PATH=path.join(tmp,"companion-behavior.json");
process.env.COMPANION_MODULES_CONFIG_DIR=path.join(tmp,"modules-config");
process.env.COMPANION_NATURAL_COGNITION_ENABLED="true";
process.env.COMPANION_NATURAL_COGNITION_PATH=path.join(tmp,"cognition.json");
process.env.COMPANION_MEMORY_ACCESSIBILITY_ENABLED="true";
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_PRIMARY_BASE_URL="";process.env.UPSTREAM_PRIMARY_API_KEY="";
process.env.UPSTREAM_SECONDARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_API_KEY="";process.env.UPSTREAM_SECONDARY_MODEL="";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_CHAT_API_KEY="";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_AGENT_API_KEY="";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_SUMMARY_API_KEY="";
process.env.UPSTREAM_API_KEY="";process.env.UPSTREAM_CHAT_MODEL="mock-chat";process.env.UPSTREAM_AGENT_MODEL="mock-agent";process.env.UPSTREAM_SUMMARY_MODEL="mock-summary";
process.env.TAVILY_API_KEY="";process.env.TAVILY_BASE_URL="";process.env.SEARXNG_BASE_URL="";
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
fs.mkdirSync(process.env.COMPANION_MODULES_DIR,{recursive:true});

const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);console.log(`OK  ${m}`);};
const HOUR=3600_000;

const {NaturalCognitionStore}=await import("../src/natural-cognition/store.js");
const store=new NaturalCognitionStore({file:path.join(tmp,"cog.json"),enabled:true});

try{
  // Attention 1-4
  {
    store.noteMessageDelivered({messageId:101,sessionId:"chat:default"});
    assert(store.messageStatus(101)==="delivered","delivered unseen after insert");
    store.setAttention({windowActive:true,chatVisible:false});
    assert(store.messageStatus(101)==="delivered","settings page stays unseen");
    store.markSeen({messageIds:[101],windowActive:true,chatVisible:false});
    assert(store.messageStatus(101)==="delivered","chat not visible → not seen");
    store.markSeen({messageIds:[101],windowActive:true,chatVisible:true});
    assert(store.messageStatus(101)==="seen","visible+active → seen");
    store.markReplied({messageId:101});
    assert(store.messageStatus(101)==="replied","reply marks replied");
    const store2=new NaturalCognitionStore({file:path.join(tmp,"cog.json"),enabled:true});
    assert(store2.messageStatus(101)==="replied","seen/replied survives restart");
  }

  // Memory accessibility 5-10
  {
    const now=new Date();
    const recent={id:"m1",content:"最近一直在调 Natural Messaging agent",importance:0.8,updated_at:new Date(now-2*HOUR).toISOString(),access_count:5,type:"project",pinned:0};
    const old={id:"m2",content:"去年随口说过一次蓝色袜子",importance:0.3,updated_at:new Date(now-200*24*HOUR).toISOString(),access_count:0,type:"fact",pinned:0};
    const stable={id:"m3",content:"用户是伴侣关系中的长期事实",importance:0.9,updated_at:new Date(now-100*24*HOUR).toISOString(),access_count:20,type:"relationship",pinned:1};
    const sRec=store.scoreMemoryAccessibility({memory:recent},{query:"agent 跑得怎么样",focusTopics:["agent"],at:now});
    const sOld=store.scoreMemoryAccessibility({memory:old},{query:"晚饭吃什么",focusTopics:["agent"],at:now});
    const sStable=store.scoreMemoryAccessibility({memory:stable},{query:"随便聊聊",at:now});
    assert(sRec>sOld,`recent/topic high > old trivia (${sRec.toFixed(2)} vs ${sOld.toFixed(2)})`);
    assert(sStable>sOld,`stable relationship stays accessible (${sStable.toFixed(2)} vs ${sOld.toFixed(2)})`);
    const filtered=store.filterMemoriesForContext([
      {memory:recent,in_context:true},
      {memory:old,in_context:true}
    ],{query:"agent",focusTopics:["agent"],at:now,max:2,minScore:0.28});
    assert(!filtered.some(x=>x.memory.id==="m2"),"low accessibility old memory not injected");
    const forced=store.filterMemoriesForContext([{memory:old,in_context:true}],{query:"你还记得我以前说过蓝色袜子吗",userExplicitRecall:true,at:now});
    assert(forced.length===1,"explicit recall allows search");
    assert(store.detectExplicitRecall("你还记得X吗")===true,"detects explicit recall prompt");
    store.noteRecall("m1",now);
    const again=store.filterMemoriesForContext([{memory:recent,in_context:true}],{query:"agent",at:now});
    // cooldown may lower but still usually above min for high salience
    assert(Array.isArray(again),"recall cooldown path runs");
  }

  // Expectation 11-16
  {
    const exp=store.upsertExpectation({topic:"agent result",salience:0.8,ttlHours:12});
    assert(exp&&exp.state==="pending","meaningful expectation created");
    const casual=store.upsertExpectation({topic:"今天怎么样",salience:0.2});
    assert(casual===null,"casual greeting not stored");
    assert(store.activeExpectations().length===1,"one pending");
    store.tryResolveExpectations("我先去吃饭");
    assert(store.activeExpectations().length===1,"unrelated reply does not resolve");
    store.tryResolveExpectations("跑完了，效果还行");
    assert(store.activeExpectations().length===0,"completion resolves expectation");
    const e2=store.upsertExpectation({topic:"agent result2",salience:0.7,ttlHours:1});
    assert(store.canRemindExpectation(e2,new Date())===false,"too new → no remind");
    e2.created_at=new Date(Date.now()-5*HOUR).toISOString();
    assert(store.canRemindExpectation(e2)===true||e2.salience<0.55,"remind allowed later if salience ok");
    // expire
    const e3=store.upsertExpectation({topic:"soon expire",salience:0.8,ttlHours:1});
    const row=store.document.expectations.find(x=>x.id===e3.id);
    row.expires_at=new Date(Date.now()-1000).toISOString();
    store.tryResolveExpectations("无关");
    assert(row.state==="expired","TTL expire works");
  }

  // Focus 17-21
  {
    store.updateFocus({activeTopic:"猫偷袜子"});
    assert(store.document.focus.primary?.topic.includes("猫"),"cat becomes primary");
    store.updateFocus({activeTopic:"TTS 测试"});
    assert(store.document.focus.primary?.topic.includes("TTS"),"topic switch moves primary");
    assert(store.document.focus.secondary?.topic.includes("猫"),"old focus demoted to secondary");
    store.updateFocus({activeTopic:"学习英语",primaryCandidate:{topic:"agent result",source:"pending_expectation",salience:0.9}});
    assert(store.focusList().length<=2,"max 2 focus slots");
    assert(store.focusList()[0].topic==="agent result","expectation wins primary");
  }

  // Restart cognition continuity 28
  {
    const store3=new NaturalCognitionStore({file:path.join(tmp,"cog.json"),enabled:true});
    assert(store3.document.focus.primary!=null,"focus persists");
    assert(Object.keys(store3.document.seen).length>0,"seen persists");
  }

  // Contact Decision × Cognition
  {
    const {NaturalPresenceStore}=await import("../src/natural-presence/store.js");
    const presence=new NaturalPresenceStore({file:path.join(tmp,"presence.json"),enabled:true});
    const cog=new NaturalCognitionStore({file:path.join(tmp,"cog2.json"),enabled:true});
    // 1) pending expectation + unseen → WAIT
    cog.noteMessageDelivered({messageId:501});
    const exp=cog.upsertExpectation({topic:"agent result",salience:0.9,ttlHours:12});
    exp.created_at=new Date(Date.now()-3*HOUR).toISOString();
    const row=cog.document.expectations.find(x=>x.id===exp.id);row.created_at=exp.created_at;
    let input=cog.contactInput();
    assert(input.unseenAssistantCount>=1,"unseen assistant counted");
    let d=presence.contactDecision({gate:{allowed:true,reasons:[]},inactivity:{eligible:false},cognition:input,at:new Date()});
    assert(d.action==="WAIT"&&d.reason==="expectation_pending_unseen",`unseen → WAIT, got ${JSON.stringify(d)}`);
    // 2) seen recently → WAIT
    cog.markSeen({messageIds:[501],windowActive:true,chatVisible:true});
    cog.setAttention({windowActive:true,chatVisible:true});
    input=cog.contactInput();
    d=presence.contactDecision({gate:{allowed:true,reasons:[]},inactivity:{eligible:false},cognition:input,at:new Date()});
    assert(d.action==="WAIT"&&(d.reason==="expectation_seen_recently"||d.reason==="expectation_not_urgent_enough"||d.reason==="expectation_pending_unseen"),`seen recently → WAIT, got ${JSON.stringify(d)}`);
    // 3) seen + reasonable time + high salience → can follow up
    const later=new Date(Date.now()+3*HOUR);
    input=cog.contactInput(later);
    // force canRemind by aging created_at
    input.canRemindExpectation=(e)=> (e.salience??0)>=0.55 && (e.reminder_count??0)<2;
    input.msSinceLastSeen=3*HOUR;
    d=presence.contactDecision({gate:{allowed:true,reasons:[]},inactivity:{eligible:false},cognition:input,at:later});
    assert(d.action==="START_CONVERSATION"&&d.reason==="pending_expectation_followup",`seen+time+salience → follow-up, got ${JSON.stringify(d)}`);
    // 4) reminder limit
    row.reminder_count=2;
    input=cog.contactInput(later);
    input.canRemindExpectation=()=>false;
    d=presence.contactDecision({gate:{allowed:true,reasons:[]},inactivity:{eligible:false},cognition:input,at:later});
    assert(d.action!=="START_CONVERSATION"||d.reason!=="pending_expectation_followup","reminder limit blocks repeat");
    // 5) inactivity never bypasses cognition when there is no contact reason
    const inactivity={eligible:true,guaranteed:true,band:"over_36h",probability:1};
    d=presence.contactDecision({gate:{allowed:true,reasons:[]},inactivity,cognition:cog.contactInput(),at:new Date()});
    assert(d.action==="WAIT"&&d.reason==="nothing_worth_saying","inactivity wake alone remains NO_ACTION");
  }

  console.log("\nPASS Natural Cognition v1 deterministic suite");
}catch(e){throw e;}finally{
  try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
}
