import fs from "node:fs";
import path from "node:path";
import { spawn,spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { config } from "./config.js";
import { invocationLedger } from "./usage-ledger.js";
import { profileReference } from "./voice-profiles.js";
import { sanitizeTtsWav } from "./voice-audio-clean.js";

const STATES=new Set(["stopped","starting","ready","synthesizing","error","stopping"]);
const safeError=error=>String(error?.message??error??"unknown error").replace(/\/[A-Za-z0-9_.\-\u0080-\uFFFF/ ]+/g,"[local path]").slice(0,300);
const atomicJson=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function projectSpeechText(value,{maxChars=2000}={}){
  return String(value??"")
    .replace(/```[\s\S]*?```/g," ").replace(/`[^`]*`/g," ")
    .replace(/https?:\/\/\S+/gi," ").replace(/!\[[^\]]*\]\([^)]*\)/g," ")
    .replace(/\[[^\]]+\]\([^)]*\)/g,match=>match.replace(/^\[|\]\([\s\S]*$/g,""))
    .replace(/<[^>]+>/g," ").replace(/^\s{0,3}#{1,6}\s+/gm,"")
    .replace(/^\s{0,3}[-*+]\s+/gm,"").replace(/[\u0000-\u001f\u007f]/g," ")
    .replace(/\s+/g," ").trim().slice(0,maxChars);
}

export function projectTtsText(value,{style="daily",maxChars=2000}={}){
  const text=projectSpeechText(value,{maxChars});
  if(style!=="intimate"||!text)return text;
  let out=text.replace(/[…⋯]+|\.{3,}/g,"，").replace(/[,，]{2,}/g,"，").replace(/(?:^[\s,，]+)|(?:[,，]+$)/g,"").replace(/\s+/g," ").trim();
  if(!out)out=text.replace(/[…⋯]+|\.{3,}/g,"").replace(/\s+/g," ").trim();
  if(out&&!/[。！？.!?]$/u.test(out))out+="。";
  return out;
}

export function ttsRequestBody({text,speed=1,reference,style="daily"}){
  const body={text,text_lang:"zh",ref_audio_path:reference.ref_audio_path,prompt_text:reference.prompt_text,prompt_lang:"zh",media_type:"wav",streaming_mode:false,speed_factor:Math.max(.6,Math.min(1.5,Number(speed)||1))};
  if(style==="intimate")Object.assign(body,{text_split_method:"cut0",fragment_interval:0,parallel_infer:false,split_bucket:false,top_k:20,top_p:.7,temperature:.7});
  return body;
}

export function sentenceSegments(value,{maxChars=180}={}){
  const text=projectSpeechText(value);if(!text)return [];
  const pieces=text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g)??[text],out=[];
  for(const raw of pieces){let part=raw.trim();while(part.length>maxChars){let cut=Math.max(part.lastIndexOf("，",maxChars),part.lastIndexOf(",",maxChars),part.lastIndexOf(" ",maxChars));if(cut<40)cut=maxChars;out.push(part.slice(0,cut+1).trim());part=part.slice(cut+1).trim();}if(part)out.push(part);}
  return out.slice(0,32);
}

export class LocalGPTSoVITSService{
  constructor(options={}){
    this.cfg={...config,...options.config};this.fetch=options.fetch??globalThis.fetch;this.spawn=options.spawn??spawn;this.portOwner=options.portOwner??this.defaultPortOwner.bind(this);this.clock=options.clock??(()=>new Date());this.sleep=options.sleep??delay;
    this.root=this.cfg.voiceDir;this.cacheDir=path.join(this.root,"cache");this.runtimeDir=path.join(this.root,"runtime");this.settingsPath=path.join(this.root,"settings.json");this.metricsPath=path.join(this.root,"metrics.json");this.statePath=path.join(this.runtimeDir,"state.json");this.yamlPath=path.join(this.runtimeDir,"yuxiao-v2.yaml");
    this.child=null;this.managedPid=null;this.idleTimer=null;this.inCall=false;this.state="stopped";this.lastError=null;this.startedAt=null;this.active=new Map();this.settings=this.loadSettings();this.metrics=this.loadMetrics();
  }
  loadSettings(){try{const v=JSON.parse(fs.readFileSync(this.settingsPath,"utf8"));return {enabled:v.enabled!==false,mode:["manual","emotion","auto"].includes(v.mode)?v.mode:"manual",voice:"yuxiao",speed:Math.max(.6,Math.min(1.5,Number(v.speed)||1))};}catch{return {enabled:true,mode:"manual",voice:"yuxiao",speed:1};}}
  loadMetrics(){try{const v=JSON.parse(fs.readFileSync(this.metricsPath,"utf8"));return v?.version===1?v:{version:1,requests:0,successes:0,failures:0,characters:0,audio_bytes:0,duration_ms:0,cost_usd:0,input_tokens:0,output_tokens:0};}catch{return {version:1,requests:0,successes:0,failures:0,characters:0,audio_bytes:0,duration_ms:0,cost_usd:0,input_tokens:0,output_tokens:0};}}
  setState(state,error=null){if(!STATES.has(state))throw new Error("invalid voice state");this.state=state;this.lastError=error?safeError(error):null;this.persistState();}
  persistState(){atomicJson(this.statePath,{version:1,state:this.state,pid:this.child?.pid??this.managedPid??null,managed:Boolean(this.child||this.managedPid),started_at:this.startedAt,last_error:this.lastError,updated_at:this.clock().toISOString()});}
  persistSettings(){atomicJson(this.settingsPath,{version:1,...this.settings});}
  updateSettings(input={}){this.settings={...this.settings,...(typeof input.enabled==="boolean"?{enabled:input.enabled}:{}),...(["manual","emotion","auto"].includes(input.mode)?{mode:input.mode}:{}),...(Number.isFinite(Number(input.speed))?{speed:Math.max(.6,Math.min(1.5,Number(input.speed)))}:{})};this.persistSettings();return this.publicStatus();}
  isConfigured(){return [this.cfg.voiceRuntimeRoot,this.cfg.voicePythonPath,this.cfg.voiceApiScriptPath,this.cfg.voiceGptWeightsPath,this.cfg.voiceSoVitsWeightsPath,this.cfg.voiceReferenceAudioPath].every(file=>fs.existsSync(file));}
  publicStatus(){return {id:"voice.tts",provider:"GPT-SoVITS Local",voice:"yuxiao",backend:"PyTorch",device:"CPU",precision:"float32",state:this.state,ready:this.state==="ready"||this.state==="synthesizing",configured:this.isConfigured(),enabled:this.settings.enabled,mode:this.settings.mode,speed:this.settings.speed,endpoint:"127.0.0.1:9880",managed_process:Boolean(this.child||this.managedPid),last_error:this.lastError,metrics:{...this.metrics}};}
  validateFiles(){for(const [label,file] of Object.entries({runtime:this.cfg.voiceRuntimeRoot,python:this.cfg.voicePythonPath,api:this.cfg.voiceApiScriptPath,gpt:this.cfg.voiceGptWeightsPath,sovits:this.cfg.voiceSoVitsWeightsPath,reference:this.cfg.voiceReferenceAudioPath}))if(!fs.existsSync(file))throw Object.assign(new Error(`local voice ${label} is missing`),{code:"VOICE_RUNTIME_MISSING"});}
  writeConfig(){fs.mkdirSync(this.runtimeDir,{recursive:true});const pretrained=path.join(this.cfg.voiceRuntimeRoot,"GPT_SoVITS","pretrained_models");const yaml=`custom:\n  bert_base_path: ${JSON.stringify(path.join(pretrained,"chinese-roberta-wwm-ext-large"))}\n  cnhuhbert_base_path: ${JSON.stringify(path.join(pretrained,"chinese-hubert-base"))}\n  device: cpu\n  is_half: false\n  t2s_weights_path: ${JSON.stringify(this.cfg.voiceGptWeightsPath)}\n  vits_weights_path: ${JSON.stringify(this.cfg.voiceSoVitsWeightsPath)}\n  version: v2\n`;fs.writeFileSync(this.yamlPath,yaml,{mode:0o600});}
  defaultPortOwner(){const r=spawnSync("lsof",["-nP","-iTCP:9880","-sTCP:LISTEN","-t"],{encoding:"utf8"});return r.status===0?r.stdout.trim():"";}
  reusableManagedPid(owner){try{const saved=JSON.parse(fs.readFileSync(this.statePath,"utf8")),pid=Number(owner);if(!saved?.managed||Number(saved.pid)!==pid||!Number.isInteger(pid)||pid<2)return null;const r=spawnSync("ps",["-p",String(pid),"-o","command="],{encoding:"utf8"}),command=r.status===0?r.stdout:"";return command.includes(this.cfg.voiceApiScriptPath)&&command.includes(this.yamlPath)?pid:null;}catch{return null;}}
  async probe(){try{const response=await this.fetch(`http://${this.cfg.voiceHost}:${this.cfg.voicePort}/openapi.json`,{signal:AbortSignal.timeout(1500)});if(!response.ok)return false;const body=await response.json();return Boolean(body?.paths?.["/tts"]);}catch{return false;}}
  async ensureReady(){
    if(!this.settings.enabled)throw Object.assign(new Error("local voice is disabled"),{code:"VOICE_DISABLED"});
    if(await this.probe()){if(this.child){this.setState("ready");return this.publicStatus();}const owner=String(await this.portOwner()),pid=this.reusableManagedPid(owner);if(pid){this.managedPid=pid;this.setState("ready");return this.publicStatus();}throw Object.assign(new Error("port 9880 is owned by an unmanaged process; refusing reuse"),{code:"VOICE_PORT_CONFLICT"});}
    const owner=String(await this.portOwner());if(owner)throw Object.assign(new Error("port 9880 is already in use; refusing to replace its owner"),{code:"VOICE_PORT_CONFLICT"});
    if(this.child&&this.state==="starting")return this.waitReady();
    this.validateFiles();this.writeConfig();this.setState("starting");this.startedAt=this.clock().toISOString();
    const log=fs.openSync(path.join(this.runtimeDir,"api.log"),"a",0o600);
    this.child=this.spawn(this.cfg.voicePythonPath,[this.cfg.voiceApiScriptPath,"-a",this.cfg.voiceHost,"-p",String(this.cfg.voicePort),"-c",this.yamlPath],{cwd:this.cfg.voiceRuntimeRoot,env:{...process.env,PYTHONUNBUFFERED:"1",NLTK_DATA:path.join(this.cfg.voiceRuntimeRoot,"nltk_data"),NO_PROXY:"127.0.0.1,localhost",no_proxy:"127.0.0.1,localhost"},stdio:["ignore",log,log],detached:true});
    fs.closeSync(log);this.managedPid=this.child.pid;this.child.once("exit",()=>{this.child=null;this.managedPid=null;if(!["stopping","stopped"].includes(this.state))this.setState("error",new Error("local voice process exited"));});this.child.unref();this.persistState();return this.waitReady();
  }
  async waitReady(){const deadline=Date.now()+this.cfg.voiceStartupTimeoutMs;while(Date.now()<deadline){if(!this.child)throw Object.assign(new Error("local voice process exited during startup"),{code:"VOICE_START_FAILED"});if(await this.probe()){this.setState("ready");return this.publicStatus();}await this.sleep(500);}await this.stop();throw Object.assign(new Error("local voice readiness timed out"),{code:"VOICE_START_TIMEOUT"});}
  voiceStyleReference(style="neutral"){
    const normalized=["neutral","happy","low_energy","annoyed","angry","intimate","daily"].includes(style)?style:"neutral";
    const profileId=normalized==="intimate"||normalized==="daily"?(normalized==="daily"?"neutral":"happy"):normalized;
    return profileReference(profileId);
  }
  async synthesize({text,voice="yuxiao",speed=1,sessionId="",signal=null,style="daily"}={}){
    const clean=projectTtsText(text,{style});if(!clean)throw Object.assign(new Error("no speakable text"),{code:"VOICE_EMPTY_TEXT"});if(voice!=="yuxiao")throw Object.assign(new Error("unknown local voice"),{code:"VOICE_UNKNOWN_PROFILE"});
    const reference=this.voiceStyleReference(style);
    const started=Date.now(),id=`tts_${crypto.randomBytes(12).toString("hex")}`,controller=new AbortController();this.active.set(id,controller);let success=false;
    try{await this.ensureReady();this.setState("synthesizing");const signals=[controller.signal,AbortSignal.timeout(this.cfg.voiceRequestTimeoutMs),...(signal?[signal]:[])];const response=await this.fetch(`http://${this.cfg.voiceHost}:${this.cfg.voicePort}/tts`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(ttsRequestBody({text:clean,speed,reference,style:reference.style})),signal:AbortSignal.any(signals)});if(!response.ok)throw new Error(`local voice returned HTTP ${response.status}`);const rawBytes=Buffer.from(await response.arrayBuffer());if(rawBytes.length<44||rawBytes.subarray(0,4).toString()!=="RIFF"||rawBytes.subarray(8,12).toString()!=="WAVE")throw new Error("local voice returned invalid WAV audio");
      let bytes=rawBytes;
      try{bytes=sanitizeTtsWav(rawBytes);}catch{}
      if(bytes.length<2000)bytes=rawBytes;
      fs.mkdirSync(this.cacheDir,{recursive:true});const file=path.join(this.cacheDir,`${id}.wav`);fs.writeFileSync(file,bytes,{mode:0o600});this.pruneCache();success=true;this.recordMetric({success:true,chars:clean.length,bytes:bytes.length,duration:Date.now()-started,sessionId});return {id,text:clean,style:reference.style,bytes:bytes.length,duration_ms:Date.now()-started,content_type:"audio/wav"};
    }catch(error){this.recordMetric({success:false,chars:clean.length,bytes:0,duration:Date.now()-started,sessionId});if(error?.name==="AbortError")throw Object.assign(new Error("voice synthesis cancelled"),{name:"AbortError",code:"VOICE_CANCELLED"});this.setState("error",error);throw error;}finally{this.active.delete(id);if((this.child||this.managedPid)&&this.state!=="error")this.setState("ready");this.scheduleIdleStop();invocationLedger.append({provider:"local",model:"gpt-sovits-yuxiao-v2",publicModel:"voice.tts",feature:"local_tts",source:"native",sessionId,inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningTokens:0,usageSource:"non_model",durationMs:Date.now()-started,success});}
  }
  recordMetric({success,chars,bytes,duration}){this.metrics={...this.metrics,requests:this.metrics.requests+1,successes:this.metrics.successes+(success?1:0),failures:this.metrics.failures+(success?0:1),characters:this.metrics.characters+chars,audio_bytes:this.metrics.audio_bytes+bytes,duration_ms:this.metrics.duration_ms+duration,cost_usd:0,input_tokens:0,output_tokens:0};atomicJson(this.metricsPath,this.metrics);}
  audioPath(id){if(!/^tts_[a-f0-9]{24}$/.test(String(id)))return null;const file=path.join(this.cacheDir,`${id}.wav`);return fs.existsSync(file)?file:null;}
  cancel(id=null){if(id){this.active.get(id)?.abort();return;}for(const controller of this.active.values())controller.abort();}
  scheduleIdleStop(){if(this.idleTimer)clearTimeout(this.idleTimer);if(this.inCall)return;if(this.cfg.voiceIdleStopMs>0)this.idleTimer=setTimeout(()=>{if(this.active.size===0&&!this.inCall)this.stop().catch(()=>{});},this.cfg.voiceIdleStopMs);this.idleTimer?.unref?.();}
  enterCall(){this.inCall=true;if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=null;}
  leaveCall(){this.inCall=false;this.scheduleIdleStop();}
  async stop(){this.cancel();if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=null;const pid=this.child?.pid??this.managedPid;if(!pid){this.setState("stopped");return;}this.setState("stopping");try{process.kill(-pid,"SIGTERM");}catch{try{process.kill(pid,"SIGTERM");}catch{}}for(let i=0;i<20;i++){try{process.kill(pid,0);await this.sleep(100);}catch{break;}}try{process.kill(-pid,"SIGKILL");}catch{}this.child=null;this.managedPid=null;this.setState("stopped");}
  pruneCache(){try{const now=Date.now(),files=fs.readdirSync(this.cacheDir).filter(x=>x.endsWith(".wav")).map(name=>{const file=path.join(this.cacheDir,name),stat=fs.statSync(file);return {file,size:stat.size,mtime:stat.mtimeMs};}).sort((a,b)=>b.mtime-a.mtime);let total=0;for(const item of files){total+=item.size;if(now-item.mtime>this.cfg.voiceCacheMaxAgeMs||total>this.cfg.voiceCacheMaxBytes)fs.unlinkSync(item.file);}}catch{}}
}

export const localGPTSoVITSService=new LocalGPTSoVITSService();
