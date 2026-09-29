const DISBELIEF_RE=/^(不是吧|不会吧|你不是吧)([哈呵啊]*|！|!)?$|^不是[，, ]?我笑死|^不是吧哈哈/;
const VAGUE_WRONG_RE=/^(不对|错了|你错了|搞错了|不是这样)[了啊呀]?[。.!！]?$/;
const INTENT_RE=/我不是让你(?:修|改|做|弄|执行)|没让你(?:改|修|做)|我只是问问|不是让你(?:改|修)|我没让你改/;
const MEMORY_RE=/你记错了|我什么时候说过|我没有说过|我没(?:有)?养|这个你记错|你刚才记错/;
const DIARY_RE=/日记(?:里|中)?(?:根本)?没(?:有)?写|日记是不是写|你昨天日记是不是/;
const SELF_RE=/等等[，,]?我刚才说错|我刚才说错了|我串了[。.!！]?$/;
const DATE_SWAP_RE=/不是\s*(昨天|前天|今天|上周)\s*[，,]?\s*是\s*(昨天|前天|今天|上周)/;
const USER_TIME_FACT_RE=/我(昨天|前天|今天)没去[，,]?是(昨天|前天|今天)去的/;
const ACTOR_USER_RE=/不是你[，,]?是我(?:弄的|做的|说的|干的)?/;
const ACTOR_ASSISTANT_RE=/不是我[，,]?是你(?:刚才说的|说的|弄的|做的)?/;
const NOT_X_IS_Y_RE=/不是\s*([^，,。！!?]{1,24}?)\s*[，,。]?\s*(?:是|我说的是)\s*([^，,。！!?]{1,40})/;
const I_MEAN_RE=/我说的是\s*([^，,。！!?]{1,40}?)(?:\s*(?:[，,。]|不是)|$)/;

function clip(value,max=80){
  return String(value??"").replace(/\s+/g," ").trim().slice(0,max);
}

function looksLikeDisbelief(text){
  const t=String(text??"").trim();
  if(!t)return false;
  if(DISBELIEF_RE.test(t))return true;
  if(/^(不是吧哈哈|不是，我笑死)/.test(t))return true;
  if(t.length<=8&&/不是吧/.test(t)&&/哈|呵|笑/.test(t))return true;
  return false;
}

function extractSwap(text){
  const raw=String(text??"").trim();
  const date=raw.match(DATE_SWAP_RE);
  if(date)return {from:date[1],to:date[2],kind:"fact"};
  const pair=raw.match(NOT_X_IS_Y_RE);
  if(pair){
    const from=clip(pair[1].replace(/^(这个|那个|我说的)?/,""),24);
    const to=clip(pair[2],40);
    if(from&&to&&from!==to)return {from,to,kind:"referent"};
  }
  const mean=raw.match(I_MEAN_RE);
  if(mean)return {from:null,to:clip(mean[1],40),kind:"referent"};
  return null;
}

function inferOriginal(lastAssistantText,corrected){
  const last=String(lastAssistantText??"");
  if(!last)return null;
  const candidates=[...last.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,24}|[\u4e00-\u9fa5]{2,12}/g)].map(m=>m[0]);
  const to=String(corrected??"");
  return candidates.find(c=>c&&!to.includes(c)&&!c.includes(to.slice(0,2)))??null;
}

function ownership(extra={}){
  return {
    correction_source:extra.correction_source??"user",
    corrected_subject:extra.corrected_subject??"object",
    requested_action:extra.requested_action??null,
    corrected_intent:extra.corrected_intent??null,
    actor:extra.actor??null,
    error_owner:extra.error_owner??null,
    referent:extra.referent??null
  };
}

function isPronounSwapTarget(value){
  return /^(你|我|他|她)(?:弄的|做的|说的|干的|刚才说的)?$/.test(String(value??"").trim());
}

/**
 * Heuristic repair classifier. "不是" alone is not enough.
 */
