import { z } from "zod";
import type { ToolResponse } from "../types.js";
import type { ToolRegistry } from "../registry.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import { executePlan, executeParallel } from "../plan/plan-executor.js";
import type { PlanStep, PlanOptions, SuspendedPlanResponse, ParallelGroup } from "../plan/plan-executor.js";
import type { PlanStateStore } from "../plan/plan-state-store.js";
import { proFeatureError } from "../hooks/pro-hooks.js";
import type { LicenseStatus } from "../license/license-status.js";
import type { FreeTierConfig } from "../license/free-tier-config.js";
import { FreeTierLicenseStatus } from "../license/license-status.js";
import { DEFAULT_FREE_TIER_CONFIG } from "../license/free-tier-config.js";
import { createTabScopedRegistry } from "../plan/tab-scoped-registry.js";

const suspendSchema = z.object({
  question: z.string().optional().describe("Question to ask the agent when suspending"),
  context: z.enum(["screenshot"]).optional().describe("Context to include: 'screenshot' captures the page"),
  condition: z.string().optional().describe("Condition expression — suspend AFTER step if true. Uses $varName syntax."),
});

const stepSchema = z.object({
  tool: z.string().describe("Tool name to execute (e.g. 'navigate', 'click', 'type')"),
  params: z.record(z.unknown()).optional().describe("Parameters for the tool. Use $varName for variable substitution."),
  saveAs: z.string().optional().describe("Save step result as variable (accessible via $name in later steps)"),
  if: z.string().optional().describe("Condition expression — step runs only if true. Use $varName for variables. Example: \"$pageTitle === 'Login'\""),
  suspend: suspendSchema.optional().describe("Suspend plan at this step to ask the agent a question"),
});

const resumeSchema = z.object({
  planId: z.string().describe("ID of the suspended plan to resume"),
  answer: z.string().describe("Agent's answer to the suspend question"),
});

// Story 7.6: Schema for parallel tab groups
const parallelGroupSchema = z.object({
  tab: z.string().describe("Tab ID (targetId) to execute steps on"),
  steps: z.array(stepSchema).describe("Steps to execute on this tab"),
});

export const runPlanSchema = z.object({
  steps: z
    .array(stepSchema)
    .optional()
    .describe("Array of tool steps to execute sequentially."),
  parallel: z
    .array(parallelGroupSchema)
    .optional()
    .describe("Array of tab groups to execute in parallel. Pro-Feature."),
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
    "Pro-Feature: Operator mode (rule engine + Micro-LLM). Returns pro-feature error in Free tier."
  ),
  resume: resumeSchema.optional().describe("Resume a previously suspended plan."),
});

export type RunPlanParams = z.infer<typeof runPlanSchema>;

/** Dependencies injected by the registry */
export interface RunPlanDeps {
  cdpClient: CdpClient;
  sessionId: string;
  sessionManager?: SessionManager;
}

