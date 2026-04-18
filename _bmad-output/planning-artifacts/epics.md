---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
workflowType: 'epics-and-stories'
project_name: 'SilbercueChrome'
user_name: 'Julian'
date: '2026-04-14'
---

# SilbercueChrome - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for SilbercueChrome, decomposing the requirements from the PRD and Architecture requirements into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: Der LLM-Agent kann den Accessibility-Tree einer Seite lesen und erhaelt stabile Element-Referenzen (Refs) fuer jedes interaktive Element
FR2: Der LLM-Agent kann zu einer URL navigieren und erhaelt den Seitenstatus nach dem Laden
FR3: Der LLM-Agent kann einen komprimierten Screenshot der aktuellen Seite anfordern
FR4: Der LLM-Agent kann den Tab-Status (URL, Titel, Ladezustand) aus dem Cache abfragen ohne CDP-Roundtrip
FR5: Der LLM-Agent kann den Accessibility-Tree mit konfigurierbarem Token-Budget anfordern (progressive Tiefe)
FR6: Der LLM-Agent kann ein Element per Ref, CSS-Selector oder sichtbarem Text anklicken
FR7: Der LLM-Agent kann Text in ein Eingabefeld eingeben (per Ref oder Selector)
FR8: Der LLM-Agent kann mehrere Formularfelder in einem einzigen Tool-Call ausfuellen
FR9: Der LLM-Agent kann die Seite oder einen spezifischen Container scrollen
FR10: Der LLM-Agent kann Tastendruecke an ein Element senden (Pro)
FR11: Der LLM-Agent kann Drag-and-Drop-Operationen ausfuehren
FR12: Der LLM-Agent kann einen mehrstufigen Plan in einem einzigen Tool-Call ausfuehren (run_plan), wobei Free-Tier auf 3 Steps begrenzt ist
FR13: Der LLM-Agent kann beliebiges JavaScript im Browser-Kontext ausfuehren und das Ergebnis erhalten
FR14: Der LLM-Agent kann auf eine Bedingung warten (Element sichtbar, Network idle, JS-Expression true)
FR15: Der LLM-Agent kann DOM-Aenderungen an einem Element beobachten und erhaelt alle Mutationen als Ergebnis
FR16: run_plan liefert bei Ueberschreitung des Step-Limits ein Teilergebnis ohne Fehlermeldung zurueck
FR17: Der LLM-Agent kann neue Tabs oeffnen, zwischen Tabs wechseln und Tabs schliessen (Pro)
FR18: Der LLM-Agent kann eine Uebersicht aller offenen Tabs mit URL und Titel in unter 500 Tokens abrufen (Pro)
FR19: Der LLM-Agent kann den Status laufender und abgeschlossener Downloads abfragen
FR20: Der LLM-Agent kann die Download-Session-History einsehen
FR21: Der Server kann Chrome automatisch starten und per CDP verbinden (Zero-Config)
FR22: Der Server kann sich per `--attach` an ein bereits laufendes Chrome anhaengen
FR23: Der Server verbindet sich nach CDP-Verbindungsverlust automatisch neu (Auto-Reconnect)
FR24: Element-Refs bleiben nach Auto-Reconnect stabil (Tab-IDs und Refs werden nicht invalidiert)
FR25: Der Server erkennt Anti-Patterns in der Tool-Nutzung (z.B. evaluate-Spiral) und gibt dem LLM korrigierende Hinweise
FR26: Der Server gibt bei Stale-Refs nach Navigation einen Recovery-Hinweis ("call view_page to get fresh refs")
FR27: Tool-Descriptions enthalten Negativ-Abgrenzung (wann NICHT verwenden, welches Tool stattdessen)
FR28: Der Server bietet konfigurierbare Tool-Profile an (Default 10 Tools, Full-Set via Env-Variable)
FR29: Der Server gibt bei click/type einen synchronen DOM-Diff zurueck (was hat sich geaendert)
FR30: Der Developer kann SilbercueChrome via `npx @silbercue/chrome@latest` ohne Installation starten
FR31: Der Developer kann einen Pro-License-Key per Umgebungsvariable oder Config-Datei aktivieren
FR32: Pro-Features funktionieren 7 Tage offline nach letzter Lizenz-Validierung (Grace Period)
FR33: Free-Tier-Tools funktionieren ohne Lizenz-Key vollstaendig und ohne kuenstliche Einschraenkungen (ausser run_plan Step-Limit)
FR34: Der MCP-Server kann im --script Modus gestartet werden, der zusaetzlich einen lokalen HTTP-Endpunkt (Port 9223) fuer Script-API-Clients startet und Tab-Isolation fuer externe Clients aktiviert
FR35: Das --script Flag aktiviert Tab-Isolation (ownedTargetIds) und den Script-API-HTTP-Endpunkt. MCP-interne Guards (switch_tab-Mutex, registry Parallel-Block) bleiben unberuehrt
FR36: Jedes Script arbeitet in einem eigenen Tab — MCP-Tabs werden nicht gestoert, Script-Tabs werden beim Context-Manager-Exit geschlossen
FR37: Die Script API bietet die Methoden navigate, click, fill, type, wait_for, evaluate und download — diese nutzen intern die gleichen Tool-Implementierungen wie der MCP-Server (Shared Core), sodass Verbesserungen automatisch auch Script-Nutzern zugutekommen
FR38: Die Script API nutzt ein Context-Manager-Pattern (with chrome.new_page()), das Tab-Lifecycle automatisch verwaltet
FR39: Die Script API wird als Python-Package (pip install silbercuechrome) distribuiert. Chrome.connect() startet den SilbercueChrome-Server bei Bedarf automatisch im Hintergrund (PATH/npx/expliziter Pfad)

### NonFunctional Requirements

