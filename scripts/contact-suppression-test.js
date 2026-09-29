import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-closure-sup-"));
process.env.COMPANION_API_KEY="closure-sup-test-key-long-random";
process.env.DATABASE_PATH=path.join(tmp,"companion.db");
process.env.PERSONA_SYNC_ON_START="true";
process.env.EMBEDDING_ENABLED="false";
process.env.COMPANION_MODULES_DIR=path.join(tmp,"modules");
process.env.COMPANION_MODULES_STATE_PATH=path.join(tmp,"ms.json");
process.env.COMPANION_MODULE_EXECUTION_LEDGER_PATH=path.join(tmp,"led.json");
process.env.COMPANION_STATE_PATH=path.join(tmp,"state.json");
process.env.COMPANION_BEHAVIOR_PATH=path.join(tmp,"behavior.json");
process.env.COMPANION_NATURAL_PRESENCE_ENABLED="true";
process.env.COMPANION_NATURAL_PRESENCE_PATH=path.join(tmp,"presence.json");
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
fs.mkdirSync(process.env.COMPANION_MODULES_DIR,{recursive:true});

const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);console.log(`OK  ${m}`);};
const { detectClosure }=await import("../src/closure-sensing.js");
const { ContactSuppressionStore, classifyLeave, looksLikeAssistantClosure }=await import("../src/contact-suppression.js");
const { NaturalPresenceStore }=await import("../src/natural-presence/store.js");

const store=new ContactSuppressionStore({file:path.join(tmp,"sup.json")});
const presence=new NaturalPresenceStore({file:path.join(tmp,"p.json"),enabled:true});

function dueLoop(at){
  presence.upsertOpenLoops([{topic:"晚饭吃什么",salience:0.85,expected_in_hours:0.01}],new Date(at.getTime()-2*3600_000));
}

