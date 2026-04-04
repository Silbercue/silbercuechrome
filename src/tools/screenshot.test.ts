import { describe, it, expect, vi, beforeEach } from "vitest";
import { screenshotSchema, screenshotHandler } from "./screenshot.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import { EMULATED_WIDTH, EMULATED_HEIGHT } from "../cdp/emulation.js";
import { a11yTree } from "../cache/a11y-tree.js";

function mockCdpClient(
  base64Data = "aVZCT1I=",
  contentWidth = 1280,
  contentHeight = 3000,
): CdpClient {
  return {
    send: vi.fn().mockImplementation((method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return Promise.resolve({
          cssContentSize: { width: contentWidth, height: contentHeight },
        });
      }
      if (method === "Page.captureScreenshot") {
        return Promise.resolve({ data: base64Data });
      }
      return Promise.resolve({});
    }),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;
}

// ~75 bytes of base64 → ~56 real bytes (well under 100KB)
const SMALL_BASE64 = "aVZCT1I=";

describe("screenshotSchema", () => {
  // Test 1: Defaults
  it("should default full_page to false", () => {
    const parsed = screenshotSchema.parse({});
    expect(parsed.full_page).toBe(false);
  });
});

describe("screenshotHandler", () => {
  // Test 2: Returns ImageContent
  it("should return ImageContent with type=image and mimeType=image/webp", async () => {
    const cdp = mockCdpClient();
    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "image",
        mimeType: "image/webp",
      }),
    );
    expect((result.content[0] as { data: string }).data).toBe(SMALL_BASE64);
  });

  // Test 3: _meta fields
  it("should include correct _meta fields", async () => {
    const cdp = mockCdpClient();
    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    expect(result._meta).toBeDefined();
    expect(result._meta!.method).toBe("screenshot");
    expect(result._meta!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result._meta!.bytes).toBeDefined();
  });

  // Test 4: No layout query for viewport screenshot — single CDP call only
  it("should not query layout metrics for normal viewport screenshots", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const layoutCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Page.getLayoutMetrics",
    );
    expect(layoutCalls).toHaveLength(0);

    // Also no Runtime.evaluate call
    const runtimeCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Runtime.evaluate",
    );
    expect(runtimeCalls).toHaveLength(0);
  });

  // Test 5: clip with scale for downscaling to MAX_WIDTH
  it("should use clip with scale to downscale to 800px wide", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(captureCall).toBeDefined();
    const params = captureCall![1] as { clip: { width: number; height: number; scale: number } };
    expect(params.clip.width).toBe(EMULATED_WIDTH);
    expect(params.clip.height).toBe(EMULATED_HEIGHT);
    expect(params.clip.scale).toBeCloseTo(800 / EMULATED_WIDTH);
  });

  // Test 6: full_page=true → uses Page.getLayoutMetrics, captureBeyondViewport
  it("should use Page.getLayoutMetrics and captureBeyondViewport for full_page", async () => {
    const cdp = mockCdpClient(SMALL_BASE64, 1280, 3000);
    await screenshotHandler({ full_page: true }, cdp, "s1");

    // Verify Page.getLayoutMetrics was called
    const layoutCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Page.getLayoutMetrics",
    );
    expect(layoutCalls).toHaveLength(1);

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(captureCall).toBeDefined();
    const params = captureCall![1] as {
      captureBeyondViewport: boolean;
      clip: { height: number; width: number; scale: number };
    };
    expect(params.captureBeyondViewport).toBe(true);
    expect(params.clip.height).toBe(3000);
    expect(params.clip.width).toBe(EMULATED_WIDTH);
    expect(params.clip.scale).toBeCloseTo(800 / EMULATED_WIDTH);
  });

  // Test 7: CDP error → isError
  it("should return isError for CDP failure", async () => {
    const cdp = {
      send: vi.fn().mockRejectedValue(new Error("Session closed")),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("screenshot failed"),
      }),
    );
    expect((result.content[0] as { text: string }).text).toContain("Session closed");
  });

  // Test 8: Empty/blank page → valid screenshot (no error)
  it("should return valid screenshot for blank page", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "image" }),
    );
  });

  // Test 9: Single CDP call — no quality fallback loop (NFR25 optimization)
  it("should make exactly one Page.captureScreenshot call (no quality fallback)", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const screenshotCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(screenshotCalls).toHaveLength(1);
  });

  // Test 10: optimizeForSpeed and fixed quality 80 are sent to CDP
  it("should send optimizeForSpeed: true and quality: 80", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(captureCall).toBeDefined();
    const params = captureCall![1] as { quality: number; optimizeForSpeed: boolean };
    expect(params.quality).toBe(80);
    expect(params.optimizeForSpeed).toBe(true);
  });

  // Test 11: C1 — Size guard retries with lower quality when >100KB
  it("should retry with quality 50 when screenshot exceeds 100KB", async () => {
    // Create base64 string that decodes to >100KB (~133_334 base64 chars → ~100_000 bytes)
    const largeBase64 = "A".repeat(140_000);
    const smallBase64 = "A".repeat(80_000);
    let callCount = 0;
    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Page.captureScreenshot") {
          callCount++;
          // First call returns large, second returns small
          return Promise.resolve({ data: callCount === 1 ? largeBase64 : smallBase64 });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    // Should have made 2 captureScreenshot calls
    const screenshotCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(screenshotCalls).toHaveLength(2);

    // Second call should use quality 50
    const retryParams = screenshotCalls[1][1] as { quality: number };
    expect(retryParams.quality).toBe(50);

    // Result should use the smaller image
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { data: string }).data).toBe(smallBase64);
  });

  // Test 12: C1 — No retry when screenshot is under 100KB
  it("should not retry when screenshot is under 100KB", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const screenshotCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(screenshotCalls).toHaveLength(1);
  });

  // Test 13: H3 — Division-by-zero guard: zero width falls back to viewport
  it("should fall back to viewport when cssContentSize width is zero", async () => {
    const cdp = mockCdpClient(SMALL_BASE64, 0, 0);
    const result = await screenshotHandler({ full_page: true }, cdp, "s1");

    expect(result.isError).toBeUndefined();

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(captureCall).toBeDefined();
    const params = captureCall![1] as {
      captureBeyondViewport?: boolean;
      clip: { width: number; height: number; scale: number };
    };
    // Falls back to emulated viewport dimensions
    expect(params.clip.width).toBe(EMULATED_WIDTH);
    expect(params.clip.height).toBe(EMULATED_HEIGHT);
    expect(params.clip.scale).toBeCloseTo(800 / EMULATED_WIDTH);
    // captureBeyondViewport should NOT be set when falling back
    expect(params.captureBeyondViewport).toBeUndefined();
  });

  // Test 14: H3 — Negative dimensions also fall back to viewport
  it("should fall back to viewport when cssContentSize has negative dimensions", async () => {
    const cdp = mockCdpClient(SMALL_BASE64, -1, -1);
    const result = await screenshotHandler({ full_page: true }, cdp, "s1");

    expect(result.isError).toBeUndefined();

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    const params = captureCall![1] as {
      captureBeyondViewport?: boolean;
      clip: { width: number; height: number };
    };
    expect(params.clip.width).toBe(EMULATED_WIDTH);
    expect(params.clip.height).toBe(EMULATED_HEIGHT);
    expect(params.captureBeyondViewport).toBeUndefined();
  });
});

