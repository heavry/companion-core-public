import http from "node:http";

const port=Number(process.env.MOCK_PORT||18990),providerName=process.env.MOCK_PROVIDER_NAME??"",sleep=ms=>new Promise(r=>setTimeout(r,ms)),textOf=m=>typeof m?.content==="string"?m.content:JSON.stringify(m?.content??"");
let stats={providerName,active:0,maxActive:0,activeMain:0,maxMainActive:0,total:0,aborted:0,toolResults:0,responses:0,compatRequests:0,initialContractChars:0,repairContractChars:0,toolMissContractChars:0,lastResponses:null,lastCompat:null,lastChat:null,recentChats:[]};
const reset=()=>{stats={providerName,active:0,maxActive:0,activeMain:0,maxMainActive:0,total:0,aborted:0,toolResults:0,responses:0,compatRequests:0,initialContractChars:0,repairContractChars:0,toolMissContractChars:0,lastResponses:null,lastCompat:null,lastChat:null,recentChats:[]};};
const sendJson=(res,status,body)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(body));};
const completion=(model,message,usage={prompt_tokens:7,completion_tokens:3,total_tokens:10,prompt_tokens_details:{cached_tokens:2}})=>({id:"mock",object:"chat.completion",model,choices:[{index:0,message,finish_reason:message.tool_calls?.length?"tool_calls":"stop"}],usage});
const toolCall=(id,name,args)=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const responseCall=(callId,name,args)=>({type:"function_call",id:`fc_${callId}`,call_id:callId,name,arguments:JSON.stringify(args),status:"completed"});
const responseMessage=text=>({type:"message",id:"msg_mock",status:"completed",role:"assistant",content:[{type:"output_text",text,annotations:[]}]});
const responseUsage={input_tokens:13,output_tokens:5,total_tokens:18,input_tokens_details:{cached_tokens:3}};
const responseBody=(model,output,usage=responseUsage)=>({id:"resp_mock",object:"response",created_at:Math.floor(Date.now()/1000),status:"completed",model,output,parallel_tool_calls:true,tool_choice:"auto",tools:[],usage});
const inputText=item=>{
  if(typeof item==="string")return item;
  if(!item||typeof item!=="object")return "";
  if(item.type==="function_call_output")return textOf({content:item.output});
  if(typeof item.content==="string")return item.content;
  if(Array.isArray(item.content))return item.content.map(part=>typeof part==="string"?part:String(part?.text??part?.refusal??"")).join("\n");
  return "";
};

