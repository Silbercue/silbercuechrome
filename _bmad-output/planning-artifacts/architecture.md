---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
lastStep: 8
status: 'complete'
completedAt: '2026-04-03'
inputDocuments:
  - "prd.md"
  - "prd-validation-report.md"
  - "product-brief-SilbercueChrome.md"
  - "product-brief-SilbercueChrome-distillate.md"
  - "benchmark-analysis.md"
workflowType: 'architecture'
project_name: 'SilbercueChrome'
user_name: 'Julian'
date: '2026-04-03'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
69 FRs in 14 Kategorien, aufgeteilt in 5 Phasen:
- **MVP (FR1-FR34):** 34 FRs — Browser-Verbindung & Lifecycle (5), Seitennavigation & Warten (5), Element-Interaktion (5), Seiteninhalte lesen (4), JavaScript-Ausfuehrung (2), State-Management & Caching (3), VirtualDesk (3), Batch-Execution (3), Tab-Management (1), Token-Optimierung & DX (3)
- **Growth (FR35-FR46):** 12 FRs — Erweitertes run_plan (2), Observability (3), Session-Management (2), Erweiterte Interaktion (3), Multi-Tab (1), Precomputed A11y (1)
- **Vision (FR47-FR51):** 5 FRs — Operator-Architektur (3), Chrome-Profil & Human Touch (2)
- **Post-MVP Visual Intelligence (FR52-FR62):** 11 FRs — Emulation-Override (3), DOMSnapshot (2), read_page Visual (1), Parallele CDP (1), DOM-Downsampling (1), Set-of-Mark (1), isClickable (1), Selector-Caching (1)
- **MVP-Infrastruktur (FR63-FR69):** 7 FRs — Monetarisierung/Lizenzierung (5), DOM-Snapshot Pro (1), Publish-Pipeline (1)

Die architektonische Implikation: Der MVP allein hat 34 FRs, die in einen kohaerenten MCP-Server mit 12 Tools muenden muessen. Die Phasen-Struktur erfordert eine erweiterbare Architektur, die Post-MVP-Features ohne Umbauten aufnehmen kann.

**Non-Functional Requirements:**
24 NFRs in 4 Kategorien:
- **Performance (NFR1-NFR8):** Benchmark <30s (validiert: 14.9s scripted, 21s LLM), CDP-Latenz <5ms, Tool-Overhead <5k Tokens, Cold-Start <3s
- **Zuverlaessigkeit (NFR9-NFR14):** 24/24 Tests, Null Abbrueche, Auto-Reconnect <3s, Ref-Stabilitaet
- **Sicherheit (NFR15-NFR18):** Lokale Kommunikation, keine Default-Credential-Extraktion, License-Key-Validierung (Phase 3)
- **Integration (NFR19-NFR24):** Alle MCP-Clients, Chrome 136+, Node.js 18+, Cross-Platform, CI-Pipeline

Architektonisch dominant: NFR8 (run_plan = 1 Roundtrip) und NFR10 (Null Abbrueche) — diese beiden treiben die meisten Architekturentscheidungen.

**Scale & Complexity:**
- Primary Domain: Backend/Infrastructure (Node.js MCP-Server)
- Complexity Level: Medium-High
- Geschaetzte architektonische Kernkomponenten: ~8-10 (Transport, CDP-Client, Session-Manager, TabStateCache, A11y-Tree-Processor, PlanExecutor, ToolRegistry, License-Manager, OOPIF-Handler, Chrome-Launcher)

### Architekturprinzip: Von innen nach aussen

Die Architektur folgt einem Schichten-Modell mit klarer Abhaengigkeitsrichtung. Jede Schicht ist unabhaengig testbar:

```
Schicht 4: run_plan (Batch-Execution)
Schicht 3: Tools (navigate, click, type, screenshot, read_page, evaluate, ...)
Schicht 2: TabStateCache + A11y-Tree-Processor
Schicht 1: CDP-Client + Transport (Pipe/WebSocket)
```

