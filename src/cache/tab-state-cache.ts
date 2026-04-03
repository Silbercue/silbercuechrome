import type { CdpClient } from "../cdp/cdp-client.js";

export interface TabState {
  url: string;
  title: string;
  domReady: boolean;
  consoleErrors: string[];
  loadingState: "loading" | "ready";
  lastUpdated: number;
}

export interface TabStateCacheOptions {
  ttlMs?: number;
  maxConsoleErrors?: number;
}

interface NavigationHistory {
  currentIndex: number;
  entries: { url: string; title: string }[];
}

interface RuntimeEvalResult {
  result: { value: string };
}

type EventCallback = (params: unknown, sessionId?: string) => void;

export class TabStateCache {
  private readonly _cache = new Map<string, TabState>();
  private readonly _pendingErrors = new Map<string, string[]>();
  private readonly _ttlMs: number;
  private readonly _maxConsoleErrors: number;
  private _activeTargetId: string | null = null;
  private _listeners: { method: string; callback: EventCallback }[] = [];
  private _cdpClient: CdpClient | null = null;

  constructor(options?: TabStateCacheOptions) {
    this._ttlMs = options?.ttlMs ?? 30_000;
    this._maxConsoleErrors = options?.maxConsoleErrors ?? 10;
  }

  get activeTargetId(): string | null {
    return this._activeTargetId;
  }

  setActiveTarget(targetId: string): void {
    this._activeTargetId = targetId;
  }

  get(targetId: string): TabState | null {
    const entry = this._cache.get(targetId);
    if (!entry) return null;
    if (Date.now() - entry.lastUpdated > this._ttlMs) return null;
    return entry;
  }

  set(targetId: string, state: Partial<TabState>): void {
    const existing = this._cache.get(targetId);
    if (existing) {
      this._cache.set(targetId, {
        ...existing,
        ...state,
        lastUpdated: Date.now(),
      });
    } else {
      this._cache.set(targetId, {
        url: "",
        title: "",
        domReady: false,
        consoleErrors: [],
        loadingState: "loading",
        ...state,
        lastUpdated: Date.now(),
      });
    }
  }

  invalidate(targetId: string): void {
    this._cache.delete(targetId);
  }

  invalidateAll(): void {
    this._cache.clear();
  }

  addConsoleError(targetId: string, error: string): void {
    const entry = this._cache.get(targetId);
    if (entry) {
      entry.consoleErrors.push(error);
      if (entry.consoleErrors.length > this._maxConsoleErrors) {
        entry.consoleErrors = entry.consoleErrors.slice(
          entry.consoleErrors.length - this._maxConsoleErrors,
        );
      }
    } else {
      // No full cache entry yet — buffer errors for later merge during CDP fetch
      let pending = this._pendingErrors.get(targetId);
      if (!pending) {
        pending = [];
        this._pendingErrors.set(targetId, pending);
      }
      pending.push(error);
      if (pending.length > this._maxConsoleErrors) {
        this._pendingErrors.set(
          targetId,
          pending.slice(pending.length - this._maxConsoleErrors),
        );
      }
    }
  }

  has(targetId: string): boolean {
    return this.get(targetId) !== null;
  }

  size(): number {
    return this._cache.size;
  }

  attachToClient(cdpClient: CdpClient, sessionId?: string): void {
    this._cdpClient = cdpClient;

    const onFrameNavigated: EventCallback = (params) => {
      const p = params as { frame: { id: string; url: string; parentId?: string } };
      if (!p.frame.parentId && this._activeTargetId) {
        const targetId = this._activeTargetId;
        this.invalidate(targetId);
        // H3: Auto-prefill cache after invalidation (fire-and-forget)
        this._fetchFromCdp(cdpClient, targetId, sessionId)
          .then((state) => this._cache.set(targetId, state))
          .catch(() => {
            /* prefill is best-effort */
          });
      }
    };

    const onNavigatedWithinDocument: EventCallback = () => {
      if (this._activeTargetId) {
        this.invalidate(this._activeTargetId);
      }
    };

    const onDomContentEventFired: EventCallback = () => {
      if (this._activeTargetId) {
        const existing = this._cache.get(this._activeTargetId);
        if (existing) {
          existing.domReady = true;
        }
      }
    };

    const onExceptionThrown: EventCallback = (params) => {
      const p = params as {
        exceptionDetails: { text: string; exception?: { description?: string } };
      };
      const msg = p.exceptionDetails.exception?.description || p.exceptionDetails.text;
      if (this._activeTargetId) {
        this.addConsoleError(this._activeTargetId, msg);
      }
    };

    cdpClient.on("Page.frameNavigated", onFrameNavigated, sessionId);
    cdpClient.on("Page.navigatedWithinDocument", onNavigatedWithinDocument, sessionId);
    cdpClient.on("Page.domContentEventFired", onDomContentEventFired, sessionId);
    cdpClient.on("Runtime.exceptionThrown", onExceptionThrown, sessionId);

    this._listeners = [
      { method: "Page.frameNavigated", callback: onFrameNavigated },
      { method: "Page.navigatedWithinDocument", callback: onNavigatedWithinDocument },
      { method: "Page.domContentEventFired", callback: onDomContentEventFired },
      { method: "Runtime.exceptionThrown", callback: onExceptionThrown },
    ];
  }

  detachFromClient(): void {
    if (this._cdpClient) {
      for (const { method, callback } of this._listeners) {
        this._cdpClient.off(method, callback);
      }
    }
    this._listeners = [];
    this._cdpClient = null;
  }

  async getOrFetch(
    cdpClient: CdpClient,
    targetId: string,
    sessionId?: string,
  ): Promise<{ state: TabState; cacheHit: boolean }> {
    const cached = this.get(targetId);
    if (cached) {
      return { state: cached, cacheHit: true };
    }

    const state = await this._fetchFromCdp(cdpClient, targetId, sessionId);
    this._cache.set(targetId, state);
    return { state, cacheHit: false };
  }

  private async _fetchFromCdp(
    cdpClient: CdpClient,
    targetId: string,
    sessionId?: string,
  ): Promise<TabState> {
    const [navHistory, readyState] = await Promise.all([
      cdpClient.send<NavigationHistory>("Page.getNavigationHistory", {}, sessionId),
      cdpClient.send<RuntimeEvalResult>(
        "Runtime.evaluate",
        { expression: "document.readyState", returnByValue: true },
        sessionId,
      ),
    ]);

    const currentEntry = navHistory.entries[navHistory.currentIndex];

    // Merge console errors: existing (stale) cache entry + pending (buffered) errors
    const existingErrors = this._cache.get(targetId)?.consoleErrors ?? [];
    const pendingErrors = this._pendingErrors.get(targetId) ?? [];
    const mergedErrors = [...existingErrors, ...pendingErrors];
    // Cap at maxConsoleErrors (keep most recent)
    const consoleErrors =
      mergedErrors.length > this._maxConsoleErrors
        ? mergedErrors.slice(mergedErrors.length - this._maxConsoleErrors)
        : mergedErrors;
    // H1: Consume pending errors — prevent memory leak
    this._pendingErrors.delete(targetId);

    return {
      url: currentEntry.url,
      title: currentEntry.title,
      domReady:
        readyState.result.value === "interactive" ||
        readyState.result.value === "complete",
      consoleErrors,
      loadingState: readyState.result.value === "complete" ? "ready" : "loading",
      lastUpdated: Date.now(),
    };
  }
}
