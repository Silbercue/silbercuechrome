# LLM Friction Fixes — Implementierungskontext

Aus den Opus 4.6 Benchmark-Runs vom 2026-04-06 (Free) und 2026-04-10 (Pro). Jede Friction enthält alles was zum Fixen nötig ist:
Problem, betroffene Dateien mit Zeilennummern, konkreter Fix-Vorschlag.

Reihenfolge nach Impact (höchster zuerst).

> **Hinweis (2026-04-11):** Alle FR-Eintraege in diesem Dokument gehoeren
> rueckwirkend zu **Epic 18 — Vorbereitung Operator Phase 1**. Neue
> Friction-Fixes werden weiter in diese Datei eingetragen und bleiben Teil
> von Epic 18, bis Epic 19 startet. Siehe
> `_bmad-output/planning-artifacts/sprint-change-proposal-2026-04-11-operator.md`
> fuer den strategischen Kontext.

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
| 16 | FR-027 scroll IntersectionObserver | Mittel | scroll.ts (async settle-wait) | gefixt |
| 17 | FR-028 natives Drag&Drop | Hoch | drag.ts (neues Tool), registry.ts | gefixt |
| 18 | FR-029 click Ambient Context AJAX-Race | Mittel | registry.ts (FR-029-Hint + Streak-Detector) | gefixt |
| 19 | FR-030 Benchmark aus /tmp | Niedrig | benchmarkTest SKILL.md (Session-Hygiene) | gefixt |
| 20 | FR-031 Cross-Platform Binaries | Mittel | scripts/build-binary-linux.sh, publish.ts | gefixt |
| 21 | FR-032 Memory aufraemen | Minimal | MEMORY.md (Historisch-Abschnitt) | gefixt |
| 22 | FR-033 Ambient Context pro Step in run_plan | Mittel | registry.ts, plan-executor.ts, run-plan.ts | gefixt |
| 23 | FR-034 Step-Response-Aggregation in run_plan verbose | Mittel | plan-executor.ts | gefixt |
| 24 | FR-035 Tool-Definition-Overhead zu gross (20 → 10) | Hoch | registry.ts | gefixt |
| 25 | FR-036 Geister-Refs hinter Modal-Overlays | Hoch | a11y-tree.ts | gefixt |
| 26 | FR-037 LLM-Denkzeit-Luecke nach navigate/click | Gross | registry.ts, a11y-tree.ts | gefixt |
| 27 | FR-038 Tool-Rename view_page/capture_image | Niedrig | registry.ts, Tools | gefixt |
| 28 | FR-039 Click-Diff priorisiert StaticText | Minimal | a11y-tree.ts | wontfix |
| 29 | FR-040 Pro-Hook ignoriert type/fill_form Diff | Mittel | ambient-context.ts (Pro), default-on-tool-result.ts | gefixt |
| 30 | FR-041 CDP Session stirbt → kein Auto-Reconnect, LLM-Loop | Mittel | virtual-desk.ts, tab-state-cache.ts, chrome-launcher.ts | gefixt |

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

---

## FR-027: scroll-Tool triggert IntersectionObserver nicht zuverlaessig (P1) — GEFIXT

### Problem
T2.2 Infinite Scroll braucht in fast jedem Run einen evaluate-Workaround (`scrollTop`-Reset + inkrementelles JS-Scroll), weil das native `scroll`-Tool den IntersectionObserver auf dem Sentinel-Element nicht triggert. Das `scroll`-Tool setzt `scrollTop` direkt oder dispatcht CDP `Input.dispatchMouseEvent` Wheel-Events — beides reicht nicht, um die Observer-Callback auszuloesen.

IntersectionObserver ist auf echten Webseiten ueberall: Lazy Loading, Infinite Scroll, Analytics, Sticky Headers. Das ist der groesste Real-World-Friction — nicht nur ein Benchmark-Problem.

### Root Cause
`scrollBy()` ist synchron, aber IntersectionObserver-Callbacks feuern erst im naechsten Rendering-Frame (nach dem JS-Callstack). Lazy-Load-Logik in der Observer-Callback (fetch + DOM-Insert) braucht weitere Millisekunden. Sowohl Container-Scroll (`Runtime.callFunctionOn`) als auch Page-Scroll (`Runtime.evaluate` mit `awaitPromise: false`) kehrten sofort zurueck bevor DOM-Updates stattfanden.

### Fix (2026-04-10)
**`src/tools/scroll.ts`:**
1. Container-Scroll: `functionDeclaration` zu `async function` geaendert, `awaitPromise: true` gesetzt
2. Page-Scroll: Expression zu async IIFE geaendert, `awaitPromise: true` gesetzt (war `false`)
3. Beide Pfade: Post-Scroll-Settle eingebaut — doppeltes `requestAnimationFrame` (garantiert nach Paint, IO-Callbacks gefeuert) + `MutationObserver` mit 150ms Timeout-Fallback (wartet auf DOM-Insert durch Lazy Load)
4. `prevScrollHeight` vor dem Scroll erfasst, nach Settle verglichen — wenn scrollHeight gewachsen ist, wird das in der Response kommuniziert: `"(content loaded: scrollHeight grew by Npx)"`

**Tests:** 7 neue Tests in `src/tools/scroll.test.ts` — awaitPromise:true, async function/IIFE, rAF+MO im Snippet, scrollHeight-Growth-Reporting fuer Page und Container.

---

## FR-028: Natives Drag&Drop-Primitive via CDP — gefixt (Story 18.6)

### Problem
T3.3 Drag&Drop wurde per `evaluate` mit `appendChild`-Reorder geloest. Das funktioniert auf der Benchmark-Seite (Vanilla JS), bricht aber auf React/Vue/Angular-Seiten weil der Framework-State nicht aktualisiert wird — das DOM stimmt, aber der Component-State ist out of sync. Playwright hat ein natives `drag`-Primitive; ein echtes CDP-basiertes Drag braucht eine `Input.dispatchMouseEvent`-Sequenz (mousedown auf Source → interpolierte mousemove → mouseup auf Target) mit korrekter `buttons:1`-Semantik, damit Chromium die HTML5-Drag-Events (`dragstart`, `dragover`, `drop`) automatisch feuert.

### Root Cause
Kein natives Tool im Werkzeugkasten. Der `evaluate`-Workaround dispatchte `dragstart`/`drop`-Events entweder mit falschem Event-Objekt (keine echten Koordinaten, kein DataTransfer) oder umging die Framework-Listener komplett durch direkten DOM-Reorder — beides bricht auf Framework-Pages.

### Fix (Story 18.6)
Neues Tool **`drag`** in `src/tools/drag.ts`. Die CDP-Event-Sequenz ist:

1. `DOM.getContentQuads` fuer Source und Target → Viewport-Koordinaten via Mittelpunkt-Formel (identisch zum Muster in `click.ts:96-108`)
2. `Input.dispatchMouseEvent({ type: "mousePressed", buttons: 1 })` auf Source
3. N interpolierte `Input.dispatchMouseEvent({ type: "mouseMoved", buttons: 1 })` zwischen Source und Target (Default 10, min 5 — unter 5 erkennen moderne Drag-Libs die `dragover`-Events nicht zuverlaessig)
4. `Input.dispatchMouseEvent({ type: "mouseReleased", buttons: 0 })` auf Target

Die `buttons: 1`-Flag waehrend der `mouseMoved`-Phase signalisiert dem Rendering-Engine, dass die Maustaste gedrueckt ist — Chromium dispatcht `dragstart`/`dragover`/`drop`-Events automatisch, wenn das Source-Element `draggable="true"` hat. Keine manuellen HTML5-Drag-Event-Dispatches im Default-Pfad.

### Tool-Budget-Entscheidung
`drag` ist **NICHT** im Default-Tool-Set (`DEFAULT_TOOL_NAMES` in `src/registry.ts:89`). Story 18.3 hat das Default-Set auf 10 Tools verschlankt; Drag ist eine Nische-Operation (Kanban, Slider, Reorder), die im Default-Set den Tool-Definition-Overhead nicht rechtfertigt. Das Tool ist nur via `SILBERCUE_CHROME_FULL_TOOLS=true` ueber `tools/list` sichtbar — der `_handlers`-Dispatcher haelt den Handler aber unabhaengig davon bereit, damit `run_plan` das Tool weiter aufrufen kann.

**Zahlen:** Full-Set steigt von 21 auf 22 Tools. Default-Set bleibt stabil bei 10.

### Betroffene Dateien
- `src/tools/drag.ts` — neues Tool
- `src/tools/drag.test.ts` — 9 Unit-Tests (Happy-Path, Interpolation, Error-Pfad, Validation, RefNotFoundError-Mapping)
- `src/registry.ts` — Tool-Registrierung via `maybeRegisterFreeMCPTool("drag", ...)` (FULL-Set-only) und `_handlers.set("drag", ...)` fuer `run_plan`-Dispatch
- `src/pro-feature-gates.regression.test.ts` — Sanity-Guard auf Default=10, Full=22
- `src/registry.test.ts` — 3 Count-Assertions von 21 auf 22 aktualisiert

### Framework-Kompatibilitaet (Scope-Hinweis, nach Code-Review 2026-04-11 geschaerft)

Die reine CDP-Mouse-Event-Sequenz deckt ab:
- **Vanilla JS mousedown/mousemove/mouseup-Handler** (Benchmark-Seite T3.3 im Mouse-Modus)
- **CSS-basierte Drag-Operationen:** Slider-Thumbs, Resize-Handles, Text-Selection, CSS-Grid-Drag
- **SortableJS im Mouse-Modus** (nicht der HTML5-Modus)
- **Custom-Mouse-basierte Drag-Listen**, die auf Mouse-Events statt auf den HTML5-Drag-API-Stack setzen

**NICHT abgedeckt** (Scope-Reduktion nach Code-Review 2026-04-11): Die HTML5 Drag&Drop API (`draggable="true"` mit `dragstart`/`dragover`/`drop`-Events) wird durch eine reine CDP-`Input.dispatchMouseEvent`-Sequenz NICHT automatisch ausgeloest — Chromium braucht `Input.dispatchDragEvent` fuer diesen Event-Pfad. Damit sind **nicht** abgedeckt:
- React DnD mit `HTML5Backend`
- Vuedraggable / SortableJS im HTML5-Modus
- ng2-dnd / Angular CDK drag-drop

