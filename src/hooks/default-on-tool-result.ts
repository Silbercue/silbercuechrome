/**
 * FR-022 (P3 fix): Free-tier default `onToolResult` hook.
 *
 * The `click` tool description promises every caller that the response
 * "already includes the DOM diff (NEW/REMOVED/CHANGED lines)". Up until
 * Story 16.6 that promise was kept by a custom `onToolResult` hook — but
 * no default hook was registered, so users without a custom hook got the
 * bare `Clicked eX (...)` text and a documentation lie.
 *
 * This module ports the 3-stage click-analysis logic into the Free-Repo as
 * the default hook so the promise holds for everyone, on every page. The
 * Hook consumers can still register their own richer hook before `startServer()` —
 * `ToolRegistry.registerAll()` only installs this default when no
 * `onToolResult` is set.
 *
 * Story 20.1: Async DOM-Diff — Click antwortet sofort, Diff piggybacks.
 *
 * v0.7.3: Extended to type and fill_form — without post-action state
 * feedback the LLM is blind after input actions and falls back to
 * capture_image every time. See inline comment at the scope gate for
 * the full rationale and benchmark trade-off analysis.
 *
 * The hook now has TWO paths:
 *  - **Synchronous path** (`_meta.syncDiff === true` or called from
 *    `runAggregationHook`): identical to the pre-20.1 behaviour — waits
 *    for the diff and appends it to the response.
 *  - **Deferred path** (default for click/type/fill_form): schedules a
 *    background diff job via `DeferredDiffSlot`. The tool response returns
 *    immediately without the diff. The diff piggybacks on the next tool
 *    response via `drainPendingDiff()`.
 *
 * Improvements over the original implementation:
 *
 *  - **Settle-Loop** (P3 root cause #2): when the first refresh produces an
 *    empty diff — typical for slow React/Vue re-renders that exceed the
 *    initial 350 ms wait window — the hook waits an additional
 *    `SILBERCUE_CHROME_DIFF_RETRY_MS` ms (default 500) and refreshes once
 *    more before giving up. This catches modal-close + table-reload races
 *    that the original fixed-wait variant silently dropped.
 *  - **Removed-Detection** (P3 root cause #3): refs whose owning
 *    backendNodeId is no longer present in the live AX tree get reported as
 *    REMOVED, even though `reverseMap` deliberately keeps them around (so
 *    the LLM can react to "stale ref" errors). The hook compares the
 *    pre-click snapshot map against the new `getActiveRefs()` set exposed
 *    on `A11yTreePublic`.
 *
 * Tunable via env vars (zero = disable):
 *   SILBERCUE_CHROME_DIFF_SETTLE_MS  — initial waitForAXChange budget (350)
 *   SILBERCUE_CHROME_DIFF_RETRY_MS   — extra settle window before retry  (500)
 */
import type { ToolResponse } from "../types.js";
import type { ProHooks, A11yTreePublic } from "./pro-hooks.js";
import type { DOMChange, SnapshotMap } from "../cache/a11y-tree.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import { deferredDiffSlot } from "../cache/deferred-diff-slot.js";
import { debug } from "../cdp/debug.js";
import { patternRecorder, PatternRecorder } from "../cortex/pattern-recorder.js";
import { a11yTree } from "../cache/a11y-tree.js";

const DEFAULT_INITIAL_WAIT_MS = 350;
const DEFAULT_RETRY_WAIT_MS = 500;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

type OnToolResult = NonNullable<ProHooks["onToolResult"]>;

/**
 * The core diff logic extracted as a standalone async function.
 * Used by both the synchronous path (inline diff) and the deferred path
 * (background diff via DeferredDiffSlot).
 *
 * Returns the formatted diff text, or null if no changes were detected.
 */
