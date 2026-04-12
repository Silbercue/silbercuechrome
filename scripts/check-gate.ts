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

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
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

/** Tag-20 checkpoint: number of gate criteria checked (MQS + pass_rate) — Subtask 3.4 */
export const TAG_20_CRITERIA_COUNT = 2;

/** Epic-19 gate: minimum MQS (Story 19.13) */
export const EPIC_19_MQS_MIN = 70;

/** Epic-19 gate: required pass count (Story 19.13) */
export const EPIC_19_PASS_COUNT = 35;

/** Epic-19 gate: minimum recognition rate (Story 19.13) */
export const EPIC_19_RECOGNITION_RATE_MIN = 0.85;

/** Epic-19 gate: minimum wall-clock reduction vs baseline (Story 19.13, NFR3) */
export const EPIC_19_WALL_CLOCK_REDUCTION_MIN = 0.50;

/** Epic-19 gate: maximum tool-definition overhead in tokens (Story 19.13, NFR1) */
export const EPIC_19_TOOL_OVERHEAD_MAX = 3000;

/** Epic-19 gate: total number of criteria (for summary line) */
export const EPIC_19_CRITERIA_COUNT = 5;

/** Path to baseline JSON for wall-clock comparison */
export const BASELINE_JSON_PATH = "test-hardest/ops-run-plan-baseline-v0.5.0.json";

/** Marker for Epic-19 entries in docs (idempotency guard) */
const EPIC_19_MARKER = "Epic-19-Abschluss-Gate";

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
  wall_ms?: number;
  operator_mode?: boolean;
  tool_definition_tokens?: number;
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

    const rawPassCount = data.summary?.passed ?? data.summary?.total_passed;
    const hasSummary = rawPassCount !== undefined;
    const passCount = rawPassCount ?? 0;
    const totalCount = data.summary?.total ?? passCount;
    const passRate = totalCount > 0 ? passCount / totalCount : 0;
    if (!hasSummary) {
      criteria.push({
        name: "pass_rate",
        expected: `${TAG_20_PASS_COUNT}/${TAG_20_PASS_COUNT} (100%)`,
        actual: "MISSING (no summary.passed/total_passed in JSON)",
        pass: false,
      });
    } else {
      criteria.push({
        name: "pass_rate",
        expected: `${TAG_20_PASS_COUNT}/${TAG_20_PASS_COUNT} (100%)`,
        actual: `${passCount}/${totalCount} (${(passRate * 100).toFixed(1)}%)`,
        pass: passCount >= TAG_20_PASS_COUNT && passRate === 1.0,
      });
    }
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

export interface EpicGateOptions {
  /** Baseline wall-clock in ms (from v0.5.0 baseline JSON) */
  baselineWallClockMs?: number;
  /** If baseline JSON was not found, set this to the error message */
  baselineError?: string;
  /** Tool-definition overhead in tokens */
  toolOverheadTokens?: number;
  /** If tool overhead could not be measured, set this to the error message */
  toolOverheadError?: string;
}

