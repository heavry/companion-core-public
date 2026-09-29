import crypto from "node:crypto";
import { config } from "./config.js";
import { findProactiveMessageByAttemptKey,getLatestUserMessageAt,getLatestUserSession,getSession,insertUsage,listRecentEvents,listRecentMessagesAfter,getPreviousRealInteraction } from "./db.js";
import { requirePersona } from "./persona.js";
import { upstreamChat,upstreamResponseInfo,usageUpstreamModel } from "./upstream.js";
import { publishEvent } from "./events-bus.js";
import { deliver,resolveDailyChatSession } from "./router.js";
import { buildInjectedMessages } from "./context.js";
import { moduleRegistry } from "./modules/registry.js";
import {
  beginProactiveAttempt,finishProactiveAttempt,getBehavior,evaluateProactiveGate,duePendingFollowups,completeFollowup,
  markEventsConsumed,getState,noteProactiveSent,pushRecentTopic,touchUserInteraction,addPendingFollowup,
  expirePendingFollowups,noteInactivityCheck,reconcileUserInteraction,saveState,effectiveLastUserInteractionAt,markCognitionWakeHandled
} from "./companion-state.js";
import { triggerEngine } from "./modules/triggers.js";
import { companionTime } from "./time-service.js";
import { autonomousLife } from "./autonomous-life/index.js";
import { evaluateInactivityEligibility } from "./inactivity-proactive.js";
import { NATURAL_MESSAGING_PROACTIVE_SYSTEM,deliverBubbleSequence,naturalMessagingEnabled,parseNaturalBubbles } from "./natural-messaging.js";
import { naturalPresence,decideContact,presenceContext } from "./natural-presence/index.js";
import { naturalCognition } from "./natural-cognition/index.js";
import { selectReturnStance,stanceGuidanceBlock } from "./silence-return-stance.js";
import { episodeContextBlock, rewriteProactiveTopic, contradictsKnownEpisode } from "./recent-episodes/index.js";
import { contactSuppression,classifyExplainedAbsence } from "./contact-suppression.js";
import { proactiveCognitionMetrics } from "./proactive-cognition-metrics.js";
import {
  relationshipContinuity,
  IMPRESSION_TYPES,
  hasUnansweredOutreach,
  unansweredOutreachHours
} from "./relationship-continuity.js";
import {
  appraiseAbsenceFromRuntime,
  absenceGuidanceBlock,
  absenceEmotionSignal,
  absenceAppraisalDiagnostics
} from "./absence-appraisal.js";
import { evolveEmotion } from "./emotion-causality.js";
import {
  FOLLOWUP_KINDS,NEXT_ACTORS,allowsCompletionFollowup,composeOwnershipSubject,inspectCandidateQualification,
  looksLikeCompletionFollowup,normalizeFollowupKind,rankProactiveCandidates
} from "./proactive-ownership.js";

// Proactive Decision Engine。
// 原则：本地规则先行筛选，只有确实值得联系时才调用一次 Chat 路由模型生成自然表达；
// 用户未回复时绝不追发；quiet hours / cooldown / daily cap 硬性生效。
// 主动消息走正常 Chat/model 路由（upstreamChat mode=chat），绝不走 summary 路由。
// Natural Messaging：模型可返回 1–3 个独立气泡；每条都是真实 DB message。

const FOLLOWUP_TOPIC_IMAGE=/(画|图|照片|头像|壁纸|插画)/;
const IMPORTANT_EVENT_IMPORTANCE=0.7;
const EVENT_MAX_AGE_MS=24*3600_000;
const GENERATION_RETRY_MS=60*60_000;
const PROACTIVE_GUARD=[
  "【主动消息生成约束】",
  "你正在以 Companion 人物身份，主动给用户发短消息。",
  "允许：自然的人物感、轻微想念、轻松抱怨、与最近话题相关的具体细节。",
  "禁止：系统通知/提醒口吻、威胁、羞辱、控制、情感勒索、质问用户为什么不回复、连续追问。"
].join("\n");

function asDate(value=new Date()){const date=value instanceof Date?value:new Date(value);if(Number.isNaN(date.getTime()))throw new Error("invalid proactive time");return date;}

function effectiveStateForEligibility(state=getState()){
  const last=effectiveLastUserInteractionAt(state);
  return last===state.lastUserInteractionAt?state:{...state,lastUserInteractionAt:last};
}

function silenceMs(state,at=new Date()){
  const lastMs=Date.parse(effectiveLastUserInteractionAt(state)??"");
  return Number.isFinite(lastMs)?Math.max(0,asDate(at).getTime()-lastMs):Infinity;
}

function unansweredContinuity(state,at=new Date()){
  const elapsed=silenceMs(state,at);
  return {
    timeSinceLastUserReplyHours:Number.isFinite(elapsed)?elapsed/3600_000:null,
    unansweredProactiveStreak:Math.max(0,Number(state.consecutiveUnansweredProactive)||0),
    lastProactiveSentAt:state.lastProactiveAt??null
  };
}

function comparableTopic(value){return String(value??"").toLowerCase().replace(/[^\p{L}\p{N}]+/gu,"");}

function topicOverlap(topic,text){
  const target=comparableTopic(topic),body=comparableTopic(text);
  if(target.length<2||body.length<2)return false;
  if(target.includes(body)||body.includes(target))return true;
  const chars=[...new Set([...target])];
  return chars.filter(char=>body.includes(char)).length/Math.min(chars.length,6)>=0.34;
}

function focusMatchesRecentUserTopic(topic,recentTopics=[]){
  const latest=(Array.isArray(recentTopics)?recentTopics:[]).find(item=>comparableTopic(item).length>=5);
  return Boolean(latest&&topicOverlap(topic,latest));
}

function proactiveReason(candidate){
  if(candidate?.proactiveReason)return candidate.proactiveReason;
  if(candidate?.kind==="followup")return "expectation_followup";
  if(candidate?.kind==="event")return "recent_event_followup";
  if(candidate?.kind!=="presence")return "unknown";
  if(candidate.presenceReason==="pending_expectation_followup")return "expectation_followup";
  if(candidate.presenceReason==="open_loop_followup"){
    return candidate.followup_kind===FOLLOWUP_KINDS.RECENT_LIFE_EVENT?"concern":"open_loop_callback";
  }
  if(candidate.presenceReason==="thought_seed")return "curiosity";
  if(candidate.presenceReason==="focus_callback")return "spontaneous_continuation";
  if(candidate.presenceReason==="pure_social_contact")return "pure_social_contact";
  return "relationship_contact";
}

