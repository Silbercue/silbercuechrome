import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ChromeLauncher } from "./cdp/chrome-launcher.js";
import { ToolRegistry } from "./registry.js";
import { TabStateCache } from "./cache/tab-state-cache.js";

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

  // 4. Create TabStateCache and attach to CDP events
  const tabStateCache = new TabStateCache({ ttlMs: 30_000 });
  tabStateCache.setActiveTarget(pageTarget.targetId);
  tabStateCache.attachToClient(cdpClient, sessionId);

  // 6. Create MCP server and register tools
  const server = new McpServer({
    name: "silbercuechrome",
    version: "0.1.0",
  });

  const registry = new ToolRegistry(server, cdpClient, sessionId, tabStateCache, () => connection.status);
  registry.registerAll();

  // 5. Register reconnect handler for automatic re-wiring (Story 5.2)
  // H1 fix: Registered AFTER registry creation to avoid TDZ reference
  connection.onReconnect(async (reconn) => {
    const newCdpClient = reconn.cdpClient;

    // 1. Attach to page target (same as initial startup)
    const { targetInfos: newTargets } = await newCdpClient.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    let newPageTarget = newTargets.find((t) => t.type === "page");
    if (!newPageTarget) {
      const { targetId } = await newCdpClient.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      newPageTarget = { targetId, type: "page", url: "about:blank" };
    }
    const { sessionId: newSessionId } = await newCdpClient.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: newPageTarget.targetId,
      flatten: true,
    });

    // 2. Enable CDP domains on the new session
    await newCdpClient.send("Runtime.enable", {}, newSessionId);
    await newCdpClient.send("Page.enable", {}, newSessionId);
    await newCdpClient.send("Page.setLifecycleEventsEnabled", { enabled: true }, newSessionId);
    await newCdpClient.send("Accessibility.enable", {}, newSessionId);

    // 3. Re-wire TabStateCache: detach from old, attach to new
    tabStateCache.detachFromClient();
    tabStateCache.setActiveTarget(newPageTarget.targetId);
    tabStateCache.attachToClient(newCdpClient, newSessionId);

    // 4. Re-wire ToolRegistry
    registry.updateClient(newCdpClient, newSessionId);
  });

  // 7. Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SilbercueChrome MCP server running on stdio");

  // 8. Graceful shutdown
  const shutdown = async () => {
    tabStateCache.detachFromClient();
    await server.close();
    await connection.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
