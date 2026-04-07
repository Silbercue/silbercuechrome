import { describe, it, expect, beforeEach } from "vitest";
import { registerProHooks, getProHooks, proFeatureError } from "./pro-hooks.js";
import type { ProHooks } from "./pro-hooks.js";
import type { LicenseStatus } from "../license/license-status.js";

describe("ProHooks", () => {
  // Reset between tests — clean state
  beforeEach(() => {
    registerProHooks({});
  });

  it("default hooks are an empty object (all properties undefined)", () => {
    const hooks = getProHooks();
    expect(hooks).toEqual({});
    expect(hooks.featureGate).toBeUndefined();
    expect(hooks.enhanceTool).toBeUndefined();
    expect(hooks.onToolResult).toBeUndefined();
  });

  it("registerProHooks sets new hooks", () => {
    const gate = (toolName: string) => ({ allowed: toolName !== "dom_snapshot" });
    registerProHooks({ featureGate: gate });

    const hooks = getProHooks();
    expect(hooks.featureGate).toBe(gate);
    expect(hooks.enhanceTool).toBeUndefined();
    expect(hooks.onToolResult).toBeUndefined();
  });

  it("getProHooks returns the registered hooks", () => {
    const myHooks: ProHooks = {
      featureGate: () => ({ allowed: true }),
      enhanceTool: (_name, params) => params,
      onToolResult: (_name, result) => result,
    };
    registerProHooks(myHooks);

    const hooks = getProHooks();
    expect(hooks.featureGate).toBe(myHooks.featureGate);
    expect(hooks.enhanceTool).toBe(myHooks.enhanceTool);
    expect(hooks.onToolResult).toBe(myHooks.onToolResult);
  });

  it("multiple registerProHooks calls — last one wins", () => {
    const first = () => ({ allowed: false });
    const second = () => ({ allowed: true });

    registerProHooks({ featureGate: first });
    expect(getProHooks().featureGate).toBe(first);

    registerProHooks({ featureGate: second });
    expect(getProHooks().featureGate).toBe(second);
  });

  it("registerProHooks with empty object resets hooks", () => {
    registerProHooks({ featureGate: () => ({ allowed: true }) });
    expect(getProHooks().featureGate).toBeDefined();

    registerProHooks({});
    expect(getProHooks().featureGate).toBeUndefined();
  });

  it("featureGate hook returns gate result with optional message", () => {
    registerProHooks({
      featureGate: (toolName) => {
        if (toolName === "dom_snapshot") {
          return { allowed: false, message: "dom_snapshot requires Pro license" };
        }
        return { allowed: true };
      },
    });

    const hooks = getProHooks();
    const blocked = hooks.featureGate!("dom_snapshot");
    expect(blocked.allowed).toBe(false);
    expect(blocked.message).toBe("dom_snapshot requires Pro license");

    const allowed = hooks.featureGate!("evaluate");
    expect(allowed.allowed).toBe(true);
    expect(allowed.message).toBeUndefined();
  });

  it("enhanceTool hook can modify params", () => {
    registerProHooks({
      enhanceTool: (_name, params) => ({ ...params, enhanced: true }),
    });

    const result = getProHooks().enhanceTool!("evaluate", { expression: "1+1" });
    expect(result).toEqual({ expression: "1+1", enhanced: true });
  });

  it("enhanceTool hook can return null for no change", () => {
    registerProHooks({
      enhanceTool: () => null,
    });

    const result = getProHooks().enhanceTool!("evaluate", { expression: "1+1" });
    expect(result).toBeNull();
  });

  it("onToolResult hook can modify response", () => {
    registerProHooks({
      onToolResult: (_name, result) => ({
        ...result,
        content: [...result.content, { type: "text" as const, text: "enhanced" }],
      }),
    });

    const original = {
      content: [{ type: "text" as const, text: "original" }],
      _meta: { elapsedMs: 10, method: "evaluate" },
    };
    const modified = getProHooks().onToolResult!("evaluate", original);
    expect(modified.content).toHaveLength(2);
    expect((modified.content[1] as { text: string }).text).toBe("enhanced");
  });

  // --- Story 9.6: proFeatureError ---

  it("proFeatureError returns isError response with correct format", () => {
    const result = proFeatureError("dom_snapshot");

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "dom_snapshot ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'",
    });
    expect(result._meta).toEqual({ elapsedMs: 0, method: "dom_snapshot" });
  });

  it("proFeatureError uses the provided tool name in message and meta", () => {
    const result = proFeatureError("some_future_tool");

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("some_future_tool ist ein Pro-Feature");
    expect(result._meta!.method).toBe("some_future_tool");
  });

  // --- Story 15.5: provideLicenseStatus Hook ---

  it("provideLicenseStatus is undefined by default", () => {
    const hooks = getProHooks();
    expect(hooks.provideLicenseStatus).toBeUndefined();
  });

  it("provideLicenseStatus can be registered and retrieved", async () => {
    const mockStatus: LicenseStatus = { isPro: () => true };
    const provider = async () => mockStatus;

    registerProHooks({ provideLicenseStatus: provider });

    const hooks = getProHooks();
    expect(hooks.provideLicenseStatus).toBe(provider);

    const status = await hooks.provideLicenseStatus!();
    expect(status.isPro()).toBe(true);
  });

  it("provideLicenseStatus works alongside other hooks", () => {
    const gate = () => ({ allowed: true });
    const provider = async (): Promise<LicenseStatus> => ({ isPro: () => false });

    registerProHooks({ featureGate: gate, provideLicenseStatus: provider });

    const hooks = getProHooks();
    expect(hooks.featureGate).toBe(gate);
    expect(hooks.provideLicenseStatus).toBe(provider);
  });

  it("provideLicenseStatus is cleared when hooks are reset", async () => {
    const provider = async (): Promise<LicenseStatus> => ({ isPro: () => true });
    registerProHooks({ provideLicenseStatus: provider });
    expect(getProHooks().provideLicenseStatus).toBeDefined();

    registerProHooks({});
    expect(getProHooks().provideLicenseStatus).toBeUndefined();
  });
});
