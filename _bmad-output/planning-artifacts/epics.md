---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/sprint-change-proposal-2026-04-26-public-browser.md
workflowType: 'epics-and-stories'
project_name: 'Public Browser (SilbercueChrome)'
user_name: 'Julian'
date: '2026-04-26'
---

# Public Browser - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Public Browser (formerly SilbercueChrome), decomposing the requirements from the PRD and Architecture into implementable stories. Focus liegt auf den drei neuen Epics (11-13) des Public Browser Pivot. Epics 1-10 sind DONE.

## Requirements Inventory

### Functional Requirements

**Page Reading & Navigation (DONE — Epic 1)**
FR1: Der LLM-Agent kann den Accessibility-Tree einer Seite lesen und erhaelt stabile Element-Referenzen (Refs) fuer jedes interaktive Element
FR2: Der LLM-Agent kann zu einer URL navigieren und erhaelt den Seitenstatus nach dem Laden
FR3: Der LLM-Agent kann einen komprimierten Screenshot der aktuellen Seite anfordern
FR4: Der LLM-Agent kann den Tab-Status (URL, Titel, Ladezustand) aus dem Cache abfragen ohne CDP-Roundtrip
FR5: Der LLM-Agent kann den Accessibility-Tree mit konfigurierbarem Token-Budget anfordern (progressive Tiefe)

**Element Interaction (DONE — Epic 2)**
FR6: Der LLM-Agent kann ein Element per Ref, CSS-Selector oder sichtbarem Text anklicken
FR7: Der LLM-Agent kann Text in ein Eingabefeld eingeben (per Ref oder Selector)
FR8: Der LLM-Agent kann mehrere Formularfelder in einem einzigen Tool-Call ausfuellen
FR9: Der LLM-Agent kann die Seite oder einen spezifischen Container scrollen
FR10: Der LLM-Agent kann Tastendruecke an ein Element senden
FR11: Der LLM-Agent kann Drag-and-Drop-Operationen ausfuehren

**Execution & Automation (DONE — Epic 3, GEAENDERT: run_plan jetzt unbegrenzt)**
FR12: Der LLM-Agent kann einen mehrstufigen Plan in einem einzigen Tool-Call ausfuehren (run_plan) mit unbegrenzter Anzahl an Steps
FR13: Der LLM-Agent kann beliebiges JavaScript im Browser-Kontext ausfuehren und das Ergebnis erhalten
FR14: Der LLM-Agent kann auf eine Bedingung warten (Element sichtbar, Network idle, JS-Expression true)
FR15: Der LLM-Agent kann DOM-Aenderungen an einem Element beobachten und erhaelt alle Mutationen als Ergebnis
FR16: run_plan liefert bei Abbruch (Fehler in einem Step) ein Teilergebnis der bereits ausgefuehrten Steps zurueck

**Tab Management (DONE — Epic 4, GEAENDERT: kein Pro-Gate mehr)**
FR17: Der LLM-Agent kann neue Tabs oeffnen, zwischen Tabs wechseln und Tabs schliessen
FR18: Der LLM-Agent kann eine Uebersicht aller offenen Tabs mit URL und Titel in unter 500 Tokens abrufen

**Download Management (DONE — Epic 4)**
FR19: Der LLM-Agent kann den Status laufender und abgeschlossener Downloads abfragen
FR20: Der LLM-Agent kann die Download-Session-History einsehen

**Connection & Setup (DONE — Epic 5)**
FR21: Der Server kann Chrome automatisch starten und per CDP verbinden (Zero-Config)
FR22: Der Server kann sich per --attach an ein bereits laufendes Chrome anhaengen
FR23: Der Server verbindet sich nach CDP-Verbindungsverlust automatisch neu (Auto-Reconnect)
FR24: Element-Refs bleiben nach Auto-Reconnect stabil (Tab-IDs und Refs werden nicht invalidiert)

