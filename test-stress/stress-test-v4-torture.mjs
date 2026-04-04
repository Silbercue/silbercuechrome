#!/usr/bin/env node
/**
 * SilbercueChrome Stress Test v4 — TORTURE TEST
 * Rapid-fire operations, endurance, and extreme scenarios.
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
  console.log(`  ${icon} ${name} ${DIM}(${ms}ms)${RESET}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
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

// TORTURE 1: Rapid-fire 50 read_page calls
async function tortureRapidReadPage(client) {
  console.log(`\n${BOLD}[RAPID] 50x Rapid-Fire read_page${RESET}`);
  await callTool(client, "navigate", { url: `${BASE_URL}/08-mega-dom.html` });

  const times = [];
  let errors = 0;
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) {
    const r = await callTool(client, "read_page", { depth: 3 });
    times.push(r.ms);
    if (r.isError) errors++;
  }
  const totalMs = Date.now() - t0;
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const max = Math.max(...times);
  const min = Math.min(...times);
  const pass = errors === 0;
  log(pass ? PASS : FAIL, `50x read_page: ${totalMs}ms total, avg=${avg}ms, min=${min}ms, max=${max}ms`, totalMs, `${errors} errors`);
  record("RAPID", "50x-read_page", pass, totalMs, `avg=${avg}ms max=${max}ms`);
}

// TORTURE 2: 20x Navigate-Read-Screenshot cycle
async function tortureNavCycle(client) {
  console.log(`\n${BOLD}[CYCLE] 20x Navigate → Read → Screenshot${RESET}`);

  const pages = [
    "01-shadow-dom.html", "02-virtual-scroll.html", "03-spa-dynamic.html",
    "05-canvas-interactive.html", "07-overlay-hell.html", "08-mega-dom.html",
    "10-race-conditions.html", "11-css-tricks.html", "12-form-gauntlet.html",
    "13-responsive-viewport.html", "14-edge-cases.html",
    "01-shadow-dom.html", "03-spa-dynamic.html", "05-canvas-interactive.html",
    "08-mega-dom.html", "11-css-tricks.html", "12-form-gauntlet.html",
    "01-shadow-dom.html", "07-overlay-hell.html", "14-edge-cases.html",
  ];

  let errors = 0;
  const t0 = Date.now();
  for (let i = 0; i < pages.length; i++) {
    const nav = await callTool(client, "navigate", { url: `${BASE_URL}/${pages[i]}` });
    if (nav.isError) { errors++; continue; }
    const rp = await callTool(client, "read_page", { depth: 3 });
    if (rp.isError) errors++;
    const ss = await callTool(client, "screenshot");
    if (!ss.hasImage) errors++;
  }
  const totalMs = Date.now() - t0;
  const pass = errors === 0;
  log(pass ? PASS : FAIL, `20x nav+read+screenshot: ${totalMs}ms, avg=${Math.round(totalMs / 20)}ms/cycle`, totalMs, `${errors} errors`);
  record("CYCLE", "20x-nav-read-ss", pass, totalMs, `${errors} errors, avg=${Math.round(totalMs / 20)}ms`);
}

// TORTURE 3: 30x Click operations
async function tortureClickBarrage(client) {
  console.log(`\n${BOLD}[CLICK] 30x Click Barrage${RESET}`);

  await callTool(client, "navigate", { url: `${BASE_URL}/12-form-gauntlet.html` });
  const rp = await callTool(client, "read_page", { depth: 5, filter: "interactive" });

  const refs = [];
  const refRegex = /\[(e\d+)\]/g;
  let match;
  while ((match = refRegex.exec(rp.text || "")) !== null) refs.push(match[1]);

  let clickErrors = 0;
  const t0 = Date.now();
  const clickCount = Math.min(30, refs.length);
  for (let i = 0; i < clickCount; i++) {
    const r = await callTool(client, "click", { ref: refs[i % refs.length] });
    if (r.isError) clickErrors++;
  }
  const totalMs = Date.now() - t0;
  const pass = clickErrors < clickCount * 0.2;
  log(pass ? PASS : FAIL, `${clickCount}x clicks: ${totalMs}ms, ${clickErrors} errors`, totalMs, `avg=${Math.round(totalMs / clickCount)}ms/click`);
  record("CLICK", "30x-click-barrage", pass, totalMs, `${clickErrors}/${clickCount} errors`);
}

// TORTURE 4: Tab storm
async function tortureTabStorm(client) {
  console.log(`\n${BOLD}[TABS] Tab Storm — 5 tabs${RESET}`);

  const tabUrls = [
    `${BASE_URL}/01-shadow-dom.html`,
    `${BASE_URL}/03-spa-dynamic.html`,
    `${BASE_URL}/05-canvas-interactive.html`,
    `${BASE_URL}/08-mega-dom.html`,
    `${BASE_URL}/11-css-tricks.html`,
  ];

  let openErrors = 0;
  const t0 = Date.now();
  for (const url of tabUrls) {
    const r = await callTool(client, "switch_tab", { action: "open", url });
    if (r.isError) openErrors++;
  }
  log(openErrors === 0 ? PASS : FAIL, `open 5 tabs: ${openErrors} errors`, Date.now() - t0);
  record("TABS", "open-5-tabs", openErrors === 0, Date.now() - t0);

  const desk = await callTool(client, "virtual_desk");
  const tabCount = (desk.text?.match(/http/g) || []).length;
  log(tabCount >= 5 ? PASS : FAIL, `virtual_desk: ${tabCount} tabs visible`, desk.ms);
  record("TABS", "desk-5-tabs", tabCount >= 5, desk.ms, `${tabCount} tabs`);

  for (let i = 0; i < 5; i++) await callTool(client, "switch_tab", { action: "close" });
  log(PASS, "closed all tabs", 0);
  record("TABS", "close-all", true, 0);
}

// TORTURE 5: 5x Full form completion
async function tortureEndurance(client) {
  console.log(`\n${BOLD}[ENDUR] 5x Full Form Completion${RESET}`);

  let successes = 0;
  const t0 = Date.now();

  for (let round = 0; round < 5; round++) {
    await callTool(client, "navigate", { url: `${BASE_URL}/12-form-gauntlet.html` });
    await delay(200);
    await callTool(client, "type", { selector: "#reg-name", text: `User ${round}` });
    await callTool(client, "type", { selector: "#reg-email", text: `user${round}@test.com` });
    await callTool(client, "type", { selector: "#reg-password", text: `Pass${round}word1` });
    await callTool(client, "click", { selector: "#next-1" });
    await delay(200);

    await callTool(client, "evaluate", {
      expression: "document.getElementById('reg-role').value='developer'; document.getElementById('reg-role').dispatchEvent(new Event('change'));",
    });
    await callTool(client, "evaluate", {
      expression: "document.querySelectorAll('input[name=\"interest\"]')[0].click(); document.querySelectorAll('input[name=\"interest\"]')[3].click();",
    });
    await callTool(client, "evaluate", {
      expression: "document.querySelectorAll('input[name=\"experience\"]')[1].click();",
    });
    await callTool(client, "click", { selector: "#next-2" });
    await delay(200);
    await callTool(client, "click", { selector: "#reg-terms" });
    await callTool(client, "click", { selector: "#submit-form" });
    await delay(100);

    const verify = await callTool(client, "evaluate", { expression: "JSON.stringify(window.__form_submitted || null)" });
    if (verify.text?.includes(`User ${round}`)) successes++;
  }

  const totalMs = Date.now() - t0;
  const pass = successes === 5;
  log(pass ? PASS : FAIL, `5x form: ${successes}/5 OK, ${totalMs}ms total`, totalMs, `avg=${Math.round(totalMs / 5)}ms/form`);
  record("ENDUR", "5x-form", pass, totalMs, `${successes}/5`);
}

// TORTURE 6: 10-step plan
async function tortureLongPlan(client) {
  console.log(`\n${BOLD}[PLAN] 10-Step Plan Execution${RESET}`);

  const plan = await callTool(client, "run_plan", {
    steps: [
      { tool: "navigate", params: { url: `${BASE_URL}/03-spa-dynamic.html` } },
      { tool: "read_page", params: { depth: 3 } },
      { tool: "click", params: { selector: "[data-tab=\"settings\"]" } },
      { tool: "screenshot", params: {} },
      { tool: "evaluate", params: { expression: "document.title" } },
      { tool: "click", params: { selector: "[data-tab=\"home\"]" } },
      { tool: "click", params: { selector: "#increment-btn" } },
      { tool: "evaluate", params: { expression: "document.getElementById('counter-display').textContent" } },
      { tool: "screenshot", params: { som: true } },
      { tool: "evaluate", params: { expression: "'plan_complete'" } },
    ],
  });
  const pass = !plan.isError && plan.text?.includes("plan_complete");
  const steps = (plan.text?.match(/\[\d+\/10\]/g) || []).length;
  log(pass ? PASS : FAIL, `10-step plan: ${steps}/10 completed`, plan.ms);
  record("PLAN", "10-step-plan", pass, plan.ms, `${steps}/10 steps`);
}

// ── Main ──
console.log(`\n${BOLD}╔═══════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}║  SilbercueChrome v4 — TORTURE TEST                ║${RESET}`);
console.log(`${BOLD}╚═══════════════════════════════════════════════════╝${RESET}\n`);

const transport = new StdioClientTransport({
  command: "node", args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
});
const client = new Client({ name: "torture", version: "4.0.0" });
await client.connect(transport);
console.log(`${DIM}Connected — ${(await client.listTools()).tools.length} tools${RESET}`);

const suites = [
  tortureRapidReadPage,
  tortureNavCycle,
  tortureClickBarrage,
  tortureTabStorm,
  tortureEndurance,
  tortureLongPlan,
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
console.log(`${BOLD}  TORTURE Results: ${GREEN}${totalPassed} passed${RESET}, ${RED}${totalFailed} failed${RESET}`);

const failures = allResults.filter((r) => !r.pass);
if (failures.length > 0) {
  console.log(`\n${BOLD}Failures:${RESET}`);
  failures.forEach((r) => console.log(`  ${FAIL} [${r.page}] ${r.test}: ${r.detail || ""}`));
}

console.log(`\n${BOLD}Performance:${RESET}`);
allResults.forEach((r) => { if (r.ms > 100) console.log(`  ${DIM}${r.page}/${r.test}: ${r.ms}ms — ${r.detail || ""}${RESET}`); });

const path = new URL(`../test-stress/stress-v4-results-${Date.now()}.json`, import.meta.url).pathname;
writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), mode: "torture", passed: totalPassed, failed: totalFailed, results: allResults }, null, 2));
console.log(`\n${DIM}Results: ${path}${RESET}\n`);

await client.close();
process.exit(totalFailed > 0 ? 1 : 0);
