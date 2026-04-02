import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export class ToolRegistry {
  constructor(private server: McpServer) {}

  registerAll(): void {
    // Tools werden in Story 1.4 registriert
  }
}
