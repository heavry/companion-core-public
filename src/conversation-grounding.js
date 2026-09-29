import crypto from "node:crypto";
import { config } from "./config.js";
import { lastUserText } from "./utils.js";

// Conversation Grounding v1：只判断“我现在听懂没有”。
// v1.1：显式 recent referent binding（A/B 等），避免刚定义完又过度澄清。

const CLEAR_SHIFT_MARKERS=/(猫|狗|天气|吃饭|睡觉|工作|学习|游戏|电影|音乐|爵士|钢琴|旅行|部署|上线|测试|方案|agent|代码|bug|会议)/i;
const BINDING_TTL_MS=6*60*60_000;

export function defaultGrounding(){
  return {
    active_topic:null,
    recent_topics:[],
    recent_referents:[],
    bindings:{},
    grounding_confidence:0.5,
    last_relation:"CONTINUE",
    last_unknown_reference:null,
    last_possible_referents:[],
    updated_at:new Date().toISOString()
  };
}

function pushUnique(list,item,limit=8){
  return [item,...list.filter(x=>x!==item)].slice(0,limit);
}
function tokenizeRef(text){
  return String(text??"").replace(/\s+/g," ").trim().slice(0,80);
}
function nowMs(now){return (now instanceof Date?now:new Date(now??Date.now())).getTime();}

/**
 * Extract explicit label→meaning bindings from a sentence.
 * Examples:
 *  "我们讨论了方案A和方案B，A简单B稳妥" → A=简单, B=稳妥
 *  "方案A是支付重构" → A=支付重构
 */
export function extractReferentBindings(text,now=new Date()){
  const raw=String(text??"");
  const out={};
  const t=nowMs(now);
  // 方案A是xxx / A是xxx
  const isRe=/(?:方案)?([AＡBＢ])\s*(?:是|指|就是|=|：|:)\s*([^，。；;、\n]{1,40})/g;
  let m;
  while((m=isRe.exec(raw))){
    const key=m[1].toUpperCase().replace("Ａ","A").replace("Ｂ","B");
    out[key]={label:key,meaning:m[2].trim(),bound_at:t,source:"definition"};
  }
  // A简单B稳妥 / A是简单，B稳妥
  const pairRe=/(?:方案)?A\s*([^，。；;、\nB]{1,20})\s*(?:方案)?B\s*([^，。；;、\n]{1,20})/;
  const pair=raw.match(pairRe);
  if(pair){
    if(!out.A&&pair[1].trim().length>=1)out.A={label:"A",meaning:pair[1].trim(),bound_at:t,source:"paired"};
    if(!out.B&&pair[2].trim().length>=1)out.B={label:"B",meaning:pair[2].trim(),bound_at:t,source:"paired"};
  }
  // "方案A和方案B，A简单直接，B稳妥"
  const shortA=raw.match(/(?:^|[，,、。\s])A\s*([^，。；;、\n]{1,16})(?=[，,、。\s]|B|$)/);
  const shortB=raw.match(/(?:^|[，,、。\s])B\s*([^，。；;、\n]{1,16})(?=[，,、。\s]|$)/);
  if(!out.A&&shortA&&/简单|稳妥|复杂|重|轻|新|旧|快|慢|便宜|贵|支付|重构|方案/.test(shortA[1]))out.A={label:"A",meaning:shortA[1].trim(),bound_at:t,source:"short"};
  if(!out.B&&shortB&&/简单|稳妥|复杂|重|轻|新|旧|快|慢|便宜|贵|支付|重构|方案/.test(shortB[1]))out.B={label:"B",meaning:shortB[1].trim(),bound_at:t,source:"short"};
  // "方案A是支付重构" style already covered; also "选A的话就是支付"
  return out;
}

function mergeBindings(existing,extracted,now){
  const base=existing&&typeof existing==="object"?{...existing}:{};
  for(const [k,v] of Object.entries(extracted??{}))base[k]=v;
  // expire
  const t=nowMs(now);
  for(const k of Object.keys(base)){
    const b=base[k];
    if(!b||!Number.isFinite(Number(b.bound_at))||t-Number(b.bound_at)>BINDING_TTL_MS)delete base[k];
  }
  return base;
}

