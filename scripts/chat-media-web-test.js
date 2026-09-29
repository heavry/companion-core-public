import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-chat-media-"));
const base=33700+Math.floor(Math.random()*300),mockPort=base,corePort=base+1,key="chat-media-test-key-long-random";
const dbPath=path.join(tmp,"companion.db"),children=[];
const TINY_PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(value,message)=>{if(!value)throw new Error(`ASSERT: ${message}`);};
async function wait(url){for(let i=0;i<160;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}

const upstreamBodies=[];
const mock=http.createServer((req,res)=>{
  if(req.url==="/health"){res.writeHead(200);return res.end("ok");}
  let raw="";req.on("data",chunk=>raw+=chunk);req.on("end",()=>{
    const body=JSON.parse(raw||"{}");upstreamBodies.push(body);
    const text=JSON.stringify(body.messages??[]);
    if(text.includes("UNSUPPORTED_IMAGE")){res.writeHead(415,{"content-type":"application/json"});return res.end(JSON.stringify({error:{message:"vision unavailable"}}));}
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({choices:[{message:{role:"assistant",content:"mock reply"}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  });
});
function startCore(){
  const child=spawn(process.execPath,[path.join(root,"src/server.js")],{cwd:root,env:{
    ...process.env,COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
    DATABASE_PATH:dbPath,PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",
    COMPANION_MODULES_DIR:path.join(tmp,"modules"),COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),
    COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"ledger.json"),COMPANION_MODULES_CONFIG_DIR:path.join(tmp,"modules-config"),
    COMPANION_SEARCH_CONFIG_PATH:path.join(tmp,"search-provider.json"),
    COMPANION_INTEGRATIONS_CONFIG_PATH:path.join(tmp,"integrations.json"),
    COMPANION_INTEGRATIONS_SECRETS_PATH:path.join(tmp,"integrations-secrets.json"),
    UPSTREAM_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_API_KEY:"",UPSTREAM_CHAT_MODEL:"mock-chat",UPSTREAM_AGENT_MODEL:"mock-agent",UPSTREAM_SUMMARY_MODEL:"mock-summary",
    UPSTREAM_CHAT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_CHAT_API_KEY:"",UPSTREAM_AGENT_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_AGENT_API_KEY:"",UPSTREAM_SUMMARY_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,UPSTREAM_SUMMARY_API_KEY:"",
    UPSTREAM_PRIMARY_BASE_URL:"",UPSTREAM_PRIMARY_API_KEY:"",UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:"",
    COMPANION_BLOCK_REAL_UPSTREAM:"1"
  },stdio:["ignore","ignore","pipe"]});
  child.stderr.on("data",data=>{if(!String(data).includes("ExperimentalWarning"))process.stderr.write(String(data).slice(0,400));});
  children.push(child);return child;
}
const request=async(pathname,{method="GET",headers={},body}={})=>{
  const response=await fetch(`http://127.0.0.1:${corePort}${pathname}`,{method,headers:{authorization:`Bearer ${key}`,...headers},body});
  const buffer=Buffer.from(await response.arrayBuffer());let data=null;try{data=JSON.parse(buffer.toString("utf8"));}catch{}
  return {status:response.status,headers:response.headers,buffer,data,text:buffer.toString("utf8")};
};
const chat=async(text,{session="chat:default",mediaId=null,webEnabled=false}={})=>{
  const content=mediaId?[{type:"text",text},{type:"image_url",image_url:{url:`companion-media://${mediaId}`}}]:text;
  return request("/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json","x-companion-source":"chat","x-companion-session":session},body:JSON.stringify({model:"yuna-chat",messages:[{role:"user",content}],metadata:{webEnabled}})});
};

try{
  await new Promise(resolve=>mock.listen(mockPort,"127.0.0.1",resolve));
  let core=startCore();await wait(`http://127.0.0.1:${corePort}/health`);

  const unauth=await fetch(`http://127.0.0.1:${corePort}/media/upload`,{method:"POST",headers:{"content-type":"image/png"},body:TINY_PNG});
  assert(unauth.status===401,"upload requires authentication");
  assert((await request("/media/upload",{method:"POST",headers:{"content-type":"text/plain"},body:Buffer.from("not image")})).status===415,"MIME whitelist rejects text");
  assert((await request("/media/upload",{method:"POST",headers:{"content-type":"image/png"},body:Buffer.from("not png")})).status===400,"fake PNG is decode-rejected");
  assert((await request("/media/upload",{method:"POST",headers:{"content-type":"image/png"},body:Buffer.alloc(10*1024*1024+1)})).status===413,"upload over 10 MB rejected");

  const uploaded=await request("/media/upload",{method:"POST",headers:{"content-type":"image/png","x-companion-filename":encodeURIComponent("../../测试.png")},body:TINY_PNG});
  assert(uploaded.status===201&&uploaded.data.width===1&&uploaded.data.height===1,"valid PNG decoded and uploaded");
  assert(uploaded.data.filename==="测试.png"&&!uploaded.data.url.includes(".."),"filename and URL are traversal-safe");
  const mediaId=uploaded.data.media_id;
  const served=await request(`/media/${mediaId}`);
  assert(served.status===200&&served.headers.get("content-type")==="image/png"&&served.buffer.equals(TINY_PNG),"uploaded bytes rehydrate through authenticated media endpoint");
  assert((await request("/media/..%2F..%2Fetc%2Fpasswd")).status===404,"media traversal rejected");

  const caps=await request("/v1/capabilities");
  assert(caps.status===200&&caps.data.web_search.configured===false&&caps.data.web_search.reason==="未配置联网搜索","web capability is honest about missing backend");
  const webOn=await chat("联网查一下",{webEnabled:true});
  assert(webOn.status===409&&webOn.data.error.code==="web_search_unconfigured"&&upstreamBodies.length===0,"web on fails explicitly without a fake upstream call");

  const textReply=await chat("hello",{webEnabled:false});
  assert(textReply.status===200,"first text message creates session and returns assistant");
  assert(upstreamBodies.length===1&&upstreamBodies[0].metadata===undefined,"internal web metadata is not leaked upstream when off");
  const visionReply=await chat("what is this",{mediaId});
  assert(visionReply.status===200,"multimodal request succeeds through mock provider");
  const imageUrl=upstreamBodies.at(-1).messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(p=>p.type==="image_url")?.image_url?.url;
  assert(String(imageUrl).startsWith("data:image/png;base64,"),"media id is materialized to upstream image data");
  const unsupported=await chat("UNSUPPORTED_IMAGE",{mediaId,session:"vision-unsupported"});
  assert(unsupported.status===422&&unsupported.data.error.code==="vision_not_supported","unsupported provider produces explicit vision error");

  const isolated=await chat("other session",{session:"chat:other"});
  assert(isolated.status===200,"second session succeeds");
  const conversations=(await request("/admin/conversations?source=chat&limit=50")).data.data;
  assert(conversations.length===3,"chat sessions remain isolated, including failed vision session");
  const primary=conversations.find(item=>item.external_key==="chat:default"),other=conversations.find(item=>item.external_key==="chat:other");
  const primaryMessages=(await request(`/admin/conversations/${primary.id}/messages`)).data.data;
  const otherMessages=(await request(`/admin/conversations/${other.id}/messages`)).data.data;
  assert(primaryMessages.length===4&&otherMessages.length===2,"user and assistant messages persist in the intended conversations");
  assert(primaryMessages.some(message=>message.attachments?.some(item=>item.mediaId===mediaId)),"history API rehydrates image attachment metadata");
  assert(otherMessages.every(message=>!String(message.content_text).includes("what is this")),"conversation histories never merge");

  const {DatabaseSync}=await import("node:sqlite");
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const row=db.prepare("SELECT content_json FROM messages WHERE content_json LIKE '%companion-media://%' LIMIT 1").get();
    assert(row&&row.content_json.includes(mediaId)&&!row.content_json.includes("data:image")&&!row.content_json.includes(TINY_PNG.toString("base64")),"SQLite stores media id metadata, never image base64");
  }finally{db.close();}

  core.kill("SIGTERM");for(let i=0;i<80&&core.exitCode===null;i++)await sleep(25);
  core=startCore();await wait(`http://127.0.0.1:${corePort}/health`);
  const afterRestart=await request(`/admin/conversations/${primary.id}/messages`);
  const mediaAfterRestart=await request(`/media/${mediaId}`);
  assert(afterRestart.status===200&&afterRestart.data.data.length===4&&mediaAfterRestart.buffer.equals(TINY_PNG),"messages and uploaded media persist across Core restart");

  console.log("\nPASS Chat + Media + Web: first-session persistence, auth/MIME/size/decode/traversal guards, multimodal materialization, explicit unsupported vision/web states, history rehydration, restart persistence, and session isolation");
}finally{
  mock.close();
  for(const child of [...children].reverse())try{child.kill("SIGKILL");}catch{}
  fs.rmSync(tmp,{recursive:true,force:true});
  await sleep(100);
}
