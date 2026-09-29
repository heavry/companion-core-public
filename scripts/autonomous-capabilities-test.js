process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_PRIMARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_BASE_URL="";
process.env.TAVILY_BASE_URL="";process.env.TAVILY_API_KEY="";process.env.SEARXNG_BASE_URL="";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-autonomous-capabilities-"));
process.env.DATABASE_PATH=path.join(root,"companion.db");
process.env.COMPANION_INVOCATION_LEDGER_PATH=path.join(root,"invocations.jsonl");
process.env.COMPANION_INVOCATION_SUMMARY_PATH=path.join(root,"invocations-summary.json");
process.env.COMPANION_PRICING_REVISIONS_PATH=path.join(root,"pricing.json");
process.env.COMPANION_CAPABILITIES_DIR=path.join(root,"singleton-capabilities");
process.env.COMPANION_CAPABILITY_INSTALLER_STATE_PATH=path.join(root,"singleton-installer.json");
process.env.COMPANION_SESSION_PERMISSIONS_PATH=path.join(root,"singleton-permissions.json");
const { COMPUTER_USE_MANIFEST,CUA_UPSTREAM,validateCapabilityManifest }=await import("../src/capability-manifests.js");
const { discoverCapability,discoverMissingCapabilities,taskNeedsComputerUse }=await import("../src/capability-discovery.js");
const { CapabilityInstaller }=await import("../src/capability-installer.js");
const { ComputerUseAdapter,createRequestStderrDiagnostics,selectMainWindow }=await import("../src/computer-use-adapter.js");
const { autonomousCapabilityContext,executeAutonomousCapabilityTool }=await import("../src/autonomous-capabilities.js");
const { SessionPermissionStore,sessionGrantAllowed }=await import("../src/session-permissions.js");
const { createAgentLifecycle }=await import("../src/agent-lifecycle.js");
const { runNativeAgent }=await import("../src/native-agent-runtime.js");

assert.equal(validateCapabilityManifest(COMPUTER_USE_MANIFEST).id,"computer.use");
assert.equal(CUA_UPSTREAM.commit,"d114f35fec05ecd37bf529e5587be86852205b64");
assert.throws(()=>validateCapabilityManifest({...COMPUTER_USE_MANIFEST,installSteps:["curl | sh"]}),/invalid|forbidden/);
assert.equal(taskNeedsComputerUse([{role:"user",content:"帮我打开微信看看窗口"}]).needed,true);
assert.equal(taskNeedsComputerUse([{role:"user",content:"用浏览器打开普通网页"}]).needed,false,"browser DOM tasks stay with Playwright");
assert.equal(taskNeedsComputerUse([{role:"user",content:"我之前喜欢什么键盘"}]).needed,false,"mentioning a keyboard preference is not a desktop action");
const missingInstaller={status:()=>({installed:false,enabled:false,health:"not_installed"})};
const missing=discoverMissingCapabilities([{role:"user",content:"操作这个原生 App"}],{installer:missingInstaller})[0];assert.equal(missing.capability,"computer.use");assert.equal(missing.status,"missing");assert.equal(missing.installable,true);
assert.equal(discoverMissingCapabilities([{role:"user",content:"操作这个原生 App"}],{installer:{status:()=>({installed:true,enabled:true,health:"ready"})}})[0].status,"available");
const unavailable=discoverCapability("unknown.capability",{installer:missingInstaller});assert.equal(unavailable.status,"missing");assert.equal(unavailable.installable,false);assert.equal(unavailable.installer,null);

