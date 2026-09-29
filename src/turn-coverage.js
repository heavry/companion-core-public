/**
 * Turn Coverage v1 — semantic obligations for one user turn.
 *
 * Goal: casual fragments may be selectively ignored; explicit questions,
 * requests, and pending tasks must not be swallowed by a short reaction.
 * Detection is clause-semantic (wh-words / request verbs / status asks),
 * not "any question mark must be answered".
 */

const CLAUSE_SPLIT = /[，,。！？!?\n；;：:、]+/;

/** Information-seeking shape: 为什么/怎么会/是什么/谁/哪… with real content. */
const WH_CORE =
  /(?:为什么|为啥|怎么会|怎么回事|怎么样|怎样|如何|是什么|是啥|是谁|哪个|哪里|哪儿|什么时候|几时|多久|多少|怎么)/;

/** Request / task verbs. */
const REQUEST_VERB =
  /(?:帮我|麻烦|劳驾|替我|给我(?:看|查|找|做|算|写|改|跑)|看一下|看看|查一下|查下|弄一下|做一下|跑一下|处理一下|检查一下|确认一下|发一下|传一下|找一下)/;

/** Pending-task / status ask about something concrete. */
const STATUS_ASK =
  /(?:(?:那个|这个|刚才|上次|前面)?(?:文件|任务|图|图片|作业|脚本|程序|部署|构建|跑的|弄的|看的|东西|事)[^，,。！？]{0,12}(?:了|完|好)?吗|跑完了吗|看完了吗|弄完了吗|做完了吗|搞完了吗|结束了吗|怎么样了)/;

/** Rhetorical banter / emotion that is NOT an explicit obligation. */
const CASUAL_ONLY =
  /(?:咋了|不行吗|行不行|好不好|是不是嘛|你凶|烦死|不理你了|行行行|你厉害|厉害死了|气死|累死|无聊|嘿嘿|笑死|哼|略)/;

