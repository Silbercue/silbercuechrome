import { describe, it, expect, vi } from "vitest";
import { runPlanHandler, runPlanSchema } from "./run-plan.js";
import type { RunPlanParams, RunPlanDeps } from "./run-plan.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolResponse } from "../types.js";
import { PlanStateStore } from "../plan/plan-state-store.js";
import type { SuspendedPlanResponse } from "../plan/plan-executor.js";

function createMockRegistry(
  toolResponses: Map<string, ToolResponse>,
): ToolRegistry {
  return {
    executeTool: vi.fn(async (name: string, _params: Record<string, unknown>) => {
      const response = toolResponses.get(name);
      if (!response) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
          _meta: { elapsedMs: 0, method: name },
        };
      }
      return response;
    }),
  } as unknown as ToolRegistry;
}

describe("runPlanHandler", () => {
  it("delegates to executePlan with parsed steps", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", {
      content: [{ type: "text", text: "OK" }],
      _meta: { elapsedMs: 10, method: "navigate" },
    });

    const registry = createMockRegistry(responses);
    const params: RunPlanParams = {
      steps: [{ tool: "navigate", params: { url: "https://test.com" } }],
    };

    const result = await runPlanHandler(params, registry);

    expect(result).toBeDefined();
    expect(result.isError).toBeFalsy();
    expect(result._meta).toBeDefined();
    expect(result._meta!.method).toBe("run_plan");
  });

  it("passes registry to executePlan", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", {
      content: [{ type: "text", text: "42" }],
      _meta: { elapsedMs: 3, method: "evaluate" },
    });

    const registry = createMockRegistry(responses);
    const params: RunPlanParams = {
      steps: [{ tool: "evaluate", params: { expression: "21*2" } }],
    };

    await runPlanHandler(params, registry);

    // Verify the registry's executeTool was called
    expect(registry.executeTool).toHaveBeenCalledWith("evaluate", { expression: "21*2" });
  });

  it("passes vars and errorStrategy to executePlan", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", {
      content: [{ type: "text", text: "OK" }],
      _meta: { elapsedMs: 5, method: "navigate" },
    });

    const registry = createMockRegistry(responses);
    const params: RunPlanParams = {
      steps: [{ tool: "navigate", params: { url: "$url" } }],
      vars: { url: "https://test.com" },
      errorStrategy: "continue",
    };

    const result = await runPlanHandler(params, registry);

    expect(result).toBeDefined();
    expect(registry.executeTool).toHaveBeenCalledWith("navigate", { url: "https://test.com" });
  });

  it("works without vars and errorStrategy (backward compatible)", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", {
      content: [{ type: "text", text: "Clicked" }],
      _meta: { elapsedMs: 2, method: "click" },
    });

    const registry = createMockRegistry(responses);
    const params: RunPlanParams = {
      steps: [{ tool: "click", params: { ref: "e1" } }],
    };

    const result = await runPlanHandler(params, registry);

    expect(result).toBeDefined();
    expect(result.isError).toBeFalsy();
  });
});

