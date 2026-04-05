# Deferred Work — SilbercueChrome

Bugs, Verbesserungen und offene Punkte die waehrend der Arbeit entdeckt, aber nicht sofort behoben wurden.

## Status-Uebersicht (Stand 2026-04-05)

| Bug | Status | Fix |
|-----|--------|-----|
| BUG-001 | GEFIXT | Tabellen mit Section-Heading annotiert in a11y-tree.ts |
| BUG-002 | GEFIXT | mouseMoved vor mousePressed in click.ts |
| BUG-003 | GEFIXT | Accept-Skip permanent — Node 22 undici Bug bestaetigt |
| BUG-004 | GEFIXT | Exponential Backoff, Race-Fix, Handler-Akkumulation |
| BUG-005 | GEFIXT | getBoundingClientRect + JS-Click Fallback in click.ts |
| BUG-006 | GEFIXT | JS-Fallback this.focus() via Runtime.callFunctionOn in type.ts |
| BUG-007 | GEFIXT | getBoundingClientRect Fallback in click.ts |
| BUG-008 | GEFIXT | Sichtbare Truncation-Warnung in run-plan.ts |
| BUG-009 | GEFIXT | Safety-Cap 50K Tokens auto-downsample in a11y-tree.ts |
| BUG-010 | GEFIXT | Precomputed-Cache sofort bei DOM-Mutation invalidiert (DomWatcher + server.ts) |
| BUG-011 | GEFIXT | wrapCdpError in 9 Tools nachgeruestet |
| BUG-012 | GEFIXT | getBoundingClientRect + JS-Click Fallback in click.ts |
| TD-001 | OFFEN | AutoLaunch Tests + Doku |

---

## BUG-001: read_page liefert unspezifischen Tabellen-Kontext

**Entdeckt:** 2026-04-05 (MCP Benchmark Run)
**Schwere:** Medium
**Betrifft:** `read_page` Tool
**Status:** GEFIXT (2026-04-05)

### Problem
Wenn mehrere Tabellen auf einer Seite sind, liefert `read_page` nicht genug Kontext um Tabellen eindeutig zuzuordnen. Der LLM liest die falsche Tabelle oder die falsche Spalte.

### Fix
`formatLine()` in `a11y-tree.ts` annotiert `table`-Nodes mit dem naechsten Heading-Geschwister via `findSectionHeading()`. Output: `[e42] table (section: "Player Scores")`. Wirkt in regulaerem und downsampled Rendering.

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
**Status:** GEFIXT (2026-04-05)

### Problem
WebSocket-Handshake zu Chrome via `--remote-debugging-port=9222` schlaegt fehl. Node 22 `httpRequest` und Chrome 146 produzieren unterschiedliche `Sec-WebSocket-Accept`-Hashes.

### Root Cause
Bestaetigt als Bug in Node 22 undici 6.21.1. Die native `WebSocket`-API hat exakt denselben Hash-Mismatch — getestet mit Mock-Server und nativem WebSocket-Client. Betrifft alle WebSocket-Implementierungen in Node 22.

### Fix
Accept-Validierung permanent uebersprungen. Die Custom-Implementierung (HTTP Upgrade + manuelle Frame-Kodierung) funktioniert korrekt — nur die Accept-Validierung ist betroffen. Chrome DevTools ist ein vertrauenswuerdiger localhost-Endpoint, daher ist der Skip sicher.

Native WebSocket und `ws`-Paket wurden als Alternativen getestet — beide scheitern am selben undici-Bug.

---

## BUG-004: Reconnect scheitert permanent — CdpClient bleibt closed

**Entdeckt:** 2026-04-05 (Live-Benchmark, 3 parallele Agents)
**Schwere:** P0 — Kritisch (Launch-Blocker)
**Betrifft:** `src/cdp/chrome-launcher.ts` (Zeilen 329-433), `src/server.ts` (Zeilen 150-216)

### Problem
Nach Verlust der CDP-Verbindung (Pipe oder WebSocket) startet der Reconnect zwar eine neue Chrome-Instanz, aber der CdpClient wird nicht erfolgreich ersetzt. Der Server bleibt dauerhaft im Status `disconnected`. Kein Tool funktioniert mehr — der gesamte MCP-Server ist tot.

### Reproduktion
- 3 parallele Agents auf Port 9222 starten → WebSocket-Contention → Disconnect
- Chrome-Prozess extern killen → Disconnect
- 1/3 Benchmark-Runs ging komplett verloren (0/24 Tests)

