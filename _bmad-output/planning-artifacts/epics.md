---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - docs/friction-fixes.md
workflowType: 'epics-and-stories'
project_name: 'SilbercueChrome'
user_name: 'Julian'
date: '2026-04-11'
---

# SilbercueChrome - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for SilbercueChrome Operator Phase 1, decomposing the requirements from the PRD and the architectural decisions from the Architecture document into implementable stories. Scope: Epic 18 (Forensik-Fixes als MVP-Vorbereitung) und Epic 19 (Kartentisch, Seed-Bibliothek, Fallback als MVP-Kern).

## Requirements Inventory

### Functional Requirements

**Kartentisch-Erkennung und Seitenlesart:**

- FR1: Operator kann eine aktuelle Seite scannen und sowohl strukturelle DOM-Signale fuer die Karten-Erkennung extrahieren als auch eine strukturierte Seitenlesart aufbauen.
- FR2: Operator kann im Return eine strukturierte Seitenlesart liefern: Seitentitel, hierarchische Content-Struktur (Ueberschriften, Textbloecke, Listen, Tabellen) und interaktive Elemente (Links, Buttons, Formulare) mit Ref-Handles. Diese Lesart ersetzt den bisherigen separaten `read_page`-Aufruf im Standard-Modus.
- FR3: Operator kann erkannte Karten direkt an dem Element der Seitenlesart verankern, auf das sie sich beziehen — als Annotationen im Seitenbaum, nicht als separate Karten-Liste daneben.
- FR4: Operator kann fuer jede in der Seed-Bibliothek registrierte Struktur-Klasse einen Match-Score berechnen und nur Karten annotieren, die die Erkennungs-Schwelle erreichen.
- FR5: Operator kann Gegen-Signale auf Document-Body-Ebene pruefen und Karten verwerfen, wenn diese Gegen-Signale anschlagen.
- FR6: Operator kann mehrere Karten gleichzeitig an unterschiedlichen Stellen der Seitenlesart annotieren, wenn eine Seite mehrere unabhaengige Struktur-Klassen enthaelt.

**Karten-Ausfuehrung und Loop:**

- FR7: Das LLM kann eine Karte aus der Seitenlesart auswaehlen und die benoetigten Parameter-Werte setzen.
- FR8: Operator kann die ausgewaehlte Karte serverseitig mechanisch ausfuehren, entsprechend der in der Karte definierten Handlungs-Sequenz.
- FR9: Operator kann nach der Karten-Ausfuehrung die Folge-Seite laden, scannen und die neue Seitenlesart (inklusive eingebetteter Karten) ans LLM liefern — ohne LLM-Zwischenaufruf.
- FR10: Operator kann mehrstufige Karten-Ablaeufe (z.B. zweischrittige Formulare) innerhalb eines einzigen Operator-Loops ausfuehren.
- FR11: Operator kann Navigations-Ereignisse (Page Loads, Redirects, Tab-Wechsel) innerhalb der Karten-Ausfuehrung sauber handhaben, ohne den Loop zu brechen.

**Fallback-Modus und Primitive:**

- FR12: Operator kann alle Karten aus der Seitenlesart entfernen und in den Fallback-Modus wechseln, wenn kein Muster die Erkennungs-Schwelle erreicht.
- FR13: Operator kann im Fallback-Modus zwischen fuenf und sechs Primitive (click, type, read, wait, screenshot, optional evaluate) als Tool-Kontext anbieten.
- FR14: Operator kann den Wechsel in den Fallback-Modus im Return mit explizitem Framing kommunizieren, damit das LLM den Modus nicht als Fehlerzustand interpretiert.
- FR15: Operator kann waehrend eines Fallback-Laufs strukturelle Muster-Signaturen registrieren, die als Kandidaten fuer zukuenftige Seed-Karten dienen.
- FR16: Das LLM kann zwischen Standard-Modus und Fallback-Modus wechseln, ohne die Session zu verlieren oder die Tab-Referenzen zu invalidieren.

**Session- und Tab-Verwaltung:**

- FR17: Ein Nutzer kann ueber `virtual_desk` einen neuen Arbeits-Kontext (Session) anlegen.
- FR18: Ein Nutzer kann innerhalb einer Session mehrere Tabs oeffnen, zwischen ihnen wechseln und sie schliessen.
- FR19: SilbercueChrome kann Chrome im Auto-Launch-Modus (Zero-Config) starten oder sich mit einem bereits laufenden Chrome mit Remote-Debugging verbinden.
- FR20: SilbercueChrome kann ein vom Nutzer konfiguriertes Chrome-Profil nutzen, um Login-Sessions ueber Session-Grenzen hinweg zu erhalten.
- FR21: SilbercueChrome kann den Chrome-Lifecycle sauber managen: Auto-Launch, Verbindungspruefung und Connection-Recovery bei Netzausfaellen.

**Audit und Transparenz:**

- FR22: Operator kann im Return fuer jede annotierte Karte ein `why_this_card`-Feld liefern, das alle geprueften Signale mit Gewicht, Score und Schwelle auflistet.
- FR23: Operator kann die Gegen-Signal-Check-Ergebnisse im `why_this_card`-Feld sichtbar machen, inklusive welche Gegen-Signale geprueft wurden und mit welchem Ergebnis.
- FR24: Operator kann Karten-Version und Karten-Quelle im Return mitliefern, damit Falsch-Matches ueber Versionsgrenzen hinweg nachvollziehbar sind.
- FR25: Operator kann im Fallback-Modus einen strukturell gleichwertigen Log liefern wie im Standard-Modus — erklaerend, warum keine Karte die Schwelle erreicht hat.

**Karten-Datenmodell und Pflege:**

- FR26: Entwickler koennen Karten in einem menschenlesbaren, in Git pflegbaren Text-Format definieren.
- FR27: Entwickler koennen pro Karte Erkennungs-Signale (positiv), Gegen-Signale, Parameter-Schema und Ausfuehrungs-Sequenz definieren.
- FR28: Entwickler koennen Karten gegen den Test-Hardest-Benchmark-Parcours validieren, bevor sie in die Seed-Bibliothek aufgenommen werden.
- FR29: Entwickler koennen Karten gegen mindestens drei strukturell aehnliche Produktionsseiten aus unterschiedlichen Domains testen, bevor sie aufgenommen werden.
- FR30: Externe Beitragende koennen neue Karten-Kandidaten als Pull Request ins oeffentliche Seed-Repository einreichen, nach einem dokumentierten Pfad.

