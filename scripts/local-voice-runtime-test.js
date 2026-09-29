import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
for(const key of ["UPSTREAM_PRIMARY_BASE_URL","UPSTREAM_SECONDARY_BASE_URL","UPSTREAM_SECONDARY_CHAT_BASE_URL","UPSTREAM_SECONDARY_AGENT_BASE_URL","UPSTREAM_SECONDARY_SUMMARY_BASE_URL","UPSTREAM_API_KEY","UPSTREAM_PRIMARY_API_KEY","UPSTREAM_SECONDARY_API_KEY","UPSTREAM_CHAT_API_KEY","UPSTREAM_AGENT_API_KEY","UPSTREAM_SUMMARY_API_KEY","TAVILY_API_KEY","TAVILY_BASE_URL","SEARXNG_BASE_URL"])process.env[key]="";
for(const key of ["UPSTREAM_CHAT_BASE_URL","UPSTREAM_AGENT_BASE_URL","UPSTREAM_SUMMARY_BASE_URL"])process.env[key]="http://127.0.0.1:9/v1";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-voice-test-")),runtime=path.join(root,"runtime"),voice=path.join(root,"voice");fs.mkdirSync(runtime,{recursive:true});
const files={python:path.join(runtime,"python"),api:path.join(runtime,"api_v2.py"),gpt:path.join(runtime,"voice.ckpt"),sovits:path.join(runtime,"voice.pth"),reference:path.join(runtime,"reference.wav"),intimate:path.join(runtime,"intimate.wav")};for(const file of Object.values(files))fs.writeFileSync(file,"fixture");
process.env.DATABASE_PATH=path.join(root,"companion.db");process.env.COMPANION_VOICE_DIR=voice;
const {LocalGPTSoVITSService,projectSpeechText,projectTtsText,sentenceSegments,ttsRequestBody}=await import("../src/local-gpt-sovits-service.js");

assert.equal(projectSpeechText("# 你好 `code` https://example.com\n```secret``` 世界"),"你好 世界");
assert.deepEqual(sentenceSegments("第一句。第二句！"),["第一句。","第二句！"]);
for(const text of ["啊","啊……","嗯","嗯……","呵","哈","哈……","唉","哦","欸","哼","嗯哼","哈哈","唉……","哦——","哈！"]){
  assert.equal(projectSpeechText(text),text,`speech projection preserves standalone vocalization: ${text}`);
  assert.deepEqual(sentenceSegments(text),[text],`sentence segmentation keeps standalone vocalization: ${text}`);
}
for(const text of ["嗯……我想想。","唉，算了。","哈，你又来了。","啊？真的吗？","好吧……嗯。","行，哈。"]){
  assert.equal(projectSpeechText(text),text,`speech projection preserves interjection in sentence: ${text}`);
  assert.ok(sentenceSegments(text).length>=1,`sentence segmentation keeps interjection sentence: ${text}`);
}
assert.equal(projectTtsText("嗯……哈啊……要去了……啊啊啊",{style:"intimate"}),"嗯，哈啊，要去了，啊啊啊。");
assert.equal(projectTtsText("啊……",{style:"intimate"}),"啊。");
assert.equal(projectTtsText("嗯……我想想。",{style:"daily"}),"嗯……我想想。");
const intimateBody=ttsRequestBody({text:"操死我。",speed:1,reference:{ref_audio_path:files.intimate,prompt_text:"叫床"},style:"intimate"});
assert.equal(intimateBody.text_split_method,"cut0");assert.equal(intimateBody.fragment_interval,0);assert.equal(intimateBody.parallel_infer,false);
const dailyBody=ttsRequestBody({text:"早上好。",speed:1,reference:{ref_audio_path:files.reference,prompt_text:"日常"},style:"daily"});
assert.equal(dailyBody.text_split_method,undefined);