Der erste funktionsfaehige Meilenstein ist der innerste Kern: CDP-Verbindung + `evaluate` + `navigate` + `read_page`. Erst wenn diese 3-4 Tools rock-solid laufen, kommen die naechsten Schichten.

### Zwei gleichwertige Ausfuehrungspfade

- **`evaluate` als Power-Pfad:** Beliebiges JavaScript, Multi-Operation-Batching, 100x schneller bei trivialen DOM-Operationen. Der Star der Benchmarks.
- **Dedizierte CDP-Tools als semantischer Pfad:** `navigate` (Settle), `click` (Wait-after-Click + Ref-Aufloesung), `read_page` (Progressive A11y-Tree via CDP), `screenshot` (WebP-Komprimierung via CDP), `wait_for` (Hydration/Network-Monitoring). Diese liefern CDP-Superkraefte, die JS allein nicht hat.

Beide Pfade sind architektonisch gleichwertig — keine Hierarchie, sondern komplementaere Staerken.

### Technical Constraints & Dependencies

- **CDP-Protokoll:** Googles internes Protokoll — kein stabiler API-Vertrag. Breaking Changes bei Chrome-Updates moeglich. **Bewusst akzeptiertes Risiko** — kein Abstraktions-Layer darueber. Mitigation: Versionspinning, CI-Pipeline bei Chrome-Updates, Mindestsupport-Version (Chrome 136+).
- **TypeScript/Node.js:** Durch MCP-Oekosystem vorgegeben.
- **stdio Transport:** MCP-Standard. JSON-RPC zwischen Client und Server.
- **Kein Abstraktions-Layer:** Bewusste Entscheidung gegen Playwright/puppeteer-core. Volle CDP-Verantwortung.
- **Chrome 136+ Constraint:** `--user-data-dir` Pflicht fuer Remote-Debugging. Beeinflusst Auto-Launch-Logik.
- **Einzelentwickler:** Julian, Teilzeit. Architektur muss iterativen Aufbau von innen nach aussen unterstuetzen.
- **SilbercueSwift als Pattern-Quelle:** Validierte Patterns (TabStateCache, Element-Refs, PlanExecutor, Two-Path-Execution) muessen auf Browser-Kontext adaptiert werden.

### Cross-Cutting Concerns (nach Risiko geordnet)

1. **Transport-Abstraktion (hohes Risiko):** CDP-Pipe und WebSocket muessen hinter einer einheitlichen Schnittstelle stehen. Wenn das wackelt, wackelt alles.
2. **OOPIF-Handling (hohes Risiko):** Cross-Origin iFrames erfordern separate CDP-Sessions. Session-Multiplexing ist komplex und fragil.
3. **Error-Handling & Recovery (mittleres Risiko):** Auto-Reconnect, Graceful Degradation, State-Recovery — durchzieht alle Komponenten.
4. **Caching & Invalidierung (mittleres Risiko):** TabStateCache mit TTLs, Invalidierung bei Navigation/DOM-Aenderungen/Tab-Wechsel — muss konsistent ueber alle Tools funktionieren.
5. **Token-Budgetierung (niedriges Risiko):** Architektur-Constraint, kein isoliertes Feature. Tool-Schemas, Responses, A11y-Tree, Screenshots — alles token-bewusst.
6. **Free/Pro Feature-Gates (niedriges Risiko):** Hook-System analog SilbercueSwift — Pro-Features klinken sich als optionale Beschleuniger ein. Kein if/else im Code, sondern erweiterbare Hooks. Muss von Tag 1 in der Repo-Struktur angelegt sein.

## Starter Template Evaluation

### Primary Technology Domain

Backend/Infrastructure — Node.js MCP-Server mit direkter CDP-Integration. Kein Web-Frontend, keine Datenbank, kein eigener Server. License-Key-Validierung erfolgt direkt gegen die Polar.sh Public API (`/v1/customer-portal/license-keys/validate`) — analog zu SilbercueSwift.

### Starter Options Considered

