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
    endpoint: "https://license.silbercuechrome.dev/validate",
    cacheDir: tmpCacheDir(),
    ...overrides,
  };
}

function mockFetchOk(valid: boolean, features: string[] = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ valid, features }),
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

    it("sends POST with correct body", async () => {
      const spy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ valid: true }),
      });
      vi.stubGlobal("fetch", spy);

      const v = new LicenseValidator(
        makeConfig({
          licenseKey: "test-key-123",
          endpoint: "https://example.com/validate",
        }),
      );
      await v.validate();

      expect(spy).toHaveBeenCalledWith(
        "https://example.com/validate",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "test-key-123" }),
        }),
      );
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
      mockFetchOk(true, ["pro-features"]);
      const cacheDir = tmpCacheDir();
      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();

      const cached = readCacheFile(cacheDir);
      expect(cached).not.toBeNull();
      expect(cached!.key).toBe("my-key");
      expect(cached!.valid).toBe(true);
      expect(cached!.features).toEqual(["pro-features"]);
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

  // ---- Review findings: cache invalidation, HTTP status, strict typing ----
  describe("review findings", () => {
    it("remote valid=false updates cache → offline returns isPro()=false", async () => {
      const cacheDir = tmpCacheDir();
      // Pre-seed cache with valid=true
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: new Date().toISOString(),
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
      writeCache(cacheDir, {
        key: "my-key",
        valid: true,
        lastCheck: new Date().toISOString(),
        features: [],
      });

      // Remote returns 500
      mockFetchStatus(500, { valid: false });
      const v = new LicenseValidator(makeConfig({ licenseKey: "my-key", cacheDir }));
      await v.validate();
      // Should fall back to cache (valid=true)
      expect(v.isPro()).toBe(true);
    });

    it("truthy non-boolean valid (e.g. string) is NOT treated as Pro", async () => {
      mockFetchStatus(200, { valid: "yes" });
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
    expect(config.endpoint).toBe("https://license.silbercuechrome.dev/validate");
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