**Lizenzierung und Distribution:**

- FR31: Der Free-Build (MIT-lizenziert) kann den kompletten Kartentisch-Mechanismus inklusive Seed-Bibliothek und Fallback-Modus nutzen.
- FR32: Der Pro-Build kann zusaetzlich parallele Plan-Ausfuehrung, erweiterte Observability und prioritaeren Karten-Update-Kanal anbieten.
- FR33: Der Pro-Build kann eine Polar.sh-Lizenz (Umgebungsvariable oder lokale Datei) validieren und bei Offline-Zustand sieben Tage Grace-Period gewaehren.
- FR34: Nutzer koennen SilbercueChrome ueber npm (Free) oder als Node SEA Binary via GitHub-Release (Pro) installieren.

**Migration und Onboarding:**

- FR35: Die README kann einen Migrations-Abschnitt fuer v0.5.0-Umsteiger enthalten, der den Uebergang in weniger als zehn Absaetzen beschreibt.
- FR36: Die README kann drei Code-Walkthroughs enthalten, die Migration (Marek), First Contact (Annika) und Fallback (Jamal) abdecken.
- FR37: Ein v0.5.0-Bestandsnutzer kann seine Haupt-Use-Cases ohne Dokumentations-Konsultation weiterfuehren, weil der Fallback-Modus und die Seed-Karten ihn auffangen.
- FR38: Ein Neuling kann SilbercueChrome mit einer dreizeiligen MCP-Client-Config starten und die erste Browser-Aufgabe in weniger als zehn Minuten erfolgreich ausfuehren.

### NonFunctional Requirements

**Performance:**

- NFR1: Tool-Definition-Overhead im Standard-Modus unter 3000 Tokens (Vergleich: Playwright MCP 13'700, Chrome DevTools MCP rund 17'000).
- NFR2: Operator-Return-Latenz im Nennzustand unter 800 Millisekunden pro Aufruf auf einer durchschnittlichen Seite (Scan, Seitenlesart-Erzeugung und Karten-Annotation zusammen).
- NFR3: Benchmark-Gesamtlaufzeit im Operator-Modus mindestens 50 Prozent kuerzer als die v0.5.0-`run_plan`-Baseline, gemessen in Wall-Clock-Sekunden auf dem Test-Hardest-Parcours.
- NFR4: Karten-Erkennungs-Rate auf dem Benchmark-Parcours mindestens 85 Prozent (Tests, in denen mindestens ein Muster die Schwelle erreicht und eine passende Karte annotiert wird).
- NFR5: Falscherkennungs-Rate unter 5 Prozent (Karten, die ueber der Schwelle anschlagen, aber bei Ausfuehrung einen nachweisbaren Folgefehler verursachen).

**Security:**

- NFR6: Polar.sh-Lizenz-Schluessel werden weder in Log-Ausgaben noch in Telemetrie-Streams aufgezeichnet. Sie erscheinen ausschliesslich im Memory des laufenden Prozesses.
- NFR7: Phase 1 uebertraegt keinerlei Seiten-Inhalte oder Muster-Signaturen an externe Dienste. Der Operator-Scan bleibt vollstaendig lokal auf dem Nutzer-Rechner.
- NFR8: SilbercueChrome respektiert die `SILBERCUE_CHROME_PROFILE`-Einstellung und veraendert keine Profil-Daten ausserhalb der aktiven Session.
- NFR9: Fuer Phase 2 (Epic 20, nicht MVP) gilt als Privacy-by-Design-Konstruktionsvorgabe: Muster-Signaturen duerfen keine URLs, Text-Inhalte oder personenbezogenen Daten enthalten. Das MVP-Codemodell wird so strukturiert, dass der spaetere Harvester diese Felder nicht aggregieren kann.

**Scalability:**

- NFR10: SilbercueChrome laeuft als Ein-Nutzer-Prozess pro MCP-Client-Instanz. Skalierung auf mehrere Nutzer erfolgt durch mehrere unabhaengige Prozesse, nicht durch Shared-State.
- NFR11: Die Seed-Bibliothek skaliert auf mindestens 100 Karten ohne spuerbare Scan-Latenz-Einbussen gegenueber dem MVP-Start-Zustand mit 20–30 Karten. Konkret: Scan-Latenz bei 100 Karten hoechstens doppelt so hoch wie bei 30 Karten.
- NFR12: Die Container-Aggregations-Schicht ist so implementiert, dass zusaetzliche Karten keine quadratische Latenz-Explosion verursachen (Erkennung waechst hoechstens linear mit Karten-Zahl).

**Reliability:**

- NFR13: Bei Verbindungs-Verlust zum Browser versucht SilbercueChrome automatisch eine Wiederverbindung (Connection-Recovery), bevor ein Fehler an das LLM zurueckgemeldet wird. Konkret: mindestens drei Wiederverbindungs-Versuche mit Exponential Backoff.
- NFR14: Jede Seite, auf der keine Karte die Schwelle erreicht, fuehrt zu einem sauberen Fallback-Uebergang und nicht zu einem Crash, nicht zu einem leeren Return, nicht zu einer Exception.
- NFR15: Benchmark-Pass-Rate im Operator-Modus mindestens 35 von 35 Tests (gleich oder besser als die v0.5.0-`run_plan`-Baseline).

**Integration:**

- NFR16: SilbercueChrome implementiert das MCP-Protokoll ueber Stdio-Transport nach Spezifikation und funktioniert mit allen Standard-MCP-Clients ohne client-spezifische Anpassungen — validiert gegen Claude Code, Cursor und Claude Desktop.
- NFR17: SilbercueChrome nutzt das Chrome DevTools Protocol in CDP-Version 1.3 als Minimum, validiert bis Chrome 146. Neue Chrome-Versionen werden mit Zwei-Release-Cycle-Verzoegerung unterstuetzt.
- NFR18: Zur Laufzeit hat SilbercueChrome keine Netzwerk-Abhaengigkeit ausser Polar.sh-Lizenz-Check (nur Pro-Build, mit sieben Tagen Offline-Grace).

