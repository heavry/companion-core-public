import { config } from "./config.js";
import { DECISION_ERROR_CATEGORIES } from "./tool-compat.js";
import { publishEvent } from "./events-bus.js";

export const startedAt=new Date().toISOString();
const active=new Map(),errors=[];
let sequence=0;
const invalidByReason=Object.fromEntries(DECISION_ERROR_CATEGORIES.map(x=>[x,0]));
const compatibility={tool_calls:0,module_tool_calls:0,protocol_retries:0,tool_miss_recoveries:0,invalid_decisions:0,retry_suppressed:0,candidate_fallbacks:0,requests:0,client_tools_total:0,candidate_tools_total:0,contract_chars_total:0,contract_tokens_estimated_total:0,invalid_by_reason:invalidByReason,last_request:null,recent_requests:[]};
const providerConfigured=p=>Object.values(p?.routes??{}).some(r=>r?.baseUrl&&r?.model&&!r.model.startsWith("replace-with"));
const providerStates=Object.fromEntries(["primary","secondary"].map(name=>[name,{name,configured:providerConfigured(config.upstreamProviders[name]),healthy:null,status:"not_checked",consecutive_failures:0,last_request_at:null,last_success_at:null,last_error_at:null,last_status:null,last_error:null,retry_after:null,requests:0,successes:0,failures:0}]));
let failovers=0,lastFailover=null;

