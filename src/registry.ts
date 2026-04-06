import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CdpClient } from "./cdp/cdp-client.js";
import type { SessionManager } from "./cdp/session-manager.js";
import type { DialogHandler } from "./cdp/dialog-handler.js";
import type { TabStateCache } from "./cache/tab-state-cache.js";
import type { ToolResponse, ToolContentBlock, ConnectionStatus } from "./types.js";
import { evaluateSchema, evaluateHandler } from "./tools/evaluate.js";
import type { EvaluateParams } from "./tools/evaluate.js";
import { navigateSchema, navigateHandler } from "./tools/navigate.js";
import type { NavigateParams } from "./tools/navigate.js";
import { readPageSchema, readPageHandler } from "./tools/read-page.js";
import type { ReadPageParams } from "./tools/read-page.js";
import { screenshotSchema, screenshotHandler } from "./tools/screenshot.js";
import type { ScreenshotParams } from "./tools/screenshot.js";
import { waitForSchema, waitForHandler } from "./tools/wait-for.js";
import type { WaitForParams } from "./tools/wait-for.js";
import { clickSchema, clickHandler } from "./tools/click.js";
import type { ClickParams } from "./tools/click.js";
import { typeSchema, typeHandler } from "./tools/type.js";
import type { TypeParams } from "./tools/type.js";
import { tabStatusHandler } from "./tools/tab-status.js";
import type { TabStatusParams } from "./tools/tab-status.js";
import { switchTabSchema, switchTabHandler } from "./tools/switch-tab.js";
import type { SwitchTabParams } from "./tools/switch-tab.js";
import { virtualDeskHandler } from "./tools/virtual-desk.js";
import type { VirtualDeskParams } from "./tools/virtual-desk.js";
import { runPlanSchema, runPlanHandler } from "./tools/run-plan.js";
import type { RunPlanParams } from "./tools/run-plan.js";
import { domSnapshotSchema, domSnapshotHandler } from "./tools/dom-snapshot.js";
import type { DomSnapshotParams } from "./tools/dom-snapshot.js";
import { handleDialogSchema, handleDialogHandler } from "./tools/handle-dialog.js";
import type { HandleDialogParams } from "./tools/handle-dialog.js";
import { fileUploadSchema, fileUploadHandler } from "./tools/file-upload.js";
import type { FileUploadParams } from "./tools/file-upload.js";
import { fillFormSchema, fillFormHandler } from "./tools/fill-form.js";
import type { FillFormParams } from "./tools/fill-form.js";
import { consoleLogsSchema, consoleLogsHandler } from "./tools/console-logs.js";
import type { ConsoleLogsParams } from "./tools/console-logs.js";
import type { ConsoleCollector } from "./cdp/console-collector.js";
import { networkMonitorSchema, networkMonitorHandler } from "./tools/network-monitor.js";
import type { NetworkMonitorParams } from "./tools/network-monitor.js";
import type { NetworkCollector } from "./cdp/network-collector.js";
import { configureSessionSchema, configureSessionHandler } from "./tools/configure-session.js";
import type { ConfigureSessionParams } from "./tools/configure-session.js";
import type { SessionDefaults } from "./cache/session-defaults.js";
import { createMicroLlmFromEnv } from "./operator/micro-llm.js";
import { createHumanTouchFromEnv } from "./operator/human-touch.js";
import { Captain } from "./operator/captain.js";
import type { CaptainProvider } from "./operator/captain.js";
import type { CaptainEscalationConfig } from "./operator/types.js";
import { PlanStateStore } from "./plan/plan-state-store.js";
import type { LicenseStatus } from "./license/license-status.js";
import type { FreeTierConfig } from "./license/free-tier-config.js";
import { FreeTierLicenseStatus } from "./license/license-status.js";
import { loadFreeTierConfig } from "./license/free-tier-config.js";
import { getProHooks, registerProHooks, proFeatureError } from "./hooks/pro-hooks.js";
import { a11yTree } from "./cache/a11y-tree.js";

// Story 13.1: Tools whose response IS page context — no ambient injection needed
const PAGE_CONTEXT_TOOLS = new Set(["read_page", "dom_snapshot", "screenshot"]);

export class ToolRegistry {
  private _sessionId: string;
  private _handlers = new Map<string, (params: Record<string, unknown>, sessionIdOverride?: string) => Promise<ToolResponse>>();
  readonly planStateStore = new PlanStateStore();

  // Story 13.1: Ambient Page Context — track which cache version was last sent
  private _lastSentCacheVersion = -1;

