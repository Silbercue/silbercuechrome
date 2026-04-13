/**
 * BrowserSession unit tests — cover the public contract (lazy readiness,
 * the smart-retry policy branches, the relaunch-notice consumption, the
 * race-safety of parallel ensureReady() calls) without touching a real
 * Chrome process.
 *
 * The strategy: inject a mock ChromeLauncher by reaching into the private
 * `_launcher` field. This is test-only and bypasses the real CDP dance
 * (Target.getTargets, Target.attachToTarget, enable domains, helpers
 * reinit). We stub `_wireUpFreshConnection` as well so the tests focus on
 * the retry policy rather than the wiring details — the wiring is
 * covered implicitly by the 1311-test full-suite passing against the
 * new server.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserSession } from "./browser-session.js";

// --- Test helpers ---------------------------------------------------------

/**
 * Build a BrowserSession with a stubbed ChromeLauncher and a no-op wiring
 * phase. Callers control the outcome of each connect attempt via the
 * `connectSequence` / `reconnectSequence` arrays.
 */
function buildSession(opts: {
  // Sequence of outcomes for connectToExistingChrome() calls (WebSocket-only)
  reconnectSequence?: Array<"ok" | "fail">;
  // Sequence of outcomes for connect() calls (full path)
  connectSequence?: Array<"ok" | "fail">;
  retryTimings?: { establishedDelays?: number[]; freshDelays?: number[] };
}) {
  const reconnectOutcomes = [...(opts.reconnectSequence ?? [])];
  const connectOutcomes = [...(opts.connectSequence ?? [])];
  const connectCalls = { count: 0 };
  const reconnectCalls = { count: 0 };

  // Fake connection object — the real wiring is stubbed below.
  const fakeConnection = {
    cdpClient: {} as never,
    headless: false,
    status: "connected" as const,
    close: vi.fn(async () => {}),
  };

  const launcher = {
    connect: vi.fn(async () => {
      connectCalls.count++;
      const outcome = connectOutcomes.shift() ?? "ok";
      if (outcome === "fail") throw new Error("simulated launch failure");
      return fakeConnection as never;
    }),
    connectToExistingChrome: vi.fn(async () => {
      reconnectCalls.count++;
      const outcome = reconnectOutcomes.shift() ?? "fail";
      if (outcome === "fail") throw new Error("simulated reconnect failure");
      return fakeConnection as never;
    }),
  };

  // Use near-zero retry delays to keep tests fast. Each attempt still runs
  // in its own microtask so the per-attempt count is observable.
  const session = new BrowserSession({
    retryTimings: {
      establishedDelays: opts.retryTimings?.establishedDelays ?? [0, 0, 0],
      freshDelays: opts.retryTimings?.freshDelays ?? [0, 0],
    },
  });

  // Inject the mock launcher by reaching into the private field.
  // This is test-only; production code never touches `_launcher` externally.
  (session as unknown as { _launcher: unknown })._launcher = launcher;

  // Stub out the wiring phase — we only care about retry behaviour here,
  // not the CDP attach dance.
  (session as unknown as { _wireUpFreshConnection: (conn: unknown) => Promise<void> })._wireUpFreshConnection =
    async function (conn: unknown) {
      // Mirror the minimal bookkeeping the real implementation does so
      // `isReady` flips to true after a successful launch.
      (this as unknown as { _connection: unknown })._connection = conn;
      (this as unknown as { _cdpClient: unknown })._cdpClient = (conn as { cdpClient: unknown }).cdpClient;
      (this as unknown as { _sessionId: string })._sessionId = "fake-session";
    };

  return { session, launcher, connectCalls, reconnectCalls };
}

// --- Tests ----------------------------------------------------------------

describe("BrowserSession — public contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts in a non-ready state and has no relaunch notice", () => {
    const { session } = buildSession({});
    expect(session.isReady).toBe(false);
    expect(session.wasEverReady).toBe(false);
    expect(session.consumeRelaunchNotice()).toBeNull();
  });

  it("throws when cdpClient is accessed before ensureReady()", () => {
    const { session } = buildSession({});
    expect(() => session.cdpClient).toThrow(/ensureReady/);
    expect(() => session.sessionId).toThrow(/ensureReady/);
  });

  it("after ensureReady() succeeds, isReady is true and wasEverReady flips", async () => {
    const { session, connectCalls } = buildSession({ connectSequence: ["ok"] });
    await session.ensureReady();
    expect(session.isReady).toBe(true);
    expect(session.wasEverReady).toBe(true);
    expect(connectCalls.count).toBe(1);
  });
});

describe("BrowserSession — fresh-session launch policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes a single connect() call when the launch succeeds first try", async () => {
    const { session, connectCalls } = buildSession({ connectSequence: ["ok"] });
    await session.ensureReady();
    expect(connectCalls.count).toBe(1);
  });

  it("retries once after an initial launch failure, then succeeds", async () => {
    const { session, connectCalls } = buildSession({
      connectSequence: ["fail", "ok"],
    });
    await session.ensureReady();
    expect(connectCalls.count).toBe(2);
    expect(session.isReady).toBe(true);
  });

  it("surfaces the launch error when both attempts fail", async () => {
    const { session, connectCalls } = buildSession({
      connectSequence: ["fail", "fail"],
    });
    await expect(session.ensureReady()).rejects.toThrow(/simulated launch failure/);
    expect(connectCalls.count).toBe(2);
    expect(session.isReady).toBe(false);
    expect(session.wasEverReady).toBe(false);
  });

  it("never sets the relaunch notice on a fresh-session launch", async () => {
    const { session } = buildSession({ connectSequence: ["fail", "ok"] });
    await session.ensureReady();
    // Even after the failed first attempt, a fresh session that eventually
    // launches should NOT flag a relaunch-after-loss — there was no loss.
    expect(session.consumeRelaunchNotice()).toBeNull();
  });
});