**Tool Steering & Error Recovery (DONE — Epic 6, Stories 6.1/6.2 DEFERRED)**
FR25: Der Server erkennt Anti-Patterns in der Tool-Nutzung (z.B. evaluate-Spiral) und gibt dem LLM korrigierende Hinweise
FR26: Der Server gibt bei Stale-Refs nach Navigation einen Recovery-Hinweis
FR27: Tool-Descriptions enthalten Negativ-Abgrenzung (wann NICHT verwenden, welches Tool stattdessen)
FR28: Der Server bietet konfigurierbare Tool-Profile an (Default 10 Tools, Full-Set via Env-Variable)
FR29: Der Server gibt bei click/type einen synchronen DOM-Diff zurueck (was hat sich geaendert)

**Distribution (GEAENDERT — Epic 11 Migration)**
FR30: Der Developer kann Public Browser via `npx public-browser@latest` ohne Installation starten
FR31: Alle Tools funktionieren vollstaendig und ohne kuenstliche Einschraenkungen

**Script API (v1 DONE — Epic 9, v2 Shared Core ausstehend)**
FR34: Der MCP-Server kann im --script Modus gestartet werden, der dem MCP-Server signalisiert externe CDP-Clients zu tolerieren und parallel zum MCP-Betrieb koexistieren zu lassen
FR35: Das --script Flag deaktiviert spezifische Guards die Script-API-Zugriff blockieren wuerden
FR36: Jedes Script arbeitet in einem eigenen Tab — MCP-Tabs werden nicht gestoert
FR37: Die Script API bietet die Methoden navigate, click, fill, type, wait_for, evaluate und download (Shared Core)
FR38: Die Script API nutzt ein Context-Manager-Pattern (with chrome.new_page())
FR39: Die Script API wird als Python-Package (pip install publicbrowser) distribuiert

**Cortex — Selbstlernendes Wissen (NEU — Epic 12 + 13)**
FR40: Der MCP zeichnet erfolgreiche Tool-Sequenzen automatisch als Pattern-Eintraege auf (Seitentyp, Tool-Sequenz, Outcome, Content-Hash). Der Seitentyp wird regelbasiert aus dem A11y-Tree bestimmt (kein ML). Domain wird optional als Metadatum gespeichert, nicht als Schluessel verwendet
FR41: Pattern-Eintraege werden in einem kryptographisch gesicherten Append-Only Merkle Log gespeichert (RFC-6962-kompatibel)
FR42: Bei Seitentyp-Match liefern navigate und view_page Cortex-Hints in der Tool-Response (_meta.cortex). Der Seitentyp wird aus dem A11y-Tree der aktuellen Seite bestimmt. Hints enthalten Markov-basierte Tool-Vorhersagen (naechstes wahrscheinlichstes Tool)
FR43: Der MCP zeigt in seiner Server-Description die Anzahl geladener Community-Patterns an
FR44: Pattern-Eintraege koennen opt-in an einen Collection-Endpoint gesendet werden (anonymisiert, Rate-Limited, kein PII). Payloads enthalten Seitentyp und Tool-Sequenz — keine Domain, keine URLs
FR45: Der Cortex-Bundle wird beim Start heruntergeladen, Sigstore-Signatur und Merkle Inclusion Proof werden lokal verifiziert
FR46: Ungueltige oder nicht-verifizierbare Bundles werden ignoriert (sicherer Default, kein Fallback auf unverifizierten Content)

### NonFunctional Requirements

**Performance (DONE)**
NFR1: Einzel-Tool-Operationen antworten in unter 50ms Median auf localhost
NFR2: Tool-Definitionen verbrauchen unter 5.000 Tokens im MCP-System-Prompt
NFR3: Screenshots werden als komprimiertes WebP unter 100KB und max 800px Breite ausgeliefert
NFR4: view_page liefert bei DOMs ueber 50.000 Tokens automatisch eine downgesampelte Version mit Safety-Cap
NFR5: tab_status antwortet in 0ms (Cache-Hit, kein CDP-Roundtrip)
NFR6: run_plan fuehrt N Steps ohne Zwischen-Latenz aus

**Reliability (DONE)**
NFR7: Bei CDP-Verbindungsverlust erfolgt automatische Wiederverbindung mit Exponential Backoff
NFR8: Kein Datenverlust bei Auto-Reconnect
NFR9: Stale-Refs nach Navigation werden erkannt und mit Recovery-Hinweis quittiert
NFR10: Der Server faengt Chrome-Absturz ab und gibt eine klare Fehlermeldung