export function classifyRepair({
  userText="",
  lastAssistantText="",
  activeTopic=null,
  recentReferents=[],
  focusTopics=[],
  now=new Date()
}={}){
  const text=String(userText??"").trim();
  if(!text)return {detected:false,reason:"empty"};
  if(looksLikeDisbelief(text))return {detected:false,reason:"disbelief"};

  if(SELF_RE.test(text)){
    return {detected:true,type:"SELF_CORRECTION",confidence:0.8,original_interpretation:activeTopic,corrected_interpretation:null,needsClarification:false,...ownership({correction_source:"assistant",corrected_subject:"assistant",error_owner:"assistant"})};
  }

  if(VAGUE_WRONG_RE.test(text)){
    const possible=[lastAssistantText,activeTopic,...(recentReferents??[]),...(focusTopics??[])].map(x=>clip(x,40)).filter(Boolean);
    const uniq=[...new Set(possible)].slice(0,4);
    if(uniq.length>=2){
      return {detected:true,type:"AMBIGUOUS_CORRECTION",confidence:0.72,needsClarification:true,possible_errors:uniq,original_interpretation:null,corrected_interpretation:null};
    }
    return {detected:true,type:"AMBIGUOUS_CORRECTION",confidence:0.6,needsClarification:true,possible_errors:uniq,original_interpretation:activeTopic,corrected_interpretation:null};
  }

  if(ACTOR_USER_RE.test(text)){
    return {
      detected:true,type:"FACT_CORRECTION",confidence:0.92,needsClarification:false,
      original_interpretation:"assistant",corrected_interpretation:"user",
      topic:clip(activeTopic||"动作主体",40),
      ...ownership({correction_source:"user",corrected_subject:"user",actor:"user",requested_action:null,referent:clip(activeTopic,40)})
    };
  }
  if(ACTOR_ASSISTANT_RE.test(text)){
    return {
      detected:true,type:"FACT_CORRECTION",confidence:0.92,needsClarification:false,
      original_interpretation:"user",corrected_interpretation:"assistant",
      topic:clip(activeTopic||"说话主体",40),
      ...ownership({correction_source:"user",corrected_subject:"assistant",actor:"assistant",error_owner:"assistant",referent:clip(activeTopic,40)})
    };
  }

  if(INTENT_RE.test(text)){
    return {
      detected:true,type:"INTENT_CORRECTION",confidence:0.9,needsClarification:false,
      original_interpretation:"execute",corrected_interpretation:"informational",
      intent:"informational",topic:clip(activeTopic||"当前话题",40),
      ...ownership({correction_source:"user",corrected_subject:"user",requested_action:"none",corrected_intent:"informational",actor:"user",referent:clip(activeTopic,40)})
    };
  }

  const timeFact=text.match(USER_TIME_FACT_RE);
  if(timeFact){
    return {
      detected:true,type:"FACT_CORRECTION",confidence:0.93,needsClarification:false,
      original_interpretation:timeFact[1],corrected_interpretation:timeFact[2],
      topic:clip(activeTopic||timeFact[2],40),
      ...ownership({correction_source:"user",corrected_subject:"user",actor:"user",referent:clip(activeTopic,40)})
    };
  }

  if(DIARY_RE.test(text)){
    const claim=clip((text.match(/写(?:了)?(.{1,20})/)||[])[1]||text,40);
    return {detected:true,type:"DIARY_CORRECTION",confidence:0.86,needsClarification:false,original_interpretation:claim,corrected_interpretation:null,topic:"diary",...ownership({correction_source:"user",corrected_subject:"assistant",error_owner:"assistant"})};
  }

  if(MEMORY_RE.test(text)){
    const topic=clip((text.match(/没(?:有)?养(.{1,8})/)||[])[1]||(/猫/.test(text)?"猫":activeTopic||"该记忆"),20);
    const suppressTopics=[topic,/猫/.test(text)?"猫":null].filter(Boolean);
    return {
      detected:true,type:"MEMORY_CORRECTION",confidence:0.88,needsClarification:false,
      original_interpretation:topic,corrected_interpretation:null,suppressTopics,
      ...ownership({correction_source:"user",corrected_subject:"assistant",error_owner:"assistant",actor:null})
    };
  }

  const swap=extractSwap(text);
  if(swap?.to){
    if(isPronounSwapTarget(swap.from)||isPronounSwapTarget(swap.to)){
      const toUser=/^我/.test(String(swap.to||""));
      const toAssistant=/^你/.test(String(swap.to||""));
      const actor=toUser?"user":toAssistant?"assistant":"object";
      return {
        detected:true,type:"FACT_CORRECTION",confidence:0.9,needsClarification:false,
        original_interpretation:clip(swap.from,24),corrected_interpretation:clip(swap.to,40),
        topic:clip(activeTopic||swap.to,40),
        ...ownership({correction_source:"user",corrected_subject:actor,actor,referent:clip(activeTopic,40)})
      };
    }
    const original=swap.from||inferOriginal(lastAssistantText,swap.to)||clip(activeTopic,40);
    const dateWord=/^(昨天|前天|今天|上周)$/;
    const type=swap.kind==="fact"||(dateWord.test(String(swap.from||""))&&dateWord.test(String(swap.to||"")))?"FACT_CORRECTION":"REFERENT_CORRECTION";
    const subject=type==="FACT_CORRECTION"&&dateWord.test(String(swap.to||""))?"object":"object";
    return {
      detected:true,type,confidence:swap.from?0.94:0.86,needsClarification:false,
      original_interpretation:original,corrected_interpretation:swap.to,topic:swap.to,
      ...ownership({correction_source:"user",corrected_subject:subject,actor:type==="FACT_CORRECTION"?null:"object",referent:swap.to})
    };
  }

  return {detected:false,reason:"no_correction"};
}

export function replyHasSpeakerInversion(assistantText,repair){
  if(!repair||repair.detected===false)return false;
  const t=String(assistantText??"");
  if(!t.trim())return false;
  if((repair.type==="INTENT_CORRECTION"||repair.corrected_intent==="informational")&&repair.corrected_subject==="user"){
    if(/我只是问问|我就是在问问|就是在问问/.test(t)&&!/你只是问问|你就是问问/.test(t))return true;
  }
  if(repair.type==="REFERENT_CORRECTION"&&repair.correction_source==="user"&&repair.corrected_interpretation){
    const obj=String(repair.corrected_interpretation).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    if(new RegExp(`我说的是\\s*${obj}`).test(t))return true;
  }
  if(repair.actor==="user"&&repair.type==="FACT_CORRECTION"){
    if(/我(?:昨天|前天)去了|我前天去的/.test(t)&&!/你(?:昨天|前天)/.test(t))return true;
  }
  if(repair.actor==="user"&&repair.corrected_subject==="user"&&/不是你是我/.test(String(repair.corrected_interpretation||""))){
    if(/是我弄的/.test(t)&&!/是你弄的|你弄的/.test(t))return true;
  }
  return false;
}

export { looksLikeDisbelief, extractSwap, ownership };