NFR1: Einzel-Tool-Operationen (click, type, view_page) antworten in unter 50ms Median auf localhost
NFR2: Tool-Definitionen verbrauchen unter 5.000 Tokens im MCP-System-Prompt (Vergleich: Playwright 13.700, Chrome DevTools MCP 17.000)
NFR3: Screenshots werden als komprimiertes WebP unter 100KB und max 800px Breite ausgeliefert
NFR4: view_page liefert bei DOMs ueber 50.000 Tokens automatisch eine downgesampelte Version mit Safety-Cap
NFR5: tab_status antwortet in 0ms (Cache-Hit, kein CDP-Roundtrip)
NFR6: run_plan fuehrt N Steps ohne Zwischen-Latenz aus (keine kuenstliche Wartezeit zwischen Steps)
NFR7: Bei CDP-Verbindungsverlust erfolgt automatische Wiederverbindung mit Exponential Backoff
NFR8: Kein Datenverlust bei Auto-Reconnect — Tab-IDs und gecachter State bleiben erhalten
NFR9: Stale-Refs nach Navigation werden erkannt und mit Recovery-Hinweis quittiert (kein stiller Fehler)
NFR10: Der Server faengt Chrome-Absturz ab und gibt eine klare Fehlermeldung (kein haengender Prozess)
NFR11: Kompatibel mit Chrome 120+ (aktuelle Stable + letzte 3 Major-Versionen)
NFR12: Funktioniert mit jedem MCP-kompatiblen Client ohne client-spezifische Anpassungen
NFR13: CDP-WebSocket-Verbindung ueber `localhost:9222` (Standard-Port, konfigurierbar)
NFR14: MCP-Kommunikation ueber stdio (JSON-RPC), kein HTTP-Server noetig
NFR15: Cross-Origin-iFrames (OOPIF) werden transparent per CDP-Session-Manager behandelt
NFR16: License-Keys werden lokal gespeichert und nur zur Validierung an Polar.sh gesendet (kein Tracking)
NFR17: `navigator.webdriver` wird maskiert um Bot-Detection auf besuchten Seiten zu vermeiden
NFR18: Kein Telemetrie-Versand, keine Nutzungsdaten, keine Analytics — der Server ist vollstaendig offline-faehig (ausser Lizenz-Check)
NFR19: MCP-Server (via Pipe/stdio) und Script-API (via Server HTTP-Endpunkt) koennen gleichzeitig auf denselben Chrome zugreifen, ohne sich gegenseitig zu stoeren. Jeder Client arbeitet in eigenen Tabs

### Additional Requirements

- Story 23.1: evaluate Anti-Spiral v2 — situational steering, zwei-Tier Streak-System, drei neue Anti-Patterns (architektonisch groesste Erweiterung fuer v1.0)
- BUG-003: WebSocket Accept-Workaround (Node 22 + Chrome 146 Inkompatibilitaet) muss im README dokumentiert werden
- Verbleibende Friction-Fixes aus deferred-work.md abarbeiten
- README-Update mit Getting-Started-Anleitung und Benchmark-Dokumentation
- registry.ts Maintainability post-v1.0 evaluieren (94 KB monolithisch, akzeptabel fuer Solo-Dev)
- Implementation Patterns einhalten: Naming (kebab-case Files, camelCase Functions, PascalCase Types), Tool Implementation Pattern (Zod-Schema, Handler, Registry-Eintrag, Co-located Test), CDP Call Pattern (session.send()), Error Handling (MCP-Response, kein throw), Tool Description Pattern (Negativ-Abgrenzung), run_plan Step Pattern
- Keine neuen Runtime-Dependencies ohne Begruendung (aktuell 4: @modelcontextprotocol/sdk, zod, pixelmatch, pngjs)
- Combined Binary Build: Pro-Code aus privatem Repo injiziert, Runtime Feature-Detection via Polar.sh

### UX Design Requirements

Entfaellt — SilbercueChrome ist ein MCP-Server ohne eigene UI. Die "Oberflaeche" sind Tool-Descriptions und MCP-Responses, die direkt vom LLM konsumiert werden. Steering-Qualitaet der Tool-Descriptions ist in FR25-FR29 abgedeckt.

### FR Coverage Map

FR1: Epic 1 — A11y-Tree mit stabilen Refs
FR2: Epic 1 — URL-Navigation mit Seitenstatus
FR3: Epic 1 — Komprimierter Screenshot
FR4: Epic 1 — Tab-Status aus Cache
FR5: Epic 1 — Progressive Tiefe
FR6: Epic 2 — Click per Ref/Selector/Text
FR7: Epic 2 — Texteingabe
FR8: Epic 2 — Multi-Field Formular
FR9: Epic 2 — Scroll
FR10: Epic 2 — Tastendruecke (Pro)
FR11: Epic 2 — Drag-and-Drop
FR12: Epic 3 — run_plan Batch-Execution
FR13: Epic 3 — JavaScript Execution
FR14: Epic 3 — wait_for Bedingungen
FR15: Epic 3 — observe (MutationObserver)
FR16: Epic 3 — Teilergebnis bei Step-Limit
FR17: Epic 4 — Tabs oeffnen/wechseln/schliessen
FR18: Epic 4 — Tab-Uebersicht
FR19: Epic 4 — Download-Status
FR20: Epic 4 — Download-Session-History
FR21: Epic 5 — Chrome Auto-Launch
FR22: Epic 5 — --attach Mode
FR23: Epic 5 — Auto-Reconnect
FR24: Epic 5 — Ref-Stabilitaet nach Reconnect
FR25: Epic 6 — Anti-Pattern-Detection
FR26: Epic 6 — Stale-Ref Recovery
FR27: Epic 6 — Negativ-Abgrenzung in Descriptions
FR28: Epic 6 — Konfigurierbare Tool-Profile
FR29: Epic 6 — Synchroner DOM-Diff
FR30: Epic 7 — npx Zero-Install
FR31: Epic 7 — License-Key Aktivierung
FR32: Epic 7 — Grace Period
FR33: Epic 7 — Free-Tier Vollstaendigkeit
FR34: Epic 9 — --script CLI-Mode (CDP-Port oeffnen)
FR35: Epic 9 — Guard-Deaktivierung fuer Script-Zugriff
FR36: Epic 9 — Tab-Isolation (eigener Tab pro Script)
FR37: Epic 9 — Python-Methoden (navigate, click, fill, type, wait_for, evaluate, download)
FR38: Epic 9 — Context-Manager-Pattern (with chrome.new_page())
FR39: Epic 9 — pip-Distribution und Single-File-Alternative

## Epic List

### Epic 1: Page Reading & Navigation
Der Agent kann jede Webseite lesen und verstehen — A11y-Tree mit stabilen Refs, progressive Tiefe, Screenshots, Tab-Status aus Cache, URL-Navigation.
**FRs covered:** FR1, FR2, FR3, FR4, FR5

