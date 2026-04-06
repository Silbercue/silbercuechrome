---
title: 'Ambient Page Context — LLM sieht die Seite von Anfang an'
type: 'feature'
created: '2026-04-06'
status: 'done'
baseline_commit: 'b47e953'
context:
  - 'docs/deferred-work.md # BUG-013'
  - 'src/registry.ts # wrap() — zentraler Response-Wrapper'
  - 'src/cache/a11y-tree.ts # Precomputed A11y Tree Cache'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Das LLM ist zwischen Tool-Calls blind. Es muss explizit `read_page` aufrufen um zu sehen was auf der Seite ist — wie ein Mensch der nach jedem Mausklick die Augen schliesst. Das fuehrt zu:
- Stale-Ref-Fehler (BUG-013): Seite aendert sich, LLM klickt auf nicht-existierenden Ref
- Unnoetige Roundtrips: Jede Aktion braucht vorher `read_page` (2 Calls statt 1)
- Fehlentscheidungen: LLM kann User-Angaben nicht gegen Realitaet abgleichen

**Approach:** Jede Tool-Response enthaelt automatisch einen kompakten Snapshot der interaktiven Elemente auf der aktiven Seite — aber NUR wenn sich der Seiteninhalt seit der letzten Response geaendert hat. Der Precomputed A11y Tree Cache (DomWatcher + Story 7.4) liefert die Daten kostenlos bei Cache-Hit. Das LLM hat dadurch von der ersten Interaktion an ein "Auge" auf die Seite.

## Boundaries & Constraints

**Always:**
- Ambient Context NUR anhaengen wenn sich der Cache seit der letzten Response geaendert hat
- Filter: `interactive` (kompakt, ~200-400 Tokens fuer normale Seiten)
- Cache-Hit = 0 CDP-Calls (Precomputed Tree nutzen)
- Injection in `wrap()` in registry.ts — gilt fuer ALLE Tools zentral
- Auch `executeTool()` (run_plan-Pfad) muss Ambient Context bekommen

**Ask First:**
- Token-Budget fuer Ambient Context (default 2000? konfigurierbar?)

**Never:**
- Nicht bei `read_page` oder `dom_snapshot` anhaengen (die SIND der Page Context)
- Nicht bei `screenshot` anhaengen (visueller Kontext, nicht textueller)
- Nicht wenn Session disconnected ist
- Kein extra CDP-Call wenn der Cache leer ist — dann halt kein Context

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Erste Aktion (navigate) | Cache leer → navigate baut Cache | Response + voller Page Context | N/A |
| Folge-Click ohne DOM-Change | Cache unveraendert | Response OHNE Page Context (0 Extra-Tokens) | N/A |
| Click mit DOM-Mutation | DomWatcher invalidiert Cache → Refresh | Response + frischer Page Context | N/A |
| Tab-Wechsel | Neuer Tab, anderer Cache | Response + Page Context des neuen Tabs | Cache-Miss → kein Context |
| read_page Call | Tool IST Page Context | Response normal, KEIN doppelter Context | N/A |
| Disconnected | Kein CDP verfuegbar | Response normal, kein Context | Silent skip |

</frozen-after-approval>

## Code Map

- `src/registry.ts` -- wrap() und executeTool(): Ambient Context Injection
- `src/cache/a11y-tree.ts` -- Neues getCompactSnapshot() + Cache-Version-Counter

## Tasks & Acceptance

**Execution:**
- [x] `src/cache/a11y-tree.ts` -- Cache-Version-Counter (_cacheVersion: number) der bei jedem refreshPrecomputed() und reset() inkrementiert. Neue Methode getCompactSnapshot() die den gecachten interactive-Tree als kompakten String liefert (Cache-Hit = 0 CDP-Calls) -- Cache-Infrastruktur
- [x] `src/registry.ts` -- In wrap() und executeTool(): Nach Tool-Ausfuehrung pruefen ob _cacheVersion > _lastSentVersion. Wenn ja: getCompactSnapshot() aufrufen, als Text-Block an content anhaengen, _lastSentVersion updaten. Skip fuer read_page, dom_snapshot, screenshot -- Zentrale Injection
- [x] Tests -- 7 Unit-Tests fuer cacheVersion (3) und getCompactSnapshot (4) in a11y-tree.test.ts -- Verifikation

**Acceptance Criteria:**
- Given ein navigate-Call, when die Seite geladen hat, then enthaelt die Response einen "Page Context" Block mit interaktiven Elementen und Refs
- Given zwei click-Calls ohne DOM-Mutation, then enthaelt nur der erste (wenn sich seit letztem Mal was geaendert hat) den Page Context, der zweite nicht
- Given ein click der eine DOM-Mutation ausloest, then enthaelt die Response den aktualisierten Page Context
- Given ein read_page-Call, then wird KEIN zusaetzlicher Page Context angehaengt

## Verification

**Commands:**
- `npm test` -- expected: Alle Tests gruen (bestehende + neue)
- `npm run build` -- expected: Keine Compile-Fehler