export async function computeDiff(
  before: SnapshotMap,
  context: {
    a11yTree: A11yTreePublic;
    waitForAXChange?: (timeoutMs: number) => Promise<boolean>;
    cdpClient: CdpClient;
    sessionId: string;
    sessionManager?: SessionManager;
  },
  initialWaitMs: number,
  retryWaitMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const computeChanges = async (waitMs: number): Promise<DOMChange[]> => {
    if (signal?.aborted) return [];
    if (waitMs > 0) {
      try {
        await context.waitForAXChange?.(waitMs);
      } catch (err) {
        debug("[default-on-tool-result] waitForAXChange threw:", err);
      }
    }
    if (signal?.aborted) return [];
    await context.a11yTree.refreshPrecomputed(
      context.cdpClient,
      context.sessionId,
      context.sessionManager,
    );
    if (signal?.aborted) return [];
    const after = context.a11yTree.getSnapshotMap();
    const changes = context.a11yTree.diffSnapshots(before, after);

    // Removed-Detection
    const activeRefs = context.a11yTree.getActiveRefs();
    if (activeRefs.size > 0) {
      const reportedRefs = new Set(changes.map((c) => c.ref));
      for (const [refNum, encoded] of before) {
        const refTag = `e${refNum}`;
        if (reportedRefs.has(refTag)) continue;
        if (activeRefs.has(refNum)) continue;
        const sep = encoded.indexOf("\0");
        const role = sep >= 0 ? encoded.slice(0, sep) : encoded;
        const name = sep >= 0 ? encoded.slice(sep + 1) : "";
        if (!name) continue;
        changes.push({ type: "removed", ref: refTag, role, before: name, after: "" });
      }
    }

    return changes;
  };

  let changes = await computeChanges(initialWaitMs);

  // Settle-Loop
  if (changes.length === 0 && retryWaitMs > 0) {
    if (signal?.aborted) return null;
    try {
      await new Promise<void>((r) => setTimeout(r, retryWaitMs));
    } catch (err) {
      debug("[default-on-tool-result] settle delay threw:", err);
    }
    if (signal?.aborted) return null;
    changes = await computeChanges(retryWaitMs);
  }

  if (signal?.aborted) return null;

  return context.a11yTree.formatDomDiff(
    changes,
    context.a11yTree.currentUrl || undefined,
  );
}

/**
 * Builds the default `onToolResult` callback. Reads the env-var tunables
 * once at construction time so a single hook instance has stable timing
 * during the life of a server.
 */
