import { z } from "zod";
import type { ToolResponse } from "../types.js";
import type { ToolRegistry } from "../registry.js";
import { executePlan } from "../plan/plan-executor.js";
import type { PlanStep } from "../plan/plan-executor.js";

const stepSchema = z.object({
  tool: z.string().describe("Tool name to execute (e.g. 'navigate', 'click', 'type')"),
  params: z.record(z.unknown()).optional().describe("Parameters for the tool"),
});

export const runPlanSchema = z.object({
  steps: z
    .array(stepSchema)
    .describe("Array of tool steps to execute sequentially. Aborts on first error."),
});

export type RunPlanParams = z.infer<typeof runPlanSchema>;

export async function runPlanHandler(
  params: RunPlanParams,
  registry: ToolRegistry,
): Promise<ToolResponse> {
  return executePlan(params.steps as PlanStep[], registry);
}
