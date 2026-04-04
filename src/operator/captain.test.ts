import { describe, it, expect, vi, beforeEach } from "vitest";
import { Captain, NullCaptain } from "./captain.js";
import type { CaptainProvider } from "./captain.js";
import type { EscalationResult, CaptainEscalationConfig } from "./types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// --- Helpers ---

function createEscalation(overrides?: Partial<EscalationResult>): EscalationResult {
  return {
    type: "escalation-needed",
    reason: "micro-llm-low-confidence",
    stepContext: { tool: "click", params: { ref: "e5" } },
    errorDescription: "Element e5 not found",
    a11ySnippet: "button 'Submit' [e5]\ntext 'Email' [e6]",
    diagnosticContext: { microLlmConfidence: 0.3 },
    ...overrides,
  };
}

const DEFAULT_CONFIG: CaptainEscalationConfig = {
  enabled: true,
  timeoutMs: 30000,
  includeScreenshot: false,
};

function createMockServer(elicitResult?: {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
}): Server {
  return {
    elicitInput: vi.fn().mockResolvedValue(
      elicitResult ?? {
        action: "accept",
        content: { decision_type: "skip-step" },
      },
    ),
  } as unknown as Server;
}

// --- Tests ---

describe("Captain", () => {
  describe("escalate()", () => {
    it("calls elicitInput with correct message and schema", async () => {
      const server = createMockServer();
      const captain = new Captain(server, DEFAULT_CONFIG);
      const escalation = createEscalation();

      await captain.escalate(escalation);

      expect(server.elicitInput).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "form",
          message: expect.stringContaining("OPERATOR ESCALATION"),
          requestedSchema: expect.objectContaining({
            type: "object",
            properties: expect.objectContaining({
              decision_type: expect.objectContaining({
                type: "string",
                enum: expect.arrayContaining([
                  "use-alternative-ref",
                  "use-selector",
                  "skip-step",
                  "retry-step",
                  "abort-plan",
                ]),
              }),
            }),
          }),
        }),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("parses accept response to use-alternative-ref decision", async () => {
      const server = createMockServer({
        action: "accept",
        content: { decision_type: "use-alternative-ref", ref_or_selector: "e12" },
      });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toEqual({ type: "use-alternative-ref", ref: "e12" });
    });

    it("parses accept response to use-selector decision", async () => {
      const server = createMockServer({
        action: "accept",
        content: { decision_type: "use-selector", ref_or_selector: "#submit-btn" },
      });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toEqual({ type: "use-selector", selector: "#submit-btn" });
    });

    it("parses accept response to skip-step decision", async () => {
      const server = createMockServer({
        action: "accept",
        content: { decision_type: "skip-step" },
      });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toEqual({ type: "skip-step" });
    });

    it("parses accept response to retry-step decision", async () => {
      const server = createMockServer({
        action: "accept",
        content: { decision_type: "retry-step" },
      });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toEqual({ type: "retry-step" });
    });

    it("parses accept response to abort-plan decision", async () => {
      const server = createMockServer({
        action: "accept",
        content: { decision_type: "abort-plan", abort_reason: "Page is broken" },
      });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toEqual({ type: "abort-plan", reason: "Page is broken" });
    });

    it("uses default abort reason when not provided", async () => {
      const server = createMockServer({
        action: "accept",
        content: { decision_type: "abort-plan" },
      });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toEqual({ type: "abort-plan", reason: "Aborted by Captain" });
    });

    it("parses retry-with-params as retry-step (flat form fallback)", async () => {
      const server = createMockServer({
        action: "accept",
        content: { decision_type: "retry-with-params" },
      });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      // retry-with-params needs structured params not expressible in flat form → fallback to retry-step
      expect(result).toEqual({ type: "retry-step" });
    });

    it("returns null on decline response", async () => {
      const server = createMockServer({ action: "decline" });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toBeNull();
    });

    it("returns null on cancel response", async () => {
      const server = createMockServer({ action: "cancel" });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toBeNull();
    });

    it("returns null on timeout", async () => {
      const server = {
        elicitInput: vi.fn().mockImplementation(async () => {
          // Simulate a never-resolving promise that will be aborted
          return new Promise((_resolve, reject) => {
            setTimeout(() => {
              reject(new Error("AbortError"));
            }, 100);
          });
        }),
      } as unknown as Server;

      const captain = new Captain(server, { ...DEFAULT_CONFIG, timeoutMs: 50 });
      const result = await captain.escalate(createEscalation());

      expect(result).toBeNull();
    });

    it("returns null when elicitInput throws", async () => {
      const server = {
        elicitInput: vi.fn().mockRejectedValue(new Error("Connection lost")),
      } as unknown as Server;

      const captain = new Captain(server, DEFAULT_CONFIG);
      const result = await captain.escalate(createEscalation());

      expect(result).toBeNull();
    });

    it("returns null for use-alternative-ref without ref_or_selector", async () => {
      const server = createMockServer({
        action: "accept",
        content: { decision_type: "use-alternative-ref" },
      });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toBeNull();
    });

    it("returns null for use-selector without ref_or_selector", async () => {
      const server = createMockServer({
        action: "accept",
        content: { decision_type: "use-selector" },
      });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toBeNull();
    });

    it("returns null for unknown decision type", async () => {
      const server = createMockServer({
        action: "accept",
        content: { decision_type: "unknown-type" },
      });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toBeNull();
    });

    it("returns null when content is undefined", async () => {
      const server = createMockServer({
        action: "accept",
        content: undefined,
      });
      const captain = new Captain(server, DEFAULT_CONFIG);

      const result = await captain.escalate(createEscalation());

      expect(result).toBeNull();
    });
  });

  describe("_buildEscalationMessage()", () => {
    it("formats escalation with all fields", () => {
      const captain = new Captain(createMockServer(), DEFAULT_CONFIG);
      const escalation = createEscalation();

      const message = captain._buildEscalationMessage(escalation);

      expect(message).toContain("OPERATOR ESCALATION");
      expect(message).toContain("Tool: click");
      expect(message).toContain("Error: Element e5 not found");
      expect(message).toContain("Micro-LLM: micro-llm-low-confidence");
      expect(message).toContain("button 'Submit' [e5]");
      expect(message).toContain("A11y context:");
    });

    it("formats escalation without a11y snippet", () => {
      const captain = new Captain(createMockServer(), DEFAULT_CONFIG);
      const escalation = createEscalation({ a11ySnippet: undefined });

      const message = captain._buildEscalationMessage(escalation);

      expect(message).toContain("OPERATOR ESCALATION");
      expect(message).not.toContain("A11y context:");
    });

    it("includes screenshot marker when provided", () => {
      const captain = new Captain(createMockServer(), DEFAULT_CONFIG);
      const escalation = createEscalation();

      const message = captain._buildEscalationMessage(escalation, "base64data...");

      expect(message).toContain("[Screenshot attached]");
    });

    it("includes diagnostic context", () => {
      const captain = new Captain(createMockServer(), DEFAULT_CONFIG);
      const escalation = createEscalation({
        diagnosticContext: { microLlmConfidence: 0.3, microLlmAction: { type: "skip-step" } },
      });

      const message = captain._buildEscalationMessage(escalation);

      expect(message).toContain("Diagnostics:");
      expect(message).toContain("microLlmConfidence");
    });
  });

  describe("_buildDecisionSchema()", () => {
    it("returns valid MCP Elicitation form schema", () => {
      const captain = new Captain(createMockServer(), DEFAULT_CONFIG);
      const schema = captain._buildDecisionSchema();

      expect(schema.type).toBe("object");
      expect(schema.properties.decision_type).toBeDefined();
      expect(schema.properties.decision_type).toHaveProperty("enum");
      expect(schema.required).toEqual(["decision_type"]);
    });

    it("includes ref_or_selector and abort_reason as optional fields", () => {
      const captain = new Captain(createMockServer(), DEFAULT_CONFIG);
      const schema = captain._buildDecisionSchema();

      expect(schema.properties.ref_or_selector).toBeDefined();
      expect(schema.properties.abort_reason).toBeDefined();
      // These should NOT be in required
      expect(schema.required).not.toContain("ref_or_selector");
      expect(schema.required).not.toContain("abort_reason");
    });
  });
});

describe("NullCaptain", () => {
  it("escalate() always returns null", async () => {
    const captain = new NullCaptain();
    const result = await captain.escalate(createEscalation());

    expect(result).toBeNull();
  });

  it("implements CaptainProvider interface", () => {
    const captain: CaptainProvider = new NullCaptain();
    expect(typeof captain.escalate).toBe("function");
  });
});
