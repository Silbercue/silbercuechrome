import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createHumanTouchFromEnv,
  normalRandom,
  cubicBezier,
  generateBezierPath,
  humanMouseMove,
  humanType,
  SPEED_PROFILES,
} from "./human-touch.js";
import type { HumanTouchConfig } from "./human-touch.js";
import type { CdpClient } from "../cdp/cdp-client.js";

// --- Mock CDP client ---

function createMockCdp() {
  const sendFn = vi.fn(async () => ({}));
  const cdpClient = {
    send: sendFn,
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;
  return { cdpClient, sendFn };
}

// ============================================================
// createHumanTouchFromEnv (Tasks 8.1 - 8.4)
// ============================================================

describe("createHumanTouchFromEnv", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup.SILBERCUE_HUMAN_TOUCH = process.env.SILBERCUE_HUMAN_TOUCH;
    envBackup.SILBERCUE_HUMAN_TOUCH_SPEED = process.env.SILBERCUE_HUMAN_TOUCH_SPEED;
    delete process.env.SILBERCUE_HUMAN_TOUCH;
    delete process.env.SILBERCUE_HUMAN_TOUCH_SPEED;
  });

  afterEach(() => {
    if (envBackup.SILBERCUE_HUMAN_TOUCH !== undefined) {
      process.env.SILBERCUE_HUMAN_TOUCH = envBackup.SILBERCUE_HUMAN_TOUCH;
    } else {
      delete process.env.SILBERCUE_HUMAN_TOUCH;
    }
    if (envBackup.SILBERCUE_HUMAN_TOUCH_SPEED !== undefined) {
      process.env.SILBERCUE_HUMAN_TOUCH_SPEED = envBackup.SILBERCUE_HUMAN_TOUCH_SPEED;
    } else {
      delete process.env.SILBERCUE_HUMAN_TOUCH_SPEED;
    }
  });

  it("should return disabled with normal speed when no env vars set (8.1)", () => {
    const config = createHumanTouchFromEnv();
    expect(config).toEqual({ enabled: false, speedProfile: "normal" });
  });

  it("should return enabled when SILBERCUE_HUMAN_TOUCH=true (8.2)", () => {
    process.env.SILBERCUE_HUMAN_TOUCH = "true";
    const config = createHumanTouchFromEnv();
    expect(config).toEqual({ enabled: true, speedProfile: "normal" });
  });

  it("should return enabled when SILBERCUE_HUMAN_TOUCH=1 (8.2)", () => {
    process.env.SILBERCUE_HUMAN_TOUCH = "1";
    const config = createHumanTouchFromEnv();
    expect(config.enabled).toBe(true);
  });

  it("should parse speed profile from env (8.3)", () => {
    process.env.SILBERCUE_HUMAN_TOUCH = "true";
    process.env.SILBERCUE_HUMAN_TOUCH_SPEED = "slow";
    const config = createHumanTouchFromEnv();
    expect(config).toEqual({ enabled: true, speedProfile: "slow" });
  });

  it("should parse fast speed profile (8.3)", () => {
    process.env.SILBERCUE_HUMAN_TOUCH = "true";
    process.env.SILBERCUE_HUMAN_TOUCH_SPEED = "fast";
    const config = createHumanTouchFromEnv();
    expect(config.speedProfile).toBe("fast");
  });

  it("should fallback to normal for invalid speed value (8.4)", () => {
    process.env.SILBERCUE_HUMAN_TOUCH = "true";
    process.env.SILBERCUE_HUMAN_TOUCH_SPEED = "turbo";
    const config = createHumanTouchFromEnv();
    expect(config.speedProfile).toBe("normal");
  });

  it("should return disabled for SILBERCUE_HUMAN_TOUCH=false", () => {
    process.env.SILBERCUE_HUMAN_TOUCH = "false";
    const config = createHumanTouchFromEnv();
    expect(config.enabled).toBe(false);
  });
});

// ============================================================
// normalRandom (Task 8.5)
// ============================================================

describe("normalRandom", () => {
  it("should return values within [min, max] range (8.5)", () => {
    for (let i = 0; i < 100; i++) {
      const val = normalRandom(50, 200);
      expect(val).toBeGreaterThanOrEqual(50);
      expect(val).toBeLessThanOrEqual(200);
    }
  });

  it("should return values close to the mean on average", () => {
    const values: number[] = [];
    for (let i = 0; i < 1000; i++) {
      values.push(normalRandom(0, 100));
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    // Mean should be roughly 50 (+/- 10)
    expect(mean).toBeGreaterThan(40);
    expect(mean).toBeLessThan(60);
  });
});

// ============================================================
// cubicBezier (Task 8.6)
// ============================================================

describe("cubicBezier", () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 25, y: 50 };
  const p2 = { x: 75, y: 50 };
  const p3 = { x: 100, y: 100 };

  it("should return start point at t=0 (8.6)", () => {
    const result = cubicBezier(0, p0, p1, p2, p3);
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
  });

  it("should return end point at t=1 (8.6)", () => {
    const result = cubicBezier(1, p0, p1, p2, p3);
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(100);
  });

  it("should return intermediate point at t=0.5", () => {
    const result = cubicBezier(0.5, p0, p1, p2, p3);
    expect(result.x).toBeGreaterThan(0);
    expect(result.x).toBeLessThan(100);
    expect(result.y).toBeGreaterThan(0);
    expect(result.y).toBeLessThan(100);
  });
});

