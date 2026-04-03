import { describe, it, expect, vi } from "vitest";
import { virtualDeskHandler } from "./virtual-desk.js";
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

function makeTargets(count: number, type = "page") {
  return Array.from({ length: count }, (_, i) => ({
    targetId: `T${String(i + 1).padStart(4, "0")}`,
    type,
    url: `https://example${i + 1}.com/path`,
    title: `Page ${i + 1}`,
  }));
}

describe("virtualDeskHandler", () => {
  it("returns overview of all page tabs with URL, title, status", async () => {
    const targets = makeTargets(3);
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T0001");

    const result = await virtualDeskHandler({}, cdp, undefined, cache);

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Tabs (3):");
    expect(text).toContain("T0001");
    expect(text).toContain("T0002");
    expect(text).toContain("T0003");
    expect(text).toContain("example1.com");
    expect(text).toContain("example2.com");
    expect(text).toContain("example3.com");
  });

  it("marks active tab with > prefix", async () => {
    const targets = makeTargets(2);
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T0002");

    const result = await virtualDeskHandler({}, cdp, undefined, cache);
    const lines = result.content[0].text.split("\n");

    // T0001 should NOT have > prefix (inactive)
    const line1 = lines.find((l: string) => l.includes("T0001"));
    expect(line1).toMatch(/^ /);

    // T0002 should have > prefix (active)
    const line2 = lines.find((l: string) => l.includes("T0002"));
    expect(line2).toMatch(/^>/);
  });

  it("uses cached state when available", async () => {
    const targets = [
      { targetId: "tab1", type: "page", url: "https://example.com", title: "CDP Title" },
    ];
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("tab1");
    cache.set("tab1", {
      url: "https://example.com",
      title: "Cached Title",
      domReady: true,
      loadingState: "ready",
    });

    const result = await virtualDeskHandler({}, cdp, undefined, cache);
    const text = result.content[0].text;

    expect(text).toContain("Cached Title");
    expect(text).toContain("ready");
  });

  it("falls back to CDP target info when no cache entry — infers 'ready' for loaded tab", async () => {
    const targets = [
      { targetId: "tab1", type: "page", url: "https://example.com", title: "CDP Title" },
    ];
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    // No cache entry set — should use CDP title and infer "ready" from url+title

    const result = await virtualDeskHandler({}, cdp, undefined, cache);
    const text = result.content[0].text;

    expect(text).toContain("CDP Title");
    expect(text).toContain("ready");
    expect(text).not.toContain("unknown");
  });

  it("infers 'loading' for about:blank tabs without cache entry", async () => {
    const targets = [
      { targetId: "tab1", type: "page", url: "about:blank", title: "" },
    ];
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const result = await virtualDeskHandler({}, cdp, undefined, cache);
    const text = result.content[0].text;

    expect(text).toContain("loading");
    expect(text).not.toContain("unknown");
  });

  it("infers 'loading' for tabs with empty title but valid URL (still loading)", async () => {
    const targets = [
      { targetId: "tab1", type: "page", url: "https://slow-site.com", title: "" },
    ];
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const result = await virtualDeskHandler({}, cdp, undefined, cache);
    const text = result.content[0].text;

    expect(text).toContain("loading");
  });

  it("shows loading status from cached state", async () => {
    const targets = [
      { targetId: "tab1", type: "page", url: "https://example.com", title: "Test" },
    ];
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.set("tab1", {
      url: "https://example.com",
      title: "Test",
      domReady: false,
      loadingState: "loading",
    });

    const result = await virtualDeskHandler({}, cdp, undefined, cache);
    const text = result.content[0].text;

    expect(text).toContain("loading");
  });

  it("filters non-page targets (service workers, background pages)", async () => {
    const targets = [
      { targetId: "t1", type: "page", url: "https://example.com", title: "Page" },
      { targetId: "t2", type: "service_worker", url: "chrome-extension://abc", title: "SW" },
      { targetId: "t3", type: "background_page", url: "chrome-extension://def", title: "BG" },
    ];
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const result = await virtualDeskHandler({}, cdp, undefined, cache);
    const text = result.content[0].text;

    expect(text).toContain("Tabs (1):");
    expect(text).toContain("t1");
    expect(text).not.toContain("t2");
    expect(text).not.toContain("t3");
  });

  // Token efficiency tests
  it("response for 10 tabs stays under 500 tokens", async () => {
    const targets = makeTargets(10);
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T0001");

    const result = await virtualDeskHandler({}, cdp, undefined, cache);
    const text = result.content[0].text;

    // Approximation: 1 token ~= 4 chars. 500 tokens = ~2000 chars
    expect(text.length).toBeLessThan(2000);
  });

  it("truncates long URLs to max 80 chars", async () => {
    const longUrl = "https://example.com/" + "a".repeat(200);
    const targets = [
      { targetId: "t1", type: "page", url: longUrl, title: "Test" },
    ];
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const result = await virtualDeskHandler({}, cdp, undefined, cache);
    const text = result.content[0].text;
    const tabLine = text.split("\n").find((l: string) => l.includes("t1"));

    // URL in the line should be truncated — the full long URL should NOT appear
    expect(tabLine).not.toContain(longUrl);
    // The URL part should end with "..."
    expect(tabLine).toContain("...");
  });

  it("truncates long titles to max 40 chars", async () => {
    const longTitle = "A".repeat(60);
    const targets = [
      { targetId: "t1", type: "page", url: "https://example.com", title: longTitle },
    ];
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const result = await virtualDeskHandler({}, cdp, undefined, cache);
    const text = result.content[0].text;

    // Full title should NOT appear
    expect(text).not.toContain(longTitle);
    // Truncated title should end with "..."
    expect(text).toContain("A".repeat(37) + "...");
  });

  // Edge cases
  it("returns 'No open tabs' when no page targets", async () => {
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: [] },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const result = await virtualDeskHandler({}, cdp, undefined, cache);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("No open tabs");
    expect(result._meta?.method).toBe("virtual_desk");
  });

  it("shows connection status when disconnected", async () => {
    const cdp = createMockCdp();
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const result = await virtualDeskHandler({}, cdp, undefined, cache, "disconnected");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Connection: disconnected");
    expect(result.content[0].text).toContain("tool calls may fail");
    expect(result._meta?.method).toBe("virtual_desk");
  });

  it("shows connection status when reconnecting", async () => {
    const cdp = createMockCdp();
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const result = await virtualDeskHandler({}, cdp, undefined, cache, "reconnecting");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Connection: reconnecting");
    expect(result._meta?.method).toBe("virtual_desk");
  });

  it("returns friendly error when CDP connection is lost", async () => {
    const cdp = createMockCdp();
    (cdp.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Transport closed unexpectedly"),
    );
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const result = await virtualDeskHandler({}, cdp, undefined, cache);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CDP connection lost");
    expect(result.content[0].text).toContain("reconnect");
    expect(result._meta?.method).toBe("virtual_desk");
    expect(result._meta?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("response always has _meta with elapsedMs and method", async () => {
    const targets = makeTargets(2);
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const result = await virtualDeskHandler({}, cdp, undefined, cache);

    expect(result._meta).toBeDefined();
    expect(result._meta!.method).toBe("virtual_desk");
    expect(typeof result._meta!.elapsedMs).toBe("number");
    expect(result._meta!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("makes exactly 1 CDP call (Target.getTargets) — no N+1 problem", async () => {
    const targets = makeTargets(10);
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("T0001");

    await virtualDeskHandler({}, cdp, undefined, cache);

    expect(cdp.send).toHaveBeenCalledTimes(1);
    expect(cdp.send).toHaveBeenCalledWith("Target.getTargets");
  });

  it("_meta includes tabCount", async () => {
    const targets = makeTargets(5);
    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: targets },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const result = await virtualDeskHandler({}, cdp, undefined, cache);

    expect(result._meta?.tabCount).toBe(5);
  });
});
