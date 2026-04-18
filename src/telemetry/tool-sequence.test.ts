import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVALUATE_STREAK_HINT_THRESHOLD,
  EVALUATE_ANY_STREAK_THRESHOLD,
  EVALUATE_STREAK_TIER2_THRESHOLD,
  EVALUATE_STREAK_TIER3_THRESHOLD,
  EVALUATE_STREAK_TIER4_THRESHOLD,
  FLAG_QUERY_SELECTOR,
  ToolSequenceTracker,
  classifyExpressionForTier2,
  hasQuerySelectorPattern,
  isResetTool,
  toolSequence,
} from "./tool-sequence.js";

describe("ToolSequenceTracker", () => {
  let tracker: ToolSequenceTracker;

  beforeEach(() => {
    tracker = new ToolSequenceTracker();
  });

  describe("consecutiveEvaluateWithQuerySelector", () => {
    it("returns 0 on empty tracker", () => {
      expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(0);
    });

    it("counts consecutive evaluate+qs calls", () => {
      const qs = new Set([FLAG_QUERY_SELECTOR]);
      tracker.record("evaluate", qs);
      tracker.record("evaluate", qs);
      tracker.record("evaluate", qs);
      expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(3);
    });

    it("stops counting at a non-evaluate call", () => {
      const qs = new Set([FLAG_QUERY_SELECTOR]);
      tracker.record("evaluate", qs);
      tracker.record("evaluate", qs);
      tracker.record("view_page");
      tracker.record("evaluate", qs);
      // Only the most recent evaluate counts — the read_page broke the streak.
      expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(1);
    });

    it("stops counting at an evaluate WITHOUT querySelector flag", () => {
      const qs = new Set([FLAG_QUERY_SELECTOR]);
      tracker.record("evaluate", qs);
      tracker.record("evaluate"); // legitimate computed-value call
      tracker.record("evaluate", qs);
      // Only the most recent is counted — the unflagged evaluate broke the streak.
      expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(1);
    });

    it("click/type/fill_form/press_key all reset the streak", () => {
      const qs = new Set([FLAG_QUERY_SELECTOR]);
      tracker.record("evaluate", qs);
      tracker.record("evaluate", qs);
      tracker.record("click");
      expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(0);

      tracker.record("evaluate", qs);
      tracker.record("evaluate", qs);
      tracker.record("type");
      expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(0);

      tracker.record("evaluate", qs);
      tracker.record("evaluate", qs);
      tracker.record("fill_form");
      expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(0);

      // BUG-018 follow-up (final review MEDIUM #5): press_key is now
      // wired through the handler and must break a streak just like
      // the other happy-path tools.
      tracker.record("evaluate", qs);
      tracker.record("evaluate", qs);
      tracker.record("press_key");
      expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(0);
    });

    it("ignores events older than the streak window", () => {
      vi.useFakeTimers();
      const qs = new Set([FLAG_QUERY_SELECTOR]);
      tracker.record("evaluate", qs);
      tracker.record("evaluate", qs);
      // Advance time past the streak window (60 s)
      vi.advanceTimersByTime(90 * 1000);
      tracker.record("evaluate", qs);
      // Only the fresh event counts
      expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(1);
      vi.useRealTimers();
    });
  });

  describe("maybeEvaluateStreakHint", () => {
    it("returns empty string below threshold", () => {
      const qs = new Set([FLAG_QUERY_SELECTOR]);
      tracker.record("evaluate", qs);
      tracker.record("evaluate", qs);
      expect(tracker.maybeEvaluateStreakHint()).toBe("");
    });

    it("returns a warning hint at or above threshold", () => {
      const qs = new Set([FLAG_QUERY_SELECTOR]);
      for (let i = 0; i < EVALUATE_STREAK_HINT_THRESHOLD; i++) {
        tracker.record("evaluate", qs);
      }
      const hint = tracker.maybeEvaluateStreakHint();
      expect(hint).toContain("Warning:");
      expect(hint).toContain("consecutive querySelector-based evaluate");
      expect(hint).toContain("view_page");
      expect(hint).toMatch(/last resort/);
    });

    it("hint disappears after a reset tool is recorded", () => {
      const qs = new Set([FLAG_QUERY_SELECTOR]);
      for (let i = 0; i < EVALUATE_STREAK_HINT_THRESHOLD; i++) {
        tracker.record("evaluate", qs);
      }
      expect(tracker.maybeEvaluateStreakHint()).not.toBe("");

      tracker.record("view_page");
      expect(tracker.maybeEvaluateStreakHint()).toBe("");

      // A new streak must still be counted correctly after a reset.
      tracker.record("evaluate", qs);
      tracker.record("evaluate", qs);
      expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(2);
    });
  });

  describe("ring-buffer trimming", () => {
    it("never keeps more than MAX_EVENTS events in memory", () => {
      for (let i = 0; i < 200; i++) {
        tracker.record("evaluate");
      }
      // Implementation trims at MAX_EVENTS = 64
      expect(tracker.size).toBeLessThanOrEqual(64);
    });
  });

  describe("reset()", () => {
    it("clears all events", () => {
      tracker.record("evaluate");
      tracker.record("click");
      expect(tracker.size).toBe(2);
      tracker.reset();
      expect(tracker.size).toBe(0);
      expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(0);
    });
  });
});

