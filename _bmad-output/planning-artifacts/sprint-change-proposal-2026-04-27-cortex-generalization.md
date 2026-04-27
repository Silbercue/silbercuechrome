# Sprint Change Proposal: Cortex Pattern Generalization

**Datum:** 2026-04-27
**Trigger:** Architektur-Analyse nach Epic 12 (Cortex Phase 1)
**Scope:** Major — Fundamentale Aenderung am Cortex-Datenmodell VOR Epic 13
**Autor:** Julian (via BMAD Correct Course)

---

## 1. Issue Summary

### Problem

Cortex-Patterns (Epic 12) nutzen `domain + pathPattern` als Schluessel. Ein Pattern fuer `github.com/login` hilft auf `gitlab.com/login` nicht — obwohl die Tool-Sequenz identisch ist (navigate → view_page → fill_form → click). Das macht Community-Sharing (Epic 13) strukturell unbrauchbar:

- **Riesige Bundles:** Alle Domains = Megabytes JSONL. NFR19 (max 2s Download) bricht bei Community-Groesse.
- **Irrelevante Bundles:** Nur Top-100-Domains = 99% der Nutzer profitieren nicht.
- **Kein Transfer-Learning:** Identische Interaktionsmuster auf verschiedenen Domains werden als voellig unterschiedliche Patterns behandelt.

### Kern-Einsicht

Der Aktionsraum ist begrenzt (~15-20 MCP-Tools), der Problemraum semi-begrenzt (Webseiten haben wiederkehrende Interaktionsmuster). Ein Login ist ein Login — unabhaengig von der Domain. Die richtige Abstraktion ist der **Seitentyp**, nicht die Domain.

### Evidenz

- Vollstaendige Recherche: `docs/research/cortex-cross-domain-generalization.md`
- 7 akademische Papers bestaetigen den Ansatz (PolySkill, WebXSkill, SkillX, SAGE)
- Mathematische Analyse: 20 Seitentypen x 15 Tools x 15 Tools = 4.500 Eintraege ≈ wenige KB statt Megabytes
- A11y-Tree-basierte Klassifikation mit >90% Precision auf bekannten Seitentypen (Login, Search, Data-Table)
- Kein Konkurrent nutzt A11y-Tree fuer Seitentyp-Klassifikation — Differenzierungspotential

### Entdeckungszeitpunkt

Nach Abschluss von Epic 12 (5 Stories, alle committed), bei der Architektur-Planung fuer Epic 13. Kein Code-Fehler — die Infrastruktur (Merkle Log, Hooks, Telemetrie, Hint-Delivery) funktioniert. Nur der Pattern-Schluessel skaliert nicht.

---

## 2. Impact Analysis

### Epic Impact

| Epic | Status | Impact | Details |
|------|--------|--------|---------|
| Epic 12 | DONE | Retrofit noetig | 3 Dateien aendern (pattern-recorder, hint-matcher, cortex-types), 2 neue Dateien (page-classifier, markov-table). Merkle Log + Hooks + Telemetrie bleiben. |
| Epic 13 | Backlog | Vereinfacht | Kleinere Bundles (~10KB statt MB), NFR19 trivial erfuellt, WASM-Validator einfacher (Markov-Tabelle statt tausende Einzel-Patterns). Stories 13.1-13.6 muessen aktualisiert werden. |
| Epic 11 | DONE | Kein Impact | Migration + Rename abgeschlossen, unberuehrt. |
| Epics 1-10 | DONE | Kein Impact | Core-Funktionalitaet unberuehrt. |

### Story Impact — Betroffene Dateien (Epic 12 Retrofit)

| Datei | Aenderungstyp | Scope |
|-------|--------------|-------|
| `src/cortex/cortex-types.ts` | Modify | `CortexPattern.domain/pathPattern` → `pageType`, neues `PageType` Enum, `MarkovEntry` Type |
| `src/cortex/pattern-recorder.ts` | Modify | URL-Extraktion → A11y-Tree-Klassifikation, neuer Import von page-classifier |
| `src/cortex/hint-matcher.ts` | Modify | Domain-Index → PageType-Index, Markov-Vorhersage statt Pattern-Matching |
| `src/cortex/telemetry-upload.ts` | Modify | Payload-Felder, Rate-Limit-Key, Sanitize-Methode |
| `src/cortex/local-store.ts` | Minor Modify | CortexPattern-Shape aendert sich, JSONL-Eintraege erhalten neues Format. Existierende Logs werden beim naechsten Schreiben migriert (oder sauberer Neustart). |
| `src/cortex/page-classifier.ts` | **Neu** | A11y-Tree → Seitentyp (regelbasiert, deterministisch) |
| `src/cortex/markov-table.ts` | **Neu** | Uebergangstabelle: P(naechstes_tool \| letztes_tool, seiten_typ) |

