import { config } from "./config.js";

// Silence Return Stance (包B)：
// 主动消息先选「立场」，再选内容。立场由状态驱动，不是固定台词。

export const RETURN_STANCES = Object.freeze({
  light_return: "light_return",
  checking_in: "checking_in",
  mild_edge: "mild_edge",
  practical: "practical",
  cool_space: "cool_space"
});

function dim(presence, key, fallback){
  const v=presence?.dimensions?.[key]?.current;
  return Number.isFinite(Number(v))?Number(v):fallback;
}

function hoursBetween(isoLike, at=new Date()){
  const t=Date.parse(isoLike??"");
  if(!Number.isFinite(t)) return null;
  return Math.max(0,(at.getTime()-t)/3600_000);
}

/**
 * Choose return stance for a proactive open after silence.
 * Input snapshot is plain data — no side effects.
 */
export function selectReturnStance({
  silenceHours=null,
  presence=null,
  openLoops=[],
  pendingExpectations=[],
  rhythmMiss=null,
  lastEventTypes=[],
  candidateKind="inactivity",
  presenceReason=null,
  absenceAppraisal=null,
  at=new Date(),
  enabled=config.silenceReturnStanceEnabled!==false
}={}){
  if(!enabled){
    return { stance:"light_return", enabled:false, reasons:["disabled"], silenceHours:null };
  }

  const hours=Number.isFinite(Number(silenceHours))?Math.max(0,Number(silenceHours)):null;
  const irritation=dim(presence,"irritation",0.1);
  const energy=dim(presence,"energy",0.65);
  const mood=dim(presence,"mood",0.15);
  const social=dim(presence,"social_drive",0.55);
  const closeness=dim(presence,"closeness",0.6);
  const reasons=[];

  const unresolvedLoops=(Array.isArray(openLoops)?openLoops:[]).filter(l=>l&&!l.resolved);
  const strongLoop=unresolvedLoops.slice().sort((a,b)=>(b.salience??0)-(a.salience??0))[0];
  const pending=(Array.isArray(pendingExpectations)?pendingExpectations:[]).filter(e=>e&&e.state==="pending");
  const strongPending=pending.slice().sort((a,b)=>(b.salience??0)-(a.salience??0))[0];

  // energy / cool first if drained
  if(energy<=0.32 || (social<=0.35 && energy<=0.45)){
    reasons.push("low_energy_or_social");
    // still prefer practical if clear unfinished wait is high salience
    if((strongPending?.salience??0)>=0.7 || (strongLoop?.salience??0)>=0.75){
      if(energy<=0.28){
        return { stance:"cool_space", enabled:true, reasons:[...reasons,"but_practical_overridden_by_drain"], silenceHours:hours, signals:{energy,irritation,mood,social,closeness} };
      }
      return { stance:"practical", enabled:true, reasons:[...reasons,"pending_or_loop_wins"], silenceHours:hours, signals:{energy,irritation,mood,social,closeness}, topic:strongPending?.topic??strongLoop?.topic??null };
    }
    return { stance:"cool_space", enabled:true, reasons, silenceHours:hours, signals:{energy,irritation,mood,social,closeness} };
  }

  // strong pending / open loop → practical
  if((strongPending?.salience??0)>=0.62 || (strongLoop?.salience??0)>=0.68 || presenceReason==="pending_expectation_followup" || (presenceReason==="open_loop_followup"&&(strongLoop?.salience??0)>=0.5)){
    reasons.push("unfinished_wait");
    return {
      stance:"practical",
      enabled:true,
      reasons,
      silenceHours:hours,
      signals:{energy,irritation,mood,social,closeness},
      topic:strongPending?.topic??strongLoop?.topic??null,
      expectationId:strongPending?.id??null,
      openLoopId:strongLoop?.id??null
    };
  }

  // Absence appraisal can drive stance without requiring pre-existing irritation.
  if(absenceAppraisal){
    const a=absenceAppraisal;
    if(a.explained){
      reasons.push("explained_absence");
      return {
        stance:a.stance_hint==="mild_edge"?"checking_in":(a.stance_hint==="checking_in"?"checking_in":"light_return"),
        enabled:true,reasons,silenceHours:hours,
        signals:{energy,irritation,mood,social,closeness},
        absenceAppraisal:a
      };
    }
    if(a.stance_hint==="mild_edge" || (a.previous_outreach_count>0 && (a.irritation_delta>=0.1 || a.hurt_delta>=0.12))){
      reasons.push("absence_unanswered_outreach");
      return {
        stance:"mild_edge",enabled:true,reasons,silenceHours:hours,
        signals:{energy,irritation,mood,social,closeness},
        absenceAppraisal:a,
        topic:strongPending?.topic??strongLoop?.topic??null
      };
    }
    if(a.stance_hint==="checking_in" || a.concern_delta>=0.12 || a.salience>=0.42){
      reasons.push("absence_concern");
      return {
        stance:"checking_in",enabled:true,reasons,silenceHours:hours,
        signals:{energy,irritation,mood,social,closeness},
        absenceAppraisal:a
      };
    }
    if(a.previous_outreach_count>0){
      reasons.push("absence_continuity");
      return {
        stance:"checking_in",enabled:true,reasons,silenceHours:hours,
        signals:{energy,irritation,mood,social,closeness},
        absenceAppraisal:a
      };
    }
  }

  // irritated residual + long silence → mild_edge
  if(irritation>=0.45 && (hours==null || hours>=8)){
    reasons.push("irritation_residual");
    return { stance:"mild_edge", enabled:true, reasons, silenceHours:hours, signals:{energy,irritation,mood,social,closeness} };
  }
  if(mood<=-0.35 && (hours==null || hours>=12)){
    reasons.push("low_mood_long_gap");
    return { stance:"mild_edge", enabled:true, reasons, silenceHours:hours, signals:{energy,irritation,mood,social,closeness} };
  }

  // default light
  if(hours!=null && hours<4) reasons.push("short_gap");
  else reasons.push("default_light");
  if(candidateKind==="presence"&&presenceReason==="thought_seed") reasons.push("thought_seed");
  return { stance:"light_return", enabled:true, reasons, silenceHours:hours, signals:{energy,irritation,mood,social,closeness} };
}

