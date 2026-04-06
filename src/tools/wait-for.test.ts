import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitForHandler, waitForSchema, extractSelector } from "./wait-for.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { WaitForParams } from "./wait-for.js";

// Mock a11yTree
vi.mock("../cache/a11y-tree.js", () => ({
  a11yTree: {
    resolveRef: vi.fn(),
  },
}));

import { a11yTree } from "../cache/a11y-tree.js";

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

// --- Schema Tests (Task 7.2) ---

describe("waitForSchema", () => {
  it("should have timeout default of 10000", () => {
    const result = waitForSchema.parse({ condition: "network_idle" });
    expect(result.timeout).toBe(10000);
  });

  it("should accept all 3 conditions", () => {
    for (const condition of ["element", "network_idle", "js"]) {
      const result = waitForSchema.parse({ condition });
      expect(result.condition).toBe(condition);
    }
  });

  it("should reject invalid condition", () => {
    expect(() => waitForSchema.parse({ condition: "invalid" })).toThrow();
  });
});

// --- Validation Tests (Task 7.3) ---

describe("waitForHandler — validation", () => {
  it("should return isError when condition is 'element' without selector", async () => {
    const { cdpClient } = createMockCdp({});
    const params: WaitForParams = { condition: "element", timeout: 10000 };

    const result = await waitForHandler(params, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires a 'selector' parameter");
    expect(result._meta?.elapsedMs).toBe(0);
    expect(result._meta?.method).toBe("wait_for");
  });

  it("should return isError when condition is 'js' without expression", async () => {
    const { cdpClient } = createMockCdp({});
    const params: WaitForParams = { condition: "js", timeout: 10000 };

    const result = await waitForHandler(params, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires an 'expression' parameter");
    expect(result._meta?.elapsedMs).toBe(0);
    expect(result._meta?.method).toBe("wait_for");
  });

  it("should NOT return validation error for condition 'network_idle' without extra params", async () => {
    // network_idle needs settle which needs lifecycle events — use short timeout
    const { cdpClient } = createMockCdp({
      "Page.getFrameTree": { frameTree: { frame: { id: "f1" } } },
    });

    const params: WaitForParams = { condition: "network_idle", timeout: 50 };
    const result = await waitForHandler(params, cdpClient, "s1");

    // It should timeout (no lifecycle events), but NOT fail on validation
    expect(result.content[0].text).not.toContain("requires");
  });
});

// --- Element condition tests (Task 7.4) ---

describe("waitForHandler — element condition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should succeed when CSS selector found after first poll", async () => {
    const { cdpClient } = createMockCdp({
      "Runtime.evaluate": { result: { value: true } },
    });

    const params: WaitForParams = {
      condition: "element",
      selector: "#submit",
      timeout: 5000,
    };

    const promise = waitForHandler(params, cdpClient, "s1");
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Condition 'element' met after");
    expect(result.content[0].text).toContain("selector: #submit");
    expect(result._meta?.condition).toBe("element");
    expect(result._meta?.method).toBe("wait_for");
  });

  it("should succeed when ref selector (e.g. 'e5') resolves via a11yTree", async () => {
    // Mock resolveRef to return a backendNodeId
    vi.mocked(a11yTree.resolveRef).mockReturnValue(42);

    const { cdpClient } = createMockCdp({
      "DOM.resolveNode": { object: { objectId: "obj-42" } },
      "Runtime.callFunctionOn": { result: { value: true } },
    });

    const params: WaitForParams = {
      condition: "element",
      selector: "e5",
      timeout: 5000,
    };

    const promise = waitForHandler(params, cdpClient, "s1");
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Condition 'element' met after");
    expect(result.content[0].text).toContain("selector: e5");
    expect(a11yTree.resolveRef).toHaveBeenCalledWith("e5");
  });

  it("should return isError when element not found within timeout", async () => {
    const { cdpClient } = createMockCdp({
      "Runtime.evaluate": { result: { value: false } },
    });

    const params: WaitForParams = {
      condition: "element",
      selector: "#missing",
      timeout: 500,
    };

    const promise = waitForHandler(params, cdpClient, "s1");

    // Advance timers past the timeout
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Timeout after 500ms");
    expect(result.content[0].text).toContain("#missing");
  });
});

// --- Network idle tests (Task 7.5) ---

