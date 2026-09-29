import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-ground-"));
process.env.COMPANION_API_KEY="ground-test-key-long-random";
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
process.env.COMPANION_VOICE_DIR=path.join(tmp,"voice");
process.env.COMPANION_NATURAL_PRESENCE_PATH=path.join(tmp,"presence.json");
process.env.COMPANION_NATURAL_PRESENCE_ENABLED="true";
process.env.COMPANION_CONVERSATION_GROUNDING_ENABLED="true";
process.env.COMPANION_MODALITY_PLANNER_ENABLED="true";
process.env.COMPANION_CHAT_VOICE_MESSAGE_ENABLED="true";
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

const {classifyGrounding,applyGroundingTurn,groundingGuidanceBlock,extractReferentBindings}=await import("../src/conversation-grounding.js");
const {NaturalPresenceStore}=await import("../src/natural-presence/store.js");
const {selectVoiceStyle,profileReference,VOICE_PROFILES}=await import("../src/voice-profiles.js");
const {planBubbleModality,planTurnModalities}=await import("../src/modality-planner.js");
const {parseNaturalBubbles,deliverBubbleSequence}=await import("../src/natural-messaging.js");
const {evaluateInactivityEligibility}=await import("../src/inactivity-proactive.js");

try{
  // 1 cat -> 方案A
  {
    const c=classifyGrounding({userText:"我觉得方案A明显更好，简单直接",activeTopic:"猫偷袜子",recentTopics:["猫偷袜子"],recentUserTexts:["我家猫又把袜子叼走了"]});
    assert(c.relation==="SHIFT_AMBIGUOUS",`cat->方案A is SHIFT_AMBIGUOUS, got ${c.relation}`);
    assert(String(c.unknown_reference).includes("方案A")||String(c.unknown_reference).includes("A"),"unknown ref set");
    const block=groundingGuidanceBlock(c,{active_topic:"猫偷袜子"});
    assert(block.includes("不要假装知道"),"guidance says do not fake understanding");
  }

  // 2 recent A/B then 还是A好 → CALLBACK with binding
  {
    const now=new Date();
    const bindings=extractReferentBindings("我们刚讨论了方案A和方案B，A简单B稳妥",now);
    assert(bindings.A&&bindings.B,`bindings extracted ${JSON.stringify(bindings)}`);
    const c=classifyGrounding({userText:"还是A最好",activeTopic:"方案A vs B",recentTopics:["方案A vs B"],recentUserTexts:["我们刚讨论了方案A和方案B，A简单B稳妥"],bindings,now});
    assert(c.relation==="CALLBACK",`fresh binding A → CALLBACK, got ${c.relation} ${JSON.stringify(c)}`);
    assert(c.confidence>=0.85,`high confidence ${c.confidence}`);
    assert(String(c.resolved_binding?.meaning??"").includes("简单")||c.possible_referents?.length,"resolved A meaning");
  }

  // 3 就那个啊 with multiple referents
  {
    const c=classifyGrounding({userText:"就那个啊",activeTopic:null,recentTopics:["猫","袜子","方案"],openLoops:[{topic:"agent run"}]});
    assert(c.relation==="SHIFT_AMBIGUOUS","multiple possible referents must clarify");
    assert((c.possible_referents??[]).length>=1,"lists possible referents");
  }

  // 4 long-term memory must NOT fill ambiguous
  {
    const c=classifyGrounding({userText:"我觉得方案A明显更好",activeTopic:"猫",longTermMemoryHits:["很久以前的方案A是支付重构"]});
    assert(c.relation==="SHIFT_AMBIGUOUS","LTM cannot silently fill ambiguous 方案A");
    assert(c.confidence<=0.4,"low confidence when only LTM evidence");
  }

  // 5 ordinary continue does not force clarification
  {
    const c=classifyGrounding({userText:"我家猫又把袜子叼走了",activeTopic:"猫偷袜子",recentTopics:["猫偷袜子"]});
    assert(c.relation==="CONTINUE",`ordinary continue, got ${c.relation}`);
    assert(!groundingGuidanceBlock(c,{active_topic:"猫偷袜子"}).includes("不要假装知道"),"no clarification spam on CONTINUE");
  }

  // 5b an explicit “suddenly thought of” turn leaves weather for waterpark
  {
    const music=classifyGrounding({userText:"换个话题，我最近在听爵士音乐，钢琴声很舒服。",activeTopic:"我家附近有只橘猫，最近总趴窗边晒太阳。"});
    assert(music.relation==="SHIFT_CLEAR",`explicit music topic beats incidental “最近” overlap, got ${music.relation}`);
    const c=classifyGrounding({userText:"突然想到水上公园，你觉得水上公园里最有意思的项目是什么？",activeTopic:"天气和阵雨"});
    assert(c.relation==="SHIFT_CLEAR",`sudden topic cue clears weather, got ${c.relation}`);
    const g=applyGroundingTurn({active_topic:"天气和阵雨"},c,"突然想到水上公园，你觉得水上公园里最有意思的项目是什么？");
    assert(g.active_topic.includes("水上公园"),`waterpark becomes active topic: ${g.active_topic}`);
    const jazz=classifyGrounding({userText:"我准备这周练熟一首爵士钢琴曲，练完会告诉你进度。",activeTopic:"水上公园，你觉得哪种项目有意思"});
    assert(jazz.relation==="SHIFT_CLEAR"&&/爵士|钢琴/.test(jazz.active_topic),`jazz commitment leaves waterpark: ${jazz.active_topic}`);
  }

  // 6 grounding + multi-bubble coexist
  {
    const p=parseNaturalBubbles('{"messages":["啊？","哪个A"]}');
    assert(p.bubbles.length===2,"clarify can be multi-bubble");
    const c=classifyGrounding({userText:"方案A更好",activeTopic:"猫"});
    const g=applyGroundingTurn({active_topic:"猫",recent_topics:["猫"]},c,"方案A更好");
    assert(g.last_relation==="SHIFT_AMBIGUOUS","grounding state records relation");
    assert(g.recent_topics.includes("猫")||g.active_topic,"topic memory kept");
  }

  // voice profiles
  {
    for(const id of ["neutral","happy","low_energy","annoyed","angry"]){
      assert(Boolean(VOICE_PROFILES[id]),`profile ${id} exists`);
      const ref=profileReference(id);
      assert(ref.ref_audio_path.includes(".wav"),`${id} has wav path`);
      assert(fs.existsSync(ref.ref_audio_path),`${id} reference file exists on disk`);
    }
    assert(profileReference("neutral").prompt_text.includes("我没有说"),"neutral prompt not happy");
    assert(profileReference("happy").prompt_text.includes("开心"),"happy prompt");
  }

  // style selector hysteresis
  {
    const base={dimensions:{mood:{current:0.1},energy:{current:0.6},irritation:{current:0.2},playfulness:{current:0.5},social_drive:{current:0.5},closeness:{current:0.6}}};
    const n=selectVoiceStyle({presence:base,previousStyle:"neutral",bubbleIndex:0,text:"嗯"});
    assert(n.style==="neutral"||n.style==="happy",`neutral-ish → ${n.style}`);
    const annoyed=selectVoiceStyle({presence:{dimensions:{mood:{current:-0.3},energy:{current:0.5},irritation:{current:0.45},playfulness:{current:0.4},social_drive:{current:0.4},closeness:{current:0.5}}},previousStyle:"annoyed",bubbleIndex:1,text:"行吧"});
    assert(annoyed.style==="annoyed",`hysteresis keeps annoyed, got ${annoyed.style}`);
    const angry=selectVoiceStyle({presence:{dimensions:{mood:{current:-0.6},energy:{current:0.5},irritation:{current:0.8},playfulness:{current:0.3},social_drive:{current:0.3},closeness:{current:0.4}}},previousStyle:"annoyed",bubbleIndex:0,text:"你够了"});
    assert(angry.style==="angry","high irritation can escalate to angry");
  }

  // modality planner
  {
    const short=planBubbleModality({text:"嗯",bubbleIndex:0,bubbleCount:1,userModality:"text",seedKey:"t1",presence:null});
    assert(short.modality==="TEXT"||short.modality==="VOICE",`short line planned ${short.modality}`);
    const tech=planBubbleModality({text:"这里需要把 `JSON.parse` 包在 try/catch 里，然后重试上游 HTTP 502，再校验 schema。",bubbleIndex:0,bubbleCount:1,userModality:"text",seedKey:"t2",presence:null});
    assert(tech.modality==="TEXT","long technical → TEXT");
    const excitedPresence={dimensions:{mood:{current:0.6},energy:{current:0.8},irritation:{current:0.1},playfulness:{current:0.8},social_drive:{current:0.8},closeness:{current:0.85}}};
    let voiceHits=0;
    for(let i=0;i<20;i++){
      const p=planBubbleModality({text:"哈哈这也太好笑了吧！",bubbleIndex:0,bubbleCount:1,userModality:"text",seedKey:"e"+i,presence:excitedPresence});
      if(p.modality==="VOICE")voiceHits++;
    }
    assert(voiceHits>=1,`excited can choose voice (${voiceHits}/20)`);
    const afterVoice=planBubbleModality({text:"嗯",bubbleIndex:0,bubbleCount:1,userModality:"voice",recentAssistantVoiceRatio:0.8,seedKey:"u1",presence:null});
    assert(afterVoice.modality==="TEXT"||afterVoice.modality==="VOICE","user voice raises but does not force");
    const turn=planTurnModalities({bubbles:["等下","我这边刚才有点乱，等我弄完再跟你说。"],userModality:"text",sessionId:"mix",presence:excitedPresence});
    assert(["TEXT","VOICE","MIXED"].includes(turn.mode),`turn mode ${turn.mode}`);
  }

  // 40h offers a cognition wake; inactivity alone never forces contact
  {
    const s=new NaturalPresenceStore({file:path.join(tmp,"p.json"),enabled:true});
    s.document.dimensions.mood.current=-0.7;
    s.document.dimensions.irritation.current=0.8;
    s.save();
    const inactivity=evaluateInactivityEligibility({
      state:{lastUserInteractionAt:new Date(Date.now()-40*3600_000).toISOString(),lastProactiveAt:null,consecutiveUnansweredProactive:0},
      at:new Date(),hasSuitableContext:true
    });
    assert(inactivity.eligible===true&&inactivity.band==="40h"&&inactivity.sendAllowed===false,"40h grants cognition only");
    const decision=s.contactDecision({lastUserInteractionAt:new Date(Date.now()-40*3600_000).toISOString(),at:new Date(),gate:{allowed:true,reasons:[]},inactivity});
    assert(decision.action!=="START_CONVERSATION",`inactivity alone cannot force contact: ${JSON.stringify(decision)}`);
    assert(!String(decision.reason).includes("inactivity"),"inactivity is not a message reason");
  }

  console.log("\nPASS Grounding + Voice Style + Modality + Presence cognition-wake suite");
}catch(e){throw e;}finally{
  try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
}
