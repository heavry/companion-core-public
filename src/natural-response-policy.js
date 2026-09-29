/**
 * Natural Response Policy v2 — Conversational Impulse first.
 * Decision framing changed: one impulse, selective attention, stop when done.
 * Candidate inspection stays thin; no new guard stack.
 */
import {
  selectConversationalImpulse,
  conversationalImpulseBlock,
  recentExpressionBlock,
  summarizeRecentExpressions,
  conversationalImpulses
} from "./conversational-impulse.js";
import { evaluateReplyCoverage, analyzeTurnCoverage } from "./turn-coverage.js";

const LEGACY_ACTS = new Set([
  "ACK","REACT","QUESTION","TEASE","COMMENT","CALLBACK","SHIFT","ADVICE","CLOSURE","SILENT_CONTEXT"
]);

const MINIMAL_ACK=/^(?:嗯+|哦+|噢+|啊+|行+|好+|好吧|好的|可以|知道了|收到|哈哈(?:哈)?(?:行吧)?|好?(?:姐姐|宝宝|宝贝))[。.!！~～]*$/i;
const ADVICE_REQUEST=/(?:怎么办|怎么做|该(?:先)?|要不要|能不能给.{0,6}建议|你建议|你觉得我(?:该|要)|帮我想|教教我|给我个主意|哪部分|选哪个)/i;
const ADVICE_BOUNDARY=/(?:别给我安排|不用建议|别劝我|我就吐槽|只是吐槽|没问怎么办|不用告诉我该怎么做)/i;
const SAFETY_NECESSITY=/(?:喘不上气|呼吸困难|胸痛|大量出血|晕倒|昏厥|要自杀|想死|有人威胁|着火|煤气|中毒)/i;
const EXPLICIT_RECALL=/(?:你还记得|你记得|记不记得|刚才那个|之前那个|上次那个|还记得我)/i;
const USER_QUESTION=/[?？]|(?:吗|呢|不|没)$/;
const PLAYFUL=/(?:笑死|哈哈|嘿嘿|逗|离谱|绝了|我可真|比.{0,10}好看|就知道)/i;
const COMPLAINT=/(?:累死|烦死|气死|撑死|困死|难受|学不进去|走神|催眠|吐槽|破防|崩了|无语)/i;
const RETURN=/(?:我回来了|回来啦|回家了|到家了|洗完了|忙完了|弄完了)/i;
const EVENT_REPORT=/(?:我(?:刚|已经|终于|今天|刚才|刚刚|现在)?[^。！？]{0,24}(?:回家|到家|下课|吃了|买了|写完|做完|弄完|交了|去了|来了|结束|完成)|刚(?:下课|吃完|写完|洗完|回来))/i;
const SUMMARY_REQUEST=/(?:总结一下|帮我捋|梳理一下|所以我现在|概括一下|复盘一下)/i;

const ADVICE_OUTPUT=/(?:你(?:可以|应该|得|最好|先|别|记得)|建议|不妨|要不|试试|先.{0,12}(?:再|然后)|(?:得|要|该)(?:先|赶紧|去|回来|看|背|复习|上传|休息|睡)|(?<![觉记])得[^，。！？]{1,10}(?:吧|了|哦|呀|啊|，|。|！|$)|(?:先|赶紧|赶快|早点|别|不要|最好|应该|可以|该|还是)[^，。！？]{1,14}(?:吧|呀|哦|了|！|。|$)|(?:拍照|上传|提交|复习|背|休息|睡|躺|洗|做|写|准备|回来).{0,8}吧|(?:可以|最好|记得|还是)(?:先|去|把|别)|(?:先|赶紧|早点|好好|就)(?:去)?(?:歇|休息|睡|躺)|(?:快|赶紧).{0,8}(?:上传|提交|复习)|(?:别|不要|记得别)(?:硬撑|勉强|折腾|乱动|熬|着凉)|(?:躺着|去)?(?:歇着|休息一下)|去休息|去睡|喝点|吃点|慢慢来|不然)/i;
const CLOSURE_OUTPUT=/(?:晚安|回头聊|明天再(?:说|聊)|忙完.{0,8}(?:找我|说一声)|有事叫我|我等你|先去忙|去吧|好好睡|不打扰你)/i;
const SUMMARY_OUTPUT=/(?:你(?:刚才|刚刚|现在|今天|已经).{0,24}(?:所以|那就|现在|又)|既然你|刚才你|你刚做完|今天已经)/i;
const TEASE_OUTPUT=/(?:笑死|哈哈|就知道|你还真|小馋|能吃|行不行啊|啧|哟|逗)/i;
const REACT_OUTPUT=/(?:辛苦|离谱|太|真|居然|这么|可算|好家伙|惨|难怪|确实|懂了|那可)/i;

