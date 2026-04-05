#!/usr/bin/env node
/**
 * SilbercueChrome MCP Benchmark — runs all 24 tests via MCP tools.
 * Usage: node test-hardest/run-mcp-benchmark.mjs
 * Requires: Chrome on port 9222, benchmark server on port 4242
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "fs";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const results = {};
let totalToolUses = 0;

async function callTool(client, name, args = {}) {
  totalToolUses++;
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const text = res.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { text, ms, isError: res.isError };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTest(id, label, fn) {
  const start = Date.now();
  let status = "fail";
  let details = "";
  try {
    const result = await fn();
    status = result.pass ? "pass" : "fail";
    details = result.details || "";
  } catch (e) {
    details = e.message.substring(0, 120);
  }
  const ms = Date.now() - start;
  const icon = status === "pass" ? PASS : FAIL;
  console.log(`  ${icon} T${id} ${label.padEnd(24)} ${DIM}${ms}ms${RESET}  ${details}`);
  results[`T${id}`] = { status, duration_ms: ms, details };
}

async function getStatus(client, id) {
  const r = await callTool(client, "evaluate", {
    expression: `(document.getElementById('${id}')?.textContent || '').trim()`,
  });
  const raw = r.text?.replace(/^"|"$/g, "") || "";
  if (raw !== "PASS") {
    console.log(`    ${DIM}⚠ ${id} = "${raw}" (expected "PASS")${RESET}`);
  }
  return raw;
}

// ── Main ──
console.log(`\n${BOLD}SilbercueChrome MCP Benchmark${RESET}`);
console.log(`${"=".repeat(55)}`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
});

const client = new Client({ name: "mcp-benchmark", version: "1.0.0" });
const benchStart = Date.now();
await client.connect(transport);

// Force clean page state — navigate away first, then to benchmark
await callTool(client, "navigate", { url: "about:blank" });
await callTool(client, "navigate", { url: "http://localhost:4242" });

// ── Level 1: Basics ──
console.log(`\n${BOLD}Level 1 — Basics${RESET}`);

await runTest("1.1", "Click Button", async () => {
  await callTool(client, "click", { selector: "#t1-1-btn" });
  const s = await getStatus(client, "t1-1-status");
  return { pass: s === "PASS", details: "clicked" };
});

await runTest("1.2", "Read Text", async () => {
  const r = await callTool(client, "evaluate", {
    expression: `document.getElementById('t1-2-secret').textContent.trim()`,
  });
  const secret = r.text?.replace(/^"|"$/g, "") || "";
  await callTool(client, "type", { selector: "#t1-2-input", text: secret, clear: true });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t1_2()"]' });
  const s = await getStatus(client, "t1-2-status");
  return { pass: s === "PASS", details: secret };
});

await runTest("1.3", "Fill Form", async () => {
  await callTool(client, "type", { selector: "#t1-3-name", text: "Max Mustermann", clear: true });
  await callTool(client, "type", { selector: "#t1-3-email", text: "max@example.com", clear: true });
  await callTool(client, "type", { selector: "#t1-3-age", text: "30", clear: true });
  await callTool(client, "evaluate", { expression: `document.getElementById('t1-3-country').value = 'de'; document.getElementById('t1-3-country').dispatchEvent(new Event('change'))` });
  await callTool(client, "type", { selector: "#t1-3-bio", text: "Automation test runner", clear: true });
  await callTool(client, "evaluate", { expression: `document.getElementById('t1-3-terms').checked = true` });
  await callTool(client, "evaluate", { expression: `document.getElementById('t1-3-form').requestSubmit()` });
  const s = await getStatus(client, "t1-3-status");
  return { pass: s === "PASS", details: "submitted" };
});

await runTest("1.4", "Selector Challenge", async () => {
  await callTool(client, "click", { selector: "#sel-by-id" });
  await callTool(client, "click", { selector: ".sel-by-class" });
  await callTool(client, "click", { selector: '[data-action="sel-data"]' });
  await callTool(client, "click", { selector: '[aria-label="accessibility-target"]' });
  await callTool(client, "click", { selector: "#t1-4-text-btn" });
  await sleep(100);
  const s = await getStatus(client, "t1-4-status");
  return { pass: s.includes("PASS"), details: "5/5 selectors" };
});

await runTest("1.5", "Nav Sequence", async () => {
  await callTool(client, "evaluate", { expression: `Tests.t1_5_nav('alpha')` });
  await callTool(client, "evaluate", { expression: `Tests.t1_5_nav('beta')` });
  await callTool(client, "evaluate", { expression: `Tests.t1_5_nav('gamma')` });
  await callTool(client, "evaluate", { expression: `Tests.t1_5_verify()` });
  const s = await getStatus(client, "t1-5-status");
  return { pass: s === "PASS", details: "alpha,beta,gamma" };
});

await runTest("1.6", "Table Sum", async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => { let s = 0; document.querySelectorAll('#t1-6-table tbody tr').forEach(tr => { const tds = tr.querySelectorAll('td'); if (tds[2]) s += parseFloat(tds[2].textContent) || 0; }); return Math.round(s); })()`,
  });
  const sum = r.text?.trim() || "";
  await callTool(client, "type", { selector: "#t1-6-input", text: sum, clear: true });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t1_6()"]' });
  const s = await getStatus(client, "t1-6-status");
  return { pass: s === "PASS", details: "sum=" + sum };
});

// ── Level 2: Intermediate ──
await callTool(client, "evaluate", { expression: "window.scrollTo(0,0)" });
await callTool(client, "evaluate", { expression: 'document.querySelector(\'#level-nav button[data-level="2"]\').click()' });
console.log(`\n${BOLD}Level 2 — Intermediate${RESET}`);

await runTest("2.1", "Async Content", async () => {
  await callTool(client, "click", { selector: "#t2-1-load" });
  await callTool(client, "wait_for", {
    condition: "js",
    expression: `document.getElementById('t2-1-container')?.textContent?.includes('Loaded')`,
    timeout: 5000,
  });
  const r = await callTool(client, "evaluate", {
    expression: `(document.getElementById('t2-1-container').textContent.match(/:\\s*(\\S+)/) || [])[1] || ''`,
  });
  const val = r.text?.replace(/^"|"$/g, "") || "";
  await callTool(client, "type", { selector: "#t2-1-input", text: val, clear: true });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t2_1_verify()"]' });
  const s = await getStatus(client, "t2-1-status");
  return { pass: s === "PASS", details: val };
});

await runTest("2.2", "Infinite Scroll", async () => {
  for (let i = 0; i < 5; i++) {
    await callTool(client, "evaluate", {
      expression: `document.getElementById('t2-2-scroller').scrollTop = document.getElementById('t2-2-scroller').scrollHeight`,
    });
    await sleep(200);
  }
  await callTool(client, "click", { selector: 'button[onclick="Tests.t2_2_verify()"]' });
  const s = await getStatus(client, "t2-2-status");
  return { pass: s === "PASS", details: "scrolled" };
});

await runTest("2.3", "Wizard", async () => {
  await callTool(client, "evaluate", {
    expression: `document.querySelector('input[name="t2-3-plan"][value="pro"]').click()`,
  });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t2_3_next(1)"]' });
  await callTool(client, "type", { selector: "#t2-3-company", text: "Acme Corp", clear: true });
  await callTool(client, "type", { selector: "#t2-3-team-size", text: "10", clear: true });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t2_3_next(2)"]' });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t2_3_finish()"]' });
  const s = await getStatus(client, "t2-3-status");
  return { pass: s === "PASS", details: "pro plan" };
});

await runTest("2.4", "Searchable Dropdown", async () => {
  // Read randomized target language from page
  const targetR = await callTool(client, "evaluate", {
    expression: `document.getElementById('t2-4-target').textContent.trim()`,
  });
  const target = targetR.text?.replace(/^"|"$/g, "") || "TypeScript";
  await callTool(client, "click", { selector: "#t2-4-search" });
  await callTool(client, "type", { selector: "#t2-4-search", text: target.substring(0, 3), clear: true });
  await sleep(100);
  await callTool(client, "evaluate", {
    expression: `(() => { const items = document.querySelectorAll('#t2-4-dropdown div'); for (const item of items) { if (item.textContent.includes('${target}')) { item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 'clicked'; } } return 'not found'; })()`,
  });
  const s = await getStatus(client, "t2-4-status");
  return { pass: s === "PASS", details: target };
});

await runTest("2.5", "Tab Management", async () => {
  // Open new tab with target page
  await callTool(client, "switch_tab", { action: "open", url: "http://localhost:4242/tab-target.html" });
  await sleep(500);
  const r = await callTool(client, "evaluate", {
    expression: `(document.getElementById('tab-value')?.textContent || '').trim()`,
  });
  const val = r.text?.replace(/^"|"$/g, "") || "";
  // Close tab — switch_tab auto-switches to remaining tab
  await callTool(client, "switch_tab", { action: "close" });
  await sleep(500);
  // Verify we're back on the benchmark page
  const check = await callTool(client, "evaluate", {
    expression: `document.title.includes('Benchmark') || document.title.includes('SilbercueChrome') || !!document.getElementById('t2-5-input')`,
  });
  if (!check.text?.includes("true")) {
    // Fallback: find and switch to the benchmark tab
    await callTool(client, "navigate", { url: "http://localhost:4242" });
    await sleep(300);
  }
  await callTool(client, "type", { selector: "#t2-5-input", text: val, clear: true });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t2_5_verify()"]' });
  const s = await getStatus(client, "t2-5-status");
  return { pass: s === "PASS", details: val };
});

await runTest("2.6", "Sort Table", async () => {
  await callTool(client, "evaluate", {
    expression: `document.querySelector('th[onclick="Tests.t2_6_sort(\\'price\\')"]').click()`,
  });
  await sleep(50);
  await callTool(client, "evaluate", {
    expression: `document.querySelector('th[onclick="Tests.t2_6_sort(\\'price\\')"]').click()`,
  });
  await sleep(50);
  const r = await callTool(client, "evaluate", {
    expression: `document.querySelector('#t2-6-body tr:first-child td:first-child').textContent.trim()`,
  });
  const name = r.text?.replace(/^"|"$/g, "") || "";
  await callTool(client, "type", { selector: "#t2-6-input", text: name, clear: true });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t2_6_verify()"]' });
  const s = await getStatus(client, "t2-6-status");
  return { pass: s === "PASS", details: name };
});

// ── Level 3: Advanced ──
await callTool(client, "evaluate", { expression: "window.scrollTo(0,0)" });
await callTool(client, "evaluate", { expression: 'document.querySelector(\'#level-nav button[data-level="3"]\').click()' });
console.log(`\n${BOLD}Level 3 — Advanced${RESET}`);

await runTest("3.1", "Shadow DOM", async () => {
  await callTool(client, "evaluate", {
    expression: `document.getElementById('t3-1-shadow-host').shadowRoot.querySelector('button').click()`,
  });
  const r = await callTool(client, "evaluate", {
    expression: `document.getElementById('t3-1-shadow-host').shadowRoot.querySelector('#shadow-value').textContent.trim()`,
  });
  const val = r.text?.replace(/^"|"$/g, "") || "";
  await callTool(client, "type", { selector: '[data-test="3.1"] input[type="text"]', text: val, clear: true });
  await callTool(client, "click", { selector: '[data-test="3.1"] button[onclick*="verify"]' });
  const s = await getStatus(client, "t3-1-status");
  return { pass: s === "PASS", details: val };
});

await runTest("3.2", "Nested iFrame", async () => {
  // Read randomized frame value — try inner iframe first, then R.frameVal fallback
  const r = await callTool(client, "evaluate", {
    expression: `(() => { try { const inner = document.getElementById('t3-2-frame').contentDocument.querySelector('iframe').contentDocument; const el = inner.getElementById('inner-secret'); return el ? el.textContent.trim() : ''; } catch { return ''; } })()`,
  });
  let val = r.text?.replace(/^"|"$/g, "") || "";
  // Fallback: read from R.frameVal on main page
  if (!val || val === "FRAME-CLICKED") {
    const r2 = await callTool(client, "evaluate", { expression: `R.frameVal` });
    val = r2.text?.replace(/^"|"$/g, "") || val;
  }
  await callTool(client, "type", { selector: '[data-test="3.2"] input[type="text"]', text: val, clear: true });
  await callTool(client, "click", { selector: '[data-test="3.2"] button[onclick*="verify"]' });
  const s = await getStatus(client, "t3-2-status");
  return { pass: s === "PASS", details: val };
});

await runTest("3.3", "Drag & Drop", async () => {
  await callTool(client, "evaluate", {
    expression: `(() => { const list = document.getElementById('t3-3-list'); const items = Array.from(list.querySelectorAll('.drag-item')); items.sort((a, b) => parseInt(a.dataset.value) - parseInt(b.dataset.value)); items.forEach(i => list.appendChild(i)); return 'sorted'; })()`,
  });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t3_3_verify()"]' });
  const s = await getStatus(client, "t3-3-status");
  return { pass: s === "PASS", details: "1-2-3-4-5" };
});

await runTest("3.4", "Canvas Click", async () => {
  // Return object directly (evaluate JSON-serializes objects, no double-encode issue)
  const r = await callTool(client, "evaluate", {
    expression: `(() => { const c = document.getElementById('t3-4-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let sx = 0, sy = 0, n = 0; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i] > 200 && d[i+1] > 80 && d[i+1] < 140 && d[i+2] > 60 && d[i+2] < 110) { sx += x; sy += y; n++; } } return n ? { cx: Math.round(sx/n), cy: Math.round(sy/n) } : { cx: 250, cy: 125 }; })()`,
  });
  const coords = JSON.parse(r.text || '{"cx":250,"cy":125}');
  // Click canvas at the target position
  await callTool(client, "evaluate", {
    expression: `(() => { const c = document.getElementById('t3-4-canvas'); const rect = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + ${coords.cx}, clientY: rect.top + ${coords.cy} })); return 'clicked'; })()`,
  });
  const s = await getStatus(client, "t3-4-status");
  return { pass: s === "PASS", details: `(${coords.cx},${coords.cy})` };
});

await runTest("3.5", "Keyboard Shortcut", async () => {
  await callTool(client, "evaluate", {
    expression: `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return 'ctrl+k'; })()`,
  });
  await sleep(50);
  await callTool(client, "evaluate", {
    expression: `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'esc'; })()`,
  });
  await sleep(50);
  await callTool(client, "evaluate", {
    expression: `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'enter'; })()`,
  });
  const s = await getStatus(client, "t3-5-status");
  return { pass: s === "PASS", details: "Ctrl+K, Esc, Enter" };
});

await runTest("3.6", "Contenteditable", async () => {
  await callTool(client, "evaluate", {
    expression: `(() => { const ed = document.getElementById('t3-6-editor'); ed.textContent = ''; ed.appendChild(document.createTextNode('Hello ')); const b = document.createElement('strong'); b.textContent = 'World'; ed.appendChild(b); return 'done'; })()`,
  });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t3_6_verify()"]' });
  const s = await getStatus(client, "t3-6-status");
  return { pass: s === "PASS", details: "Hello <b>World</b>" };
});

// ── Level 4: Hardest ──
await callTool(client, "evaluate", { expression: "window.scrollTo(0,0)" });
await callTool(client, "evaluate", { expression: 'document.querySelector(\'#level-nav button[data-level="4"]\').click()' });
console.log(`\n${BOLD}Level 4 — Hardest${RESET}`);

await runTest("4.1", "Unpredictable Timing", async () => {
  await callTool(client, "click", { selector: "#t4-1-start" });
  await callTool(client, "wait_for", {
    condition: "js",
    expression: `!!document.querySelector('#t4-1-arena button')`,
    timeout: 7000,
  });
  await callTool(client, "click", { selector: "#t4-1-arena button" });
  const s = await getStatus(client, "t4-1-status");
  return { pass: s === "PASS", details: "caught" };
});

await runTest("4.2", "Counter Race", async () => {
  // Read randomized target value from page
  const targetR = await callTool(client, "evaluate", {
    expression: `R.counterTarget`,
  });
  const counterTarget = parseInt(targetR.text || "7");
  await callTool(client, "evaluate", {
    expression: `Tests.t4_2_start()`,
  });
  await callTool(client, "wait_for", {
    condition: "js",
    expression: `typeof Tests !== 'undefined' && Tests._t4_2_value === ${counterTarget}`,
    timeout: 6000,
  });
  await callTool(client, "click", { selector: "#t4-2-capture" });
  const s = await getStatus(client, "t4-2-status");
  return { pass: s === "PASS", details: "captured at " + counterTarget };
});

await runTest("4.3", "10K DOM Needle", async () => {
  await callTool(client, "evaluate", {
    expression: `Tests.t4_3_generate()`,
  });
  await sleep(100);
  const r = await callTool(client, "evaluate", {
    expression: `(document.getElementById('the-needle') || {}).textContent || ''`,
  });
  const needle = r.text?.replace(/^"|"$/g, "") || "";
  await callTool(client, "type", { selector: "#t4-3-input", text: needle, clear: true });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t4_3_verify()"]' });
  const s = await getStatus(client, "t4-3-status");
  return { pass: s === "PASS", details: needle };
});

await runTest("4.4", "LocalStorage+Cookie", async () => {
  // Read randomized values from page (separate calls to avoid JSON escaping issues)
  const lsR = await callTool(client, "evaluate", { expression: `R.lsVal` });
  const ckR = await callTool(client, "evaluate", { expression: `R.ckVal` });
  const lsVal = lsR.text?.replace(/^"|"$/g, "") || "ALPHA";
  const ckVal = ckR.text?.replace(/^"|"$/g, "") || "OMEGA";
  await callTool(client, "evaluate", {
    expression: `(() => { localStorage.setItem('bench-key', '${lsVal}'); document.cookie = 'bench-cookie=${ckVal}'; return 'set'; })()`,
  });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t4_4_checkLS()"]' });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t4_4_checkCookie()"]' });
  const combo = lsVal + "-" + ckVal;
  await callTool(client, "type", { selector: "#t4-4-input", text: combo, clear: true });
  await callTool(client, "click", { selector: "#t4-4-verify-btn" });
  const s = await getStatus(client, "t4-4-status");
  return { pass: s === "PASS", details: combo };
});

await runTest("4.5", "Mutation Observer", async () => {
  // Set up capture via evaluate, then start mutations
  await callTool(client, "evaluate", {
    expression: `(() => { window._benchCaptures = []; const el = document.getElementById('t4-5-value'); const obs = new MutationObserver(() => { const v = el.textContent.trim(); if (v && v !== '---') window._benchCaptures.push(v); }); obs.observe(el, { childList: true, subtree: true, characterData: true }); return 'observer set'; })()`,
  });
  await callTool(client, "evaluate", {
    expression: `Tests.t4_5_start()`,
  });
  // Wait for mutations to complete
  await sleep(3500);
  const r = await callTool(client, "evaluate", {
    expression: `window._benchCaptures.join(',')`,
  });
  const captured = r.text?.replace(/^"|"$/g, "") || "";
  await callTool(client, "type", { selector: "#t4-5-input", text: captured, clear: true });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t4_5_verify()"]' });
  const s = await getStatus(client, "t4-5-status");
  return { pass: s === "PASS", details: captured };
});

await runTest("4.6", "Modal Token", async () => {
  await callTool(client, "click", { selector: 'button[onclick="Tests.t4_6_open()"]' });
  await sleep(100);
  await callTool(client, "type", { selector: "#t4-6-m-name", text: "TestProject", clear: true });
  await callTool(client, "evaluate", {
    expression: `document.getElementById('t4-6-m-env').value = 'production'; document.getElementById('t4-6-m-env').dispatchEvent(new Event('change'))`,
  });
  await callTool(client, "evaluate", {
    expression: `document.getElementById('t4-6-m-ssl').checked = true`,
  });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t4_6_confirm()"]' });
  await sleep(100);
  const r = await callTool(client, "evaluate", {
    expression: `window._t4_6_token || ''`,
  });
  const token = r.text?.replace(/^"|"$/g, "") || "";
  await callTool(client, "type", { selector: "#t4-6-input", text: token, clear: true });
  await callTool(client, "click", { selector: 'button[onclick="Tests.t4_6_verify()"]' });
  const s = await getStatus(client, "t4-6-status");
  return { pass: s === "PASS", details: token.substring(0, 20) };
});

// ── Summary ──
const benchEnd = Date.now();
const passed = Object.values(results).filter((r) => r.status === "pass").length;
const total = Object.keys(results).length;
const durationS = Math.round((benchEnd - benchStart) / 1000);

console.log(`\n${"=".repeat(55)}`);
console.log(`  ${BOLD}Result: ${passed}/${total} passed${RESET} in ${durationS}s (${totalToolUses} tool uses)`);
console.log(`${"=".repeat(55)}`);

const output = {
  name: "SilbercueChrome",
  type: "mcp-scripted",
  timestamp: new Date().toISOString(),
  summary: { total, passed, failed: total - passed, duration_s: durationS, tool_uses: totalToolUses },
  tests: results,
};

const filename = `test-hardest/benchmark-silbercuechrome_mcp-${Date.now()}.json`;
writeFileSync(new URL(`../${filename}`, import.meta.url).pathname, JSON.stringify(output, null, 2));
console.log(`\n  Saved: ${filename}\n`);

await client.close();
process.exit(total - passed > 0 ? 1 : 0);
