// Proactive ownership + candidate value：
// open loop / pending 不只是「还没结束」，还要知道「下一步轮到谁」。
// 禁止把讨论/已回答问题当成 awaiting_user_completion。

export const NEXT_ACTORS = Object.freeze({
  ASSISTANT: "assistant",
  USER: "user",
  SHARED: "shared",
  NONE: "none"
});

export const FOLLOWUP_KINDS = Object.freeze({
  AWAITING_USER_UPDATE: "awaiting_user_update",
  ASSISTANT_OWES_ANSWER: "assistant_owes_answer",
  SHARED_TOPIC: "shared_topic",
  UNFINISHED_DECISION: "unfinished_decision",
  RECENT_LIFE_EVENT: "recent_life_event"
});

const HOUR_MS = 3600_000;
const COMPLETION_BAN_RE = /弄好了没|搞好了没|跑完没|做完没|结束了没|完成了没|弄完了没|搞完了没/;
const RETURN_USER_RE = /(一会回来|等会回来|稍后|稍等|先去忙|去忙|跑一下|跑完再说|回来再说|回来丢|回来发|晚点说|回头再说|去测试|测完)/;
const WAIT_USER_PROVIDE_RE = /(等待用户|等你提供|等用户|用户提供|等你回|等你结果|等你进度)/;
const PLAN_TOPIC_RE = /(攒钱|攒到|以后|打算|计划|买设备|DXG|本地部署|压岁钱|过年|私密|写代码)/;
const QUESTION_RE = /(还要多久|多久才能|多少|怎么|为什么|是不是|能不能|行不行|吗[？?]?$|[？?])/;
const LIFE_DONE_RE = /(吃面|吃饱|出去吃|去玩|洗澡|睡觉|晚安|上学|下课|到家)/;

function textOf(value){return String(value??"").trim();}
function lower(value){return textOf(value).toLowerCase();}

/** Who should produce the next meaningful turn. */
export function classifyNextActor({topic="",userText="",assistantText="",assistantAnswered=false,followupKind=null}={}){
  const kind=normalizeFollowupKind(followupKind);
  if(kind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER)return NEXT_ACTORS.ASSISTANT;
  if(kind===FOLLOWUP_KINDS.SHARED_TOPIC)return NEXT_ACTORS.SHARED;
  if(kind===FOLLOWUP_KINDS.AWAITING_USER_UPDATE)return NEXT_ACTORS.USER;
  const u=lower(userText),a=lower(assistantText),t=lower(topic);
  if(assistantAnswered||(/回答|明白了|我听着了/.test(a)&&QUESTION_RE.test(u)))return NEXT_ACTORS.ASSISTANT;
  if(RETURN_USER_RE.test(u))return NEXT_ACTORS.USER;
  if(PLAN_TOPIC_RE.test(t)||PLAN_TOPIC_RE.test(u))return NEXT_ACTORS.SHARED;
  if(QUESTION_RE.test(u)&&!RETURN_USER_RE.test(u))return assistantAnswered?NEXT_ACTORS.NONE:NEXT_ACTORS.ASSISTANT;
  return NEXT_ACTORS.SHARED;
}

export function normalizeFollowupKind(kind){
  const k=String(kind??"").trim();
  return Object.values(FOLLOWUP_KINDS).includes(k)?k:null;
}

/**
 * Build ownership for a new/upserted open loop or pending expectation.
 * Never default discussion / answered questions into awaiting_user_completion.
 */
