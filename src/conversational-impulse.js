/**
 * Conversational Impulse v1
 *
 * Before generation, pick ONE lightweight impulse: what she most wants to do
 * with this utterance. Not chain-of-thought. Not a completeness checklist.
 * One impulse is enough — finish it and stop.
 * Explicit question/request/task in the same turn is a coverage floor:
 * casual fragment may be skipped; the explicit ask must not be swallowed.
 */
import {
  analyzeTurnCoverage,
  requiresCompleteCoverage,
  turnCoverageBlock
} from "./turn-coverage.js";
import {
  detectUserSocialActs,
  requiresSocialActCompletion,
  socialActBlock
} from "./social-act-completion.js";
import {
  detectRelationalActs,
  requiresCharacterRealization,
  relationalCharacterBlock
} from "./relational-character.js";

const IMPULSES = new Set([
  "REACT",
  "TEASE",
  "CHALLENGE",
  "DISAGREE",
  "QUESTION",
  "COMMENT",
  "CALLBACK",
  "COMPLAIN",
  "CURIOSITY",
  "REASSURE",
  "ADVISE",
  "CLOSE",
  "NOTHING_MORE"
]);

const MINIMAL_ACK = /^(?:嗯+|哦+|噢+|啊+|行+|好+|好吧|好的|可以|知道了|收到|哈哈(?:哈)?(?:行吧)?|好?(?:姐姐|宝宝|宝贝))[。.!！~～]*$/i;
const ADVICE_REQUEST = /(?:怎么办|怎么做|该不该|该先|该怎么办|该怎么做|要不要|能不能给.{0,6}建议|你建议|你觉得我(?:该|要)|帮我想|教教我|给我个主意|哪部分|选哪个)/i;
const ADVICE_BOUNDARY = /(?:别给我安排|不用建议|别劝我|我就吐槽|只是吐槽|没问怎么办|不用告诉我该怎么做)/i;
const SAFETY_NECESSITY = /(?:喘不上气|呼吸困难|胸痛|大量出血|晕倒|昏厥|要自杀|想死|有人威胁|着火|煤气|中毒)/i;
const EXPLICIT_RECALL = /(?:你还记得|你记得|记不记得|刚才那个|之前那个|上次那个|还记得我)/i;
const USER_QUESTION = /[?？]|(?:吗|呢|不|没)$/;
const PLAYFUL = /(?:笑死|哈哈|嘿嘿|逗|离谱|绝了|我可真|比.{0,10}好看|就知道)/i;
const COMPLAINT = /(?:累死|烦死|气死|撑死|困死|难受|学不进去|走神|催眠|吐槽|破防|崩了|无语)/i;
const STRONG_VENT = /(?:烦死|累死|气死|崩溃|破防|受不了|真的烦|太烦|好烦)/i;
const RETURN = /(?:我回来了|回来啦|回家了|到家了|洗完了|忙完了|弄完了)/i;
const EVENT_REPORT = /(?:我(?:刚|已经|终于|今天|刚才|刚刚|现在)?[^。！？]{0,24}(?:回家|到家|下课|吃了|买了|写完|做完|弄完|交了|去了|来了|结束|完成)|刚(?:下课|吃完|写完|洗完|回来))/i;
const SUMMARY_REQUEST = /(?:总结一下|帮我捋|梳理一下|所以我现在|概括一下|复盘一下)/i;
const FEAR_LOSS = /(?:害怕.{0,8}(?:不理|离开|消失|不要我|走掉)|怕你.{0,6}(?:不理|离开|消失|不要我)|你会(?:不会)?.{0,6}(?:不理我|离开我|不要我|消失)|以后.{0,6}(?:不理我|不要我|离开)|担心你.{0,8}(?:不理|离开|消失)|别离开我|不要丢下)/i;
const ABSURD = /(?:地球(?:绝对)?是平的|绝对没错|肯定就是.{0,10}错|所有人都(?:应该|必须)|这还用问|离谱的观点|明显不对|当然是这样|本来就该如此)/i;
const OPINION_BAIT = /(?:你觉得呢|我说的对吧|是不是这样|难道不是|本来就该|当然是)/i;
const PRAISE = /(?:你最好了|你好棒|最爱你|爱你|想你|好喜欢你|你真好|还是你好)/i;
const INTIMACY_SHARE = /(?:好想(?:你|见你)|想见你|想你了|离不开你|只要你|就想跟你)/i;
const TASK_MULTI_Q = /(?:而且|另外|还有|顺便|再问|第二个问题|两个问题)/i;
const HOWTO_TASK = /(?:帮我(?:写|改|查|找|做|算|跑|配置)|怎么(?:做|弄|装|写|改)|如何(?:做|安装|配置)|步骤|教程|给我一份)/i;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function countQuestions(text) {
  return (String(text).match(/[?？]/g) ?? []).length;
}