Die Tool-Description und der Header-Kommentar in `src/tools/drag.ts` dokumentieren diese Limitation explizit. Ein `drag.test.ts`-Test (`"HTML5 drag limit: ..."`) dient als Regression-Guard. Der HTML5-Pfad ist als Folge-Arbeit in `docs/deferred-work.md#fr-031b` festgehalten — dort auch der Implementierungs-Skizze-Vorschlag mit `Input.dispatchDragEvent`.

**Aufwand:** Hoch — CDP-Drag-Events sind notorisch fragil, daher 12 Unit-Tests mit Mock-CDP-Zaehlern fuer die Event-Sequenz (9 urspruenglich + 3 im Review-Follow-up: Happy-Path Ref→Ref, M4 steps-Guard, M1 HTML5-Limit-Regression).

**Source:** Story 18.6 (`_bmad-output/implementation-artifacts/18-6-friction-fix-batch-fr-028-aufwaerts.md`).

---

## FR-029: Ambient Context nach click zu frueh bei AJAX-Updates — gefixt (Story 18.6)

### Problem
`settle()` wurde aus click entfernt (Performance-Gewinn). Das Ambient-Context-Diff wird jetzt sofort nach dem CDP-mouseup berechnet. Bei Seiten, die nach Click einen asynchronen Request starten (AJAX, Fetch, SPA-Route-Change), kommt das Diff zu frueh — es zeigt den alten Zustand statt des neuen. Im Benchmark faellt das nicht auf, weil die Testseite synchron reagiert. Auf echten SPAs mit 200–500 ms-APIs ist das ein Problem: der LLM denkt, der Click hat nichts bewirkt, und klickt nochmal oder wechselt auf `evaluate`.

### Root Cause
Der `onToolResult`-Hook in `src/registry.ts` haengt nur dann einen Diff-Text an, wenn `formatDomDiff` non-empty ist (siehe `src/hooks/default-on-tool-result.ts:138`). Bei leerem Diff gibt es gar keinen Hint — der LLM sieht nur `"Clicked e1 (ref: e1)"` und nichts sonst. Der Prefetch-Slot aus Story 18.5 warmt den **naechsten** `read_page`-Cache, aendert aber die click-Response selbst nicht. FR-029 ist orthogonal und schliesst genau diese Luecke.

### Fix (Story 18.6)
Free-Repo-lokale Hint-Injection in `_runOnToolResultHook` nach dem Pro-Hook-Merge. Bedingungen:

1. Tool-Name ist `click`
2. `result.isError !== true`
3. `_meta.elementClass` ist `"clickable"` oder `"widget-state"` (andere Klassen wie `"static"` oder `"disabled"` haben legitime No-Op-Clicks)
4. Der Content-Array enthaelt nach dem Hook-Merge genau einen Text-Block (= Pro-/Default-Hook hat keinen Diff-Text angehaengt, weil `formatDomDiff` leer zurueckgab)
5. Der Streak-Detector hat den Hint in dieser Session noch nicht gezeigt

Hint-Text:

> No visible changes yet — the page may still be loading (AJAX/SPA). Use wait_for(condition: 'network_idle') or call read_page again to check.

Der Hint wird als separater Text-Block per `result.content.push({ type: "text", text: FR029_AJAX_RACE_HINT })` angehaengt. Keine `isError`-Aenderung, kein `_meta.warning`-Feld.

### Streak-Detector (Anti-Spiral)
Der Hint wird **pro Session** genau einmal gezeigt. Ein zweiter Click mit leerem Diff bekommt ihn nicht mehr — identisch zum FR-020/BUG-018-Pattern. Grund: wenn der LLM jeden Click mit einem Hint sieht, lernt er ihn zu ignorieren und wirft bei echten No-Op-Clicks den Muster-Anker weg.

Reset-Triggers:
- `navigate` (via `_resetFr029Streak()` im `_runOnToolResultHook`-navigate-Branch, analog zu `a11yTree.reset()`)
- `configure_session` (impliziert bewusster Kontext-Wechsel)

Die Streak-Map ist eine Instanz-Variable auf `ToolRegistry` (`_fr029HintShown: Map<string, boolean>`), keyed by `browserSession.sessionId` — bei Tab-Switch bekommt jede Session ihren eigenen Flag.

### Betroffene Dateien
- `src/registry.ts` — neue Konstante `FR029_AJAX_RACE_HINT`, neue Instanz-Variable `_fr029HintShown`, neue Methoden `_maybeAppendFr029AjaxRaceHint` und `_resetFr029Streak`, Reset-Call im navigate-Branch von `_runOnToolResultHook`, Reset-Call im `configure_session`-Branch in `wrap()`
- `src/registry.test.ts` — 5 neue Tests (Happy-Path, static-Skip, Existing-Diff-Skip, Streak-Supression, Navigate-Reset)

### Erhaltene Invarianten
- **Pro-Hook-Pfad:** Der Hint wird erst NACH dem Pro-Hook angehaengt, damit ein Pro-Hook-Diff-Text Vorrang hat. Falls der Pro-Hook bereits einen Text-Block angehaengt hat, bleibt der Hint aus (`blocks.length !== 1`-Guard).
- **Free-Tier-Pfad:** Der Default-Free-Tier-Hook (`createDefaultOnToolResult`) haengt bei leerem Diff nichts an — der Hint wird also im Free-Tier bei jedem AJAX-Race-Click einmal sichtbar.
- **`skipOnToolResultHook`:** `run_plan`-Zwischen-Steps umgehen den kompletten `_runOnToolResultHook`-Pfad (Bypass nach `isError`-Guard), sehen also auch keinen FR-029-Hint — nur der Aggregations-Hook am Plan-Ende kann ihn ausloesen.
- **Prefetch-Slot (Story 18.5):** Der Prefetch laeuft **nach** dem `executeTool`-Return als fire-and-forget, der FR-029-Hint **vor** dem Return als Teil des synchronen Response-Paths — orthogonal, keine Race-Condition.

**Aufwand:** Mittel — Hint-Logik + Streak-Detector + Reset-Triggers + 5 Tests.

**Source:** Story 18.6 (`_bmad-output/implementation-artifacts/18-6-friction-fix-batch-fr-028-aufwaerts.md`).

---

## FR-030: Benchmark-Prozess als /tmp-Session — gefixt (Story 18.6)

### Problem
Runs 3–6 liefen alle aus der Projekt-Session mit CLAUDE.md-Kontext. Der Agent kennt die Friction-Fixes, Tool-Descriptions und Benchmark-Patterns — er ist nicht blind. Der faire Vergleich mit Playwright MCP (der aus /tmp lief) erfordert /tmp-Sessions. Fuer "funktioniert alles?" sind Projekt-Session-Runs valide. Fuer "wie gut findet sich ein blindes LLM zurecht?" nicht.

### Fix (Story 18.6)
Neuer Abschnitt **Session-Hygiene** im `benchmarkTest`-Skill (`.claude/skills/benchmarkTest/SKILL.md`) oberhalb der "Kernregeln"-Liste. Drei Regeln:

1. Offizielle Vergleichs-Runs (gegen Playwright MCP, browser-use, claude-in-chrome) MUESSEN aus einer frischen `/tmp`-Claude-Session gestartet werden.
2. Begruendung woertlich zitiert aus FR-030.
3. Entwicklungs-Smoke-Runs duerfen Projekt-Session nutzen, muessen aber im Export-JSON-`notes`-Feld als `"dev-session"` markiert werden.

Der bestehende "Alle Dateipfade ABSOLUT"-Warnhinweis in `SKILL.md` wurde um einen Cross-Reference-Satz auf den neuen Session-Hygiene-Abschnitt erweitert.

### Betroffene Dateien
- `.claude/skills/benchmarkTest/SKILL.md` — neuer Abschnitt `## Session-Hygiene` oberhalb der Kernregeln, Cross-Reference im "Dateipfade ABSOLUT"-Bullet

**Aufwand:** Niedrig — reine Prozess-Dokumentation im Skill-Markdown.

**Source:** Story 18.6 (`_bmad-output/implementation-artifacts/18-6-friction-fix-batch-fr-028-aufwaerts.md`).

---

## FR-031: Linux-x64-Binary Build-Pipeline — vorbereitet (Story 18.6)

### Problem
Das Pro-Binary (`scripts/build-binary.sh` im Pro-Repo) baut nur fuer macOS arm64. Kein x86_64 Mac, kein Linux. Fuer CI/CD-Pipelines, Docker-Container oder Remote-Server auf Linux ist das Pro-Binary nicht nutzbar — Kunden muessen auf die npm-Variante ausweichen.

### Fix (Story 18.6)
Neues Adapter-Skript **`scripts/build-binary-linux.sh`** im Free-Repo. Der Build-Flow:

1. Linux-x64-Node-Binary per `curl` von `https://nodejs.org/dist/vX.Y.Z/node-vX.Y.Z-linux-x64.tar.gz` laden
2. `esbuild` CJS-Bundle (wiederverwendet aus bestehender Pipeline)
3. `sea-config.json` schreiben mit `disableExperimentalSEAWarning: true`
4. `node --experimental-sea-config` fuer den SEA-Blob
5. `postject` gegen das Linux-Node-Binary mit Standard-Sentinel-Fuse (`NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`)
6. Ausgabe: `dist/silbercue-chrome-linux-x64`, kein `codesign` noetig

Das Skript **laesst sich** auch auf macOS ausfuehren (postject ist plattform-agnostisch), aber der Release-Flow wird **in einem Linux-GitHub-Actions-Runner** (`ubuntu-latest`) laufen — der tatsaechliche Cross-Platform-Build ist nicht in einem Dev-Agent-Run produzierbar. Der Skript-Kopfkommentar dokumentiert den erwarteten CI-Flow ausfuehrlich.

`scripts/publish.ts` Phase 5.2 hat einen ergaenzten Kommentar-Block, der auf das Linux-Binary verweist. Der Upload selbst passiert in Phase 6b des `silbercuechrome-publish`-Skills, parallel zum bestehenden macOS-arm64-Binary-Upload — analog zur bestehenden Architektur.

### Betroffene Dateien
- `scripts/build-binary-linux.sh` — neues Build-Skript (ausfuehrbar, 130 Zeilen mit Kommentar-Header)
- `scripts/publish.ts` — Phase-5.2-Kommentar-Block um FR-031-Hinweis ergaenzt
- `scripts/publish.test.ts` — 3 neue Tests (Kommentar-Existenz, Skript-Existenz + Execute-Bit, CI/Docker-Flow-Dokumentation)

