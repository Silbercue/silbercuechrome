import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ChromeLauncher } from "./cdp/chrome-launcher.js";
import { ToolRegistry } from "./registry.js";

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export async function startServer(): Promise<void> {
  // 1. Connect to Chrome (Story 1.3: WebSocket first, then Auto-Launch)
  const launcher = new ChromeLauncher();
  const connection = await launcher.connect();
  const { cdpClient } = connection;

  // 2. Attach to a page target (browser-level connection needs a page session)
  const { targetInfos } = await cdpClient.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  let pageTarget = targetInfos.find((t) => t.type === "page");

  if (!pageTarget) {
    const { targetId } = await cdpClient.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    pageTarget = { targetId, type: "page", url: "about:blank" };
  }

  const { sessionId } = await cdpClient.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId: pageTarget.targetId,
    flatten: true,
  });

  // 3. Activate CDP domains on the page session
  await cdpClient.send("Runtime.enable", {}, sessionId);
  await cdpClient.send("Page.enable", {}, sessionId);
  await cdpClient.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
  await cdpClient.send("Accessibility.enable", {}, sessionId);

  // 4. Create MCP server and register tools
  const server = new McpServer({
    name: "silbercuechrome",
    version: "0.1.0",
  });

  const registry = new ToolRegistry(server, cdpClient, sessionId);
  registry.registerAll();

  // 5. Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SilbercueChrome MCP server running on stdio");

  // 6. Graceful shutdown
  const shutdown = async () => {
    await server.close();
    await connection.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