function clean(value){return String(value??"").replace(/\s+/g," ").trim();}

function recentStructure(text){
  const value=clean(text);
  const pieces=[];
  if(SUMMARY_OUTPUT.test(value))pieces.push("SUMMARY");
  if(ADVICE_OUTPUT.test(value))pieces.push("ADVICE");
  if(CLOSURE_OUTPUT.test(value))pieces.push("CLOSURE");
  if(/[?？]/.test(value))pieces.push("QUESTION");
  if(!pieces.length)pieces.push(value.length<=10?"ACK":"COMMENT");
  return pieces.join("+");
}

/** Impulse → legacy primary act for traces / older tests. */
export function impulseToPrimaryAct(impulse){
  switch(impulse){
    case "REACT": return "REACT";
    case "TEASE": return "TEASE";
    case "CHALLENGE":
    case "DISAGREE":
    case "COMMENT":
    case "COMPLAIN":
    case "CURIOSITY":
      return "COMMENT";
    case "QUESTION": return "QUESTION";
    case "CALLBACK": return "CALLBACK";
    case "REASSURE": return "REACT";
    case "ADVISE": return "ADVICE";
    case "CLOSE": return "CLOSURE";
    case "NOTHING_MORE": return "ACK";
    default: return "COMMENT";
  }
}

/**
 * Select one conversational impulse + slim policy flags.
 * Primary API for generation; legacy fields kept for traces.
 */
export function selectNaturalResponsePolicy({
  userText="",closure=null,grounding=null,recurrence=null,presence=null,
  recentAssistantTexts=[],recentImpulses=[],recentEpisodes=[],openLoops=[],expectations=[]
}={}){
  const impulseSel=selectConversationalImpulse({
    userText,closure,grounding,recurrence,presence,
    recentAssistantTexts,recentImpulses,recentEpisodes,openLoops,expectations
  });
  let primary=impulseToPrimaryAct(impulseSel.impulse);
  // legacy: minimal user turn is still an ACK for traces/gates
  if(impulseSel.impulse==="REACT"&&impulseSel.reason==="minimal_user_turn")primary="ACK";
  const recentStructures=recentAssistantTexts.slice(-3).map(recentStructure);
  const repeatedStructure=recentStructures.length>=2&&recentStructures.at(-1)===recentStructures.at(-2)
    ? recentStructures.at(-1):null;

  return {
    // v2 core
    impulse:impulseSel.impulse,
    focusPoint:impulseSel.focusPoint,
    selectiveAttention:impulseSel.selectiveAttention,
    oneImpulseOnly:true,
    stopWhenDone:true,
    avoidPosture:impulseSel.avoidPosture,
    recentExpressions:impulseSel.recentExpressions,
    turnCoverage:impulseSel.turnCoverage??null,
    socialActs:impulseSel.socialActs??[],
    requiresSocialCompletion:Boolean(impulseSel.requiresSocialCompletion),
    relationalActs:impulseSel.relationalActs??[],
    requiresCharacterRealization:Boolean(impulseSel.requiresCharacterRealization),
    // legacy-compatible
    primaryAct:LEGACY_ACTS.has(primary)?primary:"COMMENT",
    secondaryAct:null,
    contextDisposition:impulseSel.contextDisposition,
    adviceAllowed:impulseSel.adviceAllowed,
    closureAllowed:impulseSel.closureAllowed,
    reassureAllowed:impulseSel.reassureAllowed,
    summaryAllowed:impulseSel.summaryAllowed,
    reason:impulseSel.reason,
    repeatedStructure,
    recentAssistantStructures:recentStructures,
    background:impulseSel.background
  };
}

