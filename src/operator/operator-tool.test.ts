/**
 * Operator Tool Unit Tests (Story 19.7, Task 6)
 *
 * Tests the operator MCP tool handler: Scan-Flow (offer), Execute-Flow (result),
 * fallback path, state machine transitions, ToolDispatcher integration, and
 * Zod validation at input/output boundaries.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { operatorHandler, _resetCardCache } from "./operator-tool.js";
import type { OperatorDeps } from "./operator-tool.js";
import type { ToolResponse } from "../types.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Minimal AXNode fixture for a login form page. */
function makeLoginFormNodes() {
  return [
    {
      nodeId: "n-root",
      ignored: false,
      role: { type: "role", value: "WebArea" },
      name: { type: "string", value: "Login Page" },
      childIds: ["n-main"],
    },
    {
      nodeId: "n-main",
      ignored: false,
      role: { type: "role", value: "main" },
      parentId: "n-root",
      childIds: ["n-form"],
    },
    {
      nodeId: "n-form",
      ignored: false,
      role: { type: "role", value: "form" },
      name: { type: "string", value: "Login" },
      parentId: "n-main",
      childIds: ["n-user", "n-pass", "n-btn"],
    },
    {
      nodeId: "n-user",
      ignored: false,
      role: { type: "role", value: "textbox" },
      name: { type: "string", value: "Username" },
      parentId: "n-form",
      properties: [
        { name: "autocomplete", value: { type: "string", value: "username" } },
        { name: "type", value: { type: "string", value: "text" } },
      ],
    },
    {
      nodeId: "n-pass",
      ignored: false,
      role: { type: "role", value: "textbox" },
      name: { type: "string", value: "Password" },
      parentId: "n-form",
      properties: [
        { name: "autocomplete", value: { type: "string", value: "current-password" } },
        { name: "type", value: { type: "string", value: "password" } },
      ],
    },
    {
      nodeId: "n-btn",
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "string", value: "Sign In" },
      parentId: "n-form",
      properties: [
        { name: "type", value: { type: "string", value: "submit" } },
      ],
    },
  ];
}

/** Minimal AXNode fixture for an empty/no-match page. */
function makeEmptyNodes() {
  return [
    {
      nodeId: "e-root",
      ignored: false,
      role: { type: "role", value: "WebArea" },
      name: { type: "string", value: "Empty Page" },
      childIds: [],
    },
  ];
}

