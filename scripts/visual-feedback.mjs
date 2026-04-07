#!/usr/bin/env node

// Visual Feedback Hook — Automatischer Screenshot nach Frontend-Edits
// Claude Code PostToolUse Hook (Edit|Write matcher)
//
// Standalone script — runs OUTSIDE the MCP server with its own CDP connection.
// Chrome supports multiple debug clients per target, no conflict with MCP session.

import { request } from "node:http";
import { writeFile, readdir, unlink, stat } from "node:fs/promises";
import { WebSocketTransport } from "../build/transport/websocket-transport.js";
import { CdpClient } from "../build/cdp/cdp-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRONTEND_EXTENSIONS = new Set([
  ".css", ".scss", ".less", ".tsx", ".jsx", ".html", ".vue", ".svelte",
]);

const GRACE_PERIOD_MS = 500;
const HMR_TIMEOUT_MS = 3000;
const CDP_PORT = 9222;
const SCREENSHOT_DIR = "/tmp";
const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1h

// HMR console log patterns from common dev servers
const HMR_PATTERNS = [
  /\[vite\] hot updated/i,
  /\[HMR\] Updated modules/i,
  /\[Fast Refresh\] done/i,
  /\[HMR\] connected/i,
  /\[HMR\].*updated/i,
  /hmr update/i,
  /hot module replacement/i,
  /\[webpack-dev-server\]/i,
];

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Frontend file detection
// ---------------------------------------------------------------------------

function isFrontendFile(filePath) {
  if (!filePath) return false;
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return FRONTEND_EXTENSIONS.has(filePath.substring(dot));
}

// ---------------------------------------------------------------------------
// CSS selector extraction from Edit diff (Phase 2 — Task 5)
// ---------------------------------------------------------------------------