### Story Impact — Epic 13 (Aktualisierungen)

| Story | Aenderung |
|-------|-----------|
| 13.1 WASM-Validator | Validiert Markov-Tabelle statt Domain-Pattern-Liste. Einfachere Logik. |
| 13.3 OCI Distribution | Bundle ist ~10KB JSON (Markov-Tabelle) statt MB JSONL. NFR19 trivial. |
| 13.4 Canary-Deployment | Mechanismus gleich, aber Payload kleiner. |
| 13.6 Client-Verifikation | Verifiziert Markov-Tabelle. Gleiche Sigstore/Merkle-Logik. |

### Artifact Conflicts

**PRD:**
- FR40, FR42, FR44, NFR21: Referenzen auf "Domain, Pfad-Pattern" muessen auf "Seitentyp" aktualisiert werden
- Privacy-Verbesserung: Seitentyp ist WENIGER identifizierend als Domain (NFR21 wird staerker erfuellt)

**Architecture:**
- Cortex-Abschnitt: Pattern-Key-Beschreibung, Modul-Liste, Data-Flow-Diagramm
- Neue Module in Directory-Tree: page-classifier.ts, markov-table.ts
- Boundary 4 (Cortex ↔ Tools): Integration-Point bleibt gleich (hooks + navigate/read-page)

**Sprint-Status:**
- Neues Epic 12a einfuegen zwischen Epic 12 (done) und Epic 13 (backlog)

---

## 3. Recommended Approach

### Gewaehlter Pfad: Direct Adjustment (Option 1)

Neues Epic 12a ("Cortex Pattern Generalization") zwischen Epic 12 und Epic 13 einfuegen. 5 Stories, alle in `src/cortex/`. Epic 12 Infrastruktur bleibt vollstaendig erhalten.

### Rationale

- **Kein Rollback noetig:** Merkle Log, Hooks, Telemetrie-Upload und Hint-Delivery sind korrekt implementiert und bleiben unberuehrt. Nur der Pattern-Schluessel und das Matching aendern sich.
- **Begrenzter Blast-Radius:** Aenderungen sind auf `src/cortex/` begrenzt. Kein Tool, kein CDP-Code, kein Hook-Mechanismus muss angefasst werden.
- **Vereinfacht Epic 13:** Kleinere Bundles, einfachere Validierung, NFR19 trivial — Epic 13 wird LEICHTER, nicht schwerer.
- **Privacy-Gewinn:** Seitentyp statt Domain ist datenschutzrechtlich besser (NFR21).
- **A11y-Tree ist kostenlos:** view_page baut den A11y-Tree bereits — der Klassifikator nutzt vorhandene Daten, keine neuen CDP-Calls.

### Aufwand und Risiko

- **Effort:** Medium (3-5 Arbeitstage, 5 Stories)
- **Risk:** Low — regelbasierter Klassifikator ohne ML, A11y-Tree-Daten vorhanden, lokale Aenderungen
- **Timeline-Impact:** +1 Sprint vor Epic 13. Wird durch Vereinfachung von Epic 13 teilweise kompensiert.

### Verworfene Alternativen

- **Option 2 (Rollback):** Nicht sinnvoll — wuerde funktionierende Infrastruktur loeschen.
- **Option 3 (MVP Review):** Nicht noetig — Aenderung HILFT dem MVP.
- **SimHash sofort:** Schicht 3 (SimHash-Fallback) wird auf Phase 2 verschoben. Markov-Tabelle + Klassifikator decken 90%+ ab.

---

## 4. Detailed Change Proposals

### 4.1 Neues Epic 12a: Cortex Pattern Generalization

**Goal:** Cortex-Patterns von domain-basierten auf seitentyp-basierte Schluessel umstellen. Drei-Schichten-Erkennung: regelbasierter Klassifikator (Schicht 1), Markov-Uebergangstabelle (Schicht 2), SimHash-Fallback (Schicht 3, deferred).

