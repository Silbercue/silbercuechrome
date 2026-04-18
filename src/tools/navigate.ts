import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import { settle } from "../cdp/settle.js";
import type { SettleResult } from "../cdp/settle.js";
import { wrapCdpError } from "./error-utils.js";
import { toolSequence } from "../telemetry/tool-sequence.js";

export const navigateSchema = z.object({
  url: z.string().optional().describe("URL to navigate to (required for goto action)"),
  action: z
    .enum(["goto", "back", "reload"])
    .optional()
    .default("goto")
    .describe("Navigation action: goto (default), back, or reload"),
  settle_ms: z
    .number()
    .optional()
    .describe("Extra wait time in ms after page load (default: 500)"),
});

export type NavigateParams = z.infer<typeof navigateSchema>;

interface PageNavigateResult {
  frameId: string;
  loaderId?: string;
  errorText?: string;
}

interface NavigationHistoryEntry {
  id: number;
  url: string;
  title: string;
}

interface NavigationHistory {
  currentIndex: number;
  entries: NavigationHistoryEntry[];
}

interface FrameTree {
  frameTree: { frame: { id: string } };
}

interface EvalResult {
  result: { value: string };
}

export async function navigateHandler(
  params: NavigateParams,
  cdpClient: CdpClient,
  sessionId?: string,
): Promise<ToolResponse> {
  const start = performance.now();
  const method = "navigate";

  try {
    if (params.action === "back") {
      return await handleBack(cdpClient, sessionId, params.settle_ms, start, method);
    }
    if (params.action === "reload") {
      return await handleReload(cdpClient, sessionId, params.settle_ms, start, method);
    }
    return await handleGoto(cdpClient, sessionId, params.url, params.settle_ms, start, method);
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "navigate") }],
      isError: true,
      _meta: { elapsedMs, method },
    };
  }
}

async function handleReload(
  cdpClient: CdpClient,
  sessionId: string | undefined,
  settleMs: number | undefined,
  start: number,
  method: string,
): Promise<ToolResponse> {
  // 1. Get current URL before reload
  let currentUrl = "unknown";
  try {
    const urlResult = await cdpClient.send<EvalResult>(
      "Runtime.evaluate",
      { expression: "document.URL", returnByValue: true },
      sessionId,
    );
    currentUrl = urlResult.result.value;
  } catch {
    // URL retrieval failed — continue with "unknown"
  }

  // 2. Trigger reload
  await cdpClient.send("Page.reload", {}, sessionId);

  // 3. Get frameId for settle
  const frameTree = await cdpClient.send<FrameTree>("Page.getFrameTree", {}, sessionId);
  const mainFrameId = frameTree.frameTree.frame.id;

  // 4. Settle — no loaderId available upfront, same pattern as handleBack
  const settleResult = await settle({
    cdpClient,
    sessionId: sessionId!,
    frameId: mainFrameId,
    settleMs,
  });

  const elapsedMs = Math.round(performance.now() - start);

  let text = `Reloaded ${currentUrl}`;
  if (!settleResult.settled) {
    text += " (page not fully settled)";
  }
  text += "\nPrevious element refs are stale — call view_page for fresh refs, or evaluate() to check JavaScript state.";

  return {
    content: [{ type: "text", text }],
    _meta: { elapsedMs, method, settled: settleResult.settled, settleSignal: settleResult.signal },
  };
}

async function handleGoto(
  cdpClient: CdpClient,
  sessionId: string | undefined,
  url: string | undefined,
  settleMs: number | undefined,
  start: number,
  method: string,
): Promise<ToolResponse> {
  if (!url) {
    return {
      content: [{ type: "text", text: "URL is required for goto action" }],
      isError: true,
      _meta: { elapsedMs: Math.round(performance.now() - start), method },
    };
  }

  const navResult = await cdpClient.send<PageNavigateResult>(
    "Page.navigate",
    { url },
    sessionId,
  );

  if (navResult.errorText) {
    return {
      content: [{ type: "text", text: `Navigation failed: ${navResult.errorText} for ${url}` }],
      isError: true,
      _meta: { elapsedMs: Math.round(performance.now() - start), method },
    };
  }

  const isSpa = !navResult.loaderId;
  const settleResult = await settle({
    cdpClient,
    sessionId: sessionId!,
    frameId: navResult.frameId,
    loaderId: navResult.loaderId,
    spaNavigation: isSpa,
    settleMs,
  });

  return await buildSuccessResponse(cdpClient, sessionId, start, method, settleResult);
}

async function handleBack(
  cdpClient: CdpClient,
  sessionId: string | undefined,
  settleMs: number | undefined,
  start: number,
  method: string,
): Promise<ToolResponse> {
  const history = await cdpClient.send<NavigationHistory>(
    "Page.getNavigationHistory",
    {},
    sessionId,
  );

  if (history.currentIndex <= 0) {
    return {
      content: [{ type: "text", text: "No previous page in history" }],
      isError: true,
      _meta: { elapsedMs: Math.round(performance.now() - start), method },
    };
  }

  const prevEntry = history.entries[history.currentIndex - 1];

  const frameTree = await cdpClient.send<FrameTree>("Page.getFrameTree", {}, sessionId);
  const mainFrameId = frameTree.frameTree.frame.id;

  await cdpClient.send(
    "Page.navigateToHistoryEntry",
    { entryId: prevEntry.id },
    sessionId,
  );

  // Back navigation: no loaderId available upfront — accept any lifecycle events for main frame
  const settleResult = await settle({
    cdpClient,
    sessionId: sessionId!,
    frameId: mainFrameId,
    settleMs,
  });

  return await buildSuccessResponse(cdpClient, sessionId, start, method, settleResult);
}

async function buildSuccessResponse(
  cdpClient: CdpClient,
  sessionId: string | undefined,
  start: number,
  method: string,
  settleResult: SettleResult,
): Promise<ToolResponse> {
  // FR-025: Mask navigator.webdriver after page load — Chrome re-applies the
  // native getter on every new document, so we override it post-navigation.
  // NOTE: This only works reliably for auto-launched Chrome (which uses
  // --disable-blink-features=AutomationControlled). For WebSocket-attached
  // Chrome, the user must start Chrome with this flag manually.
  try {
    await cdpClient.send("Runtime.evaluate", {
      expression: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true});",
      awaitPromise: false,
    }, sessionId);
  } catch { /* non-critical */ }

  let finalUrl = "unknown";
  let title = "";

  try {
    const urlResult = await cdpClient.send<EvalResult>(
      "Runtime.evaluate",
      { expression: "document.URL", returnByValue: true },
      sessionId,
    );
    finalUrl = urlResult.result.value;
  } catch {
    // URL retrieval failed — continue with "unknown"
  }

  try {
    const titleResult = await cdpClient.send<EvalResult>(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      sessionId,
    );
    title = titleResult.result.value;
  } catch {
    // Title retrieval failed — continue with empty title
  }

  const elapsedMs = Math.round(performance.now() - start);

  let text = title
    ? `Navigated to ${finalUrl} — ${title}`
    : `Navigated to ${finalUrl}`;

  if (!settleResult.settled) {
    text += " (page not fully settled)";
  }

  text += "\nNext: call view_page to see the page content and interactive elements, or evaluate() to check JavaScript state.";

  toolSequence.record("navigate", undefined, sessionId);

  return {
    content: [{ type: "text", text }],
    _meta: { elapsedMs, method, settled: settleResult.settled, settleSignal: settleResult.signal },
  };
}
