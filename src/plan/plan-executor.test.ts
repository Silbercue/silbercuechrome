import { describe, it, expect, vi } from "vitest";
import { executePlan } from "./plan-executor.js";
import type { PlanStep, PlanOptions, SuspendedPlanResponse } from "./plan-executor.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolResponse } from "../types.js";
import { PlanStateStore } from "./plan-state-store.js";

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
    // Story 18.1: Plan-Executor ruft am Plan-Ende runAggregationHook
    // ueber den letzten Step auf. Mocks brauchen eine no-op-Implementation.
    runAggregationHook: async () => {},
  } as unknown as ToolRegistry;
}

function okResponse(tool: string, text: string, elapsedMs = 5): ToolResponse {
  return {
    content: [{ type: "text", text }],
    _meta: { elapsedMs, method: tool },
  };
}

/**
 * Story 18.1 (M1-Fix): Transition-Tool Response — sets `_meta.elementClass`
 * to `"clickable"`, which is the shape that the real `click` and `type`
 * handlers produce when the LLM interacted with a clickable element. The
 * aggregation-hook guard in `plan-executor.ts` only fires for transition
 * tools, so helper tests that want the hook to run MUST use this helper
 * for their last step.
 */
function transitionResponse(
  tool: string,
  text: string,
  elementClass: "clickable" | "widget-state" = "clickable",
  elapsedMs = 5,
): ToolResponse {
  return {
    content: [{ type: "text", text }],
    _meta: { elapsedMs, method: tool, elementClass },
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

  // FR-022: press_key and scroll work as plan steps
  it("executes press_key and scroll steps without Unknown tool error", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", okResponse("click", "Clicked element"));
    responses.set("press_key", okResponse("press_key", "Pressed Escape"));
    responses.set("scroll", okResponse("scroll", "Scrolled down 500px"));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e5" } },
      { tool: "press_key", params: { key: "Escape" } },
      { tool: "scroll", params: { direction: "down", amount: 500 } },
    ];

    const result = await executePlan(steps, registry);

    expect(result.isError).toBeFalsy();
    const textBlocks = result.content.filter((c) => c.type === "text");
    expect(textBlocks).toHaveLength(3);
    expect(textBlocks[0]).toHaveProperty("text", expect.stringContaining("OK click"));
    expect(textBlocks[1]).toHaveProperty("text", expect.stringContaining("OK press_key"));
    expect(textBlocks[2]).toHaveProperty("text", expect.stringContaining("OK scroll"));
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

  it("does NOT propagate image content blocks from successful screenshot steps (Story 18.2)", async () => {
    // Story 18.2 (AC-2): Image-Bloecke aus erfolgreichen Steps werden nicht
    // mehr in den Plan-Response uebernommen. Begruendung: ein Screenshot-Image
    // pro Zwischen-Step ist der Token-Killer (50–200 KB base64). Wer einen
    // Screenshot wirklich braucht, ruft `screenshot` ausserhalb des Plans
    // direkt auf, oder nutzt `errorStrategy: "screenshot"` (das Image bleibt
    // dann am Fehler-Step erhalten — siehe `appendErrorContext`).
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

    // Nur die Aggregations-Zeile, kein Image-Block
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toMatch(/\[1\/1\] OK screenshot \(20ms\):/);
    // Image-Bloecke duerfen NICHT in der Response sein
    const imageBlocks = result.content.filter((c) => c.type === "image");
    expect(imageBlocks).toHaveLength(0);
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

// ===== Story 6.5 Tests: Suspend/Resume =====

function isSuspended(result: unknown): result is SuspendedPlanResponse {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    (result as SuspendedPlanResponse).status === "suspended"
  );
}

describe("executePlan — Pre-Suspend (Story 6.5)", () => {
  it("suspends plan when step has suspend config without condition", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "Navigated"));
    responses.set("click", okResponse("click", "Clicked"));
    responses.set("type", okResponse("type", "Typed"));

    const registry = createCallLogRegistry(responses, callLog);
    const store = new PlanStateStore();
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "click", params: { ref: "e5" }, suspend: { question: "Welches Element?" } },
      { tool: "type", params: { ref: "e10", text: "hello" } },
    ];

    const result = await executePlan(steps, registry, undefined, store);

    expect(isSuspended(result)).toBe(true);
    if (!isSuspended(result)) throw new Error("Expected suspended");
    expect(result.status).toBe("suspended");
    expect(result.question).toBe("Welches Element?");
    expect(result.completedSteps).toHaveLength(1);
    expect(result.completedSteps[0].tool).toBe("navigate");
    expect(typeof result.planId).toBe("string");
    // executeTool should only have been called once (navigate), NOT for click or type
    expect(callLog).toHaveLength(1);
    expect(callLog[0].name).toBe("navigate");
  });

  it("suspend with context: screenshot includes screenshot", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "Navigated"));
    const screenshotResponse: ToolResponse = {
      content: [
        { type: "text", text: "Screenshot taken" },
        { type: "image", data: "base64screenshotdata", mimeType: "image/webp" },
      ],
      _meta: { elapsedMs: 20, method: "screenshot" },
    };
    responses.set("screenshot", screenshotResponse);

    const registry = createCallLogRegistry(responses);
    const store = new PlanStateStore();
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "navigate", params: { url: "https://example.com/2" }, suspend: { question: "Continue?", context: "screenshot" } },
    ];

    const result = await executePlan(steps, registry, undefined, store);

    expect(isSuspended(result)).toBe(true);
    if (!isSuspended(result)) throw new Error("Expected suspended");
    expect(result.screenshot).toBe("base64screenshotdata");
  });

  it("suspend without question uses default message", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "Navigated"));

    const registry = createCallLogRegistry(responses);
    const store = new PlanStateStore();
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" }, suspend: {} },
    ];

    const result = await executePlan(steps, registry, undefined, store);

    expect(isSuspended(result)).toBe(true);
    if (!isSuspended(result)) throw new Error("Expected suspended");
    expect(result.question).toBe("Plan paused -- condition met. How should we proceed?");
  });
});

