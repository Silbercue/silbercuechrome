#!/usr/bin/env tsx
/**
 * validate-card.ts — Validation-Pipeline fuer Seed-Karten.
 *
 * Prueft eine Karten-YAML in vier Stufen:
 *   1. Schema-Check (Zod, src/cards/card-schema.ts)
 *   2. Benchmark-Lauf (--operator-mode, optional — erfordert laufenden Server)
 *   3. Produktionsseiten-Test (URLs aus test_cases — Platzhalter, manuell)
 *   4. Gate-Check (scripts/check-gate.ts)
 *
 * Usage:
 *   tsx scripts/validate-card.ts cards/login-form.yaml
 *   tsx scripts/validate-card.ts --schema-only cards/login-form.yaml
 *   tsx scripts/validate-card.ts --help
 *
 * Exit-Codes:
 *   0 — Alle Schritte bestanden (oder --schema-only und Schema OK)
 *   1 — Mindestens ein Schritt fehlgeschlagen
 *
 * Invariante 5: keine Magic Numbers. Gate-Schwellen werden via check-gate.ts geprueft (Step 4).
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationStepResult {
  name: string;
  status: "pass" | "fail" | "skip" | "warn";
  detail: string;
}

export interface ValidationResult {
  cardPath: string;
  steps: ValidationStepResult[];
  allPassed: boolean;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface ValidateCardArgs {
  mode: "validate" | "help";
  cardPath?: string;
  schemaOnly: boolean;
}

export function parseValidateCardArgs(argv: string[]): ValidateCardArgs {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    return { mode: "help", schemaOnly: false };
  }

  const schemaOnly = args.includes("--schema-only");
  const cardPath = args.filter((a) => !a.startsWith("--")).pop();

  if (!cardPath) {
    return { mode: "help", schemaOnly: false };
  }

  return { mode: "validate", cardPath, schemaOnly };
}

// ---------------------------------------------------------------------------
// Step 1: Schema Check
// ---------------------------------------------------------------------------

export async function validateSchema(cardPath: string): Promise<ValidationStepResult> {
  try {
    // Dynamic import to avoid bundling issues with TSX
    const { loadSingle } = await import("../src/cards/card-loader.js");
    const card = loadSingle(resolve(cardPath));
    return {
      name: "Schema-Check",
      status: "pass",
      detail: `Card '${card.id}' — ${card.structureSignature.length} signals, ${card.counterSignals.length} counter-signals, ${card.executionSequence.length} steps`,
    };
  } catch (err) {
    return {
      name: "Schema-Check",
      status: "fail",
      detail: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 2: Benchmark (child-process — requires Chrome on port 9222 + benchmark server on 4242)
// ---------------------------------------------------------------------------

/** Timeout for benchmark child process in ms (env-overridable for tests). */
function getBenchmarkTimeoutMs(): number {
  return parseInt(process.env.VALIDATE_CARD_BENCHMARK_TIMEOUT_MS ?? "120000", 10);
}