// --- SoM Tests ---

/**
 * Helper: Build a mock DOMSnapshot.captureSnapshot response with the given elements.
 * Each element gets a nodeIndex, backendNodeId, bounds, and computed styles.
 */
function buildMockSnapshot(
  elements: Array<{
    backendNodeId: number;
    tag: string;
    bounds: [number, number, number, number]; // x, y, w, h
    display?: string;
    visibility?: string;
    paintOrder?: number;
  }>,
) {
  // Strings table: index 0 = "", then per-element: tag, display, visibility
  const strings: string[] = [""];
  const backendNodeIds: number[] = [];
  const nodeNames: number[] = [];
  const nodeIndexArr: number[] = [];
  const boundsArr: number[][] = [];
  const styleProps: number[][] = [];
  const paintOrders: number[] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    backendNodeIds.push(el.backendNodeId);

    // Tag name string index
    const tagIdx = strings.length;
    strings.push(el.tag);
    nodeNames.push(tagIdx);

    // Layout entry for this node
    nodeIndexArr.push(i);
    boundsArr.push(el.bounds);

    // Computed styles: [display, visibility, color, bg-color, font-size, position, z-index]
    const displayIdx = strings.length;
    strings.push(el.display ?? "block");
    const visIdx = strings.length;
    strings.push(el.visibility ?? "visible");
    // Fill remaining style indices with 0 (empty string)
    styleProps.push([displayIdx, visIdx, 0, 0, 0, 0, 0]);

    paintOrders.push(el.paintOrder ?? i);
  }

  return {
    documents: [{
      nodes: { backendNodeId: backendNodeIds, nodeName: nodeNames },
      layout: {
        nodeIndex: nodeIndexArr,
        bounds: boundsArr,
        styles: styleProps,
        paintOrders,
      },
    }],
    strings,
  };
}

