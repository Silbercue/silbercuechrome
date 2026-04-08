import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { EMULATED_WIDTH, EMULATED_HEIGHT, isHeadless } from "../cdp/emulation.js";
import { wrapCdpError } from "./error-utils.js";
import { a11yTree } from "../cache/a11y-tree.js";
import { CLICKABLE_TAGS, CLICKABLE_ROLES, COMPUTED_STYLES } from "./visual-constants.js";

export const screenshotSchema = z.object({
  full_page: z
    .boolean()
    .optional()
    .default(false)
    .describe("Capture full scrollable page instead of just viewport"),
  som: z
    .boolean()
    .optional()
    .default(false)
    .describe("Overlay numbered labels on interactive elements matching read_page ref IDs (Set-of-Mark)"),
});

export type ScreenshotParams = z.infer<typeof screenshotSchema>;

const MAX_WIDTH = 800;
const QUALITY = 80;
const RETRY_QUALITY = 50;
const MAX_BYTES = 100_000; // 100 KB size guard (promised in tool description)
const SOM_MAX_LABELS = 80;
const SOM_MIN_SIZE = 10;

interface LayoutMetrics {
  cssContentSize: { width: number; height: number };
}

// --- SoM DOMSnapshot types ---

interface SomSnapshotDocument {
  nodes: {
    backendNodeId: number[];
    nodeName: number[];
  };
  layout: {
    nodeIndex: number[];
    bounds: number[][];
    styles: number[][];
    paintOrders: number[];
  };
}

interface SomCaptureSnapshotResponse {
  documents: SomSnapshotDocument[];
  strings: string[];
}

interface SomLabel {
  ref: string;
  bounds: { x: number; y: number; w: number; h: number };
  isClickable: boolean;
  paintOrder: number;
}

// --- SoM Pipeline Helpers ---

function collectSomLabels(
  snapshot: SomCaptureSnapshotResponse,
  sessionId?: string,
): SomLabel[] {
  if (!snapshot.documents || snapshot.documents.length === 0) return [];

  const doc = snapshot.documents[0];
  const strings = snapshot.strings;

  // Build layout index map: nodeIndex → layoutIndex
  const layoutMap = new Map<number, number>();
  for (let li = 0; li < doc.layout.nodeIndex.length; li++) {
    layoutMap.set(doc.layout.nodeIndex[li], li);
  }

  const labels: SomLabel[] = [];
  const totalNodes = doc.nodes.backendNodeId.length;

  for (let ni = 0; ni < totalNodes; ni++) {
    const backendNodeId = doc.nodes.backendNodeId[ni];

    // Must have an A11y ref
    // BUG-016: screenshot/SoM run against the main-frame session; pass
    // sessionId so the composite-keyed refMap resolves the owner.
    const ref = a11yTree.getRefForBackendNodeId(backendNodeId, sessionId);
    if (!ref) continue;

    // Must have layout data
    const li = layoutMap.get(ni);
    if (li === undefined) continue;

    // Read bounds
    const boundsArr = doc.layout.bounds[li];
    if (!boundsArr || boundsArr.length < 4) continue;

    const [x, y, w, h] = boundsArr;

    // Visibility check via computed styles (display, visibility are indices 0, 1)
    const styleProps = doc.layout.styles[li] ?? [];
    const displayIdx = styleProps[0];
    const visibilityIdx = styleProps[1];
    const displayVal = (displayIdx !== undefined && displayIdx >= 0 && displayIdx < strings.length)
      ? strings[displayIdx] : "";
    const visibilityVal = (visibilityIdx !== undefined && visibilityIdx >= 0 && visibilityIdx < strings.length)
      ? strings[visibilityIdx] : "";

    if (displayVal === "none" || visibilityVal === "hidden") continue;

    // Viewport check
    if (x + w <= 0 || y + h <= 0 || x >= EMULATED_WIDTH || y >= EMULATED_HEIGHT) continue;

    // Minimum size
    if (w < SOM_MIN_SIZE || h < SOM_MIN_SIZE) continue;

    // isClickable heuristic — check tag name from snapshot (M1: shared constants)
    const tagIdx = doc.nodes.nodeName[ni];
    const tag = (tagIdx !== undefined && tagIdx >= 0 && tagIdx < strings.length) ? strings[tagIdx] : "";
    const nodeInfo = a11yTree.getNodeInfo(backendNodeId);
    const isClickable = CLICKABLE_TAGS.has(tag) || (nodeInfo ? CLICKABLE_ROLES.has(nodeInfo.role) : false);

    // C1: Only label clickable/interactive elements
    if (!isClickable) continue;

    const paintOrder = doc.layout.paintOrders?.[li] ?? 0;

    labels.push({
      ref,
      bounds: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
      isClickable,
      paintOrder,
    });
  }

  // Anti-clutter: limit to SOM_MAX_LABELS, prioritize clickable + front paint order
  if (labels.length > SOM_MAX_LABELS) {
    labels.sort((a, b) => {
      if (a.isClickable !== b.isClickable) return a.isClickable ? -1 : 1;
      return b.paintOrder - a.paintOrder;
    });
    labels.length = SOM_MAX_LABELS;
  }

  return labels;
}

