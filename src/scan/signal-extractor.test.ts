import { describe, it, expect } from "vitest";
import type { AXNode } from "../cache/a11y-tree.js";
import {
  extractSignals,
  MAX_SIGNALS,
  ROLE_BASE_WEIGHT,
  ATTRIBUTE_BASE_WEIGHT,
  STRUCTURE_BASE_WEIGHT,
  NAME_PATTERN_BASE_WEIGHT,
  MIN_SIBLING_COUNT,
  INTERESTING_ROLES,
  INTERESTING_PROPERTIES,
  PROPERTY_VALUE_ALLOWLIST,
} from "./signal-extractor.js";

// ---------------------------------------------------------------------------
// Invariante 2 Patterns — duplicated from card-schema.ts (module boundary)
// ---------------------------------------------------------------------------

const URL_PATTERN = /https?:\/\//i;
const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;

// ---------------------------------------------------------------------------
// Fixture Helpers
// ---------------------------------------------------------------------------

let nodeIdCounter = 0;

function makeNode(overrides: Partial<AXNode> = {}): AXNode {
  nodeIdCounter++;
  return {
    nodeId: `node-${nodeIdCounter}`,
    ignored: false,
    ...overrides,
  };
}

function makeRole(role: string, extras: Partial<AXNode> = {}): AXNode {
  return makeNode({
    role: { type: "role", value: role },
    ...extras,
  });
}

function makeProperty(
  name: string,
  value: unknown,
): { name: string; value: { type: string; value: unknown } } {
  return {
    name,
    value: { type: typeof value === "boolean" ? "boolean" : "string", value },
  };
}

// ---------------------------------------------------------------------------
// Fixture: Login Form (~12 nodes)
// ---------------------------------------------------------------------------

function loginFormFixture(): AXNode[] {
  const formId = "form-1";
  const usernameId = "username-1";
  const passwordId = "password-1";
  const submitId = "submit-1";
  const labelUserId = "label-user-1";
  const labelPwdId = "label-pwd-1";

  return [
    // Root
    makeNode({
      nodeId: "root",
      role: { type: "role", value: "WebArea" },
      childIds: [formId],
    }),
    // Form
    makeNode({
      nodeId: formId,
      role: { type: "role", value: "form" },
      name: { type: "computedString", value: "Login" },
      parentId: "root",
      childIds: [labelUserId, usernameId, labelPwdId, passwordId, submitId],
    }),
    // Label: Username
    makeNode({
      nodeId: labelUserId,
      role: { type: "role", value: "LabelText" },
      name: { type: "computedString", value: "Username" },
      parentId: formId,
    }),
    // Username textbox
    makeNode({
      nodeId: usernameId,
      role: { type: "role", value: "textbox" },
      name: { type: "computedString", value: "Username" },
      parentId: formId,
      properties: [
        makeProperty("autocomplete", "username"),
      ],
    }),
    // Label: Password
    makeNode({
      nodeId: labelPwdId,
      role: { type: "role", value: "LabelText" },
      name: { type: "computedString", value: "Password" },
      parentId: formId,
    }),
    // Password textbox
    makeNode({
      nodeId: passwordId,
      role: { type: "role", value: "textbox" },
      name: { type: "computedString", value: "Password" },
      parentId: formId,
      properties: [
        makeProperty("autocomplete", "current-password"),
        makeProperty("type", "password"),
      ],
    }),
    // Submit button
    makeNode({
      nodeId: submitId,
      role: { type: "role", value: "button" },
      name: { type: "computedString", value: "Sign in" },
      parentId: formId,
      properties: [
        makeProperty("type", "submit"),
      ],
    }),
  ];
}

// ---------------------------------------------------------------------------
// Fixture: Search Result List (~15 nodes)
// ---------------------------------------------------------------------------

