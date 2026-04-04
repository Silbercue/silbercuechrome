import { z } from "zod";
import type { ToolResponse, ToolContentBlock } from "../types.js";
import type { ToolRegistry } from "../registry.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { MicroLlmProvider } from "../operator/types.js";
import { executePlan } from "../plan/plan-executor.js";
import type { PlanStep } from "../plan/plan-executor.js";
import { Operator } from "../operator/operator.js";
import { RuleEngine } from "../operator/rule-engine.js";

const stepSchema = z.object({
  tool: z.string().describe("Tool name to execute (e.g. 'navigate', 'click', 'type')"),
  params: z.record(z.unknown()).optional().describe("Parameters for the tool"),
});

export const runPlanSchema = z.object({
  steps: z
    .array(stepSchema)
    .describe("Array of tool steps to execute sequentially. Aborts on first error."),
  use_operator: z.boolean().optional().default(false).describe(
    "When true, execute steps through the Operator (rule engine + Micro-LLM fallback) for adaptive error recovery."
  ),
});

export type RunPlanParams = z.infer<typeof runPlanSchema>;

/** Dependencies injected by the registry for Operator mode */
export interface RunPlanDeps {
  cdpClient: CdpClient;
  sessionId: string;
  microLlm?: MicroLlmProvider;
  minConfidence?: number;
  sessionManager?: SessionManager;
}

export async function runPlanHandler(
  params: RunPlanParams,
  registry: ToolRegistry,
  deps?: RunPlanDeps,
): Promise<ToolResponse> {
  // C1: When use_operator is true and deps are available, route through the Operator
  if (params.use_operator && deps) {
    const ruleEngine = new RuleEngine();
    const operator = new Operator(
      registry,
      deps.cdpClient,
      deps.sessionId,
      ruleEngine,
      deps.microLlm,
      deps.sessionManager,
      deps.minConfidence,
    );
    const operatorResult = await operator.executePlan(params.steps as PlanStep[]);

    // Convert OperatorPlanResult to ToolResponse format
    const contentBlocks: Array<ToolContentBlock> = [];
    for (const s of operatorResult.steps) {
      const status = s.result.isError ? "FAIL" : "OK";
      const stepMs = s.result._meta?.elapsedMs ?? 0;
      const textParts = s.result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const extras: string[] = [];
      if (s.rulesApplied.length > 0) extras.push(`rules=${s.rulesApplied.length}`);
      if (s.microLlmUsed) extras.push(`llm_conf=${s.microLlmConfidence}`);
      if (s.escalationNeeded) extras.push("escalation");
      const extrasStr = extras.length > 0 ? ` [${extras.join(", ")}]` : "";
      contentBlocks.push({
        type: "text",
        text: `[${s.step}/${operatorResult.stepsTotal}] ${status} ${s.tool} (${stepMs}ms)${extrasStr}: ${textParts}`,
      });
      for (const block of s.result.content) {
        if (block.type !== "text") {
          contentBlocks.push(block);
        }
      }
    }
    if (operatorResult.aborted) {
      contentBlocks.push({
        type: "text",
        text: `\nPlan aborted at step ${operatorResult.steps.length}/${operatorResult.stepsTotal}`,
      });
    }
    contentBlocks.push({
      type: "text",
      text: `\nOperator: ${operatorResult.totalRulesApplied} rules, ${operatorResult.totalMicroLlmCalls} LLM calls, ${operatorResult.totalEscalations} escalations, ${operatorResult.elapsedMs}ms`,
    });

    return {
      content: contentBlocks,
      isError: operatorResult.aborted,
      _meta: {
        elapsedMs: operatorResult.elapsedMs,
        method: "run_plan",
        stepsTotal: operatorResult.stepsTotal,
        stepsCompleted: operatorResult.stepsCompleted,
        operatorMetrics: {
          totalRulesApplied: operatorResult.totalRulesApplied,
          totalDialogsHandled: operatorResult.totalDialogsHandled,
          totalMicroLlmCalls: operatorResult.totalMicroLlmCalls,
          totalEscalations: operatorResult.totalEscalations,
        },
      },
    };
  }

  // Default: plain sequential execution without Operator
  return executePlan(params.steps as PlanStep[], registry);
}
