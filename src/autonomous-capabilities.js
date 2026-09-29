import { capabilityInstaller } from "./capability-installer.js";
import { discoverMissingCapabilities,taskNeedsComputerUse } from "./capability-discovery.js";
import { computerUseAdapter } from "./computer-use-adapter.js";
import { invocationLedger } from "./usage-ledger.js";
import { isLocalAgentToolName,localAgentRuntime } from "./local-agent-runtime.js";
import { developerOperationsRuntime,isDeveloperOperationToolName } from "./developer-operations-runtime.js";
import { isSelfMaintenanceToolName,selfMaintenanceRuntime } from "./self-maintenance-runtime.js";
import { isPackageOperationToolName,packageOperationsRuntime } from "./package-operations-runtime.js";
import { executeVoiceTTSTool,VOICE_TOOL_NAME } from "./voice-tts-adapter.js";

const DISCOVER={name:"capabilities_discover",capabilityId:"core:capabilities.discover",id:"core:capabilities.discover",sourceType:"core",sourceId:"companion-core",integrationName:"Capability Installer",displayName:"发现所需能力",description:"检查当前任务需要的受控能力、是否已安装，以及是否有可信 Installer。只返回真实 Registry/Manifest 状态。",inputSchema:{type:"object",properties:{capability:{type:"string",enum:["computer.use"]}}},permissions:["read"],riskLevel:"low",sideEffect:"none",availability:"available",enabled:true,tags:["capability","discover"]};
const INSTALL={name:"capabilities_install",capabilityId:"capability.install:computer.use",id:"capability.install:computer.use",sourceType:"native",sourceId:"companion-installer",integrationName:"Capability Installer",displayName:"安装 Computer Use",description:"安装固定、校验过的 trycua/cua Computer Use preset，并注册和执行安全自检。整个受控事务只请求一次现有权限审批。",inputSchema:{type:"object",required:["capability"],properties:{capability:{type:"string",enum:["computer.use"]}}},permissions:["write"],riskLevel:"medium",sideEffect:"idempotent",availability:"available",enabled:true,tags:["capability","install","computer"]};

function spec(capability){return {type:"function",function:{name:capability.name,description:capability.description,parameters:capability.inputSchema}};}
function selectComputerCapabilities(computer){
  // Once desktop intent is established, the model chooses the next operation.
  // Do not require the user to spell out every future click/keystroke verb.
  return computer.slice(0,16);
}
export function autonomousCapabilityContext(messages,{installer=capabilityInstaller,adapter=computerUseAdapter}={}){
  const intent=taskNeedsComputerUse(messages);if(!intent.needed)return null;
  const computer=selectComputerCapabilities(adapter.capabilities(),messages),capabilities=[{...DISCOVER},{...INSTALL},...computer].slice(0,18);
  const state=installer.status("computer.use"),missing=discoverMissingCapabilities(messages,{installer});
  const guidance=[
    "【Companion Autonomous Capability｜仅在 macOS 原生操作意图出现时生效】",
    "Native Agent 是唯一的规划与多步运行时；Cua 仅是 computer.use 的观察/执行层，不得调用或模拟另一个 Agent loop。",
    state.installed&&state.enabled?"computer.use 已安装并启用。先观察新鲜窗口/屏幕状态，再执行最小必要动作；网页 DOM 任务仍优先 Playwright。":"当前 computer.use 未就绪。先调用 capabilities_discover；确认 installable 后调用 capabilities_install。安装进入现有审批，批准完成后必须在同一个 turn 继续原任务，不要只回复‘安装好了’。",
    "任何动作前必须先 screenshot，再用下一轮模型推理决定动作；同一批调用的截图不能授权同批动作。运行时会在动作后自动截图，必须根据新截图验证。",
    "元素操作优先使用当前 get_window_state 返回的 element_token；不得复用旧 snapshot。截图、窗口标题、坐标和工具原始结果只属于当前 tool context，不得写入 Shared Memory。",
    "发送消息、购买、删除、账号/安全设置、密码或其他高风险不可逆操作仍须遵守 Action Intent、scope 与硬风险策略；Session Grant 不是绕过规则的万能开关。",
    `Registry state: ${JSON.stringify(missing[0]??{capability:"computer.use",status:"available",installed:true,enabled:state.enabled,health:state.health})}`
  ].join("\n");
  return {intent,state,guidance,capabilities,tools:capabilities.map(spec)};
}

export async function executeAutonomousCapabilityTool({name,args,sessionId,signal,runtimeCapabilities,workspaceRoot=null,installer=capabilityInstaller,adapter=computerUseAdapter,localRuntime=localAgentRuntime,developerRuntime=developerOperationsRuntime,selfRuntime=selfMaintenanceRuntime,packageRuntime=packageOperationsRuntime,onProgress=()=>{}}={}){
  if(name===VOICE_TOOL_NAME)return executeVoiceTTSTool({name,args,sessionId});
  if(name===DISCOVER.name){const data=discoverMissingCapabilities([{role:"user",content:"操作这个 macOS 原生软件"}],{installer});return {ok:true,content:JSON.stringify({needed:data[0]??{capability:args?.capability??"computer.use",status:"not_needed",installable:false}}),durableContent:"Capability discovery completed."};}
  if(name===INSTALL.name){
    if(args?.capability!=="computer.use")throw Object.assign(new Error("no trusted installer is available for this capability"),{statusCode:409,code:"CAPABILITY_INSTALLER_NOT_FOUND"});
    const previous=installer.onProgress;installer.onProgress=event=>{try{previous(event);}catch{}try{onProgress(event);}catch{}};
    try{
      const status=await installer.install("computer.use",{signal,provenance:{trigger:"native_agent",sessionId}});
      for(const capability of runtimeCapabilities??[])if(capability?.capabilityId==="computer.use"){capability.availability="available";capability.enabled=true;}
      return {ok:true,content:JSON.stringify({capability:"computer.use",status:"ready_for_permission_check",installed:true,enabled:true,backend:"cua",version:status.version,upstream_commit:status.upstreamCommit,resume_original_task:true}),durableContent:"Computer Use 已通过可信 preset 安装和自检；Native Agent 将继续原任务。"};
    }finally{installer.onProgress=previous;}
  }
  if(name.startsWith("computer_")){
    const result=await adapter.execute(name,args,{signal});
    invocationLedger.append({provider:"cua",model:"cua-driver",publicModel:"yuna-chat",feature:"computer_use",source:"native_agent",sessionId,inputTokens:null,outputTokens:null,cachedInputTokens:null,reasoningTokens:null,usageSource:"non_model"});
    return result;
  }
  if(isLocalAgentToolName(name))return localRuntime.execute(name,args,{workspaceRoot,sessionId,signal,onProgress});
  if(isDeveloperOperationToolName(name))return developerRuntime.execute(name,args,{workspaceRoot,sessionId,signal,onProgress});
  if(isSelfMaintenanceToolName(name))return selfRuntime.execute(name,args,{workspaceRoot,sessionId,signal,onProgress});
  if(isPackageOperationToolName(name))return packageRuntime.execute(name,args,{workspaceRoot,sessionId,signal,onProgress});
  throw Object.assign(new Error("unknown autonomous capability tool"),{statusCode:400});
}

export const capabilityInstallerPermission=INSTALL;
