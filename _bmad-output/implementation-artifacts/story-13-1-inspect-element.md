---
title: 'inspect_element Tool — CSS-Debugging in einem Call'
type: 'feature'
created: '2026-04-07'
status: 'ready-for-dev'
epic: 'Epic 13: Visual Developer Intelligence'
context:
  - '_bmad-output/planning-artifacts/epics.md # Story 13.1 ab Zeile 2370'
  - 'src/tools/element-utils.ts # resolveElement Pattern (ref + CSS)'
  - 'src/tools/dom-snapshot.ts # CDP DOMSnapshot als Referenz'
  - 'src/registry.ts # Tool-Registrierung Pattern'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** CSS-Debugging erfordert heute 4+ evaluate-Aufrufe mit handgeschriebenem JS (getComputedStyle, getBoundingClientRect, Parent-Chain, document.styleSheets). In einer realen Session brauchte der Agent 45 Minuten fuer einen flex-direction-Konflikt zwischen zwei CSS-Dateien. inspect_element haette das in 30 Sekunden geloest.

**Approach:** Neues MCP-Tool `inspect_element` das CDP `CSS.getMatchedStylesForNode` und `CSS.getComputedStyleForNode` nutzt um computed styles, CSS-Regeln mit Source-Dateien, geerbte Styles und Element-Geometrie in einem Aufruf zurueckzugeben.

## Boundaries & Constraints

**Always:**
- Ref und CSS-Selektor Support (konsistent mit click, type, observe)
- Kompakte Ausgabe — Token-Budget beachten, keine redundanten Daten
- Layout-relevante Properties als Default (display, flex*, grid*, position, text-align, overflow, width, height, margin, padding)
- Source-Datei + Zeilennummer fuer jede CSS-Regel wenn verfuegbar

**Ask First:**
- Welche Properties im Default-Set? (Layout vs. alles)
- include_children default true oder false?
- Max Tiefe fuer inherited styles?

**Never:**
- Nicht alle 300+ computed properties dumpen — nur layout-relevante oder gefilterte
- Keine stylesheetId-Leaks an den User (intern fuer Source-Resolution nutzen)

## I/O & Edge-Case Matrix

| Scenario | Input | Expected Output | Error Handling |
|----------|-------|-----------------|----------------|
| CSS-Selektor | `selector: ".cell"` | computedStyles, matchingRules, element, children | Element not found Error |
| Ref | `ref: "e42"` | Identisch wie CSS | Ref not found Error |
| Styles-Filter | `styles: ["display", "flex*"]` | Nur gefilterte Properties | Leeres Array wenn kein Match |
| Inline Styles | Element mit style="" | Inline-Regeln in matchingRules (origin: inline) | N/A |
| Shadow DOM | Element in Shadow Root | Funktioniert via OOPIF/resolveElement | N/A |
| Kein Stylesheet | Seite ohne CSS-Dateien | Nur computedStyles + UA defaults | Leere matchingRules |

</frozen-after-approval>

## Code Map

- `src/tools/inspect-element.ts` — Schema, Handler, CSS-Domain Logik
- `src/tools/inspect-element.test.ts` — Unit Tests
- `src/tools/index.ts` — Export hinzufuegen
- `src/registry.ts` — Tool registrieren + _handlers Map
- `src/registry.test.ts` — Tool-Count erhoehen

## Tasks & Acceptance

**Vorbereitung:**
- [ ] Context7: CDP CSS-Domain Doku abrufen (CSS.getMatchedStylesForNode, CSS.getComputedStyleForNode, CSS.enable)
- [ ] Bestehende Tools als Pattern-Referenz lesen (observe.ts fuer Schema+Handler, element-utils.ts fuer resolveElement)

**Execution:**
- [ ] `src/tools/inspect-element.ts` — Schema: selector/ref, styles (optional Filter), include_children (default true), include_rules (default true)
- [ ] `src/tools/inspect-element.ts` — Handler: CSS.enable, resolveElement, CSS.getComputedStyleForNode, CSS.getMatchedStylesForNode, Source-Resolution
- [ ] `src/tools/inspect-element.ts` — Kompakte Ausgabe-Formatierung (nicht raw CDP-Response, sondern LLM-freundlich)
- [ ] `src/tools/inspect-element.test.ts` — Unit Tests (Schema, Handler mit Mock CDP)
- [ ] `src/tools/index.ts` + `src/registry.ts` — Registrierung
- [ ] Live-Test gegen echte Webseite

**Acceptance Criteria:**
- Given ein Element mit CSS-Konflikten, when inspect_element aufgerufen wird, then zeigt die Response computed styles + alle matchenden CSS-Regeln mit Source-Datei
- Given ref "e42", when inspect_element aufgerufen wird, then funktioniert es identisch wie mit CSS-Selektor
- Given styles-Filter ["display", "flex*"], then werden nur passende Properties zurueckgegeben
- Given die Response, then bleibt sie unter ~2000 Tokens fuer ein typisches Element

## Technical Notes

- `CSS.enable` muss vor CSS-Queries aufgerufen werden (idempotent, wie DOM.enable)
- `CSS.getMatchedStylesForNode` liefert matchedCSSRules[].rule mit origin, selectorList, style.cssProperties[], rule.styleSheetId
- Source-Datei ueber styleSheetId → CSS.getStyleSheetText oder sourceURL im StyleSheet-Header
- Bei Webpack/Vite Bundles: href enthaelt oft den Source-Dateinamen
- Wildcard-Expansion fuer styles-Filter: "flex*" → flex-direction, flex-wrap, flex-grow, etc.
- Token-Budget: Kompakte Key-Value-Paare, keine verschachtelte JSON-Struktur in der Text-Response
