#!/usr/bin/env tsx
/**
 * Story 12a.6: Telemetry Aggregation Script.
 *
 * Batch job for the maintainer — reads telemetry NDJSON files (one
 * TelemetryPayload per line), aggregates to MarkovTableJSON format,
 * writes src/cortex/community-markov.json, and prints the SHA256 hash.
 *
 * Usage:
 *   npx tsx scripts/aggregate-telemetry.ts <input-file.ndjson>
 *
 * The input file uses the TelemetryPayload format from telemetry-upload.ts:
 *   { pageType, toolSequence, successRate, contentHash, timestamp }
 *
 * Privacy (NFR21): Output contains ONLY pageType/lastTool/nextTool/weight.
 * No domain, no URLs, no PII.
 *
 * After running, update COMMUNITY_MARKOV_HASH in community-loader.ts
 * with the printed hash.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TelemetryEntry {
  pageType: string;
  toolSequence: string[];
  successRate?: number;
  contentHash?: string;
  timestamp?: number;
}

// Three-level accumulator: pageType -> lastTool -> nextTool -> count
type Accumulator = Map<string, Map<string, Map<string, number>>>;

interface TransitionEntry {
  probability: number;
  sampleCount: number;
}

function aggregate(entries: TelemetryEntry[]): Record<string, Record<string, Record<string, TransitionEntry>>> {
  const acc: Accumulator = new Map();

  for (const entry of entries) {
    if (!entry.pageType || !Array.isArray(entry.toolSequence)) continue;
    if (entry.toolSequence.length < 2) continue;

    const seq = entry.toolSequence;
    for (let i = 0; i < seq.length - 1; i++) {
      const lastTool = seq[i];
      const nextTool = seq[i + 1];
      if (!lastTool || !nextTool) continue;

      let pageMap = acc.get(entry.pageType);
      if (!pageMap) {
        pageMap = new Map();
        acc.set(entry.pageType, pageMap);
      }

      let toolMap = pageMap.get(lastTool);
      if (!toolMap) {
        toolMap = new Map();
        pageMap.set(lastTool, toolMap);
      }

      toolMap.set(nextTool, (toolMap.get(nextTool) ?? 0) + 1);
    }
  }

  // Normalise weights to 0-1 per (pageType, lastTool) bucket, include sampleCount
  const result: Record<string, Record<string, Record<string, TransitionEntry>>> = {};

  for (const [pageType, pageMap] of acc) {
    result[pageType] = {};
    for (const [lastTool, toolMap] of pageMap) {
      let total = 0;
      for (const count of toolMap.values()) {
        total += count;
      }
      if (total === 0) continue;

      const bucket: Record<string, TransitionEntry> = {};
      for (const [nextTool, count] of toolMap) {
        bucket[nextTool] = {
          probability: Math.round((count / total) * 100) / 100,
          sampleCount: count,
        };
      }
      result[pageType][lastTool] = bucket;
    }
  }

  return result;
}

// ─── Main ───────────────────────────────────────────────────────────

const inputFile = process.argv[2];
if (!inputFile) {
  console.error("Usage: npx tsx scripts/aggregate-telemetry.ts <input-file.ndjson>");
  process.exit(1);
}

const inputPath = resolve(inputFile);
const raw = readFileSync(inputPath, "utf-8");
const lines = raw.split("\n").filter((line) => line.trim().length > 0);

const entries: TelemetryEntry[] = [];
for (let i = 0; i < lines.length; i++) {
  try {
    const parsed = JSON.parse(lines[i]) as TelemetryEntry;
    // Privacy filter: only extract whitelisted fields
    entries.push({
      pageType: parsed.pageType,
      toolSequence: parsed.toolSequence,
    });
  } catch {
    // NFR21: never log raw content (may contain URLs or PII)
    console.error(`Line ${i + 1}: invalid JSON (skipped)`);
  }
}

console.error(`Parsed ${entries.length} telemetry entries from ${inputPath}`);

const result = aggregate(entries);
const json = JSON.stringify(result, null, 2);

const outputPath = resolve(__dirname, "..", "src", "cortex", "community-markov.json");
writeFileSync(outputPath, json + "\n", "utf-8");

const hash = createHash("sha256").update(json + "\n").digest("hex");

console.error(`Wrote ${outputPath}`);
console.error(`Size: ${(Buffer.byteLength(json, "utf-8") / 1024).toFixed(2)} KB`);
console.log(hash);
console.error(`\nUpdate COMMUNITY_MARKOV_HASH in src/cortex/community-loader.ts with:`);
console.error(`  ${hash}`);
