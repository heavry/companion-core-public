/**
 * Relational Character Realization v1
 *
 * Semantic complete ≠ character realized.
 * For pure relational/social turns (affection, praise, teasing, banter, clingy),
 * a grammatical echo of the user's action (「亲一口。」 after「亲一个」) still
 * feels mechanical. One light rewrite is allowed — never force length or Bubble2.
 *
 * Scope guard:
 * - Turn Coverage owns explicit question/request/task. Do not run here.
 * - Social Act Completion owns apology / reassurance / relationship repair.
 * - This layer only covers pure character interaction with no those obligations.
 */

const CLAUSE_SPLIT = /[，,。！？!?\n；;：:、]+/;

/** Relational bids — pure character interaction, not task/question. */
const AFFECTION =
  /(?:亲一个|亲一下|亲亲|亲一口|亲我|mua|mu a|啵|抱一下|抱抱|抱我|牵(?:手|牵)|蹭蹭|贴贴|想你|爱你|最喜欢你|要亲|要抱|给(?:我)?亲|来亲|来抱)/i;

const PRAISE =
  /(?:你好棒|好棒|真棒|最棒|好厉害|真厉害|最好了|你最好|真好|可爱|好好看|帅|美|夸夸|表扬)/i;

const TEASING =
  /(?:逗你|耍你|骗你的|故意(?:的|逗|气|惹)|小笨|小笨蛋|略略|略|哼|切|才不|就不|你才|傻(?:子|瓜)|呆)/i;

const PLAYFUL_BANTER =
  /(?:笑死|嘿嘿|哈哈|逗死|绝了|离谱|服了|气你|怼你|抬杠|拌嘴|玩笑)/i;

const CLINGY =
  /(?:陪我|陪陪|不要走|别走|粘你|离不开|想见你|想你了|多陪|理我|看看我)/i;

const FAMILIAR_BID =
  /(?:宝宝亲|宝贝亲|姐姐亲|过来亲|过来抱|亲一个就|亲一口就|要亲亲|要抱抱|让我亲|让我抱)/i;

/** Reply-side stance / character voice (not merely executing the request). */
const STANCE_MARKERS =
  /(?:过来|来，|来。|给(?:你|我)|赏|勉强|真拿你|拿你没|服了|受不了|行吧|啧|哟|就这|才不|就不|骗你|想得美|少来|哈|哼|切|笨|傻|呆|乖|小馋|小笨|真敢|胆子|离谱|可以啊|行啊|厉害了|真有|继续|还有呢|就一下|一下下|只许|仅此|下不为例|真拿|谁让你|就宠|宠你|惯着|败给你|没办法|拿捏|上瘾|瘾|谁跟你|待着|陪你|抱着|堵住|捏|捏脸|揉|薅)/i;

