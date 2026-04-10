import { describe, it, expect, vi, beforeEach } from "vitest";
import { observeHandler, observeSchema, buildCollectFunction, buildUntilFunction } from "./observe.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ObserveParams } from "./observe.js";

// Mock a11yTree and selectorCache
vi.mock("../cache/a11y-tree.js", () => ({
  a11yTree: {
    resolveRef: vi.fn(),
    // BUG-016: resolveRefFull returns { backendNodeId, sessionId }. Tests
    // that care about the ref path mock this; default returns undefined.
    resolveRefFull: vi.fn(),
    getNodeInfo: vi.fn(() => ({ role: "button", name: "Test" })),
    currentUrl: "http://test.local",
    refCount: 10,
    findClosestRef: vi.fn(),
  },
  A11yTreeProcessor: { diffSnapshots: vi.fn(() => []), formatDomDiff: vi.fn() },
  RefNotFoundError: class RefNotFoundError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "RefNotFoundError";
    }
  },
}));

vi.mock("../cache/selector-cache.js", () => ({
  selectorCache: {
    get: vi.fn(() => null),
    set: vi.fn(),
    computeFingerprint: vi.fn(),
    updateFingerprint: vi.fn(),
    invalidate: vi.fn(),
  },
}));

import { a11yTree } from "../cache/a11y-tree.js";

