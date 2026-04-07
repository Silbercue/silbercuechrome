import type { CdpClient } from "../cdp/cdp-client.js";

// 48x48 Second Truth logo (PNG, base64)
const LOGO_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAMAAAAADbN2wMAAADOElEQVRYCe1Xv0/qUBQWxOcPjFGJiiEMDBIdQAdC1BD4AzRENhcdWYG4MjCZGDZGVzaYddJIICESoy7CJkZNSICYoFHkh8L7YpM+Hu3tpbbd2oHcfuf0fB+n5557OjSkXmoG1AyoGRCVAY1GMzc3p9VqRT0l4Cw1ULfb3d3dnZycFOAQZZIqCGROp9Pj8YhiFXCWQZDBYPB6vQIcokwyCJqYmHA4HHq9XhQxyZkiiFqtcMC1srJis9lIHKJwiqCpqSmfz6fT6UhBR0ZGIGh0dHRra4vkIwqnCHp7ezOZTPF4HIXCG/fPzwXTzs7O+Pg4r4/MoNFovL+/Pzs7W1pa4oaG0NvbW2z+ZrO5urrKdVAE2d/fB+Xd3Z3b7e4jWFxczOfzsOIKh8N9VqVu0fcymQwoX19fDw4O0J1ZJovFgvz96Onmcrnp6WnWpOxie3v7/f0dxJ1OJxqNzszMMHzLy8vPz8+MIDhsbm4qq4ONjq10cnLCEOP39PTUarXCirqpVqssHggE2EcUX6CAPj8/WW68qY2NjbW1NexEFjw/Px8eHoYUdIqxsTFlNaF0YrEYy41FuVxOJBKNRoMFoRhdG6fbxcUF3qyyghDdbre/vLyw9NwFKuzy8rJSqcDUarX29vZcLhdaq1wHC88/PDw85OogIUjYx8fHw8PDwsICTyxZIIQulUokBbx4oVAgNXquJMrRwX0Ar+Po6IiLCyDFYrFWqwk4SDXNzs7e3NzwJoMXDIVCUimpz/v9ftQvL30f+P39jX1HDSjVAQc7Wk4fN+/t4+MjMjo4n+gaYkK32230w0FostnsgJ5MtF8KwiG6vr4+iCB0yK+vr0E8JQkym83z8/NUGnTRq6srqpsMDqihSCTCWzS94PX1tYyfbBTdOA2Oj4976blrnHSUKPKaMU8nk0muDhYJBoNiGX9Z1AwNjs9UKkWiRAfCnEmyknBJghAUIywpNMZ+DJMkKwmXJAhjpMAxjmkJoxKJmIRLEoSxEPufFBqCRHUgJg7xk5RE04tjhnx6esLeRhX34lgjeel0GkXWh1Nv/33QUF25DhCENoMhmlcQaqher3OfUhE1A2oG1Az8l4G/PP2PrT2y2dMAAAAASUVORK5CYII=";

const OVERLAY_ID = "__sc_session_overlay__";

