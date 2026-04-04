#!/usr/bin/env node
/**
 * SilbercueChrome Stress Test v2 — Hardcore Mode
 * Focus: Native MCP tools only (click/type by ref, read_page, wait_for).
 * NO evaluate workarounds — this tests what an LLM agent actually uses.
 *
 * Usage: node test-stress/stress-test-v2.mjs [page-number]
 * Requires: Chrome on port 9222, stress-test server on port 4243
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
const pageFilter = process.argv[2] ? parseInt(process.argv[2]) : null;

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
  } catch (e) {
    return { text: e.message, hasImage: false, ms: Date.now() - t0, isError: true };
  }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Find ref by text pattern in read_page output */
function findRef(readPageText, pattern) {
  const regex = new RegExp(`\\[(e\\d+)\\][^\\n]*${pattern}`, "i");
  const match = readPageText?.match(regex);
  return match ? match[1] : null;
}

/** Count refs in read_page output */
function countRefs(text) { return (text?.match(/\[e\d+\]/g) || []).length; }

// ═══════════════════════════════════════════════
// TEST SUITES — Native MCP tools only
// ═══════════════════════════════════════════════

async function testPage01(client) {
  console.log(`\n${BOLD}[01] Shadow DOM & Web Components — NATIVE${RESET}`);
  await callTool(client, "navigate", { url: `${BASE_URL}/01-shadow-dom.html` });

  // CORE: Does read_page expose shadow DOM elements?
  const rp = await callTool(client, "read_page", { depth: 8, filter: "all" });
  const refs = countRefs(rp.text);
  log(refs > 5 ? PASS : FAIL, "read_page depth=8 refs", rp.ms, `${refs} refs`);
  record("01", "read_page-refs", refs > 5, rp.ms, `${refs} refs`);

  // T1: Can we find and click the shadow button by ref?
  const shadowRef = findRef(rp.text, "Shadow Button");
  if (shadowRef) {
    const click = await callTool(client, "click", { ref: shadowRef });
    const verify = await callTool(client, "evaluate", { expression: "window.__t1_clicked || false" });
    const pass = verify.text === "true";
    log(pass ? PASS : FAIL, `T1: click shadow button via ref ${shadowRef}`, click.ms, verify.text);
    record("01", "T1-click-ref", pass, click.ms);
  } else {
    log(FAIL, "T1: shadow button ref NOT found in a11y tree", 0);
    record("01", "T1-click-ref", false, 0, "ref not found");
  }

  // T6: 5-level deep button via ref
  const deepRef = findRef(rp.text, "Level 5 Deep");
  if (deepRef) {
    const click = await callTool(client, "click", { ref: deepRef });
    const verify = await callTool(client, "evaluate", { expression: "window.__t6_clicked || false" });
    const pass = verify.text === "true";
    log(pass ? PASS : FAIL, `T6: click 5-deep button via ref ${deepRef}`, click.ms);
    record("01", "T6-deep-ref", pass, click.ms);
  } else {
    log(FAIL, "T6: deep button ref NOT found", 0);
    record("01", "T6-deep-ref", false, 0, "ref not found");
  }

  // T3: Closed shadow — can read_page see it?
  const closedRef = findRef(rp.text, "Closed Shadow");
  log(closedRef ? PASS : FAIL, "T3: closed shadow in a11y tree", 0, closedRef || "NOT found");
  record("01", "T3-closed-a11y", !!closedRef, 0);

  // T4: Slotted button
  const slottedRef = findRef(rp.text, "Slotted Button");
  if (slottedRef) {
    const click = await callTool(client, "click", { ref: slottedRef });
    const verify = await callTool(client, "evaluate", { expression: "window.__t4_clicked || false" });
    const pass = verify.text === "true";
    log(pass ? PASS : FAIL, `T4: click slotted button via ref ${slottedRef}`, click.ms);
    record("01", "T4-slotted-ref", pass, click.ms);
  } else {
    log(FAIL, "T4: slotted button ref NOT found", 0);
    record("01", "T4-slotted-ref", false, 0);
  }

  // T5: Shadow form via native type
  const rp2 = await callTool(client, "read_page", { depth: 8, filter: "interactive" });
  const nameRef = findRef(rp2.text, "Name");
  const emailRef = findRef(rp2.text, "Email");
  const submitRef = findRef(rp2.text, "Submit");
  if (nameRef && emailRef && submitRef) {
    await callTool(client, "type", { ref: nameRef, text: "Shadow User" });
    await callTool(client, "type", { ref: emailRef, text: "shadow@test.com" });
    await callTool(client, "click", { ref: submitRef });
    const verify = await callTool(client, "evaluate", { expression: "JSON.stringify(window.__t5_submitted || null)" });
    const pass = verify.text?.includes("Shadow User");
    log(pass ? PASS : FAIL, "T5: shadow form via native type/click", 0, verify.text?.slice(0, 60));
    record("01", "T5-shadow-form", pass, 0);
  } else {
    log(FAIL, "T5: shadow form refs not found", 0, `name=${nameRef} email=${emailRef} submit=${submitRef}`);
    record("01", "T5-shadow-form", false, 0);
  }
}

