# Sprint Change Proposal — Vision-POC als Friction-Gate

**Datum:** 2026-04-18
**Trigger:** Frictioneer-Session ef027252 (Amazon-Steuer-Workflow, 51 MCP-Calls davon 31 evaluate = 61%)
**Scope:** Moderate — Process Pivot mit Gate (kein Architektur-Umbau, kein FR-Strich)
**Autor:** Julian (via Correct Course Workflow)
**Status:** PENDING APPROVAL

---

## 1. Issue Summary

### Problem-Statement

Die heutige Frictioneer-Session ef027252 hat einen Amazon-Steuer-Workflow analysiert: 51 MCP-Calls, davon 31 evaluate (61 %). Der Nutzer Julian hat daraus eine strategische Frage abgeleitet, die groesser ist als der klassische Friction-Loop:

> **Verzetteln wir uns? Koennte ein grosser Teil der Friction-Liste (aktuell 44 Eintraege in `docs/friction-fixes.md`) mit einem visuellen Ansatz grundlegend geloest werden, statt jede Kategorie-A-Friction einzeln nachzujagen?**

Die Frage ist legitim und verdient eine datengestuetzte Antwort, bevor die Friction-Pipeline in Kategorie A weitergefuehrt wird.

### Kategorisierung des Change-Triggers

**Strategic Pivot mit Gate.** Kein Fehler in der Implementierung, kein Bug. Sondern eine Erkenntnis ueber das Grenzprodukt der aktuellen Optimierungsrichtung. Die bisherige Strategie lautet *pure DOM mit capture_image als bewusst unterbewertetem Side-Tool*. Die Tool-Description sagt woertlich: `capture_image is ONLY for CSS layout checks, canvas content, or when the user explicitly asks for a screenshot`. Das ist eine selbst gebaute Barriere gegen den Hybrid-Ansatz.

### Evidenz

**Konkrete MCP-Nutzungsdaten (Session ef027252):**

- 51 MCP-Calls, 108.706 Chars MCP-Output
- 31 evaluate-Calls (61 %) — 4 evaluate-Spiralen: 3x, 5x, 3x, 5x
- 12x navigate ohne folgendes view_page (blind-Navigation)
- 3x navigate auf dieselbe URL als Reload-Ersatz (FR-044 existiert bereits)
- click(text: "07. April 2026") klickte falsche Bestellung (Text-Match-Ambiguation)
- run_plan mit 3x scroll 5000px lief auf Viewport-Ende 1471/1470px — der interne virtualisierte React-Native-Web-Container (scrollHeight 17456px) wurde nie erreicht

**Live-Verifikation heute mit MCP (Amazon-Zahlungsseite, Tab 2):**

- `view_page(filter: "interactive")` zeigt alle 38 Transaktionen e700 bis e737 als saubere Refs. Die Daten sind verfuegbar — das LLM hatte in der Session aber `filter: "all", max_tokens: 3000` gewaehlt, was auf Header downsampled hat.
- `scroll(container_selector: "div.css-g5y9jx.r-150rngu.r-eqz5dr.r-16y2uox")` scrollt den internen Container sofort (position 16738/16770, content loaded 32px). Das Tool kann es — das LLM wusste nur nicht, wie man den Container ohne evaluate findet.

**Research-Rueckendeckung (aus `docs/research/llm-tool-steering.md` und Memory-Referenz `reference_browser-automation-techniques`):**

| Ansatz | WebVoyager-Score | Quelle |
|--------|------------------|--------|
| Pure Vision (nur Screenshots) | 30,8 % | WebVoyager-Paper |
| Set-of-Mark (SoM: Screenshot + DOM-Ref-Overlay) | 59,1 % | microsoft/SoM |
| Hybrid Vision+DOM (Surfer-H) | 92,2 % | dokumentierter SoTA |

**Zitat aus der Research:** *"Pure Vision oder Pure DOM verlieren beide."*