function proactiveAttemptKey(candidate,cognitionWake=null){
  const state=effectiveStateForEligibility(getState());
  const base=effectiveLastUserInteractionAt(state)??"no_user_interaction";
  let identity=null;
  if(candidate?.kind==="followup")identity=`followup:${candidate.followup?.id??candidate.topic}`;
  else if(candidate?.kind==="event")identity=`event:${candidate.event?.id??candidate.topic}`;
  else if(candidate?.openLoopId)identity=`open_loop:${candidate.openLoopId}:${Number(candidate.openLoopContactCount??0)}`;
  else if(candidate?.expectationId)identity=`expectation:${candidate.expectationId}:${Number(candidate.expectationReminderCount??0)}`;
  else if(candidate?.thoughtSeedId)identity=`thought_seed:${candidate.thoughtSeedId}`;
  else if(candidate?.presenceReason==="absence_contact")identity=`absence_contact:${cognitionWake?.opportunityKey??"no_wake"}`;
  else if(candidate?.proactiveReason==="spontaneous_continuation"||candidate?.proactiveReason==="pure_social_contact")identity=`${candidate.proactiveReason}:${cognitionWake?.opportunityKey??"no_wake"}`;
  if(!identity)return null;
  return `proactive_${crypto.createHash("sha256").update(`${base}|${identity}`).digest("hex").slice(0,28)}`;
}

export function gatherCandidateSet({at=new Date()}={}){
  const date=asDate(at),atMs=date.getTime();
  const behavior=getBehavior(),rawState=getState(),state=effectiveStateForEligibility(rawState);
  const candidates=[];
  const activeSuppression=contactSuppression.active(date);
  const sourceSession=getLatestUserSession(config.defaultPersonaId),topic=String(state.recentTopics?.[0]??"").trim();
  const cognitionWake=evaluateInactivityEligibility({state,at:date,hasSuitableContext:Boolean(topic||sourceSession)});
  if(activeSuppression){
    return {candidates,inactivity:cognitionWake,cognitionWake,sourceSession,presenceDecision:{action:"WAIT",reason:"post_closure_suppression",until:activeSuppression.until},suppressionActive:true};
  }
  for(const fu of duePendingFollowups(atMs)){
    candidates.push({
      kind:"followup",followup:fu,score:70,topic:fu.topic,proactiveReason:"expectation_followup",
      created_at:fu.createdAt,expected_followup_at:fu.earliestAt,
      followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,
      next_expected_actor:NEXT_ACTORS.USER,
      highValue:true
    });
  }
  if(behavior.weatherAwareness){
    const lastProactive=state.lastProactiveAt?Date.parse(state.lastProactiveAt):0;
    for(const e of listRecentEvents(config.defaultPersonaId,50)){
      if(Number(e.importance)<IMPORTANT_EVENT_IMPORTANCE)continue;
      if((state.consumedEventIds??[]).includes(e.id))continue;
      if(!e.created_at||Date.parse(e.created_at)<atMs-EVENT_MAX_AGE_MS)continue;
      if(lastProactive&&Date.parse(e.created_at)<lastProactive)continue;
      candidates.push({kind:"event",event:e,score:60+Math.round(Number(e.importance)*10),topic:e.content,created_at:e.created_at,proactiveReason:"recent_event_followup"});
    }
  }
  // Inactivity opens one cognition opportunity. It is never inserted as a
  // candidate and cannot become the message subject by itself.
  const presenceDecision=naturalPresence.enabled
    ? naturalPresence.contactDecision({
        lastUserInteractionAt:effectiveLastUserInteractionAt(state),
        at:date,
        inactivity:cognitionWake,
        cognition:naturalCognition.contactInput(date),
        suppression:contactSuppression.active(date)
      })
    : null;
  if(presenceDecision?.action==="START_CONVERSATION"&&["open_loop_followup","thought_seed","pending_expectation_followup"].includes(presenceDecision.reason)){
    const openLoop=presenceDecision.openLoopId
      ? naturalPresence.document.open_loops.find(l=>l.id===presenceDecision.openLoopId)
      : null;
    const followupKind=normalizeFollowupKind(presenceDecision.followup_kind??openLoop?.followup_kind)??null;
    // assistant 还欠回答：绝不对用户发 completion follow-up
    if(!(followupKind===FOLLOWUP_KINDS.ASSISTANT_OWES_ANSWER||presenceDecision.next_expected_actor===NEXT_ACTORS.ASSISTANT)){
      const rewritten=rewriteProactiveTopic(presenceDecision.topic||topic||"");
      if(!rewritten.suppress){
        const item={
          topic:rewritten.topic||presenceDecision.topic||topic||"之前的话题",
          followup_kind:followupKind,
          next_expected_actor:String(presenceDecision.next_expected_actor??openLoop?.next_expected_actor??"").trim()||null,
          salience:Number(openLoop?.salience??presenceDecision.urgency??0.55),
          created_at:openLoop?.created_at??null,
          expected_followup_at:openLoop?.expected_followup_at??null,
          expires_at:openLoop?.expires_at??null,
          resolved:Boolean(openLoop?.resolved)
        };
        const qualification=inspectCandidateQualification(item,{
          at:date,
          recentlyDiscussed:(state.recentTopics??[]).slice(0,5),
          userAnsweredTopic:null,
          knownAnswer:null,
          completionStyle:false
        });
        if(qualification.ok){
          candidates.push({
            kind:"presence",
            presenceReason:presenceDecision.reason,
            proactiveReason:proactiveReason({kind:"presence",presenceReason:presenceDecision.reason,followup_kind:item.followup_kind}),
            topic:item.topic,
            openLoopId:presenceDecision.openLoopId??null,
            openLoopContactCount:Number(openLoop?.contact_count??0),
            thoughtSeedId:presenceDecision.thoughtSeedId??null,
            expectationId:presenceDecision.expectationId??null,
            expectationReminderCount:Number(naturalCognition.document.expectations.find(e=>e.id===presenceDecision.expectationId)?.reminder_count??0),
            urgency:presenceDecision.urgency??0.5,
            followup_kind:item.followup_kind,
            next_expected_actor:item.next_expected_actor,
            completion_followup_allowed:allowsCompletionFollowup(item),
            highValue:presenceDecision.reason==="pending_expectation_followup"||followupKind===FOLLOWUP_KINDS.AWAITING_USER_UPDATE,
            sourceSessionId:sourceSession?.id??null,
            score:presenceDecision.reason==="open_loop_followup"?75:65
          });
        }
      }
    }
  }

  if(cognitionWake.eligible){
    absenceAppraisalDiagnostics.absenceWakeCount++;
    const focusDoc=naturalCognition.enabled?naturalCognition.document?.focus:null;
    const focus=focusDoc?.primary??null;
    const focusUpdated=Date.parse(focusDoc?.updated_at??"");
    const focusAgeHours=Number.isFinite(focusUpdated)?Math.max(0,(atMs-focusUpdated)/3600_000):Infinity;
    const focusTopic=String(focus?.topic??"").trim();
    const hasResolvedRelatedItem=[...(naturalPresence.document?.open_loops??[]),...(naturalCognition.document?.expectations??[])]
      .some(item=>{
        const stateName=String(item.state??"").toLowerCase();
        const isResolved=Boolean(item.resolved)||["fulfilled","satisfied","cancelled","abandoned","expired","retired"].includes(stateName);
        return isResolved&&topicOverlap(focusTopic,item.topic);
      });
    if(focus?.source==="active_topic"&&Number(focus.salience??0)>=0.65&&focusAgeHours<=20
      &&focusTopic&&focusMatchesRecentUserTopic(focusTopic,state.recentTopics)&&!hasResolvedRelatedItem){
      candidates.push({
        kind:"presence",presenceReason:"focus_callback",proactiveReason:"spontaneous_continuation",
        topic:focusTopic,followup_kind:FOLLOWUP_KINDS.SHARED_TOPIC,next_expected_actor:NEXT_ACTORS.SHARED,
        salience:Number(focus.salience??0.7),created_at:focusDoc.updated_at,
        sourceSessionId:sourceSession?.id??null,highValue:false,score:58
      });
    }

    // Absence Appraisal: silence is evidence, not a message reason.
    // Candidate only when relationship continuity exists (unanswered outreach / pending wait).
    const presenceSnap=naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null;
    const closeness=Number(presenceSnap?.dimensions?.closeness?.current??0.6);
    const explainedLeave=Boolean(contactSuppression.active(date)?.until);
    const pendingExpectation=(naturalCognition.document?.expectations??[]).some(e=>e.state==="pending");
    const unansweredImp=relationshipContinuity.findByType(IMPRESSION_TYPES.UNANSWERED_OUTREACH,date);
    const absenceAppraisal=appraiseAbsenceFromRuntime({
      silenceHours:cognitionWake.inactivityHours,
      closeness,
      explicitLeave:explainedLeave,
      knownBusy:relationshipContinuity.findByType(IMPRESSION_TYPES.USER_RECENTLY_BUSY,date).length>0
        ||relationshipContinuity.findByType(IMPRESSION_TYPES.EXPLAINED_ABSENCE,date).length>0,
      pendingExpectation,
      currentEmotion:naturalPresence.document?.emotion_state??null,
      previousOutreachCount:Math.max(state.consecutiveUnansweredProactive??0, unansweredImp.length?1:0),
      at:date
    });
    const continuityReason=absenceAppraisal.previous_outreach_count>0
      ||unansweredImp.length>0
      ||hasUnansweredOutreach(date);
    // Unexpected absence can itself be candidate evidence when closeness/salience
    // are high — still not a deterministic send (gate/cooldown/suppression remain).
    const futurePendingWait=naturalCognition.document.expectations.some((e)=>{
      if(e.state!=="pending")return false;
      const due=Date.parse(e.expected_followup_at??e.expires_at??"");
      return Number.isFinite(due)&&due>date.getTime();
    });
    const unexpectedAbsenceOk=!absenceAppraisal.explained
      &&!explainedLeave
      &&absenceAppraisal.unexpected
      &&Boolean(absenceAppraisal.unexpected_absence_candidate)
      &&!futurePendingWait
      &&closeness>=0.72
      &&(cognitionWake.inactivityHours??0)>=20;
    if((continuityReason||unexpectedAbsenceOk)
      &&(absenceAppraisal.should_consider_contact||unexpectedAbsenceOk)
      &&!absenceAppraisal.explained
      &&closeness>=0.35){
      try{
        const signal=absenceEmotionSignal(absenceAppraisal);
        if(signal&&naturalPresence.enabled&&typeof naturalPresence.applyAbsenceEmotionSignal==="function"){
          naturalPresence.applyAbsenceEmotionSignal(signal,date);
        }
      }catch{}
      candidates.push({
        kind:"presence",
        presenceReason:"absence_contact",
        proactiveReason:continuityReason?"unanswered_outreach":"concern",
        topic:continuityReason?"上次主动联系后对方还没回":"关系很近却很久没出现",
        followup_kind:FOLLOWUP_KINDS.AWAITING_USER_UPDATE,
        next_expected_actor:NEXT_ACTORS.USER,
        salience:Number(absenceAppraisal.salience),
        absenceAppraisal,
        highValue:Boolean(continuityReason||unexpectedAbsenceOk),
        sourceSessionId:sourceSession?.id??null,
        score:continuityReason?72:(unexpectedAbsenceOk?64:58)
      });
    }

    if(!candidates.length){
      const presence=naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null;
      const socialDrive=Number(presence?.dimensions?.social_drive?.current??0);
      const energy=Number(presence?.dimensions?.energy?.current??0.5);
      const irritation=Number(presence?.dimensions?.irritation?.current??0);
      if(socialDrive>=0.78&&energy>=0.35&&irritation<0.72&&!contactSuppression.active(date)?.until){
        candidates.push({kind:"presence",presenceReason:"pure_social_contact",proactiveReason:"pure_social_contact",topic:"日常里想说的一句话",sourceSessionId:sourceSession?.id??null,highValue:false,score:42});
      }
    }
  }
  const ranked=rankProactiveCandidates(candidates,{
    at:date,
    recentProactiveTopics:(state.recentTopics??[]).slice(0,3),
    recentUserTopics:(state.recentTopics??[]).slice(0,5)
  }).map(row=>({...row.candidate,score:row.score}));
  return {candidates:ranked,inactivity:cognitionWake,cognitionWake,sourceSession,presenceDecision,suppressionActive:false};
}
export function gatherCandidates(options={}){return gatherCandidateSet(options).candidates;}

