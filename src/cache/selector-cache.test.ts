import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SelectorCache } from "./selector-cache.js";

// --- Mock debug ---

vi.mock("../cdp/debug.js", () => ({
  debug: vi.fn(),
}));

describe("SelectorCache", () => {
  let cache: SelectorCache;

  beforeEach(() => {
    cache = new SelectorCache({ maxEntries: 5, ttlMs: 1000 });
  });

  // --- computeFingerprint ---

  it("computeFingerprint() produces deterministic hash", () => {
    const fp1 = cache.computeFingerprint("https://example.com", 42);
    const fp2 = cache.computeFingerprint("https://example.com", 42);
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(16);
  });

  it("computeFingerprint() changes with URL change", () => {
    const fp1 = cache.computeFingerprint("https://example.com", 42);
    const fp2 = cache.computeFingerprint("https://other.com", 42);
    expect(fp1).not.toBe(fp2);
  });

  it("computeFingerprint() changes with node count change", () => {
    const fp1 = cache.computeFingerprint("https://example.com", 42);
    const fp2 = cache.computeFingerprint("https://example.com", 43);
    expect(fp1).not.toBe(fp2);
  });

  it("computeFingerprint() normalizes URL by stripping hash fragment", () => {
    const fp1 = cache.computeFingerprint("https://example.com/page#section1", 10);
    const fp2 = cache.computeFingerprint("https://example.com/page#section2", 10);
    expect(fp1).toBe(fp2);
  });

  // --- updateFingerprint ---

  it("updateFingerprint() sets new fingerprint", () => {
    cache.updateFingerprint("abc123");
    expect(cache.getStats().fingerprint).toBe("abc123");
  });

  // --- set + get (Cache Hit) ---

  it("set() + get() stores and returns entry (Cache Hit)", () => {
    const fp = cache.computeFingerprint("https://example.com", 10);
    cache.updateFingerprint(fp);

    cache.set("e5", 101, "session-1");
    const entry = cache.get("e5");

    expect(entry).toBeDefined();
    expect(entry!.backendNodeId).toBe(101);
    expect(entry!.sessionId).toBe("session-1");
    expect(entry!.fingerprint).toBe(fp);
  });

  // --- Cache Miss ---

  it("get() returns undefined for unknown ref (Cache Miss)", () => {
    const fp = cache.computeFingerprint("https://example.com", 10);
    cache.updateFingerprint(fp);

    expect(cache.get("e999")).toBeUndefined();
  });

  // --- Fingerprint Mismatch (Self-Healing) ---

  it("get() returns undefined on fingerprint mismatch (Self-Healing)", () => {
    const fp1 = cache.computeFingerprint("https://example.com", 10);
    cache.updateFingerprint(fp1);
    cache.set("e5", 101, "session-1");

    // DOM changed — new fingerprint
    const fp2 = cache.computeFingerprint("https://example.com", 11);
    cache.updateFingerprint(fp2);

    expect(cache.get("e5")).toBeUndefined();
  });

  it("get() deletes entry on fingerprint mismatch", () => {
    const fp1 = cache.computeFingerprint("https://example.com", 10);
    cache.updateFingerprint(fp1);
    cache.set("e5", 101, "session-1");

    const fp2 = cache.computeFingerprint("https://example.com", 11);
    cache.updateFingerprint(fp2);
    cache.get("e5"); // triggers delete

    // Reset fingerprint back — entry should be gone
    cache.updateFingerprint(fp1);
    expect(cache.get("e5")).toBeUndefined();
  });

  // --- TTL Expired ---

  it("get() returns undefined on expired TTL", () => {
    const fp = cache.computeFingerprint("https://example.com", 10);
    cache.updateFingerprint(fp);

    // Mock Date.now to control TTL
    const originalNow = Date.now;
    const startTime = 1000000;
    vi.spyOn(Date, "now").mockReturnValue(startTime);

    cache.set("e5", 101, "session-1");

    // Advance time past TTL (1000ms)
    vi.spyOn(Date, "now").mockReturnValue(startTime + 1001);

    expect(cache.get("e5")).toBeUndefined();

    Date.now = originalNow;
    vi.restoreAllMocks();
  });

  // --- Eviction ---

  it("set() evicts oldest entry when maxEntries reached", () => {
    const fp = cache.computeFingerprint("https://example.com", 10);
    cache.updateFingerprint(fp);

    const originalNow = Date.now;
    let currentTime = 1000000;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    // Fill cache to maxEntries (5)
    for (let i = 1; i <= 5; i++) {
      currentTime = 1000000 + i;
      cache.set(`e${i}`, i * 100, "session-1");
    }
    expect(cache.getStats().size).toBe(5);

    // Add one more — oldest (e1) should be evicted
    currentTime = 1000000 + 10;
    cache.set("e6", 600, "session-1");

    expect(cache.getStats().size).toBe(5);
    expect(cache.get("e1")).toBeUndefined(); // evicted
    expect(cache.get("e6")).toBeDefined();   // new entry

    Date.now = originalNow;
    vi.restoreAllMocks();
  });

  // --- invalidate ---

  it("invalidate() clears the entire cache", () => {
    const fp = cache.computeFingerprint("https://example.com", 10);
    cache.updateFingerprint(fp);
    cache.set("e1", 101, "session-1");
    cache.set("e2", 102, "session-1");

    cache.invalidate();

    expect(cache.getStats().size).toBe(0);
    expect(cache.getStats().fingerprint).toBe("");
  });

  // --- pruneStale ---

  it("pruneStale() removes only entries with old fingerprint", () => {
    const fp1 = cache.computeFingerprint("https://example.com", 10);
    cache.updateFingerprint(fp1);
    cache.set("e1", 101, "session-1");
    cache.set("e2", 102, "session-1");

    // Change fingerprint and add a new entry
    const fp2 = cache.computeFingerprint("https://example.com", 11);
    cache.updateFingerprint(fp2);
    cache.set("e3", 103, "session-1");

    cache.pruneStale();

    // e1, e2 should be pruned (old fingerprint), e3 should remain
    expect(cache.getStats().size).toBe(1);
    expect(cache.get("e3")).toBeDefined();
  });

  // --- getStats ---

  it("getStats() returns size and fingerprint", () => {
    const fp = cache.computeFingerprint("https://example.com", 10);
    cache.updateFingerprint(fp);
    cache.set("e1", 101, "session-1");

    const stats = cache.getStats();
    expect(stats.size).toBe(1);
    expect(stats.fingerprint).toBe(fp);
  });

  // --- set without fingerprint ---

  it("set() does nothing when no fingerprint is set and no URL provided", () => {
    cache.set("e1", 101, "session-1");
    expect(cache.getStats().size).toBe(0);
  });

  // --- H1 fix: on-the-fly fingerprint ---

  it("set() computes on-the-fly fingerprint when URL and nodeCount provided (H1 fix)", () => {
    // No fingerprint active
    expect(cache.getStats().fingerprint).toBe("");

    cache.set("e1", 101, "session-1", "https://example.com", 42);

    // Should have computed fingerprint and cached the entry
    expect(cache.getStats().fingerprint).not.toBe("");
    expect(cache.getStats().size).toBe(1);
    const entry = cache.get("e1");
    expect(entry).toBeDefined();
    expect(entry!.backendNodeId).toBe(101);
  });

  it("set() with URL does not overwrite existing fingerprint", () => {
    const existingFp = cache.computeFingerprint("https://other.com", 10);
    cache.updateFingerprint(existingFp);

    cache.set("e1", 101, "session-1", "https://example.com", 42);

    // Fingerprint should remain unchanged (not overwritten by on-the-fly)
    expect(cache.getStats().fingerprint).toBe(existingFp);
    expect(cache.getStats().size).toBe(1);
  });

  // --- set updates existing entry ---

  it("set() updates existing entry without triggering eviction", () => {
    const fp = cache.computeFingerprint("https://example.com", 10);
    cache.updateFingerprint(fp);

    // Fill to capacity
    for (let i = 1; i <= 5; i++) {
      cache.set(`e${i}`, i * 100, "session-1");
    }

    // Update existing entry (should not evict)
    cache.set("e3", 999, "session-1");
    expect(cache.getStats().size).toBe(5);
    expect(cache.get("e3")!.backendNodeId).toBe(999);
  });
});
