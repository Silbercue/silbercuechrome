import { describe, it, expect, vi } from "vitest";
import { executePlan } from "./plan-executor.js";
import type { PlanStep, PlanOptions } from "./plan-executor.js";
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

// ===== Story 6.4 Tests =====

function createCallLogRegistry(
  toolResponses: Map<string, ToolResponse>,
  callLog?: Array<{ name: string; params: Record<string, unknown> }>,
): ToolRegistry {
  return {
    executeTool: async (name: string, params: Record<string, unknown>) => {
      if (callLog) callLog.push({ name, params });
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

describe("executePlan — Variables (Story 6.4)", () => {
  it("substitutes $var in step params", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "Navigated"));

    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [{ tool: "navigate", params: { url: "$url" } }];
    const options: PlanOptions = { vars: { url: "https://test.com" } };

    await executePlan(steps, registry, options);

    expect(callLog[0].params).toEqual({ url: "https://test.com" });
  });

  it("saveAs stores step result as variable for later steps", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", okResponse("evaluate", "My Page Title"));

    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [
      { tool: "evaluate", params: { expression: "document.title" }, saveAs: "title" },
      { tool: "evaluate", params: { expression: "$title" } },
    ];

    await executePlan(steps, registry);

    // Second call should receive the result of the first as param
    expect(callLog[1].params).toEqual({ expression: "My Page Title" });
  });

  it("vars accumulate across steps", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", okResponse("evaluate", "value1"));
    // For the second call we need a different response — use a counter
    let callCount = 0;
    const registry = {
      executeTool: async (name: string, params: Record<string, unknown>) => {
        callLog.push({ name, params });
        callCount++;
        return {
          content: [{ type: "text" as const, text: `value${callCount}` }],
          _meta: { elapsedMs: 1, method: name },
        };
      },
    } as unknown as ToolRegistry;

    const steps: PlanStep[] = [
      { tool: "evaluate", params: { expression: "first" }, saveAs: "a" },
      { tool: "evaluate", params: { expression: "second" }, saveAs: "b" },
      { tool: "evaluate", params: { expression: "$a and $b" } },
    ];

    await executePlan(steps, registry);

    // Third call should have both vars substituted
    expect(callLog[2].params).toEqual({ expression: "value1 and value2" });
  });

  it("initial vars from options are available", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "OK"));

    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "$baseUrl/$path" } },
    ];
    const options: PlanOptions = { vars: { baseUrl: "https://example.com", path: "login" } };

    await executePlan(steps, registry, options);

    expect(callLog[0].params).toEqual({ url: "https://example.com/login" });
  });

  it("saveAs does not store on error", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", errorResponse("evaluate", "Error"));
    responses.set("navigate", okResponse("navigate", "OK"));

    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [
      { tool: "evaluate", params: { expression: "bad" }, saveAs: "result" },
      { tool: "navigate", params: { url: "$result" } },
    ];

    await executePlan(steps, registry, { errorStrategy: "continue" });

    // $result should be unresolved since evaluate failed
    expect(callLog[1].params).toEqual({ url: "$result" });
  });
});

describe("executePlan — Conditionals (Story 6.4)", () => {
  it("skips step when if condition is false", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("click", okResponse("click", "Clicked"));

    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e5" }, if: "$skip === true" },
    ];
    const options: PlanOptions = { vars: { skip: false } };

    const result = await executePlan(steps, registry, options);

    // executeTool should NOT have been called
    expect(callLog).toHaveLength(0);
    expect(result.isError).toBeFalsy();
  });

  it("executes step when if condition is true", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("click", okResponse("click", "Clicked"));

    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e5" }, if: "$doClick === true" },
    ];
    const options: PlanOptions = { vars: { doClick: true } };

    await executePlan(steps, registry, options);

    expect(callLog).toHaveLength(1);
    expect(callLog[0].name).toBe("click");
  });

  it("skipped step output shows SKIP with condition", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", okResponse("click", "Clicked"));

    const registry = createCallLogRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e5" }, if: "$pageTitle === 'Login'" },
    ];
    const options: PlanOptions = { vars: { pageTitle: "Home" } };

    const result = await executePlan(steps, registry, options);

    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    expect(textBlocks[0].text).toContain("SKIP click");
    expect(textBlocks[0].text).toContain("condition:");
    expect(textBlocks[0].text).toContain("$pageTitle === 'Login'");
  });

  it("skipped steps do not count as completed or failed", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "OK"));
    responses.set("click", okResponse("click", "Clicked"));

    const registry = createCallLogRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://test.com" } },
      { tool: "click", params: { ref: "e5" }, if: "false" },
    ];

    const result = await executePlan(steps, registry);

    expect(result._meta!.stepsCompleted).toBe(1); // only navigate
    expect(result._meta!.stepsTotal).toBe(2);
    expect(result.isError).toBeFalsy();
  });
});

