import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { config } from "./config.js";
import { ensureDefaultPersona,requirePersona } from "./persona.js";
import { buildInjectedMessages,buildInjectedResponsesInput } from "./context.js";
import { finishAgentProviderRoute,prepareAgentProviderRoute,upstreamChat,upstreamCompat,upstreamResponseInfo,upstreamResponses,usageUpstreamModel } from "./upstream.js";
import { cleanKey,incomingTail,isLoopback,json,messageText,readBody,readJsonBody,sha256,stableJson } from "./utils.js";
import { appendIncomingMessagesDetailed,findSessionToolCall,getIdempotentResponse,getLastAgentUsageProvider,getOrCreateSession,getPreviousRealInteraction,getSession,insertMessage,insertUsage,listRecentMessagesAfter,primaryInstanceLease,putIdempotentResponse } from "./db.js";
import { maybeScheduleSummary } from "./workers.js";
import { handleAdminApi } from "./admin.js";
import { resolveSession } from "./session.js";
import { beginTask,noteCompat,noteCompatInvalid,noteCompatRequest,noteCompatRetry,noteCompatToolMissRecovery,recordError,redactSecrets } from "./runtime.js";
import { observeResponseEvent,responseAssistantMessage,responsesInputToMessages,responseStreamState,rewriteResponseModel,streamAssistantMessage } from "./responses.js";
import { buildToolContractDetails,compatChatCompletion,compatChoicePolicy,compatMessages,compatResponse,mergeUsage,newCallId,normalizeCompatTools,parseToolDecision,repairMessages,selectCompatToolCandidates,shouldRecoverToolMiss,toolMissRecoveryMessages } from "./tool-compat.js";
import { findRequestTool,isModuleTool,isMcpTool } from "./tool-registry.js";
import { moduleRegistry } from "./modules/registry.js";
import { attachWebSocketServer } from "./ws.js";
import { publishEvent } from "./events-bus.js";
import { getMedia,MAX_UPLOAD_BYTES,saveUploadedMedia } from "./media.js";
import { observeUserActivity,maybeExtractFollowup,startProactiveEngine } from "./proactive.js";
import { NATURAL_MESSAGING_SYSTEM,createBubblePlan,deliverBubbleSequence,finalizeBubblePlan,naturalMessagingEnabled } from "./natural-messaging.js";
import { planFirstReplyLatency,awaitFirstReplyLatency,replyLatencyDebugLine } from "./reply-latency.js";
import { detectClosure,closureGuidanceBlock,applyClosureToBubbles } from "./closure-sensing.js";
import { naturalPresence,evaluateAndApplyTurn,presenceContext,decideContact } from "./natural-presence/index.js";
import { emotionExpressionBlock } from "./emotion-causality.js";
import { naturalCognition,onAssistantMessageDelivered,onUserMessage,updateFocusFromTurn,cognitionContextBlock,onMacSeen,onMacAttention } from "./natural-cognition/index.js";
import { classifyGrounding,applyGroundingTurn,groundingGuidanceBlock,defaultGrounding } from "./conversation-grounding.js";
import { diaryContextBlock, startDiaryScheduler } from "./natural-diary/index.js";
import { processUserRepair, currentRepair, expireRepairOnShift, repairGuidanceBlock } from "./natural-repair/index.js";
import { observeRecentEpisode, episodeContextBlock, recentEpisodes } from "./recent-episodes/index.js";
import { contactSuppression } from "./contact-suppression.js";
import { detectAndRecordUtterance, recurrenceContextBlock } from "./recent-utterances/index.js";
import { ingestUserVoiceMessage } from "./chat-voice-message.js";
import { decideVoiceDelivery } from "./voice-delivery-policy.js";
import {
  defaultVoiceAsyncQueue,
  enqueueAssistantVoice,
  recoverPendingVoiceJobs,
  snapshotVoiceAsyncDiagnostics,
  voiceAttemptKey
} from "./voice-async-queue.js";
import { selectNaturalResponsePolicy,naturalResponsePolicyBlock,naturalRecentExpressionBlock,analyzeNaturalResponse,inspectNaturalResponseCandidate } from "./natural-response-policy.js";
import {
  runPostMessagePhase,
  buildFollowupPrompt,
  isSemanticDuplicate,
  snapshotPostMessageDiagnostics,
  postMessageDiagnostics,
  postMessageLimits,
  latencyPush,
  defaultPostMessageRegistry
} from "./post-message-cognition.js";
import { associatedMemoryCandidatesForMessage,createCurrentEventAssociations } from "./event-association.js";
import { findPostMessageFollowupByAttemptKey } from "./db.js";
import { defaultActiveMemory } from "./memory-accessibility.js";

const groundingBySession=new Map();
function loadGrounding(sessionId){
  if(groundingBySession.has(sessionId))return groundingBySession.get(sessionId);
  try{
    const parsed=JSON.parse(fs.readFileSync(groundingStatePath(sessionId),"utf8"));
    groundingBySession.set(sessionId,parsed);
    return parsed;
  }catch{
    const fresh=defaultGrounding();
    groundingBySession.set(sessionId,fresh);
    return fresh;
  }
}
function saveGrounding(sessionId,state){
  groundingBySession.set(sessionId,state);
  try{
    const file=groundingStatePath(sessionId);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,JSON.stringify(state,null,2),{mode:0o600});
  }catch{}
}
function groundingStatePath(sessionId){
  return path.join(config.voiceDir??path.join(path.dirname(config.databasePath),"grounding"),`grounding-${String(sessionId).replace(/[^\w.-]/g,"_").slice(0,80)}.json`);
}

function notePresenceAfterTurn({userText="",assistantText="",sessionId=null,sourceMessageId=null,messageIds=[],activeTopic=null,groundingState=null,skipPresenceLoops=false}={}){
  try{if(!skipPresenceLoops)contactSuppression.observeAssistant({text:assistantText,at:new Date()});}catch{}
  try{
    for(const id of messageIds)onAssistantMessageDelivered({messageId:id,sessionId});
    const exp=naturalCognition.activeExpectations().sort((a,b)=>String(b.created_at??"").localeCompare(String(a.created_at??"")))[0]??null;
    const topicHint=activeTopic??groundingState?.active_topic??null;
    if(groundingState&&sessionId)saveGrounding(sessionId,groundingState);
    updateFocusFromTurn({activeTopic:topicHint,expectation:exp});
    console.log("[cognition] after turn", JSON.stringify({messageIds,exp:exp?.id??null,focusUpdated:Boolean(topicHint),assistantLength:String(assistantText).length}));
  }catch(e){console.error("[cognition] after-turn error",e?.message??e);}
  if(!naturalPresence.enabled||skipPresenceLoops)return;
  evaluateAndApplyTurn({userText,assistantText,sessionId,sourceMessageId,
    useLlm:process.env.COMPANION_NATURAL_PRESENCE_EVENT_LLM_ENABLED!=="0"})
    .catch(e=>console.error("[presence]",e?.message??e));
}

const responseActHistory=new Map();

function recentResponseActs(sessionId){
  return responseActHistory.get(String(sessionId??""))??[];
}

function responsePolicyTrace(selection,text,episodes=[],sessionId=null){
  if(!selection)return null;
  const analysis=analyzeNaturalResponse({text,selection,recentEpisodes:episodes});
  const trace={
    impulse:selection.impulse??null,
    primary_act:selection.primaryAct,
    secondary_act:selection.secondaryAct,
    selective_attention:selection.selectiveAttention??null,
    focus_point:selection.focusPoint??null,
    context_disposition:selection.contextDisposition,
    reason:selection.reason,
    recent_event_explicitly_mentioned:analysis.recentEventExplicitlyMentioned,
    advice_given:analysis.adviceGiven,
    closure_given:analysis.closureGiven,
    current_situation_summarized:analysis.currentSituationSummarized,
    realized_primary_act:analysis.realizedPrimaryAct,
    realized_secondary_acts:analysis.realizedSecondaryActs,
    multi_act_expansion:Boolean(analysis.multiActExpansion),
    policy_violations:analysis.policyViolations
  };
  if(sessionId!=null){
    const key=String(sessionId),history=recentResponseActs(key);
    // keep impulse-level posture for Recent Expression Awareness
    responseActHistory.set(key,[...history,trace.impulse??trace.realized_primary_act].slice(-8));
  }
  console.log("[response-act]",JSON.stringify(trace));
  return trace;
}

async function enforceNaturalResponseCandidate({rawContent,userText,responsePolicy,recentAssistantTexts,recentRealizedActs,ctx,signal}){
  const first=inspectNaturalResponseCandidate({rawText:rawContent,selection:responsePolicy,recentAssistantTexts,recentRealizedActs,userText});
  if(first.ok)return {rawContent:first.canonicalRaw??rawContent,repaired:false,reasons:[]};
  console.log("[response-act-repair]",JSON.stringify({stage:"requested",reasons:first.reasons,primary_act:responsePolicy?.primaryAct??null,coverage_complete:first.coverage?.complete}));
  const coverageMissing=Array.isArray(first.coverage?.missing)?first.coverage.missing.map(m=>m.text):[];
  const prompt=[
    "【Conversational Impulse｜可见回复修正】",
    "上一候选违反了 one impulse / stop when done，或吞掉了明确问题/请求。只重写可见回复；不要解释修正过程，不要新增事实。",
    `用户当前一句：${String(userText??"").slice(0,500)}`,
    `本轮 impulse=${responsePolicy?.impulse??"COMMENT"}; focus_point=${responsePolicy?.focusPoint??"当前最戳的一点"}`,
    emotionExpressionBlock(naturalPresence.document.emotion_state,responsePolicy?.primaryAct),
    `必须修正：${first.reasons.join(", ")}`,
    coverageMissing.length?`必须覆盖明确项：${coverageMissing.join("；")}`:"",
    coverageMissing.length?"只输出严格 JSON：{\"messages\":[\"反应可选\",\"明确项回答\"]}；可以先保留反应，但整轮要完成明确项。":"只输出严格 JSON：{\"messages\":[\"一条自然回复\"]}",
    "只完成这个 impulse；说够就停。不要建议、提醒、安排、总结或收尾，除非本轮 impulse 明确是 ADVISE/CLOSE。",
    coverageMissing.length?"允许短答；可以先拌嘴再回答，不要写成小作文。":"允许只抓一个点；允许短句/反问/半截口语。",
    responsePolicy?.primaryAct==="ACK"?"这是短确认，只回一个自然短句，不追问，不回接旧话题。":"",
    responsePolicy?.primaryAct==="CLOSURE"?"这是明确离场，只轻轻回应离场，不反问，不附加任务。":"",
    responsePolicy?.primaryAct==="ADVICE"?"用户明确问了建议，只回答所问范围，不扩展安排。":"",
    `上一候选：${first.visibleText.slice(0,1000)}`
  ].filter(Boolean).join("\n");
  try{
    const up=await upstreamChat({stream:false,temperature:0},[
      {role:"system",content:NATURAL_MESSAGING_SYSTEM},
      {role:"system",content:naturalResponsePolicyBlock(responsePolicy)},
      ...(emotionExpressionBlock(naturalPresence.document.emotion_state,responsePolicy?.primaryAct)?[{role:"system",content:emotionExpressionBlock(naturalPresence.document.emotion_state,responsePolicy?.primaryAct)}]:[]),
      {role:"user",content:prompt}
    ],ctx.mode,signal??null,{});
    if(up.ok){
      const data=await up.json();
      const repaired=typeof data?.choices?.[0]?.message?.content==="string"?data.choices[0].message.content:"";
      const checked=inspectNaturalResponseCandidate({rawText:repaired,selection:responsePolicy,recentAssistantTexts,recentRealizedActs,userText});
      if(checked.ok){
        console.log("[response-act-repair]",JSON.stringify({stage:"accepted",reasons:first.reasons}));
        return {rawContent:checked.canonicalRaw??repaired,repaired:true,reasons:first.reasons};
      }
      console.log("[response-act-repair]",JSON.stringify({stage:"rejected",reasons:checked.reasons}));
    }
  }catch(error){
    console.log("[response-act-repair]",JSON.stringify({stage:"error",code:String(error?.code??error?.name??"error").slice(0,80)}));
  }
  if(responsePolicy?.primaryAct==="ACK")return {rawContent:'{"messages":["嗯"]}',repaired:true,reasons:first.reasons};
  if(first.canonicalRaw&&!first.reasons.includes("verbatim_recent_reply")&&!first.reasons.includes("explicit_obligation_uncovered"))return {rawContent:first.canonicalRaw,repaired:false,reasons:first.reasons};
  return {rawContent, repaired:false,reasons:first.reasons};
}

/** Shared Natural Messaging repair: dangling opener + Semantic Bubble Normalizer. */
function naturalBubblesCompleteFn(ctx,signal){
  return async({mode,opener,text,userText="",context="",bubbles=[],missing=[],acts=[],presence=null})=>{
    let prompt;
    if(mode==="character"){
      const current=Array.isArray(bubbles)&&bubbles.length?bubbles.join("\n\n"):String(text??"");
      prompt=[
        "【Relational Character｜把这句话说成这个人】",
        "上一候选语义完整，但太像机械执行用户动作（复述/同义改写/无立场确认）。",
        "请在相同长度级别重写，像这个角色本人在回应：要有自己的反应/口吻/立场。",
        "不要新增剧情事实，不要安慰长文，不要强制两句，不要扩大话题。",
        `用户当前一句：${String(userText??"").slice(0,300)}`,
        acts.length?`人物互动：${acts.join(", ")}`:"",
        "只输出严格 JSON：{\"messages\":[\"一句更有本人口吻的回复\"]}",
        "上一候选：",
        String(current).slice(0,400)
      ].join("\n");
    }else if(mode==="social"){
      const current=Array.isArray(bubbles)&&bubbles.length?bubbles.join("\n\n"):String(text??"");
      prompt=[
        "【Social Act Completion｜社交动作收住】",
        "上一候选在用户道歉/求和/求 reassurance 时，只顶了一句反问，社交上还悬着。",
        "保留原来的口吻和长度感，可以仍然很短；但要接住社交动作，给一点点关系安全感。",
        "不要写小作文，不要机械加第二句，不要鸡汤。",
        `用户当前一句：${String(userText??"").slice(0,400)}`,
        acts.length?`社交动作：${acts.join(", ")}`:"",
        "只输出严格 JSON：{\"messages\":[\"一句自然收住的回复\"]}",
        "上一候选：",
        String(current).slice(0,600)
      ].join("\n");
    }else if(mode==="coverage"){
      const missingText=Array.isArray(missing)&&missing.length
        ? missing.map((m,i)=>`${i+1}. [${m.kind??"question"}] ${m.text}`).join("；")
        : "用户这轮的明确问题/请求";
      const current=Array.isArray(bubbles)&&bubbles.length?bubbles.join("\n\n"):String(text??"");
      prompt=[
        "【Turn Coverage｜补上被吞掉的明确问题/请求】",
        "上一候选只处理了情绪/拌嘴，没有覆盖同一轮的明确 question/request/task。",
        "请保留已有的自然反应语气，但整轮必须完成明确项。不要写成小作文，可以短答。",
        "可以输出 1～2 条：第一条可保留/轻改反应，第二条自然回答明确项；也可合成一条。",
        `用户当前一句：${String(userText??"").slice(0,500)}`,
        `必须覆盖：${missingText}`,
        "只输出严格 JSON：{\"messages\":[\"反应可选\",\"回答明确项\"]}",
        "上一候选：",
        String(current).slice(0,1000)
      ].join("\n");
    }else if(mode==="rewrite"){
      prompt=`上一轮只写了悬空开头「${opener}」。请在同一句说完，输出 JSON {"messages":["完整的一条"]}`;
    }else if(mode==="split_judge"){
      prompt=[
        "【Semantic Bubble Normalizer】",
        "下面是已经生成好的 Companion 回复。请只判断：这是 1 个连续想法，还是 2～3 个独立聊天动作。",
        "不要重新回答用户，不要新增信息，不要改变事实，不要解释。",
        "尽量保留原措辞，只做重新分组。",
        "输出严格 JSON：{\"messages\":[\"...\", \"...\"]}",
        "规则：",
        "- 1～3 条；一个 conversational act 一个 bubble。",
        "- 原回复已使用空行分成两个自然段时，这是多个聊天动作的强信号；除非其中是代码、表格、JSON、日志、引用或确实同一连续说明，否则应保持这些动作边界。",
        "- 下面通常应拆：第一反应+补充说明；答当前句+另一 callback；情绪反应+实际事项；收到/知道了+后续动作；一个结论+一个独立问题。",
        "- 连续想法（如「在呢」「嗯，我知道了」）保持 1 条。",
        "- 不要按句号机械切；不要凭空改写。",
        userText?`用户最后一句：${String(userText).slice(0,400)}`:"",
        context?`必要上下文：${String(context).slice(0,300)}`:"",
        "已生成回复：",
        String(text??"").slice(0,1500)
      ].filter(Boolean).join("\n");
    }else{
      prompt=`上一轮写了「${opener}」但没下文。请立刻给出真正下文，输出 JSON {"messages":["${opener}","真正下文"]}`;
    }
    const up2=await upstreamChat({stream:false,temperature:0},[{role:"system",content:NATURAL_MESSAGING_SYSTEM},{role:"user",content:prompt}],ctx.mode,signal??null,{});
    if(!up2.ok)throw Object.assign(new Error("bubble normalizer upstream failed"),{code:`BUBBLE_NORMALIZER_HTTP_${up2.status}`});
    const d2=await up2.json();
    const content=typeof d2?.choices?.[0]?.message?.content==="string"?d2.choices[0].message.content:"";
    if(!content)throw Object.assign(new Error("bubble normalizer returned empty content"),{code:"BUBBLE_NORMALIZER_EMPTY"});
    return content;
  };
}

function traceBubble(stage,data){
  console.log(`[${stage}]`,JSON.stringify(data));
}

function bubbleTransportChunks(text){
  const chars=Array.from(String(text??""));
  const configured=Number(process.env.COMPANION_BUBBLE_SSE_CHUNK_CHARS);
  const size=Number.isFinite(configured)&&configured>0?Math.max(1,Math.min(500,configured)):160;
  if(!chars.length)return [];
  const chunks=[];
  for(let i=0;i<chars.length;i+=size)chunks.push(chars.slice(i,i+size).join(""));
  return chunks;
}

function writeBubbleSse({res,model,messageId,index,count,text,plan,extraPayload=null}){
  const chunks=bubbleTransportChunks(text);
  chunks.forEach((chunk,chunkIndex)=>{
    traceBubble("sse",{frame_message_id:messageId,bubble_index:index,bubble_count:count,chunk_index:chunkIndex,chunk_count:chunks.length,text_length:chunk.length,turn_id:plan.turn_id});
    res.write(`data: ${JSON.stringify({
      id:`companion-bubble-${index}-${messageId}-${chunkIndex}`,
      object:"chat.completion.chunk",
      model,
      choices:[{index:0,delta:{role:"assistant",content:chunk},finish_reason:index===count-1&&chunkIndex===chunks.length-1?"stop":undefined}],
      companion_bubble_index:index,
      companion_bubble_count:count,
      companion_message_id:messageId,
      companion_bubble_turn_id:plan.turn_id,
      ...(extraPayload&&typeof extraPayload==="object"?extraPayload:{})
    })}\n\n`);
  });
}

/**
 * True post-message follow-up: only AFTER primary bubbles are durable + emitted.
 * At most one independent generation per user turn. Best-effort — never fails primary.
 */
