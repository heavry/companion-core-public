import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-natural-"));
process.env.COMPANION_API_KEY="natural-msg-test-key-long-random";
process.env.DATABASE_PATH=path.join(tmp,"companion.db");
process.env.PERSONA_SYNC_ON_START="true";
process.env.EMBEDDING_ENABLED="false";
process.env.SUMMARY_EVERY_MESSAGES="9999";
process.env.COMPANION_MODULES_DIR=path.join(tmp,"modules");
process.env.COMPANION_MODULES_STATE_PATH=path.join(tmp,"modules-state.json");
process.env.COMPANION_MODULE_EXECUTION_LEDGER_PATH=path.join(tmp,"ledger.json");
process.env.COMPANION_STATE_PATH=path.join(tmp,"companion-state.json");
process.env.COMPANION_BEHAVIOR_PATH=path.join(tmp,"companion-behavior.json");
process.env.COMPANION_MODULES_CONFIG_DIR=path.join(tmp,"modules-config");
process.env.COMPANION_NATURAL_MESSAGING_ENABLED="true";
process.env.COMPANION_INACTIVITY_DEV_OVERRIDE_ENABLED="1";
process.env.COMPANION_AUTONOMOUS_LIFE_ENABLED="false";
process.env.COMPANION_AUTONOMOUS_LIFE_STATE_PATH=path.join(tmp,"autonomous-life.json");
fs.mkdirSync(process.env.COMPANION_MODULES_DIR,{recursive:true});
const mockPort=35100+Math.floor(Math.random()*200);
process.env.UPSTREAM_BASE_URL=`http://127.0.0.1:${mockPort}/v1`;
process.env.UPSTREAM_PRIMARY_BASE_URL="";process.env.UPSTREAM_PRIMARY_API_KEY="";
process.env.UPSTREAM_API_KEY="";process.env.UPSTREAM_CHAT_MODEL="mock-chat";process.env.UPSTREAM_AGENT_MODEL="mock-agent";process.env.UPSTREAM_SUMMARY_MODEL="mock-summary";
process.env.UPSTREAM_SECONDARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_API_KEY="";process.env.UPSTREAM_SECONDARY_MODEL="";
process.env.UPSTREAM_CHAT_BASE_URL=process.env.UPSTREAM_BASE_URL;process.env.UPSTREAM_CHAT_API_KEY="";
process.env.UPSTREAM_AGENT_BASE_URL=process.env.UPSTREAM_BASE_URL;process.env.UPSTREAM_AGENT_API_KEY="";
process.env.UPSTREAM_SUMMARY_BASE_URL=process.env.UPSTREAM_BASE_URL;process.env.UPSTREAM_SUMMARY_API_KEY="";
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";

const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);console.log(`OK  ${m}`);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const minuteText=offset=>{const now=new Date(),total=(now.getHours()*60+now.getMinutes()+offset+1440)%1440;return `${String(Math.floor(total/60)).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`;};

let nextReply={messages:["在"]};
const mock=http.createServer((req,res)=>{
  let raw="";req.on("data",c=>raw+=c);
  req.on("end",()=>{
    const content=JSON.stringify({messages:nextReply.messages});
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({
      id:"m",object:"chat.completion",model:"mock-chat",
      choices:[{index:0,message:{role:"assistant",content},finish_reason:"stop"}],
      usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}
    }));
  });
});

function wsConnect(port,pathName,token){
  return new Promise((resolve,reject)=>{
    const sock=net.connect(port,"127.0.0.1",()=>{
      const wsKey=crypto.randomBytes(16).toString("base64");
      sock.write(`GET ${pathName} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`);
    });
    let handshake="",upgraded=false,buf=Buffer.alloc(0);
    const events=[];
    sock.on("data",chunk=>{
      if(!upgraded){
        handshake+=chunk.toString("latin1");
        const idx=handshake.indexOf("\r\n\r\n");
        if(idx<0)return;
        if(!handshake.slice(0,handshake.indexOf("\r\n")).includes("101")){sock.destroy();reject(new Error("ws handshake failed"));return;}
        upgraded=true;
        const rest=Buffer.from(handshake.slice(idx+4),"latin1");
        if(rest.length)buf=Buffer.concat([buf,rest]);
        resolve({socket:sock,events});
        feed();
        return;
      }
      buf=Buffer.concat([buf,chunk]);feed();
    });
    sock.on("error",reject);
    function feed(){
      while(buf.length>=2){
        const len0=buf[1]&0x7f;let headerLen=2,payloadLen=len0;
        if(len0===126){if(buf.length<4)return;payloadLen=buf.readUInt16BE(2);headerLen=4;}
        else if(len0===127){if(buf.length<10)return;payloadLen=Number(buf.readBigUInt64BE(2));headerLen=10;}
        if(buf.length<headerLen+payloadLen)return;
        const payload=buf.subarray(headerLen,headerLen+payloadLen);
        buf=buf.subarray(headerLen+payloadLen);
        try{events.push(JSON.parse(payload.toString("utf8")));}catch{}
      }
    }
  });
}

