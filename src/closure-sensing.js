import { config } from "./config.js";

// Closure Sensing (包C)：识别用户释放对话，并只做轻轻放手。
// 对侧于 Dangling Opener Guard：防的是「硬续」，不是悬空开场。

const LEAVE = [
  /我去洗澡|洗澡去了|先洗澡|去洗漱/,
  /我去睡|先睡|睡觉了|我要睡了|晚安|去躺|躺会儿|躺一会/,
  /去上课|上课了|去学校/,
  /去开会|开会了|先开会/,
  /去玩了|去玩会|玩去了|那宝贝去玩/,
  /跑\s*agent.{0,16}回来|去跑\s*agent/i,
  /先走了|走了哈|我先走|回聊|回头聊|下次聊|先撤/,
  /我先忙会|先忙|去忙|忙去了|开始忙/,
  /我出门|出门了|先出门|去吃饭|去吃面/
];

const DONE = [
  /搞定|弄好了|弄完了|完成了|弄完|跑完了|跑好了|好了好了|行了行了/,
  /不用了|不需要了|就这样|就这样吧|没问题了|ok了|OK了|可以了/,
  /谢了|谢谢啦|辛苦了你|多谢|感谢/
];

const LOW_ENERGY = [
  /^(嗯+|哦+|噢+|啊+|行+|好+|好吧|好的|可以|哈哈好|行吧)[。.!！~～]*$/,
  /^(嗯嗯|哦哦|好好好|知道了|收到)[。.!！~～]*$/
];

const FATIGUE = [
  /好困|困了|累了|好累|烦了|不想说|懒得说|明天再说|下次再说|改天/
];

function anyRe(text, patterns){
  const t=String(text??"").trim();
  if(!t)return null;
  for(const re of patterns){
    const m=t.match(re);
    if(m)return { pattern:String(re), match:m[0] };
  }
  return null;
}

/**
 * Detect conversation release signals.
 * strength: weak | medium | strong
 * kind: leave | done | low_energy | fatigue | soft_ack
 */
export function detectClosure({ userText="", presence=null, enabled=config.closureSensingEnabled!==false }={}){
  if(!enabled) return { likely:false, strength:"none", kind:null, reasons:["disabled"] };
  const t=String(userText??"").trim();
  const reasons=[];
  if(!t) return { likely:false, strength:"none", kind:null, reasons:["empty"] };

  const leave=anyRe(t,LEAVE);
  if(leave){ reasons.push(`leave:${leave.match}`); return { likely:true, strength:"strong", kind:"leave", reasons, sample:leave.match }; }

  const fatigue=anyRe(t,FATIGUE);
  if(fatigue){ reasons.push(`fatigue:${fatigue.match}`); return { likely:true, strength:"strong", kind:"fatigue", reasons, sample:fatigue.match }; }

  const done=anyRe(t,DONE);
  if(done){ reasons.push(`done:${done.match}`); return { likely:true, strength:"medium", kind:"done", reasons, sample:done.match }; }

  // very short dismissive acks
  if(t.length<=6){
    const soft=anyRe(t,LOW_ENERGY);
    if(soft){ reasons.push(`soft_ack:${soft.match}`); return { likely:true, strength:"weak", kind:"soft_ack", reasons, sample:soft.match }; }
    if(/^(嗯|哦|噢|啊|哈|好|行|ok|OK|okay)[。.!！~～]*$/.test(t)){
      reasons.push("minimal_ack");
      return { likely:true, strength:"weak", kind:"soft_ack", reasons, sample:t };
    }
  }

  // companion tired → more willing to let go, but still need user signal or very short exchange
  const energy=presence?.dimensions?.energy?.current;
  if(Number.isFinite(Number(energy)) && Number(energy)<=0.28 && t.length<=12){
    reasons.push("companion_drained_soft");
    return { likely:true, strength:"weak", kind:"low_energy", reasons };
  }

  return { likely:false, strength:"none", kind:null, reasons:["no_signal"] };
}

/**
 * Guidance injected into generation when user is releasing the conversation.
 * Constraints, not a fixed script.
 */
export function closureGuidanceBlock(closure){
  if(!closure?.likely) return "";
  const strength=closure.strength;
  const lines=[
    "【收尾识别｜只读】",
    `用户几乎在结束这轮对话（kind=${closure.kind}, strength=${strength}）。`,
    "要求：只做轻轻放手，不要展开新话题、不要总结今天聊了什么、不要再抛第二个问题。",
    strength==="strong"
      ? "强烈离场：最多回一句很短的收尾（可 0–1 条气泡）；若无必要可极短结束。"
      : strength==="medium"
        ? "事务完成：可短回情绪或一句确认，不复盘、不追问。"
        : "弱收尾：短应答即可，禁止升级成长回复。"
  ];
  return lines.join("\n");
}

/**
 * Trim generated bubbles after user release.
 * Never invents content; only shortens. Guarantees at least nothing empty.
 */
export function applyClosureToBubbles(bubbles=[], closure){
  const list=(Array.isArray(bubbles)?bubbles:[]).map(x=>String(x??"").trim()).filter(Boolean);
  if(!list.length||!closure?.likely) return { bubbles:list, trimmed:false, reason:null };

  const strength=closure.strength;
  if(strength==="strong"){
    // keep shortest meaningful first bubble only; drop extras
    const keep=list.slice(0,1);
    return { bubbles:keep, trimmed:list.length>1, reason:"strong_leave_trim" };
  }
  if(strength==="medium"||strength==="weak"){
    // allow at most 2, never 3 on release
    if(list.length>2) return { bubbles:list.slice(0,2), trimmed:true, reason:`${strength}_max2` };
  }
  return { bubbles:list, trimmed:false, reason:null };
}

export function closureEnabled(){ return config.closureSensingEnabled!==false; }
