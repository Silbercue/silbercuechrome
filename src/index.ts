#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import { runLicenseCommand } from "./cli/license-commands.js";
import { dispatchTopLevelCli } from "./cli/top-level-commands.js";

export { startServer } from "./server.js";
export { runLicenseCommand } from "./cli/license-commands.js";
export { dispatchTopLevelCli } from "./cli/top-level-commands.js";

// Nur als CLI ausfuehren, wenn die Datei direkt gestartet wurde
// (nicht wenn sie als Library importiert wird — z.B. vom Pro-Repo).
// Robuste, symlink- und Windows-sichere Pruefung via realpath.
const isMainModule = (() => {
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
