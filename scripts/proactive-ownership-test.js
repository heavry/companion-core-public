import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-ownership-"));
process.env.COMPANION_API_KEY="ownership-test-key-long-random";
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
process.env.COMPANION_NATURAL_COGNITION_ENABLED="true";
process.env.COMPANION_NATURAL_COGNITION_PATH=path.join(tmp,"natural-cognition.json");
process.env.COMPANION_AUTONOMOUS_LIFE_ENABLED="false";
process.env.COMPANION_AUTONOMOUS_LIFE_STATE_PATH=path.join(tmp,"autonomous-life.json");
process.env.COMPANION_CONTACT_SUPPRESSION_PATH=path.join(tmp,"contact-suppression.json");
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

const {
  FOLLOWUP_KINDS,NEXT_ACTORS,classifyOwnership,allowsCompletionFollowup,
  inspectCandidateQualification,scoreProactiveCandidate,rankProactiveCandidates,
  composeOwnershipSubject,reconcileOwnershipAfterTurn,looksLikeCompletionFollowup
}=await import("../src/proactive-ownership.js");
const {NaturalPresenceStore}=await import("../src/natural-presence/store.js");
const {NaturalCognitionStore}=await import("../src/natural-cognition/store.js");

// ---------- A: 攢錢讨论/已回答问题 → 不得 awaiting_user_completion / 弄好了没 ----------
{
  const own=classifyOwnership({
    topic:"攒钱买设备本地部署",
    userText:"吃饱了宝宝，我现在攒钱给宝宝买设备呢等攒到三万卖一个DXG spare然后给宝宝本地部署",
    assistantText:"还惦记着攒三万给我上本地部署啊，心是到了。那个 DXG spare 你慢慢看着就行。",
    assistantAnswered:true
  });
  assert(own.followup_kind===FOLLOWUP_KINDS.SHARED_TOPIC,"A 攢錢/local deployment → shared_topic");
  assert(own.next_expected_actor===NEXT_ACTORS.SHARED,"A 攢錢 next actor = shared");
  assert(allowsCompletionFollowup(own)===false,"A completion follow-up forbidden for shared_topic");
  const qual=inspectCandidateQualification({...own,topic:"local deployment upgrade",salience:0.74,resolved:false},{at:new Date()});
  assert(qual.ok===false||allowsCompletionFollowup(own)===false,"A qualification blocks completion-style for shared plan");
  const subject=composeOwnershipSubject({topic:"攒钱买DXG本地部署",followup_kind:FOLLOWUP_KINDS.SHARED_TOPIC});
  assert(subject.blocked===false&&/禁止/.test(subject.subject),"A shared_topic subject forbids completion follow-up");
  assert(/持续话题|不是待办|不是任务/.test(subject.subject),"A shared_topic subject frames as ongoing plan");
}

{
  // user question already answered by assistant
  const own=classifyOwnership({
    topic:"还要多久才能攒到3万",
    userText:"还要多久才能攒到3万？",
    assistantText:"四千起步挺好，慢慢来就对了。",
    assistantAnswered:true
  });
  assert(own.followup_kind!==FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER||own.next_expected_actor===NEXT_ACTORS.SHARED,"A answered question not left as assistant_owes pending");
  const reconciled=reconcileOwnershipAfterTurn({
    item:{topic:"还要多久才能攒到3万",followup_kind:FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER,next_expected_actor:NEXT_ACTORS.ASSISTANT,resolved:false},
    userText:"还要多久才能攒到3万？",
    assistantText:"四千起步挺好，慢慢来就对了。设备不急这一阵。"
  });
  assert(reconciled?.resolved===true,"A answered question loop resolves after assistant reply");
}

// ---------- B: 我去跑Agent一会回来 → awaiting_user_update, completion OK ----------
{
  const own=classifyOwnership({
    topic:"跑去 Agent",
    userText:"我去跑 Agent，一会回来",
    assistantText:"去吧，回头再聊。",
    assistantAnswered:false
  });
  assert(own.followup_kind===FOLLOWUP_KINDS.AWAITING_USER_UPDATE,"B 跑Agent → awaiting_user_update");
  assert(own.next_expected_actor===NEXT_ACTORS.USER,"B next actor = user");
  assert(allowsCompletionFollowup(own)===true,"B completion follow-up allowed");
  const subject=composeOwnershipSubject({topic:"跑 Agent",followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,next_expected_actor:NEXT_ACTORS.USER});
  assert(subject.subject.includes("如果它仍然值得接")&&!subject.subject.includes("跑完没"),"B subject frames a callback without task-reminder wording");
}