### Additional Requirements

Aus dem Architecture-Dokument abgeleitete technische Anforderungen, die auf Epic- und Story-Ebene relevant sind:

**Brownfield-Starter (kein create-*-app-Befehl).** Der Starter IST die bestehende `master`-Branch in Version 0.5.0. Es gibt keine Scaffolding-Story, stattdessen eine Branch-Schnitt-Entscheidung. Arbeit beginnt auf einem Feature-Branch (`feat/operator-phase1` oder entsprechend).

**Neue Module-Struktur unter `src/`:** `src/operator/`, `src/scan/`, `src/cards/`, `src/audit/`, plus `src/fallback-registry.ts` auf Top-Level. Die bestehenden Module (`src/cdp/`, `src/cache/`, `src/tools/`, `src/plan/`, `src/license/`, etc.) bleiben unveraendert.

**YAML-Karten-Verzeichnis auf Projekt-Ebene.** Neues Verzeichnis `cards/` (Geschwister von `src/`), enthaelt die handgepflegten Seed-Karten als YAML-Dateien plus `cards/README.md` mit Pull-Request-Leitfaden.

**ESLint-Regel `import/no-cycle`** wird aktiviert, um zirkulaere Imports zwischen den neuen Modulen zu verhindern. Import-Richtungen: `operator/` → `scan/`, `cards/`, `audit/`. `scan/` → `cache/`. `cards/` → nur Zod und `types.ts`. `audit/` → nur `types.ts`.

**Token-Budget-Enforcement.** Neuer Test `src/operator/token-budget.test.ts` nutzt das bestehende `scripts/token-count.mjs`, um pro Modul die Tokens des Return-Outputs zu messen und gegen deklarierte Budgets zu pruefen.

**Benchmark-Extension.** `test-hardest/benchmark-full.mjs` wird um einen `--operator-mode`-Flag erweitert, der den Parcours im neuen Modus faehrt und MQS, Wall-Clock-Laufzeit, Erkennungs-Rate und Falscherkennungs-Rate in eine JSON-Datei schreibt.

**Gate-Check-Skript.** Neues Skript `scripts/check-gate.ts` liest die letzte Benchmark-JSON und vergleicht gegen konfigurierbare Schwellen (Epic-18-Gate MQS ≥ 63, Tag-20-Checkpoint MQS ≥ 66, Epic-19-Abschluss MQS ≥ 70). Exit-Code 0 oder 1.

**Neue Doku-Logbuecher.** `docs/schema-migrations.md` (Versionshistorie der Datenschemas, Invariante 6) und `docs/pattern-updates.md` (Logbuch fuer Pattern-Anpassungen waehrend der Implementation).

**Fathom-Library-Spike-Story.** Mozilla Fathom ist nicht mehr aktiv gewartet (bekanntes Risiko aus Architecture-Validation Gap 2). Eine fruehe Spike-Story in Epic 19 muss entscheiden, ob die bestehende Fathom-Version mit Node 18+ und TypeScript 5.7 lauffaehig ist oder ob die relevanten Rulesets manuell portiert werden.

**State-Machine-Detail-Acceptance-Criterion.** Gap 1 aus Architecture-Validation: Bei mehrstufigen Karten-Sequenzen muss die State-Machine im EXECUTING-State bleiben, bis ALLE Schritte der `execution_sequence` durchlaufen sind, und erst dann in `POST_EXECUTION_SCAN` wechseln. Muss als expliziter Acceptance-Criterion der State-Machine-Story auftauchen.

**Sechs SilbercueChrome-spezifische Pattern-Invarianten.** Gelten uneingeschraenkt fuer jede Story in Epic 19 und sind Teil der Acceptance-Criteria: (1) Token-Budget-Disziplin mit JSDoc-`@tokens`-Annotationen, (2) Struktur-Invariante (keine URLs/Domains/Content-Strings in Karten), (3) Audit-First im Matcher, (4) Fallback als State nicht als Exception, (5) Solo-Pflegbarkeit (keine Magic Numbers, flache Klassen, keine DI-Frameworks), (6) Phase-2-Forwards-Kompatibilitaet mit `schema_version`- und `source`-Feldern.

**Friction-Fix-Stories fuer Epic 18.** Die Datei `docs/friction-fixes.md` enthaelt die Liste der Forensik-Fixes (FR-002 aufwaerts, aktueller Stand bis FR-027). Jeder FR-Eintrag wird als Story in Epic 18 geschnitten, in der Reihenfolge ihrer Impact-Sortierung. Der Haupt-Hebel ist die **Ambient-Context-Hook-Unterdrueckung**: spart auf click-lastigen Plaenen **100–1350 ms pro Click-Step** (Herleitung: die `waitForAXChange`-Wait-Konstanten 350/500/1350 ms in `src/hooks/default-on-tool-result.ts`) plus etwa **2850 Chars pro Plan** durch entfallende Ambient-Context-Snapshots. Der zeitliche Hebel skaliert mit der Anzahl der Click-/Type-Steps — Plaene ohne Transition-Steps sehen die Zeit-Einsparung nicht, die Token-Einsparung aber schon.

### UX Design Requirements

Keine. SilbercueChrome ist ein headless-orientierter MCP-Server ohne visuelles UI. Die "UX" des Produkts ist das LLM-Tool-Interface, das durch die FRs (insbesondere FR2, FR3 fuer die Seitenlesart-Struktur) und NFR1 (Tool-Definition-Overhead) bereits vollstaendig definiert ist. Das PRD hat den UX-Schritt des PRD-Workflows bewusst uebersprungen.

### FR Coverage Map

Alle 38 FRs sind zugeordnet. 6 FRs sind in bestehendem Code abgedeckt (*existing* — keine neue Story), 32 FRs werden durch Epic-19-Stories addressiert, Epic 18 deckt keine direkten FRs, sondern ist NFR-getrieben (NFR1, NFR2, NFR3, NFR15).

