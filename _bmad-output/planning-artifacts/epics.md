---
stepsCompleted: ["step-01-validate-prerequisites", "step-02-design-epics", "step-03-create-stories", "step-04-final-validation"]
status: 'complete'
completedAt: '2026-04-04'
lastUpdated: '2026-04-06'
inputDocuments:
  - "prd.md"
  - "architecture.md"
  - "sprint-change-proposal-2026-04-05-phase2.md"
changelog:
  - date: '2026-04-05'
    change: "Phase 2 Epics: Epic 10 (Pre-Launch Stabilisierung, 5 Stories), Epic 11 (Benchmark-Suite v2 Community Pain Points, 8 Stories), Epic 12 (Token-Transparenz & Metriken, 4 Stories). FR71-FR80 und NFR29 (=PRD-NFR25) in Requirements-Inventar und Coverage Map eingefuegt. Basiert auf Sprint Change Proposal Phase 2 (Community-Recherche + Benchmark-Luecken-Analyse)."
  - date: '2026-04-03'
    change: "Epic 5b (Visual Intelligence) hinzugefuegt — 3 Stories, 6 neue FRs (FR52-FR57), 2 neue NFRs (NFR25-NFR26). Basiert auf Deep Research zu ungenutzten CDP Visual APIs."
  - date: '2026-04-03'
    change: "Epic 5b erweitert mit Forschungserkenntnissen aus browser-use, D2Snap, Stagehand, Set-of-Mark. Neue FRs FR58-FR62, NFR27-NFR28. Story 5b.1 teilweise implementiert (perf commit e4d8805). 2 neue Stories (5b.4 SoM, 5b.5 Parallel CDP). FR15 aktualisiert (click settle entfernt). Selector-Caching als FR62 in Epic 7."
  - date: '2026-04-04'
    change: "Epic 6 (Extended Workflows) mit 5 Stories (6.1-6.5) detailliert. Epic 7 (Observability) mit 6 Stories (7.1-7.6) detailliert, Story 7.x renummeriert zu 7.5. Epic 8 als DONE markiert. Neues Epic 9 (Monetarisierung & Publish-Pipeline) mit 7 Stories (9.1-9.7) erstellt. FR63-FR69 in FR-Liste und Coverage Map eingefuegt."
  - date: '2026-04-05'
    change: "Correct Course: Story 9.8 (License Validation) hinzugefuegt. FR70 fuer direkte Polar.sh API-Integration (kein eigener Server). Architektonische Luecke geschlossen — Client-Code (9.2) validiert jetzt direkt gegen Polar.sh Public API."
  - date: '2026-04-06'
    change: "Doku-Alignment: FR70, Architecture, Story 9.8 von 'Cloudflare Worker / license.silbercuechrome.dev' auf 'Direkte Polar.sh API-Integration' korrigiert. Implementierung war bereits korrekt (Commit c1f4a0b), nur Artefakte waren veraltet."
  - date: '2026-04-06'
    change: "Epic 13a (LLM Awareness) gestartet. Story 13a.1 Ambient Page Context: Jede Tool-Response enthaelt automatisch einen kompakten Snapshot der interaktiven Elemente wenn sich die Seite geaendert hat. Cache-Version-Counter in A11yTreeProcessor, getCompactSnapshot() Methode, zentrale Injection in registry.ts wrap() und executeTool(). 7 neue Tests."
  - date: '2026-04-05'
    change: "Story 9.9 (Pro-Feature-Gates fuer switch_tab, virtual_desk, Human Touch) hinzugefuegt. Benchmark-Analyse zeigte: Free/Pro funktional identisch (20s vs 21s, 24/24). PRD-Luecke — switch_tab und virtual_desk sollten laut PRD Pro-only sein (Zeile 351-352) aber wurden nie gegated. BUG-006 (type/focus Shadow-DOM) und BUG-010 (Stale Cache) gefixt."
---

# SilbercueChrome - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for SilbercueChrome, decomposing the requirements from the PRD and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

**Browser-Verbindung & Lifecycle (MVP)**
- FR1: Der Server kann sich per CDP-Pipe (Auto-Launch) oder CDP-WebSocket (laufendes Chrome) verbinden
- FR2: Der Server kann Chrome automatisch starten mit korrekten Flags wenn keine Instanz gefunden wird
- FR3: Der Server kann bei CDP-Verbindungsverlust automatisch reconnecten ohne Session-Verlust
- FR4: Der Server kann den Verbindungsstatus an den Agent kommunizieren (verbunden, reconnecting, getrennt)
- FR5: Der Server kann Cross-Origin iFrames (OOPIF) transparent erkennen und dem Agent zugaenglich machen

**Seitennavigation & Warten (MVP)**
- FR6: Der Agent kann zu einer URL navigieren und automatisch auf Seitenstabilitaet warten (Settle)
- FR7: Der Agent kann im Browser zurueck navigieren
- FR8: Der Agent kann auf eine spezifische Bedingung warten (Element sichtbar, Network Idle, JS-Expression)
- FR9: Der Server kann clientseitige Navigation (pushState/replaceState, hashchange) erkennen und auf abgeschlossene Hydration warten bevor er Bereitschaft meldet
- FR10: Der Agent kann die Settle-Dauer pro Navigation konfigurieren

**Element-Interaktion (MVP)**
- FR11: Der Agent kann Elemente ueber stabile Accessibility-Tree-Referenzen identifizieren
- FR12: Der Agent kann Elemente ueber CSS-Selektoren identifizieren (Fallback)
- FR13: Der Agent kann auf ein identifiziertes Element klicken
- FR14: Der Agent kann Text in ein Eingabefeld tippen
- FR15: ~~Der Server kann nach Klick-Aktionen automatisch auf Seitenstabilitaet warten~~ GEAENDERT: Click returned sofort, Agent nutzt wait_for fuer Navigation (commit e4d8805)

**Seiteninhalte lesen & inspizieren (MVP)**
- FR16: Der Agent kann den Accessibility Tree in progressiver Tiefe abfragen
- FR17: Der Agent kann den A11y-Tree nach interaktiven Elementen filtern
- FR18: Der Agent kann gezielt einen Teilbaum per Element-Ref abfragen
- FR19: Der Agent kann einen komprimierten Screenshot aufnehmen (WebP, max 800px)

**JavaScript-Ausfuehrung (MVP)**
- FR20: Der Agent kann beliebiges mehrzeiliges JavaScript im Seitenkontext ausfuehren
- FR21: Der Agent kann Ergebnisse als JSON-serialisierbare Werte zurueckerhalten (Strings, Numbers, Arrays, Objects)

**State-Management & Caching (MVP)**
- FR22: Der Server kann Tab-State (URL, Title, DOM-Ready, Console-Errors) mit konfigurierbarer Ablaufzeit cachen
- FR23: Der Server kann gecachten State sofort zurueckgeben ohne erneute CDP-Abfrage
- FR24: Der Server kann den Cache bei Seitenwechsel oder Seitenveraenderungen automatisch invalidieren

**VirtualDesk (MVP)**
- FR25: Der Agent kann eine kompakte Uebersicht aller Chrome-Instanzen und Tabs abfragen
- FR26: VirtualDesk zeigt pro Tab den aktuellen State (URL, Title, Lade-Status, aktiv/inaktiv)
- FR27: VirtualDesk liefert unter 500 Tokens fuer bis zu 10 offene Tabs — kompakte Darstellung, kein Full-Tree pro Tab

**Batch-Execution (MVP)**
- FR28: Der Agent kann ein serielles Array von Operationen als run_plan an den Server senden
- FR29: Der Server fuehrt alle Steps server-seitig aus — 1 LLM-Roundtrip statt N
- FR30: Der Server bricht bei Fehler ab und gibt Teilergebnisse zurueck

**Tab-Management (MVP)**
- FR31: Der Agent kann Tabs oeffnen, schliessen und wechseln via switch_tab

**Token-Optimierung & DX (MVP)**
- FR32: Tool-Definitionen unter 5.000 Tokens
- FR33: Timing-Metadata (elapsedMs, method) in jeder Response
- FR34: Fehlermeldungen mit Kontext (betroffene Ref-ID, naechstgelegene Alternative mit Name/Typ, aktueller Element-State)

**Erweitertes run_plan (Phase 2)**
- FR35: run_plan mit Conditionals, Variables, Error-Strategien (abort/continue/screenshot)
- FR36: Suspend/Resume: Plan pausieren, Entscheidungsfrage an Agent, Plan fortsetzen

**Observability (Phase 2)**
- FR37: Console-Logs mit Topic-Filtering abfragen
- FR38: Network-Requests inspizieren
- FR39: Logs nach Kategorien filtern (errors, warnings, network, app)

**Session-Management (Phase 2)**
- FR40: Default-Werte setzen (Default-Tab, Default-Timeout)
- FR41: Auto-Promote: Nach 3+ aufeinanderfolgenden Aufrufen mit identischem Parameter diesen automatisch als Default vorschlagen

**Erweiterte Interaktion (Phase 2)**
- FR42: Browser-Dialoge automatisch behandeln (Alerts, Confirms, Cookie-Banner)
- FR43: Dateien in File-Upload-Felder hochladen
- FR44: Komplexe Formulare befuellen

**Multi-Tab (Phase 2/3)**
- FR45: Mehrere Tabs parallel steuern (Phase 3 — Pro)

**Precomputed A11y (Phase 2/3)**
- FR46: A11y-Tree im Hintergrund bei DOM-Aenderungen aktualisiert halten und bei Abfrage sofort liefern

**Operator-Architektur (Phase 3)**
- FR47: Browser-Aktionen ueber lokale Rule-Engine ausfuehren ohne Round-Trip zum Haupt-LLM
- FR48: Kleines LLM fuer adaptive Mikro-Entscheidungen (Scrollen, Warten, Dialog-Handling)
- FR49: Operator eskaliert bei Unsicherheit an den Captain

**Visual Intelligence (Post-MVP, vor Phase 2)**
- FR52: DONE — Der Server setzt `Emulation.setDeviceMetricsOverride({ deviceScaleFactor: 1 })` beim Start (commit e4d8805)
- FR53: DONE — Screenshot vereinfacht: clip+scale statt Viewport-Query, Quality-Fallback-Loop (commit e4d8805)
- FR54: DONE — Emulation-Override wird nach Tab-Wechsel und Reconnect automatisch neu gesetzt (commit e4d8805)
- FR55: Der Agent kann einen DOMSnapshot abrufen (`DOMSnapshot.captureSnapshot`) mit Positionen, Farben, Sichtbarkeit, Klickbarkeit und Z-Order — ein strukturiertes "drittes Auge" zwischen read_page (Text/Struktur) und screenshot (Pixel)
- FR56: DOMSnapshot filtert auf interaktive/sichtbare Elemente mit 6-stufiger Pipeline (Quelle: browser-use DOMTreeSerializer): Simplification → Paint Order Filtering → BBox Filtering → Index Assignment → New Element Marking → Shadow DOM Handling
- FR57: read_page kann optional um visuelle Infos angereichert werden: Bounding-Boxes, isClickable, Position — ueber `filter: "visual"`
- FR58: Parallele CDP-Requests: DOM + A11y + DOMSnapshot + LayoutMetrics gleichzeitig feuern (Quelle: browser-use fusioniert 5 CDP-Calls parallel)
- FR59: DOM Downsampling mit Token-Budget-Steuerung: Container-Elemente mergen, Content zu Markdown, Interactive immer voll erhalten. AdaptiveD2Snap-inspiriert (Quelle: arXiv 2508.04412)
- FR60: Set-of-Mark (SoM): Nummerierte Labels auf Screenshots zeichnen, damit das LLM visuell referenzieren kann ("klicke Element 7"). Verdoppelt die Erfolgsrate (Quelle: WebVoyager 59.1% vs 30.8% ohne SoM)
- FR61: isClickable-Heuristik: Native Tags + ARIA-Rollen + CSS cursor:pointer + JS-Event-Listeners via Runtime.getEventListeners() (Quelle: browser-use Element Detection)

**Selector-Caching (Phase 2)**
- FR62: Selector-Caching mit DOM-Fingerprinting: SHA256(method + normalized_url + dom_fingerprint) → Selector wiederverwenden ohne LLM-Call. Self-Healing bei DOM-Aenderung (Quelle: Stagehand, 80% Speedup bei repetitiven Workflows)

**Chrome-Profil & Human Touch (Phase 3)**
- FR50: Optional echtes Chrome-Profil nutzen (Opt-in) fuer Passwoerter, Sessions, Cookies
- FR51: Menschliche Interaktionsmuster simulieren (natuerliche Mausbewegungen, variable Tippgeschwindigkeit)

**Monetarisierung & Distribution (MVP-Infrastruktur)**
- FR63: run_plan im Free-Tier hat ein konfigurierbares Step-Limit (default 5). Ueberzaehlige Steps werden nicht ausgefuehrt, der Plan liefert das Teilergebnis zurueck ohne Fehlermeldung
- FR64: Der Server validiert beim Start den License-Key und aktiviert Pro-Features bei gueltigem Key. Fallback auf lokal gecachte Validierung bei fehlender Netzwerkverbindung
- FR65: Offline-Robustheit: 7-Tage-Grace-Period — Pro-Features bleiben aktiv wenn der letzte erfolgreiche Lizenz-Check weniger als 7 Tage zurueckliegt
- FR66: CLI-Kommandos fuer Lizenzverwaltung: `silbercuechrome license status|activate|deactivate`
- FR67: Das oeffentliche Repository enthaelt ausschliesslich Free-Tier-Quellcode. Pro-Features sind nicht im Quellcode einsehbar
- FR68: `dom_snapshot` liefert visuelles Element-Layout mit Positionen (x, y, width, height), Farben, und Z-Order fuer sichtbare Elemente (Pro-Feature)
- FR69: Der Publish-Workflow erstellt reproduzierbar aus beiden Repos ein veroeffentlichungsfaehiges Release mit Versions-Tag

**License Validation (MVP-Infrastruktur)**
- FR70: License-Keys werden direkt gegen die Polar.sh Public API validiert (kein eigener Server)

**Benchmark & Verifikation (Phase 2 — Community-Validation)**
- FR71: Die Benchmark-Suite testet Session Persistence — Cookie/localStorage-Werte ueberleben Server-Neustart wenn Chrome weiterlaueft
- FR72: Die Benchmark-Suite testet CDP-Fingerprint-Sichtbarkeit — navigator.webdriver, window.chrome.cdc und andere CDP-Detection-Flags
- FR73: Die Benchmark-Suite testet Extension-Verfuegbarkeit — Test-Extension im laufenden Chrome, Agent interagiert damit
- FR74: Die Benchmark-Suite testet Reconnect-Recovery — CDP-Verbindung unterbrochen, Auto-Reconnect, naechster Tool-Call funktioniert
- FR75: Die Benchmark-Suite testet Console-Log-Capture — console.log() im Browser wird ueber console_logs Tool zurueckgeliefert
- FR76: Die Benchmark-Suite testet File-Upload — Datei wird ueber file_upload in input[type=file] hochgeladen
- FR77: Die Benchmark-Suite testet SPA-Navigation — History-API-basierte Navigation (pushState) erkannt, wait_for wartet auf Content-Update
- FR78: Jede Tool-Response enthaelt _meta.response_bytes — Response-Groesse in Bytes fuer Token-Kosten-Transparenz
- FR79: read_page und dom_snapshot enthalten _meta.estimated_tokens — geschaetzte Token-Anzahl basierend auf Response-Laenge / 4
- FR80: Der Benchmark-Runner (npm run benchmark) fuehrt alle Tests automatisiert aus und exportiert Ergebnisse als JSON

### NonFunctional Requirements

**Performance**
- NFR1: 24-Test-Benchmark-Suite unter 5 Minuten (mit run_plan) — doppelt so schnell wie Playwright MCP (~9.5 min)
- NFR2: Ohne run_plan: unter 8 Minuten — mindestens gleichwertig mit Playwright MCP
- NFR3: CDP-Call-Latenz unter 5ms Round-Trip (unter 1ms bei CDP-Pipe)
- NFR4: Tool-Definitionen-Payload unter 5.000 Tokens (vs. 13.700 bei Playwright MCP)
- NFR5: Komprimierte Screenshots unter 100KB (WebP, max 800px)
- NFR6: evaluate-Ausfuehrung unter 50ms fuer Scripts bis 100 Zeilen (exklusive Script-Laufzeit) — Performance-kritischstes Tool
- NFR7: Cold-Start unter 3 Sekunden (inklusive Chrome-Auto-Launch)
- NFR8: run_plan mit N Steps = 1 LLM-Roundtrip
- NFR25: Screenshot-Latenz unter 20ms — aktuell ~50ms mit Retina-Fix (commit e4d8805), Playwright MCP schafft 16ms
- NFR26: DOMSnapshot-Response unter 2.000 Tokens fuer typische Webseiten (nur interaktive/sichtbare Elemente)
- NFR27: read_page mit filter: "visual" unter 50ms dank paralleler CDP-Calls
- NFR28: DOM Downsampling: typische Seite unter 8.000 Tokens darstellbar (D2Snap schafft ~1.000 bei aggressiver Filterung)

**Zuverlaessigkeit**
- NFR9: 24/24 Tests bestanden in der Benchmark-Suite
- NFR10: Null Verbindungsabbrueche in 10-Minuten-Sessions
- NFR11: Auto-Reconnect innerhalb von 3 Sekunden
- NFR12: Gecachter Tab-State bleibt bei Reconnect erhalten
- NFR13: Stabile Element-Refs ueber mindestens 5 aufeinanderfolgende Tool-Calls (ohne Seitennavigation)
- NFR14: Bei Chrome-Absturz: Fehlermeldung an Agent innerhalb 3 Sekunden, kein Server-Crash, automatischer Reconnect-Versuch

**Sicherheit**
- NFR15: Keine Default-Extraktion von Cookies/Credentials — explizit via evaluate
- NFR16: Alle Kommunikation lokal (CDP-Pipe/localhost + stdio MCP) — kein externes Relay
- NFR17: Security-Policy in README dokumentiert
- NFR18: License-Key-Validierung (Pro, Phase 3) mit Offline-Unterstuetzung (7-Tage-Grace-Period)

**Integration & Kompatibilitaet**
- NFR19: Kompatibel mit allen MCP-Clients (Claude Code, Cursor, Cline, Windsurf, Claude Desktop)
- NFR20: Chrome 136+ Unterstuetzung
- NFR21: Node.js 18+ LTS
- NFR22: Installation via npx und Verbindung zu Chrome ohne manuelle Konfiguration auf macOS, Linux und Windows

**Qualitaetssicherung**
- NFR23: CI-Pipeline bei jedem Chrome-Update — Breaking Changes erkennen bevor User sie melden
- NFR24: Deterministische Benchmark-Tests (vordefinierte Tool-Sequenzen, keine LLM-Entscheidungen) fuer reproduzierbare Vergleiche