| Option | Bewertung |
|--------|-----------|
| `@modelcontextprotocol/create-server` (offiziell) | Zu flach — einzelne `src/index.ts`, keine Schichten-Struktur. Muesste komplett umgebaut werden. |
| Community-Starters (kirbah, MatthewDailey) | Zu viel vom Falschen — DI-Framework, Express-Server. Overhead fuer 12-Tool-Solo-Projekt. |
| **Custom Setup (gewaehlt)** | Passgenau fuer Schichten-Architektur, Pro/Free-Hooks, CDP-Integration. |

### Selected Starter: Custom TypeScript Setup

**Rationale:** SilbercueChrome ist kein generischer MCP-Server. Die Schichten-Architektur (CDP → Cache → Tools → Plans), das Pro/Free-Hook-System und die direkte CDP-Integration erfordern eine massgeschneiderte Projektstruktur. Fertige Vorlagen passen nicht — zu simpel oder zu ueberladen.

**Initialisierung:**

```bash
mkdir silbercuechrome && cd silbercuechrome
npm init -y
npm install @modelcontextprotocol/sdk@^1.29.0 zod@^3
npm install -D typescript@^5.7 @types/node vitest eslint prettier
```

**Architektonische Entscheidungen:**

**Language & Runtime:**
- TypeScript 5.7+ mit striktem Modus
- Node.js 22+ (eingebautes Type-Stripping fuer Development, kein Build-Step noetig)
- Node.js 18+ als Mindestanforderung fuer Distribution (NFR21)
- ES2022 Target, Node16 Module Resolution

**Build Tooling:**
- `tsc` fuer Production-Build → `build/`
- Node.js Type-Stripping fuer Development (instant reload)
- `bin` Entry in package.json → `build/index.js`

**Testing:**
- Vitest (schnell, TypeScript-native, kein separater Build)

**Code Quality:**
- ESLint + Prettier

**Projektstruktur (spiegelt Schichten-Architektur):**

```
src/
  transport/     ← Schicht 1: CDP-Pipe + WebSocket Abstraktion
  cdp/           ← Schicht 1: CDP-Client, Session-Manager, OOPIF
  cache/         ← Schicht 2: TabStateCache, A11y-Tree-Processor
  tools/         ← Schicht 3: navigate, click, type, evaluate, ...
  plan/          ← Schicht 4: run_plan Executor
  server.ts      ← MCP Server Setup + ToolRegistry
  index.ts       ← Entry Point (stdio Transport)
```

**Note:** Projekt-Initialisierung mit diesem Setup sollte die erste Implementation-Story sein.

## Core Architectural Decisions

### Decision Priority Analysis

**Kritische Entscheidungen (blockieren Implementierung):**
1. CDP-Client komplett selber bauen (kein ws-Paket, kein chrome-remote-interface)
2. Zwei separate Repos (Free Open Source + Pro privat)
3. Intelligente Chrome-Launch-Strategie (erst verbinden, dann starten)

**Wichtige Entscheidungen (formen Architektur):**
4. Testing: Unit-Tests + Benchmark-Suite als Integration (kein separater Integration-Layer)
5. Error-Handling: Sofort reconnecten, laufende Calls failen, ehrliche Fehlermeldungen
6. A11y-Refs: Durchnummeriert mit Stabilitaetsgarantie (bestehende Refs aendern sich nicht bei DOM-Updates)

**Aufgeschobene Entscheidungen (Post-MVP):**
- Pro-Hook-System: Konkretes Design erst wenn Free-Tier steht
- License-Key-Validierung: Phase 3
- Operator-Architektur: Phase 3

### CDP Client & Transport

- **Entscheidung:** Eigener CDP-Client von Grund auf, inklusive WebSocket-Handling
- **Rationale:** Maximale Kontrolle, keine Dependency, konsistent mit "kein Abstraktions-Layer"-Philosophie
- **Betrifft:** Schicht 1 (Transport + CDP-Client)

### Repo-Struktur