### Root Cause (vermutet)
Der `onReconnect`-Callback in server.ts wirft eine Exception bei einem der CDP-Befehle (`Target.getTargets`, `Target.attachToTarget`, `Runtime.enable`). `throw cbErr` (Zeile 414) wird vom aeusseren `catch` (Zeile 423) gefangen — der naechste Retry startet korrekt. Aber: Zeile 412-413 setzen `status = "disconnected"` und `_reconnecting = false` VOR dem Re-Throw, was eine Race-Window oeffnet. Nach 3 gescheiterten Retries gibt `reconnect()` permanent auf (Zeile 429-432) — es gibt keinen erneuten Aufruf.

### Moegliche Fixes
1. Auto-Reconnect mit exponential Backoff (nicht nach 3 Retries aufgeben)
2. `throw cbErr` durch `continue` ersetzen — naechsten Retry starten
3. Fallback: Wenn Pipe tot, versuche WebSocket auf Port 9222
4. Manueller Reconnect-Trigger (`reconnect` Tool oder configure_session Parameter)
5. Health-Check mit proaktivem Reconnect (`Browser.getVersion` periodisch)

---

## BUG-005: click auf Shadow-DOM-Elemente — "Node does not have a layout object"

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 3)
**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/click.ts`, CDP `DOM.getContentQuads`

### Problem
`click(ref: "eXXX")` auf Elemente innerhalb eines Shadow-DOM schlaegt fehl mit "Node does not have a layout object". CDP kann Shadow-DOM-Nodes nicht lokalisieren, weil der A11y-Tree die Elemente referenziert, aber die DOM-Node-ID auf eine Node ohne Layout zeigt.

### Reproduktion
Benchmark T3.1 — Shadow DOM Interaction. Click auf Button innerhalb shadow root.

### Workaround
`evaluate` mit `shadowRoot.querySelector().click()` — funktioniert immer.

### Moegliche Fixes
- Shadow-DOM-Nodes erkennen und automatisch evaluate-basiert klicken
- Fallback in click.ts: Wenn getContentQuads fehlschlaegt, JS-Click versuchen

---

## BUG-006: type/focus schlaegt bei Elementen neben Shadow-DOM fehl

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 3)
**Schwere:** P2 — Mittel
**Betrifft:** `src/tools/type.ts`

### Problem
`type(ref: "e304", text: "...")` schlaegt fehl mit "Could not focus element e304. Element may be hidden or not focusable." Tritt auf nach DOM-Aenderungen durch Shadow-DOM-Interaktion — vermutlich invalidierte Refs.

### Reproduktion
Benchmark T3.1 — nach Shadow-DOM click, type in benachbartes Input-Feld.

---

## BUG-007: click nach DOM-Aenderung — Ref zeigt auf Node ohne Layout

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 3)
**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/click.ts`, Ref-System

### Problem
Nach schneller Sequenz von Clicks aendert sich das DOM (Buttons werden disabled, opacity=0, Groesse=0). Der naechste click auf einen Ref schlaegt fehl mit "Node does not have a layout object", weil der Ref auf die alte DOM-Node zeigt.

### Reproduktion
Benchmark T1.4 (5 Selektoren), T4.1-T4.3 — schnelle Button-Click-Sequenzen.

### Moegliche Fixes
- Ref-Cache nach DOM-Mutation invalidieren
- Automatisches read_page-Refresh vor click wenn letzter Refresh >N Sekunden alt
- Fallback: JS-Click wenn getContentQuads fehlschlaegt

---

## BUG-008: run_plan stumme Truncation ohne Warnung

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 2 + Run 3)
**Schwere:** P0 — Kritisch (UX-Blocker)
**Betrifft:** `src/tools/run-plan.ts` (Zeile 220-223)

### Problem
Plans mit >3 Steps werden im Free Tier stumm auf 3 Steps gekuerzt. Die Ausgabe zeigt `[1/3] [2/3] [3/3]` statt `[1/16 TRUNCATED]`. Die Truncation-Info ist nur in `_meta` vorhanden, die fuer den User/LLM unsichtbar ist. Der Agent denkt, nur 3 Steps waren geplant — nicht dass 13 Steps verloren gingen.

### Reproduktion
Jeder run_plan mit >3 Steps im Free Tier. 3x reproduziert mit identischem Ergebnis.

