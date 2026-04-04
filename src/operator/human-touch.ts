import type { CdpClient } from "../cdp/cdp-client.js";

// --- Types (Task 1.1) ---

export interface HumanTouchConfig {
  enabled: boolean;         // Default: false
  speedProfile: "slow" | "normal" | "fast";  // Default: "normal"
}

// --- Speed Profiles (Task 1.2) ---

export const SPEED_PROFILES = {
  slow:   { mouseMinMs: 150, mouseMaxMs: 300, typeMinMs: 120, typeMaxMs: 250, pauseMinMs: 300, pauseMaxMs: 700 },
  normal: { mouseMinMs: 50,  mouseMaxMs: 200, typeMinMs: 80,  typeMaxMs: 180, pauseMinMs: 200, pauseMaxMs: 500 },
  fast:   { mouseMinMs: 20,  mouseMaxMs: 80,  typeMinMs: 40,  typeMaxMs: 100, pauseMinMs: 80,  pauseMaxMs: 200 },
} as const;

// --- Factory (Task 1.3) ---

export function createHumanTouchFromEnv(): HumanTouchConfig {
  const raw = process.env.SILBERCUE_HUMAN_TOUCH;
  const enabled = raw === "true" || raw === "1";
  const rawSpeed = process.env.SILBERCUE_HUMAN_TOUCH_SPEED;
  const speedProfile = (rawSpeed === "slow" || rawSpeed === "fast") ? rawSpeed : "normal";
  return { enabled, speedProfile };
}

// --- Math helpers (Task 2) ---

/**
 * Generate a normally distributed random number in [min, max] via Box-Mueller transform.
 * Clamped to [min, max].
 */
export function normalRandom(min: number, max: number): number {
  // Box-Mueller transform
  let u1 = Math.random();
  const u2 = Math.random();
  // Avoid log(0)
  if (u1 === 0) u1 = 0.0001;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  // Map z (standard normal, ~[-3,3]) to [min, max] with mean at center
  const mean = (min + max) / 2;
  const stddev = (max - min) / 6; // 99.7% within [min, max]
  const value = mean + z * stddev;
  return Math.max(min, Math.min(max, value));
}

/**
 * Evaluate a point on a cubic Bezier curve for parameter t in [0, 1].
 */
export function cubicBezier(
  t: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): { x: number; y: number } {
  const oneMinusT = 1 - t;
  const oneMinusT2 = oneMinusT * oneMinusT;
  const oneMinusT3 = oneMinusT2 * oneMinusT;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: oneMinusT3 * p0.x + 3 * oneMinusT2 * t * p1.x + 3 * oneMinusT * t2 * p2.x + t3 * p3.x,
    y: oneMinusT3 * p0.y + 3 * oneMinusT2 * t * p1.y + 3 * oneMinusT * t2 * p2.y + t3 * p3.y,
  };
}

/**
 * Generate an array of points along a cubic Bezier curve from start to end.
 * Control points are randomly offset from the direct path.
 */
export function generateBezierPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
  steps: number,
): { x: number; y: number }[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Random offset for control points (10-30% of distance)
  const offsetScale1 = 0.1 + Math.random() * 0.2; // 10-30%
  const offsetScale2 = 0.1 + Math.random() * 0.2;

  // Perpendicular direction for offset
  const perpX = -dy / (dist || 1);
  const perpY = dx / (dist || 1);

  // Control point 1: ~1/3 along path with perpendicular offset
  const cp1 = {
    x: start.x + dx * 0.33 + perpX * dist * offsetScale1 * (Math.random() > 0.5 ? 1 : -1),
    y: start.y + dy * 0.33 + perpY * dist * offsetScale1 * (Math.random() > 0.5 ? 1 : -1),
  };

  // Control point 2: ~2/3 along path with perpendicular offset
  const cp2 = {
    x: start.x + dx * 0.66 + perpX * dist * offsetScale2 * (Math.random() > 0.5 ? 1 : -1),
    y: start.y + dy * 0.66 + perpY * dist * offsetScale2 * (Math.random() > 0.5 ? 1 : -1),
  };

  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    points.push(cubicBezier(t, start, cp1, cp2, end));
  }
  return points;
}

// --- Sleep helper ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- humanMouseMove (Task 3) ---

/**
 * Simulate a human-like mouse movement from (startX, startY) to (endX, endY)
 * using a Bezier curve with CDP Input.dispatchMouseEvent.
 */
export async function humanMouseMove(
  cdpClient: CdpClient,
  sessionId: string,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  config: HumanTouchConfig,
): Promise<void> {
  const profile = SPEED_PROFILES[config.speedProfile];
  const totalDuration = normalRandom(profile.mouseMinMs, profile.mouseMaxMs);
  const steps = Math.round(normalRandom(10, 20));
  const path = generateBezierPath({ x: startX, y: startY }, { x: endX, y: endY }, steps);
  const delayPerStep = totalDuration / steps;

  for (const point of path) {
    await cdpClient.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: Math.round(point.x),
        y: Math.round(point.y),
        button: "none",
        clickCount: 0,
      },
      sessionId,
    );
    await sleep(delayPerStep);
  }

  // Pre-click delay (10-50ms scaled by profile)
  const preClickScale = profile.mouseMinMs / 50; // relative scaling
  const preClickDelay = normalRandom(10 * preClickScale, 50 * preClickScale);
  await sleep(preClickDelay);
}

