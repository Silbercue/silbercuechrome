import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import type { TabStateCache } from "../cache/tab-state-cache.js";
import { settle } from "../cdp/settle.js";

export const switchTabSchema = z.object({
  action: z
    .enum(["open", "switch", "close"])
    .describe("Action: open (new tab), switch (to existing tab), close (close tab)"),
  url: z
    .string()
    .optional()
    .describe("URL to navigate to (for open action, defaults to about:blank)"),
  tab_id: z
    .string()
    .optional()
    .describe(
      "Tab ID to switch to or close (for switch/close actions, defaults to active tab for close)",
    ),
});

export type SwitchTabParams = z.infer<typeof switchTabSchema>;

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

interface FrameTree {
  frameTree: { frame: { id: string } };
}

/**
 * Mutex for serialising session-switching operations (H3).
 * Prevents race conditions when parallel tool-calls try to switch tabs concurrently.
 */
let _switchLock: Promise<void> = Promise.resolve();

function withSwitchLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _switchLock;
  let release: () => void;
  _switchLock = new Promise<void>((res) => {
    release = res;
  });
  return prev.then(fn).finally(() => release());
}

/** Visible for testing — resets the internal lock to a resolved promise. */
export function _resetSwitchLock(): void {
  _switchLock = Promise.resolve();
}

/**
 * Attach to a target, enable CDP domains, re-attach TabStateCache listeners,
 * and propagate the new sessionId. Shared by all three actions.
 */
async function activateSession(
  cdpClient: CdpClient,
  targetId: string,
  tabStateCache: TabStateCache,
  onSessionChange: (newSessionId: string) => void,
): Promise<string> {
  // 1. Attach to target -> new sessionId
  const { sessionId: newSessionId } = await cdpClient.send<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );

  // 2. Enable CDP domains on the new session
  await cdpClient.send("Runtime.enable", {}, newSessionId);
  await cdpClient.send("Page.enable", {}, newSessionId);
  await cdpClient.send("Page.setLifecycleEventsEnabled", { enabled: true }, newSessionId);
  await cdpClient.send("Accessibility.enable", {}, newSessionId);

  // 3. Re-attach cache listeners to new session
  tabStateCache.detachFromClient();
  tabStateCache.attachToClient(cdpClient, newSessionId);
  tabStateCache.setActiveTarget(targetId);

  // 4. Propagate new session to ToolRegistry
  onSessionChange(newSessionId);

  return newSessionId;
}

export async function switchTabHandler(
  params: SwitchTabParams,
  cdpClient: CdpClient,
  sessionId: string | undefined,
  tabStateCache: TabStateCache,
  onSessionChange: (newSessionId: string) => void,
): Promise<ToolResponse> {
  const start = performance.now();
  const method = "switch_tab";

  // H3: Serialise session-switching to prevent race conditions
  return withSwitchLock(async () => {
    try {
      switch (params.action) {
        case "open":
          return await handleOpen(params, cdpClient, tabStateCache, onSessionChange, start, method);
        case "switch":
          return await handleSwitch(
            params,
            cdpClient,
            tabStateCache,
            onSessionChange,
            start,
            method,
          );
        case "close":
          return await handleClose(
            params,
            cdpClient,
            sessionId,
            tabStateCache,
            onSessionChange,
            start,
            method,
          );
      }
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - start);
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `switch_tab failed: ${message}` }],
        isError: true,
        _meta: { elapsedMs, method },
      };
    }
  });
}

async function handleOpen(
  params: SwitchTabParams,
  cdpClient: CdpClient,
  tabStateCache: TabStateCache,
  onSessionChange: (newSessionId: string) => void,
  start: number,
  method: string,
): Promise<ToolResponse> {
  const url = params.url ?? "about:blank";

  // Create new tab
  const { targetId } = await cdpClient.send<{ targetId: string }>("Target.createTarget", {
    url,
  });

  // Activate session on the new tab
  const newSessionId = await activateSession(cdpClient, targetId, tabStateCache, onSessionChange);

  // If URL was specified (not about:blank), settle after navigation
  if (params.url) {
    const frameTree = await cdpClient.send<FrameTree>("Page.getFrameTree", {}, newSessionId);
    const mainFrameId = frameTree.frameTree.frame.id;
    await settle({
      cdpClient,
      sessionId: newSessionId,
      frameId: mainFrameId,
    });
  }

  // Fetch state for response
  const { state } = await tabStateCache.getOrFetch(cdpClient, targetId, newSessionId);
  const elapsedMs = Math.round(performance.now() - start);

  return {
    content: [
      {
        type: "text",
        text: `Tab opened: ${targetId}\nURL: ${state.url}\nTitle: ${state.title}`,
      },
    ],
    _meta: { elapsedMs, method },
  };
}

