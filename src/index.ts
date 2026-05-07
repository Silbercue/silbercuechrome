#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import { dispatchTopLevelCli } from "./cli/top-level-commands.js";

export { startServer } from "./server.js";
export type { StartServerOptions } from "./server.js";
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
// im SEA-Bundle). Im Source-Mode ist die Konstante nicht definiert.
declare const __SCC_NAME__: string;

const FREE_PACKAGE_NAME = "public-browser";

// Nur als CLI ausfuehren, wenn die Datei direkt gestartet wurde
// (nicht wenn sie als Library importiert wird).
// Robuste, symlink- und Windows-sichere Pruefung via realpath.
const isMainModule = (() => {
  if (isSeaBuild) {
    // Im SEA-Bundle: Wenn ein Build-Time-Marker gesetzt ist, der NICHT auf
    // das eigene Package zeigt, dann sind wir nur eine ein-gebundelte
    // Library — NICHT der Entry-Point.
    if (typeof __SCC_NAME__ === "string" && __SCC_NAME__ !== "" && __SCC_NAME__ !== FREE_PACKAGE_NAME) {
      return false;
    }
    // Sonst: das Binary IST der Entry-Point. `import.meta.url` ist leer
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

  {
    // Top-Level Subcommands (version/status/help).
    // Wenn dispatchTopLevelCli einen Subcommand erkennt, beendet es den
    // Prozess via process.exit(). Sonst → false zurueck → Server starten.
    //
    const attach = process.argv.includes("--attach");
    const script = process.argv.includes("--script");

    // --profile <name>: extract the value following the flag
    let profile: string | undefined;
    const profileIdx = process.argv.indexOf("--profile");
    if (profileIdx !== -1 && profileIdx + 1 < process.argv.length) {
      profile = process.argv[profileIdx + 1];
    }

    // Filter flags (and --profile's value) from argv before dispatch
    const flagsToFilter = new Set(["--attach", "--script", "--profile"]);
    const filteredArgv = process.argv.filter((arg, idx) => {
      if (flagsToFilter.has(arg)) return false;
      if (idx > 0 && process.argv[idx - 1] === "--profile") return false;
      return true;
    });

    dispatchTopLevelCli(filteredArgv, import.meta.url)
      .then((handled) => {
        if (handled) return;
        return startServer({ attach, script, profile });
      })
      .catch((err) => {
        console.error("Fatal:", err);
        process.exit(1);
      });
  }
}