function buildOverlayScript(): string {
  // Static template — safe for shadow DOM injection, no user input.
  const tmpl = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }

      @keyframes sc-fadeIn {
        0% { opacity: 0; transform: translateY(8px); }
        100% { opacity: 1; transform: translateY(0); }
      }

      :host {
        --sc-font: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
        --sc-font-size: 10px;
        --sc-font-weight: 400;
        --sc-letter-spacing: 0.5px;
        --sc-color: rgba(255,255,255,0.65);
        --sc-bar-height: 36px;
        --sc-bar-bg: linear-gradient(0deg, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.35) 55%, transparent 100%);
        --sc-gap: 10px;
      }

      .sc-bar {
        position: fixed;
        bottom: 0; left: 0; right: 0;
        height: var(--sc-bar-height);
        background: var(--sc-bar-bg);
        pointer-events: none;
        display: flex;
        align-items: center;
        padding: 0 14px;
        gap: var(--sc-gap);
        font-family: var(--sc-font);
        font-size: var(--sc-font-size);
        font-weight: var(--sc-font-weight);
        letter-spacing: var(--sc-letter-spacing);
        text-transform: uppercase;
        color: var(--sc-color);
        animation: sc-fadeIn 0.6s ease-out both;
      }

      .sc-logo {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background-color: #000;
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        flex-shrink: 0;
        opacity: 0;
        cursor: pointer;
        pointer-events: auto;
        animation: sc-fadeIn 0.5s ease-out 0.3s both;
      }

      .sc-logo.ready {
        opacity: 0.85;
      }

      .sc-logo.busy {
        background-image: none !important;
      }

      .sc-sep {
        color: var(--sc-color);
      }

      .sc-text-area {
        display: flex;
        align-items: center;
        gap: var(--sc-gap);
        opacity: 0;
        animation: sc-fadeIn 0.4s ease-out 0.5s both;
      }

      .sc-license {
        display: none;
        align-items: center;
        gap: var(--sc-gap);
      }

      .sc-license.open {
        display: flex;
      }

      .sc-license-key {
        cursor: pointer;
        pointer-events: auto;
        text-decoration: underline;
        text-decoration-color: rgba(255,255,255,0.3);
        text-underline-offset: 2px;
      }

      .sc-license-key:hover {
        text-decoration-color: rgba(255,255,255,0.7);
      }

      .sc-copied {
        color: rgba(140,255,140,0.9);
      }
    </style>
    <div class="sc-bar">
      <div class="sc-logo"></div>
      <span class="sc-text-area" id="sc-text-area"></span>
      <span class="sc-license" id="sc-license"></span>
    </div>`;

  const escaped = tmpl.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

  return `(() => {
  if (document.getElementById('${OVERLAY_ID}')) return;
  var LOGO = 'data:image/png;base64,` + LOGO_BASE64 + `';
  var host = document.createElement('div');
  host.id = '${OVERLAY_ID}';
  host.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:0;z-index:2147483647;pointer-events:none;';
  var sr = host.attachShadow({ mode: 'open' });
  var t = document.createElement('template');
  t.innerHTML = \`${escaped}\`;
  sr.appendChild(t.content.cloneNode(true));
  var logo = sr.querySelector('.sc-logo');
  if (logo) {
    logo.style.backgroundImage = 'url(' + LOGO + ')';
    logo.addEventListener('click', function() {
      var ta = sr.getElementById('sc-text-area');
      var lp = sr.getElementById('sc-license');
      var bar = sr.querySelector('.sc-bar');
      if (!ta || !lp || !bar) return;
      if (lp.classList.contains('open')) {
        lp.classList.remove('open');
        ta.style.display = 'flex';
        bar.style.background = '';
      } else {
        ta.style.display = 'none';
        lp.classList.add('open');
        bar.style.background = 'linear-gradient(0deg, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.75) 55%, rgba(0,0,0,0.3) 85%, transparent 100%)';
      }
    });
  }
  document.documentElement.appendChild(host);
})()`;
}

const OVERLAY_SCRIPT = buildOverlayScript();

const OVERLAY_REMOVE_SCRIPT = `(() => {
  var el = document.getElementById('${OVERLAY_ID}');
  if (el) el.remove();
})()`;

let _scriptIdentifier: string | undefined;
let _tierLabel = "FREE";
let _isPro = false;
// Cumulative token savings for Pro overlay display
let _tokensSaved = 0;
// Last tool elapsed time
let _lastElapsedMs = 0;
// License info for the panel
let _licenseKey = "";
let _licenseSince = "";
let _licenseName = "";

export function setTierLabel(isPro: boolean): void {
  _tierLabel = isPro ? "PRO" : "FREE";
  _isPro = isPro;
}

/** Set license details for the info panel. Call once after validation. */
export function setLicenseInfo(key: string | undefined, lastCheck: string | undefined, customerName: string | undefined): void {
  _licenseKey = key ?? "";
  _licenseName = customerName ?? "";
  if (lastCheck) {
    try {
      const d = new Date(lastCheck);
      _licenseSince = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    } catch {
      _licenseSince = lastCheck;
    }
  }
}

/** Track token savings (call after each tool that saves tokens via ambient context) */
export function addTokensSaved(tokens: number): void {
  _tokensSaved += tokens;
}

/** Track last tool elapsed time */
export function setLastElapsed(ms: number): void {
  _lastElapsedMs = ms;
}

export async function injectOverlay(cdpClient: CdpClient, sessionId: string): Promise<void> {
  try {
    if (_scriptIdentifier) {
      try {
        await cdpClient.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: _scriptIdentifier }, sessionId);
      } catch { /* ignore */ }
    }

    const { identifier } = await cdpClient.send<{ identifier: string }>(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: OVERLAY_SCRIPT },
      sessionId,
    );
    _scriptIdentifier = identifier;

    await cdpClient.send("Runtime.evaluate", { expression: OVERLAY_SCRIPT, awaitPromise: false }, sessionId);

    await populateLicensePanel(cdpClient, sessionId);
    await updateOverlayStatus(cdpClient, sessionId, "");
  } catch {
    // Non-critical
  }
}