export function classifyOwnership({topic="",userText="",assistantText="",assistantAnswered=false,explicitKind=null,explicitActor=null,sourceMessageId=null,at=new Date()}={}){
  const kind=normalizeFollowupKind(explicitKind);
  const u=textOf(userText),a=textOf(assistantText),t=textOf(topic);
  let followupKind=kind;
  let nextExpectedActor=explicitActor&&Object.values(NEXT_ACTORS).includes(explicitActor)?explicitActor:null;

  if(!followupKind){
    if(WAIT_USER_PROVIDE_RE.test(t+u)){
      followupKind=FOLLOWUP_KINDS.AWAITING_USER_UPDATE;
    }else if(RETURN_USER_RE.test(u)){
      followupKind=FOLLOWUP_KINDS.AWAITING_USER_UPDATE;
    }else if(PLAN_TOPIC_RE.test(t)||PLAN_TOPIC_RE.test(u)){
      // 攒钱/本地部署这类持续计划：不是任务完成清单
      followupKind=FOLLOWUP_KINDS.SHARED_TOPIC;
    }else if(QUESTION_RE.test(u)&&!RETURN_USER_RE.test(u)){
      followupKind=assistantAnswered?FOLLOWUP_KINDS.SHARED_TOPIC:FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER;
    }else if(/犹豫|决定|选哪个|怎么办|要不要/.test(u+t)){
      followupKind=FOLLOWUP_KINDS.UNFINISHED_DECISION;
    }else{
      followupKind=FOLLOWUP_KINDS.SHARED_TOPIC;
    }
  }

  if(!nextExpectedActor)nextExpectedActor=classifyNextActor({topic:t,userText:u,assistantText:a,assistantAnswered,followupKind});
  // answered user question must not stay assistant_owes_answer
  if(followupKind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER&&assistantAnswered){
    followupKind=FOLLOWUP_KINDS.SHARED_TOPIC;
    nextExpectedActor=NEXT_ACTORS.SHARED;
  }
  if(followupKind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER)nextExpectedActor=NEXT_ACTORS.ASSISTANT;
  if(followupKind===FOLLOWUP_KINDS.AWAITING_USER_UPDATE)nextExpectedActor=NEXT_ACTORS.USER;
  if(followupKind===FOLLOWUP_KINDS.SHARED_TOPIC&&nextExpectedActor===NEXT_ACTORS.USER&&/攒钱|部署|升级|计划|打算/.test(t+u)){
    nextExpectedActor=NEXT_ACTORS.SHARED;
  }

  return {
    followup_kind:followupKind,
    next_expected_actor:nextExpectedActor,
    expected_information:expectedInformationFor(followupKind,t,u),
    source_message_id:sourceMessageId??null,
    created_at:(at instanceof Date?at:new Date(at)).toISOString()
  };
}

function expectedInformationFor(kind,topic,userText){
  if(kind===FOLLOWUP_KINDS.AWAITING_USER_UPDATE)return "user_progress_or_return";
  if(kind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER)return "assistant_answer";
  if(kind===FOLLOWUP_KINDS.UNFINISHED_DECISION)return "shared_decision";
  if(kind===FOLLOWUP_KINDS.SHARED_TOPIC)return "optional_soft_update";
  return null;
}

/** Whether a completion-style follow-up (弄好了没) is allowed for this candidate. */
export function allowsCompletionFollowup(item){
  const kind=normalizeFollowupKind(item?.followup_kind??item?.followupKind??item?.kind);
  const actor=String(item?.next_expected_actor??item?.nextExpectedActor??"").trim();
  if(kind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER||actor===NEXT_ACTORS.ASSISTANT)return false;
  if(kind===FOLLOWUP_KINDS.SHARED_TOPIC||actor===NEXT_ACTORS.SHARED)return false;
  if(kind===FOLLOWUP_KINDS.AWAITING_USER_UPDATE||actor===NEXT_ACTORS.USER)return true;
  return false;
}

export function isResolvedish(item){
  if(!item)return true;
  if(item.resolved||item.state==="resolved"||item.state==="expired"||item.state==="satisfied"||item.state==="abandoned")return true;
  return false;
}

/** Final consistency gate before generating/sending a proactive candidate. */
export function inspectCandidateQualification(item,ctx={}){
  const at=ctx.at instanceof Date?ctx.at:new Date(ctx.at??Date.now());
  const nowMs=at.getTime();
  if(isResolvedish(item))return {ok:false,reason:"resolved",item};
  const kind=normalizeFollowupKind(item?.followup_kind??item?.followupKind);
  const actor=String(item?.next_expected_actor??item?.nextExpectedActor??"").trim();
  if(kind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER||actor===NEXT_ACTORS.ASSISTANT){
    return {ok:false,reason:"assistant_owes_answer",item};
  }
  const expires=Date.parse(item?.expires_at??item?.expiresAt??"");
  if(Number.isFinite(expires)&&nowMs>expires)return {ok:false,reason:"stale_expired",item};
  if(item?.stale)return {ok:false,reason:"stale",item};
  if(ctx.knownAnswer&&topicHits(ctx.knownAnswer,item?.topic)){
    return {ok:false,reason:"known_answer",item};
  }
  if(ctx.userAnsweredTopic&&topicHits(ctx.userAnsweredTopic,item?.topic)){
    // user already reported result; completion follow-up is invalid
    if(!allowsCompletionFollowup(item))return {ok:false,reason:"user_answered",item};
  }
  if(ctx.completionStyle&&!allowsCompletionFollowup(item)){
    return {ok:false,reason:"completion_forbidden",item};
  }
  if(kind===FOLLOWUP_KINDS.SHARED_TOPIC&&ctx.recentlyDiscussed&&topicHits(ctx.recentlyDiscussed,item?.topic)){
    return {ok:false,reason:"same_topic_repeat",item};
  }
  const salience=Number(item?.salience??0.5);
  if(Number.isFinite(salience)&&salience<0.35)return {ok:false,reason:"low_salience",item};
  return {ok:true,reason:"ok",item};
}

