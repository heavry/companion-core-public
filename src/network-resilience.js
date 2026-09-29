const RETRYABLE_HTTP=new Set([408,425,429,500,502,503,504,520,521,522,523,524,525,526,527]);
const NON_RETRYABLE_HTTP=new Set([400,401,403,404,405,409,410,415,422]);
// Preserve the pre-resilience provider-routing contract separately from
// same-provider retryability. In particular, HTTP 400 used to get one chance
// on the secondary provider, but must not be retried against the same provider.
const FAILOVER_HTTP=new Set([400,...RETRYABLE_HTTP]);
const RETRYABLE_CODES=new Set([
  "ECONNRESET","ECONNREFUSED","EPIPE","ETIMEDOUT","EAI_AGAIN","ENETDOWN",
  "ENETUNREACH","EHOSTDOWN","EHOSTUNREACH","UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT","UND_ERR_BODY_TIMEOUT","UND_ERR_SOCKET"
]);
const RETRYABLE_TEXT=/socket hang up|connection (?:was )?(?:closed|reset)|closed prematurely|SSE ended before terminal|fetch failed|network(?: error| is unreachable)|temporary (?:dns|failure)|timed? ?out|timeout/i;
const QUOTA_TEXT=/quota (?:exceeded|exhausted)|insufficient[_ ]quota|billing|credit(?:s)? exhausted|spending limit|account balance/i;

function numericStatus(value){
  const n=Number(value?.status??value?.statusCode??value?.response?.status??value);
  return Number.isInteger(n)&&n>=100&&n<=599?n:null;
}

function errorCode(error){
  return String(error?.code??error?.cause?.code??error?.name??"").toUpperCase().slice(0,80);
}

export function parseRetryAfter(value,{now=Date.now()}={}){
  if(value==null||value==="")return null;
  const seconds=Number(value);
  if(Number.isFinite(seconds)&&seconds>=0)return Math.min(120000,Math.round(seconds*1000));
  const at=Date.parse(String(value));
  return Number.isFinite(at)?Math.max(0,Math.min(120000,at-now)):null;
}

export function classifyNetworkFailure(input={}){
  const error=input?.error??(input instanceof Error?input:null);
  const status=numericStatus(input?.status??input?.response??error);
  const code=errorCode(error);
  const message=String(input?.body??error?.message??"").slice(0,1000);
  const quotaExhausted=status===429&&QUOTA_TEXT.test(message);
  const aborted=code==="ABORTERROR"||code==="ABORT_ERR";
  const retryable=!aborted&&!quotaExhausted&&(
    (status!=null&&RETRYABLE_HTTP.has(status))||
    RETRYABLE_CODES.has(code)||
    (!status&&RETRYABLE_TEXT.test(message))||
    code==="TIMEOUTERROR"
  );
  let errorClass="unknown";
  if(aborted)errorClass="cancelled";
  else if(quotaExhausted)errorClass="quota_exhausted";
  else if(status===429)errorClass="rate_limited";
  else if(status!=null)errorClass=retryable?`http_${status}_temporary`:`http_${status}_permanent`;
  else if(code==="TIMEOUTERROR"||code==="ETIMEDOUT"||code.includes("TIMEOUT"))errorClass="timeout";
  else if(code==="EAI_AGAIN")errorClass="dns_temporary";
  else if(code)errorClass=RETRYABLE_CODES.has(code)?code.toLowerCase():"transport_error";
  else if(RETRYABLE_TEXT.test(message))errorClass="connection_interrupted";
  return {
    retryable,
    failoverEligible:retryable||(!aborted&&status!=null&&FAILOVER_HTTP.has(status)),
    status,
    code:code||null,
    errorClass,
    quotaExhausted,
    retryAfterMs:parseRetryAfter(input?.retryAfter??error?.retryAfter??input?.headers?.get?.("retry-after"))
  };
}

export function backoffMs(attempt,{delays=[400,1000,2000],retryAfterMs=null,random=Math.random}={}){
  if(Number.isFinite(retryAfterMs))return Math.max(0,retryAfterMs);
  const base=delays[Math.min(Math.max(0,attempt-1),delays.length-1)]??2000;
  return Math.max(0,Math.round(base*(0.85+Math.max(0,Math.min(1,random()))*0.3)));
}

