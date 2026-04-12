/**
 * Integration tests for scripts/validate-card.ts
 *
 * Tests schema validation, production-site checking, and pipeline orchestration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import {
  parseValidateCardArgs,
  validateSchema,
  validateBenchmark,
  validateProductionSites,
  validateGateCheck,
  runValidationPipeline,
  formatValidationResult,
  printValidateCardHelp,
} from "./validate-card.js";

// Short timeout for benchmark/gate child processes in tests (no Chrome/server running)
process.env.VALIDATE_CARD_BENCHMARK_TIMEOUT_MS = "3000";
process.env.VALIDATE_CARD_GATE_TIMEOUT_MS = "3000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid card YAML content (snake_case). */
function validCardYaml(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test-card",
    name: "Test Card",
    description: "A test card for validation",
    structure_signature: [
      { signal: "role:form", weight: 0.8 },
      { signal: "type:submit", weight: 0.5 },
    ],
    counter_signals: [{ signal: "role:search", level: "strong" }],
    parameters: {
      username: { type: "string", description: "The username", required: true },
    },
    execution_sequence: [
      { action: "fill", target: "[name=username]", param_ref: "username" },
    ],
    schema_version: "1.0",
    source: "seed",
    version: "1.0.0",
    author: "Test Author",
    harvest_count: 0,
    test_cases: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

describe("parseValidateCardArgs", () => {
  it("returns help mode with --help", () => {
    const result = parseValidateCardArgs(["node", "validate-card.ts", "--help"]);
    expect(result.mode).toBe("help");
  });

  it("returns validate mode with card path", () => {
    const result = parseValidateCardArgs(["node", "validate-card.ts", "cards/login-form.yaml"]);
    expect(result.mode).toBe("validate");
    expect(result.cardPath).toBe("cards/login-form.yaml");
  });

  it("recognizes --schema-only flag", () => {
    const result = parseValidateCardArgs(["node", "validate-card.ts", "--schema-only", "cards/login-form.yaml"]);
    expect(result.schemaOnly).toBe(true);
    expect(result.cardPath).toBe("cards/login-form.yaml");
  });

  it("returns help when no card path provided", () => {
    const result = parseValidateCardArgs(["node", "validate-card.ts"]);
    expect(result.mode).toBe("help");
  });
});

// ---------------------------------------------------------------------------
// Schema Validation (AC-1, Subtask 6.2, 6.3)
// ---------------------------------------------------------------------------

describe("validateSchema", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-card-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("PASS: valid card passes schema check (Subtask 6.2)", () => {
    const filePath = path.join(tempDir, "test-card.yaml");
    fs.writeFileSync(filePath, yaml.dump(validCardYaml()));
    return validateSchema(filePath).then((result) => {
      expect(result.status).toBe("pass");
      expect(result.detail).toContain("test-card");
    });
  });

  it("FAIL: card with URL in signal → schema rejection (Subtask 6.3)", () => {
    const filePath = path.join(tempDir, "bad-card.yaml");
    fs.writeFileSync(
      filePath,
      yaml.dump(
        validCardYaml({
          id: "bad-card",
          structure_signature: [
            { signal: "https://example.com/login", weight: 0.8 },
            { signal: "role:form", weight: 0.5 },
          ],
        }),
      ),
    );
    return validateSchema(filePath).then((result) => {
      expect(result.status).toBe("fail");
    });
  });

  it("FAIL: card with missing required fields", () => {
    const filePath = path.join(tempDir, "incomplete-card.yaml");
    fs.writeFileSync(filePath, yaml.dump({ id: "incomplete-card", name: "Incomplete" }));
    return validateSchema(filePath).then((result) => {
      expect(result.status).toBe("fail");
    });
  });

  it("FAIL: non-existent file", () => {
    return validateSchema("/nonexistent/path/card.yaml").then((result) => {
      expect(result.status).toBe("fail");
    });
  });
});

// ---------------------------------------------------------------------------
// Benchmark + Gate Steps — C2 fix: must fail, not skip (M2 fix: verifiable)
// ---------------------------------------------------------------------------

describe("validateBenchmark", () => {
  it("FAIL: returns fail (not skip) when MCP server not running", async () => {
    const result = await validateBenchmark("cards/login-form.yaml");
    expect(result.status).toBe("fail");
    expect(result.name).toBe("Benchmark-Lauf");
    // Must not be skip — C2 fix ensures real child-process attempt
    expect(result.status).not.toBe("skip");
  }, 10_000);
});