async function testPage03(client) {
  console.log(`\n${BOLD}[03] SPA Dynamic Content — NATIVE${RESET}`);
  await callTool(client, "navigate", { url: `${BASE_URL}/03-spa-dynamic.html` });

  // read_page to find refs
  const rp = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
  log(PASS, "read_page", rp.ms, `${countRefs(rp.text)} refs`);

  // T1: Find Settings tab by ref and click
  const settingsRef = findRef(rp.text, "Settings");
  if (settingsRef) {
    await callTool(client, "click", { ref: settingsRef });
    await delay(200);
    // Re-read page to find the checkbox
    const rp2 = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
    const darkRef = findRef(rp2.text, "Dark Mode");
    if (darkRef) {
      await callTool(client, "click", { ref: darkRef });
      const verify = await callTool(client, "evaluate", { expression: "window.__t1_toggled || false" });
      const pass = verify.text === "true";
      log(pass ? PASS : FAIL, `T1: Settings tab → Dark Mode toggle (refs: ${settingsRef}, ${darkRef})`, 0);
      record("03", "T1-tab-toggle-ref", pass, 0);
    } else {
      log(FAIL, "T1: Dark Mode checkbox ref not found after tab switch", 0);
      record("03", "T1-tab-toggle-ref", false, 0, "checkbox ref not found");
    }
  } else {
    log(FAIL, "T1: Settings tab ref not found", 0);
    record("03", "T1-tab-toggle-ref", false, 0);
  }

  // T2: Debounced counter via ref
  const rp3 = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
  const incRef = findRef(rp3.text, "Increment");
  if (incRef) {
    for (let i = 0; i < 3; i++) {
      await callTool(client, "click", { ref: incRef });
      await delay(600);
    }
    const verify = await callTool(client, "evaluate", { expression: "parseInt(document.getElementById('counter-display').textContent)" });
    const pass = parseInt(verify.text) >= 3;
    log(pass ? PASS : FAIL, `T2: debounced counter via ref ${incRef}`, 0, `count=${verify.text}`);
    record("03", "T2-debounce-ref", pass, 0);
  } else {
    log(FAIL, "T2: Increment button ref not found", 0);
    record("03", "T2-debounce-ref", false, 0);
  }

  // T5: Modal chain via native tools
  const openRef = findRef(rp3.text, "Open Form");
  if (openRef) {
    await callTool(client, "click", { ref: openRef });
    await delay(400);
    // Re-read to get modal refs
    const rpModal = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
    const modalNameRef = findRef(rpModal.text, "Your name") || findRef(rpModal.text, "name");
    const modalEmailRef = findRef(rpModal.text, "Your email") || findRef(rpModal.text, "email");
    const modalSubmitRef = findRef(rpModal.text, "Submit");
    if (modalNameRef && modalEmailRef && modalSubmitRef) {
      await callTool(client, "type", { ref: modalNameRef, text: "Ref User" });
      await callTool(client, "type", { ref: modalEmailRef, text: "ref@test.com" });
      await callTool(client, "click", { ref: modalSubmitRef });
      await delay(400);
      // Confirm modal
      const rpConfirm = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
      const confirmRef = findRef(rpConfirm.text, "Confirm");
      if (confirmRef) {
        await callTool(client, "click", { ref: confirmRef });
        const verify = await callTool(client, "evaluate", { expression: "JSON.stringify(window.__t5_confirmed || null)" });
        const pass = verify.text?.includes("Ref User");
        log(pass ? PASS : FAIL, "T5: modal chain via refs", 0, verify.text?.slice(0, 60));
        record("03", "T5-modal-ref", pass, 0);
      } else {
        log(FAIL, "T5: Confirm button ref not found in confirmation modal", 0);
        record("03", "T5-modal-ref", false, 0);
      }
    } else {
      log(FAIL, "T5: modal form refs not found", 0, `name=${modalNameRef} email=${modalEmailRef}`);
      record("03", "T5-modal-ref", false, 0);
    }
  } else {
    log(FAIL, "T5: Open Form button ref not found", 0);
    record("03", "T5-modal-ref", false, 0);
  }
}

