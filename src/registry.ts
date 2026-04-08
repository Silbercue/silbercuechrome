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
import { pressKeySchema, pressKeyHandler } from "./tools/press-key.js";
import type { PressKeyParams } from "./tools/press-key.js";
import { scrollSchema, scrollHandler } from "./tools/scroll.js";
import type { ScrollParams } from "./tools/scroll.js";
import { observeSchema, observeHandler } from "./tools/observe.js";
import type { ObserveParams } from "./tools/observe.js";
import type { SessionDefaults } from "./cache/session-defaults.js";
import { injectOverlay, updateOverlayStatus, getToolLabel, setLastElapsed, showClickIndicator } from "./overlay/session-overlay.js";
import { PlanStateStore } from "./plan/plan-state-store.js";
import type { LicenseStatus } from "./license/license-status.js";
import type { FreeTierConfig } from "./license/free-tier-config.js";
import { FreeTierLicenseStatus } from "./license/license-status.js";
import { loadFreeTierConfig } from "./license/free-tier-config.js";
import { z } from "zod";
import { getProHooks, registerProHooks, proFeatureError } from "./hooks/pro-hooks.js";
import type { ToolRegistryPublic } from "./hooks/pro-hooks.js";
import { a11yTree, A11yTreeProcessor } from "./cache/a11y-tree.js";

/**
 * Story 16.4: Konvertiert ein JSON-Schema-Literal in eine Zod Raw Shape,
 * damit der MCP-SDK `server.tool()` Aufruf den Schema-Check besteht.
 *
 * Unterstuetzte Typen:
 * - `string` (inkl. `enum` → `z.enum`)
 * - `boolean`
 * - `number`
 * - `integer` → `z.number().int()`
 * - `array` (mit `items.type` string|number|boolean|object — verschachtelt)
 * - `object` (rekursiv ueber `properties`/`required`)
 * - Type-Arrays wie `["string", "null"]` → `z.union([...])`
 * - Unbekannte Typen → `z.unknown()` als Fallback
 *
 * Default-Handling: Wenn ein Feld einen `default` hat, wird ausschliesslich
 * `.default(value)` angewendet. Zod behandelt Felder mit Default in einem
 * `z.object()` automatisch als optional (wenn der Input `undefined` ist,
 * wird der Default eingesetzt). Erst wenn KEIN Default existiert UND das
 * Feld nicht in `required` steht, wird `.optional()` angehaengt.
 */
export function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required ?? []) as string[]);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType = jsonSchemaPropToZod(prop);

    if (prop.description) {
      zodType = zodType.describe(prop.description as string);
    }

    if (prop.default !== undefined) {
      // Default impliziert in Zod automatisch optional — kein zusaetzliches
      // .optional() noetig (waere semantisch falsch: .default().optional()
      // veraendert den Output-Typ zu T | undefined).
      zodType = zodType.default(prop.default);
    } else if (!required.has(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return shape;
}

/**
 * Story 16.4: Konvertiert ein einzelnes JSON-Schema-Property in einen Zod-Typ.
 * Wird sowohl von `jsonSchemaToZodShape` als auch rekursiv von sich selbst
 * (fuer `array.items` und `object.properties`) aufgerufen.
 */
function jsonSchemaPropToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const propType = prop.type;

  // Type-Array (z.B. `["string", "null"]`) → Union
  if (Array.isArray(propType)) {
    const variants = propType.map((t) => jsonSchemaPropToZod({ ...prop, type: t }));
    if (variants.length === 0) return z.unknown();
    if (variants.length === 1) return variants[0]!;
    return z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  if (propType === "null") {
    return z.null();
  }

  if (propType === "string") {
    const enumValues = prop.enum as string[] | undefined;
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      return z.enum(enumValues as [string, ...string[]]);
    }
    return z.string();
  }

  if (propType === "boolean") {
    return z.boolean();
  }

  if (propType === "number") {
    return z.number();
  }

  if (propType === "integer") {
    return z.number().int();
  }

  if (propType === "array") {
    const items = prop.items as Record<string, unknown> | undefined;
    if (items && typeof items === "object") {
      return z.array(jsonSchemaPropToZod(items));
    }
    return z.array(z.unknown());
  }

  if (propType === "object") {
    // Rekursiver Aufruf fuer verschachtelte Objekte
    const nestedShape = jsonSchemaToZodShape(prop);
    return z.object(nestedShape);
  }

  return z.unknown();
}

