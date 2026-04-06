---
stepsCompleted:
  - "step-01-init"
  - "step-02-discovery"
  - "step-02b-vision"
  - "step-02c-executive-summary"
  - "step-03-success"
  - "step-04-journeys"
  - "step-05-domain (skipped — low domain complexity)"
  - "step-06-innovation"
  - "step-07-project-type"
  - "step-08-scoping"
  - "step-09-functional"
  - "step-10-nonfunctional"
  - "step-11-polish"
  - "step-12-complete"
inputDocuments:
  - "product-brief-SilbercueChrome.md"
  - "product-brief-SilbercueChrome-distillate.md"
  - "SilbercueSwift (externes Referenzprojekt — Architektur-Patterns)"
  - "benchmark-analysis.md (Konkurrenz-Benchmarks: Playwright MCP, claude-in-chrome, browser-use)"
documentCounts:
  briefs: 2
  research: 0
  brainstorming: 0
  projectDocs: 1
  benchmarks: 1
classification:
  projectType: developer_tool
  domain: general
  complexity: medium
  projectContext: greenfield
workflowType: 'prd'
lastEdited: '2026-04-05'
editHistory:
  - date: '2026-04-05'
    changes: "Phase-2-Addendum: FR71-FR80 (Benchmark & Verifikation — Community-Validation) eingefuegt. NFR25 (Benchmark-Abdeckung Community-Pain-Points) eingefuegt. Pro/Free-Abgrenzung korrigiert: Free-Tier von '8+1 Tools' auf '15 Tools' aktualisiert, Tool-Liste und Step-Limit (default 5) angepasst. Phase 2 Success Criteria ergaenzt. Phasen-Zuordnung erweitert."
  - date: '2026-04-04'
    changes: "Benchmark-Daten mit Ist-Werten aktualisiert (14.9s/21s statt Prognosen). FR52-FR62 fuer Epic 5b/7 (Visual Intelligence) eingefuegt. Monetarisierungs-FRs renummeriert FR63-FR69. Implementation Leakage in FR64/67/69 behoben. NFR1/NFR2 Targets aktualisiert. Out-of-Scope-Liste ergaenzt. AI-Framework-Integrationen in Phase 2 aufgenommen."
---

# Product Requirements Document - SilbercueChrome

**Author:** Julian
**Date:** 2026-04-02

## Executive Summary

SilbercueChrome ist ein MCP-Server fuer Chrome-Browser-Automation, der sich direkt per CDP (Chrome DevTools Protocol) mit Chrome verbindet — ohne Playwright-Proxy, ohne Extension-Relay, ohne Abstraktionsschicht. Das Projekt uebertraegt die am Markt validierten Architektur-Patterns von SilbercueSwift — dem schnellsten iOS-MCP-Server — auf die Browser-Welt.

Das Problem ist fundamental: Browser-Automation mit KI-Agenten ist heute ein Gluecksspiel. Bestehende MCP-Server (Playwright MCP, claude-in-chrome, browser-use) brechen ab, verlieren Verbindungen und sind so langsam, dass Entwickler zuschauen und denken: "Das haette ich in 4 Sekunden selbst gemacht." Die Messlatte fuer SilbercueChrome ist brutal klar:

1. **Rock-solid Zuverlaessigkeit** — es funktioniert. Jedes Mal. Kein Gluecksspiel.
2. **Geschwindigkeit** — schneller als ein Mensch, nicht langsamer.

Token-Effizienz ist kein eigenes Designziel, sondern eine natuerliche Konsequenz: Wenn der Zugriff zuverlaessig und schnell ist, werden automatisch weniger Tokens verbraucht. Tool-Definitionen unter 5.000 Tokens (vs. 13-17k bei der Konkurrenz), komprimierte Screenshots, progressiver Accessibility Tree — alles Resultate effizienter Architektur, nicht isolierter Optimierungen.

SilbercueChrome wird primaer fuer den eigenen Gebrauch gebaut. Wenn es keinen echten Mehrwert gegenueber der Konkurrenz bringt, nutzt der Entwickler die Konkurrenz. Der Pro-Tier (12 EUR/Monat) kompensiert investierte Zeit — kein Business-Modell, sondern ehrliche Wertschoepfung. Die oeffentliche Benchmark-Suite beweist den Unterschied oder es gibt keinen.

Zielgruppe: KI-Entwickler und Claude Code / Cursor / Cline User, die Agenten mit Browser-Zugriff einsetzen und von Instabilitaet und Langsamkeit der bestehenden Loesungen frustriert sind. Sekundaer: Automation-Scripter und Claude Desktop User ohne Terminal-Erfahrung. Tertiaer: Die SilbercueSwift-Community — bestehende Nutzer kennen das Open-Core-Modell, vertrauen der Marke und sind die natuerliche Seed-Population fuer Early Adoption. Cross-Sell an bestehende Pro-User ueber die etablierten Kanaele (GitHub, npm).

### Was SilbercueChrome besonders macht

Der Vorteil ist nicht ein einzelnes Feature, sondern das Zusammenspiel — "interlocking efficiencies", validiert durch SilbercueSwift:

- **Direktes CDP** (Pipe bei Auto-Launch, WebSocket bei laufendem Chrome) eliminiert Proxy-Layer und damit 15-20% Latenz
- **Intelligentes Caching** (TabStateCache) verhindert redundante Abfragen — der Agent bekommt sofort Antworten fuer bereits bekannten State
- **Stabile Element-Referenzen** aus dem Accessibility Tree ersetzen den Screenshot-Klick-Screenshot-Zyklus durch einen einzelnen Befehl
- **Native Batch-Execution** (`run_plan`) buendelt mehrere Operationen in einem Tool-Call — reduziert LLM-Roundtrips, den eigentlichen Bottleneck
- **Auto-Reconnect** mit State-Recovery statt Session-Verlust bei Verbindungsproblemen

### Benchmark-Validierung

Die 24-Test-Benchmark-Suite gegen alle Konkurrenten hat die zentrale Erkenntnis validiert: **Der Bottleneck ist nicht Browser-Latenz. Es sind LLM-Roundtrips.** CDP-Calls kosten 1-5ms. Ein Tool-Call kostet 2-10s (LLM-Denkzeit). Wer weniger Roundtrips braucht, gewinnt.

**Scripted Benchmarks** (direkter Tool-Aufruf, ohne LLM-Roundtrips):

| Tool | Passed | Wall-Clock | Notes |
|------|--------|------------|-------|
| **SilbercueChrome** | **24/24** | **14.9s** | run_plan batcht alles serverseitig |
| Playwright MCP | 22/24 | ~13s | Shadow DOM + Table Sum fail |

**LLM-driven Benchmarks** (Claude Code steuert den MCP, realistischer Agent-Workflow):