### Epic 2: Element Interaction
Der Agent kann mit jedem Element interagieren — Click per Ref/Selector/Text, Texteingabe, Formular-Ausfuellung, Scroll, Tastendruecke (Pro), Drag-and-Drop.
**FRs covered:** FR6, FR7, FR8, FR9, FR10, FR11

### Epic 3: Automated Multi-Step Workflows
Der Agent kann mehrstufige Aufgaben in einem Aufruf erledigen — run_plan mit Free-Limit und Pro-Unlimited, JavaScript-Execution, Warten auf Bedingungen, DOM-Beobachtung, Teilergebnis bei Limit.
**FRs covered:** FR12, FR13, FR14, FR15, FR16

### Epic 4: Tab & Download Management
Der Agent kann Browser-Sessions verwalten — Multi-Tab-Handling und Uebersicht (Pro), Download-Status und Session-History.
**FRs covered:** FR17, FR18, FR19, FR20

### Epic 5: Connection & Reliability
Chrome verbindet sich automatisch und bleibt stabil — Zero-Config Auto-Launch, --attach, Auto-Reconnect mit State-Erhalt, Ref-Stabilitaet.
**FRs covered:** FR21, FR22, FR23, FR24

### Epic 6: Intelligent Tool Steering
Der Server fuehrt das LLM aktiv zum richtigen Tool — Anti-Pattern-Detection (v2 mit drei neuen Patterns), Stale-Ref-Recovery, Negativ-Abgrenzung, Tool-Profile, DOM-Diff. Hauptsaechliche neue Arbeit fuer v1.0.
**FRs covered:** FR25, FR26, FR27, FR28, FR29

### Epic 7: Distribution & Licensing
Nahtlose Installation und Free-to-Pro-Upgrade — npx Zero-Install, License-Key per Env/Config, 7-Tage Grace Period, Free-Tier ohne Einschraenkungen.
**FRs covered:** FR30, FR31, FR32, FR33

### Epic 8: Documentation & v1.0 Release
Alles was v1.0 versandfertig macht — README mit Getting-Started, BUG-003-Dokumentation, Benchmark-Dokumentation, verbleibende Friction-Fixes, Release-Vorbereitung.
**FRs covered:** Keine direkten FRs — adressiert Additional Requirements und NFR11, NFR12

### Epic 9: Script API (Python) — Shared Core
Dritter Zugangsweg neben MCP und CLI — eine Python-Client-Library fuer deterministische Browser-Automation ohne LLM im Loop. Scripts nutzen intern dieselben Tool-Implementierungen wie der MCP-Server (Shared Core). Auto-Start des Servers, Tab-Isolation, Context-Manager-Pattern, pip-Distribution.
**FRs covered:** FR34, FR35, FR36, FR37, FR38, FR39
**NFRs covered:** NFR19
**Phasen:** v1 (Stories 9.1-9.6, DONE — separate CDP-Implementierung) → v2 (Stories 9.7-9.11, Shared Core)

## Epic 1: Page Reading & Navigation

Alle 5 FRs (FR1-FR5) sind vollstaendig implementiert und getestet. Keine neuen Stories noetig fuer v1.0.

## Epic 2: Element Interaction

Alle 6 FRs (FR6-FR11) sind vollstaendig implementiert und getestet. Keine neuen Stories noetig fuer v1.0.

## Epic 3: Automated Multi-Step Workflows

Alle 5 FRs (FR12-FR16) sind vollstaendig implementiert und getestet. Friction-Fixes FR-021 (observe Refs), FR-022 (press_key in run_plan), FR-023 (iFrame in run_plan) wurden bereits gefixt. Keine neuen Stories noetig fuer v1.0.

## Epic 4: Tab & Download Management

Alle 4 FRs (FR17-FR20) sind vollstaendig implementiert und getestet. Keine neuen Stories noetig fuer v1.0.

## Epic 5: Connection & Reliability

Alle 4 FRs (FR21-FR24) sind vollstaendig implementiert und getestet. FR-025 (navigator.webdriver) wurde bereits gefixt (Chrome-Launch-Flag + Defense-in-Depth). Keine neuen Stories noetig fuer v1.0.

## Epic 6: Intelligent Tool Steering

Der Server fuehrt das LLM aktiv zum richtigen Tool. FR26-FR29 sind implementiert. FR25 (Anti-Pattern-Detection) ist mitigiert (BUG-018) — Story 6.1 (Anti-Spiral v2) und Story 6.2 (Pro DOM-Diff) sind deferred post-v1.0.

### Story 6.1: Evaluate Anti-Spiral v2 — Situational Tool Steering ⏳ DEFERRED post-v1.0

As a LLM-Agent,
I want korrigierende Hinweise bei fehlgeleiteten evaluate-Aufrufen auf die richtigen dedizierten Tools,
So that ich weniger Roundtrips brauche und zuverlaessiger arbeite.

**Acceptance Criteria:**

**Given** das LLM ruft evaluate mit `window.alert`/`confirm`/`prompt`-Overrides auf
**When** der Server den Call analysiert
**Then** erhaelt das LLM einen Hint auf `handle_dialog(action: 'dismiss'|'accept')`

**Given** das LLM ruft evaluate mit `window.scrollTo`/`scrollBy`/`scrollTop`-Zuweisungen auf
**When** der Server den Call analysiert
**Then** erhaelt das LLM einen Hint auf `scroll(direction, amount)` mit korrekten Parametern

**Given** das LLM ruft evaluate mit `fetch()`/`XMLHttpRequest` plus Auth-Headern auf
**When** der Server den Call analysiert
**Then** erhaelt das LLM einen Auth-Guidance-Hint (Cookies fuer same-origin, Token-Discovery)

**Given** die Extended Tools (handle_dialog, network_monitor, console_logs)
**When** ihre Descriptions geladen werden
**Then** enthalten sie Negativ-Abgrenzung ("wann NICHT evaluate nutzen")

**Given** die MCP Server Instructions
**When** der Server sie ausliefert
**Then** erwaehnen sie die Extended Tools mit Use-Case-Hinweisen

### Story 6.2: Pro DOM-Diff fuer type und fill_form ⏳ DEFERRED post-v1.0

As a LLM-Agent,
I want nach type/fill_form-Aufrufen im Pro-Modus einen DOM-Diff erhalten (wie bei click),
So that ich nicht extra view_page aufrufen muss um die Auswirkungen zu sehen.

