import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";

process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
for(const key of ["UPSTREAM_PRIMARY_BASE_URL","UPSTREAM_SECONDARY_BASE_URL","UPSTREAM_API_KEY","TAVILY_API_KEY","TAVILY_BASE_URL","SEARXNG_BASE_URL"])process.env[key]="";
for(const key of ["UPSTREAM_CHAT_BASE_URL","UPSTREAM_AGENT_BASE_URL","UPSTREAM_SUMMARY_BASE_URL"])process.env[key]="http://127.0.0.1:9/v1";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-stt-test-")),python=path.join(root,"python"),model=path.join(root,"model"),worker=path.join(root,"worker.py");
fs.writeFileSync(python,"fixture");fs.mkdirSync(model);fs.writeFileSync(worker,"fixture");process.env.DATABASE_PATH=path.join(root,"db.sqlite");
const {LocalSenseVoiceService}=await import("../src/local-sensevoice-service.js");
const {normalizeSpokenTranscript,buildSpeechContext}=await import("../src/speech-context.js");
assert.equal(normalizeSpokenTranscript("git hub 和 sense voice"),"GitHub 和 SenseVoice");
assert.equal(buildSpeechContext({transcript:"测试",emotion:"happy"}).uncertain,true);

let child;const fakeSpawn=(_exe,args,options)=>{assert.deepEqual(args,["-u",worker]);assert.equal(options.env.COMPANION_SENSEVOICE_MODEL,model);child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>child.emit("exit",0);child.stdin.on("data",data=>{const request=JSON.parse(String(data));setImmediate(()=>child.stdout.write(`${JSON.stringify({type:"result",id:request.id,transcript:"打开 git hub",language:"zh",emotion:"neutral",audio_events:[],raw_tags:["zh","NEUTRAL"],prosody:{pause_ratio:.2},audio_duration_seconds:1,inference_ms:80,realtime_factor:.08})}\n`));});setImmediate(()=>child.stdout.write('{"type":"ready","backend":"CPU","precision":"float32"}\n'));return child;};
const service=new LocalSenseVoiceService({config:{senseVoicePythonPath:python,senseVoiceModelPath:model,senseVoiceWorkerPath:worker,senseVoiceLabRoot:root,senseVoiceStartupTimeoutMs:1000,senseVoiceRequestTimeoutMs:1000,senseVoiceIdleStopMs:0,senseVoiceMaxAudioBytes:1024*1024},spawn:fakeSpawn});
const wav=Buffer.concat([Buffer.from("RIFF"),Buffer.alloc(4),Buffer.from("WAVE"),Buffer.alloc(40)]);const result=await service.transcribe({audioBase64:wav.toString("base64"),sessionId:"fixture"});
assert.equal(result.transcript,"打开 git hub");assert.equal(result.speech_context.normalized_transcript,"打开 GitHub");assert.equal(service.publicStatus().state,"ready");assert.equal(service.publicStatus().metrics.cost_usd,0);assert.equal(service.publicStatus().metrics.audio_seconds,1);
service.recordCall({duration_seconds:12,utterances:2,barge_ins:1,cancellations:1,mute_duration_seconds:3,speech_seconds:4,device_changes:1});assert.equal(service.publicStatus().metrics.calls,1);assert.equal(service.publicStatus().metrics.call_duration_seconds,12);assert.equal(service.publicStatus().metrics.barge_ins,1);assert.equal(service.publicStatus().metrics.mute_duration_seconds,3);assert.equal(service.publicStatus().metrics.speech_seconds,4);assert.equal(service.publicStatus().metrics.device_changes,1);assert.equal(service.publicStatus().metrics.emotion_counts.neutral,1);
await assert.rejects(service.transcribe({audioBase64:Buffer.from("bad").toString("base64")}),error=>error.code==="STT_INVALID_AUDIO");service.enterCall();service.scheduleIdleStop();assert.equal(service.publicStatus().state,"ready");
service.leaveCall();assert.equal(service.publicStatus().state,"stopped");

const {VoiceCallDiagnosticsStore,sanitizeVoiceTurnMetrics}=await import("../src/voice-call-diagnostics.js");
const diagFile=path.join(root,"call-diagnostics.json");
const store=new VoiceCallDiagnosticsStore({file:diagFile});
store.recordTurn({
  call_session_id:"c1",turn_id:"t1",endpoint_ms:650,stt_ms:340,agent_ttft_ms:500,agent_final_ms:1000,
  tts_first_audio_ms:900,speech_end_to_first_audio_ms:2520,barge_in_stop_ms:40,
  transcript:"用户很难过",raw_transcript:"用户很难过",audio_base64:"AAAA",emotion:"SAD",prosody:{pause_ratio:1},wav:"RIFF"
});
const snap=store.snapshot();
assert.equal(snap.recent_turns[0].endpoint_ms,650);
assert.equal(snap.recent_turns[0].stt_ms,340);
assert.equal(snap.recent_turns[0].barge_in_stop_ms,40);
assert.equal(snap.barge_in_stop_p50,40);
assert.equal("transcript" in snap.recent_turns[0],false);
const saved=JSON.stringify(JSON.parse(fs.readFileSync(diagFile,"utf8")));
assert.equal(saved.includes("用户很难过"),false);
assert.equal(saved.includes("AAAA"),false);
assert.equal(saved.includes("SAD"),false);
store.recordTurn({call_session_id:"c1",turn_id:"t2",barge_in_stop_ms:80});
assert.equal(store.snapshot().barge_in_stop_p90,80);
store.recordCall({duration_seconds:12,utterances:2,barge_ins:1,mute_duration_seconds:3,speech_seconds:4,device_changes:1,call_session_id:"c1"});
assert.equal(store.snapshot().mute_duration_seconds,3);
assert.equal(store.snapshot().device_changes,1);
assert.equal(store.snapshot().calls,1);
const clean=sanitizeVoiceTurnMetrics({transcript:"secret",audio_base64:"AAAA",endpoint_ms:12});
assert.equal(clean.endpoint_ms,12);
assert.equal("transcript" in clean,false);
assert.equal("audio_base64" in clean,false);
console.log("voice call runtime tests passed");