| FR | Epic | Story-Thema |
|---|---|---|
| FR1 | Epic 19 | Signal-Extractor |
| FR2 | Epic 19 | Return-Schema und Seitenlesart |
| FR3 | Epic 19 | Karten-Annotation im Seitenbaum |
| FR4 | Epic 19 | Matcher Score-Berechnung |
| FR5 | Epic 19 | Gegen-Signal-Check |
| FR6 | Epic 19 | Mehrere Karten pro Seite |
| FR7 | Epic 19 | Operator-Tool MCP-Handler |
| FR8 | Epic 19 | Karten-Ausfuehrung (Execution-Bundling) |
| FR9 | Epic 19 | Post-Execution-Scan (State-Machine) |
| FR10 | Epic 19 | Mehrstufige Karten-Sequenzen (Gap 1) |
| FR11 | Epic 19 | Navigation-Robustness |
| FR12 | Epic 19 | Fallback-Transition |
| FR13 | Epic 19 | Fallback-Registry mit Primitives |
| FR14 | Epic 19 | Fallback-Framing-Messages |
| FR15 | Epic 19 | Fallback-Log (Muster-Signaturen) |
| FR16 | Epic 19 | Session-Continuity zwischen Modi |
| FR17 | Epic 19 | virtual_desk-Tool-Wrapper |
| FR18 | Epic 19 | Multi-Tab-Handling im virtual_desk |
| FR19 | *existing* | Auto-Launch/WebSocket (`src/cdp/`) |
| FR20 | *existing* | Chrome-Profile (`src/cdp/`) |
| FR21 | *existing* | Connection-Recovery (`src/cdp/`) |
| FR22 | Epic 19 | why_this_card-Generator |
| FR23 | Epic 19 | Gegen-Signal-Check im Audit |
| FR24 | Epic 19 | Karten-Version im Return |
| FR25 | Epic 19 | Fallback-Log strukturell gleich zum Standard-Log |
| FR26 | Epic 19 | YAML-Karten-Schema (Card-Schema + Loader) |
| FR27 | Epic 19 | Karten-Felder (positive Signale, Gegen-Signale, Parameter, Sequenz) |
| FR28 | Epic 19 | Benchmark-Validation der Seed-Karten |
| FR29 | Epic 19 | Drei-Produktionsseiten-Test pro Karte |
| FR30 | Epic 19 | `cards/README.md` mit PR-Leitfaden |
| FR31 | Epic 19 | Free-Build Kartentisch-Scope-Verifizierung |
| FR32 | *existing* | `executeParallel` (Epic 7.6/16) |
| FR33 | *existing* | Polar.sh-Lizenz (Epic 16) |
| FR34 | *existing* | npm + SEA Distribution |
| FR35 | Epic 19 | README Migrations-Abschnitt |
| FR36 | Epic 19 | README drei Walkthroughs |
| FR37 | Epic 19 | Migrations-Probe (abgedeckt durch Fallback-Design) |
| FR38 | Epic 19 | Getting-Started-Probe (abgedeckt durch Auto-Launch) |

## Epic List

### Epic 18: Forensik-Fixes und Baseline-Absicherung

**User Outcome:** Bestandsnutzer im `run_plan`-Modus bekommen sofort spuerbar schnellere Laufzeiten und kleineren Token-Overhead — ohne warten zu muessen, bis Epic 19 fertig ist. Die MQS-Baseline wird von 60.3 auf 63–65 gehoben. Gleichzeitig wird der Kartentisch-Sprung in Epic 19 auf eine stabilere Grundlage gestellt: Wenn die Forensik-Fixes nicht greifen, gehen wir das Neuland nicht an.

**NFRs covered (Epic ist NFR-getrieben, keine direkte FR-Coverage):**

- **NFR1** (Tool-Definition-Overhead): Zwischen-Verbesserung durch Tool-Verschlankung von 25 auf 8–10 Transition-Tools.
- **NFR2** (Operator-Return-Latenz): Vorstufe durch Step-Response-Aggregation und Paint-Order-Filtering.
- **NFR3** (Wall-Clock-Laufzeit): Ambient-Context-Hook-Unterdrueckung spart auf click-lastigen Plaenen **100–1350 ms pro Click-Step** (Herleitung: die `waitForAXChange`-Wait-Konstanten 350/500/1350 ms in `src/hooks/default-on-tool-result.ts`) plus etwa **2850 Chars pro Plan** durch entfallende Ambient-Context-Snapshots. Der zeitliche Hebel skaliert mit der Anzahl der Click-/Type-Steps — Plaene ohne Transition-Steps sehen die Zeit-Einsparung nicht, die Token-Einsparung aber schon.
- **NFR15** (Pass-Rate erhalten): Der bestehende 35/35-Benchmark-Stand darf nicht regressieren.

**Gate fuer Epic-18-Abschluss:** `scripts/check-gate.ts` misst **MQS >= 63** auf dem Test-Hardest-Parcours. Ohne dieses Gate wird Epic 19 nicht gestartet.

**Story-Quelle:** Die in der PRD (prd.md:143) und Architecture (architecture.md:823) benannten sechs Forensik-Hebel: Ambient-Context-Hook-Unterdrueckung, Step-Response-Aggregation, Tool-Verschlankung, Paint-Order-Filtering, Speculative Prefetch, plus die offenen Friction-Fixes FR-028 aufwaerts aus `docs/friction-fixes.md`. Die historischen Eintraege FR-002 bis FR-027 sind laut Status-Tabelle bereits gefixt und gehen nicht mehr in neue Stories ein.

### Story 18.1: Ambient-Context-Hook in run_plan unterdruecken

As a Plan-Nutzer,
I want, dass `run_plan` zwischen den Steps keine ganze Seitenlesart mitschickt,
So that meine Plaene spuerbar schneller laufen und mein Token-Budget nicht explodiert.

**Acceptance Criteria:**

**Given** ein laufender `run_plan` mit mehreren click- oder type-Steps
**When** ein Step abgeschlossen ist und der naechste startet
**Then** liefert der Zwischen-Return nur die Minimal-Bestaetigung (Erfolg, geaenderter Ref, keine Compact-Snapshot-Einblendung)
**And** am Ende des kompletten Plans kommt der aggregierte Kontext einmal, nicht pro Step
**And** das `scripts/token-count.mjs`-Delta weist pro Plan mindestens 2000 Chars weniger aus, gegen den aktuellen Baseline-Run gemessen
**And** die Wall-Clock-Zeit pro Plan sinkt um mindestens 1000 ms gegen Baseline

