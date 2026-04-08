import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import type { TabStateCache } from "../cache/tab-state-cache.js";
import { settle } from "../cdp/settle.js";
import { DEVICE_METRICS_OVERRIDE, isHeadless } from "../cdp/emulation.js";
import { wrapCdpError } from "./error-utils.js";
import { injectOverlay } from "../overlay/session-overlay.js";
import { a11yTree } from "../cache/a11y-tree.js";

export const switchTabSchema = z.object({
  action: z
    .enum(["open", "switch", "close"])
    .optional()
    .default("switch")
    .describe("Action: open (new tab), switch (to existing tab, default), close (close tab)"),
  url: z
    .string()
    .optional()
    .describe("URL to navigate to (for open action, defaults to about:blank)"),
  tab: z
    .string()
    .optional()
    .describe(
      "Tab ID or tab number (1-based index, e.g. '2') to switch to or close (defaults to active tab for close)",
    ),
});

export type SwitchTabParams = z.infer<typeof switchTabSchema>;

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

/**
 * Resolve a tab that may be a 1-based numeric index (e.g. "2")
 * or a CDP targetId (32-char hex). Returns the actual targetId or undefined.
 */
function resolveTabId(tabId: string, pageTabs: TargetInfo[]): string | undefined {
  if (/^\d{1,3}$/.test(tabId)) {
    const idx = parseInt(tabId, 10) - 1;
    return pageTabs[idx]?.targetId;
  }
  return pageTabs.find((t) => t.targetId === tabId)?.targetId;
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
 * Tracks the tab the user was on before open/switch navigated away.
 * Used by close to return to the origin tab instead of picking a random one.
 */
let _originTabId: string | undefined;

/** Visible for testing — resets the origin tab tracking. */
export function _resetOriginTab(): void {
  _originTabId = undefined;
}

/** Visible for testing — reads the current origin tab. */
export function _getOriginTabId(): string | undefined {
  return _originTabId;
}

/** FR-014: Hint appended to responses where the active tab changes. */
const STALE_REFS_HINT = "\n\nNote: Element refs from the previous tab are no longer valid. Call read_page for fresh refs.";

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
  await cdpClient.send("DOM.enable", {}, newSessionId);
  await cdpClient.send("Accessibility.enable", {}, newSessionId);
  // BUG-015 fix: Keep renderer alive when window is occluded on macOS (per-tab).
  if (!isHeadless()) {
    await cdpClient.send("Emulation.setFocusEmulationEnabled", { enabled: true }, newSessionId);
  }
  if (isHeadless()) {
    await cdpClient.send("Emulation.setDeviceMetricsOverride", DEVICE_METRICS_OVERRIDE, newSessionId);
  }

  // 3. Re-attach cache listeners to new session
  tabStateCache.detachFromClient();
  tabStateCache.attachToClient(cdpClient, newSessionId);
  tabStateCache.setActiveTarget(targetId);

  // 4. Propagate new session to ToolRegistry
  onSessionChange(newSessionId);

  // BUG-017: Every ref in the a11y-cache belongs to the previous tab's
  // document and sits in a completely different backendNodeId namespace.
  // Reset the cache so the next read_page builds a fresh ref table —
  // this makes the existing STALE_REFS_HINT (Z. 91) truthful for the
  // first time. Without this reset, a stale ref could silently resolve
  // to an unrelated node in the new tab via the old refNum.
  a11yTree.reset();

  // 5. Inject session overlay into the new tab
  await injectOverlay(cdpClient, newSessionId);

  return newSessionId;
}

