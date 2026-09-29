import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { publishEvent } from "./events-bus.js";

// Media Store：模块/主动消息产出的图片等媒体文件。
//  - 文件落盘 data/media/<id>.<ext>，索引存 data/media-store.json
//  - id 为受控 UUID；GET /media/<id> 只按索引解析路径，天然防路径穿越
//  - 不把 base64 大图写入 SQLite 或 WebSocket

const MEDIA_DIR=path.join(path.dirname(config.databasePath),"media");
const INDEX_PATH=path.join(path.dirname(config.databasePath),"media-store.json");
const IMAGE_MIME={"image/png":"png","image/jpeg":"jpg","image/webp":"webp"};
const ALLOWED_MIME={...IMAGE_MIME,"audio/wav":"wav"};
const MAX_MEDIA_BYTES=16*1024*1024;
export const MAX_UPLOAD_BYTES=10*1024*1024;
export const VOICE_RETENTION_MS=30*24*60*60*1000;
export const VOICE_CACHE_MAX_BYTES=256*1024*1024;

function invalidImage(message="invalid image data"){
  return Object.assign(new Error(message),{code:"MEDIA_DECODE_INVALID",statusCode:400});
}
function pngDimensions(buf){
  const signature=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  if(buf.length<33||!buf.subarray(0,8).equals(signature)||buf.toString("ascii",12,16)!=="IHDR"||buf.toString("ascii",buf.length-8,buf.length-4)!=="IEND")throw invalidImage();
  const width=buf.readUInt32BE(16),height=buf.readUInt32BE(20);
  if(!width||!height)throw invalidImage();
  return {width,height};
}
function jpegDimensions(buf){
  if(buf.length<16||buf[0]!==0xff||buf[1]!==0xd8||buf.lastIndexOf(Buffer.from([0xff,0xd9]))<2)throw invalidImage();
  const sof=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  let i=2;
  while(i+8<buf.length){
    while(i<buf.length&&buf[i]===0xff)i++;
    const marker=buf[i++];
    if(marker===undefined||marker===0xd9)break;
    if(marker===0x01||(marker>=0xd0&&marker<=0xd8))continue;
    if(i+2>buf.length)break;
    const length=buf.readUInt16BE(i);
    if(length<2||i+length>buf.length)break;
    if(sof.has(marker)){
      const height=buf.readUInt16BE(i+3),width=buf.readUInt16BE(i+5);
      if(width&&height)return {width,height};
      break;
    }
    i+=length;
  }
  throw invalidImage();
}
function webpDimensions(buf){
  if(buf.length<30||buf.toString("ascii",0,4)!=="RIFF"||buf.toString("ascii",8,12)!=="WEBP"||buf.readUInt32LE(4)+8>buf.length)throw invalidImage();
  const type=buf.toString("ascii",12,16);
  let width=0,height=0;
  if(type==="VP8X"&&buf.length>=30){width=1+buf.readUIntLE(24,3);height=1+buf.readUIntLE(27,3);}
  else if(type==="VP8L"&&buf.length>=25&&buf[20]===0x2f){const bits=buf.readUInt32LE(21);width=1+(bits&0x3fff);height=1+((bits>>>14)&0x3fff);}
  else if(type==="VP8 "&&buf.length>=30&&buf[23]===0x9d&&buf[24]===0x01&&buf[25]===0x2a){width=buf.readUInt16LE(26)&0x3fff;height=buf.readUInt16LE(28)&0x3fff;}
  if(!width||!height)throw invalidImage();
  return {width,height};
}
export function decodeImageDimensions(buffer,mime){
  const buf=Buffer.isBuffer(buffer)?buffer:Buffer.from(buffer??[]);
  if(mime==="image/png")return pngDimensions(buf);
  if(mime==="image/jpeg")return jpegDimensions(buf);
  if(mime==="image/webp")return webpDimensions(buf);
  throw Object.assign(new Error(`unsupported media mime: ${mime}`),{code:"MEDIA_MIME_UNSUPPORTED",statusCode:415});
}
function safeFilename(filename,ext){
  const base=path.basename(String(filename??"")).normalize("NFC").replace(/[^\p{L}\p{N}._ -]+/gu,"_").slice(0,120);
  return base||`image.${ext}`;
}