**Integration (DONE)**
NFR11: Kompatibel mit Chrome 120+
NFR12: Funktioniert mit jedem MCP-kompatiblen Client ohne client-spezifische Anpassungen
NFR13: CDP-WebSocket-Verbindung ueber localhost:9222
NFR14: MCP-Kommunikation ueber stdio (JSON-RPC)
NFR15: Cross-Origin-iFrames (OOPIF) werden transparent per CDP-Session-Manager behandelt

**Security (GEAENDERT — License entfaellt, Cortex-Telemetrie neu)**
NFR16: navigator.webdriver wird maskiert um Bot-Detection zu vermeiden
NFR17: Cortex-Telemetrie ist opt-in. Ohne Opt-in werden keine Daten gesendet. Kein PII. Server ist ohne Opt-in vollstaendig offline-faehig

**CDP-Koexistenz (ausstehend — Script API v2)**
NFR18: MCP-Server und Script-API koennen gleichzeitig auf denselben Chrome zugreifen. Tab-Isolation.

**Cortex-Integritaet (NEU — Epic 12 + 13)**
NFR19: Cortex-Bundle-Download darf den MCP-Start um maximal 2 Sekunden verzoegern (Cache-Hit: 0ms, Cache-Miss: max 2s)
NFR20: Der WASM-Validator ist deterministisch — gleiche Inputs erzeugen auf jeder Plattform identische Outputs (Nix-Build-Hash)
NFR21: Cortex-Patterns enthalten ausschliesslich: Seitentyp, Tool-Sequenz, Metriken. Domain optional lokal, nicht in Telemetrie/Bundles. Keine User-Daten, keine Credentials

### Additional Requirements (Architecture)

- Brownfield-Projekt: v1.3.0, 22 Epics DONE, 1500+ Tests. Kein Scaffolding.
- Cortex-Modul: src/cortex/ mit 8 Dateien (pattern-recorder, local-store, hint-matcher, page-classifier, markov-table, bundle-loader, telemetry-upload, cortex-types)
- Cortex-Validator: Separates Rust-Projekt (cortex-validator/), kompiliert zu WASM (wasmtime, WASI P2), Nix-Build
- Integration Points Cortex: hooks/ fuer Pattern-Recording, navigate + read-page fuer Hint-Delivery, index.ts fuer Bundle-Loading beim Start
- License-Modul entfernen: src/license/, cli/license-commands.ts, Feature-Gating in registry.ts und plan-executor.ts
- Pro-Repo archivieren: Combined Binary Build, Pro-Injection-Pipeline entfaellt
- Package-Migration: npm (@silbercue/chrome → public-browser), pip (silbercuechrome → publicbrowser)
- GitHub-Repo-Migration: publicbrowser/chrome (neu), altes Repo redirect

### UX Design Requirements

N/A — MCP-Server ohne UI.

### FR Coverage Map

| FR | Status | Epic |
|---|---|---|
| FR1-FR5 | DONE | Epic 1 (Page Reading) |
| FR6-FR11 | DONE | Epic 2 (Element Interaction), FR10 Pro-Gate → Epic 11 entfernen |
| FR12-FR16 | DONE | Epic 3 (Workflows), FR12 Step-Limit → Epic 11 entfernen |
| FR17-FR18 | DONE | Epic 4 (Tab Management), Pro-Gate → Epic 11 entfernen |
| FR19-FR20 | DONE | Epic 4 (Downloads) |
| FR21-FR24 | DONE | Epic 5 (Connection) |
| FR25-FR29 | DONE/DEFERRED | Epic 6 (Steering), Stories 6.1/6.2 deferred |
| FR30-FR31 | GEAENDERT | Epic 11 (Migration) — Rename + keine Einschraenkungen |
| FR34-FR39 | v1 DONE | Epic 9 (Script API v1), v2 Shared Core ausstehend |
| FR40-FR44 | DONE | Epic 12 (Cortex Phase 1) + Epic 12a (Pattern Generalization) |
| FR45-FR46 | Vereinfacht | Story 12a.6 (Community-Markov im npm-Paket). Epic 13 gestrichen |