function needsImage(followup){return FOLLOWUP_TOPIC_IMAGE.test(followup?.topic??"");}
function candidateDeliveryKind(candidate){return candidate?.kind==="followup"&&needsImage(candidate.followup)?"image":"message";}

/** Weak social expectation only when the proactive text actually asks for a reply. */
function expectsReplyFromBubbles(bubbles=[]){
  const text=Array.isArray(bubbles)?bubbles.join("\n"):"";
  if(!text.trim())return false;
  if(/[?？]/.test(text))return true;
  if(/回我|回消息|跟我说一声|说一声|告诉我|到家|到了说|弄完告诉我|忙完找我/.test(text))return true;
  if(/还活着|人呢|在吗|你还好吗|没事吧/.test(text))return true;
  return false;
}

export function composeUserSubject(kind,candidate,stanceResult=null){
  if(kind==="followup"){
    const ownership=composeOwnershipSubject(candidate,{silenceHours:null});
    return ownership.blocked
      ?`用户之前说过：“${candidate.followup.topic}”。请自然提起，不要任务质问。`
      :ownership.subject.replace(/距离上次互动约[^\n]*\n?/,"").replace(`话题：${candidate.followup.topic}`,`话题：${candidate.followup.topic}`);
  }
  if(kind==="event")return `刚发生了这件事：${candidate.event.content}\n请写一条自然的主动分享短消息。`;
  if(kind==="inactivity")return null;
  if(kind==="presence"){
    const reason=candidate.presenceReason??"open_loop_followup";
    if(candidate.proactiveReason==="pure_social_contact"){
      return "你现在只是想自然地和用户说句话。分享一个轻松、具体的小想法或直接表达想找他聊聊；避免空泛确认式开场，不讨论联系间隔，也不要编造你在现实中的活动。";
    }
    if(reason==="focus_callback"){
      return `你刚又想到用户最近在聊的“${candidate.topic}”。顺着这个具体话题自然接一句自己的观察或好奇；不要提沉默时间，不要编造新进展，也不要像提醒任务。`;
    }
    if(reason==="open_loop_followup"||reason==="pending_expectation_followup"){
      const ownership=composeOwnershipSubject({
        topic:candidate.topic,
        followup_kind:candidate.followup_kind,
        next_expected_actor:candidate.next_expected_actor,
        completion_followup_allowed:candidate.completion_followup_allowed
      },{silenceHours:null});
      if(ownership.blocked)return null;
      return ownership.subject;
    }
    if(reason==="thought_seed"){
      return `你刚才想到：${candidate.topic}\n请用很短的主动消息自然提起，不要像系统提醒。`;
    }
    if(reason==="absence_contact"){
      return "你注意到对方已经很久没出现了，而且这和你们最近的关系状态有关。请用符合人格的方式自然联系：可以带一点担心或被晾着的感觉，但不要复读固定缺席台词，不要把时长当主题。";
    }
    return `主动联系的具体话题：${candidate.topic}\n请围绕它自然说一句，不讨论用户多久没出现。`;
  }
  return null;
}

