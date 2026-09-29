import { analyzeActionIntent,buildRepairContract,buildToolContractDetails,buildToolMissRecoveryContract,estimateContractTokens,normalizeCompatTools,parseToolDecision,selectCompatToolCandidates,shouldRecoverToolMiss } from "../src/tool-compat.js";
import { resolveSession } from "../src/session.js";
import { stableJson } from "../src/utils.js";

const assert=(value,message)=>{if(!value)throw new Error(`ASSERT tool compat unit: ${message}`);};
const schema={type:"object",properties:{value:{type:"string",minLength:2},mode:{type:"string",enum:["safe","fast"]}},required:["value"],additionalProperties:false};
const makeTool=(name,index=0,description=`Tool ${name}`)=>({type:"function",name,description:`${description} ${"deterministic description ".repeat(8)}${index}`,parameters:schema});
const messages=text=>[{role:"user",content:text}];

const five=normalizeCompatTools(Array.from({length:5},(_,i)=>makeTool(`small_${i}`,i)));
assert(selectCompatToolCandidates(five,messages("use small_4"),"required").tools.length===5,"five-tool catalog remains complete");

for(const size of [20,55]){
  const raw=Array.from({length:size},(_,i)=>makeTool(`generic_${i}`,i));
  raw[0]=makeTool("front_target",0,"front diagnostics");raw[Math.floor(size/2)]=makeTool("middle_target",Math.floor(size/2),"middle diagnostics");raw[size-1]=makeTool("end_target",size-1,"end diagnostics");
  const tools=normalizeCompatTools(raw);
  for(const target of ["front_target","middle_target","end_target"]){const selected=selectCompatToolCandidates(tools,messages(`Please call ${target} for this task`),"required");assert(selected.tools.length<=8&&selected.tools.some(x=>x.name===target),`${size}-tool catalog selects ${target}`);}
}

const foundations=normalizeCompatTools([
  makeTool("read_file",0,"read file content"),makeTool("grep_search",1,"search text"),makeTool("list_files",2,"list workspace files"),makeTool("apply_patch",3,"edit a file"),makeTool("run_tests",4,"run shell tests"),
  ...Array.from({length:45},(_,i)=>makeTool(`optional_${i}`,i+5))
]);
const foundationSelection=selectCompatToolCandidates(foundations,messages("读取代码，搜索问题，修改文件并运行测试"),"required");
for(const name of ["read_file","grep_search","list_files","apply_patch","run_tests"])assert(foundationSelection.tools.some(x=>x.name===name),`foundation ${name} retained when present`);
assert(foundationSelection.tools.length<=8,"foundation selection stays within candidate target");