/** Content nouns that make a question "explicit" rather than particle-banter. */
const CONTENT_NOUN =
  /(?:头|疼|痛|病|文件|图|图片|视频|任务|作业|脚本|程序|代码|报错|错误|bug|部署|构建|测试|端口|配置|日志|桌面|下载|路径|颜色|形状|跑|看|写|改|做)/i;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function splitClauses(text) {
  return clean(text)
    .split(CLAUSE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
}

function keywordsOf(clause) {
  const t = clean(clause);
  const out = [];
  const re =
    /头|疼|痛|病|文件|图片?|视频|任务|作业|脚本|程序|代码|报错|错误|bug|部署|构建|测试|端口|配置|日志|桌面|下载|路径|颜色|形状|馄饨|蜜雪|comfyui/gi;
  let m;
  while ((m = re.exec(t))) out.push(m[0].toLowerCase());
  return [...new Set(out)];
}

/**
 * Classify one clause. Returns kind:
 *   explicit_question | explicit_request | pending_task | casual_fragment
 * and a subtype for coverage checks.
 */
export function classifyClause(clause) {
  const t = clean(clause);
  if (!t) return null;

  const hasWh = WH_CORE.test(t);
  const hasRequest = REQUEST_VERB.test(t);
  const hasStatus = STATUS_ASK.test(t);
  const hasContent = CONTENT_NOUN.test(t);
  const endsQuestionParticle = /(?:吗|呢|么|不|没)\s*$/.test(t);
  const hasPunctQ = /[?？]/.test(t);

  // Explicit request wins (帮我看看 / 顺便帮我…).
  if (hasRequest && (hasContent || t.length >= 6)) {
    return {
      kind: "explicit_request",
      subtype: "action",
      text: t,
      keywords: keywordsOf(t),
      source: hasRequest ? "request_verb" : "content"
    };
  }

  // Wh-question with content: "头怎么会疼呢" / "刚才为什么报错".
  if (hasWh && (hasContent || t.length >= 8) && !isPureBanter(t)) {
    return {
      kind: "explicit_question",
      subtype: /为什么|为啥|怎么会|怎么回事/.test(t) ? "how_or_why" : "fact",
      text: t,
      keywords: keywordsOf(t),
      source: "wh_content"
    };
  }

  // Pending task / status: "那个文件你看了吗" / "任务跑完了吗".
  if (hasStatus || (hasContent && endsQuestionParticle && t.length >= 5 && !CASUAL_ONLY.test(t))) {
    return {
      kind: "pending_task",
      subtype: "status",
      text: t,
      keywords: keywordsOf(t),
      source: hasStatus ? "status_ask" : "content_status"
    };
  }

  // Punctuated / particle question that still carries content.
  if ((hasPunctQ || endsQuestionParticle) && hasContent && t.length >= 6 && !isPureBanter(t)) {
    return {
      kind: "explicit_question",
      subtype: /为什么|为啥|怎么/.test(t) ? "how_or_why" : "fact",
      text: t,
      keywords: keywordsOf(t),
      source: "content_question"
    };
  }

  return {
    kind: "casual_fragment",
    subtype: "banter",
    text: t,
    keywords: [],
    source: "default"
  };
}

/** Pure emotional / rhetorical banter — never an obligation. */
function isPureBanter(t) {
  const s = clean(t);
  if (!s) return true;
  if (s.length <= 8 && CASUAL_ONLY.test(s)) return true;
  // "咋了宝贝不行吗" / "你凶什么呀" — tease/challenge without content ask.
  if (!CONTENT_NOUN.test(s) && /(?:咋了|不行吗|什么呀|干嘛|烦|哼|不理|厉害|凶)/.test(s) && s.length <= 16) {
    return true;
  }
  return false;
}

/**
 * Analyze one user turn into clauses + hard obligations.
 * Casual-only turns stay free; mixed turns keep both banter and obligations.
 */
export function analyzeTurnCoverage(userText = "") {
  const clauses = splitClauses(userText).map(classifyClause).filter(Boolean);
  const obligations = clauses.filter(
    (c) => c.kind === "explicit_question" || c.kind === "explicit_request" || c.kind === "pending_task"
  );
  const casual = clauses.filter((c) => c.kind === "casual_fragment");
  return {
    clauses,
    obligations,
    casual,
    hasExplicitObligation: obligations.length > 0,
    hasCasual: casual.length > 0,
    mixed: obligations.length > 0 && casual.length > 0,
    casualOnly: obligations.length === 0 && casual.length > 0
  };
}

function replyLooksLikePureReaction(reply, obligation) {
  const r = clean(reply);
  if (!r) return true;
  const overlap = obligation.keywords.some((k) => r.toLowerCase().includes(k));
  if (overlap) return false;
  // Substantive answers almost never look like a pure  reaction.
  if (r.length >= 12) return false;
  if (Array.from(r).length >= 10) return false;
  const answerish =
    /(?:因为|可能|大概|估计|也许|没睡|着凉|累|上火|感冒|缺|导致|原因|看了|还没|跑完|弄完|做完了|好了|在|没|没有|找不到|给你|弄好|看一下|稍等|配|写错|端口|路径|色|方|圆|睡|吹|熬)/.test(
      r
    );
  return !answerish;
}

function obligationCovered(obligation, reply) {
  const r = clean(reply);
  if (!r) return false;
  const overlap = obligation.keywords.some((k) => r.toLowerCase().includes(k));
  if (overlap) return true;

  // Generous on purpose: any non-trivial answer-shaped text counts for
  // open how/why asks. We only want to catch pure banter-only reactions.
  if (obligation.kind === "explicit_question") {
    if (obligation.subtype === "how_or_why") {
      return (
        /(?:因为|可能|大概|估计|也许|没睡|着凉|累|上火|感冒|缺|导致|原因|压|熬|吹|冷|热|紧张|偏头|写错|配错|没电|堵|发炎)/.test(r) ||
        r.length >= 8
      );
    }
    return /(?:是|在|有|没|没有|看了|跑了|弄|做|好|行|可以|不行|红|蓝|方|圆|色|完)/.test(r) && r.length >= 6;
  }
  if (obligation.kind === "explicit_request" || obligation.kind === "pending_task") {
    return (
      /(?:看了|看了没|还没|跑完|弄完|做完了|好了|在|给你|找到了|弄好|稍等|马上|这就|开始|搞定|完成|行|可以|没)/.test(r) ||
      overlap ||
      r.length >= 10
    );
  }
  return false;
}

/**
 * Evaluate whether a candidate reply covers this turn's explicit obligations.
 * Generous on purpose: short answers that actually address the ask count;
 * pure banter-only reactions on mixed turns do not.
 */
export function evaluateReplyCoverage(userText = "", replyText = "") {
  const analysis = analyzeTurnCoverage(userText);
  if (!analysis.hasExplicitObligation) {
    return {
      complete: true,
      reason: "no_explicit_obligation",
      analysis,
      missing: [],
      covered: []
    };
  }

  const replies = Array.isArray(replyText)
    ? replyText.map((x) => clean(x)).filter(Boolean)
    : [clean(replyText)].filter(Boolean);
  const joined = replies.join("\n");
  const missing = [];
  const covered = [];

  for (const ob of analysis.obligations) {
    // Multi-bubble: any bubble may cover the obligation.
    let ok = replies.some((r) => obligationCovered(ob, r));
    // Combined reply that engages the obligation topic at all.
    if (!ok && joined) {
      ok =
        ob.keywords.some((k) => joined.toLowerCase().includes(k)) ||
        (joined.length >= 10 && !replyLooksLikePureReaction(joined, ob) && obligationCovered(ob, joined));
    }
    // Pure banter-only reaction never counts, even if short answer-shaped words appear
    // only on the casual side.
    if (ok && replies.length === 1 && replyLooksLikePureReaction(replies[0], ob)) {
      ok = false;
    }
    if (ok) covered.push(ob);
    else missing.push(ob);
  }

  return {
    complete: missing.length === 0,
    reason: missing.length === 0 ? "obligations_covered" : "explicit_obligation_uncovered",
    analysis,
    missing,
    covered
  };
}

/**
 * Compact coverage block for generation framing.
 * Mixed turns: banter first is fine; swallowing the explicit ask is not.
 */
export function turnCoverageBlock(analysisOrText = null) {
  const analysis =
    analysisOrText && typeof analysisOrText === "object" && Array.isArray(analysisOrText.clauses)
      ? analysisOrText
      : analyzeTurnCoverage(typeof analysisOrText === "string" ? analysisOrText : "");
  if (!analysis.hasExplicitObligation) {
    return [
      "【Turn Coverage】",
      "本句没有必须覆盖的明确问题/请求/任务；保持短、自然、可只抓一点。"
    ].join("\n");
  }
  const list = analysis.obligations.map((o, i) => `${i + 1}. [${o.kind}] ${o.text}`).join("；");
  return [
    "【Turn Coverage｜明确问题/请求不能吞】",
    `本句含明确待覆盖项：${list}`,
    analysis.mixed
      ? "可以先接住情绪/拌嘴，但同一轮还必须覆盖上面的明确项。"
      : "必须覆盖上面的明确项。",
    "闲聊碎片可以略；明确 question / request / task 不能因为前面有情绪互动就丢掉。",
    "不要机械逐句回应；不要为了完整写成小作文。可以短答，可以先拌嘴再答。",
    "可以 1 个气泡说完，也可以 2 个气泡（先反应、后回答）；整轮必须完成明确项。"
  ].join("\n");
}

/** True when selective attention must stay complete for this turn. */
export function requiresCompleteCoverage(userText = "") {
  return analyzeTurnCoverage(userText).hasExplicitObligation;
}
