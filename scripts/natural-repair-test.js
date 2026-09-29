import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-repair-"));
process.env.COMPANION_API_KEY="repair-test-key-long-random";
process.env.DATABASE_PATH=path.join(tmp,"companion.db");
process.env.PERSONA_SYNC_ON_START="true";
process.env.EMBEDDING_ENABLED="false";
process.env.COMPANION_MODULES_DIR=path.join(tmp,"modules");
process.env.COMPANION_MODULES_STATE_PATH=path.join(tmp,"modules-state.json");
process.env.COMPANION_MODULE_EXECUTION_LEDGER_PATH=path.join(tmp,"ledger.json");
process.env.COMPANION_STATE_PATH=path.join(tmp,"companion-state.json");
process.env.COMPANION_BEHAVIOR_PATH=path.join(tmp,"behavior.json");
process.env.COMPANION_NATURAL_PRESENCE_PATH=path.join(tmp,"presence.json");
process.env.COMPANION_NATURAL_COGNITION_PATH=path.join(tmp,"cognition.json");
process.env.COMPANION_NATURAL_REPAIR_ENABLED="true";
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_PRIMARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_BASE_URL="";
process.env.TAVILY_API_KEY="";process.env.SEARXNG_BASE_URL="";
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
fs.mkdirSync(process.env.COMPANION_MODULES_DIR,{recursive:true});

const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);console.log(`OK  ${m}`);};

const { ensureDefaultPersona }=await import("../src/persona.js");
ensureDefaultPersona();
const { insertMemory, listMemoriesAdmin }=await import("../src/db.js");
const { classifyGrounding }=await import("../src/conversation-grounding.js");
const { classifyRepair, replyHasSpeakerInversion }=await import("../src/natural-repair/detect.js");
const { RepairStore, applyRepairToGrounding, processUserRepair, repairGuidanceBlock }=await import("../src/natural-repair/index.js");
const { insertDiaryEntry }=await import("../src/natural-diary/store.js");
const { buildInjectedMessages }=await import("../src/context.js");
const { requirePersona }=await import("../src/persona.js");

const store=new RepairStore({dir:path.join(tmp,"repair")});