## Epic List

### Abgeschlossene Epics (Referenz)

- Epic 1: Page Reading & Navigation — DONE
- Epic 2: Element Interaction — DONE
- Epic 3: Workflows & Automation — DONE
- Epic 4: Tab & Download Management — DONE
- Epic 5: Connection & Setup — DONE
- Epic 6: Tool Steering — DONE (Stories 6.1/6.2 DEFERRED)
- Epic 7: Distribution — DONE
- Epic 8: Docs & Release — DONE
- Epic 9: Script API v1 — DONE
- Epic 10: Vision POC — POC VERLOREN (archiviert)

### Neue Epics (Public Browser Pivot)

- **Epic 11: Public Browser Migration (v2.0.0)** — Pro-Features freischalten, License entfernen, Rename, Package-Migration
- **Epic 12: Cortex Phase 1 — Lokales Lernen + Merkle Log** — Pattern-Recorder, lokaler Merkle Log, Cortex-Hints, Telemetrie-Upload — DONE
- **Epic 12a: Cortex Pattern Generalization** — Seitentyp-Klassifikator, Markov-Tabelle, Hint-Matcher + Telemetrie Retrofit auf PageType
- ~~**Epic 13: Cortex Phase 2 — Validierung + Distribution**~~ — GESTRICHEN (2026-04-27). Grund: Epic 12a (PageType-Pivot) hat das Problem eliminiert. 10KB Markov-Tabelle shipped statisch im npm-Paket, braucht weder WASM noch Sigstore noch OCI. Verbleibende Arbeit → Story 12a.6

## Epic 11: Public Browser Migration (v2.0.0)

**Goal:** Pro-Features freischalten, License-System komplett entfernen, Projekt umbenennen und Packages migrieren. Ergebnis: v2.0.0 als vollstaendig freies Open-Source-Produkt unter neuem Namen.

**FRs:** FR10 (Pro-Gate), FR12 (Step-Limit), FR17-18 (Pro-Gate), FR30-31 (Rename + keine Einschraenkungen)
**NFRs:** NFR17 (Telemetrie-Anpassung)

### Story 11.1: Pro-Feature-Gates entfernen

As a Developer,
I want alle Pro-Feature-Gates entfernt,
So that alle Tools ohne Einschraenkung fuer jeden Nutzer verfuegbar sind.

**Acceptance Criteria:**

**Given** der MCP-Server wird ohne License-Key gestartet
**When** ein LLM-Agent switch_tab, virtual_desk oder press_key aufruft
**Then** werden die Tools ausgefuehrt ohne Pro-Check oder Fehlermeldung

**Given** der MCP-Server wird ohne License-Key gestartet
**When** ein run_plan mit mehr als 3 Steps gesendet wird
**Then** werden alle Steps ausgefuehrt ohne Step-Limit oder Teilergebnis-Abbruch

**Given** registry.ts enthaelt kein isProEnabled() Check mehr
**And** plan-executor.ts enthaelt kein Step-Limit mehr
**Then** npm test laeuft ohne Regression (1500+ Tests)

### Story 11.2: License-System entfernen

As a Developer,
I want das gesamte License-System entfernt,
So that kein toter Code, keine externe Abhaengigkeit (Polar.sh) und keine Umgebungsvariablen fuer Lizenzen im Projekt bleiben.

**Acceptance Criteria:**

**Given** src/license/ existiert (license-status.ts, free-tier-config.ts)
**When** das Verzeichnis komplett entfernt wird
**Then** kompiliert das Projekt fehlerfrei (npm run build)

**Given** src/cli/license-commands.ts existiert (--activate, --deactivate)
**When** die Datei entfernt wird
**Then** CLI-Hilfe zeigt keine License-Subcommands mehr

**Given** SILBERCUECHROME_LICENSE wird als Umgebungsvariable referenziert
**When** alle Referenzen entfernt sind
**Then** grep -r "SILBERCUECHROME_LICENSE" src/ liefert 0 Treffer

**Given** alle License-Aenderungen sind durchgefuehrt
**Then** npm test laeuft ohne Regression