### Story 18.2: Step-Response-Aggregation verschmaelern

As a run_plan-Nutzer,
I want einen einzigen kompakten Aggregat-Return am Plan-Ende,
So that ich nicht zehn Zwischen-Payloads durchpfluegen muss.

**Acceptance Criteria:**

**Given** ein `run_plan` mit N Steps
**When** der Plan erfolgreich durchlaeuft
**Then** liefert der Return genau einen Aggregations-Block am Ende mit pro Step einer Zeile (Tool, Status, relevanter Ref oder Fehler)
**And** die Wall-Clock-Zeit auf dem Test-Hardest-Level-1-Parcours ist mindestens 500 ms kuerzer als Baseline
**And** bei Step-Fehlern wird der Fehler-Kontext vollstaendig gezeigt, die Aggregation kuerzt nur erfolgreiche Steps

### Story 18.3: Tool-Verschlankung auf ein Transition-Set

As a LLM-Nutzer,
I want im Default nur die acht bis zehn Tools sehen, die ich wirklich brauche,
So that mein Tool-Auswahl-Overhead sinkt.

**Acceptance Criteria:**

**Given** ein frisch verbundener MCP-Client
**When** der Client `tools/list` aufruft
**Then** exportiert SilbercueChrome im Default nur das Transition-Set (etwa `virtual_desk`, `navigate`, `read_page`, `click`, `type`, `fill_form`, `wait_for`, `run_plan`, `screenshot`, `evaluate`)
**And** ein Opt-in-Flag `SILBERCUE_CHROME_FULL_TOOLS=true` exportiert wieder den vollen Satz
**And** der Test-Hardest-Benchmark passt 35/35 mit dem Default-Set ohne Regression

### Story 18.4: Paint-Order-Filtering fuer verdeckte Elemente

As a LLM-Nutzer,
I want, dass der A11y-Tree keine Elemente listet, die visuell von einem Overlay verdeckt sind,
So that ich nicht auf Geister klicke.

**Acceptance Criteria:**

**Given** eine Seite mit einem sichtbaren Modal-Overlay vor einem Button-Grid
**When** `read_page` aufgerufen wird
**Then** enthaelt der Output nur noch die Elemente, die im Paint-Order-Stapel sichtbar sind (Modal-Elemente) — die verdeckten Button-Grid-Refs werden weggefiltert
**And** der Filter respektiert `z-index` und `pointer-events: none`
**And** ein neuer Test `a11y-tree.test.ts` deckt den Fall mit einem Overlay vor einem Link-Cluster ab

### Story 18.5: Speculative Prefetch waehrend LLM-Denkzeit

As a LLM-Nutzer,
I want, dass SilbercueChrome nach einem Tool-Call im Hintergrund bereits den naechsten voraussichtlichen Seitenzustand vorlaedt,
So that meine naechste Anfrage ohne Netzwerk-Wartezeit bedient wird.

**Acceptance Criteria:**

**Given** ein beendeter `navigate`- oder `click`-Call mit resultierender Seitenumladung
**When** der Return ans LLM zurueckgeht
**Then** startet der Server direkt danach im Hintergrund einen A11y-Tree-Build, ohne den Return zu blockieren
**And** der naechste `read_page`-Call nutzt den vorgewaermten Tree, wenn die URL noch passt
**And** bei URL-Wechsel zwischen Prefetch und Nutzung wird der Vorratsbau verworfen, ohne Fehler zu melden
**And** der Prefetch belegt maximal einen Slot pro Session (keine unbegrenzte Background-Queue)

### Story 18.6: Friction-Fix-Batch FR-028 aufwaerts

As a Maintainer,
I want die fuenf offenen Friction-Fixes aus `friction-fixes.md` gebuendelt in einer Story abarbeiten,
So that das Story-Inventar nicht fuer Mini-Fixes aufgeblasen wird.

**Acceptance Criteria:**

**Given** die Friction-Eintraege FR-028 (Drag&Drop), FR-029 (AJAX-Race nach click), FR-030 (Benchmark aus /tmp), FR-031 (Cross-Platform-Binaries), FR-032 (Memory-Cleanup)
**When** die Story geschlossen wird
**Then** sind FR-028 und FR-029 im Code behoben und mit Tests abgedeckt
**And** FR-030 ist als Prozess-Aenderung im Benchmark-Skill dokumentiert
**And** FR-031 liefert zusaetzlich ein Linux-x64-Binary im Release-Asset-Satz
**And** FR-032 hat die als historisch markierten Memory-Eintraege entfernt oder umetikettiert
**And** die Status-Tabelle in `friction-fixes.md` ist auf "gefixt" aktualisiert

### Story 18.7: Epic-18-Gate-Check

As a Maintainer,
I want einen maschinellen Gate-Check, der Epic 19 blockiert, bis die Forensik-Fixes nachweislich gegriffen haben,
So that wir das Kartentisch-Neuland nicht auf einer wackligen Grundlage angehen.

**Acceptance Criteria:**

**Given** alle Stories 18.1 bis 18.6 sind gemerged
**When** `scripts/check-gate.ts --epic 18` laeuft
**Then** liest es die letzte Benchmark-JSON und verifiziert MQS >= 63 sowie Pass-Rate >= 35/35
**And** Exit-Code ist 0 bei Erfolg, 1 bei Unterschreitung mit einer klaren Konsolen-Meldung, welches Kriterium gefehlt hat
**And** die Entscheidung (Gate bestanden oder nicht) wird in `docs/pattern-updates.md` protokolliert
**And** ohne bestandenes Gate startet Epic 19 nicht — dieser Satz steht als Durchfuehrungs-Anweisung im Gate-Check-Output

### Epic 19: Operator Kartentisch, Seed-Bibliothek, Fallback

**User Outcome:** Marek, Annika, Jamal und Lena erleben den Kartentisch-Paradigma-Wechsel in ihren Journeys. Login-Automationen, Screenshot-Sweeps, mehrstufige Formulare und Audit-faehige Falsch-Match-Diagnose funktionieren. Der Standard-Modus exportiert zwei Top-Level-Tools (`virtual_desk`, `operator`), der Fallback-Modus fuenf bis sechs Primitives — und die gesamte MQS-Wette ist messbar.

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8, FR9, FR10, FR11, FR12, FR13, FR14, FR15, FR16, FR17, FR18, FR22, FR23, FR24, FR25, FR26, FR27, FR28, FR29, FR30, FR31, FR35, FR36, FR37, FR38 (insgesamt 32 FRs).