async function maybeRunPostMessageAfterPrimary({
  body,ctx,session,currentUser,currentUserText="",turnId,primaryBubbles=[],
  closureDecision=null,controller,userInterrupted=null,source="chat",routeKey=null,upModel=null,onFollowupEmit=null
}){
  const primaryText=(primaryBubbles||[]).join("\n");
  const silenceRequested=/先别说了|不要说了|别说了|闭嘴|安静会|stop\s*it/i.test(String(currentUserText||""));
  const userLeaving=closureDecision?.kind==="leave"||/我睡了|睡觉了|先睡|晚安/.test(String(currentUserText||""));
  let associationCandidate=null;
  try{
    // Ensure this turn's current Event exists so post-message can see 1-hop links.
    createCurrentEventAssociations({
      personaId:ctx.personaId,
      sessionId:session.id,
      sourceMessageId:currentUser?.id??null,
      text:currentUserText
    });
  }catch{}
  try{
    const rows=associatedMemoryCandidatesForMessage(ctx.personaId,currentUser?.id??null);
    const top=rows?.[0];
    if(top?.memory?.id){
      associationCandidate={
        salience:Number(top.association?.activation_score??top.association?.strength??0.6),
        topic:String(top.memory.content??"").slice(0,80),
        memory_id:top.memory.id,
        event_id:top.association?.event_id??null,
        confidence:Number(top.memory.confidence??0.7)
      };
    }
  }catch{}
  let activeMemoryCandidate=null;
  try{
    const active=defaultActiveMemory.snapshot?.()??[];
    const top=active[0];
    if(top?.memory_id&&Number(top.activation)>=0.55&&top.activation_reason==="association_selected"){
      activeMemoryCandidate={
        salience:Number(top.activation),
        topic:String(top.memory_id).slice(0,24),
        memory_id:top.memory_id,
        confidence:0.65
      };
    }
  }catch{}

  const result=await runPostMessagePhase({
    parentTurnId:turnId,
    parentUserMessageId:currentUser?.id??null,
    sessionId:session.id,
    source,
    userText:currentUserText,
    primaryText,
    primaryBubbles,
    closureLikely:Boolean(closureDecision?.likely),
    userLeaving,
    silenceRequested,
    isProactive:source==="proactive",
    gateInputs:{associationCandidate,activeMemory:activeMemoryCandidate,emotionState:naturalPresence.document?.emotion_state??null},
    userInterrupted,
    getLatestUserMessageId:()=>getPreviousRealInteraction(session.id).user?.id??null,
    findDurableFollowup:findPostMessageFollowupByAttemptKey,
    signal:controller?.signal??null,
    generateFollowup:async(decision)=>{
      const prompt=buildFollowupPrompt({userText:currentUserText,primaryText,decision});
      const followupController=new AbortController();
      const followupTimeoutMs=Number(postMessageLimits().followup_timeout_ms)||60000;
      const timer=setTimeout(()=>followupController.abort(),followupTimeoutMs);
      const onParentAbort=()=>followupController.abort();
      controller?.signal?.addEventListener?.("abort",onParentAbort,{once:true});
      try{
        const up=await upstreamChat({model:body?.model??"yuna-chat",stream:false,max_tokens:80,temperature:0.7},
          [{role:"user",content:prompt}],"chat",followupController.signal,
          {phase:"post_message_followup",turnId,generationId:`${turnId}:pm1`,requestId:`postmsg:${turnId}:1`});
        if(!up?.ok)throw Object.assign(new Error(`followup upstream ${up?.status}`),{statusCode:up?.status});
        const j=await up.json().catch(()=>null);
        const text=j?.choices?.[0]?.message?.content;
        return typeof text==="string"?text:"";
      }finally{
        clearTimeout(timer);
        controller?.signal?.removeEventListener?.("abort",onParentAbort);
      }
    },
    deliverFollowupOnEmit:onFollowupEmit,
    deliverFollowup:async({text,decision,attemptKey,onEmit=null})=>{
      const plan=createBubblePlan([text],{generationRoute:"post_message_followup",turnId:`${turnId}:pm1`,origin:"post_message_followup"});
      const sequence=await deliverBubbleSequence({
        sessionId:session.id,source,bubblePlan:plan,generationRoute:"post_message_followup",
        turnId:`${turnId}:pm1`,signal:controller?.signal??null,hasUserInterrupted:userInterrupted,
        userModality:"text",enableModality:true,
        enqueueVoice:enqueueVoiceAfterDurable,
        extraContentJson:({plan:planItem})=>({
          bubble_index:0,bubble_count:1,
          bubble_turn_id:planItem.turn_id,
          generation_route:"post_message_followup",
          origin:"post_message_followup",
          post_message:{
            attempt_key:attemptKey,
            parent_turn_id:String(turnId).slice(0,160),
            reason_code:decision.reason_code,
            salience:decision.salience,
            candidate_topic:decision.candidate_topic,
            related_memory_id:decision.related_memory_id,
            related_event_id:decision.related_event_id,
            confidence:decision.confidence
          }
        }),
        onTrace:(stage,data)=>traceBubble(stage,data),
        onDelivered:async(payload)=>{await onEmit?.(payload);}
      });
      const message=sequence.messages[0]??null;
      return {messageId:message?.messageId??null,index:0,text,plan:plan[0],interrupted:Boolean(sequence.interrupted)};
    }
  });
  return result;
}

/** The sole chat final-answer boundary. Nothing below this returns to raw text. */
async function finalizeAssistantBubblePlan({rawContent="",userText="",ctx,controller,generationRoute,turnId,closureDecision=null,presence=null}){
  if(Array.isArray(config.testForcedBubbles)&&config.testForcedBubbles.length){
    const plan=createBubblePlan(config.testForcedBubbles.slice(0,3),{generationRoute,turnId});
    traceBubble("natural-messaging",{generation_route:generationRoute,forced:true,parsed_messages_count:plan.length,normalized_messages_count:plan.length});
    return {plan,closureTrimmed:false};
  }
  let closureTrimmed=false;
  const result=await finalizeBubblePlan({
    rawModelOutput:rawContent,
    completeFn:naturalBubblesCompleteFn(ctx,controller.signal),
    signal:controller.signal,
    userText,
    generationRoute,
    turnId,
    presence,
    finalTransform:bubbles=>{
      if(!closureDecision)return bubbles;
      const closed=applyClosureToBubbles(bubbles,closureDecision);
      closureTrimmed=Boolean(closed.trimmed);
      return closed.bubbles;
    },
    onTrace:trace=>traceBubble("natural-messaging",{
      generation_route:trace.generationRoute,
      raw_model_output:{length:trace.rawLength,sha256:trace.rawSha256,...(process.env.COMPANION_BUBBLE_TRACE_DEBUG==="1"?{text:String(rawContent).slice(0,1500)}:{})},
      parsed_messages_count:trace.parsedMessagesCount,
      normalized_messages_count:trace.normalizedMessagesCount,
      semantic_outcome:trace.semanticDecision?.outcome,
      coverage_outcome:trace.coverageDecision?.outcome,
      coverage_complete:trace.coverageDecision?.complete,
      social_outcome:trace.socialDecision?.outcome,
      social_complete:trace.socialDecision?.complete,
      character_outcome:trace.characterDecision?.outcome,
      character_complete:trace.characterDecision?.complete,
      dangling_outcome:trace.danglingDecision,
      packed_double:trace.packedDouble,
      multi_act:trace.multiAct
    })
  });
  return {plan:result.plan,closureTrimmed};
}

import { observeUserTurnForMemory } from "./memory-capture.js";
import { createExpectationTransitionEvents } from "./event-association.js";
import { companionStateSummary,getBehavior,updateBehavior,inQuietHours,touchUserInteraction } from "./companion-state.js";
import { triggerEngine,installEventHook } from "./modules/triggers.js";
import { moduleExecutionLedger } from "./modules/ledger.js";
import { WEB_SEARCH_TOOL_SPEC,dedupeSources,executeWebSearchTool,searchStatus,setSearchRuntimeConfig,wrapUntrustedSearchContent } from "./search/index.js";
import { mcpRegistry } from "./mcp/client.js";
import { handleMcpHttpRequest } from "./mcp/http.js";
import { browserCapabilityGuidance, buildCapabilityRegistry, capabilityCounts, capabilityToCompatTool, selectMcpCapabilities, wrapUntrustedToolOutput } from "./capability-registry.js";
import { classifyToolFailure,toolActivityMetadata } from "./tool-activity.js";
import { createAgentLifecycle,AGENT_LIFECYCLE_EVENTS } from "./agent-lifecycle.js";
import { agentTasks } from "./agent-task-store.js";
import { agentV1Context,agentToolsV1,isAgentV1Tool } from "./agent-tools-v1.js";
import { hydrateLocalResources } from "./local-resource-resolver.js";
import { runNativeAgent } from "./native-agent-runtime.js";
import { TurnRecoveryStore } from "./turn-recovery.js";
import { classifyNetworkFailure,networkLog,retryNetworkOperation } from "./network-resilience.js";
import { scheduler } from "./scheduler.js";
import { guidanceQueue } from "./guidance-queue.js";
import { consumeChatCompletionSse } from "./chat-stream.js";
import { sessionPermissions } from "./session-permissions.js";
import { activeTurns } from "./active-turns.js";
import { buildTimeContext,temporalContextStore } from "./temporal-context.js";
import { autonomousCapabilityContext,executeAutonomousCapabilityTool } from "./autonomous-capabilities.js";
import { capabilityInstaller } from "./capability-installer.js";
import { isLocalAgentToolName,localAgentCapabilityContext,localAgentRuntime } from "./local-agent-runtime.js";
import { developerOperationsCapabilityContext,developerOperationsRuntime,isDeveloperOperationToolName } from "./developer-operations-runtime.js";
import { isSelfMaintenanceToolName,selfMaintenanceCapabilityContext,selfMaintenanceRuntime } from "./self-maintenance-runtime.js";
import { isPackageOperationToolName,packageOperationsCapabilityContext,packageOperationsRuntime } from "./package-operations-runtime.js";
import { localRuntimeControls } from "./local-runtime-controls.js";
import { localGPTSoVITSService } from "./local-gpt-sovits-service.js";
import { voiceAvailabilityGuidance,voiceTTSCapabilityContext,VOICE_TOOL_NAME } from "./voice-tts-adapter.js";
import { localSenseVoiceService } from "./local-sensevoice-service.js";
import { localWakeWordService } from "./local-wake-word-service.js";
import { voiceCallDiagnostics } from "./voice-call-diagnostics.js";
import { attentionStore } from "./attention-store.js";
import { captureExplicitScreenContext } from "./presence-screen.js";
import { computerUseAdapter } from "./computer-use-adapter.js";
import { autonomousLife } from "./autonomous-life/index.js";

const turnRecovery=new TurnRecoveryStore(config.turnRecoveryPath);
turnRecovery.prune({keep:500});

if(config.apiKey==="CHANGE_ME_TO_A_LONG_RANDOM_KEY"){
  throw new Error("请先在 .env 设置随机 COMPANION_API_KEY；Companion Core 不允许使用默认公开 Key 启动。");
}
ensureDefaultPersona();
sessionPermissions.onEvent=(type,data,meta)=>{
  publishEvent(type,data,meta);
  if(type==="permission.requested"){
    const recorded=attentionStore.record({
      type:"approval_needed",source:"permission",resource:meta?.sessionId??"",fingerprint:data?.request?.request_id??"",
      title:"Companion需要你的确认。",summary:"有一个操作正在等待批准。",destination:"chat",
      conversation_id:meta?.sessionId??null,state:"pending"
    });
    if(recorded.delivered)publishEvent("attention.created",{id:recorded.item.id,type:"approval_needed",title:recorded.item.title},{sessionId:meta?.sessionId});
  }
};
capabilityInstaller.onProgress=event=>publishEvent("capability.install.progress",event,{sessionId:"capability-installer-ui"});

moduleRegistry.attachTriggerEngine(triggerEngine);
triggerEngine.attach(moduleRegistry);
installEventHook();
if(config.modulesEnabled){
  moduleRegistry.loadAll().then(status=>{
    triggerEngine.start();
    console.log(`[modules] loaded ${status.modules.filter(m=>m.loaded).length}/${status.modules.length} from ${config.modulesDir}`);
  }).catch(e=>console.error("[modules] init failed:",redactSecrets(e)));
}else{
  moduleRegistry.ready=true;
  console.log("[modules] disabled by MODULES_ENABLED=false");
}
if(config.autonomousLifeEnabled||process.env.COMPANION_PROACTIVE_DISABLED!=="1")startProactiveEngine();

const sessionQueues=new Map();
// 客户端原始对话负载指纹：请求级稳定，注入 Persona/Memory 前计算，
// 用于 Module Tool 执行台账区分"同一逻辑请求的重试"与"新一轮调用"。
function rawTurnFingerprint(kind,body){
  const items=kind==="responses"?(Array.isArray(body?.input)?body.input:[]):incomingTail(body?.messages??[]);
  return sha256(stableJson(items));
}
function inSession(id,fn){const prev=sessionQueues.get(id)??Promise.resolve();const next=prev.catch(()=>{}).then(fn).finally(()=>{if(sessionQueues.get(id)===next)sessionQueues.delete(id);});sessionQueues.set(id,next);return next;}
const compatFailureGuard=new Map();
function hasToolResult(body){return (body?.messages??[]).some(m=>m?.role==="tool")||(Array.isArray(body?.input)&&body.input.some(x=>x?.type==="function_call_output"));}
function isToolContinuation(kind,body){
  const items=kind==="responses"?(Array.isArray(body?.input)?body.input:[]):(body?.messages??[]);let lastUser=-1,lastTool=-1;
  for(let i=0;i<items.length;i++){if(items[i]?.role==="user")lastUser=i;if(items[i]?.role==="tool"||items[i]?.type==="function_call_output")lastTool=i;}
  return lastTool>lastUser;
}
const agentRouteKey=session=>`agent:${session.id}`;
function compatRetryFingerprint(kind,sessionId,body){
  if(hasToolResult(body))return null;
  const conversation=kind==="responses"?body?.input:body?.messages;
  return sha256(stableJson({kind,sessionId,conversation,tools:normalizeCompatTools(body?.tools),tool_choice:body?.tool_choice??"auto"}));
}
function guardedCompatFailure(key){
  if(!key)return null;const now=Date.now();for(const [k,v] of compatFailureGuard)if(v.expires<=now)compatFailureGuard.delete(k);
  const hit=compatFailureGuard.get(key);if(!hit)return null;noteCompat("retry_suppressed");return hit;
}
function rememberCompatFailure(key,category){if(key)compatFailureGuard.set(key,{category,expires:Date.now()+config.agentCompatRetryGuardMs});}
function sendGuardedCompatFailure(res,hit){return json(res,502,{error:{message:`duplicate compat request suppressed after recent ${hit.category} decision`,type:"upstream_error",code:"compat_retry_suppressed"}});}

const models=()=>({object:"list",data:["yuna-chat","yuna-agent"].map(id=>({id,object:"model",created:Math.floor(Date.now()/1000),owned_by:"companion-core"}))});
const capabilities=()=>{
  const registry=buildCapabilityRegistry({moduleTools:moduleRegistry.enabledModuleTools(),mcpCapabilities:mcpRegistry.allCapabilities()});
  const local=localAgentRuntime.capabilities({available:false}),developer=developerOperationsRuntime.capabilities(),self=selfMaintenanceRuntime.capabilities(),voice=voiceTTSCapabilityContext().capabilities,counts=capabilityCounts(registry);counts.native+=local.length+developer.length+self.length+voice.length;
  const controls=localRuntimeControls.snapshot().enabled;
  return {vision:{configured:true,mode:"openai_compatible_passthrough"},web_search:searchStatus(config),voice:localGPTSoVITSService.publicStatus(),speech:localSenseVoiceService.publicStatus(),wake_word:localWakeWordService.publicStatus(),autonomous_life:{enabled:config.autonomousLifeEnabled,version:"0.1",persistent:true},local_runtime:{terminal:{status:"installed",ready:controls.terminal?"task_scoped":"disabled",enabled:controls.terminal,requires_workspace:true},filesystem:{status:"installed",ready:controls.filesystem?"task_scoped":"disabled",enabled:controls.filesystem,requires_workspace:true},git:{status:"installed",ready:"task_scoped",requires_workspace:true},github:{status:"installed",ready:"needs_auth",auth:"secure_gh"},process:{status:"installed",ready:"task_scoped"},service:{status:"installed",ready:"task_scoped"},package_manager:{status:"installed",ready:controls.package_manager?"task_scoped":"disabled",enabled:controls.package_manager,requires_workspace:true,operations:packageOperationsRuntime.snapshot().operations.length},self_maintenance:{status:"installed",ready:controls.self_maintenance?"task_scoped":"disabled",enabled:controls.self_maintenance,candidate_only:true,transaction:selfMaintenanceRuntime.publicState(selfMaintenanceRuntime.active())},hard_safety_boundary:"active"},capability_registry:{counts,candidate_max:config.agentToolCandidateLimit}};
};
const h=(req,name)=>{const v=req.headers[name.toLowerCase()];return Array.isArray(v)?v[0]:v;};
function bearer(req){const v=h(req,"authorization")??"";const m=v.match(/^Bearer\s+(.+)$/i);return m?.[1]?.trim()??"";}
function apiAuth(req){return bearer(req)===config.apiKey;}
function adminAuth(req){if(!config.adminRemoteAccess&&!isLoopback(req.socket.remoteAddress))return false;return bearer(req)===config.adminKey;}
function adminHostAllowed(req){return config.adminRemoteAccess||isLoopback(req.socket.remoteAddress);}
function resolveContext(req,body){
  const publicModel=cleanKey(body.model,"yuna-chat",100);
  const source=cleanKey(h(req,"x-companion-source")??body.companion_source??(publicModel.includes("agent")?"agent":"chat"),publicModel.includes("agent")?"agent":"chat",80);
  const mode=publicModel.includes("agent")||/agent|opencode|harness|code/i.test(source)?"agent":"chat";
  const personaId=cleanKey(h(req,"x-companion-persona")??body.companion_persona??config.defaultPersonaId,config.defaultPersonaId,100);
  const session=resolveSession(req,body,source);
  return {publicModel,source,mode,personaId,...session};
}
function mergeTool(map,tc){
  const i=Number(tc?.index??0),cur=map.get(i)??{id:tc?.id,type:tc?.type??"function",function:{name:"",arguments:""}};
  if(tc?.id)cur.id=tc.id;if(tc?.type)cur.type=tc.type;
  if(tc?.function?.name)cur.function.name+=String(tc.function.name);
  if(tc?.function?.arguments!==undefined)cur.function.arguments+=typeof tc.function.arguments==="string"?tc.function.arguments:JSON.stringify(tc.function.arguments);
  map.set(i,cur);
}


function storeMessage(sessionId,source,message,{emit=true}={}){
  const messageId=insertMessage(sessionId,source,message);
  if(emit){
    const preview=typeof message.content==="string"?message.content:JSON.stringify(message.content??"");
    publishEvent("message.created",{messageId,role:message.role,source,preview:String(preview??"").slice(0,300)},{sessionId});
  }
  return messageId;
}

const voiceReadySinks=new Map();
function registerVoiceReadySink(sessionId,sink){
  const id=String(sessionId??"");
  const set=voiceReadySinks.get(id)??new Set();
  set.add(sink);
  voiceReadySinks.set(id,set);
  return ()=>{set.delete(sink);if(!set.size)voiceReadySinks.delete(id);};
}
function emitVoiceReadySse(payload){
  const sinks=voiceReadySinks.get(String(payload?.session_id??""))??[];
  const frame=`event: companion.voice_ready\ndata: ${JSON.stringify({companion_voice_ready:payload})}\n\n`;
  for(const sink of sinks){
    try{sink(frame,payload);}catch{}
  }
}
defaultVoiceAsyncQueue.onVoiceReady=async(payload)=>{emitVoiceReadySse(payload);};

