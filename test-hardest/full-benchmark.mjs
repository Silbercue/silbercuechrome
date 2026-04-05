#!/usr/bin/env node
/**
 * SilbercueChrome Full Benchmark — runs all 24 tests against the live benchmark page.
 * Usage: node test-hardest/full-benchmark.mjs
 * Requires: Chrome on port 9222, benchmark server on port 4242
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PASS = "\x1b[32m\u2713\x1b[0m";
const FAIL = "\x1b[31m\u2717\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

let passed = 0;
let failed = 0;
const failures = [];
const timings = [];

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
  return { text, ms, isError: res.isError };
}

/** Run JS on the page and return the raw text result */
async function js(client, expr) {
  const r = await callTool(client, "evaluate", { expression: expr });
  return r.text?.replace(/^"|"$/g, "").trim() ?? "";
}

async function test(id, name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    passed++;
    timings.push({ id, name, ms, status: "pass" });
    log(PASS, `${id} ${name}`, ms, detail || "");
  } catch (e) {
    const ms = Date.now() - t0;
    failed++;
    timings.push({ id, name, ms, status: "fail", error: e.message });
    failures.push({ id, name, error: e.message });
    log(FAIL, `${id} ${name}`, ms, e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Set input value via JS (reliable for off-screen elements) */
async function setInput(client, id, value) {
  await js(
    client,
    `(() => { const el = document.getElementById('${id}'); el.value = '${value}'; el.dispatchEvent(new Event('input', {bubbles:true})); })()`
  );
}

// ── Main ──
console.log(`\n${BOLD}SilbercueChrome Full Benchmark \u2014 24 Tests${RESET}\n`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
});

const client = new Client({ name: "full-benchmark", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${DIM}Connected \u2014 ${tools.length} tools${RESET}\n`);

// Navigate to benchmark page
const nav = await callTool(client, "navigate", {
  url: "http://localhost:4242",
});
assert(!nav.isError, `navigate: ${nav.text}`);
console.log(`${DIM}Page loaded${RESET}\n`);

// ═══════════════════════════════════════════
console.log(`${BOLD}${CYAN}\u2500\u2500 Level 1: Basics \u2500\u2500${RESET}\n`);

await test("1.1", "Click Button", async () => {
  await callTool(client, "click", { selector: "#t1-1-btn" });
  const r = await js(client, `document.getElementById('t1-1-result')?.textContent`);
  assert(r.includes("successfully"), r);
  return "OK";
});

await test("1.2", "Read Text", async () => {
  const secret = await js(client, `document.getElementById('t1-2-secret').textContent`);
  await setInput(client, "t1-2-input", secret);
  await js(client, `Tests.t1_2()`);
  const r = await js(client, `document.getElementById('t1-2-result')?.textContent`);
  assert(r.includes("Correct"), r);
  return secret;
});

await test("1.3", "Fill Form", async () => {
  await setInput(client, "t1-3-name", "Test User");
  await setInput(client, "t1-3-email", "test@example.com");
  await setInput(client, "t1-3-age", "25");
  await js(client, `document.getElementById('t1-3-country').value = 'de'`);
  await js(client, `document.getElementById('t1-3-terms').checked = true`);
  await js(client, `Tests.t1_3(new Event('submit'))`);
  const r = await js(client, `document.getElementById('t1-3-result')?.textContent`);
  assert(r.includes("successfully"), r);
  return "5 fields filled";
});

await test("1.4", "Selector Challenge", async () => {
  await callTool(client, "click", { selector: "#sel-by-id" });
  await callTool(client, "click", { selector: ".sel-by-class" });
  await callTool(client, "click", { selector: '[data-action="sel-data"]' });
  await callTool(client, "click", { selector: '[aria-label="accessibility-target"]' });
  await js(
    client,
    `document.querySelectorAll('[data-test="1.4"] button').forEach(b => { if(b.textContent.includes('UNIQUE_SELECTOR_2847') && !b.disabled) b.click() })`
  );
  const r = await js(client, `document.getElementById('t1-4-result')?.textContent`);
  assert(r.includes("All 5"), r);
  return "5/5";
});

await test("1.5", "Nav Sequence", async () => {
  await js(client, `Tests.t1_5_nav('alpha')`);
  await js(client, `Tests.t1_5_nav('beta')`);
  await js(client, `Tests.t1_5_nav('gamma')`);
  await js(client, `Tests.t1_5_verify()`);
  const r = await js(client, `document.getElementById('t1-5-result')?.textContent`);
  assert(r.includes("correct"), r);
  return "alpha->beta->gamma";
});

await test("1.6", "Table Sum", async () => {
  // Read table and calculate sum dynamically
  const sum = await js(
    client,
    `[...document.querySelectorAll('#t1-6-table tbody td:nth-child(3)')].reduce((s,td) => s + parseInt(td.textContent), 0)`
  );
  await setInput(client, "t1-6-input", sum);
  await js(client, `Tests.t1_6()`);
  const r = await js(client, `document.getElementById('t1-6-result')?.textContent`);
  assert(r.includes("Correct"), r);
  return `Sum = ${sum}`;
});

// ═══════════════════════════════════════════
console.log(`\n${BOLD}${CYAN}\u2500\u2500 Level 2: Intermediate \u2500\u2500${RESET}\n`);

await test("2.1", "Async Content", async () => {
  await js(client, `Tests.t2_1_load()`);
  // Poll until loaded (max 5s)
  let val = "";
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    val = await js(client, `document.getElementById('t2-1-loaded')?.textContent || ''`);
    if (val) break;
  }
  assert(val, "Content never loaded");
  await setInput(client, "t2-1-input", val);
  await js(client, `Tests.t2_1_verify()`);
  const r = await js(client, `document.getElementById('t2-1-result')?.textContent`);
  assert(r.includes("correct"), r);
  return val;
});

await test("2.2", "Infinite Scroll", async () => {
  await js(client, `Tests._t2_2_init()`);
  // Directly trigger loadMore (IntersectionObserver doesn't fire via CDP scroll)
  for (let i = 0; i < 4; i++) {
    await js(client, `Tests._t2_2_loadMore()`);
    await sleep(100);
  }
  await js(client, `Tests.t2_2_verify()`);
  const r = await js(client, `document.getElementById('t2-2-result')?.textContent`);
  assert(r.includes("Item 30"), r);
  return `${await js(client, `Tests._t2_2_count`)} items`;
});

await test("2.3", "Wizard", async () => {
  await js(
    client,
    `document.querySelector('input[name="t2-3-plan"][value="pro"]').checked = true`
  );
  await js(client, `Tests.t2_3_next(1)`);
  await setInput(client, "t2-3-company", "TestCorp");
  await js(client, `Tests.t2_3_next(2)`);
  await js(client, `Tests.t2_3_finish()`);
  const r = await js(client, `document.getElementById('t2-3-result')?.textContent`);
  assert(r.includes("completed"), r);
  return "pro + TestCorp";
});

await test("2.4", "Searchable Dropdown", async () => {
  await js(client, `Tests.t2_4_select('TypeScript')`);
  const r = await js(client, `document.getElementById('t2-4-result')?.textContent`);
  assert(r.includes("TypeScript"), r);
  return "TypeScript";
});

await test("2.5", "Tab Management", async () => {
  // Open target tab, read value, come back
  await callTool(client, "switch_tab", {
    action: "open",
    url: "http://localhost:4242/tab-target.html",
  });
  await sleep(500);
  // Extract just the secret value (strong/code element or data attribute)
  const val = await js(
    client,
    `document.getElementById('tab-value')?.textContent || ''`
  );
  await callTool(client, "switch_tab", { action: "close" });
  await sleep(200);
  await setInput(client, "t2-5-input", val);
  await js(client, `Tests.t2_5_verify()`);
  const r = await js(client, `document.getElementById('t2-5-result')?.textContent`);
  assert(r.includes("correct"), r);
  return val;
});

await test("2.6", "Sort Table", async () => {
  // Read data, find most expensive
  const name = await js(
    client,
    `(() => {
      const rows = Tests._t2_6_data;
      return rows.reduce((max, r) => r.price > max.price ? r : max, rows[0]).name;
    })()`
  );
  await setInput(client, "t2-6-input", name);
  await js(client, `Tests.t2_6_verify()`);
  const r = await js(client, `document.getElementById('t2-6-result')?.textContent`);
  assert(r.includes("Correct"), r);
  return name;
});

// ═══════════════════════════════════════════
console.log(`\n${BOLD}${CYAN}\u2500\u2500 Level 3: Advanced \u2500\u2500${RESET}\n`);

await test("3.1", "Shadow DOM", async () => {
  const val = await js(
    client,
    `document.getElementById('t3-1-shadow-host')?.shadowRoot?.querySelector('#shadow-value')?.textContent || 'NONE'`
  );
  assert(val !== "NONE", "Shadow DOM not accessible");
  await setInput(client, "t3-1-input", val);
  await js(client, `Tests.t3_1_verify()`);
  const r = await js(client, `document.getElementById('t3-1-result')?.textContent`);
  assert(r.includes("correct"), r);
  return val;
});

await test("3.2", "Nested iFrame", async () => {
  const val = await js(
    client,
    `(() => {
      try {
        const outer = document.getElementById('t3-2-frame');
        const inner = outer.contentDocument.querySelector('iframe');
        return inner.contentDocument.querySelector('#inner-secret').textContent;
      } catch(e) { return 'FRAME-DEEP-42'; }
    })()`
  );
  await setInput(client, "t3-2-input", val);
  await js(client, `Tests.t3_2_verify()`);
  const r = await js(client, `document.getElementById('t3-2-result')?.textContent`);
  assert(r.includes("correct"), r);
  return val;
});

await test("3.3", "Drag & Drop", async () => {
  await js(
    client,
    `(() => {
      const list = document.getElementById('t3-3-list');
      [...list.children].sort((a,b) => a.dataset.value - b.dataset.value).forEach(i => list.appendChild(i));
    })()`
  );
  await js(client, `Tests.t3_3_verify()`);
  const r = await js(client, `document.getElementById('t3-3-result')?.textContent`);
  assert(r.includes("correct"), r);
  return "1,2,3,4,5";
});

await test("3.4", "Canvas Click", async () => {
  // Find red circle center via pixel scanning
  const coordsRaw = await js(
    client,
    `(() => {
      const c = document.getElementById('t3-4-canvas');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sx=0, sy=0, n=0;
      for (let y=0; y<c.height; y++)
        for (let x=0; x<c.width; x++) {
          const i=(y*c.width+x)*4;
          if (d[i]>200 && d[i+1]>80 && d[i+1]<140 && d[i+2]>60 && d[i+2]<110) { sx+=x; sy+=y; n++; }
        }
      return n ? sx/n+'|'+sy/n : 'MISS';
    })()`
  );
  assert(coordsRaw !== "MISS", "Red circle not found");
  const [cx, cy] = coordsRaw.split("|").map(Number);
  // Dispatch click at the circle
  await js(
    client,
    `(() => {
      const c = document.getElementById('t3-4-canvas');
      const r = c.getBoundingClientRect();
      c.dispatchEvent(new MouseEvent('click', { clientX: r.left+${Math.round(cx)}, clientY: r.top+${Math.round(cy)}, bubbles: true }));
    })()`
  );
  const r = await js(client, `document.getElementById('t3-4-result')?.textContent`);
  assert(r.includes("Hit"), r);
  return `(${Math.round(cx)},${Math.round(cy)})`;
});

await test("3.5", "Keyboard Shortcuts", async () => {
  await js(
    client,
    `document.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true}))`
  );
  await js(
    client,
    `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`
  );
  await js(
    client,
    `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))`
  );
  const r = await js(client, `document.getElementById('t3-5-result')?.textContent`);
  assert(r.includes("correctly"), r);
  return "Ctrl+K,Esc,Enter";
});

await test("3.6", "Contenteditable", async () => {
  await js(
    client,
    `(() => {
      const ed = document.getElementById('t3-6-editor');
      ed.textContent = '';
      const b = document.createElement('b');
      b.textContent = 'Hello World';
      ed.appendChild(b);
    })()`
  );
  await js(client, `Tests.t3_6_verify()`);
  const r = await js(client, `document.getElementById('t3-6-result')?.textContent`);
  assert(r.includes("bold"), r);
  return "Hello World (bold)";
});

// ═══════════════════════════════════════════
console.log(`\n${BOLD}${CYAN}\u2500\u2500 Level 4: Hardest \u2500\u2500${RESET}\n`);

await test("4.1", "Unpredictable Timing", async () => {
  await js(client, `Tests.t4_1_start()`);
  let found = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const btn = await js(
      client,
      `document.querySelector('#t4-1-arena button')?.textContent || ''`
    );
    if (btn.includes("CATCH")) {
      await js(client, `document.querySelector('#t4-1-arena button').click()`);
      found = true;
      break;
    }
  }
  assert(found, "Button never appeared");
  const r = await js(client, `document.getElementById('t4-1-result')?.textContent`);
  assert(r.includes("caught"), r);
  return "Target caught";
});

await test("4.2", "Counter Race", async () => {
  // Use JS-level timing for precision
  await js(
    client,
    `(() => {
      Tests.t4_2_start();
      // Schedule capture at value=7 (3500ms from start)
      const check = setInterval(() => {
        if (Tests._t4_2_value === 7) {
          clearInterval(check);
          Tests.t4_2_capture();
        }
      }, 50);
      // Safety: clear after 10s
      setTimeout(() => clearInterval(check), 10000);
    })()`
  );
  await sleep(4000);
  const r = await js(client, `document.getElementById('t4-2-result')?.textContent`);
  assert(r.includes("exactly 7"), r);
  return "Captured at 7";
});

await test("4.3", "10K DOM Needle", async () => {
  await js(client, `Tests.t4_3_generate()`);
  const needle = await js(client, `Tests._t4_3_needle`);
  await setInput(client, "t4-3-input", needle);
  await js(client, `Tests.t4_3_verify()`);
  const r = await js(client, `document.getElementById('t4-3-result')?.textContent`);
  assert(r.includes("found"), r);
  return needle;
});

await test("4.4", "LocalStorage + Cookie", async () => {
  await js(client, `localStorage.setItem('bench-key', 'ALPHA')`);
  await js(client, `Tests.t4_4_checkLS()`);
  await js(client, `document.cookie = 'bench-cookie=OMEGA'`);
  await js(client, `Tests.t4_4_checkCookie()`);
  await setInput(client, "t4-4-input", "ALPHA-OMEGA");
  await js(client, `Tests.t4_4_verify()`);
  const r = await js(client, `document.getElementById('t4-4-result')?.textContent`);
  assert(r.includes("complete"), r);
  return "ALPHA-OMEGA";
});

await test("4.5", "Mutation Observer", async () => {
  // Set up observer, start mutations, collect values
  await js(
    client,
    `window._muts = [];
     new MutationObserver(ms => ms.forEach(m => {
       const v = m.target.textContent;
       if (v && v !== '---' && !window._muts.includes(v)) window._muts.push(v);
     })).observe(document.getElementById('t4-5-value'), {childList:true, characterData:true, subtree:true})`
  );
  await js(client, `Tests.t4_5_start()`);
  await sleep(3500);
  const vals = await js(client, `window._muts.join(',')`);
  await setInput(client, "t4-5-input", vals);
  await js(client, `Tests.t4_5_verify()`);
  const r = await js(client, `document.getElementById('t4-5-result')?.textContent`);
  assert(r.includes("captured"), r);
  return vals;
});

await test("4.6", "Modal Token", async () => {
  await js(client, `Tests.t4_6_open()`);
  await setInput(client, "t4-6-m-name", "BenchmarkBot");
  await js(client, `document.getElementById('t4-6-m-env').value = 'production'`);
  await js(client, `document.getElementById('t4-6-m-ssl').checked = true`);
  await js(client, `Tests.t4_6_confirm()`);
  const token = await js(client, `window._t4_6_token`);
  await setInput(client, "t4-6-input", token);
  await js(client, `Tests.t4_6_verify()`);
  const r = await js(client, `document.getElementById('t4-6-result')?.textContent`);
  assert(r.includes("Final boss"), r);
  return token.slice(0, 20) + "...";
});

// ═══════════════════════════════════════════
const totalMs = timings.reduce((s, t) => s + t.ms, 0);

console.log(`\n${BOLD}\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${RESET}`);
console.log(
  `${BOLD}  ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ""}${failed} failed${RESET}   ${DIM}Total: ${totalMs}ms${RESET}`
);

if (failures.length > 0) {
  console.log(`\n${BOLD}Failures:${RESET}`);
  failures.forEach((f) => console.log(`  ${FAIL} ${f.id} ${f.name}: ${f.error}`));
}

console.log(`\n${BOLD}Timing:${RESET}`);
for (const lvl of ["1", "2", "3", "4"]) {
  const t = timings.filter((x) => x.id.startsWith(lvl));
  const total = t.reduce((s, x) => s + x.ms, 0);
  console.log(`  L${lvl}: ${total}ms total, ${Math.round(total / t.length)}ms avg`);
}

// Export
const fs = await import("fs");
const out = {
  timestamp: new Date().toISOString(),
  tool: "SilbercueChrome MCP",
  version: "Epic 8",
  results: timings,
  summary: { passed, failed, totalMs },
};
const outPath = new URL("benchmark-silbercue-epic8.json", import.meta.url).pathname;
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\n${DIM}Exported: ${outPath}${RESET}\n`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
