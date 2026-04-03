import type { CdpClient } from "./cdp-client.js";

export interface SettleOptions {
  cdpClient: CdpClient;
  sessionId: string;
  frameId: string;
  loaderId?: string;
  spaNavigation?: boolean;
  settleMs?: number;
  timeoutMs?: number;
}

export interface SettleResult {
  settled: boolean;
  signal?: "networkIdle" | "networkAlmostIdle" | "timeout" | "spa";
  elapsedMs: number;
}

interface LifecycleEventParams {
  frameId: string;
  loaderId: string;
  name: string;
  timestamp: number;
}

const DEFAULT_SETTLE_MS = 500;
const DEFAULT_TIMEOUT_MS = 15_000;

export async function settle(options: SettleOptions): Promise<SettleResult> {
  const {
    cdpClient,
    sessionId,
    frameId,
    loaderId,
    spaNavigation = false,
    settleMs = DEFAULT_SETTLE_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const start = performance.now();

  // SPA path: same-document navigation — just wait settle_ms, no lifecycle events expected
  if (spaNavigation) {
    await delay(Math.min(settleMs, timeoutMs));
    return {
      settled: true,
      signal: "spa",
      elapsedMs: Math.round(performance.now() - start),
    };
  }

  // Cross-document navigation: wait for lifecycle events
  return new Promise<SettleResult>((resolve) => {
    let resolved = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (overallTimer !== undefined) clearTimeout(overallTimer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      cdpClient.off("Page.lifecycleEvent", onLifecycleEvent);
    };

    const finish = (result: SettleResult) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const onLifecycleEvent = (params: unknown) => {
      const event = params as LifecycleEventParams;

      // Only listen to main frame events
      if (event.frameId !== frameId) return;

      // Filter by loaderId to avoid stale events from previous navigations
      if (loaderId && event.loaderId !== loaderId) return;

      if (event.name === "networkIdle" || event.name === "networkAlmostIdle") {
        // Prefer networkIdle over networkAlmostIdle
        const signal = event.name as "networkIdle" | "networkAlmostIdle";

        // If we already have a settleTimer running (from networkAlmostIdle)
        // and now networkIdle arrives, upgrade the signal
        if (settleTimer !== undefined) {
          clearTimeout(settleTimer);
        }

        settleTimer = setTimeout(() => {
          finish({
            settled: true,
            signal,
            elapsedMs: Math.round(performance.now() - start),
          });
        }, settleMs);
      }
    };

    cdpClient.on("Page.lifecycleEvent", onLifecycleEvent, sessionId);

    // Overall timeout to prevent hanging
    const overallTimer = setTimeout(() => {
      finish({
        settled: false,
        signal: "timeout",
        elapsedMs: Math.round(performance.now() - start),
      });
    }, timeoutMs);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