export function evaluateEpicGate(data: BenchmarkData, epicNumber: number, options?: EpicGateOptions): GateResult {
  const criteria: GateCriterion[] = [];

  if (epicNumber === 19) {
    // 1. MQS >= 70
    if (data.mqs === undefined) {
      criteria.push({ name: "MQS", expected: `>= ${EPIC_19_MQS_MIN}`, actual: "MISSING", pass: false });
    } else {
      criteria.push({ name: "MQS", expected: `>= ${EPIC_19_MQS_MIN}`, actual: `${data.mqs}`, pass: data.mqs >= EPIC_19_MQS_MIN });
    }

    // 2. Recognition rate >= 85%
    if (data.recognition_rate === undefined) {
      criteria.push({ name: "Erkennungs-Rate", expected: `>= ${(EPIC_19_RECOGNITION_RATE_MIN * 100).toFixed(0)}%`, actual: "MISSING", pass: false });
    } else {
      criteria.push({
        name: "Erkennungs-Rate",
        expected: `>= ${(EPIC_19_RECOGNITION_RATE_MIN * 100).toFixed(0)}%`,
        actual: `${(data.recognition_rate * 100).toFixed(1)}%`,
        pass: data.recognition_rate >= EPIC_19_RECOGNITION_RATE_MIN,
      });
    }

    // 3. Wall-Clock >= 50% kuerzer als Baseline
    const currentWallClock = data.wall_clock_ms ?? data.wall_ms;
    if (options?.baselineError) {
      criteria.push({ name: "Wall-Clock", expected: `>= ${(EPIC_19_WALL_CLOCK_REDUCTION_MIN * 100).toFixed(0)}% kuerzer als Baseline`, actual: options.baselineError, pass: false });
    } else if (options?.baselineWallClockMs === undefined || currentWallClock === undefined) {
      const missing = currentWallClock === undefined ? "aktuelle Laufzeit MISSING" : "Baseline MISSING";
      criteria.push({ name: "Wall-Clock", expected: `>= ${(EPIC_19_WALL_CLOCK_REDUCTION_MIN * 100).toFixed(0)}% kuerzer als Baseline`, actual: missing, pass: false });
    } else {
      const reduction = (options.baselineWallClockMs - currentWallClock) / options.baselineWallClockMs;
      const pass = reduction >= EPIC_19_WALL_CLOCK_REDUCTION_MIN;
      criteria.push({
        name: "Wall-Clock",
        expected: `>= ${(EPIC_19_WALL_CLOCK_REDUCTION_MIN * 100).toFixed(0)}% kuerzer als Baseline (${options.baselineWallClockMs}ms)`,
        actual: `${currentWallClock}ms (${(reduction * 100).toFixed(1)}% kuerzer)`,
        pass,
      });
    }

    // 4. Pass-Rate >= 35/35
    const rawPassCount = data.summary?.passed ?? data.summary?.total_passed;
    const hasSummary = rawPassCount !== undefined;
    const passCount = rawPassCount ?? 0;
    const totalCount = data.summary?.total ?? passCount;
    const passRate = totalCount > 0 ? passCount / totalCount : 0;
    if (!hasSummary) {
      criteria.push({
        name: "Pass-Rate",
        expected: `${EPIC_19_PASS_COUNT}/${EPIC_19_PASS_COUNT} (100%)`,
        actual: "MISSING (no summary.passed/total_passed in JSON)",
        pass: false,
      });
    } else {
      criteria.push({
        name: "Pass-Rate",
        expected: `${EPIC_19_PASS_COUNT}/${EPIC_19_PASS_COUNT} (100%)`,
        actual: `${passCount}/${totalCount} (${(passRate * 100).toFixed(1)}%)`,
        pass: passCount >= EPIC_19_PASS_COUNT && passRate === 1.0,
      });
    }

    // 5. Tool-Overhead < 3000 Tokens
    if (options?.toolOverheadError) {
      criteria.push({ name: "Tool-Overhead", expected: `< ${EPIC_19_TOOL_OVERHEAD_MAX} Tokens`, actual: options.toolOverheadError, pass: false });
    } else if (options?.toolOverheadTokens === undefined) {
      // Fallback: check benchmark JSON field
      if (data.tool_definition_tokens !== undefined) {
        criteria.push({
          name: "Tool-Overhead",
          expected: `< ${EPIC_19_TOOL_OVERHEAD_MAX} Tokens`,
          actual: `${data.tool_definition_tokens} Tokens`,
          pass: data.tool_definition_tokens < EPIC_19_TOOL_OVERHEAD_MAX,
        });
      } else {
        criteria.push({ name: "Tool-Overhead", expected: `< ${EPIC_19_TOOL_OVERHEAD_MAX} Tokens`, actual: "nicht messbar (kein Wert)", pass: false });
      }
    } else {
      criteria.push({
        name: "Tool-Overhead",
        expected: `< ${EPIC_19_TOOL_OVERHEAD_MAX} Tokens`,
        actual: `${options.toolOverheadTokens} Tokens`,
        pass: options.toolOverheadTokens < EPIC_19_TOOL_OVERHEAD_MAX,
      });
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

/** Nachsteuerungs-Hinweise fuer verfehlte Epic-19-Kriterien (AC-3) */
const EPIC_19_REMEDIATION: Record<string, string> = {
  "MQS": "MQS zu niedrig → Seed-Bibliothek erweitern oder Fallback-Schwelle schaerfen",
  "Erkennungs-Rate": "Erkennungs-Rate zu niedrig → Seed-Karten fuer fehlende Patterns ergaenzen",
  "Wall-Clock": "Wall-Clock zu langsam → run_plan-Schritte optimieren oder Plan-Parallelisierung pruefen",
  "Pass-Rate": "Pass-Rate nicht 100% → fehlgeschlagene Tests debuggen und fixen",
  "Tool-Overhead": "Tool-Overhead zu hoch → Tool-Descriptions kuerzen oder Tools konsolidieren",
};

export function formatGateResult(result: GateResult): string {
  const lines: string[] = [];
  lines.push(`\n${BOLD}check-gate — ${result.mode}${RESET}`);
  lines.push("\u2550".repeat(50));

  for (const c of result.criteria) {
    const icon = c.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    lines.push(`  ${icon}  ${c.name.padEnd(22)} ${DIM}expected: ${c.expected}  actual: ${c.actual}${RESET}`);
  }

  lines.push("\u2500".repeat(50));

  // Epic-19-specific summary (AC-3, AC-5)
  if (result.mode === "epic:19") {
    const passedCount = result.criteria.filter((c) => c.pass).length;
    if (result.allPassed) {
      lines.push(`  ${GREEN}${BOLD}Epic-19-Gate: ${passedCount} von ${EPIC_19_CRITERIA_COUNT} Kriterien erfuellt — BESTANDEN${RESET}`);
      lines.push(`  ${GREEN}Gate bestanden — dieses Ergebnis ist die Voraussetzung fuer das Taggen einer neuen SilbercueChrome-Release-Version${RESET}`);
    } else {
      lines.push(`  ${RED}${BOLD}Epic-19-Gate: ${passedCount} von ${EPIC_19_CRITERIA_COUNT} Kriterien erfuellt — NICHT BESTANDEN${RESET}`);
      lines.push(`  ${RED}Gate NICHT bestanden — kein Release-Tag moeglich, bis alle fuenf Kriterien erfuellt sind${RESET}`);
      // Nachsteuerungs-Hinweise (AC-3)
      const failedCriteria = result.criteria.filter((c) => !c.pass);
      if (failedCriteria.length > 0) {
        lines.push("");
        lines.push(`  ${BOLD}Nachsteuerungs-Hinweise:${RESET}`);
        for (const c of failedCriteria) {
          const hint = EPIC_19_REMEDIATION[c.name] ?? `${c.name} verfehlt — manuell pruefen`;
          lines.push(`    ${RED}→${RESET} ${hint}`);
        }
      }
    }
  } else {
    const overall = result.allPassed ? `${GREEN}ALL GATES PASSED${RESET}` : `${RED}GATE CHECK FAILED${RESET}`;
    lines.push(`  ${overall}`);
  }

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
  tsx scripts/check-gate.ts --epic 19                 Epic-19 full gate check (5 Kriterien)
  tsx scripts/check-gate.ts --help                    Show this help

Default Gate Criteria:
  recognition_rate   >= ${RECOGNITION_RATE_MIN} (${RECOGNITION_RATE_MIN * 100}%)
  false_positive_rate < ${FALSE_POSITIVE_RATE_MAX} (${FALSE_POSITIVE_RATE_MAX * 100}%)

Epic-19 Gate Criteria (alle 5 muessen gleichzeitig bestanden sein):
  MQS                >= ${EPIC_19_MQS_MIN}
  Erkennungs-Rate    >= ${(EPIC_19_RECOGNITION_RATE_MIN * 100).toFixed(0)}%
  Wall-Clock         >= ${(EPIC_19_WALL_CLOCK_REDUCTION_MIN * 100).toFixed(0)}% kuerzer als v0.5.0 Baseline
  Pass-Rate          = ${EPIC_19_PASS_COUNT}/${EPIC_19_PASS_COUNT} (100%)
  Tool-Overhead      < ${EPIC_19_TOOL_OVERHEAD_MAX} Tokens
`;
}

// ---------------------------------------------------------------------------
// Checkpoint pattern-updates.md entry generation (Story 19.11)
// ---------------------------------------------------------------------------

/** Marker used to detect existing tag-20 entries (idempotency guard) */
const TAG_20_MARKER = "Tag-20-Checkpoint";

export interface CheckpointEntry {
  passed: boolean;
  date: string;
  mqs: number | "MISSING";
  passCount: number;
  passTotal: number;
  mqsDelta?: number;
  failedTests?: Array<{ name: string; error?: string }>;
  recognitionRate?: number;
  falsePositiveRate?: number;
}

/**
 * Build the markdown entry for a tag-20 checkpoint result.
 */
export function buildCheckpointEntry(entry: CheckpointEntry): string {
  const lines: string[] = [];

  if (entry.passed) {
    lines.push(`## ${TAG_20_MARKER} — BESTANDEN (${entry.date})`);
    lines.push("");
    lines.push(`**Ist-Werte:** MQS ${entry.mqs}, Pass-Rate ${entry.passCount}/${entry.passTotal}`);
    lines.push(`**Soll-Werte:** MQS >= ${TAG_20_MQS_MIN}, Pass-Rate = ${TAG_20_PASS_COUNT}/${TAG_20_PASS_COUNT}`);
    lines.push("");
    lines.push("Epic 19 kann planmaessig weiterlaufen.");
  } else {
    lines.push(`## ${TAG_20_MARKER} — NICHT BESTANDEN (${entry.date})`);
    lines.push("");
    lines.push(`**Ist-Werte:** MQS ${entry.mqs}, Pass-Rate ${entry.passCount}/${entry.passTotal}`);
    lines.push(`**Soll-Werte:** MQS >= ${TAG_20_MQS_MIN}, Pass-Rate = ${TAG_20_PASS_COUNT}/${TAG_20_PASS_COUNT}`);

    // MQS-Delta (AC-3, Subtask 3.2)
    if (entry.mqsDelta !== undefined) {
      lines.push(`**MQS-Delta zum Ziel:** ${entry.mqsDelta} Punkte`);
    }

    // Recognition rate + false positive rate (AC-3, Subtask 3.3)
    if (entry.recognitionRate !== undefined) {
      lines.push(`**Erkennungsrate:** ${(entry.recognitionRate * 100).toFixed(1)}%`);
    }
    if (entry.falsePositiveRate !== undefined) {
      lines.push(`**Falscherkennungsrate:** ${(entry.falsePositiveRate * 100).toFixed(1)}%`);
    }

    // Failed tests (AC-3, Subtask 3.1)
    if (entry.failedTests && entry.failedTests.length > 0) {
      lines.push("");
      lines.push("**Fehlgeschlagene Tests:**");
      for (const t of entry.failedTests) {
        const reason = t.error ? ` — ${t.error}` : "";
        lines.push(`- ${t.name}${reason}`);
      }
    }

    lines.push("");
    lines.push("**Nachsteuerungs-Optionen:**");
    lines.push("1. Seed-Bibliothek erweitern");
    lines.push("2. Fallback-Schwelle schaerfen");
    lines.push("3. Scope schneiden");
    lines.push("");
    lines.push("**Entscheidung:** [ausstehend — Julian entscheidet]");
  }

  return lines.join("\n");
}

/**
 * Check whether an entry with a given marker and date already exists in the file content.
 * Matches entries like "## Tag-20-Checkpoint — BESTANDEN (2026-04-20)" or "NICHT BESTANDEN (2026-04-20)".
 * Only blocks entries for the same marker+day, not all future entries. (H1 fix)
 */
function hasEntryForDate(content: string, date: string, marker?: string): boolean {
  const escapedDate = date.replace(/-/g, "\\-");
  if (marker) {
    const pattern = new RegExp(`${marker}[^\\n]*\\(${escapedDate}\\)`);
    return pattern.test(content);
  }
  // Generic: any heading with this date
  const pattern = new RegExp(`## [^\\n]*\\(${escapedDate}\\)`);
  return pattern.test(content);
}

/**
 * Append a checkpoint entry to pattern-updates.md.
 * Idempotent: warns and skips if an entry with the same marker and date already exists.
 * Allows new entries on different dates (e.g. retry next day, or FAIL→PASS).
 * Returns true if the entry was written, false if skipped (duplicate).
 */
export function appendPatternUpdate(filePath: string, entry: string, date?: string, marker?: string): boolean {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let existing = "";
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, "utf-8");
  } else {
    existing = "# Pattern-Updates\n\n---\n";
  }

  // Date-based idempotency guard (H1 fix: only block same-day entries)
  const effectiveDate = date ?? entry.match(/\((\d{4}-\d{2}-\d{2})\)/)?.[1];
  // Detect marker from entry if not provided
  const effectiveMarker = marker ?? (entry.includes(EPIC_19_MARKER) ? EPIC_19_MARKER : TAG_20_MARKER);
  if (effectiveDate && hasEntryForDate(existing, effectiveDate, effectiveMarker)) {
    return false;
  }

  // Atomic write: write to temp file, then rename (H2 fix)
  const separator = "\n\n---\n\n";
  const content = existing.trimEnd() + separator + entry + "\n";
  const tmpPath = filePath + ".tmp." + process.pid;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
  return true;
}

