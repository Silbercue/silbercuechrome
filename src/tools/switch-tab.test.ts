import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { switchTabHandler, _resetSwitchLock, _resetOriginTab, _getOriginTabId } from "./switch-tab.js";
import { TabStateCache } from "../cache/tab-state-cache.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import { DEVICE_METRICS_OVERRIDE } from "../cdp/emulation.js";

type EventCallback = (params: unknown, sessionId?: string) => void;

interface MockCdpSetup {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
  emitLifecycle: (params: Record<string, unknown>) => void;
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

  const emitLifecycle = (params: Record<string, unknown>) => {
    const set = listeners.get("Page.lifecycleEvent");
    if (set) {
      for (const entry of set) {
        entry.callback(params, entry.sessionId);
      }
    }
  };

  return { cdpClient, sendFn, emitLifecycle };
}

const defaultCdpResponses = {
  "Target.createTarget": { targetId: "T-NEW" },
  "Target.attachToTarget": { sessionId: "session-new" },
  "Target.activateTarget": {},
  "Target.closeTarget": {},
  "Target.getTargets": {
    targetInfos: [
      { targetId: "T1", type: "page", url: "https://a.com", title: "A" },
      { targetId: "T2", type: "page", url: "https://b.com", title: "B" },
    ],
  },
  "Runtime.enable": {},
  "Page.enable": {},
  "Page.setLifecycleEventsEnabled": {},
  "DOM.enable": {},
  "Accessibility.enable": {},
  "Emulation.setDeviceMetricsOverride": {},
  "Page.getFrameTree": { frameTree: { frame: { id: "frame-1" } } },
  "Page.getNavigationHistory": {
    currentIndex: 0,
    entries: [{ url: "https://example.com", title: "Example" }],
  },
  "Runtime.evaluate": { result: { value: "complete" } },
};