| Tool | Passed | Wall-Clock | Tool-Calls | Faktor vs. SilbercueChrome |
|------|--------|------------|------------|---------------------------|
| **SilbercueChrome** | **24/24** | **21s** | **116** | **1x** |
| Playwright MCP | 24/24 | 570s | 138 | 27x langsamer |
| browser-use skill (CLI) | 24/24 | 725s | 117 | 35x langsamer |
| claude-in-chrome | 24/24 | 772s | 193 | 37x langsamer |
| browser-use (raw MCP) | 16/24 | 1.813s | 124 | 86x langsamer |

`evaluate` ist dabei das wichtigste Tool: Ein einziger JS-Call der 5 DOM-Operationen batcht ist 100x schneller als 5 einzelne Click-Type-Verify-Roundtrips.

## Projekt-Klassifikation

- **Projekttyp:** Developer Tool (MCP-Server, npm-Package)
- **Domain:** General (Developer Tooling / Browser Automation)
- **Komplexitaet:** Medium — technisch anspruchsvoll (CDP-Protokoll, WebSocket/Pipe, Caching), aber ohne regulatorische Huerden
- **Projektkontext:** Greenfield — neues Produkt mit bewusster Uebernahme validierter Patterns aus SilbercueSwift

## Success Criteria

### User Success

- **Autonome Workflow-Completion:** Der Agent fuehrt einen kompletten Multi-Page-Workflow (Navigation, Formulare, Verifizierung) durch, ohne dass der Entwickler eingreifen muss.
- **Null Verbindungsabbrueche** in Standard-Workflows (10-Minuten-Sessions). Auto-Reconnect mit State-Recovery bei CDP-Verbindungsverlust.
- **Geschwindigkeit auf Mensch-Niveau oder schneller.** Der Entwickler schaut nicht mehr zu und denkt "das haette ich schneller selbst gemacht."
- **Zero-Config-Setup:** Von `npx @silbercuechrome/mcp` bis zum ersten erfolgreichen `navigate` in unter 60 Sekunden.

### Business Success

**Primaeres Kriterium:** Julian nutzt SilbercueChrome taeglich und es ist zuverlaessiger als jede verfuegbare Alternative. Wenn das nicht zutrifft, hat das Produkt seinen Zweck verfehlt.

**Sekundaere Kriterien (90 Tage post-Launch) — Validierung, dass andere es auch nuetzlich finden:**
- 500 GitHub Stars
- 1.000 npm Downloads/Monat
- 20 zahlende Pro-Subscriber

### Technical Success

- **Tool-Overhead:** <5.000 Tokens fuer Tool-Definitionen (vs. 13-17k bei der Konkurrenz)
- **Performance:** 24-Test-Benchmark-Suite unter 30 Sekunden (mit run_plan) — validiert: 14.9s scripted, 21s LLM-driven. 27x schneller als Playwright MCP
- **Stabilitaet:** CDP-Verbindung ueberlebt Tab-Wechsel und Chrome-Updates ohne Session-Verlust
- **Architektur-Validierung:** SilbercueSwift-Patterns (TabStateCache, Element-Refs, Batch-Execution) funktionieren nachweislich im Browser-Kontext

### Messbare Ergebnisse

| Metrik | Ziel | Messmethode |
|--------|------|-------------|
| Verbindungsabbrueche pro 10-Min-Session | 0 | Automatisierte Langzeit-Tests |
| Tool-Definition-Tokens | <5.000 | Token-Counter gegen MCP-Schema |
| Setup bis erster Navigate | <60 Sekunden | Cold-Start-Benchmark |
| 24-Test-Benchmark mit run_plan | <30 Sekunden | Deterministische Benchmark-Suite (validiert: 14.9s scripted, 21s LLM) |
| Taegliche Eigennutzung | Ja/Nein | Ehrliche Selbsteinschaetzung |

### Phase 2 Success Criteria (Community-Validation)

- **Benchmark-Suite v2:** 30+ Tests, davon 8+ Community-Pain-Point-Tests
- **Token-Metriken:** Jede Response zeigt geschaetzte Token-Kosten (`_meta.response_bytes`, `_meta.estimated_tokens`)
- **Benchmark-Runner:** `npm run benchmark` exportiert reproduzierbare Ergebnisse als JSON
- **Free-Tier:** Schlaegt alle Konkurrenten bei den Community-Pain-Point-Tests (ausser Anti-Bot wo Pro noetig ist)

## User Journeys

### Journey 1: Marco — Der frustrierte KI-Entwickler (Primaer, Happy Path)

**Marco**, 32, Full-Stack-Entwickler. Nutzt Claude Code taeglich. Hat Playwright MCP installiert, weil er seinen Agenten Web-Testing beibringen wollte. Jedes Mal dasselbe: Der Agent startet einen Workflow, nimmt 3 Screenshots (schon 40% Context weg), dann bricht die Session ab oder wird so langsam, dass Marco zum Browser greift und es selbst macht.

**Opening Scene:** Marco will einen E2E-Test automatisieren — Login, Dashboard pruefen, Einstellung aendern, Logout. Mit Playwright MCP braucht der Agent 6 Minuten und 3 Anlaeufe.

**Rising Action:** Marco stoesst auf SilbercueChrome. `npx @silbercuechrome/mcp` in die Claude Code Config, fertig. Der Agent navigiert, findet die Felder ueber A11y-Refs, tippt, klickt — kein Screenshot-Klick-Screenshot-Zyklus.

**Climax:** Der komplette 4-Seiten-Workflow laeuft in unter 30 Sekunden durch. Ohne Verbindungsabbruch. Ohne Retry.

**Resolution:** Marco deinstalliert Playwright MCP. Browser-Automation ist kein Gluecksspiel mehr, sondern ein zuverlaessiges Werkzeug.

---

### Journey 2: Sarah — Die Playwright-Umsteigerin (Primaer, Edge Case)

**Sarah**, 28, DevOps-Ingenieurin. Hat Playwright MCP tief in ihren Workflow integriert. Sie weiss, dass es langsam ist, aber "es funktioniert meistens." Dann liest sie einen Benchmark-Vergleich auf Reddit.

**Opening Scene:** Sarah ist skeptisch. Noch ein MCP-Server. Aber die Benchmark-Zahlen sind oeffentlich und reproduzierbar. Sie installiert SilbercueChrome parallel.

**Rising Action:** Ihre bestehenden Prompts funktionieren — die Tool-Namen sind intuitiv (`navigate`, `click`, `type`, `screenshot`). Der Migrations-Guide zeigt pro Pattern die Token-Ersparnis.

**Climax:** Derselbe Monitoring-Workflow. Playwright MCP: 4 Minuten, 2 Retries, 12.000 Tokens. SilbercueChrome: 45 Sekunden, 0 Retries, 3.800 Tokens.

**Resolution:** Sarah migriert komplett. Die gesparten Tokens summieren sich auf ~40 USD/Monat fuer das Team.