### Friction-Liste kategorisiert

Alle 44 FR-Eintraege aus `docs/friction-fixes.md` plus 8 heutige neue Frictions (A bis I) wurden nach Ursache gruppiert:

| Kategorie | Anzahl | Beschreibung | Durch Vision-Hybrid entschaerft? |
|-----------|--------|--------------|-----------------------------------|
| **A — Sichtbarkeit** | ~12 | LLM sieht die Seite nicht (Scroll-Container, iframes, Canvas, Modals, virtualisierter Content, Text-Ambiguation) | Ja, strukturell. SoM loest das Gros. |
| **B — Verhalten** | 3 | Panik-Fallback, evaluate-Spirale trotz FR-020 | Nur teilweise. Panik bleibt modellnah. |
| **C — Infrastruktur** | ~29 | Protokoll, Cache, Timing, Build, Response-Design | Nein. Bleibt komplett. |

**Kernaussage:** ~27 % der offenen Friction-Oberflaeche (Kategorie A) koennten strukturell durch einen Hybrid-Vision-Ansatz geloest werden, statt einzeln nachgejagt. Die uebrigen 73 % (B+C) bleiben ohnehin relevant.

---

## 2. Impact Analysis

### Epic Impact

| Epic | Status | Impact | Details |
|------|--------|--------|---------|
| Epic 1 (Page Reading & Navigation) | done | **Minimal** | `capture_image` (FR3) existiert bereits. Falls POC gewinnt: Tool-Description-Review noetig. |
| Epic 2 (Element Interaction) | done | Kein | Interaktions-Primitive unveraendert. |
| Epic 3 (Automated Multi-Step) | done | Kein | run_plan unveraendert. |
| Epic 4 (Tab & Download) | done | Kein | |
| Epic 5 (Connection & Reliability) | done | Kein | |
| Epic 6 (Intelligent Tool Steering) | in-progress | **Moderat** | Stories 6.1 und 6.2 sind deferred post-v1.0. POC-Ergebnis bestimmt, ob 6.1 weiter deferred bleibt oder durch POC-Findings neu geschnitten wird. |
| Epic 7 (Distribution & Licensing) | done | Kein | |
| Epic 8 (Documentation & v1.0) | done | Kein | v1.0.0 released, POC ist explizit POST-v1.0. |
| Epic 9 (Script API Shared Core) | in-progress | Kein | Script-API unabhaengig von Vision-Frage. |

### Story Impact

**Bestehende Stories — kein Rollback:**
- Alle done-Stories bleiben done.
- Stories 6.1, 6.2 bleiben deferred. Kein Review vor POC-Entscheidung.

**Neue Stories — POC-Spike:**
- Genau eine neue Story im Spike-Format (zeit- und umfangsbegrenzt).
- Epic-Zuordnung: **Neuer Epic 10 "Vision-Hybrid POC"** als Container fuer die POC-Story. Epic 10 ist bewusst minimal — nur der POC. Folge-Arbeit je nach Ergebnis.

### PRD Impact

Kein Eingriff in bestehende FRs:
- FR3 (Komprimierter Screenshot) bleibt. `capture_image` existiert.
- FR25-FR29 (Steering) bleiben. POC tangiert nicht die Steering-Schicht.

**Bedingte zukuenftige PRD-Ergaenzung** (nur falls POC gewinnt):
- Neues FR40: `capture_som` — Screenshot mit nummeriertem DOM-Ref-Overlay.
- Neues NFR20: Hybrid-Vision-Latenz (analog NFR1-NFR4).
- **Diese Ergaenzung ist NICHT Teil dieses CC. Sie folgt erst bei Erfolg des POC via separatem `bmad-create-epics-and-stories`-Lauf.**

### Architecture Impact

Kein Eingriff in die bestehende Architektur. Der POC nutzt:
- Vorhandene Tools: `view_page`, `capture_image`, `click(ref)`, `scroll(container_selector)`.
- Optional einen 50-Zeilen-Prototyp `capture_som`, der DOMSnapshot-Bounds + Screenshot kombiniert (kein Production-Code, rein evaluativ).

