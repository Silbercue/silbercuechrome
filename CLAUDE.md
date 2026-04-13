# SilbercueChrome

## Build & Run

```bash
# Bauen
npm run build          # tsc → build/

# Unit-Tests
npm test               # vitest run (1100+ Tests)

# MCP-Server starten (fuer Live-Tests via MCP-Client)
node build/index.js    # Stdio-Transport, verbindet sich zu Chrome via CDP
```

### Dev-Mode (lokaler Build statt Binary)

```bash
npm run dev          # baut Free+Pro, schaltet MCP auf lokalen Build
npm run dev:off      # schaltet zurueck auf Homebrew-Binary
npm run dev:status   # zeigt aktiven Modus
```

Tauscht die Homebrew-Binary (`/opt/homebrew/bin/silbercuechrome`) gegen ein
Wrapper-Script das den lokalen Build startet. Damit greift MCP reconnect
sofort — kein Claude Code Neustart noetig. `/silbercuechrome-publish`
stellt die Original-Binary automatisch wieder her.

**Wann Dev-Mode nutzen:** Bei JEDEM Code-Fix der live im Browser verifiziert
werden muss (Frictions, Bugs, neue Features). Ohne Dev-Mode laeuft der MCP
auf der alten Binary und Aenderungen sind unsichtbar. Workflow:
`npm run dev` → `mcp-control reconnect` → testen → iterieren → am Ende
`npm run dev:off` oder direkt `/silbercuechrome-publish`.

### Connection Modes

SilbercueChrome verbindet sich beim Start in dieser Reihenfolge:

1. **Auto-Launch (Default, Zero-Config):** Wenn kein Chrome auf Port 9222 laeuft, startet SilbercueChrome selbst einen Chrome-Kindprozess mit `--remote-debugging-pipe` und allen noetigen Flags (inklusive `--disable-backgrounding-occluded-windows` fuer zuverlaessige Screenshots). Chrome oeffnet sich **sichtbar** als Fenster — kein Headless. Das ist der Standard-Weg und erfordert keine Vorbereitung vom Nutzer.
2. **WebSocket (optional):** Wenn bereits ein Chrome mit Remote-Debugging auf Port 9222 laeuft, verbindet sich SilbercueChrome via WebSocket an diesen existierenden Browser. Nutze das, wenn du deinen eigenen Chrome (inklusive deiner Login-Sessions) steuern willst.
3. **Fehler:** Wenn `autoLaunch=false` gesetzt ist und kein Chrome laeuft, wirft SilbercueChrome einen Verbindungsfehler.

**Umgebungsvariablen:**

| Variable | Werte | Default | Beschreibung |
|----------|-------|---------|-------------|
| `SILBERCUE_CHROME_AUTO_LAUNCH` | `true` / `false` | `true` | Chrome automatisch starten wenn kein laufendes Chrome gefunden |
| `SILBERCUE_CHROME_HEADLESS` | `true` / `false` | `false` | Chrome im Headless-Modus starten (Opt-in fuer CI/Server-Umgebungen) |
| `SILBERCUE_CHROME_PROFILE` | Pfad | — | Chrome-Profilverzeichnis (nur bei Auto-Launch) |
| `SILBERCUE_CHROME_FULL_TOOLS` | `true` / `false` | `false` | Exponiert den vollen Tool-Satz (21 Tools) statt des schlankeren Default-Sets (10 Tools) in tools/list |
| `CHROME_PATH` | Pfad | — | Pfad zur Chrome-Binary (ueberschreibt automatische Erkennung) |

### Advanced — Eigenen Chrome steuern

Wenn du deinen eigenen Chrome (mit Login-Sessions, Extensions, Profil) steuern willst, starte ihn mit Remote-Debugging, bevor SilbercueChrome startet:

```bash
# Chrome mit Remote Debugging starten (macOS) — alle Flags fuer zuverlaessige Screenshots
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling
```

**Wichtig:** Ohne `--disable-backgrounding-occluded-windows` liefert `capture_image` schwarze Bilder wenn das Chrome-Fenster verdeckt oder auf einem anderen Monitor ist. Bei Auto-Launch werden diese Flags automatisch gesetzt.

## Test Hardest — Benchmark-Seite

`test-hardest/index.html` ist die lokale Benchmark-Seite fuer SilbercueChrome MCP-Testing.

