/**
 * Unit tests for scripts/check-gate.ts
 *
 * Tests all three gate modes (default, checkpoint, epic) and edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  parseCheckGateArgs,
  evaluateDefaultGate,
  evaluateCheckpointGate,
  evaluateEpicGate,
  findLatestBenchmarkJson,
  formatGateResult,
  formatCheckpointSummary,
  printHelp,
  runCheckGate,
  buildCheckpointEntry,
  buildEpic19PatternEntry,
  buildEpic19SchemaMigrationEntry,
  appendPatternUpdate,
  appendSchemaMigration,
  extractFailedTests,
  loadBaselineWallClock,
  measureToolOverhead,
  RECOGNITION_RATE_MIN,
  FALSE_POSITIVE_RATE_MAX,
  TAG_20_MQS_MIN,
  TAG_20_PASS_COUNT,
  TAG_20_CRITERIA_COUNT,
  EPIC_19_MQS_MIN,
  EPIC_19_PASS_COUNT,
  EPIC_19_CRITERIA_COUNT,
  EPIC_19_WALL_CLOCK_REDUCTION_MIN,
  EPIC_19_TOOL_OVERHEAD_MAX,
  type BenchmarkData,
  type GateResult,
  type CheckpointEntry,
  type EpicGateOptions,
  type Epic19GateValues,
} from "./check-gate.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

describe("parseCheckGateArgs", () => {
  it("returns default mode with no args", () => {
    const result = parseCheckGateArgs(["node", "check-gate.ts"]);
    expect(result.mode).toBe("default");
    expect(result.file).toBeUndefined();
  });

  it("parses --file flag", () => {
    const result = parseCheckGateArgs(["node", "check-gate.ts", "--file", "path/to/file.json"]);
    expect(result.mode).toBe("default");
    expect(result.file).toBe("path/to/file.json");
  });

  it("parses --checkpoint flag", () => {
    const result = parseCheckGateArgs(["node", "check-gate.ts", "--checkpoint", "tag-20"]);
    expect(result.mode).toBe("checkpoint");
    expect(result.checkpointTag).toBe("tag-20");
  });

  it("parses --epic flag", () => {
    const result = parseCheckGateArgs(["node", "check-gate.ts", "--epic", "19"]);
    expect(result.mode).toBe("epic");
    expect(result.epicNumber).toBe(19);
  });

  it("parses --help flag", () => {
    const result = parseCheckGateArgs(["node", "check-gate.ts", "--help"]);
    expect(result.mode).toBe("help");
  });

  it("parses -h flag", () => {
    const result = parseCheckGateArgs(["node", "check-gate.ts", "-h"]);
    expect(result.mode).toBe("help");
  });
});

// ---------------------------------------------------------------------------
// Default Gate (AC-4, Subtask 5.2 — 5.5)
// ---------------------------------------------------------------------------

describe("evaluateDefaultGate", () => {
  it("PASS: recognition_rate=0.90 and false_positive_rate=0.03 → all passed (Subtask 5.2)", () => {
    const data: BenchmarkData = {
      recognition_rate: 0.90,
      false_positive_rate: 0.03,
    };
    const result = evaluateDefaultGate(data);
    expect(result.allPassed).toBe(true);
    expect(result.criteria).toHaveLength(2);
    expect(result.criteria.every((c) => c.pass)).toBe(true);
  });

  it("FAIL: recognition_rate=0.80 → under 85% (Subtask 5.3)", () => {
    const data: BenchmarkData = {
      recognition_rate: 0.80,
      false_positive_rate: 0.03,
    };
    const result = evaluateDefaultGate(data);
    expect(result.allPassed).toBe(false);
    const recCriterion = result.criteria.find((c) => c.name === "recognition_rate");
    expect(recCriterion?.pass).toBe(false);
  });

  it("FAIL: false_positive_rate=0.06 → over 5% (Subtask 5.4)", () => {
    const data: BenchmarkData = {
      recognition_rate: 0.90,
      false_positive_rate: 0.06,
    };
    const result = evaluateDefaultGate(data);
    expect(result.allPassed).toBe(false);
    const fpCriterion = result.criteria.find((c) => c.name === "false_positive_rate");
    expect(fpCriterion?.pass).toBe(false);
  });

  it("FAIL: missing recognition_rate field → MISSING + fail (Subtask 5.5)", () => {
    const data: BenchmarkData = {
      false_positive_rate: 0.03,
    };
    const result = evaluateDefaultGate(data);
    expect(result.allPassed).toBe(false);
    const recCriterion = result.criteria.find((c) => c.name === "recognition_rate");
    expect(recCriterion?.actual).toBe("MISSING");
    expect(recCriterion?.pass).toBe(false);
  });

  it("FAIL: missing false_positive_rate field → MISSING + fail", () => {
    const data: BenchmarkData = {
      recognition_rate: 0.90,
    };
    const result = evaluateDefaultGate(data);
    expect(result.allPassed).toBe(false);
    const fpCriterion = result.criteria.find((c) => c.name === "false_positive_rate");
    expect(fpCriterion?.actual).toBe("MISSING");
    expect(fpCriterion?.pass).toBe(false);
  });

  it("PASS: recognition_rate exactly at threshold (0.85) → passes", () => {
    const data: BenchmarkData = {
      recognition_rate: 0.85,
      false_positive_rate: 0.04,
    };
    const result = evaluateDefaultGate(data);
    expect(result.allPassed).toBe(true);
  });

  it("FAIL: false_positive_rate exactly at threshold (0.05) → fails (strict <)", () => {
    const data: BenchmarkData = {
      recognition_rate: 0.90,
      false_positive_rate: 0.05,
    };
    const result = evaluateDefaultGate(data);
    expect(result.allPassed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint Gate (Subtask 5.6)
// ---------------------------------------------------------------------------

describe("evaluateCheckpointGate", () => {
  it("PASS: tag-20 with MQS=70 and pass_rate=35/35 (Subtask 5.6)", () => {
    const data: BenchmarkData = {
      mqs: 70,
      summary: { passed: 35, total: 35 },
    };
    const result = evaluateCheckpointGate(data, "tag-20");
    expect(result.allPassed).toBe(true);
    expect(result.mode).toBe("checkpoint:tag-20");
  });

  it("FAIL: tag-20 with MQS=60 → under threshold", () => {
    const data: BenchmarkData = {
      mqs: 60,
      summary: { passed: 35, total: 35 },
    };
    const result = evaluateCheckpointGate(data, "tag-20");
    expect(result.allPassed).toBe(false);
    const mqsCriterion = result.criteria.find((c) => c.name === "mqs");
    expect(mqsCriterion?.pass).toBe(false);
  });

  it("FAIL: tag-20 with pass_count=30/35 → under threshold", () => {
    const data: BenchmarkData = {
      mqs: 70,
      summary: { passed: 30, total: 35 },
    };
    const result = evaluateCheckpointGate(data, "tag-20");
    expect(result.allPassed).toBe(false);
  });

  it("FAIL: tag-20 with 35/100 → pass_count met but rate not 100% (H6 fix)", () => {
    const data: BenchmarkData = {
      mqs: 70,
      summary: { passed: 35, total: 100 },
    };
    const result = evaluateCheckpointGate(data, "tag-20");
    expect(result.allPassed).toBe(false);
    const rateCriterion = result.criteria.find((c) => c.name === "pass_rate");
    expect(rateCriterion?.pass).toBe(false);
    expect(rateCriterion?.actual).toContain("35/100");
  });

  it("FAIL: tag-20 with missing MQS", () => {
    const data: BenchmarkData = {
      summary: { passed: 35, total: 35 },
    };
    const result = evaluateCheckpointGate(data, "tag-20");
    expect(result.allPassed).toBe(false);
  });

  it("FAIL: unknown checkpoint tag", () => {
    const data: BenchmarkData = { mqs: 70, summary: { passed: 35 } };
    const result = evaluateCheckpointGate(data, "tag-99");
    expect(result.allPassed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Epic Gate (Subtask 5.7)
// ---------------------------------------------------------------------------

describe("evaluateEpicGate", () => {
  /** Standard Epic-19 options with passing baseline + tool overhead */
  const passingOptions: EpicGateOptions = {
    baselineWallClockMs: 1622,
    toolOverheadTokens: 500,
  };

  it("PASS: epic 19 all criteria met (Subtask 5.7)", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.90,
      false_positive_rate: 0.02,
      wall_clock_ms: 500,
    };
    const result = evaluateEpicGate(data, 19, passingOptions);
    expect(result.allPassed).toBe(true);
    expect(result.mode).toBe("epic:19");
    expect(result.criteria).toHaveLength(5);
  });

  it("FAIL: epic 19 missing MQS", () => {
    const data: BenchmarkData = {
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.90,
      false_positive_rate: 0.02,
      wall_clock_ms: 500,
    };
    const result = evaluateEpicGate(data, 19, passingOptions);
    expect(result.allPassed).toBe(false);
  });

  it("FAIL: epic 19 MQS too low", () => {
    const data: BenchmarkData = {
      mqs: 65,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.90,
      false_positive_rate: 0.02,
      wall_clock_ms: 500,
    };
    const result = evaluateEpicGate(data, 19, passingOptions);
    expect(result.allPassed).toBe(false);
  });

  it("FAIL: unknown epic number", () => {
    const data: BenchmarkData = { mqs: 75 };
    const result = evaluateEpicGate(data, 99);
    expect(result.allPassed).toBe(false);
  });

  it("uses total_passed fallback from summary", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { total_passed: 35, total: 35 },
      recognition_rate: 0.90,
      false_positive_rate: 0.02,
      wall_clock_ms: 500,
    };
    const result = evaluateEpicGate(data, 19, passingOptions);
    expect(result.allPassed).toBe(true);
  });

  it("FAIL: epic 19 with 35/100 → pass_count met but rate not 100% (H6 fix)", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 100 },
      recognition_rate: 0.90,
      false_positive_rate: 0.02,
      wall_clock_ms: 500,
    };
    const result = evaluateEpicGate(data, 19, passingOptions);
    expect(result.allPassed).toBe(false);
    const rateCriterion = result.criteria.find((c) => c.name === "Pass-Rate");
    expect(rateCriterion?.pass).toBe(false);
    expect(rateCriterion?.actual).toContain("35/100");
  });
});