describe("hasQuerySelectorPattern", () => {
  it("detects querySelector", () => {
    expect(hasQuerySelectorPattern("document.querySelector('#foo')")).toBe(true);
  });
  it("detects querySelectorAll", () => {
    expect(hasQuerySelectorPattern("document.querySelectorAll('.bar')")).toBe(true);
  });
  it("detects getElementById", () => {
    expect(hasQuerySelectorPattern("document.getElementById('baz')")).toBe(true);
  });
  it("detects getElementsByClassName", () => {
    expect(hasQuerySelectorPattern("document.getElementsByClassName('x')")).toBe(true);
  });
  it("does not match string literals without a paren — but matches literal calls (false-positive)", () => {
    // The pattern requires `(` after the name, so a bare reference in a
    // string literal does NOT match.
    expect(hasQuerySelectorPattern("const doc = 'use querySelector later';")).toBe(false);
    // Known limitation: a string literal that contains a literal call is
    // indistinguishable from real code without an AST — we accept the
    // false-positive as the cost of keeping the detector simple.
    expect(hasQuerySelectorPattern("const s = 'document.querySelector(\"#x\")';")).toBe(true);
  });
  it("does not trigger on unrelated code", () => {
    expect(hasQuerySelectorPattern("Math.max(1, 2, 3)")).toBe(false);
    expect(hasQuerySelectorPattern("window.scrollY")).toBe(false);
  });
});

describe("isResetTool", () => {
  it("includes the expected happy-path tools", () => {
    expect(isResetTool("view_page")).toBe(true);
    expect(isResetTool("click")).toBe(true);
    expect(isResetTool("type")).toBe(true);
    expect(isResetTool("fill_form")).toBe(true);
    expect(isResetTool("press_key")).toBe(true);
  });
  it("does not include evaluate", () => {
    expect(isResetTool("evaluate")).toBe(false);
  });
  it("does not include passive observation tools", () => {
    expect(isResetTool("switch_tab")).toBe(false);
  });
  // FR-045: scroll and navigate are explicit "dedicated action" signals
  // that a Tier 1-3 spiral is self-correcting; treat them as resets so
  // the streak can re-arm cleanly rather than keep escalating.
  it("includes scroll and navigate (FR-045)", () => {
    expect(isResetTool("scroll")).toBe(true);
    expect(isResetTool("navigate")).toBe(true);
  });
});

