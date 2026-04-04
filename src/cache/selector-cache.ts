import { createHash } from "node:crypto";
import { debug } from "../cdp/debug.js";

// --- Types ---

export interface SelectorCacheEntry {
  backendNodeId: number;
  fingerprint: string;      // SHA256(url + nodeCount + ref)
  sessionId: string;
  cachedAt: number;         // Date.now() for TTL
}

export interface SelectorCacheOptions {
  maxEntries?: number;       // Default: 200
  ttlMs?: number;            // Default: 300_000 (5 minutes)
}

// --- SelectorCache ---

export class SelectorCache {
  private _cache = new Map<string, SelectorCacheEntry>();
  private _currentFingerprint = "";
  private _maxEntries: number;
  private _ttlMs: number;

  constructor(options?: SelectorCacheOptions) {
    this._maxEntries = options?.maxEntries ?? 200;
    this._ttlMs = options?.ttlMs ?? 300_000;
  }

  /**
   * Compute a DOM fingerprint from URL and node count.
   * Lightweight — no DOMSnapshot, no A11y-Tree.
   */
  computeFingerprint(url: string, nodeCount: number): string {
    // Strip hash/fragment from URL for normalization
    const normalizedUrl = url.split("#")[0];
    return createHash("sha256")
      .update(normalizedUrl + "|" + nodeCount)
      .digest("hex")
      .substring(0, 16);
  }

  /** Set the current DOM fingerprint (called after each ref resolution or tree refresh) */
  updateFingerprint(fingerprint: string): void {
    if (fingerprint !== this._currentFingerprint) {
      this._currentFingerprint = fingerprint;
      debug("SelectorCache: fingerprint updated: %s", fingerprint);
    }
  }

  /**
   * Lookup: Check if a cached selector for this ref exists.
   * Returns entry if cache hit AND fingerprint matches.
   * Returns undefined on miss or fingerprint mismatch.
   */
  get(ref: string): SelectorCacheEntry | undefined {
    const entry = this._cache.get(ref);
    if (!entry) {
      return undefined;
    }
    // Fingerprint mismatch — DOM has changed
    if (entry.fingerprint !== this._currentFingerprint) {
      this._cache.delete(ref);
      debug("SelectorCache: fingerprint mismatch for %s, invalidating entry", ref);
      return undefined;
    }
    // TTL expired
    if (Date.now() - entry.cachedAt >= this._ttlMs) {
      this._cache.delete(ref);
      debug("SelectorCache: TTL expired for %s", ref);
      return undefined;
    }
    return entry;
  }

  /**
   * Store a resolved ref in the cache.
   * Called after successful ref resolution.
   * When url and nodeCount are provided, computes an on-the-fly fingerprint
   * if none is active yet (fixes cold-cache after navigation — H1).
   */
  set(ref: string, backendNodeId: number, sessionId: string, url?: string, nodeCount?: number): void {
    // Compute on-the-fly fingerprint if none active but URL is known (H1 fix)
    if (!this._currentFingerprint && url !== undefined && nodeCount !== undefined) {
      const fp = this.computeFingerprint(url, nodeCount);
      this.updateFingerprint(fp);
      debug("SelectorCache: on-the-fly fingerprint from set(): %s", fp);
    }
    // Still no fingerprint — can't cache
    if (!this._currentFingerprint) return;

    // Evict oldest entry if at capacity
    if (this._cache.size >= this._maxEntries && !this._cache.has(ref)) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this._cache) {
        if (entry.cachedAt < oldestTime) {
          oldestTime = entry.cachedAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) {
        this._cache.delete(oldestKey);
      }
    }

    this._cache.set(ref, {
      backendNodeId,
      fingerprint: this._currentFingerprint,
      sessionId,
      cachedAt: Date.now(),
    });
  }

  /** Invalidate the entire cache (e.g. on navigation, reconnect) */
  invalidate(): void {
    const count = this._cache.size;
    this._cache.clear();
    this._currentFingerprint = "";
    if (count > 0) {
      debug("SelectorCache: invalidated (%d entries cleared)", count);
    }
  }

  /** Remove only entries that don't match the current fingerprint */
  pruneStale(): void {
    for (const [key, entry] of this._cache) {
      if (entry.fingerprint !== this._currentFingerprint) {
        this._cache.delete(key);
      }
    }
  }

  /** Cache statistics for debugging */
  getStats(): { size: number; fingerprint: string } {
    return {
      size: this._cache.size,
      fingerprint: this._currentFingerprint,
    };
  }
}

// --- Singleton ---

export const selectorCache = new SelectorCache();