try{
  // A referent TTS → Agent, then 那个 = Agent
  {
    const c=classifyRepair({userText:"不是，我说的是昨天那个 Agent。",lastAssistantText:"你说的是那个 TTS 吧？",activeTopic:"TTS"});
    assert(c.detected&&c.type==="REFERENT_CORRECTION",`A type ${c.type}`);
    assert(/Agent/i.test(c.corrected_interpretation),"A to=Agent");
    const rec=store.add("sA",c);
    const g=applyRepairToGrounding({active_topic:"TTS",recent_referents:["TTS"]},rec);
    assert(g.active_topic.includes("Agent"),"A grounding topic Agent");
    const next=classifyGrounding({userText:"那个跑完了吗",activeTopic:g.active_topic,recentReferents:g.recent_referents,bindings:g.bindings,repair:rec});
    assert(next.relation==="CALLBACK"&&/Agent/i.test(String(next.resolved_binding?.meaning||next.active_topic)),`A 那个=Agent got ${JSON.stringify(next)}`);
  }

  // B 昨天 → 前天
  {
    const c=classifyRepair({userText:"不是昨天，是前天。",lastAssistantText:"昨天你说过。",activeTopic:"昨天"});
    assert(c.detected&&c.type==="FACT_CORRECTION","B fact");
    assert(c.original_interpretation==="昨天"&&c.corrected_interpretation==="前天","B swap dates");
  }

  // C intent
  {
    const c=classifyRepair({userText:"我没让你改，我只是问问。",lastAssistantText:"那我帮你改。",activeTopic:"改配置"});
    assert(c.detected&&c.type==="INTENT_CORRECTION"&&c.intent==="informational","C informational");
  }

  // Speaker ownership A–F
  {
    const intent=classifyRepair({userText:"我没让你改，我只是问问。",lastAssistantText:"那我帮你改。",activeTopic:"前天那个 Agent"});
    assert(intent.correction_source==="user"&&intent.corrected_subject==="user","A ownership user");
    assert(intent.requested_action==="none"&&intent.corrected_intent==="informational","A informational none");
    const ig=repairGuidanceBlock(intent);
    assert(/用户只是在询问/.test(ig),"A guidance is semantic");
    assert(!/我只是问问/.test(ig),"A guidance does not echo user 我只是问问");
    assert(replyHasSpeakerInversion("哦，明白了，我没改，就是在问问前天的那个Agent跑完了没。",intent),"A flags inverted reply");
    assert(!replyHasSpeakerInversion("哦，懂了，你只是问问。那我只跟你说情况，不动它。",intent),"A accepts remapped reply");
  }
  {
    const c=classifyRepair({userText:"我说的是 CosyVoice，不是 Voicebox",lastAssistantText:"Voicebox 那个对吧？",activeTopic:"Voicebox"});
    assert(c.detected&&/CosyVoice/i.test(c.corrected_interpretation),"B to CosyVoice");
    const g=repairGuidanceBlock(c);
    assert(/你说的是 CosyVoice/.test(g),"B tells model 你说的是");
    assert(replyHasSpeakerInversion("我说的是 CosyVoice。",c),"B flags 我说的是 CosyVoice");
    assert(!replyHasSpeakerInversion("哦，你说的是 CosyVoice。",c),"B accepts 你说的是");
  }
  {
    const c=classifyRepair({userText:"你刚才记错了",lastAssistantText:"你养了猫。"});
    assert(c.detected&&c.corrected_subject==="assistant"&&c.error_owner==="assistant","C error owner is assistant");
  }
  {
    const c=classifyRepair({userText:"我昨天没去，是前天去的",lastAssistantText:"你昨天去了。"});
    assert(c.detected&&c.actor==="user"&&c.original_interpretation==="昨天"&&c.corrected_interpretation==="前天","D user went 前天");
    assert(replyHasSpeakerInversion("我前天去的。",c),"D flags assistant as the one who went");
    assert(!replyHasSpeakerInversion("你是前天去的，不是昨天。",c),"D accepts user as actor");
  }
  {
    const c=classifyRepair({userText:"不是你，是我弄的",lastAssistantText:"这是我改的。",activeTopic:"配置"});
    assert(c.detected&&c.actor==="user"&&c.corrected_subject==="user","E actor=user");
  }
  {
    const c=classifyRepair({userText:"不是我，是你刚才说的",lastAssistantText:"这是你说的。"});
    assert(c.detected&&c.actor==="assistant"&&c.corrected_subject==="assistant","F actor=assistant");
  }

  // D memory correction does not delete
  {
    insertMemory({personaId:"yuna",content:"用户养了一只猫",type:"fact",importance:0.8,status:"active",source:"manual"});
    const before=listMemoriesAdmin({personaId:"yuna",status:"all",limit:20}).length;
    const c=classifyRepair({userText:"我没养猫，你记错了。",lastAssistantText:"你家猫还好吗？",activeTopic:"猫"});
    assert(c.detected&&c.type==="MEMORY_CORRECTION","D type");
    assert(c.suppressTopics.includes("猫"),"D suppress 猫");
    const after=listMemoriesAdmin({personaId:"yuna",status:"all",limit:20}).length;
    assert(after===before,"D does not delete memories");
    const injected=await buildInjectedMessages({
      persona:requirePersona("yuna"),ctx:{mode:"chat"},sessionId:"none",
      clientMessages:[{role:"user",content:"猫怎么样了"}],
      memorySuppressTopics:["猫"]
    });
    const memBlock=injected.filter(m=>m.role==="system").map(m=>m.content).join("\n");
    assert(!/养了一只猫/.test(memBlock),"D suppressed memory not injected");
  }

  // E diary correction retrieval
  {
    insertDiaryEntry({personaId:"yuna",dateLocal:"2026-09-12",body:"今天在测语音，没写打游戏。",summary:"测语音",sourceStartAt:new Date().toISOString(),sourceEndAt:new Date().toISOString()});
    const c=classifyRepair({userText:"你昨天日记是不是写我打游戏了？",lastAssistantText:"日记里写了你打游戏。"});
    assert(c.detected&&c.type==="DIARY_CORRECTION","E diary type");
    const processed=processUserRepair({sessionId:"sE",userText:"你日记里根本没写这个。",lastAssistantText:"日记写了打游戏",personaId:"yuna"});
    assert(processed.detected&&processed.guidance.includes("不要编"),"E guidance says do not invent");
  }

  // F vague 不对 with two errors → clarification
  {
    const c=classifyRepair({userText:"不对。",lastAssistantText:"Voicebox 昨天那个",activeTopic:"Voicebox",recentReferents:["Agent","Voicebox"]});
    assert(c.detected&&c.needsClarification&&c.type==="AMBIGUOUS_CORRECTION","F clarify");
    const g=classifyGrounding({userText:"不对。",activeTopic:"Voicebox",recentReferents:["Agent","Voicebox"],repair:c});
    assert(g.relation==="SHIFT_AMBIGUOUS","F grounding ambiguous");
  }

  // G 不是吧哈哈 not repair
  {
    const c=classifyRepair({userText:"不是吧哈哈",lastAssistantText:"你说的是 TTS 吧？",activeTopic:"TTS"});
    assert(!c.detected,"G disbelief is not repair");
  }

  // H topic shift does not keep repair as 那个 forever after deactivate
  {
    const rec=store.add("sH",{type:"REFERENT_CORRECTION",original_interpretation:"TTS",corrected_interpretation:"Agent",confidence:0.9});
    store.deactivate("sH");
    const cur=store.current("sH");
    assert(!cur,"H deactivated current");
    const g=classifyGrounding({userText:"今天天气真好",activeTopic:"天气",repair:cur});
    assert(g.relation!=="CALLBACK"||g.note!=="fresh_repair","H weather is not repair callback");
  }

  // I persist across store reload
  {
    const rec=store.add("sI",{type:"FACT_CORRECTION",original_interpretation:"昨天",corrected_interpretation:"前天",confidence:0.9});
    const store2=new RepairStore({dir:path.join(tmp,"repair")});
    const loaded=store2.current("sI");
    assert(loaded&&loaded.corrected_interpretation==="前天","I restart persists session repair");
  }

  // J second correction overrides
  {
    store.add("sJ",{type:"REFERENT_CORRECTION",original_interpretation:"TTS",corrected_interpretation:"Agent",confidence:0.9});
    store.add("sJ",{type:"REFERENT_CORRECTION",original_interpretation:"Agent",corrected_interpretation:"CosyVoice",confidence:0.95});
    const cur=store.current("sJ");
    assert(cur.corrected_interpretation==="CosyVoice","J second wins");
    assert(store.list("sJ").length===1,"J only newest is active");
    const next=classifyGrounding({userText:"那个速度怎么样",repair:cur,activeTopic:cur.corrected_interpretation});
    assert(/CosyVoice/i.test(String(next.resolved_binding?.meaning||next.active_topic)),"J 那个=CosyVoice");
  }

  console.log("PASS natural repair v1");
}finally{
  fs.rmSync(tmp,{recursive:true,force:true});
}