/**
 * Helper: Create a mock CDP client that handles SoM-related CDP calls.
 * C2 fix: getTree is now always called during SoM, so the mock must return
 * proper A11y nodes and a consistent URL to avoid resetting the ref map.
 */
function mockSomCdpClient(
  snapshotResponse: ReturnType<typeof buildMockSnapshot>,
  base64Data = SMALL_BASE64,
  backendNodeIds: number[] = [],
): CdpClient {
  // Build A11y nodes matching the seeded backendNodeIds
  const a11yNodes = backendNodeIds.map((id, i) => ({
    nodeId: `node-${i}`,
    ignored: false,
    role: { type: "role", value: "button" },
    name: { type: "name", value: `Element ${id}` },
    backendDOMNodeId: id,
  }));

  return {
    send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "Page.captureScreenshot") {
        return Promise.resolve({ data: base64Data });
      }
      if (method === "DOMSnapshot.captureSnapshot") {
        return Promise.resolve(snapshotResponse);
      }
      if (method === "Runtime.evaluate") {
        // Return consistent URL so getTree doesn't reset refs
        const expr = (params as { expression?: string })?.expression;
        if (expr === "document.URL") {
          return Promise.resolve({ result: { value: "http://test.com" } });
        }
        return Promise.resolve({ result: { value: undefined } });
      }
      if (method === "Accessibility.getFullAXTree") {
        return Promise.resolve({ nodes: a11yNodes });
      }
      return Promise.resolve({});
    }),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;
}

describe("screenshotSchema — SoM", () => {
  // Test S1: som: true is accepted
  it("should accept som: true", () => {
    const parsed = screenshotSchema.parse({ som: true });
    expect(parsed.som).toBe(true);
  });

  // Test S2: som defaults to false
  it("should default som to false", () => {
    const parsed = screenshotSchema.parse({});
    expect(parsed.som).toBe(false);
  });

  // Test S3: som: true with full_page: true is accepted
  it("should accept som: true with full_page: true", () => {
    const parsed = screenshotSchema.parse({ som: true, full_page: true });
    expect(parsed.som).toBe(true);
    expect(parsed.full_page).toBe(true);
  });
});