describe("executePlan — Post-Suspend / Condition (Story 6.5)", () => {
  it("suspends after step when suspend.condition evaluates to true", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", okResponse("evaluate", "0"));

    const registry = createCallLogRegistry(responses, callLog);
    const store = new PlanStateStore();
    const steps: PlanStep[] = [
      {
        tool: "evaluate",
        params: { expression: "document.querySelectorAll('.item').length" },
        saveAs: "count",
        suspend: { condition: "$count === 0" },
      },
      { tool: "navigate", params: { url: "https://example.com" } },
    ];

    const result = await executePlan(steps, registry, undefined, store);

    expect(isSuspended(result)).toBe(true);
    if (!isSuspended(result)) throw new Error("Expected suspended");
    // Step was executed
    expect(callLog).toHaveLength(1);
    expect(callLog[0].name).toBe("evaluate");
    // Completed steps includes the executed step
    expect(result.completedSteps).toHaveLength(1);
    expect(result.completedSteps[0].tool).toBe("evaluate");
    expect(result.question).toBe("Plan paused -- condition met. How should we proceed?");
  });

  it("does not suspend when condition is false", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", okResponse("evaluate", "5"));
    responses.set("navigate", okResponse("navigate", "Navigated"));

    const registry = createCallLogRegistry(responses, callLog);
    const store = new PlanStateStore();
    const steps: PlanStep[] = [
      {
        tool: "evaluate",
        params: { expression: "document.querySelectorAll('.item').length" },
        saveAs: "count",
        suspend: { condition: "$count === 0" },
      },
      { tool: "navigate", params: { url: "https://example.com" } },
    ];

    const result = await executePlan(steps, registry, undefined, store);

    // Plan ran to completion, no suspend
    expect(isSuspended(result)).toBe(false);
    expect(callLog).toHaveLength(2);
    expect(callLog[0].name).toBe("evaluate");
    expect(callLog[1].name).toBe("navigate");
  });
});

describe("executePlan — Resume (Story 6.5)", () => {
  it("resume continues plan from suspended step", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "Navigated"));
    responses.set("click", okResponse("click", "Clicked"));
    responses.set("type", okResponse("type", "Typed"));

    const registry = createCallLogRegistry(responses, callLog);
    const store = new PlanStateStore();
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "click", params: { ref: "e5" }, suspend: { question: "Which element?" } },
      { tool: "type", params: { ref: "e10", text: "hello" } },
    ];

    // First: execute and get suspended
    const suspendResult = await executePlan(steps, registry, undefined, store);
    expect(isSuspended(suspendResult)).toBe(true);
    if (!isSuspended(suspendResult)) throw new Error("Expected suspended");

    callLog.length = 0; // reset call log

    // Resume
    const resumeOptions: PlanOptions = {
      resumeState: {
        suspendedAtIndex: 1,
        completedResults: suspendResult.completedSteps,
        vars: {},
        answer: "e15",
      },
    };
    const resumeResult = await executePlan(steps, registry, resumeOptions, store);

    expect(isSuspended(resumeResult)).toBe(false);
    // Should have executed click and type (steps 1 and 2)
    expect(callLog).toHaveLength(2);
    expect(callLog[0].name).toBe("click");
    expect(callLog[1].name).toBe("type");
  });

  it("resume with answer injects $answer variable", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "Navigated"));
    responses.set("click", okResponse("click", "Clicked"));

    const registry = createCallLogRegistry(responses, callLog);
    const store = new PlanStateStore();
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "click", params: { ref: "$answer" }, suspend: { question: "Which ref?" } },
    ];

    // Suspend
    const suspendResult = await executePlan(steps, registry, undefined, store);
    expect(isSuspended(suspendResult)).toBe(true);
    if (!isSuspended(suspendResult)) throw new Error("Expected suspended");
    callLog.length = 0;

    // Resume with answer
    const resumeOptions: PlanOptions = {
      resumeState: {
        suspendedAtIndex: 1,
        completedResults: suspendResult.completedSteps,
        vars: {},
        answer: "e15",
      },
    };
    const resumeResult = await executePlan(steps, registry, resumeOptions, store);

    expect(isSuspended(resumeResult)).toBe(false);
    // click should be called with ref: "e15" (from $answer)
    expect(callLog[0].name).toBe("click");
    expect(callLog[0].params).toEqual({ ref: "e15" });
  });

  it("resume with expired plan returns null from stateStore", () => {
    const store = new PlanStateStore(0); // TTL=0 → immediately expired
    const planId = store.suspend({
      steps: [{ tool: "navigate", params: { url: "https://example.com" } }],
      suspendedAtIndex: 0,
      vars: {},
      errorStrategy: "abort",
      completedResults: [],
      question: "Continue?",
    });

    const state = store.resume(planId);
    expect(state).toBeNull();
  });

  it("resume preserves vars from before suspend", async () => {
    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    let evalCount = 0;
    const registry = {
      executeTool: async (name: string, params: Record<string, unknown>) => {
        callLog.push({ name, params });
        if (name === "evaluate") {
          evalCount++;
          return {
            content: [{ type: "text" as const, text: `eval-result-${evalCount}` }],
            _meta: { elapsedMs: 1, method: name },
          };
        }
        return {
          content: [{ type: "text" as const, text: `${name} done` }],
          _meta: { elapsedMs: 1, method: name },
        };
      },
    } as unknown as ToolRegistry;

    const store = new PlanStateStore();
    const steps: PlanStep[] = [
      { tool: "evaluate", params: { expression: "first" }, saveAs: "val1" },
      { tool: "navigate", params: { url: "pause" }, suspend: { question: "Continue?" } },
      { tool: "evaluate", params: { expression: "$val1" } },
    ];

    // Execute — step 0 runs, step 1 suspends (pre-suspend, before execution)
    const suspendResult = await executePlan(steps, registry, undefined, store);
    expect(isSuspended(suspendResult)).toBe(true);
    if (!isSuspended(suspendResult)) throw new Error("Expected suspended");

    // The store holds the vars including val1
    const planId = suspendResult.planId;
    // Get saved state directly from the store to check vars
    // (We need to resume to get the state)

    callLog.length = 0;

    // Resume — the stored state should have val1 set from step 0
    const storedState = store.resume(planId);
    expect(storedState).not.toBeNull();
    expect(storedState!.vars["val1"]).toBe("eval-result-1");

    // Now actually execute resume (we already consumed the state, so re-suspend)
    const planId2 = store.suspend({
      steps,
      suspendedAtIndex: storedState!.suspendedAtIndex,
      vars: storedState!.vars,
      errorStrategy: storedState!.errorStrategy,
      completedResults: storedState!.completedResults,
      question: storedState!.question,
    });
    const storedState2 = store.resume(planId2);

    const resumeOptions: PlanOptions = {
      resumeState: {
        suspendedAtIndex: storedState2!.suspendedAtIndex,
        completedResults: storedState2!.completedResults,
        vars: storedState2!.vars,
        answer: "some-answer",
      },
    };
    await executePlan(steps, registry, resumeOptions, store);

    // Step 1 (navigate) executes, then step 2 (evaluate with $val1) should use "eval-result-1"
    expect(callLog[1].params).toEqual({ expression: "eval-result-1" });
  });
});

