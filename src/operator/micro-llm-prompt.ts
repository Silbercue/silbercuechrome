import type { MicroLlmAction, MicroLlmRequest, MicroLlmResponse } from "./types.js";

const DEFAULT_MAX_TOKENS = 300;
// Conservative estimate: 1 token ≈ 4 characters
const CHARS_PER_TOKEN = 4;

/**
 * Build a compact prompt for the Micro-LLM decision.
 * Prompt is in English for better results with small models.
 * Target: ~500 tokens total input.
 */
export function buildMicroLlmPrompt(request: MicroLlmRequest): string {
  const actionsText = request.possibleActions
    .map((a, i) => `  ${i}: ${formatAction(a)}`)
    .join("\n");

  const paramsJson = JSON.stringify(request.stepContext.params);

  return `You are a browser automation operator. Choose the best action.

## Page Excerpt (A11y Tree)
${request.a11ySnippet}

## Current Step
Tool: ${request.stepContext.tool}, Params: ${paramsJson}

## Problem
${request.errorDescription}

## Possible Actions
${actionsText}

Respond ONLY with JSON: {"action_index": <number>, "alternative_ref": "<ref_or_null>", "confidence": <0.0-1.0>}`;
}

function formatAction(action: MicroLlmAction): string {
  switch (action.type) {
    case "click-alternative":
      return `click-alternative — ${action.description}`;
    case "type-alternative":
      return `type-alternative — ${action.description}`;
    case "dismiss-element":
      return `dismiss-element — ${action.description}`;
    case "scroll-direction":
      return `scroll-direction(${action.direction})`;
    case "wait":
      return `wait(${action.durationMs}ms)`;
    case "skip-step":
      return "skip-step";
    case "fail-step":
      return `fail-step — ${action.reason}`;
  }
}

/**
 * Parse the LLM response text into a MicroLlmResponse.
 * Handles JSON embedded in markdown code blocks.
 * Returns a fail-step fallback on parse errors.
 */
export function parseDecisionResponse(
  raw: string,
  possibleActions: MicroLlmAction[],
  latencyMs: number = 0,
): MicroLlmResponse {
  try {
    // Extract JSON — may be wrapped in ```json ... ``` or ``` ... ```
    let jsonStr = raw.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr) as {
      action_index?: number;
      alternative_ref?: string | null;
      confidence?: number;
    };

    // M2: Validate action_index is an integer (reject floats like 1.5)
    const actionIndex = parsed.action_index;
    if (
      typeof actionIndex !== "number" ||
      !Number.isInteger(actionIndex) ||
      actionIndex < 0 ||
      actionIndex >= possibleActions.length
    ) {
      return {
        action: { type: "fail-step", reason: "LLM response: invalid action_index" },
        confidence: 0,
        latencyMs,
      };
    }

    const confidence =
      typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;

    return {
      action: possibleActions[actionIndex],
      alternativeRef: parsed.alternative_ref ?? undefined,
      confidence,
      latencyMs,
    };
  } catch {
    return {
      action: { type: "fail-step", reason: "LLM response unparseable" },
      confidence: 0,
      latencyMs,
    };
  }
}

/**
 * Extract a relevant snippet from the full A11y tree.
 * If targetRef is provided, centers the snippet around that element.
 * Otherwise takes the first maxTokens worth of tokens.
 */
export function buildA11ySnippet(
  fullA11yTree: string,
  targetRef?: string,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const lines = fullA11yTree.split("\n");

  if (targetRef) {
    // Find the line containing the target ref
    const targetIndex = lines.findIndex((line) => line.includes(targetRef));
    if (targetIndex >= 0) {
      // Extract ±10 lines around the target
      const contextLines = 10;
      const start = Math.max(0, targetIndex - contextLines);
      const end = Math.min(lines.length, targetIndex + contextLines + 1);
      const snippet = lines.slice(start, end).join("\n");

      if (snippet.length <= maxChars) {
        return snippet;
      }
      // Truncate to maxChars if still too long
      return snippet.slice(0, maxChars);
    }
  }

  // No targetRef or not found: take from start
  const fullText = fullA11yTree;
  if (fullText.length <= maxChars) {
    return fullText;
  }
  return fullText.slice(0, maxChars);
}
