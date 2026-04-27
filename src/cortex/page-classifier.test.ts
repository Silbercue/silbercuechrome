/**
 * Story 12a.1 (Task 4): Unit-Tests fuer den Seitentyp-Klassifikator.
 *
 * Covers:
 *  - PageType Taxonomie (AC #4)
 *  - Feature-Extraktor (AC #4)
 *  - Klassifikation pro Typ (AC #1, #2, #3)
 *  - Error-Handling und Defensive Programmierung
 *  - Edge-Cases bei Mehrdeutigkeit (Prioritaetsreihenfolge)
 */
import { describe, it, expect } from "vitest";
import {
  PAGE_TYPES,
  extractFeatures,
  classify,
  classifyPage,
  type PageType,
  type PageFeatureVector,
} from "./page-classifier.js";
import type { AXNode } from "../cache/a11y-tree.js";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Creates a minimal non-ignored AXNode with a given role. */
function node(
  role: string,
  opts?: {
    name?: string;
    description?: string;
    properties?: { name: string; value: { type: string; value: unknown } }[];
    ignored?: boolean;
  },
): AXNode {
  return {
    nodeId: crypto.randomUUID(),
    ignored: opts?.ignored ?? false,
    role: { type: "role", value: role },
    ...(opts?.name != null
      ? { name: { type: "computedString", value: opts.name } }
      : {}),
    ...(opts?.description != null
      ? { description: { type: "computedString", value: opts.description } }
      : {}),
    ...(opts?.properties != null ? { properties: opts.properties } : {}),
  };
}

/** Creates a password textbox (autocomplete: current-password). */
function passwordField(name = "Password"): AXNode {
  return node("textbox", {
    name,
    properties: [
      {
        name: "autocomplete",
        value: { type: "token", value: "current-password" },
      },
    ],
  });
}

/** Creates a textbox with a given name. */
function textbox(name = ""): AXNode {
  return node("textbox", { name });
}

/** Creates a button with a given name. */
function button(name = "Submit"): AXNode {
  return node("button", { name });
}

/** Creates a link with a given name. */
function link(name = "Link"): AXNode {
  return node("link", { name });
}

/** Creates a heading with a given name. */
function heading(name: string): AXNode {
  return node("heading", { name });
}

/** Creates N links. */
function links(count: number): AXNode[] {
  return Array.from({ length: count }, (_, i) => link(`Link ${i + 1}`));
}

/** Build a feature vector with overrides for quick test setup. */
function features(
  overrides: Partial<Omit<PageFeatureVector, "roleCounts" | "labelKeywords">> & {
    roleCounts?: Record<string, number>;
    labelKeywords?: string[];
  } = {},
): PageFeatureVector {
  const { roleCounts: rc, labelKeywords: kw, ...rest } = overrides;
  return {
    roleCounts: new Map(Object.entries(rc ?? {})),
    hasPasswordField: false,
    hasSearchLandmark: false,
    hasGrid: false,
    linkCount: 0,
    headingCount: 0,
    formCount: 0,
    textboxCount: 0,
    buttonCount: 0,
    checkboxCount: 0,
    imageCount: 0,
    labelKeywords: new Set(kw ?? []),
    ...rest,
  };
}

// ─── Test-Gruppe: PageType Taxonomie (Task 4.2) ─────────────────────

describe("PageType Taxonomie", () => {
  it("PAGE_TYPES hat mindestens 15 Eintraege", () => {
    expect(PAGE_TYPES.length).toBeGreaterThanOrEqual(15);
  });

  it("PAGE_TYPES enthaelt NICHT 'unknown'", () => {
    expect(PAGE_TYPES).not.toContain("unknown");
  });

  it("alle Eintraege sind unique", () => {
    const unique = new Set(PAGE_TYPES);
    expect(unique.size).toBe(PAGE_TYPES.length);
  });

  it("PAGE_TYPES hat genau 16 bekannte Typen", () => {
    expect(PAGE_TYPES).toHaveLength(16);
  });
});

// ─── Test-Gruppe: Feature-Extraktor (Task 4.3) ──────────────────────

