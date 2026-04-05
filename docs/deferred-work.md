# Deferred Work — SilbercueChrome

Bugs, Verbesserungen und offene Punkte die waehrend der Arbeit entdeckt, aber nicht sofort behoben wurden.

---

## BUG-001: read_page liefert unspezifischen Tabellen-Kontext

**Entdeckt:** 2026-04-05 (MCP Benchmark Run)
**Schwere:** Medium
**Betrifft:** `read_page` Tool

### Problem
Wenn mehrere Tabellen auf einer Seite sind, liefert `read_page` nicht genug Kontext um Tabellen eindeutig zuzuordnen. Der LLM liest die falsche Tabelle oder die falsche Spalte.

### Reproduktion (Benchmark T1.6 + T2.6)
- T1.6: Agent las Score-Spalte aus der falschen Tabelle (brauchte 2. Versuch mit spezifischerem Selektor)
- T2.6: Agent las Stock-Spalte statt Price-Spalte (verwechselte Spaltenreihenfolge)

### Erwartetes Verhalten
`read_page` sollte Tabellen mit ihrem umgebenden Kontext (Heading, Test-ID, Section) zurueckgeben, sodass der LLM eindeutig zuordnen kann welche Tabelle welche ist.

### Moegliche Fixes
- Tabellen-Output mit naechstem Heading/Label annotieren
- Section-Kontext (h2/h3 vor der Tabelle) in den Output einbeziehen
- Tabellen-Headers immer mit ausgeben

---

## BUG-002: click() triggert mousedown-Events nicht korrekt

**Entdeckt:** 2026-04-05 (MCP Benchmark Run)
**Schwere:** Medium
**Betrifft:** `click` Tool / Event-Dispatch

### Problem
Custom Dropdown-Menus die auf `mousedown` statt `click` Events reagieren, werden von SC's `click()` nicht korrekt bedient. Der DOM-Klick wird ausgefuehrt, aber der Event-Handler des Dropdowns registriert die Auswahl nicht.

### Reproduktion (Benchmark T2.4)
- Searchable Dropdown mit dynamisch generierten Options
- Options nutzen `addEventListener('mousedown', ...)` statt `onclick`
- SC's `click()` loest den mousedown-Handler nicht aus
- Workaround: Agent musste `evaluate()` mit `Tests.t2_4_select('Rust')` aufrufen

### Erwartetes Verhalten
`click()` sollte die vollstaendige Event-Sequenz dispatchen: `pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`

### Moegliche Fixes
- Event-Dispatch-Reihenfolge in click.ts pruefen
- Sicherstellen dass mousedown/mouseup vor click dispatched werden
- CDP `Input.dispatchMouseEvent` mit korrekter Event-Sequenz nutzen

---

## BUG-003: WebSocket Sec-WebSocket-Accept Mismatch (Node 22 + Chrome 146)

**Entdeckt:** 2026-04-05 (Browser-Automation fuer Polar.sh)
**Schwere:** Medium
**Betrifft:** `src/transport/websocket-transport.ts`

### Problem
WebSocket-Handshake zu Chrome via `--remote-debugging-port=9222` schlaegt fehl. Node 22 `httpRequest` und Chrome 146 produzieren unterschiedliche `Sec-WebSocket-Accept`-Hashes. Der Client berechnet den erwarteten Hash korrekt (SHA1 von Key + GUID), aber Chrome gibt einen anderen zurueck.

### Temporaerer Fix
Accept-Validierung in `websocket-transport.ts` uebersprungen (Zeile 67-74 durch Kommentar ersetzt). Funktioniert weil Chrome DevTools ein vertrauenswuerdiger localhost-Endpoint ist.

### Moegliche permanente Fixes
- Root Cause identifizieren (Header-Encoding? Node 22 httpRequest Aenderung?)
- `ws` npm-Paket als Alternative zum Custom-WebSocket-Client
- Node.js native WebSocket API (verfuegbar ab Node 22)

---

## TECH-DEBT-001: AutoLaunch-Verhalten bei HEADLESS=false

**Entdeckt:** 2026-04-05
**Schwere:** Low
**Betrifft:** `src/server.ts`, `src/cdp/chrome-launcher.ts`

### Aenderung
Neues Verhalten: Wenn `SILBERCUE_CHROME_HEADLESS=false`, dann `autoLaunch` automatisch `false` (es sei denn explizit `SILBERCUE_CHROME_AUTO_LAUNCH=true` gesetzt). Neue Env-Variable `SILBERCUE_CHROME_AUTO_LAUNCH` hinzugefuegt.

### Offene Punkte
- Tests fuer das neue AutoLaunch-Verhalten schreiben
- Dokumentation (README) aktualisieren
- Env-Variable `SILBERCUE_CHROME_AUTO_LAUNCH` in Schema/Docs aufnehmen
