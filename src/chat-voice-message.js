import fs from "node:fs";
import { config } from "./config.js";
import { localSenseVoiceService } from "./local-sensevoice-service.js";
import { saveVoiceMedia,getMedia } from "./media.js";
import { insertMessage } from "./db.js";
import { publishEvent } from "./events-bus.js";
import { wavDurationSeconds,publicVoiceAsset } from "./voice-message-delivery.js";
import { getOrCreateSession } from "./db.js";

// Chat Voice Message v1：录完再发的一条普通聊天消息。
// 与电话（实时连续语音）产品概念分离；不复用电话 session/state machine。

export function chatDefaultSession(personaId=config.defaultPersonaId){
  return getOrCreateSession(personaId,"chat","chat:default");
}

/**
 * Accept user voice WAV, STT it, persist audio, insert a user message with
 * type=voice into chat:default. Never creates an empty message on STT failure.
 */
export async function ingestUserVoiceMessage({
  audioBase64,
  audioBuffer=null,
  durationMs=null,
  sessionId=null,
  source="chat",
  signal=null
}={}){
  if(!config.chatVoiceMessageEnabled)throw Object.assign(new Error("chat voice messages disabled"),{code:"VOICE_MESSAGE_DISABLED",statusCode:409});
  const buffer=audioBuffer?Buffer.from(audioBuffer):Buffer.from(String(audioBase64??""),"base64");
  if(buffer.length<44||buffer.subarray(0,4).toString()!=="RIFF"||buffer.subarray(8,12).toString()!=="WAVE"){
    throw Object.assign(new Error("valid WAV audio is required"),{code:"STT_INVALID_AUDIO",statusCode:400});
  }
  let transcript="";
  let speechContext=null;
  try{
    const stt=await localSenseVoiceService.transcribe({audioBase64:buffer.toString("base64"),sessionId:sessionId??"",signal});
    transcript=String(stt?.text??stt?.transcript??"").trim();
    speechContext=stt?.speech_context??null;
  }catch(error){
    // do not write an empty user message
    throw Object.assign(new Error(`voice transcription failed: ${error?.message??error}`),{code:"STT_FAILED",statusCode:502,cause:error});
  }
  if(!transcript){
    throw Object.assign(new Error("transcription produced empty text"),{code:"STT_EMPTY",statusCode:422});
  }
  const duration=Number(durationMs)||Number(wavDurationSeconds(buffer)*1000)||0;
  const session=sessionId?{id:sessionId}:chatDefaultSession();
  const media=saveVoiceMedia({buffer,duration:duration/1000,sessionId:session.id});
  const voiceAsset=publicVoiceAsset(media);
  const messageId=insertMessage(session.id,source,{
    role:"user",
    content:transcript,
    voice_asset:voiceAsset,
    voice_message:{
      type:"voice",
      audio_path:media.path,
      audio_id:media.id,
      duration_ms:duration,
      transcript,
      url:voiceAsset.url,
      source:"user"
    }
  });
  publishEvent("message.created",{
    messageId,role:"user",source,type:"voice",
    preview:transcript.slice(0,200),
    attachments:[{mediaId:media.id,mime:"audio/wav"}],
    voice_asset:voiceAsset,
    transcript,
    deliveryTargets:["mac"]
  },{sessionId:session.id});
  return {
    messageId,sessionId:session.id,transcript,duration_ms:duration,
    voice_asset:voiceAsset,speech_context:speechContext,mediaId:media.id
  };
}

export function voiceMessageMetadataForContext(message){
  const vm=message?.voice_message;
  if(vm?.transcript)return vm.transcript;
  return typeof message?.content==="string"?message.content:"";
}
