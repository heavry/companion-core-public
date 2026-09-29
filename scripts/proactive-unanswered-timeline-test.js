import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-unanswered-timeline-"));
process.env.COMPANION_API_KEY="timeline-test-key-long-random";
process.env.DATABASE_PATH=path.join(tmp,"companion.db");
process.env.COMPANION_STATE_PATH=path.join(tmp,"state.json");
process.env.COMPANION_BEHAVIOR_PATH=path.join(tmp,"behavior.json");
process.env.COMPANION_NATURAL_PRESENCE_ENABLED="true";
process.env.COMPANION_NATURAL_PRESENCE_PATH=path.join(tmp,"presence.json");
process.env.COMPANION_NATURAL_COGNITION_ENABLED="true";
process.env.COMPANION_NATURAL_COGNITION_PATH=path.join(tmp,"cognition.json");
process.env.COMPANION_AUTONOMOUS_LIFE_ENABLED="false";
process.env.COMPANION_AUTONOMOUS_LIFE_STATE_PATH=path.join(tmp,"autonomous.json");
process.env.COMPANION_INACTIVITY_DEV_OVERRIDE_ENABLED="1";
process.env.EMBEDDING_ENABLED="false";
process.env.COMPANION_MODULES_DIR=path.join(tmp,"modules");
process.env.COMPANION_MODULES_STATE_PATH=path.join(tmp,"modules-state.json");
process.env.COMPANION_MODULE_EXECUTION_LEDGER_PATH=path.join(tmp,"ledger.json");
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
process.env.UPSTREAM_API_KEY="";
process.env.UPSTREAM_CHAT_API_KEY="";
process.env.UPSTREAM_PRIMARY_BASE_URL="";
process.env.UPSTREAM_SECONDARY_BASE_URL="";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";
process.env.TAVILY_API_KEY="";
process.env.TAVILY_BASE_URL="";
process.env.SEARXNG_BASE_URL="";

const HOUR=3600_000;
const t0=new Date(Date.now()-41*HOUR);
const at=hours=>new Date(t0.getTime()+hours*HOUR);
let modelCalls=0;
const prompts=[];
const server=http.createServer((req,res)=>{
  let raw="";
  req.on("data",chunk=>raw+=chunk);
  req.on("end",()=>{
    const body=JSON.parse(raw||"{}");
    prompts.push(JSON.stringify(body.messages??[]));
    const messages=[
      ["宝贝人呢","突然想找你瞎聊两句"],
      ["我刚找过你，还是想跟你说句话。"],
      ["我先不追着说了，等你想聊再来。"]
    ][Math.min(modelCalls,2)];
    modelCalls++;
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({id:"mock",object:"chat.completion",model:"mock-chat",choices:[{index:0,message:{role:"assistant",content:JSON.stringify({messages})},finish_reason:"stop"}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}));
  });
});