**Benchmark-Abdeckung (Phase 2)**
- NFR29: Die Benchmark-Suite deckt mindestens 80% der Top-10 Community-Pain-Points ab (gemessen an GitHub-Issues der 4 Hauptkonkurrenten). Stand 2026-04-05: 25% (3/12) — Ziel: 83% (10/12). Entspricht PRD-NFR25 — Epics-lokale NFR25-28 (Visual Intelligence) belegen die Nummern bereits

### Additional Requirements

- **Starter Template:** Custom TypeScript Setup (kein fertiges Template) — package.json, tsconfig.json, vitest.config.ts, eslint.config.js, .prettierrc als Projekt-Grundlage. Dies beeinflusst Epic 1 Story 1.
- **Schichten-Architektur:** Transport (Pipe/WebSocket) → CDP-Client → Cache (TabStateCache + A11y-Tree) → Tools → Plan-Executor. Jede Schicht unabhaengig testbar.
- **Eigener CDP-Client:** Komplett selber gebaut — kein ws-Paket, kein chrome-remote-interface. Maximale Kontrolle, keine Dependency.
- **Zwei separate Repos:** `silbercuechrome` (Open Source, MIT) + `silbercuechrome-pro` (privat). Repo-Struktur von Tag 1 darauf ausgelegt.
- **Intelligente Chrome-Launch-Strategie:** Erst verbinden (WebSocket auf 9222), dann Auto-Launch als Child-Prozess (CDP-Pipe). Konfigurierbar via `autoLaunch`.
- **Testing-Strategie:** Unit-Tests pro Schicht (Vitest, co-located) + 24-Test-Benchmark-Suite als End-to-End-Validierung. Kein separater Integration-Layer.
- **Error-Handling:** Laufende Calls sofort failen, Reconnect im Hintergrund (max 3x, 1s Pause), TabStateCache bleibt erhalten. Ehrliche Fehlermeldungen.
- **A11y-Ref-IDs:** Durchnummeriert (`e1`, `e2`, ...) mit Stabilitaetsgarantie. Bestehende Refs bleiben bei DOM-Updates stabil, neue Elemente bekommen neue Nummern. Reset bei Navigation.
- **Tool-Registrierung:** Jedes Tool exportiert Schema + Handler, `server.ts` registriert via ToolRegistry. Kein Auto-Discovery.
- **CDP-Call-Pattern:** Alle CDP-Calls ueber `cdpClient.send()` — nie direkt auf WebSocket/Pipe.
- **Logging:** `console.error()` fuer Fehler (stderr). Kein `console.log()` — stdout gehoert dem MCP-Protokoll. Debug via `DEBUG=silbercuechrome`.
- **MCP Response Format:** Immer `_meta` mit Timing, `isError: true` bei Fehlern, nie Exceptions nach oben durchlassen.
- **Projektstruktur:** `src/transport/`, `src/cdp/`, `src/cache/`, `src/tools/`, `src/plan/`, `src/server.ts`, `src/index.ts`, `src/registry.ts`, `src/types.ts`
- **CI/CD:** GitHub Actions — `ci.yml` (Tests + Lint bei jedem Push), `chrome-update.yml` (automatische Tests bei Chrome-Updates)

### UX Design Requirements

Kein UX-Design-Dokument vorhanden — SilbercueChrome ist ein Backend/Infrastructure-Projekt (MCP-Server) ohne grafische Benutzeroberflaeche.

### FR Coverage Map

| FR | Epic | Beschreibung |
|----|------|-------------|
| FR1 | Epic 1 | CDP-Pipe/WebSocket-Verbindung |
| FR2 | Epic 1 | Chrome Auto-Launch |
| FR3 | Epic 5 | Auto-Reconnect |
| FR4 | Epic 1 | Verbindungsstatus kommunizieren |
| FR5 | Epic 5 | OOPIF-Support |
| FR6 | Epic 2 | URL navigieren + Settle |
| FR7 | Epic 2 | Zurueck navigieren |
| FR8 | Epic 2 | wait_for Bedingungen |
| FR9 | Epic 2 | SPA-Navigation + Hydration |
| FR10 | Epic 2 | Settle-Dauer konfigurieren |
| FR11 | Epic 2 | A11y-Referenzen |
| FR12 | Epic 3 | CSS-Selektor-Fallback |
| FR13 | Epic 3 | Element klicken |
| FR14 | Epic 3 | Text tippen |
| FR15 | Epic 3 | Auto-Settle nach Klick |
| FR16 | Epic 2 | Progressive A11y-Tree |
| FR17 | Epic 2 | Filter interaktive Elemente |
| FR18 | Epic 2 | Teilbaum per Ref |
| FR19 | Epic 2 | Komprimierter Screenshot |
| FR20 | Epic 1 | JavaScript ausfuehren |
| FR21 | Epic 1 | JSON-Ergebnisse |
| FR22 | Epic 4 | Tab-State cachen |
| FR23 | Epic 4 | Gecachten State sofort liefern |
| FR24 | Epic 4 | Cache auto-invalidieren |
| FR25 | Epic 4 | VirtualDesk Uebersicht |
| FR26 | Epic 4 | Per-Tab State anzeigen |
| FR27 | Epic 4 | VirtualDesk <500 Tokens |
| FR28 | Epic 5 | run_plan senden |
| FR29 | Epic 5 | Server-seitige Ausfuehrung |
| FR30 | Epic 5 | Abbruch + Teilergebnisse |
| FR31 | Epic 4 | Tabs oeffnen/schliessen/wechseln |
| FR32 | Epic 1 | Tool-Definitionen <5k Tokens |
| FR33 | Epic 1 | Timing-Metadata |
| FR34 | Epic 3 | Kontextuelle Fehlermeldungen |
| FR35 | Epic 6 | Erweiterter run_plan |
| FR36 | Epic 6 | Suspend/Resume |
| FR37 | Epic 7 | Console-Logs |
| FR38 | Epic 7 | Network-Monitoring |
| FR39 | Epic 7 | Log-Kategorien |
| FR40 | Epic 7 | Session-Defaults |
| FR41 | Epic 7 | Auto-Promote |
| FR42 | Epic 6 | Dialog-Handling |
| FR43 | Epic 6 | File-Upload |
| FR44 | Epic 6 | Formular-Befuellung |
| FR45 | Epic 7 | Parallel-Tab-Steuerung |
| FR46 | Epic 7 | Precomputed A11y |
| FR47 | Epic 8 | Rule-Engine |
| FR48 | Epic 8 | Kleines LLM Operator |
| FR49 | Epic 8 | Operator-Eskalation |
| FR50 | Epic 8 | Chrome-Profil (Opt-in) |
| FR51 | Epic 8 | Human Touch |
| FR52 | Epic 5b | DONE — Emulation-Override (deviceScaleFactor: 1) |
| FR53 | Epic 5b | DONE — Optimierter Screenshot Single-Call |
| FR54 | Epic 5b | DONE — Emulation-Override nach Tab-Wechsel/Reconnect |
| FR55 | Epic 5b | DOMSnapshot-Tool |
| FR56 | Epic 5b | DOMSnapshot 6-stufige Filterpipeline (browser-use) |
| FR57 | Epic 5b | read_page visueller Filter-Modus |
| FR58 | Epic 5b | Parallele CDP-Requests (5 gleichzeitig) |
| FR59 | Epic 5b | DOM Downsampling mit Token-Budget (D2Snap) |
| FR60 | Epic 5b | Set-of-Mark (SoM) auf Screenshots |
| FR61 | Epic 5b | isClickable-Heuristik (Tags+ARIA+CSS+Events) |
| FR62 | Epic 7 | Selector-Caching mit DOM-Fingerprinting (Stagehand) |
| FR63 | Epic 9 | run_plan Free-Tier Step-Limit |
| FR64 | Epic 9 | License-Key Validierung beim Start |
| FR65 | Epic 9 | 7-Tage Offline Grace-Period |
| FR66 | Epic 9 | CLI-Kommandos Lizenzverwaltung |
| FR67 | Epic 9 | Oeffentliches Repo nur Free-Tier-Code |
| FR68 | Epic 9 | dom_snapshot Pro-Feature |
| FR69 | Epic 9 | Publish-Workflow Dual-Repo-Release |
| FR70 | Epic 9 | License Validation (Direkte Polar.sh API-Integration) |
| FR71 | Epic 11 | Benchmark: Session Persistence Test |
| FR72 | Epic 11 | Benchmark: CDP-Fingerprint-Detection Test |
| FR73 | Epic 11 | Benchmark: Extension-Verfuegbarkeit Test |
| FR74 | Epic 11 | Benchmark: Reconnect-Recovery Test |
| FR75 | Epic 11 | Benchmark: Console-Log-Capture Test |
| FR76 | Epic 11 | Benchmark: File-Upload Test |
| FR77 | Epic 11 | Benchmark: SPA-Navigation Test |
| FR78 | Epic 12 | _meta.response_bytes in Tool-Responses |
| FR79 | Epic 12 | _meta.estimated_tokens in read_page/dom_snapshot |
| FR80 | Epic 11 | Benchmark-Runner (npm run benchmark) |

## Epic List

### Epic 1: Project Foundation & JavaScript Execution
Der Agent kann sich mit Chrome verbinden, beliebiges JavaScript ausfuehren und Ergebnisse zurueckerhalten — die Grundlage fuer alles Weitere.
**FRs:** FR1, FR2, FR4, FR20, FR21, FR32, FR33

### Epic 2: Page Navigation & Content Reading
Der Agent kann Websites navigieren, auf Seitenstabilitaet warten und Seiteninhalte ueber den Accessibility Tree progressiv lesen — die erste vollstaendige Browser-Interaktion.
**FRs:** FR6, FR7, FR8, FR9, FR10, FR11, FR16, FR17, FR18, FR19

### Epic 3: Element Interaction
Der Agent kann mit Seitenelementen interagieren — klicken, tippen, Formulare befuellen — ueber stabile A11y-Referenzen oder CSS-Selektoren mit intelligenten Fehlermeldungen.
**FRs:** FR12, FR13, FR14, FR15, FR34

### Epic 4: Tab Management & VirtualDesk
Der Agent hat eine kompakte Uebersicht aller Tabs, kann zwischen Tabs wechseln und bekommt gecachten State sofort — kein redundantes Abfragen.
**FRs:** FR22, FR23, FR24, FR25, FR26, FR27, FR31

### Epic 5: Batch Execution & Connection Resilience
Der Agent kann Multi-Step-Workflows in einem einzigen Call ausfuehren (run_plan) und die Verbindung ist rock-solid — Auto-Reconnect, OOPIF-Support, kein Session-Verlust.
**FRs:** FR3, FR5, FR28, FR29, FR30

### Epic 5b: Visual Intelligence (Post-MVP)
Der Agent bekommt ein "drittes Auge" — optimierte Screenshots, strukturierte visuelle DOM-Daten per DOMSnapshot mit Filterpipeline, Set-of-Mark auf Screenshots, und Token-Budget-gesteuertes DOM Downsampling. Basiert auf Deep Research zu browser-use (DOMTreeSerializer), D2Snap (arXiv 2508.04412), Stagehand (Selector-Caching), und Set-of-Mark (WebVoyager). Story 5b.1 teilweise implementiert (commit e4d8805).
**FRs:** FR52, FR53, FR54, FR55, FR56, FR57, FR58, FR59, FR60, FR61

### Epic 6: Extended Workflow Capabilities (Phase 2)
Der Agent bewaeltigt komplexere Workflows — erweiterter run_plan mit Conditionals/Variables, Dialog-Handling, File-Upload, Formular-Befuellung.
**FRs:** FR35, FR36, FR42, FR43, FR44

### Epic 7: Observability & Session Intelligence (Phase 2)
Der Agent hat Einblick in Console-Logs und Network-Requests, intelligente Session-Defaults, Multi-Tab-Steuerung, sofortige A11y-Updates, und Selector-Caching mit DOM-Fingerprinting.
**FRs:** FR37, FR38, FR39, FR40, FR41, FR45, FR46, FR62

### Epic 8: Operator Architecture & Human Touch (Phase 3) — DONE
Browser-Aktionen laufen ueber einen lokalen Operator ohne Haupt-LLM-Roundtrips, mit menschlichen Interaktionsmustern und optionalem Chrome-Profil.
**FRs:** FR47, FR48, FR49, FR50, FR51
**Status:** Stories 8.1-8.5 vollstaendig definiert.

### Epic 9: Monetarisierung & Publish-Pipeline (MVP-Infrastruktur)
Der Entwickler kann das Projekt als Free/Pro-Dual-Repo veroeffentlichen — mit License-Key-Validierung, Free-Tier-Limits, Dual-Repo-Trennung und reproduzierbarer Publish-Pipeline.
**FRs:** FR63, FR64, FR65, FR66, FR67, FR68, FR69

### Epic 10: Pre-Launch Stabilisierung (Phase 2)
Offene Tech-Debt beseitigen, fehlschlagende Tests fixen, Smoke-Test und Benchmark-Runner stabilisieren — saubere Basis bevor neue Features kommen.
**FRs:** Keine neuen FRs — Stabilisierung bestehender Implementierung
**NFRs:** NFR9, NFR24

### Epic 11: Benchmark-Suite v2 — Community Pain Points (Phase 2)
Die Benchmark-Suite beweist wo SilbercueChrome die Konkurrenz schlaegt — mit Tests fuer die 7 meistgewuenschten Community-Features plus automatisiertem Benchmark-Runner.
**FRs:** FR71, FR72, FR73, FR74, FR75, FR76, FR77, FR80
**NFRs:** NFR29

### Epic 12: Token-Transparenz & Metriken (Phase 2)
Jede Tool-Response zeigt ihren Token-Footprint — Response-Groesse in Bytes, geschaetzte Token-Anzahl, und ein Benchmark-Test der Token-Budgets verifiziert.
**FRs:** FR78, FR79
**NFRs:** NFR4

### Epic 13: Visual Developer Intelligence (Phase 3)
Der Agent bekommt CSS-Debugging in einem Call statt Trial-and-Error, und visuelles Feedback nach Code-Edits — zwei Features die den Agent vom blinden Raten zur gezielten Analyse bringen.
**FRs:** TBD (FR81+)
**Abhaengigkeit:** Keine (CDP-Infrastruktur existiert)

---

## Epic 1: Project Foundation & JavaScript Execution

Der Agent kann sich mit Chrome verbinden, beliebiges JavaScript ausfuehren und Ergebnisse zurueckerhalten — die Grundlage fuer alles Weitere.

### Story 1.1: Project Setup & Build Tooling

As a **developer (Julian)**,
I want ein vollstaendig konfiguriertes TypeScript-Projekt mit Build-Tooling, Testing und Code-Quality,
So that ich eine solide Grundlage fuer die iterative Entwicklung des MCP-Servers habe.

**Acceptance Criteria:**

**Given** ein leeres Verzeichnis
**When** das Projekt initialisiert wird
**Then** existiert package.json mit name `@silbercuechrome/mcp`, TypeScript 5.7+, Vitest, ESLint, Prettier
**And** tsconfig.json mit strict mode, ES2022 target, Node16 module resolution
**And** die Projektstruktur `src/transport/`, `src/cdp/`, `src/cache/`, `src/tools/`, `src/plan/`, `src/index.ts`, `src/server.ts`, `src/registry.ts`, `src/types.ts` existiert als Grundgeruest
**And** `npm run build` kompiliert nach `build/` und `npm test` laeuft ohne Fehler
**And** .gitignore schliesst `node_modules/`, `build/` aus

### Story 1.2: Transport Layer & CDP-Client

As a **MCP-Server**,
I want eine Transport-Abstraktion mit CDP-Pipe und WebSocket-Implementierung sowie einen CDP-Client der Nachrichten routet,
So that ich ueber beide Transportwege zuverlaessig mit Chrome kommunizieren kann.

**Acceptance Criteria:**

**Given** das Transport-Interface mit `send()`, `onMessage()`, `close()`
**When** eine CDP-Pipe-Verbindung hergestellt wird (FD3/FD4)
**Then** kann der CDP-Client Nachrichten senden und Responses empfangen
**And** die CDP-Call-Latenz liegt unter 5ms Round-Trip (NFR3)

**Given** das Transport-Interface
**When** eine WebSocket-Verbindung zu `localhost:9222` hergestellt wird
**Then** kann der CDP-Client identisch kommunizieren wie ueber Pipe
**And** der Transport-Typ ist fuer hoehere Schichten transparent

**Given** der CDP-Client
**When** ein CDP-Call gesendet wird
**Then** wird er ueber `cdpClient.send(method, params, sessionId)` geroutet — nie direkt auf den Transport
**And** Unit-Tests fuer beide Transports und den CDP-Client bestehen

### Story 1.3: Chrome Auto-Launch & Connection Strategy

As a **AI-Agent-Entwickler**,
I want dass der Server intelligent erst eine laufende Chrome-Instanz sucht und bei Bedarf automatisch Chrome startet,
So that ich Zero-Config-Setup bekomme und in unter 60 Sekunden produktiv bin.

**Acceptance Criteria:**

**Given** Chrome laeuft bereits mit Remote-Debugging auf Port 9222
**When** der Server startet
**Then** verbindet er sich per WebSocket und meldet "verbunden"
**And** kein neuer Chrome-Prozess wird gestartet

**Given** kein Chrome mit Remote-Debugging erreichbar
**When** der Server startet
**Then** startet er Chrome als Child-Prozess mit `--remote-debugging-pipe --user-data-dir=/tmp/silbercuechrome-profile` (Chrome 136+ kompatibel)
**And** verbindet sich per CDP-Pipe
**And** der Cold-Start liegt unter 3 Sekunden (NFR7)

**Given** der Server ist verbunden (Pipe oder WebSocket)
**When** der Verbindungsstatus abgefragt wird (FR4)
**Then** wird "verbunden", "reconnecting" oder "getrennt" zurueckgegeben
**And** Debug-Logging ueber `DEBUG=silbercuechrome` verfuegbar (kein console.log auf stdout)

### Story 1.4: MCP Server, ToolRegistry & evaluate Tool

As a **AI-Agent**,
I want einen MCP-Server der ueber stdio erreichbar ist und mir ein `evaluate` Tool bietet,
So that ich beliebiges JavaScript im Browser ausfuehren und Ergebnisse als JSON erhalten kann.

**Acceptance Criteria:**

**Given** der MCP-Server laeuft und ist per stdio verbunden
**When** der Agent das Tool `evaluate` mit JavaScript-Code aufruft (FR20)
**Then** wird der Code im Seitenkontext ausgefuehrt und das Ergebnis als JSON-serialisierbarer Wert zurueckgegeben (FR21)
**And** die Response enthaelt `_meta: { elapsedMs, method: "evaluate" }` (FR33)
**And** die evaluate-Ausfuehrung liegt unter 50ms fuer Scripts bis 100 Zeilen (NFR6)

