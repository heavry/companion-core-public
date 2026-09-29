#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXPECTED_TEAM="852GWN26C8";
const EXPECTED_BUNDLE="local.companion.mac";

function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}}
function readJson(file){return JSON.parse(fs.readFileSync(file,"utf8"));}
function updateState(file,patch){const state=readJson(file),next={...state,...patch,updated_at:new Date().toISOString()};atomicJson(file,next);return next;}
function ensureAbsolute(value,label){const resolved=path.resolve(String(value??""));if(!path.isAbsolute(String(value??""))||resolved==="/")throw new Error(`${label} must be an exact absolute path`);return resolved;}
function run(executable,args,{timeoutMs=30000,allowFailure=false}={}){return new Promise((resolve,reject)=>{const child=spawn(executable,args,{stdio:["ignore","pipe","pipe"],shell:false});let stdout="",stderr="",settled=false;const finish=(error,code)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)return reject(error);const result={ok:code===0,code,stdout:stdout.slice(-131072),stderr:stderr.slice(-131072)};if(!result.ok&&!allowFailure)return reject(new Error(`${path.basename(executable)} failed (${code}): ${result.stderr||result.stdout}`));resolve(result);};const timer=setTimeout(()=>{try{child.kill("SIGTERM");}catch{}finish(new Error(`${path.basename(executable)} timed out`));},timeoutMs);child.stdout.on("data",chunk=>stdout+=String(chunk));child.stderr.on("data",chunk=>stderr+=String(chunk));child.once("error",error=>finish(error));child.once("close",code=>finish(null,code));});}
async function portOpen(port){const result=await run("/usr/sbin/lsof",["-nP",`-iTCP:${port}`,"-sTCP:LISTEN","-t"],{timeoutMs:5000,allowFailure:true});return result.ok&&result.stdout.trim().length>0;}
async function verifyArtifact(app){
  if(!fs.statSync(app).isDirectory())throw new Error("signed app artifact is missing");
  await run("/usr/bin/codesign",["--verify","--deep","--strict","--verbose=2",app],{timeoutMs:30000});
  const signing=await run("/usr/bin/codesign",["-dv","--verbose=4",app],{timeoutMs:30000}),detail=`${signing.stdout}\n${signing.stderr}`;
  if(!detail.includes(`TeamIdentifier=${EXPECTED_TEAM}`))throw new Error(`codesign TeamIdentifier must be ${EXPECTED_TEAM}`);
  if(!detail.includes(`Identifier=${EXPECTED_BUNDLE}`))throw new Error(`codesign Identifier must be ${EXPECTED_BUNDLE}`);
}
async function stopCandidate(){
  await run("/usr/bin/osascript",["-e",`tell application id \"${EXPECTED_BUNDLE}\" to quit`],{timeoutMs:10000,allowFailure:true});
  for(let attempt=0;attempt<40;attempt++){if(!(await portOpen(8770)))return;await delay(250);}
  throw new Error("Candidate :8770 remained active after the owned app quit; refusing to kill an unknown listener");
}
async function launchCandidate(app){await run("/usr/bin/open",[app],{timeoutMs:10000});}
async function candidateHealthy(){for(let attempt=0;attempt<60;attempt++){try{const response=await fetch("http://127.0.0.1:8770/health",{signal:AbortSignal.timeout(1500)}),body=await response.json();if(response.ok&&body?.ok===true&&body?.version==="0.2.8.0")return true;}catch{}await delay(500);}return false;}
function restoreSource(state){for(const snapshot of state.snapshots??[]){const target=ensureAbsolute(snapshot.path,"snapshot target"),backup=ensureAbsolute(snapshot.backup_path,"snapshot backup");if(!fs.existsSync(backup))throw new Error(`source snapshot is missing for ${path.basename(target)}`);fs.copyFileSync(backup,target);}}
function removeIfExists(target){if(fs.existsSync(target))fs.renameSync(target,`${target}.failed-${Date.now()}`);}