function candidateSourceSessionId(candidate){
  return candidate?.sourceSessionId??candidate?.followup?.sourceSessionId??candidate?.event?.session_id??null;
}

function applySuccessfulCandidate(candidate,at){
  if(candidate.kind==="followup"&&candidate.followup?.status==="pending")completeFollowup(candidate.followup.id,candidateDeliveryKind(candidate)==="image"?"done":"asked");
  if(candidate.kind==="event"&&candidate.event?.id)markEventsConsumed([candidate.event.id]);
  if(candidate.openLoopId){
    const loop=naturalPresence.document.open_loops.find(item=>item.id===candidate.openLoopId);
    if(loop&&!loop.resolved&&Number(loop.contact_count??0)<=Number(candidate.openLoopContactCount??0))naturalPresence.markLoopContacted(candidate.openLoopId,at);
  }
  if(candidate.expectationId){
    const expectation=naturalCognition.document.expectations.find(item=>item.id===candidate.expectationId);
    if(expectation?.state==="pending"&&Number(expectation.reminder_count??0)<=Number(candidate.expectationReminderCount??0))naturalCognition.noteExpectationReminded(candidate.expectationId,at);
  }
}

/**
 * 用正常 Chat 路由生成主动消息。
 * 上下文：Persona + 最近聊天 + Session summary + gated Memory + autonomous state + 选定的联系理由。
 */
export async function composeMessage(kind,candidate,{at=new Date()}={}){
  const persona=requirePersona(config.defaultPersonaId);
  const sourceSessionId=candidateSourceSessionId(candidate);
  const session=sourceSessionId?getSession(sourceSessionId):null;
  const storedRecent=session?listRecentMessagesAfter(session.id,session.summary_through_message_id??0,config.chatIncludeStoredRecent?Math.min(8,config.chatStoredRecentMessages):0):[];
  const silenceHoursMs=silenceMs(getState(),asDate(at));
  const silenceHours=Number.isFinite(silenceHoursMs)?silenceHoursMs/3600_000:null;
  const presenceSnap=naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null;
  const openLoops=naturalPresence.enabled?(naturalPresence.document.open_loops??[]):[];
  const pendingExpectations=naturalCognition.enabled?(naturalCognition.document.expectations??[]):[];
  const presenceForAbsence=naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null;
  const closenessAbsence=Number(presenceForAbsence?.dimensions?.closeness?.current??0.6);
  const explainedLeave=Boolean(contactSuppression.active(asDate(at))?.until);
  const absenceAppraisal=appraiseAbsenceFromRuntime({
    silenceHours,
    closeness:closenessAbsence,
    explicitLeave:explainedLeave,
    knownBusy:relationshipContinuity.findByType(IMPRESSION_TYPES.USER_RECENTLY_BUSY,asDate(at)).length>0,
    pendingExpectation:pendingExpectations.some(e=>e.state==="pending"),
    currentEmotion:presenceForAbsence?.emotion_state??null,
    previousOutreachCount:getState().consecutiveUnansweredProactive??0,
    at:asDate(at)
  });
  const stanceResult=selectReturnStance({
    silenceHours,
    presence:presenceSnap,
    openLoops,
    pendingExpectations,
    lastEventTypes:presenceSnap?.recent_event_types??[],
    candidateKind:kind==="inactivity"?"inactivity":(candidate?.kind??"presence"),
    presenceReason:candidate?.presenceReason??null,
    absenceAppraisal:candidate?.absenceAppraisal??absenceAppraisal,
    at:asDate(at)
  });
  if(stanceResult?.stance)console.log("[silence-stance]",JSON.stringify({stance:stanceResult.stance,reasons:stanceResult.reasons,silenceHours:stanceResult.silenceHours,topic:stanceResult.topic??null,absence:absenceAppraisal.reason_code}));
  const rewrittenTopic=rewriteProactiveTopic(candidate?.topic??stanceResult?.topic??"");
  if(rewrittenTopic.topic&&candidate)candidate={...candidate,topic:rewrittenTopic.topic};
  const subject=composeUserSubject(kind,candidate,stanceResult);
  if(subject==null)return {text:"",bubbles:[],fromJson:false,stance:stanceResult,blocked:"ownership"};
  const reason=proactiveReason(candidate);
  const associationOpenLoop=candidate?.openLoopId
    ?openLoops.find(loop=>loop.id===candidate.openLoopId&&loop.source_message_id)
    :null;
  const autonomyContext=[
    autonomousLife.enabled?autonomousLife.contextBlock():`【Autonomous Life Layer｜未启用】\nrequest_decision=ACCEPT`,
    presenceContext(asDate(at),unansweredContinuity(getState(),asDate(at))),
    stanceGuidanceBlock(stanceResult),
    absenceGuidanceBlock(candidate?.absenceAppraisal??absenceAppraisal),
    episodeContextBlock(asDate(at)),
    `【本次主动联系的具体缘由】${reason}。只围绕一个主要理由说话；不要列认知清单，不要把经过时间当作主题。`
  ].filter(Boolean).join("\n\n");
  const timeContext=companionTime.toLocal(asDate(at));
  const timeLine=`当前本地时间：${timeContext.iso}（${timeContext.weekday} ${timeContext.dayPart} ${timeContext.time}，时区 ${timeContext.timeZone}）。绝对时间差请以真实时间戳为准。`;
  const injected=await buildInjectedMessages({
    persona,
    ctx:{mode:"chat",personaId:persona.id,source:"proactive",publicModel:"proactive"},
    sessionId:sourceSessionId,
    clientMessages:[{role:"user",content:subject}],
    storedRecent,
    autonomyContext,
    timeContext:timeLine,
    currentMessageId:associationOpenLoop?.source_message_id??null
  });
  const messages=naturalMessagingEnabled()
    ? [{role:"system",content:NATURAL_MESSAGING_PROACTIVE_SYSTEM},...injected]
    : [{role:"system",content:PROACTIVE_GUARD},...injected];
  const body={stream:false,temperature:0.85};
  const up=await upstreamChat(body,messages,"chat",null,{});
  if(!up.ok){
    const detail=await up.text().catch(()=>"");
    throw new Error(`chat upstream ${up.status}${detail?`: ${String(detail).slice(0,160)}`:""}`);
  }
  const data=await up.json();
  if(data?.usage){
    insertUsage({
      sessionId:sourceSessionId,source:"proactive",publicModel:"proactive",
      upstreamModel:usageUpstreamModel(upstreamResponseInfo(up)),kind:"proactive",usage:data.usage
    });
  }
  let text=data?.choices?.[0]?.message?.content;
  if(typeof text!=="string"||!text.trim())return {text:"",bubbles:[],fromJson:false,stance:stanceResult};
  const clash=contradictsKnownEpisode(text,asDate(at));
  if(clash){
    const retry=await upstreamChat(body,[
      {role:"system",content:naturalMessagingEnabled()?NATURAL_MESSAGING_PROACTIVE_SYSTEM:PROACTIVE_GUARD},
      ...injected,
      {role:"system",content:`刚才那条主动消息在问已经知道的事（${clash.reason}：${clash.episode.fact}）。请重写：不要问吃了没/吃啥了/在干嘛这类已知问题，可以问未知的 follow-up。`}
    ],"chat",null,{});
    if(retry.ok){
      const retryData=await retry.json();
      if(retryData?.usage)insertUsage({sessionId:sourceSessionId,source:"proactive",publicModel:"proactive",upstreamModel:usageUpstreamModel(upstreamResponseInfo(retry)),kind:"proactive",usage:retryData.usage});
      const retryText=retryData?.choices?.[0]?.message?.content;
      if(typeof retryText==="string"&&retryText.trim()&&!contradictsKnownEpisode(retryText,asDate(at)))text=retryText;
    }
  }
  const parsed=parseNaturalBubbles(text);
  let bubbles=parsed.bubbles;
  // Dangling opener guard: complete the turn before any delivery starts.
  const completeFn=async({mode,opener,bubbles:soFar,signal})=>{
    const prompt=mode==="rewrite"
      ?`你上一轮只写了悬空开头「${opener}」。请把整件事在同一句话里说完，输出 JSON {"messages":["完整的一条"]}`
      :`你上一轮写了「${opener}」但没说下一句。请立刻给出真正下文（是什么事），输出 JSON {"messages":["${opener}","真正下文"]}`;
    const up2=await upstreamChat({stream:false,temperature:0.85},[{role:"system",content:NATURAL_MESSAGING_PROACTIVE_SYSTEM},{role:"user",content:prompt}],"chat",signal??null,{});
    if(!up2.ok)return "";
    const d2=await up2.json();
    if(d2?.usage)insertUsage({sessionId:sourceSessionId,source:"proactive",publicModel:"proactive",upstreamModel:usageUpstreamModel(upstreamResponseInfo(up2)),kind:"proactive",usage:d2.usage});
    return typeof d2?.choices?.[0]?.message?.content==="string"?d2.choices[0].message.content:"";
  };
  try{
    const {ensureCompleteBubbles}=await import("./natural-messaging.js");
    bubbles=await ensureCompleteBubbles({bubbles,completeFn});
  }catch{}
  return {text:bubbles[0]??"",bubbles,fromJson:parsed.fromJson,raw:text,stance:stanceResult};
}

