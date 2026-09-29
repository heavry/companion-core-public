import fs from "node:fs";
import { decideVoiceDelivery } from "./voice-delivery-policy.js";
import { saveVoiceMedia } from "./media.js";

export function wavDurationSeconds(value){
  const buffer=Buffer.isBuffer(value)?value:Buffer.from(value??[]);
  if(buffer.length<44||buffer.toString("ascii",0,4)!=="RIFF"||buffer.toString("ascii",8,12)!=="WAVE")throw Object.assign(new Error("invalid voice WAV"),{code:"VOICE_ASSET_INVALID"});
  let offset=12,byteRate=0,dataBytes=0;
  while(offset+8<=buffer.length){
    const type=buffer.toString("ascii",offset,offset+4),size=buffer.readUInt32LE(offset+4),start=offset+8;
    if(start+size>buffer.length)break;
    if(type==="fmt "&&size>=12)byteRate=buffer.readUInt32LE(start+8);
    if(type==="data"){dataBytes=size;break;}
    offset=start+size+(size%2);
  }
  if(!byteRate||!dataBytes)throw Object.assign(new Error("invalid voice WAV chunks"),{code:"VOICE_ASSET_INVALID"});
  return Number((dataBytes/byteRate).toFixed(3));
}

export function publicVoiceAsset(entry){
  return {voice_asset_id:entry.id,duration:Number(entry.duration)||0,state:"ready",created_at:entry.createdAt,url:`/media/${entry.id}`};
}

export async function prepareVoiceMessage({mode="manual",enabled=true,userText="",assistantText="",emotion,emotionIntensity,sessionId="",signal=null,synthesize=null,readAudio=null,persist=null}={}){
  const decision=decideVoiceDelivery({mode,enabled,userText,assistantText,emotion,emotionIntensity});
  if(decision.voice_delivery!=="tts")return {delivery:decision,voiceAsset:null};
  // Default must follow selected TTS provider — never hardcode GPT-SoVITS.
  // Failure → TEXT only. No silent engine switch.
  const runSynthesis=synthesize??(async (input)=>{
    const { synthesizeWithSelectedProvider, selectedTtsProviderId } = await import("./tts-providers.js");
    const result=await synthesizeWithSelectedProvider({
      text:input.text,
      style:input.style??decision.voice_style,
      sessionId:input.sessionId,
      signal:input.signal
    });
    return {
      ...result,
      // keep GPT-style result.id contract for loadAudio when provider is gpt_sovits
      id:result.id,
      _provider:result.provider??selectedTtsProviderId(),
      _audio:result.audio
    };
  });
  const loadAudio=readAudio??(async (result)=>{
    if(Buffer.isBuffer(result?._audio))return result._audio;
    if(result?.audio)return result.audio;
    if(result?.audioPath)return fs.readFileSync(result.audioPath);
    // GPT-SoVITS path keeps audioPath via local service
    const { localGPTSoVITSService } = await import("./local-gpt-sovits-service.js");
    return fs.readFileSync(localGPTSoVITSService.audioPath(result.id));
  });
  const saveAudio=persist??(input=>saveVoiceMedia(input));
  try{
    if(signal?.aborted)throw Object.assign(new Error("voice synthesis cancelled"),{name:"AbortError",code:"VOICE_CANCELLED"});
    const result=await runSynthesis({text:assistantText,sessionId,signal,style:decision.voice_style});
    if(signal?.aborted)throw Object.assign(new Error("voice synthesis cancelled"),{name:"AbortError",code:"VOICE_CANCELLED"});
    const audio=await loadAudio(result),duration=wavDurationSeconds(audio);
    const entry=await saveAudio({buffer:audio,duration,sessionId});
    if(signal?.aborted)throw Object.assign(new Error("voice synthesis cancelled"),{name:"AbortError",code:"VOICE_CANCELLED"});
    const voiceAsset=publicVoiceAsset(entry);
    return {delivery:{...decision,voice_asset:voiceAsset,tts_provider:result?._provider??result?.provider??null},voiceAsset};
  }catch(error){
    console.log(`[tts] voice_failed_fallback_text provider_error=${String(error?.message??error).slice(0,120)}`);
    return {delivery:{voice_delivery:"text",reason:error?.name==="AbortError"?"voice_generation_cancelled":"voice_generation_failed",emotion:decision.emotion,emotion_intensity:decision.emotion_intensity},voiceAsset:null,error};
  }
}
