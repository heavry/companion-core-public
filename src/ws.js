// 最小 RFC6455 WebSocket 服务器（零依赖）。
//
// 选择 WebSocket 而非 SSE 的原因：
//  - Mac 客户端需要长期订阅 + 未来上行（订阅过滤/确认），WS 双向更自然
//  - 本 server 是裸 node:http，升级握手即可挂载，无需引入依赖
//  - 只实现 server→client 文本帧 + client ping/pong/close，攻击面最小
//
// 鉴权：upgrade 请求必须携带有效 Bearer API Key（header 或 ?token=），否则拒绝。

import crypto from "node:crypto";
import { config } from "./config.js";
import { registerSubscriber,removeSubscriber,busStats } from "./events-bus.js";

const WS_MAGIC="258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(key){return crypto.createHash("sha1").update(key+WS_MAGIC).digest("base64");}

function encodeTextFrame(str){
  const payload=Buffer.from(str,"utf8"),len=payload.length;
  let header;
  if(len<126)header=Buffer.from([0x81,len]);
  else if(len<65536){header=Buffer.alloc(4);header[0]=0x81;header[1]=126;header.writeUInt16BE(len,2);}
  else{header=Buffer.alloc(10);header[0]=0x81;header[1]=127;header.writeBigUInt64BE(BigInt(len),2);}
  return Buffer.concat([header,payload]);
}

function decodeFrames(buffer,onMessage,onClose){
  const frames=[];let offset=0;
  while(offset+2<=buffer.length){
    const first=buffer[offset],second=buffer[offset+1];
    const opcode=first&0x0f,masked=Boolean(second&0x80);
    let len=second&0x7f,offset2=offset+2;
    if(len===126){if(offset2+2>buffer.length)break;len=buffer.readUInt16BE(offset2);offset2+=2;}
    else if(len===127){if(offset2+8>buffer.length)break;len=Number(buffer.readBigUInt64BE(offset2));offset2+=8;}
    if(len>1024*1024)break;
    let mask=null;
    if(masked){if(offset2+4>buffer.length)break;mask=buffer.subarray(offset2,offset2+4);offset2+=4;}
    if(offset2+len>buffer.length)break;
    let payload=buffer.subarray(offset2,offset2+len);
    if(mask&&mask.length===4){payload=Buffer.from(payload);for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];}
    frames.push({opcode,payload});
    offset=offset2+len;
    if(opcode===0x8){onClose();return frames;}
  }
  return {frames,consumed:offset};
}

export function attachWebSocketServer(httpServer){
  const clients=new Map(); // socket -> {awaitingPong:bool}
  let sweepTimer=null;

  // 死连接清理：每 60s 发协议级 ping；上一轮 ping 未回 pong 的客户端判定为死链销毁。
  // 防止半开连接（客户端崩溃/网络切换）导致订阅槽位泄漏。
  sweepTimer=setInterval(()=>{
    for(const [socket,state] of clients){
      if(state.awaitingPong){try{socket.destroy();}catch{};clients.delete(socket);removeSubscriberBySocket(socket);continue;}
      try{socket.write(Buffer.from([0x89,0]));state.awaitingPong=true;}catch{try{socket.destroy();}catch{}}
    }
  },60_000);
  sweepTimer.unref?.();

  function removeSubscriberBySocket(socket){
    // subscriber 与 socket 一一对应（register/remove 由闭包维护）
    const client=socket.__companionClient;
    if(client)removeSubscriber(client);
  }
  httpServer.on("upgrade",(req,socket)=>{
    try{
      const url=new URL(req.url,`http://${req.headers.host??"localhost"}`);
      if(url.pathname!=="/ws"){socket.destroy();return;}
      // 鉴权仅接受 Authorization header；?token= 属于 legacy，默认关闭（避免 token 进入 URL/日志）
      let bearer=(req.headers.authorization??"").replace(/^Bearer\s+/i,"");
      if(!bearer&&process.env.COMPANION_WS_ALLOW_QUERY_TOKEN==="1")bearer=url.searchParams.get("token")||"";
      if(bearer!==config.apiKey){socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");socket.destroy();return;}
      const wsKey=req.headers["sec-websocket-key"];
      if(!wsKey||(req.headers.upgrade??"").toLowerCase()!=="websocket"){socket.destroy();return;}
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(wsKey)}\r\n\r\n`);
      socket.setNoDelay(true);
      let closed=false;
      const close=()=>{
        if(closed)return;closed=true;
        removeSubscriber(client);clients.delete(socket);
        try{socket.destroy();}catch{};
      };
      const client={
        sendEvent:event=>{
          if(closed)return;
          socket.write(encodeTextFrame(JSON.stringify(event)));
        },
        sendRaw:obj=>{if(!closed)socket.write(encodeTextFrame(JSON.stringify(obj)));}
      };
      socket.__companionClient=client;
      let acc=Buffer.alloc(0);
      socket.on("data",chunk=>{
        if(closed)return;
        acc=Buffer.concat([acc,chunk]);
        const result=decodeFrames(acc,
          text=>{try{const msg=JSON.parse(text);if(msg?.type==="ping")client.sendRaw({type:"pong",at:new Date().toISOString()});}catch{}},
          close);
        if(Array.isArray(result)){close();return;}
        acc=acc.subarray(result.consumed);
        for(const frame of result.frames){
          if(frame.opcode===0x9)socket.write(Buffer.from([0x8a,frame.payload.length]));
          else if(frame.opcode===0xA){const st=clients.get(socket);if(st)st.awaitingPong=false;}
        }
      });
      socket.on("error",close);
      socket.on("close",close);
      socket.on("end",close);   // 客户端正常退出发送 FIN：立即回收，而不是等写失败
      clients.set(socket,{awaitingPong:false});
      if(registerSubscriber(client)){
        client.sendRaw({type:"hello",at:new Date().toISOString(),bus:busStats()});
      }else{
        client.sendRaw({type:"error",error:"too many subscribers"});
        close();
      }
    }catch{
      try{socket.destroy();}catch{}
    }
  });
  return {
    clientCount:()=>clients.size,
    closeAll(){for(const socket of [...clients.keys()]){try{socket.destroy();}catch{}}clients.clear();},
    stopSweep(){if(sweepTimer){clearInterval(sweepTimer);sweepTimer=null;}}
  };
}
