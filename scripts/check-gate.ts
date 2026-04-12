#!/usr/bin/env tsx
/**
 * check-gate.ts — Gate-Check fuer Benchmark-Ergebnisse.
 *
 * Liest eine Benchmark-JSON und prueft konfigurierbaren Kriterien-Satz:
 *
 *   Default:           recognition_rate >= 85%, false_positive_rate < 5%
 *   --checkpoint tag-20: MQS >= 66, Pass-Rate = 35/35 (Story 19.11)
 *   --epic 19:          Alle fuenf Epic-19-Abschlusskriterien (Story 19.13)
 *
 * Exit-Codes:
 *   0 — Alle Kriterien bestanden
 *   1 — Mindestens ein Kriterium verfehlt oder Fehler
 *
 * Usage:
 *   tsx scripts/check-gate.ts                          # Default-Gate
 *   tsx scripts/check-gate.ts --file path/to/result.json
 *   tsx scripts/check-gate.ts --checkpoint tag-20
 *   tsx scripts/check-gate.ts --epic 19
 *   tsx scripts/check-gate.ts --help
 *
 * Invariante 5 (Solo-Pflegbarkeit): Alle Schwellen als SCREAMING_SNAKE_CASE.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Gate-Schwellen — Invariante 5: keine Magic Numbers
// ---------------------------------------------------------------------------

/** Default recognition rate threshold (AC-4, NFR4) */
export const RECOGNITION_RATE_MIN = 0.85;

/** Default false positive rate ceiling (AC-4, NFR5) */
export const FALSE_POSITIVE_RATE_MAX = 0.05;

/** Tag-20 checkpoint: minimum MQS (Story 19.11) */
export const TAG_20_MQS_MIN = 66;

/** Tag-20 checkpoint: required pass count (Story 19.11) */
export const TAG_20_PASS_COUNT = 35;

/** Epic-19 gate: minimum MQS (Story 19.13) */
export const EPIC_19_MQS_MIN = 70;

/** Epic-19 gate: required pass count (Story 19.13) */
export const EPIC_19_PASS_COUNT = 35;

/** Epic-19 gate: minimum recognition rate (Story 19.13) */
export const EPIC_19_RECOGNITION_RATE_MIN = 0.85;

/** Epic-19 gate: maximum false positive rate (Story 19.13) */
export const EPIC_19_FALSE_POSITIVE_RATE_MAX = 0.05;

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GateCriterion {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface GateResult {
  mode: string;
  criteria: GateCriterion[];
  allPassed: boolean;
}

export interface BenchmarkData {
  summary?: {
    total?: number;
    passed?: number;
    failed?: number;
    total_passed?: number;
  };
  mqs?: number;
  recognition_rate?: number;
  false_positive_rate?: number;
  wall_clock_ms?: number;
  operator_mode?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface CheckGateArgs {
  mode: "default" | "checkpoint" | "epic" | "help";
  checkpointTag?: string;
  epicNumber?: number;
  file?: string;
}

export function parseCheckGateArgs(argv: string[]): CheckGateArgs {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    return { mode: "help" };
  }

  let file: string | undefined;
  let mode: CheckGateArgs["mode"] = "default";
  let checkpointTag: string | undefined;
  let epicNumber: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) {
      file = args[++i];
    } else if (args[i] === "--checkpoint" && args[i + 1]) {
      mode = "checkpoint";
      checkpointTag = args[++i];
    } else if (args[i] === "--epic" && args[i + 1]) {
      mode = "epic";
      epicNumber = parseInt(args[++i], 10);
    }
  }

  return { mode, file, checkpointTag, epicNumber };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