**Acceptance Criteria:**

**Given** Pro-Lizenz aktiv und der Agent tippt in ein Suchfeld
**When** type("suchbegriff") ausgefuehrt wird
**Then** erhaelt die Response einen piggybacked DOM-Diff (analog zum Click-Diff)

**Given** Pro-Lizenz aktiv und der Agent fuellt ein Formular aus
**When** fill_form ausgefuehrt wird
**Then** erhaelt die Response einen piggybacked DOM-Diff

**Given** Free-Tier (kein Pro)
**When** type/fill_form ausgefuehrt wird
**Then** bleibt das Verhalten unveraendert (Free Default-Hook greift)

## Epic 7: Distribution & Licensing

Alle 4 FRs (FR30-FR33) sind vollstaendig implementiert und getestet. Keine neuen Stories noetig fuer v1.0.

## Epic 8: Documentation & v1.0 Release

Alles was v1.0 versandfertig macht. Keine direkten FRs — adressiert Additional Requirements, NFR11 und NFR12.

### Story 8.1: README mit Getting-Started und Tool-Uebersicht ✅ DONE

As a Developer der SilbercueChrome zum ersten Mal sieht,
I want eine klare README mit Installationsanleitung, Tool-Uebersicht und erstem Beispiel,
So that ich in unter 2 Minuten loslegen kann.

**Acceptance Criteria:**

**Given** ein Developer oeffnet das GitHub-Repository
**When** er die README liest
**Then** findet er: Einzeiler-Installation (`npx @silbercue/chrome@latest`), MCP-Config-Beispiel fuer Claude Code/Cursor/Cline, Tool-Tabelle (Free vs Pro), und ein konkretes Beispiel-Prompt

**Given** BUG-003 (WebSocket Accept Mismatch)
**When** der Developer die README liest
**Then** findet er unter "Known Issues" eine Erklaerung und den Hinweis dass Auto-Launch nicht betroffen ist

**Given** die Benchmark-Ergebnisse
**When** der Developer die README liest
**Then** findet er eine Vergleichstabelle (SilbercueChrome vs Playwright MCP vs browser-use) mit Quellenangabe

### Story 8.2: v1.0 Release-Checkliste und Version-Bump ✅ DONE

As a Maintainer,
I want eine geprueft Release-Checkliste abarbeiten,
So that v1.0 stabil, vollstaendig und oeffentlich vertretbar ist.

**Acceptance Criteria:**

**Given** alle vorherigen Epics und Stories sind abgeschlossen
**When** die Release-Checkliste geprueft wird
**Then** sind erfuellt: Benchmark 35/35, npm test bestanden, Token-Overhead <5.000, Zero-Config funktioniert auf macOS und Linux, Free/Pro-Schnitt stabil

**Given** die Checkliste ist bestanden
**When** der Release ausgefuehrt wird
**Then** wird Version auf 1.0.0 gebumpt, npm publish + GitHub Release erstellt, CHANGELOG aktualisiert

### Story 8.3: MCP Server Instructions Audit ✅ DONE

As a LLM-Agent der SilbercueChrome nutzt,
I want praezise Server Instructions die mich zum optimalen Tool-Einsatz fuehren,
So that ich ohne Trial-and-Error die richtigen Tools in der richtigen Reihenfolge waehle.

**Acceptance Criteria:**

**Given** die MCP Server Instructions (prompt.md)
**When** ein LLM-Client die Tool-Liste laedt
**Then** beschreiben die Instructions den empfohlenen Workflow (view_page → interact → verify), erwaehnen run_plan als Batch-Option, und warnen vor den haeufigsten Anti-Patterns

**Given** Tool-Renames (read_page → view_page, screenshot → capture_image)
**When** die Instructions geladen werden
**Then** verwenden sie konsistent die neuen Namen ohne Referenz auf alte Namen

## Epic 9: Script API (Python) — Shared Core

Python-Client-Library fuer deterministische Browser-Automation. Scripts nutzen intern dieselben Tool-Implementierungen wie der MCP-Server (Shared Core) — jede Verbesserung an click, navigate, fill etc. kommt Scripts automatisch zugute. Kein Konkurrent bietet diesen Ansatz (Marktanalyse: `docs/research/script-api-shared-core.md`).

**v1 (Stories 9.1-9.6): DONE** — Separate CDP-Implementierung, v1.0.0 released. Basis (--script Mode, Tab-Isolation) wird weiterverwendet.
**v2 (Stories 9.7-9.11): Shared Core** — Python routet Tool-Calls durch den SilbercueChrome-Server.

---

### v1 Stories (DONE — v1.0.0 released)

### Story 9.1: --script CLI-Mode (Server-Seite) ✅ DONE

As a Developer der SilbercueChrome mit --script starten will,
I want dass der MCP-Server MCP-seitige Guards lockert damit externe CDP-Clients Tabs erstellen koennen ohne den MCP-Betrieb zu stoeren,
So that Python-Skripte sich parallel zum MCP-Server auf den bereits offenen Port 9222 verbinden koennen.

**Acceptance Criteria:**

**Given** der MCP-Server wird mit `--script` Flag gestartet
**When** ein externer CDP-Client (z.B. Python websockets) sich auf Port 9222 verbindet und `Target.createTarget` aufruft
**Then** ignoriert der MCP-Server den neuen Tab (kein Cleanup, kein navigate-Block, kein Tab-Tracking fuer fremde Tabs)

**Given** der MCP-Server laeuft mit `--script` und ein externer Client hat einen Tab erstellt
**When** der MCP-Server Tools wie navigate oder switch_tab ausfuehrt
**Then** operieren diese ausschliesslich auf MCP-eigenen Tabs — Script-Tabs werden nicht angefasst

**Given** der MCP-Server laeuft OHNE `--script`
**When** ein externer CDP-Client einen Tab via Target.createTarget erstellt
**Then** kann der MCP-Server diesen Tab als unbekannt behandeln oder in sein Tab-Tracking aufnehmen (Default-Verhalten, keine Garantie fuer Script-Kompatibilitaet)

