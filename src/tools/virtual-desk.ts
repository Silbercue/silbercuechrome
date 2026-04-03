import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import type { TabStateCache } from "../cache/tab-state-cache.js";

export const virtualDeskSchema = z.object({});
export type VirtualDeskParams = z.infer<typeof virtualDeskSchema>;

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

function truncateUrl(url: string, maxLen: number): string {
  if (url.length <= maxLen) return url;
  const short = url.replace(/^https?:\/\//, "");
  if (short.length <= maxLen) return short;
  return short.slice(0, maxLen - 3) + "...";
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Infer loading state from CDP target info when no cache entry exists.
 * about:blank or empty title typically indicate a tab that's still loading.
 */
function inferLoadingState(target: TargetInfo): "loading" | "ready" {
  if (target.url === "" || target.url === "about:blank") return "loading";
  if (target.title === "") return "loading";
  return "ready";
}

export async function virtualDeskHandler(
  _params: VirtualDeskParams,
  cdpClient: CdpClient,
  sessionId: string | undefined,
  tabStateCache: TabStateCache,
): Promise<ToolResponse> {
  const start = performance.now();
  const method = "virtual_desk";

  try {
    // Single CDP call for ALL tabs — no N+1 problem
    const { targetInfos } = await cdpClient.send<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    const pageTabs = targetInfos.filter((t) => t.type === "page");

    if (pageTabs.length === 0) {
      return {
        content: [{ type: "text", text: "No open tabs" }],
        _meta: { elapsedMs: Math.round(performance.now() - start), method },
      };
    }

    // Cache enrichment + compact formatting
    const activeId = tabStateCache.activeTargetId;
    const lines: string[] = [];
    lines.push(`Tabs (${pageTabs.length}):`);

    for (const tab of pageTabs) {
      const isActive = tab.targetId === activeId;
      const cached = tabStateCache.get(tab.targetId);

      // Truncate for token efficiency
      const url = truncateUrl(tab.url, 80);
      const title = truncate(cached?.title || tab.title, 40);
      const status = cached?.loadingState ?? inferLoadingState(tab);
      const marker = isActive ? ">" : " ";

      lines.push(`${marker} ${tab.targetId} | ${status} | ${title} | ${url}`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      _meta: { elapsedMs: Math.round(performance.now() - start), method, tabCount: pageTabs.length },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[virtual_desk] failed after ${elapsedMs}ms:`, message);
    return {
      content: [{ type: "text", text: `virtual_desk failed: ${message}` }],
      isError: true,
      _meta: { elapsedMs, method },
    };
  }
}
