# Story 12.1: _meta.response_bytes in allen Tool-Responses

Status: done

## Story

As a **AI-Agent-Entwickler**,
I want dass jede Tool-Response `_meta.response_bytes` enthaelt,
So that ich den Token-Footprint jedes Tool-Calls sehen und optimieren kann.

## Acceptance Criteria

1. **Given** der Agent ruft ein beliebiges Tool auf (navigate, click, read_page, etc.)
   **When** die Response zurueckgegeben wird
   **Then** enthaelt `_meta` das Feld `response_bytes` mit der Groesse des serialisierten Content-Arrays in Bytes

2. **Given** eine navigate-Response mit 500 Bytes Content
   **When** `_meta.response_bytes` gelesen wird
   **Then** ist der Wert 500 (+/-10% Toleranz fuer Serialisierungs-Overhead)

3. **Given** eine leere Response (z.B. click ohne Rueckgabe)
   **When** `_meta.response_bytes` gelesen wird
   **Then** ist der Wert > 0 (mindestens die Mindest-Response-Struktur)

## Tasks / Subtasks

- [x] Task 1: Zentrale response_bytes-Berechnung in `src/registry.ts` (AC: #1, #2, #3)
  - [x] 1.1 In der `wrap()`-Funktion (Zeile ~267) den Response-Postprocessor einbauen: Nach dem `dialogWrapped()`-Aufruf und vor dem Return das `_meta.response_bytes` Feld setzen
  - [x] 1.2 Berechnung: `Buffer.byteLength(JSON.stringify(result.content), 'utf8')` — serialisiert nur das `content`-Array, nicht die gesamte Response
  - [x] 1.3 Sicherstellen dass `result._meta` existiert bevor `response_bytes` gesetzt wird (Defensive Guard: `if (result._meta)`)
  - [x] 1.4 In `executeTool()` (Zeile ~116) dieselbe Berechnung nach dem `handler()`-Aufruf und nach `_injectDialogNotifications()` einfuegen — gleiche Logik wie in `wrap()`

- [x] Task 2: Unit-Tests in `src/registry.test.ts` (AC: #1, #2, #3)
  - [x] 2.1 Test: Jeder Tool-Call ueber `executeTool()` hat `_meta.response_bytes` als positive Zahl
  - [x] 2.2 Test: `response_bytes` entspricht `Buffer.byteLength(JSON.stringify(content), 'utf8')` des tatsaechlichen Content-Arrays
  - [x] 2.3 Test: Bestehende `_meta`-Felder (`elapsedMs`, `method`) bleiben erhalten
  - [x] 2.4 Test: Leere/minimale Response hat `response_bytes > 0`
  - [x] 2.5 Test: Response mit Image-Content (Screenshot) hat korrekte Byte-Zaehlung

- [x] Task 3: Build + alle bestehenden Tests gruen (AC: #1)
  - [x] 3.1 `npm run build` erfolgreich
  - [x] 3.2 `npm test` — alle 1146 Tests bestehen
  - [x] 3.3 Keine Regressionen in bestehenden `_meta`-Assertions

## Dev Notes

### Implementierungsstrategie: Zentraler Postprocessor

Die Berechnung muss an genau **2 Stellen** in `src/registry.ts` eingefuegt werden — nicht in den einzelnen Tool-Handlern:

1. **`wrap()`-Funktion** (Zeile ~267, `registerAll()` Scope) — fuer den direkten MCP-Pfad (`server.tool()` Callbacks). Hier wird die Response nach `dialogWrapped()` und nach der Suggestion-Injection bearbeitet, aber VOR dem Return.

2. **`executeTool()`-Methode** (Zeile ~116) — fuer den `run_plan`-Pfad. Hier wird die Response nach `handler()`, nach `_injectDialogNotifications()` und nach der Suggestion-Injection bearbeitet, aber VOR dem Return.

**Code-Snippet fuer beide Stellen (identisch):**

```typescript
// Story 12.1: Inject response_bytes into _meta
if (result._meta) {
  result._meta.response_bytes = Buffer.byteLength(JSON.stringify(result.content), 'utf8');
}
```

### Warum nur `content` serialisiert wird

Die Epics-Spezifikation sagt "Groesse des serialisierten Content-Arrays in Bytes". Das `_meta`-Objekt und `isError`-Flag zaehlen nicht mit — der Agent will wissen wie viel Token-Last das eigentliche Content erzeugt, nicht der Transport-Overhead.

### Performance-Auswirkung

`JSON.stringify(content) + Buffer.byteLength` ist <1ms selbst bei grossen Responses. Screenshots enthalten Base64-Daten (~100KB), deren Stringifizierung ist dennoch <5ms. Kein merkbarer Impact auf `elapsedMs`.

### Bestehende _meta-Felder

Jeder Tool-Handler setzt bereits `_meta: { elapsedMs, method }`. Manche setzen zusaetzlich `suggestion` (Story 7.3). Das neue `response_bytes` Feld wird NACH allen bestehenden Modifikationen gesetzt — es ueberschreibt nichts.

### Zwei Ausfuehrungspfade in registry.ts

- **Direkter MCP-Pfad:** `server.tool()` → `wrap()` → Tool-Handler → Response
- **run_plan-Pfad:** `executeTool()` → `_handlers.get()` → Tool-Handler → Response

Beide Pfade muessen `response_bytes` injizieren. Die `_handlers`-Map (Zeile 607ff) registriert die Tool-Handler OHNE die `wrap()`-Funktion — deshalb muss `executeTool()` separat behandelt werden.

### Edge Cases

- **Suspended Plan Response:** In `executeTool()` gibt es einen speziellen Pfad fuer `run_plan` der `SuspendedPlanResponse` in `ToolResponse` konvertiert. Dieser Pfad ist NICHT betroffen, weil `run_plan` nicht in `_handlers` registriert ist (rekursive Invokation verhindert).
- **Image-Content:** Screenshots enthalten `{ type: "image", data: "base64...", mimeType: "image/webp" }`. Die `data`-Property ist ein langer Base64-String. `JSON.stringify` serialisiert das korrekt — `response_bytes` wird entsprechend gross sein. Das ist gewollt.
- **Error-Responses:** `isError: true` Responses haben ebenfalls `_meta` und bekommen `response_bytes`.
- **Gate-blocked Responses:** Pro-Feature-Gate Responses (z.B. `dom_snapshot` im Free-Tier) haben `_meta` und bekommen ebenfalls `response_bytes`.

### Project Structure Notes

- Aenderungen beschraenken sich auf `src/registry.ts` und `src/registry.test.ts`
- Keine neuen Dateien, keine neuen Dependencies
- Kein Eingriff in individuelle Tool-Handler (`src/tools/*.ts`)
- `src/types.ts` bleibt unveraendert — `ToolMeta` hat bereits `[key: string]: unknown` Index-Signatur, `response_bytes` passt ohne Typenerweiterung

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 12.1] — Acceptance Criteria und Technical Notes
- [Source: _bmad-output/planning-artifacts/prd.md#FR78] — "Jede Tool-Response enthaelt _meta.response_bytes"
- [Source: _bmad-output/planning-artifacts/architecture.md#MCP Response Format] — Bestehende _meta-Struktur mit elapsedMs, method
- [Source: _bmad-output/planning-artifacts/architecture.md#Tool-Registrierung] — ToolRegistry.wrap() Pattern
- [Source: src/types.ts#ToolMeta] — Interface mit `[key: string]: unknown` Index-Signatur
- [Source: src/registry.ts#wrap()] — Zeile ~267, zentraler Response-Wrapper fuer MCP-Pfad
- [Source: src/registry.ts#executeTool()] — Zeile ~116, Dispatch fuer run_plan-Pfad

### Git Intelligence

Letzte relevante Commits:
- `e666903` feat(story-9.9): Pro feature gates for switch_tab, virtual_desk, human touch
- `4f8de6b` feat(story-10.5): Validate and fix PRD addendum consistency
- `4506ccf` feat(story-10.4): Finalize benchmark runner with npm run benchmark

Alle Commits folgen dem Pattern `feat(story-X.Y): Beschreibung`. Fuer diese Story: `feat(story-12.1): Add _meta.response_bytes to all tool responses`.

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
