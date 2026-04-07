# Pro-Repo Setup Guide

## Uebersicht

Das Pro-Repo (`silbercuechrome-pro`) erweitert den Free-Tier-Code mit Pro-Features.
Es importiert `@silbercuechrome/mcp` als Dependency und registriert Pro-Implementierungen
ueber das Hook-System.

## Pro-Repo Struktur

```
silbercuechrome-pro/
  src/
    index.ts          # Entry-Point: registerProHooks() + startServer()
    gates/
      dom-snapshot.ts # featureGate fuer dom_snapshot
    ...
  package.json
  tsconfig.json
```

## package.json

```json
{
  "name": "@silbercuechrome/mcp-pro",
  "type": "module",
  "main": "./build/index.js",
  "bin": {
    "silbercuechrome-pro": "./build/index.js"
  },
  "dependencies": {
    "@silbercuechrome/mcp": "file:../silbercuechrome"
  }
}
```

Nach npm-Publish kann `file:../silbercuechrome` durch eine Versionsreferenz ersetzt werden.

## tsconfig.json

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "declaration": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "build", "src/**/*.test.ts"]
}
```

## Entry-Point (src/index.ts)

```typescript
#!/usr/bin/env node
import { registerProHooks } from "@silbercuechrome/mcp/hooks";
import { startServer } from "@silbercuechrome/mcp";

// Register Pro-Feature-Implementierungen VOR startServer()
registerProHooks({
  featureGate: (toolName) => {
    // Beispiel: dom_snapshot nur fuer Pro-User
    if (toolName === "dom_snapshot") {
      return { allowed: false, message: "dom_snapshot requires a Pro license" };
    }
    return { allowed: true };
  },

  // Story 15.3: Ambient-Context-Enrichment via 3-Stufen-Klick-Analyse.
  // Der onToolResult-Hook ist der Kern des Ambient-Context-Enrichment-Patterns
  // — das Free-Repo liefert nur die rohen a11yTree-APIs, das Pro-Repo
  // orchestriert die 3-Stufen-Analyse (classifyRef → waitForAXChange →
  // diffSnapshots → formatDomDiff).
  //
  // Alle noetigen Methoden sind auf `context.a11yTree` verfuegbar, inklusive
  // `diffSnapshots` und `formatDomDiff`. Das separate `context.a11yTreeDiffs`
  // existiert weiterhin als Backward-Compat-Alias.
  onToolResult: async (toolName, result, context) => {
    // Beispiel: Ambient Context nach einem Klick auf ein interaktives Element
    if (toolName === "click" && result._meta?.elementClass === "clickable") {
      const snapshotBefore = context.a11yTree.getSnapshotMap();
      await context.waitForAXChange?.(350);
      await context.a11yTree.refreshPrecomputed(
        context.cdpClient,
        context.sessionId,
        context.sessionManager,
      );
      const snapshotAfter = context.a11yTree.getSnapshotMap();
      const changes = context.a11yTree.diffSnapshots(snapshotBefore, snapshotAfter);
      const diffText = context.a11yTree.formatDomDiff(
        changes,
        context.a11yTree.currentUrl || undefined,
      );
      if (diffText) {
        result.content.push({ type: "text", text: diffText });
      }
    }
    return result;
  },

  // enhanceTool optional
});

startServer();
```

## Abhaengigkeitsrichtung

```
silbercuechrome-pro  -->  @silbercuechrome/mcp
     (privat)              (oeffentlich)
```

Das Free-Repo hat KEIN Wissen ueber das Pro-Repo.
Kein `try/catch`-Import, kein bedingter `require()`.

## Build-Prozess

```bash
# Im Pro-Repo:
npm install          # Installiert @silbercuechrome/mcp als Dependency
npm run build        # Kompiliert Pro-Code
node build/index.js  # Startet Pro-Server
```