- **Entscheidung:** Zwei separate Repos — `silbercuechrome` (Open Source) + `silbercuechrome-pro` (privat)
- **Rationale:** Klare Trennung zwischen Free und Pro, wie bei SilbercueSwift
- **Betrifft:** Gesamte Projektstruktur, CI/CD, Distribution

### Chrome-Launch

- **Entscheidung:** Erst verbinden (WebSocket auf 9222), dann Auto-Launch als Child-Prozess (CDP-Pipe)
- **Rationale:** Zero-Config fuer Erstnutzer, aber laufendes Chrome wird respektiert. Konfigurierbar via `autoLaunch`
- **Betrifft:** Schicht 1 (Transport), Entry Point

### Testing

- **Entscheidung:** Unit-Tests pro Schicht + 24-Test-Benchmark-Suite als End-to-End-Validierung
- **Rationale:** Pragmatisch fuer Einzelentwickler. Kein separater Integration-Layer — die Benchmark-Suite IST der Integration-Test
- **Betrifft:** CI-Pipeline, Qualitaetssicherung

### Error-Handling & Recovery

- **Entscheidung:** Laufende Calls sofort failen, Reconnect im Hintergrund (max 3x, 1s Pause), TabStateCache bleibt erhalten
- **Rationale:** Ehrlich und einfach. Agent bekommt klare Fehlermeldung statt stilles Haengen. Entspricht NFR14
- **Betrifft:** Alle Schichten (Error-Propagation von CDP → Tools → MCP Response)

### A11y-Ref-IDs

- **Entscheidung:** Durchnummeriert (`e1`, `e2`, ...) mit Stabilitaetsgarantie — bestehende Refs bleiben bei DOM-Updates stabil, neue Elemente bekommen neue Nummern. Reset bei Navigation
- **Rationale:** Einfach, vorhersagbar, erfuellt NFR13 (stabil ueber 5+ Calls). Hash-basiert waere fragil bei dynamischen Seiten
- **Betrifft:** Schicht 2 (A11y-Tree-Processor), Schicht 3 (alle Tools die Refs nutzen)

## Implementation Patterns & Consistency Rules

### Naming Patterns

| Bereich | Regel | Beispiel |
|---------|-------|----------|
| Dateien | kebab-case | `tab-state-cache.ts`, `cdp-client.ts` |
| Funktionen/Variablen | camelCase | `getTabState()`, `refId` |
| Typen/Interfaces | PascalCase | `TabState`, `CdpResponse` |
| MCP-Tool-Namen | snake_case | `read_page`, `tab_status`, `run_plan` |
| CDP-Domains/Methoden | Exakt wie Chrome sie definiert | `Page.navigate`, `Runtime.evaluate` |

### Structure Patterns

| Frage | Regel |
|-------|-------|
| Tests | Co-located: `foo.ts` → `foo.test.ts` im selben Ordner |
| Ein Tool = ? | Eine Datei pro Tool: `tools/navigate.ts`, `tools/click.ts` |
| Shared Types | `src/types.ts` fuer projektweite Typen |
| CDP-Hilfsfunktionen | Im `src/cdp/` Ordner, nicht in Tools verstreut |

### MCP Response Format

Alle Tool-Responses folgen diesem Format:

```typescript
// Erfolg
{
  content: [{ type: "text", text: "..." }],
  _meta: { elapsedMs: 42, method: "navigate" }
}

// Fehler
{
  content: [{ type: "text", text: "Element e42 nicht gefunden..." }],
  isError: true,
  _meta: { elapsedMs: 12, method: "click" }
}
```

Immer `_meta` mit Timing. Immer `isError: true` bei Fehlern. Nie Exceptions nach oben durchlassen.

### Tool-Registrierung

Jedes Tool exportiert ein Objekt mit Schema + Handler:

```typescript
// tools/navigate.ts
export const navigateTool = {
  name: "navigate",
  schema: z.object({ url: z.string(), ... }),
  handler: async (params, context) => { ... }
}
```

`server.ts` importiert alle Tools und registriert sie beim MCP-Server. Kein Auto-Discovery, keine Magic.

