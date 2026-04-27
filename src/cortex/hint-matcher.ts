/**
 * Story 12.3: Hint Matcher — Cortex Phase 1 Hint Delivery.
 *
 * Matches the current page URL against recorded patterns and returns
 * actionable hints (recommended tool sequences) for the LLM agent.
 *
 * Data flow:
 *   emittedPatterns (in-memory) + LocalStore (persisted)
 *     → HintMatcher (URL-pattern index)
 *       → navigate.ts / read-page.ts (_meta.cortex in ToolResponse)
 *
 * Design:
 *  - Synchronous `match()` for hot-path use in tool handlers.
 *  - Domain → Pattern[] index for O(1) domain lookup.
 *  - Path patterns compiled to RegExp once at load time.
 *  - Module-level singleton (`hintMatcher`), same pattern as patternRecorder.
 *
 * Error philosophy: NEVER throw — graceful degradation on any failure.
 */
import { debug } from "../cdp/debug.js";
import type { CortexPattern, CortexHint, HintMatchResult } from "./cortex-types.js";

/** UUID pattern: 8-4-4-4-12 hex chars. */
const UUID_SEGMENT = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** Pure numeric segment (at least 1 digit). */
const NUMERIC_SEGMENT = "\\d+";

/** Hex hash segment (at least 8 hex chars). */
const HEX_HASH_SEGMENT = "[0-9a-fA-F]{8,}";

/** Compiled pattern entry stored in the domain index. */
interface CompiledPattern {
  regex: RegExp;
  pattern: CortexPattern;
}

/** Empty result constant — reused to avoid allocations on miss. */
const EMPTY_RESULT: HintMatchResult = { hints: [], matchCount: 0 };

export class HintMatcher {
  /** Domain → compiled patterns index. */
  private _index = new Map<string, CompiledPattern[]>();

  /**
   * Total number of loaded patterns across all domain buckets.
   * Returns 0 when no patterns are loaded.
   */
  get patternCount(): number {
    let count = 0;
    for (const bucket of this._index.values()) {
      count += bucket.length;
    }
    return count;
  }