/** Best-effort: extract simple CSS selector from Edit diff. Returns null on failure. */
export function extractCssSelector(filePath, oldString, newString) {
  if (!filePath) return null;
  const ext = filePath.substring(filePath.lastIndexOf("."));

  // Only attempt for CSS-like files — TSX/JSX/HTML too unreliable
  if (![".css", ".scss", ".less"].includes(ext)) return null;

  const diff = newString || oldString || "";
  // Match simple selectors: .class, #id, tag — skip @media, comma-separated, nested SCSS
  const match = diff.match(/^[ \t]*([\w.#][\w\-.:>+ ]*?)\s*\{/m);
  if (!match) return null;

  const raw = match[1].trim();
  // Skip overly complex selectors
  if (raw.includes(",") || raw.includes("&") || raw.startsWith("@")) return null;
  // For multi-part selectors (div.content > p), use the full selector for querySelector
  return raw;
}

// ---------------------------------------------------------------------------
// Tab discovery
// ---------------------------------------------------------------------------

async function findBestTab() {
  return new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const targets = JSON.parse(Buffer.concat(chunks).toString());
          const pages = targets.filter((t) => t.type === "page");
          // Prefer localhost / dev-server tabs (port 3000–9999)
          const devTab = pages.find((t) =>
            /localhost:|127\.0\.0\.1:|:\d{4,5}\//.test(t.url),
          );
          resolve(devTab || pages[0] || null);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Smart HMR detection (Phase 4 — Task 11)
// ---------------------------------------------------------------------------

/**
 * Wait for HMR signal via CDP console logs, or fall back to grace period.
 * Returns quickly if HMR signal detected, otherwise waits up to HMR_TIMEOUT_MS.
 */
async function waitForHmr(tab) {
  let transport;
  try {
    transport = await WebSocketTransport.connect(
      tab.webSocketDebuggerUrl,
      { timeoutMs: 3000 },
    );
  } catch {
    // Can't connect — fall back to grace period
    await new Promise((r) => setTimeout(r, GRACE_PERIOD_MS));
    return;
  }

  const cdp = new CdpClient(transport, { timeoutMs: 5000 });

  try {
    await cdp.send("Runtime.enable", {});

    await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(undefined), HMR_TIMEOUT_MS);

      cdp.on("Runtime.consoleAPICalled", (params) => {
        const args = params?.args || [];
        const text = args.map((a) => a?.value ?? a?.description ?? "").join(" ");
        if (HMR_PATTERNS.some((p) => p.test(text))) {
          clearTimeout(timeout);
          // Small extra delay to let the DOM settle after HMR
          setTimeout(() => resolve(undefined), 100);
        }
      });

      // Also set a minimum wait — HMR signal might come very fast
      setTimeout(() => {
        // After grace period, if no signal yet, the timeout will handle it
      }, GRACE_PERIOD_MS);
    });
  } catch {
    // Runtime.enable failed — fall back to grace period
    await new Promise((r) => setTimeout(r, GRACE_PERIOD_MS));
  } finally {
    await transport.close();
  }
}

// ---------------------------------------------------------------------------
// Old screenshot cleanup (> 1h)
// ---------------------------------------------------------------------------

async function cleanupOldScreenshots() {
  try {
    const files = await readdir(SCREENSHOT_DIR);
    const now = Date.now();
    const promises = [];
    for (const f of files) {
      if (!f.startsWith("visual-feedback-")) continue;
      if (f.startsWith("visual-feedback-last-")) continue; // preserve cache
      const fullPath = `${SCREENSHOT_DIR}/${f}`;
      promises.push(
        stat(fullPath)
          .then((s) =>
            now - s.mtimeMs > CACHE_MAX_AGE_MS ? unlink(fullPath) : undefined,
          )
          .catch(() => {}),
      );
    }
    await Promise.all(promises);
  } catch {
    /* /tmp read failure — non-critical */
  }
}

// ---------------------------------------------------------------------------
// CDP Screenshot (Phase 1 — Tasks 2+3)
// ---------------------------------------------------------------------------

/**
 * Connect to a Chrome tab via CDP and take a screenshot.
 * Returns { png: base64, webp: base64 }
 */
async function captureScreenshot(tab, clipRect) {
  const transport = await WebSocketTransport.connect(
    tab.webSocketDebuggerUrl,
    { timeoutMs: 5000 },
  );
  const cdp = new CdpClient(transport, { timeoutMs: 10_000 });

  try {
    // BUG-015: Focus emulation prevents black screenshots when Chrome is occluded
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    // Build capture params
    const captureParams = clipRect
      ? { format: "png", clip: { ...clipRect, scale: 1 } }
      : { format: "png" };

    // Take PNG (used for diff cache + potential clip extraction)
    const pngResult = await cdp.send("Page.captureScreenshot", captureParams);

    // Take WebP for compact output to Claude
    const webpParams = clipRect
      ? { format: "webp", quality: 80, clip: { ...clipRect, scale: 1 } }
      : { format: "webp", quality: 80 };
    const webpResult = await cdp.send("Page.captureScreenshot", webpParams);

    return { png: pngResult.data, webp: webpResult.data };
  } finally {
    await transport.close();
  }
}

// ---------------------------------------------------------------------------
// Element bounding box via CDP (Phase 2 — Task 6)
// ---------------------------------------------------------------------------

async function getElementBounds(tab, selector, padding = 80) {
  const transport = await WebSocketTransport.connect(
    tab.webSocketDebuggerUrl,
    { timeoutMs: 5000 },
  );
  const cdp = new CdpClient(transport, { timeoutMs: 10_000 });

  try {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height,
               vpW: window.innerWidth, vpH: window.innerHeight,
               scrollX: window.scrollX, scrollY: window.scrollY };
    })()`;

    const result = await cdp.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });

    if (!result.result?.value) return null;

    const { x, y, width, height, vpW, vpH, scrollX, scrollY } = result.result.value;
    // Clip with padding, clamped to viewport
    return {
      x: Math.max(0, Math.floor(x + scrollX - padding)),
      y: Math.max(0, Math.floor(y + scrollY - padding)),
      width: Math.min(vpW, Math.ceil(width + padding * 2)),
      height: Math.min(vpH, Math.ceil(height + padding * 2)),
    };
  } finally {
    await transport.close();
  }
}

// ---------------------------------------------------------------------------
// Pixel diff (Phase 3 — Tasks 9+10)
// ---------------------------------------------------------------------------

async function computePixelDiff(beforePngBuffer, afterPngBuffer, padding = 80) {
  // Dynamic import — only loaded when actually needed
  const { default: pixelmatch } = await import("pixelmatch");
  const { PNG } = await import("pngjs");

  const before = PNG.sync.read(beforePngBuffer);
  const after = PNG.sync.read(afterPngBuffer);

  // Dimensions must match for pixelmatch
  if (before.width !== after.width || before.height !== after.height) return null;

  const { width, height } = before;

  const numDiffPixels = pixelmatch(
    before.data,
    after.data,
    null, // skip diff image — we compute bbox from raw pixels
    width,
    height,
    { threshold: 0.1 },
  );

  if (numDiffPixels === 0) return { identical: true };

  // Find bounding box by comparing raw pixel data directly.
  // pixelmatch's diff image includes gray overlay on identical pixels (alpha > 0),
  // so we must compare source buffers instead.
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (
        before.data[idx] !== after.data[idx] ||
        before.data[idx + 1] !== after.data[idx + 1] ||
        before.data[idx + 2] !== after.data[idx + 2] ||
        before.data[idx + 3] !== after.data[idx + 3]
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Add padding, clamp to image bounds
  const clipX = Math.max(0, minX - padding);
  const clipY = Math.max(0, minY - padding);
  const clipW = Math.min(width - clipX, maxX - minX + 1 + padding * 2);
  const clipH = Math.min(height - clipY, maxY - minY + 1 + padding * 2);

  return { identical: false, clip: { x: clipX, y: clipY, width: clipW, height: clipH } };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function cachePngPath(tabId) {
  return `${SCREENSHOT_DIR}/visual-feedback-last-${tabId}.png`;
}

function cacheMetaPath(tabId) {
  return `${SCREENSHOT_DIR}/visual-feedback-last-${tabId}.json`;
}

/** Read cached PNG only if the URL matches (cache invalidation on navigation). */
async function readCachedScreenshot(tabId, currentUrl) {
  try {
    const { readFile } = await import("node:fs/promises");
    // Check URL metadata
    try {
      const meta = JSON.parse(await readFile(cacheMetaPath(tabId), "utf-8"));
      if (meta.url !== currentUrl) return null; // navigated away — invalidate
    } catch {
      return null; // no meta = no valid cache
    }
    return await readFile(cachePngPath(tabId));
  } catch {
    return null;
  }
}

async function writeCacheScreenshot(tabId, pngBuffer, url) {
  await writeFile(cachePngPath(tabId), pngBuffer);
  await writeFile(cacheMetaPath(tabId), JSON.stringify({ url }));
}

// ---------------------------------------------------------------------------
// Main — Priority cascade: Selector clip → Pixel diff → Full screenshot
// ---------------------------------------------------------------------------

async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      process.stdout.write("{}");
      return;
    }

    const hookData = JSON.parse(input);
    const filePath = hookData.tool_input?.file_path;

    // Only trigger for frontend files
    if (!isFrontendFile(filePath)) {
      process.stdout.write("{}");
      return;
    }

    // Find Chrome tab
    let tab;
    try {
      tab = await findBestTab();
    } catch {
      process.stderr.write("Visual Feedback: Chrome nicht erreichbar auf Port 9222\n");
      process.stdout.write("{}");
      return;
    }

    if (!tab) {
      process.stderr.write("Visual Feedback: Kein Page-Target gefunden\n");
      process.stdout.write("{}");
      return;
    }

    // Smart HMR detection — wait for console signal or timeout
    await waitForHmr(tab);

    // Cleanup old screenshots (non-blocking best-effort)
    cleanupOldScreenshots();

    const tabId = tab.id || "unknown";
    const ts = Date.now();

    // --------------- Priority cascade ---------------

    let screenshotMode = "full";
    let clipRect = null;

    // Priority 1: CSS selector from Edit diff (Phase 2)
    const selector = extractCssSelector(
      filePath,
      hookData.tool_input?.old_string,
      hookData.tool_input?.new_string,
    );

    if (selector) {
      try {
        clipRect = await getElementBounds(tab, selector);
        if (clipRect) {
          screenshotMode = "selector";
        }
      } catch {
        // Element lookup failed — fall through to pixel diff
      }
    }

    // Priority 2: Pixel diff with cached screenshot (Phase 3)
    if (!clipRect) {
      const cachedPng = await readCachedScreenshot(tabId, tab.url);
      if (cachedPng) {
        // Take a full PNG screenshot first for diff comparison
        const { png: afterPngB64 } = await captureScreenshot(tab, null);
        const afterPngBuffer = Buffer.from(afterPngB64, "base64");

        const diffResult = await computePixelDiff(cachedPng, afterPngBuffer);

        if (diffResult?.identical) {
          // No visual change — still save cache, but tell Claude
          await writeCacheScreenshot(tabId, afterPngBuffer, tab.url);

          const output = {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: `Visual Feedback: Keine sichtbare Aenderung nach Edit von ${filePath.split("/").pop()} (Tab: ${tab.title})`,
            },
          };
          process.stdout.write(JSON.stringify(output));
          return;
        }

        if (diffResult?.clip) {
          clipRect = diffResult.clip;
          screenshotMode = "diff";

          // Save the new full screenshot as cache for next diff
          await writeCacheScreenshot(tabId, afterPngBuffer, tab.url);

          // Now take a clipped WebP screenshot for output
          const { webp } = await captureScreenshot(tab, clipRect);
          const outputPath = `${SCREENSHOT_DIR}/visual-feedback-${ts}.webp`;
          await writeFile(outputPath, Buffer.from(webp, "base64"));

          const output = {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: `Visual Feedback nach Edit (${filePath.split("/").pop()}, Pixel-Diff):\n[IMAGE:${outputPath}]`,
            },
          };
          process.stdout.write(JSON.stringify(output));
          return;
        }
        // Diff computation failed — fall through to full screenshot
      }
    }

    // Priority 3 (or selector clip): Take screenshot
    const { png, webp } = await captureScreenshot(tab, clipRect);

    const outputPath = `${SCREENSHOT_DIR}/visual-feedback-${ts}.webp`;
    await writeFile(outputPath, Buffer.from(webp, "base64"));
    // Always update PNG cache for next diff
    await writeCacheScreenshot(tabId, Buffer.from(png, "base64"), tab.url);

    const modeLabel = screenshotMode === "selector"
      ? `Selektor: ${selector}`
      : "Viewport";

    const output = {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `Visual Feedback nach Edit (${filePath.split("/").pop()}, ${modeLabel}):\n[IMAGE:${outputPath}]`,
      },
    };
    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    process.stderr.write(`Visual Feedback Error: ${err.message}\n`);
    process.stdout.write("{}");
  }
}

// Export pure functions for unit testing
export { isFrontendFile, computePixelDiff, findBestTab, cleanupOldScreenshots };

// Only run when executed directly (not when imported by tests)
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
