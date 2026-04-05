# Story 12.4: Tool-Definitions-Token-Zaehler (npm run token-count)

Status: done

## Story

As a **Entwickler (Julian)**,
I want ein Script das den Token-Overhead der Tool-Definitionen misst,
So that ich bei Aenderungen an Tool-Schemas sofort sehe ob das 5000-Token-Budget (NFR4) eingehalten wird.

## Acceptance Criteria

1. **Given** der Entwickler fuehrt `npm run token-count` aus
   **When** das Script laeuft
   **Then** listet es jedes Tool mit seiner geschaetzten Token-Anzahl auf
   **And** zeigt die Gesamtsumme aller Tool-Definitionen
   **And** markiert PASS/FAIL basierend auf dem 5000-Token-Budget (NFR4)

2. **Given** die Tool-Definitionen aendern sich
   **When** `npm run token-count` erneut ausgefuehrt wird
   **Then** zeigt es die aktualisierte Zaehlung

3. **Given** das Budget ueberschritten wird
   **When** das Script laeuft
   **Then** gibt es Exit-Code 1 zurueck (fuer CI-Integration)

## Tasks / Subtasks

- [x] Task 1: Script `scripts/token-count.mjs` erstellen (AC: #1, #2)
  - [x] 1.1 Neues File `scripts/token-count.mjs` anlegen. ESM-Format (`.mjs`), kein TypeScript-Build noetig
  - [x] 1.2 MCP-Client per `@modelcontextprotocol/sdk` starten: `StdioClientTransport` mit `command: "node"`, `args: ["build/index.js"]`, `env: { ...process.env }` — identisch zum Pattern in `test-hardest/benchmark-full.mjs` (Zeile 5-20)
  - [x] 1.3 `client.listTools()` aufrufen um alle registrierten Tool-Definitionen zu erhalten
  - [x] 1.4 Fuer jedes Tool: `name`, `description`, `inputSchema` extrahieren und Token-Schaetzung berechnen: `Math.ceil(JSON.stringify({ name, description, inputSchema }).length / 4)`
  - [x] 1.5 Ergebnis-Tabelle auf stdout ausgeben: Tool-Name, Token-Schaetzung, sortiert nach Groesse absteigend
  - [x] 1.6 Gesamtsumme berechnen: `Math.ceil(JSON.stringify(allTools).length / 4)` — JSON-stringify des gesamten `tools`-Arrays, nicht Summe der Einzelwerte (wegen Array-Overhead `[{...},{...}]`)
  - [x] 1.7 PASS/FAIL-Markierung: `PASS` wenn Gesamtsumme < 5000, `FAIL` wenn >= 5000
  - [x] 1.8 MCP-Client und Transport sauber schliessen (`await client.close()`, `await transport.close()`)

- [x] Task 2: Exit-Code bei Budget-Ueberschreitung (AC: #3)
  - [x] 2.1 Wenn Gesamtsumme >= 5000: `process.exit(1)` nach der Ausgabe
  - [x] 2.2 Wenn Gesamtsumme < 5000: `process.exit(0)` (oder normales Script-Ende)

- [x] Task 3: `package.json` Script-Eintrag (AC: #1, #2)
  - [x] 3.1 Neuen Script-Eintrag in `package.json`: `"token-count": "node scripts/token-count.mjs"`
  - [x] 3.2 Eintrag alphabetisch unter den bestehenden Scripts einfuegen (nach `test`, vor oder nach anderen — Konsistenz mit Bestand)

- [x] Task 4: Build + bestehende Tests gruen (AC: #1)
  - [x] 4.1 `npm run build` erfolgreich — Script nutzt `build/index.js`, also muss der Build aktuell sein
  - [x] 4.2 `npm test` — alle bestehenden Tests bestehen weiterhin (keine Regressionen)
  - [x] 4.3 `npm run token-count` laeuft durch und zeigt die Tool-Tabelle (Chrome muss NICHT laufen — der Server connected erst bei Tool-Aufruf, `listTools` braucht keine Chrome-Verbindung)

## Dev Notes

### Script-Architektur: MCP-Client statt Source-Parsing

Das Script startet den MCP-Server als Subprocess (ueber `StdioClientTransport`) und ruft `client.listTools()` auf. Das ist zuverlaessiger als Source-Code-Parsing, weil es die tatsaechlich registrierten Tools mit ihren finalen Schemas misst — inklusive aller Zod-Transformationen und dynamischen Registrierungen (z.B. `handle_dialog` und `console_logs` die nur bedingt registriert werden).

Die Alternative (Tool-Schemas direkt importieren) wuerde einen TypeScript-Build voraussetzen und koennte bedingte Registrierungen (`if (this._dialogHandler)`) nicht abbilden. `listTools()` liefert exakt das, was der MCP-Client sieht.

### Token-Schaetzung: Gesamtsumme vs. Einzelsumme

Die Gesamtsumme wird auf dem gesamten serialisierten `tools`-Array berechnet, NICHT als Summe der Einzelwerte. Grund: Das JSON-Array hat Overhead (`[`, `]`, Kommas) und die Gesamtserialisierung kann leicht anders ausfallen als die Summe der Teile. Die Einzelwerte pro Tool dienen nur der Orientierung und Sortierung.

Formel: `Math.ceil(JSON.stringify(tools).length / 4)` — identisch zur Epics-Spezifikation.

### StdioClientTransport-Pattern aus benchmark-full.mjs

Das Pattern fuer den MCP-Client-Start ist in `test-hardest/benchmark-full.mjs` (Zeile 5-20) etabliert:

```javascript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  env: { ...process.env },
});
const client = new Client({ name: "token-count", version: "1.0.0" });
await client.connect(transport);
```

WICHTIG: `env: { ...process.env }` muss gesetzt werden (Story 10.3 Fix), damit Umgebungsvariablen (z.B. `SILBERCUE_LICENSE_KEY`) korrekt weitergegeben werden.

### Chrome-Verbindung NICHT noetig

`client.listTools()` ist ein MCP-Protokoll-Call der die Tool-Definitionen vom Server abfragt. Das passiert VOR jeglicher Chrome-Interaktion — der Server registriert alle Tools im Konstruktor von `ToolRegistry`, unabhaengig davon ob eine Chrome-Verbindung besteht. Der Server wird kurz starten, `listTools` beantworten, und dann wieder beendet.

ACHTUNG: Der Server gibt beim Start Warnungen auf stderr aus wenn Chrome nicht laeuft ("Failed to connect to Chrome"). Das ist erwartet und soll NICHT als Fehler gewertet werden. Das Script muss stderr nicht filtern — die Ausgabe geht direkt an das Terminal, die `listTools`-Response kommt trotzdem ueber stdin/stdout.

### Bedingt registrierte Tools

Einige Tools werden nur registriert wenn ihre Dependencies vorhanden sind:
- `handle_dialog` — nur wenn `DialogHandler` existiert (immer, da im Standard-Setup erstellt)
- `console_logs` — nur wenn `ConsoleCollector` existiert (immer im Standard-Setup)
- `network_monitor` — nur wenn `NetworkCollector` existiert (immer im Standard-Setup)
- `configure_session` — nur wenn `SessionDefaults` existiert (immer im Standard-Setup)

Im Standard-Setup werden alle 18 Tools registriert. Das Script misst also alle 18 Tools.

### Aktuell 18 registrierte Tools

Stand nach Epic 9: `evaluate`, `navigate`, `read_page`, `screenshot`, `wait_for`, `click`, `type`, `tab_status`, `switch_tab`, `virtual_desk`, `dom_snapshot`, `handle_dialog`, `file_upload`, `fill_form`, `console_logs`, `network_monitor`, `run_plan`, `configure_session`.

### Erwartete Ausgabe

```
Tool-Definitions Token Count
═══════════════════════════════════════
  run_plan             ~820 tokens
  fill_form            ~380 tokens
  navigate             ~180 tokens
  ...                  ...
  tab_status           ~45 tokens
───────────────────────────────────────
  TOTAL                ~3200 tokens
  BUDGET               5000 tokens
  STATUS               PASS ✓
═══════════════════════════════════════
```

Die konkreten Zahlen sind geschaetzt — die tatsaechlichen Werte ergeben sich erst beim Lauf. `run_plan` wird das groesste Tool sein (komplexes Schema mit steps, parallel, conditions).

### Kein Unit-Test fuer das Script

Das Script ist ein CLI-Tool (wie `benchmark-full.mjs`), kein Library-Code. Es wird nicht in `src/` angelegt und braucht keinen Unit-Test. Die Validierung erfolgt durch `npm run token-count` im manuellen Smoke-Test.

### Dateien die geaendert werden

1. `scripts/token-count.mjs` — **NEU**, das Haupt-Script
2. `package.json` — neuer `"token-count"` Script-Eintrag

### Keine TypeScript-Aenderungen

Dieses Script aendert nur `scripts/token-count.mjs` (neu) und `package.json` (Script-Eintrag). Keine Aenderungen an `src/` — die Tool-Definitionen bleiben unveraendert.

### Project Structure Notes

- `scripts/` Ordner existiert bereits: `scripts/publish.ts`, `scripts/publish.test.ts`
- Neues Script als `.mjs` (nicht `.ts`) weil es kein Build braucht und direkt mit `node` laeuft — konsistent mit `test-hardest/benchmark-full.mjs`
- `package.json` hat bereits: `build`, `test`, `lint`, `format`, `benchmark`, `publish:release`
- Neuer Eintrag: `"token-count": "node scripts/token-count.mjs"`

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 12.4] — Acceptance Criteria und Technical Notes
- [Source: _bmad-output/planning-artifacts/prd.md#NFR4] — "Tool-Definitionen-Payload unter 5.000 Tokens"
- [Source: _bmad-output/planning-artifacts/prd.md#FR32] — "Tool-Definitionen unter 5.000 Tokens"
- [Source: _bmad-output/planning-artifacts/architecture.md#Tool-Registrierung] — ToolRegistry Pattern, server.tool() Aufrufe
- [Source: src/registry.ts#L339-L643] — Alle 18 Tool-Registrierungen mit Schemas und Descriptions
- [Source: test-hardest/benchmark-full.mjs#L5-L20] — StdioClientTransport Pattern fuer MCP-Client-Start
- [Source: package.json#scripts] — Bestehende npm-Scripts
- [Source: scripts/publish.ts] — Bestehende Script-Datei im scripts/ Ordner

### Previous Story Intelligence (Story 12.3)

Story 12.3 hat eine `callToolRaw()`-Hilfsfunktion im Benchmark-Runner eingefuehrt fuer vollen Response-Zugriff inkl. `_meta`. Fuer dieses Script irrelevant — wir nutzen `client.listTools()`, nicht `client.callTool()`.

Story 12.3 ist noch `ready-for-dev`, aber das hat keinen Einfluss auf Story 12.4: Es gibt keine Abhaengigkeit zwischen den beiden. Story 12.4 misst Tool-Definitionen, nicht Runtime-Responses.

### Git Intelligence

Letzte relevante Commits:
- `841f625` feat(story-12.2): Add _meta.estimated_tokens to read_page and dom_snapshot
- `e34e11a` feat(story-12.1): Add _meta.response_bytes to all tool responses
- `4506ccf` feat(story-10.4): Finalize benchmark runner with npm run benchmark

Commit-Pattern: `feat(story-X.Y): Beschreibung`. Fuer diese Story: `feat(story-12.4): Add npm run token-count for tool definition budget check`.

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
