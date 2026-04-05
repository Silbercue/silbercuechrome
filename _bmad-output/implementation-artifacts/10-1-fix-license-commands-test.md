# Story 10.1: Fix fehlschlagender Test (license-commands.test.ts)

Status: done

## Story

As a **Entwickler (Julian)**,
I want dass alle Unit-Tests gruen sind,
So that die Test-Suite als zuverlaessiges Quality-Gate funktioniert.

## Acceptance Criteria

1. **Given** die aktuelle Test-Suite (`npm test`)
   **When** alle Tests ausgefuehrt werden
   **Then** bestehen alle Tests inklusive `license-commands.test.ts` ohne Fehler

2. **Given** der fehlschlagende Test in `license-commands.test.ts`
   **When** die Root-Cause analysiert wird
   **Then** wird der Test repariert (nicht geloescht oder geskippt)
   **And** der Fix adressiert die tatsaechliche Ursache, nicht das Symptom

## Root-Cause-Analyse (vorab ermittelt)

**Fehlschlagender Test:** `license activate > activates successfully with valid key` (Zeile 263-269)

**Symptom:** Test erwartet `"License aktiviert"`, bekommt aber `"License-Key ungueltig. Pruefe den Key und versuche es erneut."`

**Ursache:** Story 9.8 hat `LicenseValidator.validateRemote()` auf das Polar.sh API-Format umgestellt. Die Validierung prueft jetzt `body.status === "granted"` (Polar-Response) statt `body.valid === true` (altes Format). Der Mock in `license-commands.test.ts` liefert aber noch das alte Format `{ valid: true, features: [...] }`.

**Beweis:**
- `src/license/license-validator.ts:117-118`: `const body = (await res.json()) as PolarValidationResponse; const valid = body.status === "granted";`
- `src/license/license-validator.ts:20-23`: `interface PolarValidationResponse { status: string; ... }`
- `src/cli/license-commands.test.ts:38-45`: `mockFetchOk` liefert `{ valid, features }` — FEHLT `status: "granted"`
- `src/license/license-validator.test.ts:26-32`: Korrekte Version: `{ status: valid ? "granted" : "revoked" }`

**Kausalkette:** `mockFetchOk(true)` → `{ valid: true, features: ["dom_snapshot"] }` → `body.status === undefined` → `valid = false` → `validator.isPro() = false` → Cache wird mit `valid: false` geschrieben → `readCacheDirectly` findet `cache.valid === false` → `"License-Key ungueltig"` Meldung

## Tasks / Subtasks