/** Decide voice delivery only. Never synthesizes. Text-first stays unblocked. */
function prepareAssistantVoice({userText,assistantText}){
  return decideVoiceDelivery({
    mode:localGPTSoVITSService.settings.mode,
    enabled:localGPTSoVITSService.settings.enabled,
    userText,assistantText
  });
}

function enqueueVoiceAfterDurable({messageId,sessionId,text,style,signal=null,voicePlan=null}){
  if(!messageId||!text)return {status:"SKIP"};
  return enqueueAssistantVoice({messageId,sessionId,text,style:style??"neutral",voicePlan,signal});
}

function buildAutonomousContext(messages,workspaceRoot){
  const v1=agentV1Context(messages,{workspaceRoot});
  const computerContext=autonomousCapabilityContext(messages),localContext=v1?null:localAgentCapabilityContext(messages,{workspaceRoot}),developerContext=developerOperationsCapabilityContext(messages,{workspaceRoot}),selfContext=selfMaintenanceCapabilityContext(messages,{workspaceRoot}),packageContext=packageOperationsCapabilityContext(messages,{workspaceRoot});
  const relevantContexts=[v1,computerContext,packageContext,selfContext,developerContext,localContext].filter(Boolean),nativeContexts=relevantContexts.filter(context=>context?.capabilities?.length),nativeCapabilities=nativeContexts.flatMap(context=>context.capabilities).slice(0,32),nativeNames=new Set(nativeCapabilities.map(capability=>capability.name));
  return relevantContexts.length?{agentV1:Boolean(v1),paths:v1?.paths??[],guidance:relevantContexts.map(context=>context.guidance).filter(Boolean).join("\n\n"),tools:nativeContexts.flatMap(context=>context.tools).filter(tool=>nativeNames.has(tool.function.name)),capabilities:nativeCapabilities,workspaceRoot:v1?.workspaceRoot??packageContext?.workspaceRoot??selfContext?.workspaceRoot??localContext?.workspaceRoot??developerContext?.workspaceRoot??null,computerUseRequested:Boolean(computerContext)}:null;
}

function activityMetadata(name,args,sourceHint=null,extra={}){
  return toolActivityMetadata({wireName:name,args,sourceHint,...extra,mcpMetadata:mcpRegistry.presentationMetadataForWireName(name)});
}

async function runCompatDecision({body,messages,ctx,session,signal,routeKey,turnFingerprint}){
  const mcpCapabilities=selectMcpCapabilities(mcpRegistry.agentCapabilities(),messages,{limit:config.agentToolCandidateLimit});
  const registry=buildCapabilityRegistry({clientTools:body.tools,moduleTools:moduleRegistry.enabledModuleTools(),mcpCapabilities});
  const unified=registry.map(capabilityToCompatTool);
  const policy=compatChoicePolicy(body.tool_choice,unified);
  if(!policy.valid){const e=new Error("tool_choice references an unavailable tool");e.statusCode=400;throw e;}
  const selected=selectCompatToolCandidates(unified,messages,body.tool_choice,{target:config.agentToolCandidateLimit});
  let contract=buildToolContractDetails(selected.tools,body.tool_choice,selected.actionIntent);
  const lookup=id=>findSessionToolCall(session.id,id);
  const requestMetric=noteCompatRequest({clientToolCount:selected.clientToolCount,candidateToolCount:selected.candidateToolCount,contractChars:contract.chars,contractTokensEstimate:contract.tokenEstimate,actionIntents:selected.actionIntent.actionRequested?selected.actionIntent.intents.map(x=>x.name):[],fallbackReason:selected.fallbackReason});
  let prompt=compatMessages(messages,contract.contract,lookup),usage=null,lastError="",lastCategory="other",protocolRetries=0,toolMissRecovered=false,moduleLoops=0,currentSelection=selected;
  while(true){
    if(signal?.aborted){finishAgentProviderRoute(routeKey,false);throw Object.assign(new Error("client cancelled"),{name:"AbortError"});}
    const up=await upstreamCompat(body,prompt,signal,{lockKey:routeKey}),upInfo=upstreamResponseInfo(up);
    if(!up.ok)return {upstreamError:up};
    let value,raw="";
    try{value=await up.json();raw=messageText(value?.choices?.[0]?.message?.content);}
    catch{lastError="upstream returned invalid JSON";lastCategory="other";}
    if(value?.usage){usage=mergeUsage(usage,value.usage);insertUsage({sessionId:session.id,source:ctx.source,publicModel:ctx.publicModel,upstreamModel:usageUpstreamModel(upInfo),kind:"agent",usage:value.usage});}
    const parsed=raw?parseToolDecision(raw,unified,body.tool_choice,currentSelection.tools):{ok:false,category:lastCategory,error:lastError||"upstream decision content missing"};
    if(parsed.ok){
      if(!toolMissRecovered&&shouldRecoverToolMiss(parsed.decision,body.tool_choice,currentSelection)){
        toolMissRecovered=true;noteCompatToolMissRecovery(requestMetric);prompt=toolMissRecoveryMessages(messages,currentSelection.matchingTools,currentSelection.actionIntent,lookup);continue;
      }
      if(parsed.decision.type==="tool_call"){
        const entry=findRequestTool(currentSelection.tools,parsed.decision.name);
        if(isModuleTool(entry)){
          if(++moduleLoops>config.moduleToolMaxLoops){finishAgentProviderRoute(routeKey,false);const e=new Error(`module tool loop exceeded ${config.moduleToolMaxLoops} rounds`);e.statusCode=502;e.compatCategory="other";throw e;}
          noteCompat("module_tool_calls");
          const callId=newCallId();
          const activity=activityMetadata(entry.name,parsed.decision.arguments,"module",{sourceId:entry.moduleId,integrationName:/weather/i.test(`${entry.moduleId} ${entry.name}`)?"Weather":"Module",displayName:entry.name});
          publishEvent("module.started",{callId,tool:entry.name,moduleId:entry.moduleId,activity},{sessionId:session.id});
          // 执行指纹 = 请求级 turn 指纹 + 当前 loop 内已存在的 tool 消息数。
          // tool 计数只由客户端原始输入与本 loop 注入的结果行构成，
          // 不受 Persona/Memory 注入内容在重试间的漂移影响：
          //  - 客户端重试同一逻辑请求 → 相同 turn 指纹 + 相同步骤序号 → 命中台账回放
          //  - 同一 loop 内第二次相同参数调用 → 步骤序号 +1 → 视为新执行
          const executionFingerprint=`${turnFingerprint??""}|step=${messages.filter(m=>m?.role==="tool").length}`;
          const assistantMsg={role:"assistant",content:null,tool_calls:[{id:callId,type:"function",function:{name:parsed.decision.name,arguments:JSON.stringify(parsed.decision.arguments)}}]};
          storeMessage(session.id,ctx.source,assistantMsg);
          let resultText;
          try{
            const outcome=await moduleExecutionLedger.run({
              sessionId:session.id,
              moduleId:entry.moduleId,
              toolName:entry.name,
              args:parsed.decision.arguments,
              fingerprint:executionFingerprint,
              sideEffect:entry.sideEffect??"non_idempotent",
              execute:async()=>{
                try{return {outcome:"completed",text:await moduleRegistry.executeModuleTool(entry.name,parsed.decision.arguments)};}
                catch(e){
                  if(e?.code==="MODULE_DISABLED"||e?.code==="MODULE_TOOL_NOT_FOUND")throw e;
                  return {outcome:"failed",text:`[module tool error] ${redactSecrets(e.message)}`};
                }
              }
            });
            resultText=outcome.text;
            publishEvent(outcome.uncertain?"module.failed":"module.completed",{callId,tool:entry.name,moduleId:entry.moduleId,replayed:Boolean(outcome.replayed),uncertain:Boolean(outcome.uncertain),activity},{sessionId:session.id});
          }catch(e){
            if(e?.code==="MODULE_DISABLED"||e?.code==="MODULE_TOOL_NOT_FOUND"){finishAgentProviderRoute(routeKey,false);e.statusCode=502;e.compatCategory="other";throw e;}
            resultText=`[module tool error] ${redactSecrets(e.message)}`;
          }
          const toolMsg={role:"tool",tool_call_id:callId,name:entry.name,content:resultText};
          storeMessage(session.id,ctx.source,toolMsg);
          messages=[...messages,assistantMsg,toolMsg];
          currentSelection=selectCompatToolCandidates(unified,messages,body.tool_choice,{target:config.agentToolCandidateLimit});
          contract=buildToolContractDetails(currentSelection.tools,body.tool_choice,currentSelection.actionIntent);
          prompt=compatMessages(messages,contract.contract,lookup);
          continue;
        }
        if(isMcpTool(entry)){
          // MCP 工具：与 module tool 同样的 loop 预算 / 台账幂等 / 不可信包裹。
          if(++moduleLoops>config.moduleToolMaxLoops){finishAgentProviderRoute(routeKey,false);const e=new Error(`core tool loop exceeded ${config.moduleToolMaxLoops} rounds`);e.statusCode=502;e.compatCategory="other";throw e;}
          noteCompat("mcp_tool_calls");
          const callId=newCallId();
          const activity=activityMetadata(entry.name,parsed.decision.arguments,"mcp");
          publishEvent("tool.started",{callId,name:entry.name,source:"mcp",integrationId:entry.moduleId,activity},{sessionId:session.id});
          const executionFingerprint=`${turnFingerprint??""}|step=${messages.filter(m=>m?.role==="tool").length}`;
          const assistantMsg={role:"assistant",content:null,tool_calls:[{id:callId,type:"function",function:{name:parsed.decision.name,arguments:JSON.stringify(parsed.decision.arguments)}}]};
          storeMessage(session.id,ctx.source,assistantMsg);
          let resultText;
          try{
            const outcome=await moduleExecutionLedger.run({
              sessionId:session.id,
              moduleId:`mcp:${entry.moduleId}`,
              toolName:entry.name,
              args:parsed.decision.arguments,
              fingerprint:executionFingerprint,
              sideEffect:entry.sideEffect==="idempotent"?"idempotent":"non_idempotent",
              execute:async()=>{
                try{
                  const authorizedHighRisk=currentSelection.actionIntent.actionRequested&&currentSelection.matchingTools.some(tool=>tool.name===entry.name);
                  const result=await mcpRegistry.executeByWireName(entry.name,parsed.decision.arguments,{authorizedHighRisk});
                  return {outcome:"completed",text:wrapUntrustedToolOutput(result.text)};
                }catch(e){
                  if(e?.code==="MCP_TOOL_NOT_FOUND"||e?.code==="MCP_INTEGRATION_DISABLED"||e?.code==="MCP_TOOL_DENIED"||e?.code==="MCP_NOT_CONNECTED"||e?.code==="MCP_CONFIRMATION_REQUIRED")throw e;
                  return {outcome:"failed",text:wrapUntrustedToolOutput(`[mcp tool error] ${redactSecrets(e.message)}`)};
                }
              }
            });
            resultText=outcome.text;
            publishEvent(outcome.uncertain?"tool.failed":"tool.completed",{callId,name:entry.name,source:"mcp",integrationId:entry.moduleId,replayed:Boolean(outcome.replayed),uncertain:Boolean(outcome.uncertain),activity},{sessionId:session.id});
          }catch(e){
            if(e?.code){finishAgentProviderRoute(routeKey,false);e.statusCode=502;e.compatCategory="other";throw e;}
            resultText=wrapUntrustedToolOutput(`[mcp tool error] ${redactSecrets(e.message)}`);
          }
          const toolMsg={role:"tool",tool_call_id:callId,name:entry.name,content:resultText};
          storeMessage(session.id,ctx.source,toolMsg);
          messages=[...messages,assistantMsg,toolMsg];
          currentSelection=selectCompatToolCandidates(unified,messages,body.tool_choice,{target:config.agentToolCandidateLimit});
          contract=buildToolContractDetails(currentSelection.tools,body.tool_choice,currentSelection.actionIntent);
          prompt=compatMessages(messages,contract.contract,lookup);
          continue;
        }
        noteCompat("tool_calls");
        publishEvent("tool.started",{callId:newCallId(),name:parsed.decision.name,source:"client",note:"execution happens on the client"},{sessionId:session.id});
      }
      finishAgentProviderRoute(routeKey,parsed.decision.type==="tool_call");return {decision:parsed.decision,usage};
    }
    lastError=parsed.error;lastCategory=parsed.category??"other";noteCompatInvalid(lastCategory,requestMetric);
    if(protocolRetries<config.agentToolProtocolRetries){protocolRetries++;noteCompatRetry(requestMetric);prompt=repairMessages(messages,unified,body.tool_choice,lastCategory,lookup);continue;}
    finishAgentProviderRoute(routeKey,false);const e=new Error(`upstream tool decision failed validation (${lastCategory}): ${lastError}`);e.statusCode=502;e.compatCategory=lastCategory;throw e;
  }
}

function sendCompatResponseSse(res,out){
  const response=out.response,write=(name,data)=>res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  write("response.created",{type:"response.created",response:{...response,status:"in_progress",output:[],usage:null}});
  write("response.in_progress",{type:"response.in_progress",response:{...response,status:"in_progress",output:[],usage:null}});
  const item=response.output[0];write("response.output_item.added",{type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",...(item.type==="function_call"?{arguments:""}:{content:[]})}});
  if(item.type==="function_call"){
    write("response.function_call_arguments.delta",{type:"response.function_call_arguments.delta",item_id:item.id,output_index:0,delta:item.arguments});
    write("response.function_call_arguments.done",{type:"response.function_call_arguments.done",item_id:item.id,output_index:0,call_id:item.call_id,name:item.name,arguments:item.arguments});
  }else{
    const text=item.content[0].text;write("response.content_part.added",{type:"response.content_part.added",item_id:item.id,output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}});
    write("response.output_text.delta",{type:"response.output_text.delta",item_id:item.id,output_index:0,content_index:0,delta:text});
    write("response.output_text.done",{type:"response.output_text.done",item_id:item.id,output_index:0,content_index:0,text});
    write("response.content_part.done",{type:"response.content_part.done",item_id:item.id,output_index:0,content_index:0,part:item.content[0]});
  }
  write("response.output_item.done",{type:"response.output_item.done",output_index:0,item});write("response.completed",{type:"response.completed",response});
}

function sendCompatChatSse(res,out){
  const c=out.completion,delta=out.message.tool_calls?{role:"assistant",tool_calls:out.message.tool_calls.map((call,index)=>({index,...call}))}:{role:"assistant",content:out.message.content};
  res.write(`data: ${JSON.stringify({id:c.id,object:"chat.completion.chunk",created:c.created,model:c.model,choices:[{index:0,delta,finish_reason:c.choices[0].finish_reason}],usage:c.usage,...(c.companion_autonomy?{companion_autonomy:c.companion_autonomy}:{})})}\n\n`);res.write("data: [DONE]\n\n");
}

function sendCachedChatResponse(res,cached,model){
  if(!cached||typeof cached!=="object")return false;
  res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",connection:"keep-alive","x-accel-buffering":"no"});
  const plan=Array.isArray(cached.companion_bubble_plan)?cached.companion_bubble_plan:[];
  for(const [index,item] of plan.entries()){
    const text=String(item?.text??cached?.companion_bubbles?.[index]??"");if(!text)continue;
    writeBubbleSse({res,model,messageId:Number(item?.message_id)||0,index:Number(item?.bubble_index??index),count:Number(item?.bubble_count??plan.length),text,plan:{...item,turn_id:item?.turn_id??item?.bubble_turn_id??null}});
  }
  res.write(`event: companion.bubbles\ndata: ${JSON.stringify({companion_bubbles:cached.companion_bubbles??plan.map(item=>item.text),companion_bubble_plan:plan,companion_bubble_count:cached.companion_bubble_count??plan.length,recovered:true})}\n\n`);
  res.write("data: [DONE]\n\n");res.end();return true;
}

async function resumeRecoveredChatTurn({res,body,ctx,session,record,idemKey}){
  const plan=Array.isArray(record?.plan)?record.plan:[];if(!plan.length)return false;
  const committed=[...(record.committed??[])].sort((a,b)=>a.bubble_index-b.bubble_index);
  const start=Math.min(plan.length,committed.length);
  if(body.stream)res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",connection:"keep-alive","x-accel-buffering":"no"});
  const sequence=await deliverBubbleSequence({
    sessionId:session.id,source:ctx.source,bubblePlan:plan,generationRoute:plan[0]?.generation_route??"recovered",turnId:record.turn_id,resumeFrom:start,
    onTrace:(stage,data)=>traceBubble(stage,data),
    onDelivered:async({messageId,index,count,text,plan:planItem})=>{
      turnRecovery.noteCommit(record.turn_id,{bubbleIndex:index,messageId});
      if(body.stream&&!res.destroyed)writeBubbleSse({res,model:ctx.publicModel,messageId,index,count,text,plan:planItem});
    }
  });
  const updated=turnRecovery.get(record.turn_id),ids=new Map((updated?.committed??[]).map(item=>[Number(item.bubble_index),Number(item.message_id)]));
  const deliveredPlan=plan.map((item,index)=>({...item,message_id:ids.get(index)??sequence.messages.find(message=>message.index===index)?.messageId??null}));
  turnRecovery.transition(record.turn_id,"COMMITTED");
  const completion={id:`companion-recovered-${record.generation_id}`,object:"chat.completion",model:ctx.publicModel,choices:[{index:0,message:{role:"assistant",content:plan[0]?.text??""},finish_reason:"stop"}],companion_bubbles:plan.map(item=>item.text),companion_bubble_plan:deliveredPlan,companion_bubble_count:plan.length,companion_recovered:true};
  if(idemKey)putIdempotentResponse(session.id,idemKey,completion);
  if(body.stream){if(!res.destroyed){res.write(`event: companion.bubbles\ndata: ${JSON.stringify({companion_bubbles:completion.companion_bubbles,companion_bubble_plan:deliveredPlan,companion_bubble_count:plan.length,recovered:true})}\n\n`);res.write("data: [DONE]\n\n");res.end();}return true;}
  json(res,200,completion);return true;
}

async function parseChatJsonResilient({initialResponse,request,turnId,generationId,requestId,signal}){
  let response=initialResponse;
  for(let attempt=1;attempt<=config.networkRetryAttempts;attempt++){
    try{return {response,json:await response.json(),attempts:attempt};}
    catch(error){
      if(signal?.aborted)throw error;
      if(attempt>=config.networkRetryAttempts)throw Object.assign(error,{statusCode:502,code:"UPSTREAM_INVALID_OR_TRUNCATED_JSON"});
      const delay=Math.min(2000,attempt===1?400:1000);
      networkLog({phase:"upstream_body",provider:"llm",turnId,generationId,requestId,errorClass:"connection_interrupted",retryable:true,attempt,backoffMs:delay});
      await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,delay);const abort=()=>{clearTimeout(timer);reject(Object.assign(new Error("cancelled"),{name:"AbortError"}));};if(signal?.aborted)return abort();signal?.addEventListener?.("abort",abort,{once:true});});
      response=await request();
      if(!response.ok)return {response,json:null,attempts:attempt+1};
    }
  }
  return {response,json:null,attempts:config.networkRetryAttempts};
}