let index=null;
function loadIndex(){
  if(index)return index;
  try{index=JSON.parse(fs.readFileSync(INDEX_PATH,"utf8"));}
  catch{index={version:1,media:[]};}
  return index;
}
function persistIndex(){
  try{
    fs.mkdirSync(MEDIA_DIR,{recursive:true});
    const tmp=`${INDEX_PATH}.${process.pid}.tmp`;
    const fd=fs.openSync(tmp,"w");
    try{fs.writeFileSync(fd,JSON.stringify(loadIndex(),null,1));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(tmp,INDEX_PATH);
  }catch(e){console.error("[media] index persist failed:",e?.message??e);}
}

export function saveMedia({base64=null,buffer=null,mime="image/png",width=null,height=null,sessionId=null,messageId=null,kind="generated"}={}){
  const ext=ALLOWED_MIME[mime];
  if(!ext)throw Object.assign(new Error(`unsupported media mime: ${mime}`),{code:"MEDIA_MIME_UNSUPPORTED"});
  const buf=buffer??Buffer.from(String(base64??""),"base64");
  if(!buf.length||buf.length>MAX_MEDIA_BYTES)throw Object.assign(new Error(`invalid media size ${buf.length}`),{code:"MEDIA_SIZE_INVALID"});
  fs.mkdirSync(MEDIA_DIR,{recursive:true});
  const id=crypto.randomUUID();
  const relPath=`media/${id}.${ext}`;
  const absPath=path.join(path.dirname(config.databasePath),relPath);
  const tmpFile=`${absPath}.tmp`;
  fs.writeFileSync(tmpFile,buf);
  fs.renameSync(tmpFile,absPath);
  const entry={id,mime,width:width??null,height:height??null,path:relPath,bytes:buf.length,sessionId,messageId:messageId??null,kind,createdAt:new Date().toISOString()};
  loadIndex().media.unshift(entry);
  persistIndex();
  publishEvent(kind==="voice_message"?"voice.asset.created":"image.created",{mediaId:id,mime,width:entry.width,height:entry.height,bytes:entry.bytes,kind},{sessionId});
  return entry;
}

export function saveUploadedMedia({buffer,mime,filename}={}){
  const ext=IMAGE_MIME[mime];
  if(!ext)throw Object.assign(new Error(`unsupported media mime: ${mime}`),{code:"MEDIA_MIME_UNSUPPORTED",statusCode:415});
  const buf=Buffer.isBuffer(buffer)?buffer:Buffer.from(buffer??[]);
  if(!buf.length||buf.length>MAX_UPLOAD_BYTES)throw Object.assign(new Error(`invalid media size ${buf.length}`),{code:"MEDIA_SIZE_INVALID",statusCode:buf.length>MAX_UPLOAD_BYTES?413:400});
  const dimensions=decodeImageDimensions(buf,mime);
  const entry=saveMedia({buffer:buf,mime,...dimensions,kind:"upload"});
  entry.filename=safeFilename(filename,ext);
  persistIndex();
  return entry;
}

export function pruneVoiceMedia({now=Date.now(),maxAgeMs=VOICE_RETENTION_MS,maxBytes=VOICE_CACHE_MAX_BYTES}={}){
  const voices=loadIndex().media.filter(item=>item.kind==="voice_message"&&!item.expiredAt).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  let total=0,changed=false;
  for(const item of voices){
    const tooOld=now-Date.parse(item.createdAt)>maxAgeMs,tooLarge=!tooOld&&(total+Number(item.bytes||0)>maxBytes);
    if(tooOld||tooLarge){
      const abs=path.join(path.dirname(config.databasePath),item.path);try{fs.unlinkSync(abs);}catch{}
      item.expiredAt=new Date(now).toISOString();changed=true;
    }else total+=Number(item.bytes||0);
  }
  if(changed)persistIndex();
  return {retainedBytes:total,expired:voices.filter(item=>item.expiredAt).length};
}

export function saveVoiceMedia({buffer,duration,sessionId=null}={}){
  const buf=Buffer.isBuffer(buffer)?buffer:Buffer.from(buffer??[]);
  if(buf.length<44||buf.subarray(0,4).toString()!=="RIFF"||buf.subarray(8,12).toString()!=="WAVE")throw Object.assign(new Error("invalid voice WAV"),{code:"VOICE_ASSET_INVALID"});
  const entry=saveMedia({buffer:buf,mime:"audio/wav",sessionId,kind:"voice_message"});
  entry.duration=Math.max(0,Number(duration)||0);entry.state="ready";persistIndex();pruneVoiceMedia();return entry;
}

export function getMedia(id){
  if(typeof id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))return null;
  const entry=loadIndex().media.find(m=>m.id===id);
  if(!entry)return null;
  // 双保险：即便索引被篡改也强制约束在 media 目录内
  const base=path.resolve(path.dirname(config.databasePath));
  const abs=path.resolve(base,entry.path);
  if(!abs.startsWith(path.join(base,"media")+path.sep))return null;
  let buffer=null;
  try{buffer=fs.readFileSync(abs);}catch{return {...entry,missing:true};}
  return {...entry,buffer};
}

export function attachMediaToMessage(mediaId,messageId){
  const m=loadIndex().media.find(x=>x.id===mediaId);
  if(m){
    const ids=new Set(Array.isArray(m.messageIds)?m.messageIds.map(String):[]);
    if(m.messageId!=null)ids.add(String(m.messageId));
    ids.add(String(messageId));m.messageIds=[...ids];m.messageId=m.messageIds[0];persistIndex();
  }
  return m??null;
}

export function attachmentsForMessage(messageId){
  if(!messageId)return [];
  const wanted=String(messageId);
  return loadIndex().media
    .filter(m=>m.kind!=="voice_message"&&(String(m.messageId??"")===wanted||(Array.isArray(m.messageIds)&&m.messageIds.map(String).includes(wanted))))
    .map(({id,buffer,...rest})=>({mediaId:id,...rest}));
}
export function voiceAssetForMessage(messageId){
  if(!messageId)return null;const wanted=String(messageId),m=loadIndex().media.find(item=>item.kind==="voice_message"&&(String(item.messageId??"")===wanted||(Array.isArray(item.messageIds)&&item.messageIds.map(String).includes(wanted))));
  if(!m)return null;return {voice_asset_id:m.id,duration:Number(m.duration)||0,state:m.expiredAt?"expired":"ready",created_at:m.createdAt,expired_at:m.expiredAt??null,url:`/media/${m.id}`};
}
export function mediaIdsForContent(content){
  if(!Array.isArray(content))return [];
  const ids=[];
  for(const part of content){
    const raw=part?.media_id??(typeof part?.image_url==="string"?part.image_url:part?.image_url?.url);
    const match=typeof raw==="string"?raw.match(/^companion-media:\/\/([0-9a-f-]{36})$/i):null;
    if(match)ids.push(match[1]);
  }
  return [...new Set(ids)];
}
export function mediaStats(){return {count:loadIndex().media.length};}