let spawned=false,ready=false,synthCalls=0;const wav=Buffer.concat([Buffer.from("RIFF"),Buffer.alloc(4),Buffer.from("WAVE"),Buffer.alloc(40)]);
const fakeFetch=async(url,options={})=>{
  assert(String(url).startsWith("http://127.0.0.1:9880/"),"loopback-only transport");
  if(String(url).endsWith("openapi.json"))return new Response(JSON.stringify({paths:ready?{"/tts":{post:{}}}:{}}),{status:ready?200:503,headers:{"content-type":"application/json"}});
  synthCalls++;const body=JSON.parse(options.body);assert.equal(body.text_lang,"zh");assert.equal(body.streaming_mode,false);if(body.ref_audio_path===files.intimate){assert.equal(body.text,"操死我。");assert.equal(body.text_split_method,"cut0");assert.equal(body.fragment_interval,0);}else{assert.equal(body.text,"安全测试");assert.equal(body.text_split_method,undefined);}return new Response(wav,{status:200,headers:{"content-type":"audio/wav"}});
};
const fakeSpawn=(_exe,args,options)=>{spawned=true;assert.deepEqual(args.slice(0,5),[files.api,"-a","127.0.0.1","-p","9880"]);assert.equal(options.cwd,runtime);assert.equal(options.env.NLTK_DATA,path.join(runtime,"nltk_data"));const child=new EventEmitter();child.pid=424242;child.unref=()=>{};setTimeout(()=>{ready=true;},1);return child;};
const service=new LocalGPTSoVITSService({config:{voiceDir:voice,voiceRuntimeRoot:runtime,voicePythonPath:files.python,voiceApiScriptPath:files.api,voiceGptWeightsPath:files.gpt,voiceSoVitsWeightsPath:files.sovits,voiceReferenceAudioPath:files.reference,voicePromptText:"本地参考",voiceIntimateReferenceAudioPath:files.intimate,voiceIntimatePromptText:"操死我啊,宝贝,操操死我,快点啊。",voiceHost:"127.0.0.1",voicePort:9880,voiceStartupTimeoutMs:1000,voiceRequestTimeoutMs:1000,voiceCacheMaxBytes:1024*1024,voiceCacheMaxAgeMs:10000},fetch:fakeFetch,spawn:fakeSpawn,portOwner:()=>"",sleep:()=>new Promise(resolve=>setTimeout(resolve,2))});
const result=await service.synthesize({text:"安全测试",sessionId:"fixture"});assert(spawned&&synthCalls===1);assert.equal(result.style,"daily");assert.equal(service.publicStatus().state,"ready");assert.equal(fs.readFileSync(service.audioPath(result.id)).subarray(0,4).toString(),"RIFF");assert.equal(service.metrics.cost_usd,0);assert.equal(service.metrics.input_tokens,0);assert.equal(service.metrics.output_tokens,0);
const intimate=await service.synthesize({text:"操死我……",style:"intimate",sessionId:"fixture"});assert.equal(intimate.style,"intimate");assert.equal(synthCalls,2);assert.equal(intimate.text,"操死我。");
const missingIntimate=new LocalGPTSoVITSService({config:{...service.cfg,voiceIntimateReferenceAudioPath:path.join(runtime,"missing.wav")},fetch:fakeFetch,spawn:fakeSpawn,portOwner:()=>"",sleep:service.sleep});
assert.equal(missingIntimate.voiceStyleReference("intimate").style,"daily","missing intimate reference falls back to daily");
assert.equal(service.publicStatus().configured,true,"configured remains independent from running state");
assert.equal(service.updateSettings({mode:"emotion"}).mode,"emotion","Emotion is a persisted output mode without changing synthesis runtime");
const yaml=fs.readFileSync(path.join(voice,"runtime","yuxiao-v2.yaml"),"utf8");assert(yaml.includes("device: cpu")&&yaml.includes("is_half: false"));assert(!JSON.stringify(service.publicStatus()).includes(runtime),"public status does not leak paths");

const conflict=new LocalGPTSoVITSService({config:{...service.cfg,voiceDir:path.join(root,"conflict")},fetch:async()=>new Response("",{status:503}),portOwner:()=>"999"});await assert.rejects(conflict.ensureReady(),error=>error.code==="VOICE_PORT_CONFLICT");
console.log("local voice runtime tests passed");