### Status und offene Punkte
- **Linux-Binary-Build selbst:** wird im naechsten Release-Cycle in CI ausgefuehrt, nicht in dieser Story. Dokumentation des Flows ist abgeschlossen.
- **Homebrew-Formula:** bleibt macOS-only. Linux-User installieren via npm (`npm i -g silbercuechrome`) oder direktem Binary-Download vom GitHub-Release.
- **Pro-Repo build-binary.sh:** Erweiterung um `--target linux-x64` bleibt als optionaler Follow-up. Der Free-Repo-Adapter-Pfad ist ausreichend, weil esbuild und postject bereits gegen den Free-Source-Tree bauen und das Pro-Binary ohnehin in Phase 6b separat signiert wird.

**Aufwand:** Mittel — Skript + Kommentar + 3 Tests. Kein Live-Build in dieser Story.

**Source:** Story 18.6 (`_bmad-output/implementation-artifacts/18-6-friction-fix-batch-fr-028-aufwaerts.md`).

---

## FR-032: Memory aufraemen — gefixt (Story 18.6)

### Problem
Sieben Memory-Eintraege in `MEMORY.md` waren historisch abgeschlossen und verwirrten bei zukuenftigen Sessions mehr als sie halfen:
- `Click-Scroll-Bug` (gefixt 2026-04-04)
- `Friction Report c987ac11` (alle 10 Frictions gefixt)
- `Friction Report 9254a969` (alle Frictions gefixt)
- `Ambient Context Optimierung` (ABGESCHLOSSEN)
- `BUG-015 Screenshot Occlusion` (GEFIXT)
- `Phase 6 Bug-Fix Playbook` (ABGESCHLOSSEN 2026-04-08)
- `Phase 5 Live-Test Playbook` (Historisches Playbook)

### Fix (Story 18.6)
Die sieben Eintraege wurden aus dem Aktiv-Index von `MEMORY.md` in einen neuen Abschnitt `## Historisch / abgeschlossen (Story 18.6, 2026-04-11)` am Dateiende verschoben. Die referenzierten Einzel-Markdown-Dateien (`project_click-scroll-bug.md` etc.) bleiben bestehen — nur der Aktiv-Index-Eintrag wurde verschoben, damit Rollback durch manuelles Zurueckkopieren moeglich ist.

Nicht entfernt wurden die aktiven Eintraege:
- `Operator-Pivot approved` (STRATEGISCH TRAGEND)
- `Distribution-Setup Status` (AKTIV)
- `MQS-Framework` (festgelegt, nicht aendern)
- `Codex-Findings ernst nehmen` (aktueller Session-Feedback-Eintrag)
- Alle BUG-/Reference-Eintraege, die nicht als ABGESCHLOSSEN markiert sind

### Betroffene Dateien
- `/Users/silbercue/.claude/projects/-Users-silbercue-Documents-Cursor-Skills-SilbercueChrome/memory/MEMORY.md` — 7 Eintraege in Historisch-Abschnitt verschoben

**Aufwand:** Minimal — reine Memory-Datei-Pflege.

**Source:** Story 18.6 (`_bmad-output/implementation-artifacts/18-6-friction-fix-batch-fr-028-aufwaerts.md`).

---

## FR-033: Ambient Context pro Step in run_plan — gefixt (Story 18.1)

### Problem
`run_plan` hat pro Zwischen-Step den vollen Ambient-Context-Hook ausgeloest
(`onToolResult` Pro-Hook in `src/registry.ts`). Bei einem typischen 10-Step-Plan
lief der Hook 10 Mal durch, jedes Mal mit A11y-Tree-Refresh, DOM-Diff-Bau und
ggf. Compact-Snapshot. Forensik-Messung: etwa **2850 Chars pro Plan** durch
entfallende Ambient-Context-Snapshots, plus **100–1350 ms pro Click-Step**
(Herleitung: die `waitForAXChange`-Wait-Konstanten 350/500/1350 ms in
`src/hooks/default-on-tool-result.ts`). Der zeitliche Hebel skaliert mit der
Anzahl der Click-/Type-Steps — Plaene ohne Transition-Steps sehen die
Zeit-Einsparung nicht, die Token-Einsparung aber schon. Der LLM braucht den
Zwischen-Kontext nicht — er will nur den finalen Seitenzustand nach dem
gesamten Plan sehen.

**Historische Korrektur:** Die urspruenglich zitierte Zahl "1050–4050 ms pro
Plan" war eine Papierrechnung (3 Click-Steps × Wait-Konstante), keine
gemessene Wall-Clock auf einem konkreten Referenz-Plan. Der Deep-Dive vom
2026-04-11 (`/tmp/forensic-deep-dive.md`) hat die korrekte Einheit geklaert:
Einsparung ist **pro Click-Step**, nicht pro Plan.

### Root Cause
`src/plan/plan-executor.ts:161` rief `registry.executeTool(step.tool, resolvedParams)`
ohne Opt-out fuer den `onToolResult`-Hook auf. `ToolRegistry.executeTool()`
hatte keinen Bypass-Kanal, weil der Hook in Story 15.3 zentral pro Tool-Call
eingehaengt wurde, ohne an `run_plan` als Spezialfall zu denken.

### Fix (Epic 18.1)
- `src/types.ts`: neuer Typ `ExecuteToolOptions` mit `skipOnToolResultHook?: boolean`.
- `src/registry.ts`:
  - `executeTool()` bekommt einen optionalen 4. Parameter `options?: ExecuteToolOptions`.
  - `_runOnToolResultHook()` respektiert das Flag nach dem `isError`-Guard und
    vor dem `hooks.onToolResult`-Aufruf. `a11yTree.reset()` auf navigate laeuft
    bewusst davor, damit navigate-Zwischen-Steps die Ref-Caches sauber
    invalidieren.
  - Neue Public-Methode `runAggregationHook(result, toolName)` ruft intern
    `_runOnToolResultHook` ohne Bypass auf.
- `src/plan/plan-executor.ts`:
  - Alle Step-Calls laufen jetzt mit `{ skipOnToolResultHook: true }`.
  - Am Plan-Ende wird einmalig `registry.runAggregationHook()` ueber das letzte
    Step-Ergebnis aufgerufen — aber nur wenn der letzte Step weder `skipped`
    noch `isError` ist.
- `src/tools/run-plan.ts`: Parallel-Pfad-Closure gibt das Flag in den
  `executeTool`-Call im `registryFactory`-Closure weiter (Pro-Repo
  executeParallel-Hook nutzt dieselbe Suppression-Semantik).
- Unit-Tests co-located in `src/registry.test.ts`, `src/plan/plan-executor.test.ts`,
  `src/tools/run-plan.test.ts`.
- Messung via `scripts/run-plan-delta.mjs` (Baseline in
  `test-hardest/ops-run-plan-baseline-v0.5.0.json`).

### Erhaltene Invarianten
- **AC-5:** `isError`-Guard bleibt VOR dem Bypass. Fehler-Steps umgehen den
  Hook weiterhin, Aggregations-Hook wird nicht ueber ein Error-Result gelegt.
- **AC-6:** Direkte Tool-Calls ausserhalb `run_plan` (MCP server.tool()-Pfad)
  uebergeben keine Options — Hook laeuft wie bisher.
- `a11yTree.reset()` auf navigate laeuft immer, auch bei gesetztem Flag.

**Aufwand:** Mittel — Flag-Plumbing + Aggregations-Hook + Tests.

**Source:** Story 18.1 (`_bmad-output/implementation-artifacts/18-1-ambient-context-hook-in-run-plan-unterdruecken.md`).

---

## FR-034: Step-Response-Aggregation in run_plan verbose — gefixt (Story 18.2)

### Problem
`run_plan` hat pro Step **alle** text-Bloecke des Tool-Outputs in den Plan-
Response gespiegelt — bei einem `read_page`-Step landet der gesamte A11y-Tree
(hunderte Zeilen) als Zwischen-Step-Output, bei `screenshot` wandert ein 50–
200 KB base64-Image durch. Forensik-Messung: pro 6-Step-Plan ~250 Zeilen
Step-Output, dominiert von genau einem `read_page`. FR-033 (Story 18.1) hat
schon den Ambient-Context-Hook unterdrueckt — FR-034 ist der zweite Token-
Hebel: die Form, in der `buildPlanResponse` die Step-Results selbst
aufbereitet.

### Root Cause
`src/plan/plan-executor.ts:314–332` (Story-18.1-Stand) hat den vollen
text-Block-Inhalt jedes Steps in eine Multi-Line-Step-Header-Zeile gequetscht
und Image-Bloecke unverstaendert durchgereicht. Es gab keine "kompakte
Aggregation" — der LLM bekam alle Outputs aller Steps.

### Fix (Epic 18.2)
- `src/plan/plan-executor.ts`:
  - Neue file-lokale Helper `extractFirstRef`, `formatStepLine`,
    `appendErrorContext`. Erfolgs-Steps werden auf eine Zeile reduziert
    (`[i/N] OK tool (Xms): ref=eK` ODER `[i/N] OK tool (Xms): <kurztext>`,
    max. 80 Zeichen — `STEP_LINE_COMPACT_MAX_CHARS`).
  - Image-Bloecke aus erfolgreichen Steps werden NICHT mehr in den
    Plan-Response uebernommen. Image-Bloecke aus Fehler-Steps (z.B.
    `errorStrategy: "screenshot"`-Pfad) bleiben via `appendErrorContext`
    erhalten.
  - Fehler-Steps behalten die volle Verbose-Form (alle text-Bloecke joined
    mit `\n`, plus Non-Text-Bloecke). Begruendung: AC-4 — der LLM braucht
    den vollen Fehler-Kontext, um zu entscheiden, was zu tun ist.
  - Aggregations-Hook-Output (Story 18.1) wird *nach* dem Hook-Aufruf aus
    dem letzten Step-Result herausgeschnitten und als separater Block-
    Schwanz an `buildPlanResponse` uebergeben — sonst verschwinden die
    DOM-Diff-Zeilen in der Ein-Zeilen-Aggregation.
  - Skip-Branch ist unveraendert (`[i/N] SKIP tool (condition: <expr>)`).
