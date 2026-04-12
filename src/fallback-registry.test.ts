/**
 * Fallback Registry Unit Tests (Story 19.8, Task 5)
 *
 * Tests FALLBACK_TOOL_NAMES, FALLBACK_TOOL_SET, and getFallbackTools().
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FALLBACK_TOOL_NAMES,
  FALLBACK_TOOL_SET,
  getFallbackTools,
} from "./fallback-registry.js";
import { ToolRegistry } from "./registry.js";
import { registerProHooks } from "./hooks/pro-hooks.js";

describe("fallback-registry", () => {
  // Subtask 5.2: FALLBACK_TOOL_NAMES contains exactly the expected 6 tool names
  it("FALLBACK_TOOL_NAMES contains exactly 6 tools", () => {
    expect(FALLBACK_TOOL_NAMES).toHaveLength(6);
    expect([...FALLBACK_TOOL_NAMES]).toEqual([
      "virtual_desk",
      "click",
      "type",
      "read_page",
      "wait_for",
      "screenshot",
    ]);
  });

  // Subtask 5.5: virtual_desk is in the fallback list (session management stays available)
  it("virtual_desk is in the fallback list", () => {
    expect(FALLBACK_TOOL_NAMES).toContain("virtual_desk");
  });

  // Subtask 5.3: getFallbackTools() returns an entry for each tool with name, description, schema
  it("getFallbackTools() returns entries with name, description, schema for all tools", () => {
    const tools = getFallbackTools();
    expect(tools).toHaveLength(6);

    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.name).toBe("string");
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe("string");
      expect(tool.schema).toBeDefined();
      expect(typeof tool.schema).toBe("object");
    }
  });

  it("getFallbackTools() names match FALLBACK_TOOL_NAMES", () => {
    const tools = getFallbackTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...FALLBACK_TOOL_NAMES]);
  });

  // Subtask 5.4: FALLBACK_TOOL_SET has O(1) lookup for all fallback tools
  it("FALLBACK_TOOL_SET has O(1) lookup for all fallback tools", () => {
    expect(FALLBACK_TOOL_SET).toBeInstanceOf(Set);
    for (const name of FALLBACK_TOOL_NAMES) {
      expect(FALLBACK_TOOL_SET.has(name)).toBe(true);
    }
    // Non-fallback tools must NOT be in the set
    expect(FALLBACK_TOOL_SET.has("evaluate")).toBe(false);
    expect(FALLBACK_TOOL_SET.has("operator")).toBe(false);
    expect(FALLBACK_TOOL_SET.has("navigate")).toBe(false);
  });

  it("getFallbackTools() click entry has ref and selector in schema", () => {
    const tools = getFallbackTools();
    const click = tools.find((t) => t.name === "click");
    expect(click).toBeDefined();
    expect(click!.schema.ref).toBeDefined();
    expect(click!.schema.selector).toBeDefined();
  });

  it("getFallbackTools() read_page entry has filter and ref in schema", () => {
    const tools = getFallbackTools();
    const readPage = tools.find((t) => t.name === "read_page");
    expect(readPage).toBeDefined();
    expect(readPage!.schema.filter).toBeDefined();
    expect(readPage!.schema.ref).toBeDefined();
  });

  it("getFallbackTools() virtual_desk has empty schema", () => {
    const tools = getFallbackTools();
    const vd = tools.find((t) => t.name === "virtual_desk");
    expect(vd).toBeDefined();
    expect(Object.keys(vd!.schema)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M1 Integration Test: ToolRegistry.registerAll() uses getFallbackTools()
// as the source for Fallback-tool schemas and descriptions.
// ---------------------------------------------------------------------------
describe("fallback-registry integration with ToolRegistry (M1)", () => {
  afterEach(() => {
    delete process.env.SILBERCUE_CHROME_FULL_TOOLS;
  });

  it("registerAll() registers fallback-only tools with descriptions from getFallbackTools()", () => {
    registerProHooks({});
    // Non-FULL_TOOLS mode so the fallback tools are registered but disabled
    delete process.env.SILBERCUE_CHROME_FULL_TOOLS;

    const toolCalls: Array<{ name: string; description: string; schemaKeys: string[] }> = [];
    const mockTool = vi.fn().mockImplementation((name: string, description: string, schema: Record<string, unknown>) => {
      toolCalls.push({ name, description, schemaKeys: Object.keys(schema) });
      const t = { enabled: true, enable: vi.fn(() => { t.enabled = true; }), disable: vi.fn(() => { t.enabled = false; }), update: vi.fn(), remove: vi.fn() };
      return t;
    });
    const mockServer = { tool: mockTool, sendToolListChanged: vi.fn() } as never;
    const mockCdpClient = {} as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    // Build expected values from getFallbackTools()
    const fallbackTools = getFallbackTools();
    const fallbackOnlyNames = ["click", "type", "read_page", "wait_for", "screenshot"];

    for (const expectedName of fallbackOnlyNames) {
      const expected = fallbackTools.find((t) => t.name === expectedName);
      expect(expected).toBeDefined();

      const registered = toolCalls.find((c) => c.name === expectedName);
      expect(registered).toBeDefined();

      // Description must match exactly — no inline drift
      expect(registered!.description).toBe(expected!.description);

      // Schema keys must match exactly
      expect(registered!.schemaKeys.sort()).toEqual(Object.keys(expected!.schema).sort());
    }
  });
});
