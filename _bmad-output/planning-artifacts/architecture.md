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
completedAt: '2026-04-11'
lastStep: 8
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/product-brief-SilbercueChrome.md
  - _bmad-output/planning-artifacts/product-brief-SilbercueChrome-distillate.md
  - _bmad-output/planning-artifacts/sprint-change-proposal-2026-04-11-operator.md
  - docs/vision/operator.md
  - docs/research/run-plan-forensics.md
  - docs/research/llm-tool-steering.md
  - docs/research/form-recognition-libraries.md
  - docs/research/speculative-execution-and-parallelism.md
  - docs/research/competitor-internals-stagehand-browser-use.md
workflowType: 'architecture'
project_name: 'SilbercueChrome'
user_name: 'Julian'
date: '2026-04-11'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements.** Das PRD definiert 38 Functional Requirements in 8 Capability Areas, die sich in fuenf architektonische Kern-Einheiten clustern lassen: Die **Scan-Match-Pipeline** (FR1-FR6) extrahiert strukturelle DOM-Signale, berechnet Match-Scores gegen die Seed-Bibliothek, prueft Gegen-Signale und produziert eine Seitenlesart mit eingebetteten Karten-Annotationen. Der **Operator-Execution-Loop** (FR7-FR11) nimmt die Karten-Auswahl vom LLM entgegen, fuehrt mechanisch aus, buendelt den Folge-Seiten-Scan in denselben Return und haelt die Kette robust bei Navigations-Ereignissen. Die **Fallback-Transition-Engine** (FR12-FR16) wechselt das Tool-Set bei fehlendem Muster, registriert strukturelle Signaturen und kommuniziert den Wechsel mit explizitem Framing. Der **Audit-Layer** (FR22-FR25) produziert `why_this_card`-Felder mit Signal-Breakdown, Score, Schwelle und Gegen-Signal-Check-Ergebnissen. Das **Card-Data-Model** (FR26-FR30) definiert ein textbasiertes, Git-pflegbares Karten-Format plus Test-Harness fuer Benchmark- und Produktionsseiten-Validation.

**Session-und Tab-Verwaltung** (FR17-FR21), **Lizenzierung und Distribution** (FR31-FR34) und **Migration und Onboarding** (FR35-FR38) sind architektonisch nicht neu: Session/Tab nutzt die bestehende Brownfield-Schicht mit CDP-Direct-Bindung, Lizenz uebernimmt das Polar.sh-Modell von SilbercueSwift, Migration ist eine Doku-Angelegenheit, nicht eine Code-Angelegenheit.

**Non-Functional Requirements.** 18 NFRs in 5 Kategorien geben die Messlatten vor, an denen die Architektur sich bewaehren muss. Drei Performance-Budgets sind dabei architektur-formend: **Tool-Definition-Overhead unter 3000 Tokens** (NFR1), **Operator-Return-Latenz unter 800 Millisekunden** (NFR2) und **Erkennungs-Rate ueber 85 Prozent** (NFR4). Die ersten beiden begrenzen, wie grosszuegig der Return strukturiert sein darf — jede zusaetzliche Metadaten-Zeile in `why_this_card` kostet Bytes und Denkzeit. Der dritte zwingt die Container-Aggregations-Schicht zu echter algorithmischer Qualitaet, nicht zu naiver Pattern-Suche.

Security-NFRs sind ueberschaubar (Lokal-Scope, keine Compliance), Scalability ist auf *"Ein Nutzer, ein Prozess"* geschnitten, Reliability steht und faellt mit dem sauberen Fallback-Uebergang, Integration ist auf **Stdio-MCP** und **CDP 1.3+** beschraenkt.

**Scale & Complexity.** Das Produkt ist **Medium-High** in der Komplexitaet. *Medium*, weil es ein lokaler Ein-Prozess-MCP-Server ohne Datenbank, ohne verteilte Komponenten und ohne Compliance-Regime ist. *High*, weil die Container-Aggregations-Schicht ein echter Neuland-Teil ist, der keine direkte Open-Source-Referenz hat — Chromium-Feldtypen und Fathom liefern Bausteine, aber die Aggregation zu Muster-Klassen-Signaturen muss erstmalig entworfen werden.

- **Primary technical domain:** Developer-Tool / MCP-Server / Library-Hybrid mit Node.js-Runtime und direktem Chrome-DevTools-Protocol-Zugriff
- **Complexity level:** Medium-High (lokale Systeme, aber algorithmisches Neuland in einem Kern-Modul)
- **Geschaetzte architektonische Komponenten:** Fuenf neue Kern-Module (Scan-Match, Execution-Loop, Fallback-Transition, Audit-Layer, Card-Data-Model) plus Bestandscode fuer Session/Tabs/CDP/Lizenz
- **Typ der Arbeit:** Brownfield-Extension — 17 Epics historische Basis bleiben unveraendert, Epic 18 (Forensik-Fixes) und Epic 19 (Kartentisch + Seed + Fallback) sind das neue Scope

### Technical Constraints & Dependencies

**Runtime und Sprache.** Node.js 18+ (aktueller Stand der `package.json`), TypeScript als Implementierungssprache, `tsc`-basierter Build ohne Bundler-Umwege. Testframework Vitest mit rund 1100 bestehenden Unit-Tests, die durch den Pivot hindurch bestehen bleiben muessen.

**Browser-Anbindung.** Direkte Chrome-DevTools-Protocol-Anbindung ueber Stdio-Transport oder WebSocket, **kein Playwright-Umweg**, **kein Headless-Zwang** (Auto-Launch startet Chrome sichtbar mit allen Flags fuer zuverlaessige Screenshots). CDP-Version 1.3 als Minimum, real getestet bis Chrome 146. Connection-Modes: Auto-Launch als Zero-Config-Default, WebSocket optional fuer User-eigenen Chrome, expliziter Fehler wenn beides nicht geht.

**MCP-Protokoll.** Stdio-Transport nach Spezifikation, kompatibel mit allen Standard-MCP-Clients (Claude Code, Cursor, Claude Desktop, custom clients). Kein client-spezifisches Custom-Protokoll. Tool-Definition-Overhead-Budget unter 3000 Tokens zwingt zur Entschlankung der exportierten Tool-Liste auf zwei Top-Level-Tools (`virtual_desk`, `operator`) plus Fallback-Primitives.

**Basis-Libraries fuer Container-Aggregation.** Chromium-Feldtypen (118 Klassifikationen, BSD-3-Clause-lizenziert) und Mozilla Fathom-Rulesets (MIT-lizenziert) als Bausteine der Scan-Match-Pipeline. Beide permissiv, beide im Free-Open-Source- und Pro-Proprietaer-Modell vertraeglich, Attribution in NOTICE-Datei zwingend. Die Aggregations-Schicht **oben drueber** ist Eigenentwicklung — hier gibt es kein fertiges Ruleset, das Muster-Klassen-Signaturen direkt produziert.

**Lizenz-Gateway.** Polar.sh-Integration fuer den Pro-Build, uebernommen aus SilbercueSwift-Modell, eigene Org-ID, getrennte License-Keys. Sieben Tage Offline-Grace-Period. Free-Build lizenziert unter MIT, enthaelt den vollen Kartentisch-Mechanismus.

**Brownfield-Constraints.** Die 17 historischen Epics bleiben unveraendert: Session-Modell mit Refs-System, Accessibility-Tree-Abstraktion, Tab-Management, Connection-Recovery, alle bestehenden 25 Tools des Werkzeugkastens bleiben **intern als Bausteine** erhalten. Epic 18/19 baut **auf** dieser Basis auf, schneidet aber kein Feature weg. Der alte `run_plan`-Tool-Kontext bleibt als internes Sicherheitsnetz und produkt-weiter Worst-Case-Fallback verfuegbar.

**Zeit- und Ressourcen-Constraints.** Solo-Maintainer, 7-plus-45-Tage-Zeitbox. Das ist nicht nur eine Projekt-Management-Randbedingung, sondern eine Architektur-Randbedingung: Jedes Modul muss **solo-pflegbar** sein. Architekturen, die drei Tage Onboarding fuer Code-Reader brauchen oder zwei Tage Debug-Zeit pro Fehlerklasse verursachen, sind strukturell unvertraeglich.

### Cross-Cutting Concerns Identified

**Audit-Transparenz als durchgaengige Anforderung.** Das `why_this_card`-Feld ist nicht ein Feature des Audit-Moduls, sondern ein **Architektur-Invariant**: Jede Karten-Annotation im Return muss den Signal-Breakdown mitbringen, jeder Fallback-Log muss strukturell gleichwertig sein zum Standard-Modus-Log. Die Audit-Schicht laesst sich nicht sauber als *"eigenes Modul am Rand"* modellieren — sie ist tief in Scan-Match und Fallback-Engine verwoben.

**Performance-Budget als Gate fuer jede Entscheidung.** Die drei harten NFRs (Token-Overhead, Return-Latenz, Erkennungs-Rate) wirken wie eine **Ressourcen-Steuer** auf jede Architektur-Entscheidung. Jede zusaetzliche Metadaten-Zeile, jeder zusaetzliche Erkennungs-Signal-Check, jede zusaetzliche Indirektion im Loop kostet in einem oder mehreren dieser Budgets. Der Architekt muss jedes Feature gegen diese drei Budgets rechnen.

**Struktur-statt-Seite als Invariante.** Karten duerfen niemals seiten-spezifisch werden. Die Architektur muss dies strukturell erzwingen — keine URL-Matcher im Karten-Format, keine Domain-Whitelisting in der Match-Logik, keine Inhalts-spezifische Signale in den Erkennungs-Regeln. Die Muster-Klassen-Signatur ist die einzige Ebene, auf der Karten definiert werden duerfen. Das ist nicht nur eine Convention, es muss im Typ-System und in den Validierungs-Tests erzwungen werden.

**Phase-2-Bridge als MVP-Constraint.** Das Karten-Datenmodell, das Signatur-Registrierungs-Format im Fallback, die Audit-Struktur und die Harvester-Hook-Stellen im Klient-Code muessen schon im MVP so gebaut sein, dass der spaetere Harvester (Epic 20) ohne Schema-Migration und ohne Typ-System-Eingriff ankoppeln kann. Das betrifft Datenformate, Naming-Conventions und Module-Boundaries — nicht Feature-Umfang. Die Hook-Stellen sind in Phase 1 inaktiv, aber strukturell vorbereitet.

**Solo-Pflegbarkeit als hart begrenzende Meta-Dimension.** Jede Architektur-Entscheidung wird durch den Solo-Filter gezogen: Kann Julian dieses Modul in zwei Wochen ohne fremde Hilfe verstehen, aendern, debuggen? Kann er in einem Tag eine Regression diagnostizieren? Kann er die Logik in zehn Saetzen in der README erklaeren? Wenn nein, ist die Entscheidung unabhaengig von ihrer technischen Eleganz unvereinbar mit dem Setup.

