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

Der Server fuehrt das LLM aktiv zum richtigen Tool. FR26-FR29 sind implementiert. FR25 (Anti-Pattern-Detection) ist mitigiert (BUG-018) — Story 23.1 bringt v2 mit drei neuen Patterns. FR-040 (Pro DOM-Diff Scope-Gate fuer type/fill_form) ist deferred. Hauptsaechliche neue Arbeit fuer v1.0.

### Story 6.1: Evaluate Anti-Spiral v2 — Situational Tool Steering

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

### Story 6.2: Pro DOM-Diff fuer type und fill_form

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

### Story 8.2: v1.0 Release-Checkliste und Version-Bump

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

### Story 8.3: MCP Server Instructions Audit

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
