/**
 * Story 12a.1 (Task 5): Benchmark-Validierung des Seitentyp-Klassifikators.
 *
 * Testet den Klassifikator gegen synthetische AXNode-Arrays die die
 * typischen Strukturen der 35 Benchmark-Testseiten (test-hardest/index.html)
 * nachbilden.
 *
 * Die Testseite ist eine SPA mit 4 Levels:
 * - Level 1: Formulare (Login, Multi-Field, Checkbox, Radio, Select, Textarea, Date)
 * - Level 2: Navigation (Tabs, Dropdown, Modal, Accordion, Tooltip)
 * - Level 3: Daten (Sortable Table, Filter, DnD, Pagination, Inline Edit)
 * - Level 4: Komplex (Multi-Step Wizard, AJAX Form, Dynamic List, File Upload, Toast)
 *
 * AC #5: Mindestens 80% korrekt klassifiziert.
 */
import { describe, it, expect } from "vitest";
import { classifyPage, type PageType } from "./page-classifier.js";
import type { AXNode } from "../cache/a11y-tree.js";

// ─── Helpers ─────────────────────────────────────────────────────────

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

function textbox(name = ""): AXNode {
  return node("textbox", { name });
}

function button(name = "Submit"): AXNode {
  return node("button", { name });
}

function link(name = "Link"): AXNode {
  return node("link", { name });
}

function heading(name: string): AXNode {
  return node("heading", { name });
}

function links(count: number): AXNode[] {
  return Array.from({ length: count }, (_, i) => link(`Link ${i + 1}`));
}

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

// ─── Benchmark-Fixture: Synthetische Seitenstrukturen ────────────────

interface BenchmarkFixture {
  /** Beschreibung der nachgebildeten Benchmark-Seite. */
  description: string;
  /** Benchmark-Level (1-4). */
  level: number;
  /** Synthetische AXNode-Struktur. */
  nodes: AXNode[];
  /** Erwarteter Seitentyp. */
  expected: PageType;
}

