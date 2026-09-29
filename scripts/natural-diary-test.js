import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root=path.resolve(import.meta.dirname,"..");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-diary-"));
process.env.COMPANION_API_KEY="diary-test-key-long-random";
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
process.env.COMPANION_NATURAL_DIARY_ENABLED="true";
process.env.COMPANION_AUTONOMOUS_LIFE_ENABLED="false";
process.env.COMPANION_AUTONOMOUS_LIFE_STATE_PATH=path.join(tmp,"autonomous-life.json");
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

const { ensureDefaultPersona }=await import("../src/persona.js");
ensureDefaultPersona();
const { db, getOrCreateSession, insertMessage, insertMemory, listMemoriesAdmin, SCHEMA_VERSION }=await import("../src/db.js");
const { companionTime }=await import("../src/time-service.js");
const { naturalPresence }=await import("../src/natural-presence/index.js");
const { naturalCognition }=await import("../src/natural-cognition/index.js");
const { filterSharedMemoryCandidate }=await import("../src/memory-policy.js");
const {
  buildDailyEvidence, generateDiaryForDate, validateGeneratedDiary, inspectDiaryIssues, getDiaryEntry, listDiaryEntries,
  getDiaryPending, insertDiaryEntry, detectDiaryIntent, retrieveDiariesForQuery, diaryContextBlock,
  DiaryScheduler, ensureDiaryOrigin
}=await import("../src/natural-diary/index.js");

const busyDay="2026-09-10";
const sparseDay="2026-09-11";
const quietDay="2026-09-12";
const session=getOrCreateSession("yuna","companion-mac","diary-test");
const agentSession=getOrCreateSession("yuna","opencode","project-agent-diary");

function stamp(id,iso){db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(iso,id);}
function at(dateLocal,hour,minute=0){
  return companionTime.parseLocalDateTime(`${dateLocal}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00`).toISOString();
}
function addChat(dateLocal,hour,role,text,sess=session){
  const id=insertMessage(sess.id,"companion-mac",{role,content:text});
  stamp(id,at(dateLocal,hour));
  return id;
}