// ---------------------------------------------------------------------------
// File Discovery
// ---------------------------------------------------------------------------

describe("findLatestBenchmarkJson", () => {
  let tempDir: string;

  it("returns null for non-existent directory", () => {
    const result = findLatestBenchmarkJson("/nonexistent-dir-12345");
    expect(result).toBeNull();
  });

  it("returns null for empty directory", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
    const result = findLatestBenchmarkJson(tempDir);
    expect(result).toBeNull();
    fs.rmSync(tempDir, { recursive: true });
  });

  it("finds benchmark JSON file", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
    fs.writeFileSync(path.join(tempDir, "benchmark-test-2026-04-12.json"), "{}");
    const result = findLatestBenchmarkJson(tempDir);
    expect(result).toContain("benchmark-test-2026-04-12.json");
    fs.rmSync(tempDir, { recursive: true });
  });

  it("returns latest file (sorted descending)", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
    fs.writeFileSync(path.join(tempDir, "benchmark-a-2026-04-01.json"), "{}");
    fs.writeFileSync(path.join(tempDir, "benchmark-b-2026-04-12.json"), "{}");
    const result = findLatestBenchmarkJson(tempDir);
    expect(result).toContain("benchmark-b-2026-04-12.json");
    fs.rmSync(tempDir, { recursive: true });
  });

  it("filters for operator files when requested", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
    fs.writeFileSync(path.join(tempDir, "benchmark-standard-2026-04-12.json"), "{}");
    fs.writeFileSync(path.join(tempDir, "benchmark-operator-2026-04-12.json"), "{}");
    const result = findLatestBenchmarkJson(tempDir, true);
    expect(result).toContain("operator");
    fs.rmSync(tempDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Output Formatting
// ---------------------------------------------------------------------------

describe("formatGateResult", () => {
  it("contains PASS for passed criteria", () => {
    const result: GateResult = {
      mode: "default",
      criteria: [{ name: "test", expected: ">= 0.85", actual: "0.90", pass: true }],
      allPassed: true,
    };
    const output = formatGateResult(result);
    expect(output).toContain("PASS");
    expect(output).toContain("ALL GATES PASSED");
  });

  it("contains FAIL for failed criteria", () => {
    const result: GateResult = {
      mode: "default",
      criteria: [{ name: "test", expected: ">= 0.85", actual: "0.80", pass: false }],
      allPassed: false,
    };
    const output = formatGateResult(result);
    expect(output).toContain("FAIL");
    expect(output).toContain("GATE CHECK FAILED");
  });
});

describe("printHelp", () => {
  it("contains usage information", () => {
    const help = printHelp();
    expect(help).toContain("check-gate");
    expect(help).toContain("--file");
    expect(help).toContain("--checkpoint");
    expect(help).toContain("--epic");
  });
});

// ---------------------------------------------------------------------------
// Named Constants Verification (Invariante 5)
// ---------------------------------------------------------------------------

describe("Named Constants", () => {
  it("RECOGNITION_RATE_MIN is 0.85", () => {
    expect(RECOGNITION_RATE_MIN).toBe(0.85);
  });

  it("FALSE_POSITIVE_RATE_MAX is 0.05", () => {
    expect(FALSE_POSITIVE_RATE_MAX).toBe(0.05);
  });

  it("TAG_20_MQS_MIN is 66", () => {
    expect(TAG_20_MQS_MIN).toBe(66);
  });

  it("TAG_20_PASS_COUNT is 35", () => {
    expect(TAG_20_PASS_COUNT).toBe(35);
  });

  it("TAG_20_CRITERIA_COUNT is 2", () => {
    expect(TAG_20_CRITERIA_COUNT).toBe(2);
  });

  it("EPIC_19_MQS_MIN is 70", () => {
    expect(EPIC_19_MQS_MIN).toBe(70);
  });

  it("EPIC_19_PASS_COUNT is 35", () => {
    expect(EPIC_19_PASS_COUNT).toBe(35);
  });
});

// ---------------------------------------------------------------------------
// CLI End-to-End: runCheckGate (M1 fix)
// ---------------------------------------------------------------------------

describe("runCheckGate — CLI E2E", () => {
  let tempDir: string;

  it("returns null for --help mode", () => {
    const result = runCheckGate(["node", "check-gate.ts", "--help"]);
    expect(result).toBeNull();
  });

  it("returns passing GateResult for valid default JSON via --file", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cli-test-"));
    const jsonPath = path.join(tempDir, "benchmark-test.json");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        recognition_rate: 0.92,
        false_positive_rate: 0.01,
        summary: { passed: 31, total: 31 },
      }),
    );
    const result = runCheckGate(["node", "check-gate.ts", "--file", jsonPath]);
    expect(result).not.toBeNull();
    expect(result!.allPassed).toBe(true);
    expect(result!.mode).toBe("default");
    fs.rmSync(tempDir, { recursive: true });
  });

  it("returns failing GateResult for below-threshold JSON via --file", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cli-test-"));
    const jsonPath = path.join(tempDir, "benchmark-test.json");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        recognition_rate: 0.50,
        false_positive_rate: 0.10,
      }),
    );
    const result = runCheckGate(["node", "check-gate.ts", "--file", jsonPath]);
    expect(result).not.toBeNull();
    expect(result!.allPassed).toBe(false);
    fs.rmSync(tempDir, { recursive: true });
  });

  it("runs checkpoint mode via --file and --checkpoint", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cli-test-"));
    const jsonPath = path.join(tempDir, "benchmark-test.json");
    const patternPath = path.join(tempDir, "pattern-updates.md");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        mqs: 70,
        summary: { passed: 35, total: 35 },
      }),
    );
    const result = runCheckGate(
      ["node", "check-gate.ts", "--checkpoint", "tag-20", "--file", jsonPath],
      { patternUpdatesPath: patternPath },
    );
    expect(result).not.toBeNull();
    expect(result!.allPassed).toBe(true);
    expect(result!.mode).toBe("checkpoint:tag-20");
    fs.rmSync(tempDir, { recursive: true });
  });

  it("runs epic mode via --file and --epic", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cli-test-"));
    const jsonPath = path.join(tempDir, "benchmark-test.json");
    const patternPath = path.join(tempDir, "pattern-updates.md");
    const schemaPath = path.join(tempDir, "schema-migrations.md");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        mqs: 75,
        summary: { passed: 35, total: 35 },
        recognition_rate: 0.90,
        false_positive_rate: 0.02,
        wall_clock_ms: 500,
      }),
    );
    const result = runCheckGate(
      ["node", "check-gate.ts", "--epic", "19", "--file", jsonPath],
      {
        baselineWallClockMs: 1622,
        toolOverheadTokens: 500,
        patternUpdatesPath: patternPath,
        schemaMigrationsPath: schemaPath,
      },
    );
    expect(result).not.toBeNull();
    expect(result!.allPassed).toBe(true);
    expect(result!.mode).toBe("epic:19");
    fs.rmSync(tempDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Story 19.11 — Checkpoint Entry Building
// ---------------------------------------------------------------------------

describe("buildCheckpointEntry", () => {
  it("builds BESTANDEN entry with date and Ist-Werte (Subtask 5.1, 5.6)", () => {
    const entry: CheckpointEntry = {
      passed: true,
      date: "2026-04-20",
      mqs: 70,
      passCount: 35,
      passTotal: 35,
    };
    const md = buildCheckpointEntry(entry);
    expect(md).toContain("BESTANDEN");
    expect(md).toContain("2026-04-20");
    expect(md).toContain("MQS 70");
    expect(md).toContain("Pass-Rate 35/35");
    expect(md).toContain("Epic 19 kann planmaessig weiterlaufen");
    expect(md).not.toContain("NICHT BESTANDEN");
    expect(md).not.toContain("Nachsteuerungs-Optionen");
  });

  it("builds NICHT BESTANDEN entry with MQS too low (Subtask 5.2)", () => {
    const entry: CheckpointEntry = {
      passed: false,
      date: "2026-04-20",
      mqs: 60,
      passCount: 35,
      passTotal: 35,
      mqsDelta: 6,
    };
    const md = buildCheckpointEntry(entry);
    expect(md).toContain("NICHT BESTANDEN");
    expect(md).toContain("MQS 60");
    expect(md).toContain("**MQS-Delta zum Ziel:** 6 Punkte");
    expect(md).toContain("Seed-Bibliothek erweitern");
    expect(md).toContain("Fallback-Schwelle schaerfen");
    expect(md).toContain("Scope schneiden");
    expect(md).toContain("Julian entscheidet");
  });

  it("builds NICHT BESTANDEN entry with failed tests listed (Subtask 5.3)", () => {
    const entry: CheckpointEntry = {
      passed: false,
      date: "2026-04-20",
      mqs: 70,
      passCount: 33,
      passTotal: 35,
      failedTests: [
        { name: "T2.1 Login", error: "timeout" },
        { name: "T3.2 Wizard", error: "wrong element" },
      ],
    };
    const md = buildCheckpointEntry(entry);
    expect(md).toContain("NICHT BESTANDEN");
    expect(md).toContain("Pass-Rate 33/35");
    expect(md).toContain("Fehlgeschlagene Tests:");
    expect(md).toContain("T2.1 Login");
    expect(md).toContain("timeout");
    expect(md).toContain("T3.2 Wizard");
  });

  it("includes recognition rate and false positive rate when present", () => {
    const entry: CheckpointEntry = {
      passed: false,
      date: "2026-04-20",
      mqs: 60,
      passCount: 33,
      passTotal: 35,
      recognitionRate: 0.82,
      falsePositiveRate: 0.07,
    };
    const md = buildCheckpointEntry(entry);
    expect(md).toContain("**Erkennungsrate:** 82.0%");
    expect(md).toContain("**Falscherkennungsrate:** 7.0%");
  });
});

// ---------------------------------------------------------------------------
// Story 19.11 — appendPatternUpdate (idempotency)
// ---------------------------------------------------------------------------

describe("appendPatternUpdate", () => {
  let tempDir: string;

  it("creates file and writes entry if file does not exist", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-pu-test-"));
    const filePath = path.join(tempDir, "pattern-updates.md");
    const entry = "## Tag-20-Checkpoint — BESTANDEN (2026-04-20)\n\nContent.";

    const written = appendPatternUpdate(filePath, entry);
    expect(written).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("Tag-20-Checkpoint");
    expect(content).toContain("BESTANDEN");
    fs.rmSync(tempDir, { recursive: true });
  });

  it("appends entry to existing file", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-pu-test-"));
    const filePath = path.join(tempDir, "pattern-updates.md");
    fs.writeFileSync(filePath, "# Pattern-Updates\n\nExisting content.\n");
    const entry = "## Tag-20-Checkpoint — BESTANDEN (2026-04-20)\n\nContent.";

    const written = appendPatternUpdate(filePath, entry, "2026-04-20");
    expect(written).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("Existing content.");
    expect(content).toContain("Tag-20-Checkpoint");
    fs.rmSync(tempDir, { recursive: true });
  });

  it("skips duplicate entry for same date (idempotency, Subtask 5.4, H1 fix)", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-pu-test-"));
    const filePath = path.join(tempDir, "pattern-updates.md");
    const entry = "## Tag-20-Checkpoint — BESTANDEN (2026-04-20)\n\nContent.";

    // Write first time
    appendPatternUpdate(filePath, entry, "2026-04-20");
    const contentBefore = fs.readFileSync(filePath, "utf-8");

    // Write second time with same date — should be skipped
    const written = appendPatternUpdate(filePath, entry, "2026-04-20");
    expect(written).toBe(false);
    const contentAfter = fs.readFileSync(filePath, "utf-8");
    expect(contentAfter).toBe(contentBefore);
    fs.rmSync(tempDir, { recursive: true });
  });

  it("allows new entry on different date (H1 fix: date-based, not global)", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-pu-test-"));
    const filePath = path.join(tempDir, "pattern-updates.md");
    const entry1 = "## Tag-20-Checkpoint — NICHT BESTANDEN (2026-04-20)\n\nFailed.";
    const entry2 = "## Tag-20-Checkpoint — BESTANDEN (2026-04-21)\n\nPassed.";

    // Write first entry (day 20, FAIL)
    const written1 = appendPatternUpdate(filePath, entry1, "2026-04-20");
    expect(written1).toBe(true);

    // Write second entry on different date (day 21, PASS) — should succeed (M2 edge-case)
    const written2 = appendPatternUpdate(filePath, entry2, "2026-04-21");
    expect(written2).toBe(true);

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("NICHT BESTANDEN (2026-04-20)");
    expect(content).toContain("BESTANDEN (2026-04-21)");
    fs.rmSync(tempDir, { recursive: true });
  });

  it("creates parent directories if needed", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-pu-test-"));
    const filePath = path.join(tempDir, "deep", "nested", "pattern-updates.md");
    const entry = "## Tag-20-Checkpoint — BESTANDEN (2026-04-20)\n\nContent.";

    const written = appendPatternUpdate(filePath, entry);
    expect(written).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    fs.rmSync(tempDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Story 19.11 — extractFailedTests
// ---------------------------------------------------------------------------

describe("extractFailedTests", () => {
  it("returns empty array when no tests field", () => {
    const result = extractFailedTests({ mqs: 70 });
    expect(result).toEqual([]);
  });

  it("returns empty array when tests is not an object", () => {
    const result = extractFailedTests({ tests: "not-an-object" } as unknown as BenchmarkData);
    expect(result).toEqual([]);
  });

  it("extracts failed tests with error messages", () => {
    const data: BenchmarkData = {
      mqs: 60,
      tests: {
        "T1.1 Login": { pass: true },
        "T2.1 Wizard": { pass: false, error: "timeout" },
        "T3.1 Search": { pass: false, error: "element not found" },
        "T4.1 Menu": { pass: true },
      },
    };
    const failed = extractFailedTests(data);
    expect(failed).toHaveLength(2);
    expect(failed[0].name).toBe("T2.1 Wizard");
    expect(failed[0].error).toBe("timeout");
    expect(failed[1].name).toBe("T3.1 Search");
  });
});

// ---------------------------------------------------------------------------
// Story 19.11 — formatCheckpointSummary
// ---------------------------------------------------------------------------

describe("formatCheckpointSummary", () => {
  it("shows positive summary when all passed (M1: fixed criteria count)", () => {
    const result: GateResult = {
      mode: "checkpoint:tag-20",
      criteria: [
        { name: "mqs", expected: ">= 66", actual: "70", pass: true },
        { name: "pass_rate", expected: "35/35", actual: "35/35 (100.0%)", pass: true },
      ],
      allPassed: true,
    };
    const summary = formatCheckpointSummary(result, { mqs: 70 });
    expect(summary).toContain("Tag-20-Checkpoint bestanden");
    // M1 fix: uses TAG_20_CRITERIA_COUNT constant instead of dynamic criteria.length
    expect(summary).toContain(`2 von ${TAG_20_CRITERIA_COUNT} Kriterien erfuellt`);
    // When MQS exceeds target, no delta shown (negative delta is not meaningful)
    expect(summary).not.toContain("Delta MQS");
  });

  it("shows delta when MQS is below target", () => {
    const result: GateResult = {
      mode: "checkpoint:tag-20",
      criteria: [
        { name: "mqs", expected: ">= 66", actual: "60", pass: false },
        { name: "pass_rate", expected: "35/35", actual: "35/35 (100.0%)", pass: true },
      ],
      allPassed: false,
    };
    const summary = formatCheckpointSummary(result, { mqs: 60 });
    expect(summary).toContain(`1 von ${TAG_20_CRITERIA_COUNT} Kriterien erfuellt`);
    expect(summary).toContain("Delta MQS: 6 Punkte");
    expect(summary).not.toContain("bestanden");
  });

  it("omits negative delta when MQS exceeds target", () => {
    const result: GateResult = {
      mode: "checkpoint:tag-20",
      criteria: [
        { name: "mqs", expected: ">= 66", actual: "70", pass: true },
        { name: "pass_rate", expected: "35/35", actual: "30/35 (85.7%)", pass: false },
      ],
      allPassed: false,
    };
    const summary = formatCheckpointSummary(result, { mqs: 70 });
    // MQS is above target (delta would be negative) — should not show delta
    expect(summary).not.toContain("Delta MQS");
  });
});

// ---------------------------------------------------------------------------
// Story 19.11 — Benchmark JSON with missing mqs field (Subtask 5.5)
// ---------------------------------------------------------------------------

describe("checkpoint with missing mqs field", () => {
  it("FAIL: checkpoint tag-20 with no mqs field → MISSING + clear failure (C2: exit-code 1 + error message)", () => {
    const data: BenchmarkData = {
      summary: { passed: 35, total: 35 },
    };
    const result = evaluateCheckpointGate(data, "tag-20");
    // M1 fix: allPassed=false maps to exit(1) in runCheckGate main
    expect(result.allPassed).toBe(false);
    // Assert MISSING error message text
    const mqsCriterion = result.criteria.find((c) => c.name === "mqs");
    expect(mqsCriterion).toBeDefined();
    expect(mqsCriterion!.actual).toBe("MISSING");
    expect(mqsCriterion!.pass).toBe(false);
    // Verify error is surfaced in formatted output
    const formatted = formatGateResult(result);
    expect(formatted).toContain("FAIL");
    expect(formatted).toContain("MISSING");
    expect(formatted).toContain("GATE CHECK FAILED");
  });

  it("FAIL: checkpoint tag-20 with no summary fields → pass_rate MISSING (C3)", () => {
    const data: BenchmarkData = {
      mqs: 70,
    };
    const result = evaluateCheckpointGate(data, "tag-20");
    // M1 fix: allPassed=false maps to exit(1) in runCheckGate main
    expect(result.allPassed).toBe(false);
    const passCriterion = result.criteria.find((c) => c.name === "pass_rate");
    expect(passCriterion).toBeDefined();
    expect(passCriterion!.actual).toContain("MISSING");
    expect(passCriterion!.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Story 19.11 — runCheckGate with checkpoint writes pattern-updates.md
// ---------------------------------------------------------------------------

describe("runCheckGate — checkpoint integration", () => {
  let tempDir: string;

  it("writes BESTANDEN entry to pattern-updates.md for passing checkpoint (C1: exit-code 0)", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cp-test-"));
    const jsonPath = path.join(tempDir, "benchmark-test.json");
    const patternPath = path.join(tempDir, "pattern-updates.md");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        mqs: 70,
        summary: { passed: 35, total: 35 },
      }),
    );
    const result = runCheckGate(
      ["node", "check-gate.ts", "--checkpoint", "tag-20", "--file", jsonPath],
      { patternUpdatesPath: patternPath },
    );
    expect(result).not.toBeNull();
    // M1 fix: allPassed=true maps to exit(0) in runCheckGate main
    expect(result!.allPassed).toBe(true);
    expect(result!.mode).toBe("checkpoint:tag-20");
    expect(result!.criteria.every((c) => c.pass)).toBe(true);

    const content = fs.readFileSync(patternPath, "utf-8");
    expect(content).toContain("BESTANDEN");
    expect(content).toContain("MQS 70");
    expect(content).toContain("Pass-Rate 35/35");
    expect(content).toContain("Epic 19 kann planmaessig weiterlaufen");
    fs.rmSync(tempDir, { recursive: true });
  });

  it("writes NICHT BESTANDEN entry with Nachsteuerungs-Optionen for failing checkpoint (C1: exit-code 1, error messages)", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cp-test-"));
    const jsonPath = path.join(tempDir, "benchmark-test.json");
    const patternPath = path.join(tempDir, "pattern-updates.md");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        mqs: 60,
        summary: { passed: 33, total: 35 },
        recognition_rate: 0.80,
        false_positive_rate: 0.06,
        tests: {
          "T1.1 Login": { pass: true },
          "T2.1 Wizard": { pass: false, error: "timeout" },
          "T3.1 Search": { pass: false, error: "not found" },
        },
      }),
    );
    const result = runCheckGate(
      ["node", "check-gate.ts", "--checkpoint", "tag-20", "--file", jsonPath],
      { patternUpdatesPath: patternPath },
    );
    expect(result).not.toBeNull();
    // M1 fix: allPassed=false maps to exit(1) in runCheckGate main
    expect(result!.allPassed).toBe(false);
    // Assert specific failed criteria messages
    const mqsCriterion = result!.criteria.find((c) => c.name === "mqs");
    expect(mqsCriterion).toBeDefined();
    expect(mqsCriterion!.pass).toBe(false);
    expect(mqsCriterion!.actual).toBe("60");
    const passCriterion = result!.criteria.find((c) => c.name === "pass_rate");
    expect(passCriterion).toBeDefined();
    expect(passCriterion!.pass).toBe(false);
    expect(passCriterion!.actual).toContain("33/35");

    const content = fs.readFileSync(patternPath, "utf-8");
    expect(content).toContain("NICHT BESTANDEN");
    expect(content).toContain("MQS 60");
    expect(content).toContain("**MQS-Delta zum Ziel:** 6 Punkte");
    expect(content).toContain("Seed-Bibliothek erweitern");
    expect(content).toContain("Fallback-Schwelle schaerfen");
    expect(content).toContain("Scope schneiden");
    expect(content).toContain("**Erkennungsrate:** 80.0%");
    expect(content).toContain("**Falscherkennungsrate:** 6.0%");
    expect(content).toContain("T2.1 Wizard");
    expect(content).toContain("T3.1 Search");
    fs.rmSync(tempDir, { recursive: true });
  });

  it("does not write duplicate entry on second run same day (idempotency, H1 fix)", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cp-test-"));
    const jsonPath = path.join(tempDir, "benchmark-test.json");
    const patternPath = path.join(tempDir, "pattern-updates.md");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        mqs: 70,
        summary: { passed: 35, total: 35 },
      }),
    );

    // First run
    runCheckGate(
      ["node", "check-gate.ts", "--checkpoint", "tag-20", "--file", jsonPath],
      { patternUpdatesPath: patternPath },
    );
    const contentAfterFirst = fs.readFileSync(patternPath, "utf-8");

    // Second run (same day) — should be skipped
    runCheckGate(
      ["node", "check-gate.ts", "--checkpoint", "tag-20", "--file", jsonPath],
      { patternUpdatesPath: patternPath },
    );
    const contentAfterSecond = fs.readFileSync(patternPath, "utf-8");

    expect(contentAfterSecond).toBe(contentAfterFirst);
    // Verify the entry is date-specific
    const today = new Date().toISOString().slice(0, 10);
    expect(contentAfterFirst).toContain(today);
    fs.rmSync(tempDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Story 19.13 — Epic-19-Abschluss-Gate
// ---------------------------------------------------------------------------

describe("Story 19.13 — Epic-19 Gate Constants", () => {
  it("EPIC_19_WALL_CLOCK_REDUCTION_MIN is 0.50", () => {
    expect(EPIC_19_WALL_CLOCK_REDUCTION_MIN).toBe(0.50);
  });

  it("EPIC_19_TOOL_OVERHEAD_MAX is 3000", () => {
    expect(EPIC_19_TOOL_OVERHEAD_MAX).toBe(3000);
  });

  it("EPIC_19_CRITERIA_COUNT is 5", () => {
    expect(EPIC_19_CRITERIA_COUNT).toBe(5);
  });
});

describe("Story 19.13 — evaluateEpicGate with all five criteria", () => {
  // Subtask 6.1: all five criteria pass → exit 0
  it("PASS: --epic 19 with all five criteria met → allPassed=true", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.92,
      wall_clock_ms: 400,
    };
    const opts: EpicGateOptions = { baselineWallClockMs: 1622, toolOverheadTokens: 500 };
    const result = evaluateEpicGate(data, 19, opts);
    expect(result.allPassed).toBe(true);
    expect(result.criteria).toHaveLength(5);
    expect(result.criteria.every((c) => c.pass)).toBe(true);
  });

  // Subtask 6.2: MQS 65 (under 70) → exit 1, only MQS red
  it("FAIL: --epic 19 with MQS 65 → only MQS fails", () => {
    const data: BenchmarkData = {
      mqs: 65,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.92,
      wall_clock_ms: 400,
    };
    const opts: EpicGateOptions = { baselineWallClockMs: 1622, toolOverheadTokens: 500 };
    const result = evaluateEpicGate(data, 19, opts);
    expect(result.allPassed).toBe(false);
    const mqsCriterion = result.criteria.find((c) => c.name === "MQS");
    expect(mqsCriterion?.pass).toBe(false);
    // All other criteria should pass
    const others = result.criteria.filter((c) => c.name !== "MQS");
    expect(others.every((c) => c.pass)).toBe(true);
  });

  // Subtask 6.3: Wall-Clock only 30% kuerzer → exit 1, Wall-Clock red
  it("FAIL: --epic 19 with Wall-Clock only 30% shorter → only Wall-Clock fails", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.92,
      wall_clock_ms: 1135, // ~30% kuerzer als 1622
    };
    const opts: EpicGateOptions = { baselineWallClockMs: 1622, toolOverheadTokens: 500 };
    const result = evaluateEpicGate(data, 19, opts);
    expect(result.allPassed).toBe(false);
    const wallClock = result.criteria.find((c) => c.name === "Wall-Clock");
    expect(wallClock?.pass).toBe(false);
    expect(wallClock?.actual).toContain("1135ms");
    // All other criteria should pass
    const others = result.criteria.filter((c) => c.name !== "Wall-Clock");
    expect(others.every((c) => c.pass)).toBe(true);
  });

  // Subtask 6.4: Tool-Overhead 3500 → exit 1, Overhead red
  it("FAIL: --epic 19 with Tool-Overhead 3500 → only Tool-Overhead fails", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.92,
      wall_clock_ms: 400,
    };
    const opts: EpicGateOptions = { baselineWallClockMs: 1622, toolOverheadTokens: 3500 };
    const result = evaluateEpicGate(data, 19, opts);
    expect(result.allPassed).toBe(false);
    const overhead = result.criteria.find((c) => c.name === "Tool-Overhead");
    expect(overhead?.pass).toBe(false);
    expect(overhead?.actual).toContain("3500");
    // All other criteria should pass
    const others = result.criteria.filter((c) => c.name !== "Tool-Overhead");
    expect(others.every((c) => c.pass)).toBe(true);
  });

  // Subtask 6.5: four pass, one fails → exit 1, summary "4 von 5"
  it("FAIL: four passed, one failed → formatGateResult shows '4 von 5'", () => {
    const data: BenchmarkData = {
      mqs: 65, // only this fails
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.92,
      wall_clock_ms: 400,
    };
    const opts: EpicGateOptions = { baselineWallClockMs: 1622, toolOverheadTokens: 500 };
    const result = evaluateEpicGate(data, 19, opts);
    expect(result.allPassed).toBe(false);
    const passedCount = result.criteria.filter((c) => c.pass).length;
    expect(passedCount).toBe(4);
    const output = formatGateResult(result);
    expect(output).toContain("4 von 5");
    expect(output).toContain("NICHT BESTANDEN");
  });

  // Subtask 6.7: missing baseline → clear error, criterion fails
  it("FAIL: missing baseline → baselineError propagates as criterion failure", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.92,
      wall_clock_ms: 400,
    };
    const opts: EpicGateOptions = {
      baselineError: "Baseline-JSON nicht gefunden — Wall-Clock-Vergleich nicht moeglich",
      toolOverheadTokens: 500,
    };
    const result = evaluateEpicGate(data, 19, opts);
    expect(result.allPassed).toBe(false);
    const wallClock = result.criteria.find((c) => c.name === "Wall-Clock");
    expect(wallClock?.pass).toBe(false);
    expect(wallClock?.actual).toContain("Baseline-JSON nicht gefunden");
  });

  it("wall_ms fallback: uses wall_ms if wall_clock_ms is undefined", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.92,
      wall_ms: 400,
    };
    const opts: EpicGateOptions = { baselineWallClockMs: 1622, toolOverheadTokens: 500 };
    const result = evaluateEpicGate(data, 19, opts);
    expect(result.allPassed).toBe(true);
    const wallClock = result.criteria.find((c) => c.name === "Wall-Clock");
    expect(wallClock?.actual).toContain("400ms");
  });

  it("tool_definition_tokens from BenchmarkData used as fallback", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.92,
      wall_clock_ms: 400,
      tool_definition_tokens: 1200,
    };
    // No toolOverheadTokens in options — should read from data
    const opts: EpicGateOptions = { baselineWallClockMs: 1622 };
    const result = evaluateEpicGate(data, 19, opts);
    expect(result.allPassed).toBe(true);
    const overhead = result.criteria.find((c) => c.name === "Tool-Overhead");
    expect(overhead?.actual).toContain("1200");
    expect(overhead?.pass).toBe(true);
  });
});

