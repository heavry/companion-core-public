import { config } from "./config.js";
import { noteProviderError,noteProviderFailover,noteProviderResponse,providerAttemptAllowed } from "./runtime.js";
import { normalizeChatCompatibilityMessages } from "./responses.js";
import fs from "node:fs";
import { getMedia } from "./media.js";
import { normalizeProviderRequestTools,providerCompatibilityProfile } from "./provider-tool-schema.js";
import { CircuitBreaker,backoffMs,classifyNetworkFailure,networkLog } from "./network-resilience.js";

const responseMetadata=new WeakMap(),agentProviderLocks=new Map();
const circuit=new CircuitBreaker({threshold:config.networkCircuitThreshold,openMs:config.networkCircuitOpenMs});
const providerConfig=name=>config.upstreamProviders[name];
const routeFor=(name,kind)=>providerConfig(name)?.routes?.[kind]??null;
const configured=(name,kind="agent")=>Boolean(routeFor(name,kind)?.baseUrl&&routeFor(name,kind)?.model);
const modelFor=(name,kind)=>routeFor(name,kind)?.model??"";

export const upstreamModelFor=(mode,provider="primary")=>modelFor(provider,mode==="agent"?"agent":"chat");
export const upstreamResponseInfo=response=>responseMetadata.get(response)??null;
export const usageUpstreamModel=info=>info?.provider&&info?.model?`${info.provider}:${info.model}`:(info?.model??"");
export function prepareAgentProviderRoute(lockKey,continuation,persistedProvider=null){if(!lockKey)return;if(!continuation)agentProviderLocks.delete(lockKey);else if(!agentProviderLocks.has(lockKey)&&configured(persistedProvider))agentProviderLocks.set(lockKey,persistedProvider);}
export function finishAgentProviderRoute(lockKey,keepLocked){if(lockKey&&!keepLocked)agentProviderLocks.delete(lockKey);}

function materializeMedia(messages){
  return (messages??[]).map(message=>{
    if(!Array.isArray(message?.content))return message;
    const content=message.content.map(part=>{
      const raw=typeof part?.image_url==="string"?part.image_url:part?.image_url?.url;
      const match=typeof raw==="string"?raw.match(/^companion-media:\/\/([0-9a-f-]{36})$/i):null;
      if(!match)return part;
      const media=getMedia(match[1]);
      if(!media||media.missing)throw Object.assign(new Error("uploaded image is unavailable"),{statusCode:400,code:"MEDIA_NOT_FOUND"});
      return {...part,image_url:{...(typeof part.image_url==="object"?part.image_url:{}),url:`data:${media.mime};base64,${media.buffer.toString("base64")}`}};
    });
    return {...message,content};
  });
}
function cleanedBody(body,messages,model){
  const x={...body,model,messages:materializeMedia(messages)};
  for(const key of ["companion_session","companion_source","companion_persona","project_path","projectPath","workspace","workspace_path","workspacePath","repository_path","repositoryPath","repository_name","repositoryName","cwd","project_id","projectId","repo","repository","project"])delete x[key];
  if(x.metadata&&typeof x.metadata==="object"&&!Array.isArray(x.metadata)){
    x.metadata={...x.metadata};delete x.metadata.webEnabled;delete x.metadata.agentResumeTaskId;
    if(!Object.keys(x.metadata).length)delete x.metadata;
  }
  return x;
}
function cleanedResponsesBody(body,input,model){
  const x={...body,model,input};
  for(const key of ["companion_session","companion_source","companion_persona","project_path","projectPath","workspace","workspace_path","workspacePath","repository_path","repositoryPath","repository_name","repositoryName","cwd","project_id","projectId","repo","repository","project"])delete x[key];
  return x;
}
function headers(route){const h={"content-type":"application/json",...config.upstreamExtraHeaders};if(route.apiKey)h.authorization=`Bearer ${route.apiKey}`;return h;}
function timeoutSignal(ms,other){const timeout=AbortSignal.timeout(ms);return other?AbortSignal.any([other,timeout]):timeout;}
function retryReason(result){return result.error?.message??`HTTP ${result.response?.status??"unknown"}`;}
function rememberResponse(response,provider,model){responseMetadata.set(response,{provider,model});return response;}

async function attempt(name,{endpoint,kind,payload,timeoutMs,signal},snapshot=null){
  const route=routeFor(name,kind),model=route?.model??"",url=`${route?.baseUrl??""}/${endpoint}`;
  const started=Date.now();
  try{
    let requestBody=snapshot?.requestBody;
    if(requestBody==null){
      const profile=providerCompatibilityProfile({model,endpoint,kind});
      const body=normalizeProviderRequestTools(profile,payload(model));
      requestBody=JSON.stringify(body);
      if(snapshot)snapshot.requestBody=requestBody;
    }
    const response=await fetch(url,{method:"POST",headers:headers(route),body:requestBody,signal:timeoutSignal(timeoutMs,signal)});
    let bodyHint="";if(response.status===429)try{bodyHint=(await response.clone().text()).slice(0,1000);}catch{}
    const failure=classifyNetworkFailure({status:response.status,headers:response.headers,body:bodyHint});
    noteProviderResponse(name,response.status,failure.retryable);rememberResponse(response,name,model);return {response,retryable:failure.retryable,failure,provider:name,model};
  }catch(error){
    if(signal?.aborted)throw error;
    const classified=classifyNetworkFailure({error}),failure=Date.now()-started>=Math.max(1,timeoutMs*.9)?{...classified,retryable:true,errorClass:"timeout"}:classified;
    noteProviderError(name,error);return {error,retryable:failure.retryable,failure,provider:name,model};
  }
}

