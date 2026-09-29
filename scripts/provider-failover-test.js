import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";

const root=path.resolve(import.meta.dirname,".."),base=23000+Math.floor(Math.random()*1000),primaryPort=base,secondaryPort=base+1,corePort=base+2,key="provider-test-key",adminKey="provider-admin-key",tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-provider-test-")),dbPath=path.join(tmp,"companion.db"),children=[];let core,primaryMock,secondaryMock;
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),assert=(value,message)=>{if(!value)throw new Error(`ASSERT: ${message}`);};
const start=(file,env={})=>{const p=spawn(process.execPath,[file],{cwd:root,env:{...process.env,...env},stdio:["ignore","pipe","pipe"]});children.push(p);p.stdout.on("data",x=>process.stdout.write(`[child] ${x}`));p.stderr.on("data",x=>process.stderr.write(`[child-err] ${x}`));return p;};
const stop=async p=>{if(!p||p.exitCode!==null)return;p.kill("SIGTERM");await Promise.race([new Promise(r=>p.once("exit",r)),sleep(1000)]);if(p.exitCode===null)p.kill("SIGKILL");};
async function wait(url){for(let i=0;i<120;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}
async function request(pathname,{method="GET",body,admin=false,auth=true,headers={}}={}){const r=await fetch(`http://127.0.0.1:${corePort}${pathname}`,{method,headers:{...(auth?{authorization:`Bearer ${admin?adminKey:key}`}:{}) ,...(body?{"content-type":"application/json"}:{}),...headers},body:body?JSON.stringify(body):undefined});const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {r,data,text};}
const api=async(pathname,options={})=>{const out=await request(pathname,options);if(!out.r.ok)throw new Error(`${out.r.status} ${out.text}`);return out.data;};
const stats=port=>fetch(`http://127.0.0.1:${port}/stats`).then(r=>r.json());
async function chat(message,session){return request("/v1/chat/completions",{method:"POST",body:{model:"yuna-chat",messages:[{role:"user",content:message}]},headers:{"x-companion-source":"kelivo","x-companion-session":session}});}
async function responses(input,session,tools=[],toolChoice="auto"){return request("/v1/responses",{method:"POST",body:{model:"yuna-agent",input,tools,tool_choice:toolChoice},headers:{"x-companion-source":"harness","x-companion-session":session}});}
const responseText=value=>(value?.output??[]).flatMap(x=>x?.content??[]).map(x=>x?.text??"").join("");

const env={
  COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:adminKey,DATABASE_PATH:dbPath,COMPANION_MODULES_DIR:path.join(tmp,"empty-modules"),COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"module-execution-ledger.json"),COMPANION_MODULES_CONFIG_DIR:path.join(tmp,"modules-config"),COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"module-execution-ledger.json"),COMPANION_BLOCK_REAL_UPSTREAM:"1",PERSONA_SYNC_ON_START:"true",SUMMARY_EVERY_MESSAGES:"9999",EMBEDDING_ENABLED:"false",AGENT_TOOL_MODE:"compat",COMPANION_NATURAL_PRESENCE_ENABLED:"false",
  UPSTREAM_PRIMARY_BASE_URL:`http://127.0.0.1:${primaryPort}/v1`,UPSTREAM_PRIMARY_API_KEY:"primary-mock-key",UPSTREAM_PRIMARY_MODEL:"primary-model",
  UPSTREAM_SECONDARY_BASE_URL:`http://127.0.0.1:${secondaryPort}/v1`,UPSTREAM_SECONDARY_API_KEY:"secondary-mock-key",UPSTREAM_SECONDARY_MODEL:"secondary-model",
  UPSTREAM_SECONDARY_CHAT_BASE_URL:`http://127.0.0.1:${secondaryPort}/v1`,UPSTREAM_SECONDARY_CHAT_API_KEY:"secondary-mock-key",UPSTREAM_SECONDARY_CHAT_MODEL:"secondary-model",
  UPSTREAM_SECONDARY_AGENT_BASE_URL:`http://127.0.0.1:${secondaryPort}/v1`,UPSTREAM_SECONDARY_AGENT_API_KEY:"secondary-mock-key",UPSTREAM_SECONDARY_AGENT_MODEL:"secondary-model",
  UPSTREAM_SECONDARY_SUMMARY_BASE_URL:`http://127.0.0.1:${secondaryPort}/v1`,UPSTREAM_SECONDARY_SUMMARY_API_KEY:"secondary-mock-key",UPSTREAM_SECONDARY_SUMMARY_MODEL:"secondary-model",
  UPSTREAM_CHAT_BASE_URL:`http://127.0.0.1:${primaryPort}/v1`,UPSTREAM_CHAT_API_KEY:"",UPSTREAM_AGENT_BASE_URL:`http://127.0.0.1:${primaryPort}/v1`,UPSTREAM_AGENT_API_KEY:"",UPSTREAM_SUMMARY_BASE_URL:`http://127.0.0.1:${primaryPort}/v1`,UPSTREAM_SUMMARY_API_KEY:"",UPSTREAM_FAILURE_THRESHOLD:"1",UPSTREAM_PRIMARY_RECOVERY_MS:"100",UPSTREAM_TIMEOUT_MS:"80",SUMMARY_TIMEOUT_MS:"80",NETWORK_RETRY_ATTEMPTS:"1"
};

