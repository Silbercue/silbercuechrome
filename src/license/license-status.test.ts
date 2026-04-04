import { describe, it, expect } from "vitest";
import { FreeTierLicenseStatus } from "./license-status.js";
import type { LicenseStatus } from "./license-status.js";

describe("LicenseStatus interface", () => {
  it("FreeTierLicenseStatus implements LicenseStatus", () => {
    const status: LicenseStatus = new FreeTierLicenseStatus();
    expect(status).toBeDefined();
    expect(typeof status.isPro).toBe("function");
  });
});

describe("FreeTierLicenseStatus", () => {
  it("isPro() returns false", () => {
    const status = new FreeTierLicenseStatus();
    expect(status.isPro()).toBe(false);
  });

  it("isPro() always returns false regardless of how many times called", () => {
    const status = new FreeTierLicenseStatus();
    expect(status.isPro()).toBe(false);
    expect(status.isPro()).toBe(false);
    expect(status.isPro()).toBe(false);
  });
});