export function createDefaultOnToolResult(): OnToolResult {
  const initialWaitMs = envInt("SILBERCUE_CHROME_DIFF_SETTLE_MS", DEFAULT_INITIAL_WAIT_MS);
  const retryWaitMs = envInt("SILBERCUE_CHROME_DIFF_RETRY_MS", DEFAULT_RETRY_WAIT_MS);

  return async (toolName, result, context) => {
    try {
      // --- Scope gate: which tools get a DOM diff? ---
      //
      // click:     Yes, when elementClass is "clickable" or "widget-state".
      //            This has been the case since Story 13a.1 / FR-022.
      //
      // type:      Yes (added v0.7.3). Without a diff, the LLM is blind after
      //            typing into a search/filter field — it gets only "Typed X
      //            into Y" and has NO information about whether the filter
      //            produced results. This forces the LLM to call capture_image
      //            or view_page as a follow-up, which is the #1 cause of
      //            unnecessary capture_image calls in production sessions.
      //            Session d4ce6dd5 (Steuer4, 2026-04-12): 7 of 7 capture_image
      //            calls happened immediately after type — every single one
      //            was compensating for missing post-type state feedback.
      //
      // fill_form: Yes (added v0.7.3). Same reasoning as type — multi-field
      //            form submissions often trigger AJAX updates (filter tables,
      //            validation messages, totals) that the LLM needs to see.
      //
      // Trade-off: This increases avg response size for type/fill_form by
      //            ~500-2000 chars (the diff text). Benchmark metrics like
      //            "avg response chars" will go up. That is intentional — the
      //            alternative is the LLM burning a full capture_image call
      //            (image payload + LLM vision inference) or view_page call
      //            (extra round-trip) to get the same information. Net token
      //            cost goes DOWN because one richer response replaces two
      //            calls. But per-tool averages go up, which will show in
      //            head-to-head comparisons with MCPs that don't do this.
      //
      // navigate:  No — navigate resets the a11y cache entirely (a11yTree.reset()
      //            in registry.ts) because the page is completely new. A diff
      //            against the previous page is meaningless. Navigate uses
      //            speculative prefetch instead (Story 18.5) to warm the cache
      //            for the next view_page call.

      // --- DOM-Diff scope gate ---
      const DIFF_TOOLS = new Set(["click", "type", "fill_form"]);
      const needsDiff = DIFF_TOOLS.has(toolName);

      let skipDiff = !needsDiff;
      if (needsDiff && toolName === "click") {
        // For click: only diff when the element was actually interactive.
        // type/fill_form always target input elements, so no class check needed.
        const cls = (
          result as ToolResponse & { _meta?: { elementClass?: string } }
        )._meta?.elementClass;
        if (cls !== "clickable" && cls !== "widget-state") skipDiff = true;
      }

      if (!skipDiff) {
        // --- Synchronous vs. deferred diff ---
        //
        // type/fill_form: ALWAYS synchronous (+350ms inline wait).
        //   The LLM types into a search field and ALWAYS needs to see the
        //   result (autocomplete suggestions, filtered table rows, validation
        //   messages). Deferred saves 350ms on the type response but forces
        //   the LLM to make a follow-up view_page call (~2-3s round-trip)
        //   just to see what happened. Net effect: deferred is slower, not
        //   faster. One richer type response beats two lean calls.
        //
        // click: Deferred by default (LLM sees "Clicked eX" immediately,
        //   diff piggybacks on the next tool call). Clicks are often chained
        //   (click tab → click row → click button) so the 350ms saving per
        //   click compounds. The LLM doesn't always need the diff before its
        //   next action. Exception: `wait_for_diff: true` or `runAggregationHook`
        //   (plan-executor end-of-plan) force the synchronous path via
        //   `_meta.syncDiff`.
        const syncDiff = (result as ToolResponse & { _meta?: { syncDiff?: boolean } })._meta?.syncDiff === true;
        const useSyncPath = syncDiff || toolName === "type" || toolName === "fill_form";

        // Stage 1: Snapshot BEFORE (synchronous, 0ms — from current cache).
        const before = context.a11yTree.getSnapshotMap();

        if (useSyncPath) {
          // --- Synchronous path ---
          const diffText = await computeDiff(before, context, initialWaitMs, retryWaitMs);
          if (diffText) {
            result.content.push({ type: "text", text: diffText });
          }
        } else {
          // --- Deferred path (click default) ---
          // Schedule a background diff job. The click response returns immediately.
          void deferredDiffSlot
            .schedule(async (signal: AbortSignal) => {
              return computeDiff(before, context, initialWaitMs, retryWaitMs, signal);
            })
            .catch((err: unknown) => {
              // Defense-in-depth: DeferredDiffSlot absorbs errors internally.
              if (err instanceof Error && err.name === "AbortError") return;
              debug(
                "DeferredDiffSlot schedule leaked an error: %s",
                err instanceof Error ? err.message : String(err),
              );
            });
        }
      }

      // --- Story 12.1 / 12a.2: Pattern Recording (Cortex Phase 1) ---
      //
      // Record every successful tool call for the Cortex pattern recorder.
      // The recorder is a passive observer — it reads the response content
      // and buffers events internally. It NEVER modifies the tool response.
      //
      // Story 12a.2: Page type classification replaces URL-based domain/path.
      //  - For `navigate`: pageType is "unknown" (A11y-Tree is empty after reset).
      //    This is correct — navigate alone never forms a recordable sequence
      //    (MIN_SEQUENCE_LENGTH = 2). The pattern uses the pageType from the
      //    LAST event in the sequence (typically after view_page/click).
      //  - For all other tools: pageType from the precomputed A11y-Tree cache.
      //
      // Session-scoped: the sessionId from context is passed through so the
      // recorder maintains separate buffers per session (parallel tabs).
      try {
        // Determine page type from the A11y-Tree singleton cache.
        // For navigate calls the cache is empty (reset runs before this hook),
        // so getPageType() returns "unknown" — which is the correct behavior.
        // C1 fix: pass sessionId for tab isolation — ensures the cached tree
        // belongs to the active tab, not a stale tree from another tab.
        const pageType = a11yTree.getPageType(context.sessionId);

        // Compute content hash from text content blocks
        const textContent = result.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        const contentHash = PatternRecorder.computeContentHash(textContent);

        patternRecorder.record(toolName, pageType, contentHash, context.sessionId);
      } catch (recordErr) {
        // Pattern recording must NEVER disrupt the tool response.
        debug("[default-on-tool-result] pattern recording threw: %s",
          recordErr instanceof Error ? recordErr.message : String(recordErr));
      }

      return result;
    } catch (err) {
      // Belt-and-braces — the hook must never destroy a tool response.
      debug("[default-on-tool-result] hook threw:", err);
      return result;
    }
  };
}

/**
 * Story 20.1: Drain the pending deferred diff.
 *
 * Non-blocking: returns the diff text if a background job has completed,
 * or null if no diff is ready (build still in flight or no diff produced).
 * The diff is consumed (set to null) after draining.
 *
 * Called from `registry.ts executeTool()` before the tool handler runs.
 */
export function drainPendingDiff(): string | null {
  return deferredDiffSlot.drain();
}