---

### Journey 3: Tom — Der Automation-Scripter (Sekundaer)

**Tom**, 41, Marketing-Manager. Kein Entwickler, aber technisch versiert genug fuer Claude Code. Braucht woechentlich Daten von 5 Plattformen — Analytics, Ad-Manager, CRM. 45 Minuten manuell jeden Montag.

**Opening Scene:** Tom hat Playwright MCP probiert, aber der Agent verliert staendig die Verbindung zwischen den Plattformen.

**Rising Action:** Tom installiert SilbercueChrome und beschreibt einfach: "Geh auf analytics.example.com, logge dich ein, exportiere den Wochenbericht als CSV, dann geh auf ads.example.com..."

**Climax:** Der Agent arbeitet alle 5 Plattformen ab. Auto-Reconnect haelt die Session stabil ueber die gesamten 8 Minuten.

**Resolution:** 45 Minuten manuelle Arbeit werden zu 8 Minuten automatisierte Arbeit. Tom versteht nicht, was CDP oder Tokens sind — und muss es auch nicht.

---

### Journey 4: Lisa — Die Claude Desktop Userin (Tertiaer, Normal User)

**Lisa**, 35, Projektmanagerin. Nutzt Claude Desktop fuer Texte und Recherche. Hat noch nie ein Terminal geoeffnet.

**Opening Scene:** Lisa nutzt claude-in-chrome. Es funktioniert manchmal — aber oft bricht die Verbindung ab.

**Rising Action:** Ein Freund richtet SilbercueChrome ein (ein Eintrag in der Claude Desktop Config). Lisa merkt keinen Unterschied in der Bedienung.

**Climax:** Der Unterschied ist, was *nicht* passiert: Keine Abbrueche. Lisa bemerkt erst nach einer Woche, dass sie keinen einzigen Browser-Fehler mehr hatte.

**Resolution:** SilbercueChrome ist unsichtbar — und genau das ist der Erfolg.

---

### Journey 5: Julian — Der Pro-Upgrade (Eigennutzung → Pro)

**Julian**, Einzelentwickler. Nutzt SilbercueChrome taeglich. Der Free-Tier ist bereits besser als alles andere. Aber bei komplexen Workflows mit vielen Tabs wird die serielle Ausfuehrung zum Bottleneck.

**Opening Scene:** Julian debuggt eine Web-App mit 3 Tabs — Frontend, API-Docs, Admin-Panel. Der Agent kann nur einen Tab gleichzeitig bedienen.

**Rising Action:** Pro-Tier: Parallel-Tab-Control, Network-Monitoring, erweiteter Plan-Executor.

**Climax:** Ein kompletter Debug-Zyklus laeuft als ein Befehl durch.

**Resolution:** Browser-Automation ist nicht mehr "Agent macht einzelne Schritte" sondern "Agent fuehrt komplexe Investigationen autonom durch."

---

### Journey Requirements Summary

| Journey | Offenbarte Capabilities |
|---------|------------------------|
| Marco (Erstinstallation) | Zero-Config-Setup, A11y-Refs, Token-Effizienz, Zuverlaessigkeit |
| Sarah (Migration) | Migrations-Guide, Benchmark-Suite |
| Tom (Automation-Scripter) | Multi-Page-Stabilitaet, Auto-Reconnect, lange Sessions |
| Lisa (Desktop User) | Unsichtbare Zuverlaessigkeit, Claude Desktop-Integration |
| Julian (Pro-Upgrade) | Parallel-Tab-Control, Network-Monitoring, Plan-Executor |

**Kern-Erkenntnis:** Alle Journeys konvergieren auf dieselben zwei Grundanforderungen — **Zuverlaessigkeit** und **Geschwindigkeit**.

## Innovation & Neuartige Patterns

### Operator-Architektur — Hierarchische Agenten-Ausfuehrung

Die fundamentalste Innovation: Trennung von Planung und Ausfuehrung in zwei Schichten.

- **Captain** (Haupt-LLM): Plant Workflows, trifft strategische Entscheidungen. Teuer, langsam, intelligent.
- **Operator** (kleines LLM oder Script-Engine): Fuehrt Browser-Aktionen adaptiv aus, trifft Mikro-Entscheidungen — ohne Round-Trip zum Captain. Billig, schnell, spezialisiert.

**Evolutionspfad:** `run_plan` (MVP, seriell) → Rule-basierter Operator → Operator mit kleinem LLM → vollautonomer Operator mit Fallback zum Captain.

### "Interlocking Efficiencies" als uebertragbares Paradigma

Kein einzelnes Feature ist revolutionaer. Das Zusammenspiel von Caching + Stabile Refs + Batch-Execution + Auto-Reconnect als System ist die Innovation. Validiert durch SilbercueSwift, jetzt als These: Diese Patterns sind domain-agnostisch.

### Token-Budget als First-Class Architectural Constraint

Die meisten MCP-Server optimieren Features. SilbercueChrome designt die Architektur um minimalen Token-Footprint — Progressive Disclosure statt Full-Tree, Inline-Results statt separate Calls, komprimierte Screenshots.

### Ehrlichkeits-Garantie als Wettbewerbsstrategie

"Wenn der Pro-Tier keinen messbaren Mehrwert liefert, wird er komplett Free." Oeffentliche Benchmark-Suite als Beweis.

### Wettbewerbskontext

| Ansatz | Konkurrenz | SilbercueChrome |
|--------|-----------|-----------------|
| Ausfuehrungsmodell | Jede Aktion = Round-Trip zum Haupt-LLM | run_plan: N Steps = 1 Roundtrip. Operator (Vision): Mikro-Entscheidungen lokal |
| Token-Architektur | 13-17k Tool-Overhead | <5k Tool-Overhead |
| Pattern-Herkunft | Von Grund auf gebaut | Validierte Patterns von SilbercueSwift |
| Bottleneck-Adressierung | Nicht adressiert | run_plan eliminiert LLM-Roundtrip-Bottleneck |

## Monetarisierung & Distribution

### Free vs. Pro — "Taste the Speed"

#### Free-Tier (Open Source, 15 Tools)

| Tool | Beschreibung |
|------|-------------|
| `evaluate` | JavaScript im Browser ausfuehren |
| `navigate` | URL Navigation + Zurueck |
| `read_page` | A11y-Tree mit stabilen Element-Refs |
| `screenshot` | Komprimierter WebP Screenshot |
| `click` | Klick per Ref oder CSS-Selector |
| `type` | Text eingeben |
| `wait_for` | Warten auf Bedingung (Element, Network, JS) |
| `tab_status` | Tab-Status aus Cache (0ms) |
| `run_plan` | **Konfigurierbares Step-Limit (default 5)** — Batch-Executor |
| `fill_form` | Komplexe Formulare befuellen |
| `handle_dialog` | Browser-Dialoge automatisch behandeln |
| `file_upload` | Dateien in File-Upload-Felder hochladen |
| `console_logs` | Console-Logs mit Topic-Filtering abfragen |
| `network_monitor` | Network-Requests inspizieren |
| `configure_session` | Default-Werte und Session-Einstellungen setzen |