async function generateProactiveImage(topic){
  const entry=moduleRegistry.toolEntry("generate_image");
  if(!entry||!moduleRegistry.isModuleToolAllowed("generate_image"))return null;
  try{
    const raw=await moduleRegistry.executeModuleTool("generate_image",{prompt:String(topic).slice(0,300),style:"casual",aspect_ratio:"1:1",purpose:"conversation"});
    const parsed=JSON.parse(raw);
    if(parsed?.mediaId)return {mediaId:parsed.mediaId,mime:parsed.mime??"image/png"};
  }catch(e){
    publishEvent("module.failed",{tool:"generate_image",error:String(e?.message??e).slice(0,200)});
  }
  return null;
}

function failureCooldownUntil(at=new Date()){
  return new Date(asDate(at).getTime()+GENERATION_RETRY_MS).toISOString();
}

const inactivityInFlight=new Set();

async function runInactivityCandidate(candidate,{at=new Date()}={}){
  const eligibility=candidate.eligibility??{};
  const attemptKey=String(eligibility.attemptKey??"").trim();
  if(!attemptKey)return {delivered:false,reason:"missing_attempt_key",llmCalled:false,kind:"inactivity"};
  if(inactivityInFlight.has(attemptKey))return {delivered:false,reason:"attempt_in_flight",llmCalled:false,kind:"inactivity",attemptKey};
  inactivityInFlight.add(attemptKey);
  try{
    return await runInactivityCandidateLocked(candidate,{at,attemptKey,eligibility});
  }finally{
    inactivityInFlight.delete(attemptKey);
  }
}

async function runInactivityCandidateLocked(candidate,{at,attemptKey,eligibility}){
  const existing=findProactiveMessageByAttemptKey(attemptKey);
  if(existing){
    finishProactiveAttempt(attemptKey,{
      generated:true,delivered:true,messageId:Number(existing.id),sessionId:existing.session_id,
      resultReason:"already_delivered",finishedAt:asDate(at)
    });
    noteInactivityCheck({...eligibility,checkedAt:asDate(at),eligible:true,reasons:["already_delivered"]});
    return {delivered:true,kind:"inactivity",messageId:Number(existing.id),llmCalled:false,attemptKey,idempotent:true};
  }

  const begin=beginProactiveAttempt({
    attemptKey,startedAt:asDate(at),triggerReason:eligibility.reason??eligibility.triggerReason??"inactivity",
    inactivityMs:eligibility.inactivityMs,inactivityHours:eligibility.inactivityHours,band:eligibility.band,
    probability:eligibility.probability,roll:eligibility.roll
  });
  if(!begin.started&&begin.audit?.delivered){
    return {delivered:true,kind:"inactivity",messageId:begin.audit.messageId,sessionId:begin.audit.sessionId,llmCalled:false,attemptKey,idempotent:true};
  }

  try{
    const composed=await composeMessage("inactivity",candidate,{at});
    const bubbles=(composed.bubbles?.length?composed.bubbles:(composed.text?[composed.text]:[])).filter(Boolean);
    if(!bubbles.length){
      const cooldownUntil=failureCooldownUntil(at);
      finishProactiveAttempt(attemptKey,{
        generated:false,delivered:false,status:"generation_empty",resultReason:"empty_text",
        cooldownUntil,finishedAt:asDate(at)
      });
      noteInactivityCheck({...eligibility,checkedAt:asDate(at),eligible:false,cooldownUntil,reasons:["generation_empty"]});
      return {delivered:false,kind:"inactivity",reason:"generation_empty",llmCalled:true,attemptKey};
    }
    const targetSession=resolveDailyChatSession();
    // Race guard: if user replied after generation started, do not continue bubbles.
    const beforeUser=getPreviousRealInteraction(targetSession.id).user;
    const startedAtMs=asDate(at).getTime();
    const hasUserInterrupted=()=>{
      const latest=getPreviousRealInteraction(targetSession.id).user;
      return Boolean(latest&&(!beforeUser||Number(latest.id)>Number(beforeUser.id)||Date.parse(latest.createdAt)>startedAtMs));
    };
    const sequence=await deliverBubbleSequence({
      sessionId:targetSession.id,
      source:"proactive",
      bubbles,
      proactiveAttemptKey:attemptKey,
      hasUserInterrupted
    });
    if(!sequence.messages.length){
      const cooldownUntil=failureCooldownUntil(at);
      finishProactiveAttempt(attemptKey,{
        generated:false,delivered:false,status:"delivery_empty",resultReason:"no_bubble_written",
        cooldownUntil,finishedAt:asDate(at)
      });
      return {delivered:false,kind:"inactivity",reason:"no_bubble_written",llmCalled:true,attemptKey};
    }
    const first=sequence.messages[0];
    finishProactiveAttempt(attemptKey,{
      generated:true,delivered:true,messageId:first.messageId,sessionId:targetSession.id,
      resultReason:sequence.messages.length>1?`delivered_${sequence.messages.length}_bubbles`:"delivered",
      finishedAt:asDate(at)
    });
    noteInactivityCheck({...eligibility,checkedAt:asDate(at),eligible:true,reasons:[`delivered_${sequence.messages.length}`]});
    try{
      relationshipContinuity.noteOutreachSent({
        messageId:first.messageId,
        attemptKey,
        reason:"cognition_wake",
        topic:candidate?.topic??null,
        expectsReply:expectsReplyFromBubbles(bubbles),
        tone:composed?.stance?.stance??null
      },asDate(at));
    }catch{}
    publishEvent("proactive.created",{
      kind:"inactivity",messageId:first.messageId,sessionId:targetSession.id,
      preview:bubbles[0].slice(0,160),attemptKey,band:eligibility.band??null,
      bubbleCount:sequence.messages.length,bubbles:bubbles.map(b=>b.slice(0,160))
    },{sessionId:targetSession.id});
    return {
      delivered:true,kind:"inactivity",messageId:first.messageId,sessionId:targetSession.id,
      llmCalled:true,attemptKey,inserted:true,bubbleCount:sequence.messages.length,
      messages:sequence.messages,interrupted:sequence.interrupted
    };
  }catch(error){
    const cooldownUntil=failureCooldownUntil(at);
    finishProactiveAttempt(attemptKey,{
      generated:false,delivered:false,status:"error",error:String(error?.message??error).slice(0,160),
      resultReason:"generation_error",cooldownUntil,finishedAt:asDate(at)
    });
    noteInactivityCheck({...eligibility,checkedAt:asDate(at),eligible:false,cooldownUntil,reasons:["generation_error"]});
    return {delivered:false,kind:"inactivity",reason:"generation_error",error:String(error?.message??error).slice(0,160),llmCalled:true,attemptKey};
  }
}

