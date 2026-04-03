import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "./session-manager.js";
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
  fireEvent: (method: string, params: unknown, sessionId?: string) => void;
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
        entry.callback(params);
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

describe("SessionManager", () => {
  let mock: MockCdpSetup;
  let manager: SessionManager;

  beforeEach(() => {
    mock = createMockCdp();
    manager = new SessionManager(mock.cdpClient, "main-session");
  });

  // --- init tests ---

  it("init calls Target.setAutoAttach with correct params", async () => {
    await manager.init();

    expect(mock.sendFn).toHaveBeenCalledWith(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      },
      "main-session",
    );
  });

  it("init registers event listeners for attachedToTarget and detachedFromTarget", async () => {
    await manager.init();

    expect(mock.onFn).toHaveBeenCalledWith(
      "Target.attachedToTarget",
      expect.any(Function),
    );
    expect(mock.onFn).toHaveBeenCalledWith(
      "Target.detachedFromTarget",
      expect.any(Function),
    );
  });

  // --- onAttached tests ---

  it("onAttached creates session for iframe target", async () => {
    await manager.init();

    mock.fireEvent("Target.attachedToTarget", {
      sessionId: "oopif-session-1",
      targetInfo: {
        targetId: "target-1",
        type: "iframe",
        url: "https://accounts.google.com",
      },
      waitingForDebugger: false,
    });

    // Wait for async domain enables
    await vi.waitFor(() => {
      expect(mock.sendFn).toHaveBeenCalledWith("Accessibility.enable", {}, "oopif-session-1");
    });

    expect(mock.sendFn).toHaveBeenCalledWith("DOM.enable", {}, "oopif-session-1");
    expect(mock.sendFn).toHaveBeenCalledWith("Runtime.enable", {}, "oopif-session-1");

    const sessions = manager.getAllSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[1].sessionId).toBe("oopif-session-1");
    expect(sessions[1].isMain).toBe(false);
    expect(sessions[1].url).toBe("https://accounts.google.com");
  });

  it("onAttached ignores non-iframe targets", async () => {
    await manager.init();

    mock.fireEvent("Target.attachedToTarget", {
      sessionId: "worker-session",
      targetInfo: {
        targetId: "target-w",
        type: "worker",
        url: "blob:worker",
      },
      waitingForDebugger: false,
    });

    // Give async code a chance to run
    await new Promise((r) => setTimeout(r, 10));

    const sessions = manager.getAllSessions();
    expect(sessions).toHaveLength(1); // Only main session
    expect(sessions[0].isMain).toBe(true);
  });

  // --- onDetached tests ---

  it("onDetached removes session and associated nodes", async () => {
    await manager.init();

    // Attach an OOPIF
    mock.fireEvent("Target.attachedToTarget", {
      sessionId: "oopif-session-1",
      targetInfo: {
        targetId: "target-1",
        type: "iframe",
        url: "https://accounts.google.com",
      },
      waitingForDebugger: false,
    });

    await vi.waitFor(() => {
      expect(mock.sendFn).toHaveBeenCalledWith("Accessibility.enable", {}, "oopif-session-1");
    });

    // Register some nodes
    manager.registerNode(1001, "oopif-session-1");
    manager.registerNode(1002, "oopif-session-1");

    expect(manager.getSessionForNode(1001)).toBe("oopif-session-1");

    // Detach
    mock.fireEvent("Target.detachedFromTarget", {
      sessionId: "oopif-session-1",
    });

    // Nodes should fall back to main session
    expect(manager.getSessionForNode(1001)).toBe("main-session");
    expect(manager.getSessionForNode(1002)).toBe("main-session");

    // Session should be gone
    const sessions = manager.getAllSessions();
    expect(sessions).toHaveLength(1);
  });

  // --- getSessionForNode tests ---

  it("getSessionForNode returns main session for unknown nodes", () => {
    expect(manager.getSessionForNode(9999)).toBe("main-session");
  });

  it("getSessionForNode returns OOPIF session for registered nodes", () => {
    manager.registerNode(42, "oopif-session-1");
    expect(manager.getSessionForNode(42)).toBe("oopif-session-1");
  });

  // --- registerNode tests ---

  it("registerNode maps backendNodeId to sessionId", () => {
    manager.registerNode(100, "session-a");
    manager.registerNode(200, "session-b");

    expect(manager.getSessionForNode(100)).toBe("session-a");
    expect(manager.getSessionForNode(200)).toBe("session-b");
  });

  // --- getAllSessions tests ---

  it("getAllSessions returns main + OOPIF sessions", async () => {
    await manager.init();

    mock.fireEvent("Target.attachedToTarget", {
      sessionId: "oopif-1",
      targetInfo: { targetId: "t-1", type: "iframe", url: "https://a.com" },
      waitingForDebugger: false,
    });
    mock.fireEvent("Target.attachedToTarget", {
      sessionId: "oopif-2",
      targetInfo: { targetId: "t-2", type: "iframe", url: "https://b.com" },
      waitingForDebugger: false,
    });

    await vi.waitFor(() => {
      expect(mock.sendFn).toHaveBeenCalledWith("Accessibility.enable", {}, "oopif-2");
    });

    const sessions = manager.getAllSessions();
    expect(sessions).toHaveLength(3);
    expect(sessions[0].isMain).toBe(true);
    expect(sessions[0].sessionId).toBe("main-session");
    expect(sessions[1].sessionId).toBe("oopif-1");
    expect(sessions[2].sessionId).toBe("oopif-2");
  });

  // --- reinit tests ---

  it("reinit clears state and re-initializes", async () => {
    await manager.init();

    // Register some state
    manager.registerNode(42, "oopif-old");

    // Create new mock CDP
    const newMock = createMockCdp();
    await manager.reinit(newMock.cdpClient, "new-main-session");

    // Old state should be cleared
    expect(manager.getSessionForNode(42)).toBe("new-main-session");
    expect(manager.mainSessionId).toBe("new-main-session");

    // New init should have been called
    expect(newMock.sendFn).toHaveBeenCalledWith(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      },
      "new-main-session",
    );
  });

  // --- detach tests ---

  it("detach cleans up event listeners", async () => {
    await manager.init();

    // Verify listeners were registered
    const attachedListeners = mock.listeners.get("Target.attachedToTarget");
    const detachedListeners = mock.listeners.get("Target.detachedFromTarget");
    expect(attachedListeners?.size).toBe(1);
    expect(detachedListeners?.size).toBe(1);

    manager.detach();

    // Verify off was called
    expect(mock.offFn).toHaveBeenCalledWith(
      "Target.attachedToTarget",
      expect.any(Function),
    );
    expect(mock.offFn).toHaveBeenCalledWith(
      "Target.detachedFromTarget",
      expect.any(Function),
    );

    // All sessions should be cleared
    const sessions = manager.getAllSessions();
    expect(sessions).toHaveLength(1); // Only main
  });
});