Bereits besser als Playwright MCP: 65% weniger Tokens, stabile Refs, Auto-Reconnect. Der User spuert den Speed-Vorteil sofort — 5 Steps in einem Call statt 5 LLM-Roundtrips. Das Step-Limit ist ein interner Hebel (konfigurierbar) und greift smooth ohne Fehlermeldung — ueberzaehlige Steps werden einfach nicht ausgefuehrt, der Plan liefert das Teilergebnis zurueck. Das LLM kann bei Bedarf weitere run_plan-Calls machen.

#### Pro-Tier (Closed-Source Binary, 12 EUR/Monat)

Alles aus Free, plus:

| Feature | Beschreibung |
|---------|-------------|
| `run_plan` unbegrenzt | N Steps in 1 Call, kein Step-Limit |
| `switch_tab` | Tabs oeffnen, wechseln, schliessen |
| `virtual_desk` | Alle Tabs auf einen Blick (<500 Tokens fuer 10 Tabs) |
| `dom_snapshot` | Visuelles Element-Layout mit Positionen, Farben, Z-Order |
| Operator Mode | Adaptive Fehlerkorrektur via Micro-LLM |
| Captain | Eskalationsprotokoll — fragt den User bei Unklarheiten |
| Human Touch | Anti-Detection: Menschenaehnliches Klick- und Tippverhalten |

**Upgrade-Trigger:** Der Free-User erlebt mit run_plan sofort den Speed-Vorteil gegenueber Playwright & Co. — schon 3 Steps in einem Call sind ein Game-Changer. Pro bietet dann den unbegrenzten Operator-Modus, Multi-Tab-Management, und visuelle DOM-Analyse. Die Grenze ist nicht kuenstlich — Free ist bereits das beste kostenlose Browser-MCP auf dem Markt.

**Upgrade-Erlebnis:** Lizenz-basiert. User traegt License-Key ein (`SILBERCUECHROME_LICENSE` oder `~/.silbercuechrome/license.json`), Pro-Features werden freigeschaltet. Kein separates Binary noetig — das Combined Binary prueft die Lizenz und aktiviert Pro-Features bei gueltigem Key.

### Dual-Repo-Architektur

**Oeffentliches Repo** (`Silbercue/SilbercueChrome`): Vollstaendiger Free-Tier-Quellcode. TypeScript, MIT-Lizenz. npm-Package `@silbercue/chrome-mcp`.

**Privates Repo** (`Silbercue/SilbercueChromePro`): Pro-Features. Wird zur Build-Zeit in das Public-Repo injiziert, nach dem Build wieder entfernt. Vorkompiliertes Binary — proprietaere Optimierungen nicht im Quellcode einsehbar.

### Lizenzierung

- **Provider:** Polar.sh API
- **Reihenfolge:** Umgebungsvariable `SILBERCUECHROME_LICENSE` > lokale Datei `~/.silbercuechrome/license.json` > Online-Check
- **Offline-Robustheit:** 7-Tage-Grace-Period
- **CLI:** `silbercuechrome license status|activate|deactivate`

### Distribution

- **npm** als `@silbercue/chrome-mcp`
- **MCP Registry** (`registry.modelcontextprotocol.io`)
- **Sekundaer:** smithery.ai, PulseMCP, mcp.so, LobeHub
- **GitHub** als Entwicklungsort
- **Launch:** Oeffentliche Benchmark-Suite als Launch-Content (HN, Reddit, Dev.to)
- **Cross-Promotion:** Ankuendigung ueber SilbercueSwift-Kanaele (GitHub, npm, bestehende Community) — sofortiger Vertrauensvorschuss und Seed-User

### Publish-Pipeline

Adaptiert vom SilbercueSwift-Publish-Skill. 6-Phasen-Workflow: Status beider Repos → Commit+Push → Combined Build → Version-Tag → GitHub Actions Release → Verify.

### Ehrlichkeits-Garantie

Wenn der Pro-Tier keinen messbaren Mehrwert liefert, wird er komplett Free. Wir monetarisieren nur, wenn wir beweisbar besser sind. Die Benchmark-Suite ist oeffentlich — jeder kann es nachpruefen.

## Developer Tool — Spezifische Anforderungen

### Technische Architektur

- **Sprache:** TypeScript / Node.js
- **Transport:** stdio (JSON-RPC) zwischen KI-Client und Server
- **Verbindung:** CDP-Pipe (FD3/FD4) als Default bei Auto-Launch fuer minimale Latenz. WebSocket als Fallback fuer Verbindung zu bereits laufendem Chrome (`localhost:9222`)
- **Chrome-Launch:** Auto-Launch mit `--remote-debugging-pipe --user-data-dir=/tmp/silbercuechrome-profile`
- **Chrome 136+:** Erfordert `--user-data-dir` — Standard-Profil kann nicht ferngesteuert werden
- **Kein Playwright, kein puppeteer-core, kein Abstraktions-Layer**

### Installation & Distribution

- **Primaer:** `npx @silbercuechrome/mcp` (Zero-Install fuer MCP-Clients)
- **npm:** `npm install -g @silbercuechrome/mcp`
- **MCP Registry:** `registry.modelcontextprotocol.io`
- **Sekundaer:** smithery.ai, PulseMCP, mcp.so, LobeHub
- **Config-Beispiel (Claude Code):** `claude mcp add SilbercueChrome -- npx @silbercuechrome/mcp`

### API Surface — Tools (18 Tools)

