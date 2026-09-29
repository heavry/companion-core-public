import { agentTasks } from "./agent-task-store.js";
import { config } from "./config.js";
import { bubbleMetadataForAdminRow,clearSessionMessages,deleteMemory,deleteSession,findSessionToolCall,getMemory,getOrCreateSession,getSession,getSqliteStatus,getStatusCounts,hasSessionToolResult,listMemoriesAdmin,listMessagesForAdmin,listPersonas,listSessionsAdmin,listUsageStats,searchMessagesForAdmin,setSessionArchived,updateMemory,upsertPersona,usageOverview,webSourcesForAdminRow } from "./db.js";
import { getEmbeddingStatus } from "./embeddings.js";
import { addManualMemory,addStagingMemory,inspectManualMemory,refreshMemoryIndex,retrieveMemoriesDetailed } from "./memory.js";
import { MEMORY_TYPES,validMemoryStatus } from "./memory-policy.js";
import { validatePersona } from "./persona.js";
import { runtimeStatus } from "./runtime.js";
import { moduleRegistry } from "./modules/registry.js";
import { triggerEngine } from "./modules/triggers.js";
import { moduleExecutionLedger } from "./modules/ledger.js";
import { companionStateSummary,getBehavior,updateBehavior,inQuietHours,proactiveCountsToday,setInactivitySimulation,recentInactivityAudits,effectiveLastUserInteractionAt,getState } from "./companion-state.js";
import { attachmentsForMessage,voiceAssetForMessage } from "./media.js";
import { busStats } from "./events-bus.js";
import { searchStatus,setSearchRuntimeConfig } from "./search/index.js";
import { mcpRegistry } from "./mcp/client.js";
import { COMPANION_MCP_TOOLS } from "./mcp/server-tools.js";
import fs from "node:fs";
import path from "node:path";
import { json,readJsonBody } from "./utils.js";
import { getWorkerStatus } from "./workers.js";
import { memoryDiagnostics,memoryRuntimeConfig } from "./memory-capture.js";
import { memoryEngine } from "./memory-engine.js";
import { memorySelectionDiagnostics } from "./memory-selection.js";
import { memoryAccessibilityDiagnostics,accessibilityLimits,defaultActiveMemory } from "./memory-accessibility.js";
import { snapshotPostMessageDiagnostics } from "./post-message-cognition.js";
import { eventAssociationDiagnostics,eventAssociationLimits } from "./event-association.js";
import { capabilityProductSnapshot,relationshipProductSnapshot,todayProductSnapshot } from "./product-surfaces.js";
import { diaryProductSnapshot, generateDiaryForDate, getDiaryEntry, listDiaryEntries, listDiaryPending, retrieveDiariesForQuery, validLocalDate } from "./natural-diary/index.js";
import { repairStore } from "./natural-repair/index.js";
import { classifyToolFailure,parseToolArguments,toolActivityMetadata,toolResultFailed } from "./tool-activity.js";
import { scheduler } from "./scheduler.js";
import { invocationLedger } from "./usage-ledger.js";
import { guidanceQueue } from "./guidance-queue.js";
import { sessionPermissions } from "./session-permissions.js";
import { activeTurns } from "./active-turns.js";
import { temporalContextStore } from "./temporal-context.js";
import { capabilityInstaller } from "./capability-installer.js";
import { computerUseAdapter } from "./computer-use-adapter.js";
import { capabilityInstallerPermission } from "./autonomous-capabilities.js";
import { publishEvent } from "./events-bus.js";
import { attentionStore } from "./attention-store.js";
import { localRuntimeControls } from "./local-runtime-controls.js";
import { autonomousLife } from "./autonomous-life/index.js";
import { runHeartbeat,gatherCandidates } from "./proactive.js";
import { evaluateInactivityEligibility } from "./inactivity-proactive.js";
import { proactiveCognitionMetrics } from "./proactive-cognition-metrics.js";
import { naturalPresence,evaluateAndApplyTurn,decideContact } from "./natural-presence/index.js";
import { naturalCognition,onMacSeen,onMacAttention } from "./natural-cognition/index.js";
import { ingestUserVoiceMessage } from "./chat-voice-message.js";
import { classifyGrounding } from "./conversation-grounding.js";
import { VOICE_PROFILES,profileReference,selectVoiceStyle } from "./voice-profiles.js";
import { listTtsProviders,setSelectedTtsProvider,synthesizeWithSelectedProvider } from "./tts-providers.js";
import { snapshotVoiceAsyncDiagnostics } from "./voice-async-queue.js";

const CAPABILITY_UI_SESSION="capability-installer-ui";
function installerOperationCapability(kind){return kind==="install"?capabilityInstallerPermission:{...capabilityInstallerPermission,capabilityId:"capability.uninstall:computer.use",id:"capability.uninstall:computer.use",name:"capabilities_uninstall",displayName:"卸载 Computer Use",description:"移除 Companion 自己安装的 Computer Use 组件，不影响其他应用或系统共享组件。"};}
function beginCapabilityOperation(kind,body={}){
  const sessionId=String(body.session_id??CAPABILITY_UI_SESSION).slice(0,240),callId=`capability_${kind}_${Date.now()}`,capability=installerOperationCapability(kind);
  const policy=sessionPermissions.policyDecision(sessionId,capability);
  const run=async()=>kind==="install"?capabilityInstaller.install("computer.use",{provenance:{trigger:"capabilities_ui",sessionId}}):capabilityInstaller.uninstall("computer.use");
  if(policy.kind==="allow")return {sessionId,pending:null,promise:run()};
  const request=sessionPermissions.beginRequest({sessionId,callId,capability,reason:kind==="install"?"安装执行型 Capability 会产生持久变更":"卸载 Capability 会移除 Companion 管理的运行文件"});
  const promise=request.promise.then(decision=>decision.decision==="allow"?run():Promise.reject(Object.assign(new Error("capability operation denied"),{code:"CAPABILITY_OPERATION_DENIED"})));
  return {sessionId,pending:request.pending,promise};
}

function safeReadConfigField(filePath,field){
  try{return JSON.parse(fs.readFileSync(filePath,"utf8"))?.[field]??"";}catch{return "";}
}

