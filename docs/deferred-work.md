# Deferred Work — SilbercueChrome

Bugs, Verbesserungen und offene Punkte die waehrend der Arbeit entdeckt, aber nicht sofort behoben wurden.

## Status-Uebersicht (Stand 2026-04-07)

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
| BUG-013 | GEFIXT | Stale-Ref "Did you mean" schlaegt identischen Ref vor |
| BUG-014 | GEFIXT | read_page max_tokens harte Validierung statt Clamping |
| UX-001 | GEFIXT | click text-Parameter — findByText in A11y-Tree |
| TD-001 | GEFIXT | AutoLaunch Tests + Doku (Story 10.2) |
| FR-001 | GEFIXT | Scroll-Container in read_page nicht erkennbar — kein Scroll-Tool |
| FR-002 | GEFIXT | click auf target=_blank-Link warnt nicht / oeffnet keinen neuen Tab |
| FR-003 | GEFIXT | Same-origin srcdoc-iframes unsichtbar in read_page |
| FR-004 | GEFIXT | type/click Page Context zu verbose — voller Baum statt lokaler Kontext |
| FR-005 | GEFIXT | evaluate gibt undefined bei impliziten Return-Values |
| FR-006 | GEFIXT | contenteditable-Elemente als "generic" in read_page |
| FR-007 | GEFIXT | Stale-Ref nach Navigation — kein Auto-Recovery |
| FR-008 | GEFIXT | Canvas-Annotation mit screenshot(som: true) Hint |
| FR-009 | GEFIXT | observe Tool — MutationObserver + Polling Hybrid fuer DOM-Aenderungen |
| FR-010 | GEFIXT | click(x,y) scroll-kompensiert — headed raw coords, headless scroll-kompensiert |
| FR-011 | GEFIXT | await-Regex vereinfacht zu /\bawait\b/ — erkennt alle Patterns |
| FR-012 | GEFIXT | Truncation-Warnung mit Original-Token-Anzahl und Tipp |
| FR-013 | GESTRICHEN | Nischenfall (verschachtelte srcdoc-iFrames), evaluate-Workaround ausreichend |
| FR-014 | GEFIXT | switch_tab Stale-Refs Hint bei Tab-Wechsel |
| FR-015 | GEFIXT | scroll container_ref/container_selector fuer Container-Scroll |
| FR-016 | GEFIXT | Stale-Ref Leaf-Node Heuristik-Warnung in read_page |
| FR-017 | GEFIXT | press_key ref/selector Parameter fuer Target-Focus |
| BUG-015 | GEFIXT | setFocusEmulationEnabled + CDPScreenshotNewSurface (Dual-Layer Anti-Occlusion) |
| BUG-016 | GEFIXT | Cross-OOPIF/Tab Ref-Collision in a11y-tree.ts (Composite-Key refMap) |
| BUG-017 | GEFIXT | switch_tab laesst stale refs im Cache (reset in activateSession) |
| BUG-018 | MITIGATED | LLM "Defensive Fallback Spiral" zu evaluate (per-session Streak-Detector + Fail-Hints) |

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

## BUG-013: Stale Ref — "Did you mean" schlaegt identischen Ref vor

**Entdeckt:** 2026-04-05 (Live-Nutzung SteuerDB-Anwendung)
**Schwere:** P2 — Mittel (UX-Problem, verschwendet Roundtrips)
**Betrifft:** `src/tools/element-utils.ts` (Zeile 159-169), `src/cache/a11y-tree.ts` (Zeile 404-435)

### Problem
`click(ref: "e96")` schlaegt fehl mit `RefNotFoundError`, weil die Seite zwischen `read_page` und `click` neu gerendert hat. Die DOM-Node hinter dem Ref existiert nicht mehr. Die Fehlermeldung lautet:

> "Element e96 not found. Did you mean e96 (button '📋 Umsätze anzeigen')?"

Das ist widerspruechlich — der Vorschlag ist identisch mit dem fehlgeschlagenen Ref.

### Root Cause
`buildRefNotFoundError()` ruft `a11yTree.findClosestRef(ref)` auf. `findClosestRef` sucht im `reverseMap` nach dem numerisch naechsten Ref. Der `reverseMap` ist ein Cache aus dem letzten `read_page`-Aufruf — er enthaelt noch die alten Refs inkl. e96. Numerisch naechster Ref zu e96 ist e96 selbst. Die Funktion prueft nicht, ob der vorgeschlagene Ref identisch mit dem angefragten ist.

### Reproduktion
1. `read_page` → liefert Refs (u.a. e96 = Button "Umsätze anzeigen")
2. Seite rendert neu (SPA-Navigation, DOM-Mutation)
3. `click(ref: "e96")` → `resolveElement` findet DOM-Node nicht → `RefNotFoundError`
4. `buildRefNotFoundError("e96")` → `findClosestRef` findet e96 im Cache → schlaegt e96 vor

### Fix-Vorschlag
In `buildRefNotFoundError()`: Wenn `suggestion.ref === ref`, stattdessen melden:

> "Element e96 is stale — the page has re-rendered since read_page was called. Run read_page again to get fresh refs."

Alternativ in `findClosestRef()`: Den angefragten Ref aus der Kandidatenliste ausschliessen, wenn er eine `RefNotFoundError` ausgeloest hat.

---

## BUG-014: read_page max_tokens — harte Validierung statt Clamping

**Entdeckt:** 2026-04-05 (Live-Nutzung SteuerDB-Anwendung)
**Schwere:** P3 — Niedrig (verschwendet 1 Roundtrip)
**Betrifft:** `src/tools/read-page.ts` (Zeile 16)

### Problem
`read_page(max_tokens: 300)` wirft einen MCP-Validierungsfehler:

> "Input validation error: Number must be greater than or equal to 500"

Das LLM muss den exakt gleichen Call mit `max_tokens: 500` wiederholen — ein komplett verschwendeter Roundtrip. Das LLM will "so wenig wie moeglich" — 500 ist die bestmoegliche Antwort darauf.

### Root Cause
`readPageSchema` definiert `z.number().int().min(500)` — Zod wirft sofort einen Validierungsfehler fuer Werte < 500. Kein Clamping, kein Fallback.

### Fix-Vorschlag
Stilles Clamping statt Fehler:

```typescript
// Variante A: Zod Transform
max_tokens: z.number().int().optional()
  .transform(v => v !== undefined ? Math.max(v, 500) : undefined)

// Variante B: Im Handler
const effectiveMaxTokens = params.max_tokens 
  ? Math.max(params.max_tokens, 500) 
  : undefined;
```

Leitprinzip: Der MCP wird von LLMs konsumiert. Werte die offensichtlich korrigierbar sind, sollten still korrigiert werden statt einen Fehler zu werfen.

---

## UX-001: click — kein Text-basiertes Matching

