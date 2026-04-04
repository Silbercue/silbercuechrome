import type { ToolRegistry } from "../registry.js";
import type { ToolResponse, ToolContentBlock, ToolMeta } from "../types.js";
import type { VarsMap } from "./plan-variables.js";
import { substituteVars, extractResultValue } from "./plan-variables.js";
import { evaluateCondition } from "./plan-conditions.js";
import type { PlanStateStore } from "./plan-state-store.js";
import { debug } from "../cdp/debug.js";

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

// ===== Story 7.6: Multi-Tab Parallel Control =====

export interface ParallelGroup {
  tab: string;          // Tab-ID (targetId)
  steps: PlanStep[];    // Steps fuer diesen Tab
}

export interface ParallelOptions {
  vars?: VarsMap;
  errorStrategy?: ErrorStrategy;
  concurrencyLimit?: number;  // Default: 5
}

export interface ParallelGroupResult {
  tab: string;
  response: ToolResponse;
  stepsCount: number;
  aborted: boolean;
  error?: string;
}

/**
 * Simple semaphore for concurrency limiting. No external package needed.
 */
export function createSemaphore(limit: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  return {
    async acquire(): Promise<void> {
      if (running < limit) { running++; return; }
      return new Promise<void>((resolve) => queue.push(() => { running++; resolve(); }));
    },
    release(): void {
      running--;
      const next = queue.shift();
      if (next) next();
    },
  };
}

/**
 * Story 7.6: Execute multiple tab-groups in parallel.
 * Each group runs its steps on a separate CDP session via the registryFactory.
 * Error isolation: a failure in one group does NOT abort other groups.
 * Returns a ToolResponse ready for MCP transport.
 */
export async function executeParallel(
  groups: ParallelGroup[],
  registryFactory: (tabTargetId: string) => Promise<{ executeTool: (name: string, params: Record<string, unknown>) => Promise<ToolResponse> }>,
  options?: ParallelOptions,
): Promise<ToolResponse> {
  const start = performance.now();
  const limit = options?.concurrencyLimit ?? 5;
  const errorStrategy: ErrorStrategy = options?.errorStrategy ?? "abort";
  const vars: VarsMap = options?.vars ?? {};

  debug("executeParallel: starting %d groups (limit=%d)", groups.length, limit);

  if (groups.length === 0) {
    return {
      content: [],
      _meta: {
        elapsedMs: 0,
        method: "run_plan",
        parallel: true,
        tabGroups: 0,
        stepsTotal: 0,
        stepsCompleted: 0,
      },
    };
  }

  const semaphore = createSemaphore(limit);

  const settled = await Promise.allSettled(
    groups.map(async (group): Promise<ParallelGroupResult> => {
      await semaphore.acquire();
      try {
        debug("executeParallel: group tab=%s started", group.tab);

        if (group.steps.length === 0) {
          debug("executeParallel: group tab=%s has no steps, skipping", group.tab);
          return {
            tab: group.tab,
            response: { content: [], _meta: { elapsedMs: 0, method: "run_plan" } },
            stepsCount: 0,
            aborted: false,
          };
        }

        // Create a tab-scoped registry via the factory
        const tabRegistry = await registryFactory(group.tab);

        // Execute the group's steps sequentially using executePlan
        // Each group gets its own COPY of vars for isolation
        const planResult = await executePlan(
          group.steps,
          tabRegistry as unknown as ToolRegistry,
          { vars: { ...vars }, errorStrategy },
        );

        // executePlan returns ToolResponse or SuspendedPlanResponse
        // For parallel, suspend is not supported (Phase 1 limitation)
        if ("status" in planResult && (planResult as SuspendedPlanResponse).status === "suspended") {
          debug("executeParallel: group tab=%s encountered suspend — not supported in parallel", group.tab);
          const suspended = planResult as SuspendedPlanResponse;
          return {
            tab: group.tab,
            response: {
              content: [{ type: "text", text: "suspend is not supported in parallel groups" }],
              isError: true,
              _meta: suspended._meta ?? { elapsedMs: 0, method: "run_plan" },
            },
            stepsCount: group.steps.length,
            aborted: true,
            error: "suspend is not supported in parallel groups",
          };
        }

        const toolResponse = planResult as ToolResponse;
        const aborted = toolResponse.isError === true;

        debug("executeParallel: group tab=%s completed (%d steps)", group.tab, group.steps.length);

        return {
          tab: group.tab,
          response: toolResponse,
          stepsCount: group.steps.length,
          aborted,
          error: aborted ? "Group aborted due to step failure" : undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debug("executeParallel: group tab=%s failed: %s", group.tab, message);
        return {
          tab: group.tab,
          response: {
            content: [{ type: "text", text: `Exception: ${message}` }],
            isError: true,
            _meta: { elapsedMs: 0, method: "run_plan" },
          },
          stepsCount: group.steps.length,
          aborted: true,
          error: message,
        };
      } finally {
        semaphore.release();
      }
    }),
  );

  // Collect results from allSettled
  const groupResults: ParallelGroupResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      groupResults.push(outcome.value);
    } else {
      // Shouldn't happen since we catch inside, but be safe
      groupResults.push({
        tab: "unknown",
        response: {
          content: [{ type: "text", text: `Unexpected rejection: ${outcome.reason}` }],
          isError: true,
          _meta: { elapsedMs: 0, method: "run_plan" },
        },
        stepsCount: 0,
        aborted: true,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  }

  const elapsedMs = Math.round(performance.now() - start);
  debug("executeParallel: all groups completed in %dms", elapsedMs);

  return buildParallelResponse(groupResults, elapsedMs);
}

/**
 * Story 7.6: Build a ToolResponse from parallel group results.
 * Each group's executePlan response is prefixed with a tab header.
 */
export function buildParallelResponse(
  groupResults: ParallelGroupResult[],
  elapsedMs: number,
): ToolResponse {
  const contentBlocks: ToolContentBlock[] = [];

  for (const group of groupResults) {
    contentBlocks.push({
      type: "text",
      text: `--- Tab ${group.tab} ---`,
    });
    // Include all content blocks from the group's executePlan response
    for (const block of group.response.content) {
      if (block.type === "text") {
        contentBlocks.push({ type: "text", text: `  ${block.text}` });
      } else {
        contentBlocks.push(block);
      }
    }
    if (group.error) {
      contentBlocks.push({ type: "text", text: `  Tab ${group.tab}: error — ${group.error}` });
    }
  }

  const totalSteps = groupResults.reduce(
    (sum, g) => sum + (Number(g.response._meta?.stepsTotal) || g.stepsCount),
    0,
  );
  const okSteps = groupResults.reduce(
    (sum, g) => sum + (Number(g.response._meta?.stepsCompleted) || 0),
    0,
  );
  const failedGroups = groupResults.filter((g) => g.aborted || g.error).length;

  return {
    content: contentBlocks,
    isError: failedGroups === groupResults.length && groupResults.length > 0 ? true : undefined,
    _meta: {
      elapsedMs,
      method: "run_plan",
      parallel: true,
      tabGroups: groupResults.length,
      stepsTotal: totalSteps,
      stepsCompleted: okSteps,
    },
  };
}