// --- charToKeyParams (Task 4 helper) ---

/**
 * Check if a character can be reliably typed via Input.dispatchKeyEvent.
 * Returns key event params or null if the character should use Input.insertText.
 */
function charToKeyParams(char: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers?: number;
  text: string;
} | null {
  // Only handle printable ASCII (32-126)
  const charCode = char.charCodeAt(0);
  if (charCode < 32 || charCode > 126) return null;

  // Space
  if (char === " ") {
    return { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " };
  }

  // Digits 0-9
  if (charCode >= 48 && charCode <= 57) {
    return { key: char, code: `Digit${char}`, windowsVirtualKeyCode: charCode, text: char };
  }

  // Lowercase a-z
  if (charCode >= 97 && charCode <= 122) {
    const upper = charCode - 32;
    return { key: char, code: `Key${char.toUpperCase()}`, windowsVirtualKeyCode: upper, text: char };
  }

  // Uppercase A-Z (Shift modifier)
  if (charCode >= 65 && charCode <= 90) {
    return { key: char, code: `Key${char}`, windowsVirtualKeyCode: charCode, modifiers: 8, text: char };
  }

  // Common punctuation — map to key/code pairs
  const punctuationMap: Record<string, { code: string; vk: number; shift?: boolean }> = {
    ".": { code: "Period", vk: 190 },
    ",": { code: "Comma", vk: 188 },
    "/": { code: "Slash", vk: 191 },
    ";": { code: "Semicolon", vk: 186 },
    "'": { code: "Quote", vk: 222 },
    "[": { code: "BracketLeft", vk: 219 },
    "]": { code: "BracketRight", vk: 221 },
    "\\": { code: "Backslash", vk: 220 },
    "-": { code: "Minus", vk: 189 },
    "=": { code: "Equal", vk: 187 },
    "`": { code: "Backquote", vk: 192 },
    "!": { code: "Digit1", vk: 49, shift: true },
    "@": { code: "Digit2", vk: 50, shift: true },
    "#": { code: "Digit3", vk: 51, shift: true },
    "$": { code: "Digit4", vk: 52, shift: true },
    "%": { code: "Digit5", vk: 53, shift: true },
    "^": { code: "Digit6", vk: 54, shift: true },
    "&": { code: "Digit7", vk: 55, shift: true },
    "*": { code: "Digit8", vk: 56, shift: true },
    "(": { code: "Digit9", vk: 57, shift: true },
    ")": { code: "Digit0", vk: 48, shift: true },
    "_": { code: "Minus", vk: 189, shift: true },
    "+": { code: "Equal", vk: 187, shift: true },
    "{": { code: "BracketLeft", vk: 219, shift: true },
    "}": { code: "BracketRight", vk: 221, shift: true },
    "|": { code: "Backslash", vk: 220, shift: true },
    ":": { code: "Semicolon", vk: 186, shift: true },
    "\"": { code: "Quote", vk: 222, shift: true },
    "<": { code: "Comma", vk: 188, shift: true },
    ">": { code: "Period", vk: 190, shift: true },
    "?": { code: "Slash", vk: 191, shift: true },
    "~": { code: "Backquote", vk: 192, shift: true },
  };

  const punct = punctuationMap[char];
  if (punct) {
    return {
      key: char,
      code: punct.code,
      windowsVirtualKeyCode: punct.vk,
      modifiers: punct.shift ? 8 : undefined,
      text: char,
    };
  }

  // Unknown ASCII character — fallback
  return null;
}

// --- humanType (Task 4) ---

/**
 * Simulate human-like typing character by character using CDP Input.dispatchKeyEvent.
 * Falls back to Input.insertText for non-ASCII characters.
 */
export async function humanType(
  cdpClient: CdpClient,
  sessionId: string,
  text: string,
  config: HumanTouchConfig,
): Promise<void> {
  const profile = SPEED_PROFILES[config.speedProfile];

  for (const char of text) {
    const keyParams = charToKeyParams(char);

    if (keyParams) {
      // rawKeyDown (no text) → char (with text) → keyUp
      const baseParams = {
        key: keyParams.key,
        code: keyParams.code,
        windowsVirtualKeyCode: keyParams.windowsVirtualKeyCode,
        ...(keyParams.modifiers !== undefined ? { modifiers: keyParams.modifiers } : {}),
      };

      await cdpClient.send(
        "Input.dispatchKeyEvent",
        { type: "rawKeyDown", ...baseParams },
        sessionId,
      );
      await cdpClient.send(
        "Input.dispatchKeyEvent",
        { type: "char", ...baseParams, text: keyParams.text, unmodifiedText: keyParams.text },
        sessionId,
      );
      await cdpClient.send(
        "Input.dispatchKeyEvent",
        { type: "keyUp", ...baseParams },
        sessionId,
      );
    } else {
      // Fallback for non-ASCII (umlauts, emoji, etc.)
      await cdpClient.send(
        "Input.insertText",
        { text: char },
        sessionId,
      );
    }

    // Inter-character delay
    const charDelay = normalRandom(profile.typeMinMs, profile.typeMaxMs);
    await sleep(charDelay);

    // Occasional micro-pause after spaces or punctuation (~20% probability)
    if ((char === " " || char === "." || char === "," || char === "!" || char === "?") && Math.random() < 0.2) {
      const pauseDelay = normalRandom(profile.pauseMinMs, profile.pauseMaxMs);
      await sleep(pauseDelay);
    }
  }
}
