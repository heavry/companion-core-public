import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-mcp-server-"));
const base=34900+Math.floor(Math.random()*300),corePort=base+1,key="mcp-server-test-key-long-random";
const children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(value,message)=>{if(!value)throw new Error(`ASSERT: ${message}`);};
async function wait(url){for(let i=0;i<160;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}

function startCore(){
  const child=spawn(process.execPath,[path.join(root,"src/server.js")],{cwd:root,env:{
    ...process.env,COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
    DATABASE_PATH:path.join(tmp,"companion.db"),PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",
    COMPANION_STATE_PATH:path.join(tmp,"companion-state.json"),COMPANION_BEHAVIOR_PATH:path.join(tmp,"companion-behavior.json"),COMPANION_AUTONOMOUS_LIFE_STATE_PATH:path.join(tmp,"autonomous-life.json"),
    COMPANION_MODULES_DIR:path.join(tmp,"modules"),COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),
    COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"ledger.json"),COMPANION_MODULES_CONFIG_DIR:path.join(tmp,"modules-config"),
    COMPANION_SEARCH_CONFIG_PATH:path.join(tmp,"search-provider.json"),
    COMPANION_INTEGRATIONS_CONFIG_PATH:path.join(tmp,"integrations.json"),
    COMPANION_INTEGRATIONS_SECRETS_PATH:path.join(tmp,"integrations-secrets.json"),
    UPSTREAM_BASE_URL:"",UPSTREAM_API_KEY:"",UPSTREAM_CHAT_MODEL:"",UPSTREAM_AGENT_MODEL:"",UPSTREAM_SUMMARY_MODEL:"",
    UPSTREAM_CHAT_BASE_URL:"",UPSTREAM_CHAT_API_KEY:"",UPSTREAM_AGENT_BASE_URL:"",UPSTREAM_AGENT_API_KEY:"",UPSTREAM_SUMMARY_BASE_URL:"",UPSTREAM_SUMMARY_API_KEY:"",
    UPSTREAM_PRIMARY_BASE_URL:"",UPSTREAM_PRIMARY_API_KEY:"",UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:"",
    COMPANION_BLOCK_REAL_UPSTREAM:"1"
  },stdio:["ignore","ignore","pipe"]});
  child.stderr.on("data",data=>{if(!String(data).includes("ExperimentalWarning"))process.stderr.write(String(data).slice(0,300));});
  children.push(child);return child;
}

async function withStdioClient(fn){
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,"src/mcp/server.js"),"--stdio"],env:{
    COMPANION_VERSION:"test",
    DATABASE_PATH:path.join(tmp,"companion.db"),PERSONA_SYNC_ON_START:"false",EMBEDDING_ENABLED:"false",
    COMPANION_STATE_PATH:path.join(tmp,"companion-state.json"),COMPANION_BEHAVIOR_PATH:path.join(tmp,"companion-behavior.json"),COMPANION_AUTONOMOUS_LIFE_STATE_PATH:path.join(tmp,"autonomous-life.json"),
    COMPANION_MODULES_DIR:path.join(tmp,"modules"),COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),
    COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"ledger.json"),COMPANION_MODULES_CONFIG_DIR:path.join(tmp,"modules-config"),
    COMPANION_SEARCH_CONFIG_PATH:path.join(tmp,"search-provider.json"),
    COMPANION_INTEGRATIONS_CONFIG_PATH:path.join(tmp,"integrations.json"),
    COMPANION_INTEGRATIONS_SECRETS_PATH:path.join(tmp,"integrations-secrets.json"),
    COMPANION_BLOCK_REAL_UPSTREAM:"1",UPSTREAM_BASE_URL:"",UPSTREAM_API_KEY:"",UPSTREAM_CHAT_MODEL:"",UPSTREAM_AGENT_MODEL:"",UPSTREAM_SUMMARY_MODEL:"",
    UPSTREAM_CHAT_BASE_URL:"",UPSTREAM_CHAT_API_KEY:"",UPSTREAM_AGENT_BASE_URL:"",UPSTREAM_AGENT_API_KEY:"",UPSTREAM_SUMMARY_BASE_URL:"",UPSTREAM_SUMMARY_API_KEY:"",
    UPSTREAM_PRIMARY_BASE_URL:"",UPSTREAM_PRIMARY_API_KEY:"",UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:"",UPSTREAM_SECONDARY_MODEL:""
  }});
  const client=new Client({name:"test-client",version:"1.0.0"},{capabilities:{}});
  try{
    await client.connect(transport);
    return await fn(client);
  }finally{
    try{await client.close();}catch{}
  }
}

