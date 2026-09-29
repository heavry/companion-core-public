import { config } from "./config.js";
import { db,listMemoriesAdmin,listPersonas,listRecentEvents,listSessionsAdmin } from "./db.js";
import { companionStateSummary,evaluateProactiveGate } from "./companion-state.js";
import { scheduler } from "./scheduler.js";
import { buildCapabilityRegistry } from "./capability-registry.js";
import { moduleRegistry } from "./modules/registry.js";
import { mcpRegistry } from "./mcp/client.js";
import { searchStatus,WEB_SEARCH_TOOL_SPEC } from "./search/index.js";
import { invocationLedger } from "./usage-ledger.js";
import { companionTime } from "./time-service.js";
import { diaryProductSnapshot } from "./natural-diary/retrieval.js";
import { validLocalDate } from "./natural-diary/dates.js";
import { capabilityInstaller } from "./capability-installer.js";
import { voiceTTSCapabilityContext } from "./voice-tts-adapter.js";
import { attentionStore } from "./attention-store.js";
import { localGPTSoVITSService } from "./local-gpt-sovits-service.js";

function publicPersonaName(name){
  const value=String(name??"").trim();
  return !value||/^yuna$/i.test(value)?"林小糖":value;
}

function safePersona(persona){
  if(!persona)return null;
  return {
    id:persona.id,name:publicPersonaName(persona.name),coreIdentity:persona.core_identity,
    personality:Array.isArray(persona.personality)?persona.personality:[],
    speakingStyle:{
      tone:persona.speaking_style?.tone??"",
      verbosity:persona.speaking_style?.verbosity??"",
      emojiFrequency:persona.speaking_style?.emoji_frequency??"",
      rules:Array.isArray(persona.speaking_style?.rules)?persona.speaking_style.rules:[]
    },
    memoryEnabled:persona.memory?.enabled!==false
  };
}

function usageToday(){
  const row=invocationLedger.snapshot().today;
  return {
    requests:Number(row.requests)||0,inputTokens:row.inputTokens,outputTokens:row.outputTokens,cachedTokens:row.cachedInputTokens,
    totalTokens:row.inputTokens==null||row.outputTokens==null?null:row.inputTokens+row.outputTokens,
    unknownTokenRequests:Number(row.unknownUsage)||0
  };
}

export function todayProductSnapshot({dateLocal=null}={}){
  const state=companionStateSummary(),gate=evaluateProactiveGate({kind:"message"});
  const selectedDate=validLocalDate(dateLocal)?dateLocal:companionTime.localDate();
  const events=listRecentEvents(config.defaultPersonaId,12).map(event=>({
    id:event.id,source:event.source,content:event.content,importance:Number(event.importance),
    createdAt:event.created_at
  }));
  const agentActivity=listSessionsAdmin({archived:"false",limit:100})
    .filter(session=>/agent|opencode|harness|code/i.test(String(session.source)))
    .slice(0,6)
    .map(session=>({id:session.id,source:session.source,updatedAt:session.updated_at,messageCount:Number(session.message_count)||0}));
  return {
    generatedAt:companionTime.nowUTC(),timeZone:companionTime.timeZone,localDate:companionTime.localDate(),localTime:companionTime.localTime(),weekday:companionTime.weekday(),dayPart:companionTime.dayPart(),
    events,
    plans:{available:true,upcoming:scheduler.snapshot().plans.filter(plan=>plan.enabled&&plan.nextRunAt).slice(0,6)},
    proactive:{
      allowed:gate.allowed,reasons:gate.reasons,level:gate.behavior.proactiveLevel,
      messagesToday:gate.counts.messages,dailyCap:gate.behavior.dailyProactiveCap,
      pendingFollowups:state.pendingFollowups,lastProactiveAt:state.lastProactiveAt,
      quietHoursNow:gate.reasons.includes("quiet_hours")
    },
    usage:usageToday(),
    recentAgentActivity:agentActivity,
    attention:attentionStore.snapshot({limit:8}),
    diary:diaryProductSnapshot(selectedDate)
  };
}

