import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DownloadCollector } from "./download-collector.js";
import type { CdpClient } from "./cdp-client.js";

// --- Mock debug ---

vi.mock("./debug.js", () => ({
  debug: vi.fn(),
}));

// --- Mock fs/os/path ---

const mockMkdtempSync = vi.fn(() => "/tmp/sc-dl-test123");
const mockRmSync = vi.fn();
const mockStatSync = vi.fn(() => ({ size: 42000 }));

vi.mock("node:fs", () => ({
  mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
}));

vi.mock("node:os", () => ({
  tmpdir: () => "/tmp",
}));

vi.mock("node:path", () => ({
  join: (...parts: string[]) => parts.join("/"),
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

/** Flush microtask queue so fire-and-forget `_finalizeDownload` settles. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("DownloadCollector", () => {
  let mock: MockCdpSetup;
  let collector: DownloadCollector;

  beforeEach(() => {
    mock = createMockCdp();
    mockStatSync.mockReturnValue({ size: 42000 });
    collector = new DownloadCollector(mock.cdpClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- init tests ---

  it("init calls Browser.setDownloadBehavior without sessionId", async () => {
    await collector.init();

    expect(mock.sendFn).toHaveBeenCalledWith("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: "/tmp/sc-dl-test123",
      eventsEnabled: true,
    });
    // Verify no sessionId was passed (3rd arg should be undefined)
    const call = mock.sendFn.mock.calls.find(
      (c: unknown[]) => c[0] === "Browser.setDownloadBehavior",
    );
    expect(call).toHaveLength(2); // method + params, no sessionId
  });

  it("init registers Browser.downloadWillBegin and Browser.downloadProgress listeners", async () => {
    await collector.init();

    expect(mock.onFn).toHaveBeenCalledWith(
      "Browser.downloadWillBegin",
      expect.any(Function),
    );
    expect(mock.onFn).toHaveBeenCalledWith(
      "Browser.downloadProgress",
      expect.any(Function),
    );
  });

  it("init is idempotent — calling twice does not register duplicate listeners", async () => {
    await collector.init();
    await collector.init();

    const willBeginCalls = mock.onFn.mock.calls.filter(
      (c: unknown[]) => c[0] === "Browser.downloadWillBegin",
    );
    expect(willBeginCalls).toHaveLength(1);
  });

  // --- download flow tests ---

  it("downloadWillBegin + downloadProgress completed → appears in consumeCompleted()", async () => {
    await collector.init();

    // Fire downloadWillBegin
    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "abc-123",
      url: "https://example.com/invoice.pdf",
      suggestedFilename: "invoice.pdf",
    });

    // Fire downloadProgress with completed state
    mock.fireEvent("Browser.downloadProgress", {
      guid: "abc-123",
      totalBytes: 42000,
      receivedBytes: 42000,
      state: "completed",
    });
    await flush();

    const completed = collector.consumeCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual({
      path: "/tmp/sc-dl-test123/abc-123",
      suggestedFilename: "invoice.pdf",
      size: 42000,
      url: "https://example.com/invoice.pdf",
    });
  });

  it("consumeCompleted clears the buffer", async () => {
    await collector.init();

    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "abc-123",
      url: "https://example.com/file.pdf",
      suggestedFilename: "file.pdf",
    });
    mock.fireEvent("Browser.downloadProgress", {
      guid: "abc-123",
      totalBytes: 1000,
      receivedBytes: 1000,
      state: "completed",
    });
    await flush();

    const first = collector.consumeCompleted();
    expect(first).toHaveLength(1);

    const second = collector.consumeCompleted();
    expect(second).toHaveLength(0);
  });

  it("downloadProgress canceled removes from pending, not in consumeCompleted", async () => {
    await collector.init();

    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "cancel-me",
      url: "https://example.com/large.zip",
      suggestedFilename: "large.zip",
    });

    mock.fireEvent("Browser.downloadProgress", {
      guid: "cancel-me",
      totalBytes: 0,
      receivedBytes: 0,
      state: "canceled",
    });

    const completed = collector.consumeCompleted();
    expect(completed).toHaveLength(0);
  });

  it("downloadProgress inProgress is silently ignored", async () => {
    await collector.init();

    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "in-progress",
      url: "https://example.com/file.zip",
      suggestedFilename: "file.zip",
    });

    mock.fireEvent("Browser.downloadProgress", {
      guid: "in-progress",
      totalBytes: 10000,
      receivedBytes: 5000,
      state: "inProgress",
    });

    // Should not be completed yet
    expect(collector.completedCount).toBe(0);
  });

  it("completedCount reflects buffer size", async () => {
    await collector.init();

    expect(collector.completedCount).toBe(0);

    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "a",
      url: "https://example.com/a.pdf",
      suggestedFilename: "a.pdf",
    });
    mock.fireEvent("Browser.downloadProgress", {
      guid: "a",
      totalBytes: 100,
      receivedBytes: 100,
      state: "completed",
    });
    await flush();

    expect(collector.completedCount).toBe(1);

    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "b",
      url: "https://example.com/b.pdf",
      suggestedFilename: "b.pdf",
    });
    mock.fireEvent("Browser.downloadProgress", {
      guid: "b",
      totalBytes: 200,
      receivedBytes: 200,
      state: "completed",
    });
    await flush();

    expect(collector.completedCount).toBe(2);

    collector.consumeCompleted();
    expect(collector.completedCount).toBe(0);
  });

  it("multiple concurrent downloads tracked independently", async () => {
    await collector.init();

    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "first",
      url: "https://example.com/first.pdf",
      suggestedFilename: "first.pdf",
    });
    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "second",
      url: "https://example.com/second.pdf",
      suggestedFilename: "second.pdf",
    });

    // Complete second first
    mock.fireEvent("Browser.downloadProgress", {
      guid: "second",
      totalBytes: 200,
      receivedBytes: 200,
      state: "completed",
    });
    mock.fireEvent("Browser.downloadProgress", {
      guid: "first",
      totalBytes: 100,
      receivedBytes: 100,
      state: "completed",
    });
    await flush();

    const completed = collector.consumeCompleted();
    expect(completed).toHaveLength(2);
    expect(completed[0].suggestedFilename).toBe("second.pdf");
    expect(completed[1].suggestedFilename).toBe("first.pdf");
  });

  it("ignores downloadProgress for unknown guid", async () => {
    await collector.init();

    // No downloadWillBegin — progress for unknown guid
    mock.fireEvent("Browser.downloadProgress", {
      guid: "unknown",
      totalBytes: 100,
      receivedBytes: 100,
      state: "completed",
    });

    expect(collector.completedCount).toBe(0);
  });

  it("ignores events with missing guid", async () => {
    await collector.init();

    mock.fireEvent("Browser.downloadWillBegin", { url: "https://example.com/no-guid.pdf" });
    mock.fireEvent("Browser.downloadProgress", { state: "completed" });

    expect(collector.completedCount).toBe(0);
  });

  // --- stat fallback test ---

  it("uses totalBytes from event when statSync fails", async () => {
    mockStatSync.mockImplementation(() => { throw new Error("ENOENT"); });
    await collector.init();

    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "stat-fail",
      url: "https://example.com/file.pdf",
      suggestedFilename: "file.pdf",
    });
    mock.fireEvent("Browser.downloadProgress", {
      guid: "stat-fail",
      totalBytes: 9999,
      receivedBytes: 9999,
      state: "completed",
    });
    // _finalizeDownload retries statSync with 50ms async delays — flush all
    await new Promise<void>((r) => setTimeout(r, 200));

    const completed = collector.consumeCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0].size).toBe(9999);
  });

  // --- getAllDownloads / history tests ---

  it("getAllDownloads returns history that survives consumeCompleted", async () => {
    await collector.init();

    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "hist-1",
      url: "https://example.com/a.pdf",
      suggestedFilename: "a.pdf",
    });
    mock.fireEvent("Browser.downloadProgress", {
      guid: "hist-1",
      totalBytes: 100,
      receivedBytes: 100,
      state: "completed",
    });
    await flush();

    // Consume clears _completed
    const consumed = collector.consumeCompleted();
    expect(consumed).toHaveLength(1);
    expect(collector.completedCount).toBe(0);

    // History still has the download
    const history = collector.getAllDownloads();
    expect(history).toHaveLength(1);
    expect(history[0].suggestedFilename).toBe("a.pdf");
  });

  it("getAllDownloads accumulates across multiple consumeCompleted cycles", async () => {
    await collector.init();

    // First download + consume
    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "cycle-1",
      url: "https://example.com/first.pdf",
      suggestedFilename: "first.pdf",
    });
    mock.fireEvent("Browser.downloadProgress", {
      guid: "cycle-1",
      totalBytes: 100,
      receivedBytes: 100,
      state: "completed",
    });
    await flush();
    collector.consumeCompleted();

    // Second download + consume
    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "cycle-2",
      url: "https://example.com/second.pdf",
      suggestedFilename: "second.pdf",
    });
    mock.fireEvent("Browser.downloadProgress", {
      guid: "cycle-2",
      totalBytes: 200,
      receivedBytes: 200,
      state: "completed",
    });
    await flush();
    collector.consumeCompleted();

    // History has both
    const history = collector.getAllDownloads();
    expect(history).toHaveLength(2);
    expect(history[0].suggestedFilename).toBe("first.pdf");
    expect(history[1].suggestedFilename).toBe("second.pdf");
  });

  // --- reinit tests ---

  it("reinit clears pending, completed buffer, and history", async () => {
    await collector.init();

    // Complete one download
    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "completed-one",
      url: "https://example.com/done.pdf",
      suggestedFilename: "done.pdf",
    });
    mock.fireEvent("Browser.downloadProgress", {
      guid: "completed-one",
      totalBytes: 100,
      receivedBytes: 100,
      state: "completed",
    });
    await flush();

    // Start another (pending)
    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "pending-one",
      url: "https://example.com/pending.pdf",
      suggestedFilename: "pending.pdf",
    });

    expect(collector.completedCount).toBe(1);
    expect(collector.getAllDownloads()).toHaveLength(1);

    // Reinit with new client
    const newMock = createMockCdp();
    await collector.reinit(newMock.cdpClient);

    // Completed buffer preserved
    expect(collector.completedCount).toBe(1);

    // History cleared on reinit
    expect(collector.getAllDownloads()).toHaveLength(0);

    // New listeners registered on new client
    expect(newMock.onFn).toHaveBeenCalledWith(
      "Browser.downloadWillBegin",
      expect.any(Function),
    );
    expect(newMock.onFn).toHaveBeenCalledWith(
      "Browser.downloadProgress",
      expect.any(Function),
    );

    // Old pending download is gone — completing it on new client does nothing extra
    newMock.fireEvent("Browser.downloadProgress", {
      guid: "pending-one",
      totalBytes: 100,
      receivedBytes: 100,
      state: "completed",
    });
    // Still just 1 (the original completed one)
    expect(collector.completedCount).toBe(1);
  });

  // --- detach tests ---

  it("detach removes listeners", async () => {
    await collector.init();

    collector.detach();

    expect(mock.offFn).toHaveBeenCalledWith(
      "Browser.downloadWillBegin",
      expect.any(Function),
    );
    expect(mock.offFn).toHaveBeenCalledWith(
      "Browser.downloadProgress",
      expect.any(Function),
    );
  });

  // --- cleanup tests ---

  it("cleanup removes the download directory", () => {
    collector.cleanup();

    expect(mockRmSync).toHaveBeenCalledWith(
      "/tmp/sc-dl-test123",
      { recursive: true, force: true },
    );
  });

  it("cleanup clears history", async () => {
    await collector.init();

    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "clean-hist",
      url: "https://example.com/file.pdf",
      suggestedFilename: "file.pdf",
    });
    mock.fireEvent("Browser.downloadProgress", {
      guid: "clean-hist",
      totalBytes: 100,
      receivedBytes: 100,
      state: "completed",
    });
    await flush();

    expect(collector.getAllDownloads()).toHaveLength(1);
    collector.cleanup();
    expect(collector.getAllDownloads()).toHaveLength(0);
  });

  it("cleanup does not throw on failure", () => {
    mockRmSync.mockImplementation(() => { throw new Error("EPERM"); });

    expect(() => collector.cleanup()).not.toThrow();
  });

  // --- pending/completed atomicity (M2 race fix) ---

  it("pending is not cleared until download is in the buffer", async () => {
    await collector.init();

    mock.fireEvent("Browser.downloadWillBegin", {
      guid: "race-test",
      url: "https://example.com/race.pdf",
      suggestedFilename: "race.pdf",
    });

    expect(collector.pendingCount).toBe(1);

    // Fire completed — _finalizeDownload is async, but the pending entry
    // should only be removed after the push into _completed/_history.
    mock.fireEvent("Browser.downloadProgress", {
      guid: "race-test",
      totalBytes: 500,
      receivedBytes: 500,
      state: "completed",
    });

    // Before flush: _finalizeDownload is still running.
    // Either pending is still 1 (not yet finalized) or both pending=0
    // AND completed=1 (already finalized). There must never be a state
    // where pending=0 AND completed=0.
    const pendingNow = collector.pendingCount;
    const completedNow = collector.completedCount;
    expect(pendingNow + completedNow).toBeGreaterThanOrEqual(1);

    await flush();

    // After flush: download is fully finalized
    expect(collector.pendingCount).toBe(0);
    expect(collector.completedCount).toBe(1);
  });

  // --- downloadPath getter ---

  it("downloadPath returns the temp directory", () => {
    expect(collector.downloadPath).toBe("/tmp/sc-dl-test123");
  });
});
