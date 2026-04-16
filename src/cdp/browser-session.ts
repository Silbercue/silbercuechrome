/**
 * BrowserSession — Lazy-Launch + smart-reconnect orchestrator.
 *
 * Centralises all browser-level state that used to live as free-standing
 * variables in `startServer()`. The key behavioural change versus the
 * previous eager-launch approach:
 *
 *   - The MCP server starts WITHOUT spawning a Chrome browser.
 *   - The first tool call that touches `cdpClient` triggers `ensureReady()`,
 *     which lazily launches Chrome (or connects to an existing one on port
 *     9222) and wires up all the CDP-backed helpers.
 *   - On connection loss, the next `ensureReady()` call uses a context-
 *     sensitive retry policy:
 *       * "Established session" (we had a working connection before):
 *         3 WebSocket-only retries at t = 0 / 250 / 750 ms, trying to
 *         reconnect to the same Chrome so the user keeps their tabs,
 *         logins, extensions, etc. If all three fail, we silently launch
 *         a fresh Chrome and set `_relaunchedAfterLoss` so the next tool
 *         result carries a short notice to the LLM.
 *       * "Fresh session" (first call after MCP startup, nothing running
 *         yet): 2 full-connect attempts at t = 0 / 400 ms, then the real
 *         launch error is surfaced to the caller.
 *
 * The class also guards against concurrent `ensureReady()` calls via a
 * cached in-flight promise (`_readyPromise`), so two parallel tool calls
 * that both arrive during a cold start do not trigger two Chrome launches.
 */

import { ChromeLauncher, type ChromeConnection } from "./chrome-launcher.js";
import { SessionManager } from "./session-manager.js";
import { DialogHandler } from "./dialog-handler.js";
import { ConsoleCollector } from "./console-collector.js";
import { NetworkCollector } from "./network-collector.js";
import { DownloadCollector } from "./download-collector.js";
import { DomWatcher } from "./dom-watcher.js";
import type { CdpClient } from "./cdp-client.js";
import { TabStateCache } from "../cache/tab-state-cache.js";
import { SessionDefaults } from "../cache/session-defaults.js";
import { a11yTree } from "../cache/a11y-tree.js";
import { selectorCache } from "../cache/selector-cache.js";
import {
  DEVICE_METRICS_OVERRIDE,
  EMULATED_WIDTH,
  EMULATED_HEIGHT,
  setHeadless,
} from "./emulation.js";
import { injectOverlay, removeOverlay } from "../overlay/session-overlay.js";
import { debug } from "./debug.js";

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/**
 * Public interface exposed to the ToolRegistry. Defined as a separate type
 * so unit tests can provide a minimal mock object without going through the
 * full Chrome-launch machinery.
 */
export interface IBrowserSession {
  readonly isReady: boolean;
  readonly wasEverReady: boolean;
  readonly cdpClient: CdpClient;
  readonly sessionId: string;
  readonly headless: boolean;
  readonly scriptMode: boolean;
  readonly tabStateCache: TabStateCache;
  readonly sessionDefaults: SessionDefaults;
  readonly sessionManager: SessionManager | undefined;
  readonly dialogHandler: DialogHandler | undefined;
  readonly consoleCollector: ConsoleCollector | undefined;
  readonly networkCollector: NetworkCollector | undefined;
  readonly downloadCollector: DownloadCollector | undefined;
  readonly domWatcher: DomWatcher | undefined;
  ensureReady(): Promise<void>;
  consumeRelaunchNotice(): string | null;
  waitForAXChange(timeoutMs: number): Promise<boolean>;
  /** Called by switch_tab when a new CDP session is attached on tab change. */
  applyTabSwitch(newSessionId: string): void;
  /**
   * Story 9.1: Check whether a target (tab) is owned by the MCP session.
   * In script mode, only MCP-owned tabs are visible to MCP tools.
   * In non-script mode, always returns true (all tabs are "owned").
   */
  isOwnedTarget(targetId: string): boolean;
  /**
   * Story 9.1: Register a newly created tab as MCP-owned.
   * Called by switch_tab(action: "open") to track tabs created via MCP.
   */
  trackOwnedTarget(targetId: string): void;
  /**
   * Story 9.1: Unregister a tab from MCP ownership tracking.
   * Called by switch_tab(action: "close") when an MCP tab is closed.
   */
  untrackOwnedTarget(targetId: string): void;
  /** CDP debugging port (default: 9222). Used by Script API for Escape Hatch WebSocket URLs. */
  readonly cdpPort: number;
  shutdown(): Promise<void>;
}