try{
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=server.address().port;
  process.env.UPSTREAM_BASE_URL=`http://127.0.0.1:${port}/v1`;
  process.env.UPSTREAM_CHAT_BASE_URL=process.env.UPSTREAM_BASE_URL;

  const {config}=await import("../src/config.js");
  const {ensureDefaultPersona}=await import("../src/persona.js");
  const state=await import("../src/companion-state.js");
  const proactive=await import("../src/proactive.js");
  const {evaluateInactivityEligibility}=await import("../src/inactivity-proactive.js");
  const {presenceContext,naturalPresence}=await import("../src/natural-presence/index.js");
  const {absenceAppraisalDiagnostics}=await import("../src/absence-appraisal.js");
  const {getOrCreateSession,getLatestUserMessageAt,insertMessage,db}=await import("../src/db.js");
  ensureDefaultPersona();
  const session=getOrCreateSession(config.defaultPersonaId,"chat","timeline-test");
  insertMessage(session.id,"chat",{role:"user",content:"最近想跟你聊聊天"});
  state.updateBehavior({quietHours:{start:"00:00",end:"00:00"},dailyProactiveCap:10,proactiveLevel:"normal",proactiveMessagesEnabled:true});
  state.touchUserInteraction(t0);
  state.getState().recentTopics=["最近想跟你聊聊天"];
  state.saveState();
  const d=naturalPresence.document.dimensions;
  d.closeness.current=0.85;d.social_drive.current=0.85;d.energy.current=0.75;
  naturalPresence.save();

  const timeline=[];
  for(const hours of [6,12,20,30,40]){
    const date=at(hours);
    const wake=evaluateInactivityEligibility({state:state.getState(),at:date,hasSuitableContext:true});
    assert.equal(wake.band,`${hours}h`);
    assert.equal(wake.inactivityHours,hours);
    const candidate=hours===6
      ?{kind:"presence",presenceReason:"pure_social_contact",proactiveReason:"pure_social_contact",topic:"日常里想说的一句话",sourceSessionId:session.id,score:42}
      :{kind:"presence",presenceReason:"absence_contact",proactiveReason:"unanswered_outreach",topic:"上次主动联系后对方还没回",followup_kind:"awaiting_user_update",next_expected_actor:"user",highValue:true,sourceSessionId:session.id,score:72};
    const candidateSet={candidates:[candidate],inactivity:wake,cognitionWake:wake,sourceSession:session,presenceDecision:null,suppressionActive:false};
    const before=modelCalls;
    const result=await proactive.runHeartbeat({at:date,candidateSet});
    const sameBucket=evaluateInactivityEligibility({state:state.getState(),at:date,hasSuitableContext:true});
    assert.equal(sameBucket.eligible,false,`${hours}h wake consumed even when contact is gated`);
    const streak=state.getState().consecutiveUnansweredProactive;
    const expected={6:1,12:1,20:2,30:2,40:3}[hours];
    assert.equal(streak,expected,`${hours}h streak`);
    assert.equal(state.getState().lastUserInteractionAt,t0.toISOString(),`${hours}h user inactivity anchor`);
    assert.equal(wake.inactivityMs,hours*HOUR,`${hours}h bucket still advances`);
    if([6,20,40].includes(hours)){
      assert.equal(result.delivered,true,`${hours}h new contact`);
      assert.equal(modelCalls,before+1,`${hours}h generates once`);
      const repeated=await proactive.runHeartbeat({at:date,candidateSet});
      assert.equal(repeated.idempotent,true,`${hours}h retry finds existing attempt`);
      assert.equal(modelCalls,before+1,`${hours}h retry does not regenerate`);
      assert.equal(state.getState().consecutiveUnansweredProactive,expected,`${hours}h retry does not recount`);
    }else{
      assert.equal(result.delivered,false,`${hours}h cooldown blocks contact`);
      assert.match(result.reason,/cooldown/,`${hours}h is paced`);
      assert.equal(modelCalls,before,`${hours}h no model call`);
    }
    timeline.push({hours,band:wake.band,delivered:Boolean(result.delivered&&!result.idempotent),streak});
  }

  const firstKey=db.prepare("SELECT json_extract(content_json,'$.proactive_attempt_key') key FROM messages WHERE source='proactive' ORDER BY id LIMIT 1").get()?.key;
  assert.ok(firstKey,"first proactive has durable attempt key");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE source='proactive' AND json_extract(content_json,'$.proactive_attempt_key')=?").get(firstKey).n,2,"two bubbles belong to one contact");
  assert.equal(db.prepare("SELECT COUNT(DISTINCT json_extract(content_json,'$.proactive_attempt_key')) n FROM messages WHERE source='proactive'").get().n,3,"three contacts have distinct durable keys");
  assert.ok(prompts[1].includes("time_since_last_user_reply_hours=20.0")&&prompts[1].includes("unanswered_proactive_streak=1")&&prompts[1].includes("last_proactive_sent_at="),"Presence generation sees time, streak, previous contact");
  const stopped=state.evaluateProactiveGate({kind:"message",candidateKind:"presence",at:at(52),highValueReason:true});
  assert.ok(stopped.reasons.includes("no_reply_limit"),"no fourth contact after long silence");
  assert.equal(modelCalls,3,"no high-frequency model calls");
  const wakeCount=absenceAppraisalDiagnostics.absenceWakeCount;
  for(const offset of [40.25,40.5,41]){
    const repeatedWake=proactive.gatherCandidateSet({at:at(offset)}).cognitionWake;
    assert.equal(repeatedWake.eligible,false,"40h wake is not replayed on later heartbeats");
  }
  assert.equal(absenceAppraisalDiagnostics.absenceWakeCount,wakeCount,"no repeated absence emotion appraisal after 40h");
  const context=presenceContext(at(52),{timeSinceLastUserReplyHours:52,unansweredProactiveStreak:3,lastProactiveSentAt:state.getState().lastProactiveAt});
  assert.ok(context.includes("unanswered_proactive_streak=3")&&context.includes("可以渐渐冷下来少说"),"Presence permits a quieter late response");

  // The real user path resets the streak immediately, without changing the old message count.
  state.setInactivitySimulation({lastUserInteractionAt:t0});
  proactive.observeUserActivity("我回来了");
  assert.equal(state.getState().consecutiveUnansweredProactive,0,"real user reply resets streak");
  assert.equal(state.getState().inactivity.simulatedLastUserInteractionAt,null,"real reply clears candidate time simulation");
  assert.ok(Date.parse(state.getState().lastUserInteractionAt)>t0.getTime(),"real user reply moves inactivity anchor");
  assert.equal(state.getState().countedProactiveAttemptKeys.length,3,"reply keeps retry dedupe history");
  state.getState().lastUserInteractionAt=t0.toISOString();
  state.getState().consecutiveUnansweredProactive=1;
  state.saveState();
  const imageId=insertMessage(session.id,"chat",{role:"user",content:[{type:"image_url",image_url:{url:"data:image/png;base64,AA=="}}]});
  const imageAt=db.prepare("SELECT created_at FROM messages WHERE id=?").get(imageId).created_at;
  assert.equal(getLatestUserMessageAt(config.defaultPersonaId),imageAt,"image-only user message is a real activity anchor");
  assert.equal(state.reconcileUserInteraction(imageAt),true,"image-only user activity reconciles from SQLite");
  assert.equal(state.getState().consecutiveUnansweredProactive,0,"image-only user activity clears streak");
  console.log(`PASS unanswered timeline ${JSON.stringify(timeline)}; 2 bubbles/1 contact; retries stable; reply reset; Presence continuity; cap 3`);
}finally{
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(tmp,{recursive:true,force:true});
}
