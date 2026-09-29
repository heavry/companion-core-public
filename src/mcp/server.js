#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema, CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { COMPANION_MCP_TOOLS, redactToolText } from "./server-tools.js";

// Companion MCP Server（stdio transport）。
// 用法（外部 MCP Client 配置）：
//   command: node
//   args:    ["/path/to/companion-core/src/mcp/server.js", "--stdio"]
// 依赖本地进程边界作为鉴权；绝不监听网络端口。

const server = new Server(
  { name: "companion-core", version: process.env.COMPANION_VERSION ?? "0.2.8.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: COMPANION_MCP_TOOLS.map(tool => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const tool = COMPANION_MCP_TOOLS.find(t => t.name === request.params?.name);
  if (!tool) return { isError: true, content: [{ type: "text", text: redactToolText(`unknown tool: ${request.params?.name}`) }] };
  try { return await tool.run(request.params?.arguments ?? {}); }
  catch (error) {
    return { isError: true, content: [{ type: "text", text: redactToolText(`tool failed: ${error?.message ?? String(error)}`) }] };
  }
});

await server.connect(new StdioServerTransport());
