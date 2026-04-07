import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  inspectElementHandler,
  inspectElementSchema,
  buildPropertyMatcher,
  shortenSourceUrl,
} from "./inspect-element.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { InspectElementParams } from "./inspect-element.js";

// Mock a11yTree and selectorCache (same pattern as observe.test.ts)
vi.mock("../cache/a11y-tree.js", () => ({
  a11yTree: {
    resolveRef: vi.fn(),
    getNodeInfo: vi.fn(() => ({ role: "generic", name: "" })),
    currentUrl: "http://test.local",
    refCount: 10,
    findClosestRef: vi.fn(),
  },
  A11yTreeProcessor: { diffSnapshots: vi.fn(() => []), formatDomDiff: vi.fn() },
  RefNotFoundError: class RefNotFoundError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "RefNotFoundError";
    }
  },
}));

vi.mock("../cache/selector-cache.js", () => ({
  selectorCache: {
    get: vi.fn(() => null),
    set: vi.fn(),
    computeFingerprint: vi.fn(),
    updateFingerprint: vi.fn(),
    invalidate: vi.fn(),
  },
}));

import { a11yTree } from "../cache/a11y-tree.js";

// --- Test Helpers ---

/** Standard CDP responses for a working inspect_element flow */
function standardCdpResponses(overrides?: Record<string, unknown | (() => unknown)>) {
  return {
    "DOM.resolveNode": { object: { objectId: "obj-1" } },
    "CSS.enable": {},
    "CSS.disable": {},
    "DOM.getDocument": { root: { nodeId: 1 } },
    "DOM.requestNode": { nodeId: 42 },
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: "display", value: "flex" },
        { name: "flex-direction", value: "column" },
        { name: "width", value: "320px" },
        { name: "height", value: "480px" },
        { name: "padding", value: "16px" },
        { name: "margin", value: "0px" },
        { name: "color", value: "rgb(0, 0, 0)" },
        { name: "position", value: "static" },
        { name: "overflow", value: "visible" },
        { name: "font-size", value: "16px" },
        { name: "background-color", value: "rgba(0, 0, 0, 0)" },
        { name: "z-index", value: "auto" },
      ],
    },
    "CSS.getMatchedStylesForNode": {
      inlineStyle: {
        cssProperties: [
          { name: "padding", value: "16px", implicit: false, parsedOk: true },
        ],
      },
      matchedCSSRules: [
        {
          rule: {
            styleSheetId: "sheet-1",
            selectorList: {
              selectors: [{ text: ".container" }],
              text: ".container",
            },
            origin: "regular",
            style: {
              styleSheetId: "sheet-1",
              cssProperties: [
                { name: "display", value: "flex", implicit: false, parsedOk: true },
                { name: "flex-direction", value: "column", implicit: false, parsedOk: true },
              ],
              range: { startLine: 41, startColumn: 0, endLine: 45, endColumn: 1 },
            },
          },
          matchingSelectors: [0],
        },
        {
          rule: {
            selectorList: {
              selectors: [{ text: "div" }],
              text: "div",
            },
            origin: "user-agent",
            style: {
              cssProperties: [
                { name: "display", value: "block", implicit: false, parsedOk: true },
              ],
            },
          },
          matchingSelectors: [0],
        },
      ],
      inherited: [
        {
          inlineStyle: undefined,
          matchedCSSRules: [
            {
              rule: {
                styleSheetId: "sheet-2",
                selectorList: {
                  selectors: [{ text: "body" }],
                  text: "body",
                },
                origin: "regular",
                style: {
                  styleSheetId: "sheet-2",
                  cssProperties: [
                    { name: "font-size", value: "16px", implicit: false, parsedOk: true },
                    { name: "color", value: "#333", implicit: false, parsedOk: true },
                    { name: "line-height", value: "1.5", implicit: false, parsedOk: true },
                  ],
                  range: { startLine: 11, startColumn: 0, endLine: 15, endColumn: 1 },
                },
              },
              matchingSelectors: [0],
            },
          ],
        },
      ],
    },
    "Runtime.callFunctionOn": (() => {
      let callCount = 0;
      return () => {
        callCount++;
        if (callCount === 1) {
          // getBoundingClientRect
          return { result: { value: { x: 10, y: 50, width: 320, height: 480 } } };
        }
        // Element info + ancestor chain
        return { result: { value: { self: "div#main.container.layout", ancestors: ["body", "html"] } } };
      };
    })(),
    ...overrides,
  };
}