export interface BrowserSessionOptions {
  profilePath?: string;
  headless?: boolean;
  autoLaunch?: boolean;
  /**
   * Attach-only mode (Story 22.3): connect to existing Chrome without
   * auto-launch. In this mode, BrowserSession creates its own tab on
   * connect and closes it on shutdown/process-exit so it does not
   * interfere with the primary MCP session's tabs.
   */
  attachMode?: boolean;
  /**
   * Story 9.1: Script mode. When enabled, the MCP server uses set-based
   * ownership tracking to distinguish MCP-created tabs from externally
   * created tabs (e.g. Python Script API). MCP tools only operate on
   * owned tabs; external tabs are invisible to switch_tab, virtual_desk, etc.
   */
  scriptMode?: boolean;
  /**
   * CDP debugging port (default: 9222). Passed through to ChromeLauncher
   * and exposed via `cdpPort` for the Script API Escape Hatch.
   */
  cdpPort?: number;
  /** Retry timings in milliseconds — exposed for tests; see class-level doc. */
  retryTimings?: {
    establishedDelays?: number[]; // delays before attempts 2..N for established sessions
    freshDelays?: number[];       // delays before attempts 2..N for fresh sessions
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BrowserSession implements IBrowserSession {
  private readonly _launcher: ChromeLauncher;
  private readonly _options: BrowserSessionOptions;
  private readonly _establishedDelays: number[];
  private readonly _freshDelays: number[];
  private readonly _attachMode: boolean;
  private readonly _scriptMode: boolean;
  private readonly _cdpPort: number;

  /**
   * Story 9.1: Set of target IDs that were created by the MCP session.
   * In script mode, only these tabs are visible to MCP tools. External
   * tabs (created by Python scripts or other CDP clients) are ignored.
   */
  private readonly _ownedTargetIds = new Set<string>();

  // Connection state — null until the first ensureReady() succeeds.
  private _connection: ChromeConnection | null = null;
  private _cdpClient: CdpClient | null = null;
  private _sessionId: string | null = null;
  private _pageTargetId: string | null = null;

  /** Tab created by this session in attach mode — closed on shutdown. */
  private _ownedTabTargetId: string | null = null;
  /** Process exit handler for attach-mode tab cleanup. */
  private _attachExitHandler: (() => void) | null = null;

  // Persistent helpers — created once, re-wired on every (re)launch.
  public readonly tabStateCache: TabStateCache;
  public readonly sessionDefaults: SessionDefaults;
  private _sessionManager: SessionManager | null = null;
  private _dialogHandler: DialogHandler | null = null;
  private _consoleCollector: ConsoleCollector | null = null;
  private _networkCollector: NetworkCollector | null = null;
  private _downloadCollector: DownloadCollector | null = null;
  private _domWatcher: DomWatcher | null = null;

  // State flags for the retry policy and notice-on-loss behaviour.
  private _wasEverReady = false;
  private _relaunchedAfterLoss = false;
  private _readyPromise: Promise<void> | null = null;
  private _shutdownRequested = false;

  constructor(options: BrowserSessionOptions = {}) {
    this._options = options;
    this._attachMode = options.attachMode ?? false;
    this._scriptMode = options.scriptMode ?? false;
    this._cdpPort = options.cdpPort ?? 9222;
    this._launcher = new ChromeLauncher({
      profilePath: options.profilePath,
      headless: options.headless ?? false,
      autoLaunch: options.autoLaunch ?? true,
      port: this._cdpPort,
      // Disable the legacy background reconnect loop — BrowserSession runs
      // its own smart-retry policy on demand inside `ensureReady()` and two
      // parallel recovery paths would race against each other.
      autoReconnect: false,
    });
    this.tabStateCache = new TabStateCache({ ttlMs: 30_000 });
    this.sessionDefaults = new SessionDefaults();

    // Retry timings — defaults give ~750ms budget for established sessions
    // (3 attempts at t=0/250/750) and ~400ms for fresh ones (2 attempts).
    // Tests can inject shorter values for speed.
    this._establishedDelays = options.retryTimings?.establishedDelays ?? [0, 250, 500];
    this._freshDelays = options.retryTimings?.freshDelays ?? [0, 400];
  }

  // ── Public getters ──────────────────────────────────────────────────

  /** Whether a working CDP connection is currently held. */
  get isReady(): boolean {
    return (
      this._cdpClient !== null &&
      this._sessionId !== null &&
      this._connection?.status === "connected"
    );
  }

  /**
   * True iff this session has ever successfully launched/connected. Used by
   * the retry policy to pick the "established" vs. "fresh" branch.
   */
  get wasEverReady(): boolean {
    return this._wasEverReady;
  }

  get cdpClient(): CdpClient {
    if (!this._cdpClient) {
      throw new Error(
        "BrowserSession.cdpClient accessed before ensureReady() — this indicates a registry bug; all tool wrappers must await ensureReady() first.",
      );
    }
    return this._cdpClient;
  }

  get sessionId(): string {
    if (!this._sessionId) {
      throw new Error(
        "BrowserSession.sessionId accessed before ensureReady() — this indicates a registry bug; all tool wrappers must await ensureReady() first.",
      );
    }
    return this._sessionId;
  }

  get sessionManager(): SessionManager | undefined {
    return this._sessionManager ?? undefined;
  }

  get dialogHandler(): DialogHandler | undefined {
    return this._dialogHandler ?? undefined;
  }

  get consoleCollector(): ConsoleCollector | undefined {
    return this._consoleCollector ?? undefined;
  }

  get networkCollector(): NetworkCollector | undefined {
    return this._networkCollector ?? undefined;
  }

  get downloadCollector(): DownloadCollector | undefined {
    return this._downloadCollector ?? undefined;
  }

  get domWatcher(): DomWatcher | undefined {
    return this._domWatcher ?? undefined;
  }

  /** Current connection headedness — only meaningful after ensureReady(). */
  get headless(): boolean {
    return this._connection?.headless ?? this._options.headless ?? false;
  }

  /** Story 9.1: Whether script mode is active (external CDP clients expected). */
  get scriptMode(): boolean {
    return this._scriptMode;
  }

  /** Story 9.9: CDP debugging port for Escape Hatch WebSocket URLs. */
  get cdpPort(): number {
    return this._cdpPort;
  }

  /**
   * Story 9.1: Check whether a target is owned by the MCP session.
   * In non-script mode this always returns true (all tabs are "owned").
   */
  isOwnedTarget(targetId: string): boolean {
    if (!this._scriptMode) return true;
    return this._ownedTargetIds.has(targetId);
  }

  /** Story 9.1: Register a tab as MCP-owned. */
  trackOwnedTarget(targetId: string): void {
    this._ownedTargetIds.add(targetId);
  }

  /** Story 9.1: Unregister a tab from MCP ownership. */
  untrackOwnedTarget(targetId: string): void {
    this._ownedTargetIds.delete(targetId);
  }

  // ── Relaunch notice ─────────────────────────────────────────────────

  /**
   * Consume and clear the "relaunch-after-loss" flag. Returns a short
   * human-readable notice if we just silently relaunched Chrome because
   * the previous session could not be recovered; returns `null` otherwise.
   *
   * The ToolRegistry calls this after each tool-call and, if non-null,
   * appends the notice as an extra text block on the response so the LLM
   * knows its previous tab references are stale.
   */
  consumeRelaunchNotice(): string | null {
    if (!this._relaunchedAfterLoss) return null;
    this._relaunchedAfterLoss = false;
    return [
      "Note: Chrome was not reachable — SilbercueChrome silently launched a fresh browser.",
      "Previous tabs and references are gone. Call virtual_desk (Pro) or tab_status (Free) to re-orient.",
    ].join("\n");
  }

  // ── Lazy-launch entry point ─────────────────────────────────────────

  /**
   * Idempotent, race-safe launch-or-reconnect. Call this at the top of
   * every tool-wrapper before touching `cdpClient` / `sessionId`. On the
   * happy path it is a cheap boolean check.
   */
  async ensureReady(): Promise<void> {
    if (this._shutdownRequested) {
      throw new Error("BrowserSession has been shut down");
    }
    if (this.isReady) return;
    if (this._readyPromise) return this._readyPromise;

    this._readyPromise = this._doEnsureReady()
      .finally(() => {
        this._readyPromise = null;
      });
    return this._readyPromise;
  }

  private async _doEnsureReady(): Promise<void> {
    // Policy branch A — established session: try to reconnect to the SAME
    // Chrome (WebSocket-only, no auto-launch) so the user's tabs, cookies
    // and extensions survive a brief transport hiccup.
    if (this._wasEverReady) {
      // Clean up stale wiring before re-attempting — the old CdpClient
      // events and child-process references are dead by this point.
      await this._teardownConnectionOnly().catch(() => {});

      for (let i = 0; i < this._establishedDelays.length; i++) {
        if (this._establishedDelays[i] > 0) {
          await sleep(this._establishedDelays[i]);
        }
        try {
          const connection = await this._launcher.connectToExistingChrome();
          await this._wireUpFreshConnection(connection);
          debug("BrowserSession reconnect succeeded on attempt %d", i + 1);
          return;
        } catch (err) {
          debug(
            "BrowserSession reconnect attempt %d/%d failed: %s",
            i + 1,
            this._establishedDelays.length,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // All WebSocket-only attempts failed — the previous Chrome is really
      // gone. Silently launch a fresh one as a last-ditch recovery and set
      // the notice flag so the LLM finds out via the next tool response.
      debug("BrowserSession: all reconnects failed, launching fresh Chrome");
      await this._teardownHelpers().catch(() => {});
      const connection = await this._launcher.connect();
      await this._wireUpFreshConnection(connection);
      this._relaunchedAfterLoss = true;
      return;
    }

    // Policy branch B — fresh session: full connect (WebSocket first, then
    // auto-launch) with a single retry for flaky startup conditions. If
    // both attempts fail, the real launch error propagates so the caller
    // (the tool wrapper) can return a proper error to the LLM.
    let lastErr: unknown = null;
    for (let i = 0; i < this._freshDelays.length; i++) {
      if (this._freshDelays[i] > 0) {
        await sleep(this._freshDelays[i]);
      }
      try {
        const connection = await this._launcher.connect();
        await this._wireUpFreshConnection(connection);
        this._wasEverReady = true;
        debug("BrowserSession: fresh launch succeeded on attempt %d", i + 1);
        return;
      } catch (err) {
        lastErr = err;
        debug(
          "BrowserSession: fresh launch attempt %d/%d failed: %s",
          i + 1,
          this._freshDelays.length,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`BrowserSession launch failed: ${String(lastErr)}`);
  }

  // ── Connection wiring ───────────────────────────────────────────────

  /**
   * Everything that used to happen between `launcher.connect()` and the
   * end of `startServer()` for both the initial launch and the old
   * `onReconnect` path. Split into two phases so the helpers (which are
   * created exactly once) can be reinit-ed on a re-launch instead of
   * re-instantiated.
   */
  private async _wireUpFreshConnection(connection: ChromeConnection): Promise<void> {
    const cdpClient = connection.cdpClient;
    this._connection = connection;
    this._cdpClient = cdpClient;

    // Detected headless may differ from options.headless (auto-detected from
    // /json/version on the WebSocket path). Use the connection's value.
    setHeadless(connection.headless);

    // 1. Attach to a page target.
    //    In attach mode we ALWAYS create our own tab — the existing tabs
    //    belong to the primary MCP session (e.g. Claude Code).
    let pageTarget: TargetInfo;
    if (this._attachMode) {
      // M1-Fix: Close the previous owned tab before creating a new one
      // to prevent tab leaks on reconnect. Fire-and-forget is acceptable.
      if (this._ownedTabTargetId) {
        const staleTabId = this._ownedTabTargetId;
        this._ownedTabTargetId = null;
        try {
          await cdpClient.send("Target.closeTarget", { targetId: staleTabId });
        } catch {
          /* tab may already be closed — graceful */
        }
      }
      const { targetId } = await cdpClient.send<{ targetId: string }>(
        "Target.createTarget",
        { url: "about:blank" },
      );
      pageTarget = { targetId, type: "page", url: "about:blank" };
      this._ownedTabTargetId = targetId;
    } else {
      const { targetInfos } = await cdpClient.send<{ targetInfos: TargetInfo[] }>(
        "Target.getTargets",
      );
      const existing = targetInfos.find((t) => t.type === "page");
      if (existing) {
        pageTarget = existing;
      } else {
        const { targetId } = await cdpClient.send<{ targetId: string }>(
          "Target.createTarget",
          { url: "about:blank" },
        );
        pageTarget = { targetId, type: "page", url: "about:blank" };
      }
    }
    const { sessionId } = await cdpClient.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: pageTarget.targetId, flatten: true },
    );
    this._sessionId = sessionId;
    this._pageTargetId = pageTarget.targetId;

    // Story 9.1: Track the initial tab as MCP-owned. In script mode this
    // ensures the first tab is visible to MCP tools while externally
    // created tabs are ignored.
    if (this._scriptMode) {
      this._ownedTargetIds.add(pageTarget.targetId);
    }

    // 2. Activate CDP domains on the page session.
    await cdpClient.send("Runtime.enable", {}, sessionId);
    await cdpClient.send("Page.enable", {}, sessionId);
    await cdpClient.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
    await cdpClient.send("Accessibility.enable", {}, sessionId);
    // FR-025: Mask navigator.webdriver for WebSocket-attached Chrome (auto-launch
    // uses --disable-blink-features=AutomationControlled, but WS-attached Chrome
    // doesn't have that flag). Defense-in-depth: both layers together.
    await cdpClient.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true});",
    }, sessionId);
    // FR-025: Also apply immediately to current document (addScriptToEvaluateOnNewDocument
    // only covers future navigations and may not fire reliably in WebSocket mode).
    await cdpClient.send("Runtime.evaluate", {
      expression: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true});",
      awaitPromise: false,
    }, sessionId);
    // BUG-015: keep renderer alive when occluded (macOS)
    if (!connection.headless) {
      await cdpClient.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
    }
    if (connection.headless) {
      await cdpClient.send("Emulation.setDeviceMetricsOverride", DEVICE_METRICS_OVERRIDE, sessionId);
    } else {
      try {
        const { windowId } = await cdpClient.send<{ windowId: number }>(
          "Browser.getWindowForTarget",
          { targetId: pageTarget.targetId },
        );
        await cdpClient.send("Browser.setWindowBounds", {
          windowId,
          bounds: { width: EMULATED_WIDTH, height: EMULATED_HEIGHT + 85 },
        });
      } catch {
        await cdpClient.send("Emulation.setDeviceMetricsOverride", DEVICE_METRICS_OVERRIDE, sessionId);
      }
    }