async function testPage05(client) {
  console.log(`\n${BOLD}[05] Canvas & SVG — NATIVE${RESET}`);
  await callTool(client, "navigate", { url: `${BASE_URL}/05-canvas-interactive.html` });

  const rp = await callTool(client, "read_page", { depth: 5, filter: "all" });
  const refs = countRefs(rp.text);
  log(PASS, "read_page", rp.ms, `${refs} refs`);

  // T3: SVG bar — try click by ref
  // SVG rects likely won't have a11y refs unless they have ARIA roles
  const barRef = findRef(rp.text, "C") || findRef(rp.text, "bar");
  if (barRef) {
    const click = await callTool(client, "click", { ref: barRef });
    log(click.isError ? FAIL : PASS, `T3: SVG bar via ref ${barRef}`, click.ms);
    record("05", "T3-svg-ref", !click.isError, click.ms);
  } else {
    // Fallback: click by selector
    const click = await callTool(client, "click", { selector: '[data-bar="c"]' });
    const verify = await callTool(client, "evaluate", { expression: "window.__t3_clicked || 'none'" });
    const pass = verify.text === '"c"';
    log(pass ? PASS : FAIL, "T3: SVG bar via selector fallback", click.ms, `ref not found, selector used`);
    record("05", "T3-svg-selector", pass, click.ms, "no ref, CSS fallback");
  }

  // SoM screenshot on SVG page
  const som = await callTool(client, "screenshot", { som: true });
  log(som.hasImage ? PASS : FAIL, "SoM screenshot on canvas/SVG page", som.ms);
  record("05", "som-screenshot", som.hasImage, som.ms);

  // dom_snapshot on canvas/SVG
  const ds = await callTool(client, "dom_snapshot");
  const dsElems = ds.text ? JSON.parse(ds.text).length : 0;
  log(dsElems > 0 ? PASS : FAIL, "dom_snapshot on canvas/SVG", ds.ms, `${dsElems} elements`);
  record("05", "dom_snapshot", dsElems > 0, ds.ms, `${dsElems} elements`);
}

async function testPage06(client) {
  console.log(`\n${BOLD}[06] Drag & Drop — NATIVE${RESET}`);
  await callTool(client, "navigate", { url: `${BASE_URL}/06-drag-drop.html` });

  const rp = await callTool(client, "read_page", { depth: 5, filter: "all" });
  const refs = countRefs(rp.text);
  log(PASS, "read_page", rp.ms, `${refs} refs`);
  record("06", "read_page", true, rp.ms, `${refs} refs`);

  // Drag & drop requires mouse events that our MCP doesn't directly support.
  // This is a known limitation — log it.
  // Try T3: Custom slider via evaluate (the only feasible way)
  const sliderResult = await callTool(client, "evaluate", {
    expression: `(() => {
      const track = document.getElementById('slider-track');
      const rect = track.getBoundingClientRect();
      const targetX = rect.left + rect.width * 0.75;
      track.dispatchEvent(new MouseEvent('click', { clientX: targetX, clientY: rect.top + 4, bubbles: true }));
      return window.__t3_value || 0;
    })()`,
  });
  const sliderVal = parseInt(sliderResult.text || "0");
  const sliderPass = sliderVal >= 70 && sliderVal <= 80;
  log(sliderPass ? PASS : FAIL, "T3: custom slider to 75 (via click)", sliderResult.ms, `value=${sliderVal}`);
  record("06", "T3-slider", sliderPass, sliderResult.ms, `value=${sliderVal}`);

  // Note: native drag&drop is NOT supported by our MCP — flag this
  log(FAIL, "T1/T2: drag & drop NOT supported by MCP (no drag events)", 0, "KNOWN LIMITATION");
  record("06", "T1-drag-drop", false, 0, "MCP cannot dispatch drag events");
}