describe("executePlan — Suspend Edge Cases (Story 6.5)", () => {
  it("suspend without stateStore logs warning and continues", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "Navigated"));
    responses.set("click", okResponse("click", "Clicked"));

    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "click", params: { ref: "e5" }, suspend: { question: "Pause?" } },
    ];

    // No stateStore passed
    const result = await executePlan(steps, registry);

    // Plan should run through without suspending
    expect(isSuspended(result)).toBe(false);
    expect(callLog).toHaveLength(2);
    expect(callLog[0].name).toBe("navigate");
    expect(callLog[1].name).toBe("click");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("suspend config on step but no stateStore provided"),
    );

    warnSpy.mockRestore();
  });

  it("completedSteps in SuspendedPlanResponse contains only finished steps", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", okResponse("navigate", "Navigated"));
    responses.set("evaluate", okResponse("evaluate", "42"));

    const registry = createCallLogRegistry(responses);
    const store = new PlanStateStore();
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "evaluate", params: { expression: "1+1" } },
      { tool: "navigate", params: { url: "https://example.com/page2" }, suspend: { question: "OK?" } },
      { tool: "navigate", params: { url: "https://example.com/page3" } },
    ];

    const result = await executePlan(steps, registry, undefined, store);

    expect(isSuspended(result)).toBe(true);
    if (!isSuspended(result)) throw new Error("Expected suspended");
    // Steps 0 and 1 completed, step 2 suspended (pre-suspend)
    expect(result.completedSteps).toHaveLength(2);
    expect(result.completedSteps[0].tool).toBe("navigate");
    expect(result.completedSteps[1].tool).toBe("evaluate");
  });

  it("post-suspend condition with stateStore warning logs and continues", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const callLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", okResponse("evaluate", "0"));
    responses.set("navigate", okResponse("navigate", "Navigated"));

    const registry = createCallLogRegistry(responses, callLog);
    const steps: PlanStep[] = [
      {
        tool: "evaluate",
        params: { expression: "0" },
        saveAs: "count",
        suspend: { condition: "$count === 0" },
      },
      { tool: "navigate", params: { url: "https://example.com" } },
    ];

    // No stateStore → condition met but no store
    const result = await executePlan(steps, registry);

    expect(isSuspended(result)).toBe(false);
    expect(callLog).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("suspend condition met but no stateStore provided"),
    );

    warnSpy.mockRestore();
  });
});

// --- Story 18.1: Ambient-Context-Hook-Suppression in run_plan ---