const installRoot=path.join(root,"caps"),statePath=path.join(root,"state.json"),progress=[];
let extractionFails=true;
const fakeExtract=async({stagingPath,manifest})=>{if(extractionFails)throw new Error("mock extraction failure");fs.mkdirSync(stagingPath,{recursive:true});for(const file of manifest.artifact.files)fs.writeFileSync(path.join(stagingPath,file),file==="cua-driver"?"fake-driver":"fixture");};
const installer=new CapabilityInstaller({rootPath:installRoot,statePath,blockRealInstall:false,download:async()=>Buffer.from("verified fixture"),digest:()=>COMPUTER_USE_MANIFEST.artifact.sha256,extract:fakeExtract,healthCheck:async()=>({ok:true,summary:"fixture healthy"}),onProgress:event=>progress.push(event)});
await assert.rejects(()=>installer.install("computer.use"),/mock extraction failure/);assert.equal(installer.status("computer.use").health,"error","failed staging is visible but never registered as installed");assert.equal(installer.status("computer.use").installed,false);
extractionFails=false;const installed=await installer.install("computer.use",{provenance:{trigger:"test",sessionId:"fixture-session"}});assert.equal(installed.installed,true);assert.equal(installed.enabled,true);assert.equal(installed.provenance.trigger,"test");assert.equal(fs.existsSync(installer.binaryPath("computer.use")),true);assert.equal(progress.at(-1).stage,"ready");
const installRecord=JSON.parse(fs.readFileSync(statePath,"utf8")).capabilities["computer.use"];assert.equal(installRecord.descriptor.id,"computer.use");assert.equal(installRecord.descriptor.version,"0.22.2");assert.equal(installRecord.descriptor.license,"MIT");assert.deepEqual(installRecord.descriptor.permissions,COMPUTER_USE_MANIFEST.permissions,"the installed record keeps an auditable manifest snapshot");
assert.equal(installer.disable("computer.use").health,"disabled");assert.equal(installer.enable("computer.use").enabled,true);assert.equal((await installer.test("computer.use")).lastTest!==null,true);
const restored=new CapabilityInstaller({rootPath:installRoot,statePath,blockRealInstall:true,healthCheck:async()=>({ok:true})});assert.equal(restored.status("computer.use").installed,true,"install/provenance survives restart");assert.equal(restored.uninstall("computer.use"),true);assert.equal(restored.status("computer.use").installed,false);assert.equal(fs.existsSync(path.join(installRoot,"computer.use")),false,"uninstall only removes Companion-owned path");
const descriptorBase={schemaVersion:1,displayName:"Fixture",source:"test_descriptor",sourceUrl:"https://github.com/example/fixture",version:"1.0.0",entrypoint:"fixture",transport:"stdio",permissions:["read"],riskClass:"low",installSteps:["register","health_check"],healthCheck:{kind:"fixture"},uninstall:{kind:"fixture"},configSchema:{type:"object"}};
let mcpRegistered=false,nativeRegistered=false;const descriptorInstaller=new CapabilityInstaller({rootPath:path.join(root,"descriptor-caps"),statePath:path.join(root,"descriptors.json"),blockRealInstall:true,registerMcp:async()=>{mcpRegistered=true;return {configured:true,health:"ready",adapterVersion:"mcp-1"};},registerNative:async()=>{nativeRegistered=true;return {configured:true,health:"ready",adapterVersion:"native-1"};}});
await descriptorInstaller.installManifest({...descriptorBase,id:"fixture.mcp",type:"mcp",provenance:{trust:"known_github_descriptor"}});assert.equal(mcpRegistered,true,"controlled MCP descriptors use the MCP installer adapter");
await descriptorInstaller.installManifest({...descriptorBase,id:"fixture.native",type:"native",transport:"native",provenance:{trust:"approved_local_adapter"}});assert.equal(nativeRegistered,true,"approved local descriptors use the native installer adapter");

