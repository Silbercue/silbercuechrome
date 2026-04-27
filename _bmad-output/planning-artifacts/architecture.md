---
stepsCompleted:
  - step-01-init
  - step-02-context
  - step-03-starter
  - step-04-decisions
  - step-05-patterns
  - step-06-structure
  - step-07-validation
  - step-08-complete
status: 'complete'
completedAt: '2026-04-26'
lastStep: 8
editHistory:
  - date: '2026-04-27'
    changes: 'Cortex Pattern Generalization: Pattern-Key auf pageType, +2 Module (page-classifier, markov-table), Cortex-Sektion und Directory-Tree aktualisiert'
  - date: '2026-04-26'
    changes: 'Public Browser Pivot: Pro/License entfernt, Cortex-Architektur (src/cortex/, cortex-validator/), Rename, FR40-46+NFR19-21 gemappt'
  - date: '2026-04-16'
    changes: 'Script API v2 Shared Core Architektur-Update'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/product-brief-SilbercueChrome-distillate.md
  - docs/research/run-plan-forensics.md
  - docs/research/competitor-internals-stagehand-browser-use.md
  - docs/research/speculative-execution-and-parallelism.md
  - docs/research/llm-tool-steering.md
  - docs/deferred-work.md
  - docs/friction-fixes.md
  - docs/story-23.1-evaluate-steering-v2.md
workflowType: 'architecture'
project_name: 'SilbercueChrome'
user_name: 'Julian'
date: '2026-04-14'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements (46 FRs in 10 Kategorien):**

Die FRs decken die gesamte Browser-Automation-Pipeline ab:
- **Page Reading** (FR1-FR5): A11y-Tree mit stabilen Refs, progressive Tiefe, Tab-Status-Cache — die Grundlage fuer jede Interaktion
- **Element Interaction** (FR6-FR11): Click, Type, Fill-Form, Scroll, Press-Key, Drag-and-Drop — direkte CDP-Operationen mit Ref-basiertem Targeting
- **Execution** (FR12-FR16): run_plan (Batch-Execution, unbegrenzte Steps, Teilergebnis bei Fehler), evaluate (JS), wait_for, observe (MutationObserver) — der Automatisierungs-Kern
- **Tab Management** (FR17-FR18): Multi-Tab-Handling und Uebersicht — alle Tools Free
- **Download Management** (FR19-FR20): Download-Status und Session-History — passive CDP-Events
- **Connection** (FR21-FR24): Zero-Config Auto-Launch, --attach, Auto-Reconnect, Ref-Stabilitaet — CDP-Lifecycle
- **Tool Steering** (FR25-FR29): Anti-Pattern-Detection, Stale-Ref-Recovery, Negativ-Abgrenzung, Profile, DOM-Diff — LLM-Fuehrung
- **Distribution** (FR30-FR31): npx public-browser, alle Tools ohne Einschraenkungen — Open Source
- **Script API** (FR34-FR39): Python-Client-Library mit Shared Core (nutzt MCP-Tool-Implementierungen), --script Flag, Tab-Isolation, Context-Manager, pip-Distribution — dritter Zugangsweg neben MCP und CLI
- **Cortex** (FR40-FR46): Selbstlernendes Wissen — Pattern-Recorder, Merkle Log, Cortex-Hints, Telemetrie-Upload, Bundle-Download mit Sigstore-Verifikation

Architektonische Implikation: Jede FR-Kategorie mappt auf ein eigenes Modul oder Sub-System. Cortex (FR40-FR46) ist das groesste neue architektonische Thema — ein komplett neues Subsystem mit eigener Persistenz (Merkle Log), externer Kommunikation (Telemetrie-Upload, Bundle-Download) und kryptographischer Verifikation (Sigstore, WASM-Validator).

**Non-Functional Requirements (21 NFRs):**

Architektur-treibende NFRs:
- **NFR1 (<50ms Median):** Erzwingt synchrone CDP-Calls, kein Queueing, kein Batching-Overhead
- **NFR2 (<5.000 Tokens Tool-Defs):** Erzwingt kompakte Tool-Descriptions, Profile-System
- **NFR4 (Safety-Cap 50k Tokens):** Erzwingt progressives Downsampling im A11y-Tree-Builder
- **NFR6 (keine Zwischen-Latenz):** Erzwingt tight-loop Execution in run_plan
- **NFR7+8 (Reconnect + State-Erhalt):** Erzwingt Cache-Layer zwischen CDP und Tools
- **NFR15 (OOPIF transparent):** Erzwingt CDP-Session-Manager fuer Cross-Origin-iFrames
- **NFR16 (webdriver-Maskierung):** Erzwingt Stealth-Konfiguration im Chrome-Launcher
- **NFR18 (CDP-Koexistenz):** Erzwingt Multi-Client-faehigen Zugriff: MCP via Pipe/stdio und Script API via Server HTTP-Endpunkt (Port 9223) gleichzeitig, Tab-Isolation zwischen Clients
- **NFR19 (Bundle-Download max 2s):** Erzwingt asynchronen Cortex-Bundle-Download mit Cache-First-Strategie und hartem Timeout beim Server-Start
- **NFR20 (WASM-Determinismus):** Erzwingt Nix-Build fuer den Cortex-Validator, gleiche Inputs → gleiche Outputs auf jeder Plattform
- **NFR21 (Pattern-Privacy):** Erzwingt striktes Datenmodell im Cortex — nur Seitentyp, Tool-Sequenz, Metriken. Domain optional lokal, nicht in Telemetrie/Bundles. Keine User-Daten, keine Credentials

### Technical Constraints & Dependencies

**Runtime:** TypeScript auf Node.js 22+ (LTS). Direktes CDP ueber `ws` Library.
**Protokoll:** MCP (JSON-RPC ueber stdio) via `@modelcontextprotocol/sdk`.
**Chrome-Kompatibilitaet:** Chrome 120+ (4 Major-Versionen).
**Build:** `tsc` nach `build/`, Distribution als npm-Package (`public-browser`).
**Cortex-Validator:** Rust → WASM (wasmtime, WASI P2), Nix-Build fuer Reproduzierbarkeit.
**Bekannte CDP-Einschraenkungen:**
- CDP serialisiert pro Session — kein echtes Parallelism (Research: speculative-execution)
- Node 22 WebSocket Accept-Mismatch (BUG-003, Accept-Check deaktiviert)
- Cross-OOPIF Ref-Collision (BUG-016, gefixt per Session-scoped prefixing)

### Cross-Cutting Concerns Identified

