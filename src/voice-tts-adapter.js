import { makeCapability } from "./capability-registry.js";
import { localGPTSoVITSService } from "./local-gpt-sovits-service.js";

export const VOICE_TOOL_NAME="voice_tts";

export function voiceAvailabilityGuidance(service=localGPTSoVITSService){
  const status=service.publicStatus(),available=status.configured&&status.enabled;
  return [
    "【Companion Voice Delivery｜运行时真值】",
    available
      ?"本轮支持 Companion 语音交付。GPT-SoVITS 是 final 之后的 Delivery Policy，当前进程停止也可能只是正常 idle；明确语音请求会 lazy start 并在交付前合成。不得因为模型 tools 中没有 TTS 就声称‘语音没挂上’。"
      :"本轮 Companion 语音交付不可用；只能根据这个运行时状态说明，不得臆测原因。",
    `Voice delivery: ${available?"available":"unavailable"}; configured=${status.configured}; enabled=${status.enabled}; runtime=${status.state}; lazy_start=true.`
  ].join("\n");
}

export function voiceTTSCapabilityContext(service=localGPTSoVITSService){
  const status=service.publicStatus();
  const capability=makeCapability({sourceType:"native",sourceId:"voice",toolName:VOICE_TOOL_NAME,displayName:"Local Voice (Yuxiao)",description:"使用本机 GPT-SoVITS 将适合朗读的中文文本合成为鱼筱语音。只接受文本、voice 与 speed，不向模型暴露运行时或模型文件路径。",inputSchema:{type:"object",additionalProperties:false,required:["text"],properties:{text:{type:"string",minLength:1,maxLength:2000},voice:{type:"string",enum:["yuxiao"]},speed:{type:"number",minimum:.6,maximum:1.5}}},sideEffect:"idempotent",permissions:["read"],tags:["voice","tts","local","audio"],enabled:status.enabled,availability:status.enabled?"available":"disabled",requiresNetwork:false,riskLevel:"low"},new Set());
  capability.capabilityId="native:voice.tts";capability.id="native:voice.tts";capability.integrationName="Local Voice";
  return {capabilities:[capability],tools:[{type:"function",function:{name:capability.name,description:capability.description,parameters:capability.inputSchema}}]};
}

export async function executeVoiceTTSTool({name,args,sessionId,service=localGPTSoVITSService}={}){
  if(name!==VOICE_TOOL_NAME)throw Object.assign(new Error("unknown voice tool"),{code:"VOICE_TOOL_NOT_FOUND"});
  const result=await service.synthesize({text:args?.text,voice:args?.voice??"yuxiao",speed:args?.speed??service.settings.speed,sessionId});
  return {ok:true,modelContent:JSON.stringify({capability:"voice.tts",profile:"yuxiao",audio_id:result.id,content_type:result.content_type,duration_ms:result.duration_ms}),durableContent:`Local voice synthesis completed (${result.id}).`,...result};
}
