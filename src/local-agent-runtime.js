import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { redactSecrets } from "./runtime.js";
import { invocationLedger } from "./usage-ledger.js";
import { localRuntimeControls } from "./local-runtime-controls.js";

const MAX_OUTPUT=128*1024;
const MAX_READ=256*1024;
const MAX_WRITE=1024*1024;
const SENSITIVE_ENV=/(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTHORIZATION|COOKIE|CREDENTIAL|PRIVATE[_-]?KEY)/i;
const FORBIDDEN_ENV=/^(?:DYLD_.+|LD_.+|NODE_OPTIONS|PYTHONPATH|RUBYOPT|PERL5OPT|BASH_ENV|ENV|SHELLOPTS)$/i;
const SECRET_DISCOVERY=/(?:^|\/)(?:env|printenv)(?:\s|$)|\bsecurity\b.*\bdump-keychain\b|(?:^|\s)(?:cat|sed|head|tail|less|more)\s+[^\n]*(?:\.ssh|Keychains?|\.env(?:\s|$)|credentials?)/i;
const PIPE_INSTALL=/(?:curl|wget)\b[^\n]*(?:\||&&)\s*(?:sudo\s+)?(?:sh|bash)\b/i;
const SENSITIVE_PATH=/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|auth\.json|credentials?(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*\.(?:pem|p12|pfx|key)|\.ssh|\.aws|\.azure|\.kube|\.netrc|\.git-credentials|Cookies|Login Data|session-permissions\.json|(?:local-)?runtime-controls\.json|capability-installer\.json|integrations-secrets\.json|agent-tasks|agent-artifacts|Keychains?)(?:\/|$)/i;
const SENSITIVE_COMMAND_PATH=/(?:^|[\s'"=])(?:[^\s'";|&]*\/)?(?:\.env(?:\.[^\s'";|&]*)?|\.npmrc|\.pypirc|auth\.json|credentials?(?:\.[^\s'";|&]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^\s/'";|&]*\.(?:pem|p12|pfx|key)|\.ssh(?:\/[^\s'";|&]*)?|Keychains?(?:\/[^\s'";|&]*)?)(?=$|[\s'";|&)])/i;

function abortError(message="Local operation cancelled"){return Object.assign(new Error(message),{name:"AbortError"});}
function cleanOutput(value,max=MAX_OUTPUT){
  return redactSecrets(String(value??""),max*2)
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,"[REDACTED_SECRET]")
    .replace(/(^|\n)([^\n=]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[^\n=]*)=[^\n]*/gi,"$1$2=[REDACTED]")
    .slice(0,max);
}
function safeSummary(value,max=160){return cleanOutput(value,max).replace(/[\u0000-\u001f\u007f]+/g," ").replace(/\s+/g," ").trim().slice(0,max);}
function inside(root,target){return target===root||target.startsWith(`${root}${path.sep}`);}
function nearestExisting(target){let current=target;while(!fs.existsSync(current)){const parent=path.dirname(current);if(parent===current)break;current=parent;}return current;}
function realDirectory(value){const resolved=fs.realpathSync(path.resolve(value));if(!fs.statSync(resolved).isDirectory())throw Object.assign(new Error("workspace root is not a directory"),{code:"WORKSPACE_ROOT_INVALID"});return resolved;}

export class WorkspaceScope{
  constructor(root){this.root=realDirectory(root);}
  resolve(value,{mustExist=true,allowRoot=true}={}){
    const raw=String(value??".");
    if(!raw||raw.includes("\u0000"))throw Object.assign(new Error("invalid path"),{code:"LOCAL_PATH_INVALID"});
    const candidate=path.resolve(this.root,raw),existing=nearestExisting(candidate),realExisting=fs.realpathSync(existing);
    if(!inside(this.root,realExisting))throw Object.assign(new Error("path escapes the authorized workspace"),{code:"LOCAL_PATH_SCOPE_DENIED"});
    if(mustExist&&!fs.existsSync(candidate))throw Object.assign(new Error("path does not exist"),{code:"LOCAL_PATH_NOT_FOUND"});
    const resolved=fs.existsSync(candidate)?fs.realpathSync(candidate):path.join(realExisting,path.relative(existing,candidate));
    if(!inside(this.root,resolved)||(!allowRoot&&resolved===this.root))throw Object.assign(new Error("path is outside the allowed operation scope"),{code:"LOCAL_PATH_SCOPE_DENIED"});
    return resolved;
  }
  relative(value){const rel=path.relative(this.root,value);return rel||".";}
}
export function isSensitiveLocalPath(value){return SENSITIVE_PATH.test(String(value??"").replace(/\\/g,"/"));}
function assertSafeContentPath(value){if(isSensitiveLocalPath(value))throw Object.assign(new Error("credential-bearing paths are blocked by the hard safety boundary"),{code:"LOCAL_SENSITIVE_PATH_BLOCKED"});return value;}
function assertSafeTree(target,scope){
  assertSafeContentPath(scope.relative(target));
  if(!fs.existsSync(target)||!fs.statSync(target).isDirectory())return target;
  const pending=[target];
  while(pending.length){const dir=pending.pop();for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);assertSafeContentPath(scope.relative(full));if(entry.isDirectory()&&!entry.isSymbolicLink())pending.push(full);}}
  return target;
}

