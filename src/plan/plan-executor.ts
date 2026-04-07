import type { ToolRegistry } from "../registry.js";
import type { ToolResponse, ToolContentBlock, ToolMeta } from "../types.js";
import type { VarsMap } from "./plan-variables.js";
import { substituteVars, extractResultValue } from "./plan-variables.js";
import { evaluateCondition } from "./plan-conditions.js";
import type { PlanStateStore } from "./plan-state-store.js";

export type ErrorStrategy = "abort" | "continue" | "screenshot";

export interface SuspendConfig {
  /** Frage an den Agent */
  question?: string;
  /** Context-Typ: "screenshot" erzeugt automatisch einen Screenshot */
  context?: "screenshot";
  /** Bedingung: Plan pausiert NACH Step-Ausfuehrung wenn Bedingung true */
  condition?: string;
}

export interface PlanStep {
  tool: string;
  params?: Record<string, unknown>;
  saveAs?: string;
  if?: string;
  suspend?: SuspendConfig;
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
  /** Fuer Resume: der gespeicherte Plan-State */
  resumeState?: {
    suspendedAtIndex: number;
    completedResults: StepResult[];
    vars: VarsMap;
    answer: string;
  };
}

export interface SuspendedPlanResponse {
  status: "suspended";
  planId: string;
  question: string;
  completedSteps: StepResult[];
  screenshot?: string;
  _meta?: ToolMeta;
}

/** executePlan kann jetzt entweder ToolResponse oder SuspendedPlanResponse zurueckgeben */
export type PlanExecutionResult = ToolResponse | SuspendedPlanResponse;

const DEFAULT_SUSPEND_QUESTION = "Plan pausiert -- Bedingung erfuellt. Wie fortfahren?";

export async function executePlan(
  steps: PlanStep[],
  registry: ToolRegistry,
  options?: PlanOptions,
  stateStore?: PlanStateStore,
): Promise<PlanExecutionResult> {
  const start = performance.now();
  let results: StepResult[] = [];
  const vars: VarsMap = { ...(options?.vars ?? {}) };
  const errorStrategy: ErrorStrategy = options?.errorStrategy ?? "abort";
  let startIndex = 0;
  let isResumeFirstStep = false;

  // --- Resume: restore state from previous suspend ---
  if (options?.resumeState) {
    const rs = options.resumeState;
    Object.assign(vars, rs.vars);
    vars["answer"] = rs.answer;
    results = [...rs.completedResults];
    startIndex = rs.suspendedAtIndex;
    isResumeFirstStep = true;
  }

  for (let i = startIndex; i < steps.length; i++) {
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

    // --- Pre-Suspend (without condition): pause BEFORE step execution ---
    // Skip pre-suspend on the first step of a resume (agent already answered)
    if (step.suspend && !step.suspend.condition && !isResumeFirstStep) {
      if (!stateStore) {
        console.warn("[plan-executor] suspend config on step but no stateStore provided — ignoring suspend");
      } else {
        const question = step.suspend.question ?? DEFAULT_SUSPEND_QUESTION;
        let screenshot: string | undefined;
        if (step.suspend.context === "screenshot") {
          try {
            const ssResult = await registry.executeTool("screenshot", {});
            if (!ssResult.isError) {
              for (const block of ssResult.content) {
                if (block.type === "image") {
                  screenshot = (block as { type: "image"; data: string }).data;
                  break;
                }
              }
            }
          } catch {
            // Screenshot is best-effort
          }
        }
        const planId = stateStore.suspend({
          steps,
          suspendedAtIndex: i,
          vars: { ...vars },
          errorStrategy,
          completedResults: [...results],
          question,
        });
        return {
          status: "suspended",
          planId,
          question,
          completedSteps: [...results],
          screenshot,
          _meta: {
            elapsedMs: Math.round(performance.now() - start),
            method: "run_plan",
          },
        } satisfies SuspendedPlanResponse;
      }
    }

    // Reset resume-first-step flag after pre-suspend check
    isResumeFirstStep = false;

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

    // --- Post-Suspend (with condition): pause AFTER step execution if condition is true ---
    if (step.suspend?.condition && !stepResult.isError) {
      const suspendConditionResult = evaluateCondition(step.suspend.condition, vars);
      if (suspendConditionResult) {
        if (!stateStore) {
          console.warn("[plan-executor] suspend condition met but no stateStore provided — ignoring suspend");
        } else {
          const question = step.suspend.question ?? DEFAULT_SUSPEND_QUESTION;
          let screenshot: string | undefined;
          if (step.suspend.context === "screenshot") {
            try {
              const ssResult = await registry.executeTool("screenshot", {});
              if (!ssResult.isError) {
                for (const block of ssResult.content) {
                  if (block.type === "image") {
                    screenshot = (block as { type: "image"; data: string }).data;
                    break;
                  }
                }
              }
            } catch {
              // Screenshot is best-effort
            }
          }
          const planId = stateStore.suspend({
            steps,
            suspendedAtIndex: i + 1,
            vars: { ...vars },
            errorStrategy,
            completedResults: [...results],
            question,
          });
          return {
            status: "suspended",
            planId,
            question,
            completedSteps: [...results],
            screenshot,
            _meta: {
              elapsedMs: Math.round(performance.now() - start),
              method: "run_plan",
            },
          } satisfies SuspendedPlanResponse;
        }
      }
    }

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