1. **Token-Effizienz:** Durchzieht alles — Tool-Definitions, A11y-Tree, Screenshots, Response-Payloads, run_plan-Aggregation. Jedes Modul muss token-budget-bewusst sein.
2. **CDP-Session-Lifecycle:** Auto-Connect, Reconnect, Target-Discovery, OOPIF-Sessions. Betrifft alle Tools.
3. **Cortex-Integration:** Pattern-Recording nach Tool-Calls, Hint-Matching bei navigate/view_page, Bundle-Download beim Start, Telemetrie-Upload (opt-in). Betrifft hooks/, navigate, view_page, Server-Startup.
4. **Error-Recovery-Kette:** Stale-Refs → view_page-Hint, CDP-Disconnect → Auto-Reconnect, evaluate-Spiral → Anti-Pattern-Hint. Drei Schichten, alle muessen zusammenspielen.
5. **LLM-Steering:** Tool-Descriptions, Server-Instructions, Anti-Pattern-Detection, Profile-System. Nicht Code sondern Prosa — aber architektonisch genauso wichtig.
6. **Koexistenz (Script API):** MCP-Server via Pipe und Python-Skripte via Server HTTP-Endpunkt (Port 9223) greifen gleichzeitig auf denselben Chrome zu. Shared Core: beide nutzen dieselben Tool-Handler. Tab-Isolation und Session-Routing muessen koordiniert sein.

## Starter Template Evaluation

### Primary Technology Domain

Developer Tool (MCP-Server) — TypeScript/Node.js CLI-Anwendung mit stdio-Transport und CDP-WebSocket-Verbindung.

### Starter Options Considered

Nicht anwendbar. Public Browser (formerly SilbercueChrome) ist ein Brownfield-Projekt bei v1.3.0 mit 22 abgeschlossenen Epics und 1500+ Tests. Der "Starter" ist die bestehende `master`-Branch. Es gibt keine Scaffolding-Story.

### Selected Starter: Public Browser Master-Branch (v1.3.0)

**Rationale:** Bestehende, produktiv genutzte Codebasis. v2.0 ist ein Rename + Feature-Freischaltung + Cortex-Ergaenzung, kein Rewrite.

### Architectural Decisions Provided by the Existing Codebase

**Language & Runtime:**
- TypeScript 5.x (strict mode), ESM (`"type": "module"`)
- Node.js 22+ (LTS), `tsc` als Compiler nach `build/`

**Dependencies (minimal — 4 Runtime):**
- `@modelcontextprotocol/sdk` — MCP-Protokoll-Handling
- `zod` — Schema-Validation (Tool-Parameter, run_plan)
- `pixelmatch` + `pngjs` — Screenshot-Diff fuer DOM-Change-Detection
- (Cortex, Phase 2+): WASM-Runtime fuer Validator, HTTPS-Client fuer Bundle-Download/Telemetrie-Upload

**DevDependencies:**
- `vitest` (Test-Framework), `eslint` + `prettier` (Linting/Formatting)
- `tsx` (Dev-Runner), `typescript-eslint`

**Modul-Struktur (src/):**
- `cdp/` — Chrome DevTools Protocol Layer (14 Dateien): WebSocket-Client, Session-Manager, Chrome-Launcher, Dialog-Handler, DOM-Watcher, Download/Network/Console-Collectors, Emulation, Settle-Logic
- `tools/` — MCP-Tool-Implementierungen (27 Dateien): Ein File pro Tool (click, type, fill-form, run-plan, etc.) plus Shared Utilities (element-utils, error-utils, visual-constants)
- `plan/` — run_plan Execution Engine
- `cache/` — State-Caching (Tab-Status, A11y-Tree)
- `hooks/` — Lifecycle-Hooks (on-tool-result, ambient-context, pattern-recording)
- `cortex/` — Selbstlernende Wissensschicht (Pattern-Recorder, Merkle Log, Hint-Matcher, Bundle-Loader, Telemetrie)
- `transport/` — MCP stdio/SSE Transport
- `cli/` — CLI-Argument-Parsing (--attach, etc.)
- `overlay/` — Visual Overlay fuer Debugging
- `telemetry/` — Telemetrie-Stubs (aktuell leer, NFR18)
- `registry.ts` — Tool-Registry (94 KB, Herzstuck: Tool-Definitions, Profile, Steering)
- `server.ts` — MCP-Server-Setup
- `index.ts` — Entry-Point

**Testing:**
- Vitest, 1500+ Tests, Co-Located (test neben source)
- `registry.test.ts` (194 KB) als groesste Test-Datei

**Build & Distribution:**
- `npm run build` → `tsc` nach `build/`
- npm-Package `public-browser`, npx-faehig
- Single-Repo: Open Source, kein Pro-Repo

## Core Architectural Decisions

### Decision Priority Analysis

**Bereits entschieden (durch 22 Epics bestaetigt):**
Alle Kern-Entscheidungen sind implementiert und produktiv validiert. Kein Redesign noetig.

**Offene Punkte fuer v1.0:**
- registry.ts (94 KB) — funktional, aber potentieller Maintainability-Engpass
- BUG-003 WebSocket Accept-Workaround — muss vor v1.0 sauber geloest oder dokumentiert werden
- Story 23.1 (evaluate Anti-Spiral v2) — einzige groessere architektonische Erweiterung

### Tool Registry & Steering

**Entscheidung:** Monolithische `registry.ts` mit Tool-Definitions, Profile-System und Steering-Logik.

- 94 KB, groesste Source-Datei. Enthaelt alle Tool-Schemas, Descriptions mit Negativ-Abgrenzung, Profile-Konfiguration (Default 10, Full via `SILBERCUE_CHROME_FULL_TOOLS`)
- Drei-Schichten Steering: (1) Negativ-Abgrenzung in Descriptions, (2) Server Instructions im MCP-Prompt, (3) Anti-Pattern-Detection zur Laufzeit (evaluate-Spiral ab 3 Calls)
- Story 23.1 plant v2: situational steering, zwei-Tier Streak-System, drei neue Anti-Patterns

**Rationale:** Zentralisierung ist gewollt — alle Tool-Definitionen an einem Ort verhindert Drift zwischen Description und Implementation. 94 KB ist gross, aber die Alternative (Definitionen verstreut ueber 27 Tool-Files) waere schwerer konsistent zu halten.

### run_plan Execution Engine

**Entscheidung:** Serverseitige deterministische Batch-Execution ohne LLM-Feedback zwischen Steps.

- Plan-Parser und Executor in `src/plan/`
- Unbegrenzte Steps, bei Fehler graceful Teilergebnis (kein Error)
- Ambient-Context-Suppression waehrend Execution (spart 2850 Chars + 1000-5250ms pro Plan)
- Step-Response-Aggregation: ein kompakter Return am Ende statt N Zwischen-Payloads
- Kein Conditional/Loop innerhalb Plans — Plans sind lineare Sequenzen