describe("toolSequence singleton", () => {
  afterEach(() => {
    toolSequence.reset();
  });

  it("is a single shared instance across imports", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    toolSequence.record("evaluate", qs);
    toolSequence.record("evaluate", qs);
    toolSequence.record("evaluate", qs);
    expect(toolSequence.maybeEvaluateStreakHint()).toContain("Warning:");
  });
});

describe("ToolSequenceTracker session scoping (BUG-018)", () => {
  let tracker: ToolSequenceTracker;

  beforeEach(() => {
    tracker = new ToolSequenceTracker();
  });

  it("tracks streaks per sessionId independently", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    // Session A has 3 querySelector evaluates — should trigger the hint.
    tracker.record("evaluate", qs, "session-a");
    tracker.record("evaluate", qs, "session-a");
    tracker.record("evaluate", qs, "session-a");
    // Session B is completely clean.
    tracker.record("view_page", undefined, "session-b");

    expect(tracker.consecutiveEvaluateWithQuerySelector("session-a")).toBe(3);
    expect(tracker.consecutiveEvaluateWithQuerySelector("session-b")).toBe(0);
    expect(tracker.maybeEvaluateStreakHint("session-a")).toContain("Warning:");
    expect(tracker.maybeEvaluateStreakHint("session-b")).toBe("");
  });

  it("a reset tool in session A does not clear session B's streak", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    tracker.record("evaluate", qs, "session-b");
    tracker.record("evaluate", qs, "session-b");
    tracker.record("evaluate", qs, "session-b");
    // Parallel tab does a happy-path tool call in a different session.
    tracker.record("click", undefined, "session-a");
    // Session B's streak must remain intact.
    expect(tracker.consecutiveEvaluateWithQuerySelector("session-b")).toBe(3);
  });

  it("reset(sessionId) clears only that session", () => {
    tracker.record("evaluate", undefined, "s1");
    tracker.record("evaluate", undefined, "s2");
    tracker.reset("s1");
    expect(tracker.consecutiveEvaluateWithQuerySelector("s1")).toBe(0);
    // s2 still has its event (but not a qs-flagged one, so streak=0 anyway
    // — the assertion is on total size below).
    expect(tracker.size).toBe(1);
  });

  it("reset() with no argument clears all sessions", () => {
    tracker.record("evaluate", undefined, "s1");
    tracker.record("evaluate", undefined, "s2");
    tracker.reset();
    expect(tracker.size).toBe(0);
  });

  it("undefined sessionId maps to the default session consistently", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    tracker.record("evaluate", qs);
    tracker.record("evaluate", qs);
    tracker.record("evaluate", qs);
    // The same default session must be readable without a sessionId arg.
    expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(3);
  });
});

