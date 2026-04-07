/**
 * Tests fuer Top-Level CLI Subcommands (Free Tier).
 * Phase 2 (Distribution-Setup) — Story analog SilbercueSwift main.swift.
 *
 * Strategie: process.exit + console.log werden gemockt, sodass jeder
 * Subcommand vollstaendig durchlaufen kann ohne den Test-Runner zu killen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  dispatchTopLevelCli,
  readPackageVersion,
  FREE_TIER_TOOL_COUNT,
  UPGRADE_URL,
} from "./top-level-commands.js";

// ---------------------------------------------------------------------------
// os.homedir mock — same Pattern wie license-commands.test.ts
// ---------------------------------------------------------------------------
let mockHomeDir = "";
vi.mock("os", async (importOriginal) => {
  const original = (await importOriginal()) as typeof os;
  return {
    ...original,
    homedir: () => mockHomeDir || original.homedir(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tmpHome(): string {
  return path.join(os.tmpdir(), `silbercuechrome-cli-toplevel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function writeCache(dir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, ".silbercuechrome"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".silbercuechrome", "license-cache.json"),
    JSON.stringify(data),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("readPackageVersion", () => {
  it("findet die package.json relativ zur src-Datei", () => {
    const result = readPackageVersion(import.meta.url);
    expect(result.name).toBe("@silbercuechrome/mcp");
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("liefert sinnvollen Fallback bei einer kaputten URL", () => {
    const result = readPackageVersion("file:///nonexistent/path/that/cannot/exist/foo.js");
    // Im worst case liefert er den Fallback OR irgendeine package.json
    // weiter oben — aber `name` und `version` sind immer Strings.
    expect(typeof result.name).toBe("string");
    expect(typeof result.version).toBe("string");
  });
});

describe("dispatchTopLevelCli", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      // Throw a sentinel error so the dispatcher control-flow stops here
      throw new Error("__exit__");
    }) as never);
    mockHomeDir = tmpHome();
    fs.mkdirSync(mockHomeDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(mockHomeDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // ---- no command → fall-through ----
  describe("no subcommand", () => {
    it("returns false when no argv[2] is given (server should start)", async () => {
      const handled = await dispatchTopLevelCli(["node", "index.js"], import.meta.url);
      expect(handled).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("returns false for unknown subcommand (server should start)", async () => {
      const handled = await dispatchTopLevelCli(
        ["node", "index.js", "totally-unknown"],
        import.meta.url,
      );
      expect(handled).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("returns false for `license` (delegated to license-commands.ts)", async () => {
      const handled = await dispatchTopLevelCli(
        ["node", "index.js", "license", "status"],
        import.meta.url,
      );
      expect(handled).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // ---- version ----
  describe("version", () => {
    it("prints package name + version and exits 0", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "version"], import.meta.url),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("@silbercuechrome/mcp");
      expect(out).toMatch(/\d+\.\d+\.\d+/);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("works with --version flag", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "--version"], import.meta.url),
      ).rejects.toThrow("__exit__");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("works with -v shortcut", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "-v"], import.meta.url),
      ).rejects.toThrow("__exit__");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  // ---- status ----
  describe("status", () => {
    it("shows Free Tier with tool count when no cache exists", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "status"], import.meta.url),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("Tier:");
      expect(out).toContain("Free");
      expect(out).toContain(`${FREE_TIER_TOOL_COUNT}`);
      expect(out).toContain("available");
      expect(out).toContain(UPGRADE_URL);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("notes existing cache + Pro-installation hint when cache.valid=true", async () => {
      writeCache(mockHomeDir, {
        key: "sk-pro-1234567890abcdef",
        valid: true,
        lastCheck: new Date().toISOString(),
        features: [],
      });
      await expect(
        dispatchTopLevelCli(["node", "index.js", "status"], import.meta.url),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("Free");
      expect(out).toContain("license cache was found");
      expect(out).toContain("@silbercuechrome/mcp-pro");
    });

    it("ignores invalid cache structure", async () => {
      writeCache(mockHomeDir, { not: "a valid cache" });
      await expect(
        dispatchTopLevelCli(["node", "index.js", "status"], import.meta.url),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).not.toContain("license cache was found");
    });
  });

  // ---- activate (Pro-only stub) ----
  describe("activate", () => {
    it("prints Pro-Feature hint and exits 1 (no key)", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "activate"], import.meta.url),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("requires the Pro tier");
      expect(out).toContain("@silbercuechrome/mcp-pro");
      expect(out).toContain(UPGRADE_URL);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("prints Pro-Feature hint and exits 1 (with key)", async () => {
      await expect(
        dispatchTopLevelCli(
          ["node", "index.js", "activate", "sk-some-key-1234"],
          import.meta.url,
        ),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("requires the Pro tier");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ---- deactivate (Pro-only stub) ----
  describe("deactivate", () => {
    it("prints Pro-Feature hint and exits 1", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "deactivate"], import.meta.url),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("requires the Pro tier");
      expect(out).toContain("@silbercuechrome/mcp-pro");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ---- help ----
  describe("help", () => {
    it("prints help text and exits 0 (help)", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "help"], import.meta.url),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("SilbercueChrome MCP Server");
      expect(out).toContain("Usage:");
      expect(out).toContain("version");
      expect(out).toContain("status");
      expect(out).toContain("activate");
      expect(out).toContain("deactivate");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("prints help text and exits 0 (--help)", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "--help"], import.meta.url),
      ).rejects.toThrow("__exit__");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("prints help text and exits 0 (-h)", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "-h"], import.meta.url),
      ).rejects.toThrow("__exit__");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });
});