| Tool | Tier | Beschreibung | Wait-Strategie |
|------|------|-------------|----------------|
| `navigate` | Free | URL laden, optional zurueck, scrollen. Eingebautes Settle (Network Idle + DOM Stable) | Automatisch |
| `click` | Free | Element klicken via A11y-Ref oder CSS-Selektor. Wartet auf Settle nach Klick | Automatisch |
| `type` | Free | Text in Eingabefeld tippen | Kein Wait noetig |
| `screenshot` | Free | Screenshot des sichtbaren Bereichs, komprimiert (WebP, max 800px) | Kein Wait noetig |
| `read_page` | Free | Accessibility Tree mit Progressive Disclosure (depth, filter, ref-basiert) | Kein Wait noetig |
| `evaluate` | Free | Beliebiges JavaScript ausfuehren — **wichtigstes Tool** (100x Faktor bei Basis-Tests durch JS-Batching) | Optional: wait_for Condition |
| `tab_status` | Free | Gecachter Tab-State (URL, Title, DOM-Ready, Console-Errors) | Aus Cache |
| `wait_for` | Free | Explizites Warten auf Condition (Element sichtbar, Network Idle, JS-Expression) | Kernfunktion |
| `run_plan` | Free (Step-Limit, default 5) / Pro (unbegrenzt) | Serielles Array von Operationen server-seitig ausfuehren. N Steps = 1 LLM-Roundtrip. Abbruch bei Fehler. Free: ueberzaehlige Steps leise nicht ausgefuehrt, Teilergebnis zurueck | Pro Step automatisch |
| `fill_form` | Free | Komplexe Formulare befuellen (mehrere Felder in einem Call) | Automatisch |
| `handle_dialog` | Free | Browser-Dialoge (alert, confirm, prompt, beforeunload) automatisch behandeln | Kein Wait noetig |
| `file_upload` | Free | Dateien in File-Upload-Felder hochladen | Kein Wait noetig |
| `console_logs` | Free | Console-Logs mit Topic-Filtering abfragen | Kein Wait noetig |
| `network_monitor` | Free | Network-Requests inspizieren und filtern | Kein Wait noetig |
| `configure_session` | Free | Default-Werte und Session-Einstellungen setzen | Kein Wait noetig |
| `switch_tab` | Pro | Tab wechseln, oeffnen, schliessen | Kein Wait noetig |
| `virtual_desk` | Pro | Kompakte Uebersicht aller Chrome-Instanzen und Tabs mit State | Aus Cache |
| `dom_snapshot` | Pro | Visuelles Element-Layout mit Positionen (x, y, width, height), Farben, Z-Order | Kein Wait noetig |
| (Cross-Frame) | Free | OOPIF-Support: Cross-Origin iFrames als eigene CDP-Targets (Google Login, Stripe, Cookie-Banner) | Transparent |

**Wait-Strategien (kritisch fuer SPA-Handling und run_plan):**
- **Network Idle:** Keine offenen HTTP-Requests seit X ms (Default: 500ms)
- **Element-basiert:** Warte bis Element mit Ref/Selektor sichtbar/interaktiv
- **Hydration-Detection:** React/Vue/Next.js — DOM existiert, aber noch nicht interaktiv
- **Custom JS-Condition:** Beliebige Expression die `true` zurueckgibt
- **Eingebaut in `navigate` und `click`:** Automatisches Settle, konfigurierbar via `settle_ms`

### Dokumentation

- **Schema-Descriptions** (primaer): Praezise, LLM-optimierte Beschreibungen pro Tool. Das LLM liest diese direkt — sie bestimmen die Nutzungsqualitaet.
- **README** (sekundaer): Quick-Start, Benchmark-Tabellen, Tool-Ueberblick, Vergleich mit Konkurrenz.
- **Migrations-Guide:** Token-Einsparungen pro Pattern fuer Playwright-Umsteiger.

### Implementierungs-Ueberlegungen

- **Tool-Design analog SilbercueSwift:** Jedes Tool = MCP Schema + Handler + Registration via ToolRegistry
- **Inline Results:** Screenshots komprimiert, Timing-Metadata (elapsedMs, method) in jeder Response
- **Progressive Disclosure:** `read_page` liefert erst Ueberblick (depth=3, nur interaktive Elemente), dann gezielt tiefer per Ref-ID
- **Intelligente Fehlermeldungen:** "Element 'e42' nicht gefunden — meintest du 'e43' (Button 'Absenden')?" statt "ref not found"
- **Aufbau von innen nach aussen:** Erst CDP-Connection und evaluate solide, dann iterativ Tools draufsetzen

## Projekt-Scoping & Phasenplanung

### MVP-Strategie

**MVP-Ansatz:** Problem-Solving MVP — das Minimum, das Browser-Automation zuverlaessig und schnell macht. Einzelentwickler-realistisch.

**Ressourcen:** Ein Entwickler (Julian), Teilzeit. Iterativer Aufbau: Grundgeruest (CDP-Connection + evaluate) muss zuerst solide funktionieren, dann schrittweise Tools ergaenzen.

### MVP Feature Set (Phase 1) — 18 Tools (15 Free + 3 Pro)

**Unterstuetzte User Journeys:** Marco (Erstinstallation), Lisa (Desktop User)

| Capability | Begruendung |
|-----------|-------------|
| 15 Free Tools (navigate, click, type, screenshot, read_page, evaluate, tab_status, wait_for, run_plan, fill_form, handle_dialog, file_upload, console_logs, network_monitor, configure_session) + 3 Pro Tools (switch_tab, virtual_desk, dom_snapshot) + OOPIF-Support | Vollstaendige Browser-Automation mit Batch-Execution |
| CDP-Pipe als Default bei Auto-Launch, WebSocket als Fallback | Minimale Latenz ohne Proxy |
| Auto-Launch Chrome mit korrekten Flags | Zero-Config-Setup (<60s) |
| Auto-Reconnect bei CDP-Verbindungsverlust | Zuverlaessigkeit Priority #1 |
| TabStateCache mit TTLs | Verhindert redundante Abfragen |
| Stabile A11y-Refs mit CSS-Selektor-Fallback | Ersetzt Screenshot-Klick-Screenshot-Zyklus |
| Progressive Disclosure fuer read_page | Verhindert 50k+ Token A11y-Trees |
| Wait-Strategien (Network Idle, Element-basiert, Hydration, Custom JS) | Kritisch fuer SPA-Handling |
| run_plan (seriell, Abbruch bei Fehler) | Eliminiert LLM-Roundtrip-Bottleneck — kategorialer Geschwindigkeitssprung |
| VirtualDesk (Pro) | Agent sieht alle Browser/Tabs auf einen Blick |
| OOPIF-Support (Cross-Origin iFrames) | Ohne das findet der Agent auf jeder dritten Website Buttons nicht |
| Intelligente Fehlermeldungen | DX-Differenzierung |
| Token-optimierte Responses (WebP, Inline-Results, <5k Tool-Overhead) | Natuerliche Konsequenz effizienter Architektur |

### Post-MVP (Phase 2 — Growth)

**Unterstuetzte User Journeys:** Sarah (Migration), Tom (Automation-Scripter)

| Feature | Begruendung |
|---------|-------------|
| Erweitertes run_plan (Conditionals, Variables, Suspend/Resume) | Vorstufe zum Operator |
| Console-Log-Filtering mit Topics | Debugging-Value-Prop (analog SilbercueSwift) |
| Network-Monitoring | Request-Inspektion ohne DevTools |
| Session-State mit Auto-Promote-Defaults | Komfort fuer wiederkehrende Workflows |
| Dialog-Handling | Cookie-Banner, Alert-Dialoge automatisch |
| File-Upload, Form-Filling | Erweiterte Interaktion |
| Multi-Tab-Management (seriell) | Mehrere Tabs verwalten |
| Precomputed A11y-Diff | A11y-Tree im Hintergrund aktuell halten — potentieller Pro-Differenzierungsfaktor |
| Migrations-Guide, Benchmark-Suite (oeffentlich) | Beweist den Unterschied |
| AI-Framework-Integrationen (LangChain, CrewAI) | Offizielle Partner-Integrationen fuer breitere Adoption |