// ============================================================
// generateBezierPath (Task 8.7)
// ============================================================

describe("generateBezierPath", () => {
  it("should return array with correct number of points (8.7)", () => {
    const path = generateBezierPath({ x: 0, y: 0 }, { x: 100, y: 100 }, 15);
    expect(path).toHaveLength(15);
  });

  it("should start near the start point and end near the end point (8.7)", () => {
    const start = { x: 10, y: 20 };
    const end = { x: 300, y: 400 };
    const path = generateBezierPath(start, end, 15);

    // First point should be exactly the start
    expect(path[0].x).toBeCloseTo(start.x, 0);
    expect(path[0].y).toBeCloseTo(start.y, 0);

    // Last point should be exactly the end
    expect(path[path.length - 1].x).toBeCloseTo(end.x, 0);
    expect(path[path.length - 1].y).toBeCloseTo(end.y, 0);
  });

  it("should handle zero-distance path (start === end)", () => {
    const path = generateBezierPath({ x: 50, y: 50 }, { x: 50, y: 50 }, 10);
    expect(path).toHaveLength(10);
    for (const p of path) {
      expect(p.x).toBeCloseTo(50, 0);
      expect(p.y).toBeCloseTo(50, 0);
    }
  });
});

// ============================================================
// humanMouseMove (Task 8.8)
// ============================================================

describe("humanMouseMove", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should dispatch multiple mouseMoved events (8.8)", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    const config: HumanTouchConfig = { enabled: true, speedProfile: "fast" };

    const promise = humanMouseMove(cdpClient, "s1", 0, 0, 150, 150, config);
    // Advance timers enough for all steps + pre-click delay
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    const moveEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => {
        const params = call[1] as Record<string, unknown>;
        return call[0] === "Input.dispatchMouseEvent" && params.type === "mouseMoved";
      },
    );
    // At least 10 mouseMoved events (steps range 10-20)
    expect(moveEvents.length).toBeGreaterThanOrEqual(10);
  });

  it("should use viewport coordinates (integers) for mouseMoved", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    const config: HumanTouchConfig = { enabled: true, speedProfile: "fast" };

    const promise = humanMouseMove(cdpClient, "s1", 0, 0, 200, 300, config);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    const moveEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => {
        const params = call[1] as Record<string, unknown>;
        return call[0] === "Input.dispatchMouseEvent" && params.type === "mouseMoved";
      },
    );

    for (const event of moveEvents) {
      const params = event[1] as Record<string, unknown>;
      expect(Number.isInteger(params.x)).toBe(true);
      expect(Number.isInteger(params.y)).toBe(true);
    }
  });

  it("should pass correct session id", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    const config: HumanTouchConfig = { enabled: true, speedProfile: "fast" };

    const promise = humanMouseMove(cdpClient, "oopif-1", 0, 0, 50, 50, config);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    for (const call of sendFn.mock.calls) {
      expect(call[2]).toBe("oopif-1");
    }
  });
});

// ============================================================
// humanType (Task 8.9, 8.10)
// ============================================================

