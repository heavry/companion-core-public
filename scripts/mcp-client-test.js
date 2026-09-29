import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-mcp-client-"));
const base=34500+Math.floor(Math.random()*300),mockPort=base,corePort=base+1,key="mcp-client-test-key-long-random";
const mockServerPath=path.join(root,"scripts/fixtures/mock-mcp-server.js");
const children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(value,message)=>{if(!value)throw new Error(`ASSERT: ${message}`);};
async function wait(url){for(let i=0;i<160;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}

let lastUpstreamBody=null;
const upstreamBodies=[];
const mockUpstream=http.createServer((req,res)=>{
  let raw="";req.on("data",c=>raw+=c);req.on("end",()=>{
    lastUpstreamBody=JSON.parse(raw||"{}");
    upstreamBodies.push(lastUpstreamBody);
    // 用户消息可内嵌指令 JSON：{"__call":"<wireName>","args":{...}} → 返回工具调用
    const lastUser=[...(lastUpstreamBody?.messages??[])].reverse().find(m=>m?.role==="user");
    const text=typeof lastUser?.content==="string"?lastUser.content:"";
    const hasToolResult=JSON.stringify(lastUpstreamBody?.messages??[]).includes("外部工具输出开始");
    const directiveStart=text.indexOf('{"__call"');
    const isCompat=lastUpstreamBody?.response_format?.type==="json_object"; // agent compat 路径
    const reply=message=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));};
    if(!isCompat){
      // daily 原生 OpenAI tool_calls 形态
      if(directiveStart>=0&&lastUpstreamBody.tool_choice!=="none"){
        try{
          const d=JSON.parse(text.slice(directiveStart).trim());
          if(!hasToolResult||d.__repeat===true)return reply({role:"assistant",content:null,tool_calls:[{id:`call_daily_${upstreamBodies.length}`,type:"function",function:{name:d.__call,arguments:JSON.stringify(d.args??{})}}]});
        }catch{}
      }
      return reply({role:"assistant",content:"好的，已完成。"});
    }
    let decision={type:"final_answer",content:"mock final"};
    if(directiveStart>=0&&!hasToolResult){try{const d=JSON.parse(text.slice(directiveStart).trim());decision={type:"tool_call",name:d.__call,arguments:d.args??{}};}catch{}}
    reply({role:"assistant",content:JSON.stringify(decision)});
  });
});

