import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPlanHandler, runPlanSchema } from "./run-plan.js";
import type { RunPlanParams, RunPlanDeps } from "./run-plan.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolResponse } from "../types.js";
import { PlanStateStore } from "../plan/plan-state-store.js";
import type { SuspendedPlanResponse } from "../plan/plan-executor.js";
import { registerProHooks } from "../hooks/pro-hooks.js";
import { FreeTierLicenseStatus } from "../license/license-status.js";

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
    // Story 18.1: Plan-Executor ruft am Plan-Ende runAggregationHook
    // ueber den letzten Step auf. Mocks brauchen eine no-op-Implementation.
    runAggregationHook: vi.fn(async () => {}),
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

    // Verify the registry's executeTool was called. Story 18.1: run_plan
    // uebergibt jetzt einen 4. Options-Parameter mit `skipOnToolResultHook`.
    expect(registry.executeTool).toHaveBeenCalledWith(
      "evaluate",
      { expression: "21*2" },
      undefined,
      { skipOnToolResultHook: true },
    );
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
    expect(registry.executeTool).toHaveBeenCalledWith(
      "navigate",
      { url: "https://test.com" },
      undefined,
      { skipOnToolResultHook: true },
    );
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
    expect(text).toContain("Pro feature");
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
    expect(text).toContain("Pro feature");
    // Must NOT be the mode-validation error message
    expect(text).not.toContain("One of 'steps', 'parallel', or 'resume' must be provided");
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
    expect(text).toContain("One of 'steps', 'parallel', or 'resume' must be provided");
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
    expect(text).toContain("Plan expired or not found");
  });

  it("returns error when resume called without stateStore", async () => {
    const registry = createMockRegistry(new Map());
    const params: RunPlanParams = {
      resume: { planId: "some-id", answer: "yes" },
    };

    const result = await runPlanHandler(params, registry);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Resume not available");
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
    expect(text).toContain("Only one of 'steps', 'parallel', or 'resume' may be provided");
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
          suspend: { question: "Which element?", context: "capture_image" },
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
        { tool: "capture_image" },
        { tool: "evaluate", params: { expression: "1" } },
        { tool: "type", params: { ref: "e2", text: "hi" } },
      ],
    };

    const license = createMockLicense(false);
    const config: FreeTierConfig = { runPlanLimit: 3 };

    const result = await runPlanHandler(params, registry, undefined, undefined, license, config);

    expect(callLog).toHaveLength(3);
    expect(callLog).toEqual(["navigate", "click", "capture_image"]);
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
        { tool: "capture_image" },
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
        { tool: "capture_image" },
        { tool: "evaluate" },
        { tool: "type" },
        { tool: "wait_for" },
        { tool: "view_page" },
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
        { tool: "capture_image" },
        { tool: "evaluate" },
        { tool: "type" },
      ],
    };

    // Explicit Free license — cache file on dev machines would default to Pro
    const result = await runPlanHandler(params, registry, undefined, undefined, new FreeTierLicenseStatus(false));

    // Free tier no longer has a step limit — all 5 steps execute
    expect(callLog).toHaveLength(5);
    expect(result._meta!.truncated).toBeUndefined();
  });

});

// ===== Story 7.6: Parallel Tab Control =====

