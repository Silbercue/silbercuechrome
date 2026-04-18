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
 *
 * FR-045 (2026-04-19): 3-Tier escalation to defeat "Context Rot" on
 * long-running evaluate spirals. Session 74b2a8fc showed 17 identical
 * Tier-1 hints ignored by the LLM over 4 spirals (peak 8 consecutive
 * evaluates). Anti-fatigue measures:
 *  - Tier 1 (streak 3-4): sachlicher Stale-Ref hint (unchanged).
 *  - Tier 2 (streak 5-7): variierender Text, kontext-sensitiv auf dem
 *    letzten evaluate-Argument (navigate|scroll|generic).
 *  - Tier 3 (streak 8-11): isError-Signal via getStreakTier(), Text
 *    enthaelt "STOP" + Platzhalter `<result>` fuer JS-Ergebnis.
 *  - Tier 4 (streak >=12): Hard-Refuse, Result wird NICHT ausgeliefert.
 */

/** Threshold at which the querySelector streak-detector emits a hint. */
export const EVALUATE_STREAK_HINT_THRESHOLD = 3;

/** Threshold for ANY consecutive evaluate calls (regardless of flags). */
export const EVALUATE_ANY_STREAK_THRESHOLD = 5;

/** FR-045 — Tier 2 threshold: escalate to variierender context-sensitive hint. */
export const EVALUATE_STREAK_TIER2_THRESHOLD = 5;

/** FR-045 — Tier 3 threshold: escalate to isError: true + result preservation. */
export const EVALUATE_STREAK_TIER3_THRESHOLD = 8;

/** FR-045 — Tier 4 threshold: hard-refuse, JS result dropped (defensive guard). */
export const EVALUATE_STREAK_TIER4_THRESHOLD = 12;

/** Maximum number of events kept in memory per session (ring-buffer trim). */
const MAX_EVENTS = 64;

/**
 * Time window in which consecutive evaluate calls count toward the streak.
 * Real spirals happen over seconds, not minutes. 60s is generous enough
 * to absorb slow human-in-the-loop scenarios without producing stale hints
 * when the LLM has moved on to a different task.
 */
const STREAK_WINDOW_MS = 60 * 1000;

/**
 * Tools whose successful execution resets the evaluate streak.
 *
 * FR-045: `scroll` joins the set because it is a legitimate dedicated
 * interaction — not a fallback. A spiral that self-corrects by scrolling
 * should not keep escalating the Tier on subsequent evaluate calls.
 * `navigate` is explicitly NOT in this set: a cross-page move is
 * desirable behaviour when the streak-hint fires, and the downstream
 * session is naturally fresh, so we want Tier 3's "navigate" suggestion
 * to be the obvious reset path.
 */
const RESET_TOOLS = new Set([
  "view_page",
  "click",
  "type",
  "fill_form",
  "press_key",
  "scroll",
  "navigate",
]);

/** Flag attached to evaluate events when the expression contained a DOM-query. */
export const FLAG_QUERY_SELECTOR = "qs";

/**
 * Anonymous session used when a caller omits the sessionId argument.
 * All "global" events end up here. Used by older callers and tests.
 */
const DEFAULT_SESSION = "__default__";

/** FR-045 — Tier classification for the evaluate streak. */
export type StreakTier = 0 | 1 | 2 | 3 | 4;

/** FR-045 — Context-sensitive hint style chosen by expression analysis. */
export type Tier2HintKind = "navigate" | "scroll" | "generic";

interface ToolEvent {
  tool: string;
  timestamp: number;
  flags?: Set<string>;
  /** FR-045 — remember the expression so Tier 2+ can analyse it later. */
  expression?: string;
}

/**
 * FR-045 — structured streak response returned to the evaluate handler.
 *
 * - `tier` drives whether `isError: true` is set (Tier >= 3).
 * - `text` is the hint to append (Tier 1/2) or the full replacement
 *   payload (Tier 3/4, contains the literal string `<result>` at
 *   Tier 3 for the handler to substitute with the truncated JS result).
 * - `streak` is the current consecutive-count (for telemetry/tests).
 */
