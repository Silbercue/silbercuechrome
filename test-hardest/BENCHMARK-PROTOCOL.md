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

The page has 5 levels with 35 tests total (6+6+6+7+10). Each test has instructions displayed on the page.
Read the instructions, perform the required actions, and verify each test.

Work through all levels in order: Level 1 (Basics), Level 2 (Intermediate), Level 3 (Advanced), Level 4 (Hardest), Level 5 (Community Pain Points — note that T5.3-T5.6 are Runner-Only and should be marked as skipped).

After completing all tests, go to the "Results" tab and click "Export as JSON". Return the full JSON output.

Important:
- Do NOT assume any test values — read them from the page
- Some tests require waiting for async content
- Some tests require keyboard shortcuts
- Some tests involve Shadow DOM and iFrames
- The "Compare" tab is for storing results — save your run there with the name "[MCP-NAME] Run [N]"
```

## Ergebnisse (Stand 2026-04-09)

### Warum zwei Tabellen?

Wir fuehren zwei Metriken parallel, weil Session-Level-Tokens eine grobe Zahl sind die vom LLM-Overhead dominiert wird (System-Prompt, CLAUDE.md, Conversation-History zusammen ~80-90% des Budgets). Tool-Efficiency ist die faire Vergleichsmetrik fuer das was der MCP-Server tatsaechlich beeinflussen kann: Anzahl Tool-Calls + Groesse der Tool-Antworten.

Die Beobachtung aus den ersten drei Runs: **Session-Delta zwischen SC Free (19.5M) und Playwright MCP (20.3M) ist nur ~4%** — weil die LLM-Kosten fast identisch sind. Erst die Tool-Efficiency-Zahlen (Tabelle 2) zeigen den echten Unterschied im Ambient-Context-Vorteil.

### Tabelle 1 — Session Tokens (grob, LLM-dominiert)

**Hinweis zur Interpretation:** Session-Tokens umfassen System-Prompt, CLAUDE.md, Conversation-History und Tool-Responses zusammen. Da die ersten drei Komponenten bei allen MCPs aehnlich gross sind, sind Session-Deltas nur begrenzt aussagekraeftig — typischer Unterschied zwischen zwei MCPs liegt bei 5-15%, nicht bei 3-5x. **Die primaere Metrik ist Tabelle 2 (Tool-Efficiency) weiter unten.**

**Scope:** Diese Tabelle enthaelt nur die **35-Test-Version** (aktuell). Alte 24-Test-Runs wurden entfernt weil sie nicht direkt vergleichbar sind (Level 5 fehlt komplett) und ihre Fussnoten sich auf entfernte Run-Files beziehen. Alle fruehere Daten sind in der git-Historie bis Commit `9e3c82e` erhalten.

| MCP | Passed | Failed | Skips | Zeit | Runs | Start-Tok | End-Tok | Δ Tokens | Modell |
|-----|--------|--------|-------|------|------|-----------|---------|----------|--------|
| **SilbercueChrome Free** | 30/31 (97%)¹ | 1 | 4 | 598s (LLM) | 1 | 2.984.978 | 29.463.368 | 26.478.390 | opus-4.6 |
| **Playwright MCP** | 29/31 (94%)† | 2 | 4 | 563s (LLM) | 1 | 90.944 | 20.379.196 | 20.288.252 | opus-4.6 |
| **Playwright CLI** | 28/31 (90%)‡ | 3 | 4 | 376s (LLM) | 1 | 29.270.369 | 48.260.695 | 18.990.326 | opus-4.6 |
| SilbercueChrome Pro | — | — | — | — | 0 | — | — | — | — |
| chrome-browser | — | — | — | — | 0 | — | — | — | — |
| claude-in-chrome | — | — | — | — | 0 | — | — | — | — |
| browser-use (MCP) | — | — | — | — | 0 | — | — | — | — |
| browser-use (Skill CLI) | — | — | — | — | 0 | — | — | — | — |
| browser-mcp | — | — | — | — | 0 | — | — | — | — |

Alle mit `—` markierten MCPs warten auf einen frischen Re-Bench-Lauf gegen die 35-Test-Version. Die alten 24-Test-Zahlen waren fuer den Vergleich mit der neuen Metrik nicht mehr brauchbar — die **Tool-Efficiency-Zahlen (Tabelle 2) sind ohnehin die wichtigere Metrik**.

### Tabelle 2 — Tool-Efficiency (die faire Metrik)

Gemessen per `measure-tool-calls.sh`: zaehlt alle `tool_use`-Bloecke in Assistant-Messages, misst `tool_result`-Content-Laenge per Char-Count, gruppiert nach Tool-Name, schaetzt Tokens via `chars/4` (BPE-Naeherung).

**Tool-Calls-Spalte zaehlt nur MCP-Tools** (mit `mcp__<servername>__*`-Prefix), nicht Shell/Task/Edit — so wird der Vergleich zwischen MCPs fair. Avg Response ist das arithmetische Mittel ueber alle MCP-Tool-Responses des Runs.

| MCP | Tool-Calls (MCP-only) | Ø Response (Chars) | Ø Response (Tok est.) | P95 Response (Chars) | Total Response | Runs |
|-----|----------------------:|-------------------:|----------------------:|---------------------:|---------------:|-----:|
| **SilbercueChrome Free**        | 151 | 807 | 201 | 2.328 | 128k | 1⁺ |
| **SilbercueChrome Pro**         | — | — | — | — | — | 0 |
| **Playwright MCP**              | 121 | 1.448 | 362 | 8.068 (snapshot) | 175k | 1⁺ |
| **Playwright CLI**              | 0§  |   —   |  —  |        —         |  —   | 1⁺ |
| **chrome-browser**              | — | — | — | — | — | 0 |
| **claude-in-chrome**            | — | — | — | — | — | 0 |
| **browser-use (MCP)**           | — | — | — | — | — | 0 |
| **browser-mcp**                 | — | — | — | — | — | 0 |

⁺ = Post-Hoc-Analyse aus der Session-JSONL vom 2026-04-09 via `measure-tool-calls.sh` mit Zeitsegmentierung. Die restlichen Zeilen warten auf den naechsten Re-Bench-Lauf pro MCP — fuer SC Free/Pro, browser-use (Skill CLI), chrome-browser, claude-in-chrome, browser-mcp sind die alten Session-JSONLs entweder in frischen `/tmp`-Sessions gelaufen (nicht mehr im Projekt-Slug vorhanden) oder mit anderen Runs in derselben Session vermischt. Saubere Zahlen gibt's erst beim naechsten Lauf gegen den instrumentierten Benchmark (mit `test_timings` im Export).

§ **Playwright CLI hat keine MCP-Tools** — alle Commands laufen als Bash-Subcommands (`playwright-cli click e12` etc.). Der CLI-Run verwendet stattdessen 40 Bash-Calls mit avg 293 Chars + 4 Read-Calls fuer Snapshot-Files (avg 5047 Chars). Nicht direkt in die MCP-only-Tabelle vergleichbar — die beiden Ansaetze haben fundamental unterschiedliche Tool-Topologien. Rohdaten in `results/playwright-cli-run1.json` unter `tool_efficiency.all_tools`.

**Interpretation der Playwright-MCP-Zahlen:** 121 Tool-Calls fuer 31 Tests = **~3.9 Calls pro Test** im Schnitt. Die groesste Response ist `browser_snapshot` mit avg 6084 Chars (p95 8068). `browser_click` ist mit avg 463 Chars erstaunlich kompakt — Playwrights MCP gibt pro Click nur einen Verifikationstext zurueck, keinen kompletten Snapshot. `browser_evaluate` liegt bei 2155 avg, max 41.150 (bei unserem Modal-Snapshot der ans Token-Limit stiess).

**Was wir erwarten** fuer die naechsten Re-Runs:
- **SilbercueChrome Free** sollte bei `click` deutlich **unter** 463 Chars liegen (durch Ambient-Context-Diff statt Verifikationstext), bei `read_page` deutlich **unter** 6084 (durch gefilterten Ambient-Context statt vollstaendigem Snapshot).
- Total-Calls sollten bei SC Free tendenziell hoeher sein (weil keine parallele Tool-Calls moeglich), aber die durchschnittliche Response kleiner.
- Der **Kern-Vergleich** ist `Ø Response (Tok est.)`: wenn SC bei ~100-150 landet vs Playwright MCP bei 362, ist das der 2-3x Vorteil auf Tool-Efficiency-Ebene.

### Per-Tool Breakdown (Deep Dive)

Pro MCP die meistgenutzten Tools mit deren Response-Groessen. Zeigt wo der echte Ambient-Context-Vorteil sichtbar wird: beim Vergleich "SCs read_page vs Playwrights snapshot" sollten die Unterschiede am krassesten sein (Faktor 3-5 erwartet).

#### Playwright MCP (Run 2, Post-Hoc 2026-04-09)

| Tool | Calls | Avg Chars | P95 Chars | Max Chars | Total |
|------|------:|----------:|----------:|----------:|------:|
| `browser_evaluate` | 47 | 2.155 | 5.450 | 41.150 | 101.325 |
| `browser_click`    | 44 |   463 |   562 |    608 |  20.377 |
| `browser_type`     | 13 |   147 |   156 |    162 |   1.912 |
| `browser_snapshot` |  8 | 6.084 | 8.068 |  8.255 |  48.673 |
| `browser_press_key`|  3 |   254 |    —  |    523 |     763 |
| `browser_tabs`     |  2 |   249 |    —  |    295 |     498 |
| `browser_wait_for` |  2 |   459 |    —  |    550 |     919 |
| `browser_fill_form`|  1 |   519 |    —  |    519 |     519 |
| `browser_navigate` |  1 |   333 |    —  |    333 |     333 |
| **Total**          |**121**|**1.448**|  —  |  —    |**175.319**|

**Auffaellig:** `browser_click` ist bei Playwright erstaunlich kompakt (463 Chars avg). `browser_snapshot` ist der Brocken (6084 avg). `browser_evaluate` hat die groesste Varianz (147-41150) weil die Return-Werte beliebig gross sein koennen — unser Benchmark-Run hat absichtlich viel per evaluate geloest.

#### Playwright CLI (Run 1, Post-Hoc 2026-04-09)

Keine MCP-Tools — alle Commands via Bash. Siehe Hinweis unter Tabelle 2.

| Tool | Calls | Avg Chars | P95 Chars | Total |
|------|------:|----------:|----------:|------:|
| `Bash` (playwright-cli commands) | 40 |   293 |   699 | 11.734 |
| `Read` (snapshot-Files)          |  4 | 5.047 | 6.299 | 20.190 |
| `TaskUpdate`                      | 12 |    22 |    23 |    273 |
| **Total**                         |**56**|   574 |  —   | 32.197 |

**Auffaellig:** CLI-Ansatz verteilt die Arbeit auf **weniger LLM-Tool-Calls** (56 vs 141 beim MCP-Run), aber die einzelnen Bash-Calls chainen mehrere CLI-Commands (z.B. `cli click e36 && cli fill e47 ...`). Der LLM-Overhead ist niedriger, aber die tatsaechliche Arbeit auf Chrome-Ebene identisch.

#### SilbercueChrome Free (Run 5, 2026-04-09, 35-Test-Version)

| Tool | Calls | Avg Chars | P95 Chars | Max Chars | Total |
|------|------:|----------:|----------:|----------:|------:|
| `click`         | 63 | 1.278 | 1.497 | 6.113 | 80.563 |
| `evaluate`      | 33 |   510 |   829 | 3.724 | 16.831 |
| `read_page`     | 21 | 1.124 | 2.495 | 3.133 | 23.613 |
| `type`          | 13 |    88 |   103 |   116 |  1.155 |
| `observe`       |  6 |    64 |    73 |    88 |    389 |
| `fill_form`     |  4 |   231 |   255 |   343 |    927 |
| `navigate`      |  4 |   183 |   143 |   382 |    734 |
| `press_key`     |  3 |    40 |    41 |    41 |    122 |
| `wait_for`      |  2 |   173 |   172 |   174 |    346 |
| `scroll`        |  1 |    87 |    87 |    87 |     87 |
| `switch_tab`    |  1 |   239 |   239 |   239 |    239 |
| `virtual_desk`  |  1 |   321 |   321 |   321 |    321 |
| **Total (MCP)** |**152**| **821** | — | — | **125.327** |

**Auffaellig:** `click` ist bei SC Free der Top-Kostenpunkt (80k Chars total) weil jede Click-Response den Ambient-Context-Diff mit NEW/REMOVED/CHANGED-Zeilen enthaelt — das ist der Preis fuer "kein extra read_page noetig". Im Vergleich: Playwright MCP `browser_click` ist nur 463 Chars avg (weil Playwright die Verifikation minimal haelt und der LLM dann nochmal `browser_snapshot` rufen muss). SC trade-off: dickere Click-Responses, dafuer weniger separate read_page-Calls (21 vs Playwrights 8 `browser_snapshot`, aber Playwright hat sehr viele `browser_evaluate` dazwischen). `read_page` bei SC avg 1124 Chars vs Playwrights `browser_snapshot` 6084 Chars — **5.4x kompakter**, der erwartete Ambient-Context-Vorteil ist sichtbar. `evaluate` (33 Calls) hoch weil mehrere Tests (T3.1 Shadow DOM, T3.2 iFrame, T3.3 Drag via DOM-Reorder, T3.4 Canvas-Pixelscan, T3.6 Rich-Text innerHTML, T4.1/T4.3 Element-Suche, T4.4 localStorage/Cookie, T4.5 MutationObserver) ohne native Primitives geloest wurden — denselben Workaround-Weg nutzte auch Playwright MCP.

#### Weitere MCPs

Warten auf Re-Bench-Runs mit der neuen Metrik. Format wie oben.

¹SilbercueChrome Free Run 5 (2026-04-09, 35-Test-Version): 30/31 PASS auf gezaehlten Tests, 4 Skips (T5.3-T5.6 Runner-Only), 1 Fail (T4.7 Token-Budget — runner-only wie T5.3-T5.6, liefert explizit "Token values not provided — run via benchmark runner"; waere korrekt als skip zu zaehlen aber der Seiten-Export meldet es als fail). Dauer **598s**. Token-Delta **26.48M** — hoeher als beim vorherigen SC Free Run (19.5M, 24-Test-Version) weil jetzt 7 zusaetzliche Tests (Level 4 Hardest + Level 5 Toasts) inkl. Level 5 Navigation zu 10k-DOM-Sektionen. Workarounds dokumentiert: **T2.5 Tab Management** per `navigate` + `navigate(back)` geloest, weil `switch_tab` im Free-Tier Pro-gated ist (bestaetigt — Pro-Feature-Error bei Smoke-Test); **T3.3 Drag&Drop** via `evaluate` DOM-`appendChild`-Reorder, weil kein natives Drag-Primitive; **T3.4 Canvas Click** via `evaluate` Pixel-Scan auf `ImageData` zur Center-Berechnung, dann koordinaten-basierter `click(x,y)`; **T3.6 Rich Text** via `evaluate` `innerHTML='<strong>Hello World</strong>'`, weil `type` kein contenteditable unterstuetzt (nach erstem Fail ohne Bold retry). **T4.5 Mutation Observer** via `evaluate` MutationObserver-Setup + async-await (`observe`-Tool hat die Changes nicht erfasst — moeglicher Bug mit MutationObserver auf `characterData` von `<strong>`-Child). Session frisch aus `/tmp`, keine CLAUDE.md-Bias. Lizenz vor dem Run entfernt (`~/.silbercuechrome/license-cache.json` weg-moved), Free-Modus durch Pro-Feature-Error auf `virtual_desk` bestaetigt. Tool-Efficiency: **151 MCP-Calls, avg 807 Chars/Call (~201 Tok est.)**, P95 2.328 Chars. Rohdaten in `results/silbercuechrome-free-run5.json`.

‡**Playwright CLI Run 1** (2026-04-09, `@playwright/cli@0.1.6`): 28/31 PASS, 4 Skips (T5.3-T5.6 Runner-Only). Fails: T2.3 (self-inflicted Wizard-State-Split), T4.2 (Counter-Race), T4.7 (SC-spezifisch). Duration **376s** — 33% schneller als MCP weil kein MCP-Protokoll-Handshake pro Tool-Call. **Token-Delta 18.99M** — nur ~6% weniger als MCP, NICHT die von Microsoft beworbene 4x-Ersparnis (weil der LLM trotzdem Snapshots lesen muss). Native CLI-Primitives erfolgreich: `click`, `fill`, `type`, `select`, `press`, `tab-select`, `localstorage-set`, `cookie-set`. Native `drag` schlug fehl. CLI hat 0 MCP-Tools (alles Bash). Rohdaten + tool_efficiency in `results/playwright-cli-run1.json`.

†**Playwright MCP Run 2** (2026-04-09, 35-Test-Version): 29/31 PASS, 4 Skips, 2 Fails (T4.2 Counter-Race echtes Fail, T4.7 SC-spezifisch). Viele Tests via `browser_evaluate` geloest (T3.3 Drag, T3.4 Canvas, T3.6 Rich-Text, T4.2 Polling, T4.5 MutationObserver, T4.6 Modal) — nicht ueber native Primitiven. Token-Delta 20.29M. Post-Hoc-Analyse via `measure-tool-calls.sh`: **121 MCP-Tool-Calls**, avg Response **1.448 Chars (362 Tok est.)**, P95 **8.068 Chars**. Rohdaten + tool_efficiency in `results/playwright-mcp-run2.json`.

## Ergebnis-Dateien (Stand 2026-04-09)

Nur die Runs gegen die aktuelle **35-Test-Version mit Tool-Efficiency-Metrik** werden gepflegt:

```
test-hardest/results/
  silbercuechrome-free-run5.json  (35 Tests, 30/31, 598s, tool_efficiency: 151 calls / ∅ 807 chars / P95 2.328)
  playwright-mcp-run2.json        (35 Tests, 29/31, 563s, tool_efficiency: 121 calls / ∅ 1.448 chars / P95 8.068)
  playwright-cli-run1.json        (35 Tests, 28/31, 376s, tool_efficiency: 0 MCP-calls — CLI via Bash)
```

Aeltere 24-Test-Runs (browser-use, chrome-browser, claude-in-chrome, browser-mcp, SC Free run1-run4, SC Pro run1-run2, playwright-mcp-run1) wurden 2026-04-09 entfernt weil sie nicht direkt mit der 35-Test-Version vergleichbar sind und keine Tool-Efficiency-Metriken enthalten. Alle historischen Daten liegen in der git-Historie bis Commit `9e3c82e`.