**Bedingte zukuenftige Architektur-Ergaenzung** (nur falls POC gewinnt): Neuer Abschnitt "Vision-Hybrid-Layer" mit SoM-Overlay-Generierung und Token-Budget-Integration. **Kein Teil dieses CC.**

### UI/UX Impact

Kein Eingriff. SilbercueChrome hat keine UI (epics.md: "Entfaellt — SilbercueChrome ist ein MCP-Server ohne eigene UI").

### Andere Artefakte

- `docs/friction-fixes.md` bekommt einen **Header-Hinweis**: "Kategorie-A-Fixes sind zwischen 2026-04-18 und POC-Entscheidung pausiert. Kategorie B und C laufen weiter." Keine FR-Eintraege werden geloescht oder umgeschrieben.
- `test-hardest/` benoetigt keine Aenderungen. Der POC wird auf Amazon.de reproduziert, nicht auf der Benchmark-Testseite.
- Keine CI/CD-Aenderungen.

---

## 3. Recommended Approach

### Pfad-Optionen aus der Checklist-Evaluation

**Option 1: Direct Adjustment (empfohlen)**

Ein neues Epic 10 mit einer Spike-Story. Kategorie-A-Frictions werden im Friction-Log als "paused-pending-POC" markiert. Kategorie B und C laufen parallel weiter.

- Effort: **Low** — halber bis ganzer Tag fuer den POC, plus 1-2 h fuer die CC-Artefakte.
- Risk: **Low** — POC ist klar abgrenzbar, reversibel (paused != deleted).
- Timeline-Impact: **Keiner** auf v1.0 (released), **halber Tag** auf offene Arbeit.

**Option 2: Rollback**

Nicht sinnvoll. Es gibt nichts zurueckzurollen — alle bisherigen Friction-Fixes sind orthogonal zur Vision-Frage und bleiben auch bei POC-Erfolg nuetzlich.

- **NICHT VIABLE.**

**Option 3: PRD MVP Review / direkter Vision-Pivot ohne POC**

Den v1.0-Scope um capture_som erweitern, Tool-Description von capture_image oeffnen, mehrere neue Stories. Bedeutet: ohne Evidenz einen Hybrid-Layer in Produkt-Code schreiben.

- Effort: **High** — 3-5 Stories, Architektur-Review, neue Tests.
- Risk: **High** — falls Hybrid nicht gewinnt, ist Arbeit verloren. Die Research zeigt zwar 92,2 % fuer Surfer-H, aber unser LLM ist nicht Surfer-H, unsere Testszenarien sind nicht WebVoyager.
- **NICHT EMPFOHLEN — zu aggressiv ohne eigene Daten.**

### Gewaehlter Pfad: Option 1 — Direct Adjustment mit Gate

Das Gate schuetzt beide Seiten:
- Wenn POC verliert, ist Kategorie-A-Pause aufgehoben, es geht weiter mit FR-045 und Folge-Frictions. Verlust: ein Tag.
- Wenn POC gewinnt, haben wir Evidenz fuer einen fundierten Hybrid-Pivot via `bmad-create-epics-and-stories` (neues Epic 11 o.ae.).

### Entscheidungs-Kriterium fuer POC-Erfolg

Quantitativ messbar gegen die Original-Session ef027252:

| Metrik | Original | Gewinn-Schwelle |
|--------|----------|-----------------|
| MCP-Calls | 51 | < 35 (-30 %) |
| evaluate-Anteil | 61 % | < 25 % |
| Tokens (geschaetzt) | ~27 000 | < 20 000 (-25 %) |
| Pass/Fail (Aufgabe geloest) | Pass | Pass |