describe("executePlan — Ambient-Context suppression (Story 18.1)", () => {
  /**
   * Mock registry that:
   *  - returns canned responses for known tools
   *  - records the options parameter of every executeTool call
   *  - simulates the Ambient-Context hook behavior: if the executeTool
   *    caller DOES NOT pass skipOnToolResultHook=true, the mock appends
   *    a "[hook] ambient-context" text block to the response — mirroring
   *    what the real hook would do.
   *  - runAggregationHook appends "[agg] aggregated-context" regardless
   */
  function createHookAwareRegistry(
    responses: Map<string, ToolResponse>,
  ): {
    registry: ToolRegistry;
    callOptions: Array<Record<string, unknown> | undefined>;
    aggregationCalls: Array<{ toolName: string }>;
  } {
    const callOptions: Array<Record<string, unknown> | undefined> = [];
    const aggregationCalls: Array<{ toolName: string }> = [];
    const registry = {
      executeTool: vi.fn(
        async (
          name: string,
          _params: Record<string, unknown>,
          _sessionIdOverride: string | undefined,
          options?: Record<string, unknown>,
        ) => {
          callOptions.push(options);
          const canned = responses.get(name);
          if (!canned) {
            return {
              content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
              isError: true,
              _meta: { elapsedMs: 0, method: name },
            };
          }
          // Deep-clone so we don't mutate the shared fixture across calls
          const cloned: ToolResponse = {
            ...canned,
            content: [...canned.content],
            _meta: canned._meta ? { ...canned._meta } : undefined,
          };
          // Simulate the onToolResult hook: only append when NOT skipped
          if (!options || options.skipOnToolResultHook !== true) {
            cloned.content.push({ type: "text", text: "[hook] ambient-context" });
          }
          return cloned;
        },
      ),
      runAggregationHook: vi.fn(async (result: ToolResponse, toolName: string) => {
        aggregationCalls.push({ toolName });
        result.content.push({ type: "text", text: "[agg] aggregated-context" });
      }),
    } as unknown as ToolRegistry;
    return { registry, callOptions, aggregationCalls };
  }

  it("propagates skipOnToolResultHook=true to every intermediate step", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", okResponse("click", "clicked"));
    responses.set("type", okResponse("type", "typed"));
    responses.set("wait_for", okResponse("wait_for", "ok"));

    const { registry, callOptions } = createHookAwareRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e1" } },
      { tool: "type", params: { ref: "e2", text: "hi" } },
      { tool: "wait_for", params: { ms: 10 } },
    ];

    await executePlan(steps, registry);

    expect(callOptions).toHaveLength(3);
    for (const opts of callOptions) {
      expect(opts).toEqual({ skipOnToolResultHook: true });
    }
  });

  it("does not inject ambient-context into intermediate step results", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", okResponse("click", "clicked"));
    responses.set("type", okResponse("type", "typed"));
    responses.set("wait_for", okResponse("wait_for", "waited"));

    const { registry } = createHookAwareRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e1" } },
      { tool: "type", params: { ref: "e2", text: "hi" } },
      { tool: "wait_for", params: { ms: 10 } },
    ];

    const result = await executePlan(steps, registry);
    const allText = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    // Intermediate step text must NOT contain the ambient-context marker
    expect(allText).not.toContain("[hook] ambient-context");
  });

  it("runs the aggregation hook exactly once at the plan end", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", transitionResponse("click", "clicked"));
    responses.set("type", transitionResponse("type", "typed"));

    const { registry, aggregationCalls } = createHookAwareRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e1" } },
      { tool: "type", params: { ref: "e2", text: "hi" } },
    ];

    const result = await executePlan(steps, registry);

    // Aggregation hook called exactly once over the last step
    expect(aggregationCalls).toHaveLength(1);
    expect(aggregationCalls[0].toolName).toBe("type");
    // Its output is visible in the aggregated plan response (last step text)
    const allText = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(allText).toContain("[agg] aggregated-context");
  });

  // --- M1 (Code-Review 18.1): Transition-Category Guard ---

  it("skips the aggregation hook when the last step is not a transition tool", async () => {
    // M1-Fix: the aggregation hook is guarded by the Transition-Category
    // check — only `click`/`type` calls set `_meta.elementClass`, which
    // matches "clickable" or "widget-state". Read-only or wait tools
    // (here: `wait_for`, which has no `elementClass`) must NOT drive the
    // aggregation hook, because they do not change the DOM and the hook
    // would just add useless tokens.
    const responses = new Map<string, ToolResponse>();
    responses.set("click", transitionResponse("click", "clicked"));
    responses.set("wait_for", okResponse("wait_for", "waited")); // no elementClass

    const { registry, aggregationCalls } = createHookAwareRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e1" } },
      { tool: "wait_for", params: { ms: 10 } },
    ];

    await executePlan(steps, registry);

    // Last step is `wait_for` without `elementClass` → hook must NOT fire
    expect(aggregationCalls).toHaveLength(0);
  });

  it("fires the aggregation hook when the last step is a widget-state transition", async () => {
    // Covers the `widget-state` branch of the Transition-Category guard —
    // i.e. a `type` into a form input / checkbox where `classifyRef`
    // returned "widget-state".
    const responses = new Map<string, ToolResponse>();
    responses.set("type", transitionResponse("type", "typed", "widget-state"));

    const { registry, aggregationCalls } = createHookAwareRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "type", params: { ref: "e1", text: "hello" } },
    ];

    await executePlan(steps, registry);

    expect(aggregationCalls).toHaveLength(1);
    expect(aggregationCalls[0].toolName).toBe("type");
  });

  it("skips the aggregation hook when the last step failed (errorStrategy=continue)", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", okResponse("click", "clicked"));
    responses.set("type", errorResponse("type", "type failed"));

    const { registry, aggregationCalls } = createHookAwareRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e1" } },
      { tool: "type", params: { ref: "e2", text: "hi" } },
    ];

    const result = await executePlan(steps, registry, { errorStrategy: "continue" });

    expect(aggregationCalls).toHaveLength(0);
    const allText = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(allText).not.toContain("[agg] aggregated-context");
    // Failed step is still visible in the response
    expect(allText).toContain("FAIL type");
    // Full error context from the failed step is preserved (AC-5)
    expect(allText).toContain("type failed");
    // errorStrategy="continue" only sets isError when EVERY step failed.
    // With 1 OK + 1 FAIL we get a partial-failure plan (isError undefined),
    // which is the current baseline behavior — the Story-18.1 fix must not
    // regress it.
    const partialFailureSummary = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(partialFailureSummary).toContain("Plan completed with errors");
  });

  it("skips the aggregation hook on abort (first-step error)", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", errorResponse("click", "click failed"));
    responses.set("type", okResponse("type", "should not run"));

    const { registry, aggregationCalls } = createHookAwareRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e1" } },
      { tool: "type", params: { ref: "e2", text: "hi" } },
    ];

    const result = await executePlan(steps, registry); // default: abort

    expect(aggregationCalls).toHaveLength(0);
    // Error context is still in the response — AC-5 guarantee
    const allText = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(allText).toContain("FAIL click");
    expect(allText).toContain("click failed");
    expect(result.isError).toBe(true);
  });

  it("skips the aggregation hook when the last step was skipped by its condition", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", okResponse("click", "clicked"));

    const { registry, aggregationCalls } = createHookAwareRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e1" } },
      { tool: "click", params: { ref: "e2" }, if: "$neverTrue" },
    ];

    await executePlan(steps, registry, { vars: { neverTrue: false } });

    expect(aggregationCalls).toHaveLength(0);
  });

  it("still runs the aggregation hook when the last executed step succeeded (errorStrategy=continue mix)", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", errorResponse("click", "click failed"));
    responses.set("type", transitionResponse("type", "typed ok"));

    const { registry, aggregationCalls } = createHookAwareRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e1" } },
      { tool: "type", params: { ref: "e2", text: "hi" } },
    ];

    await executePlan(steps, registry, { errorStrategy: "continue" });

    // Last step (type) succeeded, so aggregation fires over it
    expect(aggregationCalls).toHaveLength(1);
    expect(aggregationCalls[0].toolName).toBe("type");
  });

  it("aggregation-hook exceptions do not break the plan response", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", okResponse("click", "clicked"));

    const registry = {
      executeTool: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "clicked" }],
        _meta: { elapsedMs: 1, method: "click" },
      })),
      runAggregationHook: vi.fn(async () => {
        throw new Error("hook exploded");
      }),
    } as unknown as ToolRegistry;

    const steps: PlanStep[] = [{ tool: "click", params: { ref: "e1" } }];

    const result = await executePlan(steps, registry);

    // Plan still returns a normal response despite the hook blowing up
    expect(result.isError).toBeFalsy();
    expect(result._meta).toBeDefined();
    expect(result._meta!.stepsCompleted).toBe(1);
  });
});

