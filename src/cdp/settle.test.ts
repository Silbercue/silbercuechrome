import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { settle } from "./settle.js";
import type { CdpClient } from "./cdp-client.js";

type EventCallback = (params: unknown, sessionId?: string) => void;

interface MockCdpClient {
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  _listeners: Map<string, Set<{ callback: EventCallback; sessionId?: string }>>;
  _emit: (method: string, params: unknown, sessionId?: string) => void;
}

function createMockCdpClient(): MockCdpClient {
  const listeners = new Map<string, Set<{ callback: EventCallback; sessionId?: string }>>();

  const mock: MockCdpClient = {
    send: vi.fn(),
    on: vi.fn((method: string, callback: EventCallback, sessionId?: string) => {
      let set = listeners.get(method);
      if (!set) {
        set = new Set();
        listeners.set(method, set);
      }
      set.add({ callback, sessionId });
    }),
    once: vi.fn(),
    off: vi.fn((method: string, callback: EventCallback) => {
      const set = listeners.get(method);
      if (set) {
        for (const entry of set) {
          if (entry.callback === callback) {
            set.delete(entry);
            break;
          }
        }
      }
    }),
    _listeners: listeners,
    _emit: (method: string, params: unknown, sessionId?: string) => {
      const set = listeners.get(method);
      if (set) {
        for (const entry of set) {
          if (entry.sessionId === undefined || entry.sessionId === sessionId) {
            entry.callback(params, sessionId);
          }
        }
      }
    },
  };

  return mock;
}

