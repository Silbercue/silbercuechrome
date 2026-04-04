import { startServer } from "./server.js";
import { runLicenseCommand } from "./cli/license-commands.js";

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
