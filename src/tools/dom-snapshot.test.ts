import { describe, it, expect, vi, beforeEach } from "vitest";
import { domSnapshotHandler, domSnapshotSchema } from "./dom-snapshot.js";
import { a11yTree } from "../cache/a11y-tree.js";
import type { CdpClient } from "../cdp/cdp-client.js";

// --- Helpers ---

function mockCdpClient(
  snapshotResponse: unknown,
  a11yNodes: unknown[] = [],
  url = "https://example.com",
): CdpClient {
  return {
    send: vi.fn().mockImplementation((method: string) => {
      if (method === "DOMSnapshot.captureSnapshot") {
        return Promise.resolve(snapshotResponse);
      }
      if (method === "Runtime.evaluate") {
        return Promise.resolve({ result: { value: url } });
      }
      if (method === "Accessibility.getFullAXTree") {
        return Promise.resolve({ nodes: a11yNodes });
      }
      return Promise.resolve({});
    }),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;
}

/**
 * Build a minimal DOMSnapshot response with the given elements.
 * Each element spec provides tag, backendNodeId, bounds, and optional attrs/styles.
 */
interface ElementSpec {
  tag: string;
  backendNodeId: number;
  parentIndex: number;
  bounds?: [number, number, number, number];
  role?: string;
  display?: string;
  visibility?: string;
  color?: string;
  bgColor?: string;
  fontSize?: string;
  paintOrder?: number;
  zIndex?: string;
}

function buildSnapshot(elements: ElementSpec[]): {
  documents: unknown[];
  strings: string[];
} {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();

  function addString(s: string): number {
    if (stringIndex.has(s)) return stringIndex.get(s)!;
    const idx = strings.length;
    strings.push(s);
    stringIndex.set(s, idx);
    return idx;
  }

  // Pre-populate empty string
  addString("");

  const parentIndexArr: number[] = [];
  const nodeTypeArr: number[] = [];
  const nodeNameArr: number[] = [];
  const nodeValueArr: number[] = [];
  const backendNodeIdArr: number[] = [];
  const attributesArr: number[][] = [];

  const layoutNodeIndex: number[] = [];
  const layoutBounds: number[][] = [];
  const layoutText: number[] = [];
  const layoutStyleProps: number[][] = [];
  const layoutPaintOrders: number[] = [];
  const layoutOffsetRects: number[][] = [];
  const layoutClientRects: number[][] = [];
  const layoutBlendedBg: number[] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    parentIndexArr.push(el.parentIndex);
    nodeTypeArr.push(1); // Element
    nodeNameArr.push(addString(el.tag));
    nodeValueArr.push(addString(""));
    backendNodeIdArr.push(el.backendNodeId);

    // Attributes: optionally include role
    const attrs: number[] = [];
    if (el.role) {
      attrs.push(addString("role"), addString(el.role));
    }
    attributesArr.push(attrs);

    // Layout data (if bounds provided)
    if (el.bounds) {
      layoutNodeIndex.push(i);
      layoutBounds.push([...el.bounds]);
      layoutText.push(addString(""));

      // Style properties in order: display, visibility, color, bg-color, font-size, position, z-index
      const styleValues = [
        addString(el.display ?? "block"),
        addString(el.visibility ?? "visible"),
        addString(el.color ?? ""),
        addString(el.bgColor ?? ""),
        addString(el.fontSize ?? ""),
        addString(el.display === "none" ? "" : "static"),
        addString(el.zIndex ?? "auto"),
      ];
      layoutStyleProps.push(styleValues);
      layoutPaintOrders.push(el.paintOrder ?? 1);
      layoutOffsetRects.push([...el.bounds]);
      layoutClientRects.push([...el.bounds]);
      layoutBlendedBg.push(addString(el.bgColor ?? ""));
    }
  }

  return {
    documents: [
      {
        documentURL: addString("https://example.com"),
        nodes: {
          parentIndex: parentIndexArr,
          nodeType: nodeTypeArr,
          nodeName: nodeNameArr,
          nodeValue: nodeValueArr,
          backendNodeId: backendNodeIdArr,
          attributes: attributesArr,
        },
        layout: {
          nodeIndex: layoutNodeIndex,
          bounds: layoutBounds,
          text: layoutText,
          styles: { properties: layoutStyleProps },
          paintOrders: layoutPaintOrders,
          offsetRects: layoutOffsetRects,
          clientRects: layoutClientRects,
          blendedBackgroundColors: layoutBlendedBg,
        },
      },
    ],
    strings,
  };
}