/**
 * Extract failed tests from benchmark data for the decision basis (AC-3).
 */
export function extractFailedTests(data: BenchmarkData): Array<{ name: string; error?: string }> {
  const tests = data["tests"] as Record<string, { pass?: boolean; error?: string }> | undefined;
  if (!tests || typeof tests !== "object") return [];

  const failed: Array<{ name: string; error?: string }> = [];
  for (const [name, result] of Object.entries(tests)) {
    if (result && result.pass === false) {
      failed.push({ name, error: result.error });
    }
  }
  return failed;
}

/**
 * Format checkpoint summary line for console output (AC-3, Subtask 3.4).
 */
export function formatCheckpointSummary(result: GateResult, data: BenchmarkData): string {
  const passedCount = result.criteria.filter((c) => c.pass).length;
  const mqsActual = data.mqs;
  const mqsDelta = mqsActual !== undefined ? TAG_20_MQS_MIN - mqsActual : undefined;
  // M1 fix: use fixed constant for total criteria count, not dynamic criteria.length
  const deltaText = mqsDelta !== undefined && mqsDelta > 0 ? `, Delta MQS: ${mqsDelta} Punkte` : "";

  const lines: string[] = [];
  if (result.allPassed) {
    lines.push(`\n${GREEN}${BOLD}Tag-20-Checkpoint bestanden — Epic 19 kann planmaessig weiterlaufen${RESET}`);
  }
  lines.push(
    `\n${BOLD}Tag-20-Checkpoint: ${passedCount} von ${TAG_20_CRITERIA_COUNT} Kriterien erfuellt${deltaText}${RESET}\n`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Epic-19 Logbuch-Eintraege (Story 19.13, AC-4)
// ---------------------------------------------------------------------------

export interface Epic19GateValues {
  mqs: number | "MISSING";
  recognitionRate: string;
  wallClockMs: number | "MISSING";
  wallClockReduction: string;
  passCount: number;
  passTotal: number;
  toolOverheadTokens: number | "MISSING";
  baselineMs: number | "MISSING";
}

/**
 * Build the markdown entry for docs/pattern-updates.md on passed Epic-19 gate (AC-4).
 */
export function buildEpic19PatternEntry(date: string, values: Epic19GateValues, benchmarkFile: string): string {
  const lines: string[] = [];
  lines.push(`## ${EPIC_19_MARKER} — BESTANDEN (${date})`);
  lines.push("");
  lines.push(`**Benchmark-JSON:** ${benchmarkFile}`);
  lines.push("**Ist-Werte:**");
  lines.push(`- MQS: ${values.mqs} (Soll >= ${EPIC_19_MQS_MIN})`);
  lines.push(`- Erkennungs-Rate: ${values.recognitionRate} (Soll >= ${(EPIC_19_RECOGNITION_RATE_MIN * 100).toFixed(0)}%)`);
  lines.push(`- Wall-Clock: ${values.wallClockMs}ms (${values.wallClockReduction} kuerzer als Baseline ${values.baselineMs}ms, Soll >= ${(EPIC_19_WALL_CLOCK_REDUCTION_MIN * 100).toFixed(0)}%)`);
  lines.push(`- Pass-Rate: ${values.passCount}/${values.passTotal} (Soll = ${EPIC_19_PASS_COUNT}/${EPIC_19_PASS_COUNT})`);
  lines.push(`- Tool-Overhead: ${values.toolOverheadTokens} Tokens (Soll < ${EPIC_19_TOOL_OVERHEAD_MAX})`);
  lines.push("");
  lines.push("Epic-19-Gate bestanden — Voraussetzung fuer Release-Tag erfuellt.");
  return lines.join("\n");
}

/**
 * Build the markdown entry for docs/schema-migrations.md on passed Epic-19 gate (AC-4).
 */
export function buildEpic19SchemaMigrationEntry(date: string, version: string, values: Epic19GateValues): string {
  const lines: string[] = [];
  lines.push(`## ${EPIC_19_MARKER} — BESTANDEN (${date})`);
  lines.push("");
  lines.push(`**Version:** ${version} (aus package.json)`);
  lines.push("**Benchmark-Werte:**");
  lines.push(`- MQS: ${values.mqs} (Soll >= ${EPIC_19_MQS_MIN})`);
  lines.push(`- Erkennungs-Rate: ${values.recognitionRate} (Soll >= ${(EPIC_19_RECOGNITION_RATE_MIN * 100).toFixed(0)}%)`);
  lines.push(`- Wall-Clock: ${values.wallClockMs}ms (${values.wallClockReduction} kuerzer als Baseline, Soll >= ${(EPIC_19_WALL_CLOCK_REDUCTION_MIN * 100).toFixed(0)}%)`);
  lines.push(`- Pass-Rate: ${values.passCount}/${values.passTotal} (Soll = ${EPIC_19_PASS_COUNT}/${EPIC_19_PASS_COUNT})`);
  lines.push(`- Tool-Overhead: ${values.toolOverheadTokens} Tokens (Soll < ${EPIC_19_TOOL_OVERHEAD_MAX})`);
  lines.push("");
  lines.push("Release-Tag kann gesetzt werden.");
  return lines.join("\n");
}

/**
 * Append a schema migration entry to docs/schema-migrations.md.
 * Idempotent: warns and skips if an Epic-19 entry for the same date already exists.
 */
export function appendSchemaMigration(filePath: string, entry: string, date: string): boolean {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let existing = "";
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, "utf-8");
  } else {
    existing = "# Schema-Migrations\n\n---\n";
  }

  // Date-based idempotency guard
  const pattern = new RegExp(`${EPIC_19_MARKER}[^\\n]*\\(${date.replace(/-/g, "\\-")}\\)`);
  if (pattern.test(existing)) {
    return false;
  }

  const separator = "\n\n---\n\n";
  const content = existing.trimEnd() + separator + entry + "\n";
  const tmpPath = filePath + ".tmp." + process.pid;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
  return true;
}