**Entdeckt:** 2026-04-05 (Live-Nutzung SteuerDB-Anwendung)
**Schwere:** P2 — Mittel (erzeugt 3-5 Extra-Roundtrips)
**Betrifft:** `src/tools/click.ts`
**Status:** GEFIXT (2026-04-07)

### Problem
Das LLM brauchte 3-6 Tool-Calls um einen Button per Text zu klicken (read_page → ref → click, ggf. stale-retry).

### Fix
Neuer `text` Parameter in clickSchema: `click(text: "Submit")`. Intern nutzt `a11yTree.findByText()` die nodeInfoMap — Matching-Prioritaet: exact → case-insensitive → partial substring. Interaktive Rollen (button, link) werden bevorzugt. Wenn kein Match, werden verfuegbare Elemente im Fehler aufgelistet. Kein vorheriges read_page noetig — wenn der A11y-Tree nicht populiert ist, wird er automatisch geholt.

---

## TECH-DEBT-001: AutoLaunch-Verhalten bei HEADLESS=false

**Entdeckt:** 2026-04-05
**Schwere:** Low
**Betrifft:** `src/server.ts`, `src/cdp/chrome-launcher.ts`
**Status:** GEFIXT (Story 10.2) + UEBERHOLT (2026-04-08 — Headed-Default-Inversion)

### Aenderung
Urspruenglich (Story 10.2): Wenn `SILBERCUE_CHROME_HEADLESS=false`, dann `autoLaunch` automatisch `false`. Diese headless↔autoLaunch-Kaskade war fuer die alte "headless-by-default"-Semantik gedacht und machte in der neuen Welt keinen Sinn mehr.

2026-04-08 Inversion: Headless ist jetzt Opt-in (`SILBERCUE_CHROME_HEADLESS=true`), Default ist headed. `resolveAutoLaunch` gibt bei unset Env immer `true` zurueck — unabhaengig von headless. Damit hat ein neuer Nutzer eine echte Zero-Config-UX: installieren, restart, Tool aufrufen, Chrome oeffnet sich sichtbar von selbst.

### Fix
Tests in `src/cdp/chrome-launcher.test.ts`: WebSocket-Fallback, Pipe-Launch, autoLaunch-disabled, env-Variable-Overrides (SILBERCUE_CHROME_AUTO_LAUNCH). CLAUDE.md dokumentiert Connection Modes und Env-Variablen.

---

## FR-001: Scroll-Container in read_page nicht erkennbar — kein Scroll-Tool

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T2.2 Infinite Scroll)
**Schwere:** P1 — Hoch (5 Extra-Roundtrips, haeufiges Pattern)
**Betrifft:** `src/tools/read-page.ts`, `src/cache/a11y-tree.ts`
**Typ:** LLM Friction

### Problem
Bei T2.2 (Infinite Scroll) brauchte das LLM 5 evaluate-Aufrufe um den scrollbaren Container zu finden und zu scrollen:
1. `#t2-2-list` → null (ID geraten)
2. `[class*="scroll"]` → undefined
3. `div[style*="overflow"]` → undefined
4. Brute-Force alle divs mit computed overflow → gefunden: `#t2-2-scroller`
5. Scroll-Loop mit Delays

read_page zeigte `[e227] generic` fuer den Container — kein Hinweis auf Scrollbarkeit, kein Hinweis auf die ID.

### Warum das ein MCP-Problem ist
Das LLM hat keine Moeglichkeit, scrollbare Container zu erkennen oder zu scrollen, ausser ueber evaluate(). Das ist ein generisches Web-Pattern (Infinite Scroll, Chat-Fenster, Log-Viewer) das ohne Scroll-Support immer zu Workarounds fuehrt.

### Fix-Vorschlag
**Option A — read_page Annotation:**
```
[e227] generic (scrollable, id="t2-2-scroller") ← 10 items, more below
```
Scrollbare Container (overflow: auto/scroll + scrollHeight > clientHeight) annotieren.

**Option B — Scroll-Tool:**
```typescript
scroll(ref: "e227", direction: "bottom")  // oder: position: "end"
scroll(selector: "#t2-2-scroller", by: 500)  // px
```

**Option C — Click-Parameter:**
```typescript
click(ref: "e227", scroll: "bottom")  // Scroll-Container vor Click
```

Option A hat den hoechsten Impact bei geringstem Aufwand.

---

## FR-002: click auf target=_blank-Link warnt nicht / oeffnet keinen neuen Tab

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T2.5 Tab Management)
**Schwere:** P1 — Hoch (verursachte Test-Fail)
**Betrifft:** `src/tools/click.ts`
**Typ:** LLM Friction

### Problem
Bei T2.5 klickte das LLM den Link "Open Target Tab" mit dem click-Tool. Der Link hatte `target="_blank"`, aber click navigierte im gleichen Tab. Die Hauptseite ging verloren, der erwartete Test-Wert aenderte sich → Test fehlgeschlagen.

Das LLM musste den Test wiederholen mit `switch_tab(action: "open")`.

### Warum das ein MCP-Problem ist
Das LLM sieht in read_page: `[e245] link "Open Target Tab" → /tab-target.html`. Kein Hinweis auf `target="_blank"`. Der click verhielt sich wie navigate statt wie "neuen Tab oeffnen". Das LLM muss raten, ob es navigate oder switch_tab braucht.

### Fix-Vorschlag
**Option A — Action Result Warnung:**
Wenn click auf einen Link mit `target="_blank"` trifft, im Action Result melden:
```
Clicked link "Open Target Tab" — note: link has target="_blank".
Use switch_tab(action: "open", url: "/tab-target.html") to open in new tab.
```

**Option B — read_page Annotation:**
```
[e245] link "Open Target Tab" → /tab-target.html (opens new tab)
```

**Option C — Automatisches Verhalten:**
click auf `target="_blank"`-Links oeffnet automatisch einen neuen Tab und switched dorthin. Action Result zeigt neuen Tab-Kontext.

Option B ist am effizientesten — das LLM sieht VOR dem Click, dass ein neuer Tab noetig ist.

---

## FR-003: Same-origin srcdoc-iframes unsichtbar in read_page

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T3.2 Nested iFrame)
**Schwere:** P2 — Mittel (2 Extra-Roundtrips)
**Betrifft:** `src/cache/a11y-tree.ts` (OOPIF-Handling, Zeilen 701-753)
**Typ:** LLM Friction

### Problem
read_page zeigte nur `[e69] Iframe` ohne Inhalt. Der iframe nutzte `srcdoc` (same-origin inline), was KEIN OOPIF erzeugt. Das bestehende OOPIF-Handling in a11y-tree.ts greift nicht, weil same-origin srcdoc-iframes im selben Prozess laufen.

Das LLM brauchte 2 evaluate-Aufrufe:
1. `iframe.contentDocument` → fand aeusseren Frame-Inhalt mit verschachteltem srcdoc
2. Parse des srcdoc-HTML → extrahierte "FRAME-X6WGKK"

