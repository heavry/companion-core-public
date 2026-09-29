import { naturalCognition } from "./store.js";

export { naturalCognition };

export function cognitionEnabled(){return naturalCognition.enabled;}

export function onAssistantMessageDelivered({messageId,sessionId=null,at=new Date()}={}){
  naturalCognition.noteMessageDelivered({messageId,sessionId,at});
}

export function onUserMessage({text="",sessionId=null,at=new Date(),replyToMessageId=null,previousAssistantText="",sourceMessageId=null}={}){
  if(replyToMessageId!=null)naturalCognition.markReplied({messageId:replyToMessageId,at,sessionId});
  const cancelled=cancelMatchingExpectation(text,at);
  const resolved=naturalCognition.tryResolveExpectations(text,at);
  const violated=naturalCognition.violateExpectations(text,at);
  const createdExpectation=cancelled.length?null:maybeCreateExpectation({userText:text,assistantText:previousAssistantText,sourceMessageId,at});
  return {resolvedExpectationIds:resolved,cancelledExpectationIds:cancelled,violatedExpectationIds:violated,createdExpectation};
}

export function onMacSeen({messageIds=[],sessionId=null,windowActive=true,chatVisible=true,at=new Date()}={}){
  return naturalCognition.markSeen({messageIds,sessionId,windowActive,chatVisible,at});
}

export function onMacAttention({windowActive,chatVisible,at=new Date()}={}){
  return naturalCognition.setAttention({windowActive,chatVisible,at});
}

const COMMITMENT_REJECTIONS=/(如果|要是|假如|万一|除非|可能|也许|或许|大概|不一定|看情况|说不定)/;
const COMMITMENT_TIME_RE=/(今天晚上|今晚|晚上|等一下|等下|待会(?:儿)?|一会(?:儿)?|稍后|明天|后天|下周|这周|周[一二三四五六日天])/;
const COMMITMENT_STRENGTH_RE=/(一定|肯定|保证|答应|我会|我将|我打算|我准备|我要|等我|弄完就|做完就|搞定就|完成就|学完就|弄完再|做完再|忙完再)/;

function actionFromText(value=""){
  const text=String(value??"").replace(/[\s，,。.!！?？；;：:]/g,"");
  if(/(?:弄完|做完|搞定|完成|忙完|处理完|跑完|测完).{0,12}(?:回来|再来|来找你|找你)/.test(text))return {key:"finish_then_return",label:"弄完后回来"};
  if(/(?:照片|图片|截图|视频).{0,8}(?:发|给你)|(?:发|给你).{0,8}(?:照片|图片|截图|视频)/.test(text))return {key:"send_photo",label:"给你发照片"};
  if(/(?:给你看|发你看|展示给你|给你展示|让我看|看给你)/.test(text))return {key:"show",label:"给你看"};
  if(/(?:回来|回去|再来|来找你|过来|上线)/.test(text))return {key:"return",label:"回来"};
  if(/(?:告诉你|跟你说|说一声|报个信|汇报|回头说)/.test(text))return {key:"report",label:"告诉你"};
  if(/(?:学习|学一下|学|复习|练习|写作业|看书)/.test(text))return {key:"study",label:"学习"};
  if(/(?:弄完|做完|搞定|完成|忙完|处理完|跑完|测完)/.test(text))return {key:"completion",label:"完成"};
  return null;
}

