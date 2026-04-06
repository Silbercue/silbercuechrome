import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import { wrapCdpError } from "./error-utils.js";

/**
 * Detects top-level const/let/class declarations and wraps the expression in
 * an IIFE to avoid "Identifier has already been declared" errors across
 * repeated Runtime.evaluate calls (which share the global scope).
 *
 * The last ExpressionStatement is automatically returned so callers still
 * get the evaluation result.
 */
export function wrapInIIFE(expression: string): string {
  // Quick check: does the code need IIFE wrapping?
  // - const/let/class declarations (would collide across repeated evaluate calls)
  // - top-level return statements (illegal outside function body)
  // - top-level await (FR-H3: illegal outside async function)
  const hasDeclarations = /^[ \t]*(const|let|class)\s/m.test(expression);
  const hasTopLevelReturn = /^[ \t]*return\s/m.test(expression);
  const hasTopLevelAwait = /\bawait\b/.test(expression);
  if (!hasDeclarations && !hasTopLevelReturn && !hasTopLevelAwait) return expression;

  // Already wrapped in an IIFE? Don't double-wrap.
  const trimmed = expression.trim();
  if (/^\([\s\S]*\)\s*\(\s*\)\s*;?\s*$/.test(trimmed)) return expression;

  // FR-H3: Use async IIFE when code contains await
  const asyncPrefix = hasTopLevelAwait ? "async " : "";

  // If code already has explicit return statements, just wrap in IIFE — don't insert return.
  if (hasTopLevelReturn) {
    return `(${asyncPrefix}() => {\n${expression}\n})()`;
  }

  // Insert `return` before the last expression statement so the IIFE
  // returns its value (arrow function block bodies don't auto-return).
  const lines = expression.split("\n");

  // FR-001: Use bracket-depth tracking to find the START of the last multi-line expression.
  // Walk backwards from the last line, tracking depth of () {} [].
  // When depth reaches 0, we've found the start of the expression.
  let depth = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line.startsWith("//")) continue;

    // Count brackets right-to-left (we're scanning backwards)
    for (let c = line.length - 1; c >= 0; c--) {
      const ch = line[c];
      if (ch === ")" || ch === "}" || ch === "]") depth++;
      else if (ch === "(" || ch === "{" || ch === "[") depth--;
    }

    // depth > 0 means we're still inside a multi-line expression — keep walking up
    if (depth > 0) continue;

    // Found the start of the last complete expression/statement.
    if (/^(const|let|var|if|for|while|switch|try|throw|return|class|function)\b/.test(line)) {
      // It's a statement keyword — check for trailing expression after last ;
      const lastSemi = line.lastIndexOf(";");
      if (lastSemi >= 0 && lastSemi < line.length - 1) {
        const trailing = line.substring(lastSemi + 1).trim();
        if (trailing && !/^(const|let|var|if|for|while|switch|try|throw|return|class|function)\b/.test(trailing)) {
          const indent = lines[i].match(/^(\s*)/)?.[1] ?? "";
          lines[i] = indent + line.substring(0, lastSemi + 1);
          lines.splice(i + 1, 0, indent + "return " + trailing);
        }
      }
      break;
    }

    // Pure expression — prepend return
    const indent = lines[i].match(/^(\s*)/)?.[1] ?? "";
    lines[i] = indent + "return " + lines[i].trimStart();
    break;
  }

  return `(${asyncPrefix}() => {\n${lines.join("\n")}\n})()`;
}

export const evaluateSchema = z.object({
  expression: z.string().describe("JavaScript code to execute in the page context"),
  await_promise: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to await Promise results"),
});

export type EvaluateParams = z.infer<typeof evaluateSchema>;

interface RuntimeEvaluateResult {
  result: {
    type: string;
    subtype?: string;
    value?: unknown;
    description?: string;
    className?: string;
  };
  exceptionDetails?: {
    exceptionId: number;
    text: string;
    exception?: {
      type: string;
      subtype?: string;
      className?: string;
      description?: string;
    };
  };
}

export async function evaluateHandler(
  params: EvaluateParams,
  cdpClient: CdpClient,
  sessionId?: string,
): Promise<ToolResponse> {
  const start = performance.now();

  try {
    const wrappedExpression = wrapInIIFE(params.expression);

    const cdpResult = await cdpClient.send<RuntimeEvaluateResult>(
      "Runtime.evaluate",
      {
        expression: wrappedExpression,
        returnByValue: true,
        awaitPromise: params.await_promise,
      },
      sessionId,
    );

    const elapsedMs = Math.round(performance.now() - start);

    // Check for JS exception
    if (cdpResult.exceptionDetails) {
      const details = cdpResult.exceptionDetails;
      const message =
        details.exception?.description || details.text || "Unknown JavaScript error";
      return {
        content: [{ type: "text", text: message }],
        isError: true,
        _meta: { elapsedMs, method: "evaluate" },
      };
    }

    // Extract result value
    const resultValue = cdpResult.result;
    let text: string;
    if (resultValue.type === "undefined") {
      text = "undefined";
    } else if (resultValue.value === undefined) {
      // Non-serializable result (e.g. DOM nodes) — returnByValue couldn't serialize
      const desc = resultValue.description || resultValue.className || resultValue.subtype || resultValue.type;
      return {
        content: [{ type: "text", text: `Result not serializable: ${desc}` }],
        isError: true,
        _meta: { elapsedMs, method: "evaluate" },
      };
    } else {
      text = JSON.stringify(resultValue.value);
    }

    return {
      content: [{ type: "text", text }],
      _meta: { elapsedMs, method: "evaluate" },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "evaluate") }],
      isError: true,
      _meta: { elapsedMs, method: "evaluate" },
    };
  }
}