**Technical Notes:**
- **Port 9222 ist IMMER offen:** Chrome wird bereits mit `--remote-debugging-port=9222` gelauncht (`src/cdp/chrome-launcher.ts:142-157`). `--attach` und der interne CDP-Client nutzen diesen Port ebenfalls. Das `--script` Flag oeffnet KEINEN Port — es signalisiert dem MCP-Server nur, dass externe Clients erwartet werden.
- **CLI-Parsing analog zu --attach:** In `src/index.ts:85-98` wird `--attach` per `process.argv.includes("--attach")` geparst und vor dem CLI-Dispatch gefiltert. `--script` muss auf demselben Weg implementiert werden — NICHT in `src/cli/top-level-commands.ts` (das behandelt nur Subcommands wie version/status/help).
- **Externe CDP-Calls (Target.createTarget via Port 9222) gehen am MCP-Layer komplett vorbei** — sie laufen nicht durch registry.ts, nicht durch switch-tab.ts und nicht durch den Tab-Switch-Mutex. Diese Guards schuetzen MCP-internes switch_tab vor Parallel-Races und muessen NICHT gelockert werden.
- **Was tatsaechlich angepasst werden muss:**
  - `src/cdp/browser-session.ts` — Tab-Tracking (TabStateCache, Target-Discovery): Extern erstellte Tabs duerfen nicht ins MCP-Tab-Tracking aufgenommen werden. Kriterium: Tab nicht ueber MCP-switch_tab geoeffnet → ignorieren. Die "owned tab"-Lifecycle (`browser-session.ts:355-377`) darf extern erstellte Tabs nicht schliessen.
  - `src/registry.ts:1412-1437` — navigate-Blocker der auf virtual_desk wartet: Darf nicht blockieren weil ein externer Client einen Tab erstellt hat. Der Blocker prueft aktuell nur MCP-Tabs — muss verifiziert werden ob extern erstellte Tabs den Check triggern.
  - `src/tools/switch-tab.ts` — Das MCP-switch_tab darf NICHT auf Script-Tabs wechseln. Tab-Liste filtern.
- **NICHT anfassen:** switch_tab-Mutex (`switch-tab.ts:55-68`) und registry.ts Parallel-Block (`1815-1822`) — diese schuetzen MCP-interne Races und sind von externen CDP-Calls nicht betroffen.
- **Kein neues File `src/cli/script-mode.ts` noetig** — das Flag wird in index.ts geparst und als Option an startServer() durchgereicht, analog zu attachMode.

### Story 9.2: Python CDP Client (cdp.py) ✅ DONE

As a Python-Developer,
I want einen minimalen CDP-Client der ueber WebSocket mit Chrome kommuniziert,
So that ich die Grundlage fuer die Script API habe.

**Acceptance Criteria:**

**Given** Chrome laeuft mit offenem CDP-Port (9222)
**When** der Python CDP-Client `CdpClient.connect("localhost", 9222)` aufruft
**Then** wird eine WebSocket-Verbindung hergestellt und CDP-Commands koennen gesendet werden

**Given** eine aktive CDP-Verbindung
**When** `client.send("Runtime.evaluate", {"expression": "1+1"})` aufgerufen wird
**Then** kommt `{"result": {"type": "number", "value": 2}}` zurueck

**Given** eine aktive CDP-Verbindung
**When** `client.send("Target.createTarget", {"url": "about:blank"})` aufgerufen wird
**Then** wird ein neuer Tab erstellt und die targetId zurueckgegeben

**Technical Notes:**
- Datei: `python/silbercuechrome/cdp.py`
- Einzige Dependency: `websockets` (async WebSocket Library)
- CDP-Protokoll: JSON-RPC ueber WebSocket. Request: `{"id": N, "method": "...", "params": {...}}`. Response matcht per `id`.
- Target-Discovery: `GET http://localhost:9222/json/version` fuer Browser-WebSocket-URL, dann `Target.createTarget` fuer neue Tabs.
- Async: Python `asyncio` intern, aber die Public API (Chrome, Page) soll synchron sein (asyncio.run() wrapping).
- **Python-Projekt-Konventionen (das Verzeichnis python/ existiert noch nicht, muss von Grund auf aufgebaut werden):**
  - Packaging: `pyproject.toml` (PEP 621), KEIN setup.py
  - Tests: `python/tests/` mit pytest, analog zu Vitest im Node-Repo
  - Type Hints: PEP 484, `py.typed` Marker fuer Library-Consumers
  - Formatter: ruff (oder black), Linter: ruff
  - Minimale Python-Version: 3.10+ (fuer match/case und moderne type hints)
  - CI: pytest in bestehende GitHub Actions integrieren (neuer Job, nicht neues Workflow-File)

### Story 9.3: Chrome + Page API ✅ DONE

As a Python-Developer,
I want `Chrome.connect(port=9222)` und `chrome.new_page()` als einfache, synchrone API nutzen,
So that ich Browser-Automation-Skripte ohne Boilerplate schreiben kann.

**Acceptance Criteria:**

**Given** Chrome laeuft mit --script
**When** `Chrome.connect(port=9222)` aufgerufen wird
**Then** wird eine Verbindung hergestellt und ein Chrome-Objekt zurueckgegeben

**Given** eine Chrome-Verbindung
**When** `with chrome.new_page() as page:` als Context Manager verwendet wird
**Then** wird ein neuer Tab geoeffnet, und beim Verlassen des Context Managers wird der Tab automatisch geschlossen

**Given** ein Page-Objekt
**When** die Methoden navigate(url), click(selector), fill(fields), type(selector, text), wait_for(condition), evaluate(js), download() aufgerufen werden
**Then** fuehren sie die jeweilige Browser-Aktion ueber CDP aus und geben das Ergebnis zurueck

**Given** ein Page-Objekt in einem Script-Tab
**When** das Script Aktionen ausfuehrt
**Then** bleiben MCP-Tabs komplett unberuehrt (Tab-Isolation)

**Technical Notes:**
- Dateien: `python/silbercuechrome/chrome.py`, `python/silbercuechrome/page.py`, `python/silbercuechrome/__init__.py`
- Chrome.connect(): HTTP GET auf `/json/version`, dann WebSocket-Verbindung zum Browser
- chrome.new_page(): `Target.createTarget` → neue CDP-Session → Page-Objekt
- Page-Methoden mappen auf CDP-Commands:
  - navigate(url) → `Page.navigate` + `Page.loadEventFired`
  - click(selector) → `Runtime.evaluate` (querySelector) + `Input.dispatchMouseEvent`
  - fill(fields) → Fuer jedes Feld: focus + `Input.dispatchKeyEvent` oder `DOM.setAttributeValue`
  - type(selector, text) → focus + `Input.dispatchKeyEvent` pro Zeichen
  - wait_for(condition) → Polling mit `Runtime.evaluate` oder CDP-Event-Listener
  - evaluate(js) → `Runtime.evaluate`
  - download() → `Browser.setDownloadBehavior` + Event-Tracking
