import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { config } from "../config.js";
import { makeCapability, capabilitiesForAgent, capabilitiesForChat, applyIntegrationPolicy, capabilityToCompatTool } from "../capability-registry.js";
import { moduleRegistry } from "../modules/registry.js";
import { safeErrorMessage, redactSecrets } from "../runtime.js";
import { IntegrationOAuthProvider, oauthSecretValues } from "./oauth.js";

// McpRegistry：外部 MCP Server 连接（integration）生命周期、工具发现、统一能力输出、
// 受控执行。配置明文存 data/integrations.json；secret（env 值 / bearer token）
// 单独存 data/integrations-secrets.json（0600），绝不进入 Admin API 响应与日志。

const INTEGRATION_TYPES = new Set(["stdio", "http"]);

function stdioPath() {
  const inherited = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const preferred = [path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set([...preferred, ...inherited])].join(path.delimiter);
}

function loadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function writeJsonSecure(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function normalizeName(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "ext";
}

class McpRegistry {
  constructor() {
    this.integrations = new Map(); // id → {config, status, lastError, lastConnectedAt, connection:{client,transport}, capabilities:[], reconnectTimer, reconnectAttempts}
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    const store = loadJson(config.integrationsConfigPath) ?? { version: 1, integrations: [] };
    for (const item of store.integrations ?? []) {
      if (!item?.id || !INTEGRATION_TYPES.has(item.type)) continue;
      this.integrations.set(item.id, {
        config: { ...item, enabled: item.enabled === true },
        status: "disconnected",
        lastError: item.lastError ?? null,
        lastConnectedAt: null,
        connection: null,
        capabilities: [],
        reconnectTimer: null,
        reconnectAttempts: 0
      });
    }
  }

  persist() {
    const store = {
      version: 1,
      integrations: [...this.integrations.values()].map(e => ({
        id: e.config.id, name: e.config.name, type: e.config.type, enabled: e.config.enabled,
        availableToAgent: e.config.availableToAgent !== false,
        availableToChat: e.config.availableToChat === true,
        command: e.config.command ?? null, args: e.config.args ?? [], envKeys: e.config.envKeys ?? [],
        url: e.config.url ?? null, hasAuth: e.config.hasAuth === true,
        authType: e.config.authType ?? (e.config.hasAuth ? "bearer" : "none"),
        oauthClientId: e.config.oauthClientId ?? null,
        toolPolicy: e.config.toolPolicy ?? {}, createdAt: e.config.createdAt
      }))
    };
    fs.mkdirSync(path.dirname(config.integrationsConfigPath), { recursive: true });
    fs.writeFileSync(config.integrationsConfigPath, JSON.stringify(store, null, 2));
  }

  loadSecrets() { return loadJson(config.integrationsSecretsPath) ?? { version: 1, env: {}, auth: {}, oauth: {} }; }
  saveSecrets(secrets) { writeJsonSecure(config.integrationsSecretsPath, secrets); }

  loadOAuth(id) { return this.loadSecrets().oauth?.[id] ?? {}; }
  saveOAuth(id, value) {
    const secrets = this.loadSecrets();
    secrets.oauth ??= {};
    secrets.oauth[id] = value;
    this.saveSecrets(secrets);
  }

  oauthProvider(entry) {
    if (!entry.oauthProvider) {
      const redirectUrl = `http://127.0.0.1:${config.port}/mcp/oauth/callback`;
      entry.oauthProvider = new IntegrationOAuthProvider({
        integrationId: entry.config.id, redirectUrl,
        configuredClientId: entry.config.oauthClientId,
        load: () => this.loadOAuth(entry.config.id),
        save: value => this.saveOAuth(entry.config.id, value)
      });
    }
    return entry.oauthProvider;
  }

  secretValues(id) {
    const secrets = this.loadSecrets();
    return [...Object.values(secrets.env?.[id] ?? {}), secrets.auth?.[id], ...oauthSecretValues(secrets.oauth?.[id])]
      .filter(value => typeof value === "string" && value.length >= 4);
  }

  redactIntegrationSecrets(id, value, max = 1000) {
    let text = redactSecrets(String(value ?? ""), max * 2);
    for (const secret of this.secretValues(id)) text = text.split(secret).join("[REDACTED]");
    return text.slice(0, max);
  }

  // ---- 管理 ----

  addIntegration({ name, type, command = null, args = [], env = null, url = null, auth = null, authType = null, oauthClientId = null, availableToAgent = true, availableToChat = false }) {
    this.load();
    if (!INTEGRATION_TYPES.has(type)) throw Object.assign(new Error("type 必须是 stdio 或 http"), { statusCode: 400 });
    if (type === "stdio" && (!command || typeof command !== "string")) throw Object.assign(new Error("stdio 集成需要 command"), { statusCode: 400 });
    if (type === "http") {
      try { const u = new URL(String(url)); if (!["http:", "https:"].includes(u.protocol)) throw new Error("bad protocol"); }
      catch { throw Object.assign(new Error("http 集成需要合法 http(s) url"), { statusCode: 400 }); }
    }
    const id = `${normalizeName(name || type)}_${crypto.randomBytes(2).toString("hex")}`;
    const entry = {
      config: {
        id, name: String(name ?? id).slice(0, 80), type, enabled: true,
        availableToAgent: availableToAgent !== false, availableToChat: availableToChat === true,
        command: type === "stdio" ? String(command) : null,
        args: Array.isArray(args) ? args.map(String).slice(0, 64) : [],
        envKeys: env && typeof env === "object" ? Object.keys(env).map(String).slice(0, 32) : [],
        url: type === "http" ? String(url).replace(/\/+$/, "") : null,
        hasAuth: Boolean(auth),
        authType: type === "http" ? (authType === "oauth" ? "oauth" : (auth ? "bearer" : "none")) : "none",
        oauthClientId: type === "http" && oauthClientId ? String(oauthClientId).slice(0, 500) : null,
        toolPolicy: {},
        createdAt: new Date().toISOString()
      },
      status: "disconnected", lastError: null, lastConnectedAt: null, connection: null, capabilities: [], reconnectTimer: null, reconnectAttempts: 0
    };
    if (env && typeof env === "object" && Object.keys(env).length) {
      const secrets = this.loadSecrets();
      secrets.env[id] = Object.fromEntries(Object.entries(env).map(([k, v]) => [String(k).slice(0, 128), String(v)]));
      this.saveSecrets(secrets);
    }
    if (auth) {
      const secrets = this.loadSecrets();
      secrets.auth[id] = String(auth).slice(0, 2048);
      this.saveSecrets(secrets);
    }
    this.integrations.set(id, entry);
    this.persist();
    return this.describeIntegration(entry);
  }

  async updateIntegration(id, patch) {
    this.load();
    const entry = this.integrations.get(id);
    if (!entry) return null;
    const wasEnabled = entry.config.enabled;
    if (patch.enabled !== undefined) entry.config.enabled = Boolean(patch.enabled);
    if (patch.availableToAgent !== undefined) entry.config.availableToAgent = Boolean(patch.availableToAgent);
    if (patch.availableToChat !== undefined) entry.config.availableToChat = Boolean(patch.availableToChat);
    if (patch.name !== undefined && String(patch.name).trim()) entry.config.name = String(patch.name).trim().slice(0, 80);
    if (patch.toolPolicy && typeof patch.toolPolicy === "object") {
      const next = {};
      for (const [capId, value] of Object.entries(patch.toolPolicy).slice(0, 512)) next[capId] = value === "deny" ? "deny" : "allow";
      entry.config.toolPolicy = next;
    }
    this.persist();
    this.refreshCapabilities();
    if (wasEnabled && !entry.config.enabled) await this.disconnectIntegration(id);
    if (!wasEnabled && entry.config.enabled) await this.connectIntegration(id);
    return this.describeIntegration(entry);
  }

  async removeIntegration(id) {
    this.load();
    const entry = this.integrations.get(id);
    if (!entry) return false;
    await this.disconnectIntegration(id);
    this.integrations.delete(id);
    const secrets = this.loadSecrets();
    delete secrets.env[id]; delete secrets.auth[id]; if (secrets.oauth) delete secrets.oauth[id];
    this.saveSecrets(secrets);
    this.persist();
    return true;
  }

  describeIntegration(entry) {
    return {
      id: entry.config.id,
      name: entry.config.name,
      type: entry.config.type,
      enabled: entry.config.enabled,
      availableToAgent: entry.config.availableToAgent !== false,
      availableToChat: entry.config.availableToChat === true,
      command: entry.config.command,
      args: entry.config.args,
      envKeys: entry.config.envKeys,
      url: entry.config.url,
      hasAuth: entry.config.hasAuth,
      authType: entry.config.authType ?? (entry.config.hasAuth ? "bearer" : "none"),
      oauthStatus: entry.config.authType === "oauth" ? (entry.status === "connected" ? "authorized" : (this.oauthProvider(entry).hasTokens() ? "authorized" : "authorization_required")) : "not_applicable",
      status: entry.config.enabled ? entry.status : "disabled",
      lastConnectedAt: entry.lastConnectedAt,
      lastError: entry.lastError ? this.redactIntegrationSecrets(entry.config.id, entry.lastError, 300) : null,
      toolsCount: entry.capabilities.length
    };
  }

  listIntegrations() {
    this.load();
    return [...this.integrations.values()].map(e => this.describeIntegration(e));
  }

  listTools(integrationId) {
    this.load();
    const entry = this.integrations.get(integrationId);
    if (!entry) return null;
    return entry.capabilities.map(cap => ({
      id: cap.id, wireName: cap.name, displayName: cap.displayName,
      description: cap.description, inputSchema: cap.inputSchema,
      riskLevel: cap.riskLevel, permissions: cap.permissions, sideEffect: cap.sideEffect,
      denied: entry.config.toolPolicy?.[cap.id] === "deny"
    }));
  }

  presentationMetadataForWireName(wireName) {
    this.load();
    const found = this.findCapabilityByWireName(wireName);
    if (found) return {
        sourceType: "mcp",
        sourceId: found.entry.config.id,
        integrationName: found.entry.config.name,
        displayName: found.cap.displayName
      };
    // History can load before an enabled integration has completed discovery.
    // MCP wire names are stable and contain the integration id, so recover the
    // configured friendly name without requiring a live connection.
    const wire = String(wireName ?? "");
    const entry = [...this.integrations.values()]
      .sort((a, b) => b.config.id.length - a.config.id.length)
      .find(candidate => wire.startsWith(`mcp_${candidate.config.id}_`));
    if (!entry) return null;
    const displayName = wire.slice(`mcp_${entry.config.id}_`.length) || "tool";
    return {
      sourceType: "mcp",
      sourceId: entry.config.id,
      integrationName: entry.config.name,
      displayName
    };
  }

  // ---- 连接生命周期 ----

  buildTransport(entryConfig) {
    if (entryConfig.type === "stdio") {
      const secrets = this.loadSecrets();
      const env = {};
      for (const key of entryConfig.envKeys ?? []) {
        const value = secrets.env?.[entryConfig.id]?.[key];
        if (value !== undefined) env[key] = value;
      }
      // Finder 启动的 Companion Core 使用受限 PATH；把当前 Node 所在目录及
      // macOS 常见包管理器目录补回去，使普通 `node` / `npx` MCP 配置可移植。
      // 只继承 PATH，不把 Core 的 provider/API secret 扩散给 MCP 子进程。
      env.PATH = stdioPath();
      return new StdioClientTransport({ command: entryConfig.command, args: entryConfig.args ?? [], env, stderr: "pipe" });
    }
    if (entryConfig.authType === "oauth") {
      const entry = this.integrations.get(entryConfig.id);
      return new StreamableHTTPClientTransport(new URL(entryConfig.url), { authProvider: this.oauthProvider(entry) });
    }
    const headers = {};
    if (entryConfig.hasAuth) {
      const token = this.loadSecrets().auth?.[entryConfig.id];
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    return new StreamableHTTPClientTransport(new URL(entryConfig.url), { requestInit: { headers } });
  }

  async connectIntegration(id, { discover = true } = {}) {
    this.load();
    const entry = this.integrations.get(id);
    if (!entry) return null;
    if (entry.connection) {
      if (entry.status === "connecting") {
        const deadline = Date.now() + config.mcpConnectTimeoutMs;
        while (entry.connection && entry.status === "connecting" && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      return this.describeIntegration(entry);
    }
    if (!entry.config.enabled) { entry.status = "disabled"; return this.describeIntegration(entry); }
    const client = new Client({ name: "companion-core", version: config.version }, { capabilities: {} });
    const transport = this.buildTransport(entry.config);
    entry.connection = { client, transport };
    entry.status = "connecting";
    try {
      await client.connect(transport, { timeout: config.mcpConnectTimeoutMs });
      entry.status = "connected";
      entry.lastError = null;
      entry.lastConnectedAt = new Date().toISOString();
      entry.reconnectAttempts = 0;
      transport.onclose = () => {
        if (entry.connection?.transport !== transport) return;
        entry.connection = null;
        entry.status = "disconnected";
        this.refreshCapabilities();
        this.scheduleReconnect(id);
      };
      transport.onerror = error => {
        entry.lastError = safeErrorMessage(error);
      };
      if (discover) await this.discoverTools(entry);
    } catch (error) {
      entry.connection = null;
      const oauthRequired = entry.config.authType === "oauth" && error instanceof UnauthorizedError;
      entry.status = oauthRequired ? "authorization_required" : "error";
      entry.lastError = oauthRequired ? null : safeErrorMessage(error);
      try { await transport.close(); } catch {}
      if (!oauthRequired) this.scheduleReconnect(id);
    }
    this.refreshCapabilities();
    return this.describeIntegration(entry);
  }

  scheduleReconnect(id) {
    const entry = this.integrations.get(id);
    if (!entry || !entry.config.enabled || entry.connection) return;
    if (entry.reconnectAttempts >= config.mcpReconnectAttempts) { entry.status = "error"; return; }
    entry.reconnectAttempts += 1;
    const delay = Math.min(8000, 1000 * 2 ** (entry.reconnectAttempts - 1));
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      if (entry.config.enabled && !entry.connection) this.connectIntegration(id).catch(() => {});
    }, delay);
  }

  async disconnectIntegration(id) {
    this.load();
    const entry = this.integrations.get(id);
    if (!entry) return;
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
    entry.reconnectAttempts = 0;
    const connection = entry.connection;
    entry.connection = null;
    entry.status = "disconnected";
    if (connection) { try { await connection.client.close(); } catch {} }
    this.refreshCapabilities();
  }

  async testIntegration(id) {
    this.load();
    const entry = this.integrations.get(id);
    if (!entry) return null;
    const wasConnected = Boolean(entry.connection);
    if (!wasConnected) await this.connectIntegration(id, { discover: true });
    const result = {
      id,
      ok: entry.status === "connected",
      status: entry.status,
      toolsCount: entry.capabilities.length,
      error: entry.lastError ? this.redactIntegrationSecrets(id, entry.lastError, 300) : null
    };
    if (!wasConnected && result.ok) await this.disconnectIntegration(id);
    return result;
  }

  async startOAuth(id) {
    this.load();
    const entry = this.integrations.get(id);
    if (!entry) return null;
    if (entry.config.type !== "http" || entry.config.authType !== "oauth") throw Object.assign(new Error("integration does not use OAuth"), { statusCode: 400 });
    await this.disconnectIntegration(id);
    const provider = this.oauthProvider(entry);
    provider.authorizationUrl = null;
    await this.connectIntegration(id);
    return {
      id, ok: entry.status === "connected", status: entry.status,
      authorizationUrl: provider.authorizationUrl,
      toolsCount: entry.capabilities.length,
      error: entry.lastError ? this.redactIntegrationSecrets(id, entry.lastError, 300) : null
    };
  }

  async completeOAuth({ code, state, error = null }) {
    this.load();
    const entry = [...this.integrations.values()].find(candidate => {
      if (candidate.config.authType !== "oauth") return false;
      const expected = this.oauthProvider(candidate).callbackState();
      if (!expected || !state || expected.length !== state.length) return false;
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(state));
    });
    if (!entry) throw Object.assign(new Error("OAuth callback state is invalid or expired"), { statusCode: 400 });
    const provider = this.oauthProvider(entry);
    if (error) {
      provider.clearPending();
      entry.status = "error";
      entry.lastError = "OAuth authorization was declined";
      return { ok: false, id: entry.config.id };
    }
    if (!code) throw Object.assign(new Error("OAuth authorization code is missing"), { statusCode: 400 });
    await auth(provider, { serverUrl: entry.config.url, authorizationCode: code });
    provider.clearPending();
    await this.connectIntegration(entry.config.id);
    return { ok: entry.status === "connected", id: entry.config.id, toolsCount: entry.capabilities.length };
  }

  async connectEnabledIntegrations() {
    this.load();
    const enabled = [...this.integrations.values()].filter(entry => entry.config.enabled).map(entry => entry.config.id);
    await Promise.allSettled(enabled.map(id => this.connectIntegration(id)));
  }

  // ---- 发现与能力 ----

  async discoverTools(entry) {
    const client = entry.connection?.client;
    if (!client) throw new Error("integration not connected");
    const { tools } = await client.listTools();
    const taken = new Set(moduleRegistry.enabledModuleTools().map(t => t.name));
    const capabilities = [];
    for (const tool of (Array.isArray(tools) ? tools : []).slice(0, config.mcpMaxToolsPerIntegration)) {
      if (!tool?.name || typeof tool.name !== "string") continue;
      try {
        const annotations = tool.annotations && typeof tool.annotations === "object" ? tool.annotations : {};
        const declaredReadOnly = annotations.readOnlyHint === true;
        // MCP annotations are server-declared hints, not a permission bypass. A tool
        // explicitly declared non-read-only is conservatively high-risk so execution
        // still requires a matching Action Intent (form submit, page write, device control).
        const annotationRisk = annotations.destructiveHint === true || annotations.readOnlyHint === false ? "high"
          : declaredReadOnly ? "low" : null;
        const annotationPermissions = annotations.readOnlyHint === false
          ? ["write", "external_action", ...(annotations.openWorldHint === true ? ["network"] : [])]
          : declaredReadOnly ? ["read", ...(annotations.openWorldHint === true ? ["network"] : [])] : null;
        capabilities.push(makeCapability({
          sourceType: "mcp",
          sourceId: entry.config.id,
          toolName: tool.name,
          displayName: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? null,
          riskLevel: annotationRisk,
          permissions: annotationPermissions,
          sideEffect: declaredReadOnly ? "none" : (annotations.idempotentHint === true ? "idempotent" : null),
          requiresNetwork: annotations.openWorldHint === true ? true : null
        }, taken));
      } catch {}
    }
    entry.capabilities = capabilities;
  }

  refreshCapabilities() {
    // wire name 需要跨集成稳定：按 id 排序后统一分配，避免漂移。
    const taken = new Set(moduleRegistry.enabledModuleTools().map(t => t.name));
    for (const entry of [...this.integrations.values()].sort((a, b) => a.config.id.localeCompare(b.config.id))) {
      const old = new Map(entry.capabilities.map(cap => [cap.id, cap.name]));
      const takenForEntry = new Set(taken);
      for (const cap of entry.capabilities) {
        const previous = old.get(cap.id);
        if (previous && !taken.has(previous)) { cap.name = previous; taken.add(previous); }
        else {
          const renamed = makeCapability({ ...cap, sourceType: "mcp", sourceId: entry.config.id }, takenForEntry);
          cap.name = renamed.name;
          taken.add(cap.name);
        }
      }
    }
  }

  allCapabilities() {
    this.load();
    const out = [];
    for (const entry of this.integrations.values()) out.push(...entry.capabilities);
    return out;
  }

  integrationPolicies() {
    return new Map([...this.integrations.values()].map(entry => [entry.config.id, entry.config]));
  }

  agentCapabilities() {
    return capabilitiesForAgent(this.allCapabilities(), { integrations: this.integrationPolicies() });
  }

  chatCapabilities() {
    return capabilitiesForChat(this.allCapabilities(), { integrations: this.integrationPolicies() });
  }

  agentCompatTools() {
    return this.agentCapabilities().map(capabilityToCompatTool);
  }

  chatCompatTools() {
    return this.chatCapabilities().map(capabilityToCompatTool);
  }

  // ---- 执行 ----

  findCapabilityByWireName(wireName) {
    for (const entry of this.integrations.values())
      for (const cap of entry.capabilities)
        if (cap.name === wireName) return { entry, cap };
    return null;
  }

  async executeByWireName(wireName, args, { authorizedHighRisk = false } = {}) {
    const found = this.findCapabilityByWireName(wireName);
    if (!found) { const e = new Error(`MCP tool not found: ${wireName}`); e.code = "MCP_TOOL_NOT_FOUND"; throw e; }
    const { entry, cap } = found;
    if (!entry.config.enabled) { const e = new Error(`integration ${entry.config.id} is disabled`); e.code = "MCP_INTEGRATION_DISABLED"; throw e; }
    if (entry.config.toolPolicy?.[cap.id] === "deny") { const e = new Error(`tool ${cap.id} is denied by policy`); e.code = "MCP_TOOL_DENIED"; throw e; }
    if (cap.riskLevel === "high" && !authorizedHighRisk) { const e = new Error(`high-risk MCP tool ${cap.id} requires an explicit matching action intent`); e.code = "MCP_CONFIRMATION_REQUIRED"; throw e; }
    if (!entry.connection) {
      await this.connectIntegration(entry.config.id, { discover: false });
      if (!entry.connection) { const e = new Error(`integration ${entry.config.id} is not connected`); e.code = "MCP_NOT_CONNECTED"; throw e; }
    }
    try {
      const timeout = AbortSignal.timeout(config.mcpToolTimeoutMs);
      const result = await entry.connection.client.callTool({ name: cap.displayName, arguments: typeof args === "object" && args ? args : {} }, undefined, { signal: timeout });
      const text = normalizeToolResult(result, { secrets: this.secretValues(entry.config.id) });
      return { ok: !result?.isError, text, riskLevel: cap.riskLevel };
    } catch (error) {
      const message = this.redactIntegrationSecrets(entry.config.id, safeErrorMessage(error));
      return { ok: false, text: `[mcp tool error] ${message}`, riskLevel: cap.riskLevel };
    }
  }
}

export function normalizeToolResult(result, { maxChars = config.mcpToolResultMaxChars, secrets = [] } = {}) {
  let text = "";
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const part of content.slice(0, 64)) {
    if (part?.type === "text" && typeof part.text === "string") text += `${text ? "\n" : ""}${part.text}`;
    else if (part?.type === "resource") text += `${text ? "\n" : ""}[resource: ${String(part?.uri ?? "").slice(0, 200)}]`;
    else if (part?.type === "image") text += `${text ? "\n" : ""}[image output omitted]`;
  }
  if (result?.isError) text = `[mcp tool error] ${text || "tool reported an error"}`;
  text = redactSecrets(text, maxChars * 2);
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[mcp tool output truncated at ${maxChars} chars]`;
  return text;
}

export const mcpRegistry = new McpRegistry();