describe("settle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return settled: true with networkIdle signal", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "frame-1",
      loaderId: "loader-1",
      settleMs: 100,
      timeoutMs: 5000,
    });

    // Emit networkIdle for main frame
    mock._emit("Page.lifecycleEvent", {
      frameId: "frame-1",
      loaderId: "loader-1",
      name: "networkIdle",
      timestamp: 1,
    }, "s1");

    // Advance past settle_ms
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result.settled).toBe(true);
    expect(result.signal).toBe("networkIdle");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("should accept networkAlmostIdle as fallback signal", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "frame-1",
      loaderId: "loader-1",
      settleMs: 100,
      timeoutMs: 5000,
    });

    mock._emit("Page.lifecycleEvent", {
      frameId: "frame-1",
      loaderId: "loader-1",
      name: "networkAlmostIdle",
      timestamp: 1,
    }, "s1");

    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result.settled).toBe(true);
    expect(result.signal).toBe("networkAlmostIdle");
  });

  it("should return settled: false with timeout signal when no lifecycle event", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "frame-1",
      loaderId: "loader-1",
      settleMs: 100,
      timeoutMs: 2000,
    });

    // No events emitted — advance past timeout
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result.settled).toBe(false);
    expect(result.signal).toBe("timeout");
  });

  it("should wait configurable settle_ms after networkIdle", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "frame-1",
      loaderId: "loader-1",
      settleMs: 300,
      timeoutMs: 5000,
    });

    mock._emit("Page.lifecycleEvent", {
      frameId: "frame-1",
      loaderId: "loader-1",
      name: "networkIdle",
      timestamp: 1,
    }, "s1");

    // After 200ms (< 300ms settle_ms), should not be resolved yet
    await vi.advanceTimersByTimeAsync(200);

    // Check that promise is still pending by racing it
    const pending = await Promise.race([
      promise.then(() => "resolved"),
      Promise.resolve("still-pending"),
    ]);
    expect(pending).toBe("still-pending");

    // After another 100ms (total 300ms), should be resolved
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result.settled).toBe(true);
    expect(result.signal).toBe("networkIdle");
  });

  it("should clean up listeners after settle completes", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "frame-1",
      loaderId: "loader-1",
      settleMs: 50,
      timeoutMs: 5000,
    });

    mock._emit("Page.lifecycleEvent", {
      frameId: "frame-1",
      loaderId: "loader-1",
      name: "networkIdle",
      timestamp: 1,
    }, "s1");

    await vi.advanceTimersByTimeAsync(50);
    await promise;

    // off() should have been called to remove the listener
    expect(mock.off).toHaveBeenCalledWith("Page.lifecycleEvent", expect.any(Function));
  });

  it("should resolve quickly when networkIdle arrives immediately", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "frame-1",
      loaderId: "loader-1",
      settleMs: 50,
      timeoutMs: 5000,
    });

    // Emit immediately
    mock._emit("Page.lifecycleEvent", {
      frameId: "frame-1",
      loaderId: "loader-1",
      name: "networkIdle",
      timestamp: 1,
    }, "s1");

    await vi.advanceTimersByTimeAsync(50);

    const result = await promise;
    expect(result.settled).toBe(true);
    expect(result.elapsedMs).toBeLessThan(1000);
  });

  it("should ignore lifecycle events from iframes (different frameId)", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "main-frame",
      loaderId: "loader-1",
      settleMs: 50,
      timeoutMs: 1000,
    });

    // Emit from iframe — should be ignored
    mock._emit("Page.lifecycleEvent", {
      frameId: "iframe-1",
      loaderId: "loader-1",
      name: "networkIdle",
      timestamp: 1,
    }, "s1");

    // Should timeout since main frame event never came
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.settled).toBe(false);
    expect(result.signal).toBe("timeout");
  });

  it("should handle SPA path (spaNavigation: true) — wait settle_ms only", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "frame-1",
      spaNavigation: true,
      settleMs: 200,
      timeoutMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result.settled).toBe(true);
    expect(result.signal).toBe("spa");
    // No lifecycle listeners should have been registered for SPA path
    expect(mock.on).not.toHaveBeenCalled();
  });

  it("should use default settle_ms of 500ms when not specified", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "frame-1",
      loaderId: "loader-1",
      timeoutMs: 10000,
    });

    mock._emit("Page.lifecycleEvent", {
      frameId: "frame-1",
      loaderId: "loader-1",
      name: "networkIdle",
      timestamp: 1,
    }, "s1");

    // After 400ms (< 500ms default), still pending
    await vi.advanceTimersByTimeAsync(400);
    const pending = await Promise.race([
      promise.then(() => "resolved"),
      Promise.resolve("still-pending"),
    ]);
    expect(pending).toBe("still-pending");

    // After 100ms more (total 500ms), should resolve
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result.settled).toBe(true);
  });

  it("should ignore lifecycle events with mismatched loaderId (stale events)", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "frame-1",
      loaderId: "loader-new",
      settleMs: 50,
      timeoutMs: 1000,
    });

    // Emit stale event from previous navigation (different loaderId)
    mock._emit("Page.lifecycleEvent", {
      frameId: "frame-1",
      loaderId: "loader-old",
      name: "networkIdle",
      timestamp: 1,
    }, "s1");

    // Should timeout since correct loaderId event never came
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.settled).toBe(false);
    expect(result.signal).toBe("timeout");
  });

  it("should accept any loaderId when none specified (back navigation)", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "frame-1",
      // No loaderId — back navigation pattern
      settleMs: 50,
      timeoutMs: 5000,
    });

    mock._emit("Page.lifecycleEvent", {
      frameId: "frame-1",
      loaderId: "any-loader-id",
      name: "networkIdle",
      timestamp: 1,
    }, "s1");

    await vi.advanceTimersByTimeAsync(50);

    const result = await promise;
    expect(result.settled).toBe(true);
    expect(result.signal).toBe("networkIdle");
  });

  it("should upgrade from networkAlmostIdle to networkIdle if both arrive", async () => {
    const mock = createMockCdpClient();
    const cdpClient = mock as unknown as CdpClient;

    const promise = settle({
      cdpClient,
      sessionId: "s1",
      frameId: "frame-1",
      loaderId: "loader-1",
      settleMs: 200,
      timeoutMs: 5000,
    });

    // First: networkAlmostIdle
    mock._emit("Page.lifecycleEvent", {
      frameId: "frame-1",
      loaderId: "loader-1",
      name: "networkAlmostIdle",
      timestamp: 1,
    }, "s1");

    await vi.advanceTimersByTimeAsync(50);

    // Then: networkIdle (should reset the timer and use networkIdle as signal)
    mock._emit("Page.lifecycleEvent", {
      frameId: "frame-1",
      loaderId: "loader-1",
      name: "networkIdle",
      timestamp: 2,
    }, "s1");

    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result.settled).toBe(true);
    expect(result.signal).toBe("networkIdle");
  });
});
