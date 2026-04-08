import { describe, it, expect, vi, beforeEach } from "vitest";
import { readPageSchema, readPageHandler } from "./read-page.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import { a11yTree } from "../cache/a11y-tree.js";
import type { AXNode } from "../cache/a11y-tree.js";

function makeDomSnapshot(elements: Array<{
  backendNodeId: number;
  nodeName: string;
  bounds?: [number, number, number, number];
  display?: string;
  visibility?: string;
}>) {
  const strings: string[] = [];
  const strIndex = (s: string) => {
    let idx = strings.indexOf(s);
    if (idx === -1) { idx = strings.length; strings.push(s); }
    return idx;
  };

  const backendNodeIds: number[] = [];
  const nodeNames: number[] = [];
  const layoutNodeIndex: number[] = [];
  const layoutBounds: number[][] = [];
  const layoutStyleProps: number[][] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    backendNodeIds.push(el.backendNodeId);
    nodeNames.push(strIndex(el.nodeName));

    if (el.bounds) {
      layoutNodeIndex.push(i);
      layoutBounds.push(el.bounds);
      layoutStyleProps.push([
        strIndex(el.display ?? "block"),
        strIndex(el.visibility ?? "visible"),
        strIndex("rgb(0,0,0)"),
        strIndex("rgb(255,255,255)"),
        strIndex("16px"),
        strIndex("static"),
        strIndex("auto"),
      ]);
    }
  }

  return {
    documents: [{
      nodes: { backendNodeId: backendNodeIds, nodeName: nodeNames },
      layout: {
        nodeIndex: layoutNodeIndex,
        bounds: layoutBounds,
        styles: layoutStyleProps,
      },
    }],
    strings,
  };
}

