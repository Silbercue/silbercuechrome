/**
 * Story 12a.6: Community Markov Table Loader.
 *
 * Loads and verifies the static community-markov.json shipped in the npm
 * package. The file contains hand-curated transition probabilities for
 * common page types — every installation benefits from community knowledge
 * without a separate download.
 *
 * Verification: SHA256 hash of the file content is compared against
 * COMMUNITY_MARKOV_HASH. On mismatch the file is ignored and a warning
 * is logged to stderr (security-relevant state).
 *
 * Error philosophy: NEVER throw — graceful degradation on any failure.
 * Missing file, parse errors, hash mismatches all return null.
 *
 * IMPORTANT: Update COMMUNITY_MARKOV_HASH after every change to
 * community-markov.json (run: shasum -a 256 src/cortex/community-markov.json).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { debug } from "../cdp/debug.js";
import { MarkovTable } from "./markov-table.js";
import type { MarkovTableJSON } from "./cortex-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the community Markov table JSON file (co-located in build/cortex/). */
export const COMMUNITY_PATH = join(__dirname, "community-markov.json");

/**
 * SHA256 hex digest of the expected community-markov.json content.
 * MUST be updated whenever the JSON file changes.
 */
export const COMMUNITY_MARKOV_HASH =
  "dc8e9f9e0e958fcfc0d522e5e5973878e4112a0556ef7531309353b80ab6e983";

/**
 * Load and verify the community Markov table.
 *
 * @returns MarkovTable populated from community data, or null on any error.
 */
export function loadCommunityMarkov(): MarkovTable | null {
  try {
    let content: string;
    try {
      content = readFileSync(COMMUNITY_PATH, "utf-8");
    } catch {
      // File not found (first start, development) — graceful degradation.
      debug("[community-loader] community-markov.json not found at %s", COMMUNITY_PATH);
      return null;
    }

    // SHA256 integrity check
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== COMMUNITY_MARKOV_HASH) {
      console.error(
        `[public-browser] community-markov.json integrity check failed: ` +
        `expected ${COMMUNITY_MARKOV_HASH}, got ${hash}`,
      );
      return null;
    }

    // Parse JSON — extended format { probability, sampleCount } per nextTool
    let raw: Record<string, Record<string, Record<string, unknown>>>;
    try {
      raw = JSON.parse(content) as Record<string, Record<string, Record<string, unknown>>>;
    } catch {
      debug("[community-loader] community-markov.json parse error");
      return null;
    }

    // Transform extended format to MarkovTableJSON (number only).
    // community-markov.json stores { probability: number, sampleCount: number }
    // per nextTool entry. MarkovTable.fromJSON() expects plain number weights.
    const data: MarkovTableJSON = {};
    for (const [pageType, toolBuckets] of Object.entries(raw)) {
      if (!toolBuckets || typeof toolBuckets !== "object") continue;
      data[pageType] = {};
      for (const [lastTool, nextTools] of Object.entries(toolBuckets)) {
        if (!nextTools || typeof nextTools !== "object") continue;
        const bucket: { [nextTool: string]: number } = {};
        for (const [nextTool, value] of Object.entries(nextTools)) {
          if (typeof value === "number") {
            // Legacy flat format (plain number) — use directly
            bucket[nextTool] = value;
          } else if (
            value !== null &&
            typeof value === "object" &&
            "probability" in value &&
            typeof (value as { probability: unknown }).probability === "number"
          ) {
            // Extended format { probability, sampleCount }
            bucket[nextTool] = (value as { probability: number }).probability;
          }
        }
        if (Object.keys(bucket).length > 0) {
          data[pageType][lastTool] = bucket;
        }
      }
    }

    // Convert to MarkovTable via existing fromJSON (validates pageTypes)
    const table = MarkovTable.fromJSON(data);
    debug("[community-loader] loaded %d transitions from community table", table.size);
    return table;
  } catch (err) {
    debug(
      "[community-loader] loadCommunityMarkov() threw: %s",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
