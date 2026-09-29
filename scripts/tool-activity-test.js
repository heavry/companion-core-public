process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_PRIMARY_BASE_URL="";
process.env.UPSTREAM_SECONDARY_BASE_URL="";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_API_KEY="";
process.env.UPSTREAM_PRIMARY_API_KEY="";
process.env.UPSTREAM_SECONDARY_API_KEY="";
process.env.UPSTREAM_CHAT_API_KEY="";
process.env.UPSTREAM_AGENT_API_KEY="";
process.env.UPSTREAM_SUMMARY_API_KEY="";
process.env.TAVILY_API_KEY="";
process.env.TAVILY_BASE_URL="";
process.env.SEARXNG_BASE_URL="";

const { classifyToolFailure,safeToolActivityDetail,toolActivityMetadata,toolResultFailed } = await import("../src/tool-activity.js");

const assert=(value,message)=>{if(!value)throw new Error(`ASSERT: ${message}`);};

assert(safeToolActivityDetail("browser_navigate",{url:"https://example.com/path?token=secret"})==="example.com","browser detail keeps only public domain");
assert(safeToolActivityDetail("web_search",{query:"Authorization: Bearer secret"})===null,"sensitive search text is omitted");
assert(safeToolActivityDetail("upload_file",{path:"/Users/example-2/private/report.png"})==="report.png","local path becomes filename only");
assert(safeToolActivityDetail("browser_click",{Authorization:"Bearer secret",token:"secret"})===null,"unknown sensitive args are never summarized");

const web=toolActivityMetadata({wireName:"web_search",args:{query:"Companion repository"},sourceHint:"core"});
assert(web.integration_name==="Tavily"&&web.display_name==="web_search"&&web.detail==="Companion repository","web search gets safe friendly metadata");
const mcp=toolActivityMetadata({wireName:"mcp_dynamic_browser_navigate",args:{url:"https://github.com/x?q=secret"},mcpMetadata:{sourceType:"mcp",sourceId:"playwright_1234",integrationName:"Playwright",displayName:"browser_navigate"}});
assert(mcp.integration_name==="Playwright"&&mcp.display_name==="browser_navigate"&&mcp.detail==="github.com","MCP registry metadata wins over raw namespace");
const terminal=toolActivityMetadata({wireName:"terminal_exec",args:{executable:"/bin/bash",args:["-lc","secret command"]},sourceHint:"native"});assert(terminal.integration_name==="Terminal"&&terminal.display_name==="执行命令"&&terminal.detail===null,"terminal commands never enter Tool Activity detail");
const filesystem=toolActivityMetadata({wireName:"fs_patch",args:{path:"/Users/example-3/project/feature.js"},sourceHint:"native"});assert(filesystem.integration_name==="Filesystem"&&filesystem.display_name==="修改文件"&&filesystem.detail==="feature.js","filesystem activity exposes filename only");
assert(safeToolActivityDetail("fs_read",{path:"/Users/example-3/project/.env"})===null,"credential-bearing filenames are omitted from Tool Activity");
const selfDeploy=toolActivityMetadata({wireName:"self_deploy",args:{},sourceHint:"native"});assert(selfDeploy.integration_name==="Self Maintenance"&&selfDeploy.display_name==="部署 Candidate"&&selfDeploy.detail===null,"self-maintenance activity stays compact and safe");
const packageInstall=toolActivityMetadata({wireName:"package_install",args:{manager:"npm",packages:[{name:"fixture",version:"1.0.0"}]},sourceHint:"native"});assert(packageInstall.integration_name==="Package Manager"&&packageInstall.display_name==="安装依赖"&&packageInstall.detail===null,"package provenance stays out of compact Tool Activity detail");
assert(toolResultFailed("[mcp tool error] internal failure")&&toolResultFailed("tool reported an error")&&!toolResultFailed("normal result"),"tool failure classification is conservative");
const entitlement=classifyToolFailure('[mcp tool error] validation_error entitlement_required Searching workspace agents requires Notion AI and custom-agent access');
assert(entitlement.failure_category==="provider_error"&&entitlement.failure_code==="provider_entitlement_required","provider entitlement is not mislabeled as Companion permission");
const denied=classifyToolFailure('[companion tool failure] {"category":"approval_denied","code":"TOOL_EXECUTION_NOT_APPROVED","summary":"用户拒绝了此操作"}');
assert(denied.failure_category==="approval_denied","structured permission failure remains explainable");
assert(!JSON.stringify({web,mcp}).match(/token=secret|Bearer secret|\/Users\/person/),"presentation metadata contains no secret or home path");

console.log("PASS Tool Activity: safe domains/filenames, registry names, failure status, secret redaction");