### Story 11.3: Pro-Repo archivieren

As a Developer,
I want die Combined-Binary-Build-Pipeline und Pro-Repo-Injection entfernt,
So that nur noch ein einziges Open-Source-Repository existiert.

**Acceptance Criteria:**

**Given** die Pro-Build-Pipeline existiert (scripts/build-binary-linux.sh, SEA-Config)
**When** Pro-Build-Artefakte entfernt werden
**Then** npm run build produziert ein funktionierendes Package ohne Pro-Injection

**Given** das private Pro-Repo existiert
**When** es archiviert wird (GitHub Archive)
**Then** keine aktiven Referenzen mehr im Public-Repo

### Story 11.4: Projekt umbenennen

As a Developer,
I want alle internen Referenzen von SilbercueChrome auf Public Browser umbenannt,
So that der neue Name konsistent im gesamten Projekt verwendet wird.

**Acceptance Criteria:**

**Given** package.json name ist @silbercue/chrome
**When** auf public-browser geaendert wird
**Then** npm pack erzeugt public-browser-2.0.0.tgz

**Given** README.md, CLAUDE.md, prompt.md referenzieren SilbercueChrome
**When** alle Referenzen auf Public Browser aktualisiert werden
**Then** grep -r "SilbercueChrome" . --include="*.md" liefert nur historische Referenzen (CHANGELOG, Migration Guide)

**Given** MCP Server Instructions (prompt.md) referenzieren den alten Namen
**When** auf Public Browser aktualisiert
**Then** MCP-Clients sehen "Public Browser" als Server-Name

### Story 11.5: npm-Package-Migration

As a Developer,
I want das npm-Package von @silbercue/chrome auf public-browser migriert,
So that Nutzer ueber npx public-browser@latest installieren koennen.

**Acceptance Criteria:**

**Given** das Package public-browser existiert nicht auf npm
**When** npm publish ausgefuehrt wird
**Then** public-browser@2.0.0 ist auf npm verfuegbar

**Given** das alte Package @silbercue/chrome existiert auf npm
**When** eine Deprecation Notice gesetzt wird
**Then** npm install @silbercue/chrome zeigt Deprecation-Warnung mit Verweis auf public-browser

**Given** npx public-browser@latest wird ausgefuehrt
**Then** Chrome startet und MCP-Server verbindet

### Story 11.6: Python-Package-Migration

As a Developer,
I want das Python-Package von silbercuechrome auf publicbrowser migriert,
So that Nutzer ueber pip install publicbrowser installieren koennen.

**Acceptance Criteria:**

**Given** python/silbercuechrome/ wird zu python/publicbrowser/ umbenannt
**When** pip install publicbrowser ausgefuehrt wird
**Then** from publicbrowser import Chrome funktioniert

**Given** Chrome.connect() wird aufgerufen
**When** der Server-Pfad aufgeloest wird
**Then** public-browser Binary wird gefunden (PATH, npx, oder expliziter Pfad)

### Story 11.7: v2.0.0 Release

As a Developer,
I want ein v2.0.0 Release erstellt,
So that die Migration oeffentlich und offiziell ist.

**Acceptance Criteria:**

**Given** alle Stories 11.1-11.6 sind abgeschlossen
**When** scripts/publish.ts ausgefuehrt wird
**Then** public-browser@2.0.0 ist auf npm, GitHub Release mit Changelog existiert

**Given** die Benchmark-Suite (35 Tests) wird gegen v2.0.0 ausgefuehrt
**Then** 35/35 Tests bestanden, keine Performance-Regression gegenueber v1.3.0

## Epic 12: Cortex Phase 1 — Lokales Lernen + Merkle Log

**Goal:** Der MCP lernt aus erfolgreichen Tool-Sequenzen und speichert sie lokal in einem kryptographisch gesicherten Append-Only Log. Cortex-Hints werden in Tool-Responses eingebettet.

**FRs:** FR40-FR44
**NFRs:** NFR17 (Telemetrie opt-in), NFR19 (Bundle-Download max 2s), NFR21 (Pattern-Privacy)

### Story 12.1: Pattern-Recorder