- `scripts/run-plan-delta.mjs`: Gates kumulativ Story 18.1 + 18.2 angehoben
  auf `CHAR_GATE = 2500` und `MS_GATE = 1500`. Konstanten als benannte
  `STORY_18_1_*` / `STORY_18_2_*` mit JSDoc-Kommentar (Invariante 5).
- Unit-Tests in `src/plan/plan-executor.test.ts` (`describe`-Block
  "Step-Response-Aggregation (Story 18.2)"): 12 neue Tests fuer Ref-
  Extraktion, Multi-Line-Truncate, Long-Line-Truncate-Ellipsis,
  no-output-Fall, Image-Block-Exclusion, Skip-Branch, FAIL-Branch-Vollform,
  errorStrategy=screenshot Image-Erhalt, Aborted-Pfad, Aggregations-Overlay-
  Separation, FAIL-mit-Hook-Guard.
- Bestehender `preserves image content blocks from screenshot steps`-Test
  invertiert in `does NOT propagate image content blocks from successful
  screenshot steps (Story 18.2)`.

### Erhaltene Invarianten
- **AC-4:** Fehler-Steps behalten den vollstaendigen Fehler-Kontext —
  gekuerzt wird ausschliesslich auf erfolgreichen Steps.
- **AC-5:** Skip-Branch unveraendert.
- **AC-6:** Direkte MCP-Tool-Calls und Suspend-/Resume-Pfade beruehrt es
  nicht — die Aggregat-Logik laeuft nur in `executePlan` Happy-Path /
  `continue`-Pfad VOR `buildPlanResponse`.
- **Invariante 5:** `STEP_LINE_COMPACT_MAX_CHARS = 80` als benannte Konstante
  mit JSDoc-Kommentar; Mess-Gates ebenfalls benannte Konstanten.
- **Invariante 4:** `extractFirstRef` nutzt `match()`+`null`-Check, keinen
  try/catch — Fallback ist ein `undefined`-Returnwert, kein Exception-Pfad.

**Aufwand:** Mittel — Helper-Extraktion + Aggregations-Overlay-Schnitt +
Tests + Mess-Skript.

**Source:** Story 18.2 (`_bmad-output/implementation-artifacts/18-2-step-response-aggregation-verschmaelern.md`).

---

## FR-035: Tool-Definition-Overhead zu gross — gefixt (Story 18.3), REVIDIERT 2026-04-18

### Revisions-Vermerk (2026-04-18)

Der 10-Tool-Default aus Story 18.3 wurde **revidiert**: Default ist jetzt
wieder der volle Tool-Satz. Opt-Out auf Minimal bleibt via
`SILBERCUE_CHROME_MINIMAL_TOOLS=true` oder (backwards-compat)
`SILBERCUE_CHROME_FULL_TOOLS=false`. Begruendung:

- **Token-Effekt klein:** Die 43,8%-Reduktion (9.537 Bytes) wird durch
  Anthropic-Prompt-Caching neutralisiert — die Tool-Liste ist Teil des
  stabilen System-Prompts, wird einmal bezahlt und dann aus dem Cache
  gelesen. Der theoretische "pro Turn teurer"-Effekt greift nur bei
  Cache-Miss, nicht in der Praxis.
- **Positional-Bias nie A/B-validiert:** Der BiasBusters-Effekt
  (arXiv:2510.00307) wurde als theoretische Grundlage angefuehrt, aber
  nie auf der eigenen 35-Test-Suite gemessen. Ein A/B-Benchmark
  Default-vs-Full wurde nicht gefahren.
