#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import { runLicenseCommand } from "./cli/license-commands.js";
import { dispatchTopLevelCli } from "./cli/top-level-commands.js";

export { startServer } from "./server.js";
export { runLicenseCommand } from "./cli/license-commands.js";
export { dispatchTopLevelCli } from "./cli/top-level-commands.js";

// SEA-Detection (Phase 3b): In einem Single-Executable-Application-Bundle
// liefert esbuild fuer `import.meta.url` ein leeres Objekt, wodurch
// `fileURLToPath(import.meta.url)` wirft und die bisherige isMainModule-
// Pruefung immer `false` lieferte — das Binary beendete sich dann still
// mit Exit 0, weil weder dispatchTopLevelCli noch startServer aufgerufen
// wurde.
//
// Loesung: `node:sea.isSea()` via createRequire(process.execPath) pruefen.
// process.execPath ist in JEDEM Modus gesetzt (Source: `node`-Binary-Pfad,
// SEA: das Binary selbst). createRequire akzeptiert jeden existierenden
// Pfad und liefert eine Funktion, die Core-Module aufloesen kann. Damit
// funktioniert der Check synchron in BEIDEN Modi (ESM-Source + CJS-SEA).
const isSeaBuild = (() => {
  try {
    const req = createRequire(process.execPath);
    const sea = req("node:sea") as { isSea?: () => boolean };
    if (sea && typeof sea.isSea === "function") return sea.isSea();
  } catch {
    /* fall through */
  }
  return false;
})();

// Build-time-Konstante fuer den Package-Name (vom esbuild --define injiziert
// im SEA-Bundle). Wird genutzt um zu erkennen, ob das Free-Repo gerade als
// EIGENE SEA-Binary laeuft (Free-Bundle) oder als Library in einem Fremd-
// bundle (z.B. Pro-Bundle, das `startServer` aus `@silbercue/chrome`
// importiert). Im Source-Mode ist die Konstante nicht definiert.
declare const __SCC_NAME__: string;

const FREE_PACKAGE_NAME = "@silbercue/chrome";

// Nur als CLI ausfuehren, wenn die Datei direkt gestartet wurde
// (nicht wenn sie als Library importiert wird — z.B. vom Pro-Repo).
// Robuste, symlink- und Windows-sichere Pruefung via realpath.
const isMainModule = (() => {
  if (isSeaBuild) {
    // Im SEA-Bundle: Wenn ein Build-Time-Marker gesetzt ist, der NICHT auf
    // das Free-Package zeigt (z.B. "@silbercue/chrome-pro"), dann sind
    // wir nur eine ein-gebundelte Library — NICHT der Entry-Point.
    if (typeof __SCC_NAME__ === "string" && __SCC_NAME__ !== "" && __SCC_NAME__ !== FREE_PACKAGE_NAME) {
      return false;
    }
    // Sonst: das Binary IST der Free-Repo-Entry. `import.meta.url` ist leer
    // und `fileURLToPath` wuerde werfen — also direkt true zurueckgeben.
    return true;
  }
  if (!process.argv[1]) return false;
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const argv1Path = realpathSync(process.argv[1]);
    return modulePath === argv1Path;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const command = process.argv[2];

  if (command === "license") {
    // Bestehender `license <sub>`-Pfad — siehe src/cli/license-commands.ts
    runLicenseCommand(process.argv.slice(3)).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  } else {
    // Phase 2: Top-Level Subcommands (version/status/activate/deactivate/help).
    // Wenn dispatchTopLevelCli einen Subcommand erkennt, beendet es den
    // Prozess via process.exit(). Sonst → false zurueck → Server starten.
    dispatchTopLevelCli(process.argv, import.meta.url)
      .then((handled) => {
        if (handled) return;
        return startServer();
      })
      .catch((err) => {
        console.error("Fatal:", err);
        process.exit(1);
      });
  }
}
