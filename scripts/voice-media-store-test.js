import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-voice-media-"));
process.env.DATABASE_PATH=path.join(tmp,"companion.db");

function wav(seconds=1,sampleRate=8000){
  const dataBytes=Math.round(seconds*sampleRate*2),buffer=Buffer.alloc(44+dataBytes);
  buffer.write("RIFF",0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write("WAVE",8);buffer.write("fmt ",12);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(sampleRate,24);buffer.writeUInt32LE(sampleRate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write("data",36);buffer.writeUInt32LE(dataBytes,40);return buffer;
}

try{
  const {attachMediaToMessage,getMedia,pruneVoiceMedia,saveVoiceMedia,voiceAssetForMessage}=await import("../src/media.js");
  const first=saveVoiceMedia({buffer:wav(1),duration:1,sessionId:"session"});attachMediaToMessage(first.id,42);
  assert.equal(getMedia(first.id).buffer.equals(wav(1)),true,"persisted audio replays without TTS runtime");
  assert.equal(voiceAssetForMessage(42).state,"ready");
  pruneVoiceMedia({now:Date.now()+1000,maxAgeMs:0,maxBytes:999999});
  assert.equal(voiceAssetForMessage(42).state,"expired");assert.equal(getMedia(first.id).missing,true);

  const old=saveVoiceMedia({buffer:wav(1),duration:1}),newest=saveVoiceMedia({buffer:wav(1),duration:1});
  pruneVoiceMedia({maxAgeMs:Number.MAX_SAFE_INTEGER,maxBytes:newest.bytes});
  assert.equal(getMedia(newest.id).missing,undefined,"newest voice remains inside byte budget");
  assert.equal(getMedia(old.id).missing,true,"older voice expires when cache exceeds byte budget");
  console.log("voice media persistence and bounded cleanup tests passed");
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
