import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DomWatcher } from "./dom-watcher.js";
import type { CdpClient } from "./cdp-client.js";

// --- Mock debug ---

vi.mock("./debug.js", () => ({
  debug: vi.fn(),
}));

// --- Types ---

type EventCallback = (params: unknown, sessionId?: string) => void;

// --- Mock CDP client ---

interface MockCdpSetup {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
  onFn: ReturnType<typeof vi.fn>;
  offFn: ReturnType<typeof vi.fn>;
  listeners: Map<string, Set<{ callback: EventCallback; sessionId?: string }>>;
  fireEvent: (method: string, params: unknown) => void;
}

function createMockCdp(): MockCdpSetup {
  const listeners = new Map<string, Set<{ callback: EventCallback; sessionId?: string }>>();

  const sendFn = vi.fn(async () => ({}));

  const onFn = vi.fn((method: string, callback: EventCallback, sessionId?: string) => {
    let set = listeners.get(method);
    if (!set) {
      set = new Set();
      listeners.set(method, set);
    }
    set.add({ callback, sessionId });
  });

  const offFn = vi.fn((method: string, callback: EventCallback) => {
    const set = listeners.get(method);
    if (set) {
      for (const entry of set) {
        if (entry.callback === callback) {
          set.delete(entry);
          break;
        }
      }
    }
  });

  const fireEvent = (method: string, params: unknown) => {
    const set = listeners.get(method);
    if (set) {
      for (const entry of set) {
        entry.callback(params, entry.sessionId);
      }
    }
  };

  const cdpClient = {
    send: sendFn,
    on: onFn,
    once: vi.fn(),
    off: offFn,
  } as unknown as CdpClient;

  return { cdpClient, sendFn, onFn, offFn, listeners, fireEvent };
}