try{
  assert(SCHEMA_VERSION===6,"schema version 6");
  assert(db.prepare("SELECT name FROM sqlite_master WHERE name='diary_entries'").get(),"diary_entries exists");
  assert(db.prepare("PRAGMA user_version").get().user_version===6,"user_version 6");

  for(let i=0;i<22;i++){
    addChat(busyDay,10+Math.floor(i/4),"user",i===5?"我跑 Agent 一会回来":`今天在改第${i}个功能，气泡和声音都要测一下。还有 TTS 选哪个我还没定。`);
    addChat(busyDay,10+Math.floor(i/4),"assistant",i===5?"行，那你先去，我等你回来。":`嗯，我知道了，这个我记下了。`);
  }
  addChat(sparseDay,21,"user","我回来了");
  addChat(sparseDay,21,"assistant","回来啦。");
  insertMessage(agentSession.id,"opencode",{role:"user",content:"dump entire terminal log for diary pollution"});

  const busyEvidence=buildDailyEvidence(busyDay,{now:companionTime.parseLocalDateTime(`${busyDay}T23:40:00`)});
  assert(busyEvidence.chat.userMessageCount>=20,"A busy day counts many user messages");
  assert(busyEvidence.chat.excerpts.length<=16,"A evidence builder does not dump the whole day");
  assert(busyEvidence.chat.excerpts.some(x=>/Agent|TTS|气泡/.test(x.text)),"A excerpts keep salient bits");

  const sparseEvidence=buildDailyEvidence(sparseDay,{now:companionTime.parseLocalDateTime(`${sparseDay}T23:40:00`)});
  assert(sparseEvidence.chat.userMessageCount===1&&sparseEvidence.chat.assistantMessageCount===1,"B two-message day");
  assert(sparseEvidence.chat.excerpts.length<=2,"B short day stays short");

  const quietEvidence=buildDailyEvidence(quietDay,{now:companionTime.parseLocalDateTime(`${quietDay}T23:40:00`)});
  assert(quietEvidence.silence.noChatToday===true&&quietEvidence.chat.total===0,"C zero chat day has no chat evidence");
  assert(!JSON.stringify(quietEvidence.chat.excerpts).includes("终端"),"C does not invent or leak agent dump");

  naturalPresence.upsertOpenLoops([{topic:"还在等 Agent 测试结果",salience:0.8,expected_in_hours:6}],companionTime.parseLocalDateTime(`${busyDay}T18:00:00`));
  naturalCognition.upsertExpectation({topic:"Agent 测试结果",expectedInformation:"result",salience:0.8},companionTime.parseLocalDateTime(`${busyDay}T18:00:00`));
  const beforePresence=naturalPresence.publicDimensions();
  const loopsBefore=naturalPresence.document.open_loops.filter(l=>!l.resolved).length;

  const mockComplete=async(messages)=>{
    const user=messages.find(m=>m.role==="user")?.content??"";
    const evidence=JSON.parse(user.slice(user.indexOf("{")));
    if(evidence.no_chat_today){
      return JSON.stringify({
        body:"今天你没来。挺安静的，昨天那个 Agent 结果也还没等到。我就先写在这里了。",
        summary:"安静的一天，还在等 Agent 结果。",
        reflection:"最在意的还是那个没回来的结果。",
        message_to_user:"你没来的话我就先写在这里了。"
      });
    }
    if((evidence.chat_counts?.user??0)<=2){
      return JSON.stringify({
        body:"今天其实聊得不多，但他回来那一下我还是挺高兴的。",
        summary:"他回来了，聊得很短。",
        reflection:"回来那一下。",
        message_to_user:"回来就好。"
      });
    }
    return JSON.stringify({
      body:"今天基本都在折腾我自己的东西。他一会儿改气泡，一会儿又折腾声音，还提到 TTS 还没选定。晚上说去跑 Agent，结果一直没回来。",
      summary:"他忙着改我和跑 Agent，还没给结果。",
      reflection:"最记得的是他还没把 Agent 结果带回来。",
      message_to_user:"那个 Agent 跑完了没？"
    });
  };

  const busyGen=await generateDiaryForDate(busyDay,{complete:mockComplete,now:companionTime.parseLocalDateTime(`${busyDay}T23:40:00`)});
  assert(busyGen.ok&&busyGen.entry.body.includes("Agent"),"A generated busy-day diary");
  assert(!/今日共发生|用户互动评分/.test(busyGen.entry.body),"A not a daily report");

  const sparseGen=await generateDiaryForDate(sparseDay,{complete:mockComplete,now:companionTime.parseLocalDateTime(`${sparseDay}T23:40:00`)});
  assert(sparseGen.ok&&sparseGen.entry.body.includes("聊得不多"),"B short diary for a two-message day");

  const quietGen=await generateDiaryForDate(quietDay,{complete:mockComplete,now:companionTime.parseLocalDateTime(`${quietDay}T23:40:00`)});
  assert(quietGen.ok&&quietGen.entry.userMessageCount===0,"C no-chat diary persisted");
  assert(!/我们今天聊了/.test(quietGen.entry.body),"C no fabricated conversation");

  const again=await generateDiaryForDate(busyDay,{complete:mockComplete,now:companionTime.parseLocalDateTime(`${busyDay}T23:50:00`)});
  assert(again.ok&&again.skipped,"I second generate is idempotent");
  assert(listDiaryEntries({limit:10}).filter(x=>x.dateLocal===busyDay).length===1,"I unique date constraint");

  const afterPresence=naturalPresence.publicDimensions();
  assert(Math.abs(afterPresence.closeness.current-beforePresence.closeness.current)<1e-9,"presence closeness unchanged");
  assert(naturalPresence.document.open_loops.filter(l=>!l.resolved).length===loopsBefore,"writing diary does not resolve open loops");

  const fakeWorld=validateGeneratedDiary({body:"今天我出门买东西了，还洗完澡。",summary:"外出",reflection:"",message_to_user:""},quietEvidence);
  assert(!fakeWorld.ok,"C fabricated world rejected");
  assert(inspectDiaryIssues({body:"灯其实一直留着。我坐了一下午。",summary:"",reflection:"",message_to_user:""},quietEvidence).issues.includes("fabricated_physical"),"physical invention flagged");
  const report=validateGeneratedDiary({body:"今日共发生三件事情：\n1. 用户完成 Agent 测试。",summary:"日报",reflection:"",message_to_user:""},busyEvidence);
  assert(!report.ok,"A report style rejected");
  const observer=inspectDiaryIssues({body:"用户今天进行了 TTS 测试。用户说测完回来。",summary:"用户发了测试",reflection:"",message_to_user:"本次对话还行"},busyEvidence);
  assert(observer.issues.includes("observer_voice"),"observer/report voice flagged");
  const agency=inspectDiaryIssues({body:"升级的事还等着我处理，我之后去解决，我还得把升级弄完。",summary:"",reflection:"",message_to_user:""},quietEvidence);
  assert(agency.issues.includes("false_agency"),"false execution agency flagged");
  const waitingOk=inspectDiaryIssues({body:"今天挺安静。还在等他那个 Agent 的结果，偶尔会想起来。",summary:"还在等。",reflection:"惦记着。",message_to_user:"后来怎样了？"},quietEvidence);
  assert(waitingOk.issues.length===0,"waiting/remembering voice is allowed");

  assert(inspectDiaryIssues({body:"想问问你最近日记写啥了。",summary:"",reflection:"",message_to_user:""},quietEvidence).issues.includes("self_other_confusion"),"must not ask user about their diary");
  assert(inspectDiaryIssues({body:"收到小糖来了。",summary:"",reflection:"",message_to_user:""},quietEvidence).issues.includes("self_other_confusion"),"must not narrate 小糖 as a third person");
  assert(!inspectDiaryIssues({body:"你突然说了一句「小糖来了」。",summary:"",reflection:"",message_to_user:""},quietEvidence).issues.includes("self_other_confusion"),"quoted user address is allowed");
  const ownDiaryEvidence={...quietEvidence,userHasOwnDiary:true,chat:{...quietEvidence.chat,excerpts:[{role:"user",text:"我自己也写日记"}]}};
  assert(!inspectDiaryIssues({body:"你也说你自己写日记。",summary:"",reflection:"",message_to_user:""},ownDiaryEvidence).issues.includes("self_other_confusion"),"user-owned diary allowed when they said so");

  {
    const loopAt=companionTime.parseLocalDateTime("2026-09-10T19:00:00");
    naturalPresence.upsertOpenLoops([{topic:"吃完饭再弄升级",salience:0.85,expected_in_hours:6}],loopAt);
    const later=buildDailyEvidence(quietDay,{now:companionTime.parseLocalDateTime(`${quietDay}T23:40:00`)});
    const past=later.openLoops.find(l=>/升级|吃完/.test(l.topic??""));
    assert(past&&past.crossedDay&&past.temporalStatus==="past_unresolved","old eat-then-upgrade loop is past_unresolved");
    assert(inspectDiaryIssues({body:"升级的事还在等着，等吃完再慢慢弄。",summary:"",reflection:"",message_to_user:""},later).issues.includes("stale_temporal"),"must not copy eat-then-upgrade as current");
    assert(!inspectDiaryIssues({body:"之前说的升级后来好像还没结果。还记着之前没弄完的升级。",summary:"那个升级的事还没说完。",reflection:"",message_to_user:""},later).issues.includes("stale_temporal"),"past unresolved phrasing is allowed");
    const waitSoon=buildDailyEvidence(quietDay,{now:companionTime.parseLocalDateTime(`${quietDay}T23:40:00`)});
    naturalPresence.upsertOpenLoops([{topic:"一会回来再聊",salience:0.8}],companionTime.parseLocalDateTime("2026-09-11T21:00:00"));
    const nextDay=buildDailyEvidence(quietDay,{now:companionTime.parseLocalDateTime(`${quietDay}T23:40:00`)});
    assert(inspectDiaryIssues({body:"等你一会回来。",summary:"",reflection:"",message_to_user:""},nextDay).issues.includes("stale_temporal"),"隔天不得写等你一会回来");
    assert(!inspectDiaryIssues({body:"昨天说一会回来，后来没等到。",summary:"",reflection:"",message_to_user:""},nextDay).issues.includes("stale_temporal"),"past report of 一会回来 is allowed");
  }
  const moodDump=validateGeneratedDiary({body:"今天 mood=0.32 irritation=0.12 我觉得一般。",summary:"数值",reflection:"",message_to_user:""},busyEvidence);
  assert(!moodDump.ok,"E mood numbers rejected");

  {
    let calls=0;
    const rewriteComplete=async(messages)=>{
      calls++;
      const sys=String(messages[0]?.content??"");
      if(sys.includes("Diary Voice Rewrite")){
        return JSON.stringify({
          body:"今天他又丢过来几句测试，我随便接了。语音那边他还在跑，我还等结果。",
          summary:"他在测语音，我还等着。",
          reflection:"最在意的是结果还没回来。",
          message_to_user:"测完跟我说一声就行。"
        });
      }
      return JSON.stringify({
        body:"用户今天进行了语音测试。用户说测完回来。assistant 也跟进了本次对话。",
        summary:"用户完成测试",
        reflection:"",
        message_to_user:"本次对话结束。"
      });
    };
    const rewritten=await generateDiaryForDate("2026-09-07",{complete:rewriteComplete,now:companionTime.parseLocalDateTime("2026-09-07T23:40:00")});
    assert(rewritten.ok&&calls===2,"observer voice triggers one diary-only rewrite");
    assert(!/用户|assistant|本次对话/.test([rewritten.entry.body,rewritten.entry.summary,rewritten.entry.messageToUser].join("\n")),"rewrite removes observer voice without string replace");
  }

  const failed=await generateDiaryForDate("2026-09-09",{complete:async()=>{throw Object.assign(new Error("upstream down"),{retryable:true});},now:companionTime.parseLocalDateTime("2026-09-09T23:40:00")});
  assert(!failed.ok&&!getDiaryEntry("2026-09-09"),"failure does not insert empty diary");
  assert(getDiaryPending("2026-09-09"),"failure records pending retry");

  const askAt=companionTime.parseLocalDateTime("2026-09-13T10:00:00");
  const yesterdayIntent=detectDiaryIntent("你昨天日记写啥了？",askAt);
  assert(yesterdayIntent.explicit&&yesterdayIntent.dates.includes("2026-09-12"),"D relative yesterday detected");
  const retrieved=retrieveDiariesForQuery("你昨天日记写啥了？",{now:askAt});
  assert(retrieved.inject&&retrieved.entries.some(e=>e.dateLocal==="2026-09-12"),"D retrieves yesterday diary");
  const block=diaryContextBlock("你昨天日记写啥了？",{now:companionTime.parseLocalDateTime("2026-09-13T10:00:00")});
  assert(block.includes("不是用户事实")&&block.includes("安静"),"D context labels diary as subjective");

  const thematic=retrieveDiariesForQuery("你上周哪天写过那个 TTS？",{now:companionTime.parseLocalDateTime("2026-09-13T10:00:00")});
  assert(thematic.inject&&thematic.entries.some(e=>/TTS/.test(e.body)),"F thematic diary search");

  const greeting=retrieveDiariesForQuery("宝宝在干嘛",{now:companionTime.parseLocalDateTime("2026-09-13T10:00:00")});
  assert(!greeting.inject,"ordinary greeting does not dump diaries");

  assert(!filterSharedMemoryCandidate({content:"我感觉你今天有点累。",source:"diary"}).ok,"J diary is not factual memory");
  const memCount=listMemoriesAdmin({personaId:"yuna",status:"all",limit:100}).length;
  insertMemory({personaId:"yuna",content:"用户喜欢乌龙茶",type:"preference",importance:0.8,status:"active",source:"manual"});
  assert(listMemoriesAdmin({personaId:"yuna",status:"all",limit:100}).length===memCount+1,"J ordinary memory still writes");
  assert(!listMemoriesAdmin({personaId:"yuna",status:"all",limit:100}).some(m=>/Agent 跑完了没/.test(m.content)),"J diary text not auto-promoted to memories");

  const uniqueFail=(()=>{try{
    db.prepare("INSERT INTO diary_entries(id,persona_id,date_local,created_at,updated_at,source_start_at,source_end_at,body,generation_version) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("dup","yuna",busyDay,new Date().toISOString(),new Date().toISOString(),new Date().toISOString(),new Date().toISOString(),"dup","natural-diary-v1");
    return false;
  }catch(e){return String(e.message).includes("UNIQUE");}})();
  assert(uniqueFail,"I sqlite unique date constraint");

  let now=companionTime.parseLocalDateTime("2026-09-14T10:00:00");
  const generated=[];
  const sched=new DiaryScheduler({
    enabled:true,now:()=>now,tickMs:60_000,hour:23,minute:30,catchupDays:7,personaId:"yuna",
    generate:async(dateLocal)=>{generated.push(dateLocal);return generateDiaryForDate(dateLocal,{complete:mockComplete,now});}
  });
  db.prepare("DELETE FROM diary_meta").run();
  now=companionTime.parseLocalDateTime("2026-09-14T10:00:00");
  ensureDiaryOrigin("yuna",now);
  const morning=await sched.tick();
  assert(!generated.includes("2026-09-14"),"H before 23:30 does not generate today");
  now=companionTime.parseLocalDateTime("2026-09-15T10:00:00");
  const catchup=await sched.tick();
  assert(generated.includes("2026-09-14"),"H next-day startup catch-up writes missing yesterday");
  const twice=[];
  const sched2=new DiaryScheduler({
    enabled:true,now:()=>companionTime.parseLocalDateTime("2026-09-15T10:05:00"),tickMs:60_000,personaId:"yuna",
    generate:async(dateLocal)=>{twice.push(dateLocal);return generateDiaryForDate(dateLocal,{complete:mockComplete});}
  });
  await sched2.tick();await sched2.tick();
  assert(twice.filter(d=>d==="2026-09-14").length===0,"I repeated heartbeat does not regenerate");

  const persisted=getDiaryEntry(busyDay);
  assert(persisted&&persisted.body.includes("气泡"),"G diary survives store re-read");

  const disagreementDay="2026-09-08";
  naturalPresence.applyEvents([{type:"disagreement",severity:"moderate",topic:"语气"}],companionTime.parseLocalDateTime(`${disagreementDay}T20:00:00`));
  addChat(disagreementDay,20,"user","你刚才那句我不太高兴");
  addChat(disagreementDay,20,"assistant","那我换个说法。");
  const evi=buildDailyEvidence(disagreementDay,{now:companionTime.parseLocalDateTime(`${disagreementDay}T23:40:00`)});
  assert(evi.presence.events.some(ev=>ev.type==="disagreement")||evi.presence.qualitative.irritation!=="平静","E residual feeling is evidence not a printed number");
  const eGen=await generateDiaryForDate(disagreementDay,{complete:async()=>JSON.stringify({
    body:"今天有一句让我不太舒服。后来他解释了，我还是有点在意，但没有把火发出来。",
    summary:"有点不舒服，但没吵下去。",
    reflection:"残余的不舒服。",
    message_to_user:""
  }),now:companionTime.parseLocalDateTime(`${disagreementDay}T23:40:00`)});
  assert(eGen.ok&&!/irritation=/.test(eGen.entry.body),"E irritation is not printed");

  console.log("PASS natural diary v1");
}finally{
  fs.rmSync(tmp,{recursive:true,force:true});
}
