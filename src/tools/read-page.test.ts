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
        styles: { properties: layoutStyleProps },
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

  // Test 6: Handler with depth
  it("should pass depth to CDP", async () => {
    const cdp = mockCdpClient(sampleNodes);
    await readPageHandler({ depth: 5, filter: "interactive" }, cdp, "s1");

    expect(cdp.send).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      { depth: 5 },
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
});