export async function retryNetworkOperation(operation,{
  maxAttempts=3,
  maxElapsedMs=30000,
  delays=[400,1000,2000],
  random=Math.random,
  sleep=(ms,signal)=>new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(Object.assign(new Error("cancelled"),{name:"AbortError"}));
    const timer=setTimeout(resolve,ms);
    const abort=()=>{clearTimeout(timer);reject(Object.assign(new Error("cancelled"),{name:"AbortError"}));};
    signal?.addEventListener?.("abort",abort,{once:true});
  }),
  signal=null,
  classify=classifyNetworkFailure,
  onAttempt=()=>{}
}={}){
  const started=Date.now();let lastFailure=null;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    if(signal?.aborted)throw Object.assign(new Error("cancelled"),{name:"AbortError"});
    try{
      const value=await operation({attempt,elapsedMs:Date.now()-started});
      const failure=await classify(value);
      if(!failure.retryable){onAttempt({attempt,elapsedMs:Date.now()-started,outcome:"return",failure});return {value,attempts:attempt,failure};}
      lastFailure=failure;
      if(attempt>=maxAttempts) return {value,attempts:attempt,failure};
    }catch(error){
      const failure=await classify({error});lastFailure=failure;
      if(!failure.retryable||attempt>=maxAttempts)throw Object.assign(error,{networkFailure:failure,attempts:attempt});
    }
    const delay=backoffMs(attempt,{delays,retryAfterMs:lastFailure?.retryAfterMs,random});
    if(Date.now()-started+delay>maxElapsedMs)break;
    onAttempt({attempt,elapsedMs:Date.now()-started,outcome:"retry",failure:lastFailure,backoffMs:delay});
    await sleep(delay,signal);
  }
  const error=Object.assign(new Error("network recovery window exhausted"),{code:"NETWORK_RECOVERY_EXHAUSTED",networkFailure:lastFailure});
  throw error;
}

export class CircuitBreaker{
  constructor({threshold=3,openMs=20000,now=Date.now}={}){this.threshold=threshold;this.openMs=openMs;this.now=now;this.entries=new Map();}
  state(key){
    const item=this.entries.get(String(key));if(!item)return {state:"CLOSED",failures:0,retryAt:null};
    if(item.state==="OPEN"&&this.now()>=item.retryAt){item.state="HALF_OPEN";item.probeTaken=false;}
    return {state:item.state,failures:item.failures,retryAt:item.retryAt??null};
  }
  allow(key){
    const id=String(key),state=this.state(id),item=this.entries.get(id);
    if(state.state==="OPEN")return false;
    if(state.state==="HALF_OPEN"){
      if(item.probeTaken)return false;
      item.probeTaken=true;
    }
    return true;
  }
  success(key){this.entries.delete(String(key));}
  failure(key,{retryable=true}={}){
    if(!retryable)return this.state(key);
    const id=String(key),item=this.entries.get(id)??{state:"CLOSED",failures:0,retryAt:null,probeTaken:false};
    item.failures++;
    if(item.state==="HALF_OPEN"||item.failures>=this.threshold){item.state="OPEN";item.retryAt=this.now()+this.openMs;item.probeTaken=false;}
    this.entries.set(id,item);return this.state(id);
  }
}

export function networkLog(fields={}){
  const safe={
    phase:String(fields.phase??"unknown").slice(0,80),
    provider:String(fields.provider??"").slice(0,80)||null,
    tool:String(fields.tool??"").slice(0,80)||null,
    turn_id:String(fields.turnId??"").slice(0,160)||null,
    generation_id:String(fields.generationId??"").slice(0,160)||null,
    request_id:String(fields.requestId??"").slice(0,160)||null,
    error_class:String(fields.errorClass??"").slice(0,80)||null,
    retryable:Boolean(fields.retryable),attempt:Number(fields.attempt??0),
    backoff_ms:Number(fields.backoffMs??0),elapsed_ms:Number(fields.elapsedMs??0),
    committed_message_count:Number(fields.committedMessageCount??0),
    committed_bubble_count:Number(fields.committedBubbleCount??0)
  };
  console.log("[network]",JSON.stringify(safe));
}

export { RETRYABLE_HTTP,NON_RETRYABLE_HTTP,FAILOVER_HTTP };
