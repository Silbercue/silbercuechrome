import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { wrapCdpError } from "./error-utils.js";
import type { HumanTouchConfig } from "../operator/human-touch.js";
import { humanMouseMove } from "../operator/human-touch.js";

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

export type ClickMethod = "cdp" | "js-rect" | "js-click";

async function dispatchClick(
  cdpClient: CdpClient,
  sessionId: string,
  backendNodeId: number,
  objectId: string,
  humanTouch?: HumanTouchConfig,
): Promise<ClickMethod> {
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

  // Step 3: Get viewport-relative center — try getContentQuads, fallback chain
  let x: number;
  let y: number;
  let clickMethod: ClickMethod = "cdp";

  try {
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
    x = (q[0] + q[2] + q[4] + q[6]) / 4;
    y = (q[1] + q[3] + q[5] + q[7]) / 4;
  } catch {
    // Fallback 1: getBoundingClientRect via Runtime.callFunctionOn
    // Handles Shadow-DOM nodes and post-mutation stale layouts (BUG-005, BUG-007, BUG-012)
    try {
      const rectResult = await cdpClient.send<{
        result: { value: { x: number; y: number } };
      }>(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: `function() {
            var rect = this.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }`,
          objectId,
          returnByValue: true,
        },
        sessionId,
      );
      x = rectResult.result.value.x;
      y = rectResult.result.value.y;
      clickMethod = "js-rect";
    } catch {
      // Fallback 2: Pure JS click — no coordinates needed
      await cdpClient.send(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: `function() { this.click(); }`,
          objectId,
          returnByValue: false,
        },
        sessionId,
      );
      return "js-click";
    }
  }

  // Step 4: Human touch — Bezier mouse movement before click
  if (humanTouch?.enabled) {
    await humanMouseMove(cdpClient, sessionId, 0, 0, x, y, humanTouch);
  }

  // Step 5: Dispatch mouse events — mouseMoved → mousePressed → mouseReleased
  // mouseMoved establishes mouseenter/mouseover context (BUG-002)
  await cdpClient.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x, y, button: "none", buttons: 0 },
    sessionId,
  );
  await cdpClient.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
    sessionId,
  );
  await cdpClient.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
    sessionId,
  );

  return clickMethod;
}

// --- Main handler (Task 6) ---

export async function clickHandler(
  params: ClickParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
  humanTouch?: HumanTouchConfig,
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
    const clickMethod = await dispatchClick(
      cdpClient, element.resolvedSessionId, element.backendNodeId, element.objectId, humanTouch,
    );

    // Success response — no settle, click returns immediately.
    // If the click triggers navigation, use wait_for or navigate to wait for the page to load.
    const elapsedMs = Math.round(performance.now() - start);
    const suffix = clickMethod !== "cdp" ? `, fallback: ${clickMethod}` : "";
    return {
      content: [
        {
          type: "text",
          text: `Clicked ${params.ref ?? params.selector} (${element.resolvedVia}${suffix})`,
        },
      ],
      _meta: {
        elapsedMs,
        method: "click",
        resolvedVia: element.resolvedVia,
        clickMethod,
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
    return {
      content: [{ type: "text", text: wrapCdpError(err, "click") }],
      isError: true,
      _meta: { elapsedMs, method: "click" },
    };
  }
}