const actionTools=normalizeCompatTools([
  makeTool("ask_user_question",0,"Ask the user"),makeTool("bash",1,"Execute a shell command"),makeTool("edit_file",2,"Edit or patch a file"),makeTool("read_file",3,"Read a file"),makeTool("glob",4,"List files"),makeTool("grep",5,"Search file text"),makeTool("run_tests",6,"Run tests and checks"),makeTool("web_search",7,"Search the web"),
  ...Array.from({length:18},(_,i)=>makeTool(`unrelated_${i}`,i+8,"Unrelated optional capability"))
]);
const actionCases=[
  ["download","请帮我下载这个文件",["bash","web_search"]],
  ["install","请帮我安装这个依赖",["bash"]],
  ["configure","请帮我配置这个项目",["edit_file"]],
  ["edit","请修改代码里的错误",["edit_file"]],
  ["run","现在运行这个程序",["bash"]],
  ["test","请运行测试并验证结果",["run_tests","bash"]],
  ["deploy","请把这个服务部署上线",["bash"]]
];
for(const [intent,text,expected] of actionCases){const analysis=analyzeActionIntent(messages(text)),selection=selectCompatToolCandidates(actionTools,messages(text),"auto");assert(analysis.actionRequested&&analysis.intents.some(x=>x.name===intent),`${intent} action intent detected`);for(const name of expected)assert(selection.tools.some(x=>x.name===name),`${intent} selection retains ${name}`);assert(selection.tools.length<=8&&selection.tools.length<actionTools.length,`${intent} selection stays compact`);}
for(const text of ["怎么下载文件？只解释步骤","请告诉我如何安装依赖","先别下载，告诉我是什么","这段代码是什么意思？"]){const analysis=analyzeActionIntent(messages(text));assert(!analysis.actionRequested,`informational request does not become action: ${text}`);}
const downloadSelection=selectCompatToolCandidates(actionTools,messages("帮我下载文件"),"auto"),downloadFinal={type:"final_answer",content:"说明"};
assert(downloadSelection.matchingTools.some(x=>x.name==="bash")&&shouldRecoverToolMiss(downloadFinal,"auto",downloadSelection),"action final answer with matching executor triggers one tool-miss recovery");
assert(!shouldRecoverToolMiss({type:"tool_call",name:"bash",arguments:{}},"auto",downloadSelection)&&!shouldRecoverToolMiss(downloadFinal,"none",downloadSelection),"tool call and tool_choice none never trigger tool-miss recovery");
const qaSelection=selectCompatToolCandidates(actionTools,messages("怎么下载文件？只解释步骤"),"auto");assert(!shouldRecoverToolMiss(downloadFinal,"auto",qaSelection),"ordinary question final answer is accepted without recovery");
const harnessNames=["ask_user_question","bash","create_goal","edit","exit_plan_mode","generate_image","get_goal","glob","grep","interrupt_agent","job_kill","job_list","job_output","list_agents","ralph","read","read_image","send_message","skill","subagent","subagent_fork","todo_write","update_goal","web_search","workflow","write"],harnessTools=normalizeCompatTools(harnessNames.map((name,index)=>makeTool(name,index,name==="bash"?"Execute a bash command":name==="web_search"?"Search the web":name==="create_goal"?"Create a goal for an executable task":name==="list_agents"?"List agents and available commands":name==="workflow"?"Execute a multi-agent orchestration command":`Harness tool ${name}`))),harnessDownload=selectCompatToolCandidates(harnessTools,messages("宝宝那你帮我下载可以不可以，用国内镜像下载行吗？"),"auto");
assert(harnessDownload.tools.length<=8&&harnessDownload.tools.some(x=>x.name==="bash")&&harnessDownload.tools.some(x=>x.name==="web_search"),"realistic 26-tool Harness download request keeps shell and web search");
assert(harnessDownload.matchingTools.map(x=>x.name).join(",")==="bash","generic execute/command wording on goal, agent and workflow tools does not make them download executors");
for(const name of ["create_goal","list_agents","todo_write","workflow","read_image"])assert(!harnessDownload.tools.some(x=>x.name===name),`download intent filters unrelated Harness tool ${name}`);

const opaque=normalizeCompatTools(Array.from({length:20},(_,i)=>makeTool(`opaque_${i}`,i,"unrelated capability")));
const fallback=selectCompatToolCandidates(opaque,messages(""),"required");assert(fallback.tools.length===8&&fallback.fallbackReason==="no_reliable_signal_bounded","uncertain selection remains bounded instead of dumping the complete catalog");

const fullContract=["legacy",stableJson(foundations.map(x=>({name:x.name,description:x.description,parameters:x.parameters})))].join("\n"),optimized=buildToolContractDetails(foundationSelection.tools,"required");
assert(optimized.tokenEstimate===estimateContractTokens(optimized.contract),"contract token estimate is deterministic");
assert(optimized.tokenEstimate<estimateContractTokens(fullContract)*0.45,"large catalog contract token estimate drops by more than 55 percent");
assert(optimized.catalog.every(x=>!x.description||x.description.length<=180)&&optimized.contract.length<fullContract.length,"long descriptions are bounded and not repeated as full source text");
assert(optimized.contract.includes('"required":["value"]')&&optimized.contract.includes('"additionalProperties":false')&&optimized.contract.includes('"enum":["safe","fast"]'),"compact contract keeps required, additionalProperties and enum");