### Vision (Phase 3 — Expansion)

**Unterstuetzte User Journeys:** Julian (Pro-Upgrade), alle mit erweitertem Funktionsumfang

| Feature | Begruendung |
|---------|-------------|
| **Operator-Architektur** | Captain/Operator-Trennung — kategorialer Sprung |
| **Human Touch** | Menschliche Mausbewegungen, variable Tippgeschwindigkeit — Anti-Bot-Detection |
| **Chrome-Profil-Nutzung** | Echtes User-Profil mit Passwoertern/Sessions (Opt-in) |
| Pro-Tier mit proprietaeren Optimierungen | Monetarisierung wenn messbarer Mehrwert bewiesen |
| Parallel-Tab-Control | Mehrere Tabs gleichzeitig (Pro) |
| Performance-Tracing (Lighthouse, Core Web Vitals) | Observability |
| Plugin-API / Community-Oekosystem | Erweiterbarkeit |
| Enterprise (Support-SLAs, Team-Lizenzen) | Skalierung wenn Adoption stimmt |

### Explizit nicht in v1

- Firefox/WebKit-Support
- Chrome-Extension-basierter Ansatz
- CI/CD-Integration
- Computer-Vision/Pixel-basierte Interaktion
- Multi-Agent-Coordination
- Enterprise-Features (Team-Lizenzen, SLAs)

### Pro/Free-Abgrenzung

**Entschieden:** Open-Core-Modell nach SilbercueSwift-Vorbild. Dual-Repo-Architektur von Anfang an. Combined Binary prueft Lizenz und aktiviert Pro-Features bei gueltigem Key.

**Free-Tier (15 Tools, Open Source, MIT):**
- Alle Kern-Tools: navigate, click, type, screenshot, read_page, evaluate, tab_status, wait_for, run_plan, fill_form, handle_dialog, file_upload, console_logs, network_monitor, configure_session
- run_plan mit konfigurierbarem Step-Limit (default 5) — ueberzaehlige Steps werden leise nicht ausgefuehrt, Teilergebnis zurueck

**Pro-Tier (12 EUR/Monat, Closed-Source Binary):**
- run_plan unbegrenzt (N Steps in 1 Call)
- switch_tab (Tabs oeffnen, wechseln, schliessen)
- virtual_desk (kompakte Tab-Uebersicht)
- dom_snapshot (visuelles Element-Layout mit Positionen, Farben, Z-Order)
- Operator Mode (adaptive Fehlerkorrektur via Micro-LLM)
- Captain (Eskalationsprotokoll)
- Human Touch (Anti-Detection)
- Precomputed A11y-Diff (sofortige read_page)
- Chrome-Profil-Nutzung (Opt-in)
- Parallel-Tab-Control
- Erweitertes run_plan mit Conditionals

### Risiken & Mitigationen

**CDP-Stabilitaet:** Googles internes Protokoll, Breaking Changes moeglich.
*Mitigation:* Mindestsupport-Chrome-Version, CDP-Versionspinning, CI-Pipeline die bei Chrome-Updates automatisch testet.

**A11y-Tree-Qualitaet:** Viele Websites haben schlechte Accessibility-Attribute.
*Mitigation:* Fallback auf CSS-Selektoren/XPath. Nie ausschliesslich auf A11y-Refs verlassen.

**OOPIF-Komplexitaet:** Cross-Origin iFrames erfordern separate CDP-Sessions pro Target.
*Mitigation:* Transparente Behandlung im Server — der Agent merkt keinen Unterschied.

**Wettbewerb:** browser-use baut eigene CDP-Library (`cdp-use`), Google hat Chrome DevTools MCP.
*Mitigation:* Oeffentliche Benchmark-Suite. Ehrlichkeits-Garantie: Wenn kein Mehrwert, Konkurrenz nutzen.

**Einzelentwickler:** Julian arbeitet Teilzeit.
*Mitigation:* Iterativer Aufbau von innen nach aussen. Patterns von SilbercueSwift uebertragen statt neu erfinden.

## Functional Requirements

### Browser-Verbindung & Lifecycle (MVP)

- **FR1:** Der Server kann sich per CDP-Pipe (Auto-Launch) oder CDP-WebSocket (laufendes Chrome) verbinden
- **FR2:** Der Server kann Chrome automatisch starten mit korrekten Flags wenn keine Instanz gefunden wird
- **FR3:** Der Server kann bei CDP-Verbindungsverlust automatisch reconnecten ohne Session-Verlust
- **FR4:** Der Server kann den Verbindungsstatus an den Agent kommunizieren (verbunden, reconnecting, getrennt)
- **FR5:** Der Server kann Cross-Origin iFrames (OOPIF) transparent erkennen und dem Agent zugaenglich machen

### Seitennavigation & Warten (MVP)

- **FR6:** Der Agent kann zu einer URL navigieren und automatisch auf Seitenstabilitaet warten (Settle)
- **FR7:** Der Agent kann im Browser zurueck navigieren
- **FR8:** Der Agent kann auf eine spezifische Bedingung warten (Element sichtbar, Network Idle, JS-Expression)
- **FR9:** Der Server kann clientseitige Navigation (pushState/replaceState, hashchange) erkennen und auf abgeschlossene Hydration warten bevor er Bereitschaft meldet
- **FR10:** Der Agent kann die Settle-Dauer pro Navigation konfigurieren

### Element-Interaktion (MVP)

- **FR11:** Der Agent kann Elemente ueber stabile Accessibility-Tree-Referenzen identifizieren
- **FR12:** Der Agent kann Elemente ueber CSS-Selektoren identifizieren (Fallback)
- **FR13:** Der Agent kann auf ein identifiziertes Element klicken
- **FR14:** Der Agent kann Text in ein Eingabefeld tippen
- **FR15:** Der Server kann nach Klick-Aktionen automatisch auf Seitenstabilitaet warten

### Seiteninhalte lesen & inspizieren (MVP)

- **FR16:** Der Agent kann den Accessibility Tree in progressiver Tiefe abfragen
- **FR17:** Der Agent kann den A11y-Tree nach interaktiven Elementen filtern
- **FR18:** Der Agent kann gezielt einen Teilbaum per Element-Ref abfragen
- **FR19:** Der Agent kann einen komprimierten Screenshot aufnehmen (WebP, max 800px)

### JavaScript-Ausfuehrung (MVP)