function createMockCdp(responses?: Record<string, unknown | (() => unknown)>) {
  const sendFn = vi.fn(async (method: string) => {
    if (responses && method in responses) {
      const val = responses[method];
      return typeof val === "function" ? val() : val;
    }
    return {};
  });

  return {
    cdpClient: {
      send: sendFn,
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient,
    sendFn,
  };
}

// --- Schema Tests ---

describe("observeSchema", () => {
  it("should parse minimal collect params", () => {
    const result = observeSchema.parse({ selector: "#test", duration: 1000 });
    expect(result.selector).toBe("#test");
    expect(result.duration).toBe(1000);
    expect(result.collect).toBe("text");
    expect(result.interval).toBe(100);
    expect(result.timeout).toBe(10000);
  });

  it("should parse until params with then_click", () => {
    const result = observeSchema.parse({
      selector: "e5",
      until: "el.textContent === '8'",
      then_click: "#capture-btn",
    });
    expect(result.until).toBe("el.textContent === '8'");
    expect(result.then_click).toBe("#capture-btn");
  });

  it("should accept all collect types", () => {
    for (const collect of ["text", "attributes", "all"] as const) {
      const result = observeSchema.parse({ selector: "#x", duration: 100, collect });
      expect(result.collect).toBe(collect);
    }
  });

  it("should default timeout to 10000", () => {
    const result = observeSchema.parse({ selector: "#x", until: "true" });
    expect(result.timeout).toBe(10000);
  });
});

// --- JS Function Builder Tests ---

describe("buildCollectFunction", () => {
  it("should produce valid JS for text mode", () => {
    const fn = buildCollectFunction(1000, 100, "text");
    expect(fn).toContain("MutationObserver");
    expect(fn).toContain("checkText()");
    expect(fn).toContain("1000"); // duration
    expect(fn).toContain("100");  // interval
    expect(fn).toContain('"childList":true');
    expect(fn).toContain('"characterData":true');
  });

  it("should produce valid JS for attributes mode", () => {
    const fn = buildCollectFunction(2000, 50, "attributes");
    expect(fn).toContain("checkAttrs()");
    expect(fn).toContain('"attributes":true');
    expect(fn).not.toContain('"childList":true');
  });

  it("should produce valid JS for all mode", () => {
    const fn = buildCollectFunction(500, 100, "all");
    expect(fn).toContain("checkText(); checkAttrs();");
    expect(fn).toContain('"childList":true');
    expect(fn).toContain('"attributes":true');
  });
});

describe("buildUntilFunction", () => {
  it("should embed until expression", () => {
    const fn = buildUntilFunction("el.textContent === '8'", 10000, 100, "text");
    expect(fn).toContain("el.textContent === '8'");
    expect(fn).toContain("met: true");
    expect(fn).toContain("met: false");
  });

  it("should embed then_click selector", () => {
    const fn = buildUntilFunction("true", 5000, 100, "text", "#btn");
    expect(fn).toContain('document.querySelector("#btn")');
    expect(fn).toContain("clickTarget.click()");
  });

  it("should not have click code when no then_click", () => {
    const fn = buildUntilFunction("true", 5000, 100, "text");
    expect(fn).not.toContain("clickTarget");
    expect(fn).toContain("clicked: false");
  });
});

// --- Handler Tests ---

describe("observeHandler", () => {
  const SESSION_ID = "session-1";

  beforeEach(() => {
    vi.mocked(a11yTree.resolveRef).mockReturnValue(undefined);
  });

  it("should error when neither duration nor until provided", async () => {
    const { cdpClient } = createMockCdp();
    const params = observeSchema.parse({ selector: "#x" } as Partial<ObserveParams> & { selector: string });
    // Manually remove duration and until (schema defaults don't set them)
    const rawParams = { selector: "#x", collect: "text" as const, interval: 100, timeout: 10000 };
    const result = await observeHandler(rawParams as ObserveParams, cdpClient, SESSION_ID);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("requires either");
  });

  it("should error when both duration and until provided", async () => {
    const { cdpClient } = createMockCdp();
    const params = { selector: "#x", duration: 1000, until: "true", collect: "text" as const, interval: 100, timeout: 10000 };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("mutually exclusive");
  });

  it("should error when then_click without until", async () => {
    const { cdpClient } = createMockCdp();
    const params = { selector: "#x", duration: 1000, then_click: "#btn", collect: "text" as const, interval: 100, timeout: 10000 };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("requires 'until'");
  });

  it("should resolve CSS selector and call Runtime.callFunctionOn", async () => {
    const { cdpClient, sendFn } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 100 } },
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Runtime.callFunctionOn": {
        result: { value: { changes: [{ type: "text", value: "hello" }], count: 1 } },
      },
    });

    const params = { selector: "#test", duration: 100, collect: "text" as const, interval: 50, timeout: 10000 };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("hello");
    expect(result._meta?.mode).toBe("collect");
    expect(result._meta?.changeCount).toBe(1);

    // Verify Runtime.callFunctionOn was called with awaitPromise
    const callFn = sendFn.mock.calls.find((c) => c[0] === "Runtime.callFunctionOn");
    expect(callFn).toBeDefined();
    expect(callFn![1].objectId).toBe("obj-1");
    expect(callFn![1].awaitPromise).toBe(true);
    expect(callFn![1].returnByValue).toBe(true);
  });

  it("should resolve ref and call Runtime.callFunctionOn", async () => {
    // BUG-016: element-utils now uses resolveRefFull to get both
    // backendNodeId and owner sessionId in one lookup.
    vi.mocked(a11yTree.resolveRef).mockReturnValue(42);
    (a11yTree as unknown as { resolveRefFull: { mockReturnValue: (v: unknown) => void } })
      .resolveRefFull.mockReturnValue({ backendNodeId: 42, sessionId: SESSION_ID });

    const { cdpClient, sendFn } = createMockCdp({
      "DOM.resolveNode": { object: { objectId: "obj-ref" } },
      "Runtime.callFunctionOn": {
        result: { value: { changes: [], count: 0 } },
      },
    });

    const params = { selector: "e5", duration: 100, collect: "text" as const, interval: 50, timeout: 10000 };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("No changes");

    // Should have resolved ref via DOM.resolveNode with backendNodeId
    const resolveCall = sendFn.mock.calls.find(
      (c) => c[0] === "DOM.resolveNode" && c[1].backendNodeId === 42,
    );
    expect(resolveCall).toBeDefined();
  });

  it("should handle until mode — condition met", async () => {
    const { cdpClient } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 100 } },
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Runtime.callFunctionOn": {
        result: {
          value: {
            met: true,
            value: "8",
            changes: [{ type: "text", value: "8" }],
            clicked: true,
          },
        },
      },
    });

    const params = {
      selector: "#counter",
      until: "el.textContent === '8'",
      then_click: "#capture",
      collect: "text" as const,
      interval: 100,
      timeout: 10000,
    };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("Condition met");
    expect((result.content[0] as { text: string }).text).toContain('"8"');
    expect((result.content[0] as { text: string }).text).toContain("Clicked #capture");
    expect(result._meta?.mode).toBe("until");
    expect(result._meta?.conditionMet).toBe(true);
    expect(result._meta?.clicked).toBe(true);
  });

  it("should handle until mode — timeout", async () => {
    const { cdpClient } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 100 } },
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Runtime.callFunctionOn": {
        result: {
          value: { met: false, value: "3", changes: [], clicked: false },
        },
      },
    });

    const params = {
      selector: "#counter",
      until: "el.textContent === '99'",
      collect: "text" as const,
      interval: 100,
      timeout: 5000,
    };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Timeout");
    expect(result._meta?.conditionMet).toBe(false);
  });

  it("should handle JS exception in observer", async () => {
    const { cdpClient } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 100 } },
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Runtime.callFunctionOn": {
        result: { value: null },
        exceptionDetails: {
          exception: { description: "TypeError: Cannot read property 'textContent' of null" },
        },
      },
    });

    const params = { selector: "#missing", duration: 100, collect: "text" as const, interval: 50, timeout: 10000 };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("JS error");
  });

  it("should handle element not found (CSS)", async () => {
    const { cdpClient } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 0 }, // Not found
    });

    const params = { selector: "#nonexistent", duration: 100, collect: "text" as const, interval: 50, timeout: 10000 };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not found");
  });

  it("should handle CDP connection error", async () => {
    const { cdpClient } = createMockCdp({
      "DOM.getDocument": () => { throw new Error("CdpClient is closed"); },
    });

    const params = { selector: "#test", duration: 100, collect: "text" as const, interval: 50, timeout: 10000 };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("CDP connection lost");
  });

  it("should cap timeout at 25000ms", async () => {
    const { cdpClient, sendFn } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 100 } },
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Runtime.callFunctionOn": {
        result: { value: { changes: [], count: 0 } },
      },
    });

    const params = { selector: "#test", duration: 60000, collect: "text" as const, interval: 100, timeout: 60000 };
    await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    // The injected function should use 25000 not 60000
    const callFn = sendFn.mock.calls.find((c) => c[0] === "Runtime.callFunctionOn");
    expect(callFn![1].functionDeclaration).toContain("25000");
    expect(callFn![1].functionDeclaration).not.toContain("60000");
  });

  it("should format attribute changes correctly", async () => {
    const { cdpClient } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 100 } },
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Runtime.callFunctionOn": {
        result: {
          value: {
            changes: [
              { type: "attribute", name: "class", value: "active", old: "inactive" },
              { type: "attribute", name: "aria-expanded", value: "true", old: "false" },
            ],
            count: 2,
          },
        },
      },
    });

    const params = { selector: "#menu", duration: 1000, collect: "attributes" as const, interval: 100, timeout: 10000 };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Attribute changes (2)");
    expect(text).toContain("class: inactive → active");
    expect(text).toContain("aria-expanded: false → true");
  });
});

