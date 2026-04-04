import { z } from "zod";
import type { ConsoleCollector } from "../cdp/console-collector.js";
import type { ToolResponse } from "../types.js";

export const consoleLogsSchema = z.object({
  level: z.enum(["info", "warning", "error", "debug"])
    .optional()
    .describe("Filter by log level"),
  pattern: z.string()
    .optional()
    .describe("Regex pattern to match against log text"),
  clear: z.boolean()
    .optional()
    .default(false)
    .describe("Clear the log buffer after returning results"),
});

export type ConsoleLogsParams = z.infer<typeof consoleLogsSchema>;

export async function consoleLogsHandler(
  params: ConsoleLogsParams,
  consoleCollector: ConsoleCollector,
): Promise<ToolResponse> {
  const start = performance.now();

  // 1. Retrieve logs (filtered or all)
  let logs;
  try {
    logs = (params.level || params.pattern)
      ? consoleCollector.getFiltered(params.level, params.pattern)
      : consoleCollector.getAll();
  } catch (err) {
    // Invalid regex pattern
    return {
      content: [{ type: "text", text: `Invalid regex pattern: ${(err as Error).message}` }],
      isError: true,
      _meta: { elapsedMs: Math.round(performance.now() - start), method: "console_logs" },
    };
  }

  // 2. Clear buffer after retrieval if requested
  if (params.clear) {
    consoleCollector.clear();
  }

  // 3. Return logs as JSON array
  return {
    content: [{ type: "text", text: JSON.stringify(logs) }],
    _meta: {
      elapsedMs: Math.round(performance.now() - start),
      method: "console_logs",
      count: logs.length,
    },
  };
}
