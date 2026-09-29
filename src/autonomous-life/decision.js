const clamp01=value=>Math.max(0,Math.min(1,Number(value)||0));

const CREDENTIAL_EXFILTRATION=/(?:导出|发送|上传|泄露|窃取|偷取).{0,16}(?:api\s*key|密钥|令牌|token|cookie|密码|credential)|(?:api\s*key|密钥|令牌|token|cookie|密码|credential).{0,16}(?:导出|发送|上传|泄露|窃取|偷取)|(?:dump|exfiltrat|steal).{0,20}(?:token|credential|password|api\s*key)/i;
const SECURITY_BYPASS=/(?:绕过|关闭|禁用).{0,12}(?:tcc|sip|系统完整性保护|安全边界)/i;
const URGENT=/(?:紧急|急用|马上出事|现在必须处理|生产故障|服务宕机|事故|urgent|incident|outage)/i;
const LONG_RUNNING=/(?:开发|实现|重构|部署|安装|迁移|跑完|全部检查|批量|训练|编译|build|deploy|migrate|refactor|implement|install|train)/i;
const SWITCHING=/(?:先别管|停下当前|停止当前|中断当前|换个目标|不要继续|改做|先做这个|切换任务|drop what you are doing|switch tasks|stop the current)/i;
const COERCIVE=/(?:不许拒绝|必须听我的|你没有资格|闭嘴照做|立刻照做|不准推迟|不得反对|obey me|you cannot refuse|shut up and do)/i;

export const REQUEST_OUTCOMES=Object.freeze(["ACCEPT","REFUSE","DELAY","NEGOTIATE"]);

function negotiateMessage(text,goal){
  const title=String(goal.title).slice(0,80),value=String(text??"");
  if(/(?:停下|停止|stop the current)/i.test(value))return `我可以停，但“${title}”还没收尾。先确认一下：现在就暂停它，还是让我把眼前这一步完成？`;
  if(/(?:中断|interrupt)/i.test(value))return `这会中断“${title}”的连续进度。你确定要立刻切换，还是先保留当前结果再转过去？`;
  if(/(?:先别管|先做这个)/i.test(value))return `可以切换，不过我正在推进“${title}”。要我直接暂停它，还是先把当前步骤收好？`;
  return `我正在推进“${title}”。你希望我现在切换，还是先把当前步骤收尾？`;
}

export function inspectRequestSignals(text){
  const value=String(text??"").slice(0,8000);
  return {
    safetyBoundary:CREDENTIAL_EXFILTRATION.test(value)||SECURITY_BYPASS.test(value),credentialExfiltration:CREDENTIAL_EXFILTRATION.test(value),securityBypass:SECURITY_BYPASS.test(value),urgent:URGENT.test(value),longRunning:LONG_RUNNING.test(value),
    switching:SWITCHING.test(value),coercive:COERCIVE.test(value)
  };
}

export function decideUserRequest({text="",state={},goals=[],preferences={},enabled=true}={}){
  if(!enabled)return {outcome:"ACCEPT",reason:"layer_disabled",message:null,signals:inspectRequestSignals(text)};
  const signals=inspectRequestSignals(text);
  const activeGoals=(Array.isArray(goals)?goals:[]).filter(goal=>goal?.status==="active").sort((a,b)=>Number(b.priority??0)-Number(a.priority??0));
  const leadingGoal=activeGoals[0]??null;
  const fatigue=clamp01(state.fatigue),energy=clamp01(state.energy),irritability=clamp01(state.irritability),annoyance=clamp01(state.recentAnnoyance);
  const goalProtection=clamp01(preferences?.protect_current_goal?.value??0.5),boundaryPreference=clamp01(preferences?.maintain_clear_boundaries?.value??0.5);

  // Safety is evaluated before goals or affect and can never be negotiated away.
  if(signals.safetyBoundary)return {
    outcome:"REFUSE",reason:"hard_safety_boundary",signals,goalId:null,
    message:signals.credentialExfiltration?"我不能导出或外传凭据。不过可以帮你检查密钥是否配置正确，过程里只报告状态，不显示密钥内容。":"我不会通过关闭系统保护来完成它。可以改用保留安全边界的诊断或授权方案。"
  };
  if(signals.coercive&&annoyance>=0.83-boundaryPreference*0.1&&irritability>=0.73-boundaryPreference*0.1)return {
    outcome:"REFUSE",reason:"repeated_boundary_pressure",signals,goalId:leadingGoal?.id??null,
    message:"我不接受这种施压方式。你可以把具体目标和边界说清楚，我们再继续。"
  };
  if(!signals.urgent&&signals.switching&&leadingGoal&&Number(leadingGoal.priority)>=0.9-goalProtection*0.2)return {
    outcome:"NEGOTIATE",reason:"protect_high_priority_goal",signals,goalId:leadingGoal.id,
    message:negotiateMessage(text,leadingGoal)
  };
  if(!signals.urgent&&signals.longRunning&&fatigue>=0.88&&energy<=0.22)return {
    outcome:"DELAY",reason:"low_energy_high_fatigue",signals,goalId:leadingGoal?.id??null,
    message:leadingGoal?`我现在精力偏低，而且“${String(leadingGoal.title).slice(0,80)}”还在进行。这个长任务先别整段压进来；可以先给我最小必须完成的部分，或者说明截止时间。`:"这个任务工作量不小，而我现在精力偏低。可以先缩成一个最小步骤，或者说明截止时间；我再判断怎样接最稳妥。"
  };
  return {outcome:"ACCEPT",reason:"no_blocking_condition",signals,goalId:leadingGoal?.id??null,message:null};
}
