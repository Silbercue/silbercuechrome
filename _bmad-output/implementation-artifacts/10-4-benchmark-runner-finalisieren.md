# Story 10.4: Benchmark-Runner finalisieren (npm run benchmark)

Status: done

## Story

As a **Entwickler (Julian)**,
I want dass `npm run benchmark` alle Tests automatisiert ausfuehrt und Ergebnisse als JSON exportiert,
So that Benchmark-Vergleiche reproduzierbar und automatisierbar sind.

## Acceptance Criteria

1. **Given** Chrome laeuft und die Benchmark-Seite auf `localhost:4242` erreichbar ist
   **When** `npm run benchmark` ausgefuehrt wird
   **Then** werden alle Tests der Benchmark-Suite ausgefuehrt (aktuell 24, spaeter 30+)
   **And** die Ergebnisse werden als JSON-Datei exportiert nach `test-hardest/benchmark-silbercuechrome_mcp-llm-{datum}.json`

2. **Given** die JSON-Ergebnisdatei
   **When** sie geoeffnet wird
   **Then** enthaelt sie pro Test: Name, Level, Pass/Fail, Dauer in ms, Anzahl Tool-Calls
   **And** eine Summary mit: total_passed, total_failed, total_time_ms, total_tool_calls

3. **Given** ein Test fehlschlaegt
   **When** der Benchmark-Runner weiterlaeuft
   **Then** wird der Fehler protokolliert aber die restlichen Tests werden trotzdem ausgefuehrt (kein Abbruch)

## Tasks / Subtasks