export async function runPlanHandler(
  params: RunPlanParams,
  registry: ToolRegistry,
  deps?: RunPlanDeps,
  stateStore?: PlanStateStore,
  license?: LicenseStatus,
  freeTierConfig?: FreeTierConfig,
): Promise<ToolResponse | SuspendedPlanResponse> {
  // Story 15.1: use_operator is a Pro-Feature — return pro-feature error
  // BEFORE any mode validation so users get a clear pro-feature hint even
  // when steps/parallel/resume is missing.
  if (params.use_operator) {
    return proFeatureError("use_operator");
  }

  // --- Validation: steps, parallel, and resume are mutually exclusive ---
  const modeCount = [params.steps, params.parallel, params.resume].filter(Boolean).length;
  if (modeCount > 1) {
    return {
      content: [{ type: "text", text: "Nur eines von 'steps', 'parallel' oder 'resume' angeben" }],
      isError: true,
      _meta: { elapsedMs: 0, method: "run_plan" },
    };
  }

  if (modeCount === 0) {
    return {
      content: [{ type: "text", text: "Eines von 'steps', 'parallel' oder 'resume' muss angegeben werden" }],
      isError: true,
      _meta: { elapsedMs: 0, method: "run_plan" },
    };
  }

  // --- Story 9.1: Resolve step limit from license status ---
  const resolvedLicense = license ?? new FreeTierLicenseStatus();
  const resolvedConfig = freeTierConfig ?? DEFAULT_FREE_TIER_CONFIG;
  const stepLimit = resolvedLicense.isPro() ? undefined : resolvedConfig.runPlanLimit;

  // --- Story 7.6: Parallel path ---
  if (params.parallel) {
    // Pro-Feature-Gate: parallel requires Pro license
    if (!resolvedLicense.isPro()) {
      return {
        content: [{ type: "text", text: "parallel ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'" }],
        isError: true,
        _meta: { elapsedMs: 0, method: "run_plan" },
      };
    }

    if (params.parallel.length === 0) {
      return {
        content: [{ type: "text", text: "parallel darf nicht leer sein" }],
        isError: true,
        _meta: { elapsedMs: 0, method: "run_plan" },
      };
    }

    if (!deps) {
      return {
        content: [{ type: "text", text: "Parallel-Ausfuehrung benoetigt CDP-Verbindung" }],
        isError: true,
        _meta: { elapsedMs: 0, method: "run_plan" },
      };
    }

    const registryFactory = async (tabTargetId: string) => {
      return createTabScopedRegistry(registry, deps.cdpClient, tabTargetId);
    };

    return executeParallel(params.parallel as ParallelGroup[], registryFactory, {
      vars: params.vars,
      errorStrategy: params.errorStrategy,
      concurrencyLimit: 5,
    });
  }

  // --- Resume path ---
  if (params.resume) {
    if (!stateStore) {
      return {
        content: [{ type: "text", text: "Resume nicht verfuegbar: kein PlanStateStore konfiguriert" }],
        isError: true,
        _meta: { elapsedMs: 0, method: "run_plan" },
      };
    }
    const suspended = stateStore.resume(params.resume.planId);
    if (!suspended) {
      return {
        content: [{ type: "text", text: "Plan abgelaufen oder nicht gefunden" }],
        isError: true,
        _meta: { elapsedMs: 0, method: "run_plan" },
      };
    }
    const resumeOptions: PlanOptions = {
      vars: suspended.vars,
      errorStrategy: suspended.errorStrategy,
      resumeState: {
        suspendedAtIndex: suspended.suspendedAtIndex,
        completedResults: suspended.completedResults,
        vars: suspended.vars,
        answer: params.resume.answer,
      },
    };

    return executePlan(suspended.steps, registry, resumeOptions, stateStore);
  }

  const planOptions: PlanOptions = {
    vars: params.vars,
    errorStrategy: params.errorStrategy,
  };

  // Story 9.1: Apply step limit to steps array before execution
  const allSteps = params.steps as PlanStep[];
  let steps = allSteps;
  const total = allSteps.length;
  const truncated = stepLimit !== undefined && allSteps.length > stepLimit;
  if (truncated) {
    steps = allSteps.slice(0, stepLimit);
  }

  // Default: plain sequential execution
  const result = await executePlan(steps, registry, planOptions, stateStore);
  // Story 9.1 + BUG-008: Inject truncation info into _meta AND visible output
  if (truncated && result._meta) {
    result._meta.truncated = true;
    result._meta.limit = stepLimit!;
    result._meta.total = total;
    injectTruncationWarning(result as ToolResponse, total, stepLimit!, allSteps);
  }
  return result;
}

/** BUG-008: Inject visible truncation warning into response content */
function injectTruncationWarning(
  result: ToolResponse,
  total: number,
  limit: number,
  allSteps: PlanStep[],
): void {
  const skippedTools = allSteps.slice(limit).map((s, i) => `[${limit + i + 1}] ${s.tool}`).join(", ");
  result.content.unshift({
    type: "text",
    text: `Plan truncated from ${total} to ${limit} steps (Free Tier limit). Skipped: ${skippedTools}. Upgrade to Pro for unlimited steps.`,
  });
}
