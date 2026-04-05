import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { LicenseValidator, loadLicenseConfig } from "./license-validator.js";
import type { LicenseValidatorConfig } from "./license-validator.js";
import type { LicenseStatus } from "./license-status.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tmpCacheDir(): string {
  return path.join(os.tmpdir(), `silbercuechrome-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeConfig(overrides: Partial<LicenseValidatorConfig> = {}): LicenseValidatorConfig {
  return {
    licenseKey: undefined,
    endpoint: "https://api.polar.sh/v1/customer-portal/license-keys/validate",
    cacheDir: tmpCacheDir(),
    ...overrides,
  };
}

function mockFetchOk(valid: boolean, _features: string[] = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: valid ? "granted" : "revoked" }),
    }),
  );
}

function mockFetchStatus(status: number, body: Record<string, unknown> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}

function mockFetchNetworkError(): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
}

function writeCache(cacheDir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "license-cache.json"), JSON.stringify(data), "utf-8");
}

function readCacheFile(cacheDir: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(cacheDir, "license-cache.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("LicenseValidator", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---- Task 1: Basic behavior ----
  describe("basic behavior", () => {
    it("implements LicenseStatus interface", () => {
      const v: LicenseStatus = new LicenseValidator(makeConfig());
      expect(typeof v.isPro).toBe("function");
    });

    it("isPro() returns false before validate()", () => {
      const v = new LicenseValidator(makeConfig());
      expect(v.isPro()).toBe(false);
    });

    it("isPro() returns false when no license key is set", async () => {
      const v = new LicenseValidator(makeConfig({ licenseKey: undefined }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });

    it("does not call fetch when no license key is set", async () => {
      const spy = vi.fn();
      vi.stubGlobal("fetch", spy);
      const v = new LicenseValidator(makeConfig({ licenseKey: undefined }));
      await v.validate();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ---- Task 2: Remote validation ----
  describe("remote validation", () => {
    it("sets isPro()=true for valid key", async () => {
      mockFetchOk(true);
      const v = new LicenseValidator(makeConfig({ licenseKey: "valid-key" }));
      await v.validate();
      expect(v.isPro()).toBe(true);
    });

    it("sets isPro()=false for invalid key", async () => {
      mockFetchOk(false);
      const v = new LicenseValidator(makeConfig({ licenseKey: "bad-key" }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });

    it("sends POST with correct body including organization_id", async () => {
      const spy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "granted" }),
      });
      vi.stubGlobal("fetch", spy);

      const v = new LicenseValidator(
        makeConfig({
          licenseKey: "test-key-123",
          endpoint: "https://example.com/validate",
        }),
      );
      await v.validate();

      const callBody = JSON.parse(spy.mock.calls[0][1].body);
      expect(callBody.key).toBe("test-key-123");
      expect(callBody.organization_id).toBe("035df496-f4b7-4956-8ad4-6246f4a32788");
      expect(spy.mock.calls[0][0]).toBe("https://example.com/validate");
    });

    it("uses AbortController signal with timeout", async () => {
      const spy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ valid: true }),
      });
      vi.stubGlobal("fetch", spy);

      const v = new LicenseValidator(makeConfig({ licenseKey: "key" }));
      await v.validate();

      const callArgs = spy.mock.calls[0][1];
      expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    });

    it("falls back to free tier on network error", async () => {
      mockFetchNetworkError();
      const v = new LicenseValidator(makeConfig({ licenseKey: "key" }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });

    it("falls back to free tier on abort/timeout", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new DOMException("The operation was aborted.", "AbortError")),
      );
      const v = new LicenseValidator(makeConfig({ licenseKey: "key" }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });
  });

  // ---- Task 3: Local cache ----
  describe("local cache", () => {
    it("writes cache after successful remote validation", async () => {
      mockFetchOk(true);
      const cacheDir = tmpCacheDir();
      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();

      const cached = readCacheFile(cacheDir);
      expect(cached).not.toBeNull();
      expect(cached!.key).toBe("my-key");
      expect(cached!.valid).toBe(true);
      expect(cached!.features).toEqual([]);
      expect(typeof cached!.lastCheck).toBe("string");
    });

    it("writes cache with valid=false on invalid key", async () => {
      mockFetchOk(false);
      const cacheDir = tmpCacheDir();
      const v = new LicenseValidator(makeConfig({ licenseKey: "bad-key", cacheDir }));
      await v.validate();

      const cached = readCacheFile(cacheDir);
      expect(cached).not.toBeNull();
      expect(cached!.key).toBe("bad-key");
      expect(cached!.valid).toBe(false);
    });

    it("uses cache when network fails and cache is valid", async () => {
      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: new Date().toISOString(),
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(true);
    });

    it("ignores cache when key does not match", async () => {
      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      writeCache(cacheDir, {
        key: "different-key",
        valid: true,
        lastCheck: new Date().toISOString(),
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });

    it("falls back to free tier when no cache exists and network fails", async () => {
      mockFetchNetworkError();
      const v = new LicenseValidator(makeConfig({ licenseKey: "key", cacheDir: tmpCacheDir() }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });

    it("ignores cache where valid=false", async () => {
      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      writeCache(cacheDir, {
        key: "my-key",
        valid: false,
        lastCheck: new Date().toISOString(),
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });
  });

  // ---- Task 4: Debug logging (no stderr alarm) ----
  describe("debug logging", () => {
    it("does not write to stderr for invalid key (when DEBUG is off)", async () => {
      const origDebug = process.env.DEBUG;
      delete process.env.DEBUG;
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockFetchOk(false);
      // Must re-import to pick up fresh DEBUG check — but debug.ts caches at module-load.
      // Since DEBUG is off, the shared debug() import won't call console.error.
      const v = new LicenseValidator(makeConfig({ licenseKey: "bad-key" }));
      await v.validate();

      expect(spy).not.toHaveBeenCalled();

      process.env.DEBUG = origDebug;
    });

    it("does not write to stderr for network error (when DEBUG is off)", async () => {
      const origDebug = process.env.DEBUG;
      delete process.env.DEBUG;
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockFetchNetworkError();
      const v = new LicenseValidator(makeConfig({ licenseKey: "key" }));
      await v.validate();

      expect(spy).not.toHaveBeenCalled();

      process.env.DEBUG = origDebug;
    });
  });

  // ---- Task 6: Server resilience ----
  describe("resilience", () => {
    it("validate() never throws — even with broken fetch", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("catastrophic failure")),
      );
      const v = new LicenseValidator(makeConfig({ licenseKey: "key" }));
      await expect(v.validate()).resolves.toBeUndefined();
      expect(v.isPro()).toBe(false);
    });

    it("validate() handles malformed JSON response gracefully", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.reject(new SyntaxError("Unexpected token")),
        }),
      );
      const v = new LicenseValidator(makeConfig({ licenseKey: "key" }));
      await expect(v.validate()).resolves.toBeUndefined();
      expect(v.isPro()).toBe(false);
    });

    it("validate() handles corrupt cache file gracefully", async () => {
      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, "license-cache.json"), "NOT JSON", "utf-8");

      const v = new LicenseValidator(makeConfig({ licenseKey: "key", cacheDir }));
      await expect(v.validate()).resolves.toBeUndefined();
      expect(v.isPro()).toBe(false);
    });
  });

  // ---- Story 9.3: Grace-Period (7 days) ----
  describe("grace-period", () => {
    it("uses cache within grace-period when network fails", async () => {
      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: threeDaysAgo,
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(true);
    });

    it("falls back to free tier when cache is older than 7 days", async () => {
      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: eightDaysAgo,
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });

    it("falls back to free tier when cache has no lastCheck", async () => {
      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });

    it("treats cache as stale when lastCheck is in the future (clock rolled back)", async () => {
      vi.useFakeTimers();
      const now = new Date("2026-04-04T12:00:00Z");
      vi.setSystemTime(now);

      // lastCheck is 2 days in the future — simulates clock rollback
      const futureDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
      const cacheDir = tmpCacheDir();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: futureDate,
        features: [],
      });

      mockFetchOk(true);
      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      // Future lastCheck → Date.now() - ts is negative → isCacheFresh returns false
      // → remote call should happen
      expect(fetch).toHaveBeenCalled();
      expect(v.isPro()).toBe(true);

      vi.useRealTimers();
    });

    it("falls back to free tier when cache has invalid lastCheck", async () => {
      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: "not-a-date",
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });

    it("falls back to free tier when cache is exactly 7 days old (boundary)", async () => {
      vi.useFakeTimers();
      const now = new Date("2026-04-04T12:00:00Z");
      vi.setSystemTime(now);

      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      const exactlySevenDaysAgo = new Date(now.getTime() - 604_800_000).toISOString();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: exactlySevenDaysAgo,
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      // Exactly 7 days = NOT within grace period (< 7 days required)
      expect(v.isPro()).toBe(false);

      vi.useRealTimers();
    });

    it("uses cache at 6 days 23 hours (just within grace-period)", async () => {
      vi.useFakeTimers();
      const now = new Date("2026-04-04T12:00:00Z");
      vi.setSystemTime(now);

      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      const almostSevenDays = new Date(now.getTime() - (604_800_000 - 3_600_000)).toISOString();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: almostSevenDays,
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(true);

      vi.useRealTimers();
    });
  });

  // ---- Story 9.3: Auto-Recheck (24h) ----
  describe("auto-recheck", () => {
    it("skips remote call when cache is fresh (< 24h)", async () => {
      const spy = vi.fn();
      vi.stubGlobal("fetch", spy);
      const cacheDir = tmpCacheDir();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: new Date().toISOString(),
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });

    it("calls remote when cache is stale (>= 24h)", async () => {
      mockFetchOk(true);
      const cacheDir = tmpCacheDir();
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: twoDaysAgo,
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(true);
      expect(fetch).toHaveBeenCalled();
    });

    it("calls remote when no cache exists", async () => {
      mockFetchOk(true);
      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir: tmpCacheDir() }));
      await v.validate();
      expect(v.isPro()).toBe(true);
      expect(fetch).toHaveBeenCalled();
    });

    it("calls remote when cache key does not match", async () => {
      mockFetchOk(true);
      const cacheDir = tmpCacheDir();
      writeCache(cacheDir, {
        key: "different-key",
        valid: true,
        lastCheck: new Date().toISOString(),
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(true);
      expect(fetch).toHaveBeenCalled();
    });

    it("calls remote when cache valid=false even if fresh", async () => {
      mockFetchOk(true);
      const cacheDir = tmpCacheDir();
      writeCache(cacheDir, {
        key: "my-key",
        valid: false,
        lastCheck: new Date().toISOString(),
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(true);
      expect(fetch).toHaveBeenCalled();
    });

    it("uses stale cache (within grace-period) when remote fails", async () => {
      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: twoDaysAgo,
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(true);
    });

    it("falls back to free tier when remote fails and cache is beyond grace-period", async () => {
      mockFetchNetworkError();
      const cacheDir = tmpCacheDir();
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: tenDaysAgo,
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });

    it("skips remote at exactly 23h59m (boundary — still fresh)", async () => {
      vi.useFakeTimers();
      const now = new Date("2026-04-04T12:00:00Z");
      vi.setSystemTime(now);

      const spy = vi.fn();
      vi.stubGlobal("fetch", spy);
      const cacheDir = tmpCacheDir();
      const justUnder24h = new Date(now.getTime() - (86_400_000 - 60_000)).toISOString();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: justUnder24h,
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(true);
      expect(spy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("calls remote at exactly 24h (boundary — stale)", async () => {
      vi.useFakeTimers();
      const now = new Date("2026-04-04T12:00:00Z");
      vi.setSystemTime(now);

      mockFetchOk(true);
      const cacheDir = tmpCacheDir();
      const exactly24h = new Date(now.getTime() - 86_400_000).toISOString();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: exactly24h,
        features: [],
      });

      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      expect(v.isPro()).toBe(true);
      expect(fetch).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  // ---- Review findings: cache invalidation, HTTP status, strict typing ----
  describe("review findings", () => {
    it("remote valid=false updates cache → offline returns isPro()=false", async () => {
      const cacheDir = tmpCacheDir();
      // Pre-seed cache with valid=true but stale (> 24h) so remote call is triggered
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: twoDaysAgo,
        features: [],
      });

      // Remote says invalid
      mockFetchOk(false);
      const v1 = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v1.validate();
      expect(v1.isPro()).toBe(false);

      // Cache should now contain valid=false
      const cached = readCacheFile(cacheDir);
      expect(cached).not.toBeNull();
      expect(cached!.valid).toBe(false);

      // Subsequent offline start must NOT activate Pro
      mockFetchNetworkError();
      const v2 = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v2.validate();
      expect(v2.isPro()).toBe(false);
    });

    it("non-2xx response falls back to cache (like network error)", async () => {
      const cacheDir = tmpCacheDir();
      // Cache must be > 24h old so the fresh-cache shortcut doesn't skip the remote call
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: twoDaysAgo,
        features: [],
      });

      // Remote returns 500 — should throw and fall back to cache
      mockFetchStatus(500, { valid: false });
      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      // Should fall back to cache (valid=true, within 7-day grace-period)
      expect(v.isPro()).toBe(true);
      expect(fetch).toHaveBeenCalled();
    });

    it("non-granted status is NOT treated as Pro", async () => {
      mockFetchStatus(200, { status: "revoked" });
      const v = new LicenseValidator(makeConfig({ licenseKey: "key" }));
      await v.validate();
      expect(v.isPro()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// loadLicenseConfig
// ---------------------------------------------------------------------------
describe("loadLicenseConfig", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.SILBERCUECHROME_LICENSE_KEY = process.env.SILBERCUECHROME_LICENSE_KEY;
    savedEnv.SILBERCUECHROME_LICENSE_ENDPOINT = process.env.SILBERCUECHROME_LICENSE_ENDPOINT;
  });

  afterEach(() => {
    if (savedEnv.SILBERCUECHROME_LICENSE_KEY === undefined) {
      delete process.env.SILBERCUECHROME_LICENSE_KEY;
    } else {
      process.env.SILBERCUECHROME_LICENSE_KEY = savedEnv.SILBERCUECHROME_LICENSE_KEY;
    }
    if (savedEnv.SILBERCUECHROME_LICENSE_ENDPOINT === undefined) {
      delete process.env.SILBERCUECHROME_LICENSE_ENDPOINT;
    } else {
      process.env.SILBERCUECHROME_LICENSE_ENDPOINT = savedEnv.SILBERCUECHROME_LICENSE_ENDPOINT;
    }
  });

  it("returns undefined licenseKey when env var is not set", () => {
    delete process.env.SILBERCUECHROME_LICENSE_KEY;
    const config = loadLicenseConfig();
    expect(config.licenseKey).toBeUndefined();
  });

  it("reads SILBERCUECHROME_LICENSE_KEY from env", () => {
    process.env.SILBERCUECHROME_LICENSE_KEY = "test-key-42";
    const config = loadLicenseConfig();
    expect(config.licenseKey).toBe("test-key-42");
  });

  it("returns default endpoint when env var is not set", () => {
    delete process.env.SILBERCUECHROME_LICENSE_ENDPOINT;
    const config = loadLicenseConfig();
    expect(config.endpoint).toBe("https://api.polar.sh/v1/customer-portal/license-keys/validate");
  });

  it("reads SILBERCUECHROME_LICENSE_ENDPOINT from env", () => {
    process.env.SILBERCUECHROME_LICENSE_ENDPOINT = "https://custom.example.com/v";
    const config = loadLicenseConfig();
    expect(config.endpoint).toBe("https://custom.example.com/v");
  });

  it("sets cacheDir under home directory", () => {
    const config = loadLicenseConfig();
    expect(config.cacheDir).toBe(path.join(os.homedir(), ".silbercuechrome"));
  });

  it("returns undefined licenseKey for empty string env var", () => {
    process.env.SILBERCUECHROME_LICENSE_KEY = "";
    const config = loadLicenseConfig();
    expect(config.licenseKey).toBeUndefined();
  });
});