- Synchrone API: Intern async (asyncio), extern synchron via `asyncio.run()` oder `loop.run_until_complete()`

### Story 9.4: CDP-Koexistenz-Test ✅ DONE

As a Maintainer,
I want einen Integrationstest der beweist dass MCP und Script API parallel funktionieren,
So that NFR19 (CDP-Koexistenz) verifiziert und vor Regressionen geschuetzt ist.

**Acceptance Criteria:**

**Given** der MCP-Server laeuft mit --script und ein LLM-Agent nutzt MCP-Tools
**When** gleichzeitig ein Python-Script per Script API Browser-Aktionen ausfuehrt
**Then** funktionieren beide fehlerfrei — kein Timeout, kein Crash, keine Interferenz

**Given** der MCP-Server hat einen aktiven Tab auf URL X
**When** ein Python-Script parallel einen neuen Tab oeffnet, navigiert und schliesst
**Then** bleibt die MCP-Tab-URL X unveraendert (binaerer Test)

**Given** ein Python-Script beendet sich (normal oder via Exception)
**When** der Context Manager `with chrome.new_page()` den Scope verlaesst
**Then** wird der Script-Tab geschlossen und der MCP-Server merkt nichts davon

**Technical Notes:**
- Test-Setup: MCP-Server mit --script starten, dann parallel MCP-Tool-Calls und Python-Script-Calls ausfuehren
- Verifikation: MCP-Tab-URL vor und nach Script-Execution vergleichen (muss identisch sein)
- Edge Case: Script-Crash (unhandled Exception) — Tab muss trotzdem geschlossen werden (Context-Manager __exit__)
- Kann als Vitest-Test (Node.js-Seite) und als pytest (Python-Seite) implementiert werden

### Story 9.5: pip Distribution ✅ DONE

As a Python-Developer,
I want `pip install silbercuechrome` ausfuehren und sofort loslegen koennen,
So that die Installation genauso einfach ist wie `npx @silbercue/chrome@latest` fuer MCP-User.

**Acceptance Criteria:**

**Given** ein Python-Developer fuehrt `pip install silbercuechrome` aus
**When** die Installation abgeschlossen ist
**Then** kann er `from silbercuechrome import Chrome` importieren und nutzen

**Given** ein Developer der keine pip-Installation will
**When** er die einzelne Datei `silbercuechrome.py` in sein Projekt kopiert
**Then** funktioniert die API identisch (websockets muss installiert sein)

**Given** die installierten Dependencies
**When** `pip show silbercuechrome` ausgefuehrt wird
**Then** ist `websockets` die einzige externe Abhaengigkeit

**Technical Notes:**
- `python/pyproject.toml`: Package-Metadata (name: silbercuechrome, version: 1.0.0, dependencies: [websockets])
- `python/silbercuechrome/__init__.py`: Re-export Chrome, Page
- Single-File-Alternative: Ein `silbercuechrome.py` das alle Klassen in einer Datei enthaelt (fuer Copy-Paste-Deployment)
- PyPI-Publish: `python -m build && twine upload dist/*` (oder GitHub Actions)
- Versioning: Python-Package-Version synchron mit npm-Package-Version halten

### Story 9.6: Script API Dokumentation ✅ DONE

As a Developer der die Script API entdeckt,
I want eine klare Dokumentation mit Installationsanleitung und Beispielen,
So that ich in unter 5 Minuten mein erstes Script schreiben kann.

**Acceptance Criteria:**

**Given** ein Developer oeffnet die README
**When** er den Script API Abschnitt liest
**Then** findet er: pip-Installation, ein vollstaendiges Beispiel-Script (Login + Daten extrahieren), Methodenliste, und den Hinweis auf --script Flag

**Given** ein Developer der die Script API parallel zum MCP nutzen will
**When** er die Dokumentation liest
**Then** versteht er: Chrome muss mit --script gestartet sein, jedes Script bekommt einen eigenen Tab, MCP-Betrieb wird nicht gestoert

**Given** die CHANGELOG
**When** v1.0 Release-Notes gelesen werden
**Then** ist die Script API als neues Feature aufgefuehrt

**Technical Notes:**
- README.md: Neuer Abschnitt "Script API (Python)" nach dem MCP-Abschnitt
- Beispiel-Script: Das Tomek-Beispiel aus der PRD (Journey 5) adaptieren
- CHANGELOG.md: Script API unter "Added" eintragen
- Hinweis auf --script Flag im MCP-Config-Abschnitt

---

### v2 Stories (Shared Core — Scripts nutzen MCP-Tool-Implementierungen)

### Story 9.7: Script API Gateway (Server-Seite)

As a Python-Script,
I want Tool-Calls an den laufenden SilbercueChrome-Server senden,
So that ich dieselben Implementierungen wie der MCP-Pfad nutze (Shared Core).

**Acceptance Criteria:**

**Given** der SilbercueChrome-Server laeuft mit `--script`
**When** ein Python-Script einen HTTP-Request `POST /tool/click {"selector": "#login"}` an `localhost:9223` sendet
**Then** fuehrt der Server die click-Tool-Implementierung aus und gibt das Ergebnis als JSON zurueck

**Given** der Server laeuft mit `--script`
**When** ein Python-Script `POST /tool/view_page` sendet
**Then** erhaelt es denselben A11y-Tree wie ein MCP-Client — gleicher Code-Pfad, gleiche Refs

**Given** der Server laeuft OHNE `--script`
**When** ein HTTP-Request auf Port 9223 eingeht
**Then** antwortet der Server nicht (Port nicht geoeffnet)