/** Pure execution / echo of the user's requested action. */
const ACTION_ECHO =
  /^(?:亲(?:一口|一下|亲)?|抱(?:一下|抱)?|mua|啵|蹭|贴|好的|好哦|好哒|好呀|嗯嗯?|哦|行|可以|没问题)[。.!！~～～]*$/i;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function splitClauses(text) {
  return clean(text)
    .split(CLAUSE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Detect pure relational acts. Empty when this is task/question/apology/casual.
 */
export function detectRelationalActs(userText = "") {
  const t = clean(userText);
  if (!t) return [];
  // Never steal turns that Coverage / Social Act already own.
  if (hasExplicitAsk(t) || hasSocialRepair(t)) return [];
  const acts = [];
  if (AFFECTION.test(t) || FAMILIAR_BID.test(t)) acts.push("affection_bid");
  if (PRAISE.test(t)) acts.push("praise");
  if (TEASING.test(t)) acts.push("teasing");
  if (PLAYFUL_BANTER.test(t)) acts.push("playful_banter");
  if (CLINGY.test(t)) acts.push("clingy");
  if (!acts.length && FAMILIAR_BID.test(t)) acts.push("familiar_social_bid");
  return [...new Set(acts)];
}

function hasExplicitAsk(t) {
  // Rough non-overlap with Turn Coverage / Social Act.
  return /(?:为什么|怎么会|怎么回事|怎么办|帮我|看一下|查一下|我错了|对不起|别生气|别不理|顺顺毛|和好)/.test(t)
    || /[?？]/.test(t) && /(?:吗|呢|么)$/.test(t) && /(?:文件|任务|图片|报错|跑完|看完)/.test(t);
}

function hasSocialRepair(t) {
  return /(?:对不起|抱歉|我错了|别生气|别不理|别走|和好|顺顺毛|原谅|不跟你计较)/.test(t);
}

export function requiresCharacterRealization(userText = "") {
  return detectRelationalActs(userText).length > 0;
}

function isMechanicalEcho(userText, reply) {
  const r = clean(reply);
  const u = clean(userText);
  if (!r) return true;
  if (ACTION_ECHO.test(r)) return true;
  // Synonym rewrite of the user's core bid: 亲一个 → 亲一口 / 亲亲。
  const bid = /亲|抱|mua|啵|蹭|贴/.test(u);
  const actionOnly = /^(?:亲|抱|mua|啵|蹭|贴)(?:[一两下口嘴次个]?[。.!！~～]*)$/i.test(r);
  if (bid && actionOnly && Array.from(r).length <= 8) return true;
  // Near-copy of user action phrase.
  const uKey = u.replace(/[，,。！？!?\s]/g, "").slice(-6);
  const rKey = r.replace(/[，,。！？!?\s]/g, "");
  if (uKey && rKey && rKey.length <= 8 && (rKey.includes(uKey.slice(0, 3)) || uKey.includes(rKey.slice(0, 3)))) {
    return !STANCE_MARKERS.test(r);
  }
  return false;
}

function hasCharacterStance(reply, presence = null) {
  const r = clean(reply);
  if (!r) return false;
  if (STANCE_MARKERS.test(r)) return true;
  // Distinctive particles / attitude that are not pure execution.
  if (/[？?～~!！…]/.test(r) && Array.from(r).length >= 4) return true;
  // Mood-aware: even a short reply can carry stance via contrast particles.
  if (/(?:啊|呀|嘛|呗|哦|哼|哈|啧|哟|切)[。.!！~～]*$/.test(r) && Array.from(r).length >= 3 && !ACTION_ECHO.test(r)) {
    return true;
  }
  return false;
}

/**
 * Evaluate whether a reply for a relational turn is character-realized.
 * Short is fine — mechanical echo of the user's action is not.
 */
export function evaluateCharacterRealization(userText = "", replyText = "", presence = null) {
  const acts = detectRelationalActs(userText);
  if (!acts.length) {
    return {
      complete: true,
      reason: "not_relational",
      acts: [],
      realized: true
    };
  }

  const replies = Array.isArray(replyText)
    ? replyText.map((x) => clean(x)).filter(Boolean)
    : [clean(replyText)].filter(Boolean);
  const joined = replies.join("\n");

  // Any bubble with stance / non-echo voice counts as realized.
  const realized = replies.some((r) => !isMechanicalEcho(userText, r) && hasCharacterStance(r, presence))
    || (joined.length > 0 && !isMechanicalEcho(userText, joined) && hasCharacterStance(joined, presence));

  if (realized) {
    return {
      complete: true,
      reason: "character_realized",
      acts,
      realized: true,
      joined
    };
  }

  return {
    complete: false,
    reason: "character_under_realized",
    acts,
    realized: false,
    joined
  };
}

/**
 * Light generation framing. Never demand length, second bubble, or high emotion.
 */
export function relationalCharacterBlock(userText = "", presence = null, evaluation = null) {
  const acts = evaluation?.acts?.length ? evaluation.acts : detectRelationalActs(userText);
  if (!acts.length) return "";
  const labels = {
    affection_bid: "亲昵/求抱互动",
    praise: "被夸",
    teasing: "被逗",
    playful_banter: "玩笑拌嘴",
    clingy: "粘人式互动",
    familiar_social_bid: "熟人社交 bid"
  };
  const list = acts.map((a) => labels[a] ?? a).join("；");
  const irritation = Number(presence?.dimensions?.irritation?.current ?? presence?.irritation ?? 0);
  const mood = Number(presence?.dimensions?.mood?.current ?? presence?.mood ?? 0.5);
  const closeness = Number(presence?.dimensions?.closeness?.current ?? presence?.closeness ?? 0.6);
  let stanceHint = "带一点自己的反应/立场，不要只是把用户动作复述一遍。";
  if (irritation >= 0.45) {
    stanceHint = "可以略带刺/顶一下/不情愿，不必热情。";
  } else if (mood < 0.4) {
    stanceHint = "可以偏淡/懒/少话，不要强行兴奋或撒娇。";
  } else if (closeness >= 0.75) {
    stanceHint = "更熟、更随口、更敢逗；一句话也可以，但要有这个人自己的口吻。";
  }
  return [
    "【Relational Character｜人物感】",
    `本句是纯人物互动：${list}`,
    stanceHint,
    "可以很短；不要复述用户动作句式，不要写成执行确认。",
    "不要强制两句、不要强制撒娇、不要强制高情绪、不要扩成小作文。"
  ].join("\n");
}
