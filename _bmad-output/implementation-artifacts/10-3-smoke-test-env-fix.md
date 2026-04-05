# Story 10.3: Smoke-Test env-Fix (StdioClientTransport)

Status: done

## Story

As a **Entwickler (Julian)**,
I want dass der Smoke-Test (`node test-hardest/smoke-test.mjs`) zuverlaessig laeuft,
So that ein schneller End-to-End-Check nach Aenderungen moeglich ist.

## Acceptance Criteria

1. **Given** Chrome laeuft mit Remote Debugging auf Port 9222
   **When** `node test-hardest/smoke-test.mjs` ausgefuehrt wird
   **Then** startet der MCP-Server als Child-Prozess, fuehrt 10 Tests aus und beendet sich sauber

2. **Given** der Smoke-Test-Prozess
   **When** der MCP-Server als Child-Prozess gestartet wird
   **Then** werden relevante Umgebungsvariablen (PATH, HOME, CHROME_FLAGS, SILBERCUE_*) an den Child-Prozess weitergegeben
   **And** der StdioClientTransport verbindet sich fehlerfrei

3. **Given** ein Test fehlschlaegt
   **When** die Ergebnisse angezeigt werden
   **Then** zeigt der Output den Testnamen, die erwartete vs. tatsaechliche Antwort, und die verstrichene Zeit

## Tasks / Subtasks

