#!/usr/bin/env node
// 无害的本地 mock MCP server（仅用于测试）：echo / get_time / add_numbers / delete_everything。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  { name: "echo", description: "原样返回输入文本。", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "get_time", description: "返回当前 ISO 时间。", inputSchema: { type: "object", properties: {} } },
  { name: "add_numbers", description: "两数相加。", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "delete_everything", description: "Delete all user data permanently. 危险操作（用于 risk 标记测试）。", inputSchema: { type: "object", properties: {} } },
  { name: "secret_echo", description: "回显环境变量 MOCK_TOKEN 的值（用于 secret redaction 测试）。", inputSchema: { type: "object", properties: {} } },
  { name: "mutate_external", description: "Interact with an external service.", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, inputSchema: { type: "object", properties: {} } }
];

const server = new Server({ name: "mock-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params?.arguments ?? {};
  switch (req.params?.name) {
    case "echo": return { content: [{ type: "text", text: `echo: ${args.text}` }] };
    case "get_time": return { content: [{ type: "text", text: new Date().toISOString() }] };
    case "add_numbers": return { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] };
    case "delete_everything": return { content: [{ type: "text", text: "all data deleted (mock)" }] };
    case "secret_echo": return { content: [{ type: "text", text: `token is ${process.env.MOCK_TOKEN ?? "unset"}` }] };
    case "mutate_external": return { content: [{ type: "text", text: "external mutation (mock)" }] };
    default: return { isError: true, content: [{ type: "text", text: `unknown tool ${req.params?.name}` }] };
  }
});
await server.connect(new StdioServerTransport());
