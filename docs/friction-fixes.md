# LLM Friction Fixes — Implementierungskontext

Aus den Opus 4.6 Benchmark-Runs vom 2026-04-06 (Free) und 2026-04-10 (Pro). Jede Friction enthält alles was zum Fixen nötig ist:
Problem, betroffene Dateien mit Zeilennummern, konkreter Fix-Vorschlag.

Reihenfolge nach Impact (höchster zuerst).

---

## FR-002: click auf target=_blank warnt nicht (P1 — verursachte Test-Fail)

### Problem
LLM klickte Link "Open Target Tab" mit click-Tool. Link hatte `target="_blank"`, aber click navigierte im selben Tab. Hauptseite ging verloren → Test fehlgeschlagen.

read_page zeigte: `[e245] link "Open Target Tab" → /tab-target.html` — kein Hinweis auf neuen Tab.

### Betroffene Dateien

**`src/cache/a11y-tree.ts` — formatLine() (Zeilen 1523-1531)**
Links zeigen nur URL, nicht target:
```typescript
if (role === "link" && node.properties) {
  for (const prop of node.properties) {
    if (prop.name === "url" && prop.value.value) {
      line += ` → ${shortenUrl(String(prop.value.value))}`;
      break;
    }
  }
}
```

**`src/cache/a11y-tree.ts` — extractNodeInfo() (Zeilen 177-196)**
Liest diverse AXNode-Properties, aber KEIN `target`:
```typescript
switch (prop.name) {
  case "expanded": ...
  case "hasPopup": ...
  case "checked": ...
  case "pressed": ...
  case "disabled": ...
  case "focusable": ...
  case "level": ...
}
```

**`src/cache/a11y-tree.ts` — NodeInfo Interface (Zeilen 207-219)**
Kein `target`-Feld definiert.

### Fix
**Ansatz: read_page annotiert target=_blank bei Links**

1. In `formatLine()` nach dem URL-Block (Zeile 1531): Prüfe ob die AXNode-Properties ein `target`-Property enthalten. Wenn `target === "_blank"`, hänge ` (opens new tab)` an:
```typescript
// nach dem URL-Block:
if (role === "link" && node.properties) {
  for (const prop of node.properties) {
    if (prop.name === "url" && prop.value.value) {
      line += ` → ${shortenUrl(String(prop.value.value))}`;
      break;
    }
  }
}
```
→ Erweitern um target-Check. ABER: Chrome's AXTree liefert `target` NICHT als AXProperty.

**Alternative: DOM-basiert über nodeInfoMap**
Das `nodeInfoMap` wird in `fetchVisualData()` befüllt (Zeile 453ff) via `DOMSnapshot.captureSnapshot`. Die Snapshot-Daten enthalten DOM-Attribute. Man könnte `target` dort extrahieren und in `nodeInfoMap` speichern, ähnlich wie `htmlId` (FR-004).

**Konkret:**
- `src/cache/a11y-tree.ts` Zeile ~490: Beim Befüllen der nodeInfoMap das `target`-Attribut des DOM-Nodes lesen
- `NodeInfo` Interface erweitern: `target?: string`
- `formatLine()`: Wenn `role === "link" && info.target === "_blank"` → ` (opens new tab)` anhängen

**Aufwand:** Niedrig — gleicher Mechanismus wie htmlId in FR-004.

---

## FR-004: Page Context nach type zu verbose (P1 — Token-Verschwendung)

### Problem
Nach jedem `type`-Aufruf kommt der volle Page Context mit ALLEN interaktiven Elementen. Bei 185 Elements (T4.7 Large DOM) sind das hunderte Zeilen Context die das LLM nie braucht.

### Betroffene Dateien

**`src/registry.ts` — _injectAmbientContext() (Zeilen 175-252)**
Kernlogik — entscheidet über Context-Injection:
```typescript
// Zeile 206: Gleiche Bedingung für click UND type
if (ACTION_TOOLS.has(toolName) && (elementClass === "widget-state" || elementClass === "clickable")) {
  // DOM-Diff Logik...
}
```

**Zeilen 243-251: Fallback — Compact Snapshot**
Wenn kein DOM-Diff erkannt wird, wird ein Compact Snapshot injiziert:
```typescript
const snapshot = a11yTree.getCompactSnapshot();
result.content.push({ type: "text", text: snapshot });
```

**`src/tools/type.ts` — typeHandler (Zeile 175)**
Klassifiziert Element immer als "clickable" für Textfelder:
```typescript
elementClass: params.ref ? a11yTree.classifyRef(params.ref) : "clickable"
```

### Fix
**Ansatz: type injiziert nur DOM-Diff, keinen Compact Snapshot Fallback**

In `_injectAmbientContext()` (Zeile 206) differenzieren:

```typescript
if (ACTION_TOOLS.has(toolName)) {
  // type: nur DOM-Diff bei widget-state (combobox, autocomplete)
  // click: DOM-Diff bei widget-state UND clickable
  const shouldDiff = toolName === "click"
    ? (elementClass === "widget-state" || elementClass === "clickable")
    : (elementClass === "widget-state");  // type: nur widget-state

  if (shouldDiff && this._waitForAXChange) {
    // ... bestehende DOM-Diff Logik ...
  }
}
```

Und den Compact-Snapshot-Fallback (Zeilen 243-251) ebenfalls nur für click und fill_form:
```typescript
// Fallback: nur für click/fill_form, nicht für type
if (toolName === "type") return;
```

**Effekt:** type gibt nur seine kurze Bestätigung zurück (`Typed "..." into textbox 'Email'`). Wenn das LLM den Seitenstand braucht, ruft es read_page auf.

**Aufwand:** Niedrig — 2 Bedingungen in registry.ts ändern.

---

## FR-001: Scroll-Container nicht erkennbar (P1 — 5 Extra-Roundtrips)

### Problem
T2.2 (Infinite Scroll): LLM brauchte 5 evaluate-Aufrufe um den scrollbaren Container `#t2-2-scroller` zu finden. read_page zeigte nur `[e227] generic`.

### Betroffene Dateien

**`src/tools/visual-constants.ts` — COMPUTED_STYLES (Zeilen 10-13)**
```typescript
export const COMPUTED_STYLES = [
  "display", "visibility", "color", "background-color",
  "font-size", "position", "z-index",
] as const;
```
`overflow` fehlt in der Liste.

**`src/cache/a11y-tree.ts` — fetchVisualData() (Zeilen 457-466)**
`DOMSnapshot.captureSnapshot` wird bereits mit computedStyles aufgerufen:
```typescript
const snapshot = await cdpClient.send<CaptureSnapshotResponse>(
  "DOMSnapshot.captureSnapshot",
  { computedStyles: [...COMPUTED_STYLES], ... },
);
```

**`src/cache/a11y-tree.ts` — Style-Zugriff (Zeilen 509-512)**
Nur display und visibility werden gelesen:
```typescript
const displayVal = this.getSnapshotString(strings, styleProps[0]);
const visibilityVal = this.getSnapshotString(strings, styleProps[1]);
```

**`src/cache/a11y-tree.ts` — formatLine() (Zeilen 1498-1544)**
Kein scrollable-Marker vorhanden.

### Fix
**Ansatz: overflow in COMPUTED_STYLES, scrollable-Annotation in formatLine()**

1. **visual-constants.ts:** `"overflow-y"` zur COMPUTED_STYLES Liste hinzufügen (Index 7)

2. **a11y-tree.ts fetchVisualData():** Beim Lesen der Styles (nach Zeile 512) auch overflow-y lesen:
```typescript
const overflowY = this.getSnapshotString(strings, styleProps[7]);
```

3. **nodeInfoMap erweitern:** `isScrollable?: boolean` — true wenn overflow-y ist `auto` oder `scroll` UND scrollHeight > clientHeight. ACHTUNG: scrollHeight ist im DOMSnapshot nicht direkt verfügbar. Alternative: Nur overflow-y prüfen (ohne scrollHeight-Check).

4. **formatLine():** Nach dem disabled-Block:
```typescript
if (nodeInfo?.isScrollable) {
  line += " (scrollable)";
}
```

**Ergebnis:** `[e227] generic#t2-2-scroller (scrollable)` — LLM weiß sofort dass es scrollen muss und kennt die ID.

**Aufwand:** Mittel — COMPUTED_STYLES erweitern, Style lesen, in nodeInfoMap speichern, in formatLine() annotieren.

---

## FR-005: evaluate undefined bei if/else (P2 — Extra-Roundtrips)

### Problem
```javascript
if (el) el.textContent; else { 'fallback'; }  // → undefined
el ? el.textContent : 'fallback'              // → korrekt
```

### Betroffene Dateien

**`src/tools/evaluate.ts` — wrapInIIFE() (Zeilen 14-75)**
Die IIFE-Wrapping-Logik hat einen Backward-Scan der letzten Zeile:
- Zeilen 39-51: Rückwärts durch lines, zählt Bracket-Depth
- Zeilen 54-66: Wenn Statement-Keyword (if/for/while) mit Trailing-Expression → split und return einfügen
- Zeilen 68-71: Reine Expressions → `return` voranstellen

Das Problem: `if (el) el.textContent; else { 'fallback'; }` wird als if-Statement erkannt, aber die Branches enthalten Expressions ohne `return`.

### Fix
**Ansatz: Bessere Tool-Description (minimal-invasiv)**

Die evaluate Tool-Description in `src/registry.ts` (oder dem Schema) erweitern:
```
Tip: if/else blocks may return undefined — use ternary (a ? b : c)
or explicit return for reliable values.
```

