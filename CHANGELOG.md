# Changelog

## [1.0.0] - 2026-04-15

### Added
- 23 MCP tools for Chrome browser automation (10 Default, 13 Extended; 6 Pro-gated)
- `run_plan`: Server-side batch execution of multiple browser actions in a single tool call with variables, conditions, suspend/resume
- `virtual_desk`: Session management entry point — lists tabs, shows status, steers the LLM to the right tool
- Zero-Config Chrome launch via `npx @silbercue/chrome@latest` and `--attach` mode for connecting to running Chrome
- Free/Pro license model via Polar.sh (Free: full 10-tool default set; Pro: 23 tools + parallel run_plan)
- Ambient Context: DOM-diff (NEW/REMOVED/CHANGED lines) included inline after click — no extra view_page needed
- Progressive A11y-Tree with token budget and 50K safety cap
- Speculative prefetch during LLM think time
- Anti-Pattern Detection: evaluate-spiral streak detector with situational fail-hints (BUG-018 mitigation)
- Tool steering via negative delimitation in tool descriptions
- Configurable tool profiles (Default 10, Full 23 via `SILBERCUE_CHROME_FULL_TOOLS`)
- Multi-tab management (Pro: `switch_tab`, `virtual_desk`)
- Download tracking with status and session history
- Auto-reconnect with state preservation
- Shadow DOM + cross-origin iframe (OOPIF) support
- Drag-and-drop via native CDP mouse events
- `press_key` with real CDP keyboard events and ref/selector target focus
- `fill_form` for multi-field form filling in a single call
- `observe` tool — MutationObserver + polling hybrid for DOM change detection
- Container-aware scrolling (`scroll` with container_ref/container_selector)
- `inspect_element` for CSS debugging with computed styles, CSS rules, cascade, and visual clip

### Epic Overview

| Epic | Scope |
|------|-------|
| 1 — Page Reading & Navigation | A11y-Tree with stable refs, progressive depth, screenshots, tab status, URL navigation |
| 2 — Element Interaction | Click, type, fill_form, scroll, press_key (Pro), drag-and-drop |
| 3 — Automated Multi-Step Workflows | run_plan batch execution, evaluate, wait_for, observe, step-limit partial results |
| 4 — Tab & Download Management | Multi-tab open/switch/close (Pro), tab overview, download status and history |
| 5 — Connection & Reliability | Chrome auto-launch, --attach mode, auto-reconnect with state preservation |
| 6 — Intelligent Tool Steering | Anti-pattern detection, stale-ref recovery, negative delimitation, tool profiles, DOM-diff |
| 7 — Distribution & Licensing | npx zero-install, Polar.sh license keys, 7-day grace period, free-tier completeness |
| 8 — Documentation & v1.0 Release | README, CHANGELOG, MCP server instructions audit, release checklist |

### Benchmark Results (mcp-test.second-truth.com, 24 LLM-driven tests)

| Server | Pass Rate | Tool Calls | Duration |
|--------|-----------|------------|----------|
| **SilbercueChrome MCP** | **24/24 (100%)** | **71** | **350s** |
| Playwright MCP | 24/24 (100%) | 138 | 570s |
| claude-in-chrome | 24/24 (100%) | 193 | 772s |
| browser-use | 16/24 (67%) | 124 | 1813s |

SilbercueChrome achieves the same 100% pass rate as Playwright MCP and claude-in-chrome with 49-63% fewer tool calls. Extended benchmark (35 tests including Level 5): 34/35 passed, 1 skipped (chrome://crash safety).

### Known Issues
- BUG-003: WebSocket Sec-WebSocket-Accept mismatch (Node 22 + Chrome 146) — Accept-Check deactivated, auto-launch not affected

### Breaking Changes (vs. pre-release)
- `read_page` renamed to `view_page`
- `screenshot` renamed to `capture_image`

### Deferred (post-v1.0)
- Story 6.1: Evaluate Anti-Spiral v2 — three new anti-patterns, situational tool steering (planned for v1.1)
- Story 6.2: Pro DOM-Diff for `type` and `fill_form` (planned for v1.1)