function clientUpstreamErrorMessage(e){
  const raw=String(e?.message??"").trim();
  if(!raw)return "上游暂时不可用，请稍后重试";
  try{
    const parsed=JSON.parse(raw);
    const nested=parsed?.error?.message??parsed?.message;
    if(typeof nested==="string"&&nested.trim())return nested.trim();
  }catch{}
  if(e?.code==="UPSTREAM_CIRCUIT_OPEN"||/circuit open/i.test(raw))return "上游暂时不可用（熔断保护中），请稍后重试";
  if(/network recovery window exhausted/i.test(raw)||e?.code==="NETWORK_RECOVERY_EXHAUSTED")return "上游暂时不可用，请稍后重试";
  if(/Service temporarily unavailable/i.test(raw))return "上游账号池尚未就绪（常见于冷启动后 OAuth/会话刷新中），请稍后重试";
  if(/Concurrency limit exceeded/i.test(raw)||/rate.?limit/i.test(raw))return "上游并发受限，请稍后重试";
  return raw.slice(0,400);
}
function publicAutonomyDecision(decision){return {outcome:decision.outcome,reason:decision.reason,goal_id:decision.goalId??null};}
async function sendAutonomyChatDecision(res,{body,ctx,session,decision,idemKey}){
  const out=compatChatCompletion({type:"final_answer",content:decision.message},ctx.publicModel,null),metadata=publicAutonomyDecision(decision);
  const turnId=`${session.id}:${getPreviousRealInteraction(session.id).user?.id??"autonomy"}`;
  const plan=createBubblePlan([decision.message],{generationRoute:"autonomy_decision",turnId});
  const sequence=await deliverBubbleSequence({sessionId:session.id,source:ctx.source,bubblePlan:plan,generationRoute:"autonomy_decision",turnId,onTrace:(stage,data)=>traceBubble(stage,data)});
  const deliveredPlan=sequence.messages.map((message,index)=>({...plan[index],message_id:message.messageId}));
  out.completion.companion_autonomy=metadata;
  out.completion.companion_bubbles=sequence.messages.map(message=>message.text);
  out.completion.companion_bubble_plan=deliveredPlan;
  out.completion.companion_bubble_count=sequence.messages.length;
  if(!body.stream){if(idemKey)putIdempotentResponse(session.id,idemKey,out.completion);return json(res,200,out.completion);}
  if(res.destroyed)return;res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",connection:"keep-alive","x-accel-buffering":"no"});for(const message of sequence.messages){writeBubbleSse({res,model:ctx.publicModel,messageId:message.messageId,index:message.index,count:sequence.messages.length,text:message.text,plan:plan[message.index],extraPayload:{companion_autonomy:metadata}});}res.write(`event: companion.bubbles\ndata: ${JSON.stringify({companion_bubbles:sequence.messages.map(message=>message.text),companion_bubble_plan:deliveredPlan,companion_bubble_count:sequence.messages.length,companion_autonomy:metadata})}\n\n`);res.write("data: [DONE]\n\n");return res.end();
}
function sendAutonomyResponsesDecision(res,{body,ctx,session,decision,cacheKey}){
  const out=compatResponse({type:"final_answer",content:decision.message},ctx.publicModel,null,body),metadata=publicAutonomyDecision(decision);
  out.response.companion_autonomy=metadata;storeMessage(session.id,ctx.source,out.message);
  if(!body.stream){if(cacheKey)putIdempotentResponse(session.id,cacheKey,out.response);return json(res,200,out.response);}
  if(res.destroyed)return;res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",connection:"keep-alive","x-accel-buffering":"no"});sendCompatResponseSse(res,out);return res.end();
}

async function processCompatChat(req,res,body,ctx,session,injected,idemKey,retryFingerprint){
  const controller=new AbortController(),onClose=()=>{if(!res.writableEnded)controller.abort();};res.once("close",onClose);
  const routeKey=agentRouteKey(session),continuation=isToolContinuation("chat",body);prepareAgentProviderRoute(routeKey,continuation,continuation?getLastAgentUsageProvider(session.id):null);
  let result;try{result=await runCompatDecision({body,messages:injected,ctx,session,signal:controller.signal,routeKey,turnFingerprint:rawTurnFingerprint("chat",body)});}catch(e){res.off("close",onClose);if(e?.name==="AbortError"||res.destroyed)return;if(e.compatCategory)rememberCompatFailure(retryFingerprint,e.compatCategory);const status=e?.name==="TimeoutError"?504:(e.statusCode??502);return json(res,status,{error:{message:e?.name==="TimeoutError"?"upstream timeout":e.message,type:"upstream_error"}});}
  if(result.upstreamError){res.off("close",onClose);const up=result.upstreamError,text=redactSecrets(await up.text());res.writeHead(up.status,{"content-type":up.headers.get("content-type")??"text/plain; charset=utf-8"});return res.end(text);}
  const out=compatChatCompletion(result.decision,ctx.publicModel,result.usage);storeMessage(session.id,ctx.source,out.message);maybeScheduleSummary(session.id);
  if(!body.stream){if(idemKey)putIdempotentResponse(session.id,idemKey,out.completion);res.off("close",onClose);return json(res,200,out.completion);}
  if(res.destroyed){res.off("close",onClose);return;}res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",connection:"keep-alive","x-accel-buffering":"no"});sendCompatChatSse(res,out);res.off("close",onClose);res.end();
}

async function processCompatResponses(req,res,body,ctx,session,injected,cacheKey,retryFingerprint){
  const controller=new AbortController(),onClose=()=>{if(!res.writableEnded)controller.abort();};res.once("close",onClose);
  const messages=responsesInputToMessages(injected),routeKey=agentRouteKey(session),continuation=isToolContinuation("responses",body);prepareAgentProviderRoute(routeKey,continuation,continuation?getLastAgentUsageProvider(session.id):null);let result;
  try{result=await runCompatDecision({body,messages,ctx,session,signal:controller.signal,routeKey,turnFingerprint:rawTurnFingerprint("responses",body)});}catch(e){res.off("close",onClose);if(e?.name==="AbortError"||res.destroyed)return;if(e.compatCategory)rememberCompatFailure(retryFingerprint,e.compatCategory);const status=e?.name==="TimeoutError"?504:(e.statusCode??502);return json(res,status,{error:{message:e?.name==="TimeoutError"?"upstream timeout":e.message,type:"upstream_error"}});}
  if(result.upstreamError){res.off("close",onClose);const up=result.upstreamError,text=redactSecrets(await up.text());res.writeHead(up.status,{"content-type":up.headers.get("content-type")??"text/plain; charset=utf-8"});return res.end(text);}
  const out=compatResponse(result.decision,ctx.publicModel,result.usage,body);storeMessage(session.id,ctx.source,out.message);maybeScheduleSummary(session.id);
  if(!body.stream){if(cacheKey)putIdempotentResponse(session.id,cacheKey,out.response);res.off("close",onClose);return json(res,200,out.response);}
  if(res.destroyed){res.off("close",onClose);return;}res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",connection:"keep-alive","x-accel-buffering":"no"});sendCompatResponseSse(res,out);res.off("close",onClose);res.end();
}


function emitIncomingToolResults(kind,body,session){
  try{
    const items=kind==="responses"?(Array.isArray(body?.input)?body.input:[]):(body?.messages??[]);
    for(const item of items){
      if(item?.role!=="tool"&&item?.type!=="function_call_output")continue;
      const callId=String(item.tool_call_id??item.call_id??"");
      const output=item.output??item.content??"";
      const call=findSessionToolCall(session.id,callId);
      const name=String(call?.function?.name??call?.name??item.name??"unknown");
      publishEvent("tool.completed",{callId,name,source:"client",output_preview:String(output??"").slice(0,200),output_chars:String(output??"").length},{sessionId:session.id});
    }
  }catch{}
}

