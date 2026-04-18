# Handover fuer bmad-correct-course — Vision-POC als Friction-Gate

**Datum:** 2026-04-18
**Zweck:** Kontextuebergabe fuer `bmad-correct-course` in frischer Session.
**Scope-Klassifikation (Vorschlag):** MEDIUM — Process Pivot mit Gate, kein Architektur-Umbau.
**Ausloeser:** Frictioneer-Session ef027252 (heute), Amazon-Steuer-Workflow, 51 MCP-Calls davon 31 evaluate (61%).

---

## 1. Warum jetzt ein Correct Course

Ich bin Frictioneer-Skill beauftragt gewesen, die Session ef027252 auf Frictions zu scannen und gegen die 44-Eintraege-Friction-Liste abzugleichen. Waehrend der Analyse ist eine strategische Frage aufgekommen, die groesser ist als der Friction-Loop selbst:

> **Verzetteln wir uns? Koennte ein grosser Teil der Kategorie-A-Frictions (LLM sieht die Seite nicht) mit einem visuellen Ansatz grundlegend geloest werden statt einzeln?**

Der Nutzer hat diese Frage bewusst gestellt und explizit eine unvoreingenommene Evaluation angefordert — nicht Verteidigung des Status quo.

---

## 2. Kern-Evidenz aus Session ef027252

### Was passiert ist

Ziel war das Debugging von `amazon-download.py` — ein Skript das zu einem Bankumsatz (Umsatz 2698, Prime Video 6,99€, 9. Juli 2025) den Amazon-Beleg finden soll. Das Skript nutzte veraltete CSS-Klassen (`.apx-transactions-line-item-component-container`). Amazon hat die Transaktionsseite auf **React-Native-Web** umgestellt — CSS-Klassen wie `css-g5y9jx r-150rngu`, DOM nur noch durch CDP-Tricks zugaenglich, Content in einem **virtualisierten internen Scroll-Container** (`scrollHeight: 17456px`, `clientHeight: 718px`).

### MCP-Nutzung (Rohdaten)

- 51 MCP-Calls, 108.706 Chars MCP-Output
- **31 evaluate-Calls (61%)**
- 4 evaluate-Spiralen erkannt (Muster aus `friction-scan.py`): 3x, 5x, 3x, 5x
- 12x navigate ohne view_page — LLM navigierte blind
- 3x navigate auf dieselbe URL als Reload-Ersatz (FR-044 existiert bereits)
- click(text: "07. April 2026") klickte falsche Bestellung (Ambiguation-Gap)
- run_plan mit 3x scroll 5000px → alle Scrolls liefen auf position 1471/1470px (Viewport-Ende), der virtualisierte Container wurde nie getroffen

### Live-Verifikation (selbst durchgespielt mit MCP heute, Tab 2 / Amazon-Zahlungsseite)

- `view_page(filter: "interactive")` zeigt alle 38 Transaktionen e700 bis e737 als saubere Refs (Datum, Haendler, Karte, Bestellnummer, Betrag, Status). **Die Daten sind da.** Das LLM hat in der Session `filter: "all", max_tokens: 3000` gewaehlt — dadurch auf Header downsampled, Transaktionen weg.
- `scroll(container_selector: "div.css-g5y9jx.r-150rngu.r-eqz5dr.r-16y2uox", direction: "down", amount: 3000)` funktioniert sofort: position 16738/16770, content loaded 32px. **Das Tool kann es.** Das LLM wusste nur nicht, wie man den Container ohne evaluate findet.

### Was das bedeutet

Das LLM hat sich durchgekaempft und den Fix geliefert (Skript erweitert, Live-Test bestanden). Aber der Weg dorthin war ineffizient — und die Ursache ist nicht ein einzelner Tool-Bug, sondern dass das LLM fuer jede nicht-Standard-UI erneut per DOM-Introspektion erraten muss, was visuell eigentlich offensichtlich ist.

---

## 3. Friction-Liste nach Ursache kategorisiert

Alle 44 Eintraege aus `docs/friction-fixes.md` plus die heutigen 8 neuen Frictions (A bis I) wurden nach Ursache gruppiert:

### Kategorie A — "Das LLM sieht die Seite nicht" (~12 Eintraege)

FR-001 Scroll-Container, FR-003 srcdoc-iframes, FR-006 contenteditable, FR-008 Canvas opak, FR-009 observe-Tool fehlt, FR-021 MutationObserver, FR-023 iFrame-Inhalt, FR-036 Geister-Refs hinter Modal-Overlays, FR-039 StaticText-Prioritaet, plus heute neu: A (virtualisierter Scroll), B (scrollbare Container nicht markiert), D (filter:"all" Token-Falle), E (click text-Ambiguation), H (Content-Pattern-Suche).

Kernmuster: Etwas das visuell trivial waere (Scrollbalken, Modal, Cursor-Form, gerenderter Text, positionale Disambiguation) wird ueber DOM-Introspektion rekonstruiert, mit hohem evaluate-Anteil und bruechigen Edge-Cases.

### Kategorie B — "LLM-Verhalten / Anti-Patterns" (3 Eintraege)

FR-020 evaluate-Spirale (bereits 3-schichtig gefixt mit Tool-Descriptions + Error-Hints + Runtime-Streak-Detector, Spirale heute trotzdem 4x ausgeloest), neue C (navigate → evaluate trotz "Next: call view_page"-Hint, Duplicate FR-042), neue G (FR-020 Threshold-Tuning).

Kernmuster: Panik-Fallback nach Fehler, modellebenen-nah, durch Tool-Design nur begrenzt steuerbar.

### Kategorie C — "Infrastruktur / Toolchain" (~29 Eintraege)

FR-002 target=_blank, FR-004 type verbose, FR-005 evaluate if/else, FR-007 Stale-Ref Recovery, FR-018 Cross-Session Ref-Kollision, FR-019 Stale Refs switch_tab, FR-022 run_plan press_key, FR-025 navigator.webdriver, FR-026 T4.7 Token-Budget, FR-027 scroll IntersectionObserver, FR-028 Drag&Drop, FR-029 Ambient Context AJAX-Race, FR-030 Benchmark /tmp-Session, FR-031 Binaries, FR-032 Memory, FR-033 Ambient Context in run_plan, FR-034 Step-Response-Aggregation, FR-035 Tool-Definition-Overhead, FR-037 LLM-Denkzeit-Luecke, FR-038 Tool-Rename, FR-040 Pro-Hook DOM-Diff, FR-041 CDP Session stirbt, FR-042 navigate-Response, FR-043 capture_image Description, FR-044 reload-Action.

Kernmuster: Protokoll, Cache, Timing, Build, Response-Design. Von Vision unabhaengig. Bleibt.

### Zahlen

| Kategorie | Anzahl | Von Vision-Ansatz entschaerft? |
|-----------|--------|--------------------------------|
| A — Sichtbarkeit | ~12 | Ja, strukturell. SoM loest Gros davon. |
| B — Verhalten | 3 | Nur teilweise. Panik bleibt modellnah. |
| C — Infrastruktur | ~29 | Nein. Vollstaendig unabhaengig. |

---

## 4. Research-Rueckendeckung

Aus `reference_browser-automation-techniques` (Memory) und `docs/research/llm-tool-steering.md`:

- **Pure Vision (nur Screenshots)** auf WebVoyager: **30,8%** — schlechter als DOM.
- **Set-of-Mark (SoM: Screenshot + DOM-Ref-Overlay)**: **59,1%** — fast 2x besser als Pure Vision.
- **Hybrid Vision+DOM (Surfer-H)**: **92,2%** — der dokumentierte State of the Art.
- Zitat: "Pure Vision oder Pure DOM verlieren beide."

Unser aktuelles Produkt ist konsequent Pure DOM mit `capture_image` als bewusst unterbewertetem Side-Tool. Die Tool-Description sagt woertlich: "capture_image is ONLY for CSS layout checks, canvas content, or when the user explicitly asks for a screenshot." Das ist eine selbst gebaute Barriere gegen die Hybrid-Strategie.

---

