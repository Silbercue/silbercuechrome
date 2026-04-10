import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * License status abstraction.
 * Story 9.1: Minimal interface — Story 9.2 will provide the real implementation.
 */
export interface LicenseStatus {
  /** Returns true when the user has an active Pro license */
  isPro(): boolean;
}

/**
 * Default implementation: reads ~/.silbercuechrome/license-cache.json.
 * If the cache exists and has "valid": true, this returns Pro.
 * The Pro-Repo replaces this with a full LicenseValidator (online check).
 */
export class FreeTierLicenseStatus implements LicenseStatus {
  private _pro: boolean;

  constructor(override?: boolean) {
    this._pro = override !== undefined ? override : FreeTierLicenseStatus._readCache();
  }

  isPro(): boolean {
    return this._pro;
  }

  private static _readCache(): boolean {
    try {
      const cachePath = join(homedir(), ".silbercuechrome", "license-cache.json");
      const raw = readFileSync(cachePath, "utf8");
      const data = JSON.parse(raw);
      return data.valid === true && typeof data.key === "string" && data.key.startsWith("SCC-");
    } catch {
      return false;
    }
  }
}
