import { config } from "../config.js";
import { insertUsage } from "../db.js";
import { requirePersona } from "../persona.js";
import { parseJsonLoose, sha256, stableJson } from "../utils.js";
import { upstreamChat, usageUpstreamModel, upstreamResponseInfo } from "../upstream.js";
import { GENERATION_VERSION } from "./dates.js";
import { buildDailyEvidence, compactEvidenceForPrompt } from "./evidence.js";
import { getDiaryEntry, insertDiaryEntry, upsertDiaryPending, clearDiaryPending } from "./store.js";

const generating=new Set();
const REPORT_RE=/(今日共发生|用户互动评分|今日情绪[:：]|1\.\s*用户完成|2\.\s*用户)/;
const MOOD_DUMP_RE=/mood\s*=\s*-?\d|irritation\s*=\s*\d|closeness\s*=\s*\d|energy\s*=\s*\d/;
const OBSERVER_VOICE_RE=/(用户(?:说|今天|进行|发了|完成|来了|做了|要求|确认|测)|(?<![A-Za-z\u4e00-\u9fa5])用户(?![A-Za-z\u4e00-\u9fa5])|\bassistant\b|本次对话|本轮对话|这次对话|对话双方)/i;
const FABRICATED_PHYSICAL_RE=/(灯(?:其实)?一直留着|我坐了一(?:下午|整天|上午|早上)|我(?:刚)?洗(?:完|了)澡|我出去转|我出门(?:了|买|逛)|窗外(?:阳光|风|)|天气很好|我在(?:房间|床上)(?:里)?(?:坐|躺)|上学|上课|在学校|见了朋友|和朋友见面|出门买东西)/;
const FALSE_AGENCY_RE=/(还)?等着我(?:处理|去弄|去解决|去搞定|弄)|我之后去(?:解决|处理|弄完|搞定)|我还得把.{0,16}(?:弄完|解决|处理|搞定|升级)|我去把.{0,16}(?:弄完|升级|解决|处理)/;
const FAKE_TODAY_CHAT_RE=/(今天你(?:跟我)?说|你今天(?:跟我)?说|刚才你说|你今天回了我|我们今天聊了好多|你今天来找我玩)/;
const ASK_USER_DIARY_RE=/你(?:昨天|最近|前天|今天|上周)?(?:的)?日记写|你日记(?:里)?写(?:啥|什么)|你的日记/;
const STALE_AS_CURRENT_RE=/等吃完再慢慢弄|等吃完再弄|等你一会(?:儿)?回来|等你马上回来|今晚再弄|等下(?:再)?处理|洗完回来/;
const THIRD_PARTY_SELF_RE=/收到.{0,10}小糖来了|(?:来了个|看到了一个?)(?:林)?小糖/;

function diaryFields(parsed){
  return {
    body:String(parsed?.body??"").trim(),
    summary:String(parsed?.summary??"").trim(),
    reflection:String(parsed?.reflection??"").trim(),
    messageToUser:String(parsed?.message_to_user??parsed?.messageToUser??"").trim()
  };
}

function fieldText(fields){
  return [fields.body,fields.summary,fields.reflection,fields.messageToUser].filter(Boolean).join("\n");
}