    // 3. Inject the visual session overlay.
    await injectOverlay(cdpClient, sessionId);

    // 4. (Re-)wire the helpers.
    await this._wireHelpers(cdpClient, sessionId, pageTarget.targetId);

    // 5. Reset caches — a new connection means old refs are stale.
    a11yTree.invalidatePrecomputed();
    selectorCache.invalidate();

    // 6. Attach-mode: register process exit handler to close our owned tab.
    //    Uses the synchronous 'exit' event pattern (same as ChromeConnection).
    if (this._attachMode && this._ownedTabTargetId && !this._attachExitHandler) {
      this._attachExitHandler = () => {
        this._closeOwnedTabSync();
      };
      globalThis.process.on("exit", this._attachExitHandler);
    }
  }

  /**
   * Create-or-reinit all CDP-backed helpers. First call creates them,
   * subsequent calls use `reinit()` to swap in the new client/session.
   */
  private async _wireHelpers(cdpClient: CdpClient, sessionId: string, pageTargetId: string): Promise<void> {
    // TabStateCache: detach (if attached) and re-attach on the new client.
    this.tabStateCache.detachFromClient();
    this.tabStateCache.setActiveTarget(pageTargetId);
    this.tabStateCache.attachToClient(cdpClient, sessionId);

    // SessionManager
    if (!this._sessionManager) {
      this._sessionManager = new SessionManager(cdpClient, sessionId);
      this._sessionManager.onOopifDetach((detachedSessionId) => {
        a11yTree.removeNodesForSession(detachedSessionId);
      });
      void this._sessionManager.init();
    } else {
      void this._sessionManager.reinit(cdpClient, sessionId);
    }

    // DialogHandler
    if (!this._dialogHandler) {
      this._dialogHandler = new DialogHandler(cdpClient, sessionId);
      this._dialogHandler.init();
    } else {
      this._dialogHandler.reinit(cdpClient, sessionId);
    }

    // ConsoleCollector
    if (!this._consoleCollector) {
      this._consoleCollector = new ConsoleCollector(cdpClient, sessionId);
      this._consoleCollector.init();
    } else {
      this._consoleCollector.reinit(cdpClient, sessionId);
    }

    // NetworkCollector — not auto-started; stays dormant until a tool
    // explicitly calls network_monitor with action: "start".
    if (!this._networkCollector) {
      this._networkCollector = new NetworkCollector(cdpClient, sessionId);
    } else {
      this._networkCollector.reinit(cdpClient, sessionId);
    }

    // DownloadCollector — passively listens for Browser.download* events.
    // Uses browser-level CDP commands (no sessionId), similar to
    // Browser.getWindowForTarget / Browser.setWindowBounds above.
    // H1-Fix: await init()/reinit() so Browser.setDownloadBehavior is
    // active before ensureReady() returns — otherwise the first download
    // after connect could be missed.
    if (!this._downloadCollector) {
      this._downloadCollector = new DownloadCollector(cdpClient);
      await this._downloadCollector.init();
    } else {
      await this._downloadCollector.reinit(cdpClient);
    }

    // DomWatcher — callbacks reference `this`, so `this._cdpClient` /
    // `this._sessionId` are always the current values even after reinit.
    if (!this._domWatcher) {
      this._domWatcher = new DomWatcher(cdpClient, sessionId, { debounceMs: 500 });
      this._domWatcher.onRefresh(async () => {
        const client = this._cdpClient;
        const sid = this._sessionId;
        if (!client || !sid) return;
        await a11yTree.refreshPrecomputed(client, sid, this._sessionManager ?? undefined);
        const urlResult = await client.send<{ result: { value: string } }>(
          "Runtime.evaluate",
          { expression: "document.URL", returnByValue: true },
          sid,
        );
        const fp = selectorCache.computeFingerprint(urlResult.result.value, a11yTree.refCount);
        selectorCache.updateFingerprint(fp);
      });
      this._domWatcher.onInvalidate(() => {
        a11yTree.invalidatePrecomputed();
        selectorCache.invalidate();
      });
      this._domWatcher.onMutationInvalidate(() => {
        a11yTree.invalidatePrecomputed();
      });
      void this._domWatcher.init();
    } else {
      void this._domWatcher.reinit(cdpClient, sessionId);
    }
  }

  /**
   * Exposed for the ToolRegistry so it can pass a stable callback into
   * onReconnect-style hooks. Returns a function that forwards to whichever
   * DomWatcher instance is currently active.
   */
  waitForAXChange(timeoutMs: number): Promise<boolean> {
    return this._domWatcher?.waitForAXChange(timeoutMs) ?? Promise.resolve(false);
  }

  /**
   * Called by the switch_tab handler after a successful tab attach — the
   * new target has a different CDP session ID and the registry needs the
   * subsequent tool calls to use it.
   *
   * Re-wires the DialogHandler so it listens for Page.javascriptDialogOpening
   * on the NEW session — otherwise alerts on the new tab are never caught
   * and block all CDP calls until manual user intervention (BUG-019).
   */
  applyTabSwitch(newSessionId: string): void {
    this._sessionId = newSessionId;

    // BUG-019: DialogHandler must follow the active session, otherwise
    // alerts on a switched-to tab are never auto-dismissed.
    if (this._dialogHandler && this._cdpClient) {
      this._dialogHandler.reinit(this._cdpClient, newSessionId);
    }
  }

  // ── Teardown ────────────────────────────────────────────────────────

  /**
   * Tear down just the connection-level state (CdpClient, overlay, tab
   * cache wiring) — used as a pre-step when we know we are about to
   * re-launch and the previous ChromeConnection is dead anyway. Helpers
   * (SessionManager, collectors) are kept alive so `_wireHelpers()` can
   * `reinit()` them on the new client.
   */
  private async _teardownConnectionOnly(): Promise<void> {
    this.tabStateCache.detachFromClient();
    try {
      await this._connection?.close();
    } catch {
      /* already dead — ignore */
    }
    this._connection = null;
    this._cdpClient = null;
    this._sessionId = null;
    this._pageTargetId = null;
  }

  /**
   * Full teardown of helpers — used when we give up on the old connection
   * entirely and silently launch a fresh Chrome. The helpers will be
   * re-instantiated by `_wireHelpers()` on the new launch.
   */
  private async _teardownHelpers(): Promise<void> {
    try {
      this._domWatcher?.detach();
    } catch { /* best effort */ }
    try {
      this._networkCollector?.detach();
    } catch { /* best effort */ }
    try {
      this._downloadCollector?.detach();
      this._downloadCollector?.cleanup();
    } catch { /* best effort */ }
    try {
      this._consoleCollector?.detach();
    } catch { /* best effort */ }
    try {
      this._dialogHandler?.detach();
    } catch { /* best effort */ }
    try {
      this._sessionManager?.detach();
    } catch { /* best effort */ }
    this._domWatcher = null;
    this._networkCollector = null;
    this._downloadCollector = null;
    this._consoleCollector = null;
    this._dialogHandler = null;
    this._sessionManager = null;
  }

  // ── Attach-mode tab cleanup ─────────────────────────────────────────

  /**
   * Best-effort synchronous close of the tab we created in attach mode.
   * Called from the process 'exit' handler where we cannot await.
   * The CDP send is fire-and-forget (the process is exiting anyway).
   */
  private _closeOwnedTabSync(): void {
    if (!this._ownedTabTargetId || !this._cdpClient) return;
    try {
      // Fire-and-forget: process is exiting, we cannot await.
      void this._cdpClient.send("Target.closeTarget", {
        targetId: this._ownedTabTargetId,
      });
    } catch {
      /* tab may already be closed by user — graceful */
    }
    this._ownedTabTargetId = null;
  }

  /**
   * Async close of the owned attach-mode tab. Used during graceful
   * shutdown (SIGTERM/SIGINT) where we still have event-loop time.
   */
  private async _closeOwnedTabAsync(): Promise<void> {
    if (!this._ownedTabTargetId || !this._cdpClient) return;
    const targetId = this._ownedTabTargetId;
    this._ownedTabTargetId = null;
    try {
      await this._cdpClient.send("Target.closeTarget", { targetId });
    } catch {
      /* tab may already be closed by user — graceful */
    }
  }

  // ── Public shutdown (graceful SIGINT/SIGTERM) ───────────────────────

  async shutdown(): Promise<void> {
    if (this._shutdownRequested) return;
    this._shutdownRequested = true;

    // Attach-mode: close our owned tab before tearing down.
    if (this._attachMode) {
      await this._closeOwnedTabAsync();
      // Remove the process exit handler — shutdown is handling cleanup.
      if (this._attachExitHandler) {
        globalThis.process.removeListener("exit", this._attachExitHandler);
        this._attachExitHandler = null;
      }
    }

    if (this._cdpClient && this._sessionId) {
      try {
        await removeOverlay(this._cdpClient, this._sessionId);
      } catch { /* best effort */ }
    }
    await this._teardownHelpers();
    await this._teardownConnectionOnly();
  }
}
