import type { CdpClient } from "./cdp-client.js";
import { debug } from "./debug.js";

// --- Types ---

export interface DomWatcherOptions {
  debounceMs?: number; // Default: 500 — Wartezeit nach letzter Mutation
}

// --- DomWatcher ---

export class DomWatcher {
  private _cdpClient: CdpClient;
  private _sessionId: string;
  private _debounceMs: number;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _onRefreshCallback: (() => Promise<void>) | null = null;
  private _onInvalidateCallback: (() => void) | null = null;
  private _onMutationInvalidateCallback: (() => void) | null = null;
  private _refreshInProgress = false;

  // Story 13a.2: Accessibility.nodesUpdated — resolves pending waitForAXChange promises
  // Each entry: { resolve(changed), cancel() to clear timeout }
  private _axChangeWaiters: Array<{ resolve: (changed: boolean) => void; cancel: () => void }> = [];
  private _onNodesUpdated: ((params: unknown) => void) | null = null;

  // Bound callbacks for on/off
  private _onDocumentUpdated: ((params: unknown) => void) | null = null;
  private _onChildCountUpdated: ((params: unknown) => void) | null = null;
  private _onChildInserted: ((params: unknown) => void) | null = null;
  private _onChildRemoved: ((params: unknown) => void) | null = null;
  private _onFrameNavigated: ((params: unknown) => void) | null = null;

  constructor(cdpClient: CdpClient, sessionId: string, options?: DomWatcherOptions) {
    this._cdpClient = cdpClient;
    this._sessionId = sessionId;
    this._debounceMs = options?.debounceMs ?? 500;
  }

  /** Registriert den Callback der bei DOM-Aenderungen (nach Debounce) aufgerufen wird */
  onRefresh(callback: () => Promise<void>): void {
    this._onRefreshCallback = callback;
  }

  /** Registriert den Callback fuer sofortige Cache-Invalidierung (bei Navigation) */
  onInvalidate(callback: () => void): void {
    this._onInvalidateCallback = callback;
  }

  /** Registriert den Callback fuer sofortige Precomputed-Cache-Invalidierung bei DOM-Mutationen (BUG-010) */
  onMutationInvalidate(callback: () => void): void {
    this._onMutationInvalidateCallback = callback;
  }


