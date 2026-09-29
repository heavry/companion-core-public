import crypto from "node:crypto";
import { config } from "./config.js";
import { naturalPresence } from "./natural-presence/index.js";
import { selectVoiceStyle,profileReference,styleLogEntry,appendStyleLog } from "./voice-profiles.js";

// Modality Planner v1：每个 assistant bubble 决定 TEXT / VOICE。
// 不是自动扬声器播放；VOICE 是需点击播放的语音消息气泡。

function stableRoll(key){
  const bytes=crypto.createHash("sha256").update(String(key)).digest();
  return bytes.readUIntBE(0,6)/0x1_0000_0000_0000;
}

function looksTechnical(text){
  return /```|https?:\/\/|function |const |SELECT |API|HTTP|JSON|端口|部署|编译|stack trace|错误码/i.test(String(text??""));
}

function looksToneHeavy(text){
  return /[！!…～~]|哼|哈|哎|啦|嘛|呗|啊{1,}|哈哈|服了|不是吧|行吧/.test(String(text??""))&&String(text??"").length<=40;
}

/**
 * Decide modality for one bubble.
 * Target experience ~70–85% text / 15–30% voice, but driven by state/context.
 */
export function planBubbleModality({
  text="",
  bubbleIndex=0,
  bubbleCount=1,
  userModality="text",
  recentAssistantVoiceRatio=0,
  presence=naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null,
  hour=new Date().getHours(),
  seedKey=""
}={}){
  if(!config.modalityPlannerEnabled)return {modality:"TEXT",reason:"planner_disabled",style:"neutral"};
  const content=String(text??"").trim();
  const len=content.length;
  if(!content)return {modality:"TEXT",reason:"empty",style:"neutral"};
  if(looksTechnical(content)&&len>40)return {modality:"TEXT",reason:"technical_content",style:"neutral"};

  const d=presence?.dimensions??{};
  const cur=k=>Number(d?.[k]?.current??0);
  const mood=cur("mood"),energy=cur("energy"),irritation=cur("irritation"),playfulness=cur("playfulness"),social=cur("social_drive");

  let voiceScore=Number(config.modalityVoiceBias??0.22);
  // presence
  if(mood>=0.35&&energy>=0.62)voiceScore+=0.18;
  if(playfulness>=0.7)voiceScore+=0.08;
  if(irritation>=0.4&&len<=24)voiceScore+=0.16; // short annoyed voice ok
  if(energy<=0.3&&len<=30)voiceScore+=0.1;
  if(social>=0.8&&closenessSafe(d))voiceScore+=0.06;
  // content
  if(looksToneHeavy(content))voiceScore+=0.12;
  if(len<=6)voiceScore+=0.08;
  if(len>80)voiceScore-=0.2;
  if(bubbleCount>=3&&bubbleIndex===0)voiceScore-=0.05;
  // context
  if(userModality==="voice")voiceScore+=0.2;
  if(recentAssistantVoiceRatio>=0.5)voiceScore-=0.25; // avoid all-voice streaks
  if(hour>=23||hour<7)voiceScore-=0.08;
  // late bubbles in a turn: often voice carries the second thought
  if(bubbleCount>=2&&bubbleIndex===bubbleCount-1)voiceScore+=0.06;

  const roll=stableRoll(`${seedKey}|${bubbleIndex}|${content.slice(0,24)}`);
  const voice=roll<Math.max(0,Math.min(0.85,voiceScore));
  const style=selectVoiceStyle({presence,previousStyle:"neutral",bubbleIndex,text:content}).style;
  return {
    modality:voice?"VOICE":"TEXT",
    reason:voice?`voice_score_${voiceScore.toFixed(2)}`:`text_score_${voiceScore.toFixed(2)}`,
    voiceScore:Number(voiceScore.toFixed(3)),
    roll:Number(roll.toFixed(4)),
    style
  };
}

function closenessSafe(d){return Number(d?.closeness?.current??0)>=0.75;}

/**
 * Plan a whole turn. Avoid forcing mixed every time.
 * MIXED only when score split is natural (e.g. short text + longer tone line).
 */
export function planTurnModalities({bubbles=[],userModality="text",sessionId="",presence=null}={}){
  const list=Array.isArray(bubbles)?bubbles.filter(Boolean):[];
  if(!list.length)return {plans:[],mode:"TEXT"};
  const snap=presence??(naturalPresence.enabled?naturalPresence.snapshot({advance:false}):null);
  const seed=sessionId||String(Date.now());
  let recentVoice=0;
  const plans=list.map((text,index)=>{
    const plan=planBubbleModality({
      text,bubbleIndex:index,bubbleCount:list.length,userModality,
      recentAssistantVoiceRatio:recentVoice,presence:snap,seedKey:seed
    });
    if(plan.modality==="VOICE")recentVoice=Math.min(1,recentVoice+0.5);
    else recentVoice=Math.max(0,recentVoice-0.25);
    return {...plan,text};
  });
  const voices=plans.filter(p=>p.modality==="VOICE").length;
  const mode=voices===0?"TEXT":voices===plans.length?"VOICE":"MIXED";
  return {plans,mode};
}

export function resolveVoiceStyleForPlan({plan,presence,previousStyle="neutral"}={}){
  const selected=selectVoiceStyle({
    presence,
    previousStyle:plan?.style??previousStyle,
    bubbleIndex:plan?.bubbleIndex??0,
    text:plan?.text??""
  });
  const reference=profileReference(selected.style);
  return {style:selected.style,reason:selected.reason,reference,metrics:selected.metrics};
}

export function logVoiceStyle(entry){appendStyleLog(entry);}
export { styleLogEntry,profileReference,selectVoiceStyle };