/**
 * Load baseline JSON for wall-clock comparison.
 * Returns { wallClockMs } or { error }.
 */
export function loadBaselineWallClock(repoRoot: string): { wallClockMs: number } | { error: string } {
  const baselinePath = resolve(repoRoot, BASELINE_JSON_PATH);
  if (!existsSync(baselinePath)) {
    return { error: "Baseline-JSON nicht gefunden — Wall-Clock-Vergleich nicht moeglich" };
  }
  try {
    const raw = JSON.parse(readFileSync(baselinePath, "utf-8"));
    const ms = raw.wall_clock_ms ?? raw.wall_ms;
    if (ms === undefined || typeof ms !== "number") {
      return { error: "Baseline-JSON hat kein wall_clock_ms/wall_ms Feld" };
    }
    if (ms <= 0) {
      return { error: `Baseline wall_clock_ms ist ${ms} — muss groesser als 0 sein (Division durch 0 vermeiden)` };
    }
    return { wallClockMs: ms };
  } catch (err) {
    return { error: `Baseline-JSON Lesefehler: ${(err as Error).message}` };
  }
}

/**
 * Measure tool-definition overhead for the standard tool set.
 *
 * Strategy (C1/H1 fix — matches token-budget.test.ts method):
 *   1. PRIMARY: Import ToolRegistry from build output, instantiate with a mock
 *      server, register all tools, sum name + description + JSON.stringify(zodShape)
 *      for ENABLED tools only, divide by 4 (chars/4 ≈ tokens).
 *   2. FALLBACK: If Registry import fails (missing build, dependency issues in
 *      CLI context), read tool_definition_tokens from benchmark JSON.
 *      Limitation: this is a stale snapshot from the last benchmark run, not live.
 *   3. FAIL: If both unavailable, return error.
 */