const tools=normalizeCompatTools([makeTool("echo_tool"),makeTool("hidden_tool")]),allowed=[tools[0]],decision=(value,choice="required")=>parseToolDecision(typeof value==="string"?value:JSON.stringify(value),tools,choice,allowed);
assert(decision("not-json").category==="json_parse_error","json parse classification");
assert(decision([]).category==="invalid_root_shape","root shape classification");
assert(decision({type:"tool_call",name:"invented",arguments:{value:"ok"}}).category==="unknown_tool","unknown tool classification");
assert(decision({type:"tool_call",name:"echo_tool",arguments:{}}).category==="missing_required_argument","missing required classification");
assert(decision({type:"tool_call",name:"echo_tool",arguments:{value:"ok",extra:true}}).category==="additional_argument","additional argument classification");
assert(decision({type:"tool_call",name:"echo_tool",arguments:{value:3}}).category==="argument_type_error","argument type classification");
assert(decision({type:"tool_call",name:"echo_tool",arguments:{value:"x"}}).category==="schema_validation_error","other schema classification");
assert(decision({type:"unexpected"}).category==="invalid_decision_type","decision type classification");
assert(decision({type:"final_answer",content:""},"auto").category==="final_answer_invalid","final answer classification");
assert(decision({type:"tool_call",name:"hidden_tool",arguments:{value:"ok"}}).category==="unknown_tool","non-candidate original tool is rejected while original schema remains authoritative");
assert(decision({type:"tool_call",name:"echo_tool",arguments:{value:"ok"}}).ok,"valid compact-catalog decision passes full original schema");

const repair=buildRepairContract(allowed,"required","argument_type_error");
assert(repair.includes("argument_type_error")&&repair.length<optimized.contract.length,"repair contract contains only compact corrective catalog");
const actionContract=buildToolContractDetails(downloadSelection.tools,"auto",downloadSelection.actionIntent),missContract=buildToolMissRecoveryContract(downloadSelection.matchingTools,downloadSelection.actionIntent);assert(actionContract.contract.includes("必须选择 tool_call")&&actionContract.contract.includes("download"),"Agent contract explicitly prioritizes tool execution for detected actions");assert(missContract.includes("Tool Miss Recovery")&&missContract.length<actionContract.contract.length,"tool-miss recovery uses a smaller one-time reminder");

const req=headers=>({headers});
const openA1=resolveSession(req({"x-companion-workspace":"/Users/example-4/a/SameName"}),{},"opencode"),openA2=resolveSession(req({"x-companion-workspace":"/Users/example-4/a/SameName"}),{},"opencode"),openB=resolveSession(req({"x-companion-workspace":"/Users/example-4/b/SameName"}),{},"opencode");
assert(openA1.sessionKey===openA2.sessionKey&&openA1.sessionKey!==openB.sessionKey,"OpenCode workspace hashes are stable and same-name paths remain isolated");
assert(!openA1.sessionKey.includes("/Users/example-demo"),"OpenCode Session key never exposes the full path");
const harnessA=resolveSession(req({"x-session-id":"harness-session-a"}),{},"harness"),harnessAgain=resolveSession(req({"x-session-id":"harness-session-a"}),{},"harness"),harnessB=resolveSession(req({"x-session-id":"harness-session-b"}),{},"harness");
assert(harnessA.sessionKey===harnessAgain.sessionKey&&harnessA.sessionKey!==harnessB.sessionKey&&harnessA.strategy==="project","Harness session affinity header becomes a stable isolated Project Session");
const explicit=resolveSession(req({"x-companion-session":"manual-wins","x-companion-workspace":"/ignored"}),{},"opencode");assert(explicit.sessionKey==="manual-wins"&&explicit.strategy==="explicit_header","explicit Session keeps highest priority");

console.log("PASS v0.2.6.0 action-intent Tool Candidate Selector, compact contract, tool-miss recovery, decision classification, and project Session unit tests",{full_tools:foundations.length,candidate_tools:foundationSelection.tools.length,legacy_contract_tokens:estimateContractTokens(fullContract),optimized_contract_tokens:optimized.tokenEstimate});
