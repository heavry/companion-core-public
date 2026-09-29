import { config } from "../config.js";
import { classifyRepair, replyHasSpeakerInversion } from "./detect.js";
import { RepairStore, repairStore } from "./store.js";
import { retrieveDiariesForQuery } from "../natural-diary/retrieval.js";

export { classifyRepair, RepairStore, repairStore, replyHasSpeakerInversion };

function clip(value,max=80){return String(value??"").replace(/\s+/g," ").trim().slice(0,max);}

export function applyRepairToGrounding(state,repair,now=new Date()){
  const base=state&&typeof state==="object"?{...state}:{};
  if(!repair?.detected&&!repair?.corrected_interpretation&&!repair?.type)return base;
  const corrected=repair.referent||(["informational","execute"].includes(String(repair.corrected_interpretation||""))?null:repair.corrected_interpretation);
  const next={
    ...base,
    updated_at:(now instanceof Date?now:new Date(now)).toISOString()
  };
  if(corrected){
    next.active_topic=corrected;
    next.recent_referents=[corrected,...(base.recent_referents??[]).filter(x=>x!==corrected&&x!==repair.original_interpretation)].slice(0,8);
    next.recent_topics=[corrected,...(base.recent_topics??[]).filter(x=>x!==corrected)].slice(0,8);
    const bindings={...(base.bindings&&typeof base.bindings==="object"?base.bindings:{})};
    const t=(now instanceof Date?now:new Date(now)).getTime();
    bindings["那个"]={label:"那个",meaning:corrected,bound_at:t,source:"repair"};
    bindings["这个"]={label:"这个",meaning:corrected,bound_at:t,source:"repair"};
    if(repair.original_interpretation){
      const from=String(repair.original_interpretation);
      if(bindings[from])delete bindings[from];
    }
    next.bindings=bindings;
  }
  if(repair.intent==="informational"||repair.corrected_intent==="informational")next.repair_intent="informational";
  return next;
}

export function repairSemanticFacts(repair){
  const facts=[];
  const source=repair?.correction_source||"user";
  facts.push(`correction_source=${source}`);
  if(repair?.corrected_subject)facts.push(`corrected_subject=${repair.corrected_subject}`);
  if(repair?.actor)facts.push(`actor=${repair.actor}`);
  if(repair?.error_owner)facts.push(`error_owner=${repair.error_owner}`);
  if(repair?.requested_action)facts.push(`requested_action=${repair.requested_action}`);
  if(repair?.corrected_intent||repair?.intent)facts.push(`corrected_intent=${repair.corrected_intent||repair.intent}`);
  if(repair?.referent)facts.push(`referent=${clip(repair.referent,40)}`);
  if(repair?.type==="INTENT_CORRECTION"||repair?.corrected_intent==="informational"){
    facts.push("语义：用户只是在询问，没有让你修改或执行。");
    facts.push("承认后继续回答原问题，不要动手改东西。");
  }
  if(repair?.type==="REFERENT_CORRECTION"&&repair.corrected_interpretation){
    facts.push(`语义：用户指的对象是 ${clip(repair.corrected_interpretation,40)}，不是 ${clip(repair.original_interpretation,40)}。`);
    facts.push(`回应用「你说的是 ${clip(repair.corrected_interpretation,40)}」，不要说「我说的是…」。`);
  }
  if(repair?.type==="FACT_CORRECTION"&&repair.actor==="user"){
    facts.push(`语义：这件事的主体是用户。纠正后的事实属于用户，不是你。`);
  }
  if(repair?.type==="FACT_CORRECTION"&&repair.actor==="assistant"){
    facts.push("语义：刚才说话/出错的人是你，不是用户。");
  }
  if(repair?.type==="FACT_CORRECTION"&&repair.original_interpretation&&repair.corrected_interpretation&&repair.actor!=="assistant"){
    facts.push(`语义：时间/对象从 ${clip(repair.original_interpretation,20)} 改为 ${clip(repair.corrected_interpretation,20)}。`);
  }
  if(repair?.type==="MEMORY_CORRECTION"||repair?.error_owner==="assistant"){
    facts.push("语义：记错的人是你（assistant），不是用户。");
  }
  return facts;
}