const calls=[];let closeCount=0;
const adapterInstaller={status:()=>({installed:true,enabled:true}),binaryPath:()=>"/fixture/cua-driver",driverEnvironment:()=>({CUA_DRIVER_RS_TELEMETRY_ENABLED:"false"})};
const fakeClient={callTool:async request=>{calls.push(request);if(request.name==="get_desktop_state")return {content:[{type:"text",text:"desktop observed"},{type:"image",mimeType:"image/png",data:"c2FmZS1maXh0dXJl"}],structuredContent:{screen_size:{width:100,height:100}}};if(request.name==="driver_failure")throw new Error("driver failed");return {content:[{type:"text",text:`ok:${request.name}`}],structuredContent:{ok:true}};},close:async()=>{closeCount++;}};
const adapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client:fakeClient,transport:{}})});
const clickCapability=adapter.capabilities().find(item=>item.name==="computer_mouse_click"),elevatedClick=clickCapability.resolveInvocation({pid:10,x:1,y:2,target_description:"删除文件确认按钮"});assert.equal(elevatedClick.riskLevel,"high");assert.ok(elevatedClick.permissions.includes("external_action"));assert.equal(clickCapability.resolveInvocation({pid:10,x:1,y:2,target_description:"普通展开按钮"}).requiresConfirmation,true,"model-supplied description cannot downgrade an unknown click");
for(const [action,args,driver] of [
  ["computer_screen_observe",{},"get_accessibility_tree"],
  ["computer_screen_screenshot",{},"get_desktop_state"],
  ["computer_mouse_click",{pid:10,x:1,y:2,target_description:"普通展开按钮"},"click"],
  ["computer_keyboard_type",{pid:10,text:"fixture"},"type_text"],
  ["computer_scroll",{pid:10,direction:"down"},"scroll"],
  ["computer_app_launch",{bundle_id:"com.apple.TextEdit"},"launch_app"]
]){const result=await adapter.execute(action,args);assert.equal(result.ok,true);assert.equal(result.driverTool,driver);assert.ok(!result.durableContent.includes("c2FmZS"),"screenshots never enter durable tool content");}
assert.deepEqual(calls.map(item=>item.name),["get_accessibility_tree","get_desktop_state","click","type_text","scroll","launch_app"]);
assert.equal("target_description" in calls.find(item=>item.name==="click").arguments,false,"Companion risk metadata is not leaked into the Cua schema");
const localizedCalls=[],localizedClient={callTool:async request=>{localizedCalls.push(request);if(request.name==="list_apps")return {structuredContent:{apps:[{name:"TextEdit",bundle_id:"com.apple.TextEdit",launch_path:"/System/Applications/TextEdit.app"}]}};return {content:[{type:"text",text:"launched"}],structuredContent:{pid:42,bundle_id:"com.apple.TextEdit"}};},close:async()=>{}};
const localizedAdapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client:localizedClient,transport:{}}),appResolver:async name=>name==="文本编辑"?{bundleId:"com.apple.TextEdit",source:"launchservices_metadata"}:null});const localizedLaunch=await localizedAdapter.execute("computer_app_launch",{name:"文本编辑",target_description:"打开测试 App"});assert.equal(localizedLaunch.ok,true);assert.deepEqual(localizedCalls.at(-1).arguments,{bundle_id:"com.apple.TextEdit"},"localized app names resolve to an unambiguous bundle id before launch");
const missingAdapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client:{callTool:async()=>({isError:true,content:[{type:"text",text:"No installed macOS app found for name fixture."}],structuredContent:{error:"APP_NOT_INSTALLED",name:"fixture"}}),close:async()=>{}},transport:{}}),appResolver:async()=>null});const missingLaunch=await missingAdapter.execute("computer_app_launch",{name:"fixture"});assert.equal(missingLaunch.ok,false);assert.equal(missingLaunch.failure.category,"app_not_found");assert.equal(missingLaunch.failure.upstream_code,"APP_NOT_INSTALLED");assert.ok(!missingLaunch.durableContent.includes("permission_required"),"app resolution failures are never misattributed to TCC");
const permissionAdapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client:{callTool:async()=>({isError:true,content:[{type:"text",text:"Accessibility permission required"}],structuredContent:{error:"ACCESSIBILITY_PERMISSION_REQUIRED"}}),close:async()=>{}},transport:{}})});const permissionFailure=await permissionAdapter.execute("computer_screen_observe",{});assert.equal(permissionFailure.failure.category,"permission_required");
const mainWindow=selectMainWindow([{pid:20,window_id:91,layer:0,bounds:{width:80,height:50},on_current_space:true,z_index:9},{pid:20,window_id:72,layer:0,bounds:{width:1000,height:700},on_current_space:false,z_index:null},{pid:20,window_id:88,layer:0,bounds:{width:600,height:500},on_current_space:true,z_index:2}],20);assert.equal(mainWindow.windowId,72,"main-window choice prefers the largest ordinary usable window, not list order, newest id, or current Space");assert.equal(mainWindow.onCurrentSpace,false);
const focusCalls=[],focusClient={callTool:async request=>{focusCalls.push(request);if(request.name==="list_windows")return {structuredContent:{windows:[{pid:20,window_id:72,layer:0,bounds:{width:1000,height:700},on_current_space:true,is_on_screen:true,z_index:3}]}};return {content:[{type:"text",text:"focused"}],structuredContent:{code:"bring_to_front_exact_window_verified",activated:true}};},close:async()=>{}};const focusAdapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client:focusClient,transport:{}})});const focused=await focusAdapter.execute("computer_app_activate",{pid:20});assert.equal(focused.ok,true);assert.deepEqual(focusCalls.map(call=>[call.name,call.arguments]),[["list_windows",{pid:20}],["bring_to_front",{pid:20,window_id:72}]],"pid-only activation resolves one deterministic exact window before foregrounding");
const offSpaceClient={callTool:async request=>request.name==="list_windows"?{structuredContent:{windows:[{pid:30,window_id:73,layer:0,bounds:{width:900,height:650},on_current_space:false,is_on_screen:false,z_index:null}]}}:{isError:true,content:[{type:"text",text:"exact window was not verified as frontmost"}],structuredContent:{code:"bring_to_front_exact_window_unverified",activated:false}} ,close:async()=>{}};const offSpaceAdapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client:offSpaceClient,transport:{}})});const offSpace=await offSpaceAdapter.execute("computer_window_focus",{pid:30});assert.equal(offSpace.ok,false);assert.equal(offSpace.failure.category,"window_not_visible");assert.equal(offSpace.failure.upstream_code,"BRING_TO_FRONT_EXACT_WINDOW_UNVERIFIED");assert.ok(!offSpace.durableContent.includes("permission_required"));
let activationRound=0,launchServicesCalls=0;const recoveredClient={callTool:async request=>{if(request.name==="list_apps")return {structuredContent:{apps:[{pid:40,bundle_id:"com.example.RunningApp",running:true}]}};if(request.name==="list_windows")return {structuredContent:{windows:[{pid:40,window_id:74,layer:0,bounds:{width:900,height:650},on_current_space:activationRound>0,is_on_screen:activationRound>0,z_index:4}]}};activationRound++;return activationRound===1?{isError:true,content:[{type:"text",text:"exact window was not verified as frontmost"}],structuredContent:{code:"bring_to_front_exact_window_unverified",activated:false}}:{content:[{type:"text",text:"focused"}],structuredContent:{code:"bring_to_front_exact_window_verified",activated:true}};},close:async()=>{}};const recoveredAdapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client:recoveredClient,transport:{}}),appActivator:async bundleId=>{assert.equal(bundleId,"com.example.RunningApp");launchServicesCalls++;return true;}});const recovered=await recoveredAdapter.execute("computer_app_activate",{pid:40});assert.equal(recovered.ok,true);assert.equal(launchServicesCalls,1);assert.deepEqual(recovered.activationRecovery,{mechanism:"launchservices_open_existing",createdNewInstance:false,firstFailureCode:"BRING_TO_FRONT_EXACT_WINDOW_UNVERIFIED"},"failed exact foregrounding uses bounded LaunchServices activation of the existing app, then Cua re-verifies it");
await assert.rejects(()=>adapter.execute("computer_unknown",{}),error=>error.code==="COMPUTER_USE_ACTION_NOT_ALLOWED");await adapter.close();assert.equal(closeCount,1);
const waitingClient={callTool:async(_request,_schema,{signal})=>new Promise((_,reject)=>{const keepAlive=setTimeout(()=>reject(new Error("fixture did not abort")),1000);signal.addEventListener("abort",()=>{clearTimeout(keepAlive);reject(Object.assign(new Error("aborted"),{name:"AbortError"}));},{once:true});}),close:async()=>{}};
const timeoutAdapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client:waitingClient,transport:{}}),actionTimeoutMs:10});const timeoutFailure=await timeoutAdapter.execute("computer_screen_observe",{});assert.equal(timeoutFailure.failure.category,"timeout");
const cancelController=new AbortController(),cancelAdapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client:waitingClient,transport:{}}),actionTimeoutMs:10000});const cancelledAction=cancelAdapter.execute("computer_screen_observe",{},{signal:cancelController.signal});cancelController.abort();await assert.rejects(cancelledAction,error=>error.name==="AbortError");