describe("humanType", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should dispatch keyDown+char+keyUp triplets for ASCII chars (8.9)", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    const config: HumanTouchConfig = { enabled: true, speedProfile: "fast" };

    const promise = humanType(cdpClient, "s1", "hello", config);
    await vi.advanceTimersByTimeAsync(30000);
    await promise;

    const keyEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchKeyEvent",
    );
    // 5 chars * 3 events (rawKeyDown + char + keyUp) = 15 key events
    expect(keyEvents).toHaveLength(15);

    // Verify first character 'h' sequence
    const firstRawKeyDown = keyEvents[0][1] as Record<string, unknown>;
    expect(firstRawKeyDown.type).toBe("rawKeyDown");
    expect(firstRawKeyDown.key).toBe("h");
    expect(firstRawKeyDown.code).toBe("KeyH");

    const firstChar = keyEvents[1][1] as Record<string, unknown>;
    expect(firstChar.type).toBe("char");
    expect(firstChar.text).toBe("h");

    const firstKeyUp = keyEvents[2][1] as Record<string, unknown>;
    expect(firstKeyUp.type).toBe("keyUp");
    expect(firstKeyUp.key).toBe("h");
  });

  it("should fall back to Input.insertText for non-ASCII characters (8.10)", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    const config: HumanTouchConfig = { enabled: true, speedProfile: "fast" };

    const promise = humanType(cdpClient, "s1", "aä", config);
    await vi.advanceTimersByTimeAsync(30000);
    await promise;

    // 'a' should use dispatchKeyEvent (3 events: rawKeyDown, char, keyUp)
    const keyEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(3);

    // 'ä' should use Input.insertText
    const insertTextCalls = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.insertText",
    );
    expect(insertTextCalls).toHaveLength(1);
    expect((insertTextCalls[0][1] as Record<string, unknown>).text).toBe("ä");
  });

  it("should handle uppercase letters with shift modifier", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    const config: HumanTouchConfig = { enabled: true, speedProfile: "fast" };

    const promise = humanType(cdpClient, "s1", "A", config);
    await vi.advanceTimersByTimeAsync(30000);
    await promise;

    const keyEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(3);

    const rawKeyDown = keyEvents[0][1] as Record<string, unknown>;
    expect(rawKeyDown.key).toBe("A");
    expect(rawKeyDown.modifiers).toBe(8); // Shift
  });

  it("should handle spaces correctly", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    const config: HumanTouchConfig = { enabled: true, speedProfile: "fast" };

    // Mock Math.random to avoid micro-pauses for deterministic test
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    const promise = humanType(cdpClient, "s1", "a b", config);
    await vi.advanceTimersByTimeAsync(30000);
    await promise;

    const keyEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchKeyEvent",
    );
    // 3 chars * 3 events = 9
    expect(keyEvents).toHaveLength(9);

    // Space char event
    const spaceChar = keyEvents[4][1] as Record<string, unknown>;
    expect(spaceChar.type).toBe("char");
    expect(spaceChar.text).toBe(" ");

    vi.restoreAllMocks();
  });

  it("should handle emoji as single characters, not surrogate pairs (M1)", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    const config: HumanTouchConfig = { enabled: true, speedProfile: "fast" };

    // Mock Math.random to avoid micro-pauses for deterministic test
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    const promise = humanType(cdpClient, "s1", "Hi 👋", config);
    await vi.advanceTimersByTimeAsync(30000);
    await promise;

    // 'H' = 3 key events, 'i' = 3 key events, ' ' = 3 key events → 9 dispatchKeyEvent
    const keyEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(9);

    // '👋' (outside BMP) should use Input.insertText as a single character
    const insertTextCalls = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.insertText",
    );
    expect(insertTextCalls).toHaveLength(1);
    expect((insertTextCalls[0][1] as Record<string, unknown>).text).toBe("👋");

    // Total: 4 characters (H, i, space, 👋) — NOT 5 (which would happen with surrogate pairs)
    // 9 key events (3 ASCII chars × 3) + 1 insertText = 10 total CDP calls
    // Plus inter-character delays — but the key assertion is 4 logical characters
    const totalCdpCalls = sendFn.mock.calls.length;
    expect(totalCdpCalls).toBe(10); // 9 key events + 1 insertText

    vi.restoreAllMocks();
  });

  it("should use correct session id for all events", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    const config: HumanTouchConfig = { enabled: true, speedProfile: "fast" };

    const promise = humanType(cdpClient, "oopif-2", "ab", config);
    await vi.advanceTimersByTimeAsync(30000);
    await promise;

    for (const call of sendFn.mock.calls) {
      expect(call[2]).toBe("oopif-2");
    }
  });
});

// ============================================================
// Speed profile timing comparison (Task 8.11)
// ============================================================

describe("SPEED_PROFILES", () => {
  it("fast profile has shorter delays than slow profile (8.11)", () => {
    const fast = SPEED_PROFILES.fast;
    const slow = SPEED_PROFILES.slow;

    expect(fast.mouseMinMs).toBeLessThan(slow.mouseMinMs);
    expect(fast.mouseMaxMs).toBeLessThan(slow.mouseMaxMs);
    expect(fast.typeMinMs).toBeLessThan(slow.typeMinMs);
    expect(fast.typeMaxMs).toBeLessThan(slow.typeMaxMs);
    expect(fast.pauseMinMs).toBeLessThan(slow.pauseMinMs);
    expect(fast.pauseMaxMs).toBeLessThan(slow.pauseMaxMs);
  });

  it("normal profile is between fast and slow", () => {
    const fast = SPEED_PROFILES.fast;
    const normal = SPEED_PROFILES.normal;
    const slow = SPEED_PROFILES.slow;

    expect(normal.mouseMinMs).toBeGreaterThan(fast.mouseMinMs);
    expect(normal.mouseMinMs).toBeLessThan(slow.mouseMinMs);
    expect(normal.typeMinMs).toBeGreaterThan(fast.typeMinMs);
    expect(normal.typeMinMs).toBeLessThan(slow.typeMinMs);
  });
});