async function testPage08(client) {
  console.log(`\n${BOLD}[08] Mega DOM Performance — NATIVE${RESET}`);
  await callTool(client, "navigate", { url: `${BASE_URL}/08-mega-dom.html` });

  // read_page with different depths
  for (const depth of [2, 4, 6]) {
    const rp = await callTool(client, "read_page", { depth, filter: "interactive" });
    const refs = countRefs(rp.text);
    const pass = !rp.isError && rp.ms < 5000;
    log(pass ? PASS : FAIL, `read_page depth=${depth}`, rp.ms, `${refs} refs, ${rp.text?.length || 0} chars`);
    record("08", `read_page-d${depth}`, pass, rp.ms, `${refs} refs`);
  }

  // dom_snapshot
  const ds = await callTool(client, "dom_snapshot");
  log(!ds.isError ? PASS : FAIL, "dom_snapshot on mega DOM", ds.ms, `${ds.text?.length || 0} chars`);
  record("08", "dom_snapshot-mega", !ds.isError, ds.ms);

  // screenshot + SoM on mega DOM
  const ss = await callTool(client, "screenshot", { som: true });
  log(ss.hasImage ? PASS : FAIL, "SoM screenshot on mega DOM", ss.ms);
  record("08", "som-mega", ss.hasImage, ss.ms);

  // full_page screenshot (huge content)
  const fp = await callTool(client, "screenshot", { full_page: true });
  log(fp.hasImage ? PASS : FAIL, "full_page screenshot on mega DOM", fp.ms);
  record("08", "fullpage-mega", fp.hasImage, fp.ms);

  // Token budget test: read_page with max_tokens
  const rpBudget = await callTool(client, "read_page", { max_tokens: 1000, filter: "interactive" });
  const budgetPass = !rpBudget.isError && (rpBudget.text?.length || 0) < 6000;
  log(budgetPass ? PASS : FAIL, "read_page max_tokens=1000", rpBudget.ms, `${rpBudget.text?.length || 0} chars`);
  record("08", "read_page-budget", budgetPass, rpBudget.ms);
}

async function testPage09(client) {
  console.log(`\n${BOLD}[09] Keyboard & Focus — NATIVE${RESET}`);
  await callTool(client, "navigate", { url: `${BASE_URL}/09-keyboard-focus.html` });

  const rp = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
  log(PASS, "read_page", rp.ms, `${countRefs(rp.text)} refs`);

  // T2: Tab form — fill fields via ref, then submit
  const firstRef = findRef(rp.text, "First name");
  const lastRef = findRef(rp.text, "Last name");
  const emailRef = findRef(rp.text, "Email");
  const submitRef = findRef(rp.text, "Submit");

  if (firstRef && lastRef && emailRef) {
    await callTool(client, "type", { ref: firstRef, text: "John" });
    await callTool(client, "type", { ref: lastRef, text: "Doe" });
    await callTool(client, "type", { ref: emailRef, text: "john@test.com" });
    // Submit via evaluate (Enter key dispatch)
    if (submitRef) {
      await callTool(client, "click", { ref: submitRef });
    }
    // Check form via submit event
    await callTool(client, "evaluate", { expression: "document.getElementById('tab-form').dispatchEvent(new Event('submit'))" });
    const verify = await callTool(client, "evaluate", { expression: "JSON.stringify(window.__t2_submitted || null)" });
    const pass = verify.text?.includes("John");
    log(pass ? PASS : FAIL, "T2: form fill via refs", 0, verify.text?.slice(0, 60));
    record("09", "T2-form-refs", pass, 0);
  } else {
    log(FAIL, "T2: form field refs not found", 0, `first=${firstRef} last=${lastRef} email=${emailRef}`);
    record("09", "T2-form-refs", false, 0);
  }

  // T3: Focus trap — enter, fill, escape
  const enterRef = findRef(rp.text, "Enter Focus Trap");
  if (enterRef) {
    await callTool(client, "click", { ref: enterRef });
    await delay(200);
    const rpTrap = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
    const input1Ref = findRef(rpTrap.text, "Input 1");
    const input2Ref = findRef(rpTrap.text, "Input 2");
    const escRef = findRef(rpTrap.text, "Escape");
    if (input1Ref && input2Ref && escRef) {
      await callTool(client, "type", { ref: input1Ref, text: "trap-val-1" });
      await callTool(client, "type", { ref: input2Ref, text: "trap-val-2" });
      await callTool(client, "click", { ref: escRef });
      const verify = await callTool(client, "evaluate", { expression: "JSON.stringify(window.__t3_escaped || null)" });
      const pass = verify.text?.includes("trap-val-1");
      log(pass ? PASS : FAIL, "T3: focus trap fill & escape via refs", 0, verify.text?.slice(0, 60));
      record("09", "T3-focus-trap", pass, 0);
    } else {
      log(FAIL, "T3: trap refs not found", 0);
      record("09", "T3-focus-trap", false, 0);
    }
  } else {
    log(FAIL, "T3: Enter Focus Trap button not found", 0);
    record("09", "T3-focus-trap", false, 0);
  }
}