async function processChat(req,res,body,ctx,session){
  if(res.destroyed)return;
  const idemKey=cleanKey(h(req,"idempotency-key")??h(req,"x-companion-request-id")??"","",200);
  const requestRecovery=idemKey?turnRecovery.findByRequest(session.id,idemKey):null;
  const recoveryIncomplete=Boolean(requestRecovery?.plan?.length&&Number(requestRecovery?.committed?.length??0)<requestRecovery.plan.length);
  if(recoveryIncomplete&&requestRecovery.state!=="FAILED"&&requestRecovery.state!=="CANCELLED"){
    return resumeRecoveredChatTurn({res,body,ctx,session,record:requestRecovery,idemKey});
  }
  if(idemKey){const cached=getIdempotentResponse(session.id,idemKey);if(cached)return body.stream?sendCachedChatResponse(res,cached,ctx.publicModel):json(res,200,cached);}
  if(requestRecovery?.plan?.length&&requestRecovery.state!=="FAILED"&&requestRecovery.state!=="CANCELLED"){
    return resumeRecoveredChatTurn({res,body,ctx,session,record:requestRecovery,idemKey});
  }
  const retryFingerprint=ctx.mode==="agent"&&config.agentToolMode==="compat"?compatRetryFingerprint("chat",session.id,body):null,guarded=guardedCompatFailure(retryFingerprint);if(guarded)return sendGuardedCompatFailure(res,guarded);

  const sessionBefore=getSession(session.id);
  const includeStored=ctx.mode==="agent"?config.agentIncludeStoredRecent:config.chatIncludeStoredRecent;
  const recentLimit=ctx.mode==="agent"?config.agentStoredRecentMessages:config.chatStoredRecentMessages;
  const storedRecent=includeStored?listRecentMessagesAfter(session.id,sessionBefore?.summary_through_message_id??0,recentLimit):[];

  const previousInteraction=getPreviousRealInteraction(session.id);
  const previousAssistantText=previousInteraction.assistant
    ?listRecentMessagesAfter(session.id,previousInteraction.assistant.id-1,1).find(message=>Number(message.id)===Number(previousInteraction.assistant.id))?.content??""
    :"";
  const appended=appendIncomingMessagesDetailed(session.id,ctx.source,incomingTail(body.messages));
  const currentUser=[...appended.messages].reverse().find(message=>message.role==="user"&&message.contentText.trim())??(idemKey?previousInteraction.user:null),currentUserText=currentUser?.contentText??"";
  const nonTextUser=[...appended.messages].reverse().find(message=>message.role==="user"&&!message.contentText.trim());
  if(nonTextUser)touchUserInteraction(nonTextUser.createdAt);
  const stableTurnId=currentUser?`${session.id}:${currentUser.id}`:null;
  const existingRecovery=stableTurnId?turnRecovery.get(stableTurnId):null;
  if(existingRecovery?.plan?.length&&existingRecovery.state!=="FAILED"&&existingRecovery.state!=="CANCELLED"){
    return resumeRecoveredChatTurn({res,body,ctx,session,record:existingRecovery,idemKey});
  }
  const recovery=stableTurnId?turnRecovery.begin({turnId:stableTurnId,sessionId:session.id,userMessageId:currentUser.id,requestId:idemKey||null,source:ctx.source}):null;
  if(stableTurnId)turnRecovery.transition(stableTurnId,"GENERATING");
  let autonomyDecision=null;
  let recurrence=null;
  let skipDup=false;
  if(currentUserText){
    localGPTSoVITSService.cancel();
    observeUserActivity(currentUserText);
    recurrence=detectAndRecordUtterance({text:currentUserText,messageId:currentUser.id,sessionId:session.id,at:new Date(currentUser.createdAt)});
    skipDup=Boolean(recurrence?.skipSideEffects);
    if(recurrence?.kind&&recurrence.kind!=="NEW")console.log("[recurrence]",JSON.stringify({kind:recurrence.kind,confidence:recurrence.confidence,skipSideEffects:skipDup,matchId:recurrence.match?.message_id??null,ago:recurrence.age_hours??null}));
    contactSuppression.observeUser({text:currentUserText,messageId:currentUser.id,at:new Date(currentUser.createdAt),armLeave:!skipDup});
    temporalContextStore.observe({sessionId:session.id,text:currentUserText,sourceMessageId:currentUser.id,at:new Date(currentUser.createdAt)});
    if(!skipDup)observeRecentEpisode({text:currentUserText,role:"user",messageId:currentUser.id,sessionId:session.id,at:new Date(currentUser.createdAt)});
    autonomousLife.recordInteraction({text:currentUserText,sessionId:session.id,at:new Date(currentUser.createdAt)});
    naturalPresence.observeInteraction({text:currentUserText,sessionId:session.id,at:new Date(currentUser.createdAt)});
    if(!skipDup&&naturalPresence.enabled&&ctx.mode==="chat"){
      const previousTexts=listRecentMessagesAfter(session.id,0,8)
        .filter(message=>message.role==="user"&&message.id!==currentUser.id)
        .map(message=>typeof message.content==="string"?message.content:"");
      naturalPresence.appraiseUserEmotion({text:currentUserText,messageId:currentUser.id,
        at:new Date(currentUser.createdAt),recentUserTexts:previousTexts,
        expectations:naturalCognition.enabled?naturalCognition.document.expectations:[]});
    }
    const cognitionTurn=onUserMessage({text:currentUserText,sessionId:session.id,at:new Date(currentUser.createdAt),sourceMessageId:currentUser.id,previousAssistantText});
    const changedExpectationIds=[...(cognitionTurn?.resolvedExpectationIds??[]),...(cognitionTurn?.cancelledExpectationIds??[]),...(cognitionTurn?.violatedExpectationIds??[]),...(cognitionTurn?.createdExpectation?.id?[cognitionTurn.createdExpectation.id]:[])];
    const expectationTransitions=[...new Set(changedExpectationIds)].map(id=>naturalCognition.document.expectations.find(expectation=>expectation.id===id)).filter(Boolean);
    if(expectationTransitions.length){try{createExpectationTransitionEvents({personaId:ctx.personaId,sessionId:session.id,sourceMessageId:currentUser.id,text:currentUserText,transitions:expectationTransitions});}catch(error){console.warn("[event-association] expectation event skipped",String(error?.message??error).slice(0,120));}}
    autonomyDecision=autonomousLife.decideRequest({text:currentUserText});
    if(autonomyDecision.outcome==="ACCEPT"){
      if(!skipDup)maybeExtractFollowup(currentUserText,session.id);
      if(!skipDup)observeUserTurnForMemory(session,currentUserText,currentUser.id);
    }
  }
  if(autonomyDecision&&autonomyDecision.outcome!=="ACCEPT")return await sendAutonomyChatDecision(res,{body,ctx,session,decision:autonomyDecision,idemKey});
  const timeContext=buildTimeContext({currentUserAt:currentUser?.createdAt,previousUser:previousInteraction.user,previousAssistant:previousInteraction.assistant,activity:temporalContextStore.current(session.id)});
  const presenceBlock=presenceContext();
  const cognitionBlock=cognitionContextBlock();
  const diaryBlock=ctx.mode==="chat"?diaryContextBlock(currentUserText):"";
  const episodeBlock=ctx.mode==="chat"?episodeContextBlock():"";
  const acknowledgedFacts=ctx.mode==="chat"?recentEpisodes.list().filter(e=>!e.stale).map(e=>e.fact).filter(Boolean):[];
  const recurrenceBlock=ctx.mode==="chat"?recurrenceContextBlock(recurrence,new Date(),{acknowledgedFacts}):"";
  const autonomyContext=[autonomousLife.contextBlock(autonomyDecision),presenceBlock,cognitionBlock,diaryBlock,episodeBlock,recurrenceBlock].filter(Boolean).join("\n\n");
  // Conversation Grounding: classify before generation; inject clarification guidance.
  let groundingState=loadGrounding(session.id);
  if(!groundingState)groundingState=defaultGrounding();
  const recentForGround=listRecentMessagesAfter(session.id,0,8);
  const lastAssistantText=[...recentForGround].reverse().find(m=>m.role==="assistant"&&typeof m.content==="string"&&m.content.trim())?.content??"";
  let repairResult=null;
  if(ctx.mode==="chat"&&currentUserText){
    repairResult=processUserRepair({
      sessionId:session.id,userText:currentUserText,lastAssistantText,groundingState,
      focusTopics:naturalCognition.focusList().map(f=>f.topic),
      presenceLabels:naturalPresence.enabled?naturalPresence.labels():[],
      personaId:ctx.personaId,messageId:currentUser?.id
    });
    if(repairResult?.grounding)groundingState=repairResult.grounding;
    if(repairResult?.detected&&repairResult.record?.corrected_interpretation){
      updateFocusFromTurn({activeTopic:repairResult.record.corrected_interpretation});
    }
  }
  const activeRepair=repairResult?.detected?repairResult.record:currentRepair(session.id);
  const groundingClass=currentUserText?classifyGrounding({
    userText:currentUserText,
    activeTopic:groundingState.active_topic,
    recentTopics:groundingState.recent_topics??[],
    recentReferents:groundingState.recent_referents??[],
    bindings:groundingState.bindings??{},
    openLoops:naturalPresence.enabled?naturalPresence.document.open_loops.filter(l=>!l.resolved):[],
    recentUserTexts:recentForGround.filter(m=>m.role==="user").map(m=>typeof m.content==="string"?m.content:"").slice(-4),
    repair:activeRepair
  }):null;
  const turnGroundingState=ctx.mode==="chat"&&config.conversationGroundingEnabled&&groundingClass
    ?applyGroundingTurn(groundingState,groundingClass,currentUserText)
    :null;
  if(groundingClass?.relation==="SHIFT_CLEAR"&&!repairResult?.detected)expireRepairOnShift(session.id);
  const groundingBlock=groundingGuidanceBlock(groundingClass,groundingState);
  const repairBlock=repairResult?.guidance||(activeRepair?repairGuidanceBlock(activeRepair,naturalPresence.enabled?naturalPresence.labels():[]):"");
  const userModality=currentUser?.voice_message||currentUser?.voice_asset?"voice":"text";
  let injected=await buildInjectedMessages({persona:requirePersona(ctx.personaId),ctx,sessionId:session.id,clientMessages:body.messages,storedRecent,autonomyContext: [autonomyContext,groundingBlock,repairBlock].filter(Boolean).join("\n\n"),timeContext,memorySuppressTopics:activeRepair?.suppressTopics??[],currentMessageId:currentUser?.id??null});
  const resourceCallIds=new Map();
  const localResources=await hydrateLocalResources(injected,currentUserText,{onActivity:activity=>{
    const meta=activityMetadata(activity.name,{path:activity.path},"native");
    if(!resourceCallIds.has(activity.path))resourceCallIds.set(activity.path,`resource_${Date.now()}_${resourceCallIds.size}`);
    publishEvent(activity.status==="running"?"tool.started":activity.status==="failed"?"tool.failed":"tool.completed",{callId:resourceCallIds.get(activity.path),name:activity.name,source:"native",status:activity.status,activity:meta,turnId:stableTurnId},{sessionId:session.id});
  }});
  injected=localResources.messages;
  const speechContext=body?.metadata?.speechContext;
  if(speechContext&&typeof speechContext==="object"){
    const ephemeral={language:String(speechContext.language??"").slice(0,16),emotion:String(speechContext.emotion??"").slice(0,32),audio_events:Array.isArray(speechContext.audio_events)?speechContext.audio_events.slice(0,8).map(x=>String(x).slice(0,40)):[],prosody:speechContext.prosody&&typeof speechContext.prosody==="object"?speechContext.prosody:{}};
    injected=[{role:"system",content:`[Ephemeral speech context — uncertain and low weight. Spoken words are authoritative; never mention this metadata.] ${JSON.stringify(ephemeral)}`},...injected];
  }
  const screenContext=body?.metadata?.screenContext;
  if(screenContext&&typeof screenContext==="object"){
    injected=[{role:"system",content:`[Ephemeral current-screen context — runtime only, not memory. User question is authoritative.] ${JSON.stringify({summary:String(screenContext.summary??"").slice(0,400),frontmost:String(screenContext.frontmost??"").slice(0,80)})}`},...injected];
  }
  if(/(?:语音|开口|说给我听|念给我听|朗读|\btts\b|\bvoice\b|\bspeak\b)/i.test(currentUserText)){
    injected=[{role:"system",content:voiceAvailabilityGuidance()},...injected];
  }
  if(ctx.resumeTask)injected.push(agentTasks.resumeObservation(ctx.resumeTask));
  const agentAutonomousContext=ctx.mode==="agent"&&normalizeCompatTools(body.tools).length===0&&body.tool_choice!=="none"?buildAutonomousContext(ctx.resumeTask?[{role:"user",content:ctx.resumeTask.prompt}]:body.messages,ctx.workspaceRoot):null;
  if(agentAutonomousContext?.guidance&&!(agentAutonomousContext.tools?.length)){injected=[{role:"system",content:agentAutonomousContext.guidance},...injected];}
  if(ctx.mode==="agent"&&config.agentToolMode==="compat"&&!(agentAutonomousContext?.tools?.length)){emitIncomingToolResults("chat",body,session);return processCompatChat(req,res,body,ctx,session,injected,idemKey,retryFingerprint);}

  // Native Agent requests without client-owned tools must use the same bounded
  // autonomous capability loop as daily Chat. Previously they bypassed it and
  // went straight upstream, so a healthy local Cua runtime was invisible to
  // the model and could be falsely reported as unavailable.
  if(ctx.mode==="agent"&&normalizeCompatTools(body.tools).length===0&&body.tool_choice!=="none"){
    const autonomousContext=agentAutonomousContext;
    if(autonomousContext?.tools?.length){
      const mcpCaps=selectMcpCapabilities(mcpRegistry.agentCapabilities(),injected,{limit:config.agentToolCandidateLimit});
      const scopedInjected=[{role:"system",content:autonomousContext.guidance},...injected];
      const selection=selectCompatToolCandidates(mcpCaps.map(capabilityToCompatTool),scopedInjected,"auto",{target:config.agentToolCandidateLimit});
      const controller=new AbortController(),onClose=()=>{if(!res.writableEnded&&!sessionPermissions.hasPending(session.id))controller.abort();};
      res.once("close",onClose);
      return processChatWithCoreTools({req,res,body,ctx,session,injected:scopedInjected,idemKey,controller,onClose,webSearchActive:false,mcpChatTools:selection.tools.filter(tool=>tool.source==="mcp"),autonomousContext,actionIntent:selection.actionIntent,matchingTools:selection.matchingTools,currentUserText,sourceMessageId:currentUser?.id??null,groundingState:turnGroundingState,compatModel:config.agentToolMode==="compat",turnId:stableTurnId});
    }
  }

  // daily chat：web 联网（显式开关）+ 用户显式授权的 MCP chat 工具。
  // 默认 daily chat 没有 MCP 工具（integration 需 availableToChat=true 才进入）。
  if(ctx.mode==="chat"){
    const webSearchActive=body?.metadata?.webEnabled===true&&searchStatus(config).configured;
    const mcpChatCaps=selectMcpCapabilities(mcpRegistry.chatCapabilities(),injected,{limit:config.agentToolCandidateLimit});
    const browserGuidance=browserCapabilityGuidance({selectedCapabilities:mcpChatCaps,knownCapabilities:mcpRegistry.allCapabilities(),messages:injected});
    const autonomousContext=buildAutonomousContext(ctx.resumeTask?[{role:"user",content:ctx.resumeTask.prompt}]:body.messages,ctx.workspaceRoot);
    const scopeGuidance=[browserGuidance,autonomousContext?.guidance].filter(Boolean).join("\n\n");
    const toolAwareInjected=scopeGuidance?[{role:"system",content:scopeGuidance},...injected]:injected;
    const dailyRegistry=buildCapabilityRegistry({coreTools:webSearchActive?[WEB_SEARCH_TOOL_SPEC(config.webSearchMaxResults)]:[],mcpCapabilities:mcpChatCaps});
    const dailySelection=selectCompatToolCandidates(dailyRegistry.map(capabilityToCompatTool),toolAwareInjected,"auto",{target:config.agentToolCandidateLimit});
    const mcpChatTools=dailySelection.tools.filter(tool=>tool.source==="mcp");
    // Daily chat must stay on Natural Messaging. Only divert to core tools when
    // the client/turn actually needs tools — not merely because casual text
    // matched a local-dev intent (e.g. 「测试」 in "测试是假的别生气").
    const clientWantsTools=Array.isArray(body.tools)&&body.tools.length>0;
    const shouldDivertChatToTools=webSearchActive||mcpChatTools.length>0||clientWantsTools||
      (body.tool_choice!=="none"&&(autonomousContext?.tools?.length??0)>0&&(autonomousContext?.agentV1||autonomousContext?.computerUseRequested||Boolean(body.tool_choice)));
    if(shouldDivertChatToTools){
      console.log("[chat-route]",JSON.stringify({path:"core_tools",webSearchActive,mcp:mcpChatTools.length,clientTools:clientWantsTools,autoTools:autonomousContext?.tools?.length??0}));
      const controller=new AbortController(),onClose=()=>{if(!res.writableEnded&&!sessionPermissions.hasPending(session.id))controller.abort();};
      res.once("close",onClose);
      return processChatWithCoreTools({req,res,body,ctx,session,injected:toolAwareInjected,idemKey,controller,onClose,webSearchActive,mcpChatTools,autonomousContext,actionIntent:dailySelection.actionIntent,matchingTools:dailySelection.matchingTools,currentUserText,sourceMessageId:currentUser?.id??null,groundingState:turnGroundingState,skipPresenceLoops:skipDup,turnId:stableTurnId});
    }
    if(scopeGuidance)injected=toolAwareInjected;
    console.log("[chat-route]",JSON.stringify({path:"natural_chat",autoTools:autonomousContext?.tools?.length??0}));
  }

  const controller=new AbortController();
  const useNatural=naturalMessagingEnabled()&&ctx.mode==="chat";
  let responsePolicy=null;
  let responsePolicyEpisodes=[];
  if(useNatural){
    const presenceForPolicy=naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null;
    const closureForPrompt=skipDup?{likely:false,strength:"none",kind:null,reasons:["recurrence_skip"]}:detectClosure({userText:currentUserText,presence:presenceForPolicy});
    const closureBlock=closureGuidanceBlock(closureForPrompt);
    responsePolicyEpisodes=recentEpisodes.list();
    const recentAssistantTexts=recentForGround.filter(item=>item.role==="assistant").map(item=>typeof item.content==="string"?item.content:"").filter(Boolean);
    responsePolicy=selectNaturalResponsePolicy({
      userText:currentUserText,closure:closureForPrompt,grounding:groundingClass,recurrence,
      presence:presenceForPolicy,
      recentAssistantTexts,
      recentImpulses:recentResponseActs(session.id),
      recentEpisodes:responsePolicyEpisodes,
      openLoops:naturalPresence.enabled?naturalPresence.document.open_loops.filter(item=>!item.resolved):[],
      expectations:naturalCognition.enabled?naturalCognition.activeExpectations().filter(item=>item.state==="pending"):[]
    });
    console.log("[response-act-select]",JSON.stringify({impulse:responsePolicy.impulse,primary_act:responsePolicy.primaryAct,secondary_act:responsePolicy.secondaryAct,selective_attention:responsePolicy.selectiveAttention,focus_point:responsePolicy.focusPoint,context_disposition:responsePolicy.contextDisposition,reason:responsePolicy.reason,avoid_posture:responsePolicy.avoidPosture,repeated_structure:responsePolicy.repeatedStructure,background:responsePolicy.background}));
    injected=[
      {role:"system",content:NATURAL_MESSAGING_SYSTEM},
      ...injected,
      {role:"system",content:[naturalResponsePolicyBlock(responsePolicy),naturalRecentExpressionBlock(responsePolicy),emotionExpressionBlock(naturalPresence.document.emotion_state,responsePolicy.primaryAct),skipDup?recurrenceBlock:"",closureBlock].filter(Boolean).join("\n\n")}
    ];
  }
  const routeKey=ctx.mode==="agent"?agentRouteKey(session):"";if(routeKey){const continuation=isToolContinuation("chat",body);prepareAgentProviderRoute(routeKey,continuation,continuation?getLastAgentUsageProvider(session.id):null);}
  const onClose=()=>{if(!res.writableEnded)controller.abort();};
  res.once("close",onClose);
  // Natural Messaging needs the full model payload before splitting bubbles.
  // Force non-stream upstream even when the client asked for SSE.
  const upstreamBody=useNatural?{...body,stream:false}:body;
  let up;
  try{up=await upstreamChat(upstreamBody,injected,ctx.mode,controller.signal,{lockKey:routeKey,phase:"llm_generation",turnId:stableTurnId,generationId:recovery?.generation_id,requestId:idemKey});}catch(e){
    res.off("close",onClose);
    if(e?.name==="AbortError"||res.destroyed)return;
    const failure=e?.networkFailure??classifyNetworkFailure({error:e}),status=failure.errorClass==="timeout"||e?.name==="TimeoutError"?504:(Number(e?.statusCode)||502);
    if(stableTurnId){failure.retryable?turnRecovery.noteRetry(stableTurnId):turnRecovery.transition(stableTurnId,"FAILED",{error_class:failure.errorClass});}
    if(process.env.COMPANION_DEBUG_STACK)console.error("[dbg-stack]",e?.stack);
    return json(res,status,{error:{message:e?.name==="TimeoutError"?"upstream timeout":clientUpstreamErrorMessage(e),type:"upstream_error",code:e?.code??null,upstream_status:Number(e?.statusCode)||null}});
  }
  const upInfo=upstreamResponseInfo(up),upModel=usageUpstreamModel(upInfo);
  if(!up.ok){
    res.off("close",onClose);
    if(stableTurnId){const failure=classifyNetworkFailure({status:up.status,headers:up.headers});failure.retryable?turnRecovery.noteRetry(stableTurnId):turnRecovery.transition(stableTurnId,"FAILED",{error_class:failure.errorClass});}
    const hasImage=(injected??[]).some(m=>Array.isArray(m?.content)&&m.content.some(p=>String(typeof p?.image_url==="string"?p.image_url:p?.image_url?.url??"").match(/^(?:companion-media:\/\/|data:image\/)/)));
    if(hasImage&&[400,404,415,422].includes(up.status))return json(res,422,{error:{message:"当前上游模型不支持图片理解，图片未发送成功。",type:"vision_not_supported",code:"vision_not_supported"}});
    const text=redactSecrets(await up.text());res.writeHead(up.status,{"content-type":up.headers.get("content-type")??"text/plain; charset=utf-8"});return res.end(text);
  }

  const presenceSnapshot=naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null;
  // Exclude the current user turn so "repeat urgency" only looks at prior messages.
  const recentUserTexts=listRecentMessagesAfter(session.id,0,12)
    .filter(x=>x.role==="user"&&(currentUser?.id==null||Number(x.id)!==Number(currentUser.id)))
    .map(x=>typeof x.content==="string"?x.content:"")
    .filter(Boolean)
    .slice(-4);
  const userInterrupted=()=>{
    const latest=getPreviousRealInteraction(session.id).user;
    const cur=currentUser;
    return Boolean(latest&&cur&&Number(latest.id)>Number(cur.id));
  };
  const firstLatencyPlan=useNatural?planFirstReplyLatency({
    userText:currentUserText,
    recentUserTexts,
    presence:presenceSnapshot,
    source:ctx.source,
    modality:userModality,
    seed:`${session.id}|${currentUser?.id??""}`
  }):null;
  const closureDecision=skipDup?{likely:false,strength:"none",kind:null,reasons:["recurrence_skip"]}:detectClosure({userText:currentUserText,presence:presenceSnapshot});
  if(firstLatencyPlan?.enabled)console.log("[reply-latency]",JSON.stringify(replyLatencyDebugLine(firstLatencyPlan)));
  if(closureDecision.likely)console.log("[closure]",JSON.stringify({strength:closureDecision.strength,kind:closureDecision.kind,reasons:closureDecision.reasons}));

  if(!body.stream){
    let j;try{const parsed=await parseChatJsonResilient({initialResponse:up,request:()=>upstreamChat(upstreamBody,injected,ctx.mode,controller.signal,{lockKey:routeKey,phase:"llm_generation",turnId:stableTurnId,generationId:recovery?.generation_id,requestId:idemKey}),turnId:stableTurnId,generationId:recovery?.generation_id,requestId:idemKey,signal:controller.signal});up=parsed.response;j=parsed.json;if(!up.ok||!j)throw Object.assign(new Error(`upstream ${up.status}`),{statusCode:up.status});}catch{if(routeKey)finishAgentProviderRoute(routeKey,false);res.off("close",onClose);if(stableTurnId)turnRecovery.noteRetry(stableTurnId);return json(res,502,{error:{message:"upstream returned invalid JSON",type:"upstream_error"}});}
    if(j&&typeof j==="object")j.model=ctx.publicModel;
    const m=j?.choices?.[0]?.message;
    if(m){
      const rawContent=typeof m.content==="string"?m.content:"";
      if(useNatural){
        const turnId=`${session.id}:${currentUser?.id??"unknown"}`;
        const enforced=await enforceNaturalResponseCandidate({rawContent,userText:currentUserText,responsePolicy,recentAssistantTexts:recentForGround.filter(item=>item.role==="assistant").map(item=>typeof item.content==="string"?item.content:"").filter(Boolean),recentRealizedActs:recentResponseActs(session.id),ctx,signal:controller.signal});
        const finalized=await finalizeAssistantBubblePlan({rawContent:enforced.rawContent,userText:currentUserText,ctx,controller,generationRoute:"natural_chat",turnId,closureDecision,presence:naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null});
        const plan=finalized.plan;
        turnRecovery.setPlan(turnId,plan);
        // Full turn is complete before any bubble is written.
        const firstWait=await awaitFirstReplyLatency(firstLatencyPlan,{signal:controller.signal,userInterrupted});
        if(firstWait.interrupted||!plan.length){
          if(j?.choices?.[0]?.message)j.choices[0].message.content=plan[0]?.text??"";
          j.companion_bubbles=plan.map(item=>item.text);
          j.companion_bubble_plan=plan;
          j.companion_bubble_count=plan.length;
          j.companion_reply_latency=replyLatencyDebugLine(firstLatencyPlan);
          j.companion_closure=closureDecision.likely?{strength:closureDecision.strength,kind:closureDecision.kind,trimmed:finalized.closureTrimmed}:null;
          j.companion_response_policy=responsePolicyTrace(responsePolicy,plan.map(item=>item.text).join("\n"),responsePolicyEpisodes);
          if(routeKey)finishAgentProviderRoute(routeKey,Boolean(m?.tool_calls?.length));
          if(j?.usage)insertUsage({sessionId:session.id,source:ctx.source,publicModel:ctx.publicModel,upstreamModel:upModel,kind:ctx.mode,usage:j.usage});
          maybeScheduleSummary(session.id);res.off("close",onClose);return json(res,200,j);
        }
        const sequence=await deliverBubbleSequence({
          sessionId:session.id,source:ctx.source,bubblePlan:plan,signal:controller.signal,
          generationRoute:"natural_chat",turnId,
          userModality,enableModality:ctx.mode==="chat",
          enqueueVoice:enqueueVoiceAfterDurable,
          hasUserInterrupted:userInterrupted,
          onTrace:(stage,data)=>traceBubble(stage,data),
          onDelivered:async({messageId,index,textDurableAt})=>{turnRecovery.noteCommit(turnId,{bubbleIndex:index,messageId});traceBubble("text_durable",{messageId,textDurableAt});}
        });
        notePresenceAfterTurn({userText:currentUserText,assistantText:sequence.messages.map(x=>x.text).join("\n"),sessionId:session.id,sourceMessageId:currentUser?.id??null,messageIds:sequence.messages.map(x=>x.messageId),groundingState:turnGroundingState,skipPresenceLoops:skipDup});
        const texts=sequence.messages.map(x=>x.text);
        if(j?.choices?.[0]?.message)j.choices[0].message.content=texts[0]??"";
        j.companion_bubbles=texts;
        j.companion_bubble_plan=sequence.messages.map((message,index)=>({...plan[index],message_id:message.messageId,...(message.voicePlan?{voice_plan:message.voicePlan}:{})}));
        j.companion_bubble_count=texts.length;
        j.companion_modalities=sequence.messages.map(x=>x.modality);
        j.companion_reply_latency=replyLatencyDebugLine(firstLatencyPlan);
        j.companion_closure=closureDecision.likely?{strength:closureDecision.strength,kind:closureDecision.kind,trimmed:finalized.closureTrimmed,interrupted:sequence.interrupted}:null;
        j.companion_response_policy=responsePolicyTrace(responsePolicy,texts.join("\n"),responsePolicyEpisodes,session.id);
        if(!sequence.interrupted&&sequence.messages.length===plan.length)turnRecovery.transition(turnId,"COMMITTED");
        // True post-message follow-up only after primary bubbles are durable.
        if(!sequence.interrupted&&texts.length){
          try{
            const post=await maybeRunPostMessageAfterPrimary({
              body,ctx,session,currentUser,currentUserText,turnId,primaryBubbles:texts,
              closureDecision,controller,userInterrupted,source:ctx.source
            });
            if(post?.delivered&&post.message?.text){
              const all=[...texts,post.message.text];
              j.companion_bubbles=all;
              j.companion_bubble_count=all.length;
              j.companion_bubble_plan=[...j.companion_bubble_plan,{
                bubble_index:1,bubble_count:2,text:post.message.text,
                generation_route:"post_message_followup",turn_id:`${turnId}:pm1`,
                origin:"post_message_followup",message_id:post.message.messageId,
                post_message:{reason_code:post.decision?.reason_code,salience:post.decision?.salience}
              }];
              j.companion_post_message={delivered:true,reason_code:post.decision?.reason_code,salience:post.decision?.salience};
            }else{
              j.companion_post_message={delivered:false,reason:post?.reason??null,decision:post?.decision??null};
            }
          }catch(e){
            j.companion_post_message={delivered:false,reason:"post_message_error",error:String(e?.message??e).slice(0,120)};
          }
        }
      }else{
        const firstWait=await awaitFirstReplyLatency(firstLatencyPlan,{signal:controller.signal,userInterrupted});
        if(firstWait.interrupted){
          if(routeKey)finishAgentProviderRoute(routeKey,Boolean(m?.tool_calls?.length));
          if(j?.usage)insertUsage({sessionId:session.id,source:ctx.source,publicModel:ctx.publicModel,upstreamModel:upModel,kind:ctx.mode,usage:j.usage});
          maybeScheduleSummary(session.id);res.off("close",onClose);return json(res,200,j);
        }
        const prepared=prepareAssistantVoice({userText:currentUserText,assistantText:rawContent});
        const messageId=storeMessage(session.id,ctx.source,{role:"assistant",content:rawContent,reasoning_content:m.reasoning_content??m.reasoning,tool_calls:m.tool_calls,...(prepared.voice_delivery==="tts"?{voice_job:{state:"pending",style:prepared.voice_style}}:{})});
        if(prepared.voice_delivery==="tts")enqueueVoiceAfterDurable({messageId,sessionId:session.id,text:rawContent,style:prepared.voice_style,signal:controller.signal});
        j.companion_voice_delivery=prepared;
        j.companion_message_id=messageId;
        j.companion_reply_latency=replyLatencyDebugLine(firstLatencyPlan);
        notePresenceAfterTurn({userText:currentUserText,assistantText:rawContent,sessionId:session.id,sourceMessageId:currentUser?.id??null,groundingState:turnGroundingState,skipPresenceLoops:skipDup});
      }
    }
    if(routeKey)finishAgentProviderRoute(routeKey,Boolean(m?.tool_calls?.length));
    if(j?.usage)insertUsage({sessionId:session.id,source:ctx.source,publicModel:ctx.publicModel,upstreamModel:upModel,kind:ctx.mode,usage:j.usage});
    if(idemKey)putIdempotentResponse(session.id,idemKey,j);
    maybeScheduleSummary(session.id);res.off("close",onClose);return json(res,200,j);
  }

  // Natural Messaging + client SSE: upstream was forced non-stream; emit real
  // bubbles as separate DB messages and stream them with IM-like pauses.
  if(useNatural&&body.stream){
    res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",connection:"keep-alive","x-accel-buffering":"no"});
    const releaseVoiceSink=registerVoiceReadySink(session.id,(frame)=>{if(!res.destroyed)res.write(frame);});
    res.on("close",releaseVoiceSink);
    let j=null;try{const parsed=await parseChatJsonResilient({initialResponse:up,request:()=>upstreamChat(upstreamBody,injected,ctx.mode,controller.signal,{lockKey:routeKey,phase:"llm_generation",turnId:stableTurnId,generationId:recovery?.generation_id,requestId:idemKey}),turnId:stableTurnId,generationId:recovery?.generation_id,requestId:idemKey,signal:controller.signal});up=parsed.response;j=parsed.json;if(!up.ok||!j)throw Object.assign(new Error(`upstream ${up.status}`),{statusCode:up.status});}catch{
      res.off("close",onClose);
      if(stableTurnId)turnRecovery.noteRetry(stableTurnId);
      if(!res.destroyed){res.write(`data: ${JSON.stringify({error:{message:"upstream returned invalid JSON",type:"upstream_error"}})}\n\ndata: [DONE]\n\n`);res.end();}
      return;
    }
    if(j&&typeof j==="object")j.model=ctx.publicModel;
    const rawContent=typeof j?.choices?.[0]?.message?.content==="string"?j.choices[0].message.content:"";
    const turnId=`${session.id}:${currentUser?.id??"unknown"}`;
    const enforced=await enforceNaturalResponseCandidate({rawContent,userText:currentUserText,responsePolicy,recentAssistantTexts:recentForGround.filter(item=>item.role==="assistant").map(item=>typeof item.content==="string"?item.content:"").filter(Boolean),recentRealizedActs:recentResponseActs(session.id),ctx,signal:controller.signal});
    const finalized=await finalizeAssistantBubblePlan({rawContent:enforced.rawContent,userText:currentUserText,ctx,controller,generationRoute:"natural_chat_stream",turnId,closureDecision,presence:naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null});
    let plan=finalized.plan;
    turnRecovery.setPlan(turnId,plan);
    let interrupted=false;
    if(plan.length){
      const firstWait=await awaitFirstReplyLatency(firstLatencyPlan,{signal:controller.signal,userInterrupted});
      if(firstWait.interrupted){interrupted=true;plan=[];}
    }
    const sequence=await deliverBubbleSequence({
      sessionId:session.id,source:ctx.source,bubblePlan:plan,signal:controller.signal,
      generationRoute:"natural_chat_stream",turnId,
      userModality,enableModality:ctx.mode==="chat",
      enqueueVoice:enqueueVoiceAfterDurable,
      hasUserInterrupted:userInterrupted,
      onTrace:(stage,data)=>traceBubble(stage,data),
      onDelivered:async({messageId,index,count,text,plan:planItem,voicePlan,textDurableAt})=>{
        turnRecovery.noteCommit(turnId,{bubbleIndex:index,messageId});
        if(res.destroyed)return;
        writeBubbleSse({res,model:ctx.publicModel,messageId,index,count,text,plan:planItem,
          extraPayload:voicePlan?{companion_voice_plan:voicePlan}:null});
        traceBubble("text_sse",{messageId,textDurableAt,textSseAt:Date.now()});
      }
    });
    interrupted=interrupted||sequence.interrupted;
    const texts=sequence.messages.map(message=>message.text);
    const deliveredPlan=sequence.messages.map((message,index)=>({...plan[index],message_id:message.messageId,...(message.voicePlan?{voice_plan:message.voicePlan}:{})}));
    if(!sequence.interrupted&&sequence.messages.length===plan.length)turnRecovery.transition(turnId,"COMMITTED");
    let postMessageMeta={delivered:false,reason:sequence.interrupted?"interrupted":"none"};
    // Post-message cognition runs only after primary bubbles are durable + emitted.
    if(!sequence.interrupted&&texts.length&&!res.destroyed){
      try{
        const post=await maybeRunPostMessageAfterPrimary({
          body,ctx,session,currentUser,currentUserText,turnId,primaryBubbles:texts,
          closureDecision,controller,userInterrupted,source:ctx.source,
          onFollowupEmit:async({messageId,index,count,text,plan:planItem})=>{
            if(res.destroyed)return;
            writeBubbleSse({res,model:ctx.publicModel,messageId,index,count,text,plan:planItem});
          }
        });
        if(post?.delivered&&post.message?.text){
          texts.push(post.message.text);
          deliveredPlan.push({
            bubble_index:1,bubble_count:2,text:post.message.text,
            generation_route:"post_message_followup",turn_id:`${turnId}:pm1`,
            origin:"post_message_followup",message_id:post.message.messageId,
            post_message:{reason_code:post.decision?.reason_code,salience:post.decision?.salience}
          });
          postMessageMeta={delivered:true,reason_code:post.decision?.reason_code,salience:post.decision?.salience};
        }else{
          postMessageMeta={delivered:false,reason:post?.reason??null,decision:post?.decision??null};
        }
      }catch(e){
        postMessageMeta={delivered:false,reason:"post_message_error",error:String(e?.message??e).slice(0,120)};
      }
    }
    if(!res.destroyed){
      res.write(`event: companion.bubbles\ndata: ${JSON.stringify({companion_bubbles:texts,companion_bubble_plan:deliveredPlan,companion_bubble_count:texts.length,interrupted,companion_post_message:postMessageMeta,companion_reply_latency:replyLatencyDebugLine(firstLatencyPlan),companion_closure:closureDecision.likely?{strength:closureDecision.strength,kind:closureDecision.kind,trimmed:finalized.closureTrimmed}:null,companion_response_policy:responsePolicyTrace(responsePolicy,texts.join("\n"),responsePolicyEpisodes,session.id)})}\n\n`);
      res.write("data: [DONE]\n\n");
    }
    if(texts.length)notePresenceAfterTurn({userText:currentUserText,assistantText:texts.join("\n"),sessionId:session.id,sourceMessageId:currentUser?.id??null,groundingState:turnGroundingState,skipPresenceLoops:skipDup});
    if(j?.usage)insertUsage({sessionId:session.id,source:ctx.source,publicModel:ctx.publicModel,upstreamModel:upModel,kind:ctx.mode,usage:j.usage});
    if(routeKey)finishAgentProviderRoute(routeKey,false);
    // A disconnected client may stop a multi-bubble plan after bubble 0. Do
    // not cache that partial delivery as a completed idempotent response: the
    // same request ID must re-enter Turn Recovery and commit the remaining
    // bubbles before a terminal response can be cached.
    if(idemKey&&!interrupted&&sequence.messages.length===plan.length)putIdempotentResponse(session.id,idemKey,{id:`companion-${turnId}`,object:"chat.completion",model:ctx.publicModel,choices:[{index:0,message:{role:"assistant",content:texts[0]??""},finish_reason:"stop"}],companion_bubbles:texts,companion_bubble_plan:deliveredPlan,companion_bubble_count:texts.length});
    maybeScheduleSummary(session.id);res.off("close",onClose);res.end();
    return;
  }

  res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",connection:"keep-alive","x-accel-buffering":"no"});
  const releaseVoiceSink=registerVoiceReadySink(session.id,(frame)=>{if(!res.destroyed)res.write(frame);});
  res.on("close",releaseVoiceSink);
  const reader=up.body?.getReader(); if(!reader){res.off("close",onClose);res.end();return;}
  const dec=new TextDecoder();let buf="",text="",reasoning="",usage=null,sawDone=false,sawTerminal=false,streamError=null;const tools=new Map();
  const frame=f=>{
    if(!f.trim())return;
    const lines=f.split(/\r?\n/).filter(x=>x.startsWith("data:")).map(x=>x.slice(5).trim());
    if(!lines.length){if(!res.destroyed)res.write(f+"\n\n");return;}
    const data=lines.join("\n");
    if(data==="[DONE]"){sawDone=true;return;}
    try{
      const j=JSON.parse(data);if(j&&typeof j==="object")j.model=ctx.publicModel;
      const choice=j?.choices?.[0],d=choice?.delta;if(choice?.finish_reason)sawTerminal=true;if(typeof d?.content==="string")text+=d.content;if(typeof d?.reasoning_content==="string")reasoning+=d.reasoning_content;if(typeof d?.reasoning==="string")reasoning+=d.reasoning;
      if(Array.isArray(d?.tool_calls))for(const tc of d.tool_calls)mergeTool(tools,tc);if(j?.usage)usage=j.usage;
      // Final assistant content is held until delivery policy and any voice
      // synthesis have completed. This prevents a voice reply from first
      // appearing as a text message and only later changing presentation.
      if(!res.destroyed&&(Array.isArray(d?.tool_calls)||typeof d?.reasoning_content==="string"||typeof d?.reasoning==="string")){
        const safeDelta={...(d?.role?{role:d.role}:{}),...(Array.isArray(d?.tool_calls)?{tool_calls:d.tool_calls}:{}),...(typeof d?.reasoning_content==="string"?{reasoning_content:d.reasoning_content}:{}),...(typeof d?.reasoning==="string"?{reasoning:d.reasoning}:{})};
        res.write(`data: ${JSON.stringify({...j,choices:[{...choice,delta:safeDelta}]})}\n\n`);
      }
    }catch{if(!res.destroyed)res.write(f+"\n\n");}
  };
  try{
    while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});let match;while((match=buf.match(/\r?\n\r?\n/))){const n=match.index;frame(buf.slice(0,n));buf=buf.slice(n+match[0].length);}}
    buf+=dec.decode();if(buf.trim())frame(buf);
  }catch(e){if(e?.name!=="AbortError"&&!res.destroyed){streamError=e;recordError("upstream_stream",e);console.error("[stream]",redactSecrets(e.message??e,1000));}}
  if(res.destroyed){res.off("close",onClose);return;}
  if(!sawDone&&!sawTerminal&&!streamError)streamError=new Error("upstream SSE ended before terminal frame");
  if(streamError&&!res.destroyed)res.write(`data: ${JSON.stringify({error:{message:"upstream stream interrupted",type:"upstream_error"}})}\n\n`);
  const prepared=streamError?{voice_delivery:"text",reason:"stream_failed"}:prepareAssistantVoice({userText:currentUserText,assistantText:text});
  // A partial upstream stream is transient transport state, never durable chat
  // truth. Persist only after a terminal frame has proved generation complete.
  let streamMessageId=null;
  if(!streamError){
    streamMessageId=storeMessage(session.id,ctx.source,{role:"assistant",content:text,reasoning_content:reasoning||undefined,tool_calls:tools.size?[...tools.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1]):undefined,...(prepared.voice_delivery==="tts"?{voice_job:{state:"pending",style:prepared.voice_style}}:{})});
    notePresenceAfterTurn({userText:currentUserText,assistantText:text,sessionId:session.id,sourceMessageId:currentUser?.id??null,groundingState:turnGroundingState,skipPresenceLoops:skipDup});
  }else if(stableTurnId){turnRecovery.noteRetry(stableTurnId);}
  if(!streamError){
    // Text-first: always emit text content; TTS is async and never hides text.
    if(text)res.write(`data: ${JSON.stringify({id:`companion-final-${Date.now()}`,object:"chat.completion.chunk",model:ctx.publicModel,choices:[{index:0,delta:{role:"assistant",content:text},finish_reason:"stop"}],companion_message_id:streamMessageId})}\n\n`);
    res.write(`event: companion.voice_delivery\ndata: ${JSON.stringify({companion_voice_delivery:prepared})}\n\n`);
    if(prepared.voice_delivery==="tts"&&streamMessageId){
      enqueueVoiceAfterDurable({messageId:streamMessageId,sessionId:session.id,text,style:prepared.voice_style,signal:controller.signal});
    }
  }
  res.write("data: [DONE]\n\n");
  if(routeKey)finishAgentProviderRoute(routeKey,tools.size>0);
  if(usage)insertUsage({sessionId:session.id,source:ctx.source,publicModel:ctx.publicModel,upstreamModel:upModel,kind:ctx.mode,usage});
  maybeScheduleSummary(session.id);res.off("close",onClose);res.end();
}