describe("Story 19.13 — formatGateResult for Epic-19", () => {
  it("shows release-ready message on pass (AC-5)", () => {
    const result: GateResult = {
      mode: "epic:19",
      criteria: [
        { name: "MQS", expected: ">= 70", actual: "75", pass: true },
        { name: "Erkennungs-Rate", expected: ">= 85%", actual: "92.0%", pass: true },
        { name: "Wall-Clock", expected: ">= 50% kuerzer", actual: "400ms (75.3% kuerzer)", pass: true },
        { name: "Pass-Rate", expected: "35/35 (100%)", actual: "35/35 (100.0%)", pass: true },
        { name: "Tool-Overhead", expected: "< 3000 Tokens", actual: "500 Tokens", pass: true },
      ],
      allPassed: true,
    };
    const output = formatGateResult(result);
    expect(output).toContain("BESTANDEN");
    expect(output).toContain("5 von 5");
    expect(output).toContain("Voraussetzung fuer das Taggen einer neuen SilbercueChrome-Release-Version");
  });

  it("shows not-ready message on fail (AC-5)", () => {
    const result: GateResult = {
      mode: "epic:19",
      criteria: [
        { name: "MQS", expected: ">= 70", actual: "65", pass: false },
        { name: "Erkennungs-Rate", expected: ">= 85%", actual: "92.0%", pass: true },
        { name: "Wall-Clock", expected: ">= 50% kuerzer", actual: "400ms (75.3% kuerzer)", pass: true },
        { name: "Pass-Rate", expected: "35/35 (100%)", actual: "35/35 (100.0%)", pass: true },
        { name: "Tool-Overhead", expected: "< 3000 Tokens", actual: "500 Tokens", pass: true },
      ],
      allPassed: false,
    };
    const output = formatGateResult(result);
    expect(output).toContain("NICHT BESTANDEN");
    expect(output).toContain("4 von 5");
    expect(output).toContain("kein Release-Tag moeglich");
  });

  it("shows Nachsteuerungs-Hinweise for each failed criterion (AC-3)", () => {
    const result: GateResult = {
      mode: "epic:19",
      criteria: [
        { name: "MQS", expected: ">= 70", actual: "65", pass: false },
        { name: "Erkennungs-Rate", expected: ">= 85%", actual: "80.0%", pass: false },
        { name: "Wall-Clock", expected: ">= 50% kuerzer", actual: "1200ms (26.0% kuerzer)", pass: false },
        { name: "Pass-Rate", expected: "35/35 (100%)", actual: "33/35 (94.3%)", pass: false },
        { name: "Tool-Overhead", expected: "< 3000 Tokens", actual: "3500 Tokens", pass: false },
      ],
      allPassed: false,
    };
    const output = formatGateResult(result);
    expect(output).toContain("Nachsteuerungs-Hinweise");
    expect(output).toContain("MQS zu niedrig");
    expect(output).toContain("Erkennungs-Rate zu niedrig");
    expect(output).toContain("Wall-Clock zu langsam");
    expect(output).toContain("fehlgeschlagene Tests debuggen");
    expect(output).toContain("Tool-Descriptions kuerzen");
  });
});