// --- FR-021: click_first / then_click ref support and silent-fail fix ---

describe("FR-021: observe click_first / then_click ref support", () => {
  const SESSION_ID = "session-1";

  beforeEach(() => {
    vi.mocked(a11yTree.resolveRef).mockReturnValue(undefined);
  });

  it("click_first with ref (eN) — resolved server-side, passed as argument", async () => {
    // Target element: CSS selector
    // click_first: ref e10 → resolved to objectId "obj-click-first"
    vi.mocked(a11yTree.resolveRef).mockReturnValue(42);
    (a11yTree as unknown as { resolveRefFull: { mockReturnValue: (v: unknown) => void } })
      .resolveRefFull.mockReturnValue({ backendNodeId: 42, sessionId: SESSION_ID });

    const { cdpClient, sendFn } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 100 } },
      "DOM.resolveNode": (args: { backendNodeId: number }) => {
        if (args.backendNodeId === 100) return { object: { objectId: "obj-target" } };
        if (args.backendNodeId === 42) return { object: { objectId: "obj-click-first" } };
        return { object: { objectId: "obj-unknown" } };
      },
      "Runtime.callFunctionOn": {
        result: { value: { changes: [{ type: "text", value: "mutated" }], count: 1 } },
      },
    });

    // Fix: mock send to pass args to the response function
    sendFn.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const responses: Record<string, unknown> = {
        "DOM.getDocument": { root: { nodeId: 1 } },
        "DOM.querySelector": { nodeId: 2 },
        "DOM.describeNode": { node: { backendNodeId: 100 } },
        "Runtime.callFunctionOn": {
          result: { value: { changes: [{ type: "text", value: "mutated" }], count: 1 } },
        },
      };
      if (method === "DOM.resolveNode") {
        const bid = (params as { backendNodeId: number })?.backendNodeId;
        if (bid === 42) return { object: { objectId: "obj-click-first" } };
        return { object: { objectId: "obj-target" } };
      }
      return responses[method] ?? {};
    });

    const params = {
      selector: "#test-target",
      duration: 100,
      click_first: "e10",
      collect: "text" as const,
      interval: 50,
      timeout: 10000,
    };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("mutated");

    // Verify Runtime.callFunctionOn was called with arguments containing the click_first objectId
    const callFn = sendFn.mock.calls.find((c) => c[0] === "Runtime.callFunctionOn");
    expect(callFn).toBeDefined();
    expect(callFn![1].arguments).toEqual([{ objectId: "obj-click-first" }]);

    // Verify the function declaration has clickFirstEl parameter
    expect(callFn![1].functionDeclaration).toContain("function(clickFirstEl)");
    expect(callFn![1].functionDeclaration).toContain("clickFirstEl.click()");

    // Verify no querySelector for click_first
    expect(callFn![1].functionDeclaration).not.toContain('document.querySelector("e10")');
  });

  it("then_click with ref (eN) — resolved server-side in until mode", async () => {
    // Target: CSS selector, then_click: ref e20
    vi.mocked(a11yTree.resolveRef).mockReturnValue(55);
    (a11yTree as unknown as { resolveRefFull: { mockReturnValue: (v: unknown) => void } })
      .resolveRefFull.mockReturnValue({ backendNodeId: 55, sessionId: SESSION_ID });

    const { cdpClient, sendFn } = createMockCdp();
    sendFn.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 100 } };
      if (method === "DOM.resolveNode") {
        const bid = (params as { backendNodeId: number })?.backendNodeId;
        if (bid === 55) return { object: { objectId: "obj-then-click" } };
        return { object: { objectId: "obj-target" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: { value: { met: true, value: "8", changes: [], clicked: true } },
        };
      }
      return {};
    });

    const params = {
      selector: "#counter",
      until: "el.textContent === '8'",
      then_click: "e20",
      collect: "text" as const,
      interval: 100,
      timeout: 10000,
    };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("Condition met");

    // Verify arguments contain the then_click objectId
    const callFn = sendFn.mock.calls.find((c) => c[0] === "Runtime.callFunctionOn");
    expect(callFn).toBeDefined();
    expect(callFn![1].arguments).toEqual([{ objectId: "obj-then-click" }]);

    // Verify function has thenClickEl parameter
    expect(callFn![1].functionDeclaration).toContain("thenClickEl");
    expect(callFn![1].functionDeclaration).toContain("thenClickEl.click()");
  });

  it("click_first + then_click both refs — both resolved, both in arguments", async () => {
    // resolveRefFull needs to return different values for e10 vs e20
    const resolveRefFullMock = vi.fn((ref: string) => {
      if (ref === "e10") return { backendNodeId: 42, sessionId: SESSION_ID };
      if (ref === "e20") return { backendNodeId: 55, sessionId: SESSION_ID };
      return undefined;
    });
    (a11yTree as unknown as { resolveRefFull: typeof resolveRefFullMock }).resolveRefFull = resolveRefFullMock;

    const { cdpClient, sendFn } = createMockCdp();
    sendFn.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 100 } };
      if (method === "DOM.resolveNode") {
        const bid = (params as { backendNodeId: number })?.backendNodeId;
        if (bid === 42) return { object: { objectId: "obj-cf" } };
        if (bid === 55) return { object: { objectId: "obj-tc" } };
        return { object: { objectId: "obj-target" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: { value: { met: true, value: "done", changes: [], clicked: true } },
        };
      }
      return {};
    });

    const params = {
      selector: "#counter",
      until: "el.textContent === 'done'",
      click_first: "e10",
      then_click: "e20",
      collect: "text" as const,
      interval: 100,
      timeout: 10000,
    };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBeUndefined();

    const callFn = sendFn.mock.calls.find((c) => c[0] === "Runtime.callFunctionOn");
    expect(callFn).toBeDefined();
    // Both objectIds in arguments array, click_first first, then_click second
    expect(callFn![1].arguments).toEqual([
      { objectId: "obj-cf" },
      { objectId: "obj-tc" },
    ]);
    // Function signature should have both params
    expect(callFn![1].functionDeclaration).toContain("function(clickFirstEl, thenClickEl)");
  });

  it("click_first with CSS selector that doesn't match — throws error instead of silent fail", async () => {
    const { cdpClient, sendFn } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 100 } },
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Runtime.callFunctionOn": {
        result: { value: null },
        exceptionDetails: {
          exception: { description: 'Error: click_first: element not found for selector "#nonexistent-btn"' },
        },
      },
    });

    const params = {
      selector: "#target",
      duration: 100,
      click_first: "#nonexistent-btn",
      collect: "text" as const,
      interval: 50,
      timeout: 10000,
    };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    // The error is surfaced as a JS error (thrown inside the browser)
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("click_first");
    expect((result.content[0] as { text: string }).text).toContain("element not found");
  });

  it("click_first ref not found — returns error immediately", async () => {
    // resolveRefFull returns undefined for e999 (not found)
    (a11yTree as unknown as { resolveRefFull: { mockReturnValue: (v: unknown) => void } })
      .resolveRefFull.mockReturnValue(undefined);

    const { cdpClient } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 100 } },
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
    });

    const params = {
      selector: "#target",
      duration: 100,
      click_first: "e999",
      collect: "text" as const,
      interval: 50,
      timeout: 10000,
    };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("click_first");
    expect((result.content[0] as { text: string }).text).toContain("not found");
  });

  it("then_click ref not found — returns error immediately", async () => {
    (a11yTree as unknown as { resolveRefFull: { mockReturnValue: (v: unknown) => void } })
      .resolveRefFull.mockReturnValue(undefined);

    const { cdpClient } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 100 } },
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
    });

    const params = {
      selector: "#counter",
      until: "el.textContent === '8'",
      then_click: "e999",
      collect: "text" as const,
      interval: 100,
      timeout: 10000,
    };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("then_click");
    expect((result.content[0] as { text: string }).text).toContain("not found");
  });

  it("CSS selector click_first still works (existing behavior preserved)", async () => {
    const { cdpClient, sendFn } = createMockCdp({
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 100 } },
      "DOM.resolveNode": { object: { objectId: "obj-1" } },
      "Runtime.callFunctionOn": {
        result: { value: { changes: [{ type: "text", value: "clicked" }], count: 1 } },
      },
    });

    const params = {
      selector: "#target",
      duration: 100,
      click_first: "#start-btn",
      collect: "text" as const,
      interval: 50,
      timeout: 10000,
    };
    const result = await observeHandler(params as ObserveParams, cdpClient, SESSION_ID);

    expect(result.isError).toBeUndefined();

    // Verify querySelector is used for CSS selectors (not function arguments)
    const callFn = sendFn.mock.calls.find((c) => c[0] === "Runtime.callFunctionOn");
    expect(callFn).toBeDefined();
    expect(callFn![1].functionDeclaration).toContain('document.querySelector("#start-btn")');
    // No arguments array for CSS selectors
    expect(callFn![1].arguments).toBeUndefined();
  });
});