POC gewinnt, wenn **mindestens drei der vier Metriken** den Schwellenwert erreichen UND Pass bleibt. POC verliert, wenn Pass nicht gehalten wird oder weniger als drei Metriken greifen.

---

## 4. Detailed Change Proposals

### Aenderung 1: Neues Epic 10 — Vision-Hybrid POC

**Datei:** `_bmad-output/planning-artifacts/epics.md`

**Einzufuegen** nach Epic 9 (Zeile ca. 317 bzw. Ende der Epic-Liste):

```markdown
## Epic 10: Vision-Hybrid POC (Gate vor Kategorie-A-Fixes)

Zeitgeboxtes Spike-Epic mit genau einer Story. Pruefen, ob ein Hybrid-Vision-Ansatz (Screenshot + DOM-Refs analog SoM) die Kategorie-A-Frictions strukturell loest. Ergebnis entscheidet, ob Kategorie-A-Friction-Fixes weiter einzeln nachgejagt werden oder ob ein Hybrid-Layer ins Produkt kommt.
**FRs covered:** Keine neuen FRs in diesem Epic — der POC nutzt bestehende Tools. Neue FRs (z.B. FR40 capture_som) folgen erst bei Erfolg in einem Folge-Epic via bmad-create-epics-and-stories.
```

### Aenderung 2: Neue Story 10.1 — Vision-Hybrid POC auf Amazon-Szenario

**Datei:** `_bmad-output/planning-artifacts/epics.md` (nach neuer Epic-10-Ueberschrift)

```markdown
### Story 10.1: Vision-Hybrid POC auf Amazon-Szenario

As a Friction-Owner,
I want den Amazon-Steuer-Workflow aus Session ef027252 mit einem Hybrid-Vision-Ansatz (Screenshot + DOM-Refs) reproduzieren und messen,
So that wir datengestuetzt entscheiden koennen, ob Kategorie-A-Frictions einzeln gefixt oder strukturell durch einen Vision-Layer geloest werden sollen.

**Acceptance Criteria:**

**Given** die Amazon-Zahlungsseite (`https://www.amazon.de/cpe/yourpayments/transactions`) im aktuellen Chrome-Tab
**When** ein Test-Agent (Claude Opus oder vergleichbar) die Aufgabe "finde Prime-Video-Transaktion mit 6,99 € im Juli 2025 oder bestaetige dass keine existiert" mit erweitertem Tool-Satz loest
**Then** wird der Verlauf als JSON protokolliert (alle Tool-Calls, Parameter, Responses, Wall-Clock-Zeit)

**Given** der erweiterte Tool-Satz
**When** die Tools registriert werden
**Then** enthaelt er: alle bestehenden MCP-Tools + `capture_image` mit geoeffneter Description (keine "ONLY"-Beschraenkung) + optional Prototyp `capture_som` (Screenshot mit DOM-Ref-Overlay via DOMSnapshot-Bounds)

**Given** die Ergebnis-Metriken
**When** sie gegen Session ef027252 verglichen werden
**Then** wird ein Bericht `docs/research/vision-poc-2026-04-18.md` erzeugt mit: MCP-Calls, evaluate-Anteil, geschaetzte Tokens, Pass/Fail, Qualitative Beobachtungen

**Given** die Gewinn-Schwelle (mindestens 3 von 4 Metriken treffen, Pass gehalten)
**When** die Auswertung abgeschlossen ist
**Then** wird eine explizite Empfehlung formuliert: "POC gewinnt → Folge-Epic planen" oder "POC verliert → Kategorie-A-Pause aufheben"

**Given** der POC-Aufwand-Guard
**When** der Spike laeuft
**Then** ist die Time-Box max. 1 Arbeitstag. Bei Ueberschreitung wird abgebrochen und als "POC abgebrochen wegen Aufwand" dokumentiert (zaehlt als verloren).

