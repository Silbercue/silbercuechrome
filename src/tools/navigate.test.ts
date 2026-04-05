import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { navigateHandler, navigateSchema } from "./navigate.js";
import type { CdpClient } from "../cdp/cdp-client.js";

type EventCallback = (params: unknown, sessionId?: string) => void;

interface MockCdpSetup {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
  emitLifecycle: (params: Record<string, unknown>) => void;
}

function createMockCdp(sendResponses: Record<string, unknown>): MockCdpSetup {
  const listeners = new Map<string, Set<{ callback: EventCallback; sessionId?: string }>>();

  const sendFn = vi.fn(async (method: string) => {
    if (method in sendResponses) {
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

describe("navigateSchema", () => {
  it("should accept url only", () => {
    const result = navigateSchema.parse({ url: "https://example.com" });
    expect(result.url).toBe("https://example.com");
    expect(result.action).toBe("goto");
  });

  it("should default action to goto", () => {
    const result = navigateSchema.parse({});
    expect(result.action).toBe("goto");
  });

  it("should accept action back", () => {
    const result = navigateSchema.parse({ action: "back" });
    expect(result.action).toBe("back");
  });

  it("should accept settle_ms", () => {
    const result = navigateSchema.parse({ url: "https://example.com", settle_ms: 1000 });
    expect(result.settle_ms).toBe(1000);
  });
});

describe("navigateHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should navigate to URL and return title + URL", async () => {
    const { cdpClient, emitLifecycle } = createMockCdp({
      "Page.navigate": { frameId: "f1", loaderId: "l1" },
      "Runtime.evaluate": () => ({ result: { value: "Example Domain" } }),
    });

    // Override to return different values for URL and title
    let evalCount = 0;
    (cdpClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
      if (method === "Page.navigate") return { frameId: "f1", loaderId: "l1" };
      if (method === "Runtime.evaluate") {
        evalCount++;
        if (evalCount === 1) return { result: { value: "https://example.com" } };
        return { result: { value: "Example Domain" } };
      }
      return {};
    });

    const promise = navigateHandler(
      { url: "https://example.com", action: "goto" },
      cdpClient,
      "s1",
    );

    // Emit lifecycle event to settle
    await vi.advanceTimersByTimeAsync(10);
    emitLifecycle({ frameId: "f1", loaderId: "l1", name: "networkIdle", timestamp: 1 });
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Navigated to https://example.com — Example Domain");
    expect(result._meta?.method).toBe("navigate");
    expect(result._meta?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result._meta?.settled).toBe(true);
    expect(result._meta?.settleSignal).toBe("networkIdle");
  });

  it("should return isError when Page.navigate returns errorText", async () => {
    const { cdpClient } = createMockCdp({
      "Page.navigate": { frameId: "f1", errorText: "net::ERR_NAME_NOT_RESOLVED" },
    });

    const promise = navigateHandler(
      { url: "https://invalid.example", action: "goto" },
      cdpClient,
      "s1",
    );

    // No timers to advance — error is returned synchronously from navigate
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("net::ERR_NAME_NOT_RESOLVED");
    expect(result.content[0].text).toContain("https://invalid.example");
  });

  it("should handle action back with navigation history", async () => {
    const { cdpClient, emitLifecycle } = createMockCdp({});

    let evalCount = 0;
    (cdpClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
      if (method === "Page.getNavigationHistory") {
        return {
          currentIndex: 1,
          entries: [
            { id: 0, url: "https://first.com", title: "First" },
            { id: 1, url: "https://second.com", title: "Second" },
          ],
        };
      }
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame" } } };
      }
      if (method === "Page.navigateToHistoryEntry") return {};
      if (method === "Runtime.evaluate") {
        evalCount++;
        if (evalCount === 1) return { result: { value: "https://first.com" } };
        return { result: { value: "First" } };
      }
      return {};
    });

    const promise = navigateHandler(
      { action: "back" },
      cdpClient,
      "s1",
    );

    await vi.advanceTimersByTimeAsync(10);
    emitLifecycle({ frameId: "main-frame", loaderId: "any-loader", name: "networkIdle", timestamp: 1 });
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Navigated to https://first.com — First");
  });

  it("should return isError when going back with no history", async () => {
    const { cdpClient } = createMockCdp({
      "Page.getNavigationHistory": {
        currentIndex: 0,
        entries: [{ id: 0, url: "https://only.com", title: "Only" }],
      },
    });

    const promise = navigateHandler(
      { action: "back" },
      cdpClient,
      "s1",
    );

    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No previous page");
  });

  it("should return isError when goto without URL", async () => {
    const { cdpClient } = createMockCdp({});

    const promise = navigateHandler(
      { action: "goto" },
      cdpClient,
      "s1",
    );

    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("URL is required");
  });

  it("should pass settle_ms to settle()", async () => {
    const { cdpClient, emitLifecycle } = createMockCdp({
      "Page.navigate": { frameId: "f1", loaderId: "l1" },
    });

    let evalCount = 0;
    (cdpClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
      if (method === "Page.navigate") return { frameId: "f1", loaderId: "l1" };
      if (method === "Runtime.evaluate") {
        evalCount++;
        if (evalCount === 1) return { result: { value: "https://example.com" } };
        return { result: { value: "Example" } };
      }
      return {};
    });

    const promise = navigateHandler(
      { url: "https://example.com", action: "goto", settle_ms: 100 },
      cdpClient,
      "s1",
    );

    await vi.advanceTimersByTimeAsync(10);
    emitLifecycle({ frameId: "f1", loaderId: "l1", name: "networkIdle", timestamp: 1 });

    // After 50ms (< 100ms custom settle_ms), should not be resolved
    await vi.advanceTimersByTimeAsync(50);
    const pending = await Promise.race([
      promise.then(() => "resolved"),
      Promise.resolve("still-pending"),
    ]);
    expect(pending).toBe("still-pending");

    // After 50ms more, should resolve
    await vi.advanceTimersByTimeAsync(50);

    const result = await promise;
    expect(result.isError).toBeUndefined();
  });

  it("should NOT return isError on settle timeout (AC5) — settled: false in _meta", async () => {
    const { cdpClient } = createMockCdp({
      "Page.navigate": { frameId: "f1", loaderId: "l1" },
    });

    let evalCount = 0;
    (cdpClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
      if (method === "Page.navigate") return { frameId: "f1", loaderId: "l1" };
      if (method === "Runtime.evaluate") {
        evalCount++;
        if (evalCount === 1) return { result: { value: "https://slow.example" } };
        return { result: { value: "Slow Page" } };
      }
      return {};
    });

    const promise = navigateHandler(
      { url: "https://slow.example", action: "goto", settle_ms: 100 },
      cdpClient,
      "s1",
    );

    // No lifecycle events — settle will timeout at 15s
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;
    // AC5: Settle-Timeout is NOT an error
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Navigated to https://slow.example");
    expect(result.content[0].text).toContain("not fully settled");
    expect(result._meta?.settled).toBe(false);
    expect(result._meta?.settleSignal).toBe("timeout");
  });

  it("should return isError when CDP call throws", async () => {
    const { cdpClient } = createMockCdp({});
    (cdpClient.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Transport closed unexpectedly"),
    );

    const promise = navigateHandler(
      { url: "https://example.com", action: "goto" },
      cdpClient,
      "s1",
    );

    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CDP connection lost");
    expect(result._meta?.method).toBe("navigate");
  });
});