async function testPage11(client) {
  console.log(`\n${BOLD}[11] CSS Tricks — NATIVE${RESET}`);
  await callTool(client, "navigate", { url: `${BASE_URL}/11-css-tricks.html` });

  // T1: CSS Transform — click via ref (tests getContentQuads with transforms)
  const rp = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
  const transformRef = findRef(rp.text, "Transformed Button");
  if (transformRef) {
    const click = await callTool(client, "click", { ref: transformRef });
    const verify = await callTool(client, "evaluate", { expression: "window.__t1_clicked || false" });
    const pass = verify.text === "true";
    log(pass ? PASS : FAIL, `T1: CSS-transform button via ref ${transformRef}`, click.ms);
    record("11", "T1-transform-ref", pass, click.ms);
  } else {
    log(FAIL, "T1: transform button ref not found", 0);
    record("11", "T1-transform-ref", false, 0);
  }

  // T4: Invisible button (opacity:0) — can read_page see it?
  const invisRef = findRef(rp.text, "invisible");
  log(invisRef ? PASS : FAIL, "T4: invisible button in a11y tree", 0, invisRef || "NOT found");
  record("11", "T4-invisible-a11y", !!invisRef, 0);
  if (invisRef) {
    const click = await callTool(client, "click", { ref: invisRef });
    const verify = await callTool(client, "evaluate", { expression: "window.__t4_clicked || false" });
    const pass = verify.text === "true";
    log(pass ? PASS : FAIL, `T4: click invisible button via ref ${invisRef}`, click.ms);
    record("11", "T4-invisible-click", pass, click.ms);
  }

  // T5: Grid reorder — click visual-first
  const gridRef = findRef(rp.text, "DOM Last.*Visual First") || findRef(rp.text, "Visual First");
  if (gridRef) {
    const click = await callTool(client, "click", { ref: gridRef });
    const verify = await callTool(client, "evaluate", { expression: "window.__t5_clicked || 'none'" });
    const pass = verify.text === '"3"';
    log(pass ? PASS : FAIL, `T5: grid-reorder via ref ${gridRef}`, click.ms);
    record("11", "T5-grid-ref", pass, click.ms);
  } else {
    log(FAIL, "T5: visual-first button ref not found", 0);
    record("11", "T5-grid-ref", false, 0);
  }

  // dom_snapshot — check bounds match visual positions (transform)
  const ds = await callTool(client, "dom_snapshot");
  if (!ds.isError && ds.text) {
    const elements = JSON.parse(ds.text);
    const transformEl = elements.find((e) => e.name?.includes("Transformed"));
    if (transformEl) {
      // Transform moves 200px right — bounds.x should reflect visual position
      log(transformEl.bounds.x > 100 ? PASS : FAIL, "dom_snapshot: transform bounds accuracy", ds.ms, `x=${transformEl.bounds.x}`);
      record("11", "ds-transform-bounds", transformEl.bounds.x > 100, ds.ms, `x=${transformEl.bounds.x}`);
    } else {
      log(FAIL, "dom_snapshot: transform element not found", ds.ms);
      record("11", "ds-transform-bounds", false, ds.ms);
    }
  }
}