function schema(properties,required=[]){return {type:"object",additionalProperties:false,required,properties};}
const pathArg={type:"string",minLength:1,maxLength:4096};
const capabilities=[
  {name:"terminal_exec",family:"terminal",displayName:"Terminal",description:"在授权 workspace 内以 executable + args 结构化执行一个本机命令；不经过 shell。",inputSchema:schema({executable:{type:"string",minLength:1,maxLength:1024},args:{type:"array",maxItems:256,items:{type:"string",maxLength:16384}},cwd:pathArg,env:{type:"object",maxProperties:32,additionalProperties:{type:"string",maxLength:16384}},timeout_ms:{type:"integer",minimum:100,maximum:600000},max_output_chars:{type:"integer",minimum:256,maximum:131072}},["executable"]),permissions:["terminal.execute","workspace.read"],riskLevel:"medium",sideEffect:"unknown",tags:["terminal","command","test","build","development"]},
  {name:"terminal_session_start",family:"terminal",displayName:"Terminal Session",description:"在授权 workspace 内启动可持续运行的开发命令；返回 session id，进程不会阻塞 Core。",inputSchema:schema({executable:{type:"string",minLength:1,maxLength:1024},args:{type:"array",maxItems:256,items:{type:"string",maxLength:16384}},cwd:pathArg,env:{type:"object",maxProperties:32,additionalProperties:{type:"string",maxLength:16384}}},["executable"]),permissions:["terminal.execute","process.start","workspace.read"],riskLevel:"medium",sideEffect:"non_idempotent",tags:["terminal","session","server","watch","long task"]},
  {name:"terminal_session_write",family:"terminal",displayName:"Terminal Session",description:"向 Agent 自己启动的 terminal session 写入 stdin。",inputSchema:schema({session_id:{type:"string",pattern:"^term_[a-f0-9]{16}$"},data:{type:"string",maxLength:65536}},["session_id","data"]),permissions:["terminal.execute"],riskLevel:"medium",sideEffect:"non_idempotent",tags:["terminal","session","stdin"]},
  {name:"terminal_session_read",family:"terminal",displayName:"Terminal Session",description:"读取 Agent 自己启动的 terminal session 的增量脱敏输出与状态。",inputSchema:schema({session_id:{type:"string",pattern:"^term_[a-f0-9]{16}$"},cursor:{type:"integer",minimum:0}},["session_id"]),permissions:["terminal.execute","read"],riskLevel:"low",sideEffect:"none",tags:["terminal","session","logs","output"]},
  {name:"terminal_session_stop",family:"terminal",displayName:"Terminal Session",description:"停止 Agent 自己启动的 terminal session 及其完整 process group。",inputSchema:schema({session_id:{type:"string",pattern:"^term_[a-f0-9]{16}$"}},["session_id"]),permissions:["terminal.execute","process.stop"],riskLevel:"medium",sideEffect:"idempotent",tags:["terminal","session","stop","cancel"]},
  {name:"fs_read",family:"filesystem",displayName:"Filesystem",description:"读取授权 workspace 内的小型文本文件；binary 与大型文件只返回 metadata。",inputSchema:schema({path:pathArg,start_line:{type:"integer",minimum:1},max_lines:{type:"integer",minimum:1,maximum:5000}},["path"]),permissions:["workspace.read"],riskLevel:"low",sideEffect:"none",tags:["filesystem","file","read","source"]},
  {name:"fs_list",family:"filesystem",displayName:"Filesystem",description:"列出授权 workspace 内目录，不进行全盘扫描。",inputSchema:schema({path:pathArg,depth:{type:"integer",minimum:1,maximum:4},limit:{type:"integer",minimum:1,maximum:1000}},[]),permissions:["workspace.read"],riskLevel:"low",sideEffect:"none",tags:["filesystem","list","directory","files"]},
  {name:"fs_search",family:"filesystem",displayName:"Filesystem",description:"在授权 workspace 内按文本或文件名搜索，跳过 binary 与大型文件。",inputSchema:schema({query:{type:"string",minLength:1,maxLength:1000},path:pathArg,mode:{type:"string",enum:["content","name"]},limit:{type:"integer",minimum:1,maximum:500}},["query"]),permissions:["workspace.read"],riskLevel:"low",sideEffect:"none",tags:["filesystem","search","grep","find","source"]},
  {name:"fs_stat",family:"filesystem",displayName:"Filesystem",description:"读取授权 workspace 内路径的安全 metadata。",inputSchema:schema({path:pathArg},["path"]),permissions:["workspace.read"],riskLevel:"low",sideEffect:"none",tags:["filesystem","stat","metadata"]},
  {name:"fs_mkdir",family:"filesystem",displayName:"Filesystem",description:"在授权 workspace 内建立目录。",inputSchema:schema({path:pathArg,recursive:{type:"boolean"}},["path"]),permissions:["workspace.write"],riskLevel:"medium",sideEffect:"idempotent",tags:["filesystem","directory","create"]},
  {name:"fs_write",family:"filesystem",displayName:"Filesystem",description:"在授权 workspace 内新建文本文件；已存在的文件必须使用带前置条件的 fs_patch。",inputSchema:schema({path:pathArg,content:{type:"string",maxLength:1048576}},["path","content"]),permissions:["workspace.write"],riskLevel:"medium",sideEffect:"non_idempotent",tags:["filesystem","write","create","file"]},
  {name:"fs_patch",family:"filesystem",displayName:"Filesystem",description:"对授权 workspace 内文本文件执行精确 old_text/new_text patch；默认要求每段旧文本只出现一次。",inputSchema:schema({path:pathArg,changes:{type:"array",minItems:1,maxItems:100,items:{type:"object",additionalProperties:false,required:["old_text","new_text"],properties:{old_text:{type:"string",minLength:1,maxLength:262144},new_text:{type:"string",maxLength:262144},expected_occurrences:{type:"integer",minimum:1,maximum:100}}}}},["path","changes"]),permissions:["workspace.write"],riskLevel:"medium",sideEffect:"non_idempotent",tags:["filesystem","patch","edit","modify","source"]},
  {name:"fs_copy",family:"filesystem",displayName:"Filesystem",description:"在授权 workspace 内复制一个文件或目录；不会覆盖现有目标。",inputSchema:schema({source:pathArg,destination:pathArg},["source","destination"]),permissions:["workspace.write"],riskLevel:"medium",sideEffect:"non_idempotent",tags:["filesystem","copy"]},
  {name:"fs_move",family:"filesystem",displayName:"Filesystem",description:"在授权 workspace 内移动或重命名路径；不会覆盖现有目标。",inputSchema:schema({source:pathArg,destination:pathArg},["source","destination"]),permissions:["workspace.write"],riskLevel:"medium",sideEffect:"non_idempotent",tags:["filesystem","move","rename"]},
  {name:"fs_delete",family:"filesystem",displayName:"Filesystem",description:"将授权 workspace 内目标移入 workspace 内的 .companion-trash；不得删除 workspace root。",inputSchema:schema({path:pathArg},["path"]),permissions:["workspace.write"],riskLevel:"medium",sideEffect:"non_idempotent",tags:["filesystem","delete","remove","trash"]}
];