// daily chat 核心工具路径：强制上游非流式 → 模型可发起工具调用（web_search / 用户授权的 MCP chat 工具）→
// Core 执行并把"不可信外部内容"作为 tool result 回填 → 最多 N 轮 → 最终回复附带来源。
async function processChatWithCoreTools({req,res,body,ctx,session,injected,idemKey,controller,onClose,webSearchActive,mcpChatTools,autonomousContext=null,actionIntent,matchingTools,currentUserText="",sourceMessageId=null,groundingState=null,compatModel=false,skipPresenceLoops=false,turnId=null}){
  if(naturalMessagingEnabled()&&ctx.mode==="chat"){
    const policy=selectNaturalResponsePolicy({userText:currentUserText,presence:naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null,recentEpisodes:recentEpisodes.list()});
    injected=[{role:"system",content:[NATURAL_MESSAGING_SYSTEM,naturalResponsePolicyBlock(policy),naturalRecentExpressionBlock(policy),emotionExpressionBlock(naturalPresence.document.emotion_state,policy.primaryAct)].join("\n\n")},...injected];
  }
  const toolSpec=WEB_SEARCH_TOOL_SPEC(config.webSearchMaxResults);
  const nativeTools=autonomousContext?.tools??[],remainingAfterNative=Math.max(0,(autonomousContext?32:config.agentToolCandidateLimit)-nativeTools.length),includeWeb=webSearchActive&&remainingAfterNative>0,remainingForMcp=Math.max(0,remainingAfterNative-(includeWeb?1:0)),selectedMcp=mcpChatTools.slice(0,remainingForMcp);
  const tools=[...nativeTools,...(includeWeb?[toolSpec]:[]),...selectedMcp.map(t=>({type:"function",function:{name:t.name,description:t.description,parameters:t.parameters}}))];
  const runtimeCapabilities=[...(autonomousContext?.capabilities??[]),...(includeWeb?[{name:"web_search",capabilityId:"core:web_search",sourceType:"core",sourceId:"companion-core",integrationName:"联网搜索",displayName:"web_search",permissions:["read","network"],riskLevel:"low",sideEffect:"none",availability:"available",enabled:true}]:[]),...selectedMcp.map(t=>({...t,integrationName:mcpRegistry.presentationMetadataForWireName(t.name)?.integrationName??"Integration",availability:"available",enabled:true}))];
  let collectedSources=[],aggregateUsage=null,lastUpstreamModel="";
  const wantsStream=body.stream===true;
  if(wantsStream){
    res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",connection:"keep-alive","x-accel-buffering":"no"});
    const releaseVoiceSink=registerVoiceReadySink(session.id,(frame)=>{if(!res.destroyed)res.write(frame);});
    res.on("close",releaseVoiceSink);
  }
  const lifecycle=createAgentLifecycle({onError:failure=>recordError("native_agent_lifecycle",new Error(`${failure.event}:${failure.hookId}:${failure.message}`))});
  const task=ctx.resumeTask?agentTasks.resume(session.id,ctx.resumeTask.id,ctx.workspaceRoot??null):agentTasks.create(session.id,{prompt:currentUserText,workspaceRoot:ctx.workspaceRoot??null});
  const activeTurn=activeTurns.start(session.id,{turnId:turnId??undefined,source:ctx.source,model:ctx.publicModel,native:true});
  publishEvent("agent.started",{source:ctx.source,model:ctx.publicModel,native:true,taskId:task.id,turnId:activeTurn.turnId,status:activeTurn.status},{sessionId:session.id});
  if(wantsStream&&!res.destroyed)res.write(`event: companion.task\ndata: ${JSON.stringify({task_id:task.id,status:task.status})}\n\n`);
  const lifecycleStatus={TurnStarting:"starting",TurnStarted:"streaming",TurnQueued:"continuing",ToolStarted:"tool_running",PermissionRequest:"awaiting_approval",PermissionResolved:"continuing",PostToolUse:"continuing",PostToolUseFailure:"continuing"};
  for(const event of AGENT_LIFECYCLE_EVENTS)lifecycle.on(event,payload=>{const status=lifecycleStatus[event];if(status)activeTurns.update(session.id,activeTurn.turnId,status);publishEvent("agent.lifecycle",{event,step:payload?.step,callId:payload?.callId,capabilityId:payload?.capabilityId,decision:payload?.decision,status:status??activeTurns.current(session.id)?.status},{sessionId:session.id});return event==="PreToolUse"?payload.baseline:undefined;},{id:`core:${event}`,order:-100,policy:"observe"});
  try{
    const result=await runNativeAgent({messages:injected,tools,capabilities:runtimeCapabilities,lifecycle,permissionStore:sessionPermissions,signal:controller.signal,sessionId:session.id,maxSteps:autonomousContext?Math.max(32,config.webSearchToolMaxRounds+3):Math.max(2,config.webSearchToolMaxRounds+1),maxToolCalls:autonomousContext?64:Math.max(4,config.webSearchToolMaxRounds*4),
      finishAtLimit:!autonomousContext,
      onBeforeTool:entry=>agentTasks.before(task,entry),
      computerScreenshot:()=>agentToolsV1.execute("take_screenshot",{},{sessionId:session.id,signal:controller.signal}),
      takeQueuedGuidance:()=>guidanceQueue.consume(session.id),
      authorizedHighRisk:capability=>actionIntent?.actionRequested===true&&(capability?.sourceId==="cua"||(matchingTools??[]).some(tool=>tool.name===capability?.name)),
      callModel:async({messages,toolChoice})=>{
        activeTurns.update(session.id,activeTurn.turnId,"streaming");
        let value;
        if(compatModel){
          const compatibleTools=normalizeCompatTools(tools),forcedIntent=autonomousContext?.computerUseRequested?{actionRequested:true,intents:[{name:"computer_use",score:100,direct:true}],informational:false}:null;
          let prompt=compatMessages(messages,buildToolContractDetails(compatibleTools,toolChoice,forcedIntent).contract,id=>findSessionToolCall(session.id,id)),protocolRetries=0,toolMissRecovered=false;
          while(true){
            const up=await upstreamCompat(body,prompt,controller.signal,{}),upInfo=upstreamResponseInfo(up);lastUpstreamModel=usageUpstreamModel(upInfo);
            if(!up.ok){const error=new Error(redactSecrets(await up.text())||`upstream ${up.status}`);error.statusCode=up.status;throw error;}
            let rawResponse,raw="";try{rawResponse=await up.json();raw=messageText(rawResponse?.choices?.[0]?.message?.content);}catch{}
            if(rawResponse?.usage){aggregateUsage=mergeUsage(aggregateUsage,rawResponse.usage);insertUsage({sessionId:session.id,source:ctx.source,publicModel:ctx.publicModel,upstreamModel:lastUpstreamModel,kind:"native_agent",usage:rawResponse.usage});}
            const parsed=raw?parseToolDecision(raw,compatibleTools,toolChoice,compatibleTools):{ok:false,category:"other",error:"upstream decision content missing"};
            if(parsed.ok){
              const initialComputerDecision=autonomousContext?.computerUseRequested&&toolChoice!=="none"&&!messages.some(message=>message?.role==="tool");
              if(initialComputerDecision&&parsed.decision.type==="final_answer"&&!toolMissRecovered){toolMissRecovered=true;prompt=toolMissRecoveryMessages(messages,compatibleTools,forcedIntent,id=>findSessionToolCall(session.id,id));continue;}
              value=compatChatCompletion(parsed.decision,ctx.publicModel,rawResponse?.usage).completion;break;
            }
            if(protocolRetries<config.agentToolProtocolRetries){protocolRetries++;prompt=repairMessages(messages,compatibleTools,toolChoice,parsed.category,id=>findSessionToolCall(session.id,id));continue;}
            const error=new Error(`upstream tool decision failed validation (${parsed.category}): ${parsed.error}`);error.statusCode=502;throw error;
          }
        }else{
          const recovered=await retryNetworkOperation(async()=>{
            const payload={...body,stream:wantsStream,stream_options:wantsStream?{include_usage:true}:body.stream_options,tools,tool_choice:toolChoice};
            const up=await upstreamChat(payload,messages,ctx.mode,controller.signal,{phase:"llm_generation",turnId:activeTurn.turnId,generationId:turnRecovery.get(activeTurn.turnId)?.generation_id,requestId:idemKey});
            const upInfo=upstreamResponseInfo(up);lastUpstreamModel=usageUpstreamModel(upInfo);
            if(!up.ok){const error=new Error(redactSecrets(await up.text())||`upstream ${up.status}`);error.statusCode=up.status;error.retryAfter=up.headers.get("retry-after");throw error;}
            if(wantsStream)return consumeChatCompletionSse(up,{signal:controller.signal});
            try{return await up.json();}catch{throw Object.assign(new Error("upstream returned invalid JSON"),{statusCode:502});}
          },{
            maxAttempts:config.networkRetryAttempts,maxElapsedMs:config.networkRecoveryWindowMs,signal:controller.signal,
            onAttempt:event=>{if(event.outcome==="retry")networkLog({phase:"upstream_stream",provider:"llm",turnId:activeTurn.turnId,generationId:turnRecovery.get(activeTurn.turnId)?.generation_id,requestId:idemKey,errorClass:event.failure?.errorClass,retryable:true,attempt:event.attempt,backoffMs:event.backoffMs,elapsedMs:event.elapsedMs});}
          });
          value=recovered.value;
          if(value?.usage){aggregateUsage=mergeUsage(aggregateUsage,value.usage);insertUsage({sessionId:session.id,source:ctx.source,publicModel:ctx.publicModel,upstreamModel:lastUpstreamModel,kind:"native_agent",usage:value.usage});}
        }
        return value;
      },
      onAssistant:async message=>{const calls=Array.isArray(message.tool_calls)?message.tool_calls:[],content=typeof message.content==="string"?message.content:"";if(calls.length)storeMessage(session.id,ctx.source,{role:"assistant",content,tool_calls:calls.map(call=>isAgentV1Tool(call.function?.name)?{...call,function:{...call.function,arguments:"{}"}}:call)});if(wantsStream&&!res.destroyed&&calls.length){const delta={role:"assistant",...(content?{content}:{}),tool_calls:calls.map((call,index)=>({index,...call}))};res.write(`data: ${JSON.stringify({id:`companion-step-${Date.now()}`,object:"chat.completion.chunk",model:ctx.publicModel,choices:[{index:0,delta,finish_reason:"tool_calls"}]})}\n\n`);}},
      onToolResult:async (toolMessage,details)=>{agentTasks.after(task,toolMessage,details);storeMessage(session.id,ctx.source,toolMessage);if(wantsStream&&!res.destroyed)res.write(`event: companion.tool_result\ndata: ${JSON.stringify({type:"companion.tool_result",tool_call_id:toolMessage.tool_call_id,status:"completed"})}\n\n`);},
      executeTool:async({call,capability,args,permission})=>{
        const callName=capability.name,isAutonomous=isAgentV1Tool(callName)||callName==="capabilities_discover"||callName==="capabilities_install"||callName===VOICE_TOOL_NAME||callName.startsWith("computer_")||isLocalAgentToolName(callName)||isDeveloperOperationToolName(callName)||isSelfMaintenanceToolName(callName)||isPackageOperationToolName(callName);
        const source=callName==="web_search"?"core":isAutonomous?"native":"mcp",baseActivity=activityMetadata(callName,args,source);
        publishEvent("tool.started",{callId:call.id??"",name:callName,source,activity:baseActivity,turnId:activeTurn.turnId},{sessionId:session.id});
        let content,results=[],succeeded=true,failure=null,toolOutcome=null;
        try{
          if(isAgentV1Tool(callName)){
            toolOutcome=await agentToolsV1.execute(callName,args,{workspaceRoot:autonomousContext?.workspaceRoot,paths:autonomousContext?.paths,sessionId:session.id,signal:controller.signal,approval:permission?.approval});
            succeeded=toolOutcome.ok!==false;content=toolOutcome.durableContent;
          }else if(callName==="web_search"){
            turnRecovery.transition(activeTurn.turnId,"TOOL_WAIT");
            const outcome=await executeWebSearchTool(config,args,{sessionId:session.id,source:ctx.source,turnId:activeTurn.turnId,generationId:turnRecovery.get(activeTurn.turnId)?.generation_id,requestId:idemKey});results=outcome.results;content=outcome.content;
            turnRecovery.transition(activeTurn.turnId,outcome.status==="temporarily_unavailable"?"DEGRADED":"GENERATING_FINAL");
          }else if(isAutonomous){
            toolOutcome=await executeAutonomousCapabilityTool({name:callName,args,sessionId:session.id,signal:controller.signal,runtimeCapabilities,workspaceRoot:autonomousContext?.workspaceRoot,installer:capabilityInstaller,onProgress:event=>publishEvent(isLocalAgentToolName(callName)||isPackageOperationToolName(callName)?"local.runtime.progress":"capability.install.progress",event,{sessionId:session.id})});
            succeeded=toolOutcome.ok!==false;content=toolOutcome.durableContent??toolOutcome.content??"";failure=succeeded?null:classifyToolFailure(content);
          }else{
            const authorizedHighRisk=actionIntent?.actionRequested===true&&(matchingTools??[]).some(tool=>tool.name===callName),outcome=await mcpRegistry.executeByWireName(callName,args,{authorizedHighRisk});
            succeeded=outcome.ok!==false;failure=succeeded?null:classifyToolFailure(outcome.text);const safeText=!succeeded&&failure?`[companion tool failure] ${JSON.stringify({category:failure.failure_category,code:failure.failure_code,summary:failure.failure_summary,reason:failure.failure_reason})}`:outcome.text;content=wrapUntrustedToolOutput(safeText);
          }
        }catch(error){failure=classifyToolFailure(`[${source} tool error] ${String(error?.message??error)}`);publishEvent("tool.failed",{callId:call.id??"",name:callName,source,activity:{...baseActivity,...(failure??{})},turnId:activeTurn.turnId},{sessionId:session.id});throw error;}
        collectedSources.push(...results);const activity={...baseActivity,...(failure??{})};publishEvent(succeeded?"tool.completed":"tool.failed",{callId:call.id??"",name:callName,source,output_preview:callName==="web_search"?`${results.length} results`:isAutonomous?(succeeded?"completed":"failed"):`${content.length} chars`,output_chars:isAutonomous?undefined:content.length,result_count:callName==="web_search"?results.length:undefined,activity,turnId:activeTurn.turnId},{sessionId:session.id});return toolOutcome??{ok:succeeded,content,failure};
      }
    });
    const j=result.response,m=result.message,sources=dedupeSources(collectedSources,config.webSearchMaxResults+2),finalMessage={role:"assistant",content:typeof m.content==="string"?m.content:"",reasoning_content:m?.reasoning_content??m?.reasoning??undefined};if(sources.length)finalMessage.web_sources=sources;
    const generationRoute=webSearchActive?"core_tools_web":(compatModel?"core_tools_compat":"core_tools");
    const finalized=await finalizeAssistantBubblePlan({rawContent:finalMessage.content,userText:currentUserText,ctx,controller,generationRoute,turnId:activeTurn.turnId,presence:naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null});
    const plan=finalized.plan;
    turnRecovery.setPlan(activeTurn.turnId,plan);
    const prepared=prepareAssistantVoice({userText:currentUserText,assistantText:finalMessage.content});
    const sequence=await deliverBubbleSequence({
      sessionId:session.id,source:ctx.source,bubblePlan:plan,signal:controller.signal,
      generationRoute,turnId:activeTurn.turnId,
      userModality:"text",
      enableModality:ctx.mode==="chat",
      enqueueVoice:enqueueVoiceAfterDurable,
      extraContentJson:({index})=>({
        ...(sources.length?{web_sources:sources}:{})
      }),
      onTrace:(stage,data)=>traceBubble(stage,data),
      onDelivered:async({messageId,index,count,text,plan:planItem,textDurableAt})=>{
        turnRecovery.noteCommit(activeTurn.turnId,{bubbleIndex:index,messageId});
        // Text-first: never skip text SSE because TTS will follow.
        if(!wantsStream||res.destroyed)return;
        writeBubbleSse({res,model:ctx.publicModel,messageId,index,count,text,plan:planItem});
        traceBubble("text_sse",{messageId,textDurableAt,textSseAt:Date.now()});
      }
    });
    const deliveredPlan=sequence.messages.map((message,index)=>({...plan[index],message_id:message.messageId}));
    const finalBubbles=sequence.messages.map(message=>message.text);
    finalMessage.content=finalBubbles[0]??"";
    notePresenceAfterTurn({userText:currentUserText,assistantText:finalBubbles.join("\n"),sessionId:session.id,sourceMessageId,messageIds:sequence.messages.map(message=>message.messageId),groundingState,skipPresenceLoops});maybeScheduleSummary(session.id);res.off("close",onClose);lifecycle.close();
    agentTasks.finish(task,"completed");
    activeTurns.complete(session.id,activeTurn.turnId,"completed");
    if(!sequence.interrupted&&sequence.messages.length===plan.length)turnRecovery.transition(activeTurn.turnId,"COMMITTED");
    publishEvent("turn.completed",{ok:true,status:200,native:true,turnId:activeTurn.turnId,outcome:"completed"},{sessionId:session.id});
    publishEvent("agent.completed",{ok:true,status:200,native:true,turnId:activeTurn.turnId,pendingGuidance:guidanceQueue.pendingCount(session.id)},{sessionId:session.id});
    {const recorded=attentionStore.record({type:"agent_completed",source:"agent",resource:session.id,fingerprint:activeTurn.turnId,title:"任务完成了。",summary:"林小糖完成了一项后台任务。",destination:"chat",conversation_id:session.id,turn_id:activeTurn.turnId,state:"done"});if(recorded.delivered)publishEvent("attention.created",{id:recorded.item.id,type:"agent_completed",title:recorded.item.title},{sessionId:session.id});}
    const delivery=prepared;
    const completion={...j,companion_task_id:task.id,model:ctx.publicModel,companion_voice_delivery:delivery,companion_bubbles:finalBubbles,companion_bubble_plan:deliveredPlan,companion_bubble_count:finalBubbles.length,...(aggregateUsage?{usage:aggregateUsage}:{}),choices:[{...j.choices[0],message:{...j.choices[0].message,content:finalMessage.content,...(sources.length?{companion_web_sources:sources}:{})}}]};if(idemKey)putIdempotentResponse(session.id,idemKey,completion);if(res.destroyed)return;if(!wantsStream)return json(res,200,completion);if(sources.length)res.write(`data: ${JSON.stringify({companion_web_sources:sources})}\n\n`);res.write(`event: companion.bubbles\ndata: ${JSON.stringify({companion_bubbles:finalBubbles,companion_bubble_plan:deliveredPlan,companion_bubble_count:finalBubbles.length,interrupted:sequence.interrupted})}\n\n`);res.write(`event: companion.voice_delivery\ndata: ${JSON.stringify({companion_voice_delivery:delivery})}\n\n`);res.write("data: [DONE]\n\n");return res.end();
  }catch(e){
    res.off("close",onClose);lifecycle.close();agentTasks.finish(task,"interrupted");
    const outcome=e?.name==="AbortError"?"cancelled":e?.code==="NATIVE_AGENT_TIMEOUT"||e?.name==="TimeoutError"?"timed_out":"failed";
    if(activeTurn?.turnId){const failure=e?.networkFailure??classifyNetworkFailure({error:e,status:e?.statusCode});if(outcome==="cancelled")turnRecovery.transition(activeTurn.turnId,"CANCELLED");else if(failure.retryable)turnRecovery.noteRetry(activeTurn.turnId);else turnRecovery.transition(activeTurn.turnId,"FAILED",{error_class:failure.errorClass});}
    activeTurns.complete(session.id,activeTurn.turnId,outcome);
    publishEvent("turn.completed",{ok:false,status:Number(e?.statusCode)||502,native:true,turnId:activeTurn.turnId,outcome},{sessionId:session.id});
    publishEvent("agent.completed",{ok:false,status:Number(e?.statusCode)||502,native:true,turnId:activeTurn.turnId,outcome,pendingGuidance:guidanceQueue.pendingCount(session.id)},{sessionId:session.id});
    if(outcome!=="cancelled"){const recorded=attentionStore.record({type:"agent_failed",source:"agent",resource:session.id,fingerprint:activeTurn.turnId,title:"任务没有完成。",summary:"林小糖遇到了一个需要你查看的错误。",destination:"chat",conversation_id:session.id,turn_id:activeTurn.turnId,state:outcome});if(recorded.delivered)publishEvent("attention.created",{id:recorded.item.id,type:"agent_failed",title:recorded.item.title},{sessionId:session.id});}
    if(e?.name==="AbortError"||res.destroyed)return;
    const status=e?.name==="TimeoutError"?504:(Number(e?.statusCode)||502);
    if(process.env.COMPANION_DEBUG_STACK)console.error("[dbg-stack]",e?.stack);
    const permission=String(e?.code??"").startsWith("NATIVE_AGENT_PERMISSION");
    const payload={error:{message:e?.name==="TimeoutError"?"upstream timeout":clientUpstreamErrorMessage(e),type:permission?"permission_error":"upstream_error",code:e?.code??null,upstream_status:Number(e?.statusCode)||null}};
    if(wantsStream&&res.headersSent){res.write(`data: ${JSON.stringify(payload)}\n\n`);res.write("data: [DONE]\n\n");return res.end();}
    return json(res,status,payload);
  }
}