### Moegliche Fixes
1. Sichtbare Warnung im Output: "Plan truncated from 16 to 3 steps (Free Tier limit). Upgrade to Pro for unlimited steps."
2. Schritt-Zaehlung korrekt: `[1/16 — TRUNCATED at 3]` statt `[1/3]`
3. Restliche Steps als "skipped" im Output auflisten

---

## BUG-009: read_page 10K-DOM erzeugt 855KB Response

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 3)
**Schwere:** P3 — Niedrig
**Betrifft:** `src/tools/read-page.ts`
**Status:** GEFIXT (2026-04-05)

### Problem
`read_page(filter: "all", depth: 10)` auf Seite mit 10.000 DOM-Elementen erzeugt 855.381 Zeichen Response. Der MCP-Client schneidet die Response ab.

### Fix
Safety-Cap `DEFAULT_MAX_TOKENS = 50_000` (~200KB) in `a11y-tree.ts`. Wenn kein `max_tokens` angegeben wird, greift automatisch der Safety-Cap und triggert Downsampling. Gross genug fuer normale Seiten, verhindert MCP-Client-Truncation.

---

## BUG-010: read_page interactive zeigt zu wenige Elemente nach Scroll/DOM-Aenderung

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 2 + Run 3)
**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/read-page.ts`, A11y-Tree-Cache

### Problem
Nach Scroll oder DOM-Aenderungen zeigt `read_page(filter: "interactive")` nur 7-8 Elemente (sticky Navigation) statt 20+ interaktive Elemente. Elemente ausserhalb des Viewports oder in versteckten Tabs werden nicht als "interactive" gezaehlt.

### Moegliche Fixes
- A11y-Tree-Cache nach DOM-Mutation invalidieren
- Viewport-unabhaengige Elementerkennung
- Cached Refs nach Wizard-Step-Wechsel refreshen

---

## BUG-011: Fehlermeldungen bei Disconnect sind kryptisch

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 1 + Run 3)
**Schwere:** P2 — Mittel
**Betrifft:** Alle Tools (navigate.ts, click.ts, evaluate.ts etc.)

### Problem
Tools werfen rohe "CdpClient is closed" statt der freundlichen Meldung "CDP connection lost. The server is attempting to reconnect." Die meisten Tools nutzen `wrapCdpError()` nicht.

### Moegliche Fixes
- Alle Tools mit wrapCdpError() wrappen
- Zentrale Error-Middleware die CDP-Fehler abfaengt

---

## BUG-012: click() loest onclick-Handler nach DOM-Mutation nicht aus

**Entdeckt:** 2026-04-05 (Live-Test T3.1)
**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/click.ts` (Zeilen 26-91), CDP `Input.dispatchMouseEvent`

### Problem
CDP-Click via `Input.dispatchMouseEvent` (`mousePressed` + `mouseReleased`) loest inline `onclick`-Handler nicht zuverlaessig aus, wenn vorher DOM-Mutationen stattfanden (Shadow-DOM-Interaktion, Typing). Der Click-Return meldet Erfolg, aber der Handler feuert nicht.

### Reproduktion (Benchmark T3.1)
1. Shadow-Button klicken (e98) → OK, Text wechselt zu "Shadow Clicked!"
2. Wert in Input tippen (e59) → OK
3. Verify-Button klicken (e60, `onclick="Tests.t3_1_verify()"`) → Click-Return "success", aber Status bleibt PENDING
4. Gleicher Verify via `evaluate("Tests.t3_1_verify()")` → PASS

### Kontrast: T1.4 onclick funktioniert
T1.4-Buttons nutzen ebenfalls inline `onclick`, aber dort gab es vorher keine DOM-Mutationen. Alle 5 Clicks registrierten korrekt.

### Vermutete Ursache
Nach DOM-Mutationen (Shadow-DOM, Typing) verschiebt sich das Layout oder die Element-Koordinaten aendern sich. `DOM.getContentQuads` liefert Koordinaten basierend auf dem alten Layout. Der Click landet geometrisch daneben — `mousePressed`/`mouseReleased` werden dispatched, aber nicht auf dem richtigen Element. Deshalb feuert der onclick-Handler nicht.

### Moegliche Fixes
- Vor dem Click `DOM.scrollIntoViewIfNeeded` + kurze Pause fuer Layout-Recalc
- getContentQuads direkt vor dem Click aufrufen (nicht gecacht)
- Fallback: Wenn ref-basierter Click fehlschlaegt, JS-Click via `Runtime.callFunctionOn` versuchen
- Nach DOM-Mutationen automatisch A11y-Tree und Koordinaten-Cache invalidieren

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
