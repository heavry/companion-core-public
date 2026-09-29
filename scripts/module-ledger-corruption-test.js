import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-ledger-corrupt-"));
const modulesDir=path.join(tmp,"modules"),dbPath=path.join(tmp,"companion.db"),ledgerPath=path.join(tmp,"module-execution-ledger.json");
const base=29800+Math.floor(Math.random()*300);
const mockPort=base,corePort=base+1,obsPort=base+2;
const key="corrupt-ledger-key-long-random";
const children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);}
async function wait(url){for(let i=0;i<140;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}

const hits=new Map();
const observer=http.createServer((req,res)=>{
  const u=new URL(req.url,`http://127.0.0.1:${obsPort}`);
  if(u.pathname==="/hit"){const k=u.searchParams.get("key")??"";hits.set(k,(hits.get(k)??0)+1);res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({ok:true}));}
  if(u.pathname==="/counts"){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({count:hits.get(u.searchParams.get("key")??"")??0}));}
  res.writeHead(404);res.end();
});
const hitCount=k=>hits.get(k)??0;

function writeModule(id,manifest,main){
  const dir=path.join(modulesDir,id);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"module.json"),JSON.stringify(manifest,null,2));
  fs.writeFileSync(path.join(dir,"main.js"),main);
}
const baseManifest=overrides=>({id:"x",name:"X",version:"1",type:"tool",engine:"javascript",permissions:[],tools:[],hooks:[],triggers:[],...overrides});
const OBS=`http://127.0.0.1:${obsPort}`;
writeModule("pingy",baseManifest({id:"pingy",name:"Pingy",permissions:["network.fetch"],tools:[
  {name:"mod_ping",description:"ping once per real execution",parameters:{type:"object",additionalProperties:false,properties:{tag:{type:"string"}},required:["tag"]}},
  {name:"mod_flaky",description:"reports then fails",parameters:{type:"object",additionalProperties:false,properties:{}},required:[]}
]}),
`async function ping(args){const tag=String(args?.tag??"a");await companion.network.fetch("${OBS}/hit?key=ping:"+encodeURIComponent(tag));return {pong:tag};}
async function flaky(){await companion.network.fetch("${OBS}/hit?key=flaky");throw new Error("FLAKY_ALWAYS_FAILS");}
module.exports={tools:{mod_ping:ping,mod_flaky:flaky}};`);

let core=null;
const coreEnv={
  COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
  DATABASE_PATH:dbPath,PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",
  AGENT_TOOL_MODE:"compat",
  COMPANION_MODULES_DIR:modulesDir,COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),
  COMPANION_MODULE_EXECUTION_LEDGER_PATH:ledgerPath,
  COMPANION_SEARCH_CONFIG_PATH:path.join(tmp,"search-provider.json"),
  COMPANION_INTEGRATIONS_CONFIG_PATH:path.join(tmp,"integrations.json"),
  COMPANION_INTEGRATIONS_SECRETS_PATH:path.join(tmp,"integrations-secrets.json"),
  UPSTREAM_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_API_KEY:"",UPSTREAM_CHAT_MODEL:"mock-chat",UPSTREAM_AGENT_MODEL:"mock-agent",UPSTREAM_SUMMARY_MODEL:"mock-summary",
  UPSTREAM_PRIMARY_BASE_URL:"",UPSTREAM_PRIMARY_API_KEY:"",
  UPSTREAM_CHAT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_CHAT_API_KEY:"",
  UPSTREAM_AGENT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_AGENT_API_KEY:"",
  UPSTREAM_SUMMARY_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_SUMMARY_API_KEY:"",
  UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:"",
  COMPANION_BLOCK_REAL_UPSTREAM:"1"
};
async function startCore(){
  core=spawn(process.execPath,[path.join(root,"src/server.js")],{cwd:root,env:{...process.env,...coreEnv},stdio:["ignore","pipe","pipe"]});
  children.push(core);
  await wait(`http://127.0.0.1:${corePort}/health`);
}
function killCore(){if(core&&core.exitCode===null)core.kill("SIGKILL");core=null;}
const responses=(input,session)=>fetch(`http://127.0.0.1:${corePort}/v1/responses`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"harness","x-companion-session":session},body:JSON.stringify({model:"yuna-agent",input,tools:[],tool_choice:"auto"})}).then(async r=>({status:r.status,text:await r.text()}));
const answerText=t=>{try{const d=JSON.parse(t);return (d.output??[]).flatMap(x=>x?.content??[]).map(x=>x?.text??"").join("");}catch{return ""}};
const adminStatus=()=>fetch(`http://127.0.0.1:${corePort}/admin/status`,{headers:{authorization:`Bearer ${key}`}}).then(r=>r.json());