describe("screenshotHandler — SoM Pipeline", () => {
  beforeEach(() => {
    // Seed the a11yTree with known refs so SoM can map backendNodeIds → ref strings
    a11yTree.reset();
    // Manually populate refs by accessing internal state via getTree mock
    // We'll use the public API: force hasRefs() = true by populating the processor
  });

  /**
   * Helper to seed a11yTree with refs for given backendNodeIds.
   * Uses a mock CDP client to call getTree which populates refMap.
   */
  async function seedA11yRefs(backendNodeIds: number[]): Promise<void> {
    a11yTree.reset();
    const nodes = backendNodeIds.map((id, i) => ({
      nodeId: `node-${i}`,
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "name", value: `Element ${id}` },
      backendDOMNodeId: id,
    }));

    const mockCdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes });
        }
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "http://test.com" } });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    await a11yTree.getTree(mockCdp, "seed-session", {});
  }

  // Test S4: som: true calls DOMSnapshot.captureSnapshot
  it("should call DOMSnapshot.captureSnapshot when som is true", async () => {
    await seedA11yRefs([100, 200]);
    const snapshot = buildMockSnapshot([
      { backendNodeId: 100, tag: "BUTTON", bounds: [10, 10, 100, 40] },
      { backendNodeId: 200, tag: "A", bounds: [200, 10, 80, 30] },
    ]);
    const cdp = mockSomCdpClient(snapshot, SMALL_BASE64, [100, 200]);

    await screenshotHandler({ full_page: false, som: true }, cdp, "s1");

    const snapshotCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "DOMSnapshot.captureSnapshot",
    );
    expect(snapshotCalls).toHaveLength(1);
  });

  // Test S5: som: true injects and removes overlay via Runtime.evaluate
  it("should inject and remove overlay via Runtime.evaluate", async () => {
    await seedA11yRefs([100]);
    const snapshot = buildMockSnapshot([
      { backendNodeId: 100, tag: "BUTTON", bounds: [10, 10, 100, 40] },
    ]);
    const cdp = mockSomCdpClient(snapshot, SMALL_BASE64, [100]);

    await screenshotHandler({ full_page: false, som: true }, cdp, "s1");

    const runtimeCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Runtime.evaluate",
    );
    // C2: getTree calls Runtime.evaluate for document.URL, then inject + remove = 3 total
    expect(runtimeCalls).toHaveLength(3);

    // First call: document.URL (from getTree)
    const urlExpr = (runtimeCalls[0][1] as { expression: string }).expression;
    expect(urlExpr).toBe("document.URL");

    // Second call: inject (contains __som_overlay__)
    const injectExpr = (runtimeCalls[1][1] as { expression: string }).expression;
    expect(injectExpr).toContain("__som_overlay__");
    expect(injectExpr).toContain("__som_label");

    // Third call: remove
    const removeExpr = (runtimeCalls[2][1] as { expression: string }).expression;
    expect(removeExpr).toContain("remove()");
  });

  // Test S6: som: false does NOT call DOMSnapshot or Runtime.evaluate (regression check)
  it("should not call DOMSnapshot or Runtime.evaluate when som is false", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    await screenshotHandler({ full_page: false, som: false }, cdp, "s1");

    const snapshotCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "DOMSnapshot.captureSnapshot",
    );
    expect(snapshotCalls).toHaveLength(0);

    const runtimeCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Runtime.evaluate",
    );
    expect(runtimeCalls).toHaveLength(0);
  });

  // Test S7: Labels use correct A11y ref IDs (e.g. "e1", "e2")
  it("should use correct A11y ref IDs in labels", async () => {
    await seedA11yRefs([100, 200]);
    const snapshot = buildMockSnapshot([
      { backendNodeId: 100, tag: "BUTTON", bounds: [10, 10, 100, 40] },
      { backendNodeId: 200, tag: "A", bounds: [200, 10, 80, 30] },
    ]);
    const cdp = mockSomCdpClient(snapshot, SMALL_BASE64, [100, 200]);

    await screenshotHandler({ full_page: false, som: true }, cdp, "s1");

    const runtimeCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Runtime.evaluate",
    );
    // Skip the first Runtime.evaluate call (document.URL from getTree)
    const injectExpr = (runtimeCalls[1][1] as { expression: string }).expression;

    // Should contain the refs assigned by a11yTree (e1 and e2 since seeded fresh)
    const ref1 = a11yTree.getRefForBackendNodeId(100);
    const ref2 = a11yTree.getRefForBackendNodeId(200);
    expect(ref1).toBeDefined();
    expect(ref2).toBeDefined();
    expect(injectExpr).toContain(`"ref":"${ref1}"`);
    expect(injectExpr).toContain(`"ref":"${ref2}"`);
  });

  // Test S8: Overlay is removed even on screenshot error (finally block)
  it("should remove overlay even when screenshot fails", async () => {
    await seedA11yRefs([100]);
    const snapshot = buildMockSnapshot([
      { backendNodeId: 100, tag: "BUTTON", bounds: [10, 10, 100, 40] },
    ]);

    // Build A11y nodes for the getTree call (C2: always refreshes)
    const a11yNodes = [100].map((id, i) => ({
      nodeId: `node-${i}`,
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "name", value: `Element ${id}` },
      backendDOMNodeId: id,
    }));

    const cdp = {
      send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
        if (method === "DOMSnapshot.captureSnapshot") {
          return Promise.resolve(snapshot);
        }
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes: a11yNodes });
        }
        if (method === "Runtime.evaluate") {
          const expr = (params as { expression?: string })?.expression;
          if (expr === "document.URL") {
            return Promise.resolve({ result: { value: "http://test.com" } });
          }
          return Promise.resolve({ result: { value: undefined } });
        }
        if (method === "Page.captureScreenshot") {
          return Promise.reject(new Error("Screenshot failed!"));
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await screenshotHandler({ full_page: false, som: true }, cdp, "s1");

    // Should be an error response (H1: SoM failure falls through to normal screenshot which also fails)
    expect(result.isError).toBe(true);

    // Runtime.evaluate should have been called at least 3 times (URL + inject + remove)
    const runtimeCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Runtime.evaluate",
    );
    expect(runtimeCalls.length).toBeGreaterThanOrEqual(3);

    // The last Runtime.evaluate call should be the removal
    const lastExpr = (runtimeCalls[runtimeCalls.length - 1][1] as { expression: string }).expression;
    expect(lastExpr).toContain("remove()");
  });
});

