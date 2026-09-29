// A small, deterministic appraisal layer. The state lives in Natural Presence.
const HOUR=3600_000;
const clamp=x=>Math.max(0,Math.min(1,Number(x)||0));
const time=x=>{const n=Date.parse(x??"");return Number.isFinite(n)?n:null;};
const dismiss=/^(?:嗯+|哦+|呵呵|随便|都行|无所谓|懒得说)[。.!！~～]*$/;
const apology=/对不起|抱歉|不好意思|我错了|sorry/i;
const repair=/我会|下次|补偿|认真|解释一下|刚才是因为|我不是故意|确实是我/i;
const insult=/闭嘴|烦死你了|你有病|蠢|废物|滚开|讨厌你/i;
const success=/成功了|搞定了|通过了|赢了|拿到了|好消息|太棒了|终于完成/i;
const appreciation=/谢谢你|辛苦你了|喜欢你|爱你/i;
const promise=/晚上回来|明天回来|一会回来|等会回来|稍后回来|回来找你|回来再聊/i;
const returnText=/我回来了|回来啦|回来了|到家了/i;
const lateActionEvidence={
  return:returnText,
  finish_then_return:returnText,
  user_progress_or_return:returnText,
  show:/(?:给你看|发你看|展示给你|给你展示).{0,4}(?:了|过)|(?:已经|刚才|刚刚|之前).{0,10}(?:给你看|展示给你)/,
  send_photo:/(?:照片|图片|截图|视频).{0,8}(?:发了|发给你了|给你了)|(?:发了|发给你了|给你发了).{0,8}(?:照片|图片|截图|视频)/,
  report:/(?:告诉你|跟你说|说过了|报过信|汇报了)/
};

function expectationKind(item){
  const value=item?.expected_information??item?.expectation_type??item?.kind;
  return value==null?"":String(value).trim().toLowerCase();
}

function overdueExpectation(item,now){
  if(!item||item.resolved)return false;
  if(["satisfied","fulfilled","cancelled","canceled","abandoned","resolved"].includes(String(item.state??"")))return false;
  if(String(item.next_expected_actor??"")!=="user")return false;
  const due=time(item.expected_followup_at??item.expires_at);
  return due!==null&&due<now;
}

function expectationViolationFor(item,value){
  const kind=expectationKind(item);
  if(kind)return lateActionEvidence[kind]?.test(value)??false;
  // Legacy Presence open loops predate structured expectation kinds.
  const topic=String(item.topic??item.expected_information??"");
  return promise.test(topic)&&returnText.test(value);
}

function expectationViolationSignal(item,source){
  const reason=item.reason??item.resolution_reason??null;
  const expectationSource=item.source??item.expectation_source
    ??(["user_initiated","assistant_elicited"].includes(String(reason))?String(reason):null);
  const signal={...source,event:"expectation_violation",appraisal:"overdue_commitment_was_late",
    emotion:"hurt",strength:clamp(0.34+0.20*(item.salience??item.importance??0.6)),
    importance:clamp(item.importance??item.salience??0.6),expectation_id:item.id??null,
    lifecycle_transition:"pending->overdue->violated"};
  const kind=expectationKind(item);
  if(kind)signal.expectation_type=kind;
  if(reason!=null)signal.expectation_reason=String(reason);
  if(expectationSource!=null)signal.expectation_source=String(expectationSource);
  if(item.confidence!=null)signal.confidence=clamp(item.confidence);
  return signal;
}

export function appraiseEmotion({text="",messageId=null,at=new Date(),recentUserTexts=[],expectations=[],openLoops=[],current=null,closeness=0.6}={}){
  const value=String(text).trim(),now=new Date(at).getTime();
  if(!value||!Number.isFinite(now))return null;
  const previous=recentUserTexts.slice(-3).map(x=>String(x).trim());
  const dismissCount=previous.filter(x=>dismiss.test(x)).length;
  const pending=[...expectations,...openLoops].find(item=>overdueExpectation(item,now)&&expectationViolationFor(item,value));
  const source={event_id:String(messageId??`turn:${now}`),at:new Date(now).toISOString()};
  if(insult.test(value))return {...source,event:"direct_insult",appraisal:"direct_disrespect",emotion:current?.primary==="angry"?"hurt":"angry",strength:0.7,importance:0.9};
  if(pending)return expectationViolationSignal(pending,source);
  if(dismiss.test(value)&&dismissCount>=1){
    const escalate=current?.primary==="angry"||(current?.primary==="annoyed"&&current.intensity>=0.55);
    const baseStrength=0.22+0.08*Math.min(3,dismissCount);
    const strength=escalate&&current?.primary==="annoyed"
      ?Math.max(baseStrength,current.intensity+0.16):baseStrength;
    return {...source,event:"repeated_dismissal",appraisal:"repeated_disengagement",
      emotion:escalate?"angry":"annoyed",strength:clamp(strength),importance:0.45};
  }
  if(apology.test(value))return {...source,event:"apology",appraisal:repair.test(value)?"specific_repair_attempt":"acknowledgement",emotion:null,repair:repair.test(value)?0.27:0.12};
  if(repair.test(value)&&current?.primary)return {...source,event:"repair",appraisal:"repair_attempt",emotion:null,repair:0.2};
  if(success.test(value))return {...source,event:"shared_success",appraisal:"shared_good_news",emotion:"excited",strength:0.58,importance:0.55};
  if(appreciation.test(value))return {...source,event:"appreciation",appraisal:"felt_appreciated",emotion:"happy",strength:0.35,importance:0.35};
  if(promise.test(value))return {...source,event:"promise",appraisal:"expectation_created",emotion:null};
  return {...source,event:"ordinary",appraisal:"no_emotional_trigger",emotion:null};
}

