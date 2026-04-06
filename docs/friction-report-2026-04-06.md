# Friction Report — LLM Benchmark Run 2026-04-06

Systematische Analyse aller Stellen, an denen der MCP dem LLM nicht die richtigen Signale gegeben hat.
Quelle: Live-Benchmark-Durchlauf Session `51a1443e-68`, 35 Tests, SilbercueChrome MCP gegen `test-hardest/index.html`.

**Leitprinzip:** Es gibt keine LLM-Fehler. Wenn das LLM etwas Falsches tut, hat der MCP ihm nicht die richtigen Informationen oder Werkzeuge gegeben. Unsere Aufgabe ist es, die Friction zu eliminieren.

---

## Status-Uebersicht

| ID | Titel | Prio | Status | Verschwendete Calls |
|----|-------|------|--------|-------------------|
| FR-001 | switch_tab(close) liefert keinen Kontext ueber das Ziel-Tab | P0 | GEFIXT (af36b81) | 4 + Session-Verlust |
| FR-002 | read_page zeigt Form-Felder nicht bei verschachteltem DOM | P1 | GEFIXT (af36b81) | 3 |
| FR-003 | click auf unsichtbares Element — kryptische Fehlermeldung | P1 | GEFIXT (af36b81) | 2 |
| FR-004 | Refs nach Hash-Navigation ungueltig ohne Warnung | P1 | GEFIXT (63e09bf) | 1 |
| FR-005 | Custom-Dropdown .click() wirkungslos — kein Hinweis | P1 | GEFIXT (63e09bf) | 6 |
| FR-006 | wait_for Timeout ohne Kontext-Hilfe | P2 | GEFIXT (63e09bf) | 1 + 5s Wartezeit |
| FR-007 | evaluate Scope-Sharing verursacht SyntaxErrors | P2 | GEFIXT (af36b81) | 1 |
| FR-008 | click auf nicht-existierenden Selektor — kein Vorschlag | P3 | GEFIXT (63e09bf) | 1 |

---

## FR-001: switch_tab(close) liefert keinen Kontext ueber das Ziel-Tab

**Schwere:** P0 — Kritisch
**Betrifft:** `src/tools/switch-tab.ts`
**Tool-Description:** "Open, switch to, or close browser tabs"
**Verschwendet:** 4 Calls + gesamter Testfortschritt verloren

### Beobachtetes Verhalten (Session-Transkript)

```
# LLM oeffnet neuen Tab fuer T2.5
Call #58: switch_tab(action: "open", url: "http://localhost:4242/tab-target.html")
  → Tab opened: 64DEBDA4A9EDBE3EFBE706D274E0794F
    URL: http://localhost:4242/tab-target.html
    Title: Tab Target

# LLM liest den Wert — korrekt
Call #59: evaluate("document.body.textContent")
  → "...The secret value for this tab is: TAB-Q59M-3ZDF..."

# LLM schliesst den Tab — erwartet: zurueck zum Benchmark-Tab
Call #60: switch_tab(action: "close")
  → Tab closed: 64DEBDA4A9EDBE3EFBE706D274E0794F
    Active tab: DF08A603B8B8976AB2425E157A2BE167
    URL: http://localhost:4242/tab-target.html   ← NEUER ACTIVE TAB, ABER GLEICHE URL?!
    Title: Tab Target

# LLM prueft — falscher Tab!
Call #61: evaluate("document.title")
  → "Tab Target"    ← Nicht der Benchmark-Tab

# LLM schliesst nochmal — hofft auf den richtigen Tab
Call #62: switch_tab(action: "close")
  → Tab closed: DF08A603B8B8976AB2425E157A2BE167
    Active tab: 8935F0E34C64082D8083568ABC7715D8
    URL: https://mcp-test.second-truth.com/    ← Oeffentliche Seite, nicht localhost!
    Title: SilbercueChrome — Test Hardest

# LLM versucht zurueck zu navigieren — Reset
Call #63: evaluate("document.URL")
  → "https://mcp-test.second-truth.com/"

Call #64: navigate("http://localhost:4242")
  → Navigated... aber alle Tests sind zurueckgesetzt (0 PASS)
```

### Warum das LLM scheiterte