**FRs:** FR40 (aktualisiert), FR42 (aktualisiert)
**NFRs:** NFR19 (Bundle-Groesse drastisch reduziert), NFR21 (Privacy verbessert)

#### Story 12a.1: Seitentyp-Taxonomie + A11y-Tree-Klassifikator

As a Developer,
I want einen regelbasierten Klassifikator der aus dem A11y-Tree den Seitentyp bestimmt,
So that Cortex-Patterns domainunabhaengig zugeordnet werden koennen.

**Acceptance Criteria:**

**Given** ein A11y-Tree einer Login-Seite (form + textbox[type=password] + button)
**When** der Klassifikator aufgerufen wird
**Then** gibt er den Seitentyp `login` zurueck

**Given** ein A11y-Tree einer Suchergebnis-Seite (search-Landmark oder prominentes textbox + Submit)
**When** der Klassifikator aufgerufen wird
**Then** gibt er den Seitentyp `search_results` zurueck

**Given** ein A11y-Tree einer unbekannten Seite die keinem Typ zugeordnet werden kann
**When** der Klassifikator aufgerufen wird
**Then** gibt er den Seitentyp `unknown` zurueck (graceful degradation)

**Given** src/cortex/page-classifier.ts existiert
**Then** enthaelt es eine Seitentyp-Taxonomie mit mindestens 15 Typen
**And** ein Feature-Vektor-Extraktor der ARIA-Rollen, Marker und Label-Keywords zaehlt
**And** eine regelbasierte Zuordnungsfunktion (kein ML, kein Training, deterministisch)

**Given** die 35 Benchmark-Testseiten
**When** der Klassifikator auf jede angewendet wird
**Then** klassifiziert er mindestens 80% korrekt (PoC-Validierung)

**Technische Details:**
- Neues File: `src/cortex/page-classifier.ts`
- Input: A11y-Tree-Daten (bereits verfuegbar via view_page)
- Output: `PageType` (string enum)
- Kein neuer CDP-Call noetig — nutzt vorhandene A11y-Tree-Daten
- Feature-Vektor: Anzahl pro ARIA-Rolle, spezifische Marker (password, search-Landmark, grid/table), Label-Keywords

#### Story 12a.2: CortexPattern Retrofit auf PageType

As a Developer,
I want das CortexPattern-Datenmodell von domain-basiert auf seitentyp-basiert umstellen,
So that Patterns domainuebergreifend gemacht werden koennen.

**Acceptance Criteria:**

**Given** cortex-types.ts definiert CortexPattern
**When** das Interface aktualisiert wird
**Then** enthaelt es `pageType: string` statt `domain: string` als primaeren Schluessel
**And** `domain` wird optional beibehalten als Metadatum (Debugging, nicht fuer Matching)
**And** `pathPattern` wird entfernt (der Seitentyp ersetzt die Pfad-basierte Zuordnung)

**Given** pattern-recorder.ts zeichnet Patterns auf
**When** ein erfolgreicher Tool-Call erfolgt
**Then** wird der Seitentyp via page-classifier.ts bestimmt (statt URL-Parsing)
**And** der Pattern-Eintrag nutzt `pageType` als Schluessel

**Given** local-store.ts speichert CortexPatterns
**When** das neue Format geschrieben wird
**Then** werden neue Eintraege im neuen Format gespeichert
**And** alte JSONL-Eintraege (mit domain/pathPattern) werden beim Lesen toleriert aber ignoriert (sauberer Uebergang statt Migration)

**Given** alle Aenderungen durchgefuehrt sind
**Then** npm test laeuft ohne Regression

**Technische Details:**
- cortex-types.ts: CortexPattern.domain → optional, CortexPattern.pathPattern → entfernt, CortexPattern.pageType → neu (required)
- pattern-recorder.ts: _maybeEmitPattern() nutzt Klassifikator statt URL-Extraktion
- local-store.ts: _readPatternsRaw() filtert alte Eintraege ohne pageType (kein Migrationscode)
- Dedup-Schluessel in local-store.ts: `pageType` statt `domain||pathPattern`

#### Story 12a.3: Markov-Uebergangstabelle

As a Developer,
I want eine gewichtete Markov-Uebergangstabelle die Tool-Wahrscheinlichkeiten pro Seitentyp speichert,
So that der Cortex vorhersagen kann welches Tool als naechstes am wahrscheinlichsten erfolgreich ist.

