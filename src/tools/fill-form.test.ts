import { describe, it, expect, vi, beforeEach } from "vitest";
import { fillFormSchema, fillFormHandler } from "./fill-form.js";
import type { FillFormParams } from "./fill-form.js";
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

vi.mock("./error-utils.js", () => ({
  wrapCdpError: vi.fn((err: unknown, toolName: string) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("CdpClient is closed")) {
      return "CDP connection lost. The server is attempting to reconnect. Retry your request in a few seconds.";
    }
    return `${toolName} failed: ${message}`;
  }),
}));

import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { wrapCdpError } from "./error-utils.js";
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
    "Runtime.callFunctionOn": { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } },
    "Runtime.evaluate": {},
    "DOM.scrollIntoViewIfNeeded": {},
    "DOM.getContentQuads": { quads: [[100, 100, 200, 100, 200, 200, 100, 200]] },
    "Input.dispatchMouseEvent": {},
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

// --- Helper: mock resolved elements ---

function mockTextbox(overrides: Partial<{
  backendNodeId: number;
  objectId: string;
  role: string;
  name: string;
  resolvedSessionId: string;
  resolvedVia: "ref" | "css";
}> = {}) {
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

describe("fillFormSchema", () => {
  it("should require at least one field", () => {
    expect(() => fillFormSchema.parse({ fields: [] })).toThrow();
  });

  it("should accept a single field with ref and string value", () => {
    const result = fillFormSchema.parse({
      fields: [{ ref: "e5", value: "Max" }],
    });
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].ref).toBe("e5");
    expect(result.fields[0].value).toBe("Max");
  });

  it("should accept boolean values for checkbox/radio", () => {
    const result = fillFormSchema.parse({
      fields: [{ ref: "e10", value: true }],
    });
    expect(result.fields[0].value).toBe(true);
  });

  it("should accept number values", () => {
    const result = fillFormSchema.parse({
      fields: [{ ref: "e10", value: 42 }],
    });
    expect(result.fields[0].value).toBe(42);
  });

  it("should accept selector instead of ref", () => {
    const result = fillFormSchema.parse({
      fields: [{ selector: "#email", value: "test@test.de" }],
    });
    expect(result.fields[0].selector).toBe("#email");
  });
});

// ============================================================
// Handler tests
// ============================================================

