import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConsoleCollector } from "./console-collector.js";
import type { CdpClient } from "./cdp-client.js";

// --- Mock debug ---

vi.mock("./debug.js", () => ({
  debug: vi.fn(),
}));

// --- Types ---

type EventCallback = (params: unknown, sessionId?: string) => void;

// --- Mock CDP client ---

interface MockCdpSetup {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
  onFn: ReturnType<typeof vi.fn>;
  offFn: ReturnType<typeof vi.fn>;
  listeners: Map<string, Set<{ callback: EventCallback; sessionId?: string }>>;
  fireEvent: (method: string, params: unknown) => void;
}

function createMockCdp(): MockCdpSetup {
  const listeners = new Map<string, Set<{ callback: EventCallback; sessionId?: string }>>();

  const sendFn = vi.fn(async () => ({}));

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

  const fireEvent = (method: string, params: unknown) => {
    const set = listeners.get(method);
    if (set) {
      for (const entry of set) {
        entry.callback(params, entry.sessionId);
      }
    }
  };

  const cdpClient = {
    send: sendFn,
    on: onFn,
    once: vi.fn(),
    off: offFn,
  } as unknown as CdpClient;

  return { cdpClient, sendFn, onFn, offFn, listeners, fireEvent };
}

describe("ConsoleCollector", () => {
  let mock: MockCdpSetup;
  let collector: ConsoleCollector;

  beforeEach(() => {
    mock = createMockCdp();
    collector = new ConsoleCollector(mock.cdpClient, "test-session");
  });

  // --- init tests ---

  it("init registers event listeners for Runtime.consoleAPICalled and Runtime.exceptionThrown", () => {
    collector.init();

    expect(mock.onFn).toHaveBeenCalledWith(
      "Runtime.consoleAPICalled",
      expect.any(Function),
      "test-session",
    );
    expect(mock.onFn).toHaveBeenCalledWith(
      "Runtime.exceptionThrown",
      expect.any(Function),
      "test-session",
    );
  });

  it("init is idempotent — calling twice does not register duplicate listeners", () => {
    collector.init();
    collector.init();

    expect(mock.onFn).toHaveBeenCalledTimes(2); // once per event, not 4
  });

  // --- detach tests ---

  it("detach removes event listeners", () => {
    collector.init();
    collector.detach();

    expect(mock.offFn).toHaveBeenCalledWith(
      "Runtime.consoleAPICalled",
      expect.any(Function),
    );
    expect(mock.offFn).toHaveBeenCalledWith(
      "Runtime.exceptionThrown",
      expect.any(Function),
    );
  });

  // --- reinit tests ---

  it("reinit detaches and re-initializes with new client/session", () => {
    collector.init();

    const newMock = createMockCdp();
    collector.reinit(newMock.cdpClient, "new-session");

    // Old listeners removed
    expect(mock.offFn).toHaveBeenCalled();

    // New listeners registered on new client
    expect(newMock.onFn).toHaveBeenCalledWith(
      "Runtime.consoleAPICalled",
      expect.any(Function),
      "new-session",
    );
    expect(newMock.onFn).toHaveBeenCalledWith(
      "Runtime.exceptionThrown",
      expect.any(Function),
      "new-session",
    );
  });

  it("reinit clears the buffer", () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "before reinit" }],
    });
    expect(collector.count).toBe(1);

    const newMock = createMockCdp();
    collector.reinit(newMock.cdpClient, "new-session");

    expect(collector.count).toBe(0);
  });

  // --- consoleAPICalled level mapping tests ---

  it('consoleAPICalled with type "log" is stored as level "info"', () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "hello" }],
    });

    const logs = collector.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("info");
    expect(logs[0].source).toBe("console");
  });

  it('consoleAPICalled with type "warning" is stored as level "warning"', () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ type: "string", value: "deprecation notice" }],
    });

    const logs = collector.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("warning");
  });

  it('consoleAPICalled with type "error" is stored as level "error"', () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ type: "string", value: "something broke" }],
    });

    const logs = collector.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("error");
  });

  it('consoleAPICalled with type "debug" is stored as level "debug"', () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "debug",
      args: [{ type: "string", value: "debug info" }],
    });

    const logs = collector.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("debug");
  });

  it('consoleAPICalled with type "info" is stored as level "info"', () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "info",
      args: [{ type: "string", value: "info msg" }],
    });

    const logs = collector.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("info");
  });

  it('unknown console type (e.g. "table") maps to "info"', () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "table",
      args: [{ type: "object", description: "Array(3)" }],
    });

    const logs = collector.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("info");
  });

  // --- exceptionThrown tests ---

  it('exceptionThrown is stored as level "error" with source "exception"', () => {
    collector.init();

    mock.fireEvent("Runtime.exceptionThrown", {
      timestamp: 123456,
      exceptionDetails: {
        text: "Uncaught ReferenceError",
        exception: {
          description: "ReferenceError: foo is not defined",
        },
      },
    });

    const logs = collector.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("error");
    expect(logs[0].source).toBe("exception");
    expect(logs[0].text).toBe("ReferenceError: foo is not defined");
  });

  it("exceptionThrown falls back to exceptionDetails.text when exception is undefined", () => {
    collector.init();

    mock.fireEvent("Runtime.exceptionThrown", {
      timestamp: 123456,
      exceptionDetails: {
        text: "Uncaught SyntaxError: Unexpected token",
      },
    });

    const logs = collector.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toBe("Uncaught SyntaxError: Unexpected token");
  });

  it("exceptionThrown with completely empty details uses fallback text", () => {
    collector.init();

    mock.fireEvent("Runtime.exceptionThrown", {});

    const logs = collector.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toBe("Unknown exception");
  });

  // --- Ring-Buffer tests ---

  it("ring buffer removes oldest entries at overflow (maxEntries)", () => {
    const smallCollector = new ConsoleCollector(mock.cdpClient, "test-session", {
      maxEntries: 3,
    });
    smallCollector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "first" }],
    });
    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "second" }],
    });
    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "third" }],
    });
    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "fourth" }],
    });

    const logs = smallCollector.getAll();
    expect(logs).toHaveLength(3);
    expect(logs[0].text).toBe("second");
    expect(logs[1].text).toBe("third");
    expect(logs[2].text).toBe("fourth");
  });

  // --- getFiltered tests ---

  it("getFiltered with level filter returns only matching entries", () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "info msg" }],
    });
    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ type: "string", value: "error msg" }],
    });
    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ type: "string", value: "warn msg" }],
    });

    const errors = collector.getFiltered("error");
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toBe("error msg");
  });

  it("getFiltered with pattern filter matches per regex", () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "[MyApp] loaded" }],
    });
    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "other log" }],
    });
    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "[MyApp] error" }],
    });

    const filtered = collector.getFiltered(undefined, "\\[MyApp\\]");
    expect(filtered).toHaveLength(2);
    expect(filtered[0].text).toBe("[MyApp] loaded");
    expect(filtered[1].text).toBe("[MyApp] error");
  });

  it("getFiltered with level + pattern combines both filters (AND)", () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ type: "string", value: "deprecated API used" }],
    });
    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ type: "string", value: "unrelated warning" }],
    });
    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ type: "string", value: "deprecated error" }],
    });

    const filtered = collector.getFiltered("warning", "deprecated");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].text).toBe("deprecated API used");
  });

  it("getFiltered with invalid regex throws Error", () => {
    collector.init();

    expect(() => collector.getFiltered(undefined, "[invalid")).toThrow();
  });

  // --- clear tests ---

  it("clear empties the buffer, new events are collected again", () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "before clear" }],
    });
    expect(collector.count).toBe(1);

    collector.clear();
    expect(collector.count).toBe(0);
    expect(collector.getAll()).toHaveLength(0);

    // New events are collected again
    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "after clear" }],
    });
    expect(collector.count).toBe(1);
    expect(collector.getAll()[0].text).toBe("after clear");
  });

  // --- getAll copy test ---

  it("getAll returns a copy (no aliasing)", () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "entry" }],
    });

    const copy1 = collector.getAll();
    const copy2 = collector.getAll();
    expect(copy1).not.toBe(copy2);
    expect(copy1).toEqual(copy2);

    // Mutating the copy should not affect the buffer
    copy1.push({
      level: "info",
      text: "injected",
      timestamp: 0,
      source: "console",
    });
    expect(collector.count).toBe(1);
  });

  // --- Text extraction tests ---

  it("text extraction: args with value and description are correctly joined", () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [
        { type: "string", value: "Count:" },
        { type: "number", value: 42 },
        { type: "object", description: "HTMLDivElement" },
      ],
    });

    const logs = collector.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toBe("Count: 42 HTMLDivElement");
  });

  it("text extraction: unserializableValue is used when value is undefined", () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [
        { type: "number", unserializableValue: "Infinity" },
      ],
    });

    const logs = collector.getAll();
    expect(logs[0].text).toBe("Infinity");
  });

  it("text extraction: falls back to type when no value/description", () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [
        { type: "symbol" },
      ],
    });

    const logs = collector.getAll();
    expect(logs[0].text).toBe("symbol");
  });

  it("text extraction: empty args produces empty text", () => {
    collector.init();

    mock.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [],
    });

    const logs = collector.getAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toBe("");
  });
});
