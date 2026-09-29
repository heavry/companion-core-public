import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { knownCapabilityManifest,validateCapabilityManifest,isSafeRelativePath } from "./capability-manifests.js";

function nowIso(){return new Date().toISOString();}
function cleanError(error){return String(error?.message??error??"unknown error").replace(/[\u0000-\u001f\u007f]/g," ").slice(0,400);}
function manifestDescriptor(manifest){
  return {id:manifest.id,name:manifest.displayName,type:manifest.type,version:manifest.version,source:manifest.source,sourceUrl:manifest.sourceUrl,upstreamCommit:manifest.upstreamCommit??null,license:manifest.license??null,entrypoint:manifest.entrypoint,transport:manifest.transport,permissions:[...manifest.permissions],riskClass:manifest.riskClass,installSteps:[...manifest.installSteps],healthCheck:manifest.healthCheck,uninstall:manifest.uninstall,configSchema:manifest.configSchema};
}
function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}
}
function command(executable,args,{cwd,env,timeoutMs=30000,signal}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,env,stdio:["ignore","pipe","pipe"],shell:false});let stdout="",stderr="",done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener?.("abort",abort);error?reject(error):resolve(value);};
    child.stdout.on("data",chunk=>{stdout=(stdout+chunk).slice(-65536);});child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-65536);});
    child.once("error",error=>finish(error));child.once("close",code=>code===0?finish(null,{stdout,stderr,code}):finish(Object.assign(new Error(`command failed (${code}): ${stderr||stdout}`),{code:"INSTALL_COMMAND_FAILED"})));
    const abort=()=>{child.kill("SIGTERM");finish(Object.assign(new Error("capability operation cancelled"),{name:"AbortError"}));};
    if(signal?.aborted)return abort();signal?.addEventListener?.("abort",abort,{once:true});
    const timer=setTimeout(()=>{child.kill("SIGTERM");finish(Object.assign(new Error("capability operation timed out"),{name:"TimeoutError"}));},timeoutMs);timer.unref?.();
  });
}

async function downloadPinnedArtifact(manifest,{signal}={}){
  const response=await fetch(manifest.artifact.url,{signal,redirect:"follow",headers:{"user-agent":"Companion-Capability-Installer/1"}});
  if(!response.ok)throw new Error(`artifact download failed (${response.status})`);
  const declared=Number(response.headers.get("content-length")??0);if(declared>manifest.artifact.maxBytes)throw new Error("artifact exceeds manifest size bound");
  const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.length;if(total>manifest.artifact.maxBytes)throw new Error("artifact exceeds manifest size bound");chunks.push(chunk);}
  return Buffer.concat(chunks,total);
}

