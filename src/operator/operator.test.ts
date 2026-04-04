import { describe, it, expect, vi, beforeEach } from "vitest";
import { Operator } from "./operator.js";
import { RuleEngine } from "./rule-engine.js";
import type { ToolRegistry } from "../registry.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import type { PlanStep } from "../plan/plan-executor.js";
import type { MicroLlmProvider, MicroLlmRequest, MicroLlmResponse } from "./types.js";
import { RefNotFoundError } from "../tools/element-utils.js";
import { NullMicroLlm, MicroLlmTimeoutError, MicroLlmUnavailableError } from "./micro-llm.js";

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

    it("aborts after max 3 scroll attempts, then consults Micro-LLM (H1)", async () => {
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

      // NullMicroLlm: isAvailable() returns false → escalation
      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e99" } },
      ]);

      expect(result.aborted).toBe(true);
      expect(result.steps[0].scrollAttempts).toBe(3);
      expect(result.steps[0].result.isError).toBe(true);
      // H1: After scroll exhaustion, Micro-LLM is consulted (NullMicroLlm → escalation)
      expect(result.steps[0].microLlmCalled).toBe(true);
      expect(result.steps[0].escalationNeeded).toBe(true);
      expect(result.totalEscalations).toBe(1);
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

  // --- Micro-LLM Integration Tests ---

  describe("Micro-LLM fallback", () => {
    function createMockMicroLlm(overrides?: {
      isAvailable?: boolean;
      decideResult?: MicroLlmResponse;
      decideError?: Error;
    }): MicroLlmProvider {
      return {
        isAvailable: vi.fn().mockResolvedValue(overrides?.isAvailable ?? true),
        decide: overrides?.decideError
          ? vi.fn().mockRejectedValue(overrides.decideError)
          : vi.fn().mockResolvedValue(
              overrides?.decideResult ?? {
                action: { type: "click-alternative" as const, description: "Click alternative" },
                alternativeRef: "e10",
                confidence: 0.85,
                latencyMs: 120,
              },
            ),
      };
    }

    it("consults Micro-LLM when step fails and rule engine has no match (non-ref error)", async () => {
      const microLlm = createMockMicroLlm({
        decideResult: {
          action: { type: "skip-step" },
          confidence: 0.8,
          latencyMs: 100,
        },
      });

      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            return errorResponse("click", "Element blocked by overlay");
          }
          if (name === "read_page") {
            return okResponse("read_page", "button 'OK' [e1]\nbutton 'Cancel' [e2]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine, microLlm);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      expect(result.aborted).toBe(false);
      expect(result.steps[0].microLlmUsed).toBe(true);
      expect(result.steps[0].microLlmConfidence).toBe(0.8);
      expect(result.steps[0].microLlmLatencyMs).toBe(100);
      expect(result.totalMicroLlmCalls).toBe(1);
      expect(microLlm.decide).toHaveBeenCalled();
    });

    it("executes click-alternative action with alternativeRef from Micro-LLM", async () => {
      // After scrolling fails 3 times for ref-not-found, rule engine still matches
      // so Micro-LLM should only be consulted if rule engine returns null.
      // Let's test a non-ref error scenario where Micro-LLM provides click-alternative.
      const microLlm = createMockMicroLlm({
        decideResult: {
          action: { type: "click-alternative", description: "Click alternative" },
          alternativeRef: "e10",
          confidence: 0.9,
          latencyMs: 80,
        },
      });

      let clickCount = 0;
      const registry = createMockRegistry({
        handler: (name, params) => {
          if (name === "click") {
            clickCount++;
            if (clickCount === 1) {
              // First click fails with a generic error (not ref-not-found)
              return errorResponse("click", "Element blocked by overlay");
            }
            // Second click (with alternative ref) succeeds
            return okResponse("click", `Clicked ${(params as Record<string, unknown>).ref}`);
          }
          if (name === "read_page") {
            return okResponse("read_page", "button 'OK' [e10]\noverlay 'Banner' [e99]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine, microLlm);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      expect(result.aborted).toBe(false);
      expect(result.steps[0].microLlmUsed).toBe(true);
      expect(result.steps[0].result.content[0]).toHaveProperty("text", "Clicked e10");
    });

    it("returns EscalationResult when Micro-LLM confidence is below threshold", async () => {
      const microLlm = createMockMicroLlm({
        decideResult: {
          action: { type: "click-alternative", description: "Click alternative" },
          alternativeRef: "e10",
          confidence: 0.3, // Below 0.6 threshold
          latencyMs: 150,
        },
      });

      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            return errorResponse("click", "Element blocked by overlay");
          }
          if (name === "read_page") {
            return okResponse("read_page", "button 'OK' [e1]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine, microLlm);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      expect(result.aborted).toBe(true);
      expect(result.steps[0].escalationNeeded).toBe(true);
      expect(result.steps[0].microLlmCalled).toBe(true); // M1: counted even on low confidence
      expect(result.totalEscalations).toBe(1);
      expect(result.totalMicroLlmCalls).toBe(1); // M1: counts all invocations
    });

    it("returns EscalationResult when Micro-LLM times out", async () => {
      const microLlm = createMockMicroLlm({
        decideError: new MicroLlmTimeoutError(500),
      });

      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            return errorResponse("click", "Element blocked by overlay");
          }
          if (name === "read_page") {
            return okResponse("read_page", "button 'OK' [e1]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine, microLlm);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      expect(result.aborted).toBe(true);
      expect(result.steps[0].escalationNeeded).toBe(true);
      expect(result.steps[0].microLlmCalled).toBe(true); // M1: counted even on timeout
      expect(result.totalEscalations).toBe(1);
      expect(result.totalMicroLlmCalls).toBe(1); // M1: counts all invocations
    });

    it("returns EscalationResult when using NullMicroLlm (unavailable)", async () => {
      // Default: no microLlm param → NullMicroLlm
      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            return errorResponse("click", "Element blocked by overlay");
          }
          if (name === "read_page") {
            return okResponse("read_page", "button 'OK' [e1]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      // C3: NullMicroLlm.isAvailable() returns false → immediate escalation
      expect(result.aborted).toBe(true);
      expect(result.steps[0].escalationNeeded).toBe(true);
      expect(result.steps[0].microLlmCalled).toBe(true); // M1: counted even when unavailable
      expect(result.totalEscalations).toBe(1);
      expect(result.totalMicroLlmCalls).toBe(1); // M1: counts all invocations
    });

    // C4: Integration test for element-not-found → scroll exhausted → Micro-LLM → alternative ref
    it("consults Micro-LLM for alternative ref after scroll exhaustion on element-not-found (C4/H1)", async () => {
      const microLlm = createMockMicroLlm({
        decideResult: {
          action: { type: "click-alternative", description: "Click alternative element" },
          alternativeRef: "e42",
          confidence: 0.9,
          latencyMs: 110,
        },
      });

      let clickCount = 0;
      const registry = createMockRegistry({
        handler: (name, params) => {
          if (name === "click") {
            clickCount++;
            // Original ref always fails with "not found"
            if ((params as Record<string, unknown>).ref === "e99") {
              return errorResponse("click", "Element e99 not found.");
            }
            // Alternative ref (e42 from Micro-LLM) succeeds
            return okResponse("click", `Clicked ${(params as Record<string, unknown>).ref}`);
          }
          if (name === "read_page") {
            return okResponse("read_page", "button 'Submit' [e42]\nheading 'Form' [e1]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine, microLlm);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e99" } },
      ]);

      // Should NOT abort — Micro-LLM provided a working alternative
      expect(result.aborted).toBe(false);
      expect(result.stepsCompleted).toBe(1);
      // Scroll was attempted first (rule engine), then Micro-LLM took over
      expect(result.steps[0].scrollAttempts).toBeGreaterThanOrEqual(1);
      expect(result.steps[0].microLlmUsed).toBe(true);
      expect(result.steps[0].microLlmCalled).toBe(true);
      expect(result.steps[0].microLlmConfidence).toBe(0.9);
      expect(result.steps[0].result.content[0]).toHaveProperty("text", "Clicked e42");
      // Micro-LLM was called
      expect(microLlm.decide).toHaveBeenCalled();
      expect(microLlm.isAvailable).toHaveBeenCalled();
      expect(result.totalMicroLlmCalls).toBe(1);
    });

    it("does NOT consult Micro-LLM when rule engine matches", async () => {
      const microLlm = createMockMicroLlm();

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
            return okResponse("read_page", "button 'Submit' [e5]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine, microLlm);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      // Rule engine should handle it (scroll-to for "not found") and step succeeded on retry
      expect(result.aborted).toBe(false);
      expect(result.steps[0].rulesApplied.some((r) => r.action === "scroll-to")).toBe(true);
      // Micro-LLM should NOT be consulted (step succeeded after scroll)
      expect(microLlm.decide).not.toHaveBeenCalled();
      expect(result.steps[0].microLlmUsed).toBe(false);
      expect(result.steps[0].microLlmCalled).toBe(false);
      expect(result.totalMicroLlmCalls).toBe(0);
    });

    it("tracks metrics correctly: microLlmUsed, latencyMs, confidence", async () => {
      const microLlm = createMockMicroLlm({
        decideResult: {
          action: { type: "skip-step" },
          confidence: 0.75,
          latencyMs: 200,
        },
      });

      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            return errorResponse("click", "Overlay blocking interaction");
          }
          if (name === "read_page") {
            return okResponse("read_page", "overlay [e99]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine, microLlm);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      const stepResult = result.steps[0];
      expect(stepResult.microLlmUsed).toBe(true);
      expect(stepResult.microLlmLatencyMs).toBe(200);
      expect(stepResult.microLlmConfidence).toBe(0.75);
      expect(result.totalMicroLlmCalls).toBe(1);
      expect(result.totalEscalations).toBe(0);
    });

    // H2: Structured escalation data preserved in result
    it("preserves structured escalation data (H2)", async () => {
      const microLlm = createMockMicroLlm({
        decideResult: {
          action: { type: "click-alternative", description: "Click alternative" },
          alternativeRef: "e10",
          confidence: 0.2, // Below threshold
          latencyMs: 150,
        },
      });

      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            return errorResponse("click", "Element blocked by overlay");
          }
          if (name === "read_page") {
            return okResponse("read_page", "button 'OK' [e1]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine, microLlm);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      expect(result.steps[0].escalationNeeded).toBe(true);
      // H2: Structured escalation data available for Captain (Story 8.3)
      const esc = result.steps[0].escalation;
      expect(esc).toBeDefined();
      expect(esc!.type).toBe("escalation-needed");
      expect(esc!.reason).toBe("micro-llm-low-confidence");
      expect(esc!.stepContext.tool).toBe("click");
      expect(esc!.errorDescription).toBe("Element blocked by overlay");
      expect(esc!.a11ySnippet).toBeDefined();
      expect(esc!.diagnosticContext.microLlmConfidence).toBe(0.2);
    });

    // C2: Custom minConfidence from config
    it("uses custom minConfidence threshold from constructor (C2)", async () => {
      const microLlm = createMockMicroLlm({
        decideResult: {
          action: { type: "skip-step" },
          confidence: 0.5, // Below default 0.6 but above custom 0.4
          latencyMs: 100,
        },
      });

      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            return errorResponse("click", "Element blocked by overlay");
          }
          if (name === "read_page") {
            return okResponse("read_page", "button 'OK' [e1]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      // Custom minConfidence = 0.4, so 0.5 should pass
      const operator = new Operator(
        registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine, microLlm,
        undefined, // sessionManager
        0.4, // minConfidence
      );
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      // Should NOT escalate — confidence 0.5 >= minConfidence 0.4
      expect(result.aborted).toBe(false);
      expect(result.steps[0].microLlmUsed).toBe(true);
      expect(result.steps[0].escalationNeeded).toBeUndefined();
    });

    // C3: isAvailable check before decide
    it("escalates immediately when Micro-LLM isAvailable returns false (C3)", async () => {
      const microLlm = createMockMicroLlm({
        isAvailable: false,
      });

      const registry = createMockRegistry({
        handler: (name) => {
          if (name === "click") {
            return errorResponse("click", "Element blocked by overlay");
          }
          if (name === "read_page") {
            return okResponse("read_page", "button 'OK' [e1]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine, microLlm);
      const result = await operator.executePlan([
        { tool: "click", params: { ref: "e5" } },
      ]);

      // C3: isAvailable() returns false → escalation without calling decide()
      expect(result.aborted).toBe(true);
      expect(result.steps[0].escalationNeeded).toBe(true);
      expect(result.steps[0].microLlmCalled).toBe(true);
      expect(microLlm.isAvailable).toHaveBeenCalled();
      expect(microLlm.decide).not.toHaveBeenCalled(); // decide() never called
      expect(result.steps[0].escalation).toBeDefined();
      expect(result.steps[0].escalation!.reason).toBe("micro-llm-unavailable");
    });

    it("Micro-LLM provides alternative ref for type step", async () => {
      const microLlm = createMockMicroLlm({
        decideResult: {
          action: { type: "type-alternative", description: "Type into different field" },
          alternativeRef: "e20",
          confidence: 0.8,
          latencyMs: 90,
        },
      });

      let typeCount = 0;
      const registry = createMockRegistry({
        handler: (name, params) => {
          if (name === "type") {
            typeCount++;
            if (typeCount === 1) {
              return errorResponse("type", "Input field unavailable");
            }
            return okResponse("type", `Typed into ${(params as Record<string, unknown>).ref}`);
          }
          if (name === "read_page") {
            return okResponse("read_page", "input 'Name' [e20]");
          }
          return okResponse(name, `${name} done`);
        },
      });

      const operator = new Operator(registry, cdpClient as unknown as CdpClient, sessionId, ruleEngine, microLlm);
      const result = await operator.executePlan([
        { tool: "type", params: { ref: "e10", text: "hello" } },
      ]);

      expect(result.aborted).toBe(false);
      expect(result.steps[0].microLlmUsed).toBe(true);
      expect(result.steps[0].result.content[0]).toHaveProperty("text", "Typed into e20");
    });
  });
});
