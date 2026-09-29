import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { invocationLedger } from "./usage-ledger.js";

const MAX_TURNS = 80;
const NUMBER_KEYS = [
  "endpoint_ms","stt_ms","agent_ttft_ms","agent_final_ms","tts_first_audio_ms",
  "speech_end_to_first_audio_ms","barge_in_stop_ms","vad_false_starts",
  "self_triggers_prevented","device_changes","mute_duration_seconds","speech_seconds"
];
const FORBIDDEN = ["audio","audio_base64","transcript","raw_transcript","normalized_transcript","emotion","prosody","wav","samples","secret","token"];

function numberOrNull(value){
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(tmp,file);
  try{fs.chmodSync(file,0o600);}catch{}
}

export function sanitizeVoiceTurnMetrics(input={}){
  const raw = input && typeof input === "object" ? input : {};
  for(const key of Object.keys(raw)){
    if(FORBIDDEN.some(item=>key.toLowerCase().includes(item)))continue;
  }
  return {
    call_session_id: String(raw.call_session_id??"").slice(0,80),
    turn_id: String(raw.turn_id??"").slice(0,80),
    endpoint_ms: numberOrNull(raw.endpoint_ms),
    stt_ms: numberOrNull(raw.stt_ms),
    agent_ttft_ms: numberOrNull(raw.agent_ttft_ms),
    agent_final_ms: numberOrNull(raw.agent_final_ms),
    tts_first_audio_ms: numberOrNull(raw.tts_first_audio_ms),
    speech_end_to_first_audio_ms: numberOrNull(raw.speech_end_to_first_audio_ms),
    barge_in_stop_ms: numberOrNull(raw.barge_in_stop_ms),
    vad_false_starts: Math.max(0,Math.round(Number(raw.vad_false_starts)||0)),
    self_triggers_prevented: Math.max(0,Math.round(Number(raw.self_triggers_prevented)||0)),
    device_changes: Math.max(0,Math.round(Number(raw.device_changes)||0))
  };
}

export class VoiceCallDiagnosticsStore{
  constructor(options={}){
    this.file = options.file ?? path.join(options.voiceDir ?? config.voiceDir,"call-diagnostics.json");
    this.now = options.now ?? (()=>new Date());
    this.state = this.load();
  }
  empty(){
    return {
      version:1,calls:0,call_duration_seconds:0,utterances:0,barge_ins:0,cancellations:0,
      mute_duration_seconds:0,speech_seconds:0,vad_false_starts:0,self_triggers_prevented:0,
      device_changes:0,turns:[],updated_at:null
    };
  }
  load(){
    try{
      const parsed = JSON.parse(fs.readFileSync(this.file,"utf8"));
      if(parsed?.version===1)return {...this.empty(),...parsed,turns:Array.isArray(parsed.turns)?parsed.turns:[]};
    }catch{}
    return this.empty();
  }
  persist(){this.state.updated_at=this.now().toISOString();atomic(this.file,this.state);return this.snapshot();}
  snapshot(){
    const turns=this.state.turns??[];
    const values=key=>turns.map(turn=>turn[key]).filter(value=>Number.isFinite(value));
    const percentile=(list,fraction)=>{
      if(!list.length)return null;
      const sorted=[...list].sort((a,b)=>a-b);
      const index=Math.min(sorted.length-1,Math.max(0,Math.round((sorted.length-1)*fraction)));
      return sorted[index];
    };
    return {
      version:1,
      calls:this.state.calls,
      call_duration_seconds:this.state.call_duration_seconds,
      utterances:this.state.utterances,
      barge_ins:this.state.barge_ins,
      cancellations:this.state.cancellations,
      mute_duration_seconds:this.state.mute_duration_seconds,
      speech_seconds:this.state.speech_seconds,
      vad_false_starts:this.state.vad_false_starts,
      self_triggers_prevented:this.state.self_triggers_prevented,
      device_changes:this.state.device_changes,
      barge_in_stop_p50:percentile(values("barge_in_stop_ms"),0.5),
      barge_in_stop_p90:percentile(values("barge_in_stop_ms"),0.9),
      turn_count:turns.length,
      recent_turns:turns.slice(-20),
      updated_at:this.state.updated_at
    };
  }
  recordTurn(input={}){
    const turn=sanitizeVoiceTurnMetrics(input);
    this.state.turns=[...this.state.turns,turn].slice(-MAX_TURNS);
    this.state.vad_false_starts+=turn.vad_false_starts;
    this.state.self_triggers_prevented+=turn.self_triggers_prevented;
    this.state.device_changes+=turn.device_changes;
    return this.persist();
  }
  recordCall(input={}){
    const duration=Math.max(0,Number(input.duration_seconds)||0);
    const mute=Math.max(0,Number(input.mute_duration_seconds)||0);
    const speech=Math.max(0,Number(input.speech_seconds)||0);
    this.state.calls++;
    this.state.call_duration_seconds+=duration;
    this.state.utterances+=Math.max(0,Number(input.utterances)||0);
    this.state.barge_ins+=Math.max(0,Number(input.barge_ins)||0);
    this.state.cancellations+=Math.max(0,Number(input.cancellations)||0);
    this.state.mute_duration_seconds+=mute;
    this.state.speech_seconds+=speech;
    this.state.vad_false_starts+=Math.max(0,Number(input.vad_false_starts)||0);
    this.state.self_triggers_prevented+=Math.max(0,Number(input.self_triggers_prevented)||0);
    this.state.device_changes+=Math.max(0,Number(input.device_changes)||0);
    invocationLedger.append({
      provider:"local",model:"voice-call",publicModel:"yuna-chat",feature:"local_voice_call",
      source:"native",sessionId:String(input.call_session_id??"").slice(0,80),
      inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningTokens:0,
      usageSource:"non_model",durationMs:Math.round(duration*1000),success:true
    });
    return this.persist();
  }
}

export const voiceCallDiagnostics=new VoiceCallDiagnosticsStore();
export const VOICE_CALL_METRIC_KEYS=NUMBER_KEYS;
