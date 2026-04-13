import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CdpClient } from "./cdp/cdp-client.js";
import type { SessionManager } from "./cdp/session-manager.js";
import type { DialogHandler } from "./cdp/dialog-handler.js";
import type { ConsoleCollector } from "./cdp/console-collector.js";
import type { NetworkCollector } from "./cdp/network-collector.js";
import type { IBrowserSession } from "./cdp/browser-session.js";
import type { TabStateCache } from "./cache/tab-state-cache.js";
import type { SessionDefaults as SessionDefaultsType } from "./cache/session-defaults.js";
import { SessionDefaults } from "./cache/session-defaults.js";
import { TabStateCache as TabStateCacheCtor } from "./cache/tab-state-cache.js";
import type { ToolResponse, ToolContentBlock, ExecuteToolOptions } from "./types.js";
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
import { networkMonitorSchema, networkMonitorHandler } from "./tools/network-monitor.js";
import type { NetworkMonitorParams } from "./tools/network-monitor.js";
import { configureSessionSchema, configureSessionHandler } from "./tools/configure-session.js";
import type { ConfigureSessionParams } from "./tools/configure-session.js";
import { pressKeySchema, pressKeyHandler } from "./tools/press-key.js";
import type { PressKeyParams } from "./tools/press-key.js";
import { scrollSchema, scrollHandler } from "./tools/scroll.js";
import type { ScrollParams } from "./tools/scroll.js";
import { observeSchema, observeHandler } from "./tools/observe.js";
import type { ObserveParams } from "./tools/observe.js";
import { dragSchema, dragHandler } from "./tools/drag.js";
import type { DragParams } from "./tools/drag.js";
import { updateOverlayStatus, getToolLabel, setLastElapsed, showClickIndicator } from "./overlay/session-overlay.js";
import { PlanStateStore } from "./plan/plan-state-store.js";
import type { LicenseStatus } from "./license/license-status.js";
import type { FreeTierConfig } from "./license/free-tier-config.js";
import { FreeTierLicenseStatus } from "./license/license-status.js";
import { loadFreeTierConfig } from "./license/free-tier-config.js";
import { z } from "zod";
import { getProHooks, registerProHooks, proFeatureError } from "./hooks/pro-hooks.js";
import type { ToolRegistryPublic } from "./hooks/pro-hooks.js";
import { createDefaultOnToolResult, drainPendingDiff } from "./hooks/default-on-tool-result.js";
import { a11yTree, A11yTreeProcessor } from "./cache/a11y-tree.js";
import { prefetchSlot } from "./cache/prefetch-slot.js";
import { deferredDiffSlot } from "./cache/deferred-diff-slot.js";
import { debug } from "./cdp/debug.js";

/**
 * Story 18.3 — Transition-Set fuer die schlanke Default-Tool-Liste.
 *
 * Dieses Array enthaelt genau die zehn Tools, die im Default-Modus ueber
 * `tools/list` exponiert werden. Die Reihenfolge entspricht der
 * Positional-Bias-optimierten Reihenfolge in `ToolRegistry.registerAll()`
 * (orientation → reading → interaction → navigation → timing → visual →
 * meta → evaluate). `evaluate` steht absichtlich als Letztes (Story 16.5,
 * BiasBusters arXiv:2510.00307).
 *
 * Extended-Tools (`press_key`, `scroll`, `switch_tab`, `tab_status`,
 * `observe`, `dom_snapshot`, `handle_dialog`, `file_upload`, `console_logs`,
 * `network_monitor`, `configure_session`) bleiben im internen
 * `_handlers`-Dispatcher erreichbar, damit `run_plan` sie weiter aufrufen
 * kann — sie werden nur in `tools/list` ausgeblendet.
 *
 * Opt-in: Wer das volle Set braucht, setzt `SILBERCUE_CHROME_FULL_TOOLS=true`.
 *
 * @see docs/friction-fixes.md#FR-035
 */
export const DEFAULT_TOOL_NAMES: readonly string[] = [
  "virtual_desk",
  "view_page",
  "click",
  "type",
  "fill_form",
  "navigate",
  "wait_for",
  "capture_image",
  "run_plan",
  "evaluate",
] as const;

/**
 * Story 18.3 — Set-Form des Default-Tool-Sets fuer O(1)-Lookups im
 * `maybeRegisterFreeMCPTool`-Gate in `registerAll()`.
 */
export const DEFAULT_TOOL_SET: ReadonlySet<string> = new Set(DEFAULT_TOOL_NAMES);

/**
 * Story 18.3 — Env-Var-Gate fuer den vollen Tool-Satz.
 *
 * Parst `SILBERCUE_CHROME_FULL_TOOLS` nach demselben Muster wie
 * `SILBERCUE_CHROME_HEADLESS` in `src/server.ts:27`: nur der exakte String
 * `"true"` aktiviert den Full-Set. `"false"`, unset oder andere Werte
 * bleiben im Default-Set.
 *
 * @returns `true` wenn der LLM den vollen 20-Tool-Satz sehen soll, sonst
 *          `false` (Default-Set mit zehn Tools).
 */
export function isFullToolsMode(): boolean {
  return process.env.SILBERCUE_CHROME_FULL_TOOLS === "true";
}

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

/**
 * Story 18.6 (FR-029): Hint-Text fuer den AJAX-Race-Fall nach click.
 *
 * Wenn ein Klick auf ein interaktives Element keinen DOM-Diff erzeugt hat,
 * ist die wahrscheinlichste Erklaerung, dass die Seite noch einen
 * asynchronen Request laufen laesst. Der LLM sieht sonst "No visible
 * changes" und wechselt auf `evaluate`-Workarounds. Dieser Hint zeigt einen
 * konkreten naechsten Schritt an.
 *
 * Wird per Streak-Detector nur einmal pro Session gezeigt (Pattern aus
 * FR-020 / BUG-018), damit der LLM bei echten No-Op-Clicks (disabled button)
 * den Muster-Anker nicht wegwirft.
 *
 * @see docs/friction-fixes.md#FR-029
 * @see docs/research/llm-tool-steering.md#Anti-Spiral Patterns
 */
const FR029_AJAX_RACE_HINT =
  "No visible changes yet — the page may still be loading (AJAX/SPA). Use wait_for(condition: 'network_idle') or call view_page again to check.";

export class ToolRegistry implements ToolRegistryPublic {
  private _handlers = new Map<string, (params: Record<string, unknown>, sessionIdOverride?: string) => Promise<ToolResponse>>();
  readonly planStateStore = new PlanStateStore();

  /**
   * Story 18.6 (FR-029): Per-Session-Flag fuer den AJAX-Race-Hint.
   *
   * Der Hint wird pro Session genau einmal angehaengt — ein zweiter Click
   * mit leerem Diff bekommt ihn nicht mehr (sonst wird er zum Rauschen und
   * der LLM ignoriert ihn bei echten No-Op-Clicks). Reset passiert via
   * `navigate`, `a11yTree.reset()`-Pfad und expliziten `configure_session`-
   * Call — identisch zum Pattern aus FR-020 (`tool-sequence.ts`).
   *
   * Key-Konvention: `sessionId` der aktuellen BrowserSession. Bei Tab-
   * Switch bekommt jede Session ihren eigenen Flag, weil `sessionId` sich
   * mit dem Tab aendert.
   */
  private _fr029HintShown = new Map<string, boolean>();

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

  private _licenseStatus: LicenseStatus;
  private _freeTierConfig: FreeTierConfig;

  // FR-H: Track whether the LLM has checked browser context before acting
  private _contextChecked = false;

  private _browserSession!: IBrowserSession;
  /** Legacy-constructor state pointer (test-only). Null in production. */
  private _legacyState: { cdpClient: CdpClient; sessionId: string } | null = null;