**Rationale:** Linearitaet ist Feature, nicht Limitation. Conditionals wuerden die Plan-Sprache komplex machen und den Determinismus-Vorteil aufheben. Das LLM kann nach einem Teilergebnis einen neuen Plan formulieren.

### CDP Connection & Session Management

**Entscheidung:** Direktes CDP ueber WebSocket (`ws` Library), kein Framework-Layer.

- `src/cdp/` mit 14 Dateien: Client, Session-Manager, Chrome-Launcher, Collectors (Console, Network, Download, Dialog, DOM-Watcher)
- Auto-Launch mit `--remote-debugging-port=9222`, --attach fuer laufendes Chrome
- Auto-Reconnect mit Exponential Backoff, State-Preservation (Tab-IDs, Cache)
- OOPIF-Sessions transparent via Session-Manager (BUG-016 gefixt)
- BUG-003 Workaround: WebSocket Accept-Check deaktiviert (Node 22 + Chrome 146 Inkompatibilitaet)

**v1.0-Entscheidung zu BUG-003:** Workaround dokumentieren in README ("Known Issue"), Accept-Check reaktivieren sobald Node oder Chrome den Bug fixen. Kein eigener Fix — das ist ein Upstream-Problem.

### A11y-Tree & Page Reading

**Entscheidung:** Progressive Tiefe mit Token-Budget und Safety-Cap.

- `src/tools/read-page.ts` baut A11y-Tree mit stabilen Refs (e1, e2...)
- Token-Budget konfigurierbar, Safety-Cap bei 50k Tokens
- Paint-Order-Filtering: verdeckte Elemente (z.B. hinter Modal) werden ausgefiltert
- Speculative Prefetch: A11y-Tree wird im Hintergrund vorgebaut waehrend LLM "denkt"
- Stale-Ref-Detection mit Recovery-Hint ("call view_page to get fresh refs")

**Rationale:** Progressive Tiefe ist der Token-Effizienz-Hebel — nicht jede Seite braucht den vollen Tree. Safety-Cap verhindert Context-Window-Sprengung bei DOM-Monstern.

### Cortex — Selbstlernende Wissensschicht

**Entscheidung:** Neues Subsystem `src/cortex/` das erfolgreiche Tool-Sequenzen aufzeichnet, lokal in einem Merkle Log speichert, und ueber die Community teilt.

**Pattern-Key:** `pageType` (regelbasiert aus A11y-Tree bestimmt, Epic 12a Retrofit). Drei-Schichten-Erkennung:
1. Schicht 1: Regelbasierter A11y-Tree-Klassifikator → Seitentyp (~20 Typen)
2. Schicht 2: Gewichtete Markov-Uebergangstabelle → Tool-Vorhersage pro Seitentyp
3. Schicht 3: SimHash-Fallback → fuer unbekannte Seitentypen (deferred, Phase 2)

**Community-Bundle-Format:** JSON Markov-Tabelle (~10KB): `{ pageType → { lastTool → { nextTool → weight } } }`. Ersetzt JSONL-Einzelpatterns (domain + pathPattern pro Zeile).

**Architektur (8 Dateien, +2 durch Epic 12a):**
- `cortex/pattern-recorder.ts` — Hook nach erfolgreichen Tool-Calls (wie Ambient-Context). Bestimmt Seitentyp via page-classifier und zeichnet Tool-Sequenz, Outcome und Content-Hash auf.
- `cortex/local-store.ts` — Lokaler Append-Only Merkle Log (RFC-6962-kompatibel). Speichert Patterns kryptographisch gesichert.
- `cortex/hint-matcher.ts` — Seitentyp-Matching + Markov-Vorhersage. Wird in navigate und view_page eingebunden, liefert Cortex-Hints in `_meta.cortex`.
- `cortex/page-classifier.ts` — **Neu (Epic 12a).** Regelbasierter A11y-Tree-Klassifikator → Seitentyp (~20 Typen). Deterministisch, kein ML.
- `cortex/markov-table.ts` — **Neu (Epic 12a).** Gewichtete Uebergangstabelle: P(naechstes_tool | letztes_tool, seiten_typ). Export als ~10KB JSON fuer Community-Sharing.
- `cortex/bundle-loader.ts` — Laeuft beim Server-Start. Laedt Community-Bundle herunter, verifiziert Sigstore-Signatur und Merkle Inclusion Proof. Cache-First mit hartem 2s-Timeout (NFR19).
- `cortex/telemetry-upload.ts` — Opt-in. Sendet anonymisierte Pattern-Eintraege (Seitentyp + Tool-Sequenz, keine Domain) an Collection-Endpoint (HTTPS POST, Rate-Limited, kein PII).
- `cortex/cortex-types.ts` — Pattern (mit PageType statt Domain), Bundle (Markov-Tabelle statt Einzelpatterns), MerkleProof, HintMatch Typen.