export interface StreakResponse {
  tier: StreakTier;
  text: string;
  streak: number;
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
   *
   * FR-045: an optional `expression` lets the evaluate handler record
   * the last JS payload so Tier 2+ can do context-sensitive routing
   * (querySelectorAll + href → navigate hint, getBoundingClientRect
   * → scroll hint).
   */
  record(
    tool: string,
    flags?: Set<string>,
    sessionId?: string,
    expression?: string,
  ): void {
    const sid = sessionId ?? DEFAULT_SESSION;
    let events = this.bySession.get(sid);
    if (!events) {
      events = [];
      this.bySession.set(sid, events);
    }
    events.push({ tool, timestamp: Date.now(), flags, expression });
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
   * Count consecutive evaluate calls of ANY kind (regardless of flags).
   * Any non-evaluate call terminates the streak. Used for the broader
   * "you've been using evaluate a lot" hint that fires at a higher
   * threshold than the querySelector-specific one.
   */
  consecutiveEvaluateCalls(sessionId?: string): number {
    const sid = sessionId ?? DEFAULT_SESSION;
    const events = this.bySession.get(sid);
    if (!events) return 0;
    const cutoff = Date.now() - STREAK_WINDOW_MS;
    let count = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.timestamp < cutoff) break;
      if (ev.tool !== "evaluate") break;
      count++;
    }
    return count;
  }

  /**
   * Build an anti-spiral hint string. Two tiers:
   *  1. querySelector streak ≥ 3 → specific stale-ref hint (takes priority)
   *  2. ANY evaluate streak ≥ 5 → generic "consider dedicated tools" hint
   * Returns empty string when no hint should be emitted.
   *
   * FR-045: Tier 1 text is unchanged. Tier 2+ escalation is served
   * through `evaluateStreakResponse()`. This method retains its
   * Tier-1-only-shape so existing callers and tests keep working.
   */
  maybeEvaluateStreakHint(sessionId?: string): string {
    const response = this.evaluateStreakResponse(sessionId);
    // Tier 0 → empty string. Tier 1/2 → hint text (appendable). Tier 3/4
    // use replacement payloads with a `<result>` placeholder — they
    // make no sense as a bare append, so expose them only through the
    // richer API. Callers that only know the legacy API still get the
    // specific Tier 1 string.
    if (response.tier === 0) return "";
    if (response.tier === 1 || response.tier === 2) return response.text;
    return "";
  }

  /**
   * FR-045 — Return the full streak response (tier + text + streak).
   * Callers who want to drive `isError: true` or embed the JS result
   * use this richer API; `maybeEvaluateStreakHint()` remains available
   * for string-append callers.
   *
   * `expressionOverride` lets the caller pass the current evaluate
   * expression even before `record()` has been invoked for this call
   * (the default path reads the most recent recorded event).
   */
  evaluateStreakResponse(
    sessionId?: string,
    expressionOverride?: string,
  ): StreakResponse {
    const qsStreak = this.consecutiveEvaluateWithQuerySelector(sessionId);
    const anyStreak = this.consecutiveEvaluateCalls(sessionId);

    // Pick the streak value that governs the tier. QuerySelector-based
    // spirals are the dangerous kind (route-around-failure pattern), so
    // they take priority. If the model is doing mixed evaluate (some qs,
    // some pure-computation) we still respect the any-streak once it
    // crosses its broader threshold.
    const streak = Math.max(qsStreak, anyStreak);
    const isQueryDominated = qsStreak >= EVALUATE_STREAK_HINT_THRESHOLD;

    // Tier 4 — hard-refuse. Defensive guard only, not the default path.
    if (streak >= EVALUATE_STREAK_TIER4_THRESHOLD) {
      return {
        tier: 4,
        streak,
        text: this.tier4Text(streak),
      };
    }

    // Tier 3 — isError + result preservation. Anti-fatigue via "STOP".
    if (streak >= EVALUATE_STREAK_TIER3_THRESHOLD) {
      return {
        tier: 3,
        streak,
        text: this.tier3Text(streak, this.expressionForHint(sessionId, expressionOverride)),
      };
    }

    // Tier 2 — variierender context-sensitive hint. Only fires when
    // either the qs-streak or any-streak has passed their thresholds.
    if (
      streak >= EVALUATE_STREAK_TIER2_THRESHOLD ||
      (isQueryDominated && streak >= EVALUATE_STREAK_TIER2_THRESHOLD)
    ) {
      return {
        tier: 2,
        streak,
        text: this.tier2Text(streak, this.expressionForHint(sessionId, expressionOverride)),
      };
    }

    // Tier 1 — sachlicher Stale-Ref hint (only for the querySelector pattern).
    if (isQueryDominated) {
      return {
        tier: 1,
        streak: qsStreak,
        text: this.tier1Text(qsStreak),
      };
    }

    // The any-streak generic hint (Story 23.1). It lives at the Tier-2
    // threshold and was previously the only non-qs path.
    if (anyStreak >= EVALUATE_ANY_STREAK_THRESHOLD) {
      return {
        tier: 2,
        streak: anyStreak,
        text: this.tier2Text(anyStreak, this.expressionForHint(sessionId, expressionOverride)),
      };
    }

    return { tier: 0, streak: 0, text: "" };
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

  // ---------- FR-045 helpers ---------------------------------------------

  /**
   * Pull the most recent evaluate expression for this session — used by
   * Tier 2/3 to pick a context-sensitive hint. Falls back to an explicit
   * override so the evaluate handler can pass the current expression
   * before it has been recorded.
   */
  private expressionForHint(
    sessionId?: string,
    expressionOverride?: string,
  ): string | undefined {
    if (expressionOverride !== undefined) return expressionOverride;
    const sid = sessionId ?? DEFAULT_SESSION;
    const events = this.bySession.get(sid);
    if (!events) return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].tool === "evaluate" && events[i].expression) {
        return events[i].expression;
      }
    }
    return undefined;
  }

  private tier1Text(streak: number): string {
    return (
      `\n\nWarning: ${streak} consecutive querySelector-based evaluate calls detected. ` +
      `This usually means a ref went stale or a tool failed silently and you fell back to evaluate. ` +
      `Call view_page once for fresh refs, then continue with click/type/fill_form. ` +
      `evaluate is a last resort — routing around tool errors wastes tokens and hides real bugs.`
    );
  }

  private tier2Text(streak: number, expression: string | undefined): string {
    const kind = classifyExpressionForTier2(expression);
    if (kind === "navigate") {
      return (
        `\n\nNotice: ${streak} consecutive evaluate calls filtering DOM for content. ` +
        `The page may not contain the answer. Alternatives: ` +
        `(a) navigate(url) to a different page — the data might live under a different route, ` +
        `(b) view_page(filter:"all") to see ALL text with refs, ` +
        `(c) scroll(container_ref:"eN") if the content is in a virtualised list.`
      );
    }
    if (kind === "scroll") {
      return (
        `\n\nNotice: ${streak} consecutive evaluate calls reading layout/scroll state. ` +
        `Use scroll(container_ref:"eN", direction:"down") or scroll(ref:"eN") — ` +
        `it tracks scrollHeight growth natively.`
      );
    }
    return (
      `\n\nNotice: ${streak} consecutive evaluate calls. Consider: ` +
      `navigate(url) for cross-page moves, ` +
      `view_page(filter:"all") for exhaustive refs, ` +
      `scroll / click / type / fill_form for interaction. ` +
      `evaluate is for JS computation, not for routing around failed tool calls. ` +
      `Dedicated tools that may help: scroll, handle_dialog, network_monitor, wait_for.`
    );
  }

  private tier3Text(streak: number, expression: string | undefined): string {
    const kind = classifyExpressionForTier2(expression);
    let nextAction: string;
    if (kind === "navigate") {
      nextAction =
        `Required next action: navigate(url) to a different page OR summarise findings and stop. ` +
        `Further evaluate calls will likely fail the same way.`;
    } else if (kind === "scroll") {
      nextAction =
        `Required next action: scroll(container_ref:"eN") to reveal hidden content OR navigate(url) ` +
        `to a different page. Further evaluate calls will likely fail the same way.`;
    } else {
      nextAction =
        `Required next action: navigate(url) to a different page OR summarise findings and stop. ` +
        `Further evaluate calls will likely fail the same way.`;
    }
    // `<result>` is a placeholder substituted by the evaluate handler.
    return (
      `STOP — ${streak} consecutive querySelector-based evaluate calls. ` +
      `The page does not contain the answer through DOM queries.\n\n` +
      `JS result: <result>\n\n` +
      `${nextAction}`
    );
  }

  private tier4Text(streak: number): string {
    return (
      `REFUSED — ${streak} consecutive querySelector-based evaluate calls. ` +
      `Further evaluate calls are blocked. Call navigate(url), view_page, or explicitly abort the task.`
    );
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

/**
 * FR-045 — classify the evaluate expression so Tier 2/3 can emit a
 * context-sensitive hint.
 *
 *  - `navigate`: querySelectorAll + href|textContent|innerText → link-
 *    filter pattern. The right next move is usually `navigate(url)`.
 *  - `scroll`: getBoundingClientRect | scrollTop | offsetTop → layout
 *    reading, usually a botched attempt at virtualised-list scrolling.
 *  - `generic`: fall-through.
 */
export function classifyExpressionForTier2(
  expression: string | undefined,
): Tier2HintKind {
  if (!expression) return "generic";

  // Link-filter / text-extraction pattern → navigate hint.
  const hasQueryAll = /\b(querySelectorAll|getElementsByTagName|getElementsByClassName)\s*\(/.test(
    expression,
  );
  const hasContentExtract = /\b(href|textContent|innerText|innerHTML)\b/.test(
    expression,
  );
  if (hasQueryAll && hasContentExtract) return "navigate";

  // Layout / scroll reading → scroll hint.
  if (/\b(getBoundingClientRect|scrollTop|offsetTop|offsetHeight|scrollHeight)\b/.test(expression)) {
    return "scroll";
  }

  return "generic";
}

/** Internal reference to the RESET_TOOLS set, exported for tests. */
export function isResetTool(tool: string): boolean {
  return RESET_TOOLS.has(tool);
}

/** Module-level singleton analogous to `a11yTree`. */
export const toolSequence = new ToolSequenceTracker();