  /**
   * Lazy-launch architecture: all CDP-level state lives inside the
   * BrowserSession. The Registry holds only a reference and delegates
   * `cdpClient`, `sessionId`, collectors, etc. via getters so that the
   * internal wiring is automatically refreshed after a silent relaunch.
   *
   * ## Constructor overloads
   *
   * The primary signature takes an `IBrowserSession` — this is what
   * `startServer()` uses in production.
   *
   * A legacy signature (2nd arg = `CdpClient`, followed by the old
   * positional parameter list) is preserved for the registry test suite
   * (~80 instantiations). When the 2nd argument is detected as a raw
   * CdpClient, a synthetic `IBrowserSession` adapter is built internally
   * from the legacy parameters. This keeps the test surface stable while
   * still exercising the new wiring through the same constructor.
   */
  constructor(server: McpServer, browserSession: IBrowserSession, licenseStatus?: LicenseStatus, freeTierConfig?: FreeTierConfig);
  constructor(
    server: McpServer,
    cdpClient: CdpClient,
    sessionId: string,
    tabStateCache: TabStateCache,
    getConnectionStatus?: (() => unknown) | undefined,
    sessionManager?: SessionManager,
    dialogHandler?: DialogHandler,
    licenseStatus?: LicenseStatus,
    freeTierConfig?: FreeTierConfig,
    consoleCollector?: ConsoleCollector,
    networkCollector?: NetworkCollector,
    sessionDefaults?: SessionDefaultsType,
    waitForAXChange?: (timeoutMs: number) => Promise<boolean>,
  );
  constructor(
    private server: McpServer,
    browserSessionOrCdpClient: IBrowserSession | CdpClient,
    sessionIdOrLicense?: string | LicenseStatus,
    tabStateCacheOrFreeTier?: TabStateCache | FreeTierConfig,
    _getConnectionStatus?: unknown,
    sessionManager?: SessionManager,
    dialogHandler?: DialogHandler,
    licenseStatusLegacy?: LicenseStatus,
    freeTierConfigLegacy?: FreeTierConfig,
    consoleCollector?: ConsoleCollector,
    networkCollector?: NetworkCollector,
    sessionDefaults?: SessionDefaultsType,
    waitForAXChange?: (timeoutMs: number) => Promise<boolean>,
  ) {
    // Detect which constructor signature is being used: the new path
    // passes an IBrowserSession (which has an `ensureReady` method);
    // the legacy path passes a raw CdpClient.
    const looksLikeSession = (v: unknown): v is IBrowserSession =>
      !!v && typeof v === "object" && typeof (v as { ensureReady?: unknown }).ensureReady === "function";

    if (looksLikeSession(browserSessionOrCdpClient)) {
      // New signature: (server, session, licenseStatus?, freeTierConfig?)
      this._browserSession = browserSessionOrCdpClient;
      this._licenseStatus = (sessionIdOrLicense as LicenseStatus | undefined) ?? new FreeTierLicenseStatus();
      this._freeTierConfig = (tabStateCacheOrFreeTier as FreeTierConfig | undefined) ?? loadFreeTierConfig();
    } else {
      // Legacy signature (test-only): synthesise an IBrowserSession from
      // the old positional parameters. `ensureReady()` is a no-op so
      // tests that provide a raw CdpClient do not trip over the
      // lazy-launch gate.
      const legacyCdpClient = browserSessionOrCdpClient as CdpClient;
      const legacySessionId = (sessionIdOrLicense as string | undefined) ?? "test-session";
      const legacyTabCache =
        (tabStateCacheOrFreeTier as TabStateCache | undefined) ?? new TabStateCacheCtor({ ttlMs: 30_000 });
      const legacySessionDefaults = sessionDefaults ?? new SessionDefaults();
      // Mutable wrapper so `applyTabSwitch()` / legacy `updateClient()` can
      // update the returned getters.
      const legacyState = { cdpClient: legacyCdpClient, sessionId: legacySessionId };
      this._legacyState = legacyState;
      const session: IBrowserSession = {
        isReady: true,
        wasEverReady: true,
        get cdpClient() { return legacyState.cdpClient; },
        get sessionId() { return legacyState.sessionId; },
        headless: false,
        tabStateCache: legacyTabCache,
        sessionDefaults: legacySessionDefaults,
        sessionManager,
        dialogHandler,
        consoleCollector,
        networkCollector,
        domWatcher: undefined,
        ensureReady: async () => { /* legacy: no-op */ },
        consumeRelaunchNotice: () => null,
        waitForAXChange: waitForAXChange ?? (async () => false),
        applyTabSwitch: (newSessionId: string) => {
          legacyState.sessionId = newSessionId;
          // BUG-019: DialogHandler must follow the active session
          if (dialogHandler) {
            dialogHandler.reinit(legacyState.cdpClient, newSessionId);
          }
        },
        shutdown: async () => { /* legacy: no-op */ },
      };
      this._browserSession = session;
      this._licenseStatus = licenseStatusLegacy ?? new FreeTierLicenseStatus();
      this._freeTierConfig = freeTierConfigLegacy ?? loadFreeTierConfig();
    }
  }

  /** Lazy-resolved CdpClient — throws if ensureReady() has not run yet. */
  get cdpClient(): CdpClient {
    return this._browserSession.cdpClient;
  }

  get sessionId(): string {
    return this._browserSession.sessionId;
  }

  /** Story 16.4: Public getter fuer OOPIF SessionManager (ToolRegistryPublic). */
  get sessionManager(): SessionManager | undefined {
    return this._browserSession.sessionManager;
  }

  /** Access to the underlying BrowserSession (for server shutdown hooks). */
  get browserSession(): IBrowserSession {
    return this._browserSession;
  }

  // ── Legacy API (test-only, no-op in production) ─────────────────────
  //
  // These methods exist only because the registry test suite was written
  // against the pre-lazy-launch API and exercises direct
  // `updateClient()` / `updateSession()` / `connectionStatus` paths. In
  // production every tool wrapper goes through `browserSession.ensureReady()`
  // which handles reconnect internally, so these methods have no callers
  // outside of tests.

  /** @deprecated Test-only. In production BrowserSession manages sessions. */
  updateSession(sessionId: string): void {
    if (this._legacyState) {
      this._legacyState.sessionId = sessionId;
    } else {
      this._browserSession.applyTabSwitch(sessionId);
    }
  }

  /** @deprecated Test-only. In production BrowserSession manages the client. */
  updateClient(cdpClient: CdpClient, sessionId: string): void {
    if (this._legacyState) {
      this._legacyState.cdpClient = cdpClient;
      this._legacyState.sessionId = sessionId;
    }
    // Production path: BrowserSession re-wires itself on re-launch.
  }

  /**
   * @deprecated Test-only. Lazy-launch made the old "disconnected" state
   * invisible to tools (ensureReady recovers it transparently). Kept as a
   * constant "connected" for test compatibility.
   */
  get connectionStatus(): string {
    return "connected";
  }