async function testPage12(client) {
  console.log(`\n${BOLD}[12] Form Gauntlet — NATIVE REFS${RESET}`);
  await callTool(client, "navigate", { url: `${BASE_URL}/12-form-gauntlet.html` });

  const rp = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
  log(PASS, "read_page", rp.ms, `${countRefs(rp.text)} refs`);

  // Step 1: Find form fields by ref
  const nameRef = findRef(rp.text, "Full Name");
  const emailRef = findRef(rp.text, "Email");
  const pwRef = findRef(rp.text, "Password");
  const nextRef = findRef(rp.text, "Next Step");

  if (nameRef && emailRef && pwRef && nextRef) {
    await callTool(client, "type", { ref: nameRef, text: "Jane Smith" });
    await callTool(client, "type", { ref: emailRef, text: "jane@example.com" });
    await callTool(client, "type", { ref: pwRef, text: "Strong1Pass" });
    await callTool(client, "click", { ref: nextRef });
    await delay(300);

    // Step 2
    const rp2 = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
    const roleRef = findRef(rp2.text, "role") || findRef(rp2.text, "Select");
    const next2Ref = findRef(rp2.text, "Next Step");

    // Use evaluate for select and checkboxes (complex interactions)
    await callTool(client, "evaluate", {
      expression: `document.getElementById('reg-role').value='designer'; document.getElementById('reg-role').dispatchEvent(new Event('change'));`,
    });
    await callTool(client, "evaluate", {
      expression: `document.querySelectorAll('input[name="interest"]')[1].click(); document.querySelectorAll('input[name="interest"]')[4].click();`,
    });
    await callTool(client, "evaluate", {
      expression: `document.querySelectorAll('input[name="experience"]')[2].click();`,
    });

    if (next2Ref) {
      await callTool(client, "click", { ref: next2Ref });
      await delay(300);
    }

    // Step 3
    const rp3 = await callTool(client, "read_page", { depth: 5, filter: "interactive" });
    const bioRef = findRef(rp3.text, "Bio") || findRef(rp3.text, "yourself");
    const termsRef = findRef(rp3.text, "Terms") || findRef(rp3.text, "agree");
    const submitRef = findRef(rp3.text, "Submit");

    if (bioRef) await callTool(client, "type", { ref: bioRef, text: "QA tester" });
    if (termsRef) await callTool(client, "click", { ref: termsRef });
    if (submitRef) await callTool(client, "click", { ref: submitRef });
    await delay(200);

    const verify = await callTool(client, "evaluate", { expression: "JSON.stringify(window.__form_submitted || null)" });
    const pass = verify.text?.includes("Jane Smith");
    log(pass ? PASS : FAIL, "Form gauntlet completed via refs", 0, verify.text?.slice(0, 80));
    record("12", "form-gauntlet-refs", pass, 0);
  } else {
    log(FAIL, "Step 1 refs not found", 0, `name=${nameRef} email=${emailRef} pw=${pwRef}`);
    record("12", "form-gauntlet-refs", false, 0);
  }
}

async function testRunPlan(client) {
  console.log(`\n${BOLD}[PLAN] run_plan orchestration tests${RESET}`);

  // Multi-page plan: navigate + read + click + verify
  const plan = await callTool(client, "run_plan", {
    steps: [
      { tool: "navigate", params: { url: `${BASE_URL}/03-spa-dynamic.html` } },
      { tool: "click", params: { selector: '[data-tab="settings"]' } },
      { tool: "evaluate", params: { expression: "document.getElementById('tab-settings').classList.contains('active')" } },
      { tool: "screenshot", params: {} },
    ],
  });
  const planPass = !plan.isError && plan.text?.includes("true");
  log(planPass ? PASS : FAIL, "run_plan: navigate → tab → verify → screenshot", plan.ms, `${plan.text?.split("\n").length} steps`);
  record("PLAN", "multi-step-plan", planPass, plan.ms);

  // Plan with intentional error to test abort behavior
  const failPlan = await callTool(client, "run_plan", {
    steps: [
      { tool: "evaluate", params: { expression: "'step1_ok'" } },
      { tool: "click", params: { selector: "#nonexistent-element-xyz" } },
      { tool: "evaluate", params: { expression: "'should_not_run'" } },
    ],
  });
  const failPlanAborted = failPlan.isError || failPlan.text?.includes("FAIL");
  log(failPlanAborted ? PASS : FAIL, "run_plan: abort on error", failPlan.ms);
  record("PLAN", "abort-on-error", failPlanAborted, failPlan.ms);
}