1. **Kein Tab-Stack/History:** Das LLM hat keine Information, welcher Tab vorher aktiv war. `switch_tab(close)` schliesst den aktuellen Tab und aktiviert "irgendeinen" — das LLM hat keine Kontrolle.
2. **Response ist mehrdeutig:** Die Response zeigt `Active tab: DF08A603...` — aber nur Tab-ID und URL. Das LLM kann nicht beurteilen ob das der richtige Tab ist, weil es die Tab-ID des Benchmark-Tabs nie erfahren hat.
3. **Kein "return to previous":** Es gibt keine Moeglichkeit zu sagen "schliesse den Tab und kehre zum Tab zurueck, von dem ich kam".

### Was der MCP haette tun muessen

Die Response nach `switch_tab(close)` sollte dem LLM klar zeigen, wo es gelandet ist. Und idealerweise:
- Den `origin_tab` (Tab von dem aus `open` aufgerufen wurde) merken und bei `close` automatisch dorthin zurueckkehren
- Oder: In der `open`-Response mitteilen: "Dein vorheriger Tab war XYZ — nutze switch_tab(action: 'switch', tab_id: 'XYZ') um zurueckzukehren"

---

## FR-002: read_page zeigt Form-Felder nicht bei verschachteltem DOM

**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/read-page.ts`, `src/cache/a11y-tree.ts`
**Tool-Description:** "Read page content via accessibility tree with stable element refs"
**Verschwendet:** 3 Calls

### Beobachtetes Verhalten (Session-Transkript)

```
# LLM will die Formular-Felder sehen um sie auszufuellen
Call #81: read_page(ref: "e38", depth: 3)
  → Subtree for e38 — 0 elements      ← LEER! Nichts drin.

Call #82: read_page(ref: "e63", depth: 3)
  → ERROR: Element e63 not found in current tree.

Call #83: read_page(filter: "interactive")
  → Page: SilbercueChrome — Test Hardest — 10 interactive elements (depth 3)
    [e26] button "Reset All"
    [e8] button "Level 1 — Basics"
    [e9] button "Level 2 �� Intermediate"
    ...
    ← NUR Tab-Buttons! Kein einziges Form-Feld (input, select, textarea)!

# LLM gibt auf, scrollt per evaluate und nutzt fill_form mit CSS-Selektoren
Call #84: evaluate("...scrollIntoView...")
Call #85: fill_form(fields: [{selector: "#t1-3-name", ...}])  ← Workaround
```

### Warum das LLM scheiterte

1. **`read_page(ref: "e38", depth: 3)` liefert 0 Elemente:** Der Subtree-Modus findet das Container-Element, aber bei depth 3 sind die Form-Felder (die in `<div class="test-area"><form><div><input>` verschachtelt sind) nicht erreichbar.
2. **`read_page(filter: "interactive")` zeigt nur Top-Level:** Die 10 interaktiven Elemente sind alle Tab-Buttons der Hauptnavigation. Die Form-Inputs des aktuell sichtbaren Tests fehlen komplett.
3. **Das LLM hatte keine Chance:** Es hat 3 verschiedene Strategien versucht — alle scheiterten. Es gab keinen Hinweis in der Response "Tipp: Erhoehe die Tiefe" oder "Es gibt weitere interaktive Elemente unterhalb des sichtbaren Bereichs".

### Was der MCP haette tun muessen

- `filter: "interactive"` sollte ALLE interaktiven Elemente der Seite liefern, unabhaengig von der Verschachtelungstiefe. Ein Input-Feld 5 Ebenen tief ist genauso wichtig wie ein Button auf Ebene 1.
- Wenn ein `read_page(ref: "eXX")` ein Subtree mit 0 Elementen liefert, sollte die Response hinweisen: "Subtree leer bei depth 3. Das Element hat N Kinder bei depth 6."

---

## FR-003: click auf unsichtbares Element — kryptische Fehlermeldung

**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/click.ts`
**Tool-Description:** "Click an element by A11y-Tree ref (e.g. 'e5') or CSS selector..."
**Verschwendet:** 2 Calls

### Beobachtetes Verhalten (Session-Transkript)

```
# LLM wechselt zu Level 2, will dort den ersten Button klicken
# e51 war der "T1.1 Click Me" Button — existiert im Tree, ist aber display:none
Call #29: click(ref: "e51")
  → click failed: CDP error -32000: Node does not have a layout object

# LLM versucht es nochmal — gleicher Fehler
Call #31: click(ref: "e51")
  → click failed: CDP error -32000: Node does not have a layout object

# LLM wechselt auf CSS-Selektor — Erfolg
Call #32: click(selector: "[data-test='2.1'] button")
  → Clicked [data-test='2.1'] button (css)
```

