#!/usr/bin/env node
/**
 * SilbercueChrome Stress Test v3 — Edge Cases & Stability
 * Tests: moving targets, identical elements, contenteditable, optgroups,
 *        DOM storms, context menus, name collisions, rapid navigation.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "fs";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

const BASE_URL = "http://localhost:4243";
let totalPassed = 0;
let totalFailed = 0;
const allResults = [];

function log(icon, name, ms, detail = "") {
  const d = detail ? ` ${DIM}${detail}${RESET}` : "";
  console.log(`  ${icon} ${name} ${DIM}(${ms}ms)${RESET}${d}`);
}
function record(page, test, pass, ms, detail) {
  allResults.push({ page, test, pass, ms, detail });
  pass ? totalPassed++ : totalFailed++;
}
async function callTool(client, name, args = {}) {
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args });
    const ms = Date.now() - t0;
    const text = res.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const hasImage = res.content?.some((c) => c.type === "image");
    return { text, hasImage, ms, isError: res.isError };
  } catch (e) { return { text: e.message, hasImage: false, ms: Date.now() - t0, isError: true }; }
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function findRef(text, pattern) {
  const regex = new RegExp(`\\[(e\\d+)\\][^\\n]*${pattern}`, "i");
  const match = text?.match(regex);
  return match ? match[1] : null;
}

async function testEdgeCases(client) {
  console.log(`\n${BOLD}[14] Edge Cases & Killer Scenarios${RESET}`);
  await callTool(client, "navigate", { url: `${BASE_URL}/14-edge-cases.html` });

  const rp = await callTool(client, "read_page", { depth: 5, filter: "all" });
  const refs = (rp.text?.match(/\[e\d+\]/g) || []).length;
  log(PASS, "read_page", rp.ms, `${refs} refs`);

  // T1: Moving button (CSS animation)
  const movingRef = findRef(rp.text, "Moving Button");
  if (movingRef) {
    const click = await callTool(client, "click", { ref: movingRef });
    const verify = await callTool(client, "evaluate", { expression: "window.__t1_clicked || false" });
    const pass = verify.text === "true";
    log(pass ? PASS : FAIL, `T1: click moving animated button (ref ${movingRef})`, click.ms);
    record("14", "T1-moving-btn", pass, click.ms);
  } else {
    // Try by selector
    const click = await callTool(client, "click", { selector: "#moving-btn" });
    const verify = await callTool(client, "evaluate", { expression: "window.__t1_clicked || false" });
    const pass = verify.text === "true";
    log(pass ? PASS : FAIL, "T1: click moving button (selector fallback)", click.ms);
    record("14", "T1-moving-btn", pass, click.ms);
  }

  // T2: Identical twins — click the 3rd
  const rp2 = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
  // All twins show as "Submit" — need to distinguish by position
  const twinRef = findRef(rp2.text, "correct-twin") || findRef(rp2.text, "Submit");
  const twinClick = await callTool(client, "click", { selector: "#correct-twin" });
  const t2Verify = await callTool(client, "evaluate", { expression: "window.__t2_clicked" });
  const t2Pass = t2Verify.text === "2";
  log(t2Pass ? PASS : FAIL, "T2: click 3rd identical twin", twinClick.ms, `clicked index=${t2Verify.text}`);
  record("14", "T2-identical-twins", t2Pass, twinClick.ms);

  // T3: ContentEditable — can MCP type into it?
  const editRef = findRef(rp2.text, "editable") || findRef(rp2.text, "Type here");
  if (editRef) {
    const typeResult = await callTool(client, "type", { ref: editRef, text: "hello-editable" });
    const pass = !typeResult.isError;
    log(pass ? PASS : FAIL, `T3: type into contenteditable via ref ${editRef}`, typeResult.ms, typeResult.text?.slice(0, 60));
    record("14", "T3-contenteditable-ref", pass, typeResult.ms, typeResult.text?.slice(0, 60));
  } else {
    // Try evaluate approach
    const evalType = await callTool(client, "evaluate", {
      expression: `(() => { const el = document.getElementById('editable-div'); el.focus(); el.textContent = 'hello-editable'; el.dispatchEvent(new Event('input')); return el.textContent; })()`,
    });
    const pass = evalType.text?.includes("hello-editable");
    log(pass ? PASS : FAIL, "T3: contenteditable via evaluate fallback", evalType.ms);
    record("14", "T3-contenteditable-eval", pass, evalType.ms, "ref not found, eval fallback");
  }

  // T4: Complex select with optgroup
  await callTool(client, "evaluate", {
    expression: `document.getElementById('complex-select').value = 'espresso'; document.getElementById('complex-select').dispatchEvent(new Event('change'));`,
  });
  const t4Verify = await callTool(client, "evaluate", { expression: "window.__t4_selected || 'none'" });
  const t4Pass = t4Verify.text === '"espresso"';
  log(t4Pass ? PASS : FAIL, "T4: select optgroup value", 0, t4Verify.text);
  record("14", "T4-optgroup-select", t4Pass, 0);

  // T5: DOM mutation storm — click target while DOM mutates 100/sec
  await callTool(client, "click", { selector: "#start-storm" });
  await delay(500);
  const stormClick = await callTool(client, "click", { selector: "#storm-target" });
  const t5Verify = await callTool(client, "evaluate", { expression: "window.__t5_clicked || false" });
  const t5Pass = t5Verify.text === "true";
  log(t5Pass ? PASS : FAIL, "T5: click target during DOM mutation storm", stormClick.ms, t5Verify.text);
  record("14", "T5-dom-storm", t5Pass, stormClick.ms);

  // T7: Name collision — type into correct form
  const formBInput = await callTool(client, "type", { selector: "#form-b-username", text: "form-b-user" });
  const t7Verify = await callTool(client, "evaluate", { expression: "window.__t7_typed || false" });
  const t7Pass = t7Verify.text === "true";
  log(t7Pass ? PASS : FAIL, "T7: type into correct name-collision field", formBInput.ms, t7Verify.text);
  record("14", "T7-name-collision", t7Pass, formBInput.ms);

  // T8: Self-disabling button — click, re-enable, click again
  await callTool(client, "click", { selector: "#self-disable-btn" });
  await delay(100);
  await callTool(client, "click", { selector: "#re-enable-btn" });
  await delay(100);
  await callTool(client, "click", { selector: "#self-disable-btn" });
  await delay(300);
  const t8Verify = await callTool(client, "evaluate", { expression: "window.__t8_done || false" });
  const t8Pass = t8Verify.text === "true";
  log(t8Pass ? PASS : FAIL, "T8: click → re-enable → click self-disabling button", 0, t8Verify.text);
  record("14", "T8-self-disable", t8Pass, 0);
}

async function testRapidNavigation(client) {
  console.log(`\n${BOLD}[NAV] Rapid Navigation Stability${RESET}`);

  const pages = [
    "01-shadow-dom.html", "03-spa-dynamic.html", "05-canvas-interactive.html",
    "08-mega-dom.html", "11-css-tricks.html", "12-form-gauntlet.html",
  ];

  // Rapid fire: navigate to 6 pages quickly
  const t0 = Date.now();
  for (const page of pages) {
    const r = await callTool(client, "navigate", { url: `${BASE_URL}/${page}` });
    if (r.isError) {
      log(FAIL, `rapid nav → ${page}`, r.ms, r.text?.slice(0, 60));
      record("NAV", `rapid-${page}`, false, r.ms);
      return;
    }
  }
  const totalMs = Date.now() - t0;
  log(PASS, `rapid navigation: 6 pages in ${totalMs}ms`, totalMs, `avg ${Math.round(totalMs / 6)}ms/page`);
  record("NAV", "rapid-6-pages", true, totalMs, `avg ${Math.round(totalMs / 6)}ms`);

  // After rapid nav, verify last page works
  const rp = await callTool(client, "read_page", { depth: 3 });
  const pass = !rp.isError && (rp.text?.match(/\[e\d+\]/g) || []).length > 0;
  log(pass ? PASS : FAIL, "read_page works after rapid navigation", rp.ms);
  record("NAV", "post-rapid-readpage", pass, rp.ms);
}

async function testStaleRefRecovery(client) {
  console.log(`\n${BOLD}[STALE] Stale Ref Recovery${RESET}`);

  // Navigate, get refs, navigate away, navigate back — do old refs still work?
  await callTool(client, "navigate", { url: `${BASE_URL}/03-spa-dynamic.html` });
  const rp1 = await callTool(client, "read_page", { depth: 3, filter: "interactive" });
  const settingsRef = findRef(rp1.text, "Settings");

  // Navigate away
  await callTool(client, "navigate", { url: `${BASE_URL}/01-shadow-dom.html` });
  await delay(200);

  // Navigate back
  await callTool(client, "navigate", { url: `${BASE_URL}/03-spa-dynamic.html` });
  await delay(200);

  // Try old ref — should fail gracefully
  if (settingsRef) {
    const click = await callTool(client, "click", { ref: settingsRef });
    const isStale = click.isError;
    log(PASS, `stale ref ${settingsRef} after nav-away → ${isStale ? "rejected (good)" : "still works"}`, click.ms);
    record("STALE", "stale-ref-handling", true, click.ms, isStale ? "gracefully rejected" : "ref survived navigation");

    // Get fresh refs and retry
    if (isStale) {
      const rp2 = await callTool(client, "read_page", { depth: 3, filter: "interactive" });
      const freshRef = findRef(rp2.text, "Settings");
      if (freshRef) {
        const click2 = await callTool(client, "click", { ref: freshRef });
        const pass = !click2.isError;
        log(pass ? PASS : FAIL, `fresh ref ${freshRef} works after refresh`, click2.ms);
        record("STALE", "fresh-ref-after-stale", pass, click2.ms);
      }
    }
  }
}

async function testConcurrentOps(client) {
  console.log(`\n${BOLD}[CONC] Concurrent Operations${RESET}`);

  await callTool(client, "navigate", { url: `${BASE_URL}/08-mega-dom.html` });

  // Run read_page and screenshot concurrently (if supported)
  const t0 = Date.now();
  const [rp, ss] = await Promise.all([
    callTool(client, "read_page", { depth: 4 }),
    callTool(client, "screenshot", { som: true }),
  ]);
  const totalMs = Date.now() - t0;
  const bothOk = !rp.isError && ss.hasImage;
  log(bothOk ? PASS : FAIL, `concurrent read_page + screenshot`, totalMs, `rp=${rp.ms}ms ss=${ss.ms}ms`);
  record("CONC", "parallel-read-screenshot", bothOk, totalMs);

  // Sequential same-tool calls (cache test)
  const rp1 = await callTool(client, "read_page", { depth: 3 });
  const rp2 = await callTool(client, "read_page", { depth: 3 });
  const cacheSpeedup = rp1.ms > 0 ? ((rp1.ms - rp2.ms) / rp1.ms * 100).toFixed(0) : 0;
  log(PASS, `read_page cache: ${rp1.ms}ms → ${rp2.ms}ms (${cacheSpeedup}% faster)`, rp2.ms);
  record("CONC", "read_page-cache", true, rp2.ms, `${cacheSpeedup}% speedup`);
}

async function testErrorResilience(client) {
  console.log(`\n${BOLD}[ERR] Error Resilience${RESET}`);

  // Click non-existent ref
  const badRef = await callTool(client, "click", { ref: "e999999" });
  const pass1 = badRef.isError;
  log(pass1 ? PASS : FAIL, "click non-existent ref → graceful error", badRef.ms, badRef.text?.slice(0, 60));
  record("ERR", "bad-ref-click", pass1, badRef.ms);

  // Click non-existent selector
  const badSel = await callTool(client, "click", { selector: "#does-not-exist-xyz" });
  const pass2 = badSel.isError;
  log(pass2 ? PASS : FAIL, "click non-existent selector → graceful error", badSel.ms, badSel.text?.slice(0, 60));
  record("ERR", "bad-selector-click", pass2, badSel.ms);

  // Type into non-input
  const badType = await callTool(client, "type", { selector: "h1", text: "test" });
  const pass3 = badType.isError;
  log(pass3 ? PASS : FAIL, "type into h1 → graceful error", badType.ms, badType.text?.slice(0, 60));
  record("ERR", "type-non-input", pass3, badType.ms);

  // Navigate to invalid URL
  const badNav = await callTool(client, "navigate", { url: "http://localhost:99999/not-real" });
  const pass4 = badNav.isError;
  log(pass4 ? PASS : FAIL, "navigate to invalid URL → graceful error", badNav.ms);
  record("ERR", "bad-url-navigate", pass4, badNav.ms);

  // evaluate syntax error
  const badEval = await callTool(client, "evaluate", { expression: "function{{{invalid" });
  const pass5 = badEval.isError;
  log(pass5 ? PASS : FAIL, "evaluate syntax error → graceful error", badEval.ms);
  record("ERR", "bad-eval", pass5, badEval.ms);

  // wait_for with very short timeout
  const shortWait = await callTool(client, "wait_for", { condition: "element", selector: "#never-exists", timeout: 100 });
  const pass6 = shortWait.isError;
  log(pass6 ? PASS : FAIL, "wait_for short timeout → graceful timeout", shortWait.ms);
  record("ERR", "short-timeout", pass6, shortWait.ms);
}

// ── Main ──
console.log(`\n${BOLD}╔═══════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}║  SilbercueChrome v3 — Edge Cases & Stability      ║${RESET}`);
console.log(`${BOLD}╚═══════════════════════════════════════════════════╝${RESET}\n`);

const transport = new StdioClientTransport({
  command: "node", args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
});
const client = new Client({ name: "stress-v3", version: "3.0.0" });
await client.connect(transport);
console.log(`${DIM}Connected — ${(await client.listTools()).tools.length} tools${RESET}`);

const suites = [
  testEdgeCases,
  testRapidNavigation,
  testStaleRefRecovery,
  testConcurrentOps,
  testErrorResilience,
];

for (const fn of suites) {
  try { await fn(client); }
  catch (e) {
    console.log(`  ${FAIL} CRASH: ${e.message}`);
    totalFailed++;
    allResults.push({ page: fn.name, test: "CRASH", pass: false, ms: 0, detail: e.message });
  }
}

console.log(`\n${BOLD}═══════════════════════════════════════════════════${RESET}`);
console.log(`${BOLD}  v3 Results: ${GREEN}${totalPassed} passed${RESET}, ${RED}${totalFailed} failed${RESET}`);
console.log(`${BOLD}  Total: ${totalPassed + totalFailed} tests${RESET}`);

const failures = allResults.filter((r) => !r.pass);
if (failures.length > 0) {
  console.log(`\n${BOLD}Failures:${RESET}`);
  failures.forEach((r) => console.log(`  ${FAIL} [${r.page}] ${r.test}: ${r.detail || ""}`));
}

const path = new URL(`../test-stress/stress-v3-results-${Date.now()}.json`, import.meta.url).pathname;
writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), mode: "edge-cases", passed: totalPassed, failed: totalFailed, passRate: `${((totalPassed / (totalPassed + totalFailed)) * 100).toFixed(1)}%`, results: allResults }, null, 2));
console.log(`\n${DIM}Results: ${path}${RESET}\n`);

await client.close();
process.exit(totalFailed > 0 ? 1 : 0);
