import { describe, it, expect, vi } from "vitest";
import { tabStatusHandler } from "./tab-status.js";
import { TabStateCache } from "../cache/tab-state-cache.js";
import type { CdpClient } from "../cdp/cdp-client.js";

function createMockCdp(sendResponses?: Record<string, unknown>): CdpClient {
  const sendFn = vi.fn(async (method: string) => {
    if (sendResponses && method in sendResponses) {
      const val = sendResponses[method];
      if (typeof val === "function") return val();
      return val;
    }
    return {};
  });

  return {
    send: sendFn,
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;
}

describe("tabStatusHandler", () => {
  it("returns cached tab state with cacheHit metadata", async () => {
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("tab1");
    cache.set("tab1", {
      url: "https://example.com",
      title: "Example",
      domReady: true,
      loadingState: "ready",
    });

    const cdp = createMockCdp();
    const result = await tabStatusHandler({}, cdp, "s1", cache);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("URL: https://example.com");
    expect(result.content[0].text).toContain("Title: Example");
    expect(result.content[0].text).toContain("DOM: ready");
    expect(result._meta?.cacheHit).toBe(true);
  });

  it("fetches from CDP on cache miss", async () => {
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("tab1");

    const cdp = createMockCdp({
      "Page.getNavigationHistory": {
        currentIndex: 0,
        entries: [{ url: "https://fresh.com", title: "Fresh" }],
      },
      "Runtime.evaluate": { result: { value: "complete" } },
    });

    const result = await tabStatusHandler({}, cdp, "s1", cache);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("URL: https://fresh.com");
    expect(result._meta?.cacheHit).toBe(false);
  });

  it("returns error when no active tab", async () => {
    const cache = new TabStateCache();
    // Do NOT set an active target
    const cdp = createMockCdp();

    const result = await tabStatusHandler({}, cdp, "s1", cache);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("No active tab. Use virtual_desk to discover available tabs, or navigate to a page first.");
    expect(result._meta?.method).toBe("tab_status");
    expect(result._meta?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("returns friendly error when CDP connection is lost", async () => {
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("tab1");

    const cdp = createMockCdp();
    (cdp.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Transport closed unexpectedly"),
    );

    const result = await tabStatusHandler({}, cdp, "s1", cache);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CDP connection lost");
    expect(result.content[0].text).toContain("reconnect");
    expect(result._meta?.method).toBe("tab_status");
    expect(result._meta?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("response format includes URL, Title, DOM status, errors", async () => {
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("tab1");
    cache.set("tab1", {
      url: "https://example.com",
      title: "My Page",
      domReady: false,
      consoleErrors: ["Error A", "Error B"],
      loadingState: "loading",
    });

    const cdp = createMockCdp();
    const result = await tabStatusHandler({}, cdp, "s1", cache);

    const text = result.content[0].text;
    expect(text).toContain("URL: https://example.com");
    expect(text).toContain("Title: My Page");
    expect(text).toContain("DOM: loading");
    expect(text).toContain("Errors (2):");
    expect(text).toContain("  - Error A");
    expect(text).toContain("  - Error B");
  });

  it("console errors truncated to 200 chars for token efficiency", async () => {
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("tab1");
    const longError = "X".repeat(300);
    cache.set("tab1", {
      url: "https://example.com",
      title: "Test",
      domReady: true,
      consoleErrors: [longError],
      loadingState: "ready",
    });

    const cdp = createMockCdp();
    const result = await tabStatusHandler({}, cdp, "s1", cache);

    const text = result.content[0].text;
    // The error line should contain exactly 200 X's (truncated), not 300
    const errorLine = text.split("\n").find((l: string) => l.startsWith("  - "));
    expect(errorLine).toBeDefined();
    // "  - " prefix is 4 chars, then 200 X's
    expect(errorLine!.length).toBe(4 + 200);
  });

  it("returns structured, actionable message when disconnected", async () => {
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("tab1");
    const cdp = createMockCdp();

    const result = await tabStatusHandler({}, cdp, "s1", cache, "disconnected");

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // Status line
    expect(text).toContain("Connection: disconnected");
    // Reason explains why (Chrome lost + reconnect exhausted)
    expect(text).toMatch(/Reason:.*Chrome/i);
    expect(text).toMatch(/reconnect/i);
    // Hint is actionable — must tell the LLM to restart the MCP server
    expect(text).toMatch(/Hint:/);
    expect(text).toMatch(/restart/i);
    // Must NOT suggest that navigate will auto-launch (auto-launch only runs at startup)
    expect(text).toMatch(/auto-launch only runs at server startup/i);
    // Structured _meta for programmatic consumers
    expect(result._meta?.method).toBe("tab_status");
    expect(result._meta?.connectionStatus).toBe("disconnected");
  });

  it("returns wait-and-retry hint when reconnecting", async () => {
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("tab1");
    const cdp = createMockCdp();

    const result = await tabStatusHandler({}, cdp, "s1", cache, "reconnecting");

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("Connection: reconnecting");
    expect(text).toMatch(/Reason:.*reconnect/i);
    // Reconnecting is transient — hint says wait & retry, NOT restart
    expect(text).toMatch(/Hint:.*(wait|retry)/i);
    expect(text).not.toMatch(/restart the MCP server/i);
    expect(result._meta?.method).toBe("tab_status");
    expect(result._meta?.connectionStatus).toBe("reconnecting");
  });

  it("_meta includes elapsedMs and method", async () => {
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("tab1");
    cache.set("tab1", {
      url: "https://example.com",
      title: "Test",
      domReady: true,
      loadingState: "ready",
    });

    const cdp = createMockCdp();
    const result = await tabStatusHandler({}, cdp, "s1", cache);

    expect(result._meta).toBeDefined();
    expect(result._meta!.method).toBe("tab_status");
    expect(typeof result._meta!.elapsedMs).toBe("number");
    expect(result._meta!.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