function searchResultFixture(): AXNode[] {
  const searchId = "search-1";
  const inputId = "input-1";
  const listId = "list-1";

  const items: AXNode[] = [];
  const itemIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = `item-${i}`;
    itemIds.push(id);
    items.push(
      makeNode({
        nodeId: id,
        role: { type: "role", value: "listitem" },
        name: { type: "computedString", value: `Result ${i + 1}` },
        parentId: listId,
      }),
    );
  }

  return [
    // Root
    makeNode({
      nodeId: "root-search",
      role: { type: "role", value: "WebArea" },
      childIds: [searchId, listId],
    }),
    // Search landmark
    makeNode({
      nodeId: searchId,
      role: { type: "role", value: "search" },
      name: { type: "computedString", value: "Search" },
      parentId: "root-search",
      childIds: [inputId],
    }),
    // Search input
    makeNode({
      nodeId: inputId,
      role: { type: "role", value: "textbox" },
      name: { type: "computedString", value: "Search query" },
      parentId: searchId,
      properties: [
        makeProperty("autocomplete", "off"),
      ],
    }),
    // List
    makeNode({
      nodeId: listId,
      role: { type: "role", value: "list" },
      parentId: "root-search",
      childIds: itemIds,
    }),
    // List items
    ...items,
  ];
}

// ---------------------------------------------------------------------------
// Fixture: Article Page (~10 nodes)
// ---------------------------------------------------------------------------

function articleFixture(): AXNode[] {
  const mainId = "main-1";
  const articleId = "article-1";
  const h1Id = "h1-1";

  return [
    makeNode({
      nodeId: "root-article",
      role: { type: "role", value: "WebArea" },
      childIds: [mainId],
    }),
    makeNode({
      nodeId: mainId,
      role: { type: "role", value: "main" },
      parentId: "root-article",
      childIds: [articleId],
    }),
    makeNode({
      nodeId: articleId,
      role: { type: "role", value: "article" },
      name: { type: "computedString", value: "Breaking News: Test Article" },
      parentId: mainId,
      childIds: [h1Id],
    }),
    makeNode({
      nodeId: h1Id,
      role: { type: "role", value: "heading" },
      name: { type: "computedString", value: "Breaking News" },
      parentId: articleId,
      properties: [makeProperty("level", 1)],
    }),
  ];
}

// ---------------------------------------------------------------------------
// Fixture: Large list for dedup testing (20 listitems)
// ---------------------------------------------------------------------------

function largeListFixture(): AXNode[] {
  const listId = "big-list";
  const items: AXNode[] = [];
  const itemIds: string[] = [];
  const count = 20;

  for (let i = 0; i < count; i++) {
    const id = `big-item-${i}`;
    itemIds.push(id);
    items.push(
      makeNode({
        nodeId: id,
        role: { type: "role", value: "listitem" },
        name: { type: "computedString", value: `Item ${i}` },
        parentId: listId,
      }),
    );
  }

  return [
    makeNode({
      nodeId: "root-biglist",
      role: { type: "role", value: "WebArea" },
      childIds: [listId],
    }),
    makeNode({
      nodeId: listId,
      role: { type: "role", value: "list" },
      parentId: "root-biglist",
      childIds: itemIds,
    }),
    ...items,
  ];
}

// ---------------------------------------------------------------------------
// Fixture: 100-node page for latency testing
// ---------------------------------------------------------------------------