export function measureToolOverhead(data: BenchmarkData): { tokens: number } | { error: string } {
  // Primary: live measurement from ToolRegistry (same method as token-budget.test.ts)
  try {
    return measureToolOverheadFromRegistry();
  } catch {
    // Registry import failed — expected in some CLI contexts (missing build, etc.)
  }

  // Fallback: from benchmark JSON (if the benchmark run recorded it)
  // Limitation: this value was recorded at benchmark time, not live-measured now.
  if (data.tool_definition_tokens !== undefined && typeof data.tool_definition_tokens === "number") {
    if (data.tool_definition_tokens < 0) {
      return { error: `tool_definition_tokens ist ${data.tool_definition_tokens} — ungueltiger Wert` };
    }
    return { tokens: data.tool_definition_tokens };
  }

  return { error: "Tool-Overhead nicht messbar: Registry-Import fehlgeschlagen und kein tool_definition_tokens in Benchmark-JSON. Bitte 'npm run build' ausfuehren." };
}

/**
 * Measure tool overhead by instantiating ToolRegistry with a mock server.
 * Counts chars of ENABLED tools' (name + description + JSON schema) / 4.
 * This is the same method used in src/operator/token-budget.test.ts.
 * Throws if ToolRegistry cannot be loaded from build output.
 */
