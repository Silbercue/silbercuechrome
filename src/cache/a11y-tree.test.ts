import { describe, it, expect, vi, beforeEach } from "vitest";
import { A11yTreeProcessor, RefNotFoundError } from "./a11y-tree.js";
import type { AXNode } from "./a11y-tree.js";
import type { CdpClient } from "../cdp/cdp-client.js";

function mockCdpClient(nodes: AXNode[], url = "https://example.com"): CdpClient {
  return {
    send: vi.fn().mockImplementation((method: string) => {
      if (method === "Runtime.evaluate") {
        return Promise.resolve({ result: { value: url } });
      }
      if (method === "Accessibility.getFullAXTree") {
        return Promise.resolve({ nodes });
      }
      return Promise.resolve({});
    }),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;
}

function makeNode(overrides: Partial<AXNode> & { nodeId: string }): AXNode {
  return {
    ignored: false,
    ...overrides,
  };
}

describe("A11yTreeProcessor", () => {
  let processor: A11yTreeProcessor;

  beforeEach(() => {
    processor = new A11yTreeProcessor();
  });

  // Test 1: Empty tree
  it("should return empty result for page with no elements", async () => {
    const cdp = mockCdpClient([]);
    const result = await processor.getTree(cdp, "s1");

    expect(result.refCount).toBe(0);
    expect(result.depth).toBe(3);
    expect(result.text).toContain("0 interactive elements");
  });

  // Test 2: Simple tree with refs
  it("should assign refs e1, e2 to non-ignored nodes", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Test Page" },
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
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "Home" },
        backendDOMNodeId: 102,
        properties: [{ name: "url", value: { type: "string", value: "/home" } }],
      }),
    ];
    const cdp = mockCdpClient(nodes);
    const result = await processor.getTree(cdp, "s1");

    expect(result.refCount).toBe(2);
    // e1 = WebArea root (not rendered in interactive filter), e2 = button, e3 = link
    expect(result.text).toContain('[e2] button "Submit"');
    expect(result.text).toContain('[e3] link "Home" → /home');
  });

  // Test 3: Depth limitation — filter=all passes depth directly to CDP
  it("should respect depth parameter (filter=all passes depth directly to CDP)", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "OK" },
        backendDOMNodeId: 101,
      }),
    ];
    const cdp = mockCdpClient(nodes);
    const result = await processor.getTree(cdp, "s1", { depth: 1, filter: "all" });

    expect(result.depth).toBe(1);
    // FR-002: filter=all → CDP depth = display depth + 2 (extra levels for leaf text)
    expect(cdp.send).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      { depth: 3 },
      "s1",
    );
  });

  // Test 4: Interactive filter — button + link included, generic + StaticText excluded
  it("should include interactive roles and exclude non-interactive", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2", "3", "4"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Click" },
        backendDOMNodeId: 101,
      }),
      makeNode({
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "generic" },
        backendDOMNodeId: 102,
      }),
      makeNode({
        nodeId: "4",
        parentId: "1",
        role: { type: "role", value: "StaticText" },
        name: { type: "computedString", value: "Hello" },
        backendDOMNodeId: 103,
      }),
    ];
    const cdp = mockCdpClient(nodes);
    const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

    expect(result.text).toContain("button");
    expect(result.text).not.toContain("generic");
    expect(result.text).not.toContain("StaticText");
    expect(result.refCount).toBe(1);
  });

  // Test 5: Landmark filter
  it("should include only landmark roles with landmark filter", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2", "3"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "navigation" },
        name: { type: "computedString", value: "Main Nav" },
        backendDOMNodeId: 101,
      }),
      makeNode({
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Click" },
        backendDOMNodeId: 102,
      }),
    ];
    const cdp = mockCdpClient(nodes);
    const result = await processor.getTree(cdp, "s1", { filter: "landmark" });

    expect(result.text).toContain("navigation");
    expect(result.text).not.toContain("button");
    expect(result.refCount).toBe(1);
  });

  // Test 6: All filter
  it("should include all non-ignored nodes with all filter", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2", "3"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "generic" },
        name: { type: "computedString", value: "Container" },
        backendDOMNodeId: 101,
      }),
      makeNode({
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "OK" },
        backendDOMNodeId: 102,
      }),
    ];
    const cdp = mockCdpClient(nodes);
    const result = await processor.getTree(cdp, "s1", { filter: "all" });

    expect(result.text).toContain("generic");
    expect(result.text).toContain("button");
    // root WebArea + generic + button = 3
    expect(result.refCount).toBe(3);
  });

  // Test 7: Ref stability — same backendDOMNodeId keeps same ref
  it("should assign stable refs across calls without navigation", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "OK" },
        backendDOMNodeId: 101,
      }),
    ];
    const cdp = mockCdpClient(nodes);

    const result1 = await processor.getTree(cdp, "s1");
    const result2 = await processor.getTree(cdp, "s1");

    // Same ref numbers in both calls — e2 is the button (e1 = WebArea root)
    expect(result1.text).toContain("[e2]");
    expect(result2.text).toContain("[e2]");
  });

  // Test 8: Navigation reset — URL change resets refs
  it("should reset refs when URL changes", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "OK" },
        backendDOMNodeId: 101,
      }),
    ];

    // First call with URL A
    const cdp1 = mockCdpClient(nodes, "https://example.com/a");
    await processor.getTree(cdp1, "s1");

    // Second call with URL B — different backendDOMNodeIds (new page)
    const nodesB: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 200,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "Back" },
        backendDOMNodeId: 201,
      }),
    ];
    const cdp2 = mockCdpClient(nodesB, "https://example.com/b");
    const result = await processor.getTree(cdp2, "s1");

    // Refs reset — e1 = WebArea root, e2 = link
    expect(result.text).toContain("[e2]");
  });

  // Test 8b: Hash-only URL change preserves refs (anchor navigation)
  it("should preserve refs when only the hash changes", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Click Me" },
        backendDOMNodeId: 101,
      }),
    ];

    // First call: page without hash
    const cdp1 = mockCdpClient(nodes, "https://example.com/page");
    await processor.getTree(cdp1, "s1");
    expect(processor.resolveRef("e2")).toBe(101);

    // Second call: same page with hash — should keep refs
    const cdp2 = mockCdpClient(nodes, "https://example.com/page#section-2");
    await processor.getTree(cdp2, "s1");
    expect(processor.resolveRef("e2")).toBe(101); // ref still valid!
  });

  // Test 8c: Hash-only change still resets on real navigation
  it("should reset refs when path changes even if both have hashes", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "OK" },
        backendDOMNodeId: 101,
      }),
    ];

    // First: page-a#top
    const cdp1 = mockCdpClient(nodes, "https://example.com/page-a#top");
    await processor.getTree(cdp1, "s1");

    // Second: page-b#top — different path → reset
    const nodesB: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 200,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "Back" },
        backendDOMNodeId: 201,
      }),
    ];
    const cdp2 = mockCdpClient(nodesB, "https://example.com/page-b#top");
    const result = await processor.getTree(cdp2, "s1");

    // Refs reset — new refs assigned
    expect(processor.resolveRef("e2")).toBe(201);
  });

  // Test 9: New nodes get next ref number
  it("should assign next ref number to new DOM nodes", async () => {
    const nodes1: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "First" },
        backendDOMNodeId: 101,
      }),
    ];
    const cdp1 = mockCdpClient(nodes1);
    await processor.getTree(cdp1, "s1");

    // Invalidate precomputed cache to simulate DOM mutation (DomWatcher would do this)
    processor.invalidatePrecomputed();

    // Second call: original node + new node
    const nodes2: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2", "3"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "First" },
        backendDOMNodeId: 101,
      }),
      makeNode({
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Second" },
        backendDOMNodeId: 102,
      }),
    ];
    const cdp2 = mockCdpClient(nodes2);
    const result = await processor.getTree(cdp2, "s1");

    // e1 = WebArea root, e2 = First button (stable), e3 = Second button (new)
    expect(result.text).toContain('[e2] button "First"');
    expect(result.text).toContain('[e3] button "Second"');
  });

  // Test 10: Subtree query
  it("should return subtree for given ref", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "navigation" },
        name: { type: "computedString", value: "Nav" },
        backendDOMNodeId: 101,
        childIds: ["3"],
      }),
      makeNode({
        nodeId: "3",
        parentId: "2",
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "Home" },
        backendDOMNodeId: 102,
      }),
    ];
    const cdp = mockCdpClient(nodes);

    // First call to assign refs
    await processor.getTree(cdp, "s1", { filter: "all" });

    // Subtree query for navigation node (e2)
    const result = await processor.getTree(cdp, "s1", { ref: "e2", filter: "all" });

    expect(result.text).toContain("Subtree for e2");
    expect(result.text).toContain("navigation");
    expect(result.text).toContain("link");
  });

  // Test 11: Invalid ref
  it("should throw RefNotFoundError for invalid ref", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "OK" },
        backendDOMNodeId: 101,
      }),
    ];
    const cdp = mockCdpClient(nodes);

    // First call to assign refs
    await processor.getTree(cdp, "s1");

    // Query with invalid ref
    await expect(processor.getTree(cdp, "s1", { ref: "e99" })).rejects.toThrow(
      RefNotFoundError,
    );
  });

  // Test 12: Ignored nodes — skipped but children traversed
  it("should skip ignored nodes but render their children", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        ignored: true,
        backendDOMNodeId: 101,
        childIds: ["3"],
      }),
      makeNode({
        nodeId: "3",
        parentId: "2",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Hidden Child" },
        backendDOMNodeId: 102,
      }),
    ];
    const cdp = mockCdpClient(nodes);
    const result = await processor.getTree(cdp, "s1");

    // e1 = WebArea root, ignored node gets no ref, e2 = button child
    expect(result.text).toContain('[e2] button "Hidden Child"');
    expect(result.refCount).toBe(1);
  });

  // Test 13: Text formatting — indentation, roles, names, values
  it("should format output with correct indentation and properties", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "My Page" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Search" },
        value: { type: "string", value: "hello" },
        backendDOMNodeId: 101,
      }),
    ];
    const cdp = mockCdpClient(nodes);
    const result = await processor.getTree(cdp, "s1");

    expect(result.text).toContain("Page: My Page");
    // e1 = WebArea root, e2 = textbox
    expect(result.text).toContain('[e2] textbox "Search" value="hello"');
  });

  // Test 14: resolveRef — correct resolution
  it("should resolve ref to backendDOMNodeId", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        backendDOMNodeId: 101,
      }),
    ];
    const cdp = mockCdpClient(nodes);
    await processor.getTree(cdp, "s1");

    // e1 = backendDOMNodeId 100 (WebArea root), e2 = 101 (button)
    // But only button passes interactive filter for rendering.
    // Refs are assigned to ALL non-ignored nodes, so e1=100, e2=101
    expect(processor.resolveRef("e1")).toBe(100);
    expect(processor.resolveRef("e2")).toBe(101);
  });

  // Test 15: resolveRef — unknown ref returns undefined
  it("should return undefined for unknown ref", () => {
    expect(processor.resolveRef("e999")).toBeUndefined();
    expect(processor.resolveRef("invalid")).toBeUndefined();
  });

  // Additional: focusable custom elements pass interactive filter
  it("should include focusable elements in interactive filter", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "generic" },
        name: { type: "computedString", value: "Custom Widget" },
        backendDOMNodeId: 101,
        properties: [{ name: "focusable", value: { type: "boolean", value: true } }],
      }),
    ];
    const cdp = mockCdpClient(nodes);
    const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

    // e1 = WebArea root, e2 = focusable generic
    expect(result.text).toContain('[e2] generic "Custom Widget"');
    expect(result.refCount).toBe(1);
  });

  // Test: findClosestRef — returns closest ref with role and name
  it("findClosestRef should return closest ref with role and name", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Submit" },
        backendDOMNodeId: 101,
      }),
    ];
    const cdp = mockCdpClient(nodes);
    await processor.getTree(cdp, "s1");

    // e1 = WebArea (100), e2 = button (101). Request e99 → closest is e2
    const suggestion = processor.findClosestRef("e99");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.ref).toBe("e2");
    expect(suggestion!.role).toBe("button");
    expect(suggestion!.name).toBe("Submit");
  });

  // Test: findClosestRef — returns null on empty processor
  it("findClosestRef should return null on empty processor", () => {
    const suggestion = processor.findClosestRef("e1");
    expect(suggestion).toBeNull();
  });

  // Test: findClosestRef — returns null for invalid ref pattern
  it("findClosestRef should return null for invalid ref pattern", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "OK" },
        backendDOMNodeId: 101,
      }),
    ];
    const cdp = mockCdpClient(nodes);
    await processor.getTree(cdp, "s1");

    expect(processor.findClosestRef("invalid")).toBeNull();
  });

  // Test: findClosestRef — returns the ref itself if it exists
  it("findClosestRef should return the ref itself if it exists", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Submit" },
        backendDOMNodeId: 101,
      }),
    ];
    const cdp = mockCdpClient(nodes);
    await processor.getTree(cdp, "s1");

    // e2 exists — findClosestRef returns it
    const suggestion = processor.findClosestRef("e2");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.ref).toBe("e2");
    expect(suggestion!.role).toBe("button");
    expect(suggestion!.name).toBe("Submit");
  });

  // Test: nodeInfoMap is cleared on URL change
  it("should clear nodeInfoMap on URL change", async () => {
    const nodes1: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "OldButton" },
        backendDOMNodeId: 101,
      }),
    ];
    const cdp1 = mockCdpClient(nodes1, "https://example.com/a");
    await processor.getTree(cdp1, "s1");

    // After URL change, old refs should be gone
    const nodes2: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 200,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "NewLink" },
        backendDOMNodeId: 201,
      }),
    ];
    const cdp2 = mockCdpClient(nodes2, "https://example.com/b");
    await processor.getTree(cdp2, "s1");

    // Old ref e2 (backendNodeId 101) is gone, new e2 is "NewLink"
    const suggestion = processor.findClosestRef("e99");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.name).toBe("NewLink");
    expect(suggestion!.role).toBe("link");
  });

  // Additional: disabled elements are included but marked
  it("should mark disabled elements", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Disabled Btn" },
        backendDOMNodeId: 101,
        properties: [{ name: "disabled", value: { type: "boolean", value: true } }],
      }),
    ];
    const cdp = mockCdpClient(nodes);
    const result = await processor.getTree(cdp, "s1");

    expect(result.text).toContain('(disabled)');
  });

  // --- OOPIF tests ---

  it("getTree with multiple sessions merges A11y trees", async () => {
    const mainNodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Main Page" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Main Button" },
        backendDOMNodeId: 101,
      }),
    ];

    const oopifNodes: AXNode[] = [
      makeNode({
        nodeId: "o1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "OAuth Frame" },
        backendDOMNodeId: 200,
        childIds: ["o2"],
      }),
      makeNode({
        nodeId: "o2",
        parentId: "o1",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Email" },
        backendDOMNodeId: 201,
      }),
    ];

    // Mock CDP that returns different results per session
    const cdp = {
      send: vi.fn().mockImplementation((method: string, _params: unknown, sessionId?: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (sessionId === "oopif-s1") {
            return Promise.resolve({ nodes: oopifNodes });
          }
          return Promise.resolve({ nodes: mainNodes });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    // Mock SessionManager
    const mockSessionManager = {
      getAllSessions: () => [
        { sessionId: "s1", frameId: "main", url: "", isMain: true },
        { sessionId: "oopif-s1", frameId: "frame-1", url: "https://accounts.google.com", isMain: false },
      ],
      registerNode: vi.fn(),
    } as unknown as import("../cdp/session-manager.js").SessionManager;

    const result = await processor.getTree(cdp, "s1", { filter: "interactive" }, mockSessionManager);

    // Main frame button + OOPIF textbox should both be present
    expect(result.text).toContain('[e2] button "Main Button"');
    expect(result.text).toContain('--- iframe: https://accounts.google.com ---');
    expect(result.text).toContain('[e4] textbox "Email"');
  });

  it("OOPIF nodes get regular ref IDs in sequence", async () => {
    const mainNodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2", "3"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Btn1" },
        backendDOMNodeId: 101,
      }),
      makeNode({
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Btn2" },
        backendDOMNodeId: 102,
      }),
    ];

    const oopifNodes: AXNode[] = [
      makeNode({
        nodeId: "o1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 300,
        childIds: ["o2"],
      }),
      makeNode({
        nodeId: "o2",
        parentId: "o1",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Input" },
        backendDOMNodeId: 301,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, _params: unknown, sessionId?: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/seq" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (sessionId === "oopif-s1") return Promise.resolve({ nodes: oopifNodes });
          return Promise.resolve({ nodes: mainNodes });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const mockSessionManager = {
      getAllSessions: () => [
        { sessionId: "s1", frameId: "main", url: "", isMain: true },
        { sessionId: "oopif-s1", frameId: "f-1", url: "https://stripe.com", isMain: false },
      ],
      registerNode: vi.fn(),
    } as unknown as import("../cdp/session-manager.js").SessionManager;

    const result = await processor.getTree(cdp, "s1", { filter: "interactive" }, mockSessionManager);

    // Main: e1=WebArea(100), e2=Btn1(101), e3=Btn2(102)
    // OOPIF: e4=WebArea(300), e5=Input(301)
    // Rendered interactive: e2, e3 (main), e5 (OOPIF)
    expect(result.text).toContain("[e2] button");
    expect(result.text).toContain("[e3] button");
    expect(result.text).toContain("[e5] textbox");

    // Ref IDs should be sequential, no gaps in rendered elements
    expect(processor.resolveRef("e2")).toBe(101);
    expect(processor.resolveRef("e3")).toBe(102);
    expect(processor.resolveRef("e5")).toBe(301);
  });

  it("H5: refCount excludes separator lines", async () => {
    const mainNodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Main Btn" },
        backendDOMNodeId: 101,
      }),
    ];

    const oopifNodes: AXNode[] = [
      makeNode({
        nodeId: "o1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 200,
        childIds: ["o2"],
      }),
      makeNode({
        nodeId: "o2",
        parentId: "o1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "OOPIF Btn" },
        backendDOMNodeId: 201,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, _params: unknown, sessionId?: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/h5" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (sessionId === "oopif-s1") return Promise.resolve({ nodes: oopifNodes });
          return Promise.resolve({ nodes: mainNodes });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const mockSessionManager = {
      getAllSessions: () => [
        { sessionId: "s1", frameId: "main", url: "", isMain: true },
        { sessionId: "oopif-s1", frameId: "f-1", url: "https://oopif.example.com", isMain: false },
      ],
      registerNode: vi.fn(),
    } as unknown as import("../cdp/session-manager.js").SessionManager;

    const result = await processor.getTree(cdp, "s1", { filter: "interactive" }, mockSessionManager);

    // Should have separator line but refCount should only count element lines
    expect(result.text).toContain("--- iframe:");
    // 2 interactive elements: main button + OOPIF button (not separator)
    expect(result.refCount).toBe(2);
  });

  it("H1: removeNodesForSession cleans up refs for detached OOPIF", async () => {
    const mainNodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Main" },
        backendDOMNodeId: 101,
      }),
    ];

    const oopifNodes: AXNode[] = [
      makeNode({
        nodeId: "o1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 300,
        childIds: ["o2"],
      }),
      makeNode({
        nodeId: "o2",
        parentId: "o1",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Email" },
        backendDOMNodeId: 301,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, _params: unknown, sessionId?: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/h1" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (sessionId === "oopif-s1") return Promise.resolve({ nodes: oopifNodes });
          return Promise.resolve({ nodes: mainNodes });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const mockSessionManager = {
      getAllSessions: () => [
        { sessionId: "s1", frameId: "main", url: "", isMain: true },
        { sessionId: "oopif-s1", frameId: "f-1", url: "https://accounts.google.com", isMain: false },
      ],
      registerNode: vi.fn(),
    } as unknown as import("../cdp/session-manager.js").SessionManager;

    // Build tree first
    await processor.getTree(cdp, "s1", { filter: "interactive" }, mockSessionManager);

    // OOPIF nodes should be resolvable
    expect(processor.resolveRef("e4")).toBe(301); // OOPIF textbox

    // Simulate OOPIF detach — remove nodes for that session
    processor.removeNodesForSession("oopif-s1");

    // OOPIF refs should now be undefined
    expect(processor.resolveRef("e4")).toBeUndefined();
    // Main frame refs should still work
    expect(processor.resolveRef("e2")).toBe(101);
  });

  it("multi-session subtree query works across OOPIF nodes", async () => {
    const mainNodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Main Btn" },
        backendDOMNodeId: 101,
      }),
    ];

    const oopifNodes: AXNode[] = [
      makeNode({
        nodeId: "o1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 300,
        childIds: ["o2"],
      }),
      makeNode({
        nodeId: "o2",
        parentId: "o1",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Email" },
        backendDOMNodeId: 301,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, _params: unknown, sessionId?: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/subtree-oopif" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (sessionId === "oopif-s1") return Promise.resolve({ nodes: oopifNodes });
          return Promise.resolve({ nodes: mainNodes });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const mockSessionManager = {
      getAllSessions: () => [
        { sessionId: "s1", frameId: "main", url: "", isMain: true },
        { sessionId: "oopif-s1", frameId: "f-1", url: "https://stripe.com", isMain: false },
      ],
      registerNode: vi.fn(),
    } as unknown as import("../cdp/session-manager.js").SessionManager;

    // Build tree
    await processor.getTree(cdp, "s1", { filter: "all" }, mockSessionManager);

    // Subtree query on OOPIF root (e3=WebArea(300))
    const result = await processor.getTree(cdp, "s1", { ref: "e3", filter: "all" }, mockSessionManager);

    expect(result.text).toContain("Subtree for e3");
    expect(result.text).toContain("textbox");
  });

  it("OOPIF section shows iframe URL separator", async () => {
    const mainNodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: [],
      }),
    ];

    const oopifNodes: AXNode[] = [
      makeNode({
        nodeId: "o1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 200,
        childIds: ["o2"],
      }),
      makeNode({
        nodeId: "o2",
        parentId: "o1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Sign In" },
        backendDOMNodeId: 201,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, _params: unknown, sessionId?: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/sep" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (sessionId === "oopif-s1") return Promise.resolve({ nodes: oopifNodes });
          return Promise.resolve({ nodes: mainNodes });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const mockSessionManager = {
      getAllSessions: () => [
        { sessionId: "s1", frameId: "main", url: "", isMain: true },
        { sessionId: "oopif-s1", frameId: "f-1", url: "https://accounts.google.com/login", isMain: false },
      ],
      registerNode: vi.fn(),
    } as unknown as import("../cdp/session-manager.js").SessionManager;

    const result = await processor.getTree(cdp, "s1", { filter: "interactive" }, mockSessionManager);

    expect(result.text).toContain("--- iframe: https://accounts.google.com/login ---");
    expect(result.text).toContain('[e3] button "Sign In"');
  });

  // --- Visual enrichment tests (Story 5b.3) ---

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

  function mockCdpClientVisual(
    nodes: AXNode[],
    domSnapshot: ReturnType<typeof makeDomSnapshot>,
    url = "https://example.com/visual",
  ): CdpClient {
    return {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: url } });
        }
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes });
        }
        if (method === "DOMSnapshot.captureSnapshot") {
          return Promise.resolve(domSnapshot);
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;
  }

  it("getTree with filter visual produces lines with bounds info", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Submit" },
        backendDOMNodeId: 101,
      }),
    ];
    const snapshot = makeDomSnapshot([
      { backendNodeId: 100, nodeName: "HTML", bounds: [0, 0, 1280, 800] },
      { backendNodeId: 101, nodeName: "BUTTON", bounds: [120, 340, 80, 32] },
    ]);
    const cdp = mockCdpClientVisual(nodes, snapshot);
    const result = await processor.getTree(cdp, "s1", { filter: "visual" });

    expect(result.text).toContain("[120,340 80x32]");
    expect(result.text).toContain("click");
    expect(result.text).toContain("vis");
    expect(result.hasVisualData).toBe(true);
  });

  it("getTree with filter interactive produces lines WITHOUT bounds info (regression)", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Submit" },
        backendDOMNodeId: 101,
      }),
    ];
    const cdp = mockCdpClient(nodes, "https://example.com/noreg");
    const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

    expect(result.text).not.toContain("[120,340");
    expect(result.text).not.toContain("[hidden]");
    expect(result.hasVisualData).toBeUndefined();
  });

  it("fetchVisualData parses DOMSnapshot correctly (bounds, isClickable, isVisible)", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2", "3"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Click Me" },
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
      { backendNodeId: 101, nodeName: "BUTTON", bounds: [50, 100, 200, 40] },
      { backendNodeId: 102, nodeName: "H1", bounds: [10, 10, 500, 60] },
    ]);
    const cdp = mockCdpClientVisual(nodes, snapshot);
    const result = await processor.getTree(cdp, "s1", { filter: "visual" });

    // Button should be clickable (BUTTON tag)
    const lines = result.text.split("\n");
    const buttonLine = lines.find(l => l.includes("button"));
    expect(buttonLine).toContain("[50,100 200x40]");
    expect(buttonLine).toContain("click");
    expect(buttonLine).toContain("vis");

    // Heading should NOT be clickable (H1 is not in CLICKABLE_TAGS, heading not in CLICKABLE_ROLES)
    const headingLine = lines.find(l => l.includes("heading"));
    expect(headingLine).toContain("[10,10 500x60]");
    expect(headingLine).not.toContain("click");
    expect(headingLine).toContain("vis");
  });

  // H1: hasVisualData set to false when tree is empty but filter is visual
  it("H1: empty tree with filter visual returns hasVisualData false", async () => {
    const snapshot = makeDomSnapshot([]);
    const cdp = mockCdpClientVisual([], snapshot, "https://example.com/empty-visual");
    const result = await processor.getTree(cdp, "s1", { filter: "visual" });

    expect(result.refCount).toBe(0);
    expect(result.hasVisualData).toBe(false);
  });

  // H1: empty tree without visual filter has no hasVisualData
  it("H1: empty tree with filter interactive has no hasVisualData", async () => {
    const cdp = mockCdpClient([], "https://example.com/empty-interactive");
    const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

    expect(result.refCount).toBe(0);
    expect(result.hasVisualData).toBeUndefined();
  });

  // H2: nodes without layout (w=0, h=0) show [hidden] instead of [0,0 0x0]
  it("H2: nodes without layout show [hidden] instead of zero bounds", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2", "3"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Visible" },
        backendDOMNodeId: 101,
      }),
      makeNode({
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "NoLayout" },
        backendDOMNodeId: 102,
      }),
    ];
    // backendNodeId 102 has no bounds (not in layout) → [hidden]
    const snapshot = makeDomSnapshot([
      { backendNodeId: 100, nodeName: "HTML", bounds: [0, 0, 1280, 800] },
      { backendNodeId: 101, nodeName: "BUTTON", bounds: [50, 50, 100, 30] },
      { backendNodeId: 102, nodeName: "BUTTON" }, // no bounds → no layout
    ]);
    const cdp = mockCdpClientVisual(nodes, snapshot, "https://example.com/h2-no-layout");
    const result = await processor.getTree(cdp, "s1", { filter: "visual" });

    const lines = result.text.split("\n");
    const visibleLine = lines.find(l => l.includes("Visible"));
    const noLayoutLine = lines.find(l => l.includes("NoLayout"));

    expect(visibleLine).toContain("[50,50 100x30]");
    expect(noLayoutLine).toContain("[hidden]");
    expect(noLayoutLine).not.toContain("[0,0 0x0]");
  });

  // M1: DOMSnapshot failure falls back to tree without visual data
  it("M1: DOMSnapshot failure returns tree with hasVisualData false", async () => {
    const nodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "OK" },
        backendDOMNodeId: 101,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/m1-fail" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes });
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

    const result = await processor.getTree(cdp, "s1", { filter: "visual" });

    // Should NOT throw — returns tree without visual data
    expect(result.refCount).toBeGreaterThan(0);
    expect(result.hasVisualData).toBe(false);
    // Button should be in output without visual annotations
    expect(result.text).toContain("button");
    expect(result.text).not.toContain("[hidden]");
    expect(result.text).not.toContain("click");
  });

  // --- Downsampling tests (Story 5b.5) ---

  describe("Downsampling Pipeline", () => {
    // Helper to build a large tree with mixed elements
    function buildLargeTree(
      elementCount: number,
      url: string,
    ): { nodes: AXNode[]; cdp: CdpClient } {
      const childIds = Array.from({ length: elementCount }, (_, i) => `n${i}`);
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Large Page" },
          backendDOMNodeId: 5000,
          childIds,
        }),
        ...Array.from({ length: elementCount }, (_, i) =>
          makeNode({
            nodeId: `n${i}`,
            parentId: "root",
            role: { type: "role", value: i % 3 === 0 ? "button" : i % 3 === 1 ? "heading" : "navigation" },
            name: { type: "computedString", value: `Element ${i} with a longer description text` },
            backendDOMNodeId: 5001 + i,
          }),
        ),
      ];
      const cdp = mockCdpClient(nodes, url);
      return { nodes, cdp };
    }

    it("should NOT downsample when max_tokens is not set", async () => {
      const { cdp } = buildLargeTree(20, "https://example.com/no-ds-tree");
      const result = await processor.getTree(cdp, "s1", { filter: "all" });

      expect(result.downsampled).toBeUndefined();
      expect(result.text).toContain("[e");
    });

    it("should NOT downsample when max_tokens exceeds output", async () => {
      const { cdp } = buildLargeTree(5, "https://example.com/small-tree");
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 99999 });

      expect(result.downsampled).toBeUndefined();
    });

    it("should downsample when output exceeds max_tokens", async () => {
      const { cdp } = buildLargeTree(60, "https://example.com/big-tree-ds");
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 500 });

      expect(result.downsampled).toBe(true);
      expect(result.originalTokens).toBeGreaterThan(500);
      expect(result.downsampleLevel).toBeDefined();
      expect(result.downsampleLevel).toBeGreaterThanOrEqual(0);
      expect(result.downsampleLevel).toBeLessThanOrEqual(4);
    });

    it("should ALWAYS preserve interactive elements", async () => {
      // Build tree with buttons and many container/content elements
      const childIds = ["btn1", "btn2", ...Array.from({ length: 40 }, (_, i) => `p${i}`)];
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Interactive Test" },
          backendDOMNodeId: 6000,
          childIds,
        }),
        makeNode({
          nodeId: "btn1",
          parentId: "root",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Submit" },
          backendDOMNodeId: 6001,
        }),
        makeNode({
          nodeId: "btn2",
          parentId: "root",
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: "More Info" },
          backendDOMNodeId: 6002,
        }),
        ...Array.from({ length: 40 }, (_, i) =>
          makeNode({
            nodeId: `p${i}`,
            parentId: "root",
            role: { type: "role", value: "paragraph" },
            name: { type: "computedString", value: `Long paragraph text ${i} that contributes many tokens to the total output size` },
            backendDOMNodeId: 6003 + i,
          }),
        ),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/interactive-preserve");
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 600 });

      expect(result.downsampled).toBe(true);
      expect(result.text).toContain("button");
      expect(result.text).toContain("Submit");
      expect(result.text).toContain("link");
      expect(result.text).toContain("More Info");
    });

    it("should merge containers at higher levels", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Container Test" },
          backendDOMNodeId: 7000,
          childIds: ["nav1", ...Array.from({ length: 30 }, (_, i) => `para${i}`)],
        }),
        makeNode({
          nodeId: "nav1",
          parentId: "root",
          role: { type: "role", value: "navigation" },
          name: { type: "computedString", value: "Main" },
          backendDOMNodeId: 7001,
          childIds: ["link1"],
        }),
        makeNode({
          nodeId: "link1",
          parentId: "nav1",
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: "Home" },
          backendDOMNodeId: 7002,
        }),
        ...Array.from({ length: 30 }, (_, i) =>
          makeNode({
            nodeId: `para${i}`,
            parentId: "root",
            role: { type: "role", value: "paragraph" },
            name: { type: "computedString", value: `Paragraph ${i} with enough text to force high-level downsampling in the pipeline` },
            backendDOMNodeId: 7003 + i,
          }),
        ),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/container-merge");
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 500 });

      expect(result.downsampled).toBe(true);
      // At level 3+, navigation should be rendered as one-line summary
      if (result.downsampleLevel! >= 3) {
        expect(result.text).toContain("[nav:");
      }
      // Interactive elements always preserved
      expect(result.text).toContain("link");
      expect(result.text).toContain("Home");
    });

    it("should convert content to compact Markdown at level 4", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Markdown Test" },
          backendDOMNodeId: 8000,
          childIds: ["h1", ...Array.from({ length: 40 }, (_, i) => `txt${i}`)],
        }),
        makeNode({
          nodeId: "h1",
          parentId: "root",
          role: { type: "role", value: "heading" },
          name: { type: "computedString", value: "Products" },
          backendDOMNodeId: 8001,
        }),
        ...Array.from({ length: 40 }, (_, i) =>
          makeNode({
            nodeId: `txt${i}`,
            parentId: "root",
            role: { type: "role", value: "paragraph" },
            name: { type: "computedString", value: `Product description number ${i} with enough text to trigger level 4 downsampling` },
            backendDOMNodeId: 8002 + i,
          }),
        ),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/markdown-test");
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 500 });

      if (result.downsampleLevel === 4) {
        // Heading should become Markdown `# Products`
        expect(result.text).toContain("# Products");
      }
    });

    it("should preserve hierarchy (indent levels) in downsampled output", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Hierarchy" },
          backendDOMNodeId: 9000,
          childIds: ["nav1", ...Array.from({ length: 30 }, (_, i) => `filler${i}`)],
        }),
        makeNode({
          nodeId: "nav1",
          parentId: "root",
          role: { type: "role", value: "navigation" },
          name: { type: "computedString", value: "Nav" },
          backendDOMNodeId: 9001,
          childIds: ["btn1"],
        }),
        makeNode({
          nodeId: "btn1",
          parentId: "nav1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Click" },
          backendDOMNodeId: 9002,
        }),
        ...Array.from({ length: 30 }, (_, i) =>
          makeNode({
            nodeId: `filler${i}`,
            parentId: "root",
            role: { type: "role", value: "paragraph" },
            name: { type: "computedString", value: `Filler paragraph ${i} that adds tokens to force downsampling to kick in` },
            backendDOMNodeId: 9003 + i,
          }),
        ),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/hierarchy-test");
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 600 });

      expect(result.downsampled).toBe(true);
      // Button should have indent (child of nav)
      const lines = result.text.split("\n");
      const btnLine = lines.find((l: string) => l.includes("button") && l.includes("Click"));
      expect(btnLine).toBeDefined();
      // Button should be indented (at least 2 spaces)
      expect(btnLine!.startsWith("  ")).toBe(true);
    });

    it("should include downsampled header info", async () => {
      const { cdp } = buildLargeTree(60, "https://example.com/header-ds");
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 500 });

      expect(result.downsampled).toBe(true);
      expect(result.text).toContain("downsampled");
      expect(result.text).toContain("tokens");
    });

    it("should truncate as last resort with marker", async () => {
      // Create a huge tree that even level 4 can't compress enough.
      // Ticket-1 Token-Aggregation collapses ≥10 consecutive same-class
      // sibling leaves, so we deliberately give each button a unique word
      // (no shared prefix, no trailing-digit pattern) to bypass it and
      // exercise the truncation code path.
      const uniqueWords = [
        "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf",
        "hotel", "india", "juliet", "kilo", "lima", "mike", "november",
        "oscar", "papa", "quebec", "romeo", "sierra", "tango",
      ];
      const childIds = Array.from({ length: 200 }, (_, i) => `b${i}`);
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Huge Page" },
          backendDOMNodeId: 10000,
          childIds,
        }),
        ...Array.from({ length: 200 }, (_, i) =>
          makeNode({
            nodeId: `b${i}`,
            parentId: "root",
            role: { type: "role", value: "button" },
            name: {
              type: "computedString",
              // Each name is structurally unique: a word from the rotating
              // dictionary plus a long unique tail string. No shared
              // alphabetic prefix between adjacent buttons → aggregator
              // never matches → original truncation path runs.
              value: `${uniqueWords[i % uniqueWords.length]}-button-${i.toString(36)}-payload`,
            },
            backendDOMNodeId: 10001 + i,
          }),
        ),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/truncate-test");
      const result = await processor.getTree(cdp, "s1", { filter: "interactive", max_tokens: 500 });

      expect(result.downsampled).toBe(true);
      // Should truncate since 200 unique buttons can't fit in 500 tokens
      // even at L4 (and the aggregator doesn't apply to non-similar names).
      expect(result.text).toContain("truncated");
      expect(result.text).toContain("omitted");
    });
  });

  // --- Precomputed Cache tests (Story 7.4) ---

  describe("Precomputed Cache", () => {
    it("invalidatePrecomputed() setzt Cache zurueck", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "OK" },
          backendDOMNodeId: 101,
        }),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/pc-invalidate");

      // Prime cache via refreshPrecomputed
      await processor.refreshPrecomputed(cdp, "s1");
      expect(processor.hasPrecomputed("s1")).toBe(true);

      // Invalidate
      processor.invalidatePrecomputed();
      expect(processor.hasPrecomputed("s1")).toBe(false);
    });

    it("refreshPrecomputed() laedt Tree und cached Nodes", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Submit" },
          backendDOMNodeId: 101,
        }),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/pc-refresh");

      await processor.refreshPrecomputed(cdp, "s1");

      expect(processor.hasPrecomputed("s1")).toBe(true);
      // Should have called Accessibility.getFullAXTree
      expect(cdp.send).toHaveBeenCalledWith(
        "Accessibility.getFullAXTree",
        { depth: 3 },
        "s1",
      );
    });

    it("refreshPrecomputed() weist stabile Refs zu (bestehende Refs bleiben)", async () => {
      const nodes1: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "First" },
          backendDOMNodeId: 101,
        }),
      ];
      const cdp1 = mockCdpClient(nodes1, "https://example.com/pc-stable");
      await processor.refreshPrecomputed(cdp1, "s1");

      // e1 = WebArea (100), e2 = button (101)
      expect(processor.resolveRef("e1")).toBe(100);
      expect(processor.resolveRef("e2")).toBe(101);

      // Second refresh with new node — existing refs should stay
      const nodes2: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2", "3"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "First" },
          backendDOMNodeId: 101,
        }),
        makeNode({
          nodeId: "3",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Second" },
          backendDOMNodeId: 102,
        }),
      ];
      const cdp2 = mockCdpClient(nodes2, "https://example.com/pc-stable");
      await processor.refreshPrecomputed(cdp2, "s1");

      // Old refs stable, new node gets e3
      expect(processor.resolveRef("e1")).toBe(100);
      expect(processor.resolveRef("e2")).toBe(101);
      expect(processor.resolveRef("e3")).toBe(102);
    });

    it("refreshPrecomputed() bei URL-Aenderung: reset() wird aufgerufen", async () => {
      const nodes1: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Old" },
          backendDOMNodeId: 101,
        }),
      ];
      const cdp1 = mockCdpClient(nodes1, "https://example.com/page-a");
      // Set lastUrl by calling getTree first
      await processor.getTree(cdp1, "s1");
      expect(processor.resolveRef("e2")).toBe(101);

      // Refresh with different URL — should reset
      const nodes2: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 200,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: "New" },
          backendDOMNodeId: 201,
        }),
      ];
      const cdp2 = mockCdpClient(nodes2, "https://example.com/page-b");
      await processor.refreshPrecomputed(cdp2, "s1");

      // Old refs should be gone (reset cleared them), new refs start from e1
      expect(processor.resolveRef("e1")).toBe(200);
      expect(processor.resolveRef("e2")).toBe(201);
    });

    it("hasPrecomputed() gibt true bei gueltigem Cache", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
        }),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/pc-has-true");
      await processor.refreshPrecomputed(cdp, "s1");

      expect(processor.hasPrecomputed("s1")).toBe(true);
    });

    it("hasPrecomputed() gibt false bei invalidiertem Cache", () => {
      expect(processor.hasPrecomputed("s1")).toBe(false);
    });

    it("hasPrecomputed() gibt false bei falscher sessionId", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
        }),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/pc-wrong-session");
      await processor.refreshPrecomputed(cdp, "s1");

      expect(processor.hasPrecomputed("s2")).toBe(false);
    });

    it("getTree() nutzt Cache bei Cache-Hit (kein Accessibility.getFullAXTree Call)", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Cached Page" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Cached Button" },
          backendDOMNodeId: 101,
        }),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/pc-cache-hit");

      // Prime the cache
      await processor.refreshPrecomputed(cdp, "s1");

      // Reset call count
      (cdp.send as ReturnType<typeof vi.fn>).mockClear();

      // getTree should use cached nodes — filter=all with depth=1 → cdpFetchDepth=3 matches cached depth=3
      const result = await processor.getTree(cdp, "s1", { filter: "all", depth: 1 });

      // Should have called Runtime.evaluate (URL check) but NOT Accessibility.getFullAXTree
      const calls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
      const a11yCalls = calls.filter((c: unknown[]) => c[0] === "Accessibility.getFullAXTree");
      expect(a11yCalls).toHaveLength(0);

      // But Runtime.evaluate for URL should still be called
      const evalCalls = calls.filter((c: unknown[]) => c[0] === "Runtime.evaluate");
      expect(evalCalls.length).toBeGreaterThan(0);

      // Result should contain the cached button
      expect(result.text).toContain('[e2] button "Cached Button"');
    });

    it("getTree() faellt auf CDP zurueck bei Cache-Miss", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Fresh" },
          backendDOMNodeId: 101,
        }),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/pc-cache-miss");

      // No cache primed — should fall back to CDP
      // FR-002: default filter=interactive → cdpFetchDepth = max(3, 10) = 10
      const result = await processor.getTree(cdp, "s1");

      // Should have called Accessibility.getFullAXTree with cdpFetchDepth=10
      expect(cdp.send).toHaveBeenCalledWith(
        "Accessibility.getFullAXTree",
        { depth: 10 },
        "s1",
      );
      expect(result.text).toContain('[e2] button "Fresh"');
    });

    it("getTree() mit ref-Parameter: immer frisch (kein Cache)", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "SubButton" },
          backendDOMNodeId: 101,
        }),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/pc-subtree");

      // Prime cache
      await processor.refreshPrecomputed(cdp, "s1");
      (cdp.send as ReturnType<typeof vi.fn>).mockClear();

      // Subtree query — should bypass cache
      const result = await processor.getTree(cdp, "s1", { ref: "e2", filter: "all" });

      // Should have called Accessibility.getFullAXTree (bypassed cache)
      const calls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
      const a11yCalls = calls.filter((c: unknown[]) => c[0] === "Accessibility.getFullAXTree");
      expect(a11yCalls.length).toBeGreaterThan(0);

      expect(result.text).toContain("Subtree for e2");
    });

    it("M2: Cache-Miss (Fallback) primes Precomputed-Cache, next call is Cache-Hit", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Prime Test" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Primed" },
          backendDOMNodeId: 101,
        }),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/pc-prime-fallback");

      // No cache primed — first call is a cache miss / fallback
      expect(processor.hasPrecomputed("s1")).toBe(false);
      const result1 = await processor.getTree(cdp, "s1");
      expect(result1.text).toContain('[e2] button "Primed"');

      // After fallback, cache should be primed
      expect(processor.hasPrecomputed("s1")).toBe(true);

      // Reset call count to verify second call is a cache hit
      (cdp.send as ReturnType<typeof vi.fn>).mockClear();

      // Second call should be a cache hit — no Accessibility.getFullAXTree call
      const result2 = await processor.getTree(cdp, "s1");
      const calls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
      const a11yCalls = calls.filter((c: unknown[]) => c[0] === "Accessibility.getFullAXTree");
      expect(a11yCalls).toHaveLength(0);
      expect(result2.text).toContain('[e2] button "Primed"');
    });

    it("M1: Depth-Mismatch fuehrt zu Cache-Miss", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Deep" },
          backendDOMNodeId: 101,
        }),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/pc-depth-mismatch");

      // Prime cache at default depth (3)
      await processor.refreshPrecomputed(cdp, "s1");
      (cdp.send as ReturnType<typeof vi.fn>).mockClear();

      // filter=all → cdpFetchDepth = depth + 2 = 7, exceeds cached depth 3 → cache miss
      await processor.getTree(cdp, "s1", { depth: 5, filter: "all" });
      const calls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
      const a11yCalls = calls.filter((c: unknown[]) => c[0] === "Accessibility.getFullAXTree");
      expect(a11yCalls.length).toBeGreaterThan(0);
      // Should have requested depth 5 + 2 = 7 (extra levels for leaf text)
      expect(a11yCalls[0][1]).toEqual({ depth: 7 });
    });

    it("M1: Depth kleiner-gleich Cache-Depth ist Cache-Hit", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Shallow" },
          backendDOMNodeId: 101,
        }),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/pc-depth-hit");

      // Prime cache at default depth (3)
      await processor.refreshPrecomputed(cdp, "s1");
      (cdp.send as ReturnType<typeof vi.fn>).mockClear();

      // filter=all → cdpFetchDepth = depth + 2 = 3, matches cached depth 3 → cache hit
      await processor.getTree(cdp, "s1", { depth: 1, filter: "all" });
      const calls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
      const a11yCalls = calls.filter((c: unknown[]) => c[0] === "Accessibility.getFullAXTree");
      expect(a11yCalls).toHaveLength(0);
    });

    it("reset() invalidiert auch Precomputed-Cache", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
        }),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/pc-reset");
      await processor.refreshPrecomputed(cdp, "s1");
      expect(processor.hasPrecomputed("s1")).toBe(true);

      processor.reset();
      expect(processor.hasPrecomputed("s1")).toBe(false);
    });
  });

  // --- refCount (Story 7.5) ---

  describe("refCount", () => {
    it("refCount returns 0 for empty processor", () => {
      expect(processor.refCount).toBe(0);
    });

    it("refCount returns correct count after getTree()", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
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
          role: { type: "role", value: "textbox" },
          name: { type: "computedString", value: "Name" },
          backendDOMNodeId: 102,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");

      // WebArea is typically counted as a ref too, plus the 2 interactive elements
      expect(processor.refCount).toBeGreaterThanOrEqual(2);
    });
  });

  // --- Story 13.1: Ambient Page Context ---

  describe("cacheVersion", () => {
    it("starts at 0 and increments on reset()", () => {
      const v0 = processor.cacheVersion;
      processor.reset();
      expect(processor.cacheVersion).toBeGreaterThan(v0);
    });

    it("increments on invalidatePrecomputed()", () => {
      const v0 = processor.cacheVersion;
      processor.invalidatePrecomputed();
      expect(processor.cacheVersion).toBeGreaterThan(v0);
    });

    it("increments on refreshPrecomputed()", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Test" },
          backendDOMNodeId: 1,
          childIds: [],
        }),
      ];
      const cdp = mockCdpClient(nodes);
      const v0 = processor.cacheVersion;
      await processor.refreshPrecomputed(cdp, "s1");
      expect(processor.cacheVersion).toBeGreaterThan(v0);
    });
  });

  describe("getCompactSnapshot", () => {
    it("returns null for empty processor", () => {
      expect(processor.getCompactSnapshot()).toBeNull();
    });

    it("returns compact snapshot of interactive elements after getTree()", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Test Page" },
          backendDOMNodeId: 1,
          childIds: ["2", "3", "4"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Submit" },
          backendDOMNodeId: 2,
        }),
        makeNode({
          nodeId: "3",
          parentId: "1",
          role: { type: "role", value: "heading" },
          name: { type: "computedString", value: "Title" },
          backendDOMNodeId: 3,
        }),
        makeNode({
          nodeId: "4",
          parentId: "1",
          role: { type: "role", value: "textbox" },
          name: { type: "computedString", value: "Email" },
          backendDOMNodeId: 4,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");

      const snapshot = processor.getCompactSnapshot();
      expect(snapshot).not.toBeNull();
      // Story 13a.2: Should contain interactive elements AND context roles (headings)
      expect(snapshot).toContain("button 'Submit'");
      expect(snapshot).toContain("textbox 'Email'");
      expect(snapshot).toContain('[h1] "Title"'); // enriched: headings included
      // Should have header
      expect(snapshot).toContain("Page Context");
      expect(snapshot).toContain("interactive");
    });

    it("respects maxTokens budget", async () => {
      // Create many interactive elements
      const children: AXNode[] = [];
      for (let i = 2; i <= 50; i++) {
        children.push(
          makeNode({
            nodeId: `${i}`,
            parentId: "1",
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: `Button number ${i} with a longer name` },
            backendDOMNodeId: i,
          }),
        );
      }
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Test" },
          backendDOMNodeId: 1,
          childIds: children.map((c) => c.nodeId),
        }),
        ...children,
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");

      // Very tight budget — should truncate
      const snapshot = processor.getCompactSnapshot(20);
      expect(snapshot).not.toBeNull();
      expect(snapshot).toContain("... (");
      expect(snapshot).toContain("more)");
    });

    it("excludes non-interactive roles", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Test" },
          backendDOMNodeId: 1,
          childIds: ["2", "3"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "paragraph" },
          name: { type: "computedString", value: "Some text" },
          backendDOMNodeId: 2,
        }),
        makeNode({
          nodeId: "3",
          parentId: "1",
          role: { type: "role", value: "generic" },
          name: { type: "computedString", value: "" },
          backendDOMNodeId: 3,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");

      // No interactive or context elements → null
      const snapshot = processor.getCompactSnapshot();
      expect(snapshot).toBeNull();
    });
  });

  // --- Story 13a.2: classifyRef + Enriched Snapshot ---

  describe("classifyRef", () => {
    it("returns 'widget-state' for element with expanded property", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2"] }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Toggle" },
          backendDOMNodeId: 2,
          properties: [{ name: "expanded", value: { type: "boolean", value: false } }],
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");
      // e1 = WebArea, e2 = button
      expect(processor.classifyRef("e2")).toBe("widget-state");
    });

    it("returns 'disabled' for disabled element", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2"] }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Disabled" },
          backendDOMNodeId: 2,
          properties: [{ name: "disabled", value: { type: "boolean", value: true } }],
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");
      expect(processor.classifyRef("e2")).toBe("disabled");
    });

    it("returns 'clickable' for interactive role without widget-state", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2"] }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Simple" },
          backendDOMNodeId: 2,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");
      expect(processor.classifyRef("e2")).toBe("clickable");
    });

    it("returns 'static' for non-interactive role", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2"] }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "paragraph" },
          name: { type: "computedString", value: "Text" },
          backendDOMNodeId: 2,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");
      expect(processor.classifyRef("e2")).toBe("static");
    });

    it("returns 'widget-state' for element with hasPopup='menu'", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2"] }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Menu" },
          backendDOMNodeId: 2,
          properties: [{ name: "hasPopup", value: { type: "token", value: "menu" } }],
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");
      expect(processor.classifyRef("e2")).toBe("widget-state");
    });

    it("returns 'clickable' (not widget-state) for hasPopup='false'", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2"] }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "NoPopup" },
          backendDOMNodeId: 2,
          properties: [{ name: "hasPopup", value: { type: "token", value: "false" } }],
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");
      expect(processor.classifyRef("e2")).toBe("clickable");
    });

    it("returns 'widget-state' for element with checked property", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2"] }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "checkbox" },
          name: { type: "computedString", value: "Accept" },
          backendDOMNodeId: 2,
          properties: [{ name: "checked", value: { type: "tristate", value: "false" } }],
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");
      expect(processor.classifyRef("e2")).toBe("widget-state");
    });

    it("returns 'widget-state' for element with pressed property", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2"] }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Toggle" },
          backendDOMNodeId: 2,
          properties: [{ name: "pressed", value: { type: "tristate", value: "true" } }],
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");
      expect(processor.classifyRef("e2")).toBe("widget-state");
    });

    it("returns 'static' for unknown ref", () => {
      expect(processor.classifyRef("e999")).toBe("static");
    });
  });

  describe("enriched getCompactSnapshot", () => {
    it("includes alerts in snapshot", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2", "3"] }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "alert" },
          name: { type: "computedString", value: "Error loading data" },
          backendDOMNodeId: 2,
        }),
        makeNode({
          nodeId: "3", parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Retry" },
          backendDOMNodeId: 3,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");

      const snapshot = processor.getCompactSnapshot();
      expect(snapshot).toContain('[alert] "Error loading data"');
      expect(snapshot).toContain("button 'Retry'");
    });

    it("includes heading with level", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2", "3"] }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "heading" },
          name: { type: "computedString", value: "Dashboard" },
          backendDOMNodeId: 2,
          properties: [{ name: "level", value: { type: "integer", value: 2 } }],
        }),
        makeNode({
          nodeId: "3", parentId: "1",
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: "Home" },
          backendDOMNodeId: 3,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");

      const snapshot = processor.getCompactSnapshot();
      expect(snapshot).toContain('[h2] "Dashboard"');
      expect(snapshot).toContain("link 'Home'");
    });

    it("context roles appear before interactive elements", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2", "3"] }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Click" },
          backendDOMNodeId: 2,
        }),
        makeNode({
          nodeId: "3", parentId: "1",
          role: { type: "role", value: "heading" },
          name: { type: "computedString", value: "Title" },
          backendDOMNodeId: 3,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");

      const snapshot = processor.getCompactSnapshot()!;
      const headingIdx = snapshot.indexOf('[h1] "Title"');
      const buttonIdx = snapshot.indexOf("button 'Click'");
      expect(headingIdx).toBeLessThan(buttonIdx);
    });
  });

  describe("FR-002: getSnapshotMap", () => {
    it("returns map with role and name for all relevant nodes", async () => {
      const nodes: AXNode[] = [
        makeNode({ nodeId: "1", role: { type: "role", value: "WebArea" }, backendDOMNodeId: 1, childIds: ["2", "3"] }),
        makeNode({ nodeId: "2", role: { type: "role", value: "button" }, name: { type: "string", value: "Submit" }, backendDOMNodeId: 2 }),
        makeNode({ nodeId: "3", role: { type: "role", value: "heading" }, name: { type: "string", value: "Title" }, backendDOMNodeId: 3, properties: [{ name: "level", value: { type: "integer", value: 1 } }] }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.getTree(cdp, "s1");

      const map = processor.getSnapshotMap();
      expect(map.size).toBe(2); // button + heading (WebArea has no name)
      // Check that values encode role\0name
      const values = [...map.values()];
      expect(values).toContainEqual("button\0Submit");
      expect(values).toContainEqual("heading\0Title");
    });

    it("returns empty map when no nodes", () => {
      const map = processor.getSnapshotMap();
      expect(map.size).toBe(0);
    });
  });

  describe("FR-002: diffSnapshots", () => {
    it("detects added nodes", () => {
      const before = new Map<number, string>([[1, "button\0Submit"]]);
      const after = new Map<number, string>([
        [1, "button\0Submit"],
        [2, "alert\0Success!"],
      ]);
      const changes = A11yTreeProcessor.diffSnapshots(before, after);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ type: "added", ref: "e2", role: "alert", after: "Success!" });
    });

    it("detects removed nodes", () => {
      const before = new Map<number, string>([
        [1, "button\0Submit"],
        [2, "alert\0Error"],
      ]);
      const after = new Map<number, string>([[1, "button\0Submit"]]);
      const changes = A11yTreeProcessor.diffSnapshots(before, after);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ type: "removed", ref: "e2", role: "alert", after: "", before: "Error" });
    });

    it("detects changed text", () => {
      const before = new Map<number, string>([[1, "status\0PENDING"]]);
      const after = new Map<number, string>([[1, "status\0PASS"]]);
      const changes = A11yTreeProcessor.diffSnapshots(before, after);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ type: "changed", ref: "e1", role: "status", before: "PENDING", after: "PASS" });
    });

    it("ignores unchanged nodes", () => {
      const before = new Map<number, string>([[1, "button\0Submit"], [2, "heading\0Title"]]);
      const after = new Map<number, string>([[1, "button\0Submit"], [2, "heading\0Title"]]);
      const changes = A11yTreeProcessor.diffSnapshots(before, after);
      expect(changes).toHaveLength(0);
    });

    it("ignores role-only changes when name stays same", () => {
      const before = new Map<number, string>([[1, "generic\0text"]]);
      const after = new Map<number, string>([[1, "paragraph\0text"]]);
      const changes = A11yTreeProcessor.diffSnapshots(before, after);
      expect(changes).toHaveLength(0); // name didn't change
    });

    it("skips nodes without names in added/removed", () => {
      const before = new Map<number, string>([[1, "generic\0"]]);
      const after = new Map<number, string>();
      const changes = A11yTreeProcessor.diffSnapshots(before, after);
      expect(changes).toHaveLength(0); // empty name → skip
    });
  });

  describe("FR-002: formatDomDiff", () => {
    it("formats changes with header and type labels", () => {
      const changes = [
        { type: "added" as const, ref: "e5", role: "alert", after: "Saved!" },
        { type: "changed" as const, ref: "e3", role: "status", before: "PENDING", after: "PASS" },
      ];
      const text = A11yTreeProcessor.formatDomDiff(changes, "https://example.com/page")!;
      expect(text).toContain("--- Action Result (2 changes)");
      expect(text).toContain("/page");
      expect(text).toContain('NEW');
      expect(text).toContain('"Saved!"');
      expect(text).toContain('CHANGED');
      expect(text).toContain('"PENDING" → "PASS"');
    });

    it("sorts alerts/status before other changes", () => {
      const changes = [
        { type: "changed" as const, ref: "e1", role: "button", before: "Old", after: "New" },
        { type: "added" as const, ref: "e2", role: "alert", after: "Alert!" },
      ];
      const text = A11yTreeProcessor.formatDomDiff(changes)!;
      const alertIdx = text.indexOf("Alert!");
      const buttonIdx = text.indexOf("New");
      expect(alertIdx).toBeLessThan(buttonIdx);
    });

    it("returns null for empty changes", () => {
      expect(A11yTreeProcessor.formatDomDiff([])).toBeNull();
    });
  });

  // --- FR-H6: Tab selected state annotation ---
  describe("FR-H6: tab selected annotation", () => {
    it("should annotate selected tab with (selected)", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Tabs Page" },
          backendDOMNodeId: 900,
          childIds: ["2", "3", "4"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "tab" },
          name: { type: "computedString", value: "Basics" },
          backendDOMNodeId: 901,
          properties: [{ name: "selected", value: { type: "boolean", value: true } }],
        }),
        makeNode({
          nodeId: "3",
          parentId: "1",
          role: { type: "role", value: "tab" },
          name: { type: "computedString", value: "Advanced" },
          backendDOMNodeId: 902,
          properties: [{ name: "selected", value: { type: "boolean", value: false } }],
        }),
        makeNode({
          nodeId: "4",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Submit" },
          backendDOMNodeId: 903,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

      expect(result.text).toContain('tab "Basics" (selected)');
      expect(result.text).not.toContain('tab "Advanced" (selected)');
      expect(result.text).toContain('tab "Advanced"');
      expect(result.text).not.toContain('button "Submit" (selected)');
    });

    it("truncates at 30 lines", () => {
      const changes = Array.from({ length: 35 }, (_, i) => ({
        type: "added" as const, ref: `e${i}`, role: "button", after: `Button ${i}`,
      }));
      const text = A11yTreeProcessor.formatDomDiff(changes)!;
      expect(text).toContain("5 more changes");
    });
  });

  // FR-021: When a clickable generic has its innerText truncated to 80 chars
  // during FR-H5 enrichment, formatLine must surface the truncation with a
  // "+N chars" marker so the LLM knows there's more text available via filter:'all'.
  describe("Name truncation marker (FR-021)", () => {
    function cdpForTruncatedGeneric(opts: { innerText: string; nodes: AXNode[] }) {
      return {
        send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") {
            return Promise.resolve({ result: { value: "https://example.com/fr-021" } });
          }
          if (method === "Accessibility.getFullAXTree") {
            return Promise.resolve({ nodes: opts.nodes });
          }
          if (method === "DOM.describeNode") {
            // Make the generic "clickable" by returning an onclick attribute
            return Promise.resolve({ node: { attributes: ["onclick", "doSomething()"] } });
          }
          if (method === "DOM.resolveNode") {
            return Promise.resolve({ object: { objectId: "fake-obj-1" } });
          }
          if (method === "Runtime.callFunctionOn") {
            const t = opts.innerText;
            // FR-021 enrichment protocol: first 80 chars + \x00 + full length
            return Promise.resolve({ result: { value: t.slice(0, 80) + "\x00" + t.length } });
          }
          if (method === "Runtime.releaseObject") return Promise.resolve({});
          return Promise.resolve({});
        }),
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
      } as unknown as CdpClient;
    }

    it("appends '…[+N chars]' marker when generic name was truncated", async () => {
      const proc = new A11yTreeProcessor();
      const longText =
        "T1.2 Read Text Content — Lies den versteckten Wert aus dem Element und gib ihn in das Eingabefeld ein. Der geheime Code lautet: QMQ1-BPAD";
      expect(longText.length).toBeGreaterThan(80);
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 500,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2", parentId: "1",
          // No name — triggers FR-H5 enrichment path
          role: { type: "role", value: "generic" },
          backendDOMNodeId: 501,
        }),
      ];
      const cdp = cdpForTruncatedGeneric({ innerText: longText, nodes });
      const result = await proc.getTree(cdp, "s1", { filter: "interactive" });

      // Marker should include the extra-char count and direct the LLM to filter:'all'
      expect(result.text).toMatch(/…\[\+\d+ chars; use filter:"all"/);
    });

    it("does NOT append marker when innerText fits in 80 chars", async () => {
      const proc = new A11yTreeProcessor();
      const shortText = "Short name";
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 600,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "generic" },
          backendDOMNodeId: 601,
        }),
      ];
      const cdp = cdpForTruncatedGeneric({ innerText: shortText, nodes });
      const result = await proc.getTree(cdp, "s1", { filter: "interactive" });

      expect(result.text).not.toMatch(/…\[\+\d+ chars/);
    });
  });

  // FR-022: Content nodes hidden by filter:interactive must be counted so
  // read_page can hint that filter:'all' would reveal them. Prevents the LLM
  // from falling back to evaluate/querySelector to read visible text.
  describe("hiddenContentCount (FR-022)", () => {
    it("counts visible StaticText/paragraph/cell nodes when filter=interactive", async () => {
      const proc = new A11yTreeProcessor();
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2", "3", "4", "5"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "StaticText" },
          name: { type: "computedString", value: "Der geheime Code lautet: QMQ1-BPAD" },
          backendDOMNodeId: 101,
        }),
        makeNode({
          nodeId: "3",
          parentId: "1",
          role: { type: "role", value: "paragraph" },
          name: { type: "computedString", value: "Lorem ipsum" },
          backendDOMNodeId: 102,
        }),
        makeNode({
          nodeId: "4",
          parentId: "1",
          role: { type: "role", value: "cell" },
          name: { type: "computedString", value: "203" },
          backendDOMNodeId: 103,
        }),
        makeNode({
          nodeId: "5",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Submit" },
          backendDOMNodeId: 104,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      const result = await proc.getTree(cdp, "s1", { filter: "interactive" });
      expect(result.hiddenContentCount).toBe(3);
    });

    it("returns undefined when filter is 'all' (nothing hidden)", async () => {
      const proc = new A11yTreeProcessor();
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "StaticText" },
          name: { type: "computedString", value: "hi" },
          backendDOMNodeId: 101,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      const result = await proc.getTree(cdp, "s1", { filter: "all" });
      expect(result.hiddenContentCount).toBeUndefined();
    });

    it("ignores content nodes with empty names", async () => {
      const proc = new A11yTreeProcessor();
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
          childIds: ["2", "3"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "StaticText" },
          name: { type: "computedString", value: "" },
          backendDOMNodeId: 101,
        }),
        makeNode({
          nodeId: "3",
          parentId: "1",
          role: { type: "role", value: "paragraph" },
          name: { type: "computedString", value: "   " },
          backendDOMNodeId: 102,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      const result = await proc.getTree(cdp, "s1", { filter: "interactive" });
      expect(result.hiddenContentCount).toBe(0);
    });
  });

  // ============================================================
  // Ticket-1 — Sibling-aggregation (T4.7 token reduction)
  // ============================================================
  //
  // Collapses runs of ≥10 consecutive same-class sibling leaves into a
  // single line so generated lists like the 240-button benchmark page
  // do not blow the token budget. Aggregation never kicks in below the
  // threshold; small lists keep their per-element rendering.

  describe("Ticket-1 sibling aggregation", () => {
    function buildButtonList(count: number, namePattern: (i: number) => string): AXNode[] {
      const childIds = Array.from({ length: count }, (_, i) => `b${i}`);
      return [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Aggregation Test" },
          backendDOMNodeId: 1000,
          childIds,
        }),
        ...Array.from({ length: count }, (_, i) =>
          makeNode({
            nodeId: `b${i}`,
            parentId: "root",
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: namePattern(i) },
            backendDOMNodeId: 1001 + i,
          }),
        ),
      ];
    }

    it("does NOT aggregate when fewer than 10 consecutive same-pattern siblings", async () => {
      const nodes = buildButtonList(9, (i) => `Action ${i + 1}`);
      const cdp = mockCdpClient(nodes, "https://example.com/small-list");
      const result = await processor.getTree(cdp, "s1");

      // Each button should still render as its own line
      expect(result.text).toContain('[e2] button "Action 1"');
      expect(result.text).toContain('[e10] button "Action 9"');
      // No aggregate marker
      expect(result.text).not.toMatch(/\d+× button/);
      expect(result.refCount).toBe(9);
    });

    it("aggregates 10+ consecutive same-pattern siblings into one line", async () => {
      const nodes = buildButtonList(10, (i) => `Action ${i + 1}`);
      const cdp = mockCdpClient(nodes, "https://example.com/threshold");
      const result = await processor.getTree(cdp, "s1");

      // Single aggregate line covering the whole run
      expect(result.text).toContain('[e2..e11] 10× button "Action 1" .. "Action 10"');
      // Individual lines must NOT appear anymore
      expect(result.text).not.toContain('[e2] button "Action 1"');
      expect(result.text).not.toContain('[e11] button "Action 10"');
    });

    it("aggregates a 240-button list into a single line (T4.7 benchmark case)", async () => {
      const nodes = buildButtonList(240, (i) => `Action ${i + 1}`);
      const cdp = mockCdpClient(nodes, "https://example.com/t4-7");
      const result = await processor.getTree(cdp, "s1");

      expect(result.text).toContain('[e2..e241] 240× button "Action 1" .. "Action 240"');
      // The whole tree must now fit comfortably below the 2000-token budget
      // that the benchmark check uses for T4.7. We assert ≤ 200 tokens to
      // give plenty of headroom and lock in the magnitude of the saving.
      expect(result.tokenCount).toBeLessThan(200);
      // Aggregation runs in the standard render pipeline, so the result is
      // NOT marked downsampled.
      expect(result.downsampled).toBeUndefined();
    });

    it("aggregates identical-name siblings (no trailing-digit pattern)", async () => {
      // 12 unnamed-but-identical buttons all called "Add" — common in
      // table-row action columns. Should still collapse.
      const nodes = buildButtonList(12, () => "Add");
      const cdp = mockCdpClient(nodes, "https://example.com/identical");
      const result = await processor.getTree(cdp, "s1");

      expect(result.text).toContain('[e2..e13] 12× button "Add"');
      // No "..first .. last" form because the names are identical
      expect(result.text).not.toContain('"Add" .. "Add"');
    });

    it("does NOT aggregate across different roles", async () => {
      // 10 children alternating button / link → no consecutive run of 10
      const childIds = Array.from({ length: 10 }, (_, i) => `c${i}`);
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Mixed" },
          backendDOMNodeId: 1000,
          childIds,
        }),
        ...Array.from({ length: 10 }, (_, i) =>
          makeNode({
            nodeId: `c${i}`,
            parentId: "root",
            role: { type: "role", value: i % 2 === 0 ? "button" : "link" },
            name: { type: "computedString", value: `Item ${i + 1}` },
            backendDOMNodeId: 1001 + i,
          }),
        ),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/mixed-roles");
      const result = await processor.getTree(cdp, "s1");

      // None of the buttons / links forms a run of 10 → no aggregation
      expect(result.text).not.toMatch(/\d+× button/);
      expect(result.text).not.toMatch(/\d+× link/);
      expect(result.refCount).toBe(10);
    });

    it("does NOT aggregate across different name prefixes", async () => {
      const nodes = buildButtonList(20, (i) => (i < 10 ? `Open ${i + 1}` : `Close ${i + 1}`));
      const cdp = mockCdpClient(nodes, "https://example.com/two-prefixes");
      const result = await processor.getTree(cdp, "s1");

      // Two distinct runs of 10 — both meet the threshold and aggregate
      // separately, never merging across the prefix boundary.
      expect(result.text).toContain('[e2..e11] 10× button "Open 1" .. "Open 10"');
      expect(result.text).toContain('[e12..e21] 10× button "Close 11" .. "Close 20"');
    });

    it("does NOT aggregate elements with renderable child interactives", async () => {
      // Each "wrapper" button contains a nested textbox — the parent is
      // therefore not a leaf and aggregation must skip it even though the
      // wrappers themselves look identical.
      const wrapperIds = Array.from({ length: 12 }, (_, i) => `w${i}`);
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Wrapped inputs" },
          backendDOMNodeId: 2000,
          childIds: wrapperIds,
        }),
      ];
      for (let i = 0; i < 12; i++) {
        nodes.push(
          makeNode({
            nodeId: `w${i}`,
            parentId: "root",
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: `Row ${i + 1}` },
            backendDOMNodeId: 2001 + i * 2,
            childIds: [`t${i}`],
          }),
          makeNode({
            nodeId: `t${i}`,
            parentId: `w${i}`,
            role: { type: "role", value: "textbox" },
            name: { type: "computedString", value: `Field ${i + 1}` },
            backendDOMNodeId: 2002 + i * 2,
          }),
        );
      }
      const cdp = mockCdpClient(nodes, "https://example.com/wrapped");
      const result = await processor.getTree(cdp, "s1");

      // Wrappers must render individually because they have renderable
      // descendants (the nested textboxes).
      expect(result.text).not.toMatch(/\d+× button/);
      // The textboxes themselves are leaves and could collapse — verify
      // that path still works for the inner level.
      expect(result.text).toContain("Row 1");
      expect(result.text).toContain("Field 1");
    });

    it("preserves ref resolution for elements inside an aggregated run", async () => {
      // The whole point of aggregation: the LLM still issues click({ ref:
      // 'eN' }) for any individual button in the range, even though the
      // text response only shows the [start..end] band.
      const nodes = buildButtonList(15, (i) => `Step ${i + 1}`);
      const cdp = mockCdpClient(nodes, "https://example.com/refs");
      await processor.getTree(cdp, "s1");

      // backendDOMNodeId is 1001 + i, refs are e2 + i (e1 = WebArea root)
      expect(processor.resolveRef("e2")).toBe(1001);
      expect(processor.resolveRef("e8")).toBe(1007);
      expect(processor.resolveRef("e16")).toBe(1015);
    });

    // --- Container-scan / interleaved tests (T4.7 case) ---

    it("aggregates leaves that are interleaved with unrelated content", async () => {
      // The T4.7 benchmark pattern: 12 sections in one container, each a
      // sequence of (heading, paragraph, button "Action N", link, textbox).
      // No run of ≥10 consecutive buttons — every button is bracketed by
      // other kinds of leaves. The global aggregator must still collapse
      // the 12 buttons into one summary line.
      const childIds: string[] = [];
      const children: AXNode[] = [];
      let backendId = 1000;
      for (let sec = 0; sec < 12; sec++) {
        const hId = `h${sec}`;
        const pId = `p${sec}`;
        const bId = `btn${sec}`;
        const lId = `lnk${sec}`;
        const tId = `tb${sec}`;
        childIds.push(hId, pId, bId, lId, tId);
        children.push(
          makeNode({
            nodeId: hId,
            parentId: "root",
            role: { type: "role", value: "heading" },
            name: { type: "computedString", value: `Section ${sec + 1}` },
            backendDOMNodeId: backendId++,
          }),
          makeNode({
            nodeId: pId,
            parentId: "root",
            role: { type: "role", value: "paragraph" },
            name: { type: "computedString", value: `Body ${sec + 1}` },
            backendDOMNodeId: backendId++,
          }),
          makeNode({
            nodeId: bId,
            parentId: "root",
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: `Action ${sec + 1}` },
            backendDOMNodeId: backendId++,
          }),
          makeNode({
            nodeId: lId,
            parentId: "root",
            role: { type: "role", value: "link" },
            name: { type: "computedString", value: `Section ${sec + 1} anchor` },
            backendDOMNodeId: backendId++,
            properties: [{ name: "url", value: { type: "string", value: `/#s${sec}` } }],
          }),
          makeNode({
            nodeId: tId,
            parentId: "root",
            role: { type: "role", value: "textbox" },
            name: { type: "computedString", value: `Input ${sec + 1}` },
            backendDOMNodeId: backendId++,
          }),
        );
      }
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Interleaved" },
          backendDOMNodeId: 999,
          childIds,
        }),
        ...children,
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/interleaved");
      const result = await processor.getTree(cdp, "s1");

      // 12 buttons → above threshold → one aggregate line spanning the band
      // The first button has backendDOMNodeId 1002 (h0=1000, p0=1001, btn0=1002),
      // ref = e4 (e1=root, e2=h0 is not interactive so not present, but
      // interactive filter means headings ARE included as context... let me
      // assert the structural properties instead of exact ref numbers).
      expect(result.text).toMatch(/\d+× button "Action 1" \.\. "Action 12"/);
      // The individual button lines must NOT appear — they are suppressed.
      expect(result.text).not.toContain('button "Action 3"');
      expect(result.text).not.toContain('button "Action 7"');
      // Links are NOT aggregated because their names are all different
      // ("Section 1 anchor" .. "Section 12 anchor" strips to "Section " and
      // matches! Actually wait — "Section 1 anchor" ends in "anchor", not
      // digits, so the fallback is exact-name match and the names differ).
      // Each link should appear individually.
      expect(result.text).toContain('"Section 1 anchor"');
      expect(result.text).toContain('"Section 12 anchor"');
      // Textboxes ARE aggregated: "Input 1" .. "Input 12" → key "textbox::Input "
      expect(result.text).toMatch(/\d+× textbox "Input 1" \.\. "Input 12"/);
    });

    it("reproduces the T4.7 benchmark pattern (120 buttons across 60 sections)", async () => {
      // Faithful reproduction of test-hardest/index.html t4_7_generate(): a
      // single container with 60 sections, each [heading, 4 paragraphs,
      // 2 div/span groups, ul/4 li, button (Action 2n+1), button (Action
      // 2n+2), link, textbox]. 120 buttons total (note: aria-labels in the
      // real benchmark are sec*4+1/sec*4+2, we mirror that).
      const childIds: string[] = [];
      const children: AXNode[] = [];
      let backendId = 1000;
      const addLeaf = (role: string, name: string) => {
        const id = `n${childIds.length}`;
        childIds.push(id);
        children.push(
          makeNode({
            nodeId: id,
            parentId: "root",
            role: { type: "role", value: role },
            name: { type: "computedString", value: name },
            backendDOMNodeId: backendId++,
          }),
        );
      };
      for (let sec = 0; sec < 60; sec++) {
        addLeaf("heading", `Section ${sec + 1}`);
        for (let p = 0; p < 4; p++) addLeaf("paragraph", `para ${sec}-${p}`);
        // Two generic wrappers in the real page — omitted here since they
        // would be ignored by the interactive filter anyway.
        addLeaf("button", `Action ${sec * 4 + 1}`);
        addLeaf("button", `Action ${sec * 4 + 2}`);
        addLeaf("link", `Link ${sec + 1}`);
        addLeaf("textbox", `Input ${sec + 1}`);
      }
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "T4.7 repro" },
          backendDOMNodeId: 999,
          childIds,
        }),
        ...children,
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/t4-7-repro");
      const result = await processor.getTree(cdp, "s1");

      // All 120 action buttons collapse into one line
      expect(result.text).toMatch(
        /120× button "Action 1" \.\. "Action 238"/,
      );
      // None of the individual "Action N" lines for N in the middle of the
      // range should remain.
      expect(result.text).not.toContain('button "Action 57"');
      expect(result.text).not.toContain('button "Action 199"');
      // The 60 textboxes with "Input 1..60" also aggregate.
      expect(result.text).toMatch(/60× textbox "Input 1" \.\. "Input 60"/);
      // The 60 links with "Link 1..60" also aggregate.
      expect(result.text).toMatch(/60× link "Link 1" \.\. "Link 60"/);
      // Total interactive token count must be comfortably below the
      // benchmark's 2000-token budget. The old render produced ~2585; the
      // global aggregator should take this under 500.
      expect(result.tokenCount).toBeLessThan(500);
      // Standard render path, not downsampled.
      expect(result.downsampled).toBeUndefined();
    });

    it("resolves refs for every member of an interleaved aggregated bucket", async () => {
      // Same interleaved pattern as the first interleaved test, but this
      // time we assert that every individual button's ref still resolves
      // back to its backendDOMNodeId so click({ref}) keeps working on any
      // element inside the aggregated band.
      const childIds: string[] = [];
      const children: AXNode[] = [];
      const buttonBackendIds: number[] = [];
      let backendId = 500;
      for (let sec = 0; sec < 15; sec++) {
        const hId = `h${sec}`;
        const bId = `btn${sec}`;
        childIds.push(hId, bId);
        children.push(
          makeNode({
            nodeId: hId,
            parentId: "root",
            role: { type: "role", value: "heading" },
            name: { type: "computedString", value: `H${sec}` },
            backendDOMNodeId: backendId++,
          }),
        );
        buttonBackendIds.push(backendId);
        children.push(
          makeNode({
            nodeId: bId,
            parentId: "root",
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: `Step ${sec + 1}` },
            backendDOMNodeId: backendId++,
          }),
        );
      }
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Refs" },
          backendDOMNodeId: 499,
          childIds,
        }),
        ...children,
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/refs-interleaved");
      await processor.getTree(cdp, "s1");

      // Every button backendId must resolve via its ref, including the ones
      // that were suppressed in the text output.
      for (const backend of buttonBackendIds) {
        const ref = Array.from({ length: 50 })
          .map((_, i) => `e${i + 1}`)
          .find((r) => processor.resolveRef(r) === backend);
        expect(ref).toBeDefined();
      }
    });
  });
});