try{
  const core=startCore();await wait(`http://127.0.0.1:${corePort}/health`);

  // ---- stdio transport ----
  await withStdioClient(async client=>{
    const tools=await client.listTools();
    const names=(tools.tools??[]).map(t=>t.name);
    assert(names.includes("companion.memory.search")&&names.includes("companion.memory.add")&&names.includes("companion.weather.current")&&names.includes("companion.followup.create")&&names.includes("companion.followup.list")&&names.includes("companion.web.search")&&names.includes("companion.modules.list"),`all 7 safe tools exposed: ${names.join(",")}`);
    assert(!names.some(n=>n.includes("db")||n.includes("shell")||n.includes("env")||n.includes("admin")),"no dangerous tools exposed");

    const memory=await client.callTool({name:"companion.memory.search",arguments:{query:"用户偏好"}});
    assert(!memory.isError&&typeof memory.content?.[0]?.text==="string","memory search returns text");

    const added=await client.callTool({name:"companion.memory.add",arguments:{content:"用户喜欢在天津生活"}});
    assert(!added.isError,"memory add via staging works");
    assert(String(added.content?.[0]?.text??"").includes("staging"),"add goes through Memory Policy staging");
    // staging → active 需经 policy 晋升（这里用 admin API 模拟审核通过）
    const memoryId=String(added.content?.[0]?.text??"").match(/id=([a-z0-9-]+)/)?.[1];
    assert(Boolean(memoryId),"staging memory id returned");
    const promoted=await fetch(`http://127.0.0.1:${corePort}/admin/memories/${memoryId}`,{method:"PATCH",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify({status:"active"})});
    assert(promoted.ok,"memory promoted to active via policy review");
    const search=await client.callTool({name:"companion.memory.search",arguments:{query:"天津生活"}});
    assert(String(search.content?.[0]?.text??"").includes("天津"),`promoted memory searchable: ${String(search.content?.[0]?.text??"").slice(0,150)}`);

    const followup=await client.callTool({name:"companion.followup.create",arguments:{topic:"回访天津天气话题"}});
    assert(!followup.isError,"followup create works");
    const list=await client.callTool({name:"companion.followup.list",arguments:{}});
    assert(String(list.content?.[0]?.text??"").includes("回访天津天气话题"),"followup list shows created item");

    const unknown=await client.callTool({name:"companion_admin_dump",arguments:{}});
    assert(unknown.isError,"unknown/dangerous tool rejected");

    const webSearch=await client.callTool({name:"companion.web.search",arguments:{query:"test"}});
    assert(webSearch.isError&&String(webSearch.content?.[0]?.text).includes("未配置"),"web search honest when provider unconfigured");

    const modulesInfo=await client.callTool({name:"companion.modules.list",arguments:{}});
    assert(!modulesInfo.isError,"modules list works");
    assert(!JSON.stringify(modulesInfo).toLowerCase().includes("apikey"),"no api key material in modules list");
  });

  // ---- HTTP transport：鉴权 ----
  const mcpUrl=`http://127.0.0.1:${corePort}/mcp`;
  const post=async(body,token)=>fetch(mcpUrl,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  const unauth=await post({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"x",version:"1"}}});
  assert(unauth.status===401,"unauthenticated MCP HTTP rejected");

  const init=await post({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"x",version:"1"}}},key);
  assert(init.status===200,"authenticated initialize ok");
  const initText=await init.text();
  const jsonStart=initText.indexOf("{");
  const initPayload=JSON.parse(initText.slice(jsonStart));
  assert(initPayload.result?.serverInfo?.name==="companion-core","server info returned");

  const inited=initPayload.id;
  const listed=await post({jsonrpc:"2.0",id:2,method:"tools/list",params:{}},key);
  assert(listed.status===200,"tools/list over HTTP ok");
  assert(!JSON.stringify(await listed.clone().text()).includes(key),"no secret echo over MCP HTTP");

  const wrongToken=await post({jsonrpc:"2.0",id:3,method:"tools/list",params:{}},key+"x");
  assert(wrongToken.status===401,"wrong token rejected");

  // ---- admin 可见性 ----
  const status=await fetch(`http://127.0.0.1:${corePort}/admin/mcp-server`,{headers:{authorization:`Bearer ${key}`}});
  const statusData=await status.json();
  assert(statusData.http_enabled===true&&statusData.http_path==="/mcp","admin mcp-server status");
  assert(statusData.tools_exposed.length===7,"admin reports 7 exposed tools");
  assert(!JSON.stringify(statusData).includes(key),"admin status does not leak the token");

  console.log("\nPASS MCP Server: stdio+HTTP transports, 7 safe tools, auth 401, staging memory policy, honest web-search state, no dangerous tools, no secret echo");
}catch(e){
  console.error(e);
  process.exitCode=1;
}finally{
  for(const child of [...children].reverse())try{child.kill("SIGKILL");}catch{}
  fs.rmSync(tmp,{recursive:true,force:true});
  await sleep(100);
}