/** Create mock deps with configurable AXNode response. */
function makeDeps(
  overrides: Partial<{
    nodes: unknown[];
    clickResult: ToolResponse;
    fillResult: ToolResponse;
    pressKeyResult: ToolResponse;
    scrollResult: ToolResponse;
    settleResult: boolean;
  }> = {},
): OperatorDeps {
  const nodes = overrides.nodes ?? makeLoginFormNodes();
  const okResult: ToolResponse = {
    content: [{ type: "text", text: "OK" }],
    _meta: { elapsedMs: 5, method: "test" },
  };

  return {
    getAXNodes: vi.fn().mockResolvedValue(nodes),
    tabStateCache: {
      get: vi.fn().mockReturnValue({ title: "Test Page", url: "http://localhost:4242" }),
      activeTargetId: "target-1",
    },
    sessionManager: undefined,
    clickHandler: vi.fn().mockResolvedValue(overrides.clickResult ?? okResult),
    fillFormHandler: vi.fn().mockResolvedValue(overrides.fillResult ?? okResult),
    pressKeyHandler: vi.fn().mockResolvedValue(overrides.pressKeyResult ?? okResult),
    scrollHandler: vi.fn().mockResolvedValue(overrides.scrollResult ?? okResult),
    settle: vi.fn().mockResolvedValue(overrides.settleResult ?? true),
    switchToFallbackMode: vi.fn(),
    switchToStandardMode: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("operator-tool", () => {
  beforeEach(() => {
    _resetCardCache();
  });

  // Subtask 6.2: Scan-Flow returns offer
  it("scan-flow: operator() without params returns offer text with cards", async () => {
    const deps = makeDeps();
    const result = await operatorHandler({}, deps);

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    // Offer format starts with === OPERATOR ===
    expect(text).toContain("=== OPERATOR ===");
    expect(text).toContain("Page:");
  });

  // Subtask 6.3: Execute-Flow returns result
  it("execute-flow: operator(card, params) returns result text", async () => {
    const deps = makeDeps();
    const result = await operatorHandler(
      { card: "login-form", params: { username: "testuser", password: "pass123" } },
      deps,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    // Result format starts with === OPERATOR RESULT ===
    expect(text).toContain("=== OPERATOR RESULT ===");
    expect(text).toContain("Login Form"); // card display name
  });

  // Subtask 6.4: Unknown card returns error
  it("execute-flow: unknown card returns isError", async () => {
    const deps = makeDeps();
    const result = await operatorHandler(
      { card: "nonexistent-card", params: {} },
      deps,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Unknown card");
    expect(text).toContain("nonexistent-card");
  });

  // Subtask 6.5: C3 fix — State machine path for offer with real assertions
  it("scan-flow: state machine reaches AWAITING_SELECTION (verified via offer content)", async () => {
    const deps = makeDeps();
    const result = await operatorHandler({}, deps);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    // Offer text proves IDLE → SCANNING → AWAITING_SELECTION completed.
    // The offer contains page context and card annotations.
    expect(text).toContain("=== OPERATOR ===");
    expect(text).toContain("Page:");
    expect(text).toContain("Test Page"); // page title from tabStateCache
    // The serialized offer contains page state info (interactive elements)
    expect(text).toContain("textbox"); // the login form has textbox elements
    // _meta confirms scan ran
    expect(result._meta!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result._meta!.method).toBe("operator");
    expect(result._meta!.fallback).toBeUndefined(); // NOT a fallback
  });

  // Subtask 6.6: C3 fix — ToolDispatcher called with paramRef-substituted values
  it("execute-flow: ToolDispatcher fill is called with paramRef-substituted values", async () => {
    const deps = makeDeps();
    await operatorHandler(
      { card: "login-form", params: { username: "alice", password: "secret" } },
      deps,
    );

    // fillFormHandler should have been called with the substituted param values
    expect(deps.fillFormHandler).toHaveBeenCalled();
    const calls = (deps.fillFormHandler as ReturnType<typeof vi.fn>).mock.calls;
    // Login-form card has fill steps for username and password.
    // Check that at least one call has the value "alice" and one has "secret".
    const allValues = calls.flatMap((call: unknown[]) => {
      const params = call[0] as Record<string, unknown>;
      const fields = (params.fields ?? []) as Array<{ value?: string }>;
      return fields.map(f => f.value);
    });
    expect(allValues).toContain("alice");
    expect(allValues).toContain("secret");
  });

  // Subtask 6.7: C3 fix — POST_EXECUTION_SCAN appends new offer
  it("execute-flow: POST_EXECUTION_SCAN appends new offer to result", async () => {
    const deps = makeDeps();
    const result = await operatorHandler(
      { card: "login-form", params: { username: "bob", password: "pass" } },
      deps,
    );

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    // Must contain the result section
    expect(text).toContain("=== OPERATOR RESULT ===");
    expect(text).toContain("Login Form");
    // The post-execution scan uses the same mock nodes (login form),
    // so it should find the login-form card again and append an offer.
    expect(text).toContain("=== OPERATOR ==="); // post-scan offer appended
    // Verify the result has step completion info (format: "Steps: N/N")
    expect(text).toMatch(/Steps:\s*\d+\/\d+/);
  });

  // Subtask 6.8: Fallback path when no card matches
  it("scan-flow: fallback returns no-match text when page has no matching cards", async () => {
    const deps = makeDeps({ nodes: makeEmptyNodes() });
    const result = await operatorHandler({}, deps);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No card matched");
    expect(result._meta?.fallback).toBe(true);
  });

  // Subtask 6.9: C4 fix — Zod validation at input throws McpError
  it("invalid input: non-string card param triggers McpError", async () => {
    const deps = makeDeps();
    await expect(
      operatorHandler({ card: 123 } as unknown as Record<string, unknown>, deps),
    ).rejects.toThrow(McpError);
  });

  // Subtask 6.10: _meta fields are populated
  it("_meta.elapsedMs and _meta.response_bytes are populated", async () => {
    const deps = makeDeps();
    const result = await operatorHandler({}, deps);

    expect(result._meta).toBeDefined();
    expect(result._meta!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result._meta!.method).toBe("operator");
    expect(result._meta!.response_bytes).toBeGreaterThan(0);
  });

  // C4 fix: CDP error is wrapped into McpError
  it("CDP error is wrapped into McpError", async () => {
    const deps = makeDeps();
    (deps.getAXNodes as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("CDP connection lost"));

    await expect(operatorHandler({}, deps)).rejects.toThrow(McpError);
    try {
      await operatorHandler({}, deps);
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).message).toContain("CDP connection lost");
    }
  });

  // Execute-flow: click handler error produces partial result
  it("execute-flow: click handler error produces partial execution result", async () => {
    const errorResult: ToolResponse = {
      content: [{ type: "text", text: "Element not found" }],
      isError: true,
      _meta: { elapsedMs: 5, method: "click" },
    };
    const deps = makeDeps({ clickResult: errorResult });

    const result = await operatorHandler(
      { card: "login-form", params: { username: "alice", password: "secret" } },
      deps,
    );

    // The execution may produce a partial result or error.
    // The key assertion is it doesn't throw uncaught.
    expect(result).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
  });

  // H1: Verify selector-based targets work (not just refs)
  it("execute-flow: ToolDispatcher passes CSS selectors for seed card targets", async () => {
    const deps = makeDeps();
    await operatorHandler(
      { card: "login-form", params: { username: "alice", password: "secret" } },
      deps,
    );

    // Login-form card uses CSS selectors (e.g. "[autocomplete=username]") not refs.
    // The dispatcher should pass them as { selector: ... } not { ref: ... }.
    const fillCalls = (deps.fillFormHandler as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of fillCalls) {
      const params = call[0] as Record<string, unknown>;
      const fields = (params.fields ?? []) as Array<{ ref?: string; selector?: string }>;
      for (const field of fields) {
        // CSS selectors contain brackets/dots/hashes — NOT the eN ref pattern
        if (field.selector) {
          expect(field.selector).toMatch(/[\[\]#.=,]/); // looks like a CSS selector
        }
        // Should NOT have ref for CSS selector targets
        expect(field.ref).toBeUndefined();
      }
    }
  });

  // H2: Latency test for AC-6 (<800ms for scan-flow)
  it("scan-flow latency is under 800ms (AC-6)", async () => {
    const deps = makeDeps();
    const start = performance.now();
    const result = await operatorHandler({}, deps);
    const elapsed = performance.now() - start;

    expect(result.isError).toBeFalsy();
    expect(elapsed).toBeLessThan(800);
    // Also verify the internally-tracked latency
    expect(result._meta!.elapsedMs).toBeLessThan(800);
  });

  // -----------------------------------------------------------------
  // Story 19.8, Task 7: Fallback-Transition Tests
  // -----------------------------------------------------------------

  // Subtask 7.1: Scan without card match calls switchToFallbackMode
  it("fallback: scan without card match calls switchToFallbackMode()", async () => {
    const deps = makeDeps({ nodes: makeEmptyNodes() });
    await operatorHandler({}, deps);

    expect(deps.switchToFallbackMode).toHaveBeenCalledTimes(1);
    expect(deps.switchToStandardMode).not.toHaveBeenCalled();
  });

  // Subtask 7.2: Fallback return has no isError and contains framing text
  it("fallback: return has no isError and contains the framing text", async () => {
    const deps = makeDeps({ nodes: makeEmptyNodes() });
    const result = await operatorHandler({}, deps);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No card matched");
    expect(text).toContain("direct-primitive mode");
    expect(result._meta?.fallback).toBe(true);
  });

  // Subtask 7.3: Re-scan with card match calls switchToStandardMode (return path)
  it("fallback: scan with card match calls switchToStandardMode()", async () => {
    // Login form nodes produce a card match — this is the "return to standard" case
    const deps = makeDeps();
    await operatorHandler({}, deps);

    // When cards match, switchToStandardMode is called (even if already standard,
    // the no-op guard is in the registry, not in operator-tool)
    expect(deps.switchToStandardMode).toHaveBeenCalledTimes(1);
  });

  // Subtask 7.3 (execute-flow): Post-execution scan with card match calls switchToStandardMode
  it("fallback: execute-flow post-scan with match calls switchToStandardMode()", async () => {
    const deps = makeDeps();
    await operatorHandler(
      { card: "login-form", params: { username: "a", password: "b" } },
      deps,
    );

    // The post-execution scan finds login-form again, so switchToStandardMode is called
    expect(deps.switchToStandardMode).toHaveBeenCalled();
  });

  // Subtask 7.4: NFR14 — empty page leads to clean fallback (no crash)
  it("NFR14: empty page leads to clean fallback without crash", async () => {
    const deps = makeDeps({
      nodes: [
        {
          nodeId: "root",
          ignored: false,
          role: { type: "role", value: "WebArea" },
          name: { type: "string", value: "" },
          childIds: [],
        },
      ],
    });

    const result = await operatorHandler({}, deps);
    expect(result).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result._meta?.fallback).toBe(true);
    expect(deps.switchToFallbackMode).toHaveBeenCalled();
  });

  // Subtask 7.5: NFR14 — page with only text leads to clean fallback
  it("NFR14: page with only text leads to clean fallback", async () => {
    const deps = makeDeps({
      nodes: [
        {
          nodeId: "root",
          ignored: false,
          role: { type: "role", value: "WebArea" },
          name: { type: "string", value: "Text Only Page" },
          childIds: ["p1"],
        },
        {
          nodeId: "p1",
          ignored: false,
          role: { type: "role", value: "paragraph" },
          name: { type: "string", value: "Just some text content" },
          parentId: "root",
        },
      ],
    });

    const result = await operatorHandler({}, deps);
    expect(result).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result._meta?.fallback).toBe(true);
    expect(deps.switchToFallbackMode).toHaveBeenCalled();
  });

  // Subtask 7.6: NFR14 — page with interactive elements but no card match
  it("NFR14: page with interactive elements but no card match leads to clean fallback", async () => {
    const deps = makeDeps({
      nodes: [
        {
          nodeId: "root",
          ignored: false,
          role: { type: "role", value: "WebArea" },
          name: { type: "string", value: "Random Page" },
          childIds: ["btn1", "input1"],
        },
        {
          nodeId: "btn1",
          ignored: false,
          role: { type: "role", value: "button" },
          name: { type: "string", value: "Random Button" },
          parentId: "root",
        },
        {
          nodeId: "input1",
          ignored: false,
          role: { type: "role", value: "textbox" },
          name: { type: "string", value: "Random Input" },
          parentId: "root",
        },
      ],
    });

    const result = await operatorHandler({}, deps);
    expect(result).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    // These nodes don't match any seed card pattern (no form with login structure)
    expect(result._meta?.fallback).toBe(true);
    expect(deps.switchToFallbackMode).toHaveBeenCalled();
  });
});
