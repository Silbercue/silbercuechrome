/**
 * Top-Level CLI Subcommands fuer SilbercueChrome (Free Tier).
 *
 * Phase 2 (Distribution-Setup): analog zum SilbercueSwift main.swift Pattern.
 * Wird VOR `startServer()` in `src/index.ts` aufgerufen. Bei Match:
 * Subcommand ausfuehren + `process.exit(0|1)`. Sonst: false zurueckgeben,
 * damit der MCP-Server normal startet.
 *
 * Verfuegbare Subcommands (Free):
 *   silbercuechrome version              — Version anzeigen
 *   silbercuechrome status               — Free Tier Status + Tool-Anzahl
 *   silbercuechrome activate <KEY>       — Pro-Feature-Hinweis (nur in Pro verfuegbar)
 *   silbercuechrome deactivate           — Pro-Feature-Hinweis (nur in Pro verfuegbar)
 *   silbercuechrome --help / -h          — Help-Text
 *
 * Diese Datei enthaelt KEINE Pro-Code-Imports — der Free-Repo darf NIEMALS
 * vom Pro-Repo abhaengen (Story 15.x Constraint).
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "node:url";

/**
 * Anzahl Tools die der Free-Tier MCP-Server registriert.
 *
 * WICHTIG: Diese Konstante MUSS aktuell gehalten werden, wenn Tools im
 * Registry hinzugefuegt oder entfernt werden. Quelle der Wahrheit ist der
 * smoke-test (`test-hardest/smoke-test.mjs`) — bei Aenderungen muss die
 * Zahl hier nachgezogen werden.
 *
 * Stand 2026-04-07 (nach Phase 1): 21 Free-Tools (3 Tools sind Pro-gated:
 * dom_snapshot, switch_tab, virtual_desk → werden ueber featureGate
 * geblockt aber trotzdem in tools/list angezeigt).
 *
 * Free-User sehen also 21 nutzbare + 3 gated = 22 Tools insgesamt.
 * Pro-Zaehlung in der Pro-Variante: 22 + inspect_element = 23.
 */
export const FREE_TIER_TOOL_COUNT = 21;

/**
 * URL fuer Pro-Upgrade. Wird in `status`-Output und Aktivierungs-Hinweisen
 * gezeigt.
 */
export const UPGRADE_URL = "https://polar.sh/silbercuechrome/silbercuechrome-pro";

/** Liste der bekannten Free-Subcommands fuer Dispatch + Help. */
const KNOWN_SUBCOMMANDS = [
  "version",
  "--version",
  "-v",
  "status",
  "activate",
  "deactivate",
  "license", // bestehender Subcommand (siehe license-commands.ts)
  "help",
  "--help",
  "-h",
] as const;

/**
 * Liest die Version aus `package.json` relativ zur kompilierten JS-Datei.
 *
 * Robustness: Sucht von `import.meta.url` ausgehend nach oben — funktioniert
 * sowohl im `build/`-Layout als auch im `src/`-Layout (Tests via vitest).
 */
export function readPackageVersion(currentFileUrl: string): { name: string; version: string } {
  try {
    const here = fileURLToPath(currentFileUrl);
    let dir = path.dirname(here);

    // Hoch-Suche nach package.json (max 6 Ebenen, um Endlosschleifen
    // bei symlink-Loops zu verhindern).
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, "utf-8");
        const pkg = JSON.parse(raw) as { name?: string; version?: string };
        return {
          name: pkg.name ?? "@silbercuechrome/mcp",
          version: pkg.version ?? "0.0.0",
        };
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to fallback below.
  }
  return { name: "@silbercuechrome/mcp", version: "0.0.0" };
}

/** Shape der Free-Tier Cache-Datei (read-only fuer status). */
interface LicenseCacheShape {
  key: string;
  valid: boolean;
  lastCheck: string;
  features?: string[];
  validUntil?: string;
}

/** Liest Cache-Datei direkt — kein Remote-Call. */
function readLicenseCache(): LicenseCacheShape | null {
  try {
    const cachePath = path.join(os.homedir(), ".silbercuechrome", "license-cache.json");
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.valid !== "boolean" ||
      typeof parsed.lastCheck !== "string" ||
      typeof parsed.key !== "string"
    ) {
      return null;
    }
    return parsed as LicenseCacheShape;
  } catch {
    return null;
  }
}