function actionAlreadyCompleted(text,actionKey){
  const completed={
    finish_then_return:/(?:弄完|做完|搞定|完成|忙完|处理完|跑完|测完).{0,12}(?:回来|再来|来找你|找你).{0,2}(?:了|啦)|(?:已经|刚才|刚刚|之前).{0,10}(?:弄完|做完|搞定|完成|回来)/,
    return:/(?:回来|回到家|回到这里|来找你).{0,2}(?:了|啦|过)|(?:已经|刚才|刚刚|之前).{0,10}(?:回来|回到家|来找你)/,
    send_photo:/(?:给你发|发给你|把.{0,8}(?:照片|图片|截图).{0,4}发).{0,8}(?:了|过)|(?:照片|图片|截图).{0,8}(?:发给你了|发给你过)/,
    show:/(?:给你看|发你看|展示给你|给你展示).{0,4}(?:了|过)|(?:已经|刚才|刚刚|之前).{0,10}(?:给你看|展示给你)/,
    report:/(?:告诉你|跟你说|说一声|报个信|汇报).{0,4}(?:了|过)|(?:已经|刚才|刚刚|之前).{0,10}(?:告诉你|跟你说|汇报)/,
    study:/(?:学习|学|复习|练习|写作业|看书).{0,3}(?:了|过|完)|(?:已经|刚才|刚刚|之前).{0,10}(?:学习|复习|练习|写完作业)/,
    completion:/(?:弄完|做完|搞定|完成|忙完|处理完|跑完|测完).{0,2}(?:了|啦|过)|(?:已经|刚才|刚刚|之前).{0,10}(?:弄完|做完|搞定|完成|跑完|测完)/
  };
  return Boolean(completed[actionKey]?.test(text));
}

function timeLabel(value=""){
  const match=String(value??"").match(COMMITMENT_TIME_RE);
  return match?.[0]??"";
}

function buildUserCommitmentCandidate(value=""){
  const text=String(value??"").trim();
  if(!text||text.length>500||COMMITMENT_REJECTIONS.test(text))return null;
  const firm=COMMITMENT_STRENGTH_RE.test(text);
  if(/(?:我想|想要|希望|我觉得)/.test(text)&&!firm)return null;
  // 「想以后……」是愿望/长期设想；没有更强的承诺词时不升级成待办。
  if(/想(?:要)?(?:以后|将来|之后|有空)/.test(text)&&!firm)return null;
  const action=actionFromText(text);
  if(!action||actionAlreadyCompleted(text,action.key))return null;
  const time=timeLabel(text);
  const firstPerson=/我/.test(text);
  const sequence=/(?:弄完|做完|搞定|完成|忙完|处理完|学完).{0,10}(?:就|再|后)/.test(text);
  // Need a concrete user action plus either a future window or a clear commitment marker.
  if(!time&&!firm&&!sequence)return null;
  if(!firm&&!sequence&&!time)return null;
  // A time-only statement is sufficient for an explicit first-person action or a direct
  // conversational promise such as “等下给你看”。 It is not sufficient for speculation.
  if(time&&!firstPerson&&!/(给你|等我|等下|待会|稍后|一会)/.test(text)&&!firm)return null;
  const topic=action.key==="finish_then_return"?`${time?`${time}`:""}弄完后回来`:`${time?`${time}`:""}${action.label}`;
  const ttlHours=/下周/.test(text)?24*8:(/后天/.test(text)?72:(/明天/.test(text)?48:24));
  return {topic,expectedInformation:action.key,ttlHours};
}

function assistantElicitedCandidate(assistantText=""){
  const text=String(assistantText??"").trim();
  if(!text)return null;
  const requestsUpdate=/(?:弄完|做完|搞定|完成|忙完|跑完|测完|有结果|结果出来|回来).{0,20}(?:告诉我|跟我说|发我|给我看|让我看|说一声|报个信)|(?:告诉我|跟我说|发我|给我看|让我看|说一声|报个信).{0,20}(?:弄完|做完|搞定|完成|跑完|测完|有结果|结果|回来)/.test(text.replace(/[\s，,。.!！?？；;：:]/g,""));
  if(!requestsUpdate)return null;
  const expectedInformation=/(结果|跑完|测完)/.test(text)
    ?"result"
    :(/饱/.test(text)&&/吃得怎么样|好吃|味道/.test(text)?"meal_quality,satiety":(/饱/.test(text)?"satiety":(/吃得怎么样|好吃|味道/.test(text)?"meal_quality":"completion_update")));
  const action=actionFromText(text);
  const topic=/(结果|跑完|测完)/.test(text)?"完成后汇报结果":(/吃得怎么样|好吃|味道|饱/.test(text)?"面吃得怎么样/是否吃饱":(action?.key==="return"?"回来后告诉我":"弄完后告诉我"));
  return {topic,expectedInformation,ttlHours:48};
}