function mockCdpClient(nodes: AXNode[], url = "https://example.com", domSnapshot?: ReturnType<typeof makeDomSnapshot>): CdpClient {
  return {
    send: vi.fn().mockImplementation((method: string) => {
      if (method === "Runtime.evaluate") {
        return Promise.resolve({ result: { value: url } });
      }
      if (method === "Accessibility.getFullAXTree") {
        return Promise.resolve({ nodes });
      }
      if (method === "DOMSnapshot.captureSnapshot") {
        return Promise.resolve(domSnapshot ?? { documents: [], strings: [] });
      }
      return Promise.resolve({});
    }),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;
}

function makeNode(overrides: Partial<AXNode> & { nodeId: string }): AXNode {
  return { ignored: false, ...overrides };
}

const sampleNodes: AXNode[] = [
  makeNode({
    nodeId: "1",
    role: { type: "role", value: "WebArea" },
    name: { type: "computedString", value: "Test" },
    backendDOMNodeId: 100,
    childIds: ["2", "3"],
  }),
  makeNode({
    nodeId: "2",
    parentId: "1",
    role: { type: "role", value: "button" },
    name: { type: "computedString", value: "OK" },
    backendDOMNodeId: 101,
  }),
  makeNode({
    nodeId: "3",
    parentId: "1",
    role: { type: "role", value: "link" },
    name: { type: "computedString", value: "Home" },
    backendDOMNodeId: 102,
  }),
];

describe("readPageSchema", () => {
  beforeEach(() => {
    a11yTree.reset();
  });

  // Test 1: defaults
  it("should have correct defaults (depth=3, filter=interactive)", () => {
    const parsed = readPageSchema.parse({});
    expect(parsed.depth).toBe(3);
    expect(parsed.filter).toBe("interactive");
    expect(parsed.ref).toBeUndefined();
  });

  // Test 2: custom depth
  it("should parse custom depth", () => {
    const parsed = readPageSchema.parse({ depth: 5 });
    expect(parsed.depth).toBe(5);
  });

  // Test 3: ref parameter
  it("should parse ref parameter", () => {
    const parsed = readPageSchema.parse({ ref: "e5" });
    expect(parsed.ref).toBe("e5");
  });

  // Test 4: filter enum validation
  it("should validate filter enum", () => {
    expect(readPageSchema.parse({ filter: "all" }).filter).toBe("all");
    expect(readPageSchema.parse({ filter: "landmark" }).filter).toBe("landmark");
    expect(() => readPageSchema.parse({ filter: "invalid" })).toThrow();
  });

  // Test: filter "visual" accepted
  it("should accept filter visual", () => {
    const parsed = readPageSchema.parse({ filter: "visual" });
    expect(parsed.filter).toBe("visual");
  });

  // Test: max_tokens accepted
  it("should accept max_tokens: 4000", () => {
    const parsed = readPageSchema.parse({ max_tokens: 4000 });
    expect(parsed.max_tokens).toBe(4000);
  });

  // Test: max_tokens is optional
  it("should default max_tokens to undefined", () => {
    const parsed = readPageSchema.parse({});
    expect(parsed.max_tokens).toBeUndefined();
  });

  // Test: max_tokens clamp to 500 (BUG-014)
  it("should clamp max_tokens below 500 to 500", () => {
    expect(readPageSchema.parse({ max_tokens: 100 }).max_tokens).toBe(500);
    expect(readPageSchema.parse({ max_tokens: 499 }).max_tokens).toBe(500);
  });

  // Test: max_tokens must be int
  it("should reject non-integer max_tokens", () => {
    expect(() => readPageSchema.parse({ max_tokens: 4000.5 })).toThrow();
  });
});

describe("readPageHandler", () => {
  beforeEach(() => {
    a11yTree.reset();
  });

  // Test 5: Default handler response
  it("should return tree text with header and _meta", async () => {
    const cdp = mockCdpClient(sampleNodes);
    const result = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Page: Test");
    expect(result.content[0].text).toContain("interactive elements");
    expect(result._meta).toBeDefined();
    expect(result._meta!.method).toBe("read_page");
  });

  // Test 6: Handler with depth — FR-002: interactive filter uses cdpFetchDepth = max(depth, 10)
  it("should pass cdpFetchDepth (not display depth) to CDP for interactive filter", async () => {
    const cdp = mockCdpClient(sampleNodes);
    await readPageHandler({ depth: 5, filter: "interactive" }, cdp, "s1");

    // FR-002: interactive filter → cdpFetchDepth = max(5, 10) = 10
    expect(cdp.send).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      { depth: 10 },
      "s1",
    );
  });

  // Test 6b: filter=all fetches depth + 2 (extra levels for leaf text content)
  it("should pass display depth + 2 to CDP for filter=all", async () => {
    a11yTree.reset();
    const cdp = mockCdpClient(sampleNodes, "https://example.com/all-depth");
    await readPageHandler({ depth: 5, filter: "all" }, cdp, "s1");

    expect(cdp.send).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      { depth: 7 },
      "s1",
    );
  });

  // Test 7: Handler with ref (subtree)
  it("should return subtree for valid ref", async () => {
    const cdp = mockCdpClient(sampleNodes);
    // First call assigns refs
    await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");
    // Subtree for e2 (button)
    const result = await readPageHandler({ depth: 3, filter: "all", ref: "e2" }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Subtree for e2");
  });

  // Test 8: Handler with filter=all
  it("should return all elements with filter=all", async () => {
    const cdp = mockCdpClient(sampleNodes);
    const result = await readPageHandler({ depth: 3, filter: "all" }, cdp, "s1");

    expect(result.content[0].text).toContain("all elements");
    // WebArea + button + link = 3
    expect(result._meta!.refCount).toBe(3);
  });

  // Test 9: Invalid ref → isError with suggestion
  it("should return isError for invalid ref", async () => {
    const cdp = mockCdpClient(sampleNodes);
    // First call assigns refs
    await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");
    // Invalid ref
    const result = await readPageHandler({ depth: 3, filter: "interactive", ref: "e99" }, cdp, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("e99");
    expect(result.content[0].text).toContain("not found");
  });

  // Test 10: CDP error → isError
  it("should return isError for CDP failure", async () => {
    const cdp = {
      send: vi.fn().mockRejectedValue(new Error("Session closed")),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("read_page failed");
    expect(result.content[0].text).toContain("Session closed");
  });

  // Test 11: Empty page → empty tree (no error)
  it("should return empty tree for empty page", async () => {
    const cdp = mockCdpClient([]);
    const result = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    expect(result._meta!.refCount).toBe(0);
  });

  // Test 12: _meta fields
  it("should include correct _meta fields", async () => {
    const cdp = mockCdpClient(sampleNodes);
    const result = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

    expect(result._meta!.method).toBe("read_page");
    expect(result._meta!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result._meta!.refCount).toBeGreaterThanOrEqual(0);
    expect(result._meta!.depth).toBe(3);
  });

  // Test: filter visual calls DOMSnapshot.captureSnapshot
  it("should call DOMSnapshot.captureSnapshot for filter visual", async () => {
    const snapshot = makeDomSnapshot([
      { backendNodeId: 100, nodeName: "HTML", bounds: [0, 0, 1280, 800] },
      { backendNodeId: 101, nodeName: "BUTTON", bounds: [120, 340, 80, 32] },
      { backendNodeId: 102, nodeName: "A", bounds: [200, 400, 60, 20] },
    ]);
    const cdp = mockCdpClient(sampleNodes, "https://example.com", snapshot);
    await readPageHandler({ depth: 3, filter: "visual" }, cdp, "s1");

    expect(cdp.send).toHaveBeenCalledWith(
      "DOMSnapshot.captureSnapshot",
      expect.objectContaining({ includeDOMRects: true }),
      "s1",
    );
  });

  // Test: filter interactive does NOT call DOMSnapshot.captureSnapshot
  it("should NOT call DOMSnapshot.captureSnapshot for filter interactive", async () => {
    const cdp = mockCdpClient(sampleNodes);
    await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

    const calls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
    const snapshotCalls = calls.filter(
      (c: string[]) => c[0] === "DOMSnapshot.captureSnapshot",
    );
    expect(snapshotCalls.length).toBe(0);
  });

  // Test: visual output contains bounds format [x,y wxh] click vis
  it("should include [x,y wxh] click vis format in visual output", async () => {
    const snapshot = makeDomSnapshot([
      { backendNodeId: 100, nodeName: "HTML", bounds: [0, 0, 1280, 800] },
      { backendNodeId: 101, nodeName: "BUTTON", bounds: [120, 340, 80, 32] },
      { backendNodeId: 102, nodeName: "A", bounds: [200, 400, 60, 20] },
    ]);
    const cdp = mockCdpClient(sampleNodes, "https://example.com", snapshot);
    const result = await readPageHandler({ depth: 3, filter: "visual" }, cdp, "s1");

    expect(result.content[0].text).toContain("[120,340 80x32]");
    expect(result.content[0].text).toContain("click");
    expect(result.content[0].text).toContain("vis");
  });

  // Test: isClickable correct for button (true) vs heading (false)
  it("should mark button as clickable and heading as not clickable", async () => {
    const nodesWithHeading: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Test" },
        backendDOMNodeId: 100,
        childIds: ["2", "3"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Submit" },
        backendDOMNodeId: 101,
      }),
      makeNode({
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "heading" },
        name: { type: "computedString", value: "Title" },
        backendDOMNodeId: 102,
        properties: [{ name: "focusable", value: { type: "boolean", value: true } }],
      }),
    ];
    const snapshot = makeDomSnapshot([
      { backendNodeId: 100, nodeName: "HTML", bounds: [0, 0, 1280, 800] },
      { backendNodeId: 101, nodeName: "BUTTON", bounds: [120, 340, 80, 32] },
      { backendNodeId: 102, nodeName: "H1", bounds: [10, 10, 300, 40] },
    ]);
    const cdp = mockCdpClient(nodesWithHeading, "https://example.com", snapshot);
    const result = await readPageHandler({ depth: 3, filter: "visual" }, cdp, "s1");

    const lines = result.content[0].text.split("\n");
    const buttonLine = lines.find((l: string) => l.includes("button"));
    const headingLine = lines.find((l: string) => l.includes("heading"));

    expect(buttonLine).toContain("click");
    expect(headingLine).not.toContain("click");
  });

  // Test: isVisible false for off-screen elements
  it("should mark off-screen elements as not visible", async () => {
    const snapshot = makeDomSnapshot([
      { backendNodeId: 100, nodeName: "HTML", bounds: [0, 0, 1280, 800] },
      { backendNodeId: 101, nodeName: "BUTTON", bounds: [2000, 2000, 80, 32] },
      { backendNodeId: 102, nodeName: "A", bounds: [200, 400, 60, 20] },
    ]);
    const cdp = mockCdpClient(sampleNodes, "https://example.com", snapshot);
    const result = await readPageHandler({ depth: 3, filter: "visual" }, cdp, "s1");

    const lines = result.content[0].text.split("\n");
    const buttonLine = lines.find((l: string) => l.includes("button"));
    const linkLine = lines.find((l: string) => l.includes("link"));

    // Off-screen button should not have "vis"
    expect(buttonLine).not.toContain("vis");
    // On-screen link should have "vis"
    expect(linkLine).toContain("vis");
  });

  // Test: ref + filter visual returns subtree with visual data
  it("should return subtree with visual data for ref + visual filter", async () => {
    const snapshot = makeDomSnapshot([
      { backendNodeId: 100, nodeName: "HTML", bounds: [0, 0, 1280, 800] },
      { backendNodeId: 101, nodeName: "BUTTON", bounds: [120, 340, 80, 32] },
      { backendNodeId: 102, nodeName: "A", bounds: [200, 400, 60, 20] },
    ]);
    const cdp = mockCdpClient(sampleNodes, "https://example.com", snapshot);

    // First call to assign refs
    await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");
    // Subtree for e2 (button) with visual
    const result = await readPageHandler({ depth: 3, filter: "visual", ref: "e2" }, cdp, "s1");

    expect(result.content[0].text).toContain("Subtree for e2");
    expect(result.content[0].text).toContain("[120,340 80x32]");
  });

  // Test: _meta.hasVisualData is true for visual, undefined for interactive
  it("should set _meta.hasVisualData only for visual filter", async () => {
    const snapshot = makeDomSnapshot([
      { backendNodeId: 100, nodeName: "HTML", bounds: [0, 0, 1280, 800] },
      { backendNodeId: 101, nodeName: "BUTTON", bounds: [120, 340, 80, 32] },
      { backendNodeId: 102, nodeName: "A", bounds: [200, 400, 60, 20] },
    ]);
    const cdp = mockCdpClient(sampleNodes, "https://example.com", snapshot);

    const visualResult = await readPageHandler({ depth: 3, filter: "visual" }, cdp, "s1");
    expect(visualResult._meta!.hasVisualData).toBe(true);

    // Reset and test interactive
    a11yTree.reset();
    const interactiveResult = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");
    expect(interactiveResult._meta!.hasVisualData).toBeUndefined();
  });

  // M1: DOMSnapshot failure → hasVisualData false in _meta, no isError
  it("M1: should return hasVisualData false when DOMSnapshot fails", async () => {
    a11yTree.reset();
    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/m1" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes: sampleNodes });
        }
        if (method === "DOMSnapshot.captureSnapshot") {
          return Promise.reject(new Error("DOMSnapshot not supported"));
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await readPageHandler({ depth: 3, filter: "visual" }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    expect(result._meta!.hasVisualData).toBe(false);
    expect(result.content[0].text).toContain("button");
  });

  // H1: empty tree with visual filter → hasVisualData false in _meta
  it("H1: should return hasVisualData false for empty tree with visual filter", async () => {
    a11yTree.reset();
    const cdp = mockCdpClient([], "https://example.com/empty-h1");
    const result = await readPageHandler({ depth: 3, filter: "visual" }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    expect(result._meta!.hasVisualData).toBe(false);
    expect(result._meta!.refCount).toBe(0);
  });

  // --- Downsampling Tests ---

  // Test: Without max_tokens, output is unchanged (regression)
  it("should NOT downsample without max_tokens", async () => {
    const cdp = mockCdpClient(sampleNodes, "https://example.com/no-ds");
    const result = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

    expect(result._meta!.downsampled).toBeUndefined();
    expect(result.content[0].text).toContain('[e');
    expect(result.content[0].text).toContain("button");
  });

  // Test: max_tokens larger than output → no change
  it("should NOT downsample when max_tokens exceeds output size", async () => {
    a11yTree.reset();
    const cdp = mockCdpClient(sampleNodes, "https://example.com/large-budget");
    const result = await readPageHandler({ depth: 3, filter: "interactive", max_tokens: 50000 }, cdp, "s1");

    expect(result._meta!.downsampled).toBeUndefined();
    expect(result.content[0].text).toContain("button");
  });

  // Test: _meta.downsampled is true when downsampling applied
  it("should set _meta.downsampled when downsampling applied", async () => {
    a11yTree.reset();
    // Create many nodes to generate a large tree
    const manyNodes: AXNode[] = [
      makeNode({
        nodeId: "root",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Big Page" },
        backendDOMNodeId: 1000,
        childIds: Array.from({ length: 50 }, (_, i) => `n${i}`),
      }),
      ...Array.from({ length: 50 }, (_, i) =>
        makeNode({
          nodeId: `n${i}`,
          parentId: "root",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: `Button ${i} with a reasonably long label to consume tokens` },
          backendDOMNodeId: 1001 + i,
        }),
      ),
    ];
    const cdp = mockCdpClient(manyNodes, "https://example.com/big-ds");
    const result = await readPageHandler({ depth: 3, filter: "interactive", max_tokens: 500 }, cdp, "s1");

    expect(result._meta!.downsampled).toBe(true);
    expect(result._meta!.originalTokens).toBeGreaterThan(500);
    expect(result._meta!.downsampleLevel).toBeDefined();
  });

  // Test: Interactive elements ALWAYS preserved in downsampled output
  it("should preserve interactive elements in downsampled output", async () => {
    a11yTree.reset();
    const mixedNodes: AXNode[] = [
      makeNode({
        nodeId: "root",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Mixed" },
        backendDOMNodeId: 2000,
        childIds: ["nav1", "btn1", "link1", "heading1", ...Array.from({ length: 30 }, (_, i) => `p${i}`)],
      }),
      makeNode({
        nodeId: "nav1",
        parentId: "root",
        role: { type: "role", value: "navigation" },
        name: { type: "computedString", value: "Main Nav" },
        backendDOMNodeId: 2001,
      }),
      makeNode({
        nodeId: "btn1",
        parentId: "root",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Submit Form" },
        backendDOMNodeId: 2002,
      }),
      makeNode({
        nodeId: "link1",
        parentId: "root",
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "More Info" },
        backendDOMNodeId: 2003,
      }),
      makeNode({
        nodeId: "heading1",
        parentId: "root",
        role: { type: "role", value: "heading" },
        name: { type: "computedString", value: "Page Title" },
        backendDOMNodeId: 2004,
      }),
      ...Array.from({ length: 30 }, (_, i) =>
        makeNode({
          nodeId: `p${i}`,
          parentId: "root",
          role: { type: "role", value: "paragraph" },
          name: { type: "computedString", value: `Paragraph ${i} with a long text that takes up many tokens in the output to force downsampling` },
          backendDOMNodeId: 2005 + i,
        }),
      ),
    ];
    const cdp = mockCdpClient(mixedNodes, "https://example.com/mixed-ds");
    const result = await readPageHandler({ depth: 3, filter: "all", max_tokens: 800 }, cdp, "s1");

    // Interactive elements must be present
    expect(result.content[0].text).toContain("button");
    expect(result.content[0].text).toContain("Submit Form");
    expect(result.content[0].text).toContain("link");
    expect(result.content[0].text).toContain("More Info");
    expect(result._meta!.downsampled).toBe(true);
  });

  // --- FR-002: CDP Fetch Depth vs Display Depth ---

  // FR-002: interactive filter finds deeply nested elements (depth 7) even with display depth 3
  it("FR-002: should find interactive elements at depth 7 with filter=interactive, depth=3", async () => {
    a11yTree.reset();
    // Build a deeply nested tree: WebArea > generic > generic > generic > generic > generic > generic > textbox
    // The textbox is at nesting level 7 (beyond display depth 3)
    const deepNodes: AXNode[] = [
      makeNode({
        nodeId: "d0",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Deep Form" },
        backendDOMNodeId: 5000,
        childIds: ["d1"],
      }),
      makeNode({
        nodeId: "d1",
        parentId: "d0",
        role: { type: "role", value: "generic" },
        name: { type: "computedString", value: "" },
        backendDOMNodeId: 5001,
        childIds: ["d2"],
      }),
      makeNode({
        nodeId: "d2",
        parentId: "d1",
        role: { type: "role", value: "generic" },
        name: { type: "computedString", value: "" },
        backendDOMNodeId: 5002,
        childIds: ["d3"],
      }),
      makeNode({
        nodeId: "d3",
        parentId: "d2",
        role: { type: "role", value: "generic" },
        name: { type: "computedString", value: "" },
        backendDOMNodeId: 5003,
        childIds: ["d4"],
      }),
      makeNode({
        nodeId: "d4",
        parentId: "d3",
        role: { type: "role", value: "generic" },
        name: { type: "computedString", value: "" },
        backendDOMNodeId: 5004,
        childIds: ["d5"],
      }),
      makeNode({
        nodeId: "d5",
        parentId: "d4",
        role: { type: "role", value: "generic" },
        name: { type: "computedString", value: "" },
        backendDOMNodeId: 5005,
        childIds: ["d6"],
      }),
      makeNode({
        nodeId: "d6",
        parentId: "d5",
        role: { type: "role", value: "form" },
        name: { type: "computedString", value: "Contact" },
        backendDOMNodeId: 5006,
        childIds: ["d7"],
      }),
      makeNode({
        nodeId: "d7",
        parentId: "d6",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Email" },
        backendDOMNodeId: 5007,
      }),
    ];

    const cdp = mockCdpClient(deepNodes, "https://example.com/fr002-deep");
    const result = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

    // The textbox at depth 7 MUST be found — FR-002 fix
    expect(result.content[0].text).toContain("textbox");
    expect(result.content[0].text).toContain("Email");

    // CDP must have been called with cdpFetchDepth=10, not display depth=3
    expect(cdp.send).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      { depth: 10 },
      "s1",
    );
  });

  // FR-001: filter=all with depth=3 fetches depth+2=5 (extra levels for leaf text)
  it("FR-001: filter=all with depth=3 should fetch at depth 5", async () => {
    a11yTree.reset();
    const cdp = mockCdpClient(sampleNodes, "https://example.com/fr002-all");
    await readPageHandler({ depth: 3, filter: "all" }, cdp, "s1");

    expect(cdp.send).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      { depth: 5 },
      "s1",
    );
  });

  // FR-002: filter=landmark uses cdpFetchDepth = max(depth, 6)
  it("FR-002: filter=landmark with depth=3 should fetch at depth 6", async () => {
    a11yTree.reset();
    const cdp = mockCdpClient(sampleNodes, "https://example.com/fr002-landmark");
    await readPageHandler({ depth: 3, filter: "landmark" }, cdp, "s1");

    expect(cdp.send).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      { depth: 6 },
      "s1",
    );
  });

  // FR-002: filter=visual uses cdpFetchDepth = max(depth, 10) (same as interactive)
  it("FR-002: filter=visual with depth=3 should fetch at depth 10", async () => {
    a11yTree.reset();
    const snapshot = makeDomSnapshot([
      { backendNodeId: 100, nodeName: "HTML", bounds: [0, 0, 1280, 800] },
    ]);
    const cdp = mockCdpClient(sampleNodes, "https://example.com/fr002-visual", snapshot);
    await readPageHandler({ depth: 3, filter: "visual" }, cdp, "s1");

    expect(cdp.send).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      { depth: 10 },
      "s1",
    );
  });

  // --- FR-H6: Hidden element hint ---

  it("FR-H6: should append hidden-element hint when >= 5 interactive elements are hidden", async () => {
    a11yTree.reset();
    const cdp = {
      send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") {
          const expr = (params?.expression as string) ?? "";
          // Hidden element detect expression contains offsetParent
          if (expr.includes("offsetParent")) {
            return Promise.resolve({ result: { value: 12 } });
          }
          // URL evaluate
          return Promise.resolve({ result: { value: "https://example.com/fr-h6" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes: sampleNodes });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

    expect(result.content[0].text).toContain("12 interactive elements are hidden");
    expect(result.content[0].text).toContain("Click tabs/buttons to reveal");
  });

  it("FR-H6: should NOT append hint when hidden count < 5", async () => {
    a11yTree.reset();
    const cdp = {
      send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") {
          const expr = (params?.expression as string) ?? "";
          if (expr.includes("offsetParent")) {
            return Promise.resolve({ result: { value: 3 } });
          }
          return Promise.resolve({ result: { value: "https://example.com/fr-h6-low" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes: sampleNodes });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

    expect(result.content[0].text).not.toContain("hidden");
  });

  it("FR-H6: should NOT run hidden detection for filter=all", async () => {
    a11yTree.reset();
    const cdp = mockCdpClient(sampleNodes, "https://example.com/fr-h6-all");
    const result = await readPageHandler({ depth: 3, filter: "all" }, cdp, "s1");

    // No hidden hint for non-interactive filters
    expect(result.content[0].text).not.toContain("hidden");
  });

  it("FR-H6: should gracefully handle evaluate failure for hidden detection", async () => {
    a11yTree.reset();
    let evalCount = 0;
    const cdp = {
      send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") {
          const expr = (params?.expression as string) ?? "";
          if (expr.includes("offsetParent")) {
            return Promise.reject(new Error("evaluate failed"));
          }
          return Promise.resolve({ result: { value: "https://example.com/fr-h6-err" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes: sampleNodes });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

    // Should still return valid result without hint
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("button");
    expect(result.content[0].text).not.toContain("hidden");
  });

  // FR-022: Hint that visible text content was filtered out by filter:interactive.
  // Prevents the LLM from falling back to evaluate/querySelector to read visible text.
  describe("FR-022: hidden content nodes hint", () => {
    const contentHeavyNodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Test Page" },
        backendDOMNodeId: 200,
        childIds: ["c1", "c2", "c3", "c4", "c5", "c6", "c7"],
      }),
      makeNode({
        nodeId: "c1", parentId: "1",
        role: { type: "role", value: "StaticText" },
        name: { type: "computedString", value: "Secret: ABC-123" },
        backendDOMNodeId: 201,
      }),
      makeNode({
        nodeId: "c2", parentId: "1",
        role: { type: "role", value: "StaticText" },
        name: { type: "computedString", value: "Value: 42" },
        backendDOMNodeId: 202,
      }),
      makeNode({
        nodeId: "c3", parentId: "1",
        role: { type: "role", value: "cell" },
        name: { type: "computedString", value: "Alpha" },
        backendDOMNodeId: 203,
      }),
      makeNode({
        nodeId: "c4", parentId: "1",
        role: { type: "role", value: "cell" },
        name: { type: "computedString", value: "Beta" },
        backendDOMNodeId: 204,
      }),
      makeNode({
        nodeId: "c5", parentId: "1",
        role: { type: "role", value: "paragraph" },
        name: { type: "computedString", value: "Some description" },
        backendDOMNodeId: 205,
      }),
      makeNode({
        nodeId: "c6", parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Submit" },
        backendDOMNodeId: 206,
      }),
      makeNode({
        nodeId: "c7", parentId: "1",
        role: { type: "role", value: "StaticText" },
        name: { type: "computedString", value: "Another label" },
        backendDOMNodeId: 207,
      }),
    ];

    it("appends content-hidden hint when filter=interactive and >= 5 content nodes hidden", async () => {
      a11yTree.reset();
      const cdp = mockCdpClient(contentHeavyNodes, "https://example.com/fr-022");
      const result = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text as string;
      expect(text).toMatch(/text\/content nodes/);
      expect(text).toMatch(/filter:\s*"all"/);
      expect(text).toMatch(/don't fall back to evaluate/);
    });

    it("does NOT append content-hidden hint for filter=all", async () => {
      a11yTree.reset();
      const cdp = mockCdpClient(contentHeavyNodes, "https://example.com/fr-022-all");
      const result = await readPageHandler({ depth: 3, filter: "all" }, cdp, "s1");

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).not.toMatch(/text\/content nodes.*hidden/);
    });

    it("does NOT append hint when < 5 content nodes hidden", async () => {
      const lightNodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 300,
          childIds: ["2", "3", "4"],
        }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "StaticText" },
          name: { type: "computedString", value: "Hello" },
          backendDOMNodeId: 301,
        }),
        makeNode({
          nodeId: "3", parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "OK" },
          backendDOMNodeId: 302,
        }),
        makeNode({
          nodeId: "4", parentId: "1",
          role: { type: "role", value: "StaticText" },
          name: { type: "computedString", value: "World" },
          backendDOMNodeId: 303,
        }),
      ];
      a11yTree.reset();
      const cdp = mockCdpClient(lightNodes, "https://example.com/fr-022-light");
      const result = await readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1");

      expect(result.content[0].text).not.toMatch(/text\/content nodes.*hidden/);
    });
  });
});
