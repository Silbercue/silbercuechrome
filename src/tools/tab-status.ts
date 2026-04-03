import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import type { TabStateCache } from "../cache/tab-state-cache.js";

export const tabStatusSchema = z.object({});
export type TabStatusParams = z.infer<typeof tabStatusSchema>;

export async function tabStatusHandler(
  _params: TabStatusParams,
  cdpClient: CdpClient,
  sessionId: string | undefined,
  tabStateCache: TabStateCache,
): Promise<ToolResponse> {
  const start = performance.now();

  const activeTarget = tabStateCache.activeTargetId;
  if (!activeTarget) {
    return {
      content: [{ type: "text", text: "No active tab. Navigate to a page first." }],
      isError: true,
      _meta: { elapsedMs: Math.round(performance.now() - start), method: "tab_status" },
    };
  }

  try {
    const { state, cacheHit } = await tabStateCache.getOrFetch(cdpClient, activeTarget, sessionId);
    const elapsedMs = Math.round(performance.now() - start);

    const lines = [
      `URL: ${state.url}`,
      `Title: ${state.title}`,
      `DOM: ${state.domReady ? "ready" : "loading"}`,
    ];
    if (state.consoleErrors.length > 0) {
      lines.push(`Errors (${state.consoleErrors.length}):`);
      for (const err of state.consoleErrors) {
        lines.push(`  - ${err.slice(0, 200)}`);
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      _meta: { elapsedMs, method: "tab_status", cacheHit },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `tab_status failed: ${message}` }],
      isError: true,
      _meta: { elapsedMs, method: "tab_status" },
    };
  }
}