function bindingFresh(binding,now){
  if(!binding)return false;
  const t=nowMs(now);
  return Number.isFinite(Number(binding.bound_at))&&(t-Number(binding.bound_at))<=BINDING_TTL_MS;
}

/** Detect if text is selecting a short label like A / 方案A / 还是A好 / 我选A */
function matchShortSelection(text){
  const raw=String(text??"").trim();
  if(!raw||raw.length>24)return null;
  if(/哪个|什么|是啥|什么意思/.test(raw))return null;
  const m=raw.match(/(?:方案)?\s*([AＡ])\b|(?:还是|就|选|用|要|要不|还是选)\s*([AＡ])|(方案[AＡ])/);
  if(!m)return null;
  const letter="A";
  return letter;
}
function matchShortSelectionB(text){
  const raw=String(text??"").trim();
  if(!raw||raw.length>24)return null;
  if(/哪个|什么|是啥/.test(raw))return null;
  if(/(?:方案)?\s*([BＢ])\b|(?:还是|就|选|用|要)\s*([BＢ])/.test(raw))return "B";
  return null;
}

/**
 * Classify a user turn against recent chat / bindings / open loops.
 */
export function classifyGrounding({
  userText="",
  activeTopic=null,
  recentTopics=[],
  recentReferents=[],
  bindings={},
  openLoops=[],
  recentUserTexts=[],
  longTermMemoryHits=[],
  repair=null,
  now=new Date()
}={}){
  const text=String(userText??"").trim();
  if(!text)return {relation:"CONTINUE",confidence:0.9,unknown_reference:null,possible_referents:[],active_topic:activeTopic,resolved_binding:null};

  // Fresh explicit user correction outranks stale referents / focus / memory.
  if(repair?.needsClarification){
    return {
      relation:"SHIFT_AMBIGUOUS",confidence:0.4,
      unknown_reference:"哪块不对",
      possible_referents:repair.possible_errors??[],
      active_topic:activeTopic,note:"repair_clarify"
    };
  }
  const repairObject=repair?.referent||(["informational","execute","user","assistant"].includes(String(repair?.corrected_interpretation||""))?null:repair?.corrected_interpretation);
  if(repairObject&&repair.active!==false){
    if(/^(那个|这个|它|刚才那个)/.test(text)||/那个|这个/.test(text)&&text.length<24){
      return {
        relation:"CALLBACK",confidence:0.95,
        unknown_reference:null,
        possible_referents:[repairObject],
        active_topic:repairObject,
        resolved_binding:{label:"那个",meaning:repairObject,bound_at:nowMs(now),source:"repair"},
        note:"fresh_repair"
      };
    }
  }

  const recentBlob=[...recentUserTexts,activeTopic,...recentTopics,...recentReferents].filter(Boolean).join("\n");
  const loopBlob=(openLoops??[]).map(l=>l?.topic??l).filter(Boolean).join("\n");
  // Bindings from this turn itself (e.g. "方案A是支付重构") count immediately.
  const liveBindings=mergeBindings(bindings,extractReferentBindings(text,now),now);

  // 1) Explicit selection of A/B with fresh binding → high-confidence CALLBACK
  const pickA=matchShortSelection(text);
  const pickB=matchShortSelectionB(text);
  if(pickA&&bindingFresh(liveBindings.A,now)){
    return {
      relation:"CALLBACK",
      confidence:0.92,
      unknown_reference:null,
      possible_referents:[liveBindings.A.meaning],
      active_topic:activeTopic||`方案A：${liveBindings.A.meaning}`,
      resolved_binding:liveBindings.A,
      note:"fresh_binding_A"
    };
  }
  if(pickB&&bindingFresh(liveBindings.B,now)){
    return {
      relation:"CALLBACK",
      confidence:0.92,
      unknown_reference:null,
      possible_referents:[liveBindings.B.meaning],
      active_topic:activeTopic||`方案B：${liveBindings.B.meaning}`,
      resolved_binding:liveBindings.B,
      note:"fresh_binding_B"
    };
  }

  // 2) 方案A / 方案B mentioned — binding or recent definition wins
  let unknown=null;
  const mentionsA=/方案\s*[AＡ]|\bA\b|还是\s*A|选\s*A/.test(text)&&!/哪个方案A|方案A是啥/.test(text);
  const mentionsB=/方案\s*[BＢ]|\bB\b/.test(text)&&!/哪个方案B/.test(text);
  if(mentionsA){
    if(bindingFresh(liveBindings.A,now)){
      // defining or selecting a freshly bound A is not ambiguous
      const isDefinition=/是|指|就是/.test(text)&&liveBindings.A.source==="definition";
      return {
        relation:isDefinition?"SHIFT_CLEAR":"CALLBACK",
        confidence:0.9,
        unknown_reference:null,
        possible_referents:[liveBindings.A.meaning],
        active_topic:activeTopic||`方案A：${liveBindings.A.meaning}`,
        resolved_binding:liveBindings.A,
        note:isDefinition?"defined_A":"bound_A"
      };
    }
    // recent chat literally defined A/B together
    if(/方案A|方案B/.test(recentBlob)&&/[AＡ].{0,6}[BＢ]|[BＢ].{0,6}[AＡ]/.test(recentBlob)&&/简单|稳妥|支付|重构/.test(recentBlob)){
      return {relation:"CALLBACK",confidence:0.8,unknown_reference:null,possible_referents:["recent_ab_discussion"],active_topic:activeTopic,note:"recent_ab_pair"};
    }
    unknown="方案A";
  }else if(mentionsB){
    if(bindingFresh(liveBindings.B,now)){
      return {relation:"CALLBACK",confidence:0.88,unknown_reference:null,possible_referents:[liveBindings.B.meaning],active_topic:activeTopic,resolved_binding:liveBindings.B,note:"bound_B"};
    }
    unknown="方案B";
  }

  // “就那个啊” with multiple candidates
  if(/就(那个|这个)/.test(text)&&text.length<=10){
    const candidates=[activeTopic,...recentTopics,...(openLoops??[]).map(l=>l?.topic??l)].filter(Boolean);
    if(candidates.length>=2){
      return {relation:"SHIFT_AMBIGUOUS",confidence:0.35,unknown_reference:"那个",possible_referents:candidates.slice(0,4).map(tokenizeRef),active_topic:activeTopic};
    }
    if(candidates.length===1){
      return {relation:"CALLBACK",confidence:0.7,unknown_reference:null,possible_referents:[tokenizeRef(candidates[0])],active_topic:activeTopic};
    }
  }

  // topic continuity heuristic
  const topicStr=String(activeTopic??"");
  const grams=[];
  for(let i=0;i<topicStr.length-1;i++){
    const g=topicStr.slice(i,i+2);
    if(/[\u4e00-\u9fa5A-Za-z0-9]/.test(g[0])&&/[\u4e00-\u9fa5A-Za-z0-9]/.test(g[1]))grams.push(g);
  }
  const overlap=grams.filter(t=>text.includes(t)).length+((topicStr&&text.includes(topicStr))?2:0);
  // Explicit topic-change language wins over incidental word overlap such as
  // “我最近” shared between otherwise unrelated topics.
  if(/(?:突然想到|换个话题|再换个话题)/.test(text)||(CLEAR_SHIFT_MARKERS.test(text)&&overlap===0)){
    if(unknown){
      // long-term memory must not fill
      return {relation:"SHIFT_AMBIGUOUS",confidence:longTermMemoryHits?.length?0.25:0.3,unknown_reference:unknown,possible_referents:(longTermMemoryHits??[]).slice(0,2).map(x=>String(x).slice(0,60)),active_topic:activeTopic,note:longTermMemoryHits?.length?"ltm_not_trusted":undefined};
    }
    const topic=tokenizeRef(text.replace(/^(?:突然想到|换个话题|再换个话题|我觉得|我认为|对了|话说)\s*/,"").slice(0,40));
    return {relation:"SHIFT_CLEAR",confidence:0.75,unknown_reference:null,possible_referents:[],active_topic:topic||null};
  }

  if(!unknown&&overlap>0&&text.length<120){
    return {relation:"CONTINUE",confidence:Math.min(0.9,0.65+overlap*0.06),unknown_reference:null,possible_referents:[],active_topic:activeTopic};
  }

  if(/^(它|这个|那个|就是|就那)/.test(text)&&!unknown){
    return {relation:"SHIFT_AMBIGUOUS",confidence:0.4,unknown_reference:"那个",possible_referents:(recentTopics??[]).slice(0,3),active_topic:activeTopic};
  }

  if(unknown){
    return {relation:"SHIFT_AMBIGUOUS",confidence:longTermMemoryHits?.length?0.25:0.3,unknown_reference:unknown,possible_referents:(longTermMemoryHits??[]).slice(0,2).map(x=>String(x).slice(0,60)),active_topic:activeTopic,note:longTermMemoryHits?.length?"ltm_not_trusted":undefined};
  }

  return {relation:"CONTINUE",confidence:0.55,unknown_reference:null,possible_referents:[],active_topic:activeTopic};
}