const boolParam=v=>v==="true"?true:v==="false"?false:undefined;
function needConfirmation(body){if(body?.confirm!==true){const e=new Error("confirmation required");e.statusCode=400;throw e;}}
function validatedPersona(body){try{return validatePersona(body);}catch(e){e.statusCode=400;throw e;}}
function memoryPatch(body){
  const patch={};
  if(body.content!==undefined){if(typeof body.content!=="string"||!body.content.trim())throw Object.assign(new Error("content required"),{statusCode:400});patch.content=body.content.trim();}
  if(body.type!==undefined){if(!MEMORY_TYPES.has(body.type))throw Object.assign(new Error("invalid memory type"),{statusCode:400});patch.type=body.type;}
  if(body.status!==undefined){if(!validMemoryStatus(body.status))throw Object.assign(new Error("invalid memory status"),{statusCode:400});patch.status=body.status;}
  if(body.importance!==undefined)patch.importance=Number(body.importance);
  if(body.confidence!==undefined){const confidence=Number(body.confidence);if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw Object.assign(new Error("invalid confidence"),{statusCode:400});patch.confidence=confidence;}
  if(body.pinned!==undefined)patch.pinned=Boolean(body.pinned);
  if(body.source!==undefined){if(typeof body.source!=="string"||!body.source.trim())throw Object.assign(new Error("invalid memory source"),{statusCode:400});patch.source=body.source.trim().slice(0,100);}
  if(body.temporal_state!==undefined){if(!["current","historical","planned","timeless"].includes(body.temporal_state))throw Object.assign(new Error("invalid temporal state"),{statusCode:400});patch.temporalState=body.temporal_state;}
  return patch;
}


function classifyConversation(s){
  const src=String(s.source??"").toLowerCase(),key=String(s.external_key??"");
  if(src.startsWith("proactive")||key.startsWith("companion-mac"))return {category:"proactive",display_name:"主动消息"};
  if(src.includes("kelivo"))return {category:"daily",display_name:`Kelivo · ${key||"daily-main"}`};
  if(src.includes("opencode"))return {category:"agents",display_name:`OpenCode · ${(key.match(/^project-([a-z0-9-]+)-[0-9a-f]+$/i)?.[1]??key).slice(0,40)}`};
  if(src.includes("harness"))return {category:"agents",display_name:`Harness · ${(key.match(/^project-([a-z0-9-]+)-[0-9a-f]+$/i)?.[1]??key).slice(0,40)}`};
  if(src.startsWith("module"))return {category:"system",display_name:`Module · ${key.slice(0,40)}`};
  return {category:"daily",display_name:`${s.source} · ${key.slice(0,40)}`};
}

function activityMetadata(name,args,sourceHint=null){
  return toolActivityMetadata({wireName:name,args,sourceHint,mcpMetadata:mcpRegistry.presentationMetadataForWireName(name)});
}

function toolActivitiesForAdminRow(sessionId,row){
  if(row.role==="assistant"&&row.tool_calls_json){
    try{
      const calls=JSON.parse(row.tool_calls_json);
      return (Array.isArray(calls)?calls:[]).slice(0,20).map(call=>{
        const name=String(call?.function?.name??call?.name??""),args=parseToolArguments(call?.function?.arguments??call?.arguments);
        const callId=String(call?.id??call?.call_id??""),age=Date.now()-Date.parse(row.created_at??""),stale=!hasSessionToolResult(sessionId,callId)&&Number.isFinite(age)&&age>Math.max(120000,config.mcpToolTimeoutMs+30000);
        const interrupted=sessionPermissions.interruptedFor(sessionId,callId)??(stale?{failure_category:"tool_error",failure_code:"tool_turn_interrupted",failure_summary:"操作已中断",failure_reason:"服务重启或连接中断后，这个操作没有完成；请重新发送请求"}:null);
        return {call_id:callId,status:interrupted?"failed":"running",...activityMetadata(name,args,name==="web_search"?"core":null),...(interrupted?{failure_category:interrupted.failure_category,failure_code:interrupted.failure_code,failure_summary:interrupted.failure_summary,failure_reason:interrupted.failure_reason}:{})};
      }).filter(item=>item.call_id);
    }catch{return null;}
  }
  if(row.role==="tool"&&row.tool_call_id){
    const call=findSessionToolCall(sessionId,row.tool_call_id);
    if(!call)return null;
    const name=String(call?.function?.name??call?.name??""),args=parseToolArguments(call?.function?.arguments??call?.arguments);
    const failure=classifyToolFailure(row.content_text);
    return [{call_id:String(row.tool_call_id),status:toolResultFailed(row.content_text)?"failed":"success",...activityMetadata(name,args,name==="web_search"?"core":null),...(failure??{})}];
  }
  return null;
}