export async function switchTabHandler(
  params: SwitchTabParams,
  cdpClient: CdpClient,
  sessionId: string | undefined,
  tabStateCache: TabStateCache,
  onSessionChange: (newSessionId: string) => void,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();
  const method = "switch_tab";

  // H3: Serialise session-switching to prevent race conditions
  return withSwitchLock(async () => {
    try {
      switch (params.action) {
        case "open":
          return await handleOpen(params, cdpClient, tabStateCache, onSessionChange, start, method, sessionManager);
        case "switch":
          return await handleSwitch(
            params,
            cdpClient,
            tabStateCache,
            onSessionChange,
            start,
            method,
            sessionManager,
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
      return {
        content: [{ type: "text", text: wrapCdpError(err, "switch_tab") }],
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
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const url = params.url ?? "about:blank";

  // Remember origin tab before switching away
  _originTabId = tabStateCache.activeTargetId ?? undefined;

  // Create new tab
  const { targetId } = await cdpClient.send<{ targetId: string }>("Target.createTarget", {
    url,
  });

  // Activate session on the new tab
  const newSessionId = await activateSession(cdpClient, targetId, tabStateCache, onSessionChange);

  // C1: Re-initialize SessionManager for new tab's OOPIF auto-attach
  if (sessionManager) {
    await sessionManager.reinit(cdpClient, newSessionId);
  }

  // If a real URL was specified, settle after navigation (about:blank needs no settle)
  if (params.url && params.url !== "about:blank") {
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

  const originLine = _originTabId
    ? `\nOrigin tab: ${_originTabId} — use switch_tab(action: "close") to return`
    : "";

  return {
    content: [
      {
        type: "text",
        text: `Tab opened: ${targetId}\nURL: ${state.url}\nTitle: ${state.title}${originLine}${STALE_REFS_HINT}`,
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
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  if (!params.tab) {
    // No tab: list available tabs so the LLM can pick one
    const { targetInfos } = await cdpClient.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    const pageTabs = targetInfos.filter((t) => t.type === "page");
    const activeId = tabStateCache.activeTargetId;
    const lines = pageTabs.map((t, i) => {
      const marker = t.targetId === activeId ? "★" : " ";
      return `${marker} Tab ${i + 1}: ${t.targetId} | ${t.title} | ${t.url}`;
    });
    return {
      content: [{ type: "text", text: `Tabs (${pageTabs.length} open):\n${lines.join("\n")}` }],
      _meta: { elapsedMs: Math.round(performance.now() - start), method },
    };
  }

  // Verify tab exists before switching (supports numeric index or targetId)
  const { targetInfos } = await cdpClient.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  const pageTabs = targetInfos.filter((t) => t.type === "page");
  const resolvedId = resolveTabId(params.tab!, pageTabs);
  if (!resolvedId) {
    return {
      content: [{ type: "text", text: `Tab not found: ${params.tab}. Use virtual_desk to discover available tabs.` }],
      isError: true,
      _meta: { elapsedMs: Math.round(performance.now() - start), method },
    };
  }

  // Remember origin tab before switching away
  _originTabId = tabStateCache.activeTargetId ?? undefined;

  // C1: Remember previous state for rollback if attachToTarget fails
  const previousTargetId = tabStateCache.activeTargetId;

  // Bring tab to front visually + ensure its window is in foreground
  await cdpClient.send("Target.activateTarget", { targetId: resolvedId });
  try {
    const { windowId } = await cdpClient.send<{ windowId: number }>(
      "Browser.getWindowForTarget",
      { targetId: resolvedId },
    );
    await cdpClient.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
  } catch {
    /* best-effort — window focus is not critical */
  }

  // C1: Activate CDP session — rollback on failure
  let newSessionId: string;
  try {
    newSessionId = await activateSession(
      cdpClient,
      resolvedId,
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

  // C1: Re-initialize SessionManager for new tab's OOPIF auto-attach
  if (sessionManager) {
    await sessionManager.reinit(cdpClient, newSessionId);
  }

  // Fetch state for response
  const { state } = await tabStateCache.getOrFetch(cdpClient, resolvedId, newSessionId);
  const elapsedMs = Math.round(performance.now() - start);

  return {
    content: [
      {
        type: "text",
        text: `Switched to tab: ${resolvedId}\nURL: ${state.url}\nTitle: ${state.title}${STALE_REFS_HINT}`,
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
  // Get all page tabs to check if this is the last one
  const { targetInfos } = await cdpClient.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  const pageTabs = targetInfos.filter((t) => t.type === "page");

  // Resolve tab (supports numeric index or targetId)
  let targetTab: string | undefined;
  if (params.tab) {
    targetTab = resolveTabId(params.tab, pageTabs);
    if (!targetTab) {
      return {
        content: [{ type: "text", text: `Tab not found: ${params.tab}` }],
        isError: true,
        _meta: { elapsedMs: Math.round(performance.now() - start), method },
      };
    }
  } else {
    targetTab = tabStateCache.activeTargetId ?? undefined;
  }

  if (!targetTab) {
    return {
      content: [{ type: "text", text: "No active tab to close" }],
      isError: true,
      _meta: { elapsedMs: Math.round(performance.now() - start), method },
    };
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
    // Prefer origin tab (the tab we came from) if it still exists
    const originAlive =
      _originTabId &&
      _originTabId !== targetTab &&
      pageTabs.some((t) => t.targetId === _originTabId);
    if (originAlive) {
      newActiveTab = _originTabId;
    } else {
      // Fallback: pick the next available tab
      newActiveTab = pageTabs.find((t) => t.targetId !== targetTab)?.targetId;
    }
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
          _originTabId = undefined; // Reset after close
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
                text: `Tab closed: ${targetTab}\nActive tab: ${fallback.targetId} (fallback)\nURL: ${state.url}\nTitle: ${state.title}${STALE_REFS_HINT}`,
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

    const usedOrigin = newActiveTab === _originTabId;
    _originTabId = undefined; // Reset after close

    const { state } = await tabStateCache.getOrFetch(cdpClient, newActiveTab, newSessionId);
    const elapsedMs = Math.round(performance.now() - start);

    const activeLine = usedOrigin
      ? `Returned to origin tab: ${newActiveTab}`
      : `Active tab: ${newActiveTab} (origin tab no longer available)`;

    return {
      content: [
        {
          type: "text",
          text: `Tab closed: ${targetTab}\n${activeLine}\nURL: ${state.url}\nTitle: ${state.title}${STALE_REFS_HINT}`,
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