function startCore(){
  const child=spawn(process.execPath,[path.join(root,"src/server.js")],{cwd:root,env:{
    ...process.env,PATH:"/usr/bin:/bin",COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
    DATABASE_PATH:path.join(tmp,"companion.db"),PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",
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
  return {status:response.status,data,text:buffer.toString("utf8")};
};

try{
  await new Promise(resolve=>mockUpstream.listen(mockPort,"127.0.0.1",resolve));
  startCore();await wait(`http://127.0.0.1:${corePort}/health`);

  // 1) 添加 stdio integration（env secret 单独存放）
  const add=await request("/admin/integrations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Mock MCP",type:"stdio",command:"node",args:[mockServerPath],env:{MOCK_TOKEN:"super-secret-token-9876"}})});
  assert(add.status===201&&add.data.id,"integration created");
  const integrationId=add.data.id;
  assert(add.data.status==="disconnected"&&!add.text.includes("super-secret-token"),"create response has no secret");
  const listEmpty=await request("/admin/integrations");
  assert(!listEmpty.text.includes("super-secret-token"),"list never echoes env secret values");
  assert(listEmpty.data.data[0].envKeys.includes("MOCK_TOKEN"),"envKeys exposed (names only)");

  // 2) Test connection：连接 + 发现 6 个工具
  const test=await request(`/admin/integrations/${integrationId}/test`,{method:"POST"});
  assert(test.status===200&&test.data.ok===true&&test.data.toolsCount===6,"restricted Finder PATH still resolves node and discovers 6 tools");
  assert((await request("/admin/integrations")).data.data[0].toolsCount===6,"discovered tool metadata remains visible after test disconnect");

  // 3) 持久连接 + 工具列表（normalize + risk 标记）
  const connect=await request(`/admin/integrations/${integrationId}/connect`,{method:"POST"});
  assert(connect.status===200&&connect.data.status==="connected","persistent connect");
  const tools=(await request(`/admin/integrations/${integrationId}/tools`)).data.data;
  assert(tools.length===6,"tools listed");
  const echo=tools.find(t=>t.displayName==="echo"),del=tools.find(t=>t.displayName==="delete_everything"),external=tools.find(t=>t.displayName==="mutate_external");
  assert(echo?.wireName===`mcp_${integrationId}_echo`,"wire name namespaced");
  assert(del?.riskLevel==="high","delete tool marked high risk");
  assert(echo?.riskLevel==="low","echo tool low risk");
  assert(external?.riskLevel==="high"&&external?.permissions.includes("write")&&external?.permissions.includes("external_action"),"server-declared non-read-only tool requires Action Intent");

  // 4) Agent 路径：MCP 工具进入候选并真实执行（mock upstream 决策 + untrusted 包裹）
  const agentChat=async (wireName,args)=>request("/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json","x-companion-source":"opencode","x-companion-session":"mcp-agent-test"},body:JSON.stringify({model:"yuna-agent",messages:[{role:"user",content:`请调用工具 ${JSON.stringify({__call:wireName,args})}`}]})});
  const echoCall=await agentChat(echo.wireName,{text:"hello-from-model"});
  assert(echoCall.status===200,`agent mcp tool call roundtrip ok: ${echoCall.status} ${JSON.stringify(echoCall.data).slice(0,250)}`);
  assert(String(echoCall.data.choices?.[0]?.message?.content??"").includes("mock final"),"compat flow completes after tool execution");
  const sessionList=(await request("/admin/conversations?source=opencode&limit=20")).data.data;
  const conv=sessionList.find(c=>c.external_key==="mcp-agent-test");
  const rows=(await request(`/admin/conversations/${conv.id}/messages`)).data.data;
  const toolRow=rows.find(r=>r.role==="tool");
  assert(Boolean(toolRow)&&toolRow.content_text.includes("hello-from-model"),"mcp tool result persisted");
  assert(toolRow.content_text.includes("不可信外部数据"),"mcp tool result wrapped as untrusted");
  assert(!rows.some(r=>String(r.content_text??"").includes("super-secret-token")),"no env secret in stored history");
  const upstreamToolText=JSON.stringify(lastUpstreamBody?.messages??[]);
  assert(upstreamToolText.includes("外部工具输出开始")||upstreamToolText.includes("先前工具调用"),"untrusted wrapper reaches upstream context");

  // integration 自己回显 secret 时也必须按 secret reference 精确遮罩。
  const secretTool=tools.find(t=>t.displayName==="secret_echo");
  const secretCall=await agentChat(secretTool.wireName,{});
  assert(secretCall.status===200,"secret echo mock call completes");
  const secretRows=(await request(`/admin/conversations/${conv.id}/messages`)).data.data;
  assert(!JSON.stringify(secretRows).includes("super-secret-token-9876"),"integration secret values redacted from tool output and history");

  // 高风险工具：仅提到/伪造工具名不足以执行；明确匹配的删除 Action Intent 才能通过现有确认语义。
  const implicitDanger=await agentChat(del.wireName,{});
  assert(implicitDanger.status===502||implicitDanger.data.decision?.type!=="tool_call","high-risk tool blocked without explicit matching action intent");
  const explicitDanger=await request("/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json","x-companion-source":"opencode","x-companion-session":"mcp-risk-test"},body:JSON.stringify({model:"yuna-agent",messages:[{role:"user",content:`请删除测试数据，并调用 ${JSON.stringify({__call:del.wireName,args:{}})}`}]})});
  assert(explicitDanger.status===200&&String(explicitDanger.data.choices?.[0]?.message?.content??"").includes("mock final"),"explicit matching delete intent authorizes harmless high-risk mock");

  // 5) per-tool deny：deny 后工具不进入候选
  const echoCapId=echo.id;
  await request(`/admin/integrations/${integrationId}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({toolPolicy:{[echoCapId]:"deny"}})});
  const deniedCall=await agentChat(echo.wireName,{text:"should-not-run"});
  assert(deniedCall.status===502||deniedCall.data.decision?.type!=="tool_call"||!String(deniedCall.data.decision?.name??"").includes("echo"),"denied tool rejected");
  await request(`/admin/integrations/${integrationId}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({toolPolicy:{[echoCapId]:"allow"}})});

  // 6) 禁用 integration：工具全部退出候选
  await request(`/admin/integrations/${integrationId}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:false})});
  const disabledCall=await agentChat(echo.wireName,{text:"disabled"});
  assert(disabledCall.status===502||disabledCall.data.decision?.type!=="tool_call","disabled integration removes tools from agent candidates");
  await request(`/admin/integrations/${integrationId}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:true})});

  // 7) daily chat 默认无 MCP 工具（availableToChat=false）
  const daily=await request("/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json","x-companion-source":"chat","x-companion-session":"chat:default"},body:JSON.stringify({model:"yuna-chat",messages:[{role:"user",content:"你好"}]})});
  assert(daily.status===200&&lastUpstreamBody.tools===undefined,"daily chat has no MCP tools by default");
  assert(lastUpstreamBody.metadata===undefined,"no metadata leak");

  const casualAgent=await request("/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json","x-companion-source":"opencode","x-companion-session":"mcp-casual-test"},body:JSON.stringify({model:"yuna-agent",messages:[{role:"user",content:"今天好累"}]})});
  assert(casualAgent.status===200&&!JSON.stringify(lastUpstreamBody.messages??[]).includes(`mcp_${integrationId}_`),"casual agent chat exposes zero MCP schemas");

  // 8) availableToChat=true → daily chat 获得工具并可执行
  const addTool=tools.find(t=>t.displayName==="add_numbers");
  await request(`/admin/integrations/${integrationId}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({availableToChat:true})});
  const dailyMcp=await request("/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json","x-companion-source":"chat","x-companion-session":"chat:default"},body:JSON.stringify({model:"yuna-chat",messages:[{role:"user",content:`计算一下 ${JSON.stringify({__call:addTool.wireName,args:{a:2,b:3}})}`}]})});
  assert(dailyMcp.status===200,"daily chat with opt-in mcp ok");
  assert(Array.isArray(lastUpstreamBody.tools)&&lastUpstreamBody.tools.some(t=>t.function?.name===addTool.wireName),"opt-in tools injected into daily chat");
  const dailyRows=(await request(`/admin/conversations/${(await request("/admin/conversations?source=chat&limit=20")).data.data.find(c=>c.external_key==="chat:default").id}/messages`)).data.data;
  assert(dailyRows.some(r=>r.role==="tool"&&String(r.content_text).includes("5")),"daily mcp tool executed (2+3=5)");
  const activityCall=dailyRows.find(r=>r.role==="assistant"&&r.tool_activities?.some(a=>a.display_name==="add_numbers"));
  const activityCallId=activityCall?.tool_activities?.find(a=>a.display_name==="add_numbers")?.call_id;
  const activityResult=dailyRows.find(r=>r.role==="tool"&&r.tool_activities?.some(a=>a.call_id===activityCallId));
  assert(activityCall?.tool_activities?.[0]?.integration_name==="Mock MCP"&&activityCall.tool_activities[0].display_name==="add_numbers","history API resolves friendly integration/tool metadata from MCP registry");
  assert(activityResult?.tool_activities?.[0]?.status==="success","history tool result maps to success with the same call id");
  assert(!JSON.stringify([activityCall?.tool_activities,activityResult?.tool_activities]).includes("super-secret-token"),"history Tool Activity metadata never contains integration secrets");

  // 达到工具轮次上限后必须强制生成文字答复，不能把待调用 tool_calls 当最终响应。
  const repeatSession="chat:mcp-repeat-final";
  const repeatStart=upstreamBodies.length;
  const repeated=await request("/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json","x-companion-source":"chat","x-companion-session":repeatSession},body:JSON.stringify({model:"yuna-chat",messages:[{role:"user",content:`计算并完成 ${JSON.stringify({__call:addTool.wireName,args:{a:2,b:3},__repeat:true})}`}]})});
  const repeatBodies=upstreamBodies.slice(repeatStart);
  assert(repeated.status===200&&repeated.data.choices?.[0]?.message?.content==="好的，已完成。","daily tool loop ends with a text answer after reaching the round cap");
  assert(repeatBodies.at(-1)?.tool_choice==="none","final synthesis round explicitly disables further tool calls");
  const repeatConv=(await request("/admin/conversations?source=chat&limit=20")).data.data.find(c=>c.external_key===repeatSession);
  const repeatRows=(await request(`/admin/conversations/${repeatConv.id}/messages`)).data.data;
  assert(repeatRows.filter(r=>r.role==="tool").length===2,"tool execution remains bounded by configured maximum rounds");
  await request(`/admin/integrations/${integrationId}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({availableToChat:false})});

  // 9) 断开连接：状态回 disconnected，App 不 crash
  await request(`/admin/integrations/${integrationId}/disconnect`,{method:"POST"});
  const afterDisconnect=(await request("/admin/integrations")).data.data[0];
  assert(afterDisconnect.status==="disconnected","disconnect reports cleanly");
  const disconnectedHistory=(await request(`/admin/conversations/${(await request("/admin/conversations?source=chat&limit=20")).data.data.find(c=>c.external_key==="chat:default").id}/messages`)).data.data;
  const disconnectedActivity=disconnectedHistory.find(r=>r.tool_activities?.some(a=>a.call_id===activityCallId))?.tool_activities?.find(a=>a.call_id===activityCallId);
  assert(disconnectedActivity?.integration_name==="Mock MCP"&&disconnectedActivity?.display_name==="add_numbers","history keeps friendly MCP metadata before discovery/reconnect");
  const reconnected=await request(`/admin/integrations/${integrationId}/connect`,{method:"POST"});
  assert(reconnected.status===200&&reconnected.data.status==="connected","manual reconnect succeeds after disconnect");
  const health=await request("/health");
  assert(health.status===200,"core healthy after disconnect");

  // 10) 删除 integration：配置与 secrets 一并清除
  await request(`/admin/integrations/${integrationId}`,{method:"DELETE"});
  const afterDelete=(await request("/admin/integrations")).data.data;
  assert(afterDelete.length===0,"integration removed");
  const secretsRaw=fs.readFileSync(path.join(tmp,"integrations-secrets.json"),"utf8");
  assert(!secretsRaw.includes("super-secret-token"),"secrets purged on remove");

  console.log("\nPASS MCP Client: stdio connect/discover/normalize, wire namespacing, risk marking, agent execution with untrusted wrapping + ledger, per-tool deny, enable/disable isolation, daily-chat default-off + opt-in, disconnect safety, secret purge");
}finally{
  try{mockUpstream.close();}catch{}
  for(const child of [...children].reverse())try{child.kill("SIGKILL");}catch{}
  fs.rmSync(tmp,{recursive:true,force:true});
  await sleep(100);
}