/**
 * 单次 proactive 决策循环：本地规则筛选 → 至多一次 Chat 路由/图片生成 → 幂等投递。
 * 返回 {delivered:boolean,kind?,reason?}
 */
export async function runOnce({at=new Date(),eligibilityRoll=null,candidateSet=null}={}){
  const date=asDate(at);
  const behavior=getBehavior();
  if(!behavior.proactiveMessagesEnabled&&!behavior.proactiveImagesEnabled){
    noteInactivityCheck({checkedAt:date,reason:"disabled",eligible:false});
    return {delivered:false,reason:"disabled",llmCalled:false};
  }
  const gathered=candidateSet??gatherCandidateSet({at:date,eligibilityRoll});
  const {candidates,inactivity}=gathered;
  noteInactivityCheck({
    checkedAt:date,triggerReason:inactivity?.reason??"no_inactivity_candidate",
    inactivityMs:inactivity?.inactivityMs,inactivityHours:inactivity?.inactivityHours,band:inactivity?.band,
    probability:inactivity?.probability,roll:inactivity?.roll,opportunityKey:inactivity?.opportunityKey,
    attemptKey:inactivity?.attemptKey,eligible:Boolean(inactivity?.eligible),
    reasons:candidates.length?candidates.map(c=>c.kind):["no_candidates"]
  });
  if(!candidates.length)return {delivered:false,reason:"no_candidates",llmCalled:false};

  for(const candidate of candidates){
    const kind=candidateDeliveryKind(candidate);
    // 发出前最后一致性检查：不合格就丢弃，继续看下一个 candidate
    const qualification=inspectCandidateQualification({
      topic:candidate.topic??candidate.followup?.topic??candidate.event?.content??"",
      followup_kind:candidate.followup_kind,
      next_expected_actor:candidate.next_expected_actor,
      salience:candidate.urgency??0.6,
      created_at:candidate.created_at,
      expires_at:candidate.expires_at,
      resolved:false
    },{
      at:date,
      recentlyDiscussed:(getState().recentTopics??[]).slice(0,4),
      completionStyle:false,
      knownAnswer:null,
      userAnsweredTopic:null
    });
    if(!qualification.ok&&candidate.kind==="presence"
      &&!(candidate.presenceReason==="focus_callback"&&qualification.reason==="same_topic_repeat"))continue;
    const highValueReason=Boolean(candidate.highValue);
    const reason=proactiveReason(candidate);
    const attemptKey=proactiveAttemptKey(candidate,gathered.cognitionWake);
    const existing=attemptKey?findProactiveMessageByAttemptKey(attemptKey):null;
    if(existing){
      const existingAt=Date.parse(existing.created_at??"");
      const lastProactive=Date.parse(getState().lastProactiveAt??"");
      const stateAlreadyAccountsForSend=Number.isFinite(existingAt)&&Number.isFinite(lastProactive)&&lastProactive>=existingAt;
      if(!stateAlreadyAccountsForSend)noteProactiveSent("message",{at:Number.isFinite(existingAt)?new Date(existingAt):date,attemptKey});
      applySuccessfulCandidate(candidate,date);
      if(!stateAlreadyAccountsForSend)proactiveCognitionMetrics.noteDelivery({reason,topic:candidate.topic??candidate.followup?.topic??"",text:existing.content_text??"",at:Number.isFinite(existingAt)?new Date(existingAt):date});
      return {delivered:true,kind:candidate.kind,proactiveReason:reason,messageId:Number(existing.id),sessionId:existing.session_id,llmCalled:false,attemptKey,idempotent:true};
    }
    const gate=evaluateProactiveGate({kind,candidateKind:candidate.kind,at:date,candidate,highValueReason});
    if(!gate.allowed){
      proactiveCognitionMetrics.noteGateBlock(gate.reasons);
      if(candidate.kind==="inactivity"&&inactivity?.attemptKey){
        finishProactiveAttempt(inactivity.attemptKey,{
          generated:false,delivered:false,status:"gated",resultReason:`gate:${gate.reasons.join(",")}`,
          cooldownUntil:gate.reasons.includes("generation_error")?failureCooldownUntil(date):null,
          finishedAt:date
        });
      }
      return {delivered:false,reason:`gate:${gate.reasons.join(",")}`,candidateKind:kind,llmCalled:false,kind:candidate.kind};
    }
    if(kind==="image"){
      const image=await generateProactiveImage(candidate.followup.topic);
      if(image){
        const finalGate=evaluateProactiveGate({kind,candidateKind:candidate.kind,at:date,candidate,highValueReason});
        if(!finalGate.allowed){proactiveCognitionMetrics.noteGateBlock(finalGate.reasons);return {delivered:false,reason:`gate:${finalGate.reasons.join(",")}`,llmCalled:true,kind:candidate.kind};}
        if(contactSuppression.active(date)){
          proactiveCognitionMetrics.noteGateBlock(["post_closure_suppression"]);
          return {delivered:false,reason:"post_closure_suppression",llmCalled:true,kind:candidate.kind};
        }
        const outImg=await deliver({type:"image",content:`给你画好了：${candidate.followup.topic.slice(0,120)}`,attachments:[image],source:"proactive",idempotencyKey:attemptKey});
        noteProactiveSent("image",{at:date,attemptKey});
        applySuccessfulCandidate(candidate,date);
        publishEvent("proactive.created",{kind:"image",mediaId:image.mediaId,sessionId:outImg.sessionId,messageId:outImg.messageId},{sessionId:outImg.sessionId});
        proactiveCognitionMetrics.noteDelivery({reason:proactiveReason(candidate),topic:candidate.topic,text:`给你画好了：${candidate.followup.topic.slice(0,120)}`,at:date});
        return {delivered:true,kind:"image",llmCalled:false,sessionId:outImg.sessionId,messageId:outImg.messageId,proactiveReason:proactiveReason(candidate),attemptKey};
      }
      continue;
    }
    if(candidate.kind==="inactivity")return {delivered:false,reason:"inactivity_is_not_a_message_reason",llmCalled:false};
    const composed=await composeMessage(candidate.kind,candidate,{at:date});
    const bubbles=(composed.bubbles?.length?composed.bubbles:(composed.text?[composed.text]:[])).filter(Boolean);
    if(!bubbles.length)continue;
    // 生成后二次检查：禁止对 shared_topic / assistant 欠答案 使用 completion 模板
    if(!allowsCompletionFollowup(candidate)&&bubbles.some(b=>looksLikeCompletionFollowup(b))){
      continue;
    }
    const text=bubbles.join("\n");
    if(proactiveCognitionMetrics.isDuplicateSubject(text,date)){
      proactiveCognitionMetrics.noteDuplicateSuppressed();
      return {delivered:false,reason:"duplicate_subject",llmCalled:true,kind:candidate.kind,proactiveReason:reason};
    }
    const finalGate=evaluateProactiveGate({kind,candidateKind:candidate.kind,at:date,candidate,highValueReason});
    if(!finalGate.allowed){proactiveCognitionMetrics.noteGateBlock(finalGate.reasons);return {delivered:false,reason:`gate:${finalGate.reasons.join(",")}`,llmCalled:true,kind:candidate.kind,proactiveReason:reason};}
    if(contactSuppression.active(date)){
      proactiveCognitionMetrics.noteGateBlock(["post_closure_suppression"]);
      return {delivered:false,reason:"post_closure_suppression",llmCalled:true,kind:candidate.kind,proactiveReason:reason};
    }
    const targetSession=resolveDailyChatSession();
    const sequence=await deliverBubbleSequence({sessionId:targetSession.id,source:"proactive",bubbles,proactiveAttemptKey:attemptKey});
    if(!sequence.messages.length)continue;
    noteProactiveSent("message",{at:date,attemptKey});
    applySuccessfulCandidate(candidate,date);
    try{
      relationshipContinuity.noteOutreachSent({
        messageId:sequence.messages[0]?.messageId??null,
        attemptKey,
        reason,
        topic:candidate.topic??candidate.followup?.topic??null,
        expectsReply:expectsReplyFromBubbles(bubbles),
        tone:composed?.stance?.stance??null
      },date);
      if(hasUnansweredOutreach(date))absenceAppraisalDiagnostics.proactiveAfterUnansweredOutreach++;
    }catch{}
    proactiveCognitionMetrics.noteDelivery({reason,topic:candidate.topic??candidate.followup?.topic??"",text,at:date});
    const first=sequence.messages[0];
    publishEvent("proactive.created",{kind:candidate.kind,proactiveReason:reason,messageId:first.messageId,sessionId:targetSession.id,preview:bubbles[0].slice(0,160),bubbleCount:sequence.messages.length,presenceReason:candidate.presenceReason??null,followupKind:candidate.followup_kind??null},{sessionId:targetSession.id});
    return {delivered:true,kind:candidate.kind,proactiveReason:reason,messageId:first.messageId,llmCalled:true,bubbleCount:sequence.messages.length,sessionId:targetSession.id,presenceReason:candidate.presenceReason??null,followupKind:candidate.followup_kind??null,score:candidate.score,attemptKey};
  }
  return {delivered:false,reason:"all_candidates_skipped",llmCalled:false};
}

