import { describe, it, expect, vi, beforeEach } from "vitest";
import { typeSchema, typeHandler } from "./type.js";
import type { TypeParams } from "./type.js";
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
    "DOM.focus": {},
    "Input.insertText": {},
    "Runtime.callFunctionOn": { result: { value: undefined } },
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

// --- Helper: default resolved element ---

function mockTextbox(overrides: Partial<{ backendNodeId: number; objectId: string; role: string; name: string; resolvedSessionId: string }> = {}) {
  return {
    backendNodeId: 42,
    objectId: "obj-42",
    role: "textbox",
    name: "Email",
    resolvedVia: "ref" as const,
    resolvedSessionId: "s1",
    ...overrides,
  };
}

// ============================================================
// Schema tests
// ============================================================

describe("typeSchema", () => {
  it("should require text parameter", () => {
    expect(() => typeSchema.parse({})).toThrow();
  });

  it("should default clear to false", () => {
    const result = typeSchema.parse({ text: "hello" });
    expect(result.clear).toBe(false);
  });

  it("should accept text + ref", () => {
    const result = typeSchema.parse({ ref: "e12", text: "hello" });
    expect(result.ref).toBe("e12");
    expect(result.text).toBe("hello");
  });

  it("should accept text + selector", () => {
    const result = typeSchema.parse({ selector: "input[name='email']", text: "test" });
    expect(result.selector).toBe("input[name='email']");
    expect(result.text).toBe("test");
  });

  it("should accept clear: true", () => {
    const result = typeSchema.parse({ ref: "e1", text: "x", clear: true });
    expect(result.clear).toBe(true);
  });
});

// ============================================================
// Handler tests
// ============================================================