**Acceptance Criteria:**

**Given** src/cortex/markov-table.ts existiert
**When** lokale Patterns aggregiert werden
**Then** wird eine Tabelle gebaut: `P(naechstes_tool | letztes_tool, seiten_typ)`

**Given** 10 erfolgreiche Patterns auf login-Seiten mit Sequenz navigate → fill_form → click
**When** die Tabelle abgefragt wird fuer `(navigate, login)`
**Then** gibt sie `fill_form` mit hoher Wahrscheinlichkeit zurueck

**Given** die Tabelle als JSON exportiert wird
**Then** ist sie unter 50KB (Ziel: ~10KB fuer Community-Format)

**Given** die Tabelle einen Decay-Mechanismus hat
**When** ein Eintrag aelter als 30 Tage ist
**Then** wird sein Gewicht reduziert (ACO-Verdampfung)

**Technische Details:**
- Neues File: `src/cortex/markov-table.ts`
- State-Definition: `(letztes_tool, seiten_typ)` → Map von `naechstes_tool` → Gewicht
- Wird aus lokalen Patterns gebaut (Aggregation von pattern-recorder Eintraegen)
- Export als JSON fuer Community-Sharing (Epic 13)
- ACO-Decay: Gewichte * 0.95 pro Woche (konfigurierbar)
- Order 1 (letztes Tool) als Default, Order 2 als spaetere Erweiterung

#### Story 12a.4: Hint-Matcher Retrofit

As a Developer,
I want den Hint-Matcher von Domain-Lookup auf PageType-Lookup + Markov-Vorhersage umstellen,
So that Cortex-Hints domainunabhaengig funktionieren.

**Acceptance Criteria:**

**Given** hint-matcher.ts nutzt aktuell einen Domain-Index (Map<domain, CompiledPattern[]>)
**When** auf PageType-Index umgestellt wird
**Then** nutzt es Map<pageType, MarkovEntry[]> statt Domain-Lookup

**Given** der LLM-Agent navigate("https://gitlab.com/login") aufruft
**When** der Klassifikator den Seitentyp `login` erkennt
**Then** liefert der Hint-Matcher Markov-basierte Empfehlungen (z.B. "fill_form mit P=0.85")
**And** der Hint kommt von Community-Daten ALLER Login-Seiten, nicht nur von gitlab.com

**Given** der Seitentyp `unknown` zurueckgegeben wird
**When** der Hint-Matcher abgefragt wird
**Then** wird kein Hint geliefert (graceful degradation, wie heute bei fehlendem Domain-Match)

**Given** die CortexHint-Struktur aktualisiert wird
**Then** enthaelt sie `pageType` statt `domain` und `pathPattern`
**And** die Integration in navigate.ts und read-page.ts (_meta.cortex) bleibt identisch

**Technische Details:**
- hint-matcher.ts: _index von Map<string, CompiledPattern[]> → Map<string, MarkovTransition[]>
- match(url) wird zu match(url, a11yTree?) — braucht A11y-Daten fuer Klassifikation
- Alternativ: match(pageType) wenn der Klassifikator vorher aufgerufen wird
- CortexHint: domain/pathPattern → pageType
- refreshAsync(): Laedt aus LocalStore + PatternRecorder, baut Markov-Tabelle

#### Story 12a.5: Telemetrie-Payload + Privacy-Update

As a Developer,
I want das Telemetrie-Payload auf das neue Seitentyp-Format aktualisieren,
So that Community-Daten im neuen Format gesammelt werden und NFR21 staerker erfuellt wird.

**Acceptance Criteria:**

**Given** telemetry-upload.ts sanitisiert CortexPattern-Eintraege
**When** _sanitize() aufgerufen wird
**Then** enthaelt das Payload `pageType` statt `domain` und `pathPattern`

**Given** das Rate-Limit nutzt aktuell `domain||pathPattern` als Key
**When** auf `pageType||toolSequenceHash` umgestellt wird
**Then** funktioniert das Rate-Limiting korrekt fuer das neue Format

**Given** ein Pattern-Eintrag mit Seitentyp `login` wird hochgeladen
**Then** enthaelt der Payload KEINE Domain-Information (Privacy-Verbesserung gegenueber vorher)

**Given** TelemetryPayload in cortex-types.ts aktualisiert wird
**Then** enthaelt es: pageType, toolSequence, successRate, contentHash, timestamp
**And** KEINE domain, KEINE pathPattern (NFR21 staerker erfuellt)