function buildSomInjectScript(labels: SomLabel[]): string {
  const labelData = labels.map((l) => ({
    ref: l.ref,
    x: l.bounds.x,
    y: l.bounds.y,
  }));

  return `(() => {
  const data = ${JSON.stringify(labelData)};
  const style = document.createElement('style');
  style.id = '__som_style__';
  style.textContent = \`
    .__som_label {
      position: absolute;
      z-index: 2147483647;
      pointer-events: none;
      background: rgba(255, 87, 34, 0.85);
      color: white;
      font-size: 10px;
      font-family: monospace;
      font-weight: bold;
      line-height: 1;
      padding: 1px 3px;
      border-radius: 2px;
      white-space: nowrap;
    }
  \`;
  document.head.appendChild(style);
  const container = document.createElement('div');
  container.id = '__som_overlay__';
  container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none;';
  for (const d of data) {
    const el = document.createElement('div');
    el.className = '__som_label';
    el.style.top = d.y + 'px';
    el.style.left = d.x + 'px';
    el.textContent = d.ref;
    container.appendChild(el);
  }
  document.body.appendChild(container);
})()`;
}

const SOM_REMOVE_SCRIPT = `(() => {
  const overlay = document.getElementById('__som_overlay__');
  if (overlay) overlay.remove();
  const style = document.getElementById('__som_style__');
  if (style) style.remove();
})()`;

// --- Handler ---