- [x] Task 1: `package.json` Script hinzufuegen (AC: #1)
  - [x] 1.1 In `package.json` unter `"scripts"` hinzufuegen: `"benchmark": "node test-hardest/benchmark-full.mjs"`
  - [x] 1.2 Verifizieren: `npm run benchmark` startet den Runner

- [x] Task 2: JSON-Ausgabeformat an Epics-Spezifikation anpassen (AC: #1, #2)
  - [x] 2.1 Dateiname-Pattern aendern: aktuell `benchmark-silbercuechrome-free-{timestamp}.json` (mit Unix-Timestamp). Neues Pattern: `benchmark-silbercuechrome_mcp-{YYYY-MM-DD}.json` (Datum-basiert, konsistent mit bestehendem `benchmark-silbercuechrome_mcp-llm-2026-04-05.json`)
    ```javascript
    // ALT (Zeile 633):
    const outPath = new URL(`benchmark-silbercuechrome-free-${Date.now()}.json`, import.meta.url).pathname;
    // NEU:
    const today = new Date().toISOString().slice(0, 10);
    const outPath = new URL(`benchmark-silbercuechrome_mcp-${today}.json`, import.meta.url).pathname;
    ```
  - [x] 2.2 `name`-Feld in JSON anpassen: aktuell `"SilbercueChrome MCP (Free Tier, Post-9.9)"` — aendern zu `"SilbercueChrome MCP"` (generisch, unabhaengig von Pro/Free-Status)
  - [x] 2.3 `type`-Feld beibehalten: `"mcp-scripted"` (korrekt — unterscheidet von `"llm-driven"` Benchmarks)
  - [x] 2.4 Level-Information pro Test hinzufuegen: Jeder Test-Eintrag erhaelt ein `level`-Feld basierend auf der Test-ID-Konvention (T1.x → 1, T2.x → 2, etc.)
    ```javascript
    // In runTest() den Level aus der ID extrahieren:
    const level = parseInt(id.replace("T", ""));
    testResults[id] = { status: "pass", level, duration_ms: ms, tool_calls: calls };
    // Bei Fehler:
    testResults[id] = { status: "fail", level, duration_ms: ms, tool_calls: calls, error: e.message };
    ```
  - [x] 2.5 Summary um `total_tool_calls` ergaenzen: aktuell hat die Summary `tool_uses`. Laut AC #2 muss auch `total_tool_calls` vorhanden sein. Beiden Keys beibehalten fuer Abwaertskompatibilitaet:
    ```javascript
    summary: {
      total: 24,
      passed,
      failed,
      duration_s: totalDuration,
      total_time_ms: (benchmarkEnd - benchmarkStart),
      tool_uses: totalCalls,
      total_tool_calls: totalCalls,
    }
    ```
  - [x] 2.6 `notes`-Feld generischer formulieren: aktuell erwähnt Free Tier und Story 9.9. Neuer Text: `"Automated benchmark via npm run benchmark. 24 tests across 4 levels."`

- [x] Task 3: Fehler-Robustheit verifizieren (AC: #3)
  - [x] 3.1 Pruefen dass `runTest()` (Zeile 41-56) Fehler per try/catch abfaengt und den Runner NICHT abbricht — das ist BEREITS korrekt implementiert. `runTest()` faengt Exceptions, loggt den Fehler in `testResults[id]` und laeuft weiter. **Kein Code-Change noetig**, nur verifizieren.
  - [x] 3.2 Pruefen dass der Exit-Code korrekt ist: `process.exit(failed > 0 ? 1 : 0)` (Zeile 638) — BEREITS korrekt. Non-zero bei Fehlern, zero bei Erfolg.

- [x] Task 4: Build & Validierung (AC: #1, #2, #3)
  - [x] 4.1 `npm run build` erfolgreich
  - [x] 4.2 Chrome mit Remote Debugging starten: `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222`
  - [x] 4.3 Benchmark-Server starten: `cd test-hardest && python3 -m http.server 4242`
  - [x] 4.4 http://localhost:4242 in Chrome oeffnen
  - [x] 4.5 `npm run benchmark` ausfuehren — alle 24 Tests muessen ausgefuehrt werden
  - [x] 4.6 JSON-Datei pruefen: `test-hardest/benchmark-silbercuechrome_mcp-{heute}.json` existiert, Format stimmt
  - [x] 4.7 JSON-Format validieren: `name`, `type`, `timestamp`, `notes`, `summary` (mit total, passed, failed, duration_s, total_time_ms, tool_uses, total_tool_calls), `tests` (mit status, level, duration_ms, tool_calls pro Test)

## Dev Notes

### Architektur-Kontext

Die Architektur definiert das Testing-Konzept:
> "Unit-Tests pro Schicht + 24-Test-Benchmark-Suite als End-to-End-Validierung. Pragmatisch fuer Einzelentwickler. Kein separater Integration-Layer — die Benchmark-Suite IST der Integration-Test."
[Source: _bmad-output/planning-artifacts/architecture.md#Testing]

FR80 spezifiziert den Benchmark-Runner:
> "Der Benchmark-Runner (`npm run benchmark`) fuehrt alle Tests automatisiert aus und exportiert Ergebnisse als JSON mit Millisekunden pro Test und Tool-Calls pro Test."
[Source: _bmad-output/planning-artifacts/prd.md#FR80]

NFR24 fordert deterministische Tests:
> "Deterministische Benchmark-Tests (vordefinierte Tool-Sequenzen, keine LLM-Entscheidungen) fuer reproduzierbare Vergleiche."
[Source: _bmad-output/planning-artifacts/prd.md#NFR24]

### Vorhandene Infrastruktur

**benchmark-full.mjs (bereits fast vollstaendig):**
- 639 Zeilen, 24 Tests in 4 Levels — ALLE Tests sind bereits implementiert und funktionsfaehig
- `callTool()` Helper (Zeile 24-34): Zaehlt Tool-Calls, misst Zeit pro Call
- `runTest()` Helper (Zeile 41-56): Try/catch mit Pass/Fail-Tracking — Fehler-Robustheit BEREITS implementiert
- `testResults` Objekt (Zeile 21): Sammelt `{ status, duration_ms, tool_calls, error? }` pro Test
- JSON-Export (Zeile 624-636): Summary + Tests → Datei
- `StdioClientTransport` mit `env: { ...process.env }` (Zeile 61-66) — env-Fix aus Story 10.3 BEREITS eingebaut
- Exit-Code `process.exit(failed > 0 ? 1 : 0)` (Zeile 638) — KORREKT

**Was FEHLT (= diese Story):**
1. `package.json` Script `"benchmark"` — damit `npm run benchmark` funktioniert
2. Dateiname-Pattern: Aktuell `benchmark-silbercuechrome-free-{unix-timestamp}.json` — muss zu `benchmark-silbercuechrome_mcp-{YYYY-MM-DD}.json` werden
3. `level`-Feld pro Test-Eintrag — AC #2 fordert Level-Info
4. `total_time_ms` und `total_tool_calls` in Summary — AC #2 fordert beides explizit
5. `name` und `notes` sind zu spezifisch (erwaehnen "Free Tier" und "Story 9.9")

**Bestehende Benchmark-JSON-Dateien (Referenz-Format):**
- `benchmark-silbercuechrome_mcp-llm-2026-04-05.json`: Format mit `{ name, type, timestamp, notes, summary: { total, passed, failed, duration_s, tool_uses }, tests: { T1.1: { status, tool_calls, notes } } }` — LLM-driven Format (kein `duration_ms` pro Test, hat `notes` statt `level`)
- `benchmark-silbercuechrome_mcp-1775416756099.json`: Format mit `{ name, type, timestamp, summary: { total, passed, failed, duration_s, tool_uses }, tests: { T1.1: { status, duration_ms, details } } }` — Page-driven Format (hat `details` statt `tool_calls`/`level`)
- **Ziel-Format dieser Story:** Vereinheitlicht: `{ status, level, duration_ms, tool_calls }` pro Test + erweiterte Summary

### Kritische Design-Entscheidungen

1. **Dateiname-Pattern `{YYYY-MM-DD}` statt Unix-Timestamp:** Lesbarkeit und Sortierbarkeit. Ein Run pro Tag ist fuer die Vergleichbarkeit ausreichend. Wenn mehrere Runs am selben Tag gemacht werden, wird die vorherige Datei ueberschrieben — das ist gewollt (letzter Run zaehlt).

2. **`level`-Feld aus Test-ID ableiten, NICHT hardcoden:** `parseInt(id.replace("T", ""))` extrahiert den Level aus `T1.1` → `1`, `T4.6` → `4`. Wenn spaeter Level 5 (Epic 11) dazukommt, funktioniert es automatisch.

3. **Beide Summary-Keys `tool_uses` UND `total_tool_calls`:** Abwaertskompatibilitaet mit bestehenden JSON-Dateien die `tool_uses` nutzen + AC #2 fordert `total_tool_calls`. Beide zeigen auf denselben Wert.

4. **`total_time_ms` zusaetzlich zu `duration_s`:** AC #2 fordert `total_time_ms`. Bestehendes Format hat `duration_s`. Beide beibehalten.

5. **Kein neuer Test-Code:** Alle 24 Tests sind BEREITS implementiert und funktionsfaehig. Diese Story aendert NUR die Infrastruktur (package.json Script, JSON-Format, Dateiname).

### Abgrenzung

- **Modifiziert:** `package.json` (neues `benchmark` Script)
- **Modifiziert:** `test-hardest/benchmark-full.mjs` (Dateiname-Pattern, JSON-Format, Level-Feld, Summary-Erweiterung, Name/Notes)
- **KEIN Produktionscode wird geaendert** — NUR Test-Infrastruktur
- **KEIN neuer Test** — alle 24 Tests existieren bereits
- **KEINE neuen Abhaengigkeiten**
- **KEINE neuen Dateien** — rein Modifikation bestehender Dateien

### Betroffene Dateien (vollstaendige Liste)

| Datei | Aenderung |
|-------|-----------|
| `package.json` | `"benchmark": "node test-hardest/benchmark-full.mjs"` in scripts hinzufuegen |
| `test-hardest/benchmark-full.mjs` | Zeile 41-56: `level` Feld in `testResults` ergaenzen |
| `test-hardest/benchmark-full.mjs` | Zeile 624-631: `name`, `notes` generischer, `total_time_ms` + `total_tool_calls` in Summary |
| `test-hardest/benchmark-full.mjs` | Zeile 633: Dateiname-Pattern von `benchmark-silbercuechrome-free-{timestamp}` zu `benchmark-silbercuechrome_mcp-{YYYY-MM-DD}` |

### Vorherige Story-Learnings (aus Story 10.1, 10.2, 10.3)

- Story 10.1: Mock-Format-Mismatch — wenn Formate sich aendern, ALLE Konsumenten pruefen. Hier relevant: Das neue JSON-Format muss mit bestehenden Analyse-Tools kompatibel bleiben.
- Story 10.2: `resolveAutoLaunch()` extrahiert — saubere Funktions-Extraktion statt inline-Logik. Analogie: Level-Extraktion als einzeilige Berechnung statt Lookup-Tabelle.
- Story 10.3: `env: { ...process.env }` Fix — dieser Fix ist in `benchmark-full.mjs` BEREITS eingebaut (Zeile 61-66). Keine erneute Aenderung noetig.
[Source: _bmad-output/implementation-artifacts/10-1-fix-license-commands-test.md]
[Source: _bmad-output/implementation-artifacts/10-2-autolaunch-tests-doku.md]
[Source: _bmad-output/implementation-artifacts/10-3-smoke-test-env-fix.md]

### Git Intelligence

Letzte relevante Commits:
- `be72cc5` feat(story-10.2): AutoLaunch tests, resolveAutoLaunch extraction, connection docs
- `3f0f9c7` feat(story-10.1): Fix license-commands test mock format (Polar.sh)
- `e666903` feat(story-9.9): Pro feature gates for switch_tab, virtual_desk, human touch

Story 10.2 ist der letzte abgeschlossene Commit. Story 10.3 (env-Fix) hat Status `ready-for-dev` — der env-Fix ist aber in `benchmark-full.mjs` BEREITS eingebaut (wurde vor der Story-Erstellung manuell gefixt). Story 10.4 haengt laut Epic von Story 10.3 ab, aber der relevante Fix (`env: { ...process.env }`) ist bereits in der Datei.

### Project Structure Notes

- `test-hardest/benchmark-full.mjs` — Haupt-Benchmark-Runner, wird zu `npm run benchmark`
- `test-hardest/smoke-test.mjs` — Schneller 10-Test Smoke-Test (separates Skript, nicht betroffen)
- `test-hardest/benchmark-*.json` — Bestehende Benchmark-Ergebnisse verschiedener MCP-Implementierungen
- `test-hardest/index.html` — Benchmark-Seite mit 24 Tests in 4 Levels
- `package.json` — Scripts-Sektion (aktuell: build, test, lint, format, publish:release)

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 10.4] — Acceptance Criteria, Technical Notes
- [Source: _bmad-output/planning-artifacts/prd.md#FR80] — Benchmark-Runner Anforderung
- [Source: _bmad-output/planning-artifacts/prd.md#NFR24] — Deterministische Benchmark-Tests
- [Source: _bmad-output/planning-artifacts/architecture.md#Testing] — Benchmark als Integration-Test
- [Source: test-hardest/benchmark-full.mjs] — Bestehender Runner (zu finalisieren)
- [Source: test-hardest/benchmark-silbercuechrome_mcp-llm-2026-04-05.json] — Referenz-JSON-Format (LLM-driven)
- [Source: test-hardest/benchmark-silbercuechrome_mcp-1775416756099.json] — Referenz-JSON-Format (Page-driven)
- [Source: package.json#scripts] — Aktuell kein benchmark-Script

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