### CDP-Call-Pattern

```typescript
// Immer ueber den CDP-Client, nie direkt WebSocket
const result = await cdpClient.send("Page.navigate", { url: "..." }, sessionId);
```

Jeder CDP-Call geht durch `cdpClient.send()`. Nie direkt auf den WebSocket/Pipe schreiben. Reconnect-Logik und Session-Routing bleiben zentral.

### Logging

- `console.error()` fuer echte Fehler (geht an stderr, nicht an MCP-Client)
- Kein `console.log()` — stdout gehoert dem MCP-Protokoll (stdio Transport)
- Debug-Logging optional ueber Umgebungsvariable `DEBUG=silbercuechrome`

### Anti-Patterns (verboten)

- Nie direkt auf WebSocket/Pipe schreiben — immer ueber `cdpClient`
- Nie `console.log()` — stdout ist MCP
- Nie CDP-Domain-Methoden hardcoden die sich zwischen Chrome-Versionen aendern koennten — Constants nutzen
- Nie synchron auf CDP warten — immer async/await mit Timeout

## Project Structure & Boundaries

### Complete Project Directory Structure

```
silbercuechrome/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── .prettierrc
├── .gitignore
├── README.md
├── LICENSE                          ← MIT (Open Source Free-Tier)
│
├── .github/
│   └── workflows/
│       ├── ci.yml                   ← Tests + Lint bei jedem Push
│       └── chrome-update.yml        ← Automatische Tests bei Chrome-Updates (NFR23)
│
├── src/
│   ├── index.ts                     ← Entry Point: stdio Transport starten
│   ├── server.ts                    ← MCP Server Setup
│   ├── registry.ts                  ← ToolRegistry (eigene Datei — run_plan braucht Zugriff)
│   ├── types.ts                     ← Projektweite Typen
│   │
│   ├── transport/                   ← Schicht 1a: Transport-Abstraktion
│   │   ├── transport.ts             ← Interface: send(), onMessage(), close()
│   │   ├── pipe-transport.ts        ← CDP-Pipe (FD3/FD4) fuer Auto-Launch
│   │   ├── websocket-transport.ts   ← WebSocket fuer laufendes Chrome
│   │   ├── pipe-transport.test.ts
│   │   └── websocket-transport.test.ts
│   │
│   ├── cdp/                         ← Schicht 1b: CDP-Client
│   │   ├── cdp-client.ts            ← send(), Event-Routing, Reconnect-Logik
│   │   ├── session-manager.ts       ← Per-Tab Sessions, OOPIF-Sessions
│   │   ├── chrome-launcher.ts       ← Auto-Launch mit korrekten Flags
│   │   ├── settle.ts                ← Gemeinsame Warte-Logik (Network Idle, DOM Stable, Hydration)
│   │   ├── protocol.ts              ← CDP-Typen, Domain-Constants
│   │   ├── cdp-client.test.ts
│   │   ├── session-manager.test.ts
│   │   ├── chrome-launcher.test.ts
│   │   └── settle.test.ts
│   │
│   ├── cache/                       ← Schicht 2: State & A11y
│   │   ├── tab-state-cache.ts       ← TTL-Cache: URL, Title, DOM-Ready, Errors
│   │   ├── a11y-tree.ts             ← Progressive Disclosure, Ref-ID-Vergabe
│   │   ├── tab-state-cache.test.ts
│   │   └── a11y-tree.test.ts
│   │
│   ├── tools/                       ← Schicht 3: MCP Tools (1 Datei pro Tool)
│   │   ├── navigate.ts
│   │   ├── click.ts
│   │   ├── type.ts
│   │   ├── screenshot.ts
│   │   ├── read-page.ts
│   │   ├── evaluate.ts
│   │   ├── tab-status.ts
│   │   ├── wait-for.ts
│   │   ├── switch-tab.ts
│   │   ├── virtual-desk.ts
│   │   ├── run-plan.ts              ← Tool-Handler (delegiert an plan/)
│   │   └── *.test.ts                ← Co-located Tests pro Tool
│   │
│   └── plan/                        ← Schicht 4: Batch-Execution
│       ├── plan-executor.ts         ← Serieller Step-Runner, Abbruch bei Fehler
│       └── plan-executor.test.ts
│
├── test-hardest/                    ← Benchmark-Suite (24 Tests, bereits vorhanden)
│   ├── index.html
│   └── benchmark-*.json
│
└── build/                           ← Production-Build Output (gitignored)
    └── index.js                     ← bin Entry fuer npx
```

