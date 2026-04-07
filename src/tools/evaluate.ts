import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse, ToolContentBlock } from "../types.js";
import { EMULATED_WIDTH, EMULATED_HEIGHT, isHeadless } from "../cdp/emulation.js";
import { wrapCdpError } from "./error-utils.js";
import { isStyleChange, extractSelector, formatGeometryDiff, type BoundingRect } from "./style-change-detection.js";

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

const SCREENSHOT_PADDING = 80;
const SCREENSHOT_QUALITY = 80;
const SCREENSHOT_MAX_WIDTH = 800;
const SETTLE_MS = 50;

/**
 * Captures getBoundingClientRect for the first element matching `selector`.
 * Returns null if the element doesn't exist or the query fails.
 */
async function captureBoundingRect(
  cdpClient: CdpClient,
  selector: string,
  sessionId?: string,
): Promise<BoundingRect | null> {
  try {
    const result = await cdpClient.send<RuntimeEvaluateResult>(
      "Runtime.evaluate",
      {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    );
    if (result.exceptionDetails || !result.result.value) return null;
    return result.result.value as BoundingRect;
  } catch {
    return null;
  }
}

/**
 * Captures a clip screenshot around a bounding rect with padding.
 * Falls back to viewport screenshot if clip capture fails.
 */
async function captureClipScreenshot(
  cdpClient: CdpClient,
  rect: BoundingRect | null,
  sessionId?: string,
): Promise<string | null> {
  try {
    // BUG-015: Focus emulation for reliable screenshots
    await cdpClient.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {});

    // Scroll offset for headed mode
    let scrollX = 0;
    let scrollY = 0;
    if (!isHeadless()) {
      const scrollResult = await cdpClient.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        { expression: "JSON.stringify({x:window.scrollX,y:window.scrollY})", returnByValue: true },
        sessionId,
      );
      try {
        const scroll = JSON.parse(scrollResult.result.value);
        scrollX = scroll.x || 0;
        scrollY = scroll.y || 0;
      } catch { /* fallback to 0,0 */ }
    }

    const viewportParams: Record<string, unknown> = {
      format: "webp",
      quality: SCREENSHOT_QUALITY,
      optimizeForSpeed: true,
      clip: {
        x: scrollX, y: scrollY,
        width: EMULATED_WIDTH, height: EMULATED_HEIGHT,
        scale: SCREENSHOT_MAX_WIDTH / EMULATED_WIDTH,
      },
    };

    if (rect) {
      // Try clip around element with padding, clamped to viewport
      const x = Math.max(0, rect.x - SCREENSHOT_PADDING) + scrollX;
      const y = Math.max(0, rect.y - SCREENSHOT_PADDING) + scrollY;
      const right = Math.min(EMULATED_WIDTH, rect.x + rect.width + SCREENSHOT_PADDING);
      const bottom = Math.min(EMULATED_HEIGHT, rect.y + rect.height + SCREENSHOT_PADDING);
      const w = right - Math.max(0, rect.x - SCREENSHOT_PADDING);
      const h = bottom - Math.max(0, rect.y - SCREENSHOT_PADDING);

      try {
        const result = await cdpClient.send<{ data: string }>(
          "Page.captureScreenshot",
          {
            format: "webp",
            quality: SCREENSHOT_QUALITY,
            optimizeForSpeed: true,
            clip: { x, y, width: w, height: h, scale: SCREENSHOT_MAX_WIDTH / EMULATED_WIDTH },
          },
          sessionId,
        );
        return result.data;
      } catch {
        // H2: Clip failed → fall through to viewport
      }
    }

    // Viewport fallback (also used when rect is null)
    const result = await cdpClient.send<{ data: string }>(
      "Page.captureScreenshot", viewportParams, sessionId,
    );
    return result.data;
  } catch {
    return null;
  }
}

export async function evaluateHandler(
  params: EvaluateParams,
  cdpClient: CdpClient,
  sessionId?: string,
): Promise<ToolResponse> {
  const start = performance.now();

  try {
    // --- Style-Change Detection (zero-cost for non-style expressions) ---
    const styleChange = isStyleChange(params.expression);
    const selector = styleChange ? extractSelector(params.expression) : null;

    // Capture before-rect if style change with identifiable selector
    let beforeRect: BoundingRect | null = null;
    if (styleChange && selector) {
      beforeRect = await captureBoundingRect(cdpClient, selector, sessionId);
    }

    // --- Execute expression (unchanged logic) ---
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

    // --- Visual Feedback (only for style changes, after successful execution) ---
    const content: ToolContentBlock[] = [{ type: "text", text }];

    if (styleChange) {
      // Brief settle to let the browser render
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      // Capture after-rect + geometry diff
      let afterRect: BoundingRect | null = null;
      if (selector) {
        afterRect = await captureBoundingRect(cdpClient, selector, sessionId);

        if (beforeRect && afterRect) {
          content.push({ type: "text", text: formatGeometryDiff(selector, beforeRect, afterRect) });
        }
      }

      // Clip screenshot (around element if identifiable, else viewport)
      const screenshotData = await captureClipScreenshot(
        cdpClient,
        afterRect, // null → viewport fallback
        sessionId,
      );

      if (screenshotData) {
        content.push({ type: "image", data: screenshotData, mimeType: "image/webp" });
      }
    }

    return {
      content,
      _meta: {
        elapsedMs: Math.round(performance.now() - start),
        method: "evaluate",
        ...(styleChange ? { visualFeedback: true } : {}),
      },
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