export async function screenshotHandler(
  params: ScreenshotParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

  try {
    // In headed mode (no Emulation.setDeviceMetricsOverride), clip coordinates are
    // in page/document space. We must offset by scroll position to capture the
    // visible viewport, otherwise we capture the top of the page (which may be
    // off-screen and return a black image from the compositor).
    let clipX = 0;
    let clipY = 0;
    if (!isHeadless() && !params.full_page) {
      const scrollResult = await cdpClient.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        { expression: "JSON.stringify({x:window.scrollX,y:window.scrollY})", returnByValue: true },
        sessionId,
      );
      try {
        const scroll = JSON.parse(scrollResult.result.value);
        clipX = scroll.x || 0;
        clipY = scroll.y || 0;
      } catch { /* fallback to 0,0 */ }
    }

    const captureParams: Record<string, unknown> = {
      format: "webp",
      quality: QUALITY,
      optimizeForSpeed: true,
      clip: {
        x: clipX,
        y: clipY,
        width: EMULATED_WIDTH,
        height: EMULATED_HEIGHT,
        scale: MAX_WIDTH / EMULATED_WIDTH,
      },
    };

    if (params.full_page) {
      const metrics = await cdpClient.send<LayoutMetrics>(
        "Page.getLayoutMetrics",
        {},
        sessionId,
      );
      const { width, height } = metrics.cssContentSize;

      // H3: Guard against zero/negative dimensions — fall back to viewport
      if (width <= 0 || height <= 0) {
        captureParams.clip = {
          x: 0,
          y: 0,
          width: EMULATED_WIDTH,
          height: EMULATED_HEIGHT,
          scale: MAX_WIDTH / EMULATED_WIDTH,
        };
      } else {
        captureParams.clip = {
          x: 0,
          y: 0,
          width,
          height,
          scale: MAX_WIDTH / width,
        };
        captureParams.captureBeyondViewport = true;
      }
    }

    // --- SoM Pipeline: inject overlay before screenshot, remove after ---
    let somElements: number | undefined;
    let somFailed = false;

    if (params.som) {
      try {
        // C2: Always refresh A11y refs — after navigation they may be stale
        await a11yTree.getTree(cdpClient, sessionId!, {}, sessionManager);

        // Capture DOMSnapshot for bounding boxes
        const snapshot = await cdpClient.send<SomCaptureSnapshotResponse>(
          "DOMSnapshot.captureSnapshot",
          {
            computedStyles: [...COMPUTED_STYLES],
            includeDOMRects: true,
            includeBlendedBackgroundColors: true,
            includePaintOrder: true,
          },
          sessionId,
        );

        const labels = collectSomLabels(snapshot, sessionId);
        somElements = labels.length;

        if (labels.length > 0) {
          // H2: try/finally wraps entire inject+screenshot+cleanup so even inject errors run cleanup
          try {
            // Inject overlay
            await cdpClient.send("Runtime.evaluate", {
              expression: buildSomInjectScript(labels),
            }, sessionId);

            let result = await cdpClient.send<{ data: string }>(
              "Page.captureScreenshot", captureParams, sessionId,
            );

            let bytes = Math.ceil(result.data.length * 3 / 4);

            // Size guard
            if (bytes > MAX_BYTES) {
              captureParams.quality = RETRY_QUALITY;
              result = await cdpClient.send<{ data: string }>(
                "Page.captureScreenshot", captureParams, sessionId,
              );
              bytes = Math.ceil(result.data.length * 3 / 4);
            }

            const elapsedMs = Math.round(performance.now() - start);
            return {
              content: [{ type: "image", data: result.data, mimeType: "image/webp" }],
              _meta: {
                elapsedMs,
                method: "screenshot",
                bytes,
                somElements,
              },
            };
          } finally {
            // Cleanup guarantee — remove overlay even on error
            await cdpClient.send("Runtime.evaluate", {
              expression: SOM_REMOVE_SCRIPT,
            }, sessionId).catch(() => { /* best-effort cleanup */ });
          }
        }
        // If no labels, fall through to normal screenshot with somElements = 0
      } catch (somErr) {
        // H1: SoM pipeline failed — fall through to normal screenshot
        somFailed = true;
        somElements = undefined;
      }
    }

    // Normal screenshot (som === false OR som with 0 labels)
    let result = await cdpClient.send<{ data: string }>(
      "Page.captureScreenshot", captureParams, sessionId,
    );

    let bytes = Math.ceil(result.data.length * 3 / 4);

    // C1: Size guard — retry once with lower quality if >100KB
    if (bytes > MAX_BYTES) {
      captureParams.quality = RETRY_QUALITY;
      result = await cdpClient.send<{ data: string }>(
        "Page.captureScreenshot", captureParams, sessionId,
      );
      bytes = Math.ceil(result.data.length * 3 / 4);
    }

    const elapsedMs = Math.round(performance.now() - start);

    return {
      content: [{ type: "image", data: result.data, mimeType: "image/webp" }],
      _meta: {
        elapsedMs,
        method: "screenshot",
        bytes,
        ...(somElements !== undefined ? { somElements } : {}),
        ...(somFailed ? { somFailed: true } : {}),
      },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "screenshot") }],
      isError: true,
      _meta: { elapsedMs, method: "screenshot" },
    };
  }
}