describe("Story 19.13 — Logbuch-Eintraege (AC-4)", () => {
  // Subtask 6.6: Pass → entries in pattern-updates.md and schema-migrations.md
  it("writes entries to both pattern-updates.md and schema-migrations.md on pass", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-epic19-test-"));
    const jsonPath = path.join(tempDir, "benchmark-test.json");
    const patternPath = path.join(tempDir, "pattern-updates.md");
    const schemaPath = path.join(tempDir, "schema-migrations.md");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        mqs: 75,
        summary: { passed: 35, total: 35 },
        recognition_rate: 0.92,
        wall_clock_ms: 500,
      }),
    );
    const result = runCheckGate(
      ["node", "check-gate.ts", "--epic", "19", "--file", jsonPath],
      {
        patternUpdatesPath: patternPath,
        schemaMigrationsPath: schemaPath,
        baselineWallClockMs: 1622,
        toolOverheadTokens: 500,
      },
    );
    expect(result).not.toBeNull();
    expect(result!.allPassed).toBe(true);

    // pattern-updates.md written
    expect(fs.existsSync(patternPath)).toBe(true);
    const patternContent = fs.readFileSync(patternPath, "utf-8");
    expect(patternContent).toContain("Epic-19-Abschluss-Gate");
    expect(patternContent).toContain("BESTANDEN");
    expect(patternContent).toContain("MQS: 75");
    expect(patternContent).toContain("Release-Tag");

    // schema-migrations.md written
    expect(fs.existsSync(schemaPath)).toBe(true);
    const schemaContent = fs.readFileSync(schemaPath, "utf-8");
    expect(schemaContent).toContain("Epic-19-Abschluss-Gate");
    expect(schemaContent).toContain("BESTANDEN");
    expect(schemaContent).toContain("Release-Tag kann gesetzt werden");
    expect(schemaContent).toContain("0.5.0"); // version from package.json

    fs.rmSync(tempDir, { recursive: true });
  });

  it("does NOT write logbook entries when gate fails", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-epic19-test-"));
    const jsonPath = path.join(tempDir, "benchmark-test.json");
    const patternPath = path.join(tempDir, "pattern-updates.md");
    const schemaPath = path.join(tempDir, "schema-migrations.md");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        mqs: 65, // fails
        summary: { passed: 35, total: 35 },
        recognition_rate: 0.92,
        wall_clock_ms: 500,
      }),
    );
    const result = runCheckGate(
      ["node", "check-gate.ts", "--epic", "19", "--file", jsonPath],
      {
        patternUpdatesPath: patternPath,
        schemaMigrationsPath: schemaPath,
        baselineWallClockMs: 1622,
        toolOverheadTokens: 500,
      },
    );
    expect(result).not.toBeNull();
    expect(result!.allPassed).toBe(false);

    // Neither file should exist (not created on failure)
    expect(fs.existsSync(patternPath)).toBe(false);
    expect(fs.existsSync(schemaPath)).toBe(false);

    fs.rmSync(tempDir, { recursive: true });
  });

  // Subtask 6.8: idempotency — second run same day produces no duplicate
  it("does NOT write duplicate entries on second run same day (idempotency)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-epic19-test-"));
    const jsonPath = path.join(tempDir, "benchmark-test.json");
    const patternPath = path.join(tempDir, "pattern-updates.md");
    const schemaPath = path.join(tempDir, "schema-migrations.md");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        mqs: 75,
        summary: { passed: 35, total: 35 },
        recognition_rate: 0.92,
        wall_clock_ms: 500,
      }),
    );
    const opts = {
      patternUpdatesPath: patternPath,
      schemaMigrationsPath: schemaPath,
      baselineWallClockMs: 1622,
      toolOverheadTokens: 500,
    };

    // First run
    runCheckGate(["node", "check-gate.ts", "--epic", "19", "--file", jsonPath], opts);
    const patternAfterFirst = fs.readFileSync(patternPath, "utf-8");
    const schemaAfterFirst = fs.readFileSync(schemaPath, "utf-8");

    // Second run
    runCheckGate(["node", "check-gate.ts", "--epic", "19", "--file", jsonPath], opts);
    const patternAfterSecond = fs.readFileSync(patternPath, "utf-8");
    const schemaAfterSecond = fs.readFileSync(schemaPath, "utf-8");

    // Content should be identical (no duplicate)
    expect(patternAfterSecond).toBe(patternAfterFirst);
    expect(schemaAfterSecond).toBe(schemaAfterFirst);

    fs.rmSync(tempDir, { recursive: true });
  });
});

