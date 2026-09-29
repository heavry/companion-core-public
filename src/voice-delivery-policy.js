const VOCATIVE_EDGE=/^(?:(?:宝宝|宝贝|宝|亲爱的)[呀啊啦嘛呢，,。！!？?、~～]*)+|(?:(?:宝宝|宝贝|宝|亲爱的)[呀啊啦嘛呢，,。！!？?、~～]*)+$/gu;
const TRAILING_PARTICLES=/[呀啊啦嘛呢吧哦哈呐诶喔]+$/u;
const VOICE_NOUN=/(?:语音|声音)/u;
const VOICE_ACTION=/(?:出声|发声|开口(?:说)?|说出来|说给我听|听你说|直接说|念给我听|读给我听|朗读|说(?:一?句|句话|一声|点什么)(?:给我听)?)/u;
const NO_TYPING=/(?:别|不要|不用)\s*打字/u;
const TEXT_ONLY_PATTERNS=[
  /(?:不要|不用|不想|别|取消)(?:发|用|要|听)?(?:任何)?语音/u,
  /(?:不是|并非)(?:想|要|在要)?语音/u,
  /(?:只|就|还是|这次只)(?:用|要)?(?:打字|文字|文本)/u,
  /这次(?:用|要)?(?:打字|文字|文本)/u,
  /(?:我要|给我|请用|改用|用)(?:打字|文字|文本)/u,
  /(?:打字|文字|文本)(?:就行|即可|回复|回我)/u,
  /文字说/u,
  /(?:别说话|别说了|不要说话|不要出声|别出声).{0,8}(?:打字|文字|文本)?/u,
  /^\s*(?:打字|文字|文本)\s*$/u,
  /text\s*only/i
];
const DISCUSSION_ONLY=/(?:模型|功能|实现|原理|接口|服务|配置|状态|进程|工具|能力|支持|tts|gpt[\s-]*sovits|sovits|为什么|为何|怎么|如何|是不是|是否|检查|排查|刚才|之前|没出来|没有出来|失败|报错|idle)/iu;
const INTIMATE_STYLE=/(?:那种声音|那种叫(?:法|声)?|浪叫|淫叫|叫床|骚叫|发情|喘着(?:说|叫)?|边叫边说|用骚|浪着说|用叫的声音|叫给我听|用那种叫)/u;
const INTIMATE_NEGATE=/(?:不要|不用|不想|别|取消).{0,10}(?:那种声音|那种叫|浪叫|淫叫|叫床|骚叫|发情)|(?:普通|正常|日常)(?:声音|说话|说)/u;
const INTIMATE_DISCUSSION=/(?:是什么|什么意思|什么叫|原理|实现|模型|功能|怎么做|如何实现|为什么)/u;
const INTIMATE_PERFORM=/(?:用(?:语音)?(?:那种声音|那种叫(?:法|声)?|叫的声音).{0,16}(?:说|喊|叫|回复|回我)|(?:那种声音).{0,12}(?:说|喊|叫)|(?:要|给我|来|请|帮我|再|在).{0,8}(?:那种声音|浪叫|淫叫|叫床|骚叫)|(?:浪叫|淫叫|叫床).{0,4}(?:给我听|一下|一点|一些|好不好)|喘着(?:说|叫)|边叫边说)/u;
const REQUEST_MARKER=/(?:要|想|给我|帮我|请|来(?:一|句|条|段|个)?|发(?:一|句|条|段)?|用|这次|现在|直接|回复|回我|告诉我|说|听|念|读|朗读|开口)/u;
const STRONG_VOICE_REQUEST=/(?:要|来(?:一|句|条|段)?|发(?:一|句|条|段)?)(?:个|一条|条|句|段)?语音|(?:我要|我想|想)听(?:你说|你的声音|语音)|用(?:语音|声音).{0,6}(?:回复|回我|跟我说|和我说|说|告诉我)|(?:语音|声音).{0,6}(?:回复|回我|告诉我|说)|(?:说给我听|听你说|听你的声音|别打字|不要打字|直接说|开口说|说出来)/u;

const EMOTIONS={
  excited:["太棒","好激动","迫不及待","难以置信","太开心","真的太好了","恭喜"],
  sad:["很难过","好难过","心疼","想哭","失去","遗憾","抱抱你"],
  worried:["很担心","好担心","害怕","焦虑","不安","千万小心","我在这里"]
};

