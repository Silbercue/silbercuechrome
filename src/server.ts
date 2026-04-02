import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function startServer(): Promise<void> {
  const server = new McpServer({
    name: "silbercuechrome",
    version: "0.1.0",
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SilbercueChrome MCP server running on stdio");
}