- **FR20:** Der Agent kann beliebiges mehrzeiliges JavaScript im Seitenkontext ausfuehren
- **FR21:** Der Agent kann Ergebnisse als JSON-serialisierbare Werte zurueckerhalten (Strings, Numbers, Arrays, Objects)

### State-Management & Caching (MVP)

- **FR22:** Der Server kann Tab-State (URL, Title, DOM-Ready, Console-Errors) mit konfigurierbarer Ablaufzeit cachen
- **FR23:** Der Server kann gecachten State sofort zurueckgeben ohne erneute CDP-Abfrage
- **FR24:** Der Server kann den Cache bei Seitenwechsel oder Seitenveraenderungen automatisch invalidieren

### VirtualDesk (MVP)

- **FR25:** Der Agent kann eine kompakte Uebersicht aller Chrome-Instanzen und Tabs abfragen
- **FR26:** VirtualDesk zeigt pro Tab den aktuellen State (URL, Title, Lade-Status, aktiv/inaktiv)
- **FR27:** VirtualDesk liefert unter 500 Tokens fuer bis zu 10 offene Tabs — kompakte Darstellung, kein Full-Tree pro Tab

### Batch-Execution (MVP)

- **FR28:** Der Agent kann ein serielles Array von Operationen als run_plan an den Server senden
- **FR29:** Der Server fuehrt alle Steps server-seitig aus — 1 LLM-Roundtrip statt N
- **FR30:** Der Server bricht bei Fehler ab und gibt Teilergebnisse zurueck

### Tab-Management (MVP)

- **FR31:** Der Agent kann Tabs oeffnen, schliessen und wechseln via switch_tab

### Token-Optimierung & DX (MVP)

- **FR32:** Tool-Definitionen unter 5.000 Tokens
- **FR33:** Timing-Metadata (elapsedMs, method) in jeder Response
- **FR34:** Fehlermeldungen mit Kontext (betroffene Ref-ID, naechstgelegene Alternative mit Name/Typ, aktueller Element-State)

### Erweitertes run_plan (Phase 2)

- **FR35:** run_plan mit Conditionals, Variables, Error-Strategien (abort/continue/screenshot)
- **FR36:** Suspend/Resume: Plan pausieren, Entscheidungsfrage an Agent, Plan fortsetzen

### Observability (Phase 2)

- **FR37:** Console-Logs mit Topic-Filtering abfragen
- **FR38:** Network-Requests inspizieren
- **FR39:** Logs nach Kategorien filtern (errors, warnings, network, app)

### Session-Management (Phase 2)

- **FR40:** Default-Werte setzen (Default-Tab, Default-Timeout)
- **FR41:** Auto-Promote: Nach 3+ aufeinanderfolgenden Aufrufen mit identischem Parameter diesen automatisch als Default vorschlagen

### Erweiterte Interaktion (Phase 2)

- **FR42:** Browser-Dialoge automatisch behandeln (Alerts, Confirms, Cookie-Banner)
- **FR43:** Dateien in File-Upload-Felder hochladen
- **FR44:** Komplexe Formulare befuellen

### Multi-Tab (Phase 2/3)

- **FR45:** Mehrere Tabs parallel steuern (Phase 3 — Pro)

### Precomputed A11y (Phase 2/3)

- **FR46:** A11y-Tree im Hintergrund bei DOM-Aenderungen aktualisiert halten und bei Abfrage sofort liefern

### Operator-Architektur (Phase 3)

- **FR47:** Browser-Aktionen ueber lokale Rule-Engine ausfuehren ohne Round-Trip zum Haupt-LLM
- **FR48:** Kleines LLM fuer adaptive Mikro-Entscheidungen (Scrollen, Warten, Dialog-Handling)
- **FR49:** Operator eskaliert bei Unsicherheit an den Captain

### Chrome-Profil & Human Touch (Phase 3)

- **FR50:** Optional echtes Chrome-Profil nutzen (Opt-in) fuer Passwoerter, Sessions, Cookies
- **FR51:** Menschliche Interaktionsmuster simulieren (natuerliche Mausbewegungen, variable Tippgeschwindigkeit)

### Visual Intelligence & DOM-Optimierung (Post-MVP, Epic 5b)

- **FR52:** Der Server kann den Device-Scale-Factor auf 1 setzen (Emulation-Override) fuer pixelgenaue Screenshots unabhaengig von Retina-Displays
- **FR53:** Der Server kann Screenshots in einem einzelnen CDP-Call aufnehmen statt mehrere Aufrufe zu benoetigen
- **FR54:** Der Server kann nach Tab-Wechsel oder Reconnect die Emulation-Einstellungen automatisch wiederherstellen
- **FR55:** Der Agent kann einen DOMSnapshot mit visuellen Positionen, Farben und Z-Order abrufen
- **FR56:** Der Server kann DOMSnapshot-Ergebnisse ueber eine 6-stufige Filterpipeline auf relevante Elemente reduzieren
- **FR57:** Der Agent kann read_page mit einem visuellen Filter-Modus nutzen der Layout-Informationen einschliesst
- **FR58:** Der Server kann bis zu 5 CDP-Requests parallel ausfuehren fuer schnellere Seitenanalyse
- **FR59:** Der Agent kann DOM-Inhalte mit einem konfigurierbaren Token-Budget abfragen — automatisches Downsampling bei Ueberschreitung
- **FR60:** Der Agent kann Set-of-Mark (SoM) auf Screenshots aktivieren — interaktive Elemente werden mit nummerierten Markern ueberlagert
- **FR61:** Der Server kann die Klickbarkeit von Elementen heuristisch bestimmen (Tags, ARIA-Rollen, CSS, Event-Listener)
- **FR62:** Der Server kann haeufig genutzte Element-Selektoren cachen und bei unveraendertem DOM wiederverwenden (Selector-Caching mit DOM-Fingerprinting)

### Monetarisierung & Distribution (MVP-Infrastruktur)

- **FR63:** run_plan im Free-Tier hat ein konfigurierbares Step-Limit (default 5). Ueberzaehlige Steps werden nicht ausgefuehrt, der Plan liefert das Teilergebnis zurueck ohne Fehlermeldung
- **FR64:** Der Server validiert beim Start den License-Key und aktiviert Pro-Features bei gueltigem Key. Fallback auf lokal gecachte Validierung bei fehlender Netzwerkverbindung
- **FR65:** Offline-Robustheit: 7-Tage-Grace-Period — Pro-Features bleiben aktiv wenn der letzte erfolgreiche Lizenz-Check weniger als 7 Tage zurueckliegt
- **FR66:** CLI-Kommandos fuer Lizenzverwaltung: `silbercuechrome license status|activate|deactivate`
- **FR67:** Das oeffentliche Repository enthaelt ausschliesslich Free-Tier-Quellcode. Pro-Features sind nicht im Quellcode einsehbar

### DOM-Snapshot (Pro, Phase 2/3)

