process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_PRIMARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_BASE_URL="";
process.env.TAVILY_BASE_URL="";process.env.TAVILY_API_KEY="";process.env.SEARXNG_BASE_URL="";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-runtime-controls-"));
process.env.DATABASE_PATH=path.join(root,"companion.db");
process.env.COMPANION_INVOCATION_LEDGER_PATH=path.join(root,"invocations.jsonl");
process.env.COMPANION_INVOCATION_SUMMARY_PATH=path.join(root,"invocations-summary.json");
process.env.COMPANION_PRICING_REVISIONS_PATH=path.join(root,"prices.json");
process.env.COMPANION_LOCAL_RUNTIME_CONTROLS_PATH=path.join(root,"controls.json");
process.env.COMPANION_PACKAGE_OPERATIONS_PATH=path.join(root,"packages.json");
process.env.COMPANION_SELF_MAINTENANCE_DIR=path.join(root,"self-maintenance");
process.env.COMPANION_SESSION_PERMISSIONS_PATH=path.join(root,"permissions.json");

const { localRuntimeControls }=await import("../src/local-runtime-controls.js");
const { LocalAgentRuntime,localAgentCapabilityContext }=await import("../src/local-agent-runtime.js");
const { SelfMaintenanceRuntime,selfMaintenanceCapabilityContext }=await import("../src/self-maintenance-runtime.js");
const workspace=path.join(root,"workspace");fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,"package.json"),'{"name":"companion-core"}\n');fs.mkdirSync(path.join(workspace,"CompanionMac"));fs.writeFileSync(path.join(workspace,"CompanionMac","Package.swift"),"// fixture\n");fs.mkdirSync(path.join(workspace,".git"));

const local=new LocalAgentRuntime({controls:localRuntimeControls}),pending=local.execute("terminal_exec",{executable:"/bin/sleep",args:["10"]},{workspaceRoot:workspace,sessionId:"controls-test"});await new Promise(resolve=>setTimeout(resolve,30));localRuntimeControls.update({terminal:false});await assert.rejects(pending,error=>error.name==="AbortError");assert.equal(localAgentCapabilityContext([{role:"user",content:"run terminal command"}],{workspaceRoot:workspace,controls:localRuntimeControls}).capabilities.some(item=>item.idFamily==="terminal"),false,"disabled Terminal is removed from selection immediately");
localRuntimeControls.update({terminal:true});

const waitingRunner=async(_executable,_args,{signal}={})=>new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(new Error("cancelled"),{name:"AbortError"})),{once:true})),self=new SelfMaintenanceRuntime({stateDir:path.join(root,"self-state"),runner:waitingRunner,controls:localRuntimeControls});const selfPending=self.execute("self_inspect",{},{workspaceRoot:workspace,sessionId:"controls-test"});await new Promise(resolve=>setTimeout(resolve,10));localRuntimeControls.update({self_maintenance:false});await assert.rejects(selfPending,error=>error.name==="AbortError");assert.equal(selfMaintenanceCapabilityContext([{role:"user",content:"self inspect Companion"}],{workspaceRoot:workspace,controls:localRuntimeControls}),null,"disabled Self Maintenance leaves no candidate tools");localRuntimeControls.update({self_maintenance:true});
const helperCancel=path.join(root,"helper.cancel");self.activeHelperCancels.add(helperCancel);localRuntimeControls.update({self_maintenance:false});assert.equal(fs.readFileSync(helperCancel,"utf8"),"cancelled\n","revocation also signals an already-dispatched deployment helper");localRuntimeControls.update({self_maintenance:true});

function response(){return {status:null,headers:null,body:"",writeHead(status,headers){this.status=status;this.headers=headers;},end(body=""){this.body=String(body);}};}
async function admin(method,pathName,body=null){const req=Readable.from(body===null?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;const res=response();const handled=await handleAdminApi(req,res,new URL(`http://127.0.0.1${pathName}`));assert.notEqual(handled,false);return {status:res.status,body:JSON.parse(res.body)};}
const { handleAdminApi }=await import("../src/admin.js");let api=await admin("GET","/admin/local-runtime-controls");assert.equal(api.status,200);assert.equal(api.body.enabled.terminal,true);api=await admin("PATCH","/admin/local-runtime-controls",{enabled:{terminal:false,self_maintenance:false}});assert.equal(api.status,200);assert.equal(api.body.enabled.terminal,false);assert.equal(api.body.enabled.filesystem,true,"partial PATCH preserves unrelated controls");api=await admin("GET","/admin/local-runtime-controls");assert.equal(api.body.enabled.self_maintenance,false);assert.equal(fs.statSync(process.env.COMPANION_LOCAL_RUNTIME_CONTROLS_PATH).mode&0o777,0o600,"persisted controls are private");

fs.rmSync(root,{recursive:true,force:true});console.log("local-runtime-controls-test: ok");