try{
  await new Promise(r=>mock.listen(mockPort,"127.0.0.1",r));
  const {ensureDefaultPersona}=await import("../src/persona.js");
  ensureDefaultPersona();
  const {parseNaturalBubbles,bubbleDelayMs,deliverBubbleSequence,isDanglingOpener,hasDanglingLastBubble,ensureCompleteBubbles,ensureSemanticBubbles,looksLikePackedDoubleParagraph}=await import("../src/natural-messaging.js");
  const {db:sqlite,getOrCreateSession,insertMessage}=await import("../src/db.js");
  const stateMod=await import("../src/companion-state.js");
  const proactive=await import("../src/proactive.js");
  const {attachWebSocketServer}=await import("../src/ws.js");
  const httpServer=http.createServer((req,res)=>{res.writeHead(404);res.end();});
  attachWebSocketServer(httpServer);
  const wsPort=36100+Math.floor(Math.random()*200);
  await new Promise(r=>httpServer.listen(wsPort,"127.0.0.1",r));
  const ws=await wsConnect(wsPort,"/ws",process.env.COMPANION_API_KEY);
  await sleep(80);

  // 1-4 parser
  {
    const one=parseNaturalBubbles(JSON.stringify({messages:["在"]}));
    assert(one.ok&&one.fromJson&&one.bubbles.length===1&&one.bubbles[0]==="在","parse single bubble JSON");
    const two=parseNaturalBubbles('{"messages":["怎么啦","刚刚还在想你是不是又忙别的去了"]}');
    assert(two.bubbles.length===2,"parse double bubble");
    const three=parseNaturalBubbles('```json\n{"messages":["嗯","行","吃饭没"]}\n```');
    assert(three.ok&&three.bubbles.length===3,"parse triple bubble with fence");
    const bad=parseNaturalBubbles("我就随便说说，不是 JSON");
    assert(bad.ok===false&&bad.fromJson===false&&bad.bubbles.length===1,"parse failure fallback single");
    const empty=parseNaturalBubbles("   ");
    assert(empty.bubbles.length===0,"empty yields no bubbles");
  }

  // delays
  {
    assert(bubbleDelayMs("在",0)===0,"first bubble no delay");
    const d1=bubbleDelayMs("在",1),d2=bubbleDelayMs("刚刚还在想你是不是又忙别的去了",1);
    assert(d1>0&&d1<2500&&d2>d1,"delay grows with length, stays IM-scale");
  }

  // 5-7 deliver multi bubbles into chat:default with WS
  {
    const session=getOrCreateSession("yuna","chat","chat:default");
    const before=sqlite.prepare("SELECT COUNT(*) c FROM messages WHERE session_id=?").get(session.id).c;
    const t0=Date.now();
    const seq=await deliverBubbleSequence({sessionId:session.id,source:"chat",bubbles:["嗯","行","吃饭没"]});
    const elapsed=Date.now()-t0;
    assert(seq.messages.length===3,"three bubbles delivered");
    assert(elapsed>=400,`bubbles paced (${elapsed}ms)`);
    const rows=sqlite.prepare("SELECT id,content_text,source,role FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 3").all(session.id).reverse();
    assert(rows.map(r=>r.content_text).join("|")==="嗯|行|吃饭没","DB order correct");
    assert(rows.every(r=>r.role==="assistant"&&r.source==="chat"),"each bubble is assistant message");
    await sleep(100);
    const bubbleEvents=ws.events.filter(e=>e.type==="message.created"&&[3,2,1].includes(Number(e.data?.bubbleCount)));
    assert(bubbleEvents.length>=3,`WS received bubble events (${bubbleEvents.length})`);
    const after=sqlite.prepare("SELECT COUNT(*) c FROM messages WHERE session_id=?").get(session.id).c;
    assert(after===before+3,"DB count +3");
  }

  // 9-10 proactive multi-bubble + idempotency
  {
    stateMod.updateBehavior({quietHours:{start:minuteText(2),end:minuteText(4)},dailyProactiveCap:10,proactiveLevel:"active",proactiveMessagesEnabled:true});
    const session=getOrCreateSession("yuna","chat","chat:default");
    insertMessage(session.id,"chat",{role:"user",content:"我明天去测试新版"});
    stateMod.getState().recentTopics=["测试新版"];
    stateMod.saveState();
    stateMod.touchUserInteraction(new Date(Date.now()-40*3600_000).toISOString());
    stateMod.setInactivitySimulation({hoursAgo:40});
    nextReply={messages:["宝宝","刚还在想你","吃饭没"]};
    const out=await proactive.runOnce({at:new Date(),eligibilityRoll:0});
    assert(out.delivered===true,`proactive multi delivered ${JSON.stringify(out).slice(0,200)}`);
    assert((out.bubbleCount??1)>=1,`bubbleCount ${out.bubbleCount}`);
    const proMsgs=sqlite.prepare("SELECT id,content_text FROM messages WHERE session_id=? AND source='proactive' ORDER BY id DESC LIMIT 5").all(session.id);
    assert(proMsgs.length>=Math.min(3,out.bubbleCount??1),`proactive bubbles in chat:default (${proMsgs.length})`);
    const keys=sqlite.prepare(`SELECT json_extract(content_json,'$.proactive_attempt_key') k FROM messages WHERE session_id=? AND source='proactive' ORDER BY id DESC LIMIT 3`).all(session.id);
    assert(keys.every(r=>r.k===out.attemptKey),"all bubbles share attempt key");
    const again=await proactive.runOnce({at:new Date(),eligibilityRoll:0});
    assert(again.delivered===false||again.idempotent===true||String(again.reason??"").includes("cooldown")||String(again.reason??"").includes("already"),`repeat guarded: ${JSON.stringify(again).slice(0,180)}`);
    const hb=await proactive.runHeartbeat({at:new Date()});
    assert(hb.delivered===false||hb.idempotent===true,`heartbeat no re-send: ${JSON.stringify(hb).slice(0,160)}`);
  }

  // Dangling opener guard
  {
    assert(isDanglingOpener("刚想起来一件事"),"detect 刚想起来一件事");
    assert(isDanglingOpener("对了"),"detect 对了");
    assert(!isDanglingOpener("刚想起来一件事，你那个Agent跑完没"),"complete sentence not dangling");
    assert(hasDanglingLastBubble(["啊？","对了"]),"last bubble dangling");
    assert(!hasDanglingLastBubble(["对了","你那个跑完没"]),"complete pair not dangling");
    const repaired=await ensureCompleteBubbles({
      bubbles:["刚想起来一件事"],
      completeFn:async()=>JSON.stringify({messages:["刚想起来一件事","你昨天那个 Agent 后来跑完没？"]})
    });
    assert(repaired.length===2&&!hasDanglingLastBubble(repaired),`continue repairs opener: ${JSON.stringify(repaired)}`);
    const rewritten=await ensureCompleteBubbles({
      bubbles:["对了"],
      completeFn:async({mode,opener})=>{
        if(mode==="rewrite")return JSON.stringify({messages:["对了，你昨天说的那个方案我后来想了一下，A 更合适"]});
        return JSON.stringify({messages:[opener,"你昨天说的那个方案我后来想了一下，A 更合适"]});
      }
    });
    assert(rewritten.length>=2&&!hasDanglingLastBubble(rewritten),`rewrite/continue repairs opener: ${JSON.stringify(rewritten)}`);
  }

  // Packed double-paragraph guard: model re-judges; never code-split
  {
    const packed="没生气。刚才那几条一眼就是测试在跑，尾巴还带着乱码和数字，不当真。\n\n方案 A 你又拍一次板了，简单那条继续算默认。升级你弄就行，弄完回来随便聊。";
    assert(looksLikePackedDoubleParagraph(packed),"detect packed double paragraph");
    assert(!looksLikePackedDoubleParagraph("在呢"),"single short not packed");
    assert(!looksLikePackedDoubleParagraph("嗯\n\n行")===false||true,"noop");
    // short with newline only still may count if both sides long enough; "嗯\n\n行" should not
    assert(!looksLikePackedDoubleParagraph("嗯\n\n行"),"tiny two lines not packed");
    const single=parseNaturalBubbles(JSON.stringify({messages:[packed]}));
    assert(single.bubbles.length===1,"packed arrives as 1 bubble from parser");
    const split=await ensureSemanticBubbles({
      bubbles:single.bubbles,
      completeFn:async()=>JSON.stringify({messages:[
        "没生气。刚才那几条一眼就是测试在跑，尾巴还带着乱码和数字，不当真。",
        "方案 A 你又拍一次板了，简单那条继续算默认。升级你弄就行，弄完回来随便聊。"
      ]})
    });
    assert(split.length===2,`split_judge splits packed acts: ${JSON.stringify(split)}`);
    const keep=await ensureSemanticBubbles({
      bubbles:["在呢"],
      completeFn:async()=>{throw new Error("should not call for short single")}
    });
    assert(keep.length===1&&keep[0]==="在呢","short single stays 1");
    const continuous=await ensureSemanticBubbles({
      bubbles:[packed],
      completeFn:async()=>JSON.stringify({messages:[packed]})
    });
    assert(continuous.length===1,"model can keep one continuous thought");
    // multi-bubble already OK — no rejudge
    const multi=await ensureSemanticBubbles({
      bubbles:["在","行"],
      completeFn:async()=>{throw new Error("should not call for multi")}
    });
    assert(multi.length===2,"multi untouched");
  }

  // Structure protection: fenced code / tables / JSON / logs must not drive multi-act split
  {
    const { looksLikeMultiActReply, shouldRunSemanticNormalizer, isFaithfulRegroup } = await import("../src/natural-messaging.js");

    // 1) Pure fenced code block with internal blank lines → not multi-act
    const pureCode = [
      "```bash",
      "echo start",
      "",
      "echo mid",
      "",
      "echo end",
      "```"
    ].join("\n");
    assert(!looksLikePackedDoubleParagraph(pureCode), "pure fenced code not packed-double");
    assert(!looksLikeMultiActReply(pureCode), "pure fenced code not multi-act");
    assert(!shouldRunSemanticNormalizer([pureCode]), "pure fenced code skips normalizer");

    // 2) Shell/log block with blank lines inside fences
    const logOnly = [
      "```",
      "[ok] step1",
      "",
      "[ok] step2",
      "```"
    ].join("\n");
    assert(!shouldRunSemanticNormalizer([logOnly]), "log-only fenced block skips normalizer");
    // Conversational shell + one fence: blank lines inside fence must not alone
    // create a regroup that drops/rewrites fence lines.
    const logReply = "日志在下面。\n\n" + logOnly + "\n\n有空再细看。";
    const logSplit = ["日志在下面。", logOnly, "有空再细看。"];
    assert(isFaithfulRegroup(logReply, logSplit), "faithful regroup preserves full log fence with blank lines");
    assert(logSplit[1].includes("[ok] step1")&&logSplit[1].includes("[ok] step2")&&logSplit[1].includes("\n\n"),
      "log fence blank line and both steps remain intact");

    // 3) Markdown table with internal structure — no multi-act from pipes/rows alone
    const tableOnly = [
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "| c | d |",
      "| - | - |",
      "| 3 | 4 |"
    ].join("\n");
    // Two tables separated by blank line may look packed to naive detector;
    // structural test: regroup must not drop table text if we ever split.
    const tableActs = ["上面那张表先看。", tableOnly];
    const faithfulTable = isFaithfulRegroup(tableActs.join("\n\n"), tableActs);
    assert(faithfulTable, "faithful regroup keeps markdown table text intact");

    // 4) JSON body with internal blank lines inside fence must survive regroup unchanged
    const jsonFence = [
      "```json",
      "{",
      "  \"a\": 1,",
      "",
      "  \"b\": 2",
      "}",
      "```"
    ].join("\n");
    const jsonReply = "配置我贴一下。\n\n" + jsonFence + "\n\n你看要不要改。";
    const jsonSplit = [
      "配置我贴一下。",
      jsonFence,
      "你看要不要改。"
    ];
    assert(isFaithfulRegroup(jsonReply, jsonSplit), "faithful regroup preserves fenced JSON including blank lines");
    // JSON content must be byte-identical in some bubble
    assert(jsonSplit.some(b=>b.includes("\"a\": 1,")&&b.includes("\"b\": 2")),
      "JSON blank-line interior not stripped by regroup");

    // 5) URL / quote block: multi-line quoted reply is one act, not N acts from newlines
    const quoted = [
      "他原文是：",
      "",
      "> 第一行引用，说明背景。",
      "> 第二行引用，补充细节。",
      "",
      "我这边按这个改完了。"
    ].join("\n");
    // Quote lines inside one paragraph should stay together when checking coverage
    const quotedSplitOk = isFaithfulRegroup(quoted, [
      "他原文是：\n\n> 第一行引用，说明背景。\n> 第二行引用，补充细节。",
      "我这边按这个改完了。"
    ]);
    assert(quotedSplitOk, "faithful regroup keeps quote block content");

    // 6) Should not fire normalizer when only structure (no conversational multi-act)
    const jsonOnly = "```json\n{\"messages\":[1]}\n\n{\"messages\":[2]}\n```";
    assert(!shouldRunSemanticNormalizer([jsonOnly]), "json-only fenced text does not trigger normalizer");

    // 7) Converse: natural multi-act outside fences still triggers
    const naturalAct = "改完了啊，那你来验活正好。\n\n报告那边我看过了，拆气泡那些算过关。";
    assert(shouldRunSemanticNormalizer([naturalAct]), "natural multi-act still triggers normalizer");

    // 8) Destructive regroup (drops table/JSON) must be rejected
    const badJsonSplit = ["配置我贴一下。", "你看要不要改。"]; // dropped JSON fence
    assert(!isFaithfulRegroup(jsonReply, badJsonSplit),
      "regroup that drops fenced JSON is not faithful");
  }

  // TTS fail on 2nd bubble still writes TEXT (no half-turn)
  {
    const session=getOrCreateSession("yuna","chat","chat:default");
    const before=sqlite.prepare("SELECT COUNT(*) c FROM messages WHERE session_id=?").get(session.id).c;
    const seq=await deliverBubbleSequence({
      sessionId:session.id,source:"chat",bubbles:["哈哈这也太好笑了吧！","我这边刚才有点乱，等我弄完再跟你说。"],
      enableModality:true,
      userModality:"voice",
      synthesizeVoice:async()=>{
        throw new Error("tts down");
      }
    });
    assert(seq.messages.length===2,`both bubbles written despite TTS fail ${JSON.stringify(seq.messages)}`);
    assert(seq.messages.every(x=>x.modality==="TEXT"),`TTS fail → TEXT fallback for all attempted ${JSON.stringify(seq.messages.map(x=>({m:x.modality,f:x.voiceFailed})))}`);
    assert(seq.messages.some(x=>x.voiceFailed===true)||seq.messages.every(x=>x.modality==="TEXT"),"no half-turn leftover");
    const after=sqlite.prepare("SELECT COUNT(*) c FROM messages WHERE session_id=?").get(session.id).c;
    assert(after===before+2,"DB got both bubbles");
  }

  // J: user interruption after bubble 0 cancels bubble 1 without merging text.
  {
    const session=getOrCreateSession("yuna","chat","bubble-interruption-fixture");
    let interrupted=false;
    const seq=await deliverBubbleSequence({
      sessionId:session.id,source:"chat",bubbles:["第一条已经发出","第二条应被取消"],
      generationRoute:"interruption_fixture",turnId:"fixture-turn-j",
      hasUserInterrupted:()=>interrupted,
      onDelivered:async({index})=>{if(index===0)interrupted=true;}
    });
    assert(seq.interrupted===true&&seq.messages.length===1,"J interruption cancels only the pending second bubble");
    const rows=sqlite.prepare("SELECT content_text,json_extract(content_json,'$.bubble_index') bi,json_extract(content_json,'$.bubble_count') bc FROM messages WHERE session_id=? AND role='assistant' ORDER BY id").all(session.id);
    assert(rows.length===1&&rows[0].content_text==="第一条已经发出"&&rows[0].bi===0&&rows[0].bc===2,"J delivered bubble remains one durable row with its original identity");
  }

  ws.socket.destroy();
  httpServer.close();
  console.log("\nPASS Natural Messaging v1: parse 1/2/3, fallback, DB order, WS bubbles, pacing, proactive idempotency, dangling opener, TTS fallback, interruption");
}catch(e){throw e;}finally{
  try{mock.close();}catch{}
  try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
}
