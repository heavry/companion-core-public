import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-mcp-oauth-"));
const base=34800+Math.floor(Math.random()*200),oauthPort=base,corePort=base+1,key="mcp-oauth-test-key-long-random";
const origin=`http://127.0.0.1:${oauthPort}`,mcpUrl=`${origin}/mcp`,token="mock-oauth-access-token-never-echo";
const children=[];let registrations=0,tokenExchanges=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(value,message)=>{if(!value)throw new Error(`ASSERT: ${message}`);};
async function wait(url){for(let i=0;i<160;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}
const send=(res,status,value,headers={})=>{res.writeHead(status,{"content-type":"application/json",...headers});res.end(JSON.stringify(value));};

const oauthServer=http.createServer((req,res)=>{
  const url=new URL(req.url??"/",origin),chunks=[];
  req.on("data",chunk=>chunks.push(chunk));req.on("end",()=>{
    const body=Buffer.concat(chunks).toString("utf8");
    if(req.method==="GET"&&url.pathname==="/.well-known/oauth-protected-resource/mcp")return send(res,200,{resource:mcpUrl,authorization_servers:[origin],scopes_supported:["mcp"]});
    if(req.method==="GET"&&url.pathname==="/.well-known/oauth-authorization-server")return send(res,200,{
      issuer:origin,authorization_endpoint:`${origin}/authorize`,token_endpoint:`${origin}/token`,registration_endpoint:`${origin}/register`,
      response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],
      code_challenge_methods_supported:["S256"],token_endpoint_auth_methods_supported:["none"]
    });
    if(req.method==="POST"&&url.pathname==="/register"){
      registrations+=1;
      return send(res,201,{...JSON.parse(body||"{}"),client_id:"mock-dcr-client",client_id_issued_at:Math.floor(Date.now()/1000)});
    }
    if(req.method==="POST"&&url.pathname==="/token"){tokenExchanges+=1;return send(res,200,{access_token:token,token_type:"Bearer",expires_in:3600,refresh_token:"mock-refresh-token-never-echo"});}
    if(url.pathname==="/mcp"){
      if(req.headers.authorization!==`Bearer ${token}`)return send(res,401,{error:"unauthorized"},{"www-authenticate":`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`});
      if(req.method==="GET"){res.writeHead(405);return res.end();}
      const rpc=JSON.parse(body||"{}");
      if(rpc.method==="initialize")return send(res,200,{jsonrpc:"2.0",id:rpc.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"mock-oauth-mcp",version:"1.0.0"}}});
      if(rpc.method==="notifications/initialized"){res.writeHead(202);return res.end();}
      if(rpc.method==="tools/list")return send(res,200,{jsonrpc:"2.0",id:rpc.id,result:{tools:[{name:"read_note",description:"Read a note without modifying it",inputSchema:{type:"object",properties:{id:{type:"string"}}}}]}});
      return send(res,200,{jsonrpc:"2.0",id:rpc.id,result:{}});
    }
    send(res,404,{error:"not_found"});
  });
});