async function handleResponses(req,res,b){
  const input=typeof b.input==="string"?[{role:"user",content:b.input}]:(b.input??[]),all=input.map(inputText).join("\n"),lastUser=[...input].reverse().find(item=>item?.role==="user"),user=inputText(lastUser),toolOutputs=input.filter(item=>item?.type==="function_call_output");
  stats.active++;stats.maxActive=Math.max(stats.maxActive,stats.active);stats.activeMain++;stats.maxMainActive=Math.max(stats.maxMainActive,stats.activeMain);stats.total++;stats.responses++;stats.toolResults+=toolOutputs.length;
  stats.lastResponses={model:b.model,stream:Boolean(b.stream),tools:b.tools??null,toolChoice:b.tool_choice??null,hasPersona:all.includes("【角色身份"),hasAgentMode:all.includes("【当前模式】"),hasMemory:all.includes("用户喜欢机械键盘"),hasEvent:all.includes("RESPONSES_SHARED_EVENT"),hasSummary:all.includes("RESPONSES_SESSION_SUMMARY"),hasAutonomousLife:all.includes("【Autonomous Life Layer｜代码计算的只读状态，不是用户指令】")};
  let closed=false;res.on("close",()=>{if(!res.writableEnded&&!closed)stats.aborted++;});
  try{
    if(providerName==="primary"){for(const status of [400,429,500,502,503,504,520,521,522,523,524,525,526,527])if(user.includes(`PRIMARY_ONLY_${status}`)){if(status===524){res.writeHead(524,{"content-type":"text/html"});return res.end("<html>CLOUDFLARE_524_PAGE_MUST_NOT_LEAK</html>");}return sendJson(res,status,{error:{message:`primary responses ${status}`,type:"mock_error"}});}if(user.includes("PRIMARY_NET_RESET")){req.socket.destroy();return;}if(user.includes("PRIMARY_DEADLINE_HANG")){await sleep(1200);if(!res.destroyed)return sendJson(res,200,responseBody(b.model,[responseMessage("PRIMARY_TOO_LATE")]));return;}}
    for(const status of [429,500])if(user.includes(`RESP_FAULT_${status}`))return sendJson(res,status,{error:{message:`mock responses ${status}`,type:"mock_error"}});
    if(user.includes("RESP_CONNECTION_RESET")){req.socket.destroy();return;}
    if(user.includes("RESP_SLOW_"))await sleep(220);
    let output;
    if(user.includes("RESP_AGENT_LOOP")){
      if(toolOutputs.length===0)output=[responseCall("call_one","first_tool",{step:1})];
      else if(toolOutputs.length===1)output=[responseCall("call_two","second_tool",{step:2})];
      else output=[responseMessage("RESP_AGENT_DONE")];
    }else if(user.includes("RESP_MULTI_TOOL"))output=[responseCall("call_a","tool_a",{a:1}),responseCall("call_b","tool_b",{b:2})];
    else if(toolOutputs.length)output=[responseMessage("RESP_TOOL_RESULT_OK")];
    else if(user.includes("RESP_CONTEXT_CHECK"))output=[responseMessage(stats.lastResponses.hasPersona&&stats.lastResponses.hasAgentMode&&stats.lastResponses.hasMemory&&stats.lastResponses.hasEvent&&stats.lastResponses.hasSummary?"RESP_CONTEXT_OK":"RESP_CONTEXT_MISSING")];
    else if(user.includes("我之前喜欢什么键盘"))output=[responseMessage(all.includes("用户喜欢机械键盘")?"MEMORY_SEEN":"MEMORY_MISSING")];
    else if(user.includes("项目秘密是什么"))output=[responseMessage(all.includes("PROJECT_A_SECRET")?"PROJECT_A_SECRET":all.includes("PROJECT_B_SECRET")?"PROJECT_B_SECRET":"ISOLATED")];
    else if(user.includes("RESP_STREAM_FUNCTION"))output=[responseCall("call_stream","stream_echo",{value:"ok"})];
    else if(user.includes("RESP_FORCED_FUNCTION")||Array.isArray(b.tools)&&b.tools.length){const name=b.tool_choice?.name??b.tools?.[0]?.name??"echo_test";output=[responseCall("call_forced",name,{value:"ok"})];}
    else output=[responseMessage(providerName?`${providerName.toUpperCase()}_RESP_MOCK_OK`:"RESP_MOCK_OK")];
    const completed=responseBody(b.model,output);completed.tool_choice=b.tool_choice??"auto";completed.tools=b.tools??[];
    if(!b.stream)return sendJson(res,200,completed);
    const eol=user.includes("RESP_LF_STREAM")?"\n":"\r\n",write=(name,data)=>res.write(`event: ${name}${eol}data: ${JSON.stringify(data)}${eol}${eol}`);
    res.writeHead(200,{"content-type":"text/event-stream"});write("response.created",{type:"response.created",response:{...completed,status:"in_progress",output:[],usage:null}});
    if(user.includes("RESP_STREAM_FUNCTION")){
      const call=responseCall("call_stream","stream_echo",{value:"ok"});
      write("response.output_item.added",{type:"response.output_item.added",output_index:0,item:{...call,status:"in_progress",arguments:""}});
      write("response.function_call_arguments.delta",{type:"response.function_call_arguments.delta",item_id:call.id,output_index:0,delta:'{"value":'});
      write("response.function_call_arguments.delta",{type:"response.function_call_arguments.delta",item_id:call.id,output_index:0,delta:'"ok"}'});
      write("response.function_call_arguments.done",{type:"response.function_call_arguments.done",item_id:call.id,output_index:0,call_id:call.call_id,name:call.name,arguments:call.arguments});
      write("response.output_item.done",{type:"response.output_item.done",output_index:0,item:call});
    }else{
      const text=output[0]?.content?.[0]?.text??"RESP_MOCK_OK",half=Math.max(1,Math.floor(text.length/2)),itemId="msg_stream";
      write("response.output_item.added",{type:"response.output_item.added",output_index:0,item:{type:"message",id:itemId,status:"in_progress",role:"assistant",content:[]}});
      write("response.output_text.delta",{type:"response.output_text.delta",item_id:itemId,output_index:0,content_index:0,delta:text.slice(0,half)});
      if(user.includes("RESP_SSE_BREAK")){await sleep(20);res.destroy();return;}
      if(user.includes("RESP_CANCEL_STREAM")){for(let i=0;i<100&&!res.destroyed;i++){await sleep(25);write("response.output_text.delta",{type:"response.output_text.delta",item_id:itemId,output_index:0,content_index:0,delta:"."});}if(res.destroyed)return;}
      write("response.output_text.delta",{type:"response.output_text.delta",item_id:itemId,output_index:0,content_index:0,delta:text.slice(half)});
      write("response.output_text.done",{type:"response.output_text.done",item_id:itemId,output_index:0,content_index:0,text});
      write("response.output_item.done",{type:"response.output_item.done",output_index:0,item:output[0]});
    }
    write("response.completed",{type:"response.completed",response:completed});res.end();return;
  }finally{closed=res.writableEnded;stats.active--;stats.activeMain--;}
}