**Technical Notes:**
- **Kommunikationskanal:** Lokaler HTTP-Server auf Port 9223 (konfigurierbar). Wird nur gestartet wenn `--script` Flag gesetzt ist. Kein WebSocket noetig — Request-Response reicht fuer synchrone Tool-Calls.
- **Warum HTTP statt Subprocess-stdio:** Mehrere Python-Scripts koennen gleichzeitig verbinden. MCP ueber stdio und Script API ueber HTTP laufen parallel. Kein Konflikt.
- **Warum Port 9223:** 9222 ist CDP (Chrome), 9223 ist Script API (Server). Einfach zu merken, kein Konflikt.
- **Routing:** HTTP-Handler mappt Tool-Namen auf die bestehenden Tool-Handler in `src/tools/`. Gleicher Code-Pfad wie `registry.ts` → Tool-Handler. Kein Wrapper, kein Adapter — direkter Aufruf.
- **Kanonisches Session-/Tab-Lifecycle-Modell:**
  1. `POST /session/create` → Server ruft intern `Target.createTarget` auf (direkt ueber CDP, NICHT ueber switch_tab-Tool), gibt `session_token` zurueck
  2. Alle Tool-Calls enthalten `X-Session: {session_token}` Header → Server routet auf den richtigen Tab
  3. `POST /session/close` → Server ruft `Target.closeTarget` auf, raeumt Session auf
  4. Bei Verbindungsabbruch (Python-Prozess stirbt): Server erkennt verwaiste Sessions nach Timeout (30s) und schliesst deren Tabs
  5. Pro-Gating: Tab-Management im Gateway nutzt CDP direkt (`Target.createTarget/closeTarget`), NICHT das Pro-gated switch_tab-Tool. Die Script API ist damit Free-Tier-kompatibel.
- **Bestehende Dateien:** `src/server.ts` erweitern (HTTP-Server starten wenn scriptMode), neues File `src/transport/script-api-server.ts` fuer HTTP-Handling.
- **NICHT anfassen:** Tool-Implementierungen in `src/tools/` bleiben unveraendert. Das Gateway ruft sie auf, aendert sie nicht. switch_tab-Mutex und registry Parallel-Block bleiben unberuehrt.
- **OFFENE SPEC-FRAGEN (bei Story-Erstellung klaeren):**
  - Orphan-Timeout: 30s reicht? Heartbeat/Lease-Refresh noetig fuer lange idle Sessions?
  - Response-Vertrag: HTTP-Response-Format definieren — was gibt `/tool/click` zurueck? Raw MCP-Envelope oder bereinigte Werte?
  - `/session/create` Response: Neben `session_token` auch `cdp_ws_url` und `cdp_session_id` mitliefern (fuer Escape Hatch in Story 9.9)

### Story 9.8: Python Library v2 — Shared Core Client

As a Python-Developer,
I want `Chrome.connect()` aufrufen und die gleiche API wie v1 nutzen, aber mit der Gewissheit dass meine Klicks und Navigationen dieselbe Qualitaet haben wie die des MCP-Servers,
So that jede Server-Verbesserung automatisch auch meinen Scripts zugutekommt.

**Acceptance Criteria:**

**Given** der SilbercueChrome-Server ist NICHT gestartet
**When** `Chrome.connect()` aufgerufen wird
**Then** startet Chrome.connect() den Server automatisch als Subprocess (mit `--script` Flag), wartet bis Port 9223 antwortet, und gibt ein Chrome-Objekt zurueck

**Given** der SilbercueChrome-Server laeuft bereits (z.B. weil MCP aktiv ist)
**When** `Chrome.connect()` aufgerufen wird
**Then** verbindet es sich zum bestehenden Server auf Port 9223 (kein zweiter Server-Prozess)

**Given** ein Page-Objekt
**When** `page.click("#login")` aufgerufen wird
**Then** sendet die Library `POST /tool/click {"selector": "#login"}` an den Server, der die MCP-Click-Implementierung ausfuehrt (Shadow DOM, Scroll-into-View, Paint-Order etc.)

**Given** die v1 API-Oberflaeche
**When** v2 installiert wird
**Then** bleiben alle Methodensignaturen identisch: `navigate(url)`, `click(selector)`, `fill(fields)`, `type(selector, text)`, `wait_for(condition)`, `evaluate(js)`, `download()`

**Technical Notes:**
- **Auto-Start:** `Chrome.connect()` prueft ob Port 9223 erreichbar ist. Falls nein: `subprocess.Popen(["silbercuechrome", "--script"])` oder `subprocess.Popen(["npx", "-y", "@silbercue/chrome@latest", "--", "--script"])`. Wartet max. 10s auf Port-Readiness.
- **Server-Discovery:** Reihenfolge: (1) `silbercuechrome` im PATH (Homebrew), (2) `npx @silbercue/chrome@latest`, (3) expliziter Pfad via `Chrome.connect(server_path="...")`.
- **Interner Umbau:** `page.py` Methoden ersetzen CDP-Calls durch HTTP-Calls an `/tool/{tool_name}`. `cdp.py` wird fuer den Hauptpfad nicht mehr gebraucht — bleibt als Escape-Hatch (`page.cdp.send()`).
- **Selector-zu-Ref-Mapping:** Der Server's click-Tool akzeptiert bereits CSS-Selektoren und sichtbaren Text neben Refs (`src/tools/click.ts` resolved Selektoren intern). Kein Adapter noetig auf Python-Seite.
- **Context Manager nutzt Session-API:** `with chrome.new_page() as page:` ruft `POST /session/create` auf (Tab-Erstellung via CDP direkt, NICHT via Pro-gated switch_tab-Tool), schliesst via `POST /session/close` bei Exit. Script API ist damit Free-Tier-kompatibel.
- **OFFENE SPEC-FRAGEN (bei Story-Erstellung klaeren):**
  - Python-API-Vertrag: Was gibt `page.click()` zurueck? (None + Exception bei Fehler, oder Result-Objekt?) Was gibt `page.evaluate()` zurueck? (Den JS-Wert direkt, oder ein Wrapper-Objekt?)
  - Koexistenz-Fall: Was passiert wenn MCP OHNE `--script` laeuft und `Chrome.connect()` aufgerufen wird? (Empfehlung: eigenen Server spawnen mit --script, oder Fehler mit Hinweis "starte MCP mit --script")

### Story 9.9: Escape Hatch & CDP-Direktzugriff

As a Power-User,
I want bei Bedarf CDP-Befehle direkt an Chrome senden koennen, auch wenn ich die Shared-Core-API nutze,
So that ich nicht eingeschraenkt bin wenn ein MCP-Tool meinen Spezialfall nicht abdeckt.

