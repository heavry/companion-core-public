export const AGENT_LIFECYCLE_EVENTS=Object.freeze([
  "SessionStart","SessionEnd","ContactActivated","ProfileChanged","InstructionsChanged","UserPromptSubmit","TurnQueued","TurnStarting","TurnStarted",
  "ContextCollect","ContextInjected","ContextInjectionFailed","DynamicContextCollect","DynamicContextInjected","DynamicContextInjectionFailed","DynamicContextExpired","DynamicContextCleanupFailed","AssistantDelta","PreToolUse",
  "ToolStarted","PermissionRequest","PermissionResolved","PostToolUse","PostToolUseFailure",
  "PreCompact","PostCompact","CompactFailed","StopRequested","Stop","SubagentStart","SubagentStop"
]);

const known=new Set(AGENT_LIFECYCLE_EVENTS),decisionEvents=new Set(["PreToolUse"]);

export class AgentLifecycleError extends Error{
  constructor(message,code="AGENT_LIFECYCLE_ERROR",details={}){super(message);this.name="AgentLifecycleError";this.code=code;this.details=details;}
}

function frozenPayload(value){
  if(!value||typeof value!=="object")return value;
  if(Array.isArray(value))return Object.freeze(value.map(frozenPayload));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key,item])=>[key,frozenPayload(item)])));
}

function timeout(promise,ms,id){
  if(!ms)return promise;
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AgentLifecycleError(`hook ${id} timed out`,"HOOK_TIMEOUT",{id,timeoutMs:ms})),ms);timer.unref?.();})]).finally(()=>clearTimeout(timer));
}

export function createAgentLifecycle({defaultTimeoutMs=3000,onError=()=>{}}={}){
  const hooks=new Map(AGENT_LIFECYCLE_EVENTS.map(name=>[name,[]]));let sequence=0,closed=false;
  const validEvent=event=>{if(!known.has(event))throw new AgentLifecycleError(`unknown lifecycle event: ${event}`,"UNKNOWN_EVENT",{event});return event;};
  const on=(event,callback,{id=`${event}:${sequence+1}`,order=0,policy="observe",timeoutMs=defaultTimeoutMs}={})=>{
    validEvent(event);if(closed)throw new AgentLifecycleError("lifecycle closed","LIFECYCLE_CLOSED");
    if(typeof callback!=="function")throw new AgentLifecycleError("hook must be a function","INVALID_HOOK");
    if(!["observe","critical"].includes(policy))throw new AgentLifecycleError("invalid hook failure policy","INVALID_FAILURE_POLICY");
    const list=hooks.get(event);if(list.some(item=>item.id===id))throw new AgentLifecycleError(`duplicate hook id: ${id}`,"DUPLICATE_HOOK_ID");
    const record={id:String(id),callback,order:Number(order)||0,policy,timeoutMs:Math.max(0,Math.min(60000,Number(timeoutMs)||0)),sequence:++sequence};list.push(record);
    return ()=>{const index=list.indexOf(record);if(index<0)return false;list.splice(index,1);return true;};
  };
  const dispatch=async(event,payload={})=>{
    validEvent(event);const immutable=frozenPayload(payload),results=[],failures=[];
    const ordered=[...hooks.get(event)].sort((a,b)=>a.order-b.order||a.sequence-b.sequence);
    for(const hook of ordered){
      try{results.push({hookId:hook.id,value:await timeout(Promise.resolve().then(()=>hook.callback(immutable)),hook.timeoutMs,hook.id)});}
      catch(error){const failure=Object.freeze({event,hookId:hook.id,policy:hook.policy,message:String(error?.message??error)});failures.push(failure);try{onError(failure);}catch{}if(hook.policy==="critical")throw new AgentLifecycleError(`critical hook failed: ${hook.id}`,"CRITICAL_HOOK_FAILED",failure);}
    }
    return Object.freeze({event,results:Object.freeze(results),failures:Object.freeze(failures)});
  };
  const decide=async(event,payload={})=>{
    if(!decisionEvents.has(event))throw new AgentLifecycleError(`${event} is not a decision event`,"NOT_DECISION_EVENT");
    const outcome=await dispatch(event,payload),decisions=outcome.results.map(item=>({hookId:item.hookId,decision:item.value})).filter(item=>["allow","ask","deny"].includes(item.decision?.kind));
    const decision=decisions.find(item=>item.decision.kind==="deny")?.decision??decisions.find(item=>item.decision.kind==="ask")?.decision??Object.freeze({kind:"allow"});
    return Object.freeze({...outcome,decisions:Object.freeze(decisions),decision});
  };
  return Object.freeze({on,dispatch,decide,close(){if(closed)return false;closed=true;for(const list of hooks.values())list.length=0;return true;}});
}
