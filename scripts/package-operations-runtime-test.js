process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_PRIMARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_BASE_URL="";
process.env.TAVILY_BASE_URL="";process.env.TAVILY_API_KEY="";process.env.SEARXNG_BASE_URL="";

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-package-runtime-"));
process.env.DATABASE_PATH=path.join(root,"companion.db");
process.env.COMPANION_INVOCATION_LEDGER_PATH=path.join(root,"invocations.jsonl");
process.env.COMPANION_INVOCATION_SUMMARY_PATH=path.join(root,"invocations-summary.json");
process.env.COMPANION_PRICING_REVISIONS_PATH=path.join(root,"prices.json");
process.env.COMPANION_LOCAL_RUNTIME_CONTROLS_PATH=path.join(root,"singleton-controls.json");
process.env.COMPANION_PACKAGE_OPERATIONS_PATH=path.join(root,"singleton-packages.json");

const { LocalRuntimeControls }=await import("../src/local-runtime-controls.js");
const { PackageOperationsRuntime,packageOperationsCapabilityContext }=await import("../src/package-operations-runtime.js");
const workspace=path.join(root,"workspace");fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,"package.json"),'{"name":"fixture","private":true}\n');fs.writeFileSync(path.join(workspace,"package-lock.json"),'{}\n');
const controlsPath=path.join(root,"controls.json"),controls=new LocalRuntimeControls({filePath:controlsPath});assert.equal(controls.snapshot().enabled.terminal,true);controls.update({terminal:false});assert.equal(new LocalRuntimeControls({filePath:controlsPath}).enabled("terminal"),false,"runtime revocation survives restart");controls.update({terminal:true});await assert.rejects(async()=>controls.update({terminal:"yes"}),/must be boolean/);assert.throws(()=>controls.update({root_access:true}),/unknown local runtime control/);

const calls=[];const runner=async(executable,args,{cwd,signal}={})=>{calls.push({executable,args:[...args],cwd});if(signal?.aborted)throw Object.assign(new Error("cancelled"),{name:"AbortError"});if(executable==="python3"&&args.join(" ")==="-m venv .venv"){const bin=path.join(cwd,".venv","bin");fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,"python"),"fixture");}return {ok:true,exitCode:0,stdout:executable==="brew"&&args[0]==="info"?'{"formulae":[{"name":"ripgrep","versions":{"stable":"14.1.1"}}]}':"",stderr:""};};
const statePath=path.join(root,"package-state.json"),runtime=new PackageOperationsRuntime({statePath,runner,controls,download:async(_url,target)=>fs.writeFileSync(target,"verified-binary")});
let context=packageOperationsCapabilityContext([{role:"user",content:"请安装 npm dependency"}],{workspaceRoot:workspace,controls});assert.deepEqual(context.capabilities.map(item=>item.name),["package_inspect","package_install","release_binary_install"]);controls.update({package_manager:false});assert.equal(packageOperationsCapabilityContext([{role:"user",content:"npm install dependency"}],{workspaceRoot:workspace,controls}),null);await assert.rejects(runtime.execute("package_inspect",{},{workspaceRoot:workspace}),error=>error.code==="LOCAL_RUNTIME_DISABLED");controls.update({package_manager:true});

const progress=[];let result=await runtime.execute("package_install",{manager:"npm",packages:[{name:"left-pad",version:"1.3.0"}]},{workspaceRoot:workspace,sessionId:"package-test",onProgress:event=>progress.push(event)});assert.equal(JSON.parse(result.modelContent).operation.location,"node_modules");assert.deepEqual(calls.find(item=>item.executable==="npm").args,["install","--save-exact","--ignore-scripts","--","left-pad@1.3.0"]);assert.equal(progress.at(-1).stage,"installed");
result=await runtime.execute("package_install",{manager:"pip",packages:[{name:"httpx",version:"0.27.2"}]},{workspaceRoot:workspace,sessionId:"package-test"});assert(calls.some(item=>item.executable.endsWith("/.venv/bin/python")&&item.args.includes("--only-binary=:all:")));assert(!calls.some(item=>item.args.includes("sudo")||item.args.includes("--global")));
result=await runtime.execute("package_install",{manager:"brew",packages:[{name:"ripgrep",version:"14.1.1"}]},{workspaceRoot:workspace,sessionId:"package-test"});assert(calls.some(item=>item.executable==="brew"&&item.args[0]==="info"&&item.args.includes("--formula")));assert(calls.some(item=>item.executable==="brew"&&item.args[0]==="install"&&item.args.includes("--formula")));

