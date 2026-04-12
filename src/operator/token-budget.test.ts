import { describe, it, expect } from "vitest";
import type { AXNode } from "../cache/a11y-tree.js";
import type { MatchResult } from "../scan/match-types.js";
import {
  buildOfferReturn,
  buildResultReturn,
  MAX_OFFER_TOKENS,
  MAX_RESULT_TOKENS,
} from "./return-builder.js";
import type { AnnotatedMatch, PageContext, CardInfo } from "./return-builder.js";
import { serializeOfferReturn, serializeResultReturn } from "./return-serializer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Fixture Helpers
// ---------------------------------------------------------------------------

function makeAXNode(overrides: Partial<AXNode>): AXNode {
  return { nodeId: "n-1", ignored: false, ...overrides };
}

function makePageContext(): PageContext {
  return { title: "MCP Test Benchmark", url: "http://localhost:4242" };
}

function makeLoginCardInfo(): CardInfo {
  return {
    id: "login-form",
    name: "Login Form",
    description: "Fills credentials and submits the form",
    parameters: {
      username: { type: "string", description: "Username or email address for login", required: true },
      password: { type: "string", description: "Password for login", required: true },
    },
  };
}

function makeMatchResult(cardId: string, cardName: string): MatchResult {
  return {
    cardId,
    cardName,
    matched: true,
    score: 0.85,
    threshold: 0.5,
    signal_breakdown: [
      { signal: "role:form", weight: 0.6, matched: true, found_count: 1 },
      { signal: "type:password", weight: 0.9, matched: true, found_count: 1 },
      { signal: "type:submit", weight: 0.5, matched: true, found_count: 1 },
    ],
    counter_signal_checks: [
      { signal: "role:search", level: "strong", found: false, action_taken: "clear" },
    ],
    schema_version: "1.0",
    source: "a11y-tree",
  };
}

/**
 * Login form fixture — mimics a typical login page.
 */
function makeLoginFormFixture(): { nodes: AXNode[]; matches: AnnotatedMatch[] } {
  const nodes: AXNode[] = [
    makeAXNode({
      nodeId: "n-root", role: { type: "role", value: "WebArea" },
      name: { type: "string", value: "Login" },
      childIds: ["n-main"],
    }),
    makeAXNode({
      nodeId: "n-main", role: { type: "role", value: "main" },
      parentId: "n-root", childIds: ["n-heading", "n-form"],
    }),
    makeAXNode({
      nodeId: "n-heading", role: { type: "role", value: "heading" },
      name: { type: "string", value: "Sign In" },
      parentId: "n-main",
    }),
    makeAXNode({
      nodeId: "n-form", role: { type: "role", value: "form" },
      name: { type: "string", value: "Login Form" },
      parentId: "n-main", childIds: ["n-user", "n-pass", "n-btn"],
    }),
    makeAXNode({
      nodeId: "n-user", role: { type: "role", value: "textbox" },
      name: { type: "string", value: "Username" },
      parentId: "n-form",
    }),
    makeAXNode({
      nodeId: "n-pass", role: { type: "role", value: "textbox" },
      name: { type: "string", value: "Password" },
      parentId: "n-form",
    }),
    makeAXNode({
      nodeId: "n-btn", role: { type: "role", value: "button" },
      name: { type: "string", value: "Sign In" },
      parentId: "n-form",
    }),
  ];

  const matches: AnnotatedMatch[] = [
    {
      matchResult: makeMatchResult("login-form", "Login Form"),
      cardInfo: makeLoginCardInfo(),
      cluster: { nodeIds: ["n-form"], signals: [], dominantTypes: ["role"] },
    },
  ];

  return { nodes, matches };
}

/**
 * T2.3 Multi-Step Wizard fixture — mimics the benchmark wizard page.
 */
