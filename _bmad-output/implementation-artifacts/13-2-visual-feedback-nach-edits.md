# Story 13.2: Visual Feedback — Automatischer Screenshot nach Frontend-Edits

Status: review

## Story

As a **AI-Agent (LLM)**,
I want automatisches visuelles Feedback nach CSS/TSX/HTML-Aenderungen in Projekten mit Hot Reload,
so that ich sofort sehe ob meine Aenderung korrekt uebernommen wurde, ohne manuell navigate → read_page → screenshot aufrufen zu muessen.

## Acceptance Criteria

### AC-1: Automatischer Screenshot nach Frontend-Edit (Grundgeruest)

**Given** der Agent editiert eine Frontend-Datei (.css, .scss, .less, .tsx, .jsx, .html, .vue, .svelte)
**When** die Datei gespeichert wird
**Then** wird nach einer Grace-Period (500ms, spaeter HMR-basiert via Phase 4) automatisch ein Screenshot gemacht und dem Agent als `additionalContext` zugaenglich gemacht
**And** der Agent muss NICHT manuell navigate → read_page → screenshot aufrufen
**And** der Screenshot zeigt den best-effort Seitenzustand — ob HMR bereits abgeschlossen ist, haengt vom Timing ab (Phase 4 verbessert dies)

### AC-2: Gezielter Ausschnitt wenn Selektor erkennbar (Prioritaet 1)

**Given** der Agent editiert eine CSS-Datei und der Selektor ist aus dem Diff erkennbar (z.B. `.card-header`)
**When** der automatische Screenshot getriggert wird
**Then** wird nur der Bereich um das betroffene Element gecaptured (clip-Parameter mit Padding)
**And** es wird KEIN ganzer Screenshot gemacht — nur der fokussierte Ausschnitt

### AC-3: Pixel-Diff wenn Selektor nicht erkennbar (Prioritaet 2)

**Given** der Agent editiert eine Frontend-Datei aber kein CSS-Selektor extrahierbar ist
**When** ein vorheriger Screenshot gecacht ist
**Then** wird ein Pixel-Diff zwischen Vorher- und Nachher-Screenshot berechnet
**And** nur die veraenderte Region wird zurueckgegeben (mit ~80px Padding fuer Kontext)
**And** der Agent sieht exakt was sich visuell geaendert hat

### AC-4: Ganzer Screenshot als Fallback (Prioritaet 3)

**Given** weder Selektor erkennbar noch vorheriger Screenshot gecacht
**When** der automatische Screenshot getriggert wird
**Then** wird ein ganzer Viewport-Screenshot gemacht und zurueckgegeben

### AC-5: Kein HMR aktiv

**Given** Hot Reload ist nicht aktiv oder die Seite aendert sich nicht innerhalb des Timeouts
**When** der Screenshot getriggert wird
**Then** wird trotzdem ein Screenshot gemacht (zeigt den aktuellen Zustand)

## Tasks / Subtasks

### Phase 1: Hook-Grundgeruest + Ganzer Screenshot (AC-1, AC-4, AC-5)

