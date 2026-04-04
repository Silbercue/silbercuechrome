import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
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
  // Step 1: Reset scroll to origin before clicking.
  // When Emulation.setDeviceMetricsOverride is active, Input.dispatchMouseEvent
  // hit-tests at document coordinates (viewport + scrollY) instead of viewport
  // coordinates. Scrolling to 0 ensures viewport coords = document coords.
  await cdpClient.send(
    "Runtime.evaluate",
    { expression: "window.scrollTo(0,0)" },
    sessionId,
  );

  // Step 2: Scroll element into view (from scroll 0)
  await cdpClient.send(
    "DOM.scrollIntoViewIfNeeded",
    { backendNodeId },
    sessionId,
  );

  // Step 3: Get viewport-relative center via DOM.getContentQuads
  const quadsResult = await cdpClient.send<{ quads: number[][] }>(
    "DOM.getContentQuads",
    { backendNodeId },
    sessionId,
  );
  if (!quadsResult.quads || quadsResult.quads.length === 0) {
    throw new Error("Element has no visible layout quads");
  }
  // Quad is [x1,y1, x2,y2, x3,y3, x4,y4] — average all 4 corners for center
  const q = quadsResult.quads[0];
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;

  // Step 3: Dispatch mouse events at viewport coordinates
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

    // Success response — no settle, click returns immediately.
    // If the click triggers navigation, use wait_for or navigate to wait for the page to load.
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
