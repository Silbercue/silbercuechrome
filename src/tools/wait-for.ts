import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import { settle } from "../cdp/settle.js";
import { a11yTree } from "../cache/a11y-tree.js";
import { wrapCdpError } from "./error-utils.js";

// --- Schema (Task 1) ---

export const waitForSchema = z.object({
  condition: z
    .enum(["element", "network_idle", "js"])
    .describe("What to wait for: element visibility, network idle, or JS expression returning true"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector or element ref (e.g. 'e5') — required when condition is 'element'"),
  expression: z
    .string()
    .optional()
    .describe("JavaScript expression that should evaluate to true — required when condition is 'js'"),
  timeout: z
    .number()
    .optional()
    .default(10000)
    .describe("Maximum wait time in milliseconds (default: 10000)"),
});

export type WaitForParams = z.infer<typeof waitForSchema>;

// --- Constants ---

const POLL_INTERVAL_MS = 200;

// --- Delay helper ---

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Element condition (Task 2) ---

interface WaitResult {
  found: boolean;
  elapsedMs: number;
}

async function waitForElement(
  cdpClient: CdpClient,
  sessionId: string,
  selector: string,
  timeout: number,
): Promise<WaitResult> {
  const start = performance.now();
  const deadline = start + timeout;
  const isRef = /^e\d+$/.test(selector);

  while (performance.now() < deadline) {
    try {
      let found = false;

      if (isRef) {
        // Ref path
        const backendNodeId = a11yTree.resolveRef(selector);
        if (backendNodeId !== undefined) {
          // Resolve backendNodeId → objectId via DOM.resolveNode
          const { object } = await cdpClient.send<{ object: { objectId: string } }>(
            "DOM.resolveNode",
            { backendNodeId },
            sessionId,
          );
          // Check visibility via callFunctionOn
          const { result } = await cdpClient.send<{ result: { value: boolean } }>(
            "Runtime.callFunctionOn",
            {
              objectId: object.objectId,
              functionDeclaration:
                "function() { const r = this.getBoundingClientRect(); return r.width > 0 && r.height > 0; }",
              returnByValue: true,
            },
            sessionId,
          );
          found = result.value === true;
        }
        // If resolveRef returns undefined, ref not in cache yet — keep polling
      } else {
        // CSS path
        const checkExpression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })()`;
        const evalResult = await cdpClient.send<{ result: { value: boolean } }>(
          "Runtime.evaluate",
          { expression: checkExpression, returnByValue: true },
          sessionId,
        );
        found = evalResult.result.value === true;
      }

      if (found) {
        return { found: true, elapsedMs: Math.round(performance.now() - start) };
      }
    } catch {
      // CDP error during polling (e.g. element removed) — swallow and continue
      // Transport errors will propagate from the outer try/catch in the handler
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }

  return { found: false, elapsedMs: Math.round(performance.now() - start) };
}

// --- Network idle condition (Task 3) ---

interface NetworkIdleResult {
  settled: boolean;
  signal?: string;
  elapsedMs: number;
}

async function waitForNetworkIdle(
  cdpClient: CdpClient,
  sessionId: string,
  timeout: number,
): Promise<NetworkIdleResult> {
  // Get main frame ID
  const frameTree = await cdpClient.send<{ frameTree: { frame: { id: string } } }>(
    "Page.getFrameTree",
    {},
    sessionId,
  );
  const frameId = frameTree.frameTree.frame.id;

  const settleResult = await settle({
    cdpClient,
    sessionId,
    frameId,
    settleMs: 500,
    timeoutMs: timeout,
  });

  return {
    settled: settleResult.settled,
    signal: settleResult.signal,
    elapsedMs: settleResult.elapsedMs,
  };
}

// --- JS condition (Task 4) ---

interface JsWaitResult {
  met: boolean;
  elapsedMs: number;
  lastValue: unknown;
}

async function waitForJs(
  cdpClient: CdpClient,
  sessionId: string,
  expression: string,
  timeout: number,
): Promise<JsWaitResult> {
  const start = performance.now();
  const deadline = start + timeout;
  let lastValue: unknown = undefined;

  while (performance.now() < deadline) {
    try {
      const result = await cdpClient.send<{
        result: { value: unknown };
        exceptionDetails?: unknown;
      }>(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: false,
        },
        sessionId,
      );

      if (!result.exceptionDetails) {
        lastValue = result.result.value;
        if (result.result.value === true) {
          return { met: true, elapsedMs: Math.round(performance.now() - start), lastValue };
        }
      }
      // Exception in expression — swallow and keep polling
    } catch {
      // CDP error — swallow and keep polling
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }

  return { met: false, elapsedMs: Math.round(performance.now() - start), lastValue };
}

// --- Main handler (Task 5) ---

export async function waitForHandler(
  params: WaitForParams,
  cdpClient: CdpClient,
  sessionId?: string,
): Promise<ToolResponse> {
  const start = performance.now();

  // Validation (Task 1.4)
  if (params.condition === "element" && (!params.selector || params.selector.trim() === "")) {
    return {
      content: [
        {
          type: "text",
          text: "wait_for condition 'element' requires a 'selector' parameter (CSS selector or ref like 'e5')",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "wait_for" },
    };
  }

  if (params.condition === "js" && (!params.expression || params.expression.trim() === "")) {
    return {
      content: [
        {
          type: "text",
          text: "wait_for condition 'js' requires an 'expression' parameter",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "wait_for" },
    };
  }

  try {
    switch (params.condition) {
      case "element": {
        const result = await waitForElement(
          cdpClient,
          sessionId!,
          params.selector!,
          params.timeout,
        );
        if (result.found) {
          return {
            content: [
              {
                type: "text",
                text: `Condition 'element' met after ${result.elapsedMs}ms — selector: ${params.selector}`,
              },
            ],
            _meta: { elapsedMs: result.elapsedMs, method: "wait_for", condition: "element" },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Timeout after ${params.timeout}ms waiting for element '${params.selector}' to become visible`,
            },
          ],
          isError: true,
          _meta: { elapsedMs: result.elapsedMs, method: "wait_for", condition: "element" },
        };
      }

      case "network_idle": {
        const result = await waitForNetworkIdle(cdpClient, sessionId!, params.timeout);
        if (result.settled) {
          return {
            content: [
              {
                type: "text",
                text: `Condition 'network_idle' met after ${result.elapsedMs}ms`,
              },
            ],
            _meta: {
              elapsedMs: result.elapsedMs,
              method: "wait_for",
              condition: "network_idle",
              settleSignal: result.signal,
            },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Timeout after ${params.timeout}ms waiting for network idle (signal: ${result.signal})`,
            },
          ],
          isError: true,
          _meta: {
            elapsedMs: result.elapsedMs,
            method: "wait_for",
            condition: "network_idle",
            settleSignal: result.signal,
          },
        };
      }

      case "js": {
        const result = await waitForJs(
          cdpClient,
          sessionId!,
          params.expression!,
          params.timeout,
        );
        if (result.met) {
          return {
            content: [
              {
                type: "text",
                text: `Condition 'js' met after ${result.elapsedMs}ms`,
              },
            ],
            _meta: { elapsedMs: result.elapsedMs, method: "wait_for", condition: "js" },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Timeout after ${params.timeout}ms waiting for JS expression to return true. Last evaluation returned: ${JSON.stringify(result.lastValue)}`,
            },
          ],
          isError: true,
          _meta: { elapsedMs: result.elapsedMs, method: "wait_for", condition: "js" },
        };
      }
    }
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "wait_for") }],
      isError: true,
      _meta: { elapsedMs, method: "wait_for" },
    };
  }
}
