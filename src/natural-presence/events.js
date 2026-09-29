import crypto from "node:crypto";
import { upstreamChat,upstreamResponseInfo,usageUpstreamModel } from "../upstream.js";
import { insertUsage } from "../db.js";
import { parseJsonLoose } from "../utils.js";

// Event Evaluator：LLM 只判断“刚才发生了什么”，代码映射 delta。
// 模型绝不直接写 mood=-0.73。

export const EVENT_TYPES=[
  "warm_interaction","playful_interaction","praise","disagreement","dismissive_response",
  "apology","reconciliation","user_busy","user_leaving_temporarily","promised_followup",
  "unresolved_topic","shared_success","neutral"
];

const SEVERITY_W={low:0.55,moderate:1,high:1.45};

// event → deterministic delta（单维已由 applyDeltas 再 clamp）
const EVENT_DELTAS={
  warm_interaction:{mood:0.05,closeness:0.02,social_drive:0.03,irritation:-0.02},
  playful_interaction:{mood:0.08,playfulness:0.10,social_drive:0.05},
  praise:{mood:0.06,confidence:0.03,closeness:0.02,irritation:-0.03},
  disagreement:{mood:-0.08,irritation:0.18,confidence:0.02},
  dismissive_response:{mood:-0.12,irritation:0.25,confidence:0.04,social_drive:-0.04},
  apology:{irritation:-0.20,closeness:0.04,mood:0.04},
  reconciliation:{irritation:-0.16,closeness:0.05,mood:0.08,social_drive:0.03},
  user_busy:{social_drive:-0.02,mood:-0.02},
  user_leaving_temporarily:{social_drive:-0.03},
  promised_followup:{closeness:0.02,social_drive:0.02,playfulness:0.01},
  unresolved_topic:{social_drive:0.02,mood:-0.01},
  shared_success:{mood:0.08,closeness:0.03,confidence:0.03,playfulness:0.02},
  neutral:{}
};

const EVALUATOR_SYSTEM=[
  "你是 Companion 的事件理解器。只输出 JSON，不要解释。",
  '{"events":[{"type":"warm_interaction|playful_interaction|praise|disagreement|dismissive_response|apology|reconciliation|user_busy|user_leaving_temporarily|promised_followup|unresolved_topic|shared_success|neutral","severity":"low|moderate|high","resolved":true|false,"topic":"简短主题"}]}',
  "最多 3 条；普通寒暄用 neutral 或 warm_interaction。",
  "type 必须是列表中的英文枚举。没有有意义事件就返回 {\"events\":[] }。",
  "不要输出情绪数值，只分类事件。"
].join("\n");

function mulberry32(seed){
  return function(){
    let t=seed+=0x6D2B79F5;
    t=Math.imul(t^t>>>15,t|1);
    t=Math.imul(t^t>>>7,t|61);
    return ((t^t>>>14)>>>0)/4294967296;
  };
}

export function mapEventsToDeltas(events=[]){
  const total={mood:0,energy:0,closeness:0,irritation:0,social_drive:0,playfulness:0,confidence:0};
  const applied=[];
  for(const ev of events){
    const type=String(ev?.type??"neutral");
    if(!EVENT_DELTAS[type]||type==="neutral")continue;
    const w=SEVERITY_W[String(ev?.severity??"moderate")]??1;
    for(const [k,v] of Object.entries(EVENT_DELTAS[type])){
      total[k]=(total[k]||0)+v*w;
    }
    applied.push({type,severity:ev.severity??"moderate",resolved:Boolean(ev.resolved),topic:String(ev.topic??"").slice(0,80)});
  }
  return {deltas:total,applied};
}

export function heuristicEvents(userText,assistantText=""){
  const u=String(userText??"");
  const a=String(assistantText??"");
  const events=[];
  if(/谢谢|辛苦|太棒|厉害|喜欢你|爱你|thank/i.test(u))events.push({type:"praise",severity:"low",resolved:true,topic:"praise"});
  if(/算了|随便|无所谓|懒得说|哦$|^哦/.test(u)&&u.length<20)events.push({type:"dismissive_response",severity:"moderate",resolved:false,topic:"dismiss"});
  if(/对不起|抱歉|我错了|不好意思/.test(u))events.push({type:"apology",severity:"moderate",resolved:false,topic:"apology"});
  if(/和好|不吵了|没事了|原谅你/.test(u))events.push({type:"reconciliation",severity:"moderate",resolved:true,topic:"reconciliation"});
  if(/不同意|不对|你错了|还是.{0,8}最好|我觉得不是/.test(u))events.push({type:"disagreement",severity:"moderate",resolved:false,topic:"disagreement"});
  if(/一会回来|等会回来|稍等|去忙|开会|先睡|下了|拜拜|跑一下/.test(u))events.push({type:"user_leaving_temporarily",severity:"low",resolved:false,topic:"leaving"});
  if(/一会回来|等我|跑完|结果出来|等结果/.test(u))events.push({type:"promised_followup",severity:"moderate",resolved:false,topic:"followup"});
  if(/哈哈|笑死|逗|好玩|嘿嘿/.test(u)||/哈哈|逗你|笨蛋/.test(a))events.push({type:"playful_interaction",severity:"low",resolved:true,topic:"play"});
  if(!events.length&&u.length>0)events.push({type:"warm_interaction",severity:"low",resolved:true,topic:"chat"});
  return events.slice(0,3);
}

export async function evaluateInteractionEvents({userText,assistantText="",sessionId=null,at=new Date()}={}){
  let events=null,source="heuristic";
  try{
    const up=await upstreamChat({stream:false,temperature:0.1},[
      {role:"system",content:EVALUATOR_SYSTEM},
      {role:"user",content:`用户：${String(userText??"").slice(0,1200)}\nCompanion：${String(assistantText??"").slice(0,800)}`}
    ],"chat",null,{});
    if(up.ok){
      const data=await up.json();
      if(data?.usage)insertUsage({sessionId,source:"presence",publicModel:"presence",upstreamModel:usageUpstreamModel(upstreamResponseInfo(up)),kind:"presence",usage:data.usage});
      const parsed=parseJsonLoose(data?.choices?.[0]?.message?.content??"");
      const list=Array.isArray(parsed?.events)?parsed.events:null;
      if(list&&list.length<=5&&list.every(e=>e&&typeof e.type==="string")){
        events=list.filter(e=>EVENT_TYPES.includes(e.type)).slice(0,3);
        source="llm";
      }
    }
  }catch{}
  if(!events||!events.length){events=heuristicEvents(userText,assistantText);source=events.length?"heuristic":"none";}
  return {events,source};
}

export function eventId(){
  return `pe_${crypto.randomBytes(6).toString("hex")}`;
}

export { EVENT_DELTAS,EVALUATOR_SYSTEM };