function isTaskCompleteTurn(text) {
  const t = clean(text);
  if (!t) return false;
  if (SAFETY_NECESSITY.test(t)) return true;
  if (SUMMARY_REQUEST.test(t)) return true;
  if (HOWTO_TASK.test(t)) return true;
  if (countQuestions(t) >= 2) return true;
  if (countQuestions(t) >= 1 && TASK_MULTI_Q.test(t)) return true;
  // Semantic explicit question/request/task — not punctuation-gated.
  // "咋了宝贝不行吗，宝宝你说头怎么会疼呢" must stay complete.
  if (requiresCompleteCoverage(t)) return true;
  return false;
}

/** Light recent assistant expressions: act + posture tag. */
export function summarizeRecentExpressions(recentAssistantTexts = [], recentImpulses = []) {
  const out = [];
  const texts = Array.isArray(recentAssistantTexts) ? recentAssistantTexts : [];
  const impulses = Array.isArray(recentImpulses) ? recentImpulses : [];
  const n = Math.min(6, Math.max(texts.length, impulses.length));
  for (let i = 0; i < n; i++) {
    const text = clean(texts[texts.length - n + i] ?? "");
    const impulse = impulses[impulses.length - n + i] ?? null;
    if (!text && !impulse) continue;
    out.push({
      impulse: impulse ?? guessImpulseFromText(text),
      posture: postureTag(text, impulse),
      preview: text.slice(0, 28)
    });
  }
  return out;
}

function postureTag(text, impulse) {
  const t = clean(text);
  if (!t) return "neutral";
  if (/(?:不急|不用证明|待着就|没事的|没关系|放心|我一直|不会不理|不会走)/.test(t)) return "soothing";
  if (/(?:晚安|先睡|回头聊|明天再说|去吧|好好睡|不打扰)/.test(t)) return "closing";
  if (/(?:哈哈|就知道|你还真|哟|啧|行不行啊|小馋|逗)/.test(t)) return "teasing";
  if (/(?:不是|认真的|离谱|得了吧|少来|想得美|我就不同意|不同意)/.test(t)) return "edgy";
  if (impulse === "REASSURE") return "soothing";
  if (impulse === "CLOSE") return "closing";
  if (impulse === "TEASE") return "teasing";
  if (impulse === "CHALLENGE" || impulse === "DISAGREE") return "edgy";
  return "soft";
}

function guessImpulseFromText(text) {
  const t = clean(text);
  if (!t) return null;
  if (/(?:晚安|先睡|回头聊|明天再说|去吧|好好睡)/.test(t)) return "CLOSE";
  if (/(?:哈哈|就知道|你还真|哟|啧|行不行啊)/.test(t)) return "TEASE";
  if (/[?？]/.test(t)) return "QUESTION";
  if (t.length <= 10) return "REACT";
  return "COMMENT";
}

function recentPostureRecurrence(expressions, posture) {
  if (!posture) return 0;
  const tags = expressions.map(x => x.posture);
  let streak = 0;
  for (let i = tags.length - 1; i >= 0; i--) {
    if (tags[i] === posture) streak++;
    else break;
  }
  return streak;
}

/**
 * Pick ONE conversational impulse for this user utterance.
 * Deterministic and cheap — precision is not the product; framing is.
 */