const fixtures: BenchmarkFixture[] = [
  // ── Level 1: Formulare ──────────────────────────────────────────

  {
    description: "L1: Login Form (username + password + submit)",
    level: 1,
    nodes: [
      node("form", { name: "Login" }),
      textbox("Username"),
      passwordField(),
      button("Login"),
    ],
    expected: "login",
  },
  {
    description: "L1: Multi-Field Contact Form (name, email, subject, message)",
    level: 1,
    nodes: [
      node("form", { name: "Contact Us" }),
      textbox("Full Name"),
      textbox("Email Address"),
      textbox("Subject"),
      node("textbox", { name: "Message" }),
      button("Send Message"),
    ],
    expected: "form_simple",
  },
  {
    description: "L1: Checkbox Group (notification preferences)",
    level: 1,
    nodes: [
      heading("Notification Settings"),
      node("checkbox", { name: "Email notifications" }),
      node("checkbox", { name: "Push notifications" }),
      node("checkbox", { name: "SMS notifications" }),
      node("checkbox", { name: "Weekly digest" }),
      button("Save Settings"),
    ],
    expected: "settings",
  },
  {
    description: "L1: Radio Button Group with text field (plan selection + promo code)",
    level: 1,
    nodes: [
      node("form", { name: "Choose Option" }),
      heading("Select your plan"),
      node("radio", { name: "Basic" }),
      node("radio", { name: "Premium" }),
      node("radio", { name: "Enterprise" }),
      textbox("Discount Voucher"),
      button("Continue"),
    ],
    expected: "form_simple",
  },
  {
    description: "L1: Select Dropdown Form",
    level: 1,
    nodes: [
      node("form", { name: "Filter" }),
      textbox("Filter Name"),
      node("combobox", { name: "Category" }),
      node("combobox", { name: "Sort by" }),
      button("Apply"),
    ],
    expected: "form_simple",
  },
  {
    description: "L1: Textarea Form (feedback)",
    level: 1,
    nodes: [
      node("form", { name: "Feedback" }),
      textbox("Your feedback"),
      node("slider", { name: "Rating" }),
      button("Submit"),
    ],
    expected: "form_simple",
  },
  {
    description: "L1: Date Picker Form",
    level: 1,
    nodes: [
      node("form", { name: "Book Appointment" }),
      textbox("Select date"),
      textbox("Select time"),
      button("Book"),
    ],
    expected: "form_simple",
  },

  // ── Level 2: Navigation ─────────────────────────────────────────

  {
    description: "L2: Tab Navigation (content tabs)",
    level: 2,
    nodes: [
      node("tablist", { name: "Content Tabs" }),
      node("tab", { name: "Overview" }),
      node("tab", { name: "Details" }),
      node("tab", { name: "Reviews" }),
      node("tabpanel", { name: "Overview" }),
      heading("Product Overview"),
      heading("Features"),
      node("StaticText", { name: "Description of the product with detailed information..." }),
      ...links(5),
    ],
    expected: "article",
  },
  {
    description: "L2: Dropdown Menu (navigation with many links)",
    level: 2,
    nodes: [
      node("navigation", { name: "Main Menu" }),
      node("menubar", { name: "Menu" }),
      node("menuitem", { name: "Home" }),
      node("menuitem", { name: "Products" }),
      node("menu", { name: "Submenu" }),
      ...links(18),
    ],
    expected: "navigation",
  },
  {
    description: "L2: Modal Dialog",
    level: 2,
    nodes: [
      node("dialog", { name: "Confirm Action" }),
      heading("Are you sure?"),
      node("StaticText", { name: "This action cannot be undone." }),
      button("Cancel"),
      button("Confirm"),
    ],
    expected: "unknown",
  },
  {
    description: "L2: Accordion Navigation",
    level: 2,
    nodes: [
      heading("FAQ"),
      node("button", { name: "What is this?" }),
      node("region", { name: "Answer 1" }),
      node("StaticText", { name: "This is a frequently asked question..." }),
      node("button", { name: "How does it work?" }),
      node("region", { name: "Answer 2" }),
      node("StaticText", { name: "It works by..." }),
      heading("More Questions"),
      node("button", { name: "Pricing?" }),
      node("region", { name: "Answer 3" }),
    ],
    expected: "article",
  },
  {
    description: "L2: Tooltip/Hover (simple page with interactive hints)",
    level: 2,
    nodes: [
      heading("Features"),
      node("StaticText", { name: "Hover over items for details" }),
      heading("Feature List"),
      node("tooltip", { name: "Info about feature A" }),
      node("tooltip", { name: "Info about feature B" }),
      ...links(4),
    ],
    expected: "article",
  },

  // ── Level 3: Daten ──────────────────────────────────────────────

  {
    description: "L3: Sortable Data Table",
    level: 3,
    nodes: [
      heading("Employee List"),
      node("table", { name: "Employees" }),
      node("columnheader", { name: "Name" }),
      node("columnheader", { name: "Department" }),
      node("columnheader", { name: "Salary" }),
      node("cell", { name: "Alice" }),
      node("cell", { name: "Engineering" }),
      node("cell", { name: "$120,000" }),
      node("cell", { name: "Bob" }),
      node("cell", { name: "Marketing" }),
      node("cell", { name: "$95,000" }),
    ],
    expected: "data_table",
  },
  {
    description: "L3: Filterable Search Field with results",
    level: 3,
    nodes: [
      node("search", { name: "Filter employees" }),
      textbox("Search"),
      button("Filter"),
      node("list", { name: "Results" }),
      ...links(8),
    ],
    expected: "search_results",
  },
  {
    description: "L3: Drag-and-Drop List",
    level: 3,
    nodes: [
      heading("Task Board"),
      node("list", { name: "To Do" }),
      node("listitem", { name: "Task 1" }),
      node("listitem", { name: "Task 2" }),
      node("list", { name: "In Progress" }),
      node("listitem", { name: "Task 3" }),
      node("list", { name: "Done" }),
      node("listitem", { name: "Task 4" }),
      heading("Board"),
    ],
    expected: "article",
  },
  {
    description: "L3: Pagination (table with page controls)",
    level: 3,
    nodes: [
      node("table", { name: "Products" }),
      node("columnheader", { name: "Product" }),
      node("columnheader", { name: "Price" }),
      node("cell", { name: "Widget" }),
      node("cell", { name: "$10" }),
      node("navigation", { name: "Pagination" }),
      link("1"),
      link("2"),
      link("3"),
      link("Next"),
    ],
    expected: "data_table",
  },
  {
    description: "L3: Inline Editing (data table with edit controls)",
    level: 3,
    nodes: [
      node("grid", { name: "Editable Data" }),
      node("columnheader", { name: "Field" }),
      node("columnheader", { name: "Value" }),
      node("cell", { name: "Name" }),
      textbox("Alice"),
      node("cell", { name: "Email" }),
      textbox("alice@example.com"),
      button("Save"),
    ],
    expected: "data_table",
  },

  // ── Level 4: Komplex ───────────────────────────────────────────

  {
    description: "L4: Multi-Step Wizard (3 steps)",
    level: 4,
    nodes: [
      node("form", { name: "Registration Wizard" }),
      heading("Step 1 of 3"),
      node("progressbar", { name: "Progress" }),
      textbox("First Name"),
      textbox("Last Name"),
      button("Next Step"),
    ],
    expected: "form_wizard",
  },
  {
    description: "L4: AJAX Form (dynamic submission)",
    level: 4,
    nodes: [
      node("form", { name: "Subscribe" }),
      textbox("Email Address"),
      button("Subscribe"),
      node("status", { name: "Subscribed!" }),
    ],
    expected: "form_simple",
  },
  {
    description: "L4: Dynamic List (add/remove items)",
    level: 4,
    nodes: [
      heading("Shopping List"),
      textbox("Add item"),
      button("Add"),
      node("list", { name: "Items" }),
      node("listitem", { name: "Milk" }),
      node("listitem", { name: "Bread" }),
      button("Remove"),
      button("Remove"),
    ],
    expected: "form_simple",
  },
  {
    description: "L4: File Upload Form",
    level: 4,
    nodes: [
      node("form", { name: "Upload" }),
      button("Choose File"),
      node("StaticText", { name: "No file chosen" }),
      button("Upload"),
    ],
    expected: "unknown",
  },
  {
    description: "L4: Toast Notifications (page with status messages)",
    level: 4,
    nodes: [
      heading("Notifications Demo"),
      button("Show Success"),
      button("Show Error"),
      button("Show Warning"),
      node("alert", { name: "Operation successful" }),
    ],
    expected: "unknown",
  },

  // ── Fehlende Tests fuer 35-Fixture-Gate (H2) ──────────────────────

  {
    description: "T1.1: Click the Button (einfacher Button-Click-Test)",
    level: 1,
    nodes: [
      heading("Click the Button"),
      button("Click Me"),
      node("StaticText", { name: "Finde und klicke den Button." }),
    ],
    expected: "unknown",
  },
  {
    description: "T1.2: Read Text Content (Wert lesen + eingeben)",
    level: 1,
    nodes: [
      heading("Read Text Content"),
      node("StaticText", { name: "Der geheime Wert lautet:" }),
      textbox("Wert hier eingeben"),
      button("Check"),
    ],
    expected: "form_simple",
  },
  {
    description: "T1.4: Element Selection Challenge (5 Selektoren)",
    level: 1,
    nodes: [
      heading("Element Selection Challenge"),
      button("Find by ID"),
      button("Find by Class"),
      button("Find by data-attribute"),
      button("Find by aria-label"),
      button("Find by exact text"),
    ],
    expected: "unknown",
  },
  {
    description: "T1.5: Navigation Sequence (Links in Reihenfolge klicken)",
    level: 1,
    nodes: [
      heading("Navigation Sequence"),
      link("Step Alpha"),
      link("Step Beta"),
      link("Step Gamma"),
      button("Check Sequence"),
    ],
    expected: "unknown",
  },
  {
    description: "T1.6: Read Table Data (Tabelle lesen + Summe berechnen)",
    level: 1,
    nodes: [
      heading("Read Table Data"),
      node("table", { name: "Scores" }),
      node("columnheader", { name: "Name" }),
      node("columnheader", { name: "Category" }),
      node("columnheader", { name: "Score" }),
      node("cell", { name: "Alice" }),
      node("cell", { name: "Math" }),
      node("cell", { name: "85" }),
      textbox("Sum of scores"),
      button("Submit"),
    ],
    expected: "data_table",
  },
  {
    description: "T2.1: Wait for Async Content (Load + Wert lesen)",
    level: 2,
    nodes: [
      heading("Wait for Async Content"),
      button("Load Data"),
      textbox("Enter loaded value"),
      button("Submit"),
    ],
    expected: "form_simple",
  },
  {
    description: "T2.2: Infinite Scroll (Scroll-Liste laden)",
    level: 2,
    nodes: [
      heading("Infinite Scroll"),
      node("list", { name: "Scroll items" }),
      node("listitem", { name: "Item 1" }),
      node("listitem", { name: "Item 2" }),
      node("listitem", { name: "Item 3" }),
      button("Check Item 30 Loaded"),
    ],
    expected: "unknown",
  },
  {
    description: "T2.6: Sort Table and Find Value (Sortierung + Wert eingeben)",
    level: 2,
    nodes: [
      heading("Sort Table and Find Value"),
      node("table", { name: "Products" }),
      node("columnheader", { name: "Product" }),
      node("columnheader", { name: "Price" }),
      node("columnheader", { name: "Stock" }),
      node("cell", { name: "Widget" }),
      node("cell", { name: "$99" }),
      node("cell", { name: "50" }),
      textbox("Most expensive product"),
      button("Submit"),
    ],
    expected: "data_table",
  },
  {
    description: "T3.1: Shadow DOM Interaction (Button in Shadow Root)",
    level: 3,
    nodes: [
      heading("Shadow DOM Interaction"),
      node("StaticText", { name: "Interagiere mit dem Element im Shadow DOM." }),
      button("Click Inside Shadow"),
    ],
    expected: "unknown",
  },
  {
    description: "T3.2: Nested iFrame Interaction (verschachtelte Frames)",
    level: 3,
    nodes: [
      heading("Nested iFrame Interaction"),
      node("Iframe", { name: "Outer Frame" }),
      node("StaticText", { name: "Navigiere durch verschachtelte iFrames." }),
    ],
    expected: "unknown",
  },
  {
    description: "T3.4: Canvas Click Target (Klick auf Canvas-Position)",
    level: 3,
    nodes: [
      heading("Canvas Click Target"),
      node("StaticText", { name: "Klicke auf das rote Ziel im Canvas." }),
    ],
    expected: "unknown",
  },
  {
    description: "T3.5: Keyboard Shortcut Sequence (Tastenkombinationen)",
    level: 3,
    nodes: [
      heading("Keyboard Shortcut Sequence"),
      node("StaticText", { name: "Druecke die Tasten in der richtigen Reihenfolge." }),
      node("StaticText", { name: "Sequence: Ctrl+A, Ctrl+C, Ctrl+V" }),
    ],
    expected: "unknown",
  },
  {
    description: "T3.6: Rich Text Editor (contenteditable)",
    level: 3,
    nodes: [
      heading("Rich Text Editor"),
      node("textbox", { name: "Editor content" }),
      button("Bold"),
      button("Italic"),
      button("Underline"),
    ],
    expected: "form_simple",
  },
];