export class ToolRegistry implements ToolRegistryPublic {
  private _sessionId: string;
  private _handlers = new Map<string, (params: Record<string, unknown>, sessionIdOverride?: string) => Promise<ToolResponse>>();
  readonly planStateStore = new PlanStateStore();

  /**
   * Story 15.2: Delegate for `registerTool()` — set during `registerAll()`
   * so it has access to the wrap() closure (dialog injection, response_bytes,
   * session defaults). Pro-Repo calls `registerTool()` from within
   * `registerProTools`, which runs inside `registerAll()` after this delegate
   * is installed.
   */
  private _registerProToolDelegate:
    | ((
        name: string,
        description: string,
        schema: Record<string, unknown>,
        handler: (
          params: Record<string, unknown>,
          sessionIdOverride?: string,
        ) => Promise<ToolResponse>,
      ) => void)
    | null = null;

  /**
   * Story 15.2: Public method exposed via `ToolRegistryPublic`. The Pro-Repo
   * uses this from within the `registerProTools` hook to register extra
   * MCP tools (e.g. inspect_element).
   *
   * Lifecycle: The delegate is installed at the start of `registerAll()`
   * (before `registerProTools` is invoked) and cleared at the end of
   * `registerAll()`. Calling `registerTool()` outside this window throws.
   */
  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (
      params: Record<string, unknown>,
      sessionIdOverride?: string,
    ) => Promise<ToolResponse>,
  ): void {
    if (!this._registerProToolDelegate) {
      throw new Error(
        "ToolRegistry.registerTool() can only be called during registerAll() / registerProTools",
      );
    }
    this._registerProToolDelegate(name, description, schema, handler);
  }

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

  // FR-H: Track whether the LLM has checked browser context before acting
  private _contextChecked = false;

  constructor(
    private server: McpServer,
    public cdpClient: CdpClient,
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

  /** Story 16.4: Public getter fuer OOPIF SessionManager (ToolRegistryPublic). */
  get sessionManager(): SessionManager | undefined {
    return this._sessionManager;
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
    // Story 16.5: enhanceTool hook (Operator/Human Touch) — Pro-Repo injiziert
    // Callback-Funktionen (z.B. humanMouseMove) in params. Sync-Hook, kein await.
    {
      const hooks = getProHooks();
      const enhanced = hooks.enhanceTool?.(name, resolvedParams);
      if (enhanced) {
        resolvedParams = enhanced;
      }
    }
    const result = await handler(resolvedParams, sessionIdOverride);
    this._injectDialogNotifications(result);
    // Story 15.3: Ambient Page Context — delegated to Pro-Repo via onToolResult hook
    await this._runOnToolResultHook(result, name);
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
   * Story 15.3: Invokes the `onToolResult` Pro-Hook (if registered) to enrich
   * the tool response with ambient context (DOM diffs, compact snapshots).
   *
   * The Free-Repo itself no longer contains any ambient-context orchestration —
   * the 3-stage click analysis (classifyRef → waitForAXChange → diffSnapshots →
   * formatDomDiff) now lives in the Pro-Repo hook implementation.
   *
   * Responsibilities that stay in the Free-Repo:
   *  - FR-007: `a11yTree.reset()` on navigate — called BEFORE the hook so
   *    stale refs never leak to the next tool call, even if the hook is
   *    not registered.
   *  - Error-guard: the hook is NOT invoked when `result.isError` is true,
   *    preserving the pre-15.3 semantics.
   *
   * After the hook returns, the enhanced response is merged via
   * `Object.assign(result, enhanced)` so the original `_meta` reference
   * remains stable — later code-paths (response_bytes, estimated_tokens,
   * suggestion injection) mutate `result._meta` in place. If the hook
   * returns a new `_meta` object, the original reference is restored to
   * prevent downstream mutations from writing to a detached object.
   */
  private async _runOnToolResultHook(result: ToolResponse, name: string): Promise<void> {
    // FR-007: Navigate invalidates all refs — reset immediately so next
    // tool gets clear stale-error even if no hook is registered.
    if (name === "navigate") {
      a11yTree.reset();
    }

    if (result.isError) return;

    const hooks = getProHooks();
    if (!hooks.onToolResult) return;

    // Story 15.3 (AC #5): Build a unified `a11yTree` facade that exposes both
    // the instance methods (classifyRef, getSnapshotMap, refreshPrecomputed, …)
    // AND the static diff/format methods (diffSnapshots, formatDomDiff), so
    // the Pro-Repo can drive the full 3-stage analysis through a single
    // `context.a11yTree` object. The legacy `a11yTreeDiffs` field is kept
    // for backward compatibility.
    const a11yTreeFacade = {
      classifyRef: (ref: string) => a11yTree.classifyRef(ref),
      getSnapshotMap: () => a11yTree.getSnapshotMap(),
      getCompactSnapshot: (maxTokens?: number) => a11yTree.getCompactSnapshot(maxTokens),
      refreshPrecomputed: (client: CdpClient, sessionId: string, manager?: SessionManager) =>
        a11yTree.refreshPrecomputed(client, sessionId, manager),
      reset: () => a11yTree.reset(),
      get currentUrl(): string {
        return a11yTree.currentUrl;
      },
      diffSnapshots: A11yTreeProcessor.diffSnapshots,
      formatDomDiff: A11yTreeProcessor.formatDomDiff,
    };

    // M1 fix: Save the original `_meta` reference BEFORE invoking the hook.
    // If the hook returns a new `_meta` object, downstream code-paths would
    // otherwise mutate a detached object (response_bytes, estimated_tokens,
    // suggestion injection all assume `result._meta` is the original reference).
    const originalMeta = result._meta;

    const enhanced = await hooks.onToolResult(name, result, {
      a11yTree: a11yTreeFacade,
      a11yTreeDiffs: A11yTreeProcessor,
      waitForAXChange: this._waitForAXChange ?? undefined,
      cdpClient: this.cdpClient,
      sessionId: this._sessionId,
      sessionManager: this._sessionManager,
    });

    // Merge enhanced fields into the original result object so the `_meta`
    // reference stays stable for downstream mutations. If the hook returned
    // a new object (enhanced !== result), we still Object.assign to copy the
    // content, then restore the original _meta reference.
    if (enhanced && enhanced !== result) {
      Object.assign(result, enhanced);
      result._meta = originalMeta;
    }
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

    // Session overlay: show status before tool, clear after (with elapsed time)
    const overlayBefore = async (name: string) => {
      await updateOverlayStatus(this.cdpClient, this._sessionId, getToolLabel(name));
    };
    const overlayAfter = async (elapsedMs?: number, meta?: Record<string, unknown>) => {
      if (elapsedMs !== undefined && elapsedMs > 0) setLastElapsed(elapsedMs);
      // Show click indicator at click position
      if (meta?.clickX !== undefined && meta?.clickY !== undefined) {
        showClickIndicator(this.cdpClient, this._sessionId, meta.clickX as number, meta.clickY as number);
      }
      await updateOverlayStatus(this.cdpClient, this._sessionId, "");
    };

    const wrap = <T>(fn: (params: T) => Promise<ToolResponse>, toolName?: string) => {
      const dialogWrapped = this._wrapWithDialogInjection(fn);
      if (!sessionDefaults) {
        // Story 12.1: Inject response_bytes even without sessionDefaults
        return async (params: T): Promise<ToolResponse> => {
          const name = toolName ?? "unknown";
          await overlayBefore(name);
          let elapsed: number | undefined;
          let meta: Record<string, unknown> | undefined;
          try {
            // Story 16.5: enhanceTool hook (Operator/Human Touch) — Pro-Repo
            // injiziert Callback-Funktionen in params. Sync-Hook.
            let effectiveParams = params;
            const enhanceHooks = getProHooks();
            const enhanced = enhanceHooks.enhanceTool?.(
              name,
              params as unknown as Record<string, unknown>,
            );
            if (enhanced) {
              effectiveParams = enhanced as unknown as T;
            }
            const result = await dialogWrapped(effectiveParams);
            elapsed = result._meta?.elapsedMs as number | undefined;
            meta = result._meta as Record<string, unknown> | undefined;
            // Story 15.3: Ambient Page Context — delegated to Pro-Repo via onToolResult hook
            await this._runOnToolResultHook(result, name);
            injectResponseBytes(result);
            return result;
          } finally {
            await overlayAfter(elapsed, meta);
          }
        };
      }
      return async (params: T): Promise<ToolResponse> => {
        const name = toolName ?? "unknown";
        await overlayBefore(name);
        let elapsed: number | undefined;
        let meta: Record<string, unknown> | undefined;
        try {
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
          let resolvedParams = sessionDefaults.resolveParams(name, params as unknown as Record<string, unknown>) as unknown as T;
          // Story 16.5: enhanceTool hook (Operator/Human Touch) — Pro-Repo
          // injiziert Callback-Funktionen in params. Sync-Hook, kein await.
          const enhanceHooks = getProHooks();
          const enhanced = enhanceHooks.enhanceTool?.(
            name,
            resolvedParams as unknown as Record<string, unknown>,
          );
          if (enhanced) {
            resolvedParams = enhanced as unknown as T;
          }
          const result = await dialogWrapped(resolvedParams);
          // Story 15.3: Ambient Page Context — delegated to Pro-Repo via onToolResult hook
          await this._runOnToolResultHook(result, name);
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
          elapsed = result._meta?.elapsedMs as number | undefined;
          meta = result._meta as Record<string, unknown> | undefined;
          return result;
        } finally {
          await overlayAfter(elapsed, meta);
        }
      };
    };

    // Story 15.2: Install the registerTool delegate so the Pro-Repo can
    // register extra MCP tools from within its `registerProTools` hook.
    // Must be set BEFORE `finalHooks.registerProTools?.(this)` is called.
    this._registerProToolDelegate = (name, description, schema, handler) => {
      // Register in the internal handlers map (for executeTool / run_plan)
      this._handlers.set(name, handler);
      // Story 16.4: Pro-Repo liefert JSON-Schema-Literale (kein zod).
      // MCP SDK erwartet Zod — konvertieren wir hier in der Free-Repo-Schicht.
      const zodShape = jsonSchemaToZodShape(schema);
      // Register with the MCP server (for tools/list). Reuse the same
      // `wrap()` closure as Free-Tools so Pro-Tools inherit the same
      // cross-cutting concerns (dialog injection, response_bytes,
      // session-defaults, overlay status).
      this.server.tool(
        name,
        description,
        zodShape,
        wrap(async (params) => handler(params as Record<string, unknown>), name),
      );
    };

    // Story 15.2: Let the Pro-Repo register its tools BEFORE the Free-Tools
    // so that `tools/list` is deterministic.
    //
    // AC #8: When the Pro-Repo does NOT call `registerProTools`, the Pro-only
    // tools (e.g. `inspect_element`) are simply NOT registered — they do not
    // appear in `tools/list` at all. If an LLM still attempts to invoke them,
    // the MCP server returns a standard "Unknown tool" error. This is cleaner
    // than maintaining a fake stub that clutters the tool list in the free tier.
    finalHooks.registerProTools?.(this);

    // Tool order matters for LLM selection (Positional Bias — BiasBusters
    // arXiv:2510.00307). High-priority workflow tools come first; evaluate
    // is deliberately last so it is NOT the default for text/element tasks.
    //
    // Order: orientation → reading → interaction → tab-mgmt → timing →
    //        visual → special → debug → meta → evaluate (last resort).

    // --- 1. Orientation ---
    this.server.tool(
      "virtual_desk",
      "PRIMARY orientation tool — call first in every new session, after reconnect, or when unsure. Lists all tabs with IDs, URLs, state. Use returned IDs with switch_tab(tab: '<id>') instead of opening duplicates via navigate. Cheap, call liberally.",
      {},
      wrap(this.wrapWithGate("virtual_desk", async (params) => {
        this._contextChecked = true;
        return virtualDeskHandler(
          params as unknown as VirtualDeskParams,
          this.cdpClient,
          this.sessionId,
          this._tabStateCache,
          this.connectionStatus,
        );
      }, finalHooks), "virtual_desk"),
    );

    // --- 2. Reading ---
    this.server.tool(
      "read_page",
      "PRIMARY tool for page understanding — call after navigate/switch_tab before any interaction. Returns accessibility tree with stable refs (e.g. 'e5') that you pass to click/type/fill_form. Use this to read visible text too — not evaluate/querySelector. Default filter:'interactive' hides static text; for cells/paragraphs/labels call read_page(ref: 'eN', filter: 'all'). ~10-30x cheaper than screenshot.",
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

    // --- 3. Interaction (click/type/fill_form/press_key/scroll) ---
    this.server.tool(
      "click",
      "Click an element by ref, CSS selector, or viewport coordinates. Dispatches real CDP mouse events (mouseMoved/mousePressed/mouseReleased). For canvas or pixel-precise targets, use x+y coordinates instead of ref. If the click opens a new tab, the response reports it automatically. The response already includes the DOM diff (NEW/REMOVED/CHANGED lines) — inspect those changes for success/failure signals instead of following up with evaluate to re-check state.",
      {
        ref: clickSchema.shape.ref,
        selector: clickSchema.shape.selector,
        text: clickSchema.shape.text,
        x: clickSchema.shape.x,
        y: clickSchema.shape.y,
      },
      wrap(async (params) => {
        return clickHandler(params as unknown as ClickParams, this.cdpClient, this.sessionId, this._sessionManager);
      }, "click"),
    );

    this.server.tool(
      "type",
      "Type text into an input field identified by ref or CSS selector. For multiple fields in the same form, prefer fill_form — it handles text inputs, <select>, checkbox, and radio in one round-trip and is more reliable than N separate type calls. For special keys (Enter, Escape, Tab, arrows) or shortcuts (Ctrl+K), use press_key instead.",
      {
        ref: typeSchema.shape.ref,
        selector: typeSchema.shape.selector,
        text: typeSchema.shape.text,
        clear: typeSchema.shape.clear,
      },
      wrap(async (params) => {
        return typeHandler(params as unknown as TypeParams, this.cdpClient, this.sessionId, this._sessionManager);
      }, "type"),
    );

    // Story 6.3: fill_form — fill complete forms with one call
    this.server.tool(
      "fill_form",
      "Fill a complete form with one call — the preferred way to submit any form with 2+ fields. Each field needs ref or CSS selector plus value. Supports text inputs, <select> (by value or visible label), checkboxes (boolean), and radio buttons. Use this INSTEAD of multiple type calls or evaluate-setting select.value: one round-trip, partial errors do not abort, each field reports its own status.",
      {
        fields: fillFormSchema.shape.fields,
      },
      wrap(async (params) => {
        return fillFormHandler(
          params as unknown as FillFormParams,
          this.cdpClient,
          this.sessionId,
          this._sessionManager,
        );
      }, "fill_form"),
    );

    // FR-C: press_key — real CDP keyboard events (not JS dispatchEvent)
    this.server.tool(
      "press_key",
      "Press a keyboard key or shortcut. Optionally focus an element first via ref/selector. Use for Enter, Escape, Tab, arrows, shortcuts (Ctrl+K).",
      {
        key: pressKeySchema.shape.key,
        ref: pressKeySchema.shape.ref,
        selector: pressKeySchema.shape.selector,
        modifiers: pressKeySchema.shape.modifiers,
      },
      wrap(async (params) => {
        return pressKeyHandler(params as unknown as PressKeyParams, this.cdpClient, this.sessionId, this._sessionManager);
      }, "press_key"),
    );

    // FR-F: scroll — scroll page or element into view
    this.server.tool(
      "scroll",
      "Scroll the page, a container, or an element into view. Use ref/selector to scroll an element into the viewport. Use container_ref/container_selector + direction to scroll inside a specific container (e.g. sidebar, modal body).",
      {
        ref: scrollSchema.shape.ref,
        selector: scrollSchema.shape.selector,
        container_ref: scrollSchema.shape.container_ref,
        container_selector: scrollSchema.shape.container_selector,
        direction: scrollSchema.shape.direction,
        amount: scrollSchema.shape.amount,
      },
      wrap(async (params) => {
        return scrollHandler(params as unknown as ScrollParams, this.cdpClient, this.sessionId, this._sessionManager);
      }, "scroll"),
    );

    // --- 4. Tab management (navigate/switch_tab/tab_status) ---
    this.server.tool(
      "navigate",
      "Navigate the ACTIVE tab to a URL (or action:'back'). Waits for settle. WARNING: overwrites the user's active tab — always call virtual_desk FIRST to check what's open; if the right tab exists, use switch_tab instead. First call per session is auto-redirected to virtual_desk.",
      {
        url: navigateSchema.shape.url,
        action: navigateSchema.shape.action,
        settle_ms: navigateSchema.shape.settle_ms,
      },
      wrap(async (params) => {
        // FR-H: If virtual_desk hasn't been called yet, run it instead of navigating.
        // This prevents overwriting the user's active tab blindly.
        if (!this._contextChecked) {
          this._contextChecked = true;
          const vdResult = await virtualDeskHandler(
            {} as VirtualDeskParams,
            this.cdpClient,
            this.sessionId,
            this._tabStateCache,
            this.connectionStatus,
          );
          const tabList = vdResult.content?.[0]?.type === "text" ? vdResult.content[0].text : "";
          return {
            content: [{ type: "text" as const, text: `Navigation blocked — virtual_desk was not called yet. Here are your open tabs:\n\n${tabList}\n\nUse switch_tab(tab: "<id>") to go to an existing tab, or call navigate again to open a new page.` }],
            _meta: { elapsedMs: vdResult._meta?.elapsedMs ?? 0, method: "navigate", intercepted: true },
          };
        }
        return navigateHandler(params as unknown as NavigateParams, this.cdpClient, this.sessionId);
      }, "navigate"),
    );

    this.server.tool(
      "switch_tab",
      "Open a new tab, switch to an existing tab by ID (from virtual_desk), or close a tab. Prefer 'open' over navigate when you don't want to touch the user's active tab.",
      {
        action: switchTabSchema.shape.action,
        url: switchTabSchema.shape.url,
        tab: switchTabSchema.shape.tab,
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
      "tab_status",
      "Active tab's cached URL/title/ready/errors for quick sanity checks mid-workflow ('did my click navigate?'). For tab discovery: use virtual_desk. For page content: use read_page.",
      {},
      wrap(async (params) => {
        this._contextChecked = true;
        return tabStatusHandler(
          params as unknown as TabStatusParams,
          this.cdpClient,
          this.sessionId,
          this._tabStateCache,
          this.connectionStatus,
        );
      }, "tab_status"),
    );

    // --- 5. Timing (wait_for/observe) ---
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

    // FR-009: observe — passively watch DOM changes
    this.server.tool(
      "observe",
      "Watch an element for changes over time — use this INSTEAD of writing MutationObserver/setInterval/setTimeout code in evaluate. Two modes: (1) collect — watch for 'duration' ms, return all text/attribute changes (e.g. collect 3 values that appear one after another). (2) until — wait for a condition, then optionally click immediately (e.g. click Capture when counter hits 8). Use click_first to trigger the action that causes changes (observer is set up BEFORE the click, so nothing is missed).",
      {
        selector: observeSchema.shape.selector,
        duration: observeSchema.shape.duration,
        until: observeSchema.shape.until,
        then_click: observeSchema.shape.then_click,
        click_first: observeSchema.shape.click_first,
        collect: observeSchema.shape.collect,
        interval: observeSchema.shape.interval,
        timeout: observeSchema.shape.timeout,
      },
      wrap(async (params) => {
        return observeHandler(params as unknown as ObserveParams, this.cdpClient, this.sessionId, this._sessionManager);
      }, "observe"),
    );

    // --- 6. Visual (screenshot/dom_snapshot — last resort for visual tasks) ---
    this.server.tool(
      "screenshot",
      "Capture a WebP image of the page (max 800px, <100KB). You CANNOT use screenshots as input for click/type — use read_page for element refs. Only use for visual verification, canvas pages, or explicit user requests. ~10-30x more tokens than read_page.",
      {
        full_page: screenshotSchema.shape.full_page,
        som: screenshotSchema.shape.som,
      },
      wrap(async (params) => {
        // Check for minimized window before taking screenshot
        const activeTarget = this._tabStateCache.activeTargetId;
        if (activeTarget) {
          try {
            const { bounds } = await this.cdpClient.send<{ windowId: number; bounds: { windowState: string } }>(
              "Browser.getWindowForTarget",
              { targetId: activeTarget },
            );
            if (bounds.windowState === "minimized") {
              return {
                content: [{ type: "text", text: "Warning: Window is minimized — screenshot may be empty or stale. Use switch_tab to bring the window to foreground first, or call Browser.setWindowBounds to restore it." }],
                isError: true,
                _meta: { elapsedMs: 0, method: "screenshot", windowMinimized: true },
              };
            }
          } catch {
            /* best-effort — proceed with screenshot */
          }
        }
        const result = await screenshotHandler(params as unknown as ScreenshotParams, this.cdpClient, this.sessionId, this._sessionManager);
        // Preventive hint: screenshots cannot drive click/type — steer back to read_page
        if (!result.isError && result.content?.length > 0) {
          const somHint = (params as unknown as ScreenshotParams).som
            ? " SoM labels match read_page refs — pass them to click/type directly."
            : " Add som: true to overlay numbered ref labels matching read_page.";
          result.content.push({ type: "text", text: `Reminder: screenshots cannot be used as input for click/type — you need refs from read_page for any interaction.${somHint}` });
        }
        return result;
      }, "screenshot"),
    );

    this.server.tool(
      "dom_snapshot",
      "Structured layout data: bounding boxes, computed styles, paint order, colors. Refs match read_page. Use ONLY for spatial questions read_page cannot answer (is A above B? what color?). For element discovery or text: use read_page. For pure visual verification: use screenshot.",
      {
        ref: domSnapshotSchema.shape.ref,
      },
      wrap(this.wrapWithGate("dom_snapshot", async (params) => {
        return domSnapshotHandler(params as unknown as DomSnapshotParams, this.cdpClient, this.sessionId, this._sessionManager);
      }, finalHooks), "dom_snapshot"),
    );

    // --- 7. Special interactions (handle_dialog/file_upload) ---
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

    // --- 8. Debugging (console_logs/network_monitor) ---
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

    // --- 9. Meta (configure_session/run_plan) ---
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

    this.server.tool(
      "run_plan",
      "Execute a sequential plan of tool steps server-side. Supports variables ($varName), conditions (if), saveAs, error strategies (abort/continue/screenshot), suspend/resume. Parallel tab execution via parallel: [{ tab, steps }] is a Pro-Feature - requires Pro license.",
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
          sessionManager: this._sessionManager,
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

    // --- 10. Last resort: evaluate (intentionally registered last so LLMs
    // don't default to it for text/element tasks — Positional Bias fix) ---
    this.server.tool(
      "evaluate",
      "Execute JavaScript in the browser page context and return the result. Use this to COMPUTE values or trigger side effects no other tool covers — NOT to discover elements. If you're using querySelector/getElementById/innerText to find interactive elements or read visible text, prefer read_page (stable refs survive DOM changes, selectors don't) or fill_form. Common anti-patterns that evaluate will detect and hint you about: DOM-queried buttons/inputs, .innerText/.textContent reads, .click()/.scrollIntoView(), Tests.*.toString() introspection. Scope is shared between calls — top-level const/let/class are auto-wrapped in IIFE. If/else blocks may return undefined — use ternary (a ? b : c) or explicit return.",
      {
        expression: evaluateSchema.shape.expression,
        await_promise: evaluateSchema.shape.await_promise,
      },
      wrap(async (params) => {
        return evaluateHandler(params as unknown as EvaluateParams, this.cdpClient, this.sessionId);
      }, "evaluate"),
    );

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
    this._handlers.set("observe", async (params, sessionIdOverride?) => {
      return observeHandler(params as unknown as ObserveParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._sessionManager);
    });
    this._handlers.set("click", async (params, sessionIdOverride?) => {
      return clickHandler(params as unknown as ClickParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._sessionManager);
    });
    this._handlers.set("type", async (params, sessionIdOverride?) => {
      return typeHandler(params as unknown as TypeParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._sessionManager);
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

    // Story 15.2 / H2: Clear the Pro-Tool registration delegate now that
    // `registerAll()` is done. Any subsequent `registerTool()` call (after
    // the setup phase) will throw — preventing non-deterministic late
    // registrations from corrupting `tools/list`.
    this._registerProToolDelegate = null;
  }
}