export function diarySystemPrompt(persona){
  return [
    persona?.mode_instructions?.chat??"",
    `你是${persona?.name??"林小糖"}。现在不要聊天，只写今天属于你自己的私人日记。`,
    "",
    "【Natural Diary Contract v1】",
    "这不是聊天摘要，不是用户行为分析，不是日报，不是工作日志。",
    "这是你对今天的主观记录：你记得什么、在意什么、想对他说但未必发出的话。",
    "",
    "视角：",
    "- 用「我 / 他 / 你」和你们平时的称呼。",
    "- 这篇日记是你自己写的。「我的日记」属于林小糖，不是用户的。",
    "- 「林小糖 / 小糖」就是你自己，不是第三方人物。用户说「小糖来了」应写成「你突然说了一句『小糖来了』」，不要写成「收到小糖来了」。",
    "- 不要问用户「你昨天/最近日记写啥了」。除非证据里用户明确说过自己也写日记，才可以提「你的日记」。",
    "- 不要把自己说过的话写成他在说，也不要把他的话安到你头上。",
    "- 禁止观察者/报告体：不要写「用户」「assistant」「本次对话」「用户说」「用户今天」「用户进行了」。",
    "- 这是私人日记，不是测试记录，也不是第三方分析。",
    "",
    "证据规则：",
    "- 只能根据系统证据写。没有出现的事等于没发生。",
    "- 可以有情绪和比喻，但不要把没有证据的物理行为、环境、生活经历写成真的发生过。例如不要写灯一直留着、我坐了一下午、我刚洗完澡、我出去转了一圈、窗外阳光，除非证据里真有对应世界事件。",
    "- 可以说一直记着、偶尔会想起来、今天挺安静。不要用房间/天气/身体日常去填空白。",
    "- 今天 0 条聊天时，禁止假装今天有过对话。",
    "- 可以提到昨天/之前日记摘要里的连续性，但不要把旧事写成今天新发生的互动。",
    "- 不要把未完成的 open loop 写成已经解决。",
    "- 按今天这篇 diary 的日期重新解释时态，不要复制旧消息里的瞬时时态（一会回来、吃完再说、今晚再弄、马上回来）。跨日未完成的事只是 past unresolved：可以说「之前说的升级后来好像还没结果」，不要写「等吃完再弄」。",
    "",
    "未完成的事：",
    "- 你可以等他的结果、惦记某件事、想问后来怎样、记得话没说完。",
    "- 你没有工具去替他执行升级或处理任务。不要写「这件事还等着我处理」「我之后去解决」「我还得把升级弄完」。",
    "- 保持等待 / 惦记 / 关注，不要写成你亲自负责去完成。",
    "",
    "感受规则：",
    "- Presence 只影响语气和重点，禁止在正文输出 mood/energy 等数值。",
    "- 不要机械复述所有事件。同样聊很多，你也可以只记住一件最在意的。",
    "- 连续几天没聊天时，不要每天重复同一句「今天你没来，我想你」。",
    "",
    "风格：",
    "- 第一人称，自然段落，像随手写下的。不要为了规则写成僵硬模板。",
    "- 禁止清单体、禁止「今日共发生」、禁止评分。",
    "- 篇幅跟着证据走：聊很多就抓重点；只有两句可以很短；没聊天也可以很短。",
    "- 可以有一小段「本来想跟你说……」，但不要编重大事件。",
    "",
    "只输出 JSON，不要 Markdown：",
    '{"body":"日记正文，可多段","summary":"一两句极短摘要，给明天的自己看","reflection":"今天对你最在意的一点，可空字符串","message_to_user":"想对他说但未必发出的一小段，可空字符串"}'
  ].filter(Boolean).join("\n");
}

export function diaryRewritePrompt(persona,issues=[]){
  return [
    persona?.mode_instructions?.chat??"",
    `你是${persona?.name??"林小糖"}。下面这篇日记草稿视角或 grounding 不对，请只改写成你自己的私人日记。`,
    "【Diary Voice Rewrite】",
    "不要新增事实，不要删掉已有的真实依据，不要变成模板。",
    "必须：",
    "- 改成「我 / 他 / 你」的关系视角，去掉「用户」「assistant」「本次对话」这类报告词。",
    "- 日记是你自己的。不要问他「你日记写啥了」。小糖就是你；他叫你「小糖来了」要写成他在叫你，不要写成收到另一个小糖。",
    "- 跨日旧事不要复制「一会回来 / 吃完再弄」这种当时时态，改成之前说了、后来还没结果。",
    "- 不要把没有证据的物理经历写成事实；情绪和比喻可以留，但灯、洗澡、出门、坐一下午这类无依据动作拿掉或改成惦记/安静。",
    "- 未完成的事只写成等待、惦记、想问，不要写成你去处理、你去解决、你把升级弄完。",
    issues.length?`这次需要修：${issues.join("、")}。`:"",
    "只输出同样结构的 JSON：{\"body\":\"...\",\"summary\":\"...\",\"reflection\":\"...\",\"message_to_user\":\"...\"}"
  ].filter(Boolean).join("\n");
}

