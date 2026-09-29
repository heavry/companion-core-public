import fs from "node:fs";
import path from "node:path";

/**
 * Safe TTS audio cleanup for chat voice bubbles.
 * - Trim only leading/trailing near-silence.
 * - Preserve natural internal pauses (breath, comma, sentence rhythm).
 * Voice-only post-process; never rewrites speech energy mid-utterance.
 */

function readWav(buf){
  if(buf.length<44||buf.toString("ascii",0,4)!=="RIFF"||buf.toString("ascii",8,12)!=="WAVE") {
    throw Object.assign(new Error("invalid WAV"),{code:"VOICE_ASSET_INVALID"});
  }
  let offset=12,fmt=null,dataStart=null,dataSize=0;
  while(offset+8<=buf.length){
    const id=buf.toString("ascii",offset,offset+4);
    const size=buf.readUInt32LE(offset+4);
    const body=offset+8;
    if(body+size>buf.length)break;
    if(id==="fmt "){
      const audioFormat=buf.readUInt16LE(body);
      const channels=buf.readUInt16LE(body+2);
      const sampleRate=buf.readUInt32LE(body+4);
      const byteRate=buf.readUInt32LE(body+8);
      const blockAlign=buf.readUInt16LE(body+12);
      const bits=buf.readUInt16LE(body+14);
      fmt={audioFormat,channels,sampleRate,byteRate,blockAlign,bits};
    }else if(id==="data"){dataStart=body;dataSize=size;}
    offset=body+size+(size%2);
  }
  if(!fmt||dataStart==null)throw Object.assign(new Error("invalid WAV chunks"),{code:"VOICE_ASSET_INVALID"});
  const pcm=buf.subarray(dataStart,dataStart+dataSize);
  return {fmt,pcm};
}

function writeWav(fmt,pcm){
  const header=Buffer.alloc(44);
  header.write("RIFF",0,"ascii");
  header.writeUInt32LE(36+pcm.length,4);
  header.write("WAVE",8,"ascii");
  header.write("fmt ",12,"ascii");
  header.writeUInt32LE(16,16);
  header.writeUInt16LE(fmt.audioFormat,20);
  header.writeUInt16LE(fmt.channels,22);
  header.writeUInt32LE(fmt.sampleRate,24);
  header.writeUInt32LE(fmt.byteRate,28);
  header.writeUInt16LE(fmt.blockAlign,32);
  header.writeUInt16LE(fmt.bits,34);
  header.write("data",36,"ascii");
  header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

function frameEnergies(pcm,sampleRate,channels,frameMs=20){
  const bytesPerSample=2;
  const frameSamples=Math.max(1,Math.floor(sampleRate*frameMs/1000));
  const frameBytes=frameSamples*channels*bytesPerSample;
  const out=[];
  for(let i=0;i+frameBytes<=pcm.length;i+=frameBytes){
    let sum=0,count=0;
    for(let s=0;s<frameBytes;s+=2){
      const v=pcm.readInt16LE(i+s)/32768;
      sum+=v*v;count++;
    }
    out.push(count?Math.sqrt(sum/count):0);
  }
  return {energies:out, frameBytes};
}

/**
 * Trim only head/tail near-silence. Internal pauses are left intact so
 * GPT-SoVITS natural timing (comma/breath) is not crushed.
 */
export function sanitizeTtsWav(buffer,{headPadMs=80,tailPadMs=120,thresholdRatio=0.06,minFloor=0.012}={}){
  const {fmt,pcm}=readWav(Buffer.isBuffer(buffer)?Buffer.from(buffer):Buffer.from(buffer??[]));
  if(fmt.bits!==16||fmt.audioFormat!==1)return buffer; // only PCM16
  const {energies,frameBytes}=frameEnergies(pcm,fmt.sampleRate,fmt.channels);
  if(!energies.length)return buffer;
  const frameSec=0.02;
  const peak=Math.max(...energies);
  const thr=Math.max(minFloor,peak*thresholdRatio);
  const flags=energies.map(e=>e>=thr);
  let first=flags.findIndex(Boolean);
  let last=flags.length-1;
  while(last>=0&&!flags[last])last--;
  if(first<0||last<first)return buffer; // silence-only: leave as-is
  const headFrames=Math.max(0,Math.floor(headPadMs/1000/frameSec));
  const tailFrames=Math.max(0,Math.floor(tailPadMs/1000/frameSec));
  const startFrame=Math.max(0,first-headFrames);
  const endFrame=Math.min(flags.length,last+1+tailFrames);
  // Head/tail trim only — do not compress intermediate silence.
  const outPcm=Buffer.from(pcm.subarray(startFrame*frameBytes,endFrame*frameBytes));
  return writeWav(fmt,outPcm);
}

export function wavDurationSeconds(buf){
  const {fmt,pcm}=readWav(Buffer.isBuffer(buf)?buf:Buffer.from(buf??[]));
  const bytesPerSec=fmt.sampleRate*fmt.channels*(fmt.bits/8);
  return Number((pcm.length/bytesPerSec).toFixed(3));
}

export function analyzeVoiceWav(buf){
  const {fmt,pcm}=readWav(Buffer.isBuffer(buf)?Buffer.from(buf):Buffer.from(buf??[]));
  const {energies}=frameEnergies(pcm,fmt.sampleRate,fmt.channels);
  const peak=Math.max(0,...energies);
  const thr=Math.max(0.012,peak*0.06);
  const flags=energies.map(e=>e>=thr);
  const speech=flags.map((v,i)=>v?i:-1).filter(i=>i>=0);
  const gaps=[];
  for(let k=1;k<speech.length;k++){
    const d=speech[k]-speech[k-1];
    if(d>1)gaps.push(Number((d*0.02).toFixed(3)));
  }
  return {
    duration_s:Number((pcm.length/(fmt.sampleRate*fmt.channels*2)).toFixed(3)),
    speech_span_s:speech.length?Number(((speech.at(-1)-speech[0]+1)*0.02).toFixed(3)):0,
    head_silence_s:speech.length?Number((speech[0]*0.02).toFixed(3)):null,
    tail_silence_s:speech.length?Number(((flags.length-1-speech.at(-1))*0.02).toFixed(3)):null,
    max_gap_s:gaps.length?Math.max(...gaps):0,
    long_gaps:gaps.filter(g=>g>=0.35),
    sample_rate:fmt.sampleRate
  };
}
