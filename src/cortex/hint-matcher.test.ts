/**
 * Story 12.3 (Task 7.1): HintMatcher tests.
 *
 * Covers:
 *  - match() on loaded patterns finds domain+path match (AC #1)
 *  - match() without patterns returns empty result (AC #2)
 *  - match() on wrong domain returns empty result (AC #2)
 *  - match() with path placeholders (:id, :uuid, :hash) matches correctly
 *  - Aggregation: multiple patterns for same domain yield correct hint (AC #3)
 *  - Hint contains toolSequence, successRate, installationCount (AC #3)
 *  - refresh() updates the internal index
 *  - refreshAsync() loads patterns from LocalStore
 *  - Invalid URL is handled gracefully (no throw)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HintMatcher, hintMatcher } from "./hint-matcher.js";
import type { CortexPattern } from "./cortex-types.js";

/**
 * Helper to create a minimal CortexPattern (Story 12a.2: pageType required, domain optional).
 *
 * Story 12a.2 Temporary Compat: pathPattern is no longer on CortexPattern but
 * hint-matcher still reads it via `(p as any).pathPattern` for compat until 12a.4.
 * The helper includes pathPattern as an extra field on the object.
 */
function makePattern(overrides: Partial<CortexPattern> & { domain?: string; pathPattern?: string } = {}): CortexPattern {
  const base = {
    pageType: "dashboard",
    domain: "example.com",
    pathPattern: "/dashboard",
    toolSequence: ["navigate", "view_page", "click"],
    outcome: "success" as const,
    contentHash: "a1b2c3d4e5f6a7b8",
    timestamp: Date.now(),
  };
  return { ...base, ...overrides } as CortexPattern;
}

