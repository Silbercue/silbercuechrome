import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { wrapCdpError } from "./error-utils.js";

// --- Schema ---

export const scrollSchema = z.object({
  ref: z
    .string()
    .optional()
    .describe("Element ref to scroll into view (e.g. 'e42')"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector to scroll into view (e.g. '#item-30')"),
  direction: z
    .enum(["up", "down"])
    .optional()
    .describe("Scroll the page up or down (when no ref/selector given). Default: down"),
  amount: z
    .number()
    .optional()
    .describe("Pixels to scroll (default: 500). Only used with direction."),
});

export type ScrollParams = z.infer<typeof scrollSchema>;

// --- Handler ---

export async function scrollHandler(
  params: ScrollParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

  // Mode 1: Scroll element into view
  if (params.ref || params.selector) {
    try {
      const target = params.ref ? { ref: params.ref } : { selector: params.selector };
      const element = await resolveElement(cdpClient, sessionId!, target, sessionManager);

      await cdpClient.send(
        "DOM.scrollIntoViewIfNeeded",
        { backendNodeId: element.backendNodeId },
        element.resolvedSessionId,
      );

      const elapsedMs = Math.round(performance.now() - start);
      return {
        content: [{ type: "text", text: `Scrolled ${params.ref ?? params.selector} into view` }],
        _meta: { elapsedMs, method: "scroll" },
      };
    } catch (err) {
      if (err instanceof RefNotFoundError && params.ref) {
        return {
          content: [{ type: "text", text: buildRefNotFoundError(params.ref) }],
          isError: true,
          _meta: { elapsedMs: 0, method: "scroll" },
        };
      }
      const elapsedMs = Math.round(performance.now() - start);
      return {
        content: [{ type: "text", text: wrapCdpError(err, "scroll") }],
        isError: true,
        _meta: { elapsedMs, method: "scroll" },
      };
    }
  }

  // Mode 2: Page scroll by direction + amount
  const direction = params.direction ?? "down";
  const amount = params.amount ?? 500;
  const scrollY = direction === "down" ? amount : -amount;

  try {
    const result = await cdpClient.send<{ result: { value: { scrollY: number; scrollHeight: number; clientHeight: number } } }>(
      "Runtime.evaluate",
      {
        expression: `(() => {
          window.scrollBy(0, ${scrollY});
          return { scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight, clientHeight: window.innerHeight };
        })()`,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    );

    const pos = result.result.value;
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{
        type: "text",
        text: `Scrolled ${direction} ${amount}px — position: ${pos.scrollY}/${pos.scrollHeight - pos.clientHeight}px`,
      }],
      _meta: { elapsedMs, method: "scroll" },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "scroll") }],
      isError: true,
      _meta: { elapsedMs, method: "scroll" },
    };
  }
}