  /**
   * Load patterns into the internal index.
   * Compiles path patterns to RegExp for fast matching.
   */
  loadPatterns(patterns: CortexPattern[]): void {
    this._index.clear();
    for (const p of patterns) {
      try {
        const domain = p.domain.toLowerCase();
        const regex = HintMatcher._pathPatternToRegex(p.pathPattern);
        let bucket = this._index.get(domain);
        if (!bucket) {
          bucket = [];
          this._index.set(domain, bucket);
        }
        bucket.push({ regex, pattern: p });
      } catch (err) {
        debug(
          "[hint-matcher] Failed to compile pattern %s%s: %s",
          p.domain,
          p.pathPattern,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /**
   * Match a URL against loaded patterns.
   *
   * @returns HintMatchResult with matching hints, or empty result if no match.
   */
  match(url: string): HintMatchResult {
    try {
      if (!url) return EMPTY_RESULT;

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return EMPTY_RESULT;
      }

      // Only match http/https URLs
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return EMPTY_RESULT;
      }

      const domain = parsed.hostname.toLowerCase();
      const bucket = this._index.get(domain);
      if (!bucket || bucket.length === 0) return EMPTY_RESULT;

      const path = parsed.pathname;
      const matching = bucket.filter((entry) => entry.regex.test(path));
      if (matching.length === 0) return EMPTY_RESULT;

      // Aggregate matching patterns into a single CortexHint
      const hint = HintMatcher._aggregate(matching, domain);
      return { hints: [hint], matchCount: matching.length };
    } catch (err) {
      debug(
        "[hint-matcher] match() threw: %s",
        err instanceof Error ? err.message : String(err),
      );
      return EMPTY_RESULT;
    }
  }

  /**
   * Synchronous refresh: fire-and-forget async reload from PatternRecorder.
   * Called after each new pattern emission. Uses dynamic import() to break
   * the circular dependency (ESM — require() is not available).
   */
  refresh(): void {
    // Fire-and-forget: delegate to refreshFromRecorder which uses await import().
    this._refreshFromRecorder().catch((err: unknown) => {
      debug(
        "[hint-matcher] refresh() failed: %s",
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  /**
   * Internal async helper for refresh() — loads patterns from PatternRecorder
   * via dynamic import() (ESM-safe, no require()).
   */
  private async _refreshFromRecorder(): Promise<void> {
    const { patternRecorder } = await import("./pattern-recorder.js");
    this.loadPatterns(patternRecorder.emittedPatterns);
  }

  /**
   * Async refresh: load patterns from both PatternRecorder (in-memory)
   * and LocalStore (persisted). Called once at server start.
   */
  async refreshAsync(): Promise<void> {
    try {
      const [{ patternRecorder }, { LocalStore: LS }] = await Promise.all([
        import("./pattern-recorder.js"),
        import("./local-store.js"),
      ]);

      // Merge patterns: LocalStore (persisted) + emittedPatterns (in-memory).
      // Aggregate by domain+pathPattern: keep ALL patterns (different tool
      // sequences for the same URL pattern are valuable — _aggregate() picks
      // the most frequent one). Deduplicate only exact matches
      // (domain+pathPattern+toolSequence), keeping the more recent timestamp.
      const store = new LS();
      const persisted = await store.getAll();
      const inMemory = patternRecorder.emittedPatterns;

      const seen = new Map<string, CortexPattern>();
      for (const p of [...persisted, ...inMemory]) {
        const seqKey = p.toolSequence.join(",");
        const key = `${p.domain}||${p.pathPattern}||${seqKey}`;
        const existing = seen.get(key);
        if (!existing || p.timestamp > existing.timestamp) {
          seen.set(key, p);
        }
      }

      this.loadPatterns([...seen.values()]);
      debug("[hint-matcher] refreshAsync loaded %d patterns", seen.size);
    } catch (err) {
      debug(
        "[hint-matcher] refreshAsync() failed: %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Convert a path pattern (with :id, :uuid, :hash placeholders) to a RegExp.
   * The resulting regex matches the full pathname.
   */
  static _pathPatternToRegex(pathPattern: string): RegExp {
    if (!pathPattern || pathPattern === "/") return /^\/$/;

    // Escape regex-special characters, then replace placeholders
    const escaped = pathPattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/:uuid/g, UUID_SEGMENT)
      .replace(/:id/g, NUMERIC_SEGMENT)
      .replace(/:hash/g, HEX_HASH_SEGMENT);

    return new RegExp(`^${escaped}$`);
  }

  /**
   * Aggregate multiple matching patterns into a single CortexHint.
   *
   * - toolSequence: from the most frequent pattern (by occurrence count)
   * - successRate: fraction of successful patterns (Phase 1: always 1.0)
   * - installationCount: number of distinct matching patterns
   */
  private static _aggregate(matches: CompiledPattern[], domain: string): CortexHint {
    // Find the most common tool sequence
    const seqCounts = new Map<string, { count: number; seq: string[]; pathPattern: string }>();
    for (const m of matches) {
      const key = m.pattern.toolSequence.join(",");
      const existing = seqCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        seqCounts.set(key, {
          count: 1,
          seq: m.pattern.toolSequence,
          pathPattern: m.pattern.pathPattern,
        });
      }
    }

    // Pick the sequence with the highest count
    let best = { count: 0, seq: [] as string[], pathPattern: "/" };
    for (const entry of seqCounts.values()) {
      if (entry.count > best.count) {
        best = entry;
      }
    }

    // C4 fix: installationCount = number of DISTINCT patterns (domain+pathPattern),
    // not the raw matches array length which can contain duplicates.
    const distinctPatterns = new Set(
      matches.map((m) => `${m.pattern.domain}||${m.pattern.pathPattern}`),
    ).size;

    return {
      toolSequence: best.seq,
      successRate: 1.0, // Phase 1: only successful patterns are recorded
      installationCount: distinctPatterns,
      pathPattern: best.pathPattern,
      domain,
    };
  }
}

/**
 * Module-level singleton (same pattern as `patternRecorder` and `toolSequence`).
 *
 * Starts with an empty index — `refreshAsync()` is called at server start
 * to load persisted patterns, and `refresh()` is called after each new
 * pattern emission to keep the index current.
 */
export const hintMatcher = new HintMatcher();
