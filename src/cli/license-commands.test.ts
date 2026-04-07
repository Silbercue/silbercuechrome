import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Mock os.homedir — getCacheDir() uses path.join(os.homedir(), ".silbercuechrome").
// We point homedir to a temp parent, so the actual cache dir becomes parent/.silbercuechrome.
// ---------------------------------------------------------------------------
let mockHomeDir = "";

vi.mock("os", async (importOriginal) => {
  const original = (await importOriginal()) as typeof os;
  return {
    ...original,
    homedir: () => mockHomeDir,
  };
});

import { runLicenseCommand, parseLicenseCommand, maskKey } from "./license-commands.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tmpHomeDir(): string {
  return path.join(os.tmpdir(), `silbercuechrome-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/** Returns the effective cache dir based on the mocked homedir. */
function cacheDir(): string {
  return path.join(mockHomeDir, ".silbercuechrome");
}

function writeCache(dir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "license-cache.json"), JSON.stringify(data), "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("maskKey", () => {
  it("masks a normal key showing first 4 and last 4 chars", () => {
    expect(maskKey("sk-12345678abcdef")).toBe("sk-1...cdef");
  });

  it("masks a 10-character key (boundary)", () => {
    expect(maskKey("1234567890")).toBe("1234...7890");
  });

  it("fully masks a key shorter than 10 characters", () => {
    expect(maskKey("short")).toBe("****");
  });

  it("fully masks a 9-character key", () => {
    expect(maskKey("123456789")).toBe("****");
  });

  it("fully masks an empty string", () => {
    expect(maskKey("")).toBe("****");
  });
});

describe("parseLicenseCommand", () => {
  it("parses status subcommand", () => {
    expect(parseLicenseCommand(["status"])).toEqual({ subcommand: "status", key: undefined });
  });

  it("parses activate subcommand with key", () => {
    expect(parseLicenseCommand(["activate", "my-key"])).toEqual({ subcommand: "activate", key: "my-key" });
  });

  it("parses deactivate subcommand", () => {
    expect(parseLicenseCommand(["deactivate"])).toEqual({ subcommand: "deactivate", key: undefined });
  });

  it("returns undefined subcommand for empty args", () => {
    expect(parseLicenseCommand([])).toEqual({ subcommand: undefined, key: undefined });
  });

  it("parses unknown subcommand", () => {
    expect(parseLicenseCommand(["unknown"])).toEqual({ subcommand: "unknown", key: undefined });
  });
});

describe("runLicenseCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    mockHomeDir = tmpHomeDir();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---- Unknown subcommand ----
  describe("unknown subcommand", () => {
    it("prints usage and exits with 1 for unknown subcommand", async () => {
      await runLicenseCommand(["bogus"]);
      expect(logSpy).toHaveBeenCalledWith("SilbercueChrome License Management");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("prints usage and exits with 1 for empty args", async () => {
      await runLicenseCommand([]);
      expect(logSpy).toHaveBeenCalledWith("SilbercueChrome License Management");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ---- license status ----
  describe("license status", () => {
    it("shows Free tier when no cache exists", async () => {
      await runLicenseCommand(["status"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Free");
      expect(output).toContain("Nicht konfiguriert");
      expect(output).toContain("Um Pro zu aktivieren");
    });

    it("shows Pro tier with valid cache and displays valid-until date", async () => {
      writeCache(cacheDir(), {
        key: "sk-pro-1234567890abcdef",
        valid: true,
        lastCheck: new Date().toISOString(),
        features: ["dom_snapshot", "extended_run_plan"],
      });
      await runLicenseCommand(["status"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Pro");
      expect(output).toContain("sk-p...cdef");
      expect(output).toContain("dom_snapshot, extended_run_plan");
      expect(output).toContain("verbleibend");
      expect(output).toContain("Gueltig bis:");
    });

    it("shows validUntil from cache when present", async () => {
      writeCache(cacheDir(), {
        key: "sk-pro-1234567890abcdef",
        valid: true,
        lastCheck: "2026-04-04T12:00:00Z",
        features: [],
        validUntil: "2026-05-04T12:00:00Z",
      });
      await runLicenseCommand(["status"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Gueltig bis:");
      expect(output).toContain("2026-05-04");
    });

    it("does NOT call fetch during status (read-only, no remote call)", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      writeCache(cacheDir(), {
        key: "sk-pro-1234567890abcdef",
        valid: true,
        lastCheck: new Date().toISOString(),
        features: [],
      });
      await runLicenseCommand(["status"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("shows Free tier with invalid cache", async () => {
      writeCache(cacheDir(), {
        key: "sk-bad-key-1234abcd",
        valid: false,
        lastCheck: new Date().toISOString(),
        features: [],
      });
      await runLicenseCommand(["status"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Free");
      expect(output).toContain("Key ungueltig");
    });

    it("shows expired grace period for very old cache", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-04T12:00:00Z"));

      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      writeCache(cacheDir(), {
        key: "sk-expired-1234abcd",
        valid: true,
        lastCheck: tenDaysAgo,
        features: [],
      });
      await runLicenseCommand(["status"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Abgelaufen");

      vi.useRealTimers();
    });

    it("shows grace period remaining for cache within 7 days", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-04T12:00:00Z"));

      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      writeCache(cacheDir(), {
        key: "sk-grace-1234567890",
        valid: true,
        lastCheck: threeDaysAgo,
        features: [],
      });
      await runLicenseCommand(["status"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("4 Tage");
      expect(output).toContain("verbleibend");

      vi.useRealTimers();
    });

    it("handles corrupt cache file gracefully (shows Free tier)", async () => {
      const cd = cacheDir();
      fs.mkdirSync(cd, { recursive: true });
      fs.writeFileSync(path.join(cd, "license-cache.json"), "NOT JSON", "utf-8");
      await runLicenseCommand(["status"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Free");
      expect(output).toContain("Nicht konfiguriert");
    });

    it("handles structurally invalid cache (missing key field)", async () => {
      writeCache(cacheDir(), {
        valid: true,
        lastCheck: new Date().toISOString(),
        features: [],
      });
      await runLicenseCommand(["status"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Free");
      expect(output).toContain("Nicht konfiguriert");
    });
  });

  // ---- license activate ----
  describe("license activate", () => {
    it("shows Pro-Feature hint and exits with 1 (no key)", async () => {
      await runLicenseCommand(["activate"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Pro-Feature");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("shows Pro-Feature hint and exits with 1 (with key)", async () => {
      await runLicenseCommand(["activate", "sk-valid-key-1234"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Pro-Feature");
      expect(output).toContain("silbercuechrome-pro");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ---- license deactivate ----
  describe("license deactivate", () => {
    it("deletes cache file and shows success", async () => {
      const cd = cacheDir();
      writeCache(cd, {
        key: "sk-to-deactivate-key",
        valid: true,
        lastCheck: new Date().toISOString(),
        features: [],
      });
      // Verify cache exists before deactivation
      expect(fs.existsSync(path.join(cd, "license-cache.json"))).toBe(true);

      await runLicenseCommand(["deactivate"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("License deaktiviert");
      expect(output).toContain("Um Pro wieder zu aktivieren");
      expect(exitSpy).toHaveBeenCalledWith(0);
      // Verify cache file was deleted
      expect(fs.existsSync(path.join(cd, "license-cache.json"))).toBe(false);
    });

    it("succeeds even when no cache file exists (idempotent)", async () => {
      await runLicenseCommand(["deactivate"]);
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("License deaktiviert");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("reports permission errors (EACCES) instead of swallowing them", async () => {
      const cd = cacheDir();
      // Create cache file, then make the directory read-only to provoke EACCES on unlink
      writeCache(cd, {
        key: "sk-perm-test-1234ab",
        valid: true,
        lastCheck: new Date().toISOString(),
        features: [],
      });
      // Make directory read-only (removes write+execute for owner)
      fs.chmodSync(cd, 0o444);

      try {
        await runLicenseCommand(["deactivate"]);
        const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
        expect(output).toContain("Fehler beim Loeschen");
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(cd, 0o755);
      }
    });
  });
});