try{
  primaryMock=start(path.join(root,"scripts/mock-upstream.js"),{MOCK_PORT:String(primaryPort),MOCK_PROVIDER_NAME:"primary"});
  secondaryMock=start(path.join(root,"scripts/mock-upstream.js"),{MOCK_PORT:String(secondaryPort),MOCK_PROVIDER_NAME:"secondary"});
  await Promise.all([wait(`http://127.0.0.1:${primaryPort}/stats`),wait(`http://127.0.0.1:${secondaryPort}/stats`)]);
  core=start(path.join(root,"src/server.js"),env);await wait(`http://127.0.0.1:${corePort}/health`);
  assert((await api("/health",{auth:false})).version==="0.2.8.0","v0.2.8.0 health");

  const normal=await chat("PRIMARY_NORMAL","provider-primary");assert(normal.r.ok&&normal.data.choices[0].message.content==="PRIMARY_MOCK_OK","healthy primary handles requests without random routing");
  let ps=await stats(primaryPort),ss=await stats(secondaryPort);assert(ps.total===1&&ss.total===0,"secondary is untouched while primary is healthy");

  const failedOver=await chat("PRIMARY_ONLY_500","provider-failover");assert(failedOver.r.ok&&failedOver.data.choices[0].message.content==="SECONDARY_MOCK_OK","HTTP 500 fails over to secondary");
  const circuit=await chat("CIRCUIT_USES_SECONDARY","provider-circuit");assert(circuit.r.ok&&circuit.data.choices[0].message.content==="SECONDARY_MOCK_OK","open primary circuit uses secondary directly");
  ps=await stats(primaryPort);ss=await stats(secondaryPort);assert(ps.total>=2&&ss.total>=2,`primary consecutive failure opens deterministic secondary route (primary=${ps.total}, secondary=${ss.total})`);

  await sleep(130);const recovered=await chat("PRIMARY_RECOVERED","provider-recovery");assert(recovered.r.ok&&recovered.data.choices[0].message.content==="PRIMARY_MOCK_OK","primary is automatically retried and restored after cooldown");

  const retryableMarkers=["PRIMARY_ONLY_429","PRIMARY_ONLY_502","PRIMARY_ONLY_503","PRIMARY_ONLY_504",...Array.from({length:8},(_,i)=>`PRIMARY_ONLY_${520+i}`),"PRIMARY_NET_RESET","PRIMARY_DEADLINE_HANG"];
  for(const [index,marker] of retryableMarkers.entries()){
    const out=await chat(marker,`retry-${marker}`);assert(out.r.ok&&out.data.choices[0].message.content==="SECONDARY_MOCK_OK",`${marker} fails over to secondary`);if(marker==="PRIMARY_ONLY_524"){assert(!out.text.includes("CLOUDFLARE_524_PAGE_MUST_NOT_LEAK"),"primary Cloudflare 524 HTML never reaches the client after secondary succeeds");const s=await api("/admin/status",{admin:true});assert(s.provider.primary.last_status===524&&s.provider.primary.last_error==="HTTP 524"&&s.provider.primary.failures>0&&s.provider.primary.consecutive_failures===1,"524 updates primary failure status and consecutive count");}
    await sleep(130);const probe=await chat(`PRIMARY_RECOVERY_PROBE_${index}`,`recover-${index}`);assert(probe.r.ok&&probe.data.choices[0].message.content==="PRIMARY_MOCK_OK",`${marker} recovery returns to primary`);
  }

  const secondaryBefore4xx=(await stats(secondaryPort)).total;for(const status of [401]){const out=await chat(`FAULT_${status}`,`no-failover-${status}`);assert(out.r.status===status,`HTTP ${status} is returned without failover`);}assert((await stats(secondaryPort)).total===secondaryBefore4xx,"non-retryable 401 never reach secondary");
  const secondaryBefore400=(await stats(secondaryPort)).total,primaryBefore400=(await stats(primaryPort)).total;const out400=await chat("PRIMARY_ONLY_400","baseline-failover-400");assert(out400.r.ok&&out400.data.choices[0].message.content==="SECONDARY_MOCK_OK","HTTP 400 gets the baseline one-shot secondary-provider fallback");assert((await stats(primaryPort)).total===primaryBefore400+1,"HTTP 400 is not retried on the same provider");assert((await stats(secondaryPort)).total===secondaryBefore400+1,"HTTP 400 reaches secondary exactly once");
  const bothFailed=await chat("FAULT_500","provider-both-fail");assert(bothFailed.r.status===500&&bothFailed.data?.error?.type==="mock_error","secondary failure is returned as a bounded upstream error when both providers fail");const bothStatus=await api("/admin/status",{admin:true});assert(bothStatus.provider.primary.last_status===500&&bothStatus.provider.secondary.last_status===500&&bothStatus.provider.secondary.failures>0,"both provider failures update their own health state");await sleep(130);const afterBoth=await chat("PRIMARY_AFTER_BOTH_FAILED","provider-both-recovery");assert(afterBoth.r.ok&&afterBoth.data.choices[0].message.content==="PRIMARY_MOCK_OK","new task recovers primary after both providers failed");
  const secondaryBeforeCancel=(await stats(secondaryPort)).total,cancelController=new AbortController();const cancelled=fetch(`http://127.0.0.1:${corePort}/v1/chat/completions`,{method:"POST",signal:cancelController.signal,headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"kelivo","x-companion-session":"provider-cancel"},body:JSON.stringify({model:"yuna-chat",messages:[{role:"user",content:"PRIMARY_DEADLINE_HANG"}]})}).catch(e=>e);setTimeout(()=>cancelController.abort(),20);const cancelResult=await cancelled;assert(cancelResult?.name==="AbortError","client request is cancelled locally");await sleep(120);assert((await stats(secondaryPort)).total===secondaryBeforeCancel,"Client Cancel never triggers secondary");
  await stop(primaryMock);const unavailable=await chat("PRIMARY_PROCESS_UNAVAILABLE","provider-fetch-failed");assert(unavailable.r.ok&&unavailable.data.choices[0].message.content==="SECONDARY_MOCK_OK","connection refused/fetch failed switches to secondary");
  primaryMock=start(path.join(root,"scripts/mock-upstream.js"),{MOCK_PORT:String(primaryPort),MOCK_PROVIDER_NAME:"primary"});await wait(`http://127.0.0.1:${primaryPort}/stats`);await sleep(130);const afterUnavailable=await chat("PRIMARY_AFTER_UNAVAILABLE","provider-fetch-recovery");assert(afterUnavailable.r.ok&&afterUnavailable.data.choices[0].message.content==="PRIMARY_MOCK_OK","primary recovers after a real unavailable endpoint");

  const tool={type:"function",name:"echo_test",description:"Echo",parameters:{type:"object",additionalProperties:false,properties:{value:{type:"string"}},required:["value"]}};
  const first=await responses("COMPAT_PROVIDER_LOOP PRIMARY_ONLY_524","provider-loop",[tool],"required"),call=first.data?.output?.find(x=>x.type==="function_call");assert(first.r.ok&&call?.call_id&&!first.text.includes("CLOUDFLARE_524_PAGE_MUST_NOT_LEAK"),"primary 524 starts Agent tool loop on secondary without leaking HTML");
  await sleep(130);const recoveryDuringLoop=await chat("RECOVER_WHILE_AGENT_LOCKED","provider-loop-recovery");assert(recoveryDuringLoop.r.ok&&recoveryDuringLoop.data.choices[0].message.content==="PRIMARY_MOCK_OK","unrelated chat recovers primary while Agent loop remains active");
  const preRestartStatus=await api("/admin/status",{admin:true});assert(preRestartStatus.provider.primary.last_success_at&&preRestartStatus.provider.primary.last_error_at&&preRestartStatus.provider.secondary.last_success_at&&preRestartStatus.provider.failovers>=17,"Admin exposes primary/secondary success, error and failover metrics");
  await stop(core);core=start(path.join(root,"src/server.js"),{...env,PERSONA_SYNC_ON_START:"false"});await wait(`http://127.0.0.1:${corePort}/health`);
  const primaryBeforeContinuation=(await stats(primaryPort)).total,secondaryBeforeContinuation=(await stats(secondaryPort)).total;
  const final=await responses([{role:"user",content:"COMPAT_PROVIDER_LOOP PRIMARY_ONLY_524"},...first.data.output,{type:"function_call_output",call_id:call.call_id,output:"safe-result"}],"provider-loop",[],"none");
  assert(final.r.ok&&responseText(final.data)==="YUNA_COMPAT_FINAL","secondary-locked tool result reaches final answer");
  ps=await stats(primaryPort);ss=await stats(secondaryPort);assert(ps.total===primaryBeforeContinuation&&ss.total===secondaryBeforeContinuation+1,"tool loop continuation stays on secondary even after primary recovery and Core restart");

  await api("/admin/memories",{method:"POST",admin:true,body:{persona_id:"yuna",content:"用户喜欢机械键盘",type:"preference",importance:.9,status:"active",source:"manual"}});
  const memory=await chat("我之前喜欢什么键盘？","provider-memory");assert(memory.r.ok&&memory.data.choices[0].message.content==="MEMORY_SEEN","Shared Memory remains injected through multi-provider routing");
  const sessions=await api("/admin/sessions?source=kelivo",{admin:true});assert(sessions.data.some(x=>x.external_key==="provider-memory"),"Session persistence remains unchanged");

  const status=await api("/admin/status",{admin:true});assert(status.provider.primary.configured&&status.provider.secondary.configured&&status.provider.primary.last_success_at&&status.provider.secondary.last_success_at,"Admin safely reports both providers after restart");assert(status.sqlite.user_version===6&&status.sqlite.schema_version===6,"current schema remains intact");
  const usage=await api("/admin/usage?group_by=upstream_model",{admin:true});assert(usage.data.some(x=>x.bucket==="primary:primary-model")&&usage.data.some(x=>x.bucket==="secondary:secondary-model"),"existing upstream_model field records provider and model without migration");
  assert(!JSON.stringify(status).includes("primary-mock-key")&&!JSON.stringify(status).includes("secondary-mock-key"),"Admin never exposes provider API keys");
  console.log("\nPASS Companion Core v0.2.6.0 Cloudflare 52x failover, bounded dual failure, cancel safety, recovery, Agent loop provider lock, yuna-chat, Memory, Session, Admin health, and usage attribution Mock tests");
}finally{for(const p of [...children].reverse())await stop(p);await sleep(80);fs.rmSync(tmp,{recursive:true,force:true});}