// --- Story 23.1: Two-tier streak detection ---
describe("ToolSequenceTracker ANY-evaluate streak (Story 23.1)", () => {
  let tracker: ToolSequenceTracker;

  beforeEach(() => {
    tracker = new ToolSequenceTracker();
  });

  it("consecutiveEvaluateCalls counts ALL evaluate calls regardless of flags", () => {
    tracker.record("evaluate"); // no qs flag
    tracker.record("evaluate"); // no qs flag
    tracker.record("evaluate"); // no qs flag
    expect(tracker.consecutiveEvaluateCalls()).toBe(3);
    expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(0); // no qs flag
  });

  it("any non-evaluate call resets the ANY streak", () => {
    tracker.record("evaluate");
    tracker.record("evaluate");
    tracker.record("evaluate");
    tracker.record("scroll"); // any non-evaluate call breaks evaluate streak

    tracker.record("evaluate");
    expect(tracker.consecutiveEvaluateCalls()).toBe(1);
  });

  it("maybeEvaluateStreakHint returns Tier 2 hint at ANY threshold (FR-045)", () => {
    for (let i = 0; i < EVALUATE_ANY_STREAK_THRESHOLD; i++) {
      tracker.record("evaluate"); // no qs flag, no expression
    }
    const hint = tracker.maybeEvaluateStreakHint();
    // FR-045: Tier 2 text now uses "Notice:" prefix instead of "Warning:"
    // so the visual distinction between Tier 1 and Tier 2+ is clear.
    expect(hint).toContain("Notice:");
    expect(hint).toContain(`${EVALUATE_ANY_STREAK_THRESHOLD} consecutive evaluate`);
    // Generic Tier 2 text lists the main alternative tools.
    expect(hint).toContain("navigate(url)");
    expect(hint).toContain("scroll");
    expect(hint).toContain("handle_dialog");
    expect(hint).toContain("network_monitor");
  });

  it("does NOT fire generic hint below threshold", () => {
    for (let i = 0; i < EVALUATE_ANY_STREAK_THRESHOLD - 1; i++) {
      tracker.record("evaluate");
    }
    expect(tracker.maybeEvaluateStreakHint()).toBe("");
  });

  it("FR-045: at streak 5 Tier 2 supersedes Tier 1 even when qs flag set", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    // 5 consecutive evaluate+qs calls crosses the Tier-2 threshold.
    // FR-045 design: Tier 2 escalates over the Tier-1 text regardless
    // of flag — the anti-fatigue goal is that the user sees a DIFFERENT
    // text once the streak gets louder.
    for (let i = 0; i < EVALUATE_STREAK_TIER2_THRESHOLD; i++) {
      tracker.record("evaluate", qs);
    }
    const hint = tracker.maybeEvaluateStreakHint();
    expect(hint).toContain("Notice:"); // Tier 2 marker
    expect(hint).not.toContain("Warning:"); // no Tier 1 marker
  });

  it("Tier 1 fires at qs streak 3 (below Tier 2 threshold)", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < EVALUATE_STREAK_HINT_THRESHOLD; i++) {
      tracker.record("evaluate", qs);
    }
    const hint = tracker.maybeEvaluateStreakHint();
    // qs-streak = 3 → Tier 1 path fires, sachliches Warning + view_page.
    expect(hint).toContain("Warning:");
    expect(hint).toContain("querySelector-based evaluate");
  });

  it("generic hint fires when qs streak < 3 but total streak >= 5", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    // 2 qs calls (below qs threshold) + 3 plain calls = 5 total
    tracker.record("evaluate", qs);
    tracker.record("evaluate", qs);
    tracker.record("evaluate");
    tracker.record("evaluate");
    tracker.record("evaluate");
    const hint = tracker.maybeEvaluateStreakHint();
    // Tier 2 is active (streak=5), text is the generic tool catalogue.
    expect(hint).toContain("Notice:");
    expect(hint).toContain("handle_dialog"); // generic Tier-2 marker
    expect(hint).not.toContain("querySelector-based"); // not the Tier-1 qs hint
  });

  it("session scoping works for ANY streak", () => {
    for (let i = 0; i < EVALUATE_ANY_STREAK_THRESHOLD; i++) {
      tracker.record("evaluate", undefined, "session-a");
    }
    expect(tracker.consecutiveEvaluateCalls("session-a")).toBe(EVALUATE_ANY_STREAK_THRESHOLD);
    expect(tracker.consecutiveEvaluateCalls("session-b")).toBe(0);
  });
});

