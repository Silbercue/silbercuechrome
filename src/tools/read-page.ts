import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { a11yTree, RefNotFoundError } from "../cache/a11y-tree.js";

export const readPageSchema = z.object({
  depth: z.number().optional().default(3).describe("Tree depth to return (default: 3)"),
  ref: z.string().optional().describe("Element ref (e.g. 'e5') to get subtree for"),
  filter: z
    .enum(["interactive", "all", "landmark", "visual"])
    .optional()
    .default("interactive")
    .describe("Filter mode: interactive (default), all, landmark, or visual (adds bounds/click/visibility)"),
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
    }, sessionManager);

    const elapsedMs = Math.round(performance.now() - start);

    return {
      content: [{ type: "text", text: result.text }],
      _meta: {
        elapsedMs,
        method,
        refCount: result.refCount,
        depth: result.depth,
        ...(result.hasVisualData !== undefined ? { hasVisualData: result.hasVisualData } : {}),
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

    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `read_page failed: ${message}` }],
      isError: true,
      _meta: { elapsedMs, method },
    };
  }
}