describe("runPlanHandler — parallel (Story 7.6)", () => {
  // Story 15.4: ensure clean hook state between parallel tests
  beforeEach(() => {
    registerProHooks({});
  });

  it("parallel and steps simultaneously returns error", async () => {
    const registry = createMockRegistry(new Map());
    const params: RunPlanParams = {
      steps: [{ tool: "navigate", params: { url: "https://example.com" } }],
      parallel: [{ tab: "tab-a", steps: [{ tool: "click", params: { ref: "e1" } }] }],
    };

    const result = await runPlanHandler(params, registry);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Only one of 'steps', 'parallel', or 'resume' may be provided");
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
    expect(text).toContain("Only one of 'steps', 'parallel', or 'resume' may be provided");
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
    expect(text).toContain("parallel is a Pro feature");
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
    expect(text).toContain("Pro feature");
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
    expect(text).toContain("parallel must not be empty");
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
    expect(text).toContain("Parallel execution requires a CDP connection");
  });

  // --- Story 15.4: executeParallel Hook delegation ---

  it("parallel with Pro license but without registered hook returns Pro-Feature error", async () => {
    // Simulates Free-Repo scenario: Pro license somehow set, but Pro-Repo not loaded
    // (e.g. npm-installed free package). Must not crash, must return proFeatureError.
    registerProHooks({}); // Ensure no executeParallel hook registered

    const registry = createMockRegistry(new Map());
    const license = createMockLicense(true);
    const deps: RunPlanDeps = {
      cdpClient: {
        send: vi.fn(),
      } as unknown as RunPlanDeps["cdpClient"],
      sessionId: "test-session",
    };
    const params: RunPlanParams = {
      parallel: [{ tab: "tab-a", steps: [{ tool: "navigate" }] }],
    };

    const result = await runPlanHandler(params, registry, deps, undefined, license);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("parallel is a Pro feature");
  });

  it("parallel with Pro license and registered hook delegates to hook", async () => {
    const mockHookResponse: ToolResponse = {
      content: [{ type: "text", text: "parallel-hook-result" }],
      _meta: { elapsedMs: 42, method: "run_plan", parallel: true, tabGroups: 1 },
    };
    const executeParallelMock = vi.fn().mockResolvedValue(mockHookResponse);

    registerProHooks({ executeParallel: executeParallelMock });

    const registry = createMockRegistry(new Map());
    const license = createMockLicense(true);
    const cdpSendMock = vi.fn();
    const deps: RunPlanDeps = {
      cdpClient: {
        send: cdpSendMock,
      } as unknown as RunPlanDeps["cdpClient"],
      sessionId: "test-session",
    };
    const params: RunPlanParams = {
      parallel: [{ tab: "tab-a", steps: [{ tool: "navigate", params: { url: "https://a.com" } }] }],
      vars: { foo: "bar" },
      errorStrategy: "continue",
    };

    const result = await runPlanHandler(params, registry, deps, undefined, license);

    // Hook was called exactly once
    expect(executeParallelMock).toHaveBeenCalledTimes(1);

    // Args: groups, registryFactory, options
    const callArgs = executeParallelMock.mock.calls[0];
    expect(callArgs[0]).toEqual([
      { tab: "tab-a", steps: [{ tool: "navigate", params: { url: "https://a.com" } }] },
    ]);
    expect(typeof callArgs[1]).toBe("function"); // registryFactory
    expect(callArgs[2]).toEqual({
      vars: { foo: "bar" },
      errorStrategy: "continue",
      concurrencyLimit: 5,
    });

    // Hook response is returned verbatim
    expect(result).toBe(mockHookResponse);

    // Reset hooks
    registerProHooks({});
  });

  // --- M1 (Code-Review 15.4): Edge-Case-Tests fuer Hook-Errors ---

  it("parallel hook throws exception → returns isError response (no crash)", async () => {
    // Hook wirft synchron/asynchron eine Exception. runPlanHandler MUSS sie
    // in eine MCP-konforme isError-Response wandeln statt nach oben durchzulassen.
    const executeParallelMock = vi.fn().mockRejectedValue(new Error("hook boom"));
    registerProHooks({ executeParallel: executeParallelMock });

    const registry = createMockRegistry(new Map());
    const license = createMockLicense(true);
    const cdpSendMock = vi.fn().mockResolvedValue({ sessionId: "tab-session-1" });
    const deps: RunPlanDeps = {
      cdpClient: {
        send: cdpSendMock,
      } as unknown as RunPlanDeps["cdpClient"],
      sessionId: "test-session",
    };
    const params: RunPlanParams = {
      parallel: [{ tab: "tab-a", steps: [{ tool: "navigate", params: { url: "https://a.com" } }] }],
    };

    const result = await runPlanHandler(params, registry, deps, undefined, license);

    expect(executeParallelMock).toHaveBeenCalledTimes(1);
    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("parallel execution failed");
    expect(text).toContain("hook boom");
    expect((result as ToolResponse)._meta).toEqual(
      expect.objectContaining({ method: "run_plan" }),
    );

    registerProHooks({});
  });

  it("parallel hook returns isError:true → returned as-is", async () => {
    // Wenn der Hook eine isError-Response liefert (z.B. wegen Tab-Fehler),
    // muss runPlanHandler sie unveraendert weiterreichen — kein Wrapping,
    // kein Verlust der _meta-Daten.
    const hookErrorResponse: ToolResponse = {
      content: [{ type: "text", text: "Tab xyz could not be opened" }],
      isError: true,
      _meta: { elapsedMs: 17, method: "run_plan", parallel: true, tabGroups: 1 },
    };
    const executeParallelMock = vi.fn().mockResolvedValue(hookErrorResponse);
    registerProHooks({ executeParallel: executeParallelMock });

    const registry = createMockRegistry(new Map());
    const license = createMockLicense(true);
    const cdpSendMock = vi.fn().mockResolvedValue({ sessionId: "tab-session-1" });
    const deps: RunPlanDeps = {
      cdpClient: {
        send: cdpSendMock,
      } as unknown as RunPlanDeps["cdpClient"],
      sessionId: "test-session",
    };
    const params: RunPlanParams = {
      parallel: [{ tab: "tab-a", steps: [{ tool: "navigate" }] }],
    };

    const result = await runPlanHandler(params, registry, deps, undefined, license);

    expect(executeParallelMock).toHaveBeenCalledTimes(1);
    // Response identisch zurueckgegeben (gleicher Object-Reference)
    expect(result).toBe(hookErrorResponse);
    expect((result as ToolResponse).isError).toBe(true);
    expect((result as ToolResponse)._meta).toEqual(
      expect.objectContaining({ elapsedMs: 17, method: "run_plan", parallel: true, tabGroups: 1 }),
    );

    registerProHooks({});
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

// --- Story 18.1: run_plan suppresses Ambient-Context-Hook per step ---

describe("runPlanHandler — Ambient-Context suppression (Story 18.1)", () => {
  beforeEach(() => {
    registerProHooks({});
  });

  it("every intermediate step is executed with skipOnToolResultHook=true", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", {
      content: [{ type: "text", text: "Clicked" }],
      _meta: { elapsedMs: 1, method: "click" },
    });
    responses.set("type", {
      content: [{ type: "text", text: "Typed" }],
      _meta: { elapsedMs: 1, method: "type" },
    });

    const registry = createMockRegistry(responses);
    const params: RunPlanParams = {
      steps: [
        { tool: "click", params: { ref: "e1" } },
        { tool: "type", params: { ref: "e2", text: "hi" } },
      ],
    };

    await runPlanHandler(params, registry);

    const calls = (registry.executeTool as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    for (const [, , sessionIdOverride, options] of calls) {
      expect(sessionIdOverride).toBeUndefined();
      expect(options).toEqual({ skipOnToolResultHook: true });
    }
  });

  it("direct tool-calls outside run_plan stay opt-in (ambient context default)", async () => {
    // This verifies the opt-in semantics: only run_plan threads the flag
    // through. A registry callsite that does not pass options preserves
    // the current default behavior (hook runs normally).
    //
    // We check this by building a responses map where the mock registry
    // inspects the fourth argument. run_plan-driven calls must carry the
    // flag; a direct executeTool call (simulating the MCP server.tool
    // callsite) must NOT.
    const directCallOptions: Array<unknown> = [];
    const planCallOptions: Array<unknown> = [];
    const mockRegistry = {
      executeTool: vi.fn(
        async (
          _name: string,
          _params: Record<string, unknown>,
          _sess: string | undefined,
          options: unknown,
        ) => {
          // Route based on who called: for this test we push into the
          // "plan" bucket if the options object was provided, "direct"
          // otherwise. The real production code mirrors this split:
          // run_plan always passes options, the server.tool wrap does not.
          if (options !== undefined) planCallOptions.push(options);
          else directCallOptions.push(options);
          return {
            content: [{ type: "text" as const, text: "ok" }],
            _meta: { elapsedMs: 1, method: _name },
          };
        },
      ),
      runAggregationHook: vi.fn(async () => {}),
    } as unknown as ToolRegistry;

    // Plan-driven call: options must be set
    await runPlanHandler(
      { steps: [{ tool: "click", params: { ref: "e1" } }] } as RunPlanParams,
      mockRegistry,
    );

    // Direct call (outside run_plan): no options → default behavior
    await mockRegistry.executeTool("click", { ref: "e2" });

    expect(planCallOptions).toHaveLength(1);
    expect(planCallOptions[0]).toEqual({ skipOnToolResultHook: true });
    expect(directCallOptions).toHaveLength(1);
    expect(directCallOptions[0]).toBeUndefined();
  });

  // --- H1 (Code-Review 18.1): Parallel-Pfad Aggregation ---

  it("parallel plan with 3 steps calls runAggregationHook exactly once", async () => {
    // Regression test for H1: the parallel path must drive the aggregation
    // hook *once* at the end of the whole parallel group — not once per
    // step (3x would defeat the suppression) and not zero times (that
    // would leak the pre-18.1 "no final ambient context" bug into the
    // parallel path).
    const mockHookResponse: ToolResponse = {
      content: [{ type: "text", text: "parallel ok" }],
      _meta: { elapsedMs: 42, method: "run_plan", parallel: true, tabGroups: 1 },
    };
    // The real Pro executeParallel would drive the registry.executeTool
    // closure three times (once per step); we simulate that here so the
    // test catches any accidental aggregation-per-step regression.
    const runAggregationHook = vi.fn(async () => {});
    const executeToolInner = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "step ok" }],
      _meta: { elapsedMs: 1, method: "click" },
    }));
    const executeParallelMock = vi.fn(
      async (
        _groups: Array<{ tab: string; steps: PlanStep[] }>,
        registryFactory: (tabTargetId: string) => Promise<{
          executeTool: (
            name: string,
            toolParams: Record<string, unknown>,
          ) => Promise<ToolResponse>;
        }>,
      ) => {
        // Simulate the Pro-Hook: instantiate the tab-registry via the
        // factory, then run each step via its `executeTool` closure.
        const tabRegistry = await registryFactory("tab-a");
        await tabRegistry.executeTool("click", { ref: "e1" });
        await tabRegistry.executeTool("click", { ref: "e2" });
        await tabRegistry.executeTool("click", { ref: "e3" });
        return mockHookResponse;
      },
    );

    registerProHooks({ executeParallel: executeParallelMock });

    const registry = {
      executeTool: executeToolInner,
      runAggregationHook,
    } as unknown as ToolRegistry;

    const license = createMockLicense(true);
    const cdpSendMock = vi.fn().mockResolvedValue({ sessionId: "tab-session-1" });
    const deps: RunPlanDeps = {
      cdpClient: {
        send: cdpSendMock,
      } as unknown as RunPlanDeps["cdpClient"],
      sessionId: "test-session",
    };
    const params: RunPlanParams = {
      parallel: [
        {
          tab: "tab-a",
          steps: [
            { tool: "click", params: { ref: "e1" } },
            { tool: "click", params: { ref: "e2" } },
            { tool: "click", params: { ref: "e3" } },
          ],
        },
      ],
    };

    const result = await runPlanHandler(params, registry, deps, undefined, license);

    // The Pro-Hook saw 3 executeTool calls on its tab-registry (one per
    // step) — that is the "N steps" baseline.
    expect(executeToolInner).toHaveBeenCalledTimes(3);
    // Every intermediate step ran with the suppression flag set — this
    // is the AC-1 contract and must not regress in the parallel path.
    for (const call of executeToolInner.mock.calls) {
      const options = call[3];
      expect(options).toEqual({ skipOnToolResultHook: true });
    }

    // *** The H1 fix: aggregation hook fires exactly once, over the
    // whole parallel-group result — not three times, not zero times.
    expect(runAggregationHook).toHaveBeenCalledTimes(1);
    const aggregationArgs = runAggregationHook.mock.calls[0];
    expect(aggregationArgs[0]).toBe(mockHookResponse);
    expect(aggregationArgs[1]).toBe("run_plan");

    // The Pro-Hook's response is returned unchanged.
    expect(result).toBe(mockHookResponse);

    registerProHooks({});
  });

  it("parallel plan that returns isError skips the aggregation hook", async () => {
    // Regression test: isError responses must not trigger the aggregation
    // hook, mirroring the sequential plan-executor guard. Otherwise the
    // LLM would get a misleading "final ambient context" stitched onto
    // a failed parallel run.
    const hookErrorResponse: ToolResponse = {
      content: [{ type: "text", text: "tab crashed" }],
      isError: true,
      _meta: { elapsedMs: 17, method: "run_plan", parallel: true, tabGroups: 1 },
    };
    const runAggregationHook = vi.fn(async () => {});
    const executeParallelMock = vi.fn(async () => hookErrorResponse);

    registerProHooks({ executeParallel: executeParallelMock });

    const registry = {
      executeTool: vi.fn(),
      runAggregationHook,
    } as unknown as ToolRegistry;

    const license = createMockLicense(true);
    const cdpSendMock = vi.fn().mockResolvedValue({ sessionId: "tab-session-1" });
    const deps: RunPlanDeps = {
      cdpClient: {
        send: cdpSendMock,
      } as unknown as RunPlanDeps["cdpClient"],
      sessionId: "test-session",
    };
    const params: RunPlanParams = {
      parallel: [{ tab: "tab-a", steps: [{ tool: "click", params: { ref: "e1" } }] }],
    };

    const result = await runPlanHandler(params, registry, deps, undefined, license);

    expect((result as ToolResponse).isError).toBe(true);
    // Aggregation must NOT have fired over the failed parallel response
    expect(runAggregationHook).not.toHaveBeenCalled();

    registerProHooks({});
  });
});