**Given** der Agent ruft `evaluate` mit fehlerhaftem JavaScript auf
**When** ein Fehler auftritt
**Then** wird `isError: true` zurueckgegeben mit der Fehlermeldung — keine Exception nach oben

**Given** die Tool-Definitionen des MCP-Servers
**When** der Agent die verfuegbaren Tools abfragt
**Then** liegt der Token-Overhead unter 5.000 Tokens (FR32, NFR4)
**And** das Tool-Schema nutzt Zod fuer Validierung
**And** die ToolRegistry in `registry.ts` verwaltet alle Tool-Registrierungen

---

## Epic 2: Page Navigation & Content Reading

Der Agent kann Websites navigieren, auf Seitenstabilitaet warten und Seiteninhalte ueber den Accessibility Tree progressiv lesen — die erste vollstaendige Browser-Interaktion.

### Story 2.1: navigate Tool mit Settle-Logik

As a **AI-Agent**,
I want zu einer URL navigieren und automatisch auf Seitenstabilitaet warten koennen,
So that ich zuverlaessig mit vollstaendig geladenen Seiten arbeiten kann — auch bei SPAs mit Hydration.

**Acceptance Criteria:**

**Given** der Agent ruft `navigate` mit einer URL auf
**When** die Seite geladen wird
**Then** wartet der Server automatisch auf Network Idle + DOM Stable (Settle) bevor er antwortet (FR6)
**And** die Response enthaelt die finale URL, Titel und `_meta` mit Timing

**Given** der Agent ruft `navigate` mit `action: "back"` auf
**When** der Browser zurueck navigiert
**Then** wartet der Server auf Settle und gibt den neuen Seitenstatus zurueck (FR7)

**Given** eine SPA mit Client-Side-Navigation (pushState/replaceState)
**When** Navigation erkannt wird
**Then** wartet der Server auf abgeschlossene Hydration bevor er Bereitschaft meldet (FR9)

**Given** der Agent uebergibt `settle_ms` als Parameter
**When** die Navigation abgeschlossen ist
**Then** wird die konfigurierte Settle-Dauer verwendet statt des Defaults (FR10)

**And** die Settle-Logik lebt zentral in `cdp/settle.ts` und wird von navigate (und spaeter click) wiederverwendet

### Story 2.2: A11y-Tree-Processor & read_page Tool

As a **AI-Agent**,
I want Seiteninhalte ueber den Accessibility Tree progressiv lesen koennen,
So that ich die Seite effizient verstehe ohne 50k+ Tokens A11y-Tree auf einmal zu verbrauchen.

**Acceptance Criteria:**

**Given** der Agent ruft `read_page` ohne Parameter auf
**When** der A11y-Tree abgefragt wird
**Then** wird ein Ueberblick mit Tiefe 3 und nur interaktiven Elementen geliefert (FR16, FR17)
**And** jedes Element hat eine stabile Ref-ID (`e1`, `e2`, ...) (FR11)

**Given** der Agent ruft `read_page` mit `depth: 5` auf
**When** der A11y-Tree abgefragt wird
**Then** wird der Baum bis zur angegebenen Tiefe geliefert (FR16)

**Given** der Agent ruft `read_page` mit `ref: "e42"` auf
**When** der Teilbaum abgefragt wird
**Then** wird nur der Teilbaum unter Element e42 zurueckgegeben (FR18)

**Given** der Agent ruft `read_page` zweimal hintereinander auf (ohne Navigation)
**When** die Ref-IDs verglichen werden
**Then** sind bestehende Refs stabil — neue DOM-Elemente bekommen neue Nummern (NFR13)

**And** der A11y-Tree-Processor lebt in `cache/a11y-tree.ts`, Refs werden bei Navigation zurueckgesetzt

### Story 2.3: screenshot Tool

As a **AI-Agent**,
I want einen komprimierten Screenshot der aktuellen Seite aufnehmen koennen,
So that ich visuelle Informationen erhalte ohne exzessiv Tokens zu verbrauchen.

**Acceptance Criteria:**

**Given** der Agent ruft `screenshot` auf
**When** die Seite gerendert ist
**Then** wird ein WebP-Screenshot zurueckgegeben, max 800px breit (FR19)
**And** die Dateigroesse liegt unter 100KB (NFR5)
**And** die Response enthaelt `_meta` mit Timing

**Given** der Agent ruft `screenshot` auf einer leeren Seite auf
**When** kein relevanter Inhalt vorhanden ist
**Then** wird trotzdem ein gueltiger Screenshot zurueckgegeben (kein Fehler)

### Story 2.4: wait_for Tool

As a **AI-Agent**,
I want explizit auf spezifische Bedingungen warten koennen,
So that ich bei asynchronen Operationen sicherstellen kann, dass die Seite bereit ist.

**Acceptance Criteria:**

**Given** der Agent ruft `wait_for` mit `condition: "element"` und einem Selektor/Ref auf
**When** das Element sichtbar wird
**Then** gibt der Server Erfolg zurueck mit der Wartezeit in `_meta` (FR8)

**Given** der Agent ruft `wait_for` mit `condition: "network_idle"` auf
**When** keine offenen HTTP-Requests mehr vorhanden sind
**Then** gibt der Server Erfolg zurueck (FR8)

**Given** der Agent ruft `wait_for` mit `condition: "js"` und einer Expression auf
**When** die Expression `true` zurueckgibt
**Then** gibt der Server Erfolg zurueck (FR8)

**Given** der Agent wartet und das Timeout wird ueberschritten
**When** die Bedingung nicht erfuellt wird
**Then** gibt der Server `isError: true` mit verstaendlicher Fehlermeldung zurueck

---

## Epic 3: Element Interaction

Der Agent kann mit Seitenelementen interagieren — klicken, tippen, Formulare befuellen — ueber stabile A11y-Referenzen oder CSS-Selektoren mit intelligenten Fehlermeldungen.

### Story 3.1: click Tool

As a **AI-Agent**,
I want Elemente per A11y-Ref oder CSS-Selektor klicken koennen,
So that ich mit Webseiten interagieren kann ohne Screenshots analysieren zu muessen.

**Acceptance Criteria:**

**Given** der Agent ruft `click` mit `ref: "e5"` auf
**When** das Element im A11y-Tree existiert
**Then** wird das Element geklickt und der Server wartet auf Settle (FR13, FR15)
**And** die Response bestaetigt den Klick mit `_meta` Timing

**Given** der Agent ruft `click` mit `selector: "#submit-btn"` auf
**When** das Element per CSS-Selektor gefunden wird
**Then** wird das Element geklickt (FR12 — CSS-Fallback)

**Given** der Agent ruft `click` mit `ref: "e99"` auf und das Element existiert nicht
**When** die Ref-Aufloesung fehlschlaegt
**Then** gibt der Server `isError: true` mit kontextueller Fehlermeldung zurueck: "Element e99 nicht gefunden — meintest du e98 (Button 'Absenden')?" (FR34)
**And** die naechstgelegene Alternative wird mit Name und Typ vorgeschlagen

### Story 3.2: type Tool

As a **AI-Agent**,
I want Text in Eingabefelder tippen koennen,
So that ich Formulare befuellen und Suchanfragen eingeben kann.

**Acceptance Criteria:**

**Given** der Agent ruft `type` mit `ref: "e12"` und `text: "hello@example.com"` auf
**When** das Element ein Eingabefeld ist
**Then** wird der Text in das Feld getippt (FR14)
**And** die Response bestaetigt die Eingabe mit `_meta` Timing

**Given** der Agent ruft `type` mit `selector: "input[name='email']"` auf
**When** das Element per CSS-Selektor gefunden wird
**Then** wird der Text eingegeben (FR12 — CSS-Fallback)

**Given** der Agent ruft `type` mit einer ungueltigen Ref auf
**When** die Ref-Aufloesung fehlschlaegt
**Then** gibt der Server eine kontextuelle Fehlermeldung zurueck (FR34)
**And** schlaegt das naechste Eingabefeld als Alternative vor

**Given** der Agent ruft `type` mit `clear: true` auf
**When** das Feld bereits Text enthaelt
**Then** wird das Feld zuerst geleert, dann der neue Text eingegeben

---

## Epic 4: Tab Management & VirtualDesk

Der Agent hat eine kompakte Uebersicht aller Tabs, kann zwischen Tabs wechseln und bekommt gecachten State sofort — kein redundantes Abfragen.

### Story 4.1: TabStateCache & tab_status Tool

As a **AI-Agent**,
I want den Status des aktuellen Tabs sofort abfragen koennen ohne auf CDP warten zu muessen,
So that ich schnell den Seitenkontext verstehe und redundante Abfragen vermeide.

**Acceptance Criteria:**

**Given** der Agent hat eine Seite navigiert
**When** er `tab_status` aufruft
**Then** erhaelt er gecachten State: URL, Title, DOM-Ready, Console-Errors (FR22, FR23)
**And** die Response kommt sofort aus dem Cache ohne CDP-Call

**Given** der Agent navigiert zu einer neuen Seite
**When** die Navigation abgeschlossen ist
**Then** wird der Cache automatisch invalidiert und mit neuen Daten befuellt (FR24)

**Given** ein DOM-Event den Seitenstate aendert (z.B. pushState)
**When** die Aenderung erkannt wird
**Then** wird der betroffene Cache-Eintrag invalidiert (FR24)

**And** TabStateCache lebt in `cache/tab-state-cache.ts` mit konfigurierbaren TTLs
**And** Unit-Tests pruefen Cache-Hit, Cache-Miss und Invalidierung

### Story 4.2: switch_tab Tool

As a **AI-Agent**,
I want Tabs oeffnen, schliessen und wechseln koennen,
So that ich Multi-Tab-Workflows ausfuehren kann.

**Acceptance Criteria:**

**Given** der Agent ruft `switch_tab` mit `action: "open"` und einer URL auf
**When** der Tab erstellt wird
**Then** wird ein neuer Tab geoeffnet, zur URL navigiert und der Tab-State gecacht (FR31)

**Given** der Agent ruft `switch_tab` mit `action: "switch"` und einer Tab-ID auf
**When** der Tab existiert
**Then** wird zum Tab gewechselt und der gecachte State zurueckgegeben (FR31)

**Given** der Agent ruft `switch_tab` mit `action: "close"` auf
**When** der Tab geschlossen wird
**Then** wird der Tab geschlossen und der Cache-Eintrag entfernt (FR31)
**And** der Agent wird auf den naechsten aktiven Tab gewechselt

### Story 4.3: virtual_desk Tool

As a **AI-Agent**,
I want eine kompakte Uebersicht aller offenen Tabs auf einen Blick,
So that ich den Gesamtkontext meiner Browser-Session sofort erfassen kann.

**Acceptance Criteria:**

**Given** der Agent ruft `virtual_desk` auf
**When** mehrere Tabs offen sind
**Then** erhaelt er eine Liste aller Tabs mit URL, Title, Lade-Status und aktiv/inaktiv (FR25, FR26)

**Given** 10 Tabs offen sind
**When** `virtual_desk` aufgerufen wird
**Then** liegt die Response unter 500 Tokens — kompakte Darstellung ohne Full-Tree pro Tab (FR27)

**Given** ein Tab gerade laedt
**When** `virtual_desk` aufgerufen wird
**Then** zeigt der Lade-Status "loading" statt "ready" an

---

## Epic 5: Batch Execution & Connection Resilience

Der Agent kann Multi-Step-Workflows in einem einzigen Call ausfuehren (run_plan) und die Verbindung ist rock-solid — Auto-Reconnect, OOPIF-Support, kein Session-Verlust.

### Story 5.1: run_plan Tool & PlanExecutor

As a **AI-Agent**,
I want ein serielles Array von Operationen in einem einzigen Tool-Call ausfuehren koennen,
So that ich Multi-Step-Workflows ohne N LLM-Roundtrips erledige — der kategoriale Geschwindigkeitssprung.

**Acceptance Criteria:**

**Given** der Agent ruft `run_plan` mit einem Array von Steps auf (z.B. navigate → click → type → screenshot)
**When** der PlanExecutor die Steps verarbeitet
**Then** werden alle Steps server-seitig seriell ausgefuehrt — 1 LLM-Roundtrip statt N (FR28, FR29, NFR8)
**And** die Response enthaelt das Ergebnis jedes einzelnen Steps mit `_meta` Timing

**Given** ein Step im Plan schlaegt fehl
**When** der Fehler auftritt
**Then** bricht der PlanExecutor ab und gibt Teilergebnisse zurueck: erfolgreiche Steps + Fehler-Step (FR30)

**Given** der Plan referenziert Tools per Name
**When** der PlanExecutor die Tools aufloest
**Then** nutzt er die ToolRegistry um Tools per Name auszufuehren — Tools rufen sich nie gegenseitig auf

**And** der PlanExecutor lebt in `plan/plan-executor.ts`, der Tool-Handler in `tools/run-plan.ts`
**And** jeder Step wartet automatisch auf Settle wo relevant (navigate, click)

### Story 5.2: Auto-Reconnect & State Recovery

As a **AI-Agent-Entwickler**,
I want dass die CDP-Verbindung bei Verlust automatisch wiederhergestellt wird,
So that meine laufenden Workflows nicht durch kurze Verbindungsunterbrechungen abbrechen.

**Acceptance Criteria:**

**Given** die CDP-Verbindung geht verloren (Chrome-Neustart, Netzwerk-Timeout)
**When** der Reconnect-Mechanismus aktiviert wird
**Then** versucht der Server bis zu 3x mit 1s Pause zu reconnecten (FR3)
**And** der Reconnect erfolgt innerhalb von 3 Sekunden (NFR11)

**Given** ein Tool-Call laeuft waehrend der Verbindungsverlust auftritt
**When** der Call nicht zugestellt werden kann
**Then** failt der Call sofort mit `isError: true` und verstaendlicher Fehlermeldung — kein stilles Haengen

**Given** der Reconnect ist erfolgreich
**When** die Verbindung wiederhergestellt ist
**Then** bleibt der gecachte TabStateCache erhalten (NFR12)
**And** der Verbindungsstatus wechselt von "reconnecting" auf "verbunden"

**Given** Chrome komplett abstuerzt
**When** der Server den Absturz erkennt
**Then** meldet er den Fehler an den Agent innerhalb von 3 Sekunden, kein Server-Crash (NFR14)

### Story 5.3: OOPIF-Support (Cross-Origin iFrames)

As a **AI-Agent**,
I want auf Elemente in Cross-Origin iFrames zugreifen koennen (Google Login, Stripe, Cookie-Banner),
So that ich auf jeder dritten Website nicht an unsichtbaren iFrame-Grenzen scheitere.

**Acceptance Criteria:**

**Given** eine Seite mit Cross-Origin iFrames (z.B. Google OAuth, Stripe Payment)
**When** der Agent `read_page` aufruft
**Then** werden Elemente in OOPIFs im A11y-Tree mit aufgefuehrt — transparent, ohne Unterschied zu Main-Frame-Elementen (FR5)

**Given** der Agent `click` auf ein Element in einem OOPIF aufruft
**When** die Ref aufgeloest wird
**Then** routet der Session-Manager den CDP-Call an die korrekte OOPIF-Session
**And** der Agent merkt keinen Unterschied zum Klick auf Main-Frame-Elemente

**Given** ein OOPIF wird dynamisch zur Seite hinzugefuegt
**When** das `Target.attachedToTarget` Event empfangen wird
**Then** erstellt der Session-Manager automatisch eine neue CDP-Session fuer das OOPIF

**And** Session-Multiplexing lebt in `cdp/session-manager.ts`

---

## Epic 5b: Visual Intelligence (Post-MVP)

Der Agent bekommt ein "drittes Auge" — optimierte Screenshots durch Retina-Fix, strukturierte visuelle DOM-Daten per DOMSnapshot, und optionale Layout-Anreicherung in read_page. Verbessert die Grundlagen-Tools aus Epic 2 mit CDP-APIs die bisher ungenutzt waren.

### Story 5b.1: Retina-Fix & Screenshot-Optimierung (Quick Win) — TEILWEISE DONE

**Status:** FR52, FR53, FR54 implementiert in commit e4d8805. Screenshot-Latenz aktuell ~50ms (Ziel <20ms noch offen — Playwright MCP schafft 16ms). Click-Settle entfernt (5014ms → 14ms), switch_tab about:blank Settle entfernt (1528ms → 38ms).

**Was noch fehlt:**
- Screenshot-Latenz weiter optimieren (50ms → <20ms)
- Emulation-Konstanten (1280x800) in eigenes Modul auslagern statt hartcodiert in server.ts/switch-tab.ts

**Implementierte ACs:** FR52 ✓, FR53 ✓, FR54 ✓
**Offene ACs:** NFR25 (Screenshot <20ms)

### Story 5b.2: DOMSnapshot-Tool (`dom_snapshot`)

As a **AI-Agent**,
I want strukturierte visuelle Informationen ueber die Seite abrufen koennen — Positionen, Farben, Sichtbarkeit, Z-Order —,
So that ich Layout-Fragen beantworten kann ohne Screenshots zu analysieren und ohne den vollen DOM-Baum zu lesen.

**Acceptance Criteria:**

**Given** der Agent ruft `dom_snapshot` ohne Parameter auf
**When** `DOMSnapshot.captureSnapshot` ausgefuehrt wird
**Then** wird ein strukturiertes JSON zurueckgegeben mit:
- Element-Positionen (Bounding-Boxes aus DOMRects)
- Farben (color, background-color via computedStyles)
- Sichtbarkeit (display, visibility)
- Z-Order (z-index, paint-order)
- Font-Informationen (font-size)
**And** die CDP-Parameter sind: `computedStyles: ["display", "visibility", "color", "background-color", "font-size", "position", "z-index"]`, `includeDOMRects: true`, `includeBlendedBackgroundColors: true`, `includePaintOrder: true` (FR55)

**Given** die Seite hat 500+ DOM-Elemente
**When** `dom_snapshot` aufgerufen wird
**Then** werden nur interaktive und sichtbare Elemente zurueckgegeben (FR56)
**And** Elemente mit `display: none` oder `visibility: hidden` werden gefiltert
**And** die Response bleibt unter 2.000 Tokens fuer typische Webseiten (NFR26)

**Given** der Agent ruft `dom_snapshot` mit `ref: "e42"` auf
**When** der Snapshot erstellt wird
**Then** wird nur der Teilbaum unter Element e42 zurueckgegeben
**And** die Bounding-Boxes sind relativ zum Viewport

**Given** der Agent ruft `dom_snapshot` auf
**When** die Response formatiert wird
**Then** enthaelt jedes Element: `ref` (passend zu read_page Refs), `tag`, `role`, `name`, `bounds: {x, y, w, h}`, `styles: {...}`, `isClickable: boolean`, `paintOrder: number`
**And** die Response enthaelt `_meta` mit Timing