describe("switchTabHandler — action: open", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSwitchLock();
    _resetOriginTab();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens new tab with URL, navigates, caches state, returns tab info", async () => {
    const { cdpClient, emitLifecycle } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T-OLD");
    const onSessionChange = vi.fn();

    const promise = switchTabHandler(
      { action: "open", url: "https://example.com" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    // Emit lifecycle event to satisfy settle
    await vi.advanceTimersByTimeAsync(10);
    emitLifecycle({ frameId: "frame-1", loaderId: "l1", name: "networkIdle", timestamp: 1 });
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Tab opened: T-NEW");
    expect(text).toContain("URL:");
    expect(text).toContain("Title:");
    expect(result._meta?.method).toBe("switch_tab");
    expect(result._meta?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("activateSession calls DOM.enable on new session", async () => {
    const { cdpClient, sendFn } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T-OLD");
    const onSessionChange = vi.fn();

    await switchTabHandler(
      { action: "open" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(sendFn).toHaveBeenCalledWith("DOM.enable", {}, "session-new");
  });

  it("opens new tab without URL, defaults to about:blank", async () => {
    const { cdpClient } = createMockCdp({
      ...defaultCdpResponses,
      "Page.getNavigationHistory": {
        currentIndex: 0,
        entries: [{ url: "about:blank", title: "" }],
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T-OLD");
    const onSessionChange = vi.fn();

    // No URL -> no settle needed -> resolves immediately
    const result = await switchTabHandler(
      { action: "open" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBeUndefined();
    // Verify Target.createTarget was called with about:blank
    expect(cdpClient.send).toHaveBeenCalledWith("Target.createTarget", { url: "about:blank" });
  });

  it("updates active target in cache after open", async () => {
    const { cdpClient, emitLifecycle } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T-OLD");
    const onSessionChange = vi.fn();

    const promise = switchTabHandler(
      { action: "open", url: "https://example.com" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    await vi.advanceTimersByTimeAsync(10);
    emitLifecycle({ frameId: "frame-1", loaderId: "l1", name: "networkIdle", timestamp: 1 });
    await vi.advanceTimersByTimeAsync(500);

    await promise;

    expect(cache.activeTargetId).toBe("T-NEW");
  });

  it("propagates new sessionId via onSessionChange callback", async () => {
    const { cdpClient, emitLifecycle } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T-OLD");
    const onSessionChange = vi.fn();

    const promise = switchTabHandler(
      { action: "open", url: "https://example.com" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    await vi.advanceTimersByTimeAsync(10);
    emitLifecycle({ frameId: "frame-1", loaderId: "l1", name: "networkIdle", timestamp: 1 });
    await vi.advanceTimersByTimeAsync(500);

    await promise;

    expect(onSessionChange).toHaveBeenCalledWith("session-new");
  });

  it("enables CDP domains on new session", async () => {
    const { cdpClient, emitLifecycle } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T-OLD");
    const onSessionChange = vi.fn();

    const promise = switchTabHandler(
      { action: "open", url: "https://example.com" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    await vi.advanceTimersByTimeAsync(10);
    emitLifecycle({ frameId: "frame-1", loaderId: "l1", name: "networkIdle", timestamp: 1 });
    await vi.advanceTimersByTimeAsync(500);

    await promise;

    expect(cdpClient.send).toHaveBeenCalledWith("Runtime.enable", {}, "session-new");
    expect(cdpClient.send).toHaveBeenCalledWith("Page.enable", {}, "session-new");
    expect(cdpClient.send).toHaveBeenCalledWith(
      "Page.setLifecycleEventsEnabled",
      { enabled: true },
      "session-new",
    );
    expect(cdpClient.send).toHaveBeenCalledWith("Accessibility.enable", {}, "session-new");
    expect(cdpClient.send).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", DEVICE_METRICS_OVERRIDE, "session-new");
  });
});

describe("switchTabHandler — action: switch", () => {
  beforeEach(() => {
    _resetSwitchLock();
    _resetOriginTab();
  });

  it("switches to existing tab, returns cached state", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "switch", tab: "T2" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Switched to tab: T2");
    expect(text).toContain("URL:");
    expect(result._meta?.method).toBe("switch_tab");
  });

  it("returns error for non-existent tab", async () => {
    const { cdpClient } = createMockCdp({
      ...defaultCdpResponses,
      "Target.getTargets": {
        targetInfos: [{ targetId: "T1", type: "page", url: "https://a.com", title: "A" }],
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "switch", tab: "NONEXISTENT" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Tab not found: NONEXISTENT");
    expect(result._meta?.method).toBe("switch_tab");
  });

  it("updates active target in cache after switch", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    await switchTabHandler(
      { action: "switch", tab: "T2" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(cache.activeTargetId).toBe("T2");
  });

  it("does not change active tab on error", async () => {
    const { cdpClient } = createMockCdp({
      ...defaultCdpResponses,
      "Target.getTargets": {
        targetInfos: [{ targetId: "T1", type: "page", url: "https://a.com", title: "A" }],
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    await switchTabHandler(
      { action: "switch", tab: "NONEXISTENT" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(cache.activeTargetId).toBe("T1");
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it("lists tabs when tab missing for switch action", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "switch" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Tabs (2 open):");
    expect(text).toContain("★ Tab 1:");
    expect(text).toContain("Tab 2:");
    expect(text).toContain("T1");
    expect(text).toContain("T2");
    expect(result._meta?.method).toBe("switch_tab");
  });

  it("C1: rolls back to previous tab when attachToTarget fails after activateTarget", async () => {
    const { cdpClient } = createMockCdp({
      ...defaultCdpResponses,
      "Target.attachToTarget": () => {
        throw new Error("attach failed");
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "switch", tab: "T2" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("attach failed");

    // Verify activateTarget was called twice: once for T2, once for rollback to T1
    const activateCalls = (cdpClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Target.activateTarget",
    );
    expect(activateCalls).toHaveLength(2);
    expect(activateCalls[0][1]).toEqual({ targetId: "T2" });
    expect(activateCalls[1][1]).toEqual({ targetId: "T1" });

    // Session should not have changed
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it("switches to tab by numeric index (1-based)", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    // tab "2" should resolve to T2 (second entry in pageTabs)
    const result = await switchTabHandler(
      { action: "switch", tab: "2" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Switched to tab: T2");
  });

  it("returns error for out-of-range numeric index", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "switch", tab: "5" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Tab not found: 5");
  });
});

describe("switchTabHandler — action: close", () => {
  beforeEach(() => {
    _resetSwitchLock();
    _resetOriginTab();
  });

  it("closes active tab, switches to next available tab", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "close" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Tab closed: T1");
    expect(text).toContain("Active tab: T2");
    expect(result._meta?.method).toBe("switch_tab");
  });

  it("closes specific tab by tab", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "close", tab: "T2" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Tab closed: T2");
    // Non-active tab closed — no switch needed
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it("removes cache entry for closed tab", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    cache.set("T1", {
      url: "https://a.com",
      title: "A",
      domReady: true,
      loadingState: "ready",
    });
    const onSessionChange = vi.fn();

    await switchTabHandler(
      { action: "close" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(cache.has("T1")).toBe(false);
  });

  it("opens about:blank before closing last tab", async () => {
    const { cdpClient } = createMockCdp({
      ...defaultCdpResponses,
      "Target.getTargets": {
        targetInfos: [{ targetId: "T1", type: "page", url: "https://a.com", title: "A" }],
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "close" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Tab closed: T1");
    // A new about:blank tab was created
    expect(cdpClient.send).toHaveBeenCalledWith("Target.createTarget", { url: "about:blank" });
    expect(result.content[0].text).toContain("Active tab: T-NEW");
  });

  it("switches to next tab when active tab is closed", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "close" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBeUndefined();
    expect(cache.activeTargetId).toBe("T2");
    expect(onSessionChange).toHaveBeenCalledWith("session-new");
  });

  it("H1: calls activateTarget before attachToTarget when switching after close", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    await switchTabHandler(
      { action: "close" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    // Verify order: activateTarget(T2) must come before attachToTarget(T2)
    const calls = (cdpClient.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    const activateIdx = calls.indexOf("Target.activateTarget");
    const attachIdx = calls.indexOf("Target.attachToTarget");
    expect(activateIdx).toBeGreaterThanOrEqual(0);
    expect(attachIdx).toBeGreaterThan(activateIdx);
  });

  it("H2: returns error for non-existent tab in close action", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "close", tab: "NONEXISTENT" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Tab not found: NONEXISTENT");
    // Should not have attempted to close anything
    expect(cdpClient.send).not.toHaveBeenCalledWith(
      "Target.closeTarget",
      expect.anything(),
    );
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it("closes tab by numeric index", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    // tab "2" should resolve to T2 (non-active tab)
    const result = await switchTabHandler(
      { action: "close", tab: "2" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Tab closed: T2");
  });
});

describe("switchTabHandler — error handling", () => {
  beforeEach(() => {
    _resetSwitchLock();
    _resetOriginTab();
  });

  it("returns error when CDP connection fails", async () => {
    const { cdpClient } = createMockCdp();
    (cdpClient.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Transport closed unexpectedly"),
    );
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "open", url: "https://example.com" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CDP connection lost");
    expect(result._meta?.method).toBe("switch_tab");
    expect(result._meta?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("response always has _meta with elapsedMs and method", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    // Success case (no URL -> no settle)
    const successResult = await switchTabHandler(
      { action: "open" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );
    expect(successResult._meta).toBeDefined();
    expect(successResult._meta!.method).toBe("switch_tab");
    expect(typeof successResult._meta!.elapsedMs).toBe("number");

    // Tab listing case (no tab)
    const listResult = await switchTabHandler(
      { action: "switch" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );
    expect(listResult._meta).toBeDefined();
    expect(listResult._meta!.method).toBe("switch_tab");
    expect(typeof listResult._meta!.elapsedMs).toBe("number");
  });

  it("M1: returns error when attachToTarget fails during switch", async () => {
    const { cdpClient } = createMockCdp({
      ...defaultCdpResponses,
      "Target.attachToTarget": () => {
        throw new Error("Session creation failed");
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "switch", tab: "T2" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Session creation failed");
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it("M1: returns error when closeTarget fails", async () => {
    const { cdpClient } = createMockCdp({
      ...defaultCdpResponses,
      "Target.closeTarget": () => {
        throw new Error("Cannot close target");
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "close", tab: "T2" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot close target");
  });

  it("M1: returns error when re-attach fails after close (active tab, no fallback)", async () => {
    const { cdpClient } = createMockCdp({
      ...defaultCdpResponses,
      "Target.attachToTarget": () => {
        throw new Error("Re-attach failed");
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "close" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Re-attach failed");
    // With only 2 tabs and attach failing for the only candidate,
    // the close never happened — T1 remains open and active (safe state).
    expect(cache.activeTargetId).toBe("T1");
    // closeTarget was never called because attach failed first
    expect(cdpClient.send).not.toHaveBeenCalledWith(
      "Target.closeTarget",
      expect.anything(),
    );
  });

  it("C2: activeTargetId never points to closed tab when activateSession fails", async () => {
    // Three tabs: T1 (active), T2, T3 — attach to T2 fails, fallback to T3
    const threeTabResponses = {
      ...defaultCdpResponses,
      "Target.getTargets": {
        targetInfos: [
          { targetId: "T1", type: "page", url: "https://a.com", title: "A" },
          { targetId: "T2", type: "page", url: "https://b.com", title: "B" },
          { targetId: "T3", type: "page", url: "https://c.com", title: "C" },
        ],
      },
    };
    let attachCallCount = 0;
    const { cdpClient } = createMockCdp({
      ...threeTabResponses,
      "Target.attachToTarget": () => {
        attachCallCount++;
        if (attachCallCount === 1) {
          throw new Error("Attach to T2 failed");
        }
        return { sessionId: "session-fallback" };
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    const result = await switchTabHandler(
      { action: "close" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    // Should succeed with fallback tab T3
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Tab closed: T1");
    expect(result.content[0].text).toContain("fallback");
    // Active target must be T3, not T1 (closed) or T2 (attach failed)
    expect(cache.activeTargetId).toBe("T3");
  });
});

describe("switchTabHandler — serialisation (H3)", () => {
  beforeEach(() => {
    _resetSwitchLock();
    _resetOriginTab();
  });

  it("H3: serialises concurrent switch calls", async () => {
    const callOrder: string[] = [];
    const { cdpClient } = createMockCdp({
      ...defaultCdpResponses,
      "Target.attachToTarget": async () => {
        callOrder.push("attach-start");
        // Simulate async work
        await new Promise((r) => setTimeout(r, 0));
        callOrder.push("attach-end");
        return { sessionId: "session-new" };
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    // Launch two switches concurrently
    const p1 = switchTabHandler(
      { action: "switch", tab: "T2" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );
    const p2 = switchTabHandler(
      { action: "switch", tab: "T1" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    await Promise.all([p1, p2]);

    // Verify attach calls don't interleave: first pair completes before second starts
    expect(callOrder[0]).toBe("attach-start");
    expect(callOrder[1]).toBe("attach-end");
    expect(callOrder[2]).toBe("attach-start");
    expect(callOrder[3]).toBe("attach-end");
  });
});

describe("switchTabHandler — origin tab tracking (FR-001)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSwitchLock();
    _resetOriginTab();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("open saves originTabId and close returns to it", async () => {
    const { cdpClient, emitLifecycle } = createMockCdp({
      ...defaultCdpResponses,
      "Target.getTargets": {
        targetInfos: [
          { targetId: "BENCHMARK", type: "page", url: "https://bench.com", title: "Bench" },
          { targetId: "T-NEW", type: "page", url: "https://target.com", title: "Target" },
        ],
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("BENCHMARK");
    const onSessionChange = vi.fn();

    // 1. Open a new tab (should save BENCHMARK as origin)
    const openPromise = switchTabHandler(
      { action: "open", url: "https://target.com" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    await vi.advanceTimersByTimeAsync(10);
    emitLifecycle({ frameId: "frame-1", loaderId: "l1", name: "networkIdle", timestamp: 1 });
    await vi.advanceTimersByTimeAsync(500);

    const openResult = await openPromise;
    expect(openResult.content[0].text).toContain("Origin tab: BENCHMARK");
    expect(_getOriginTabId()).toBe("BENCHMARK");

    // 2. Close the new tab (should return to BENCHMARK)
    // Update getTargets to reflect the new tab is now active
    (cdpClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            { targetId: "BENCHMARK", type: "page", url: "https://bench.com", title: "Bench" },
            { targetId: "T-NEW", type: "page", url: "https://target.com", title: "Target" },
          ],
        };
      }
      if (method === "Target.attachToTarget") return { sessionId: "session-bench" };
      if (method === "Page.getNavigationHistory") {
        return { currentIndex: 0, entries: [{ url: "https://bench.com", title: "Bench" }] };
      }
      if (method === "Runtime.evaluate") return { result: { value: "complete" } };
      return {};
    });
    cache.setActiveTarget("T-NEW");

    const closeResult = await switchTabHandler(
      { action: "close" },
      cdpClient,
      "session-new",
      cache,
      onSessionChange,
    );

    expect(closeResult.isError).toBeUndefined();
    const closeText = closeResult.content[0].text;
    expect(closeText).toContain("Tab closed: T-NEW");
    expect(closeText).toContain("Returned to origin tab: BENCHMARK");
    expect(cache.activeTargetId).toBe("BENCHMARK");
    // Origin should be reset after close
    expect(_getOriginTabId()).toBeUndefined();
  });

  it("close falls back when originTabId no longer exists", async () => {
    const { cdpClient } = createMockCdp({
      ...defaultCdpResponses,
      "Target.getTargets": {
        targetInfos: [
          { targetId: "T1", type: "page", url: "https://a.com", title: "A" },
          { targetId: "T-NEW", type: "page", url: "https://b.com", title: "B" },
        ],
      },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("BENCHMARK");

    // Simulate: open set origin to BENCHMARK, but BENCHMARK was closed externally
    const openPromise = switchTabHandler(
      { action: "open" },
      cdpClient,
      "session-old",
      cache,
      vi.fn(),
    );
    await openPromise;
    expect(_getOriginTabId()).toBe("BENCHMARK");

    // Now close the active tab — origin BENCHMARK is not in pageTabs anymore
    cache.setActiveTarget("T-NEW");
    const closeResult = await switchTabHandler(
      { action: "close" },
      cdpClient,
      "session-new",
      cache,
      vi.fn(),
    );

    expect(closeResult.isError).toBeUndefined();
    const text = closeResult.content[0].text;
    expect(text).toContain("Tab closed: T-NEW");
    expect(text).toContain("Active tab: T1");
    expect(text).toContain("origin tab no longer available");
    expect(_getOriginTabId()).toBeUndefined();
  });

  it("switch saves originTabId", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");
    const onSessionChange = vi.fn();

    await switchTabHandler(
      { action: "switch", tab: "T2" },
      cdpClient,
      "session-old",
      cache,
      onSessionChange,
    );

    expect(_getOriginTabId()).toBe("T1");
  });

  it("_resetOriginTab() clears the origin", async () => {
    const { cdpClient } = createMockCdp(defaultCdpResponses);
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T1");

    // Trigger switch to set origin
    await switchTabHandler(
      { action: "switch", tab: "T2" },
      cdpClient,
      "session-old",
      cache,
      vi.fn(),
    );
    expect(_getOriginTabId()).toBe("T1");

    _resetOriginTab();
    expect(_getOriginTabId()).toBeUndefined();
  });
});