  /**
   * Story 13a.2: Wait for Accessibility.nodesUpdated event within timeout.
   * Returns true if AX tree changed, false on timeout.
   */
  waitForAXChange(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this._axChangeWaiters = this._axChangeWaiters.filter((w) => w.resolve !== resolve);
          resolve(false);
        }
      }, timeoutMs);
      this._axChangeWaiters.push({
        resolve: (changed: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(changed); } },
        cancel: () => clearTimeout(timer),
      });
    });
  }

  /** Startet DOM-Beobachtung: DOM.enable + Event-Listener registrieren */
  async init(): Promise<void> {
    // DOM.enable ist idempotent — doppeltes Enable schadet nicht
    await this._cdpClient.send("DOM.enable", {}, this._sessionId);

    this._onDocumentUpdated = () => this._scheduleMutationRefresh();
    this._onChildCountUpdated = () => this._scheduleMutationRefresh();
    this._onChildInserted = () => this._scheduleMutationRefresh();
    this._onChildRemoved = () => this._scheduleMutationRefresh();
    this._onFrameNavigated = (params: unknown) => this._handleNavigation(params);

    // Story 13a.2: Subscribe to Accessibility.nodesUpdated for post-click detection
    this._onNodesUpdated = () => {
      debug("DomWatcher: Accessibility.nodesUpdated received");
      const waiters = [...this._axChangeWaiters];
      this._axChangeWaiters = [];
      for (const w of waiters) w.resolve(true);
    };

    this._cdpClient.on("DOM.documentUpdated", this._onDocumentUpdated, this._sessionId);
    this._cdpClient.on("DOM.childNodeCountUpdated", this._onChildCountUpdated, this._sessionId);
    this._cdpClient.on("DOM.childNodeInserted", this._onChildInserted, this._sessionId);
    this._cdpClient.on("DOM.childNodeRemoved", this._onChildRemoved, this._sessionId);
    this._cdpClient.on("Page.frameNavigated", this._onFrameNavigated, this._sessionId);
    this._cdpClient.on("Accessibility.nodesUpdated", this._onNodesUpdated, this._sessionId);

    debug("DomWatcher initialized on session %s", this._sessionId);
  }

  /** Stoppt Beobachtung und raeumt auf */
  detach(): void {
    // Cancel pending debounce timer
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    // Remove all event listeners
    if (this._onDocumentUpdated) {
      this._cdpClient.off("DOM.documentUpdated", this._onDocumentUpdated);
      this._onDocumentUpdated = null;
    }
    if (this._onChildCountUpdated) {
      this._cdpClient.off("DOM.childNodeCountUpdated", this._onChildCountUpdated);
      this._onChildCountUpdated = null;
    }
    if (this._onChildInserted) {
      this._cdpClient.off("DOM.childNodeInserted", this._onChildInserted);
      this._onChildInserted = null;
    }
    if (this._onChildRemoved) {
      this._cdpClient.off("DOM.childNodeRemoved", this._onChildRemoved);
      this._onChildRemoved = null;
    }
    if (this._onFrameNavigated) {
      this._cdpClient.off("Page.frameNavigated", this._onFrameNavigated);
      this._onFrameNavigated = null;
    }
    if (this._onNodesUpdated) {
      this._cdpClient.off("Accessibility.nodesUpdated", this._onNodesUpdated);
      this._onNodesUpdated = null;
    }

    // Story 13a.2: Resolve any pending AX change waiters as false (detach = no change)
    const waiters = [...this._axChangeWaiters];
    this._axChangeWaiters = [];
    for (const w of waiters) { w.cancel(); w.resolve(false); }

    // NICHT DOM.disable — andere Komponenten koennten es brauchen
    debug("DomWatcher detached");
  }

  /** Reconnect: neuer CdpClient, neue SessionId */
  async reinit(cdpClient: CdpClient, sessionId: string): Promise<void> {
    this.detach();
    this._cdpClient = cdpClient;
    this._sessionId = sessionId;
    await this.init();
  }

  /** Debounce-Handler: Wird bei jeder DOM-Mutation aufgerufen */
  private _scheduleMutationRefresh(): void {
    // H2 fix: Do NOT invalidate selector cache immediately on DOM mutations.
    // The debounced refresh will compute a new fingerprint, and any stale
    // cache entries will self-heal via fingerprint mismatch on next access.

    // BUG-010 fix: Immediately invalidate precomputed A11y-tree cache so the next
    // getTree() call fetches fresh data from CDP instead of serving stale cache.
    // This is idempotent and cheap (just nulls the cached nodes array).
    if (this._onMutationInvalidateCallback) {
      this._onMutationInvalidateCallback();
    }

    // Cancel existing timer
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    // Set new timer
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._executeRefresh();
    }, this._debounceMs);
    debug("DomWatcher: DOM mutation detected, scheduling refresh");
  }

  /** Navigation-Handler: Invalidiert Cache SOFORT (kein Debounce) */
  private _handleNavigation(params: unknown): void {
    const p = params as { frame?: { parentId?: string } };
    // Nur main-frame Navigation (parentId ist undefined/leer fuer main frame)
    if (p.frame?.parentId) return; // iframe navigation — ignorieren

    // Cancel pending debounce timer
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    // Cache sofort invalidieren
    if (this._onInvalidateCallback) {
      this._onInvalidateCallback();
    }

    debug("DomWatcher: main frame navigation detected, cache invalidated");

    // H2: Hintergrund-Refresh nach Navigation triggern (AC #4)
    // Kurzer Delay damit die neue Seite settlen kann
    this._scheduleMutationRefresh();
  }

  /** Fuehrt den Refresh-Callback aus (mit Guard gegen parallele Refreshes) */
  private async _executeRefresh(): Promise<void> {
    if (this._refreshInProgress) return; // letzter Refresh laeuft noch
    if (!this._onRefreshCallback) return;

    this._refreshInProgress = true;
    try {
      await this._onRefreshCallback();
    } catch {
      // silent — Hintergrund-Refresh soll Server nicht lahmlegen
      debug("DomWatcher: background refresh failed (ignored)");
    }
    this._refreshInProgress = false;
  }
}