describe("screenshotHandler — SoM Viewport Filter", () => {
  beforeEach(() => {
    a11yTree.reset();
  });

  async function seedA11yRefs(backendNodeIds: number[]): Promise<void> {
    a11yTree.reset();
    const nodes = backendNodeIds.map((id, i) => ({
      nodeId: `node-${i}`,
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "name", value: `El ${id}` },
      backendDOMNodeId: id,
    }));
    const mockCdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes });
        if (method === "Runtime.evaluate") return Promise.resolve({ result: { value: "http://test.com" } });
        return Promise.resolve({});
      }),
      on: vi.fn(), once: vi.fn(), off: vi.fn(),
    } as unknown as CdpClient;
    await a11yTree.getTree(mockCdp, "seed-session", {});
  }

  // Test S9: Elements outside viewport (x > 1280 or y > 800) are not labelled
  it("should not label elements outside viewport", async () => {
    await seedA11yRefs([100, 200, 300]);
    const snapshot = buildMockSnapshot([
      { backendNodeId: 100, tag: "BUTTON", bounds: [10, 10, 100, 40] },        // inside
      { backendNodeId: 200, tag: "BUTTON", bounds: [1300, 10, 100, 40] },       // outside (x > 1280)
      { backendNodeId: 300, tag: "BUTTON", bounds: [10, 900, 100, 40] },        // outside (y > 800)
    ]);
    const cdp = mockSomCdpClient(snapshot, SMALL_BASE64, [100, 200, 300]);

    await screenshotHandler({ full_page: false, som: true }, cdp, "s1");

    const runtimeCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Runtime.evaluate",
    );
    // C2: document.URL + inject + remove = 3 calls (element 100 is visible)
    expect(runtimeCalls.length).toBe(3);

    // Skip URL call, check inject call
    const injectExpr = (runtimeCalls[1][1] as { expression: string }).expression;
    const ref1 = a11yTree.getRefForBackendNodeId(100)!;
    const ref2 = a11yTree.getRefForBackendNodeId(200)!;
    const ref3 = a11yTree.getRefForBackendNodeId(300)!;

    expect(injectExpr).toContain(ref1);
    expect(injectExpr).not.toContain(`"ref":"${ref2}"`);
    expect(injectExpr).not.toContain(`"ref":"${ref3}"`);
  });

  // Test S10: Elements with display: none are not labelled
  it("should not label elements with display: none", async () => {
    await seedA11yRefs([100, 200]);
    const snapshot = buildMockSnapshot([
      { backendNodeId: 100, tag: "BUTTON", bounds: [10, 10, 100, 40] },                       // visible
      { backendNodeId: 200, tag: "BUTTON", bounds: [200, 10, 100, 40], display: "none" },       // hidden
    ]);
    const cdp = mockSomCdpClient(snapshot, SMALL_BASE64, [100, 200]);

    await screenshotHandler({ full_page: false, som: true }, cdp, "s1");

    const runtimeCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Runtime.evaluate",
    );
    // Skip URL call (index 0), check inject call (index 1)
    const injectExpr = (runtimeCalls[1][1] as { expression: string }).expression;

    const ref1 = a11yTree.getRefForBackendNodeId(100)!;
    const ref2 = a11yTree.getRefForBackendNodeId(200)!;
    expect(injectExpr).toContain(`"ref":"${ref1}"`);
    expect(injectExpr).not.toContain(`"ref":"${ref2}"`);
  });

  // Test S11: Elements without A11y ref are not labelled
  it("should not label elements without A11y ref", async () => {
    // Only seed ref for backendNodeId 100, not for 999
    await seedA11yRefs([100]);
    const snapshot = buildMockSnapshot([
      { backendNodeId: 100, tag: "BUTTON", bounds: [10, 10, 100, 40] },
      { backendNodeId: 999, tag: "DIV", bounds: [200, 10, 100, 40] },  // no ref
    ]);
    const cdp = mockSomCdpClient(snapshot, SMALL_BASE64, [100]);

    await screenshotHandler({ full_page: false, som: true }, cdp, "s1");

    const runtimeCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Runtime.evaluate",
    );
    // Skip URL call (index 0), check inject call (index 1)
    const injectExpr = (runtimeCalls[1][1] as { expression: string }).expression;

    // Parse the data array from the inject script to verify only 1 label
    const dataMatch = injectExpr.match(/const data = (\[.*?\]);/s);
    expect(dataMatch).toBeDefined();
    const labelData = JSON.parse(dataMatch![1]);
    expect(labelData).toHaveLength(1);
    expect(labelData[0].ref).toBe(a11yTree.getRefForBackendNodeId(100));
  });
});

