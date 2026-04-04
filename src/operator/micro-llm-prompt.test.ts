import { describe, it, expect } from "vitest";
import { buildMicroLlmPrompt, parseDecisionResponse, buildA11ySnippet } from "./micro-llm-prompt.js";
import type { MicroLlmAction, MicroLlmRequest } from "./types.js";

const SAMPLE_ACTIONS: MicroLlmAction[] = [
  { type: "click-alternative", description: "Click a different element" },
  { type: "scroll-direction", direction: "down" },
  { type: "dismiss-element", description: "Dismiss blocking element" },
  { type: "skip-step" },
  { type: "fail-step", reason: "No suitable element found" },
];

function createRequest(overrides?: Partial<MicroLlmRequest>): MicroLlmRequest {
  return {
    a11ySnippet: "button 'Submit' [e5]\ntext 'Email' [e6]",
    stepContext: { tool: "click", params: { ref: "e5" } },
    errorDescription: "Element e5 not found",
    possibleActions: SAMPLE_ACTIONS,
    ...overrides,
  };
}

describe("buildMicroLlmPrompt()", () => {
  it("generates prompt containing all required sections", () => {
    const prompt = buildMicroLlmPrompt(createRequest());

    expect(prompt).toContain("## Page Excerpt (A11y Tree)");
    expect(prompt).toContain("button 'Submit' [e5]");
    expect(prompt).toContain("## Current Step");
    expect(prompt).toContain("Tool: click");
    expect(prompt).toContain("## Problem");
    expect(prompt).toContain("Element e5 not found");
    expect(prompt).toContain("## Possible Actions");
    expect(prompt).toContain("0: click-alternative");
    expect(prompt).toContain("1: scroll-direction(down)");
    expect(prompt).toContain("4: fail-step");
    expect(prompt).toContain('Respond ONLY with JSON: {"action_index"');
  });

  it("includes step params as JSON", () => {
    const prompt = buildMicroLlmPrompt(createRequest({
      stepContext: { tool: "type", params: { ref: "e10", text: "hello" } },
    }));

    expect(prompt).toContain('"ref":"e10"');
    expect(prompt).toContain('"text":"hello"');
  });

  it("keeps prompt under 600 estimated tokens (2400 chars) for typical input", () => {
    const prompt = buildMicroLlmPrompt(createRequest());
    // Conservative estimate: 4 chars per token → 600 tokens = 2400 chars
    const estimatedTokens = prompt.length / 4;
    expect(estimatedTokens).toBeLessThan(600);
  });

  it("numbers actions starting from 0", () => {
    const prompt = buildMicroLlmPrompt(createRequest());
    expect(prompt).toContain("  0:");
    expect(prompt).toContain("  1:");
    expect(prompt).toContain("  4:");
  });
});

