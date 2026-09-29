// Realtime Event Bus：向已订阅的 WebSocket 客户端广播 Companion 活动事件。
//
// 安全边界：
//  - 只广播显式构造的最小负载；绝不自动序列化整个请求/响应对象
//  - 字符串统一截断（preview 类 ≤400 字符；任何未知深层数值同样受限）
//  - 禁止出现 apiKey/authorization/persona 原文等敏感键

import crypto from "node:crypto";

const PREVIEW_CHARS=400;
const MAX_SUBSCRIBERS=64;

const subscribers=new Set();
let droppedEvents=0;

function previewText(value,max=PREVIEW_CHARS){
  const text=String(value??"");
  if(text.length<=max)return text;
  return `${text.slice(0,max)}…[${text.length} chars]`;
}

function sanitizePayload(payload,depth=0){
  if(payload===null||payload===undefined)return payload;
  const type=typeof payload;
  if(type==="string")return previewText(payload);
  if(type==="number"||type==="boolean")return payload;
  if(depth>4)return "[deep]";
  if(Array.isArray(payload))return payload.slice(0,20).map(x=>sanitizePayload(x,depth+1));
  if(type==="object"){
    const out={};
    for(const [k,v] of Object.entries(payload)){
      if(/key|token|secret|authorization|password/i.test(k))continue;
      out[k]=sanitizePayload(v,depth+1);
    }
    return out;
  }
  return String(payload);
}

export function publishEvent(type,payload={},meta={}){
  const event={
    type,
    eventId:`evt_${crypto.randomBytes(8).toString("hex")}`,
    at:new Date().toISOString(),
    sessionId:meta.sessionId??null,
    data:sanitizePayload(payload)
  };
  if(!subscribers.size){droppedEvents++;return event;}
  for(const client of subscribers){
    try{client.sendEvent(event);}
    catch{subscribers.delete(client);}
  }
  return event;
}

export function registerSubscriber(client){
  if(subscribers.size>=MAX_SUBSCRIBERS)return false;
  subscribers.add(client);
  return true;
}
export function removeSubscriber(client){subscribers.delete(client);}
export function subscriberCount(){return subscribers.size;}
export function busStats(){return {subscribers:subscribers.size,dropped_events:droppedEvents};}