function measureToolOverheadFromRegistry(): { tokens: number } {
  // Dynamic import of the built registry
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ToolRegistry } = require("../build/registry.js") as { ToolRegistry: RegistryConstructor };

  // Ensure standard mode (not FULL_TOOLS)
  const prevFullTools = process.env.SILBERCUE_CHROME_FULL_TOOLS;
  delete process.env.SILBERCUE_CHROME_FULL_TOOLS;

  try {
    const toolCalls: Array<[string, string, Record<string, unknown>]> = [];
    const toolResults: Array<{ enabled: boolean }> = [];

    const toolFn = (...args: unknown[]) => {
      const tool = {
        enabled: true,
        enable() { tool.enabled = true; },
        disable() { tool.enabled = false; },
        update() {},
        remove() {},
      };
      toolCalls.push([args[0] as string, args[1] as string, args[2] as Record<string, unknown>]);
      toolResults.push(tool);
      return tool;
    };
    const mockServer = { tool: toolFn, sendToolListChanged() {} } as never;
    const mockCdp = {} as never;

    const registry = new ToolRegistry(mockServer, mockCdp, "gate-check", {} as never);
    registry.registerAll();

    // Sum only ENABLED tools (standard mode: virtual_desk + operator).
    // Disabled fallback tools are not counted — they don't appear in tools/list.
    let totalChars = 0;
    for (let i = 0; i < toolCalls.length; i++) {
      const [name, description, zodShape] = toolCalls[i]!;
      const result = toolResults[i]!;
      if (result.enabled) {
        totalChars += name.length;
        totalChars += description.length;
        totalChars += JSON.stringify(zodShape).length;
      }
    }

    return { tokens: Math.ceil(totalChars / 4) };
  } finally {
    // Restore env
    if (prevFullTools !== undefined) {
      process.env.SILBERCUE_CHROME_FULL_TOOLS = prevFullTools;
    } else {
      delete process.env.SILBERCUE_CHROME_FULL_TOOLS;
    }
  }
}