- **FR68:** `dom_snapshot` liefert visuelles Element-Layout mit Positionen (x, y, width, height), Farben, und Z-Order fuer sichtbare Elemente

### Publish-Pipeline (MVP-Infrastruktur)

- **FR69:** Der Publish-Workflow erstellt reproduzierbar aus beiden Repos ein veroeffentlichungsfaehiges Release mit Versions-Tag

### License Validation (MVP-Infrastruktur)

- **FR70:** License-Keys werden direkt gegen die Polar.sh Public API (`/v1/customer-portal/license-keys/validate`) validiert. Kein eigener Server — die Organization-ID ist oeffentlich im Code, die Polar-Response (`status: "granted"`) wird auf `{ valid: true }` gemappt. Analog zu SilbercueSwift

### Benchmark & Verifikation (Phase 2 — Community-Validation)

- **FR71:** Die Benchmark-Suite testet Session Persistence — Cookie/localStorage-Werte ueberleben Server-Neustart wenn Chrome weiterlaueft. Konkurrenten die frischen Browser starten, scheitern.
- **FR72:** Die Benchmark-Suite testet CDP-Fingerprint-Sichtbarkeit — `navigator.webdriver`, `window.chrome.cdc` und andere CDP-Detection-Flags werden geprueft. SilbercueChrome mit Human Touch (Pro) muss alle Checks bestehen.
- **FR73:** Die Benchmark-Suite testet Extension-Verfuegbarkeit — eine Test-Extension ist im laufenden Chrome geladen und der Agent kann mit ihr interagieren. Konkurrenten die `--disable-extensions` nutzen, scheitern.
- **FR74:** Die Benchmark-Suite testet Reconnect-Recovery — CDP-Verbindung wird unterbrochen, Auto-Reconnect stellt die Verbindung her, naechster Tool-Call funktioniert.
- **FR75:** Die Benchmark-Suite testet Console-Log-Capture — `console.log()` im Browser wird ueber das `console_logs` Tool zurueckgeliefert.
- **FR76:** Die Benchmark-Suite testet File-Upload — eine Datei wird ueber `file_upload` in ein `<input type="file">` Element hochgeladen.
- **FR77:** Die Benchmark-Suite testet SPA-Navigation — History-API-basierte Navigation (`pushState`) wird erkannt, `wait_for` wartet auf Content-Update.
- **FR78:** Jede Tool-Response enthaelt `_meta.response_bytes` — die Response-Groesse in Bytes fuer Token-Kosten-Transparenz.
- **FR79:** `read_page` und `dom_snapshot` enthalten `_meta.estimated_tokens` — geschaetzte Token-Anzahl basierend auf Response-Laenge / 4.
- **FR80:** Der Benchmark-Runner (`npm run benchmark`) fuehrt alle Tests automatisiert aus und exportiert Ergebnisse als JSON mit Millisekunden pro Test und Tool-Calls pro Test.

**Phasen-Zuordnung:** MVP: FR1-FR34 (34 FRs) | Post-MVP Visual Intelligence: FR52-FR62 (11 FRs) | MVP-Infrastruktur: FR63-FR67, FR69-FR70 (7 FRs, FR70 = direkte Polar.sh-Integration) | Growth: FR35-FR46 (12 FRs) | Vision: FR47-FR51 (5 FRs) | Pro Phase 2/3: FR68 (1 FR) | Phase 2 Community-Validation: FR71-FR80 (10 FRs)

## Non-Functional Requirements

### Performance

- **NFR1:** 24-Test-Benchmark-Suite unter 30 Sekunden (mit run_plan) — validiert: 14.9s scripted, 21s LLM-driven. 27x schneller als Playwright MCP (570s)
- **NFR2:** Ohne run_plan: unter 2 Minuten — validiert: LLM-driven Benchmark mit Einzelcalls unter 120s bei optimaler Tool-Nutzung
- **NFR3:** CDP-Call-Latenz unter 5ms Round-Trip (unter 1ms bei CDP-Pipe)
- **NFR4:** Tool-Definitionen-Payload unter 5.000 Tokens (vs. 13.700 bei Playwright MCP)
- **NFR5:** Komprimierte Screenshots unter 100KB (WebP, max 800px)
- **NFR6:** evaluate-Ausfuehrung unter 50ms fuer Scripts bis 100 Zeilen (exklusive Script-Laufzeit) — Performance-kritischstes Tool
- **NFR7:** Cold-Start unter 3 Sekunden (inklusive Chrome-Auto-Launch)
- **NFR8:** run_plan mit N Steps = 1 LLM-Roundtrip

### Zuverlaessigkeit

- **NFR9:** 24/24 Tests bestanden in der Benchmark-Suite
- **NFR10:** Null Verbindungsabbrueche in 10-Minuten-Sessions
- **NFR11:** Auto-Reconnect innerhalb von 3 Sekunden
- **NFR12:** Gecachter Tab-State bleibt bei Reconnect erhalten
- **NFR13:** Stabile Element-Refs ueber mindestens 5 aufeinanderfolgende Tool-Calls (ohne Seitennavigation)
- **NFR14:** Bei Chrome-Absturz: Fehlermeldung an Agent innerhalb 3 Sekunden, kein Server-Crash, automatischer Reconnect-Versuch

### Sicherheit

- **NFR15:** Keine Default-Extraktion von Cookies/Credentials — explizit via evaluate
- **NFR16:** Alle Kommunikation lokal (CDP-Pipe/localhost + stdio MCP) — kein externes Relay
- **NFR17:** Security-Policy in README dokumentiert
- **NFR18:** License-Key-Validierung (Pro, Phase 3) mit Offline-Unterstuetzung (7-Tage-Grace-Period)

### Integration & Kompatibilitaet

- **NFR19:** Kompatibel mit allen MCP-Clients (Claude Code, Cursor, Cline, Windsurf, Claude Desktop)
- **NFR20:** Chrome 136+ Unterstuetzung
- **NFR21:** Node.js 18+ LTS
- **NFR22:** Installation via npx und Verbindung zu Chrome ohne manuelle Konfiguration auf macOS, Linux und Windows

### Qualitaetssicherung

- **NFR23:** CI-Pipeline bei jedem Chrome-Update — Breaking Changes erkennen bevor User sie melden
- **NFR24:** Deterministische Benchmark-Tests (vordefinierte Tool-Sequenzen, keine LLM-Entscheidungen) fuer reproduzierbare Vergleiche

### Benchmark-Abdeckung (Phase 2)

- **NFR25:** Die Benchmark-Suite deckt mindestens 80% der Top-10 Community-Pain-Points ab (gemessen an GitHub-Issues der 4 Hauptkonkurrenten: Playwright MCP, browser-use, claude-in-chrome, Chrome DevTools MCP). Stand 2026-04-05: 25% (3/12) — Ziel: 83% (10/12).