export function normalizeVoiceIntentText(text){
  let value=String(text??"").normalize("NFKC").trim().toLowerCase();
  value=value.replace(VOCATIVE_EDGE,"").replace(VOCATIVE_EDGE,"").trim();
  value=value.replace(TRAILING_PARTICLES,"").replace(/[\s，,。！!？?、~～：:；;“”'‘’]+/gu,"");
  return value;
}

export function analyzeVoiceDeliveryIntent(text){
  const raw=String(text??"");
  const normalized=normalizeVoiceIntentText(raw);
  const explicitTextOnly=TEXT_ONLY_PATTERNS.some(pattern=>pattern.test(raw))||TEXT_ONLY_PATTERNS.some(pattern=>pattern.test(normalized));
  if(explicitTextOnly)return {normalized,explicitVoice:false,explicitTextOnly:true,preference:"text"};
  const noTyping=NO_TYPING.test(raw)||NO_TYPING.test(normalized);
  const hasVoiceOutput=VOICE_NOUN.test(normalized)||VOICE_ACTION.test(normalized)||noTyping||/speak(?:ittome|tome|this)?/i.test(normalized);
  const shortVoiceUtterance=VOICE_NOUN.test(normalized)&&normalized.length<=6;
  const request=REQUEST_MARKER.test(normalized)||shortVoiceUtterance||noTyping;
  const discussion=DISCUSSION_ONLY.test(normalized);
  const strongRequest=STRONG_VOICE_REQUEST.test(normalized)||noTyping;
  const explicitVoice=hasVoiceOutput&&request&&(!discussion||strongRequest);
  return {normalized,explicitVoice,explicitTextOnly:false,preference:explicitVoice?"tts":null};
}

export function explicitVoicePreference(text){
  return analyzeVoiceDeliveryIntent(text).preference;
}

export function analyzeIntimateVoiceIntent(text){
  const raw=String(text??"");
  const normalized=normalizeVoiceIntentText(raw);
  if(INTIMATE_NEGATE.test(raw)||INTIMATE_NEGATE.test(normalized))return {normalized,explicitIntimate:false};
  const discussing=INTIMATE_DISCUSSION.test(normalized)||DISCUSSION_ONLY.test(normalized);
  if(/淫叫/u.test(raw)||/淫叫/u.test(normalized)){
    if(discussing)return {normalized,explicitIntimate:false};
    return {normalized,explicitIntimate:true};
  }
  const perform=INTIMATE_PERFORM.test(raw)||INTIMATE_PERFORM.test(normalized);
  if(discussing&&!perform)return {normalized,explicitIntimate:false};
  if(perform)return {normalized,explicitIntimate:true};
  if(!INTIMATE_STYLE.test(raw)&&!INTIMATE_STYLE.test(normalized))return {normalized,explicitIntimate:false};
  return {normalized,explicitIntimate:normalized.length<=8};
}

export function inferEmotionHint(text){
  const value=String(text??"").trim();
  if(!value)return {emotion:"neutral",emotion_intensity:0};
  let best={emotion:"neutral",matches:0};
  for(const [emotion,phrases] of Object.entries(EMOTIONS)){
    const matches=phrases.reduce((count,phrase)=>count+(value.includes(phrase)?1:0),0);
    if(matches>best.matches)best={emotion,matches};
  }
  const exclamations=Math.min(3,(value.match(/[！!]/g)??[]).length);
  const expressiveEmoji=Math.min(2,(value.match(/[🥹😭😢😰😟😄🥳🎉❤💗💛✨]/gu)??[]).length);
  const repetition=/(.)\1{2,}|(?:太|好|真的|特别).{0,8}(?:太|好|真的|特别)/u.test(value)?1:0;
  const directFeeling=/(?:我|真的)(?:很|好|太|特别)?(?:开心|激动|难过|担心|害怕|心疼)/u.test(value)?1:0;
  const score=Math.min(1,best.matches*.38+exclamations*.08+expressiveEmoji*.12+repetition*.1+directFeeling*.18);
  return {emotion:best.matches?best.emotion:"neutral",emotion_intensity:Number(score.toFixed(2))};
}

export function hasHeavyTechnicalContent(text){
  const value=String(text??"");
  const code=(value.match(/```|`[^`]+`/g)??[]).length;
  const urls=(value.match(/https?:\/\/\S+/gi)??[]).length;
  const paths=(value.match(/(?:^|\s)(?:~\/|\/Users\/|\/[A-Za-z0-9_.-]+\/)[^\s]*/gm)??[]).length;
  const tableLines=value.split("\n").filter(line=>/^\s*\|.*\|\s*$/.test(line)).length;
  const logLines=value.split("\n").filter(line=>/^\s*(?:\[[^\]]+\]|\d{4}-\d\d-\d\d|ERROR|WARN|INFO)/i.test(line)).length;
  return code+urls+paths+Math.min(3,tableLines)+Math.min(3,logLines)>=3;
}

export function decideVoiceDelivery({mode="manual",enabled=true,userText="",assistantText="",emotion,emotionIntensity}={}){
  const preference=explicitVoicePreference(userText);
  const intimate=analyzeIntimateVoiceIntent(userText);
  const inferred=inferEmotionHint(assistantText);
  const hint={emotion:String(emotion??inferred.emotion),emotion_intensity:Math.max(0,Math.min(1,Number(emotionIntensity??inferred.emotion_intensity)||0))};
  let voice_delivery="text",reason="default_text",voice_style="daily";
  if(enabled&&preference!=="text"){
    if(preference==="tts"){voice_delivery="tts";reason="explicit_user_request";}
    else if(intimate.explicitIntimate){voice_delivery="tts";reason="explicit_intimate_voice";}
    else if(mode==="auto"){voice_delivery="tts";reason="auto_mode";}
    else if(mode==="emotion"&&hint.emotion_intensity>=.8&&!hasHeavyTechnicalContent(assistantText)){voice_delivery="tts";reason="strong_emotion";}
  }
  if(voice_delivery==="tts"&&intimate.explicitIntimate)voice_style="intimate";
  return {voice_delivery,reason,voice_style,...hint};
}