  /**
   * Story 18.1: `options` ist optional und strikt opt-in. Bestehende
   * Call-Sites ohne 4. Parameter behalten das bisherige Verhalten. Wenn
   * `options.skipOnToolResultHook === true` ist, wird der Ambient-Context-
   * Pro-Hook nach dem Tool-Handler NICHT aufgerufen (`run_plan` nutzt das
   * fuer Zwischen-Steps). Siehe `docs/friction-fixes.md#FR-033`.
   */
  async executeTool(
    name: string,
    params: Record<string, unknown>,
    sessionIdOverride?: string,
    options?: ExecuteToolOptions,
  ): Promise<ToolResponse> {
    const handler = this._handlers.get(name);
    if (!handler) {
      const content: ToolContentBlock[] = [{ type: "text", text: `Unknown tool: ${name}` }];
      return {
        content,
        isError: true,
        _meta: { elapsedMs: 0, method: name, response_bytes: Buffer.byteLength(JSON.stringify(content), 'utf8') },
      };
    }

    // Story 18.6 review-fix H1: FR-029 streak-detector reset on session-
    // boundary tools. This lives in `executeTool()` (not only in the
    // `wrap()` closure) so that `run_plan` steps with
    // `configure_session` / `switch_tab` reset the streak consistently
    // with direct MCP calls. The `navigate` reset stays in
    // `_runOnToolResultHook` because it is co-located with the
    // `a11yTree.reset()` call and fires for both paths via the hook.
    //
    // Review-fix M3: `switch_tab` also resets so the hint map does not
    // accumulate stale entries when the caller jumps between tabs —
    // each fresh tab starts with a re-armed hint.
    if (name === "configure_session" || name === "switch_tab") {
      this._resetFr029Streak();
    }
    // Lazy-launch: ensure Chrome is reachable before the handler runs.
    // On a fresh session this triggers the first ChromeLauncher.connect().
    // On an established session with a lost connection, BrowserSession
    // runs its smart-retry policy. A hard launch failure propagates here
    // so the caller can return a proper error to the LLM.
    try {
      await this._browserSession.ensureReady();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errContent: ToolContentBlock[] = [
        { type: "text", text: `Chrome is not reachable: ${msg}. Check that Chrome is installed, or start Chrome manually with --remote-debugging-port=9222 and retry the tool call.` },
      ];
      return {
        content: errContent,
        isError: true,
        _meta: { elapsedMs: 0, method: name, response_bytes: Buffer.byteLength(JSON.stringify(errContent), 'utf8') },
      };
    }
    // Story 7.3: Track call and resolve session defaults for run_plan path
    // Skip trackCall/resolveParams for meta-tools (H2 fix)
    let resolvedParams = params;
    let suggestionText: string | undefined;
    const sessionDefaults = this._browserSession.sessionDefaults;
    if (sessionDefaults && name !== "configure_session") {
      sessionDefaults.trackCall(name, params);
      // H1 fix: Read suggestions immediately after trackCall (atomic with tracking)
      const suggestions = sessionDefaults.getSuggestions();
      if (suggestions.length > 0) {
        const s = suggestions[0];
        suggestionText = `${s.param} '${s.value}' wurde ${s.count}x verwendet — setze als Default mit configure_session`;
      }
      resolvedParams = sessionDefaults.resolveParams(name, params);
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
    // Story 20.1: Drain pending deferred diff BEFORE the handler runs.
    // If a previous click scheduled a background diff that has since
    // completed, we pick it up here and prepend it to this tool's response
    // after the handler finishes. Non-blocking — if the diff is not ready
    // yet, `drainPendingDiff()` returns null and we move on.
    const piggybackDiff = drainPendingDiff();

    const result = await handler(resolvedParams, sessionIdOverride);
    this._injectDialogNotifications(result);
    this._injectRelaunchNotice(result);

    // Story 20.1: Prepend the piggybacked diff as a leading content block
    // so the LLM sees it before the current tool's output.
    if (piggybackDiff) {
      result.content.unshift({ type: "text", text: piggybackDiff });
    }

    // Story 15.3: Ambient Page Context — delegated to Pro-Repo via onToolResult hook.
    // Story 18.1: `skipOnToolResultHook` erlaubt `run_plan`, den Ambient-Context
    // fuer Zwischen-Steps zu unterdruecken. Dialog-Notifications und
    // Relaunch-Notice laufen oben bewusst unabhaengig davon.
    await this._runOnToolResultHook(result, name, options?.skipOnToolResultHook === true);
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
      if (method === "view_page" || method === "dom_snapshot") {
        result._meta.estimated_tokens = Math.ceil(responseBytes / 4);
      }
    }
    // Story 18.5 / Story 20.1: Speculative Prefetch — fire-and-forget.
    //
    // Story 20.1: Click no longer triggers the prefetch — the
    // DeferredDiffSlot's background build already calls
    // refreshPrecomputed, which has the same cache-warming effect.
    // Only navigate triggers the speculative prefetch now.
    if (!result.isError && name === "navigate") {
      this._triggerSpeculativePrefetch();
    }
    return result;
  }