- **Starten:** `cd test-hardest && python3 -m http.server 4242` → http://localhost:4242
- **22 Tests** in 4 Levels: Basics → Intermediate → Advanced → Hardest
- **Zweck:** MCP-Faehigkeiten benchmarken und gegen Konkurrenten (Playwright MCP, claude-in-chrome, browser-use) vergleichen
- **Metriken:** Zeit (ms), Pass/Fail, JSON-Export — kein Netzwerk, vollstaendig deterministisch
- Neue Tests in `test-hardest/index.html` unter `const Tests = { ... }` hinzufuegen, Benchmark.setResult() aufrufen

### Live-Test-Workflow

1. Chrome mit Remote Debugging starten
2. Benchmark-Server starten: `cd test-hardest && python3 -m http.server 4242`
3. http://localhost:4242 in Chrome oeffnen
4. MCP-Server starten und Tools gegen die Benchmark-Seite ausfuehren
5. Ergebnisse im Results-Tab als JSON exportieren

### Smoke-Test (automatisch)

```bash
node test-hardest/smoke-test.mjs   # 10 Tests, startet MCP-Server intern
```

### Forensik-Delta fuer run_plan (Story 18.1 + 18.2 kumulativ)

`scripts/run-plan-delta.mjs` fuehrt einen festen Referenz-Plan gegen die
lokale Benchmark-Seite aus und misst `response_bytes` + Wall-Clock pro Plan.
Baseline liegt in `test-hardest/ops-run-plan-baseline-v0.5.0.json` (Stand vor
Story 18.1), aktueller Messwert in `test-hardest/ops-run-plan.json`.

```bash
# Baseline einchecken (nur einmal, vor einem Forensik-Fix)
node scripts/run-plan-delta.mjs --baseline

# Delta gegen Baseline messen
# Gates kumulativ Story 18.1 + 18.2: delta_chars >= 2500, delta_ms >= 1500
node scripts/run-plan-delta.mjs
```

Voraussetzung: `npm run build` gelaufen + `cd test-hardest && python3 -m http.server 4242`.

### Benchmark-Daten der Konkurrenten

Liegen als JSON in `test-hardest/benchmark-*.json` und `test-hardest/ops-*.json` (Stand 2026-04-02).

## Tag-20-Checkpoint (Epic 19 Zwischenbilanz)

```bash
npm run checkpoint     # Benchmark-Lauf + Gate-Check in einem Schritt
```

Voraussetzung: Chrome laeuft + `cd test-hardest && python3 -m http.server 4242`.
Prueft MQS >= 66 und Pass-Rate 35/35. Schreibt automatisch einen Eintrag in `docs/pattern-updates.md` (bestanden oder Nachsteuerungs-Notiz mit Entscheidungsgrundlage).

## Bekannte Bugs & Deferred Work

Vollstaendige Bug-Liste mit Reproduktionsschritten und Root-Cause-Analysen: `docs/deferred-work.md`

**2026-04-08 — Session 6dd8f7d3 Postmortem:** BUG-016 (Cross-OOPIF Ref-Kollision via Composite-Key refMap), BUG-017 (switch_tab Cache-Reset), BUG-018 (LLM Defensive Fallback Spiral zu evaluate — dreischichtig gefixt: Tool-Descriptions, zentrale Fail-Recovery-Hints, per-Session Streak-Detector). Details: `docs/deferred-work.md#bug-016` bis `#bug-018`, `docs/friction-fixes.md#fr-018` bis `#fr-020`, Rationale in `docs/research/llm-tool-steering.md` Abschnitt "Anti-Spiral Patterns".

## Context7 — Aktuelle Library-Dokumentation
- Vor jeder Implementierung, die externe Libraries oder Frameworks nutzt,
  automatisch Context7 MCP verwenden (resolve-library-id → get-library-docs)
  — ohne dass der User es explizit anfordern muss.
- Gilt fuer: Architektur-Planung, Implementierung, Code Review.
- **Debugging (3-Strike-Regel):** Nach 3 gescheiterten empirischen Debug-Versuchen
  MUSS Context7 gestartet werden — parallel zum naechsten Debug-Run. Frage:
  "Wie funktioniert [API X] genau bei [Bedingung Y]?" Nicht weiter raten,
  sondern Doku lesen. Besonders relevant fuer CDP-APIs (Koordinatensysteme,
  Event-Dispatch-Semantik, Response-Formate).