describe("validateGateCheck", () => {
  it("FAIL: returns fail (not skip) when no benchmark JSON available", async () => {
    const result = await validateGateCheck();
    expect(result.status).toBe("fail");
    expect(result.name).toBe("Gate-Check");
    expect(result.status).not.toBe("skip");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Production Sites Validation (AC-3, Subtask 6.4)
// ---------------------------------------------------------------------------

describe("validateProductionSites", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-card-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("FAIL: card without test_cases (Subtask 6.4, H3 fix)", () => {
    const filePath = path.join(tempDir, "test-card.yaml");
    fs.writeFileSync(filePath, yaml.dump(validCardYaml()));
    return validateProductionSites(filePath).then((result) => {
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("Keine test_cases");
    });
  });

  it("FAIL: card with fewer than 3 test_cases", () => {
    const filePath = path.join(tempDir, "test-card.yaml");
    fs.writeFileSync(
      filePath,
      yaml.dump(
        validCardYaml({
          test_cases: ["https://example.com/login", "https://other.com/login"],
        }),
      ),
    );
    return validateProductionSites(filePath).then((result) => {
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("2/3");
    });
  });

  it("PASS: card with 3 test_cases from different domains", () => {
    const filePath = path.join(tempDir, "test-card.yaml");
    fs.writeFileSync(
      filePath,
      yaml.dump(
        validCardYaml({
          test_cases: [
            "https://example.com/login",
            "https://other.com/login",
            "https://third.org/login",
          ],
        }),
      ),
    );
    return validateProductionSites(filePath).then((result) => {
      expect(result.status).toBe("pass");
      expect(result.detail).toContain("3 test_cases");
    });
  });

  it("FAIL: card with invalid URL in test_cases", () => {
    const filePath = path.join(tempDir, "test-card.yaml");
    fs.writeFileSync(
      filePath,
      yaml.dump(
        validCardYaml({
          test_cases: [
            "https://example.com/login",
            "not-a-url",
            "https://third.org/login",
          ],
        }),
      ),
    );
    return validateProductionSites(filePath).then((result) => {
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("Ungueltige URLs");
    });
  });

  it("FAIL: card with 3 test_cases but same domain (H3 fix)", () => {
    const filePath = path.join(tempDir, "test-card.yaml");
    fs.writeFileSync(
      filePath,
      yaml.dump(
        validCardYaml({
          test_cases: [
            "https://example.com/page1",
            "https://example.com/page2",
            "https://example.com/page3",
          ],
        }),
      ),
    );
    return validateProductionSites(filePath).then((result) => {
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("1 unterschiedliche");
    });
  });
});

// ---------------------------------------------------------------------------
// Pipeline Orchestration
// ---------------------------------------------------------------------------

describe("runValidationPipeline", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-card-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("schema-only mode stops after schema check", async () => {
    const filePath = path.join(tempDir, "test-card.yaml");
    fs.writeFileSync(filePath, yaml.dump(validCardYaml()));
    const result = await runValidationPipeline(filePath, true);
    expect(result.allPassed).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].name).toBe("Schema-Check");
  });

  it("full pipeline runs all four steps on valid card and fails when server not running", async () => {
    const filePath = path.join(tempDir, "test-card.yaml");
    fs.writeFileSync(filePath, yaml.dump(validCardYaml()));
    const result = await runValidationPipeline(filePath, false);
    expect(result.steps).toHaveLength(4);
    expect(result.steps[0].name).toBe("Schema-Check");
    expect(result.steps[1].name).toBe("Benchmark-Lauf");
    expect(result.steps[2].name).toBe("Produktionsseiten-Test");
    expect(result.steps[3].name).toBe("Gate-Check");
    // Without a running MCP server + Chrome, benchmark and gate MUST fail (not skip).
    // Schema passes, but overall pipeline must fail because non-pass steps block (C3/H5 fix).
    expect(result.allPassed).toBe(false);
    // Verify no step has "skip" status — C2 fix ensures real child-process attempts
    const skipSteps = result.steps.filter((s) => s.status === "skip");
    expect(skipSteps).toHaveLength(0);
  }, 30_000);

  it("pipeline aborts early on schema failure", async () => {
    const filePath = path.join(tempDir, "test-card.yaml");
    fs.writeFileSync(filePath, yaml.dump({ id: "test-card", name: "Bad" }));
    const result = await runValidationPipeline(filePath, false);
    expect(result.allPassed).toBe(false);
    expect(result.steps).toHaveLength(1); // Only schema step
    expect(result.steps[0].status).toBe("fail");
  });

  it("pipeline allPassed=false when any step is not 'pass' (C3/H5 fix)", async () => {
    const filePath = path.join(tempDir, "test-card.yaml");
    // Valid card but without test_cases → production step will fail, not warn
    fs.writeFileSync(filePath, yaml.dump(validCardYaml()));
    const result = await runValidationPipeline(filePath, false);
    expect(result.allPassed).toBe(false);
    // At least one step must be 'fail' (not 'skip' or 'warn')
    const failSteps = result.steps.filter((s) => s.status === "fail");
    expect(failSteps.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Output Formatting
// ---------------------------------------------------------------------------

describe("formatValidationResult", () => {
  it("formats passed result", () => {
    const output = formatValidationResult({
      cardPath: "cards/test.yaml",
      steps: [{ name: "Schema-Check", status: "pass", detail: "OK" }],
      allPassed: true,
    });
    expect(output).toContain("VALIDATION PASSED");
    expect(output).toContain("cards/test.yaml");
  });

  it("formats failed result", () => {
    const output = formatValidationResult({
      cardPath: "cards/test.yaml",
      steps: [{ name: "Schema-Check", status: "fail", detail: "Error" }],
      allPassed: false,
    });
    expect(output).toContain("VALIDATION FAILED");
  });
});

describe("printValidateCardHelp", () => {
  it("contains usage information", () => {
    const help = printValidateCardHelp();
    expect(help).toContain("validate-card");
    expect(help).toContain("--schema-only");
    expect(help).toContain("Schema-Check");
  });
});

// ---------------------------------------------------------------------------
// Real Seed Cards (Integration with actual cards/)
// ---------------------------------------------------------------------------

describe("Real Seed Cards — Schema Validation", () => {
  const cardsDir = path.resolve(__dirname, "..", "cards");

  it("login-form.yaml passes schema validation", async () => {
    const result = await validateSchema(path.join(cardsDir, "login-form.yaml"));
    expect(result.status).toBe("pass");
  });

  it("search-result-list.yaml passes schema validation", async () => {
    const result = await validateSchema(path.join(cardsDir, "search-result-list.yaml"));
    expect(result.status).toBe("pass");
  });

  it("article-reader.yaml passes schema validation", async () => {
    const result = await validateSchema(path.join(cardsDir, "article-reader.yaml"));
    expect(result.status).toBe("pass");
  });
});