**Hinweis:** Diese Ordnerstruktur ist das Ziel. Am Anfang darf flacher gestartet werden (wenige Dateien in `src/`), Refactoring in Ordner wenn die Dateianzahl waechst.

### FR-Kategorie → Verzeichnis-Mapping

| FR-Kategorie | Verzeichnis | Dateien |
|-------------|-------------|---------|
| Browser-Verbindung & Lifecycle (FR1-FR5) | `transport/`, `cdp/` | cdp-client, session-manager, chrome-launcher |
| Seitennavigation & Warten (FR6-FR10) | `tools/`, `cdp/` | navigate, wait-for, settle |
| Element-Interaktion (FR11-FR15) | `tools/`, `cache/` | click, type + a11y-tree (Ref-Aufloesung) |
| Seiteninhalte lesen (FR16-FR19) | `tools/`, `cache/` | read-page, screenshot + a11y-tree |
| JavaScript-Ausfuehrung (FR20-FR21) | `tools/` | evaluate |
| State-Management & Caching (FR22-FR24) | `cache/` | tab-state-cache |
| VirtualDesk (FR25-FR27) | `tools/`, `cache/` | virtual-desk + tab-state-cache |
| Batch-Execution (FR28-FR30) | `tools/`, `plan/` | run-plan + plan-executor |
| Tab-Management (FR31) | `tools/` | switch-tab |
| Token-Optimierung & DX (FR32-FR34) | `server.ts`, alle Tools | Tool-Schemas, Response-Format |

### Architectural Boundaries

**Transport-Boundary:** `transport/transport.ts` definiert das Interface. Alles oberhalb spricht nur mit diesem Interface — nie direkt mit Pipe oder WebSocket.

**CDP-Boundary:** `cdp/cdp-client.ts` ist die einzige Stelle, die CDP-Nachrichten sendet/empfaengt. Tools rufen `cdpClient.send()` auf — nie tiefer.

**Cache-Boundary:** Tools lesen/schreiben Cache ueber `TabStateCache` und `A11yTree` — nie direkt CDP fuer gecachte Daten.

**Tool-Boundary:** Jedes Tool ist self-contained. Tools rufen sich nicht gegenseitig auf. `run-plan` nutzt die ToolRegistry um Tools per Name auszufuehren.

**Settle-Boundary:** Alle Warte-Logik (Network Idle, DOM Stable, Hydration) lebt in `cdp/settle.ts`. Tools rufen `settle()` auf — implementieren es nie selbst.

### Datenfluss

```
MCP Client (Claude Code/Cursor)
    ↓ stdio (JSON-RPC)
index.ts → server.ts → registry.ts (ToolRegistry)
    ↓ Tool-Handler
tools/*.ts
    ↓ CDP-Calls + Cache-Reads + Settle
cache/ + cdp/cdp-client.ts + cdp/settle.ts
    ↓ Transport
transport/ → Chrome (CDP-Pipe oder WebSocket)
```

## Architecture Validation Results

### Coherence Validation ✅

Alle Entscheidungen arbeiten zusammen ohne Widersprueche:
- TypeScript + MCP SDK v1.29.0 + Zod: Kompatibel
- Eigener CDP-Client + Pipe/WebSocket-Abstraktion: Konsistent
- Schichten-Architektur spiegelt sich 1:1 in Projektstruktur
- ToolRegistry als eigene Datei loest run_plan-Abhaengigkeit sauber
- Settle-Logik zentral statt dupliziert
- Naming-Patterns konsistent (kebab-case Dateien, camelCase Code, snake_case Tools)

