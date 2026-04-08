import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVALUATE_STREAK_HINT_THRESHOLD,
  FLAG_QUERY_SELECTOR,
  ToolSequenceTracker,
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
      tracker.record("read_page");
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
      expect(hint).toContain("read_page");
      expect(hint).toMatch(/last resort/);
    });

    it("hint disappears after a reset tool is recorded", () => {
      const qs = new Set([FLAG_QUERY_SELECTOR]);
      for (let i = 0; i < EVALUATE_STREAK_HINT_THRESHOLD; i++) {
        tracker.record("evaluate", qs);
      }
      expect(tracker.maybeEvaluateStreakHint()).not.toBe("");

      tracker.record("read_page");
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
    expect(isResetTool("read_page")).toBe(true);
    expect(isResetTool("click")).toBe(true);
    expect(isResetTool("type")).toBe(true);
    expect(isResetTool("fill_form")).toBe(true);
    expect(isResetTool("press_key")).toBe(true);
  });
  it("does not include evaluate", () => {
    expect(isResetTool("evaluate")).toBe(false);
  });
  it("does not include navigation-only tools", () => {
    expect(isResetTool("navigate")).toBe(false);
    expect(isResetTool("switch_tab")).toBe(false);
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
    tracker.record("read_page", undefined, "session-b");

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
