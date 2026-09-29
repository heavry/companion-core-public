import { config } from "../config.js";
import { retrieveMemoriesDetailed, addStagingMemory } from "../memory.js";
import { addPendingFollowup, getState, expirePendingFollowups } from "../companion-state.js";
import { moduleRegistry } from "../modules/registry.js";
import { executeWebSearchTool, searchStatus } from "../search/index.js";
import { ensureDefaultPersona } from "../persona.js";
import { safeErrorMessage, redactSecrets } from "../runtime.js";

// Companion 对外暴露的 MCP Server 工具（第一批，全部为安全、明确的能力）。
// 明确不暴露：raw database、session dump、API keys、.env、provider credentials、
// module ledger、文件系统、shell、进程控制、admin secret、Persona system prompt 原文。

function personaId() { return config.defaultPersonaId; }

export const COMPANION_MCP_TOOLS = [
  {
    name: "companion.memory.search",
    title: "Memory Search",
    description: "在 Companion 的长期记忆中语义检索相关记忆片段。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词或问题" },
        limit: { type: "integer", description: "返回条数 1-10，默认 5" }
      },
      required: ["query"]
    },
    riskLevel: "low",
    async run(args) {
      const query = String(args?.query ?? "").trim().slice(0, 500);
      if (!query) return { isError: true, content: [{ type: "text", text: "query 必填" }] };
      const limit = Math.max(1, Math.min(10, Number(args?.limit) || 5));
      ensureDefaultPersona();
      const ranked = await retrieveMemoriesDetailed(personaId(), query, { limit, recordAccess: true });
      const lines = (ranked ?? []).slice(0, limit).map(x => {
        const m = x?.memory ?? x;
        return `- [${m?.type ?? "fact"}] ${String(m?.content ?? "").slice(0, 300)}`;
      }).filter(line => line.length > 9);
      return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "（无相关记忆）" }] };
    }
  },
  {
    name: "companion.memory.add",
    title: "Memory Add",
    description: "向 Companion 长期记忆添加一条事实（进入 staging，需经 Memory Policy 审核后生效）。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "记忆内容（一句明确的事实）" },
        type: { type: "string", description: "fact / preference / event" },
        importance: { type: "number", description: "0-1，默认 0.5" }
      },
      required: ["content"]
    },
    riskLevel: "medium",
    async run(args) {
      const content = String(args?.content ?? "").trim().slice(0, 1000);
      if (!content) return { isError: true, content: [{ type: "text", text: "content 必填" }] };
      const type = ["fact", "preference", "event"].includes(String(args?.type)) ? String(args.type) : "fact";
      const importance = Math.max(0, Math.min(1, Number(args?.importance) || 0.5));
      ensureDefaultPersona();
      const memory = await addStagingMemory({ personaId: personaId(), content, type, importance, source: "mcp" });
      return { content: [{ type: "text", text: `已加入 staging 记忆（id=${memory?.id ?? "unknown"}，待 policy 审核）` }] };
    }
  },
  {
    name: "companion.weather.current",
    title: "Weather Current",
    description: "获取 Companion 配置位置（用户 coarse location）的当前天气。",
    inputSchema: { type: "object", properties: {} },
    riskLevel: "low",
    async run() {
      try {
        const text = await moduleRegistry.executeModuleTool("get_current_weather", {});
        return { content: [{ type: "text", text: String(text).slice(0, 2000) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `weather module 不可用：${safeErrorMessage(error)}` }] };
      }
    }
  },
  {
    name: "companion.followup.create",
    title: "Follow-up Create",
    description: "创建一条 follow-up 提醒（Companion 会在合适时机主动提起）。",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "要跟进的主题" },
        earliestAt: { type: "string", description: "ISO8601，最早提醒时间（可选）" },
        expiresInHours: { type: "number", description: "过期小时数，默认 72" }
      },
      required: ["topic"]
    },
    riskLevel: "medium",
    async run(args) {
      const topic = String(args?.topic ?? "").trim().slice(0, 300);
      if (!topic) return { isError: true, content: [{ type: "text", text: "topic 必填" }] };
      const expiresInHours = Math.max(1, Math.min(24 * 30, Number(args?.expiresInHours) || 72));
      const now = Date.now();
      const followup = addPendingFollowup({
        topic,
        earliestAt: args?.earliestAt ? String(args.earliestAt).slice(0, 32) : new Date(now + 30 * 60 * 1000).toISOString(),
        expiresAt: new Date(now + expiresInHours * 3600 * 1000).toISOString(),
        sourceSessionId: null
      });
      return { content: [{ type: "text", text: followup ? `已创建 follow-up：${followup.id}` : "相同主题的 follow-up 已存在，未重复创建" }] };
    }
  },
  {
    name: "companion.followup.list",
    title: "Follow-up List",
    description: "列出当前待处理的 follow-up 提醒。",
    inputSchema: { type: "object", properties: {} },
    riskLevel: "low",
    async run() {
      expirePendingFollowups();
      const items = (getState().pendingFollowups ?? []).filter(f => f.status === "pending").slice(0, 20);
      const lines = items.map(f => `- [${f.id}] ${String(f.topic ?? "").slice(0, 160)}（创建于 ${f.createdAt}）`);
      return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "（当前没有待处理的 follow-up）" }] };
    }
  },
  {
    name: "companion.web.search",
    title: "Web Search",
    description: "使用 Companion 配置的搜索后端（Tavily / SearXNG）搜索互联网。未配置搜索后端时会明确报错。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        max_results: { type: "integer", description: "结果数 1-8，默认 6" }
      },
      required: ["query"]
    },
    riskLevel: "low",
    async run(args) {
      const status = searchStatus(config);
      if (!status.configured) return { isError: true, content: [{ type: "text", text: `联网搜索未配置：${status.reason}` }] };
      const outcome = await executeWebSearchTool(config, { query: args?.query, max_results: args?.max_results }, { source: "mcp" });
      return { content: [{ type: "text", text: outcome.content }] };
    }
  },
  {
    name: "companion.modules.list",
    title: "Modules List",
    description: "列出 Companion 已安装模块及其工具（不含任何凭据）。",
    inputSchema: { type: "object", properties: {} },
    riskLevel: "low",
    async run() {
      const status = moduleRegistry.listStatus();
      const lines = status.modules.map(m => `- ${m.id} v${m.version} enabled=${m.enabled} loaded=${m.loaded} tools=[${m.tools.map(t => t.name).join(", ")}]`);
      return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "（没有已安装模块）" }] };
    }
  }
];

export function redactToolText(text) { return redactSecrets(String(text ?? "")); }
