import { config } from "./config.js";
import { findProactiveMessageByAttemptKey,getOrCreateSession,getSession,insertMessage } from "./db.js";
import { attachMediaToMessage } from "./media.js";
import { publishEvent } from "./events-bus.js";
import { onAssistantMessageDelivered } from "./natural-cognition/index.js";

// Message Router / Outbox：Core 对外的统一消息投递抽象。
// 主动消息必须进入用户日常使用的 Chat conversation（Mac 默认 chat/chat:default），
// 否则只会出现在用户不可见的独立 session 里。message.source 仍为 proactive 以便审计。

const DAILY_CHAT_SOURCE="chat";
const DAILY_CHAT_EXTERNAL_KEY="chat:default";

export function resolveDailyChatSession(personaId=config.defaultPersonaId){
  return getOrCreateSession(personaId,DAILY_CHAT_SOURCE,DAILY_CHAT_EXTERNAL_KEY);
}

export async function deliver({type="text",content="",sessionId=null,attachments=[],source="proactive",idempotencyKey=null}){
  const attemptKey=typeof idempotencyKey==="string"?idempotencyKey.slice(0,120):null;
  if(attemptKey){
    const existing=findProactiveMessageByAttemptKey(attemptKey);
    if(existing)return {sessionId:existing.session_id,messageId:Number(existing.id),attachments:[],inserted:false,createdAt:existing.created_at};
  }
  const personaId=config.defaultPersonaId;
  let session;
  if(sessionId){
    session=getSession(sessionId);
    if(!session)throw Object.assign(new Error(`deliver: unknown session ${sessionId}`),{code:"SESSION_NOT_FOUND"});
  }else{
    session=resolveDailyChatSession(personaId);
  }
  const messageId=insertMessage(session.id,source,{role:"assistant",content:String(content??""),...(attemptKey?{proactive_attempt_key:attemptKey}:{})});
  const linked=[];
  for(const att of Array.isArray(attachments)?attachments:[]){
    if(att?.mediaId&&attachMediaToMessage(att.mediaId,messageId))linked.push({mediaId:att.mediaId,mime:att.mime??"image/png"});
  }
  if(type==="image"||linked.length){
    publishEvent("image.created",{mediaId:linked[0]?.mediaId??null,messageId,preview:String(content??"").slice(0,200)},{sessionId:session.id});
  }
  publishEvent("message.created",{messageId,role:"assistant",source,type,preview:String(content??"").slice(0,300),attachments:linked,deliveryTargets:["mac"]},{sessionId:session.id});
  onAssistantMessageDelivered({messageId,sessionId:session.id});
  return {sessionId:session.id,messageId,attachments:linked,inserted:true,createdAt:new Date().toISOString()};
}