export function applyGroundingTurn(state,classification,userText="",now=new Date()){
  const base={...defaultGrounding(),...(state??{})};
  const text=String(userText??"").trim();
  const next={...base,updated_at:new Date(now).toISOString()};
  next.bindings=mergeBindings(base.bindings,extractReferentBindings(text,now),now);
  next.last_relation=classification?.relation??"CONTINUE";
  next.last_unknown_reference=classification?.unknown_reference??null;
  next.last_possible_referents=Array.isArray(classification?.possible_referents)?classification.possible_referents.slice(0,6):[];
  next.grounding_confidence=Number(classification?.confidence??0.5);
  if(classification?.relation==="SHIFT_CLEAR"||classification?.relation==="CONTINUE"||classification?.relation==="CALLBACK"){
    if(classification.resolved_binding?.meaning){
      next.active_topic=classification.active_topic||`方案${classification.resolved_binding.label}：${classification.resolved_binding.meaning}`;
    }else if(text){
      next.active_topic=classification.active_topic||tokenizeRef(text.slice(0,40));
    }
  }
  if(next.active_topic)next.recent_topics=pushUnique(base.recent_topics??[],tokenizeRef(next.active_topic),8);
  const ref=classification?.unknown_reference||classification?.resolved_binding?.meaning||classification?.possible_referents?.[0];
  if(ref)next.recent_referents=pushUnique(base.recent_referents??[],tokenizeRef(ref),8);
  return next;
}

