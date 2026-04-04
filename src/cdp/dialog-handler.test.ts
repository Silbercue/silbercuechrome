import { describe, it, expect, vi, beforeEach } from "vitest";
import { DialogHandler } from "./dialog-handler.js";
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

describe("DialogHandler", () => {
  let mock: MockCdpSetup;
  let handler: DialogHandler;

  beforeEach(() => {
    vi.useFakeTimers();
    mock = createMockCdp();
    handler = new DialogHandler(mock.cdpClient, "test-session");
  });

  // --- init tests ---

  it("init registers Page.javascriptDialogOpening listener", () => {
    handler.init();

    expect(mock.onFn).toHaveBeenCalledWith(
      "Page.javascriptDialogOpening",
      expect.any(Function),
      "test-session",
    );
  });

  // --- auto-dismiss tests ---

  it("auto-dismisses alert after default timeout when no handler configured", () => {
    handler.init();

    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "alert",
      message: "Hello!",
      url: "https://example.com",
    });

    // Should NOT have called handleJavaScriptDialog yet
    expect(mock.sendFn).not.toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      expect.anything(),
      expect.anything(),
    );

    // Advance past the default 3s timeout
    vi.advanceTimersByTime(3000);

    expect(mock.sendFn).toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      { accept: false },
      "test-session",
    );
  });

  // --- handler stack tests ---

  it("accepts dialog immediately when handler with autoAccept=true is pushed", () => {
    handler.init();
    handler.pushHandler({ autoAccept: true, timeoutMs: 0 });

    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Are you sure?",
      url: "https://example.com",
    });

    expect(mock.sendFn).toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      { accept: true },
      "test-session",
    );
  });

  it("dismisses dialog immediately when handler with autoAccept=false is pushed", () => {
    handler.init();
    handler.pushHandler({ autoAccept: false, timeoutMs: 0 });

    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Are you sure?",
      url: "https://example.com",
    });

    expect(mock.sendFn).toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      { accept: false },
      "test-session",
    );
  });

  it("sends promptText for prompt dialogs when configured", () => {
    handler.init();
    handler.pushHandler({ autoAccept: true, promptText: "my answer", timeoutMs: 0 });

    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "prompt",
      message: "Enter name:",
      defaultPrompt: "",
      url: "https://example.com",
    });

    expect(mock.sendFn).toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      { accept: true, promptText: "my answer" },
      "test-session",
    );
  });

  it("does not send promptText for non-prompt dialogs even when configured", () => {
    handler.init();
    handler.pushHandler({ autoAccept: true, promptText: "my answer", timeoutMs: 0 });

    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "alert",
      message: "Hello",
      url: "https://example.com",
    });

    expect(mock.sendFn).toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      { accept: true },
      "test-session",
    );
  });

  it("handler stack: last handler wins (LIFO) and is consumed", () => {
    handler.init();
    handler.pushHandler({ autoAccept: false, timeoutMs: 0 });
    handler.pushHandler({ autoAccept: true, timeoutMs: 0 });

    // First dialog uses the top handler (autoAccept: true)
    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "First",
      url: "https://example.com",
    });

    expect(mock.sendFn).toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      { accept: true },
      "test-session",
    );

    mock.sendFn.mockClear();

    // Second dialog uses the next handler (autoAccept: false)
    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Second",
      url: "https://example.com",
    });

    expect(mock.sendFn).toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      { accept: false },
      "test-session",
    );
  });

  // --- notification buffer tests ---

  it("consumeNotifications returns buffered events and clears buffer", () => {
    handler.init();
    handler.pushHandler({ autoAccept: true, timeoutMs: 0 });

    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "alert",
      message: "Hello!",
      url: "https://example.com",
    });

    const notifications = handler.consumeNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      type: "alert",
      message: "Hello!",
      defaultPrompt: undefined,
      url: "https://example.com",
    });

    // Buffer should be empty now
    const again = handler.consumeNotifications();
    expect(again).toHaveLength(0);
  });

  it("pendingCount reflects notification buffer size", () => {
    handler.init();
    handler.pushHandler({ autoAccept: true, timeoutMs: 0 });
    handler.pushHandler({ autoAccept: true, timeoutMs: 0 });

    expect(handler.pendingCount).toBe(0);

    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "alert",
      message: "First",
      url: "https://example.com",
    });
    expect(handler.pendingCount).toBe(1);

    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Second",
      url: "https://example.com",
    });
    expect(handler.pendingCount).toBe(2);

    handler.consumeNotifications();
    expect(handler.pendingCount).toBe(0);
  });

  // --- reinit tests ---

  it("reinit preserves notifications, resets listener", () => {
    handler.init();
    handler.pushHandler({ autoAccept: true, timeoutMs: 0 });

    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "alert",
      message: "Before reinit",
      url: "https://example.com",
    });

    expect(handler.pendingCount).toBe(1);

    // Reinit with new mock
    const newMock = createMockCdp();
    handler.reinit(newMock.cdpClient, "new-session");

    // Notifications should be preserved
    expect(handler.pendingCount).toBe(1);
    const notifications = handler.consumeNotifications();
    expect(notifications[0].message).toBe("Before reinit");

    // New listener should be registered on new client
    expect(newMock.onFn).toHaveBeenCalledWith(
      "Page.javascriptDialogOpening",
      expect.any(Function),
      "new-session",
    );
  });

  // --- detach tests ---

  it("detach removes listener and clears handler stack", () => {
    handler.init();
    handler.pushHandler({ autoAccept: true, timeoutMs: 0 });
    handler.pushHandler({ autoAccept: false, timeoutMs: 0 });

    handler.detach();

    expect(mock.offFn).toHaveBeenCalledWith(
      "Page.javascriptDialogOpening",
      expect.any(Function),
    );

    // Handler stack should be cleared — popHandler returns undefined
    expect(handler.popHandler()).toBeUndefined();
  });

  // --- beforeunload tests (H1) ---

  it("beforeunload auto-dismiss uses accept: true to avoid blocking navigation", () => {
    handler.init();

    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "beforeunload",
      message: "Changes you made may not be saved.",
      url: "https://example.com",
    });

    // Advance past the default 3s timeout
    vi.advanceTimersByTime(3000);

    expect(mock.sendFn).toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      { accept: true },
      "test-session",
    );
  });

  // --- configurable timeout tests (H2) ---

  it("uses custom timeoutMs from constructor", () => {
    const customHandler = new DialogHandler(mock.cdpClient, "test-session", 500);
    customHandler.init();

    mock.fireEvent("Page.javascriptDialogOpening", {
      type: "alert",
      message: "Timeout test",
      url: "https://example.com",
    });

    // Should NOT have auto-dismissed at 400ms
    vi.advanceTimersByTime(400);
    expect(mock.sendFn).not.toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      expect.anything(),
      expect.anything(),
    );

    // Should auto-dismiss at 500ms
    vi.advanceTimersByTime(100);
    expect(mock.sendFn).toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      { accept: false },
      "test-session",
    );
  });

  // --- init idempotency tests (L2) ---

  it("init is idempotent — calling twice does not register duplicate listeners", () => {
    handler.init();
    handler.init();

    // on() should only have been called once
    expect(mock.onFn).toHaveBeenCalledTimes(1);
  });

  // --- error handling tests ---

  it("handles error when dialog already dismissed by other code", () => {
    mock.sendFn.mockRejectedValueOnce(new Error("No dialog is showing"));

    handler.init();
    handler.pushHandler({ autoAccept: true, timeoutMs: 0 });

    // Should not throw
    expect(() => {
      mock.fireEvent("Page.javascriptDialogOpening", {
        type: "alert",
        message: "Already gone",
        url: "https://example.com",
      });
    }).not.toThrow();

    // Notification should still be buffered
    expect(handler.pendingCount).toBe(1);
  });
});
