import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse, ConnectionStatus } from "../types.js";
import type { TabStateCache } from "../cache/tab-state-cache.js";
import { wrapCdpError } from "./error-utils.js";

export const tabStatusSchema = z.object({});
export type TabStatusParams = z.infer<typeof tabStatusSchema>;

export async function tabStatusHandler(
  _params: TabStatusParams,
  cdpClient: CdpClient,
  sessionId: string | undefined,
  tabStateCache: TabStateCache,
  connectionStatus?: ConnectionStatus,
): Promise<ToolResponse> {
  const start = performance.now();

  // If disconnected or reconnecting, report status immediately
  if (connectionStatus && connectionStatus !== "connected") {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: `Connection: ${connectionStatus} — tool calls may fail until reconnected` }],
      isError: true,
      _meta: { elapsedMs, method: "tab_status" },
    };
  }

  const activeTarget = tabStateCache.activeTargetId;
  if (!activeTarget) {
    return {
      content: [{ type: "text", text: "No active tab. Use virtual_desk to discover available tabs, or navigate to a page first." }],
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
    return {
      content: [{ type: "text", text: wrapCdpError(err, "tab_status") }],
      isError: true,
      _meta: { elapsedMs, method: "tab_status" },
    };
  }
}