/**
 * Internal generation constraints for a stance. Never a canned opening line.
 */
export function stanceGuidanceBlock(stanceResult){
  if(!stanceResult?.stance) return "";
  if(stanceResult.enabled===false) return "";
  const stance=stanceResult.stance;
  const map={
    light_return:[
      "【归来立场｜light_return】",
      "几乎若无其事地回来。不要表演「你终于回来了」，不要质问消失多久。",
      "1 条短气泡优先；语气轻松自然。"
    ],
    checking_in:[
      "【归来立场｜checking_in】",
      "有一点惦记，但不过度戏剧化。可以直接说想联系/有点担心，不必假装若无其事，也不要复读固定缺席模板。",
      "最多 1–2 条短气泡；自然直接，不写成缺席盘点。"
    ],
    mild_edge:[
      "【归来立场｜mild_edge】",
      "被冷落的距离感 + 轻微不满/担心。允许直接一点：可以提我之前找过你、可以带亲近关系下的责备感，不必过度体谅对方忙。",
      "禁止翻旧账长文、禁止羞辱/威胁；不要用「你忙就先忙/没事」把情绪抹掉。"
    ],
    practical:[
      "【归来立场｜practical】",
      "先处理未完成的事，少寒暄。像想起来就问进度，不像 CRM 跟进。",
      "1–2 条；语气仍要有人物感，禁止系统提醒口吻。"
    ],
    cool_space:[
      "【归来立场｜cool_space】",
      "明显克制、话少、不黏。低能量时以省电为准。",
      "通常 1 条很短；禁止突然热情。"
    ]
  };
  const lines=map[stance]??map.light_return;
  if(stanceResult?.topic) lines.push(`可关联的未完事项数据：${String(stanceResult.topic).slice(0,80)}`);
  lines.push("禁止伪造现实经历（不要说刚去洗澡/刚出门/一直等你等具体虚假动作）。");
  return lines.join("\n");
}

export function silenceReturnStanceEnabled(){ return config.silenceReturnStanceEnabled!==false; }