**Nicht-Ziele dieser Story:**
- Kein Production-Code. Der `capture_som`-Prototyp ist ein Evaluations-Skript, nicht Teil des MCP-Servers.
- Keine Benchmark-Testseite. Die Amazon-Zahlungsseite ist der Prueftseite-Ersatz, weil die heutige Friction dort auftrat.
- Keine Aenderung an bestehenden Tools. `capture_image` wird temporaer per Test-Override mit gelockerter Description genutzt.

**Source Hints:**
- Session-Evidenz: `_bmad-output/planning-artifacts/handover-2026-04-18-vision-poc-correct-course.md`
- Research: `reference_browser-automation-techniques` (Memory), `docs/research/llm-tool-steering.md`
- Friction-Evidenz: `docs/friction-fixes.md` (Kategorien A/B/C aus Handover)

Status: backlog
```

### Aenderung 3: Header-Hinweis in Friction-Liste

**Datei:** `docs/friction-fixes.md` (nach Zeile 14, vor dem ersten `## FR-002`)

```markdown
---

> **Hinweis (2026-04-18):** Kategorie-A-Frictions (LLM-Sichtbarkeits-Probleme:
> FR-001, FR-003, FR-006, FR-008, FR-009, FR-021, FR-023, FR-036, FR-039 plus
> heutige neue Frictions A/B/D/E/H aus Session ef027252) sind bis zur
> Entscheidung ueber Story 10.1 (Vision-Hybrid POC) **pausiert**. Kategorien B
> (Verhalten) und C (Infrastruktur) werden weiter bearbeitet. Siehe
> `_bmad-output/planning-artifacts/sprint-change-proposal-2026-04-18-vision-poc.md`.

---
```

### Aenderung 4: sprint-status.yaml

**Datei:** `_bmad-output/implementation-artifacts/sprint-status.yaml`

Eintrag hinzufuegen am Ende der `development_status`-Section:

```yaml
  # Epic 10: Vision-Hybrid POC — Gate vor Kategorie-A-Friction-Fixes
  epic-10: backlog
  10-1-vision-hybrid-poc-amazon-szenario: backlog
  epic-10-retrospective: optional
```

`last_updated` auf `2026-04-18` setzen.

### Aenderung 5: Keine Aenderung an PRD und Architecture

PRD und Architecture bleiben **unberuehrt**. Das ist Absicht — der POC nutzt bestehende FRs/Tools und beruehrt keine Architektur-Entscheidung. Neue FRs und Architektur-Ergaenzungen folgen erst bei POC-Gewinn in einem separaten CC-Lauf.

---

## 5. Implementation Handoff

### Scope-Klassifikation

**Moderate** — Backlog-Reorganisation (neues Epic 10, neue Story 10.1), aber keine Architektur-Aenderung, kein FR-Umbau, kein Rollback. PO/SM-Koordination reicht.

### Handoff-Empfaenger

1. **Scrum Master / Story-Ersteller** (via `bmad-create-story`): erstellt die Story-Datei `10-1-vision-hybrid-poc-amazon-szenario.md` basierend auf Aenderung 2 dieses Proposals.
2. **Dev-Agent** (via `bmad-dev-story`): fuehrt die POC-Story aus. Im Gegensatz zu normalen Stories ist hier der "Dev" kein Feature-Implementierer, sondern ein Evaluator — der Code ist ein Messinstrument, kein Produkt-Artefakt.
3. **Julian** (PM/Entscheider): liest den POC-Bericht `docs/research/vision-poc-2026-04-18.md` und entscheidet auf Basis der Metriken:
   - POC gewinnt → separater CC-Lauf "Vision-Layer Integration" mit `bmad-create-epics-and-stories`
   - POC verliert → Header-Hinweis in `friction-fixes.md` wird entfernt, Kategorie-A-Pause aufgehoben

### Erfolgskriterien

**Fuer den CC (diesen Proposal):**
- Epic 10 und Story 10.1 im epics.md vorhanden
- sprint-status.yaml enthaelt Epic 10
- friction-fixes.md hat Pause-Hinweis
- Story 10.1 hat Status `backlog` und eine klare Time-Box