describe("Feature-Extraktor (extractFeatures)", () => {
  it("leeres Node-Array → alle Counts 0, keine Keywords", () => {
    const v = extractFeatures([]);
    expect(v.roleCounts.size).toBe(0);
    expect(v.hasPasswordField).toBe(false);
    expect(v.hasSearchLandmark).toBe(false);
    expect(v.hasGrid).toBe(false);
    expect(v.linkCount).toBe(0);
    expect(v.headingCount).toBe(0);
    expect(v.formCount).toBe(0);
    expect(v.textboxCount).toBe(0);
    expect(v.buttonCount).toBe(0);
    expect(v.checkboxCount).toBe(0);
    expect(v.imageCount).toBe(0);
    expect(v.labelKeywords.size).toBe(0);
  });

  it("Login-typische Nodes → hasPasswordField, formCount, textboxCount", () => {
    const nodes: AXNode[] = [
      node("form", { name: "Login" }),
      textbox("Username"),
      passwordField(),
      button("Sign in"),
    ];
    const v = extractFeatures(nodes);
    expect(v.hasPasswordField).toBe(true);
    expect(v.formCount).toBe(1);
    expect(v.textboxCount).toBeGreaterThanOrEqual(1);
    expect(v.buttonCount).toBe(1);
  });

  it("Search-typische Nodes → hasSearchLandmark", () => {
    const nodes: AXNode[] = [
      node("search", { name: "Search" }),
      textbox("Search query"),
      button("Search"),
    ];
    const v = extractFeatures(nodes);
    expect(v.hasSearchLandmark).toBe(true);
    expect(v.textboxCount).toBe(1);
  });

  it("Data-Table-typische Nodes (table + columnheader) → hasGrid", () => {
    const nodes: AXNode[] = [
      node("table", { name: "Data" }),
      node("columnheader", { name: "Name" }),
      node("columnheader", { name: "Email" }),
      node("cell", { name: "Alice" }),
    ];
    const v = extractFeatures(nodes);
    expect(v.hasGrid).toBe(true);
  });

  it("grid-Rolle allein → hasGrid", () => {
    const nodes: AXNode[] = [node("grid", { name: "Spreadsheet" })];
    const v = extractFeatures(nodes);
    expect(v.hasGrid).toBe(true);
  });

  it("table OHNE columnheader → kein hasGrid", () => {
    const nodes: AXNode[] = [
      node("table", { name: "Layout" }),
      node("cell", { name: "Content" }),
    ];
    const v = extractFeatures(nodes);
    expect(v.hasGrid).toBe(false);
  });

  it("ignorierte Nodes werden uebersprungen", () => {
    const nodes: AXNode[] = [
      node("textbox", { name: "Visible" }),
      node("textbox", { name: "Hidden", ignored: true }),
    ];
    const v = extractFeatures(nodes);
    expect(v.textboxCount).toBe(1);
  });

  it("Passwort-Erkennung via name enthält 'password'", () => {
    const nodes: AXNode[] = [
      node("form"),
      node("textbox", { name: "Enter your password" }),
    ];
    const v = extractFeatures(nodes);
    expect(v.hasPasswordField).toBe(true);
  });

  it("Passwort-Erkennung via autocomplete: new-password", () => {
    const nodes: AXNode[] = [
      node("textbox", {
        name: "Confirm",
        properties: [
          {
            name: "autocomplete",
            value: { type: "token", value: "new-password" },
          },
        ],
      }),
    ];
    const v = extractFeatures(nodes);
    expect(v.hasPasswordField).toBe(true);
  });

  it("searchbox zaehlt als textbox", () => {
    const nodes: AXNode[] = [node("searchbox", { name: "Search" })];
    const v = extractFeatures(nodes);
    expect(v.textboxCount).toBe(1);
  });

  it("checkbox und switch werden gemeinsam gezaehlt", () => {
    const nodes: AXNode[] = [
      node("checkbox", { name: "Option A" }),
      node("switch", { name: "Toggle B" }),
      node("checkbox", { name: "Option C" }),
    ];
    const v = extractFeatures(nodes);
    expect(v.checkboxCount).toBe(3);
  });

  it("Keywords werden lowercase und dedupliziert", () => {
    const nodes: AXNode[] = [
      node("button", { name: "Submit Form" }),
      node("button", { name: "Submit Again" }),
    ];
    const v = extractFeatures(nodes);
    expect(v.labelKeywords.has("submit")).toBe(true);
    expect(v.labelKeywords.has("form")).toBe(true);
    expect(v.labelKeywords.has("again")).toBe(true);
  });

  it("Woerter mit 2 oder weniger Zeichen werden ignoriert", () => {
    const nodes: AXNode[] = [node("button", { name: "Go to it" })];
    const v = extractFeatures(nodes);
    expect(v.labelKeywords.has("go")).toBe(false);
    expect(v.labelKeywords.has("to")).toBe(false);
    expect(v.labelKeywords.has("it")).toBe(false);
  });
});

