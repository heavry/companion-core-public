import fs from "node:fs";
import readline from "node:readline";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { invocationLedger } from "./usage-ledger.js";
import { buildSpeechContext } from "./speech-context.js";

const cleanError=value=>String(value?.message??value??"unknown error").replace(/\/[A-Za-z0-9_.\-\u0080-\uFFFF/ ]+/g,"[local path]").slice(0,240);

export class LocalSenseVoiceService{
  constructor(options={}){
    this.cfg={...config,...options.config};this.spawn=options.spawn??spawn;this.child=null;this.reader=null;
    this.state="stopped";this.lastError=null;this.startedAt=null;this.pending=new Map();this.readyPromise=null;this.idleTimer=null;this.inCall=false;
    this.metricsPath=`${this.cfg.voiceDir}/sensevoice-metrics.json`;this.metrics=this.loadMetrics();
  }
  emptyMetrics(){return {version:1,requests:0,successes:0,failures:0,audio_seconds:0,inference_ms:0,realtime_factor_sum:0,calls:0,call_duration_seconds:0,utterances:0,barge_ins:0,cancellations:0,mute_duration_seconds:0,speech_seconds:0,device_changes:0,emotion_counts:{},cost_usd:0,input_tokens:0,output_tokens:0};}
  loadMetrics(){try{return {...this.emptyMetrics(),...JSON.parse(fs.readFileSync(this.metricsPath,"utf8"))};}catch{return this.emptyMetrics();}}
  persistMetrics(){fs.mkdirSync(this.cfg.voiceDir,{recursive:true});const temp=`${this.metricsPath}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(this.metrics,null,2),{mode:0o600});fs.renameSync(temp,this.metricsPath);}
  configured(){return fs.existsSync(this.cfg.senseVoicePythonPath)&&fs.existsSync(this.cfg.senseVoiceModelPath)&&fs.existsSync(this.cfg.senseVoiceWorkerPath);}
  publicStatus(){return {id:"voice.stt",provider:"SenseVoice Local",backend:"CPU",precision:"float32",state:this.state,ready:this.state==="ready"||this.state==="transcribing",configured:this.configured(),managed_process:Boolean(this.child),streaming:false,last_error:this.lastError,metrics:{...this.metrics}};}
  async ensureReady(){
    if(this.child&&["ready","transcribing"].includes(this.state))return this.publicStatus();
    if(this.readyPromise)return this.readyPromise;
    if(!this.configured())throw Object.assign(new Error("local SenseVoice runtime is missing"),{code:"STT_RUNTIME_MISSING"});
    this.state="starting";this.lastError=null;this.startedAt=new Date().toISOString();
    this.readyPromise=new Promise((resolve,reject)=>{
      const child=this.spawn(this.cfg.senseVoicePythonPath,["-u",this.cfg.senseVoiceWorkerPath],{cwd:this.cfg.senseVoiceLabRoot,env:{...process.env,COMPANION_SENSEVOICE_MODEL:this.cfg.senseVoiceModelPath,PYTHONUNBUFFERED:"1",HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1"},stdio:["pipe","pipe","pipe"]});
      this.child=child;let settled=false;const timeout=setTimeout(()=>finish(new Error("SenseVoice startup timed out")),this.cfg.senseVoiceStartupTimeoutMs);timeout.unref?.();
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timeout);if(error){this.lastError=cleanError(error);this.state="error";reject(error);}else{this.state="ready";resolve(this.publicStatus());}};
      this.reader=readline.createInterface({input:child.stdout});this.reader.on("line",line=>{let event;try{event=JSON.parse(line);}catch{return;}if(event.type==="ready")return finish();this.handleEvent(event);});
      child.stderr?.on("data",()=>{});child.once("error",finish);child.once("exit",()=>{const error=new Error("SenseVoice worker exited");for(const item of this.pending.values())item.reject(error);this.pending.clear();this.child=null;this.reader=null;if(!["stopping","stopped"].includes(this.state)){this.state="error";this.lastError=cleanError(error);}finish(error);});
    }).finally(()=>{this.readyPromise=null;});
    return this.readyPromise;
  }
  handleEvent(event){const item=this.pending.get(String(event.id??""));if(!item)return;this.pending.delete(String(event.id));clearTimeout(item.timeout);event.type==="result"?item.resolve(event):item.reject(Object.assign(new Error(event.message??"SenseVoice inference failed"),{code:"STT_INFERENCE_FAILED"}));}
  async transcribe({audioBase64,sessionId="",signal=null}={}){
    const audio=Buffer.from(String(audioBase64??""),"base64");if(audio.length<44||audio.subarray(0,4).toString()!=="RIFF"||audio.subarray(8,12).toString()!=="WAVE")throw Object.assign(new Error("valid WAV audio is required"),{code:"STT_INVALID_AUDIO"});
    if(audio.length>this.cfg.senseVoiceMaxAudioBytes)throw Object.assign(new Error("voice utterance is too large"),{code:"STT_AUDIO_TOO_LARGE"});
    await this.ensureReady();this.state="transcribing";const id=`stt_${crypto.randomBytes(12).toString("hex")}`,started=Date.now();let success=false;
    try{
      const result=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(new Error("SenseVoice request timed out"),{code:"STT_TIMEOUT"}));},this.cfg.senseVoiceRequestTimeoutMs);timeout.unref?.();this.pending.set(id,{resolve,reject,timeout});this.child.stdin.write(`${JSON.stringify({id,audio_base64:audio.toString("base64")})}\n`);if(signal)signal.addEventListener("abort",()=>{const item=this.pending.get(id);if(item){clearTimeout(item.timeout);this.pending.delete(id);item.reject(Object.assign(new Error("transcription cancelled"),{name:"AbortError",code:"STT_CANCELLED"}));}},{once:true});});
      success=true;this.metrics.requests++;this.metrics.successes++;this.metrics.audio_seconds+=Number(result.audio_duration_seconds)||0;this.metrics.inference_ms+=Number(result.inference_ms)||0;this.metrics.realtime_factor_sum+=Number(result.realtime_factor)||0;if(result.emotion)this.metrics.emotion_counts[result.emotion]=(this.metrics.emotion_counts[result.emotion]??0)+1;this.persistMetrics();
      return {...result,speech_context:buildSpeechContext(result)};
    }catch(error){this.metrics.requests++;this.metrics.failures++;this.lastError=cleanError(error);this.persistMetrics();throw error;}
    finally{this.state=this.child?"ready":"stopped";this.scheduleIdleStop();invocationLedger.append({provider:"local",model:"sensevoice-small",publicModel:"voice.stt",feature:"local_stt",source:"native",sessionId,inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningTokens:0,usageSource:"non_model",durationMs:Date.now()-started,success});}
  }
  scheduleIdleStop(){if(this.idleTimer)clearTimeout(this.idleTimer);if(this.inCall)return;if(this.cfg.senseVoiceIdleStopMs>0)this.idleTimer=setTimeout(()=>{if(this.pending.size===0&&!this.inCall)this.stop();},this.cfg.senseVoiceIdleStopMs);this.idleTimer?.unref?.();}
  enterCall(){this.inCall=true;if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=null;}
  leaveCall(){this.inCall=false;this.stop();}
  recordCall(value={}){this.metrics.calls++;this.metrics.call_duration_seconds+=Math.max(0,Number(value.duration_seconds)||0);this.metrics.utterances+=Math.max(0,Number(value.utterances)||0);this.metrics.barge_ins+=Math.max(0,Number(value.barge_ins)||0);this.metrics.cancellations+=Math.max(0,Number(value.cancellations)||0);this.metrics.mute_duration_seconds+=Math.max(0,Number(value.mute_duration_seconds)||0);this.metrics.speech_seconds+=Math.max(0,Number(value.speech_seconds)||0);this.metrics.device_changes+=Math.max(0,Number(value.device_changes)||0);this.persistMetrics();}
  stop(){if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=null;this.state="stopping";for(const item of this.pending.values()){clearTimeout(item.timeout);item.reject(new Error("SenseVoice stopped"));}this.pending.clear();try{this.child?.kill("SIGTERM");}catch{}this.reader?.close();this.child=null;this.reader=null;this.state="stopped";}
}

export const localSenseVoiceService=new LocalSenseVoiceService();