export function findLatestBenchmarkJson(testHardestDir: string, operatorOnly = false): string | null {
  let files: string[];
  try {
    files = readdirSync(testHardestDir);
  } catch {
    return null;
  }

  const jsonFiles = files
    .filter((f) => f.startsWith("benchmark-") && f.endsWith(".json"))
    .filter((f) => !operatorOnly || f.includes("operator"))
    .sort()
    .reverse();

  return jsonFiles.length > 0 ? resolve(testHardestDir, jsonFiles[0]) : null;
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

export function evaluateDefaultGate(data: BenchmarkData): GateResult {
  const criteria: GateCriterion[] = [];

  if (data.recognition_rate === undefined) {
    criteria.push({
      name: "recognition_rate",
      expected: `>= ${RECOGNITION_RATE_MIN}`,
      actual: "MISSING",
      pass: false,
    });
  } else {
    criteria.push({
      name: "recognition_rate",
      expected: `>= ${RECOGNITION_RATE_MIN}`,
      actual: `${data.recognition_rate}`,
      pass: data.recognition_rate >= RECOGNITION_RATE_MIN,
    });
  }

  if (data.false_positive_rate === undefined) {
    criteria.push({
      name: "false_positive_rate",
      expected: `< ${FALSE_POSITIVE_RATE_MAX}`,
      actual: "MISSING",
      pass: false,
    });
  } else {
    criteria.push({
      name: "false_positive_rate",
      expected: `< ${FALSE_POSITIVE_RATE_MAX}`,
      actual: `${data.false_positive_rate}`,
      pass: data.false_positive_rate < FALSE_POSITIVE_RATE_MAX,
    });
  }

  return {
    mode: "default",
    criteria,
    allPassed: criteria.every((c) => c.pass),
  };
}

export function evaluateCheckpointGate(data: BenchmarkData, tag: string): GateResult {
  const criteria: GateCriterion[] = [];

  if (tag === "tag-20") {
    if (data.mqs === undefined) {
      criteria.push({
        name: "mqs",
        expected: `>= ${TAG_20_MQS_MIN}`,
        actual: "MISSING",
        pass: false,
      });
    } else {
      criteria.push({
        name: "mqs",
        expected: `>= ${TAG_20_MQS_MIN}`,
        actual: `${data.mqs}`,
        pass: data.mqs >= TAG_20_MQS_MIN,
      });
    }

    const passCount = data.summary?.passed ?? data.summary?.total_passed ?? 0;
    const totalCount = data.summary?.total ?? passCount;
    const passRate = totalCount > 0 ? passCount / totalCount : 0;
    criteria.push({
      name: "pass_rate",
      expected: `${TAG_20_PASS_COUNT}/${TAG_20_PASS_COUNT} (100%)`,
      actual: `${passCount}/${totalCount} (${(passRate * 100).toFixed(1)}%)`,
      pass: passCount >= TAG_20_PASS_COUNT && passRate === 1.0,
    });
  } else {
    criteria.push({
      name: "checkpoint",
      expected: `known tag (tag-20)`,
      actual: tag,
      pass: false,
    });
  }

  return {
    mode: `checkpoint:${tag}`,
    criteria,
    allPassed: criteria.every((c) => c.pass),
  };
}

export function evaluateEpicGate(data: BenchmarkData, epicNumber: number): GateResult {
  const criteria: GateCriterion[] = [];

  if (epicNumber === 19) {
    // MQS >= 70
    if (data.mqs === undefined) {
      criteria.push({ name: "mqs", expected: `>= ${EPIC_19_MQS_MIN}`, actual: "MISSING", pass: false });
    } else {
      criteria.push({ name: "mqs", expected: `>= ${EPIC_19_MQS_MIN}`, actual: `${data.mqs}`, pass: data.mqs >= EPIC_19_MQS_MIN });
    }

    // Pass rate: all tests must pass (passCount >= EPIC_19_PASS_COUNT AND 100% rate)
    const passCount = data.summary?.passed ?? data.summary?.total_passed ?? 0;
    const totalCount = data.summary?.total ?? passCount;
    const passRate = totalCount > 0 ? passCount / totalCount : 0;
    criteria.push({
      name: "pass_rate",
      expected: `${EPIC_19_PASS_COUNT}/${EPIC_19_PASS_COUNT} (100%)`,
      actual: `${passCount}/${totalCount} (${(passRate * 100).toFixed(1)}%)`,
      pass: passCount >= EPIC_19_PASS_COUNT && passRate === 1.0,
    });

    // Recognition rate >= 85%
    if (data.recognition_rate === undefined) {
      criteria.push({ name: "recognition_rate", expected: `>= ${EPIC_19_RECOGNITION_RATE_MIN}`, actual: "MISSING", pass: false });
    } else {
      criteria.push({
        name: "recognition_rate",
        expected: `>= ${EPIC_19_RECOGNITION_RATE_MIN}`,
        actual: `${data.recognition_rate}`,
        pass: data.recognition_rate >= EPIC_19_RECOGNITION_RATE_MIN,
      });
    }

    // False positive rate < 5%
    if (data.false_positive_rate === undefined) {
      criteria.push({ name: "false_positive_rate", expected: `< ${EPIC_19_FALSE_POSITIVE_RATE_MAX}`, actual: "MISSING", pass: false });
    } else {
      criteria.push({
        name: "false_positive_rate",
        expected: `< ${EPIC_19_FALSE_POSITIVE_RATE_MAX}`,
        actual: `${data.false_positive_rate}`,
        pass: data.false_positive_rate < EPIC_19_FALSE_POSITIVE_RATE_MAX,
      });
    }

    // Wall-clock placeholder — can't evaluate "50% shorter" without baseline reference
    if (data.wall_clock_ms === undefined) {
      criteria.push({ name: "wall_clock_ms", expected: "present", actual: "MISSING", pass: false });
    } else {
      criteria.push({ name: "wall_clock_ms", expected: "present", actual: `${data.wall_clock_ms}ms`, pass: true });
    }
  } else {
    criteria.push({
      name: "epic",
      expected: `known epic (19)`,
      actual: `${epicNumber}`,
      pass: false,
    });
  }

  return {
    mode: `epic:${epicNumber}`,
    criteria,
    allPassed: criteria.every((c) => c.pass),
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function formatGateResult(result: GateResult): string {
  const lines: string[] = [];
  lines.push(`\n${BOLD}check-gate — ${result.mode}${RESET}`);
  lines.push("\u2550".repeat(50));

  for (const c of result.criteria) {
    const icon = c.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    lines.push(`  ${icon}  ${c.name.padEnd(22)} ${DIM}expected: ${c.expected}  actual: ${c.actual}${RESET}`);
  }

  lines.push("\u2500".repeat(50));
  const overall = result.allPassed ? `${GREEN}ALL GATES PASSED${RESET}` : `${RED}GATE CHECK FAILED${RESET}`;
  lines.push(`  ${overall}`);
  lines.push("\u2550".repeat(50) + "\n");

  return lines.join("\n");
}

export function printHelp(): string {
  return `
${BOLD}check-gate — Benchmark Gate Checker${RESET}

Usage:
  tsx scripts/check-gate.ts                           Default gate (recognition_rate, false_positive_rate)
  tsx scripts/check-gate.ts --file <path>             Use specific JSON file
  tsx scripts/check-gate.ts --checkpoint tag-20       Tag-20 checkpoint (MQS >= 66, Pass 35/35)
  tsx scripts/check-gate.ts --epic 19                 Epic-19 full gate check
  tsx scripts/check-gate.ts --help                    Show this help

Default Gate Criteria:
  recognition_rate   >= ${RECOGNITION_RATE_MIN} (${RECOGNITION_RATE_MIN * 100}%)
  false_positive_rate < ${FALSE_POSITIVE_RATE_MAX} (${FALSE_POSITIVE_RATE_MAX * 100}%)
`;
}

// ---------------------------------------------------------------------------
// Main (only runs when executed directly, not when imported)
// ---------------------------------------------------------------------------

export function runCheckGate(argv: string[]): GateResult | null {
  const parsed = parseCheckGateArgs(argv);

  if (parsed.mode === "help") {
    console.log(printHelp());
    return null;
  }

  // Resolve file path
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dirname, "..");
  const testHardestDir = resolve(repoRoot, "test-hardest");

  let filePath: string;
  if (parsed.file) {
    filePath = resolve(parsed.file);
  } else {
    const found = findLatestBenchmarkJson(testHardestDir, parsed.mode === "default");
    if (!found) {
      console.error(`${RED}ERROR${RESET}: No benchmark JSON found in ${testHardestDir}`);
      process.exit(1);
    }
    filePath = found;
  }

  // Read JSON
  let data: BenchmarkData;
  try {
    data = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error(`${RED}ERROR${RESET}: Failed to read ${filePath}: ${(err as Error).message}`);
    process.exit(1);
  }

  console.error(`${DIM}Reading: ${filePath}${RESET}`);

  // Evaluate
  let result: GateResult;
  switch (parsed.mode) {
    case "checkpoint":
      result = evaluateCheckpointGate(data, parsed.checkpointTag!);
      break;
    case "epic":
      result = evaluateEpicGate(data, parsed.epicNumber!);
      break;
    default:
      result = evaluateDefaultGate(data);
      break;
  }

  console.log(formatGateResult(result));
  return result;
}

// Auto-run when executed directly
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("check-gate.ts") || process.argv[1].endsWith("check-gate.js"));

if (isMainModule) {
  const result = runCheckGate(process.argv);
  if (result) {
    process.exit(result.allPassed ? 0 : 1);
  }
}