try{
  const obsServer=await new Promise(r=>observer.listen(obsPort,"127.0.0.1",r));
  const mock=spawn(process.execPath,[path.join(root,"scripts/mock-upstream.js")],{cwd:root,env:{...process.env,MOCK_PORT:String(mockPort)},stdio:["ignore","ignore","ignore"]});
  children.push(mock);
  await wait(`http://127.0.0.1:${mockPort}/stats`);
  await startCore();

  // 先产生真实执行记录（completed + uncertain 两类）
  const rA=await responses([{role:"user",content:"CALL_PING PINGTAG:pre MODULE_ECHO_LAST_TOOL"}],"pre");
  assert(rA.status===200&&hitCount("ping:pre")===1,"baseline execution ok");
  assert(Object.values(JSON.parse(fs.readFileSync(ledgerPath,"utf8")).records).some(x=>x.status==="completed"),"completed record persisted");
  killCore();await sleep(120);

  // ---------- 模拟损坏：整份文件变成非法 JSON ----------
  fs.writeFileSync(ledgerPath,"{\"records\":{\"broken\":tru");
  await startCore();

  // D: Admin 显示 health=corrupt + corrupt_backup
  {
    const st=await adminStatus();
    assert(st.module_execution_ledger.health==="corrupt","D health=corrupt reported");
    assert(typeof st.module_execution_ledger.corrupt_backup==="string"&&st.module_execution_ledger.corrupt_backup.includes(".corrupt-"),"D corrupt_backup path exposed");
    assert(st.module_execution_ledger.path.endsWith("module-execution-ledger.json"),"D ledger path exposed");
    assert(!JSON.stringify(st.module_execution_ledger).includes("fingerprint"),"D no record content leaked via admin status");
  }

  // A: completed 记录已随损坏丢失 → 相同请求重放必须被阻止，handler 不再执行
  {
    const before=hitCount("ping:pre");
    const r=await responses([{role:"user",content:"CALL_PING PINGTAG:pre MODULE_ECHO_LAST_TOOL"}],"pre-corrupt");
    assert(r.status===200,"A blocked replay returns 200 with explicit tool result");
    assert(answerText(r.text).includes("Module execution ledger is unavailable/corrupt"),"A fail-closed message surfaced to model/client");
    await sleep(150);
    assert(hitCount("ping:pre")===before,`A handler never re-executed while ledger corrupt (hits=${hitCount("ping:pre")})`);
  }

  // B: pending/uncertain 场景同样被阻断 —— 直接构造含 uncertain 的合法文件再损坏
  {
    killCore();await sleep(120);
    const now=Date.now();
    fs.writeFileSync(ledgerPath,JSON.stringify({version:1,savedAt:new Date().toISOString(),records:{
      "unc\u0000pingy\u0000mod_ping\u0000{\"tag\":\"unc\"}":{fingerprint:"fp-unc",status:"uncertain",attempts:0,text:"",moduleId:"pingy",tool:"mod_ping",session:"s-unc",sideEffect:"non_idempotent",createdAt:now,updatedAt:now,expiresAt:0}
    }}));
    await startCore();
    let st=await adminStatus();assert(st.module_execution_ledger.health==="healthy","B valid file loads healthy again");
    killCore();await sleep(120);
    fs.writeFileSync(ledgerPath,"CORRUPT-AFTER-UNCERTAIN{{");
    await startCore();
    st=await adminStatus();assert(st.module_execution_ledger.health==="corrupt","B corruption after uncertain detected");
    const r=await responses([{role:"user",content:"CALL_PING PINGTAG:unc MODULE_ECHO_LAST_TOOL"}],"s-unc");
    await sleep(150);
    assert(hitCount("ping:unc")===0,"B handler not executed for uncertain record under corruption");
    assert(answerText(r.text).includes("blocked to avoid duplicate actions"),"B block reason surfaced");
  }

  // C: 损坏状态下 Kelivo chat / client tools / provider 路由照常工作
  {
    const chat=await fetch(`http://127.0.0.1:${corePort}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"kelivo"},body:JSON.stringify({model:"yuna-chat",messages:[{role:"user",content:"hello"}]})});
    const chatData=await chat.json();
    assert(chat.ok&&chatData.choices?.[0]?.message?.content==="MOCK_OK","C Kelivo chat unaffected by corrupt ledger");
    const bash=await fetch(`http://127.0.0.1:${corePort}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"opencode","x-companion-session":"c-bash"},body:JSON.stringify({model:"yuna-agent",messages:[{role:"user",content:"COMPAT_SELECT_TOOL:bash"}],tools:[{type:"function",function:{name:"bash",description:"shell",parameters:{type:"object",properties:{}}}}],tool_choice:"auto"})});
    const bashData=await bash.json();
    assert(bashData.choices?.[0]?.message?.tool_calls?.[0]?.function?.name==="bash","C client tools still returned to client");
    assert((await (await fetch(`http://127.0.0.1:${corePort}/health`)).json()).ok,"C Core healthy overall");
  }

  // reset 端点：无 confirm → 400 且携带后果警告
  {
    const noConfirm=await fetch(`http://127.0.0.1:${corePort}/admin/modules/ledger/reset`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:"{}"});
    const nc=await noConfirm.json();
    assert(noConfirm.status===400&&nc.requires_confirm&&nc.error.includes("重复副作用"),"reset without confirm refused with warning");
  }

  // E: 显式人工恢复 → 空 ledger → health 恢复 healthy，副作用工具恢复可执行
  {
    const reset=await fetch(`http://127.0.0.1:${corePort}/admin/modules/ledger/reset`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify({confirm:true})});
    const rd=await reset.json();
    assert(reset.ok&&rd.health==="healthy"&&rd.warning.includes("重复副作用"),"E manual recovery restores healthy with warning");
    let st=await adminStatus();
    assert(st.module_execution_ledger.health==="healthy","E admin reflects healthy");
    const r=await responses([{role:"user",content:"CALL_PING PINGTAG:post MODULE_ECHO_LAST_TOOL"}],"post");
    assert(r.status===200&&hitCount("ping:post")===1,"E side-effecting module executes again only after explicit recovery");
    assert(answerText(r.text).includes('"pong":"post"'),"E normal replay semantics resume");
    st=await adminStatus();
    assert(st.module_execution_ledger.pending!==undefined&&st.module_execution_ledger.uncertain!==undefined,"pending/uncertain counts visible for future resolve/purge");
  }

  console.log("\nPASS Ledger Corruption Fail-Closed: corrupt→quarantine+health=corrupt, side-effecting module tools blocked (no re-execution), chat/client-tools/admin unaffected, explicit manual reset required to resume");
}catch(e){throw e;}finally{
  observer.close();
  fs.rmSync(tmp,{recursive:true,force:true});
  for(const p of [...children].reverse()){try{p.kill("SIGKILL");}catch{}}
  await sleep(100);
}
