#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import { runLicenseCommand } from "./cli/license-commands.js";

export { startServer } from "./server.js";
export { runLicenseCommand } from "./cli/license-commands.js";

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
    runLicenseCommand(process.argv.slice(3)).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  } else {
    startServer().catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
  }
}