/**
 * Pruft das erste CLI-Argument und dispatcht zu einem Subcommand.
 * Returns:
 *   - `true`  → Subcommand wurde erkannt und ausgefuehrt (Caller MUSS exit-en).
 *   - `false` → Kein Subcommand erkannt, normaler Server-Start ist erlaubt.
 *
 * Side-effects: ruft `process.exit()` direkt am Ende eines Subcommands
 * (zur Klarheit + um Server-Start zu verhindern).
 */
export async function dispatchTopLevelCli(
  argv: string[],
  currentFileUrl: string,
): Promise<boolean> {
  const command = argv[2];
  if (!command) return false;

  // Sub-Subcommand "license <...>" wird vom existierenden license-commands.ts
  // Pfad in src/index.ts behandelt — hier NICHT abfangen.
  if (command === "license") return false;

  switch (command) {
    case "version":
    case "--version":
    case "-v": {
      const { name, version } = readPackageVersion(currentFileUrl);
      console.log(`${name} ${version}`);
      process.exit(0);
      // unreachable but keeps tsc happy in mocked-exit tests
      return true;
    }

    case "status": {
      const { name, version } = readPackageVersion(currentFileUrl);
      const cache = readLicenseCache();
      console.log(`${name} ${version}`);
      console.log("");
      // Free-Repo sieht IMMER Free-Tier (auch wenn ein Pro-Cache existiert,
      // weil der Validator im Pro-Repo lebt). Wir zeigen aber, ob ein Cache
      // existiert, damit der User Bescheid weiss.
      console.log(`Tier:   Free`);
      console.log(`Tools:  ${FREE_TIER_TOOL_COUNT} available`);
      if (cache && cache.valid) {
        console.log("");
        console.log("A license cache was found, but license validation requires");
        console.log("the Pro tier. Install @silbercuechrome/mcp-pro to activate.");
      }
      console.log("");
      console.log(`Upgrade to Pro: ${UPGRADE_URL}`);
      process.exit(0);
      return true;
    }

    case "activate": {
      console.log("License activation requires the Pro tier.");
      console.log("");
      console.log("Install SilbercueChrome Pro to validate license keys:");
      console.log("  npm install -g @silbercuechrome/mcp-pro");
      console.log("");
      console.log(`More info: ${UPGRADE_URL}`);
      process.exit(1);
      return true;
    }

    case "deactivate": {
      console.log("License deactivation requires the Pro tier.");
      console.log("");
      console.log("Install SilbercueChrome Pro to manage license keys:");
      console.log("  npm install -g @silbercuechrome/mcp-pro");
      console.log("");
      console.log(`More info: ${UPGRADE_URL}`);
      process.exit(1);
      return true;
    }

    case "help":
    case "--help":
    case "-h": {
      printHelp();
      process.exit(0);
      return true;
    }

    default:
      // Unbekannter Subcommand → Server-Start erlauben (z.B. fuer
      // zukuenftige Subcommands oder MCP-Stdio-Modus ohne argv).
      return false;
  }
}

/** Druckt den Free-Tier Help-Text. */
function printHelp(): void {
  console.log("SilbercueChrome MCP Server (Free Tier)");
  console.log("");
  console.log("Usage:");
  console.log("  silbercuechrome [command]");
  console.log("");
  console.log("Commands:");
  console.log("  version                Show version information");
  console.log("  status                 Show current tier and tool count");
  console.log("  activate <KEY>         Activate Pro license (requires Pro tier)");
  console.log("  deactivate             Deactivate Pro license (requires Pro tier)");
  console.log("  license <subcommand>   License management (status/activate/deactivate)");
  console.log("  help                   Show this help text");
  console.log("");
  console.log("Without a command, starts the MCP server on stdio.");
  console.log("");
  console.log(`Upgrade to Pro: ${UPGRADE_URL}`);
}

/** Internal helper for tests — exposes the known subcommand list. */
export function getKnownSubcommands(): readonly string[] {
  return KNOWN_SUBCOMMANDS;
}
