# Story 10.2: TD-001 AutoLaunch-Verhalten Tests & Dokumentation

Status: done

## Story

As a **Entwickler (Julian)**,
I want dass das AutoLaunch-Verhalten mit Tests abgesichert und dokumentiert ist,
So that Aenderungen am Chrome-Start-Verhalten nicht unbemerkt Breaking Changes einfuehren.

## Acceptance Criteria

1. **Given** Chrome laeuft bereits mit `--remote-debugging-port=9222`
   **When** der MCP-Server startet
   **Then** verbindet er sich per WebSocket zum laufenden Chrome (kein zweiter Chrome-Start)

2. **Given** kein Chrome laeuft
   **When** der MCP-Server startet und `autoLaunch` nicht explizit deaktiviert ist
   **Then** startet er Chrome mit `--remote-debugging-pipe` als Child-Prozess
   **And** die Verbindung erfolgt per CDP-Pipe (FD3/FD4)

3. **Given** kein Chrome laeuft und `autoLaunch: false` konfiguriert ist
   **When** der MCP-Server startet
   **Then** meldet er einen Verbindungsfehler (kein Auto-Launch)

4. **Given** die AutoLaunch-Tests existieren
   **When** `npm test` laeuft
   **Then** bestehen mindestens 3 Tests: WebSocket-Fallback, Pipe-Launch, autoLaunch-disabled

## Tasks / Subtasks