/** Populate the license info panel. Called after inject and self-healing re-inject. */
async function populateLicensePanel(cdpClient: CdpClient, sessionId: string): Promise<void> {
  let panelHtml: string;
  let copyScript = "";
  if (_licenseKey) {
    const masked = _licenseKey.slice(0, 8) + "\u2026" + _licenseKey.slice(-4);
    const escapedMasked = masked.replace(/'/g, "\\'");
    const fullKey = _licenseKey.replace(/'/g, "\\'");
    const since = _licenseSince.replace(/'/g, "\\'");
    const name = _licenseName.replace(/'/g, "\\'");
    // Order: PRO | date | key (clickable) | name
    panelHtml = `<span>${_tierLabel}</span>`;
    if (since) panelHtml += `<span class="sc-sep">|</span><span>${since}</span>`;
    panelHtml += `<span class="sc-sep">|</span><span>License: <span class="sc-license-key" id="sc-lk">${escapedMasked}</span></span>`;
    if (name) panelHtml += `<span class="sc-sep">|</span><span>${name}</span>`;
    panelHtml += `<span class="sc-copied" id="sc-copied" style="display:none">COPIED</span>`;
    copyScript = `var lk = sr.getElementById('sc-lk');
  if (lk) lk.addEventListener('click', function() {
    navigator.clipboard.writeText('${fullKey}');
    var cp = sr.getElementById('sc-copied');
    if (cp) { cp.style.display = 'inline'; setTimeout(function() { cp.style.display = 'none'; }, 1500); }
  });`;
  } else {
    panelHtml = `<span>${_tierLabel}</span><span class="sc-sep">|</span><span>No license key</span>`;
  }
  const panelScript = `(() => {
  var host = document.getElementById('${OVERLAY_ID}');
  if (!host || !host.shadowRoot) return;
  var sr = host.shadowRoot;
  var lp = sr.getElementById('sc-license');
  if (!lp) return;
  lp.innerHTML = '${panelHtml.replace(/'/g, "\\'")}';
  ${copyScript}
})()`;
  try {
    await cdpClient.send("Runtime.evaluate", { expression: panelScript, awaitPromise: false }, sessionId);
  } catch { /* non-critical */ }
}

function formatMs(ms: number): string {
  return String(ms).padStart(4, "0") + "ms";
}

function formatSaved(tokens: number): string {
  if (tokens >= 1000) return Math.round(tokens / 1000) + "k saved";
  return tokens + " saved";
}

/**
 * Update the overlay.
 * Empty text = idle state (tier + metrics, logo shows image).
 * Non-empty text = busy state (tier + metrics + action, logo = black dot).
 */
export async function updateOverlayStatus(cdpClient: CdpClient, sessionId: string, text: string): Promise<void> {
  // Self-healing: re-inject overlay if it was removed (e.g. SPA rebuild, page reload)
  try {
    const { result } = await cdpClient.send<{ result: { value: boolean } }>(
      "Runtime.evaluate",
      { expression: `!!document.getElementById('${OVERLAY_ID}')`, returnByValue: true },
      sessionId,
    );
    if (!result.value) {
      await cdpClient.send("Runtime.evaluate", { expression: OVERLAY_SCRIPT, awaitPromise: false }, sessionId);
      // Set logo image after re-injection
      await cdpClient.send("Runtime.evaluate", {
        expression: `(() => { var h = document.getElementById('${OVERLAY_ID}'); if (h && h.shadowRoot) { var l = h.shadowRoot.querySelector('.sc-logo'); if (l) l.style.backgroundImage = 'url(data:image/png;base64,` + LOGO_BASE64 + `)'; } })()`,
        awaitPromise: false,
      }, sessionId);
      // Re-populate license panel after self-healing
      await populateLicensePanel(cdpClient, sessionId);
    }
  } catch { /* non-critical */ }

  const isIdle = text === "";
  const tier = _tierLabel.replace(/'/g, "\\'");
  const action = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const timeStr = _lastElapsedMs > 0 ? formatMs(_lastElapsedMs) : "";
  const savedStr = _isPro && _tokensSaved > 0 ? formatSaved(_tokensSaved) : "";

  // Build segments: tier is always shown, others conditional
  const segments: string[] = [tier];
  if (savedStr) segments.push(savedStr);
  if (timeStr) segments.push(timeStr);
  if (!isIdle && action) segments.push(action);
  // Join with " | " — rendered as separate spans so gap handles spacing
  const segmentsJson = JSON.stringify(segments);

  const script = `(() => {
  var host = document.getElementById('${OVERLAY_ID}');
  if (!host || !host.shadowRoot) return;
  var sr = host.shadowRoot;
  var logo = sr.querySelector('.sc-logo');
  var textArea = sr.getElementById('sc-text-area');
  if (!logo || !textArea) return;
  logo.classList.add('ready');
  ${isIdle ? "logo.classList.remove('busy');" : "logo.classList.add('busy');"}
  var segs = ${segmentsJson};
  var html = '';
  for (var i = 0; i < segs.length; i++) {
    if (i > 0) html += '<span class="sc-sep">|</span>';
    html += '<span>' + segs[i] + '</span>';
  }
  textArea.innerHTML = html;
})()`;
  try {
    await cdpClient.send("Runtime.evaluate", { expression: script, awaitPromise: false }, sessionId);
  } catch {
    // Non-critical
  }
}

export async function removeOverlay(cdpClient: CdpClient, sessionId: string): Promise<void> {
  try {
    if (_scriptIdentifier) {
      await cdpClient.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: _scriptIdentifier }, sessionId);
      _scriptIdentifier = undefined;
    }
    await cdpClient.send("Runtime.evaluate", { expression: OVERLAY_REMOVE_SCRIPT, awaitPromise: false }, sessionId);
  } catch {
    // Non-critical
  }
}

/**
 * Show an expanding, fading circle at the given viewport coordinates.
 * Call after a click to visualize where the agent clicked.
 */
export async function showClickIndicator(cdpClient: CdpClient, sessionId: string, x: number, y: number): Promise<void> {
  const script = `(() => {
  var d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:${Math.round(x) - 6}px;top:${Math.round(y) - 6}px;width:12px;height:12px;border-radius:50%;background:#000;border:1px solid rgba(200,200,200,0.5);pointer-events:none;z-index:2147483646;opacity:0.8;transition:opacity 0.8s ease-out;';
  document.documentElement.appendChild(d);
  requestAnimationFrame(function() { d.style.opacity = '0'; });
  setTimeout(function() { d.remove(); }, 900);
})()`;
  try {
    await cdpClient.send("Runtime.evaluate", { expression: script, awaitPromise: false }, sessionId);
  } catch {
    // Non-critical
  }
}

const TOOL_LABELS: Record<string, string> = {
  navigate: "Navigating\u2026",
  read_page: "Reading page\u2026",
  screenshot: "Taking screenshot\u2026",
  click: "Clicking\u2026",
  type: "Typing\u2026",
  fill_form: "Filling form\u2026",
  scroll: "Scrolling\u2026",
  press_key: "Pressing key\u2026",
  wait_for: "Waiting\u2026",
  evaluate: "Evaluating JS\u2026",
  observe: "Observing\u2026",
  inspect_element: "Inspecting\u2026",
  dom_snapshot: "Reading DOM\u2026",
  file_upload: "Uploading file\u2026",
  run_plan: "Running plan\u2026",
  switch_tab: "Switching tab\u2026",
  virtual_desk: "Listing tabs\u2026",
  console_logs: "Reading console\u2026",
  network_monitor: "Monitoring network\u2026",
  configure_session: "Configuring\u2026",
  handle_dialog: "Handling dialog\u2026",
  tab_status: "Checking tab\u2026",
};

export function getToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? "Working\u2026";
}
