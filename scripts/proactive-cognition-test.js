import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-proactive-cognition-"));
process.env.COMPANION_API_KEY="cognition-test-key-long-random";
process.env.DATABASE_PATH=path.join(tmp,"companion.db");
process.env.EMBEDDING_ENABLED="false";
process.env.COMPANION_STATE_PATH=path.join(tmp,"companion-state.json");
process.env.COMPANION_BEHAVIOR_PATH=path.join(tmp,"companion-behavior.json");
process.env.COMPANION_NATURAL_PRESENCE_PATH=path.join(tmp,"natural-presence.json");
process.env.COMPANION_NATURAL_COGNITION_PATH=path.join(tmp,"natural-cognition.json");
process.env.COMPANION_AUTONOMOUS_LIFE_ENABLED="false";
process.env.COMPANION_AUTONOMOUS_LIFE_STATE_PATH=path.join(tmp,"autonomous-life.json");
process.env.COMPANION_INACTIVITY_DEV_OVERRIDE_ENABLED="1";
process.env.COMPANION_NATURAL_PRESENCE_ENABLED="true";
process.env.COMPANION_NATURAL_COGNITION_ENABLED="true";
process.env.COMPANION_PROACTIVE_DISABLED="0";
process.env.COMPANION_MODULES_DIR=path.join(tmp,"modules");
process.env.COMPANION_MODULES_STATE_PATH=path.join(tmp,"modules-state.json");
process.env.COMPANION_MODULE_EXECUTION_LEDGER_PATH=path.join(tmp,"ledger.json");
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:1/v1";
process.env.UPSTREAM_API_KEY="";
process.env.UPSTREAM_CHAT_BASE_URL=process.env.UPSTREAM_BASE_URL;
process.env.UPSTREAM_CHAT_API_KEY="";
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";

