import { describe, it, expect, vi } from "vitest";
import { runPlanHandler, runPlanSchema } from "./run-plan.js";
import type { RunPlanParams, RunPlanDeps } from "./run-plan.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolResponse } from "../types.js";
import type { OperatorPlanResult } from "../operator/types.js";

// Mock the Operator module for use_operator tests
vi.mock("../operator/operator.js", () => {
  return {
    Operator: vi.fn().mockImplementation(() => ({
      executePlan: vi.fn(),
    })),
  };
});

import { Operator } from "../operator/operator.js";

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

describe("runPlanHandler — use_operator:true (M1)", () => {
  function createMockDeps(): RunPlanDeps {
    return {
      cdpClient: {} as RunPlanDeps["cdpClient"],
      sessionId: "test-session",
    };
  }

  function createMockRegistry(): ToolRegistry {
    return {
      executeTool: vi.fn(),
    } as unknown as ToolRegistry;
  }

  function makeOperatorResult(overrides: Partial<OperatorPlanResult>): OperatorPlanResult {
    return {
      steps: [],
      stepsTotal: 0,
      stepsCompleted: 0,
      totalRulesApplied: 0,
      totalDialogsHandled: 0,
      totalMicroLlmCalls: 0,
      totalEscalations: 0,
      escalations: [],
      aborted: false,
      elapsedMs: 100,
      ...overrides,
    };
  }

  it("H1: formats skipped steps as SKIP with condition, not OK", async () => {
    const operatorResult = makeOperatorResult({
      stepsTotal: 2,
      stepsCompleted: 1,
      steps: [
        {
          step: 1,
          tool: "navigate",
          result: {
            content: [{ type: "text", text: "OK" }],
            _meta: { elapsedMs: 10, method: "navigate" },
          },
          rulesApplied: [],
          scrollAttempts: 0,
          dialogsHandled: 0,
          microLlmUsed: false,
          microLlmCalled: false,
        },
        {
          step: 2,
          tool: "click",
          result: {
            content: [{ type: "text", text: 'Skipped: condition "$loggedIn === true" was false' }],
            _meta: { elapsedMs: 0, method: "click" },
          },
          rulesApplied: [],
          scrollAttempts: 0,
          dialogsHandled: 0,
          microLlmUsed: false,
          microLlmCalled: false,
          skipped: true,
          condition: "$loggedIn === true",
        },
      ],
    });

    const MockOperator = vi.mocked(Operator);
    MockOperator.mockImplementation(() => ({
      executePlan: vi.fn().mockResolvedValue(operatorResult),
    }) as unknown as InstanceType<typeof Operator>);

    const params: RunPlanParams = {
      steps: [
        { tool: "navigate", params: { url: "https://test.com" } },
        { tool: "click", params: { ref: "e1" }, if: "$loggedIn === true" },
      ],
      use_operator: true,
    };

    const result = await runPlanHandler(params, createMockRegistry(), createMockDeps());
    const texts = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);

    // Step 2 should be SKIP, not OK
    const step2Text = texts.find((t) => t.includes("[2/2]"));
    expect(step2Text).toContain("SKIP");
    expect(step2Text).toContain("condition: $loggedIn === true");
    expect(step2Text).not.toContain("OK click");
  });

  it("H2: isError is true when all steps fail with continue strategy", async () => {
    const operatorResult = makeOperatorResult({
      stepsTotal: 2,
      stepsCompleted: 0,
      aborted: false,
      steps: [
        {
          step: 1,
          tool: "click",
          result: {
            content: [{ type: "text", text: "Element not found" }],
            isError: true,
            _meta: { elapsedMs: 5, method: "click" },
          },
          rulesApplied: [],
          scrollAttempts: 0,
          dialogsHandled: 0,
          microLlmUsed: false,
          microLlmCalled: false,
        },
        {
          step: 2,
          tool: "type",
          result: {
            content: [{ type: "text", text: "Input not found" }],
            isError: true,
            _meta: { elapsedMs: 3, method: "type" },
          },
          rulesApplied: [],
          scrollAttempts: 0,
          dialogsHandled: 0,
          microLlmUsed: false,
          microLlmCalled: false,
        },
      ],
    });

    const MockOperator = vi.mocked(Operator);
    MockOperator.mockImplementation(() => ({
      executePlan: vi.fn().mockResolvedValue(operatorResult),
    }) as unknown as InstanceType<typeof Operator>);

    const params: RunPlanParams = {
      steps: [
        { tool: "click", params: { ref: "e1" } },
        { tool: "type", params: { ref: "e2", text: "hello" } },
      ],
      errorStrategy: "continue",
      use_operator: true,
    };

    const result = await runPlanHandler(params, createMockRegistry(), createMockDeps());

    // All steps failed with continue → isError should be true
    expect(result.isError).toBe(true);
  });

  it("H2: isError is falsy when some steps succeed with continue strategy", async () => {
    const operatorResult = makeOperatorResult({
      stepsTotal: 2,
      stepsCompleted: 1,
      aborted: false,
      steps: [
        {
          step: 1,
          tool: "navigate",
          result: {
            content: [{ type: "text", text: "OK" }],
            _meta: { elapsedMs: 10, method: "navigate" },
          },
          rulesApplied: [],
          scrollAttempts: 0,
          dialogsHandled: 0,
          microLlmUsed: false,
          microLlmCalled: false,
        },
        {
          step: 2,
          tool: "click",
          result: {
            content: [{ type: "text", text: "Element not found" }],
            isError: true,
            _meta: { elapsedMs: 5, method: "click" },
          },
          rulesApplied: [],
          scrollAttempts: 0,
          dialogsHandled: 0,
          microLlmUsed: false,
          microLlmCalled: false,
        },
      ],
    });

    const MockOperator = vi.mocked(Operator);
    MockOperator.mockImplementation(() => ({
      executePlan: vi.fn().mockResolvedValue(operatorResult),
    }) as unknown as InstanceType<typeof Operator>);

    const params: RunPlanParams = {
      steps: [
        { tool: "navigate", params: { url: "https://test.com" } },
        { tool: "click", params: { ref: "e1" } },
      ],
      errorStrategy: "continue",
      use_operator: true,
    };

    const result = await runPlanHandler(params, createMockRegistry(), createMockDeps());

    // One step succeeded → isError should NOT be true
    expect(result.isError).toBeFalsy();
  });
});
