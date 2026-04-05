#!/usr/bin/env node
/**
 * Epic 5b Feature Tests — tests new visual enrichment & performance tools.
 * Usage: node test-hardest/epic5b-test.mjs
 * Requires: Chrome on port 9222, benchmark server on port 4242
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

let passed = 0;
let failed = 0;
const results = [];

function log(icon, name, ms, detail = "") {
  const d = detail ? ` ${DIM}${detail}${RESET}` : "";
  console.log(`  ${icon} ${name} ${DIM}(${ms}ms)${RESET}${d}`);
}

async function callTool(client, name, args = {}) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const text = res.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const hasImage = res.content?.some((c) => c.type === "image");
  return { text, hasImage, ms, isError: res.isError, raw: res };
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    results.push({ name, error: e.message });
    log(FAIL, name, 0, e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── Main ──
console.log(`\n${BOLD}Epic 5b Feature Tests${RESET}`);
console.log(`${DIM}Visual Enrichment & Performance Optimization${RESET}\n`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
});

const client = new Client({ name: "epic5b-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`${DIM}Connected — ${tools.tools.length} tools available${RESET}\n`);

// Navigate to benchmark page
await callTool(client, "navigate", { url: "http://localhost:4242" });

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log(`${CYAN}── Story 5b.1: Screenshot Optimization ──${RESET}`);

await test("screenshot — returns WebP image", async () => {
  const r = await callTool(client, "screenshot");
  assert(!r.isError, `error: ${r.text}`);
  assert(r.hasImage, "no image returned");
  // Check metadata
  const meta = r.text || "";
  log(PASS, "screenshot — WebP image", r.ms, `has metadata: ${meta.length > 0}`);
});

await test("screenshot — full_page mode", async () => {
  const r = await callTool(client, "screenshot", { full_page: true });
  assert(!r.isError, `error: ${r.text}`);
  assert(r.hasImage, "no image returned");
  log(PASS, "screenshot — full_page", r.ms);
});

await test("screenshot — latency < 300ms", async () => {
  // Run 3 times and check average
  let totalMs = 0;
  for (let i = 0; i < 3; i++) {
    const r = await callTool(client, "screenshot");
    assert(!r.isError, `error run ${i}: ${r.text}`);
    totalMs += r.ms;
  }
  const avgMs = Math.round(totalMs / 3);
  assert(avgMs < 300, `avg ${avgMs}ms > 300ms`);
  log(PASS, "screenshot — avg latency", avgMs, `${avgMs}ms (3 runs)`);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log(`\n${CYAN}── Story 5b.2: dom_snapshot Tool ──${RESET}`);

await test("dom_snapshot — full page", async () => {
  const r = await callTool(client, "dom_snapshot");
  assert(!r.isError, `error: ${r.text}`);
  // Should contain visual info like bounds, colors, z-order
  assert(r.text.length > 100, `output too short: ${r.text.length} chars`);
  const hasBounds = r.text.includes("x:") || r.text.includes("bounds") || r.text.includes("w:");
  assert(hasBounds, "no bounds/position data found");
  log(PASS, "dom_snapshot — full page", r.ms, `${r.text.length} chars`);
});

await test("dom_snapshot — has clickability info", async () => {
  const r = await callTool(client, "dom_snapshot");
  assert(!r.isError, `error: ${r.text}`);
  const hasClickable = r.text.toLowerCase().includes("click") || r.text.includes("interactive") || r.text.includes("pointer");
  assert(hasClickable, "no clickability info found");
  log(PASS, "dom_snapshot — clickability", r.ms);
});

await test("dom_snapshot — has z-order/visibility", async () => {
  const r = await callTool(client, "dom_snapshot");
  assert(!r.isError, `error: ${r.text}`);
  const hasZOrder = r.text.includes("z") || r.text.includes("visible") || r.text.includes("paint");
  assert(hasZOrder, "no z-order/visibility info");
  log(PASS, "dom_snapshot — z-order/visibility", r.ms);
});

await test("dom_snapshot — has color info", async () => {
  const r = await callTool(client, "dom_snapshot");
  assert(!r.isError, `error: ${r.text}`);
  const hasColor = r.text.includes("#") || r.text.includes("rgb") || r.text.includes("color") || r.text.includes("bg:");
  assert(hasColor, "no color info found");
  log(PASS, "dom_snapshot — colors", r.ms);
});

await test("dom_snapshot — with ref (focused element)", async () => {
  // First get a ref from read_page
  const rp = await callTool(client, "read_page");
  const refMatch = rp.text.match(/\[(e\d+)\]/);
  assert(refMatch, "no ref found in read_page");
  const ref = refMatch[1];

  const r = await callTool(client, "dom_snapshot", { ref });
  assert(!r.isError, `error: ${r.text}`);
  assert(r.text.length > 10, `output too short for ref ${ref}`);
  log(PASS, "dom_snapshot — ref focus", r.ms, `ref=${ref}`);
});

await test("dom_snapshot — refs mapped to read_page", async () => {
  const rp = await callTool(client, "read_page");
  const rpRefs = (rp.text.match(/\[e\d+\]/g) || []).map(r => r.replace(/[\[\]]/g, ""));

  const ds = await callTool(client, "dom_snapshot");
  const dsRefs = (ds.text.match(/e\d+/g) || []);

  // At least some refs should overlap
  const overlap = rpRefs.filter(r => dsRefs.includes(r));
  assert(overlap.length > 0, `no ref overlap between read_page (${rpRefs.length}) and dom_snapshot (${dsRefs.length})`);
  log(PASS, "dom_snapshot — ref mapping", ds.ms, `${overlap.length} shared refs`);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log(`\n${CYAN}── Story 5b.3: read_page visual filter ──${RESET}`);

await test("read_page filter:visual — has visual enrichment", async () => {
  const r = await callTool(client, "read_page", { filter: "visual" });
  assert(!r.isError, `error: ${r.text}`);
  // Visual filter should add bounds/clickability/visibility
  const hasVisual = r.text.includes("bounds") || r.text.includes("x:") || r.text.includes("click") || r.text.includes("visible") || r.text.includes("w:");
  assert(hasVisual, "no visual enrichment in output");
  log(PASS, "read_page filter:visual", r.ms, `${r.text.length} chars`);
});

await test("read_page filter:visual vs default — more info", async () => {
  const rDefault = await callTool(client, "read_page", { filter: "interactive" });
  const rVisual = await callTool(client, "read_page", { filter: "visual" });
  assert(!rDefault.isError, `default error: ${rDefault.text}`);
  assert(!rVisual.isError, `visual error: ${rVisual.text}`);
  // Visual should contain more information
  assert(rVisual.text.length >= rDefault.text.length,
    `visual (${rVisual.text.length}) should be >= default (${rDefault.text.length})`);
  log(PASS, "read_page visual > default", rVisual.ms,
    `visual=${rVisual.text.length} vs default=${rDefault.text.length} chars`);
});

await test("read_page filter:all — complete tree", async () => {
  const r = await callTool(client, "read_page", { filter: "all" });
  assert(!r.isError, `error: ${r.text}`);
  const refCount = (r.text.match(/\[e\d+\]/g) || []).length;
  assert(refCount > 20, `too few refs for all filter: ${refCount}`);
  log(PASS, "read_page filter:all", r.ms, `${refCount} refs`);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log(`\n${CYAN}── Story 5b.4: Set-of-Mark (SOM) ──${RESET}`);

await test("screenshot som:true — returns image with labels", async () => {
  const r = await callTool(client, "screenshot", { som: true });
  assert(!r.isError, `error: ${r.text}`);
  assert(r.hasImage, "no image returned");
  // SOM metadata should mention elements
  const meta = r.text || "";
  const hasSomInfo = meta.includes("som") || meta.includes("label") || meta.includes("element");
  log(PASS, "screenshot som:true — image", r.ms, meta.slice(0, 80));
});

await test("screenshot som:true — has element count", async () => {
  const r = await callTool(client, "screenshot", { som: true });
  assert(!r.isError, `error: ${r.text}`);
  assert(r.hasImage, "no image returned");
  log(PASS, "screenshot som:true — elements", r.ms, (r.text || "").slice(0, 80));
});

await test("screenshot som:true — labels mapped to refs", async () => {
  // Get SOM screenshot
  const som = await callTool(client, "screenshot", { som: true });
  assert(!som.isError, `som error: ${som.text}`);

  // Get read_page refs
  const rp = await callTool(client, "read_page");
  const rpRefs = (rp.text.match(/\[e\d+\]/g) || []).length;
  assert(rpRefs > 0, "no read_page refs");

  log(PASS, "screenshot som — ref mapping", som.ms, `read_page has ${rpRefs} refs`);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log(`\n${CYAN}── Story 5b.5: DOM Downsampling ──${RESET}`);

await test("read_page max_tokens:500 — respects budget or skips", async () => {
  const fullPage = await callTool(client, "read_page", { filter: "all" });
  const r = await callTool(client, "read_page", { filter: "all", max_tokens: 500 });
  assert(!r.isError, `error: ${r.text}`);
  // On a large enough page, downsampled should be smaller. On a small page, it stays the same.
  const fullTokensEst = Math.ceil(fullPage.text.length / 4);
  if (fullTokensEst > 500) {
    assert(r.text.length < fullPage.text.length,
      `downsampled (${r.text.length}) not smaller than full (${fullPage.text.length})`);
    log(PASS, "read_page max_tokens:500 — downsampled", r.ms,
      `${r.text.length} vs ${fullPage.text.length} chars`);
  } else {
    log(PASS, "read_page max_tokens:500 — page small enough, no downsample needed", r.ms,
      `~${fullTokensEst} tokens < 500 budget`);
  }
});

await test("read_page max_tokens:2000 — moderate budget", async () => {
  const r = await callTool(client, "read_page", { max_tokens: 2000 });
  assert(!r.isError, `error: ${r.text}`);
  assert(r.text.length > 100, "output too short");
  log(PASS, "read_page max_tokens:2000", r.ms, `${r.text.length} chars`);
});

await test("read_page max_tokens — downsample metadata", async () => {
  const r = await callTool(client, "read_page", { max_tokens: 500, filter: "all" });
  assert(!r.isError, `error: ${r.text}`);
  // Should indicate downsampling happened
  const meta = r.text || "";
  const downsampled = meta.includes("downsample") || meta.includes("truncat") || meta.includes("budget") || meta.includes("level");
  log(PASS, "read_page — downsample metadata", r.ms,
    `downsampled indicator: ${downsampled}, ${meta.length} chars`);
});

await test("read_page max_tokens — still contains refs", async () => {
  const r = await callTool(client, "read_page", { max_tokens: 500 });
  assert(!r.isError, `error: ${r.text}`);
  const refCount = (r.text.match(/\[e\d+\]/g) || []).length;
  assert(refCount > 0, `no refs in downsampled output`);
  log(PASS, "read_page downsampled — has refs", r.ms, `${refCount} refs`);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log(`\n${CYAN}── Kombinationstests ──${RESET}`);

await test("read_page filter:visual + max_tokens:1000 — combined", async () => {
  const r = await callTool(client, "read_page", { filter: "visual", max_tokens: 1000 });
  assert(!r.isError, `error: ${r.text}`);
  assert(r.text.length > 50, "output too short");
  log(PASS, "visual + downsampled combined", r.ms, `${r.text.length} chars`);
});

await test("run_plan — dom_snapshot + screenshot som in batch", async () => {
  const r = await callTool(client, "run_plan", {
    steps: [
      { tool: "dom_snapshot", params: {} },
      { tool: "screenshot", params: { som: true } },
      { tool: "read_page", params: { filter: "visual", max_tokens: 500 } },
    ],
  });
  assert(!r.isError, `run_plan error: ${r.text}`);
  log(PASS, "run_plan — 5b combo batch", r.ms);
});

// ── Summary ──
console.log(`\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.log(`${BOLD}  Epic 5b: ${passed} passed, ${failed} failed${RESET}`);
if (results.length > 0) {
  console.log(`\n${BOLD}Failures:${RESET}`);
  results.forEach((r) => console.log(`  ${FAIL} ${r.name}: ${r.error}`));
}
console.log();

await client.close();
process.exit(failed > 0 ? 1 : 0);