### Warum das LLM scheiterte

1. **Die Fehlermeldung ist kryptisch:** "Node does not have a layout object" ist eine rohe CDP-Fehlermeldung. Kein LLM versteht, dass dies "Element ist nicht sichtbar (display:none oder aehnlich)" bedeutet.
2. **Das LLM probiert es nochmal:** Weil die Fehlermeldung keine klare Ursache nennt, denkt das LLM vielleicht es war ein Timing-Problem und versucht es erneut.
3. **Kein Vorschlag:** Die Response haette sagen koennen: "Element e51 existiert im DOM, ist aber nicht sichtbar. Moeglicherweise in einem versteckten Tab/Panel."

### Was der MCP haette tun muessen

Die Fehlermeldung uebersetzen:
```
click failed: Element e51 (button 'Click Me') exists but is not visible — 
it has no layout (display:none or hidden). Try scrolling to it or check if 
it's inside an inactive tab/panel.
```

---

## FR-004: Refs nach Hash-Navigation ungueltig ohne Warnung

**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/click.ts`, `src/cache/a11y-tree.ts`
**Verschwendet:** 1 Call + Kontextwechsel auf CSS-Selektoren

### Beobachtetes Verhalten (Session-Transkript)

```
# LLM klickt Alpha-Link — Hash-Navigation nach /#step-alpha
Call #92: click(ref: "e77")
  → Clicked e77 (ref) --- Page Context (8 interactive) — /#step-alpha ---
    ← Page Context zeigt neue URL, aber nur 8 interactive elements (Navigation-Buttons)

# LLM will Beta-Link klicken — Ref ist jetzt ungueltig
Call #93: click(ref: "e78")
  → Element e78 not found. Did you mean e41 (generic '')?
    ← Ref e78 existiert nicht mehr. Vorschlag "e41 generic" ist nutzlos.

# LLM wechselt auf CSS-Selektoren fuer den Rest
Call #94: click(selector: "[data-test='1.5'] a[href='#step-beta']")
  → Clicked (css)
Call #95: click(selector: "[data-test='1.5'] a[href='#step-gamma']")
  → Clicked (css)
Call #96: click(selector: "[data-test='1.5'] button")
  → Clicked (css)
```

### Warum das LLM scheiterte

1. **Hash-Navigation invalidiert den A11y-Tree:** Der Klick auf den Alpha-Link aendert den URL-Hash. Chrome baut Teile des A11y-Trees neu auf. Die alten Refs (e78, e79 etc.) zeigen ins Leere.
2. **Page Context nach Click #92 zeigt nur 8 Elemente:** Die Ambient-Context-Response nach dem Click zeigt die neuen Refs, aber nur die Top-Level-Navigation. Die Link-Refs innerhalb des Tests fehlen.
3. **Der Vorschlag "e41 (generic '')" ist wertlos:** Er hilft dem LLM nicht, das richtige Element zu finden.

### Was der MCP haette tun muessen

- Die Click-Response koennte warnen: "Page hash changed from / to /#step-alpha — element refs may have been invalidated. Consider using read_page to refresh refs."
- Oder: Der Ambient Context nach URL-Aenderung koennte automatisch die interaktiven Elemente im sichtbaren Bereich auflisten, nicht nur die Top-Level-Navigation.

---

## FR-005: Custom-Dropdown .click() wirkungslos — kein Hinweis

**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/click.ts`, `src/tools/evaluate.ts`
**Verschwendet:** 6 Calls (erster Durchlauf T2.4)

### Beobachtetes Verhalten (Session-Transkript)