try{
  const realLeave=detectClosure({userText:"那宝贝去玩了，姐姐休息会去吧"});
  assert(realLeave.likely&&realLeave.kind==="leave","20:43 is leave");
  assert(classifyLeave("那宝贝去玩了，姐姐休息会去吧")?.kind==="play","20:43 leave kind=play");
  assert(looksLikeAssistantClosure("好，去玩吧宝贝。姐姐歇一会儿，你玩开心点。回头想找我再来。"),"20:46 is assistant closure");

  // A play + 3 min WAIT
  {
    const t0=new Date("2026-09-13T12:43:55Z");
    store.observeUser({text:"那宝贝去玩了，姐姐休息会去吧",at:t0});
    store.observeAssistant({text:"好，去玩吧宝贝。回头想找我再来。",at:new Date("2026-09-13T12:46:38Z")});
    dueLoop(t0);
    const t3=new Date("2026-09-13T12:49:56Z");
    const d=presence.contactDecision({at:t3,gate:{allowed:true,reasons:[]},inactivity:{eligible:false},suppression:store.active(t3)});
    assert(d.action==="WAIT"&&d.reason==="post_closure_suppression",`A 3min WAIT got ${d.action} ${d.reason}`);
  }

  // B bath 5 min WAIT, later may contact
  {
    const s=new ContactSuppressionStore({file:path.join(tmp,"b.json")});
    const t0=new Date("2026-09-13T12:00:00Z");
    s.observeUser({text:"我去洗澡了",at:t0});
    s.observeAssistant({text:"去洗吧，洗完再来。",at:t0});
    const t5=new Date(t0.getTime()+5*60_000);
    assert(s.active(t5)&&presence.contactDecision({at:t5,gate:{allowed:true,reasons:[]},inactivity:{eligible:false},suppression:s.active(t5)}).action==="WAIT","B 5min WAIT");
    const tLater=new Date(t0.getTime()+90*60_000);
    assert(!s.active(tLater),"B expired after reasonable window");
  }

  // C sleep
  {
    const s=new ContactSuppressionStore({file:path.join(tmp,"c.json")});
    const t0=new Date("2026-09-13T16:10:00Z"); // 00:10 shanghai
    s.observeUser({text:"我要睡了，晚安",at:t0});
    s.observeAssistant({text:"晚安，好梦。",at:t0});
    const night=new Date(t0.getTime()+2*3600_000);
    assert(s.active(night)?.kind==="sleep","C sleep suppression at night");
    dueLoop(t0);
    const d=presence.contactDecision({at:night,gate:{allowed:true,reasons:[]},inactivity:{eligible:false},suppression:s.active(night)});
    assert(d.action==="WAIT","C night open loop still WAIT");
  }

  // D agent 10 min still suppressed
  {
    const s=new ContactSuppressionStore({file:path.join(tmp,"d.json")});
    const t0=new Date("2026-09-13T12:00:00Z");
    s.observeUser({text:"我跑 Agent，一会回来",at:t0});
    s.observeAssistant({text:"行，去吧，忙完再来。",at:t0});
    const t10=new Date(t0.getTime()+10*60_000);
    assert(s.active(t10),"D 10min still suppressed");
    const t50=new Date(t0.getTime()+50*60_000);
    assert(!s.active(t50),"D later window can follow up");
  }

  // E user returns clears
  {
    const s=new ContactSuppressionStore({file:path.join(tmp,"e.json")});
    const t0=new Date("2026-09-13T12:00:00Z");
    s.observeUser({text:"我去玩会",at:t0});
    s.observeAssistant({text:"去玩吧，回头再聊。",at:t0});
    s.observeUser({text:"我回来了",at:new Date(t0.getTime()+2*60_000)});
    assert(!s.active(new Date(t0.getTime()+3*60_000)),"E return clears");
  }

  // F high salience loop still WAIT
  {
    const s=new ContactSuppressionStore({file:path.join(tmp,"f.json")});
    const t0=new Date("2026-09-13T12:43:55Z");
    s.observeUser({text:"那宝贝去玩了",at:t0});
    s.observeAssistant({text:"好，去玩吧宝贝。回头想找我再来。",at:new Date(t0.getTime()+3*60_000)});
    dueLoop(t0);
    const d=presence.contactDecision({at:new Date(t0.getTime()+6*60_000),gate:{allowed:true,reasons:[]},inactivity:{eligible:false},suppression:s.active(new Date(t0.getTime()+6*60_000))});
    assert(d.action==="WAIT","F old dinner loop cannot break 3min window");
  }

  // G no closure, natural stop
  {
    const s=new ContactSuppressionStore({file:path.join(tmp,"g.json")});
    s.observeUser({text:"四千起步挺好慢慢来",at:new Date()});
    s.observeAssistant({text:"慢慢来就对了。",at:new Date()});
    assert(!s.active(),"G no suppression without leave");
    assert(!detectClosure({userText:"四千起步挺好慢慢来"}).likely,"G not leave");
  }

  // H cancel
  {
    const s=new ContactSuppressionStore({file:path.join(tmp,"h.json")});
    const t0=new Date();
    s.observeUser({text:"我去玩了",at:t0});
    s.observeAssistant({text:"去玩吧。",at:t0});
    s.observeUser({text:"去吧哈哈我逗你的，我不去了",at:new Date(t0.getTime()+30_000)});
    assert(!s.active(),"H cancelled");
  }

  // I persist absolute until, no resurrect after expiry
  {
    const file=path.join(tmp,"i.json");
    const s=new ContactSuppressionStore({file});
    const t0=new Date("2026-09-13T12:46:38Z");
    s.observeUser({text:"那宝贝去玩了",at:new Date("2026-09-13T12:43:55Z")});
    s.observeAssistant({text:"去玩吧，回头再来。",at:t0});
    const s2=new ContactSuppressionStore({file});
    assert(s2.active(new Date("2026-09-13T12:49:56Z")),"I restart still suppressed");
    assert(!s2.active(new Date("2026-09-13T14:00:00Z")),"I expired not resurrected");
  }

  // J real 20:43→20:49
  {
    const s=new ContactSuppressionStore({file:path.join(tmp,"j.json")});
    s.observeUser({text:"那宝贝去玩了，姐姐休息会去吧",messageId:1516,at:new Date("2026-09-13T12:43:55.747Z")});
    s.observeAssistant({text:"好，去玩吧宝贝。姐姐歇一会儿，你玩开心点。回头想找我再来。",at:new Date("2026-09-13T12:46:38.776Z")});
    dueLoop(new Date("2026-09-13T12:43:55Z"));
    const at=new Date("2026-09-13T12:49:56.288Z");
    const d=presence.contactDecision({at,gate:{allowed:true,reasons:[]},inactivity:{eligible:false},suppression:s.active(at)});
    assert(d.action==="WAIT"&&d.reason==="post_closure_suppression","J 20:49 WAIT not dinner follow-up");
  }

  console.log("PASS contact suppression");
}finally{
  fs.rmSync(tmp,{recursive:true,force:true});
}
