import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TabStateCache } from "./tab-state-cache.js";
import type { CdpClient } from "../cdp/cdp-client.js";

type EventCallback = (params: unknown, sessionId?: string) => void;

interface MockCdpSetup {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
  emit: (method: string, params: Record<string, unknown>) => void;
}

function createMockCdp(sendResponses?: Record<string, unknown>): MockCdpSetup {
  const listeners = new Map<string, Set<{ callback: EventCallback; sessionId?: string }>>();

  const sendFn = vi.fn(async (method: string) => {
    if (sendResponses && method in sendResponses) {
      const val = sendResponses[method];
      if (typeof val === "function") return val();
      return val;
    }
    return {};
  });

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

  const cdpClient = {
    send: sendFn,
    on: onFn,
    once: vi.fn(),
    off: offFn,
  } as unknown as CdpClient;

  const emit = (method: string, params: Record<string, unknown>) => {
    const set = listeners.get(method);
    if (set) {
      for (const entry of set) {
        entry.callback(params, entry.sessionId);
      }
    }
  };

  return { cdpClient, sendFn, emit };
}

describe("TabStateCache — Core Cache Operations", () => {
  let cache: TabStateCache;

  beforeEach(() => {
    cache = new TabStateCache({ ttlMs: 5000 });
  });

  it("get returns null for unknown targetId", () => {
    expect(cache.get("unknown-tab")).toBeNull();
  });

  it("set + get returns cached state", () => {
    cache.set("tab1", {
      url: "https://example.com",
      title: "Example",
      domReady: true,
      consoleErrors: [],
      loadingState: "ready",
    });

    const state = cache.get("tab1");
    expect(state).not.toBeNull();
    expect(state!.url).toBe("https://example.com");
    expect(state!.title).toBe("Example");
    expect(state!.domReady).toBe(true);
    expect(state!.loadingState).toBe("ready");
    expect(state!.lastUpdated).toBeGreaterThan(0);
  });

  it("get returns null after TTL expires", () => {
    vi.useFakeTimers();
    try {
      cache.set("tab1", { url: "https://example.com", title: "Example" });
      expect(cache.get("tab1")).not.toBeNull();

      vi.advanceTimersByTime(5001);
      expect(cache.get("tab1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidate removes entry", () => {
    cache.set("tab1", { url: "https://example.com" });
    expect(cache.has("tab1")).toBe(true);

    cache.invalidate("tab1");
    expect(cache.has("tab1")).toBe(false);
    expect(cache.get("tab1")).toBeNull();
  });

  it("invalidateAll clears all entries", () => {
    cache.set("tab1", { url: "https://one.com" });
    cache.set("tab2", { url: "https://two.com" });
    expect(cache.size()).toBe(2);

    cache.invalidateAll();
    expect(cache.size()).toBe(0);
    expect(cache.get("tab1")).toBeNull();
    expect(cache.get("tab2")).toBeNull();
  });

  it("set merges with existing state (partial update)", () => {
    cache.set("tab1", {
      url: "https://example.com",
      title: "Example",
      domReady: false,
      consoleErrors: ["error1"],
    });

    cache.set("tab1", { title: "Updated Title", domReady: true });

    const state = cache.get("tab1");
    expect(state).not.toBeNull();
    expect(state!.url).toBe("https://example.com");
    expect(state!.title).toBe("Updated Title");
    expect(state!.domReady).toBe(true);
    expect(state!.consoleErrors).toEqual(["error1"]);
  });

  it("has returns false for stale entry", () => {
    vi.useFakeTimers();
    try {
      cache.set("tab1", { url: "https://example.com" });
      expect(cache.has("tab1")).toBe(true);

      vi.advanceTimersByTime(5001);
      expect(cache.has("tab1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TabStateCache — Console Errors", () => {
  let cache: TabStateCache;

  beforeEach(() => {
    cache = new TabStateCache({ maxConsoleErrors: 3 });
  });

  it("addConsoleError stores error", () => {
    cache.set("tab1", { url: "https://example.com" });
    cache.addConsoleError("tab1", "ReferenceError: foo is not defined");

    const state = cache.get("tab1");
    expect(state!.consoleErrors).toEqual(["ReferenceError: foo is not defined"]);
  });

  it("addConsoleError caps at maxConsoleErrors (FIFO)", () => {
    cache.set("tab1", { url: "https://example.com" });
    cache.addConsoleError("tab1", "Error 1");
    cache.addConsoleError("tab1", "Error 2");
    cache.addConsoleError("tab1", "Error 3");
    cache.addConsoleError("tab1", "Error 4");

    const state = cache.get("tab1");
    expect(state!.consoleErrors).toEqual(["Error 2", "Error 3", "Error 4"]);
    expect(state!.consoleErrors.length).toBe(3);
  });

  it("console errors survive partial state updates", () => {
    cache.set("tab1", { url: "https://example.com" });
    cache.addConsoleError("tab1", "Some error");

    cache.set("tab1", { title: "New Title" });

    const state = cache.get("tab1");
    expect(state!.consoleErrors).toEqual(["Some error"]);
    expect(state!.title).toBe("New Title");
  });

  it("addConsoleError buffers errors in pendingErrors when no cache entry exists", () => {
    cache.addConsoleError("new-tab", "An error");
    // No cache entry is created — errors are buffered in _pendingErrors
    expect(cache.size()).toBe(0);
    expect(cache.get("new-tab")).toBeNull();
  });
});

describe("TabStateCache — CDP Event Invalidation", () => {
  let cache: TabStateCache;
  let mock: MockCdpSetup;

  beforeEach(() => {
    cache = new TabStateCache({ ttlMs: 30_000 });
    mock = createMockCdp();
    cache.setActiveTarget("target-1");
    cache.set("target-1", {
      url: "https://example.com",
      title: "Example",
      domReady: true,
      loadingState: "ready",
    });
    cache.attachToClient(mock.cdpClient, "session-1");
  });

  afterEach(() => {
    cache.detachFromClient();
  });

  it("Page.frameNavigated invalidates top-level frame", () => {
    expect(cache.has("target-1")).toBe(true);

    mock.emit("Page.frameNavigated", {
      frame: { id: "main-frame", url: "https://new.com" },
    });

    expect(cache.has("target-1")).toBe(false);
  });

  it("Page.frameNavigated ignores child frames (with parentId)", () => {
    expect(cache.has("target-1")).toBe(true);

    mock.emit("Page.frameNavigated", {
      frame: { id: "child-frame", url: "https://iframe.com", parentId: "main-frame" },
    });

    expect(cache.has("target-1")).toBe(true);
  });

  it("Page.navigatedWithinDocument invalidates cache (SPA navigation)", () => {
    expect(cache.has("target-1")).toBe(true);

    mock.emit("Page.navigatedWithinDocument", {
      url: "https://example.com/spa-route",
    });

    expect(cache.has("target-1")).toBe(false);
  });

  it("Runtime.exceptionThrown adds console error", () => {
    mock.emit("Runtime.exceptionThrown", {
      exceptionDetails: {
        text: "Uncaught error",
        exception: { description: "TypeError: Cannot read property 'x' of null" },
      },
    });

    const state = cache.get("target-1");
    expect(state!.consoleErrors).toContain("TypeError: Cannot read property 'x' of null");
  });

  it("Runtime.exceptionThrown falls back to text if no exception.description", () => {
    mock.emit("Runtime.exceptionThrown", {
      exceptionDetails: {
        text: "Script error.",
      },
    });

    const state = cache.get("target-1");
    expect(state!.consoleErrors).toContain("Script error.");
  });

  it("Page.domContentEventFired updates domReady", () => {
    cache.set("target-1", {
      url: "https://example.com",
      title: "Example",
      domReady: false,
      loadingState: "loading",
    });

    mock.emit("Page.domContentEventFired", { timestamp: 12345 });

    const state = cache.get("target-1");
    expect(state!.domReady).toBe(true);
  });

  it("detachFromClient removes all listeners", () => {
    cache.detachFromClient();

    // After detach, events should not affect cache
    cache.set("target-1", {
      url: "https://example.com",
      title: "Example",
      domReady: true,
      loadingState: "ready",
    });

    mock.emit("Page.frameNavigated", {
      frame: { id: "main-frame", url: "https://new.com" },
    });

    // Cache should still have the entry
    expect(cache.has("target-1")).toBe(true);
  });
});

describe("TabStateCache — getOrFetch", () => {
  let cache: TabStateCache;

  beforeEach(() => {
    cache = new TabStateCache({ ttlMs: 5000 });
  });

  it("getOrFetch returns cached state with cacheHit: true", async () => {
    cache.set("tab1", {
      url: "https://cached.com",
      title: "Cached Page",
      domReady: true,
      loadingState: "ready",
    });

    const mock = createMockCdp();
    const result = await cache.getOrFetch(mock.cdpClient, "tab1", "s1");

    expect(result.cacheHit).toBe(true);
    expect(result.state.url).toBe("https://cached.com");
    expect(mock.sendFn).not.toHaveBeenCalled();
  });

  it("getOrFetch fetches from CDP on miss with cacheHit: false", async () => {
    const mock = createMockCdp({
      "Page.getNavigationHistory": {
        currentIndex: 0,
        entries: [{ url: "https://fresh.com", title: "Fresh Page" }],
      },
      "Runtime.evaluate": { result: { value: "complete" } },
    });

    const result = await cache.getOrFetch(mock.cdpClient, "tab1", "s1");

    expect(result.cacheHit).toBe(false);
    expect(result.state.url).toBe("https://fresh.com");
    expect(result.state.title).toBe("Fresh Page");
    expect(result.state.domReady).toBe(true);
    expect(result.state.loadingState).toBe("ready");
    expect(mock.sendFn).toHaveBeenCalledTimes(2);
  });

  it("getOrFetch fetches from CDP when TTL expired", async () => {
    vi.useFakeTimers();
    try {
      cache.set("tab1", {
        url: "https://stale.com",
        title: "Stale",
        domReady: true,
        loadingState: "ready",
      });

      vi.advanceTimersByTime(5001);

      const mock = createMockCdp({
        "Page.getNavigationHistory": {
          currentIndex: 0,
          entries: [{ url: "https://refreshed.com", title: "Refreshed" }],
        },
        "Runtime.evaluate": { result: { value: "interactive" } },
      });

      const result = await cache.getOrFetch(mock.cdpClient, "tab1", "s1");

      expect(result.cacheHit).toBe(false);
      expect(result.state.url).toBe("https://refreshed.com");
      expect(result.state.domReady).toBe(true);
      expect(result.state.loadingState).toBe("loading");
    } finally {
      vi.useRealTimers();
    }
  });

  it("getOrFetch preserves existing console errors on CDP fetch", async () => {
    cache.set("tab1", { url: "https://old.com" });
    cache.addConsoleError("tab1", "Existing error");

    // Invalidate but keep the Map entry for console errors
    // Since invalidate removes the entry, we need a TTL expiry instead
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(5001);

      const mock = createMockCdp({
        "Page.getNavigationHistory": {
          currentIndex: 0,
          entries: [{ url: "https://new.com", title: "New" }],
        },
        "Runtime.evaluate": { result: { value: "complete" } },
      });

      const result = await cache.getOrFetch(mock.cdpClient, "tab1", "s1");
      // After TTL expiry the entry is stale but still in the Map,
      // so _fetchFromCdp reads consoleErrors from the stale entry
      expect(result.state.consoleErrors).toEqual(["Existing error"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TabStateCache — Pending Errors Merge (AC-8)", () => {
  it("errors buffered before first getOrFetch are merged into the fetched state", async () => {
    const cache = new TabStateCache({ ttlMs: 5000, maxConsoleErrors: 10 });

    // Errors arrive before any cache entry exists
    cache.addConsoleError("tab1", "Early error 1");
    cache.addConsoleError("tab1", "Early error 2");

    // No cache entry yet
    expect(cache.size()).toBe(0);

    const mock = createMockCdp({
      "Page.getNavigationHistory": {
        currentIndex: 0,
        entries: [{ url: "https://example.com", title: "Example" }],
      },
      "Runtime.evaluate": { result: { value: "complete" } },
    });

    const result = await cache.getOrFetch(mock.cdpClient, "tab1", "s1");

    expect(result.cacheHit).toBe(false);
    expect(result.state.consoleErrors).toEqual(["Early error 1", "Early error 2"]);
    expect(result.state.url).toBe("https://example.com");
  });

  it("pending errors are consumed (not duplicated) on subsequent getOrFetch", async () => {
    const cache = new TabStateCache({ ttlMs: 5000, maxConsoleErrors: 10 });

    cache.addConsoleError("tab1", "Buffered error");

    const mock = createMockCdp({
      "Page.getNavigationHistory": {
        currentIndex: 0,
        entries: [{ url: "https://example.com", title: "Example" }],
      },
      "Runtime.evaluate": { result: { value: "complete" } },
    });

    // First fetch — merges pending errors
    const first = await cache.getOrFetch(mock.cdpClient, "tab1", "s1");
    expect(first.state.consoleErrors).toEqual(["Buffered error"]);

    // Second call — should be a cache hit, no duplication
    const second = await cache.getOrFetch(mock.cdpClient, "tab1", "s1");
    expect(second.cacheHit).toBe(true);
    expect(second.state.consoleErrors).toEqual(["Buffered error"]);
  });

  it("pending errors are capped at maxConsoleErrors", async () => {
    const cache = new TabStateCache({ ttlMs: 5000, maxConsoleErrors: 3 });

    cache.addConsoleError("tab1", "Error 1");
    cache.addConsoleError("tab1", "Error 2");
    cache.addConsoleError("tab1", "Error 3");
    cache.addConsoleError("tab1", "Error 4");

    const mock = createMockCdp({
      "Page.getNavigationHistory": {
        currentIndex: 0,
        entries: [{ url: "https://example.com", title: "Example" }],
      },
      "Runtime.evaluate": { result: { value: "complete" } },
    });

    const result = await cache.getOrFetch(mock.cdpClient, "tab1", "s1");
    // Only the 3 most recent pending errors should survive
    expect(result.state.consoleErrors).toEqual(["Error 2", "Error 3", "Error 4"]);
  });
});

describe("TabStateCache — activeTargetId", () => {
  it("activeTargetId is null initially", () => {
    const cache = new TabStateCache();
    expect(cache.activeTargetId).toBeNull();
  });

  it("setActiveTarget updates activeTargetId", () => {
    const cache = new TabStateCache();
    cache.setActiveTarget("target-42");
    expect(cache.activeTargetId).toBe("target-42");
  });
});