// --- FR-021: buildCollectFunction / buildUntilFunction arg support ---

describe("FR-021: buildCollectFunction with clickFirstIsArg", () => {
  it("generates clickFirstEl parameter when clickFirstIsArg=true", () => {
    const fn = buildCollectFunction(1000, 100, "text", "e10", true);
    expect(fn).toContain("function(clickFirstEl)");
    expect(fn).toContain("clickFirstEl.click()");
    // Should NOT use querySelector for ref-resolved click_first
    expect(fn).not.toContain("document.querySelector");
  });

  it("generates error-throwing querySelector when clickFirstIsArg=false", () => {
    const fn = buildCollectFunction(1000, 100, "text", "#btn");
    expect(fn).toContain('document.querySelector("#btn")');
    expect(fn).toContain("throw new Error");
    expect(fn).toContain("click_first: element not found");
  });

  it("generates no click code when no clickFirst provided", () => {
    const fn = buildCollectFunction(1000, 100, "text");
    expect(fn).not.toContain("click");
    expect(fn).toContain("function()");
  });
});

describe("FR-021: buildUntilFunction with arg support", () => {
  it("generates clickFirstEl + thenClickEl when both are args", () => {
    const fn = buildUntilFunction("true", 5000, 100, "text", "e20", "e10", true, true);
    expect(fn).toContain("function(clickFirstEl, thenClickEl)");
    expect(fn).toContain("clickFirstEl.click()");
    expect(fn).toContain("thenClickEl.click()");
    expect(fn).not.toContain("document.querySelector");
  });

  it("generates error-throwing querySelector for CSS then_click", () => {
    const fn = buildUntilFunction("true", 5000, 100, "text", "#capture-btn");
    expect(fn).toContain('document.querySelector("#capture-btn")');
    expect(fn).toContain("throw new Error");
    expect(fn).toContain("then_click: element not found");
  });

  it("generates error-throwing querySelector for CSS click_first", () => {
    const fn = buildUntilFunction("true", 5000, 100, "text", undefined, "#start-btn");
    expect(fn).toContain('document.querySelector("#start-btn")');
    expect(fn).toContain("throw new Error");
    expect(fn).toContain("click_first: element not found");
  });

  it("only clickFirstEl param when only click_first is arg", () => {
    const fn = buildUntilFunction("true", 5000, 100, "text", "#css-btn", "e10", true, false);
    expect(fn).toContain("function(clickFirstEl)");
    expect(fn).not.toContain("thenClickEl");
    expect(fn).toContain("clickFirstEl.click()");
    // CSS then_click still uses querySelector
    expect(fn).toContain('document.querySelector("#css-btn")');
  });

  it("only thenClickEl param when only then_click is arg", () => {
    const fn = buildUntilFunction("true", 5000, 100, "text", "e20", "#css-start", false, true);
    expect(fn).toContain("function(thenClickEl)");
    expect(fn).not.toContain("clickFirstEl");
    expect(fn).toContain("thenClickEl.click()");
    // CSS click_first still uses querySelector
    expect(fn).toContain('document.querySelector("#css-start")');
  });
});
