import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { wrapCdpError } from "./error-utils.js";
import { toolSequence } from "../telemetry/tool-sequence.js";

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
  container_ref: z
    .string()
    .optional()
    .describe("Scrollable container ref — scroll this container instead of the page (e.g. 'e10')"),
  container_selector: z
    .string()
    .optional()
    .describe("Scrollable container CSS selector (e.g. '.sidebar-list')"),
  direction: z
    .enum(["up", "down"])
    .optional()
    .describe("Scroll direction (when no ref/selector given). Default: down"),
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
      toolSequence.record("scroll", undefined, sessionId);
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

  // Mode 2: Scroll by direction + amount (page or container)
  const direction = params.direction ?? "down";
  const amount = params.amount ?? 500;
  const scrollY = direction === "down" ? amount : -amount;

  // Settle delay (ms) — browser-side setTimeout after scrollBy. Gives IntersectionObserver
  // callbacks and lazy-load DOM updates time to fire. Must run IN the browser, not server-side
  // (server-side delays don't advance the browser's rendering pipeline).
  const SETTLE_MS = 150;

  // Resolve container to a CSS selector string for use in evaluate
  let containerSelector: string | undefined;
  let containerSessionForScroll = sessionId;
  if (params.container_ref || params.container_selector) {
    if (params.container_selector) {
      // Direct CSS selector — use as-is
      containerSelector = params.container_selector;
    } else {
      // Ref — resolve to get backendNodeId, then get a unique CSS selector via DOM.describeNode
      try {
        const container = await resolveElement(cdpClient, sessionId!, { ref: params.container_ref }, sessionManager);
        containerSessionForScroll = container.resolvedSessionId;
        // Get DOM attributes to build a selector
        const desc = await cdpClient.send<{ node: { attributes?: string[]; localName: string; nodeId: number } }>(
          "DOM.describeNode",
          { backendNodeId: container.backendNodeId },
          container.resolvedSessionId,
        );
        const attrs = desc.node.attributes ?? [];
        const idIdx = attrs.indexOf("id");
        if (idIdx >= 0 && attrs[idIdx + 1]) {
          containerSelector = `#${attrs[idIdx + 1]}`;
        } else {
          // Fallback: use data-* or class-based selector. If none available,
          // inject a temporary ID for the evaluate to find the element.
          const tempId = `__sc_scroll_${Date.now()}`;
          await cdpClient.send(
            "Runtime.callFunctionOn",
            {
              functionDeclaration: `function() { this.dataset.scScrollId = '${tempId}'; }`,
              objectId: container.objectId,
            },
            container.resolvedSessionId,
          );
          containerSelector = `[data-sc-scroll-id="${tempId}"]`;
        }
      } catch (err) {
        if (err instanceof RefNotFoundError && params.container_ref) {
          return {
            content: [{ type: "text", text: buildRefNotFoundError(params.container_ref) }],
            isError: true,
            _meta: { elapsedMs: Math.round(performance.now() - start), method: "scroll" },
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
  }

  try {
    if (containerSelector) {
      // Container scroll — pure Runtime.evaluate with querySelector.
      // callFunctionOn does NOT reliably await async functions (Chrome CDP bug),
      // so everything runs in a single evaluate with awaitPromise: true.
      const escapedSelector = containerSelector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const result = await cdpClient.send<{ result: { value: { scrollTop: number; scrollHeight: number; clientHeight: number; prevScrollHeight: number } } }>(
        "Runtime.evaluate",
        {
          expression: `(async () => {
            const el = document.querySelector('${escapedSelector}');
            if (!el) throw new Error('scroll: container not found: ${escapedSelector}');
            if (el.dataset.scScrollId) delete el.dataset.scScrollId;
            const prev = el.scrollHeight;
            el.scrollBy(0, ${scrollY});
            await new Promise(r => setTimeout(r, ${SETTLE_MS}));
            return { scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, prevScrollHeight: prev };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        },
        containerSessionForScroll,
      );

      const pos = result.result.value;
      const containerLabel = params.container_ref ?? params.container_selector;
      const grew = pos.scrollHeight - pos.prevScrollHeight;
      const grewNote = grew > 0 ? ` (content loaded: scrollHeight grew by ${grew}px)` : "";
      const elapsedMs = Math.round(performance.now() - start);
      toolSequence.record("scroll", undefined, sessionId);
      return {
        content: [{
          type: "text",
          text: `Scrolled ${direction} ${amount}px in ${containerLabel} — position: ${pos.scrollTop}/${pos.scrollHeight - pos.clientHeight}px${grewNote}`,
        }],
        _meta: { elapsedMs, method: "scroll" },
      };
    }

    // Page scroll — single async evaluate with browser-side settle
    const result = await cdpClient.send<{ result: { value: { scrollY: number; scrollHeight: number; clientHeight: number; prevScrollHeight: number } } }>(
      "Runtime.evaluate",
      {
        expression: `(async () => {
          const prevScrollHeight = document.documentElement.scrollHeight;
          window.scrollBy(0, ${scrollY});
          await new Promise(r => setTimeout(r, ${SETTLE_MS}));
          return { scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight, clientHeight: window.innerHeight, prevScrollHeight };
        })()`,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
    );

    const pos = result.result.value;
    const grew = pos.scrollHeight - pos.prevScrollHeight;
    const grewNote = grew > 0 ? ` (content loaded: scrollHeight grew by ${grew}px)` : "";
    const elapsedMs = Math.round(performance.now() - start);
    toolSequence.record("scroll", undefined, sessionId);
    return {
      content: [{
        type: "text",
        text: `Scrolled ${direction} ${amount}px — position: ${pos.scrollY}/${pos.scrollHeight - pos.clientHeight}px${grewNote}`,
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
