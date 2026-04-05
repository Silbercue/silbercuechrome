# MCP Benchmark Protocol

## Ziel
Fairer, reproduzierbarer Vergleich verschiedener Browser-MCP-Server.
Alle Tests laufen auf https://mcp-test.second-truth.com — Werte sind bei jedem Page-Load randomisiert.

## Anti-Bias Massnahmen

1. **Randomisierte Werte** — Alle Testwerte werden bei jedem Page-Load neu generiert. Quellcode-Kenntnis hilft nicht.
2. **Frische Session** — Jeder Run startet eine NEUE Claude Code Session aus `/tmp` (kein Projektkontext).
3. **Standard-Prompt** — Jeder MCP bekommt exakt denselben Prompt. Keine Hints, kein Vorwissen.
4. **Nur ein MCP aktiv** — Alle anderen Browser-MCPs werden deaktiviert.
5. **Automatischer Export** — Ergebnisse werden per JSON exportiert, nicht manuell notiert.
6. **Headed-Modus** — SC laeuft mit `SILBERCUE_CHROME_HEADLESS=false` fuer Fairness.

## Standard-Prompt

```
Use [MCP-NAME] tools for all browser interactions. Do not use any other browser automation tool.

Navigate to https://mcp-test.second-truth.com and complete ALL tests on the page.

The page has 4 levels with 6 tests each (24 total). Each test has instructions displayed on the page.
Read the instructions, perform the required actions, and verify each test.

Work through all levels in order: Level 1 (Basics), Level 2 (Intermediate), Level 3 (Advanced), Level 4 (Hardest).

After completing all tests, go to the "Results" tab and click "Export as JSON". Return the full JSON output.

Important:
- Do NOT assume any test values — read them from the page
- Some tests require waiting for async content
- Some tests require keyboard shortcuts
- Some tests involve Shadow DOM and iFrames
- The "Compare" tab is for storing results — save your run there with the name "[MCP-NAME] Run [N]"
```

## Ergebnisse (Stand 2026-04-05)

### Uebersicht

| MCP | Passed | Failed | Skips | Zeit | Runs |
|-----|--------|--------|-------|------|------|
| **SilbercueChrome Pro** | 24/24 (100%) | 0 | 0 | 21s (scripted), 555s (LLM) | 2 |
| **SilbercueChrome Free** | 24/24 (100%) | 0 | 0 | 20s (scripted), 755s-900s (LLM) | 3 |
| **Playwright MCP** | 24/24 (100%) | 0 | 0 | — | 1 |
| **claude-in-chrome** | 24/24 (100%) | 0 | 0 | 1140s | 1 |
| **browser-use** | 17/24 (71%) | 0-3 | 5-7 | ~1049s | 2 (gueltig) |

### browser-use Limitierungen (7 nie geschaffte Tests)

- T2.2 Infinite Scroll — kein Container-internes Scrollen
- T3.3 Drag & Drop — nicht unterstuetzt
- T3.4 Canvas Click — Koordinaten ungenau
- T3.5 Keyboard Shortcuts — nicht unterstuetzt
- T3.6 Contenteditable Bold — kein Keyboard-Support
- T4.4 localStorage+Cookie — kein JS-Execution
- T4.5 Mutation Observer — kein JS-Execution

### SilbercueChrome Bugs (gefunden im Benchmark)

- BUG-001: `read_page` liefert unspezifischen Tabellen-Kontext (T1.6, T2.6)
- BUG-002: `click()` dispatcht mousedown-Events nicht korrekt (T2.4)
- BUG-006: GEFIXT — type/focus nach Shadow-DOM (JS-Fallback this.focus())
- BUG-010: GEFIXT — read_page interactive nach Scroll/DOM (Precomputed-Cache Invalidierung)
- Details: `docs/deferred-work.md`

### Ungueltige Runs (verworfen)

- browser-use Run 1 + Run 2: Im SilbercueChrome-Projektordner ausgefuehrt (CLAUDE.md Bias) und vermutlich andere MCPs aktiv
- SC Free Run 1: Headless-Modus (nicht vergleichbar mit headed-MCPs)

## TODO

- [x] Polar.sh Produkt fuer SilbercueChrome Pro anlegen
- [x] License Key generieren und aktivieren
- [x] SilbercueChrome Pro Run 1 durchfuehren
- [x] Ergebnisse auf Benchmark-Seite veroeffentlichen (Compare-Tab mit vorgeladenen Daten)

## Ergebnis-Dateien

```
test-hardest/results/
  browser-use-run1.json          (ungueltig — Projektordner + andere MCPs)
  browser-use-run2.json          (ungueltig — Projektordner + andere MCPs)
  browser-use-run3.json          (gueltig)
  browser-use-run4.json          (gueltig)
  playwright-mcp-run1.json       (gueltig)
  claude-in-chrome-run1.json     (gueltig)
  silbercuechrome-free-run1.json (gueltig, headless, LLM)
  silbercuechrome-free-run2.json (gueltig, headed, LLM)
  silbercuechrome-free-run3.json (gueltig, scripted, 24/24, 20s, post-BUG-006+010-Fix)
  silbercuechrome-pro-run1.json  (gueltig, headed, LLM)
  silbercuechrome-pro-run2.json  (gueltig, scripted, 24/24, 21s, post-BUG-006+010-Fix)
```
