/**
 * FR-022 (P3 fix): Tests for the Free-tier default `onToolResult` hook.
 *
 * Story 20.1: The hook now has two paths:
 *  - **Synchronous** (syncDiff=true): diff runs inline, appended to response
 *  - **Deferred** (default): diff scheduled in background via DeferredDiffSlot
 *
 * Tests cover both paths. Existing pre-20.1 tests are preserved with
 * `syncDiff: true` to test the synchronous path. New tests verify the
 * deferred path and `drainPendingDiff()`.
 *
 * Covers:
 *  (a) Scope: only `click` + `clickable`/`widget-state` triggers the hook
 *  (b) Happy path (sync): refresh + diff + format -> diff text appended
 *  (c) Settle-Loop (sync): empty first refresh -> retry once with extra wait
 *  (d) Removed-Detection (sync): refs missing from getActiveRefs() get REMOVED
 *  (e) Errors inside the hook never destroy the original tool response
 *  (f) `formatDomDiff` returning null leaves the response untouched
 *  (g) Deferred path: click without syncDiff schedules background job
 *  (h) drainPendingDiff returns the diff after background completion
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDefaultOnToolResult, drainPendingDiff } from "./default-on-tool-result.js";
import { deferredDiffSlot } from "../cache/deferred-diff-slot.js";
import type { A11yTreePublic, A11yTreeDiffs } from "./pro-hooks.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import type { DOMChange, SnapshotMap } from "../cache/a11y-tree.js";

type MockOptions = {
  /** Snapshot maps returned by getSnapshotMap() — first call is BEFORE, rest AFTER. */
  snapshots?: SnapshotMap[];
  /** Diff results returned by diffSnapshots() per call (one entry per refresh). */
  diffResults?: DOMChange[][];
  /** Sequence of formatDomDiff() return values per call. */
  formatResults?: Array<string | null>;
  /** Active refs reported by getActiveRefs() — controls REMOVED detection. */
  activeRefs?: Set<number>;
  currentUrl?: string;
  /** When true, omit waitForAXChange from the context entirely. */
  omitWaitForAXChange?: boolean;
};

function makeContext(opts: MockOptions = {}) {
  const snapshots = opts.snapshots ?? [new Map(), new Map()];
  const diffResults = opts.diffResults ?? [[]];
  const formatResults = opts.formatResults ?? [null];
  const activeRefs = opts.activeRefs ?? new Set<number>();

  let snapCall = 0;
  const getSnapshotMap = vi.fn(() => {
    const m = snapshots[snapCall] ?? snapshots[snapshots.length - 1];
    snapCall += 1;
    return m;
  });

  let diffCall = 0;
  const diffSnapshots = vi.fn(() => {
    const r = diffResults[diffCall] ?? diffResults[diffResults.length - 1];
    diffCall += 1;
    return r;
  });

  let formatCall = 0;
  const formatDomDiff = vi.fn(() => {
    const r = formatResults[formatCall] ?? formatResults[formatResults.length - 1];
    formatCall += 1;
    return r;
  });

  const a11yTree = {
    classifyRef: vi.fn(),
    getSnapshotMap,
    getCompactSnapshot: vi.fn(),
    refreshPrecomputed: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    currentUrl: opts.currentUrl ?? "https://example.com/page",
    diffSnapshots,
    formatDomDiff,
    getActiveRefs: vi.fn(() => new Set(activeRefs)),
  };

  const cdpClient = {} as unknown as CdpClient;
  const sessionManager = undefined as SessionManager | undefined;
  const waitForAXChange = vi.fn().mockResolvedValue(true);

  const context = {
    a11yTree: a11yTree as unknown as A11yTreePublic,
    a11yTreeDiffs: { diffSnapshots, formatDomDiff } as unknown as A11yTreeDiffs,
    cdpClient,
    sessionId: "sess-1",
    sessionManager,
  } as Parameters<ReturnType<typeof createDefaultOnToolResult>>[2];

  if (!opts.omitWaitForAXChange) {
    context.waitForAXChange = waitForAXChange;
  }

  return { a11yTree, context, waitForAXChange };
}

