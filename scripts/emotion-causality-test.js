import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NaturalPresenceStore,heuristicEvaluation } from "../src/natural-presence/store.js";
import { appraiseEmotion,emotionExpressionBlock } from "../src/emotion-causality.js";

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"companion-emotion-"));
const file=path.join(dir,"presence.json");
let now=new Date("2026-09-23T10:00:00Z");
const store=new NaturalPresenceStore({file,enabled:true,now:()=>now});
const turn=(text,id,previous=[])=>store.appraiseUserEmotion({text,messageId:id,at:now,recentUserTexts:previous});
try{
  turn("嗯","m1");
  assert.equal(store.document.emotion_state,null,"one minimal reply is not a trigger");
  assert(!heuristicEvaluation("今天就想随便聊聊").events.some(event=>event.type==="dismissive_response"),"ordinary use of 随便 is not dismissal");
  assert.equal(heuristicEvaluation("嗯").events.length,0,"one minimal acknowledgement is emotionally neutral");
  assert(heuristicEvaluation("你有病吧").events.some(event=>event.type==="dismissive_response"),"direct insult is not a warm interaction");
  turn("哦","m2",["嗯"]);
  assert.equal(store.document.emotion_state.primary,"annoyed");
  assert.equal(store.document.emotion_state.causes[0].event_id,"m2");
  turn("随便","m3",["嗯","哦"]);
  assert(store.document.emotion_state.intensity>0.5,"reinforcement raises intensity");
  const before=store.document.emotion_state.intensity;
  turn("在吗","m4",["哦","随便"]);
  assert.equal(store.document.emotion_state.primary,"annoyed");
  assert(store.document.emotion_state.intensity>=before*0.99,"ordinary topic shift keeps residual emotion");
  turn("对不起，刚才我态度不好，下次会认真回你","m5");
  assert(store.document.emotion_state.intensity<before&&store.document.emotion_state.intensity>0.12,"repair is gradual");
  const persisted=store.document.emotion_state.intensity;
  const reloaded=new NaturalPresenceStore({file,enabled:true,now:()=>now});
  assert.equal(reloaded.document.emotion_state.intensity,persisted,"cause and intensity survive restart");
  now=new Date("2026-09-25T10:00:00Z");
  reloaded.appraiseUserEmotion({text:"今天聊点别的",messageId:"m6",at:now});
  assert(reloaded.document.emotion_state===null||reloaded.document.emotion_state.intensity<persisted,"time eases emotion");
  now=new Date("2026-09-23T10:00:00Z");
  const second=new NaturalPresenceStore({file:path.join(dir,"expectation.json"),enabled:true,now:()=>now});
  second.appraiseUserEmotion({text:"我晚上回来找你",messageId:"p1",at:now});
  assert(second.document.open_loops.some(loop=>loop.next_expected_actor==="user"));
  now=new Date("2026-09-24T10:00:00Z");
  second.appraiseUserEmotion({text:"我回来了",messageId:"p2",at:now});
  assert.equal(second.document.emotion_state.primary,"hurt");
  assert.equal(second.document.emotion_state.causes[0].event,"expectation_violation");
  assert(second.document.open_loops.every(loop=>loop.resolved),"fulfilled promise is not violated twice");
  second.appraiseUserEmotion({text:"在吗",messageId:"p3",at:now});
  assert.equal(second.document.emotion_state.primary,"hurt");
  const lateCommitments=[
    {type:"finish_then_return",text:"我回来了，已经弄完了",reason:"user_initiated"},
    {type:"return",text:"我回来了",reason:"user_initiated"},
    {type:"show",text:"我给你看了",reason:"assistant_elicited"}
  ];
  for(const [index,commitment] of lateCommitments.entries()){
    const item={id:`exp_late_${index}`,topic:"结构化 expectation",expected_information:commitment.type,
      state:"pending",next_expected_actor:"user",expires_at:new Date(now.getTime()-60_000).toISOString(),
      reason:commitment.reason,salience:0.65,confidence:0.83};
    const appraisal=appraiseEmotion({text:commitment.text,messageId:`late_${index}`,at:now,expectations:[item]});
    assert.equal(appraisal.event,"expectation_violation",`${commitment.type} overdue update is appraised`);
    assert.equal(appraisal.expectation_id,item.id);
    assert.equal(appraisal.expectation_type,commitment.type);
    assert.equal(appraisal.expectation_reason,commitment.reason);
    assert.equal(appraisal.expectation_source,commitment.reason);
    assert.equal(appraisal.lifecycle_transition,"pending->overdue->violated");
    assert.equal(appraisal.confidence,0.83);
    assert.equal(appraisal.emotion,"hurt","late update does not mechanically force anger");
    assert(appraisal.strength<0.6,"violation appraisal remains moderate");
    const durable=new NaturalPresenceStore({file:path.join(dir,`violation-${index}.json`),enabled:true,now:()=>now});
    const saved=durable.appraiseUserEmotion({text:commitment.text,messageId:`late_${index}`,at:now,expectations:[item]});
    assert.equal(saved.state.causes[0].expectation_type,commitment.type,"structured expectation type persists with emotional cause");
    assert.equal(saved.state.causes[0].expectation_source,commitment.reason);
    assert.equal(saved.state.causes[0].lifecycle_transition,"pending->overdue->violated");
  }
  for(const terminalState of ["satisfied","abandoned","cancelled"]){
    const appraisal=appraiseEmotion({text:"我回来了",messageId:`terminal_${terminalState}`,at:now,expectations:[{
      id:`exp_${terminalState}`,topic:"晚上回来",expected_information:"return",state:terminalState,
      next_expected_actor:"user",expires_at:new Date(now.getTime()-60_000).toISOString(),reason:"user_cancelled",salience:0.7
    }]});
    assert.notEqual(appraisal.event,"expectation_violation",`${terminalState} expectations do not produce a violation`);
  }
  for(const text of ["以后可能买个打印机","如果明天下雨我就不去了"]){
    const appraisal=appraiseEmotion({text,messageId:"weak_commitment",at:now});
    assert.notEqual(appraisal.event,"expectation_violation",`${text} does not create a violation without a commitment`);
  }
  const notOverdue=appraiseEmotion({text:"我回来了",messageId:"not_overdue",at:now,expectations:[{
    id:"exp_future",topic:"晚上回来",expected_information:"return",state:"pending",next_expected_actor:"user",
    expires_at:new Date(now.getTime()+60_000).toISOString(),reason:"user_initiated",salience:0.7
  }]});
  assert.notEqual(notOverdue.event,"expectation_violation","a future due time cannot produce a violation");
  now=new Date("2026-09-27T10:00:00Z");
  second.contextBlock(now);
  assert(second.document.emotion_state===null||second.document.emotion_state.intensity<0.2,"proactive context also advances recovery");
  now=new Date("2026-09-24T10:00:00Z");
  const third=new NaturalPresenceStore({file:path.join(dir,"transition.json"),enabled:true,now:()=>now});
  third.appraiseUserEmotion({text:"你有病吧",messageId:"x1",at:now});
  assert.equal(third.document.emotion_state.primary,"angry");
  third.appraiseUserEmotion({text:"讨厌你",messageId:"x2",at:now});
  assert.equal(third.document.emotion_state.primary,"hurt","repeated disrespect can turn anger into hurt");
  assert(emotionExpressionBlock(third.document.emotion_state,"QUESTION").includes("QUESTION 仍要提问"),"expression keeps the selected act");
  const escalation=new NaturalPresenceStore({file:path.join(dir,"escalation.json"),enabled:true,now:()=>now});
  escalation.appraiseUserEmotion({text:"嗯",messageId:"d1",at:now});
  escalation.appraiseUserEmotion({text:"哦",messageId:"d2",at:now,recentUserTexts:["嗯"]});
  escalation.appraiseUserEmotion({text:"随便",messageId:"d3",at:now,recentUserTexts:["嗯","哦"]});
  const annoyedIntensity=escalation.document.emotion_state.intensity;
  escalation.appraiseUserEmotion({text:"呵呵",messageId:"d4",at:now,recentUserTexts:["嗯","哦","随便"]});
  assert.equal(escalation.document.emotion_state.primary,"angry","sustained dismissal escalates with a cause");
  assert(escalation.document.emotion_state.intensity>annoyedIntensity,"escalation increases intensity");
  const angryIntensity=escalation.document.emotion_state.intensity;
  escalation.appraiseUserEmotion({text:"都行",messageId:"d5",at:now,recentUserTexts:["哦","随便","呵呵"]});
  assert(escalation.document.emotion_state.intensity>angryIntensity,"further dismissal reinforces anger");
  assert.equal(escalation.document.emotion_state.causes[0].event_id,"d5");
  console.log("emotion causality: persistence, reinforcement, repair, expectation and restart passed");
}finally{fs.rmSync(dir,{recursive:true,force:true});}