**NFRs covered:** NFR1 (finale Unterschreitung von 3000 Tokens), NFR2 (Operator-Return-Latenz < 800 ms), NFR4 (Erkennungs-Rate >= 85%), NFR5 (Falscherkennungs-Rate < 5%), NFR9 (Phase-2-Bridge im Schema), NFR11, NFR12, NFR14 — alle architektonisch in die Stories verwoben.

**Zwischencheckpoint (Tag 20):** `scripts/check-gate.ts` misst **MQS >= 66**. Bei Unterschreitung: Nachsteuerung (Seed-Bibliothek erweitern, Fallback-Schwelle schaerfen) statt Durchziehen.

**Gate fuer Epic-19-Abschluss:** **MQS >= 70, Erkennungs-Rate >= 85%, Wall-Clock >= 50% kuerzer als Baseline, Pass-Rate >= 35/35, Tool-Definition-Overhead < 3000 Tokens**. Alle fuenf muessen gleichzeitig erreicht sein.

**Bekannte Spike-Stories innerhalb Epic 19:**

- **Fathom-Verfuegbarkeit** — frueh in Epic 19 einzuplanen (Gap 2 aus Architecture-Validation). Mozilla Fathom ist nicht mehr aktiv gewartet; die Spike muss entscheiden, ob die bestehende Version mit Node 18+ und TypeScript 5.7 lauffaehig ist oder ob die relevanten Rulesets manuell portiert werden.
- **State-Machine-Detail bei mehrstufigen Karten** — als Acceptance-Criterion der State-Machine-Story (Gap 1 aus Architecture-Validation). Bei mehrstufigen `execution_sequence`-Karten muss die State-Machine im `EXECUTING`-State bleiben, bis **alle** Schritte durchlaufen sind, und erst dann in `POST_EXECUTION_SCAN` wechseln.

**Dependency zu Epic 18:** Epic 19 startet erst, wenn Epic 18 sein Gate erreicht hat (MQS >= 63). Innerhalb Epic 19 sind die Stories so geschnitten, dass sie in der folgenden Reihenfolge gebaut werden koennen, ohne dass eine Story auf eine spaetere wartet: Card Data Model → Fathom-Spike (parallel) → Scan-Match-Pipeline → Operator State Machine → Return Schema → Fallback Mode → Audit Layer → virtual_desk → Seed Library Validation → README + Migration → Free-Build-Scope-Verifizierung.

### Story 19.1: Card Data Model mit drei Seed-Karten

As a Maintainer,
I want ein sauberes, in Git pflegbares Karten-Schema plus Loader plus drei handgepflegte Seed-Karten,
So that der ganze Kartentisch-Mechanismus auf einem geprueften Fundament aufsetzt.

**Acceptance Criteria:**

**Given** ein leeres `cards/`-Verzeichnis und kein `src/cards/`-Modul
**When** die Story geschlossen wird
**Then** existiert `src/cards/card-schema.ts` mit einem Zod-Schema, das positive Signale, Gegen-Signale, Parameter-Schema, Execution-Sequenz und die Felder `schema_version` plus `source` erzwingt
**And** `src/cards/card-loader.ts` laedt alle YAML-Dateien aus `cards/` und wirft bei Verstoessen gegen die Struktur-Invariante (URLs, Domains, Content-Strings) einen Validation-Fehler
**And** drei Seed-Karten (zum Beispiel `login-form`, `search-result-list`, `article-reader`) liegen als YAML in `cards/` und passieren die Schema-Validation
**And** `cards/README.md` dokumentiert den PR-Leitfaden fuer externe Beitraege (FR30)
**And** Unit-Tests in `card-schema.test.ts` decken alle sechs Pattern-Invarianten als negative Assertions ab (Test schlaegt fehl, wenn eine Karte eine URL enthaelt, Magic Number, etc.)

### Story 19.2: Fathom-Library-Spike

As a Maintainer,
I want eine klare Entscheidung, ob Mozilla Fathom im aktuellen Stack lauffaehig ist,
So that die Scan-Match-Pipeline nicht an einer ungeklaerten Library-Frage haengen bleibt.

**Acceptance Criteria:**

**Given** die offene Frage aus Architecture-Validation Gap 2 (Fathom nicht mehr aktiv gewartet)
**When** die Spike abgeschlossen ist
**Then** liegt in `docs/pattern-updates.md` eine Entscheidungs-Notiz mit Datum, Versuch, Ergebnis und Empfehlung (Fathom nutzen oder Rulesets manuell portieren)
**And** ein minimales Beispiel-Ruleset laeuft mit Node 18+, TypeScript 5.7 und der aktuellen `package.json` durch, oder die Notiz dokumentiert den konkreten Blocker
**And** die Story 19.4 (Aggregator und Matcher) kann ohne weitere Vorarbeit starten, weil die Library-Frage entschieden ist

### Story 19.3: Signal-Extractor

As a Scan-Pipeline,
I want DOM-Signale aus einer Seite extrahieren koennen, ohne bereits zu matchen,
So that Aggregator und Matcher saubere Eingabedaten bekommen.

**Acceptance Criteria:**

**Given** eine geladene Seite mit HTML, CSS und ARIA-Attributen
**When** `signalExtractor.extract(page)` aufgerufen wird
**Then** liefert die Funktion eine Liste strukturierter Signale (Tag, Role, Attribute, Position im DOM-Baum), ohne URLs, Content-Strings oder personenbezogene Daten
**And** die Extraction-Latenz auf einer Benchmark-Seite liegt unter 150 ms
**And** ein JSDoc-Kommentar `@tokens max 800` begrenzt die Signal-Liste, `token-budget.test.ts` verifiziert die Einhaltung
**And** keine Magic Numbers im Code — alle Schwellen stehen als benannte Konstanten am Datei-Kopf (Invariante 5)

### Story 19.4: Aggregator, Matcher und why_this_card

As a Operator,
I want fuer jede Karte einen Score berechnen, Gegen-Signale pruefen und ein vollstaendiges Audit-Objekt zurueckbekommen,
So that Falsch-Matches nachvollziehbar bleiben.