const ended=()=>({content:[{type:"text",text:"request refused before dispatch"}],structuredContent:{status:"refused",refusal:{code:"session_ended",message:"logical session ended"}}});
{
  let actionCalls=0,startCalls=0;const client={callTool:async request=>{if(request.name==="start_session"){startCalls++;return {structuredContent:{active:true,state:"active"}};}actionCalls++;return actionCalls===1?ended():{content:[{type:"text",text:"observed"}],structuredContent:{ok:true}};},close:async()=>{}};
  const recovering=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client,transport:{}})}),result=await recovering.execute("computer_screen_observe",{});assert.equal(result.ok,true);assert.equal(startCalls,1);assert.equal(actionCalls,2);assert.deepEqual(result.sessionRecovery,{attempted:true,retried:true,recovered:true});assert.deepEqual(recovering.runtimeState(),{process:"alive",transport:"connected",session:"active"});
}
{
  let actionCalls=0,startCalls=0;const client={callTool:async request=>{if(request.name==="start_session"){startCalls++;return {structuredContent:{active:true}};}actionCalls++;return ended();},close:async()=>{}};const adapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client,transport:{}})}),result=await adapter.execute("computer_window_list",{});assert.equal(result.ok,false);assert.equal(result.failure.code,"computer_use_session_ended");assert.equal(result.failure.category,"lifecycle_session");assert.equal(result.failure.safeToReplay,true);assert.equal(result.failure.rejectedBeforeDispatch,true);assert.equal(startCalls,1);assert.equal(actionCalls,2,"session recovery retries the original request at most once");assert.ok(!result.durableContent.includes("permission_required"));
}
{
  let active=false,startCalls=0,actionCalls=0,release;const gate=new Promise(resolve=>release=resolve),client={callTool:async request=>{if(request.name==="start_session"){startCalls++;await gate;active=true;return {structuredContent:{active:true}};}actionCalls++;return active?{content:[{type:"text",text:"ok"}],structuredContent:{ok:true}}:ended();},close:async()=>{}};const adapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client,transport:{}})});const first=adapter.execute("computer_screen_observe",{}),second=adapter.execute("computer_window_list",{});await new Promise(resolve=>setImmediate(resolve));assert.equal(adapter.runtimeState().session,"recovering");release();const results=await Promise.all([first,second]);assert.ok(results.every(result=>result.ok));assert.equal(startCalls,1,"concurrent ended requests share one start_session recovery");assert.equal(actionCalls,4);
}
{
  let dispatched=0,startCalls=0;const client={callTool:async request=>{if(request.name==="start_session"){startCalls++;return {structuredContent:{active:true}};}dispatched++;return dispatched===1?ended():{content:[{type:"text",text:"typed"}],structuredContent:{ok:true}};},close:async()=>{}};const adapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client,transport:{}})}),result=await adapter.execute("computer_keyboard_type",{pid:10,text:"fixture"});assert.equal(result.ok,true);assert.equal(startCalls,1);assert.equal(dispatched,2,"a side-effect request is replayed only after an explicit before-dispatch session refusal");
}
{
  let calls=0,factoryCalls=0;const adapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>{factoryCalls++;return {client:{callTool:async()=>{calls++;if(factoryCalls===1)throw new Error("unknown transport break");return {content:[{type:"text",text:"typed"}],structuredContent:{ok:true}};},close:async()=>{}},transport:{}};}}),result=await adapter.execute("computer_keyboard_type",{pid:10,text:"fixture"});assert.equal(result.ok,false);assert.equal(calls,1,"unknown transport failures never replay a side-effect action");assert.equal(result.failure.category,"driver_error");assert.deepEqual(adapter.runtimeState(),{process:"stopped",transport:"disconnected",session:"none"});const next=await adapter.execute("computer_keyboard_type",{pid:10,text:"next fixture"});assert.equal(next.ok,true,"the next distinct request may establish a fresh driver connection");assert.equal(factoryCalls,2);assert.equal(calls,2);
}
{
  let actionCalls=0,release;const gate=new Promise(resolve=>release=resolve),client={callTool:async request=>{if(request.name==="start_session"){await gate;return {structuredContent:{active:true}};}actionCalls++;return ended();},close:async()=>{}};const controller=new AbortController(),adapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client,transport:{}})}),task=adapter.execute("computer_mouse_click",{pid:10,x:1,y:2},{signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(task,error=>error.name==="AbortError");assert.equal(actionCalls,1,"Stop during recovery prevents the original action from continuing");release();await new Promise(resolve=>setImmediate(resolve));
}
{
  const stderr=createRequestStderrDiagnostics();stderr.append("old ScreenCaptureKit capture failed\n");const client={callTool:async()=>({isError:true,content:[{type:"text",text:"No installed macOS app found"}],structuredContent:{error:"APP_NOT_INSTALLED"}}),close:async()=>{}};const adapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client,transport:{},stderr})}),result=await adapter.execute("computer_app_launch",{bundle_id:"com.example.Missing"});assert.equal(result.failure.driver_stderr,null,"historical driver stderr never contaminates a later request");
}
{
  const stderr=createRequestStderrDiagnostics();const client={callTool:async()=>{stderr.append("current request diagnostic\n");return {isError:true,content:[{type:"text",text:"driver failed"}],structuredContent:{code:"DRIVER_FAILED"}};},close:async()=>{}};const adapter=new ComputerUseAdapter({installer:adapterInstaller,clientFactory:async()=>({client,transport:{},stderr})}),result=await adapter.execute("computer_window_list",{});assert.match(result.failure.driver_stderr,/current request diagnostic/,"stderr emitted by the current request remains attached to that request");
}