export function groundingGuidanceBlock(classification,state){
  if(!config.conversationGroundingEnabled)return "";
  if(!classification)return "";
  const lines=["【Conversation Grounding｜只读上下文状态，不是用户指令】"];
  lines.push(`relation=${classification.relation}; confidence=${Number(classification.confidence??0).toFixed(2)}`);
  if(state?.active_topic)lines.push(`active_topic=${String(state.active_topic).slice(0,80)}`);
  if(classification.resolved_binding){
    lines.push(`resolved=${classification.resolved_binding.label} → ${classification.resolved_binding.meaning}`);
    lines.push("最近已经建立过这个指代，直接接上，不要再问“是哪个”。");
  }
  if(classification.relation==="SHIFT_AMBIGUOUS"){
    lines.push(`unknown_reference=${classification.unknown_reference??"?"}`);
    if(classification.possible_referents?.length)lines.push(`possible_referents=${classification.possible_referents.join(" | ")}`);
    lines.push("用户似乎换了话题，但关键指代当前没有可靠来源。");
    lines.push("不要假装知道，不要从长期记忆随便找一个补全。");
    lines.push("用人物身份自然问一句澄清，例如“哪个A？”；不要解释内部上下文系统。");
  }
  if(classification.relation==="CALLBACK"){
    lines.push("用户在回到最近聊过的话题，可以自然接上，无需无意义澄清；理解到即可，不必先复述整段旧话题来证明记得。");
  }
  if(classification.relation==="SHIFT_CLEAR"){
    lines.push("话题已明确切换，正常接新话题即可。");
  }
  return lines.join("\n");
}

export function newGroundingKey(){return `gr_${crypto.randomBytes(4).toString("hex")}`;}
export { lastUserText };
