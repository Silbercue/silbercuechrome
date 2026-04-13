import { z } from "zod";
import type { DownloadCollector, DownloadInfo } from "../cdp/download-collector.js";
import type { ToolResponse } from "../types.js";

export const downloadSchema = z.object({
  action: z.enum(["status", "list"])
    .default("status")
    .describe("status: check/wait for pending downloads, list: show all session downloads"),
  timeout: z.number()
    .optional()
    .default(30_000)
    .describe("Max wait time in ms for pending downloads (default: 30000)"),
});

export type DownloadParams = z.infer<typeof downloadSchema>;

function formatDownload(d: DownloadInfo): Record<string, unknown> {
  return {
    filename: d.suggestedFilename,
    path: d.path,
    size: d.size,
    sizeKb: Math.ceil(d.size / 1024),
    url: d.url,
  };
}

export async function downloadHandler(
  params: DownloadParams,
  downloadCollector: DownloadCollector,
): Promise<ToolResponse> {
  const start = performance.now();
  const action = params.action ?? "status";

  // --- action: "list" ---
  if (action === "list") {
    const all = downloadCollector.getAllDownloads();
    if (all.length === 0) {
      return {
        content: [{ type: "text", text: "No downloads in this session." }],
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "download", count: 0 },
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(all.map(formatDownload)) }],
      _meta: { elapsedMs: Math.round(performance.now() - start), method: "download", count: all.length },
    };
  }

  // --- action: "status" (default) ---
  const pending = downloadCollector.pendingCount;
  const alreadyCompleted = downloadCollector.consumeCompleted();

  // Nothing in progress and nothing completed — quick exit
  if (pending === 0 && alreadyCompleted.length === 0) {
    return {
      content: [{ type: "text", text: "No downloads in progress or completed." }],
      _meta: { elapsedMs: Math.round(performance.now() - start), method: "download", pending: 0 },
    };
  }

  // If downloads are pending — wait for them
  let newlyCompleted: DownloadInfo[] = [];
  if (pending > 0) {
    const timeout = params.timeout ?? 30_000;
    newlyCompleted = await downloadCollector.waitForCompletion(timeout);
  }

  const allCompleted = [...alreadyCompleted, ...newlyCompleted];
  const stillPending = downloadCollector.pendingCount;

  const result: Record<string, unknown> = {
    downloads: allCompleted.map(formatDownload),
    pending: stillPending,
  };

  if (stillPending > 0) {
    result.note = `${stillPending} download(s) still in progress after timeout.`;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    _meta: {
      elapsedMs: Math.round(performance.now() - start),
      method: "download",
      count: allCompleted.length,
      pending: stillPending,
    },
  };
}