**Acceptance Criteria:**

**Given** ein Page-Objekt im Shared-Core-Modus
**When** `page.cdp.send("Network.enable")` aufgerufen wird
**Then** wird der CDP-Befehl direkt an Chrome gesendet (nicht ueber den Tool-Handler), und das Ergebnis zurueckgegeben

**Given** ein Escape-Hatch-Call
**When** der CDP-Befehl den Tab-State veraendert (z.B. Navigation)
**Then** bleibt die Tab-Isolation intakt — der Call geht nur an den Script-eigenen Tab

**Technical Notes:**
- **Architektur:** Der v1 CdpClient (`python/silbercuechrome/cdp.py`) bleibt als Escape-Hatch erhalten. `page.cdp` exponiert `send(method, params)` fuer direkten CDP-Zugriff.
- **Session-Routing:** Escape-Hatch-Calls gehen ueber die CDP-WebSocket-Verbindung (Port 9222), nicht ueber den HTTP-Kanal (Port 9223). Die Session-ID des Script-Tabs wird mitgegeben.
- **Wann relevant:** Network-Interception, Console-Log-Subscription, Custom-DOM-Mutationen, Performance-Tracing — alles was kein Standard-Tool abdeckt.

### Story 9.10: Shared Core Integration Tests

As a Maintainer,
I want automatisierte Tests die beweisen dass Python-Scripts denselben Code-Pfad wie MCP-Tools nutzen,
So that die Shared-Core-Architektur vor Regressionen geschuetzt ist.

**Acceptance Criteria:**

**Given** der Server laeuft mit `--script` und ein Python-Script ruft `page.click("#btn")` auf
**When** der Server den Click ausfuehrt
**Then** laeuft derselbe `clickHandler` in `src/tools/click.ts` wie bei einem MCP-Call (verifiziert durch Logging oder Instrumentation)

**Given** der MCP-Click wird verbessert (z.B. besseres Shadow-DOM-Handling)
**When** ein Python-Script `page.click()` aufruft
**Then** profitiert es automatisch von der Verbesserung (kein separater Fix noetig)

**Given** ein Python-Script ruft jede der 7 Tool-Methoden auf: navigate, click, fill, type, wait_for, evaluate, download
**When** der Server die Calls verarbeitet
**Then** laeuft fuer jede Methode der entsprechende MCP-Tool-Handler (navigateHandler, clickHandler, fillFormHandler, typeHandler, waitForHandler, evaluateHandler, downloadHandler) — verifiziert per Test

**Given** kein laufender Server
**When** ein Python-Script `Chrome.connect()` aufruft
**Then** startet der Server automatisch, Chrome wird gelauncht, und der erste Tool-Call funktioniert innerhalb von 10 Sekunden

**Technical Notes:**
- **Vitest (Node.js-Seite):** Tests in `src/transport/script-api-server.test.ts` — HTTP-Routing, Tool-Dispatch, Tab-Session-Management.
- **pytest (Python-Seite):** Tests in `python/tests/test_shared_core.py` — Auto-Start, Tool-Call-Roundtrip, API-Paritaet (v1 vs v2 Ergebnisse vergleichen), Escape-Hatch.
- **Regressionsschutz:** Test der explizit prueft dass `page.click()` den Server-seitigen clickHandler aufruft, nicht eigenen CDP-Code. Kann ueber einen Debug-Header im HTTP-Response verifiziert werden.
- **Koexistenz-Matrix (erweitert gegenueber v1 Story 9.4):**
  - MCP + Shared-Core-Script gleichzeitig (Tab-Isolation)
  - Mehrere Python-Scripts gleichzeitig am selben Server (separate Sessions)
  - Shared-Core-Script + Escape-Hatch-Call im selben Script (Ref-Konsistenz)
  - Abnormaler Python-Prozess-Abbruch (Server raeumt verwaiste Session nach Timeout auf)
- **Skip-Guards:** Integrationstests brauchen Chrome — `@pytest.mark.integration` und `describe.skipIf` analog zu Story 9.4.

### Story 9.11: Script API v2 Dokumentation

As a Developer,
I want die Dokumentation spiegelt die neue Shared-Core-Architektur wider,
So that ich verstehe dass meine Scripts von Server-Verbesserungen profitieren und wie Auto-Start funktioniert.

**Acceptance Criteria:**

**Given** ein Developer liest die README
**When** er den Script API Abschnitt findet
**Then** steht dort: "Scripts nutzen dieselben Tool-Implementierungen wie der MCP-Server — jede Verbesserung kommt automatisch auch Scripts zugute."

**Given** ein Developer will die Script API nutzen
**When** er die Installationsanleitung liest
**Then** steht dort: `pip install silbercuechrome` genuegt — `Chrome.connect()` startet den Server automatisch

**Given** ein Developer will verstehen wie es intern funktioniert
**When** er die Architektur-Beschreibung liest
**Then** findet er das Data-Flow-Diagramm: `Python Script → Server → Tool Handler → CDP → Chrome`

**Technical Notes:**
- **README.md (Root):** Script API Abschnitt aktualisieren — Shared Core hervorheben, Auto-Start erwaehnen, neues Data-Flow-Diagramm.
- **python/README.md:** Komplett ueberarbeiten — keine Erwaehnung von "direktem CDP", stattdessen "nutzt den SilbercueChrome-Server intern".
- **CHANGELOG.md:** v1.1 (oder v2.0) Eintrag fuer Shared Core Umbau.
- **Escape-Hatch:** `page.cdp.send()` in der Doku erwaehnen als Fallback fuer Power-User.

## Epic 10: Vision-Hybrid POC (Gate vor Kategorie-A-Fixes)

Zeitgeboxtes Spike-Epic mit genau einer Story. Pruefen, ob ein Hybrid-Vision-Ansatz (Screenshot + DOM-Refs analog SoM) die Kategorie-A-Frictions strukturell loest. Ergebnis entscheidet, ob Kategorie-A-Friction-Fixes weiter einzeln nachgejagt werden oder ob ein Hybrid-Layer ins Produkt kommt.
**FRs covered:** Keine neuen FRs in diesem Epic — der POC nutzt bestehende Tools. Neue FRs (z.B. FR40 capture_som) folgen erst bei Erfolg in einem Folge-Epic via bmad-create-epics-and-stories.

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
