# SilbercueChrome

## Build & Run

```bash
# Bauen
npm run build          # tsc → build/

# Unit-Tests
npm test               # vitest run (363+ Tests)

# MCP-Server starten (fuer Live-Tests via MCP-Client)
node build/index.js    # Stdio-Transport, verbindet sich zu Chrome via CDP
```

Der Server verbindet sich automatisch zu einer laufenden Chrome-Instanz (WebSocket auf Port 9222) oder startet Chrome mit `--remote-debugging-port=9222`. Chrome muss mit Remote Debugging laufen:

```bash
# Chrome mit Remote Debugging starten (macOS)
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

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

### Benchmark-Daten der Konkurrenten

Liegen als JSON in `test-hardest/benchmark-*.json` und `test-hardest/ops-*.json` (Stand 2026-04-02).

## Bekannte Bugs & Deferred Work

Vollstaendige Bug-Liste mit Reproduktionsschritten und Root-Cause-Analysen: `docs/deferred-work.md`

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