function makeWizardFixture(): { nodes: AXNode[]; matches: AnnotatedMatch[] } {
  const nodes: AXNode[] = [
    makeAXNode({
      nodeId: "w-root", role: { type: "role", value: "WebArea" },
      name: { type: "string", value: "MCP Test Benchmark" },
      childIds: ["w-main"],
    }),
    makeAXNode({
      nodeId: "w-main", role: { type: "role", value: "main" },
      parentId: "w-root", childIds: ["w-heading", "w-form", "w-nav"],
    }),
    makeAXNode({
      nodeId: "w-heading", role: { type: "role", value: "heading" },
      name: { type: "string", value: "T2.3 Multi-Step Wizard" },
      parentId: "w-main",
    }),
    makeAXNode({
      nodeId: "w-form", role: { type: "role", value: "form" },
      name: { type: "string", value: "Wizard Form" },
      parentId: "w-main",
      childIds: ["w-radio1", "w-radio2", "w-radio3", "w-next"],
    }),
    makeAXNode({
      nodeId: "w-radio1", role: { type: "role", value: "radio" },
      name: { type: "string", value: "Starter" },
      parentId: "w-form",
    }),
    makeAXNode({
      nodeId: "w-radio2", role: { type: "role", value: "radio" },
      name: { type: "string", value: "Pro" },
      parentId: "w-form",
    }),
    makeAXNode({
      nodeId: "w-radio3", role: { type: "role", value: "radio" },
      name: { type: "string", value: "Enterprise" },
      parentId: "w-form",
    }),
    makeAXNode({
      nodeId: "w-next", role: { type: "role", value: "button" },
      name: { type: "string", value: "Next" },
      parentId: "w-form",
    }),
    makeAXNode({
      nodeId: "w-nav", role: { type: "role", value: "navigation" },
      name: { type: "string", value: "Step Navigation" },
      parentId: "w-main",
      childIds: ["w-tab1", "w-tab2", "w-tab3"],
    }),
    makeAXNode({
      nodeId: "w-tab1", role: { type: "role", value: "tab" },
      name: { type: "string", value: "Step 1" },
      parentId: "w-nav",
    }),
    makeAXNode({
      nodeId: "w-tab2", role: { type: "role", value: "tab" },
      name: { type: "string", value: "Step 2" },
      parentId: "w-nav",
    }),
    makeAXNode({
      nodeId: "w-tab3", role: { type: "role", value: "tab" },
      name: { type: "string", value: "Step 3" },
      parentId: "w-nav",
    }),
    // Hidden sections (Step 2 and 3)
    makeAXNode({
      nodeId: "w-hidden-step2", ignored: true,
      role: { type: "role", value: "region" },
      name: { type: "string", value: "Step 2 — Company Info" },
      parentId: "w-root",
    }),
    makeAXNode({
      nodeId: "w-hidden-step3", ignored: true,
      role: { type: "role", value: "region" },
      name: { type: "string", value: "Step 3 — Complete Setup" },
      parentId: "w-root",
    }),
  ];

  const wizardCardInfo: CardInfo = {
    id: "wizard",
    name: "Multi-Step Wizard",
    description: "Completes a multi-step wizard form with plan selection and company info",
    parameters: {
      plan_choice: { type: "string", description: "Plan to select (Starter/Pro/Enterprise)", required: true },
      company_name: { type: "string", description: "Company name to fill in step 2", required: true },
    },
  };

  const matches: AnnotatedMatch[] = [
    {
      matchResult: makeMatchResult("wizard", "Multi-Step Wizard"),
      cardInfo: wizardCardInfo,
      cluster: { nodeIds: ["w-form"], signals: [], dominantTypes: ["role"] },
    },
  ];

  return { nodes, matches };
}

// ---------------------------------------------------------------------------
// Task 8 — Token Budget Tests
// ---------------------------------------------------------------------------