- [x] Task 1: Mock-Funktion `mockFetchOk` auf Polar-Format umstellen (AC: #1, #2)
  - [x] 1.1 In `src/cli/license-commands.test.ts`, Zeile 38-46: Die `mockFetchOk(valid, features)` Funktion aendern. Der `json()`-Callback muss `{ status: valid ? "granted" : "revoked" }` zurueckliefern statt `{ valid, features }`:
    ```typescript
    function mockFetchOk(valid: boolean, _features: string[] = []): void {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ status: valid ? "granted" : "revoked" }),
        }),
      );
    }
    ```
  - [x] 1.2 Der `features`-Parameter wird zum Kompatibilitaets-Placeholder (Aufrufe wie `mockFetchOk(true, ["dom_snapshot"])` in Zeile 264 bleiben kompilierbar). Falls gewuenscht: Parameter entfernen und Aufrufe anpassen. NICHT notwendig fuer den Fix, aber sauberer.
  - [x] 1.3 KEIN anderer Test-Code muss geaendert werden — `mockFetchOk(false)` (Zeile 272) erzeugt korrekt `{ status: "revoked" }`, was weiterhin `valid === false` ergibt.

- [x] Task 2: Verifizieren, dass der Netzwerkfehler-Test weiterhin funktioniert (AC: #1)
  - [x] 2.1 `mockFetchNetworkError()` (Zeile 48-50) ist NICHT betroffen — `fetch` wirft `TypeError("fetch failed")`, das geht in den `catch`-Block von `validateRemote()`, dann in `validateFromCache()`. Kein Format-Mismatch.
  - [x] 2.2 Trotzdem manuell verifizieren: `npm test -- --reporter=verbose src/cli/license-commands.test.ts`

- [x] Task 3: Build & Validierung (AC: #1, #2)
  - [x] 3.1 `npm run build` erfolgreich
  - [x] 3.2 `npm test` — alle 1123 Tests gruen (1 bisher fehlender Test jetzt repariert)
  - [x] 3.3 Speziell `npm test -- src/cli/license-commands.test.ts` einzeln ausfuehren und alle Tests gruen

## Dev Notes

### Architektur-Kontext

Die Architektur definiert NFR9 (Zuverlaessigkeit):
> "24/24 Tests" — die Test-Suite muss als zuverlaessiges Quality-Gate funktionieren.
[Source: _bmad-output/planning-artifacts/architecture.md#NFRs]

Story 9.8 hat die License-Validierung auf Polar.sh umgestellt:
> `LicenseValidator.validateRemote()` prueft `body.status === "granted"` statt `body.valid === true`
[Source: src/license/license-validator.ts#validateRemote(), Zeile 117-118]

### Vorhandene Infrastruktur

**LicenseValidator (Story 9.8 — Polar.sh-Migration):**
- `PolarValidationResponse` Interface (license-validator.ts:20-23): `{ status: string; expires_at?: string | null; [key: string]: unknown }`
- `validateRemote()` (license-validator.ts:101-142): Sendet POST an Polar Endpoint, prueft `body.status === "granted"`
- Cache-Format (license-validator.ts:123-128): `{ key, valid: boolean, lastCheck, features: [] }`

**License-Commands CLI (license-commands.ts:107-141):**
- `licenseActivate(key)`: Erstellt `LicenseValidator` mit CLI-Key, ruft `validate()`, prueft `isPro()`
- Bei `isPro() === false`: Unterscheidet Server-Antwort (Cache mit `valid: false`) von Netzwerkfehler (kein Cache-Update)
- `readCacheDirectly()` (license-commands.ts:180-192): Liest Cache-Datei direkt fuer die Unterscheidung

**Test-Setup (license-commands.test.ts:1-50):**
- `mockCacheDir`: Temp-Verzeichnis pro Test, via `vi.mock` an `loadLicenseConfig` uebergeben
- `mockFetchOk(valid, features)`: Stubbt globales `fetch` — HIER ist der Bug (altes Format)
- `mockFetchNetworkError()`: Stubbt `fetch` als `TypeError("fetch failed")` — korrekt, nicht betroffen

**Korrekte Referenz-Implementation (license-validator.test.ts:25-33):**
- `mockFetchOk(valid)`: Liefert `{ status: valid ? "granted" : "revoked" }` — korrekt, funktioniert

### Kritische Design-Entscheidungen

1. **NUR den Mock fixen, NICHT den Produktionscode:** Der `LicenseValidator` funktioniert korrekt mit Polar.sh. Der Bug ist ausschliesslich im Test-Mock, der nach Story 9.8 nicht aktualisiert wurde.

2. **Gleiches Mock-Format wie license-validator.test.ts:** Beide Test-Dateien sollen das gleiche Response-Format nutzen (`{ status: "granted" | "revoked" }`). Konsistenz verhindert zukuenftige Verwirrung.

3. **Features-Parameter optional beibehalten oder entfernen:** Der `features`-Parameter in `mockFetchOk` hat keinen Effekt mehr (Polar-Response hat kein `features`-Feld, der Validator liest es nicht). Kann entfernt werden fuer Sauberkeit, oder als unused-Parameter `_features` markiert werden.

### Abgrenzung

- **NUR `src/cli/license-commands.test.ts` wird modifiziert** — `mockFetchOk` Funktion
- **KEIN Produktionscode wird geaendert** — `license-commands.ts`, `license-validator.ts` bleiben
- **KEINE anderen Test-Dateien werden geaendert** — `license-validator.test.ts` ist bereits korrekt
- **KEINE neuen Abhaengigkeiten** — rein interner Mock-Fix
- **KEIN neues Feature** — Bug-Fix einer veralteten Test-Konfiguration

### Testing-Patterns

- Bestehende Tests in `src/cli/license-commands.test.ts` — Co-located mit der CLI-Implementierung
- Mock-Pattern: `vi.stubGlobal("fetch", vi.fn().mockResolvedValue(...))` — globaler Fetch-Stub
- `vi.mock("../license/license-validator.js", ...)` — Module-Mock fuer `loadLicenseConfig`
- Alle 1123 Tests muessen nach dem Fix gruen sein (aktuell: 1122 passed, 1 failed)

### Vorherige Story-Learnings (aus Story 9.8 + 9.9)

- Story 9.8 hat `LicenseValidator` auf Polar.sh Endpoint umgestellt (`body.status === "granted"`)
- Die `license-validator.test.ts` Mocks wurden korrekt angepasst (Zeile 26-32)
- Die `license-commands.test.ts` Mocks wurden NICHT angepasst — das ist dieser Bug
- Story 9.9 (Pro-Feature-Gates) hat 7 neue Tests in `registry.test.ts` hinzugefuegt — alle gruen, nicht betroffen

### Git Intelligence

Letzte relevante Commits:
- `e666903` feat(story-9.9): Pro feature gates for switch_tab, virtual_desk, human touch
- `c1f4a0b` feat(story-9.8): direct Polar.sh license validation — no custom server needed

Story 9.8 (Commit `c1f4a0b`) ist der ausloesende Commit — hat `validateRemote()` auf Polar-Format umgestellt, aber den CLI-Test-Mock vergessen.

### Project Structure Notes

- Modifiziert: `src/cli/license-commands.test.ts` (mockFetchOk Format-Fix)
- NICHT modifiziert: `src/cli/license-commands.ts` (Produktionscode korrekt)
- NICHT modifiziert: `src/license/license-validator.ts` (Polar-Validierung korrekt)
- NICHT modifiziert: `src/license/license-validator.test.ts` (Mocks bereits korrekt)

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 10.1] — Acceptance Criteria, Technical Notes
- [Source: _bmad-output/planning-artifacts/architecture.md#NFRs] — NFR9 Zuverlaessigkeit
- [Source: src/license/license-validator.ts#Zeile 20-23] — PolarValidationResponse Interface
- [Source: src/license/license-validator.ts#Zeile 117-118] — `body.status === "granted"` Pruefung
- [Source: src/cli/license-commands.test.ts#Zeile 38-46] — Fehlerhafter mockFetchOk (altes Format)
- [Source: src/license/license-validator.test.ts#Zeile 25-33] — Korrekter mockFetchOk (Referenz)
- [Source: src/cli/license-commands.ts#Zeile 107-141] — licenseActivate() Produktionscode

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