function makeA11yNode(
  nodeId: string,
  role: string,
  name: string,
  backendDOMNodeId: number,
  parentId?: string,
  childIds?: string[],
) {
  return {
    nodeId,
    ignored: false,
    role: { type: "role", value: role },
    name: { type: "computedString", value: name },
    backendDOMNodeId,
    parentId,
    childIds,
  };
}

// --- Tests ---

describe("domSnapshotSchema", () => {
  it("should accept empty params", () => {
    const result = domSnapshotSchema.parse({});
    expect(result.ref).toBeUndefined();
  });

  it("should accept ref parameter", () => {
    const result = domSnapshotSchema.parse({ ref: "e5" });
    expect(result.ref).toBe("e5");
  });
});

describe("domSnapshotHandler", () => {
  beforeEach(() => {
    a11yTree.reset();
  });

  it("should return empty array for empty page", async () => {
    const snapshot = { documents: [], strings: [] };
    const cdp = mockCdpClient(snapshot);

    // Pre-populate a11y tree so it doesn't try to build one
    const a11yNodes = [makeA11yNode("1", "WebArea", "Test", 1)];
    const a11yCdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(a11yCdp, "s1");

    const response = await domSnapshotHandler({}, cdp, "s1");

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toBe("[]");
    expect(response._meta?.elementCount).toBe(0);
  });

  it("should filter elements with display:none", async () => {
    const a11yNodes = [
      makeA11yNode("1", "WebArea", "Test", 1, undefined, ["2", "3"]),
      makeA11yNode("2", "button", "Visible", 10, "1"),
      makeA11yNode("3", "button", "Hidden", 20, "1"),
    ];

    const snapshot = buildSnapshot([
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
      { tag: "BUTTON", backendNodeId: 10, parentIndex: 0, bounds: [10, 10, 100, 40] },
      { tag: "BUTTON", backendNodeId: 20, parentIndex: 0, bounds: [10, 60, 100, 40], display: "none" },
    ]);

    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    const response = await domSnapshotHandler({}, cdp, "s1");
    const elements = JSON.parse(response.content[0].text);

    expect(elements.length).toBe(1);
    expect(elements[0].ref).toBe("e2");
  });

  it("should filter off-screen elements", async () => {
    const a11yNodes = [
      makeA11yNode("1", "WebArea", "Test", 1, undefined, ["2", "3"]),
      makeA11yNode("2", "button", "OnScreen", 10, "1"),
      makeA11yNode("3", "button", "OffScreen", 20, "1"),
    ];

    const snapshot = buildSnapshot([
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
      { tag: "BUTTON", backendNodeId: 10, parentIndex: 0, bounds: [100, 100, 80, 32] },
      { tag: "BUTTON", backendNodeId: 20, parentIndex: 0, bounds: [-200, -200, 80, 32] },
    ]);

    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    const response = await domSnapshotHandler({}, cdp, "s1");
    const elements = JSON.parse(response.content[0].text);

    expect(elements.length).toBe(1);
    expect(elements[0].ref).toBe("e2");
  });

  it("should enforce token budget with 500+ elements", async () => {
    // Create 200 interactive a11y nodes (more than MAX_ELEMENTS=150)
    const a11yNodes = [
      makeA11yNode("root", "WebArea", "Test", 1, undefined,
        Array.from({ length: 200 }, (_, i) => `n${i}`)),
    ];
    const snapshotElements: ElementSpec[] = [
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
    ];

    for (let i = 0; i < 200; i++) {
      a11yNodes.push(
        makeA11yNode(`n${i}`, "button", `Btn${i}`, 100 + i, "root"),
      );
      snapshotElements.push({
        tag: "BUTTON",
        backendNodeId: 100 + i,
        parentIndex: 0,
        bounds: [10 + (i % 10) * 120, 10 + Math.floor(i / 10) * 40, 100, 32],
        paintOrder: i,
      });
    }

    const snapshot = buildSnapshot(snapshotElements);
    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    const response = await domSnapshotHandler({}, cdp, "s1");
    const elements = JSON.parse(response.content[0].text);

    // Should be capped at 150
    expect(elements.length).toBeLessThanOrEqual(150);

    // NFR26: 150 elements * ~13 tokens/element = ~1950 tokens < 2000
    // Token estimation: each compact element is roughly 13 tokens
    const tokenEstimate = elements.length * 13;
    expect(tokenEstimate).toBeLessThan(2000);

    // Meta should show filteredFrom > elementCount
    expect(response._meta?.filteredFrom).toBeGreaterThan(response._meta?.elementCount as number);
  });

  it("should return only subtree when ref parameter given", async () => {
    const a11yNodes = [
      makeA11yNode("1", "WebArea", "Test", 1, undefined, ["2", "3"]),
      makeA11yNode("2", "navigation", "Nav", 10, "1", ["4", "5"]),
      makeA11yNode("3", "button", "Outside", 20, "1"),
      makeA11yNode("4", "link", "Link1", 30, "2"),
      makeA11yNode("5", "link", "Link2", 40, "2"),
    ];

    const snapshot = buildSnapshot([
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
      { tag: "NAV", backendNodeId: 10, parentIndex: 0, bounds: [0, 0, 1280, 60], role: "navigation" },
      { tag: "BUTTON", backendNodeId: 20, parentIndex: 0, bounds: [100, 200, 80, 32] },
      { tag: "A", backendNodeId: 30, parentIndex: 1, bounds: [10, 10, 80, 20] },
      { tag: "A", backendNodeId: 40, parentIndex: 1, bounds: [100, 10, 80, 20] },
    ]);

    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    // Ref e2 is the NAV element (backendNodeId=10)
    const response = await domSnapshotHandler({ ref: "e2" }, cdp, "s1");
    const elements = JSON.parse(response.content[0].text);

    // Should only contain elements from the NAV subtree (links), not the outside button
    const refs = elements.map((el: { ref: string }) => el.ref);
    expect(refs).not.toContain("e3"); // Outside button
    // Should contain the links inside nav
    expect(refs).toContain("e4");
    expect(refs).toContain("e5");
  });

  it("should include required fields on each element", async () => {
    const a11yNodes = [
      makeA11yNode("1", "WebArea", "Test", 1, undefined, ["2"]),
      makeA11yNode("2", "button", "Submit", 10, "1"),
    ];

    const snapshot = buildSnapshot([
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
      {
        tag: "BUTTON",
        backendNodeId: 10,
        parentIndex: 0,
        bounds: [120, 340, 80, 32],
        color: "#ffffff",
        bgColor: "#007bff",
        fontSize: "14px",
        paintOrder: 42,
      },
    ]);

    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    const response = await domSnapshotHandler({}, cdp, "s1");
    const elements = JSON.parse(response.content[0].text);

    expect(elements.length).toBe(1);
    const el = elements[0];
    expect(el.ref).toBe("e2");
    expect(el.tag).toBe("button");
    expect(el.role).toBe("button");
    expect(el.name).toBe("Submit");
    expect(el.bounds).toEqual({ x: 120, y: 340, w: 80, h: 32 });
    expect(el.styles.color).toBe("#ffffff");
    expect(el.styles.bg).toBe("#007bff");
    expect(el.styles.fontSize).toBe("14px");
    expect(el.isClickable).toBe(true);
    expect(el.paintOrder).toBe(42);
    expect(el.zIndex).toBeNull();
  });

  it("should return zIndex as number when set, null when auto", async () => {
    const a11yNodes = [
      makeA11yNode("1", "WebArea", "Test", 1, undefined, ["2", "3"]),
      makeA11yNode("2", "button", "WithZ", 10, "1"),
      makeA11yNode("3", "button", "AutoZ", 20, "1"),
    ];

    const snapshot = buildSnapshot([
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
      { tag: "BUTTON", backendNodeId: 10, parentIndex: 0, bounds: [10, 10, 80, 32], zIndex: "5" },
      { tag: "BUTTON", backendNodeId: 20, parentIndex: 0, bounds: [10, 50, 80, 32], zIndex: "auto" },
    ]);

    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    const response = await domSnapshotHandler({}, cdp, "s1");
    const elements = JSON.parse(response.content[0].text);

    const byRef = new Map(elements.map((el: { ref: string }) => [el.ref, el]));
    expect(byRef.get("e2")?.zIndex).toBe(5);
    expect(byRef.get("e3")?.zIndex).toBeNull();
  });

  it("should set isClickable correctly for different element types", async () => {
    const a11yNodes = [
      makeA11yNode("1", "WebArea", "Test", 1, undefined, ["2", "3", "4", "5"]),
      makeA11yNode("2", "button", "Btn", 10, "1"),
      makeA11yNode("3", "link", "Link", 20, "1"),
      makeA11yNode("4", "heading", "Title", 30, "1"),
      makeA11yNode("5", "button", "RoleBtn", 40, "1"),
    ];

    const snapshot = buildSnapshot([
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
      { tag: "BUTTON", backendNodeId: 10, parentIndex: 0, bounds: [10, 10, 80, 32] },
      { tag: "A", backendNodeId: 20, parentIndex: 0, bounds: [10, 50, 80, 20] },
      { tag: "H1", backendNodeId: 30, parentIndex: 0, bounds: [10, 80, 200, 40] },
      { tag: "IMG", backendNodeId: 40, parentIndex: 0, bounds: [10, 130, 100, 100], role: "button" },
    ]);

    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    const response = await domSnapshotHandler({}, cdp, "s1");
    const elements = JSON.parse(response.content[0].text);

    const byRef = new Map(elements.map((el: { ref: string }) => [el.ref, el]));
    expect(byRef.get("e2")?.isClickable).toBe(true);  // BUTTON
    expect(byRef.get("e3")?.isClickable).toBe(true);  // A (link)
    expect(byRef.get("e4")?.isClickable).toBe(false); // H1 (not clickable)
    expect(byRef.get("e5")?.isClickable).toBe(true);  // div[role="button"]
  });

  it("should have refs matching a11y tree", async () => {
    const a11yNodes = [
      makeA11yNode("1", "WebArea", "Test", 1, undefined, ["2", "3"]),
      makeA11yNode("2", "button", "Alpha", 10, "1"),
      makeA11yNode("3", "link", "Beta", 20, "1"),
    ];

    const snapshot = buildSnapshot([
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
      { tag: "BUTTON", backendNodeId: 10, parentIndex: 0, bounds: [10, 10, 80, 32] },
      { tag: "A", backendNodeId: 20, parentIndex: 0, bounds: [10, 50, 80, 20] },
    ]);

    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    // Verify a11y tree refs
    expect(a11yTree.resolveRef("e2")).toBe(10);
    expect(a11yTree.resolveRef("e3")).toBe(20);

    const response = await domSnapshotHandler({}, cdp, "s1");
    const elements = JSON.parse(response.content[0].text);

    const btn = elements.find((el: { ref: string }) => el.ref === "e2");
    const link = elements.find((el: { ref: string }) => el.ref === "e3");
    expect(btn).toBeDefined();
    expect(btn.name).toBe("Alpha");
    expect(link).toBeDefined();
    expect(link.name).toBe("Beta");
  });

  it("should include _meta with elapsedMs, method, elementCount, filteredFrom", async () => {
    const a11yNodes = [
      makeA11yNode("1", "WebArea", "Test", 1, undefined, ["2"]),
      makeA11yNode("2", "button", "Btn", 10, "1"),
    ];

    const snapshot = buildSnapshot([
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
      { tag: "BUTTON", backendNodeId: 10, parentIndex: 0, bounds: [10, 10, 80, 32] },
    ]);

    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    const response = await domSnapshotHandler({}, cdp, "s1");

    expect(response._meta).toBeDefined();
    expect(response._meta?.method).toBe("dom_snapshot");
    expect(response._meta?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(response._meta?.elementCount).toBe(1);
    expect(response._meta?.filteredFrom).toBeGreaterThan(0);
  });

  it("should return error for unknown ref", async () => {
    const a11yNodes = [makeA11yNode("1", "WebArea", "Test", 1)];
    const snapshot = buildSnapshot([
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
    ]);

    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    const response = await domSnapshotHandler({ ref: "e999" }, cdp, "s1");
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("e999");
  });

  it("should filter elements with visibility:hidden", async () => {
    const a11yNodes = [
      makeA11yNode("1", "WebArea", "Test", 1, undefined, ["2", "3"]),
      makeA11yNode("2", "button", "Visible", 10, "1"),
      makeA11yNode("3", "button", "Hidden", 20, "1"),
    ];

    const snapshot = buildSnapshot([
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
      { tag: "BUTTON", backendNodeId: 10, parentIndex: 0, bounds: [10, 10, 100, 40] },
      { tag: "BUTTON", backendNodeId: 20, parentIndex: 0, bounds: [10, 60, 100, 40], visibility: "hidden" },
    ]);

    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    const response = await domSnapshotHandler({}, cdp, "s1");
    const elements = JSON.parse(response.content[0].text);

    expect(elements.length).toBe(1);
    expect(elements[0].ref).toBe("e2");
  });

  it("should filter zero-size elements", async () => {
    const a11yNodes = [
      makeA11yNode("1", "WebArea", "Test", 1, undefined, ["2", "3"]),
      makeA11yNode("2", "button", "Normal", 10, "1"),
      makeA11yNode("3", "button", "ZeroSize", 20, "1"),
    ];

    const snapshot = buildSnapshot([
      { tag: "HTML", backendNodeId: 1, parentIndex: -1, bounds: [0, 0, 1280, 800] },
      { tag: "BUTTON", backendNodeId: 10, parentIndex: 0, bounds: [10, 10, 80, 32] },
      { tag: "BUTTON", backendNodeId: 20, parentIndex: 0, bounds: [10, 50, 0, 0] },
    ]);

    const cdp = mockCdpClient(snapshot, a11yNodes);
    await a11yTree.getTree(cdp, "s1");

    const response = await domSnapshotHandler({}, cdp, "s1");
    const elements = JSON.parse(response.content[0].text);

    expect(elements.length).toBe(1);
    expect(elements[0].ref).toBe("e2");
  });
});

describe("A11yTreeProcessor.getRefForBackendNodeId", () => {
  beforeEach(() => {
    a11yTree.reset();
  });

  it("should return ref string for known backendNodeId", async () => {
    const a11yNodes = [
      makeA11yNode("1", "WebArea", "Test", 1, undefined, ["2"]),
      makeA11yNode("2", "button", "Btn", 42, "1"),
    ];
    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Runtime.evaluate") return Promise.resolve({ result: { value: "https://example.com" } });
        if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: a11yNodes });
        return Promise.resolve({});
      }),
    } as unknown as CdpClient;

    await a11yTree.getTree(cdp, "s1");
    expect(a11yTree.getRefForBackendNodeId(42)).toBe("e2");
  });

  it("should return undefined for unknown backendNodeId", async () => {
    expect(a11yTree.getRefForBackendNodeId(999)).toBeUndefined();
  });
});