Die IIFE-Wrapping-Logik ist bereits komplex (75 Zeilen Bracket-Tracking). Automatisches Return-Insertion in if/else-Branches wäre fragil und könnte bestehenden Code brechen.

**Aufwand:** Minimal — nur Description-Text ändern.

---

## FR-003: srcdoc-iframes unsichtbar (P2 — 2 Extra-Roundtrips)

### Problem
read_page zeigte `[e69] Iframe` ohne Inhalt. Der iframe nutzte `srcdoc` (same-origin, kein OOPIF).

### Betroffene Dateien

**`src/cache/a11y-tree.ts` — OOPIF-Handling (Zeilen 701-753)**
Nur OOPIF-Sessions (Out-Of-Process IFrames) werden traversiert:
```typescript
const oopifSessions = sessionManager.getAllSessions().filter(s => !s.isMain);
```
Same-origin srcdoc-iframes haben keine eigene Session → werden übersprungen.

**`src/tools/navigate.ts` (Zeile 137):** Einziger Ort wo `Page.getFrameTree` aufgerufen wird.

### Fix
**Ansatz: Annotation als Minimum-Fix**

In `formatLine()`: Wenn `role === "Iframe"`, prüfe ob der iframe same-origin ist und annotiere:
```typescript
if (role === "Iframe") {
  line += " (same-origin, use evaluate to read content)";
}
```

**Vollständiger Fix (aufwändiger):** `Page.getFrameTree` nutzen um srcdoc-Frame-IDs zu finden, dann `Accessibility.getFullAXTree` mit `frameId`-Parameter aufrufen und Nodes inline einbetten.

**Aufwand:** Annotation = Niedrig. Inline-Expansion = Hoch.

---

## FR-007: Stale-Ref kein Auto-Recovery (P2 — 2 Extra-Calls)

### Problem
Nach Navigation sind Refs ungültig. Fehlermeldung ist gut, aber erzwingt manuelles read_page + Retry.

### Betroffene Dateien

**`src/tools/element-utils.ts` — resolveElement() (Zeilen 74-98)**
Ref-Auflösung wirft sofort RefNotFoundError:
```typescript
const backendNodeId = a11yTree.resolveRef(target.ref);
if (backendNodeId === undefined) {
  throw new RefNotFoundError(...);  // Zeile 77
}
```

**`src/cache/a11y-tree.ts` — URL-basierter Reset (Zeilen 615-630)**
Cache wird NUR invalidiert wenn sich die URL ändert — und nur beim nächsten `getTree()`-Aufruf:
```typescript
if (stripHash(currentUrl) !== stripHash(this.lastUrl)) {
  this.refMap.clear();
  this.reverseMap.clear();
  // ...
}
```

### Fix
**Ansatz: Proaktiver Reset nach navigate/switch_tab**

In `src/tools/navigate.ts`: Nach erfolgreicher Navigation `a11yTree.reset()` aufrufen, sodass der nächste Tool-Call (click, type) frische Refs bekommt statt stale Refs.

Alternativ in `resolveElement()`: Wenn RefNotFoundError und ein CSS-Selektor aus der nodeInfoMap ableitbar ist (htmlId vorhanden), automatisch per CSS-Selektor auflösen statt Fehler werfen.

**Aufwand:** Mittel.

---

## FR-006: contenteditable als "generic" (P3)

### Problem
Rich-Text-Editor erschien als `[e94] generic` statt als editierbares Element.

### Betroffene Dateien

**`src/cache/a11y-tree.ts` — formatLine() (Zeilen 1534-1541)**
Nur `disabled` wird aus Properties gelesen. Kein Check auf `editable`.

### Fix
Nach dem disabled-Block in formatLine():
```typescript
// contenteditable marker
if (node.properties) {
  for (const prop of node.properties) {
    if (prop.name === "editable" && prop.value.value &&
        prop.value.value !== "inherit") {
      line += " (editable)";
      break;
    }
  }
}
```

Chrome's AXTree liefert `editable: "plaintext"` oder `editable: "richtext"` für contenteditable-Elemente. Der Wert `"inherit"` bedeutet das Element erbt die Editierbarkeit vom Parent (z.B. Kinder eines contenteditable-Divs) — das sollte nicht annotiert werden.

**Aufwand:** Minimal — 8 Zeilen in formatLine().

---

## FR-008 + FR-009: Canvas opak / kein observe-Tool (P3)

Niedrige Priorität. Canvas ist inherent opak (Pixel, keine DOM-Nodes). Ein observe-Tool wäre nice-to-have aber evaluate-Workarounds funktionieren. Keine konkreten Fixes geplant.

---

## Reihenfolge zum Abarbeiten

