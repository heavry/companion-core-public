import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-web-search-"));
const base=34100+Math.floor(Math.random()*300),mockUpstreamPort=base,mockSearchPort=base+1,corePort=base+2,key="web-search-test-key-long-random",searchKey="tvly-mock-secret-key-123456";
const dbPath=path.join(tmp,"companion.db"),searchConfigPath=path.join(tmp,"search-provider.json"),children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(value,message)=>{if(!value)throw new Error(`ASSERT: ${message}`);};
async function wait(url){for(let i=0;i<160;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(50);}throw new Error(`timeout waiting for ${url}`);}
async function waitFor(fn,label){for(let i=0;i<200;i++){const value=await fn();if(value)return value;await sleep(25);}throw new Error(`timeout waiting for ${label}`);}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

const upstreamBodies=[];
const mockUpstream=http.createServer((req,res)=>{
  let raw="";req.on("data",chunk=>raw+=chunk);req.on("end",()=>{
    const body=JSON.parse(raw||"{}");upstreamBodies.push(body);
    const lastUser=[...(body.messages??[])].reverse().find(m=>m?.role==="user");
    const text=typeof lastUser?.content==="string"?lastUser.content:"";
    const hasToolResult=(body.messages??[]).some(m=>m?.role==="tool");
    if(body.stream){
      res.writeHead(200,{"content-type":"text/event-stream"});
      const send=value=>res.write(`data: ${typeof value==="string"?value:JSON.stringify(value)}\n\n`);
      if(text.includes("STREAM_ERROR")){send({error:{message:"mock stream provider failed"}});return res.end();}
      if(body.tools?.length&&!hasToolResult&&text.includes("STREAM_SEARCH")){
        send({id:"stream-1",model:"mock-chat",choices:[{index:0,delta:{role:"assistant",tool_calls:[{index:0,id:"stream-call",type:"function",function:{name:"web_",arguments:"{\"query\":\"今"}}]},finish_reason:null}]});
        send({id:"stream-1",model:"mock-chat",choices:[{index:0,delta:{tool_calls:[{index:0,function:{name:"search",arguments:"天天气\",\"max_results\":2}"}}]},finish_reason:null}]});
        send({id:"stream-1",model:"mock-chat",choices:[{index:0,delta:{},finish_reason:"tool_calls"}]});send("[DONE]");return res.end();
      }
      send({id:"stream-2",model:"mock-chat",choices:[{index:0,delta:{role:"assistant",content:"streamed "},finish_reason:null}]});
      send({id:"stream-2",model:"mock-chat",choices:[{index:0,delta:{content:"answer"},finish_reason:null}]});
      send({id:"stream-2",model:"mock-chat",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3}});send("[DONE]");return res.end();
    }
    if(body.tools?.length&&!hasToolResult&&text.includes("SEARCH")){
      res.writeHead(200,{"content-type":"application/json"});
      return res.end(JSON.stringify({choices:[{message:{role:"assistant",content:"",tool_calls:[{id:"call_1",type:"function",function:{name:"web_search",arguments:JSON.stringify({query:text.includes("HOLD_SEARCH")?"hold":"今天天气",max_results:3})}}]}}],usage:{prompt_tokens:2,completion_tokens:2,total_tokens:4}}));
    }
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({choices:[{message:{role:"assistant",content:"mock reply"}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  });
});

const searchHits=[],searchStarted=deferred(),releaseSearch=deferred();
const mockSearch=http.createServer((req,res)=>{
  let raw="";req.on("data",chunk=>raw+=chunk);req.on("end",async()=>{
    const body=JSON.parse(raw||"{}");searchHits.push(body);
    if(body.api_key!==searchKey){res.writeHead(401);return res.end("{}");}
    if(body.query==="hold"){searchStarted.resolve();await releaseSearch.promise;}
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({results:[
      {title:"天气结果 A",url:"https://weather.example.com/a",content:"A".repeat(600)},
      {title:"天气结果 B",url:"https://weather.example.com/b",content:"B 内容"},
      {title:"重复 URL",url:"https://weather.example.com/a#dup",content:"dup"},
      {title:"非法 URL",url:"javascript:alert(1)",content:"bad"}
    ]}));
  });
});

function startCore(){
  const child=spawn(process.execPath,[path.join(root,"src/server.js")],{cwd:root,env:{
    ...process.env,COMPANION_HOST:"127.0.0.1",COMPANION_PORT:String(corePort),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,
    DATABASE_PATH:dbPath,PERSONA_SYNC_ON_START:"true",EMBEDDING_ENABLED:"false",SUMMARY_EVERY_MESSAGES:"9999",
    COMPANION_MODULES_DIR:path.join(tmp,"modules"),COMPANION_MODULES_STATE_PATH:path.join(tmp,"modules-state.json"),
    COMPANION_MODULE_EXECUTION_LEDGER_PATH:path.join(tmp,"ledger.json"),COMPANION_MODULES_CONFIG_DIR:path.join(tmp,"modules-config"),
    COMPANION_SEARCH_CONFIG_PATH:searchConfigPath,
    TAVILY_BASE_URL:`http://127.0.0.1:${mockSearchPort}`,
    UPSTREAM_BASE_URL:`http://127.0.0.1:${mockUpstreamPort}/v1`,UPSTREAM_API_KEY:"",UPSTREAM_CHAT_MODEL:"mock-chat",UPSTREAM_AGENT_MODEL:"mock-agent",UPSTREAM_SUMMARY_MODEL:"mock-summary",
    UPSTREAM_CHAT_BASE_URL:`http://127.0.0.1:${mockUpstreamPort}/v1`,UPSTREAM_CHAT_API_KEY:"",UPSTREAM_AGENT_BASE_URL:`http://127.0.0.1:${mockUpstreamPort}/v1`,UPSTREAM_AGENT_API_KEY:"",UPSTREAM_SUMMARY_BASE_URL:`http://127.0.0.1:${mockUpstreamPort}/v1`,UPSTREAM_SUMMARY_API_KEY:"",
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
const chat=async(text,{session="chat:default",webEnabled=false,model="yuna-chat"}={})=>
  request("/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json","x-companion-source":"chat","x-companion-session":session},body:JSON.stringify({model,messages:[{role:"user",content:text}],metadata:{webEnabled}})});
const streamChat=async(text,{session="stream:default",webEnabled=true}={})=>{
  const response=await fetch(`http://127.0.0.1:${corePort}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json","x-companion-source":"chat","x-companion-session":session},body:JSON.stringify({model:"yuna-chat",stream:true,messages:[{role:"user",content:text}],metadata:{webEnabled}})});
  return {status:response.status,text:await response.text()};
};
const conversationByKey=async key=>(await request("/admin/conversations?source=chat&limit=100")).data.data.find(c=>c.external_key===key);
const guidance=async(sessionId,content)=>request(`/admin/sessions/${sessionId}/guidance`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({content})});

try{
  await new Promise(resolve=>mockUpstream.listen(mockUpstreamPort,"127.0.0.1",resolve));
  await new Promise(resolve=>mockSearch.listen(mockSearchPort,"127.0.0.1",resolve));
  const core=startCore();await wait(`http://127.0.0.1:${corePort}/health`);

  // 1) 未配置：诚实上报 + web on 显式 409
  let caps=(await request("/v1/capabilities")).data;
  assert(caps.web_search.configured===false&&caps.web_search.reason==="未配置联网搜索","unconfigured capability is honest");
  const early=await chat("SEARCH 需要联网",{webEnabled:true});
  assert(early.status===409&&early.data.error.code==="web_search_unconfigured"&&upstreamBodies.length===0,"web on fails explicitly without upstream call");

  // 2) 配置 Tavily（mock）→ 状态变为已配置；Key 绝不回传
  const put=await request("/admin/search/config",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"tavily",tavily_api_key:searchKey})});
  assert(put.status===200&&put.data.configured===true&&put.data.provider==="tavily","tavily provider becomes configured");
  assert(!put.text.includes(searchKey),"config response never echoes the key");
  const cfgGet=await request("/admin/search/config");
  assert(cfgGet.data.has_tavily_key===true&&!cfgGet.text.includes(searchKey),"status exposes has_key only");
  const stat=fs.statSync(searchConfigPath);
  assert((stat.mode&0o777)===0o600,"search config file is 0600");
  caps=(await request("/v1/capabilities")).data;
  assert(caps.web_search.configured===true&&caps.web_search.provider==="tavily","capabilities reflect configured provider");

  // 3) web off：上游请求不带 tools，搜索不发生
  const off=await chat("hello",{webEnabled:false});
  assert(off.status===200,"web off chat ok");
  assert(upstreamBodies.at(-1).tools===undefined,"web off injects no tools");
  assert(searchHits.length===0,"web off never calls search provider");

  // 4) web on + 模型决定不搜索（无 SEARCH 标记）：不强制搜索
  const plain=await chat("你好",{webEnabled:true});
  assert(plain.status===200&&searchHits.length===0,"web on does not force search for casual chat");
  assert(plain.data.choices[0].message.companion_web_sources===undefined,"no sources when no search happened");

  // completed normal turn: even a stale client calling guidance directly is rejected,
  // and the same text can immediately start a new ordinary turn.
  const primaryAfterPlain=await conversationByKey("chat:default");
  const staleNormal=await guidance(primaryAfterPlain.id,"NEXT_NORMAL_AFTER_FINAL");
  assert(staleNormal.status===409&&staleNormal.data.error.code==="no_active_turn","completed normal turn rejects stale guidance POST");
  const nextNormal=await chat("NEXT_NORMAL_AFTER_FINAL",{webEnabled:false});
  assert(nextNormal.status===200,"message after completed normal answer starts a new turn");
  assert((await request(`/admin/sessions/${primaryAfterPlain.id}/guidance`)).data.data.filter(x=>x.status==="queued").length===0,"normal completion leaves guidance queue empty");

  // 5) web on + 需要搜索：工具循环 → 搜索执行 → 来源返回并持久化
  const searched=await chat("SEARCH 今天天气",{webEnabled:true});
  assert(searched.status===200,"web search chat ok");
  assert(searchHits.length===1&&searchHits[0].query==="今天天气","search executed once with model query");
  assert(searchHits[0].api_key===searchKey,"search provider received configured key");
  assert(searchHits[0].max_results===3,"model-provided max_results respected");
  const sources=searched.data.choices[0].message.companion_web_sources;
  assert(Array.isArray(sources)&&sources.length===2,"normalized+deduped sources returned (3→2 after dedupe+url filter)");
  assert(sources[0].source==="weather.example.com"&&sources[0].snippet.length<=321,"snippet truncated and host set");
  assert(!searched.text.includes(searchKey),"key never appears in chat response");
  const toolCallRound=upstreamBodies.at(-1);
  const toolMsg=toolCallRound.messages.find(m=>m?.role==="tool");
  assert(Boolean(toolMsg)&&toolMsg.content.includes("不可信外部数据"),"tool result is wrapped as untrusted external content upstream");
  assert(!toolMsg.content.includes(searchKey),"tool result never contains the key");

  // 6) 历史持久化：web_sources 存在于 assistant 行；tool 行存在；content 不含 base64/key
  const conversations=(await request("/admin/conversations?source=chat&limit=50")).data.data;
  const primary=conversations.find(c=>c.external_key==="chat:default");
  const rows=(await request(`/admin/conversations/${primary.id}/messages`)).data.data;
  const finalAssistant=[...rows].reverse().find(r=>r.role==="assistant"&&r.web_sources?.length);
  assert(Boolean(finalAssistant)&&finalAssistant.web_sources.length===2,"web_sources persisted on assistant message row");
  assert(rows.some(r=>r.role==="tool"),"tool result row persisted");
  assert(!rows.some(r=>String(r.content_text??"").includes(searchKey)),"no secret in stored history");
  const usageLedger=(await request("/admin/product/usage")).data;
  const searchUsage=usageLedger.features.find(item=>item.key==="search");
  assert(searchUsage?.requests>=1&&searchUsage.inputTokens===null&&searchUsage.unknownUsage>=1,"search invocations enter ledger without inventing token counts");

  // 7) Native Agent SSE：provider 分片先在 Core 重组/分类，客户端只收到安全的结构化 tool call；最终历史只落一次。
  const streamed=await streamChat("STREAM_SEARCH 今天天气");
  assert(streamed.status===200,"native streaming status ok");
  const toolCall=streamed.text.indexOf('"name":"web_search"');
  const toolResult=streamed.text.indexOf("companion.tool_result"),finalText=streamed.text.indexOf('"content":"streamed answer"');
  assert(toolCall>=0&&!streamed.text.includes('"name":"web_"'),"fragmented provider tool calls are reassembled before client delivery");
  assert(toolResult>toolCall&&finalText>toolResult,"tool result precedes the normalized continuation text");
  assert(streamed.text.trim().endsWith("data: [DONE]"),"stream ends exactly with DONE");
  const streamConversation=(await request("/admin/conversations?source=chat&limit=50")).data.data.find(c=>c.external_key==="stream:default");
  const streamRows=(await request(`/admin/conversations/${streamConversation.id}/messages`)).data.data;
  assert(streamRows.filter(row=>row.role==="assistant"&&row.content_text==="streamed answer").length===1,"final durable assistant history is stored once");
  assert(streamRows.some(row=>row.role==="tool"&&row.tool_call_id==="stream-call"),"streamed tool result remains durable");

  // The Core clears active state before the client-visible terminal DONE. A stale
  // Swift busy flag therefore cannot enqueue after a tool-loop final answer.
  const staleAfterTool=await guidance(streamConversation.id,"NEXT_AFTER_TOOL_FINAL");
  assert(staleAfterTool.status===409&&staleAfterTool.data.error.code==="no_active_turn","tool-loop completion rejects stale guidance POST after DONE");
  const nextAfterTool=await chat("NEXT_AFTER_TOOL_FINAL",{session:"stream:default",webEnabled:false});
  assert(nextAfterTool.status===200,"message immediately after tool-loop final answer starts a new turn");
  assert((await request(`/admin/sessions/${streamConversation.id}/guidance`)).data.data.filter(x=>x.status==="queued").length===0,"tool-loop completion leaves guidance queue empty");

  // A genuinely running multi-step turn accepts guidance while its tool is still running.
  const heldPromise=chat("HOLD_SEARCH",{session:"guidance:tool-running",webEnabled:true});
  await searchStarted.promise;
  const heldConversation=await waitFor(()=>conversationByKey("guidance:tool-running"),"held conversation");
  const heldSnapshot=await request(`/admin/sessions/${heldConversation.id}/guidance`);
  assert(heldSnapshot.data.activeTurn.status==="tool_running","Core exposes tool_running as an active state");
  const queuedDuringTool=await guidance(heldConversation.id,"GUIDANCE_DURING_TOOL");
  assert(queuedDuringTool.status===201,"guidance is accepted while the tool is genuinely running");
  releaseSearch.resolve();
  assert((await heldPromise).status===200,"held multi-step turn resumes without a timer workaround");
  assert((await request(`/admin/sessions/${heldConversation.id}/guidance`)).data.data.filter(x=>x.status==="queued").length===0,"running-turn guidance is consumed FIFO at the next boundary");

  const streamFailure=await streamChat("STREAM_ERROR",{session:"stream:error"});
  assert(streamFailure.status===200&&streamFailure.text.includes("mock stream provider failed")&&streamFailure.text.includes("data: [DONE]"),"provider stream error terminates explicitly");
  const failedConversation=await conversationByKey("stream:error");
  assert((await guidance(failedConversation.id,"AFTER_FAILED_TURN")).status===409,"failed turn cannot accept stale guidance");
  assert((await chat("AFTER_FAILED_TURN",{session:"stream:error",webEnabled:false})).status===200,"message after failed turn starts normally");

  // 8) agent 模式不受 daily 联网开关影响（compat 决策路径对 mock 回复可能报错，但关键是不注入 web_search）
  await chat("SEARCH agent 侧",{webEnabled:true,model:"yuna-agent",session:"agent-web-check"});
  const lastAgentBody=upstreamBodies.at(-1);
  assert(Boolean(lastAgentBody),"agent upstream attempt recorded");
  const agentToolSpecs=(Array.isArray(lastAgentBody.tools)?lastAgentBody.tools:[]).map(t=>t?.function?.name);
  assert(!agentToolSpecs.includes("web_search"),"daily web toggle does not inject web_search tool into agent path");

  // 9) 重启后配置与来源仍在
  core.kill("SIGTERM");for(let i=0;i<80&&core.exitCode===null;i++)await sleep(25);
  const core2=startCore();children.push(core2);await wait(`http://127.0.0.1:${corePort}/health`);
  const capsAfter=(await request("/v1/capabilities")).data;
  assert(capsAfter.web_search.configured===true&&capsAfter.web_search.provider==="tavily","search config survives restart");
  const rowsAfter=(await request(`/admin/conversations/${primary.id}/messages`)).data.data;
  assert(rowsAfter.some(r=>r.web_sources?.length),"web_sources survive restart");

  // 10) 关闭 provider → 回到未配置
  await request("/admin/search/config",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"none"})});
  const capsOff=(await request("/v1/capabilities")).data;
  assert(capsOff.web_search.configured===false,"provider none disables capability");

  // 11) 归一化/截断/去重单元断言
  const { normalizeSearchResults,wrapUntrustedSearchContent,dedupeSources }=await import(path.join(root,"src/search/index.js"));
  const raw=Array.from({length:12},(_,i)=>({title:`t${i}`,url:i%3===0?"not-a-url":`https://s.example.com/${i}`,content:"x".repeat(900)}));
  const normalized=normalizeSearchResults(raw,{maxResults:6,snippetMaxChars:320});
  assert(normalized.length===6&&normalized.every(r=>r.snippet.length<=321),"normalization caps count and truncates snippets");
  assert(dedupeSources([...normalized,...normalized],8).length===6,"dedupeSources removes url duplicates");
  assert(wrapUntrustedSearchContent([{title:"x"}]).includes("不可信"),"untrusted wrapper marks external content");

  console.log("\nPASS Web Search: honest unconfigured state, tavily config (0600, no key echo), web-off isolation, no forced search, tool loop with untrusted wrapping, source normalization/persistence/restart, agent isolation, provider disable");
}finally{
  for(const server of [mockUpstream,mockSearch])try{server.close();}catch{}
  for(const child of [...children].reverse())try{child.kill("SIGKILL");}catch{}
  fs.rmSync(tmp,{recursive:true,force:true});
  await sleep(100);
}
