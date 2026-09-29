import assert from "node:assert/strict";

// Offline unit tests for 出场与离场：A reply latency / C closure / B silence stance.

const { planFirstReplyLatency, detectUrgency, messageWeight, awaitFirstReplyLatency, sleepWithSignal } = await import("../src/reply-latency.js");
const { detectClosure, applyClosureToBubbles, closureGuidanceBlock } = await import("../src/closure-sensing.js");
const { selectReturnStance, stanceGuidanceBlock, RETURN_STANCES } = await import("../src/silence-return-stance.js");

function ok(v,m){ assert.ok(v,m); console.log(`OK  ${m}`); }

// ---------- A ----------
{
  const u=detectUrgency("？？？");
  ok(u.urgent,"A urgency punct");
  const u2=detectUrgency("在吗");
  ok(u2.urgent,"A urgency 在吗");
  const n=detectUrgency("今天天气不错");
  ok(!n.urgent,"A non-urgent normal text");

  ok(messageWeight("为什么这个方案会失败？帮我分析一下对比") === "heavy","A heavy weight");
  ok(messageWeight("哈哈") === "light","A light weight");

  const healthy=planFirstReplyLatency({
    userText:"哈哈",
    presence:{dimensions:{energy:{current:0.8},irritation:{current:0.05},mood:{current:0.4}}},
    seed:"a1"
  });
  ok(healthy.enabled && healthy.delayMs>=80 && healthy.delayMs<=9000,"A healthy within floor/cap");
  ok(healthy.tier==="normal",`A healthy normal tier (${healthy.tier})`);
  ok(healthy.delayMs>=250,"A healthy not 100ms fake delay");

  // 1) low mood alone must not enter snappy
  const lowMood=planFirstReplyLatency({
    userText:"随便聊聊今天的事",
    presence:{dimensions:{energy:{current:0.65},irritation:{current:0.08},mood:{current:-0.7}}},
    seed:"a-mood"
  });
  ok(lowMood.tier==="normal",`A low mood alone not snappy (${lowMood.tier})`);
  ok(!lowMood.reasons.some(r=>r.includes("mood")),`A no mood speed reason (${lowMood.reasons.join(",")})`);
  ok(lowMood.delayMs>=250,"A low mood alone not ~100ms");

  // 2) low mood + low energy → slower
  const lowMoodTired=planFirstReplyLatency({
    userText:"随便聊聊今天的事",
    presence:{dimensions:{energy:{current:0.25},irritation:{current:0.08},mood:{current:-0.7}}},
    seed:"a-mood-tired"
  });
  ok(["thoughtful","drained"].includes(lowMoodTired.tier),`A low mood + low energy slower (${lowMoodTired.tier})`);
  ok(lowMoodTired.delayMs>lowMood.delayMs,"A tired slower than normal-energy low mood");

  // 3) high irritation + enough energy + short → snappy
  const irritable=planFirstReplyLatency({
    userText:"行",
    presence:{dimensions:{energy:{current:0.65},irritation:{current:0.62},mood:{current:0.1}}},
    seed:"a-irr"
  });
  ok(irritable.tier==="snappy",`A irritated+energy snappy (${irritable.tier})`);
  ok(irritable.reasons.includes("irritated_snappy"),"A irritated_snappy reason");

  // 4) urgency still compresses
  const urge=planFirstReplyLatency({
    userText:"？？",
    presence:{dimensions:{energy:{current:0.25},irritation:{current:0.1},mood:{current:0}}},
    seed:"a3"
  });
  ok(urge.tier==="snappy","A urgent compresses even when tired");
  ok(urge.delayMs<=urge.capMs,"A hard cap respected");
  ok(planFirstReplyLatency({
    userText:"快点回我",
    presence:{dimensions:{energy:{current:0.7},irritation:{current:0.1},mood:{current:0.3}}},
    seed:"a-urge2"
  }).tier==="snappy","A 快点 urge snappy");
  ok(planFirstReplyLatency({
    userText:"在吗",
    presence:{dimensions:{energy:{current:0.7},irritation:{current:0.05},mood:{current:0.2}}},
    seed:"a-urge3"
  }).tier==="snappy","A 在吗 snappy");

  // 5) normal mood casual chat keeps natural delay
  const casual=planFirstReplyLatency({
    userText:"今天天气不错",
    presence:{dimensions:{energy:{current:0.68},irritation:{current:0.08},mood:{current:0.18}}},
    seed:"a-casual"
  });
  ok(casual.tier==="normal",`A casual normal (${casual.tier})`);
  ok(casual.delayMs>=250&&casual.delayMs<=1800,"A casual natural band");

  const drained=planFirstReplyLatency({
    userText:"今天有点累，随便聊聊",
    presence:{dimensions:{energy:{current:0.22},irritation:{current:0.1},mood:{current:-0.1}}},
    seed:"a2"
  });
  ok(["thoughtful","drained"].includes(drained.tier),`A drained prefers longer (${drained.tier})`);
  ok(drained.delayMs>=1200,"A drained min band");

  const heavy=planFirstReplyLatency({
    userText:"为什么这个方案会失败？帮我分析一下对比，顺便复盘昨天的 bug",
    presence:{dimensions:{energy:{current:0.7},irritation:{current:0.05},mood:{current:0.2}}},
    seed:"a-heavy"
  });
  ok(["normal","thoughtful"].includes(heavy.tier)&&!heavy.reasons.includes("low_mood_slightly_faster"),`A heavy thoughtful/normal (${heavy.tier})`);
  ok(heavy.delayMs>casual.delayMs||heavy.tier==="thoughtful","A heavy slower or thoughtful");

  const disabled=planFirstReplyLatency({userText:"hi",enabled:false});
  ok(disabled.delayMs===0 && disabled.enabled===false,"A can disable");

  const agent=planFirstReplyLatency({userText:"hi",source:"agent"});
  ok(agent.enabled===false,"A skips agent source");

  const t0=Date.now();
  const waited=await awaitFirstReplyLatency({...healthy,delayMs:120});
  ok(waited.waited>=100,"A await waits roughly delay");
  ok(Date.now()-t0>=100,"A wall clock advanced");

  const ac=new AbortController();
  const p=awaitFirstReplyLatency({...healthy,delayMs:5000}, {signal:ac.signal});
  setTimeout(()=>ac.abort(),30);
  const abortRes=await p;
  ok(abortRes.interrupted===true,"A abort cancels wait");

  await sleepWithSignal(5);
  ok(true,"A sleepWithSignal resolves");
}