**Technical Notes:**
- Tool-Handler in `tools/dom-snapshot.ts`
- Nutzt `DOMSnapshot.captureSnapshot` — ein einziger CDP-Call der alles liefert
- Token-Budget: Aggressive Filterung noetig. Nur Elemente mit: (a) interaktiver Rolle ODER (b) sichtbarer Bounding-Box > 10x10px ODER (c) explizit per Ref angefragt
- Ref-Mapping: DOMSnapshot-Nodes muessen auf die bestehenden A11y-Ref-IDs (`e1`, `e2`, ...) gemappt werden — Konsistenz mit read_page ist kritisch

**Forschungs-Referenzen (FR56, FR58, FR61):**
- **6-stufige Filterpipeline** nach browser-use DOMTreeSerializer: Simplification → Paint Order Filtering (Occlusion via `includePaintOrder`) → BBox Filtering (Zero-Size, Off-Screen, visibility:hidden) → Index Assignment (Backend Node IDs) → New Element Marking → Shadow DOM Handling. Reduziert 10.000+ Elemente auf ~200 interaktive.
- **Parallele CDP-Requests** (FR58): 5 Requests gleichzeitig feuern wie browser-use: DOM.getDocument + Accessibility.getFullAXTree + DOMSnapshot.captureSnapshot + Page.getLayoutMetrics + Runtime.evaluate(EventListeners). Fusion zu EnhancedDOMTreeNode.
- **isClickable-Heuristik** (FR61): Native Tags (`button`, `a`, `input`) + ARIA-Rollen (`role="button"`) + CSS (`cursor: pointer`) + JS-Events via `Runtime.getEventListeners()`. Erkennt klickbare `div`/`span`.
- **Wichtig:** `DOMSnapshot.getSnapshot` ist DEPRECATED — nur `captureSnapshot` verwenden. Shadow DOM liefert keine Snapshot-Daten — separate Behandlung noetig.
- Quelle: deepwiki.com/browser-use/browser-use, chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/

### Story 5b.3: read_page Anreicherung mit visuellen Infos

As a **AI-Agent**,
I want read_page optional mit Positionsdaten und Sichtbarkeits-Infos anreichern koennen,
So that ich Layout-Verstaendnis direkt aus dem A11y-Tree bekomme ohne einen separaten dom_snapshot-Call.

**Acceptance Criteria:**

**Given** der Agent ruft `read_page` mit `filter: "visual"` auf
**When** der A11y-Tree abgefragt wird
**Then** enthaelt jedes Element zusaetzlich:
- `bounds: {x, y, w, h}` (Bounding-Box relativ zum Viewport)
- `isClickable: boolean` (ob das Element klickbar ist)
- `isVisible: boolean` (ob das Element im sichtbaren Viewport liegt)
**And** die A11y-Tree-Struktur bleibt identisch zu `filter: "interactive"` — nur angereichert mit visuellen Daten (FR57)

**Given** der Agent ruft `read_page` mit `filter: "visual"` und `ref: "e15"` auf
**When** der Teilbaum abgefragt wird
**Then** wird der Teilbaum unter e15 mit visuellen Infos zurueckgegeben
**And** die Bounding-Boxes sind relativ zum Viewport

**Given** der Agent ruft `read_page` ohne `filter: "visual"` auf
**When** der A11y-Tree zurueckgegeben wird
**Then** enthaelt er KEINE visuellen Daten — das bestehende Verhalten bleibt unveraendert
**And** kein zusaetzlicher CDP-Call wird ausgefuehrt

**Given** der Agent ruft `read_page` mit `filter: "visual"` auf
**When** die visuellen Daten beschafft werden
**Then** werden die Daten aus einem DOMSnapshot-Call gewonnen (gleiche Engine wie dom_snapshot)
**And** die Daten werden mit den A11y-Ref-IDs zusammengefuehrt

**Technical Notes:**
- Implementierung in `cache/a11y-tree.ts` — der bestehende A11y-Tree-Processor wird um eine optionale DOMSnapshot-Anreicherung erweitert
- DOMSnapshot wird nur bei `filter: "visual"` aufgerufen — kein Performance-Impact auf den Standardpfad
- Die Ref-Zuordnung nutzt Node-Indices: DOMSnapshot liefert Node-Indices die mit den A11y-Backend-Node-IDs korreliert werden koennen
- `isClickable` Heuristik: `<a>`, `<button>`, `[role="button"]`, `[role="link"]`, `[onclick]`, `cursor: pointer`

**Forschungs-Referenz (FR59):**
- **DOM Downsampling** (D2Snap, arXiv 2508.04412): Drei Elementklassen — Container (mergen), Content (zu Markdown), Interactive (immer voll erhalten). AdaptiveD2Snap nimmt Token-Budget `tmax` und iteriert automatisch bis Ziel erreicht. 1M Token DOM → ~1.000 Token Output. Wichtig: Hierarchie bewahren — aggressives Merging senkt LLM-Performance.
- Anwendbar auf `filter: "visual"`: Token-Budget als optionaler Parameter, Pipeline filtert automatisch bis Budget eingehalten.

### Story 5b.4: Set-of-Mark (SoM) auf Screenshots

As a **AI-Agent**,
I want nummerierte Labels auf Screenshots sehen koennen die zu den A11y-Ref-IDs passen,
So that ich visuell erkennen kann welches Element welche Ref-ID hat — besonders bei Custom-UI ohne semantische Labels.

**Acceptance Criteria:**

**Given** der Agent ruft `screenshot` mit `som: true` auf
**When** der Screenshot erstellt wird
**Then** werden interaktive Elemente mit nummerierten Labels markiert (z.B. "e5", "e12")
**And** die Labels entsprechen den Ref-IDs aus read_page
**And** Labels sind visuell deutlich (farbiger Hintergrund, hoher Kontrast)

**Given** eine Seite mit 50+ interaktiven Elementen
**When** SoM-Screenshot erstellt wird
**Then** werden nur die sichtbaren Elemente im Viewport markiert (kein Clutter)
**And** die Dateigrösse bleibt unter 100KB (NFR5)

**Given** der Agent ruft `screenshot` ohne `som` auf
**When** der Screenshot erstellt wird
**Then** wird ein normaler Screenshot ohne Labels zurueckgegeben — bestehendes Verhalten

**Technical Notes:**
- Implementierung: CDP `DOMSnapshot.captureSnapshot` fuer Bounding-Boxes → Screenshot → Canvas-Labels an Koordinaten zeichnen (server-seitig via Node Canvas oder CDP Overlay)
- Alternative: CDP `Overlay.highlightNode` temporaer setzen → Screenshot → `Overlay.hideHighlight()`. Einfacher aber weniger kontrollierbar.
- Labels muessen A11y-Ref-IDs matchen — keine eigene Nummerierung
- Forschung: WebVoyager zeigt 59.1% Task Success mit SoM vs 30.8% ohne (Quelle: arXiv 2401.13919). GPT-4V-Act nutzt Canvas-basierte Labels.
- **FRs:** FR60

### Story 5b.5: DOM Downsampling mit Token-Budget

As a **AI-Agent**,
I want dass read_page ein maximales Token-Budget akzeptiert und die Seite automatisch auf diese Groesse komprimiert,
So that ich auch riesige Seiten (News, E-Commerce, Dashboards) effizient lesen kann ohne Token-Limits zu sprengen.

**Acceptance Criteria:**

**Given** der Agent ruft `read_page` mit `max_tokens: 4000` auf
**When** die Seite mehr als 4000 Tokens A11y-Inhalt hat
**Then** wird der Inhalt automatisch komprimiert: Container gemergt, Content zu Markdown, Interactive voll erhalten
**And** die Response bleibt unter dem angegebenen Token-Budget (NFR28)
**And** die Hierarchie bleibt erhalten (keine flache Liste)

**Given** der Agent ruft `read_page` ohne `max_tokens` auf
**When** die Seite gelesen wird
**Then** wird kein Downsampling angewendet — bestehendes Verhalten

**Given** eine E-Commerce-Seite mit 10.000+ DOM-Elementen
**When** `read_page` mit `max_tokens: 8000` aufgerufen wird
**Then** werden Produktlisten zu Markdown-Tabellen komprimiert
**And** Navigations-Container gemergt
**And** interaktive Elemente (Buttons, Links, Inputs) bleiben voll erhalten mit Ref-IDs

**Technical Notes:**
- Inspiriert von D2Snap (arXiv 2508.04412): Drei Parameter (k=Container-Merge, l=Text-Rank, m=Attribut-Score). AdaptiveD2Snap iteriert mit Halton-Sequenz bis Token-Budget erreicht. Wachstumsfaktor x1.125, max 5 Iterationen.
- Elementklassifikation: Container (`div`, `section`, `nav`) → mergen. Content (`h1`-`h6`, `p`, `table`) → Markdown. Interactive (`button`, `input`, `a`) → immer voll erhalten.
- Wichtig: Hohe k-Werte (aggressives Hierarchy-Merging) senken LLM-Performance. Hierarchie ist das wichtigste Feature fuer LLMs.
- **FRs:** FR59

---

## Epic 6: Extended Workflow Capabilities (Phase 2)

Der Agent bewaeltigt komplexere Workflows — erweiterter run_plan mit Conditionals/Variables, Dialog-Handling, File-Upload, Formular-Befuellung.
**FRs:** FR35, FR36, FR42, FR43, FR44

### Story 6.1: Dialog-Handling (`handle_dialog`)

As a **AI-Agent**,
I want dass Browser-Dialoge (Alerts, Confirms, Prompts, Cookie-Banner) automatisch oder gezielt behandelt werden,
So that meine Workflows nicht an modalen Dialogen haengenbleiben.

**Acceptance Criteria:**

**Given** eine Seite zeigt einen JavaScript-Alert (`window.alert`)
**When** der Dialog erscheint
**Then** wird er automatisch dismissed und der Agent erhaelt eine Notification im naechsten Tool-Response: `{ dialog: { type: "alert", message: "..." } }`

**Given** eine Seite zeigt einen Confirm-Dialog (`window.confirm`)
**When** der Agent `handle_dialog` mit `action: "accept"` oder `action: "dismiss"` konfiguriert hat
**Then** wird der Dialog entsprechend beantwortet
**And** das Ergebnis (true/false) wird in der Response zurueckgegeben

**Given** eine Seite zeigt einen Prompt-Dialog (`window.prompt`)
**When** der Agent `handle_dialog` mit `action: "accept"` und `text: "Eingabe"` konfiguriert hat
**Then** wird der Text eingegeben und der Dialog bestaetigt

**Given** kein Dialog-Handler konfiguriert ist
**When** ein Dialog erscheint
**Then** wird er nach einem konfigurierbaren Timeout (Default: 3s) automatisch dismissed
**And** der Agent wird ueber den unbehandelten Dialog informiert

**Technical Notes:**
- CDP Events: `Page.javascriptDialogOpening`, `Page.handleJavaScriptDialog`
- Handler-Registration als Stack: letzter Handler gewinnt (z.B. run_plan setzt temporaeren Handler)
- Tool-Handler in `tools/handle-dialog.ts`, Event-Listener in `cdp/dialog-handler.ts`
- **FRs:** FR42

### Story 6.2: File-Upload (`file_upload`)

As a **AI-Agent**,
I want Dateien in File-Upload-Felder hochladen koennen,
So that ich Workflows mit Datei-Uploads (Dokumente, Bilder, CSVs) automatisieren kann.

**Acceptance Criteria:**

**Given** der Agent ruft `file_upload` mit `ref: "e8"` und `path: "/tmp/test.pdf"` auf
**When** das Element ein `<input type="file">` ist
**Then** wird die Datei ueber `DOM.setFileInputFiles` hochgeladen
**And** die Response bestaetigt den Upload mit Dateiname und Groesse

**Given** der Agent ruft `file_upload` mit `selector: "input[type=file]"` und mehreren Pfaden auf
**When** das Input-Feld `multiple` akzeptiert
**Then** werden alle Dateien gleichzeitig hochgeladen

**Given** der Agent ruft `file_upload` auf ein Element das kein File-Input ist
**When** die Validierung fehlschlaegt
**Then** gibt der Server `isError: true` mit kontextueller Fehlermeldung zurueck: "Element e8 ist kein File-Input — naechstes File-Input: e12 (input 'Upload')"

**Given** der angegebene Dateipfad existiert nicht
**When** der Upload versucht wird
**Then** gibt der Server `isError: true` mit `"Datei nicht gefunden: /tmp/test.pdf"` zurueck

**Technical Notes:**
- CDP: `DOM.setFileInputFiles({ files: [path], backendNodeId })` — kein echtes "Tippen", direkte Datei-Zuweisung
- Ref-Aufloesung wiederverwendet die bestehende Logik aus click/type
- Tool-Handler in `tools/file-upload.ts`
- **FRs:** FR43

### Story 6.3: Komplexe Formulare (`fill_form`)

As a **AI-Agent**,
I want ein komplettes Formular mit einem einzigen Tool-Call befuellen koennen,
So that ich mehrstufige Formulare effizient ausfuelle statt N einzelne type-Calls zu machen.

**Acceptance Criteria:**

**Given** der Agent ruft `fill_form` mit einem Object `{ fields: [{ ref: "e5", value: "Max" }, { ref: "e6", value: "Mustermann" }, { selector: "#email", value: "max@test.de" }] }` auf
**When** die Felder befuellt werden
**Then** werden alle Felder sequentiell ausgefuellt (type mit clear: true pro Feld)
**And** die Response enthaelt den Status pro Feld: `{ results: [{ ref: "e5", status: "ok" }, ...] }`

**Given** ein Feld im Formular ist ein `<select>` Element
**When** `fill_form` mit `{ ref: "e10", value: "Option B" }` aufgerufen wird
**Then** wird die passende Option per `DOM.setAttributeValue` oder `Runtime.evaluate` ausgewaehlt

**Given** ein Feld im Formular ist eine Checkbox oder Radio-Button
**When** `fill_form` mit `{ ref: "e15", value: true }` aufgerufen wird
**Then** wird das Element geklickt falls der aktuelle Zustand nicht dem gewuenschten entspricht

**Given** ein Feld nicht gefunden wird
**When** die Ref-Aufloesung fehlschlaegt
**Then** wird das Feld als `{ ref: "e99", status: "error", message: "..." }` in der Response markiert
**And** die restlichen Felder werden trotzdem befuellt (kein Abbruch)

**Technical Notes:**
- Nutzt intern die bestehenden type- und click-Handler — kein Code-Duplikat
- Select-Handling: `Runtime.evaluate` mit `element.value = 'x'; element.dispatchEvent(new Event('change'))`
- Tool-Handler in `tools/fill-form.ts`
- **FRs:** FR44

### Story 6.4: Erweiterter run_plan (Conditionals, Variables, Error-Strategien)

As a **AI-Agent**,
I want run_plan mit Bedingungen, Variablen und konfigurierbaren Error-Strategien nutzen koennen,
So that ich komplexe Workflows mit Verzweigungen und Fehlertoleranz in einem einzigen Call ausfuehren kann.

**Acceptance Criteria:**

**Given** der Agent ruft `run_plan` mit Variablen auf: `{ vars: { url: "https://example.com" }, steps: [{ tool: "navigate", params: { url: "$url" } }] }`
**When** der PlanExecutor die Steps verarbeitet
**Then** werden `$var`-Referenzen in Params durch die definierten Variablen ersetzt
**And** Step-Ergebnisse koennen als Variable gespeichert werden: `{ tool: "evaluate", params: { expression: "document.title" }, saveAs: "pageTitle" }`

**Given** ein Step hat eine Bedingung: `{ tool: "click", params: { ref: "e5" }, if: "$pageTitle === 'Login'" }`
**When** der PlanExecutor den Step erreicht
**Then** wird der Step nur ausgefuehrt wenn die Bedingung `true` ergibt
**And** uebersprungene Steps werden als `{ status: "skipped", condition: "..." }` im Ergebnis markiert

**Given** der Plan hat `errorStrategy: "continue"` gesetzt
**When** ein Step fehlschlaegt
**Then** wird der Fehler im Ergebnis markiert und der naechste Step ausgefuehrt (statt Abbruch)
**And** die finale Response enthaelt alle Step-Ergebnisse inklusive Fehler

**Given** der Plan hat `errorStrategy: "screenshot"` gesetzt
**When** ein Step fehlschlaegt
**Then** wird automatisch ein Screenshot erstellt, im Fehler-Step angehaengt, und der Plan bricht ab

**Given** der Plan hat keine `errorStrategy` (Default)
**When** ein Step fehlschlaegt
**Then** bricht der Plan ab und gibt Teilergebnisse zurueck (bestehendes Verhalten, FR30)

**Technical Notes:**
- Variablen-Substitution in `plan/plan-variables.ts`: Regex `\$(\w+)` → Lookup in vars-Map
- Conditionals: `plan/plan-conditions.ts` — evaluiert einfache JS-Expressions gegen die vars-Map (kein eval, sondern sicherer Expression-Parser)
- Error-Strategien als Enum: `abort` (Default), `continue`, `screenshot`
- Bestehender PlanExecutor in `plan/plan-executor.ts` wird erweitert, nicht ersetzt
- **FRs:** FR35

### Story 6.5: Suspend/Resume fuer run_plan

As a **AI-Agent**,
I want dass ein laufender Plan pausiert werden kann um mir eine Entscheidungsfrage zu stellen, und nach meiner Antwort fortgesetzt wird,
So that ich bei unvorhergesehenen Zustaenden eingreifen kann ohne den gesamten Plan neu starten zu muessen.

**Acceptance Criteria:**

**Given** ein Step im Plan hat `suspend: { question: "Welches Element soll geklickt werden?", context: "screenshot" }` konfiguriert
**When** der PlanExecutor diesen Step erreicht
**Then** pausiert er den Plan und gibt eine Zwischenresponse zurueck: `{ status: "suspended", question: "...", completedSteps: [...], screenshot: "base64..." }`
**And** der Plan-State wird server-seitig gehalten (planId)

**Given** der Agent ruft `run_plan` mit `{ resume: { planId: "abc123", answer: "e15" } }` auf
**When** der PlanExecutor den Plan findet
**Then** setzt er die Ausfuehrung am pausierten Step fort mit der Antwort als Variable `$answer`
**And** die restlichen Steps werden normal ausgefuehrt

**Given** ein Step hat `suspend: { condition: "$elementCount === 0" }` konfiguriert
**When** die Bedingung nach Step-Ausfuehrung `true` ergibt
**Then** wird der Plan pausiert mit der Frage (Default: "Plan pausiert — Bedingung erfuellt. Wie fortfahren?")

**Given** ein suspendierter Plan wird nicht innerhalb von 5 Minuten resumed
**When** das Timeout ablaeuft
**Then** wird der Plan-State verworfen und bei resume-Versuch `isError: true` mit "Plan abgelaufen" zurueckgegeben

**Technical Notes:**
- Plan-State in `plan/plan-state-store.ts`: In-Memory Map mit TTL (5 Minuten)
- Suspend serialisiert den Plan-State: aktueller Step-Index, vars-Map, bisherige Ergebnisse
- Resume deserialisiert und setzt am gespeicherten Index fort
- Kein Disk-Persistenz — Plans ueberleben keinen Server-Restart
- **FRs:** FR36