async function processResponses(req,res,body,ctx,session){
  if(res.destroyed)return;
  const idemKey=cleanKey(h(req,"idempotency-key")??h(req,"x-companion-request-id")??"","",200),cacheKey=idemKey?`responses:${idemKey}`:"";
  if(cacheKey&&!body.stream){const cached=getIdempotentResponse(session.id,cacheKey);if(cached)return json(res,200,cached);}
  const retryFingerprint=config.agentToolMode==="compat"?compatRetryFingerprint("responses",session.id,body):null,guarded=guardedCompatFailure(retryFingerprint);if(guarded)return sendGuardedCompatFailure(res,guarded);
  const sessionBefore=getSession(session.id),storedRecent=config.agentIncludeStoredRecent?listRecentMessagesAfter(session.id,sessionBefore?.summary_through_message_id??0,config.agentStoredRecentMessages):[];
  const incoming=responsesInputToMessages(body.input);
  const previousInteraction=getPreviousRealInteraction(session.id),appended=appendIncomingMessagesDetailed(session.id,ctx.source,incomingTail(incoming));
  const currentUser=[...appended.messages].reverse().find(message=>message.role==="user"&&message.contentText.trim()),currentUserText=currentUser?.contentText??"";
  const nonTextUser=[...appended.messages].reverse().find(message=>message.role==="user"&&!message.contentText.trim());
  if(nonTextUser)touchUserInteraction(nonTextUser.createdAt);
  let autonomyDecision=null;
  if(currentUserText){localGPTSoVITSService.cancel();observeUserActivity(currentUserText);temporalContextStore.observe({sessionId:session.id,text:currentUserText,sourceMessageId:currentUser.id,at:new Date(currentUser.createdAt)});autonomousLife.recordInteraction({text:currentUserText,sessionId:session.id,at:new Date(currentUser.createdAt)});autonomyDecision=autonomousLife.decideRequest({text:currentUserText});if(autonomyDecision.outcome==="ACCEPT"){maybeExtractFollowup(currentUserText,session.id);observeUserTurnForMemory(session,currentUserText,currentUser.id);}}
  if(autonomyDecision&&autonomyDecision.outcome!=="ACCEPT")return sendAutonomyResponsesDecision(res,{body,ctx,session,decision:autonomyDecision,cacheKey});
  const timeContext=buildTimeContext({currentUserAt:currentUser?.createdAt,previousUser:previousInteraction.user,previousAssistant:previousInteraction.assistant,activity:temporalContextStore.current(session.id)});
  const autonomyContext=autonomousLife.contextBlock(autonomyDecision);
  const injected=await buildInjectedResponsesInput({persona:requirePersona(ctx.personaId),ctx,sessionId:session.id,clientInput:body.input,clientMessages:incoming,storedRecent,autonomyContext,timeContext,currentMessageId:currentUser?.id??null});
  if(config.agentToolMode==="compat"){emitIncomingToolResults("responses",body,session);return processCompatResponses(req,res,body,ctx,session,injected,cacheKey,retryFingerprint);}
  const controller=new AbortController(),onClose=()=>{if(!res.writableEnded)controller.abort();};
  const routeKey=agentRouteKey(session),continuation=isToolContinuation("responses",body);prepareAgentProviderRoute(routeKey,continuation,continuation?getLastAgentUsageProvider(session.id):null);
  res.once("close",onClose);
  let up;
  try{up=await upstreamResponses(body,injected,controller.signal,{lockKey:routeKey});}catch(e){
    res.off("close",onClose);if(e?.name==="AbortError"||res.destroyed)return;
    const status=e?.name==="TimeoutError"?504:502;
    if(process.env.COMPANION_DEBUG_STACK)console.error("[dbg-stack]",e?.stack);
    return json(res,status,{error:{message:e?.name==="TimeoutError"?"upstream timeout":(e.message??String(e)),type:"upstream_error"}});
  }
  const upInfo=upstreamResponseInfo(up),upModel=usageUpstreamModel(upInfo);
  if(!up.ok){res.off("close",onClose);const text=redactSecrets(await up.text());res.writeHead(up.status,{"content-type":up.headers.get("content-type")??"text/plain; charset=utf-8"});return res.end(text);}
  if(!body.stream){
    let out;try{out=await up.json();}catch{finishAgentProviderRoute(routeKey,false);res.off("close",onClose);return json(res,502,{error:{message:"upstream returned invalid JSON",type:"upstream_error"}});}
    rewriteResponseModel(out,ctx.publicModel);
    const message=responseAssistantMessage(out);if(message)storeMessage(session.id,ctx.source,message);
    finishAgentProviderRoute(routeKey,Boolean(message?.tool_calls?.length));
    if(out?.usage)insertUsage({sessionId:session.id,source:ctx.source,publicModel:ctx.publicModel,upstreamModel:upModel,kind:"agent",usage:out.usage});
    if(cacheKey)putIdempotentResponse(session.id,cacheKey,out);
    maybeScheduleSummary(session.id);res.off("close",onClose);return json(res,200,out);
  }
  res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",connection:"keep-alive","x-accel-buffering":"no"});
  const reader=up.body?.getReader();if(!reader){res.off("close",onClose);res.end();return;}
  const dec=new TextDecoder(),state=responseStreamState();let buf="",streamError=null;
  const frame=f=>{
    if(!f.trim())return;
    const lines=f.split(/\r?\n/),dataLines=lines.filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim());
    if(!dataLines.length){if(!res.destroyed)res.write(`${f}\n\n`);return;}
    const data=dataLines.join("\n");
    if(data==="[DONE]"){if(!res.destroyed)res.write(`${f}\n\n`);return;}
    try{
      const event=JSON.parse(data);observeResponseEvent(state,event);rewriteResponseModel(event,ctx.publicModel);
      const metadata=lines.filter(line=>!line.startsWith("data:"));
      if(!res.destroyed)res.write(`${metadata.length?`${metadata.join("\n")}\n`:""}data: ${JSON.stringify(event)}\n\n`);
    }catch{if(!res.destroyed)res.write(`${f}\n\n`);}
  };
  try{
    while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});let match;while((match=buf.match(/\r?\n\r?\n/))){const n=match.index;frame(buf.slice(0,n));buf=buf.slice(n+match[0].length);}}
    buf+=dec.decode();if(buf.trim())frame(buf);
  }catch(e){if(e?.name!=="AbortError"&&!res.destroyed){streamError=e;recordError("upstream_responses_stream",e);console.error("[responses stream]",redactSecrets(e.message??e,1000));}}
  if(res.destroyed){res.off("close",onClose);return;}
  if(!state.terminal&&!streamError)streamError=new Error("upstream Responses SSE ended before terminal event");
  if(streamError)res.write(`event: error\ndata: ${JSON.stringify({type:"error",error:{message:"upstream stream interrupted",type:"upstream_error"}})}\n\n`);
  const message=streamAssistantMessage(state);if(message)storeMessage(session.id,ctx.source,message);
  finishAgentProviderRoute(routeKey,Boolean(message?.tool_calls?.length));
  if(state.usage)insertUsage({sessionId:session.id,source:ctx.source,publicModel:ctx.publicModel,upstreamModel:upModel,kind:"agent",usage:state.usage});
  maybeScheduleSummary(session.id);res.off("close",onClose);res.end();
}

