import { describe, it, expect, vi } from "vitest";
import { screenshotSchema, screenshotHandler } from "./screenshot.js";
import type { CdpClient } from "../cdp/cdp-client.js";

function mockCdpClient(
  base64Data = "aVZCT1I=",
  viewportWidth = 1280,
  viewportHeight = 720,
  scrollWidth = 1280,
  scrollHeight = 3000,
): CdpClient {
  return {
    send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.evaluate") {
        const expr = params?.expression as string;
        if (expr.includes("scrollWidth")) {
          return Promise.resolve({
            result: {
              value: JSON.stringify({ scrollWidth, scrollHeight }),
            },
          });
        }
        return Promise.resolve({
          result: {
            value: JSON.stringify({ width: viewportWidth, height: viewportHeight }),
          },
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
// Generate a base64 string that decodes to >100KB
const LARGE_BASE64 = "A".repeat(140000); // ~105KB decoded

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
    expect(result._meta!.width).toBeDefined();
    expect(result._meta!.height).toBeDefined();
    expect(result._meta!.bytes).toBeDefined();
  });

  // Test 4: Scaling — viewport 1280 → scale should be 800/1280
  it("should scale down when viewport > 800px", async () => {
    const cdp = mockCdpClient(SMALL_BASE64, 1280, 720);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(captureCall).toBeDefined();
    const clipParam = (captureCall![1] as { clip: { scale: number } }).clip;
    expect(clipParam.scale).toBeCloseTo(800 / 1280, 5);
  });

  // Test 5: No scaling for small viewport
  it("should not scale up when viewport <= 800px", async () => {
    const cdp = mockCdpClient(SMALL_BASE64, 600, 400);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    const clipParam = (captureCall![1] as { clip: { scale: number } }).clip;
    expect(clipParam.scale).toBe(1);
  });

  // Test 6: full_page=true → captureBeyondViewport and scrollHeight
  it("should use scrollHeight and captureBeyondViewport for full_page", async () => {
    const cdp = mockCdpClient(SMALL_BASE64, 1280, 720, 1280, 3000);
    await screenshotHandler({ full_page: true }, cdp, "s1");

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(captureCall).toBeDefined();
    const params = captureCall![1] as {
      captureBeyondViewport: boolean;
      clip: { height: number; width: number };
    };
    expect(params.captureBeyondViewport).toBe(true);
    expect(params.clip.height).toBe(3000);
    expect(params.clip.width).toBe(1280);
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
    const cdp = mockCdpClient(SMALL_BASE64, 800, 600);
    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "image" }),
    );
  });

  // Test 9: Quality fallback when image too large
  it("should retry with lower quality when image exceeds 100KB", async () => {
    let callCount = 0;
    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({
            result: { value: JSON.stringify({ width: 1280, height: 720 }) },
          });
        }
        if (method === "Page.captureScreenshot") {
          callCount++;
          // First two calls return large data, third returns small
          if (callCount <= 2) {
            return Promise.resolve({ data: LARGE_BASE64 });
          }
          return Promise.resolve({ data: SMALL_BASE64 });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    // Should have called captureScreenshot 3 times (quality 80, 60, 40)
    const screenshotCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(screenshotCalls).toHaveLength(3);

    // Verify quality steps: 80, 60, 40
    expect((screenshotCalls[0][1] as { quality: number }).quality).toBe(80);
    expect((screenshotCalls[1][1] as { quality: number }).quality).toBe(60);
    expect((screenshotCalls[2][1] as { quality: number }).quality).toBe(40);

    expect(result.isError).toBeUndefined();
  });

  // Test 10: Viewport guardrail — zero dimensions fallback to defaults
  it("should fallback to default dimensions for zero viewport", async () => {
    const cdp = mockCdpClient(SMALL_BASE64, 0, 0);
    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    // Should use fallback 1280x720, scale to 800/1280
    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    const clipParam = (captureCall![1] as { clip: { scale: number; width: number } }).clip;
    expect(clipParam.width).toBe(1280);
    expect(clipParam.scale).toBeCloseTo(800 / 1280, 5);
  });

  // Test 11: Best effort — all quality steps exceed 100KB
  it("should accept best effort when all quality steps exceed 100KB", async () => {
    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({
            result: { value: JSON.stringify({ width: 1280, height: 720 }) },
          });
        }
        if (method === "Page.captureScreenshot") {
          return Promise.resolve({ data: LARGE_BASE64 });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    // Should NOT be an error — best effort accepted
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "image" }),
    );
  });
});