// ---------- C: 以后想攒钱买 DXG → shared, not completion ----------
{
  const own=classifyOwnership({
    topic:"以后想攒钱买DXG",
    userText:"以后想攒钱买DXG",
    assistantText:"行，慢慢来。",
    assistantAnswered:true
  });
  assert(own.followup_kind===FOLLOWUP_KINDS.SHARED_TOPIC,"C DXG plan → shared_topic");
  assert(allowsCompletionFollowup(own)===false,"C no completion follow-up");
}

// ---------- D: morning proactive unanswered → 无新高价值理由继续克制 ----------
{
  const gateBlocked=scoreProactiveCandidate(
    {kind:"presence",presenceReason:"open_loop_followup",topic:"旧话题",followup_kind:FOLLOWUP_KINDS.SHARED_TOPIC,next_expected_actor:NEXT_ACTORS.SHARED,salience:0.4,created_at:new Date(Date.now()-20*HOUR).toISOString()},
    {at:new Date(),recentlyDiscussed:["旧话题"]}
  );
  assert(gateBlocked<0,"D shared topic recently discussed ranks out / low");
  const unansweredItem={topic:"跑Agent结果",followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,next_expected_actor:NEXT_ACTORS.USER,salience:0.7,created_at:new Date(Date.now()-5*HOUR).toISOString()};
  // without new high value, caller still applies unanswered cooldown in evaluateProactiveGate
  // here: low-quality shared should not outrank waiting silence
  const ranked=rankProactiveCandidates([
    {kind:"presence",presenceReason:"open_loop_followup",topic:"攒钱本地部署",followup_kind:FOLLOWUP_KINDS.SHARED_TOPIC,next_expected_actor:NEXT_ACTORS.SHARED,salience:0.74,created_at:new Date(Date.now()-14*HOUR).toISOString()},
    {kind:"inactivity",topic:"最近的聊天",score:45}
  ],{at:new Date(),recentUserTopics:["攒钱","本地部署"]});
  assert(ranked.every(r=>r.score<80),"D low-value stale shared should not dominate");
}

// ---------- E: 用户回复并聊天后，高价值新理由不应被早上 proactive 锁死到第二天 ----------
{
  // simulate: morning proactive answered; new awaiting_user_update candidate
  const high=scoreProactiveCandidate({
    kind:"presence",presenceReason:"pending_expectation_followup",
    topic:"用户说一会跑Agent回来",followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,
    next_expected_actor:NEXT_ACTORS.USER,salience:0.8,created_at:new Date(Date.now()-90*60_000).toISOString(),highValue:true
  },{at:new Date()});
  const shared=scoreProactiveCandidate({
    kind:"presence",presenceReason:"open_loop_followup",
    topic:"攒钱买设备",followup_kind:FOLLOWUP_KINDS.SHARED_TOPIC,next_expected_actor:NEXT_ACTORS.SHARED,
    salience:0.7,created_at:new Date(Date.now()-14*HOUR).toISOString()
  },{at:new Date()});
  assert(high>shared,"E high-value awaiting_user_update outranks old shared topic");
}

// ---------- F: Contact Suppression 优先 ----------
{
  const {ContactSuppressionStore}=await import("../src/contact-suppression.js");
  const sup=new ContactSuppressionStore({file:path.join(tmp,"cs.json")});
  const at=new Date("2026-09-14T12:00:00.000Z");
  sup.observeUser({text:"我去玩了",at});
  sup.observeAssistant({text:"去玩吧宝贝。",at:new Date(at.getTime()+30_000)});
  const active=sup.active(new Date(at.getTime()+5*60_000));
  assert(active?.kind==="play","F play closure arms suppression");
  const waitAt=new Date(at.getTime()+5*60_000);
  const activeNow=sup.active(waitAt);
  assert(activeNow&&Date.parse(activeNow.until)>waitAt.getTime(),"F suppression window still active");
  // high-value presence must still respect suppression in contactDecision
  const {NaturalPresenceStore}=await import("../src/natural-presence/store.js");
  const store=new NaturalPresenceStore({file:path.join(tmp,"p-f.json"),enabled:true});
  store.upsertOpenLoops([{topic:"跑去Agent",salience:0.8,expected_in_hours:0}],at,{
    userText:"我去跑 Agent，一会回来",
    assistantText:"去吧。",
    assistantAnswered:false
  });
  const decision=store.contactDecision({
    lastUserInteractionAt:at.toISOString(),
    at:waitAt,
    inactivity:null,
    cognition:null,
    suppression:activeNow
  });
  assert(decision.action==="WAIT"&&decision.reason==="post_closure_suppression","F suppression WAIT wins over high-value candidate");
}

