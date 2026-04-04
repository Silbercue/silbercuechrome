import { describe, it, expect, beforeEach } from "vitest";
import { SessionDefaults } from "./session-defaults.js";

describe("SessionDefaults", () => {
  let sd: SessionDefaults;

  beforeEach(() => {
    sd = new SessionDefaults();
  });

  // --- setDefault / getDefault ---

  it("setDefault setzt einen Default-Wert", () => {
    sd.setDefault("tab", "tab-abc123");
    expect(sd.getDefault("tab")).toBe("tab-abc123");
  });

  it("setDefault mit null entfernt den Default", () => {
    sd.setDefault("tab", "tab-abc123");
    sd.setDefault("tab", null);
    expect(sd.getDefault("tab")).toBeUndefined();
  });

  it("getDefault gibt den gesetzten Wert zurueck", () => {
    sd.setDefault("timeout", 10000);
    expect(sd.getDefault("timeout")).toBe(10000);
  });

  it("getDefault gibt undefined fuer nicht-gesetzte Params zurueck", () => {
    expect(sd.getDefault("nonexistent")).toBeUndefined();
  });

  it("getAllDefaults gibt alle Defaults als Record zurueck", () => {
    sd.setDefault("tab", "tab-abc");
    sd.setDefault("timeout", 5000);
    expect(sd.getAllDefaults()).toEqual({ tab: "tab-abc", timeout: 5000 });
  });

  // --- resolveParams ---

  it("resolveParams fuegt fehlende Defaults ein", () => {
    sd.setDefault("tab", "tab-abc");
    sd.setDefault("timeout", 10000);

    const resolved = sd.resolveParams("click", { ref: "e5" });
    expect(resolved).toEqual({ ref: "e5", tab: "tab-abc", timeout: 10000 });
  });

  it("resolveParams ueberschreibt explizite Params nicht", () => {
    sd.setDefault("tab", "tab-abc");
    sd.setDefault("timeout", 10000);

    const resolved = sd.resolveParams("click", { ref: "e5", tab: "tab-xyz" });
    expect(resolved.tab).toBe("tab-xyz");
    expect(resolved.timeout).toBe(10000);
  });

  it("resolveParams gibt neues Objekt zurueck (keine Mutation)", () => {
    sd.setDefault("tab", "tab-abc");
    const original = { ref: "e5" };
    const resolved = sd.resolveParams("click", original);

    expect(resolved).not.toBe(original);
    expect(original).toEqual({ ref: "e5" }); // unchanged
    expect(resolved).toEqual({ ref: "e5", tab: "tab-abc" });
  });

  it("resolveParams ohne Defaults gibt Kopie der Original-Params zurueck", () => {
    const original = { ref: "e5", selector: ".btn" };
    const resolved = sd.resolveParams("click", original);

    expect(resolved).not.toBe(original);
    expect(resolved).toEqual(original);
  });

  // --- trackCall / getSuggestions ---

  it("trackCall speichert Call in History", () => {
    sd.trackCall("click", { ref: "e5", tab: "tab-abc" });
    // We can verify indirectly through suggestions after threshold calls
    // At 1 call, no suggestion yet
    expect(sd.getSuggestions()).toEqual([]);
  });

  it("trackCall sliding window: aelteste Calls werden entfernt (max 10)", () => {
    const sdSmall = new SessionDefaults({ slidingWindowSize: 3, promoteThreshold: 3 });

    // Track 5 calls — only last 3 should remain in window
    sdSmall.trackCall("click", { tab: "tab-old" });
    sdSmall.trackCall("click", { tab: "tab-old" });
    sdSmall.trackCall("click", { tab: "tab-new" });
    sdSmall.trackCall("click", { tab: "tab-new" });
    sdSmall.trackCall("click", { tab: "tab-new" });

    // Last 3 are all "tab-new" — should suggest
    const suggestions = sdSmall.getSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].param).toBe("tab");
    expect(suggestions[0].value).toBe("tab-new");
    expect(suggestions[0].count).toBe(3);
  });

  it("getSuggestions gibt Vorschlaege nach 3+ identischen Calls", () => {
    sd.trackCall("click", { tab: "tab-xyz" });
    sd.trackCall("type", { tab: "tab-xyz" });
    sd.trackCall("click", { tab: "tab-xyz" });

    const suggestions = sd.getSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toEqual({
      param: "tab",
      value: "tab-xyz",
      count: 3,
      tool: "click", // first tool in the consecutive run (from the end = the first/earliest)
    });
  });

  it("getSuggestions gibt leere Liste wenn unter Threshold", () => {
    sd.trackCall("click", { tab: "tab-xyz" });
    sd.trackCall("type", { tab: "tab-xyz" });

    expect(sd.getSuggestions()).toEqual([]);
  });

  it("getSuggestions schlaegt keinen Param vor der bereits Default ist", () => {
    sd.setDefault("tab", "tab-xyz");

    sd.trackCall("click", { tab: "tab-xyz" });
    sd.trackCall("type", { tab: "tab-xyz" });
    sd.trackCall("click", { tab: "tab-xyz" });

    expect(sd.getSuggestions()).toEqual([]);
  });

  it("getSuggestions vergleicht nur primitive Werte", () => {
    const obj = { x: 1 };
    sd.trackCall("evaluate", { data: obj });
    sd.trackCall("evaluate", { data: obj });
    sd.trackCall("evaluate", { data: obj });

    // Objects should be ignored — no suggestion
    expect(sd.getSuggestions()).toEqual([]);
  });

  it("getSuggestions ignores arrays", () => {
    sd.trackCall("evaluate", { items: [1, 2] });
    sd.trackCall("evaluate", { items: [1, 2] });
    sd.trackCall("evaluate", { items: [1, 2] });

    expect(sd.getSuggestions()).toEqual([]);
  });

  // --- applyAllSuggestions ---

  it("applyAllSuggestions setzt alle Vorschlaege als Defaults", () => {
    sd.trackCall("click", { tab: "tab-abc", timeout: 5000 });
    sd.trackCall("click", { tab: "tab-abc", timeout: 5000 });
    sd.trackCall("click", { tab: "tab-abc", timeout: 5000 });

    const applied = sd.applyAllSuggestions();
    expect(applied).toEqual({ tab: "tab-abc", timeout: 5000 });
    expect(sd.getDefault("tab")).toBe("tab-abc");
    expect(sd.getDefault("timeout")).toBe(5000);
  });

  it("applyAllSuggestions leert die Vorschlagsliste", () => {
    sd.trackCall("click", { tab: "tab-abc" });
    sd.trackCall("click", { tab: "tab-abc" });
    sd.trackCall("click", { tab: "tab-abc" });

    expect(sd.getSuggestions()).toHaveLength(1);
    sd.applyAllSuggestions();
    expect(sd.getSuggestions()).toEqual([]);
  });

  // --- clearAll ---

  it("clearAll leert Defaults, History und Vorschlaege", () => {
    sd.setDefault("tab", "tab-abc");
    sd.trackCall("click", { timeout: 5000 });
    sd.trackCall("click", { timeout: 5000 });
    sd.trackCall("click", { timeout: 5000 });

    // Verify state before clear
    expect(sd.getAllDefaults()).toEqual({ tab: "tab-abc" });
    expect(sd.getSuggestions()).toHaveLength(1);

    sd.clearAll();

    expect(sd.getAllDefaults()).toEqual({});
    expect(sd.getSuggestions()).toEqual([]);
  });

  // --- Edge cases ---

  it("consecutive count breaks when a different value appears", () => {
    sd.trackCall("click", { tab: "tab-abc" });
    sd.trackCall("click", { tab: "tab-abc" });
    sd.trackCall("click", { tab: "tab-xyz" }); // breaks the run
    sd.trackCall("click", { tab: "tab-abc" });
    sd.trackCall("click", { tab: "tab-abc" });

    // Only 2 consecutive from the end — under threshold
    expect(sd.getSuggestions()).toEqual([]);
  });

  it("suggestion count updates when more consecutive calls arrive", () => {
    sd.trackCall("click", { tab: "tab-abc" });
    sd.trackCall("click", { tab: "tab-abc" });
    sd.trackCall("click", { tab: "tab-abc" });

    expect(sd.getSuggestions()[0].count).toBe(3);

    sd.trackCall("click", { tab: "tab-abc" });

    expect(sd.getSuggestions()[0].count).toBe(4);
  });

  it("boolean values are tracked as primitives", () => {
    sd.trackCall("evaluate", { await_promise: true });
    sd.trackCall("evaluate", { await_promise: true });
    sd.trackCall("evaluate", { await_promise: true });

    const suggestions = sd.getSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].param).toBe("await_promise");
    expect(suggestions[0].value).toBe(true);
  });

  it("calls without a param break the consecutive run", () => {
    sd.trackCall("click", { tab: "tab-abc" });
    sd.trackCall("tab_status", {}); // no tab param
    sd.trackCall("click", { tab: "tab-abc" });

    // The gap breaks the consecutive run from the end → count is 1
    expect(sd.getSuggestions()).toEqual([]);
  });

  it("applyAllSuggestions returns empty record when no suggestions", () => {
    const applied = sd.applyAllSuggestions();
    expect(applied).toEqual({});
  });

  it("getSuggestions returns a copy (not the internal array)", () => {
    sd.trackCall("click", { tab: "tab-abc" });
    sd.trackCall("click", { tab: "tab-abc" });
    sd.trackCall("click", { tab: "tab-abc" });

    const suggestions1 = sd.getSuggestions();
    const suggestions2 = sd.getSuggestions();
    expect(suggestions1).not.toBe(suggestions2);
    expect(suggestions1).toEqual(suggestions2);
  });
});