// ─── Test-Gruppe: Klassifikation (Task 4.4) ─────────────────────────

describe("Klassifikation (classify)", () => {
  it("login: form + password-textbox + 1 textbox + button → login (AC #1)", () => {
    const nodes: AXNode[] = [
      node("form", { name: "Login" }),
      textbox("Username"),
      passwordField(),
      button("Sign in"),
    ];
    expect(classifyPage(nodes)).toBe("login");
  });

  it("search_results: search-Landmark + 10 Links → search_results (AC #2)", () => {
    const nodes: AXNode[] = [
      node("search", { name: "Search" }),
      textbox("Query"),
      ...links(10),
    ];
    expect(classifyPage(nodes)).toBe("search_results");
  });

  it("unknown: leeres Array → unknown (AC #3)", () => {
    expect(classifyPage([])).toBe("unknown");
  });

  it("signup: form + password + 3+ textbox → signup", () => {
    const nodes: AXNode[] = [
      node("form", { name: "Register" }),
      textbox("Name"),
      textbox("Email"),
      passwordField(),
      textbox("Confirm Password"),
      button("Create Account"),
    ];
    // 4 textbox (Name, Email, Password, Confirm) — password is detected, textboxCount >= 3
    expect(classifyPage(nodes)).toBe("signup");
  });

  it("data_table: table + columnheader → data_table", () => {
    const nodes: AXNode[] = [
      node("table", { name: "Users" }),
      node("columnheader", { name: "Name" }),
      node("columnheader", { name: "Email" }),
      node("cell", { name: "Alice" }),
      node("cell", { name: "alice@example.com" }),
    ];
    expect(classifyPage(nodes)).toBe("data_table");
  });

  it("error: heading '404 Not Found' + 0 textbox → error", () => {
    const nodes: AXNode[] = [
      heading("404 Not Found"),
      node("StaticText", { name: "The page you are looking for does not exist." }),
    ];
    expect(classifyPage(nodes)).toBe("error");
  });

  it("error: heading with 'Error' keyword → error", () => {
    const nodes: AXNode[] = [
      heading("An Error Occurred"),
      node("StaticText", { name: "Something went wrong." }),
    ];
    expect(classifyPage(nodes)).toBe("error");
  });

  it("form_simple: form + 2 textbox + button, kein Passwort → form_simple", () => {
    const nodes: AXNode[] = [
      node("form", { name: "Contact" }),
      textbox("Name"),
      textbox("Email"),
      button("Send"),
    ];
    expect(classifyPage(nodes)).toBe("form_simple");
  });

  it("article: 3 headings + viel StaticText + 0 textbox → article", () => {
    const nodes: AXNode[] = [
      heading("Introduction"),
      node("StaticText", { name: "Lorem ipsum dolor sit amet..." }),
      heading("Chapter 1"),
      node("StaticText", { name: "More text content here..." }),
      heading("Chapter 2"),
      node("StaticText", { name: "Even more text content..." }),
      ...links(5), // some links in article, but < 15
    ];
    expect(classifyPage(nodes)).toBe("article");
  });

  it("navigation: 20 Links + 0 textbox → navigation", () => {
    const nodes: AXNode[] = [
      heading("Sitemap"),
      ...links(20),
    ];
    expect(classifyPage(nodes)).toBe("navigation");
  });

  it("settings: 3+ checkbox → settings", () => {
    const nodes: AXNode[] = [
      heading("Settings"),
      node("checkbox", { name: "Enable notifications" }),
      node("checkbox", { name: "Dark mode" }),
      node("checkbox", { name: "Auto-save" }),
      button("Save"),
    ];
    expect(classifyPage(nodes)).toBe("settings");
  });

  it("settings: 1 checkbox + settings keyword → settings", () => {
    const nodes: AXNode[] = [
      heading("Account Settings"),
      node("checkbox", { name: "Newsletter" }),
      button("Save Settings"),
    ];
    expect(classifyPage(nodes)).toBe("settings");
  });

  it("media: video role → media", () => {
    const nodes: AXNode[] = [
      node("video", { name: "Tutorial" }),
      button("Play"),
      button("Pause"),
    ];
    expect(classifyPage(nodes)).toBe("media");
  });

  it("media: audio role → media", () => {
    const nodes: AXNode[] = [
      node("audio", { name: "Podcast Episode" }),
      button("Play"),
    ];
    expect(classifyPage(nodes)).toBe("media");
  });

  it("checkout: payment keywords + form → checkout", () => {
    const nodes: AXNode[] = [
      node("form", { name: "Checkout" }),
      textbox("Card Number"),
      textbox("Billing Address"),
      node("textbox", { name: "Payment Method" }),
      button("Pay Now"),
    ];
    expect(classifyPage(nodes)).toBe("checkout");
  });

  it("profile: img + heading + profile keyword + wenig Links → profile", () => {
    const nodes: AXNode[] = [
      node("img", { name: "Avatar" }),
      heading("User Profile"),
      node("StaticText", { name: "John Doe" }),
      node("StaticText", { name: "john@example.com" }),
      ...links(3),
    ];
    expect(classifyPage(nodes)).toBe("profile");
  });

  it("dashboard: 3+ headings + grid + 5+ Links → dashboard", () => {
    const nodes: AXNode[] = [
      heading("Dashboard"),
      heading("Revenue"),
      heading("Users"),
      node("grid", { name: "Stats" }),
      ...links(6),
    ];
    expect(classifyPage(nodes)).toBe("dashboard");
  });

  it("mfa: verify keyword + wenig textbox → mfa", () => {
    const nodes: AXNode[] = [
      heading("Two-Factor Authentication"),
      textbox("Enter your OTP code"),
      button("Verify"),
    ];
    expect(classifyPage(nodes)).toBe("mfa");
  });

  it("form_wizard: form + step keyword → form_wizard", () => {
    const nodes: AXNode[] = [
      node("form", { name: "Registration Wizard" }),
      heading("Step 1 of 3"),
      textbox("First Name"),
      textbox("Last Name"),
      button("Next"),
    ];
    expect(classifyPage(nodes)).toBe("form_wizard");
  });

  it("search_form: search keyword + wenig textbox + wenig Links → search_form", () => {
    const nodes: AXNode[] = [
      heading("Search"),
      textbox("Search for products"),
      button("Search"),
      ...links(3),
    ];
    expect(classifyPage(nodes)).toBe("search_form");
  });

  it("search_results: kein search-Landmark, aber Search-textbox + Submit + viele Links → search_results (H1)", () => {
    const nodes: AXNode[] = [
      heading("Results"),
      textbox("Search products"),
      button("Search"),
      ...links(8),
    ];
    expect(classifyPage(nodes)).toBe("search_results");
  });

  it("signup: 3-Feld-Form (Email + Password + Confirm) → signup, nicht login (H3)", () => {
    const nodes: AXNode[] = [
      node("form", { name: "Register" }),
      textbox("Email"),
      passwordField(),
      node("textbox", { name: "Confirm Password" }),
      button("Sign Up"),
    ];
    // 3 textbox (Email, Password, Confirm) — muss signup sein, nicht login
    expect(classifyPage(nodes)).toBe("signup");
  });
});