export function naturalResponsePolicyBlock(policy={}){
  return conversationalImpulseBlock(policy);
}

export function naturalRecentExpressionBlock(policy={}){
  return recentExpressionBlock(policy?.recentExpressions??[]);
}

function topicTerms(episodes=[]){
  const terms=new Set();
  for(const episode of Array.isArray(episodes)?episodes:[]){
    if(episode?.stale)continue;
    for(const value of Object.values(episode?.known??{})){
      const text=clean(value);
      if(text.length>=2&&!/^(?:true|false|null|unknown)$/i.test(text))terms.add(text);
    }
    const topic=String(episode?.topic??"");
    if(topic==="dinner")["晚饭","吃饭","面","牛肉面"].forEach(x=>terms.add(x));
    if(topic==="home")["回家","到家"].forEach(x=>terms.add(x));
    if(topic==="sleep")["睡觉","睡了"].forEach(x=>terms.add(x));
    if(topic==="bath")["洗澡","洗完"].forEach(x=>terms.add(x));
    if(topic==="school")["上学","下课","学校"].forEach(x=>terms.add(x));
  }
  return [...terms];
}

export function analyzeNaturalResponse({text="",selection=null,recentEpisodes=[]}={}){
  const value=clean(text);
  const advice=ADVICE_OUTPUT.test(value);
  const closure=CLOSURE_OUTPUT.test(value);
  const question=/[?？]/.test(value);
  let primary="COMMENT";
  if(closure)primary="CLOSURE";
  else if(advice)primary="ADVICE";
  else if(TEASE_OUTPUT.test(value))primary="TEASE";
  else if(question)primary="QUESTION";
  else if(value.length<=10)primary="ACK";
  else if(REACT_OUTPUT.test(value))primary="REACT";
  const secondary=[];
  if(advice&&primary!=="ADVICE")secondary.push("ADVICE");
  if(closure&&primary!=="CLOSURE")secondary.push("CLOSURE");
  if(question&&primary!=="QUESTION")secondary.push("QUESTION");
  const terms=topicTerms(recentEpisodes);
  const multiActExpansion=secondary.length>=2||(primary!=="ACK"&&value.length>80&&(advice&&closure));
  return {
    selectedPrimaryAct:selection?.primaryAct??null,
    selectedSecondaryAct:selection?.secondaryAct??null,
    selectedImpulse:selection?.impulse??null,
    realizedPrimaryAct:primary,
    realizedSecondaryActs:secondary,
    recentEventExplicitlyMentioned:terms.some(term=>value.includes(term)),
    adviceGiven:advice,
    closureGiven:closure,
    currentSituationSummarized:SUMMARY_OUTPUT.test(value),
    contextDisposition:selection?.contextDisposition??null,
    multiActExpansion,
    policyViolations:[
      advice&&!selection?.adviceAllowed?"advice_not_allowed":null,
      closure&&!selection?.closureAllowed?"closure_not_allowed":null,
      SUMMARY_OUTPUT.test(value)&&!selection?.summaryAllowed?"situation_summary_not_allowed":null,
      // one-impulse: casual selective attention should not become completeness dump
      selection?.selectiveAttention==="allowed"&&advice&&closure?"multi_act_expansion":null
    ].filter(Boolean)
  };
}

