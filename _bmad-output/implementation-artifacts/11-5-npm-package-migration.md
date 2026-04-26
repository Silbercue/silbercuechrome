# Story 11.5: npm-Package-Migration

Status: done

## Story

As a Developer,
I want das npm-Package von @silbercue/chrome auf public-browser migriert,
So that Nutzer ueber npx public-browser@latest installieren koennen.

## Acceptance Criteria

1. **Given** das Package public-browser existiert nicht auf npm **When** npm publish ausgefuehrt wird **Then** public-browser@2.0.0 ist auf npm verfuegbar

2. **Given** das alte Package @silbercue/chrome existiert auf npm **When** eine Deprecation Notice gesetzt wird **Then** npm install @silbercue/chrome zeigt Deprecation-Warnung mit Verweis auf public-browser

3. **Given** npx public-browser@latest wird ausgefuehrt **Then** Chrome startet und MCP-Server verbindet

## Tasks / Subtasks

- [ ] Task 1: Publish-Pipeline fuer neuen Package-Namen vorbereiten (AC: #1)
  - [ ] 1.1 `scripts/publish.ts`: Pruefen dass NPM_PACKAGE auf `"public-browser"` steht (bereits in 11.4 geaendert — verifizieren)
  - [ ] 1.2 `scripts/publish.ts`: Deprecation-Step hinzufuegen — nach erfolgreichem Publish von public-browser soll `npm deprecate @silbercue/chrome "This package has been renamed to public-browser. Install: npx public-browser@latest"` ausgefuehrt werden
  - [ ] 1.3 `scripts/publish.test.ts`: Test fuer den Deprecation-Step hinzufuegen

- [ ] Task 2: package.json fuer npm publish verifizieren (AC: #1)
  - [ ] 2.1 Pruefen: `"name": "public-browser"`, `"bin": { "public-browser": ... }`, `"files"` Array, `"repository"` URL
  - [ ] 2.2 `npm pack --dry-run` ausfuehren — verifizieren dass public-browser-*.tgz korrekt erzeugt wird

- [ ] Task 3: Build + Test verifizieren (AC: #1)
  - [ ] 3.1 `npm run build` — fehlerfrei
  - [ ] 3.2 `npm test` — alle Tests bestehen

- [ ] Task 4: npm publish + Deprecation (AC: #1, #2) — OPERATIV, WIRD IN 11.7 AUSGEFUEHRT
  - [ ] 4.1 `npm publish` unter neuem Namen — wird zusammen mit v2.0.0 in Story 11.7 ausgefuehrt
  - [ ] 4.2 `npm deprecate "@silbercue/chrome" "..."` — wird nach erfolgreichem Publish ausgefuehrt

## Dev Notes

### Abgrenzung zu Story 11.7

Der tatsaechliche `npm publish` passiert in Story 11.7 (v2.0.0 Release) zusammen mit dem Version-Bump. Story 11.5 bereitet die Pipeline vor und stellt sicher dass alles korrekt konfiguriert ist.

### Betroffene Dateien

| Datei | Aenderungstyp |
|-------|---------------|
| `scripts/publish.ts` | Edit (Deprecation-Step) |
| `scripts/publish.test.ts` | Edit (Deprecation-Test) |

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 11.5] — ACs und User Story
- [Source: scripts/publish.ts] — Publish-Pipeline
- [Source: package.json] — Package-Konfiguration (bereits auf public-browser in 11.4)

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