describe("fillFormHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- AC #1: Multiple text fields ---

  it("fills multiple text fields sequentially", async () => {
    // Setup: 3 text fields
    let callCount = 0;
    mockResolveElement.mockImplementation(async () => {
      callCount++;
      return mockTextbox({
        backendNodeId: 40 + callCount,
        objectId: `obj-${40 + callCount}`,
        name: ["Vorname", "Nachname", "Email"][callCount - 1],
      });
    });

    // Runtime.callFunctionOn needs to return text input type for type detection,
    // then also be called for clear operation
    let runtimeCallCount = 0;
    const { cdpClient, sendFn } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        // Every odd call is type detection, every even is clear
        if (runtimeCallCount % 2 === 1) {
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } };
        }
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      {
        fields: [
          { ref: "e5", value: "Max" },
          { ref: "e6", value: "Mustermann" },
          { ref: "e7", value: "max@test.de" },
        ],
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Filled 3 fields:"),
      }),
    );

    // Verify DOM.focus was called 3 times
    const focusCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "DOM.focus");
    expect(focusCalls).toHaveLength(3);

    // Verify Input.insertText was called 3 times
    const insertCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Input.insertText");
    expect(insertCalls).toHaveLength(3);

    expect(result._meta?.method).toBe("fill_form");
  });

  // --- AC #1: CSS selector ---

  it("fills text field via CSS selector", async () => {
    mockResolveElement.mockResolvedValue(
      mockTextbox({ resolvedVia: "css", role: "", name: "" }),
    );

    let runtimeCallCount = 0;
    const { cdpClient } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        if (runtimeCallCount % 2 === 1) {
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } };
        }
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      { fields: [{ selector: "#email", value: "max@test.de" }] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
    expect(mockResolveElement).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      { selector: "#email" },
      undefined,
    );
  });

  // --- AC #1: Clear before typing ---

  it("clears existing content before typing", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());

    let runtimeCallCount = 0;
    const { cdpClient, sendFn } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        if (runtimeCallCount === 1) {
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } };
        }
        return { result: { value: undefined } };
      },
    });

    await fillFormHandler(
      { fields: [{ ref: "e5", value: "Max" }] },
      cdpClient,
      "s1",
    );

    // Verify Runtime.callFunctionOn (clear) was called before Input.insertText
    const callMethods = sendFn.mock.calls.map((c: unknown[]) => c[0]);
    const runtimeCalls = callMethods
      .map((m, i) => ({ method: m, index: i }))
      .filter((x) => x.method === "Runtime.callFunctionOn");
    const insertIdx = callMethods.indexOf("Input.insertText");

    // First Runtime.callFunctionOn is type detection, second is clear
    expect(runtimeCalls.length).toBeGreaterThanOrEqual(2);
    expect(runtimeCalls[1].index).toBeLessThan(insertIdx);

    // Verify the clear call has the right objectId
    const clearCall = sendFn.mock.calls[runtimeCalls[1].index];
    expect(clearCall[1]).toEqual(
      expect.objectContaining({
        objectId: "obj-42",
        returnByValue: true,
      }),
    );
  });

  // --- AC #2: Select element by value ---

  it("selects option in select element by value", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox({ role: "combobox", name: "Country" }));

    let runtimeCallCount = 0;
    const { cdpClient, sendFn } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        if (runtimeCallCount === 1) {
          // Type detection: SELECT
          return { result: { value: JSON.stringify({ tag: "SELECT", type: "", checked: false }) } };
        }
        // Select option operation
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      { fields: [{ ref: "e10", value: "DE" }] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("\u2713");

    // Verify the select operation was called with correct arguments
    const runtimeCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Runtime.callFunctionOn");
    // Second call is the select operation
    expect(runtimeCalls[1][1]).toEqual(
      expect.objectContaining({
        objectId: "obj-42",
        arguments: [{ value: "DE" }],
      }),
    );
  });

  // --- AC #2: Select element by text ---

  it("selects option in select element by text", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox({ role: "combobox", name: "Country" }));

    let runtimeCallCount = 0;
    const { cdpClient, sendFn } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        if (runtimeCallCount === 1) {
          return { result: { value: JSON.stringify({ tag: "SELECT", type: "", checked: false }) } };
        }
        // The JS function in fillSelect handles both value and text matching internally
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      { fields: [{ ref: "e10", value: "Germany" }] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();

    // Verify the select operation was called with "Germany" as argument (text matching)
    const runtimeCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Runtime.callFunctionOn");
    // Second call is the select operation
    expect(runtimeCalls[1][1]).toEqual(
      expect.objectContaining({
        objectId: "obj-42",
        arguments: [{ value: "Germany" }],
      }),
    );

    // Verify the function declaration includes textContent matching
    const selectFnDecl = runtimeCalls[1][1].functionDeclaration as string;
    expect(selectFnDecl).toContain("textContent");
  });

  // --- AC #2, #4: Select option not found ---

  it("returns error when select option not found", async () => {
    // Two fields: first is a select that fails, second is a text field that succeeds
    let resolveCount = 0;
    mockResolveElement.mockImplementation(async () => {
      resolveCount++;
      return mockTextbox({
        backendNodeId: 40 + resolveCount,
        objectId: `obj-${40 + resolveCount}`,
        name: resolveCount === 1 ? "Country" : "Name",
      });
    });

    let runtimeCallCount = 0;
    const { cdpClient } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        // Field 1: type detection (SELECT)
        if (runtimeCallCount === 1) {
          return { result: { value: JSON.stringify({ tag: "SELECT", type: "", checked: false }) } };
        }
        // Field 1: option selection (throws with available options)
        if (runtimeCallCount === 2) {
          throw new Error("Option not found: InvalidOption — available: [Germany, France, Italy]");
        }
        // Field 2: type detection (INPUT text)
        if (runtimeCallCount === 3) {
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } };
        }
        // Field 2: clear
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      {
        fields: [
          { ref: "e10", value: "InvalidOption" },
          { ref: "e11", value: "Max" },
        ],
      },
      cdpClient,
      "s1",
    );

    // Not isError because second field succeeded
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1/2 fields");
    expect(text).toContain("error");
    expect(text).toContain("Option not found");
    expect(text).toContain("available:");
    expect(text).toContain("\u2713"); // second field succeeded
  });

  // --- M2: File input guard ---

  it("returns helpful error for file input fields", async () => {
    mockResolveElement.mockResolvedValue(
      mockTextbox({ role: "textbox", name: "Upload" }),
    );

    const { cdpClient } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        return { result: { value: JSON.stringify({ tag: "INPUT", type: "file", checked: false }) } };
      },
    });

    const result = await fillFormHandler(
      { fields: [{ ref: "e20", value: "photo.jpg" }] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("file input");
    expect(text).toContain("file_upload");
  });

  // --- M1: buildRefNotFoundError with roleFilter ---

  it("passes roleFilter to buildRefNotFoundError for form fields", async () => {
    mockResolveElement.mockRejectedValue(
      new RefNotFoundError("Element e99 not found."),
    );
    mockBuildRefNotFoundError.mockReturnValue(
      "Element e99 not found. Did you mean e5 (textbox 'Vorname')?",
    );

    const { cdpClient } = createMockCdp();

    await fillFormHandler(
      { fields: [{ ref: "e99", value: "test" }] },
      cdpClient,
      "s1",
    );

    // Verify buildRefNotFoundError was called with a roleFilter Set
    expect(mockBuildRefNotFoundError).toHaveBeenCalledWith(
      "e99",
      expect.any(Set),
    );
    // Verify the Set contains form-relevant roles
    const roleFilter = mockBuildRefNotFoundError.mock.calls[0][1] as Set<string>;
    expect(roleFilter.has("textbox")).toBe(true);
    expect(roleFilter.has("combobox")).toBe(true);
    expect(roleFilter.has("checkbox")).toBe(true);
    expect(roleFilter.has("radio")).toBe(true);
  });

  // --- AC #3: Checkbox clicks when value differs ---

  it("clicks checkbox when value differs from current state", async () => {
    mockResolveElement.mockResolvedValue(
      mockTextbox({ role: "checkbox", name: "Newsletter" }),
    );

    let runtimeCallCount = 0;
    const { cdpClient, sendFn } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        if (runtimeCallCount === 1) {
          // Type detection: checkbox, currently unchecked
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "checkbox", checked: false }) } };
        }
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      { fields: [{ ref: "e15", value: true }] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();

    // Verify mouse events were dispatched
    const mouseCalls = sendFn.mock.calls.filter(
      (c: unknown[]) => c[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseCalls).toHaveLength(2); // mousePressed + mouseReleased

    // Verify scroll reset was called
    const evalCalls = sendFn.mock.calls.filter(
      (c: unknown[]) => c[0] === "Runtime.evaluate",
    );
    expect(evalCalls).toHaveLength(1);

    // Verify scrollIntoView was called
    const scrollCalls = sendFn.mock.calls.filter(
      (c: unknown[]) => c[0] === "DOM.scrollIntoViewIfNeeded",
    );
    expect(scrollCalls).toHaveLength(1);
  });

  // --- AC #3: Checkbox state already matches ---

  it("skips checkbox click when state already matches", async () => {
    mockResolveElement.mockResolvedValue(
      mockTextbox({ role: "checkbox", name: "Newsletter" }),
    );

    const { cdpClient, sendFn } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        // Checkbox already checked
        return { result: { value: JSON.stringify({ tag: "INPUT", type: "checkbox", checked: true }) } };
      },
    });

    const result = await fillFormHandler(
      { fields: [{ ref: "e15", value: true }] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("\u2713");

    // No mouse events should have been dispatched
    const mouseCalls = sendFn.mock.calls.filter(
      (c: unknown[]) => c[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseCalls).toHaveLength(0);
  });

  // --- AC #3: Radio button ---

  it("clicks radio button to select it", async () => {
    mockResolveElement.mockResolvedValue(
      mockTextbox({ role: "radio", name: "Male" }),
    );

    const { cdpClient, sendFn } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        return { result: { value: JSON.stringify({ tag: "INPUT", type: "radio", checked: false }) } };
      },
    });

    const result = await fillFormHandler(
      { fields: [{ ref: "e20", value: true }] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();

    const mouseCalls = sendFn.mock.calls.filter(
      (c: unknown[]) => c[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseCalls).toHaveLength(2);
  });

  // --- AC #4: Continue after field not found ---

  it("continues filling after field not found", async () => {
    let resolveCount = 0;
    mockResolveElement.mockImplementation(async (_cdp, _sid, target) => {
      resolveCount++;
      if (resolveCount === 2) {
        throw new RefNotFoundError("Element e99 not found.");
      }
      return mockTextbox({
        backendNodeId: 40 + resolveCount,
        objectId: `obj-${40 + resolveCount}`,
        name: resolveCount === 1 ? "Vorname" : "Nachname",
      });
    });
    mockBuildRefNotFoundError.mockReturnValue(
      "Element e99 not found. Did you mean e5 (textbox 'Vorname')?"
    );

    let runtimeCallCount = 0;
    const { cdpClient } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        if (runtimeCallCount % 2 === 1) {
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } };
        }
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      {
        fields: [
          { ref: "e5", value: "Max" },
          { ref: "e99", value: "Error" },
          { ref: "e6", value: "Mustermann" },
        ],
      },
      cdpClient,
      "s1",
    );

    // Partial success — not isError
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("2/3 fields");
    expect(text).toContain("e99");
    expect(text).toContain("not found");
    expect(text).toContain("\u2713");
  });

  // --- AC #4: isError only when ALL fields fail ---

  it("returns isError only when ALL fields fail", async () => {
    mockResolveElement.mockRejectedValue(
      new RefNotFoundError("Element not found."),
    );
    mockBuildRefNotFoundError.mockReturnValue("Element e99 not found.");

    const { cdpClient } = createMockCdp();

    const result = await fillFormHandler(
      {
        fields: [
          { ref: "e99", value: "Max" },
          { ref: "e98", value: "Test" },
        ],
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("0/2 fields");
  });

  it("returns no isError when at least one field succeeds", async () => {
    let resolveCount = 0;
    mockResolveElement.mockImplementation(async () => {
      resolveCount++;
      if (resolveCount === 1) {
        return mockTextbox();
      }
      throw new RefNotFoundError("Not found");
    });
    mockBuildRefNotFoundError.mockReturnValue("Element e99 not found.");

    let runtimeCallCount = 0;
    const { cdpClient } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        if (runtimeCallCount % 2 === 1) {
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } };
        }
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      {
        fields: [
          { ref: "e5", value: "Max" },
          { ref: "e99", value: "Error" },
        ],
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
  });

  // --- Validation: no ref or selector ---

  it("returns error when field has neither ref nor selector", async () => {
    // One field without ref/selector, one field valid
    mockResolveElement.mockResolvedValue(mockTextbox());

    let runtimeCallCount = 0;
    const { cdpClient } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        if (runtimeCallCount % 2 === 1) {
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } };
        }
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      {
        fields: [
          { value: "no target" } as FillFormParams["fields"][0],
          { ref: "e5", value: "Max" },
        ],
      },
      cdpClient,
      "s1",
    );

    // Partial success
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1/2 fields");
    expect(text).toContain("ref");
    expect(text).toContain("selector");
  });

  // --- Number value conversion ---

  it("handles number value by converting to string for text input", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox({ name: "Age" }));

    let runtimeCallCount = 0;
    const { cdpClient, sendFn } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        if (runtimeCallCount === 1) {
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } };
        }
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      { fields: [{ ref: "e5", value: 42 }] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();

    // Verify Input.insertText was called with string "42"
    const insertCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Input.insertText");
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toEqual({ text: "42" });
  });

  // --- CDP connection error ---

  it("handles CDP connection error gracefully", async () => {
    let resolveCount = 0;
    mockResolveElement.mockImplementation(async () => {
      resolveCount++;
      if (resolveCount === 2) {
        throw new Error("CdpClient is closed");
      }
      return mockTextbox({
        backendNodeId: 40 + resolveCount,
        objectId: `obj-${40 + resolveCount}`,
        name: resolveCount === 1 ? "Vorname" : "Nachname",
      });
    });

    let runtimeCallCount = 0;
    const { cdpClient } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        if (runtimeCallCount % 2 === 1) {
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } };
        }
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      {
        fields: [
          { ref: "e5", value: "Max" },
          { ref: "e6", value: "Error" },
          { ref: "e7", value: "Mustermann" },
        ],
      },
      cdpClient,
      "s1",
    );

    // Partial success
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("2/3 fields");
    expect(text).toContain("CDP connection lost");
  });

  // --- Schema validation: empty fields array ---

  it("returns error when fields array is empty", () => {
    expect(() => fillFormSchema.parse({ fields: [] })).toThrow();
  });

  // --- _meta ---

  it("includes _meta with method=fill_form", async () => {
    mockResolveElement.mockResolvedValue(mockTextbox());

    let runtimeCallCount = 0;
    const { cdpClient } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        runtimeCallCount++;
        if (runtimeCallCount === 1) {
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } };
        }
        return { result: { value: undefined } };
      },
    });

    const result = await fillFormHandler(
      { fields: [{ ref: "e5", value: "Max" }] },
      cdpClient,
      "s1",
    );

    expect(result._meta?.method).toBe("fill_form");
    expect(typeof result._meta?.elapsedMs).toBe("number");
  });
});