| # | Friction | Aufwand | Dateien | Status |
|---|----------|---------|---------|--------|
| 1 | FR-002 target=_blank | Niedrig | a11y-tree.ts (formatLine + nodeInfoMap) | gefixt |
| 2 | FR-004 type verbose | Niedrig | registry.ts (_injectAmbientContext) | gefixt |
| 3 | FR-006 contenteditable | Minimal | a11y-tree.ts (formatLine) | gefixt |
| 4 | FR-005 evaluate hint | Minimal | registry.ts (Tool-Description) | gefixt |
| 5 | FR-001 scrollable | Mittel | visual-constants.ts, a11y-tree.ts | gefixt |
| 6 | FR-003 iframe annotation | Niedrig | a11y-tree.ts (formatLine) | gefixt |
| 7 | FR-007 stale-ref recovery | Mittel | navigate.ts, element-utils.ts | gefixt |
| 8 | FR-018 Cross-OOPIF Ref-Kollision | Hoch | a11y-tree.ts, element-utils.ts | gefixt |
| 9 | FR-019 Stale Refs switch_tab | Mittel | switch-tab.ts | gefixt |
| 10 | FR-020 evaluate Fallback-Spirale | Hoch | registry.ts, tool-sequence.ts, element-utils.ts | gefixt |
| 11 | FR-021 observe click_first/then_click Refs | Mittel | observe.ts (Ref-Resolution + silent-fail fix) | gefixt |
| 12 | FR-022 run_plan press_key | Mittel | registry.ts (_handlers), run-plan.ts (Schema) | gefixt |
| 13 | FR-023 run_plan iFrame | Mittel | a11y-tree.ts (same-origin iframe inlining) | gefixt |
| 14 | FR-025 navigator.webdriver exposed | Niedrig | chrome-launcher.ts, browser-session.ts, navigate.ts, switch-tab.ts | gefixt |
| 15 | FR-026 T4.7 Token-Budget borderline | Mittel | a11y-tree.ts (DEFAULT_INTERACTIVE_MAX_TOKENS + editable skip) | gefixt |

---

## FR-018: Cross-Session Ref-Kollision → Composite-Key (P1 — Session 6dd8f7d3)

### Problem
In der Benchmark-Session 6dd8f7d3 (Free Run 4) klickte der Assistant bei T2.5 Tab Management auf ein falsches Element. Der Assistant beschrieb das Symptom selbst: *"e257 zeigte sowohl auf das 'Pro'-Radio als auch auf einen YouTube-Link aus einem Chrome-Webstore-Drittanbieter-iframe. Dadurch landeten Klicks/Types teilweise im falschen Element."*

### Root Cause
`src/cache/a11y-tree.ts:231` hatte eine globale `refMap: Map<number, number>` mit `backendDOMNodeId` als Key. Verifiziert via Context7-Recherche (WICG + Chromium Groups): **backendNodeId ist pro Renderer-Prozess eindeutig, nicht global**. Out-of-Process iframes laufen in separaten Renderer-Prozessen, sodass Kollisionen moeglich sind und die zweite `registerNode`-Invocation den ersten Eintrag leise ueberschreibt.

Der `SessionManager.getSessionForNode()` Linear-Scan lieferte dann die erste Session mit diesem backendNodeId — unter Kollision die falsche.