export async function executeMaintenanceRequest(request,hooks={}){
  const statePath=ensureAbsolute(request.state_path,"state path"),desktop=ensureAbsolute(request.desktop_app,"Desktop app"),artifact=request.artifact?ensureAbsolute(request.artifact,"artifact"):null,backup=ensureAbsolute(request.backup_app,"backup app"),stage=ensureAbsolute(request.staged_app,"staged app");
  const checkPort=hooks.portOpen??portOpen,verify=hooks.verifyArtifact??verifyArtifact,stop=hooks.stopCandidate??stopCandidate,launch=hooks.launchCandidate??launchCandidate,healthy=hooks.candidateHealthy??candidateHealthy;
  let state=readJson(statePath);if(state.transaction_id!==request.transaction_id)throw new Error("self-maintenance transaction id mismatch");
  const cancelled=()=>Boolean(request.cancel_path&&fs.existsSync(ensureAbsolute(request.cancel_path,"cancel path"))),checkCancelled=()=>{if(cancelled()){updateState(statePath,{status:"interrupted",interrupted_stage:request.action==="rollback"?"rolling_back":"deploying",recovery_action:"resume_or_rollback",failure:"self-maintenance cancelled before an irreversible stage"});throw Object.assign(new Error("self-maintenance cancelled before an irreversible stage"),{name:"AbortError"});}};checkCancelled();
  if(await checkPort(8765)){updateState(statePath,{status:"failed",failure:"production :8765 is active; Candidate self-maintenance fails closed",rollback_state:"not_started"});throw new Error("production :8765 is active; Candidate self-maintenance fails closed");}
  const rollback=async reason=>{
    updateState(statePath,{status:"rolling_back",rollback_state:"running",failure:String(reason??"manual rollback").slice(0,1000)});
    try{await stop();removeIfExists(desktop);if(!fs.existsSync(backup))throw new Error("Desktop Companion.app backup is missing");fs.renameSync(backup,desktop);state=readJson(statePath);restoreSource(state);await verify(desktop);await launch(desktop);if(!(await healthy()))throw new Error("restored Candidate failed health check");if(await checkPort(8765))throw new Error("production :8765 became active during rollback");return updateState(statePath,{status:"rolled_back",rollback_state:"completed",health_result:{candidate_8770:"healthy",production_8765:"down"},completed_at:new Date().toISOString()});}
    catch(error){updateState(statePath,{status:"rollback_failed",rollback_state:"failed",failure:String(error?.message??error).slice(0,1000)});throw error;}
  };
  if(request.action==="rollback")return rollback(request.reason??"manual rollback");
  if(request.action!=="deploy")throw new Error("unknown self-maintenance helper action");let stopped=false,swapped=false;
  try{
    if(!artifact)throw new Error("deploy artifact is required");if(!fs.existsSync(desktop))throw new Error("Desktop Companion.app is missing; a rollback source is required");if(fs.existsSync(backup)||fs.existsSync(stage))throw new Error("transaction backup or staged app already exists");
    await verify(artifact);checkCancelled();fs.cpSync(artifact,stage,{recursive:true,errorOnExist:true});await run("/usr/bin/xattr",["-dr","com.apple.FinderInfo",stage],{allowFailure:true});await run("/usr/bin/xattr",["-dr","com.apple.ResourceFork",stage],{allowFailure:true});await verify(stage);checkCancelled();
    updateState(statePath,{status:"deploying",deploy_result:{stage:"verified",staged_app:stage}});await stop();stopped=true;checkCancelled();fs.renameSync(desktop,backup);swapped=true;fs.renameSync(stage,desktop);await verify(desktop);if(cancelled())throw Object.assign(new Error("self-maintenance cancelled after swap"),{name:"AbortError"});await launch(desktop);
    if(!(await healthy()))throw new Error("new Candidate failed :8770 health/version check");if(await checkPort(8765))throw new Error("production :8765 became active during Candidate deploy");
    return updateState(statePath,{status:"completed",deploy_result:{stage:"deployed",desktop_app:desktop,backup_app:backup},health_result:{candidate_8770:"healthy",production_8765:"down"},rollback_state:"not_needed",completed_at:new Date().toISOString()});
  }catch(error){if(swapped)return rollback(error?.message??error);if(stopped&&fs.existsSync(desktop))try{await launch(desktop);}catch{}updateState(statePath,{status:error?.name==="AbortError"?"interrupted":"failed",interrupted_stage:error?.name==="AbortError"?"deploying":null,recovery_action:error?.name==="AbortError"?"resume_or_rollback":null,failure:String(error?.message??error).slice(0,1000),rollback_state:"not_needed"});throw error;}
}

async function main(){const index=process.argv.indexOf("--request"),requestPath=index>=0?process.argv[index+1]:null;if(!requestPath)throw new Error("usage: self-maintenance-helper.js --request /absolute/request.json");const request=readJson(ensureAbsolute(requestPath,"request"));if(Number(request.delay_ms)>0)await delay(Math.min(5000,Number(request.delay_ms)));await executeMaintenanceRequest(request);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(`self-maintenance helper failed: ${String(error?.message??error)}\n`);process.exitCode=1;});