describe("screenshotHandler — SoM Meta", () => {
  beforeEach(() => {
    a11yTree.reset();
  });

  async function seedA11yRefs(backendNodeIds: number[]): Promise<void> {
    a11yTree.reset();
    const nodes = backendNodeIds.map((id, i) => ({
      nodeId: `node-${i}`,
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "name", value: `El ${id}` },
      backendDOMNodeId: id,
    }));
    const mockCdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes });
        if (method === "Runtime.evaluate") return Promise.resolve({ result: { value: "http://test.com" } });
        return Promise.resolve({});
      }),
      on: vi.fn(), once: vi.fn(), off: vi.fn(),
    } as unknown as CdpClient;
    await a11yTree.getTree(mockCdp, "seed-session", {});
  }

  // Test S12: _meta.somElements contains count when som: true
  it("should include somElements count in _meta when som is true", async () => {
    await seedA11yRefs([100, 200]);
    const snapshot = buildMockSnapshot([
      { backendNodeId: 100, tag: "BUTTON", bounds: [10, 10, 100, 40] },
      { backendNodeId: 200, tag: "A", bounds: [200, 10, 80, 30] },
    ]);
    const cdp = mockSomCdpClient(snapshot, SMALL_BASE64, [100, 200]);

    const result = await screenshotHandler({ full_page: false, som: true }, cdp, "s1");

    expect(result._meta).toBeDefined();
    expect(result._meta!.somElements).toBe(2);
  });

  // Test S13: _meta.somElements is undefined when som: false
  it("should not include somElements in _meta when som is false", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    const result = await screenshotHandler({ full_page: false, som: false }, cdp, "s1");

    expect(result._meta).toBeDefined();
    expect(result._meta!.somElements).toBeUndefined();
  });

  // Test S14 (H1): getTree failure falls back to normal screenshot with somFailed: true
  it("should fall back to normal screenshot with somFailed when getTree fails", async () => {
    a11yTree.reset();
    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Accessibility.getFullAXTree") {
          return Promise.reject(new Error("A11y tree unavailable"));
        }
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "http://test.com" } });
        }
        if (method === "Page.captureScreenshot") {
          return Promise.resolve({ data: SMALL_BASE64 });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await screenshotHandler({ full_page: false, som: true }, cdp, "s1");

    // Should succeed with a normal screenshot
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(expect.objectContaining({ type: "image" }));
    // somFailed should be set
    expect(result._meta!.somFailed).toBe(true);
    // somElements should be undefined (pipeline failed before counting)
    expect(result._meta!.somElements).toBeUndefined();
  });

  // Test S15 (C1): Non-clickable elements (e.g. DIV with "generic" role) are NOT labelled
  it("should not label non-clickable elements like DIV", async () => {
    await seedA11yRefs([100, 200]);
    const snapshot = buildMockSnapshot([
      { backendNodeId: 100, tag: "BUTTON", bounds: [10, 10, 100, 40] },  // clickable
      { backendNodeId: 200, tag: "DIV", bounds: [200, 10, 100, 40] },     // not clickable
    ]);
    // Override the a11y role for backendNodeId 200 to be non-clickable
    // seedA11yRefs sets all to "button" role, so re-seed with correct roles
    a11yTree.reset();
    const nodes = [
      { nodeId: "node-0", ignored: false, role: { type: "role", value: "button" }, name: { type: "name", value: "El 100" }, backendDOMNodeId: 100 },
      { nodeId: "node-1", ignored: false, role: { type: "role", value: "generic" }, name: { type: "name", value: "El 200" }, backendDOMNodeId: 200 },
    ];
    const seedCdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes });
        if (method === "Runtime.evaluate") return Promise.resolve({ result: { value: "http://test.com" } });
        return Promise.resolve({});
      }),
      on: vi.fn(), once: vi.fn(), off: vi.fn(),
    } as unknown as CdpClient;
    await a11yTree.getTree(seedCdp, "seed-session", {});

    // Build SoM CDP client that also returns correct A11y nodes
    const cdp = mockSomCdpClient(snapshot, SMALL_BASE64, [100, 200]);
    // Override getFullAXTree to return correct roles
    (cdp.send as ReturnType<typeof vi.fn>).mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes });
      if (method === "Runtime.evaluate") {
        const expr = (params as { expression?: string })?.expression;
        if (expr === "document.URL") return Promise.resolve({ result: { value: "http://test.com" } });
        return Promise.resolve({ result: { value: undefined } });
      }
      if (method === "DOMSnapshot.captureSnapshot") return Promise.resolve(snapshot);
      if (method === "Page.captureScreenshot") return Promise.resolve({ data: SMALL_BASE64 });
      return Promise.resolve({});
    });

    const result = await screenshotHandler({ full_page: false, som: true }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    expect(result._meta!.somElements).toBe(1); // Only BUTTON, not DIV
  });
});