describe("Story 19.13 — loadBaselineWallClock", () => {
  it("returns wallClockMs from a valid baseline JSON with wall_ms", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-baseline-test-"));
    const baselineDir = path.join(tempDir, "test-hardest");
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.writeFileSync(
      path.join(baselineDir, "ops-run-plan-baseline-v0.5.0.json"),
      JSON.stringify({ wall_ms: 1622 }),
    );
    const result = loadBaselineWallClock(tempDir);
    expect("wallClockMs" in result).toBe(true);
    if ("wallClockMs" in result) {
      expect(result.wallClockMs).toBe(1622);
    }
    fs.rmSync(tempDir, { recursive: true });
  });

  it("returns wallClockMs from baseline with wall_clock_ms", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-baseline-test-"));
    const baselineDir = path.join(tempDir, "test-hardest");
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.writeFileSync(
      path.join(baselineDir, "ops-run-plan-baseline-v0.5.0.json"),
      JSON.stringify({ wall_clock_ms: 491000 }),
    );
    const result = loadBaselineWallClock(tempDir);
    expect("wallClockMs" in result).toBe(true);
    if ("wallClockMs" in result) {
      expect(result.wallClockMs).toBe(491000);
    }
    fs.rmSync(tempDir, { recursive: true });
  });

  // Subtask 6.7: missing baseline JSON → clear error
  it("returns error when baseline JSON does not exist", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-baseline-test-"));
    const result = loadBaselineWallClock(tempDir);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Baseline-JSON nicht gefunden");
    }
    fs.rmSync(tempDir, { recursive: true });
  });

  it("returns error when baseline JSON has no wall_clock_ms/wall_ms field", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-baseline-test-"));
    const baselineDir = path.join(tempDir, "test-hardest");
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.writeFileSync(
      path.join(baselineDir, "ops-run-plan-baseline-v0.5.0.json"),
      JSON.stringify({ response_bytes: 6410 }),
    );
    const result = loadBaselineWallClock(tempDir);
    expect("error" in result).toBe(true);
    fs.rmSync(tempDir, { recursive: true });
  });
});