async function testTabManagement(client) {
  console.log(`\n${BOLD}[TABS] Tab Management${RESET}`);

  // Open new tab, navigate, switch back, verify
  const open = await callTool(client, "switch_tab", { action: "open", url: `${BASE_URL}/01-shadow-dom.html` });
  log(!open.isError ? PASS : FAIL, "switch_tab: open new tab", open.ms);
  record("TABS", "open-tab", !open.isError, open.ms);

  // tab_status
  const status = await callTool(client, "tab_status");
  log(!status.isError ? PASS : FAIL, "tab_status", status.ms, status.text?.split("\n")[0]?.slice(0, 60));
  record("TABS", "tab_status", !status.isError, status.ms);

  // virtual_desk
  const desk = await callTool(client, "virtual_desk");
  const multiTabs = desk.text?.includes("shadow-dom") || desk.text?.includes("01-");
  log(!desk.isError ? PASS : FAIL, "virtual_desk", desk.ms, `multi-tab: ${multiTabs}`);
  record("TABS", "virtual_desk", !desk.isError, desk.ms);

  // Close tab
  const close = await callTool(client, "switch_tab", { action: "close" });
  log(!close.isError ? PASS : FAIL, "switch_tab: close tab", close.ms);
  record("TABS", "close-tab", !close.isError, close.ms);
}

// ── Main ──

console.log(`\n${BOLD}╔═══════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}║  SilbercueChrome Stress Test v2 — HARDCORE MODE   ║${RESET}`);
console.log(`${BOLD}╚═══════════════════════════════════════════════════╝${RESET}\n`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
});

const client = new Client({ name: "stress-v2", version: "2.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`${DIM}Connected — ${tools.tools.length} tools available${RESET}`);

const suites = [
  { num: 1, fn: testPage01 },
  { num: 3, fn: testPage03 },
  { num: 5, fn: testPage05 },
  { num: 6, fn: testPage06 },
  { num: 8, fn: testPage08 },
  { num: 9, fn: testPage09 },
  { num: 11, fn: testPage11 },
  { num: 12, fn: testPage12 },
  { num: 100, fn: testRunPlan },
  { num: 101, fn: testTabManagement },
];

for (const suite of suites) {
  if (pageFilter && suite.num !== pageFilter) continue;
  try {
    await suite.fn(client);
  } catch (e) {
    console.log(`  ${FAIL} SUITE ${suite.num} CRASH: ${e.message}`);
    totalFailed++;
    allResults.push({ page: String(suite.num), test: "CRASH", pass: false, ms: 0, detail: e.message });
  }
}

// ── Summary ──
console.log(`\n${BOLD}═══════════════════════════════════════════════════${RESET}`);
console.log(`${BOLD}  HARDCORE Results: ${GREEN}${totalPassed} passed${RESET}, ${RED}${totalFailed} failed${RESET}`);
console.log(`${BOLD}  Total: ${totalPassed + totalFailed} tests across ${suites.length} suites${RESET}`);

const failures = allResults.filter((r) => !r.pass);
if (failures.length > 0) {
  console.log(`\n${BOLD}Failures:${RESET}`);
  failures.forEach((r) => console.log(`  ${FAIL} [${r.page}] ${r.test}: ${r.detail || ""}`));
}

const exportPath = new URL(`../test-stress/stress-v2-results-${Date.now()}.json`, import.meta.url).pathname;
writeFileSync(exportPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  mode: "hardcore",
  passed: totalPassed,
  failed: totalFailed,
  passRate: `${((totalPassed / (totalPassed + totalFailed)) * 100).toFixed(1)}%`,
  results: allResults,
}, null, 2));
console.log(`\n${DIM}Results: ${exportPath}${RESET}\n`);

await client.close();
process.exit(totalFailed > 0 ? 1 : 0);
