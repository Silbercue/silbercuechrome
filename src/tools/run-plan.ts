import { z } from "zod";
import type { ToolResponse, ToolContentBlock } from "../types.js";
import type { ToolRegistry } from "../registry.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { MicroLlmProvider } from "../operator/types.js";
import type { CaptainProvider } from "../operator/captain.js";
import { executePlan } from "../plan/plan-executor.js";
import type { PlanStep, PlanOptions } from "../plan/plan-executor.js";
import { Operator } from "../operator/operator.js";
import { RuleEngine } from "../operator/rule-engine.js";

const stepSchema = z.object({
  tool: z.string().describe("Tool name to execute (e.g. 'navigate', 'click', 'type')"),
  params: z.record(z.unknown()).optional().describe("Parameters for the tool. Use $varName for variable substitution."),
  saveAs: z.string().optional().describe("Save step result as variable (accessible via $name in later steps)"),
  if: z.string().optional().describe("Condition expression — step runs only if true. Use $varName for variables. Example: \"$pageTitle === 'Login'\""),
});

export const runPlanSchema = z.object({
  steps: z
    .array(stepSchema)
    .describe("Array of tool steps to execute sequentially."),
  vars: z
    .record(z.unknown())
    .optional()
    .describe("Initial variables for the plan. Accessible via $varName in step params and conditions."),
  errorStrategy: z
    .enum(["abort", "continue", "screenshot"])
    .optional()
    .default("abort")
    .describe("Error handling: 'abort' (default) stops on first error, 'continue' runs all steps, 'screenshot' captures page on error then aborts."),
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
  captain?: CaptainProvider;
  captainScreenshot?: boolean;
}

export async function runPlanHandler(
  params: RunPlanParams,
  registry: ToolRegistry,
  deps?: RunPlanDeps,
): Promise<ToolResponse> {
  const planOptions: PlanOptions = {
    vars: params.vars,
    errorStrategy: params.errorStrategy,
  };

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
      deps.captain,
      deps.captainScreenshot,
    );
    const operatorResult = await operator.executePlan(params.steps as PlanStep[], planOptions);

    // Convert OperatorPlanResult to ToolResponse format
    const contentBlocks: Array<ToolContentBlock> = [];
    let okCount = 0;
    let failCount = 0;
    let skipCount = 0;
    for (const s of operatorResult.steps) {
      // H1: Skipped steps (conditional) must show SKIP, not OK
      if (s.skipped) {
        skipCount++;
        contentBlocks.push({
          type: "text",
          text: `[${s.step}/${operatorResult.stepsTotal}] SKIP ${s.tool} (condition: ${s.condition})`,
        });
        continue;
      }

      const status = s.result.isError ? "FAIL" : "OK";
      if (s.result.isError) failCount++;
      else okCount++;
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
    // Add escalation content blocks (Story 8.3)
    for (const esc of operatorResult.escalations) {
      const decisionStr = esc.decision
        ? `Captain: ${esc.decision.type}${"ref" in esc.decision ? ` ${esc.decision.ref}` : ""}${"selector" in esc.decision ? ` ${esc.decision.selector}` : ""}`
        : "Captain: timeout/declined";
      contentBlocks.push({
        type: "text",
        text: `[ESCALATION Step ${esc.stepNumber}/${operatorResult.stepsTotal}] ${esc.escalation.reason} → ${decisionStr} (${esc.elapsedMs}ms)`,
      });
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

    // Captain escalation metrics (Story 8.3)
    const captainEscalations = operatorResult.escalations.length;
    const captainDecisions = operatorResult.escalations.filter((e) => e.decision !== null).length;
    const captainTimeouts = operatorResult.escalations.filter((e) => e.decision === null).length;

    // H2: Determine isError analogous to executePlan:
    // - abort/screenshot: aborted flag
    // - continue: only if ALL executed (non-skipped) steps failed
    const executedCount = okCount + failCount;
    const isError =
      params.errorStrategy === "continue" && !operatorResult.aborted
        ? executedCount > 0 && failCount === executedCount
        : operatorResult.aborted;

    return {
      content: contentBlocks,
      isError: isError || undefined,
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
          captainEscalations,
          captainDecisions,
          captainTimeouts,
        },
      },
    };
  }

  // Default: plain sequential execution without Operator
  return executePlan(params.steps as PlanStep[], registry, planOptions);
}
