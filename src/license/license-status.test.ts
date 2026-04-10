import { describe, it, expect, vi, beforeEach } from "vitest";
import { FreeTierLicenseStatus } from "./license-status.js";
import type { LicenseStatus } from "./license-status.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn() };
});

import { readFileSync } from "node:fs";
const mockRead = vi.mocked(readFileSync);

beforeEach(() => {
  mockRead.mockReset();
});

describe("LicenseStatus interface", () => {
  it("FreeTierLicenseStatus implements LicenseStatus", () => {
    mockRead.mockImplementation(() => { throw new Error("ENOENT"); });
    const status: LicenseStatus = new FreeTierLicenseStatus();
    expect(status).toBeDefined();
    expect(typeof status.isPro).toBe("function");
  });
});

describe("FreeTierLicenseStatus — cache-based", () => {
  it("isPro() returns false when cache file missing", () => {
    mockRead.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(new FreeTierLicenseStatus().isPro()).toBe(false);
  });

  it("isPro() returns false when cache has valid: false", () => {
    mockRead.mockReturnValue(JSON.stringify({ key: "SCC-TEST", valid: false }));
    expect(new FreeTierLicenseStatus().isPro()).toBe(false);
  });

  it("isPro() returns false when key prefix is wrong", () => {
    mockRead.mockReturnValue(JSON.stringify({ key: "WRONG-KEY", valid: true }));
    expect(new FreeTierLicenseStatus().isPro()).toBe(false);
  });

  it("isPro() returns true with valid cache", () => {
    mockRead.mockReturnValue(JSON.stringify({
      key: "SCC-BB10DC99-BC6B-47AF-BF3F-E4ED4DA59DE8",
      valid: true,
    }));
    expect(new FreeTierLicenseStatus().isPro()).toBe(true);
  });

  it("isPro() returns false on malformed JSON", () => {
    mockRead.mockReturnValue("not json");
    expect(new FreeTierLicenseStatus().isPro()).toBe(false);
  });
});

describe("FreeTierLicenseStatus — override parameter", () => {
  it("override=false forces Free regardless of cache", () => {
    mockRead.mockReturnValue(JSON.stringify({ key: "SCC-VALID", valid: true }));
    expect(new FreeTierLicenseStatus(false).isPro()).toBe(false);
  });

  it("override=true forces Pro regardless of cache", () => {
    mockRead.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(new FreeTierLicenseStatus(true).isPro()).toBe(true);
  });
});
