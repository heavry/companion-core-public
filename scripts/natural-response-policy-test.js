import assert from "node:assert/strict";
import fs from "node:fs";
import { analyzeNaturalResponse,inspectNaturalResponseCandidate,naturalResponsePolicyBlock,selectNaturalResponsePolicy } from "../src/natural-response-policy.js";

function select(userText,extra={}){
  return selectNaturalResponsePolicy({
    userText,
    closure:{likely:false,strength:"none",kind:null},
    grounding:{relation:"CONTINUE",confidence:0.8},
    recurrence:{kind:"NEW"},
    presence:{dimensions:{playfulness:{current:0.78}}},
    recentAssistantTexts:[],recentEpisodes:[],openLoops:[],expectations:[],
    ...extra
  });
}

const report=select("宝宝我刚下课，终于回家了",{recentEpisodes:[{topic:"home",stale:false}]});
assert.deepEqual(report,select("宝宝我刚下课，终于回家了",{recentEpisodes:[{topic:"home",stale:false}]}),"same causes produce same act without randomness");
assert.equal(report.primaryAct,"REACT");
assert.equal(report.contextDisposition,"SILENT_CONTEXT");
assert.equal(report.adviceAllowed,false);
assert.equal(report.closureAllowed,false);

const full=select("撑死我了",{recentEpisodes:[{topic:"dinner",known:{meal:"牛肉面"},stale:false}]});
assert.equal(full.primaryAct,"REACT");
assert.equal(full.contextDisposition,"SILENT_CONTEXT");
assert.equal(full.adviceAllowed,false);

const advice=select("你觉得我今晚该先看哪部分？");
assert.equal(advice.primaryAct,"ADVICE");
assert.equal(advice.adviceAllowed,true);

const boundary=select("别给我安排，我就吐槽一下");
assert.notEqual(boundary.primaryAct,"ADVICE");
assert.equal(boundary.adviceAllowed,false);

const closure=select("我去洗澡啦",{closure:{likely:true,strength:"strong",kind:"leave"}});
assert.equal(closure.primaryAct,"CLOSURE");
assert.equal(closure.closureAllowed,true);

assert.equal(select("嗯").primaryAct,"ACK");
const softAck=select("嗯",{closure:{likely:true,strength:"weak",kind:"soft_ack"}});
assert.equal(softAck.primaryAct,"ACK");
assert.equal(softAck.closureAllowed,false);
assert.equal(select("你还记得我刚才吃的啥不").primaryAct,"CALLBACK");
assert.equal(select("你还记得我刚才吃的啥不").contextDisposition,"MENTION_IF_NEEDED");
assert.equal(select("笑死，我手机比单词好看多了").primaryAct,"TEASE");

const clarification=select("那个呢",{grounding:{relation:"SHIFT_AMBIGUOUS",confidence:0.3}});
assert.equal(clarification.primaryAct,"QUESTION");

const block=naturalResponsePolicyBlock(full);
assert.match(block,/Context ≠ Required Mention/);
assert.match(block,/silent-use context/);
assert.match(block,/不要给 advice/);
assert.match(block,/open loops 是机会，不是待办/);

const compliant=analyzeNaturalResponse({
  text:"哈哈，吃猛了吧。",
  selection:full,
  recentEpisodes:[{topic:"dinner",known:{meal:"牛肉面"},stale:false}]
});
assert.equal(compliant.adviceGiven,false);
assert.equal(compliant.closureGiven,false);
assert.equal(compliant.currentSituationSummarized,false);
assert.equal(compliant.recentEventExplicitlyMentioned,false);

const templated=analyzeNaturalResponse({
  text:"你刚刚吃完牛肉面，现在很撑，所以先休息一下，别乱动。",
  selection:full,
  recentEpisodes:[{topic:"dinner",known:{meal:"牛肉面"},stale:false}]
});
assert.equal(templated.adviceGiven,true);
assert.equal(templated.currentSituationSummarized,true);
assert.equal(templated.recentEventExplicitlyMentioned,true);
assert.deepEqual(templated.policyViolations.sort(),["advice_not_allowed","situation_summary_not_allowed"]);
assert.equal(analyzeNaturalResponse({text:"那就赶紧去休息吧，明天再聊",selection:full}).adviceGiven,true);
assert.equal(analyzeNaturalResponse({text:"那就赶紧去休息吧，明天再聊",selection:full}).closureGiven,true);
assert.equal(analyzeNaturalResponse({text:"吃不完就别勉强了",selection:full}).adviceGiven,true);
assert.equal(analyzeNaturalResponse({text:"明天小测得赶紧回来哦，不然容易翻车",selection:full}).adviceGiven,true);
assert.equal(analyzeNaturalResponse({text:"作业也得准备准备，不然明天小测受影响",selection:full}).adviceGiven,true);
assert.equal(analyzeNaturalResponse({text:"拍照上传吧",selection:full}).adviceGiven,true);
assert.equal(analyzeNaturalResponse({text:"还是早点睡吧",selection:full}).adviceGiven,true);
assert.equal(analyzeNaturalResponse({text:"记得啊，路上买的牛肉面",selection:full}).adviceGiven,false);
assert.equal(analyzeNaturalResponse({text:"陪你吐槽我都觉得轻松了",selection:full}).adviceGiven,false);

const repairedJson=inspectNaturalResponseCandidate({
  rawText:'{"messages":["行啊","我就听你吐槽"]',selection:boundary
});
assert.equal(repairedJson.ok,true);
assert.equal(repairedJson.canonicalRaw,'{"messages":["行啊","我就听你吐槽"]}');

const overAnswer=inspectNaturalResponseCandidate({
  rawText:'{"messages":["好啦～","躺着好好休息吧"]}',selection:select("好姐姐")
});
assert.equal(overAnswer.ok,false);
assert.ok(overAnswer.reasons.includes("advice_not_allowed"));
assert.ok(overAnswer.reasons.includes("minimal_ack_overanswered"));
assert.ok(inspectNaturalResponseCandidate({rawText:'{"messages":["是啊，份量确实离谱"]}',selection:select("哦")}).reasons.includes("minimal_ack_overanswered"));

const duplicate=inspectNaturalResponseCandidate({
  rawText:'{"messages":["心情还行","你呢？"]}',selection:select("不过我知道你是关心我"),
  recentAssistantTexts:["心情还行","你呢？"]
});
assert.equal(duplicate.ok,false);
assert.ok(duplicate.reasons.includes("verbatim_recent_reply"));

const thirdQuestion=inspectNaturalResponseCandidate({
  rawText:'{"messages":["是吗？"]}',selection:select("我又想到一点"),recentRealizedActs:["QUESTION","QUESTION"]
});
assert.equal(thirdQuestion.ok,false);
assert.ok(thirdQuestion.reasons.includes("third_same_response_structure"));
assert.ok(thirdQuestion.reasons.includes("unselected_question"));

const extraQuestion=inspectNaturalResponseCandidate({
  rawText:'{"messages":["终于到家啦","今天怎么样呀？"]}',selection:report
});
assert.equal(extraQuestion.ok,false);
assert.ok(extraQuestion.reasons.includes("unselected_question"));

for(const [file,needle] of [
  ["src/recent-episodes/index.js","未知槽位也不会自动产生追问义务"],
  ["src/natural-cognition/store.js","waiting_for 不要求追问"],
  ["src/natural-presence/store.js","open loops 和念头只是机会"],
  ["src/temporal-context.js","not required talking points"],
  ["src/natural-messaging.js","不构成第二个念头"]
])assert.ok(fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8").includes(needle),`${file} keeps background context silent`);

console.log("natural response policy tests passed");