describe("Story 19.13 — appendSchemaMigration", () => {
  it("creates file if it does not exist", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-schema-test-"));
    const filePath = path.join(tempDir, "schema-migrations.md");
    const entry = "## Epic-19-Abschluss-Gate — BESTANDEN (2026-04-12)\n\nContent.";
    const written = appendSchemaMigration(filePath, entry, "2026-04-12");
    expect(written).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("Schema-Migrations");
    expect(content).toContain("Epic-19-Abschluss-Gate");
    fs.rmSync(tempDir, { recursive: true });
  });

  it("skips duplicate for same date (idempotency)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-schema-test-"));
    const filePath = path.join(tempDir, "schema-migrations.md");
    const entry = "## Epic-19-Abschluss-Gate — BESTANDEN (2026-04-12)\n\nContent.";
    appendSchemaMigration(filePath, entry, "2026-04-12");
    const contentBefore = fs.readFileSync(filePath, "utf-8");
    const written = appendSchemaMigration(filePath, entry, "2026-04-12");
    expect(written).toBe(false);
    const contentAfter = fs.readFileSync(filePath, "utf-8");
    expect(contentAfter).toBe(contentBefore);
    fs.rmSync(tempDir, { recursive: true });
  });
});

describe("Story 19.13 — buildEpic19PatternEntry", () => {
  it("contains all five Ist-Werte and benchmark file name", () => {
    const values: Epic19GateValues = {
      mqs: 75,
      recognitionRate: "92.0%",
      wallClockMs: 500,
      wallClockReduction: "69.2%",
      passCount: 35,
      passTotal: 35,
      toolOverheadTokens: 500,
      baselineMs: 1622,
    };
    const md = buildEpic19PatternEntry("2026-04-12", values, "benchmark-operator-2026-04-12.json");
    expect(md).toContain("Epic-19-Abschluss-Gate — BESTANDEN");
    expect(md).toContain("MQS: 75");
    expect(md).toContain("Erkennungs-Rate: 92.0%");
    expect(md).toContain("500ms");
    expect(md).toContain("69.2%");
    expect(md).toContain("35/35");
    expect(md).toContain("500 Tokens");
    expect(md).toContain("benchmark-operator-2026-04-12.json");
    expect(md).toContain("Voraussetzung fuer Release-Tag erfuellt");
  });
});