function topicHits(needles,topic){
  const t=lower(topic);
  if(!t)return false;
  const list=Array.isArray(needles)?needles:[needles];
  return list.some(n=>{
    const x=lower(n);
    if(!x)return false;
    return t.includes(x)||x.includes(t)||similarLoose(t,x);
  });
}

function similarLoose(a,b){
  if(!a||!b)return false;
  const xs=new Set(a),ys=new Set(b);
  let inter=0;for(const ch of xs)if(ys.has(ch))inter++;
  return inter/Math.max(xs.size,ys.size)>=0.72;
}

/**
 * Value ranking for proactive candidates.
 * Not first-hit-wins: prefer fresher, more unresolved, actor=user reasons.
 */
export function scoreProactiveCandidate(candidate,ctx={}){
  if(!candidate)return -Infinity;
  const at=ctx.at instanceof Date?ctx.at:new Date(ctx.at??Date.now());
  const nowMs=at.getTime();
  const qualification=inspectCandidateQualification(candidate,ctx);
  if(!qualification.ok)return -1000;

  let score=0;
  const kind=String(candidate.kind??"").trim();
  const presenceReason=String(candidate.presenceReason??"").trim();
  const followupKind=normalizeFollowupKind(candidate.followup_kind??candidate.followupKind??(kind==="presence"?presenceReason:null));
  const actor=String(candidate.next_expected_actor??candidate.nextExpectedActor??"").trim();
  const salience=Number(candidate.salience??candidate.urgency??0.5);

  if(kind==="followup")score+=70;
  else if(presenceReason==="pending_expectation_followup")score+=85;
  else if(presenceReason==="open_loop_followup")score+=75;
  else if(presenceReason==="thought_seed")score+=55;
  else if(kind==="inactivity")score+=40;
  else if(kind==="event")score+=60;
  else score+=30;

  if(followupKind===FOLLOWUP_KINDS.AWAITING_USER_UPDATE)score+=20;
  if(followupKind===FOLLOWUP_KINDS.RECENT_LIFE_EVENT)score+=15;
  if(followupKind===FOLLOWUP_KINDS.UNFINISHED_DECISION)score+=8;
  if(followupKind===FOLLOWUP_KINDS.SHARED_TOPIC)score-=8;
  if(followupKind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER||actor===NEXT_ACTORS.ASSISTANT)return -1000;

  if(Number.isFinite(salience))score+=Math.max(0,Math.min(1,salience))*20;

  const created=Date.parse(candidate.created_at??candidate.createdAt??"");
  if(Number.isFinite(created)){
    const ageH=(nowMs-created)/HOUR_MS;
    if(ageH<2)score+=12;
    else if(ageH<12)score+=6;
    else if(ageH>36)score-=18;
    else if(ageH>72)score-=30;
  }

  const expected=Date.parse(candidate.expected_followup_at??candidate.expectedInformationAt??"");
  if(Number.isFinite(expected)){
    const overdueH=(nowMs-expected)/HOUR_MS;
    if(overdueH>=0&&overdueH<6)score+=10;
    if(overdueH>48)score-=15;
  }

  if(Array.isArray(ctx.recentProactiveTopics)&&ctx.recentProactiveTopics.length){
    const topic=String(candidate.topic??"");
    if(topicHits(ctx.recentProactiveTopics,topic))score-=25;
  }
  if(Array.isArray(ctx.recentUserTopics)&&ctx.recentUserTopics.length){
    const topic=String(candidate.topic??"");
    if(topicHits(ctx.recentUserTopics,topic)){
      score-=followupKind===FOLLOWUP_KINDS.SHARED_TOPIC?18:6;
    }
  }

  if(candidate.highValue)score+=30;
  return score;
}

export function rankProactiveCandidates(candidates=[],ctx={}){
  return (Array.isArray(candidates)?candidates:[])
    .map(candidate=>({candidate,score:scoreProactiveCandidate(candidate,ctx)}))
    .filter(row=>row.score>-100)
    .sort((a,b)=>b.score-a.score);
}

