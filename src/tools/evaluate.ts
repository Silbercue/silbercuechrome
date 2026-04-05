import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import { wrapCdpError } from "./error-utils.js";

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
    const cdpResult = await cdpClient.send<RuntimeEvaluateResult>(
      "Runtime.evaluate",
      {
        expression: params.expression,
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