// ─── Test-Gruppe: Error-Handling (Task 4.5, 4.6) ────────────────────

describe("Error-Handling", () => {
  it("classifyPage() faengt Fehler ab → unknown (Task 4.5)", () => {
    // Node mit fehlendem role — extractFeatures handles gracefully
    const badNodes: AXNode[] = [
      { nodeId: "1", ignored: false } as AXNode,
    ];
    expect(classifyPage(badNodes)).toBe("unknown");
  });

  it("classifyPage() mit null → unknown (Task 4.6)", () => {
    expect(classifyPage(null as unknown as AXNode[])).toBe("unknown");
  });

  it("classifyPage() mit undefined → unknown (Task 4.6)", () => {
    expect(classifyPage(undefined as unknown as AXNode[])).toBe("unknown");
  });

  it("classifyPage() mit Nicht-Array → unknown (Task 4.6)", () => {
    expect(classifyPage("not an array" as unknown as AXNode[])).toBe("unknown");
  });

  it("classifyPage() faengt echte Exception in extractFeatures ab → unknown (M1)", () => {
    // Erzeuge ein Node-Objekt das beim Property-Zugriff wirft (Getter-Trap).
    // Das loest eine echte Exception im extractFeatures-Pfad aus.
    const trap = {
      nodeId: "trap",
      ignored: false,
      get role(): never {
        throw new Error("Boom: role getter exploded");
      },
    } as unknown as AXNode;
    expect(classifyPage([trap])).toBe("unknown");
  });
});