### Warum das ein MCP-Problem ist
iframes sind ein Standard-Web-Pattern (Eingebettete Widgets, Payment-Forms, Editors). Wenn read_page sie nicht traversiert, muss das LLM immer auf evaluate ausweichen.

### Technischer Hintergrund
`Accessibility.getFullAXTree` liefert KEINE Nodes aus same-origin iframes — nur aus dem Hauptframe. OOPIF-Sessions werden separat abgefragt (Zeile 720-740), aber srcdoc-iframes haben keine eigene Session.

### Fix-Vorschlag
**Option A — Inline-Expansion:**
Wenn der AXTree einen iframe-Node enthaelt und der iframe same-origin ist:
1. CDP `DOM.describeNode` → frameId
2. `Page.getFrameTree` → alle Frames inkl. srcdoc
3. `Accessibility.getFullAXTree` mit frameId-Filter (nicht sessionId)
4. Nodes inline in den Hauptbaum einhaengen

**Option B — Annotation:**
```
[e69] Iframe (same-origin, use evaluate to access content)
```
Mindestens dem LLM signalisieren, dass der iframe lesbar ist.

---

## FR-004: type/click Page Context zu verbose — voller Baum statt lokaler Kontext

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — durchgehend)
**Schwere:** P1 — Hoch (Token-Verschwendung bei jeder Aktion)
**Betrifft:** `src/registry.ts` (Ambient Context Injection, Zeilen 175-230)
**Typ:** LLM Friction

### Problem
Nach jedem `type`-Aufruf wird der volle Page Context (alle interaktiven Elemente) zurueckgegeben. Bei T4.7 (Large DOM, 185 interactive Elements) waren das hunderte Zeilen nur fuer den Context nach einem einzigen type-Call.

**Beispiel:** Nach dem Tippen in T2.1-Input kamen 35 interactive Elements, obwohl nur der benachbarte Verify-Button relevant war. Alle Level-1-Elemente (die schon erledigt waren) erschienen weiterhin.

### Kontrast: click macht es besser
click gibt ein kompaktes "Action Result" mit nur den DOM-Aenderungen:
```
--- Action Result (1 changes) — / ---
 NEW    StaticText "T1.1 pass!"
```
Das ist perfekt — kurz, relevant, actionable.

### Warum das ein MCP-Problem ist
Jeder Token im Context kostet das LLM Aufmerksamkeit und Budget. Irrelevanter Context (Level-1-Buttons waehrend Level-4-Arbeit) verwirrt und verlangsamt.

### Fix-Vorschlag
**Option A — Nur Action Result, kein Page Context bei type:**
type gibt nur den DOM-Diff zurueck (wie click). Wenn das LLM den vollen Baum braucht, ruft es read_page auf.

**Option B — Lokaler Context:**
Statt ALLER interaktiven Elemente nur die Geschwister und Eltern des interagierten Elements:
```
--- Action Result — typed into #t2-1-input ---
 Parent: [e205] T2.1 Wait for Async Content
 Sibling: [e222] button "Verify"
 Sibling: [e224] generic "PENDING"
```

**Option C — Smart Context mit Threshold:**
Wenn die Seite > 30 interactive Elements hat, nur Action Result. Unter 30: voller Context wie bisher.

Option A ist der sauberste Ansatz und konsistent mit click-Verhalten.

---

## FR-005: evaluate gibt undefined bei impliziten Return-Values

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T3.2, T3.3, T3.4, T4.5)
**Schwere:** P2 — Mittel (1 Extra-Roundtrip pro Vorfall)
**Betrifft:** `src/tools/evaluate.ts`, IIFE-Wrapping-Logik
**Typ:** LLM Friction

### Problem
Ausdruecke die als Statement (nicht Expression) geschrieben sind, geben undefined zurueck:

```javascript
// Gibt undefined:
if (el) el.textContent; else { 'fallback'; }

// Gibt den Wert:
el ? el.textContent : 'fallback'
```

Die Tool-Description sagt "top-level const/let/class are auto-wrapped in IIFE to prevent redeclaration errors", aber erklaert nicht wie das den Return-Value beeinflusst.

### Warum das ein MCP-Problem ist
LLMs schreiben natuerlich eher `if/else`-Bloecke als ternaries. Wenn der Rueckgabewert stillschweigend verloren geht, muss das LLM den gleichen Code nochmal mit `return` oder ternary ausfuehren.

### Fix-Vorschlag
**Option A — Smarterer IIFE-Wrapper:**
Letztes Statement automatisch als Return-Value verwenden (wie Node REPL / Chrome Console):
```javascript
// Wrapper-Logik: Wenn letztes Statement ein ExpressionStatement ist,
// automatisch "return" davor setzen
(function() { if (el) return el.textContent; else { return 'fallback'; } })()
```

**Option B — Bessere Tool-Description:**
```
Tip: Use ternary expressions (a ? b : c) or explicit return statements
for reliable return values. if/else blocks may return undefined.
```

Option B ist minimal-invasiv und sofort wirksam.

---

## FR-006: contenteditable-Elemente als "generic" in read_page

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T3.6 Rich Text Editor)
**Schwere:** P3 — Niedrig
**Betrifft:** `src/cache/a11y-tree.ts` (formatLine)
**Typ:** LLM Friction

### Problem
Der contenteditable-Editor in T3.6 erschien als `[e94] generic` — kein Hinweis auf Editierbarkeit. Das LLM wusste nur aus dem Test-Titel ("Rich Text Editor"), dass es ein Editor ist.

### Warum das ein MCP-Problem ist
contenteditable-Elemente brauchen andere Interaktion als normale Inputs (innerHTML statt value, Ctrl+B fuer Bold etc.). Wenn sie nicht als editierbar erkennbar sind, greift das LLM zu Workarounds.

### Technischer Hintergrund
Chrome's AXTree meldet contenteditable-divs als role "generic" wenn kein explizites ARIA-role gesetzt ist. Die Information steckt in den AXNode-Properties (`editable: "plaintext"` oder `editable: "richtext"`).

### Fix-Vorschlag
In `formatLine()`: Wenn AXNode-Properties `editable` enthalten:
```
[e94] generic (contenteditable) value="Hello World"
```

---

## FR-007: Stale-Ref nach Navigation — kein Auto-Recovery

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T2.5 nach Tab-Rueckkehr)
**Schwere:** P2 — Mittel (1 Extra-Roundtrip)
**Betrifft:** `src/tools/element-utils.ts`, `src/cache/a11y-tree.ts`
**Typ:** LLM Friction

### Problem
Nach Navigation (navigate, switch_tab close) sind alle Refs ungueltig. Der Fehler ist gut formuliert:
```
Element e87 not found — refs may be stale after page navigation or DOM changes.
Use read_page to get fresh refs, or use a CSS selector instead.
```
Aber das LLM muss trotzdem einen Extra-Roundtrip machen (read_page oder CSS-Fallback).