As a Developer,
I want dass erfolgreiche Tool-Sequenzen automatisch als Patterns aufgezeichnet werden,
So that der Cortex aus wiederholten Interaktionen lernt.

**Acceptance Criteria:**

**Given** ein LLM-Agent fuehrt navigate → view_page → click → wait_for erfolgreich aus
**When** der letzte Tool-Call erfolgreich zurueckkehrt
**Then** wird ein Pattern-Eintrag erzeugt mit Domain, Pfad-Pattern, Tool-Sequenz, Outcome und Content-Hash

**Given** src/cortex/pattern-recorder.ts existiert
**When** es als Hook in hooks/default-on-tool-result.ts eingebunden ist
**Then** wird nach jedem erfolgreichen Tool-Call geprueft ob eine aufzeichnungswuerdige Sequenz vorliegt

**Given** ein Tool-Call schlaegt fehl
**Then** wird kein Pattern aufgezeichnet (nur erfolgreiche Sequenzen)

**Given** cortex/cortex-types.ts definiert Pattern-Typen
**Then** enthaelt Pattern: domain, pathPattern, toolSequence, outcome, contentHash, timestamp

### Story 12.2: Lokaler Merkle Append-Only Log

As a Developer,
I want Pattern-Eintraege in einem kryptographisch gesicherten Merkle Log gespeichert,
So that die Integritaet der lokalen Lernhistorie verifizierbar ist.

**Acceptance Criteria:**

**Given** ein Pattern-Eintrag wird vom Pattern-Recorder erzeugt
**When** er an cortex/local-store.ts uebergeben wird
**Then** wird er an den lokalen Merkle Log angehaengt (Append-Only)

**Given** der Merkle Log wird gelesen
**Then** ist jeder Eintrag per Merkle Inclusion Proof verifizierbar

**Given** ein gespeicherter Eintrag wird manipuliert
**When** ein Integrity-Check ausgefuehrt wird
**Then** wird die Manipulation erkannt (Hash-Mismatch)

**Given** der Log ist RFC-6962-kompatibel
**Then** koennen Standard-Tools den Signed Tree Head verifizieren

### Story 12.3: Cortex-Hint in Tool-Responses

As a Developer,
I want dass navigate und view_page Cortex-Hints in der Response liefern,
So that der LLM-Agent von gespeichertem Wissen profitiert.

**Acceptance Criteria:**

**Given** der lokale Cortex enthaelt ein Pattern fuer dashboard.example.com
**When** navigate("https://dashboard.example.com") aufgerufen wird
**Then** enthaelt die Response ein _meta.cortex Feld mit dem Hint

**Given** cortex/hint-matcher.ts fuehrt URL-Pattern-Matching durch
**When** kein Pattern fuer die aktuelle URL existiert
**Then** wird kein _meta.cortex Feld in die Response eingefuegt

**Given** Cortex-Hints werden geliefert
**Then** enthalten sie: empfohlene Tool-Sequenz, Erfolgsrate, Installations-Count

### Story 12.4: Icon/Badge-Indikator

As a Developer,
I want dass die MCP Server-Description die Anzahl geladener Cortex-Patterns anzeigt,
So that der LLM-Agent und der Nutzer wissen ob Cortex-Wissen verfuegbar ist.

**Acceptance Criteria:**

**Given** der Cortex enthaelt 15 lokale Patterns
**When** der MCP-Server seine Description liefert
**Then** enthaelt sie "15 cortex patterns loaded" (oder aehnlich)

**Given** kein Cortex-Wissen vorhanden
**Then** wird kein Cortex-Hinweis in der Description angezeigt

### Story 12.5: Opt-in Telemetrie-Upload

As a Developer,
I want Pattern-Eintraege opt-in an einen Collection-Endpoint senden koennen,
So that Community-Intelligence aufgebaut werden kann.

**Acceptance Criteria:**

**Given** Telemetrie ist NICHT aktiviert (Default)
**When** der MCP-Server laeuft
**Then** werden KEINE Daten an externe Endpoints gesendet

**Given** Telemetrie ist per Konfiguration aktiviert (opt-in)
**When** ein neuer Pattern-Eintrag erzeugt wird
**Then** wird er anonymisiert per HTTPS POST an den Collection-Endpoint gesendet

