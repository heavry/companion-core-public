import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { COMPANION_MCP_TOOLS, redactToolText } from "./server-tools.js";

// Companion MCP Server 的 HTTP transport（stateless streamable HTTP，挂载在 Core /mcp）。
// 鉴权由 Core 路由层完成（Bearer MCP token / API key），本模块不做鉴权。

function buildServer() {
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
  return server;
}

export async function handleMcpHttpRequest(req, res, parsedBody) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  res.on("close", () => { try { transport.close(); } catch {} try { server.close(); } catch {} });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}