describe("runPlanSchema (Story 6.4)", () => {
  it("accepts vars in schema", () => {
    const result = runPlanSchema.safeParse({
      steps: [{ tool: "navigate", params: { url: "$url" } }],
      vars: { url: "https://test.com" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts errorStrategy in schema", () => {
    const result = runPlanSchema.safeParse({
      steps: [{ tool: "click" }],
      errorStrategy: "continue",
    });
    expect(result.success).toBe(true);
  });

  it("accepts saveAs and if in step schema", () => {
    const result = runPlanSchema.safeParse({
      steps: [
        { tool: "evaluate", params: { expression: "1" }, saveAs: "result" },
        { tool: "click", params: { ref: "e1" }, if: "$result === 1" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("errorStrategy defaults to abort", () => {
    const result = runPlanSchema.parse({
      steps: [{ tool: "click" }],
    });
    expect(result.errorStrategy).toBe("abort");
  });

  it("rejects invalid errorStrategy", () => {
    const result = runPlanSchema.safeParse({
      steps: [{ tool: "click" }],
      errorStrategy: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("runPlanHandler — use_operator:true returns Pro-Feature error (Story 15.1)", () => {
  it("returns proFeatureError when use_operator is true", async () => {
    const registry = createMockRegistry(new Map());
    const params: RunPlanParams = {
      steps: [{ tool: "navigate", params: { url: "https://test.com" } }],
      use_operator: true,
    };

    const result = await runPlanHandler(params, registry);

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Pro-Feature");
    expect(text).toContain("use_operator");
  });

  it("returns proFeatureError BEFORE mode validation when use_operator is true and no steps/parallel/resume given", async () => {
    // Regression test for H1: use_operator must be checked before the
    // "steps/parallel/resume mutually exclusive" mode validation, so users
    // get a clear pro-feature hint even without any mode field set.
    const registry = createMockRegistry(new Map());
    const params = { use_operator: true } as RunPlanParams;

    const result = await runPlanHandler(params, registry);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("use_operator");
    expect(text).toContain("Pro-Feature");
    // Must NOT be the mode-validation error message
    expect(text).not.toContain("Eines von 'steps', 'parallel' oder 'resume' muss angegeben werden");
  });
});

// ===== Story 6.5: Suspend/Resume in runPlanHandler =====

function isSuspended(result: unknown): result is SuspendedPlanResponse {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    (result as SuspendedPlanResponse).status === "suspended"
  );
}

describe("runPlanHandler — Suspend/Resume (Story 6.5)", () => {
  it("returns error when neither steps nor resume is provided", async () => {
    const registry = createMockRegistry(new Map());
    const params = {} as RunPlanParams;

    const result = await runPlanHandler(params, registry, undefined, new PlanStateStore());

    expect(result).toBeDefined();
    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Eines von 'steps', 'parallel' oder 'resume' muss angegeben werden");
  });

  it("returns error when resume has unknown planId", async () => {
    const registry = createMockRegistry(new Map());
    const store = new PlanStateStore();
    const params: RunPlanParams = {
      resume: { planId: "nonexistent-id", answer: "yes" },
    };

    const result = await runPlanHandler(params, registry, undefined, store);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Plan abgelaufen oder nicht gefunden");
  });

  it("returns error when resume called without stateStore", async () => {
    const registry = createMockRegistry(new Map());
    const params: RunPlanParams = {
      resume: { planId: "some-id", answer: "yes" },
    };

    const result = await runPlanHandler(params, registry);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Resume nicht verfuegbar");
  });

  it("suspend returns SuspendedPlanResponse through runPlanHandler", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", {
      content: [{ type: "text", text: "OK" }],
      _meta: { elapsedMs: 10, method: "navigate" },
    });

    const registry = createMockRegistry(responses);
    const store = new PlanStateStore();
    const params: RunPlanParams = {
      steps: [
        { tool: "navigate", params: { url: "https://example.com" } },
        { tool: "navigate", params: { url: "https://example.com/2" }, suspend: { question: "Continue?" } },
      ],
    };

    const result = await runPlanHandler(params, registry, undefined, store);

    expect(isSuspended(result)).toBe(true);
    if (!isSuspended(result)) throw new Error("Expected suspended");
    expect(result.question).toBe("Continue?");
    expect(result.completedSteps).toHaveLength(1);
  });

  it("resume continues and completes the plan", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", {
      content: [{ type: "text", text: "Navigated" }],
      _meta: { elapsedMs: 10, method: "navigate" },
    });
    responses.set("click", {
      content: [{ type: "text", text: "Clicked" }],
      _meta: { elapsedMs: 5, method: "click" },
    });

    const registry = createMockRegistry(responses);
    const store = new PlanStateStore();

    // First: suspend
    const suspendParams: RunPlanParams = {
      steps: [
        { tool: "navigate", params: { url: "https://example.com" } },
        { tool: "click", params: { ref: "e5" }, suspend: { question: "Which element?" } },
        { tool: "navigate", params: { url: "https://example.com/done" } },
      ],
    };

    const suspendResult = await runPlanHandler(suspendParams, registry, undefined, store);
    expect(isSuspended(suspendResult)).toBe(true);
    if (!isSuspended(suspendResult)) throw new Error("Expected suspended");

    // Resume
    const resumeParams: RunPlanParams = {
      resume: { planId: suspendResult.planId, answer: "e15" },
    };

    const resumeResult = await runPlanHandler(resumeParams, registry, undefined, store);
    expect(isSuspended(resumeResult)).toBe(false);
    expect((resumeResult as ToolResponse).isError).toBeFalsy();
  });

  it("returns error when both steps and resume are provided", async () => {
    const registry = createMockRegistry(new Map());
    const store = new PlanStateStore();
    const params: RunPlanParams = {
      steps: [{ tool: "navigate", params: { url: "https://example.com" } }],
      resume: { planId: "some-id", answer: "yes" },
    };

    const result = await runPlanHandler(params, registry, undefined, store);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Nur eines von 'steps', 'parallel' oder 'resume' angeben");
  });

});

describe("runPlanSchema — Suspend/Resume (Story 6.5)", () => {
  it("accepts steps as optional", () => {
    const result = runPlanSchema.safeParse({
      resume: { planId: "abc123", answer: "e15" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts suspend in step schema", () => {
    const result = runPlanSchema.safeParse({
      steps: [
        {
          tool: "click",
          params: { ref: "e5" },
          suspend: { question: "Which element?", context: "screenshot" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts suspend with condition in step schema", () => {
    const result = runPlanSchema.safeParse({
      steps: [
        {
          tool: "evaluate",
          params: { expression: "1" },
          saveAs: "count",
          suspend: { condition: "$count === 0" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts resume schema", () => {
    const result = runPlanSchema.safeParse({
      resume: { planId: "test-id", answer: "yes" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects resume with missing answer", () => {
    const result = runPlanSchema.safeParse({
      resume: { planId: "test-id" },
    });
    expect(result.success).toBe(false);
  });
});

// ===== Story 9.1: Free-Tier Step-Limit =====

import type { LicenseStatus } from "../license/license-status.js";
import type { FreeTierConfig } from "../license/free-tier-config.js";

function createMockLicense(isPro: boolean): LicenseStatus {
  return { isPro: () => isPro };
}

describe("runPlanHandler — Free-Tier Step-Limit (Story 9.1)", () => {
  it("truncates steps to freeTierConfig.runPlanLimit when license is free", async () => {
    const callLog: string[] = [];
    const registry = {
      executeTool: vi.fn(async (name: string) => {
        callLog.push(name);
        return {
          content: [{ type: "text" as const, text: `${name} done` }],
          _meta: { elapsedMs: 5, method: name },
        };
      }),
    } as unknown as ToolRegistry;

    const params: RunPlanParams = {
      steps: [
        { tool: "navigate", params: { url: "https://example.com" } },
        { tool: "click", params: { ref: "e1" } },
        { tool: "screenshot" },
        { tool: "evaluate", params: { expression: "1" } },
        { tool: "type", params: { ref: "e2", text: "hi" } },
      ],
    };

    const license = createMockLicense(false);
    const config: FreeTierConfig = { runPlanLimit: 3 };

    const result = await runPlanHandler(params, registry, undefined, undefined, license, config);

    expect(callLog).toHaveLength(3);
    expect(callLog).toEqual(["navigate", "click", "screenshot"]);
    expect(result._meta).toBeDefined();
    expect(result._meta!.truncated).toBe(true);
    expect(result._meta!.limit).toBe(3);
    expect(result._meta!.total).toBe(5);
    expect(result.isError).toBeFalsy();

    // BUG-008: Visible truncation warning in content (not just _meta)
    const firstBlock = result.content[0];
    expect(firstBlock).toEqual(expect.objectContaining({ type: "text" }));
    const text = (firstBlock as { type: "text"; text: string }).text;
    expect(text).toContain("truncated from 5 to 3");
    expect(text).toContain("[4] evaluate");
    expect(text).toContain("[5] type");
  });

  it("does not limit steps when license is Pro", async () => {
    const callLog: string[] = [];
    const registry = {
      executeTool: vi.fn(async (name: string) => {
        callLog.push(name);
        return {
          content: [{ type: "text" as const, text: `${name} done` }],
          _meta: { elapsedMs: 5, method: name },
        };
      }),
    } as unknown as ToolRegistry;

    const params: RunPlanParams = {
      steps: [
        { tool: "navigate" },
        { tool: "click" },
        { tool: "screenshot" },
        { tool: "evaluate" },
        { tool: "type" },
      ],
    };

    const license = createMockLicense(true);
    const config: FreeTierConfig = { runPlanLimit: 3 };

    const result = await runPlanHandler(params, registry, undefined, undefined, license, config);

    expect(callLog).toHaveLength(5);
    expect(result._meta!.truncated).toBeUndefined();
  });

  it("uses custom runPlanLimit from config", async () => {
    const callLog: string[] = [];
    const registry = {
      executeTool: vi.fn(async (name: string) => {
        callLog.push(name);
        return {
          content: [{ type: "text" as const, text: `${name} done` }],
          _meta: { elapsedMs: 5, method: name },
        };
      }),
    } as unknown as ToolRegistry;

    const params: RunPlanParams = {
      steps: [
        { tool: "navigate" },
        { tool: "click" },
        { tool: "screenshot" },
        { tool: "evaluate" },
        { tool: "type" },
        { tool: "wait_for" },
        { tool: "read_page" },
        { tool: "dom_snapshot" },
      ],
    };

    const license = createMockLicense(false);
    const config: FreeTierConfig = { runPlanLimit: 5 };

    const result = await runPlanHandler(params, registry, undefined, undefined, license, config);

    expect(callLog).toHaveLength(5);
    expect(result._meta!.truncated).toBe(true);
    expect(result._meta!.limit).toBe(5);
    expect(result._meta!.total).toBe(8);
  });

  it("defaults to free tier (stepLimit applied) when no license provided", async () => {
    const callLog: string[] = [];
    const registry = {
      executeTool: vi.fn(async (name: string) => {
        callLog.push(name);
        return {
          content: [{ type: "text" as const, text: `${name} done` }],
          _meta: { elapsedMs: 5, method: name },
        };
      }),
    } as unknown as ToolRegistry;

    const params: RunPlanParams = {
      steps: [
        { tool: "navigate" },
        { tool: "click" },
        { tool: "screenshot" },
        { tool: "evaluate" },
        { tool: "type" },
      ],
    };

    // No license, no config → defaults: FreeTierLicenseStatus (isPro=false), runPlanLimit=3
    const result = await runPlanHandler(params, registry);

    expect(callLog).toHaveLength(3);
    expect(result._meta!.truncated).toBe(true);
    expect(result._meta!.limit).toBe(3);
  });

});

// ===== Story 7.6: Parallel Tab Control =====

describe("runPlanHandler — parallel (Story 7.6)", () => {
  it("parallel and steps simultaneously returns error", async () => {
    const registry = createMockRegistry(new Map());
    const params: RunPlanParams = {
      steps: [{ tool: "navigate", params: { url: "https://example.com" } }],
      parallel: [{ tab: "tab-a", steps: [{ tool: "click", params: { ref: "e1" } }] }],
    };

    const result = await runPlanHandler(params, registry);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Nur eines von 'steps', 'parallel' oder 'resume' angeben");
  });

  it("parallel and resume simultaneously returns error", async () => {
    const registry = createMockRegistry(new Map());
    const params: RunPlanParams = {
      parallel: [{ tab: "tab-a", steps: [{ tool: "click", params: { ref: "e1" } }] }],
      resume: { planId: "some-id", answer: "yes" },
    };

    const result = await runPlanHandler(params, registry);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Nur eines von 'steps', 'parallel' oder 'resume' angeben");
  });

  it("parallel without Pro license returns feature-gate error", async () => {
    const registry = createMockRegistry(new Map());
    const license = createMockLicense(false);
    const params: RunPlanParams = {
      parallel: [{ tab: "tab-a", steps: [{ tool: "navigate", params: { url: "https://a.com" } }] }],
    };

    const result = await runPlanHandler(params, registry, undefined, undefined, license);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("parallel ist ein Pro-Feature");
  });

  it("parallel with use_operator returns Pro-Feature error (Story 15.1)", async () => {
    const registry = createMockRegistry(new Map());
    const license = createMockLicense(true);
    const params: RunPlanParams = {
      parallel: [{ tab: "tab-a", steps: [{ tool: "navigate" }] }],
      use_operator: true,
    };

    const result = await runPlanHandler(params, registry, undefined, undefined, license);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Pro-Feature");
    expect(text).toContain("use_operator");
  });

  it("parallel with empty groups list returns error", async () => {
    const registry = createMockRegistry(new Map());
    const license = createMockLicense(true);
    const deps: RunPlanDeps = {
      cdpClient: {} as RunPlanDeps["cdpClient"],
      sessionId: "test-session",
    };
    const params: RunPlanParams = {
      parallel: [],
    };

    const result = await runPlanHandler(params, registry, deps, undefined, license);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("parallel darf nicht leer sein");
  });

  it("parallel without deps returns error", async () => {
    const registry = createMockRegistry(new Map());
    const license = createMockLicense(true);
    const params: RunPlanParams = {
      parallel: [{ tab: "tab-a", steps: [{ tool: "navigate" }] }],
    };

    const result = await runPlanHandler(params, registry, undefined, undefined, license);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Parallel-Ausfuehrung benoetigt CDP-Verbindung");
  });
});

describe("runPlanSchema — parallel (Story 7.6)", () => {
  it("accepts parallel in schema", () => {
    const result = runPlanSchema.safeParse({
      parallel: [
        { tab: "tab-a", steps: [{ tool: "navigate", params: { url: "https://a.com" } }] },
        { tab: "tab-b", steps: [{ tool: "click", params: { ref: "e1" } }] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects parallel with invalid group (missing tab)", () => {
    const result = runPlanSchema.safeParse({
      parallel: [
        { steps: [{ tool: "navigate" }] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects parallel with invalid group (missing steps)", () => {
    const result = runPlanSchema.safeParse({
      parallel: [
        { tab: "tab-a" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts parallel with vars and errorStrategy", () => {
    const result = runPlanSchema.safeParse({
      parallel: [
        { tab: "tab-a", steps: [{ tool: "navigate", params: { url: "$url" } }] },
      ],
      vars: { url: "https://a.com" },
      errorStrategy: "continue",
    });
    expect(result.success).toBe(true);
  });
});