describe("waitForHandler — network_idle condition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should succeed when settle returns settled: true", async () => {
    const { cdpClient, emitLifecycle } = createMockCdp({
      "Page.getFrameTree": { frameTree: { frame: { id: "f1" } } },
    });

    const params: WaitForParams = { condition: "network_idle", timeout: 5000 };

    const promise = waitForHandler(params, cdpClient, "s1");

    // Emit lifecycle event to trigger settle
    await vi.advanceTimersByTimeAsync(10);
    emitLifecycle({ frameId: "f1", name: "networkIdle", timestamp: 1, loaderId: "l1" });
    await vi.advanceTimersByTimeAsync(500); // settle delay

    const result = await promise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Condition 'network_idle' met after");
    expect(result._meta?.condition).toBe("network_idle");
    expect(result._meta?.settleSignal).toBeDefined();
  });

  it("should return isError when settle times out", async () => {
    const { cdpClient } = createMockCdp({
      "Page.getFrameTree": { frameTree: { frame: { id: "f1" } } },
    });

    const params: WaitForParams = { condition: "network_idle", timeout: 1000 };

    const promise = waitForHandler(params, cdpClient, "s1");

    // No lifecycle events → timeout
    await vi.advanceTimersByTimeAsync(1100);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Timeout after 1000ms waiting for network idle");
    expect(result.content[0].text).toContain("signal: timeout");
  });
});

// --- JS condition tests (Task 7.6) ---

describe("waitForHandler — js condition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should succeed when expression returns true immediately", async () => {
    const { cdpClient } = createMockCdp({
      "Runtime.evaluate": { result: { value: true } },
    });

    const params: WaitForParams = {
      condition: "js",
      expression: "window.ready === true",
      timeout: 5000,
    };

    const promise = waitForHandler(params, cdpClient, "s1");
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Condition 'js' met after");
    expect(result._meta?.condition).toBe("js");
  });

  it("should succeed after polling (false, then true)", async () => {
    let callCount = 0;
    const { cdpClient } = createMockCdp({});
    (cdpClient.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { result: { value: false } };
      return { result: { value: true } };
    });

    const params: WaitForParams = {
      condition: "js",
      expression: "document.getElementById('loaded') !== null",
      timeout: 5000,
    };

    const promise = waitForHandler(params, cdpClient, "s1");

    // First poll: false
    await vi.advanceTimersByTimeAsync(0);
    // Second poll after 200ms: true
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Condition 'js' met after");
  });

  it("should return isError when expression never returns true", async () => {
    const { cdpClient } = createMockCdp({
      "Runtime.evaluate": { result: { value: false } },
    });

    const params: WaitForParams = {
      condition: "js",
      expression: "false",
      timeout: 500,
    };

    const promise = waitForHandler(params, cdpClient, "s1");
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Timeout after 500ms");
    expect(result.content[0].text).toContain("Last evaluation returned: false");
  });

  it("should keep polling when expression throws exception", async () => {
    let callCount = 0;
    const { cdpClient } = createMockCdp({});
    (cdpClient.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { result: { value: undefined }, exceptionDetails: { text: "ReferenceError" } };
      return { result: { value: true } };
    });

    const params: WaitForParams = {
      condition: "js",
      expression: "window.myVar.ready",
      timeout: 5000,
    };

    const promise = waitForHandler(params, cdpClient, "s1");
    await vi.advanceTimersByTimeAsync(0);   // First poll: exception
    await vi.advanceTimersByTimeAsync(200); // Second poll: true

    const result = await promise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Condition 'js' met after");
  });
});

// --- Timeout tests (Task 7.7) ---

describe("waitForHandler — custom timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should respect custom timeout (500ms, not 10000ms)", async () => {
    const { cdpClient } = createMockCdp({
      "Runtime.evaluate": { result: { value: false } },
    });

    const params: WaitForParams = {
      condition: "js",
      expression: "false",
      timeout: 500,
    };

    const promise = waitForHandler(params, cdpClient, "s1");

    // After 500ms it should have timed out
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Timeout after 500ms");
  });
});

// --- Error handling tests (Task 7.8) ---

describe("waitForHandler — error handling", () => {
  it("should return isError on CDP transport error", async () => {
    const { cdpClient } = createMockCdp({});
    (cdpClient.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Transport closed unexpectedly"),
    );

    const params: WaitForParams = {
      condition: "network_idle",
      timeout: 5000,
    };

    const result = await waitForHandler(params, cdpClient, "s1");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CDP connection lost");
    expect(result._meta?.method).toBe("wait_for");
  });
});

// --- extractSelector unit tests (FR-006) ---

