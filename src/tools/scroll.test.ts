import { describe, it, expect, vi, beforeEach } from "vitest";
import { scrollSchema, scrollHandler } from "./scroll.js";
import type { CdpClient } from "../cdp/cdp-client.js";

// --- Mock element-utils ---

vi.mock("./element-utils.js", () => {
  class RefNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RefNotFoundError";
    }
  }
  return {
    resolveElement: vi.fn(),
    buildRefNotFoundError: vi.fn().mockReturnValue("Element not found."),
    RefNotFoundError,
  };
});

import { resolveElement } from "./element-utils.js";
const mockResolveElement = vi.mocked(resolveElement);

function createMockCdp(overrides: Record<string, unknown> = {}) {
  const defaultResponses: Record<string, unknown> = {
    "Runtime.evaluate": {
      result: { value: { scrollY: 500, scrollHeight: 2000, clientHeight: 800, prevScrollHeight: 2000 } },
    },
    "Runtime.callFunctionOn": {},
    "DOM.scrollIntoViewIfNeeded": {},
    ...overrides,
  };

  const sendFn = vi.fn(async (method: string) => {
    if (method in defaultResponses) {
      const val = defaultResponses[method];
      if (typeof val === "function") return (val as () => unknown)();
      return val;
    }
    return {};
  });

  const cdpClient = {
    send: sendFn,
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;

  return { cdpClient, sendFn };
}

describe("scrollSchema", () => {
  it("should accept empty object (defaults)", () => {
    const result = scrollSchema.parse({});
    expect(result.ref).toBeUndefined();
    expect(result.direction).toBeUndefined();
  });

  it("should accept ref", () => {
    const result = scrollSchema.parse({ ref: "e42" });
    expect(result.ref).toBe("e42");
  });

  it("should accept direction and amount", () => {
    const result = scrollSchema.parse({ direction: "up", amount: 300 });
    expect(result.direction).toBe("up");
    expect(result.amount).toBe(300);
  });
});

describe("scrollHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should scroll element into view by ref", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "listitem",
      name: "Item 30",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient, sendFn } = createMockCdp();

    const result = await scrollHandler({ ref: "e42" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: "Scrolled e42 into view" }),
    );
    expect(sendFn).toHaveBeenCalledWith("DOM.scrollIntoViewIfNeeded", { backendNodeId: 42 }, "s1");
  });

  it("should scroll page down by default amount", async () => {
    const { cdpClient, sendFn } = createMockCdp();

    const result = await scrollHandler({ direction: "down" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("Scrolled down 500px") }),
    );
    expect(sendFn).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        expression: expect.stringContaining("scrollBy(0, 500)"),
        awaitPromise: true,
      }),
      "s1",
    );
  });

  it("should scroll page up by custom amount", async () => {
    const { cdpClient, sendFn } = createMockCdp();

    const result = await scrollHandler({ direction: "up", amount: 300 }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("Scrolled up 300px") }),
    );
    expect(sendFn).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        expression: expect.stringContaining("scrollBy(0, -300)"),
        awaitPromise: true,
      }),
      "s1",
    );
  });

  it("should default to scrolling down when no params given", async () => {
    const { cdpClient } = createMockCdp();

    const result = await scrollHandler({}, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("Scrolled down 500px") }),
    );
  });

  it("should report scroll position in response", async () => {
    const { cdpClient } = createMockCdp();

    const result = await scrollHandler({ direction: "down" }, cdpClient, "s1");

    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("position: 500/1200px") }),
    );
  });

  // --- FR-027: Browser-side settle tests ---

  it("should use async IIFE with awaitPromise and setTimeout settle for page scroll", async () => {
    const { cdpClient, sendFn } = createMockCdp();

    await scrollHandler({ direction: "down" }, cdpClient, "s1");

    const call = sendFn.mock.calls.find(c => c[0] === "Runtime.evaluate")!;
    const params = call[1] as { expression: string; awaitPromise: boolean };
    expect(params.awaitPromise).toBe(true);
    expect(params.expression).toContain("async");
    expect(params.expression).toContain("setTimeout");
    expect(params.expression).toContain("prevScrollHeight");
  });

  it("should use pure evaluate with querySelector for container_selector scroll", async () => {
    const { cdpClient, sendFn } = createMockCdp({
      "Runtime.evaluate": {
        result: { value: { scrollTop: 500, scrollHeight: 2000, clientHeight: 800, prevScrollHeight: 2000 } },
      },
    });

    await scrollHandler({ container_selector: ".my-list", direction: "down" }, cdpClient, "s1");

    // No callFunctionOn — pure evaluate with querySelector
    const cfoCalls = sendFn.mock.calls.filter(c => c[0] === "Runtime.callFunctionOn");
    expect(cfoCalls).toHaveLength(0);

    // Single async evaluate with scrollBy + setTimeout settle
    const evalCalls = sendFn.mock.calls.filter(c => c[0] === "Runtime.evaluate");
    expect(evalCalls).toHaveLength(1);
    const evalParams = evalCalls[0][1] as { expression: string; awaitPromise: boolean };
    expect(evalParams.awaitPromise).toBe(true);
    expect(evalParams.expression).toContain("async");
    expect(evalParams.expression).toContain("setTimeout");
    expect(evalParams.expression).toContain("scrollBy");
    expect(evalParams.expression).toContain(".my-list");
  });

  it("should report scrollHeight growth when content was lazy-loaded (page scroll)", async () => {
    const { cdpClient } = createMockCdp({
      "Runtime.evaluate": {
        result: { value: { scrollY: 500, scrollHeight: 3000, clientHeight: 800, prevScrollHeight: 2000 } },
      },
    });

    const result = await scrollHandler({ direction: "down" }, cdpClient, "s1");

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("content loaded: scrollHeight grew by 1000px");
  });

  it("should NOT report scrollHeight growth when no lazy loading occurred", async () => {
    const { cdpClient } = createMockCdp();

    const result = await scrollHandler({ direction: "down" }, cdpClient, "s1");

    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("content loaded");
  });

  it("should report scrollHeight growth for container scroll", async () => {
    const { cdpClient } = createMockCdp({
      "Runtime.evaluate": {
        result: { value: { scrollTop: 500, scrollHeight: 3000, clientHeight: 800, prevScrollHeight: 2000 } },
      },
    });

    const result = await scrollHandler({ container_selector: ".my-list", direction: "down" }, cdpClient, "s1");

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("content loaded: scrollHeight grew by 1000px");
  });
});