**Fallback als erstklassiger Zustand, nicht als Fehler-Klasse.** Die Architektur muss den Fallback-Modus **gleichberechtigt** zum Standard-Modus modellieren. Kein `try/catch`-Wrapper um den Kartentisch, sondern ein echter State-Machine-Uebergang mit eigenem Return-Schema und eigenem Tool-Kontext. Jeder Teil des Systems, der Karten beruehrt, muss den Fallback-Fall als Normalitaet behandeln.

## Starter Template Evaluation

### Primary Technology Domain

Developer-Tool / MCP-Server / Library-Hybrid auf Node.js-Basis mit direkter Chrome-DevTools-Protocol-Anbindung. Das entspricht keinem der Web-App-, Mobile-App- oder Full-Stack-Buckets, die typische Starter-Templates abdecken (Next.js, Vite, Expo, T3, RedwoodJS und so weiter). Der naechstliegende Bucket waere *"CLI tool / library"*, aber auch hier ist die Projekt-Topologie ein eher ungewoehnliches Hybrid: MCP-Server via Stdio-Transport, der einen externen Prozess (Chrome) steuert, mit Free/Pro-Distribution ueber npm und Node SEA Binary. Keine direkte Starter-Referenz.

### Starter Options Considered

**Option 1 — Greenfield-Start mit einem MCP-SDK-Template.** Das offizielle `@modelcontextprotocol/sdk` bietet Getting-Started-Snippets fuer neue MCP-Server. **Verworfen**: Wuerde bedeuten, die 17 Epics historische Basis zu verlieren — Session-Modell mit Refs-System, Accessibility-Tree-Caches, CDP-Direct-Client, Plan-Executor-Loop mit Variables/Conditions/State-Store, Polar.sh-Lizenz-Integration, SEA-Binary-Pipeline, rund 1100 Unit-Tests. Strukturell unvertraeglich mit dem PRD-Constraint *"Brownfield mit Kategorie-Wechsel, 17 Epics bleiben unveraendert"*.

**Option 2 — Fork der bestehenden Codebase in einen Operator-Branch.** Wuerde erlauben, parallel zur `master`-Linie zu entwickeln, ohne die v0.5.0-Produktlinie zu gefaehrden. **Verworfen**: Produziert einen Parallel-Zweig mit doppelter Pflege, Verlust der Benchmark-Kontinuitaet auf dem Test-Hardest-Parcours und eine spaetere Merge-Schlacht. In der 45-Tage-Zeitbox nicht tragbar.

**Option 3 — Extension der bestehenden `master`-Codebase mit neuen Modulen.** Epic 18 (Forensik-Fixes) und Epic 19 (Kartentisch, Seed-Bibliothek, Fallback) werden als neue Module in die bestehende TypeScript-Struktur eingefuegt. Bestehende Module bleiben funktional unveraendert und werden allenfalls in der exportierten Tool-Liste verschlankt. **Selected.**

### Selected Starter: SilbercueChrome Master-Branch (v0.5.0)

**Rationale.** Brownfield-Pivot laesst keinen echten Starter zu. Der Starter *ist* der bestehende Code. Was dieser Schritt stattdessen leistet, ist die vollstaendige Dokumentation dessen, was bereits festgelegt ist — damit die nachfolgenden Architektur-Entscheidungen auf einer expliziten Basis aufsetzen statt auf impliziten Annahmen.

**Initialization Command.** Keiner. Der bestehende Code unter `master` (Version 0.5.0) ist der Ausgangspunkt. Die Arbeit beginnt mit einem neuen Feature-Branch fuer Epic 18 und Epic 19, typisch `feat/epic-18-forensik-fixes` und `feat/epic-19-kartentisch` oder ein gemeinsamer `feat/operator-phase1`-Branch.

### Architectural Decisions Provided by the Existing Codebase

**Language & Runtime.**

- **TypeScript 5.7** mit strict mode, ESM-only (`"type": "module"` in `package.json`)
- **Node.js 18+** als Mindest-Version (`engines.node: ">=18"`), real getestet auf 20+
- **Build** ueber `tsc && chmod +x build/index.js` — **kein Bundler** (kein Webpack, kein Rollup, kein esbuild zur Laufzeit). Das SEA-Binary wird durch ein separates esbuild-basiertes Bundle erzeugt, aber die reine npm-Distribution nutzt den rohen `tsc`-Output.

**MCP-Framework und Transport.**

- **`@modelcontextprotocol/sdk` ^1.29** als einzige MCP-Library, offizielles Anthropic SDK
- **Stdio-Transport** ueber die SDK — keine custom Transport-Layer
- **`src/transport/`** enthaelt die Server-Transport-Setup-Logik, `src/server.ts` verdrahtet den MCP-Server mit der Tool-Registry

**CDP-Anbindung (Low-Level Browser Control).**

- **Direkte Implementierung** ueber `src/cdp/cdp-client.js` und `src/cdp/session-manager.js` — **keine externe CDP-Library** (kein `chrome-remote-interface`, kein `puppeteer`, kein `playwright`)
- Unterstuetzt sowohl **Auto-Launch** (Chrome als Kindprozess via `--remote-debugging-pipe`) als auch **WebSocket** (bestehender Chrome auf Port 9222)
- Die `src/cdp/`-Schicht ist die **einzige Stelle**, an der CDP-Messages direkt produziert oder konsumiert werden

**Tool-Registry und bestehende Tool-Liste.**

- **`src/registry.ts`** verwaltet die komplette Tool-Liste und exportiert sie an den MCP-Server
- Aktuelle Version exportiert rund 25 Tools — diese Liste wird in Epic 19 auf zwei Top-Level-Tools (`virtual_desk`, `operator`) plus Fallback-Primitives **verschlankt**, ohne die bestehenden Implementierungen unter `src/tools/` zu loeschen
- Die alten Tool-Implementierungen bleiben als **interne Bausteine** verfuegbar fuer die Karten-Ausfuehrung und fuer das `run_plan`-Sicherheitsnetz

**Plan-Executor-Loop (run_plan-Sicherheitsnetz).**

- **`src/plan/plan-executor.js`** plus **`plan-variables.js`**, **`plan-conditions.js`**, **`plan-state-store.js`**
- Dieser Loop bleibt im Code als interner Fallback-Mechanismus auf Produkt-Ebene (*"Worst-Case-Szenario"* aus dem PRD-Risk-Kapitel), wird aber in der Standard-Tool-Liste nicht mehr als LLM-Oberflaeche exportiert

**Cache-Schicht.**

- **`src/cache/a11y-tree.js`** — Accessibility-Tree-Cache fuer das bestehende `read_page`-Tool; wird fuer die neue Seitenlesart in Epic 19 **mit hoher Wahrscheinlichkeit weiterverwendet oder leicht erweitert** (genaue Entscheidung faellt in Schritt 4 der Architektur)
- **`src/cache/selector-cache.js`** — Selector-Cache, bleibt fuer die bestehenden Tool-Implementierungen relevant

**Testing-Framework.**

- **Vitest ^3** als Test-Framework mit rund 1100 bestehenden Unit-Tests (laut `CLAUDE.md`)
- **`npm test`** ruft `vitest run` auf
- Die neuen Module fuer Epic 18 und 19 muessen in dieses Test-Framework einfuegen — keine Parallel-Test-Infrastruktur

**Benchmark-Framework.**

- **`test-hardest/`** mit 35 Tests als lokaler Benchmark-Parcours
- **`npm run benchmark`** ruft `node test-hardest/benchmark-full.mjs` auf
- Der Parcours ist die einzige quantitative Instanz fuer MQS und Wall-Clock-Laufzeit — Epic 19 wird sich gegen diesen Parcours validieren muessen

**Linting und Formatierung.**

- **ESLint 9** plus **typescript-eslint 8** plus **Prettier 3** — Standard-Stack, bereits konfiguriert
- Hook-Extension-Punkt in `src/hooks/` fuer pre-commit und lint-staged falls noetig

**Lizenz- und Distributions-Pipeline.**

- **Polar.sh-Integration** ueber `src/license/` (aus Epic 16 etabliert)
- **`scripts/publish.ts`** als zentraler Release-Skript, der npm-Publish fuer Free und SEA-Binary-Build fuer Pro in einem Durchlauf erzeugt
- **`silbercuechrome-publish`**-Skill (im `.claude/skills/`-Ordner) automatisiert den Release-Flow

**Telemetrie-Hooks.**

- **`src/telemetry/`** existiert bereits, nutzt lokale Metriken-Erfassung ohne Netzwerk-Upload
- Kann als **Einbindepunkt** fuer die Phase-2-Harvester-Hook-Stelle vorbereitet werden, auch wenn der Harvester in Phase 1 inaktiv bleibt

**Overlay-Layer.**

- **`src/overlay/`** existiert, Zweck aktuell unklar — vermutlich Visual-Overlay fuer Debug-Markierungen auf der Chrome-Seite
- Nicht release-kritisch fuer Epic 19, aber verfuegbar falls benoetigt

**Zod-Schemas.**

- **`zod` ^3** als Schema-Validation-Library, bereits als Dependency installiert
- Naturbedingter Kandidat fuer die **Parameter-Schemas der Karten** und das **Operator-Return-Schema**, weil es im Stack ist und das Team (Julian) bereits damit arbeitet

**Screenshot-Vergleiche.**

- **`pixelmatch` ^7.1** plus **`pngjs` ^7** — fuer visuelle Regressions-Tests, verfuegbar falls die Seed-Karten-Validierung visuelles Feedback braucht

### Neu einzufuegende Module fuer Epic 18/19 (Erste Grobeinteilung)

Die Grobeinteilung der neuen Module fuer den Operator-Pivot, die spaeter in Schritt 4 (Architectural Decisions) verfeinert wird:

- **`src/operator/`** — der Operator-Execution-Loop mit State-Machine fuer Standard- und Fallback-Modus, inklusive der Bundling-Logik fuer Folge-Seiten-Scans
- **`src/cards/`** — Karten-Datenmodell, Seed-Bibliothek-Loader, Karten-Validierung
- **`src/scan/`** (Arbeitstitel) — die Container-Aggregations-Schicht, die Chromium-Feldtypen-Signale und Fathom-Rulesets zu Muster-Klassen-Signaturen verdichtet
- **`src/audit/`** — `why_this_card`-Generator, Signal-Breakdown-Formatter, Fallback-Log-Generator

Diese Module werden parallel zu den bestehenden `src/plan/`, `src/tools/` und `src/cdp/`-Verzeichnissen eingefuegt — nicht als Ersatz, sondern als Erweiterung.