// ---------- Companion Behavior Heartbeat ----------
// 周期唤醒入口：本身禁止直接调用 LLM（生成发生在 runOnce 的 Chat 路由中）。

export function maybeRunWeatherWatchdog(){
  const behavior=getBehavior(),state=getState();
  if(!behavior.weatherAwareness||!behavior.weatherWatchdogEnabled)return false;
  const entry=moduleRegistry.toolEntry("get_current_weather");
  if(!entry)return false;
  const intervalMs=behavior.weatherWatchdogMinutes*60_000;
  const last=state.lastWeatherWatchdogAt?Date.parse(state.lastWeatherWatchdogAt):0;
  if(Date.now()-last<intervalMs)return false;
  state.lastWeatherWatchdogAt=new Date().toISOString();
  saveState();
  triggerEngine.run(entry.moduleId,"check_alerts",{depth:0}).catch(e=>console.error("[weather-watchdog]",e?.message??e));
  return true;
}

export function weatherWatchdogDue(){
  const behavior=getBehavior(),state=getState();
  if(!behavior.weatherAwareness||!behavior.weatherWatchdogEnabled||!moduleRegistry.toolEntry("get_current_weather"))return false;
  const last=state.lastWeatherWatchdogAt?Date.parse(state.lastWeatherWatchdogAt):0;
  return Date.now()-last>=behavior.weatherWatchdogMinutes*60_000;
}

/** SQLite 是用户互动时间的权威来源；开发时间模拟开启时跳过 reconcile。 */
function reconcileAbsoluteUserTime(){
  if(config.inactivityDevOverrideEnabled)return false;
  const sqliteAt=getLatestUserMessageAt(config.defaultPersonaId);
  return reconcileUserInteraction(sqliteAt);
}