describe("typeHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Validation tests (AC #6, #7, #8) ---

  it("should return isError when text parameter is missing (AC #6)", async () => {
    const { cdpClient } = createMockCdp();
    // Simulate direct call without Zod parsing — text is undefined
    const result = await typeHandler(
      { ref: "e12", text: undefined as unknown as string, clear: false } as TypeParams,
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "type requires a 'text' parameter",
      }),
    );
    expect(result._meta?.method).toBe("type");
  });

  it("should return isError when neither ref nor selector provided", async () => {
    const { cdpClient } = createMockCdp();
    const result = await typeHandler({ text: "hello", clear: false } as TypeParams, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "type requires either 'ref' or 'selector' to identify the target element",
      }),
    );
    expect(result._meta?.elapsedMs).toBe(0);
    expect(result._meta?.method).toBe("type");
  });

  it("should prefer ref when both ref and selector are provided (AC #8)", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient } = createMockCdp();

    await typeHandler({ ref: "e12", selector: "input", text: "hello", clear: false }, cdpClient, "s1");

    expect(mockResolveElement).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      { ref: "e12" },
      undefined,
    );
  });

  // --- Ref path tests (AC #1) ---

  it("should type text into element by ref successfully", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient, sendFn } = createMockCdp();

    const result = await typeHandler({ ref: "e12", text: "hello@example.com", clear: false }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Typed \"hello@example.com\""),
      }),
    );
    expect(result._meta?.method).toBe("type");

    // Verify DOM.focus was called
    expect(sendFn).toHaveBeenCalledWith("DOM.focus", { backendNodeId: 42 }, "s1");
    // Verify Input.insertText was called
    expect(sendFn).toHaveBeenCalledWith("Input.insertText", { text: "hello@example.com" }, "s1");
  });

  it("should return isError when ref not found with input-field suggestion (AC #3)", async () => {
    mockResolveElement.mockRejectedValue(
      new RefNotFoundError("Element e999 not found."),
    );
    mockBuildRefNotFoundError.mockReturnValue(
      "Element e999 not found. Did you mean e42 (textbox 'Email')?",
    );
    const { cdpClient } = createMockCdp();

    const result = await typeHandler({ ref: "e999", text: "test", clear: false }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "Element e999 not found. Did you mean e42 (textbox 'Email')?",
      }),
    );
    // Verify roleFilter was passed to buildRefNotFoundError
    expect(mockBuildRefNotFoundError).toHaveBeenCalledWith(
      "e999",
      new Set(["textbox", "searchbox", "combobox", "spinbutton"]),
    );
  });

  it("should return isError when ref resolves to non-input element (AC #9)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp();

    const result = await typeHandler({ ref: "e5", text: "test", clear: false }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "Element e5 is not a text input (role: button). Expected textbox, searchbox, combobox, or spinbutton.",
      }),
    );
  });

  // --- CSS path tests (AC #2) ---

  it("should type text into element by CSS selector successfully", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 100,
      objectId: "obj-100",
      role: "",
      name: "",
      resolvedVia: "css",
      resolvedSessionId: "s1",
    });
    const { cdpClient, sendFn } = createMockCdp();

    const result = await typeHandler(
      { selector: "input[name='email']", text: "test", clear: false },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Typed \"test\""),
      }),
    );

    expect(mockResolveElement).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      { selector: "input[name='email']" },
      undefined,
    );
    expect(sendFn).toHaveBeenCalledWith("DOM.focus", { backendNodeId: 100 }, "s1");
    expect(sendFn).toHaveBeenCalledWith("Input.insertText", { text: "test" }, "s1");
  });

  it("should return isError when CSS selector not found", async () => {
    mockResolveElement.mockRejectedValue(
      new Error("Element not found for selector '.nonexistent'"),
    );
    const { cdpClient } = createMockCdp();

    const result = await typeHandler(
      { selector: ".nonexistent", text: "test", clear: false },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "type failed: Element not found for selector '.nonexistent'",
      }),
    );
  });

  it("should skip role check for CSS-resolved elements", async () => {
    // CSS path returns empty role — should NOT trigger role-check error
    mockResolveElement.mockResolvedValue({
      backendNodeId: 100,
      objectId: "obj-100",
      role: "",
      name: "",
      resolvedVia: "css",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp();

    const result = await typeHandler(
      { selector: "input", text: "test", clear: false },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
  });

  // --- Clear tests (AC #4, #5) ---

  it("should clear field before typing when clear: true (AC #4)", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient, sendFn } = createMockCdp();

    await typeHandler({ ref: "e12", text: "new text", clear: true }, cdpClient, "s1");

    // Verify Runtime.callFunctionOn (clear) was called before Input.insertText
    const callMethods = sendFn.mock.calls.map((c: unknown[]) => c[0]);
    const clearIdx = callMethods.indexOf("Runtime.callFunctionOn");
    const insertIdx = callMethods.indexOf("Input.insertText");

    expect(clearIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(clearIdx);

    // Verify clear call args
    expect(sendFn).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({
        objectId: "obj-42",
        returnByValue: true,
      }),
      "s1",
    );
  });

  it("should not clear field when clear: false (AC #5)", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient, sendFn } = createMockCdp();

    await typeHandler({ ref: "e12", text: "appended", clear: false }, cdpClient, "s1");

    // No Runtime.callFunctionOn should be called
    const clearCalls = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Runtime.callFunctionOn",
    );
    expect(clearCalls).toHaveLength(0);
  });

  it("should clear field with empty text when clear: true and text is empty", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient, sendFn } = createMockCdp();

    const result = await typeHandler({ ref: "e12", text: "", clear: true }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();

    // Clear should be called
    const clearCalls = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Runtime.callFunctionOn",
    );
    expect(clearCalls).toHaveLength(1);

    // InsertText should NOT be called for empty string
    const insertCalls = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.insertText",
    );
    expect(insertCalls).toHaveLength(0);
  });

  // --- Text input tests (AC #1, #2) ---

  it("should call Input.insertText with correct text", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient, sendFn } = createMockCdp();

    await typeHandler({ ref: "e12", text: "hello world", clear: false }, cdpClient, "s1");

    expect(sendFn).toHaveBeenCalledWith("Input.insertText", { text: "hello world" }, "s1");
  });

  it("should truncate long text in response (>50 chars)", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient } = createMockCdp();
    const longText = "a".repeat(60);

    const result = await typeHandler({ ref: "e12", text: longText, clear: false }, cdpClient, "s1");

    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("a".repeat(50) + "..."),
      }),
    );
  });

  it("should not truncate text <= 50 chars", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient } = createMockCdp();

    const result = await typeHandler({ ref: "e12", text: "short", clear: false }, cdpClient, "s1");

    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("\"short\""),
      }),
    );
    // Should NOT contain "..."
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("...");
  });

  // --- No settle test (AC #10) ---

  it("should NOT call settle or Page.getFrameTree after typing", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient, sendFn } = createMockCdp();

    await typeHandler({ ref: "e12", text: "hello", clear: false }, cdpClient, "s1");

    // No Page.getFrameTree or Page.lifecycleEvent listener
    const frameTreeCalls = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Page.getFrameTree",
    );
    expect(frameTreeCalls).toHaveLength(0);
  });

  // --- Error handling tests (AC #3, #9) ---

  it("should return isError when DOM.focus fails", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient } = createMockCdp({
      "DOM.focus": () => {
        throw new Error("Element is not focusable");
      },
    });

    const result = await typeHandler({ ref: "e12", text: "test", clear: false }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Could not focus element e12"),
      }),
    );
  });

  it("should return isError when Input.insertText fails", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient } = createMockCdp({
      "Input.insertText": () => {
        throw new Error("Input.insertText failed");
      },
    });

    const result = await typeHandler({ ref: "e12", text: "test", clear: false }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "type failed: Input.insertText failed",
      }),
    );
  });

  // --- _meta tests ---

  it("should include _meta with method=type and cleared flag", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient } = createMockCdp();

    const result = await typeHandler({ ref: "e12", text: "hello", clear: true }, cdpClient, "s1");

    expect(result._meta?.method).toBe("type");
    expect(result._meta?.cleared).toBe(true);
    expect(typeof result._meta?.elapsedMs).toBe("number");
  });

  it("should include cleared: false in _meta when clear is false", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient } = createMockCdp();

    const result = await typeHandler({ ref: "e12", text: "hello", clear: false }, cdpClient, "s1");

    expect(result._meta?.cleared).toBe(false);
  });

  // --- Human Touch integration tests (Story 8.5) ---

  it("typeHandler with humanTouch disabled behaves identically to default (9.3)", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient, sendFn } = createMockCdp();

    const result = await typeHandler(
      { ref: "e12", text: "hello", clear: false },
      cdpClient,
      "s1",
      undefined,
      { enabled: false, speedProfile: "normal" },
    );

    expect(result.isError).toBeUndefined();
    // Should use Input.insertText (existing behavior)
    expect(sendFn).toHaveBeenCalledWith("Input.insertText", { text: "hello" }, "s1");
    // No Input.dispatchKeyEvent calls
    const keyEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(0);
  });

  it("typeHandler with humanTouch enabled dispatches keyEvent instead of insertText (9.4)", async () => {
    vi.useFakeTimers();
    mockResolveElement.mockResolvedValue(mockTextbox());
    const { cdpClient, sendFn } = createMockCdp();

    const promise = typeHandler(
      { ref: "e12", text: "hi", clear: false },
      cdpClient,
      "s1",
      undefined,
      { enabled: true, speedProfile: "fast" },
    );
    await vi.advanceTimersByTimeAsync(30000);
    const result = await promise;

    expect(result.isError).toBeUndefined();

    // Should NOT use Input.insertText
    const insertCalls = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.insertText",
    );
    expect(insertCalls).toHaveLength(0);

    // Should use Input.dispatchKeyEvent (2 chars * 3 events = 6)
    const keyEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(6);

    vi.useRealTimers();
  });

  // --- OOPIF tests ---

  it("type resolves OOPIF element and uses correct session", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 300,
      objectId: "obj-300",
      role: "textbox",
      name: "Email",
      resolvedVia: "ref",
      resolvedSessionId: "oopif-session-1",
    });
    const { cdpClient, sendFn } = createMockCdp();
    const mockSessionManager = {} as unknown as import("../cdp/session-manager.js").SessionManager;

    const result = await typeHandler(
      { ref: "e42", text: "user@example.com", clear: true },
      cdpClient,
      "s1",
      mockSessionManager,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Typed \"user@example.com\""),
      }),
    );

    // Verify DOM.focus uses OOPIF session
    expect(sendFn).toHaveBeenCalledWith(
      "DOM.focus",
      { backendNodeId: 300 },
      "oopif-session-1",
    );

    // Verify Runtime.callFunctionOn (clear) uses OOPIF session
    expect(sendFn).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({
        objectId: "obj-300",
        returnByValue: true,
      }),
      "oopif-session-1",
    );

    // Verify Input.insertText uses OOPIF session
    expect(sendFn).toHaveBeenCalledWith(
      "Input.insertText",
      { text: "user@example.com" },
      "oopif-session-1",
    );

    // resolveElement was called with sessionManager
    expect(mockResolveElement).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      { ref: "e42" },
      mockSessionManager,
    );
  });
});