function publicCapability(item,available){
  const base={...item,id:`native:${item.name}`,capabilityId:item.family,idFamily:item.family,sourceType:"native",sourceId:item.family,integrationName:item.family==="terminal"?"Terminal":"Filesystem",availability:available?"available":"needs_workspace",enabled:available};
  base.resolveInvocation=args=>{
    if(item.name.startsWith("terminal_")&&SECRET_DISCOVERY.test(`${args?.executable??""} ${(args?.args??[]).join(" ")}`))return {...base,riskLevel:"high",permissions:[...base.permissions,"sensitive"],sideEffect:"non_idempotent",hardSafetyBoundary:true,resolveInvocation:null};
    return null;
  };
  return base;
}

function latestUserText(messages){const item=[...(messages??[])].reverse().find(x=>x?.role==="user");return typeof item?.content==="string"?item.content:JSON.stringify(item?.content??"");}
export function taskNeedsLocalRuntime(messages){
  const text=latestUserText(messages);
  const needed=/(?:终端|\bterminal\b|\bterminal_exec\b|命令|\bcommand\b|\bshell\b|\bbash\b|\bpwd\b|\bfs_(?:read|list|search|stat|patch|write|mkdir|copy|move|delete)\b|日志|\blogs?\b|测试|\btests?\b|\bbuild\b|编译|源码|代码|文件|目录|\bworkspace\b|\brepo(?:sitory)?\b|项目|修复|\bbugs?\b|开发|\bnpm\b|\bnode\b|\bpython\b|\bswift\b|\bgit\b)/i.test(text);
  return {needed,reason:needed?"任务需要结构化的本机终端或授权 workspace 文件能力":"no local development intent"};
}