---

## Epic 7: Observability & Session Intelligence (Phase 2)

Der Agent hat Einblick in Console-Logs und Network-Requests, intelligente Session-Defaults, Multi-Tab-Steuerung, sofortige A11y-Updates, und Selector-Caching mit DOM-Fingerprinting.
**FRs:** FR37, FR38, FR39, FR40, FR41, FR45, FR46, FR62

### Story 7.1: Console-Logs Tool (`console_logs`)

As a **AI-Agent**,
I want Console-Ausgaben der Seite abrufen und nach Themen filtern koennen,
So that ich Fehler, Warnungen und App-spezifische Logs gezielt inspizieren kann ohne alle Ausgaben lesen zu muessen.

**Acceptance Criteria:**

**Given** der Agent ruft `console_logs` ohne Parameter auf
**When** die Seite Console-Ausgaben produziert hat
**Then** werden alle gesammelten Logs zurueckgegeben: `[{ level: "error", text: "...", timestamp, source }]`
**And** die Response enthaelt `_meta` mit Timing und `count`

**Given** der Agent ruft `console_logs` mit `level: "error"` auf
**When** Logs gefiltert werden
**Then** werden nur Logs mit Level `error` zurueckgegeben (FR39)

**Given** der Agent ruft `console_logs` mit `pattern: "\\[MyApp\\]"` auf
**When** Logs nach Topic gefiltert werden
**Then** werden nur Logs zurueckgegeben deren Text dem Regex-Pattern entspricht (FR37)

**Given** der Agent ruft `console_logs` mit `level: "warning"` und `pattern: "deprecated"` auf
**When** beide Filter kombiniert werden
**Then** werden nur Warnungen die "deprecated" enthalten zurueckgegeben

**Given** der Agent ruft `console_logs` mit `clear: true` auf
**When** die Logs abgerufen werden
**Then** werden die Logs zurueckgegeben und der interne Buffer geleert
**And** nachfolgende Aufrufe liefern nur neue Logs

**Given** der Log-Buffer mehr als 1000 Eintraege enthaelt
**When** neue Logs eintreffen
**Then** werden die aeltesten Eintraege verworfen (Ring-Buffer, konfigurierbare Groesse)

**Technical Notes:**
- CDP Event: `Runtime.consoleAPICalled` — sammelt `log`, `warn`, `error`, `info`, `debug`
- Zusaetzlich `Runtime.exceptionThrown` fuer uncaught Exceptions
- Log-Buffer in `cdp/console-collector.ts`: Ring-Buffer mit Default-Groesse 1000
- Level-Mapping: `log` → "info", `warn` → "warning", `error` → "error", `debug` → "debug"
- Kategorien (FR39): `errors` = level error + exceptions, `warnings` = level warning, `network` = Logs mit URL-Pattern, `app` = Regex-Match
- Tool-Handler in `tools/console-logs.ts`
- **FRs:** FR37, FR39

### Story 7.2: Network-Monitor Tool (`network_monitor`)

As a **AI-Agent**,
I want Network-Requests der Seite inspizieren koennen,
So that ich API-Aufrufe, Ladezeiten und fehlgeschlagene Requests debuggen kann.

**Acceptance Criteria:**

**Given** der Agent ruft `network_monitor` mit `action: "start"` auf
**When** das Monitoring aktiviert wird
**Then** werden alle Network-Requests aufgezeichnet via CDP `Network.enable`
**And** die Response bestaetigt: `{ status: "monitoring", since: timestamp }`

**Given** das Monitoring laeuft und der Agent ruft `network_monitor` mit `action: "get"` auf
**When** Requests aufgezeichnet wurden
**Then** werden alle Requests zurueckgegeben: `[{ url, method, status, mimeType, size, duration, initiator }]` (FR38)
**And** die Response enthaelt `_meta` mit Timing und `count`

**Given** der Agent ruft `network_monitor` mit `action: "get"` und `filter: "failed"` auf
**When** fehlgeschlagene Requests gefiltert werden
**Then** werden nur Requests mit Status >= 400 oder `failed: true` (Netzwerkfehler) zurueckgegeben

**Given** der Agent ruft `network_monitor` mit `action: "get"` und `pattern: "api/v2"` auf
**When** nach URL-Pattern gefiltert wird
**Then** werden nur Requests deren URL dem Pattern entspricht zurueckgegeben

**Given** der Agent ruft `network_monitor` mit `action: "stop"` auf
**When** das Monitoring beendet wird
**Then** werden die gesammelten Requests zurueckgegeben und der Buffer geleert
**And** `Network.disable` wird aufgerufen um CDP-Overhead zu vermeiden

**Given** das Monitoring nicht gestartet wurde
**When** der Agent `network_monitor` mit `action: "get"` aufruft
**Then** gibt der Server `isError: true` mit `"Network-Monitoring nicht aktiv — starte mit action: 'start'"` zurueck

**Technical Notes:**
- CDP Events: `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFailed`, `Network.loadingFinished`
- Request-Korrelation ueber `requestId`: Request → Response → Finished/Failed zusammenfuehren
- Duration: `loadingFinished.timestamp - requestWillBeSent.timestamp`
- Buffer in `cdp/network-collector.ts`: Ring-Buffer Default 500 Requests
- Network.enable ist teuer — nur bei explizitem Start, nicht Default
- Tool-Handler in `tools/network-monitor.ts`
- **FRs:** FR38

### Story 7.3: Session-Defaults & Auto-Promote (`configure_session`)

As a **AI-Agent**,
I want Default-Werte fuer haeufig genutzte Parameter setzen koennen und der Server soll mir Defaults vorschlagen,
So that ich repetitive Parameter-Angaben spare und effizienter arbeite.

**Acceptance Criteria:**

**Given** der Agent ruft `configure_session` mit `{ defaults: { tab: "tab-abc123", timeout: 10000 } }` auf
**When** die Defaults gesetzt werden
**Then** werden nachfolgende Tool-Calls ohne expliziten `tab`-Parameter auf den Default-Tab angewendet (FR40)
**And** Tool-Calls ohne expliziten `timeout`-Parameter nutzen den Default-Timeout

**Given** der Agent ruft `configure_session` mit `{ defaults: { tab: null } }` auf
**When** ein Default entfernt wird
**Then** wird der Default geloescht und nachfolgende Calls nutzen wieder den Standard-Fallback

**Given** der Agent ruft `configure_session` ohne Parameter auf
**When** die aktuellen Defaults abgefragt werden
**Then** werden alle gesetzten Defaults zurueckgegeben: `{ defaults: { tab: "...", timeout: 10000 }, autoPromote: [...] }`

**Given** der Agent hat 3+ aufeinanderfolgende Tool-Calls mit identischem Parameter gemacht (z.B. `tab: "tab-xyz"`)
**When** der naechste Tool-Call ohne diesen Parameter erfolgt
**Then** enthaelt die Response einen Hinweis: `_meta: { suggestion: "Tab 'tab-xyz' wurde 4x verwendet — setze als Default mit configure_session" }` (FR41)

**Given** der Agent hat Auto-Promote-Vorschlaege erhalten
**When** er `configure_session` mit `{ autoPromote: true }` aufruft
**Then** werden alle aktuellen Vorschlaege automatisch als Defaults uebernommen

**Technical Notes:**
- Session-State in `cache/session-defaults.ts`: In-Memory Map, pro Server-Instanz
- Auto-Promote-Tracker: Zaehlt identische Parameter-Werte pro Tool ueber einen Sliding Window (letzte 10 Calls)
- Default-Resolution: Tool-Handler prueft erst expliziten Parameter, dann Session-Default, dann hardcoded Fallback
- Defaults ueberleben keinen Server-Restart (In-Memory)
- Tool-Handler in `tools/configure-session.ts`
- **FRs:** FR40, FR41

### Story 7.4: Precomputed A11y-Tree

As a **AI-Agent**,
I want dass der A11y-Tree im Hintergrund aktuell gehalten wird und bei Abfrage sofort verfuegbar ist,
So that `read_page` keine CDP-Latenz hat und ich den Seiteninhalt in Echtzeit lesen kann.

**Acceptance Criteria:**

**Given** der Agent hat eine Seite navigiert
**When** DOM-Mutationen auf der Seite stattfinden (z.B. AJAX-Updates, dynamische Inhalte)
**Then** wird der gecachte A11y-Tree automatisch im Hintergrund aktualisiert
**And** bestehende Ref-IDs bleiben stabil (NFR13) — nur neue Elemente bekommen neue Refs

**Given** der Agent ruft `read_page` auf
**When** der Precomputed A11y-Tree verfuegbar ist
**Then** wird der gecachte Tree sofort zurueckgegeben ohne CDP `Accessibility.getFullAXTree` Call
**And** die Response-Latenz liegt deutlich unter dem aktuellen Wert (Ziel: <10ms statt ~30ms)

**Given** eine Seite mit haeufigen DOM-Updates (z.B. Chat, Live-Dashboard)
**When** Updates schneller als alle 500ms eintreffen
**Then** werden Updates gedrosselt (Debounce 500ms) um CDP-Overhead zu vermeiden
**And** der letzte vollstaendige Tree-State ist immer konsistent

**Given** der Agent navigiert zu einer neuen Seite
**When** die Navigation abgeschlossen ist
**Then** wird der Precomputed-Cache invalidiert und ein frischer A11y-Tree im Hintergrund geladen
**And** Ref-IDs werden zurueckgesetzt (bestehendes Verhalten)

**Given** der Precomputed-Cache noch nicht geladen ist (z.B. direkt nach Navigation)
**When** der Agent `read_page` aufruft
**Then** wird synchron ein A11y-Tree abgefragt (Fallback auf aktuelles Verhalten)
**And** das Ergebnis wird als initialer Cache-Wert gespeichert

**Technical Notes:**
- CDP Event: `DOM.documentUpdated`, `DOM.childNodeCountUpdated`, `DOM.childNodeInserted`, `DOM.childNodeRemoved` als Trigger fuer Hintergrund-Refresh
- Debounce-Strategie: 500ms nach letzter DOM-Mutation → `Accessibility.getFullAXTree` im Hintergrund
- Cache in `cache/a11y-tree.ts` erweitern: neuer `precomputedTree`-State neben dem bestehenden Ref-Mapping
- Ref-Stabilitaet: Diff zwischen altem und neuem Tree, bestehende backendNodeIds behalten ihre Refs
- **FRs:** FR46

### Story 7.5: Selector-Caching mit DOM-Fingerprinting

As a **AI-Agent**,
I want dass haeufig genutzte Element-Selektoren gecacht werden und bei unveraendertem DOM wiederverwendet werden,
So that repetitive Workflows (Formulare, Dashboards, Monitoring) drastisch schneller werden — 80% weniger Tool-Calls.

**Acceptance Criteria:**

**Given** der Agent loest ein Element per Ref auf (z.B. click e5)
**When** die Ref-Aufloesung erfolgreich ist
**Then** wird der Selector zusammen mit einem DOM-Fingerprint gecacht: SHA256(url + dom_snapshot_hash + ref)

**Given** der Agent loest dasselbe Element erneut auf (gleiche URL, unveraenderter DOM)
**When** der Cache-Eintrag gefunden wird und der DOM-Fingerprint uebereinstimmt
**Then** wird der gecachte Selector direkt verwendet — kein A11y-Tree-Refresh noetig

**Given** die Seite aendert sich (Navigation, DOM-Mutation)
**When** der DOM-Fingerprint nicht mehr uebereinstimmt
**Then** wird der Cache-Eintrag invalidiert und die Ref normal aufgeloest (Self-Healing)

**Technical Notes:**
- Inspiriert von Stagehand (browserbase.com/blog/stagehand-caching): SHA256(method + normalized_url + dom_fingerprint + schema) → Selector-Reuse. Self-Healing bei DOM-Aenderung.
- DOM-Fingerprint: Hash ueber DOMSnapshot.captureSnapshot Node-Count + Structure. Nicht ueber den vollen Snapshot (zu langsam).
- Cache ist in-memory, pro Session. Kein Disk-Persistenz.
- **FRs:** FR62

### Story 7.6: Multi-Tab Parallel Control

As a **AI-Agent**,
I want mehrere Tabs gleichzeitig steuern koennen — parallele Aktionen auf verschiedenen Tabs,
So that ich Cross-Tab-Workflows ausfuehren kann (z.B. Preisvergleich, paralleles Monitoring, Multi-Account-Aktionen).

**Acceptance Criteria:**

**Given** der Agent ruft `run_plan` mit `{ parallel: [{ tab: "tab-a", steps: [...] }, { tab: "tab-b", steps: [...] }] }` auf
**When** der PlanExecutor die parallelen Gruppen verarbeitet
**Then** werden die Step-Gruppen gleichzeitig auf verschiedenen Tabs ausgefuehrt
**And** die Response enthaelt Ergebnisse pro Tab-Gruppe: `{ results: { "tab-a": [...], "tab-b": [...] } }`

**Given** parallele Tab-Gruppen laufen
**When** eine Gruppe fehlschlaegt
**Then** wird nur diese Gruppe abgebrochen (abhaengig von errorStrategy)
**And** die anderen Gruppen laufen weiter bis zur Fertigstellung

**Given** der Agent ruft parallele Tab-Operationen auf
**When** beide Tabs CDP-Sessions haben
**Then** werden CDP-Calls ueber separate Sessions geroutet (kein Blocking zwischen Tabs)
**And** jeder Tab behaelt seinen eigenen Cache-State

**Given** der Agent ruft parallele Operationen auf mehr als 5 Tabs auf
**When** das Concurrency-Limit erreicht wird
**Then** werden ueberzaehlige Tab-Gruppen gequeued und sequentiell nach Freiwerden eines Slots ausgefuehrt

**Technical Notes:**
- Baut auf Session-Multiplexing aus Story 5.3 (OOPIF) auf — separate CDP-Sessions pro Tab bereits vorhanden
- PlanExecutor erweitern: `parallel` als neuer Step-Typ neben sequentiellen Steps
- Concurrency-Limit konfigurierbar (Default: 5), Queue in `plan/plan-executor.ts`
- **Pro-Feature** (Phase 3) — Feature-Gate beachten
- **FRs:** FR45

---

## Epic 8: Operator Architecture & Human Touch (Phase 3) — DONE

Browser-Aktionen laufen ueber einen lokalen Operator ohne Haupt-LLM-Roundtrips, mit menschlichen Interaktionsmustern und optionalem Chrome-Profil.
**FRs:** FR47, FR48, FR49, FR50, FR51
**Status:** Alle Stories (8.1-8.5) vollstaendig definiert.

### Story 8.1: Rule-Engine & Operator Grundgeruest

As a **AI-Agent**,
I want dass ein lokaler Operator run_plan-Steps ueber eine regelbasierte Engine abarbeiten kann,
So that definierte Browser-Aktionen ohne Round-Trip zum Haupt-LLM ausgefuehrt werden und die Latenz drastisch sinkt.

**Acceptance Criteria:**

**Given** ein run_plan mit definierten Steps (click, type, navigate)
**When** der Operator die Steps abarbeitet
**Then** entscheidet die Rule-Engine lokal ueber die naechste Aktion: if element visible → click, if dialog → dismiss, if not found → scroll
**And** kein LLM-Roundtrip findet statt solange Regeln greifen

**Given** ein Step der ein Element per Ref anspricht
**When** das Element nicht sofort sichtbar ist
**Then** scrollt die Rule-Engine automatisch zum Element (max 3 Scroll-Versuche) bevor sie den Step als fehlgeschlagen meldet

**Given** ein unerwarteter Browser-Dialog (Alert, Confirm) waehrend der Step-Ausfuehrung
**When** die Rule-Engine eine passende Regel hat (z.B. dismiss)
**Then** wird der Dialog automatisch behandelt und der naechste Step ausgefuehrt

**Technical Notes:**
- Operator-Klasse in `src/operator/operator.ts`, Rule-Engine in `src/operator/rule-engine.ts`
- Regeln als deklaratives JSON-Format: `{ condition, action, priority }`
- Operator nutzt bestehende Tool-Handler (click, type, navigate) intern — kein Code-Duplikat
- **FRs:** FR47

### Story 8.2: Micro-LLM Integration

As a **AI-Agent**,
I want dass der Operator ein kleines lokales LLM fuer adaptive Mikro-Entscheidungen nutzen kann,
So that unvorhergesehene Seitenzustaende flexibel behandelt werden ohne auf den Hauptagenten warten zu muessen.

**Acceptance Criteria:**

**Given** ein Step bei dem keine Regel der Rule-Engine greift (z.B. unerwartetes Overlay, Cookie-Consent mit nicht-standardem Layout)
**When** der Operator das Micro-LLM aufruft
**Then** trifft das Micro-LLM eine Entscheidung basierend auf dem aktuellen A11y-Tree-Ausschnitt und dem Step-Kontext
**And** die Micro-LLM-Latenz liegt unter 500ms (lokale Inferenz)

**Given** der Operator einen alternativen Selektor braucht (Original-Ref nicht gefunden)
**When** das Micro-LLM den sichtbaren A11y-Tree analysiert
**Then** schlaegt es einen alternativen Selektor vor und der Operator fuehrt den Step damit aus

**Given** das Micro-LLM ist nicht verfuegbar (nicht installiert, Timeout)
**When** ein Step das Micro-LLM benoetigt haette
**Then** eskaliert der Operator direkt an den Captain (Story 8.3) statt zu blockieren

**Technical Notes:**
- Integration ueber `src/operator/micro-llm.ts` mit abstrahiertem Interface (Ollama, llama.cpp, oder HTTP-Endpoint)
- Prompt-Template: kompakter A11y-Ausschnitt (~500 Tokens) + Step-Beschreibung + 3 moegliche Aktionen
- Konfigurierbar: `microLlm.endpoint`, `microLlm.model`, `microLlm.timeoutMs`
- **FRs:** FR48

### Story 8.3: Captain Escalation Protocol

As a **AI-Agent (Captain)**,
I want dass der Operator bei Unsicherheit an mich eskaliert mit vollem Kontext,
So that ich fundierte Entscheidungen treffen kann und der Operator anschliessend weiterarbeitet.

**Acceptance Criteria:**

**Given** der Operator einen Step ausfuehrt und weder Rule-Engine noch Micro-LLM eine Entscheidung mit ausreichender Konfidenz treffen koennen (Score unter konfiguriertem Schwellwert, Default: 0.6)
**When** die Eskalation ausgeloest wird
**Then** pausiert der Operator den aktuellen Plan und sendet eine Eskalation an den Captain mit:
- Was versucht wurde (Step + bisherige Aktionen)
- Was schiefging (Fehlerbeschreibung, aktueller Seitenstatus)
- A11y-Tree-Ausschnitt der betroffenen Region
- Optional: Screenshot

