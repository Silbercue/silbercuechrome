import type { ToolRegistry } from "../registry.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import { debug } from "../cdp/debug.js";

/**
 * Story 7.6: Creates a Registry-Wrapper that routes executeTool() calls
 * through a Tab-specific CDP session.
 *
 * The wrapper implements only the executeTool interface that the PlanExecutor needs.
 * It attaches to the target tab via Target.attachToTarget, enables required CDP
 * domains, and delegates all tool execution to the base registry with a session override.
 *
 * The global server sessionId is NOT mutated — each tab group operates on its own
 * CDP session via the sessionIdOverride parameter.
 */
export async function createTabScopedRegistry(
  baseRegistry: ToolRegistry,
  cdpClient: CdpClient,
  tabTargetId: string,
): Promise<{ executeTool: (name: string, params: Record<string, unknown>) => Promise<ToolResponse> }> {
  // Attach to the target tab and get a dedicated session
  const { sessionId: tabSessionId } = await cdpClient.send<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId: tabTargetId, flatten: true },
  );

  // Enable required CDP domains on the tab session
  await cdpClient.send("Runtime.enable", {}, tabSessionId);
  await cdpClient.send("Accessibility.enable", {}, tabSessionId);

  debug("createTabScopedRegistry: attached to tab=%s sessionId=%s", tabTargetId, tabSessionId);

  return {
    async executeTool(name: string, params: Record<string, unknown>): Promise<ToolResponse> {
      return baseRegistry.executeTool(name, params, tabSessionId);
    },
  };
}