export function selectConversationalImpulse({
  userText = "",
  closure = null,
  grounding = null,
  recurrence = null,
  presence = null,
  recentAssistantTexts = [],
  recentImpulses = [],
  recentEpisodes = [],
  openLoops = [],
  expectations = []
} = {}) {
  const text = clean(userText);
  const playfulness = Number(presence?.dimensions?.playfulness?.current ?? presence?.playfulness ?? 0);
  const closeness = Number(presence?.dimensions?.closeness?.current ?? 0.6);
  const confidence = Number(presence?.dimensions?.confidence?.current ?? 0.5);
  const irritation = Number(presence?.dimensions?.irritation?.current ?? 0);
  const expressions = summarizeRecentExpressions(recentAssistantTexts, recentImpulses);

  const coverage = analyzeTurnCoverage(text);
  const socialActs = detectUserSocialActs(text);
  const relationalActs = detectRelationalActs(text);
  const selectiveAttention = isTaskCompleteTurn(text) ? "required_complete" : "allowed";
  let impulse = "COMMENT";
  let reason = "ordinary_current_turn";
  let focusPoint = firstFocusPoint(text);

  if (closure?.likely && closure?.strength !== "weak") {
    impulse = "CLOSE";
    reason = `user_release:${closure.kind ?? "unknown"}`;
    focusPoint = text.slice(0, 24) || focusPoint;
  } else if (SAFETY_NECESSITY.test(text)) {
    impulse = "ADVISE";
    reason = "real_world_safety_necessity";
  } else if (ADVICE_REQUEST.test(text) && !ADVICE_BOUNDARY.test(text)) {
    impulse = "ADVISE";
    reason = "explicit_advice_request";
  } else if (FEAR_LOSS.test(text)) {
    impulse = "REASSURE";
    reason = "explicit_relationship_fear";
  } else if (grounding?.relation === "SHIFT_AMBIGUOUS") {
    impulse = "QUESTION";
    reason = "clarification_needed";
  } else if (EXPLICIT_RECALL.test(text) || grounding?.relation === "CALLBACK" || recurrence?.kind === "CALLBACK") {
    impulse = "CALLBACK";
    reason = "user_callback";
    focusPoint = text.slice(0, 24) || focusPoint;
  } else if (MINIMAL_ACK.test(text)) {
    impulse = "REACT";
    reason = "minimal_user_turn";
    focusPoint = text;
  } else if (ABSURD.test(text) || (OPINION_BAIT.test(text) && (confidence >= 0.7 || irritation >= 0.35))) {
    impulse = irritation >= 0.45 || ABSURD.test(text) ? "CHALLENGE" : "DISAGREE";
    reason = "stance_on_user_claim";
  } else if (PLAYFUL.test(text) && playfulness >= 0.5) {
    impulse = "TEASE";
    reason = "playful_rhythm";
    focusPoint = text.slice(0, 20) || focusPoint;
  } else if (STRONG_VENT.test(text)) {
    impulse = "COMPLAIN";
    reason = "strong_vent";
    focusPoint = extractVentPoint(text) ?? focusPoint;
  } else if (COMPLAINT.test(text)) {
    // Selective: often only the sharpest fragment, not the whole emotional inventory.
    impulse = closeness >= 0.72 ? "REACT" : "REACT";
    reason = "user_emotion_or_complaint";
    focusPoint = extractComplaintPoint(text) ?? focusPoint;
  } else if (PRAISE.test(text) || INTIMACY_SHARE.test(text)) {
    if (closeness >= 0.75 && playfulness >= 0.45) {
      impulse = "TEASE";
      reason = "close_playful_on_praise";
    } else if (closeness >= 0.75) {
      impulse = "REACT";
      reason = "close_casual_on_intimacy";
    } else {
      impulse = "REACT";
      reason = "intimacy_or_praise";
    }
    focusPoint = text.slice(0, 18) || focusPoint;
  } else if (RETURN.test(text) || EVENT_REPORT.test(text)) {
    impulse = "REACT";
    reason = "user_event_update";
    focusPoint = extractEventPoint(text) ?? focusPoint;
  } else if (USER_QUESTION.test(text) && selectiveAttention === "required_complete") {
    impulse = "COMMENT";
    reason = "task_question_complete";
  } else if (USER_QUESTION.test(text)) {
    // Casual question: may answer, may flip to curiosity/challenge — default COMMENT take.
    impulse = countQuestions(text) >= 1 && /(?:为什么|凭啥|怎么又|啥情况)/.test(text) ? "CURIOSITY" : "COMMENT";
    reason = impulse === "CURIOSITY" ? "casual_curiosity" : "answer_current_question";
    focusPoint = text.slice(0, 24) || focusPoint;
  } else {
    const recentPosture = expressions.at(-1)?.posture ?? null;
    const soothingStreak = recentPostureRecurrence(expressions, "soothing");
    if (soothingStreak >= 2 && (PRAISE.test(text) || INTIMACY_SHARE.test(text) || closeness >= 0.7)) {
      impulse = playfulness >= 0.4 ? "TEASE" : "REACT";
      reason = "avoid_repeated_soothing_posture";
      focusPoint = text.slice(0, 18) || focusPoint;
    } else {
      impulse = "COMMENT";
      reason = "ordinary_current_turn";
    }
  }

  // High closeness should not automatically produce REASSURE/CLOSE.
  if ((impulse === "REASSURE" || impulse === "CLOSE") && reason !== "explicit_relationship_fear" && reason !== "user_release" && !String(reason).startsWith("user_release")) {
    if (closeness >= 0.78 && PRAISE.test(text)) {
      impulse = "TEASE";
      reason = "high_closeness_not_auto_comfort";
    }
  }

  const lastPosture = expressions.at(-1)?.posture ?? null;
  const postureStreak = recentPostureRecurrence(expressions, lastPosture);
  const avoidPosture = postureStreak >= 2 ? lastPosture : null;

  // If we just repeated a soothing/closing posture too often, force a different impulse.
  if (avoidPosture === "soothing" && (impulse === "REASSURE" || impulse === "CLOSE" || (impulse === "REACT" && PRAISE.test(text)))) {
    impulse = playfulness >= 0.4 ? "TEASE" : (PRAISE.test(text) || INTIMACY_SHARE.test(text) ? "TEASE" : "COMMENT");
    reason = `avoid_repeated_${avoidPosture}_posture`;
    focusPoint = text.slice(0, 18) || focusPoint;
  } else if (avoidPosture === "closing" && impulse === "CLOSE" && !closure?.likely) {
    impulse = "REACT";
    reason = "avoid_repeated_closing_posture";
  }

  return {
    impulse: IMPULSES.has(impulse) ? impulse : "COMMENT",
    focusPoint,
    selectiveAttention,
    reason,
    avoidPosture,
    closeness,
    playfulness,
    oneImpulseOnly: true,
    stopWhenDone: true,
    adviceAllowed: impulse === "ADVISE",
    closureAllowed: impulse === "CLOSE",
    reassureAllowed: impulse === "REASSURE",
    summaryAllowed: SUMMARY_REQUEST.test(text),
    contextDisposition: (EXPLICIT_RECALL.test(text) || grounding?.relation === "CALLBACK") ? "MENTION_IF_NEEDED" : "SILENT_CONTEXT",
    recentExpressions: expressions,
    // Coverage floor: explicit Q/R/T in this turn cannot be swallowed.
    turnCoverage: {
      hasExplicitObligation: coverage.hasExplicitObligation,
      mixed: coverage.mixed,
      obligations: coverage.obligations.map(o => ({ kind: o.kind, subtype: o.subtype, text: o.text, keywords: o.keywords }))
    },
    socialActs,
    requiresSocialCompletion: socialActs.length > 0,
    relationalActs,
    requiresCharacterRealization: relationalActs.length > 0,
    background: {
      recentEpisodeCount: Array.isArray(recentEpisodes) ? recentEpisodes.filter(item => !item?.stale).length : 0,
      openLoopCount: Array.isArray(openLoops) ? openLoops.length : 0,
      pendingExpectationCount: Array.isArray(expectations) ? expectations.length : 0
    }
  };
}

