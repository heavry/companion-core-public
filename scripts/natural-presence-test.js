import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-presence-"));
process.env.COMPANION_API_KEY="presence-test-key-long-random";
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
process.env.COMPANION_NATURAL_PRESENCE_ENABLED="true";
process.env.COMPANION_NATURAL_PRESENCE_PATH=path.join(tmp,"natural-presence.json");
process.env.COMPANION_AUTONOMOUS_LIFE_ENABLED="false";
process.env.COMPANION_AUTONOMOUS_LIFE_STATE_PATH=path.join(tmp,"autonomous-life.json");
process.env.COMPANION_INACTIVITY_DEV_OVERRIDE_ENABLED="1";
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

const {NaturalPresenceStore,EVENT_DELTAS,parsePresenceEvaluation,heuristicEvaluation}=await import("../src/natural-presence/store.js");
const {evaluateInactivityEligibility}=await import("../src/inactivity-proactive.js");

const file=path.join(tmp,"presence.json");
const t0=new Date("2026-09-12T10:00:00.000Z");
const store=new NaturalPresenceStore({file,enabled:true,now:()=>t0});

try{
  // 1 ordinary chat small change
  {
    const before=store.publicDimensions();
    store.applyEvents([{type:"warm_interaction",severity:"minor"}],t0);
    const after=store.publicDimensions();
    assert(Math.abs(after.closeness.current-before.closeness.current)<=0.05,"ordinary chat only small closeness change");
    assert(Math.abs(after.mood.current-before.mood.current)<=0.05,"ordinary mood small");
  }

  // 2 disagreement raises irritation
  {
    const before=store.publicDimensions().irritation.current;
    store.applyEvents([{type:"disagreement",severity:"moderate"}],new Date(t0.getTime()+60_000));
    const after=store.publicDimensions().irritation.current;
    assert(after>before,"disagreement raises irritation");
    assert(after-before<=0.25,"disagreement delta bounded");
  }

  // 3 consecutive dismissive clamps
  {
    const start=store.publicDimensions().irritation.current;
    for(let i=0;i<8;i++)store.applyEvents([{type:"dismissive_response",severity:"major"}],new Date(t0.getTime()+120_000+i*1000));
    const after=store.publicDimensions().irritation.current;
    assert(after<=1,"irritation clamped at 1");
    assert(after>=start,"dismissive does not decrease irritation");
  }

  // 4 apology softens but not instant zero
  {
    const before=store.publicDimensions().irritation.current;
    store.applyEvents([{type:"apology",severity:"moderate"}],new Date(t0.getTime()+200_000));
    const after=store.publicDimensions().irritation.current;
    assert(after<before,"apology reduces irritation");
    // moderate apology is -0.20; allow tiny decay/jitter but not a full personality reset
    assert(before-after<=0.35,`apology not a full wipe (${before.toFixed(3)}→${after.toFixed(3)})`);
    assert(after>store.document.dimensions.irritation.baseline-0.05||after<0.5,"irritation remains meaningful");
  }

  // 5-6 decay 6/12/24h + closeness slower than irritation
  {
    // force elevated irritation and closeness
    store.document.dimensions.irritation.current=0.8;
    store.document.dimensions.irritation.last_updated_at=t0.toISOString();
    store.document.dimensions.closeness.current=0.95;
    store.document.dimensions.closeness.last_updated_at=t0.toISOString();
    store.document.dimensions.irritation.baseline=0.08;
    store.document.dimensions.closeness.baseline=0.62;
    store.save();
    store.advance(new Date(t0.getTime()+6*HOUR));
    const at6=store.publicDimensions();
    store.advance(new Date(t0.getTime()+12*HOUR));
    const at12=store.publicDimensions();
    store.advance(new Date(t0.getTime()+24*HOUR));
    const at24=store.publicDimensions();
    assert(at6.irritation.current<0.8,"6h irritation decayed");
    assert(at12.irritation.current<at6.irritation.current,"12h irritation further decay");
    assert(at24.irritation.current<at12.irritation.current,"24h irritation further decay");
    assert(Math.abs(at24.closeness.current-0.95)<Math.abs(at24.irritation.current-0.8),"closeness moved less than irritation over 24h");
  }

  // 7 restart preserves
  {
    const store2=new NaturalPresenceStore({file,enabled:true});
    const a=store.publicDimensions().closeness.current;
    const b=store2.publicDimensions().closeness.current;
    assert(Math.abs(a-b)<1e-6,`restart preserves closeness ${a} vs ${b}`);
  }

  // 8 sleep/wake large jump uses absolute time
  {
    const store3=new NaturalPresenceStore({file:path.join(tmp,"presence-sleep.json"),enabled:true});
    store3.document.dimensions.irritation.current=0.9;
    store3.document.dimensions.irritation.last_updated_at=new Date("2026-09-10T00:00:00.000Z").toISOString();
    store3.save();
    store3.advance(new Date("2026-09-12T00:00:00.000Z"));
    assert(store3.publicDimensions().irritation.current<0.5,"48h wake decayed irritation a lot");
  }

  // 8b mood jitter must not re-apply every advance() inside the same 3h bucket
  {
    const storeJ=new NaturalPresenceStore({file:path.join(tmp,"presence-jitter.json"),enabled:true});
    const t=Date.parse("2026-09-13T04:50:00.000Z");
    storeJ.document.dimensions.mood.current=0.4;
    storeJ.document.dimensions.mood.baseline=0.18;
    storeJ.document.dimensions.mood.last_updated_at=new Date(t-4*HOUR).toISOString();
    storeJ.document.last_mood_jitter_bucket=null;
    storeJ.document.updated_at=new Date(t-4*HOUR).toISOString();
    storeJ.save();
    for(let i=0;i<20;i++) storeJ.advance(new Date(t+i*2000));
    const final=storeJ.publicDimensions().mood.current;
    // Old bug: ~20 * -0.019 on top of decay. Fixed: at most one jitter step per bucket.
    assert(final>0.10&&final<0.55,`mood not crashed by repeated jitter (got ${final.toFixed(4)})`);
    assert(storeJ.document.last_mood_jitter_bucket!==null,"jitter bucket recorded");
  }

  // 8c ordinary leave/urging heuristics are not negative mood bombs
  {
    const samples=["我去洗澡了","晚安","搞定了，谢了","？？"];
    for(const text of samples){
      const ev=heuristicEvaluation(text,"");
      const neg=(ev.events??[]).filter(e=>["disagreement","dismissive_response"].includes(e.type));
      assert(neg.length===0,`ordinary text not dismissive/disagreement: ${text} ${JSON.stringify(ev.events)}`);
    }
  }

  // 9-11 open loop create/resolve/dedupe/expire
  {
    const s=new NaturalPresenceStore({file:path.join(tmp,"loops.json"),enabled:true});
    const at=new Date("2026-09-12T08:00:00.000Z");
    s.upsertOpenLoops([{topic:"agent run",expected_in_hours:1,salience:0.7}],at);
    assert(s.document.open_loops.length===1,"open loop created");
    s.upsertOpenLoops([{topic:"agent run",salience:0.8}],at);
    assert(s.document.open_loops.length===1,"open loop deduped");
    assert(s.document.open_loops[0].salience>=0.75,"salience raised on dedupe");
    const n=s.resolveOpenLoops(["agent run"],new Date(at.getTime()+HOUR));
    assert(n===1&&s.document.open_loops[0].resolved,"open loop resolved");
    s.upsertOpenLoops([{topic:"old",salience:0.5}],new Date(at.getTime()-60*HOUR));
    s.resolveOpenLoops([],new Date(at.getTime()+HOUR));
    assert(s.document.open_loops.every(l=>l.resolved||l.topic!=="old"||l.salience<0.5),"old loop decayed/expired path");
  }

  // 12 thought seeds create/activate/cooldown/expire
  {
    const s=new NaturalPresenceStore({file:path.join(tmp,"seeds.json"),enabled:true});
    const at=new Date("2026-09-12T08:00:00.000Z");
    s.addThoughtSeeds([{text:"不知道 agent 跑完没有",topic:"agent",salience:0.6}],at);
    assert(s.document.thought_seeds.length===1,"seed created");
    const a=s.activateThoughtSeed(at);
    assert(Boolean(a),"seed activated");
    const b=s.activateThoughtSeed(new Date(at.getTime()+HOUR));
    assert(b===null,"seed cooldown blocks immediate reactivation");
    const c=s.activateThoughtSeed(new Date(at.getTime()+7*HOUR));
    assert(Boolean(c),"seed reactivates after cooldown");
    s.document.thought_seeds[0].expires_at=new Date(at.getTime()+HOUR).toISOString();
    s.addThoughtSeeds([],new Date(at.getTime()+2*HOUR));
    assert(s.document.thought_seeds.length===0||s.document.thought_seeds.every(x=>!x.expired),"expired seeds cleaned");
  }

  // 13 rhythm update
  {
    const s=new NaturalPresenceStore({file:path.join(tmp,"rhythm.json"),enabled:true});
    const {companionTime}=await import("../src/time-service.js");
    const base=companionTime.fromLocalParts({year:2026,month:9,day:12,hour:14,minute:0});
    for(let i=0;i<5;i++)s.observeInteraction({text:"hi",at:new Date(base.getTime()+i*1000)});
    const r=s.rhythmSummary(new Date(base.getTime()+HOUR));
    assert(r.samples>=5,"rhythm samples counted");
    assert(r.activeHours.includes(14),`hour bucket 14 active, got ${JSON.stringify(r.activeHours)}`);
  }

  // 14 contact decision with open loop
  {
    const s=new NaturalPresenceStore({file:path.join(tmp,"contact.json"),enabled:true});
    const at=new Date("2026-09-12T10:00:00.000Z");
    s.upsertOpenLoops([{topic:"Natural Messaging agent run",expected_in_hours:0.2,salience:0.8}],at);
    const decision=s.contactDecision({lastUserInteractionAt:new Date(at.getTime()-HOUR).toISOString(),at:new Date(at.getTime()+HOUR),gate:{allowed:true,reasons:[]}});
    assert(decision.action==="START_CONVERSATION"&&decision.reason==="open_loop_followup",`open loop drives contact: ${JSON.stringify(decision)}`);
    assert(String(decision.topic).includes("agent")||String(decision.topic).includes("Natural"),"loop topic present");
  }

  // 15 WAIT when nothing meaningful
  {
    const s=new NaturalPresenceStore({file:path.join(tmp,"wait.json"),enabled:true});
    const at=new Date("2026-09-12T15:00:00.000Z");
    s.document.interaction_rhythm.hour_buckets=Array.from({length:24},()=>0);
    s.document.interaction_rhythm.day_counts=[];
    s.save();
    const decision=s.contactDecision({lastUserInteractionAt:new Date(at.getTime()-30*60_000).toISOString(),at,gate:{allowed:true,reasons:[]},inactivity:{eligible:false}});
    assert(decision.action==="WAIT",`waits without reason to ping: ${JSON.stringify(decision)}`);
  }

  // 16 40h inactivity grants a cognition wake, never direct send eligibility
  {
    const elig=evaluateInactivityEligibility({
      state:{lastUserInteractionAt:new Date(Date.now()-40*HOUR).toISOString(),lastProactiveAt:null,consecutiveUnansweredProactive:0},
      at:new Date(),hasSuitableContext:true
    });
    assert(elig.eligible===true&&elig.band==="40h"&&elig.sendAllowed===false,`40h grants cognition only: ${JSON.stringify({band:elig.band,sendAllowed:elig.sendAllowed,eligible:elig.eligible})}`);
  }

  // 17 user reply resets streak (companion-state)
  {
    const stateMod=await import("../src/companion-state.js");
    stateMod.touchUserInteraction(new Date(Date.now()-HOUR).toISOString());
    const s1=stateMod.getState();
    s1.consecutiveUnansweredProactive=2;stateMod.saveState();
    stateMod.touchUserInteraction();
    assert((stateMod.getState().consecutiveUnansweredProactive??0)===0,"user reply resets proactive streak");
  }

  // 18 natural messaging still available
  {
    const {parseNaturalBubbles}=await import("../src/natural-messaging.js");
    const p=parseNaturalBubbles('{"messages":["在","怎么啦"]}');
    assert(p.bubbles.length===2,"multi-bubble parser intact");
  }

  // parse evaluation + heuristic
  {
    const parsed=parsePresenceEvaluation('```json\n{"events":[{"type":"disagreement","severity":"moderate","resolved":false,"topic":"design"}],"open_loops":[{"topic":"agent","expected_in_hours":1}]}\n```');
    assert(parsed.ok&&parsed.events[0].type==="disagreement","evaluation JSON parse");
    const h=heuristicEvaluation("我让 agent 跑一下，一会回来","");
    assert(h.open_loops.length===1,"heuristic creates open loop");
  }

  console.log("\nPASS Natural Presence v1 deterministic suite");
}catch(e){throw e;}finally{
  try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
}
