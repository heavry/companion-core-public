import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-comfy-"));
const modulesDir=path.join(tmp,"modules"),configDir=path.join(tmp,"modules-config"),dbPath=path.join(tmp,"companion.db");
const base=32600+Math.floor(Math.random()*300);
const mockPort=base,comfyPort=base+1,corePort=base+2,key="comfy-test-key-long-random";
const children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);};
async function wait(url){for(let i=0;i<140;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}

// 1x1 PNG
const TINY_PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");

// Mock ComfyUI：/prompt、/history/<id>、/view（binary）
let promptIdCounter=0;
const comfy=http.createServer((req,res)=>{
  const u=new URL(req.url,`http://127.0.0.1:${comfyPort}`);
  if(u.pathname==="/prompt"&&req.method==="POST"){
    let raw="";req.on("data",c=>raw+=c);
    return req.on("end",()=>{
      try{
        const body=JSON.parse(raw||"{}");
        assert(body.prompt&&body.prompt["6"]&&body.prompt["6"].inputs.text.includes("a tiny test image"),"workflow embeds model prompt");
        const id=`job-${++promptIdCounter}`;
        globalThis[`hist_${id}`]={outputs:{"9":{images:[{filename:"ComfyUI_00001_.png",subfolder:"",type:"output"}]}},status:{completed:true}};
        res.writeHead(200,{"content-type":"application/json"});
        res.end(JSON.stringify({prompt_id:id}));
      }catch(e){res.writeHead(500);res.end(String(e.message));}
    });
  }
  if(u.pathname.startsWith("/history/")){
    const id=u.pathname.split("/").pop();
    const hist=globalThis[`hist_${id}`];
    res.writeHead(200,{"content-type":"application/json"});
    return res.end(JSON.stringify(hist?{[id]:hist}:{}));
  }
  if(u.pathname==="/view"){
    res.writeHead(200,{"content-type":"image/png"});
    return res.end(TINY_PNG);
  }
  res.writeHead(404);res.end();
});

function startCore(){
  const p=spawn(process.execPath,[path.join(root,"src/server.js")],{cwd:root,env:{
    ...process.env,
    COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
    DATABASE_PATH:dbPath,PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",
    AGENT_TOOL_MODE:"compat",
    COMPANION_MODULES_DIR:modulesDir,COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),
    COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"ledger.json"),
    COMPANION_MODULES_CONFIG_DIR:configDir,
    COMPANION_SEARCH_CONFIG_PATH:path.join(tmp,"search-provider.json"),
    COMPANION_INTEGRATIONS_CONFIG_PATH:path.join(tmp,"integrations.json"),
    COMPANION_INTEGRATIONS_SECRETS_PATH:path.join(tmp,"integrations-secrets.json"),
    UPSTREAM_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_API_KEY:"",UPSTREAM_CHAT_MODEL:"mock-chat",UPSTREAM_AGENT_MODEL:"mock-agent",UPSTREAM_SUMMARY_MODEL:"mock-summary",
    UPSTREAM_AGENT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_AGENT_API_KEY:"",
    UPSTREAM_CHAT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_CHAT_API_KEY:"",
    UPSTREAM_SUMMARY_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_SUMMARY_API_KEY:"",
    UPSTREAM_PRIMARY_BASE_URL:"",UPSTREAM_PRIMARY_API_KEY:"",
    UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:"",
    COMPANION_BLOCK_REAL_UPSTREAM:"1"
  },stdio:["ignore","pipe","pipe"]});
  children.push(p);
  return p;
}

try{
  await new Promise(r=>comfy.listen(comfyPort,"127.0.0.1",r));
  const mock=spawn(process.execPath,[path.join(root,"scripts/mock-upstream.js")],{cwd:root,env:{...process.env,MOCK_PORT:String(mockPort)},stdio:["ignore","ignore","ignore"]});
  children.push(mock);
  await wait(`http://127.0.0.1:${mockPort}/stats`);

  // 安装真实 comfyui 模块 + 注入 baseUrl 配置
  fs.mkdirSync(modulesDir,{recursive:true});
  fs.cpSync(path.join(root,"modules/comfyui"),path.join(modulesDir,"comfyui"),{recursive:true});
  fs.mkdirSync(configDir,{recursive:true});
  fs.writeFileSync(path.join(configDir,"comfyui.json"),JSON.stringify({baseUrl:`http://127.0.0.1:${comfyPort}`},null,2));

  const core=startCore();
  await wait(`http://127.0.0.1:${corePort}/health`);
  let st=await (await fetch(`http://127.0.0.1:${corePort}/admin/status`,{headers:{authorization:`Bearer ${key}`}})).json();
  assert(st.version==="0.2.8.0","health version 0.2.8.0");

  // 模块加载与工具注册
  {
    const mods=await (await fetch(`http://127.0.0.1:${corePort}/admin/modules`,{headers:{authorization:`Bearer ${key}`}})).json();
    const comfyMod=mods.modules.find(m=>m.id==="comfyui");
    assert(comfyMod?.loaded===true&&comfyMod.tools.some(t=>t.name==="generate_image"),"comfyui module loaded with generate_image");
  }

  // 端到端：模型决策 CALL_IMAGE → Core 执行模块 → ComfyUI mock → media store
  const r=await fetch(`http://127.0.0.1:${corePort}/v1/responses`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"harness","x-companion-session":"img-1"},body:JSON.stringify({model:"yuna-agent",input:[{role:"user",content:"CALL_IMAGE"}],tools:[],tool_choice:"auto"})});
  assert(r.status===200,"image generation request ok");

  // 从持久化的 tool 结果中取 mediaId
  const {DatabaseSync}=await import("node:sqlite");
  const db=new DatabaseSync(dbPath,{readOnly:true});
  let mediaId;try{
    const row=db.prepare("SELECT content_text FROM messages WHERE role='tool' AND content_text LIKE '%mediaId%' ORDER BY id DESC LIMIT 1").get();
    mediaId=JSON.parse(row.content_text).mediaId;
  }finally{db.close();}
  assert(/^[0-9a-f-]{36}$/.test(mediaId??""),"mediaId produced by module via media store");

  // GET /media/<id> 鉴权 + 内容一致 + 路径穿越防护
  {
    const noAuth=await fetch(`http://127.0.0.1:${corePort}/media/${mediaId}`);
    assert(noAuth.status===401,"media requires auth");
    const ok=await fetch(`http://127.0.0.1:${corePort}/media/${mediaId}`,{headers:{authorization:`Bearer ${key}`}});
    assert(ok.status===200&&ok.headers.get("content-type")==="image/png","media served with correct mime");
    const buf=Buffer.from(await ok.arrayBuffer());
    assert(buf.equals(TINY_PNG),"media bytes match generated image");
    const traversal=await fetch(`http://127.0.0.1:${corePort}/media/..%2F..%2Fetc%2Fpasswd`,{headers:{authorization:`Bearer ${key}`}});
    assert(traversal.status===404,"path traversal rejected");
    const bogus=await fetch(`http://127.0.0.1:${corePort}/media/00000000-0000-0000-0000-000000000000`,{headers:{authorization:`Bearer ${key}`}});
    assert(bogus.status===404,"unknown media id 404");
  }

  console.log("\nPASS ComfyUI Module e2e: workflow template submission, status polling, media store persistence, authenticated /media serving, traversal blocked");
}catch(e){throw e;}finally{
  comfy.close();
  fs.rmSync(tmp,{recursive:true,force:true});
  for(const p of [...children].reverse()){try{p.kill("SIGKILL");}catch{}}
  await sleep(100);
}