- [x] Task 1: Bestandsaufnahme existierender Tests (AC: #4)
  - [x] 1.1 In `src/cdp/chrome-launcher.test.ts` existieren BEREITS Tests die AC #1-#3 teilweise abdecken:
    - `ChromeLauncher > falls back to auto-launch when WebSocket fails` (Zeile 391-437) — deckt AC #2 ab (Pipe-Launch Fallback)
    - `ChromeLauncher > throws original error when autoLaunch=false and no Chrome running` (Zeile 439-446) — deckt AC #3 ab (autoLaunch disabled)
    - `WebSocket Discovery > connects via WebSocket when Chrome is running` (Zeile 270-340) — deckt AC #1 ab (WebSocket-Verbindung)
  - [x] 1.2 Feststellen welche Luecken noch bestehen — insbesondere:
    - Kein expliziter Test fuer die `autoLaunch`-Logik in `server.ts` (Zeile 29): `SILBERCUE_CHROME_AUTO_LAUNCH` env-Variable und das Verhalten `autoLaunch = true wenn headless, false wenn headed`
    - Kein Test der die GESAMTE Verbindungsstrategie (WebSocket zuerst, dann Pipe-Fallback) als zusammenhaengendes Szenario prueft
    - Kein Test fuer die env-Variable `SILBERCUE_CHROME_AUTO_LAUNCH`

- [x] Task 2: Fehlende Tests ergaenzen (AC: #1, #2, #3, #4)
  - [x] 2.1 Neuer `describe("AutoLaunch connection strategy")` Block in `src/cdp/chrome-launcher.test.ts`:
    - Test: `ChromeLauncher.connect() tries WebSocket first, falls back to pipe` — das ist der Happy-Path der Verbindungsstrategie. Bestehender Test `falls back to auto-launch when WebSocket fails` deckt das zwar ab, aber explizit als AutoLaunch-Strategie-Test benennen/verifizieren
    - Test: `ChromeLauncher with autoLaunch=false does not spawn Chrome when WebSocket fails` — Variation des bestehenden Tests, stellt sicher dass KEIN spawn() Aufruf stattfindet
    - Test: `ChromeLauncher with autoLaunch=true spawns Chrome with --remote-debugging-pipe` — verifiziert dass die korrekten Chrome-Flags gesetzt werden (speziell `--remote-debugging-pipe`, `--user-data-dir`, `--headless`)
  - [x] 2.2 Neuer `describe("autoLaunch env variable")` Block:
    - Test: `SILBERCUE_CHROME_AUTO_LAUNCH=true forces auto-launch` — setzt env, erstellt ChromeLauncher und prueft `_autoLaunch` ist true
    - Test: `SILBERCUE_CHROME_AUTO_LAUNCH=false disables auto-launch even in headless mode`
    - Test: `autoLaunch defaults to true when headless=true and env unset`
    - Test: `autoLaunch defaults to false when headless=false and env unset`
    - HINWEIS: Diese Tests pruefen die Logik aus `server.ts` Zeile 29. Die env-Logik liegt aber in `server.ts`, NICHT in `ChromeLauncher`. `ChromeLauncher` nimmt `autoLaunch` als boolean-Option. Die env-Interpretation muss entweder:
      - (a) In `server.ts` getestet werden (neuer Test-File `src/server.test.ts` — bevorzugt), ODER
      - (b) Die env-Logik nach `ChromeLauncher` oder eine Hilfsfunktion verschoben werden, um sie testbar zu machen
    - **Entscheidung:** Variante (b) — eine exportierte `resolveAutoLaunch(env, headless)` Funktion in `chrome-launcher.ts` extrahieren. Das macht die Logik testbar ohne den gesamten Server hochzufahren. In `server.ts` wird dann `resolveAutoLaunch(process.env, headless)` aufgerufen.

- [x] Task 3: `resolveAutoLaunch()` Hilfsfunktion extrahieren (AC: #1, #2, #3)
  - [x] 3.1 In `src/cdp/chrome-launcher.ts` eine neue exportierte Funktion ergaenzen:
    ```typescript
    export function resolveAutoLaunch(
      env: Record<string, string | undefined>,
      headless: boolean,
    ): boolean {
      if (env.SILBERCUE_CHROME_AUTO_LAUNCH === "true") return true;
      if (env.SILBERCUE_CHROME_AUTO_LAUNCH === "false") return false;
      // Default: autoLaunch = true wenn headless (Server-Modus), false wenn headed (Entwickler-Modus)
      return headless;
    }
    ```
  - [x] 3.2 In `src/server.ts` Zeile 29 ersetzen:
    ```typescript
    // ALT:
    const autoLaunch = process.env.SILBERCUE_CHROME_AUTO_LAUNCH === "true" || (process.env.SILBERCUE_CHROME_AUTO_LAUNCH === undefined && headless);
    // NEU:
    const autoLaunch = resolveAutoLaunch(process.env as Record<string, string | undefined>, headless);
    ```
    Import ergaenzen: `import { ChromeLauncher, resolveAutoLaunch } from "./cdp/chrome-launcher.js";`
  - [x] 3.3 Verhalten muss IDENTISCH bleiben — die alte Logik und die neue Funktion muessen dasselbe Ergebnis liefern:
    - `SILBERCUE_CHROME_AUTO_LAUNCH=true` → `true` (env override)
    - `SILBERCUE_CHROME_AUTO_LAUNCH=false` → `false` (env override)
    - `SILBERCUE_CHROME_AUTO_LAUNCH=undefined, headless=true` → `true` (default)
    - `SILBERCUE_CHROME_AUTO_LAUNCH=undefined, headless=false` → `false` (default)

- [x] Task 4: README-Dokumentation "Connection Modes" (AC: #1, #2, #3)
  - [x] 4.1 Es gibt aktuell KEIN README.md im Projekt-Root. Die Dokumentation in CLAUDE.md ist auf Entwickler beschraenkt.
    Statt README.md: Die Connection-Modes-Doku in `CLAUDE.md` im Abschnitt "Build & Run" ergaenzen. Neuer Unterabschnitt:
    ```markdown
    ### Connection Modes

    SilbercueChrome verbindet sich in dieser Reihenfolge:

    1. **WebSocket (bevorzugt):** Prueft `127.0.0.1:9222/json/version`. Wenn Chrome laeuft, verbindet sich per WebSocket.
    2. **Auto-Launch (Fallback):** Wenn kein Chrome laeuft und `autoLaunch` aktiv, startet Chrome mit `--remote-debugging-pipe` als Child-Prozess.
    3. **Fehler:** Wenn kein Chrome laeuft und `autoLaunch=false`, wirft einen Verbindungsfehler.

    **Umgebungsvariablen:**

    | Variable | Werte | Default | Beschreibung |
    |----------|-------|---------|-------------|
    | `SILBERCUE_CHROME_AUTO_LAUNCH` | `true` / `false` | `true` (headless), `false` (headed) | Chrome automatisch starten wenn kein laufendes Chrome gefunden |
    | `SILBERCUE_CHROME_HEADLESS` | `true` / `false` | `true` | Chrome im Headless-Modus starten |
    | `SILBERCUE_CHROME_PROFILE` | Pfad | — | Chrome-Profilverzeichnis (nur bei Auto-Launch) |
    | `CHROME_PATH` | Pfad | — | Pfad zur Chrome-Binary (ueberschreibt automatische Erkennung) |
    ```

- [x] Task 5: Build & Validierung (AC: #4)
  - [x] 5.1 `npm run build` erfolgreich
  - [x] 5.2 `npm test` — alle Tests gruen (1123 + neue Tests)
  - [x] 5.3 Speziell `npm test -- src/cdp/chrome-launcher.test.ts` ausfuehren und alle neuen AutoLaunch-Tests gruen

## Dev Notes

### Architektur-Kontext

Die Architektur definiert die Chrome-Launch-Strategie explizit:
> "Erst verbinden (WebSocket auf 9222), dann Auto-Launch als Child-Prozess (CDP-Pipe). Zero-Config fuer Erstnutzer, aber laufendes Chrome wird respektiert. Konfigurierbar via `autoLaunch`."
[Source: _bmad-output/planning-artifacts/architecture.md#Chrome-Launch]

Die Schichten-Architektur platziert diese Logik in Schicht 1:
> Transport-Boundary: `transport/transport.ts` definiert das Interface. CDP-Boundary: `cdp/cdp-client.ts` ist die einzige Stelle, die CDP-Nachrichten sendet/empfaengt.
[Source: _bmad-output/planning-artifacts/architecture.md#Architectural Boundaries]

### Vorhandene Infrastruktur

**ChromeLauncher (chrome-launcher.ts:513-569):**
- `ChromeLauncher.connect()` implementiert die WebSocket-First-Pipe-Fallback-Strategie
- `_autoLaunch` Boolean steuert ob Pipe-Fallback aktiviert ist
- `_connectViaWebSocket()` nutzt `fetchJsonVersion()` und `WebSocketTransport.connect()`
- `launchChrome()` spawnt Chrome mit `--remote-debugging-pipe` und Flags

**Server-Integration (server.ts:25-31):**
- `SILBERCUE_CHROME_AUTO_LAUNCH` env-Variable: `"true"` = immer, `"false"` = nie, undefined = headless-abhaengig
- `SILBERCUE_CHROME_HEADLESS` env-Variable: `"false"` = headed-Modus
- `SILBERCUE_CHROME_PROFILE` env-Variable: Chrome-Profilpfad (nur bei Auto-Launch wirksam)
- Die env-Logik lebt aktuell inline in `server.ts` Zeile 29 — NICHT in `ChromeLauncher`

**Bestehende Tests (chrome-launcher.test.ts — 37 Tests, 1022+ Zeilen):**
- `findChromePath` (3 Tests): CHROME_PATH env, null-Pfad, macOS-Detection
- `launchChrome` (3 Tests): Chrome-not-found, spawn mit Flags, cleanup bei Fehler
- `WebSocket Discovery` (4 Tests): WS-Connect, HTTP 404, invalid JSON, missing URL
- `ChromeLauncher` (2 Tests): Fallback zu Auto-Launch, autoLaunch=false Error
- `ChromeConnection` (4 Tests): close(), idempotent close, auto-reconnect, Listener-Cleanup
- `ChromeConnection.reconnect` (7 Tests): close-guard, parallel-guard, Status-Transitions, Callback, Pipe-Exit, Backoff, Close-during-reconnect, Callback-Error, WS-Close
- `Chrome Profile Support` (7 Tests): profilePath launch, temp-dir regression, invalid path, Launcher+profile, WS+profile, close+profile, reconnect+profile

### Kritische Design-Entscheidungen

1. **`resolveAutoLaunch()` als reine Funktion extrahieren:** Die env-Variable-Interpretation aus `server.ts` Zeile 29 in eine testbare reine Funktion in `chrome-launcher.ts` verschieben. Kein neues File noetig, konsistent mit der bestehenden Architektur (chrome-launcher.ts enthaelt alle Launch-Logik).

2. **Tests in chrome-launcher.test.ts, NICHT in server.test.ts:** Alle AutoLaunch-Tests gehoeren in die bestehende Test-Datei. Die `resolveAutoLaunch()` Funktion lebt in chrome-launcher.ts, also gehoert der Test dorthin. Es gibt keinen `server.test.ts` und einen zu erstellen waere Over-Engineering — der Server braucht eine laufende Chrome-Instanz.

3. **Doku in CLAUDE.md statt README.md:** Es gibt kein README.md im Projekt-Root. Die CLAUDE.md ist die primaere Entwickler-Doku. Neuer Abschnitt "Connection Modes" unter "Build & Run".

4. **Bestehende Tests NICHT duplizieren:** Die existierenden Tests in `ChromeLauncher` und `WebSocket Discovery` decken AC #1-#3 bereits teilweise ab. Die neuen Tests fokussieren sich auf die Luecken: env-Variable-Logik (`resolveAutoLaunch()`) und explizite AutoLaunch-Strategie-Benennung.

### Abgrenzung

- **Modifiziert:** `src/cdp/chrome-launcher.ts` (neue Funktion `resolveAutoLaunch()`)
- **Modifiziert:** `src/cdp/chrome-launcher.test.ts` (neue Tests fuer `resolveAutoLaunch()` und AutoLaunch-Strategie)
- **Modifiziert:** `src/server.ts` (Import + Aufruf `resolveAutoLaunch()` statt inline-Logik)
- **Modifiziert:** `CLAUDE.md` (neuer Abschnitt "Connection Modes")
- **KEIN neues File** — alles in bestehende Dateien
- **KEIN Produktionscode-Verhalten wird geaendert** — rein refactoring der env-Logik + Tests + Doku
- **KEIN neues Feature** — Tech-Debt-Beseitigung (TD-001)

### Testing-Patterns

- Bestehende Tests in `src/cdp/chrome-launcher.test.ts` — Co-located mit der Implementation
- Mock-Pattern fuer Chrome-Spawn: `vi.mock("node:child_process")` + `createMockChildProcess()` + `simulateCdpResponse()`
- Mock-Pattern fuer WebSocket: Eigener `createServer()` mit WebSocket-Upgrade-Handler + echtem HTTP-Port
- Mock-Pattern fuer HTTP: `startMockHttpServer()` mit dynamischem Port
- `resolveAutoLaunch()` ist eine reine Funktion — braucht KEINE Mocks, nur direkte Aufrufe mit verschiedenen Inputs
- Alle Tests muessen nach dem Fix gruen sein (aktuell: 1123 passed)

### Vorherige Story-Learnings (aus Story 10.1)

- Story 10.1 hat einen Mock-Format-Mismatch in `license-commands.test.ts` repariert — der Mock lieferte altes API-Format statt des neuen Polar.sh-Formats
- Pattern: Wenn Produktionscode API-Formate aendert, muessen ALLE Test-Mocks aktualisiert werden (nicht nur die direkt zugehoerigen)
- Kein Produktionscode wurde geaendert — NUR Test-Mocks
[Source: _bmad-output/implementation-artifacts/10-1-fix-license-commands-test.md]

### Git Intelligence

Letzte relevante Commits:
- `e666903` feat(story-9.9): Pro feature gates for switch_tab, virtual_desk, human touch
- `8c17a20` feat: BUG-002-012 fixes, headed mode, benchmark data, BMAD skills
- `83d0596` fix: WebSocket accept bypass (BUG-003) and autoLaunch env support

Commit `83d0596` hat die `SILBERCUE_CHROME_AUTO_LAUNCH` env-Variable in `server.ts` eingefuehrt — das ist die Logik die jetzt mit Tests abgesichert werden muss.

### Project Structure Notes

- `src/cdp/chrome-launcher.ts` — Launch-Logik, `ChromeLauncher`, `ChromeConnection`, neue `resolveAutoLaunch()`
- `src/cdp/chrome-launcher.test.ts` — 37 bestehende Tests, neue AutoLaunch-Tests hier ergaenzen
- `src/server.ts` — env-Variable-Interpretation, Refactoring auf `resolveAutoLaunch()`
- `CLAUDE.md` — Entwickler-Dokumentation, neuer Abschnitt "Connection Modes"

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 10.2] — Acceptance Criteria, Technical Notes
- [Source: _bmad-output/planning-artifacts/architecture.md#Chrome-Launch] — Verbindungsstrategie
- [Source: _bmad-output/planning-artifacts/architecture.md#Architectural Boundaries] — Transport-/CDP-Boundary
- [Source: docs/deferred-work.md#TD-001] — Tech-Debt-Eintrag "AutoLaunch Tests + Doku"
- [Source: src/cdp/chrome-launcher.ts#Zeile 513-569] — ChromeLauncher.connect() Implementierung
- [Source: src/cdp/chrome-launcher.ts#Zeile 19-28] — ChromeConnectionOptions Interface
- [Source: src/server.ts#Zeile 25-31] — autoLaunch env-Logik (zu refactoren)
- [Source: src/cdp/chrome-launcher.test.ts#Zeile 390-447] — Bestehende ChromeLauncher-Tests

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