const permissionDir=path.join(root,"permissions.json"),permissionStore=new SessionPermissionStore({filePath:permissionDir,pendingTtlMs:30000});
const installCap=autonomousCapabilityContext([{role:"user",content:"操作这个原生 App"}],{installer:missingInstaller,adapter:{capabilities:()=>[]}}).capabilities.find(item=>item.name==="capabilities_install");
assert.equal(permissionStore.policyDecision("p",installCap).kind,"ask","persistent installer uses existing approval flow");assert.equal(sessionGrantAllowed(installCap),true,"bounded idempotent preset may be granted for this session");
const highRisk={...installCap,capabilityId:"danger",riskLevel:"high",sideEffect:"non_idempotent",permissions:["external_action"]};assert.equal(sessionGrantAllowed(highRisk),false,"session grants never bypass high-risk hard rules");
const denied=permissionStore.beginRequest({sessionId:"p",callId:"deny",capability:installCap});permissionStore.resolve("p",denied.pending.request_id,"deny");assert.equal((await denied.promise).decision,"deny");
const once=permissionStore.beginRequest({sessionId:"p",callId:"once",capability:installCap});permissionStore.resolve("p",once.pending.request_id,"allow_once");assert.equal((await once.promise).action,"allow_once");
const grant=permissionStore.beginRequest({sessionId:"p",callId:"grant",capability:installCap});permissionStore.resolve("p",grant.pending.request_id,"allow_session");await grant.promise;assert.equal(permissionStore.policyDecision("p",installCap).source,"session_grant");