describe("token-budget", () => {
  // Subtask 8.1: Login form offer < 2500 tokens
  it("serializeOfferReturn for login form fixture < 2500 tokens", () => {
    const { nodes, matches } = makeLoginFormFixture();
    const offer = buildOfferReturn(makePageContext(), matches, nodes);
    const text = serializeOfferReturn(offer);

    const estimatedTokens = text.length / CHARS_PER_TOKEN;
    expect(estimatedTokens).toBeLessThan(MAX_OFFER_TOKENS);
  });

  // Subtask 8.2: Wizard offer < 2500 tokens
  it("serializeOfferReturn for T2.3 wizard fixture < 2500 tokens", () => {
    const { nodes, matches } = makeWizardFixture();
    const offer = buildOfferReturn(makePageContext(), matches, nodes);
    const text = serializeOfferReturn(offer);

    const estimatedTokens = text.length / CHARS_PER_TOKEN;
    expect(estimatedTokens).toBeLessThan(MAX_OFFER_TOKENS);
  });

  // Subtask 8.3: Result payload < 800 tokens
  it("serializeResultReturn for successful result < 800 tokens", () => {
    const { nodes } = makeLoginFormFixture();
    const result = buildResultReturn(
      "Login Form",
      { username: "testuser@example.com", password: "s3cureP@ssw0rd!" },
      3,
      3,
      makePageContext(),
      nodes,
    );
    const text = serializeResultReturn(result);

    const estimatedTokens = text.length / CHARS_PER_TOKEN;
    expect(estimatedTokens).toBeLessThan(MAX_RESULT_TOKENS);
  });

  // Subtask 8.4: Serializer truncates automatically when tree too large
  it("serializeOfferReturn truncates when payload exceeds budget", () => {
    // Create many nodes to generate a large tree
    const nodes: AXNode[] = [
      makeAXNode({
        nodeId: "big-root",
        role: { type: "role", value: "WebArea" },
        name: { type: "string", value: "Big Page" },
        childIds: ["big-main"],
      }),
      makeAXNode({
        nodeId: "big-main",
        role: { type: "role", value: "main" },
        parentId: "big-root",
        childIds: Array.from({ length: 50 }, (_, i) => `big-form-${i}`),
      }),
    ];

    // Add 50 form groups, each with card annotations
    const matches: AnnotatedMatch[] = [];
    for (let i = 0; i < 50; i++) {
      const formId = `big-form-${i}`;
      nodes.push(
        makeAXNode({
          nodeId: formId,
          role: { type: "role", value: "form" },
          name: { type: "string", value: `Form ${i} with a fairly long name to pad tokens` },
          parentId: "big-main",
          childIds: [`big-btn-${i}`],
        }),
        makeAXNode({
          nodeId: `big-btn-${i}`,
          role: { type: "role", value: "button" },
          name: { type: "string", value: `Submit Form ${i}` },
          parentId: formId,
        }),
      );

      matches.push({
        matchResult: makeMatchResult(`card-${i}`, `Card ${i} with description`),
        cardInfo: {
          id: `card-${i}`,
          name: `Card ${i} with description`,
          description: `Does something for form ${i} with plenty of detail text`,
          parameters: {
            field_a: { type: "string", description: "First field for the form", required: true },
            field_b: { type: "string", description: "Second field for the form", required: false },
          },
        },
        cluster: { nodeIds: [formId], signals: [], dominantTypes: ["role"] },
      });
    }

    const offer = buildOfferReturn(makePageContext(), matches, nodes);
    const text = serializeOfferReturn(offer);

    // Even with 50 cards, the serializer should stay within budget
    // (via truncation of match/params lines)
    const estimatedTokens = text.length / CHARS_PER_TOKEN;
    expect(estimatedTokens).toBeLessThan(MAX_OFFER_TOKENS);
  });

  // Additional: verify that normal payloads are significantly under budget
  it("login form offer uses less than 50% of token budget", () => {
    const { nodes, matches } = makeLoginFormFixture();
    const offer = buildOfferReturn(makePageContext(), matches, nodes);
    const text = serializeOfferReturn(offer);

    const estimatedTokens = text.length / CHARS_PER_TOKEN;
    // A single-card login form should be well under half the budget
    expect(estimatedTokens).toBeLessThan(MAX_OFFER_TOKENS * 0.5);
  });

  // M1 fix: hard cap test with extremely long card names/descriptions
  it("offer hard cap enforced even with extreme card name/description lengths", () => {
    const longName = "A".repeat(500);
    const longDesc = "B".repeat(500);
    const longWhy = "C".repeat(1500);
    const nodes: AXNode[] = [
      makeAXNode({
        nodeId: "x-root",
        role: { type: "role", value: "WebArea" },
        name: { type: "string", value: "Extreme" },
        childIds: ["x-main"],
      }),
      makeAXNode({
        nodeId: "x-main",
        role: { type: "role", value: "main" },
        parentId: "x-root",
        childIds: Array.from({ length: 30 }, (_, i) => `x-form-${i}`),
      }),
    ];

    const matches: AnnotatedMatch[] = [];
    for (let i = 0; i < 30; i++) {
      const formId = `x-form-${i}`;
      nodes.push(
        makeAXNode({
          nodeId: formId,
          role: { type: "role", value: "form" },
          name: { type: "string", value: `${longName}-${i}` },
          parentId: "x-main",
          childIds: [`x-btn-${i}`],
        }),
        makeAXNode({
          nodeId: `x-btn-${i}`,
          role: { type: "role", value: "button" },
          name: { type: "string", value: `Submit ${longName}-${i}` },
          parentId: formId,
        }),
      );
      matches.push({
        matchResult: makeMatchResult(`card-${i}`, `${longName}-${i}`),
        cardInfo: {
          id: `card-${i}`,
          name: `${longName}-${i}`,
          description: `${longDesc}-${i}`,
          parameters: {
            long_field: { type: "string", description: "D".repeat(200), required: true },
          },
        },
        cluster: { nodeIds: [formId], signals: [], dominantTypes: ["role"] },
      });
    }

    const offer = buildOfferReturn(makePageContext(), matches, nodes);
    const text = serializeOfferReturn(offer);

    // Hard cap: must be within budget even with extreme inputs
    expect(text.length).toBeLessThanOrEqual(MAX_OFFER_TOKENS * CHARS_PER_TOKEN);
  });

  // M1 fix: result hard cap with extreme execution_summary and error
  it("result hard cap enforced with extremely long error and summary", () => {
    const { nodes } = makeLoginFormFixture();
    const longError = "E".repeat(2000);
    const result = buildResultReturn(
      "Card-" + "X".repeat(500),
      { field: "V".repeat(500) },
      1,
      5,
      makePageContext(),
      nodes,
      longError,
    );
    const text = serializeResultReturn(result);

    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_TOKENS * CHARS_PER_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Task 5 — Tool-Definition-Overhead < 3000 Tokens (AC-1, NFR1)
// ---------------------------------------------------------------------------

import { vi } from "vitest";
import { ToolRegistry } from "../registry.js";

describe("tool-definition-overhead", () => {
  /**
   * C2 fix: Measure the REAL tools/list response from the registry,
   * not hardcoded strings. This test instantiates ToolRegistry in
   * standard mode (no FULL_TOOLS), captures server.tool() calls,
   * and measures the actual descriptions + schema JSON.
   */
  it("tool-definition overhead for standard mode (real registry) is under 3000 tokens", () => {
    // Ensure standard mode (not FULL_TOOLS)
    delete process.env.SILBERCUE_CHROME_FULL_TOOLS;

    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;
    const mockCdpClient = {} as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    // server.tool() is called with: (name, description, zodShape, handler)
    let totalChars = 0;
    const registeredNames: string[] = [];

    for (const call of toolFn.mock.calls) {
      const name = call[0] as string;
      const description = call[1] as string;
      const zodShape = call[2] as Record<string, unknown>;

      registeredNames.push(name);

      // Accumulate: name + description + JSON-serialized schema
      totalChars += name.length;
      totalChars += description.length;
      totalChars += JSON.stringify(zodShape).length;
    }

    // Standard mode should have exactly 2 tools
    expect(registeredNames).toEqual(["virtual_desk", "operator"]);

    const estimatedTokens = totalChars / CHARS_PER_TOKEN;
    expect(estimatedTokens).toBeLessThan(3000);
  });
});