  /**
   * Story 18.5: Kicks off a background A11y-Tree build that warms the
   * precomputed cache so the next read_page can skip the CDP round-trip.
   * Fire-and-forget — must NEVER block the current tool response.
   *
   * Lifecycle rules (enforced by `PrefetchSlot`):
   *  - Exactly one slot per session — second trigger cancels the first
   *    via AbortController.
   *  - URL mismatch between schedule and completion → result dropped
   *    (the URL re-check inside `refreshPrecomputed` handles this).
   *  - Errors are absorbed (debug-log only, never surfaced to LLM).
   *
   * The method is sync (no `await`) — that is the contract from AC-1.
   * If the BrowserSession is not ready (legacy test path with no real
   * CDP client), the call is a silent no-op.
   *
   * @see _bmad-output/implementation-artifacts/18-5-speculative-prefetch-waehrend-llm-denkzeit.md
   */
  private _triggerSpeculativePrefetch(): void {
    // Defensive readiness check: in production `executeTool` has already
    // awaited `ensureReady()` so the getters below will not throw, but the
    // legacy test constructor builds a synthetic session whose CDP client
    // may be a `{}` stub. We never want a synthetic-session test to crash
    // through this path.
    if (!this._browserSession.isReady) return;
    let cdpClient;
    let sessionId: string;
    try {
      cdpClient = this._browserSession.cdpClient;
      sessionId = this._browserSession.sessionId;
    } catch {
      // Session getters throw if cdpClient/sessionId are not yet set —
      // skip the prefetch in that case (no LLM-visible error possible).
      return;
    }
    const sessionManager = this._browserSession.sessionManager;
    const expectedUrl = a11yTree.currentUrl;

    // Story 18.5 Task 3 / M1 review follow-up: fire-and-forget mit
    // EXPLIZITEM `.catch()`-Callsite. `PrefetchSlot.schedule()` absorbiert
    // bereits alle Fehler intern (AC-5), aber der explizite `.catch()` hier
    // ist Defense-in-Depth: wenn ein zukuenftiger Refactor das interne
    // Schlucken aufhebt, bleibt der `unhandledRejection`-Kanal clean.
    //
    // Story 18.5 L1: Der Build-Callback bekommt `expectedUrl` durchgereicht
    // und reicht ihn an `refreshPrecomputed` weiter — dort wird die URL als
    // aktiver Race-Guard genutzt (siehe `refreshPrecomputed`-Implementation).
    void prefetchSlot
      .schedule(
        async (signal: AbortSignal, slotExpectedUrl: string) => {
          if (signal.aborted) return;
          await a11yTree.refreshPrecomputed(
            cdpClient,
            sessionId,
            sessionManager,
            signal,
            slotExpectedUrl,
          );
        },
        sessionId,
        expectedUrl,
      )
      .catch((err: unknown) => {
        // Defense-in-depth: der Slot schluckt eigentlich alles.
        // Falls doch mal etwas durchkommt, debug-loggen und verwerfen —
        // aber NIEMALS an den LLM propagieren (AC-5).
        if (err instanceof Error && err.name === "AbortError") return;
        debug(
          "PrefetchSlot trigger leaked an error: %s",
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  /**
   * Inject the one-shot "we just silently relaunched Chrome" notice into
   * any tool response. The BrowserSession sets this flag after a failed
   * reconnect triggered a fresh launch, and we consume it here so the LLM
   * finds out via the next tool result (without spammy repetition).
   */
  private _injectRelaunchNotice(result: ToolResponse): void {
    const notice = this._browserSession.consumeRelaunchNotice();
    if (notice) {
      result.content.push({ type: "text", text: notice });
    }
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
  private async _runOnToolResultHook(
    result: ToolResponse,
    name: string,
    skipHook = false,
  ): Promise<void> {
    // FR-007: Navigate invalidates all refs — reset immediately so next
    // tool gets clear stale-error even if no hook is registered.
    //
    // Story 18.1: `reset()` laeuft BEWUSST vor dem `skipHook`-Check, damit
    // `run_plan` seine navigate-Zwischen-Steps sauber die Ref-Caches
    // invalidieren laesst, auch wenn der Ambient-Context-Hook uebersprungen
    // wird.
    //
    // Story 18.6 (FR-029): Der FR-029-Streak-Detector wird bei navigate
    // ebenfalls zurueckgesetzt — neue Seite, neuer Orientierungsbedarf fuer
    // den LLM. Identisch zum Muster aus FR-020 (`tool-sequence.ts`).
    if (name === "navigate") {
      a11yTree.reset();
      this._resetFr029Streak();
      // Story 20.1: Cancel any pending deferred diff — the page changed,
      // the old diff is stale.
      deferredDiffSlot.cancel();
    }

    if (result.isError) return;

    // Story 18.1: Bypass fuer `run_plan`-Zwischen-Steps. Platziert NACH dem
    // `isError`-Guard, damit Fehler-Semantik (AC-5) unveraendert bleibt.
    if (skipHook) return;

    const hooks = getProHooks();
    // Story 18.6 review-fix H2: FR-029 AJAX-race hint must fire in the
    // Free-Tier even when NO Pro-Hook (and no Free-Tier-default) is
    // registered. `registerAll()` always installs the default hook, but
    // legacy-test paths and bare registries bypass `registerAll()` —
    // without this early injection the hint would be dead code for the
    // Free-Tier assertion in AC-4. Placed BEFORE the hook early-return so
    // it covers both Free-Tier (no hook) and Pro-Tier (custom hook) paths.
    //
    // The hint is idempotent with the later injection that runs AFTER
    // the Pro-Hook merge: the streak-detector in `_maybeAppendFr029...`
    // guards against double-append, and the content-length check skips
    // the post-hook branch once the Pro-Hook added a diff block.
    if (!hooks.onToolResult) {
      this._maybeAppendFr029AjaxRaceHint(result, name);
      return;
    }

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
      getActiveRefs: () => a11yTree.getActiveRefs(),
    };

    // M1 fix: Save the original `_meta` reference BEFORE invoking the hook.
    // If the hook returns a new `_meta` object, downstream code-paths would
    // otherwise mutate a detached object (response_bytes, estimated_tokens,
    // suggestion injection all assume `result._meta` is the original reference).
    const originalMeta = result._meta;

    const enhanced = await hooks.onToolResult(name, result, {
      a11yTree: a11yTreeFacade,
      a11yTreeDiffs: A11yTreeProcessor,
      waitForAXChange: (ms: number) => this._browserSession.waitForAXChange(ms),
      cdpClient: this._browserSession.cdpClient,
      sessionId: this._browserSession.sessionId,
      sessionManager: this._browserSession.sessionManager,
    });

    // Merge enhanced fields into the original result object so the `_meta`
    // reference stays stable for downstream mutations. If the hook returned
    // a new object (enhanced !== result), we still Object.assign to copy the
    // content, then restore the original _meta reference.
    if (enhanced && enhanced !== result) {
      Object.assign(result, enhanced);
      result._meta = originalMeta;
    }

    // Story 18.6 (FR-029): AJAX-Race-Hint nach click mit leerem DOM-Diff.
    //
    // Platziert NACH dem Pro-Hook-Merge, damit der Hint nicht versehentlich
    // mit einem bereits existierenden Diff-Text kollidiert. Der Pro-Hook
    // (oder der Free-Tier-Default aus `createDefaultOnToolResult`) haengt
    // nur dann Content an, wenn `formatDomDiff` non-empty ist. Bleibt das
    // Content-Array exakt auf Laenge 1 (nur der originale "Clicked eX ..."-
    // Text), dann ist der Diff leer — genau der FR-029-Fall.
    //
    // Bedingungen:
    //  1. Tool ist `click` (nur dort macht der Hint Sinn — andere Tools
    //     haben eigene Feedback-Kanaele)
    //  2. Click lief auf ein als "clickable" oder "widget-state" klassi-
    //     fiziertes Element (elementClass aus `_meta`). Disabled-/Static-
    //     Clicks bekommen den Hint nicht — sie haben legitime No-Op-Results.
    //  3. Kein zusaetzlicher Text-Content-Block wurde vom Hook angehaengt
    //     (Content-Array hat genau 1 Text-Block).
    //  4. Streak-Detector: Hint wurde in dieser Session noch nicht gezeigt.
    //
    // @see docs/friction-fixes.md#FR-029
    this._maybeAppendFr029AjaxRaceHint(result, name);
  }

  /**
   * Story 18.6 (FR-029): Haenge den AJAX-Race-Hint an, wenn ein click auf
   * ein interaktives Element keinen sichtbaren DOM-Diff produziert hat.
   * Einmal pro Session — danach unterdrueckt der Streak-Detector weitere
   * Hints, damit der LLM bei echten No-Op-Clicks nicht abstumpft.
   *
   * @see docs/friction-fixes.md#FR-029
   */
  private _maybeAppendFr029AjaxRaceHint(
    result: ToolResponse,
    toolName: string,
  ): void {
    if (toolName !== "click") return;
    if (result.isError) return;

    const elementClass = (result._meta?.elementClass as string | undefined) ?? undefined;
    if (elementClass !== "clickable" && elementClass !== "widget-state") return;

    // Diff-leer-Check: genau ein Text-Block (der originale Click-Return-Text)
    // und keine weiteren Content-Bloecke vom Hook.
    const blocks = result.content ?? [];
    if (blocks.length !== 1) return;
    if (blocks[0]?.type !== "text") return;

    // Streak-Detector: einmal pro Session zeigen.
    let sessionKey: string;
    try {
      sessionKey = this._browserSession.sessionId;
    } catch {
      // Legacy-test path: kein BrowserSession-sessionId verfuegbar.
      sessionKey = "legacy-test-session";
    }
    if (this._fr029HintShown.get(sessionKey) === true) return;
    this._fr029HintShown.set(sessionKey, true);

    result.content.push({ type: "text", text: FR029_AJAX_RACE_HINT });
  }

  /**
   * Story 18.6 (FR-029): Reset des Streak-Detectors fuer eine Session.
   * Wird aufgerufen bei `configure_session`, `navigate` (ueber a11yTree.reset)
   * und bei Tab-Switch — identisch zum Muster aus FR-020.
   */
  private _resetFr029Streak(sessionId?: string): void {
    if (sessionId !== undefined) {
      this._fr029HintShown.delete(sessionId);
    } else {
      this._fr029HintShown.clear();
    }
  }

  /**
   * Story 18.1: Aggregations-Hook fuer `run_plan`.
   *
   * `run_plan` setzt `skipOnToolResultHook: true` auf alle Zwischen-Steps,
   * damit der Ambient-Context-Hook nicht pro Step feuert. Am Plan-Ende ruft
   * der Plan-Executor diese Methode genau einmal ueber das letzte Step-
   * Ergebnis auf, damit der LLM am Plan-Ende trotzdem DOM-Diff/Compact-
   * Snapshot des finalen Seitenzustands sieht.
   *
   * Verhaelt sich identisch zu `_runOnToolResultHook` ohne Bypass:
   *  - `a11yTree.reset()` auf navigate
   *  - `isError`-Guard bleibt
   *  - Pro-Hook wird mit vollem Kontext aufgerufen
   *
   * @see docs/friction-fixes.md#FR-033
   */
  async runAggregationHook(result: ToolResponse, toolName: string): Promise<void> {
    await this._runOnToolResultHook(result, toolName, false);
  }

  /**
   * Story 6.1: Inject pending dialog notifications into any tool response.
   * Called from both executeTool() (run_plan path) and server.tool() callbacks (direct MCP path).
   */
  private _injectDialogNotifications(result: ToolResponse): void {
    const dialogs = this._browserSession.dialogHandler?.consumeNotifications();
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

  /**
   * Registriert alle Free-Tools auf dem MCP-Server und befuellt den internen
   * `_handlers`-Dispatcher.
   *
   * Story 18.3 — Default-/Full-Tools-Modus: Ueber die Env-Var
   * `SILBERCUE_CHROME_FULL_TOOLS` laesst sich zwischen zwei
   * `tools/list`-Exporten waehlen:
   *
   * - **Default (unset oder `false`):** Nur die zehn Tools aus
   *   `DEFAULT_TOOL_NAMES` werden ueber `server.tool()` registriert
   *   (Transition-Set, Positional-Bias-optimiert). Das reduziert den
   *   Tool-Definition-Overhead im Prompt erheblich — siehe
   *   `docs/friction-fixes.md#FR-035`.
   * - **Full (`true`):** Alle 20 Free-Tools werden wie vor Story 18.3
   *   exponiert. Reihenfolge ist rueckwaerts-kompatibel.
   *
   * In beiden Modi bleibt der interne `_handlers`-Dispatcher vollstaendig,
   * damit `run_plan` weiterhin alle Extended-Tools aufrufen kann.
   * Pro-Tools (`registerProToolDelegate`) sind nicht vom Gate betroffen.
   */
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
          const gatedTools = ["dom_snapshot", "switch_tab", "virtual_desk", "observe", "console_logs", "network_monitor"];
          if (gatedTools.includes(toolName) && !licenseStatus.isPro()) {
            return { allowed: false };
          }
          return { allowed: true };
        },
      });
    }
    // FR-022 (P3 fix): Register the default Free-tier `onToolResult` hook
    // when no Pro-Repo override is present. This is the source of the
    // DOM-diff lines that the `click` tool description promises ("The
    // response already includes the DOM diff (NEW/REMOVED/CHANGED lines)").
    // The Pro-Repo can still register a richer hook before startServer();
    // we only fill the gap.
    const hooksAfterFeatureGate = getProHooks();
    if (!hooksAfterFeatureGate.onToolResult) {
      registerProHooks({
        ...hooksAfterFeatureGate,
        onToolResult: createDefaultOnToolResult(),
      });
    }
    // Re-read hooks after potential registration
    const finalHooks = getProHooks();

    // Story 6.1 (C1): All server.tool() callbacks are wrapped with dialog notification
    // injection so that pending dialogs reach the LLM regardless of call path
    // (direct MCP call vs executeTool/run_plan).
    // Story 7.3: Extended wrap to include session defaults tracking, resolution, and suggestion injection.
    // Lazy-launch: Additionally, every wrapped tool call starts with
    // `await this._browserSession.ensureReady()` — this triggers the Chrome
    // launch on the very first tool call and handles silent re-launch after
    // connection loss, all transparent to the individual tool handler.
    const browserSession = this._browserSession;
    const injectRelaunchNotice = (result: ToolResponse): void => {
      const notice = browserSession.consumeRelaunchNotice();
      if (notice) {
        result.content.push({ type: "text", text: notice });
      }
    };
    // Build a friendly launch-failure response so the LLM can react instead
    // of seeing an opaque exception in the MCP transport layer.
    const buildLaunchFailureResponse = (name: string, err: unknown): ToolResponse => {
      const msg = err instanceof Error ? err.message : String(err);
      const text = `Chrome is not reachable: ${msg}. Check that Chrome is installed, or start Chrome manually with --remote-debugging-port=9222 and retry the tool call.`;
      const content: ToolContentBlock[] = [{ type: "text", text }];
      return {
        content,
        isError: true,
        _meta: {
          elapsedMs: 0,
          method: name,
          response_bytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
        },
      };
    };
    // Story 12.1: Helper to inject response_bytes into _meta
    // Story 12.2: Also injects estimated_tokens for read_page and dom_snapshot
    const injectResponseBytes = (result: ToolResponse): void => {
      if (result._meta) {
        const responseBytes = Buffer.byteLength(JSON.stringify(result.content ?? []), 'utf8');
        result._meta.response_bytes = responseBytes;
        const method = result._meta.method;
        if (method === "view_page" || method === "dom_snapshot") {
          result._meta.estimated_tokens = Math.ceil(responseBytes / 4);
        }
      }
    };

    // Session overlay: show status before tool, clear after (with elapsed time)
    const overlayBefore = async (name: string) => {
      await updateOverlayStatus(browserSession.cdpClient, browserSession.sessionId, getToolLabel(name));
    };
    const overlayAfter = async (elapsedMs?: number, meta?: Record<string, unknown>) => {
      if (elapsedMs !== undefined && elapsedMs > 0) setLastElapsed(elapsedMs);
      // Show click indicator at click position
      if (meta?.clickX !== undefined && meta?.clickY !== undefined) {
        showClickIndicator(browserSession.cdpClient, browserSession.sessionId, meta.clickX as number, meta.clickY as number);
      }
      await updateOverlayStatus(browserSession.cdpClient, browserSession.sessionId, "");
    };

    const wrap = <T>(fn: (params: T) => Promise<ToolResponse>, toolName?: string) => {
      const dialogWrapped = this._wrapWithDialogInjection(fn);
      return async (params: T): Promise<ToolResponse> => {
        const name = toolName ?? "unknown";
        // Lazy-launch gate — triggers Chrome boot on first call, and handles
        // silent reconnect after established-session drops.
        try {
          await browserSession.ensureReady();
        } catch (err) {
          return buildLaunchFailureResponse(name, err);
        }

        const sessionDefaults = browserSession.sessionDefaults;
        await overlayBefore(name);
        let elapsed: number | undefined;
        let meta: Record<string, unknown> | undefined;
        try {
          // H2 fix: Skip trackCall/resolveParams for meta-tools
          if (name === "configure_session") {
            // Story 18.6 (FR-029): configure_session resettet den
            // AJAX-Race-Hint-Streak-Detector — der User hat explizit
            // Session-Defaults angefasst, neuer Kontext.
            this._resetFr029Streak();
            const result = await dialogWrapped(params);
            injectResponseBytes(result);
            injectRelaunchNotice(result);
            return result;
          }
          // Story 18.6 review-fix M3: switch_tab also resets the FR-029
          // streak-detector state. Without this reset the `_fr029HintShown`
          // map would accumulate stale per-session entries across long-
          // running sessions and every new tab would inherit a stale
          // "hint-already-shown" flag (or, depending on session-key
          // stability, leak memory indefinitely).
          if (name === "switch_tab") {
            this._resetFr029Streak();
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
          // Story 20.1 H3-Fix: Drain pending deferred diff BEFORE the
          // handler runs — mirrors the same logic in executeTool().
          // Without this, the direct MCP path (server.tool) would never
          // pick up deferred diffs from a previous click.
          const piggybackDiff = drainPendingDiff();

          const result = await dialogWrapped(resolvedParams);
          // Story 15.3: Ambient Page Context — delegated to Pro-Repo via onToolResult hook
          await this._runOnToolResultHook(result, name);

          // Story 20.1 H3-Fix: Prepend the piggybacked diff as a leading
          // content block so the LLM sees it before the current tool's output.
          if (piggybackDiff) {
            result.content.unshift({ type: "text", text: piggybackDiff });
          }

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
            if (method === "view_page" || method === "dom_snapshot") {
              result._meta.estimated_tokens = Math.ceil(responseBytes / 4);
            }
          }
          injectRelaunchNotice(result);
          elapsed = result._meta?.elapsedMs as number | undefined;
          meta = result._meta as Record<string, unknown> | undefined;
          return result;
        } finally {
          await overlayAfter(elapsed, meta);
        }
      };
    };

    // Story 18.3: Einmaliges Lesen der Env-Var entscheidet, ob der volle
    // Tool-Satz oder nur das schlanke Default-Set in `tools/list` landet.
    // Der Wert wird hier EINMALIG geflogen und bleibt fuer die gesamte
    // `registerAll()`-Phase stabil — keine Laufzeit-Umstellung mittendrin.
    //
    // Wichtig: Das gilt NUR fuer die MCP-seitige Registrierung
    // (`this.server.tool(...)`). Der interne `_handlers`-Dispatcher unten
    // wird unabhaengig vom Modus vollstaendig befuellt, damit `run_plan`
    // weiterhin Extended-Tools (`press_key`, `scroll`, `observe`, ...)
    // dispatchen kann — siehe AC-3 in der Story-Spec.
    //
    // Pro-Tools (z.B. `inspect_element`) laufen ueber den eigenen
    // `_registerProToolDelegate`-Pfad und sind von diesem Gate NICHT
    // betroffen. Das Pro-Repo hat keine eigene Vorstellung vom Default-Set
    // und wuerde sonst seine eigenen Tools verlieren.
    const fullToolsMode = isFullToolsMode();
    const maybeRegisterFreeMCPTool = (
      name: string,
      description: string,
      shape: Record<string, z.ZodTypeAny>,
      handler: (params: Record<string, unknown>) => Promise<ToolResponse>,
    ): void => {
      if (!fullToolsMode && !DEFAULT_TOOL_SET.has(name)) {
        return;
      }
      this.server.tool(name, description, shape, handler);
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
    maybeRegisterFreeMCPTool(
      "virtual_desk",
      "PRIMARY orientation tool — call first in every new session, after reconnect, or when unsure. Lists all tabs with IDs, URLs, state. Use returned IDs with switch_tab(tab: '<id>') instead of opening duplicates via navigate. Cheap, call liberally.",
      {},
      wrap(this.wrapWithGate("virtual_desk", async (params) => {
        this._contextChecked = true;
        return virtualDeskHandler(
          params as unknown as VirtualDeskParams,
          this.cdpClient,
          this.sessionId,
          this._browserSession.tabStateCache,
          undefined /* connectionStatus removed in lazy-launch refactor */,
        );
      }, finalHooks), "virtual_desk"),
    );

    // --- 2. Reading ---
    maybeRegisterFreeMCPTool(
      "view_page",
      "PRIMARY tool for seeing what's on the page — call after navigate/switch_tab before any interaction. Returns accessibility tree with stable refs (e.g. 'e5') that you pass to click/type/fill_form. Use this to read visible text too — not evaluate/querySelector. Default filter:'interactive' hides static text; for cells/paragraphs/labels call view_page(ref: 'eN', filter: 'all'). Under tight max_tokens, containers appear as `[eXX role, N items]` one-line summaries — call view_page(ref:'eXX', filter:'all') on that ref to expand the subtree. ~10-30x cheaper than capture_image.",
      {
        depth: readPageSchema.shape.depth,
        ref: readPageSchema.shape.ref,
        filter: readPageSchema.shape.filter,
        max_tokens: readPageSchema.shape.max_tokens,
      },
      wrap(async (params) => {
        return readPageHandler(params as unknown as ReadPageParams, this.cdpClient, this.sessionId, this._browserSession.sessionManager);
      }, "view_page"),
    );

    // --- 3. Interaction (click/type/fill_form/press_key/scroll) ---
    maybeRegisterFreeMCPTool(
      "click",
      "Click an element by ref, CSS selector, or viewport coordinates. Dispatches real CDP mouse events (mouseMoved/mousePressed/mouseReleased). For canvas or pixel-precise targets, use x+y coordinates instead of ref. If the click opens a new tab, the response reports it automatically. The response already includes the DOM diff (NEW/REMOVED/CHANGED lines) — inspect those changes for success/failure signals instead of following up with evaluate to re-check state. If click fails with a stale-ref error, call view_page for fresh refs and retry. Avoid evaluate(querySelector + .click()) as default recovery — it bypasses the CDP pointer chain and hides real bugs. (Legitimate exception: explicitly testing synthetic JS event plumbing.)",
      {
        ref: clickSchema.shape.ref,
        selector: clickSchema.shape.selector,
        text: clickSchema.shape.text,
        x: clickSchema.shape.x,
        y: clickSchema.shape.y,
        wait_for_diff: clickSchema.shape.wait_for_diff,
      },
      wrap(async (params) => {
        return clickHandler(params as unknown as ClickParams, this.cdpClient, this.sessionId, this._browserSession.sessionManager);
      }, "click"),
    );

    maybeRegisterFreeMCPTool(
      "type",
      "Type text into an input field identified by ref or CSS selector. For multiple fields in the same form, prefer fill_form — it handles text inputs, <select>, checkbox, and radio in one round-trip and is more reliable than N separate type calls. For special keys (Enter, Escape, Tab, arrows) or shortcuts (Ctrl+K), use press_key instead. On stale-ref errors, call view_page for fresh refs and retry. Avoid evaluate(element.value = ...) as default data-entry recovery — it bypasses framework listeners (React, Vue) and masks real failures. (Legitimate exception: tests explicitly targeting synthetic event plumbing.)",
      {
        ref: typeSchema.shape.ref,
        selector: typeSchema.shape.selector,
        text: typeSchema.shape.text,
        clear: typeSchema.shape.clear,
      },
      wrap(async (params) => {
        return typeHandler(params as unknown as TypeParams, this.cdpClient, this.sessionId, this._browserSession.sessionManager);
      }, "type"),
    );

    // Story 6.3: fill_form — fill complete forms with one call
    maybeRegisterFreeMCPTool(
      "fill_form",
      "Fill a complete form with one call — the preferred way to submit any form with 2+ fields. Each field needs ref or CSS selector plus value. Supports text inputs, <select> (by value or visible label), checkboxes (boolean), and radio buttons. Use this INSTEAD of multiple type calls or evaluate-setting select.value: one round-trip, partial errors do not abort, each field reports its own status. On per-field errors, call view_page and retry the failing fields — DO NOT escape to evaluate(querySelector) to patch individual fields; it bypasses framework state management (React, Vue) and hides real bugs.",
      {
        fields: fillFormSchema.shape.fields,
      },
      wrap(async (params) => {
        return fillFormHandler(
          params as unknown as FillFormParams,
          this.cdpClient,
          this.sessionId,
          this._browserSession.sessionManager,
        );
      }, "fill_form"),
    );

    // FR-C: press_key — real CDP keyboard events (not JS dispatchEvent)
    maybeRegisterFreeMCPTool(
      "press_key",
      "Press a keyboard key or shortcut. Optionally focus an element first via ref/selector. Use for Enter, Escape, Tab, arrows, shortcuts (Ctrl+K).",
      {
        key: pressKeySchema.shape.key,
        ref: pressKeySchema.shape.ref,
        selector: pressKeySchema.shape.selector,
        modifiers: pressKeySchema.shape.modifiers,
      },
      wrap(async (params) => {
        return pressKeyHandler(params as unknown as PressKeyParams, this.cdpClient, this.sessionId, this._browserSession.sessionManager);
      }, "press_key"),
    );

    // FR-F: scroll — scroll page or element into view
    maybeRegisterFreeMCPTool(
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
        return scrollHandler(params as unknown as ScrollParams, this.cdpClient, this.sessionId, this._browserSession.sessionManager);
      }, "scroll"),
    );

