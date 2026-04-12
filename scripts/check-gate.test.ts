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
  printHelp,
  runCheckGate,
  RECOGNITION_RATE_MIN,
  FALSE_POSITIVE_RATE_MAX,
  TAG_20_MQS_MIN,
  TAG_20_PASS_COUNT,
  EPIC_19_MQS_MIN,
  EPIC_19_PASS_COUNT,
  type BenchmarkData,
  type GateResult,
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
  it("PASS: epic 19 all criteria met (Subtask 5.7)", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.90,
      false_positive_rate: 0.02,
      wall_clock_ms: 15000,
    };
    const result = evaluateEpicGate(data, 19);
    expect(result.allPassed).toBe(true);
    expect(result.mode).toBe("epic:19");
    expect(result.criteria.length).toBeGreaterThanOrEqual(5);
  });

  it("FAIL: epic 19 missing MQS", () => {
    const data: BenchmarkData = {
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.90,
      false_positive_rate: 0.02,
      wall_clock_ms: 15000,
    };
    const result = evaluateEpicGate(data, 19);
    expect(result.allPassed).toBe(false);
  });

  it("FAIL: epic 19 MQS too low", () => {
    const data: BenchmarkData = {
      mqs: 65,
      summary: { passed: 35, total: 35 },
      recognition_rate: 0.90,
      false_positive_rate: 0.02,
      wall_clock_ms: 15000,
    };
    const result = evaluateEpicGate(data, 19);
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
      wall_clock_ms: 15000,
    };
    const result = evaluateEpicGate(data, 19);
    expect(result.allPassed).toBe(true);
  });

  it("FAIL: epic 19 with 35/100 → pass_count met but rate not 100% (H6 fix)", () => {
    const data: BenchmarkData = {
      mqs: 75,
      summary: { passed: 35, total: 100 },
      recognition_rate: 0.90,
      false_positive_rate: 0.02,
      wall_clock_ms: 15000,
    };
    const result = evaluateEpicGate(data, 19);
    expect(result.allPassed).toBe(false);
    const rateCriterion = result.criteria.find((c) => c.name === "pass_rate");
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
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        mqs: 70,
        summary: { passed: 35, total: 35 },
      }),
    );
    const result = runCheckGate(["node", "check-gate.ts", "--checkpoint", "tag-20", "--file", jsonPath]);
    expect(result).not.toBeNull();
    expect(result!.allPassed).toBe(true);
    expect(result!.mode).toBe("checkpoint:tag-20");
    fs.rmSync(tempDir, { recursive: true });
  });

  it("runs epic mode via --file and --epic", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cli-test-"));
    const jsonPath = path.join(tempDir, "benchmark-test.json");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        mqs: 75,
        summary: { passed: 35, total: 35 },
        recognition_rate: 0.90,
        false_positive_rate: 0.02,
        wall_clock_ms: 15000,
      }),
    );
    const result = runCheckGate(["node", "check-gate.ts", "--epic", "19", "--file", jsonPath]);
    expect(result).not.toBeNull();
    expect(result!.allPassed).toBe(true);
    expect(result!.mode).toBe("epic:19");
    fs.rmSync(tempDir, { recursive: true });
  });
});