## 5. Strategisches Vorgehen — Vorschlag fuer den CC-Skill

Die Empfehlung ist **kein Architektur-Umbau**, sondern ein **Gate vor weiteren Kategorie-A-Fixes**:

1. **Vision-POC als zeitgeboxter Spike** (halber bis ganzer Tag). Die Amazon-Session von heute reproduziert mit einem erweiterten Tool-Satz: `capture_image` frei nutzbar plus optional ein `capture_som`-Prototyp (Screenshot mit nummeriertem DOM-Overlay analog WebVoyager/SoM). Metriken: Calls, Tokens, Zeit, Pass/Fail.
2. **Friction-Kategorie A eingefroren** bis POC entschieden hat. Keine neuen FR-045+ in Kategorie A.
3. **Kategorie B und C laufen weiter**, weil sie auch bei Vision-Ergebnis relevant bleiben. Heutige Kleinst-Fixes mit eindeutiger Wirkung (neue C navigate→evaluate, neue F reload-Discovery) bleiben Kandidaten.
4. **Entscheidungslogik nach POC:**
   - POC verliert (weniger effizient oder unzuverlaessig) → Kategorie-A-Frictions wieder aufnehmen, POC archivieren als evaluiert-wontfix.
   - POC gewinnt (weniger Calls/Tokens bei gleicher oder besserer Pass-Rate) → neues Epic 22 SoM-Integration via `bmad-create-epics-and-stories`, Epic 20/21 neu einordnen.

---

## 6. Was der CC-Skill erzeugen soll

Einen Sprint Change Proposal nach dem Vorbild `sprint-change-proposal-2026-04-11-operator.md` unter `_bmad-output/planning-artifacts/sprint-change-proposal-2026-04-18-vision-poc.md` mit:

- **Issue Summary** (Paragraphen 1-5 dieses Handovers)
- **Impact Analysis** auf aktive Epics (Epic 20/21 parked, Friction-Pipeline pausiert fuer Kategorie A, Epic 22 vorbereitend skizziert)
- **Path Forward Options**: (A) POC bauen und messen — empfohlen; (B) Status quo — Kategorie A weiter fixen; (C) direkter Vision-Pivot ohne POC — zu aggressiv
- **Recommendation und Approval-Frage** an den Nutzer
- **Anhang:** Friction-Kategorisierungs-Tabelle (Kategorie A/B/C mit FR-IDs)

---

## 7. Kontext-Verweise

- **Diese Session (Frictioneer):** `ef027252-94d7-4e40-9a78-a2f19d8b1524` — JSONL unter `/Users/silbercue/.claude/projects/-Users-silbercue-Documents-Cursor-Steuer4/`
- **Friction-Liste:** `docs/friction-fixes.md` (1625 Zeilen, bis FR-044)
- **Existierende Sprint Change Proposals als Form-Vorlage:** `_bmad-output/planning-artifacts/sprint-change-proposal-2026-04-11-operator.md` (Operator-Pivot, MAJOR), `sprint-change-proposal-2026-04-16-script-api-v2.md` (aktuelle Version als Form-Referenz)
- **Vision-Dokument:** `docs/vision/operator.md`
- **Research-Korpus:** `docs/research/` (llm-tool-steering.md, browser-automation-techniques via Memory)
- **Memory-Pointers relevant:**
  - `project_operator-pivot-approved.md` — Epic 18-21 Kontext
  - `project_epic18-abschluss.md` — Epic 18 DONE, MQS 58.2
  - `project_epic19-abschluss.md` — Epic 19 DONE, 2-Tool-Interface operator+virtual_desk
  - `reference_browser-automation-techniques.md` — SoM, D2Snap, Hybrid-Strategie
  - `reference_llm-tool-steering.md` — 6 Steering-Patterns

---

## 8. Nicht-Ziele dieses CC

- Kein Ersatz der bestehenden DOM-Tools. Hybrid, nicht Switch.
- Keine Vorwegnahme der POC-Entscheidung. Der CC stellt das Gate, nicht das Ergebnis.
- Keine Umschrift der Friction-Liste. Kategorie A wird pausiert, nicht geloescht.