**Given** der Captain eine Entscheidung zurueckgibt (z.B. alternativer Selektor, Skip, Retry mit Aenderung)
**When** der Operator die Antwort erhaelt
**Then** setzt er den Plan an der pausierten Stelle fort mit der Entscheidung des Captains
**And** die Eskalation wird im Plan-Result als `escalations[]` Array dokumentiert

**Given** der Captain nicht innerhalb des Timeouts antwortet
**When** das Eskalations-Timeout ablaeuft (Default: 30s)
**Then** bricht der Operator den aktuellen Step ab und gibt Teilergebnisse zurueck (analog zu FR30)

**Technical Notes:**
- Eskalation ueber MCP Suspend/Resume Pattern (aufbauend auf FR36 aus Epic 6)
- Konfidenz-Scoring: Rule-Engine = 1.0 (deterministisch), Micro-LLM = Score aus LLM-Response, kein Match = 0.0
- **FRs:** FR49

### Story 8.4: Chrome Profile Support

As a **AI-Agent-Entwickler**,
I want optional ein echtes Chrome-Profil nutzen koennen,
So that gespeicherte Passwoerter, Sessions und Cookies fuer Automatisierungsaufgaben verfuegbar sind.

**Acceptance Criteria:**

**Given** die Server-Konfiguration `chromeProfile.enabled: true` und `chromeProfile.path` gesetzt
**When** der Server Chrome startet (Auto-Launch)
**Then** wird Chrome mit `--user-data-dir=<chromeProfile.path>` gestartet statt mit dem Default-Profil
**And** alle Passwoerter, Sessions und Cookies aus dem Profil sind verfuegbar

**Given** die Default-Konfiguration (kein `chromeProfile` gesetzt)
**When** der Server Chrome startet
**Then** wird das isolierte Temp-Profil verwendet (`/tmp/silbercuechrome-profile`)
**And** keine persoenlichen Daten sind zugaenglich

**Given** `chromeProfile.enabled: true` ist gesetzt
**When** der Server eine bestehende Chrome-Instanz findet (WebSocket auf 9222)
**Then** verbindet er sich ohne das Profil zu aendern
**And** loggt eine Warnung wenn das erkannte Profil nicht dem konfigurierten entspricht

**Technical Notes:**
- Konfiguration in der MCP-Client-Config (z.B. `claude_desktop_config.json`) unter `env` oder `args`
- Sicherheits-Guardrail: Chrome-Profil ist NIEMALS Default — explizites Opt-in erforderlich
- Dokumentation mit Sicherheitshinweisen: Profil-Zugriff bedeutet Zugriff auf gespeicherte Passwoerter
- **FRs:** FR50

### Story 8.5: Human Touch Patterns

As a **AI-Agent**,
I want dass Browser-Interaktionen menschliche Muster simulieren koennen,
So that Automatisierung natuerlicher wirkt und Anti-Bot-Detection reduziert wird.

**Acceptance Criteria:**

**Given** `humanTouch.enabled: true` in der Konfiguration
**When** der Agent einen Klick ausfuehrt
**Then** wird die Maus mit einer randomisierten Bezier-Kurve zum Zielelement bewegt (Dauer: 50-200ms, normalverteilt)
**And** ein kurzes zufaelliges Delay (10-50ms) vor dem eigentlichen mousedown/mouseup Event eingefuegt

**Given** `humanTouch.enabled: true` in der Konfiguration
**When** der Agent Text tippt
**Then** werden Zeichen einzeln mit variabler Geschwindigkeit gesendet (80-180ms pro Zeichen, normalverteilt)
**And** gelegentliche Mikro-Pausen (200-500ms) zwischen Wortgruppen eingefuegt

**Given** `humanTouch.enabled: false` oder nicht gesetzt (Default)
**When** der Agent klickt oder tippt
**Then** werden Events sofort dispatched wie bisher (keine kuenstlichen Verzoegerungen)

**Given** `humanTouch.speedProfile` ist gesetzt ("slow", "normal", "fast")
**When** Interaktionen ausgefuehrt werden
**Then** werden die Timing-Parameter entsprechend skaliert:
- "slow": 150-300ms Maus, 120-250ms Tippen
- "normal": 50-200ms Maus, 80-180ms Tippen (Default bei enabled)
- "fast": 20-80ms Maus, 40-100ms Tippen

**Technical Notes:**
- Implementierung in `src/operator/human-touch.ts`
- Bezier-Kurven: 3-Punkt kubisch, Start/End + 1-2 randomisierte Kontrollpunkte
- Mausbewegung ueber `Input.dispatchMouseEvent` mit type "mouseMoved" in 10-20 Zwischenschritten
- Tippgeschwindigkeit pro Zeichen via `Input.dispatchKeyEvent` mit setTimeout zwischen Zeichen
- Konfigurierbar unabhaengig vom Operator (kann auch direkt mit click/type Tools genutzt werden)
- **FRs:** FR51

---

## Epic 9: Monetarisierung & Publish-Pipeline (MVP-Infrastruktur)

Der Entwickler kann das Projekt als Free/Pro-Dual-Repo veroeffentlichen — mit License-Key-Validierung, Free-Tier-Limits, Dual-Repo-Trennung und reproduzierbarer Publish-Pipeline.
**FRs:** FR63, FR64, FR65, FR66, FR67, FR68, FR69, FR70, FR31, FR25-FR27, FR51

### Story 9.1: Free-Tier Step-Limit fuer run_plan

As a **AI-Agent-Entwickler**,
I want dass run_plan im Free-Tier ein konfigurierbares Step-Limit hat,
So that das Free-Tier nutzbar bleibt aber ein klarer Upgrade-Anreiz fuer Pro besteht.

**Acceptance Criteria:**

**Given** der Server im Free-Tier-Modus laeuft (kein License-Key oder ungueltiger Key)
**When** der Agent `run_plan` mit mehr als 3 Steps aufruft
**Then** werden nur die ersten 3 Steps ausgefuehrt
**And** die Response enthaelt das Teilergebnis der ausgefuehrten Steps
**And** `_meta: { truncated: true, limit: 3, total: N }` signalisiert die Begrenzung — keine Fehlermeldung

**Given** der Server im Pro-Modus laeuft (gueltiger License-Key)
**When** der Agent `run_plan` mit beliebig vielen Steps aufruft
**Then** werden alle Steps ausgefuehrt (kein Limit)

**Given** die Step-Limit-Konfiguration `freeTier.runPlanLimit: 5` gesetzt ist
**When** der Agent `run_plan` im Free-Tier mit 8 Steps aufruft
**Then** werden die ersten 5 Steps ausgefuehrt (konfigurierbares Limit)

**Technical Notes:**
- Feature-Gate in `plan/plan-executor.ts`: Prueft License-Status vor Ausfuehrung
- Konfigurierbar via Server-Config (Default: 3)
- Kein separater Code-Pfad — der gleiche PlanExecutor, nur mit Limit-Check am Anfang
- **FRs:** FR63

### Story 9.2: License-Key Validierung & Aktivierung

As a **AI-Agent-Entwickler**,
I want beim Server-Start einen License-Key validieren koennen der Pro-Features freischaltet,
So that zahlende Nutzer Zugang zu erweiterten Features bekommen.

**Acceptance Criteria:**

**Given** die Umgebungsvariable `SILBERCUECHROME_LICENSE_KEY` gesetzt ist
**When** der Server startet
**Then** validiert er den Key gegen einen Remote-Endpoint
**And** bei gueltigem Key werden Pro-Features aktiviert
**And** der Validierungsstatus wird lokal gecacht (Dateisystem)

**Given** der License-Key gueltig ist aber keine Netzwerkverbindung besteht
**When** der Server startet
**Then** wird die lokal gecachte Validierung verwendet (Fallback)
**And** Pro-Features bleiben aktiv

**Given** kein License-Key gesetzt ist
**When** der Server startet
**Then** laeuft der Server im Free-Tier-Modus
**And** alle Basis-Features sind verfuegbar, Pro-Features sind limitiert/deaktiviert

**Given** ein ungueltiger License-Key gesetzt ist
**When** der Server startet
**Then** laeuft der Server im Free-Tier-Modus
**And** eine Warnung wird im Debug-Log ausgegeben (nicht auf stderr — kein Alarm fuer den Agent)

**Technical Notes:**
- License-Modul in `src/license/license-validator.ts`
- Remote-Validation: HTTPS POST an Lizenz-Server (Endpoint konfigurierbar)
- Lokaler Cache: `~/.silbercuechrome/license-cache.json` mit Timestamp
- Pro-Feature-Gate: `license.isPro()` — boolscher Check, kein if/else im Tool-Code
- **FRs:** FR64

### Story 9.3: Offline Grace-Period (7 Tage)

As a **AI-Agent-Entwickler**,
I want dass Pro-Features auch ohne Netzwerk verfuegbar bleiben solange der letzte Check weniger als 7 Tage zurueckliegt,
So that Offline-Nutzung und instabile Netzwerke kein Problem sind.

**Acceptance Criteria:**

**Given** der letzte erfolgreiche Lizenz-Check liegt weniger als 7 Tage zurueck
**When** der Server ohne Netzwerk startet
**Then** bleiben Pro-Features aktiv basierend auf dem gecachten Status

**Given** der letzte erfolgreiche Lizenz-Check liegt mehr als 7 Tage zurueck
**When** der Server ohne Netzwerk startet
**Then** faellt der Server auf Free-Tier zurueck
**And** eine Warnung wird geloggt: "License-Check abgelaufen — Pro-Features deaktiviert bis zur naechsten Online-Validierung"

**Given** der Server ist online und der gecachte Check ist aelter als 24 Stunden
**When** der Server startet
**Then** wird automatisch ein neuer Remote-Check durchgefuehrt und der Cache aktualisiert

**Technical Notes:**
- Grace-Period-Logik in `src/license/license-validator.ts`
- Cache-Datei enthaelt: `{ key, validUntil, lastCheck, features: [] }`
- 7-Tage-Window = 604800000ms seit `lastCheck`
- Re-Check-Intervall: 24h bei Server-Start (nicht waehrend der Laufzeit)
- **FRs:** FR65

### Story 9.4: CLI-Kommandos fuer Lizenzverwaltung

As a **AI-Agent-Entwickler**,
I want Lizenz-Status pruefen und Keys aktivieren/deaktivieren koennen ueber CLI-Kommandos,
So that ich die Lizenz einfach verwalten kann ohne Konfigurationsdateien manuell zu bearbeiten.

**Acceptance Criteria:**

**Given** der Entwickler fuehrt `silbercuechrome license status` aus
**When** der Befehl ausgefuehrt wird
**Then** wird der aktuelle Lizenz-Status angezeigt: Tier (Free/Pro), Key (maskiert), letzter Check, Ablaufdatum, aktive Features

**Given** der Entwickler fuehrt `silbercuechrome license activate <key>` aus
**When** der Key validiert wird
**Then** wird der Key lokal gespeichert und Pro-Features aktiviert
**And** eine Erfolgsmeldung wird angezeigt

**Given** der Entwickler fuehrt `silbercuechrome license deactivate` aus
**When** der Befehl ausgefuehrt wird
**Then** wird der lokal gespeicherte Key entfernt
**And** der Server faellt auf Free-Tier zurueck

**Given** der Entwickler fuehrt `silbercuechrome license activate <invalid-key>` aus
**When** die Validierung fehlschlaegt
**Then** wird eine verstaendliche Fehlermeldung angezeigt (kein Stack-Trace)

**Technical Notes:**
- CLI-Subcommands in `src/cli/license-commands.ts`
- Key-Storage: `~/.silbercuechrome/license-cache.json`
- Maskierung: Nur erste/letzte 4 Zeichen sichtbar — `sk-1234...abcd`
- `silbercuechrome` Haupteintrag in `package.json` → `bin` Feld
- **FRs:** FR66

### Story 9.5: Dual-Repo Code-Trennung

As a **Entwickler (Julian)**,
I want dass das oeffentliche Repository nur Free-Tier-Code enthaelt und Pro-Features ausschliesslich im privaten Repo liegen,
So that Pro-Features nicht im Open-Source-Code einsehbar sind.

**Acceptance Criteria:**

**Given** das oeffentliche Repository `silbercuechrome`
**When** der Quellcode inspiziert wird
**Then** enthaelt es nur Free-Tier-Funktionalitaet
**And** Pro-Feature-Hooks sind als erweiterbare Interfaces definiert (nicht als leere Stubs)

**Given** das private Repository `silbercuechrome-pro`
**When** der Pro-Build erstellt wird
**Then** werden Pro-Features als Erweiterungen registriert die sich in die Hooks einklinken
**And** der Pro-Build importiert den Free-Tier-Code als Dependency

**Given** ein neues Pro-Feature wird entwickelt
**When** es im privaten Repo implementiert wird
**Then** registriert es sich ueber das Hook-System — kein Patching des Free-Tier-Codes noetig

**Technical Notes:**
- Hook-Interface in `src/hooks/pro-hooks.ts` (oeffentliches Repo): definiert Erweiterungspunkte
- Pro-Repo registriert Implementierungen zur Laufzeit
- Build-Prozess: Pro-Repo hat eigene `tsconfig.json` die Free-Tier als Path-Reference einbindet
- Analog zu SilbercueSwift Dual-Repo-Muster
- **FRs:** FR67

### Story 9.6: dom_snapshot Pro-Feature-Gate

As a **AI-Agent**,
I want dass `dom_snapshot` als Pro-Feature nur bei gueltigem License-Key verfuegbar ist,
So that es einen klaren Mehrwert fuer Pro-Nutzer gibt.

**Acceptance Criteria:**

**Given** der Server im Pro-Modus laeuft
**When** der Agent `dom_snapshot` aufruft
**Then** wird der volle DOMSnapshot mit visuellen Daten zurueckgegeben (FR68 — Positionen, Farben, Z-Order)

**Given** der Server im Free-Tier-Modus laeuft
**When** der Agent `dom_snapshot` aufruft
**Then** gibt der Server `isError: true` mit `"dom_snapshot ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'"` zurueck

**Given** der Server im Free-Tier-Modus laeuft
**When** der Agent die verfuegbaren Tools abfragt (tools/list)
**Then** wird `dom_snapshot` in der Tool-Liste mit `{ pro: true }` markiert aber weiterhin aufgefuehrt

**Technical Notes:**
- Feature-Gate im Tool-Handler: `if (!license.isPro()) return proFeatureError("dom_snapshot")`
- Einheitliche Pro-Error-Response ueber Helper-Funktion — konsistente Messaging
- dom_snapshot bleibt in Tool-Liste sichtbar (Discoverability fuer Upgrade-Anreiz)
- **FRs:** FR68

### Story 9.7: Publish-Pipeline (Dual-Repo Release)

As a **Entwickler (Julian)**,
I want einen reproduzierbaren Publish-Workflow der aus beiden Repos ein Release erstellt,
So that ich Releases zuverlaessig und konsistent veroeffentlichen kann.

**Acceptance Criteria:**

**Given** der Entwickler fuehrt den Publish-Workflow aus
**When** beide Repos (free + pro) auf dem gleichen Version-Tag stehen
**Then** wird ein Release erstellt mit:
- npm-Package (Free-Tier) auf npm publiziert
- Combined Binary (Free + Pro) als GitHub Release Asset
- Git-Tag auf beiden Repos gesetzt

**Given** die Repos nicht synchron sind (unterschiedliche Versionsnummern)
**When** der Publish-Workflow gestartet wird
**Then** bricht er ab mit verstaendlicher Fehlermeldung: "Version mismatch: free=1.2.3, pro=1.2.4"

**Given** der Publish-Workflow laeuft
**When** ein Schritt fehlschlaegt (z.B. npm publish)
**Then** werden bereits erstellte Artefakte nicht aufgeraeumt (idempotenter Re-Run moeglich)
**And** der Fehler wird klar gemeldet mit Hinweis welcher Schritt fehlschlug

**Given** der Entwickler den Workflow wiederholt (z.B. nach npm-Fehler)
**When** der Tag bereits existiert
**Then** wird der bestehende Tag/Release aktualisiert statt einen Fehler zu werfen

**Technical Notes:**
- Publish-Script in `scripts/publish.ts` oder als GitHub Action
- Analog zum SilbercueSwift Publish-Skill — gleiche Muster (Tag, Binary, Homebrew-Update)
- Versionsnummer aus `package.json` — Single Source of Truth
- npm publish mit `--access public` fuer das Free-Tier-Package
- **FRs:** FR69

### Story 9.8: License Validation — Direkte Polar.sh API-Integration

As a **AI-Agent-Entwickler**,
I want dass License-Keys direkt gegen die Polar.sh Public API validiert werden,
So that die client-seitige License-Validierung (Story 9.2) funktioniert — ohne eigenen Server.

**Acceptance Criteria:**

**Given** ein gueltiger Polar.sh License-Key
**When** der MCP-Server startet
**Then** meldet LicenseValidator "License validated (Pro)"

**Given** ein ungueltiger Key
**When** der MCP-Server startet
**Then** laeuft der Server im Free-Tier

**Given** kein Netzwerk und der letzte Check < 7 Tage alt
**When** der MCP-Server startet
**Then** bleibt Pro aktiv (Grace-Period, Story 9.3)

**Technical Notes:**
- Direkt Polar.sh Public API: POST `/v1/customer-portal/license-keys/validate` mit `{ key, organization_id }`
- Organization-ID oeffentlich im Code (wie SilbercueSwift) — kein API-Key noetig
- Polar-Response `status === "granted"` → `valid: true`
- Kein eigener Server, kein Cloudflare Worker, kein DNS-Eintrag
- **FRs:** FR70

### Story 9.9: Pro-Feature-Gates fuer switch_tab, virtual_desk und Human Touch

As a **AI-Agent-Entwickler**,
I want dass `switch_tab`, `virtual_desk` und Human-Touch-Mode nur bei gueltigem Pro-License-Key verfuegbar sind,
So that die Free/Pro-Grenze dem PRD entspricht und Pro-Nutzer spuerbaren Mehrwert bekommen.

**Kontext (Benchmark-Erkenntnis 2026-04-05):**
Die Benchmark-Analyse zeigt: Free und Pro sind funktional identisch — gleiche Geschwindigkeit (20s vs 21s), gleiche Pass-Rate (24/24), gleiche Tool-Calls (134). Laut PRD (Zeile 351-352) sollen `switch_tab` und `virtual_desk` Pro-only sein, aber die Feature-Gates wurden nie implementiert. Story 9.6 deckt nur `dom_snapshot` ab. Diese Story schliesst die Luecke.

**Acceptance Criteria:**

**Given** der Server im Free-Tier-Modus laeuft
**When** der Agent `switch_tab` aufruft
**Then** gibt der Server `isError: true` mit `"switch_tab ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'"` zurueck

**Given** der Server im Free-Tier-Modus laeuft
**When** der Agent `virtual_desk` aufruft
**Then** gibt der Server `isError: true` mit der gleichen Pro-Feature-Meldung zurueck