async function attemptResilient(name,spec,{phase="llm_generation",turnId="",generationId="",requestId="",maxAttempts=config.networkRetryAttempts}={}){
  const started=Date.now(),snapshot={requestBody:null};let result=null;
  for(let n=1;n<=maxAttempts;n++){
    if(!circuit.allow(`${name}:${spec.kind}`)){
      const error=Object.assign(new Error(`upstream ${name} circuit open`),{code:"UPSTREAM_CIRCUIT_OPEN",statusCode:503});
      return {error,retryable:true,failure:{retryable:true,errorClass:"circuit_open"},provider:name,model:modelFor(name,spec.kind),circuitOpen:true};
    }
    result=await attempt(name,spec,snapshot);
    if(result.response?.ok){circuit.success(`${name}:${spec.kind}`);return result;}
    const failure=result.failure??classifyNetworkFailure({error:result.error,status:result.response?.status,headers:result.response?.headers});
    const breaker=circuit.failure(`${name}:${spec.kind}`,failure);
    if(!failure.retryable||n>=maxAttempts)return result;
    const delay=backoffMs(n,{retryAfterMs:failure.retryAfterMs});
    networkLog({phase,provider:name,turnId,generationId,requestId,errorClass:failure.errorClass,retryable:true,attempt:n,backoffMs:delay,elapsedMs:Date.now()-started});
    if(Date.now()-started+delay>config.networkRecoveryWindowMs)return result;
    if(breaker.state==="OPEN")return result;
    if(result.response?.body)try{await result.response.body.cancel();}catch{}
    await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,delay);const abort=()=>{clearTimeout(timer);reject(Object.assign(new Error("cancelled"),{name:"AbortError"}));};if(spec.signal?.aborted)return abort();spec.signal?.addEventListener?.("abort",abort,{once:true});});
  }
  return result;
}

async function requestWithFailover(spec,{lockKey="",phase="llm_generation",turnId="",generationId="",requestId=""}={}){
  const locked=lockKey?agentProviderLocks.get(lockKey):null;
  let first=locked&&configured(locked,spec.kind)?locked:null;
  if(!first)first=providerAttemptAllowed("primary")&&configured("primary",spec.kind)?"primary":configured("secondary",spec.kind)?"secondary":"primary";
  const fallbackAvailable=first==="primary"&&configured("secondary",spec.kind);
  const initial=await attemptResilient(first,spec,{phase,turnId,generationId,requestId,maxAttempts:fallbackAvailable?Math.min(2,config.networkRetryAttempts):config.networkRetryAttempts});
  if(initial.response?.ok&&lockKey)agentProviderLocks.set(lockKey,first);
  const failoverEligible=Boolean(initial.failure?.failoverEligible??initial.retryable);
  if(locked||!failoverEligible||first!=="primary"||!configured("secondary",spec.kind)){
    if(initial.error)throw Object.assign(initial.error,{networkFailure:initial.failure});
    return initial.response;
  }
  if(initial.response?.body)try{await initial.response.body.cancel();}catch{}
  noteProviderFailover("primary","secondary",retryReason(initial));
  const fallback=await attemptResilient("secondary",spec,{phase,turnId,generationId,requestId,maxAttempts:1});
  if(fallback.response?.ok&&lockKey)agentProviderLocks.set(lockKey,"secondary");
  if(fallback.error)throw Object.assign(fallback.error,{networkFailure:fallback.failure});
  return fallback.response;
}

export async function upstreamChat(body,messages,mode,signal,route={}){
  return requestWithFailover({endpoint:"chat/completions",kind:mode==="agent"?"agent":"chat",payload:model=>cleanedBody(body,messages,model),timeoutMs:config.upstreamTimeoutMs,signal},route);
}
export async function upstreamResponses(body,input,signal,route={}){
  return requestWithFailover({endpoint:"responses",kind:"agent",payload:model=>cleanedResponsesBody(body,input,model),timeoutMs:config.upstreamTimeoutMs,signal},route);
}
export async function upstreamCompat(body,messages,signal,route={}){
  // 结构化调试日志：仅记录长度等结构信息，绝不记录 system/persona 原文。
  if(config.debugEnabled)try{const sys=messages.find(m=>m?.role==="system");if(sys){const txt=typeof sys.content==="string"?sys.content:JSON.stringify(sys.content);fs.appendFileSync(config.debugLogPath,JSON.stringify({time:new Date().toISOString(),event:"compat_system_structure",system_message_chars:txt.length,mode:"compat"})+"\n");}}catch{}
  return requestWithFailover({endpoint:"chat/completions",kind:"agent",payload:model=>{const normalized=normalizeChatCompatibilityMessages(messages);const request={model,messages:normalized,stream:false,temperature:0,response_format:{type:"json_object"}};if(Number.isFinite(Number(body?.max_output_tokens)))request.max_completion_tokens=Number(body.max_output_tokens);else if(Number.isFinite(Number(body?.max_completion_tokens)))request.max_completion_tokens=Number(body.max_completion_tokens);else if(Number.isFinite(Number(body?.max_tokens)))request.max_completion_tokens=Number(body.max_tokens);return request;},timeoutMs:config.upstreamTimeoutMs,signal},route);
}
export async function simpleCompletion(messages){
  const response=await requestWithFailover({endpoint:"chat/completions",kind:"summary",payload:model=>({model,messages,stream:false,temperature:0.1}),timeoutMs:config.summaryTimeoutMs,signal:null});
  if(!response.ok)throw new Error(`summary upstream ${response.status}`);return {data:await response.json(),info:upstreamResponseInfo(response)};
}
