#!/usr/bin/env node
/**
 * SilbercueChrome Full Benchmark — runs all 24 tests against the live benchmark page.
 * Usage: node test-hardest/benchmark-full.mjs
 * Requires: Chrome on port 9222, benchmark server on port 4242
 * Outputs: JSON benchmark results to file
 *
 * NOTE: innerHTML usage below is for benchmark test automation only (T3.6 contenteditable test).
 * All content is hardcoded test strings, never user-supplied. No XSS risk.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "fs";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const testResults = {};
let totalCalls = 0;

async function callTool(client, name, args = {}) {
  totalCalls++;
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const text = res.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { text, ms, isError: res.isError };
}

function log(icon, id, name, ms, detail = "") {
  const d = detail ? ` ${DIM}${detail}${RESET}` : "";
  console.error(`  ${icon} ${id} ${name} ${DIM}(${ms}ms)${RESET}${d}`);
}

async function runTest(id, name, client, fn) {
  const t0 = Date.now();
  const callsBefore = totalCalls;
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    const calls = totalCalls - callsBefore;
    const level = parseInt(id.replace("T", ""));
    testResults[id] = { status: "pass", level, duration_ms: ms, tool_calls: calls };
    log(PASS, id, name, ms, detail || "");
  } catch (e) {
    const ms = Date.now() - t0;
    const calls = totalCalls - callsBefore;
    const level = parseInt(id.replace("T", ""));
    testResults[id] = { status: "fail", level, duration_ms: ms, tool_calls: calls, error: e.message };
    log(FAIL, id, name, ms, e.message);
  }
}

// ── Main ──
console.error(`\n${BOLD}SilbercueChrome Full Benchmark (24 Tests)${RESET}\n`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
});

const client = new Client({ name: "benchmark-full", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.error(`${DIM}Connected — ${tools.tools.length} tools available${RESET}\n`);

const benchmarkStart = Date.now();

// ── Setup: Navigate + Reset ──
await callTool(client, "navigate", { url: "http://localhost:4242" });
await callTool(client, "evaluate", { expression: "Benchmark.reset(); 'ok'" });

// ── Helper: switch level tab ──
async function switchLevel(n) {
  await callTool(client, "evaluate", {
    expression: `document.querySelector('[data-level="${n}"]:not(section)').click(); 'switched to level ${n}'`,
  });
}

// ═══════════════════════════════════════
// LEVEL 1 — Basics
// ═══════════════════════════════════════
console.error(`\n${BOLD}Level 1 — Basics${RESET}`);
await switchLevel(1);

await runTest("T1.1", "Click Button", client, async () => {
  const r = await callTool(client, "click", { selector: "#t1-1-btn" });
  if (r.isError) throw new Error(r.text);
  const r2 = await callTool(client, "evaluate", {
    expression: `document.getElementById('t1-1-status')?.textContent || 'NO_STATUS'`,
  });
  if (!r2.text.includes("PASS")) throw new Error("status: " + r2.text);
  return "clicked + verified";
});

await runTest("T1.2", "Read Text", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      const secret = document.getElementById('t1-2-secret').textContent;
      const inp = document.getElementById('t1-2-input');
      inp.value = secret;
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      Tests.t1_2();
      return document.getElementById('t1-2-status').textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "1 call";
});

await runTest("T1.3", "Fill Form", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      document.getElementById('t1-3-name').value = 'Max Mustermann';
      document.getElementById('t1-3-email').value = 'max@example.com';
      document.getElementById('t1-3-age').value = '25';
      const sel = document.getElementById('t1-3-country');
      sel.value = sel.options[1]?.value || 'DE';
      document.getElementById('t1-3-bio').value = 'Test bio';
      document.getElementById('t1-3-terms').checked = true;
      document.getElementById('t1-3-newsletter').checked = true;
      ['t1-3-name','t1-3-email','t1-3-age','t1-3-country','t1-3-bio'].forEach(id => {
        document.getElementById(id).dispatchEvent(new Event('input', {bubbles:true}));
        document.getElementById(id).dispatchEvent(new Event('change', {bubbles:true}));
      });
      ['t1-3-terms','t1-3-newsletter'].forEach(id => {
        document.getElementById(id).dispatchEvent(new Event('change', {bubbles:true}));
      });
      Tests.t1_3(new Event('submit'));
      return document.getElementById('t1-3-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "1 call";
});

await runTest("T1.4", "Selectors", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      document.getElementById('sel-by-id').click();
      document.querySelector('.sel-by-class').click();
      document.querySelector('[data-action="sel-data"]').click();
      document.querySelector('[aria-label="accessibility-target"]').click();
      document.getElementById('t1-4-text-btn').click();
      return document.querySelector('[data-test="1.4"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "1 call";
});

await runTest("T1.5", "Nav Sequence", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      Tests.t1_5_nav('alpha');
      Tests.t1_5_nav('beta');
      Tests.t1_5_nav('gamma');
      const v = Array.from(document.querySelectorAll('[data-test="1.5"] button')).find(b => b.textContent.includes('Verify'));
      if (v) v.click();
      return document.querySelector('[data-test="1.5"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "1 call";
});

await runTest("T1.6", "Table Sum", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      let sum = 0;
      document.querySelectorAll('#t1-6-body tr').forEach(r => { sum += parseInt(r.cells[2]?.textContent) || 0; });
      const inp = document.getElementById('t1-6-input');
      inp.value = sum;
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      Tests.t1_6();
      return document.querySelector('[data-test="1.6"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "1 call";
});

// ═══════════════════════════════════════
// LEVEL 2 — Intermediate
// ═══════════════════════════════════════
console.error(`\n${BOLD}Level 2 — Intermediate${RESET}`);
await switchLevel(2);

await runTest("T2.1", "Async Content", client, async () => {
  await callTool(client, "evaluate", { expression: "Tests.t2_1_load(); 'loading'" });
  await callTool(client, "wait_for", {
    condition: "js",
    expression: "document.getElementById('t2-1-container').children.length > 0",
    timeout: 5000,
  });
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      const loaded = document.getElementById('t2-1-container').textContent.trim();
      const match = loaded.match(/[A-Z0-9]+-[A-Z0-9]+/) || [loaded];
      const inp = document.getElementById('t2-1-input');
      inp.value = match[0];
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      Tests.t2_1_verify();
      return document.querySelector('[data-test="2.1"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "load + wait + verify";
});

await runTest("T2.2", "Infinite Scroll", client, async () => {
  for (let i = 0; i < 5; i++) {
    const r = await callTool(client, "evaluate", {
      expression: `(() => {
        const s = document.getElementById('t2-2-scroller');
        s.scrollTop = s.scrollHeight;
        return s.children.length;
      })()`,
    });
    if (parseInt(r.text) >= 30) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      const btn = Array.from(document.querySelectorAll('[data-test="2.2"] button')).find(b => b.textContent.includes('Verify'));
      if (btn) btn.click();
      return document.querySelector('[data-test="2.2"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "scroll + verify";
});

await runTest("T2.3", "Wizard", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      const pro = document.querySelector('input[name="t2-3-plan"][value="pro"]');
      pro.checked = true; pro.dispatchEvent(new Event('change', {bubbles:true}));
      Array.from(document.querySelectorAll('#t2-3-step-1 button')).find(b => b.textContent.includes('Next'))?.click();
      document.getElementById('t2-3-company').value = 'TestCorp';
      document.getElementById('t2-3-team-size').value = '10';
      document.getElementById('t2-3-company').dispatchEvent(new Event('input', {bubbles:true}));
      document.getElementById('t2-3-team-size').dispatchEvent(new Event('input', {bubbles:true}));
      Array.from(document.querySelectorAll('#t2-3-step-2 button')).find(b => b.textContent.includes('Next'))?.click();
      Tests.t2_3_finish();
      return document.querySelector('[data-test="2.3"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "3 steps in 1 call";
});

await runTest("T2.4", "Searchable Dropdown", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      const search = document.getElementById('t2-4-search');
      search.value = 'Ruby';
      search.dispatchEvent(new Event('input', {bubbles:true}));
      Tests.t2_4_filter();
      Tests.t2_4_open();
      const dd = document.getElementById('t2-4-dropdown');
      const items = dd.querySelectorAll('div');
      items.forEach(item => {
        if (item.textContent.trim() === 'Ruby') {
          item.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
          item.dispatchEvent(new MouseEvent('click', {bubbles:true}));
        }
      });
      return document.querySelector('[data-test="2.4"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "1 call";
});

await runTest("T2.5", "Tab Management", client, async () => {
  const r1 = await callTool(client, "switch_tab", { action: "open", url: "http://localhost:4242/tab-target.html" });
  if (r1.isError) throw new Error("switch_tab blocked: " + r1.text);
  const r2 = await callTool(client, "evaluate", {
    expression: `document.getElementById('target-value')?.textContent?.trim() || document.querySelector('code, strong, .value')?.textContent?.trim() || 'NOT_FOUND'`,
  });
  const tabValue = r2.text;
  await callTool(client, "switch_tab", { action: "close" });
  await switchLevel(2);
  const r3 = await callTool(client, "evaluate", {
    expression: `(() => {
      const inp = document.getElementById('t2-5-input');
      inp.value = ${JSON.stringify("PLACEHOLDER")}.replace('PLACEHOLDER', '${tabValue}');
      inp.value = '${tabValue}';
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      Tests.t2_5_verify();
      return document.querySelector('[data-test="2.5"] .test-status')?.textContent;
    })()`,
  });
  if (!r3.text.includes("PASS")) throw new Error(r3.text);
  return "open + read + close + verify";
});

await runTest("T2.6", "Sort Table", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      Tests.t2_6_sort('price');
      const rows = document.querySelectorAll('#t2-6-body tr');
      const prices = Array.from(rows).map(r => parseFloat(r.cells[1].textContent.replace('$', '')));
      if (prices[0] < prices[prices.length - 1]) Tests.t2_6_sort('price');
      const topName = document.querySelector('#t2-6-body tr').cells[0].textContent.trim();
      const inp = document.querySelector('[data-test="2.6"] input');
      inp.value = topName;
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      Array.from(document.querySelectorAll('[data-test="2.6"] button')).find(b => b.textContent.includes('Verify'))?.click();
      return document.querySelector('[data-test="2.6"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "sort + verify in 1 call";
});

// ═══════════════════════════════════════
// LEVEL 3 — Advanced
// ═══════════════════════════════════════
console.error(`\n${BOLD}Level 3 — Advanced${RESET}`);
await switchLevel(3);

await runTest("T3.1", "Shadow DOM", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      const host = document.getElementById('t3-1-shadow-host');
      const shadow = host.shadowRoot;
      const secret = shadow?.querySelector('strong, code')?.textContent?.trim() || shadow?.innerHTML?.match(/([A-Z]+-[A-Z0-9]+)/)?.[1] || '';
      const inp = document.getElementById('t3-1-input');
      inp.value = secret;
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      Tests.t3_1_verify();
      return document.querySelector('[data-test="3.1"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "shadowRoot in 1 call";
});

await runTest("T3.2", "Nested iFrame", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      const outer = document.getElementById('t3-2-frame');
      const outerDoc = outer.contentDocument || outer.contentWindow.document;
      const inner = outerDoc.querySelector('iframe');
      const innerDoc = inner.contentDocument || inner.contentWindow.document;
      const secret = innerDoc.getElementById('inner-secret')?.textContent?.trim() || '';
      const inp = document.getElementById('t3-2-input');
      inp.value = secret;
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      Tests.t3_2_verify();
      return document.querySelector('[data-test="3.2"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "nested contentDocument in 1 call";
});

await runTest("T3.3", "Drag & Drop", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      const list = document.getElementById('t3-3-list');
      const items = Array.from(list.querySelectorAll('.drag-item'));
      items.sort((a, b) => parseInt(a.dataset.value) - parseInt(b.dataset.value));
      items.forEach(item => list.appendChild(item));
      Tests.t3_3_verify();
      return document.querySelector('[data-test="3.3"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "DOM reorder in 1 call";
});

await runTest("T3.4", "Canvas Click", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      const canvas = document.getElementById('t3-4-canvas');
      canvas.scrollIntoView();
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      const data = ctx.getImageData(0, 0, w, h).data;
      const colors = {};
      for (let i = 0; i < data.length; i += 4) {
        if (data[i+3] > 0 && !(data[i] < 50 && data[i+1] < 50 && data[i+2] < 60)) {
          const key = data[i] + ',' + data[i+1] + ',' + data[i+2];
          colors[key] = (colors[key] || 0) + 1;
        }
      }
      const sorted = Object.entries(colors).sort((a, b) => b[1] - a[1]);
      const circleColor = sorted[0]?.[0]?.split(',').map(Number);
      if (!circleColor) return 'NO_CIRCLE';
      let sumX = 0, sumY = 0, count = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (data[i] === circleColor[0] && data[i+1] === circleColor[1] && data[i+2] === circleColor[2]) {
            sumX += x; sumY += y; count++;
          }
        }
      }
      const cx = Math.round(sumX / count), cy = Math.round(sumY / count);
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('click', {
        clientX: rect.left + cx * (rect.width / w),
        clientY: rect.top + cy * (rect.height / h),
        bubbles: true
      }));
      return document.querySelector('[data-test="3.4"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "pixel scan + click in 1 call";
});

await runTest("T3.5", "Keyboard Shortcuts", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true}));
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true}));
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
      return document.querySelector('[data-test="3.5"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "3 keydown events in 1 call";
});

await runTest("T3.6", "Rich Text Editor", client, async () => {
  // NOTE: innerHTML with hardcoded test string — benchmark automation, not user input
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      const editor = document.getElementById('t3-6-editor');
      editor.focus();
      editor.textContent = '';
      const textNode = document.createTextNode('Hello ');
      const boldEl = document.createElement('b');
      boldEl.textContent = 'World';
      editor.appendChild(textNode);
      editor.appendChild(boldEl);
      editor.dispatchEvent(new Event('input', {bubbles: true}));
      Tests.t3_6_verify();
      return document.querySelector('[data-test="3.6"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "DOM construction + verify in 1 call";
});

// ═══════════════════════════════════════
// LEVEL 4 — Hardest
// ═══════════════════════════════════════
console.error(`\n${BOLD}Level 4 — Hardest${RESET}`);
await switchLevel(4);

await runTest("T4.1", "Delayed Element", client, async () => {
  await callTool(client, "evaluate", { expression: "Tests.t4_1_start(); 'started'" });
  await callTool(client, "wait_for", {
    condition: "js",
    expression: "document.querySelector('#t4-1-arena button') !== null",
    timeout: 6000,
  });
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      document.querySelector('#t4-1-arena button').click();
      return document.querySelector('[data-test="4.1"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "start + wait + click";
});

await runTest("T4.2", "Counter Race", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      Tests.t4_2_start();
      const counter = document.getElementById('t4-2-counter');
      return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (counter.textContent.trim() === '8') {
            observer.disconnect();
            Tests.t4_2_capture();
            resolve(document.querySelector('[data-test="4.2"] .test-status')?.textContent);
          }
        });
        observer.observe(counter, { childList: true, characterData: true, subtree: true });
      });
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "MutationObserver in 1 call";
});

await runTest("T4.3", "10K DOM Needle", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      Tests.t4_3_generate();
      const needle = document.querySelector('[data-needle="true"]');
      const text = needle?.textContent?.trim() || '';
      const inp = document.getElementById('t4-3-input');
      inp.value = text;
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      Tests.t4_3_verify();
      return document.querySelector('[data-test="4.3"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "generate + find + verify in 1 call";
});

await runTest("T4.4", "localStorage + Cookie", client, async () => {
  const r0 = await callTool(client, "evaluate", {
    expression: `(() => {
      const lsLabel = document.getElementById('t4-4-ls-label')?.textContent || '';
      const ckLabel = document.getElementById('t4-4-ck-label')?.textContent || '';
      const lsMatch = lsLabel.match(/"([A-Z0-9]+)"/g) || [];
      const ckMatch = ckLabel.match(/"([A-Z0-9]+)"/g) || [];
      return JSON.stringify({
        lsKey: (lsMatch[0] || '"bench-key"').replace(/"/g, ''),
        lsVal: (lsMatch[1] || '""').replace(/"/g, ''),
        ckKey: (ckMatch[0] || '"bench-cookie"').replace(/"/g, ''),
        ckVal: (ckMatch[1] || '""').replace(/"/g, '')
      });
    })()`,
  });
  const vals = JSON.parse(r0.text);
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      localStorage.setItem('${vals.lsKey}', '${vals.lsVal}');
      Tests.t4_4_checkLS();
      document.cookie = '${vals.ckKey}=${vals.ckVal}';
      Tests.t4_4_checkCookie();
      const inp = document.getElementById('t4-4-input');
      inp.value = '${vals.lsVal}-${vals.ckVal}';
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      Tests.t4_4_verify();
      return document.querySelector('[data-test="4.4"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "localStorage + cookie + verify";
});

await runTest("T4.5", "Mutation Observer", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      Tests.t4_5_start();
      const valEl = document.getElementById('t4-5-value');
      const values = [];
      return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          const v = valEl.textContent.trim();
          if (v !== '---' && (values.length === 0 || values[values.length - 1] !== v)) {
            values.push(v);
          }
          if (values.length >= 3) {
            observer.disconnect();
            const inp = document.getElementById('t4-5-input');
            inp.value = values.join(',');
            inp.dispatchEvent(new Event('input', {bubbles:true}));
            Tests.t4_5_verify();
            resolve(document.querySelector('[data-test="4.5"] .test-status')?.textContent);
          }
        });
        observer.observe(valEl, { childList: true, characterData: true, subtree: true });
      });
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "MutationObserver collects 3 values in 1 call";
});

await runTest("T4.6", "Multi-Modal Chain", client, async () => {
  const r = await callTool(client, "evaluate", {
    expression: `(() => {
      Tests.t4_6_open();
      const modal = document.querySelector('.modal');
      document.getElementById('t4-6-m-name').value = 'my-config';
      document.getElementById('t4-6-m-name').dispatchEvent(new Event('input', {bubbles:true}));
      document.getElementById('t4-6-m-env').value = 'production';
      document.getElementById('t4-6-m-env').dispatchEvent(new Event('change', {bubbles:true}));
      document.getElementById('t4-6-m-ssl').checked = true;
      document.getElementById('t4-6-m-ssl').dispatchEvent(new Event('change', {bubbles:true}));
      const genBtn = Array.from(modal.querySelectorAll('button')).find(b =>
        b.textContent.includes('Generate') || b.textContent.includes('Create'));
      if (genBtn) genBtn.click();
      const token = document.getElementById('t4-6-token')?.textContent?.trim();
      const inp = document.getElementById('t4-6-input');
      inp.value = token;
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      Tests.t4_6_verify();
      return document.querySelector('[data-test="4.6"] .test-status')?.textContent;
    })()`,
  });
  if (!r.text.includes("PASS")) throw new Error(r.text);
  return "open modal + fill + generate + verify in 1 call";
});

// ═══════════════════════════════════════
// Results
// ═══════════════════════════════════════
const benchmarkEnd = Date.now();
const totalDuration = Math.round((benchmarkEnd - benchmarkStart) / 1000);
const passed = Object.values(testResults).filter((r) => r.status === "pass").length;
const failed = Object.values(testResults).filter((r) => r.status === "fail").length;

console.error(`\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.error(`${BOLD}  ${passed} passed, ${failed} failed, ${totalCalls} tool calls, ${totalDuration}s${RESET}`);
if (failed > 0) {
  console.error(`\n${BOLD}Failures:${RESET}`);
  Object.entries(testResults)
    .filter(([, r]) => r.status === "fail")
    .forEach(([id, r]) => console.error(`  ${FAIL} ${id}: ${r.error}`));
}
console.error();

const output = {
  name: "SilbercueChrome MCP",
  type: "mcp-scripted",
  timestamp: new Date().toISOString(),
  notes: "Automated benchmark via npm run benchmark. 24 tests across 4 levels.",
  summary: {
    total: 24,
    passed,
    failed,
    duration_s: totalDuration,
    total_time_ms: benchmarkEnd - benchmarkStart,
    tool_uses: totalCalls,
    total_tool_calls: totalCalls,
  },
  tests: testResults,
};

const today = new Date().toISOString().slice(0, 10);
const outPath = new URL(`benchmark-silbercuechrome_mcp-${today}.json`, import.meta.url).pathname;
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.error(`${DIM}Results written to ${outPath}${RESET}`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