- **Praxis-Kosten hoch:** Power-Tools wie `switch_tab`, `scroll`,
  `press_key` sind nur via `run_plan`-Dispatch erreichbar — der LLM
  vergisst das regelmaessig, was bereits zu dokumentierten Incidents
  gefuehrt hat (Session 6d4db449, 2026-04-17: "SilbercueChrome hat
  leider kein tabs_create Tool" — falsch, aber symptomatisch).
- **Der `_handlers`-Dispatcher bleibt unberuehrt:** `run_plan` kann
  weiterhin alle Extended-Tools aufrufen, in beiden Modi.

Der urspruengliche Problem-Abschnitt unten bleibt als historischer
Kontext stehen, spiegelt aber nicht mehr die aktive Policy wider.

### Problem (historisch, pre-Revision)
SilbercueChrome registrierte bislang **alle 21 Free-Tools** ueber
`server.tool()`, also tauchten sie im `tools/list`-Export auf. Die
Tool-Definitionen sind nicht nur Namen, sondern enthalten Beschreibungen,
JSON-Schemas und Annotations — Forensik-Messung des Default-Builds: ~21,7 KB
Tool-Definition-Overhead pro `tools/list`-Antwort, das landet bei jedem
neuen LLM-Turn im System-Prompt. Bei einer LLM-Session mit z.B. 50
Tool-Calls macht die reine Tool-Liste mehrere Hundert Tausend Token
zusaetzlich aus, ohne dass der LLM die Mehrzahl der Tools jemals direkt
anwaehlt. Hauptproblem ist die Auswahl-Last: 21 Tools zur Auswahl bedeuten
hoehere Wahrscheinlichkeit fuer Positional-Bias-Fehler (BiasBusters
arXiv:2510.00307 — Position-Bias delta_pos 0.17–0.5).

### Root Cause
Story 15.2 hatte alle Free-Tools direkt in `registerAll()` registriert. Das
war zur Pro-Tool-Extraktion korrekt — es gab schlicht noch keine Vorstellung
von einem "schlanken Default" vs. "voller Set". Story 18.3 ist die explizite
Trennung.

### Fix (Story 18.3)
- `src/registry.ts`:
  - Neue benannte Konstante `DEFAULT_TOOL_NAMES: readonly string[]` mit
    den zehn Transition-Tools (`virtual_desk`, `read_page`, `click`, `type`,
    `fill_form`, `navigate`, `wait_for`, `screenshot`, `run_plan`, `evaluate`),
    plus `DEFAULT_TOOL_SET: ReadonlySet<string>` fuer O(1)-Lookups.
  - Neuer Helper `isFullToolsMode(): boolean` parst
    `process.env.SILBERCUE_CHROME_FULL_TOOLS === "true"` — exakt im Stil
    von `headlessEnv` in `src/server.ts`.
  - In `registerAll()` wird einmalig `const fullToolsMode = isFullToolsMode()`
    gelesen und ein lokaler Helper `maybeRegisterFreeMCPTool(name, ...)`
    gatet jeden Free-Tool-Registrierungs-Aufruf:
    `if (!fullToolsMode && !DEFAULT_TOOL_SET.has(name)) return;`
  - Alle 21 `this.server.tool(...)`-Aufrufe in der Free-Tool-Sektion sind
    auf `maybeRegisterFreeMCPTool(...)` umgestellt. Der Pro-Tool-Delegate
    (`_registerProToolDelegate`) bleibt **unveraendert** — Pro-Tools wie
    `inspect_element` werden weiterhin registriert wenn das Pro-Repo
    `registerProTools()` aufruft.
  - **Review-Fix H1 (2026-04-11):** `handle_dialog`, `console_logs` und
    `network_monitor` werden seit dem Review-Fix **unbedingt** registriert.
    Die Collector-Existenz-Pruefung wandert in den Runtime-Handler, der
    bei fehlendem Collector eine klare Diagnose-Meldung liefert. Grund:
    `BrowserSession` initialisiert die Collectors lazy in `ensureReady()`
    (via `_wireHelpers()`), also NACH `registerAll()`. Die vorherige
    Registration-Time-Gate-Logik hat die drei Tools deshalb in Produktion
    nie registriert, und `tools/list` exportierte real nur 18 statt 21.
  - Der `_handlers`-Block (interner Dispatcher fuer `executeTool` /
    `run_plan`) bleibt **vollstaendig**. `run_plan` kann weiter Extended-
    Tools (`press_key`, `scroll`, `observe`, ...) aufrufen, auch wenn sie
    in `tools/list` versteckt sind.
  - **Review-Fix H2 (2026-04-11):** Der `_handlers`-Dispatcher registriert
    ebenfalls `handle_dialog`, `console_logs`, `network_monitor`
    unconditional — mit Runtime-Guard statt Conditional-Set. Damit fallen
    `executeTool(...)` und `run_plan`-Steps fuer diese drei Tools nicht
    mehr auf "Unknown tool", wenn der Collector noch nicht initialisiert
    ist.
- `src/registry.test.ts`:
  - Parent `beforeEach` setzt `SILBERCUE_CHROME_FULL_TOOLS=true` fuer
    bestehende Tests, die Extended-Tool-Callbacks aus den
    `server.tool()`-Mock-Calls ziehen — so bleibt die alte Coverage gruen
    ohne Test-Umbau.
  - Neuer `describe`-Block `ToolRegistry — Tool-Verschlankung (Story 18.3)`
    mit urspruenglich elf + **sechs Review-Fix-Tests** (H1/H2/H3):
    Default-Set Reihenfolge, Extended-Tools sind raus, `"false"` und
    andere truthy-aehnliche Werte aktivieren NICHT Full, `FULL_TOOLS=true`
    registriert alle **21** Free-Tools (Review-Fix H3), `executeTool(...)`
    fuer `handle_dialog`/`console_logs`/`network_monitor` findet Handler
    und liefert Runtime-Guard-Meldung (Review-Fix H2), `executeTool` fuer
    `press_key`/`observe`/`scroll`/`dom_snapshot` findet Handler in
    `_handlers`, `unknown_tool` liefert weiterhin "Unknown tool"-Error,
    `virtual_desk` zuerst und `evaluate` zuletzt, plus ein Integration-
    Test der echte Mock-Collectors injiziert und den funktionalen
    Handler-Pfad fuer `console_logs` verifiziert.
- `src/pro-feature-gates.regression.test.ts`:
  - **Review-Fix M2 (2026-04-11):** Zwei getrennte Assertions statt eines
    Lower-Bound-Checks — Default-Modus exakt `10`, Full-Modus exakt `21`
    (plus explizite Assertions dass `handle_dialog`/`console_logs`/
    `network_monitor` im Full-Modus vorhanden sind). Faengt Regressions
    in BEIDEN Modi ab.
- `scripts/tool-list-tokens.mjs` (neu): Mess-Skript spawnt zwei
  MCP-Server-Subprocesses, ruft `tools/list` ab, vergleicht die Bytes
  und prueft das Reduktions-Gate `STORY_18_3_REDUCTION_GATE = 0.30`.
  Konstante mit JSDoc, Output als JSON-Block. **Nicht** in `npm test`
  eingehaengt — Delivery-Gate analog `scripts/run-plan-delta.mjs`.
- `CLAUDE.md` + `README.md`: Env-Var-Tabelle um neue Zeile fuer
  `SILBERCUE_CHROME_FULL_TOOLS` ergaenzt.

### Mess-Werte (Stand HEAD nach Story 18.3 + Review-Fixes H1/H2/H3)
- Default-Set: 10 Tools, **12,234 Bytes** (~3,059 Tokens, 4 Bytes/Token)
- Full-Set: **21 Tools** (10 Default + 11 Extended, inkl. handle_dialog/
  console_logs/network_monitor nach Review-Fix H1), **21,771 Bytes**
  (~5,443 Tokens)
- Reduktion: **9,537 Bytes / 43.8%** — Gate `>= 30%` erfuellt
- Ausfuehrung: `node scripts/tool-list-tokens.mjs` (siehe
  `docs/pattern-updates.md` Story-18.3-Abschnitt fuer den Live-Run)

### Erhaltene Invarianten
- **AC-3:** `_handlers`-Map bleibt vollstaendig — `run_plan` dispatcht
  weiter Extended-Tools, auch im Default-Modus. Bestaetigt durch die neuen
  Registry-Tests fuer `executeTool("press_key"/"observe"/"scroll")`.
- **Pro-Tools:** Der `_registerProToolDelegate`-Pfad ist nicht vom Gate
  betroffen. `inspect_element` und andere Pro-Tools verhalten sich
  unveraendert — registriert wenn das Pro-Repo `registerProTools()`
  aufruft, sonst nicht.
- **Reihenfolge:** Default-Set behaelt die Positional-Bias-optimierte
  Reihenfolge (`virtual_desk` zuerst, `evaluate` zuletzt) — exakt wie der
  Kommentar bei `registerAll()` Zeile 850–856 vorschreibt.
- **Invariante 5:** `DEFAULT_TOOL_NAMES`, `DEFAULT_TOOL_SET` und
  `STORY_18_3_REDUCTION_GATE` sind benannte Konstanten mit JSDoc-Kommentar.
- **Rueckwaerts-Kompatibilitaet:** `SILBERCUE_CHROME_FULL_TOOLS=true`
  liefert die exakt selbe Tool-Liste wie der Stand vor Story 18.3.
- **Kein Migrations-Scope-Creep:** Tool-Registrierung bleibt beim
  klassischen `server.tool()`-Pattern — keine Umstellung auf
  `server.registerTool()` (das waere ein orthogonaler Refactor und kein
  Teil von Story 18.3).

**Aufwand:** Mittel — Helper-Extraktion + 21 Call-Site-Umstellungen +
Test-Anpassungen + Mess-Skript + Doku.

**Source:** Story 18.3 (`_bmad-output/implementation-artifacts/18-3-tool-verschlankung-auf-ein-transition-set.md`).

## FR-036: Geister-Refs hinter Modal-Overlays — gefixt (Story 18.4)

**Problem:** `read_page` listete interaktive Elemente auf, die visuell von
einem Modal-Overlay verdeckt waren. Der LLM sah im A11y-Tree einen Button,
rief `click(ref: "e42")` auf, und bekam entweder ein "click intercepted"
zurueck oder klickte auf das Overlay statt den gewuenschten Button.
Klassischer Geisterklick.

**Symptom:**
- Auf Seiten mit offenem Dialog/Modal erscheinen Refs fuer darunterliegende
  Buttons/Links im `read_page`-Output.
- LLM-Klick trifft entweder das Overlay oder wird von Chrome als
  "intercepted" abgelehnt.
- Token-Budget wird verschwendet mit Elementen, die gar nicht erreichbar
  sind.
- Semantischer A11y-Tree (ignored-Flag) hilft nicht, weil `ignored: true`
  nur fuer semantische Gruende gesetzt wird (aria-hidden, display:none,
  role=none), nicht fuer visuelle Verdeckung durch z-index/Overlays.

**Fix — Paint-Order-Filter (dreistufig):**

1. **`COMPUTED_STYLES` um `pointer-events` erweitert** (`src/tools/visual-constants.ts`) —
   der captureSnapshot-Call liefert jetzt den computed `pointer-events`-Wert
   pro Element, damit der Filter weiss, wer Klicks blockiert und wer
   durchlaesst. Append-only; bestehende Index-Zugriffe (display=0,
   visibility=1, z-index=6) bleiben unveraendert.
2. **`VisualInfo` um `occluded`- und `paintOrder`-Felder erweitert**
   (`src/cache/a11y-tree.ts`). `occluded` wird im zweiten Pass von
   `fetchVisualData` gesetzt, wenn ein anderer klickbarer Occluder mit
   hoeherem paintOrder das Element-Zentrum ueberdeckt.
3. **`fetchVisualData` wird jetzt fuer ALLE Filter-Modi aufgerufen** — nicht
   mehr nur `filter: "visual"`. Die Occlusion-Info wird fuer jeden
   `read_page`-Aufruf berechnet. Bounds/click/vis-Annotationen bleiben
   weiterhin auf `filter: "visual"` beschraenkt (zentral im neuen Helper
   `appendVisualAnnotation`).
4. **`renderNode` und `renderNodeDownsampled`** ueberspringen occluded Nodes,
   rendern aber ihre Kinder weiter — damit `position: absolute;
   z-index: 999`-Kinder, die aus einem verdeckten Parent
   "herausbrechen", sichtbar bleiben.

**Algorithmus (`fetchVisualData` zweiter Pass):**

```
sort occluders by paintOrder DESC (only pointer-events != "none")
for every visible candidate:
  for every occluder with higher paintOrder:
    if candidate.centre (cx, cy) lies inside occluder.bounds:
      mark candidate as occluded
      break
```

- **Zentrum-Probe, nicht volle Box** — matcht die Semantik von
  `document.elementFromPoint(cx, cy)`, die Chrome beim `click`-Dispatch
  ueber `Input.dispatchMouseEvent` nutzt. Partielle Ueberdeckung (z.B. nur
  der linke Rand eines Buttons) macht den Button nicht unerreichbar.
- **Nur klickbare Occluder zaehlen** — Overlays mit `pointer-events: none`
  lassen Klicks durch, sind also keine Occluder. Deshalb die
  `pointer-events`-Erweiterung in `COMPUTED_STYLES`.
- **Ein CDP-Call extra pro `read_page`** — der bestehende
  `DOMSnapshot.captureSnapshot`-Call wird wiederverwendet, mit `includePaintOrder: true`
  (was `fetchVisualData` ohnehin schon setzte). Kein zusaetzliches
  Runtime.evaluate, kein LayerTree, kein DOM.getContentQuads.

**Test:**
- Vier neue Tests in `src/cache/a11y-tree.test.ts` unter
  `describe("Paint-order filtering (Story 18.4)")`:
  1. Overlay-vor-Link-Cluster → 5 Links gefiltert
  2. Overlay mit `pointer-events: none` → 5 Links bleiben
  3. Zwei Buttons selbe Bounds, hoehere paintOrder gewinnt
  4. DOMSnapshot-Fail → Fallback auf ungefilterte Tree (wie M1)
- `makeDomSnapshot`-Helper um `pointerEvents` und `paintOrder`-Felder
  erweitert; Defaults (`"auto"`, DOM-Reihenfolge `i + 1`) halten alle
  132 bestehenden a11y-tree-Tests gruen.
- Gesamt: 1454/1454 Unit-Tests gruen (vorher 1450, +4 neu).
- Smoke-Test-Fails (3) sind pre-existing aus Story 18.3 (Tool-Verschlankung)
  — kein Paint-Order-Regress.

**Fallback-Robustheit:**
- Wenn `DOMSnapshot.captureSnapshot` fehlschlaegt (aeltere Chrome-Builds,
  restricted pages), setzt `getTree()` `visualDataFailed = true` und
  faellt auf den bisherigen ungefilterten Pfad zurueck. Genau derselbe
  Mechanismus wie die bestehende M1-Absicherung fuer `filter: "visual"`,
  jetzt auch wirksam fuer `interactive`/`all`/`landmark`.
- `paintOrders[]` ist im `SnapshotDocument`-Typ optional — aeltere
  Snapshot-Responses ohne paintOrder liefern `undefined`, der Default
  ist `paintOrder: 0`, und die Occlusion-Schleife macht dann
  effektiv nichts (alle Kandidaten haben paintOrder 0, die innere
  `<=`-Bedingung filtert alles raus).

**Token-Effekt:**
- Auf Seiten **ohne** Overlay: 0% Aenderung (keine Nodes werden
  gefiltert). Der zusaetzliche CDP-Call kostet ~5-30 ms je nach Seite.
- Auf Seiten **mit** aktivem Modal: 10-20% Token-Reduktion erwartet,
  weil alle verdeckten Buttons/Links aus dem Output fliegen.

**Status:** GEFIXT in Story 18.4. File: `src/cache/a11y-tree.ts`
(fetchVisualData zweiter Pass, renderNode/renderNodeDownsampled
Occlusion-Skip, appendVisualAnnotation Helper), `src/tools/visual-constants.ts`
(COMPUTED_STYLES).

**Aufwand:** Mittel — Types-Erweiterung + zweiter Pass in fetchVisualData
+ render-Pipe-Filter + Helper-Extraktion + 4 neue Tests +
Mock-Erweiterung + 2 Regression-Test-Anpassungen (read-page.test.ts,
screenshot.test.ts).

**Source:** Story 18.4 (`_bmad-output/implementation-artifacts/18-4-paint-order-filtering-fuer-verdeckte-elemente.md`).

## FR-037: LLM-Denkzeit-Luecke nach navigate/click — gefixt (Story 18.5)

**Problem:** Zwischen einem `navigate`/`click`-Call und dem darauffolgenden
`read_page`-Call denkt der LLM 2-10 Sekunden. In dieser Zeit steht
SilbercueChrome still — der naechste Cache-Warm-up laeuft erst, wenn der
LLM seinen naechsten Tool-Call schickt. Das Ergebnis: unnoetige Wall-Clock-
Latenz in Plaenen mit `navigate → read_page`-Sequenzen (was der mit Abstand
haeufigste Pfad ist — ~70-80% der Tool-Folgen laut Forensik-Analyse).

**Symptom:**
- `read_page` nach einem erfolgreichen `navigate` wartet nochmal 50-500 ms
  auf den CDP-Roundtrip, obwohl der LLM zu diesem Zeitpunkt gerade noch
  "denkt".
- Wall-Clock-Summe ueber einen 10-Step-Plan: ~3-5 s unnoetiger Overhead,
  allein aus dem Cache-Warm-up-Pfad.
- Besonders schmerzhaft auf grossen Seiten (shop, dashboard, form) wo der
  `Accessibility.getFullAXTree`-Call selbst 200-500 ms braucht.

**Fix — Speculative Prefetch mit Single-Slot-Semantik:**

1. **Neue Infrastruktur-Klasse `PrefetchSlot`** (`src/cache/prefetch-slot.ts`)
   — haelt genau einen aktiven Background-Build pro Instanz. Zweiter
   `schedule()`-Aufruf cancelt den ersten via `AbortController`. Errors
   werden absorbiert — der Slot ist Fire-and-forget-Infrastruktur, der
   Foreground-Tool-Pfad darf nie durch ihn beeinflusst werden.
2. **Registry-Trigger nach erfolgreichem `navigate`/`click`** (`src/registry.ts`
   `_triggerSpeculativePrefetch`) — laeuft **nach** dem Handler-Return,
   nicht parallel. CDP serialisiert ohnehin pro Session, Parallelismus
   wuerde den Foreground verlangsamen.
3. **`refreshPrecomputed(signal)`** (`src/cache/a11y-tree.ts`) — optionaler
   `AbortSignal`-Parameter an jedem `await`-Punkt gecheckt, Cache-Write
   wird bei Abort uebersprungen. Der zusaetzliche `expectedUrl`-Parameter
   (L1 review follow-up) nutzt die zum Schedule-Zeitpunkt bekannte URL
   als Race-Guard: wenn die Page mittlerweile auf einer anderen URL ist,
   wird der Cache-Write ignoriert.
4. **`_resetState()`-Split** (`src/cache/a11y-tree.ts`) — der externe
   `reset()`-Entrypoint cancelt den Slot, die interne URL-Change-Branch
   in `refreshPrecomputed` nutzt `_resetState()` ohne Slot-Cancel, sonst
   wuerde der Build sich selbst abbrechen.
5. **`schedule()`-Atomaritaet (H1 review follow-up)** — Build laeuft im
   `setImmediate()`-Tick, nicht synchron im `schedule()`-Stack. Identitaets-
   Check via monoton steigender `slotId` im Cleanup-Pfad — ein
   abgebrochener Slot darf seinen Nachfolger nicht aus `_active` loeschen.
   Reentrante `schedule()`-Aufrufe aus dem Build-Callback heraus sehen
   dadurch immer einen wohldefinierten Slot-State.

**Race-Condition-Katalog (6 Faelle):**
1. Race 1 — Slot 1 in flight, getFullAXTree returns nach cancel → abort-check vor Cache-Write.
2. Race 2 — Slot 1 finally clobbers Slot 2 → slotId identity-check.
3. Race 3 — `reset()` mid-build → externer `reset()` cancelt Slot, interner `_resetState()` nicht.
4. Race 4 — Multi-tab session-handover → composite-keyed refMap (BUG-016), keine zusaetzliche Mitigation noetig.
5. Race 5 — Reentrante `schedule()` aus dem Build-Callback → atomare `_active`-Zuweisung + `setImmediate`-Build-Start (H1 fix).
6. Race 6 — Build wirft synchron → `(async () => build())()`-Wrap konvertiert in Promise-Reject.

**Test:**
- Neue Datei `src/cache/prefetch-slot.test.ts` mit 9 Unit-Tests: Lifecycle
  (schedule/cancel), Race 2 (Identity-Check), Race 5 (reentrancy H1 fix),
  Race 3 (external cancel M2 fix), Error-Absorption (sync + async + AbortError).
- Neue Tests in `src/cache/a11y-tree.test.ts` unter
  `describe("Story 18.5 M2 — reset / _resetState / prefetchSlot interaction")`:
  `reset()` cancelt Slot, URL-Change-Branch nutzt `_resetState()` nicht
  `reset()`, `expectedUrl` als L1-Pre-Read-Check (positiv + negativ).
- Neue Integration-Tests in `src/registry.test.ts` unter
  `describe("ToolRegistry — Speculative Prefetch (Story 18.5)")`: Fire-and-
  forget Timing, navigate/click-Trigger, isError-Gating, Negativ-Cases fuer
  type/fill_form/screenshot/wait_for (H2 review follow-up), URL-Mismatch-Drop,
  Single-Slot-Replace, Error-Absorption.
- Gesamt: 1481/1481 Unit-Tests gruen (vorher 1474, +7 neu).

**Prefetch-Semantik (wichtig):**
Der Prefetch schlaegt NICHT auf den `read_page`-Tool-Pfad direkt durch —
`read-page.ts:37` ruft `getTree({fresh: true})` und umgeht damit den
Precomputed-Cache. Der Effekt entsteht im **Ambient-Context-Hook** (Pro-Repo
Story 15.3): wenn der Prefetch bereits gelaufen ist, ist der naechste
`refreshPrecomputed`-Call im Hook entweder obsolet oder deutlich schneller.
Der LLM-sichtbare Effekt ist kuerzere Wall-Clock-Zeit zwischen `click`-
Return und naechstem Tool-Return.

**Token-Effekt:**
- Null Aenderung beim Tool-Definitions-Budget (keine neuen Tools).
- Response-Content unveraendert — Prefetch ist Infrastruktur, nicht Feature.
- Wall-Clock-Einsparung: erwartet 50-300 ms pro navigate→read-Sequenz.
  Harte Messung findet im Gate-Check Story 18.7 statt.

**Status:** GEFIXT in Story 18.5. Files: `src/cache/prefetch-slot.ts` (NEU),
`src/cache/prefetch-slot.test.ts` (NEU), `src/cache/a11y-tree.ts`
(`refreshPrecomputed(signal, expectedUrl)`-Parameter, `_resetState()`-Split,
`reset()` cancelt `prefetchSlot`), `src/registry.ts` (`_triggerSpeculativePrefetch()`,
Fire-and-forget Trigger nach `navigate`/`click`).

**Aufwand:** Gross — neue Infrastruktur-Klasse + Signal-Wiring in
`refreshPrecomputed` + Registry-Trigger + 7 neue Tests + 5 Review-Follow-ups
(H1 atomare `schedule()`, H2 erweiterte Negativ-Coverage, M1 expliziter
`.catch()`, M2 Race-3-Tests, L1 `expectedUrl` als aktiver URL-Guard).

**Source:** Story 18.5 (`_bmad-output/implementation-artifacts/18-5-speculative-prefetch-waehrend-llm-denkzeit.md`).

## FR-038: Tool-Rename read_page → view_page, screenshot → capture_image — gefixt (Story 20.2)

**Problem:** LLMs greifen bei "kannst du das sehen?"-Prompts zu `screenshot`
statt `read_page`, weil "screenshot" semantisch naeher an "sehen" liegt als
"read_page" (= "lesen"). In realen Steuer4-Sessions war die screenshot:read_page-
Rate konsistent hoch (30-54%), auch nach Steering-Fixes in Descriptions und
Response-Hints.

**Root Cause:** Der Tool-NAME ist das staerkste Steering-Signal. "screenshot"
triggert den Reflex direkt, Descriptions werden nach Tool-Search/Deferred-Tools-
Load nicht mehr staendig gesehen.

**Fix:** Reines String-Rename — keine Logik-Aenderung:
- `read_page` → `view_page`: "view" = "sehen/ansehen" — matcht den User-Trigger.
- `screenshot` → `capture_image`: `capture_`-Praefix impliziert Aufwand/Kosten.
- Alle Descriptions, Response-Hints, Server-Instructions und Cross-Referenzen
  in anderen Tool-Descriptions aktualisiert.
- run_plan Schema und plan-executor ErrorStrategy/SuspendConfig angepasst.

**Aufwand:** Niedrig — ~50 String-Ersetzungen in Source, ~100 in Tests.

---

## FR-039: Click-Diff priorisiert StaticText ueber interaktive Elemente (P3 — wontfix)

### Problem
`formatDomDiff()` schneidet bei 30 Eintraegen ab (`maxLines = 30` in
`src/cache/a11y-tree.ts:3449`). Innerhalb der Change-Typen (added/changed/
removed) werden Elemente in DOM-Reihenfolge ausgegeben — StaticText-Eintraege
ohne Ref (z.B. `"|"`, `"Betrag"`, `"-"`) verbrauchen Slots die fuer
interaktive Elemente mit Ref gebraucht wuerden.

**Beobachtete Auswirkung (Session 6121335d, Steuer4):**
Click auf "Umsaetze anzeigen" erzeugte 60 DOM-Aenderungen. Die ersten 30
enthielten ~10 StaticText-Eintraege ohne Ref. Das Suchfeld `[e145] textbox
"Name, Beschreibung oder Kommentar suchen"` landete in den versteckten 30
Aenderungen. Das LLM brauchte ein extra `view_page` (7.158 Chars, ~1.789
Tokens) um das Suchfeld zu finden.

### Root Cause
`formatDomDiff()` sortiert nach Change-Typ (alerts → added → changed →
removed), aber innerhalb jedes Typs gibt es keine Priorisierung von
interaktiven Elementen ueber nicht-interaktive.

### Betroffene Dateien
`src/cache/a11y-tree.ts` — `formatDomDiff()`, Zeile ~3437 (Sortier-Logik).

### Fix-Vorschlag
Innerhalb jedes Change-Typs interaktive Elemente (die mit Ref) vor
StaticText (ohne Ref) sortieren. Einzeiler-Aenderung in der `priority()`-
Funktion: `if (!INTERACTIVE_ROLES.has(c.role) && !CONTEXT_ROLES.has(c.role)) p += 5;`

### Warum wontfix
1. **v0.7.3 DOM-Diff auf type/fill_form** adressiert den Hauptimpact: Nach
   dem Tippen in ein Suchfeld bekommt das LLM jetzt den DOM-Diff mit den
   Suchergebnissen — das extra `view_page` nach `type` entfaellt.
2. **Marginaler Gewinn:** Spart ~1 Call bei Seiten mit 30+ DOM-Aenderungen
   auf Click. Auf den meisten Seiten hat Click <30 Aenderungen.
3. **LLM-Verhalten:** Selbst wenn e145 im Diff sichtbar waere, koennte das
   LLM trotzdem ein `view_page` machen um den vollen Seiten-Kontext zu sehen.

**Aufwand:** Minimal
**Session:** 6121335d-67ff-4c12-9133-4ec8e60f4064
**Hinweis:** finden des Umsatzes

---

## FR-040: Pro-Server onToolResult Hook ignoriert type/fill_form — Deferred DOM-Diff toter Code (P2)

### Problem
Die v0.7.3 Erweiterung des deferred DOM-Diff auf type und fill_form
(`src/hooks/default-on-tool-result.ts`) ist **toter Code** wenn der
Pro-Server aktiv ist. Der Pro-Server registriert seinen eigenen
`onToolResult`-Hook (`silbercuechrome-pro/src/visual/ambient-context.ts`),
der den Free-Default-Hook ersetzt. Der Pro-Hook hat als Scope-Gate
`if (toolName !== "click") return result;` (Zeile 47) — type und fill_form
werden komplett ignoriert.

**Auswirkung:** Nach type in ein Suchfeld bekommt das LLM nur
`Typed "X" into textbox...` (69 Chars) ohne DOM-Diff. Es braucht ein
zusaetzliches view_page um die gefilterten Ergebnisse zu sehen — genau
die Friction die v0.7.3 fixen sollte.

### Root Cause
`src/registry.ts:1008-1012` installiert den Free-Default-Hook NUR wenn
kein Pro-Hook gesetzt ist:
```typescript
if (!hooksAfterFeatureGate.onToolResult) {
  registerProHooks({ ...hooksAfterFeatureGate, onToolResult: createDefaultOnToolResult() });
}
```
Der Pro-Server ruft `registerProHooks()` VOR `registerAll()` auf, sodass
`hooksAfterFeatureGate.onToolResult` gesetzt ist und der Default nie
installiert wird.

### Session-Evidenz
Testlauf 2026-04-13: MCP reconnect mit v0.7.3 Build, type "10132" in
Steuer4-Suchfeld, view_page danach zeigte KEINEN piggybacked Diff.
Click-Diff funktionierte (55 changes inline) — beweist dass der
Pro-Hook aktiv ist und NUR click behandelt.

### Betroffene Dateien
1. `silbercuechrome-pro/src/visual/ambient-context.ts` — Scope-Gate
   erweitern, deferred Pfad fuer type/fill_form hinzufuegen
2. `src/hooks/default-on-tool-result.ts` — `computeDiff` exportieren
   damit der Pro-Hook ihn wiederverwenden kann (kein Code-Duplikat)

### Fix-Vorschlag
1. In `src/hooks/default-on-tool-result.ts`: `computeDiff` als `export`
   markieren (aktuell module-intern)
2. In `silbercuechrome-pro/src/visual/ambient-context.ts`:
   - Import `computeDiff` aus `@silbercue/chrome/hooks/default-on-tool-result.js`
   - Import `deferredDiffSlot` aus `@silbercue/chrome/cache/deferred-diff-slot.js`
   - Scope-Gate erweitern: `const DIFF_TOOLS = new Set(["click","type","fill_form"]); if (!DIFF_TOOLS.has(toolName)) return result;`
   - Click-Pfad bleibt synchron (Zeile 51-92 unveraendert)
   - Neuer Pfad fuer type/fill_form: Before-Snapshot + `deferredDiffSlot.schedule(async (signal) => computeDiff(before, context, 350, 500, signal))` + return result unchanged

**Aufwand:** Mittel — zwei Repos, Import-Pfade pruefen, Tests
**Session:** 6121335d-67ff-4c12-9133-4ec8e60f4064
**Hinweis:** finden des Umsatzes

**Source:** Story 20.2.

---

## FR-041: CDP Session stirbt → virtual_desk zeigt Tab als "ready" aber kein Auto-Reconnect (P2)

### Problem

In Session `336cd4e1` starb die CDP Session mitten in der Arbeit auf `bahn.de`. Das LLM rief `virtual_desk` 6× auf — jedes Mal `OK` ohne `>`-Marker — und versuchte danach `navigate`/`view_page`/`capture_image` die alle mit `-32001: Session with given id not found` scheiterten.

Tool-Sequenz (22:36:42–22:37:55):
```
22:36:42  navigate(bahn.de/reiseuebersicht) → ERROR -32001
22:36:43  virtual_desk → OK (Tab als "ready", kein > Marker)
22:36:46  navigate(bahn.de/reiseuebersicht) → ERROR -32001
22:36:47  virtual_desk → OK
22:36:56  view_page → ERROR -32001
22:36:57  virtual_desk → OK
22:37:07  navigate(bahn.de/reiseuebersicht, settle_ms:2000) → ERROR -32001
22:37:47  virtual_desk → OK
22:37:49  view_page → ERROR -32001
22:37:51  virtual_desk → OK
22:37:55  capture_image → ERROR -32001
```

6 nutzlose virtual_desk Calls, kein Recovery.

### Root Cause

`tabStateCache.activeTargetId` zeigte auf die geschlossene Steuer-Automat-Tab (`2F263361...`), nicht auf die bahn.de-Tab (`F8C625...`). Deshalb kein `>`-Marker — SilbercueChrome hat keinen aktiven Tab.

`virtual_desk` listet Tabs aus `Target.getTargets` und prüft `tab.targetId === activeId`. Wenn `activeId` veraltet ist (Target nicht mehr in der Liste), erscheint kein `>`. virtual_desk führt dabei **keine** Auto-Reconnect-Logik aus.

Mutmaßliche Ursache des Session-Tods: CDP WebSocket Reconnect zwischen 22:34:16 und 22:36:42 (146s Lücke) invalidierte alle bestehenden Session-IDs — verwandt mit BUG-003 (Node 22 + Chrome WebSocket). Nach Reconnect kennt Chrome die alten Session-IDs nicht mehr.

Das LLM sieht `ready`-Tab ohne `>`, versteht nicht dass es `switch_tab` braucht, versucht `navigate` direkt → Endlosloop.

### Betroffene Dateien

1. `src/tools/virtual-desk.ts` — kein Auto-Attach wenn activeId veraltet
2. `src/cache/tab-state-cache.ts` — `activeTargetId` wird nicht auf verfügbare Tabs bereinigt
3. `src/cdp/chrome-launcher.ts` — Reconnect-Logik reaktiviert Session nicht nach WebSocket-Wiederverbindung

### Fix-Vorschlag

**Option A (Minimal — Steering-Fix, kein Code-Change in Reconnect-Logik):**

Wenn `virtual_desk` aufgerufen wird und `activeId` auf keinen existierenden Tab zeigt: den ersten verfügbaren Tab als neuen `activeTargetId` setzen und in der Response signalisieren:
```
> Tab 1: F8C625... | ready | Reisedetails | bahn.de/...  (auto-selected: previous session lost)
Note: No active session found — auto-selected Tab 1. Call navigate to load the desired URL.
```

**Option B (Robust — Session Recovery):**

In `navigate`/`view_page` nach `-32001` automatisch `Target.attachToTarget({ targetId })` aufrufen um eine neue CDP Session zu erhalten, dann den Original-Call wiederholen. Max 1 Retry pro Call.

**Empfehlung:** Option A zuerst (einfach, kein Risiko), dann Option B separat wenn noch nötig.

**Aufwand:** Niedrig (Option A) / Mittel (Option B)
**Session:** 336cd4e1-013c-423d-8f5c-9542b73ddc5f
**Hinweis:** Oje was denn da los?

---

## FR-042: navigate-Response gibt kein "call view_page"-Signal — LLM wechselt zu evaluate (P1)

### Problem

In Session `297995ca` (Hakuna-Matte Dev-Workflow): 18 von 19 navigate-Calls wurden von evaluate gefolgt statt view_page. Das LLM lud die Seite nach Code-Änderungen neu und prüfte dann sofort den JS-State via evaluate, weil die navigate-Response kein Signal gibt was als nächstes zu tun ist.

Tool-Sequenz (exemplarisch, 18x wiederholt):
```
23:51:26  navigate(http://localhost:8080/hakuna-matte/) → "Navigated to ... — Hakuna Matte Analysis"
23:51:33  evaluate (statt view_page)
```

Die navigate-Response lautet nur: `"Navigated to <url> — <title>"`. Kein Hinweis auf view_page.

Die view_page Tool-Description sagt "Call this after navigate/click/switch_tab" — aber das greift nicht, weil das LLM nach navigate direkt JS-State inspizieren will und dabei evaluate statt view_page wählt.

### Root Cause

`buildSuccessResponse` in `src/tools/navigate.ts` (Zeile 203-205) baut nur:
```
"Navigated to <url> — <title>"
```
Kein Folge-Hinweis. Das LLM muss aus der Tool-Description schließen was als nächstes sinnvoll ist — und wählt evaluate weil es JS-State prüfen will.

### Betroffene Dateien

- `src/tools/navigate.ts` — `buildSuccessResponse()` (Zeilen 203-214)

### Fix-Vorschlag

In `buildSuccessResponse` nach dem Title-Block ergänzen:
```typescript
text += "\nCall view_page to see the page content and interactive elements, or evaluate() to check JavaScript state.";
```

Gilt auch für `handleBack` (gleicher Pfad → `buildSuccessResponse`).

**Aufwand:** Minimal — 1 Zeile
**Session:** 297995ca-574e-4b88-bfd5-7e683dfb7c5d
**Hinweis:** Dev-Workflow Hakuna-Matte — 18x navigate→evaluate statt navigate→view_page

---

## FR-043: capture_image Description erlaubt "CSS layout" — inspect_element als Alternative fehlt (P1)

### Problem

In Session `297995ca` (Hakuna-Matte Dev-Workflow): 31 capture_image-Calls für visuelle Layout-Verifikation nach CSS-Änderungen. Der User beschwerte sich explizit: "Was machst du gerade 12 Mal Screenshot?"

Das LLM handelte korrekt gemäß der Tool-Description — die explizit sagt:
> "The ONLY valid uses: **(1) checking CSS layout or visual rendering**..."

Aber für CSS-Layout-Verifikation wäre `inspect_element` besser: liefert computed styles, CSS-Regeln mit source:line und einen visuellen Clip — ohne den Token-Overhead eines Screenshots.

### Root Cause

Die capture_image Description nennt "CSS layout or visual rendering" als primären Use Case. Das steers das LLM aktiv in Richtung capture_image für genau den Fall, wo inspect_element überlegen wäre.

### Betroffene Dateien

- `src/registry.ts` — capture_image Tool-Description (Zeile 1516) und STOP-Message (Zeile 1547)

### Fix-Vorschlag

Description ändern von:
```
"The ONLY valid uses: (1) checking CSS layout or visual rendering, (2) canvas/chart content that has no DOM, (3) the user explicitly asks for a screenshot."
```
zu:
```
"The ONLY valid uses: (1) canvas/chart content that has no DOM text, (2) pixel-level animation or rendering comparison, (3) the user explicitly asks for a screenshot. For CSS layout or element positioning: use inspect_element (returns computed styles + visual clip + source locations)."
```

STOP-Message (Zeile 1547) ergänzen:
```
"STOP: You just used capture_image. For CSS layout verification use inspect_element instead — it returns computed styles, source locations and a visual clip. Next time you want to see page content, call view_page."
```

**Aufwand:** Minimal — Text-Änderungen
**Session:** 297995ca-574e-4b88-bfd5-7e683dfb7c5d
**Hinweis:** 31 Screenshots in Dev-Workflow, User-Beschwerde "12 Mal Screenshot"

---

## FR-044: Kein reload-Action in navigate — LLM nutzt navigate(same_url) als Seiten-Refresh (P2)

### Problem

In Session `297995ca`: 18 von 26 navigate-Calls navigierten zur selben URL (`http://localhost:8080/hakuna-matte/`) — als Seiten-Reload nach Code-Änderungen. Ein dediziertes `reload`-Tool würde:
1. Die semantische Absicht klarmachen
2. Eine spezifische Response ermöglichen: "Reloaded. Previous refs are stale — call view_page for fresh refs, or evaluate() to check JavaScript state."
3. Kürzer sein (`reload` statt `navigate(url)`)

### Root Cause

`navigate` hat nur `action: "goto" | "back"`. Kein `reload`. Das LLM muss navigate(same_url) nutzen, weil es keinen besseren Weg gibt — und die navigate-Response ist identisch zu einer echten Navigation.

### Betroffene Dateien

- `src/tools/navigate.ts` — Schema und Handler
- `src/registry.ts` — navigate Tool-Description

### Fix-Vorschlag

`navigateSchema` erweitern:
```typescript
action: z.enum(["goto", "back", "reload"]).optional().default("goto")
  .describe("Navigation action: goto (default), back, or reload (refreshes current page)")
```

Handler-Zweig für reload:
```typescript
if (params.action === "reload") {
  await cdpClient.send("Page.reload", {}, sessionId);
  await settle({ cdpClient, sessionId: sessionId!, ... });
  return { content: [{ text: "Reloaded. Previous element refs are stale — call view_page for fresh refs, or evaluate() to check JavaScript state." }], ... };
}
```

navigate Tool-Description ergänzen:
```
"...or action:'reload' to refresh the current page (all element refs become stale)."
```

**Aufwand:** Niedrig
**Session:** 297995ca-574e-4b88-bfd5-7e683dfb7c5d
**Hinweis:** 18 navigate(same_url) = reload in Dev-Workflow

---

## FR-045: evaluate-Spiral-Hint wird ignoriert — Escalation fehlt (P1 — Session 74b2a8fc)

### Problem

In Session `74b2a8fc` (Amazon Payments, Aufgabe "finde Transaktion 26. Nov 2025, 41,22 € AMZN Mktp DE" — Transaktion lag ausserhalb des geladenen Zeitraums):

- 47 MCP-Calls, 26 davon evaluate (55 %)
- **4 evaluate-Spiralen: 4x / 5x / 5x / 8x**
- **17 Mal** wurde der FR-020 Streak-Hint ("Warning: N consecutive querySelector-based evaluate calls detected...") in die evaluate-Response injiziert
- **17 Mal ignoriert**, Agent evaluated weiter

Der Hint funktioniert technisch (wird korrekt emittiert ab Streak 3), aber er erreicht das LLM nicht als Verhaltens-Aenderung. Das Pattern ist **Alarm-Fatigue**: identischer Text, keine Eskalation, kein Block.

Dazu: Der gelieferte Hint ist zu generisch — empfiehlt nur `view_page` fuer fresh refs. Auf der Run-8-Session wurde die gesuchte Transaktion aber nicht von der aktuellen Seite angezeigt (ausserhalb Zeitfenster). Der richtige Pfad waere `navigate` zur Bestellhistorie oder `scroll` durch einen virtualisierten Container — beides nicht im Hint-Text.

### Root Cause

`src/telemetry/tool-sequence.ts` `maybeEvaluateStreakHint()` emittiert genau zwei statische Texte:
1. Tier 1 (querySelector, Streak >= 3): fix-formulierter Stale-Ref-Hint — wird 17x identisch ausgespielt
2. Tier 2 (any-evaluate, Streak >= 5): Tool-Liste als Alternativen — wird ueberschrieben von Tier 1 sobald querySelector-Flag gesetzt ist

Drei Schwaechen:
- **Keine Variation:** Exakt gleicher Text bei Streak 3, 5, 8.
- **Kein Block:** Auch bei Streak 10+ wird der Call weiter ausgefuehrt.
- **Zu enger Loesungsvorschlag:** Nur `view_page` empfohlen, `navigate` und `scroll(container_ref)` fehlen.

### Session-Evidenz (Tool-Sequenz)

```
21:40:53-21:41:06  Spirale 1 (4x evaluate, Hint ab 3. Call)
21:41:08  view_page                              ← Reset
21:41:19-21:41:43  Spirale 2 (5x evaluate, 3x Hint identisch)
21:41:48  view_page                              ← Reset
21:41:55-21:42:11  Spirale 3 (5x evaluate, 3x Hint identisch)
21:42:18  view_page                              ← Reset
21:43:07-21:43:56  Spirale 4 (8x evaluate, 6x Hint identisch — Peak Alarm-Fatigue)
```

Der Hint-Text aus Spirale 1 Call 3 war exakt gleich wie in Spirale 4 Call 8 — das LLM lernt "ich darf das ignorieren".

### Betroffene Dateien

- `src/telemetry/tool-sequence.ts` — `maybeEvaluateStreakHint()` statische Rueckgabe (Z. 142-168)
- `src/tools/evaluate.ts` — evaluateHandler haengt Hint an (Z. 301-315). Kein Block-Mechanismus.

### Fix-Vorschlag (3-Tier-Escalation, Context7-informiert)

Basiert auf Context7-Recherche 2026-04-19 (MCP-Spec 2025-11-25 + Anthropic Context-Engineering Blog). Begriffsdefinition: "Context Rot" = Phaenomen dass LLMs identische Warnungen in langen Threads kognitiv rausfiltern. Die Spec erlaubt `isError: true` explizit als "actionable feedback for self-correction" — kein Hard-Block, aber starkes Signal.

**Tier 1 (Streak 3-4) — Sachlich, wie heute.**
Fix-Text unveraendert. Niedriges Alarm-Niveau, legitimer Early-Warn.

**Tier 2 (Streak 5-7) — Variierender Text mit 3 Alternativen.**
- Statt statischem Text: rotierendes 3-aus-N-Set mit konkreten Action-Verben: `navigate(url)`, `view_page(ref, filter:"all")`, `scroll(container_ref)`.
- Analysiert das letzte evaluate-Argument kontext-sensitiv: wenn `querySelectorAll('a')` + textContent-Filter → **navigate-Hint** ("You are filtering links with JS — navigate directly to the target URL."). Wenn `getBoundingClientRect` + scroll-Logic → **scroll-Hint** ("scroll supports ref/container, no JS needed."). Sonst: generischer Tool-Katalog.
- Response bleibt `isError: false`, JS-Result wird ausgeliefert.

**Tier 3 (Streak >= 8) — `isError: true` + Result-Preservation.**
- Response wird mit `isError: true` gesetzt, Text-Payload: "STOP — N consecutive querySelector-evaluates. The JS returned: <result>. But this workflow pattern indicates the page does not contain the answer. Required next action: navigate(url) to a different page, or summarise findings and stop."
- **Wichtig:** Das JS-Result wird NICHT weggeschnitten, sondern IN den Error-Text eingebettet. Der Agent bekommt alle Informationen und zusaetzlich ein eindeutiges Self-Correction-Signal. MCP-Spec-konform (Anthropic: `isError: true` ist "actionable feedback", nicht Hard-Block).
- Silent-Reset nach einem erfolgreichen `navigate` / `click` / `fill_form` / `type` / `scroll` — der Tier-Hinweis greift nur auf zusammenhaengender Spirale.

**Optional Tier 4 (Streak >= 12) — Hard-Refuse.**
- Nur wenn der Agent auch nach Tier 3 weiter evaluated (sehr selten, aber moeglich bei Model-Regression): `isError: true`, **kein** JS-Ausfuehrung. Text: "REFUSED — 12 consecutive querySelector-evaluates. Further evaluate calls are blocked until you call navigate, view_page, or explicitly signal task abort." Defensive Guard, nicht Default-Pfad.

### Allgemeingueltigkeit

### Allgemeingueltigkeit

Der Fix greift an `src/telemetry/tool-sequence.ts` an — einem reinen Telemetry-Modul das von jedem Tool genutzt wird. Keine Seiten-Spezifik. Escalation-Logik gilt fuer jede evaluate-Spirale unabhaengig von der Domain (Amazon, Hakuna, Benchmark, whatever).

**Aufwand:** Niedrig — Progressive-Tier-Logik in `maybeEvaluateStreakHint()` erweitern + 2-3 neue Tests in `tool-sequence.test.ts`.

**Session:** 74b2a8fc-097c-4568-a372-f453651a9dfa (Multi-Run Serie 2 Run 8, Vision-POC-Datenbasis 2026-04-18)
**Hinweis:** harte Aufgabe "26. November 2025, 41,22 € AMZN Mktp DE" — Transaktion lag ausserhalb Zeitfenster, Agent blieb trotz 17 Hints auf der gleichen Seite stuck statt zu navigate-n.