    // Story 18.6 (FR-028): drag — native CDP Drag&Drop Primitive.
    //
    // ABSICHTLICH NICHT im Default-Set (DEFAULT_TOOL_NAMES). Drag ist
    // eine Nische-Operation (Kanban-Boards, Slider-Thumbs, Reorder-Listen),
    // die Tool-Definition-Overhead-Kosten stehen im Default-Set in keinem
    // Verhaeltnis zur Nutzungsfrequenz. Wird nur registriert wenn
    // `SILBERCUE_CHROME_FULL_TOOLS=true` gesetzt ist — der interne
    // `_handlers`-Dispatcher unten haelt den Handler aber unabhaengig
    // vom Modus bereit, damit `run_plan` das Tool weiterhin aufrufen kann.
    //
    // @see docs/friction-fixes.md#FR-028
    maybeRegisterFreeMCPTool(
      "drag",
      "Drag an element via native CDP mouse events (mousePressed → interpolated mouseMoved with buttons:1 → mouseReleased). Works for CSS-driven drag: slider thumbs, resize handles, text selection, mouse-based reorder lists (e.g. SortableJS in mouse mode). NOT suitable for HTML5 Drag&Drop API (draggable=true elements with dragstart/drop listeners, React DnD HTML5Backend, Vuedraggable, ng2-dnd) — that path needs Input.dispatchDragEvent which this tool does not implement. Parameters: from_ref/from_selector OR from_x+from_y as source, to_ref/to_selector OR to_x+to_y as target. `steps` (default 10, min 5) controls mouseMoved granularity.",
      {
        from_ref: dragSchema.shape.from_ref,
        from_selector: dragSchema.shape.from_selector,
        from_x: dragSchema.shape.from_x,
        from_y: dragSchema.shape.from_y,
        to_ref: dragSchema.shape.to_ref,
        to_selector: dragSchema.shape.to_selector,
        to_x: dragSchema.shape.to_x,
        to_y: dragSchema.shape.to_y,
        steps: dragSchema.shape.steps,
      },
      wrap(async (params) => {
        return dragHandler(params as unknown as DragParams, this.cdpClient, this.sessionId, this._browserSession.sessionManager);
      }, "drag"),
    );

