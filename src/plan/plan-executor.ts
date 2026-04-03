import type { ToolRegistry } from "../registry.js";
import type { ToolResponse, ToolContentBlock } from "../types.js";

export interface PlanStep {
  tool: string;
  params?: Record<string, unknown>;
}

export interface StepResult {
  step: number;
  tool: string;
  result: ToolResponse;
}

export async function executePlan(
  steps: PlanStep[],
  registry: ToolRegistry,
): Promise<ToolResponse> {
  const start = performance.now();
  const results: StepResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let stepResult: ToolResponse;
    try {
      stepResult = await registry.executeTool(step.tool, step.params ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stepResult = {
        content: [{ type: "text", text: `Exception in ${step.tool}: ${message}` }],
        isError: true,
        _meta: { elapsedMs: 0, method: step.tool },
      };
    }
    results.push({ step: i + 1, tool: step.tool, result: stepResult });

    if (stepResult.isError) {
      // Abort on error — return partial results
      return buildPlanResponse(results, steps.length, start, true);
    }
  }

  return buildPlanResponse(results, steps.length, start, false);
}

function buildPlanResponse(
  results: StepResult[],
  stepsTotal: number,
  startTime: number,
  aborted: boolean,
): ToolResponse {
  const elapsedMs = Math.round(performance.now() - startTime);
  const contentBlocks: Array<ToolContentBlock> = [];

  for (const r of results) {
    const status = r.result.isError ? "FAIL" : "OK";
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

  return {
    content: contentBlocks,
    isError: aborted,
    _meta: {
      elapsedMs,
      method: "run_plan",
      stepsTotal,
      stepsCompleted: aborted ? results.length - 1 : results.length,
    },
  };
}
