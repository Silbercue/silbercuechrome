/**
 * CLI commands for license management.
 * Story 9.4: Thin CLI layer over the existing LicenseValidator.
 */
import * as fs from "fs";
import * as path from "path";
import { LicenseValidator, loadLicenseConfig } from "../license/license-validator.js";

/** Grace period constant (7 days) — duplicated from LicenseValidator (private). */
const GRACE_PERIOD_MS = 604_800_000;

/** Shape of the local cache file (mirrors LicenseValidator's private interface). */
interface LicenseCache {
  key: string;
  valid: boolean;
  lastCheck: string; // ISO 8601
  features: string[];
  validUntil?: string; // ISO 8601, optional — set by server
}

/**
 * Parses CLI args and dispatches to the correct subcommand.
 * Exported for testability — `src/index.ts` calls this.
 */
export async function runLicenseCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  switch (subcommand) {
    case "status":
      return licenseStatus();
    case "activate":
      return licenseActivate(args[1]);
    case "deactivate":
      return licenseDeactivate();
    default:
      printUsage();
      process.exit(1);
  }
}

/**
 * Parses CLI arguments and returns the parsed command.
 * Pure function — exported for unit-testing the routing logic
 * without side effects.
 */
export function parseLicenseCommand(argv: string[]): {
  subcommand: string | undefined;
  key?: string;
} {
  // argv is process.argv.slice(3), i.e. everything after "license"
  const subcommand = argv[0];
  const key = argv[1];
  return { subcommand, key };
}

/**
 * Masks a license key for display: first 4 + "..." + last 4.
 * Keys shorter than 10 characters are fully masked.
 */
export function maskKey(key: string): string {
  if (!key || key.length < 10) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** `license status` — read-only, no remote call. */
async function licenseStatus(): Promise<void> {
  const { cacheDir } = loadLicenseConfig();
  const cache = readCacheDirectly(cacheDir);

  console.log("SilbercueChrome License Status");
  console.log("===============================");

  if (!cache) {
    console.log("Tier:          Free");
    console.log("License Key:   Nicht konfiguriert");
    console.log("");
    console.log("Um Pro zu aktivieren: silbercuechrome license activate <key>");
    return;
  }

  if (cache.valid) {
    console.log("Tier:          Pro");
    console.log(`License Key:   ${maskKey(cache.key)}`);
    console.log(`Last Check:    ${formatDate(cache.lastCheck)}`);
    console.log(`Gueltig bis:   ${formatValidUntil(cache)}`);

    const gracePeriodInfo = formatGracePeriod(cache.lastCheck);
    if (gracePeriodInfo) {
      console.log(`Grace Period:  ${gracePeriodInfo}`);
    }

    if (cache.features && cache.features.length > 0) {
      console.log(`Features:      ${cache.features.join(", ")}`);
    }
  } else {
    console.log("Tier:          Free");
    console.log(`License Key:   ${maskKey(cache.key)}`);
    console.log("Status:        Key ungueltig");
    console.log("");
    console.log("Um Pro zu aktivieren: silbercuechrome license activate <key>");
  }
}

/** `license activate <key>` — validates key remotely, writes cache. */
async function licenseActivate(key: string | undefined): Promise<void> {
  if (!key) {
    console.log("Bitte Key angeben: silbercuechrome license activate <key>");
    process.exit(1);
    return; // for type narrowing (process.exit is mocked in tests)
  }

  try {
    const config = loadLicenseConfig();
    config.licenseKey = key; // Override with CLI argument
    const validator = new LicenseValidator(config);
    await validator.validate();

    if (validator.isPro()) {
      console.log("License aktiviert — Pro-Features verfuegbar.");
      process.exit(0);
    } else {
      // Distinguish: key invalid (server responded → cache written with valid:false)
      // vs network error (no cache update for this key).
      const cache = readCacheDirectly(config.cacheDir);
      if (cache && cache.key === key && cache.valid === false) {
        // Server responded with invalid
        console.log("License-Key ungueltig. Pruefe den Key und versuche es erneut.");
      } else {
        // No cache update → network error / timeout
        console.log("Validierung fehlgeschlagen (Netzwerkfehler). Key wurde gespeichert — Validierung beim naechsten Server-Start.");
      }
      process.exit(1);
    }
  } catch {
    console.log("Validierung fehlgeschlagen — Netzwerkverbindung pruefen.");
    process.exit(1);
  }
}

/** `license deactivate` — deletes cache file. */
function licenseDeactivate(): void {
  const { cacheDir } = loadLicenseConfig();
  const cachePath = path.join(cacheDir, "license-cache.json");

  try {
    fs.unlinkSync(cachePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.log(`Fehler beim Loeschen der Cache-Datei: ${(err as Error).message}`);
      process.exit(1);
      return;
    }
    // ENOENT — file doesn't exist, that's fine (idempotent)
  }

  console.log("License deaktiviert — Server laeuft im Free-Tier.");
  console.log("Um Pro wieder zu aktivieren: silbercuechrome license activate <key>");
  process.exit(0);
}

/** Prints usage help for unknown subcommands. */
function printUsage(): void {
  console.log("SilbercueChrome License Management");
  console.log("");
  console.log("Usage:");
  console.log("  silbercuechrome license status              Lizenz-Status anzeigen");
  console.log("  silbercuechrome license activate <key>      License-Key aktivieren");
  console.log("  silbercuechrome license deactivate          License-Key deaktivieren");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reads the cache file directly (no remote call). */
function readCacheDirectly(cacheDir: string): LicenseCache | null {
  try {
    const raw = fs.readFileSync(path.join(cacheDir, "license-cache.json"), "utf-8");
    const parsed = JSON.parse(raw);

    // Runtime validation — reject structurally invalid cache
    if (
      typeof parsed.valid !== "boolean" ||
      typeof parsed.lastCheck !== "string" ||
      typeof parsed.key !== "string"
    ) {
      return null;
    }

    return parsed as LicenseCache;
  } catch {
    return null;
  }
}

/** Formats an ISO date string for human-readable display. */
function formatDate(isoString: string): string {
  const ts = Date.parse(isoString);
  if (Number.isNaN(ts)) return "Unbekannt";
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

/**
 * Formats the grace-period status for display.
 * Returns null if lastCheck is invalid or not applicable.
 */
function formatGracePeriod(lastCheck: string): string | null {
  const ts = Date.parse(lastCheck);
  if (Number.isNaN(ts)) return null;
  const age = Date.now() - ts;
  if (age < 0) return "Unbekannt (Systemzeit-Problem)";

  const remaining = GRACE_PERIOD_MS - age;
  if (remaining <= 0) return "Abgelaufen";

  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

  if (days > 0) {
    return `${days} Tag${days !== 1 ? "e" : ""} ${hours} Stunde${hours !== 1 ? "n" : ""} verbleibend`;
  }
  return `${hours} Stunde${hours !== 1 ? "n" : ""} verbleibend`;
}

/**
 * Formats the "valid until" date from cache.
 * If validUntil is present in the cache, uses that directly.
 * Otherwise falls back to lastCheck + 7 days (grace period).
 */
function formatValidUntil(cache: LicenseCache): string {
  if (cache.validUntil) {
    return formatDate(cache.validUntil);
  }
  // Fallback: lastCheck + grace period (7 days)
  const ts = Date.parse(cache.lastCheck);
  if (Number.isNaN(ts)) return "Unbekannt";
  return formatDate(new Date(ts + GRACE_PERIOD_MS).toISOString());
}