function largePageFixture(): AXNode[] {
  const nodes: AXNode[] = [];
  const roles = ["button", "textbox", "heading", "link", "listitem", "cell"];
  const rootId = "root-large";

  nodes.push(
    makeNode({
      nodeId: rootId,
      role: { type: "role", value: "WebArea" },
      childIds: Array.from({ length: 100 }, (_, i) => `large-${i}`),
    }),
  );

  for (let i = 0; i < 100; i++) {
    const role = roles[i % roles.length];
    nodes.push(
      makeNode({
        nodeId: `large-${i}`,
        role: { type: "role", value: role },
        name: { type: "computedString", value: `Element ${i}` },
        parentId: rootId,
        properties: i % 3 === 0 ? [makeProperty("checked", true)] : undefined,
      }),
    );
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// AC-1: Structured Signal List from AXNodes
// ---------------------------------------------------------------------------

describe("extractSignals — AC-1: Structured Signal List", () => {
  it("returns typed Signal[] with required fields", () => {
    const result = extractSignals(loginFormFixture());
    expect(result.signals.length).toBeGreaterThan(0);
    for (const sig of result.signals) {
      expect(sig).toHaveProperty("type");
      expect(sig).toHaveProperty("signal");
      expect(sig).toHaveProperty("nodeId");
      expect(sig).toHaveProperty("weight");
      expect(typeof sig.type).toBe("string");
      expect(typeof sig.signal).toBe("string");
      expect(typeof sig.nodeId).toBe("string");
      expect(typeof sig.weight).toBe("number");
      expect(sig.weight).toBeGreaterThanOrEqual(0);
      expect(sig.weight).toBeLessThanOrEqual(1);
    }
  });

  it("returns metadata with nodeCount, extractionTimeMs, signalCount", () => {
    const fixture = loginFormFixture();
    const result = extractSignals(fixture);
    expect(result.metadata.nodeCount).toBe(fixture.length);
    expect(result.metadata.extractionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.signalCount).toBe(result.signals.length);
  });
});

// ---------------------------------------------------------------------------
// AC-2: Four Signal Categories
// ---------------------------------------------------------------------------

describe("extractSignals — AC-2: Four Signal Categories", () => {
  it("extracts role signals from login form", () => {
    const result = extractSignals(loginFormFixture());
    const roleSignals = result.signals.filter((s) => s.type === "role");
    expect(roleSignals.length).toBeGreaterThan(0);
    const signalNames = roleSignals.map((s) => s.signal);
    expect(signalNames).toContain("role:form");
    expect(signalNames).toContain("role:textbox");
    expect(signalNames).toContain("role:button");
  });

  it("extracts attribute signals (autocomplete)", () => {
    const result = extractSignals(loginFormFixture());
    const attrSignals = result.signals.filter((s) => s.type === "attribute");
    expect(attrSignals.length).toBeGreaterThan(0);
    const signalNames = attrSignals.map((s) => s.signal);
    expect(signalNames).toContain("autocomplete:username");
    expect(signalNames).toContain("autocomplete:current-password");
  });

  it("extracts structure signals (parent:form)", () => {
    const result = extractSignals(loginFormFixture());
    const structSignals = result.signals.filter((s) => s.type === "structure");
    expect(structSignals.length).toBeGreaterThan(0);
    const signalNames = structSignals.map((s) => s.signal);
    expect(signalNames).toContain("parent:form");
  });

  it("extracts name-pattern signals (has-name:true)", () => {
    const result = extractSignals(loginFormFixture());
    const nameSignals = result.signals.filter((s) => s.type === "name-pattern");
    expect(nameSignals.length).toBeGreaterThan(0);
    const signalNames = nameSignals.map((s) => s.signal);
    expect(signalNames).toContain("has-name:true");
  });

  it("extracts all four categories from a login form", () => {
    const result = extractSignals(loginFormFixture());
    const categories = new Set(result.signals.map((s) => s.type));
    expect(categories.has("role")).toBe(true);
    expect(categories.has("attribute")).toBe(true);
    expect(categories.has("structure")).toBe(true);
    expect(categories.has("name-pattern")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subtask 3.2: Login Form Fixture Signals
// ---------------------------------------------------------------------------

describe("extractSignals — Login Form", () => {
  it("contains role:form, autocomplete:username, type:password, type:submit, and role:button", () => {
    const result = extractSignals(loginFormFixture());
    const names = result.signals.map((s) => s.signal);
    expect(names).toContain("role:form");
    expect(names).toContain("autocomplete:username");
    expect(names).toContain("autocomplete:current-password");
    expect(names).toContain("type:password");
    expect(names).toContain("type:submit");
    expect(names).toContain("role:button");
  });
});

// ---------------------------------------------------------------------------
// Subtask 3.3: Search Result Fixture Signals
// ---------------------------------------------------------------------------

describe("extractSignals — Search Result List", () => {
  it("contains role:search, role:list, and siblings:listitem signal", () => {
    const result = extractSignals(searchResultFixture());
    const names = result.signals.map((s) => s.signal);
    expect(names).toContain("role:search");
    expect(names).toContain("role:list");
    // 5 listitems under same parent -> siblings signal
    const siblingsSignal = result.signals.find((s) =>
      s.signal.startsWith("siblings:listitem:"),
    );
    expect(siblingsSignal).toBeDefined();
    const count = parseInt(siblingsSignal!.signal.split(":")[2], 10);
    expect(count).toBeGreaterThanOrEqual(MIN_SIBLING_COUNT);
  });
});

// ---------------------------------------------------------------------------
// Subtask 3.4: Empty Input
// ---------------------------------------------------------------------------

describe("extractSignals — Empty Input", () => {
  it("returns empty signal list and zero metadata for empty array", () => {
    const result = extractSignals([]);
    expect(result.signals).toEqual([]);
    expect(result.metadata.nodeCount).toBe(0);
    expect(result.metadata.extractionTimeMs).toBe(0);
    expect(result.metadata.signalCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Subtask 3.5: Negative — No URLs or Domains (Invariante 2)
// ---------------------------------------------------------------------------

describe("extractSignals — Invariante 2: No URLs or Domains", () => {
  it("no signal contains a URL", () => {
    const fixtures = [
      loginFormFixture(),
      searchResultFixture(),
      articleFixture(),
      largeListFixture(),
    ];
    for (const fixture of fixtures) {
      const result = extractSignals(fixture);
      for (const sig of result.signals) {
        expect(URL_PATTERN.test(sig.signal)).toBe(false);
      }
    }
  });

  it("no signal contains a domain name", () => {
    const fixtures = [
      loginFormFixture(),
      searchResultFixture(),
      articleFixture(),
      largeListFixture(),
    ];
    for (const fixture of fixtures) {
      const result = extractSignals(fixture);
      for (const sig of result.signals) {
        expect(DOMAIN_PATTERN.test(sig.signal)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Subtask 3.5b: Adversarial — URL/Domain Leakage via Attribute Values (M1)
// ---------------------------------------------------------------------------

describe("extractSignals — Invariante 2: Adversarial URL/Domain Leakage", () => {
  it("filters out URL in autocomplete value", () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "url-leak-1",
        role: { type: "role", value: "textbox" },
        properties: [
          makeProperty("autocomplete", "https://evil.com/login"),
        ],
      }),
    ];
    const result = extractSignals(nodes);
    const attrSignals = result.signals.filter((s) => s.type === "attribute");
    for (const sig of attrSignals) {
      expect(URL_PATTERN.test(sig.signal)).toBe(false);
    }
  });

  it("filters out domain in autocomplete value", () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "domain-leak-1",
        role: { type: "role", value: "textbox" },
        properties: [
          makeProperty("autocomplete", "evil.com/login"),
        ],
      }),
    ];
    const result = extractSignals(nodes);
    const attrSignals = result.signals.filter((s) => s.type === "attribute");
    for (const sig of attrSignals) {
      expect(DOMAIN_PATTERN.test(sig.signal)).toBe(false);
    }
  });

  it("filters out arbitrary string in hasPopup value", () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "arbitrary-leak-1",
        role: { type: "role", value: "button" },
        properties: [
          makeProperty("hasPopup", "https://phishing.example.com"),
        ],
      }),
    ];
    const result = extractSignals(nodes);
    const attrSignals = result.signals.filter((s) => s.type === "attribute");
    // Should not contain the URL — either filtered or not emitted
    for (const sig of attrSignals) {
      expect(sig.signal).not.toContain("https://");
    }
  });

  it("filters out unknown type values (content strings)", () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "content-type-leak",
        role: { type: "role", value: "textbox" },
        properties: [
          makeProperty("type", "My Secret Username"),
        ],
      }),
    ];
    const result = extractSignals(nodes);
    const typeSignals = result.signals.filter((s) => s.signal.startsWith("type:"));
    expect(typeSignals).toHaveLength(0);
  });

  it("allows known structural autocomplete values", () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "good-autocomplete",
        role: { type: "role", value: "textbox" },
        properties: [
          makeProperty("autocomplete", "username"),
          makeProperty("autocomplete", "current-password"),
        ],
      }),
    ];
    const result = extractSignals(nodes);
    const attrSignals = result.signals.filter((s) => s.type === "attribute");
    const signalNames = attrSignals.map((s) => s.signal);
    expect(signalNames).toContain("autocomplete:username");
    expect(signalNames).toContain("autocomplete:current-password");
  });

  it("allows known type values (password, submit, email)", () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "good-type-1",
        role: { type: "role", value: "textbox" },
        properties: [makeProperty("type", "password")],
      }),
      makeNode({
        nodeId: "good-type-2",
        role: { type: "role", value: "button" },
        properties: [makeProperty("type", "submit")],
      }),
      makeNode({
        nodeId: "good-type-3",
        role: { type: "role", value: "textbox" },
        properties: [makeProperty("type", "email")],
      }),
    ];
    const result = extractSignals(nodes);
    const typeSignals = result.signals.filter((s) => s.signal.startsWith("type:"));
    const typeValues = typeSignals.map((s) => s.signal);
    expect(typeValues).toContain("type:password");
    expect(typeValues).toContain("type:submit");
    expect(typeValues).toContain("type:email");
  });

  it("PROPERTY_VALUE_ALLOWLIST covers all properties with string values", () => {
    // Ensure the allowlist is configured for string-valued properties
    expect(PROPERTY_VALUE_ALLOWLIST.has("type")).toBe(true);
    expect(PROPERTY_VALUE_ALLOWLIST.has("autocomplete")).toBe(true);
    expect(PROPERTY_VALUE_ALLOWLIST.has("hasPopup")).toBe(true);
    expect(PROPERTY_VALUE_ALLOWLIST.has("inputMode")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subtask 3.6: Negative — No Content Strings in Signals
// ---------------------------------------------------------------------------

describe("extractSignals — Invariante 2: No Content Strings", () => {
  it("no signal contains literal name.value text", () => {
    const fixture = loginFormFixture();
    // Collect all name values from the fixture
    const nameValues = fixture
      .map((n) => n.name?.value)
      .filter((v): v is string => typeof v === "string" && v.length > 0);

    const result = extractSignals(fixture);
    for (const sig of result.signals) {
      for (const nameVal of nameValues) {
        // The signal string must not be or contain the literal name value
        // (allowed: "has-name:true"; not allowed: "Username", "Password", "Sign in")
        expect(sig.signal).not.toBe(nameVal as string);
        expect(sig.signal).not.toContain(nameVal as string);
      }
    }
  });

  it("name-pattern signals only contain has-name:true, never text", () => {
    const result = extractSignals(loginFormFixture());
    const nameSignals = result.signals.filter((s) => s.type === "name-pattern");
    for (const sig of nameSignals) {
      expect(sig.signal).toBe("has-name:true");
    }
  });
});

// ---------------------------------------------------------------------------
// Subtask 3.7: Latency Gate < 150 ms (AC-3)
// ---------------------------------------------------------------------------

describe("extractSignals — AC-3: Latency Gate", () => {
  it("processes 100-node fixture in under 150 ms", () => {
    const fixture = largePageFixture();
    expect(fixture.length).toBeGreaterThanOrEqual(100);

    const t0 = performance.now();
    extractSignals(fixture);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(150);
  });
});

// ---------------------------------------------------------------------------
// Subtask 3.8: Token Budget < 800 tokens (AC-4)
// ---------------------------------------------------------------------------

describe("extractSignals — AC-4: Token Budget", () => {
  it("serialized signal list is under 3200 chars (~800 tokens) for login fixture", () => {
    // Login form with ~50 nodes (augmented fixture)
    const base = loginFormFixture();
    // Extend to ~50 nodes with generic elements
    const extra: AXNode[] = [];
    for (let i = 0; i < 43; i++) {
      extra.push(
        makeNode({
          nodeId: `extra-${i}`,
          role: { type: "role", value: i % 2 === 0 ? "link" : "heading" },
          name: { type: "computedString", value: `Nav item ${i}` },
          parentId: "root",
        }),
      );
    }
    const fixture = [...base, ...extra];
    expect(fixture.length).toBeGreaterThanOrEqual(50);

    const result = extractSignals(fixture);
    const serialized = JSON.stringify(result.signals);
    expect(serialized.length).toBeLessThan(3200);
  });
});

// ---------------------------------------------------------------------------
// Subtask 3.9: Deduplication
// ---------------------------------------------------------------------------

describe("extractSignals — Deduplication", () => {
  it("deduplicates 20 role:listitem nodes into a single signal with count", () => {
    const result = extractSignals(largeListFixture());
    const listitemSignals = result.signals.filter(
      (s) => s.signal === "role:listitem",
    );
    expect(listitemSignals).toHaveLength(1);
    expect(listitemSignals[0].count).toBe(20);
  });

  it("boosted weight for repeated signals is higher than base weight", () => {
    const result = extractSignals(largeListFixture());
    const listitemSignal = result.signals.find(
      (s) => s.signal === "role:listitem",
    );
    expect(listitemSignal).toBeDefined();
    expect(listitemSignal!.weight).toBeGreaterThan(ROLE_BASE_WEIGHT);
  });

  it("weight never exceeds 1 even with many repetitions", () => {
    const result = extractSignals(largeListFixture());
    for (const sig of result.signals) {
      expect(sig.weight).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5: Named Constants — No Magic Numbers
// ---------------------------------------------------------------------------

describe("extractSignals — AC-5: Named Constants", () => {
  it("MAX_SIGNALS is a positive number", () => {
    expect(MAX_SIGNALS).toBeGreaterThan(0);
  });

  it("all base weights are between 0 and 1", () => {
    expect(ROLE_BASE_WEIGHT).toBeGreaterThan(0);
    expect(ROLE_BASE_WEIGHT).toBeLessThanOrEqual(1);
    expect(ATTRIBUTE_BASE_WEIGHT).toBeGreaterThan(0);
    expect(ATTRIBUTE_BASE_WEIGHT).toBeLessThanOrEqual(1);
    expect(STRUCTURE_BASE_WEIGHT).toBeGreaterThan(0);
    expect(STRUCTURE_BASE_WEIGHT).toBeLessThanOrEqual(1);
    expect(NAME_PATTERN_BASE_WEIGHT).toBeGreaterThan(0);
    expect(NAME_PATTERN_BASE_WEIGHT).toBeLessThanOrEqual(1);
  });

  it("INTERESTING_ROLES is a non-empty Set", () => {
    expect(INTERESTING_ROLES.size).toBeGreaterThan(0);
  });

  it("INTERESTING_PROPERTIES is a non-empty Set", () => {
    expect(INTERESTING_PROPERTIES.size).toBeGreaterThan(0);
  });

  it("MIN_SIBLING_COUNT is a positive integer", () => {
    expect(MIN_SIBLING_COUNT).toBeGreaterThan(0);
    expect(Number.isInteger(MIN_SIBLING_COUNT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe("extractSignals — Edge Cases", () => {
  it("skips ignored nodes", () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "ignored-1",
        ignored: true,
        role: { type: "role", value: "form" },
      }),
    ];
    const result = extractSignals(nodes);
    expect(result.signals.find((s) => s.signal === "role:form")).toBeUndefined();
  });

  it("skips nodes without role field", () => {
    const nodes: AXNode[] = [makeNode({ nodeId: "no-role" })];
    const result = extractSignals(nodes);
    const roleSignals = result.signals.filter((s) => s.type === "role");
    expect(roleSignals).toHaveLength(0);
  });

  it("skips non-interesting roles (e.g. generic, WebArea)", () => {
    const nodes: AXNode[] = [
      makeRole("generic"),
      makeRole("WebArea"),
      makeRole("paragraph"),
    ];
    const result = extractSignals(nodes);
    const roleSignals = result.signals.filter((s) => s.type === "role");
    expect(roleSignals).toHaveLength(0);
  });

  it("skips attribute signals with false/empty values", () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "false-prop",
        role: { type: "role", value: "textbox" },
        properties: [
          makeProperty("checked", false),
          makeProperty("disabled", false),
          makeProperty("autocomplete", ""),
        ],
      }),
    ];
    const result = extractSignals(nodes);
    const attrSignals = result.signals.filter((s) => s.type === "attribute");
    expect(attrSignals).toHaveLength(0);
  });

  it("handles nodes with empty name string (no name-pattern signal)", () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "empty-name",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "" },
      }),
    ];
    const result = extractSignals(nodes);
    const nameSignals = result.signals.filter((s) => s.type === "name-pattern");
    expect(nameSignals).toHaveLength(0);
  });

  it("caps signals at MAX_SIGNALS when exceeded", () => {
    // Generate many distinct signals using allowlisted values
    const nodes: AXNode[] = [];
    const roles = Array.from(INTERESTING_ROLES);
    const acValues = ["username", "email", "tel", "name", "given-name", "family-name"];
    const typeValues = ["password", "submit", "email", "text", "search", "tel"];
    for (let i = 0; i < 200; i++) {
      const role = roles[i % roles.length];
      nodes.push(
        makeNode({
          nodeId: `cap-${i}`,
          role: { type: "role", value: role },
          name: { type: "computedString", value: `Label ${i}` },
          properties: [
            makeProperty("autocomplete", acValues[i % acValues.length]),
            makeProperty("type", typeValues[i % typeValues.length]),
            makeProperty("checked", true),
            makeProperty("expanded", true),
          ],
          parentId: i > 0 ? `cap-${i - 1}` : undefined,
        }),
      );
    }
    const result = extractSignals(nodes);
    expect(result.signals.length).toBeLessThanOrEqual(MAX_SIGNALS);
  });

  it("signals are sorted by weight descending", () => {
    const result = extractSignals(loginFormFixture());
    for (let i = 1; i < result.signals.length; i++) {
      expect(result.signals[i - 1].weight).toBeGreaterThanOrEqual(
        result.signals[i].weight,
      );
    }
  });

  it("article fixture produces role:article, role:main, role:heading", () => {
    const result = extractSignals(articleFixture());
    const names = result.signals.map((s) => s.signal);
    expect(names).toContain("role:article");
    expect(names).toContain("role:main");
    expect(names).toContain("role:heading");
  });
});

// ---------------------------------------------------------------------------
// Signal Format Convention (prefix:value)
// ---------------------------------------------------------------------------

describe("extractSignals — Signal Format Convention", () => {
  it("all signals use prefix:value format", () => {
    const result = extractSignals(loginFormFixture());
    for (const sig of result.signals) {
      expect(sig.signal).toMatch(/^[a-z-]+:[a-zA-Z0-9_:-]+$/);
    }
  });

  it("role signals use role: prefix", () => {
    const result = extractSignals(loginFormFixture());
    const roleSignals = result.signals.filter((s) => s.type === "role");
    for (const sig of roleSignals) {
      expect(sig.signal).toMatch(/^role:/);
    }
  });

  it("structure signals use parent: or siblings: prefix", () => {
    const result = extractSignals(searchResultFixture());
    const structSignals = result.signals.filter((s) => s.type === "structure");
    for (const sig of structSignals) {
      expect(sig.signal).toMatch(/^(parent:|siblings:)/);
    }
  });
});