const assert=(value,message)=>{if(!value)throw new Error(`ASSERT: ${message}`);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let server=null,chatCalls=0;
try{
  const mockPort=35200+Math.floor(Math.random()*200);
  process.env.UPSTREAM_BASE_URL=`http://127.0.0.1:${mockPort}/v1`;
  process.env.UPSTREAM_CHAT_BASE_URL=process.env.UPSTREAM_BASE_URL;
  server=http.createServer((req,res)=>{
    let raw="";req.on("data",chunk=>raw+=chunk);
    req.on("end",()=>{
      chatCalls++;
      const body=JSON.parse(raw||"{}");
      const subject=(body.messages??[]).filter(item=>item.role==="user").at(-1)?.content??"";
      const content=/打印机/.test(subject)?"对了，你那个打印机后来怎么样了？":"刚想到你，想跟你说句话。";
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({id:"mock",object:"chat.completion",model:"mock-chat",choices:[{index:0,message:{role:"assistant",content},finish_reason:"stop"}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}));
    });
  });
  await new Promise(resolve=>server.listen(mockPort,"127.0.0.1",resolve));

  const {config}=await import("../src/config.js");
  const {ensureDefaultPersona}=await import("../src/persona.js");
  const state=await import("../src/companion-state.js");
  const {naturalPresence}=await import("../src/natural-presence/index.js");
  const {naturalCognition}=await import("../src/natural-cognition/index.js");
  const {contactSuppression}=await import("../src/contact-suppression.js");
  const proactive=await import("../src/proactive.js");
  const {getOrCreateSession,insertMessage,db}=await import("../src/db.js");
  const {FOLLOWUP_KINDS,NEXT_ACTORS}=await import("../src/proactive-ownership.js");
  const metricsModule=await import("../src/proactive-cognition-metrics.js");
  ensureDefaultPersona();
  const session=getOrCreateSession(config.defaultPersonaId,"chat","proactive-cognition-test");
  insertMessage(session.id,config.defaultPersonaId,{role:"user",content:"最近在看3D打印机的方案"});
  insertMessage(session.id,config.defaultPersonaId,{role:"assistant",content:"这个方向挺有意思的"});
  const minuteText=offset=>{const now=new Date(),total=(now.getHours()*60+now.getMinutes()+offset+1440)%1440;return `${String(Math.floor(total/60)).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`;};
  state.updateBehavior({quietHours:{start:minuteText(3),end:minuteText(5)},dailyProactiveCap:10,proactiveLevel:"normal",proactiveMessagesEnabled:true});

  const setBase=({hours=8,topic="最近在看3D打印机的方案",at=new Date(Date.now()+60_000)}={})=>{
    const last=new Date(at.getTime()-hours*3600_000).toISOString();
    const s=state.getState();
    s.lastUserInteractionAt=last;s.lastProactiveAt=null;s.consecutiveUnansweredProactive=0;
    s.recentTopics=[topic];s.pendingFollowups=[];s.proactiveToday={date:"",count:0};
    s.inactivity={...s.inactivity,simulatedLastUserInteractionAt:last,lastCognitionWakeKey:null};
    state.saveState();
    naturalPresence.document.open_loops=[];naturalPresence.document.thought_seeds=[];
    naturalPresence.document.emotion_state={current:"calm",cause:null,remaining_turns:0};
    for(const [key,value] of Object.entries({mood:0.1,energy:0.8,irritation:0.1,social_drive:0.58,closeness:0.65,playfulness:0.55,confidence:0.65})){
      const dim=naturalPresence.document.dimensions[key];if(dim){dim.current=value;dim.baseline=value;dim.last_updated_at=at.toISOString();}
    }
    naturalPresence.save();
    naturalCognition.document.expectations=[];
    naturalCognition.document.focus={primary:null,secondary:null,updated_at:last};
    naturalCognition.document.seen={};
    naturalCognition.document.attention={state:"UNKNOWN",window_active:false,chat_visible:false,updated_at:at.toISOString()};
    naturalCognition.save();
    contactSuppression.state={version:1,pending:null,active:null};contactSuppression.save();
    return {at,last};
  };
  const tick=async ({hours=8,topic}={})=>{
    const {at}=setBase({hours,topic});
    const out=await proactive.runHeartbeat({at});
    assert(out.delivered===false,"NO_ACTION tick did not deliver");
    return out;
  };
  let checks=0;

  // A. Inactivity by itself reaches NO_ACTION.
  {
    const before=chatCalls;const out=await tick({hours:12});checks++;
    assert(out.reason==="no_candidates"||out.reason==="autonomy:wait","inactivity-only tick is NO_ACTION");
    assert(chatCalls===before,"inactivity-only tick does not call the model");
  }

  // B. User-owned printer loop wins as the contact reason; prompt omits silence duration.
  {
    const {at}=setBase({hours:12,topic:"我等下去看看那台3D打印机"});
    naturalPresence.upsertOpenLoops([{
      topic:"3D打印机",salience:0.82,state:"waiting_for_followup",
      expected_followup_at:new Date(at.getTime()-2*3600_000).toISOString(),
      followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,next_expected_actor:NEXT_ACTORS.USER
    }],at,{userText:"我等下去看看那台3D打印机",assistantText:"好，回来跟我说"});
    const {candidates}=proactive.gatherCandidateSet({at});
    const chosen=candidates[0];
    assert(chosen?.proactiveReason==="open_loop_callback"&&chosen.topic.includes("打印机"),"open loop becomes callback reason");
    const subject=proactive.composeUserSubject("presence",chosen);
    assert(subject.includes("打印机")&&!subject.includes("距离上次"),"callback prompt stays on the printer");
    checks++;
  }

  // C. Overdue user expectation participates; due ownership is recorded.
  {
    const {at}=setBase({hours:16,topic:"我晚上回来"});
    naturalCognition.upsertExpectation({topic:"晚上回来",salience:0.9,ttlHours:24,reason:"user_commitment",followupKind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,nextExpectedActor:NEXT_ACTORS.USER},new Date(at.getTime()-5*3600_000));
    const {candidates}=proactive.gatherCandidateSet({at});
    assert(candidates[0]?.proactiveReason==="expectation_followup","pending expectation can drive the decision");
    assert(!proactive.composeUserSubject("presence",candidates[0]).includes("距离上次"),"expectation prompt is not inactivity-led");
    checks++;
  }

  // D. Explicit leave suppression survives the 40h wake.
  {
    const {at}=setBase({hours:40});
    contactSuppression.state.active={kind:"sleep",until:new Date(at.getTime()+2*3600_000).toISOString(),assistant_closed:true};contactSuppression.save();
    const before=chatCalls;const result=proactive.gatherCandidateSet({at});
    assert(result.suppressionActive&&result.candidates.length===0,"explicit suppression blocks all candidate kinds");
    const out=await proactive.runHeartbeat({at});
    assert(out.delivered===false&&chatCalls===before,"suppression prevents model call and delivery");
    checks++;
  }

  // E. Cooldown gates a fresh high-value loop before model generation.
  {
    const {at}=setBase({hours:12,topic:"那台3D打印机"});
    naturalPresence.upsertOpenLoops([{topic:"3D打印机",salience:0.82,expected_followup_at:new Date(at.getTime()-3600_000).toISOString(),followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,next_expected_actor:NEXT_ACTORS.USER}],at,{userText:"看看打印机",assistantText:"好"});
    state.getState().lastProactiveAt=new Date(at.getTime()-10*60_000).toISOString();state.saveState();
    const before=chatCalls;const out=await proactive.runOnce({at});
    assert(out.delivered===false&&String(out.reason).includes("cooldown"),"cooldown blocks loop candidate");
    assert(chatCalls===before,"cooldown blocks before generation");
    checks++;
  }

  // F. Fulfilled loop does not return as a callback.
  {
    const {at}=setBase({hours:8,topic:"3D打印机后来已经搞定了"});
    const [loop]=naturalPresence.upsertOpenLoops([{topic:"3D打印机",salience:0.9,expected_followup_at:new Date(at.getTime()-3600_000).toISOString(),followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,nextExpectedActor:NEXT_ACTORS.USER}],at,{userText:"等下看打印机",assistantText:"好"});
    naturalPresence.resolveOpenLoops(["3D打印机"],at);
    naturalCognition.updateFocus({primaryCandidate:{topic:"3D打印机",source:"active_topic",salience:0.8},at:new Date(at.getTime()-3600_000)});
    const {candidates}=proactive.gatherCandidateSet({at});
    assert(!candidates.some(item=>item.topic.includes("打印机")),"fulfilled loop and related focus are not revived");
    checks++;
  }

  // G. Recent project focus can create one restrained continuation without an expectation.
  {
    const topic="Companion 项目的消息去重方案";
    const {at}=setBase({hours:8,topic:`刚聊到${topic}`});
    naturalCognition.updateFocus({primaryCandidate:{topic,source:"active_topic",salience:0.8},at:new Date(at.getTime()-8*3600_000)});
    const {candidates}=proactive.gatherCandidateSet({at});
    const chosen=candidates[0];
    assert(chosen?.proactiveReason==="spontaneous_continuation"&&chosen.topic===topic,"recent matching focus offers one continuation");
    const subject=proactive.composeUserSubject("presence",chosen);
    assert(subject.includes(topic)&&!subject.includes("没来"),"continuation prompt centers the project");
    checks++;
  }

  // H. High social drive can occasionally select pure social contact without a forced check-in.
  {
    const {at}=setBase({hours:20,topic:"最近在看点东西"});
    naturalPresence.document.dimensions.social_drive.current=0.9;naturalPresence.save();
    const {candidates}=proactive.gatherCandidateSet({at});
    assert(candidates[0]?.proactiveReason==="pure_social_contact","high social drive allows an occasional social contact");
    const subject=proactive.composeUserSubject("presence",candidates[0]);
    assert(!subject.includes("在干嘛")&&!subject.includes("还在吗")&&!subject.includes("多久"),"pure social prompt avoids absence questions");
    checks++;
  }

  // I. A stale focus or an explicit topic shift cannot revive an old callback.
  {
    const stale="水上公园";
    const {at}=setBase({hours:30,topic:"植物园花展"});
    naturalCognition.updateFocus({primaryCandidate:{topic:stale,source:"active_topic",salience:0.8},at:new Date(at.getTime()-30*3600_000)});
    const {candidates}=proactive.gatherCandidateSet({at});
    assert(!candidates.some(item=>item.topic===stale),"stale/mismatched focus cannot become a callback");
    checks++;
  }

  // J. Several reasons coexist, but one ranked primary reason is selected.
  {
    const {at}=setBase({hours:12,topic:"那个打印机"});
    naturalPresence.upsertOpenLoops([{topic:"3D打印机",salience:0.82,expected_followup_at:new Date(at.getTime()-3600_000).toISOString(),followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,next_expected_actor:NEXT_ACTORS.USER}],at,{userText:"看看打印机",assistantText:"好"});
    state.getState().pendingFollowups=[{id:"fu_test",topic:"明天要验收新版本",status:"pending",sourceSessionId:session.id,createdAt:new Date(at.getTime()-24*3600_000).toISOString(),earliestAt:new Date(at.getTime()-3600_000).toISOString(),expiresAt:new Date(at.getTime()+24*3600_000).toISOString()}];state.saveState();
    const {candidates}=proactive.gatherCandidateSet({at});
    assert(candidates.length>=2,"open loop and due follow-up coexist");
    const chosen=candidates[0],subject=proactive.composeUserSubject(chosen.kind,chosen);
    assert(chosen.proactiveReason&&subject,"one primary reason has one generation subject");
    assert(!subject.includes("打印机")||!subject.includes("验收新版本"),"subject does not emit a cognition checklist");
    checks++;
  }

  // Five repeated no-reason cognition ticks remain silent and do not call the model.
  for(const hours of [6,12,20,30,40]){
    const before=chatCalls;const out=await tick({hours,topic:"随便聊过的内容"});
    assert(out.delivered===false&&chatCalls===before,`wake ${hours}h does not imply a send`);checks++;
  }

  // Metrics persist counts and only retain subject hashes, never message text.
  {
    const metrics=new metricsModule.ProactiveCognitionMetrics({file:path.join(tmp,"metrics.json")});
    metrics.noteTick({action:"NO_ACTION",reason:"nothing_worth_saying"});
    const first=metrics.noteDelivery({reason:"open_loop_callback",topic:"打印机",text:"对了，你那个打印机后来怎么样了？"});
    const duplicate=metrics.noteDelivery({reason:"open_loop_callback",topic:"打印机",text:"对了，你那个打印机后来怎么样了？"});
    assert(!first.duplicate&&duplicate.duplicate,"duplicate proactive subject is detected");
    metrics.noteDelivery({reason:"open_loop_callback",topic:"打印机",text:"你怎么这么久没找我，在干嘛？"});
    assert(metrics.snapshot().counters.absence_framed===1&&metrics.snapshot().counters.forced_question===1,"absence framing and forced check-in language are measured");
    const raw=fs.readFileSync(path.join(tmp,"metrics.json"),"utf8");
    assert(!raw.includes("后来怎么样")&&metrics.snapshot().counters.no_action===1,"metrics retain hashes and counts, not message content");
    checks++;
  }

  assert(chatCalls===0,"all 15 cognition scenarios were decision-only");
  console.log(`PASS Proactive Cognition v1: ${checks} targeted ticks/scenarios across NO_ACTION, open loops, expectations, suppression, cooldown, fulfilled state, focus, social contact, ranking, and metrics`);
}finally{
  try{server?.close();}catch{}
  try{const dbMod=await import("../src/db.js");dbMod.db?.close();}catch{}
  fs.rmSync(tmp,{recursive:true,force:true});
}
