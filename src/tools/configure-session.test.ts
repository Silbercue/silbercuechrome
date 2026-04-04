import { describe, it, expect, beforeEach } from "vitest";
import { configureSessionHandler } from "./configure-session.js";
import { SessionDefaults } from "../cache/session-defaults.js";

describe("configureSessionHandler", () => {
  let sd: SessionDefaults;

  beforeEach(() => {
    sd = new SessionDefaults();
  });

  it("ohne Parameter: gibt aktuelle Defaults und Vorschlaege zurueck", async () => {
    sd.setDefault("tab", "tab-abc");

    const result = await configureSessionHandler({}, sd);

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.defaults).toEqual({ tab: "tab-abc" });
    expect(parsed.autoPromote).toEqual([]);
  });

  it("mit defaults: setzt Defaults und gibt aktualisierte Defaults zurueck", async () => {
    const result = await configureSessionHandler(
      { defaults: { tab: "tab-abc123", timeout: 10000 } },
      sd,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.defaults).toEqual({ tab: "tab-abc123", timeout: 10000 });
  });

  it("mit defaults: { tab: null } entfernt Default", async () => {
    sd.setDefault("tab", "tab-abc");
    sd.setDefault("timeout", 5000);

    const result = await configureSessionHandler(
      { defaults: { tab: null } },
      sd,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.defaults).toEqual({ timeout: 5000 });
    // tab should be removed
    expect(parsed.defaults.tab).toBeUndefined();
  });

  it("mit autoPromote: true: uebernimmt Vorschlaege als Defaults", async () => {
    // Create suggestions by tracking calls
    sd.trackCall("click", { tab: "tab-xyz" });
    sd.trackCall("click", { tab: "tab-xyz" });
    sd.trackCall("click", { tab: "tab-xyz" });

    const result = await configureSessionHandler(
      { autoPromote: true },
      sd,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.applied).toEqual({ tab: "tab-xyz" });
    expect(parsed.defaults).toEqual({ tab: "tab-xyz" });
  });

  it("_meta enthaelt elapsedMs und method: configure_session", async () => {
    const result = await configureSessionHandler({}, sd);

    expect(result._meta).toBeDefined();
    expect(result._meta?.method).toBe("configure_session");
    expect(typeof result._meta?.elapsedMs).toBe("number");
  });

  it("autoPromote: true with no suggestions: returns empty applied and defaults", async () => {
    const result = await configureSessionHandler(
      { autoPromote: true },
      sd,
    );

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.applied).toEqual({});
    expect(parsed.defaults).toEqual({});
  });

  it("H4: autoPromote + defaults gleichzeitig → beide werden ausgefuehrt", async () => {
    // Set up suggestions
    sd.trackCall("click", { tab: "tab-xyz" });
    sd.trackCall("click", { tab: "tab-xyz" });
    sd.trackCall("click", { tab: "tab-xyz" });

    const result = await configureSessionHandler(
      { autoPromote: true, defaults: { timeout: 8000 } },
      sd,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    // autoPromote should have applied the suggestion
    expect(parsed.applied).toEqual({ tab: "tab-xyz" });
    // defaults should contain both the explicit default AND the promoted suggestion
    expect(parsed.defaults).toEqual({ timeout: 8000, tab: "tab-xyz" });
  });

  it("defaults with unknown keys are accepted (future-proof)", async () => {
    const result = await configureSessionHandler(
      { defaults: { custom_param: "value", another: 42 } },
      sd,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.defaults).toEqual({ custom_param: "value", another: 42 });
  });
});