describe("Story 19.13 — buildEpic19SchemaMigrationEntry", () => {
  it("contains version from package.json and all five Ist-Werte", () => {
    const values: Epic19GateValues = {
      mqs: 75,
      recognitionRate: "92.0%",
      wallClockMs: 500,
      wallClockReduction: "69.2%",
      passCount: 35,
      passTotal: 35,
      toolOverheadTokens: 500,
      baselineMs: 1622,
    };
    const md = buildEpic19SchemaMigrationEntry("2026-04-12", "0.6.0", values);
    expect(md).toContain("Epic-19-Abschluss-Gate — BESTANDEN");
    expect(md).toContain("0.6.0");
    expect(md).toContain("MQS: 75");
    expect(md).toContain("Release-Tag kann gesetzt werden");
  });
});

describe("Story 19.13 — printHelp shows Epic-19 mode", () => {
  it("shows five Epic-19 criteria in help output", () => {
    const help = printHelp();
    expect(help).toContain("Epic-19 Gate Criteria");
    expect(help).toContain("MQS");
    expect(help).toContain("Erkennungs-Rate");
    expect(help).toContain("Wall-Clock");
    expect(help).toContain("Pass-Rate");
    expect(help).toContain("Tool-Overhead");
  });
});

// ---------------------------------------------------------------------------
// M2 fix: Edge-case tests for baseline/overhead boundary conditions
// ---------------------------------------------------------------------------

