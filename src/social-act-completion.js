/**
 * Social Act Completion v1
 *
 * Turn Coverage handles explicit question/request/task.
 * This layer handles social acts: apology, reconciliation, reassurance-seeking.
 * A grammatical sentence can still leave the social act hanging
 * (e.g. 「错什么错。」 after an apology).
 *
 * Keep it light: pure casual short replies stay short; only real social
 * acts need a closing social signal. Never force a second bubble or long comfort.
 */

const CLAUSE_SPLIT = /[，,。！？!?\n；;：:、]+/;

const APOLOGY =
  /(?:对不起|对不起了|抱歉|不好意思|我错了|我错啦|错了|不是故意|sorry|是我的错|是我不好|错怪)/i;

const REASSURANCE_SEEK =
  /(?:别生气|别气|别不理|别走|别丢下|是不是(?:在)?生气|你(?:还)?生气|你不理我|别嫌弃|别凶|别骂|还在(?:生)?气)/i;

const RELATIONSHIP_REPAIR =
  /(?:顺顺毛|和好吧|和好|不吵了|别吵|算了不跟你计较|不跟你计较|不计较了|这次是我不对|原谅我|别往心里去|当我没说)/i;

const GRIEVANCE =
  /(?:委屈|QAQ|呜呜|呜呜呜|难过|被凶|被骂|不耐烦|嫌弃我|不爱我了|你凶|吼我)/i;

/** Reply-side signals that the social loop is closed / care is shown. */
const SOCIAL_CLOSURE =
  /(?:没怪|没有怪|不怪|没生你?气|没生气|不生气|不会生气|没事|没关系|不用(?:道歉|说这个|这样|往心里)|知道了|知道啦|好啦|好了|行了|这次先|先放过|放过你|算了|不气|消气|不计较|逗你|开玩笑|骗你|笨|傻|蠢|过来|抱|乖|原谅|信你|谁怪你|怪你干嘛|干嘛道歉|道什么歉)/i;

/** Pure rhetorical deflection that often leaves apology hanging. */
const RHETORICAL_SHUT =
  /^(?:错|好|行|乖|傻|笨|气|怪|想|说|做)什么(?:错|好|行|乖|傻|笨|气|怪|想|说|做)[。.!！~～～]*$|^(?:哼|切|呵|哈|啧)[。.!！~～]*$/;

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
 * Detect which social acts this user turn is performing.
 * Returns [] for ordinary casual chat.
 */
export function detectUserSocialActs(userText = "") {
  const t = clean(userText);
  if (!t) return [];
  const acts = [];
  if (APOLOGY.test(t)) acts.push("apology");
  if (REASSURANCE_SEEK.test(t)) acts.push("reassurance_seek");
  if (RELATIONSHIP_REPAIR.test(t)) acts.push("relationship_repair");
  if (GRIEVANCE.test(t) && (APOLOGY.test(t) || REASSURANCE_SEEK.test(t) || RELATIONSHIP_REPAIR.test(t))) {
    acts.push("grievance");
  }
  return [...new Set(acts)];
}

function showsSocialClosure(reply) {
  return SOCIAL_CLOSURE.test(clean(reply));
}

function isHangingSocialDeflection(reply) {
  const r = clean(reply);
  if (!r) return true;
  if (showsSocialClosure(r)) return false;
  // Long substantive replies usually already carry stance.
  if (r.length >= 14) return false;
  if (RHETORICAL_SHUT.test(r)) return true;
  // Very short reply after a social act with zero care markers.
  return Array.from(r).length <= 8 && !showsSocialClosure(r);
}

/**
 * Is this user turn a real social act that needs completion?
 * Ordinary casual / praise / vent without apology-repair is NOT included.
 */
export function requiresSocialActCompletion(userText = "") {
  const acts = detectUserSocialActs(userText);
  return acts.length > 0;
}

/**
 * Evaluate whether a reply completes the social act(s) in the user turn.
 * Generous: short replies with a care/stance marker count.
 * Strict only against pure hanging deflections after apology/repair.
 */
export function evaluateSocialActCompletion(userText = "", replyText = "") {
  const acts = detectUserSocialActs(userText);
  if (!acts.length) {
    return {
      complete: true,
      reason: "no_social_act",
      acts,
      missing: []
    };
  }

  const replies = Array.isArray(replyText)
    ? replyText.map((x) => clean(x)).filter(Boolean)
    : [clean(replyText)].filter(Boolean);
  const joined = replies.join("\n");

  // Any bubble that shows social closure completes the turn.
  const closed = replies.some((r) => showsSocialClosure(r)) || showsSocialClosure(joined);

  // Apology/repair specifically: a pure rhetorical shut is not enough.
  const needsCare = acts.includes("apology") || acts.includes("relationship_repair") || acts.includes("reassurance_seek");
  if (needsCare && !closed) {
    const hanging = replies.length === 0 || replies.every((r) => isHangingSocialDeflection(r));
    if (hanging) {
      return {
        complete: false,
        reason: "social_act_hanging",
        acts,
        missing: acts,
        joined
      };
    }
  }

  // Grievance without care markers but with a real stance answer is OK.
  if (!closed && needsCare && joined.length >= 12 && !isHangingSocialDeflection(joined)) {
    return { complete: true, reason: "social_act_stanced", acts, missing: [], joined };
  }

  return {
    complete: true,
    reason: closed ? "social_act_closed" : "social_act_stanced",
    acts,
    missing: [],
    joined
  };
}

/**
 * Framing block for generation. Keep short; never demand a second bubble.
 */
export function socialActBlock(userText = "", evaluation = null) {
  const acts = evaluation?.acts?.length ? evaluation.acts : detectUserSocialActs(userText);
  if (!acts.length) return "";
  const labels = {
    apology: "用户在道歉/认错",
    reassurance_seek: "用户在求 reassurance / 怕你生气",
    relationship_repair: "用户在求和/修复关系",
    grievance: "用户带着委屈"
  };
  const list = acts.map((a) => labels[a] ?? a).join("；");
  return [
    "【Social Act｜社交动作要收住】",
    `本句社交动作：${list}`,
    "回应可以很短，但要把这个社交动作接住，不要停在纯反问/纯顶回去。",
    "例如认错时：先接住反应，再给一点点关系安全感（没怪你/没生气/不用道歉…）。口吻可以顶、可以逗，不必温柔长文。",
    "不要机械加第二句；不要写小作文；纯闲聊本身不需要这段。"
  ].join("\n");
}