function selectCapabilities(messages,available){
  if(!available)return [];
  const text=latestUserText(messages),long=/(?:\bdev server\b|\bwatch\b|长任务|持续运行|后台服务|\bnpm\s+(?:run\s+)?dev\b)/i.test(text);
  const mutations=/(?:修改|修复|写入|创建|新增|\bpatch\b|\bedit\b|\bwrite\b|\bfix\b|\bimplement\b|删除|移动|复制|\brename\b|\bmove\b|\bcopy\b)/i.test(text);
  const selected=new Set(["terminal_exec","fs_read","fs_list","fs_search","fs_stat"]);
  if(mutations){selected.add("fs_patch");selected.add("fs_write");selected.add("fs_mkdir");}
  if(long)for(const name of ["terminal_session_start","terminal_session_read","terminal_session_write","terminal_session_stop"])selected.add(name);
  if(/(?:删除|\bremove\b|\bdelete\b|\btrash\b)/i.test(text))selected.add("fs_delete");
  if(/(?:移动|重命名|\bmove\b|\brename\b)/i.test(text))selected.add("fs_move");
  if(/(?:复制|\bcopy\b)/i.test(text))selected.add("fs_copy");
  const priority=mutations?["fs_patch","terminal_exec","fs_read","fs_search","fs_list","fs_stat","fs_write","fs_mkdir","terminal_session_start","terminal_session_read","terminal_session_write","terminal_session_stop","fs_copy","fs_move","fs_delete"]:["terminal_exec","fs_read","fs_search","fs_list","fs_stat","terminal_session_start","terminal_session_read","terminal_session_write","terminal_session_stop","fs_copy","fs_move","fs_delete"];
  return priority.filter(name=>selected.has(name)).slice(0,12).map(name=>publicCapability(capabilities.find(item=>item.name===name),true));
}

export function localAgentCapabilityContext(messages,{workspaceRoot=null,controls=localRuntimeControls}={}){
  const intent=taskNeedsLocalRuntime(messages);if(!intent.needed)return null;
  let root=null;try{if(workspaceRoot)root=realDirectory(workspaceRoot);}catch{}
  const selected=selectCapabilities(messages,Boolean(root)).filter(item=>controls.enabled(item.idFamily));
  const guidance=[
    "【Companion Local Runtime｜仅在本机开发/文件意图出现时生效】",
    root?`本轮 workspace 已由调用方授权：${root}。所有 terminal cwd 与 filesystem path 必须位于该 root 内。`:"本轮没有调用方授权的 workspace path；不得调用或声称拥有 Terminal/Filesystem。",
    "优先使用结构化 terminal_exec(executable,args,cwd)，只有确实需要 shell semantics 时才显式执行 /bin/bash -lc；源码修改优先 fs_patch。",
    "不得读取或输出 credential、Keychain、.ssh、环境变量全集或 .env secret。命令输出、源码、diff 与日志只属于当前 task context，不进入 Shared Memory。",
    "删除使用 workspace 内可恢复的 .companion-trash；未知 WIP、workspace root 与边界外路径不可破坏。"
  ].join("\n");
  return {intent,workspaceRoot:root,guidance,capabilities:selected,tools:selected.map(cap=>({type:"function",function:{name:cap.name,description:cap.description,parameters:cap.inputSchema}}))};
}