**Technische Details:**
- cortex-types.ts: TelemetryPayload.domain → entfernt, TelemetryPayload.pathPattern → entfernt, TelemetryPayload.pageType → neu
- telemetry-upload.ts: _sanitize() und Rate-Limit-Key aktualisieren
- Privacy-Gewinn: Seitentyp "login" verraet nicht WELCHE Seite besucht wurde

---

### 4.2 PRD-Aenderungen

#### FR40

**OLD:**
FR40: Der MCP zeichnet erfolgreiche Tool-Sequenzen automatisch als Pattern-Eintraege auf (Domain, Pfad-Pattern, Tool-Sequenz, Outcome, Content-Hash)

**NEW:**
FR40: Der MCP zeichnet erfolgreiche Tool-Sequenzen automatisch als Pattern-Eintraege auf (Seitentyp, Tool-Sequenz, Outcome, Content-Hash). Der Seitentyp wird regelbasiert aus dem A11y-Tree bestimmt (kein ML). Domain wird optional als Metadatum gespeichert, nicht als Schluessel verwendet.

**Rationale:** Domain-basierte Schluessel skalieren nicht fuer Community-Sharing. Seitentyp-basierte Schluessel generalisieren domainuebergreifend.

#### FR42

**OLD:**
FR42: Bei URL-Pattern-Match liefern navigate und view_page Cortex-Hints in der Tool-Response (_meta.cortex)

**NEW:**
FR42: Bei Seitentyp-Match liefern navigate und view_page Cortex-Hints in der Tool-Response (_meta.cortex). Der Seitentyp wird aus dem A11y-Tree der aktuellen Seite bestimmt. Hints enthalten Markov-basierte Tool-Vorhersagen (naechstes wahrscheinlichstes Tool).

**Rationale:** Seitentyp-Matching ermoeglicht Cross-Domain-Hints (Login-Hints gelten auf allen Login-Seiten).

#### FR44

**OLD:**
FR44: Pattern-Eintraege koennen opt-in an einen Collection-Endpoint gesendet werden (anonymisiert, Rate-Limited, kein PII)

**NEW:**
FR44: Pattern-Eintraege koennen opt-in an einen Collection-Endpoint gesendet werden (anonymisiert, Rate-Limited, kein PII). Payloads enthalten Seitentyp und Tool-Sequenz — keine Domain, keine URLs.

**Rationale:** Seitentyp ist weniger identifizierend als Domain — staerkere Privacy-Garantie.

#### NFR21

**OLD:**
NFR21: Cortex-Patterns enthalten ausschliesslich: Domain, Pfad-Pattern, Tool-Sequenz, Success-Rate, Installations-Count, Validator-Hash, Timestamp. Keine User-Daten, keine Credentials, keine Session-Tokens

**NEW:**
NFR21: Cortex-Patterns enthalten ausschliesslich: Seitentyp, Tool-Sequenz, Success-Rate, Installations-Count, Validator-Hash, Timestamp. Optional: Domain als Metadatum (nur lokal, wird nicht in Telemetrie-Uploads oder Community-Bundles uebertragen). Keine User-Daten, keine Credentials, keine Session-Tokens

**Rationale:** Seitentyp statt Domain reduziert PII-Risiko — "login" verraet nicht welche Seite besucht wurde.

---

### 4.3 Architecture-Aenderungen

#### Cortex Pattern-Key

**OLD:**
Pattern-Key: `domain + pathPattern`

**NEW:**
Pattern-Key: `pageType` (regelbasiert aus A11y-Tree bestimmt). Drei-Schichten-Erkennung:
1. Schicht 1: Regelbasierter A11y-Tree-Klassifikator → Seitentyp (~20 Typen)
2. Schicht 2: Gewichtete Markov-Uebergangstabelle → Tool-Vorhersage pro Seitentyp
3. Schicht 3: SimHash-Fallback → fuer unbekannte Seitentypen (deferred, Phase 2)

#### Cortex Module

**OLD (6 Dateien):**
- pattern-recorder.ts, local-store.ts, hint-matcher.ts, bundle-loader.ts, telemetry-upload.ts, cortex-types.ts