/** Subject line guidance for the generator — never a universal completion template. */
export function composeOwnershipSubject(candidate,ctx={}){
  const kind=normalizeFollowupKind(candidate?.followup_kind??candidate?.followupKind);
  const topic=String(candidate?.topic??"之前的话题").slice(0,160);
  const hours=Number(ctx.silenceHours??NaN);
  const hourNote=Number.isFinite(hours)?`距离上次互动约 ${hours.toFixed(1)} 小时。`:"";
  if(kind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER||candidate?.next_expected_actor===NEXT_ACTORS.ASSISTANT){
    return {blocked:true,subject:"assistant_owes_answer 不得对用户使用 completion follow-up"};
  }
  if(kind===FOLLOWUP_KINDS.SHARED_TOPIC||candidate?.next_expected_actor===NEXT_ACTORS.SHARED){
    return {
      blocked:false,
      subject:[
        hourNote,
        `这是一个持续话题（不是待办任务）：${topic}`,
        "请用很自然的方式轻轻提起，像想起一件事。可以问最近还在想吗/有新进展吗，但禁止「弄好了没/跑完没/做完了没」这类任务进度追问。"
      ].filter(Boolean).join("\n")
    };
  }
  if(kind===FOLLOWUP_KINDS.AWAITING_USER_UPDATE||candidate?.next_expected_actor===NEXT_ACTORS.USER){
    return {
      blocked:false,
      subject:[
        hourNote,
        `之前聊到的事情：${topic}`,
        "如果它仍然值得接，就像突然想起这件事一样自然提起，允许问结果；不要像检查清单、催办或质问。"
      ].filter(Boolean).join("\n")
    };
  }
  if(kind===FOLLOWUP_KINDS.UNFINISHED_DECISION){
    return {
      blocked:false,
      subject:[
        hourNote,
        `还有个没说完的话题：${topic}`,
        "可以自然提起，不要像催任务。"
      ].filter(Boolean).join("\n")
    };
  }
  if(kind===FOLLOWUP_KINDS.RECENT_LIFE_EVENT){
    return {
      blocked:false,
      subject:[hourNote,`最近的生活片段：${topic}`,"可以关心一下未知的部分，不要问已经知道的事。"].filter(Boolean).join("\n")
    };
  }
  return {
    blocked:false,
    subject:[hourNote,`之前聊到：${topic}`,"请自然提起，禁止机械任务进度追问。"].filter(Boolean).join("\n")
  };
}

export function looksLikeCompletionFollowup(text){
  return COMPLETION_BAN_RE.test(String(text??""));
}

/** Reconcile a stored loop/expectation after a full turn. Returns patch or null. */
export function reconcileOwnershipAfterTurn({item,userText="",assistantText="",at=new Date()}={}){
  if(!item||isResolvedish(item))return null;
  const u=textOf(userText),a=textOf(assistantText);
  const assistantAnswered=a.length>=8&&!/还在看|马上|等等|我看看|这个任务工作量/.test(a);
  const userReported=/跑完了|弄好了|搞定了|完成了|结束了|好了|可以了|不用了|吃饱了|吃完了/.test(u);
  const planTalk=PLAN_TOPIC_RE.test(u)||PLAN_TOPIC_RE.test(String(item.topic??""));
  const returnPromised=RETURN_USER_RE.test(u);

  if(userReported&&allowsCompletionFollowup(item)){
    return {resolved:true,resolve_reason:"user_reported_done",resolved_at:(at instanceof Date?at:new Date(at)).toISOString()};
  }
  // answered user question should not stay assistant_owes_answer
  if(normalizeFollowupKind(item.followup_kind??item.followupKind)===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER&&assistantAnswered){
    return {
      followup_kind:FOLLOWUP_KINDS.SHARED_TOPIC,
      next_expected_actor:NEXT_ACTORS.SHARED,
      resolved:true,
      resolve_reason:"assistant_answered",
      resolved_at:(at instanceof Date?at:new Date(at)).toISOString()
    };
  }
  if(planTalk&&!returnPromised){
    const ownership=classifyOwnership({topic:item.topic,userText:u,assistantText:a,assistantAnswered:true,at});
    return {
      followup_kind:ownership.followup_kind,
      next_expected_actor:ownership.next_expected_actor,
      last_touched_at:(at instanceof Date?at:new Date(at)).toISOString()
    };
  }
  if(returnPromised){
    const ownership=classifyOwnership({topic:item.topic,userText:u,assistantText:a,assistantAnswered:false,explicitKind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,at});
    return {
      followup_kind:ownership.followup_kind,
      next_expected_actor:ownership.next_expected_actor,
      last_touched_at:(at instanceof Date?at:new Date(at)).toISOString()
    };
  }
  return null;
}

export { COMPLETION_BAN_RE };
