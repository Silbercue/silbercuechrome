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

/** Shape of the remote validation response. */
interface ValidationResponse {
  valid: boolean;
  features?: string[];
  expiresAt?: string;
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
   * Tries remote first, falls back to local cache on network failure.
   * NEVER throws — worst-case falls back to Free Tier.
   */
  async validate(): Promise<void> {
    const { licenseKey } = this.config;

    if (!licenseKey) {
      debug("No license key — running Free Tier");
      this.pro = false;
      return;
    }

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
        body: JSON.stringify({ key: licenseKey }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const body = (await res.json()) as ValidationResponse;

      if (body.valid === true) {
        this.pro = true;
        debug("License validated (Pro)");
        this.writeCache({
          key: licenseKey,
          valid: true,
          lastCheck: new Date().toISOString(),
          features: body.features ?? [],
        });
      } else {
        this.pro = false;
        debug("License invalid — running Free Tier");
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
   * Only uses the cache if the stored key matches the current key.
   */
  private validateFromCache(licenseKey: string): void {
    const cache = this.readCache();

    if (cache && cache.key === licenseKey && cache.valid) {
      this.pro = true;
      debug("License cache used (offline)");
    } else {
      this.pro = false;
      debug("License invalid — running Free Tier");
    }
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
      return JSON.parse(raw) as LicenseCache;
    } catch {
      return null;
    }
  }
}

const DEFAULT_ENDPOINT = "https://license.silbercuechrome.dev/validate";

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