### Betroffene Dateien
**`src/cache/a11y-tree.ts`** — refMap auf Composite-Key `${sessionId}:${backendNodeId}`, reverseMap-Value auf `{backendNodeId, sessionId}`, neue `resolveRefFull()` Methode, `_renderSessionId` Instance-Variable fuer Render-Helper, `getSubtree` nutzt Frame-spezifischen nodeMap (Codex CRITICAL #4), `removeNodesForSession` mit safe nodeInfoMap-Cleanup. ~12 touchpoints + 4 neue Tests.

**`src/tools/element-utils.ts:75-80`** — `resolveElement` nutzt `resolveRefFull` statt Session-Linear-Scan.

### Fix-Vorschlag (implementiert)
Composite-Key statt reiner backendNodeId. `nextRef` bleibt global damit User-sichtbare Refs `e1, e2, ...` einzigartig sind. Rendering-Pfade nutzen `_renderSessionId` als implicit scope-Parameter via `try/finally`.

### Rationale / Referenz
Context7 WICG Issue #9 + Chromium Groups: "BackendNodeIds are unique per-process". Gemini Cross-Check zeigt dass Playwright/Puppeteer Session-ID-Exposure **nicht** nutzen (Playwright Issue #32114 WONTFIX), stattdessen Frame+ExecutionContext. Wir bleiben pragmatisch bei sessionId statt frameId weil der `SessionManager` bereits session-basiert ist — ein Refactor zu frameId ist separater Scope.

Siehe auch `docs/research/llm-tool-steering.md` Abschnitt "Anti-Spiral Patterns" fuer den Zusammenhang mit LLM-Behavior nach Tool-Fails.

---

## FR-019: Stale Refs nach switch_tab → Cache-Reset (P2)

### Problem
Nach `switch_tab` blieben alte Refs im A11y-Cache gueltig und konnten auf zufaellige Elemente im neuen Tab "auflosen". Ein `click(ref: "e5")` im neuen Tab landete auf einem komplett anderen Element als gemeint. Der existierende `STALE_REFS_HINT` in `switch-tab.ts:90-91` warnte zwar, aber die Refs blieben trotzdem abrufbar — der Hint war nicht wahrheitsgemaess.

### Betroffene Dateien
**`src/tools/switch-tab.ts`** — `activateSession()` ruft jetzt `a11yTree.reset()` nach dem Session-Handover, vor der Overlay-Injection. Verknuepfung mit BUG-016: Der komplette Reset ist notwendig weil die Composite-Keys des alten Tabs in einem komplett anderen `backendNodeId`-Namespace liegen.

### Fix-Vorschlag (implementiert)
```ts
// BUG-017: Every ref in the a11y-cache belongs to the previous tab's
// document and sits in a completely different backendNodeId namespace.
// Reset the cache so the next read_page builds a fresh ref table —
// this makes the existing STALE_REFS_HINT truthful for the first time.
a11yTree.reset();
```

### Rationale
Selektiver Per-Session-Cleanup wurde evaluiert und verworfen: `nextRef` wuerde fragmentieren (Luecken, verwirrender Output). Performance-Impact ist vernachlaessigbar — O(n) clear, naechster `read_page` baut neu auf.

Known Limitation: OOPIFs in anderen Tabs verlieren ebenfalls ihre Refs (Codex-Review #5). Deferred fuer Tab-isolierten Cache.

---

## FR-020: LLM Defensive Fallback Spiral zu evaluate (P1)

### Problem
In Session 6dd8f7d3 beobachtet: nach **einem einzigen** fehlgegangenen `type`-Call bei T2.5 wechselte der LLM fuer ~20 Folge-Calls komplett auf `evaluate(querySelector+click())`. Selbst Tests die normal per `click`/`type` loesbar waren (T3.3 Drag, T3.4 Canvas, T4.1-T4.6) wurden defensiv per JS umgangen. Muster: *Single Fail → Learned Helplessness → Defensiv-Workaround*.

Erst nach User-Intervention bei T4.7 brach die Spirale.

### Betroffene Dateien

**`src/registry.ts`** — 5 Tool-Descriptions erweitert (`click`, `type`, `fill_form`, `switch_tab`, `evaluate`) mit Anti-Fluchtreflex-Hints. Pattern-Vorlage aus `docs/research/llm-tool-steering.md` Pattern 1 (Negativ-Abgrenzung).

**`src/tools/element-utils.ts` `buildRefNotFoundError`** — zentraler Fail-Recovery-Hint fuer alle Callsites (`click`, `type`, `fill_form`). Statt jedes Tool separat anzupassen, wird der Hint **einmal** am Error-Auslauf formuliert.

**`src/telemetry/tool-sequence.ts`** (NEU) — `ToolSequenceTracker` singleton, session-scoped. Trackt consecutive `evaluate` calls mit querySelector-Pattern. Bei 3+ im 60s-Fenster liefert `maybeEvaluateStreakHint(sessionId)` eine Warnung. Jeder erfolgreiche `read_page`/`click`/`type`/`fill_form` resettet die Streak implizit (per-session via `record(tool, flags, sessionId)`).

**`src/tools/evaluate.ts`**, **`read-page.ts`**, **`click.ts`**, **`type.ts`**, **`fill-form.ts`** — je ein `toolSequence.record(...)` im Success-Pfad, session-scoped.

### Fix-Vorschlag (implementiert, 3-schichtig)
1. **Tool-Descriptions** als erste Verteidigung (wirkt VOR der Tool-Auswahl).
2. **Error-Response-Hints** in `buildRefNotFoundError` als zweite Verteidigung (wirkt bei Tool-Fail).
3. **Runtime-Streak-Detector** als dritte Verteidigung (wirkt wenn Spirale bereits begonnen hat).

### Rationale / Referenz
Pattern 1 (Negativ-Abgrenzung) + Pattern 4 (Response-Qualitaet: Status, Delta, Next-Hints) aus `docs/research/llm-tool-steering.md`. Die Research-Datei identifiziert das `"click → evaluate re-read state"-Antipattern` bereits explizit (Zeile 294). FR-020 ist die Implementierung dieses Patterns im Response-Layer.

Codex-Review Commit 2 hat das Session-Scoping als CRITICAL angemerkt (Story 7.6 parallele Tab-Gruppen). Der Tracker ist seitdem `Map<sessionId, events[]>` statt globalem Array.

### Known Limitations
- Silent-Success-Click (ohne DOM-Effekt) resettet die Streak. Akzeptabel weil selten.
- Regex-basierter querySelector-Detector hat bekannte False-Positives/-Negatives (dokumentiert im Code).
- `STREAK_WINDOW_MS = 60s` ist pragmatisch. Echte Spirale ist Sekunden, 60s verzeiht Human-in-the-Loop-Pausen.

---

## FR-021: observe click_first/then_click unterstuetzen keine Refs (P2 — Pro Run 1, Session 7115251d)

### Problem
T4.5 (Mutation Observer): `observe` wurde 3× versucht — jedes Mal "No changes detected" oder "Element not found". Der LLM stieg auf `evaluate` mit eigenem `MutationObserver`-Setup um, brauchte ~14 Tool-Calls und **147.8s** fuer einen einzigen Test.

### Root Cause (verifiziert via Session-Evidenz)
Die Friction-Beschreibung vermutete ein MutationObserver-Config-Problem (`subtree`/`characterData`). **Das war falsch.** Die MutationObserver-Config war korrekt (`subtree: true`, `characterData: true`).

Das echte Problem: `click_first` und `then_click` in `observe.ts` nutzten inline `document.querySelector(selector)` — das versteht nur CSS-Selektoren, keine Refs (`eN`). Der "Start Mutations"-Button hatte keine CSS-ID, also:
1. `click_first: "#t4-5-start"` → `querySelector` fand nichts → **lautlos uebersprungen** → kein Klick → keine Mutationen
2. `click_first: "e701"` → `querySelector("e701")` returned null → **lautlos uebersprungen** → kein Klick → keine Mutationen

### Fix (implementiert)
1. **Ref-Resolution server-seitig** in `observeHandler`: Wenn `click_first` oder `then_click` dem Ref-Pattern `/^e\d+$/` entspricht, wird via `resolveElement()` ein objectId aufgeloest und als `arguments` an `Runtime.callFunctionOn` uebergeben. Die generierte Funktion empfaengt das Element als Parameter (`clickFirstEl`/`thenClickEl`).
2. **Silent-fail beseitigt**: CSS-Selektoren die nicht matchen werfen jetzt einen Error statt lautlos zu scheitern.
3. **Schema-Descriptions aktualisiert**: `click_first` und `then_click` dokumentieren jetzt "CSS selector or element ref (e.g. 'e5')".

### Betroffene Dateien
**`src/tools/observe.ts`** — `observeHandler` (Ref-Resolution + arguments-Array), `buildCollectFunction` (clickFirstIsArg-Flag), `buildUntilFunction` (clickFirstIsArg + thenClickIsArg), Schema-Descriptions.

**Aufwand:** Mittel — 15 neue Tests, ~100 Zeilen geaendert.

---

## FR-022: run_plan kann press_key-Steps nicht ausfuehren (P2 — Pro Run 1)

### Problem
Bei T3.5 (Keyboard Shortcuts) und T3.4 (Canvas Click) schlug `run_plan` fuer `press_key`-Steps fehl: *"Canvas-Erkennung und press_key in run_plan fehlgeschlagen — mache beides direkt"*. Der LLM musste auf 3 direkte `press_key`-Calls + `scroll` + `screenshot` ausweichen.

### Vermuteter Root Cause
`run_plan` unterstuetzt moeglicherweise `press_key` als Step-Typ nicht oder die Parameteruebergabe (Modifier-Keys wie Ctrl+K) wird nicht korrekt gemappt.

### Root Cause (verifiziert via Session-Evidenz)
`run_plan` dispatcht Steps ueber `registry.executeTool(step.tool, params)`, welches in `_handlers.get(name)` nachschlaegt. `press_key` und `scroll` waren als MCP-Tools registriert (`server.tool()`), aber **nicht** in der `_handlers`-Map. Daher: `Unknown tool: press_key`.

### Fix (implementiert)
1. **`src/registry.ts`** — `_handlers.set("press_key", ...)` und `_handlers.set("scroll", ...)` hinzugefuegt, analog zu den anderen Interaction-Tools. Beide mit `sessionIdOverride`-Support fuer Story 7.6 parallel tab execution.
2. **`src/tools/run-plan.ts`** — Step-Schema `tool`-Description aktualisiert: `"(e.g. 'click', 'type', 'press_key', 'navigate', 'scroll')"` statt nur `"(e.g. 'navigate', 'click', 'type')"`.
3. **5 neue Tests** in `registry.test.ts` (4) und `plan-executor.test.ts` (1).

**Aufwand:** Niedrig — 6 Zeilen Code + Schema-Update + Tests.

---

## FR-023: run_plan kann iFrame-Inhalt nicht lesen (P3 — Pro Run 1)

### Problem
T3.2 (iFrame Read): `run_plan`-Step zum Lesen des iFrame-Werts schlug fehl. Workaround: 3 separate `evaluate`-Calls mit `contentDocument`-Traversal.

Zusammenhang mit FR-003 (srcdoc-iframes unsichtbar): `read_page` sieht den iFrame als opakes Element, und `run_plan` kann intern keinen `evaluate`-Zugriff auf Frame-Content ausfuehren.

### Root Cause (verifiziert via Session-Evidenz)
`run_plan` KANN evaluate-Steps ausfuehren — das war nicht das Problem. Das echte Problem: `read_page` zeigte iframe-Inhalt nicht, also musste das LLM blind per evaluate die DOM-Struktur erraten. Erster Versuch `#t3-2-inner-frame` schlug fehl (Selektor existiert nicht), danach 3 Extra-Evaluates zum Erkunden.

### Fix (implementiert)
Same-origin iframe AX-Trees inline in `read_page` anzeigen — analog zum bestehenden OOPIF-Handling:

1. **`src/cache/a11y-tree.ts` — `getTree()`**: Nach OOPIF-Block ruft `Page.getFrameTree()` auf, sammelt rekursiv same-origin Child-Frames (`about:srcdoc`, `about:blank`, matching `securityOrigin`), fetcht deren AX-Trees via `Accessibility.getFullAXTree({ frameId })` auf der Main-Session, registriert Refs mit Main-SessionId als Composite-Key.
2. **`src/cache/a11y-tree.ts` — `formatLine()`**: Iframe-Annotation von `"(use evaluate to access iframe content)"` auf `"(content shown below)"` geaendert.
3. **8 neue Tests** in `a11y-tree.test.ts`.

**Effekt:** Vorher ~5 Calls (1 run_plan + 3 evaluate + 1 run_plan) fuer T3.2. Nachher: 1 read_page + 1 fill_form + 1 click = 3 Calls.

**Aufwand:** Mittel — ~120 Zeilen Code + 8 Tests.

---

## FR-024: read_page Token-Profil Pro vs Free — Beobachtung (Info)

### Beobachtung
`read_page` avg Chars bei Pro: **8.310** (P95: 20.357) vs Free: **1.124** (P95: 2.495). Pro liefert **7.4× mehr Daten pro read_page-Call**. `read_page` dominiert das Token-Budget: 108k von 224k Total (48%).

Das ist kein Bug — Pro liefert reichhaltigere AX-Trees mit mehr Details. Aber die Tool-Efficiency-Zahlen sind dadurch nicht direkt mit Free vergleichbar. Pro hat weniger Calls (88 vs 151, -42%) aber dickere Responses (590 vs 201 Tok est avg).

### Implikation fuer Vergleiche
Die Tabelle 2 (Tool-Efficiency) sollte bei Pro-vs-Free-Vergleichen die unterschiedliche Informationsdichte beruecksichtigen. Die **Token-per-Test-Metrik** waere ein besserer Vergleichswert als rohes Avg-Response: Pro ~7.2k Tok/Test (224k/31) vs Free ~4.0k Tok/Test (125k/31) — Faktor 1.8×, nicht 7.4× wie das rohe read_page avg suggeriert.

---

## Fazit Pro Run 1 (2026-04-10, Session 7115251d)

**100% Pass-Rate (31/31)** — perfekter Run, kein einziger Test fehlgeschlagen.

**Pro vs Free Vergleich:**
- **Calls:** 88 vs 151 (-42%) — Hauptfaktor ist `run_plan`, das mehrere Einzel-Calls buendelt
- **Pass-Rate:** 100% vs 97% (31/31 vs 30/31) — Free scheiterte an T4.7 Token-Budget (Runner-Only)
- **Dauer:** 568s vs 598s (-5%) — aehnlich, kein dramatischer Unterschied
- **Token-Delta:** 14.42M vs 26.48M (-46%) — signifikant weniger Token-Verbrauch

**Effizienz-Highlights:**
- `run_plan` war der Schluessel: Level 1 komplett in 1 run_plan (16 Steps), Level 2 in 5 run_plans
- `observe` mit `until` + `then_click` loeste Timing-kritische Tests (T4.1, T4.2) zuverlaessig
- `switch_tab` + `virtual_desk` (Pro-Features) loesten T2.5 nativ — Free brauchte navigate-Workaround

**Schwachstellen:**
- **T4.5 ist der teuerste Test** (147.8s, ~14 Calls) wegen observe-Limitations bei MutationObserver → FR-021
- **run_plan hat blinde Flecken**: press_key (FR-022) und iFrame-Zugriff (FR-023) werden nicht unterstuetzt
- **read_page bei Pro sehr token-hungrig**: 8.3k avg Chars — doppelt so viel wie Playwrights `browser_snapshot` (6.1k avg)

---

## FR-025: navigator.webdriver exposed via CDP (P1 — konsistenter Fail Run 2+3)

### Problem
T5.2 prueft ob `navigator.webdriver` den Wert `false` hat. CDP setzt `navigator.webdriver = true` — das ist Chrome-Standard bei DevTools-Verbindungen. In Run 1 hat das LLM den Wert zufaellig per `evaluate` maskiert (Teil der Testloesung), in Run 2 und Run 3 nicht → konsistenter Fail.

### Betroffene Dateien
Session-Initialisierung — dort wo wir uns mit Chrome verbinden und die erste Page-Interaktion aufbauen. Vermutlich `src/session/session-manager.ts` oder `src/chrome/chrome-launcher.ts` — je nachdem wo `Page.addScriptToEvaluateOnNewDocument` am besten platziert wird.

### Fix (implementiert, 2-schichtig)

**Schicht 1 — Chrome-Launch-Flag (primaere Verteidigung, Auto-Launch-Modus):**
`--disable-blink-features=AutomationControlled` in `src/cdp/chrome-launcher.ts` CHROME_FLAGS. Deaktiviert `navigator.webdriver` auf Chromium-Ebene. Greift nur bei Auto-Launch (Standard-Modus, Zero-Config). Das ist der Benchmark-relevante Fix.

**Schicht 2 — Defense-in-Depth (best-effort fuer WebSocket-Modus):**
- `Page.addScriptToEvaluateOnNewDocument` in `browser-session.ts` und `switch-tab.ts` — registriert webdriver-Override fuer zukuenftige Dokumente
- `Runtime.evaluate` in `browser-session.ts`, `navigate.ts` und `switch-tab.ts` — wendet Override sofort auf aktuelles Dokument an

### Known Limitation: WebSocket-Modus
Im WebSocket-Modus (User-Chrome auf Port 9222) greift weder der Launch-Flag noch die Script-Injection zuverlaessig. Chrome's nativer `navigator.webdriver`-Getter wird nach unseren Overrides zurueckgesetzt. Fuer WebSocket muss der User Chrome mit `--disable-blink-features=AutomationControlled` starten. Fuer den Benchmark (Auto-Launch aus /tmp) ist das irrelevant — der Launch-Flag loest T5.2.

### Betroffene Dateien
- `src/cdp/chrome-launcher.ts` — Launch-Flag
- `src/cdp/browser-session.ts` — addScriptToEvaluateOnNewDocument + Runtime.evaluate
- `src/tools/navigate.ts` — Runtime.evaluate nach Settlement
- `src/tools/switch-tab.ts` — addScriptToEvaluateOnNewDocument + Runtime.evaluate
- `src/cdp/chrome-launcher.test.ts` — Flag-Assertion
- `src/tools/switch-tab.test.ts` — CDP-Call-Assertions

---

## FR-026: T4.7 read_page interactive Token-Budget borderline (P2 — Run 2 Fail, Run 1 knapp)

### Problem
T4.7 (Large DOM) hat ein Token-Budget von 2000 fuer `read_page` im interactive-only Modus. Run 1: 1899 Tok (PASS, 5% unter Budget). Run 2: 2571 Tok (FAIL, 28% ueber Budget). Die Schwankung kommt vom randomisierten DOM — manchmal mehr, manchmal weniger interaktive Elemente.

### Betroffene Dateien
**`src/cache/a11y-tree.ts` — formatLine() und getCompactSnapshot()**
Die Interactive-Mode-Ausgabe koennte kompakter sein:
- Jede Zeile hat Prefix `[eN] role "name"` — der Name koennte bei langen Labels gekuerzt werden
- Redundante Annotationen (z.B. `(scrollable)`, `(opens new tab)`) koennten im interactive-only Modus wegfallen
- Hierarchie-Einrueckung mit 2 Spaces pro Level summiert sich bei tiefen DOMs

### Fix (implementiert)
1. **DEFAULT_INTERACTIVE_MAX_TOKENS = 2000:** Neuer Default fuer `filter: "interactive"` in `getTree()`. Wenn kein explizites `max_tokens` gesetzt wird, greift bei interactive-only das 2000-Token-Budget. Der bestehende Downsampling-Mechanismus (`downsampleTree`, `truncateToFit`) komprimiert automatisch: grosse Subtrees werden zu `... (N elements omitted)` zusammengefasst. Normale Pages (<100 interaktive Elemente) bleiben unberuehrt.

2. **Bonus: `(editable)` bei textbox entfernt:** Textboxen sind per Definition editierbar — die Annotation war redundant und verschwendete ~10 Chars pro Textbox.

### Verifiziert
T4.7 empirisch getestet: 267 interaktive Elemente, roher Output ~2737 Tokens → nach Downsampling ~1884 Tokens (unter Budget). Kein Informationsverlust — das LLM kann per `read_page(ref)` in kollabierte Sections expandieren.

### Betroffene Dateien
- `src/cache/a11y-tree.ts` — `DEFAULT_INTERACTIVE_MAX_TOKENS`, effectiveMaxTokens-Berechnung, `(editable)` skip fuer textbox