// ─── Benchmark-Test ──────────────────────────────────────────────────

describe("Benchmark-Validierung (AC #5)", () => {
  // Individuelle Fixture-Tests fuer Debugging
  for (const fixture of fixtures) {
    it(`${fixture.description} → ${fixture.expected}`, () => {
      const result = classifyPage(fixture.nodes);
      expect(result).toBe(fixture.expected);
    });
  }

  // Aggregierter 80%-Gate-Test
  it("mindestens 80% der Benchmark-Fixtures korrekt klassifiziert", () => {
    let correct = 0;
    const failures: string[] = [];

    for (const fixture of fixtures) {
      const result = classifyPage(fixture.nodes);
      if (result === fixture.expected) {
        correct++;
      } else {
        failures.push(
          `  ${fixture.description}: expected=${fixture.expected}, got=${result}`,
        );
      }
    }

    const total = fixtures.length;
    const rate = correct / total;

    // Log details for debugging if threshold is not met
    if (rate < 0.8) {
      console.error(
        `Benchmark: ${correct}/${total} (${(rate * 100).toFixed(1)}%) — BELOW 80% THRESHOLD`,
      );
      console.error("Failures:");
      for (const f of failures) console.error(f);
    }

    expect(rate).toBeGreaterThanOrEqual(0.8);
  });
});
