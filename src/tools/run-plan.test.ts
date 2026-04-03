import { describe, it, expect, vi } from "vitest";
import { runPlanHandler } from "./run-plan.js";
import type { RunPlanParams } from "./run-plan.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolResponse } from "../types.js";

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
});
