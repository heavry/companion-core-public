import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";

const worktree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const phase=process.argv[2]??"after";
const serverRoot=path.resolve(process.argv[3]??worktree);
const port=Number(process.env.COMPANION_TEST_PORT??18771);
const route=config.upstreamProviders?.primary?.routes?.chat;
if(route?.baseUrl!=="http://127.0.0.1:8080/v1"||route?.model!=="grok-4.6"||!route?.apiKey){
  throw new Error("formal grok-4.6 route mismatch");
}
const root=fs.mkdtempSync(path.join(os.tmpdir(),`companion-emotion-${phase}-`));
const data=path.join(root,"data");
fs.mkdirSync(data,{recursive:true});
fs.mkdirSync(path.join(root,"config"),{recursive:true});
fs.copyFileSync(path.join(serverRoot,"config/persona.json"),path.join(root,"config/persona.json"));
const output=path.join(worktree,"diagnostics/emotion-causality",`${phase}-real-20260923.json`);
if(fs.existsSync(output))throw new Error(`output already exists: ${output}`);
const testKey="emotion-validation-disposable-local-key";
const env={
  PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR??"/tmp",
  COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(port),COMPANION_DEPLOYMENT_ROLE:"development-test",
  COMPANION_INSTANCE_ID:`emotion-v1-isolated-${phase}`,COMPANION_API_KEY:testKey,COMPANION_ADMIN_KEY:testKey,
  DATABASE_PATH:path.join(data,"companion.db"),
  UPSTREAM_BASE_URL:route.baseUrl,UPSTREAM_API_KEY:route.apiKey,UPSTREAM_CHAT_MODEL:"grok-4.6",
  UPSTREAM_AGENT_BASE_URL:route.baseUrl,UPSTREAM_AGENT_API_KEY:route.apiKey,UPSTREAM_AGENT_MODEL:"grok-4.6",
  UPSTREAM_SUMMARY_MODEL:"grok-4.6",UPSTREAM_TIMEOUT_MS:"90000",
  UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:"",
  COMPANION_BLOCK_REAL_UPSTREAM:"1",SEARCH_PROVIDER:"none",COMPANION_PROACTIVE_DISABLED:"1",
  COMPANION_AUTONOMOUS_LIFE_ENABLED:"0",COMPANION_NATURAL_DIARY_ENABLED:"0",
  COMPANION_MODALITY_PLANNER_ENABLED:"0",COMPANION_NATURAL_PRESENCE_EVENT_LLM_ENABLED:"0",
  COMPANION_NATURAL_PRESENCE_ENABLED:"1",COMPANION_NATURAL_COGNITION_ENABLED:"1",
  COMPANION_NATURAL_MESSAGING_ENABLED:"1",AUTO_PROMOTE_MEMORY:"0",EMBEDDING_ENABLED:"false",
  MEMORY_IMMEDIATE_ENABLED:"false",MEMORY_REVIEW_EVERY_USER_TURNS:"999",
  PERSONA_SYNC_ON_START:"false",SUMMARY_EVERY_MESSAGES:"999",COMPANION_REPLY_LATENCY_ENABLED:"false",
  COMPANION_TEST_PORT:String(port),COMPANION_TEST_PHASE:phase,COMPANION_TEST_SESSION:`emotion-${phase}-20260923`,
  COMPANION_TEST_OUTPUT:output,COMPANION_TEST_PRESENCE_FILE:path.join(data,"natural-presence.json"),
  COMPANION_TEST_WAIT_FOR_SLOT:"1"
};
const log=fs.openSync(path.join(root,"server.log"),"w");
const server=spawn(process.execPath,[path.join(serverRoot,"src/server.js")],{cwd:root,env,stdio:["ignore",log,log]});
let stopped=false;
async function stop(){if(stopped)return;stopped=true;server.kill("SIGTERM");await new Promise(resolve=>setTimeout(resolve,1000));}
process.on("SIGINT",()=>{void stop().then(()=>process.exit(130));});
process.on("SIGTERM",()=>{void stop().then(()=>process.exit(143));});
try{
  console.log(JSON.stringify({stage:"isolated_started",phase,root,port,output}));
  let healthy=false;
  for(let i=0;i<60;i++){
    if(server.exitCode!==null)throw new Error(`server exited before health; see ${path.join(root,"server.log")}`);
    try{const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1500)});if(response.ok){healthy=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!healthy)throw new Error(`isolated server health timeout; see ${path.join(root,"server.log")}`);
  console.log(JSON.stringify({stage:"isolated_health",status:200}));
  const runner=spawn(process.execPath,[path.join(worktree,"scripts/emotion-real-model-test.js")],{cwd:root,env,stdio:"inherit"});
  const exit=await new Promise(resolve=>runner.on("exit",(code,signal)=>resolve({code,signal})));
  console.log(JSON.stringify({stage:"runner_exit",...exit,output}));
  if(exit.code!==0)process.exitCode=1;
}finally{await stop();console.log(JSON.stringify({stage:"isolated_stopped",port}));}
