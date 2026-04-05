#!/usr/bin/env node
/**
 * SilbercueChrome Smoke Test — runs MCP tools against the live benchmark page.
 * Usage: node test-hardest/smoke-test.mjs
 * Requires: Chrome on port 9222, benchmark server on port 4242
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

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
  return { text, hasImage, ms, isError: res.isError };
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
console.log(`\n${BOLD}SilbercueChrome Smoke Test${RESET}\n`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
});

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`${DIM}Connected — ${tools.tools.length} tools available${RESET}\n`);

// ── 1. Navigate to benchmark page ──
await test("navigate → localhost:4242", async () => {
  const r = await callTool(client, "navigate", { url: "http://localhost:4242" });
  assert(!r.isError, `navigate error: ${r.text}`);
  assert(r.text.includes("localhost:4242") || r.text.includes("Test Hardest"), `unexpected: ${r.text?.slice(0, 100)}`);
  log(PASS, "navigate → localhost:4242", r.ms);
});

// ── 2. tab_status (Epic 4, Story 4.1) ──
await test("tab_status — cached state", async () => {
  const r = await callTool(client, "tab_status");
  assert(!r.isError, `tab_status error: ${r.text}`);
  assert(r.text.includes("localhost:4242"), `URL not in status: ${r.text?.slice(0, 100)}`);
  log(PASS, "tab_status — cached state", r.ms, r.text?.split("\n")[0]);
});

// ── 3. read_page — accessibility tree ──
await test("read_page — a11y tree", async () => {
  const r = await callTool(client, "read_page");
  assert(!r.isError, `read_page error: ${r.text}`);
  assert(r.text.includes("SilbercueChrome") || r.text.includes("Test Hardest"), `page title missing`);
  const refCount = (r.text.match(/\[e\d+\]/g) || []).length;
  assert(refCount > 5, `too few refs: ${refCount}`);
  log(PASS, "read_page — a11y tree", r.ms, `${refCount} refs`);
});

// ── 4. virtual_desk (Epic 4, Story 4.3) ──
await test("virtual_desk — tab overview", async () => {
  const r = await callTool(client, "virtual_desk");
  assert(!r.isError, `virtual_desk error: ${r.text}`);
  assert(r.text.includes("localhost:4242"), `benchmark tab not listed`);
  log(PASS, "virtual_desk — tab overview", r.ms);
});

// ── 5. screenshot ──
await test("screenshot — captures page", async () => {
  const r = await callTool(client, "screenshot");
  assert(!r.isError, `screenshot error: ${r.text}`);
  assert(r.hasImage, "no image in response");
  log(PASS, "screenshot — captures page", r.ms);
});

// ── 6. evaluate — JS execution ──
await test("evaluate — 2+2", async () => {
  const r = await callTool(client, "evaluate", { expression: "2 + 2" });
  assert(!r.isError, `evaluate error: ${r.text}`);
  assert(r.text.includes("4"), `expected 4, got: ${r.text}`);
  log(PASS, "evaluate — 2+2", r.ms);
});

// ── 7. T1.1 — Click button (Benchmark Test) ──
await test("T1.1 — click button", async () => {
  // Click the T1.1 button by its ID
  const r2 = await callTool(client, "click", { selector: "#t1-1-btn" });
  assert(!r2.isError, `click error: ${r2.text}`);

  // Check result
  const r3 = await callTool(client, "evaluate", {
    expression: `document.getElementById('t1-1-result')?.textContent || document.getElementById('t1-1-status')?.textContent || 'NO_RESULT'`,
  });
  log(PASS, "T1.1 — click button", r2.ms, r3.text?.slice(0, 60));
});

// ── 8. evaluate — DOM query on benchmark ──
await test("evaluate — count test cards", async () => {
  const r = await callTool(client, "evaluate", {
    expression: `document.querySelectorAll('[data-test]').length`,
  });
  assert(!r.isError, `evaluate error: ${r.text}`);
  const count = parseInt(r.text);
  assert(count >= 20, `expected 20+ test cards, got: ${count}`);
  log(PASS, "evaluate — count test cards", r.ms, `${count} cards`);
});

// ── 9. switch_tab open + close (Epic 4, Story 4.2) ──
await test("switch_tab — open & close tab", async () => {
  const r1 = await callTool(client, "switch_tab", { action: "open", url: "about:blank" });
  assert(!r1.isError, `open error: ${r1.text}`);
  log(PASS, "switch_tab open", r1.ms);

  const r2 = await callTool(client, "switch_tab", { action: "close" });
  assert(!r2.isError, `close error: ${r2.text}`);
  log(PASS, "switch_tab close", r2.ms);
});

// ── 10. run_plan — batch execution (Epic 5, Story 5.1) ──
await test("run_plan — 3-step batch", async () => {
  const r = await callTool(client, "run_plan", {
    steps: [
      { tool: "evaluate", params: { expression: "'step1_ok'" } },
      { tool: "evaluate", params: { expression: "1 + 1" } },
      { tool: "evaluate", params: { expression: "document.title" } },
    ],
  });
  assert(!r.isError, `run_plan error: ${r.text}`);
  assert(r.text.includes("step1_ok"), `step1 missing in output`);
  assert(r.text.includes("2"), `step2 result missing`);
  log(PASS, "run_plan — 3-step batch", r.ms);
});

// ── Summary ──
console.log(`\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.log(`${BOLD}  ${passed} passed, ${failed} failed${RESET}`);
if (results.length > 0) {
  console.log(`\n${BOLD}Failures:${RESET}`);
  results.forEach((r) => console.log(`  ${FAIL} ${r.name}: ${r.error}`));
}
console.log();

await client.close();
process.exit(failed > 0 ? 1 : 0);
