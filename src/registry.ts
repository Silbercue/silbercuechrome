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

export class ToolRegistry {
  private _sessionId: string;
  private _handlers = new Map<string, (params: Record<string, unknown>) => Promise<ToolResponse>>();
  readonly planStateStore = new PlanStateStore();

  private _getConnectionStatus: (() => ConnectionStatus) | null = null;
  private _sessionManager: SessionManager | undefined;
  private _dialogHandler: DialogHandler | undefined;
  private _licenseStatus: LicenseStatus;
  private _freeTierConfig: FreeTierConfig;

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
  ) {
    this._sessionId = sessionId;
    this._getConnectionStatus = getConnectionStatus ?? null;
    this._sessionManager = sessionManager;
    this._dialogHandler = dialogHandler;
    this._licenseStatus = licenseStatus ?? new FreeTierLicenseStatus();
    this._freeTierConfig = freeTierConfig ?? loadFreeTierConfig();
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

  async executeTool(name: string, params: Record<string, unknown>): Promise<ToolResponse> {
    const handler = this._handlers.get(name);
    if (!handler) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
        _meta: { elapsedMs: 0, method: name },
      };
    }
    const result = await handler(params);
    this._injectDialogNotifications(result);
    return result;
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

  registerAll(): void {
    // Create Human Touch config from environment (once at startup)
    const humanTouch = createHumanTouchFromEnv();
    if (humanTouch.enabled) {
      console.error(`SilbercueChrome human touch enabled (speed: ${humanTouch.speedProfile})`);
    }
    // Story 6.1 (C1): All server.tool() callbacks are wrapped with dialog notification
    // injection so that pending dialogs reach the LLM regardless of call path
    // (direct MCP call vs executeTool/run_plan).
    const wrap = <T>(fn: (params: T) => Promise<ToolResponse>) => this._wrapWithDialogInjection(fn);

    this.server.tool(
      "evaluate",
      "Execute JavaScript in the browser page context and return the result",
      {
        expression: evaluateSchema.shape.expression,
        await_promise: evaluateSchema.shape.await_promise,
      },
      wrap(async (params) => {
        return evaluateHandler(params as unknown as EvaluateParams, this.cdpClient, this.sessionId);
      }),
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
      }),
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
      }),
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
      }),
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
      }),
    );

    this.server.tool(
      "click",
      "Click an element by A11y-Tree ref (e.g. 'e5') or CSS selector. Returns immediately after click — use wait_for if the click triggers navigation or async content loading.",
      {
        ref: clickSchema.shape.ref,
        selector: clickSchema.shape.selector,
      },
      wrap(async (params) => {
        return clickHandler(params as unknown as ClickParams, this.cdpClient, this.sessionId, this._sessionManager, humanTouch);
      }),
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
      }),
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
      }),
    );

    this.server.tool(
      "switch_tab",
      "Open, switch to, or close browser tabs",
      {
        action: switchTabSchema.shape.action,
        url: switchTabSchema.shape.url,
        tab_id: switchTabSchema.shape.tab_id,
      },
      wrap(async (params) => {
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
      }),
    );

    this.server.tool(
      "virtual_desk",
      "Compact overview of all open browser tabs with state (URL, title, loading status, active/inactive)",
      {},
      wrap(async (params) => {
        return virtualDeskHandler(
          params as unknown as VirtualDeskParams,
          this.cdpClient,
          this.sessionId,
          this._tabStateCache,
          this.connectionStatus,
        );
      }),
    );

    this.server.tool(
      "dom_snapshot",
      "Get a compact visual snapshot of the page: element positions, colors, z-order, clickability. Mapped to read_page refs.",
      {
        ref: domSnapshotSchema.shape.ref,
      },
      wrap(async (params) => {
        return domSnapshotHandler(params as unknown as DomSnapshotParams, this.cdpClient, this.sessionId, this._sessionManager);
      }),
    );

    // Story 6.1: handle_dialog — configure dialog handling before triggering actions
    if (this._dialogHandler) {
      this.server.tool(
        "handle_dialog",
        "Configure how the browser handles JavaScript dialogs (alerts, confirms, prompts). Pre-configure before triggering actions, or check dialog status.",
        {
          action: handleDialogSchema.shape.action,
          text: handleDialogSchema.shape.text,
        },
        async (params) => {
          return handleDialogHandler(params as unknown as HandleDialogParams, this._dialogHandler!);
        },
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
      }),
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
      }),
    );

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
      "Execute a sequential plan of tool steps server-side. Supports variables ($varName), conditions (if), saveAs, error strategies (abort/continue/screenshot), and suspend/resume for agent decisions mid-plan. Use resume: { planId, answer } to continue a suspended plan.",
      {
        steps: runPlanSchema.shape.steps,
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
      }),
    );

    // Register tool handlers for executeTool dispatch
    // IMPORTANT: run_plan is NOT registered here to prevent recursive invocation
    this._handlers.set("evaluate", async (params) => {
      return evaluateHandler(params as unknown as EvaluateParams, this.cdpClient, this.sessionId);
    });
    this._handlers.set("navigate", async (params) => {
      return navigateHandler(params as unknown as NavigateParams, this.cdpClient, this.sessionId);
    });
    this._handlers.set("read_page", async (params) => {
      return readPageHandler(params as unknown as ReadPageParams, this.cdpClient, this.sessionId, this._sessionManager);
    });
    this._handlers.set("screenshot", async (params) => {
      return screenshotHandler(params as unknown as ScreenshotParams, this.cdpClient, this.sessionId, this._sessionManager);
    });
    this._handlers.set("wait_for", async (params) => {
      return waitForHandler(params as unknown as WaitForParams, this.cdpClient, this.sessionId);
    });
    this._handlers.set("click", async (params) => {
      return clickHandler(params as unknown as ClickParams, this.cdpClient, this.sessionId, this._sessionManager, humanTouch);
    });
    this._handlers.set("type", async (params) => {
      return typeHandler(params as unknown as TypeParams, this.cdpClient, this.sessionId, this._sessionManager, humanTouch);
    });
    this._handlers.set("tab_status", async (params) => {
      return tabStatusHandler(
        params as unknown as TabStatusParams,
        this.cdpClient,
        this.sessionId,
        this._tabStateCache,
        this.connectionStatus,
      );
    });
    this._handlers.set("switch_tab", async (params) => {
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
    this._handlers.set("virtual_desk", async (params) => {
      return virtualDeskHandler(
        params as unknown as VirtualDeskParams,
        this.cdpClient,
        this.sessionId,
        this._tabStateCache,
        this.connectionStatus,
      );
    });
    this._handlers.set("dom_snapshot", async (params) => {
      return domSnapshotHandler(params as unknown as DomSnapshotParams, this.cdpClient, this.sessionId, this._sessionManager);
    });
    if (this._dialogHandler) {
      this._handlers.set("handle_dialog", async (params) => {
        return handleDialogHandler(params as unknown as HandleDialogParams, this._dialogHandler!);
      });
    }
    this._handlers.set("file_upload", async (params) => {
      return fileUploadHandler(
        params as unknown as FileUploadParams,
        this.cdpClient,
        this.sessionId,
        this._sessionManager,
      );
    });
    this._handlers.set("fill_form", async (params) => {
      return fillFormHandler(
        params as unknown as FillFormParams,
        this.cdpClient,
        this.sessionId,
        this._sessionManager,
        humanTouch,
      );
    });
  }
}