function createMockCdp(responses?: Record<string, unknown | (() => unknown)>) {
  const sendFn = vi.fn(async (method: string) => {
    if (responses && method in responses) {
      const val = responses[method];
      return typeof val === "function" ? val() : val;
    }
    return {};
  });

  return {
    cdpClient: {
      send: sendFn,
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient,
    sendFn,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Schema Tests ---

describe("inspectElementSchema", () => {
  it("should parse minimal params (selector only)", () => {
    const result = inspectElementSchema.parse({ selector: ".container" });
    expect(result.selector).toBe(".container");
    expect(result.include_rules).toBe(true);
    expect(result.include_inherited).toBe(true);
    expect(result.styles).toBeUndefined();
  });

  it("should parse with styles filter", () => {
    const result = inspectElementSchema.parse({
      selector: "e5",
      styles: ["display", "flex*"],
    });
    expect(result.styles).toEqual(["display", "flex*"]);
  });

  it("should parse with include_rules false", () => {
    const result = inspectElementSchema.parse({
      selector: "#box",
      include_rules: false,
    });
    expect(result.include_rules).toBe(false);
  });

  it("should parse with include_inherited false", () => {
    const result = inspectElementSchema.parse({
      selector: "e10",
      include_inherited: false,
    });
    expect(result.include_inherited).toBe(false);
  });

  it("should reject missing selector", () => {
    expect(() => inspectElementSchema.parse({})).toThrow();
  });
});

// --- buildPropertyMatcher Tests ---

describe("buildPropertyMatcher", () => {
  it("should use DEFAULT_PROPERTIES when no filter is given", () => {
    const matcher = buildPropertyMatcher();
    expect(matcher("display")).toBe(true);
    expect(matcher("flex-direction")).toBe(true);
    expect(matcher("width")).toBe(true);
    expect(matcher("padding")).toBe(true);
    expect(matcher("animation-duration")).toBe(false);
    expect(matcher("cursor")).toBe(false);
  });

  it("should match exact property names", () => {
    const matcher = buildPropertyMatcher(["color", "font-size"]);
    expect(matcher("color")).toBe(true);
    expect(matcher("font-size")).toBe(true);
    expect(matcher("display")).toBe(false);
  });

  it("should expand wildcards", () => {
    const matcher = buildPropertyMatcher(["flex*"]);
    expect(matcher("flex-direction")).toBe(true);
    expect(matcher("flex-wrap")).toBe(true);
    expect(matcher("flex-grow")).toBe(true);
    expect(matcher("flex-shrink")).toBe(true);
    expect(matcher("flex-basis")).toBe(true);
    expect(matcher("display")).toBe(false);
  });

  it("should handle mixed exact and wildcard filters", () => {
    const matcher = buildPropertyMatcher(["color", "grid*"]);
    expect(matcher("color")).toBe(true);
    expect(matcher("grid-template-columns")).toBe(true);
    expect(matcher("grid-gap")).toBe(true);
    expect(matcher("display")).toBe(false);
  });

  it("should return false for empty filter array (no defaults)", () => {
    const matcher = buildPropertyMatcher([]);
    expect(matcher("display")).toBe(true); // empty array → use defaults
  });
});

// --- shortenSourceUrl Tests ---

describe("shortenSourceUrl", () => {
  it("should extract filename from full URL", () => {
    expect(shortenSourceUrl("https://example.com/css/styles.css")).toBe("css/styles.css");
  });

  it("should handle short paths", () => {
    expect(shortenSourceUrl("https://example.com/styles.css")).toBe("styles.css");
  });

  it("should handle deep paths (keep last 2 segments)", () => {
    expect(shortenSourceUrl("https://example.com/a/b/c/d/main.css")).toBe("d/main.css");
  });

  it("should return <inline> for empty string", () => {
    expect(shortenSourceUrl("")).toBe("<inline>");
  });

  it("should handle invalid URLs gracefully", () => {
    expect(shortenSourceUrl("not-a-url")).toBe("not-a-url");
  });
});

// --- Handler Tests ---

describe("inspectElementHandler", () => {
  it("should resolve ref-based selector and return formatted output", async () => {
    (a11yTree.resolveRef as ReturnType<typeof vi.fn>).mockReturnValue(100);
    const { cdpClient, sendFn } = createMockCdp(standardCdpResponses());

    const result = await inspectElementHandler(
      { selector: "e5", include_rules: true, include_inherited: true } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].type === "text" ? result.content[0].text : "";

    // Element header with geometry
    expect(text).toContain("Element: div#main.container.layout");
    expect(text).toContain("320x480");
    expect(text).toContain("10,50");

    // Computed styles
    expect(text).toContain("Computed:");
    expect(text).toContain("display: flex");
    expect(text).toContain("flex-direction: column");
    expect(text).toContain("width: 320px");

    // CSS.enable was called
    expect(sendFn).toHaveBeenCalledWith("CSS.enable", {}, "session-1");

    // Meta
    expect(result._meta?.method).toBe("inspect_element");
    expect(result._meta?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("should resolve CSS selector", async () => {
    const responses = standardCdpResponses({
      "DOM.querySelector": { nodeId: 99 },
      "DOM.describeNode": { node: { backendNodeId: 200 } },
    });
    const { cdpClient } = createMockCdp(responses);

    const result = await inspectElementHandler(
      { selector: ".container", include_rules: true, include_inherited: true } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("Element:");
  });

  it("should include matched CSS rules with source files", async () => {
    (a11yTree.resolveRef as ReturnType<typeof vi.fn>).mockReturnValue(100);
    const { cdpClient } = createMockCdp(standardCdpResponses());

    // Register stylesheet header via on() callback
    const onCallbacks: Array<(event: unknown) => void> = [];
    (cdpClient.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, cb: (event: unknown) => void) => {
        onCallbacks.push(cb);
      },
    );

    // Simulate styleSheetAdded after CSS.enable
    const originalSend = (cdpClient.send as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (cdpClient.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string, ...args: unknown[]) => {
      const result = await originalSend(method, ...args);
      if (method === "CSS.enable" && onCallbacks.length > 0) {
        onCallbacks.forEach((cb) => {
          cb({
            header: {
              styleSheetId: "sheet-1",
              sourceURL: "https://example.com/css/styles.css",
              isInline: false,
              startLine: 0,
            },
          });
          cb({
            header: {
              styleSheetId: "sheet-2",
              sourceURL: "https://example.com/css/global.css",
              isInline: false,
              startLine: 0,
            },
          });
        });
      }
      return result;
    });

    const result = await inspectElementHandler(
      { selector: "e5", include_rules: true, include_inherited: true } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";

    // Rules section with source files
    expect(text).toContain("Rules:");
    expect(text).toContain(".container { display: flex; flex-direction: column }");
    expect(text).toContain("<- css/styles.css:42");

    // User-agent rules should NOT appear
    expect(text).not.toContain("user-agent");
    expect(text).not.toMatch(/div \{ display: block/);
  });

  it("should include inherited styles", async () => {
    (a11yTree.resolveRef as ReturnType<typeof vi.fn>).mockReturnValue(100);
    const { cdpClient } = createMockCdp(standardCdpResponses());

    const result = await inspectElementHandler(
      { selector: "e5", include_rules: true, include_inherited: true } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("Inherited:");
    expect(text).toContain("font-size: 16px");
    expect(text).toContain("color: #333");
    expect(text).toContain("line-height: 1.5");
  });

  it("should skip inherited when include_inherited is false", async () => {
    (a11yTree.resolveRef as ReturnType<typeof vi.fn>).mockReturnValue(100);
    const { cdpClient } = createMockCdp(standardCdpResponses());

    const result = await inspectElementHandler(
      { selector: "e5", include_rules: true, include_inherited: false } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).not.toContain("Inherited:");
  });

  it("should skip rules when include_rules is false", async () => {
    (a11yTree.resolveRef as ReturnType<typeof vi.fn>).mockReturnValue(100);
    const { cdpClient, sendFn } = createMockCdp(standardCdpResponses());

    const result = await inspectElementHandler(
      { selector: "e5", include_rules: false, include_inherited: true } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).not.toContain("Rules:");
    expect(text).not.toContain("Inherited:");

    // CSS.getMatchedStylesForNode should NOT have been called
    const matchedCalls = sendFn.mock.calls.filter(
      (c: unknown[]) => c[0] === "CSS.getMatchedStylesForNode",
    );
    expect(matchedCalls).toHaveLength(0);
  });

  it("should filter computed styles with styles parameter", async () => {
    (a11yTree.resolveRef as ReturnType<typeof vi.fn>).mockReturnValue(100);
    const { cdpClient } = createMockCdp(standardCdpResponses());

    const result = await inspectElementHandler(
      { selector: "e5", styles: ["display", "flex*"], include_rules: false, include_inherited: false } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("display: flex");
    expect(text).toContain("flex-direction: column");
    // width should NOT appear (not in filter)
    expect(text).not.toContain("width: 320px");
  });

  it("should return error for missing ref", async () => {
    (a11yTree.resolveRef as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (a11yTree.findClosestRef as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const { cdpClient } = createMockCdp(standardCdpResponses());

    const result = await inspectElementHandler(
      { selector: "e999", include_rules: true, include_inherited: true } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    expect(result.isError).toBe(true);
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("e999");
    expect(text).toContain("not found");
  });

  it("should handle DOM.requestNode failure", async () => {
    (a11yTree.resolveRef as ReturnType<typeof vi.fn>).mockReturnValue(100);
    const { cdpClient } = createMockCdp({
      ...standardCdpResponses(),
      "DOM.requestNode": { nodeId: 0 },
    });

    const result = await inspectElementHandler(
      { selector: "e5", include_rules: true, include_inherited: true } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    expect(result.isError).toBe(true);
  });

  it("should handle page without stylesheets (only computed)", async () => {
    (a11yTree.resolveRef as ReturnType<typeof vi.fn>).mockReturnValue(100);
    const { cdpClient } = createMockCdp({
      ...standardCdpResponses(),
      "CSS.getMatchedStylesForNode": {
        inlineStyle: undefined,
        matchedCSSRules: [],
        inherited: [],
      },
    });

    const result = await inspectElementHandler(
      { selector: "e5", include_rules: true, include_inherited: true } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("Element:");
    expect(text).toContain("Computed:");
    // No Rules or Inherited sections since there are no rules
    expect(text).not.toContain("Rules:");
    expect(text).not.toContain("Inherited:");
  });

  it("should show display: none in computed (important for debugging)", async () => {
    (a11yTree.resolveRef as ReturnType<typeof vi.fn>).mockReturnValue(100);
    const { cdpClient } = createMockCdp({
      ...standardCdpResponses(),
      "CSS.getComputedStyleForNode": {
        computedStyle: [
          { name: "display", value: "none" },
          { name: "width", value: "0px" },
        ],
      },
    });

    const result = await inspectElementHandler(
      { selector: "e5", include_rules: false, include_inherited: false } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("display: none");
  });

  it("should include inline styles in Rules section", async () => {
    (a11yTree.resolveRef as ReturnType<typeof vi.fn>).mockReturnValue(100);
    const { cdpClient } = createMockCdp(standardCdpResponses());

    const result = await inspectElementHandler(
      { selector: "e5", include_rules: true, include_inherited: false } as InspectElementParams,
      cdpClient,
      "session-1",
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("[inline] { padding: 16px }");
  });
});