const request=async(pathname,{method="GET",body}={})=>{
  const response=await fetch(`http://127.0.0.1:${corePort}${pathname}`,{method,headers:{authorization:`Bearer ${key}`,...(body?{"content-type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();let data=null;try{data=JSON.parse(text);}catch{}
  return {status:response.status,data,text};
};
const coreEnv={
  ...process.env,COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
  DATABASE_PATH:path.join(tmp,"companion.db"),PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",
  COMPANION_MODULES_DIR:path.join(tmp,"modules"),COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),
  COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"ledger.json"),COMPANION_MODULES_CONFIG_DIR:path.join(tmp,"modules-config"),
  COMPANION_SEARCH_CONFIG_PATH:path.join(tmp,"search-provider.json"),COMPANION_INTEGRATIONS_CONFIG_PATH:path.join(tmp,"integrations.json"),
  COMPANION_INTEGRATIONS_SECRETS_PATH:path.join(tmp,"integrations-secrets.json"),COMPANION_BLOCK_REAL_UPSTREAM:"1",
  UPSTREAM_BASE_URL:"",UPSTREAM_API_KEY:"",UPSTREAM_CHAT_BASE_URL:"",UPSTREAM_CHAT_API_KEY:"",UPSTREAM_AGENT_BASE_URL:"",UPSTREAM_AGENT_API_KEY:"",UPSTREAM_SUMMARY_BASE_URL:"",UPSTREAM_SUMMARY_API_KEY:"",UPSTREAM_PRIMARY_BASE_URL:"",UPSTREAM_PRIMARY_API_KEY:"",UPSTREAM_SECONDARY_BASE_URL:"",UPSTREAM_SECONDARY_API_KEY:""
};
function startCore(){
  const core=spawn(process.execPath,[path.join(root,"src/server.js")],{cwd:root,env:coreEnv,stdio:["ignore","ignore","pipe"]});
  core.stderr.on("data",data=>{if(!String(data).includes("ExperimentalWarning"))process.stderr.write(String(data).slice(0,400));});
  children.push(core);return core;
}
async function stopCore(core){
  if(!core||core.exitCode!==null)return;
  const exited=new Promise(resolve=>core.once("exit",resolve));
  core.kill("SIGKILL");await exited;
}
async function waitIntegration(id,status,toolsCount=null){
  for(let i=0;i<160;i++){
    const listed=await request("/admin/integrations");
    const row=listed.data?.data?.find(item=>item.id===id);
    if(row?.status===status&&(toolsCount===null||row.toolsCount===toolsCount))return row;
    await sleep(50);
  }
  throw new Error(`timeout waiting for integration ${id} status ${status}`);
}

try{
  await new Promise(resolve=>oauthServer.listen(oauthPort,"127.0.0.1",resolve));
  let core=startCore();
  await wait(`http://127.0.0.1:${corePort}/health`);

  const added=await request("/admin/integrations",{method:"POST",body:{name:"Mock OAuth MCP",type:"http",url:mcpUrl,authType:"oauth",availableToAgent:true,availableToChat:true}});
  assert(added.status===201&&added.data.authType==="oauth","OAuth integration created through generic model");
  const id=added.data.id;
  const start=await request(`/admin/integrations/${id}/oauth-start`,{method:"POST"});
  if(start.status!==200||start.data?.status!=="authorization_required")console.error(JSON.stringify({http:start.status,status:start.data?.status,error:start.data?.error,hasAuthorizationUrl:Boolean(start.data?.authorizationUrl)}));
  assert(start.status===200&&start.data.status==="authorization_required","OAuth discovery pauses for user authorization");
  assert(new URL(start.data.authorizationUrl).origin===origin,"authorization URL comes from discovered official server");
  assert(registrations===1,"dynamic client registration completed once");
  const authUrl=new URL(start.data.authorizationUrl),state=authUrl.searchParams.get("state");
  assert(state&&authUrl.searchParams.get("code_challenge"),"state and PKCE challenge present");

  const callback=await fetch(`http://127.0.0.1:${corePort}/mcp/oauth/callback?code=mock-code&state=${encodeURIComponent(state)}`);
  assert(callback.status===200&&tokenExchanges===1,"callback exchanges code exactly once");
  const listed=await request("/admin/integrations");
  const row=listed.data.data.find(item=>item.id===id);
  assert(row.status==="connected"&&row.oauthStatus==="authorized"&&row.toolsCount===1,"OAuth integration reconnects and discovers tools");
  assert(!listed.text.includes(token)&&!listed.text.includes("mock-refresh-token"),"Admin API never echoes OAuth tokens");
  const toolList=await request(`/admin/integrations/${id}/tools`);
  assert(toolList.data.data[0].displayName==="read_note"&&toolList.data.data[0].riskLevel==="low","read-only OAuth tool normalized through Capability Registry");
  const secretsPath=path.join(tmp,"integrations-secrets.json"),mode=fs.statSync(secretsPath).mode&0o777;
  assert(mode===0o600&&fs.readFileSync(secretsPath,"utf8").includes(token),"OAuth tokens exist only in 0600 integration secret store");
  const invalid=await fetch(`http://127.0.0.1:${corePort}/mcp/oauth/callback?code=other&state=invalid`);
  assert(invalid.status===400,"invalid callback state fails closed");

  // 进程重启后应从安全存储恢复 OAuth token，不重新注册或交换 token。
  await stopCore(core);core=startCore();await wait(`http://127.0.0.1:${corePort}/health`);
  const restored=await waitIntegration(id,"connected",1);
  assert(restored.oauthStatus==="authorized"&&restored.toolsCount===1,"OAuth state restores after Core restart");
  assert(registrations===1&&tokenExchanges===1,"OAuth restore reuses persisted client and token state");

  // 单个 integration secret 不可用时，只降级该 integration，Core 仍健康。
  await stopCore(core);fs.rmSync(secretsPath,{force:true});core=startCore();await wait(`http://127.0.0.1:${corePort}/health`);
  const unavailable=await waitIntegration(id,"authorization_required");
  assert(unavailable.toolsCount===0,"missing integration secret exposes no stale tools");
  assert((await request("/health")).status===200,"missing integration secret does not affect Core health");
  console.log("\nPASS MCP OAuth: discovery, DCR, PKCE/state, callback exchange, secure token store, restart restore, integration-only secret failure, reconnect/tool discovery, invalid-state rejection");
}finally{
  try{oauthServer.close();}catch{}
  for(const child of children)try{child.kill("SIGKILL");}catch{}
  fs.rmSync(tmp,{recursive:true,force:true});await sleep(100);
}
