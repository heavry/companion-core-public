import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-debug-leak-"));
const logPath=path.join(tmp,"debug.log"),port=28900+Math.floor(Math.random()*200);
const PERSONA_TEXT="TOP_SECRET_PERSONA_BODY_林小糖_绝不能出现在日志中";
const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// 本地 mock upstream（仅回环，绝不触达真实 Provider）
const server=http.createServer((req,res)=>{
  let raw="";req.on("data",c=>raw+=c);req.on("end",()=>{
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({id:"m",object:"chat.completion",model:"mock",choices:[{index:0,message:{role:"assistant",content:'{"type":"final_answer","content":"ok"}'},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  });
});

function runChild(debugValue){
  return new Promise((resolve,reject)=>{
    const env={...process.env,
      COMPANION_DEBUG:debugValue,COMPANION_DEBUG_LOG:logPath,COMPANION_BLOCK_REAL_UPSTREAM:"1",
      UPSTREAM_BASE_URL:`http://127.0.0.1:${port}/v1`,UPSTREAM_API_KEY:"",UPSTREAM_CHAT_MODEL:"mock-chat",UPSTREAM_AGENT_MODEL:"mock-agent",UPSTREAM_SUMMARY_MODEL:"mock-summary",
      UPSTREAM_AGENT_BASE_URL:`http://127.0.0.1:${port}/v1`,UPSTREAM_AGENT_API_KEY:"",
      UPSTREAM_PRIMARY_BASE_URL:"",UPSTREAM_PRIMARY_API_KEY:"",
      UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:""
    };
    const script=`
      const {config}=await import(${JSON.stringify(path.join(root,"src/config.js"))});
      const {upstreamCompat}=await import(${JSON.stringify(path.join(root,"src/upstream.js"))});
      console.log("debugEnabled="+config.debugEnabled);
      try{await upstreamCompat({max_tokens:16},[{role:"system",content:${JSON.stringify(PERSONA_TEXT)}},{role:"user",content:"hi"}],null);}catch(e){console.log("upstream-error:"+e.message);}
      console.log("done");
    `;
    const child=spawn(process.execPath,["--input-type=module","-e",script],{cwd:root,env,stdio:["ignore","pipe","pipe"]});
    let out="",err="";
    child.stdout.on("data",d=>out+=String(d));
    child.stderr.on("data",d=>err+=String(d));
    child.on("error",reject);
    child.on("exit",(code,signal)=>{
      if(code!==0)return reject(new Error(`child exited code=${code} signal=${signal}\nstderr:${err.slice(0,800)}`));
      resolve({out,err});
    });
    setTimeout(()=>{try{child.kill("SIGKILL");}catch{}reject(new Error("child timeout"));},20000);
  });
}

try{
  await new Promise(r=>server.listen(port,"127.0.0.1",r));
  // 场景 1：COMPANION_DEBUG 未设置 → 绝不写日志
  delete process.env.COMPANION_DEBUG;
  const r1=await runChild("");
  assert(r1.out.includes("debugEnabled=false"),"default debug disabled");
  assert(!fs.existsSync(logPath),"no debug log written when COMPANION_DEBUG is off");

  // 场景 2：COMPANION_DEBUG=false → 同样不写
  const r2=await runChild("false");
  assert(r2.out.includes("debugEnabled=false"),"explicit false keeps debug disabled");
  assert(!fs.existsSync(logPath),"no debug log with explicit COMPANION_DEBUG=false");

  // 场景 3：COMPANION_DEBUG=true → 仅结构信息，无 persona 原文
  const r3=await runChild("true");
  assert(r3.out.includes("debugEnabled=true"),"opt-in debug enabled");
  for(let i=0;i<40&&!fs.existsSync(logPath);i++)await sleep(50);
  assert(fs.existsSync(logPath),"structural log written when explicitly enabled");
  const rawLog=fs.readFileSync(logPath,"utf8");
  const entries=rawLog.trim().split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
  assert(entries.length>=1&&entries.every(e=>e.event==="compat_system_structure"),"log events are structural only");
  assert(entries.every(e=>typeof e.system_message_chars==="number"),"logs expose message char counts");
  assert(entries.every(e=>!("first500" in e)&&!("persona-preview" in e)),"legacy persona-preview/first500 fields removed");
  assert(!rawLog.includes("TOP_SECRET_PERSONA_BODY")&&!rawLog.includes("林小糖"),"persona body never appears in log");

  console.log("\nPASS Debug Persona Leak Fix: silent by default, structural-only when opted in, no persona content ever logged");
}catch(e){throw e;}finally{
  server.close();
  await sleep(60);
  fs.rmSync(tmp,{recursive:true,force:true});
}