describe("Story 19.13 — Edge Cases (M2)", () => {
  it("loadBaselineWallClock rejects baseline with wall_clock_ms = 0 (division by zero guard)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-edge-test-"));
    const baselineDir = path.join(tempDir, "test-hardest");
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.writeFileSync(
      path.join(baselineDir, "ops-run-plan-baseline-v0.5.0.json"),
      JSON.stringify({ wall_clock_ms: 0 }),
    );
    const result = loadBaselineWallClock(tempDir);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("groesser als 0");
    }
    fs.rmSync(tempDir, { recursive: true });
  });

  it("loadBaselineWallClock rejects negative wall_clock_ms", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-edge-test-"));
    const baselineDir = path.join(tempDir, "test-hardest");
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.writeFileSync(
      path.join(baselineDir, "ops-run-plan-baseline-v0.5.0.json"),
      JSON.stringify({ wall_clock_ms: -500 }),
    );
    const result = loadBaselineWallClock(tempDir);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("groesser als 0");
    }
    fs.rmSync(tempDir, { recursive: true });
  });

  it("measureToolOverhead returns real registry measurement (primary path)", () => {
    // When the build exists, measureToolOverhead uses the ToolRegistry directly
    // rather than falling back to JSON fields
    const data: BenchmarkData = { tool_definition_tokens: -100 };
    const result = measureToolOverhead(data);
    // Primary path succeeds because build/registry.js is available in test env
    if ("tokens" in result) {
      // Real measurement — should be a reasonable positive number
      expect(result.tokens).toBeGreaterThan(0);
      expect(result.tokens).toBeLessThan(3000);
    } else {
      // Fallback path — negative JSON value should produce error
      expect(result.error).toContain("-100");
    }
  });

  it("measureToolOverhead with valid JSON fallback returns tokens when present", () => {
    // This tests the fallback path — when tool_definition_tokens is in the JSON.
    // In the test env, the primary registry path will likely succeed first,
    // so we verify the contract: either real measurement or JSON fallback.
    const data: BenchmarkData = { tool_definition_tokens: 1500 };
    const result = measureToolOverhead(data);
    expect("tokens" in result).toBe(true);
    if ("tokens" in result) {
      expect(result.tokens).toBeGreaterThan(0);
    }
  });

  it("evaluateEpicGate handles toolOverheadTokens = 0 correctly (passes, 0 < 3000)", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.92,
      wall_clock_ms: 400,
    };
    const opts: EpicGateOptions = { baselineWallClockMs: 1622, toolOverheadTokens: 0 };
    const result = evaluateEpicGate(data, 19, opts);
    const overhead = result.criteria.find((c) => c.name === "Tool-Overhead");
    expect(overhead?.pass).toBe(true);
    expect(overhead?.actual).toContain("0 Tokens");
  });

  it("evaluateEpicGate with baselineWallClockMs = 0 via options produces NaN — guard should be at loadBaselineWallClock level", () => {
    // This test documents that the guard against 0 baseline is in loadBaselineWallClock,
    // not in evaluateEpicGate. If someone passes 0 directly via options, the reduction
    // calculation produces -Infinity or NaN. The H2 fix prevents this at the load level.
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.92,
      wall_clock_ms: 400,
    };
    const opts: EpicGateOptions = { baselineWallClockMs: 0, toolOverheadTokens: 500 };
    const result = evaluateEpicGate(data, 19, opts);
    const wallClock = result.criteria.find((c) => c.name === "Wall-Clock");
    // With baseline 0, reduction = (0-400)/0 = -Infinity → fails
    expect(wallClock?.pass).toBe(false);
  });
});
