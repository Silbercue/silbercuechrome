import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { a11yTree, RefNotFoundError } from "../cache/a11y-tree.js";
import { wrapCdpError } from "./error-utils.js";

export const readPageSchema = z.object({
  depth: z.number().optional().default(3).describe("Tree depth to return (default: 3)"),
  ref: z.string().optional().describe("Element ref (e.g. 'e5') to get subtree for"),
  filter: z
    .enum(["interactive", "all", "landmark", "visual"])
    .optional()
    .default("interactive")
    .describe("Filter mode: interactive (default), all, landmark, or visual (adds bounds/click/visibility)"),
  max_tokens: z.number().int().min(500).optional().describe("Token budget — page content is automatically downsampled to fit. Omit for full output."),
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