**Note:** Die Projektinitialisierung ist bereits erfolgt (Version 0.5.0 ist released). Die erste Implementierungs-Story waere damit **nicht** eine Scaffolding-Story, sondern die **Entscheidung, wie der Operator-Branch aus `master` abgezweigt wird** und welche Forensik-Fixes aus Epic 18 zuerst landen.

## Core Architectural Decisions

### Decision Priority Analysis

**Critical (Block Implementation):** Card Data Model, Scan-Match-Pipeline Design, Operator Return Schema, Operator State Machine, Fallback-Mode Architecture.

**Important (Shape Architecture):** Audit-Layer-Integration, Testing und Benchmarking Integration, Phase-2-Bridge-Preparation, Neue-Module-Ordnerstruktur.

**Deferred / Bestehend (Don't re-decide):** License und Attribution (Polar.sh, NOTICE-Datei — aus Epic 16), Distribution (npm Free, SEA Binary Pro — aus silbercuechrome-publish-Skill), CDP-Client (bestehend in `src/cdp/`), MCP-Transport (`@modelcontextprotocol/sdk` Stdio — unveraendert), Cache-Schicht (`src/cache/a11y-tree.js` wird wiederverwendet oder leicht erweitert).

### Card Data Model

**Entscheidung:** YAML-Dateien, eine pro Karte, im Verzeichnis `cards/` des Repositories, validiert durch ein Zod-Schema beim Server-Start. Jede Karten-Datei enthaelt die Felder `id`, `name`, `description`, `structure_signature` (positive Signale mit Gewichten), `counter_signals` (Gegen-Signale mit Pflicht-Ebene), `parameters` (Zod-Schema-kompatibles Parameter-Schema fuer die Ausfuehrung), `execution_sequence` (Liste der internen Tool-Aufrufe), `version`, `author`, `source` (in Phase 1 immer `"seed"`), `harvest_count` (in Phase 1 immer `0`), `test_cases` (Liste von Test-URLs oder Benchmark-Parcours-Referenzen).

**Rationale:** YAML ist menschen-pflegbar, Git-freundlich durch Line-basiertes Diff, unterstuetzt Kommentare (wichtig fuer erklaerende Notizen an strukturell schwer unterscheidbaren Muster-Klassen wie Login vs. 2FA-Rescue), und liegt syntaktisch naeher an Karten als JSON oder TOML. Zod ist bereits im Stack und validiert zur Laufzeit, nicht erst zur Compile-Time. Die `source`- und `harvest_count`-Felder sind die Phase-2-Bruecke: Der spaetere Harvester kann Crowd-eingereichte Karten ohne Schema-Migration einfuegen.

**Verworfene Alternativen:** JSON (verliert Kommentar-Faehigkeit), TOML (schlechter bei verschachtelten Execution-Sequenzen), Markdown mit Frontmatter (verliert Schema-Validierung).

### Scan-Match-Pipeline Design

**Entscheidung:** Dreischicht-Pipeline mit klarer Verantwortungstrennung.

1. **Signal-Extractor** (`src/scan/signal-extractor.ts`) ruft Chromium-Feldtypen-Klassifikation und Fathom-Rulesets ueber die bestehende `src/cache/a11y-tree.js`-Schicht auf und produziert eine Liste von tagged Signals.
2. **Signal-Aggregator** (`src/scan/aggregator.ts`) konsolidiert Signale zu Struktur-Kandidaten durch Clustering nach DOM-Naehe und Typ-Aehnlichkeit.
3. **Card-Matcher** (`src/scan/matcher.ts`) vergleicht Struktur-Kandidaten gegen Seed-Karten-Signaturen, berechnet Match-Scores durch lineare Gewichtung (keine ML-Modelle), prueft Gegen-Signale, liefert annotierte Karten zurueck.

**Rationale:** Lineare Gewichtung ist erklaerbar (wichtig fuer das `why_this_card`-Audit-Feld), schnell (kein Inference-Overhead, passt zum 800ms-Return-Latenz-Budget) und solo-pflegbar (Julian kann in zehn Minuten verstehen, warum eine Karte gematcht hat). Die Dreischicht-Trennung erlaubt, jede Schicht einzeln zu testen und unabhaengig zu iterieren.

**Verworfene Alternativen:** Monolithische Scan-Schicht (nicht testbar), ML-basiertes Matching (Solo-Maintainer-unvertraeglich), Rules-Engine (schwerer zu debuggen).

### Operator Return Schema

**Entscheidung:** Ein einziges Zod-Schema mit folgender Struktur: `tab_context` (aktive Tab-ID, URL, Titel, Navigation-State), `page_tree` (hierarchischer Seitenbaum als Liste von Nodes mit `ref`-Handles, `type`, `content`, `children`), `mode` (`"standard"` oder `"fallback"`), `fallback_framing` (nur im Fallback-Modus belegt). **Karten-Annotationen sitzen direkt an der Node**, zu der sie gehoeren — als optionales `card`-Feld mit `name`, `description`, `parameters_schema` und eingebettetem `why_this_card`. Keine separate Karten-Liste oben.

**Rationale:** Die Einbettung der Karten direkt im Seitenbaum ist die zentrale Architektur-Entscheidung aus dem PRD-Dialog — *"Karten sind nicht daneben, sie sitzen am Element"*. Das Zod-Schema erzwingt die Struktur beim Serialize, und die LLM-lesbare Ausgabe wird durch die flache Hierarchie kompakt. Token-Budget-Ziel: Ein typischer Login-Page-Return liegt unter 1200 Tokens inklusive Audit-Feld.

**Verworfene Alternativen:** Separate `page_tree`- und `cards`-Arrays (zwingen zur Korrelations-Arbeit im LLM), flaches Karten-Array mit Tree-Position-Referenzen (Indirektions-Overhead).

### Operator State Machine

**Entscheidung:** Fuenf explizite States mit klaren Transitions.

1. `IDLE` — kein aktiver Operator-Call
2. `SCANNING` — Seite wird gescannt (Signal-Extractor + Aggregator + Matcher laufen)
3. `AWAITING_SELECTION` — Return ist an das LLM gegangen, wartet auf Karten-Auswahl oder Fallback-Primitive-Aufruf
4. `EXECUTING` — ausgewaehlte Karte wird mechanisch ausgefuehrt (inklusive Navigation-Warten)
5. `POST_EXECUTION_SCAN` — Folge-Seite wird gescannt, neuer Return wird vorbereitet; bei Abschluss Uebergang zu `AWAITING_SELECTION`

**Fallback als Flag:** Der Fallback-Modus ist kein eigener State, sondern ein Flag am `SCANNING`-State (`fallback=true`), das bewirkt, dass keine Karten annotiert werden und das `fallback_framing`-Feld im Return belegt wird.

**Rationale:** Explizite State Machines sind in TypeScript gut testbar, erlauben klare Assertions und produzieren lesbare Debug-Logs. Der Fallback als Flag statt als State vermeidet State-Explosion. Die `POST_EXECUTION_SCAN`-Phase ist der Kern-Bundling-Mechanismus — hier passiert die Einsparung der LLM-Denkzeit.

**Verworfene Alternativen:** Event-Emitter ohne explizite States (verliert Assertion-Qualitaet), Redux-artiger Reducer (overkill fuer Ein-User-System), Promise-basierte Chains ohne State (brechen unsauber bei Navigation-Fehlern).

### Fallback-Mode Architecture

**Entscheidung:** Die bestehenden Tool-Implementierungen aus `src/tools/` werden direkt wiederverwendet. Der Fallback-Modus exportiert sie ueber eine **separate Tool-Registry-Instanz** (`src/fallback-registry.ts`) mit nur `click`, `type`, `read`, `wait`, `screenshot` und optional `evaluate`. Der Wechsel zwischen Standard-Modus und Fallback-Modus nutzt die MCP-SDK-Funktion `notifications/tools/list_changed`, um dem Client die neue Tool-Liste dynamisch mitzuteilen.

**Muster-Signatur-Registrierung:** Jede Fallback-Sequenz wird in einem **In-Memory-Ringpuffer** aufgezeichnet (letzte 50 Fallback-Sessions, pro Session die DOM-Signale der Ausgangsseite plus die mechanischen Schritte). Kein persistentes Speichern in Phase 1, aber die Struktur der Eintraege folgt dem gleichen Schema wie Karten — damit der Harvester sie in Phase 2 ohne Schema-Bruch abgreifen kann.

**Rationale:** Wiederverwendung der bestehenden Tool-Implementierungen ist die einzige realistische Option in 45 Tagen. Die separate Registry zeigt nur auf dieselben Handlers. Dynamic Tool-List-Notification ist seit MCP-SDK 1.x spezifiziert und funktioniert in Claude Code, Cursor und Claude Desktop.

**Verworfene Alternativen:** Alle Tools immer aktiv lassen und Fallback via Prompt-Engineering kommunizieren (verletzt Zwei-Tools-Versprechen und Token-Overhead-Budget), separate Fallback-Tool-Implementierungen (Doppelarbeit).

### Audit Layer Integration

**Entscheidung:** Der `why_this_card`-Generator ist **Teil des Card-Matchers** in `src/scan/matcher.ts`, nicht ein separates Modul. Der Matcher gibt ein Objekt `{ card, score, threshold, signal_breakdown, counter_signal_checks, matched: boolean }` zurueck. Das Return-Schema nimmt diese Struktur direkt im `card.why_this_card`-Feld auf.

**Token-Budget-Disziplin:** Das `why_this_card`-Feld ist auf maximal 400 Tokens pro Karte begrenzt. Signale mit Gewicht unter 0.05 werden in der Ausgabe zu einer zusammenfassenden Notiz kondensiert.

**Rationale:** Der Audit entsteht exakt an dem Ort, wo die Entscheidung getroffen wird — nicht als nachtraegliche Reconstruction. Das vermeidet Drift zwischen *"was wurde wirklich geprueft"* und *"was steht im Audit"*. Die enge Kopplung ist bewusst: Jede Aenderung am Matching zieht automatisch eine Aenderung am Audit nach.

### Testing- und Benchmark-Integration

**Entscheidung:** Zwei Test-Ebenen, beide in Vitest.

1. **Unit-Tests pro Modul** nutzen fixierte HTML-Snippets als Eingabe, keine Chrome-Abhaengigkeit. Dateien: `signal-extractor.test.ts`, `aggregator.test.ts`, `matcher.test.ts`, `state-machine.test.ts`, `card-loader.test.ts`.
2. **Benchmark-Integration-Tests** erweitern `test-hardest/benchmark-full.mjs` um einen `operator-mode`-Flag. Bei jedem Lauf werden MQS, Wall-Clock-Laufzeit und Erkennungs-Rate in eine JSON-Datei geschrieben. Ein kleines Skript (`scripts/check-gate.ts`) liest die letzte JSON-Datei und gibt Exit-Code 0 oder 1 zurueck.

**Zwischencheckpoint-Workflow:** Am Tag 20 des MVP-Laufs wird `npm run benchmark -- --operator-mode` plus `npm run check-gate` ausgefuehrt. Wenn MQS unter 66, schlaegt das Gate an und der naechste Story-Commit wird blockiert.

**Rationale:** Vitest und das Benchmark-Framework sind bereits im Stack. Das Zwischen-Gate braucht keine externe CI-Infrastruktur.

### Phase-2-Bridge Preparation

**Entscheidung:** Drei konkrete Preparations.

1. **Karten-Schema hat bereits `source`- und `harvest_count`-Felder** (in Phase 1 inaktiv, aber im Schema vorhanden).
2. **Fallback-Sequenzen-Ringpuffer ist ein definiertes Interface** in `src/audit/fallback-log.ts` mit der Methode `exportAnonymousPatterns(): Pattern[]`. In Phase 1 keine Netzwerk-Aufrufe, in Phase 2 vom Harvester aufgerufen.
3. **Privacy-by-Design im Ringpuffer-Schema:** Kein Feld fuer URLs, Textinhalte oder DOM-Attribute, die personenbezogen sein koennten. Nur strukturelle Signale.

**Rationale:** Drei kleine Preparations ersparen eine Schema-Migration in Phase 2. Aufwand jeweils weniger als ein Tag, Gewinn ist strukturelle Kontinuitaet zwischen den Phasen.

### Neue Module, Ordnerstruktur

**Entscheidung:**

- `src/operator/` — `state-machine.ts`, `operator-tool.ts` (der MCP-Tool-Handler), `execution-bundling.ts`
- `src/scan/` — `signal-extractor.ts`, `aggregator.ts`, `matcher.ts`, `signal-types.ts`
- `src/cards/` — `card-loader.ts`, `card-schema.ts` (Zod-Schema), `seed-library.ts`. Die YAML-Dateien liegen auf Projekt-Ebene in `cards/`, nicht in `src/`.
- `src/audit/` — `why-this-card-generator.ts`, `fallback-log.ts`
- `src/registry.ts` bleibt bestehen, wird verschlankt auf die Standard-Tool-Liste (zwei Top-Level-Tools)
- `src/fallback-registry.ts` (neu) fuer die Primitive-Liste im Fallback-Modus

**Rationale:** Flache Modul-Struktur, jeder Ordner hat eine klare Verantwortung, keine zirkulaeren Dependencies. Beschreibende Namen statt technischer.

### Decision Impact Analysis

**Implementation Sequence.** Epic 18 beginnt mit den Forensik-Fixes aus `docs/friction-fixes.md` (code-seitig isoliert, beruehren die neue Architektur nicht). Epic 19 beginnt mit **Card Data Model** (Schema, Loader, ein paar handgepflegte Seed-Karten) als Fundament, dann **Scan-Match-Pipeline** in der Reihenfolge Extractor, Aggregator, Matcher, dann **Operator State Machine** und **Return-Schema**, dann **Fallback-Mode**, dann **Audit-Layer-Verfeinerung**. Testing- und Benchmark-Integration laufen parallel.

**Cross-Component Dependencies.** Scan-Match-Pipeline und Card Data Model sind voneinander abhaengig: Der Matcher braucht das Karten-Schema, das Schema braucht Seed-Karten zum Testen. Die State Machine ist abhaengig von der Scan-Match-Pipeline (sie ruft den Scanner im `SCANNING`-State auf). Das Return-Schema ist abhaengig von beiden (es formatiert was beide produzieren). Der Fallback-Mode ist abhaengig von State Machine und Return-Schema. Der Audit-Layer ist abhaengig von der Matcher-Output-Struktur. Die Testing-Integration ist abhaengig von allem, aber lokal testbar pro Modul.

**Kritische Reihenfolge-Entscheidung.** Die Container-Aggregations-Schicht (Scan-Match-Pipeline) ist der Neuland-Teil und muss so frueh wie moeglich in Epic 19 landen, damit der Zwischencheckpoint an Tag 20 schon erste reale Messungen hat. Alle anderen Module sind Brownfield-Erweiterungen und weniger risikoreich.

## Implementation Patterns & Consistency Rules

### Pattern Categories Defined

Potenzielle Konflikt-Punkte zwischen Dev-Agents fuer dieses Projekt: **sechs in den Standard-Kategorien** plus **sechs projekt-spezifische Invarianten**, die sich aus dem Kartentisch-Mechanismus ergeben. Insgesamt also zwoelf Pattern-Bloecke, die ein Dev-Agent kennen muss, bevor er Code in Epic 18 oder 19 schreibt.

### Code Naming Conventions

**TypeScript-Code in `src/`.**

- **Dateien**: `kebab-case.ts` (z.B. `signal-extractor.ts`, `card-loader.ts`). Keine CamelCase-Dateinamen, keine Underscore-Dateinamen.
- **Klassen und Typen**: `PascalCase` (z.B. `OperatorStateMachine`, `CardSchema`, `SignalBreakdown`)
- **Funktionen und Methoden**: `camelCase` (z.B. `extractSignals`, `computeMatchScore`, `renderFallbackFraming`)
- **Variablen**: `camelCase`, beschreibend (z.B. `currentState`, `activeTabId`, `matchedCards`)
- **Konstanten**: `SCREAMING_SNAKE_CASE` nur fuer echte Konstanten (z.B. `MIN_SCORE_THRESHOLD`, `MAX_WHY_CARD_TOKENS`), nicht fuer Konfig-Werte
- **Type-Aliases und Interfaces**: `PascalCase`, Interfaces ohne `I`-Praefix (kein `IOperatorReturn`, sondern `OperatorReturn`)
- **Zod-Schemas**: Konvention `{Name}Schema` (z.B. `CardSchema`, `OperatorReturnSchema`), zugehoerige Typ-Definition `{Name}` (z.B. `type Card = z.infer<typeof CardSchema>`)

**Karten in `cards/` (YAML-Dateien).**

- Dateiname: `kebab-case.yaml`, identisch mit dem `id`-Feld im Inhalt (z.B. `login-form.yaml` mit `id: login-form`)
- `id`-Feld im Kartenformat: `kebab-case`
- Felder im YAML: `snake_case` (z.B. `structure_signature`, `counter_signals`, `execution_sequence`)

**Begruendung der Asymmetrie.** TypeScript-Code nutzt `camelCase` und `PascalCase` wie die JavaScript-Welt. YAML-Dateien nutzen `snake_case`, wie es in der YAML-Community (Kubernetes, Ansible, GitHub Actions) Usus ist. Die Uebergaenge zwischen beiden Welten werden beim Zod-Parse mit `.transform()` abgefangen.

### Project Organization

**Tests liegen co-located** — `signal-extractor.ts` hat `signal-extractor.test.ts` daneben. Ausnahmen: Benchmark-Integration-Tests liegen in `test-hardest/`, bestehen aus `.mjs`-Dateien und sind vom Vitest-Lauf ausgeklammert.

**Module-Boundaries sind streng.** `src/scan/` darf `src/cache/` importieren, aber nicht `src/operator/`. `src/operator/` darf `src/scan/`, `src/cards/`, `src/audit/` importieren, aber nicht umgekehrt. Zirkulaere Imports werden durch ESLint-Regel `import/no-cycle` geblockt.

**Entry-Points.** `src/index.ts` und `src/server.ts` bleiben als bestehende Entry-Points unveraendert. Neue Module werden in `src/server.ts` hineinverdrahtet, nicht in `src/index.ts`.

**YAML-Karten liegen auf Projekt-Ebene.** `cards/` ist ein Geschwister von `src/`, nicht darin. Damit sie als Daten-Files erkennbar bleiben und nicht als Code-Module.

### Format Patterns — Zod und Return-Schema

**JSON-Felder im Operator-Return.** `snake_case` (`tab_context`, `page_tree`, `why_this_card`, `fallback_framing`). Begruendung: LLMs lesen `snake_case`-Feldnamen konsistenter als `camelCase`, siehe auch die allgemeine MCP-Konvention im offiziellen SDK.

**Date-Handling.** Keine Dates im Operator-Return. Falls Timestamps doch noetig werden (z.B. fuer Karten-Versionen), dann **ISO-8601-Strings** (`"2026-04-11T14:30:00Z"`), niemals Unix-Timestamps oder lokale Zeitzonen.

**Null, Undefined, Leerstrings.** Zod-Schemas erzwingen die Disziplin: Felder sind entweder `required` mit Typ, oder `optional` (verschwinden komplett wenn leer), oder `nullable` (sind explizit `null`). Leere Strings werden verworfen — wenn ein Feld leer waere, soll es gar nicht im Return auftauchen.

**Arrays vs. Objekte.** Listen sind immer `[]`, auch wenn nur ein Element drin steht. `card` an einer Node ist entweder ein Objekt oder `undefined`, nie ein Array mit einem Element.

**Error-Responses.** Nicht relevant — das Operator-Tool hat kein Error-Response-Format im klassischen Sinn. Fehler gehen als **MCP-Protocol-Errors** (`McpError` aus dem SDK) raus, und die werden vom Client standardisiert gehandhabt. Nicht-fatale Fehler (Karte fehlerhaft, Gegensignal nicht eindeutig) landen im `why_this_card`-Audit-Feld, nicht in einem separaten Error-Feld.

### Communication Patterns — MCP Tool Handler Flow

**Tool-Handler-Signatur.** Jeder exportierte MCP-Tool-Handler in `src/operator/` und `src/fallback-registry.ts` folgt dem Muster `async function handle{ToolName}(args: {ToolName}Args): Promise<{ToolName}Return>` mit Zod-parse am Eingang und Zod-parse am Ausgang. Keine ungeprueften `any`-Rueckgaben.

**Tool-Registration.** `src/registry.ts` ist der **einzige Ort**, an dem Tools registriert werden. Kein dynamisches Tool-Einfuegen aus anderen Modulen, kein Registrierungs-Decorator. Die Standard-Registry enthaelt `virtual_desk` und `operator`, die `src/fallback-registry.ts` enthaelt die Primitives.

**State Machine Events.** Die Operator-State-Machine kommuniziert intern ueber typisierte Events (nicht ueber Callbacks oder Strings): `ScanStarted`, `ScanCompleted`, `CardSelected`, `ExecutionCompleted`, `FallbackTriggered`. Events sind als Discriminated Unions definiert (Type-Field `type`) und werden in `src/operator/events.ts` zentral gepflegt.

### Error Handling — Fallback-First, Not Try-Catch

Das ist die zentrale Disziplin, die sich aus dem PRD ergibt und den Dev-Agents beigebracht werden muss:

**Regel:** `try/catch` wird **nicht** verwendet, um den Kartentisch-Flow abzusichern. Wenn der Matcher keine Karten findet, ist das kein Error — es ist ein sauberer Uebergang in den Fallback-Modus. Wenn eine Karten-Ausfuehrung fehlschlaegt (z.B. Klick-Target verschwindet waehrend der Ausfuehrung), ist das **kein** Exception-Throw, sondern ein State-Uebergang: der Operator wechselt in `SCANNING` zurueck mit `fallback=true` und dem entsprechenden Framing-Text.

**Try/Catch ist erlaubt nur fuer:** (a) System-Level-Fehler wie OOM, CDP-Connection-Loss, File-System-Errors beim Laden der Karten-YAMLs, (b) Einhuellende Error-Handler im MCP-Tool-Handler, die CDP-Errors in `McpError` umwandeln, (c) Zod-Parse-Fehler beim Karten-Schema-Loading (defensive Programmierung gegen fehlerhafte Beitraege).

**Anti-Pattern:**

```typescript
// FALSCH — try/catch als Fallback-Mechanismus
try {
  const cards = matchCards(tree);
  return { mode: 'standard', cards };
} catch (e) {
  return { mode: 'fallback', primitives };
}
```

**Korrekt:**

```typescript
// RICHTIG — expliziter State-Uebergang auf Basis des Match-Ergebnisses
const matchResults = matchCards(tree);
if (matchResults.every(r => r.score < THRESHOLD)) {
  return buildFallbackReturn(tree, 'Kein strukturelles Muster erreicht Schwelle');
}
return buildStandardReturn(tree, matchResults);
```

**Begruendung.** `try/catch` als Control-Flow macht den Fallback unsichtbar. Explizite State-Uebergaenge sind testbar, debuggbar und im `why_this_card`-Audit nachvollziehbar.

### SilbercueChrome-Spezifische Pattern-Invarianten

Diese sechs Invarianten sind projekt-spezifisch und werden nicht durch Standard-Patterns abgedeckt. Sie gelten **uneingeschraenkt** und sind Teil der Acceptance-Criteria jeder Story in Epic 19.

**Invariant 1 — Token-Budget-Disziplin.** Jede Funktion, die am Operator-Return baut, dokumentiert im JSDoc-Kommentar ihr **Token-Budget** (z.B. `/** @tokens max 400 */` fuer den `why_this_card`-Generator). Ein separater Test in `src/operator/token-budget.test.ts` misst die Token-Count-Output fuer typische Inputs und schlaegt an, wenn ein Modul sein Budget bricht. Der Test nutzt das bestehende `scripts/token-count.mjs`-Skript.

**Invariant 2 — Struktur-Invariante (keine URLs, Domains, Inhalte in Karten).** Kein Karten-Feld darf eine URL, einen Domain-Namen oder einen Inhalts-String (Text, Label, Platzhalter) enthalten. Das wird durch das Zod-Schema erzwungen: `CardSchema` verbietet diese Feld-Typen auf Type-Ebene. Bei Review wird jede neue Karte daraufhin geprueft. Anti-Pattern-Beispiel: Eine Karte, die nur auf `login.example.com` funktioniert — strukturell nicht zulaessig.

**Invariant 3 — Audit-First im Matcher.** Der Card-Matcher baut das `why_this_card`-Breakdown **vor** der Rueckgabe der Match-Entscheidung, niemals nachtraeglich. Die Funktion `matchCard(tree, card)` gibt immer `{ matched: boolean, score, signal_breakdown, counter_signal_checks }` zurueck, nie nur einen Boolean. Wenn ein Dev-Agent einen Shortcut `matchCard(...).then(s => s.matched)` bauen will, ist das ein Pattern-Verstoss und wird im Review zurueckgewiesen.

**Invariant 4 — Fallback als State, nicht als Exception.** Wie oben unter "Error Handling" ausgefuehrt. Zusaetzlich gilt: Der `fallback_framing`-Text im Return muss aus einer **zentralen Konstanten** kommen (`src/operator/fallback-messages.ts`), nicht ad-hoc zusammengebaut werden. Damit ist der LLM-Ton einheitlich und aenderbar an einer Stelle.

**Invariant 5 — Solo-Pflegbarkeit.** Keine Magic Numbers im Code. Alle Schwellen (Match-Threshold, Token-Limits, Timeout-Werte) liegen in `src/operator/config.ts` als benannte Konstanten mit Kommentar. Keine Klassen-Hierarchien mit mehr als einer Vererbungsebene. Keine abstrakten Base-Classes, die nur einen Implementierungs-Zweig haben. Keine Dependency-Injection-Frameworks — einfache Konstruktor-Injection reicht.

**Invariant 6 — Phase-2-Forwards-Kompatibilitaet.** Alle Daten-Schemas (Karten, Fallback-Log-Eintraege, Audit-Struktur) haben bereits heute ein `schema_version`-Feld und ein `source`-Feld. In Phase 1 sind die Werte konstant (`schema_version: "1"`, `source: "seed"` bzw. `source: "fallback-observation"`). Dev-Agents duerfen **keine** Schema-Aenderungen machen, ohne die `schema_version` zu erhoehen und eine Migration-Note in `docs/schema-migrations.md` zu hinterlegen. Das schuetzt die spaetere Phase-2-Ankopplung.

### Enforcement Guidelines

**Alle Dev-Agents MUESSEN**:

1. Vor jeder Implementierung die sechs Invarianten lesen und in der Story-Acceptance-Criteria referenzieren.
2. Pattern-Verletzungen im Code-Review als `bmad-code-review`-Findings markieren und fixen, bevor die Story als `done` gilt.
3. Bei Unsicherheit ueber eine Pattern-Anwendung lieber eine Frage an den Menschen stellen als einen Shortcut nehmen, der das Pattern verletzt.

**Wo Pattern-Verletzungen dokumentiert werden.** Im Story-Review-Log unter `_bmad-output/implementation-artifacts/{epic}/{story}-review.md` als Finding mit der Schwere **H** (High). Wenn eine Pattern-Verletzung absichtlich gewaehlt wird (z.B. ein Leerstring in einem Test-Case als Mock-Wert), muss das im JSDoc-Kommentar mit `// eslint-disable-next-line` und einer Begruendung markiert sein.

**Prozess fuer Pattern-Updates.** Wenn sich im Lauf der Implementation zeigt, dass ein Pattern nicht traegt oder falsch geschnitten ist, wird der Change in `docs/pattern-updates.md` notiert mit Datum, Begruendung und dem neuen Wording. Das `architecture.md` wird erst am Ende des Epics angepasst, nicht pro Story.

## Project Structure & Boundaries

### Complete Project Directory Structure

```
SilbercueChrome/
├── README.md                          # Primary Doku, zweigleisig (Migration + Getting-Started)
├── LICENSE                            # MIT (Free-Build)
├── NOTICE                             # Attribution fuer Chromium-Feldtypen + Fathom-Rulesets
├── CLAUDE.md                          # Projekt-Context fuer Claude-Code-Sessions
├── package.json                       # npm-Manifest, "type": "module", engines.node >=18
├── tsconfig.json                      # strict mode, ESM target
├── eslint.config.js                   # ESLint 9 + typescript-eslint 8
├── .prettierrc
├── .gitignore                         # enthaelt build/, _bmad-output/, node_modules/
├── vitest.config.ts
│
├── src/                               # TypeScript-Source
│   ├── index.ts                       # Entry-Point (unveraendert)
│   ├── server.ts                      # MCP-Server-Setup (Standard-Registry verdrahten)
│   ├── registry.ts                    # Standard-Tool-Registry (zwei Top-Level-Tools)
│   ├── fallback-registry.ts           # Fallback-Primitives-Registry (NEU)
│   ├── types.ts                       # Zentrale Typ-Definitionen
│   │
│   ├── operator/                      # Operator-Loop und State Machine (NEU)
│   │   ├── state-machine.ts           # Fuenf-State-Machine (IDLE, SCANNING, ...)
│   │   ├── state-machine.test.ts
│   │   ├── operator-tool.ts           # MCP-Tool-Handler fuer `operator`
│   │   ├── operator-tool.test.ts
│   │   ├── virtual-desk-tool.ts       # MCP-Tool-Handler fuer `virtual_desk`
│   │   ├── virtual-desk-tool.test.ts
│   │   ├── execution-bundling.ts      # Bundling-Logik fuer Folge-Seiten-Scans
│   │   ├── execution-bundling.test.ts
│   │   ├── events.ts                  # Discriminated Union der State-Machine-Events
│   │   ├── config.ts                  # Benannte Konstanten (Thresholds, Limits, Timeouts)
│   │   ├── fallback-messages.ts       # Zentrale Fallback-Framing-Texte
│   │   ├── return-schema.ts           # Zod-Schema fuer `operator`-Return
│   │   ├── return-schema.test.ts
│   │   └── token-budget.test.ts       # Token-Budget-Compliance-Tests
│   │
│   ├── scan/                          # Scan-Match-Pipeline (NEU)
│   │   ├── signal-extractor.ts        # DOM-Signale aus A11y-Tree extrahieren
│   │   ├── signal-extractor.test.ts
│   │   ├── aggregator.ts              # Signale zu Struktur-Kandidaten clustern
│   │   ├── aggregator.test.ts
│   │   ├── matcher.ts                 # Karten matchen + why_this_card-Breakdown
│   │   ├── matcher.test.ts
│   │   ├── signal-types.ts            # Typ-Definitionen fuer Signale
│   │   └── fathom-integration.ts      # Wrapper um Mozilla Fathom (falls noetig)
│   │
│   ├── cards/                         # Karten-Datenmodell (NEU)
│   │   ├── card-schema.ts             # Zod-Schema fuer Karten-YAML
│   │   ├── card-loader.ts             # YAML-Parser + Validierung beim Server-Start
│   │   ├── card-loader.test.ts
│   │   └── seed-library.ts            # Laden aller Karten aus cards/-Verzeichnis
│   │
│   ├── audit/                         # why_this_card + Fallback-Log (NEU)
│   │   ├── why-this-card-generator.ts # Formatter fuer Signal-Breakdown
│   │   ├── why-this-card-generator.test.ts
│   │   ├── fallback-log.ts            # In-Memory-Ringpuffer fuer Fallback-Sequenzen
│   │   └── fallback-log.test.ts
│   │
│   ├── cache/                         # Accessibility-Tree-Cache (bestehend)
│   │   ├── a11y-tree.ts               # A11y-Tree-Cache, wird von Scan wiederverwendet
│   │   └── selector-cache.ts
│   │
│   ├── cdp/                           # Chrome DevTools Protocol Direct Client (bestehend)
│   │   ├── cdp-client.ts              # Low-Level CDP-Client
│   │   └── session-manager.ts         # Chrome-Session-Lifecycle, Auto-Launch
│   │
│   ├── cli/                           # CLI-Entry fuer Dev-Aufrufe (bestehend)
│   ├── hooks/                         # Hook-System fuer Extensions (bestehend)
│   ├── license/                       # Polar.sh-Lizenz-Verifizierung (bestehend)
│   ├── overlay/                       # Visual-Overlay (bestehend)
│   ├── plan/                          # run_plan-Executor als Sicherheitsnetz (bestehend)
│   │   ├── plan-executor.ts           # Wird NICHT mehr als Standard-Tool exportiert
│   │   ├── plan-variables.ts
│   │   ├── plan-conditions.ts
│   │   └── plan-state-store.ts
│   ├── telemetry/                     # Lokale Metriken, Phase-2-Hook-Vorbereitung (bestehend)
│   ├── tools/                         # 25 bestehende Tool-Implementierungen (bestehend)
│   │   ├── click.ts                   # Wird intern von Fallback-Registry und Karten genutzt
│   │   ├── type.ts
│   │   ├── read-page.ts               # Wird intern von Scan wiederverwendet
│   │   ├── wait.ts
│   │   ├── screenshot.ts
│   │   └── ... (weitere bestehende Tools)
│   └── transport/                     # MCP-Stdio-Transport-Wrapper (bestehend)
│
├── cards/                             # SEED-KARTEN (NEU, YAML-Dateien, Projekt-Ebene)
│   ├── login-form.yaml                # Handgepflegte Seed-Karte
│   ├── two-step-form.yaml
│   ├── cookie-banner.yaml
│   ├── search-field.yaml
│   ├── image-content-reader.yaml
│   ├── full-page-screenshot.yaml
│   ├── ... (insgesamt 20-30 Seed-Karten)
│   └── README.md                      # Kurzer Leitfaden fuer Karten-Autoren
│
├── test-hardest/                      # Benchmark-Parcours (bestehend)
│   ├── index.html                     # 35 Tests in 4 Levels
│   ├── benchmark-full.mjs             # Wird um --operator-mode-Flag erweitert
│   ├── smoke-test.mjs
│   └── benchmark-*.json               # Konkurrenz-Benchmark-Daten (Stand 2026-04-02)
│
├── scripts/                           # Build- und Release-Skripte (bestehend)
│   ├── publish.ts                     # Release-Pipeline: npm + SEA Binary
│   ├── token-count.mjs                # Token-Count-Messung fuer Token-Budget-Tests
│   └── check-gate.ts                  # NEU: Pruft ob Zwischen-Gate MQS >= 66 erreicht
│
├── docs/                              # Projekt-Dokumentation (bestehend)
│   ├── research/                      # Forschungs-Dokumente (bestehend, Input fuer PRD)
│   │   ├── run-plan-forensics.md
│   │   ├── llm-tool-steering.md
│   │   ├── form-recognition-libraries.md
│   │   ├── speculative-execution-and-parallelism.md
│   │   └── competitor-internals-stagehand-browser-use.md
│   ├── vision/
│   │   └── operator.md                # Operator-Vision, vier Ebenen, zwei Phasen
│   ├── friction-fixes.md              # Epic-18-Inhalt (rueckwirkend zugeordnet)
│   ├── deferred-work.md               # Bug-Liste mit Root-Cause-Analysen
│   ├── schema-migrations.md           # NEU: Versionshistorie der Datenschemas
│   └── pattern-updates.md             # NEU: Logbuch fuer Pattern-Anpassungen im Lauf
│
├── _bmad-output/                      # BMAD-Outputs (gitignored, aber sichtbar)
│   └── planning-artifacts/
│       ├── prd.md
│       ├── architecture.md            # Dieses Dokument
│       ├── product-brief-SilbercueChrome.md
│       └── sprint-change-proposal-2026-04-11-operator.md
│
└── build/                             # tsc-Output, gitignored
    ├── index.js
    ├── server.js
    └── ... (alle kompilierten Module)
```

### Architectural Boundaries

**Module-Import-Richtungen (streng, ESLint-erzwungen via `import/no-cycle`).**

```
          server.ts
              │
              ├──── registry.ts ──┬── operator/ ───────┐
              │                   │                    │
              │                   └── virtual-desk/    │
              │                                        │
              └──── fallback-registry.ts ──── tools/   │
                                                       │
              operator/ ────┬── scan/ ──── cache/      │
                            │                          │
                            ├── cards/                 │
                            │                          │
                            └── audit/                 │
                                                       │
              scan/ ────── cache/, fathom-integration  │
                                                       │
              cdp/ ────── transport/                   │
              (unveraendert, Low-Level-Schicht)        │
                                                       │
              plan/ ────── tools/ ────── cdp/          │
              (bestehend als Sicherheitsnetz)          │
```

**Regeln.** `src/operator/` darf `scan/`, `cards/`, `audit/` importieren. `src/scan/` darf `cache/` und die bestehende Fathom-/Chromium-Integrations-Schicht importieren, aber **nicht** `operator/`, `cards/` oder `audit/`. `src/cards/` darf nur Zod und `src/types.ts` importieren — **keine** Chrome- oder Browser-Abhaengigkeit, weil Kartenformate rein datenbasiert sind. `src/audit/` darf nur `src/types.ts` importieren — **keine** State-Machine-Abhaengigkeit, damit Audit-Strukturen unabhaengig formatierbar sind.

**Tool-Registry-Isolation.** `src/registry.ts` und `src/fallback-registry.ts` sind die **einzigen** Orte, an denen Tools dem MCP-Server gegenueber deklariert werden. Kein anderes Modul darf `server.registerTool()` oder Aequivalentes aufrufen. Das haelt das Token-Budget-Overhead unter Kontrolle und erleichtert Auditing.

### Requirements to Structure Mapping

**FR1–FR6 (Kartentisch-Erkennung und Seitenlesart).** Implementierung in `src/scan/` (`signal-extractor.ts`, `aggregator.ts`, `matcher.ts`) plus `src/operator/return-schema.ts` fuer die Seitenlesart-Struktur. Die Seed-Karten liegen als YAML in `cards/`.

**FR7–FR11 (Karten-Ausfuehrung und Loop).** Implementierung in `src/operator/state-machine.ts` und `src/operator/execution-bundling.ts`. Die tatsaechliche mechanische Ausfuehrung delegiert an die bestehenden Tools in `src/tools/` (click, type, etc.).

**FR12–FR16 (Fallback-Modus und Primitive).** `src/operator/state-machine.ts` verwaltet den `fallback`-Flag, `src/fallback-registry.ts` exportiert die Primitive-Liste, `src/audit/fallback-log.ts` registriert Muster-Signaturen im Ringpuffer.

**FR17–FR21 (Session- und Tab-Verwaltung).** Bleibt in der bestehenden `src/cdp/`-Schicht. Keine neuen Module, nur ein Wrapper in `src/operator/virtual-desk-tool.ts`, der die bestehende Session-Manager-API fuer das `virtual_desk`-MCP-Tool aufruft.

**FR22–FR25 (Audit und Transparenz).** `src/audit/why-this-card-generator.ts` fuer die Formatierung, der Matcher in `src/scan/matcher.ts` produziert die Rohdaten.

**FR26–FR30 (Karten-Datenmodell und Pflege).** `src/cards/card-schema.ts` (Zod-Schema), `src/cards/card-loader.ts` (YAML-Parser), `src/cards/seed-library.ts` (Loader fuer alle Karten im `cards/`-Verzeichnis). Die YAML-Dateien selbst liegen auf Projekt-Ebene unter `cards/`. Pull-Request-Prozess und Review-Richtlinien werden in `cards/README.md` dokumentiert.

**FR31–FR34 (Lizenzierung und Distribution).** Unveraendert bestehend: `src/license/` fuer Polar.sh-Integration, `scripts/publish.ts` fuer Release-Pipeline.

**FR35–FR38 (Migration und Onboarding).** Reine Doku-Arbeit in `README.md` — kein Code-Modul.

**NFR1 (Tool-Definition-Overhead unter 3000 Tokens).** Enforcement in `src/registry.ts` plus `src/operator/token-budget.test.ts` — der Test misst die Token-Count des exportierten Standard-Registries.

**NFR2 (Operator-Return-Latenz unter 800 ms).** Enforcement in `test-hardest/benchmark-full.mjs --operator-mode` plus `scripts/check-gate.ts`.

**NFR3–NFR5 (Laufzeit-Spar, Erkennungs-Rate, Falscherkennung).** Enforcement ueber den Benchmark-Parcours in `test-hardest/`.

**NFR6–NFR9 (Security).** `src/license/` respektiert die Regeln (kein Log-Leak), `src/operator/` und `src/scan/` machen keine Netzwerk-Aufrufe, `src/audit/fallback-log.ts` enthaelt Privacy-by-Design-Kommentare am Schema.

**NFR10–NFR12 (Scalability).** Ein-Prozess-Modell ist durch `src/server.ts` garantiert (kein Multi-Tenant-Code). Der Matcher in `src/scan/matcher.ts` haelt seine Komplexitaet linear ueber die Karten-Zahl.

**NFR13–NFR15 (Reliability).** Connection-Recovery in `src/cdp/session-manager.ts` (bestehend, wird bei Bedarf geschaerft). Fallback-Transition in `src/operator/state-machine.ts`. Benchmark-Pass-Rate ueber den Test-Hardest-Parcours.

**NFR16–NFR18 (Integration).** MCP-Transport in `src/transport/` (bestehend), CDP-Client in `src/cdp/` (bestehend), Polar.sh-Netzwerk-Aufruf in `src/license/` (bestehend, mit Offline-Grace).

### Integration Points

**Internal Communication.** Der MCP-Server (`src/server.ts`) verdrahtet die Standard-Registry beim Start. Wenn das LLM das `operator`-Tool aufruft, delegiert der Handler an die Operator-State-Machine, die wiederum Scan, Matcher und Tools orchestriert. Beim Uebergang in den Fallback-Modus wird `notifications/tools/list_changed` ausgesendet, und der Client laedt die Fallback-Registry.

**External Integrations.**

- **Chrome ueber CDP** — `src/cdp/cdp-client.ts` ist die einzige Stelle, an der CDP-Messages produziert werden. Alle anderen Module rufen `cdp-client.ts` auf.
- **Polar.sh-Lizenz-Verification** — `src/license/` ruft `https://api.polar.sh/` auf, einmal beim Server-Start (Pro-Build), mit 7-Tage-Offline-Grace.
- **Keine weiteren externen Integrationen** in Phase 1.

**Data Flow.**

```
LLM ──> MCP-Tool-Call (operator)
         │
         ▼
   server.ts ──> registry.ts ──> operator-tool.ts
         │                              │
         │                              ▼
         │                       state-machine (SCANNING)
         │                              │
         │                              ▼
         │                       scan/signal-extractor ──> cache/a11y-tree
         │                              │
         │                              ▼
         │                       scan/aggregator
         │                              │
         │                              ▼
         │                       scan/matcher ──> cards/seed-library
         │                              │
         │                              ▼
         │                       audit/why-this-card-generator
         │                              │
         │                              ▼
         │                       return-schema (Zod-parse)
         │                              │
         └──────────────────────────────┘
                                        │
                                        ▼
                                   LLM (Seitenlesart + Karten)
```

Beim Fallback-Uebergang: Der Fluss geht gleich, nur dass der Matcher keine Karten annotiert und stattdessen `fallback_framing` setzt. Zusaetzlich wird die Signatur ins `audit/fallback-log.ts`-Ringpuffer geschrieben. Der MCP-Server sendet `notifications/tools/list_changed` aus, und die Fallback-Registry wird aktiv.

### File Organization Patterns

**Konfigurations-Files** liegen auf Projekt-Ebene (`package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`). Keine verteilten Configs pro Unterverzeichnis.

**Source-Code** liegt ausschliesslich in `src/`, flach organisiert nach Verantwortung (nicht nach Schicht, nicht nach Feature). Jeder Unterordner ist ein **Zustaendigkeits-Block**: `operator/`, `scan/`, `cards/`, `audit/`, `cdp/`, `tools/`, etc.

**Tests** liegen **co-located** mit dem Source-File (`signal-extractor.test.ts` neben `signal-extractor.ts`). Benchmark-Integration-Tests liegen abseits in `test-hardest/` als `.mjs`-Dateien.

**Karten-YAMLs** liegen auf Projekt-Ebene in `cards/`, nicht in `src/`. Sie sind Daten, kein Code.

**Dokumentation** liegt in `docs/`, unterteilt nach Lebensdauer (`research/` fuer langlebige Forschung, `vision/` fuer strategische Dokumente, `friction-fixes.md` und `deferred-work.md` fuer laufende Arbeit, `schema-migrations.md` und `pattern-updates.md` als Logbuecher).

**BMAD-Artefakte** liegen in `_bmad-output/planning-artifacts/` — gitignored, aber projekt-sichtbar. PRD und Architecture-Dokument sind hier.

### Development Workflow Integration

**Development Server.** `npm run build` ruft `tsc && chmod +x build/index.js` auf und produziert das ausfuehrbare MCP-Server-Binary in `build/index.js`. Ein MCP-Client (Claude Code, Cursor) kann dieses Binary direkt als Stdio-Server aufrufen. Fuer Dev-Iterationen empfiehlt sich ein Watch-Mode (`tsc --watch`) in einem zweiten Terminal.

**Build Process.** Der Release-Build laeuft ueber `npm run publish:release` (`tsx scripts/publish.ts`), das sowohl das npm-Free-Paket als auch das Pro-SEA-Binary baut. Beide teilen sich denselben `tsc`-Output als Basis, das SEA-Binary zusaetzlich durch einen esbuild-Bundling-Schritt.

**Deployment.** Free wird ueber npm publiziert (`npm publish`), Pro wird ueber GitHub Releases verteilt. Beide Prozesse sind im Release-Skill `silbercuechrome-publish` automatisiert.

**Benchmarking.** `npm run benchmark -- --operator-mode` fuehrt den Test-Hardest-Parcours im Operator-Modus durch und schreibt das Ergebnis in eine JSON-Datei. `scripts/check-gate.ts` prueft gegen das aktuell gueltige Gate (Epic-18: MQS ≥ 63, Tag-20-Checkpoint: MQS ≥ 66, Epic-19-Abschluss: MQS ≥ 70).

## Architecture Validation Results

### Coherence Validation

**Decision Compatibility.** Alle Technologie-Entscheidungen stehen im aktuellen `package.json` und sind miteinander kompatibel: Node.js 18+, TypeScript 5.7 im strict mode, ESM-only, `@modelcontextprotocol/sdk` 1.29+, Zod 3, Vitest 3, ESLint 9 plus typescript-eslint 8 plus Prettier 3, `tsx` 4.21 als Script-Runner. Keine Version-Konflikte, kein Dependency-Gegensatz. Die Fathom-Integration kommt als neue Dependency dazu und muss im Paket-Manifest ergaenzt werden, ist aber MIT-lizenziert und ohne Konflikt zum bestehenden Lizenz-Stack.

**Pattern Consistency.** Die zwoelf Pattern-Bloecke (sechs Standard plus sechs Invarianten) greifen ohne Widerspruch ineinander. **Audit-First** (Invariante 3) stuetzt den Matcher-Output, der wiederum das Return-Schema fuellt. **Fallback-als-State** (Invariante 4) passt strukturell zur Operator-State-Machine. **Token-Budget-Disziplin** (Invariante 1) wird durch `scripts/token-count.mjs` und den `token-budget.test.ts`-Test mechanisch enforced. **Struktur-Invariante** (Invariante 2) wird durch das Zod-Schema auf Typ-Ebene erzwungen, nicht nur als Konvention. Keine Patterns widersprechen Architektur-Entscheidungen.

**Structure Alignment.** Die Module-Import-Richtungen in der Structure-Sektion spiegeln genau die Datenflussrichtung wider: Operator → Scan → Cache, Operator → Cards, Operator → Audit. ESLint `import/no-cycle` wird zirkulaere Imports verhindern. Die neue Ordner-Struktur (`operator/`, `scan/`, `cards/`, `audit/`) passt zur bestehenden flachen Organisation ohne Bruch.

### Requirements Coverage Validation

**Functional Requirements (38 FRs).** Systematisch gegen alle acht Capability Areas geprueft:

- **Kartentisch-Erkennung und Seitenlesart (FR1–FR6):** Vollstaendig abgedeckt durch `src/scan/` (Extractor, Aggregator, Matcher) plus `src/operator/return-schema.ts`. Die Karten-Einbettung im Seitenbaum (FR3) ist im Schema strukturell verankert.
- **Karten-Ausfuehrung und Loop (FR7–FR11):** Abgedeckt durch `src/operator/state-machine.ts` plus `src/operator/execution-bundling.ts`. **Minor Gap** bei der State-Machine-Detaillierung zwischen FR9 (Folge-Seiten-Scan ohne LLM-Zwischenaufruf) und FR10 (mehrstufige Karten-Sequenz in einem Loop) — siehe Gap Analysis unten.
- **Fallback-Modus und Primitive (FR12–FR16):** Abgedeckt durch State-Machine-Flag, `src/fallback-registry.ts`, `src/operator/fallback-messages.ts`, `src/audit/fallback-log.ts` und MCP `notifications/tools/list_changed`-Mechanismus.
- **Session- und Tab-Verwaltung (FR17–FR21):** Bestandscode in `src/cdp/session-manager.ts` deckt alles ab, `src/operator/virtual-desk-tool.ts` verdrahtet es ans `virtual_desk`-MCP-Tool.
- **Audit und Transparenz (FR22–FR25):** Abgedeckt durch `src/audit/why-this-card-generator.ts` und die Matcher-Output-Struktur. Das Audit-Feld ist als verpflichtender Teil des Return-Schemas im Zod-Schema erzwungen.
- **Karten-Datenmodell und Pflege (FR26–FR30):** Abgedeckt durch `src/cards/card-schema.ts`, `card-loader.ts`, `seed-library.ts` und den YAML-Standort unter `cards/`. Der Pull-Request-Pfad wird in `cards/README.md` dokumentiert.
- **Lizenzierung und Distribution (FR31–FR34):** Bestandscode in `src/license/` und `scripts/publish.ts`, unveraendert.
- **Migration und Onboarding (FR35–FR38):** Reine Doku-Arbeit im README. Keine Code-Komponente, aber strukturell nicht in Gefahr.

**38 von 38 FRs architektonisch abgedeckt**, ein Minor-Gap bei FR9/FR10 als Important-Issue in der Gap-Analyse.

**Non-Functional Requirements (18 NFRs).** Systematisch gegen alle fuenf Kategorien geprueft:

- **Performance (NFR1–NFR5):** NFR1 durch `src/registry.ts`-Verschlankung und `token-budget.test.ts`-Enforcement. NFR2 durch lineare Matcher-Komplexitaet plus `test-hardest`-Benchmark-Enforcement. NFR3 durch Benchmark-Gate. NFR4 durch Fathom + Chromium-Feldtypen-Integration in der Signal-Extraktor-Schicht plus Enforcement. NFR5 durch Counter-Signals im CardSchema plus Audit-Trail. Alle architektonisch verankert.
- **Security (NFR6–NFR9):** NFR6 bestehend in `src/license/` (keine Log-Ausgabe von Lizenz-Keys). NFR7 durch Design (keine Netzwerk-Aufrufe ausser Polar.sh). NFR8 bestehend in `src/cdp/session-manager.ts` (Profile-Zugriff). NFR9 durch Invariante 6 plus `src/audit/fallback-log.ts`-Schema-Design.
- **Scalability (NFR10–NFR12):** NFR10 durch Design (Ein-Prozess-MCP-Server, kein Shared-State). NFR11 durch lineare Scan-Komplexitaet (Matcher skaliert linear mit Karten-Zahl). NFR12 durch explizite Design-Entscheidung gegen quadratische Algorithmen oder ML-Inferenz.
- **Reliability (NFR13–NFR15):** NFR13 bestehend in `src/cdp/session-manager.ts` (Connection-Recovery-Logik). NFR14 durch State-Machine-Design (Fallback ist erstklassiger State). NFR15 durch Benchmark-Gate.
- **Integration (NFR16–NFR18):** NFR16 durch bestehendes `@modelcontextprotocol/sdk` 1.29+ mit Stdio-Transport. NFR17 durch bestehende CDP-Direct-Implementierung. NFR18 durch Design (lokaler Server mit Polar.sh-Ausnahme).

**18 von 18 NFRs architektonisch adressiert.**

### Implementation Readiness Validation

**Decision Completeness.** Alle neun Entscheidungs-Kategorien aus Step 4 sind mit Rationale und verworfenen Alternativen dokumentiert. Versionen sind aus der `package.json` verifiziert. Keine schwebenden Entscheidungen, die die Implementierung blockieren wuerden. Ein kleiner offener Punkt: Die Fathom-Integration-Version ist nicht festgelegt (Mozilla Fathom ist nicht mehr aktiv gewartet — Story 19.x muss die aktuelle Verwendbarkeit verifizieren oder eine Alternative wie ein manuelles Port der Fathom-Rulesets evaluieren).

**Structure Completeness.** Der komplette Projekt-Tree ist in Step 6 gezeichnet, inklusive aller neuen Dateien und Test-Dateien. Jede neue Datei hat einen klaren Zweck und eine Module-Zugehoerigkeit. Import-Richtungen sind definiert und ESLint-enforced.

**Pattern Completeness.** Alle potenziellen Konflikt-Punkte zwischen Dev-Agents sind adressiert: Naming (Dateien, Code, Karten-Felder), Format (Zod-Schema, snake_case, ISO-Dates), Communication (Tool-Handler-Signaturen, Event-Typen), Error-Handling (Fallback-First-Regel mit Code-Beispielen), Token-Budget, Struktur-Invariante. Die sechs SilbercueChrome-spezifischen Invarianten schliessen die projekt-spezifischen Luecken.

### Gap Analysis

**Critical Gaps.** Keine. Die Architektur ist implementation-ready.

**Important Gaps.**

**Gap 1 — State-Machine-Detail zwischen FR9 und FR10.** Die State-Machine hat fuenf States (IDLE, SCANNING, AWAITING_SELECTION, EXECUTING, POST_EXECUTION_SCAN). Bei mehrstufigen Karten-Sequenzen (z.B. zweischrittiges Formular) muss die Maschine **innerhalb** des EXECUTING-States bleiben, bis alle Schritte der Karten-Execution-Sequence durchlaufen sind, und **erst dann** in POST_EXECUTION_SCAN wechseln. Das ist in Step 4 und Step 6 nicht glasklar formuliert. **Vorschlag:** In `src/cards/card-schema.ts` enthaelt die `execution_sequence` eine Liste von Steps, wobei der letzte Step implizit das Ende markiert. Die State-Machine liest die Liste ab und triggert `POST_EXECUTION_SCAN` erst, wenn alle Steps ausgefuehrt wurden — nicht nach dem ersten. Dieser Implementation-Detail sollte in der Epic-19-Story-Struktur explizit als ein Acceptance-Criterion der State-Machine-Story auftauchen.

**Gap 2 — Fathom-Library-Verfuegbarkeit und -Integration.** Mozilla Fathom ist nicht mehr aktiv gewartet (das Repository hat seit einiger Zeit keine neuen Commits). Die Integration in `src/scan/fathom-integration.ts` setzt voraus, dass entweder (a) die bestehende Fathom-Version mit Node 18+ und TypeScript 5.7 funktioniert, oder (b) die relevanten Rulesets manuell portiert werden muessen. **Vorschlag:** In Epic 19 gibt es eine frueh einzuplanende **Spike-Story** (*"Fathom-Verfuegbarkeit pruefen und Integrations-Strategie entscheiden"*), die entweder die Library einbindet oder die Rulesets als eigenen Code portiert. Der Rest der Scan-Match-Pipeline ist davon unabhaengig und kann parallel laufen.

**Nice-to-Have Gaps.**

**Gap 3 — Logging-Standard.** Das bestehende `src/telemetry/` enthaelt lokale Metriken-Erfassung. Ein konsistentes Logging-Format fuer die neuen Module (Scan, Operator, Cards, Audit) ist nicht explizit benannt. Kein Blocker, weil die bestehende Telemetry-Schicht wiederverwendet werden kann, aber eine Notiz in `docs/pattern-updates.md` zum Zeitpunkt der ersten Operator-Story waere sinnvoll.

**Gap 4 — Seed-Karten-Review-Prozess.** Der Pull-Request-Pfad (FR30) ist in `cards/README.md` dokumentiert, aber die **Review-Kriterien** fuer eine neue Karte (*"erreicht die Signatur mindestens 85% auf drei Produktionsseiten"*, *"Struktur-Invariante erfuellt"*, *"keine URLs oder Text-Strings"*) sind noch nicht in einem Review-Template formalisiert. Kein Blocker, aber eine spaetere Verfeinerung.

### Validation Issues Addressed

Die beiden Important-Gaps (State-Machine-Detail und Fathom-Verfuegbarkeit) werden **nicht** jetzt im Architektur-Dokument geloest, sondern als konkrete Acceptance-Criteria-Notizen in die kommende Epic-19-Story-Erstellung gelegt. Grund: Beide sind Implementation-Details, die erst im Kontakt mit dem realen Code auftauchen. Die Architektur-Entscheidung *"State-Machine mit fuenf States"* bleibt gueltig, die *"Scan-Match-Pipeline mit Fathom plus Chromium-Feldtypen"* bleibt gueltig. Die Gaps schaerfen nur die ersten Stories.

Nice-to-Have-Gaps werden im Laufe der Implementierung in `docs/pattern-updates.md` notiert, falls sie relevant werden.

### Architecture Completeness Checklist

**Requirements Analysis**

- [x] Project context thoroughly analyzed (Step 2)
- [x] Scale and complexity assessed (Medium-High, algorithmisches Neuland in einem Modul)
- [x] Technical constraints identified (Brownfield, Solo, 45-Tage-Zeitbox, direkt-CDP, MCP)
- [x] Cross-cutting concerns mapped (Audit-First, Performance-Budget, Struktur-Invariante, Phase-2-Bridge, Solo-Pflegbarkeit, Fallback als State)

**Architectural Decisions**

- [x] Critical decisions documented with rationale (9 Entscheidungs-Kategorien in Step 4)
- [x] Technology stack fully specified (aus `package.json` verifiziert)
- [x] Integration patterns defined (MCP Stdio, CDP direct, Polar.sh)
- [x] Performance considerations addressed (lineare Matcher-Komplexitaet, Token-Budget-Disziplin)

**Implementation Patterns**

- [x] Naming conventions established (TypeScript, YAML, kebab-case, PascalCase, camelCase)
- [x] Structure patterns defined (co-located tests, flache Module-Organisation)
- [x] Communication patterns specified (Tool-Handler-Signatur, State-Machine-Events, MCP-Protokoll)
- [x] Process patterns documented (Fallback-First statt try/catch, Audit-First im Matcher)
- [x] Six SilbercueChrome-spezifische Invarianten

**Project Structure**

- [x] Complete directory structure defined (Step 6, inklusive `cards/`, `src/operator/`, `src/scan/`, `src/cards/`, `src/audit/`)
- [x] Component boundaries established (ESLint-enforced import-Richtungen)
- [x] Integration points mapped (MCP-Server, CDP, Polar.sh)
- [x] Requirements to structure mapping complete (alle 38 FRs und 18 NFRs auf Module gemappt)

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION WITH TWO FLAGGED SPIKES

**Confidence Level:** Hoch. Die Brownfield-Basis (17 Epics) ist stabil, die neuen Module sind klar geschnitten, die Pattern-Invarianten sind projekt-spezifisch geschaerft, die Gaps sind benannt und in konkrete Spike-Stories aufloesbar.

**Key Strengths.**

- **Klarer Modul-Schnitt.** Die Container-Aggregations-Schicht, die im PRD als *"Neuland"* markiert war, ist als Dreischicht-Pipeline (Extractor, Aggregator, Matcher) in drei gut testbare Dateien zerlegt.
- **Fallback als erstklassiger Zustand.** Die State-Machine-Modellierung zwingt Dev-Agents zur expliziten State-Uebergangs-Logik, verhindert `try/catch`-als-Control-Flow.
- **Token-Budget-Disziplin mechanisch enforced.** Der `token-budget.test.ts` plus das bestehende `scripts/token-count.mjs` machen das 3000-Tokens-Gate reproduzierbar messbar.
- **Phase-2-Bridge strukturell verankert.** `source`- und `harvest_count`-Felder im Karten-Schema, Privacy-by-Design im fallback-log-Schema, dokumentierte Export-Methode fuer den spaeteren Harvester — keine Schema-Migration noetig.
- **Zero neue Dependencies.** Bis auf die offene Fathom-Frage kommt keine neue Library ins Projekt. Das Paket bleibt schlank und solo-pflegbar.

**Areas for Future Enhancement.**

- Ein echtes Logging-Standard-Dokument (Gap 3), wenn Epic 19 zur Haelfte durch ist.
- Ein Review-Template fuer Seed-Karten-Pull-Requests (Gap 4), wenn die ersten externen Beitraege eintrudeln.
- Performance-Profiling der Scan-Match-Pipeline auf ungewoehnlich grossen Seiten (jenseits der Benchmark-Parcours-Groesse), wenn der Zwischen-Checkpoint an Tag 20 erste reale Zahlen liefert.

### Implementation Handoff

**AI Agent Guidelines.**

1. Folge allen Architektur-Entscheidungen aus Step 4 exakt. Insbesondere: **Keine Magic Numbers** (Invariante 5), **kein `try/catch` als Fallback-Mechanismus** (Error-Handling-Regel), **Audit-First im Matcher** (Invariante 3).
2. Nutze die sechs SilbercueChrome-spezifischen Invarianten als Acceptance-Criterion fuer jede Story. Wenn eine Invariante in einer Story nicht eingehalten werden kann, ist das ein Review-Finding der Schwere **H** (High).
3. Respektiere die Module-Import-Richtungen aus Step 6. Zirkulaere Imports werden von ESLint geblockt — wenn das Problem entsteht, ist die Modul-Aufteilung falsch geschnitten, nicht die ESLint-Regel.
4. Schreibe Tests **co-located** mit dem Source-File. Benchmark-Integration-Tests liegen in `test-hardest/`.
5. Wenn eine Architektur-Entscheidung unklar wirkt oder in Widerspruch zur Realitaet der Implementation steht: **Nicht raten**, sondern in `docs/pattern-updates.md` eine Notiz hinterlegen und im `bmad-code-review` dokumentieren. Das `architecture.md` wird am Ende des Epics angepasst, nicht pro Story.

**First Implementation Priority.**

Die erste Story von Epic 18 ist der **Ambient-Context-Hook-Forensik-Fix** aus `docs/friction-fixes.md` (Haupt-Hebel laut Forensik: spart auf click-lastigen Plaenen **100–1350 ms pro Click-Step** — Herleitung: die `waitForAXChange`-Wait-Konstanten 350/500/1350 ms in `src/hooks/default-on-tool-result.ts` — plus etwa **2850 Chars pro Plan** durch entfallende Ambient-Context-Snapshots; der zeitliche Hebel skaliert mit der Anzahl der Click-/Type-Steps — Plaene ohne Transition-Steps sehen die Zeit-Einsparung nicht, die Token-Einsparung aber schon). Diese Story ist code-seitig isoliert, beruehrt die neue Operator-Architektur nicht, und validiert das Implementation-Gate (MQS +2 bis +3) vor dem Kartentisch-Sprung.

Die erste Story von Epic 19 sollte **Card Data Model** sein (`src/cards/card-schema.ts` plus `card-loader.ts` plus drei handgepflegte Seed-Karten als Test-Datensatz). Grund: Dieses Modul hat keine Chrome-Abhaengigkeit und kann vollstaendig mit Unit-Tests validiert werden. Es ist das Fundament fuer alle nachfolgenden Scan-Match-Pipeline-Stories.

**Fathom-Spike-Story** (FR4, NFR4) sollte parallel zur zweiten Epic-19-Story laufen, damit die Scan-Match-Pipeline nicht durch eine ungeklaerte Library-Verfuegbarkeit blockiert wird.