const digest=crypto.createHash("sha256").update("verified-binary").digest("hex"),url="https://github.com/example/tools/releases/download/v1.2.3/fixture";result=await runtime.execute("release_binary_install",{name:"fixture",version:"1.2.3",url,sha256:digest},{workspaceRoot:workspace,sessionId:"package-test"});const binary=path.join(workspace,".companion-tools","bin","fixture");assert.equal(fs.readFileSync(binary,"utf8"),"verified-binary");assert.equal(fs.statSync(binary).mode&0o777,0o700);assert.equal(JSON.parse(result.modelContent).operation.source,url);
await assert.rejects(runtime.execute("release_binary_install",{name:"bad",version:"1.0.0",url:"https://evil.example/tool",sha256:digest},{workspaceRoot:workspace}),error=>error.code==="PACKAGE_RELEASE_SOURCE_DENIED");await assert.rejects(runtime.execute("package_install",{manager:"npm",packages:[{name:"x",version:"latest"}]},{workspaceRoot:workspace}),error=>error.code==="PACKAGE_VERSION_NOT_PINNED");await assert.rejects(runtime.execute("package_install",{manager:"npm",packages:[{name:"https://evil.example/x",version:"1.0.0"}]},{workspaceRoot:workspace}),error=>error.code==="PACKAGE_NAME_INVALID");
assert(!fs.readFileSync(statePath,"utf8").includes("evil.example"),"rejected package input never enters provenance");

const wipRuntime=new PackageOperationsRuntime({statePath:path.join(root,"wip-state.json"),controls,runner:async(executable)=>({ok:true,exitCode:0,stdout:executable==="git"?" M package.json\n":"",stderr:""})});await assert.rejects(wipRuntime.execute("package_install",{manager:"npm",packages:[{name:"x",version:"1.0.0"}]},{workspaceRoot:workspace}),error=>error.code==="PACKAGE_MANIFEST_WIP");
const cancelControls=new LocalRuntimeControls({filePath:path.join(root,"cancel-controls.json")}),cancelRuntime=new PackageOperationsRuntime({statePath:path.join(root,"cancel-state.json"),controls:cancelControls,runner:async(executable,_args,{signal}={})=>executable==="git"?{ok:true,stdout:"",stderr:""}:new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(new Error("cancelled"),{name:"AbortError"})),{once:true}))});const pending=cancelRuntime.execute("package_install",{manager:"npm",packages:[{name:"x",version:"1.0.0"}]},{workspaceRoot:workspace});await new Promise(resolve=>setTimeout(resolve,10));cancelControls.update({package_manager:false});await assert.rejects(pending,error=>error.name==="AbortError");assert.equal(JSON.parse(fs.readFileSync(path.join(root,"cancel-state.json"),"utf8")).operations.at(-1).status,"cancelled","revocation cancels an active package process");

const persisted=new PackageOperationsRuntime({statePath,runner,controls});assert(persisted.snapshot().operations.some(item=>item.manager==="release_binary"&&item.sha256===digest));const ledger=fs.readFileSync(process.env.COMPANION_INVOCATION_LEDGER_PATH,"utf8").trim().split("\n").map(line=>JSON.parse(line));assert(ledger.some(item=>item.feature==="package"&&item.inputTokens===null&&item.usageSource==="non_model"));
fs.rmSync(root,{recursive:true,force:true});console.log("package-operations-runtime-test: ok");