// --- FR-045: 3-Tier escalation of the evaluate-streak hint ---
describe("classifyExpressionForTier2 (FR-045)", () => {
  it("returns 'generic' for undefined or empty input", () => {
    expect(classifyExpressionForTier2(undefined)).toBe("generic");
    expect(classifyExpressionForTier2("")).toBe("generic");
  });

  it("returns 'navigate' for querySelectorAll + href/textContent pattern", () => {
    expect(
      classifyExpressionForTier2(
        `Array.from(document.querySelectorAll('a')).map(a => a.href)`,
      ),
    ).toBe("navigate");
    expect(
      classifyExpressionForTier2(
        `Array.from(document.querySelectorAll('li')).map(l => l.textContent)`,
      ),
    ).toBe("navigate");
  });

  it("returns 'scroll' for getBoundingClientRect / scrollTop / offsetTop", () => {
    expect(classifyExpressionForTier2("el.getBoundingClientRect().top")).toBe("scroll");
    expect(classifyExpressionForTier2("container.scrollTop")).toBe("scroll");
    expect(classifyExpressionForTier2("el.offsetTop")).toBe("scroll");
  });

  it("returns 'generic' for a plain querySelector.click call", () => {
    // Single-element querySelector + click — no content extraction,
    // no layout reading, no match for navigate/scroll. Falls through.
    expect(classifyExpressionForTier2("document.querySelector('#x').click()")).toBe(
      "generic",
    );
  });
});