function firstFocusPoint(text) {
  const t = clean(text);
  if (!t) return null;
  // Prefer the clause that looks most felt / specific.
  const clauses = t.split(/[，,。！？!?\n]+/).map(s => s.trim()).filter(Boolean);
  if (!clauses.length) return t.slice(0, 24);
  const ranked = clauses
    .map((c, i) => ({
      c,
      i,
      score:
        (/又|再|还|居然|竟然|真的|好|最|烦|累|坏|怕|想/.test(c) ? 2 : 0) +
        (c.length <= 12 ? 1 : 0) +
        (/电脑|手机|作业|课|睡|吃|见|疼|哭|笑/.test(c) ? 1 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return ranked[0].c.slice(0, 28);
}

function extractComplaintPoint(text) {
  const t = clean(text);
  const m = t.match(/[^，,。！？]{0,10}(?:烦死|累死|气死|难受|崩了|破防|无语|学不进去|电脑|手机|坏了|又[^，,。]{0,8})[^，,。！？]{0,10}/);
  return m ? m[0].slice(0, 28) : firstFocusPoint(text);
}

function extractVentPoint(text) {
  return extractComplaintPoint(text);
}

function extractEventPoint(text) {
  const t = clean(text);
  const m = t.match(/(?:回家|到家|下课|吃了|买|写完|做完|弄完|忙完|洗完|回来了)/);
  return m ? m[0] : firstFocusPoint(text);
}

/** Generation framing — decision first; explicit Q/R/T is a coverage floor. */
export function conversationalImpulseBlock(impulseSel = {}) {
  const impulse = IMPULSES.has(impulseSel.impulse) ? impulseSel.impulse : "COMMENT";
  const focus = impulseSel.focusPoint ? String(impulseSel.focusPoint).slice(0, 40) : "当前这句话里最戳到的那一点";
  const selective = impulseSel.selectiveAttention === "required_complete" ? "required_complete" : "allowed";
  const hasObligation = Boolean(
    impulseSel.turnCoverage?.hasExplicitObligation || selective === "required_complete"
  );
  const mixed = Boolean(impulseSel.turnCoverage?.mixed) || (hasObligation && selective === "required_complete");
  const lines = [
    "【Conversational Impulse｜先决定我现在最想干嘛，而不是把用户这句回应完整】",
    `impulse=${impulse}`,
    `focus_point=${focus}`,
    `selective_attention=${selective}`,
    "one_impulse_only=true; stop_when_done=true",
    `selection_reason=${impulseSel.reason ?? "ordinary_current_turn"}${impulseSel.avoidPosture ? `; avoid_posture=${impulseSel.avoidPosture}` : ""}`,
    "核心：听到这句话，我真正想干什么，就先把那个反应说出来。说够了就停。",
    "不要为了完整去 acknowledge + 解释情绪 + 安抚 + 建议 + 收尾。那不是聊天，那是交作业。",
    hasObligation
      ? "这轮含明确 question/request/task：可以先接情绪/拌嘴，但必须覆盖明确项。仍只完成必要动作，不要额外安抚收尾。"
      : "普通闲聊允许只抓一个点。次要信息可以不提。遗漏次要内容不是 bug。",
    "允许短句、半截、反问、语气词：啊？/ 又来？/ 你认真的？/ 行，这句我收下。/ 不是，等会儿。",
    "Context ≠ Required Mention；Context ≠ Required Response Act。后台事实、情绪、关系、记忆可以只在心里用。open loops 是机会，不是待办。",
    "high closeness = 更熟、更随口、更敢顶、更敢笑、更敢吐槽、更少礼貌包装；不是更温柔、更 counselling。",
    "Emotion detected ≠ 必须 reassure。Intimacy ≠ 必须 closure。夸一句、随便聊、表达亲近，不必自动安抚收尾。",
    "人格来自立场：信不信、喜不喜欢、觉不觉得离谱、想吐槽还是追问、要不要顺着说。不要永远理解、赞同、温柔、完整。",
    "不要把 mood/closeness/记忆字段说给用户听。"
  ];

  if (hasObligation) {
    const obligations = Array.isArray(impulseSel.turnCoverage?.obligations)
      ? impulseSel.turnCoverage.obligations
      : [];
    if (obligations.length) {
      lines.push(turnCoverageBlock({
        clauses: obligations,
        obligations,
        casual: [],
        hasExplicitObligation: true,
        hasCasual: Boolean(mixed),
        mixed: Boolean(mixed),
        casualOnly: false
      }));
    } else {
      lines.push([
        "【Turn Coverage｜明确问题/请求不能吞】",
        "本句含明确 question/request/task：可以先接情绪/拌嘴，但同一轮必须覆盖明确项。",
        "闲聊碎片可以略；明确问题不能吞。可以短答，不要写成小作文。"
      ].join("\n"));
    }
  }

  const socialActs = Array.isArray(impulseSel.socialActs) ? impulseSel.socialActs : [];
  if (socialActs.length || impulseSel.requiresSocialCompletion) {
    const block = socialActBlock("", { acts: socialActs.length ? socialActs : ["apology"] });
    if (block) lines.push(block);
  }

  const relationalActs = Array.isArray(impulseSel.relationalActs) ? impulseSel.relationalActs : [];
  if (relationalActs.length) {
    const block = relationalCharacterBlock("", null, { acts: relationalActs });
    if (block) lines.push(block);
  }

  if (!impulseSel.adviceAllowed) {
    lines.push("不要给 advice、提醒、安排或「先…然后…」；接住第一反应就够。");
  }
  if (!impulseSel.closureAllowed) {
    lines.push("不要加「忙完找我/有事叫我/我等你/早点休息」式尾巴。");
  }

  switch (impulse) {
    case "REACT":
      if (hasObligation) {
        lines.push("这轮可以先完成第一反应，但同一轮还要覆盖明确问题/请求。反应不要写成安慰长文。");
      } else {
        lines.push("这轮就完成第一反应。反应到位就够，不要再补 reassurance/advice/summary/closure。");
      }
      break;
    case "TEASE":
      if (hasObligation) {
        lines.push("这轮可以先逗回去/接梗，但同一轮要覆盖明确问题/请求。别解释笑点，别再温柔收尾。");
      } else {
        lines.push("这轮就逗回去/接梗。可以短、可以不完整。别解释笑点，别再温柔收尾。");
      }
      break;
    case "CHALLENGE":
      if (hasObligation) {
        lines.push("这轮可以先较真/顶回去，但同一轮要覆盖明确问题/请求。不要先 validate 再讲道理。");
      } else {
        lines.push("这轮可以较真、反问、指出离谱之处。不要先 validate 再讲道理。");
      }
      break;
    case "DISAGREE":
      lines.push("这轮可以不同意。直接一点，不必先共情再转折。");
      break;
    case "QUESTION":
      lines.push("这轮就问真正想知道的那一个。不要连带安慰或总结。");
      break;
    case "COMMENT":
      if (hasObligation) {
        lines.push("这轮可以先给反应/说法，但必须覆盖明确问题或请求。不要只停在拌嘴。");
      } else {
        lines.push("这轮给一个自己的说法/反应就够了。可以只回应一部分内容。");
      }
      break;
    case "CALLBACK":
      lines.push("轻轻回接旧事一个点，不要重讲整段背景。");
      break;
    case "COMPLAIN":
      lines.push("可以跟着嫌弃/抱怨/吐槽一句。不必立刻给出解决方案。");
      break;
    case "CURIOSITY":
      lines.push("突然好奇就问那一个细节，不要展开成完整调查。");
      break;
    case "REASSURE":
      lines.push("用户真的在怕失去关系/明确需要安慰：认真、短、真。不要鸡汤长文，不要自动加 advice/closure。");
      break;
    case "ADVISE":
      lines.push("用户明确问了建议或有真实安全需要：只答所问范围，不扩展安排下一步。");
      break;
    case "CLOSE":
      lines.push("用户确实在收尾：轻轻放手即可。不总结今天，不追问，不附加任务。");
      break;
    case "NOTHING_MORE":
      lines.push("impulse 已完成，没有新念头就什么都不用说。");
      break;
    default:
      break;
  }

  if (impulseSel.contextDisposition === "SILENT_CONTEXT") {
    lines.push("本轮 silent-use context：用背景理解语气和指代即可，除非不说会误解，否则不要复述最近事件。");
  }

  return lines.join("\n");
}

/** Very light expression awareness — not a blacklist. */
export function recentExpressionBlock(expressions = []) {
  const list = Array.isArray(expressions) ? expressions.filter(Boolean).slice(-6) : [];
  if (!list.length) return "";
  const rows = list.map(x => `${x.impulse ?? "?"}/${x.posture ?? "soft"}${x.preview ? ` :: ${x.preview}` : ""}`);
  return [
    "【Recent Expression｜仅用来换气口，不是黑名单】",
    `最近她自己说过：${rows.join(" | ")}`,
    "如果最近 2–3 次都是同一种 posture（尤其 soothing closure / 同一种 tease），这轮换一种。不要复制口头禅。"
  ].join("\n");
}

export function conversationalImpulses() {
  return [...IMPULSES];
}

const impulseMetrics = {
  singleImpulseTurnCount: 0,
  multiActExpansionCount: 0,
  closureAfterCompletedImpulse: 0,
  unrequestedAdviceCount: 0,
  reassuranceWithoutNeedCount: 0,
  selectiveAttentionCasualCount: 0,
  postMessageNoNewImpulseSuppressed: 0,
  recentPostureRecurrenceCount: 0
};

export function resetImpulseMetrics() {
  for (const k of Object.keys(impulseMetrics)) impulseMetrics[k] = 0;
}

export function noteImpulseMetric(key, n = 1) {
  if (key in impulseMetrics && Number.isFinite(n)) impulseMetrics[key] += n;
}

export function snapshotImpulseMetrics() {
  return { ...impulseMetrics };
}
