/**
 * License-Key validation & activation.
 * Story 9.2: Validates license keys against a remote endpoint,
 * caches results locally, and falls back to cache when offline.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { debug } from "../cdp/debug.js";
import type { LicenseStatus } from "./license-status.js";

/** Configuration for the LicenseValidator. */
export interface LicenseValidatorConfig {
  licenseKey?: string;
  endpoint: string;
  cacheDir: string;
}

/** Shape of the Polar.sh license-keys/validate response. */
interface PolarValidationResponse {
  status: string; // "granted", "revoked", etc.
  expires_at?: string | null;
  [key: string]: unknown;
}

/** Shape of the local cache file. */
interface LicenseCache {
  key: string;
  valid: boolean;
  lastCheck: string; // ISO 8601
  features: string[];
}

const CACHE_FILENAME = "license-cache.json";
const REMOTE_TIMEOUT_MS = 5000;
const GRACE_PERIOD_MS = 604_800_000; // 7 days
const RECHECK_INTERVAL_MS = 86_400_000; // 24 hours

/**
 * Validates a license key and provides synchronous `isPro()` access.
 *
 * Usage:
 *   const validator = new LicenseValidator(config);
 *   await validator.validate(); // one-time async check at startup
 *   validator.isPro();          // synchronous thereafter
 */
export class LicenseValidator implements LicenseStatus {
  private pro = false;
  private readonly config: LicenseValidatorConfig;

  constructor(config: LicenseValidatorConfig) {
    this.config = config;
  }

  /** Synchronous — returns cached Pro status. */
  isPro(): boolean {
    return this.pro;
  }

  /**
   * Performs the one-time license validation.
   * If the cache is fresh (< 24h), skips the remote call entirely.
   * If the cache is stale or missing, tries remote first, falls back to
   * local cache on network failure (with grace-period check).
   * NEVER throws — worst-case falls back to Free Tier.
   */
  async validate(): Promise<void> {
    const { licenseKey } = this.config;

    if (!licenseKey) {
      debug("No license key — running Free Tier");
      this.pro = false;
      return;
    }

    // Check if cache is fresh enough to skip remote call
    const cache = this.readCache();
    if (cache && cache.key === licenseKey && cache.valid && this.isCacheFresh(cache)) {
      // Fresh cache (< 24h) is always within grace-period (< 7d),
      // so no grace-period check needed here. The else-branch was
      // mathematically unreachable (RECHECK_INTERVAL_MS < GRACE_PERIOD_MS).
      this.pro = true;
      debug("License cache fresh — skipping remote check");
      return;
    }

    // Cache stale or missing — try remote
    try {
      await this.validateRemote(licenseKey);
    } catch {
      // Network error or timeout — try cache fallback
      this.validateFromCache(licenseKey);
    }
  }

  /**
   * Validates the key against the remote endpoint.
   * On success, updates local cache. On invalid key, sets Free Tier.
   * Throws on network/timeout errors so the caller can fall back to cache.
   */
  private async validateRemote(licenseKey: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);

    try {
      const res = await fetch(this.config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: licenseKey, organization_id: POLAR_ORG_ID }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const body = (await res.json()) as PolarValidationResponse;
      const valid = body.status === "granted";

      if (valid) {
        this.pro = true;
        debug("License validated (Pro)");
        this.writeCache({
          key: licenseKey,
          valid: true,
          lastCheck: new Date().toISOString(),
          features: [],
        });
      } else {
        this.pro = false;
        debug("License invalid (status: %s) — running Free Tier", body.status);
        this.writeCache({
          key: licenseKey,
          valid: false,
          lastCheck: new Date().toISOString(),
          features: [],
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Falls back to the local cache file.
   * Only uses the cache if the stored key matches and the cache is
   * within the 7-day grace period.
   */
  private validateFromCache(licenseKey: string): void {
    const cache = this.readCache();

    if (cache && cache.key === licenseKey && cache.valid) {
      if (this.isCacheWithinGracePeriod(cache)) {
        this.pro = true;
        debug("License cache used (offline, grace-period active)");
      } else {
        this.pro = false;
        debug("License-Check abgelaufen — Pro-Features deaktiviert bis zur naechsten Online-Validierung");
      }
    } else {
      this.pro = false;
      debug("License invalid — running Free Tier");
    }
  }

  /** Parses the lastCheck ISO string to a timestamp; returns null if invalid. */
  private parseLastCheck(cache: LicenseCache): number | null {
    if (!cache.lastCheck) return null;
    const ts = Date.parse(cache.lastCheck);
    return Number.isNaN(ts) ? null : ts;
  }

  /** Returns true when the cache was checked less than 24 hours ago. */
  private isCacheFresh(cache: LicenseCache): boolean {
    const ts = this.parseLastCheck(cache);
    if (ts === null) return false;
    const age = Date.now() - ts;
    // Negative age means lastCheck is in the future (clock rolled back) → treat as stale
    return age >= 0 && age < RECHECK_INTERVAL_MS;
  }

  /** Returns true when the cache was checked less than 7 days ago. */
  private isCacheWithinGracePeriod(cache: LicenseCache): boolean {
    const ts = this.parseLastCheck(cache);
    if (ts === null) return false;
    const age = Date.now() - ts;
    // Negative age means lastCheck is in the future (clock rolled back) → treat as expired
    return age >= 0 && age < GRACE_PERIOD_MS;
  }

  /** Writes the cache file, creating the directory if needed. */
  private writeCache(cache: LicenseCache): void {
    try {
      fs.mkdirSync(this.config.cacheDir, { recursive: true });
      const filePath = path.join(this.config.cacheDir, CACHE_FILENAME);
      fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), { encoding: "utf-8", mode: 0o600 });
    } catch {
      // Non-critical — cache write failure should not crash the server
      debug("Failed to write license cache");
    }
  }

  /** Reads the cache file, returning null if it doesn't exist or is invalid. */
  private readCache(): LicenseCache | null {
    try {
      const filePath = path.join(this.config.cacheDir, CACHE_FILENAME);
      const raw = fs.readFileSync(filePath, "utf-8");
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
}

const POLAR_ORG_ID = "035df496-f4b7-4956-8ad4-6246f4a32788";
const DEFAULT_ENDPOINT = "https://api.polar.sh/v1/customer-portal/license-keys/validate";

/**
 * Loads LicenseValidatorConfig from environment variables.
 *
 * Env vars:
 *   SILBERCUECHROME_LICENSE_KEY      — the license key (optional)
 *   SILBERCUECHROME_LICENSE_ENDPOINT — override for the validation endpoint (optional)
 */
export function loadLicenseConfig(): LicenseValidatorConfig {
  const licenseKey = process.env.SILBERCUECHROME_LICENSE_KEY || undefined;
  const endpoint = process.env.SILBERCUECHROME_LICENSE_ENDPOINT || DEFAULT_ENDPOINT;
  const cacheDir = path.join(os.homedir(), ".silbercuechrome");

  return { licenseKey, endpoint, cacheDir };
}