async function handleSwitch(
  params: SwitchTabParams,
  cdpClient: CdpClient,
  tabStateCache: TabStateCache,
  onSessionChange: (newSessionId: string) => void,
  start: number,
  method: string,
): Promise<ToolResponse> {
  if (!params.tab_id) {
    return {
      content: [{ type: "text", text: "tab_id is required for switch action" }],
      isError: true,
      _meta: { elapsedMs: Math.round(performance.now() - start), method },
    };
  }

  // Verify tab exists before switching
  const { targetInfos } = await cdpClient.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  const target = targetInfos.find((t) => t.targetId === params.tab_id && t.type === "page");
  if (!target) {
    return {
      content: [{ type: "text", text: `Tab not found: ${params.tab_id}` }],
      isError: true,
      _meta: { elapsedMs: Math.round(performance.now() - start), method },
    };
  }

  // C1: Remember previous state for rollback if attachToTarget fails
  const previousTargetId = tabStateCache.activeTargetId;

  // Bring tab to front visually
  await cdpClient.send("Target.activateTarget", { targetId: params.tab_id });

  // C1: Activate CDP session — rollback on failure
  try {
    var newSessionId = await activateSession(
      cdpClient,
      params.tab_id,
      tabStateCache,
      onSessionChange,
    );
  } catch (attachErr) {
    // C1: Rollback — re-activate the previous tab visually
    if (previousTargetId) {
      try {
        await cdpClient.send("Target.activateTarget", { targetId: previousTargetId });
      } catch {
        /* best-effort rollback */
      }
    }
    throw attachErr;
  }

  // Fetch state for response
  const { state } = await tabStateCache.getOrFetch(cdpClient, params.tab_id, newSessionId);
  const elapsedMs = Math.round(performance.now() - start);

  return {
    content: [
      {
        type: "text",
        text: `Switched to tab: ${params.tab_id}\nURL: ${state.url}\nTitle: ${state.title}`,
      },
    ],
    _meta: { elapsedMs, method },
  };
}

async function handleClose(
  params: SwitchTabParams,
  cdpClient: CdpClient,
  sessionId: string | undefined,
  tabStateCache: TabStateCache,
  onSessionChange: (newSessionId: string) => void,
  start: number,
  method: string,
): Promise<ToolResponse> {
  const targetTab = params.tab_id ?? tabStateCache.activeTargetId;
  if (!targetTab) {
    return {
      content: [{ type: "text", text: "No active tab to close" }],
      isError: true,
      _meta: { elapsedMs: Math.round(performance.now() - start), method },
    };
  }

  // Get all page tabs to check if this is the last one
  const { targetInfos } = await cdpClient.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  const pageTabs = targetInfos.filter((t) => t.type === "page");

  // H2: Validate that the specified tab_id actually exists among page targets
  if (params.tab_id) {
    const tabExists = pageTabs.some((t) => t.targetId === params.tab_id);
    if (!tabExists) {
      return {
        content: [{ type: "text", text: `Tab not found: ${params.tab_id}` }],
        isError: true,
        _meta: { elapsedMs: Math.round(performance.now() - start), method },
      };
    }
  }

  const isLastTab = pageTabs.length <= 1;
  const isActiveTab = targetTab === tabStateCache.activeTargetId;
  let newActiveTab: string | undefined;

  if (isLastTab) {
    // Create a new about:blank tab before closing the last one
    const { targetId: blankTabId } = await cdpClient.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    newActiveTab = blankTabId;
  } else if (isActiveTab) {
    // Find the next available tab to switch to
    newActiveTab = pageTabs.find((t) => t.targetId !== targetTab)?.targetId;
  }

  // C2/H1: If switching to a new tab, complete the switch BEFORE closing & cleanup.
  // Architecture: activateTarget (visual) -> attachToTarget (session) -> close old tab.
  if (newActiveTab) {
    // H1: Activate the new tab visually first
    await cdpClient.send("Target.activateTarget", { targetId: newActiveTab });

    // H1: Then attach session
    let newSessionId: string;
    try {
      newSessionId = await activateSession(
        cdpClient,
        newActiveTab,
        tabStateCache,
        onSessionChange,
      );
    } catch (attachErr) {
      // C2: activateSession failed — don't leave activeTargetId on a tab we're about to close.
      // Find any other surviving tab to fall back to.
      const fallback = pageTabs.find(
        (t) => t.targetId !== targetTab && t.targetId !== newActiveTab,
      );
      if (fallback) {
        try {
          await cdpClient.send("Target.activateTarget", { targetId: fallback.targetId });
          const fallbackSessionId = await activateSession(
            cdpClient,
            fallback.targetId,
            tabStateCache,
            onSessionChange,
          );
          // Still close the intended target
          await cdpClient.send("Target.closeTarget", { targetId: targetTab });
          tabStateCache.invalidate(targetTab);
          const { state } = await tabStateCache.getOrFetch(
            cdpClient,
            fallback.targetId,
            fallbackSessionId,
          );
          const elapsedMs = Math.round(performance.now() - start);
          return {
            content: [
              {
                type: "text",
                text: `Tab closed: ${targetTab}\nActive tab: ${fallback.targetId} (fallback)\nURL: ${state.url}\nTitle: ${state.title}`,
              },
            ],
            _meta: { elapsedMs, method },
          };
        } catch {
          /* fallback also failed, propagate original error */
        }
      }
      throw attachErr;
    }

    // Now safely close the old tab and clean up
    await cdpClient.send("Target.closeTarget", { targetId: targetTab });
    tabStateCache.invalidate(targetTab);

    const { state } = await tabStateCache.getOrFetch(cdpClient, newActiveTab, newSessionId);
    const elapsedMs = Math.round(performance.now() - start);

    return {
      content: [
        {
          type: "text",
          text: `Tab closed: ${targetTab}\nActive tab: ${newActiveTab}\nURL: ${state.url}\nTitle: ${state.title}`,
        },
      ],
      _meta: { elapsedMs, method },
    };
  }

  // Non-active tab was closed, no switch needed
  await cdpClient.send("Target.closeTarget", { targetId: targetTab });
  tabStateCache.invalidate(targetTab);

  const elapsedMs = Math.round(performance.now() - start);
  return {
    content: [
      {
        type: "text",
        text: `Tab closed: ${targetTab}`,
      },
    ],
    _meta: { elapsedMs, method },
  };
}