**Acceptance Criteria:**

**Given** eine Karte aus der Seed-Bibliothek und eine Liste extrahierter Signale
**When** `matchCard(card, signals)` aufgerufen wird
**Then** liefert die Funktion immer ein Objekt `{matched, score, signal_breakdown, counter_signal_checks}`, auch bei Nicht-Match — kein `null`, kein throw, kein leerer Return (Audit-First, Invariante 3)
**And** Karten unterhalb der Erkennungs-Schwelle werden mit `matched: false` und dem kompletten Breakdown zurueckgegeben, damit im Audit sichtbar wird, warum sie nicht gewaehlt wurden
**And** Gegen-Signale werden auf Document-Body-Ebene geprueft, Ergebnisse stehen im `counter_signal_checks`-Array (FR5, FR23)
**And** die Matcher-Latenz bei 30 Seed-Karten liegt unter 200 ms, bei 100 Karten unter 400 ms (NFR11, NFR12)
**And** die Falscherkennungs-Rate auf dem Test-Hardest-Parcours bleibt unter 5% (NFR5)

### Story 19.5: Operator Return Schema und Seitenlesart

As a LLM,
I want eine strukturierte Seitenlesart mit direkt am Seitenbaum verankerten Karten-Annotationen,
So that ich nicht zwischen separater Karten-Liste und `read_page`-Output mental hin- und herspringen muss.

**Acceptance Criteria:**

**Given** ein abgeschlossener Scan-Lauf mit einer oder mehreren matchenden Karten
**When** `operator.buildReturn()` aufgerufen wird
**Then** liefert es eine hierarchische Seitenlesart mit Titel, Content-Bloecken und interaktiven Elementen mit Ref-Handles, die den bisherigen separaten `read_page`-Aufruf im Standard-Modus ersetzt (FR2)
**And** Karten-Annotationen sind direkt an dem Element verankert, auf das sie sich beziehen, nicht als separate Liste daneben (FR3)
**And** mehrere Karten auf einer Seite werden an unterschiedlichen Stellen annotiert, wenn die Seite mehrere unabhaengige Struktur-Klassen enthaelt (FR6)
**And** der Return-Payload liegt unter 2500 Tokens auf einer typischen Benchmark-Seite (JSDoc `@tokens max 2500` plus `token-budget.test.ts`)
**And** das Schema enthaelt `schema_version` und `source` fuer Phase-2-Forwards-Kompatibilitaet (Invariante 6)

### Story 19.6: Operator State Machine

As a Operator,
I want eine explizite State-Machine, die SCAN, MATCH, EXECUTING und POST_EXECUTION_SCAN als erstklassige Zustaende fuehrt,
So that der Loop robust bleibt und mehrstufige Karten sauber abgearbeitet werden.

**Acceptance Criteria:**

**Given** eine matchende Karte mit mehrstufiger `execution_sequence` (zum Beispiel ein zweischrittiges Formular)
**When** die State-Machine den EXECUTING-State betritt
**Then** bleibt sie im EXECUTING-State, bis **alle** Schritte der `execution_sequence` durchlaufen sind, und wechselt erst dann zu POST_EXECUTION_SCAN (Gap-1-Acceptance-Criterion aus Architecture-Validation, FR9, FR10)
**And** Navigations-Ereignisse waehrend der Sequenz (Page Load, Redirect, Tab-Wechsel) werden sauber gehandhabt, ohne den Loop zu brechen (FR11)
**And** der Fallback-Modus wird als expliziter State `FALLBACK` modelliert, nicht als Exception oder try/catch (Invariante 4)
**And** Unit-Tests decken mindestens fuenf State-Uebergaenge ab, inklusive des mehrstufigen-Karten-Pfads

### Story 19.7: Top-Level-Tools operator und virtual_desk

As a MCP-Client,
I want im Standard-Modus nur zwei Top-Level-Tools sehen,
So that der Tool-Definition-Overhead unter 3000 Tokens bleibt und das LLM keine Auswahl zwischen 25 Primitives treffen muss.

**Acceptance Criteria:**

**Given** ein frisch verbundener MCP-Client im Standard-Modus
**When** der Client `tools/list` aufruft
**Then** exportiert SilbercueChrome genau zwei Tools: `virtual_desk` (Session- und Tab-Verwaltung, FR17, FR18) und `operator` (Scan, Match, Execute, FR7)
**And** der gesamte Tool-Definition-Overhead liegt unter 3000 Tokens (NFR1), gemessen durch `token-budget.test.ts`
**And** das `operator`-Tool akzeptiert als Parameter die vom LLM gewaehlte Karte plus deren Parameter-Werte
**And** der Handler ruft die State-Machine aus 19.6 auf und liefert einen Return nach 19.5-Schema
**And** die Operator-Return-Latenz im Nennzustand liegt unter 800 ms auf einer Benchmark-Seite (NFR2)

### Story 19.8: Fallback-Registry und Mode-Transition

As a LLM,
I want, dass der Fallback-Modus keinen Fehlerzustand signalisiert, sondern als expliziter, eigenstaendiger Arbeitsmodus kommt,
So that ich nicht panisch zu evaluate ausweiche.

**Acceptance Criteria:**

**Given** ein Operator-Return, bei dem keine Karte die Erkennungs-Schwelle erreicht hat
**When** die State-Machine in den FALLBACK-State wechselt
**Then** exportiert SilbercueChrome via MCP `notifications/tools/list_changed` einen neuen Tool-Satz mit fuenf bis sechs Primitives (`click`, `type`, `read`, `wait`, `screenshot`, optional `evaluate`) — FR12, FR13
**And** der Return enthaelt ein explizites Framing wie "no card matched, switching to direct-primitive mode" — kein Error-Framing (FR14)
**And** Session und Tab-Referenzen bleiben beim Mode-Wechsel gueltig (FR16)
**And** der Rueckweg vom FALLBACK in den Standard-Modus nach einem erneuten Scan mit Karten-Match wird von der State-Machine sauber behandelt, ohne Tool-List-Flicker
**And** NFR14 wird getestet: keine Seite ohne Karten-Match fuehrt zu Crash, leerem Return oder Exception

### Story 19.9: Fallback-Logbuch mit Muster-Signaturen