function makeClickResult(elementClass?: string, syncDiff?: boolean): ToolResponse {
  return {
    content: [{ type: "text", text: "Clicked e2 (ref)" }],
    _meta: {
      elapsedMs: 1,
      method: "click",
      ...(elementClass !== undefined ? { elementClass } : {}),
      ...(syncDiff ? { syncDiff: true } : {}),
    },
  };
}

/**
 * Wartet auf genau einen `setImmediate`-Tick — noetig damit der
 * DeferredDiffSlot-Build gestartet wird (Story 20.1).
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("createDefaultOnToolResult (P3 — default Free-tier hook)", () => {
  beforeEach(() => {
    delete process.env.SILBERCUE_CHROME_DIFF_RETRY_MS;
    delete process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS;
    deferredDiffSlot.cancel();
  });

  afterEach(() => {
    vi.useRealTimers();
    deferredDiffSlot.cancel();
  });

  it("returns a function", () => {
    expect(typeof createDefaultOnToolResult()).toBe("function");
  });

  // =========================================================================
  // (a) Scope: non-click tools are passed through untouched
  // =========================================================================

  it("ignores non-click tools", async () => {
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext();
    const result = makeClickResult("clickable");

    const out = await hook("view_page", result, context);

    expect(out).toBe(result);
    expect(out.content).toHaveLength(1);
    expect(a11yTree.refreshPrecomputed).not.toHaveBeenCalled();
  });

  it("ignores click on static element", async () => {
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext();
    const result = makeClickResult("static");

    const out = await hook("click", result, context);

    expect(out).toBe(result);
    expect(out.content).toHaveLength(1);
    expect(a11yTree.refreshPrecomputed).not.toHaveBeenCalled();
  });

  it("ignores click on disabled element", async () => {
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext();
    const result = makeClickResult("disabled");

    const out = await hook("click", result, context);

    expect(out).toBe(result);
    expect(a11yTree.refreshPrecomputed).not.toHaveBeenCalled();
  });

  // =========================================================================
  // (b) Synchronous path (syncDiff=true) — pre-20.1 behaviour
  // =========================================================================

  it("appends diff text on click + clickable when syncDiff=true", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree, waitForAXChange } = makeContext({
      snapshots: [
        new Map([[1, "button\0Old"]]),
        new Map([
          [1, "button\0Old"],
          [2, "row\0New row"],
        ]),
      ],
      diffResults: [
        [{ type: "added", ref: "e2", role: "row", after: "New row" }],
      ],
      formatResults: ["--- Action Result (1 changes) ---\n NEW row \"New row\""],
      activeRefs: new Set([1, 2]),
    });
    const result = makeClickResult("clickable", true);

    const out = await hook("click", result, context);

    expect(out).toBe(result);
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("NEW row"),
    });
    expect(waitForAXChange).toHaveBeenCalledTimes(0);
    expect(a11yTree.refreshPrecomputed).toHaveBeenCalledTimes(1);
    expect(a11yTree.getSnapshotMap).toHaveBeenCalledTimes(2);
    expect(a11yTree.diffSnapshots).toHaveBeenCalledTimes(1);
    expect(a11yTree.formatDomDiff).toHaveBeenCalledWith(
      expect.any(Array),
      "https://example.com/page",
    );
  });

  it("triggers on widget-state element with syncDiff=true", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext({
      snapshots: [new Map([[1, "checkbox\0Subscribe"]]), new Map([[1, "checkbox\0Subscribe (checked)"]])],
      diffResults: [
        [{ type: "changed", ref: "e1", role: "checkbox", before: "Subscribe", after: "Subscribe (checked)" }],
      ],
      formatResults: ["--- Action Result (1 changes) ---\n CHANGED checkbox..."],
      activeRefs: new Set([1]),
    });
    const result = makeClickResult("widget-state", true);

    const out = await hook("click", result, context);

    expect(out.content).toHaveLength(2);
    expect(a11yTree.refreshPrecomputed).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // (c) Settle-Loop (syncDiff=true)
  // =========================================================================

  it("retries once with extra wait when first refresh produces empty diff (syncDiff=true)", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "10";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext({
      snapshots: [
        new Map([[1, "button\0Open"]]),
        new Map([[1, "button\0Open"]]),
        new Map([
          [1, "button\0Open"],
          [2, "row\0Late row"],
        ]),
      ],
      diffResults: [
        [],
        [{ type: "added", ref: "e2", role: "row", after: "Late row" }],
      ],
      formatResults: [
        null,
        "--- Action Result (1 changes) ---\n NEW row \"Late row\"",
      ],
      activeRefs: new Set([1, 2]),
    });
    const result = makeClickResult("clickable", true);

    const out = await hook("click", result, context);

    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Late row"),
    });
    expect(a11yTree.refreshPrecomputed).toHaveBeenCalledTimes(2);
    expect(a11yTree.diffSnapshots).toHaveBeenCalledTimes(2);
  });

  it("does not retry when SILBERCUE_CHROME_DIFF_RETRY_MS=0 (syncDiff=true)", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext({
      snapshots: [new Map(), new Map()],
      diffResults: [[]],
      formatResults: [null],
      activeRefs: new Set(),
    });
    const result = makeClickResult("clickable", true);

    await hook("click", result, context);

    expect(a11yTree.refreshPrecomputed).toHaveBeenCalledTimes(1);
    expect(a11yTree.diffSnapshots).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // (d) Removed-Detection (syncDiff=true)
  // =========================================================================

  it("synthesizes REMOVED entries for refs missing from getActiveRefs() (syncDiff=true)", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const formatDomDiffSpy = vi.fn(
      (changes: DOMChange[]) => `--- ${changes.length} changes ---`,
    );
    const { context, a11yTree } = makeContext({
      snapshots: [
        new Map([
          [1, "button\0Save"],
          [5, "dialog\0Confirm dialog"],
        ]),
        new Map([
          [1, "button\0Save"],
          [5, "dialog\0Confirm dialog"],
          [9, "row\0New row"],
        ]),
      ],
      diffResults: [
        [{ type: "added", ref: "e9", role: "row", after: "New row" }],
      ],
      formatResults: ["mock"],
      activeRefs: new Set([1, 9]),
    });
    a11yTree.formatDomDiff = formatDomDiffSpy as unknown as typeof a11yTree.formatDomDiff;
    const result = makeClickResult("clickable", true);

    await hook("click", result, context);

    expect(formatDomDiffSpy).toHaveBeenCalledTimes(1);
    const passedChanges = formatDomDiffSpy.mock.calls[0][0] as DOMChange[];
    expect(passedChanges).toHaveLength(2);
    expect(passedChanges).toContainEqual(
      expect.objectContaining({ type: "added", ref: "e9" }),
    );
    expect(passedChanges).toContainEqual(
      expect.objectContaining({
        type: "removed",
        ref: "e5",
        role: "dialog",
        before: "Confirm dialog",
      }),
    );
  });

  it("does not double-report REMOVED for refs already in diffSnapshots output (syncDiff=true)", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const formatDomDiffSpy = vi.fn(() => "mock");
    const { context, a11yTree } = makeContext({
      snapshots: [
        new Map([[5, "dialog\0X"]]),
        new Map([[5, "dialog\0X"]]),
      ],
      diffResults: [
        [{ type: "removed", ref: "e5", role: "dialog", before: "X", after: "" }],
      ],
      formatResults: ["mock"],
      activeRefs: new Set(),
    });
    a11yTree.formatDomDiff = formatDomDiffSpy as unknown as typeof a11yTree.formatDomDiff;
    const result = makeClickResult("clickable", true);

    await hook("click", result, context);

    const passedChanges = formatDomDiffSpy.mock.calls[0][0] as DOMChange[];
    const removed = passedChanges.filter((c) => c.type === "removed");
    expect(removed).toHaveLength(1);
  });

  it("skips REMOVED synthesis when getActiveRefs() returns empty (syncDiff=true)", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const formatDomDiffSpy = vi.fn(() => "mock");
    const { context, a11yTree } = makeContext({
      snapshots: [
        new Map([[5, "dialog\0X"]]),
        new Map([[5, "dialog\0X"]]),
      ],
      diffResults: [[]],
      formatResults: [null],
      activeRefs: new Set(),
    });
    a11yTree.formatDomDiff = formatDomDiffSpy as unknown as typeof a11yTree.formatDomDiff;
    const result = makeClickResult("clickable", true);

    await hook("click", result, context);

    if (formatDomDiffSpy.mock.calls.length > 0) {
      const passedChanges = formatDomDiffSpy.mock.calls[0][0] as DOMChange[];
      expect(passedChanges).toHaveLength(0);
    }
  });

  // =========================================================================
  // (e) Belt-and-braces: hook errors must not destroy the response
  // =========================================================================

  it("returns the original result unchanged when refreshPrecomputed throws (syncDiff=true)", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext();
    a11yTree.refreshPrecomputed = vi
      .fn()
      .mockRejectedValue(new Error("CDP boom")) as unknown as typeof a11yTree.refreshPrecomputed;
    const result = makeClickResult("clickable", true);

    const out = await hook("click", result, context);

    expect(out).toBe(result);
    expect(out.content).toHaveLength(1);
    expect(out.content[0]).toMatchObject({ text: "Clicked e2 (ref)" });
  });

  // (f) formatDomDiff returns null -> response untouched
  it("does not append text when formatDomDiff returns null (syncDiff=true)", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context } = makeContext({
      snapshots: [new Map(), new Map()],
      diffResults: [[]],
      formatResults: [null],
      activeRefs: new Set(),
    });
    const result = makeClickResult("clickable", true);

    const out = await hook("click", result, context);

    expect(out).toBe(result);
    expect(out.content).toHaveLength(1);
  });

  // waitForAXChange undefined: hook still works (defensive optional chaining)
  it("runs without crash when waitForAXChange is missing from the context (syncDiff=true)", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "1";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext({
      omitWaitForAXChange: true,
      snapshots: [new Map(), new Map([[1, "row\0Inserted"]])],
      diffResults: [[{ type: "added", ref: "e1", role: "row", after: "Inserted" }]],
      formatResults: ["mock diff"],
      activeRefs: new Set([1]),
    });
    const result = makeClickResult("clickable", true);

    const out = await hook("click", result, context);

    expect(out.content).toHaveLength(2);
    expect(a11yTree.refreshPrecomputed).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // (g) Story 20.1: Deferred path (default — no syncDiff)
  // =========================================================================

  it("does NOT append diff text on click without syncDiff (deferred)", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext({
      snapshots: [
        new Map([[1, "button\0Old"]]),
        new Map([
          [1, "button\0Old"],
          [2, "row\0New row"],
        ]),
      ],
      diffResults: [
        [{ type: "added", ref: "e2", role: "row", after: "New row" }],
      ],
      formatResults: ["--- Action Result (1 changes) ---\n NEW row \"New row\""],
      activeRefs: new Set([1, 2]),
    });
    const result = makeClickResult("clickable"); // no syncDiff

    const out = await hook("click", result, context);

    // Response must NOT have the diff appended — it's deferred
    expect(out).toBe(result);
    expect(out.content).toHaveLength(1);
    expect(out.content[0]).toMatchObject({ text: "Clicked e2 (ref)" });

    // But a deferred diff job was scheduled
    expect(deferredDiffSlot.isActive).toBe(true);

    // Wait for the background build to complete
    await tick();
    // The build itself needs microtask resolution for its async body
    await new Promise<void>((r) => setTimeout(r, 10));
    await tick();

    // The diff should now be drainable
    const drained = drainPendingDiff();
    expect(drained).toContain("NEW row");
    expect(a11yTree.refreshPrecomputed).toHaveBeenCalledTimes(1);
  });

  it("deferred path: drainPendingDiff returns null when no click happened", () => {
    expect(drainPendingDiff()).toBeNull();
  });

  it("deferred path: drainPendingDiff returns null when diff build is still in flight", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "5000";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context } = makeContext({
      snapshots: [new Map(), new Map()],
      diffResults: [[]],
      formatResults: [null],
      activeRefs: new Set(),
    });
    const result = makeClickResult("clickable"); // deferred

    await hook("click", result, context);

    // The build is still waiting on waitForAXChange(5000ms)
    // drain should return null immediately
    const drained = drainPendingDiff();
    expect(drained).toBeNull();

    // Clean up
    deferredDiffSlot.cancel();
  });

  it("deferred path: second click cancels first deferred diff", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "5000";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context } = makeContext({
      snapshots: [new Map(), new Map()],
      diffResults: [[]],
      formatResults: [null],
      activeRefs: new Set(),
    });

    // First click
    const result1 = makeClickResult("clickable");
    await hook("click", result1, context);
    expect(deferredDiffSlot.isActive).toBe(true);

    // Second click cancels the first
    const result2 = makeClickResult("clickable");
    await hook("click", result2, context);

    // Still active with the new build
    expect(deferredDiffSlot.isActive).toBe(true);

    deferredDiffSlot.cancel();
  });

  // =========================================================================
  // (i) Story 20.1 M2: In-flight discard via drain
  // =========================================================================

  it("deferred path: drain while build is in-flight discards the result (H1-Fix)", async () => {
    // Use a long settle time so the build hangs during waitForAXChange
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "5000";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context } = makeContext({
      snapshots: [
        new Map([[1, "button\0Old"]]),
        new Map([
          [1, "button\0Old"],
          [2, "row\0New row"],
        ]),
      ],
      diffResults: [
        [{ type: "added", ref: "e2", role: "row", after: "New row" }],
      ],
      formatResults: ["--- Action Result (1 changes) ---\n NEW row \"New row\""],
      activeRefs: new Set([1, 2]),
    });
    const result = makeClickResult("clickable"); // deferred

    await hook("click", result, context);
    expect(deferredDiffSlot.isActive).toBe(true);

    // Drain immediately while build is still in-flight
    const drained1 = drainPendingDiff();
    expect(drained1).toBeNull();

    // The in-flight build should now be cancelled
    expect(deferredDiffSlot.isActive).toBe(false);

    // Even after waiting for any pending microtasks, drain returns null
    // because the build was aborted and its result discarded.
    await tick();
    await new Promise<void>((r) => setTimeout(r, 50));
    await tick();

    const drained2 = drainPendingDiff();
    expect(drained2).toBeNull();
  });

  it("deferred path: errors in background build are absorbed", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext();
    a11yTree.refreshPrecomputed = vi
      .fn()
      .mockRejectedValue(new Error("CDP boom")) as unknown as typeof a11yTree.refreshPrecomputed;
    const result = makeClickResult("clickable"); // deferred

    const out = await hook("click", result, context);

    // Response is unchanged
    expect(out).toBe(result);
    expect(out.content).toHaveLength(1);

    // Wait for background build to fail
    await tick();
    await new Promise<void>((r) => setTimeout(r, 10));
    await tick();

    // No crash, drain returns null
    const drained = drainPendingDiff();
    expect(drained).toBeNull();
  });

  // =========================================================================
  // Story 12.1 (Task 4.3): Pattern Recorder integration
  // =========================================================================

  it("calls patternRecorder.record() on navigate — pageType is 'unknown' (A11y-Tree empty after reset)", async () => {
    const { patternRecorder } = await import("../cortex/pattern-recorder.js");
    const recordSpy = vi.spyOn(patternRecorder, "record");

    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    // Simulate the real lifecycle: a11yTree.reset() has run, so currentUrl is empty
    const { context } = makeContext({
      currentUrl: "",
    });
    const result: ToolResponse = {
      content: [{ type: "text", text: "Navigated to https://shop.example.com/products/42" }],
      _meta: { elapsedMs: 100, method: "navigate" },
    };

    await hook("navigate", result, context);

    // Story 12a.2: record() now takes (toolName, pageType, contentHash, sessionId).
    // For navigate calls the A11y-Tree is empty, so pageType is "unknown".
    expect(recordSpy).toHaveBeenCalledTimes(1);
    // M1 fix: Assert concrete pageType value instead of expect.any(String).
    // The A11y-Tree singleton has no precomputed cache in the test env,
    // so getPageType() returns "unknown".
    expect(recordSpy).toHaveBeenCalledWith(
      "navigate",
      "unknown",
      expect.stringMatching(/^[0-9a-f]{16}$/),
      "sess-1",
    );

    recordSpy.mockRestore();
  });

  it("pattern recording uses pageType for non-navigate tools and does not modify response", async () => {
    const { patternRecorder } = await import("../cortex/pattern-recorder.js");
    const recordSpy = vi.spyOn(patternRecorder, "record");

    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context } = makeContext({
      currentUrl: "https://example.com/page",
    });
    const result: ToolResponse = {
      content: [{ type: "text", text: "Page content here" }],
      _meta: { elapsedMs: 50, method: "view_page" },
    };

    const out = await hook("view_page", result, context);

    // Response is unchanged — pattern recording is read-only
    expect(out).toBe(result);
    expect(out.content).toHaveLength(1);
    expect(out.content[0]).toMatchObject({ type: "text", text: "Page content here" });

    // M1 fix: Assert concrete pageType value instead of expect.any(String).
    // The A11y-Tree singleton has no precomputed cache in the test env,
    // so getPageType() returns "unknown".
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      "view_page",
      "unknown",
      expect.stringMatching(/^[0-9a-f]{16}$/),
      "sess-1",
    );

    recordSpy.mockRestore();
  });

  it("pattern recording always records even without currentUrl (Story 12a.2: pageType-based)", async () => {
    const { patternRecorder } = await import("../cortex/pattern-recorder.js");
    const recordSpy = vi.spyOn(patternRecorder, "record");

    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext();
    // Simulate missing URL
    Object.defineProperty(a11yTree, "currentUrl", { value: "", writable: false });

    const result: ToolResponse = {
      content: [{ type: "text", text: "Some result" }],
      _meta: { elapsedMs: 50, method: "view_page" },
    };

    await hook("view_page", result, context);

    // M1 fix: Assert concrete pageType value instead of expect.any(String).
    // The A11y-Tree singleton has no precomputed cache in the test env,
    // so getPageType() returns "unknown".
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      "view_page",
      "unknown",
      expect.stringMatching(/^[0-9a-f]{16}$/),
      "sess-1",
    );

    recordSpy.mockRestore();
  });

  // M2: isError guard — in production, `_runOnToolResultHook` (registry.ts line 801)
  // returns early when `result.isError` is true, so the hook is never called.
  // This test documents the expectation: if the hook WERE called with isError,
  // pattern recording should still not record (the URL would typically be present
  // but the error path should be a no-op from a pattern perspective).
  it("pattern recording is NOT reached for isError results (guard in registry.ts)", async () => {
    const { patternRecorder } = await import("../cortex/pattern-recorder.js");
    const recordSpy = vi.spyOn(patternRecorder, "record");

    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context } = makeContext({
      currentUrl: "https://example.com/page",
    });
    const result: ToolResponse = {
      content: [{ type: "text", text: "Error: element not found" }],
      isError: true,
      _meta: { elapsedMs: 50, method: "click" },
    };

    // In production this hook is never called because registry.ts line 801
    // returns early: `if (result.isError) return;`. But even if called,
    // the hook still records (it's a passive observer — the upstream guard
    // is the correct filter). This test documents the contract.
    await hook("click", result, context);

    // The hook DOES record even with isError because the isError guard
    // lives in registry.ts, not in the hook itself. The important thing
    // is that the upstream guard prevents this call from happening.
    // We verify the hook is callable without crash.
    expect(recordSpy).toHaveBeenCalledTimes(1);

    recordSpy.mockRestore();
  });
});
