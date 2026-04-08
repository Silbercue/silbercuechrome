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

  // If disconnected or reconnecting, report status with actionable hint.
  // BUG: Previously this returned a single non-actionable line
  // ("Connection: disconnected — tool calls may fail until reconnected").
  // An LLM agent had no way to distinguish a transient dropout from a
  // permanently-lost Chrome, and no guidance on what to do next. Now we
  // emit a multi-line text block with Reason + Hint for each sub-state.
  if (connectionStatus && connectionStatus !== "connected") {
    const elapsedMs = Math.round(performance.now() - start);
    const lines = [`Connection: ${connectionStatus}`];
    if (connectionStatus === "reconnecting") {
      lines.push(
        "Reason: CDP transport dropped — automatic reconnect in progress (up to 5 attempts with exponential backoff).",
        "Hint: Wait ~2-3 seconds and retry this call. No manual action needed; if reconnect succeeds, subsequent calls return to normal.",
      );
    } else {
      lines.push(
        "Reason: Chrome was closed or crashed and all automatic reconnect attempts failed. The MCP server can no longer reach Chrome via CDP.",
        "Hint: Restart the MCP server (or your Claude Code session) so SilbercueChrome can auto-launch a fresh Chrome. Alternatively, start Chrome yourself with --remote-debugging-port=9222 before restarting. Auto-launch only runs at server startup — calling navigate/switch_tab now will not recover the connection.",
      );
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      isError: true,
      _meta: { elapsedMs, method: "tab_status", connectionStatus },
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
