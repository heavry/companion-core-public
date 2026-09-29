import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root=path.resolve(import.meta.dirname,"..");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-bubble-finalization-"));
const base=37400+Math.floor(Math.random()*200),mockPort=base,corePort=base+1;
const key="bubble-finalization-test-key-long-random";
const dbPath=path.join(tmp,"companion.db"),children=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(value,message)=>{if(!value)throw new Error(`ASSERT: ${message}`);console.log(`OK  ${message}`);};

let fixture={raw:"",normalized:null,normalizerCalls:0};
const allContent=messages=>(messages??[]).map(message=>typeof message?.content==="string"?message.content:JSON.stringify(message?.content??"")).join("\n");
const completion=content=>({id:"fixture",object:"chat.completion",model:"mock-chat",choices:[{index:0,message:{role:"assistant",content},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
const mock=http.createServer((req,res)=>{
  let raw="";req.on("data",chunk=>raw+=chunk);req.on("end",()=>{
    const body=JSON.parse(raw||"{}");
    const semantic=allContent(body.messages).includes("Semantic Bubble Normalizer");
    const content=semantic?(fixture.normalizerCalls++,JSON.stringify({messages:fixture.normalized??[fixture.raw]})):fixture.raw;
    if(body.stream===true&&!semantic){
      res.writeHead(200,{"content-type":"text/event-stream"});
      const chars=Array.from(content),middle=Math.max(1,Math.floor(chars.length/2));
      for(const [index,part] of [chars.slice(0,middle).join(""),chars.slice(middle).join("")].filter(Boolean).entries()){
        res.write(`data: ${JSON.stringify({id:"upstream",object:"chat.completion.chunk",model:"mock-chat",choices:[{index:0,delta:{role:"assistant",content:part},finish_reason:index===1?"stop":null}]})}\n\n`);
      }
      res.write(`data: ${JSON.stringify({usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2},choices:[]})}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(completion(content)));
  });
});

function startCore(){
  const child=spawn(process.execPath,[path.join(root,"src/server.js")],{cwd:root,env:{
    ...process.env,
    COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
    DATABASE_PATH:dbPath,PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",
    COMPANION_MODULES_DIR:path.join(tmp,"modules"),COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),
    COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"ledger.json"),COMPANION_MODULES_CONFIG_DIR:path.join(tmp,"modules-config"),
    COMPANION_STATE_PATH:path.join(tmp,"state.json"),COMPANION_BEHAVIOR_PATH:path.join(tmp,"behavior.json"),
    COMPANION_NATURAL_PRESENCE_ENABLED:"false",COMPANION_NATURAL_COGNITION_ENABLED:"false",COMPANION_AUTONOMOUS_LIFE_ENABLED:"false",
    COMPANION_REPLY_LATENCY_ENABLED:"false",COMPANION_MODALITY_PLANNER_ENABLED:"false",COMPANION_BUBBLE_SSE_CHUNK_CHARS:"6",
    UPSTREAM_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_API_KEY:"",UPSTREAM_CHAT_MODEL:"mock-chat",UPSTREAM_AGENT_MODEL:"mock-agent",UPSTREAM_SUMMARY_MODEL:"mock-summary",
    UPSTREAM_CHAT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_CHAT_API_KEY:"",UPSTREAM_AGENT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_AGENT_API_KEY:"",UPSTREAM_SUMMARY_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_SUMMARY_API_KEY:"",
    UPSTREAM_PRIMARY_BASE_URL:"",UPSTREAM_PRIMARY_API_KEY:"",UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:"",
    COMPANION_BLOCK_REAL_UPSTREAM:"1"
  },stdio:["ignore","ignore","pipe"]});
  child.stderr.on("data",data=>{if(!String(data).includes("ExperimentalWarning"))process.stderr.write(String(data).slice(0,500));});
  children.push(child);return child;
}

async function waitCore(){for(let i=0;i<160;i++){try{if((await fetch(`http://127.0.0.1:${corePort}/health`)).ok)return;}catch{}await sleep(50);}throw new Error("Core fixture startup timeout");}
async function stop(child){if(!child||child.exitCode!==null)return;child.kill("SIGTERM");await Promise.race([new Promise(resolve=>child.once("exit",resolve)),sleep(1500)]);}

function decodeSse(text){
  const frames=[],summaries=[];
  for(const block of text.split(/\r?\n\r?\n/)){
    const data=block.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()).join("\n");
    if(!data||data==="[DONE]")continue;
    try{
      const value=JSON.parse(data);
      if(Array.isArray(value.companion_bubbles)){summaries.push(value);continue;}
      const content=value?.choices?.[0]?.delta?.content;
      if(typeof content==="string"&&content)frames.push({text:content,index:value.companion_bubble_index,count:value.companion_bubble_count,messageId:value.companion_message_id,turnId:value.companion_bubble_turn_id});
    }catch{}
  }
  return {frames,summary:summaries.at(-1)??null};
}

async function runCase(name,{raw,normalized=null,expected,session}){
  fixture={raw,normalized,normalizerCalls:0};
  const response=await fetch(`http://127.0.0.1:${corePort}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"chat","x-companion-session":session},body:JSON.stringify({model:"yuna-chat",stream:true,messages:[{role:"user",content:`fixture ${name}`}],tools:[{type:"function",function:{name:"fixture_unused",parameters:{type:"object"}}}]})});
  assert(response.status===200,`${name}: HTTP 200`);
  const sse=decodeSse(await response.text());
  const db=new DatabaseSync(dbPath,{readOnly:true});
  let rows;
  try{
    rows=db.prepare(`SELECT m.id,m.content_text,json_extract(m.content_json,'$.bubble_index') bubble_index,json_extract(m.content_json,'$.bubble_count') bubble_count,json_extract(m.content_json,'$.bubble_turn_id') bubble_turn_id,json_extract(m.content_json,'$.generation_route') generation_route FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.external_key=? AND m.role='assistant' AND m.content_text<>'' ORDER BY m.id`).all(session);
  }finally{db.close();}
  assert(rows.length===expected.length,`${name}: DB has ${expected.length} assistant bubble rows`);
  assert(rows.map(row=>row.content_text).join("|")===expected.join("|"),`${name}: DB texts preserve semantic acts`);
  assert(rows.every((row,index)=>row.bubble_index===index&&row.bubble_count===expected.length),`${name}: DB bubble metadata is complete`);
  assert(rows.every(row=>row.bubble_turn_id&&row.generation_route.startsWith("core_tools")),`${name}: DB turn identity and generation route survive`);
  assert(sse.summary?.companion_bubble_count===expected.length,`${name}: SSE summary count matches`);
  assert(new Set(sse.frames.map(frame=>frame.messageId)).size===expected.length,`${name}: SSE durable ids match bubble cardinality`);
  assert(sse.frames.every(frame=>Number.isInteger(frame.index)&&frame.count===expected.length&&frame.turnId),`${name}: every SSE chunk carries bubble metadata`);
  for(let index=0;index<expected.length;index++){
    const chunks=sse.frames.filter(frame=>frame.index===index);
    assert(chunks.map(frame=>frame.text).join("")===expected[index],`${name}: bubble ${index} chunks reassemble exactly`);
  }
  return {rows,sse,normalizerCalls:fixture.normalizerCalls};
}

try{
  await new Promise(resolve=>mock.listen(mockPort,"127.0.0.1",resolve));
  let core=startCore();await waitCore();

  await runCase("A-two",{raw:JSON.stringify({messages:["刚回来呀","先歇会也行"]}),expected:["刚回来呀","先歇会也行"],session:"bubble-fixture-a"});
  await runCase("B-three",{raw:JSON.stringify({messages:["第一件事","第二件事","第三件事"]}),expected:["第一件事","第二件事","第三件事"],session:"bubble-fixture-b"});
  const c=await runCase("C-plain-fallback",{raw:"行，表扬。一边背语文一边让人给姐姐修新东西，这叫会安排。\n\n背就认真背，别光想着被夸。周一晚上十点了，背完一轮就收，明天还上课。姐姐在这儿呢，你学你的。",normalized:["行，表扬。一边背语文一边让人给姐姐修新东西，这叫会安排。","背就认真背，别光想着被夸。周一晚上十点了，背完一轮就收，明天还上课。姐姐在这儿呢，你学你的。"],expected:["行，表扬。一边背语文一边让人给姐姐修新东西，这叫会安排。","背就认真背，别光想着被夸。周一晚上十点了，背完一轮就收，明天还上课。姐姐在这儿呢，你学你的。"],session:"bubble-fixture-c"});
  assert(c.normalizerCalls===1,"C: plain packed reply passes semantic normalizer exactly once");
  const d=await runCase("D-long-single",{raw:"这是一段完整的说明，它围绕同一个问题给出连续解释，虽然内容比较长，但没有第二个独立聊天动作。",expected:["这是一段完整的说明，它围绕同一个问题给出连续解释，虽然内容比较长，但没有第二个独立聊天动作。"],session:"bubble-fixture-d"});
  assert(d.normalizerCalls===0,"D: coherent long reply is not forced apart");
  const code="解释：\n```js\nconst value = { a: 1 };\n\nconsole.log(value);\n```";
  const e=await runCase("E-structural",{raw:code,normalized:[code],expected:[code],session:"bubble-fixture-e"});
  assert(e.rows.length===1&&e.rows[0].content_text===code,"E: Markdown/code remains one intact durable bubble");
  const g=await runCase("F-G-core-tools-stream",{raw:JSON.stringify({messages:["这是第一条比较长的气泡","这是第二条也会分成传输块"]}),expected:["这是第一条比较长的气泡","这是第二条也会分成传输块"],session:"bubble-fixture-fg"});
  assert(g.sse.frames.filter(frame=>frame.index===0).length>1&&g.sse.frames.filter(frame=>frame.index===1).length>1,"G: each bubble may span multiple SSE chunks without identity loss");

  await stop(core);core=startCore();await waitCore();
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const rows=db.prepare("SELECT COUNT(*) count FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.external_key='bubble-fixture-a' AND m.role='assistant'").get();
    assert(rows.count===2,"I: restart reload preserves two durable bubble rows");
  }finally{db.close();}

  console.log("\nPASS Bubble Finalization A-I: structured 2/3, semantic plain fallback, coherent single, structural content, core_tools, multi-chunk SSE, durable metadata, restart");
}finally{
  mock.close();for(const child of [...children].reverse())await stop(child);
  fs.rmSync(tmp,{recursive:true,force:true});await sleep(100);
}