export async function handleAdminApi(req,res,u){
  if(req.method==="GET"&&u.pathname==="/admin/status"){const counts=getStatusCounts();return json(res,200,{version:config.version,module_execution_ledger:{...moduleExecutionLedger.stats(),health:moduleExecutionLedger.health,path:config.moduleExecutionLedgerPath,corrupt_backup:moduleExecutionLedger.corruptBackup},...counts,listen:{host:config.host,port:config.port,admin_remote_access:config.adminRemoteAccess},...runtimeStatus(),sqlite:getSqliteStatus(),counts,usage:usageOverview(),workers:getWorkerStatus(),embedding:getEmbeddingStatus(),memory:{diagnostics:{...memoryDiagnostics},selection:{...memorySelectionDiagnostics},event_association:{...eventAssociationDiagnostics,limits:eventAssociationLimits()},accessibility:{...memoryAccessibilityDiagnostics,limits:accessibilityLimits(),active_memory:defaultActiveMemory.snapshot()},
      post_message:snapshotPostMessageDiagnostics(),runtime:memoryRuntimeConfig()},autonomous_life:autonomousLife.snapshot()});}
  if(req.method==="GET"&&u.pathname==="/admin/local-runtime-controls")return json(res,200,localRuntimeControls.snapshot());
  if(req.method==="PATCH"&&u.pathname==="/admin/local-runtime-controls"){
    const snapshot=localRuntimeControls.update(await readJsonBody(req,config.maxBodyBytes));publishEvent("local.runtime.controls.updated",snapshot);return json(res,200,snapshot);
  }
  if(req.method==="GET"&&u.pathname==="/admin/capabilities/computer.use")return json(res,200,{status:capabilityInstaller.status("computer.use"),permissionSession:sessionPermissions.snapshot(CAPABILITY_UI_SESSION)});
  if(req.method==="GET"&&u.pathname==="/admin/capabilities/computer.use/permissions"){
    const status=capabilityInstaller.status("computer.use");if(!status.installed)return json(res,200,{installed:false,accessibility:false,screen_recording:false,source:null});
    try{return json(res,200,{installed:true,driver:await computerUseAdapter.permissions()});}catch(error){return json(res,200,{installed:true,error:String(error?.message??error).slice(0,300)});}
  }
  if(req.method==="POST"&&u.pathname==="/admin/capabilities/computer.use/install"){
    if(capabilityInstaller.status("computer.use").installed)return json(res,200,{ok:true,status:"installed",request:null,permissionSession:sessionPermissions.snapshot(CAPABILITY_UI_SESSION)});
    const operation=beginCapabilityOperation("install",await readJsonBody(req,config.maxBodyBytes));operation.promise.then(status=>publishEvent("capability.install.completed",{capability:"computer.use",status},{sessionId:operation.sessionId})).catch(error=>publishEvent("capability.install.failed",{capability:"computer.use",message:String(error?.message??error).slice(0,240)},{sessionId:operation.sessionId}));
    return json(res,202,{ok:true,status:"awaiting_approval",request:operation.pending,permissionSession:sessionPermissions.snapshot(operation.sessionId)});
  }
  if(req.method==="POST"&&u.pathname==="/admin/capabilities/computer.use/test")return json(res,200,{ok:true,status:await capabilityInstaller.test("computer.use")});
  if(req.method==="PATCH"&&u.pathname==="/admin/capabilities/computer.use"){
    const body=await readJsonBody(req,config.maxBodyBytes);if(typeof body.enabled!=="boolean")return json(res,400,{error:"enabled boolean required"});
    if(!body.enabled)await computerUseAdapter.close();return json(res,200,{ok:true,status:capabilityInstaller.enable("computer.use",body.enabled)});
  }
  if(req.method==="DELETE"&&u.pathname==="/admin/capabilities/computer.use"){
    const body=await readJsonBody(req,config.maxBodyBytes),operation=beginCapabilityOperation("uninstall",body);operation.promise.then(async()=>{await computerUseAdapter.close();publishEvent("capability.uninstall.completed",{capability:"computer.use"},{sessionId:operation.sessionId});}).catch(error=>publishEvent("capability.uninstall.failed",{capability:"computer.use",message:String(error?.message??error).slice(0,240)},{sessionId:operation.sessionId}));
    return json(res,202,{ok:true,status:"awaiting_approval",request:operation.pending,permissionSession:sessionPermissions.snapshot(operation.sessionId)});
  }
  if(req.method==="GET"&&u.pathname==="/admin/product/today"){
    const date=u.searchParams.get("date");
    return json(res,200,todayProductSnapshot({dateLocal:date}));
  }
  if(req.method==="GET"&&u.pathname==="/admin/diary"){
    const date=u.searchParams.get("date");
    if(date){
      if(!validLocalDate(date))return json(res,400,{error:{message:"invalid date",type:"invalid_request_error"}});
      const entry=getDiaryEntry(date);
      if(!entry)return json(res,404,{error:{message:"diary not found",type:"not_found"},date,pending:listDiaryPending().find(x=>x.date_local===date)??null});
      return json(res,200,{ok:true,entry,product:diaryProductSnapshot(date)});
    }
    return json(res,200,{ok:true,entries:listDiaryEntries({limit:Number(u.searchParams.get("limit")||30)}),pending:listDiaryPending()});
  }
  if(req.method==="POST"&&u.pathname==="/admin/diary/generate"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    const date=String(body?.date??body?.date_local??"").trim();
    if(!validLocalDate(date))return json(res,400,{error:{message:"date (YYYY-MM-DD) required",type:"invalid_request_error"}});
    const result=await generateDiaryForDate(date,{force:false});
    return json(res,result.ok?200:502,{ok:Boolean(result.ok),...result});
  }
  if(req.method==="POST"&&u.pathname==="/admin/diary/regenerate"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    needConfirmation(body);
    const date=String(body?.date??body?.date_local??"").trim();
    if(!validLocalDate(date))return json(res,400,{error:{message:"date (YYYY-MM-DD) required",type:"invalid_request_error"}});
    const result=await generateDiaryForDate(date,{force:true});
    return json(res,result.ok?200:502,{ok:Boolean(result.ok),...result});
  }
  if(req.method==="POST"&&u.pathname==="/admin/diary/retrieve"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    return json(res,200,retrieveDiariesForQuery(String(body?.query??"")));
  }
  if(req.method==="GET"&&u.pathname==="/admin/attention")return json(res,200,attentionStore.snapshot({limit:Number(u.searchParams.get("limit")||50)}));
  const attentionMark=u.pathname.match(/^\/admin\/attention\/([^/]+)\/(read|dismiss|snooze)$/);
  if(req.method==="POST"&&attentionMark){
    const id=decodeURIComponent(attentionMark[1]),action=attentionMark[2];
    if(action==="snooze"){
      const body=await readJsonBody(req,8*1024);
      const minutes=body.in==="1h"?60:body.in==="tomorrow"?24*60:10;
      const at=new Date(Date.now()+minutes*60*1000).toISOString();
      const item=attentionStore.mark(id,"snoozed");
      if(!item)return json(res,404,{error:{message:"attention item not found",type:"not_found"}});
      const plan=scheduler.create({title:`稍后提醒：${item.title}`,schedule:{type:"once",at,timeZone:"Asia/Shanghai"},target:{type:"conversation",content:item.summary||item.title},enabled:true});
      return json(res,200,{item,plan});
    }
    const item=attentionStore.mark(id,action==="read"?"read":"dismissed");
    if(!item)return json(res,404,{error:{message:"attention item not found",type:"not_found"}});
    return json(res,200,{item});
  }
  if(req.method==="GET"&&u.pathname==="/admin/product/relationship")return json(res,200,relationshipProductSnapshot());
  if(req.method==="GET"&&u.pathname==="/admin/product/capabilities")return json(res,200,capabilityProductSnapshot());
  if(req.method==="GET"&&u.pathname==="/admin/product/usage")return json(res,200,invocationLedger.snapshot());
  if(req.method==="GET"&&u.pathname==="/admin/usage/prices")return json(res,200,{data:invocationLedger.snapshot().prices});
  if(req.method==="POST"&&u.pathname==="/admin/usage/prices")return json(res,201,{ok:true,revision:invocationLedger.addPrice(await readJsonBody(req,config.maxBodyBytes))});
  const guidanceCollection=u.pathname.match(/^\/admin\/sessions\/([^/]+)\/guidance$/);
  if(guidanceCollection&&req.method==="GET"){
    const sessionId=decodeURIComponent(guidanceCollection[1]);
    return json(res,200,{...guidanceQueue.snapshot(sessionId),activeTurn:activeTurns.current(sessionId)});
  }
  if(guidanceCollection&&req.method==="POST"){
    const body=await readJsonBody(req,config.maxBodyBytes),sessionId=decodeURIComponent(guidanceCollection[1]);
    if(!activeTurns.isActive(sessionId))return json(res,409,{error:{message:"当前会话没有正在运行的 Agent turn；请作为新消息发送。",type:"conflict",code:"no_active_turn"}});
    return json(res,201,{ok:true,item:guidanceQueue.enqueue(sessionId,body?.content)});
  }
  const guidanceItem=u.pathname.match(/^\/admin\/sessions\/([^/]+)\/guidance\/([^/]+)$/);
  if(guidanceItem&&req.method==="DELETE"){
    const outcome=guidanceQueue.cancel(decodeURIComponent(guidanceItem[1]),decodeURIComponent(guidanceItem[2]));
    if(!outcome)return json(res,404,{error:"guidance not found"});
    return outcome.ok?json(res,200,outcome):json(res,409,{error:"guidance is no longer queued",item:outcome.item});
  }
  const agentTaskCollection=u.pathname.match(/^\/admin\/sessions\/([^/]+)\/agent-tasks$/);
  if(agentTaskCollection&&req.method==="GET")return json(res,200,{tasks:agentTasks.list(decodeURIComponent(agentTaskCollection[1]))});
  const permissionsCollection=u.pathname.match(/^\/admin\/sessions\/([^/]+)\/permissions$/);
  if(permissionsCollection&&req.method==="GET")return json(res,200,sessionPermissions.snapshot(decodeURIComponent(permissionsCollection[1])));
  if(permissionsCollection&&req.method==="PATCH"){
    const sessionId=decodeURIComponent(permissionsCollection[1]),body=await readJsonBody(req,config.maxBodyBytes);
    return json(res,200,sessionPermissions.setMode(sessionId,body?.mode));
  }
  const sessionWorkspace=u.pathname.match(/^\/admin\/sessions\/([^/]+)\/workspace$/);
  if(sessionWorkspace&&req.method==="GET")return json(res,200,sessionPermissions.snapshot(decodeURIComponent(sessionWorkspace[1])));
  if(sessionWorkspace&&req.method==="PUT"){
    const body=await readJsonBody(req,config.maxBodyBytes);
    return json(res,200,sessionPermissions.setWorkspace(decodeURIComponent(sessionWorkspace[1]),body?.path));
  }
  if(sessionWorkspace&&req.method==="DELETE")return json(res,200,sessionPermissions.clearWorkspace(decodeURIComponent(sessionWorkspace[1])));
  if(u.pathname==="/admin/session-workspace"&&["GET","PUT","DELETE"].includes(req.method)){
    const body=req.method==="GET"?{}:await readJsonBody(req,config.maxBodyBytes),personaId=String(body?.persona_id??u.searchParams.get("persona_id")??config.defaultPersonaId),source=String(body?.source??u.searchParams.get("source")??"chat"),externalKey=String(body?.external_key??u.searchParams.get("external_key")??"chat:default");
    const session=getOrCreateSession(personaId,source,externalKey);
    if(req.method==="PUT")return json(res,200,sessionPermissions.setWorkspace(session.id,body?.path));
    if(req.method==="DELETE")return json(res,200,sessionPermissions.clearWorkspace(session.id));
    return json(res,200,sessionPermissions.snapshot(session.id));
  }
  const permissionDecision=u.pathname.match(/^\/admin\/sessions\/([^/]+)\/permissions\/decisions\/([^/]+)$/);
  if(permissionDecision&&req.method==="POST"){
    const body=await readJsonBody(req,config.maxBodyBytes);
    return json(res,200,sessionPermissions.resolve(decodeURIComponent(permissionDecision[1]),decodeURIComponent(permissionDecision[2]),body?.action,{reason:body?.reason}));
  }
  const permissionGrant=u.pathname.match(/^\/admin\/sessions\/([^/]+)\/permissions\/grants\/([^/]+)$/);
  if(permissionGrant&&req.method==="DELETE")return sessionPermissions.revoke(decodeURIComponent(permissionGrant[1]),decodeURIComponent(permissionGrant[2]))?json(res,200,{ok:true,snapshot:sessionPermissions.snapshot(decodeURIComponent(permissionGrant[1]))}):json(res,404,{error:"grant not found"});
  const permissionRevokeAll=u.pathname.match(/^\/admin\/sessions\/([^/]+)\/permissions\/revoke-all$/);
  if(permissionRevokeAll&&req.method==="POST")return json(res,200,{ok:true,revoked:sessionPermissions.revokeAll(decodeURIComponent(permissionRevokeAll[1])),snapshot:sessionPermissions.snapshot(decodeURIComponent(permissionRevokeAll[1]))});
  if(req.method==="GET"&&u.pathname==="/admin/scheduler")return json(res,200,scheduler.snapshot());
  if(req.method==="POST"&&u.pathname==="/admin/scheduler")return json(res,201,{ok:true,plan:scheduler.create(await readJsonBody(req,config.maxBodyBytes))});
  const schedulerMatch=u.pathname.match(/^\/admin\/scheduler\/([^/]+)$/);
  if(schedulerMatch&&req.method==="PATCH"){
    const plan=scheduler.update(schedulerMatch[1],await readJsonBody(req,config.maxBodyBytes));
    return plan?json(res,200,{ok:true,plan}):json(res,404,{error:"plan not found"});
  }
  if(schedulerMatch&&req.method==="DELETE"){
    needConfirmation(await readJsonBody(req,config.maxBodyBytes));
    return scheduler.delete(schedulerMatch[1])?json(res,200,{ok:true}):json(res,404,{error:"plan not found"});
  }

  if(req.method==="GET"&&u.pathname==="/admin/autonomous-life")return json(res,200,autonomousLife.snapshot());
  if(req.method==="POST"&&u.pathname==="/admin/autonomous-life/heartbeat")return json(res,200,autonomousLife.heartbeat({proactiveCandidateCount:0,toolCandidateCount:0}));
  if(req.method==="POST"&&u.pathname==="/admin/autonomous-life/goals")return json(res,201,{ok:true,goal:autonomousLife.createGoal(await readJsonBody(req,config.maxBodyBytes))});
  const autonomousGoal=u.pathname.match(/^\/admin\/autonomous-life\/goals\/([^/]+)$/);
  if(autonomousGoal&&req.method==="PATCH"){
    const goal=autonomousLife.updateGoal(decodeURIComponent(autonomousGoal[1]),await readJsonBody(req,config.maxBodyBytes));
    return goal?json(res,200,{ok:true,goal}):json(res,404,{error:"autonomous goal not found"});
  }

  if(req.method==="GET"&&u.pathname==="/admin/personas")return json(res,200,{data:listPersonas()});
  if(req.method==="POST"&&u.pathname==="/admin/personas/import"){const p=validatedPersona(await readJsonBody(req,config.maxBodyBytes));upsertPersona(p);return json(res,200,{ok:true,persona:p});}
  const personaMatch=u.pathname.match(/^\/admin\/personas\/([^/]+)(?:\/export)?$/);
  if(personaMatch&&req.method==="GET"){
    const p=listPersonas().find(x=>x.id===decodeURIComponent(personaMatch[1]));if(!p)return json(res,404,{error:"persona not found"});
    return json(res,200,p,{"content-disposition":`attachment; filename="persona-${p.id}.json"`});
  }
  if(personaMatch&&["PUT","PATCH"].includes(req.method)){const p=validatedPersona(await readJsonBody(req,config.maxBodyBytes));if(p.id!==decodeURIComponent(personaMatch[1]))return json(res,400,{error:"persona id mismatch"});upsertPersona(p);return json(res,200,{ok:true,persona:p});}

  if(req.method==="GET"&&u.pathname==="/admin/sessions")return json(res,200,{data:listSessionsAdmin({personaId:u.searchParams.get("persona_id"),source:u.searchParams.get("source"),search:u.searchParams.get("search")??"",archived:u.searchParams.get("archived")??"all",limit:u.searchParams.get("limit")??100})});
  const messagesMatch=u.pathname.match(/^\/admin\/sessions\/([^/]+)\/messages$/);
  if(messagesMatch&&req.method==="GET")return json(res,200,{data:searchMessagesForAdmin(messagesMatch[1],{search:u.searchParams.get("search")??"",limit:u.searchParams.get("limit")??500})});
  const clearMatch=u.pathname.match(/^\/admin\/sessions\/([^/]+)\/clear$/);
  if(clearMatch&&req.method==="POST"){const body=await readJsonBody(req,config.maxBodyBytes);needConfirmation(body);const result=clearSessionMessages(clearMatch[1]);if(result)temporalContextStore.deleteSession(clearMatch[1]);return result?json(res,200,{ok:true,...result}):json(res,404,{error:"session not found"});}
  const sessionMatch=u.pathname.match(/^\/admin\/sessions\/([^/]+)$/);
  if(sessionMatch&&req.method==="GET"){const session=getSession(sessionMatch[1]);return session?json(res,200,{...session,messages:listMessagesForAdmin(session.id,50)}):json(res,404,{error:"session not found"});}
  if(sessionMatch&&req.method==="PATCH"){const body=await readJsonBody(req,config.maxBodyBytes);const session=setSessionArchived(sessionMatch[1],Boolean(body.archived));return session?json(res,200,{ok:true,session}):json(res,404,{error:"session not found"});}
  if(sessionMatch&&req.method==="DELETE"){const body=await readJsonBody(req,config.maxBodyBytes);needConfirmation(body);const session=deleteSession(sessionMatch[1]);if(session){sessionPermissions.removeSession(sessionMatch[1]);temporalContextStore.deleteSession(sessionMatch[1]);}return session?json(res,200,{ok:true}):json(res,404,{error:"session not found"});}

  if(req.method==="GET"&&u.pathname==="/admin/memories")return json(res,200,{data:listMemoriesAdmin({personaId:u.searchParams.get("persona_id")??config.defaultPersonaId,status:u.searchParams.get("status")??"all",type:u.searchParams.get("type")??"",source:u.searchParams.get("source")??"",pinned:u.searchParams.get("pinned")??"all",search:u.searchParams.get("search")??"",limit:u.searchParams.get("limit")??500})});
  if(req.method==="GET"&&u.pathname==="/admin/memory/brain")return json(res,200,await memoryEngine.graph(u.searchParams.get("persona_id")??config.defaultPersonaId,{search:u.searchParams.get("search")??"",limit:Math.max(1,Math.min(1000,Number(u.searchParams.get("limit"))||500))}));
  if(req.method==="POST"&&u.pathname==="/admin/memories/prepare"){
    const body=await readJsonBody(req,config.maxBodyBytes),patch=memoryPatch(body);if(!patch.content)return json(res,400,{error:"content required"});
    return json(res,200,inspectManualMemory({personaId:body.persona_id??config.defaultPersonaId,content:patch.content,type:patch.type??"fact"}));
  }
  if(req.method==="POST"&&u.pathname==="/admin/memories"){
    const body=await readJsonBody(req,config.maxBodyBytes),patch=memoryPatch(body);if(!patch.content)return json(res,400,{error:"content required"});
    if(body.mode==="manual"){
      const assessment=inspectManualMemory({personaId:body.persona_id??config.defaultPersonaId,content:patch.content,type:patch.type??"fact"});
      if(assessment.disposition==="invalid")return json(res,400,{error:{message:"这段内容不适合作为长期记忆。",code:assessment.reason},assessment});
      if(assessment.disposition==="review"&&!body.replaces_id&&body.keep_alongside!==true)return json(res,409,{error:{message:"这可能会更新一条现有记忆。",code:"possible_conflict"},assessment});
      const result=await addManualMemory({personaId:body.persona_id??config.defaultPersonaId,content:patch.content,type:patch.type??"fact",importance:patch.importance??0.8,temporalState:patch.temporalState??"current",replacesId:body.replaces_id?String(body.replaces_id):null,keepAlongside:body.keep_alongside===true});
      return json(res,200,{ok:true,...result});
    }
    let memory=await addStagingMemory({personaId:body.persona_id??config.defaultPersonaId,content:patch.content,type:patch.type??"fact",importance:patch.importance??0.8,source:patch.source??"manual"});
    if(memory&&(patch.status||patch.pinned!==undefined)){memory=updateMemory(memory.id,{status:patch.status??memory.status,pinned:patch.pinned??memory.pinned});await refreshMemoryIndex(memory);}
    return json(res,200,{ok:true,memory});
  }
  if(req.method==="POST"&&u.pathname==="/admin/memories/retrieval-debug"){
    const body=await readJsonBody(req,config.maxBodyBytes);if(typeof body.query!=="string"||!body.query.trim())return json(res,400,{error:"query required"});
    const rows=await retrieveMemoriesDetailed(body.persona_id??config.defaultPersonaId,body.query,{limit:Math.max(1,Math.min(50,Number(body.limit)||6)),recordAccess:false,candidateLimit:100});
    return json(res,200,{query:body.query,embedding:getEmbeddingStatus(),data:rows.map(x=>({id:x.memory.id,content:x.memory.content,type:x.memory.type,source:x.memory.source,importance:x.memory.importance,confidence:x.memory.confidence,pinned:Boolean(x.memory.pinned),fts_score:x.fts_score,fts_rank:x.fts_rank,embedding_score:x.embedding_score,text_score:x.text_score,importance_score:x.importance_score,confidence_score:x.confidence_score,recency_score:x.recency_score,access_score:x.access_score,final_score:x.final_score,in_context:x.in_context,reasons:x.reasons}))});
  }
  const memoryMatch=u.pathname.match(/^\/admin\/memories\/([^/]+)$/);
  if(memoryMatch&&req.method==="GET"){const m=getMemory(memoryMatch[1]);return m?json(res,200,m):json(res,404,{error:"memory not found"});}
  if(memoryMatch&&req.method==="PATCH"){let m=updateMemory(memoryMatch[1],memoryPatch(await readJsonBody(req,config.maxBodyBytes)));if(!m)return json(res,404,{error:"memory not found"});await refreshMemoryIndex(m);return json(res,200,{ok:true,memory:m});}
  if(memoryMatch&&req.method==="DELETE"){needConfirmation(await readJsonBody(req,config.maxBodyBytes));if(!getMemory(memoryMatch[1]))return json(res,404,{error:"memory not found"});deleteMemory(memoryMatch[1]);return json(res,200,{ok:true});}

  if(req.method==="GET"&&u.pathname==="/admin/conversations"){
    const rows=listSessionsAdmin({source:u.searchParams.get("source")??null,search:u.searchParams.get("search")??"",archived:u.searchParams.get("archived")??"all",limit:u.searchParams.get("limit")??500});
    const categoryFilter=u.searchParams.get("category")??"";
    const conversations=rows.map(s=>{
      const {category,display_name}=classifyConversation(s);
      return {id:s.id,source:s.source,external_key:s.external_key,category,display_name,
        last_activity:s.updated_at,message_count:s.message_count,recent_message:(s.recent_message??"").slice(0,160),
        archived:Boolean(s.archived_at),status:s.archived_at?"archived":"active"};
    });
    return json(res,200,{data:categoryFilter?conversations.filter(x=>x.category===categoryFilter):conversations});
  }
  const convMsgMatch=u.pathname.match(/^\/admin\/conversations\/([^/]+)\/messages$/);
  if(convMsgMatch&&req.method==="GET"){
    const session=getSession(decodeURIComponent(convMsgMatch[1]));
    if(!session)return json(res,404,{error:"conversation not found"});
    const rows=searchMessagesForAdmin(session.id,{limit:Math.max(1,Math.min(1000,Number(u.searchParams.get("limit"))||300))});
    return json(res,200,{session:{id:session.id,source:session.source,...classifyConversation(session)},data:rows.map(r=>({web_sources:webSourcesForAdminRow(r),voice_asset:voiceAssetForMessage(r.id),...bubbleMetadataForAdminRow(r),...r,attachments:attachmentsForMessage(r.id),tool_activities:toolActivitiesForAdminRow(session.id,r)}))});
  }

  if(u.pathname==="/admin/search/status"&&req.method==="GET"){return json(res,200,searchStatus(config));}

  // ---- MCP / Integrations 管理（secret 绝不回传）----

  if(u.pathname==="/admin/integrations"&&req.method==="GET"){return json(res,200,{data:mcpRegistry.listIntegrations()});}
  if(u.pathname==="/admin/integrations"&&req.method==="POST"){
    const body=await readJsonBody(req,config.maxBodyBytes);
    const created=mcpRegistry.addIntegration({
      name:body?.name,type:body?.type,command:body?.command,args:body?.args,
      env:body?.env&&typeof body.env==="object"?body.env:null,
      url:body?.url,auth:body?.auth?String(body.auth):null,
      authType:body?.authType,oauthClientId:body?.oauthClientId,
      availableToAgent:body?.availableToAgent,availableToChat:body?.availableToChat
    });
    return json(res,201,created);
  }
  const integrationMatch=u.pathname.match(/^\/admin\/integrations\/([^/]+)(\/(tools|test|connect|disconnect|oauth-start))?$/);
  if(integrationMatch){
    const id=decodeURIComponent(integrationMatch[1]),action=integrationMatch[3]??null;
    if(action==="tools"&&req.method==="GET"){
      const tools=mcpRegistry.listTools(id);
      return tools?json(res,200,{data:tools}):json(res,404,{error:"integration not found"});
    }
    if(action==="test"&&req.method==="POST"){const result=await mcpRegistry.testIntegration(id);return result?json(res,200,result):json(res,404,{error:"integration not found"});}
    if(action==="connect"&&req.method==="POST"){const result=await mcpRegistry.connectIntegration(id);return result?json(res,200,result):json(res,404,{error:"integration not found"});}
    if(action==="disconnect"&&req.method==="POST"){await mcpRegistry.disconnectIntegration(id);return json(res,200,{ok:true});}
    if(action==="oauth-start"&&req.method==="POST"){const result=await mcpRegistry.startOAuth(id);return result?json(res,200,result):json(res,404,{error:"integration not found"});}
    if(!action&&req.method==="PUT"){
      const body=await readJsonBody(req,config.maxBodyBytes);
      const updated=await mcpRegistry.updateIntegration(id,body);
      return updated?json(res,200,updated):json(res,404,{error:"integration not found"});
    }
    if(!action&&req.method==="DELETE"){return await mcpRegistry.removeIntegration(id)?json(res,200,{ok:true}):json(res,404,{error:"integration not found"});}
  }

  if(u.pathname==="/admin/mcp-server"&&req.method==="GET"){
    return json(res,200,{
      http_enabled:config.mcpHttpEnabled,
      http_path:"/mcp",
      transports:{stdio:"node src/mcp/server.js --stdio",http:config.mcpHttpEnabled?"POST /mcp (stateless streamable HTTP)":null},
      auth:{type:config.mcpToken?"dedicated_token":"api_key",token_masked:config.mcpToken?`${config.mcpToken.slice(0,4)}…${config.mcpToken.slice(-2)}`:"(复用 Companion API Key)"},
      tools_exposed:COMPANION_MCP_TOOLS.map(t=>({name:t.name,description:t.description,riskLevel:t.riskLevel})),
      integrations:mcpRegistry.listIntegrations().length
    });
  }  if(u.pathname==="/admin/search/config"){
    if(req.method==="GET"){
      const status=searchStatus(config);
      let file={};try{file=JSON.parse(fs.readFileSync(config.searchConfigPath,"utf8"));}catch{}
      return json(res,200,{...status,has_tavily_key:Boolean(config.tavilyApiKey||file.tavily_api_key),searxng_base_url:config.searxngBaseUrl||file.searxng_base_url||""});
    }
    if(req.method==="PUT"||req.method==="PATCH"){
      const body=await readJsonBody(req,config.maxBodyBytes);
      const provider=String(body?.provider??"none").toLowerCase();
      if(!["none","tavily","searxng"].includes(provider))return json(res,400,{error:{message:"provider 必须是 none / tavily / searxng",type:"invalid_request_error"}});
      const next={provider};
      if(body?.tavily_api_key!==undefined){
        const key=String(body.tavily_api_key??"").trim();
        if(key&&!/^[\x21-\x7E]{8,256}$/.test(key))return json(res,400,{error:{message:"Tavily API Key 格式不正确",type:"invalid_request_error"}});
        next.tavily_api_key=key;
      }else{
        try{next.tavily_api_key=JSON.parse(fs.readFileSync(config.searchConfigPath,"utf8")).tavily_api_key??"";}catch{next.tavily_api_key="";}
      }
      next.searxng_base_url=String(body?.searxng_base_url??(provider==="searxng"?safeReadConfigField(config.searchConfigPath,"searxng_base_url"):"")).trim();      if(next.searxng_base_url){
        try{const host=new URL(next.searxng_base_url).hostname;if(!/^[\w.-]+$/.test(host))throw new Error("bad host");}catch{return json(res,400,{error:{message:"SearXNG 地址不合法",type:"invalid_request_error"}});}
        next.searxng_base_url=next.searxng_base_url.replace(/\/+$/,"");
      }
      try{
        fs.mkdirSync(path.dirname(config.searchConfigPath),{recursive:true});
        fs.writeFileSync(config.searchConfigPath,JSON.stringify(next,null,2),{mode:0o600});
        try{fs.chmodSync(config.searchConfigPath,0o600);}catch{}
      }catch(e){return json(res,500,{error:{message:"搜索配置写入失败",type:"internal_error"}});}
      setSearchRuntimeConfig(next);
      return json(res,200,searchStatus(config));
    }
  }

  if(req.method==="GET"&&u.pathname==="/admin/companion/state"){return json(res,200,{...companionStateSummary(),quiet_hours_now:inQuietHours(),bus:busStats(),proactive_today:proactiveCountsToday()});}
  if(req.method==="GET"&&u.pathname==="/admin/proactive/cognition")return json(res,200,proactiveCognitionMetrics.snapshot());
  if(req.method==="GET"&&u.pathname==="/admin/inactivity/status"){
    const state=getState();
    const effectiveState={...state,lastUserInteractionAt:effectiveLastUserInteractionAt(state)};
    return json(res,200,{
      overrideEnabled:Boolean(config.inactivityDevOverrideEnabled),
      effectiveLastUserInteractionAt:effectiveLastUserInteractionAt(state),
      simulatedLastUserInteractionAt:state.inactivity?.simulatedLastUserInteractionAt??null,
      cognition_wake:evaluateInactivityEligibility({state:effectiveState,hasSuitableContext:true}),
      candidates:gatherCandidates().map(c=>({kind:c.kind,proactive_reason:c.proactiveReason??null,score:c.score})),
      audits:recentInactivityAudits(10)
    });
  }
  if(u.pathname==="/admin/inactivity/simulate"){
    if(!config.inactivityDevOverrideEnabled)return json(res,403,{error:{message:"inactivity time simulation is disabled",type:"forbidden"}});
    if(req.method==="DELETE")return json(res,200,{ok:true,...setInactivitySimulation({clear:true})});
    if(req.method==="POST"||req.method==="PUT"){
      const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
      if(body?.clear===true)return json(res,200,{ok:true,...setInactivitySimulation({clear:true})});
      const hoursAgo=body?.hours_ago??body?.hoursAgo??body?.hours;
      const lastUserInteractionAt=body?.last_user_interaction_at??body?.lastUserInteractionAt;
      if(hoursAgo===undefined&&lastUserInteractionAt===undefined)return json(res,400,{error:{message:"hours_ago or last_user_interaction_at required",type:"invalid_request_error"}});
      const result=setInactivitySimulation({hoursAgo:hoursAgo===undefined?null:Number(hoursAgo),lastUserInteractionAt:lastUserInteractionAt??null});
      return json(res,200,{ok:true,...result});
    }
  }
  if(req.method==="POST"&&u.pathname==="/admin/inactivity/heartbeat"){
    // 仅 candidate/dev：production 未开启 override 时拒绝远程触发。
    if(!config.inactivityDevOverrideEnabled)return json(res,403,{error:{message:"inactivity heartbeat trigger requires COMPANION_INACTIVITY_DEV_OVERRIDE_ENABLED",type:"forbidden"}});
    try{
      const result=await runHeartbeat();
      return json(res,200,{ok:true,result});
    }catch(error){
      return json(res,500,{error:{message:String(error?.message??error),type:"internal_error"}});
    }
  }
  if(req.method==="GET"&&u.pathname==="/admin/natural-presence"){
    return json(res,200,naturalPresence.snapshot());
  }
  if(req.method==="GET"&&u.pathname==="/admin/natural-cognition"){
    return json(res,200,naturalCognition.snapshot());
  }
  if(req.method==="GET"&&u.pathname==="/admin/natural-repair"){
    const sessionId=u.searchParams.get("session")||"";
    if(!sessionId)return json(res,200,{ok:true,current:null,repairs:[]});
    return json(res,200,{ok:true,current:repairStore.current(sessionId),repairs:repairStore.list(sessionId)});
  }
  if(req.method==="POST"&&u.pathname==="/admin/natural-cognition/seen"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    const ids=Array.isArray(body.message_ids)?body.message_ids:(body.message_id!=null?[body.message_id]:[]);
    const result=onMacSeen({
      messageIds:ids,
      sessionId:body.session_id??null,
      windowActive:Boolean(body.window_active??true),
      chatVisible:Boolean(body.chat_visible??true)
    });
    return json(res,200,{ok:true,...result});
  }
  if(req.method==="POST"&&u.pathname==="/admin/natural-cognition/attention"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    return json(res,200,{ok:true,attention:onMacAttention({windowActive:body.window_active,chatVisible:body.chat_visible})});
  }
  if(req.method==="GET"&&u.pathname==="/admin/voice-profiles"){
    return json(res,200,{profiles:VOICE_PROFILES,active_default:"neutral",resolved:{
      neutral:profileReference("neutral"),happy:profileReference("happy"),low_energy:profileReference("low_energy"),annoyed:profileReference("annoyed"),angry:profileReference("angry")
    }});
  }
  if(req.method==="POST"&&u.pathname==="/admin/voice-profiles/preview-style"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    const style=selectVoiceStyle({presence:body?.presence??naturalPresence.snapshot({advance:false}),previousStyle:body?.previous_style??"neutral",bubbleIndex:Number(body?.bubble_index??0),text:String(body?.text??"")});
    return json(res,200,{ok:true,style,reference:profileReference(style.style)});
  }
  if(req.method==="GET"&&u.pathname==="/admin/tts-providers"){
    return json(res,200,await listTtsProviders());
  }
  if(req.method==="GET"&&u.pathname==="/admin/voice-async"){
    return json(res,200,snapshotVoiceAsyncDiagnostics());
  }
  if(req.method==="POST"&&u.pathname==="/admin/tts-providers/select"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    const id=String(body?.id??body?.provider??"").trim();
    try{
      const state=setSelectedTtsProvider(id);
      return json(res,200,{ok:true,...state,providers:(await listTtsProviders()).providers});
    }catch(error){
      return json(res,Number(error?.statusCode)||400,{error:{message:String(error?.message??error),type:"tts_provider_error"}});
    }
  }
  if(req.method==="POST"&&u.pathname==="/admin/tts-providers/synthesize"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    try{
      const result=await synthesizeWithSelectedProvider({
        text:String(body?.text??"").slice(0,2000),
        style:String(body?.style??"neutral"),
        sessionId:String(body?.session_id??"tts-provider-preview")
      });
      return json(res,200,{
        ok:true,
        id:result.id,
        provider:result.provider,
        duration_ms:result.durationMs,
        bytes:result.bytes,
        style:result.style,
        meta:result.meta??null
      });
    }catch(error){
      return json(res,Number(error?.statusCode)||500,{error:{message:String(error?.message??error),type:error?.code??"tts_error"}});
    }
  }
  if(req.method==="POST"&&u.pathname==="/admin/chat/voice-message"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    try{
      const result=await ingestUserVoiceMessage({
        audioBase64:body?.audio_base64??body?.audioBase64,
        durationMs:body?.duration_ms??body?.durationMs,
        sessionId:body?.session_id??null,
        source:String(body?.source??"chat")
      });
      return json(res,200,{ok:true,...result});
    }catch(error){
      const status=Number(error?.statusCode)||500;
      return json(res,status,{error:{message:String(error?.message??error),type:error?.code??"voice_message_error"}});
    }
  }
  if(req.method==="POST"&&u.pathname==="/admin/conversation-grounding/classify"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    const result=classifyGrounding({
      userText:String(body?.user_text??body?.userText??""),
      activeTopic:body?.active_topic??null,
      recentTopics:Array.isArray(body?.recent_topics)?body.recent_topics:[],
      recentReferents:Array.isArray(body?.recent_referents)?body.recent_referents:[],
      openLoops:Array.isArray(body?.open_loops)?body.open_loops:[],
      recentUserTexts:Array.isArray(body?.recent_user_texts)?body.recent_user_texts:[],
      longTermMemoryHits:Array.isArray(body?.long_term_memory_hits)?body.long_term_memory_hits:[],
      bindings:body?.bindings&&typeof body.bindings==="object"?body.bindings:{}
    });
    return json(res,200,{ok:true,result});
  }
  if(req.method==="POST"&&u.pathname==="/admin/natural-presence/evaluate"){
    if(!config.naturalPresenceEnabled)return json(res,409,{error:{message:"natural presence disabled",type:"conflict"}});
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    const result=await evaluateAndApplyTurn({
      userText:String(body?.user_text??body?.userText??""),
      assistantText:String(body?.assistant_text??body?.assistantText??""),
      sessionId:body?.session_id??null,
      useLlm:Boolean(body?.use_llm??body?.useLlm??true)
    });
    return json(res,200,result);
  }
  if(req.method==="POST"&&u.pathname==="/admin/natural-presence/contact-decision"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    const decision=decideContact({
      lastUserInteractionAt:body?.last_user_interaction_at??null,
      at:new Date(),
      inactivity:body?.inactivity??null
    });
    return json(res,200,{ok:true,decision,presence:naturalPresence.snapshot({advance:false})});
  }
  if(req.method==="POST"&&u.pathname==="/admin/natural-presence/open-loops"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    if(body?.resolve){
      const n=naturalPresence.resolveOpenLoops(Array.isArray(body.resolve)?body.resolve:[String(body.resolve)]);
      return json(res,200,{ok:true,resolved:n});
    }
    const created=naturalPresence.upsertOpenLoops(Array.isArray(body?.loops)?body.loops:[body??{}]);
    return json(res,200,{ok:true,created});
  }
  if(u.pathname==="/admin/companion/behavior"){
    if(req.method==="GET")return json(res,200,getBehavior());
    if(req.method==="PATCH"||req.method==="PUT"){
      const body=await readJsonBody(req,config.maxBodyBytes);
      return json(res,200,{ok:true,behavior:updateBehavior(body)});
    }
  }

  const modCfgMatch=u.pathname.match(/^\/admin\/modules\/([^/]+)\/config$/);
  if(modCfgMatch){
    const id=decodeURIComponent(modCfgMatch[1]);
    const cfgDir=path.resolve(process.env.COMPANION_MODULES_CONFIG_DIR||"./data/modules-config");
    const cfgFile=path.join(cfgDir,`${id}.json`);
    if(req.method==="GET"){
      let cfg=null;try{cfg=JSON.parse(fs.readFileSync(cfgFile,"utf8"));}catch{}
      return json(res,200,{id,config:cfg});
    }
    if(req.method==="PUT"||req.method==="PATCH"){
      const body=await readJsonBody(req,config.maxBodyBytes);
      if(!body||typeof body!=="object"||Array.isArray(body))return json(res,400,{error:"module config must be a JSON object"});
      fs.mkdirSync(cfgDir,{recursive:true});
      const tmpF=`${cfgFile}.tmp`;fs.writeFileSync(tmpF,JSON.stringify(body,null,2));fs.renameSync(tmpF,cfgFile);
      await moduleRegistry.loadAll({rescan:true});
      return json(res,200,{ok:true,id,config:body,reloaded:true});
    }
  }

  if(req.method==="GET"&&u.pathname==="/admin/usage")return json(res,200,{data:listUsageStats({from:u.searchParams.get("from")??"",to:u.searchParams.get("to")??"",source:u.searchParams.get("source")??"",publicModel:u.searchParams.get("public_model")??"",upstreamModel:u.searchParams.get("upstream_model")??"",sessionId:u.searchParams.get("session_id")??"",kind:u.searchParams.get("kind")??"",groupBy:u.searchParams.get("group_by")??"date"})});

  const ledgerResetMatch=u.pathname.match(/^\/admin\/modules\/ledger\/reset$/);
  if(ledgerResetMatch&&req.method==="POST"){
    const body=await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    if(body?.confirm!==true){
      return json(res,400,{error:"旧请求的执行状态将无法恢复，之后重放可能造成重复副作用。确认无误请携带 \"confirm\":true 重新提交。",requires_confirm:true});
    }
    if(moduleExecutionLedger.health!=="corrupt"){
      return json(res,409,{error:"execution ledger is not corrupt; refusing to wipe valid execution state"});
    }
    const health=moduleExecutionLedger.resetManual();
    console.error("[modules] execution ledger manually reset by operator; previous execution states are unrecoverable");
    return json(res,200,{ok:true,health,warning:"旧请求的执行状态将无法恢复，之后重放可能造成重复副作用。"});
  }

  if(req.method==="GET"&&u.pathname==="/admin/modules")return json(res,200,moduleRegistry.listStatus());
  if(req.method==="POST"&&u.pathname==="/admin/modules/reload"){if(!config.modulesEnabled)return json(res,409,{error:"modules disabled by MODULES_ENABLED=false"});const status=await moduleRegistry.loadAll({rescan:true});return json(res,200,status);}
  const moduleMatch=u.pathname.match(/^\/admin\/modules\/([^/]+)(?:\/(enable|disable))?$/);
  if(moduleMatch&&(req.method==="POST"||req.method==="PATCH")){
    const id=decodeURIComponent(moduleMatch[1]);
    const action=moduleMatch[2]??(req.method==="POST"?"enable":"");
    if(!action)return json(res,400,{error:"action required"});
    if(!config.modulesEnabled)return json(res,409,{error:"modules disabled by MODULES_ENABLED=false"});
    const described=await moduleRegistry.setEnabled(id,action==="enable");
    return described?json(res,200,{ok:true,module:described}):json(res,404,{error:"module not found"});
  }
  const triggerRunMatch=u.pathname.match(/^\/admin\/modules\/([^/]+)\/triggers\/([^/]+)\/run$/);
  if(triggerRunMatch&&req.method==="POST"){
    await readJsonBody(req,config.maxBodyBytes).catch(()=>({}));
    if(!config.modulesEnabled)return json(res,409,{error:"modules disabled by MODULES_ENABLED=false"});
    const result=await triggerEngine.run(decodeURIComponent(triggerRunMatch[1]),decodeURIComponent(triggerRunMatch[2]),{depth:0});
    return json(res,result.ok?200:409,result);
  }
  return false;
}