```
# LLM oeffnet Dropdown, filtert fuer "Rust", sieht das Element
Call #48: evaluate("...innerHTML...") → Dropdown-HTML mit Optionen
Call #49: evaluate("...input.focus(); Tests.t2_4_open(); input.value = 'Rust'; ...")
  → "filtering for Rust"

# LLM prueft: Wurde etwas ausgewaehlt?
Call #50: evaluate("document.getElementById('t2-4-selected')?.textContent")
  → "none"    ← Nichts ausgewaehlt

# LLM inspiziert den Dropdown — er ist offen, "Rust" ist sichtbar
Call #51: evaluate("...dropdown hidden/html/childCount...")
  → {"hidden":false, "html":"<div style=\"padding: 8px 12px; cursor: pointer;\">Rust</div>", "childCount":1}

# LLM klickt auf die Option — KEIN EFFEKT!
Call #52: evaluate("document.querySelector('#t2-4-dropdown div').click(); return ...t2-4-selected...")
  → "none"    ← Immer noch "none"! Click hat nicht gewirkt.

# LLM liest den Source-Code des Select-Handlers
Call #53: evaluate("Tests.t2_4_select?.toString()?.substring(0, 400)")
  → "t2_4_select(lang) { Benchmark.start('2.4'); ... }"

# LLM erkennt: Das Ziel war "Elixir" (nicht "Rust") und ruft direkt die Funktion auf
Call #54: evaluate("R.dropdownTarget")  → "Elixir"
Call #55: evaluate("...t2_4_select('Elixir')...")  → "Elixir"  ← Endlich!
```

### Warum das LLM scheiterte

Zwei separate Probleme:

1. **`.click()` auf dem Dropdown-Item wirkt nicht:** Das Dropdown nutzt Event-Delegation oder einen spezifischen Handler der auf `mousedown`/`pointerdown` hoert, nicht auf `click`. Der programmatische `.click()` feuert ein `click`-Event, aber der Handler reagiert darauf nicht.

2. **Das LLM hat das falsche Ziel ("Rust" statt "Elixir"):** Die Test-Beschreibung und das Ziel (`R.dropdownTarget`) stehen im DOM, aber das LLM hat sie nicht gelesen. `read_page` haette den Zielwert zeigen koennen — oder der Test haette den Zielwert prominenter darstellen muessen.

### Was der MCP haette tun muessen

Fuer Problem 1: Wenn ein LLM `evaluate("...element.click()...")` ausfuehrt und das Element einen Event-Listener hat der nicht auf `click` reagiert, gibt es keine Moeglichkeit das zu erkennen. Aber:
- Ein dediziertes MCP-Tool `click(ref: "eXX")` das die vollstaendige Event-Sequenz (`pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`) dispatcht, waere robuster als `.click()` via evaluate.
- Die Tool-Description von `evaluate` koennte einen Hinweis enthalten: "For clicking elements, prefer the click tool over element.click() — it dispatches the full event chain."

Fuer Problem 2: `read_page` nach dem Tab-Wechsel zu Level 2 haette die Test-Beschreibung zeigen koennen, inkl. des Zielwerts.

---

## FR-006: wait_for Timeout ohne Kontext-Hilfe

**Schwere:** P2 — Mittel
**Betrifft:** `src/tools/wait-for.ts`
**Tool-Description:** "Wait for a condition: element visible, network idle, or JS expression true"
**Verschwendet:** 1 Call + 5 Sekunden Wartezeit

### Beobachtetes Verhalten (Session-Transkript)

```
# LLM wartet auf den Async-Inhalt von T2.1
Call #33: wait_for(condition: "js", 
           expression: "document.querySelector('[data-test=\"2.1\"] .async-result')?.textContent?.length > 0",
           timeout: 5000)
  → Timeout after 5000ms waiting for JS expression to return true. Last evaluation returned: false
```

### Warum das LLM scheiterte

1. **Falscher Selektor:** Die Klasse `.async-result` existiert nicht. Das Element heisst `#t2-1-loaded`. Das LLM hat den Selektor geraten.
2. **Die Fehlermeldung hilft nicht:** "Last evaluation returned: false" — ja, aber WARUM? Das Element existiert nicht? Oder es existiert, hat aber keinen Inhalt? Das LLM muss einen Follow-up evaluate-Call machen um das herauszufinden.

### Was der MCP haette tun muessen

Bei Timeout koennte die Response erweiterte Diagnostik liefern:
```
Timeout after 5000ms. Last evaluation: false.
Debug: document.querySelector('[data-test="2.1"] .async-result') → null (element not found)
Hint: Similar elements in [data-test="2.1"]: #t2-1-load (button), #t2-1-loaded (div), #t2-1-input (input)
```

Das haette dem LLM sofort gezeigt: `.async-result` gibt es nicht, aber `#t2-1-loaded` sieht vielversprechend aus.

---