let heartbeatRunning=false;
export async function runHeartbeat({at=new Date(),eligibilityRoll=null,candidateSet:providedCandidateSet=null}={}){
  if(heartbeatRunning)return {delivered:false,reason:"heartbeat_in_flight",heartbeat:null};
  heartbeatRunning=true;
  try{
    const date=asDate(at);
    reconcileAbsoluteUserTime();
    expirePendingFollowups(date.getTime());
    const proactiveEnabled=process.env.COMPANION_PROACTIVE_DISABLED!=="1";
    const candidateSet=providedCandidateSet??gatherCandidateSet({at:date});
    const {candidates,presenceDecision,cognitionWake}=candidateSet;
    const top=candidates[0]??null;
    const selectedReason=top?proactiveReason(top):"nothing_worth_saying";
    const record=(result)=>{
      const reason=result?.proactiveReason??(result?.delivered?selectedReason:(result?.reason??selectedReason));
      proactiveCognitionMetrics.noteTick({at:date,action:result?.delivered?"SEND":"NO_ACTION",reason});
      if(candidateSet.suppressionActive)proactiveCognitionMetrics.noteGateBlock(["post_closure_suppression"]);
      publishEvent("proactive.cognition.tick",{
        action:result?.delivered?"SEND":"NO_ACTION",reason,
        selectedReason:top?selectedReason:null,
        candidateKind:top?.kind??null,
        wakeBand:cognitionWake?.eligible?cognitionWake.band:null,
        suppression:Boolean(candidateSet.suppressionActive||result?.reason==="post_closure_suppression"),
        delivered:Boolean(result?.delivered)
      });
      return result;
    };
    if(!proactiveEnabled){
      maybeRunWeatherWatchdog();
      return record({delivered:false,reason:"disabled",heartbeat:null});
    }
    const highValueReason=Boolean(top?.highValue);
    const proactiveGate=candidates.length
      ? evaluateProactiveGate({kind:candidateDeliveryKind(top),candidateKind:top.kind,at:date,candidate:top,highValueReason})
      : null;
    // A wake is one cognition opportunity even when cooldown/no-reply gating
    // chooses silence. Otherwise the same absence appraisal can re-fire every
    // heartbeat and repeatedly intensify Presence without new user evidence.
    if(cognitionWake?.eligible&&!candidateSet.suppressionActive)markCognitionWakeHandled(cognitionWake.opportunityKey);
    const heartbeat=autonomousLife.heartbeat({
      at:date,
      proactiveCandidateCount:proactiveGate?.allowed?candidates.length:0,
      proactiveSuppressionReasons:proactiveGate?.allowed?[]:(proactiveGate?.reasons??[]),
      toolCandidateCount:weatherWatchdogDue()?1:0
    });
    // 高价值 open loop / pending 可覆盖 autonomous WAIT/USE_TOOL；shared topic 不强制。
    const presenceUrgent=presenceDecision?.action==="START_CONVERSATION"
      &&["open_loop_followup","pending_expectation_followup"].includes(presenceDecision.reason)
      &&(presenceDecision.completion_followup_allowed!==false)
      &&normalizeFollowupKind(presenceDecision.followup_kind)!==FOLLOWUP_KINDS.SHARED_TOPIC
      &&presenceDecision.next_expected_actor!==NEXT_ACTORS.SHARED;
    const highValuePresence=presenceUrgent&&highValueReason;
    if(!autonomousLife.enabled){
      maybeRunWeatherWatchdog();
      const result=await runOnce({at:date,candidateSet});
      return record({...result,heartbeat});
    }
    if(heartbeat.action==="USE_TOOL"&&!highValuePresence){
      maybeRunWeatherWatchdog();
      return record({delivered:false,reason:"autonomy:use_tool",heartbeat});
    }
    // High-value user-owned loops / expectations may proceed when autonomy
    // says WAIT; focus and social callbacks still respect its energy decision.
    if(heartbeat.action!=="START_CONVERSATION"){
      if(presenceUrgent&&proactiveGate?.allowed&&proactiveEnabled){
        try{
          const delivered=await runOnce({at:date,candidateSet});
          const forcedHeartbeat={...heartbeat,action:"START_CONVERSATION",reason:presenceDecision.reason,forcedByPresence:true};
          autonomousLife.noteProactiveResult({heartbeat:forcedHeartbeat,result:delivered});
          return record({...delivered,heartbeat:forcedHeartbeat,presenceDecision});
        }catch(error){
          record({delivered:false,reason:"generation_error",proactiveReason:selectedReason});
          autonomousLife.noteProactiveResult({
            heartbeat:{...heartbeat,action:"START_CONVERSATION",reason:presenceDecision.reason,forcedByPresence:true},
            error:error?.message??error
          });
          throw error;
        }
      }
      return record({delivered:false,reason:`autonomy:${heartbeat.action.toLowerCase()}`,heartbeat,presenceDecision,proactiveReason:selectedReason});
    }
    try{
      const delivered=await runOnce({at:date,candidateSet});
      autonomousLife.noteProactiveResult({heartbeat,result:delivered});
      return record({...delivered,heartbeat,presenceDecision});
    }catch(error){
      record({delivered:false,reason:"generation_error",proactiveReason:selectedReason});
      autonomousLife.noteProactiveResult({heartbeat,error:error?.message??error});
      throw error;
    }
  }finally{heartbeatRunning=false;}
}

let timer=null,startupTimer=null;
export function startProactiveEngine(){
  const seconds=Math.max(30,Number(process.env.COMPANION_HEARTBEAT_SECONDS||process.env.COMPANION_PROACTIVE_TICK_SECONDS)||900);
  if(timer)return;
  timer=setInterval(()=>{runHeartbeat().catch(e=>console.error("[heartbeat]",e?.message??e));},seconds*1000);
  timer.unref?.();
  // 启动后立即按绝对时间重新判断，不等待默认 15 分钟。
  if(process.env.COMPANION_PROACTIVE_DISABLED!=="1"){
    const startupDelayMs=Math.max(0,Number(process.env.COMPANION_HEARTBEAT_STARTUP_DELAY_MS)||1500);
    startupTimer=setTimeout(()=>{runHeartbeat().catch(e=>console.error("[heartbeat-startup]",e?.message??e));},startupDelayMs);
    startupTimer.unref?.();
  }
}
export function stopProactiveEngine(){
  if(timer){clearInterval(timer);timer=null;}
  if(startupTimer){clearTimeout(startupTimer);startupTimer=null;}
}

/** 用户消息进入时调用：记录互动时间、解除 no-reply 抑制 */
export function observeUserActivity(lastUserPreview){
  touchUserInteraction();
  if(lastUserPreview)pushRecentTopic(String(lastUserPreview).slice(0,80));
  try{
    const text=String(lastUserPreview??"");
    const explained=classifyExplainedAbsence(text);
    const warm=/想你|爱你|亲亲|抱抱|回来了|嘿嘿|哈哈|开心|谢谢/.test(text);
    relationshipContinuity.noteUserInteraction({
      text,
      warm,
      explainedAbsence:Boolean(explained&&!explained.dontContact),
      busy:Boolean(explained?.knownBusy)
    },new Date());
    if(explained?.dontContact){
      absenceAppraisalDiagnostics.suppressedByExplicitLeave++;
    }
  }catch{}
}

// ---------- 保守 Follow-up 抽取 ----------
const FOLLOWUP_PATTERN=/(明天|后天)(?!.*昨天)[^。\n]{0,24}?(?:要|去|打算|准备|记得|需要)?[^。\n]{0,10}(测一下|测试|交|部署|上线|开会|面试|体检|看医生|验收)/;

export function maybeExtractFollowup(userText,sourceSessionId,timeService=companionTime){
  const behavior=getBehavior();
  if(!behavior.followUpEnabled)return null;
  const text=String(userText??"").trim();
  if(!text||text.length>120)return null;
  const m=text.match(FOLLOWUP_PATTERN);
  if(!m)return null;
  const local=timeService.parts(timeService.now()),wall=new Date(Date.UTC(local.year,local.month-1,local.day+(text.includes("后天")?2:1)));
  const base=timeService.fromLocalParts({year:wall.getUTCFullYear(),month:wall.getUTCMonth()+1,day:wall.getUTCDate(),hour:9});
  return addPendingFollowup({
    topic:m[0].slice(0,120),
    earliestAt:base.toISOString(),
    expiresAt:new Date(base.getTime()+48*3600_000).toISOString(),
    sourceSessionId
  });
}

export { silenceMs,effectiveStateForEligibility };