// --- Story 18.2: Step-Response-Aggregation verschmaelern (FR-034) ---

describe("executePlan — Step-Response-Aggregation (Story 18.2)", () => {
  function refResponse(tool: string, text: string, elapsedMs = 5): ToolResponse {
    return {
      content: [{ type: "text", text }],
      _meta: { elapsedMs, method: tool },
    };
  }

  it("successful steps render as single-line aggregation with ref-extraction", async () => {
    // 3 Steps, alle OK, Mock-Tool gibt "Clicked element e5" zurueck → die
    // Aggregations-Zeile fasst auf `ref=e5` zusammen.
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", refResponse("navigate", "Navigated to https://example.com", 100));
    responses.set("click", refResponse("click", "Clicked element e5", 30));
    responses.set("type", refResponse("type", "Typed 'hello' into e7", 25));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "click", params: { ref: "e5" } },
      { tool: "type", params: { ref: "e7", text: "hello" } },
    ];

    const result = await executePlan(steps, registry);
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    expect(textBlocks).toHaveLength(3);
    // navigate hat keinen Ref → Kurztext-Pfad
    expect(textBlocks[0].text).toBe(
      "[1/3] OK navigate (100ms): Navigated to https://example.com",
    );
    // click hat `e5` → ref=e5
    expect(textBlocks[1].text).toBe("[2/3] OK click (30ms): ref=e5");
    // type hat `e7` → ref=e7
    expect(textBlocks[2].text).toBe("[3/3] OK type (25ms): ref=e7");
  });

  it("ref=eN prefix format takes priority over bare eN", async () => {
    // Wenn Tool `"ref=e3 and also e9"` schreibt, soll `e3` gewinnen.
    const responses = new Map<string, ToolResponse>();
    responses.set("click", refResponse("click", "ref=e3 and also e9", 12));
    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "click", params: { ref: "e3" } }];

    const result = await executePlan(steps, registry);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("[1/1] OK click (12ms): ref=e3");
  });

  it("multi-line tool output is truncated to first line without newlines", async () => {
    // Mock-Tool gibt einen Multi-Line-Output ohne Ref zurueck → die
    // Aggregations-Zeile enthaelt nur die erste Zeile, kein \nline2.
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", refResponse("evaluate", "line1\nline2\nline3", 8));
    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "evaluate", params: { expression: "1" } }];

    const result = await executePlan(steps, registry);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("[1/1] OK evaluate (8ms): line1");
    expect(text).not.toContain("\nline2");
    expect(text).not.toContain("line3");
  });

  it("compact text longer than 80 chars is truncated with ellipsis", async () => {
    // Erste Zeile > STEP_LINE_COMPACT_MAX_CHARS (80) → Truncate auf 77 + "..."
    const longLine = "x".repeat(120); // keine Refs, kein Newline
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", refResponse("evaluate", longLine, 4));
    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "evaluate", params: { expression: "1" } }];

    const result = await executePlan(steps, registry);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    // Erwartung: Suffix ist exakt 80 Zeichen lang (77 x + "...")
    const suffix = text.replace("[1/1] OK evaluate (4ms): ", "");
    expect(suffix).toHaveLength(80);
    expect(suffix.endsWith("...")).toBe(true);
    expect(suffix.startsWith("x".repeat(77))).toBe(true);
  });

  it("step with no text output renders as <no-output>", async () => {
    // Mock-Tool gibt content: [] zurueck → Zeile endet mit `: <no-output>`
    const responses = new Map<string, ToolResponse>();
    responses.set("screenshot", {
      content: [],
      _meta: { elapsedMs: 18, method: "screenshot" },
    });
    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "screenshot" }];

    const result = await executePlan(steps, registry);
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("[1/1] OK screenshot (18ms): <no-output>");
  });

  it("image blocks from successful steps are excluded from aggregation", async () => {
    // AC-2: Image-Bloecke aus erfolgreichen Steps duerfen nicht durchkommen.
    const screenshotResponse: ToolResponse = {
      content: [
        { type: "text", text: "Screenshot taken" },
        { type: "image", data: "base64data", mimeType: "image/webp" },
      ],
      _meta: { elapsedMs: 20, method: "screenshot" },
    };
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", refResponse("navigate", "Navigated", 50));
    responses.set("screenshot", screenshotResponse);

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "screenshot" },
    ];

    const result = await executePlan(steps, registry);

    // 2 text-Bloecke, 0 Image-Bloecke
    const imageBlocks = result.content.filter((c) => c.type === "image");
    expect(imageBlocks).toHaveLength(0);
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[1].text).toBe("[2/2] OK screenshot (20ms): Screenshot taken");
  });

  it("skipped steps still render as one line with condition", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", refResponse("click", "Clicked element e5"));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e5" }, if: "$skip === true" },
    ];

    const result = await executePlan(steps, registry, { vars: { skip: false } });
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].text).toContain("SKIP click");
    expect(textBlocks[0].text).toContain("condition:");
    expect(textBlocks[0].text).toContain("$skip === true");
  });

  it("failed step with errorStrategy=continue keeps full error context, OK steps stay single-line", async () => {
    // AC-4: 4 Steps, Step 2 failed (mit Multi-Line-Fehlertext), continue.
    // Erwartung: Step 1, 3, 4 sind ein-zeilig; Step 2 enthaelt alle text-
    // Bloecke des Fehler-Tools (Multi-Line, ungekuerzt).
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", refResponse("navigate", "Navigated to https://example.com", 90));
    responses.set("click", {
      content: [
        { type: "text", text: "Element not found\nTried selector e99\nNo match" },
      ],
      isError: true,
      _meta: { elapsedMs: 12, method: "click" },
    });
    responses.set("evaluate", refResponse("evaluate", "42", 7));
    responses.set("type", refResponse("type", "Typed 'foo' into e3", 19));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "click", params: { ref: "e99" } },
      { tool: "evaluate", params: { expression: "1+1" } },
      { tool: "type", params: { ref: "e3", text: "foo" } },
    ];

    const result = await executePlan(steps, registry, { errorStrategy: "continue" });
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );

    // Step 1, 3, 4 OK ein-zeilig; Step 2 FAIL voll; plus continue-Footer
    // (text count: 4 step lines + 1 footer = 5)
    expect(textBlocks.length).toBe(5);
    expect(textBlocks[0].text).toBe(
      "[1/4] OK navigate (90ms): Navigated to https://example.com",
    );
    // FAIL-Step behaelt vollen Multi-Line-Kontext
    expect(textBlocks[1].text).toBe(
      "[2/4] FAIL click (12ms): Element not found\nTried selector e99\nNo match",
    );
    // OK-Steps nach dem FAIL bleiben ein-zeilig
    expect(textBlocks[2].text).toBe("[3/4] OK evaluate (7ms): 42");
    expect(textBlocks[3].text).toBe("[4/4] OK type (19ms): ref=e3");
    expect(textBlocks[4].text).toContain("Plan completed with errors");
  });

  it("error step with screenshot strategy keeps image block (Story 18.2 AC-4)", async () => {
    // Step 1 OK, Step 2 failed mit errorStrategy=screenshot → der angehaengte
    // Screenshot-Image-Block muss am Fehler-Step sichtbar bleiben.
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", refResponse("navigate", "Navigated", 60));
    responses.set("click", {
      content: [{ type: "text", text: "Not found e99" }],
      isError: true,
      _meta: { elapsedMs: 8, method: "click" },
    });
    responses.set("screenshot", {
      content: [
        { type: "text", text: "Screenshot taken" },
        { type: "image", data: "base64-error-shot", mimeType: "image/webp" },
      ],
      _meta: { elapsedMs: 20, method: "screenshot" },
    });

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "click", params: { ref: "e99" } },
    ];

    const result = await executePlan(steps, registry, {
      errorStrategy: "screenshot",
    });

    // Plan ist aborted, Image-Block muss da sein (am Fehler-Step)
    expect(result.isError).toBe(true);
    const imageBlocks = result.content.filter((c) => c.type === "image");
    expect(imageBlocks).toHaveLength(1);
    expect(
      (imageBlocks[0] as { type: "image"; data: string; mimeType: string }).data,
    ).toBe("base64-error-shot");

    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    // Step 1 OK ein-zeilig
    expect(textBlocks[0].text).toBe("[1/2] OK navigate (60ms): Navigated");
    // Step 2 FAIL voll (text-Bloecke joined)
    expect(textBlocks[1].text).toContain("[2/2] FAIL click (8ms):");
    expect(textBlocks[1].text).toContain("Not found e99");
    // Footer
    expect(textBlocks.some((b) => b.text.includes("Plan aborted at step 2/2"))).toBe(true);
  });

  it("aborted plan still uses verbose error format for the failing step", async () => {
    // errorStrategy=abort, Step 2 failed → Step 1 ein-zeilig (OK), Step 2
    // voll (FAIL), Footer "Plan aborted at step 2/3"
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", refResponse("navigate", "Navigated to start", 40));
    responses.set("click", {
      content: [{ type: "text", text: "Selector failed\nstale ref" }],
      isError: true,
      _meta: { elapsedMs: 5, method: "click" },
    });
    responses.set("type", refResponse("type", "should not run", 1));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "click", params: { ref: "e99" } },
      { tool: "type", params: { ref: "e1", text: "foo" } },
    ];

    const result = await executePlan(steps, registry); // default = abort

    expect(result.isError).toBe(true);
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    // 1 OK + 1 FAIL + abort-Footer = 3 text blocks
    expect(textBlocks).toHaveLength(3);
    expect(textBlocks[0].text).toBe("[1/3] OK navigate (40ms): Navigated to start");
    // FAIL behaelt Multi-Line-Kontext
    expect(textBlocks[1].text).toBe(
      "[2/3] FAIL click (5ms): Selector failed\nstale ref",
    );
    expect(textBlocks[2].text).toContain("Plan aborted at step 2/3");
  });

  it("aggregation-hook overlay is appended as separate block, not squeezed into the last step line", async () => {
    // Aggregations-Hook (Story 18.1) mutiert das letzte Step-Result mit
    // einem zusaetzlichen text-Block. Story 18.2 schneidet diesen Overlay
    // aus dem Step-Result heraus und haengt ihn separat an. Der LLM sieht
    // die Hook-Output-Zeile am Plan-Ende, nicht in der kompakten Step-
    // Aggregation gequetscht.
    const aggregationCalls: Array<{ toolName: string }> = [];
    const registry = {
      executeTool: vi.fn(
        async (
          name: string,
          _params: Record<string, unknown>,
        ): Promise<ToolResponse> => {
          if (name === "click") {
            return {
              content: [{ type: "text", text: "Clicked element e5" }],
              _meta: { elapsedMs: 11, method: "click", elementClass: "clickable" },
            };
          }
          return {
            content: [{ type: "text", text: `${name} done` }],
            _meta: { elapsedMs: 5, method: name },
          };
        },
      ),
      runAggregationHook: vi.fn(async (result: ToolResponse, toolName: string) => {
        aggregationCalls.push({ toolName });
        result.content.push({
          type: "text",
          text: "[hook] dom-diff: +1 added, -0 removed",
        });
      }),
    } as unknown as ToolRegistry;

    const steps: PlanStep[] = [{ tool: "click", params: { ref: "e5" } }];
    const result = await executePlan(steps, registry);

    expect(aggregationCalls).toHaveLength(1);

    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    // Erwartung: 2 text-Bloecke — Step-Aggregation + Overlay-Block
    expect(textBlocks).toHaveLength(2);
    // Step-Zeile bleibt kompakt mit ref=e5 (Overlay nicht eingequetscht)
    expect(textBlocks[0].text).toBe("[1/1] OK click (11ms): ref=e5");
    // Overlay als eigener Block
    expect(textBlocks[1].text).toBe("[hook] dom-diff: +1 added, -0 removed");
  });

  it("H1-Fix: hook that unshifts (not pushes) new blocks — overlay extracted correctly via reference-set diffing", async () => {
    // Review 18.2 H1: Der alte `slice(contentLengthBefore)`-Schnitt hat
    // implizit angenommen, dass der Hook neue Bloecke per `push` am Ende
    // anfuegt. Mit unshift (Hook schiebt neuen Block an die Spitze) wuerde
    // der alte Code den Overlay-Block und den Original-Step-Text
    // vertauschen — Step-Line enthaelt Hook-Text, Overlay enthaelt Original.
    // Der Fix via Set-Based-Diffing darf davon nicht betroffen sein.
    const registry = {
      executeTool: vi.fn(
        async (name: string): Promise<ToolResponse> => {
          if (name === "click") {
            return {
              content: [{ type: "text", text: "Clicked element e5" }],
              _meta: { elapsedMs: 13, method: "click", elementClass: "clickable" },
            };
          }
          return {
            content: [{ type: "text", text: `${name} done` }],
            _meta: { elapsedMs: 2, method: name },
          };
        },
      ),
      runAggregationHook: vi.fn(async (result: ToolResponse, _toolName: string) => {
        // Hook schiebt den Overlay-Block an den ANFANG (unshift), nicht ans
        // Ende — das ist der H1-Stresstest.
        result.content.unshift({
          type: "text",
          text: "[hook-unshift] dom-diff-prepended",
        });
      }),
    } as unknown as ToolRegistry;

    const steps: PlanStep[] = [{ tool: "click", params: { ref: "e5" } }];
    const result = await executePlan(steps, registry);

    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    // Erwartung: 2 text-Bloecke — Step-Aggregation + Overlay
    expect(textBlocks).toHaveLength(2);
    // Step-Zeile enthaelt den ORIGINAL-Step-Text (ref=e5), NICHT den Hook-
    // Text. Mit dem alten `slice`-Schnitt waere hier
    // "ref=[hook-unshift]..." gelandet, weil slice(1) den Original-Step-
    // Block als Overlay genommen und den unshift-Block in der Step-Line
    // gerendert haette.
    expect(textBlocks[0].text).toBe("[1/1] OK click (13ms): ref=e5");
    // Overlay als eigener Block am Ende, mit genau dem Hook-Text
    expect(textBlocks[1].text).toBe("[hook-unshift] dom-diff-prepended");
  });

  it("M1-Fix: bare eN in free-form error text is NOT extracted when params.ref differs", async () => {
    // Review 18.2 M1: Der alte Regex `\b(e\d+)\b` wuerde `e500` in
    // "HTTP error 500" matchen (false positive) oder ein fremdes `e99`
    // in einem Fehler-Text. Die Haertung via params.ref-Cross-Validation
    // verhindert das — bare-`eN`-Matches werden nur akzeptiert, wenn sie
    // mit dem in params erwarteten Ref uebereinstimmen.
    const responses = new Map<string, ToolResponse>();
    // Step 1: click mit e5, Output enthaelt einen fremden `e500`-Token
    // (simuliert z.B. ein Success-Log-Message "Fired event e500 on ancestor")
    responses.set(
      "click",
      refResponse("click", "Fired event e500 on ancestor of element", 10),
    );

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "click", params: { ref: "e5" } }];

    const result = await executePlan(steps, registry);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    // Erwartung: KEIN ref=e500. Stattdessen Kurztext-Pfad, weil `e500`
    // nicht mit `params.ref=e5` matched.
    expect(text).not.toContain("ref=e500");
    expect(text).toBe(
      "[1/1] OK click (10ms): Fired event e500 on ancestor of element",
    );
  });

  it("M1-Fix: bare eN that matches params.ref is still extracted (positive path remains intact)", async () => {
    // Gegenbeispiel: Wenn der bare Ref mit params.ref uebereinstimmt, soll
    // die Extraktion wie gehabt funktionieren — diese Haertung darf den
    // Happy-Path nicht brechen.
    const responses = new Map<string, ToolResponse>();
    responses.set("click", refResponse("click", "Clicked element e5", 10));

    const registry = createMockRegistry(responses);
    const steps: PlanStep[] = [{ tool: "click", params: { ref: "e5" } }];

    const result = await executePlan(steps, registry);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("[1/1] OK click (10ms): ref=e5");
  });

  it("M1-Fix: `e2e` in text is not extracted as ref even when params.ref exists", async () => {
    // `\b(e\d+)\b` fordert Word-Boundary nach den Ziffern. In `e2e-test`
    // folgt der `2` ein `e` (Word-Char), also kein Boundary → kein Match.
    // Dieser Test verifiziert das explizit, damit `e2e` (End-to-End) in
    // Tool-Output nicht versehentlich als Ref interpretiert wird.
    const responses = new Map<string, ToolResponse>();
    responses.set(
      "evaluate",
      refResponse(
        "evaluate",
        "Running e2e-test suite — 42 tests passed",
        7,
      ),
    );

    const registry = createMockRegistry(responses);
    // evaluate hat keinen `ref`-Param → expectedRef = undefined → nur
    // Praefix-Format kann matchen, und hier gibt es kein `ref=eN`-Praefix.
    const steps: PlanStep[] = [{ tool: "evaluate", params: { expression: "1" } }];

    const result = await executePlan(steps, registry);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toMatch(/ref=e\d/);
    expect(text).toBe(
      "[1/1] OK evaluate (7ms): Running e2e-test suite — 42 tests passed",
    );
  });

  it("M1-Fix: prefix format `ref=eN` is always accepted, even without params.ref", async () => {
    // Das Praefix-Format ist explizit und sicher — es matched unabhaengig
    // davon, ob params.ref gesetzt ist. Diese Regression-Guard stellt
    // sicher, dass die Haertung den Praefix-Pfad nicht beeintraechtigt.
    const responses = new Map<string, ToolResponse>();
    responses.set(
      "evaluate",
      refResponse("evaluate", "discovered ref=e42 in current page", 5),
    );
    const registry = createMockRegistry(responses);
    // KEIN ref in params — trotzdem soll das Praefix-Match greifen.
    const steps: PlanStep[] = [{ tool: "evaluate", params: { expression: "1" } }];

    const result = await executePlan(steps, registry);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("[1/1] OK evaluate (5ms): ref=e42");
  });

  it("steps with FAIL after a hook overlay attempt: overlay is not extracted (hook only fires on success)", async () => {
    // Sicherheitspruefung: Wenn der letzte Step ein FAIL ist, laeuft der
    // Aggregations-Hook nicht (Story 18.1-Guard) → kein Overlay → die
    // Step-Liste enthaelt nur die normale FAIL-Verbose-Form.
    const aggregationCalls: Array<{ toolName: string }> = [];
    const responses = new Map<string, ToolResponse>();
    responses.set("click", refResponse("click", "ok"));
    responses.set("type", {
      content: [{ type: "text", text: "type failed" }],
      isError: true,
      _meta: { elapsedMs: 4, method: "type" },
    });

    const registry = {
      executeTool: vi.fn(async (name: string) => responses.get(name)!),
      runAggregationHook: vi.fn(async (_r: ToolResponse, toolName: string) => {
        aggregationCalls.push({ toolName });
      }),
    } as unknown as ToolRegistry;

    const steps: PlanStep[] = [
      { tool: "click", params: { ref: "e1" } },
      { tool: "type", params: { ref: "e2", text: "x" } },
    ];

    const result = await executePlan(steps, registry, { errorStrategy: "continue" });

    expect(aggregationCalls).toHaveLength(0);
    const textBlocks = result.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    // 2 step-Bloecke + continue-Footer = 3
    expect(textBlocks).toHaveLength(3);
    expect(textBlocks[0].text).toContain("[1/2] OK click");
    expect(textBlocks[1].text).toContain("[2/2] FAIL type");
    expect(textBlocks[1].text).toContain("type failed");
  });
});
