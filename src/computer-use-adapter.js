import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";
import { capabilityInstaller } from "./capability-installer.js";
import { redactSecrets } from "./runtime.js";

const ACTIONS=Object.freeze({
  computer_screen_observe:{driver:"get_accessibility_tree",displayName:"观察屏幕",description:"读取当前 macOS 应用和窗口的轻量结构，不截取屏幕。",permissions:["screen.read"],riskLevel:"low",sideEffect:"none",schema:{type:"object",properties:{}}},
  computer_screen_screenshot:{driver:"get_desktop_state",displayName:"截取屏幕",description:"截取当前主显示器，用于当前 Agent turn 的视觉定位；截图不会写入长期记忆。",permissions:["screen.read"],riskLevel:"low",sideEffect:"none",schema:{type:"object",properties:{session:{type:"string",maxLength:80}}}},
  computer_window_list:{driver:"list_windows",displayName:"查看窗口",description:"列出 macOS 顶层窗口。",permissions:["screen.read"],riskLevel:"low",sideEffect:"none",schema:{type:"object",properties:{on_screen_only:{type:"boolean"},pid:{type:"integer",minimum:1}}}},
  computer_window_observe:{driver:"get_window_state",displayName:"观察窗口",description:"读取一个窗口的辅助功能结构并可同时截取该窗口。操作元素前应先观察并使用新鲜 element_token。",permissions:["screen.read"],riskLevel:"low",sideEffect:"none",schema:{type:"object",required:["pid","window_id"],properties:{pid:{type:"integer",minimum:1},window_id:{type:"integer",minimum:1},include_screenshot:{type:"boolean"},query:{type:"string",maxLength:200},max_elements:{type:"integer",minimum:1,maximum:2000},max_depth:{type:"integer",minimum:1,maximum:25},session:{type:"string",maxLength:80}}}},
  computer_mouse_click:{driver:"click",displayName:"点击",description:"点击一个刚观察到的元素；优先使用 element_token，只有自绘界面才使用坐标。",permissions:["mouse.control"],riskLevel:"medium",sideEffect:"idempotent",schema:{type:"object",required:["pid"],properties:{pid:{type:"integer",minimum:1},element_token:{type:"string",maxLength:1000},element_index:{type:"integer",minimum:0},snapshot_id:{type:"string",pattern:"^s[0-9a-f]{8}$"},window_id:{type:"integer",minimum:1},x:{type:"number"},y:{type:"number"},button:{type:"string",enum:["left","right","middle"]},action:{type:"string",enum:["press","show_menu","pick","confirm","cancel","open"]},delivery_mode:{type:"string",enum:["background","foreground"]},session:{type:"string",maxLength:80}},oneOf:[{required:["element_token"]},{required:["element_index","snapshot_id","window_id"]},{required:["x","y"]}]}},
  computer_mouse_double_click:{driver:"double_click",displayName:"双击",description:"双击刚观察到的元素或自绘界面坐标。",permissions:["mouse.control"],riskLevel:"medium",sideEffect:"idempotent",schema:{type:"object",required:["pid"],properties:{pid:{type:"integer",minimum:1},element_token:{type:"string",maxLength:1000},element_index:{type:"integer",minimum:0},snapshot_id:{type:"string",pattern:"^s[0-9a-f]{8}$"},window_id:{type:"integer",minimum:1},x:{type:"number"},y:{type:"number"},delivery_mode:{type:"string",enum:["background","foreground"]},session:{type:"string",maxLength:80}},oneOf:[{required:["element_token"]},{required:["element_index","snapshot_id","window_id"]},{required:["x","y"]}]}},
  computer_mouse_move:{driver:"move_cursor",displayName:"移动指针",description:"移动 macOS 指针；scope=desktop 时移动真实系统指针。",permissions:["mouse.control"],riskLevel:"medium",sideEffect:"idempotent",schema:{type:"object",required:["x","y"],properties:{x:{type:"number"},y:{type:"number"},scope:{type:"string",enum:["window","desktop"]},target:{type:"object"},cursor_id:{type:"string",maxLength:80},session:{type:"string",maxLength:80}}}},
  computer_mouse_drag:{driver:"drag",displayName:"拖动",description:"在刚观察到的窗口或屏幕上拖动。",permissions:["mouse.control"],riskLevel:"medium",sideEffect:"non_idempotent",schema:{type:"object",required:["from_x","from_y","to_x","to_y"],properties:{from_x:{type:"number"},from_y:{type:"number"},to_x:{type:"number"},to_y:{type:"number"},pid:{type:"integer",minimum:1},window_id:{type:"integer",minimum:1},scope:{type:"string",enum:["window","desktop"]},target:{type:"object"},duration_ms:{type:"integer",minimum:0,maximum:10000},steps:{type:"integer",minimum:1,maximum:200},button:{type:"string",enum:["left","right","middle"]},delivery_mode:{type:"string",enum:["background","foreground"]},session:{type:"string",maxLength:80}}}},
  computer_keyboard_type:{driver:"type_text",displayName:"输入文字",description:"向刚观察到并由用户授权的目标输入普通文字。密码、密钥和不可逆提交仍受硬规则限制。",permissions:["keyboard.control"],riskLevel:"medium",sideEffect:"non_idempotent",schema:{type:"object",required:["text"],properties:{text:{type:"string",maxLength:8000},pid:{type:"integer",minimum:1},element_token:{type:"string",maxLength:1000},element_index:{type:"integer",minimum:0},snapshot_id:{type:"string",pattern:"^s[0-9a-f]{8}$"},window_id:{type:"integer",minimum:1},x:{type:"number"},y:{type:"number"},scope:{type:"string",enum:["window","desktop"]},delivery_mode:{type:"string",enum:["background","foreground"]},delay_ms:{type:"integer",minimum:0,maximum:200},session:{type:"string",maxLength:80}}}},
  computer_keyboard_key:{driver:"press_key",displayName:"按键",description:"按一个键，可指定刚观察到的元素。",permissions:["keyboard.control"],riskLevel:"medium",sideEffect:"idempotent",schema:{type:"object",required:["key"],properties:{key:{type:"string",maxLength:40},pid:{type:"integer",minimum:1},window_id:{type:"integer",minimum:1},element_token:{type:"string",maxLength:1000},element_index:{type:"integer",minimum:0},snapshot_id:{type:"string",pattern:"^s[0-9a-f]{8}$"},modifiers:{type:"array",maxItems:6,items:{type:"string",maxLength:20}},scope:{type:"string",enum:["window","desktop"]},delivery_mode:{type:"string",enum:["background","foreground"]},session:{type:"string",maxLength:80}}}},
  computer_keyboard_hotkey:{driver:"hotkey",displayName:"快捷键",description:"执行 macOS 快捷键。",permissions:["keyboard.control"],riskLevel:"medium",sideEffect:"non_idempotent",schema:{type:"object",required:["keys"],properties:{keys:{type:"array",minItems:2,maxItems:6,items:{type:"string",maxLength:40}},pid:{type:"integer",minimum:1},window_id:{type:"integer",minimum:1},element_token:{type:"string",maxLength:1000},scope:{type:"string",enum:["window","desktop"]},delivery_mode:{type:"string",enum:["background","foreground"]},session:{type:"string",maxLength:80}}}},
  computer_scroll:{driver:"scroll",displayName:"滚动",description:"在当前界面按方向滚动，可定位到刚观察到的元素或像素区域。",permissions:["mouse.control"],riskLevel:"medium",sideEffect:"idempotent",schema:{type:"object",required:["direction"],properties:{direction:{type:"string",enum:["up","down","left","right"]},amount:{type:"integer",minimum:1,maximum:50},by:{type:"string",enum:["line","page"]},pid:{type:"integer",minimum:1},window_id:{type:"integer",minimum:1},element_token:{type:"string",maxLength:1000},x:{type:"number"},y:{type:"number"},scope:{type:"string",enum:["window","desktop"]},delivery_mode:{type:"string",enum:["background","foreground"]},session:{type:"string",maxLength:80}}}},
  computer_window_focus:{driver:"bring_to_front",displayName:"聚焦窗口",description:"将指定 macOS 应用或窗口切到前台。",permissions:["window.control"],riskLevel:"medium",sideEffect:"idempotent",schema:{type:"object",required:["pid"],properties:{pid:{type:"integer",minimum:1},window_id:{type:"integer",minimum:1}}}},
  computer_app_launch:{driver:"launch_app",displayName:"打开应用",description:"按 bundle id 或名称打开一个 macOS 应用。",permissions:["app.launch"],riskLevel:"medium",sideEffect:"idempotent",schema:{type:"object",properties:{bundle_id:{type:"string",maxLength:240},name:{type:"string",maxLength:160},urls:{type:"array",maxItems:8,items:{type:"string",maxLength:2000}},creates_new_application_instance:{type:"boolean"}},oneOf:[{required:["bundle_id"]},{required:["name"]}]}}
  ,computer_app_activate:{driver:"bring_to_front",displayName:"激活应用",description:"激活一个已运行的 macOS 应用，并可聚焦指定窗口。",permissions:["app.launch","window.control"],riskLevel:"medium",sideEffect:"idempotent",schema:{type:"object",required:["pid"],properties:{pid:{type:"integer",minimum:1},window_id:{type:"integer",minimum:1}}}}
});

