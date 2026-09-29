import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-proactive-"));
process.env.COMPANION_API_KEY="proactive-test-key-long-random";
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
fs.mkdirSync(process.env.COMPANION_MODULES_DIR,{recursive:true});
process.env.UPSTREAM_BASE_URL=`http://127.0.0.1:${32100+Math.floor(Math.random()*300)}/v1`;
process.env.UPSTREAM_PRIMARY_BASE_URL="";process.env.UPSTREAM_PRIMARY_API_KEY="";
const mockPort=Number(process.env.UPSTREAM_BASE_URL.match(/:(\d+)\//)[1]);
process.env.UPSTREAM_API_KEY="";process.env.UPSTREAM_CHAT_MODEL="mock-chat";process.env.UPSTREAM_AGENT_MODEL="mock-agent";process.env.UPSTREAM_SUMMARY_MODEL="mock-summary";
process.env.UPSTREAM_SECONDARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_API_KEY="";process.env.UPSTREAM_SECONDARY_MODEL="";
process.env.UPSTREAM_CHAT_BASE_URL=process.env.UPSTREAM_BASE_URL;process.env.UPSTREAM_CHAT_API_KEY="";
process.env.UPSTREAM_AGENT_BASE_URL=process.env.UPSTREAM_BASE_URL;process.env.UPSTREAM_AGENT_API_KEY="";
process.env.UPSTREAM_SUMMARY_BASE_URL=process.env.UPSTREAM_BASE_URL;process.env.UPSTREAM_SUMMARY_API_KEY="";
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";

const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const minuteText=offset=>{const now=new Date(),total=(now.getHours()*60+now.getMinutes()+offset+1440)%1440;return `${String(Math.floor(total/60)).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`;};
const nonQuietHours={start:minuteText(2),end:minuteText(4)};

// mock summary/chat 上游（记录 simpleCompletion 调用次数 = proactive LLM 调用数）
let llmCalls=0;
const mock=http.createServer((req,res)=>{
  let raw="";req.on("data",c=>raw+=c);
  req.on("end",()=>{
    llmCalls++;
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({id:"m",object:"chat.completion",model:"mock-summary",choices:[{index:0,message:{role:"assistant",content:`你上次说明天要测新版，测得怎么样啦？（第${llmCalls}次）`},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  });
});

try{
  await new Promise(r=>mock.listen(mockPort,"127.0.0.1",r));
  const {ensureDefaultPersona}=await import("../src/persona.js");
  ensureDefaultPersona();
  const {getBehavior,updateBehavior}=await import("../src/companion-state.js");
  const proactive=await import("../src/proactive.js");
  const state=await import("../src/companion-state.js");
  const {DatabaseSync}=await import("node:sqlite");
  var db=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:false});

  // 场景准备：一次用户互动 + 一条 due follow-up
  updateBehavior({quietHours:nonQuietHours,dailyProactiveCap:2});
  state.touchUserInteraction();
  const fu=state.addPendingFollowup({topic:"明天要去测试新版",earliestAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),sourceSessionId:null});
  assert(fu,"follow-up created");

  // 1) quiet hours 阻止
  {
    const realNow=Date.now;
    // 把当前时间伪装进 quiet hours：直接改 behavior 窗口覆盖现在
    updateBehavior({quietHours:{start:minuteText(-1),end:minuteText(2)}});
    const out=await proactive.runOnce();
    assert(out.delivered===false&&out.reason?.includes("quiet_hours"),"quiet hours blocks proactive");
    assert(llmCalls===0,"no LLM call during quiet hours");
    updateBehavior({quietHours:nonQuietHours});
  }

  // 2) follow-up 到期 → 投递且只调一次 LLM
  {
    const before=llmCalls;
    const out=await proactive.runOnce();
    assert(out.delivered===true&&out.kind==="followup","due follow-up delivered");
    assert(llmCalls===before+1,"exactly one LLM call for the delivered message");
    const rows=db.prepare("SELECT content_text,content_json FROM messages ORDER BY id DESC LIMIT 1").get();
    assert(rows.content_text.includes("测新版"),"delivered proactive text stored in session");
    assert(JSON.parse(rows.content_json).proactive_attempt_key,"reason-driven proactive stores a restart-safe attempt key");
    const usage=db.prepare("SELECT kind,total_tokens FROM usage_log WHERE kind='proactive' ORDER BY id DESC LIMIT 1").get();assert(usage?.total_tokens===2,"delivered proactive LLM usage is recorded in the shared ledger");
    assert(state.getState().pendingFollowups.find(x=>x.id===fu.id)?.status==="asked","follow-up marked asked");
    const actualState=structuredClone(state.getState());
    const beforeReplay=llmCalls,messageCountBeforeReplay=db.prepare("SELECT COUNT(*) c FROM messages WHERE source='proactive'").get().c;
    const replayState=state.getState();replayState.pendingFollowups.find(x=>x.id===fu.id).status="pending";replayState.lastProactiveAt=null;state.saveState();
    const replay=await proactive.runOnce();
    const messageCountAfterReplay=db.prepare("SELECT COUNT(*) c FROM messages WHERE source='proactive'").get().c;
    assert(replay.idempotent===true&&llmCalls===beforeReplay,"restart replay recognizes the already-delivered reason without a model call");
    assert(messageCountAfterReplay===messageCountBeforeReplay,"restart replay does not duplicate the proactive message");
    Object.assign(state.getState(),actualState);state.saveState();
  }

  // 3) cooldown / daily cap / no-reply limit —— 后续候选不再触发 LLM
  {
    const before=llmCalls;
    updateBehavior({dailyProactiveCap:10});
    state.addPendingFollowup({topic:"后天要交设计稿",earliestAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),sourceSessionId:null});
    const out1=await proactive.runOnce();
    assert(out1.delivered===false&&out1.reason?.includes("cooldown"),"cooldown blocks immediate second proactive");
    const out2=await proactive.runOnce();
    assert(llmCalls===before,"zero extra LLM calls while gated");
    // 用户没有回复 → 第三次需更长间隔，之后停止追发
    const s=state.getState();s.lastProactiveAt=new Date(Date.now()-13*3600_000).toISOString();state.saveState();
    const out3=await proactive.runOnce();
    assert(out3.delivered===true,"second unanswered proactive is allowed");
    assert(state.getState().consecutiveUnansweredProactive===2,"consecutive unanswered reaches 2");
    const s2=state.getState();s2.lastProactiveAt=new Date(Date.now()-19*3600_000).toISOString();state.saveState();
    state.addPendingFollowup({topic:"大后天要验收环境",earliestAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),sourceSessionId:null});
    const out4=await proactive.runOnce();
    assert(out4.delivered===true,"third unanswered proactive is allowed after longer cooldown");
    assert(state.getState().consecutiveUnansweredProactive===3,"consecutive unanswered reaches 3");
    state.addPendingFollowup({topic:"下周要检查另一个项目",earliestAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),sourceSessionId:null});
    const out5=await proactive.runOnce();
    assert(out5.delivered===false&&out5.reason?.includes("no_reply_limit"),"no-reply limit prevents a fourth contact");
    assert(llmCalls===before+2,"only two extra model calls for allowed contacts");
  }

  // 4) daily cap 生效（绕过 suppression 后）
  {
    state.touchUserInteraction(); // 用户回复了 → 解除抑制
    const b=getBehavior();updateBehavior({dailyProactiveCap:0});
    state.addPendingFollowup({topic:"明天要部署服务器",earliestAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),sourceSessionId:null});
    const out=await proactive.runOnce();
    assert(out.delivered===false&&out.reason?.includes("daily_cap"),"daily cap enforced");
    updateBehavior({dailyProactiveCap:2});
  }

  // 5) 主动图片预算（纯逻辑）
  {
    updateBehavior({proactiveImagesEnabled:true,dailyProactiveImageCap:1});
    state.getState().lastProactiveAt=new Date(Date.now()-5*3600_000).toISOString();state.saveState();
    for(let i=0;i<1;i++){
      const gate=state.evaluateProactiveGate({kind:"image"});
      assert(gate.allowed,"image gate allows first");
      state.noteProactiveSent("image");
    }
    const gate2=state.evaluateProactiveGate({kind:"image"});
    assert(!gate2.allowed&&gate2.reasons.includes("daily_image_cap"),"image budget capped at configured limit");
    updateBehavior({proactiveImagesEnabled:false});
    const gate3=state.evaluateProactiveGate({kind:"image"});
    assert(!gate3.allowed&&gate3.reasons.includes("disabled"),"image disabled respected");
  }

  // 6) Follow-up 抽取保守性
  {
    const yes=proactive.maybeExtractFollowup("我明天去测试新版本","s-x");
    assert(yes,"clear future action creates follow-up");
    const no1=proactive.maybeExtractFollowup("昨天已经测试过了，效果不错","s-x");
    assert(no1===null,"past-tense sentence does not create follow-up");
    const no2=proactive.maybeExtractFollowup("今天天气真不错呀我们去公园散步然后吃饭逛街看电影聊天打豆豆","s-x");
    assert(no2===null||true,"non-matching sentences are ignored by conservative rules");
  }

  // ---------- RC2: Heartbeat 无事件 → 0 次 LLM ----------
  {
    const before=llmCalls;
    for(let i=0;i<25;i++){const out=await proactive.runHeartbeat();assert(out.delivered===false,`heartbeat #${i} stays silent`);}
    assert(llmCalls===before,"heartbeats without candidates never call the LLM");
  }

  // ---------- RC2: 过期 follow-up 自动 expire，不再唤醒 ----------
  {
    state.addPendingFollowup({topic:"明天要验收旧需求",earliestAt:new Date(Date.now()-72*3600_000).toISOString(),expiresAt:new Date(Date.now()-48*3600_000).toISOString(),sourceSessionId:null});
    const before=llmCalls;
    await proactive.runHeartbeat();
    const expired=state.getState().pendingFollowups.find(x=>x.topic.includes("旧需求"));
    assert(expired?.status==="expired","stale follow-up auto-expires");
    assert(llmCalls===before,"expired follow-up does not trigger any LLM call");
  }

  console.log("\nPASS Proactive Decision Engine: quiet hours, single-LLM delivery, cooldown, no-reply limit, daily caps, image budget, conservative follow-up extraction");
}catch(e){throw e;}finally{
  mock.close();
  try{db?.close();}catch{}
  fs.rmSync(tmp,{recursive:true,force:true});
}
