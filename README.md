# Public Browser

[![GitHub Release](https://img.shields.io/github/v/release/Silbercue/public-browser)](https://github.com/Silbercue/public-browser/releases)
[![npm version](https://img.shields.io/npm/v/public-browser)](https://www.npmjs.com/package/public-browser)
[![23 tools](https://img.shields.io/badge/Tools-23-brightgreen)](https://github.com/Silbercue/public-browser#tool-overview)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

The most token-efficient MCP server for Chrome browser automation. Direct CDP, a11y-tree refs, multi-tab ready — 1670+ TypeScript tests, 235+ Python tests.

Built for [Claude Code](https://claude.ai/claude-code), [Cursor](https://cursor.sh), and any MCP-compatible client.

> **Looking for an alternative to Playwright MCP, Browser MCP, or claude-in-chrome?** Public Browser talks to Chrome directly via the DevTools Protocol — no Playwright dependency, no Chrome extension bridge, no single-tab limit. One command to install, zero config. [See benchmark comparison below](#benchmarks).

## Why Public Browser?

Every Chrome MCP server has the same problem: **too many tokens, too few reliable refs.** Screenshots eat 10-30x more tokens than text trees. Selector-based refs break the second the DOM rerenders. Extension bridges (Browser MCP) get stuck on the connected tab. Playwright wrappers spin up a new browser instance for every session.

Public Browser fixes this. It talks directly to Chrome via CDP (same protocol Playwright and Puppeteer use internally), returns an accessibility-tree-based reference map, and caches it across calls so `click(ref: 'e5')` and `type(ref: 'e7', ...)` survive scrolls and DOM updates.

| What you get | Playwright MCP | Browser MCP | claude-in-chrome | browser-use | **Public Browser** |
|---|---|---|---|---|---|
| Hardest benchmark (35 tests, LLM-driven) | 29/31 (563s) | **cannot finish** | (pending re-bench) | (pending re-bench) | **30/31: 598s** |
| Avg Tool-Response (Tokens est.) | 362 | — | — | — | **201 (1.8x smaller)** |
| P95 Tool-Response (Chars) | 8.068 | — | — | — | **2.328 (3.5x smaller)** |
| `view_page` avg (Chars) | 6.084 (`browser_snapshot`) | — | — | — | **1.124 (5.4x smaller)** |
| Multi-tab support | Yes | **No (single tab)** | Yes | Partial | **Yes** |
| Connection | New browser | Extension bridge | Extension | Subprocess | **Direct CDP (pipe or WebSocket)** |
| Ref system | Playwright refs | Playwright refs | CSS selectors | Screenshots | **A11y-tree refs (stable across DOM changes)** |
| Drag & drop | Yes | No | Partial | No | **Yes (native CDP mouse events)** |
| Shadow DOM + iframe | Yes | Yes | Partial | No | **Yes (with OOPIF session support)** |
| Multi-step plan execution | — | — | — | — | **`run_plan` — server-side plan executor with variables, conditions, suspend/resume** |

## Quick Start

### Install in Claude Code

One command — installs globally for all projects:

```bash
claude mcp add --scope user public-browser npx -y public-browser@latest
```

**Important:** after `claude mcp add` you must **fully quit and reopen Claude Code**. `/mcp reconnect` is not enough — Claude Code reads the `mcpServers` config only at session start and caches it. After the restart, the first tool call auto-launches Chrome **visible** (no headless, no port setup). Done.

> To enable parallel Python [Script API](#script-api-python) access, add `--script` to the args:
> `claude mcp add --scope user public-browser npx -y public-browser@latest -- --script`

### Install in Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "public-browser": {
      "command": "npx",
      "args": ["-y", "public-browser@latest"]
    }
  }
}
```

> For parallel Python [Script API](#script-api-python) access, use `"args": ["-y", "public-browser@latest", "--", "--script"]`

### Install in Cline

Add to your `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "public-browser": {
      "command": "npx",
      "args": ["-y", "public-browser@latest"]
    }
  }
}
```

### Install in other MCP clients

Any client that supports stdio MCP servers: `npx -y public-browser@latest` with no arguments.

### Try it — your first prompt

After installing, paste this into your AI coding assistant:

> Open mcp-test.second-truth.com, read the page, and fill the contact form with Name "Test User" and Email "test@example.com".

This exercises three core tools in sequence: `navigate` loads the page, `view_page` reads the accessibility tree with stable element refs, and `fill_form` fills multiple fields in one call. You should see Chrome open, the page load, and the form filled — all without writing a single line of code.

### Uninstall

```bash
claude mcp remove --scope user public-browser
```

## Chrome Profiles

By default, Public Browser starts Chrome with a fresh temp profile — no cookies, no logins, no extensions. For tasks like research on sites that block anonymous visitors, you can launch Chrome with your real profile instead.

### List available profiles

```bash
npx public-browser profiles
```

### Launch with a profile

Three ways — pick whichever fits your setup:

```bash
# CLI flag
npx public-browser --profile "Julian"

# Environment variable
PUBLIC_BROWSER_PROFILE="Julian" npx public-browser

# MCP tool (call BEFORE any browser interaction)
configure_session({ profile: "Julian" })
```

When using a real profile, Public Browser preserves extensions, cookies, logins, and sync. It creates a lightweight wrapper directory with a symlink to your real profile data — Chrome gets a "non-default" data dir (required for remote debugging) while using your actual profile.

### If Chrome is already open

Public Browser detects this via lock-file inspection. If Chrome is running with remote debugging enabled, it attaches via CDP. If not, it shows a clear error asking you to close Chrome first.

## Script API (Python)

A second way to use Public Browser — deterministic browser automation from Python, without an LLM in the loop. Scripts use the same tool implementations as the MCP server (Shared Core) — every improvement to `click`, `navigate`, `fill_form` etc. automatically benefits your scripts too. The MCP server handles AI-driven workflows; the Script API is for repeatable scripts you write yourself.

### Installation

```bash
pip install publicbrowser
```

That's it. `Chrome.connect()` auto-starts the Public Browser server as a subprocess — no manual Chrome launch or port setup needed.

> **Legacy single-file alternative:** For quick prototyping you can copy [`python/publicbrowser.py`](python/publicbrowser.py) into your project. This uses v1 direct CDP and does not benefit from server-side improvements — use `pip install` for the full Shared Core experience.

### How it works

```
Python Script                        Escape Hatch (Power User)
    |                                    |
    v                                    v
HTTP POST /tool/{name}              WebSocket (CDP)
Port 9223                           Port 9222
    |                                    |
    v                                    |
Public Browser Server                    |
    |                                    |
    v                                    |
registry.executeTool()                   |
    |                                    |
    v                                    |
Tool Handler                             |
(click.ts, navigate.ts, ...)             |
    |                                    |
    v                                    v
Chrome <------------ CDP --------------->
```

Your script sends HTTP requests to the Public Browser server on port 9223. The server executes the exact same tool handlers that the MCP server uses — one codebase, one test suite (1670+ tests), two access paths.

### Auto-Start

`Chrome.connect()` finds and starts the server automatically:

1. **Running server** — checks if port 9223 already responds, connects immediately
2. **PATH binary** — finds `public-browser` in PATH, starts it with `--script`
3. **npx fallback** — runs `npx -y public-browser@latest -- --script`
4. **Explicit path** — `Chrome.connect(server_path="/path/to/public-browser")` for custom setups

### Example: Login + Data Extraction

```python
from publicbrowser import Chrome

chrome = Chrome.connect()

with chrome.new_page() as page:
    page.navigate("https://competitor.example.com/login")
    page.fill({"#email": "tomek@shop.de", "#password": "***"})
    page.click("button[type=submit]")
    page.wait_for("text=Dashboard")

    for cat in ["electronics", "furniture", "toys"]:
        page.navigate(f"https://competitor.example.com/prices/{cat}")
        prices = page.evaluate(
            "[...document.querySelectorAll('tr')].map(r => r.textContent)"
        )
        save_csv(cat, prices)

chrome.close()
```

### Methods

| Method | Description |
|---|---|
| `Chrome.connect()` | Connect to or auto-start the Public Browser server |
| `chrome.new_page()` | Context manager — opens a new tab, auto-closes on exit |
| `page.navigate(url)` | Navigate and wait for load |
| `page.click(selector)` | Click element by CSS selector, text, or ref |
| `page.type(selector, text)` | Type text into an input |
| `page.fill({"sel": "val"})` | Fill multiple form fields at once |
| `page.wait_for(condition)` | Wait for JS condition or `"text=..."` shorthand |
| `page.evaluate(expression)` | Run JavaScript, return result |
| `page.download()` | Enable downloads, return download dir |
| `page.close()` | Close the tab (auto-called by context manager) |
| `page.cdp.send(method, params)` | Escape Hatch — direct CDP access via WebSocket (see below) |

### Escape Hatch: Direct CDP Access

For use cases the high-level API doesn't cover — network interception, console log subscriptions, performance tracing, cookie management — you can drop down to raw CDP commands:

```python
with chrome.new_page() as page:
    page.navigate("https://example.com")

    # Enable network tracking
    page.cdp.send("Network.enable")

    # Get all cookies
    cookies = page.cdp.send("Network.getAllCookies")

    # Performance tracing
    page.cdp.send("Tracing.start", {"categories": "-*,devtools.timeline"})
```

The Escape Hatch communicates directly with Chrome via WebSocket (port 9222), bypassing the server. It connects lazily on the first `send()` call and reuses the connection for subsequent calls. Each page gets its own WebSocket routed to the correct tab.

### MCP Coexistence

When the MCP server and Python scripts need to run at the same time, add `--script` to the MCP config. `Chrome.connect()` handles the rest automatically — each script works in its own tab, MCP tabs are never touched.

### Enabling `--script` in MCP Config

**Claude Code:**
```bash
claude mcp add --scope user public-browser npx -y public-browser@latest -- --script
```

**Cursor / Cline (`mcp.json`):**
```json
{
  "mcpServers": {
    "public-browser": {
      "command": "npx",
      "args": ["-y", "public-browser@latest", "--", "--script"]
    }
  }
}
```

See [`python/README.md`](python/README.md) for the full API reference and advanced examples.

## Tool Overview

| Tool | Description |
|---|---|
| **Reading & Observation** | |
| `view_page` | A11y-tree with stable `e`-refs — primary way to understand the page. Filter by `interactive` (default) or `all`. 5.4x more compact than Playwright's `browser_snapshot`. |
| `capture_image` | WebP screenshot, max 800px, <100KB. For visual verification only — refs come from `view_page`. |
| `console_logs` | Browser console output with level/pattern filters |
| `network_monitor` | Start/stop/query network requests with filtering |
| `observe` | Watch DOM changes: `collect` (buffer over time) or `until` (wait for condition, then auto-click) |
| `wait_for` | Wait for element visible, network idle, or JS expression true |
| `tab_status` | Active tab's cached URL/title/ready/errors (0ms) |
| `virtual_desk` | Lists all tabs with stable IDs. Call first in every session. |
| `dom_snapshot` | Bounding boxes, computed styles, paint order. For spatial questions `view_page` cannot answer. |
| **Interaction** | |
| `click` | Real CDP mouse events by ref, selector, text, or coordinates. Response includes DOM diff (NEW/REMOVED/CHANGED). |
| `type` | Type into an input by ref/selector |
| `fill_form` | Fill a complete form in one call — text, `<select>`, checkbox, radio. Per-field status. |
| `press_key` | Real CDP keyboard events — Enter, Escape, Tab, arrows, shortcuts (Ctrl+K, etc.) |
| `scroll` | Scroll page, element into view, or inside a specific container |
| `file_upload` | Upload file(s) to `<input type="file">` |
| `handle_dialog` | Configure `alert`/`confirm`/`prompt` handling before triggering actions |
| `drag` | Native CDP drag & drop between elements |
| `download` | Enable downloads, return download dir |
| **Navigation** | |
| `navigate` | Load a URL. First call per session auto-redirected to `virtual_desk` to prevent overwriting the user's tab. |
| `switch_tab` | Open, switch to, or close tabs by ID from `virtual_desk` |
| **Scripting** | |
| `run_plan` | Multi-step batch execution with variables, conditions, `saveAs`, error strategies, suspend/resume. |
| `configure_session` | View/set session defaults (tab, timeout) and accept auto-promote suggestions |
| `evaluate` | Execute JS in page context. Anti-pattern scanner warns on `querySelector`/`.click()`. |
| `inspect_element` | CSS debugging: computed styles, matching rules with source file, inherited values — one call replaces 4+ evaluate roundtrips. |

## Benchmarks

Measured on `https://mcp-test.second-truth.com` — **35 tests in 5 levels** (Basics, Intermediate, Advanced, Hardest, Community Pain Points). Each run is independent, values on the benchmark page are randomized per page-load, all runs started in a fresh Claude Code session out of `/tmp` (no project context bias), and **all metrics measured post-hoc from the session JSONL** via [`test-hardest/measure-tool-calls.sh`](.claude/skills/benchmarkTest/measure-tool-calls.sh) — no self-reporting, no MCP-side instrumentation, just counting `tool_use` blocks and `tool_result` char lengths.

### Head-to-Head (24-Test Suite, 2026-04-04)

All four servers ran the same 24-test suite on [mcp-test.second-truth.com](https://mcp-test.second-truth.com), same LLM (Claude Opus 4.6), same test page. Raw data in `test-hardest/benchmark-*.json`.

| MCP Server | Tests Passed | Duration | Tool Calls | Speed vs PB |
|---|---:|---:|---:|---|
| **Public Browser** | **24/24** | **21s** | **116** | -- |
| Playwright MCP | 24/24 | 570s | 138 | 27x slower |
| claude-in-chrome | 24/24 | 772s | 193 | 37x slower |
| browser-use | 16/24 | 1813s | 124 | 86x slower |

### Pass Rate + Duration (35-Test Suite, 2026-04-09)

| MCP | Passed | Duration |
|---|---|---|
| **Public Browser** | **30/31 (97%)** | **598s** |
| Playwright MCP | 29/31 (94%) | 563s |
| Playwright CLI | 28/31 (90%) | 376s |

### Tool-Efficiency (the fair metric)

We measure each tool call's response char length directly, group by tool name, estimate tokens via `chars/4`. Why this metric: session-level token deltas are dominated by LLM overhead (system prompt + CLAUDE.md + conversation history = ~80-90% of the budget) and only show 5-15% differences between MCPs — untrustworthy for comparing browser servers. Tool-response size is the part the MCP server actually controls.

| Metric | Public Browser | Playwright MCP | Difference |
|---|---:|---:|---:|
| Tool calls (MCP-only) | 151 | 121 | +25% (PB uses more, smaller calls) |
| Avg Response size | **807 Chars** | 1.448 Chars | **PB 1.8x smaller** |
| Avg Response tokens est. | **201** | 362 | **PB 1.8x smaller** |
| P95 Response | **2.328 Chars** | 8.068 Chars | **PB 3.5x smaller** |
| Total response content | **128k Chars** | 175k Chars | **PB 27% less** |

### Per-Tool Breakdown (where the difference comes from)

| Tool | Public Browser Avg | Playwright MCP Avg | Verdict |
|---|---:|---:|---|
| `view_page` / `browser_snapshot` | **1.124 Chars** (21 calls) | 6.084 Chars (8 calls) | **PB 5.4x more compact per call** |
| `evaluate` / `browser_evaluate` | **510 Chars** (33 calls) | 2.155 Chars (47 calls) | **PB 4.2x more compact per call** |
| `type` / `browser_type` | **88 Chars** (13 calls) | 147 Chars (13 calls) | PB 1.7x more compact |
| `click` / `browser_click` | 1.278 Chars (63 calls) | **463 Chars** (44 calls) | Playwright 2.8x leaner — but see trade-off below |

### The Ambient-Context trade-off

> **Ambient Context — Claude sees DOM changes for free, no extra `view_page` needed**

Public Browser's `click` is 2.8x larger than Playwright's because every click response embeds the DOM diff (NEW/REMOVED/CHANGED lines). Playwright returns a bare confirmation, forcing the LLM to follow up with a `browser_snapshot` or `browser_evaluate` to see what happened. Over a full benchmark run, this cascade costs Playwright MCP **47 extra `browser_evaluate` calls** averaging 2.155 chars each. Public Browser delivers the diff inline. Net result: PB's click+read_page+evaluate total is **120k chars vs Playwright MCP's 170k** — 30% less response content overall.

> **`view_page` is 5.4x more compact than Playwright MCP's `browser_snapshot`**

Measured on the 35-test benchmark (2026-04-09): Public Browser's `view_page` averages **1.124 chars per call** vs Playwright MCP's `browser_snapshot` at **6.084 chars**. Same page, same test suite, same LLM driver. The a11y-tree compression + Ambient Context pipeline means we only send what the agent actually needs — smaller responses, less context pressure, cheaper runs.

See [`test-hardest/BENCHMARK-PROTOCOL.md`](test-hardest/BENCHMARK-PROTOCOL.md) for the full protocol, per-test breakdown, and raw JSON runs with `tool_efficiency` blocks.

## Cortex — Self-Learning Pattern Engine

Public Browser includes a lightweight learning layer called **Cortex**. It observes which tool sequences work on different page types and feeds that knowledge back as hints to the LLM agent. No ML model, no training step — just deterministic pattern recording and Markov-chain predictions.

### How it works

1. **Page Classification** — Every page is classified by its accessibility tree into one of 16 functional types: `login`, `signup`, `mfa`, `search_form`, `search_results`, `data_table`, `form_simple`, `form_wizard`, `article`, `navigation`, `dashboard`, `settings`, `media`, `checkout`, `profile`, `error`. The classifier is rule-based (ARIA roles, landmarks, keyword signals) — no domains or URLs are involved.

2. **Pattern Recording** — Successful tool-call sequences (e.g. `navigate → view_page → fill_form → click` on a `login` page) are recorded into a local append-only Merkle log (`~/.public-browser/patterns.jsonl`). Only page type, tool names, a content hash, and a timestamp are stored — no URLs, no page content, no PII.

3. **Markov Predictions** — Recorded patterns are ingested into a first-order Markov table that models `P(next_tool | last_tool, page_type)`. When the agent lands on a page, the Cortex returns the most likely next tools with probabilities. Stale entries decay automatically (0.95/week, removed after 30 days).

4. **Community Markov Table** — A hand-curated transition table (`community-markov.json`) ships with every installation. It contains baseline probabilities for common page types so that new installations benefit from community knowledge immediately, without needing local history. The table is SHA-256 verified at load time and merged with local patterns (local data takes precedence).

### Privacy by design

The Cortex stores and transmits only structural metadata — page types (not domains), tool names (not arguments), and content hashes (not content). A `login` pattern reveals nothing about *which* login page was visited. The telemetry payload is built via explicit field allowlist (no spread operator), preventing accidental leakage of future fields.

### Opt-in telemetry

Telemetry is **disabled by default**. To contribute your anonymised patterns back to the community table, set `PUBLIC_BROWSER_TELEMETRY=1`. Uploads go via HTTPS only; non-HTTPS endpoints are rejected. Each pattern is rate-limited to prevent duplicate uploads.

## Architecture

```
Public Browser (Node.js MCP server, public-browser)
+-- @modelcontextprotocol/sdk (stdio transport)
+-- CDP Client
|   +-- WebSocket transport (existing Chrome on :9222)
|   +-- Pipe transport (auto-launched Chrome with --remote-debugging-pipe)
+-- Auto-Launch: Chrome + optimal flags, visible by default
+-- A11y-tree cache + Selector cache
+-- Session Manager (OOPIF support for iframes and Shadow DOM)
+-- Tab State Cache (URL/title/ready across tabs)
+-- Cortex (self-learning pattern engine)
|   +-- Page Classifier (16 page types from a11y-tree)
|   +-- Pattern Recorder + Merkle Log (local persistence)
|   +-- Markov Table (transition predictions)
|   +-- Community Table (shipped baseline, SHA-256 verified)
|   +-- Hint Matcher (delivers predictions to tool responses)
|   +-- Telemetry Upload (opt-in, HTTPS, rate-limited)
+-- Script API (Python, pip install publicbrowser)
|   +-- Shared Core via HTTP (:9223) — same tool handlers as MCP
|   +-- Escape Hatch via WebSocket (:9222) — direct CDP for power users
+-- 23 tools
    Reading - Interaction - Navigation - Scripting - Observation
```

Connection priority:
1. **Auto-Launch (default, zero-config)** — starts Chrome as a child process via `--remote-debugging-pipe`, visible as a window, with all flags set for reliable screenshots and keyboard focus.
2. **WebSocket (optional)** — if you already run Chrome with `--remote-debugging-port=9222`, Public Browser connects to that instead. Use this to control your own browser with its extensions and login sessions.

## Requirements

- Node.js >= 18
- Google Chrome, Chromium, or any Chromium-based browser (auto-detected on macOS/Linux/Windows; override with `CHROME_PATH`)

## Environment Variables

| Variable | Values | Default | Description |
|---|---|---|---|
| `SILBERCUE_CHROME_AUTO_LAUNCH` | `true` / `false` | `true` | Auto-launch Chrome if no running instance found |
| `SILBERCUE_CHROME_HEADLESS` | `true` / `false` | `false` | Opt-in headless mode for CI/server environments |
| `SILBERCUE_CHROME_PORT` | `1`–`65535` | `9222` | CDP debugging port. Non-default values spawn an isolated Chrome instance (separate `--user-data-dir`) that won't conflict with the user's browser |
| `SILBERCUE_CHROME_PROFILE` | path | — | Chrome user profile directory (auto-launch only) |
| `CHROME_PATH` | path | — | Path to Chrome binary (overrides auto-detection) |
| `PUBLIC_BROWSER_TELEMETRY` | `1` / `true` | — (disabled) | Opt-in: upload anonymised Cortex patterns to the community endpoint |
| `PUBLIC_BROWSER_TELEMETRY_ENDPOINT` | URL | `https://cortex.public-browser.dev/v1/patterns` | Override the telemetry collection endpoint (must be HTTPS) |

## Known Issues

### BUG-003: WebSocket `Sec-WebSocket-Accept` Mismatch (Node 22 + Chrome 146)

When connecting to an already-running Chrome via `--remote-debugging-port=9222` (WebSocket transport), Node 22's undici 6.21.1 produces a different `Sec-WebSocket-Accept` hash than Chrome 146 expects. This is a confirmed bug in Node 22's native WebSocket implementation.

**Workaround:** The Accept validation is skipped — safe because the connection is to a localhost CDP endpoint. The workaround is already active in the shipped code.

**Auto-Launch is NOT affected.** The default mode (auto-launch) uses `--remote-debugging-pipe` which bypasses WebSocket entirely. You only hit this if you manually start Chrome with `--remote-debugging-port` and connect via `--attach`.

## License

MIT licensed — see [LICENSE](LICENSE). Use it however you want, commercially or otherwise.

## Contributing

Issues and pull requests welcome at [github.com/Silbercue/public-browser](https://github.com/Silbercue/public-browser).

## Privacy

Public Browser runs entirely on your machine. All browser automation happens locally via CDP. The Cortex learning layer stores only structural metadata locally (page types, tool names, content hashes — no URLs, no domains, no page content, no PII). Telemetry is **off by default**. If you opt in via `PUBLIC_BROWSER_TELEMETRY=1`, only the same structural metadata is uploaded via HTTPS — the payload is built from an explicit field allowlist to prevent accidental leakage.

## Links

- [GitHub Repository](https://github.com/Silbercue/public-browser)
- [npm Package](https://www.npmjs.com/package/public-browser)
- [Benchmark Test Site](https://mcp-test.second-truth.com)