describe("DomWatcher", () => {
  let mock: MockCdpSetup;
  let watcher: DomWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    mock = createMockCdp();
    watcher = new DomWatcher(mock.cdpClient, "test-session", { debounceMs: 500 });
  });

  afterEach(() => {
    watcher.detach();
    vi.useRealTimers();
  });

  // --- init tests ---

  it("init() ruft DOM.enable auf", async () => {
    await watcher.init();

    expect(mock.sendFn).toHaveBeenCalledWith("DOM.enable", {}, "test-session");
  });

  it("init() registriert 4 DOM-Events und Page.frameNavigated", async () => {
    await watcher.init();

    const registeredEvents = [...mock.listeners.keys()];
    expect(registeredEvents).toContain("DOM.documentUpdated");
    expect(registeredEvents).toContain("DOM.childNodeCountUpdated");
    expect(registeredEvents).toContain("DOM.childNodeInserted");
    expect(registeredEvents).toContain("DOM.childNodeRemoved");
    expect(registeredEvents).toContain("Page.frameNavigated");
  });

  // --- DOM mutation events trigger debounce ---

  it("DOM.childNodeInserted triggert Debounce-Timer", async () => {
    const refreshFn = vi.fn().mockResolvedValue(undefined);
    watcher.onRefresh(refreshFn);
    await watcher.init();

    mock.fireEvent("DOM.childNodeInserted", { parentNodeId: 1, previousNodeId: 0, node: {} });

    // Should not fire immediately
    expect(refreshFn).not.toHaveBeenCalled();

    // After debounce
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("DOM.childNodeRemoved triggert Debounce-Timer", async () => {
    const refreshFn = vi.fn().mockResolvedValue(undefined);
    watcher.onRefresh(refreshFn);
    await watcher.init();

    mock.fireEvent("DOM.childNodeRemoved", { parentNodeId: 1, nodeId: 2 });

    await vi.advanceTimersByTimeAsync(500);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("DOM.childNodeCountUpdated triggert Debounce-Timer", async () => {
    const refreshFn = vi.fn().mockResolvedValue(undefined);
    watcher.onRefresh(refreshFn);
    await watcher.init();

    mock.fireEvent("DOM.childNodeCountUpdated", { nodeId: 1, childNodeCount: 5 });

    await vi.advanceTimersByTimeAsync(500);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("DOM.documentUpdated triggert Debounce-Timer", async () => {
    const refreshFn = vi.fn().mockResolvedValue(undefined);
    watcher.onRefresh(refreshFn);
    await watcher.init();

    mock.fireEvent("DOM.documentUpdated", {});

    await vi.advanceTimersByTimeAsync(500);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  // --- Debounce behavior ---

  it("Debounce: mehrere Mutations innerhalb 500ms fuehren zu genau einem Refresh", async () => {
    const refreshFn = vi.fn().mockResolvedValue(undefined);
    watcher.onRefresh(refreshFn);
    await watcher.init();

    // Fire multiple mutations within 500ms
    mock.fireEvent("DOM.childNodeInserted", {});
    await vi.advanceTimersByTimeAsync(100);
    mock.fireEvent("DOM.childNodeRemoved", {});
    await vi.advanceTimersByTimeAsync(100);
    mock.fireEvent("DOM.childNodeInserted", {});
    await vi.advanceTimersByTimeAsync(100);
    mock.fireEvent("DOM.childNodeCountUpdated", {});

    // Not fired yet (last event was at 300ms, debounce resets each time)
    expect(refreshFn).not.toHaveBeenCalled();

    // Wait full debounce from last event
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("Debounce: Refresh wird nach 500ms Ruhe ausgefuehrt", async () => {
    const refreshFn = vi.fn().mockResolvedValue(undefined);
    watcher.onRefresh(refreshFn);
    await watcher.init();

    mock.fireEvent("DOM.childNodeInserted", {});

    // At 250ms — not yet
    await vi.advanceTimersByTimeAsync(250);
    expect(refreshFn).not.toHaveBeenCalled();

    // At 500ms — fires
    await vi.advanceTimersByTimeAsync(250);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  // --- Navigation handling ---

  it("Page.frameNavigated (main frame) invalidiert sofort und triggert Hintergrund-Refresh nach Debounce", async () => {
    const refreshFn = vi.fn().mockResolvedValue(undefined);
    const invalidateFn = vi.fn();
    watcher.onRefresh(refreshFn);
    watcher.onInvalidate(invalidateFn);
    await watcher.init();

    // Main frame navigation — no parentId
    mock.fireEvent("Page.frameNavigated", { frame: { id: "main-frame" } });

    // Invalidate should fire immediately
    expect(invalidateFn).toHaveBeenCalledTimes(1);

    // Refresh should NOT fire immediately (debounced)
    expect(refreshFn).not.toHaveBeenCalled();

    // H2: After debounce period, background refresh should fire
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("Page.frameNavigated (iframe) wird ignoriert (parentId vorhanden)", async () => {
    const invalidateFn = vi.fn();
    watcher.onInvalidate(invalidateFn);
    await watcher.init();

    // Iframe navigation — has parentId
    mock.fireEvent("Page.frameNavigated", { frame: { id: "child-frame", parentId: "main-frame" } });

    // Invalidate should NOT fire
    expect(invalidateFn).not.toHaveBeenCalled();
  });

  it("Page.frameNavigated (main frame) cancelt pending Debounce-Timer und startet neuen", async () => {
    const refreshFn = vi.fn().mockResolvedValue(undefined);
    const invalidateFn = vi.fn();
    watcher.onRefresh(refreshFn);
    watcher.onInvalidate(invalidateFn);
    await watcher.init();

    // Trigger mutation (starts debounce timer)
    mock.fireEvent("DOM.childNodeInserted", {});
    await vi.advanceTimersByTimeAsync(200);

    // Navigation cancels old debounce timer and starts a new one (H2)
    mock.fireEvent("Page.frameNavigated", { frame: { id: "main-frame" } });
    expect(invalidateFn).toHaveBeenCalledTimes(1);

    // Old mutation refresh should not fire; instead the navigation-triggered refresh fires after debounce
    await vi.advanceTimersByTimeAsync(500);
    // Exactly one refresh call — from the navigation debounce, not from the old mutation
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  // --- Parallel refresh guard ---

  it("Paralleler Refresh: zweiter Trigger waehrend laufendem Refresh wird uebersprungen", async () => {
    let resolveRefresh: (() => void) | null = null;
    const refreshFn = vi.fn().mockImplementation(() => {
      return new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
    });
    watcher.onRefresh(refreshFn);
    await watcher.init();

    // First mutation — triggers debounce
    mock.fireEvent("DOM.childNodeInserted", {});
    await vi.advanceTimersByTimeAsync(500);

    // refreshFn called once but not resolved yet
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Second mutation while refresh is in progress
    mock.fireEvent("DOM.childNodeInserted", {});
    await vi.advanceTimersByTimeAsync(500);

    // _executeRefresh is called but skipped because _refreshInProgress=true
    // refreshFn should still only have been called once (the guard prevents the second call)
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Resolve the first refresh
    resolveRefresh!();
    await vi.advanceTimersByTimeAsync(0);
  });

  // --- detach ---

  it("detach() entfernt alle Event-Listener und cancelt Timer", async () => {
    const refreshFn = vi.fn().mockResolvedValue(undefined);
    watcher.onRefresh(refreshFn);
    await watcher.init();

    // Start a debounce timer
    mock.fireEvent("DOM.childNodeInserted", {});

    watcher.detach();

    // off should have been called for all 5 events
    expect(mock.offFn).toHaveBeenCalledTimes(5);

    // Timer should be cancelled — no refresh after debounce
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshFn).not.toHaveBeenCalled();
  });

  // --- reinit ---

  it("reinit() detacht alten und initialisiert neuen Client", async () => {
    await watcher.init();

    const mock2 = createMockCdp();
    await watcher.reinit(mock2.cdpClient, "new-session");

    // Old client should have been detached (off called 5 times)
    expect(mock.offFn).toHaveBeenCalledTimes(5);

    // New client should have DOM.enable called
    expect(mock2.sendFn).toHaveBeenCalledWith("DOM.enable", {}, "new-session");

    // New client should have events registered
    const registeredEvents = [...mock2.listeners.keys()];
    expect(registeredEvents).toContain("DOM.documentUpdated");
    expect(registeredEvents).toContain("DOM.childNodeInserted");
    expect(registeredEvents).toContain("Page.frameNavigated");
  });

  // --- Refresh callback error handling ---

  it("Refresh callback error wird still geschluckt", async () => {
    const refreshFn = vi.fn().mockRejectedValue(new Error("CDP disconnected"));
    watcher.onRefresh(refreshFn);
    await watcher.init();

    mock.fireEvent("DOM.childNodeInserted", {});

    // Should not throw
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // After error, subsequent refreshes should still work
    const refreshFn2 = vi.fn().mockResolvedValue(undefined);
    watcher.onRefresh(refreshFn2);
    mock.fireEvent("DOM.childNodeInserted", {});
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshFn2).toHaveBeenCalledTimes(1);
  });
});
