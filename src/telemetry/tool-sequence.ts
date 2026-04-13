/**
 * Cross-Tool Sequence Tracker — Anti-Spiral Telemetry.
 *
 * Tracks the sequence of tool calls PER SESSION so the server can detect
 * when an LLM has fallen into a "Defensive Fallback Spiral" — a pattern
 * where a single tool error (stale ref, click miss) causes the model to
 * abandon the happy-path tools (click/type/fill_form) and route around
 * every subsequent interaction with evaluate(querySelector.click()).
 *
 * Session-scoped by design: Story 7.6 allows parallel tab execution via
 * sessionIdOverride. A global tracker would let streaks from one tab
 * silence a real spiral on another. Each sessionId gets its own
 * ToolSequenceTracker via a registry map.
 *
 * Design goals:
 *  - Detect >=3 consecutive evaluate calls that contain querySelector-
 *    style DOM-queries within a time window and emit a nudge hint.
 *  - Any successful happy-path call (read_page, click, type, fill_form)
 *    resets the evaluate-streak so a normal workflow stays unaffected.
 *  - Memory-bounded: keep at most the last MAX_EVENTS events per session.
 *  - No persistence, no cross-session bleed.
 *
 * Known limitation: "successful" is inferred from the handler reaching
 * its happy-path return, not from verified DOM effect. A click that
 * silently misses still resets the streak. This is acceptable for V1 —
 * the vast majority of failed clicks surface as RefNotFoundError or CDP
 * errors, which do NOT take the happy-path. True silent-success (rare)
 * is tracked separately by the evaluate anti-pattern hints.
 */

/** Threshold at which the streak-detector emits a hint. */
export const EVALUATE_STREAK_HINT_THRESHOLD = 3;

/** Maximum number of events kept in memory per session (ring-buffer trim). */
const MAX_EVENTS = 64;

/**
 * Time window in which consecutive evaluate calls count toward the streak.
 * Real spirals happen over seconds, not minutes. 60s is generous enough
 * to absorb slow human-in-the-loop scenarios without producing stale hints
 * when the LLM has moved on to a different task.
 */
const STREAK_WINDOW_MS = 60 * 1000;

/** Tools whose successful execution resets the evaluate streak. */
const RESET_TOOLS = new Set(["view_page", "click", "type", "fill_form", "press_key"]);

/** Flag attached to evaluate events when the expression contained a DOM-query. */
export const FLAG_QUERY_SELECTOR = "qs";

/**
 * Anonymous session used when a caller omits the sessionId argument.
 * All "global" events end up here. Used by older callers and tests.
 */
const DEFAULT_SESSION = "__default__";

interface ToolEvent {
  tool: string;
  timestamp: number;
  flags?: Set<string>;
}

export class ToolSequenceTracker {
  // Per-session event logs. A Map<sessionId, events[]> keeps parallel
  // tab-group executions isolated — Story 7.6 runs handler calls with
  // different sessionId overrides on the same tracker instance.
  private bySession = new Map<string, ToolEvent[]>();

  /**
   * Record a tool call for a specific session. Successful happy-path
   * tools implicitly reset the evaluate streak by virtue of being
   * recorded between evaluate events — the
   * `consecutiveEvaluateWithQuerySelector()` walk stops at the first
   * non-evaluate event.
   */
  record(tool: string, flags?: Set<string>, sessionId?: string): void {
    const sid = sessionId ?? DEFAULT_SESSION;
    let events = this.bySession.get(sid);
    if (!events) {
      events = [];
      this.bySession.set(sid, events);
    }
    events.push({ tool, timestamp: Date.now(), flags });
    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }
  }

  /**
   * Count how many of the most-recent consecutive tool calls in this
   * session were `evaluate` with the querySelector flag. A non-evaluate
   * call (or an evaluate without the flag, e.g. a legitimate computed-
   * value call) terminates the streak. Events older than
   * STREAK_WINDOW_MS are ignored entirely.
   */
  consecutiveEvaluateWithQuerySelector(sessionId?: string): number {
    const sid = sessionId ?? DEFAULT_SESSION;
    const events = this.bySession.get(sid);
    if (!events) return 0;
    const cutoff = Date.now() - STREAK_WINDOW_MS;
    let count = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.timestamp < cutoff) break;
      if (ev.tool !== "evaluate") break;
      if (!ev.flags?.has(FLAG_QUERY_SELECTOR)) break;
      count++;
    }
    return count;
  }

  /**
   * Build an anti-spiral hint string when the querySelector evaluate
   * streak has reached the threshold for the given session. Returns the
   * empty string when no hint should be emitted, so it can be safely
   * concatenated to any response text.
   */
  maybeEvaluateStreakHint(sessionId?: string): string {
    const streak = this.consecutiveEvaluateWithQuerySelector(sessionId);
    if (streak < EVALUATE_STREAK_HINT_THRESHOLD) return "";
    return (
      `\n\nWarning: ${streak} consecutive querySelector-based evaluate calls detected. ` +
      `This usually means a ref went stale or a tool failed silently and you fell back to evaluate. ` +
      `Call view_page once for fresh refs, then continue with click/type/fill_form. ` +
      `evaluate is a last resort — routing around tool errors wastes tokens and hides real bugs.`
    );
  }

  /** Total events tracked across all sessions (mostly useful for tests). */
  get size(): number {
    let total = 0;
    for (const events of this.bySession.values()) total += events.length;
    return total;
  }

  /** Forget all events for a specific session, or all sessions if omitted. */
  reset(sessionId?: string): void {
    if (sessionId === undefined) {
      this.bySession.clear();
    } else {
      this.bySession.delete(sessionId);
    }
  }
}

/**
 * Detect whether an evaluate expression contains a DOM-query pattern that
 * is typically used to route around a tool failure. Used by the evaluate
 * handler to flag events when recording.
 */
export function hasQuerySelectorPattern(expression: string): boolean {
  // querySelector, querySelectorAll, getElementById, getElementsBy*
  return /\b(querySelector(?:All)?|getElementById|getElementsBy(?:TagName|ClassName|Name))\s*\(/.test(
    expression,
  );
}

/** Internal reference to the RESET_TOOLS set, exported for tests. */
export function isResetTool(tool: string): boolean {
  return RESET_TOOLS.has(tool);
}

/** Module-level singleton analogous to `a11yTree`. */
export const toolSequence = new ToolSequenceTracker();
