#!/usr/bin/env node
/**
 * SilbercueChrome PRO Smoke Test — Story 16.7 Task 4.
 *
 * Pro-Variante von test-hardest/smoke-test.mjs (Free-Variante).
 * Startet den Pro-Server (silbercuechrome-pro/build/index.js) statt des Free-Servers.
 *
 * Usage: node test-hardest/smoke-test-pro.mjs
 * Requires: Chrome on port 9222, benchmark server on port 4242, Pro-Repo gebaut.
 *
 * UNTERSCHIEDE zur Free-Variante (siehe Story 16.7 Task 4):
 *   1. `cwd` zeigt auf das Pro-Repo (silbercuechrome-pro), damit
 *      `node_modules/@silbercuechrome/mcp` per `file:`-Dependency aufloest.
 *   2. `args` zeigt auf `build/index.js` im Pro-Repo (relative path).
 *
 * SEMANTISCH INVERTIERTE ASSERTS gegenueber der Free-Variante:
 *   Im Pro-Server registriert `index.ts` die Pro-Hooks. Daraus folgt:
 *
 *   - `inspect_element` IST in `tools/list` (registerProTools-Hook registriert es
 *     unabhaengig vom License-Status). Free erwartet "absent", Pro erwartet
 *     "present".
 *   - `evaluate` mit Style-Change-Expressions liefert KEIN Screenshot wenn
 *     `licenseStatus.isPro() === false`, weil der `enhanceEvaluateResult`-Hook
 *     selbst nicht gegated ist — ABER die Free-Erwartung gilt nur, wenn der
 *     Pro-Server OHNE `SILBERCUECHROME_LICENSE_KEY` env var laeuft. Dann faellt
 *     `provideLicenseStatus` auf FreeTier zurueck, der `enhanceEvaluateResult`-
 *     Hook ist trotzdem registriert und liefert ein Screenshot. In dieser
 *     Smoke-Test-Variante akzeptieren wir BEIDES (mit oder ohne Screenshot),
 *     weil das Pro-Verhalten beide Pfade abdeckt.
 *
 *   - `virtual_desk` und `switch_tab` bleiben im Pro-Server OHNE License-Env
 *     weiterhin Free-gegated, weil `licenseStatus.isPro() === false`. Die
 *     Asserts bleiben daher unveraendert.
 *
 * SYNCHRON HALTEN: Falls die Free-Variante (smoke-test.mjs) sich aendert,
 * MUSS diese Datei manuell nachgezogen werden — keine geteilte Code-Basis.
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
console.log(`\n${BOLD}SilbercueChrome PRO Smoke Test${RESET}\n`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: new URL("../../silbercuechrome-pro", import.meta.url).pathname,
  env: { ...process.env },
});

const client = new Client({ name: "smoke-test-pro", version: "1.0.0" });
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

// ── 4. virtual_desk — Pro-Feature: in Pro-Repo OHNE License-Env weiterhin gegated ──
// Im Pro-Server faellt provideLicenseStatus ohne `SILBERCUECHROME_LICENSE_KEY`
// auf FreeTier zurueck, daher ist licenseStatus.isPro() === false und
// `virtual_desk` bleibt gegated. Test bleibt semantisch identisch zur Free-Variante.
await test("virtual_desk — Pro-Feature gated without license env", async () => {
  const r = await callTool(client, "virtual_desk");
  assert(r.isError, `expected Pro-Feature error, got success: ${r.text?.slice(0, 100)}`);
  assert(
    r.text?.includes("Pro-Feature"),
    `expected "Pro-Feature" in error text, got: ${r.text?.slice(0, 100)}`,
  );
  log(PASS, "virtual_desk — Pro-Feature gated without license env", r.ms);
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
  const r2 = await callTool(client, "click", { selector: "#t1-1-btn" });
  assert(!r2.isError, `click error: ${r2.text}`);

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

// ── 9. switch_tab — Pro-Feature: ohne License-Env weiterhin gegated ──
// Analog zu virtual_desk: ohne SILBERCUECHROME_LICENSE_KEY ist isPro() === false.
await test("switch_tab — Pro-Feature gated without license env", async () => {
  const r1 = await callTool(client, "switch_tab", { action: "open", url: "about:blank" });
  assert(r1.isError, `expected Pro-Feature error, got success: ${r1.text?.slice(0, 100)}`);
  assert(
    r1.text?.includes("Pro-Feature"),
    `expected "Pro-Feature" in error text, got: ${r1.text?.slice(0, 100)}`,
  );
  log(PASS, "switch_tab — Pro-Feature gated without license env", r1.ms);
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

// ── 11. inspect_element — Pro-Tool MUSS in tools/list sein (Story 16.4) ──
// SEMANTISCH INVERTIERT gegenueber Free-Smoke-Test: dort "absent", hier "present".
// `registerProTools`-Hook im Pro-Server registriert inspect_element unabhaengig
// vom License-Status (das Tool ist immer da, sobald der Pro-Server laeuft).
await test("inspect_element — Pro-Tool present in tools/list", async () => {
  const listed = tools.tools.map((t) => t.name);
  assert(
    listed.includes("inspect_element"),
    `inspect_element MUST be in Pro-Tier tools/list, got: ${listed.join(", ")}`,
  );
  log(PASS, "inspect_element — Pro-Tool present in tools/list", 0);
});

// ── 12-15. Visual Feedback nach evaluate (Story 16.4 enhanceEvaluateResult) ──
// SEMANTISCH INVERTIERT: Im Pro-Server ist der enhanceEvaluateResult-Hook
// registriert und liefert bei Style-Change-Expressions ein Clip-Screenshot.
// Wir verifizieren, dass das Hook NICHT crasht und die evaluate-Antwort
// weiterhin den Text-Content enthaelt. Ein Screenshot ist OPTIONAL erlaubt
// (kein Assertion-Fail wenn keiner kommt — z.B. wenn das Element nicht
// visible ist oder die Geometry-Erfassung fehlschlaegt).

await test("evaluate style-change (border) → no crash, optional screenshot", async () => {
  const r = await callTool(client, "evaluate", {
    expression: `document.querySelector('#t1-1-btn').style.border = '3px solid red'`,
  });
  assert(!r.isError, `evaluate error: ${r.text}`);
  log(PASS, "evaluate style-change (border) → no crash, optional screenshot", r.ms, r.hasImage ? "screenshot included" : "no screenshot");
});

await test("evaluate no style-change → no screenshot", async () => {
  const r = await callTool(client, "evaluate", {
    expression: `document.querySelector('#t1-1-btn').textContent`,
  });
  assert(!r.isError, `evaluate error: ${r.text}`);
  assert(!r.hasImage, "read-only evaluate should NOT include screenshot");
  log(PASS, "evaluate no style-change → no screenshot", r.ms);
});

await test("evaluate style-change (background) → no crash, optional screenshot", async () => {
  const r = await callTool(client, "evaluate", {
    expression: `document.querySelector('#t1-1-btn').style.backgroundColor = 'yellow'`,
  });
  assert(!r.isError, `evaluate error: ${r.text}`);
  log(PASS, "evaluate style-change (background) → no crash, optional screenshot", r.ms, r.hasImage ? "screenshot included" : "no screenshot");
});

await test("evaluate style-change (outline on body) → no crash, optional screenshot", async () => {
  const r = await callTool(client, "evaluate", {
    expression: `document.body.style.outline = '3px solid blue'`,
  });
  assert(!r.isError, `evaluate error: ${r.text}`);
  log(PASS, "evaluate style-change (outline on body) → no crash, optional screenshot", r.ms, r.hasImage ? "screenshot included" : "no screenshot");
});

// Restore original styles
await callTool(client, "evaluate", {
  expression: `(() => { const btn = document.getElementById('t1-1-btn'); btn.style.border = ''; btn.style.backgroundColor = ''; document.body.style.outline = ''; })()`,
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