function appendBounded(record,key,chunk){const text=cleanOutput(chunk,MAX_OUTPUT);record[key]=(record[key]+text).slice(-MAX_OUTPUT);record.sequence+=text.length;}
function validateCommand(executable,args,env,{scope,cwd}={}){
  const command=`${executable} ${(args??[]).join(" ")}`;
  if(SECRET_DISCOVERY.test(command))throw Object.assign(new Error("credential discovery commands are blocked by the hard safety boundary"),{code:"LOCAL_SECRET_DISCOVERY_BLOCKED"});
  if(SENSITIVE_COMMAND_PATH.test(command))throw Object.assign(new Error("credential-bearing command paths are blocked by the hard safety boundary"),{code:"LOCAL_SENSITIVE_PATH_BLOCKED"});
  if(PIPE_INSTALL.test(command))throw Object.assign(new Error("unknown pipe-to-shell installers are blocked"),{code:"LOCAL_UNTRUSTED_INSTALLER_BLOCKED"});
  if(scope&&cwd){
    const pathHints=command.match(/(?:~\/|\.{1,2}\/|\/(?:Users|System|Library|etc|private|var)\/)[^\s'";|&)]*/g)??[];
    for(const hint of pathHints){const expanded=hint.startsWith("~/")?path.join(process.env.HOME??"/",hint.slice(2)):hint,target=path.resolve(cwd,expanded);if(!inside(scope.root,target))throw Object.assign(new Error("command contains a path outside the authorized workspace"),{code:"LOCAL_COMMAND_SCOPE_DENIED"});}
  }
  for(const [key,value] of Object.entries(env??{})){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||SENSITIVE_ENV.test(key)||FORBIDDEN_ENV.test(key))throw Object.assign(new Error("unsafe environment override"),{code:"LOCAL_ENV_OVERRIDE_DENIED"});if(String(value).includes("\u0000"))throw new Error("invalid environment value");}
}
function childEnv(overrides={}){const result={};for(const [key,value] of Object.entries(process.env))if(!SENSITIVE_ENV.test(key))result[key]=value;for(const [key,value] of Object.entries(overrides))result[key]=String(value);return result;}

export class LocalAgentRuntime{
  constructor({controls=localRuntimeControls}={}){this.controls=controls;this.sessions=new Map();this.activeControllers=new Map();this.controls.onChange?.(snapshot=>{if(!snapshot.enabled.terminal){for(const [controller,family] of this.activeControllers)if(family==="terminal")controller.abort();this.terminateAllSync();}});process.once("exit",()=>this.terminateAllSync());}
  terminateAllSync(){for(const record of this.sessions.values())if(record.status==="running"){try{process.kill(-record.pid,"SIGTERM");}catch{}record.status="stopped";}}
  capabilities({available=true}={}){return capabilities.map(x=>publicCapability(x,available));}
  async execute(name,args,{workspaceRoot,sessionId="",signal,onProgress=()=>{}}={}){
    const started=Date.now();let ok=false;
    const family=String(name).startsWith("fs_")?"filesystem":"terminal",controller=new AbortController(),operationSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;this.activeControllers.set(controller,family);
    try{
      this.controls.assertEnabled(family);
      const scope=new WorkspaceScope(workspaceRoot);
      let result;
      if(name==="terminal_exec")result=await this.exec(args,{scope,signal:operationSignal,onProgress});
      else if(name==="terminal_session_start")result=await this.start(args,{scope,owner:sessionId,signal:operationSignal,onProgress});
      else if(name==="terminal_session_write")result=this.write(args,{owner:sessionId});
      else if(name==="terminal_session_read")result=this.read(args,{owner:sessionId});
      else if(name==="terminal_session_stop")result=await this.stop(args.session_id,{owner:sessionId});
      else if(name.startsWith("fs_"))result=await this.filesystem(name,args,scope);
      else throw Object.assign(new Error("unknown local runtime tool"),{code:"LOCAL_TOOL_NOT_FOUND"});
      ok=result?.ok!==false;return result;
    }finally{this.activeControllers.delete(controller);invocationLedger.append({provider:"local",model:"runtime",publicModel:"yuna-chat",feature:name.startsWith("fs_")?"filesystem":"terminal",source:"native_agent",sessionId,inputTokens:null,outputTokens:null,cachedInputTokens:null,reasoningTokens:null,usageSource:"non_model",durationMs:Date.now()-started,success:ok});}
  }
  async exec(args,{scope,signal,onProgress}){
    const executable=String(args.executable),argv=(args.args??[]).map(String),env=args.env??{},cwd=scope.resolve(args.cwd??".");validateCommand(executable,argv,env,{scope,cwd});if(!fs.statSync(cwd).isDirectory())throw new Error("terminal cwd must be a directory");
    const timeoutMs=Math.max(100,Math.min(600000,Number(args.timeout_ms)||120000)),max=Math.max(256,Math.min(MAX_OUTPUT,Number(args.max_output_chars)||MAX_OUTPUT));
    if(signal?.aborted)throw abortError();
    return await new Promise((resolve,reject)=>{
      const child=spawn(executable,argv,{cwd,env:childEnv(env),stdio:["ignore","pipe","pipe"],shell:false,detached:true});let stdout="",stderr="",settled=false,timedOut=false;
      const finish=(error,code,termSignal)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener?.("abort",abort);if(error)return reject(error);const safeOut=cleanOutput(stdout,max),safeErr=cleanOutput(stderr,max);resolve({ok:code===0,modelContent:JSON.stringify({exit_code:code,signal:termSignal??null,stdout:safeOut,stderr:safeErr,timed_out:timedOut,truncated:stdout.length>max||stderr.length>max}),durableContent:`Terminal finished: ${path.basename(executable)} exited ${code}${timedOut?" after timeout":""}.`,exitCode:code});};
      const terminate=reason=>{try{process.kill(-child.pid,"SIGTERM");}catch{}setTimeout(()=>{try{process.kill(-child.pid,"SIGKILL");}catch{}},1500).unref?.();if(reason==="abort")finish(abortError());};
      const abort=()=>terminate("abort"),timer=setTimeout(()=>{timedOut=true;terminate("timeout");},timeoutMs);timer.unref?.();signal?.addEventListener?.("abort",abort,{once:true});
      child.stdout.on("data",chunk=>{stdout=(stdout+String(chunk)).slice(-MAX_OUTPUT*2);onProgress({type:"terminal.output",stream:"stdout",preview:safeSummary(chunk)});});
      child.stderr.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-MAX_OUTPUT*2);onProgress({type:"terminal.output",stream:"stderr",preview:safeSummary(chunk)});});
      child.once("error",error=>finish(error));child.once("close",(code,termSignal)=>finish(null,code,termSignal));
    });
  }
  async start(args,{scope,owner,signal,onProgress}){
    const executable=String(args.executable),argv=(args.args??[]).map(String),env=args.env??{},cwd=scope.resolve(args.cwd??".");validateCommand(executable,argv,env,{scope,cwd});if(signal?.aborted)throw abortError();
    const id=`term_${crypto.randomBytes(8).toString("hex")}`,child=spawn(executable,argv,{cwd,env:childEnv(env),stdio:["pipe","pipe","pipe"],shell:false,detached:true});
    const record={id,owner:String(owner),child,pid:child.pid,cwd:scope.relative(cwd),executable:path.basename(executable),stdout:"",stderr:"",sequence:0,status:"running",exitCode:null,signal:null,startedAt:new Date().toISOString()};this.sessions.set(id,record);
    if(signal){record.abort=()=>{this.stop(id,{owner}).catch(()=>{});};record.abortSignal=signal;signal.addEventListener("abort",record.abort,{once:true});}
    child.stdout.on("data",chunk=>{appendBounded(record,"stdout",chunk);onProgress({type:"terminal.output",session_id:id,stream:"stdout",preview:safeSummary(chunk)});});
    child.stderr.on("data",chunk=>{appendBounded(record,"stderr",chunk);onProgress({type:"terminal.output",session_id:id,stream:"stderr",preview:safeSummary(chunk)});});
    child.once("error",error=>{record.status="failed";record.stderr=cleanOutput(error.message);});child.once("close",(code,termSignal)=>{if(record.status!=="stopped")record.status="exited";record.exitCode=code;record.signal=termSignal;record.finishedAt=new Date().toISOString();if(record.abort)record.abortSignal?.removeEventListener?.("abort",record.abort);});
    return {ok:true,modelContent:JSON.stringify({session_id:id,pid:child.pid,status:"running",cwd:record.cwd,executable:record.executable}),durableContent:`Terminal session started: ${record.executable}.`,sessionId:id};
  }
  owned(id,owner){const record=this.sessions.get(String(id));if(!record||record.owner!==String(owner))throw Object.assign(new Error("terminal session not found in this Agent session"),{code:"TERMINAL_SESSION_NOT_FOUND"});return record;}
  write(args,{owner}){const record=this.owned(args.session_id,owner);if(record.status!=="running"||!record.child.stdin.writable)throw new Error("terminal session is not writable");record.child.stdin.write(String(args.data));return {ok:true,modelContent:JSON.stringify({session_id:record.id,written_chars:String(args.data).length}),durableContent:"Terminal session input sent."};}
  read(args,{owner}){const record=this.owned(args.session_id,owner),cursor=Math.max(0,Number(args.cursor)||0),combined=`[stdout]\n${record.stdout}\n[stderr]\n${record.stderr}`,content=combined.slice(cursor);return {ok:true,modelContent:JSON.stringify({session_id:record.id,status:record.status,exit_code:record.exitCode,signal:record.signal,cursor:combined.length,output:content}),durableContent:`Terminal session status: ${record.status}.`};}
  async stop(id,{owner}={}){const record=this.owned(id,owner);if(record.status==="running"){try{process.kill(-record.pid,"SIGTERM");}catch{}await new Promise(resolve=>{const timer=setTimeout(()=>{try{process.kill(-record.pid,"SIGKILL");}catch{}resolve();},1500);record.child.once("close",()=>{clearTimeout(timer);resolve();});});record.status="stopped";}return {ok:true,modelContent:JSON.stringify({session_id:record.id,status:record.status}),durableContent:"Terminal session stopped."};}
  async stopAllForOwner(owner){const ids=[...this.sessions.values()].filter(x=>x.owner===String(owner)&&x.status==="running").map(x=>x.id);for(const id of ids)await this.stop(id,{owner});return ids.length;}
  async filesystem(name,args,scope){
    if(name==="fs_read"){
      const target=assertSafeContentPath(scope.resolve(args.path)),stat=fs.statSync(target);if(!stat.isFile())throw new Error("fs.read requires a file");
      if(stat.size>MAX_READ)return {ok:true,modelContent:JSON.stringify({path:scope.relative(target),bytes:stat.size,binary:null,content:null,reason:"file_too_large"}),durableContent:`Filesystem inspected ${scope.relative(target)} (${stat.size} bytes).`};
      const buffer=fs.readFileSync(target),binary=buffer.includes(0);if(binary)return {ok:true,modelContent:JSON.stringify({path:scope.relative(target),bytes:stat.size,binary:true,content:null}),durableContent:`Filesystem inspected binary file ${scope.relative(target)}.`};
      const lines=buffer.toString("utf8").split("\n"),start=Math.max(1,Number(args.start_line)||1),count=Math.max(1,Math.min(5000,Number(args.max_lines)||500));return {ok:true,modelContent:JSON.stringify({path:scope.relative(target),bytes:stat.size,binary:false,start_line:start,end_line:Math.min(lines.length,start+count-1),total_lines:lines.length,content:lines.slice(start-1,start-1+count).join("\n")}),durableContent:`Filesystem read ${scope.relative(target)}.`};
    }
    if(name==="fs_list"){
      const target=assertSafeContentPath(scope.resolve(args.path??".")),depth=Math.max(1,Math.min(4,Number(args.depth)||2)),limit=Math.max(1,Math.min(1000,Number(args.limit)||300)),entries=[];
      const walk=(dir,level)=>{if(entries.length>=limit||level>depth)return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entries.length>=limit)break;const full=path.join(dir,entry.name),rel=scope.relative(full);if(isSensitiveLocalPath(rel))continue;entries.push({path:rel,type:entry.isDirectory()?"directory":entry.isSymbolicLink()?"symlink":"file"});if(entry.isDirectory()&&!entry.isSymbolicLink())walk(full,level+1);}};walk(target,1);return {ok:true,modelContent:JSON.stringify({path:scope.relative(target),entries,truncated:entries.length>=limit}),durableContent:`Filesystem listed ${entries.length} entries.`};
    }
    if(name==="fs_search"){
      const target=scope.resolve(args.path??"."),query=String(args.query),mode=args.mode??"content",limit=Math.max(1,Math.min(500,Number(args.limit)||100)),results=[];
      const walk=dir=>{if(results.length>=limit)return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(results.length>=limit)break;if([".git","node_modules",".build",".companion-trash"].includes(entry.name))continue;const full=path.join(dir,entry.name),rel=scope.relative(full);if(isSensitiveLocalPath(rel))continue;if(mode==="name"&&entry.name.toLowerCase().includes(query.toLowerCase()))results.push({path:rel,type:entry.isDirectory()?"directory":"file"});if(entry.isDirectory())walk(full);else if(mode==="content"&&entry.isFile()){let stat;try{stat=fs.statSync(full);}catch{continue;}if(stat.size>2*1024*1024)continue;let buffer;try{buffer=fs.readFileSync(full);}catch{continue;}if(buffer.includes(0))continue;const lines=buffer.toString("utf8").split("\n");for(let index=0;index<lines.length&&results.length<limit;index++)if(lines[index].toLowerCase().includes(query.toLowerCase()))results.push({path:rel,line:index+1,preview:lines[index].slice(0,500)});}}};walk(target);return {ok:true,modelContent:JSON.stringify({query,mode,results,truncated:results.length>=limit}),durableContent:`Filesystem search found ${results.length} matches.`};
    }
    if(name==="fs_stat"){const target=assertSafeContentPath(scope.resolve(args.path)),stat=fs.lstatSync(target);return {ok:true,modelContent:JSON.stringify({path:scope.relative(target),type:stat.isDirectory()?"directory":stat.isSymbolicLink()?"symlink":stat.isFile()?"file":"other",bytes:stat.size,mode:(stat.mode&0o777).toString(8),modified_at:stat.mtime.toISOString()}),durableContent:`Filesystem inspected ${scope.relative(target)}.`};}
    if(name==="fs_mkdir"){const target=assertSafeContentPath(scope.resolve(args.path,{mustExist:false,allowRoot:false}));fs.mkdirSync(target,{recursive:args.recursive!==false});return {ok:true,modelContent:JSON.stringify({path:scope.relative(target),created:true}),durableContent:`Filesystem created directory ${scope.relative(target)}.`};}
    if(name==="fs_write"){
      const target=assertSafeContentPath(scope.resolve(args.path,{mustExist:false,allowRoot:false})),exists=fs.existsSync(target);if(exists)throw Object.assign(new Error("existing files must be changed with fs_patch so preconditions protect user WIP"),{code:"FS_PATCH_REQUIRED"});const content=String(args.content);if(Buffer.byteLength(content)>MAX_WRITE)throw new Error("write content exceeds limit");fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content,"utf8");return {ok:true,modelContent:JSON.stringify({path:scope.relative(target),bytes:Buffer.byteLength(content),created:true}),durableContent:`Filesystem created ${scope.relative(target)}.`};
    }
    if(name==="fs_patch"){
      const target=assertSafeContentPath(scope.resolve(args.path,{allowRoot:false})),stat=fs.statSync(target);if(!stat.isFile()||stat.size>MAX_WRITE)throw new Error("patch target must be a small text file");let content=fs.readFileSync(target,"utf8");const summaries=[];
      for(const change of args.changes){const oldText=String(change.old_text),newText=String(change.new_text),expected=Number(change.expected_occurrences)||1;let count=0,at=0;while((at=content.indexOf(oldText,at))>=0){count++;at+=oldText.length;}if(count!==expected)throw Object.assign(new Error(`patch precondition failed: expected ${expected} occurrence(s), found ${count}`),{code:"FS_PATCH_PRECONDITION_FAILED"});content=content.split(oldText).join(newText);summaries.push({old_chars:oldText.length,new_chars:newText.length,occurrences:count});}fs.writeFileSync(target,content,"utf8");return {ok:true,modelContent:JSON.stringify({path:scope.relative(target),changes:summaries}),durableContent:`Filesystem patched ${scope.relative(target)} (${summaries.length} changes).`};
    }
    if(name==="fs_copy"||name==="fs_move"){
      const source=assertSafeTree(scope.resolve(args.source,{allowRoot:false}),scope),destination=assertSafeContentPath(scope.resolve(args.destination,{mustExist:false,allowRoot:false}));if(fs.existsSync(destination))throw Object.assign(new Error("destination exists; refusing to overwrite unknown WIP"),{code:"FS_DESTINATION_EXISTS"});fs.mkdirSync(path.dirname(destination),{recursive:true});if(name==="fs_copy")fs.cpSync(source,destination,{recursive:true,errorOnExist:true});else fs.renameSync(source,destination);return {ok:true,modelContent:JSON.stringify({source:scope.relative(source),destination:scope.relative(destination)}),durableContent:`Filesystem ${name==="fs_copy"?"copied":"moved"} an item.`};
    }
    if(name==="fs_delete"){
      const target=assertSafeTree(scope.resolve(args.path,{allowRoot:false}),scope),trash=path.join(scope.root,".companion-trash");if(inside(target,trash))throw new Error("cannot trash the trash directory");fs.mkdirSync(trash,{recursive:true});const destination=path.join(trash,`${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${path.basename(target)}`);fs.renameSync(target,destination);return {ok:true,modelContent:JSON.stringify({path:scope.relative(target),recoverable:true,trash_path:scope.relative(destination)}),durableContent:`Filesystem moved ${scope.relative(target)} to recoverable workspace trash.`};
    }
    throw new Error("unsupported filesystem operation");
  }
}

export const localAgentRuntime=new LocalAgentRuntime();
export function isLocalAgentToolName(name){return String(name).startsWith("terminal_")||String(name).startsWith("fs_");}