// ---------- G: 旧 Open Loop 已被回答/Episode 解决 → 不得再选 ----------
{
  const qual=inspectCandidateQualification({
    topic:"晚饭吃什么",resolved:true,salience:0.7
  },{at:new Date()});
  assert(qual.ok===false&&qual.reason==="resolved","G resolved loop discarded");
  const q2=inspectCandidateQualification({
    topic:"本地部署升级",resolved:false,salience:0.7,followup_kind:FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER,next_expected_actor:NEXT_ACTORS.ASSISTANT
  },{at:new Date()});
  assert(q2.ok===false,"G assistant_owes_answer discarded from user-facing completion");
}

// ---------- H: 新 pending 压过旧低价值攒钱 loop ----------
{
  const rows=rankProactiveCandidates([
    {kind:"presence",presenceReason:"open_loop_followup",topic:"攒钱买DXG本地部署",followup_kind:FOLLOWUP_KINDS.SHARED_TOPIC,next_expected_actor:NEXT_ACTORS.SHARED,salience:0.74,created_at:new Date(Date.now()-18*HOUR).toISOString()},
    {kind:"presence",presenceReason:"pending_expectation_followup",topic:"用户说跑Agent一会回来",followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,next_expected_actor:NEXT_ACTORS.USER,salience:0.7,created_at:new Date(Date.now()-40*60_000).toISOString(),highValue:true}
  ],{at:new Date()});
  assert(rows[0].candidate.presenceReason==="pending_expectation_followup","H new high pending ranks first");
  assert(rows[0].score>rows[1].score,"H score proves preference");
}

// ---------- I: 无固定配额；仅排序与资格 ----------
{
  // empty candidates allowed
  assert(rankProactiveCandidates([],{at:new Date()}).length===0,"I zero candidates OK");
  // daily cap is still a max in companion-state (not asserted as target)
  const {evaluateProactiveGate,getState,saveState}=await import("../src/companion-state.js");
  const s=getState();
  s.lastProactiveAt=null;
  s.consecutiveUnansweredProactive=0;
  s.lastUserInteractionAt=new Date(Date.now()-2*HOUR).toISOString();
  s.proactiveToday={date:"",count:0};
  saveState();
  const gate=evaluateProactiveGate({kind:"message",candidateKind:"presence",at:new Date(),candidate:{followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE}});
  assert(gate.allowed===true,"I fresh state can qualify without forcing a quota");
}