### Warum das ein MCP-Problem ist
Die Error-Message ist gut. Aber der Workaround (read_page → neuer ref → retry) kostet 2 Extra-Calls. CSS-Selektoren als Fallback funktionieren, sind aber nicht immer offensichtlich.

### Fix-Vorschlag
**Option A — Auto-Recovery:**
Wenn ein Ref stale ist UND eine eindeutige CSS-ID verfuegbar ist (z.B. `#t2-5-input`):
1. Automatisch read_page ausfuehren
2. Neuen Ref finden der zum alten Element passt (gleiche ID, gleiches Label)
3. Aktion mit neuem Ref ausfuehren
4. Im Result melden: "Ref was stale — auto-recovered via #t2-5-input → e87(new)"

**Option B — Proaktiver Ref-Refresh:**
Nach navigate/switch_tab automatisch `a11yTree.reset()` + `refreshPrecomputed()` ausfuehren, sodass der naechste Tool-Call frische Refs hat.

Option B ist sauberer — switch_tab macht das bereits (laut Explore-Ergebnis). navigate muesste das gleiche tun.

---

## FR-008: Canvas-Elemente komplett opak fuer read_page

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T3.4 Canvas Click)
**Schwere:** P3 — Niedrig (Canvas ist inherent opak)
**Betrifft:** `src/cache/a11y-tree.ts` (formatLine)
**Typ:** LLM Friction
**Status:** GEFIXT (2026-04-07)

### Problem
read_page zeigte nur `[e82] Canvas` — keinerlei Information ueber den Inhalt. Das LLM brauchte 3 evaluate-Aufrufe um den roten Kreis zu finden.

### Fix
Canvas-Annotation in formatLine(): `[e71] Canvas ⚠ Canvas content is pixels, not DOM. Use screenshot(som: true) to see what's inside.` Lenkt das LLM direkt zum bereits implementierten Set-of-Mark Feature (Story 5b.4) statt zu evaluate-Workarounds.

---

## FR-009: Kein observe/poll-Mechanismus fuer Timing-sensitive DOM-Aenderungen

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T4.2 Racing Counter, T4.5 Mutations)
**Schwere:** P3 — Niedrig (evaluate-Workaround funktioniert)
**Betrifft:** `src/tools/observe.ts`
**Typ:** LLM Friction
**Status:** GEFIXT (2026-04-07)

### Problem
Fuer T4.2 (Counter bei Wert 8 capturen) und T4.5 (3 Mutationen in 3 Sekunden sammeln) musste das LLM Promise-basierte evaluate-Aufrufe mit setInterval/setTimeout schreiben. Der erste T4.2-Versuch scheiterte am CDP-Timeout (30s).

### Fix
Neues `observe` Tool mit MutationObserver + Polling Hybrid. Zwei Modi:

**Collect-Modus** (T4.5): Sammelt alle Aenderungen ueber eine Zeitspanne.
```typescript
observe(selector: "#mutation-target", duration: 4000)
// → Text changes (3): MUT-VSS, MUT-EMH, MUT-9S4
```

**Until-Modus** (T4.2): Wartet auf eine Bedingung, optional mit sofortigem Click.
```typescript
observe(selector: "#counter", until: "el.textContent === '8'",
        then_click: "#capture-btn", timeout: 10000)
// → Condition met after 4100ms — value: "8" / Clicked #capture-btn
```

Technisch: `Runtime.callFunctionOn` mit `awaitPromise: true` auf dem resolved Element (ref oder CSS).
MutationObserver fuer DOM-Events + Polling-Fallback fuer CSS-only-Aenderungen.
Max Timeout 25s (unter CDP 30s Limit). Unterstuetzt ref und CSS selector, OOPIF-kompatibel.

---

## FR-010: click(x,y) kein auto-scroll wenn Koordinaten ausserhalb Viewport

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run 9254a969 — T3.4 Canvas Click)
**Schwere:** P1 — Hoch (6 Extra-Calls, 40s verschwendet)
**Betrifft:** `src/tools/click.ts`
**Typ:** LLM Friction
**Status:** GEFIXT (2026-04-06, bab5c23)

### Problem
`click(x: 313, y: 814)` ging ins Leere weil das Canvas-Element nicht im sichtbaren Viewport lag (Viewport-Hoehe war kleiner). Der Klick wurde dispatcht, aber auf den falschen Bereich. Erst nach manuellem `scrollIntoView` + neuen Koordinaten (313, 444) klappte es.

### Fix
click(x,y) nutzt jetzt scroll-kompensierte Koordinaten: Headed-Modus verwendet raw viewport coords, Headless-Modus kompensiert scrollY. Canvas-Click T3.4 funktioniert bei beliebigem Scroll-Zustand.

---

## FR-011: evaluate await-Regression — bestimmte Patterns nicht auto-wrapped

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run 9254a969 — T4.5 Mutations)
**Schwere:** P2 — Mittel (verursacht SyntaxError, LLM muss erneut senden)
**Betrifft:** `src/tools/evaluate.ts` (wrapInIIFE)
**Typ:** Bug-Regression
**Status:** GEFIXT (2026-04-06, 816774a)

### Problem
Fix FR-3 (a60fb4b) hat `wrapInIIFE()` eingefuehrt, das Top-Level `await` erkennt und in async IIFE wrappelt. Aber bestimmte Code-Patterns werden nicht erkannt. In T4.5 trat `SyntaxError: await is only valid in async functions` auf.

### Fix
await-Regex vereinfacht zu `/\bawait\b/` — erkennt jetzt alle Patterns (Destructuring, Parenthesized, MutationObserver+Promise). Jeder Code mit `await` wird in async IIFE gewrapped.

---

## FR-012: read_page Token-Metadata nicht strukturiert

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run 9254a969 — T4.7 Token Budget)
**Schwere:** P2 — Mittel (7 Extra-Calls, 40s — LLM muss Token-Info aus Header-Text parsen)
**Betrifft:** `src/tools/read-page.ts`
**Typ:** LLM Friction
**Status:** GEFIXT (2026-04-06, 816774a)

### Problem
read_page gab Token-Informationen nur als Prosa im Header-Text zurueck. Das LLM konnte diese Zahlen nicht effizient nutzen.

### Fix
Truncation-Warnung mit Original-Token-Anzahl und Tipp. Token-Estimation-Ratio von chars/4 auf chars/3.5 verschaerft (8bb4e1c) fuer zuverlaessigere max_tokens-Durchsetzung.

---

## FR-013: FR-003 Regression — verschachtelte srcdoc-iFrames unsichtbar

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run 9254a969 — T3.2 Nested iFrame)
**Schwere:** P2 — Mittel (3 Extra-Calls)
**Betrifft:** `src/cache/a11y-tree.ts`
**Typ:** Regression