describe("ToolSequenceTracker FR-045 3-Tier escalation", () => {
  let tracker: ToolSequenceTracker;

  beforeEach(() => {
    tracker = new ToolSequenceTracker();
  });

  // --- Tier boundary tests (streak → tier) ---

  it("Tier 0 when streak < qs-threshold and < any-threshold", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    tracker.record("evaluate", qs); // streak 1
    tracker.record("evaluate", qs); // streak 2
    const response = tracker.evaluateStreakResponse();
    expect(response.tier).toBe(0);
    expect(response.text).toBe("");
  });

  it("Tier 1 at qs streak 3 (sachlicher Stale-Ref hint)", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 3; i++) tracker.record("evaluate", qs);
    const response = tracker.evaluateStreakResponse();
    expect(response.tier).toBe(1);
    expect(response.streak).toBe(3);
    expect(response.text).toContain("Warning:");
    expect(response.text).toContain("querySelector-based evaluate");
    expect(response.text).toContain("view_page");
  });

  it("Tier 1 still applies at qs streak 4 (below Tier-2 threshold)", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 4; i++) tracker.record("evaluate", qs);
    const response = tracker.evaluateStreakResponse();
    expect(response.tier).toBe(1);
    expect(response.streak).toBe(4);
  });

  it("Tier 2 at streak 5 with context-sensitive navigate hint", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 5; i++) {
      tracker.record(
        "evaluate",
        qs,
        undefined,
        `Array.from(document.querySelectorAll('a')).map(a => a.href)`,
      );
    }
    const response = tracker.evaluateStreakResponse();
    expect(response.tier).toBe(2);
    expect(response.streak).toBe(5);
    expect(response.text).toContain("Notice:");
    // navigate-hint text signature
    expect(response.text).toContain("navigate(url)");
    expect(response.text).toContain("filtering DOM for content");
  });

  it("Tier 2 with scroll-context emits scroll-specific hint", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 6; i++) {
      tracker.record(
        "evaluate",
        qs,
        undefined,
        `document.querySelector('#list').scrollTop`,
      );
    }
    const response = tracker.evaluateStreakResponse();
    expect(response.tier).toBe(2);
    expect(response.text).toContain("scroll(container_ref");
    expect(response.text).toContain("layout/scroll state");
  });

  it("Tier 2 with generic expression emits generic tool catalogue", () => {
    for (let i = 0; i < 7; i++) {
      tracker.record("evaluate", undefined, undefined, "1 + 1");
    }
    const response = tracker.evaluateStreakResponse();
    expect(response.tier).toBe(2);
    expect(response.text).toContain("handle_dialog");
    expect(response.text).toContain("network_monitor");
    expect(response.text).toContain("wait_for");
  });

  it("Tier 3 at streak 8 carries STOP + <result> placeholder + navigate hint", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 8; i++) {
      tracker.record(
        "evaluate",
        qs,
        undefined,
        `document.querySelectorAll('a.order').length`,
      );
    }
    const response = tracker.evaluateStreakResponse();
    expect(response.tier).toBe(3);
    expect(response.streak).toBe(8);
    // MCP-spec: isError text must be actionable self-correction feedback.
    expect(response.text).toContain("STOP");
    expect(response.text).toContain("<result>"); // handler substitutes
    expect(response.text).toContain("Required next action");
    expect(response.text).toContain("navigate(url)");
  });

  it("Tier 3 stays in force through streak 11 (one below Tier-4)", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 11; i++) tracker.record("evaluate", qs);
    const response = tracker.evaluateStreakResponse();
    expect(response.tier).toBe(3);
    expect(response.streak).toBe(11);
  });

  it("Tier 4 at streak 12 hard-refuses (no <result> placeholder)", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 12; i++) tracker.record("evaluate", qs);
    const response = tracker.evaluateStreakResponse();
    expect(response.tier).toBe(4);
    expect(response.streak).toBe(12);
    expect(response.text).toContain("REFUSED");
    expect(response.text).not.toContain("<result>");
  });

  // --- Reset-tool coverage (FR-045 extends RESET_TOOLS) ---

  it("scroll resets the streak (FR-045)", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 5; i++) tracker.record("evaluate", qs);
    expect(tracker.evaluateStreakResponse().tier).toBeGreaterThanOrEqual(2);

    tracker.record("scroll");
    expect(tracker.consecutiveEvaluateWithQuerySelector()).toBe(0);
    expect(tracker.consecutiveEvaluateCalls()).toBe(0);
    expect(tracker.evaluateStreakResponse().tier).toBe(0);
  });

  it("navigate resets the streak (FR-045)", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 8; i++) tracker.record("evaluate", qs);
    expect(tracker.evaluateStreakResponse().tier).toBe(3);

    tracker.record("navigate");
    expect(tracker.evaluateStreakResponse().tier).toBe(0);
  });

  it("passing expressionOverride beats the recorded expression", () => {
    // Record 5 plain evaluates with a boring expression — generic hint.
    for (let i = 0; i < 5; i++) {
      tracker.record("evaluate", undefined, undefined, "1 + 1");
    }
    // Override with a querySelectorAll+href expression at call time.
    const response = tracker.evaluateStreakResponse(
      undefined,
      "Array.from(document.querySelectorAll('a')).map(a => a.href)",
    );
    expect(response.tier).toBe(2);
    expect(response.text).toContain("filtering DOM for content");
  });

  // --- Anti-fatigue: adjacent tiers must produce DIFFERENT text ---

  it("Tier 1 and Tier 2 messages are not identical (anti-fatigue)", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 3; i++) tracker.record("evaluate", qs);
    const tier1 = tracker.evaluateStreakResponse().text;

    // Add two more to cross Tier-2 threshold.
    tracker.record("evaluate", qs);
    tracker.record("evaluate", qs);
    const tier2 = tracker.evaluateStreakResponse().text;

    expect(tier1).not.toBe(tier2);
    expect(tier1).toContain("Warning:");
    expect(tier2).toContain("Notice:");
  });

  it("Tier 2 and Tier 3 messages are not identical (anti-fatigue)", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 5; i++) tracker.record("evaluate", qs);
    const tier2 = tracker.evaluateStreakResponse().text;

    for (let i = 0; i < 3; i++) tracker.record("evaluate", qs);
    const tier3 = tracker.evaluateStreakResponse().text;

    expect(tier2).not.toBe(tier3);
    expect(tier2).not.toContain("STOP");
    expect(tier3).toContain("STOP");
  });

  // --- maybeEvaluateStreakHint compatibility ---

  it("maybeEvaluateStreakHint returns empty string for Tier 3/4 (uses richer API)", () => {
    const qs = new Set([FLAG_QUERY_SELECTOR]);
    for (let i = 0; i < 8; i++) tracker.record("evaluate", qs);
    // The legacy append API returns "" when the tier is too high
    // for a plain append — callers must use evaluateStreakResponse().
    expect(tracker.maybeEvaluateStreakHint()).toBe("");
    expect(tracker.evaluateStreakResponse().tier).toBe(3);
  });
});
