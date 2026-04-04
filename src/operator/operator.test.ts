import { describe, it, expect, vi, beforeEach } from "vitest";
import { Operator } from "./operator.js";
import { RuleEngine } from "./rule-engine.js";
import type { ToolRegistry } from "../registry.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import type { PlanStep } from "../plan/plan-executor.js";
import { RefNotFoundError } from "../tools/element-utils.js";

// --- Mock factories (analogous to plan-executor.test.ts) ---

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

interface MockRegistryOptions {
  /** Static responses per tool name */
  toolResponses?: Map<string, ToolResponse>;
  /** Dynamic handler that can change behavior per call */
  handler?: (name: string, params: Record<string, unknown>, callCount: number) => ToolResponse | Promise<ToolResponse>;
  /** Throw this error for specific tools */
  throwErrors?: Map<string, Error>;
}

function createMockRegistry(options: MockRegistryOptions): ToolRegistry {
  const callCounts = new Map<string, number>();

  return {
    executeTool: async (name: string, params: Record<string, unknown>) => {
      const count = (callCounts.get(name) ?? 0) + 1;
      callCounts.set(name, count);

      // Check if should throw
      if (options.throwErrors?.has(name)) {
        throw options.throwErrors.get(name)!;
      }

      // Dynamic handler
      if (options.handler) {
        return options.handler(name, params, count);
      }

      // Static responses
      const response = options.toolResponses?.get(name);
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

function createMockCdpClient(): CdpClient {
  const listeners = new Map<string, Set<{ callback: (params: unknown, sessionId?: string) => void; sessionId?: string }>>();

  return {
    send: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((method: string, callback: (params: unknown, sessionId?: string) => void, sessionId?: string) => {
      let set = listeners.get(method);
      if (!set) {
        set = new Set();
        listeners.set(method, set);
      }
      set.add({ callback, sessionId });
    }),
    off: vi.fn((method: string, callback: (params: unknown) => void) => {
      const set = listeners.get(method);
      if (set) {
        for (const entry of set) {
          if (entry.callback === callback) {
            set.delete(entry);
            break;
          }
        }
      }
    }),
    // Helper to simulate dialog events in tests
    _simulateEvent: (method: string, params: unknown, sessionId?: string) => {
      const set = listeners.get(method);
      if (set) {
        for (const entry of set) {
          if (entry.sessionId === undefined || entry.sessionId === sessionId) {
            entry.callback(params, sessionId);
          }
        }
      }
    },
  } as unknown as CdpClient & { _simulateEvent: (method: string, params: unknown, sessionId?: string) => void };
}

describe("Operator", () => {
  let cdpClient: ReturnType<typeof createMockCdpClient>;
  let ruleEngine: RuleEngine;
  const sessionId = "test-session";

  beforeEach(() => {
    cdpClient = createMockCdpClient();
    ruleEngine = new RuleEngine();
  });

  describe("Happy path — sequential step execution", () => {
    it("executes all steps sequentially and returns completed result", async () => {
      const responses = new Map<string, ToolResponse>();
      responses.set("navigate", okResponse("navigate", "Navigated to https://example.com"));
      responses.set("click", okResponse("click", "Clicked e5"));
      responses.set("screenshot", okResponse("screenshot", "Screenshot taken"));

      const registry = createMockRegistry({ toolResponses: responses });
      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);

      const steps: PlanStep[] = [
        { tool: "navigate", params: { url: "https://example.com" } },
        { tool: "click", params: { ref: "e5" } },
        { tool: "screenshot" },
      ];

      const result = await operator.executePlan(steps);

      expect(result.aborted).toBe(false);
      expect(result.stepsTotal).toBe(3);
      expect(result.stepsCompleted).toBe(3);
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0].tool).toBe("navigate");
      expect(result.steps[1].tool).toBe("click");
      expect(result.steps[2].tool).toBe("screenshot");
    });

    it("empty steps array returns empty result", async () => {
      const registry = createMockRegistry({ toolResponses: new Map() });
      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);

      const result = await operator.executePlan([]);

      expect(result.aborted).toBe(false);
      expect(result.stepsTotal).toBe(0);
      expect(result.stepsCompleted).toBe(0);
      expect(result.steps).toHaveLength(0);
      expect(result.totalRulesApplied).toBe(0);
    });

    it("step numbers are 1-indexed in results", async () => {
      const responses = new Map<string, ToolResponse>();
      responses.set("navigate", okResponse("navigate", "OK"));
      responses.set("click", okResponse("click", "OK"));

      const registry = createMockRegistry({ toolResponses: responses });
      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);

      const result = await operator.executePlan([
        { tool: "navigate", params: { url: "https://example.com" } },
        { tool: "click", params: { ref: "e1" } },
      ]);

      expect(result.steps[0].step).toBe(1);
      expect(result.steps[1].step).toBe(2);
    });
  });

  describe("Auto-scroll on element not found (M1: isError responses)", () => {
    it("scrolls and retries when tool returns isError 'not found' response", async () => {
      let clickAttempt = 0;
      const registry = createMockRegistry({
        handler: (name, _params, callCount) => {
          if (name === "click") {
            clickAttempt++;
            if (clickAttempt === 1) {
              // First attempt: return isError response (real production path)
              return errorResponse("click", "Element e5 not found. Did you mean e3?");
            }
            // Second attempt: success
            return okResponse("click", "Clicked e5");
          }
          // read_page calls during scroll recovery
          if (name === "read_page") {
            return okResponse("read_page", "a11y tree refreshed");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      expect(result.aborted).toBe(false);
      expect(result.stepsCompleted).toBe(1);
      expect(result.steps[0].scrollAttempts).toBe(1);
      expect(result.steps[0].rulesApplied.length).toBeGreaterThanOrEqual(1);
      expect(result.steps[0].rulesApplied.some((r) => r.action === "scroll-to")).toBe(true);

      // Verify scrollBy was called via CDP
      expect(cdpClient.send).toHaveBeenCalledWith(
        "Runtime.evaluate",
        { expression: "window.scrollBy(0, window.innerHeight * 0.8)" },
        sessionId,
      );

      // C3: Verify scrollTo(0,0) reset was called
      expect(cdpClient.send).toHaveBeenCalledWith(
        "Runtime.evaluate",
        { expression: "window.scrollTo(0,0)" },
        sessionId,
      );
    });

    it("also handles thrown RefNotFoundError for backward compatibility", async () => {
      let clickAttempt = 0;
      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            clickAttempt++;
            if (clickAttempt === 1) {
              throw new RefNotFoundError("Element e5 not found");
            }
            return okResponse("click", "Clicked e5");
          }
          if (name === "read_page") {
            return okResponse("read_page", "a11y tree refreshed");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      expect(result.aborted).toBe(false);
      expect(result.stepsCompleted).toBe(1);
      expect(result.steps[0].scrollAttempts).toBe(1);
    });

    it("aborts after max 3 scroll attempts", async () => {
      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            // Always return isError (element never becomes resolvable)
            return errorResponse("click", "Element e99 not found.");
          }
          if (name === "read_page") {
            return okResponse("read_page", "a11y tree refreshed");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e99" } },
      ]);

      expect(result.aborted).toBe(true);
      expect(result.steps[0].scrollAttempts).toBe(3);
      expect(result.steps[0].result.isError).toBe(true);
    });
  });

  describe("Dialog handling", () => {
    it("dismisses dialog that appears before step execution", async () => {
      // Use a handler that delays slightly so the dialog event can be processed
      let clickCalled = false;
      const registry = createMockRegistry({
        handler: async (name) => {
          if (name === "click") {
            clickCalled = true;
            return okResponse("click", "Clicked e1");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);

      // The dialog handler is registered via cdpClient.on during _setupDialogHandler.
      // We hook into the mock's on() so that when executePlan registers the listener,
      // we immediately fire a dialog event via that listener.
      const originalOn = cdpClient.on as ReturnType<typeof vi.fn>;
      (cdpClient as unknown as Record<string, unknown>).on = vi.fn((method: string, callback: (params: unknown, sessionId?: string) => void, sid?: string) => {
        originalOn(method, callback, sid);
        // Fire dialog immediately after registration so it's present before first step
        if (method === "Page.javascriptDialogOpening") {
          callback({ type: "alert", message: "Unexpected alert!" }, sid);
        }
      });

      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e1" } },
      ]);

      expect(result.steps[0].dialogsHandled).toBe(1);
      expect(result.steps[0].rulesApplied.some((r) => r.condition === "dialog-present")).toBe(true);

      // Verify Page.handleJavaScriptDialog was called with accept: false
      expect(cdpClient.send).toHaveBeenCalledWith(
        "Page.handleJavaScriptDialog",
        { accept: false },
        sessionId,
      );
    });

    it("handles dialog during step execution, retries step, and succeeds (M2)", async () => {
      let clickAttempt = 0;
      const registry = createMockRegistry({
        handler: (name, _params, callCount) => {
          if (name === "click") {
            clickAttempt++;
            if (clickAttempt === 1) {
              // First attempt fails due to dialog
              return errorResponse("click", "Dialog blocked interaction");
            }
            // Second attempt succeeds after dialog dismiss
            return okResponse("click", "Clicked e1");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);

      // We need the dialog to appear after step execution starts but before result is checked
      // Simulate by registering the dialog event and triggering it during execution
      const planPromise = operator.executePlan([
        { tool: "click", params: { ref: "e1" } },
      ]);

      // Trigger dialog event — the handler was registered in _setupDialogHandler
      const onCalls = (cdpClient.on as ReturnType<typeof vi.fn>).mock.calls;
      const dialogRegistration = onCalls.find((c: unknown[]) => c[0] === "Page.javascriptDialogOpening");
      if (dialogRegistration) {
        dialogRegistration[1]({ type: "confirm", message: "Are you sure?" }, sessionId);
      }

      const result = await planPromise;

      // Dialog should have been handled
      expect(result.steps[0].dialogsHandled).toBe(1);
      // M2: Step should have succeeded after dialog dismiss
      expect(result.aborted).toBe(false);
      expect(result.stepsCompleted).toBe(1);
      expect(result.steps[0].result.isError).toBeUndefined();
      expect(result.steps[0].result.content[0]).toHaveProperty("text", "Clicked e1");
    });

    it("registers and cleans up dialog event listener", async () => {
      const responses = new Map<string, ToolResponse>();
      responses.set("navigate", okResponse("navigate", "OK"));

      const registry = createMockRegistry({ toolResponses: responses });
      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);

      await operator.executePlan([{ tool: "navigate", params: { url: "https://example.com" } }]);

      // Verify on was called for dialog listener setup
      expect(cdpClient.on).toHaveBeenCalledWith(
        "Page.javascriptDialogOpening",
        expect.any(Function),
        sessionId,
      );

      // Verify off was called for cleanup
      expect(cdpClient.off).toHaveBeenCalledWith(
        "Page.javascriptDialogOpening",
        expect.any(Function),
      );
    });
  });

  describe("Metrics tracking", () => {
    it("tracks totalRulesApplied across steps", async () => {
      let attempt = 0;
      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            attempt++;
            if (attempt === 1) {
              return errorResponse("click", "Element e5 not found.");
            }
            return okResponse("click", "Clicked e5");
          }
          if (name === "read_page") {
            return okResponse("read_page", "a11y tree refreshed");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      expect(result.totalRulesApplied).toBeGreaterThanOrEqual(1);
    });

    it("tracks totalDialogsHandled across multiple steps", async () => {
      const registry = createMockRegistry({
        toolResponses: new Map([
          ["click", okResponse("click", "Clicked")],
          ["type", okResponse("type", "Typed")],
        ]),
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);

      // Start plan
      const planPromise = operator.executePlan([
        { tool: "click", params: { ref: "e1" } },
        { tool: "type", params: { ref: "e2", text: "hello" } },
      ]);

      // Simulate dialog before first step
      const onCalls = (cdpClient.on as ReturnType<typeof vi.fn>).mock.calls;
      const dialogRegistration = onCalls.find((c: unknown[]) => c[0] === "Page.javascriptDialogOpening");
      if (dialogRegistration) {
        dialogRegistration[1]({ type: "alert", message: "Alert!" }, sessionId);
      }

      const result = await planPromise;

      expect(result.totalDialogsHandled).toBeGreaterThanOrEqual(1);
    });

    it("elapsedMs is a positive number", async () => {
      const registry = createMockRegistry({
        toolResponses: new Map([
          ["navigate", okResponse("navigate", "OK")],
        ]),
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);
      const result = await operator.executePlan([
        { tool: "navigate", params: { url: "https://example.com" } },
      ]);

      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.elapsedMs).toBe("number");
    });

    it("stepsCompleted counts only successful steps when aborted", async () => {
      const responses = new Map<string, ToolResponse>();
      responses.set("navigate", okResponse("navigate", "OK"));
      responses.set("click", errorResponse("click", "Failed"));

      const registry = createMockRegistry({ toolResponses: responses });
      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);

      const result = await operator.executePlan([
        { tool: "navigate", params: { url: "https://example.com" } },
        { tool: "click", params: { ref: "e1" } },
        { tool: "screenshot" },
      ]);

      expect(result.aborted).toBe(true);
      expect(result.stepsTotal).toBe(3);
      expect(result.stepsCompleted).toBe(1); // Only navigate succeeded
    });
  });

  describe("Error handling", () => {
    it("aborts on non-recoverable errors (not RefNotFoundError)", async () => {
      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            return errorResponse("click", "CDP session disconnected");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);
      const result = await operator.executePlan([
        { tool: "navigate", params: { url: "https://example.com" } },
        { tool: "click", params: { ref: "e5" } },
        { tool: "screenshot" },
      ]);

      // Navigate succeeds, click returns error → abort, screenshot not reached
      // But navigate gets an okResponse from handler, and click returns errorResponse
      // Wait — the handler always returns based on name. navigate also goes through handler.
      // Let me re-check: handler returns okResponse for non-click tools.
      expect(result.aborted).toBe(true);
      expect(result.steps).toHaveLength(2); // navigate + click (aborted on click)
      expect(result.stepsCompleted).toBe(1);
    });

    it("catches thrown exceptions and converts to error response", async () => {
      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "evaluate") {
            throw new Error("CDP connection lost");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);
      const result = await operator.executePlan([
        { tool: "evaluate", params: { expression: "1+1" } },
      ]);

      expect(result.aborted).toBe(true);
      expect(result.steps[0].result.isError).toBe(true);
      expect(result.steps[0].result.content[0]).toHaveProperty("text", expect.stringContaining("CDP connection lost"));
    });
  });

  describe("scroll-to-0 workaround (C3)", () => {
    it("executes scrollBy then scrollTo(0,0) reset during auto-scroll", async () => {
      let clickAttempt = 0;
      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            clickAttempt++;
            if (clickAttempt === 1) {
              return errorResponse("click", "Element e5 not found.");
            }
            return okResponse("click", "Clicked e5");
          }
          if (name === "read_page") {
            return okResponse("read_page", "a11y tree refreshed");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);
      await operator.executePlan([{ tool: "click", params: { ref: "e5" } }]);

      const sendCalls = (cdpClient.send as ReturnType<typeof vi.fn>).mock.calls;

      // Verify scrollBy was called (viewport scroll)
      const scrollByCall = sendCalls.find(
        (c: unknown[]) => c[0] === "Runtime.evaluate" && (c[1] as Record<string, string>)?.expression?.includes("scrollBy"),
      );
      expect(scrollByCall).toBeDefined();

      // C3: Verify scrollTo(0,0) reset was actually executed
      const scrollResetCall = sendCalls.find(
        (c: unknown[]) => c[0] === "Runtime.evaluate" && (c[1] as Record<string, string>)?.expression?.includes("scrollTo(0,0)"),
      );
      expect(scrollResetCall).toBeDefined();
    });
  });
});