### Problem
FR-003 wurde als GEFIXT markiert, aber read_page(depth=8) zeigt den Inhalt von verschachtelten srcdoc-iFrames immer noch nicht. Der Benchmark T3.2 nutzt:
- Aeusserer iFrame mit `srcdoc` → enthalt inneren iFrame mit `srcdoc`
- `Accessibility.getFullAXTree` traversiert keine same-origin srcdoc-Frames

Das LLM brauchte 3 evaluate-Aufrufe um den Wert aus dem inneren Frame zu lesen.

### Zu pruefen
Was genau hat der FR-003 Fix geaendert? Moeglicherweise nur einfache (nicht verschachtelte) srcdoc-iframes. Der verschachtelte Fall muss separat behandelt werden.

---

## FR-014: switch_tab gibt keine Warnung ueber invalidierte Refs

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run 9254a969 — T2.5 Tab Management)
**Schwere:** P3 — Niedrig (1 Extra-Call, gute Fehlermeldung beim type-Call)
**Betrifft:** `src/tools/switch-tab.ts`
**Typ:** LLM Friction
**Status:** GEFIXT (2026-04-07)

### Problem
Nach `switch_tab(action: "close")` zurueck zum Haupttab sind alle alten Refs ungueltig. Die switch_tab-Response selbst warnte nicht.

### Fix
`STALE_REFS_HINT` wird an alle Responses angehaengt die den aktiven Tab wechseln (open, switch, close mit Tab-Wechsel). Nicht-aktive Tab-Schliessungen (kein Kontextwechsel) erhalten keinen Hint.

---

## FR-015: scroll kein Container-until-Element Support

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run 9254a969 — T2.2 Infinite Scroll)
**Schwere:** P3 — Niedrig (2 Extra-Calls)
**Betrifft:** `src/tools/scroll.ts`
**Typ:** LLM Friction
**Status:** GEFIXT (2026-04-07, 707aff0)

### Problem
Das LLM nutzte evaluate statt scroll fuer Infinite-Scroll, weil scroll kein "scroll Container X bis Element Y erscheint" unterstuetzt.

### Fix
Neue Parameter `container_ref` / `container_selector` in scroll.ts. Scrollt innerhalb eines spezifischen Containers (Sidebar, Modal-Body) statt immer die ganze Seite. Gibt Container-Scroll-Position zurueck (scrollTop/scrollHeight).

---

## FR-016: Stale Ref gibt stille falsche Daten statt Fehler

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run 9254a969 — T2.6 Sort Table)
**Schwere:** P3 — Niedrig (1 Extra-Call)
**Betrifft:** `src/tools/read-page.ts`
**Typ:** LLM Friction
**Status:** GEFIXT (2026-04-07)

### Problem
`read_page(ref="e253")` gab `StaticText "$4.50"` zurueck — ein voellig anderes Element als erwartet. Kein Fehler, keine Warnung.

### Fix
Heuristik in readPageHandler: Wenn `params.ref` gesetzt ist UND `refCount <= 1` UND der Output ein Leaf-Node ist (StaticText, img, separator, none oder <=2 Zeilen), wird eine Warnung angehaengt.

---

## FR-017: press_key kein Target-Focus

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run 9254a969 — T3.5 Keyboard Shortcuts)
**Schwere:** P3 — Niedrig (1 Extra-Call)
**Betrifft:** `src/tools/press-key.ts`
**Typ:** LLM Friction
**Status:** GEFIXT (2026-04-07, 707aff0)

### Problem
Das LLM musste vor press_key manuell per evaluate `.focus()` auf das richtige Element setzen.

### Fix
Neue optionale Parameter `ref` / `selector` in press_key. Fokussiert das Element vor Key-Events. OOPIF-aware via resolveElement + effectiveSessionId. Standard-Verhalten (kein Target) bleibt unveraendert.

---

## BUG-015: screenshot schwarz bei verdecktem Fenster / sekundaerem Monitor (macOS)

**Entdeckt:** 2026-04-07 (Live-Test mit Benchmark-Seite auf sekundaerem Monitor)
**Schwere:** P2 — Mittel (screenshot unbrauchbar, read_page/evaluate funktionieren)
**Betrifft:** `src/tools/screenshot.ts`, macOS Occlusion Tracking
**Typ:** Plattform-Limitation
**Status:** GEFIXT (2026-04-07) — Dual-Layer-Fix

### Problem
`screenshot` liefert schwarze Bilder wenn das Chrome-Fenster auf einem sekundaeren Monitor liegt oder von anderen Fenstern verdeckt ist.

### Fix
Dual-Layer-Ansatz basierend auf Deep Research des Chromium-Quellcodes:

1. **`Emulation.setFocusEmulationEnabled({ enabled: true })`** — Runtime-CDP-Call bei Session-Aufbau. Haelt `visible_capturer_count_ > 0` via `WebContents::IncrementCapturerCount(stay_hidden=false)`, sodass der Renderer im `kVisible`-Zustand bleibt. Implementiert in `server.ts` (Init + Reconnect) und `switch-tab.ts` (activateSession).

2. **`--enable-features=CDPScreenshotNewSurface`** — Chrome-Launch-Flag. Erzeugt neuen Compositor Surface pro Screenshot (`ForceRedraw` + `RequestRepaintOnNewSurface` + `CopyFromSurface`), umgeht Screen-Praesentation. Implementiert in `chrome-launcher.ts` CHROME_FLAGS.

Vollstaendiger Forschungsbericht: `docs/bug-015-screenshot-occlusion.md`

---

## BUG-016: Cross-OOPIF/Tab Ref-Collision in a11y-tree.ts

**Entdeckt:** 2026-04-08 (Benchmark Session 6dd8f7d3 — Free Run 4, @silbercue/chrome@0.2.0)
**Schwere:** P1 — Hoch (silent-wrong click auf falsches Element)
**Betrifft:** `src/cache/a11y-tree.ts`, `src/tools/element-utils.ts`
**Status:** GEFIXT (2026-04-08)

### Problem
Der Assistant klickte bei T2.5 "Tab Management" auf ein Element im Chrome-Webstore-iframe statt auf das beabsichtigte "Pro"-Radio-Button. Die Refs `e257` zeigten in zwei Sessions gleichzeitig auf unterschiedliche Elemente. Die `type`-Call landete im falschen Element, T2.5 schlug fehl, und der LLM wechselte auf evaluate als Defensiv-Fallback (siehe BUG-018).

### Root Cause
`src/cache/a11y-tree.ts:231` nutzte eine globale `refMap: Map<number, number>` mit `backendDOMNodeId` als Key. Via Context7-Recherche (WICG + Chromium Groups): **"BackendNodeIds are unique per-process — duplicate ids across different render processes are possible"**. Out-of-Process iframes (OOPIFs) und neue Tabs laufen in separaten Renderer-Prozessen mit eigenem Namespace. Die zweite `registerNode(42, "oopif-session")` ueberschrieb den Main-Frame-Eintrag leise.

