import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { settle } from "../cdp/settle.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";

// --- Schema (Task 2) ---

export const clickSchema = z.object({
  ref: z
    .string()
    .optional()
    .describe("A11y-Tree element ref (e.g. 'e5') — preferred over selector"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector (e.g. '#submit-btn') — fallback when ref is not available"),
});

export type ClickParams = z.infer<typeof clickSchema>;

// --- Click dispatch (Task 4) ---

async function dispatchClick(
  cdpClient: CdpClient,
  sessionId: string,
  backendNodeId: number,
): Promise<void> {
  // Step 1: Scroll into view
  await cdpClient.send(
    "DOM.scrollIntoViewIfNeeded",
    { backendNodeId },
    sessionId,
  );

  // Step 2: Get box model
  const box = await cdpClient.send<{ model: { content: number[] } }>(
    "DOM.getBoxModel",
    { backendNodeId },
    sessionId,
  );

  // Step 3: Calculate center point
  const quad = box.model.content;
  const x = (quad[0] + quad[2]) / 2;
  const y = (quad[1] + quad[5]) / 2;

  // Step 4: Dispatch mouse events
  await cdpClient.send(
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    },
    sessionId,
  );
  await cdpClient.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    },
    sessionId,
  );
}

// --- Main handler (Task 6) ---

export async function clickHandler(
  params: ClickParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

  // Validation (Task 2.4)
  if (!params.ref && !params.selector) {
    return {
      content: [
        {
          type: "text",
          text: "click requires either 'ref' (e.g. 'e5') or 'selector' (e.g. '#submit-btn')",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "click" },
    };
  }

  try {
    // Resolve element via shared utility (with OOPIF routing)
    const target = params.ref ? { ref: params.ref } : { selector: params.selector };
    const element = await resolveElement(cdpClient, sessionId!, target, sessionManager);

    // Dispatch click using the resolved session (may be OOPIF or main)
    await dispatchClick(cdpClient, element.resolvedSessionId, element.backendNodeId);

    // Auto-settle — always on main frame session (navigation is main-frame concern)
    const frameTree = await cdpClient.send<{ frameTree: { frame: { id: string } } }>(
      "Page.getFrameTree",
      {},
      sessionId!,
    );
    const frameId = frameTree.frameTree.frame.id;

    const settleResult = await settle({
      cdpClient,
      sessionId: sessionId!,
      frameId,
      settleMs: 500,
      timeoutMs: 5000,
    });

    // Success response
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [
        {
          type: "text",
          text: `Clicked ${params.ref ?? params.selector} (${element.resolvedVia})`,
        },
      ],
      _meta: {
        elapsedMs,
        method: "click",
        resolvedVia: element.resolvedVia,
        settleSignal: settleResult.signal,
        settleMs: settleResult.elapsedMs,
      },
    };
  } catch (err) {
    if (err instanceof RefNotFoundError && params.ref) {
      const errorText = buildRefNotFoundError(params.ref);
      return {
        content: [{ type: "text", text: errorText }],
        isError: true,
        _meta: { elapsedMs: 0, method: "click" },
      };
    }
    const elapsedMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `click failed: ${message}` }],
      isError: true,
      _meta: { elapsedMs, method: "click" },
    };
  }
}