async function chat(req,res,body){
  if(typeof body?.model!=="string"||!Array.isArray(body?.messages))return json(res,400,{error:{message:"model 和 messages 必填",type:"invalid_request_error"}});
  if(body?.metadata?.webEnabled===true&&!capabilities().web_search.configured)return json(res,409,{error:{message:"未配置联网搜索",type:"web_search_unconfigured",code:"web_search_unconfigured"}});
  const ctx=resolveContext(req,body),persona=requirePersona(ctx.personaId),session=getOrCreateSession(persona.id,ctx.source,ctx.sessionKey);ctx.workspaceRoot=ctx.workspaceRoot??sessionPermissions.workspaceRoot(session.id);
  return inSession(session.id,async()=>{
    const end=beginTask(ctx.mode,session.id);let outcome;
    if(ctx.mode==="agent")publishEvent("agent.started",{source:ctx.source,model:ctx.publicModel},{sessionId:session.id});
    try{
      if(body?.metadata?.agentResumeTaskId)ctx.resumeTask=agentTasks.get(session.id,body.metadata.agentResumeTaskId);
      else {const last=[...body.messages].reverse().find(m=>m.role==="user");if(typeof last?.content==="string"&&/^(?:继续上次任务|恢复上次任务|resume last task)[。.!！\s]*$/i.test(last.content.trim()))ctx.resumeTask=agentTasks.list(session.id).find(t=>t.status==="interrupted")??null;}
      return await processChat(req,res,body,ctx,session);}
    catch(e){outcome={error:e,status:e?.statusCode};throw e;}
    finally{
      if(ctx.mode==="agent")publishEvent("agent.completed",{ok:!outcome?.error,status:outcome?.status??200},{sessionId:session.id});
      end(outcome);
    }
  });
}

async function responses(req,res,body){
  if(body?.model!=="yuna-agent"||!(typeof body?.input==="string"||Array.isArray(body?.input)))return json(res,400,{error:{message:"model 必须是 yuna-agent，input 必填",type:"invalid_request_error"}});
  const ctx=resolveContext(req,body),persona=requirePersona(ctx.personaId),session=getOrCreateSession(persona.id,ctx.source,ctx.sessionKey);ctx.workspaceRoot=ctx.workspaceRoot??sessionPermissions.workspaceRoot(session.id);
  return inSession(session.id,async()=>{
    const end=beginTask("agent",session.id);let outcome;
    publishEvent("agent.started",{source:ctx.source,model:ctx.publicModel},{sessionId:session.id});
    try{return await processResponses(req,res,body,ctx,session);}
    catch(e){outcome={error:e,status:e?.statusCode};throw e;}
    finally{
      publishEvent("agent.completed",{ok:!outcome?.error,status:outcome?.status??200},{sessionId:session.id});
      end(outcome);
    }
  });
}

const adminAssets=new Map([
  ["/admin/",{type:"text/html; charset=utf-8",body:fs.readFileSync(new URL("../public/admin/index.html",import.meta.url))}],
  ["/admin-ui/styles.css",{type:"text/css; charset=utf-8",body:fs.readFileSync(new URL("../public/admin/styles.css",import.meta.url))}],
  ["/admin-ui/app.js",{type:"text/javascript; charset=utf-8",body:fs.readFileSync(new URL("../public/admin/app.js",import.meta.url))}]
]);

const server=http.createServer(async(req,res)=>{try{
  const u=new URL(req.url,`http://${req.headers.host??"localhost"}`);
  if(req.method==="OPTIONS"){res.writeHead(204,{"access-control-allow-origin":config.corsAllowOrigin,"access-control-allow-headers":"authorization,content-type,idempotency-key,x-companion-request-id,x-companion-source,x-companion-session,x-companion-persona,x-companion-filename,x-companion-project,x-companion-project-path,x-companion-workspace,x-project-path,x-workspace,x-repository-path,x-repository-name,x-cwd,x-project-id,x-opencode-project,x-harness-project,x-session-id","access-control-allow-methods":"GET,POST,PUT,PATCH,DELETE,OPTIONS"});return res.end();}
  res.setHeader("access-control-allow-origin",config.corsAllowOrigin);
  if(u.pathname==="/health")return json(res,200,{ok:true,service:"companion-core",version:config.version,time:new Date().toISOString(),instance:primaryInstanceLease.metadata()});

  // OAuth redirect 不携带 Companion API Key；仅接受一次性 state，并只在
  // loopback callback 上交换 authorization code。响应不回显 code/token。
  if(req.method==="GET"&&u.pathname==="/mcp/oauth/callback"){
    if(!isLoopback(req.socket.remoteAddress))return json(res,403,{error:{message:"OAuth callback denied",type:"authorization_error"}});
    try{
      const result=await mcpRegistry.completeOAuth({code:u.searchParams.get("code"),state:u.searchParams.get("state"),error:u.searchParams.get("error")});
      const ok=result.ok;
      res.writeHead(ok?200:400,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'"});
      return res.end(`<!doctype html><meta charset="utf-8"><title>Companion MCP OAuth</title><style>body{font:16px system-ui;max-width:560px;margin:80px auto;padding:24px}h1{font-size:24px}</style><h1>${ok?"授权完成":"授权未完成"}</h1><p>${ok?"Companion 已安全保存授权并连接 MCP。现在可以关闭此页面。":"没有获得授权。你可以关闭页面后在 Companion 中重试。"}</p>`);
    }catch{
      res.writeHead(400,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'"});
      return res.end('<!doctype html><meta charset="utf-8"><title>Companion MCP OAuth</title><style>body{font:16px system-ui;max-width:560px;margin:80px auto;padding:24px}</style><h1>授权回调无效或已过期</h1><p>请关闭此页面并从 Companion 重新发起授权。</p>');
    }
  }

  // MCP Server（HTTP transport）：必须鉴权（专用 MCP token 或 API key），绝不裸奔。
  if(config.mcpHttpEnabled&&u.pathname==="/mcp"){
    const expected=[config.mcpToken,config.apiKey].filter(Boolean);
    if(!expected.includes(bearer(req)))return json(res,401,{error:{message:"MCP authentication failed",type:"authentication_error"}});
    if(req.method!=="POST")return json(res,405,{error:{message:"MCP HTTP transport supports POST only",type:"invalid_request_error"}});
    let parsed;try{parsed=JSON.parse((await readBody(req,config.maxBodyBytes)).toString("utf8")||"{}");}catch{return json(res,400,{error:{message:"invalid JSON body",type:"invalid_request_error"}});}
    try{await handleMcpHttpRequest(req,res,parsed);}catch(e){if(!res.headersSent)json(res,500,{error:{message:"mcp transport error",type:"internal_error"}});}
    return;
  }

  if(req.method==="GET"&&u.pathname==="/admin"){if(!adminHostAllowed(req))return json(res,403,{error:{message:"Admin access denied",type:"authorization_error"}});res.writeHead(302,{location:"/admin/"});return res.end();}
  if(req.method==="GET"&&adminAssets.has(u.pathname)){
    if(!adminHostAllowed(req))return json(res,403,{error:{message:"Admin access denied",type:"authorization_error"}});
    const asset=adminAssets.get(u.pathname);res.writeHead(200,{"content-type":asset.type,"cache-control":"no-store","content-security-policy":"default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'","x-content-type-options":"nosniff"});return res.end(asset.body);
  }
  if(u.pathname.startsWith("/admin/")){
    if(!adminAuth(req))return json(res,403,{error:{message:"Admin access denied",type:"authorization_error"}});
    const handled=await handleAdminApi(req,res,u);if(handled!==false)return;
    return json(res,404,{error:{message:"Admin endpoint not found",type:"not_found"}});
  }

  if(!apiAuth(req))return json(res,401,{error:{message:"Invalid Companion API key",type:"authentication_error"}});
  if(req.method==="GET"&&u.pathname==="/v1/models")return json(res,200,models());
  if(req.method==="GET"&&u.pathname==="/v1/capabilities")return json(res,200,capabilities());
  if(req.method==="GET"&&u.pathname==="/v1/voice/status")return json(res,200,localGPTSoVITSService.publicStatus());
  if(req.method==="GET"&&u.pathname==="/v1/presence/status"){
    const wake=localWakeWordService.publicStatus();
    return json(res,200,{
      agent_active:activeTurns.count()>0,
      voice_call:localSenseVoiceService.publicStatus().state==="ready"||localSenseVoiceService.publicStatus().state==="transcribing",
      pending_approval:Boolean(sessionPermissions.pending?.size),
      wake_word:{enabled:wake.enabled,state:wake.state,experimental:true}
    });
  }
  if(req.method==="GET"&&u.pathname==="/v1/wake-word/status")return json(res,200,localWakeWordService.publicStatus());
  if(req.method==="PATCH"&&u.pathname==="/v1/wake-word/settings")return json(res,200,localWakeWordService.updateSettings(await readJsonBody(req,16*1024)));
  if(req.method==="POST"&&u.pathname==="/v1/wake-word/context")return json(res,200,localWakeWordService.updateContext(await readJsonBody(req,16*1024)));
  if(req.method==="POST"&&u.pathname==="/v1/wake-word/ingest"){
    const body=await readJsonBody(req,512*1024);
    return json(res,200,await localWakeWordService.ingest({pcm16Base64:body.pcm16_base64,sampleRate:body.sample_rate}));
  }
  if(req.method==="POST"&&u.pathname==="/v1/wake-word/resolve"){
    const body=await readJsonBody(req,16*1024);
    return json(res,200,localWakeWordService.resolveTranscript(body.transcript??""));
  }
  if(req.method==="POST"&&u.pathname==="/v1/wake-word/event"){
    const body=await readJsonBody(req,16*1024);
    const kind=String(body.kind??"");
    if(!["wake","one_shot","timeout","cancel","false_wake","call","disable"].includes(kind))return json(res,400,{error:{message:"unknown wake event",type:"invalid_request"}});
    return json(res,200,localWakeWordService.record(kind));
  }
  if(req.method==="POST"&&u.pathname==="/v1/presence/screen-context"){
    const observe=async()=>{
      try{
        const listed=await computerUseAdapter.execute("computer_window_list",{on_screen_only:true});
        const text=typeof listed.modelContent==="string"?listed.modelContent:JSON.stringify(listed.modelContent??{});
        return {frontmost:null,windows:[{app:"screen",title:text.slice(0,80)}],unavailable:listed.ok===false};
      }catch{
        return {unavailable:true};
      }
    };
    return json(res,200,await captureExplicitScreenContext({explicit:true,observe}));
  }
  if(req.method==="GET"&&u.pathname==="/v1/voice-call/status")return json(res,200,{stt:localSenseVoiceService.publicStatus(),tts:localGPTSoVITSService.publicStatus(),diagnostics:voiceCallDiagnostics.snapshot()});
  if(req.method==="POST"&&u.pathname==="/v1/chat/voice-message"){
    const body=await readJsonBody(req,config.maxBodyBytes);
    const t0=Date.now();
    try{
      const result=await ingestUserVoiceMessage({
        audioBase64:body.audio_base64,
        durationMs:body.duration_ms,
        sessionId:body.session_id??null,
        source:String(body.source??"chat")
      });
      console.log("[voice-message] ok", JSON.stringify({ms:Date.now()-t0,messageId:result.messageId,transcript:result.transcript,duration_ms:result.duration_ms}));
      return json(res,200,{ok:true,...result});
    }catch(error){
      const status=Number(error?.statusCode)||500;
      console.error("[voice-message] fail", JSON.stringify({ms:Date.now()-t0,code:error?.code,status,message:String(error?.message??error).slice(0,160)}));
      return json(res,status,{error:{message:String(error?.message??error),type:error?.code??"voice_message_error"}});
    }
  }
  if(req.method==="POST"&&u.pathname==="/v1/voice-call/transcribe"){

    const body=await readJsonBody(req,config.senseVoiceMaxAudioBytes*2),result=await localSenseVoiceService.transcribe({audioBase64:body.audio_base64,sessionId:cleanKey(body.session_id,"voice-call",200)});
    return json(res,200,result);
  }
  if(req.method==="POST"&&u.pathname==="/v1/voice-call/prewarm"){await Promise.all([localSenseVoiceService.ensureReady(),localGPTSoVITSService.ensureReady()]);localSenseVoiceService.enterCall();localGPTSoVITSService.enterCall();localWakeWordService.updateContext({voiceCallActive:true});return json(res,200,{stt:localSenseVoiceService.publicStatus(),tts:localGPTSoVITSService.publicStatus()});}
  if(req.method==="POST"&&u.pathname==="/v1/voice-call/turn-metrics"){
    const body=await readJsonBody(req,64*1024);
    return json(res,200,voiceCallDiagnostics.recordTurn(body));
  }
  if(req.method==="POST"&&u.pathname==="/v1/voice-call/end"){
    const body=await readJsonBody(req,64*1024);
    localSenseVoiceService.recordCall(body);
    voiceCallDiagnostics.recordCall(body);
    localSenseVoiceService.leaveCall();
    localGPTSoVITSService.leaveCall();
    localWakeWordService.updateContext({voiceCallActive:false});
    return json(res,200,{ok:true,diagnostics:voiceCallDiagnostics.snapshot()});
  }
  if(req.method==="PATCH"&&u.pathname==="/v1/voice/settings")return json(res,200,localGPTSoVITSService.updateSettings(await readJsonBody(req,64*1024)));
  if(req.method==="POST"&&u.pathname==="/v1/voice/synthesize"){
    const body=await readJsonBody(req,64*1024),result=await localGPTSoVITSService.synthesize({text:body.text,voice:body.voice??"yuxiao",speed:body.speed??localGPTSoVITSService.settings.speed,sessionId:cleanKey(body.session_id,"voice-ui",200)});
    return json(res,200,{...result,audio_url:`/v1/voice/audio/${result.id}`});
  }
  if(req.method==="POST"&&u.pathname==="/v1/voice/cancel"){localGPTSoVITSService.cancel();return json(res,200,{ok:true});}
  if(req.method==="POST"&&u.pathname==="/v1/voice/stop"){await localGPTSoVITSService.stop();return json(res,200,localGPTSoVITSService.publicStatus());}
  const voiceAudio=req.method==="GET"?u.pathname.match(/^\/v1\/voice\/audio\/(tts_[a-f0-9]{24})$/):null;
  if(voiceAudio){const file=localGPTSoVITSService.audioPath(voiceAudio[1]);if(!file)return json(res,404,{error:{message:"voice audio not found",type:"not_found"}});const stat=fs.statSync(file);res.writeHead(200,{"content-type":"audio/wav","content-length":stat.size,"cache-control":"private, max-age=86400","x-content-type-options":"nosniff"});return fs.createReadStream(file).pipe(res);}
  if(req.method==="POST"&&u.pathname==="/media/upload"){
    const mime=String(h(req,"content-type")??"").split(";",1)[0].trim().toLowerCase();
    const declared=Number(h(req,"content-length")??0);
    if(declared>MAX_UPLOAD_BYTES)return json(res,413,{error:{message:"图片不能超过 10 MB",type:"media_too_large"}});
    let filename="";try{filename=decodeURIComponent(String(h(req,"x-companion-filename")??""));}catch{filename="";}
    const media=saveUploadedMedia({buffer:await readBody(req,MAX_UPLOAD_BYTES),mime,filename});
    return json(res,201,{media_id:media.id,mime:media.mime,filename:media.filename,width:media.width,height:media.height,bytes:media.bytes,url:`/media/${media.id}`});
  }
  const mediaMatch=req.method==="GET"?u.pathname.match(/^\/media\/([0-9a-fA-F-]{36})$/):null;
  if(mediaMatch){
    const media=getMedia(mediaMatch[1]);
    if(!media||media.missing)return json(res,404,{error:{message:"media not found",type:"not_found"}});
    res.writeHead(200,{"content-type":media.mime,"content-length":media.buffer.length,"cache-control":"private, max-age=86400","x-content-type-options":"nosniff"});
    return res.end(media.buffer);
  }
  if(req.method==="POST"&&u.pathname==="/v1/chat/completions")return await chat(req,res,await readJsonBody(req,config.maxBodyBytes));
  if(req.method==="POST"&&u.pathname==="/v1/responses")return await responses(req,res,await readJsonBody(req,config.maxBodyBytes));
  return json(res,404,{error:{message:"Not found",type:"not_found"}});
}catch(e){
  if(e?.name==="AbortError"||res.destroyed)return;
  const status=Number(e?.statusCode)||500;
  const item=recordError("server",e,status);console.error("[server]",item.message);
  if(!res.headersSent)json(res,status,{error:{message:item.message,type:status<500?"invalid_request_error":"companion_core_error"}});else res.end();
}});
attachWebSocketServer(server);
server.listen(config.port,config.host,()=>{
  console.log(`Companion Core v${config.version}: http://${config.host}:${config.port}`,JSON.stringify(primaryInstanceLease.metadata()));
  scheduler.start();
  startDiaryScheduler();
  try{
    const recovered=recoverPendingVoiceJobs();
    if(recovered?.recovered||recovered?.already_ready)console.log("[voice-async] recovered",JSON.stringify(recovered));
  }catch(e){console.error("[voice-async] recover failed",redactSecrets(e?.message??String(e)));}
  mcpRegistry.connectEnabledIntegrations().catch(error=>console.error("[mcp] startup reconnect failed",redactSecrets(error?.message??String(error))));
});
for(const signal of ["SIGTERM","SIGINT"])process.once(signal,()=>{localSenseVoiceService.stop();localGPTSoVITSService.stop().finally(()=>{primaryInstanceLease.release();process.exit(signal==="SIGTERM"?0:130);});});
process.once("exit",()=>primaryInstanceLease.release());
