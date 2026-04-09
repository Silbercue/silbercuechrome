# SilbercueChrome

[![GitHub Release](https://img.shields.io/github/v/release/Silbercue/silbercuechrome)](https://github.com/Silbercue/silbercuechrome/releases)
[![npm version](https://img.shields.io/npm/v/@silbercue%2Fchrome)](https://www.npmjs.com/package/@silbercue/chrome)
[![Free — 18 tools](https://img.shields.io/badge/Free-18_tools-brightgreen)](https://github.com/Silbercue/silbercuechrome#free-vs-pro)
[![Pro — 21+ tools](https://img.shields.io/badge/Pro-21%2B_tools-blueviolet)](https://polar.sh/silbercuechrome)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

The most token-efficient MCP server for Chrome browser automation. Direct CDP, a11y-tree refs, multi-tab ready. **30/31 on the hardest 35-test benchmark (97% pass rate) with Ambient Context — `read_page` is 5.4× more compact than Playwright MCP's `browser_snapshot`, and our P95 tool response is 3.5× smaller.**

Built for [Claude Code](https://claude.ai/claude-code), [Cursor](https://cursor.sh), and any MCP-compatible client.

> **Looking for an alternative to Playwright MCP, Browser MCP, or claude-in-chrome?** SilbercueChrome talks to Chrome directly via the DevTools Protocol — no Playwright dependency, no Chrome extension bridge, no single-tab limit. One command to install, zero config, and the best benchmark score in the category. [See comparison below](#benchmarks).

## Why SilbercueChrome?

Every Chrome MCP server has the same problem: **too many tokens, too few reliable refs.** Screenshots eat 10-30x more tokens than text trees. Selector-based refs break the second the DOM rerenders. Extension bridges (Browser MCP) get stuck on the connected tab. Playwright wrappers spin up a new browser instance for every session.

SilbercueChrome fixes this. It talks directly to Chrome via CDP (same protocol Playwright and Puppeteer use internally), returns an accessibility-tree-based reference map, and caches it across calls so `click(ref: 'e5')` and `type(ref: 'e7', ...)` survive scrolls and DOM updates.

| What you get | Playwright MCP | Browser MCP | claude-in-chrome | browser-use | **SilbercueChrome** |
|---|---|---|---|---|---|
| Hardest benchmark (35 tests, LLM-driven) | 29/31 (563s) | **cannot finish** | (pending re-bench) | (pending re-bench) | **30/31 Free: 598s** |
| ∅ Tool-Response (Tokens est.) | 362 | — | — | — | **201 (1.8× smaller)** |
| P95 Tool-Response (Chars) | 8.068 | — | — | — | **2.328 (3.5× smaller)** |
| `read_page` avg (Chars) | 6.084 (`browser_snapshot`) | — | — | — | **1.124 (5.4× smaller)** |
| Multi-tab support | Yes | **No (single tab)** | Yes | Partial | **Yes** |
| Connection | New browser | Extension bridge | Extension | Subprocess | **Direct CDP (pipe or WebSocket)** |
| Ref system | Playwright refs | Playwright refs | CSS selectors | Screenshots | **A11y-tree refs (stable across DOM changes)** |
| Read page | Screenshot + DOM | Snapshot | DOM dump | Screenshot-heavy | **`read_page` — 10-30x fewer tokens** |
| Drag & drop | Yes | No | Partial | No | **Yes (native CDP mouse events)** |
| Shadow DOM + iframe | Yes | Yes | Partial | No | **Yes (with OOPIF session support)** |
| Keyboard shortcuts | Yes | Yes | Partial | No | **Yes (`press_key` with real CDP keyboard events)** |
| localStorage/cookies | Yes | No | Partial | No | **Yes (via `evaluate`)** |
| Multi-step plan execution | — | — | — | — | **`run_plan` — server-side plan executor with variables, conditions, suspend/resume** |
| Zero-config install | Yes | Yes | Built-in | Yes | **Yes (one `claude mcp add` line)** |

### Where SilbercueChrome really shines

> ![killer feat](https://img.shields.io/badge/killer%20feat-%23FFD700?style=flat-square) **Ambient Context — Claude sees DOM changes for free, no extra `read_page` needed**

After every `click`, SilbercueChrome's response includes **NEW / REMOVED / CHANGED** lines showing exactly what changed on the page. Playwright MCP's `browser_click` only returns "clicked element X" — Claude then has to call `browser_snapshot` or `browser_evaluate` to figure out what happened. Over a full benchmark run, this means Playwright needs **47 extra `browser_evaluate` calls** averaging 2.155 chars each just to reconstruct page state. SC delivers the diff inline, so the same workflow needs only **33 evaluate calls averaging 510 chars**. Result: **~30% less total response content** across the three main tools (click + read_page + evaluate: 120k vs 170k chars).

> ![killer feat](https://img.shields.io/badge/killer%20feat-%23FFD700?style=flat-square) **`read_page` is 5.4× more compact than Playwright MCP's `browser_snapshot`**

Measured on the 35-test hardest benchmark (2026-04-09): SC's `read_page` averages **1.124 chars per call** vs Playwright MCP's `browser_snapshot` at **6.084 chars**. Same page, same test suite, same LLM driver. The difference is the Ambient Context pipeline + a11y-tree compression — we only send what the agent actually needs, filtered to interactive elements by default. Smaller responses mean less context pressure, more room for reasoning, and cheaper runs.

> ![killer feat](https://img.shields.io/badge/killer%20feat-%23FFD700?style=flat-square) **P95 Tool-Response is 3.5× smaller than Playwright MCP**

The worst-case tool response is what really eats context budgets. SC's 95th-percentile response is **2.328 chars** vs Playwright MCP's **8.068 chars**. Even the most expensive SC call is cheaper than Playwright's typical snapshot. This compounds over long agent runs where the biggest responses decide whether the context window survives.

> ![killer feat](https://img.shields.io/badge/killer%20feat-%23FFD700?style=flat-square) **True multi-tab — `virtual_desk`, `switch_tab`, parallel tabs in `run_plan`** <img src="https://img.shields.io/badge/Pro-blueviolet?style=flat-square" align="center">

Browser MCP binds to a single "connected" tab via its Chrome extension — cross-tab operations are architecturally impossible. SilbercueChrome uses CDP `Target` API to enumerate, open, close, and switch between tabs. `virtual_desk` lists every open tab with stable IDs. `switch_tab` moves between them without touching the user's active tab. `run_plan` even supports parallel tab execution.

> ![strong](https://img.shields.io/badge/strong-%23C0C0C0?style=flat-square) **`fill_form` — one call for a complete form**

Other MCPs make you emit N `type` calls for an N-field form. `fill_form` takes a single `fields[]` array with refs and values, handles text inputs, `<select>` (by value or label), checkboxes, and radios in one CDP round-trip, and reports per-field status.

> ![strong](https://img.shields.io/badge/strong-%23C0C0C0?style=flat-square) **`observe` — watch DOM changes without writing JavaScript**

Two modes: `collect` (watch for N ms, return every text/attribute change) and `until` (wait for a condition, then auto-click). Use `click_first` to trigger the action that causes changes — the observer is set up *before* the click, so nothing is missed. Replaces the typical `setInterval`/`MutationObserver`/`evaluate` dance.

> ![strong](https://img.shields.io/badge/strong-%23C0C0C0?style=flat-square) **`run_plan` — server-side multi-step automation**

Execute a sequence of tool steps server-side with variables (`$varName`), conditions (`if`), `saveAs`, error strategies (`abort`/`continue`/`screenshot`), and suspend/resume for long-running workflows. Parallel tab execution is a Pro feature.

## Quick Start

### Install in Claude Code

One command — installs globally for all projects:

```bash
claude mcp add --scope user silbercuechrome npx -y @silbercue/chrome@latest
```

Restart Claude Code. First tool call auto-launches Chrome **visible** (no headless, no port setup). Done.

### Install in Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "silbercuechrome": {
      "command": "npx",
      "args": ["-y", "@silbercue/chrome@latest"]
    }
  }
}
```

### Install in other MCP clients

Any client that supports stdio MCP servers: `npx -y @silbercue/chrome@latest` with no arguments.

### Install Pro via Homebrew

Pro adds `virtual_desk`, `switch_tab`, `dom_snapshot`, parallel tabs in `run_plan`, ambient context hooks, and an operator hook pipeline on top of the 18 Free tools. Three commands, no JSON edits:

```bash
brew install silbercue/silbercue/silbercuechrome
claude mcp add --scope user silbercuechrome /opt/homebrew/bin/silbercuechrome
silbercuechrome activate SCC-XXXX-XXXX-XXXX-XXXX
```

**Important — restart Claude Code completely after `claude mcp add`.** `/mcp reconnect` is *not* enough. Claude Code reads the `mcpServers` config only at session start and caches it; the old command is re-used even after `reconnect`. Fully quit Claude Code and reopen it so the new `silbercuechrome` server is picked up.

After the restart, `silbercuechrome status` should print `Tier: Pro, Tools: 23`. Get a license (one-time $19) at [polar.sh/silbercuechrome](https://polar.sh/silbercuechrome) — the key arrives by email and can be activated as shown above.

Google Chrome must be installed on the machine — SilbercueChrome auto-launches Chrome via CDP at runtime, but it does not install Chrome for you.

### Uninstall

```bash
# Free (npx install)
claude mcp remove --scope user silbercuechrome

# Pro (Homebrew install)
silbercuechrome deactivate   # wipes license cache
claude mcp remove --scope user silbercuechrome
brew uninstall silbercue/silbercue/silbercuechrome
```

## Free vs Pro

The Free tier gives you 18 tools covering 24/24 benchmark tests in the scripted runner. Pro adds `virtual_desk`, `switch_tab`, `dom_snapshot`, and advanced `run_plan` features (parallel tabs, operator hooks, ambient context) plus faster internals.

| | Free | Pro |
|---|---|---|
| Tools | 18 | 21+ |
| Page understanding | `read_page` | `read_page` + `dom_snapshot` (spatial queries) |
| Tab management | `navigate`, `tab_status` | + `virtual_desk`, `switch_tab`, parallel tabs in `run_plan` |
| Interaction | `click`, `type`, `fill_form`, `press_key`, `scroll`, `file_upload`, `handle_dialog` | Same |
| Observation | `screenshot`, `wait_for`, `observe`, `console_logs`, `network_monitor` | Same + ambient page context hooks |
| Scripting | `run_plan` (sequential) | `run_plan` (sequential + parallel + operator hooks) |
| Last resort | `evaluate` | `evaluate` + anti-pattern scanner hints |
| Benchmark score | 24/24 | 24/24 |
| Benchmark time (scripted) | ~20s | ~21s |
| Benchmark time (LLM-driven) | 755-900s | ~555s |

Pro costs $19 USD one-time. [Get a license on Polar.sh](https://polar.sh/silbercuechrome), then follow [Install Pro via Homebrew](#install-pro-via-homebrew) above — three commands, no manual download, no env-var editing. License keys arrive by email and are activated with `silbercuechrome activate <YOUR-LICENSE-KEY>`. (The `SILBERCUECHROME_LICENSE_KEY=...` env var still works as an alternative for non-Homebrew installs.)

## Tools

### Reading & Observation

| Tool | Description |
|---|---|
| `read_page` | Accessibility tree with stable `e`-refs — primary way to understand the page. 10-30x cheaper than screenshots. Filter by `interactive` (default) or `all` (include static text). |
| `screenshot` | WebP capture, max 800px, <100KB. Use for visual verification only — you cannot use screenshots to drive click/type, refs come from `read_page`. |
| `console_logs` | Retrieve browser console output with level/pattern filters |
| `network_monitor` | Start/stop/query network requests with filtering |
| `observe` | Watch DOM changes: `collect` (buffer changes over time) or `until` (wait for condition, then auto-click) |
| `wait_for` | Wait for element visible, network idle, or JS expression true |
| `tab_status` | Active tab's cached URL/title/ready/errors — mid-workflow sanity check |

### Interaction

| Tool | Description |
|---|---|
| `click` | Real CDP mouse events (mouseMoved/Pressed/Released). Click by ref, selector, text, or `x`+`y` coordinates. Response includes DOM diff (NEW/REMOVED/CHANGED). |
| `type` | Type into an input by ref/selector |
| `fill_form` | Fill a complete form in one call — text, `<select>`, checkbox, radio. Per-field status, partial errors don't abort. |
| `press_key` | Real CDP keyboard events — Enter, Escape, Tab, arrows, shortcuts (Ctrl+K, etc.) |
| `scroll` | Scroll page, element into view, or inside a specific container (sidebar, modal body) |
| `file_upload` | Upload file(s) to an `<input type="file">` |
| `handle_dialog` | Configure `alert`/`confirm`/`prompt` handling before triggering actions |

### Navigation

| Tool | Description |
|---|---|
| `navigate` | Load a URL in the active tab. Waits for settle. First call per session is auto-redirected to `virtual_desk` to prevent blindly overwriting the user's tab. |

### Scripting

| Tool | Description |
|---|---|
| `run_plan` | Execute a multi-step plan server-side. Variables (`$varName`), conditions (`if`), `saveAs`, error strategies (`abort`/`continue`/`screenshot`), suspend/resume. Parallel tabs require Pro. |
| `configure_session` | View/set session defaults (tab, timeout) and accept auto-promote suggestions |
| `evaluate` | Execute JS in the page context. Use for COMPUTE or side effects no tool covers — not for element discovery (use `read_page` instead). Anti-pattern scanner warns when you reach for `querySelector` or `.click()`. |

### Pro tier (additional)

| Tool | Description |
|---|---|
| `virtual_desk` <img src="https://img.shields.io/badge/Pro-blueviolet?style=flat-square" align="center"> | Lists all tabs with stable IDs. Call first in every session. |
| `switch_tab` <img src="https://img.shields.io/badge/Pro-blueviolet?style=flat-square" align="center"> | Open, switch to, or close tabs by ID from `virtual_desk` |
| `dom_snapshot` <img src="https://img.shields.io/badge/Pro-blueviolet?style=flat-square" align="center"> | Bounding boxes, computed styles, paint order, colors. For spatial questions `read_page` cannot answer. |

## Benchmarks

Measured on `https://mcp-test.second-truth.com` — **35 tests in 5 levels** (Basics, Intermediate, Advanced, Hardest, Community Pain Points). Each run is independent, values on the benchmark page are randomized per page-load, all runs started in a fresh Claude Code session out of `/tmp` (no project context bias), and **all metrics measured post-hoc from the session JSONL** via [`test-hardest/measure-tool-calls.sh`](.claude/skills/benchmarkTest/measure-tool-calls.sh) — no self-reporting, no MCP-side instrumentation, just counting `tool_use` blocks and `tool_result` char lengths.

### Pass Rate + Duration (35-Test Suite, 2026-04-09)

| MCP | Passed | Duration |
|---|---|---|
| **SilbercueChrome Free** | **30/31 (97%)** | **598s** |
| Playwright MCP | 29/31 (94%) | 563s |
| Playwright CLI | 28/31 (90%) | 376s |

**Pending re-bench on the new 35-test suite:** SilbercueChrome Pro, chrome-browser, claude-in-chrome, browser-use, Browser MCP. The previous 24-test results are archived in the git history.

### Tool-Efficiency (the fair metric)

We measure each tool call's response char length directly, group by tool name, estimate tokens via `chars/4`. Why this metric: session-level token deltas are dominated by LLM overhead (system prompt + CLAUDE.md + conversation history = ~80-90% of the budget) and only show 5-15% differences between MCPs — untrustworthy for comparing browser servers. Tool-response size is the part the MCP server actually controls.

| Metric | SC Free | Playwright MCP | Difference |
|---|---:|---:|---:|
| Tool calls (MCP-only) | 151 | 121 | +25% (SC uses more, smaller calls) |
| ∅ Response size | **807 Chars** | 1.448 Chars | **SC 1.8× smaller** |
| ∅ Response tokens est. | **201** | 362 | **SC 1.8× smaller** |
| P95 Response | **2.328 Chars** | 8.068 Chars | **SC 3.5× smaller** |
| Total response content | **128k Chars** | 175k Chars | **SC 27% less** |

### Per-Tool Breakdown (where the difference comes from)

| Tool | SC Free ∅ | Playwright MCP ∅ | Verdict |
|---|---:|---:|---|
| `read_page` / `browser_snapshot` | **1.124 Chars** (21 calls) | 6.084 Chars (8 calls) | **SC 5.4× more compact per call** |
| `evaluate` / `browser_evaluate` | **510 Chars** (33 calls) | 2.155 Chars (47 calls) | **SC 4.2× more compact per call** |
| `type` / `browser_type` | **88 Chars** (13 calls) | 147 Chars (13 calls) | SC 1.7× more compact |
| `click` / `browser_click` | 1.278 Chars (63 calls) | **463 Chars** (44 calls) | Playwright 2.8× leaner — but see trade-off below |

**The Ambient-Context trade-off (worth understanding):** SC's `click` is 2.8× larger than Playwright's because every SC click response embeds the DOM diff (NEW/REMOVED/CHANGED lines). Playwright returns a bare confirmation, which means the LLM has to follow up with a `browser_snapshot` or `browser_evaluate` to see what happened. Over the full run, this cascade costs Playwright MCP **47 extra `browser_evaluate` calls**. Net result: SC's click+read_page+evaluate total is **120k chars vs Playwright MCP's 170k** — 30% less response content overall, despite the "thicker" click responses.

See [`test-hardest/BENCHMARK-PROTOCOL.md`](test-hardest/BENCHMARK-PROTOCOL.md) for the full protocol, per-test breakdown, and raw JSON runs with `tool_efficiency` blocks.

## Architecture

```
SilbercueChrome (Node.js MCP server, @silbercue/chrome)
├── @modelcontextprotocol/sdk (stdio transport)
├── CDP Client
│   ├── WebSocket transport (existing Chrome on :9222)
│   └── Pipe transport (auto-launched Chrome with --remote-debugging-pipe)
├── Auto-Launch: Chrome + optimal flags, visible by default
├── A11y-tree cache + Selector cache
├── Session Manager (OOPIF support for iframes and Shadow DOM)
├── Tab State Cache (URL/title/ready across tabs)
└── 18 Free-tier tools + 3+ Pro-tier tools
    Reading · Interaction · Navigation · Scripting · Observation
```

Connection priority:
1. **Auto-Launch (default, zero-config)** — starts Chrome as a child process via `--remote-debugging-pipe`, visible as a window, with all flags set for reliable screenshots and keyboard focus.
2. **WebSocket (optional)** — if you already run Chrome with `--remote-debugging-port=9222`, SilbercueChrome connects to that instead. Use this to control your own browser with its extensions and login sessions.

## Requirements

- Node.js >= 18
- Google Chrome, Chromium, or any Chromium-based browser (auto-detected on macOS/Linux/Windows; override with `CHROME_PATH`)

## Environment Variables

| Variable | Values | Default | Description |
|---|---|---|---|
| `SILBERCUE_CHROME_AUTO_LAUNCH` | `true` / `false` | `true` | Auto-launch Chrome if no running instance found |
| `SILBERCUE_CHROME_HEADLESS` | `true` / `false` | `false` | Opt-in headless mode for CI/server environments |
| `SILBERCUE_CHROME_PROFILE` | path | — | Chrome user profile directory (auto-launch only) |
| `CHROME_PATH` | path | — | Path to Chrome binary (overrides auto-detection) |
| `SILBERCUECHROME_LICENSE_KEY` | license key | — | Pro license key (e.g. `SC-PRO-...`) |

## License

The core server and all 18 Free-tier tools are **MIT licensed** — see [LICENSE](LICENSE). Use them however you want, commercially or otherwise.

Pro tools (3+ gated tools, parallel tab execution, ambient context, operator hooks, faster internals) require a [paid license](https://polar.sh/silbercuechrome). The license validation code is in the separate private Pro repository.

## Contributing

Issues and pull requests welcome at [github.com/Silbercue/silbercuechrome](https://github.com/Silbercue/silbercuechrome).

## Privacy

SilbercueChrome runs entirely on your machine. All browser automation happens locally via CDP. No telemetry, no remote calls, no data sent to any third party.