describe("executePlan — Error Strategies (Story 6.4)", () => {
  it("errorStrategy abort is default behavior (unchanged)", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "OK"));
    responses.set("click", errorResponse("click", "Not found"));
    responses.set("screenshot", okResponse("screenshot", "Shot"));

    const registry = createCallLogRegistry(responses);
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
    expect(textBlocks.some((b) => b.text.includes("Plan aborted"))).toBe(true);
  });

  it("errorStrategy continue runs all steps despite errors", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "OK"));
    responses.set("click", errorResponse("click", "Not found"));
    responses.set("screenshot", okResponse("screenshot", "Shot"));

    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://test.com" } },
      { tool: "click", params: { ref: "e99" } },
      { tool: "screenshot" },
    ];
    const options: PlanOptions = { errorStrategy: "continue" };

    const result = await executePlan(steps, registry, options);

    // All 3 steps should have been called
    expect(callLog).toHaveLength(3);
    // Not all failed, so isError should be falsy
    expect(result.isError).toBeFalsy();
    // Summary should be present
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    expect(textBlocks.some((b) => b.text.includes("Plan completed with errors"))).toBe(true);
  });

  it("errorStrategy continue with all failures sets isError", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", errorResponse("click", "Not found"));
    responses.set("type", errorResponse("type", "Element missing"));

    const registry = createCallLogRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e1" } },
      { tool: "type", params: { ref: "e2", text: "hello" } },
    ];
    const options: PlanOptions = { errorStrategy: "continue" };

    const result = await executePlan(steps, registry, options);

    expect(result.isError).toBe(true);
  });

  it("errorStrategy screenshot takes screenshot on error then aborts", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const screenshotResponse: ToolResponse = {
      content: [
        { type: "text", text: "Screenshot taken" },
        { type: "image", data: "base64screenshot", mimeType: "image/webp" },
      ],
      _meta: { elapsedMs: 20, method: "screenshot" },
    };

    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "OK"));
    responses.set("click", errorResponse("click", "Not found"));
    responses.set("screenshot", screenshotResponse);
    responses.set("type", okResponse("type", "Typed")); // should not be reached

    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://test.com" } },
      { tool: "click", params: { ref: "e99" } },
      { tool: "type", params: { ref: "e1", text: "hello" } },
    ];
    const options: PlanOptions = { errorStrategy: "screenshot" };

    const result = await executePlan(steps, registry, options);

    expect(result.isError).toBe(true);
    // navigate + click + screenshot = 3 calls, type not called
    expect(callLog.map((c) => c.name)).toEqual(["navigate", "click", "screenshot"]);
    // Should have image block in result
    const imageBlocks = result.content.filter((c) => c.type === "image");
    expect(imageBlocks).toHaveLength(1);
    expect((imageBlocks[0] as { type: "image"; data: string }).data).toBe("base64screenshot");
    // Should have abort message
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    expect(textBlocks.some((b) => b.text.includes("Plan aborted"))).toBe(true);
  });

  it("errorStrategy screenshot does not take screenshot on success", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "OK"));
    responses.set("click", okResponse("click", "Clicked"));

    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://test.com" } },
      { tool: "click", params: { ref: "e1" } },
    ];
    const options: PlanOptions = { errorStrategy: "screenshot" };

    const result = await executePlan(steps, registry, options);

    expect(result.isError).toBeFalsy();
    // Only navigate + click, no screenshot
    expect(callLog.map((c) => c.name)).toEqual(["navigate", "click"]);
  });
});

describe("executePlan — Combined Features (Story 6.4)", () => {
  it("vars + conditions + continue strategy work together", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    let callIdx = 0;
    const registry = {
      executeTool: async (name: string, params: Record<string, unknown>) => {
        callLog.push({ name, params });
        callIdx++;
        if (name === "evaluate") {
          return {
            content: [{ type: "text" as const, text: "Login" }],
            _meta: { elapsedMs: 1, method: name },
          };
        }
        if (name === "click" && params.ref === "e99") {
          return {
            content: [{ type: "text" as const, text: "Not found" }],
            isError: true,
            _meta: { elapsedMs: 1, method: name },
          };
        }
        return {
          content: [{ type: "text" as const, text: `${name} done` }],
          _meta: { elapsedMs: 1, method: name },
        };
      },
    } as unknown as ToolRegistry;

    const steps: PlanStep[] = [
      { tool: "evaluate", params: { expression: "document.title" }, saveAs: "title" },
      { tool: "click", params: { ref: "e5" }, if: "$title === 'Login'" },
      { tool: "click", params: { ref: "e99" } }, // will fail
      { tool: "navigate", params: { url: "$url" }, if: "$title === 'NotLogin'" }, // will skip
      { tool: "screenshot" },
    ];
    const options: PlanOptions = {
      vars: { url: "https://test.com" },
      errorStrategy: "continue",
    };

    const result = await executePlan(steps, registry, options);

    // Step 1: evaluate (OK, saveAs title="Login")
    // Step 2: click e5 (condition true, OK)
    // Step 3: click e99 (FAIL, continue)
    // Step 4: navigate (condition false, SKIP)
    // Step 5: screenshot (OK)
    expect(callLog.map((c) => c.name)).toEqual(["evaluate", "click", "click", "screenshot"]);
    expect(result._meta!.stepsCompleted).toBe(3); // evaluate, click e5, screenshot
    expect(result._meta!.stepsTotal).toBe(5);

    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    expect(textBlocks.some((b) => b.text.includes("SKIP navigate"))).toBe(true);
    expect(textBlocks.some((b) => b.text.includes("FAIL click"))).toBe(true);
    expect(textBlocks.some((b) => b.text.includes("Plan completed with errors"))).toBe(true);
  });

  it("saveAs works with skipped steps (skipped step does not overwrite var)", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", okResponse("evaluate", "original"));
    responses.set("navigate", okResponse("navigate", "OK"));

    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [
      { tool: "evaluate", params: { expression: "first" }, saveAs: "val" },
      { tool: "evaluate", params: { expression: "second" }, saveAs: "val", if: "false" },
      { tool: "navigate", params: { url: "$val" } },
    ];

    await executePlan(steps, registry);

    // Third call should use "original" (not overwritten by skipped step)
    expect(callLog[1].params).toEqual({ url: "original" });
  });
});