  private _getConnectionStatus: (() => ConnectionStatus) | null = null;
  private _sessionManager: SessionManager | undefined;
  private _dialogHandler: DialogHandler | undefined;
  private _licenseStatus: LicenseStatus;
  private _freeTierConfig: FreeTierConfig;
  private _consoleCollector: ConsoleCollector | undefined;
  private _networkCollector: NetworkCollector | undefined;
  private _sessionDefaults: SessionDefaults | undefined;
  // Story 13a.2: Callback to wait for Accessibility.nodesUpdated event
  private _waitForAXChange: ((timeoutMs: number) => Promise<boolean>) | null = null;

  constructor(
    private server: McpServer,
    private cdpClient: CdpClient,
    sessionId: string,
    private _tabStateCache: TabStateCache,
    getConnectionStatus?: () => ConnectionStatus,
    sessionManager?: SessionManager,
    dialogHandler?: DialogHandler,
    licenseStatus?: LicenseStatus,
    freeTierConfig?: FreeTierConfig,
    consoleCollector?: ConsoleCollector,
    networkCollector?: NetworkCollector,
    sessionDefaults?: SessionDefaults,
    waitForAXChange?: (timeoutMs: number) => Promise<boolean>,
  ) {
    this._sessionId = sessionId;
    this._getConnectionStatus = getConnectionStatus ?? null;
    this._sessionManager = sessionManager;
    this._dialogHandler = dialogHandler;
    this._licenseStatus = licenseStatus ?? new FreeTierLicenseStatus();
    this._freeTierConfig = freeTierConfig ?? loadFreeTierConfig();
    this._consoleCollector = consoleCollector;
    this._networkCollector = networkCollector;
    this._sessionDefaults = sessionDefaults;
    this._waitForAXChange = waitForAXChange ?? null;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  updateSession(sessionId: string): void {
    this._sessionId = sessionId;
  }

  /** Swap the CDP client and session after a successful reconnect */
  updateClient(cdpClient: CdpClient, sessionId: string): void {
    this.cdpClient = cdpClient;
    this._sessionId = sessionId;
  }

  /** Get current connection status (connected, reconnecting, disconnected) */
  get connectionStatus(): ConnectionStatus {
    return this._getConnectionStatus?.() ?? "connected";
  }

  async executeTool(name: string, params: Record<string, unknown>, sessionIdOverride?: string): Promise<ToolResponse> {
    const handler = this._handlers.get(name);
    if (!handler) {
      const content: ToolContentBlock[] = [{ type: "text", text: `Unknown tool: ${name}` }];
      return {
        content,
        isError: true,
        _meta: { elapsedMs: 0, method: name, response_bytes: Buffer.byteLength(JSON.stringify(content), 'utf8') },
      };
    }
    // Story 7.3: Track call and resolve session defaults for run_plan path
    // Skip trackCall/resolveParams for meta-tools (H2 fix)
    let resolvedParams = params;
    let suggestionText: string | undefined;
    if (this._sessionDefaults && name !== "configure_session") {
      this._sessionDefaults.trackCall(name, params);
      // H1 fix: Read suggestions immediately after trackCall (atomic with tracking)
      const suggestions = this._sessionDefaults.getSuggestions();
      if (suggestions.length > 0) {
        const s = suggestions[0];
        suggestionText = `${s.param} '${s.value}' wurde ${s.count}x verwendet — setze als Default mit configure_session`;
      }
      resolvedParams = this._sessionDefaults.resolveParams(name, params);
    }
    const result = await handler(resolvedParams, sessionIdOverride);
    this._injectDialogNotifications(result);
    // Story 13.1: Ambient Page Context — inject after action, before metrics
    await this._injectAmbientContext(result, name);
    // Story 7.3: Inject auto-promote suggestion into _meta
    if (suggestionText && result._meta) {
      result._meta.suggestion = suggestionText;
    }
    // Story 12.1: Inject response_bytes into _meta
    if (result._meta) {
      const responseBytes = Buffer.byteLength(JSON.stringify(result.content ?? []), 'utf8');
      result._meta.response_bytes = responseBytes;
      // Story 12.2: Inject estimated_tokens for text-heavy tools
      const method = result._meta.method;
      if (method === "read_page" || method === "dom_snapshot") {
        result._meta.estimated_tokens = Math.ceil(responseBytes / 4);
      }
    }
    return result;
  }

  /**
   * Story 13a.2: Ambient Page Context v2 — smart post-action detection.
   * For action tools (click, type): uses pre-click classification to decide
   * whether to wait for page changes before injecting context.
   * For other tools: injects if cache version changed (v1 behavior).
   */
  private async _injectAmbientContext(result: ToolResponse, toolName: string): Promise<void> {
    if (PAGE_CONTEXT_TOOLS.has(toolName)) return;
    if (result.isError) return;

    // Tab switch/open: session changed → force-refresh a11yTree for the new tab
    if (toolName === "switch_tab") {
      try {
        a11yTree.reset(); // Clear stale refs from previous tab (prevents duplicates with same-URL tabs)
        await a11yTree.refreshPrecomputed(this.cdpClient, this._sessionId, this._sessionManager);
      } catch {
        return; // Refresh failed (e.g. chrome:// page) — skip context gracefully
      }
      const snapshot = a11yTree.getCompactSnapshot();
      if (!snapshot) return;
      result.content.push({ type: "text", text: snapshot });
      this._lastSentCacheVersion = a11yTree.cacheVersion;
      return;
    }

    const elementClass = result._meta?.elementClass as string | undefined;

    // Story 13a.2: Pre-click classification — skip immediately for disabled/static
    if (elementClass === "disabled" || elementClass === "static") return;

    // Story 13a.2: Widget-state or unknown clickable — wait for AX change
    if (elementClass === "widget-state" || elementClass === "clickable") {
      if (this._waitForAXChange) {
        // Story 13a.2 fix: Chrome has a 250ms throttle on nodesUpdated — use 350ms+ to avoid false negatives
        const timeoutMs = elementClass === "widget-state" ? 500 : 350;
        const changed = await this._waitForAXChange(timeoutMs);
        if (changed) {
          // Refresh the precomputed cache to get fresh data
          try {
            await a11yTree.refreshPrecomputed(this.cdpClient, this._sessionId, this._sessionManager);
          } catch {
            // Refresh failed — fall through to version check below
          }
        } else if (elementClass === "clickable") {
          // Hash-probe fallback: nodesUpdated didn't fire (CSS-only toggle?).
          // Fetch fresh tree and compare snapshot — inject only if tree actually changed.
          const snapshotBefore = a11yTree.getCompactSnapshot();
          try {
            await a11yTree.refreshPrecomputed(this.cdpClient, this._sessionId, this._sessionManager);
          } catch {
            return; // Refresh failed — can't determine if page changed
          }
          const snapshotAfter = a11yTree.getCompactSnapshot();
          if (snapshotBefore === snapshotAfter) {
            return; // Tree identical — nothing changed, skip injection
          }
          // Tree changed despite no nodesUpdated — fall through to inject
        }
        // widget-state: always inject even if no nodesUpdated (e.g. server-side toggle)
      }
    }

    // v1 fallback: inject if cache version changed
    const currentVersion = a11yTree.cacheVersion;
    if (currentVersion === this._lastSentCacheVersion) return;

    const snapshot = a11yTree.getCompactSnapshot();
    if (!snapshot) return;

    result.content.push({ type: "text", text: snapshot });
    this._lastSentCacheVersion = currentVersion;
  }

  /**
   * Story 6.1: Inject pending dialog notifications into any tool response.
   * Called from both executeTool() (run_plan path) and server.tool() callbacks (direct MCP path).
   */
  private _injectDialogNotifications(result: ToolResponse): void {
    const dialogs = this._dialogHandler?.consumeNotifications();
    if (dialogs && dialogs.length > 0) {
      const dialogText = dialogs
        .map((d) => `[dialog] ${d.type}: "${d.message}"`)
        .join("\n");
      result.content.push({ type: "text", text: dialogText });
    }
  }

  /**
   * Create a Captain instance if MCP Elicitation is available.
   * Reads config from environment variables.
   * Returns undefined if Elicitation is not supported.
   */
  private _createCaptain(): { captain: CaptainProvider; includeScreenshot: boolean } | undefined {
    // The low-level Server exposes elicitInput — check if it exists
    const lowLevelServer = this.server.server;
    if (!lowLevelServer || typeof lowLevelServer.elicitInput !== "function") {
      return undefined;
    }

    const rawTimeout = process.env.SILBERCUE_CAPTAIN_TIMEOUT;
    const rawScreenshot = process.env.SILBERCUE_CAPTAIN_SCREENSHOT;

    const parsedTimeout = rawTimeout !== undefined ? parseInt(rawTimeout, 10) : NaN;

    const config: CaptainEscalationConfig = {
      enabled: true,
      timeoutMs: Number.isFinite(parsedTimeout) ? parsedTimeout : 30000,
      includeScreenshot: rawScreenshot === "true" || rawScreenshot === "1",
    };

    return { captain: new Captain(lowLevelServer, config), includeScreenshot: config.includeScreenshot };
  }

  /**
   * Wrap a tool handler so dialog notifications are injected into its response.
   * This ensures notifications reach the LLM regardless of whether the tool
   * is called via the direct MCP path (server.tool) or via executeTool (run_plan).
   */
  private _wrapWithDialogInjection<T>(
    handler: (params: T) => Promise<ToolResponse>,
  ): (params: T) => Promise<ToolResponse> {
    return async (params: T) => {
      const result = await handler(params);
      this._injectDialogNotifications(result);
      return result;
    };
  }

  /**
   * Story 9.5: Wrap a tool handler with a Pro feature gate check.
   * If a featureGate hook is registered and returns { allowed: false },
   * the tool is blocked with an isError response.
   * When no hook is registered, the tool executes normally.
   */
  wrapWithGate<T>(
    toolName: string,
    fn: (params: T) => Promise<ToolResponse>,
    hooks: ReturnType<typeof getProHooks>,
  ): (params: T) => Promise<ToolResponse> {
    return async (params: T): Promise<ToolResponse> => {
      const gate = hooks.featureGate?.(toolName);
      if (gate && !gate.allowed) {
        if (gate.message) {
          return {
            content: [{ type: "text", text: gate.message }],
            isError: true,
            _meta: { elapsedMs: 0, method: toolName },
          };
        }
        return proFeatureError(toolName);
      }
      return fn(params);
    };
  }

  registerAll(): void {
    // Story 9.5: Read Pro hooks once at startup
    const hooks = getProHooks();

    // Story 9.6: Register default feature gate for Pro-only tools
    // Pro-Repo can override by calling registerProHooks() before startServer()
    if (!hooks.featureGate) {
      const licenseStatus = this._licenseStatus;
      registerProHooks({
        ...hooks,
        featureGate: (toolName: string) => {
          const gatedTools = ["dom_snapshot", "switch_tab", "virtual_desk"];
          if (gatedTools.includes(toolName) && !licenseStatus.isPro()) {
            return { allowed: false };
          }
          return { allowed: true };
        },
      });
    }
    // Re-read hooks after potential registration
    const finalHooks = getProHooks();

    // Create Human Touch config from environment (once at startup)
    const humanTouch = createHumanTouchFromEnv();
    // Story 9.9: Human Touch is Pro-only — silently downgrade in Free tier (AC #3)
    if (humanTouch.enabled && !this._licenseStatus.isPro()) {
      humanTouch.enabled = false;
      console.error("SilbercueChrome human touch disabled (Pro feature — activate with 'silbercuechrome license activate <key>')");
    }
    if (humanTouch.enabled) {
      console.error(`SilbercueChrome human touch enabled (speed: ${humanTouch.speedProfile})`);
    }
    // Story 6.1 (C1): All server.tool() callbacks are wrapped with dialog notification
    // injection so that pending dialogs reach the LLM regardless of call path
    // (direct MCP call vs executeTool/run_plan).
    // Story 7.3: Extended wrap to include session defaults tracking, resolution, and suggestion injection.
    const sessionDefaults = this._sessionDefaults;
    // Story 12.1: Helper to inject response_bytes into _meta
    // Story 12.2: Also injects estimated_tokens for read_page and dom_snapshot
    const injectResponseBytes = (result: ToolResponse): void => {
      if (result._meta) {
        const responseBytes = Buffer.byteLength(JSON.stringify(result.content ?? []), 'utf8');
        result._meta.response_bytes = responseBytes;
        const method = result._meta.method;
        if (method === "read_page" || method === "dom_snapshot") {
          result._meta.estimated_tokens = Math.ceil(responseBytes / 4);
        }
      }
    };

    const wrap = <T>(fn: (params: T) => Promise<ToolResponse>, toolName?: string) => {
      const dialogWrapped = this._wrapWithDialogInjection(fn);
      if (!sessionDefaults) {
        // Story 12.1: Inject response_bytes even without sessionDefaults
        return async (params: T): Promise<ToolResponse> => {
          const result = await dialogWrapped(params);
          // Story 13.1: Ambient Page Context (before metrics so bytes include snapshot)
          await this._injectAmbientContext(result, toolName ?? "unknown");
          injectResponseBytes(result);
          return result;
        };
      }
      return async (params: T): Promise<ToolResponse> => {
        const name = toolName ?? "unknown";
        // H2 fix: Skip trackCall/resolveParams for meta-tools
        if (name === "configure_session") {
          const result = await dialogWrapped(params);
          injectResponseBytes(result);
          return result;
        }
        // Track call for auto-promote analysis
        sessionDefaults.trackCall(name, params as unknown as Record<string, unknown>);
        // H1 fix: Read suggestions immediately after trackCall (atomic with tracking)
        let suggestionText: string | undefined;
        const suggestions = sessionDefaults.getSuggestions();
        if (suggestions.length > 0) {
          const s = suggestions[0];
          suggestionText = `${s.param} '${s.value}' wurde ${s.count}x verwendet — setze als Default mit configure_session`;
        }
        // Resolve defaults into params
        const resolvedParams = sessionDefaults.resolveParams(name, params as unknown as Record<string, unknown>) as unknown as T;
        const result = await dialogWrapped(resolvedParams);
        // Story 13.1: Ambient Page Context (before metrics so bytes include snapshot)
        await this._injectAmbientContext(result, name);
        // Inject auto-promote suggestion into _meta
        if (suggestionText && result._meta) {
          result._meta.suggestion = suggestionText;
        }
        // Story 12.1: Inject response_bytes into _meta
        // Story 12.2: Inject estimated_tokens for text-heavy tools
        if (result._meta) {
          const responseBytes = Buffer.byteLength(JSON.stringify(result.content ?? []), 'utf8');
          result._meta.response_bytes = responseBytes;
          const method = result._meta.method;
          if (method === "read_page" || method === "dom_snapshot") {
            result._meta.estimated_tokens = Math.ceil(responseBytes / 4);
          }
        }
        return result;
      };
    };

    this.server.tool(
      "evaluate",
      "Execute JavaScript in the browser page context and return the result. Scope is shared between calls — top-level const/let/class are auto-wrapped in IIFE to prevent redeclaration errors. Prefer the click tool over element.click() in JS — click dispatches the full pointer event chain (pointerdown → mousedown → pointerup → mouseup → click) which works with custom widgets that only listen to mousedown/pointerdown.",
      {
        expression: evaluateSchema.shape.expression,
        await_promise: evaluateSchema.shape.await_promise,
      },
      wrap(async (params) => {
        return evaluateHandler(params as unknown as EvaluateParams, this.cdpClient, this.sessionId);
      }, "evaluate"),
    );

    this.server.tool(
      "navigate",
      "Navigate to a URL or go back, waits for page to settle before returning",
      {
        url: navigateSchema.shape.url,
        action: navigateSchema.shape.action,
        settle_ms: navigateSchema.shape.settle_ms,
      },
      wrap(async (params) => {
        return navigateHandler(params as unknown as NavigateParams, this.cdpClient, this.sessionId);
      }, "navigate"),
    );

    this.server.tool(
      "read_page",
      "Read page content via accessibility tree with stable element refs",
      {
        depth: readPageSchema.shape.depth,
        ref: readPageSchema.shape.ref,
        filter: readPageSchema.shape.filter,
        max_tokens: readPageSchema.shape.max_tokens,
      },
      wrap(async (params) => {
        return readPageHandler(params as unknown as ReadPageParams, this.cdpClient, this.sessionId, this._sessionManager);
      }, "read_page"),
    );

    this.server.tool(
      "screenshot",
      "Take a compressed WebP screenshot of the current page (max 800px wide, <100KB)",
      {
        full_page: screenshotSchema.shape.full_page,
        som: screenshotSchema.shape.som,
      },
      wrap(async (params) => {
        return screenshotHandler(params as unknown as ScreenshotParams, this.cdpClient, this.sessionId, this._sessionManager);
      }, "screenshot"),
    );

    this.server.tool(
      "wait_for",
      "Wait for a condition: element visible, network idle, or JS expression true",
      {
        condition: waitForSchema.shape.condition,
        selector: waitForSchema.shape.selector,
        expression: waitForSchema.shape.expression,
        timeout: waitForSchema.shape.timeout,
      },
      wrap(async (params) => {
        return waitForHandler(params as unknown as WaitForParams, this.cdpClient, this.sessionId);
      }, "wait_for"),
    );

    this.server.tool(
      "click",
      "Click an element by A11y-Tree ref (e.g. 'e5') or CSS selector. Dispatches the full pointer event chain (pointerdown/mousedown/pointerup/mouseup/click) — works with custom widgets that JS element.click() misses. Returns immediately after click — use wait_for if the click triggers navigation or async content loading.",
      {
        ref: clickSchema.shape.ref,
        selector: clickSchema.shape.selector,
      },
      wrap(async (params) => {
        return clickHandler(params as unknown as ClickParams, this.cdpClient, this.sessionId, this._sessionManager, humanTouch);
      }, "click"),
    );

    this.server.tool(
      "type",
      "Type text into an input field identified by ref or CSS selector",
      {
        ref: typeSchema.shape.ref,
        selector: typeSchema.shape.selector,
        text: typeSchema.shape.text,
        clear: typeSchema.shape.clear,
      },
      wrap(async (params) => {
        return typeHandler(params as unknown as TypeParams, this.cdpClient, this.sessionId, this._sessionManager, humanTouch);
      }, "type"),
    );

    this.server.tool(
      "tab_status",
      "Get cached tab state: URL, title, DOM-ready status, console errors. Instant from cache.",
      {},
      wrap(async (params) => {
        return tabStatusHandler(
          params as unknown as TabStatusParams,
          this.cdpClient,
          this.sessionId,
          this._tabStateCache,
          this.connectionStatus,
        );
      }, "tab_status"),
    );

    this.server.tool(
      "switch_tab",
      "Open, switch to, or close browser tabs",
      {
        action: switchTabSchema.shape.action,
        url: switchTabSchema.shape.url,
        tab_id: switchTabSchema.shape.tab_id,
      },
      wrap(this.wrapWithGate("switch_tab", async (params) => {
        return switchTabHandler(
          params as unknown as SwitchTabParams,
          this.cdpClient,
          this.sessionId,
          this._tabStateCache,
          (newSessionId) => {
            this.updateSession(newSessionId);
          },
          this._sessionManager,
        );
      }, finalHooks), "switch_tab"),
    );

    this.server.tool(
      "virtual_desk",
      "Lists all open tabs with IDs and state. Use this first when starting a session, after reconnect, or when a tab session is lost.",
      {},
      wrap(this.wrapWithGate("virtual_desk", async (params) => {
        return virtualDeskHandler(
          params as unknown as VirtualDeskParams,
          this.cdpClient,
          this.sessionId,
          this._tabStateCache,
          this.connectionStatus,
        );
      }, finalHooks), "virtual_desk"),
    );

    this.server.tool(
      "dom_snapshot",
      "Get a compact visual snapshot of the page: element positions, colors, z-order, clickability. Mapped to read_page refs.",
      {
        ref: domSnapshotSchema.shape.ref,
      },
      wrap(this.wrapWithGate("dom_snapshot", async (params) => {
        return domSnapshotHandler(params as unknown as DomSnapshotParams, this.cdpClient, this.sessionId, this._sessionManager);
      }, finalHooks), "dom_snapshot"),
    );

    // Story 6.1: handle_dialog — configure dialog handling before triggering actions
    // H3 fix: Route through wrap for default-resolution and suggestion-injection
    if (this._dialogHandler) {
      this.server.tool(
        "handle_dialog",
        "Configure how the browser handles JavaScript dialogs (alerts, confirms, prompts). Pre-configure before triggering actions, or check dialog status.",
        {
          action: handleDialogSchema.shape.action,
          text: handleDialogSchema.shape.text,
        },
        wrap(async (params) => {
          return handleDialogHandler(params as unknown as HandleDialogParams, this._dialogHandler!);
        }, "handle_dialog"),
      );
    }

    // Story 6.2: file_upload — upload files to file input elements
    this.server.tool(
      "file_upload",
      "Upload file(s) to a file input element. Provide ref or CSS selector to identify the <input type='file'>, and absolute path(s) to the file(s).",
      {
        ref: fileUploadSchema.shape.ref,
        selector: fileUploadSchema.shape.selector,
        path: fileUploadSchema.shape.path,
      },
      wrap(async (params) => {
        return fileUploadHandler(
          params as unknown as FileUploadParams,
          this.cdpClient,
          this.sessionId,
          this._sessionManager,
        );
      }, "file_upload"),
    );

    // Story 6.3: fill_form — fill complete forms with one call
    this.server.tool(
      "fill_form",
      "Fill a complete form with one call. Each field needs ref or CSS selector plus value. Supports text inputs, selects, checkboxes, and radio buttons. Partial errors do not abort — each field reports its own status.",
      {
        fields: fillFormSchema.shape.fields,
      },
      wrap(async (params) => {
        return fillFormHandler(
          params as unknown as FillFormParams,
          this.cdpClient,
          this.sessionId,
          this._sessionManager,
          humanTouch,
        );
      }, "fill_form"),
    );

    // Story 7.1: console_logs — retrieve and filter console output
    if (this._consoleCollector) {
      this.server.tool(
        "console_logs",
        "Retrieve collected browser console logs. Filter by level (info/warning/error/debug) and/or regex pattern. Optionally clear the buffer after reading.",
        {
          level: consoleLogsSchema.shape.level,
          pattern: consoleLogsSchema.shape.pattern,
          clear: consoleLogsSchema.shape.clear,
        },
        wrap(async (params) => {
          return consoleLogsHandler(params as unknown as ConsoleLogsParams, this._consoleCollector!);
        }, "console_logs"),
      );
    }

    // Story 7.2: network_monitor — start/stop/get network request monitoring
    if (this._networkCollector) {
      this.server.tool(
        "network_monitor",
        "Monitor network requests: start recording, retrieve recorded requests (with optional filter/pattern), or stop and return all collected data.",
        {
          action: networkMonitorSchema.shape.action,
          filter: networkMonitorSchema.shape.filter,
          pattern: networkMonitorSchema.shape.pattern,
        },
        wrap(async (params) => {
          return networkMonitorHandler(params as unknown as NetworkMonitorParams, this._networkCollector!);
        }, "network_monitor"),
      );
    }

    // C1: Create Micro-LLM provider from environment for Operator mode
    const microLlm = createMicroLlmFromEnv();

    // Story 8.3: Create Captain for escalation protocol
    // Captain is only available when MCP Elicitation is supported by the client.
    // Feature detection happens once at setup — no runtime checks per escalation.
    const captainResult = this._createCaptain();
    const captain = captainResult?.captain;
    const captainScreenshot = captainResult?.includeScreenshot ?? false;

    this.server.tool(
      "run_plan",
      "Execute a sequential plan of tool steps server-side. Supports variables ($varName), conditions (if), saveAs, error strategies (abort/continue/screenshot), suspend/resume, and parallel tab execution (Pro). Use parallel: [{ tab, steps }] for multi-tab workflows.",
      {
        steps: runPlanSchema.shape.steps,
        parallel: runPlanSchema.shape.parallel,
        use_operator: runPlanSchema.shape.use_operator,
        resume: runPlanSchema.shape.resume,
      },
      wrap(async (params) => {
        const result = await runPlanHandler(params as unknown as RunPlanParams, this, {
          cdpClient: this.cdpClient,
          sessionId: this._sessionId,
          microLlm,
          sessionManager: this._sessionManager,
          captain,
          captainScreenshot,
        }, this.planStateStore, this._licenseStatus, this._freeTierConfig);
        // Convert SuspendedPlanResponse to ToolResponse for MCP transport
        if ("status" in result && (result as { status: string }).status === "suspended") {
          const suspended = result as import("./plan/plan-executor.js").SuspendedPlanResponse;
          const content: Array<ToolContentBlock> = [
            { type: "text", text: JSON.stringify({
              status: suspended.status,
              planId: suspended.planId,
              question: suspended.question,
              completedSteps: suspended.completedSteps,
            }) },
          ];
          if (suspended.screenshot) {
            content.push({
              type: "image",
              data: suspended.screenshot,
              mimeType: "image/webp",
            } as ToolContentBlock);
          }
          return { content, _meta: suspended._meta };
        }
        return result as ToolResponse;
      }, "run_plan"),
    );

    // Story 7.3: configure_session — set session defaults and auto-promote
    if (this._sessionDefaults) {
      this.server.tool(
        "configure_session",
        "View/set session defaults for recurring parameters (tab, timeout, etc.). Without params: show current defaults and auto-promote suggestions. With autoPromote: true: apply all suggestions.",
        {
          defaults: configureSessionSchema.shape.defaults,
          autoPromote: configureSessionSchema.shape.autoPromote,
        },
        wrap(async (params) => {
          return configureSessionHandler(params as unknown as ConfigureSessionParams, this._sessionDefaults!);
        }, "configure_session"),
      );
    }

    // Register tool handlers for executeTool dispatch
    // IMPORTANT: run_plan is NOT registered here to prevent recursive invocation
    // Story 7.6: All session-aware handlers accept sessionIdOverride for parallel tab execution.
    // When sessionIdOverride is provided, it is used INSTEAD of this.sessionId.
    // This avoids Race-Conditions when multiple tab groups run in parallel.
    this._handlers.set("evaluate", async (params, sessionIdOverride?) => {
      return evaluateHandler(params as unknown as EvaluateParams, this.cdpClient, sessionIdOverride ?? this.sessionId);
    });
    this._handlers.set("navigate", async (params, sessionIdOverride?) => {
      return navigateHandler(params as unknown as NavigateParams, this.cdpClient, sessionIdOverride ?? this.sessionId);
    });
    this._handlers.set("read_page", async (params, sessionIdOverride?) => {
      return readPageHandler(params as unknown as ReadPageParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._sessionManager);
    });
    this._handlers.set("screenshot", async (params, sessionIdOverride?) => {
      return screenshotHandler(params as unknown as ScreenshotParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._sessionManager);
    });
    this._handlers.set("wait_for", async (params, sessionIdOverride?) => {
      return waitForHandler(params as unknown as WaitForParams, this.cdpClient, sessionIdOverride ?? this.sessionId);
    });
    this._handlers.set("click", async (params, sessionIdOverride?) => {
      return clickHandler(params as unknown as ClickParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._sessionManager, humanTouch);
    });
    this._handlers.set("type", async (params, sessionIdOverride?) => {
      return typeHandler(params as unknown as TypeParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._sessionManager, humanTouch);
    });
    this._handlers.set("tab_status", async (params, sessionIdOverride?) => {
      return tabStatusHandler(
        params as unknown as TabStatusParams,
        this.cdpClient,
        sessionIdOverride ?? this.sessionId,
        this._tabStateCache,
        this.connectionStatus,
      );
    });
    this._handlers.set("switch_tab", async (params, sessionIdOverride?) => {
      // Story 9.9: Pro-Feature-Gate must fire BEFORE the parallel check
      const switchGate = finalHooks.featureGate?.("switch_tab");
      if (switchGate && !switchGate.allowed) {
        if (switchGate.message) {
          return { content: [{ type: "text", text: switchGate.message }], isError: true, _meta: { elapsedMs: 0, method: "switch_tab" } };
        }
        return proFeatureError("switch_tab");
      }
      // H3 fix: switch_tab in parallel context would mutate the global session — block it
      if (sessionIdOverride) {
        return {
          content: [{ type: "text", text: "switch_tab ist in parallelen Plan-Gruppen nicht erlaubt — jede Gruppe operiert auf ihrem eigenen Tab" }],
          isError: true,
          _meta: { elapsedMs: 0, method: "switch_tab" },
        };
      }
      return switchTabHandler(
        params as unknown as SwitchTabParams,
        this.cdpClient,
        this.sessionId,
        this._tabStateCache,
        (newSessionId) => {
          this.updateSession(newSessionId);
        },
        this._sessionManager,
      );
    });
    this._handlers.set("virtual_desk", async (params, sessionIdOverride?) => {
      // Story 9.9: Pro-Feature-Gate for virtual_desk
      const vdGate = finalHooks.featureGate?.("virtual_desk");
      if (vdGate && !vdGate.allowed) {
        if (vdGate.message) {
          return { content: [{ type: "text", text: vdGate.message }], isError: true, _meta: { elapsedMs: 0, method: "virtual_desk" } };
        }
        return proFeatureError("virtual_desk");
      }
      return virtualDeskHandler(
        params as unknown as VirtualDeskParams,
        this.cdpClient,
        sessionIdOverride ?? this.sessionId,
        this._tabStateCache,
        this.connectionStatus,
      );
    });
    this._handlers.set("dom_snapshot", async (params, sessionIdOverride?) => {
      // C1 fix: dom_snapshot must use sessionIdOverride for parallel tab execution
      const gate = finalHooks.featureGate?.("dom_snapshot");
      if (gate && !gate.allowed) {
        if (gate.message) {
          return { content: [{ type: "text", text: gate.message }], isError: true, _meta: { elapsedMs: 0, method: "dom_snapshot" } };
        }
        return proFeatureError("dom_snapshot");
      }
      return domSnapshotHandler(params as unknown as DomSnapshotParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._sessionManager);
    });
    if (this._dialogHandler) {
      this._handlers.set("handle_dialog", async (params, _sessionIdOverride?) => {
        // C2 fix: accept sessionIdOverride for parallel-context compatibility
        return handleDialogHandler(params as unknown as HandleDialogParams, this._dialogHandler!);
      });
    }
    this._handlers.set("file_upload", async (params, sessionIdOverride?) => {
      return fileUploadHandler(
        params as unknown as FileUploadParams,
        this.cdpClient,
        sessionIdOverride ?? this.sessionId,
        this._sessionManager,
      );
    });
    this._handlers.set("fill_form", async (params, sessionIdOverride?) => {
      return fillFormHandler(
        params as unknown as FillFormParams,
        this.cdpClient,
        sessionIdOverride ?? this.sessionId,
        this._sessionManager,
        humanTouch,
      );
    });
    if (this._consoleCollector) {
      this._handlers.set("console_logs", async (params) => {
        return consoleLogsHandler(params as unknown as ConsoleLogsParams, this._consoleCollector!);
      });
    }
    if (this._networkCollector) {
      this._handlers.set("network_monitor", async (params) => {
        return networkMonitorHandler(params as unknown as NetworkMonitorParams, this._networkCollector!);
      });
    }
    if (this._sessionDefaults) {
      this._handlers.set("configure_session", async (params) => {
        return configureSessionHandler(params as unknown as ConfigureSessionParams, this._sessionDefaults!);
      });
    }
  }
}