**NEW (8 Dateien):**
- pattern-recorder.ts (geaendert), local-store.ts (minor), hint-matcher.ts (geaendert), bundle-loader.ts (Epic 13), telemetry-upload.ts (geaendert), cortex-types.ts (geaendert)
- **page-classifier.ts** (neu) — A11y-Tree → Seitentyp
- **markov-table.ts** (neu) — Uebergangstabelle + Vorhersage
- structural-hash.ts (deferred Phase 2) — SimHash-Fallback

#### Community-Bundle-Format

**OLD:**
JSONL mit Einzelpatterns (domain + pathPattern + toolSequence pro Zeile)

**NEW:**
JSON Markov-Tabelle (~10KB): `{ pageType → { lastTool → { nextTool → weight } } }`

---

### 4.4 Epic 13 Story-Aktualisierungen

#### Story 13.1 WASM-Validator

**OLD:**
"Patterns akzeptiert die: N unabhaengige Bestaetigungen haben..."

**NEW:**
"Markov-Tabellen-Eintraege akzeptiert die: aus N unabhaengigen Installationen aggregiert sind, innerhalb eines Zeitfensters liegen, keinen Anomalie-Check ausloesen. Input-Format: Markov-Tabelle (JSON), nicht Einzel-Pattern-Liste."

#### Story 13.3 OCI Distribution

**OLD:**
"Bundle Content-Addressed (SHA-256) verfuegbar"

**NEW:**
"Bundle Content-Addressed (SHA-256) verfuegbar. Bundle ist eine Markov-Tabelle (~10KB JSON), nicht eine JSONL-Datei mit Einzelpatterns. NFR19 (max 2s Download) ist bei dieser Groesse trivial erfuellt."

---

## 5. Implementation Handoff

### Scope-Klassifikation: Major

Fundamentale Aenderung am Cortex-Datenmodell. Betrifft PRD, Architecture, Epics und bestehenden Code.

### Handoff-Plan

| Schritt | Rolle | Aktion |
|---------|-------|--------|
| 1 | Julian (Approval) | Sprint Change Proposal genehmigen |
| 2 | Architect (Winston) | Architecture-Dokument aktualisieren |
| 3 | PM (John) | PRD FR40/FR42/FR44/NFR21 aktualisieren |
| 4 | SM (Bob) | Sprint-Status aktualisieren, Epic 12a einfuegen |
| 5 | SM (Bob) | Epic 13 Stories aktualisieren |
| 6 | Dev (Amelia) | Stories 12a.1-12a.5 implementieren |

### Reihenfolge

1. **Dieses Proposal genehmigen** (jetzt)
2. **PRD aktualisieren** (FR40, FR42, FR44, NFR21)
3. **Architecture aktualisieren** (Cortex-Sektion, Module, Data Flow)
4. **Epics aktualisieren** (Epic 12a einfuegen, Epic 13 Stories anpassen)
5. **Sprint-Status aktualisieren** (Epic 12a mit 5 Stories)
6. **Implementierung starten** (Story 12a.1 zuerst — Klassifikator ist Voraussetzung)

### Erfolgskriterien

- [ ] A11y-Klassifikator erkennt mindestens 80% der 35 Benchmark-Seiten korrekt
- [ ] Markov-Tabelle unter 50KB (Ziel: ~10KB)
- [ ] Keine Regression in npm test (1500+ Tests)
- [ ] Hint-Matcher liefert Cross-Domain-Hints (gleiche Hints fuer github.com/login und gitlab.com/login)
- [ ] Telemetrie-Payload enthaelt keine Domain-Information mehr
- [ ] Epic 13 Stories referenzieren das neue Format

### Offene Fragen (aus Research)

1. **Seitentyp-Taxonomie:** Welche ~20 Typen decken 90%+ ab? → Story 12a.1 klaert das.
2. **Markov-Order:** Order 1 (letztes Tool) als Default. Order 2 als spaetere Erweiterung wenn noetig.
3. **Existierende Logs:** Alte JSONL-Eintraege werden toleriert aber ignoriert (kein Migrationscode). Sauberer Neustart der Lernphase.
4. **A11y-Tree Timing:** Klassifikator braucht A11y-Daten. Fuer navigate (wo der A11y-Tree erst nach der Navigation verfuegbar ist) wird der Klassifikator erst beim naechsten view_page ausgefuehrt. Pattern-Recording aendert sich dadurch nicht (es zeichnet ohnehin erst nach mehreren Tool-Calls auf).