// ---------- C ----------
{
  const leave=detectClosure({userText:"我去洗澡了"});
  ok(leave.likely && leave.strength==="strong" && leave.kind==="leave","C leave strong");

  const sleep=detectClosure({userText:"晚安"});
  ok(sleep.likely && sleep.strength==="strong","C 晚安 strong");

  const done=detectClosure({userText:"搞定了，谢了"});
  ok(done.likely && done.strength==="medium" && done.kind==="done","C done medium");

  const soft=detectClosure({userText:"嗯嗯"});
  ok(soft.likely && soft.strength==="weak","C soft ack weak");

  const chat=detectClosure({userText:"我们继续聊那个 TTS 停顿的问题"});
  ok(!chat.likely,"C normal chat not closure");

  const again=detectClosure({userText:"我去洗澡了"});
  const trimmed=applyClosureToBubbles(["好","那我先说下 Agent 的事其实还有…","其实我还没讲完"],again);
  ok(trimmed.bubbles.length===1 && trimmed.trimmed,"C strong trims to 1");

  const med=applyClosureToBubbles(["1","2","3"],detectClosure({userText:"搞定了，谢了"}));
  ok(med.bubbles.length===2 && med.trimmed,"C medium max2");

  const guidance=closureGuidanceBlock(leave);
  ok(guidance.includes("轻轻放手") && guidance.includes("收尾识别"),"C guidance present");
  ok(closureGuidanceBlock(chat)==="","C no guidance when not closing");

  const disabled=detectClosure({userText:"晚安",enabled:false});
  ok(!disabled.likely,"C can disable");
}

// ---------- B ----------
{
  ok(RETURN_STANCES.practical==="practical","B stance enum");

  const shortGap=selectReturnStance({
    silenceHours:2,
    presence:{dimensions:{energy:{current:0.7},irritation:{current:0.1},mood:{current:0.2},social_drive:{current:0.6},closeness:{current:0.6}}},
    openLoops:[],
    pendingExpectations:[]
  });
  ok(shortGap.stance==="light_return","B short gap light");

  const irritated=selectReturnStance({
    silenceHours:20,
    presence:{dimensions:{energy:{current:0.6},irritation:{current:0.55},mood:{current:-0.2},social_drive:{current:0.5},closeness:{current:0.6}}},
    openLoops:[],
    pendingExpectations:[]
  });
  ok(irritated.stance==="mild_edge","B irritated long gap mild_edge");

  const loop=selectReturnStance({
    silenceHours:10,
    presence:{dimensions:{energy:{current:0.7},irritation:{current:0.1},mood:{current:0.2},social_drive:{current:0.6},closeness:{current:0.7}}},
    openLoops:[{topic:"Agent跑测试",salience:0.8,resolved:false}],
    pendingExpectations:[]
  });
  ok(loop.stance==="practical","B open loop → practical");

  const pending=selectReturnStance({
    silenceHours:8,
    presence:{dimensions:{energy:{current:0.7},irritation:{current:0.05},mood:{current:0.1},social_drive:{current:0.55},closeness:{current:0.65}}},
    openLoops:[],
    pendingExpectations:[{state:"pending",topic:"跑完没",salience:0.75,id:"e1"}]
  });
  ok(pending.stance==="practical","B pending expectation → practical");

  const drained=selectReturnStance({
    silenceHours:12,
    presence:{dimensions:{energy:{current:0.2},irritation:{current:0.1},mood:{current:0.1},social_drive:{current:0.4},closeness:{current:0.6}}},
    openLoops:[],
    pendingExpectations:[]
  });
  ok(drained.stance==="cool_space","B drained → cool_space");

  const rhythm=selectReturnStance({
    silenceHours:5,
    presence:{dimensions:{energy:{current:0.7},irritation:{current:0.1},mood:{current:0.2},social_drive:{current:0.6},closeness:{current:0.6}}},
    openLoops:[],
    pendingExpectations:[],
    rhythmMiss:{expected:true}
  });
  ok(rhythm.stance==="checking_in","B rhythm miss → checking_in");

  const longCloseness=selectReturnStance({
    silenceHours:24,
    presence:{dimensions:{energy:{current:0.7},irritation:{current:0.1},mood:{current:0.2},social_drive:{current:0.6},closeness:{current:0.7}}},
    openLoops:[],
    pendingExpectations:[]
  });
  ok(longCloseness.stance==="checking_in","B long silence closeness → checking_in");

  const g=stanceGuidanceBlock(loop);
  ok(g.includes("practical") && g.includes("未完成") && !g.includes("你去哪了"),"B guidance constraints not canned line");
  ok(stanceGuidanceBlock({stance:"light_return",enabled:false})==="","B disabled guidance empty");
}

console.log("\nPASS 出场与离场 unit: A latency / C closure / B silence stance");
