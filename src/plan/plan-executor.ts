import type { ToolRegistry } from "../registry.js";
import type { ToolResponse, ToolContentBlock } from "../types.js";
import type { VarsMap } from "./plan-variables.js";
import { substituteVars, extractResultValue } from "./plan-variables.js";
import { evaluateCondition } from "./plan-conditions.js";

export type ErrorStrategy = "abort" | "continue" | "screenshot";

export interface PlanStep {
  tool: string;
  params?: Record<string, unknown>;
  saveAs?: string;
  if?: string;
}

export interface StepResult {
  step: number;
  tool: string;
  result: ToolResponse;
  skipped?: boolean;
  condition?: string;
}

export interface PlanOptions {
  vars?: VarsMap;
  errorStrategy?: ErrorStrategy;
}

export async function executePlan(
  steps: PlanStep[],
  registry: ToolRegistry,
  options?: PlanOptions,
): Promise<ToolResponse> {
  const start = performance.now();
  const results: StepResult[] = [];
  const vars: VarsMap = { ...(options?.vars ?? {}) };
  const errorStrategy: ErrorStrategy = options?.errorStrategy ?? "abort";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // --- Conditional: evaluate if clause ---
    if (step.if !== undefined && step.if !== "") {
      const conditionResult = evaluateCondition(step.if, vars);
      if (!conditionResult) {
        results.push({
          step: i + 1,
          tool: step.tool,
          result: {
            content: [{ type: "text", text: `Skipped: condition "${step.if}" was false` }],
            _meta: { elapsedMs: 0, method: step.tool },
          },
          skipped: true,
          condition: step.if,
        });
        continue;
      }
    }

    // --- Variable substitution ---
    const resolvedParams = step.params
      ? substituteVars(step.params, vars)
      : {};

    // --- Execute step ---
    let stepResult: ToolResponse;
    try {
      stepResult = await registry.executeTool(step.tool, resolvedParams);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stepResult = {
        content: [{ type: "text", text: `Exception in ${step.tool}: ${message}` }],
        isError: true,
        _meta: { elapsedMs: 0, method: step.tool },
      };
    }

    // --- saveAs: store result as variable ---
    if (!stepResult.isError && step.saveAs) {
      vars[step.saveAs] = extractResultValue(stepResult);
    }

    results.push({ step: i + 1, tool: step.tool, result: stepResult });

    // --- Error handling based on strategy ---
    if (stepResult.isError) {
      if (errorStrategy === "abort") {
        return buildPlanResponse(results, steps.length, start, true, errorStrategy);
      }

      if (errorStrategy === "screenshot") {
        // Take screenshot and append to the failed step
        try {
          const screenshotResult = await registry.executeTool("screenshot", {});
          // Append screenshot content to the failed step's result
          const lastResult = results[results.length - 1];
          if (!screenshotResult.isError) {
            for (const block of screenshotResult.content) {
              if (block.type === "image") {
                lastResult.result = {
                  ...lastResult.result,
                  content: [...lastResult.result.content, block],
                };
              }
            }
          }
        } catch {
          // Screenshot is best-effort
        }
        return buildPlanResponse(results, steps.length, start, true, errorStrategy);
      }

      // errorStrategy === "continue": just keep going
    }
  }

  return buildPlanResponse(results, steps.length, start, false, errorStrategy);
}

function buildPlanResponse(
  results: StepResult[],
  stepsTotal: number,
  startTime: number,
  aborted: boolean,
  errorStrategy: ErrorStrategy = "abort",
): ToolResponse {
  const elapsedMs = Math.round(performance.now() - startTime);
  const contentBlocks: Array<ToolContentBlock> = [];

  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (const r of results) {
    if (r.skipped) {
      skipCount++;
      contentBlocks.push({
        type: "text",
        text: `[${r.step}/${stepsTotal}] SKIP ${r.tool} (condition: ${r.condition})`,
      });
      continue;
    }

    const status = r.result.isError ? "FAIL" : "OK";
    if (r.result.isError) failCount++;
    else okCount++;

    const stepMs = r.result._meta?.elapsedMs ?? 0;

    // Build step header text from text content blocks
    const textParts = r.result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    contentBlocks.push({
      type: "text",
      text: `[${r.step}/${stepsTotal}] ${status} ${r.tool} (${stepMs}ms): ${textParts}`,
    });

    // Preserve non-text content blocks (e.g. screenshot images)
    for (const block of r.result.content) {
      if (block.type !== "text") {
        contentBlocks.push(block);
      }
    }
  }

  if (aborted) {
    contentBlocks.push({
      type: "text",
      text: `\nPlan aborted at step ${results.length}/${stepsTotal}`,
    });
  }

  // Summary for continue strategy with errors
  if (errorStrategy === "continue" && failCount > 0 && !aborted) {
    const parts = [`${okCount}/${stepsTotal} OK`, `${failCount} FAIL`];
    if (skipCount > 0) parts.push(`${skipCount} SKIP`);
    contentBlocks.push({
      type: "text",
      text: `\nPlan completed with errors: ${parts.join(", ")}`,
    });
  }

  // Determine isError:
  // - abort/screenshot: aborted flag
  // - continue: only if ALL executed (non-skipped) steps failed
  const executedCount = okCount + failCount;
  const isError =
    errorStrategy === "continue" && !aborted
      ? executedCount > 0 && failCount === executedCount
      : aborted;

  return {
    content: contentBlocks,
    isError: isError || undefined,
    _meta: {
      elapsedMs,
      method: "run_plan",
      stepsTotal,
      stepsCompleted: okCount,
    },
  };
}