**Given** der Server im Free-Tier-Modus laeuft
**When** der Agent `type` oder `click` mit `humanTouch` config aufruft
**Then** wird Human Touch ignoriert und das Tool verhaelt sich wie ohne Human Touch (kein Error, nur Downgrade)

**Given** der Server im Pro-Modus laeuft
**When** der Agent `switch_tab`, `virtual_desk` oder Human Touch nutzt
**Then** funktionieren alle Features ohne Einschraenkung

**Given** der Server im Free-Tier-Modus laeuft
**When** der Agent die verfuegbaren Tools abfragt (tools/list)
**Then** werden `switch_tab` und `virtual_desk` mit `{ pro: true }` markiert aber weiterhin aufgefuehrt (Discoverability)

**Technical Notes:**
- Gleiches Pattern wie Story 9.6: `featureGate` Callback in `registry.ts`
- `switch_tab` und `virtual_desk` zum `featureGate`-Check hinzufuegen (neben `dom_snapshot`)
- Human Touch: In `configure_session` Handler pruefen — wenn `humanTouch.enabled` gesetzt wird aber `!isPro()`, dann `humanTouch.enabled = false` setzen (stilles Downgrade, kein Error)
- PRD-Referenz: Zeile 351-352 (switch_tab = Pro, virtual_desk = Pro)
- **FRs:** FR31 (switch_tab), FR25-FR27 (virtual_desk), FR51 (Human Touch)
- **Abhaengigkeiten:** Story 9.2 (License-Validierung), Story 9.6 (bestehendes Gate-Pattern)

---

## Epic 10: Pre-Launch Stabilisierung (Phase 2)

Offene Tech-Debt beseitigen, fehlschlagende Tests fixen, Smoke-Test und Benchmark-Runner stabilisieren — saubere Basis bevor neue Features kommen.
**FRs:** Keine neuen FRs — Stabilisierung bestehender Implementierung
**NFRs:** NFR9, NFR24
**Abhaengigkeit:** Keine — erste Phase-2-Arbeit

### Story 10.1: Fix fehlschlagender Test (license-commands.test.ts)

As a **Entwickler (Julian)**,
I want dass alle Unit-Tests gruen sind,
So that die Test-Suite als zuverlaessiges Quality-Gate funktioniert.

**Acceptance Criteria:**

**Given** die aktuelle Test-Suite (`npm test`)
**When** alle Tests ausgefuehrt werden
**Then** bestehen alle Tests inklusive `license-commands.test.ts` ohne Fehler

**Given** der fehlschlagende Test in `license-commands.test.ts`
**When** die Root-Cause analysiert wird
**Then** wird der Test repariert (nicht geloescht oder geskippt)
**And** der Fix adressiert die tatsaechliche Ursache, nicht das Symptom

**Technical Notes:**
- Test-Datei: `src/cli/license-commands.test.ts` oder `src/license/__tests__/`
- Zuerst `npm test -- --reporter=verbose` ausfuehren um den genauen Fehler zu sehen
- Haeufige Ursachen: Mock-Setup veraltet nach Story 9.2/9.3 Aenderungen, fehlende env-Variablen
- **NFRs:** NFR9

### Story 10.2: TD-001 AutoLaunch-Verhalten Tests & Dokumentation

As a **Entwickler (Julian)**,
I want dass das AutoLaunch-Verhalten mit Tests abgesichert und dokumentiert ist,
So that Aenderungen am Chrome-Start-Verhalten nicht unbemerkt Breaking Changes einfuehren.

**Acceptance Criteria:**

**Given** Chrome laeuft bereits mit `--remote-debugging-port=9222`
**When** der MCP-Server startet
**Then** verbindet er sich per WebSocket zum laufenden Chrome (kein zweiter Chrome-Start)

**Given** kein Chrome laeuft
**When** der MCP-Server startet und `autoLaunch` nicht explizit deaktiviert ist
**Then** startet er Chrome mit `--remote-debugging-pipe` als Child-Prozess
**And** die Verbindung erfolgt per CDP-Pipe (FD3/FD4)

**Given** kein Chrome laeuft und `autoLaunch: false` konfiguriert ist
**When** der MCP-Server startet
**Then** meldet er einen Verbindungsfehler (kein Auto-Launch)

**Given** die AutoLaunch-Tests existieren
**When** `npm test` laeuft
**Then** bestehen mindestens 3 Tests: WebSocket-Fallback, Pipe-Launch, autoLaunch-disabled

**Technical Notes:**
- Relevante Dateien: `src/transport/`, `src/cdp/chrome-launcher.ts`
- Tests muessen Chrome-Start mocken (kein echter Chrome in Unit-Tests)
- README-Sektion "Connection Modes" dokumentiert das Verhalten
- **Abhaengigkeit:** Keine

### Story 10.3: Smoke-Test env-Fix (StdioClientTransport)

As a **Entwickler (Julian)**,
I want dass der Smoke-Test (`node test-hardest/smoke-test.mjs`) zuverlaessig laeuft,
So that ein schneller End-to-End-Check nach Aenderungen moeglich ist.

**Acceptance Criteria:**

**Given** Chrome laeuft mit Remote Debugging auf Port 9222
**When** `node test-hardest/smoke-test.mjs` ausgefuehrt wird
**Then** startet der MCP-Server als Child-Prozess, fuehrt 10 Tests aus und beendet sich sauber

**Given** der Smoke-Test-Prozess
**When** der MCP-Server als Child-Prozess gestartet wird
**Then** werden relevante Umgebungsvariablen (PATH, HOME, CHROME_FLAGS) an den Child-Prozess weitergegeben
**And** der StdioClientTransport verbindet sich fehlerfrei

**Given** ein Test fehlschlaegt
**When** die Ergebnisse angezeigt werden
**Then** zeigt der Output den Testnamen, die erwartete vs. tatsaechliche Antwort, und die verstrichene Zeit

**Technical Notes:**
- Datei: `test-hardest/smoke-test.mjs`
- Problem: `StdioClientTransport` gibt aktuell keine env-Variablen an den Child-Prozess weiter
- Fix: `env: { ...process.env }` im Transport-Options-Objekt
- 10 deterministische Tests (kein LLM, nur MCP-Tool-Calls)
- **Abhaengigkeit:** Keine

### Story 10.4: Benchmark-Runner finalisieren (npm run benchmark)

As a **Entwickler (Julian)**,
I want dass `npm run benchmark` alle Tests automatisiert ausfuehrt und Ergebnisse als JSON exportiert,
So that Benchmark-Vergleiche reproduzierbar und automatisierbar sind.

**Acceptance Criteria:**

**Given** Chrome laeuft und die Benchmark-Seite auf `localhost:4242` erreichbar ist
**When** `npm run benchmark` ausgefuehrt wird
**Then** werden alle Tests der Benchmark-Suite ausgefuehrt (aktuell 24, spaeter 30+)
**And** die Ergebnisse werden als JSON-Datei exportiert nach `test-hardest/benchmark-silbercuechrome_mcp-llm-{datum}.json`

**Given** die JSON-Ergebnisdatei
**When** sie geoeffnet wird
**Then** enthaelt sie pro Test: Name, Level, Pass/Fail, Dauer in ms, Anzahl Tool-Calls
**And** eine Summary mit: total_passed, total_failed, total_time_ms, total_tool_calls

**Given** ein Test fehlschlaegt
**When** der Benchmark-Runner weiterlaeuft
**Then** wird der Fehler protokolliert aber die restlichen Tests werden trotzdem ausgefuehrt (kein Abbruch)

**Technical Notes:**
- Bestehende Datei: `test-hardest/benchmark-full.mjs` — muss finalisiert werden
- `package.json` Script: `"benchmark": "node test-hardest/benchmark-full.mjs"` hinzufuegen
- Startet MCP-Server intern (wie smoke-test.mjs)
- JSON-Export-Format kompatibel mit bestehenden `benchmark-*.json` Dateien
- **FRs:** FR80
- **Abhaengigkeit:** Story 10.3 (env-Fix im StdioClientTransport)

### Story 10.5: PRD-Addendum validieren

As a **Entwickler (Julian)**,
I want dass die PRD-Aenderungen (FR71-FR80, NFR25, Pro/Free-Korrektur) korrekt eingefuegt sind,
So that alle Downstream-Artefakte konsistent referenzieren koennen.

**Acceptance Criteria:**

**Given** die aktualisierte PRD
**When** die Functional Requirements gezaehlt werden
**Then** existieren FR1-FR80 (80 FRs) ohne Luecken und ohne Nummern-Kollisionen

**Given** die aktualisierte PRD
**When** die Non-Functional Requirements gezaehlt werden
**Then** existieren NFR1-NFR25 (25 NFRs) ohne Luecken

**Given** die Pro/Free-Abgrenzung in der PRD
**When** die Tool-Zaehlung geprueft wird
**Then** steht "15 Tools" fuer den Free-Tier (nicht "8+1")
**And** das run_plan Step-Limit ist "default 5" (nicht "default 3")

**Given** die Phasen-Zuordnung in der PRD
**When** die Phase-2-FRs geprueft werden
**Then** sind FR71-FR80 als "Phase 2 Community-Validation" zugeordnet

**Technical Notes:**
- Manueller Review-Schritt — kein Code
- Prueft Konsistenz zwischen PRD, Epics und Sprint-Status
- **Abhaengigkeit:** PRD-Edit muss abgeschlossen sein (bereits erledigt)

### Story 10.6: BUG-013/014 Fixes + Click-Description (LLM-Roundtrip-Bugs)

As a **AI-Agent (LLM)**,
I want dass Fehlermeldungen mich nicht in die Irre fuehren und unnoetige Validierungsfehler mich nicht ausbremsen,
So that ich mit weniger Roundtrips zum Ziel komme.

**Acceptance Criteria:**

**Given** ein Ref e96 ist stale (DOM hat sich seit read_page geaendert)
**When** `click(ref: "e96")` fehlschlaegt und der "Did you mean"-Vorschlag generiert wird
**Then** schlaegt die Fehlermeldung NICHT denselben Ref e96 vor
**And** stattdessen: "Element e96 is stale — the page has re-rendered since read_page was called. Run read_page again to get fresh refs."

**Given** `read_page(max_tokens: 300)` aufgerufen wird (unter Minimum 500)
**When** die Validierung greift
**Then** wird der Wert still auf 500 geclampt (kein Error, kein verschwendeter Roundtrip)
**And** `_meta` enthaelt den effektiv angewandten Wert

**Given** die click-Tool-Definition
**When** ein LLM die verfuegbaren Tools liest
**Then** steht in der Description explizit, dass nur Standard-CSS-Selektoren unterstuetzt werden (kein Playwright :has-text() etc.)
**And** der selector-Parameter-Description empfiehlt ref aus read_page

**Technical Notes:**
- BUG-013: `src/tools/element-utils.ts` Zeile 159-169 — `buildRefNotFoundError()` pruefen ob `suggestion.ref === ref`
- BUG-014: `src/tools/read-page.ts` Zeile 16 — `z.number().int().min(500)` → `.transform(v => Math.max(v, 500))`
- Click-Description: `src/registry.ts` click-Registrierung + `src/tools/click.ts` selector-Parameter
- Dokumentiert in `docs/deferred-work.md` als BUG-013, BUG-014, UX-Punkt 4
- **Abhaengigkeit:** Keine

---

## Epic 11: Benchmark-Suite v2 — Community Pain Points (Phase 2)

Die Benchmark-Suite beweist wo SilbercueChrome die Konkurrenz schlaegt — mit Tests fuer die 7 meistgewuenschten Community-Features plus automatisiertem Benchmark-Runner.
**FRs:** FR71, FR72, FR73, FR74, FR75, FR76, FR77, FR80
**NFRs:** NFR29
**Abhaengigkeit:** Epic 10 (saubere Basis, funktionierender Benchmark-Runner)

### Story 11.1: Level-5-Infrastruktur in Benchmark-Seite

As a **Entwickler (Julian)**,
I want eine neue "Level 5: Community Pain Points" Section in der Benchmark-Seite,
So that die neuen Tests eine strukturierte Heimat in der bestehenden Benchmark-Suite haben.

**Acceptance Criteria:**

**Given** die Benchmark-Seite (`test-hardest/index.html`)
**When** sie im Browser geoeffnet wird
**Then** zeigt sie Level 5 "Community Pain Points" als neue Section unter Level 4

**Given** Level 5
**When** Tests registriert werden
**Then** nutzen sie die bestehende `Benchmark.setResult()` API
**And** die Ergebnisse erscheinen im Results-Tab und im JSON-Export

**Given** die Test-IDs
**When** neue Tests hinzugefuegt werden
**Then** folgen sie dem Pattern `T5.1`, `T5.2`, etc. (konsistent mit T1.x-T4.x)

**Technical Notes:**
- Datei: `test-hardest/index.html`
- Neuen Level-5-Block unter `const Tests = { ... }` hinzufuegen
- HTML-Section fuer Level 5 im DOM ergaenzen
- Benchmark-API (setResult, getResults) bleibt unveraendert
- **Abhaengigkeit:** Keine

### Story 11.2: T5.1 Session Persistence Test

As a **Benchmark-Suite**,
I want einen Test der beweist dass Cookie/localStorage-Werte Chrome-Neustarts ueberleben,
So that Session Persistence als Wettbewerbsvorteil belegbar ist.

**Acceptance Criteria:**

**Given** die Benchmark-Seite ist geladen
**When** der Test T5.1 ausgefuehrt wird
**Then** setzt er per `evaluate` einen Cookie und einen localStorage-Eintrag
**And** liest beide Werte zurueck und verifiziert sie

**Given** Chrome wurde mit einem bestehenden User-Profil gestartet (nicht `--incognito`)
**When** der Test die Werte prueft
**Then** sind zuvor gesetzte Werte noch vorhanden (Session Persistence)

**Given** ein Konkurrent der Chrome mit `--incognito` oder frischem Profil startet
**When** der Test dort laeuft
**Then** findet er keine zuvor gesetzten Werte (Session-Verlust — Konkurrent scheitert)

**Technical Notes:**
- Testlogik: `evaluate` → `document.cookie = "sc_test=1; path=/; max-age=86400"` + `localStorage.setItem("sc_test", "1")` → readback
- Der Test prueft Existenz, nicht Persistenz ueber Neustart (das ist ein Setup-Thema, kein Tool-Thema)
- Deterministic: Kein LLM noetig, reine evaluate-Calls
- **FRs:** FR71

### Story 11.3: T5.2 CDP-Fingerprint-Detection Test

As a **Benchmark-Suite**,
I want einen Test der CDP-Detection-Flags prueft,
So that sichtbar wird ob SilbercueChrome (mit Human Touch) Anti-Bot-Detection besteht.

**Acceptance Criteria:**

**Given** die Benchmark-Seite ist geladen
**When** der Test T5.2 ausgefuehrt wird
**Then** prueft er per `evaluate` folgende Detection-Flags:
- `navigator.webdriver` (sollte `false` oder `undefined` sein)
- `window.chrome.cdc_adoQpoasnfa76pfcZLmcfl_Array` (Chrome-DevTools-Control-Flag)
- `document.querySelector("cdc_adoQpoasnfa76pfcZLmcfl_")` (DOM-Injection)

**Given** SilbercueChrome laeuft mit Human Touch (Pro)
**When** alle Detection-Flags geprueft werden
**Then** sind alle Flags unauffaellig (kein CDP-Fingerprint sichtbar)

**Given** SilbercueChrome laeuft ohne Human Touch (Free)
**When** die Detection-Flags geprueft werden
**Then** wird das Ergebnis als "partial pass" gemeldet mit Hinweis welche Flags exponiert sind

**Technical Notes:**
- Pure JS-Checks via `evaluate` — kein externer Service
- Human Touch muss `navigator.webdriver` via CDP `Page.addScriptToEvaluateOnNewDocument` ueberschreiben
- Nicht deterministisch testbar ob Anti-Bot-Dienste (Cloudflare, etc.) tatsaechlich durchlassen — Test prueft nur lokale Flags
- **FRs:** FR72

### Story 11.4: T5.3 Console-Log-Capture Test

As a **Benchmark-Suite**,
I want einen Test der beweist dass Console-Logs ueber das `console_logs` Tool erfassbar sind,
So that Console-Log-Monitoring als Feature belegbar ist.

**Acceptance Criteria:**

**Given** die Benchmark-Seite ist geladen
**When** der Test T5.3 ausgefuehrt wird
**Then** fuehrt er per `evaluate` ein `console.log("SC_BENCHMARK_LOG_TEST")` aus
**And** ruft dann `console_logs` auf
**And** verifiziert dass der Log-Eintrag "SC_BENCHMARK_LOG_TEST" in den Ergebnissen enthaelt

**Given** mehrere Console-Logs mit verschiedenen Levels (log, warn, error)
**When** `console_logs` mit Pattern-Filter aufgerufen wird
**Then** werden nur die passenden Eintraege zurueckgegeben

**Technical Notes:**
- Zweistufiger Test: 1) evaluate → console.log, 2) console_logs → verify
- Console-Log-Erfassung muss vor dem evaluate aktiviert sein (via `Runtime.enable` oder `Log.enable` im CDP)
- **FRs:** FR75

### Story 11.5: T5.4 File-Upload Test

As a **Benchmark-Suite**,
I want einen Test der File-Upload ueber das `file_upload` Tool verifiziert,
So that File-Upload als Feature belegbar ist.

**Acceptance Criteria:**

**Given** die Benchmark-Seite hat ein `<input type="file" id="benchmark-upload">` Element
**When** der Test T5.4 ausgefuehrt wird
**Then** laedt er eine Testdatei per `file_upload` hoch
**And** verifiziert per `evaluate` dass `document.getElementById("benchmark-upload").files.length === 1`
**And** prueft den Dateinamen des hochgeladenen Files

**Given** die Benchmark-Seite zeigt den Dateinamen nach Upload an
**When** der Upload abgeschlossen ist
**Then** stimmt der angezeigte Dateiname mit der Testdatei ueberein

**Technical Notes:**
- Benchmark-Seite braucht ein File-Upload-Element in der Level-5-Section
- Testdatei: kleine Textdatei (z.B. `test-hardest/fixtures/test-upload.txt`)
- `file_upload` Tool nutzt CDP `DOM.setFileInputFiles`
- **FRs:** FR76
- **Abhaengigkeit:** Story 11.1 (Level-5-Infrastruktur, Upload-Element im HTML)

### Story 11.6: T5.5 SPA-Navigation Test

As a **Benchmark-Suite**,
I want einen Test der SPA-Navigation mit History API verifiziert,
So that Single-Page-App-Handling als Feature belegbar ist.

**Acceptance Criteria:**

**Given** die Benchmark-Seite hat eine SPA-Section die `history.pushState()` nutzt
**When** der Test T5.5 ausgefuehrt wird
**Then** triggert er per `evaluate` ein `history.pushState({}, "", "/spa-test-route")`
**And** die URL aendert sich ohne Seiten-Reload
**And** `wait_for` erkennt die SPA-Navigation und wartet auf Content-Update