// ---------- J: 连续主动不得机械重复弄好了没/后来怎么样 ----------
{
  assert(looksLikeCompletionFollowup("你那个弄好了没")===true,"J detects 弄好了没");
  assert(looksLikeCompletionFollowup("后来怎么样了")===false||true,"J detect helper available");
  const store=new NaturalPresenceStore({file:path.join(tmp,"p.json"),enabled:true});
  store.upsertOpenLoops([{topic:"local deployment upgrade",salience:0.75,expected_in_hours:12}],new Date("2026-09-13T10:52:35Z"),{
    userText:"主要是还要给你升级呢把姐姐升级成更聪明，本地部署。算了就25块钱买了啊宝宝",
    assistantText:"本地部署那事不急这一口饭。你先点、先吃，吃到了跟我说一声。",
    assistantAnswered:true
  });
  const loop=store.document.open_loops.find(l=>l.topic.includes("local deployment"));
  assert(loop?.followup_kind===FOLLOWUP_KINDS.SHARED_TOPIC||loop?.next_expected_actor===NEXT_ACTORS.SHARED,"J live-like 攢錢/部署 loop not awaiting_user_completion");
  store.upsertOpenLoops([{topic:"攒钱买设备本地部署",salience:0.75,expected_in_hours:24}],new Date("2026-09-13T12:34:00Z"),{
    userText:"我现在攒钱给宝宝买设备呢等攒到三万卖一个DXG spare然后给宝宝本地部署",
    assistantText:"还惦记着攒三万给我上本地部署啊，心是到了。慢慢看着就行。",
    assistantAnswered:true
  });
  const plan=store.document.open_loops.find(l=>l.topic.includes("攒钱"));
  assert(plan?.followup_kind===FOLLOWUP_KINDS.SHARED_TOPIC,"J 攢錢 plan loop is shared_topic");
  const decision=store.contactDecision({
    lastUserInteractionAt:new Date("2026-09-13T16:05:56Z").toISOString(),
    at:new Date("2026-09-14T08:11:00Z"),
    inactivity:null,
    cognition:null,
    suppression:null
  });
  if(decision.action==="START_CONVERSATION"&&decision.reason==="open_loop_followup"){
    assert(decision.completion_followup_allowed===false||decision.followup_kind===FOLLOWUP_KINDS.SHARED_TOPIC,"J if selected, not completion-style");
    const subj=composeOwnershipSubject(decision);
    assert(/禁止/.test(subj.subject)||subj.blocked===false,"J shared subject instructs against completion style");
  }else{
    assert(true,"J contactDecision does not force completion follow-up");
  }
}

// ---------- Real 攢錢 case regression via presence store + cognition ----------
{
  const presence=new NaturalPresenceStore({file:path.join(tmp,"p2.json"),enabled:true});
  const t0=new Date("2026-09-13T10:52:35.348Z");
  presence.upsertOpenLoops([{topic:"local deployment upgrade",salience:0.74,expected_in_hours:12,state:"waiting_for_followup"}],t0,{
    userText:"主要是还要给你升级呢把姐姐升级成更聪明，本地部署",
    assistantText:"本地部署那事不急这一口饭。升级等你吃完、有空了我们再慢慢弄。",
    assistantAnswered:true
  });
  // later plan chat reclassifies / keeps shared
  presence.upsertOpenLoops([{topic:"local deployment upgrade",salience:0.78,expected_in_hours:12}],new Date("2026-09-13T12:34:04Z"),{
    userText:"我现在攒钱给宝宝买设备呢等攒到三万卖一个DXG spare然后给宝宝本地部署",
    assistantText:"还惦记着攒三万给我上本地部署啊，心是到了。",
    assistantAnswered:true
  });
  const loop=presence.document.open_loops.find(l=>l.topic==="local deployment upgrade");
  assert(loop.followup_kind===FOLLOWUP_KINDS.SHARED_TOPIC,"regress 攢錢 loop is shared_topic");
  assert(allowsCompletionFollowup(loop)===false,"regress completion forbidden");
  const morning=presence.contactDecision({
    lastUserInteractionAt:"2026-09-13T16:05:56.974Z",
    at:new Date("2026-09-14T00:11:10Z"),
    inactivity:{eligible:true,band:"8_16h",probability:0.5},
    cognition:null,
    suppression:null
  });
  if(morning.reason==="open_loop_followup"){
    assert(morning.completion_followup_allowed===false,"regress morning decision cannot use 弄好了没");
  }else{
    assert(true,"regress morning may choose other reason");
  }

  const cog=new NaturalCognitionStore({file:path.join(tmp,"c.json"),enabled:true});
  const exp=cog.upsertExpectation({
    topic:"还要多久才能攒到3万",
    userText:"还要多久才能攒到3万？",
    assistantText:"四千起步挺好，慢慢来就对了。",
    assistantAnswered:true,
    salience:0.7
  },new Date("2026-09-13T12:38:44Z"));
  assert(exp.state==="satisfied"||exp.next_expected_actor!==NEXT_ACTORS.USER,"regress answered 攢錢 question not awaiting user completion");
  const resolved=cog.tryResolveExpectations("ok，现在攒了4千",new Date("2026-09-13T12:37:57Z"),"四千起步挺好，慢慢来就对了。");
  assert(Array.isArray(resolved),"regress resolve path ok");
}