describe("HintMatcher (Story 12.3)", () => {
  let matcher: HintMatcher;

  beforeEach(() => {
    matcher = new HintMatcher();
  });

  // =========================================================================
  // AC #1: match() finds domain+path match
  // =========================================================================

  it("match() finds a domain+path match on loaded patterns (AC #1)", () => {
    matcher.loadPatterns([makePattern({ domain: "dashboard.example.com", pathPattern: "/users/:id/profile" })]);

    const result = matcher.match("https://dashboard.example.com/users/42/profile");
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.hints).toHaveLength(1);
    expect(result.hints[0].domain).toBe("dashboard.example.com");
    expect(result.hints[0].toolSequence).toEqual(["navigate", "view_page", "click"]);
  });

  it("match() works with exact path (no placeholders)", () => {
    matcher.loadPatterns([makePattern({ domain: "example.com", pathPattern: "/dashboard" })]);

    const result = matcher.match("https://example.com/dashboard");
    expect(result.matchCount).toBe(1);
    expect(result.hints).toHaveLength(1);
  });

  it("match() works with root path", () => {
    matcher.loadPatterns([makePattern({ domain: "example.com", pathPattern: "/" })]);

    const result = matcher.match("https://example.com/");
    expect(result.matchCount).toBe(1);
  });

  // =========================================================================
  // AC #2: No match scenarios
  // =========================================================================

  it("match() without patterns returns empty result (AC #2)", () => {
    const result = matcher.match("https://example.com/dashboard");
    expect(result.matchCount).toBe(0);
    expect(result.hints).toHaveLength(0);
  });

  it("match() on wrong domain returns empty result (AC #2)", () => {
    matcher.loadPatterns([makePattern({ domain: "example.com" })]);

    const result = matcher.match("https://other.com/dashboard");
    expect(result.matchCount).toBe(0);
    expect(result.hints).toHaveLength(0);
  });

  it("match() on wrong path returns empty result", () => {
    matcher.loadPatterns([makePattern({ domain: "example.com", pathPattern: "/dashboard" })]);

    const result = matcher.match("https://example.com/settings");
    expect(result.matchCount).toBe(0);
    expect(result.hints).toHaveLength(0);
  });

  it("match() with empty string returns empty result", () => {
    const result = matcher.match("");
    expect(result.matchCount).toBe(0);
  });

  it("match() with about:blank returns empty result", () => {
    const result = matcher.match("about:blank");
    expect(result.matchCount).toBe(0);
  });

  it("match() with chrome:// URL returns empty result", () => {
    const result = matcher.match("chrome://settings");
    expect(result.matchCount).toBe(0);
  });

  // =========================================================================
  // Path placeholder matching
  // =========================================================================

  it("match() with :id placeholder matches numeric segments", () => {
    matcher.loadPatterns([makePattern({ pathPattern: "/users/:id/profile" })]);

    expect(matcher.match("https://example.com/users/42/profile").matchCount).toBe(1);
    expect(matcher.match("https://example.com/users/999999/profile").matchCount).toBe(1);
    // Non-numeric should NOT match :id
    expect(matcher.match("https://example.com/users/abc/profile").matchCount).toBe(0);
  });

  it("match() with :uuid placeholder matches UUID segments", () => {
    matcher.loadPatterns([makePattern({ pathPattern: "/items/:uuid/details" })]);

    expect(matcher.match("https://example.com/items/550e8400-e29b-41d4-a716-446655440000/details").matchCount).toBe(1);
    // Non-UUID should NOT match :uuid
    expect(matcher.match("https://example.com/items/12345/details").matchCount).toBe(0);
  });

  it("match() with :hash placeholder matches hex hash segments", () => {
    matcher.loadPatterns([makePattern({ pathPattern: "/assets/:hash/image.png" })]);

    expect(matcher.match("https://example.com/assets/a1b2c3d4e5f6a7b8/image.png").matchCount).toBe(1);
    expect(matcher.match("https://example.com/assets/abcdef12/image.png").matchCount).toBe(1);
    // Too short for :hash (needs 8+)
    expect(matcher.match("https://example.com/assets/abc/image.png").matchCount).toBe(0);
  });

  // =========================================================================
  // AC #3: Aggregation and hint fields
  // =========================================================================

  it("aggregation: multiple patterns yield correct hint (AC #3)", () => {
    matcher.loadPatterns([
      makePattern({ domain: "example.com", pathPattern: "/dashboard", toolSequence: ["navigate", "view_page", "click"] }),
      makePattern({ domain: "example.com", pathPattern: "/dashboard", toolSequence: ["navigate", "view_page", "click"], timestamp: Date.now() + 1 }),
      makePattern({ domain: "example.com", pathPattern: "/dashboard", toolSequence: ["navigate", "view_page"], timestamp: Date.now() + 2 }),
    ]);

    const result = matcher.match("https://example.com/dashboard");
    expect(result.matchCount).toBe(3);
    expect(result.hints).toHaveLength(1);

    const hint = result.hints[0];
    // Most frequent toolSequence wins
    expect(hint.toolSequence).toEqual(["navigate", "view_page", "click"]);
    // C4: installationCount = distinct domain+pathPattern combos (all 3 share the same, so 1)
    expect(hint.installationCount).toBe(1);
  });

  it("hint contains toolSequence, successRate, installationCount (AC #3)", () => {
    matcher.loadPatterns([makePattern()]);

    const result = matcher.match("https://example.com/dashboard");
    const hint = result.hints[0];

    expect(hint.toolSequence).toEqual(["navigate", "view_page", "click"]);
    expect(hint.successRate).toBe(1.0);
    expect(hint.installationCount).toBe(1);
    expect(hint.pathPattern).toBe("/dashboard");
    expect(hint.domain).toBe("example.com");
  });

  // =========================================================================
  // refresh() and refreshAsync() — C2/C3: call actual methods, not proxies
  // =========================================================================

  it("refresh() calls _refreshFromRecorder and updates index from patternRecorder", async () => {
    // Mock the dynamic import chain that refresh() uses internally.
    const testPattern = makePattern({ domain: "refreshed.com", pathPattern: "/live" });
    vi.doMock("./pattern-recorder.js", () => ({
      patternRecorder: { emittedPatterns: [testPattern] },
    }));

    // Create a fresh matcher so the mock is picked up
    const { HintMatcher: FreshMatcher } = await import("./hint-matcher.js");
    const freshMatcher = new FreshMatcher();

    // Call actual refresh() — fires async, wait a tick for it to settle
    freshMatcher.refresh();
    await new Promise((r) => setTimeout(r, 50));

    const result = freshMatcher.match("https://refreshed.com/live");
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.hints[0].domain).toBe("refreshed.com");

    vi.doUnmock("./pattern-recorder.js");
  });

  it("refreshAsync() loads and merges patterns from LocalStore + patternRecorder", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "hint-matcher-test-"));

    try {
      const persistedPattern = makePattern({ domain: "persisted.com", pathPattern: "/saved", timestamp: 1000 });
      const inMemoryPattern = makePattern({ domain: "inmemory.com", pathPattern: "/live", timestamp: 2000 });
      await mkdir(tmpDir, { recursive: true });
      await writeFile(join(tmpDir, "patterns.jsonl"), JSON.stringify(persistedPattern) + "\n", "utf-8");

      // Mock both imports that refreshAsync() uses
      vi.doMock("./pattern-recorder.js", () => ({
        patternRecorder: { emittedPatterns: [inMemoryPattern] },
      }));
      vi.doMock("./local-store.js", () => ({
        LocalStore: class {
          async getAll() { return [persistedPattern]; }
        },
      }));

      const { HintMatcher: FreshMatcher } = await import("./hint-matcher.js");
      const freshMatcher = new FreshMatcher();

      // Call actual refreshAsync()
      await freshMatcher.refreshAsync();

      // Both persisted and in-memory patterns should be loaded
      expect(freshMatcher.match("https://persisted.com/saved").matchCount).toBeGreaterThan(0);
      expect(freshMatcher.match("https://inmemory.com/live").matchCount).toBeGreaterThan(0);

      vi.doUnmock("./pattern-recorder.js");
      vi.doUnmock("./local-store.js");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // M2: Merge edge-cases
  // =========================================================================

  it("merge: persisted + in-memory patterns for same domain are correctly merged", () => {
    // Simulate what refreshAsync produces: patterns from both sources
    const persisted = makePattern({ domain: "shop.com", pathPattern: "/cart", toolSequence: ["navigate", "click"], timestamp: 1000 });
    const inMemory = makePattern({ domain: "shop.com", pathPattern: "/checkout", toolSequence: ["navigate", "fill_form"], timestamp: 2000 });

    matcher.loadPatterns([persisted, inMemory]);

    // Both paths should match on the same domain
    expect(matcher.match("https://shop.com/cart").matchCount).toBeGreaterThan(0);
    expect(matcher.match("https://shop.com/checkout").matchCount).toBeGreaterThan(0);
  });

  it("merge: different tool sequences for same domain+path are aggregated, not overwritten (H2)", () => {
    // Two patterns with same domain+path but different tool sequences
    const seqA = makePattern({ domain: "app.com", pathPattern: "/dashboard", toolSequence: ["navigate", "view_page", "click"], timestamp: 1000 });
    const seqB = makePattern({ domain: "app.com", pathPattern: "/dashboard", toolSequence: ["navigate", "fill_form", "click"], timestamp: 2000 });

    matcher.loadPatterns([seqA, seqB]);

    const result = matcher.match("https://app.com/dashboard");
    // Both patterns match — matchCount should reflect both
    expect(result.matchCount).toBe(2);
    // C4: installationCount = distinct domain+pathPattern (both share same, so 1)
    expect(result.hints[0].installationCount).toBe(1);
    // Hint should contain a toolSequence (the aggregated best one)
    expect(result.hints[0].toolSequence.length).toBeGreaterThan(0);
  });

  it("installationCount counts distinct domain+pathPattern, not raw matches (C4)", () => {
    // Two different pathPatterns on same domain
    const patA = makePattern({ domain: "shop.com", pathPattern: "/products/:id", toolSequence: ["navigate", "view_page"] });
    const patB = makePattern({ domain: "shop.com", pathPattern: "/products/:id", toolSequence: ["navigate", "click"] });
    const patC = makePattern({ domain: "shop.com", pathPattern: "/products/:id", toolSequence: ["navigate", "view_page"] });

    matcher.loadPatterns([patA, patB, patC]);

    const result = matcher.match("https://shop.com/products/42");
    // 3 raw matches but only 1 distinct domain+pathPattern
    expect(result.matchCount).toBe(3);
    expect(result.hints[0].installationCount).toBe(1);
  });

  // =========================================================================
  // Invalid URL handling (graceful)
  // =========================================================================

  it("invalid URL is handled gracefully (no throw)", () => {
    matcher.loadPatterns([makePattern()]);

    // These should all return empty results, not throw
    expect(matcher.match("not-a-url").matchCount).toBe(0);
    expect(matcher.match("://broken").matchCount).toBe(0);
    expect(matcher.match("ftp://example.com/file").matchCount).toBe(0);
  });

  // =========================================================================
  // _pathPatternToRegex (static helper)
  // =========================================================================

  describe("_pathPatternToRegex", () => {
    it("compiles exact path", () => {
      const re = HintMatcher._pathPatternToRegex("/dashboard");
      expect(re.test("/dashboard")).toBe(true);
      expect(re.test("/other")).toBe(false);
    });

    it("compiles root path", () => {
      const re = HintMatcher._pathPatternToRegex("/");
      expect(re.test("/")).toBe(true);
      expect(re.test("/anything")).toBe(false);
    });

    it("compiles :id placeholder", () => {
      const re = HintMatcher._pathPatternToRegex("/users/:id/profile");
      expect(re.test("/users/42/profile")).toBe(true);
      expect(re.test("/users/abc/profile")).toBe(false);
    });

    it("compiles :uuid placeholder", () => {
      const re = HintMatcher._pathPatternToRegex("/items/:uuid");
      expect(re.test("/items/550e8400-e29b-41d4-a716-446655440000")).toBe(true);
      expect(re.test("/items/12345")).toBe(false);
    });

    it("compiles :hash placeholder", () => {
      const re = HintMatcher._pathPatternToRegex("/assets/:hash/img.png");
      expect(re.test("/assets/a1b2c3d4e5f6a7b8/img.png")).toBe(true);
      expect(re.test("/assets/abc/img.png")).toBe(false);
    });

    it("handles empty/null path", () => {
      const re = HintMatcher._pathPatternToRegex("");
      expect(re.test("/")).toBe(true);
    });
  });

  // =========================================================================
  // Domain case insensitivity
  // =========================================================================

  it("domain matching is case-insensitive", () => {
    matcher.loadPatterns([makePattern({ domain: "Example.COM" })]);
    expect(matcher.match("https://example.com/dashboard").matchCount).toBe(1);
    expect(matcher.match("https://EXAMPLE.COM/dashboard").matchCount).toBe(1);
  });

  // =========================================================================
  // Story 12.4: patternCount getter
  // =========================================================================

  it("patternCount returns 0 on empty index (Story 12.4)", () => {
    expect(matcher.patternCount).toBe(0);
  });

  it("patternCount returns correct count after loadPatterns (Story 12.4)", () => {
    matcher.loadPatterns([
      makePattern({ domain: "a.com", pathPattern: "/one" }),
      makePattern({ domain: "a.com", pathPattern: "/two" }),
      makePattern({ domain: "b.com", pathPattern: "/three" }),
    ]);
    expect(matcher.patternCount).toBe(3);
  });

  it("patternCount updates after refresh via loadPatterns (Story 12.4)", () => {
    matcher.loadPatterns([makePattern()]);
    expect(matcher.patternCount).toBe(1);

    // Reload with more patterns
    matcher.loadPatterns([
      makePattern({ pathPattern: "/a" }),
      makePattern({ pathPattern: "/b" }),
      makePattern({ pathPattern: "/c" }),
      makePattern({ pathPattern: "/d" }),
    ]);
    expect(matcher.patternCount).toBe(4);

    // Reload with empty → back to 0
    matcher.loadPatterns([]);
    expect(matcher.patternCount).toBe(0);
  });

  // =========================================================================
  // Story 12.4 C2: patternCount after refresh()
  // =========================================================================

  it("patternCount returns correct value after refresh() loads from patternRecorder (Story 12.4 C2)", async () => {
    const patterns = [
      makePattern({ domain: "c2.com", pathPattern: "/alpha" }),
      makePattern({ domain: "c2.com", pathPattern: "/beta" }),
      makePattern({ domain: "c2.com", pathPattern: "/gamma" }),
    ];

    // Mock the dynamic import that refresh() uses internally
    vi.doMock("./pattern-recorder.js", () => ({
      patternRecorder: { emittedPatterns: patterns },
    }));

    // Fresh import so the mock is picked up by the dynamic import() chain
    const { HintMatcher: FreshMatcher } = await import("./hint-matcher.js");
    const freshMatcher = new FreshMatcher();

    // Before refresh: empty
    expect(freshMatcher.patternCount).toBe(0);

    // Call refresh() (fire-and-forget internally), wait for the async settle
    freshMatcher.refresh();
    await new Promise((r) => setTimeout(r, 50));

    // After refresh: patternCount reflects the loaded patterns
    expect(freshMatcher.patternCount).toBe(3);

    vi.doUnmock("./pattern-recorder.js");
  });

  // =========================================================================
  // Singleton export
  // =========================================================================

  it("hintMatcher singleton is exported", () => {
    expect(hintMatcher).toBeInstanceOf(HintMatcher);
  });
});