async function extractPinnedArtifact({archivePath,stagingPath,manifest,signal}){
  const listing=await command("/usr/bin/tar",["-tzf",archivePath],{timeoutMs:30000,signal});
  const names=listing.stdout.split(/\r?\n/).map(name=>name.replace(/^\.\//,"")).filter(Boolean);
  if(names.some(name=>!isSafeRelativePath(name)))throw new Error("artifact contains an unsafe path");
  const allowed=new Set(manifest.artifact.files);if(names.some(name=>!allowed.has(name)))throw new Error("artifact contains files outside the manifest allowlist");
  for(const expected of allowed)if(!names.includes(expected))throw new Error(`artifact is missing ${expected}`);
  fs.mkdirSync(stagingPath,{recursive:true,mode:0o700});
  await command("/usr/bin/tar",["-xzf",archivePath,"-C",stagingPath,...manifest.artifact.files],{timeoutMs:30000,signal});
}

async function defaultHealthCheck({binaryPath,manifest,signal,environment}){
  const result=await command(binaryPath,manifest.healthCheck.args,{timeoutMs:15000,signal,env:environment});
  if(!result.stdout.includes(manifest.healthCheck.expectedVersion)&&!result.stderr.includes(manifest.healthCheck.expectedVersion))throw new Error("installed driver version does not match the manifest");
  if(process.platform==="darwin"&&manifest.provenance?.publisherTeam){
    await command("/usr/bin/codesign",["--verify","--strict","--verbose=2",binaryPath],{timeoutMs:15000,signal});
    const identity=await command("/usr/bin/codesign",["-dv","--verbose=4",binaryPath],{timeoutMs:15000,signal});
    const detail=`${identity.stdout}\n${identity.stderr}`;if(!detail.includes(`TeamIdentifier=${manifest.provenance.publisherTeam}`))throw new Error("installed driver signing identity does not match the trusted manifest");
  }
  return {ok:true,summary:`Cua Driver ${manifest.version} signature and version verified`};
}

export class CapabilityInstaller{
  constructor({rootPath=config.capabilitiesDir,statePath=config.capabilityInstallerStatePath,clock=()=>new Date(),onProgress=()=>{},download=downloadPinnedArtifact,extract=extractPinnedArtifact,healthCheck=defaultHealthCheck,digest=buffer=>crypto.createHash("sha256").update(buffer).digest("hex"),registerMcp=null,registerNative=null,platform=process.platform,arch=process.arch,blockRealInstall=process.env.COMPANION_BLOCK_REAL_UPSTREAM==="1"}={}){
    this.rootPath=rootPath;this.statePath=statePath;this.clock=clock;this.onProgress=onProgress;this.download=download;this.extract=extract;this.healthCheck=healthCheck;this.digest=digest;this.registerMcp=registerMcp;this.registerNative=registerNative;this.platform=platform;this.arch=arch;this.blockRealInstall=blockRealInstall;this.operations=new Map();this.state=this.load();
  }
  load(){try{const parsed=JSON.parse(fs.readFileSync(this.statePath,"utf8"));return parsed?.version===1&&parsed.capabilities&&typeof parsed.capabilities==="object"?parsed:{version:1,capabilities:{}};}catch{return {version:1,capabilities:{}};}}
  persist(){atomicJson(this.statePath,this.state);}
  installPath(id){return path.join(this.rootPath,String(id));}
  runtimePath(id){return path.join(this.installPath(id),"runtime");}
  binaryPath(id){return path.join(this.runtimePath(id),"cua-driver");}
  driverEnvironment(){return {...process.env,HOME:path.join(this.rootPath,".runtime-home"),CUA_DRIVER_RS_TELEMETRY_ENABLED:"false",CUA_TELEMETRY_ENABLED:"false",CUA_DRIVER_TELEMETRY_HOME:path.join(this.rootPath,".telemetry-disabled")};}
  emit(id,stage,status,message){const event={capability:id,stage,status,message:String(message??"").slice(0,180),at:this.clock().toISOString()};try{this.onProgress(event);}catch{}return event;}
  status(id){
    const manifest=knownCapabilityManifest(id),record=this.state.capabilities[id]??null,operation=this.operations.get(id)??null;
    if(!manifest)return {id:String(id),known:false,installed:false,enabled:false,health:"unknown",operation};
    const exists=record?.installPath&&fs.existsSync(record.installPath)&&fs.existsSync(this.binaryPath(id));
    const installed=Boolean(record?.installed&&exists);
    return {id:manifest.id,name:manifest.displayName,known:true,installed,enabled:installed&&record.enabled!==false,configured:installed&&record.configured===true,health:installed?(record.health??"installed"):(record?.health==="error"?"error":"not_installed"),lastError:record?.lastError??null,lastTest:record?.lastTest??null,installTime:record?.installTime??null,installPath:installed?record.installPath:null,adapterVersion:record?.adapterVersion??null,version:manifest.version,source:manifest.source,sourceUrl:manifest.sourceUrl,upstreamCommit:manifest.upstreamCommit,license:manifest.license,permissions:manifest.permissions,macOSPermissions:manifest.macOSPermissions,provenance:record?.provenance??manifest.provenance,operation};
  }
  inspect(id){const manifest=knownCapabilityManifest(id);return manifest?{manifest,status:this.status(id)}:null;}
  async installManifest(manifest,{signal,provenance={trigger:"user",sessionId:null}}={}){
    validateCapabilityManifest(manifest);
    if(manifest.type==="preset"){if(knownCapabilityManifest(manifest.id)!==manifest)throw new Error("only Companion built-in preset objects may use preset installation");return this.install(manifest.id,{signal,provenance});}
    const adapter=manifest.type==="mcp"?this.registerMcp:this.registerNative;if(typeof adapter!=="function")throw Object.assign(new Error(`${manifest.type} installer adapter is not configured`),{code:"CAPABILITY_INSTALLER_ADAPTER_MISSING",statusCode:409});
    const outcome=await adapter(manifest,{signal});this.state.capabilities[manifest.id]={installed:true,configured:outcome?.configured!==false,enabled:true,health:outcome?.health??"installed",lastError:null,lastTest:this.clock().toISOString(),installTime:this.clock().toISOString(),installPath:outcome?.installPath??null,adapterVersion:String(outcome?.adapterVersion??"1"),descriptor:manifestDescriptor(manifest),provenance:{...manifest.provenance,trigger:provenance.trigger,sessionId:provenance.sessionId,manifestId:manifest.id,sourceUrl:manifest.sourceUrl,version:manifest.version}};this.persist();return this.state.capabilities[manifest.id];
  }
  async install(id,{signal,provenance={trigger:"user",sessionId:null}}={}){
    const manifest=validateCapabilityManifest(knownCapabilityManifest(id));
    if(this.operations.has(id))throw Object.assign(new Error("capability operation already in progress"),{code:"CAPABILITY_OPERATION_IN_PROGRESS",statusCode:409});
    if(this.status(id).installed)return this.status(id);
    if(this.blockRealInstall&&this.download===downloadPinnedArtifact)throw Object.assign(new Error("real capability installation is blocked in offline test mode"),{code:"REAL_INSTALL_BLOCKED",statusCode:409});
    if(this.platform!=="darwin"||!["arm64","x64"].includes(this.arch))throw Object.assign(new Error("computer.use preset currently supports macOS only"),{code:"CAPABILITY_INCOMPATIBLE",statusCode:409});
    const operation={id:`install_${crypto.randomBytes(8).toString("hex")}`,kind:"install",stage:"compatibility",status:"running",startedAt:this.clock().toISOString()};this.operations.set(id,operation);
    const ownedPath=this.installPath(id),parent=path.dirname(ownedPath);fs.mkdirSync(parent,{recursive:true,mode:0o700});
    const tempRoot=fs.mkdtempSync(path.join(parent,`.${id}-install-`)),archivePath=path.join(tempRoot,"artifact.tar.gz"),stagingPath=path.join(tempRoot,"runtime");
    try{
      this.emit(id,"compatibility","running","正在检查兼容性");
      operation.stage="download";this.emit(id,"download","running","正在安装 Computer Use");
      const artifact=await this.download(manifest,{signal});if(!Buffer.isBuffer(artifact))throw new Error("installer download adapter returned invalid data");
      fs.writeFileSync(archivePath,artifact,{mode:0o600});
      operation.stage="verify";this.emit(id,"verify","running","正在验证可信来源");
      const checksum=this.digest(artifact);if(checksum!==manifest.artifact.sha256)throw Object.assign(new Error("artifact checksum mismatch"),{code:"CAPABILITY_CHECKSUM_MISMATCH"});
      operation.stage="extract";await this.extract({archivePath,stagingPath,manifest,signal});
      if(!fs.existsSync(path.join(stagingPath,"cua-driver")))throw new Error("driver entrypoint missing after extraction");fs.chmodSync(path.join(stagingPath,"cua-driver"),0o700);
      operation.stage="health_check";this.emit(id,"health_check","running","正在测试 Computer Use");
      const health=await this.healthCheck({binaryPath:path.join(stagingPath,"cua-driver"),manifest,signal,environment:this.driverEnvironment()});if(health?.ok===false)throw new Error(health?.summary??"health check failed");
      fs.rmSync(archivePath,{force:true});if(fs.existsSync(ownedPath))throw new Error("managed install path unexpectedly exists");fs.renameSync(tempRoot,ownedPath);
      const installedRuntime=path.join(ownedPath,"runtime");
      this.state.capabilities[id]={installed:true,configured:true,enabled:true,health:"installed",lastError:null,lastTest:this.clock().toISOString(),installTime:this.clock().toISOString(),installPath:ownedPath,adapterVersion:"1",runtimePath:installedRuntime,descriptor:manifestDescriptor(manifest),provenance:{...manifest.provenance,trigger:String(provenance.trigger??"user").slice(0,40),sessionId:provenance.sessionId?String(provenance.sessionId).slice(0,240):null,manifestId:manifest.id,sourceUrl:manifest.sourceUrl,upstreamCommit:manifest.upstreamCommit,version:manifest.version}};this.persist();
      operation.status="completed";operation.stage="ready";operation.completedAt=this.clock().toISOString();this.emit(id,"ready","completed","Computer Use 已安装，等待 macOS 权限检查");return this.status(id);
    }catch(error){operation.status="failed";operation.error=cleanError(error);operation.completedAt=this.clock().toISOString();this.state.capabilities[id]={...(this.state.capabilities[id]??{}),installed:false,enabled:false,configured:false,health:"error",lastError:operation.error,lastTest:this.clock().toISOString()};this.persist();this.emit(id,operation.stage,"failed",operation.error);throw error;}
    finally{this.operations.delete(id);if(fs.existsSync(tempRoot))fs.rmSync(tempRoot,{recursive:true,force:true});}
  }
  async test(id,{signal}={}){const manifest=knownCapabilityManifest(id),status=this.status(id);if(!manifest||!status.installed)throw Object.assign(new Error("capability is not installed"),{statusCode:409});try{const result=await this.healthCheck({binaryPath:this.binaryPath(id),manifest,signal,environment:this.driverEnvironment()});const record=this.state.capabilities[id];record.health=result?.ok===false?"error":"installed";record.lastError=result?.ok===false?cleanError(result?.summary):null;record.lastTest=this.clock().toISOString();record.descriptor=manifestDescriptor(manifest);this.persist();return this.status(id);}catch(error){const record=this.state.capabilities[id];record.health="error";record.lastError=cleanError(error);record.lastTest=this.clock().toISOString();this.persist();throw error;}}
  enable(id,enabled=true){const record=this.state.capabilities[id];if(!record?.installed)throw Object.assign(new Error("capability is not installed"),{statusCode:409});record.enabled=Boolean(enabled);record.health=enabled?(record.health==="disabled"?"installed":record.health):"disabled";this.persist();return this.status(id);}
  disable(id){return this.enable(id,false);}
  uninstall(id){const record=this.state.capabilities[id];if(!record?.installed)return false;const expected=this.installPath(id);if(path.resolve(record.installPath)!==path.resolve(expected))throw new Error("refusing to remove a non-owned install path");if(fs.existsSync(expected))fs.rmSync(expected,{recursive:true,force:true});delete this.state.capabilities[id];this.persist();this.emit(id,"uninstall","completed","Computer Use 已卸载");return true;}
}

export const capabilityInstaller=new CapabilityInstaller();
