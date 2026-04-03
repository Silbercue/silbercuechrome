import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";

export const screenshotSchema = z.object({
  full_page: z
    .boolean()
    .optional()
    .default(false)
    .describe("Capture full scrollable page instead of just viewport"),
});

export type ScreenshotParams = z.infer<typeof screenshotSchema>;

const MAX_BYTES = 100 * 1024;
const MAX_WIDTH = 800;
const QUALITY_STEPS = [80, 60, 40];

interface ViewportMetrics {
  width: number;
  height: number;
}

interface ScrollMetrics {
  scrollWidth: number;
  scrollHeight: number;
}

export async function screenshotHandler(
  params: ScreenshotParams,
  cdpClient: CdpClient,
  sessionId?: string,
): Promise<ToolResponse> {
  const start = performance.now();

  try {
    // Get viewport size
    const viewportResult = await cdpClient.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      {
        expression:
          "JSON.stringify({ width: document.documentElement.clientWidth || window.innerWidth, height: document.documentElement.clientHeight || window.innerHeight })",
        returnByValue: true,
      },
      sessionId,
    );
    const viewport: ViewportMetrics = JSON.parse(viewportResult.result.value);

    // Guard against invalid viewport values
    if (!viewport.width || !viewport.height || viewport.width <= 0 || viewport.height <= 0) {
      viewport.width = viewport.width && viewport.width > 0 ? viewport.width : 1280;
      viewport.height = viewport.height && viewport.height > 0 ? viewport.height : 720;
    }

    // Determine capture dimensions and scale
    let captureWidth = viewport.width;
    let captureHeight = viewport.height;
    let captureBeyondViewport = false;

    if (params.full_page) {
      const scrollResult = await cdpClient.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        {
          expression:
            "JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight })",
          returnByValue: true,
        },
        sessionId,
      );
      const scroll: ScrollMetrics = JSON.parse(scrollResult.result.value);
      captureWidth = scroll.scrollWidth;
      captureHeight = scroll.scrollHeight;
      captureBeyondViewport = true;
    }

    const scale = captureWidth > MAX_WIDTH ? MAX_WIDTH / captureWidth : 1;

    // Capture with quality fallback
    let lastData = "";
    let lastBytes = 0;

    for (const quality of QUALITY_STEPS) {
      const result = await cdpClient.send<{ data: string }>(
        "Page.captureScreenshot",
        {
          format: "webp",
          quality,
          clip: {
            x: 0,
            y: 0,
            width: captureWidth,
            height: captureHeight,
            scale,
          },
          captureBeyondViewport,
        },
        sessionId,
      );

      lastData = result.data;
      lastBytes = Math.ceil(lastData.length * 3 / 4);

      if (lastBytes <= MAX_BYTES) {
        break;
      }
    }

    const elapsedMs = Math.round(performance.now() - start);
    const resultWidth = Math.round(captureWidth * scale);
    const resultHeight = Math.round(captureHeight * scale);

    return {
      content: [{ type: "image", data: lastData, mimeType: "image/webp" }],
      _meta: {
        elapsedMs,
        method: "screenshot",
        width: resultWidth,
        height: resultHeight,
        bytes: lastBytes,
      },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `screenshot failed: ${message}` }],
      isError: true,
      _meta: { elapsedMs, method: "screenshot" },
    };
  }
}