export function repairGuidanceBlock(repair,presenceLabels=[],diaryNote=null){
  if(!repair?.detected&&!repair?.type)return "";
  const lines=["【Natural Repair｜语义事实｜禁止照抄用户第一人称】"];
  lines.push(`type=${repair.type}; confidence=${Number(repair.confidence??0).toFixed(2)}`);
  lines.push("代词映射：用户说的「我」=用户；用户说的「你」=你（林小糖）。禁止把用户的「我…」复述成你自己的「我…」。");
  lines.push("不要逐字复述纠正句。承认语义后改行为即可。");
  if(repair.needsClarification){
    lines.push("用户只说「不对」，当前有不止一个可能错点。");
    if(repair.possible_errors?.length)lines.push(`possible=${repair.possible_errors.join(" | ")}`);
    lines.push("不要自己猜一个 correction。自然问「哪块不对？」或「你说我刚才哪句串了？」");
    return lines.join("\n");
  }
  for(const fact of repairSemanticFacts(repair))lines.push(fact);
  const object=repair.referent||(["informational","execute"].includes(String(repair.corrected_interpretation||""))?null:repair.corrected_interpretation);
  if(object)lines.push(`之后「那个 / 这个 / 它」优先指 ${clip(object,40)}。被纠正掉的说法不要再抢占。`);
  if(repair.type==="MEMORY_CORRECTION"){
    lines.push("当前回答不要再用这条冲突记忆。不要批量删除记忆，也不要为了面子坚持。");
  }
  if(repair.type==="DIARY_CORRECTION"){
    lines.push(diaryNote||"先按已检索的日记回答。日记里没有的不要编。");
  }
  const irritated=presenceLabels.includes("irritated");
  const low=presenceLabels.includes("low")||presenceLabels.includes("tired");
  if(repair.type==="INTENT_CORRECTION"){
    lines.push(irritated?"短承认：行，你只是问问，那我不动。然后直接答问题。":"自然承认：哦，懂了，你只是问问。然后继续说情况，不要执行。");
  }else if(irritated)lines.push("语气可以短：行，是这个，我刚才串了。不要客服式长道歉。");
  else if(low)lines.push("可以轻声承认记混了，重新对一下。不要反复道歉。");
  else lines.push("小误解用「哦，你说的是那个」「啊，串了」即可。明显误会才可以自然抱歉一句，不要每次非常抱歉。");
  lines.push("嘴上承认之后，后续指代和行动必须真的改过来。");
  return lines.join("\n");
}

export function noteDiaryRepair(userText,personaId){
  const retrieved=retrieveDiariesForQuery(userText,{personaId,limit:2});
  const blob=(retrieved.entries??[]).map(e=>`${e.dateLocal}:${e.body}`).join("\n");
  const claim=String(userText??"");
  const mentioned=(claim.match(/写(?:了|过)?(.{1,16}?)(?:了|吗|呢|？|\?|$)/)||[])[1];
  const needle=String(mentioned||"").replace(/了|吗|呢|啊/g,"").trim();
  const found=needle&&blob.includes(needle);
  if(/没(?:有)?写|根本没/.test(claim)){
    return {found:false,note:blob?`已查日记。用户指出的内容未出现。不要编，直接说没有。检索日期：${(retrieved.entries||[]).map(e=>e.dateLocal).join(",")||"无"}`:"已查，没有对应日记内容。不要编。"};
  }
  return {found:Boolean(found),note:found?`日记里确有相关：不要否认。`:`已检索日记，没有「${needle||"该内容"}」。不要为了面子编造。`};
}

export function processUserRepair({
  sessionId,
  userText,
  lastAssistantText="",
  groundingState=null,
  focusTopics=[],
  presenceLabels=[],
  personaId=config.defaultPersonaId,
  messageId=null,
  now=new Date()
}={}){
  if(config.naturalRepairEnabled===false)return {detected:false,reason:"disabled"};
  const classified=classifyRepair({
    userText,lastAssistantText,
    activeTopic:groundingState?.active_topic??null,
    recentReferents:groundingState?.recent_referents??[],
    focusTopics,now
  });
  if(!classified.detected)return classified;
  let diaryNote=null;
  if(classified.type==="DIARY_CORRECTION"){
    const diary=noteDiaryRepair(userText,personaId);
    diaryNote=diary.note;
    classified.diaryFound=diary.found;
  }
  const record=repairStore.add(sessionId,{
    ...classified,
    source_message_ids:messageId!=null?[String(messageId)]:[],
    ttl_hours:classified.type==="INTENT_CORRECTION"?6:12
  },now);
  const grounding=applyRepairToGrounding(groundingState,record,now);
  const guidance=repairGuidanceBlock(record,presenceLabels,diaryNote);
  console.log("[repair]",JSON.stringify({
    detected:true,
    type:record.type,
    from:record.original_interpretation,
    to:record.corrected_interpretation,
    correction_source:record.correction_source,
    corrected_subject:record.corrected_subject,
    requested_action:record.requested_action,
    corrected_intent:record.corrected_intent,
    actor:record.actor,
    referent:record.referent,
    confidence:record.confidence
  }));
  return {detected:true,...classified,record,grounding,guidance,diaryNote};
}

export function currentRepair(sessionId,now=new Date()){
  return repairStore.current(sessionId,now);
}

export function expireRepairOnShift(sessionId){
  repairStore.deactivate(sessionId);
}