// ─── Test-Gruppe: Edge-Cases (Task 4.7) ──────────────────────────────

describe("Edge-Cases: Prioritaetsreihenfolge", () => {
  it("Login mit Footer-Navigation (Passwort + viele Links) → login (Passwort hat Prioritaet)", () => {
    const nodes: AXNode[] = [
      node("form", { name: "Login" }),
      textbox("Email"),
      passwordField(),
      button("Sign in"),
      ...links(20), // Footer navigation
    ];
    expect(classifyPage(nodes)).toBe("login");
  });

  it("Suchergebnis mit Tabelle (search + data_table) → search_results (search hat Prioritaet)", () => {
    const nodes: AXNode[] = [
      node("search", { name: "Search" }),
      textbox("Query"),
      node("table", { name: "Results" }),
      node("columnheader", { name: "Name" }),
      node("columnheader", { name: "Price" }),
      ...links(10),
    ];
    expect(classifyPage(nodes)).toBe("search_results");
  });

  it("Error-Seite ohne '404' aber mit 'error' → error", () => {
    const nodes: AXNode[] = [
      heading("Server Error"),
      node("StaticText", { name: "Internal error occurred." }),
    ];
    expect(classifyPage(nodes)).toBe("error");
  });

  it("Seite mit nur einem Heading und nichts anderem → unknown", () => {
    const nodes: AXNode[] = [heading("Welcome")];
    expect(classifyPage(nodes)).toBe("unknown");
  });

  it("checkout hat Prioritaet vor form_simple (payment keywords)", () => {
    const f = features({
      formCount: 1,
      textboxCount: 2,
      buttonCount: 1,
      labelKeywords: ["payment", "address"],
    });
    expect(classify(f)).toBe("checkout");
  });

  it("dashboard hat Prioritaet vor navigation (headings + grid + links)", () => {
    const f = features({
      headingCount: 4,
      hasGrid: true,
      linkCount: 20,
      textboxCount: 0,
    });
    expect(classify(f)).toBe("dashboard");
  });

  it("form_wizard hat Prioritaet vor form_simple (step keyword)", () => {
    const f = features({
      formCount: 1,
      textboxCount: 2,
      labelKeywords: ["step", "next"],
    });
    expect(classify(f)).toBe("form_wizard");
  });
});

// ─── classify() direkt mit Feature-Vektoren ──────────────────────────

describe("classify() mit Feature-Vektoren", () => {
  it("alle Defaults → unknown", () => {
    expect(classify(features())).toBe("unknown");
  });

  it("nur hasPasswordField + formCount → login", () => {
    expect(
      classify(features({ hasPasswordField: true, formCount: 1, textboxCount: 2 })),
    ).toBe("login");
  });

  it("hasPasswordField + textboxCount >= 3 → signup", () => {
    expect(
      classify(
        features({ hasPasswordField: true, formCount: 1, textboxCount: 4 }),
      ),
    ).toBe("signup");
  });

  it("nur linkCount >= 15 → navigation", () => {
    expect(classify(features({ linkCount: 20, textboxCount: 0 }))).toBe(
      "navigation",
    );
  });

  it("nur headingCount >= 2 + linkCount < 15 + textboxCount === 0 → article", () => {
    expect(
      classify(features({ headingCount: 3, linkCount: 5, textboxCount: 0 })),
    ).toBe("article");
  });

  it("application + player keyword → media", () => {
    expect(
      classify(
        features({
          roleCounts: { application: 1 },
          labelKeywords: ["player"],
        }),
      ),
    ).toBe("media");
  });
});
