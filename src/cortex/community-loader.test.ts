/**
 * Story 12a.6 (Task 6): Tests for community-loader.ts.
 *
 * Covers:
 *  - AC #1: Community table loaded and merged with local data
 *  - AC #2: SHA256 hash match → table loaded; mismatch → null + stderr warning
 *  - AC #4: No domain/URL/PII in loaded table
 *  - AC #5: Missing file → null (graceful degradation)
 *  - AC #5: Corrupt JSON → null (graceful degradation)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MarkovTable } from "./markov-table.js";

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * We test loadCommunityMarkov by importing the module fresh.
 * Since the module uses fs.readFileSync at call time (not import time),
 * we can mock fs to control test scenarios.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read the real community-markov.json content (unmocked fs, test-file __dirname). */
const REAL_COMMUNITY_CONTENT = readFileSync(
  join(__dirname, "community-markov.json"),
  "utf-8",
);

// Real community-markov.json content for hash-match tests
import { COMMUNITY_MARKOV_HASH, COMMUNITY_PATH } from "./community-loader.js";

describe("community-loader — constants", () => {
  it("COMMUNITY_PATH ends with community-markov.json", () => {
    expect(COMMUNITY_PATH).toMatch(/community-markov\.json$/);
  });

  it("COMMUNITY_MARKOV_HASH is a 64-char hex string", () => {
    expect(COMMUNITY_MARKOV_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("community-loader — loadCommunityMarkov", () => {
  // We need to mock fs.readFileSync. The community-loader uses
  // named import from "node:fs", so we mock the module.
  let mockReadFileSync: ReturnType<typeof vi.fn>;
  let loadCommunityMarkov: () => MarkovTable | null;

  const VALID_JSON = JSON.stringify({
    login: {
      navigate: {
        view_page: { probability: 0.95, sampleCount: 0 },
        wait_for: { probability: 0.05, sampleCount: 0 },
      },
      view_page: {
        fill_form: { probability: 0.80, sampleCount: 0 },
        click: { probability: 0.15, sampleCount: 0 },
        type: { probability: 0.05, sampleCount: 0 },
      },
    },
    search_results: {
      navigate: {
        view_page: { probability: 0.90, sampleCount: 0 },
        wait_for: { probability: 0.10, sampleCount: 0 },
      },
      view_page: {
        click: { probability: 0.60, sampleCount: 0 },
        scroll: { probability: 0.25, sampleCount: 0 },
        type: { probability: 0.15, sampleCount: 0 },
      },
    },
  });

  const VALID_HASH = createHash("sha256").update(VALID_JSON).digest("hex");

  beforeEach(async () => {
    // Reset module mocks
    vi.resetModules();

    // Default mock: return valid JSON
    mockReadFileSync = vi.fn().mockReturnValue(VALID_JSON);

    // Mock node:fs
    vi.doMock("node:fs", () => ({
      readFileSync: mockReadFileSync,
    }));

    // Re-import to pick up mocks. Also override the hash constant.
    const mod = await import("./community-loader.js");
    loadCommunityMarkov = mod.loadCommunityMarkov;

    // We need to override the hash to match our test JSON.
    // Since the hash is a module-level const, we use vi.spyOn workaround:
    // Instead, we'll construct the test JSON to match the REAL hash,
    // OR we mock at a different level. Let's use a pragmatic approach:
    // just test with the real file when hash-match is needed.
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("AC #2 (hash match): returns a MarkovTable when hash matches", async () => {
    // Mock fs to return the real file content (avoids __dirname issues in test env)
    mockReadFileSync.mockReturnValue(REAL_COMMUNITY_CONTENT);

    vi.resetModules();
    vi.doMock("node:fs", () => ({ readFileSync: mockReadFileSync }));

    const { loadCommunityMarkov: realLoad } = await import("./community-loader.js");
    const result = realLoad();

    // Hard assertion: the real file MUST load successfully
    expect(result).not.toBeNull();
    // Duck-type check (instanceof fails across vi.resetModules boundaries)
    expect(result).toHaveProperty("size");
    expect(result).toHaveProperty("predict");
    expect(result!.size).toBeGreaterThan(0);
  });

  it("AC #2 (hash mismatch): returns null and logs to stderr", async () => {
    const tampered = JSON.stringify({ login: { navigate: { click: 1.0 } } });
    mockReadFileSync.mockReturnValue(tampered);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Need to re-import with the mock in place
    vi.resetModules();
    vi.doMock("node:fs", () => ({ readFileSync: mockReadFileSync }));
    const mod = await import("./community-loader.js");

    const result = mod.loadCommunityMarkov();

    expect(result).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("integrity check failed"),
    );

    consoleErrorSpy.mockRestore();
  });

  it("AC #5 (missing file): returns null, no throw", async () => {
    mockReadFileSync.mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    vi.resetModules();
    vi.doMock("node:fs", () => ({ readFileSync: mockReadFileSync }));
    const mod = await import("./community-loader.js");

    const result = mod.loadCommunityMarkov();
    expect(result).toBeNull();
  });

  it("AC #5 (corrupt JSON): returns null, no throw — hits JSON.parse path", async () => {
    // To test the JSON.parse error path we need content that:
    // 1. Passes the SHA256 hash check (hash matches COMMUNITY_MARKOV_HASH)
    // 2. Fails JSON.parse()
    // We mock node:crypto so createHash always returns the expected hash,
    // bypassing the integrity gate. Then corrupt content hits JSON.parse.
    const corruptContent = "{{not valid json at all";

    mockReadFileSync.mockReturnValue(corruptContent);

    vi.resetModules();
    vi.doMock("node:fs", () => ({ readFileSync: mockReadFileSync }));

    // Mock node:crypto to bypass hash check — digest always returns the expected hash.
    // Use COMMUNITY_MARKOV_HASH captured at import time (same value the reimported
    // module will have, since the source file hasn't changed).
    vi.doMock("node:crypto", () => ({
      createHash: () => ({
        update: () => ({
          digest: () => COMMUNITY_MARKOV_HASH,
        }),
      }),
    }));

    const mod = await import("./community-loader.js");
    const result = mod.loadCommunityMarkov();

    // Must return null via JSON.parse error path, not throw
    expect(result).toBeNull();
  });

  it("AC #4: loaded table contains no domain/URL/PII fields", async () => {
    // Mock fs to return the real file content
    mockReadFileSync.mockReturnValue(REAL_COMMUNITY_CONTENT);

    vi.resetModules();
    vi.doMock("node:fs", () => ({ readFileSync: mockReadFileSync }));

    const { loadCommunityMarkov: realLoad } = await import("./community-loader.js");
    const result = realLoad();

    // Hard assertion: the table must load
    expect(result).not.toBeNull();

    // Verify no PII fields in the actual JSON content
    const data = JSON.parse(REAL_COMMUNITY_CONTENT);

    // Verify structure: only pageType -> lastTool -> nextTool -> { probability, sampleCount }
    for (const [pageType, toolBuckets] of Object.entries(data)) {
      expect(typeof pageType).toBe("string");
      // pageType should not look like a URL or domain
      expect(pageType).not.toMatch(/^https?:\/\//);
      expect(pageType).not.toMatch(/\./); // no dots (domains)
      expect(pageType).not.toMatch(/@/); // no email-like patterns

      for (const [lastTool, nextTools] of Object.entries(toolBuckets as Record<string, unknown>)) {
        expect(typeof lastTool).toBe("string");
        for (const [nextTool, value] of Object.entries(nextTools as Record<string, unknown>)) {
          expect(typeof nextTool).toBe("string");
          // Extended format: { probability, sampleCount }
          expect(value).toHaveProperty("probability");
          expect(value).toHaveProperty("sampleCount");
          const entry = value as { probability: number; sampleCount: number };
          expect(typeof entry.probability).toBe("number");
          expect(entry.probability).toBeGreaterThan(0);
          expect(entry.probability).toBeLessThanOrEqual(1);
          expect(typeof entry.sampleCount).toBe("number");
        }
      }
    }
  });

  it("AC #4: community-markov.json is under 50KB", () => {
    const sizeKB = Buffer.byteLength(REAL_COMMUNITY_CONTENT, "utf-8") / 1024;
    expect(sizeKB).toBeLessThan(50);
  });

  it("AC #1: community table can be merged with local MarkovTable", () => {
    // Create a local table with some data
    const local = new MarkovTable();
    local.ingest([{
      pageType: "login",
      toolSequence: ["navigate", "view_page", "fill_form"],
      outcome: "success" as const,
      contentHash: "0123456789abcdef",
      timestamp: Date.now(),
    }]);

    const sizeBefore = local.size;

    // Create community table from JSON (simulating loadCommunityMarkov)
    const communityJSON = {
      login: {
        navigate: { view_page: 0.95, wait_for: 0.05 },
        view_page: { fill_form: 0.80, click: 0.15 },
      },
      search_results: {
        navigate: { view_page: 0.90 },
      },
    };
    const community = MarkovTable.fromJSON(communityJSON);

    local.merge(community);

    // After merge, local table should have more entries
    expect(local.size).toBeGreaterThan(sizeBefore);
    // search_results was only in community — now in local
    expect(local.pageTypes).toContain("search_results");
    // login was in both — still present
    expect(local.pageTypes).toContain("login");
  });

  it("AC #1: local data takes precedence via max-weight merge", () => {
    // Local table with high-count data
    const local = new MarkovTable();
    for (let i = 0; i < 10; i++) {
      local.ingest([{
        pageType: "login",
        toolSequence: ["navigate", "view_page"],
        outcome: "success" as const,
        contentHash: "0123456789abcdef",
        timestamp: Date.now(),
      }]);
    }

    // Community table with low weights (normalised 0-1)
    const community = MarkovTable.fromJSON({
      login: {
        navigate: { view_page: 0.95, wait_for: 0.05 },
      },
    });

    local.merge(community);

    const predictions = local.predict("login", "navigate");
    const viewPage = predictions.find((p) => p.tool === "view_page");
    // Local weight (10) should dominate over community weight (0.95)
    expect(viewPage!.weight).toBe(10);
  });
});