function modelContent(result){
  const blocks=Array.isArray(result?.content)?result.content:[];const out=[];
  for(const block of blocks){
    if(block?.type==="text"&&typeof block.text==="string")out.push({type:"text",text:block.text.slice(0,config.mcpToolResultMaxChars)});
    else if(block?.type==="image"&&typeof block.data==="string"&&/^image\/(?:png|jpeg|webp)$/.test(String(block.mimeType??"")))out.push({type:"image_url",image_url:{url:`data:${block.mimeType};base64,${block.data}`}});
  }
  if(result?.structuredContent&&typeof result.structuredContent==="object")out.push({type:"text",text:JSON.stringify(result.structuredContent).slice(0,config.mcpToolResultMaxChars)});
  if(!out.length)out.push({type:"text",text:"Computer Use completed without a content payload."});
  return out.length===1&&out[0].type==="text"?out[0].text:out;
}

function resultText(result){return (Array.isArray(result?.content)?result.content:[]).filter(block=>block?.type==="text").map(block=>String(block.text??"")).join("\n").slice(0,4000);}
function safeDriverStderr(value){const text=redactSecrets(String(value??"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim(),480);return text&&!text.includes("[REDACTED]")?text.slice(-240):null;}
function structuredCode(result){const structured=result?.structuredContent&&typeof result.structuredContent==="object"?result.structuredContent:{};return String(structured?.refusal?.code??structured.error??structured.code??"").toUpperCase();}
function sessionEndedResult(result){return String(result?.structuredContent?.status??"").toLowerCase()==="refused"&&String(result?.structuredContent?.refusal?.code??"").toLowerCase()==="session_ended";}
function computerUseFailure({result,error,timedOut=false,action,stderr}={}){
  const structured=result?.structuredContent&&typeof result.structuredContent==="object"?result.structuredContent:{};
  const upstreamCode=structuredCode(result)||String(error?.code??"").toUpperCase();
  const detail=`${upstreamCode} ${resultText(result)} ${String(error?.message??"")}`.slice(0,5000);
  let category="driver_error",code="computer_use_driver_error",summary=`${ACTIONS[action]?.displayName??"Computer Use"}失败`,reason="Cua Driver returned an unclassified error";
  if(upstreamCode==="SESSION_ENDED"){category="lifecycle_session";code="computer_use_session_ended";summary="Computer Use 正在重新连接";reason="Cua rejected the request before dispatch because its logical session had ended";}
  else if(timedOut||/TIMEOUT|TIMED OUT/.test(detail)){category="timeout";code="computer_use_timeout";reason="Computer Use action exceeded its bounded timeout";}
  else if(/APP_NOT_INSTALLED|APP_NOT_FOUND|COULD NOT LOCATE APP|NO INSTALLED MACOS APP/.test(detail)){category="app_not_found";code="computer_use_app_not_found";summary="未找到要打开的应用";reason="Cua launch_app could not resolve the requested installed application";}
  else if(/PERMISSION|ACCESSIBILITY|SCREEN_RECORDING|SCREEN RECORDING|TCC/.test(detail)){category="permission_required";code="computer_use_permission_required";summary="Computer Use 需要 macOS 权限";reason="Cua explicitly reported a missing macOS permission";}
  else if(/INVALID_ARGUMENT|INVALID ARGUMENT|MISSING REQUIRED|PROVIDE EITHER|SCHEMA|AMBIGUOUS_WINDOW_TARGET|WINDOW_OWNER_PID_MISMATCH/.test(detail)){category="invalid_argument";code="computer_use_invalid_argument";reason="Cua rejected the normalized action arguments or target selection";}
  else if(/BRING_TO_FRONT_EXACT_WINDOW_UNVERIFIED|BRING_TO_FRONT_PROCESS_UNVERIFIED/.test(detail)){category="activation_failed";code="computer_use_activation_failed";reason="Cua accepted the foreground request but could not verify the requested app/window as visible and frontmost";}
  else if(/UNSUPPORTED|NOT_SUPPORTED|ACTION_NOT_ALLOWED/.test(detail)){category="unsupported_action";code="computer_use_unsupported_action";reason="The requested action is not supported by this Cua backend";}
  else if(/COMPUTER_USE_SESSION_RECOVERY_FAILED/.test(detail)){category="lifecycle_session";code="computer_use_session_recovery_failed";summary="Computer Use 重新连接失败";reason="Cua could not restore its ended logical session";}
  else if(/ECONN|BROKEN PIPE|CONNECTION|TRANSPORT|UNAVAILABLE|NOT INSTALLED AND ENABLED|CLOSED/.test(detail)){category="driver_unavailable";code="computer_use_driver_unavailable";summary="Computer Use Driver 不可用";reason="The Cua driver process or transport is unavailable";}
  return {category,code,summary,reason,upstream_code:upstreamCode||null,driver_stderr:safeDriverStderr(stderr),...(upstreamCode==="SESSION_ENDED"?{safeToReplay:true,rejectedBeforeDispatch:true}:{})};
}

export function createRequestStderrDiagnostics({maxChars=8192}={}){
  let sequence=0,totalChars=0,entries=[];
  const trim=()=>{while(totalChars>maxChars&&entries.length>1){totalChars-=entries[0].text.length;entries.shift();}};
  return {append(chunk){const text=String(chunk??"");if(!text)return;entries.push({sequence:++sequence,text});totalChars+=text.length;trim();},mark(){return sequence;},since(mark){return entries.filter(entry=>entry.sequence>Number(mark||0)).map(entry=>entry.text).join("").slice(-maxChars);},get tail(){return entries.map(entry=>entry.text).join("").slice(-maxChars);}};
}

function stderrMark(connection){return typeof connection?.stderr?.mark==="function"?connection.stderr.mark():0;}
function stderrSince(connection,mark){return typeof connection?.stderr?.since==="function"?connection.stderr.since(mark):"";}
async function callDriver(connection,name,args,signal){const mark=stderrMark(connection);try{return {result:await connection.client.callTool({name,arguments:args},undefined,{signal}),stderr:stderrSince(connection,mark)};}catch(error){error.companionRequestStderr=stderrSince(connection,mark);throw error;}}
function abortIfNeeded(signal){if(signal?.aborted)throw Object.assign(new Error("Computer Use cancelled"),{name:"AbortError"});}
function waitWithSignal(promise,signal){if(!signal)return promise;if(signal.aborted)return Promise.reject(Object.assign(new Error("Computer Use cancelled"),{name:"AbortError"}));return new Promise((resolve,reject)=>{const abort=()=>reject(Object.assign(new Error("Computer Use cancelled"),{name:"AbortError"}));signal.addEventListener("abort",abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));});}

function windowBounds(window){const bounds=window?.bounds??{};return {width:Number(bounds.width??bounds.w??0)||0,height:Number(bounds.height??bounds.h??0)||0};}
export function selectMainWindow(windows,pid){
  const candidates=(Array.isArray(windows)?windows:[]).filter(window=>Number(window?.pid)===Number(pid)&&Number(window?.window_id)>0&&Number(window?.layer??0)===0).map(window=>{const {width,height}=windowBounds(window),area=Math.max(0,width)*Math.max(0,height),standard=String(window?.role??"")==="AXWindow"||String(window?.subrole??"")==="AXStandardWindow",normalSize=width>=240&&height>=160;return {window,area,standard,normalSize,minimized:window?.minimized===true,onCurrent:window?.on_current_space===true,onScreen:window?.is_on_screen===true,z:Number.isInteger(window?.z_index)?window.z_index:-1_000_000_000};});
  candidates.sort((a,b)=>Number(b.standard)-Number(a.standard)||Number(b.normalSize)-Number(a.normalSize)||Number(a.minimized)-Number(b.minimized)||b.area-a.area||Number(b.onCurrent)-Number(a.onCurrent)||Number(b.onScreen)-Number(a.onScreen)||b.z-a.z||Number(a.window.window_id)-Number(b.window.window_id));
  const chosen=candidates[0];if(!chosen)return null;return {windowId:Number(chosen.window.window_id),windowCount:candidates.length,onCurrentSpace:chosen.window.on_current_space??null,isOnScreen:chosen.window.is_on_screen??null,minimized:chosen.window.minimized??null,rationale:{standardWindow:chosen.standard,normalSize:chosen.normalSize,largestUsableArea:candidates.every((item,index)=>index===0||chosen.area>=item.area)}};
}
function safeDurableSummary(action,result,failure=null){
  const label=ACTIONS[action]?.displayName??"Computer Use";
  return failure?`[companion tool failure] ${JSON.stringify(failure)}`:`Computer Use 已完成：${label}。详细屏幕观察仅保留在当前运行上下文，不写入长期聊天正文或 Shared Memory。`;
}

function execFileText(file,args,{signal,timeout=5000}={}){return new Promise((resolve,reject)=>execFile(file,args,{encoding:"utf8",maxBuffer:256*1024,timeout,signal},(error,stdout)=>error?reject(error):resolve(stdout)));}
function metadataQueryValue(value){return String(value).replace(/\\/g,"\\\\").replace(/"/g,'\\"');}
async function spotlightBundleId(name,{signal}={}){
  if(process.platform!=="darwin")return null;
  const query=`kMDItemContentType == "com.apple.application-bundle" && kMDItemDisplayName == "${metadataQueryValue(name)}"cd`;
  let paths=[];try{paths=(await execFileText("/usr/bin/mdfind",[query],{signal})).split(/\r?\n/).map(item=>item.trim()).filter(item=>item.endsWith(".app")).slice(0,12);}catch{return null;}
  const matches=[];for(const appPath of paths){try{const bundleId=(await execFileText("/usr/bin/mdls",["-raw","-name","kMDItemCFBundleIdentifier",appPath],{signal,timeout:2000})).trim().replace(/^"|"$/g,"");if(bundleId&&bundleId!=="(null)")matches.push({bundleId,appPath});}catch{}}
  const unique=[...new Map(matches.map(item=>[item.bundleId,item])).values()];return unique.length===1?unique[0]:null;
}
async function resolveMacOSApp(name,{client,signal}={}){
  const requested=String(name??"").trim();if(!requested)return null;
  try{const listed=await client.callTool({name:"list_apps",arguments:{}},undefined,{signal});const apps=Array.isArray(listed?.structuredContent?.apps)?listed.structuredContent.apps:[];const folded=requested.toLocaleLowerCase();const exact=apps.filter(app=>[app?.name,app?.bundle_id,path.basename(String(app?.launch_path??""),".app")].some(value=>String(value??"").toLocaleLowerCase()===folded));const unique=[...new Map(exact.filter(app=>app?.bundle_id).map(app=>[app.bundle_id,app])).values()];if(unique.length===1)return {bundleId:unique[0].bundle_id,appPath:unique[0].launch_path??null,source:"cua_list_apps"};}catch{}
  const spotlight=await spotlightBundleId(requested,{signal});return spotlight?{...spotlight,source:"launchservices_metadata"}:null;
}
async function activateExistingMacOSApp(bundleId,{signal}={}){if(process.platform!=="darwin"||!bundleId)return false;await execFileText("/usr/bin/open",["-b",String(bundleId)],{signal,timeout:10000});return true;}
async function runningBundleId(client,pid,{signal}={}){try{const listed=await client.callTool({name:"list_apps",arguments:{}},undefined,{signal});const apps=Array.isArray(listed?.structuredContent?.apps)?listed.structuredContent.apps:[];const app=apps.find(item=>Number(item?.pid??item?.process_id??item?.running_pid)===Number(pid));return typeof app?.bundle_id==="string"&&app.bundle_id?app.bundle_id:null;}catch{return null;}}

const HIGH_RISK_ACTION=/(?:delete|remove|trash|erase|send|submit|publish|post|purchase|buy|pay|transfer|password|credential|token|account security|删除|移除|废纸篓|清空|发送|提交|发布|购买|支付|转账|密码|凭据|密钥|账号安全)/i;
function invocationRisk(definition,args){
  const description=String(args?.target_description??args?.action_intent??"");
  const text=definition.driver==="type_text"?`${description} ${String(args?.text??"")}`:description;
  const keys=Array.isArray(args?.keys)?args.keys.map(String).join("+"):String(args?.key??"");
  const dangerousShortcut=/(?:cmd|command).*(?:return|enter)|(?:delete|backspace)/i.test(keys)&&HIGH_RISK_ACTION.test(description);
  if(["click","double_click","drag","type_text","press_key","hotkey"].includes(definition.driver)||args?.urls?.length||HIGH_RISK_ACTION.test(text)||dangerousShortcut)return {requiresConfirmation:true,hardSafetyBoundary:true,riskLevel:"high",permissions:[...new Set([...(definition.permissions??[]),"write","external_action",...(/(?:password|credential|token|密码|凭据|密钥)/i.test(text)?["sensitive"]:[])])],sideEffect:"non_idempotent"};
  return null;
}
function exposedSchema(definition){
  const schema={...definition.schema,additionalProperties:false};
  if(definition.riskLevel==="low")return schema;
  return {...schema,properties:{...(schema.properties??{}),target_description:{type:"string",maxLength:240,description:"用人类可读文字说明要操作的控件或结果；Companion 用它执行高风险硬边界判断，不传给 Cua Driver。"}}};
}
function computerCapability(name,definition,availability){const schema=exposedSchema(definition);const capability={name,capabilityId:"computer.use",id:"computer.use",sourceType:"native",sourceId:"cua",integrationName:"Computer Use",displayName:definition.displayName,description:definition.description,inputSchema:schema,parameters:schema,permissions:definition.permissions,riskLevel:definition.riskLevel,sideEffect:definition.sideEffect,availability,enabled:availability==="available",tags:["computer","macos","desktop","cua"]};capability.resolveInvocation=args=>{const elevated=invocationRisk(definition,args);return elevated?{...capability,...elevated,resolveInvocation:null}:null;};return capability;}

function driverArguments(args){const out={...(args??{})};delete out.target_description;delete out.action_intent;return out;}

export class ComputerUseAdapter{
  constructor({installer=capabilityInstaller,clientFactory=null,actionTimeoutMs=config.computerUseActionTimeoutMs,appResolver=resolveMacOSApp,appActivator=activateExistingMacOSApp}={}){this.installer=installer;this.clientFactory=clientFactory;this.actionTimeoutMs=actionTimeoutMs;this.appResolver=appResolver;this.appActivator=appActivator;this.connection=null;this.connectPromise=null;this.recoveryPromise=null;this.lifecycleState={process:"stopped",transport:"disconnected",session:"none"};}
  definitions(){return ACTIONS;}
  runtimeState(){return {...this.lifecycleState};}
  capabilities(){const status=this.installer.status("computer.use"),availability=status.installed&&status.enabled?"available":status.installed?"disabled":"not_installed";return Object.entries(ACTIONS).map(([name,definition])=>computerCapability(name,definition,availability));}
  async connect(){
    if(this.connection)return this.connection;
    if(this.connectPromise)return this.connectPromise;
    const operation=(async()=>{const state=this.installer.status("computer.use");if(!state.installed||!state.enabled)throw Object.assign(new Error("computer.use is not installed and enabled"),{code:"COMPUTER_USE_UNAVAILABLE",statusCode:409});
      if(this.clientFactory){const connection=await this.clientFactory();this.connection=connection;this.lifecycleState={process:"alive",transport:"connected",session:"active"};return connection;}
      const client=new Client({name:"companion-computer-use",version:config.version},{capabilities:{}});
      const transport=new StdioClientTransport({command:this.installer.binaryPath("computer.use"),args:["mcp","--direct"],env:this.installer.driverEnvironment(),stderr:"pipe"});
      const stderr=createRequestStderrDiagnostics();transport.stderr?.on?.("data",chunk=>stderr.append(chunk));
      try{await client.connect(transport);const connection={client,transport,stderr};this.connection=connection;this.lifecycleState={process:"alive",transport:"connected",session:"active"};return connection;}catch(error){this.lifecycleState={process:"failed",transport:"disconnected",session:"none"};try{await transport.close();}catch{}throw error;}
    })();
    const shared=operation.finally(()=>{if(this.connectPromise===shared)this.connectPromise=null;});this.connectPromise=shared;return shared;
  }
  async close(){const connection=this.connection;this.connection=null;this.recoveryPromise=null;this.lifecycleState={process:"stopped",transport:"disconnected",session:"none"};if(connection)try{await connection.client.close();}catch{}}
  async recoverSession(connection,{signal}={}){
    if(connection!==this.connection)throw Object.assign(new Error("Computer Use connection changed during recovery"),{code:"COMPUTER_USE_CONNECTION_CHANGED"});
    if(!this.recoveryPromise){this.lifecycleState={...this.lifecycleState,session:"recovering"};const recoverySignal=AbortSignal.timeout(this.actionTimeoutMs);const operation=(async()=>{const {result,stderr}=await callDriver(connection,"start_session",{},recoverySignal);if(result?.isError===true||sessionEndedResult(result))throw Object.assign(new Error("Cua start_session did not restore the logical session"),{code:"COMPUTER_USE_SESSION_RECOVERY_FAILED",companionRequestStderr:stderr});this.lifecycleState={...this.lifecycleState,session:"active"};return true;})();const shared=operation.finally(()=>{if(this.recoveryPromise===shared)this.recoveryPromise=null;if(this.lifecycleState.session==="recovering")this.lifecycleState={...this.lifecycleState,session:"ended"};});this.recoveryPromise=shared;}
    return waitWithSignal(this.recoveryPromise,signal);
  }
  async execute(action,args={}, {signal}={}){
    const definition=ACTIONS[action];if(!definition)throw Object.assign(new Error("unsupported Computer Use action"),{code:"COMPUTER_USE_ACTION_NOT_ALLOWED",statusCode:400});
    const connection=await this.connect();const timeout=AbortSignal.timeout(this.actionTimeoutMs);const combined=signal?AbortSignal.any([signal,timeout]):timeout;
    try{let normalized=driverArguments(args),windowSelection=null;if(definition.driver==="launch_app"&&!normalized.bundle_id&&normalized.name){const resolved=await this.appResolver(normalized.name,{client:connection.client,signal:combined});if(resolved?.bundleId){normalized={...normalized,bundle_id:resolved.bundleId};delete normalized.name;}}
      if(definition.driver==="bring_to_front"&&!normalized.window_id&&Number(normalized.pid)>0){const listed=await connection.client.callTool({name:"list_windows",arguments:{pid:Number(normalized.pid)}},undefined,{signal:combined});windowSelection=selectMainWindow(listed?.structuredContent?.windows,normalized.pid);if(windowSelection)normalized={...normalized,window_id:windowSelection.windowId};}
      let request=await callDriver(connection,definition.driver,normalized,combined),result=request.result,failure=result?.isError===true||sessionEndedResult(result)?computerUseFailure({result,action,stderr:request.stderr}):null,activationRecovery=null,sessionRecovery=null;
      if(failure?.code==="computer_use_session_ended"){if(!this.recoveryPromise)this.lifecycleState={...this.lifecycleState,session:"ended"};await this.recoverSession(connection,{signal:combined});abortIfNeeded(combined);const retry=await callDriver(connection,definition.driver,normalized,combined);result=retry.result;failure=result?.isError===true||sessionEndedResult(result)?computerUseFailure({result,action,stderr:retry.stderr}):null;sessionRecovery={attempted:true,retried:true,recovered:!failure};}
      if(action==="computer_app_activate"&&failure?.category==="activation_failed"){const firstFailureCode=failure.upstream_code,bundleId=await runningBundleId(connection.client,normalized.pid,{signal:combined});if(bundleId){try{await this.appActivator(bundleId,{signal:combined});const refreshed=await connection.client.callTool({name:"list_windows",arguments:{pid:Number(normalized.pid)}},undefined,{signal:combined}),nextSelection=selectMainWindow(refreshed?.structuredContent?.windows,normalized.pid);if(nextSelection){windowSelection=nextSelection;normalized={...normalized,window_id:nextSelection.windowId};const activated=await callDriver(connection,definition.driver,normalized,combined);result=activated.result;failure=result?.isError===true||sessionEndedResult(result)?computerUseFailure({result,action,stderr:activated.stderr}):null;activationRecovery={mechanism:"launchservices_open_existing",createdNewInstance:false,firstFailureCode};}}catch(error){failure=computerUseFailure({error,action,stderr:error?.companionRequestStderr});activationRecovery={mechanism:"launchservices_open_existing",createdNewInstance:false,firstFailureCode,failed:true};}}}
      if(failure?.category==="activation_failed"&&windowSelection?.onCurrentSpace===false)failure={...failure,category:"window_not_visible",code:"computer_use_window_not_visible",reason:"Cua could not verify that the off-Space window was brought to the current visible foreground"};return {ok:!failure,modelContent:modelContent(result),durableContent:safeDurableSummary(action,result,failure),driverTool:definition.driver,isError:Boolean(failure),failure,windowSelection,activationRecovery,sessionRecovery,normalizedArguments:definition.driver==="launch_app"?{bundle_id:normalized.bundle_id??null,name:normalized.name??null,urls:Array.isArray(normalized.urls)?normalized.urls.map(()=>"[target]"):undefined}:definition.driver==="bring_to_front"?{pid:normalized.pid,window_id:normalized.window_id??null}:undefined};}
    catch(error){if(signal?.aborted){throw Object.assign(new Error("Computer Use cancelled"),{name:"AbortError"});}const failure=computerUseFailure({error,timedOut:timeout.aborted,action,stderr:error?.companionRequestStderr});await this.close();return {ok:false,modelContent:JSON.stringify(failure),durableContent:safeDurableSummary(action,null,failure),driverTool:definition.driver,isError:true,failure};}
  }
  async permissions({signal}={}){const connection=await this.connect();let request=await callDriver(connection,"check_permissions",{prompt:false},signal);if(sessionEndedResult(request.result)){if(!this.recoveryPromise)this.lifecycleState={...this.lifecycleState,session:"ended"};await this.recoverSession(connection,{signal});abortIfNeeded(signal);request=await callDriver(connection,"check_permissions",{prompt:false},signal);}return request.result?.structuredContent??request.result;}
  async health({signal}={}){const connection=await this.connect();const result=await connection.client.callTool({name:"health_report",arguments:{}},undefined,{signal});return {ok:result?.isError!==true,result};}
}

export const computerUseAdapter=new ComputerUseAdapter();
export const computerUseToolSpecs=()=>computerUseAdapter.capabilities().map(capability=>({type:"function",function:{name:capability.name,description:capability.description,parameters:capability.inputSchema}}));