export function evolveEmotion(current,appraisal,at=new Date()){
  const now=new Date(at).getTime();
  if(!Number.isFinite(now))return current??null;
  let state=current&&typeof current==="object"?structuredClone(current):null;
  if(state?.primary){
    const hours=Math.max(0,(now-(time(state.last_updated_at)??now))/HOUR);
    const importance=Math.max(0.25,Math.min(1,Number(state.causes?.[0]?.importance??0.5)));
    const halfLife=(state.primary==="excited"?4:8+16*importance)*(1-0.4*clamp(state.recovery_pressure));
    state.intensity=clamp(state.intensity*Math.pow(0.5,hours/halfLife));
    state.residual=state.intensity;
    state.last_updated_at=new Date(now).toISOString();
    if(state.primary==="excited"&&state.intensity<0.35)state.primary="happy";
    if(state.primary==="angry"&&state.intensity<0.32)state.primary="annoyed";
  }
  if(appraisal?.repair&&state?.primary){
    state.intensity=clamp(state.intensity*(1-appraisal.repair));
    state.recovery_pressure=clamp((state.recovery_pressure??0)+appraisal.repair);
    state.residual=state.intensity;
  }
  if(appraisal?.emotion){
    const cause={event_id:appraisal.event_id,event:appraisal.event,appraisal:appraisal.appraisal,importance:appraisal.importance??0.5,expectation_id:appraisal.expectation_id??null,expectation_type:appraisal.expectation_type??null,expectation_reason:appraisal.expectation_reason??null,expectation_source:appraisal.expectation_source??null,lifecycle_transition:appraisal.lifecycle_transition??null,confidence:appraisal.confidence??null,at:appraisal.at};
    if(state?.primary===appraisal.emotion){
      state.intensity=clamp(state.intensity+appraisal.strength*(1-state.intensity));
      state.causes=[cause,...(state.causes??[])].slice(0,4);
      state.last_reinforced_at=appraisal.at;
      state.recovery_pressure=clamp((state.recovery_pressure??0)*0.5);
    }else if(!state?.primary||(state.primary==="angry"&&appraisal.emotion==="hurt")||appraisal.strength>=state.intensity+(state.primary==="angry"||state.primary==="hurt"?0.15:0)){
      state={primary:appraisal.emotion,intensity:clamp(appraisal.strength),causes:[cause],onset_at:appraisal.at,last_reinforced_at:appraisal.at,last_updated_at:appraisal.at,residual:clamp(appraisal.strength),recovery_pressure:0};
    }
  }
  if(state?.primary&&state.intensity<0.12)return null;
  return state;
}

export function emotionExpressionBlock(state,act=null){
  if(!state?.primary||state.intensity<0.12)return "";
  const name=state.primary,intensity=Number(state.intensity).toFixed(2);
  const cause=state.causes?.[0]?.appraisal??"recent_interaction";
  const styles={
    happy:"可以随口、敢逗、敢顶；不要自动变温柔 counselling，不必额外加气泡。",
    excited:"语气轻快、反应直接；可以短促，但不强制两条气泡。",
    annoyed:"少解释、少安抚、少追问；可以顶一句或拌嘴，别自动温柔收尾。",
    angry:"语气硬、短，降低迁就；有真实原因时允许尖锐反驳或适度粗口，别同轮自动说算了没事。不要威胁、羞辱或操控。",
    hurt:"收着说也可以冷一点、顶一句；不要被洗成安慰模板，不要立刻和好式收尾。",
    low:"降低精力与篇幅，不套连续安慰模板。"
  };
  return ["【Emotion Expression｜只改变语气/立场/篇幅，不增加 response 动作】",`emotion=${name}; intensity=${intensity}; internal_cause=${cause}`,
    act?`selected_act=${act}; 情绪不改变 impulse。完成本轮 impulse 后停。`:"Conversational Impulse 仍决定本轮 impulse。",
    styles[name]??"保持自然。","Emotion detected ≠ 必须 reassure。Intimacy ≠ 必须 closure。原因只供内部理解，不要求口头报告情绪。"].join("\n");
}
