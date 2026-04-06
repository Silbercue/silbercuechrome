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

vi.mock("../cache/a11y-tree.js", () => ({
  a11yTree: {
    classifyRef: vi.fn().mockReturnValue("clickable"),
    getInteractiveElements: vi.fn().mockReturnValue([]),
  },
}));

import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { a11yTree } from "../cache/a11y-tree.js";
const mockResolveElement = vi.mocked(resolveElement);
const mockBuildRefNotFoundError = vi.mocked(buildRefNotFoundError);
const mockGetInteractiveElements = vi.mocked(a11yTree.getInteractiveElements);

// --- Mock CDP client ---

type EventCallback = (params: unknown, sessionId?: string) => void;

interface MockCdpSetup {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
}

function createMockCdp(overrides: Record<string, unknown> = {}): MockCdpSetup {
  const defaultResponses: Record<string, unknown> = {
    "Runtime.evaluate": { result: { value: { sx: 0, sy: 0 } } },
    "DOM.scrollIntoViewIfNeeded": {},
    "DOM.getContentQuads": { quads: [[100, 100, 200, 100, 200, 200, 100, 200]] },
    "Input.dispatchMouseEvent": {},
    "DOM.getDocument": { root: { nodeId: 1 } },
    "DOM.querySelector": { nodeId: 42 },
    "DOM.describeNode": { node: { backendNodeId: 100 } },
    "Target.getTargets": { targetInfos: [{ targetId: "t1", type: "page", url: "https://example.com", title: "Test" }] },
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

    // Verify CDP calls: scrollTo(0,0), scroll, getContentQuads, 3x mouse — NO Page.getFrameTree
    expect(sendFn).toHaveBeenCalledWith("Runtime.evaluate", { expression: "window.scrollTo(0,0)" }, "s1");
    expect(sendFn).toHaveBeenCalledWith("DOM.scrollIntoViewIfNeeded", { backendNodeId: 42 }, "s1");
    expect(sendFn).toHaveBeenCalledWith("DOM.getContentQuads", { backendNodeId: 42 }, "s1");
    const callMethods = sendFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(callMethods).not.toContain("Page.getFrameTree");
  });

  it("should dispatch mouseMoved, mousePressed and mouseReleased with correct center coordinates", async () => {
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
    expect(mouseEvents).toHaveLength(3);

    // mouseMoved (establishes mouseenter/mouseover context)
    expect(mouseEvents[0][1]).toEqual({
      type: "mouseMoved",
      x: 150,
      y: 150,
      button: "none",
      buttons: 0,
    });

    // mousePressed
    expect(mouseEvents[1][1]).toEqual({
      type: "mousePressed",
      x: 150,
      y: 150,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });

    // mouseReleased
    expect(mouseEvents[2][1]).toEqual({
      type: "mouseReleased",
      x: 150,
      y: 150,
      button: "left",
      buttons: 0,
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

    // 8 CDP calls: Target.getTargets (before), scrollTo(0,0), scrollIntoView, getContentQuads, 3x mouse, Target.getTargets (after)
    expect(sendFn).toHaveBeenCalledTimes(8);
    const callMethods = sendFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(callMethods).toEqual([
      "Target.getTargets",
      "Runtime.evaluate",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getContentQuads",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Target.getTargets",
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

  it("should fallback to getBoundingClientRect when getContentQuads throws (BUG-005)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient, sendFn } = createMockCdp({
      "DOM.getContentQuads": () => {
        throw new Error("Node does not have a layout object");
      },
      "Runtime.callFunctionOn": () => ({
        result: { value: { x: 200, y: 300 } },
      }),
    });

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        text: "Clicked e5 (ref, fallback: js-rect)",
      }),
    );
    expect(result._meta?.clickMethod).toBe("js-rect");

    // Should have called Runtime.callFunctionOn for getBoundingClientRect
    const jsCall = sendFn.mock.calls.find(
      (c: unknown[]) => c[0] === "Runtime.callFunctionOn" && typeof c[1] === "object" &&
        (c[1] as Record<string, unknown>).objectId === "obj-42",
    );
    expect(jsCall).toBeDefined();

    // Should still dispatch mouse events at the JS-computed coordinates
    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(3);
    expect(mouseEvents[0][1]).toEqual(expect.objectContaining({ type: "mouseMoved", x: 200, y: 300 }));
    expect(mouseEvents[1][1]).toEqual(expect.objectContaining({ type: "mousePressed", x: 200, y: 300 }));
    expect(mouseEvents[2][1]).toEqual(expect.objectContaining({ type: "mouseReleased", x: 200, y: 300 }));
  });

  it("should fallback to JS click when both getContentQuads and getBoundingClientRect fail (BUG-005 Shadow-DOM)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    let callCount = 0;
    const { cdpClient, sendFn } = createMockCdp({
      "DOM.getContentQuads": () => {
        throw new Error("Node does not have a layout object");
      },
      "Runtime.callFunctionOn": () => {
        callCount++;
        if (callCount === 1) {
          // First call: getBoundingClientRect fails
          throw new Error("Cannot find context with specified id");
        }
        // Second call: this.click() succeeds
        return { result: { value: undefined } };
      },
    });

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        text: "Clicked e5 (ref, fallback: js-click)",
      }),
    );
    expect(result._meta?.clickMethod).toBe("js-click");

    // No mouse events dispatched — pure JS click
    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(0);
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

    // Mouse events use OOPIF session (mouseMoved + mousePressed + mouseReleased)
    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(3);
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

  // --- Human Touch integration tests (Story 8.5) ---

  it("clickHandler with humanTouch disabled behaves identically to default (9.1)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient, sendFn } = createMockCdp();

    const result = await clickHandler(
      { ref: "e5" },
      cdpClient,
      "s1",
      undefined,
      { enabled: false, speedProfile: "normal" },
    );

    expect(result.isError).toBeUndefined();
    // 8 CDP calls: Target.getTargets (before), scrollTo, scrollIntoView, getContentQuads, 3x mouse, Target.getTargets (after)
    expect(sendFn).toHaveBeenCalledTimes(8);
    const callMethods = sendFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(callMethods).toEqual([
      "Target.getTargets",
      "Runtime.evaluate",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getContentQuads",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Target.getTargets",
    ]);
  });

  it("clickHandler with humanTouch enabled dispatches mouseMoved events before mousePressed (9.2)", async () => {
    vi.useFakeTimers();
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient, sendFn } = createMockCdp();

    const promise = clickHandler(
      { ref: "e5" },
      cdpClient,
      "s1",
      undefined,
      { enabled: true, speedProfile: "fast" },
    );
    await vi.advanceTimersByTimeAsync(10000);
    const result = await promise;

    expect(result.isError).toBeUndefined();

    // Should have mouseMoved events before mousePressed
    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );

    // At least 10 humanTouch mouseMoved + 1 explicit mouseMoved + 1 mousePressed + 1 mouseReleased = 13+
    expect(mouseEvents.length).toBeGreaterThanOrEqual(13);

    // Find the indices of mousePressed and first mouseMoved
    const firstMoveIdx = mouseEvents.findIndex(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === "mouseMoved",
    );
    const pressedIdx = mouseEvents.findIndex(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === "mousePressed",
    );
    expect(firstMoveIdx).toBeLessThan(pressedIdx);

    vi.useRealTimers();
  });

  // --- FR-008: Interactive element suggestions on CSS selector failure ---

  it("should include available interactive elements when CSS selector not found (FR-008)", async () => {
    mockResolveElement.mockRejectedValue(
      new Error("Element not found for selector '#t2-1-verify'"),
    );
    mockGetInteractiveElements.mockReturnValue([
      "[e52] button 'Load Data'",
      "[e53] textbox 'Enter loaded value...'",
      "[e54] button 'Verify'",
    ]);
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ selector: "#t2-1-verify" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Element not found for selector '#t2-1-verify'");
    expect(text).toContain("Available interactive elements:");
    expect(text).toContain("[e52] button 'Load Data'");
    expect(text).toContain("[e53] textbox 'Enter loaded value...'");
    expect(text).toContain("[e54] button 'Verify'");
    expect(mockGetInteractiveElements).toHaveBeenCalledWith(8);
  });

  it("should not include element hints when no interactive elements are known (FR-008)", async () => {
    mockResolveElement.mockRejectedValue(
      new Error("Element not found for selector '.nonexistent'"),
    );
    mockGetInteractiveElements.mockReturnValue([]);
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ selector: ".nonexistent" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("click failed: Element not found for selector '.nonexistent'");
    expect(text).not.toContain("Available interactive elements");
  });

  // --- FR-D: Coordinate-based click tests ---

  it("should click at viewport coordinates without element resolution (FR-D)", async () => {
    const { cdpClient, sendFn } = createMockCdp();

    const result = await clickHandler({ x: 250, y: 100 }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: "Clicked at (250, 100)" }),
    );
    expect(result._meta?.clickMethod).toBe("coordinates");

    // Should NOT call resolveElement
    expect(mockResolveElement).not.toHaveBeenCalled();

    // Should dispatch mouse events at exact coordinates
    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(3);
    expect(mouseEvents[0][1]).toEqual(expect.objectContaining({ type: "mouseMoved", x: 250, y: 100 }));
    expect(mouseEvents[1][1]).toEqual(expect.objectContaining({ type: "mousePressed", x: 250, y: 100 }));
    expect(mouseEvents[2][1]).toEqual(expect.objectContaining({ type: "mouseReleased", x: 250, y: 100 }));
  });

  it("should prefer coordinates over ref when both provided (FR-D)", async () => {
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ ref: "e5", x: 100, y: 200 }, cdpClient, "s1");

    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: "Clicked at (100, 200)" }),
    );
    expect(mockResolveElement).not.toHaveBeenCalled();
  });

  // --- FR-E: New tab detection tests ---

  it("should report new tab when click opens one (FR-E)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "link",
      name: "Open in new tab",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    let callCount = 0;
    const { cdpClient } = createMockCdp({
      "Target.getTargets": () => {
        callCount++;
        if (callCount === 1) {
          return { targetInfos: [{ targetId: "t1", type: "page", url: "https://example.com", title: "Main" }] };
        }
        // After click: new tab appeared
        return {
          targetInfos: [
            { targetId: "t1", type: "page", url: "https://example.com", title: "Main" },
            { targetId: "t2", type: "page", url: "https://other.com", title: "Other" },
          ],
        };
      },
    });

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("New tab opened");
    expect(text).toContain("https://other.com");
    expect(text).toContain("switch_tab");
  });

  it("should not report new tab when click stays on same page (FR-E)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("New tab");
  });

  it("should not include element hints for non-selector errors (FR-008)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "css",
      resolvedSessionId: "s1",
    });
    mockGetInteractiveElements.mockReturnValue([
      "[e1] button 'Click me'",
    ]);
    const { cdpClient } = createMockCdp({
      "DOM.scrollIntoViewIfNeeded": () => {
        throw new Error("Could not find node with given id");
      },
    });

    const result = await clickHandler({ selector: "#btn" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("Available interactive elements");
  });
});