export async function validateBenchmark(_cardPath: string): Promise<ValidationStepResult> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dirname, "..");
  const benchmarkScript = resolve(repoRoot, "test-hardest", "benchmark-full.mjs");

  try {
    execFileSync("node", [benchmarkScript, "--operator-mode"], {
      cwd: repoRoot,
      timeout: getBenchmarkTimeoutMs(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      name: "Benchmark-Lauf",
      status: "pass",
      detail: "benchmark-full.mjs --operator-mode completed successfully",
    };
  } catch (err: unknown) {
    const error = err as { status?: number; stderr?: Buffer; message?: string };
    // Exit code 1 = test failures, other codes = infra problems
    if (error.status === 1) {
      return {
        name: "Benchmark-Lauf",
        status: "fail",
        detail: `Benchmark-Tests fehlgeschlagen (Exit 1). ${error.stderr ? error.stderr.toString().split("\n").slice(-3).join(" ") : ""}`.trim(),
      };
    }
    // Likely: server not running, Chrome not available, timeout
    return {
      name: "Benchmark-Lauf",
      status: "fail",
      detail: `Benchmark konnte nicht gestartet werden: ${error.message ?? "unbekannter Fehler"}. Chrome auf Port 9222 und Benchmark-Server auf Port 4242 benoetigt.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 3: Production-Sites Test (placeholder — manual step)
// ---------------------------------------------------------------------------

export async function validateProductionSites(cardPath: string): Promise<ValidationStepResult> {
  try {
    const { loadSingle } = await import("../src/cards/card-loader.js");
    const card = loadSingle(resolve(cardPath));

    if (card.testCases.length === 0) {
      return {
        name: "Produktionsseiten-Test",
        status: "fail",
        detail: "Keine test_cases in der Karte — mindestens 3 URLs aus unterschiedlichen Domains benoetigt fuer Merge",
      };
    }

    if (card.testCases.length < 3) {
      return {
        name: "Produktionsseiten-Test",
        status: "fail",
        detail: `Nur ${card.testCases.length}/3 test_cases vorhanden — mindestens 3 aus unterschiedlichen Domains benoetigt`,
      };
    }

    // Check that URLs are valid
    const invalidUrls = card.testCases.filter((url) => {
      try {
        new URL(url);
        return false;
      } catch {
        return true;
      }
    });

    if (invalidUrls.length > 0) {
      return {
        name: "Produktionsseiten-Test",
        status: "fail",
        detail: `Ungueltige URLs in test_cases: ${invalidUrls.join(", ")}`,
      };
    }

    // Check domains are different — AC-3 requires 3 structurally similar sites from different domains
    const domains = new Set(card.testCases.map((url) => new URL(url).hostname));
    if (domains.size < 3) {
      return {
        name: "Produktionsseiten-Test",
        status: "fail",
        detail: `Nur ${domains.size} unterschiedliche Domains — mindestens 3 verschiedene Domains benoetigt (AC-3)`,
      };
    }

    return {
      name: "Produktionsseiten-Test",
      status: "pass",
      detail: `${card.testCases.length} test_cases aus ${domains.size} Domains — manueller Live-Test empfohlen`,
    };
  } catch (err) {
    return {
      name: "Produktionsseiten-Test",
      status: "fail",
      detail: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 4: Gate Check (runs check-gate.ts as child process)
// ---------------------------------------------------------------------------

/** Timeout for gate-check child process in ms (env-overridable for tests). */
function getGateCheckTimeoutMs(): number {
  return parseInt(process.env.VALIDATE_CARD_GATE_TIMEOUT_MS ?? "15000", 10);
}

export async function validateGateCheck(): Promise<ValidationStepResult> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const checkGateScript = resolve(__dirname, "check-gate.ts");

  try {
    const result = execFileSync("npx", ["tsx", checkGateScript], {
      cwd: resolve(__dirname, ".."),
      timeout: getGateCheckTimeoutMs(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      name: "Gate-Check",
      status: "pass",
      detail: `Gate-Check bestanden. ${result.toString().replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").pop() ?? ""}`.trim(),
    };
  } catch (err: unknown) {
    const error = err as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
    if (error.status === 1) {
      const output = (error.stdout?.toString() ?? "") + (error.stderr?.toString() ?? "");
      const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter(Boolean).pop() ?? "";
      return {
        name: "Gate-Check",
        status: "fail",
        detail: `Gate-Kriterien nicht erfuellt: ${cleanOutput}`,
      };
    }
    return {
      name: "Gate-Check",
      status: "fail",
      detail: `Gate-Check konnte nicht ausgefuehrt werden: ${error.message ?? "unbekannter Fehler"}. Benchmark-JSON vorhanden?`,
    };
  }
}

// ---------------------------------------------------------------------------
// Pipeline orchestration
// ---------------------------------------------------------------------------

export async function runValidationPipeline(cardPath: string, schemaOnly: boolean): Promise<ValidationResult> {
  const steps: ValidationStepResult[] = [];

  // Step 1: Schema — always runs
  const schemaResult = await validateSchema(cardPath);
  steps.push(schemaResult);

  if (schemaResult.status === "fail") {
    // Schema failed → abort early
    return { cardPath, steps, allPassed: false };
  }

  if (schemaOnly) {
    return { cardPath, steps, allPassed: true };
  }

  // Step 2: Benchmark
  const benchmarkResult = await validateBenchmark(cardPath);
  steps.push(benchmarkResult);

  // Step 3: Production sites
  const productionResult = await validateProductionSites(cardPath);
  steps.push(productionResult);

  // Step 4: Gate check
  const gateResult = await validateGateCheck();
  steps.push(gateResult);

  // Determine overall result: fail if ANY step is not "pass".
  // skip and warn count as failures — the Merge-Gate must block (AC-5).
  const allPassed = steps.every((s) => s.status === "pass");
  return { cardPath, steps, allPassed };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];
  lines.push(`\n${BOLD}validate-card — ${result.cardPath}${RESET}`);
  lines.push("\u2550".repeat(60));

  for (const step of result.steps) {
    let icon: string;
    switch (step.status) {
      case "pass":
        icon = `${GREEN}OK${RESET}`;
        break;
      case "fail":
        icon = `${RED}FAIL${RESET}`;
        break;
      case "skip":
        icon = `${DIM}SKIP${RESET}`;
        break;
      case "warn":
        icon = `${YELLOW}WARN${RESET}`;
        break;
    }
    lines.push(`  ${icon}  ${step.name.padEnd(24)} ${DIM}${step.detail}${RESET}`);
  }

  lines.push("\u2500".repeat(60));
  const overall = result.allPassed
    ? `${GREEN}VALIDATION PASSED${RESET}`
    : `${RED}VALIDATION FAILED${RESET}`;
  lines.push(`  ${overall}`);
  lines.push("\u2550".repeat(60) + "\n");

  return lines.join("\n");
}

export function printValidateCardHelp(): string {
  return `
${BOLD}validate-card — Seed Card Validation Pipeline${RESET}

Usage:
  tsx scripts/validate-card.ts <card.yaml>                Full validation (4 steps)
  tsx scripts/validate-card.ts --schema-only <card.yaml>  Schema check only
  tsx scripts/validate-card.ts --help                     Show this help

Steps:
  1. Schema-Check      Zod validation against CardSchema
  2. Benchmark-Lauf    benchmark-full.mjs --operator-mode (requires server)
  3. Produktionsseiten  test_cases URLs from the card YAML
  4. Gate-Check         recognition_rate >= 85%, false_positive_rate < 5%
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const parsed = parseValidateCardArgs(argv);

  if (parsed.mode === "help" || !parsed.cardPath) {
    console.log(printValidateCardHelp());
    return 0;
  }

  const result = await runValidationPipeline(parsed.cardPath, parsed.schemaOnly);
  console.log(formatValidationResult(result));
  return result.allPassed ? 0 : 1;
}

// Auto-run when executed directly
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("validate-card.ts") || process.argv[1].endsWith("validate-card.js"));

if (isMainModule) {
  main(process.argv).then((code) => process.exit(code));
}