    // --- 4. Tab management (navigate/switch_tab/tab_status) ---
    maybeRegisterFreeMCPTool(
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
            this._browserSession.tabStateCache,
            undefined /* connectionStatus removed in lazy-launch refactor */,
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

    maybeRegisterFreeMCPTool(
      "switch_tab",
      "Open a new tab, switch to an existing tab by ID (from virtual_desk), or close a tab. Prefer 'open' over navigate when you don't want to touch the user's active tab. After switching, refs from the previous tab are invalid — call view_page FIRST to get fresh refs before click/type/fill_form. DO NOT try to reuse old refs via evaluate(querySelector) as a shortcut.",
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
          this._browserSession.tabStateCache,
          (newSessionId) => {
            this._browserSession.applyTabSwitch(newSessionId);
          },
          this._browserSession.sessionManager,
        );
      }, finalHooks), "switch_tab"),
    );

    maybeRegisterFreeMCPTool(
      "tab_status",
      "Active tab's cached URL/title/ready/errors for quick sanity checks mid-workflow ('did my click navigate?'). For tab discovery: use virtual_desk. For page content: use view_page.",
      {},
      wrap(async (params) => {
        this._contextChecked = true;
        return tabStatusHandler(
          params as unknown as TabStatusParams,
          this.cdpClient,
          this.sessionId,
          this._browserSession.tabStateCache,
          undefined /* connectionStatus removed in lazy-launch refactor */,
        );
      }, "tab_status"),
    );

    // --- 5. Timing (wait_for/observe) ---
    maybeRegisterFreeMCPTool(
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
    maybeRegisterFreeMCPTool(
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
        return observeHandler(params as unknown as ObserveParams, this.cdpClient, this.sessionId, this._browserSession.sessionManager);
      }, "observe"),
    );

    // --- 6. Visual (capture_image/dom_snapshot — last resort for visual tasks) ---
    maybeRegisterFreeMCPTool(
      "capture_image",
      "Capture a WebP image of the page (max 800px, <100KB). For reading page content (text, errors, forms, headings), use view_page — 10-30x cheaper. capture_image CANNOT drive click/type — only view_page returns usable element refs. Only use for pixel-level visual inspection, canvas pages, or explicit user requests.",
      {
        full_page: screenshotSchema.shape.full_page,
        som: screenshotSchema.shape.som,
      },
      wrap(async (params) => {
        // Check for minimized window before taking screenshot
        const activeTarget = this._browserSession.tabStateCache.activeTargetId;
        if (activeTarget) {
          try {
            const { bounds } = await this.cdpClient.send<{ windowId: number; bounds: { windowState: string } }>(
              "Browser.getWindowForTarget",
              { targetId: activeTarget },
            );
            if (bounds.windowState === "minimized") {
              return {
                content: [{ type: "text", text: "Warning: Window is minimized — capture_image may be empty or stale. Use switch_tab to bring the window to foreground first, or call Browser.setWindowBounds to restore it." }],
                isError: true,
                _meta: { elapsedMs: 0, method: "capture_image", windowMinimized: true },
              };
            }
          } catch {
            /* best-effort — proceed with screenshot */
          }
        }
        const result = await screenshotHandler(params as unknown as ScreenshotParams, this.cdpClient, this.sessionId, this._browserSession.sessionManager);
        // Preventive hint: capture_image cannot drive click/type — steer back to view_page
        if (!result.isError && result.content?.length > 0) {
          const somHint = (params as unknown as ScreenshotParams).som
            ? " SoM labels match view_page refs — pass them to click/type directly."
            : " Add som: true to overlay numbered ref labels matching view_page.";
          result.content.push({ type: "text", text: `Reminder: for page content use view_page — capture_image is for pixel-level inspection only.${somHint}` });
        }
        return result;
      }, "capture_image"),
    );

    maybeRegisterFreeMCPTool(
      "dom_snapshot",
      "Structured layout data: bounding boxes, computed styles, paint order, colors. Refs match view_page. Use ONLY for spatial questions view_page cannot answer (is A above B? what color?). For element discovery or text: use view_page. For pure visual verification: use capture_image.",
      {
        ref: domSnapshotSchema.shape.ref,
      },
      wrap(this.wrapWithGate("dom_snapshot", async (params) => {
        return domSnapshotHandler(params as unknown as DomSnapshotParams, this.cdpClient, this.sessionId, this._browserSession.sessionManager);
      }, finalHooks), "dom_snapshot"),
    );

    // --- 7. Special interactions (handle_dialog/file_upload) ---
    // Story 6.1: handle_dialog — configure dialog handling before triggering actions
    // H3 fix: Route through wrap for default-resolution and suggestion-injection
    //
    // Story 18.3 Review-Fix H1: Unbedingte Registrierung, unabhaengig davon, ob
    // der `dialogHandler` zum `registerAll()`-Zeitpunkt bereits existiert. Der
    // Collector wird lazy in `BrowserSession.ensureReady()` initialisiert (via
    // `_wireHelpers()`), also nach dem Start des Servers aber vor jedem echten
    // Tool-Call (der `wrap()`-Closure ruft `ensureReady()` vorher auf). Falls
    // der Handler trotzdem mit einem fehlenden Collector aufgerufen wird (z.B.
    // im Legacy-Test-Pfad ohne `dialogHandler`), liefern wir eine klare
    // Fehlermeldung statt ein Tool aus `tools/list` zu verbergen. Siehe
    // `docs/friction-fixes.md#FR-035` H1/H2.
    maybeRegisterFreeMCPTool(
      "handle_dialog",
      "Configure how the browser handles JavaScript dialogs (alerts, confirms, prompts). Pre-configure before triggering actions, or check dialog status.",
      {
        action: handleDialogSchema.shape.action,
        text: handleDialogSchema.shape.text,
      },
      wrap(async (params) => {
        const dialogHandler = this._browserSession.dialogHandler;
        if (!dialogHandler) {
          return {
            content: [{ type: "text", text: "handle_dialog unavailable: dialog handler not initialized. This usually means the browser session has not been started yet — retry after any other tool call (e.g. virtual_desk) triggers the Chrome connection." }],
            isError: true,
            _meta: { elapsedMs: 0, method: "handle_dialog" },
          };
        }
        return handleDialogHandler(params as unknown as HandleDialogParams, dialogHandler);
      }, "handle_dialog"),
    );

    // Story 6.2: file_upload — upload files to file input elements
    maybeRegisterFreeMCPTool(
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
          this._browserSession.sessionManager,
        );
      }, "file_upload"),
    );

    // --- 8. Debugging (console_logs/network_monitor) ---
    // Story 7.1: console_logs — retrieve and filter console output
    //
    // Story 18.3 Review-Fix H1: Unbedingte Registrierung analog `handle_dialog`
    // oben. Der `consoleCollector` wird lazy in `BrowserSession.ensureReady()`
    // gesetzt; Runtime-Guard faengt den Legacy-Test-Pfad ab, in dem der
    // Collector nie initialisiert wird.
    maybeRegisterFreeMCPTool(
      "console_logs",
      "Retrieve collected browser console logs. Filter by level (info/warning/error/debug) and/or regex pattern. Optionally clear the buffer after reading.",
      {
        level: consoleLogsSchema.shape.level,
        pattern: consoleLogsSchema.shape.pattern,
        clear: consoleLogsSchema.shape.clear,
      },
      wrap(async (params) => {
        const collector = this._browserSession.consoleCollector;
        if (!collector) {
          return {
            content: [{ type: "text", text: "console_logs unavailable: console collector not initialized. This usually means the browser session has not been started yet — retry after any other tool call (e.g. virtual_desk) triggers the Chrome connection." }],
            isError: true,
            _meta: { elapsedMs: 0, method: "console_logs" },
          };
        }
        return consoleLogsHandler(params as unknown as ConsoleLogsParams, collector);
      }, "console_logs"),
    );

    // Story 7.2: network_monitor — start/stop/get network request monitoring
    //
    // Story 18.3 Review-Fix H1: Unbedingte Registrierung, Runtime-Guard
    // analog `console_logs`.
    maybeRegisterFreeMCPTool(
      "network_monitor",
      "Monitor network requests: start recording, retrieve recorded requests (with optional filter/pattern), or stop and return all collected data.",
      {
        action: networkMonitorSchema.shape.action,
        filter: networkMonitorSchema.shape.filter,
        pattern: networkMonitorSchema.shape.pattern,
      },
      wrap(async (params) => {
        const collector = this._browserSession.networkCollector;
        if (!collector) {
          return {
            content: [{ type: "text", text: "network_monitor unavailable: network collector not initialized. This usually means the browser session has not been started yet — retry after any other tool call (e.g. virtual_desk) triggers the Chrome connection." }],
            isError: true,
            _meta: { elapsedMs: 0, method: "network_monitor" },
          };
        }
        return networkMonitorHandler(params as unknown as NetworkMonitorParams, collector);
      }, "network_monitor"),
    );

    // --- 9. Meta (configure_session/run_plan) ---
    // Story 7.3: configure_session — set session defaults and auto-promote
    if (this._browserSession.sessionDefaults) {
      maybeRegisterFreeMCPTool(
        "configure_session",
        "View/set session defaults for recurring parameters (tab, timeout, etc.). Without params: show current defaults and auto-promote suggestions. With autoPromote: true: apply all suggestions.",
        {
          defaults: configureSessionSchema.shape.defaults,
          autoPromote: configureSessionSchema.shape.autoPromote,
        },
        wrap(async (params) => {
          return configureSessionHandler(params as unknown as ConfigureSessionParams, this._browserSession.sessionDefaults!);
        }, "configure_session"),
      );
    }

    maybeRegisterFreeMCPTool(
      "run_plan",
      "Execute a sequential plan of tool steps server-side. Supports variables ($varName), conditions (if), saveAs, error strategies (abort/continue/capture_image), suspend/resume. Parallel tab execution via parallel: [{ tab, steps }] is a Pro-Feature - requires Pro license.",
      {
        steps: runPlanSchema.shape.steps,
        parallel: runPlanSchema.shape.parallel,
        use_operator: runPlanSchema.shape.use_operator,
        resume: runPlanSchema.shape.resume,
      },
      wrap(async (params) => {
        const result = await runPlanHandler(params as unknown as RunPlanParams, this, {
          cdpClient: this.cdpClient,
          sessionId: this._browserSession.sessionId,
          sessionManager: this._browserSession.sessionManager,
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
    maybeRegisterFreeMCPTool(
      "evaluate",
      "Execute JavaScript in the browser page context. Good uses: computation, style mutations (.style.X = ..., classList.add), shadow-root traversal, app-specific side effects no dedicated tool covers. Bad uses: (1) automatic recovery after a click/type/fill_form failure — call view_page for fresh refs and retry instead; (2) CSS inspection via getComputedStyle/getBoundingClientRect — use inspect_element (returns computed styles, CSS rules with source:line, cascade, AND a visual clip screenshot in one call). For element discovery (querySelector/getElementById/innerText), prefer view_page or fill_form. Scope is shared between calls — top-level const/let/class are auto-wrapped in IIFE. If/else blocks may return undefined — use ternary (a ? b : c) or explicit return.",
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
    //
    // Story 18.3: `_handlers` bleibt IMMER vollstaendig, unabhaengig vom
    // Default-/Full-Tools-Modus. `run_plan` dispatcht ueber diesen Weg und
    // muss alle Tools erreichen, auch wenn `tools/list` sie verbirgt.
    // Konkret: Extended-Tools (`press_key`, `scroll`, `switch_tab`,
    // `tab_status`, `observe`, `dom_snapshot`, `handle_dialog`,
    // `file_upload`, `console_logs`, `network_monitor`, `configure_session`)
    // bleiben hier registriert, auch wenn `SILBERCUE_CHROME_FULL_TOOLS`
    // nicht gesetzt ist. Siehe `docs/friction-fixes.md#FR-035`.
    this._handlers.set("evaluate", async (params, sessionIdOverride?) => {
      return evaluateHandler(params as unknown as EvaluateParams, this.cdpClient, sessionIdOverride ?? this.sessionId);
    });
    this._handlers.set("navigate", async (params, sessionIdOverride?) => {
      return navigateHandler(params as unknown as NavigateParams, this.cdpClient, sessionIdOverride ?? this.sessionId);
    });
    this._handlers.set("view_page", async (params, sessionIdOverride?) => {
      return readPageHandler(params as unknown as ReadPageParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._browserSession.sessionManager);
    });
    this._handlers.set("capture_image", async (params, sessionIdOverride?) => {
      return screenshotHandler(params as unknown as ScreenshotParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._browserSession.sessionManager);
    });
    this._handlers.set("wait_for", async (params, sessionIdOverride?) => {
      return waitForHandler(params as unknown as WaitForParams, this.cdpClient, sessionIdOverride ?? this.sessionId);
    });
    this._handlers.set("observe", async (params, sessionIdOverride?) => {
      return observeHandler(params as unknown as ObserveParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._browserSession.sessionManager);
    });
    this._handlers.set("click", async (params, sessionIdOverride?) => {
      return clickHandler(params as unknown as ClickParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._browserSession.sessionManager);
    });
    this._handlers.set("type", async (params, sessionIdOverride?) => {
      return typeHandler(params as unknown as TypeParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._browserSession.sessionManager);
    });
    this._handlers.set("tab_status", async (params, sessionIdOverride?) => {
      return tabStatusHandler(
        params as unknown as TabStatusParams,
        this.cdpClient,
        sessionIdOverride ?? this.sessionId,
        this._browserSession.tabStateCache,
        undefined /* connectionStatus removed in lazy-launch refactor */,
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
          content: [{ type: "text", text: "switch_tab is not allowed in parallel plan groups — each group operates on its own tab" }],
          isError: true,
          _meta: { elapsedMs: 0, method: "switch_tab" },
        };
      }
      return switchTabHandler(
        params as unknown as SwitchTabParams,
        this.cdpClient,
        this.sessionId,
        this._browserSession.tabStateCache,
        (newSessionId) => {
          this._browserSession.applyTabSwitch(newSessionId);
        },
        this._browserSession.sessionManager,
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
        this._browserSession.tabStateCache,
        undefined /* connectionStatus removed in lazy-launch refactor */,
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
      return domSnapshotHandler(params as unknown as DomSnapshotParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._browserSession.sessionManager);
    });
    // Story 18.3 Review-Fix H2: Unbedingte Registrierung im _handlers-Map.
    // `executeTool()` / `run_plan` ruft `ensureReady()` vorher auf, das laesst
    // den Collector in `BrowserSession._wireHelpers()` lazy anlegen. Runtime-
    // Guard faengt den Legacy-Test-Pfad ab, in dem keine Collectors wiringt
    // werden — dort liefert der Handler einen sauberen `isError` statt
    // `Unknown tool`. Siehe `docs/friction-fixes.md#FR-035`.
    this._handlers.set("handle_dialog", async (params, _sessionIdOverride?) => {
      // C2 fix: accept sessionIdOverride for parallel-context compatibility
      const dialogHandler = this._browserSession.dialogHandler;
      if (!dialogHandler) {
        return {
          content: [{ type: "text", text: "handle_dialog unavailable: dialog handler not initialized." }],
          isError: true,
          _meta: { elapsedMs: 0, method: "handle_dialog" },
        };
      }
      return handleDialogHandler(params as unknown as HandleDialogParams, dialogHandler);
    });
    this._handlers.set("file_upload", async (params, sessionIdOverride?) => {
      return fileUploadHandler(
        params as unknown as FileUploadParams,
        this.cdpClient,
        sessionIdOverride ?? this.sessionId,
        this._browserSession.sessionManager,
      );
    });
    this._handlers.set("fill_form", async (params, sessionIdOverride?) => {
      return fillFormHandler(
        params as unknown as FillFormParams,
        this.cdpClient,
        sessionIdOverride ?? this.sessionId,
        this._browserSession.sessionManager,
      );
    });
    this._handlers.set("press_key", async (params, sessionIdOverride?) => {
      return pressKeyHandler(params as unknown as PressKeyParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._browserSession.sessionManager);
    });
    this._handlers.set("scroll", async (params, sessionIdOverride?) => {
      return scrollHandler(params as unknown as ScrollParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._browserSession.sessionManager);
    });
    // Story 18.6 (FR-028): drag bleibt im _handlers-Dispatcher vollstaendig
    // registriert, auch wenn es nicht im Default-Set ist — run_plan soll
    // das Tool weiter aufrufen koennen.
    this._handlers.set("drag", async (params, sessionIdOverride?) => {
      return dragHandler(params as unknown as DragParams, this.cdpClient, sessionIdOverride ?? this.sessionId, this._browserSession.sessionManager);
    });
    // Story 18.3 Review-Fix H2: Unbedingte Registrierung analog `handle_dialog`
    // oben. Runtime-Guard im Handler faengt den Fall "Collector noch nicht
    // initialisiert" ab (Legacy-Test-Pfad ohne ensureReady()-Wiring).
    this._handlers.set("console_logs", async (params) => {
      const collector = this._browserSession.consoleCollector;
      if (!collector) {
        return {
          content: [{ type: "text", text: "console_logs unavailable: console collector not initialized." }],
          isError: true,
          _meta: { elapsedMs: 0, method: "console_logs" },
        };
      }
      return consoleLogsHandler(params as unknown as ConsoleLogsParams, collector);
    });
    this._handlers.set("network_monitor", async (params) => {
      const collector = this._browserSession.networkCollector;
      if (!collector) {
        return {
          content: [{ type: "text", text: "network_monitor unavailable: network collector not initialized." }],
          isError: true,
          _meta: { elapsedMs: 0, method: "network_monitor" },
        };
      }
      return networkMonitorHandler(params as unknown as NetworkMonitorParams, collector);
    });
    if (this._browserSession.sessionDefaults) {
      this._handlers.set("configure_session", async (params) => {
        return configureSessionHandler(params as unknown as ConfigureSessionParams, this._browserSession.sessionDefaults!);
      });
    }

    // Story 15.2 / H2: Clear the Pro-Tool registration delegate now that
    // `registerAll()` is done. Any subsequent `registerTool()` call (after
    // the setup phase) will throw — preventing non-deterministic late
    // registrations from corrupting `tools/list`.
    this._registerProToolDelegate = null;
  }
}