**Fuer die Story 10.1:**
- POC innerhalb von max. 1 Arbeitstag abgeschlossen
- Bericht erzeugt mit allen vier Metriken gegen Original-Session
- Explizite Gewinn/Verlust-Einordnung
- Julian hat entschieden (Folge-CC oder Pause-Aufhebung)

### Naechste Schritte

1. **Jetzt:** Julian approved diesen Sprint Change Proposal (Abschnitt 7).
2. **Bei Approval:** Aenderungen 1–4 werden in die jeweiligen Dateien geschrieben.
3. **Danach:** neue Session mit `/bmad-create-story 10-1-vision-hybrid-poc-amazon-szenario` fuer die Story-Datei.
4. **Danach:** `/bmad-dev-story` (oder manuelle Session) fuer den POC.
5. **Nach POC:** Julian entscheidet. Entweder Folge-CC oder `friction-fixes.md`-Header entfernen.

---

## 6. Anhang — Friction-Kategorisierungs-Tabelle (fuer Referenz)

### Kategorie A — Sichtbarkeit (pausiert bis POC-Entscheidung)

| FR-ID | Beschreibung | Status vor CC |
|-------|--------------|---------------|
| FR-001 | Scroll-Container nicht erkennbar | gefixt (unvollstaendig fuer React-Native-Web) |
| FR-003 | srcdoc-iframes unsichtbar | gefixt (annotation) |
| FR-006 | contenteditable als "generic" | gefixt |
| FR-008 | Canvas opak | wontfix P3 |
| FR-009 | kein observe-Tool | wontfix P3 |
| FR-021 | observe click_first/then_click keine Refs | gefixt |
| FR-023 | run_plan kann iFrame-Inhalt nicht lesen | gefixt |
| FR-036 | Geister-Refs hinter Modal-Overlays | gefixt |
| FR-039 | Click-Diff priorisiert StaticText | wontfix P3 |
| A (neu) | virtualisierter Scroll-Container | offen — **pausiert** |
| B (neu) | scrollbare Container nicht in view_page markiert | offen — **pausiert** |
| D (neu) | filter:"all" Token-Falle | offen — **pausiert** |
| E (neu) | click(text) Ambiguation | offen — **pausiert** |
| H (neu) | Content-Pattern-Suche fehlt | offen — **pausiert** |

### Kategorie B — Verhalten (laeuft weiter)

| FR-ID | Beschreibung | Status |
|-------|--------------|--------|
| FR-020 | LLM Defensive Fallback Spiral | gefixt (3-schichtig, Spirale heute dennoch 4x) |
| C (neu) | navigate → evaluate trotz Hint (Duplicate FR-042) | offen |
| G (neu) | FR-020 Threshold-Tuning | offen |

### Kategorie C — Infrastruktur (laeuft weiter)

~29 Eintraege (FR-002, FR-004, FR-005, FR-007, FR-018, FR-019, FR-022, FR-025, FR-026, FR-027, FR-028, FR-029, FR-030 bis FR-044). Keine pausieren. Siehe Handover-Datei Abschnitt 3 fuer Vollstaendigkeit.

---

## 7. Approval-Frage

**Julian, approvest du diesen Sprint Change Proposal?**

Konkret bedeutet Approval:
- Epic 10 und Story 10.1 werden in `epics.md` geschrieben
- `sprint-status.yaml` wird um Epic 10 ergaenzt
- `docs/friction-fixes.md` bekommt den Pause-Hinweis am Dateianfang
- Kategorie-A-Friction-Fixes werden bis zur POC-Entscheidung pausiert (ca. 1-2 Werktage)
- Kategorie B und C laufen weiter

Antworte mit **yes** (approved, Aenderungen werden geschrieben), **no** (abgelehnt, alles bleibt wie es ist) oder **revise: <Begruendung>** (Proposal wird angepasst).