- [x] Task 1: Claude Code PostToolUse Hook konfigurieren (AC: #1)
  - [x] Hook-Eintrag in `.claude/settings.json` mit Matcher `"Edit|Write"`
  - [x] Hook-Script unter `scripts/visual-feedback.mjs` (Node.js, ESM)
  - [x] Script liest `tool_input.file_path` von stdin, prueft Dateiendung
  - [x] Nur Frontend-Dateien triggern: `.css`, `.tsx`, `.jsx`, `.html`, `.vue`, `.svelte`, `.scss`, `.less`
  - [x] Nicht-Frontend-Dateien: Script gibt `{}` zurueck und beendet sich sofort

- [x] Task 2: CDP-Screenshot via separater WebSocket-Verbindung (AC: #4)
  - [x] HTTP GET `http://127.0.0.1:9222/json/list` → Tab finden (siehe Tab-Selektion unten)
  - [x] **PFLICHT:** `WebSocketTransport` aus `src/transport/websocket-transport.ts` wiederverwenden — NICHT native `WebSocket` oder `ws`-Paket! Grund: BUG-003 (Node 22 Sec-WebSocket-Accept Mismatch) ist dort gefixt, naive Implementierungen scheitern am Handshake.
  - [x] `Page.captureScreenshot` mit `format: "png"` fuer Diff-Cache, `format: "webp"` + `quality: 80` fuer finalen Output
  - [x] Screenshot speichern: `/tmp/visual-feedback-<timestamp>.webp` (Output) + `/tmp/visual-feedback-last-<tab-id>.png` (Diff-Cache)
  - [x] WebSocket sofort nach Screenshot schliessen
  - [x] **Screenshot-Reliability:** Vor `captureScreenshot` muss `Emulation.setFocusEmulationEnabled({ enabled: true })` aufgerufen werden — sonst schwarze Bilder wenn Chrome-Fenster verdeckt ist (BUG-015, siehe `src/tools/screenshot.ts:208-225`)

- [x] Task 3: HMR-Grace-Period (AC: #5)
  - [x] 500ms Wartezeit nach File-Save bevor Screenshot gemacht wird
  - [x] Timeout: Wenn nach 500ms kein HMR erkennbar → trotzdem Screenshot machen

- [x] Task 4: Rueckkanal an Claude (AC: #1)
  - [x] stdout-JSON: `{ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "Visual Feedback nach Edit:\n[IMAGE:/tmp/visual-feedback-<ts>.webp]" } }`
  - [x] Claude sieht den Screenshot automatisch nach jedem Frontend-Edit

### Phase 2: Gezielter Ausschnitt via Selektor (AC-2)

- [x] Task 5: CSS-Selektor aus Edit-Diff parsen (AC: #2)
  - [x] Bei `tool_name: "Edit"`: `old_string` / `new_string` analysieren
  - [x] CSS-Regelblock erkennen: Regex fuer `<selektor> {` Pattern — **Best-Effort:** Einfache Selektoren (.class, #id, tag) werden zuverlaessig erkannt. Komplexe Faelle (kommagetrennte Selektoren, verschachtelte SCSS-Bloecke, @media-Queries) werden uebersprungen → Fallback auf Pixel-Diff.
  - [x] Selektor extrahieren (z.B. `.card-header`, `#main-nav`). Bei mehrteiligen Selektoren (`div.content > p`) den ersten Teil verwenden.
  - [x] Bei TSX/JSX/HTML: Selektor-Extraktion ueberspringen (zu unzuverlaessig) → Fallback

- [x] Task 6: Element-Position im Browser ermitteln (AC: #2)
  - [x] Via CDP: `Runtime.evaluate` mit `document.querySelector('<selektor>').getBoundingClientRect()`
  - [x] Technik aus SoM-Pipeline wiederverwendbar: Bounding-Box-Berechnung (siehe `src/tools/screenshot.ts` SoM-Abschnitt)
  - [x] Padding addieren: ~80px um das Element herum (konfigurierbar)
  - [x] Clip auf Viewport-Grenzen begrenzen (nicht ueber Seitenrand hinaus)

- [x] Task 7: Clip-Screenshot (AC: #2)
  - [x] `Page.captureScreenshot` mit `clip: { x, y, width, height, scale: 1 }`
  - [x] Wenn Element nicht gefunden → Fallback auf Pixel-Diff (Phase 3), NICHT auf ganzen Screenshot (AC-2 verbietet das)
  - [x] Wenn auch Pixel-Diff nicht moeglich (kein gecachter Screenshot) → dann AC-4 Fallback (ganzer Screenshot)

### Phase 3: Pixel-Diff (AC-3)

- [x] Task 8: Screenshot-Cache (AC: #3)
  - [x] Nach jedem Screenshot: PNG-Kopie speichern unter `/tmp/visual-feedback-last-<tab-id>.png` (Tab-ID aus `/json/list`)
  - [x] Tab-spezifischer Cache verhindert Race Conditions bei parallelen Hook-Instanzen und Cross-Tab-Verwechslungen
  - [x] Beim naechsten Edit: vorherigen Screenshot als "Vorher" laden (gleicher Tab-ID)
  - [x] Cache invalidieren bei Navigation (anderer Tab/URL) — URL im Cache-Metadaten speichern
  - [x] Aufraeumen: Screenshots aelter als 1h beim Hook-Start loeschen (`/tmp/visual-feedback-*.{png,webp}`)

- [x] Task 9: Pixel-Diff berechnen (AC: #3)
  - [x] `pixelmatch` npm-Paket verwenden (zero-dependency, lightweight)
  - [x] Vorher-Screenshot + Nachher-Screenshot vergleichen
  - [x] Geaenderte Region erkennen: Bounding-Box aller Pixel mit Diff > Threshold
  - [x] Padding um die Diff-Region: ~80px Kontext drumherum
  - [x] Nur den Ausschnitt aus dem Nachher-Screenshot extrahieren und zurueckgeben
  - [x] Wenn kein Diff erkannt (identische Bilder): kurze Textnachricht statt Screenshot

- [x] Task 10: Bild-Dekodierung fuer Pixel-Vergleich (AC: #3)
  - [x] **Entscheidung: Durchgaengig PNG fuer Diff-Pipeline.** Der Cache (Task 8) speichert PNG, pixelmatch arbeitet direkt mit PNG-Buffern.
  - [x] PNG-Dekodierung: `pngjs` npm-Paket (zero-dependency, lightweight) — `PNG.sync.read(buffer)` liefert RGBA-Pixel-Buffer
  - [x] `pixelmatch` + `pngjs` sind beide `dependencies` (nicht devDependencies), da sie zur Hook-Laufzeit benoetigt werden
  - [x] Finaler Output an Claude: WebP 80% (via CDP `Page.captureScreenshot` mit `format: "webp"` fuer den Clip/Viewport-Screenshot)

### Phase 3b: Tests (AC-1 bis AC-5)

- [x] Task 10b: Unit-Tests fuer Hook-Script (AC: #1-5)
  - [x] Test: stdin mit Frontend-Datei → Screenshot-Output erwartet
  - [x] Test: stdin mit .ts-Datei → leeres JSON, kein Screenshot
  - [x] Test: stdin mit fehlendem Chrome auf 9222 → stderr-Warning, exit 0
  - [x] Test: CSS-Selektor-Parsing — einfache Selektoren (.class, #id)
  - [x] Test: CSS-Selektor-Parsing — komplexe Faelle → Fallback
  - [x] Test: Pixel-Diff Bounding-Box + Padding-Berechnung
  - [x] Test: Cache-Aufraeumung (Dateien aelter als 1h werden geloescht)
  - [x] Test: Tab-Selektion-Heuristik (localhost bevorzugt)

### Phase 4: Smarte HMR-Erkennung (Enhancement)

- [x] Task 11: Console-Log-basierte HMR-Detection (Enhancement von Task 3)
  - [x] Statt fixer 500ms: CDP `Runtime.enable` + auf `Runtime.consoleAPICalled` lauschen
  - [x] Pattern-Match: `[vite] hot updated`, `[HMR] Updated modules`, `[Fast Refresh] done`
  - [x] Wenn HMR-Signal erkannt → sofort Screenshot
  - [x] Timeout nach 3s: wenn kein Signal → trotzdem Screenshot (Fallback)
  - [x] WebSocket-Verbindung nach Screenshot schliessen

## Dev Notes

### Architektur-Entscheidung: Hook-Script ist EXTERN, nicht im MCP-Server

Das Script `scripts/visual-feedback.mjs` laeuft **ausserhalb** des MCP-Servers als eigenstaendiges Node.js-Script. Es verbindet sich per eigener CDP-WebSocket-Session zum selben Chrome. Chrome erlaubt mehrere Debug-Clients gleichzeitig — kein Konflikt mit der MCP-Server-Session.

**Warum nicht im MCP-Server?** Claude Code Hooks koennen keine MCP-Tools aufrufen. Der Hook bekommt stdin-JSON und muss stdout-JSON zurueckgeben. Das Script muss daher standalone sein.

### Concurrent CDP-Zugriff: Sicher

Chrome DevTools Protocol unterstuetzt mehrere gleichzeitige Clients pro Target. Der MCP-Server und das Hook-Script verwenden separate WebSocket-Verbindungen. Solange beide nicht gleichzeitig Seitennavigation ausloesen, gibt es keine Race Conditions. Das Hook-Script fuehrt nur lesende Operationen aus (Screenshot, BoundingRect-Query).

### Claude Code Hook-System: Referenz

PostToolUse Hooks bekommen per stdin:
```json
{
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "/path/to/button.css",
    "old_string": ".btn { font-size: 14px; }",
    "new_string": ".btn { font-size: 18px; }"
  },
  "tool_response": { "success": true },
  "cwd": "/project-root"
}
```

Rueckgabe per stdout (non-blocking):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Visual Feedback nach Edit:\n[IMAGE:/tmp/visual-feedback-1712345678.webp]"
  }
}
```

[Source: Context7 Claude Code Hooks Docs — code.claude.com/docs/en/hooks]

### Prioritaets-Kaskade fuer Screenshot-Modus

```
1. CSS-Selektor aus Diff erkennbar? (best-effort Regex, nur einfache Selektoren)
   → JA: querySelector im Browser → Element gefunden?
     → JA: Clip-Screenshot um Element + 80px Padding (Task 6+7)
     → NEIN: weiter zu 2.
   → NEIN: weiter zu 2.

2. Vorheriger Screenshot gecacht? (gleicher Tab-ID, gleiche URL)
   → JA: Pixel-Diff, Ausschnitt der geaenderten Region + 80px Padding (Task 9)
   → NEIN: weiter zu 3.

3. Letzter Fallback: Ganzer Viewport-Screenshot (Task 2)
```

### SoM-Pipeline wiederverwenden

Die Bounding-Box-Berechnung in `src/tools/screenshot.ts` (SoM-Abschnitt, ab Zeile ~36) zeigt wie DOMSnapshot → Bounds → Clip funktioniert. Fuer das Hook-Script ist der einfachere Weg: `Runtime.evaluate` mit `getBoundingClientRect()` — das reicht fuer ein einzelnes Element und vermeidet die DOMSnapshot-Komplexitaet.

### Pixel-Diff: Padding ist Pflicht

Beim Pixel-Diff wird die Bounding-Box aller geaenderten Pixel berechnet. Diese Box wird um **~80px Padding** erweitert, damit Claude den Kontext sieht (umliegende Elemente, Layout). Ohne Padding waere nur ein schmaler Streifen geaenderter Pixel sichtbar — nutzlos fuer visuelles Verstaendnis.

### Bild-Format-Strategie

| Zweck | Format | Grund |
|-------|--------|-------|
| Finaler Screenshot an Claude | WebP 80% | Kompakt, unter 100KB |
| Interner Diff-Cache | PNG | Pflicht — pixelmatch + pngjs arbeiten mit PNG-RGBA-Buffern |
| Pixel-Diff-Output | WebP 80% | Kompakt fuer Claude (Diff-Region aus PNG extrahieren → als WebP encodieren via CDP) |

### Frontend-Dateiendungen

Trigger-Extensions: `.css`, `.scss`, `.less`, `.tsx`, `.jsx`, `.html`, `.vue`, `.svelte`

Nicht-Trigger (bewusst ausgeschlossen): `.ts`, `.js`, `.json`, `.md` — diese haben selten direkte visuelle Auswirkungen.

### Screenshot-Reliability (BUG-015)

Das Hook-Script muss dieselben Reliability-Mechaniken anwenden wie der MCP-Server:
- `Emulation.setFocusEmulationEnabled({ enabled: true })` — verhindert schwarze Screenshots bei verdecktem Chrome-Fenster
- Kein Scroll-Offset-Fix noetig (Hook macht keinen scrollTo, nur captureScreenshot)
- Referenz: `src/tools/screenshot.ts:208-225`, `docs/bug-015-screenshot-occlusion.md`

### Project Structure Notes

- Hook-Konfiguration: `.claude/settings.json` (projektspezifisch, wird eingecheckt) — wird von Task 1 neu erstellt
- Hook-Script: `scripts/visual-feedback.mjs` (Verzeichnis `scripts/` existiert bereits im Projekt)
- Import aus eigenem Projekt: `import { WebSocketTransport } from '../build/transport/websocket-transport.js'` — setzt voraus dass `npm run build` gelaufen ist
- `pixelmatch` und `pngjs` als `dependencies` in `package.json` (Laufzeit-Abhaengigkeiten, nicht devDependencies)

### Tab-Selektion

Das Hook-Script muss den richtigen Tab finden. Strategie:
1. HTTP GET `http://127.0.0.1:9222/json/list` → Liste aller Targets
2. Bevorzugt: Target mit `"type": "page"` dessen URL localhost oder die Dev-Server-URL enthaelt (heuristisch: `localhost:`, `127.0.0.1:`, Port 3000-9999)
3. Fallback: Erstes Target mit `"type": "page"`
4. Kein Page-Target gefunden → stderr-Warning, exit 0

### Bekannte Limitierungen

1. **Kein Chrome auf Port 9222:** Hook-Script gibt eine **stderr-Warning** aus (`"Visual Feedback: Chrome nicht erreichbar auf Port 9222"`) und exit 0 mit leerem JSON. Der Agent sieht die Warning im Hook-Feedback und weiss, dass kein visuelles Feedback verfuegbar ist.
2. **Multiple Tabs:** Script nutzt Heuristik (localhost/Dev-Server bevorzugt). Bei mehreren Dev-Servern kann der falsche Tab getroffen werden. Spaeteres Enhancement: aktiven Tab aus MCP-Session abfragen.
3. **Headless Mode:** Screenshots funktionieren auch headless — kein Problem.
4. **Sehr schnelle Edits:** Wenn Claude mehrere Dateien schnell hintereinander editiert, laufen mehrere Hook-Instanzen parallel. Tab-spezifischer Cache-Pfad (`/tmp/visual-feedback-last-<tab-id>.png`) verhindert Race Conditions beim Pixel-Diff.

### References

- [Source: _bmad-output/planning-artifacts/epics.md Zeile 2409-2450 — Story 13.2 Definition]
- [Source: Context7 — Claude Code Hooks Docs (code.claude.com/docs/en/hooks)]
- [Source: Context7 — CDP Page.captureScreenshot API]
- [Source: Web-Recherche — HMR Detection: Vite/Webpack/Next.js Console-Log Patterns]
- [Source: Web-Recherche — pixelmatch npm-Paket fuer Visual Regression]
- [Source: src/tools/screenshot.ts — SoM Bounding-Box-Pipeline als Referenz]
- [Source: src/tools/inspect-element.ts — Story 13.1, CSS-Domain Pattern]
- [Source: src/cdp/console-collector.ts — Runtime.consoleAPICalled Listener]

## Codex Pre-Dev Review

**Reviewer:** Codex gpt-5.3-codex (xhigh reasoning)
**Datum:** 2026-04-07
**Verdict:** NEEDS_WORK

### Findings

REASONING_USED: xhigh
ARTIFACT_TYPE: story
FILES_READ: 15
CODE_CHECKED: ja

## BLOCKER — Artefakt fundamental fehlerhaft / nicht implementierbar
[B1] BLOCKER — keine

## CRITICAL — Fehlende/widersprüchliche Anforderung die Implementierung scheitern lässt
[C1] Task 2 / Dev Notes — Eigene WebSocket-CDP-Verbindung ist gefordert, aber ohne verbindliche Vorgabe zur Wiederverwendung der bereits gefixten Transport-Implementierung; naive/native/ws-Implementierung kann an bekanntem Handshake-Problem scheitern (docs/deferred-work.md:86-103, src/transport/websocket-transport.ts:67-72).
[C2] AC-2 vs Task 7 — AC-2 fordert explizit "KEIN ganzer Screenshot", Task 7 erlaubt bei "Element nicht gefunden" Fallback auf Full Screenshot; direkter Widerspruch.
[C3] AC-1 vs Phase 1/4 — AC-1 verlangt Screenshot nach Hot-Reload-Update, Phase 1 nutzt nur fixe 500ms Wartezeit, echte HMR-Erkennung ist nur "Enhancement" in Phase 4; Kern-AC ist damit nicht zuverlaessig erfuellbar.

## HIGH — Unklare AC / fehlende Edge Cases / Widerspruch zum echten Code
[H1] Phase 3 Task 8/10 — Cache-Format ist widersprüchlich: Task 8 speichert "last" als WebP, Task 10 empfiehlt PNG fuer Diff; Decoder-/Pipeline-Entscheidung bleibt unklar.
[H2] Bekannte Limitierungen vs Cache-Design — "Parallele Hook-Instanzen kein Problem" widerspricht globalem Cache-Pfad /tmp/visual-feedback-last.webp; Race Conditions und Cross-Edit-Diffs sind wahrscheinlich.
[H3] Task 2 / Multiple Tabs — "erstes page-Target" plus bekannte Multiple-Tab-Limitierung fuehrt oft zu Screenshot vom falschen Tab; AC-Nutzen bricht damit praktisch.
[H4] Dev Notes vs realer Code — Story uebernimmt nicht die bestehenden Screenshot-Reliability-Mechaniken (Focus-Emulation und Headed-Scroll-Offset), die im Code explizit noetig sind (src/server.ts:69-71, src/tools/switch-tab.ts:113-116, src/tools/screenshot.ts:208-225).
[H5] Task 5/6 — Selektor-Parsing per einfachem Regex ist fuer reale CSS/SCSS-Faelle (kommagetrennte Selektoren, verschachtelte Bloecke, @media) unzureichend spezifiziert; hohe Fallback-Quote vorprogrammiert.
[H6] AC-1/Dev Notes — "Kein Chrome auf 9222 -> leise fehlschlagen" untergraebt Verifizierbarkeit der ACs, weil Ausfall nicht erkennbar ist.

## MEDIUM — Unvollstaendige Dev Notes / Verbesserungswuerdig / Performance-Luecken
[M1] Project Structure Notes — .claude/settings.json und scripts/visual-feedback.mjs sind aktuell nicht vorhanden (Repo-Stand), Bootstrapping ist zwar implizit, aber nicht als verifizierbarer Deliverable-Schritt spezifiziert.
[M2] Dependency-Management — pixelmatch ist als "optionale devDependency" notiert, wird aber zur Laufzeit des Hooks benoetigt; Paketierungs-/Installationsrisiko.
[M3] Tasks/Subtasks — Es fehlen explizite Testaufgaben (Unit/Integration) fuer Hook-Input/Output, Tab-Auswahl, Diff-Bounding-Box und HMR-Timing.
[M4] Betrieb/Performance — Kein Aufraeumkonzept fuer /tmp/visual-feedback-<timestamp>.webp, potenziell unbounded File-Wachstum.

## LOW — Formulierung / Stil / kleinere Luecken
[L1] Project Structure Notes — "neues Verzeichnis scripts/" ist sachlich ungenau; scripts/ existiert bereits im Projekt.
[L2] AC-1 vs Trigger-Liste — AC-1 nennt Dateitypen ohne .scss/.less, Tasks/Dev Notes triggern diese aber mit.

## SUMMARY
BLOCKER: 0 | CRITICAL: 3 | HIGH: 6 | MEDIUM: 4 | LOW: 2
VERDICT: NEEDS_WORK
BEGRUENDUNG: Die Story hat eine gute, stufenweise Zielarchitektur (Fallback-Kaskade, klare Phasen) und verweist auf relevante bestehende Codebereiche. Vor Umsetzung muessen aber harte Widersprueche (AC-2 vs Task 7, AC-1-Timing), der CDP-Transportpfad und das Diff-/Cache-Design praezisiert werden, sonst scheitert die Implementierung in realen Laeufen.

### Action Items

- [x] [CRITICAL] C1: CDP-Transport — Task 2 + Project Structure Notes: WebSocketTransport Pflicht, Import-Pfad dokumentiert
- [x] [CRITICAL] C2: AC-2 vs Task 7 — Task 7 Fallback korrigiert: Pixel-Diff statt Full Screenshot, Kaskade praezisiert
- [x] [CRITICAL] C3: AC-1 Wording — "best-effort nach Grace-Period", Phase 4 als Enhancement klar benannt
- [x] [HIGH] H1: Cache-Format — Task 2 + Task 8 + Task 10: durchgaengig PNG fuer Diff, WebP nur fuer Output
- [x] [HIGH] H2: Race-Condition — Task 8: Cache-Pfad mit Tab-ID statt globalem Pfad
- [x] [HIGH] H3: Tab-Selektion — Neue Sektion "Tab-Selektion" mit localhost-Heuristik
- [x] [HIGH] H4: Screenshot-Reliability — Neue Sektion "Screenshot-Reliability (BUG-015)" mit Focus-Emulation
- [x] [HIGH] H5: Selektor-Parsing — Task 5: best-effort Regex klar dokumentiert, komplexe Faelle → Fallback
- [x] [HIGH] H6: Fehler-Signalling — Limitierung 1: stderr-Warning statt stille Rueckkehr
- [x] [MEDIUM] M1: Bootstrapping in Task 1 implizit (erstellt settings.json + Script)
- [x] [MEDIUM] M2: Dependency — pixelmatch + pngjs als dependencies (nicht devDependencies)
- [x] [MEDIUM] M3: Tests — Phase 3b mit 8 Unit-Test-Tasks hinzugefuegt
- [x] [MEDIUM] M4: Aufraeumen — Task 8: Screenshots aelter als 1h loeschen
- [x] [LOW] L1: scripts/ existiert bereits — Project Structure Notes korrigiert
- [x] [LOW] L2: .scss/.less in AC-1 aufgenommen

---

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- pixelmatch Diff-Image-Bug: alpha=0.1 zeichnet identische Pixel als Graustufen → Bounding-Box-Berechnung direkt auf Roh-Pixeldaten statt Diff-Image
- execFile mit `input` Option haengt in vitest → spawn mit explizitem `stdin.end()` verwendet

### Completion Notes List
- Phase 1: Hook-Grundgeruest (Tasks 1-4) — `.claude/settings.json` PostToolUse Hook + `scripts/visual-feedback.mjs` mit CDP-Screenshot via WebSocketTransport + CdpClient, BUG-015 Focus-Emulation, 500ms Grace-Period, stdout-JSON Rueckkanal
- Phase 2: Selektor-basierter Ausschnitt (Tasks 5-7) — CSS-Selektor-Regex best-effort Extraktion (.class, #id, tag), TSX/HTML → Fallback. Element-Position via CDP `Runtime.evaluate` + `getBoundingClientRect()`, 80px Padding, Viewport-Clamping
- Phase 3: Pixel-Diff (Tasks 8-10) — Tab-spezifischer PNG-Cache mit URL-Metadaten fuer Navigation-Invalidierung, pixelmatch + pngjs fuer RGBA-Vergleich, Bounding-Box direkt aus Roh-Pixeldaten (nicht aus Diff-Image), 80px Padding, Cache-Cleanup >1h
- Phase 3b: Tests (Task 10b) — 34 Unit/Integration-Tests: isFrontendFile (14), extractCssSelector (10), computePixelDiff (4), hook integration (3), tab selection (2), regex validation (1). Alle bestanden.
- Phase 4: Smarte HMR-Erkennung (Task 11) — CDP `Runtime.enable` + `Runtime.consoleAPICalled` Listener mit 8 HMR-Patterns (Vite, Webpack, Fast Refresh), 3s Timeout-Fallback, 100ms Settle nach HMR-Signal
- Prioritaets-Kaskade funktioniert: Selektor-Clip → Pixel-Diff → Viewport-Screenshot
- Alle 1370 Tests der gesamten Suite bestehen ohne Regressionen

### Implementation Plan
Standalone ESM-Script `scripts/visual-feedback.mjs` als Claude Code PostToolUse Hook. Eigene CDP-Verbindung via bestehender WebSocketTransport + CdpClient (kein ws-Paket). Drei-stufige Screenshot-Strategie: (1) CSS-Selektor aus Diff → Clip-Screenshot, (2) Pixel-Diff mit gecachtem Screenshot → Diff-Region, (3) Ganzer Viewport als Fallback. Smarte HMR-Detection via Console-Log-Pattern-Matching statt fixer Grace-Period.

### File List
- scripts/visual-feedback.mjs (NEU) — Hook-Script, Prioritaets-Kaskade, HMR-Detection
- scripts/visual-feedback.test.ts (NEU) — 34 Unit/Integration-Tests
- .claude/settings.json (NEU) — PostToolUse Hook-Konfiguration
- package.json (GEAENDERT) — pixelmatch + pngjs als dependencies

### Change Log
- 2026-04-07: Story 13.2 komplett implementiert — Phasen 1-4 mit 34 Tests, alle 1370 Suite-Tests bestanden