export function relationshipProductSnapshot(){
  const persona=safePersona(listPersonas().find(item=>item.id===config.defaultPersonaId)??listPersonas()[0]);
  const memories=listMemoriesAdmin({personaId:persona?.id??config.defaultPersonaId,status:"all",limit:1000});
  const statusCounts=memories.reduce((out,item)=>{out[item.status]=(out[item.status]??0)+1;return out;},{});
  const typeCounts=memories.reduce((out,item)=>{out[item.type]=(out[item.type]??0)+1;return out;},{});
  const session=db.prepare(`
    SELECT summary,updated_at
    FROM sessions
    WHERE persona_id=? AND summary IS NOT NULL AND trim(summary)<>''
      AND lower(source) NOT LIKE '%agent%' AND lower(source) NOT LIKE '%opencode%' AND lower(source) NOT LIKE '%harness%'
    ORDER BY updated_at DESC LIMIT 1
  `).get(persona?.id??config.defaultPersonaId);
  return {
    generatedAt:new Date().toISOString(),
    persona,
    memoryOverview:{
      total:memories.length,active:Number(statusCounts.active)||0,staging:Number(statusCounts.staging)||0,
      historical:Number(statusCounts.retired)||0,types:typeCounts,
      recent:memories.slice(0,5).map(item=>({id:item.id,content:item.content,type:item.type,status:item.status,source:item.source,updatedAt:item.updated_at}))
    },
    contextSummary:session?.summary??null,
    contextUpdatedAt:session?.updated_at??null,
    importantEvents:listRecentEvents(persona?.id??config.defaultPersonaId,8).map(event=>({
      id:event.id,content:event.content,source:event.source,importance:Number(event.importance),createdAt:event.created_at
    })),
    journal:{available:false,entries:[]}
  };
}

function capabilityCategory(capability){
  const text=`${capability.name} ${capability.displayName} ${capability.description} ${(capability.tags??[]).join(" ")}`.toLowerCase();
  if(/image|generate|create media|生成|绘图/.test(text))return "Creation";
  if(/send|email|message|notion|publish|communication|发送|通知/.test(text))return "Communication";
  if(/search|weather|read|list|get|query|browser|inspect|perception|搜索|读取|查看|天气/.test(text))return "Perception";
  if(capability.sideEffect!=="idempotent"||/write|create|update|delete|toggle|execute|action|写入|修改|删除/.test(text))return "Action";
  return "System / Advanced";
}

export function capabilityProductSnapshot(){
  const search=searchStatus(config),integrations=new Map(mcpRegistry.listIntegrations().map(item=>[item.id,item]));
  const modules=new Map(moduleRegistry.listStatus().modules?.map(item=>[item.id,item])??[]);
  const registry=[...voiceTTSCapabilityContext().capabilities,...buildCapabilityRegistry({coreTools:search.configured?[WEB_SEARCH_TOOL_SPEC(config.webSearchMaxResults)]:[],moduleTools:moduleRegistry.enabledModuleTools(),mcpCapabilities:mcpRegistry.allCapabilities()})];
  const managed=capabilityInstaller.status("computer.use"),computerUse={id:"computer.use",name:"Computer Use",wireName:"computer.use",description:"通过 Cua Driver 观察并操作 macOS 原生应用；仍由 Companion Native Agent 负责规划与审批。",category:"Action",enabled:managed.enabled,configured:managed.installed,scope:["Agent"],provider:"cua",permission:managed.permissions??["screen.read","mouse.control","keyboard.control","app.launch","window.control"],riskLevel:"medium",health:managed.health,lastStatus:managed.lastError,requiresApproval:true,installable:true,installed:managed.installed,status:managed.operation?.status??(managed.installed?(managed.enabled?"installed":"disabled"):managed.health==="error"?"error":"not_installed"),sourceUrl:managed.sourceUrl,version:managed.version,upstreamCommit:managed.upstreamCommit,license:managed.license,installTime:managed.installTime,installPath:managed.installPath,adapterVersion:managed.adapterVersion,lastTest:managed.lastTest,macOSPermissions:managed.macOSPermissions??["accessibility","screen_recording"],operation:managed.operation};
  return {generatedAt:new Date().toISOString(),source:"companion-capability-registry",data:[computerUse,...registry.map(capability=>{
    const integration=capability.sourceType==="mcp"?integrations.get(capability.sourceId):null,module=capability.sourceType==="module"?modules.get(capability.sourceId):null;
    const scopes=capability.sourceType==="mcp"?[integration?.availableToAgent!==false?"Agent":null,integration?.availableToChat===true?"Chat":null].filter(Boolean):["Agent"];
    const health=capability.id==="native:voice.tts"?(localGPTSoVITSService.publicStatus().ready?"ready":localGPTSoVITSService.publicStatus().state):integration?.status??(module?(module.loaded?"ready":"error"):(capability.availability??"available"));
    return {id:capability.id,name:capability.displayName,wireName:capability.name,description:capability.description,category:capabilityCategory(capability),enabled:capability.enabled!==false,configured:capability.id==="native:voice.tts"?localGPTSoVITSService.publicStatus().configured:health==="connected"||health==="ready"||health==="available",scope:scopes,provider:capability.sourceId??capability.sourceType,permission:capability.permissions??[],riskLevel:capability.riskLevel,health,lastStatus:integration?.lastError??module?.last_error??null,requiresApproval:capability.riskLevel==="high"||capability.permissions?.includes("external_action")};
  })]};
}