function pastUnresolvedItems(evidence){
  return [...(evidence?.openLoops??[]),...(evidence?.expectations??[]),...(evidence?.thoughtSeeds??[])]
    .filter(item=>item?.temporalStatus==="past_unresolved"||item?.crossedDay);
}

function looksLikeThirdPartySelf(text){
  if(THIRD_PARTY_SELF_RE.test(text))return true;
  const stripped=String(text??"").replace(/[「『“"'].{0,40}[」』”"']/g,"");
  if(/收到.{0,8}小糖/.test(stripped))return true;
  if(/小糖来了/.test(stripped)&&!/你.{0,8}说/.test(stripped))return true;
  return false;
}

export function inspectDiaryIssues(parsed,evidence){
  const fields=diaryFields(parsed);
  const text=fieldText(fields);
  const noChat=Boolean(evidence?.silence?.noChatToday)||((evidence?.chat?.userMessageCount??0)===0&&(evidence?.chat?.assistantMessageCount??0)===0);
  const issues=[];
  if(OBSERVER_VOICE_RE.test(text)||REPORT_RE.test(text))issues.push("observer_voice");
  if(FABRICATED_PHYSICAL_RE.test(text))issues.push("fabricated_physical");
  if(FALSE_AGENCY_RE.test(text))issues.push("false_agency");
  if(noChat&&FAKE_TODAY_CHAT_RE.test(text))issues.push("fabricated_today_chat");
  if(MOOD_DUMP_RE.test(text))issues.push("mood_dump");
  const allowUserDiary=Boolean(evidence?.userHasOwnDiary);
  if(!allowUserDiary&&ASK_USER_DIARY_RE.test(text))issues.push("self_other_confusion");
  if(looksLikeThirdPartySelf(text))issues.push("self_other_confusion");
  if(pastUnresolvedItems(evidence).length&&STALE_AS_CURRENT_RE.test(text))issues.push("stale_temporal");
  return {fields,text,noChat,issues:[...new Set(issues)]};
}

export function validateGeneratedDiary(parsed,evidence){
  if(!parsed||typeof parsed!=="object")return {ok:false,reason:"not_object",issues:["not_object"]};
  const inspected=inspectDiaryIssues(parsed,evidence);
  const {fields,issues}=inspected;
  if(fields.body.length<12)return {ok:false,reason:"body_too_short",issues:["body_too_short"],...fields};
  if(fields.body.length>4000)return {ok:false,reason:"body_too_long",issues:["body_too_long"],...fields};
  if(issues.length)return {ok:false,reason:issues[0],issues,...fields};
  return {ok:true,issues:[],body:fields.body,summary:fields.summary.slice(0,400),reflection:fields.reflection.slice(0,800),messageToUser:fields.messageToUser.slice(0,500)};
}

const REWRITEABLE=new Set(["observer_voice","fabricated_physical","false_agency","fabricated_today_chat","self_other_confusion","stale_temporal"]);

async function defaultComplete(messages){
  const up=await upstreamChat({stream:false,temperature:0.78,max_tokens:1400},messages,"chat",null,{});
  if(!up.ok){
    const err=new Error(`diary upstream ${up.status}`);
    err.status=up.status;
    throw err;
  }
  const data=await up.json();
  if(data?.usage){
    insertUsage({sessionId:null,source:"diary",publicModel:"diary",upstreamModel:usageUpstreamModel(upstreamResponseInfo(up)),kind:"diary",usage:data.usage});
  }
  const content=typeof data?.choices?.[0]?.message?.content==="string"?data.choices[0].message.content:"";
  if(!content.trim())throw new Error("diary upstream empty");
  return content;
}

export async function generateDiaryForDate(dateLocal,{
  personaId=config.defaultPersonaId,
  force=false,
  complete=defaultComplete,
  now=new Date(),
  evidence=null
}={}){
  if(!config.naturalDiaryEnabled)return {ok:false,reason:"disabled"};
  const key=`${personaId}:${dateLocal}`;
  if(generating.has(key))return {ok:false,reason:"in_flight"};
  const existing=getDiaryEntry(dateLocal,personaId);
  if(existing&&!force)return {ok:true,skipped:true,reason:"already_exists",entry:existing};
  generating.add(key);
  try{
    const built=evidence??buildDailyEvidence(dateLocal,{personaId,now});
    const persona=requirePersona(personaId);
    const compact=compactEvidenceForPrompt(built);
    const raw=await complete([
      {role:"system",content:diarySystemPrompt(persona)},
      {role:"user",content:`今天是 ${dateLocal}（${built.weekday}）。请根据下面的系统证据写日记。\n${JSON.stringify(compact)}`}
    ]);
    let parsed;
    try{parsed=parseJsonLoose(raw);}catch{throw Object.assign(new Error("diary json parse failed"),{retryable:true});}
    let valid=validateGeneratedDiary(parsed,built);
    const rewriteable=(valid.issues??[]).filter(issue=>REWRITEABLE.has(issue));
    if(!valid.ok&&rewriteable.length){
      const rewritten=await complete([
        {role:"system",content:diaryRewritePrompt(persona,rewriteable)},
        {role:"user",content:`原草稿：\n${JSON.stringify({body:valid.body,summary:valid.summary,reflection:valid.reflection,message_to_user:valid.messageToUser})}\n系统证据（不可新增事实）：\n${JSON.stringify(compact)}`}
      ]);
      try{parsed=parseJsonLoose(rewritten);}catch{throw Object.assign(new Error("diary rewrite json parse failed"),{retryable:true,reason:"rewrite_parse_failed"});}
      valid=validateGeneratedDiary(parsed,built);
    }
    if(!valid.ok)throw Object.assign(new Error(`diary validation: ${valid.reason}`),{retryable:true,reason:valid.reason});
    const saved=insertDiaryEntry({
      personaId,
      dateLocal,
      body:valid.body,
      summary:valid.summary,
      reflection:valid.reflection,
      messageToUser:valid.messageToUser,
      moodSnapshot:built.presence?.snapshots?.mood??null,
      energySnapshot:built.presence?.snapshots?.energy??null,
      closenessSnapshot:built.presence?.snapshots?.closeness??null,
      irritationSnapshot:built.presence?.snapshots?.irritation??null,
      relatedMessageIds:(built.chat?.excerpts??[]).map(x=>x.id).filter(Boolean).slice(0,24),
      relatedOpenLoopIds:(built.openLoops??[]).map(x=>x.id).filter(Boolean),
      relatedExpectationIds:(built.expectations??[]).map(x=>x.id).filter(Boolean),
      chatMessageCount:built.chat?.total??0,
      userMessageCount:built.chat?.userMessageCount??0,
      assistantMessageCount:built.chat?.assistantMessageCount??0,
      sourceStartAt:built.sourceStartAt,
      sourceEndAt:built.sourceEndAt,
      generationVersion:GENERATION_VERSION,
      evidenceHash:sha256(stableJson({date:dateLocal,counts:compact.chat_counts,excerpts:compact.excerpts,loops:compact.unresolved_open_loops,focus:compact.current_focus})).slice(0,16),
      content:{highlights:valid.reflection,version:GENERATION_VERSION}
    },{replace:Boolean(force&&existing)});
    if(!saved.ok&&saved.reason==="already_exists")return {ok:true,skipped:true,reason:"already_exists",entry:saved.entry};
    clearDiaryPending(dateLocal,personaId);
    return {ok:true,skipped:false,entry:saved.entry,evidence:built};
  }catch(error){
    upsertDiaryPending({personaId,dateLocal,reason:existing&&force?"regenerate_failed":"generation_failed",error:error?.message??error,now});
    return {ok:false,reason:error?.reason??"generation_failed",error:String(error?.message??error).slice(0,400),retryable:error?.retryable!==false};
  }finally{
    generating.delete(key);
  }
}