function isShortAcceptance(value=""){
  return /^(?:好|好的|行|可以|没问题|嗯|嗯嗯|收到|ok|okay|好呀|好哒|知道了|好嘞)[。.!！]?$/i.test(String(value??"").trim());
}

function cancellationFromText(value=""){
  const text=String(value??"").trim();
  if(!/(?:算了|取消|不去了|不学了|不做了|不发了|不回来了|不看了|不用了|改主意|不弄了|不继续了)/.test(text))return null;
  const action=actionFromText(text);
  if(!action)return null;
  return {expectedInformation:action.key,timeHint:timeLabel(text)};
}

function cancelMatchingExpectation(userText,at){
  const cancellation=cancellationFromText(userText);
  if(!cancellation)return [];
  return naturalCognition.cancelExpectations({...cancellation,reason:"user_cancelled"},at);
}

export function maybeCreateExpectation({assistantText="",topicHint=null,salience=0.72,sourceMessageId=null,at=new Date(),userText=""}={}){
  if(!naturalCognition.enabled)return null;
  const candidate=buildUserCommitmentCandidate(userText);
  let selected=candidate?{...candidate,reason:"user_initiated"}:null;
  if(!selected&&isShortAcceptance(userText)){
    const elicited=assistantElicitedCandidate(assistantText);
    if(elicited)selected={...elicited,reason:"assistant_elicited"};
  }
  if(!selected)return null;
  const topic=String(topicHint??selected.topic).trim().slice(0,120);
  // A new commitment for the same action supersedes an older one while preserving history.
  naturalCognition.cancelExpectations({expectedInformation:selected.expectedInformation,excludeTopic:topic,reason:"user_superseded"},at);
  return naturalCognition.upsertExpectation({
    topic,
    expectedInformation:selected.expectedInformation,
    sourceMessageId,
    salience:Math.max(0.65,salience),
    ttlHours:selected.ttlHours,
    reason:selected.reason,
    nextExpectedActor:"user",
    followupKind:"awaiting_user_update",
    userText,
    assistantText,
    assistantAnswered:false
  },at);
}

export function updateFocusFromTurn({activeTopic=null,expectation=null,openLoop=null,thoughtSeed=null,at=new Date()}={}){
  if(!naturalCognition.enabled)return null;
  let primary=null,secondary=null;
  // The topic the user is discussing now owns primary focus. Pending commitments
  // remain available as a secondary open loop instead of hijacking each reply.
  if(activeTopic)primary={topic:activeTopic,source:"active_topic",salience:0.7};
  else if(expectation?.topic)primary={topic:expectation.topic,source:"pending_expectation",salience:expectation.salience??0.8};
  else if(openLoop?.topic)primary={topic:openLoop.topic,source:"open_loop",salience:openLoop.salience??0.7};
  else if(thoughtSeed?.topic)primary={topic:thoughtSeed.topic,source:"thought_seed",salience:thoughtSeed.salience??0.55};
  if(activeTopic&&expectation?.topic&&activeTopic!==expectation.topic)secondary={topic:expectation.topic,source:"pending_expectation",salience:expectation.salience??0.65};
  else if(activeTopic&&primary&&activeTopic!==primary.topic)secondary={topic:activeTopic,source:"active_topic",salience:0.45};
  return naturalCognition.updateFocus({activeTopic,primaryCandidate:primary,secondaryCandidate:secondary,at});
}

export function filterMemoriesForGeneration(rows,opts={}){
  return naturalCognition.filterMemoriesForContext(rows,opts);
}

export function detectExplicitRecall(text){return naturalCognition.detectExplicitRecall(text);}

export function markMemoryRecalled(id){naturalCognition.noteRecall(id);}

export function cognitionContextBlock(at=new Date()){
  return naturalCognition.attentionContextBlock(at);
}