export function redactSecrets(value,max=100000){
  let text=String(value??"");
  const routeSecrets=Object.values(config.upstreamProviders).flatMap(p=>Object.values(p.routes??{}).map(r=>r.apiKey));
  const environmentSecrets=Object.entries(process.env).filter(([key,value])=>/(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTHORIZATION|COOKIE|CREDENTIAL|PRIVATE[_-]?KEY)/i.test(key)&&String(value??"").length>=4).map(([,value])=>value);
  for(const secret of [config.apiKey,config.adminKey,config.upstreamApiKey,...routeSecrets,...environmentSecrets])if(secret&&secret.length>=4)text=text.split(secret).join("[REDACTED]");
  return text.replace(/Bearer\s+[^\s"']+/gi,"Bearer [REDACTED]").replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi,"$1[REDACTED]").slice(0,max);
}
export function safeErrorMessage(value){return redactSecrets(value?.message??value??"unknown error",1000);}

export function recordError(scope,error,status=null){
  const item={time:new Date().toISOString(),scope,status,message:safeErrorMessage(error)};errors.unshift(item);errors.splice(50);return item;
}

export function beginTask(kind,sessionId=null){
  const id=`${kind}-${++sequence}`,started_at=new Date().toISOString();active.set(id,{id,kind,session_id:sessionId,started_at});
  return outcome=>{const task=active.get(id);active.delete(id);if(outcome?.error)recordError(kind,outcome.error,outcome.status??null);return task;};
}


function providerTransition(name,nextHealthy){
  const p=providerStates[name];if(!p)return;
  if(p.healthy!==nextHealthy)publishEvent("provider.status_changed",{provider:name,healthy:nextHealthy,status:p.status});
}
export function noteProviderResponse(name,status,retryable=false){
  const provider=providerStates[name];if(!provider)return;
  const now=new Date().toISOString();provider.requests++;provider.last_request_at=now;provider.last_status=Number(status)||null;
  if(status>=200&&status<300){const was=provider.healthy;provider.status="available";provider.healthy=true;provider.successes++;provider.consecutive_failures=0;provider.last_success_at=now;provider.last_error=null;provider.retry_after=null;if(was!==true)providerTransition(name,true);return;}
  provider.status="error";provider.last_error=`HTTP ${status}`;provider.last_error_at=now;
  if(retryable){provider.healthy=false;provider.failures++;provider.consecutive_failures++;provider.last_error_at=now;if(name==="primary"&&provider.consecutive_failures>=config.upstreamFailureThreshold)provider.retry_after=new Date(Date.now()+config.upstreamPrimaryRecoveryMs).toISOString();}
}
export function noteProviderError(name,error){
  const provider=providerStates[name];if(!provider)return;
  const now=new Date().toISOString();provider.requests++;provider.status="unavailable";provider.healthy=false;provider.failures++;provider.consecutive_failures++;provider.last_request_at=now;provider.last_error_at=now;provider.last_status=null;provider.last_error=safeErrorMessage(error);if(name==="primary"&&provider.consecutive_failures>=config.upstreamFailureThreshold)provider.retry_after=new Date(Date.now()+config.upstreamPrimaryRecoveryMs).toISOString();recordError(`upstream_${name}`,error);
}
export function noteProviderFailover(from,to,reason){failovers++;lastFailover={time:new Date().toISOString(),from,to,reason:safeErrorMessage(reason)};}
export function providerAttemptAllowed(name){
  const provider=providerStates[name];if(!provider?.configured)return false;
  if(name!=="primary"||provider.consecutive_failures<config.upstreamFailureThreshold||!provider.retry_after)return true;
  return Date.now()>=Date.parse(provider.retry_after);
}
export function noteCompat(kind){if(typeof compatibility[kind]==="number")compatibility[kind]++;}
export function noteCompatInvalid(category,request=compatibility.last_request){compatibility.invalid_decisions++;const key=DECISION_ERROR_CATEGORIES.includes(category)?category:"other";compatibility.invalid_by_reason[key]++;if(request)request.invalid_decisions++;}
export function noteCompatRequest(metrics={}){
  const item={time:new Date().toISOString(),client_tool_count:Number(metrics.clientToolCount)||0,candidate_tool_count:Number(metrics.candidateToolCount)||0,contract_chars:Number(metrics.contractChars)||0,contract_tokens_estimate:Number(metrics.contractTokensEstimate)||0,action_intents:Array.isArray(metrics.actionIntents)?metrics.actionIntents.slice(0,8):[],protocol_retries:0,tool_miss_recoveries:0,invalid_decisions:0,fallback_reason:metrics.fallbackReason??null};
  compatibility.requests++;compatibility.client_tools_total+=item.client_tool_count;compatibility.candidate_tools_total+=item.candidate_tool_count;compatibility.contract_chars_total+=item.contract_chars;compatibility.contract_tokens_estimated_total+=item.contract_tokens_estimate;if(item.fallback_reason)compatibility.candidate_fallbacks++;
  compatibility.last_request=item;compatibility.recent_requests.unshift(item);compatibility.recent_requests.splice(20);return item;
}
export function noteCompatRetry(request=compatibility.last_request){compatibility.protocol_retries++;if(request)request.protocol_retries++;}
export function noteCompatToolMissRecovery(request=compatibility.last_request){compatibility.tool_miss_recoveries++;if(request)request.tool_miss_recoveries++;}
function safeBaseUrl(value){try{const u=new URL(value);u.username="";u.password="";u.search="";u.hash="";return u.toString().replace(/\/$/,"");}catch{return value?"configured":"";}}
function safeProvider(name){const p=config.upstreamProviders[name],s=providerStates[name],routes=Object.fromEntries(Object.entries(p.routes??{}).map(([kind,r])=>[kind,{base_url:safeBaseUrl(r.baseUrl),model:r.model||null,configured:Boolean(r.baseUrl&&r.model)}]));return {...s,base_url:routes.chat?.base_url??"",model:p.model||null,chat_model:routes.chat?.model??null,agent_model:routes.agent?.model??null,summary_model:routes.summary?.model??null,routes};}

export function runtimeStatus(){
  const primary=safeProvider("primary"),secondary=safeProvider("secondary"),latest=[primary,secondary].filter(x=>x.last_request_at).sort((a,b)=>String(b.last_request_at).localeCompare(String(a.last_request_at)))[0];
  return {started_at:startedAt,uptime_seconds:Math.floor(process.uptime()),pid:process.pid,running_tasks:[...active.values()],recent_errors:errors.slice(0,20),agent_tool_mode:config.agentToolMode,compatibility:{...compatibility,invalid_by_reason:{...compatibility.invalid_by_reason},last_request:compatibility.last_request?{...compatibility.last_request}:null,recent_requests:compatibility.recent_requests.map(x=>({...x}))},provider:{configured:primary.configured,status:latest?.status??"not_checked",last_request_at:latest?.last_request_at??null,last_success_at:latest?.last_success_at??null,last_status:latest?.last_status??null,last_error:latest?.last_error??null,base_url:primary.base_url,chat_model:primary.chat_model,agent_model:primary.agent_model,summary_model:primary.summary_model,failovers,last_failover:lastFailover,primary,secondary}};
}