describe("BrowserSession — established-session reconnect policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper: bring a session into "established" state (wasEverReady = true)
   * via an initial successful launch, then force a disconnect by nulling
   * out the cached connection so the next ensureReady() takes the
   * established-session branch.
   */
  async function establishAndLose<T extends { session: BrowserSession }>(ctx: T): Promise<void> {
    await ctx.session.ensureReady();
    // Simulate a connection loss: clear the connection + cached client
    // so `isReady` returns false but `wasEverReady` remains true.
    (ctx.session as unknown as { _connection: unknown })._connection = null;
    (ctx.session as unknown as { _cdpClient: unknown })._cdpClient = null;
    (ctx.session as unknown as { _sessionId: string | null })._sessionId = null;
    expect(ctx.session.isReady).toBe(false);
    expect(ctx.session.wasEverReady).toBe(true);
  }

  it("reconnects to the same Chrome on the first WebSocket-only retry", async () => {
    const ctx = buildSession({
      connectSequence: ["ok"],
      reconnectSequence: ["ok"],
    });
    await establishAndLose(ctx);
    await ctx.session.ensureReady();
    expect(ctx.reconnectCalls.count).toBe(1);
    // Importantly: NO fresh launch happened — the user's Chrome is preserved.
    expect(ctx.connectCalls.count).toBe(1); // only the initial establish
    expect(ctx.session.consumeRelaunchNotice()).toBeNull();
  });

  it("retries the WebSocket-only reconnect up to 3 times before giving up", async () => {
    const ctx = buildSession({
      connectSequence: ["ok", "ok"],
      reconnectSequence: ["fail", "fail", "ok"],
    });
    await establishAndLose(ctx);
    await ctx.session.ensureReady();
    expect(ctx.reconnectCalls.count).toBe(3); // all 3 attempts tried
    expect(ctx.session.consumeRelaunchNotice()).toBeNull();
  });

  it("silently launches a fresh Chrome after 3 failed reconnect attempts and sets the relaunch notice", async () => {
    const ctx = buildSession({
      connectSequence: ["ok", "ok"], // one for the initial establish, one for the fallback
      reconnectSequence: ["fail", "fail", "fail"],
    });
    await establishAndLose(ctx);
    await ctx.session.ensureReady();
    expect(ctx.reconnectCalls.count).toBe(3);
    expect(ctx.connectCalls.count).toBe(2); // initial + fallback
    // The relaunch notice must be surfaced so the LLM knows previous refs are stale.
    const notice = ctx.session.consumeRelaunchNotice();
    expect(notice).not.toBeNull();
    expect(notice).toMatch(/Chrome was not reachable/i);
    expect(notice).toMatch(/fresh browser/i);
    expect(notice).toMatch(/virtual_desk|tab_status/i);
  });

  it("consumeRelaunchNotice() clears the flag so subsequent calls return null", async () => {
    const ctx = buildSession({
      connectSequence: ["ok", "ok"],
      reconnectSequence: ["fail", "fail", "fail"],
    });
    await establishAndLose(ctx);
    await ctx.session.ensureReady();
    expect(ctx.session.consumeRelaunchNotice()).not.toBeNull();
    expect(ctx.session.consumeRelaunchNotice()).toBeNull();
    expect(ctx.session.consumeRelaunchNotice()).toBeNull();
  });
});

describe("BrowserSession — race safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parallel ensureReady() calls share a single in-flight launch", async () => {
    const ctx = buildSession({ connectSequence: ["ok"] });
    // Two tool calls arrive simultaneously during cold start — both must
    // wait on the same launch, not trigger two parallel ChromeLauncher
    // invocations.
    const [r1, r2] = await Promise.all([
      ctx.session.ensureReady(),
      ctx.session.ensureReady(),
    ]);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(ctx.connectCalls.count).toBe(1);
    expect(ctx.session.isReady).toBe(true);
  });

  it("ensureReady() is a no-op once the session is ready", async () => {
    const ctx = buildSession({ connectSequence: ["ok"] });
    await ctx.session.ensureReady();
    await ctx.session.ensureReady();
    await ctx.session.ensureReady();
    expect(ctx.connectCalls.count).toBe(1); // still just the initial launch
  });

  it("after shutdown() ensureReady() throws", async () => {
    const ctx = buildSession({});
    await ctx.session.shutdown();
    await expect(ctx.session.ensureReady()).rejects.toThrow(/shut down/i);
  });
});

describe("BrowserSession — tab switching", () => {
  it("applyTabSwitch() updates the session ID", async () => {
    const ctx = buildSession({ connectSequence: ["ok"] });
    await ctx.session.ensureReady();
    expect(ctx.session.sessionId).toBe("fake-session");
    ctx.session.applyTabSwitch("new-session-after-switch");
    expect(ctx.session.sessionId).toBe("new-session-after-switch");
  });

  it("BUG-019: applyTabSwitch() reinits DialogHandler on the new session", async () => {
    const ctx = buildSession({ connectSequence: ["ok"] });
    await ctx.session.ensureReady();

    // Inject a mock DialogHandler so we can observe reinit calls
    const reinitSpy = vi.fn();
    const mockDialogHandler = { reinit: reinitSpy };
    (ctx.session as unknown as { _dialogHandler: unknown })._dialogHandler = mockDialogHandler;

    ctx.session.applyTabSwitch("tab-2-session");

    expect(reinitSpy).toHaveBeenCalledOnce();
    expect(reinitSpy).toHaveBeenCalledWith(
      expect.anything(), // cdpClient
      "tab-2-session",
    );
  });
});