- [x] Task 1: env-Fix in `test-hardest/smoke-test.mjs` (AC: #1, #2)
  - [x] 1.1 In `test-hardest/smoke-test.mjs` Zeile 55-59 den `StdioClientTransport`-Konstruktor um `env: { ...process.env }` ergaenzen:
    ```javascript
    // ALT (Zeile 55-59):
    const transport = new StdioClientTransport({
      command: "node",
      args: ["build/index.js"],
      cwd: new URL("..", import.meta.url).pathname,
    });

    // NEU:
    const transport = new StdioClientTransport({
      command: "node",
      args: ["build/index.js"],
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env },
    });
    ```
  - [x] 1.2 **Warum:** `StdioClientTransport` nutzt ohne explizite `env`-Option die Funktion `getDefaultEnvironment()`, die NUR diese 6 Variablen weitergibt: `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`. Damit fehlen dem Child-Prozess (MCP-Server) alle `SILBERCUE_*`-Variablen (`SILBERCUE_CHROME_AUTO_LAUNCH`, `SILBERCUE_CHROME_HEADLESS`, `SILBERCUE_CHROME_PROFILE`), `CHROME_PATH` und alle anderen Custom-env-Variablen.
    [Source: node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js Zeile 8-42]

- [x] Task 2: Gleichen env-Fix in ALLEN anderen `.mjs`-Dateien anwenden (AC: #2)
  - [x] 2.1 `test-hardest/benchmark-full.mjs` Zeile 61-65: `env: { ...process.env }` hinzufuegen
  - [x] 2.2 `test-hardest/full-benchmark.mjs` Zeile 82-86: `env: { ...process.env }` hinzufuegen
  - [x] 2.3 `test-hardest/run-mcp-benchmark.mjs` Zeile 68-72: `env: { ...process.env }` hinzufuegen
  - [x] 2.4 `test-hardest/epic5b-test.mjs` Zeile 57-61: `env: { ...process.env }` hinzufuegen
  - [x] 2.5 **Alle 5 Dateien** haben exakt dasselbe Pattern — kein `env`-Feld im `StdioClientTransport`-Konstruktor. Der Fix ist identisch.

- [x] Task 3: Validierung (AC: #1, #3)
  - [x] 3.1 `npm run build` erfolgreich (der Smoke-Test nutzt `build/index.js`)
  - [x] 3.2 Chrome mit Remote Debugging starten: `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222`
  - [x] 3.3 Benchmark-Server starten: `cd test-hardest && python3 -m http.server 4242`
  - [x] 3.4 `node test-hardest/smoke-test.mjs` ausfuehren — alle 10 Tests muessen gruen sein
  - [x] 3.5 Pruefen dass die Ausgabe pro Test den Testnamen und die Zeit in ms zeigt (bereits implementiert via `log()` Funktion)

## Dev Notes

### Root-Cause-Analyse

Das `@modelcontextprotocol/sdk` (Version im Projekt installiert) implementiert `StdioClientTransport.start()` so, dass es beim `spawn()` die env-Variablen wie folgt zusammensetzt:

```javascript
env: {
  ...getDefaultEnvironment(),  // NUR: HOME, LOGNAME, PATH, SHELL, TERM, USER
  ...this._serverParams.env    // undefined wenn nicht gesetzt → kein Merge
}
```

Ohne explizites `env`-Feld im Konstruktor erhaelt der Child-Prozess (SilbercueChrome MCP-Server) NUR die 6 Default-Variablen. Der MCP-Server liest aber in `src/server.ts` (Zeile 27-28):
- `process.env.SILBERCUE_CHROME_PROFILE` → `undefined` (nicht weitergegeben)
- `process.env.SILBERCUE_CHROME_HEADLESS` → `undefined` (nicht weitergegeben, Default-Verhalten greift)
- `process.env.SILBERCUE_CHROME_AUTO_LAUNCH` → `undefined` (nicht weitergegeben)

Und in `src/cdp/chrome-launcher.ts`:
- `CHROME_PATH` → `undefined` (nicht weitergegeben)

Mit `env: { ...process.env }` werden ALLE Umgebungsvariablen des aufrufenden Prozesses an den Child-Prozess weitergegeben.
[Source: node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js Zeile 60-75]

### Betroffene Dateien (vollstaendige Liste)

| Datei | Zeile | Aenderung |
|-------|-------|-----------|
| `test-hardest/smoke-test.mjs` | 55-59 | `env: { ...process.env }` hinzufuegen |
| `test-hardest/benchmark-full.mjs` | 61-65 | `env: { ...process.env }` hinzufuegen |
| `test-hardest/full-benchmark.mjs` | 82-86 | `env: { ...process.env }` hinzufuegen |
| `test-hardest/run-mcp-benchmark.mjs` | 68-72 | `env: { ...process.env }` hinzufuegen |
| `test-hardest/epic5b-test.mjs` | 57-61 | `env: { ...process.env }` hinzufuegen |

### Abgrenzung

- **KEIN Produktionscode wird geaendert** — NUR `test-hardest/*.mjs` Dateien
- **KEIN neues File** — rein Modifikation bestehender Dateien
- **KEINE neuen Abhaengigkeiten**
- **KEIN neues Feature** — Bug-Fix in Test-Infrastruktur
- **KEINE Unit-Tests betroffen** — die `.mjs`-Dateien sind Integration/Smoke-Tests, nicht von `npm test` erfasst
- Story 10.4 (Benchmark-Runner finalisieren) haengt von diesem Fix ab — der env-Fix muss auch in `benchmark-full.mjs` landen

### Kritische Design-Entscheidungen

1. **`{ ...process.env }` statt selektivem env-Forwarding:** Die Alternative waere nur bestimmte Variablen weiterzuleiten (z.B. `SILBERCUE_*`, `CHROME_PATH`). `{ ...process.env }` ist robuster — wenn neue env-Variablen dazukommen, werden sie automatisch weitergegeben. Der Smoke-Test ist lokale Infrastruktur, keine Sicherheitsgrenze.

2. **Alle 5 `.mjs`-Dateien fixen, nicht nur `smoke-test.mjs`:** Das Epic definiert den Fix fuer `smoke-test.mjs`, aber alle Dateien haben denselben Bug. Konsistenz und Vermeidung von zukuenftigen Debug-Sessions rechtfertigen den Mehraufwand (5 Zeilen statt 1).

### Vorherige Story-Learnings (aus Story 10.1 und 10.2)

- Story 10.1: Mock-Format-Mismatch nach API-Aenderung — wenn sich Formate aendern, ALLE Konsumenten pruefen (nicht nur den direkten). Analog hier: wenn ein env-Fix in smoke-test.mjs noetig ist, ALLE `.mjs`-Dateien pruefen.
- Story 10.2: `resolveAutoLaunch()` Hilfsfunktion extrahiert env-Variable-Logik — diese env-Variablen muessen ueber den StdioClientTransport im Smoke-Test ankommen, sonst greifen die Defaults statt der gesetzten Werte.
[Source: _bmad-output/implementation-artifacts/10-1-fix-license-commands-test.md]
[Source: _bmad-output/implementation-artifacts/10-2-autolaunch-tests-doku.md]

### Git Intelligence

Letzte relevante Commits:
- `3f0f9c7` feat(story-10.1): Fix license-commands test mock format (Polar.sh)
- `e666903` feat(story-9.9): Pro feature gates for switch_tab, virtual_desk, human touch
- `83d0596` fix: WebSocket accept bypass (BUG-003) and autoLaunch env support

Commit `83d0596` hat die `SILBERCUE_CHROME_AUTO_LAUNCH` env-Variable eingefuehrt — genau diese Variable kommt ohne den env-Fix nicht beim MCP-Server-Child-Prozess an.

### Project Structure Notes

- `test-hardest/` — Benchmark-Suite und Smoke-Tests, NICHT Teil des `npm test` (vitest) Laufs
- `test-hardest/*.mjs` — ESM-Module, werden direkt mit `node` ausgefuehrt
- Alle `.mjs`-Dateien nutzen `@modelcontextprotocol/sdk/client/stdio.js` fuer `StdioClientTransport`
- Der MCP-Server wird als `node build/index.js` Child-Prozess gestartet

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 10.3] — Acceptance Criteria, Technical Notes
- [Source: _bmad-output/planning-artifacts/architecture.md#NFRs] — NFR9 Zuverlaessigkeit, NFR24 Integration
- [Source: node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js#Zeile 8-42] — getDefaultEnvironment() limitiert auf 6 Variablen
- [Source: node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js#Zeile 60-75] — spawn() env-Merge-Logik
- [Source: test-hardest/smoke-test.mjs#Zeile 55-59] — StdioClientTransport ohne env
- [Source: src/server.ts#Zeile 27-28] — SILBERCUE_* env-Variablen die der MCP-Server liest

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