## FR-007: evaluate Scope-Sharing verursacht SyntaxErrors

**Schwere:** P2 — Mittel
**Betrifft:** `src/tools/evaluate.ts`
**Tool-Description:** "Execute JavaScript in the browser page context and return the result"
**Verschwendet:** 1 Call

### Beobachtetes Verhalten (Session-Transkript)

```
# Erster evaluate-Call deklariert "section"
Call #37: evaluate("const container = document.querySelector('#t2-2-list'); ...")
  → "no container"

# Zweiter evaluate-Call deklariert erneut "section" — CRASH
Call #38: evaluate("const section = document.querySelector('[data-test=\"2.2\"]'); ...")
  → SyntaxError: Identifier 'section' has already been declared

# LLM lernt und wraps in IIFE ab jetzt
Call #39: evaluate("(() => { const s = document.querySelector(...); ... })()")
  → Funktioniert
```

### Warum das LLM scheiterte

1. **Geteilter Scope:** Chrome's `Runtime.evaluate` teilt den globalen Scope zwischen Aufrufen. `const`/`let`-Deklarationen bleiben bestehen. Ein zweites `const section = ...` ist ein SyntaxError.
2. **Kein Hinweis in der Tool-Description:** Die Beschreibung sagt nur "Execute JavaScript in the browser page context and return the result". Kein Wort ueber Scope-Sharing oder die Notwendigkeit von IIFEs.
3. **Das LLM muss es durch Trial-and-Error lernen:** Nach dem Fehler wraps es alles in `(() => { ... })()` — aber der erste Call ist verschwendet.

### Was der MCP haette tun muessen

Zwei Optionen:

**Option A (empfohlen):** Der MCP wraps den Code automatisch in ein IIFE, wenn er Top-Level `const`/`let`/`class`-Deklarationen enthaelt.

**Option B:** Die Tool-Description erweitern:
```
"Execute JavaScript in the browser page context. 
NOTE: The scope is shared across calls — use (() => { ... })() 
to avoid 'already declared' errors with const/let."
```

---

## FR-008: click auf nicht-existierenden Selektor — kein Vorschlag

**Schwere:** P3 — Niedrig
**Betrifft:** `src/tools/click.ts`
**Verschwendet:** 1 Call

### Beobachtetes Verhalten (Session-Transkript)

```
# LLM hat den Wert eingegeben, will jetzt den Verify-Button klicken
Call #106: click(selector: "#t2-1-verify")
  → click failed: Element not found for selector '#t2-1-verify'

# LLM versucht generischeren Selektor
Call #107: click(selector: "[data-test='2.1'] button:last-of-type")
  → Clicked (css)
```

### Warum das LLM scheiterte

1. **Geratener Selektor:** `#t2-1-verify` existiert nicht. Der Button hat keinen speziellen ID — er ist nur ein `<button>` innerhalb der Test-Section.
2. **Kein Vorschlag in der Fehlermeldung:** Die Response sagt "Element not found" — Punkt. Kein Hint welche Buttons stattdessen verfuegbar sind.

### Was der MCP haette tun muessen

Bei "Element not found" fuer CSS-Selektoren:
```
click failed: Element not found for selector '#t2-1-verify'.
Available interactive elements nearby: 
  [e53] textbox 'Enter loaded value...'
  [e54] button 'Verify' (selector: [data-test='2.1'] button:nth-of-type(2))
```

Das haette dem LLM den richtigen Selektor auf dem Silbertablett geliefert.

---

## Naechste Schritte

Die Friction-Punkte werden einzeln abgearbeitet, priorisiert nach Impact:

1. **FR-001** — switch_tab(close): Origin-Tab merken und zurueckkehren
2. **FR-002** — read_page interactive: Alle interaktiven Elemente unabhaengig von Tiefe
3. **FR-003** — click Fehlermeldung: "Node does not have a layout object" uebersetzen
4. **FR-004** — Hash-Navigation: Warnung bei Ref-Invalidierung
5. **FR-005** — Custom-Dropdown: Vollstaendige Event-Sequenz + Tool-Description-Hinweis
6. **FR-006** — wait_for Timeout: Diagnostik mit naechstgelegenen Elementen
7. **FR-007** — evaluate: Auto-IIFE oder Description-Hinweis
8. **FR-008** — click CSS-Fehler: Vorschlaege fuer verfuegbare Elemente