**Externe Komponente: cortex-validator/**
- Separates Rust-Projekt (nicht Teil des Node.js-Builds)
- Kompiliert zu WASM (wasmtime, WASI P2) fuer deterministische Ausfuehrung
- Nix-Build fuer Reproduzierbarkeit (gleicher Hash = gleicher Output)
- Validierungsregeln: N unabhaengige Bestaetigungen, Zeitfenster, Anomalie-Check

**Warum ein eigenes Subsystem statt Integration in bestehende Module:**
Cortex hat eigene Persistenz (Merkle Log), eigene externe Kommunikation (Telemetrie, Bundle-Download), eigene Kryptographie (Sigstore, Merkle Proofs) und eigene Privacy-Anforderungen (NFR21). Diese Concerns gehoeren nicht in tools/ oder hooks/.

**Warum Rust/WASM fuer den Validator:**
Determinismus ist die zentrale Anforderung — gleiche Inputs muessen auf jeder Plattform identische Outputs erzeugen (NFR20). WASM garantiert das. Rust bietet Memory Safety ohne GC, Nix-Build ermoeglicht reproduzierbare Kompilierung.

**Integration mit bestehendem Code:**
- `hooks/` ruft `cortex/pattern-recorder.ts` nach erfolgreichen Tool-Calls auf (neuer Hook neben Ambient-Context)
- `tools/navigate.ts` und `tools/read-page.ts` fragen `cortex/hint-matcher.ts` ab und fuegen Hints in die Response ein
- `src/index.ts` (Server-Start) ruft `cortex/bundle-loader.ts` auf (async, max 2s)
- Kein Tool importiert cortex/ direkt — alles laeuft ueber hooks/ und die zwei Integration Points (navigate, view_page)

### Hooks & Lifecycle

**Entscheidung:** Leichtgewichtiges Hook-System fuer Tool-Result-Processing.

- `src/hooks/` mit on-tool-result Hooks
- Ambient-Context: Nach Tool-Calls optional Seiten-Kontext mitliefern (unterdrueckt in run_plan)
- DOM-Diff: Bei click/type synchroner Vergleich vorher/nachher
- Speculative Prefetch: Background A11y-Tree-Build nach Navigation

**Rationale:** Hooks statt Middleware — keine Plugin-Architektur, keine DI. Einfache Funktionsaufrufe an definierten Stellen. Solo-Developer-tauglich.

### Script API & Shared Core

**Entscheidung:** Python-Scripts routen Tool-Calls durch den Public-Browser-Server und nutzen dieselben Implementierungen wie MCP-Tools (Shared Core).

**Architektur:**
- `Chrome.connect()` startet den Public-Browser-Server als Subprocess falls nicht bereits laufend (selbes Pattern wie Playwright, das einen unsichtbaren Node.js-Prozess startet)
- Die Python-Library kommuniziert mit dem Server ueber einen lokalen Kanal (Kommunikationsprotokoll — Subprocess stdio, HTTP oder WebSocket — wird bei Epic-Erstellung entschieden)
- Tool-Calls (click, navigate, fill etc.) werden serverseitig ausgefuehrt — gleicher Code-Pfad wie MCP-Tools, gleiche Tests, gleiche Bugfixes
- `--script` CLI-Flag (aus Epic 9 v1) bleibt: aktiviert Tab-Isolation (ownedTargetIds-Set filtert Script-Tabs aus MCP-Tab-Listen) und startet den HTTP-Endpunkt auf Port 9223. MCP-interne Guards (switch_tab-Mutex, registry Parallel-Block) bleiben UNBERUEHRT — sie schuetzen MCP-interne Races und sind von Script-API-Calls nicht betroffen
- Tab-Isolation: Scripts arbeiten in eigenen Tabs, MCP-Tabs werden nicht modifiziert
- Context-Manager-Pattern (`with chrome.new_page()`) schliesst den Tab beim Exit automatisch
- Escape-Hatch: `cdp.send()` fuer direkten CDP-Zugriff bei Spezialfaellen (Power-User)

**Warum Shared Core statt separater Implementierung:**
Marktanalyse (`docs/research/script-api-shared-core.md`) zeigt: kein Konkurrent bietet diesen Ansatz — unbesetzte Nische. Feature-Paritaet ohne manuelles Portieren. Eine Codebase, ein Testset (1600+ Tests). Jede Verbesserung an click, navigate, fill etc. kommt Scripts automatisch zugute.

**Warum Python (nicht Node.js/TypeScript):**
Die Zielgruppe fuer deterministische Scripting (Tomek-Persona) arbeitet typischerweise in Python. Node.js-User nutzen bereits den MCP-Weg. Python erweitert die Zielgruppe statt sie zu duplizieren.

**Distribution-Entscheidung:**
- `pip install publicbrowser` als primaerer Installationspfad
- `Chrome.connect()` startet den Server automatisch — kein separates Setup noetig
- Server-Binary wird ueber PATH gefunden (Homebrew, npx, oder expliziter Pfad)

**Module:**
- `python/` (Projekt-Root) — Python-Package mit `Chrome`, `Page` Klassen (API-Oberflaeche stabil, interne Implementierung routet durch Server)
- `src/index.ts` — `--script` Flag-Parsing (bereits implementiert, Epic 9 v1)
- Server-seitiges Script-API-Gateway (neu) — nimmt Tool-Calls von Python entgegen und fuehrt sie ueber die bestehenden Tool-Handler aus

**NFR19-Sicherstellung:**
- Tab-Isolation ueber `--script` Mode und `_ownedTargetIds` Set (Epic 9 v1, bewaehrt)
- Scripts und MCP-Agent teilen denselben Server-Prozess und Chrome, aber arbeiten in getrennten Tabs
- Kein CDP-Konflikt: Scripts gehen durch den Server, nicht direkt an Chrome

### Decision Impact Analysis

**Implementation Sequence fuer v2.0:**
1. Epic 11: Public Browser Migration — Pro-Gates entfernen, License entfernen, Rename, npm/pip-Package migrieren
2. Epic 12: Cortex Phase 1 — Pattern-Recorder, Merkle Log, Cortex-Hints, Telemetrie-Upload — DONE
3. Epic 12a: Cortex Pattern Generalization — Seitentyp-Klassifikator, Markov-Tabelle, Hint-Matcher + Telemetrie Retrofit
4. Epic 13: Cortex Phase 2 — WASM-Validator, Sigstore-Signierung, OCI Distribution, Canary-Deployment

**Cross-Component Dependencies:**
- Tool Steering (registry.ts) ↔ Anti-Pattern-Detection (hooks) ↔ run_plan (plan/)
- CDP Session-Manager ↔ alle Tools (Ref-Stabilitaet)
- Cortex (cortex/) ↔ hooks/ (Pattern-Recording) ↔ navigate + view_page (Hint-Delivery) ↔ index.ts (Bundle-Loading beim Start)
- Script API (python/) ↔ Script-API-Gateway ↔ Tool-Handler (shared) ↔ CDP ↔ NFR18 Tab-Isolation

## Implementation Patterns & Consistency Rules

### Pattern Categories Defined

**5 Konflikt-Bereiche** in denen KI-Agenten unterschiedlich entscheiden koennten:
Namensgebung, Tool-Implementierung, CDP-Aufrufe, Fehlerbehandlung, Tool-Descriptions

### Code Naming Conventions

**Dateien:** kebab-case fuer alle Source-Files (`fill-form.ts`, `read-page.ts`, `chrome-launcher.ts`)
**Tests:** Co-located, gleicher Name mit `.test.ts` Suffix (`click.ts` → `click.test.ts`)
**Funktionen:** camelCase (`parseSelector`, `buildAccessibilityTree`, `dispatchMouseEvent`)
**Typen/Interfaces:** PascalCase (`ToolDefinition`, `PlanStep`, `BrowserSession`)
**Konstanten:** UPPER_SNAKE_CASE fuer Modul-Konstanten (`MAX_TOKENS`, `DEFAULT_VIEWPORT_WIDTH`)
**Zod-Schemas:** camelCase mit Schema-Suffix oder inline (`clickSchema`, `runPlanSchema`)
**Tool-Namen (MCP):** snake_case (`view_page`, `fill_form`, `run_plan`, `switch_tab`)

### Tool Implementation Pattern

Jedes Tool in `src/tools/` folgt demselben Aufbau:

1. **Zod-Schema** fuer Parameter-Validation oben in der Datei
2. **Handler-Funktion** die `(params, session)` nimmt und ein MCP-Response-Objekt zurueckgibt
3. **Registrierung** in `registry.ts` mit Tool-Definition (name, description, inputSchema, handler)
4. **Co-located Test** mit Vitest, gleicher Dateiname

**Regel:** Keine Tool-Datei importiert eine andere Tool-Datei. Shared Logic geht nach `element-utils.ts` oder `error-utils.ts`. Ein Tool = ein File = eine Verantwortlichkeit.

### CDP Call Pattern

- Alle CDP-Aufrufe gehen ueber `session.send('Domain.method', params)` — niemals direkt ueber WebSocket
- CDP-Fehler werden gefangen und in MCP-Fehlermeldungen uebersetzt (nicht durchgereicht)
- Kein `await` auf CDP-Events in tight loops — stattdessen `waitForEvent` mit Timeout
- OOPIF-Aufrufe nutzen den Session-Manager fuer die richtige CDP-Session

### Error Handling Pattern

**MCP-Responses:** Immer `{ content: [{ type: "text", text: "..." }], isError: true/false }`
**Kein throw** aus Tool-Handlern — Fehler werden als MCP-Response mit `isError: true` zurueckgegeben
**Recovery-Hints:** Fehler enthalten Hinweise was das LLM als naechstes tun soll ("call view_page to get fresh refs", "use click(ref) instead of evaluate for DOM interaction")
**error-utils.ts:** Zentrale Fehler-Formatierung, nicht jedes Tool baut eigene Fehlertexte

### Tool Description Pattern (LLM-Steering)

**Negativ-Abgrenzung:** Jede Description sagt wann das Tool NICHT verwendet werden soll und verweist auf die bessere Alternative
- Beispiel: capture_image Description sagt "fuer Seiteninhalt view_page nutzen, nicht capture_image"
- Beispiel: evaluate Description sagt "fuer Klicks click(ref) nutzen, nicht evaluate mit querySelector"

**Kompaktheit:** Descriptions muessen unter dem Token-Budget bleiben. Keine Prosa-Erklaerungen, nur praezise Handlungsanweisungen.

**Profile-Awareness:** Nicht alle Tools sind immer sichtbar. Default-Profil zeigt 10 Tools, Full-Profil alle. Descriptions duerfen nicht auf unsichtbare Tools verweisen.

### run_plan Step Pattern

Jede Aktion die als run_plan-Step ausfuehrbar sein soll, muss:
1. Eine synchrone Ausfuehrung unterstuetzen (kein LLM-Feedback noetig zwischen Steps)
2. Ein kompaktes Ergebnis liefern (fuer Step-Response-Aggregation)
3. Bei Fehler einen klaren Abbruchgrund liefern (Plan stoppt bei erstem Fehler)
4. Ambient-Context-Suppression respektieren (kein Seiten-Snapshot zwischen Steps)

### Enforcement Guidelines

**Alle KI-Agenten MUESSEN:**
- Neue Tools nach dem Tool Implementation Pattern aufbauen (Zod-Schema, Handler, Registry-Eintrag, Co-located Test)
- Fehler als MCP-Response zurueckgeben, nicht als throw
- Tool-Descriptions mit Negativ-Abgrenzung versehen
- Tests mit `npm test` verifizieren bevor eine Story als fertig gilt
- Token-Impact pruefen bei Aenderungen an registry.ts oder read-page.ts

**Anti-Patterns:**
- Tool A importiert Tool B → Shared Logic nach utils extrahieren
- `console.log` fuer Debugging → Logs gehen nach stderr, nicht nach stdout (MCP-Transport)
- Neue Abhaengigkeit in package.json → Muss zwingend begruendet werden (aktuell nur 4 Runtime-Deps)
- CDP-Calls direkt ueber WebSocket statt ueber session.send

## Project Structure & Boundaries

### Complete Project Directory Structure

```
PublicBrowser/
├── package.json              # public-browser v2.0.0
├── tsconfig.json             # TypeScript Strict, ESM
├── vitest.config.ts          # Test-Konfiguration
├── eslint.config.js          # Linting
├── LICENSE                   # MIT
├── README.md                 # Getting-Started, Tool-Uebersicht
├── CLAUDE.md                 # MCP-Server-Instruktionen
├── prompt.md                 # MCP Server Instructions (LLM-Steering)
│
├── src/
│   ├── index.ts              # Entry-Point: CLI-Parsing, Server-Start
│   ├── server.ts             # MCP-Server-Setup (SDK-Initialisierung)
│   ├── registry.ts           # Tool-Registry (94 KB): Definitionen, Profile, Steering
│   ├── types.ts              # Shared TypeScript-Typen
│   ├── version.ts            # Versionsnummer
│   │
│   ├── cdp/                  # Chrome DevTools Protocol Layer
│   │   ├── cdp-client.ts     # WebSocket-Client (ws Library)
│   │   ├── browser-session.ts # Session-Verwaltung pro Tab
│   │   ├── session-manager.ts # OOPIF Session-Manager
│   │   ├── chrome-launcher.ts # Auto-Launch + --attach
│   │   ├── protocol.ts       # CDP-Typen und Hilfsfunktionen
│   │   ├── settle.ts         # Page-Load/Navigation-Settle-Logik
│   │   ├── emulation.ts      # Viewport, webdriver-Maskierung
│   │   ├── dialog-handler.ts # alert/confirm/prompt Handling
│   │   ├── dom-watcher.ts    # DOM-Mutation-Listener
│   │   ├── console-collector.ts # Console-Log-Aggregation
│   │   ├── network-collector.ts # Network-Event-Sammlung
│   │   ├── download-collector.ts # Download-Event-Tracking
│   │   └── debug.ts          # CDP-Debug-Logging
│   │
│   ├── tools/                # MCP-Tool-Implementierungen (1 File = 1 Tool)
│   │   ├── read-page.ts      # → view_page: A11y-Tree mit Refs
│   │   ├── screenshot.ts     # → capture_image: WebP-Kompression
│   │   ├── click.ts          # → click: Ref/Selector/Text
│   │   ├── type.ts           # → type: Texteingabe
│   │   ├── fill-form.ts      # → fill_form: Multi-Field
│   │   ├── scroll.ts         # → scroll: Page/Container
│   │   ├── wait-for.ts       # → wait_for: Element/Network/JS
│   │   ├── evaluate.ts       # → evaluate: JS-Execution
│   │   ├── navigate.ts       # → navigate: URL-Navigation
│   │   ├── run-plan.ts       # → run_plan: Batch-Execution
│   │   ├── tab-status.ts     # → tab_status: Cache-Hit
│   │   ├── observe.ts        # → observe: MutationObserver
│   │   ├── download.ts       # → download: Status/History
│   │   ├── switch-tab.ts     # → switch_tab: Pro
│   │   ├── virtual-desk.ts   # → virtual_desk: Pro
│   │   ├── press-key.ts      # → press_key: Pro
│   │   ├── drag.ts           # → drag: Drag-and-Drop
│   │   ├── handle-dialog.ts  # → handle_dialog: Alert/Confirm
│   │   ├── console-logs.ts   # → console_logs: Log-Abfrage
│   │   ├── network-monitor.ts # → network_monitor: Request-Tracking
│   │   ├── file-upload.ts    # → file_upload: Input[type=file]
│   │   ├── configure-session.ts # → configure_session: Viewport etc.
│   │   ├── dom-snapshot.ts   # DOM-Snapshot-Hilfsfunktionen
│   │   ├── element-utils.ts  # Shared: Ref-Aufloesung, Selector-Parsing
│   │   ├── error-utils.ts    # Shared: MCP-Fehlerformatierung
│   │   └── visual-constants.ts # Shared: Viewport-Groessen, Breakpoints
│   │
│   ├── plan/                 # run_plan Execution Engine
│   │   ├── plan-executor.ts  # Step-fuer-Step Ausfuehrung
│   │   ├── plan-conditions.ts # Bedingte Ausfuehrung (if_visible etc.)
│   │   ├── plan-state-store.ts # Variablen-Speicher zwischen Steps
│   │   └── plan-variables.ts # Variable-Interpolation in Plans
│   │
│   ├── cache/                # State-Caching
│   │   ├── tab-state-cache.ts # Tab-Status-Cache (0ms Abfrage)
│   │   ├── a11y-tree.ts      # A11y-Tree-Cache + Builder
│   │   ├── prefetch-slot.ts  # Speculative Prefetch Storage
│   │   ├── deferred-diff-slot.ts # Deferred DOM-Diff
│   │   ├── selector-cache.ts # CSS-Selector-Cache
│   │   └── session-defaults.ts # Session-Default-Werte
│   │
│   ├── hooks/                # Lifecycle-Hooks
│   │   └── default-on-tool-result.ts # Ambient-Context, DOM-Diff, Cortex-Pattern-Recording
│   │
│   ├── cortex/               # Selbstlernende Wissensschicht
│   │   ├── pattern-recorder.ts # Zeichnet erfolgreiche Sequenzen auf (Seitentyp-basiert)
│   │   ├── local-store.ts     # Lokaler Merkle Log (WASM oder native)
│   │   ├── hint-matcher.ts    # Seitentyp-Matching + Markov-Vorhersage fuer Cortex-Hints
│   │   ├── page-classifier.ts # A11y-Tree → Seitentyp (regelbasiert, deterministisch)
│   │   ├── markov-table.ts    # Uebergangstabelle: P(next_tool | last_tool, page_type)
│   │   ├── bundle-loader.ts   # Download + Verifikation des Community-Bundles
│   │   ├── telemetry-upload.ts # Opt-in Upload anonymisierter Patterns (Seitentyp, keine Domain)
│   │   └── cortex-types.ts    # Pattern (PageType), Bundle (Markov-Tabelle), MerkleProof Typen
│   │
│   ├── transport/            # MCP-Transport-Layer
│   │   ├── pipe-transport.ts # stdio (Default)
│   │   ├── transport.ts      # Transport-Interface
│   │   └── websocket-transport.ts # WebSocket (fuer SSE)
│   │
│   ├── cli/                  # CLI-Subcommands (version, status, help)
│   │   └── top-level-commands.ts # Subcommands: version, status, help (NICHT --attach/--script — die werden in index.ts geparst)
│   │
│   ├── overlay/              # Visual Debugging
│   │   └── session-overlay.ts
│   │
│   └── telemetry/            # Telemetrie (lokal, NFR18)
│       └── tool-sequence.ts  # Tool-Nutzungs-Tracking
│
├── scripts/                  # Build- und Analyse-Scripts
│   ├── publish.ts            # npm publish + GitHub Release
│   ├── dev-mode.sh           # Dev-Mode Toggle
│   ├── token-count.mjs       # Token-Zaehlung fuer Budgets
│   ├── tool-list-tokens.mjs  # Tool-Definition Token-Messung
│   ├── run-plan-delta.mjs    # Benchmark-Forensik
│   └── visual-feedback.mjs   # Visual-Feedback-Analyse
│
├── cortex-validator/          # Rust-Projekt (WASM-Validator, deterministisch)
│   ├── Cargo.toml
│   ├── src/
│   │   └── main.rs           # Validierungslogik
│   └── flake.nix             # Nix-Build fuer Reproduzierbarkeit
│
├── python/                   # Script API (Python-Package)
│   ├── publicbrowser/        # Package-Verzeichnis
│   │   ├── __init__.py       # Public API: Chrome, Page
│   │   ├── chrome.py         # Chrome.connect(port) — CDP-Verbindung
│   │   ├── page.py           # Page-Klasse: navigate, click, fill, type, wait_for, evaluate, download
│   │   └── cdp.py            # Minimaler CDP-Client (websockets)
│   ├── pyproject.toml        # Package-Metadata, Dependencies (websockets)
│   └── tests/                # Python-Tests
│
├── test-hardest/             # Benchmark-Suite (35 Tests, 4 Levels)
├── docs/                     # Research, Friction-Fixes, Deferred Work
│   └── research/             # 5 Research-Dokumente
└── marketing/                # Marketing-Assets
```

### Architectural Boundaries

**Boundary 1: CDP ↔ Tools**
- `src/cdp/` liefert die rohe Chrome-Verbindung, kennt keine MCP-Konzepte
- `src/tools/` nutzt CDP-Sessions, kennt keine CDP-Interna (nur `session.send()`)
- Verbindung: `browser-session.ts` gibt Session-Objekte an Tools weiter

**Boundary 2: Tools ↔ Registry**
- Jedes Tool exportiert Handler + Schema
- `registry.ts` assembliert alles: Definitions, Profile, MCP-Export
- Tools wissen nicht ob sie im Default-Profil sichtbar sind

**Boundary 3: Plan ↔ Tools**
- `plan/plan-executor.ts` ruft Tool-Handler direkt auf (nicht ueber MCP)
- Plan-Engine unterdrueckt Ambient-Context-Hooks zwischen Steps
- Tools wissen nicht ob sie innerhalb eines Plans laufen (ausser ueber Context-Flag)

**Boundary 4: Cortex ↔ Tools**
- `cortex/` ist read-only fuer Tools — Tools lesen Cortex-Hints, schreiben nicht direkt
- `cortex/pattern-recorder.ts` wird als Hook nach erfolgreichen Tool-Calls aufgerufen (wie Ambient-Context)
- `cortex/bundle-loader.ts` laeuft beim Server-Start, blockiert maximal 2s (NFR19)
- `cortex/hint-matcher.ts` wird von navigate und view_page abgefragt — einzige zwei Integration Points
- Kein Tool importiert cortex/ direkt — alles laeuft ueber hooks/ und die Response-Integration in navigate/read-page

**Boundary 5: Cache ↔ Alles**
- `cache/` ist rein passiv — wird befuellt und abgefragt
- Tab-State-Cache macht tab_status 0ms-faehig
- A11y-Tree-Cache + Prefetch-Slot ermoeglichen Speculative Prefetch

**Boundary 6: Script API ↔ Server**
- `python/` kommuniziert mit dem Public-Browser-Server, der Tool-Calls intern ausfuehrt — kein direkter CDP-Zugriff (ausser Escape-Hatch)
- Script API nutzt die Tool-Handler des Servers (Shared Core) — gleicher Code-Pfad wie MCP-Tools
- Der Server verwaltet Chrome, CDP-Sessions und Tab-Isolation
- `--script` CLI-Flag signalisiert dem Server externe Script-Clients zu tolerieren

**Boundary 7: Cortex ↔ Externe Systeme**
- `cortex/telemetry-upload.ts` kommuniziert ueber HTTPS mit dem Collection-Endpoint — opt-in, Rate-Limited
- `cortex/bundle-loader.ts` laedt Bundles von OCI Registry (ORAS, SHA-256 Content-Addressed)
- Signatur-Verifikation erfolgt lokal (Sigstore Cosign Keyless, Rekor Transparency Log)
- `cortex-validator/` (Rust/WASM) ist ein separater Build-Schritt, wird vom CI als WASM-Modul bereitgestellt — nicht zur Node.js-Laufzeit kompiliert

### FR-Kategorie → Modul-Mapping

| FR-Kategorie | Primaeres Modul | Sekundaere Module |
|---|---|---|
| Page Reading (FR1-5) | tools/read-page, cache/a11y-tree | cdp/session-manager |
| Element Interaction (FR6-11) | tools/click, type, fill-form, scroll, press-key, drag | tools/element-utils |
| Execution (FR12-16) | plan/plan-executor, tools/run-plan | hooks/, cache/ |
| Tab Management (FR17-18) | tools/switch-tab, virtual-desk | cache/tab-state-cache |
| Download (FR19-20) | tools/download | cdp/download-collector |
| Connection (FR21-24) | cdp/chrome-launcher, cdp-client | cdp/session-manager |
| Tool Steering (FR25-29) | registry.ts, hooks/ | telemetry/tool-sequence |
| Distribution (FR30-31) | cli/, scripts/publish.ts | — |
| Script API (FR34-39) | python/publicbrowser/, Script-API-Gateway | src/tools/ (Shared Core), src/cli/ (--script Flag) |
| Cortex (FR40-46) | cortex/ | hooks/ (Pattern-Recording), tools/navigate + read-page (Hints) |

### Data Flow

```
LLM ──stdio──→ MCP SDK ──→ server.ts ──→ registry.ts ──→ tool handler
                                                              │
                                                    session.send()
                                                              │
                                              cdp-client.ts ──ws──→ Chrome
```

Fuer run_plan:
```
LLM ──→ run_plan tool ──→ plan-executor ──→ tool1 → tool2 → ... → toolN
                              │                                      │
                              └── suppress hooks ──── aggregate ─────┘
                                                          │
                                                    single response ──→ LLM
```

Fuer Script API (Shared Core — gleicher Server, gleiche Tool-Handler):
```
Python Script ──→ Public Browser Server ──→ Tool Handler ──→ CDP ──→ Chrome
                   (auto-gestartet)          (shared mit MCP)     (eigener Tab)

LLM ──stdio──→ MCP SDK ──→ server.ts ──→ registry.ts ──→ Tool Handler ──→ CDP ──→ Chrome
                                                              │                (MCP-Tab)
                                                         gleicher Code
```

Fuer Cortex (Learning → Distribution → Consumption):
```
Erfolgreicher Tool-Call ──→ hooks/ ──→ cortex/pattern-recorder.ts
                                              │
                                              ▼
                                    cortex/local-store.ts (Merkle Log, lokal)
                                              │
                                              ▼ (opt-in)
                                    cortex/telemetry-upload.ts ──HTTPS──→ Collection-Endpoint
                                                                                │
                                                                    (taeglich, CI)
                                                                                ▼
                                                                    WASM-Validator → Sigstore → OCI
                                                                                │
                                    cortex/bundle-loader.ts  ←──────────────────┘
                                    (beim Server-Start, max 2s)
                                              │
                                              ▼
                                    cortex/hint-matcher.ts ──→ navigate/view_page Response
```

## Architecture Validation Results

### Coherence Validation

**Decision Compatibility: ✅ Keine Konflikte**
- TypeScript + Node.js 22+ + ESM + tsc → konsistentes Build-System
- ws Library + CDP direkt → keine Framework-Konflikte
- MCP SDK + stdio → Standard-Transport, keine Inkompatibilitaeten
- Zod fuer Schema-Validation → einheitlich in Tools und Plan-Engine
- Vitest + co-located Tests → kein Test-Framework-Konflikt

**Pattern Consistency: ✅ Durchgehend**
- kebab-case Dateien, camelCase Funktionen, PascalCase Typen → konsistent ueber alle Module
- Ein-Tool-pro-Datei Pattern → durchgehend in src/tools/
- MCP-Response-Format → einheitlich ueber error-utils.ts
- CDP-Zugriff nur ueber session.send() → durchgehend respektiert

**Structure Alignment: ✅ Boundaries eingehalten**
- cdp/ kennt keine MCP-Konzepte, tools/ kennt keine CDP-Interna
- plan/ ruft Tools direkt auf, nicht ueber MCP-Layer
- cortex/ ist read-only fuer Tools, Integration nur ueber hooks/ und navigate/read-page
- cache/ ist passiv, keine zirkulaeren Abhaengigkeiten

### Requirements Coverage Validation

**Functional Requirements (46 FRs):**

| Status | Anzahl | FRs |
|---|---|---|
| ✅ Architektonisch unterstuetzt | 28 | FR1-10, FR12-24, FR26-28, FR30-31 |
| ⚠️ Unterstuetzt, Implementierung pruefen | 3 | FR11 (Drag-and-Drop), FR25 (Anti-Pattern v2), FR29 (DOM-Diff) |
| 🔄 v1 implementiert, v2 (Shared Core) ausstehend | 6 | FR34-39 (Script API) |
| 🆕 Architektur definiert, Implementierung ausstehend | 7 | FR40-46 (Cortex) |

- FR11: `tools/drag.ts` existiert, aber deferred-work.md listet HTML5-Drag-API-Limitation
- FR25: Basis-Anti-Pattern existiert (BUG-018), Story 23.1 plant v2 mit drei neuen Detections
- FR29: DOM-Diff via `hooks/default-on-tool-result.ts` + `cache/deferred-diff-slot.ts` vorhanden
- FR34-39: Script API v1 implementiert (Epic 9, 6 Stories, v1.0.0). v2-Umbau auf Shared Core geplant.
- FR40-46: Cortex-Architektur in diesem Dokument definiert (src/cortex/, 6 Dateien + cortex-validator/). Epic 12+13.

**Non-Functional Requirements (21 NFRs):**

| Status | Anzahl | NFRs |
|---|---|---|
| ✅ Architektonisch unterstuetzt | 15 | NFR1-10, NFR12-15, NFR16 |
| ⚠️ Zu verifizieren | 2 | NFR11 (Chrome 120+), NFR17 (Cortex-Telemetrie opt-in) |
| 🆕 Architektur definiert, Implementierung ausstehend | 4 | NFR18 (CDP-Koexistenz), NFR19-21 (Cortex-Integritaet) |

### Implementation Readiness Validation

**Decision Completeness: ✅**
- 6 Kern-Entscheidungen dokumentiert mit Rationale (Free/Pro Gating → Cortex ersetzt)
- Cortex-Architektur vollstaendig definiert (Module, Integration Points, Data Flow, externe Boundaries)
- Technologie-Versionen aus bestehendem Code (kein Raten)

**Structure Completeness: ✅**
- Vollstaendiger Directory-Tree aktualisiert (license/ entfernt, cortex/ + cortex-validator/ hinzugefuegt)
- 7 Boundary-Definitionen mit klaren Regeln (2 neu: Cortex ↔ Tools, Cortex ↔ Externe Systeme)
- FR → Modul-Mapping aktualisiert (10 Kategorien inkl. Cortex)

**Pattern Completeness: ✅**
- 7 Naming-Konventionen, 4 CDP-Call-Regeln, 5 Error-Handling-Regeln
- Tool-Description-Pattern mit konkreten Beispielen
- run_plan-Step-Pattern mit 4 Anforderungen
- 5 Anti-Patterns dokumentiert

### Gap Analysis

**Kritische Luecken: Keine**

**Wichtige Luecken:**

1. **Cortex Dependency-Entscheidung (Epic 12)** — WASM-Runtime fuer Merkle-Log (ct-merkle als WASM oder native Dependency) muss bei Story-Erstellung entschieden werden. Optionen: (a) reines TypeScript Merkle-Log, (b) Rust-WASM-Modul, (c) native Rust-Dependency via N-API.

2. **Cortex Collection-Endpoint Infrastruktur (Epic 13)** — Server-Infrastruktur fuer Pattern-Collection noch nicht spezifiziert. Optionen: (a) GitHub Pages als statische Bundle-Distribution, (b) minimaler HTTPS-Endpoint (Cloudflare Workers / Vercel Edge), (c) OCI Registry direkt.

3. **registry.ts Maintainability** — 94 KB in einer Datei. Bei Community-Growth evaluieren.

4. **BUG-003 Dokumentation** — WebSocket Accept-Check Workaround muss im README stehen.

**Nice-to-Have:**
- CI/CD-Pipeline fuer Cortex-Bundle (taeglich: Validierung → Signierung → Distribution)
- Monitoring-Dashboard fuer Cortex-Gesundheit (rekor-monitor Integration)

### Architecture Completeness Checklist

**✅ Requirements Analysis**
- [x] Projekt-Kontext analysiert (v1.3.0 → v2.0.0, 22 Epics, Brownfield)
- [x] Komplexitaet bewertet (Medium)
- [x] Technische Constraints identifiziert (CDP, Node 22, MCP)
- [x] Cross-Cutting Concerns gemappt (5 Concerns)

**✅ Architectural Decisions**
- [x] 6 Kern-Entscheidungen mit Rationale dokumentiert (Cortex ersetzt Free/Pro Gating)
- [x] Tech-Stack vollstaendig spezifiziert (inkl. Cortex: Rust/WASM, Sigstore, OCI)
- [x] Integration Patterns definiert (7 Boundaries, inkl. Cortex ↔ Tools und Cortex ↔ Externe)
- [x] Performance-Anforderungen adressiert (NFR1-6)

**✅ Implementation Patterns**
- [x] Naming Conventions (7 Kategorien)
- [x] Tool Implementation Pattern
- [x] CDP Call Pattern
- [x] Error Handling Pattern
- [x] Tool Description Pattern (LLM-Steering)
- [x] run_plan Step Pattern

**✅ Project Structure**
- [x] Vollstaendiger Directory-Tree (70+ Dateien, cortex/ + cortex-validator/ hinzugefuegt)
- [x] 7 Boundary-Definitionen
- [x] FR → Modul-Mapping (8 Kategorien)
- [x] Data-Flow-Diagramme (Standard + run_plan)

### Architecture Readiness Assessment

**Overall Status: READY FOR IMPLEMENTATION (aktualisiert 2026-04-26)**

**Confidence Level: HIGH** — Brownfield-Projekt bei v1.3.0. Epic 1-9 v1 implementiert. Architecture aktualisiert fuer Public Browser Pivot: Pro/License entfernt, Cortex-Subsystem definiert.

**Staerken:**
- Minimale Dependency-Liste (4 Runtime-Deps, Cortex-Deps kommen inkrementell)
- Klare Modul-Boundaries (7 definiert, inkl. 2 neue fuer Cortex)
- Deterministische run_plan-Engine (jetzt unbegrenzte Steps)
- Drei-Schichten Tool-Steering
- Cortex-Architektur mit klarer Separation (read-only fuer Tools, Hook-basiertes Recording)

**Bereiche fuer spaetere Verbesserung:**
- registry.ts Aufspaltung (bei Community-Growth)
- CI/CD-Pipeline fuer Cortex-Bundle
- Cortex Collection-Endpoint Infrastruktur

### Implementation Handoff

**KI-Agent-Richtlinien:**
- Alle Architektur-Entscheidungen exakt wie dokumentiert befolgen
- Implementation Patterns konsistent ueber alle Komponenten anwenden
- Projekt-Struktur und Boundaries respektieren
- Dieses Dokument als Referenz fuer alle architektonischen Fragen nutzen

**Implementation-Prioritaet:**
1. Epic 11: Public Browser Migration — Pro-Gates entfernen, License entfernen, Rename, v2.0.0
2. Epic 12: Cortex Phase 1 — Pattern-Recorder, Merkle Log, Cortex-Hints, Telemetrie-Upload — DONE
3. Epic 12a: Cortex Pattern Generalization — Seitentyp-Klassifikator, Markov-Tabelle, Retrofit
4. Epic 13: Cortex Phase 2 — WASM-Validator, Sigstore, OCI Distribution, Canary-Deployment
5. Script API v2: Shared Core Umbau (Epic 9, Stories 9.7-9.11)
6. Story 23.1/6.1 (evaluate Anti-Spiral v2) — deferred