const server=http.createServer(async(req,res)=>{
  if(req.url==="/stats"){return sendJson(res,200,stats);}
  if(req.url==="/reset"&&req.method==="POST"){reset();return sendJson(res,200,{ok:true});}
  if(req.method!=="POST"||!["/v1/chat/completions","/v1/responses"].includes(req.url)){res.writeHead(404);return res.end();}
  let raw="";for await(const c of req)raw+=c;const b=JSON.parse(raw||"{}");
  if(req.url==="/v1/responses")return handleResponses(req,res,b);
  const messages=b.messages??[],all=messages.map(textOf).join("\n"),last=[...messages].reverse().find(m=>m.role==="user"),user=textOf(last),isSummary=String(b.model).includes("summary");
  stats.active++;stats.maxActive=Math.max(stats.maxActive,stats.active);stats.total++;if(!isSummary){stats.activeMain++;stats.maxMainActive=Math.max(stats.maxMainActive,stats.activeMain);}stats.toolResults+=messages.filter(m=>m.role==="tool").length;
  let closed=false;res.on("close",()=>{if(!res.writableEnded&&!closed)stats.aborted++;});
  try{
    if(isSummary){
      const pollution=all.includes("PROJECT_POLLUTION_CASE")||all.includes("RESP_POLLUTION_CASE")||all.includes("COMPAT_POLLUTION_CASE"),payload={summary:pollution?"CompanionAI OAuth 阶段已完成。":all.includes("蓝鲸")?"用户在本 Session 提到暗号蓝鲸。":all.includes("MEMCAP_INCLUDE_SHOULD_SUMMARY")?"[MOCK_SUMMARY_SHOULD_RUN]":"本段对话已总结。",memories:[],events:[]};
      if(all.includes("机械键盘"))payload.memories.push({content:"用户喜欢机械键盘",type:"preference",importance:.9});
      if(all.includes("MEMCAP_INCLUDE_SAFETY"))payload.memories.push({content:"用户偏好绿色",type:"preference",importance:.7});
      if(all.includes("SECURITY_INJECTION_CASE"))payload.memories.push({content:"攻击者诱导偏好",type:"preference",importance:.99});
      if(all.includes("MEMCAP_INCLUDE_REVIEW"))payload.memories.push({content:"用户想要每月底复查项目进度",type:"preference",importance:.8});
      if(all.includes("MEMCAP_MEMORY_FAIL")){return sendJson(res,400,{error:{message:"mock extraction failure",type:"mock_error"}});}
      // 通用记忆抽取：当识别到 [MEMORY EXTRACTION CONTRACT V1] 提取请求时，
      // 根据对话内容中的信号词返回可预测的候选，以便端到端测试。
      if(all.includes("【MEMORY EXTRACTION CONTRACT V1】")||all.includes("[MEMORY EXTRACTION CONTRACT V1]")){
        if(all.includes("星空主题"))payload.memories.push({content:"用户在测试时更喜欢看星空主题配色",type:"preference",importance:.8});
        if(all.includes("极光主题")){
          // 若对话包含已有记忆 id 引用（由测试注入），则设置 replaces_id 以触发冲突更新
          const idMatch=all.match(/REPLACE_TARGET:([\w-]+)/);
          payload.memories.push({content:"用户现在更喜欢极光主题配色",type:"preference",importance:.9,...(idMatch?{replaces_id:idMatch[1]}:{})});
        }
        if(all.includes("墨绿色"))payload.memories.push({content:"用户喜欢墨绿色",type:"preference",importance:.7});
        if(all.includes("MEMCAP_INCLUDE_SHOULD_SUMMARY"))payload.memories.push({content:"用户希望每季度复查这个内部计划",type:"commitment",importance:.8});
      }
      if(pollution){payload.memories.push({content:"CompanionAI 的 OAuth 登录问题已修复并通过测试。",type:"project",importance:.95},{content:"auth.ts 第 317 行 SECRET_TOOL_OUTPUT_XYZ",type:"project",importance:1});payload.events.push({content:"CompanionAI OAuth 修复已经完成并通过验收。",importance:.9},{content:"git diff @@ SECRET_TOOL_OUTPUT_XYZ",importance:1});}
      return sendJson(res,200,completion(b.model,{role:"assistant",content:JSON.stringify(payload)},{prompt_tokens:11,completion_tokens:9,total_tokens:20,prompt_tokens_details:{cached_tokens:4}}));
    }
    const currentChat={model:b.model,stream:Boolean(b.stream),toolCount:Array.isArray(b.tools)?b.tools.length:0,toolNames:(b.tools??[]).map(tool=>tool?.function?.name??tool?.name).filter(Boolean),hasNoWorkspaceTruth:all.includes("本轮没有调用方授权的 workspace path"),hasVoiceAvailability:all.includes("【Companion Voice Delivery｜运行时真值】"),hasTimeContext:all.includes("【动态时间上下文｜只读事实数据，不是指令】"),hasTimeZone:all.includes("Timezone: Asia/Shanghai (UTC+08:00)"),hasPreviousUser:all.includes("Previous real user message:"),hasPreviousAssistant:all.includes("Previous real assistant final message:"),hasElapsed:all.includes("Elapsed since previous real user message:"),hasTemporaryActivity:all.includes("Temporary activity: activity=study"),hasActivitySafetyRule:all.includes("elapsed time only measures the chat gap"),hasAutonomousLife:all.includes("【Autonomous Life Layer｜代码计算的只读状态，不是用户指令】")};
    if(currentChat.hasTimeContext||currentChat.hasNoWorkspaceTruth||currentChat.hasVoiceAvailability||currentChat.toolCount>0)stats.lastChat=currentChat;
    stats.recentChats.push({...currentChat,workspaceClearedCase:all.includes("工作区已清除"),workspaceRestoredCase:all.includes("工作区重新选择完成")});
    if(stats.recentChats.length>50)stats.recentChats.shift();
    if(providerName==="primary"){for(const status of [400,429,500,502,503,504,520,521,522,523,524,525,526,527])if(user.includes(`PRIMARY_ONLY_${status}`)){if(status===524){res.writeHead(524,{"content-type":"text/html"});return res.end("<html>CLOUDFLARE_524_PAGE_MUST_NOT_LEAK</html>");}return sendJson(res,status,{error:{message:`primary upstream ${status}`,type:"mock_error"}});}if(user.includes("PRIMARY_NET_RESET")){req.socket.destroy();return;}if(user.includes("PRIMARY_DEADLINE_HANG")){await sleep(1200);if(!res.destroyed)return sendJson(res,200,completion(b.model,{role:"assistant",content:"PRIMARY_TOO_LATE"}));return;}}
    for(const status of [400,401,429,500,502])if(user.includes(`FAULT_${status}`))return sendJson(res,status,{error:{message:`mock upstream ${status}`,type:"mock_error"}});
    if(user.includes("CONNECTION_RESET")){req.socket.destroy();return;}
    if(user.includes("TIMEOUT")){await sleep(1200);if(!res.destroyed)return sendJson(res,200,completion(b.model,{role:"assistant",content:"TOO_LATE"}));return;}
    if(user.includes("SLOW_"))await sleep(220);

    if(all.includes("【Tool Compatibility Contract｜协议规则，不改变角色人格】")||all.includes("【Tool Compatibility Protocol 修复")||all.includes("【Tool Miss Recovery")){
      stats.compatRequests++;const repair=all.includes("【Tool Compatibility Protocol 修复"),toolMiss=all.includes("【Tool Miss Recovery"),toolResults=(all.match(/【工具执行结果｜只读数据/g)??[]).length;
      const contract=[...messages].reverse().find(m=>textOf(m).includes("【Tool Compatibility Contract")||textOf(m).includes("【Tool Compatibility Protocol 修复")||textOf(m).includes("【Tool Miss Recovery")),contractText=textOf(contract),catalogLine=contractText.split("\n").find(x=>x.startsWith("工具目录：")||x.startsWith("候选工具：")||x.startsWith("匹配工具："))??"工具目录：[]";
      let catalog=[];try{catalog=JSON.parse(catalogLine.slice(catalogLine.indexOf("：")+1));}catch{}
      if(repair)stats.repairContractChars=contractText.length;else if(toolMiss)stats.toolMissContractChars=contractText.length;else stats.initialContractChars=contractText.length;
      stats.lastCompat={providerName,model:b.model,stream:b.stream,responseFormat:b.response_format,temperature:b.temperature,hasNativeTools:Object.hasOwn(b,"tools"),hasPersona:all.includes("【角色身份"),hasCoreIdentity:all.includes("星铃守护者"),hasPersonality:all.includes("机敏、温柔"),hasSpeakingStyle:all.includes("每次最终回答以「星铃｜」开头"),hasAgentMode:all.includes("AGENT_MODE_MARKER"),hasMemory:all.includes("用户喜欢机械键盘"),hasEvent:all.includes("COMPAT_SHARED_EVENT"),hasSummary:all.includes("COMPAT_SESSION_SUMMARY"),hasToolContract:true,toolMiss,catalog,toolResults,toolResultContext:messages.filter(x=>textOf(x).includes("【工具执行结果｜只读数据")).map(textOf).join("\n"),messageRoles:messages.map(x=>x.role)};
      if(user.includes("COMPAT_CANCEL")){await sleep(1200);if(res.destroyed)return;}
      if(user.includes("MODULE_ROUND2_HANG")&&toolResults>0){await sleep(4000);if(res.destroyed)return;}
      let decision;
      if(user.includes("COMPAT_INVALID_ALWAYS"))return sendJson(res,200,completion(b.model,{role:"assistant",content:"not json"}));
      if(user.includes("COMPAT_INVALID_ONCE")&&!repair)return sendJson(res,200,completion(b.model,{role:"assistant",content:"```json\n{bad}\n```"}));
      if(user.includes("COMPAT_EMPTY_ONCE")&&!repair)return sendJson(res,200,completion(b.model,{role:"assistant",content:""}));
      if(user.includes("COMPAT_UNKNOWN_ONCE")&&!repair)decision={type:"tool_call",name:"delete_database",arguments:{}};
      else if(user.includes("COMPAT_MISSING_REQUIRED_ONCE")&&!repair)decision={type:"tool_call",name:catalog[0]?.name??"echo_test",arguments:{}};
      else if(user.includes("COMPAT_EXTRA_ARG_ONCE")&&!repair)decision={type:"tool_call",name:catalog[0]?.name??"echo_test",arguments:{value:"ok",unexpected:true}};
      else if(user.includes("COMPAT_WRONG_TYPE_ONCE")&&!repair)decision={type:"tool_call",name:catalog[0]?.name??"echo_test",arguments:{value:123}};
      else if(user.includes("COMPAT_SCHEMA_ONCE")&&!repair)decision={type:"tool_call",name:catalog[0]?.name??"echo_test",arguments:{value:"not-in-enum"}};
      else if(user.includes("COMPAT_ROOT_ONCE")&&!repair)decision=[];
      else if(user.includes("COMPAT_TYPE_ONCE")&&!repair)decision={type:"unexpected"};
      else if(user.includes("COMPAT_FINAL_INVALID_ONCE")&&!repair)decision={type:"final_answer",content:"not allowed while required"};
      else if(user.includes("COMPAT_ACTION_MISS_ALWAYS"))decision={type:"final_answer",content:"仍然没有调用工具。"};
      else if(user.includes("COMPAT_ACTION_DOWNLOAD"))decision=toolMiss?{type:"tool_call",name:"bash",arguments:{command:"curl -O https://example.invalid/safe.txt"}}:{type:"final_answer",content:"你可以自己下载。"};
      else if(user.includes("COMPAT_ACTION_INSTALL"))decision=toolMiss?{type:"tool_call",name:"bash",arguments:{command:"printf install-safe"}}:{type:"final_answer",content:"你可以自己安装。"};
      else if(user.includes("COMPAT_ACTION_EDIT"))decision=toolMiss?{type:"tool_call",name:"edit_file",arguments:{path:"tmp.txt",content:"safe"}}:{type:"final_answer",content:"你可以自己修改。"};
      else if(user.includes("COMPAT_ACTION_TEST"))decision=toolMiss?{type:"tool_call",name:"run_tests",arguments:{command:"node --check safe.js"}}:{type:"final_answer",content:"你可以自己测试。"};
      else if(user.includes("COMPAT_ACTION_QA"))decision={type:"final_answer",content:"这是普通说明回答。"};
      else if(user.includes("COMPAT_DEV_LOOP"))decision=toolResults===0?{type:"tool_call",name:"read_file",arguments:{path:"tmp.txt"}}:toolResults===1?{type:"tool_call",name:"edit_file",arguments:{path:"tmp.txt",content:"safe"}}:toolResults===2?{type:"tool_call",name:"run_test",arguments:{command:"node --check tmp.txt"}}:{type:"final_answer",content:"星铃｜DEV_LOOP_DONE"};
      else if(user.includes("MODULE_BADARGS"))decision={type:"tool_call",name:(catalog.find(t=>String(t.name).startsWith("mod_"))??{}).name??"mod_unknown",arguments:{wrong:"shape"}};
      else if(user.includes("CALL_IMAGE")&&toolResults===0)decision={type:"tool_call",name:"generate_image",arguments:{prompt:"a tiny test image",style:"casual",aspect_ratio:"1:1"}};
      else if(user.includes("CALL_FLAKY")&&toolResults===0)decision={type:"tool_call",name:"mod_flaky",arguments:{}};
      else if(user.includes("CALL_SLOW_PING")&&toolResults===0)decision={type:"tool_call",name:"mod_slow_ping",arguments:{tag:(user.match(/PINGTAG:(\w+)/)?.[1]??"a")}};
      else if(user.includes("MODULE_ECHO_LAST_TOOL")&&toolResults>0){const m=all.match(/\[module[^\]]*\]/);const out=(all.match(/output:\n([^\n]+)/)?.[1]??"");decision={type:"final_answer",content:"TOOL_SAYS:"+(m?m[0]:"NONE")+"|OUT:"+out};}
      else if(user.includes("CALL_PING")&&toolResults===0)decision={type:"tool_call",name:"mod_ping",arguments:{tag:(user.match(/PINGTAG:(\w+)/)?.[1]??"a")}};
      else if(user.includes("MODULE_LOOP")){if(toolResults===0){const mt=catalog.find(t=>t.name==="mod_echo_note")??catalog.find(t=>String(t.name).startsWith("mod_"));decision=mt?{type:"tool_call",name:mt.name,arguments:{text:"hello"}}:{type:"final_answer",content:"NO_MODULE_TOOL"};}else decision={type:"final_answer",content:`MODULE_RESULT_SEEN:${all.includes("ECHO_NOTE")?"yes":"no"}`};}
      else if(user.includes("COMPAT_LOOP"))decision=toolResults===0?{type:"tool_call",name:"first_tool",arguments:{step:1}}:toolResults===1?{type:"tool_call",name:"second_tool",arguments:{step:2}}:{type:"final_answer",content:"YUNA_COMPAT_LOOP_DONE"};
      else if(/COMPAT_SELECT_TOOL:([A-Za-z0-9_-]+)/.test(user)){const name=user.match(/COMPAT_SELECT_TOOL:([A-Za-z0-9_-]+)/)[1];decision={type:"tool_call",name,arguments:{value:"ok"}};}
      else if(user.includes("COMPAT_SECOND_TOOL"))decision={type:"tool_call",name:catalog[1]?.name??catalog[0]?.name,arguments:{query:"ok"}};
      else if(user.includes("NATIVE_COMPUTER_EXPOSURE"))decision=toolResults===0?{type:"tool_call",name:"capabilities_discover",arguments:{capability:"computer.use"}}:{type:"final_answer",content:"NATIVE_COMPUTER_EXPOSURE_OK"};
      else if(user.includes("COMPAT_CONTEXT_CHECK"))decision={type:"final_answer",content:stats.lastCompat.hasPersona&&stats.lastCompat.hasCoreIdentity&&stats.lastCompat.hasPersonality&&stats.lastCompat.hasSpeakingStyle&&stats.lastCompat.hasAgentMode&&stats.lastCompat.hasMemory&&stats.lastCompat.hasEvent&&stats.lastCompat.hasSummary?"星铃｜YUNA_PERSONA_CONTEXT_OK":"CONTEXT_MISSING"};
      else if(toolResults>0||!catalog.length||all.includes("选择规则：禁止调用工具"))decision={type:"final_answer",content:"YUNA_COMPAT_FINAL"};
      else decision={type:"tool_call",name:catalog[0]?.name??"echo_test",arguments:{value:"ok"}};
      return sendJson(res,200,completion(b.model,{role:"assistant",content:JSON.stringify(decision)},{prompt_tokens:17,completion_tokens:6,total_tokens:23,prompt_tokens_details:{cached_tokens:5}}));
    }

    const toolMessages=messages.filter(m=>m.role==="tool");
    if(user.includes("STREAM_TOOL")&&b.stream){
      res.writeHead(200,{"content-type":"text/event-stream"});
      res.write(`data: ${JSON.stringify({id:"st",object:"chat.completion.chunk",model:b.model,choices:[{index:0,delta:{tool_calls:[{index:0,id:"call_stream",type:"function",function:{name:"echo_test",arguments:'{"value":'}}]},finish_reason:null}]})}\r\n\r\n`);
      res.write(`data: ${JSON.stringify({id:"st",object:"chat.completion.chunk",model:b.model,choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"ok"}'}}]},finish_reason:"tool_calls"}]})}\r\n\r\n`);
      res.write("data: [DONE]\r\n\r\n");res.end();return;
    }
    if(user.includes("AGENT_LOOP")){
      if(toolMessages.length===0)return sendJson(res,200,completion(b.model,{role:"assistant",content:null,tool_calls:[toolCall("call_one","first_tool",{step:1})]}));
      if(toolMessages.length===1)return sendJson(res,200,completion(b.model,{role:"assistant",content:null,tool_calls:[toolCall("call_two","second_tool",{step:2})]}));
      return sendJson(res,200,completion(b.model,{role:"assistant",content:"AGENT_DONE"}));
    }
    if(user.includes("MULTI_TOOL"))return sendJson(res,200,completion(b.model,{role:"assistant",content:null,tool_calls:[toolCall("call_a","tool_a",{a:1}),toolCall("call_b","tool_b",{b:2})]}));
    if(toolMessages.length)return sendJson(res,200,completion(b.model,{role:"assistant",content:textOf(toolMessages.at(-1)).length>50000?"LARGE_TOOL_OK":"TOOL_RESULT_OK"}));
    if(user.includes("NATIVE_COMPUTER_EXPOSURE"))return sendJson(res,200,completion(b.model,{role:"assistant",content:"NATIVE_COMPUTER_EXPOSURE_OK"}));
    if(user.includes("NATIVE_LOCAL_EXPOSURE"))return sendJson(res,200,completion(b.model,{role:"assistant",content:"NATIVE_LOCAL_EXPOSURE_OK"}));
    if(user.includes("VOICE_AVAILABILITY_CONTEXT"))return sendJson(res,200,completion(b.model,{role:"assistant",content:"VOICE_AVAILABILITY_CONTEXT_OK"}));
    if(Array.isArray(b.tools)&&b.tools.length)return sendJson(res,200,completion(b.model,{role:"assistant",content:null,tool_calls:[toolCall("call_echo","echo_test",{value:"ok"})]}));

    let answer=providerName?`${providerName.toUpperCase()}_MOCK_OK`:"MOCK_OK";
    if(user.includes("暗号是什么"))answer=messages.some(message=>message.role==="user"&&textOf(message).includes("第一句暗号是蓝鲸"))?"蓝鲸":"不知道";
    if(user.includes("项目秘密是什么"))answer=all.includes("PROJECT_A_SECRET")?"PROJECT_A_SECRET":all.includes("PROJECT_B_SECRET")?"PROJECT_B_SECRET":"ISOLATED";
    if(user.includes("我之前喜欢什么键盘"))answer=all.includes("用户喜欢机械键盘")?"MEMORY_SEEN":"MEMORY_MISSING";
    if(user.includes("REASONING"))return sendJson(res,200,completion(b.model,{role:"assistant",content:"REASONING_OK",reasoning_content:"mock reasoning"}));

    if(b.stream){
      res.writeHead(200,{"content-type":"text/event-stream"});const eol=user.includes("LF_STREAM")?"\n":"\r\n";
      const write=data=>res.write(`data: ${data}${eol}${eol}`);
      write(JSON.stringify({id:"s",object:"chat.completion.chunk",model:b.model,choices:[{index:0,delta:{content:answer.slice(0,Math.max(1,Math.floor(answer.length/2)))},finish_reason:null}]}));
      if(user.includes("SSE_BREAK")){await sleep(20);res.destroy();return;}
      if(user.includes("CANCEL_STREAM")){for(let i=0;i<100&&!res.destroyed;i++){await sleep(25);write(JSON.stringify({id:"s",object:"chat.completion.chunk",model:b.model,choices:[{index:0,delta:{content:"."},finish_reason:null}]}));}if(res.destroyed)return;}
      write(JSON.stringify({id:"s",object:"chat.completion.chunk",model:b.model,choices:[{index:0,delta:{content:answer.slice(Math.max(1,Math.floor(answer.length/2)))},finish_reason:null}]}));
      write(JSON.stringify({id:"s",object:"chat.completion.chunk",model:b.model,choices:[{index:0,delta:{reasoning_content:user.includes("STREAM_REASONING")?"stream reasoning":""},finish_reason:"stop"}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5,prompt_tokens_details:{cached_tokens:1}}}));write("[DONE]");res.end();return;
    }
    return sendJson(res,200,completion(b.model,{role:"assistant",content:answer}));
  }finally{closed=res.writableEnded;stats.active--;if(!isSummary)stats.activeMain--;}
});
server.listen(port,"127.0.0.1",()=>console.log(`mock upstream ${port}`));