function parseVisibleCandidate(raw){
  const source=String(raw??"").trim();
  if(!source)return {bubbles:[],visible:"",canonical:null,structural:false,malformed:false};
  let candidate=source;
  const fenced=candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if(fenced)candidate=fenced[1].trim();
  const structural=/^[\[{]/.test(candidate)||/^\s*```(?:json)?/i.test(source);
  const attempts=[candidate];
  if(/^\{\s*"(?:messages|bubbles)"\s*:/i.test(candidate)&&!candidate.trimEnd().endsWith("}"))attempts.push(`${candidate}}`);
  for(const attempt of attempts){
    try{
      const parsed=JSON.parse(attempt);
      const list=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.messages)?parsed.messages:Array.isArray(parsed?.bubbles)?parsed.bubbles:null);
      if(Array.isArray(list)){
        const bubbles=list.map(clean).filter(Boolean).slice(0,3);
        if(bubbles.length)return {bubbles,visible:bubbles.join("\n"),canonical:JSON.stringify({messages:bubbles}),structural:true,malformed:false};
      }
    }catch{}
  }
  return {bubbles:[source],visible:source,canonical:null,structural,malformed:structural};
}

function normalizedForRepeat(value){
  return clean(value).replace(/[\s。.!！?？~～，,]/g,"");
}

/**
 * Inspect candidate before BubblePlan. Thin gate only — no new named guards.
 */
export function inspectNaturalResponseCandidate({rawText="",selection=null,recentAssistantTexts=[],recentRealizedActs=[],userText=""}={}){
  const parsed=parseVisibleCandidate(rawText);
  const analysis=analyzeNaturalResponse({text:parsed.visible,selection});
  const reasons=[...analysis.policyViolations];
  if(parsed.malformed)reasons.push("malformed_structured_output");

  // Coverage floor: explicit question/request/task must not be swallowed.
  const coverage=evaluateReplyCoverage(userText, parsed.bubbles.length?parsed.bubbles:parsed.visible);
  if(!coverage.complete){
    reasons.push("explicit_obligation_uncovered");
  }

  const recent=new Set((Array.isArray(recentAssistantTexts)?recentAssistantTexts:[])
    .map(normalizedForRepeat).filter(Boolean));
  const repeated=parsed.bubbles.length>0&&(parsed.bubbles.length>1||Array.from(parsed.visible).length>6)&&
    parsed.bubbles.every(item=>recent.has(normalizedForRepeat(item)));
  if(repeated)reasons.push("verbatim_recent_reply");

  const realized=analysis.realizedPrimaryAct;
  const acts=Array.isArray(recentRealizedActs)?recentRealizedActs.filter(Boolean):[];
  if(acts.length>=2&&acts.at(-1)===realized&&acts.at(-2)===realized&&!['ACK','CLOSURE'].includes(realized)){
    reasons.push("third_same_response_structure");
  }
  if((realized==="QUESTION"||analysis.realizedSecondaryActs.includes("QUESTION"))&&
    !["QUESTION","CALLBACK"].includes(selection?.primaryAct)&&selection?.secondaryAct!=="QUESTION"){
    reasons.push("unselected_question");
  }
  if(selection?.primaryAct==="ACK"&&(realized!=="ACK"||Array.from(parsed.visible).length>6||parsed.bubbles.length>1))reasons.push("minimal_ack_overanswered");
  if(selection?.primaryAct==="CLOSURE"&&realized!=="CLOSURE")reasons.push("closure_act_not_realized");
  if(selection?.primaryAct==="ADVICE"&&realized!=="ADVICE")reasons.push("requested_advice_not_realized");

  return {
    ok:reasons.length===0,
    reasons:[...new Set(reasons)],
    visibleText:parsed.visible,
    canonicalRaw:parsed.canonical,
    bubbles:parsed.bubbles,
    analysis,
    coverage
  };
}

export function naturalResponseActs(){return [...LEGACY_ACTS];}
export function conversationalImpulseSet(){return conversationalImpulses();}
export { summarizeRecentExpressions };
