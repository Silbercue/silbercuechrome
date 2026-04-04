import { describe, it, expect, vi, beforeEach } from "vitest";
import { clickSchema, clickHandler } from "./click.js";
import type { ClickParams } from "./click.js";
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
    buildRefNotFoundError: vi.fn(),
    RefNotFoundError,
  };
});

import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
const mockResolveElement = vi.mocked(resolveElement);
const mockBuildRefNotFoundError = vi.mocked(buildRefNotFoundError);

// --- Mock CDP client ---

type EventCallback = (params: unknown, sessionId?: string) => void;

interface MockCdpSetup {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
}

function createMockCdp(overrides: Record<string, unknown> = {}): MockCdpSetup {
  const defaultResponses: Record<string, unknown> = {
    "Runtime.evaluate": {},
    "DOM.scrollIntoViewIfNeeded": {},
    "DOM.getContentQuads": { quads: [[100, 100, 200, 100, 200, 200, 100, 200]] },
    "Input.dispatchMouseEvent": {},
    "DOM.getDocument": { root: { nodeId: 1 } },
    "DOM.querySelector": { nodeId: 42 },
    "DOM.describeNode": { node: { backendNodeId: 100 } },
    ...overrides,
  };

  const listeners = new Map<string, Set<{ callback: EventCallback; sessionId?: string }>>();

  const sendFn = vi.fn(async (method: string) => {
    if (method in defaultResponses) {
      const val = defaultResponses[method];
      if (typeof val === "function") return (val as () => unknown)();
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

  return { cdpClient, sendFn };
}

describe("clickSchema", () => {
  it("should accept only ref", () => {
    const result = clickSchema.parse({ ref: "e5" });
    expect(result.ref).toBe("e5");
    expect(result.selector).toBeUndefined();
  });

  it("should accept only selector", () => {
    const result = clickSchema.parse({ selector: "#btn" });
    expect(result.selector).toBe("#btn");
    expect(result.ref).toBeUndefined();
  });

  it("should accept both ref and selector", () => {
    const result = clickSchema.parse({ ref: "e5", selector: "#btn" });
    expect(result.ref).toBe("e5");
    expect(result.selector).toBe("#btn");
  });

  it("should accept empty object (validation in handler)", () => {
    const result = clickSchema.parse({});
    expect(result.ref).toBeUndefined();
    expect(result.selector).toBeUndefined();
  });
});

describe("clickHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Validation tests ---

  it("should return isError when neither ref nor selector provided", async () => {
    const { cdpClient } = createMockCdp();
    const result = await clickHandler({} as ClickParams, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("click requires either 'ref'"),
      }),
    );
    expect(result._meta?.elapsedMs).toBe(0);
    expect(result._meta?.method).toBe("click");
  });

  // --- Ref click tests (AC #1) ---

  it("should click element by ref and return immediately without settle", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient, sendFn } = createMockCdp();

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: "Clicked e5 (ref)" }),
    );
    expect(result._meta?.method).toBe("click");
    expect(result._meta?.resolvedVia).toBe("ref");
    // No settle — no settleSignal or settleMs in _meta
    expect(result._meta).not.toHaveProperty("settleSignal");
    expect(result._meta).not.toHaveProperty("settleMs");

    // Verify CDP calls: scrollTo(0,0), scroll, getContentQuads, 2x mouse — NO Page.getFrameTree
    expect(sendFn).toHaveBeenCalledWith("Runtime.evaluate", { expression: "window.scrollTo(0,0)" }, "s1");
    expect(sendFn).toHaveBeenCalledWith("DOM.scrollIntoViewIfNeeded", { backendNodeId: 42 }, "s1");
    expect(sendFn).toHaveBeenCalledWith("DOM.getContentQuads", { backendNodeId: 42 }, "s1");
    const callMethods = sendFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(callMethods).not.toContain("Page.getFrameTree");
  });

  it("should dispatch mousePressed and mouseReleased with correct center coordinates", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    // getContentQuads returns quad [100,100, 200,100, 200,200, 100,200]
    // Center: x = (100+200+200+100)/4 = 150, y = (100+100+200+200)/4 = 150
    const { cdpClient, sendFn } = createMockCdp();

    await clickHandler({ ref: "e5" }, cdpClient, "s1");

    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(2);

    // mousePressed
    expect(mouseEvents[0][1]).toEqual({
      type: "mousePressed",
      x: 150,
      y: 150,
      button: "left",
      clickCount: 1,
    });

    // mouseReleased
    expect(mouseEvents[1][1]).toEqual({
      type: "mouseReleased",
      x: 150,
      y: 150,
      button: "left",
      clickCount: 1,
    });
  });

  it("should not call settle or Page.getFrameTree", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient, sendFn } = createMockCdp();

    await clickHandler({ ref: "e5" }, cdpClient, "s1");

    // 5 CDP calls: scrollTo(0,0), scrollIntoView, getContentQuads, mousePressed, mouseReleased
    expect(sendFn).toHaveBeenCalledTimes(5);
    const callMethods = sendFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(callMethods).toEqual([
      "Runtime.evaluate",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getContentQuads",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
  });

  // --- CSS click tests (AC #2) ---

  it("should click element by CSS selector successfully", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 100,
      objectId: "obj-100",
      role: "",
      name: "",
      resolvedVia: "css",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ selector: "#submit-btn" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: "Clicked #submit-btn (css)" }),
    );
    expect(result._meta?.resolvedVia).toBe("css");

    // Verify resolveElement was called with selector target
    expect(mockResolveElement).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      { selector: "#submit-btn" },
      undefined,
    );
  });

  it("should return isError when CSS selector not found", async () => {
    mockResolveElement.mockRejectedValue(
      new Error("Element not found for selector '.nonexistent'"),
    );
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ selector: ".nonexistent" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "click failed: Element not found for selector '.nonexistent'",
      }),
    );
  });

  // --- Contextual error message tests (AC #3) ---

  it("should include suggestion with role and name when ref not found", async () => {
    mockResolveElement.mockRejectedValue(
      new RefNotFoundError("Element e99 not found."),
    );
    mockBuildRefNotFoundError.mockReturnValue(
      "Element e99 not found. Did you mean e5 (button 'Submit')?",
    );
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ ref: "e99" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "Element e99 not found. Did you mean e5 (button 'Submit')?",
      }),
    );
  });

  it("should show error without suggestion when buildRefNotFoundError returns no suggestion", async () => {
    mockResolveElement.mockRejectedValue(
      new RefNotFoundError("Element e99 not found."),
    );
    mockBuildRefNotFoundError.mockReturnValue("Element e99 not found.");
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ ref: "e99" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "Element e99 not found.",
      }),
    );
  });

  // --- Priority tests ---

  it("should use ref when both ref and selector are provided", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ ref: "e5", selector: "#btn" }, cdpClient, "s1");

    expect(result._meta?.resolvedVia).toBe("ref");
    // resolveElement should be called with ref target (not selector)
    expect(mockResolveElement).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      { ref: "e5" },
      undefined,
    );
  });

  // --- Error handling tests ---

  it("should return isError when DOM.getContentQuads throws in dispatchClick", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp({
      "DOM.getContentQuads": () => {
        throw new Error("Node does not have a layout object");
      },
    });

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "click failed: Node does not have a layout object",
      }),
    );
    expect(result._meta?.method).toBe("click");
  });

  it("should return isError when DOM.scrollIntoViewIfNeeded throws", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp({
      "DOM.scrollIntoViewIfNeeded": () => {
        throw new Error("Could not find node with given id");
      },
    });

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "click failed: Could not find node with given id",
      }),
    );
  });

  // --- OOPIF tests ---

  it("click resolves OOPIF element and uses correct session", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 300,
      objectId: "obj-300",
      role: "button",
      name: "Sign In",
      resolvedVia: "ref",
      resolvedSessionId: "oopif-session-1",
    });
    const { cdpClient, sendFn } = createMockCdp();
    const mockSessionManager = {} as unknown as import("../cdp/session-manager.js").SessionManager;

    const result = await clickHandler({ ref: "e42" }, cdpClient, "s1", mockSessionManager);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: "Clicked e42 (ref)" }),
    );

    // Verify CDP calls use OOPIF session for element interaction
    expect(sendFn).toHaveBeenCalledWith(
      "Runtime.evaluate",
      { expression: "window.scrollTo(0,0)" },
      "oopif-session-1",
    );
    expect(sendFn).toHaveBeenCalledWith(
      "DOM.scrollIntoViewIfNeeded",
      { backendNodeId: 300 },
      "oopif-session-1",
    );
    expect(sendFn).toHaveBeenCalledWith(
      "DOM.getContentQuads",
      { backendNodeId: 300 },
      "oopif-session-1",
    );

    // Mouse events use OOPIF session
    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(2);
    expect(mouseEvents[0][2]).toBe("oopif-session-1");

    // No settle — no Page.getFrameTree call
    const callMethods = sendFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(callMethods).not.toContain("Page.getFrameTree");

    // resolveElement was called with sessionManager
    expect(mockResolveElement).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      { ref: "e42" },
      mockSessionManager,
    );
  });
});
