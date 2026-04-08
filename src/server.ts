import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ChromeLauncher, resolveAutoLaunch } from "./cdp/chrome-launcher.js";
import { SessionManager } from "./cdp/session-manager.js";
import { DialogHandler } from "./cdp/dialog-handler.js";
import { ConsoleCollector } from "./cdp/console-collector.js";
import { NetworkCollector } from "./cdp/network-collector.js";
import { DomWatcher } from "./cdp/dom-watcher.js";
import { DEVICE_METRICS_OVERRIDE, EMULATED_WIDTH, EMULATED_HEIGHT, setHeadless } from "./cdp/emulation.js";
import { ToolRegistry } from "./registry.js";
import { injectOverlay, removeOverlay, setTierLabel, setLicenseInfo } from "./overlay/session-overlay.js";
import { TabStateCache } from "./cache/tab-state-cache.js";
import { SessionDefaults } from "./cache/session-defaults.js";
import { a11yTree } from "./cache/a11y-tree.js";
import { selectorCache } from "./cache/selector-cache.js";
import { FreeTierLicenseStatus } from "./license/license-status.js";
import type { LicenseStatus } from "./license/license-status.js";
import { loadFreeTierConfig } from "./license/free-tier-config.js";
import { getProHooks } from "./hooks/pro-hooks.js";

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export async function startServer(): Promise<void> {
  // 1. Connect to Chrome (Story 1.3: WebSocket first, then Auto-Launch)
  const profilePath = process.env.SILBERCUE_CHROME_PROFILE || undefined;
  const headlessEnv = process.env.SILBERCUE_CHROME_HEADLESS === "true";
  const autoLaunch = resolveAutoLaunch(process.env as Record<string, string | undefined>, headlessEnv);
  const launcher = new ChromeLauncher({ profilePath, headless: headlessEnv, autoLaunch });
  const connection = await launcher.connect();
  const { cdpClient } = connection;
  // Use detected headless from connection (auto-detected from Chrome's /json/version for WebSocket)
  const headless = connection.headless;
  setHeadless(headless);

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
  // BUG-015 fix: Keep renderer alive when window is occluded on macOS.
  // setFocusEmulationEnabled calls WebContents::IncrementCapturerCount(stay_hidden=false),
  // which keeps visible_capturer_count_ > 0 → renderer stays in kVisible state.
  if (!headless) {
    await cdpClient.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  }
  if (headless) {
    await cdpClient.send("Emulation.setDeviceMetricsOverride", DEVICE_METRICS_OVERRIDE, sessionId);
  } else {
    // Headed mode: resize browser window instead of emulating viewport.
    // Emulation.setDeviceMetricsOverride causes a gray bar below the content.
    try {
      const { windowId } = await cdpClient.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: pageTarget.targetId });
      await cdpClient.send("Browser.setWindowBounds", {
        windowId,
        bounds: { width: EMULATED_WIDTH, height: EMULATED_HEIGHT + 85 }, // +85 for Chrome UI (tabs, address bar)
      });
    } catch {
      // Fallback to emulation if Browser.setWindowBounds fails (e.g. remote connection)
      await cdpClient.send("Emulation.setDeviceMetricsOverride", DEVICE_METRICS_OVERRIDE, sessionId);
    }
  }

  // 3b. Inject session overlay (visual indicator for controlled tab)
  await injectOverlay(cdpClient, sessionId);

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

  // 4e. Create NetworkCollector for network request monitoring (Story 7.2)
  // NOT started here — on-demand via action: "start"
  const networkCollector = new NetworkCollector(cdpClient, sessionId);

  // 4f. Create SessionDefaults for session parameter defaults (Story 7.3)
  const sessionDefaults = new SessionDefaults();

  // 4g. Create DomWatcher for precomputed A11y-Tree (Story 7.4)
  const domWatcher = new DomWatcher(cdpClient, sessionId, { debounceMs: 500 });
  domWatcher.onRefresh(async () => {
    await a11yTree.refreshPrecomputed(cdpClient, sessionId, sessionManager);
    // Update selector cache fingerprint after tree refresh (Story 7.5)
    const urlResult = await cdpClient.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression: "document.URL", returnByValue: true },
      sessionId,
    );
    const fp = selectorCache.computeFingerprint(urlResult.result.value, a11yTree.refCount);
    selectorCache.updateFingerprint(fp);
  });
  domWatcher.onInvalidate(() => {
    a11yTree.invalidatePrecomputed();
    // H2 fix: Invalidate selector cache on navigation (not on every DOM mutation).
    // DOM mutations use fingerprint mismatch for self-healing instead.
    selectorCache.invalidate();
  });
  // BUG-010: Invalidate precomputed A11y-tree immediately on DOM mutations
  // (selector cache uses fingerprint self-healing, so only A11y cache needs immediate invalidation)
  domWatcher.onMutationInvalidate(() => {
    a11yTree.invalidatePrecomputed();
  });
  await domWatcher.init();

  // 6. Create MCP server and register tools
  const server = new McpServer(
    {
      name: "silbercuechrome",
      version: "0.1.0",
    },
    {
      instructions: [
        "SilbercueChrome controls a real Chrome browser via CDP.",
        "",
        "Workflow: virtual_desk → switch_tab (or navigate) → read_page → click/type/fill_form using refs.",
        "",
        "Token-efficiency rules:",
        "- read_page (accessibility tree with refs like 'e5') is 10-30x cheaper than screenshot.",
        "- Screenshots CANNOT drive click/type — only read_page returns usable element refs.",
        "- fill_form beats multiple type calls for any form with 2+ fields.",
        "- evaluate is a last resort — prefer read_page, click, type, fill_form, observe.",
      ].join("\n"),
    },
  );

  // Story 15.5: License status via ProHooks (Pro-Repo injiziert LicenseValidator)
  const hooks = getProHooks();
  let licenseStatus: LicenseStatus = new FreeTierLicenseStatus();
  if (hooks.provideLicenseStatus) {
    try {
      licenseStatus = await hooks.provideLicenseStatus();
    } catch {
      // Fallback to Free Tier
    }
  }
  const freeTierConfig = loadFreeTierConfig();

  // Set overlay tier label and license info
  setTierLabel(licenseStatus.isPro());
  setLicenseInfo(undefined, undefined, undefined);

  // Story 13a.2: Pass waitForAXChange callback to Registry for post-click detection
  const registry = new ToolRegistry(server, cdpClient, sessionId, tabStateCache, () => connection.status, sessionManager, dialogHandler, licenseStatus, freeTierConfig, consoleCollector, networkCollector, sessionDefaults, (ms) => domWatcher.waitForAXChange(ms));
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
    // BUG-015 fix: Keep renderer alive on reconnect (same as initial setup)
    if (!headless) {
      await newCdpClient.send("Emulation.setFocusEmulationEnabled", { enabled: true }, newSessionId);
    }
    if (headless) {
      await newCdpClient.send("Emulation.setDeviceMetricsOverride", DEVICE_METRICS_OVERRIDE, newSessionId);
    }

    // 2b. Re-inject session overlay after reconnect
    await injectOverlay(newCdpClient, newSessionId);

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

    // 8. Re-initialize NetworkCollector for network request monitoring
    networkCollector.reinit(newCdpClient, newSessionId);

    // 9. Re-initialize DomWatcher for precomputed A11y-Tree (Story 7.4)
    // H3: Rebind callbacks BEFORE reinit() to avoid race condition where
    // reinit()->init() fires events that invoke stale closures
    a11yTree.invalidatePrecomputed();
    // 10. Invalidate SelectorCache on reconnect (Story 7.5)
    selectorCache.invalidate();
    domWatcher.onRefresh(async () => {
      await a11yTree.refreshPrecomputed(newCdpClient, newSessionId, sessionManager);
      // Update selector cache fingerprint after tree refresh (Story 7.5)
      const urlResult = await newCdpClient.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        { expression: "document.URL", returnByValue: true },
        newSessionId,
      );
      const fp = selectorCache.computeFingerprint(urlResult.result.value, a11yTree.refCount);
      selectorCache.updateFingerprint(fp);
    });
    domWatcher.onInvalidate(() => {
      a11yTree.invalidatePrecomputed();
      selectorCache.invalidate();
    });
    // BUG-010: Rebind mutation invalidation callback on reconnect
    domWatcher.onMutationInvalidate(() => {
      a11yTree.invalidatePrecomputed();
    });
    await domWatcher.reinit(newCdpClient, newSessionId);
  });

  // 7. Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SilbercueChrome MCP server running on stdio");

  // 8. Graceful shutdown
  const shutdown = async () => {
    await removeOverlay(cdpClient, sessionId).catch(() => {});
    domWatcher.detach();
    networkCollector.detach();
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
