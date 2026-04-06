import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { a11yTree, RefNotFoundError } from "../cache/a11y-tree.js";
import { wrapCdpError } from "./error-utils.js";

export const readPageSchema = z.object({
  depth: z.number().optional().default(3).describe("Nesting depth — how many tree levels to display (default: 3). Controls indentation, not visibility. Hidden sections (display: none) require clicking tabs/buttons to reveal."),
  ref: z.string().optional().describe("Element ref (e.g. 'e5') to get subtree for"),
  filter: z
    .enum(["interactive", "all", "landmark", "visual"])
    .optional()
    .default("interactive")
    .describe("Filter mode: interactive (default), all, landmark, or visual (adds bounds/click/visibility)"),
  max_tokens: z.number().int().optional().transform(v => v !== undefined && v < 500 ? 500 : v).describe("Token budget — page content is automatically downsampled to fit. Omit for full output."),
});

export type ReadPageParams = z.infer<typeof readPageSchema>;

export async function readPageHandler(
  params: ReadPageParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();
  const method = "read_page";

  try {
    const result = await a11yTree.getTree(cdpClient, sessionId!, {
      depth: params.depth,
      ref: params.ref,
      filter: params.filter,
      max_tokens: params.max_tokens,
      fresh: true, // Story 13a.2 fix: always fetch fresh data — precomputed cache may be stale after SPA navigation
    }, sessionManager);

    let responseText = result.text;

    // Truncation warning — when downsampled, hint that overlays may be hidden
    if (result.downsampled && params.max_tokens) {
      responseText += `\n\n⚠ Truncated to ~${params.max_tokens} tokens (full page: ~${result.originalTokens}). Overlays/modals are prioritized but some elements may be hidden — retry without max_tokens or use screenshot to check for modals.`;
    }

    // FR-H6: Detect hidden interactive elements — hint when page has hidden sections
    if (params.filter === "interactive" && result.refCount > 0) {
      try {
        const hiddenResult = await cdpClient.send<{ result: { value: number } }>(
          "Runtime.evaluate",
          {
            expression: `(() => { let h = 0; for (const el of document.querySelectorAll('button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="tab"],[role="link"]')) { if (el.offsetParent === null) { const p = getComputedStyle(el).position; if (p !== "fixed" && p !== "sticky") h++; } } return h; })()`,
            returnByValue: true,
          },
          sessionId,
        );
        const hiddenCount = hiddenResult?.result?.value;
        if (typeof hiddenCount === "number" && hiddenCount >= 5) {
          responseText += `\n\nNote: ${hiddenCount} interactive elements are hidden (display: none). Click tabs/buttons to reveal hidden sections.`;
        }
      } catch {
        // Best-effort — ignore errors
      }
    }

    const elapsedMs = Math.round(performance.now() - start);

    return {
      content: [{ type: "text", text: responseText }],
      _meta: {
        elapsedMs,
        method,
        refCount: result.refCount,
        depth: result.depth,
        tokenCount: result.tokenCount,
        pageUrl: result.pageUrl,
        ...(result.hasVisualData !== undefined ? { hasVisualData: result.hasVisualData } : {}),
        ...(result.downsampled ? {
          downsampled: true,
          originalTokens: result.originalTokens,
          downsampleLevel: result.downsampleLevel,
        } : {}),
      },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);

    if (err instanceof RefNotFoundError) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
        _meta: { elapsedMs, method },
      };
    }

    return {
      content: [{ type: "text", text: wrapCdpError(err, "read_page") }],
      isError: true,
      _meta: { elapsedMs, method },
    };
  }
}