**Given** ein Pattern-Eintrag wird zum Upload vorbereitet
**Then** enthaelt er NUR: Domain, Pfad-Pattern, Tool-Sequenz, Success-Rate, Content-Hash, Timestamp
**And** keine PII, keine URLs mit Auth-Tokens, keine Seiteninhalte (NFR21)

**Given** der Upload wird Rate-Limited
**Then** maximal 1 Upload pro Minute pro Pattern-Typ

## Epic 12a: Cortex Pattern Generalization

**Goal:** Cortex-Patterns von domain-basierten auf seitentyp-basierte Schluessel umstellen. Drei-Schichten-Erkennung: regelbasierter Klassifikator (Schicht 1), Markov-Uebergangstabelle (Schicht 2), SimHash-Fallback (Schicht 3, deferred).

**FRs:** FR40 (aktualisiert), FR42 (aktualisiert)
**NFRs:** NFR19 (Bundle-Groesse drastisch reduziert), NFR21 (Privacy verbessert)

### Story 12a.1: Seitentyp-Taxonomie + A11y-Tree-Klassifikator

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

### Story 12a.2: CortexPattern Retrofit auf PageType

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

### Story 12a.3: Markov-Uebergangstabelle

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

### Story 12a.4: Hint-Matcher Retrofit

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

### Story 12a.5: Telemetrie-Payload + Privacy-Update

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

## ~~Epic 13: Cortex Phase 2 — Validierung + Distribution~~ GESTRICHEN

**Datum:** 2026-04-27
**Grund:** Epic 12a (PageType-Pivot) hat das zugrunde liegende Problem eliminiert.

Die Markov-Tabelle ist ~10KB statt Megabytes an Domain-Patterns. Damit entfallen:
- WASM-Validator (JSON-Schema + SHA256 reicht fuer 10KB)
- Sigstore-Signierung (npm-Paket ist bereits signiert)
- OCI Distribution (10KB shipped statisch mit `npm install`)
- Canary-Deployment (monatliche npm-Releases reichen)
- Bundle-Loader (kein separater Download noetig)

**FRs betroffen:** FR45-FR46 werden vereinfacht zu Story 12a.6.
**NFRs:** NFR19 trivial erfuellt (kein Download), NFR20 entfaellt (kein WASM), NFR21 bereits durch 12a.5 erfuellt.

---

### Story 12a.6: Community-Markov-Tabelle im npm-Paket

As a Developer,
I want eine vorkuratierte Community-Markov-Tabelle die statisch im npm-Paket ausgeliefert wird,
So that jede Installation sofort von Community-Wissen profitiert (ohne separaten Download).

**Acceptance Criteria:**

**Given** `src/cortex/community-markov.json` existiert
**When** der MCP-Server startet
**Then** wird die Community-Tabelle geladen und mit der lokalen Markov-Tabelle gemergt (Community als Baseline, lokale Daten ueberschreiben bei gleichem Key)

**Given** die Community-Tabelle geladen wird
**When** ein SHA256-Integritaets-Check durchgefuehrt wird
**Then** wird der Hashwert gegen einen im Code hinterlegten Expected-Hash geprueft
**And** bei Mismatch wird die Tabelle ignoriert und eine Warnung auf stderr geloggt

**Given** Telemetrie-Daten von Nutzern eingehen (opt-in, Story 12a.5)
**When** ein Aggregations-Script (`scripts/aggregate-telemetry.ts`) ausgefuehrt wird
**Then** wird eine neue `community-markov.json` generiert (Batch-Job, nicht Echtzeit)
**And** die Datei wird beim naechsten `npm publish` mit ausgeliefert

**Given** die Community-Tabelle als JSON vorliegt
**Then** ist sie unter 50KB (Ziel: ~10KB bei 20 Seitentypen)
**And** enthaelt NUR: pageType, lastTool, nextTool, probability, sampleCount
**And** keine Domain, keine URLs, kein PII (NFR21)

**Given** kein `community-markov.json` existiert (erster Start, Entwicklung)
**Then** startet der Server ohne Community-Daten (nur lokales Lernen, graceful degradation)
