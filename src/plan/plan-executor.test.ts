import { describe, it, expect } from "vitest";
import { executePlan } from "./plan-executor.js";
import type { PlanStep } from "./plan-executor.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolResponse } from "../types.js";

function createMockRegistry(
  toolResponses: Map<string, ToolResponse>,
): ToolRegistry {
  return {
    executeTool: async (name: string, _params: Record<string, unknown>) => {
      const response = toolResponses.get(name);
      if (!response) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
          _meta: { elapsedMs: 0, method: name },
        };
      }
      return response;
    },
  } as unknown as ToolRegistry;
}

function okResponse(tool: string, text: string, elapsedMs = 5): ToolResponse {
  return {
    content: [{ type: "text", text }],
    _meta: { elapsedMs, method: tool },
  };
}

function errorResponse(tool: string, text: string, elapsedMs = 2): ToolResponse {
  return {
    content: [{ type: "text", text }],
    isError: true,
    _meta: { elapsedMs, method: tool },
  };
}

describe("executePlan", () => {
  it("executes all steps sequentially and returns combined results", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "Navigated to https://example.com"));
    responses.set("click", okResponse("click", "Clicked element e5"));
    responses.set("screenshot", okResponse("screenshot", "Screenshot taken"));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "click", params: { ref: "e5" } },
      { tool: "screenshot" },
    ];

    const result = await executePlan(steps, registry);

    expect(result.isError).toBeFalsy();
    // Should have 3 text blocks for 3 steps
    const textBlocks = result.content.filter((c) => c.type === "text");
    expect(textBlocks).toHaveLength(3);
    expect(textBlocks[0]).toHaveProperty("text", expect.stringContaining("navigate"));
    expect(textBlocks[1]).toHaveProperty("text", expect.stringContaining("click"));
    expect(textBlocks[2]).toHaveProperty("text", expect.stringContaining("screenshot"));
  });

  it("returns step-by-step results with tool name and timing", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "Navigated", 42));
    responses.set("click", okResponse("click", "Clicked", 15));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://test.com" } },
      { tool: "click", params: { ref: "e1" } },
    ];

    const result = await executePlan(steps, registry);
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );

    expect(textBlocks[0].text).toMatch(/\[1\/2\] OK navigate \(42ms\)/);
    expect(textBlocks[1].text).toMatch(/\[2\/2\] OK click \(15ms\)/);
  });

  it("_meta contains stepsTotal, stepsCompleted, elapsedMs, method", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", okResponse("evaluate", "42"));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "evaluate", params: { expression: "1+1" } }];

    const result = await executePlan(steps, registry);

    expect(result._meta).toBeDefined();
    expect(result._meta!.method).toBe("run_plan");
    expect(result._meta!.stepsTotal).toBe(1);
    expect(result._meta!.stepsCompleted).toBe(1);
    expect(typeof result._meta!.elapsedMs).toBe("number");
  });

  it("aborts on first error and returns partial results", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "Navigated"));
    responses.set("click", errorResponse("click", "Element not found"));
    responses.set("screenshot", okResponse("screenshot", "Screenshot taken"));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://test.com" } },
      { tool: "click", params: { ref: "e99" } },
      { tool: "screenshot" },
    ];

    const result = await executePlan(steps, registry);

    expect(result.isError).toBe(true);
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    // Step 1 (OK) + Step 2 (FAIL) + abort message = 3 text blocks
    expect(textBlocks).toHaveLength(3);
    expect(textBlocks[0].text).toContain("OK navigate");
    expect(textBlocks[1].text).toContain("FAIL click");
    expect(textBlocks[2].text).toContain("Plan aborted at step 2/3");
  });

  it("stepsCompleted counts only successful steps, not the failed one", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "OK"));
    responses.set("click", errorResponse("click", "Fail"));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://test.com" } },
      { tool: "click", params: { ref: "e1" } },
      { tool: "screenshot" },
    ];

    const result = await executePlan(steps, registry);

    expect(result._meta!.stepsTotal).toBe(3);
    expect(result._meta!.stepsCompleted).toBe(1); // Only navigate succeeded
  });

  it("isError is true when plan is aborted", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", errorResponse("navigate", "Connection failed"));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "navigate", params: { url: "bad" } }];

    const result = await executePlan(steps, registry);

    expect(result.isError).toBe(true);
  });

  it("reports unknown tool name as error", async () => {
    const responses = new Map<string, ToolResponse>();
    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "nonexistent_tool" }];

    const result = await executePlan(steps, registry);

    expect(result.isError).toBe(true);
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    expect(textBlocks.some((b) => b.text.includes("nonexistent_tool"))).toBe(true);
  });

  it("empty steps array returns empty result, no error", async () => {
    const registry = createMockRegistry(new Map());
    const steps: PlanStep[] = [];

    const result = await executePlan(steps, registry);

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(0);
    expect(result._meta!.stepsTotal).toBe(0);
    expect(result._meta!.stepsCompleted).toBe(0);
    expect(result._meta!.method).toBe("run_plan");
  });

  it("single step plan works correctly", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", okResponse("evaluate", "42", 10));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "evaluate", params: { expression: "21*2" } }];

    const result = await executePlan(steps, registry);

    expect(result.isError).toBeFalsy();
    expect(result._meta!.stepsTotal).toBe(1);
    expect(result._meta!.stepsCompleted).toBe(1);
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].text).toContain("evaluate");
  });

  it("error on first step returns only that step", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", errorResponse("navigate", "DNS error"));
    responses.set("click", okResponse("click", "Should not reach"));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://bad.invalid" } },
      { tool: "click", params: { ref: "e1" } },
    ];

    const result = await executePlan(steps, registry);

    expect(result.isError).toBe(true);
    expect(result._meta!.stepsCompleted).toBe(0); // Failed step doesn't count
    expect(result._meta!.stepsTotal).toBe(2);
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    // Step 1 (FAIL) + abort message
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0].text).toContain("FAIL navigate");
    expect(textBlocks[1].text).toContain("Plan aborted at step 1/2");
  });

  it("response format includes step number, status, tool name, timing, and text", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", okResponse("evaluate", "result-value", 7));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "evaluate", params: { expression: "1" } }];

    const result = await executePlan(steps, registry);
    const text = (result.content[0] as { type: "text"; text: string }).text;

    expect(text).toBe("[1/1] OK evaluate (7ms): result-value");
  });

  it("executes steps in strict serial order (call-log verification)", async () => {
    const callLog: string[] = [];
    const registry = {
      executeTool: async (name: string, _params: Record<string, unknown>) => {
        callLog.push(name);
        return {
          content: [{ type: "text" as const, text: `${name} done` }],
          _meta: { elapsedMs: 1, method: name },
        };
      },
    } as unknown as ToolRegistry;

    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "read_page" },
      { tool: "click", params: { ref: "e3" } },
      { tool: "screenshot" },
      { tool: "evaluate", params: { expression: "1+1" } },
    ];

    await executePlan(steps, registry);

    expect(callLog).toEqual(["navigate", "read_page", "click", "screenshot", "evaluate"]);
  });

  it("catches exception from executeTool and converts to isError response", async () => {
    const registry = {
      executeTool: async (name: string, _params: Record<string, unknown>) => {
        if (name === "click") {
          throw new Error("CDP session disconnected");
        }
        return {
          content: [{ type: "text" as const, text: `${name} done` }],
          _meta: { elapsedMs: 1, method: name },
        };
      },
    } as unknown as ToolRegistry;

    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "click", params: { ref: "e5" } },
      { tool: "screenshot" },
    ];

    const result = await executePlan(steps, registry);

    expect(result.isError).toBe(true);
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    // Step 1 OK + Step 2 FAIL (exception) + abort message
    expect(textBlocks).toHaveLength(3);
    expect(textBlocks[0].text).toContain("OK navigate");
    expect(textBlocks[1].text).toContain("FAIL click");
    expect(textBlocks[1].text).toContain("CDP session disconnected");
    expect(textBlocks[2].text).toContain("Plan aborted at step 2/3");
  });

  it("catches non-Error exceptions and converts to string", async () => {
    const registry = {
      executeTool: async () => {
        throw "raw string error";
      },
    } as unknown as ToolRegistry;

    const steps: PlanStep[] = [{ tool: "evaluate", params: { expression: "1" } }];

    const result = await executePlan(steps, registry);

    expect(result.isError).toBe(true);
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    expect(textBlocks[0].text).toContain("raw string error");
  });

  it("preserves image content blocks from screenshot steps", async () => {
    const screenshotResponse: ToolResponse = {
      content: [
        { type: "text", text: "Screenshot taken" },
        { type: "image", data: "base64data", mimeType: "image/webp" },
      ],
      _meta: { elapsedMs: 20, method: "screenshot" },
    };

    const responses = new Map<string, ToolResponse>();
    responses.set("screenshot", screenshotResponse);

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "screenshot" }];

    const result = await executePlan(steps, registry);

    expect(result.content).toHaveLength(2); // text header + image block
    expect(result.content[0].type).toBe("text");
    expect(result.content[1].type).toBe("image");
    expect((result.content[1] as { type: "image"; data: string; mimeType: string }).data).toBe(
      "base64data",
    );
  });
});