/** Type for the ToolRegistry constructor (dynamic import) */
interface RegistryConstructor {
  new (server: never, cdpClient: never, sessionId: string, options: never): {
    registerAll(): void;
  };
}

/**
 * Read the project version from package.json.
 */
function readProjectVersion(repoRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Main (only runs when executed directly, not when imported)
// ---------------------------------------------------------------------------

export interface RunCheckGateOptions {
  patternUpdatesPath?: string;
  schemaMigrationsPath?: string;
  /** Override for baseline wall-clock (for testing) */
  baselineWallClockMs?: number;
  /** Override for tool overhead tokens (for testing) */
  toolOverheadTokens?: number;
  /** Override for repoRoot (for testing) */
  repoRoot?: string;
}

export function runCheckGate(argv: string[], options?: RunCheckGateOptions): GateResult | null {
  const parsed = parseCheckGateArgs(argv);

  if (parsed.mode === "help") {
    console.log(printHelp());
    return null;
  }

  // Resolve file path
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = options?.repoRoot ?? resolve(__dirname, "..");
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
    case "epic": {
      // Epic-19: load baseline + measure tool overhead
      let epicOptions: EpicGateOptions | undefined;
      if (parsed.epicNumber === 19) {
        epicOptions = {};

        // Wall-Clock baseline
        if (options?.baselineWallClockMs !== undefined) {
          epicOptions.baselineWallClockMs = options.baselineWallClockMs;
        } else {
          const baseline = loadBaselineWallClock(repoRoot);
          if ("error" in baseline) {
            epicOptions.baselineError = baseline.error;
          } else {
            epicOptions.baselineWallClockMs = baseline.wallClockMs;
          }
        }

        // Tool overhead
        if (options?.toolOverheadTokens !== undefined) {
          epicOptions.toolOverheadTokens = options.toolOverheadTokens;
        } else {
          const overhead = measureToolOverhead(data);
          if ("error" in overhead) {
            epicOptions.toolOverheadError = overhead.error;
          } else {
            epicOptions.toolOverheadTokens = overhead.tokens;
          }
        }
      }
      result = evaluateEpicGate(data, parsed.epicNumber!, epicOptions);
      break;
    }
    default:
      result = evaluateDefaultGate(data);
      break;
  }

  console.log(formatGateResult(result));

  // Checkpoint-specific: write pattern-updates.md entry + summary (Story 19.11)
  if (parsed.mode === "checkpoint" && parsed.checkpointTag === "tag-20") {
    const patternPath = options?.patternUpdatesPath ?? resolve(repoRoot, "docs", "pattern-updates.md");
    const today = new Date().toISOString().slice(0, 10);
    const rawPassCount = data.summary?.passed ?? data.summary?.total_passed;
    const passCount = rawPassCount ?? 0;
    const passTotal = data.summary?.total ?? passCount;

    // C3 fix: explicit console warning when summary fields are missing
    if (rawPassCount === undefined) {
      console.error(`${RED}WARNING${RESET}: Benchmark JSON has no summary.passed or summary.total_passed — pass_rate shows MISSING`);
    }
    const mqsActual = data.mqs;
    if (mqsActual === undefined) {
      console.error(`${RED}WARNING${RESET}: Benchmark JSON has no mqs field — MQS shows MISSING`);
    }

    const checkpointEntry: CheckpointEntry = {
      passed: result.allPassed,
      date: today,
      mqs: mqsActual ?? "MISSING",
      passCount,
      passTotal,
    };

    if (!result.allPassed) {
      if (mqsActual !== undefined) {
        checkpointEntry.mqsDelta = TAG_20_MQS_MIN - mqsActual;
      }
      checkpointEntry.failedTests = extractFailedTests(data);
      if (data.recognition_rate !== undefined) {
        checkpointEntry.recognitionRate = data.recognition_rate;
      }
      if (data.false_positive_rate !== undefined) {
        checkpointEntry.falsePositiveRate = data.false_positive_rate;
      }
    }

    const markdown = buildCheckpointEntry(checkpointEntry);
    const written = appendPatternUpdate(patternPath, markdown, today);

    if (written) {
      console.log(`${DIM}Eintrag in ${patternPath} geschrieben.${RESET}`);
    } else {
      console.log(`${DIM}Tag-20-Eintrag fuer ${today} existiert bereits in ${patternPath} — uebersprungen.${RESET}`);
    }

    console.log(formatCheckpointSummary(result, data));
  }

  // Epic-19-specific: write logbook entries on pass (Story 19.13, AC-4)
  if (parsed.mode === "epic" && parsed.epicNumber === 19 && result.allPassed) {
    const patternPath = options?.patternUpdatesPath ?? resolve(repoRoot, "docs", "pattern-updates.md");
    const schemaPath = options?.schemaMigrationsPath ?? resolve(repoRoot, "docs", "schema-migrations.md");
    const today = new Date().toISOString().slice(0, 10);
    const version = readProjectVersion(repoRoot);

    const rawPassCount = data.summary?.passed ?? data.summary?.total_passed ?? 0;
    const passTotal = data.summary?.total ?? rawPassCount;
    const currentWallClock = data.wall_clock_ms ?? data.wall_ms;

    // Extract baseline from result criteria (already computed)
    const wallClockCriterion = result.criteria.find((c) => c.name === "Wall-Clock");
    const reductionMatch = wallClockCriterion?.actual.match(/([\d.]+)% kuerzer/);
    const reductionStr = reductionMatch ? `${reductionMatch[1]}%` : "N/A";

    // Extract baseline ms from expected string
    const baselineMatch = wallClockCriterion?.expected.match(/\((\d+)ms\)/);
    const baselineMs = baselineMatch ? parseInt(baselineMatch[1], 10) : ("MISSING" as const);

    const toolCriterion = result.criteria.find((c) => c.name === "Tool-Overhead");
    const toolTokensMatch = toolCriterion?.actual.match(/^(\d+) Tokens/);
    const toolTokens = toolTokensMatch ? parseInt(toolTokensMatch[1], 10) : ("MISSING" as const);

    const benchmarkFile = filePath.split("/").pop() ?? filePath;

    const values: Epic19GateValues = {
      mqs: data.mqs ?? "MISSING",
      recognitionRate: data.recognition_rate !== undefined ? `${(data.recognition_rate * 100).toFixed(1)}%` : "MISSING",
      wallClockMs: currentWallClock ?? "MISSING",
      wallClockReduction: reductionStr,
      passCount: rawPassCount,
      passTotal,
      toolOverheadTokens: toolTokens,
      baselineMs,
    };

    // pattern-updates.md
    const patternEntry = buildEpic19PatternEntry(today, values, benchmarkFile);
    const patternWritten = appendPatternUpdate(patternPath, patternEntry, today);
    if (patternWritten) {
      console.log(`${DIM}Epic-19-Eintrag in ${patternPath} geschrieben.${RESET}`);
    } else {
      console.log(`${DIM}Epic-19-Eintrag fuer ${today} existiert bereits in ${patternPath} — uebersprungen.${RESET}`);
    }

    // schema-migrations.md
    const schemaEntry = buildEpic19SchemaMigrationEntry(today, version, values);
    const schemaWritten = appendSchemaMigration(schemaPath, schemaEntry, today);
    if (schemaWritten) {
      console.log(`${DIM}Epic-19-Eintrag in ${schemaPath} geschrieben.${RESET}`);
    } else {
      console.log(`${DIM}Epic-19-Eintrag fuer ${today} existiert bereits in ${schemaPath} — uebersprungen.${RESET}`);
    }
  }

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
