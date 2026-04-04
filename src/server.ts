import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ChromeLauncher } from "./cdp/chrome-launcher.js";
import { SessionManager } from "./cdp/session-manager.js";
import { DialogHandler } from "./cdp/dialog-handler.js";
import { ConsoleCollector } from "./cdp/console-collector.js";
import { DEVICE_METRICS_OVERRIDE } from "./cdp/emulation.js";
import { ToolRegistry } from "./registry.js";
import { TabStateCache } from "./cache/tab-state-cache.js";
import { a11yTree } from "./cache/a11y-tree.js";
import { LicenseValidator } from "./license/license-validator.js";
import { loadLicenseConfig } from "./license/license-validator.js";
import { loadFreeTierConfig } from "./license/free-tier-config.js";

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export async function startServer(): Promise<void> {
  // 1. Connect to Chrome (Story 1.3: WebSocket first, then Auto-Launch)
  const profilePath = process.env.SILBERCUE_CHROME_PROFILE || undefined;
  const launcher = new ChromeLauncher({ profilePath });
  const connection = await launcher.connect();
  const { cdpClient } = connection;

  if (profilePath) {
    if (connection.transportType === "pipe") {
      console.error(`SilbercueChrome using Chrome profile: ${profilePath}`);
    } else {
      console.error(`SilbercueChrome warning: profilePath "${profilePath}" ignored — connected via WebSocket to existing Chrome`);
    }
  }

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
  await cdpClient.send("Emulation.setDeviceMetricsOverride", DEVICE_METRICS_OVERRIDE, sessionId);

  // 4. Create TabStateCache and attach to CDP events
  const tabStateCache = new TabStateCache({ ttlMs: 30_000 });
  tabStateCache.setActiveTarget(pageTarget.targetId);
  tabStateCache.attachToClient(cdpClient, sessionId);

  // 4b. Create SessionManager for OOPIF support
  const sessionManager = new SessionManager(cdpClient, sessionId);
  // H1: Wire up OOPIF detach callback to clean A11yTreeProcessor ref-maps
  sessionManager.onOopifDetach((detachedSessionId) => {
    a11yTree.removeNodesForSession(detachedSessionId);
  });
  await sessionManager.init();

  // 4c. Create DialogHandler for automatic dialog handling (Story 6.1)
  const dialogHandler = new DialogHandler(cdpClient, sessionId);
  dialogHandler.init();

  // 4d. Create ConsoleCollector for console log buffering (Story 7.1)
  const consoleCollector = new ConsoleCollector(cdpClient, sessionId);
  consoleCollector.init();

  // 6. Create MCP server and register tools
  const server = new McpServer({
    name: "silbercuechrome",
    version: "0.1.0",
  });

  // Story 9.2: License-Key Validierung
  const licenseConfig = loadLicenseConfig();
  const licenseValidator = new LicenseValidator(licenseConfig);
  try {
    await licenseValidator.validate();
  } catch {
    // validate() should never throw, but if it does — Free Tier is fine
  }
  const freeTierConfig = loadFreeTierConfig();

  const registry = new ToolRegistry(server, cdpClient, sessionId, tabStateCache, () => connection.status, sessionManager, dialogHandler, licenseValidator, freeTierConfig, consoleCollector);
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
    await newCdpClient.send("Emulation.setDeviceMetricsOverride", DEVICE_METRICS_OVERRIDE, newSessionId);

    // 3. Re-wire TabStateCache: detach from old, attach to new
    tabStateCache.detachFromClient();
    tabStateCache.setActiveTarget(newPageTarget.targetId);
    tabStateCache.attachToClient(newCdpClient, newSessionId);

    // 4. Re-wire ToolRegistry
    registry.updateClient(newCdpClient, newSessionId);

    // 5. Re-initialize SessionManager for OOPIF support
    await sessionManager.reinit(newCdpClient, newSessionId);

    // 6. Re-initialize DialogHandler for dialog handling
    dialogHandler.reinit(newCdpClient, newSessionId);

    // 7. Re-initialize ConsoleCollector for console log buffering
    consoleCollector.reinit(newCdpClient, newSessionId);
  });

  // 7. Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SilbercueChrome MCP server running on stdio");

  // 8. Graceful shutdown
  const shutdown = async () => {
    consoleCollector.detach();
    dialogHandler.detach();
    sessionManager.detach();
    tabStateCache.detachFromClient();
    await server.close();
    await connection.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