describe("extractSelector", () => {
  it("should extract selector from querySelector with single quotes", () => {
    expect(extractSelector("document.querySelector('#myId')?.textContent")).toBe("#myId");
  });

  it("should extract selector from querySelector with double quotes", () => {
    expect(extractSelector('document.querySelector("[data-test] .async-result")')).toBe('[data-test] .async-result');
  });

  it("should extract selector from getElementById and prefix with #", () => {
    expect(extractSelector("document.getElementById('loaded') !== null")).toBe("#loaded");
  });

  it("should return null when no querySelector or getElementById is present", () => {
    expect(extractSelector("window.ready === true")).toBeNull();
    expect(extractSelector("false")).toBeNull();
  });
});

// --- JS timeout diagnostics tests (FR-006) ---

describe("waitForHandler — js timeout diagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should show 'element not found' diagnostic when querySelector target does not exist", async () => {
    let callCount = 0;
    const { cdpClient } = createMockCdp({});
    (cdpClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      callCount++;
      // Polling calls return false (expression never met)
      if (params?.expression && typeof params.expression === "string" && params.expression.includes(".async-result")) {
        return { result: { value: false } };
      }
      // Diagnostic call: element does not exist
      if (params?.expression && typeof params.expression === "string" && params.expression.includes("!== null")) {
        return { result: { value: false } };
      }
      return { result: { value: false } };
    });

    const params: WaitForParams = {
      condition: "js",
      expression: "document.querySelector('[data-test=\"2.1\"] .async-result')?.textContent?.length > 0",
      timeout: 500,
    };

    const promise = waitForHandler(params, cdpClient, "s1");
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Timeout after 500ms");
    expect(result.content[0].text).toContain("element not found in DOM");
    expect(result.content[0].text).toContain('[data-test="2.1"] .async-result');
  });

  it("should show 'element exists but condition not met' when element is present", async () => {
    const { cdpClient } = createMockCdp({});
    (cdpClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      if (params?.expression && typeof params.expression === "string" && params.expression.includes("!== null")) {
        // Diagnostic call: element exists
        return { result: { value: true } };
      }
      // Polling calls: condition never met
      return { result: { value: false } };
    });

    const params: WaitForParams = {
      condition: "js",
      expression: "document.querySelector('#myEl')?.textContent === 'done'",
      timeout: 500,
    };

    const promise = waitForHandler(params, cdpClient, "s1");
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Timeout after 500ms");
    expect(result.content[0].text).toContain("Element exists but condition not met");
  });

  // --- FR-H7: Element timeout diagnostics ---

  it("FR-H7: should add diagnostic when element CSS selector not found in DOM", async () => {
    const { cdpClient, sendFn } = createMockCdp({
      "Runtime.evaluate": { result: { value: { exists: false, hidden: false, tag: "" } } },
    });

    const params: WaitForParams = {
      condition: "element",
      selector: "#nonexistent",
      timeout: 500,
    };

    const promise = waitForHandler(params, cdpClient, "s1");
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Timeout after 500ms");
    expect(result.content[0].text).toContain("Debug:");
    expect(result.content[0].text).toContain("element not in DOM");
  });

  it("FR-H7: should add diagnostic when element exists but is hidden", async () => {
    let callCount = 0;
    const { cdpClient } = createMockCdp({
      "Runtime.evaluate": () => {
        callCount++;
        // During polling, return false (not visible)
        // On diagnostic call, return exists+hidden
        return { result: { value: callCount > 3 ? { exists: true, hidden: true, tag: "div" } : false } };
      },
    });

    const params: WaitForParams = {
      condition: "element",
      selector: "#hidden-section",
      timeout: 500,
    };

    const promise = waitForHandler(params, cdpClient, "s1");
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Debug:");
    expect(result.content[0].text).toContain("zero size");
  });

  it("FR-H7: should add diagnostic for stale ref", async () => {
    vi.mocked(a11yTree.resolveRef).mockReturnValue(undefined);

    const { cdpClient } = createMockCdp({});

    const params: WaitForParams = {
      condition: "element",
      selector: "e99",
      timeout: 500,
    };

    const promise = waitForHandler(params, cdpClient, "s1");
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Debug:");
    expect(result.content[0].text).toContain("Ref not found");
    expect(result.content[0].text).toContain("read_page");
  });

  it("should NOT add diagnostic when expression has no querySelector or getElementById", async () => {
    const { cdpClient } = createMockCdp({
      "Runtime.evaluate": { result: { value: false } },
    });

    const params: WaitForParams = {
      condition: "js",
      expression: "window.ready === true",
      timeout: 500,
    };

    const promise = waitForHandler(params, cdpClient, "s1");
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Timeout after 500ms");
    expect(result.content[0].text).toContain("Last evaluation returned: false");
    // No Debug line
    expect(result.content[0].text).not.toContain("Debug:");
  });
});