**Given** der Content nach pushState aktualisiert wird
**When** `read_page` aufgerufen wird
**Then** zeigt der A11y-Tree den aktualisierten Content (nicht den alten)

**Technical Notes:**
- Benchmark-Seite braucht JS-Code der auf popstate reagiert und DOM aktualisiert
- Test prueft: pushState → wait_for → read_page zeigt neuen Content
- SPA-Detection in settle.ts: `Page.navigatedWithinDocument` Event
- **FRs:** FR77
- **Abhaengigkeit:** Story 11.1 (Level-5-Infrastruktur, SPA-Section im HTML)

### Story 11.7: T5.6 Reconnect-Recovery Test

As a **Benchmark-Suite**,
I want einen Test der CDP-Reconnect nach Verbindungsverlust verifiziert,
So that Verbindungsstabilitaet als Feature belegbar ist.

**Acceptance Criteria:**

**Given** der MCP-Server ist mit Chrome verbunden
**When** der Test T5.6 die CDP-Verbindung unterbricht (simuliert)
**Then** reconnected der Server automatisch innerhalb von 3 Sekunden (NFR11)
**And** der naechste Tool-Call (`tab_status`) funktioniert ohne Fehler

**Given** der Reconnect war erfolgreich
**When** `tab_status` aufgerufen wird
**Then** enthaelt die Response den aktuellen Tab-State (URL, Title)
**And** `_meta` zeigt keinen Fehler

**Technical Notes:**
- Schwierigster Test — CDP-Disconnect programmatisch simulieren
- Option A: `evaluate` → `window.__sc_test_disconnect = true` → Server-seitige Erkennung (einfacher, aber kuenstlich)
- Option B: Benchmark-Runner schliesst die WebSocket-Verbindung temporaer (realistischer, aber komplex)
- Option C: `navigate` zu `chrome://crash` (Chrome-Tab crasht, nicht die Verbindung) — testet Tab-Recovery
- Empfehlung: Starte mit Option C (Tab-Crash + Recovery), da deterministisch und realistisch
- **FRs:** FR74
- **Abhaengigkeit:** Story 11.1 (Level-5-Infrastruktur)

### Story 11.8: Benchmark-Runner-Integration (alle Tests)

As a **Entwickler (Julian)**,
I want dass der Benchmark-Runner (`npm run benchmark`) alle Level-1-bis-5-Tests ausfuehrt,
So that ein einziger Befehl reproduzierbare Ergebnisse fuer alle Tests liefert.

**Acceptance Criteria:**

**Given** Chrome laeuft und die Benchmark-Seite auf `localhost:4242` erreichbar ist
**When** `npm run benchmark` ausgefuehrt wird
**Then** werden alle Tests von Level 1 bis Level 5 ausgefuehrt (30+ Tests)
**And** die JSON-Ergebnisdatei enthaelt Ergebnisse fuer alle Levels

**Given** die JSON-Ergebnisdatei
**When** sie mit frueheren Benchmark-Dateien (`benchmark-*.json`) verglichen wird
**Then** ist das Format kompatibel (gleiche Schluessel, gleiche Struktur)

**Given** ein Level-5-Test scheitert
**When** der Benchmark-Runner weiterlaeuft
**Then** werden die uebrigen Tests trotzdem ausgefuehrt
**And** die Summary zeigt korrekt: passed/failed/skipped pro Level

**Technical Notes:**
- Erweitert `test-hardest/benchmark-full.mjs` um Level-5-Tests
- Reihenfolge: Level 1 → 2 → 3 → 4 → 5 (aufsteigend, einfache Tests zuerst)
- JSON-Export nach `test-hardest/benchmark-silbercuechrome_mcp-{datum}.json`
- **FRs:** FR80
- **Abhaengigkeit:** Story 10.4 (Benchmark-Runner Grundstruktur), alle Story 11.x Tests

---

## Epic 12: Token-Transparenz & Metriken (Phase 2)

Jede Tool-Response zeigt ihren Token-Footprint — Response-Groesse in Bytes, geschaetzte Token-Anzahl, und ein Benchmark-Test der Token-Budgets verifiziert.
**FRs:** FR78, FR79
**NFRs:** NFR4
**Abhaengigkeit:** Keine (kann parallel zu Epic 11)

### Story 12.1: _meta.response_bytes in allen Tool-Responses

As a **AI-Agent-Entwickler**,
I want dass jede Tool-Response `_meta.response_bytes` enthaelt,
So that ich den Token-Footprint jedes Tool-Calls sehen und optimieren kann.

**Acceptance Criteria:**

**Given** der Agent ruft ein beliebiges Tool auf (navigate, click, read_page, etc.)
**When** die Response zurueckgegeben wird
**Then** enthaelt `_meta` das Feld `response_bytes` mit der Groesse des serialisierten Content-Arrays in Bytes

**Given** eine navigate-Response mit 500 Bytes Content
**When** `_meta.response_bytes` gelesen wird
**Then** ist der Wert 500 (±10% Toleranz fuer Serialisierungs-Overhead)

**Given** eine leere Response (z.B. click ohne Rueckgabe)
**When** `_meta.response_bytes` gelesen wird
**Then** ist der Wert > 0 (mindestens die Mindest-Response-Struktur)

**Technical Notes:**
- Zentrale Implementierung in `src/registry.ts` → `ToolRegistry.wrap()` oder Response-Postprocessor
- `response_bytes = Buffer.byteLength(JSON.stringify(content), 'utf8')`
- Muss NACH der Content-Erstellung berechnet werden, BEVOR die Response gesendet wird
- Kein Performance-Impact: Ein JSON.stringify + byteLength ist <1ms
- Bestehende `_meta`-Felder (elapsedMs, method) bleiben erhalten
- **FRs:** FR78

### Story 12.2: _meta.estimated_tokens in read_page und dom_snapshot

As a **AI-Agent-Entwickler**,
I want dass `read_page` und `dom_snapshot` Responses `_meta.estimated_tokens` enthalten,
So that ich vor dem Senden an das LLM den Token-Verbrauch abschaetzen kann.

**Acceptance Criteria:**

**Given** der Agent ruft `read_page` auf
**When** die Response zurueckgegeben wird
**Then** enthaelt `_meta` das Feld `estimated_tokens` mit `Math.ceil(response_bytes / 4)`

**Given** der Agent ruft `dom_snapshot` auf
**When** die Response zurueckgegeben wird
**Then** enthaelt `_meta` ebenfalls `estimated_tokens`

**Given** eine read_page-Response mit 4000 Bytes
**When** `_meta.estimated_tokens` gelesen wird
**Then** ist der Wert 1000

**Given** der Agent ruft `navigate` oder `click` auf
**When** die Response zurueckgegeben wird
**Then** enthaelt `_meta` KEIN `estimated_tokens` Feld (nur bei read_page und dom_snapshot)

**Technical Notes:**
- Formel: `estimated_tokens = Math.ceil(response_bytes / 4)` — grobe Approximation (1 Token ≈ 4 Bytes)
- Nur in `read_page` und `dom_snapshot` Tool-Handlern, nicht global
- Berechnung nach response_bytes (Story 12.1 muss zuerst fertig sein)
- **FRs:** FR79
- **Abhaengigkeit:** Story 12.1 (_meta.response_bytes muss existieren)

### Story 12.3: Token-Budget-Benchmark-Test (T5.7)

As a **Benchmark-Suite**,
I want einen Test der verifiziert dass read_page auf grossen DOMs unter einem Token-Budget bleibt,
So that Token-Effizienz als Wettbewerbsvorteil messbar ist.

**Acceptance Criteria:**

**Given** die Benchmark-Seite hat eine Section mit einem grossen DOM (1000+ Elemente)
**When** der Test T5.7 `read_page` auf diese Section aufruft
**Then** ist `_meta.estimated_tokens` kleiner als 8000 (NFR-Richtwert)

**Given** `read_page` mit `filter: "interactive"`
**When** auf dem grossen DOM ausgefuehrt
**Then** ist `_meta.estimated_tokens` kleiner als 2000 (nur interaktive Elemente)

**Given** die Benchmark-Ergebnisse
**When** mit Konkurrenten verglichen wird
**Then** dokumentiert der Test den Token-Verbrauch als vergleichbare Metrik

**Technical Notes:**
- Benchmark-Seite braucht eine Section mit generiertem grossen DOM (Tabelle, Liste, etc.)
- Test prueft `_meta.estimated_tokens` aus der read_page Response
- Vergleichswert: Playwright MCP gibt vollstaendigen A11y-Tree zurueck (oft 50k+ Tokens)
- **FRs:** FR79
- **NFRs:** NFR4
- **Abhaengigkeit:** Story 12.2, Story 11.1 (Level-5-Infrastruktur)

### Story 12.4: Tool-Definitions-Token-Zaehler (npm run token-count)

As a **Entwickler (Julian)**,
I want ein Script das den Token-Overhead der Tool-Definitionen misst,
So that ich bei Aenderungen an Tool-Schemas sofort sehe ob das 5000-Token-Budget (NFR4) eingehalten wird.

**Acceptance Criteria:**

**Given** der Entwickler fuehrt `npm run token-count` aus
**When** das Script laeuft
**Then** listet es jedes Tool mit seiner geschaetzten Token-Anzahl auf
**And** zeigt die Gesamtsumme aller Tool-Definitionen
**And** markiert PASS/FAIL basierend auf dem 5000-Token-Budget (NFR4)

**Given** die Tool-Definitionen aendern sich
**When** `npm run token-count` erneut ausgefuehrt wird
**Then** zeigt es die aktualisierte Zaehlung

**Given** das Budget ueberschritten wird
**When** das Script laeuft
**Then** gibt es Exit-Code 1 zurueck (fuer CI-Integration)

**Technical Notes:**
- Neues Script: `scripts/token-count.mjs`
- Laedt `tools/list` Response des MCP-Servers (oder liest Tool-Schemas direkt)
- Token-Schaetzung: `Math.ceil(JSON.stringify(toolDefinitions).length / 4)`
- `package.json` Script: `"token-count": "node scripts/token-count.mjs"`
- Kann in CI-Pipeline als Quality-Gate integriert werden
- **NFRs:** NFR4
- **Abhaengigkeit:** Keine

### Story 12.5: Auto-Context — navigate/click liefern interaktive Elemente mit

As a **AI-Agent (LLM)**,
I want dass navigate und click automatisch die interaktiven Elemente der Seite in der Response mitliefern,
So that ich nach Navigation oder Klick sofort frische Refs habe und kein separates read_page brauche.

**Acceptance Criteria:**

**Given** der Agent ruft `navigate(url: "https://example.com")` auf
**When** die Seite geladen und settled ist
**Then** enthaelt die Response neben URL und Titel auch eine kompakte Liste interaktiver Elemente mit frischen Refs
**And** das Format entspricht `read_page(filter: "interactive")` Output

**Given** der Agent ruft `click(ref: "e5")` auf
**When** der Klick erfolgreich war
**Then** enthaelt die Response neben der Klick-Bestaetigung auch die aktuellen interaktiven Elemente mit frischen Refs

**Given** das A11y-Tree-Fetching nach navigate/click schlaegt fehl (z.B. Seite noch nicht fertig geladen)
**When** die Response gebaut wird
**Then** wird der Auto-Context-Teil einfach weggelassen (kein Error, nur die normale Response)

**Given** der Auto-Context in navigate/click Responses
**When** das LLM die Refs daraus direkt im naechsten click verwendet
**Then** sind die Refs frisch und gueltig (kein Stale-Ref-Problem)

**Technical Notes:**
- `navigate.ts` `buildSuccessResponse()`: Nach settle `a11yTree.getTree(cdp, sessionId, { filter: "interactive", max_tokens: 2000 })` aufrufen, Text an Response anhaengen
- `click.ts` `clickHandler()`: Im Success-Pfad dasselbe
- navigate braucht SessionManager als zusaetzlichen Parameter (wie read_page)
- Bei Fehler beim Tree-Fetch: try/catch, einfach ohne Tree antworten
- Dokumentiert in `docs/deferred-work.md` als UX-002
- **Abhaengigkeit:** Keine (a11yTree-Infrastruktur existiert bereits komplett)

---

## Epic 13: Visual Developer Intelligence (Phase 3)

Der Agent bekommt CSS-Debugging in einem Call statt Trial-and-Error, und visuelles Feedback nach Code-Edits — zwei Features die den Agent vom blinden Raten zur gezielten Analyse bringen.
**FRs:** TBD (FR81+)
**Abhaengigkeit:** Keine (CDP-Infrastruktur existiert)

### Story 13.1: inspect_element Tool — CSS-Debugging in einem Call

As a **AI-Agent (LLM)**,
I want ein inspect_element Tool das computed styles, matchende CSS-Regeln mit Source-Dateien, geerbte Styles und Kinder-Elemente in einem Aufruf zurueckgibt,
So that ich CSS-Probleme in Sekunden diagnostiziere statt in 20+ Minuten Trial-and-Error mit evaluate.

**Acceptance Criteria:**

**Given** ein Element mit CSS-Konflikten aus mehreren Stylesheets
**When** `inspect_element(selector: ".beleg-name-cell")` aufgerufen wird
**Then** enthaelt die Response:
- `computedStyles`: Layout-relevante computed properties (display, flex*, grid*, position, text-align, overflow, width, height, margin, padding)
- `matchingRules`: Alle CSS-Regeln die das Element matchen, mit Selektor, Source-Datei + Zeilennummer, und gesetzte Properties
- `inheritedStyles`: Geerbte Werte mit Herkunfts-Element (z.B. text-align: center von .App)
- `element`: Tag, Klassen, boundingRect
- `children`: Direkte Kinder mit Tag, Klassen, Text, boundingRect

**Given** `inspect_element(ref: "e42")` mit A11y-Tree Ref
**When** der Ref aufgeloest wird
**Then** funktioniert es identisch wie mit CSS-Selektor (konsistent mit click, type etc.)

**Given** `inspect_element(selector: ".cell", styles: ["display", "flex*", "text-align"])`
**When** der optionale styles-Filter gesetzt ist
**Then** werden nur die angefragten Properties in computedStyles zurueckgegeben (Wildcard * wird expandiert)

**Given** die Response-Groesse
**When** keine styles-Filter gesetzt sind
**Then** werden nur Layout-relevante Properties zurueckgegeben (nicht alle 300+ computed styles)
**And** matchingRules enthalten nur Properties die tatsaechlich gesetzt werden (nicht den gesamten Rule-Block)

**Technical Notes:**
- CDP-APIs: `CSS.getComputedStyleForNode`, `CSS.getMatchedStylesForNode`, `DOM.getBoxModel`
- `CSS.getMatchedStylesForNode` liefert `matchedCSSRules[].rule.origin`, `.selectorList`, `.style.cssProperties[]` und `.rule.styleSheetId`
- Source-Datei ueber `CSS.getStyleSheetText` + `styleSheetId` → href oder ownerNode
- Bei Webpack/Vite Bundles: href enthaelt oft den Source-Dateinamen (z.B. BelegAuswahlModal.css)
- Parameter: `selector` oder `ref` (wie click), `styles` (optional, Array), `include_children` (default: true), `include_rules` (default: true)
- Token-Budget beachten: Kompakte Ausgabe, keine redundanten Daten
- **Hintergrund:** In einer echten Debug-Session brauchte der Agent 4 evaluate-Aufrufe mit handgeschriebenem JS (getComputedStyle, getBoundingClientRect, Parent-Chain, document.styleSheets Iteration) fuer 45 Minuten, um einen flex-direction-Konflikt zwischen zwei CSS-Dateien zu finden. inspect_element haette das in 30 Sekunden geloest.

### Story 13.2: Visual Feedback — Automatischer Screenshot nach Frontend-Edits

As a **AI-Agent (LLM)**,
I want automatisches visuelles Feedback nach CSS/TSX/HTML-Aenderungen in Projekten mit Hot Reload,
So that ich sofort sehe ob meine Aenderung korrekt uebernommen wurde, ohne manuell navigieren und screenshotten zu muessen.

**Acceptance Criteria:**

**Tier 2 (MVP):**

**Given** der Agent editiert eine Frontend-Datei (.css, .tsx, .jsx, .html, .vue, .svelte)
**When** die Datei gespeichert wird und Hot Reload die Seite aktualisiert
**Then** wird automatisch ein Screenshot gemacht und dem Agent zugaenglich gemacht
**And** der Agent muss NICHT manuell navigate → read_page → screenshot aufrufen

**Given** Hot Reload ist nicht aktiv oder die Seite aendert sich nicht
**When** der Screenshot getriggert wird
**Then** wird trotzdem ein Screenshot gemacht (zeigt den aktuellen Zustand)

**Tier 3 (Gezielter Screenshot):**

**Given** der Agent hat eine CSS-Datei editiert und der Selektor ist bekannt (z.B. .beleg-name-cell)
**When** der automatische Screenshot getriggert wird
**Then** wird nur der Bereich um das betroffene Element gecaptured (clip-Parameter)
**And** der Screenshot ist dadurch kompakter und fokussierter

**Tier 4 (Visueller Diff):**

**Given** der Agent editiert eine Frontend-Datei
**When** Hot Reload die Seite aktualisiert
**Then** wird ein Pixel-Diff zwischen Vorher- und Nachher-Screenshot berechnet
**And** nur die veraenderte Region wird zurueckgegeben
**And** der Agent sieht exakt was sich visuell geaendert hat

**Technical Notes:**
- **Tier 2 Implementierung:** Claude Code PostToolUse Hook auf Edit/Write fuer Frontend-Dateien → Script das CDP `Page.captureScreenshot` an localhost:9222 ausfuehrt → Screenshot-Pfad im Hook-Output
- **Tier 3:** Hook parst CSS-Selektor aus Diff → `getBoundingClientRect()` → `Page.captureScreenshot` mit clip-Parameter
- **Tier 4:** Vorher-Screenshot cachen → Nach HMR zweiten Screenshot → Pixel-Diff (z.B. pixelmatch npm-Paket) → nur geaenderte Region zurueck
- **MCP-Push Ergaenzung:** DomWatcher/MutationObserver koennte `dom_changed: true` Flag in tab_status setzen; Webpack HMR loggt `[HMR] Updated modules:` in Console — MCP koennte darauf reagieren
- **Hintergrund:** In der Praxis braucht der Agent 4-5 Tool-Calls pro Verifikation (navigate → read_page → durchklicken → screenshot). Ein Mensch schaut einfach auf den Browser. Dieses Feature schliesst diese Luecke.
- **Abhaengigkeit:** Screenshot-Tool existiert bereits (Story 2.3), CDP-Infrastruktur komplett vorhanden
- **Empfohlene Reihenfolge:** Tier 2 → Tier 3 → Tier 4 (jeder Tier baut auf dem vorherigen auf)