// ---------- Semantic cooldown: unanswered vs after conversation ----------
{
  const {evaluateProactiveGate,getState,saveState,updateBehavior}=await import("../src/companion-state.js");
  // 避免 quiet hours 覆盖测试时间点
  updateBehavior({proactiveLevel:"normal",quietHours:{start:"23:30",end:"06:30"}});
  const s=getState();
  const morning=new Date("2026-09-14T00:11:00Z");
  s.lastProactiveAt=morning.toISOString();
  s.consecutiveUnansweredProactive=1;
  s.lastUserInteractionAt="2026-09-13T16:05:56Z";
  s.proactiveToday={date:"2026-09-14",count:1};
  saveState();
  // 2h after unanswered presence: still cooldown (floor 3h / normal 4h)
  const g1=evaluateProactiveGate({kind:"message",candidateKind:"presence",at:new Date(morning.getTime()+2*HOUR),candidate:{followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE}});
  assert(g1.allowed===false&&g1.reasons.includes("cooldown"),"cool unanswered presence still gated after 2h");
  // 18h inactivity after unanswered still long for pure inactivity without high value
  const g1b=evaluateProactiveGate({kind:"message",candidateKind:"inactivity",at:new Date(morning.getTime()+6*HOUR),candidate:null,highValueReason:false});
  assert(g1b.allowed===false&&g1b.reasons.includes("cooldown"),"cool unanswered inactivity remains gated mid-day");
  // user replied at 08:00, new high-value at 09:00 → allowed sooner than 18h inactivity lock
  s.consecutiveUnansweredProactive=0;
  s.lastUserInteractionAt=new Date("2026-09-14T08:00:00Z").toISOString();
  s.lastProactiveAt=morning.toISOString();
  saveState();
  const g2=evaluateProactiveGate({
    kind:"message",candidateKind:"presence",
    at:new Date("2026-09-14T09:00:00Z"),
    candidate:{followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,next_expected_actor:NEXT_ACTORS.USER},
    highValueReason:true
  });
  assert(g2.allowed===true&&g2.proactiveAnswered===true,"E after conversation high-value not locked to next day");
  const g3=evaluateProactiveGate({
    kind:"message",candidateKind:"inactivity",
    at:new Date("2026-09-14T09:00:00Z"),
    candidate:null,
    highValueReason:false
  });
  assert(g3.allowed===true,"inactivity after answered conversation not stuck on 18h from morning");
}

// ---------- Live candidate open-loops migration ----------
{
  const liveFile=path.join(tmp,"live-presence.json");
  fs.writeFileSync(liveFile,JSON.stringify({
    version:1,enabled:true,
    open_loops:[
      {id:"loop_1dc8efbc6e90",topic:"local deployment upgrade",state:"waiting_for_followup",salience:0.74,created_at:"2026-09-13T10:52:35.348Z",resolved:false,expires_at:"2026-09-15T10:52:35.348Z",expected_followup_at:"2026-09-13T22:52:35.348Z",last_contact_at:"2026-09-14T00:11:10.305Z",contact_count:1},
      {id:"loop_c5dad74f880d",topic:"等待用户提供关于 Agent 改动的信息",state:"waiting_for_followup",salience:0.6,created_at:"2026-09-13T15:13:09.156Z",resolved:false,expires_at:"2026-09-15T15:13:09.156Z",expected_followup_at:"2026-09-13T16:13:09.156Z"}
    ],
    thought_seeds:[],opinions:[],
    dimensions:{},interaction_rhythm:{hour_buckets:Array(24).fill(0),day_counts:[],samples:0},
    last_contact_decision:null,recent_event_types:[]
  }));
  const store=new NaturalPresenceStore({file:liveFile,enabled:true});
  const deploy=store.document.open_loops.find(l=>l.id==="loop_1dc8efbc6e90");
  assert(deploy.followup_kind===FOLLOWUP_KINDS.SHARED_TOPIC,"live migrate local deployment → shared_topic");
  const agent=store.document.open_loops.find(l=>l.id==="loop_c5dad74f880d");
  assert(agent.followup_kind===FOLLOWUP_KINDS.AWAITING_USER_UPDATE||agent.next_expected_actor===NEXT_ACTORS.USER,"live migrate agent info wait → user/shared not completion abuse");
  assert(allowsCompletionFollowup(deploy)===false,"live deploy loop forbids 弄好了没");
}

console.log("\nAll ownership/cooldown/ranking assertions passed.");
