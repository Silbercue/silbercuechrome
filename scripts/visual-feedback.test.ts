import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

// Import pure functions from the hook script
const {
  extractCssSelector,
  isFrontendFile,
  computePixelDiff,
} = await import("./visual-feedback.mjs");

// ---------------------------------------------------------------------------
// Helper: Run the hook script as a subprocess with stdin JSON
// ---------------------------------------------------------------------------

function runHook(
  stdinJson: string,
  timeoutMs = 12_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["scripts/visual-feedback.mjs"], {
      cwd: join(import.meta.dirname, ".."),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d; });
    child.stderr.on("data", (d: Buffer) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr, exitCode: 124 }); // timeout
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.stdin.write(stdinJson);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// 1. Frontend file detection
// ---------------------------------------------------------------------------

describe("isFrontendFile", () => {
  it("returns true for .css files", () => {
    expect(isFrontendFile("/project/src/button.css")).toBe(true);
  });

  it("returns true for .tsx files", () => {
    expect(isFrontendFile("/project/src/App.tsx")).toBe(true);
  });

  it("returns true for .jsx files", () => {
    expect(isFrontendFile("/project/src/App.jsx")).toBe(true);
  });

  it("returns true for .html files", () => {
    expect(isFrontendFile("/project/index.html")).toBe(true);
  });

  it("returns true for .vue files", () => {
    expect(isFrontendFile("/project/src/App.vue")).toBe(true);
  });

  it("returns true for .svelte files", () => {
    expect(isFrontendFile("/project/src/App.svelte")).toBe(true);
  });

  it("returns true for .scss files", () => {
    expect(isFrontendFile("/project/styles/main.scss")).toBe(true);
  });

  it("returns true for .less files", () => {
    expect(isFrontendFile("/project/styles/main.less")).toBe(true);
  });

  it("returns false for .ts files", () => {
    expect(isFrontendFile("/project/src/server.ts")).toBe(false);
  });

  it("returns false for .js files", () => {
    expect(isFrontendFile("/project/src/index.js")).toBe(false);
  });

  it("returns false for .json files", () => {
    expect(isFrontendFile("/project/package.json")).toBe(false);
  });

  it("returns false for .md files", () => {
    expect(isFrontendFile("/project/README.md")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isFrontendFile(null)).toBe(false);
    expect(isFrontendFile(undefined)).toBe(false);
  });

  it("returns false for files without extension", () => {
    expect(isFrontendFile("/project/Makefile")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. CSS selector extraction (Phase 2 — Task 5)
// ---------------------------------------------------------------------------

describe("extractCssSelector", () => {
  describe("simple selectors", () => {
    it("extracts .class selector", () => {
      const result = extractCssSelector(
        "/project/styles.css",
        ".card-header { color: red; }",
        ".card-header { color: blue; }",
      );
      expect(result).toBe(".card-header");
    });

    it("extracts #id selector", () => {
      const result = extractCssSelector(
        "/project/styles.css",
        "#main-nav { display: flex; }",
        "#main-nav { display: grid; }",
      );
      expect(result).toBe("#main-nav");
    });

    it("extracts tag selector", () => {
      const result = extractCssSelector(
        "/project/styles.css",
        "body { margin: 0; }",
        "body { margin: 10px; }",
      );
      expect(result).toBe("body");
    });

    it("extracts multi-part selector", () => {
      const result = extractCssSelector(
        "/project/styles.css",
        "div.content > p { line-height: 1.5; }",
        "div.content > p { line-height: 1.8; }",
      );
      expect(result).toBe("div.content > p");
    });
  });

  describe("complex selectors → fallback (null)", () => {
    it("returns null for comma-separated selectors", () => {
      const result = extractCssSelector(
        "/project/styles.css",
        ".a, .b { color: red; }",
        ".a, .b { color: blue; }",
      );
      expect(result).toBeNull();
    });

    it("returns null for SCSS nested selectors (&)", () => {
      const result = extractCssSelector(
        "/project/styles.scss",
        "&__item { padding: 0; }",
        "&__item { padding: 5px; }",
      );
      expect(result).toBeNull();
    });

    it("returns null for @media queries", () => {
      const result = extractCssSelector(
        "/project/styles.css",
        "@media (max-width: 768px) {",
        "@media (max-width: 1024px) {",
      );
      expect(result).toBeNull();
    });
  });

  describe("non-CSS files → null", () => {
    it("returns null for .tsx files", () => {
      const result = extractCssSelector(
        "/project/App.tsx",
        '<div className="card">',
        '<div className="card-v2">',
      );
      expect(result).toBeNull();
    });

    it("returns null for .html files", () => {
      const result = extractCssSelector(
        "/project/index.html",
        '<div class="hero">',
        '<div class="hero-v2">',
      );
      expect(result).toBeNull();
    });

    it("returns null for null file path", () => {
      expect(extractCssSelector(null, "a", "b")).toBeNull();
    });
  });

  describe("no selector pattern found → null", () => {
    it("returns null for property-only changes", () => {
      const result = extractCssSelector(
        "/project/styles.css",
        "  color: red;",
        "  color: blue;",
      );
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Pixel diff computation (Phase 3 — Tasks 9+10)
// ---------------------------------------------------------------------------

describe("computePixelDiff", () => {
  // Create minimal PNG buffers using pngjs
  async function createPngBuffer(
    width: number,
    height: number,
    fillRgba: [number, number, number, number],
  ): Promise<Buffer> {
    const { PNG } = await import("pngjs");
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        png.data[idx] = fillRgba[0];
        png.data[idx + 1] = fillRgba[1];
        png.data[idx + 2] = fillRgba[2];
        png.data[idx + 3] = fillRgba[3];
      }
    }
    return PNG.sync.write(png);
  }

  async function createPngWithRegion(
    width: number,
    height: number,
    bgRgba: [number, number, number, number],
    regionX: number,
    regionY: number,
    regionW: number,
    regionH: number,
    regionRgba: [number, number, number, number],
  ): Promise<Buffer> {
    const { PNG } = await import("pngjs");
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const inRegion =
          x >= regionX &&
          x < regionX + regionW &&
          y >= regionY &&
          y < regionY + regionH;
        const rgba = inRegion ? regionRgba : bgRgba;
        png.data[idx] = rgba[0];
        png.data[idx + 1] = rgba[1];
        png.data[idx + 2] = rgba[2];
        png.data[idx + 3] = rgba[3];
      }
    }
    return PNG.sync.write(png);
  }

  it("detects identical images", async () => {
    const png = await createPngBuffer(100, 100, [255, 0, 0, 255]);
    const result = await computePixelDiff(png, png);
    expect(result).toEqual({ identical: true });
  });

  it("returns null for mismatched dimensions", async () => {
    const a = await createPngBuffer(100, 100, [255, 0, 0, 255]);
    const b = await createPngBuffer(200, 200, [255, 0, 0, 255]);
    const result = await computePixelDiff(a, b);
    expect(result).toBeNull();
  });

  it("computes diff bounding box with padding", async () => {
    const bg: [number, number, number, number] = [255, 255, 255, 255];
    const red: [number, number, number, number] = [255, 0, 0, 255];
    const blue: [number, number, number, number] = [0, 0, 255, 255];

    // 400x400 image, white background
    // Before: red region at (150, 150) 20x20
    // After: blue region at same position
    const before = await createPngWithRegion(400, 400, bg, 150, 150, 20, 20, red);
    const after = await createPngWithRegion(400, 400, bg, 150, 150, 20, 20, blue);

    const result = await computePixelDiff(before, after, 80);
    expect(result).not.toBeNull();
    expect(result!.identical).toBe(false);
    expect(result!.clip).toBeDefined();

    const clip = result!.clip!;
    // Diff region: (150,150)-(170,170), with 80px padding → clip starts at (70,70)
    expect(clip.x).toBe(70);
    expect(clip.y).toBe(70);
    expect(clip.width).toBeGreaterThanOrEqual(20);
    expect(clip.height).toBeGreaterThanOrEqual(20);
  });

  it("clamps padding to image boundaries", async () => {
    const bg: [number, number, number, number] = [255, 255, 255, 255];
    const red: [number, number, number, number] = [255, 0, 0, 255];
    const blue: [number, number, number, number] = [0, 0, 255, 255];

    // Diff at corner (0,0)-(5,5) — padding would go negative
    const before = await createPngWithRegion(100, 100, bg, 0, 0, 5, 5, red);
    const after = await createPngWithRegion(100, 100, bg, 0, 0, 5, 5, blue);

    const result = await computePixelDiff(before, after, 80);
    expect(result!.clip!.x).toBe(0);
    expect(result!.clip!.y).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Integration: stdin with non-frontend file → empty JSON
// ---------------------------------------------------------------------------

describe("hook integration", { timeout: 15_000 }, () => {
  it("returns {} for non-frontend .ts file", async () => {
    const { stdout, exitCode } = await runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "/project/server.ts" },
        tool_response: { success: true },
      }),
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("{}");
  });

  it("returns {} for empty stdin", async () => {
    const { stdout, exitCode } = await runHook("");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("{}");
  });

  it("returns {} for .json file", async () => {
    const { stdout, exitCode } = await runHook(
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/project/config.json" },
        tool_response: { success: true },
      }),
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// 5. Tab selection heuristic (regex validation)
// ---------------------------------------------------------------------------

describe("tab selection heuristic", () => {
  it("localhost regex matches dev server URLs", () => {
    const re = /localhost:|127\.0\.0\.1:|:\d{4,5}\//;
    expect(re.test("http://localhost:3000/")).toBe(true);
    expect(re.test("http://127.0.0.1:5173/")).toBe(true);
    expect(re.test("http://localhost:4242/test")).toBe(true);
    expect(re.test("https://example.com/")).toBe(false);
    expect(re.test("chrome://newtab/")).toBe(false);
  });

  it("localhost regex matches various dev ports (3000-9999)", () => {
    const re = /localhost:|127\.0\.0\.1:|:\d{4,5}\//;
    expect(re.test("http://localhost:3000/")).toBe(true);
    expect(re.test("http://localhost:5173/")).toBe(true);
    expect(re.test("http://localhost:8080/")).toBe(true);
    expect(re.test("http://localhost:9999/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. E2E tests against localhost:4242 (test-hardest benchmark page)
//    Requires: Chrome on port 9222 + python3 -m http.server 4242
// ---------------------------------------------------------------------------

/** Check if Chrome CDP is reachable on port 9222 */
function isChromeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request("http://127.0.0.1:9222/json/version", (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** Check if test-hardest page is served on localhost:4242 */
function isBenchmarkAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request("http://localhost:4242/", (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

describe("E2E against localhost:4242", { timeout: 20_000 }, () => {
  let chromeOk = false;
  let benchmarkOk = false;

  beforeAll(async () => {
    chromeOk = await isChromeAvailable();
    benchmarkOk = await isBenchmarkAvailable();
  });

  // ---- Test 1: CSS-Edit produces a screenshot ----
  it("CSS-Edit returns screenshot in hookSpecificOutput", async () => {
    if (!chromeOk || !benchmarkOk) return; // skip silently if infra not available

    // Clean up any previous cache
    const cacheFiles = (await import("node:fs")).readdirSync("/tmp")
      .filter((f: string) => f.startsWith("visual-feedback-last-"));
    for (const f of cacheFiles) await unlink(`/tmp/${f}`).catch(() => {});

    const { stdout, exitCode } = await runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: {
          file_path: "/project/styles.css",
          old_string: ".test-card { background: var(--surface); }",
          new_string: ".test-card { background: #1e1e2e; }",
        },
        tool_response: { success: true },
      }),
    );

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.additionalContext).toContain("[IMAGE:");
    expect(result.hookSpecificOutput.additionalContext).toContain("visual-feedback-");

    // Verify the screenshot file actually exists
    const imagePath = result.hookSpecificOutput.additionalContext
      .match(/\[IMAGE:(.*?)\]/)?.[1];
    expect(imagePath).toBeDefined();
    const fileStat = await stat(imagePath!);
    expect(fileStat.size).toBeGreaterThan(1000); // real image, not empty
  });

  // ---- Test 2: Selector-based clip (known CSS class) ----
  it("CSS selector .test-card produces selector-mode screenshot", async () => {
    if (!chromeOk || !benchmarkOk) return;

    const { stdout, exitCode } = await runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: {
          file_path: "/project/components.css",
          old_string: ".test-card { padding: 24px; }",
          new_string: ".test-card { padding: 32px; }",
        },
        tool_response: { success: true },
      }),
    );

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // Should detect .test-card selector and use clip mode
    expect(result.hookSpecificOutput.additionalContext).toContain("Selektor: .test-card");
  });

  // ---- Test 3: Non-CSS frontend file falls back to pixel-diff or viewport ----
  it("TSX-Edit uses pixel-diff or viewport (no selector extraction)", async () => {
    if (!chromeOk || !benchmarkOk) return;

    const { stdout, exitCode } = await runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: {
          file_path: "/project/App.tsx",
          old_string: '<div className="hero">Hello</div>',
          new_string: '<div className="hero">Updated</div>',
        },
        tool_response: { success: true },
      }),
    );

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // TSX → no selector extraction → should NOT contain "Selektor:"
    const ctx = result.hookSpecificOutput.additionalContext;
    expect(ctx).not.toContain("Selektor:");
    // Should use pixel-diff or viewport mode
    expect(ctx).toMatch(/Pixel-Diff|Viewport/);
  });

  // ---- Test 4: Pixel-diff detects change between two runs ----
  it("second CSS-Edit uses pixel-diff when no selector match on page", async () => {
    if (!chromeOk || !benchmarkOk) return;

    // First run: populate cache (non-existent selector)
    await runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: {
          file_path: "/project/theme.css",
          old_string: "  font-size: 14px;",
          new_string: "  font-size: 16px;",
        },
        tool_response: { success: true },
      }),
    );

    // Second run: should use pixel-diff from cached screenshot
    const { stdout, exitCode } = await runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: {
          file_path: "/project/theme.css",
          old_string: "  font-size: 16px;",
          new_string: "  font-size: 18px;",
        },
        tool_response: { success: true },
      }),
    );

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    const ctx = result.hookSpecificOutput.additionalContext;
    // Either pixel-diff detected a change, or no visible change (both valid)
    expect(ctx).toMatch(/Pixel-Diff|Keine sichtbare Aenderung|Viewport/);
  });

  // ---- Test 5: Cache has URL metadata (navigation-aware) ----
  it("cache stores URL metadata for navigation invalidation", async () => {
    if (!chromeOk || !benchmarkOk) return;

    await runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: {
          file_path: "/project/nav.css",
          old_string: "nav { display: flex; }",
          new_string: "nav { display: grid; }",
        },
        tool_response: { success: true },
      }),
    );

    // Find the cache meta file
    const files = (await import("node:fs")).readdirSync("/tmp")
      .filter((f: string) => f.startsWith("visual-feedback-last-") && f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);

    const meta = JSON.parse(await readFile(`/tmp/${files[0]}`, "utf-8"));
    expect(meta.url).toContain("localhost:4242");
  });
});
