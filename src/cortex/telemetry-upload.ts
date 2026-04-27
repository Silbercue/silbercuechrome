/**
 * Story 12.5: Opt-in Telemetry Upload.
 *
 * Sends anonymised pattern entries to a collection endpoint when
 * telemetry is explicitly enabled via environment variable.
 *
 * Privacy (NFR21): Only whitelisted fields are sent — no PII, no URLs
 * with auth tokens, no page content. The _sanitize() method builds an
 * explicit object literal (no spread) to prevent accidental leakage.
 *
 * Error Handling: Same philosophy as Stories 12.1-12.4 — the uploader
 * NEVER throws or disrupts the tool flow. All errors are debug-logged
 * and silently swallowed.
 */
import { debug } from "../cdp/debug.js";
import type { CortexPattern } from "./cortex-types.js";
import type { TelemetryPayload, TelemetryConfig } from "./cortex-types.js";
import { TELEMETRY_RATE_LIMIT_MS } from "./cortex-types.js";

/** Default collection endpoint (placeholder for Phase 1). */
const DEFAULT_ENDPOINT = "https://cortex.public-browser.dev/v1/patterns";

/** Timeout for the upload HTTP request (ms). */
const UPLOAD_TIMEOUT_MS = 5000;

export class TelemetryUploader {
  private readonly _config: TelemetryConfig;

  /** Tracks last upload timestamp per pattern key for rate-limiting. */
  private readonly _lastUploadByKey = new Map<string, number>();

  constructor(config: TelemetryConfig) {
    this._config = config;
  }

  /**
   * Attempt to upload a pattern entry. Fire-and-forget — the caller
   * does NOT await the result.
   *
   * Order: enabled-check → rate-limit-check → sanitize → upload.
   */
  maybeUpload(pattern: CortexPattern): void {
    try {
      // AC #1: If telemetry is not enabled, bail out immediately.
      if (!this._config.enabled) return;

      // AC #4: Rate-limiting per pattern key.
      const key = `${pattern.domain}||${pattern.pathPattern}`;
      const now = Date.now();
      const lastUpload = this._lastUploadByKey.get(key);
      if (lastUpload !== undefined && now - lastUpload < this._config.rateLimitMs) {
        return;
      }

      // Update the timestamp before the async upload to prevent duplicates.
      this._lastUploadByKey.set(key, now);

      // AC #3: Sanitize to whitelisted fields only (NFR21).
      const payload = this._sanitize(pattern);

      // Fire-and-forget upload with catch to prevent unhandled rejection.
      void this._doUpload(payload).catch((err: unknown) => {
        debug(
          "[telemetry-upload] upload failed: %s",
          err instanceof Error ? err.message : String(err),
        );
      });
    } catch (err) {
      // Outer catch: the uploader must NEVER throw.
      debug(
        "[telemetry-upload] maybeUpload() threw: %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Extract ONLY the whitelisted fields from a CortexPattern.
   *
   * CRITICAL: Builds an explicit object literal — NO spread operator,
   * NO Object.assign(). This prevents future CortexPattern fields from
   * leaking into the upload payload (NFR21).
   */
  _sanitize(pattern: CortexPattern): TelemetryPayload {
    return {
      domain: pattern.domain,
      pathPattern: pattern.pathPattern,
      toolSequence: [...pattern.toolSequence],
      successRate: 1.0, // Phase 1: only successful patterns are recorded.
      contentHash: pattern.contentHash,
      timestamp: pattern.timestamp,
    };
  }

  /**
   * Perform the actual HTTPS POST to the collection endpoint.
   *
   * Uses native Node.js fetch() (Node 22+, no external dependency).
   * AbortSignal.timeout(5000) provides automatic request cancellation.
   *
   * On ANY error (network, timeout, non-2xx status): debug-log and
   * return — NEVER throw to the caller.
   */
  async _doUpload(payload: TelemetryPayload): Promise<void> {
    try {
      const response = await fetch(this._config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });

      if (!response.ok) {
        debug("[telemetry-upload] HTTP %d from %s", response.status, this._config.endpoint);
      }
    } catch (err) {
      debug(
        "[telemetry-upload] fetch error: %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Resolve telemetry configuration from environment variables.
 *
 * - PUBLIC_BROWSER_TELEMETRY: "1" or "true" enables upload (default: disabled)
 * - PUBLIC_BROWSER_TELEMETRY_ENDPOINT: URL override for self-hosted/test setups
 */
function resolveConfig(): TelemetryConfig {
  const envEnabled = process.env.PUBLIC_BROWSER_TELEMETRY;
  let enabled = envEnabled === "1" || envEnabled === "true";
  const endpoint =
    process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT ?? DEFAULT_ENDPOINT;

  // H1: HTTPS is mandatory per AC #2 ("anonymisiert per HTTPS POST").
  // Reject non-HTTPS endpoints to prevent accidental plaintext uploads.
  if (enabled && !endpoint.startsWith("https://")) {
    debug(
      "[telemetry-upload] endpoint %s does not use HTTPS — disabling telemetry",
      endpoint,
    );
    enabled = false;
  }

  return { enabled, endpoint, rateLimitMs: TELEMETRY_RATE_LIMIT_MS };
}

/**
 * Module-level singleton (same pattern as patternRecorder and hintMatcher).
 * Configured once at import time from environment variables.
 */
export const telemetryUploader = new TelemetryUploader(resolveConfig());