let fakeInstalled=false,installCalls=0;
const turnInstaller={onProgress:()=>{},status:()=>({installed:fakeInstalled,enabled:fakeInstalled,health:fakeInstalled?"installed":"not_installed",version:"0.22.2",upstreamCommit:CUA_UPSTREAM.commit}),install:async()=>{installCalls++;fakeInstalled=true;return {installed:true,enabled:true,version:"0.22.2",upstreamCommit:CUA_UPSTREAM.commit};}};
const turnAdapter={capabilities:()=>new ComputerUseAdapter({installer:{status:()=>({installed:fakeInstalled,enabled:fakeInstalled})}}).capabilities(),execute:async()=>({ok:true,modelContent:[{type:"text",text:"visible transient"},{type:"image_url",image_url:{url:"data:image/png;base64,PRIVATE_SCREENSHOT"}}],durableContent:"Computer Use 已完成：观察屏幕。"})};
const context=autonomousCapabilityContext([{role:"user",content:"帮我操作这个原生 App 完成测试"}],{installer:turnInstaller,adapter:turnAdapter}),runtimeCapabilities=context.capabilities;
const readOnlyContext=autonomousCapabilityContext([{role:"user",content:"查看当前 macOS 屏幕和窗口"}],{installer:turnInstaller,adapter:turnAdapter});
assert(readOnlyContext.capabilities.some(item=>item.name==="computer_screen_observe"),"screen intent exposes computer_screen_observe");
assert(readOnlyContext.capabilities.some(item=>item.name==="computer_window_list"),"window intent exposes computer_window_list");
const namedContext=autonomousCapabilityContext([{role:"user",content:"检查当前 Computer Use 能力是否可用，不要点击或输入。"}],{installer:turnInstaller,adapter:turnAdapter});
assert(namedContext.capabilities.some(item=>item.name==="computer_screen_observe"),"explicit Computer Use name routes to read-only observation tools");
const runtimePermission=new SessionPermissionStore({filePath:path.join(root,"turn-permissions.json"),pendingTtlMs:30000,onEvent:(type,data)=>{if(type==="permission.requested")queueMicrotask(()=>runtimePermission.resolve("turn",data.request.request_id,"allow_once"));}});
const modelCalls=[
  {id:"d",name:"capabilities_discover",args:{capability:"computer.use"}},
  {id:"i",name:"capabilities_install",args:{capability:"computer.use"}},
  {id:"o",name:"computer_screen_observe",args:{}},
  null
];
const durable=[],lifecycleEvents=[],lifecycle=createAgentLifecycle();for(const event of ["SessionStart","SessionEnd"])lifecycle.on(event,()=>lifecycleEvents.push(event));
const response=message=>({choices:[{message}]});
const result=await runNativeAgent({messages:[{role:"user",content:"操作原生 App"}],tools:context.tools,capabilities:runtimeCapabilities,lifecycle,permissionStore:runtimePermission,sessionId:"turn",maxSteps:5,callModel:async()=>{const next=modelCalls.shift();return next?response({role:"assistant",content:"",tool_calls:[{id:next.id,type:"function",function:{name:next.name,arguments:JSON.stringify(next.args)}}]}):response({role:"assistant",content:"原任务已经继续并完成"});},executeTool:async({capability,args,signal})=>executeAutonomousCapabilityTool({name:capability.name,args,sessionId:"turn",signal,runtimeCapabilities,installer:turnInstaller,adapter:turnAdapter}),onToolResult:async message=>durable.push(message.content)});
assert.equal(result.message.content,"原任务已经继续并完成");assert.equal(installCalls,1);assert.deepEqual(lifecycleEvents,["SessionStart","SessionEnd"],"install and original task share one Native Agent turn");assert.equal(runtimeCapabilities.find(item=>item.name==="computer_screen_observe").availability,"available");assert.ok(durable.every(text=>!text.includes("PRIVATE_SCREENSHOT")),"Computer Use observations do not pollute durable conversation/Memory inputs");

fs.rmSync(root,{recursive:true,force:true});
console.log("autonomous-capabilities-test: ok");