describe("parseDecisionResponse()", () => {
  it("parses valid JSON response", () => {
    const raw = '{"action_index": 0, "alternative_ref": "e7", "confidence": 0.85}';
    const result = parseDecisionResponse(raw, SAMPLE_ACTIONS, 42);

    expect(result.action).toEqual(SAMPLE_ACTIONS[0]);
    expect(result.alternativeRef).toBe("e7");
    expect(result.confidence).toBe(0.85);
    expect(result.latencyMs).toBe(42);
  });

  it("extracts JSON from markdown code block", () => {
    const raw = '```json\n{"action_index": 1, "alternative_ref": null, "confidence": 0.7}\n```';
    const result = parseDecisionResponse(raw, SAMPLE_ACTIONS);

    expect(result.action).toEqual(SAMPLE_ACTIONS[1]);
    expect(result.alternativeRef).toBeUndefined();
    expect(result.confidence).toBe(0.7);
  });

  it("extracts JSON from plain code block (no language tag)", () => {
    const raw = '```\n{"action_index": 2, "confidence": 0.6}\n```';
    const result = parseDecisionResponse(raw, SAMPLE_ACTIONS);

    expect(result.action).toEqual(SAMPLE_ACTIONS[2]);
    expect(result.confidence).toBe(0.6);
  });

  it("returns fail-step fallback on invalid JSON", () => {
    const raw = "I think you should click on the submit button";
    const result = parseDecisionResponse(raw, SAMPLE_ACTIONS);

    expect(result.action.type).toBe("fail-step");
    expect(result.confidence).toBe(0);
  });

  it("returns fail-step fallback on invalid action_index (out of range)", () => {
    const raw = '{"action_index": 99, "confidence": 0.9}';
    const result = parseDecisionResponse(raw, SAMPLE_ACTIONS);

    expect(result.action.type).toBe("fail-step");
    expect(result.confidence).toBe(0);
  });

  it("returns fail-step fallback on negative action_index", () => {
    const raw = '{"action_index": -1, "confidence": 0.9}';
    const result = parseDecisionResponse(raw, SAMPLE_ACTIONS);

    expect(result.action.type).toBe("fail-step");
    expect(result.confidence).toBe(0);
  });

  // M2: Float action_index must be rejected
  it("returns fail-step fallback on float action_index (M2)", () => {
    const raw = '{"action_index": 1.5, "confidence": 0.9}';
    const result = parseDecisionResponse(raw, SAMPLE_ACTIONS);

    expect(result.action.type).toBe("fail-step");
    expect(result.confidence).toBe(0);
  });

  it("returns fail-step fallback on missing action_index", () => {
    const raw = '{"confidence": 0.9}';
    const result = parseDecisionResponse(raw, SAMPLE_ACTIONS);

    expect(result.action.type).toBe("fail-step");
    expect(result.confidence).toBe(0);
  });

  it("clamps confidence to [0, 1]", () => {
    const raw = '{"action_index": 0, "confidence": 1.5}';
    const result = parseDecisionResponse(raw, SAMPLE_ACTIONS);

    expect(result.confidence).toBe(1);

    const raw2 = '{"action_index": 0, "confidence": -0.5}';
    const result2 = parseDecisionResponse(raw2, SAMPLE_ACTIONS);
    expect(result2.confidence).toBe(0);
  });

  it("defaults confidence to 0 when missing", () => {
    const raw = '{"action_index": 0}';
    const result = parseDecisionResponse(raw, SAMPLE_ACTIONS);

    expect(result.confidence).toBe(0);
  });

  it("converts null alternative_ref to undefined", () => {
    const raw = '{"action_index": 0, "alternative_ref": null, "confidence": 0.5}';
    const result = parseDecisionResponse(raw, SAMPLE_ACTIONS);

    expect(result.alternativeRef).toBeUndefined();
  });
});

describe("buildA11ySnippet()", () => {
  const sampleTree = Array.from({ length: 50 }, (_, i) =>
    `line ${i}: element [e${i}] role=button name="Button ${i}"`,
  ).join("\n");

  it("extracts context around target ref (±10 lines)", () => {
    const snippet = buildA11ySnippet(sampleTree, "e25");

    expect(snippet).toContain("e25");
    expect(snippet).toContain("e15"); // 10 lines before
    expect(snippet).toContain("e35"); // 10 lines after
    // Should not contain elements far away
    expect(snippet).not.toContain("e0");
    expect(snippet).not.toContain("e49");
  });

  it("takes from start when no targetRef provided", () => {
    const snippet = buildA11ySnippet(sampleTree);

    expect(snippet).toContain("e0");
    expect(snippet).toContain("e1");
  });

  it("takes from start when targetRef is not found in tree", () => {
    const snippet = buildA11ySnippet(sampleTree, "nonexistent");

    expect(snippet).toContain("e0");
  });

  it("respects maxTokens limit", () => {
    const snippet = buildA11ySnippet(sampleTree, undefined, 50);
    // 50 tokens × 4 chars = 200 chars max
    expect(snippet.length).toBeLessThanOrEqual(200);
  });

  it("returns full tree when it fits within maxTokens", () => {
    const shortTree = "button 'OK' [e1]";
    const snippet = buildA11ySnippet(shortTree, undefined, 300);

    expect(snippet).toBe(shortTree);
  });

  it("truncates snippet around target when too long for maxTokens", () => {
    // Lines short enough that e15 stays within the token budget after centering
    const longTree = Array.from({ length: 30 }, (_, i) =>
      `[e${i}] button "Btn ${i}"`,
    ).join("\n");

    const snippet = buildA11ySnippet(longTree, "e15", 100);
    // 100 tokens × 4 chars = 400 chars max
    expect(snippet.length).toBeLessThanOrEqual(400);
    expect(snippet).toContain("e15");
    // Should not contain elements far from target
    expect(snippet).not.toContain("e0");
  });
});
