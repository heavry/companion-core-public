import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";

const root=path.resolve(import.meta.dirname,".."),base=24500+Math.floor(Math.random()*500),chatPort=base,agentPort=base+1,corePort=base+2,tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-split-routing-")),children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),assert=(value,message)=>{if(!value)throw new Error(`ASSERT: ${message}`);};
const start=(file,env={})=>{const p=spawn(process.execPath,[file],{cwd:root,env:{...process.env,...env},stdio:["ignore","pipe","pipe"]});children.push(p);p.stdout.on("data",x=>process.stdout.write(`[child] ${x}`));p.stderr.on("data",x=>process.stderr.write(`[child-err] ${x}`));return p;};
const stop=async p=>{if(!p||p.exitCode!==null)return;p.kill("SIGTERM");await Promise.race([new Promise(r=>p.once("exit",r)),sleep(1000)]);if(p.exitCode===null)p.kill("SIGKILL");};
async function wait(url){for(let i=0;i<120;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}

try{
  start(path.join(root,"scripts/mock-upstream.js"),{MOCK_PORT:String(chatPort),MOCK_PROVIDER_NAME:"chat"});
  start(path.join(root,"scripts/mock-upstream.js"),{MOCK_PORT:String(agentPort),MOCK_PROVIDER_NAME:"agent"});
  await Promise.all([wait(`http://127.0.0.1:${chatPort}/stats`),wait(`http://127.0.0.1:${agentPort}/stats`)]);
  start(path.join(root,"src/server.js"),{
    COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:"split-key",COMPANION_ADMIN_KEY:"split-admin",DATABASE_PATH:path.join(tmp,"companion.db"),COMPANION_MODULES_DIR:path.join(tmp,"empty-modules"),COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"module-execution-ledger.json"),COMPANION_MODULES_CONFIG_DIR:path.join(tmp,"modules-config"),COMPANION_BLOCK_REAL_UPSTREAM:"1",PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",AGENT_TOOL_MODE:"compat",COMPANION_NATURAL_PRESENCE_ENABLED:"false",
    UPSTREAM_BASE_URL:`http://127.0.0.1:${chatPort}/v1`,UPSTREAM_API_KEY:"chat-key",UPSTREAM_CHAT_MODEL:"grok-chat",UPSTREAM_AGENT_MODEL:"legacy-agent",UPSTREAM_SUMMARY_MODEL:"grok-summary",
    UPSTREAM_AGENT_BASE_URL:`http://127.0.0.1:${agentPort}/v1`,UPSTREAM_AGENT_API_KEY:"agent-key",UPSTREAM_AGENT_MODEL:"deepseek-agent",UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:"",UPSTREAM_CHAT_BASE_URL:`http://127.0.0.1:${chatPort}/v1`,UPSTREAM_CHAT_API_KEY:"",UPSTREAM_SUMMARY_BASE_URL:`http://127.0.0.1:${chatPort}/v1`,UPSTREAM_SUMMARY_API_KEY:"",UPSTREAM_PRIMARY_BASE_URL:"",UPSTREAM_PRIMARY_API_KEY:"",
  });
  await wait(`http://127.0.0.1:${corePort}/health`);
  const headers={authorization:"Bearer split-key","content-type":"application/json"};
  const chat=await fetch(`http://127.0.0.1:${corePort}/v1/chat/completions`,{method:"POST",headers:{...headers,"x-companion-source":"kelivo","x-companion-session":"split-chat"},body:JSON.stringify({model:"yuna-chat",messages:[{role:"user",content:"hello"}]})});
  assert(chat.ok,"yuna-chat succeeds through chat route");
  const agent=await fetch(`http://127.0.0.1:${corePort}/v1/responses`,{method:"POST",headers:{...headers,"x-companion-source":"harness","x-companion-session":"split-agent"},body:JSON.stringify({model:"yuna-agent",input:"hello",tools:[],tool_choice:"none"})});
  assert(agent.ok,"yuna-agent succeeds through agent route");
  const computer=await fetch(`http://127.0.0.1:${corePort}/v1/chat/completions`,{method:"POST",headers:{...headers,"x-companion-source":"opencode","x-companion-session":"compat-computer"},body:JSON.stringify({model:"yuna-agent",messages:[{role:"user",content:"查看当前 macOS 屏幕和窗口 NATIVE_COMPUTER_EXPOSURE"}]})});
  const computerBody=await computer.json();
  assert(computer.ok&&computerBody.choices?.[0]?.message?.content==="NATIVE_COMPUTER_EXPOSURE_OK","compat Agent routes Computer Use through the autonomous tool loop");
  const chatStats=await fetch(`http://127.0.0.1:${chatPort}/stats`).then(r=>r.json()),agentStats=await fetch(`http://127.0.0.1:${agentPort}/stats`).then(r=>r.json());
  // Presence follow-up evaluation may add an asynchronous chat-route request;
  // assert route isolation without depending on that background timing.
  assert(chatStats.total>=1&&agentStats.total>=3,"chat and agent requests reach different upstream addresses");
  assert(agentStats.lastCompat?.model==="deepseek-agent","agent route uses independent DeepSeek model");
  assert(agentStats.lastCompat?.catalog?.some(tool=>tool.name==="computer_screen_observe")&&agentStats.lastCompat.catalog.some(tool=>tool.name==="computer_window_list"),"compat Agent decision contract exposes bounded Computer Use schemas");
  console.log("PASS split Chat/Grok and Agent/DeepSeek upstream routing with isolated URLs and credentials");
}finally{for(const p of [...children].reverse())await stop(p);await sleep(50);fs.rmSync(tmp,{recursive:true,force:true});}