Der Linear-Scan in `SessionManager.getSessionForNode()` lieferte dann die **erste** Session, die die backendNodeId tracked — unter Kollision die falsche.

### Fix (atomic commit)

1. **refMap auf Composite-Key** (`a11y-tree.ts:231`): `Map<string, number>` mit Key `${sessionId}:${backendNodeId}`. `nextRef` bleibt global, sodass Refs `e1, e2, ...` weiter einzigartig im User-Output sind.
2. **reverseMap mit Owner-Tupel**: Value-Typ `{ backendNodeId: number, sessionId: string }` statt nur `number`. Der Lookup liefert in einem Schritt die richtige Session.
3. **Neue Methode `resolveRefFull(ref)`**: zentraler Lookup, eliminiert den SessionManager-Linear-Scan in der Hot-Path. `resolveRef(ref)` bleibt backward-compat als Wrapper.
4. **`_renderSessionId` Instance-Variable**: Wird vor/nach jedem Render-Pass (main + OOPIF) gesetzt via `try/finally`, sodass ~6 Render-Helper (`renderNode`, `renderNodeDownsampled`, `prepareAggregateGroups`, `isRenderableLeaf`) ihre refMap-Lookups ohne Signatur-Aenderung machen koennen.
5. **`getSubtree` routing**: Zieht jetzt die richtige Frame-Node-Liste basierend auf `full.sessionId`, anstatt eine kollisions-faehige `combinedNodeMap` ueber alle Frames zu bauen. (Codex-Review Finding #4)
6. **`removeNodesForSession` safe cleanup**: Prueft `_isBackendNodeIdUsedByOtherSessions` bevor `nodeInfoMap`-Eintraege geloescht werden.
7. **`element-utils.resolveElement`** nutzt `resolveRefFull` und eliminiert den Session-Lookup via `getSessionForNode`.

### Coverage
- 4 neue Tests in `src/cache/a11y-tree.test.ts > BUG-016` (Cross-Session-Isolation, OOPIF-Detach-Survival, switch_tab-Reset, Subtree-Routing).
- 1 neuer Test in `src/tools/element-utils.test.ts` fuer resolveElement mit OOPIF-Session-Routing.
- Bestehende 1100+ Tests bleiben gruen (Backward-compat via `resolveRef` + Linear-Scan-Fallback in `refLookup`).

### Verifikation
`npm run build && npm test` gruen. Manueller Smoke-Test der T2.5-Szene gegen `test-hardest/` steht aus (pending Smoke-Test-Phase).

---

## BUG-017: switch_tab laesst stale refs im Cache

**Entdeckt:** 2026-04-08 (zusammen mit BUG-016 in Session 6dd8f7d3)
**Schwere:** P2 — Mittel (stumme Wrong-Resolution nach Tab-Wechsel)
**Betrifft:** `src/tools/switch-tab.ts`, `src/cache/a11y-tree.ts`
**Status:** GEFIXT (2026-04-08)

### Problem
Nach `switch_tab` blieb die `refMap` im A11y-Cache unveraendert, weil `reset()` nur auf URL-Aenderung getriggert wurde. Refs aus dem vorherigen Tab konnten still-falsch aufgeloest werden, sodass `click(ref: "e5")` im neuen Tab auf ein komplett anderes Element landete.

Der existierende `STALE_REFS_HINT` in `switch-tab.ts:90-91` war appended, aber nicht wahrheitsgemaess — die Refs waren trotz Hint weiter "verwendbar".

### Fix
`src/tools/switch-tab.ts` `activateSession()` ruft nach dem Session-Handover, vor der Overlay-Injection: `a11yTree.reset()`. Loescht alle Refs, refMap, reverseMap, sessionNodeMap, nodeInfoMap und `_renderSessionId`. Der naechste `read_page`-Call baut eine frische Ref-Tabelle.

Der `STALE_REFS_HINT` bleibt aktiv und ist jetzt erstmals wahrheitsgemaess.

### Coverage
Neuer Test in `src/tools/switch-tab.test.ts`: "BUG-017: resets a11y-cache refs after a successful switch" — seedet Refs unter einer Session, ruft switch_tab auf, assertiert dass `a11yTree.hasRefs()` false und `resolveRef("e2")` undefined ist.

### Known Limitation
`a11yTree.reset()` loescht ALLE Refs aller Sessions, nicht nur die des alten Tabs. OOPIFs in anderen Tabs verlieren ihre Refs und muessen per `read_page` neu geladen werden. Akzeptabel fuer V1 — Tab-isolierter Cache ist ein separater Refactor (codex-Review Finding #5, deferred).

---

## BUG-018: LLM Defensive Fallback Spiral zu evaluate

**Entdeckt:** 2026-04-08 (Session 6dd8f7d3, Follow-up von BUG-016)
**Schwere:** P1 — Hoch (20+ verschwendete Tool-Calls pro Spiral-Episode)
**Betrifft:** Tool-Descriptions in `src/registry.ts`, `src/tools/element-utils.ts`, neue Telemetry
**Status:** MITIGATED (2026-04-08, nicht "GEFIXT" weil Behavioral, nicht Code-Bug)

### Problem
Nach einem einzigen Tool-Fehlschlag (Stale-Ref wegen BUG-016) wechselte der LLM fuer ~20 Folge-Calls komplett auf `evaluate(querySelector+click())` — selbst wenn `click`/`type`/`fill_form` danach problemlos funktioniert haetten. Das Muster: Single Fail → "Learned Helplessness" → Defensiv-Workaround via JS.

Konkret in Session 6dd8f7d3: T2.5 fail → T2.6 durch T4.6 alle per evaluate, bis User manuell intervenierte.

### Fix (3-schichtig)

**Schicht 1 — Tool-Description Anti-Fluchtreflex-Hints** (`src/registry.ts`):
- `click`, `type`, `fill_form`: "If X fails with stale-ref, call read_page for fresh refs. Avoid evaluate(querySelector) as default recovery ..."
- `switch_tab`: "After switching, refs from the previous tab are invalid — call read_page FIRST ..."
- `evaluate`: "Good uses: computation, reading values, shadow-root traversal. Bad use: automatic recovery after click/type/fill_form failure ..."

Codex-Review Follow-ups: absolute "DO NOT" zu "Avoid ... as default recovery" abgeschwaecht, legitime Exceptions explizit erlaubt ("Legitimate exception: tests explicitly targeting synthetic event plumbing").

**Schicht 2 — zentraler Fail-Recovery-Hint in `buildRefNotFoundError`** (`src/tools/element-utils.ts`):
`click`, `type`, `fill_form` rufen alle `buildRefNotFoundError` bei Stale-Refs auf. Der Error-String empfiehlt `read_page` fuer fresh refs und warnt explizit vor evaluate-Workarounds.

**Schicht 3 — Cross-Tool Streak-Detector** (`src/telemetry/tool-sequence.ts`):
Neue `ToolSequenceTracker`-Klasse, session-scoped (Story 7.6 parallele Tab-Gruppen sicher). Trackt consecutive `evaluate` calls mit querySelector-Pattern. Bei 3+ im 60s-Fenster: Response-Hint "Warning: N consecutive querySelector-based evaluate calls. Call read_page once for fresh refs ...".
Erfolgreicher `read_page`/`click`/`type`/`fill_form` resettet die Streak implizit (per-session).

### Coverage
- 26 Unit-Tests in `src/telemetry/tool-sequence.test.ts` (inkl. 5 Session-Scoping Tests).
- Snapshot-Tests fuer Description-Strings in `src/registry.test.ts` (regex-basiert).
- Manueller Smoke-Test (Session-Replay) steht aus.

### Known Limitations
- **Silent-Success-Reset**: Ein click ohne wirksamen DOM-Effekt resettet die Streak (codex-Review Finding #2 Commit 2). Akzeptabel fuer V1 — echte Silent-Successes sind selten, und `detectEvaluateAntiPattern` faengt die meisten Anti-Patterns ohnehin ab.
- **querySelector Regex-Heuristik**: False-Positives bei String-Literalen mit `querySelector(`; False-Negatives bei `document['querySelector'](...)` oder Aliasing. Explizit dokumentiert in `tool-sequence.ts` und `tool-sequence.test.ts`.
- **Backward-compat Linear-Scan in `refLookup` / `nodeInfoLookup`**: Wenn weder sessionId noch `_renderSessionId` gesetzt ist, faellt der Lookup auf linearen Scan zurueck. Kollisionsrisiko minimal, weil alle kritischen CDP-Callsites jetzt `resolveRefFull` nutzen und `nodeInfoLookup` von owner-iterierenden Callsites mit expliziter sessionId aufgerufen wird. Codex-Review Finding #2 Commit 3 — deferred fuer spaeteres Hardening.
- **Race: `switch_tab` vs. in-flight `read_page`** (Final Codex Review HIGH #3): Theoretisch kann ein laufender `getTree`-Call nach `a11yTree.reset()` in `switch_tab` noch Refs schreiben, weil beide auf derselben `a11yTree`-Singleton arbeiten. In der Praxis nicht ausnutzbar, weil alle CDP-Calls sequenziell ueber denselben `CdpClient` laufen und der MCP-Server Requests synchron verarbeitet. Ein sauberer Fix waere ein Cache-Generation/epoch-Zaehler, der Writes bei Mismatch verwirft — deferred.

---

## FR-023 bis FR-027: Feature-Gaps aus SC Free Run 5 (2026-04-09, 35-Test-Benchmark)

**Entdeckt:** 2026-04-09 beim frischen 35-Test-Run von SilbercueChrome Free (silbercuechrome-free-run5.json). 30/31 Tests bestanden, alle Fails/Workarounds ehrlich dokumentiert in `marketing/benchmark-numbers.md` und `test-hardest/BENCHMARK-PROTOCOL.md`. Jeder Workaround ist ein konkretes Feature-Gap gegenueber nativen Primitives. Jede Umsetzung wuerde die `evaluate`-Quote und damit die Response-Groessen weiter druecken (heute 33 Calls à ∅ 510 Chars = 16.831 Chars; jede ersetzte Workaround-Gruppe spart 2-5 evaluate-Calls).

### FR-023: Kein natives Drag-and-Drop Primitive

**Schwere:** P2 — Mittel (betrifft HTML5-drag-events, ist Nischen-Use-Case in LLM-gefuehrten Workflows, aber wird im Benchmark T3.3 explizit gemessen)
**Betrifft:** neuer Tool `drag_drop` oder Erweiterung von `click`, vermutlich `src/tools/drag.ts`
**Workaround im Run 5:** DOM-Reorder via `appendChild` in einer Sort-Schleife aus `evaluate` heraus — keine echten Drag-Events. Funktioniert fuer sortable-Listen mit state-unabhaengiger Positionsaenderung, bricht bei Libraries die Drag-Events zum Animieren brauchen (react-beautiful-dnd, @dnd-kit).

### Problem
HTML5-Drag-and-Drop braucht eine Event-Sequenz `dragstart` → `dragenter` → `dragover` → `drop` → `dragend` auf verschiedenen Elementen mit synthetischem `DataTransfer`-Objekt. CDP hat `Input.dispatchDragEvent`, aber es ist experimentell und erfordert drei separate Invocations plus aktives Drag-Tracking. Playwright MCPs `drag` Primitive schlaegt auf denselben Testseiten genauso fehl — Microsoft hat das Problem auch nicht geloest. Keine einfache Fix-Vorlage aus der Konkurrenz verfuegbar.

### Empfohlener Fix
1. Neues Tool `drag_drop(from: Ref, to: Ref, options?: { steps?: number })` mit CDP `Input.dispatchMouseEvent` Sequenz (mousedown → 5-10 mousemoves → mouseup) plus `Input.dispatchDragEvent` fuer native HTML5-Drag. Beide Pfade, automatischer Fallback.
2. Alternative: Erweiterung `click(drag_to: Ref)` — einfacher API-mental, aber semantisch verwirrend.

---

### FR-024: Kein Canvas-Pixel-Helper

**Schwere:** P3 — Niedrig (Nischenfall, T3.4 Benchmark-Test aber selten in realen Workflows)
**Betrifft:** moeglicherweise neuer Tool `canvas_find(ref, color|pattern)` oder `read_page` Canvas-Annotation
**Workaround im Run 5:** `evaluate` mit Canvas `getImageData()`-Pixel-Scan fuer Rot-Zentrum, dann Center-Berechnung und `click(x,y)` mit Koordinaten. Funktioniert zuverlaessig fuer einfarbige Targets, bricht bei Gradients oder mehrfarbigen Shapes.

### Problem
Canvas-Elemente sind aus Sicht von `read_page` / a11y-tree komplett opak. FR-008 hat einen Canvas-Annotation-Hint fuer `screenshot(som: true)` eingebaut, aber das findet nur Canvas-Existenz, nicht Canvas-Inhalte. Fuer Ziele wie "klick den roten Kreis" muss der LLM heute eine Pixel-Scan-Logik schreiben — was `evaluate`-Quote hochtreibt und Tool-Hints zum Anti-Pattern fallen laesst.

### Empfohlener Fix
Entweder:
1. Neues Pro-Tool `canvas_find(ref, { color?: string, text?: string })` das `getImageData` serverseitig macht und {x, y, confidence} zurueckgibt.
2. Oder Integration in `read_page` als optionale Canvas-Inhalte-Annotation bei `filter: 'all'` (OCR fuer Text, Pixel-Cluster fuer einfarbige Shapes).

Niedrige Prio weil Nischenfall — deferred bis ein realer Nutzer es anfragt.

---

### FR-025: `type` kann kein `contenteditable` + Inline-Formatting

**Schwere:** P2 — Mittel (betrifft alle Rich-Text-Editoren: Notion, Quill, TipTap, ProseMirror, contenteditable-divs)
**Betrifft:** `src/tools/type.ts` Text-Dispatch-Logik, moeglicherweise neuer `rich_text`-Parameter
**Workaround im Run 5:** HTML-String direkt ins contenteditable-Element via `evaluate`-DOM-Manipulation setzen, dann `input`-Event dispatchen — statt `type` + `press_key('Control+B')`. Funktioniert direkt, umgeht aber alle Editor-Plugins die auf echte Keyboard-Events hoeren.

### Problem
`type` dispatcht CDP-Keyboard-Events via `Input.insertText` oder `Input.dispatchKeyEvent`. Fuer `<input>` und `<textarea>` funktioniert das perfekt. Fuer `contenteditable` werden die Events zwar ausgeloest, aber inline-Formatierung (bold/italic) muss per `document.execCommand('bold')` oder via expliziten Cursor-Selection + Format-Range gesetzt werden — beides ist aus CDP heraus nicht direkt erreichbar.

Playwright MCP hat dasselbe Problem: Run 2 hat T3.6 auch via `browser_evaluate` mit DOM-Manipulation geloest. Konkurrenz ist hier kein Vorbild.

### Empfohlener Fix
Option A: Neuer Tool `rich_text(ref, html)` der das HTML ins contenteditable-Element setzt und den `input`-Event dispatcht. Einfach, funktioniert fuer die meisten contenteditable-Divs.
Option B: Erweiterung `type(ref, text, { format?: 'bold' | 'italic' | 'underline' })` die vor dem Type `execCommand('bold')` aufruft. Eleganter, aber `execCommand` ist deprecated und wird von modernen Browsers vielleicht bald entfernt.

Empfehlung: **Option A** — expliziter, ehrlicher, keine Deprecation-Falle.

---

### FR-026: `observe` Tool verpasst Mutation-Observer-Changes bei `characterData`

**Schwere:** P1 — Hoch (zentrales Async-Observation-Tool schlaegt bei realem Use-Case fehl)
**Betrifft:** `src/tools/observe.ts` MutationObserver-Konfiguration
**Workaround im Run 5:** Eigene `evaluate`-basierte MutationObserver-Implementierung mit `characterData: true` und manuellen Event-Handler, weil das Produkt-`observe` die Changes nicht erfasst hat. **Das ist ein echter Bug** — der Workaround war nicht geplant.

### Problem
Im Benchmark-Test T4.5 aendert die Seite `<strong>` Text-Inhalte 3x in 3 Sekunden via `characterData`-Mutationen. Der `observe`-Tool mit `collect` hat die Changes nicht angezeigt — der manuelle MutationObserver via `evaluate` hat sie in derselben Session korrekt erfasst. Vermutung: `observe` setzt `characterData: false` oder hat einen Root-Selector der den `<strong>`-Child nicht covered.

### Empfohlener Fix
1. **Reproduktion:** Benchmark-Seite `https://mcp-test.second-truth.com` → Level 4 → T4.5 "Mutation Observer Challenge" starten. `observe(collect, ms: 4000)` vs manueller `evaluate`-Observer vergleichen.
2. **Root Cause:** `src/tools/observe.ts` MutationObserver-Options pruefen. Vermutlich `characterData: false` default. Oder `subtree: false`.
3. **Fix:** `characterData: true, subtree: true` als default setzen. Bei Changes auch `characterData`-Mutations in der Response listen.
4. **Test:** Unit-Test mit synthetischen `characterData`-Mutationen in jsdom oder Playwright Headless.

---

### FR-027: `switch_tab` ist Pro-gated, kein Free-Tier-Tab-Switching

**Schwere:** P2 — Mittel (Free-Tier-Nutzer muessen auf `navigate` + `navigate(back)`-Workaround ausweichen fuer Tab-Workflows)
**Betrifft:** Produkt-Tier-Gate in `src/tools/switch-tab.ts`, ggf. `src/license.ts`
**Workaround im Run 5:** T2.5 "Multi-Tab Management" via `navigate(target-tab-url)` + `navigate(main-url)` + manual URL-tracking statt Tab-Switch. Funktioniert, aber verliert Tab-State (Formulare, Scroll-Position, History).

### Problem
`switch_tab` ist aktuell ein Pro-Feature. Der Free-Tier hat `navigate`, `tab_status`, aber kein `switch_tab`. Das zwingt Free-Nutzer zu Workarounds fuer alle Multi-Tab-Patterns (Link oeffnet neuen Tab → lese dort → komm zurueck → trage Wert ein). Der `navigate(back)`-Workaround funktioniert fuer einfache Read-Back-Flows, aber nicht wenn der neue Tab Formular-Interaktion braucht (Login in Popup-Tab) oder wenn der Ursprungs-Tab State halten muss.

### Empfohlene Entscheidung
Drei Optionen:
1. **`switch_tab` in Free-Tier migrieren** (einfachste, freundlichste Loesung). `virtual_desk` bleibt Pro. Das macht T2.5 im Free-Tier sauber loesbar und vermeidet die `evaluate`-Workaround-Spirale die wir mit BUG-018 bekaempft haben.
2. **Weiter Pro-gated lassen** und die Fuss-Note in T2.5-Feedback schreiben "Pro-Feature". Dann aber explizit im `run_plan` / `observe` / `tool-description`-Layer dokumentieren dass Free-Nutzer `navigate(back)` nutzen sollen statt eigenen `evaluate` zu schreiben.
3. **`switch_tab_readonly`** als Free-Tier-Variante anbieten — kann wechseln, aber nicht neue Tabs erstellen. `virtual_desk` bleibt Pro fuer die Listing-Funktion.

Empfehlung: **Option 1** — einfachste und fairste Loesung, vor allem weil wir gerade mit BUG-018 gegen die evaluate-Fallback-Spirale kaempfen. Pro-Tier differenziert sich trotzdem durch `virtual_desk`, `dom_snapshot`, `run_plan`-parallel-tabs, Ambient-Context-Hooks, Operator-Hooks. `switch_tab` alleine ist kein ausreichendes Pro-Differentiator.

---

### Zusammenhang mit Tool-Efficiency Marketing

Jeder dieser 5 Gaps erzwingt heute einen `evaluate`-Workaround. Im SC Free Run 5 waren **33 evaluate-Calls** — wenn FR-023 + FR-025 + FR-026 gefixt sind, fallen davon geschaetzt 10-15 weg (Drag, RichText, MutationObserver). Das wuerde die "SC evaluate avg 510 Chars"-Zahl noch weiter druecken und damit den Tool-Efficiency-Vorsprung gegenueber Playwright MCP vergroessern. Jeder gefixte Gap ist also auch Marketing-Munition.