As a Maintainer,
I want, dass jeder Fallback-Lauf strukturelle Muster-Signaturen protokolliert,
So that Epic 20 spaeter ohne Schema-Migration daran andocken kann.

**Acceptance Criteria:**

**Given** ein aktiver Fallback-Lauf auf einer Seite ohne Karten-Match
**When** der Lauf endet
**Then** liegt ein Fallback-Log-Eintrag vor, der strukturell gleichwertig zum Standard-Log ist (FR25) und beschreibt, welche Signale geprueft wurden und warum keine Karte traf
**And** der Log enthaelt keine URLs, Text-Inhalte oder personenbezogene Daten — Privacy-by-Design-Schema-Assertion (NFR9) in einem eigenen Test
**And** Muster-Signaturen werden registriert und sind ueber eine interne `harvest`-API abfragbar, die im MVP nur von Tests aufgerufen wird (FR15)
**And** das Log-Schema traegt `schema_version` und `source` (Invariante 6)

### Story 19.10: Seed-Library Validation und Benchmark-Integration

As a Maintainer,
I want, dass keine Karte in die Seed-Bibliothek kommt, bevor sie gegen den Benchmark-Parcours und gegen drei echte Produktionsseiten getestet wurde,
So that die Seed-Qualitaet ab Tag eins stimmt.

**Acceptance Criteria:**

**Given** eine neue Karten-YAML im `cards/`-Verzeichnis
**When** die Validation-Pipeline laeuft
**Then** passiert die Karte den Schema-Check aus 19.1, laeuft erfolgreich gegen `test-hardest/benchmark-full.mjs --operator-mode` (FR28) und trifft in mindestens drei strukturell aehnlichen Produktionsseiten aus unterschiedlichen Domains (FR29)
**And** `scripts/check-gate.ts` liest die resultierende JSON und prueft Erkennungs-Rate >= 85% sowie Falscherkennungs-Rate < 5% (NFR4, NFR5)
**And** die Benchmark-JSON enthaelt MQS, Wall-Clock-Laufzeit, Erkennungs-Rate, Falscherkennungs-Rate als eigene Felder
**And** eine Karte, die eines dieser Kriterien verfehlt, wird nicht gemerged — der Gate-Check schlaegt fehl

### Story 19.11: Tag-20-Zwischencheckpoint

As a Maintainer,
I want an Tag 20 eine ehrliche Zwischenbilanz,
So that ich bei Unterschreitung nachsteuern kann statt durchzuziehen.

**Acceptance Criteria:**

**Given** der Stand der Implementation nach rund 20 Arbeitstagen (ungefaehr zur Haelfte von Epic 19)
**When** `scripts/check-gate.ts --checkpoint tag-20` laeuft
**Then** prueft es die letzte Benchmark-JSON gegen MQS >= 66 und Pass-Rate >= 35/35
**And** bei Unterschreitung wird eine Nachsteuerungs-Notiz in `docs/pattern-updates.md` angelegt mit den drei Optionen Seed-Bibliothek erweitern, Fallback-Schwelle schaerfen, oder Scope schneiden
**And** der User (Julian) entscheidet auf Basis dieser Notiz, ob Epic 19 weiterlaeuft oder der Scope geschnitten wird — die Story selbst trifft keine Entscheidung, sie produziert nur die Entscheidungsgrundlage

### Story 19.12: README-Migration und Onboarding-Walkthroughs

As a v0.5.0-Bestandsnutzer oder Neuling,
I want einen klaren Migrations-Abschnitt und drei Walkthroughs,
So that ich ohne Vorwissen oder mit minimaler Anpassung loslegen kann.

**Acceptance Criteria:**

**Given** die komplette Operator-Phase-1-Implementation steht
**When** die README aktualisiert wird
**Then** enthaelt sie einen Migrations-Abschnitt fuer v0.5.0-Umsteiger in weniger als zehn Absaetzen (FR35)
**And** drei Walkthroughs mit Code-Beispielen liegen vor: Migration (Marek), First Contact (Annika), Fallback (Jamal) — FR36
**And** ein Bestandsnutzer kann seine Haupt-Use-Cases ohne weitere Doku-Konsultation weiterfuehren, weil der Fallback-Modus ihn auffaengt (FR37) — validiert durch einen manuellen Smoke-Test, dokumentiert in `docs/pattern-updates.md`
**And** ein Neuling startet SilbercueChrome mit einer dreizeiligen MCP-Client-Config und fuehrt die erste Browser-Aufgabe in unter zehn Minuten erfolgreich aus (FR38) — validiert durch einen zweiten Smoke-Test
**And** die Free-Build-Scope-Verifizierung laeuft mit: der Free-Build kann Kartentisch, Seed-Bibliothek und Fallback-Modus vollstaendig nutzen (FR31)

### Story 19.13: Epic-19-Abschluss-Gate

As a Maintainer,
I want einen einzigen Gate-Check, der alle fuenf Abschluss-Kriterien gleichzeitig prueft,
So that Epic 19 erst dann als "done" gilt, wenn die ganze MQS-Wette aufgegangen ist.

**Acceptance Criteria:**

**Given** alle Stories 19.1 bis 19.12 sind gemerged und der Zwischen-Checkpoint 19.11 ist bestanden
**When** `scripts/check-gate.ts --epic 19` laeuft
**Then** prueft es gleichzeitig: MQS >= 70, Erkennungs-Rate >= 85%, Wall-Clock-Laufzeit mindestens 50% kuerzer als v0.5.0-Baseline, Pass-Rate >= 35/35, Tool-Definition-Overhead < 3000 Tokens
**And** Exit-Code ist 0 nur, wenn alle fuenf Kriterien gleichzeitig erfuellt sind — ein einzelner Verfehler blockt das Gate
**And** die Konsolen-Meldung benennt bei Fehlschlag exakt, welche Kriterien gefehlt haben, damit klar ist, wo nachzusteuern ist
**And** bei bestandenem Gate wird automatisch ein Eintrag in `docs/schema-migrations.md` und `docs/pattern-updates.md` mit Datum, Version und Benchmark-Werten angelegt
**And** ein bestandenes Gate ist die Voraussetzung fuer das Taggen einer neuen SilbercueChrome-Release-Version
