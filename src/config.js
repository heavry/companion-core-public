import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const localHome = os.homedir();

function loadDotEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const env = (name, fallback = "") => process.env[name] ?? fallback;
const int = (name, fallback) => {
  const n = Number.parseInt(env(name, ""), 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (name, fallback) => {
  const v = env(name, "");
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

let extraHeaders = {};
try {
  extraHeaders = JSON.parse(env("UPSTREAM_EXTRA_HEADERS_JSON", "{}"));
} catch {
  throw new Error("UPSTREAM_EXTRA_HEADERS_JSON 必须是合法 JSON");
}

const apiKey = env("COMPANION_API_KEY", "CHANGE_ME_TO_A_LONG_RANDOM_KEY");
const databasePath = path.resolve(env("DATABASE_PATH", "./data/companion.db"));
const durableDataDir = path.dirname(databasePath);
const legacyBaseUrl = env("UPSTREAM_BASE_URL", "https://api.x.ai/v1").replace(/\/+$/, "");
const legacyApiKey = env("UPSTREAM_API_KEY", "");
const legacyChatModel = env("UPSTREAM_CHAT_MODEL", "replace-with-real-model-id");
const legacyAgentModel = env("UPSTREAM_AGENT_MODEL", "replace-with-real-model-id");
const legacySummaryModel = env("UPSTREAM_SUMMARY_MODEL", legacyChatModel);
const primaryBaseUrl = env("UPSTREAM_PRIMARY_BASE_URL", "").replace(/\/+$/, "");
const primaryApiKey = env("UPSTREAM_PRIMARY_API_KEY", "");
const primaryModel = env("UPSTREAM_PRIMARY_MODEL", "");
const usesPrimaryFields = Boolean(primaryBaseUrl||primaryApiKey||primaryModel);
const primaryProvider = {
  name: "primary",
  baseUrl: primaryBaseUrl||legacyBaseUrl,
  apiKey: usesPrimaryFields?primaryApiKey:legacyApiKey,
  model: primaryModel,
  chatModel: primaryModel || legacyChatModel,
  agentModel: primaryModel || legacyAgentModel,
  summaryModel: primaryModel || legacySummaryModel
};
const secondaryModel = env("UPSTREAM_SECONDARY_MODEL", "");
const secondaryProvider = {
  name: "secondary",
  baseUrl: env("UPSTREAM_SECONDARY_BASE_URL", "").replace(/\/+$/, ""),
  apiKey: env("UPSTREAM_SECONDARY_API_KEY", ""),
  model: secondaryModel,
  chatModel: secondaryModel,
  agentModel: secondaryModel,
  summaryModel: secondaryModel
};

function addKindRoutes(provider,prefix){
  const route=(kind,defaultModel)=>({
    baseUrl:env(`${prefix}_${kind.toUpperCase()}_BASE_URL`,provider.baseUrl).replace(/\/+$/, ""),
    apiKey:env(`${prefix}_${kind.toUpperCase()}_API_KEY`,provider.apiKey),
    model:prefix==="UPSTREAM"?defaultModel:env(`${prefix}_${kind.toUpperCase()}_MODEL`,defaultModel)
  });
  return {...provider,routes:{
    chat:route("chat",provider.chatModel),
    agent:route("agent",provider.agentModel),
    summary:route("summary",provider.summaryModel)
  }};
}

const routedPrimaryProvider=addKindRoutes(primaryProvider,"UPSTREAM");
const routedSecondaryProvider=addKindRoutes(secondaryProvider,"UPSTREAM_SECONDARY");

// 测试 fail-closed 守卫：设置 COMPANION_BLOCK_REAL_UPSTREAM=1 时，
// 任何非回环且非空的上游配置（含从 .env 意外泄漏的值）都会直接拒绝启动，绝不回退。
// 空 baseUrl 视为"该路由未配置"，不视为违规。
if(env("COMPANION_BLOCK_REAL_UPSTREAM","")==="1"){
  const offenders=[];
  const loopbackSafeUrls=[["primary",routedPrimaryProvider],["secondary",routedSecondaryProvider]].flatMap(([providerName,provider])=>Object.entries(provider.routes??{}).map(([kind,route])=>[`${providerName}.${kind}`,route?.baseUrl]));
  // 搜索后端仅在显式配置（URL/Key）时才纳入守卫：默认官方端点在未启用搜索时不视为违规。
  if(env("TAVILY_BASE_URL","")||env("TAVILY_API_KEY",""))loopbackSafeUrls.push(["search.tavily",env("TAVILY_BASE_URL","https://api.tavily.com")]);
  if(env("SEARXNG_BASE_URL",""))loopbackSafeUrls.push(["search.searxng",env("SEARXNG_BASE_URL","")]);
  for(const [label,raw] of loopbackSafeUrls){
    const value=String(raw??"");
    if(!value)continue;
    let host="";
    try{host=new URL(value).hostname;}catch{host="<invalid-url>";}
    if(!["127.0.0.1","localhost","::1"].includes(host))offenders.push(`${label}→${host}`);
  }
  if(offenders.length)throw new Error(`COMPANION_BLOCK_REAL_UPSTREAM=1 且检测到非回环上游/搜索配置，fail closed: ${offenders.join(", ")}`);
}

export const config = {
  version: "0.2.8.0",
  host: env("COMPANION_HOST", "0.0.0.0"),
  port: int("COMPANION_PORT", 8765),
  apiKey,
  adminKey: env("COMPANION_ADMIN_KEY", "") || apiKey,
  adminRemoteAccess: bool("ADMIN_REMOTE_ACCESS", false),
  corsAllowOrigin: env("CORS_ALLOW_ORIGIN", "*"),
  maxBodyBytes: int("MAX_BODY_BYTES", 25 * 1024 * 1024),
  defaultPersonaId: env("DEFAULT_PERSONA_ID", "yuna"),

  upstreamProviders: {primary:routedPrimaryProvider,secondary:routedSecondaryProvider},
  upstreamBaseUrl: routedPrimaryProvider.routes.chat.baseUrl,
  upstreamApiKey: routedPrimaryProvider.routes.chat.apiKey,
  upstreamChatModel: routedPrimaryProvider.routes.chat.model,
  upstreamAgentModel: routedPrimaryProvider.routes.agent.model,
  upstreamSummaryModel: routedPrimaryProvider.routes.summary.model,
  upstreamExtraHeaders: extraHeaders,
  upstreamTimeoutMs: int("UPSTREAM_TIMEOUT_MS", 600000),
  summaryTimeoutMs: int("SUMMARY_TIMEOUT_MS", 120000),
  networkRetryAttempts: Math.max(1,Math.min(5,int("NETWORK_RETRY_ATTEMPTS", 3))),
  networkRecoveryWindowMs: Math.max(1000,Math.min(120000,int("NETWORK_RECOVERY_WINDOW_MS", 30000))),
  networkCircuitThreshold: Math.max(1,Math.min(10,int("NETWORK_CIRCUIT_THRESHOLD", 3))),
  networkCircuitOpenMs: Math.max(1000,Math.min(120000,int("NETWORK_CIRCUIT_OPEN_MS", 20000))),
  upstreamFailureThreshold: Math.max(1,Math.min(10,int("UPSTREAM_FAILURE_THRESHOLD", 2))),
  upstreamPrimaryRecoveryMs: Math.max(100,Math.min(3600000,int("UPSTREAM_PRIMARY_RECOVERY_MS", 30000))),

  databasePath,
  deploymentRole: env("COMPANION_DEPLOYMENT_ROLE", "local-primary"),
  instanceId: env("COMPANION_INSTANCE_ID", ""),
  instanceIdentityPath: path.resolve(env("COMPANION_INSTANCE_ID_PATH", path.join(durableDataDir,"instance-identity.json"))),
  primaryLockPath: path.resolve(env("COMPANION_PRIMARY_LOCK_PATH", path.join(durableDataDir,"primary-instance.lock"))),
  turnRecoveryPath: path.join(path.dirname(databasePath),"turn-recovery.json"),
  personaSyncOnStart: bool("PERSONA_SYNC_ON_START", false),

  chatIncludeStoredRecent: bool("CHAT_INCLUDE_STORED_RECENT", true),
  agentIncludeStoredRecent: bool("AGENT_INCLUDE_STORED_RECENT", false),
  chatStoredRecentMessages: int("CHAT_STORED_RECENT_MESSAGES", 24),
  agentStoredRecentMessages: int("AGENT_STORED_RECENT_MESSAGES", 8),
  agentInjectSessionSummary: bool("AGENT_INJECT_SESSION_SUMMARY", true),
  agentToolMode: ["native","compat"].includes(env("AGENT_TOOL_MODE", "compat"))?env("AGENT_TOOL_MODE", "compat"):"compat",
  agentToolProtocolRetries: Math.max(0,Math.min(2,int("AGENT_TOOL_PROTOCOL_RETRIES", 0))),
  agentToolCandidateLimit: Math.max(1,Math.min(12,int("AGENT_TOOL_CANDIDATE_LIMIT", 12))),
  agentCompatRetryGuardMs: Math.max(1000,Math.min(60000,int("AGENT_COMPAT_RETRY_GUARD_MS", 15000))),

  modulesDir: path.resolve(env("COMPANION_MODULES_DIR", "./modules")),
  modulesEnabled: bool("MODULES_ENABLED", true),
  moduleLoadTimeoutMs: int("MODULE_LOAD_TIMEOUT_MS", 3000),
  moduleCallTimeoutMs: int("MODULE_CALL_TIMEOUT_MS", 15000),
  moduleToolMaxLoops: Math.max(1, Math.min(32, int("AGENT_MODULE_TOOL_MAX_LOOPS", 8))),
  moduleToolResultMaxChars: int("MODULE_TOOL_RESULT_MAX_CHARS", 65536),
  moduleNetworkTimeoutMs: int("MODULE_NETWORK_TIMEOUT_MS", 10000),
  moduleNetworkMaxBytes: int("MODULE_NETWORK_MAX_BYTES", 262144),
  moduleNetworkBinaryMaxBytes: int("MODULE_NETWORK_BINARY_MAX_BYTES", 8388608),
  moduleTriggerMinSeconds: Math.max(1, int("MODULE_TRIGGER_MIN_SECONDS", 30)),
  moduleTriggerTickMs: Math.max(200, int("MODULE_TRIGGER_TICK_MS", 1000)),
  moduleTriggerMaxDepth: Math.max(0, int("MODULE_TRIGGER_MAX_DEPTH", 2)),
  modulesStatePath: path.resolve(env("COMPANION_MODULES_STATE_PATH", "./data/modules-state.json")),
  companionStatePath: path.resolve(env("COMPANION_STATE_PATH", "./data/companion-state.json")),
  companionBehaviorPath: path.resolve(env("COMPANION_BEHAVIOR_PATH", "./data/companion-behavior.json")),
  autonomousLifeEnabled: bool("COMPANION_AUTONOMOUS_LIFE_ENABLED", true),
  autonomousLifeStatePath: path.resolve(env("COMPANION_AUTONOMOUS_LIFE_STATE_PATH", path.join(durableDataDir,"autonomous-life.json"))),
  autonomousLifeActiveWindowMs: Math.max(60_000,Math.min(6*60*60_000,int("COMPANION_AUTONOMOUS_ACTIVE_WINDOW_SECONDS",30*60)*1000)),
  autonomousLifeReflectionEventThreshold: Math.max(3,Math.min(100,int("COMPANION_AUTONOMOUS_REFLECTION_EVENT_THRESHOLD",8))),
  autonomousLifeReflectionMinIntervalMs: Math.max(60_000,Math.min(7*24*60*60_000,int("COMPANION_AUTONOMOUS_REFLECTION_MIN_INTERVAL_SECONDS",6*60*60)*1000)),
  inactivityDevOverrideEnabled: env("NODE_ENV","development")!=="production"&&bool("COMPANION_INACTIVITY_DEV_OVERRIDE_ENABLED",false),
  naturalMessagingEnabled: bool("COMPANION_NATURAL_MESSAGING_ENABLED", true),
  // Character Runtime v1 — First-person Reasoning Layer. Default off = clean 2f35880.
  firstPersonReasoningEnabled: bool("COMPANION_FIRST_PERSON_REASONING_ENABLED", false),
  naturalMessagingMaxBubbles: Math.max(1, Math.min(3, int("COMPANION_NATURAL_MESSAGING_MAX_BUBBLES", 3))),
  naturalMessagingMaxDelayMs: Math.max(200, Math.min(5000, int("COMPANION_NATURAL_MESSAGING_MAX_DELAY_MS", 1800))),
  naturalPresenceEnabled: bool("COMPANION_NATURAL_PRESENCE_ENABLED", true),
  naturalPresenceStatePath: path.resolve(env("COMPANION_NATURAL_PRESENCE_PATH", path.join(durableDataDir,"natural-presence.json"))),
  naturalPresenceEventModelTimeoutMs: Math.max(2000, Math.min(30000, int("COMPANION_NATURAL_PRESENCE_EVENT_TIMEOUT_MS", 12000))),
  naturalCognitionEnabled: bool("COMPANION_NATURAL_COGNITION_ENABLED", true),
  naturalCognitionStatePath: path.resolve(env("COMPANION_NATURAL_COGNITION_PATH", path.join(durableDataDir,"natural-cognition.json"))),
  naturalDiaryEnabled: bool("COMPANION_NATURAL_DIARY_ENABLED", true),
  naturalDiaryHour: Math.max(0, Math.min(23, int("COMPANION_NATURAL_DIARY_HOUR", 23))),
  naturalDiaryMinute: Math.max(0, Math.min(59, int("COMPANION_NATURAL_DIARY_MINUTE", 30))),
  naturalDiaryCatchupDays: Math.max(1, Math.min(14, int("COMPANION_NATURAL_DIARY_CATCHUP_DAYS", 7))),
  naturalDiaryMaxRetries: Math.max(1, Math.min(12, int("COMPANION_NATURAL_DIARY_MAX_RETRIES", 6))),
  naturalDiaryTickMs: Math.max(5000, Math.min(300000, int("COMPANION_NATURAL_DIARY_TICK_MS", 30000))),
  naturalRepairEnabled: bool("COMPANION_NATURAL_REPAIR_ENABLED", true),
  replyLatencyEnabled: bool("COMPANION_REPLY_LATENCY_ENABLED", true),
  replyLatencyCapMs: Math.max(1000, Math.min(20000, int("COMPANION_REPLY_LATENCY_CAP_MS", 9000))),
  replyLatencyFloorMs: Math.max(0, Math.min(1000, int("COMPANION_REPLY_LATENCY_FLOOR_MS", 80))),
  closureSensingEnabled: bool("COMPANION_CLOSURE_SENSING_ENABLED", true),
  silenceReturnStanceEnabled: bool("COMPANION_SILENCE_RETURN_STANCE_ENABLED", true),
  // Candidate-only fixture: force Natural Messaging bubbles for realtime UI tests.
  testForcedBubbles: (()=>{
    try{
      const raw=String(env("COMPANION_TEST_FORCED_BUBBLES","")||"").trim();
      if(!raw)return null;
      const list=JSON.parse(raw);
      if(!Array.isArray(list)||!list.length)return null;
      return list.map(x=>String(x??"").trim()).filter(Boolean).slice(0,3);
    }catch{return null;}
  })(),
  memoryAccessibilityEnabled: bool("COMPANION_MEMORY_ACCESSIBILITY_ENABLED", true),
  memoryAccessibilityMinScore: Math.max(0, Math.min(1, Number(env("COMPANION_MEMORY_ACCESSIBILITY_MIN", "0.28")))),
  memoryAccessibilityMaxInject: Math.max(0, Math.min(12, int("COMPANION_MEMORY_ACCESSIBILITY_MAX", 4))),
  moduleExecutionLedgerPath: path.resolve(env("COMPANION_MODULE_EXECUTION_LEDGER_PATH", "./data/module-execution-ledger.json")),
  schedulerStatePath: path.resolve(env("COMPANION_SCHEDULER_STATE_PATH", path.join(durableDataDir,"scheduler.json"))),
  temporalContextPath: path.resolve(env("COMPANION_TEMPORAL_CONTEXT_PATH", path.join(durableDataDir,"temporal-context.json"))),
  schedulerTickMs: Math.max(250, Math.min(60000, int("COMPANION_SCHEDULER_TICK_MS", 1000))),
  invocationLedgerPath: path.resolve(env("COMPANION_INVOCATION_LEDGER_PATH", path.join(durableDataDir,"invocations.jsonl"))),
  invocationSummaryPath: path.resolve(env("COMPANION_INVOCATION_SUMMARY_PATH", path.join(durableDataDir,"invocations-summary.json"))),
  pricingRevisionsPath: path.resolve(env("COMPANION_PRICING_REVISIONS_PATH", path.join(durableDataDir,"pricing-revisions.json"))),
  guidanceQueuePath: path.resolve(env("COMPANION_GUIDANCE_QUEUE_PATH", path.join(durableDataDir,"guidance-queue.json"))),
  sessionPermissionsPath: path.resolve(env("COMPANION_SESSION_PERMISSIONS_PATH", path.join(durableDataDir,"session-permissions.json"))),
  sessionPermissionGrantTtlMs: Math.max(60000,Math.min(7*24*60*60*1000,int("COMPANION_SESSION_PERMISSION_GRANT_TTL_MS",8*60*60*1000))),
  sessionPermissionPendingTtlMs: Math.max(30000,Math.min(60*60*1000,int("COMPANION_SESSION_PERMISSION_PENDING_TTL_MS",15*60*1000))),
  moduleExecutionLedgerTtlMs: int("MODULE_EXECUTION_LEDGER_TTL_MS", 600000),
  moduleExecutionLedgerMaxEntries: int("MODULE_EXECUTION_LEDGER_MAX_ENTRIES", 4096),
  moduleExecutionLedgerResultStoreChars: Math.max(128, int("MODULE_EXECUTION_LEDGER_RESULT_STORE_CHARS", 2048)),

  chatMemoryLimit: int("CHAT_MEMORY_LIMIT", 6),
  agentMemoryLimit: int("AGENT_MEMORY_LIMIT", 3),
  summaryEveryMessages: int("SUMMARY_EVERY_MESSAGES", 40),
  summaryMaxMessages: int("SUMMARY_MAX_MESSAGES", 120),
  summaryMaxChars: int("SUMMARY_MAX_CHARS", 5000),
  summaryRetryCooldownSeconds: int("SUMMARY_RETRY_COOLDOWN_SECONDS", 300),
  autoPromoteMemory: bool("AUTO_PROMOTE_MEMORY", true),
  autoPromoteMinImportance: Number(env("AUTO_PROMOTE_MIN_IMPORTANCE", "0.55")),
  memoryImmediateEnabled: bool("MEMORY_IMMEDIATE_ENABLED", true),
  memoryGateEnabled: bool("MEMORY_GATE_ENABLED", true),
  memoryImmediateCooldownSeconds: int("MEMORY_IMMEDIATE_COOLDOWN_SECONDS", 45),
  memoryReviewEveryUserTurns: int("MEMORY_REVIEW_EVERY_USER_TURNS", 12),
  memoryReviewMaxMessages: int("MEMORY_REVIEW_MAX_MESSAGES", 40),
  memoryCandidateLimit: int("MEMORY_CANDIDATE_LIMIT", 4),

  embeddingEnabled: bool("EMBEDDING_ENABLED", false),
  ollamaBaseUrl: env("OLLAMA_BASE_URL", "http://127.0.0.1:11434").replace(/\/+$/, ""),
  ollamaEmbedModel: env("OLLAMA_EMBED_MODEL", "bge-m3"),
  embeddingCandidateLimit: int("EMBEDDING_CANDIDATE_LIMIT", 1000),
  embeddingTimeoutMs: int("EMBEDDING_TIMEOUT_MS", 5000),
  embeddingProbeIntervalMs: int("EMBEDDING_PROBE_INTERVAL_MS", 60000),

  searchProvider: ["auto","native","tavily","searxng","none"].includes(env("SEARCH_PROVIDER", "auto"))?env("SEARCH_PROVIDER", "auto"):"auto",
  tavilyApiKey: env("TAVILY_API_KEY", ""),
  tavilyBaseUrl: env("TAVILY_BASE_URL", "https://api.tavily.com").replace(/\/+$/, ""),
  searxngBaseUrl: env("SEARXNG_BASE_URL", "").replace(/\/+$/, ""),
  searchConfigPath: path.resolve(env("COMPANION_SEARCH_CONFIG_PATH", "./data/search-provider.json")),
  webSearchMaxResults: Math.max(1, Math.min(8, int("WEB_SEARCH_MAX_RESULTS", 6))),
  webSearchTimeoutMs: Math.max(2000, Math.min(30000, int("SEARCH_TIMEOUT_MS", 12000))),
  searchSnippetMaxChars: Math.max(80, Math.min(1000, int("SEARCH_SNIPPET_MAX_CHARS", 320))),
  webSearchToolMaxRounds: Math.max(1, Math.min(4, int("WEB_SEARCH_TOOL_MAX_ROUNDS", 2))),

  mcpHttpEnabled: bool("COMPANION_MCP_HTTP_ENABLED", true),
  mcpToken: env("COMPANION_MCP_TOKEN", ""),
  mcpConnectTimeoutMs: Math.max(3000, Math.min(120000, int("MCP_CONNECT_TIMEOUT_MS", 15000))),
  mcpToolTimeoutMs: Math.max(2000, Math.min(300000, int("MCP_TOOL_TIMEOUT_MS", 30000))),
  mcpToolResultMaxChars: Math.max(1024, Math.min(200000, int("MCP_TOOL_RESULT_MAX_CHARS", 32768))),
  mcpReconnectAttempts: Math.max(0, Math.min(10, int("MCP_RECONNECT_ATTEMPTS", 3))),
  mcpMaxToolsPerIntegration: Math.max(1, Math.min(512, int("MCP_MAX_TOOLS_PER_INTEGRATION", 128))),
  integrationsConfigPath: path.resolve(env("COMPANION_INTEGRATIONS_CONFIG_PATH", path.join(durableDataDir,"integrations.json"))),
  integrationsSecretsPath: path.resolve(env("COMPANION_INTEGRATIONS_SECRETS_PATH", path.join(durableDataDir,"integrations-secrets.json"))),

  capabilitiesDir: path.resolve(env("COMPANION_CAPABILITIES_DIR", path.join(durableDataDir,"capabilities"))),
  capabilityInstallerStatePath: path.resolve(env("COMPANION_CAPABILITY_INSTALLER_STATE_PATH", path.join(durableDataDir,"capability-installer.json"))),
  selfMaintenanceDir: path.resolve(env("COMPANION_SELF_MAINTENANCE_DIR", path.join(durableDataDir,"self-maintenance"))),
  localRuntimeControlsPath: path.resolve(env("COMPANION_LOCAL_RUNTIME_CONTROLS_PATH", path.join(durableDataDir,"local-runtime-controls.json"))),
  packageOperationsPath: path.resolve(env("COMPANION_PACKAGE_OPERATIONS_PATH", path.join(durableDataDir,"package-operations.json"))),
  voiceDir: path.resolve(env("COMPANION_VOICE_DIR", path.join(durableDataDir,"voice"))),
  voiceRuntimeRoot: path.resolve(env("COMPANION_VOICE_RUNTIME_ROOT", path.join(localHome, "GPT-SoVITS"))),
  voicePythonPath: path.resolve(env("COMPANION_VOICE_PYTHON", path.join(localHome, "GPT-SoVITS", ".venv", "bin", "python"))),
  voiceApiScriptPath: path.resolve(env("COMPANION_VOICE_API_SCRIPT", path.join(localHome, "GPT-SoVITS", "api_v2.py"))),
  voiceGptWeightsPath: path.resolve(env("COMPANION_VOICE_GPT_WEIGHTS", path.join(localHome, "CompanionVoice", "gpt.ckpt"))),
  voiceSoVitsWeightsPath: path.resolve(env("COMPANION_VOICE_SOVITS_WEIGHTS", path.join(localHome, "CompanionVoice", "sovits.pth"))),
  voiceReferenceAudioPath: path.resolve(env("COMPANION_VOICE_REFERENCE_AUDIO", path.join(localHome, "CompanionVoice", "reference.wav"))),
  voicePromptText: env("COMPANION_VOICE_PROMPT_TEXT", "我没有说你的意思。"),
  voiceIntimateReferenceAudioPath: path.resolve(env("COMPANION_VOICE_INTIMATE_REFERENCE_AUDIO", path.join(localHome, "CompanionVoice", "intimate-reference.wav"))),
  voiceIntimatePromptText: env("COMPANION_VOICE_INTIMATE_PROMPT_TEXT", "我希望你时时刻刻都能够开心。"),
  voiceProfilesDir: path.resolve(env("COMPANION_VOICE_PROFILES_DIR", path.join(localHome, "CompanionVoice", "profiles"))),
  conversationGroundingEnabled: bool("COMPANION_CONVERSATION_GROUNDING_ENABLED", true),
  chatVoiceMessageEnabled: bool("COMPANION_CHAT_VOICE_MESSAGE_ENABLED", true),
  modalityPlannerEnabled: bool("COMPANION_MODALITY_PLANNER_ENABLED", true),
  modalityVoiceBias: Math.max(0, Math.min(1, Number(env("COMPANION_MODALITY_VOICE_BIAS", "0.22")))),
  voiceHost: "127.0.0.1",
  voicePort: 9880,
  voiceStartupTimeoutMs: Math.max(30000,Math.min(10*60*1000,int("COMPANION_VOICE_STARTUP_TIMEOUT_MS",5*60*1000))),
  voiceRequestTimeoutMs: Math.max(5000,Math.min(10*60*1000,int("COMPANION_VOICE_REQUEST_TIMEOUT_MS",3*60*1000))),
  voiceCacheMaxBytes: Math.max(8*1024*1024,Math.min(1024*1024*1024,int("COMPANION_VOICE_CACHE_MAX_BYTES",256*1024*1024))),
  voiceCacheMaxAgeMs: Math.max(60*1000,Math.min(30*24*60*60*1000,int("COMPANION_VOICE_CACHE_MAX_AGE_MS",7*24*60*60*1000))),
  voiceIdleStopMs: Math.max(0,Math.min(24*60*60*1000,int("COMPANION_VOICE_IDLE_STOP_MS",10*60*1000))),
  senseVoiceLabRoot: path.resolve(env("COMPANION_SENSEVOICE_LAB_ROOT", path.join(localHome, "CompanionVoiceLab", "sensevoice"))),
  senseVoicePythonPath: path.resolve(env("COMPANION_SENSEVOICE_PYTHON", path.join(localHome, "CompanionVoiceLab", "sensevoice", ".venv", "bin", "python"))),
  senseVoiceModelPath: path.resolve(env("COMPANION_SENSEVOICE_MODEL", path.join(localHome, "CompanionVoiceLab", "sensevoice", "model"))),
  senseVoiceWorkerPath: path.resolve(env("COMPANION_SENSEVOICE_WORKER", "./scripts/sensevoice-worker.py")),
  senseVoiceStartupTimeoutMs: Math.max(1000,Math.min(10*60*1000,int("COMPANION_SENSEVOICE_STARTUP_TIMEOUT_MS",2*60*1000))),
  senseVoiceRequestTimeoutMs: Math.max(3000,Math.min(60*1000,int("COMPANION_SENSEVOICE_REQUEST_TIMEOUT_MS",20*1000))),
  senseVoiceIdleStopMs: Math.max(0,Math.min(24*60*60*1000,int("COMPANION_SENSEVOICE_IDLE_STOP_MS",30*60*1000))),
  senseVoiceMaxAudioBytes: Math.max(64*1024,Math.min(32*1024*1024,int("COMPANION_SENSEVOICE_MAX_AUDIO_BYTES",8*1024*1024))),
  wakeWordLabRoot: path.resolve(env("COMPANION_WAKE_WORD_LAB_ROOT", path.join(localHome, "CompanionVoiceLab", "wakeword"))),
  wakeWordPythonPath: path.resolve(env("COMPANION_WAKE_WORD_PYTHON", path.join(localHome, "CompanionVoiceLab", "wakeword", ".venv", "bin", "python"))),
  wakeWordModelDir: path.resolve(env("COMPANION_WAKE_WORD_MODEL", path.join(localHome, "CompanionVoiceLab", "wakeword", "model"))),
  wakeWordWorkerPath: path.resolve(env("COMPANION_WAKE_WORD_WORKER", "./scripts/wake-word-worker.py")),
  wakeWordStartupTimeoutMs: Math.max(1000,Math.min(2*60*1000,int("COMPANION_WAKE_WORD_STARTUP_TIMEOUT_MS",15000))),
  wakeWordIngestTimeoutMs: Math.max(100,Math.min(5000,int("COMPANION_WAKE_WORD_INGEST_TIMEOUT_MS",800))),
  capabilityInstallTimeoutMs: Math.max(30000,Math.min(30*60*1000,int("COMPANION_CAPABILITY_INSTALL_TIMEOUT_MS",10*60*1000))),
  computerUseActionTimeoutMs: Math.max(1000,Math.min(120000,int("COMPANION_COMPUTER_USE_ACTION_TIMEOUT_MS",30000))),

  debugEnabled: bool("COMPANION_DEBUG", false),
  debugLogPath: env("COMPANION_DEBUG_LOG", "/private/tmp/companion-debug.log")
};