### Requirements Coverage ✅

**Alle 34 MVP-FRs architektonisch abgedeckt:**

| Schicht | Abgedeckte FRs |
|---------|---------------|
| Transport + CDP | FR1-FR5 (Verbindung, Auto-Launch, Reconnect, OOPIF) |
| Cache | FR16-FR19, FR22-FR27 (A11y-Tree, State-Cache, VirtualDesk) |
| Tools | FR6-FR15, FR20-FR21, FR28-FR31 (Alle 12 MVP-Tools) |
| Uebergreifend | FR32-FR34 (Token-Optimierung, Timing, Fehlermeldungen) |
| Visual Intelligence | FR52-FR62 (Emulation, DOMSnapshot, SoM, Downsampling, Selector-Caching) — Post-MVP, implementiert in Epic 5b |
| Operator (Phase 3) | FR47-FR51 (Rule-Engine, Micro-LLM, Captain, Chrome-Profil, Human Touch) — implementiert in Epic 8 |
| Infrastruktur | FR63-FR69 (Lizenzierung, Dual-Repo, Publish) — MVP-Infrastruktur |

**Alle 24 NFRs adressiert:**
- Performance (NFR1-NFR8): Direktes CDP, run_plan, Token-Budget ✅
- Zuverlaessigkeit (NFR9-NFR14): Reconnect-Strategie, Ref-Stabilitaet ✅
- Sicherheit (NFR15-NFR18): Lokale Kommunikation, License deferred ✅
- Integration (NFR19-NFR24): Cross-Platform, CI-Pipeline ✅

### Gap Analysis

**Kritische Gaps: 0**

**Kleine Luecken (nicht blockierend):**
1. **Screenshot-Format:** CDP `Page.captureScreenshot` unterstuetzt direkt WebP — kein separates Konvertierungs-Paket noetig
2. **Default-Timeouts:** Empfohlene Defaults: Settle 500ms, Reconnect 3x1s, run_plan 30s pro Step. Anpassung basierend auf realen Messungen
3. **Phase 2/3 Erweiterbarkeit:** Durch Schichten-Modell gegeben, keine expliziten Erweiterungspunkte dokumentiert — akzeptabel fuer MVP

### Completeness Checklist

- [x] Projekt-Kontext analysiert
- [x] Schichten-Architektur definiert (CDP → Cache → Tools → Plans)
- [x] Kern-Entscheidungen getroffen (CDP-Client, Repos, Launch, Testing, Errors, Refs)
- [x] Implementation Patterns festgelegt (Naming, Struktur, Responses, Registrierung)
- [x] Projektstruktur vollstaendig mit FR-Mapping
- [x] Architektur-Boundaries definiert
- [x] Datenfluss dokumentiert

### Architecture Readiness Assessment

**Status:** READY FOR IMPLEMENTATION

**Confidence Level:** High

**Staerken:**
- Klare Schichten mit testbaren Boundaries
- "Von innen nach aussen" ermoeglicht iterativen Aufbau durch Einzelentwickler
- Alle 34 MVP-FRs und 24 NFRs architektonisch abgedeckt
- Pragmatische Entscheidungen (kein Over-Engineering)

**Spaeter verbessern:**
- Pro-Hook-System konkretisieren wenn Free-Tier steht
- Erweiterungspunkte fuer Phase 2/3 explizit dokumentieren
- Default-Timeouts basierend auf realen Messungen anpassen

### Implementation Handoff

**Erste Implementierungs-Prioritaet:**
1. Projekt-Setup (package.json, tsconfig, Tooling)
2. CDP-Client + Transport (Schicht 1 — der innerste Kern)
3. `evaluate` Tool (wichtigstes Tool, Benchmark-Star)
4. `navigate` + `read_page` (erste nutzbare Browser-Interaktion)
5. Iterativ weitere Tools ergaenzen
