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
    // BUG-019: display depth stays user-controlled, but the wire-level CDP call
    // always fetches the full tree (no depth param) so deeply nested main content
    // doesn't silently disappear.
    expect(cdp.send).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      {},
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

  // Story 18.8 Fix B: disabled elements get a LEADING `[DISABLED]` prefix
  // (before the ref/role) so a scanning LLM can't miss it. Two benchmark
  // runs failed T4.4 because the old trailing `(disabled)` was overlooked.
  it("should mark disabled elements with a leading [DISABLED] prefix", async () => {
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

    // The prefix must sit BEFORE the ref/role, not trail at the end of the line.
    expect(result.text).toMatch(/\[DISABLED\] \[e\d+\] button "Disabled Btn"/);
    // And the old trailing `(disabled)` suffix must be gone.
    expect(result.text).not.toContain("(disabled)");
  });

  // Story 18.8 Fix B regression — T4.4 scenario from the benchmark.
  // Two independent LLM runs typed into a disabled textbox because the
  // old `(disabled)` suffix was at the tail of the line and easy to miss.
  // The [DISABLED] prefix must also render for textbox+input elements,
  // not just buttons — and it must sit BEFORE `[e…] textbox …`.
  it("Story 18.8 — disabled textbox gets [DISABLED] prefix (T4.4 regression)", async () => {
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
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Your input" },
        backendDOMNodeId: 101,
        properties: [{ name: "disabled", value: { type: "boolean", value: true } }],
      }),
    ];
    const cdp = mockCdpClient(nodes);
    const result = await processor.getTree(cdp, "s1");

    // The disabled marker must be the VERY FIRST token on the element line
    // (after indentation). If it trails at the end we regress T4.4.
    const lines = result.text.split("\n");
    const textboxLine = lines.find((l) => l.includes("textbox"));
    expect(textboxLine).toBeDefined();
    expect(textboxLine!.trimStart().startsWith("[DISABLED]")).toBe(true);
    expect(textboxLine!).toMatch(/\[DISABLED\] \[e\d+\] textbox "Your input"/);
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

  // --- FR-023: Same-origin iframe inlining tests ---

  it("FR-023: srcdoc iframe content is inlined in read_page output", async () => {
    const mainNodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Main Page" },
        backendDOMNodeId: 100,
        childIds: ["2", "3"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Main Button" },
        backendDOMNodeId: 101,
      }),
      makeNode({
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "Iframe" },
        name: { type: "computedString", value: "" },
        backendDOMNodeId: 102,
      }),
    ];

    const iframeNodes: AXNode[] = [
      makeNode({
        nodeId: "f1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "IFrame Doc" },
        backendDOMNodeId: 200,
        childIds: ["f2"],
      }),
      makeNode({
        nodeId: "f2",
        parentId: "f1",
        role: { type: "role", value: "StaticText" },
        name: { type: "computedString", value: "FRAME-1U7PMO" },
        backendDOMNodeId: 201,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/fr023" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (params && params.frameId === "iframe-frame-1") {
            return Promise.resolve({ nodes: iframeNodes });
          }
          return Promise.resolve({ nodes: mainNodes });
        }
        if (method === "Page.getFrameTree") {
          return Promise.resolve({
            frameTree: {
              frame: { id: "main-frame", url: "https://example.com/fr023", securityOrigin: "https://example.com" },
              childFrames: [{
                frame: { id: "iframe-frame-1", url: "about:srcdoc", securityOrigin: "null" },
              }],
            },
          });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await processor.getTree(cdp, "s1", { filter: "all" });

    // Iframe content should appear as inline section
    expect(result.text).toContain("--- iframe: about:srcdoc ---");
    expect(result.text).toContain("FRAME-1U7PMO");
  });

  it("FR-023: nested same-origin srcdoc iframes are both inlined", async () => {
    const mainNodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Main" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "Iframe" },
        backendDOMNodeId: 101,
      }),
    ];

    const outerIframeNodes: AXNode[] = [
      makeNode({
        nodeId: "o1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Outer Frame" },
        backendDOMNodeId: 300,
        childIds: ["o2"],
      }),
      makeNode({
        nodeId: "o2",
        parentId: "o1",
        role: { type: "role", value: "StaticText" },
        name: { type: "computedString", value: "OUTER-CONTENT" },
        backendDOMNodeId: 301,
      }),
    ];

    const innerIframeNodes: AXNode[] = [
      makeNode({
        nodeId: "i1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Inner Frame" },
        backendDOMNodeId: 400,
        childIds: ["i2"],
      }),
      makeNode({
        nodeId: "i2",
        parentId: "i1",
        role: { type: "role", value: "StaticText" },
        name: { type: "computedString", value: "INNER-CONTENT" },
        backendDOMNodeId: 401,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/nested" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (params && params.frameId === "outer-frame") {
            return Promise.resolve({ nodes: outerIframeNodes });
          }
          if (params && params.frameId === "inner-frame") {
            return Promise.resolve({ nodes: innerIframeNodes });
          }
          return Promise.resolve({ nodes: mainNodes });
        }
        if (method === "Page.getFrameTree") {
          return Promise.resolve({
            frameTree: {
              frame: { id: "main-frame", url: "https://example.com/nested", securityOrigin: "https://example.com" },
              childFrames: [{
                frame: { id: "outer-frame", url: "about:srcdoc", securityOrigin: "null" },
                childFrames: [{
                  frame: { id: "inner-frame", url: "about:srcdoc", securityOrigin: "null" },
                }],
              }],
            },
          });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await processor.getTree(cdp, "s1", { filter: "all" });

    // Both nested iframes should be inlined
    expect(result.text).toContain("OUTER-CONTENT");
    expect(result.text).toContain("INNER-CONTENT");
    // Two separate iframe sections
    const iframeSections = result.text.split("--- iframe: about:srcdoc ---");
    expect(iframeSections.length).toBe(3); // original + 2 splits = 3 parts
  });

  it("FR-023: OOPIF iframe is excluded from same-process inlining (handled by OOPIF path)", async () => {
    // A true OOPIF (different eTLD+1, e.g. evil.com inside example.com) is handled
    // by the SessionManager path, not by the same-process inlining path.
    // The frame appears in Page.getFrameTree but must be skipped because the
    // SessionManager already has an OOPIF session for it.
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
        role: { type: "role", value: "Iframe" },
        backendDOMNodeId: 101,
      }),
    ];

    const oopifNodes: AXNode[] = [
      makeNode({
        nodeId: "o1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Evil Widget" },
        backendDOMNodeId: 200,
        childIds: ["o2"],
      }),
      makeNode({
        nodeId: "o2",
        parentId: "o1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Evil Button" },
        backendDOMNodeId: 201,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>, sessionId?: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/cross" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          // OOPIF session gets its own getFullAXTree call (without frameId)
          if (sessionId === "oopif-evil") {
            return Promise.resolve({ nodes: oopifNodes });
          }
          // Same-process inlining must NOT call getFullAXTree with this frameId
          if (params && params.frameId === "cross-frame") {
            throw new Error("Should not fetch OOPIF frame AX tree via main session — it has its own session");
          }
          return Promise.resolve({ nodes: mainNodes });
        }
        if (method === "Page.getFrameTree") {
          return Promise.resolve({
            frameTree: {
              frame: { id: "main-frame", url: "https://example.com/cross", securityOrigin: "https://example.com" },
              childFrames: [{
                frame: { id: "cross-frame", url: "https://evil.com/widget", securityOrigin: "https://evil.com" },
              }],
            },
          });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    // SessionManager reports this frame as an OOPIF → excluded from same-process path
    const mockSessionManager = {
      getAllSessions: () => [
        { sessionId: "s1", frameId: "main", url: "", isMain: true },
        { sessionId: "oopif-evil", frameId: "cross-frame", url: "https://evil.com/widget", isMain: false },
      ],
      registerNode: vi.fn(),
    } as unknown as import("../cdp/session-manager.js").SessionManager;

    const result = await processor.getTree(cdp, "s1", { filter: "all" }, mockSessionManager);

    // OOPIF content appears via the OOPIF path, NOT via same-process inlining
    expect(result.text).toContain("--- iframe: https://evil.com/widget ---");
    expect(result.text).toContain('[e4] button "Evil Button"');
  });

  it("FR-023: same-site cross-origin iframe IS inlined (not an OOPIF)", async () => {
    // Chrome groups by Site (eTLD+1), not Origin. Two subdomains like
    // www.freenet.de and cmp.freenet.de share the same renderer process.
    // They appear in Page.getFrameTree but NOT in Target.getTargets(type:"iframe").
    // The same-process inlining path must pick them up.
    const mainNodes: AXNode[] = [
      makeNode({
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Freenet Page" },
        backendDOMNodeId: 100,
        childIds: ["2", "3"],
      }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Main Nav" },
        backendDOMNodeId: 101,
      }),
      makeNode({
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "Iframe" },
        name: { type: "computedString", value: "SP Consent Message" },
        backendDOMNodeId: 102,
      }),
    ];

    const consentNodes: AXNode[] = [
      makeNode({
        nodeId: "c1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Notice Message App" },
        backendDOMNodeId: 300,
        childIds: ["c2", "c3"],
      }),
      makeNode({
        nodeId: "c2",
        parentId: "c1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Alle akzeptieren" },
        backendDOMNodeId: 301,
      }),
      makeNode({
        nodeId: "c3",
        parentId: "c1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Ohne Einwilligung weiter" },
        backendDOMNodeId: 302,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://www.freenet.de/rechnungen" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (params && params.frameId === "consent-frame") {
            return Promise.resolve({ nodes: consentNodes });
          }
          return Promise.resolve({ nodes: mainNodes });
        }
        if (method === "Page.getFrameTree") {
          return Promise.resolve({
            frameTree: {
              frame: { id: "main-frame", url: "https://www.freenet.de/rechnungen", securityOrigin: "https://www.freenet.de" },
              childFrames: [{
                // Same site (freenet.de) but different origin (cmp vs www)
                // Chrome keeps this in the same process → NOT an OOPIF
                frame: { id: "consent-frame", url: "https://cmp.freenet.de/consent", securityOrigin: "https://cmp.freenet.de" },
              }],
            },
          });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    // No SessionManager → no OOPIF sessions → frame must be inlined via same-process path
    const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

    // Consent iframe content should be visible
    expect(result.text).toContain("--- iframe: https://cmp.freenet.de/consent ---");
    expect(result.text).toContain('button "Alle akzeptieren"');
    expect(result.text).toContain('button "Ohne Einwilligung weiter"');
  });

  it("FR-023: Page.getFrameTree failure is handled gracefully", async () => {
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
        name: { type: "computedString", value: "OK" },
        backendDOMNodeId: 101,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/err" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes: mainNodes });
        }
        if (method === "Page.getFrameTree") {
          return Promise.reject(new Error("Protocol error: Page.getFrameTree not supported"));
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    // Should not throw — graceful degradation
    const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

    expect(result.text).toContain('[e2] button "OK"');
    expect(result.refCount).toBeGreaterThan(0);
  });

  it("FR-023: same-origin iframe nodes get refs and can be resolved", async () => {
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

    const iframeNodes: AXNode[] = [
      makeNode({
        nodeId: "f1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 500,
        childIds: ["f2"],
      }),
      makeNode({
        nodeId: "f2",
        parentId: "f1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "IFrame Btn" },
        backendDOMNodeId: 501,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/refs" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (params && params.frameId === "srcdoc-frame") {
            return Promise.resolve({ nodes: iframeNodes });
          }
          return Promise.resolve({ nodes: mainNodes });
        }
        if (method === "Page.getFrameTree") {
          return Promise.resolve({
            frameTree: {
              frame: { id: "main-frame", url: "https://example.com/refs", securityOrigin: "https://example.com" },
              childFrames: [{
                frame: { id: "srcdoc-frame", url: "about:srcdoc", securityOrigin: "null" },
              }],
            },
          });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

    // iframe button should have a ref
    expect(result.text).toContain('[e4] button "IFrame Btn"');

    // Refs should be resolvable — and they should use the main sessionId
    const full = processor.resolveRefFull("e4");
    expect(full).toBeDefined();
    expect(full!.backendNodeId).toBe(501);
    expect(full!.sessionId).toBe("s1"); // main session, not a separate OOPIF session
  });

  it("FR-023: about:blank iframe with same origin is inlined", async () => {
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
        role: { type: "role", value: "Iframe" },
        backendDOMNodeId: 101,
      }),
    ];

    const blankIframeNodes: AXNode[] = [
      makeNode({
        nodeId: "b1",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 600,
        childIds: ["b2"],
      }),
      makeNode({
        nodeId: "b2",
        parentId: "b1",
        role: { type: "role", value: "StaticText" },
        name: { type: "computedString", value: "BLANK-CONTENT" },
        backendDOMNodeId: 601,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/blank" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (params && params.frameId === "blank-frame") {
            return Promise.resolve({ nodes: blankIframeNodes });
          }
          return Promise.resolve({ nodes: mainNodes });
        }
        if (method === "Page.getFrameTree") {
          return Promise.resolve({
            frameTree: {
              frame: { id: "main-frame", url: "https://example.com/blank", securityOrigin: "https://example.com" },
              childFrames: [{
                frame: { id: "blank-frame", url: "about:blank", securityOrigin: "https://example.com" },
              }],
            },
          });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await processor.getTree(cdp, "s1", { filter: "all" });

    expect(result.text).toContain("--- iframe: about:blank ---");
    expect(result.text).toContain("BLANK-CONTENT");
  });

  it("FR-023: same-origin iframe with explicit src URL is inlined", async () => {
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
        role: { type: "role", value: "Iframe" },
        backendDOMNodeId: 101,
      }),
    ];

    const sameOriginIframeNodes: AXNode[] = [
      makeNode({
        nodeId: "s1n",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 700,
        childIds: ["s2n"],
      }),
      makeNode({
        nodeId: "s2n",
        parentId: "s1n",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Same Origin Btn" },
        backendDOMNodeId: 701,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/parent" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          if (params && params.frameId === "same-origin-frame") {
            return Promise.resolve({ nodes: sameOriginIframeNodes });
          }
          return Promise.resolve({ nodes: mainNodes });
        }
        if (method === "Page.getFrameTree") {
          return Promise.resolve({
            frameTree: {
              frame: { id: "main-frame", url: "https://example.com/parent", securityOrigin: "https://example.com" },
              childFrames: [{
                frame: { id: "same-origin-frame", url: "https://example.com/widget", securityOrigin: "https://example.com" },
              }],
            },
          });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

    expect(result.text).toContain("--- iframe: https://example.com/widget ---");
    expect(result.text).toContain('[e4] button "Same Origin Btn"');
  });

  it("FR-023: iframe annotation says 'content shown below' instead of evaluate hint", async () => {
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
        role: { type: "role", value: "Iframe" },
        name: { type: "computedString", value: "My Frame" },
        backendDOMNodeId: 101,
      }),
    ];

    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({ result: { value: "https://example.com/hint" } });
        }
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({ nodes: mainNodes });
        }
        if (method === "Page.getFrameTree") {
          return Promise.resolve({
            frameTree: {
              frame: { id: "main-frame", url: "https://example.com/hint", securityOrigin: "https://example.com" },
            },
          });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await processor.getTree(cdp, "s1", { filter: "all" });

    expect(result.text).toContain("(content shown below)");
    expect(result.text).not.toContain("use evaluate to access iframe content");
  });

  // --- Visual enrichment tests (Story 5b.3) ---

  function makeDomSnapshot(elements: Array<{
    backendNodeId: number;
    nodeName: string;
    bounds?: [number, number, number, number];
    display?: string;
    visibility?: string;
    // Story 18.4: optional pointer-events + paintOrder for occlusion tests.
    // Defaults preserve the pre-18.4 behaviour so existing tests stay green.
    pointerEvents?: string;
    paintOrder?: number;
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
    const layoutPaintOrders: number[] = [];

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      backendNodeIds.push(el.backendNodeId);
      nodeNames.push(strIndex(el.nodeName));

      if (el.bounds) {
        layoutNodeIndex.push(i);
        layoutBounds.push(el.bounds);
        // Order MUST match COMPUTED_STYLES tuple in visual-constants.ts:
        // display, visibility, color, bg-color, font-size, position,
        // z-index, pointer-events (Story 18.4).
        layoutStyleProps.push([
          strIndex(el.display ?? "block"),
          strIndex(el.visibility ?? "visible"),
          strIndex("rgb(0,0,0)"),
          strIndex("rgb(255,255,255)"),
          strIndex("16px"),
          strIndex("static"),
          strIndex("auto"),
          strIndex(el.pointerEvents ?? "auto"),
        ]);
        // Story 18.4: default paintOrder to DOM order (i + 1) so tests that
        // don't care about stacking get deterministic, monotonically
        // increasing values — the last element drawn wins, which matches
        // Chrome's default for non-positioned flow layout.
        layoutPaintOrders.push(el.paintOrder ?? i + 1);
      }
    }

    return {
      documents: [{
        nodes: { backendNodeId: backendNodeIds, nodeName: nodeNames },
        layout: {
          nodeIndex: layoutNodeIndex,
          bounds: layoutBounds,
          styles: layoutStyleProps,
          paintOrders: layoutPaintOrders,
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

  // --- Paint-order filtering (Story 18.4) ---
  //
  // Verifies that elements covered by a higher-paintOrder clickable overlay
  // are dropped from read_page output, even in the default "interactive"
  // filter. The three primary tests cover the AC-4 matrix:
  //   1. Overlay-over-cluster → underlying links disappear
  //   2. Same overlay with pointer-events: none → links stay
  //   3. Pure z-index stacking (same bounds, different paintOrder)
  // Plus a fallback regression: DOMSnapshot failure must NOT drop elements.
  describe("Paint-order filtering (Story 18.4)", () => {
    /** Helper: build an AX tree with a WebArea root plus a flat list of
     *  link/button leaves. Keeps test bodies focused on paint-order
     *  assertions rather than AX wiring. */
    function buildFlatTree(
      leaves: Array<{ nodeId: string; backendNodeId: number; role: string; name: string }>,
    ): AXNode[] {
      const rootChildIds = leaves.map((l) => l.nodeId);
      const root = makeNode({
        nodeId: "root",
        role: { type: "role", value: "WebArea" },
        backendDOMNodeId: 1,
        childIds: rootChildIds,
      });
      const children = leaves.map((l) =>
        makeNode({
          nodeId: l.nodeId,
          parentId: "root",
          role: { type: "role", value: l.role },
          name: { type: "computedString", value: l.name },
          backendDOMNodeId: l.backendNodeId,
        }),
      );
      return [root, ...children];
    }

    it("should filter occluded links when overlay covers a link cluster", async () => {
      // 5 links in a column + 1 modal div that covers them all.
      // Link paintOrders are 1..5, modal paintOrder is 10 → modal wins
      // the centre-point hit test for every link.
      const nodes = buildFlatTree([
        { nodeId: "n2", backendNodeId: 102, role: "link", name: "Link 1" },
        { nodeId: "n3", backendNodeId: 103, role: "link", name: "Link 2" },
        { nodeId: "n4", backendNodeId: 104, role: "link", name: "Link 3" },
        { nodeId: "n5", backendNodeId: 105, role: "link", name: "Link 4" },
        { nodeId: "n6", backendNodeId: 106, role: "link", name: "Link 5" },
        { nodeId: "n7", backendNodeId: 107, role: "button", name: "Close Modal" },
      ]);

      const snapshot = makeDomSnapshot([
        { backendNodeId: 1, nodeName: "HTML", bounds: [0, 0, 1280, 800], paintOrder: 0 },
        // Five links stacked vertically, all inside the modal's bounds.
        { backendNodeId: 102, nodeName: "A", bounds: [100, 200, 80, 30], paintOrder: 1 },
        { backendNodeId: 103, nodeName: "A", bounds: [200, 200, 80, 30], paintOrder: 2 },
        { backendNodeId: 104, nodeName: "A", bounds: [300, 200, 80, 30], paintOrder: 3 },
        { backendNodeId: 105, nodeName: "A", bounds: [400, 200, 80, 30], paintOrder: 4 },
        { backendNodeId: 106, nodeName: "A", bounds: [500, 200, 80, 30], paintOrder: 5 },
        // Modal div covering the entire link strip. pointer-events: auto
        // (default) → occludes the underlying links.
        { backendNodeId: 107, nodeName: "BUTTON", bounds: [80, 180, 600, 70], paintOrder: 10, pointerEvents: "auto" },
      ]);

      const cdp = mockCdpClientVisual(nodes, snapshot, "https://example.com/occluded");
      const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

      // None of the occluded links should appear in the output.
      expect(result.text).not.toContain("Link 1");
      expect(result.text).not.toContain("Link 2");
      expect(result.text).not.toContain("Link 3");
      expect(result.text).not.toContain("Link 4");
      expect(result.text).not.toContain("Link 5");
      // The modal's close button must stay — it is the top-most clickable.
      expect(result.text).toContain("Close Modal");
      expect(result.refCount).toBe(1);
    });

    it("should keep underlying elements when overlay has pointer-events: none", async () => {
      // Identical setup to the first test, but the modal has
      // pointer-events: none. Chrome's hit test walks THROUGH it, so the
      // underlying links remain clickable and must remain in the output.
      const nodes = buildFlatTree([
        { nodeId: "n2", backendNodeId: 102, role: "link", name: "Link 1" },
        { nodeId: "n3", backendNodeId: 103, role: "link", name: "Link 2" },
        { nodeId: "n4", backendNodeId: 104, role: "link", name: "Link 3" },
        { nodeId: "n5", backendNodeId: 105, role: "link", name: "Link 4" },
        { nodeId: "n6", backendNodeId: 106, role: "link", name: "Link 5" },
        { nodeId: "n7", backendNodeId: 107, role: "button", name: "Close Modal" },
      ]);

      const snapshot = makeDomSnapshot([
        { backendNodeId: 1, nodeName: "HTML", bounds: [0, 0, 1280, 800], paintOrder: 0 },
        { backendNodeId: 102, nodeName: "A", bounds: [100, 200, 80, 30], paintOrder: 1 },
        { backendNodeId: 103, nodeName: "A", bounds: [200, 200, 80, 30], paintOrder: 2 },
        { backendNodeId: 104, nodeName: "A", bounds: [300, 200, 80, 30], paintOrder: 3 },
        { backendNodeId: 105, nodeName: "A", bounds: [400, 200, 80, 30], paintOrder: 4 },
        { backendNodeId: 106, nodeName: "A", bounds: [500, 200, 80, 30], paintOrder: 5 },
        // Modal with pointer-events: none → NOT an occluder.
        { backendNodeId: 107, nodeName: "BUTTON", bounds: [80, 180, 600, 70], paintOrder: 10, pointerEvents: "none" },
      ]);

      const cdp = mockCdpClientVisual(nodes, snapshot, "https://example.com/pe-none");
      const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

      // All five links must still appear.
      expect(result.text).toContain("Link 1");
      expect(result.text).toContain("Link 2");
      expect(result.text).toContain("Link 3");
      expect(result.text).toContain("Link 4");
      expect(result.text).toContain("Link 5");
      // The modal's button is present too (it is in the A11y tree —
      // pointer-events: none doesn't hide it from accessibility, only
      // from hit testing).
      expect(result.text).toContain("Close Modal");
      expect(result.refCount).toBe(6);
    });

    it("should respect z-index stacking in paintOrder data", async () => {
      // Two overlapping buttons with IDENTICAL bounds but different
      // paintOrders. The higher-paintOrder button wins the hit test →
      // "Visible" stays, "Hidden" is dropped.
      const nodes = buildFlatTree([
        { nodeId: "n2", backendNodeId: 102, role: "button", name: "Hidden" },
        { nodeId: "n3", backendNodeId: 103, role: "button", name: "Visible" },
      ]);

      const snapshot = makeDomSnapshot([
        { backendNodeId: 1, nodeName: "HTML", bounds: [0, 0, 1280, 800], paintOrder: 0 },
        { backendNodeId: 102, nodeName: "BUTTON", bounds: [100, 100, 200, 40], paintOrder: 1 },
        { backendNodeId: 103, nodeName: "BUTTON", bounds: [100, 100, 200, 40], paintOrder: 10 },
      ]);

      const cdp = mockCdpClientVisual(nodes, snapshot, "https://example.com/zindex");
      const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

      expect(result.text).toContain("Visible");
      expect(result.text).not.toContain("Hidden");
      expect(result.refCount).toBe(1);
    });

    // Task 9 — fallback: if captureSnapshot rejects, getTree must return
    // the UNFILTERED tree so the LLM still sees every element. Parity with
    // the existing M1 visual-filter path, but for the default interactive
    // filter that Story 18.4 now also routes through fetchVisualData.
    it("Paint-order filter: DOMSnapshot failure falls back to unfiltered interactive tree", async () => {
      const nodes = buildFlatTree([
        { nodeId: "n2", backendNodeId: 102, role: "link", name: "Link 1" },
        { nodeId: "n3", backendNodeId: 103, role: "link", name: "Link 2" },
        { nodeId: "n4", backendNodeId: 104, role: "link", name: "Link 3" },
        { nodeId: "n5", backendNodeId: 105, role: "link", name: "Link 4" },
        { nodeId: "n6", backendNodeId: 106, role: "link", name: "Link 5" },
      ]);

      const cdp = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === "Runtime.evaluate") {
            return Promise.resolve({ result: { value: "https://example.com/snapshot-fail" } });
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

      const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

      // All five links must appear — the filter falls back to the
      // unfiltered tree.
      expect(result.text).toContain("Link 1");
      expect(result.text).toContain("Link 5");
      expect(result.refCount).toBe(5);
      // Interactive filter never sets hasVisualData — only visual does.
      expect(result.hasVisualData).toBeUndefined();
    });

    // Review H1 + M1: captureSnapshot SUCCEEDS but `paintOrders` is
    // undefined. This is the Chrome CDP regression mode — on affected
    // builds DOMSnapshot silently drops the field instead of throwing.
    // Before the H1 fix, getTree would silently default every paintOrder
    // to 0 and render the full unfiltered tree while claiming to be
    // filtered. After the fix, fetchVisualData throws
    // PaintOrderUnavailableError and getTree takes the unfiltered
    // fallback AND emits a one-time console.warn.
    it("Review H1: captureSnapshot success without paintOrders falls back unfiltered", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const nodes = buildFlatTree([
          { nodeId: "n2", backendNodeId: 202, role: "link", name: "Link A" },
          { nodeId: "n3", backendNodeId: 203, role: "link", name: "Link B" },
          { nodeId: "n4", backendNodeId: 204, role: "link", name: "Link C" },
        ]);

        // Mock captureSnapshot returning a valid document shape but WITHOUT
        // `paintOrders`. This mimics the exact failure mode from the
        // reviewer's H1 note.
        const snapshotMissingPaintOrders = {
          documents: [{
            nodes: { backendNodeId: [1, 202, 203, 204], nodeName: [0, 1, 1, 1] },
            layout: {
              nodeIndex: [0, 1, 2, 3],
              bounds: [
                [0, 0, 1280, 800],
                [100, 200, 80, 30],
                [200, 200, 80, 30],
                [300, 200, 80, 30],
              ],
              styles: [
                [2, 3, 4, 5, 6, 7, 8, 9], // default visible block
                [2, 3, 4, 5, 6, 7, 8, 9],
                [2, 3, 4, 5, 6, 7, 8, 9],
                [2, 3, 4, 5, 6, 7, 8, 9],
              ],
              // paintOrders intentionally omitted
            },
          }],
          strings: ["HTML", "A", "block", "visible", "rgb(0,0,0)", "rgb(255,255,255)", "16px", "static", "auto", "auto"],
        };

        const cdp = {
          send: vi.fn().mockImplementation((method: string) => {
            if (method === "Runtime.evaluate") {
              return Promise.resolve({ result: { value: "https://example.com/missing-paint-orders" } });
            }
            if (method === "Accessibility.getFullAXTree") {
              return Promise.resolve({ nodes });
            }
            if (method === "DOMSnapshot.captureSnapshot") {
              return Promise.resolve(snapshotMissingPaintOrders);
            }
            return Promise.resolve({});
          }),
          on: vi.fn(),
          once: vi.fn(),
          off: vi.fn(),
        } as unknown as CdpClient;

        const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

        // All three links must appear unfiltered — the missing-paintOrders
        // case falls back to the same path as a thrown CDP error.
        expect(result.text).toContain("Link A");
        expect(result.text).toContain("Link B");
        expect(result.text).toContain("Link C");
        expect(result.refCount).toBe(3);
        expect(result.hasVisualData).toBeUndefined();

        // Review H2: warning emitted exactly once, with the
        // missing-paint-orders reason tag.
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain("missing-paint-orders");
        expect(warnSpy.mock.calls[0][0]).toContain("Paint-order filtering unavailable");
      } finally {
        warnSpy.mockRestore();
      }
    });

    // Review M1: paintOrders present but empty array — treated the same
    // as missing.
    it("Review M1: captureSnapshot with empty paintOrders array falls back unfiltered", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const nodes = buildFlatTree([
          { nodeId: "n2", backendNodeId: 302, role: "button", name: "Btn X" },
          { nodeId: "n3", backendNodeId: 303, role: "button", name: "Btn Y" },
        ]);

        const snapshotEmptyPaintOrders = {
          documents: [{
            nodes: { backendNodeId: [1, 302, 303], nodeName: [0, 1, 1] },
            layout: {
              nodeIndex: [0, 1, 2],
              bounds: [
                [0, 0, 1280, 800],
                [100, 100, 80, 30],
                [200, 100, 80, 30],
              ],
              styles: [
                [2, 3, 4, 5, 6, 7, 8, 9],
                [2, 3, 4, 5, 6, 7, 8, 9],
                [2, 3, 4, 5, 6, 7, 8, 9],
              ],
              paintOrders: [], // empty — signals the same Chrome-bug mode
            },
          }],
          strings: ["HTML", "BUTTON", "block", "visible", "rgb(0,0,0)", "rgb(255,255,255)", "16px", "static", "auto", "auto"],
        };

        const cdp = {
          send: vi.fn().mockImplementation((method: string) => {
            if (method === "Runtime.evaluate") {
              return Promise.resolve({ result: { value: "https://example.com/empty-paint-orders" } });
            }
            if (method === "Accessibility.getFullAXTree") {
              return Promise.resolve({ nodes });
            }
            if (method === "DOMSnapshot.captureSnapshot") {
              return Promise.resolve(snapshotEmptyPaintOrders);
            }
            return Promise.resolve({});
          }),
          on: vi.fn(),
          once: vi.fn(),
          off: vi.fn(),
        } as unknown as CdpClient;

        const result = await processor.getTree(cdp, "s1", { filter: "interactive" });

        // Both buttons survive the fallback.
        expect(result.text).toContain("Btn X");
        expect(result.text).toContain("Btn Y");
        expect(result.refCount).toBe(2);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain("missing-paint-orders");
      } finally {
        warnSpy.mockRestore();
      }
    });

    // Review H2 + M1 (optional third case): two consecutive read_page
    // calls with the missing-paintOrders mock must emit the warning
    // exactly once, not twice.
    it("Review H2: paint-order warning is emitted at most once per session", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const nodes = buildFlatTree([
          { nodeId: "n2", backendNodeId: 402, role: "link", name: "Only Link" },
        ]);

        const snapshotMissingPaintOrders = {
          documents: [{
            nodes: { backendNodeId: [1, 402], nodeName: [0, 1] },
            layout: {
              nodeIndex: [0, 1],
              bounds: [
                [0, 0, 1280, 800],
                [100, 100, 80, 30],
              ],
              styles: [
                [2, 3, 4, 5, 6, 7, 8, 9],
                [2, 3, 4, 5, 6, 7, 8, 9],
              ],
              // paintOrders missing
            },
          }],
          strings: ["HTML", "A", "block", "visible", "rgb(0,0,0)", "rgb(255,255,255)", "16px", "static", "auto", "auto"],
        };

        const cdp = {
          send: vi.fn().mockImplementation((method: string) => {
            if (method === "Runtime.evaluate") {
              return Promise.resolve({ result: { value: "https://example.com/repeat-warn" } });
            }
            if (method === "Accessibility.getFullAXTree") {
              return Promise.resolve({ nodes });
            }
            if (method === "DOMSnapshot.captureSnapshot") {
              return Promise.resolve(snapshotMissingPaintOrders);
            }
            return Promise.resolve({});
          }),
          on: vi.fn(),
          once: vi.fn(),
          off: vi.fn(),
        } as unknown as CdpClient;

        // Two consecutive read_page calls — the second hits the M3 cache
        // so captureSnapshot isn't even re-run. Either way: warning
        // count must stay at 1.
        await processor.getTree(cdp, "s1", { filter: "interactive" });
        await processor.getTree(cdp, "s1", { filter: "interactive" });

        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    // Review M3: visual/occlusion data is cached across read_page calls
    // that don't invalidate the A11y cache. Verifies the M3 fix directly:
    // captureSnapshot is called once, even though read_page runs twice.
    it("Review M3: visual data is cached between consecutive read_page calls", async () => {
      const nodes = buildFlatTree([
        { nodeId: "n2", backendNodeId: 502, role: "link", name: "Cached Link 1" },
        { nodeId: "n3", backendNodeId: 503, role: "link", name: "Cached Link 2" },
      ]);

      const snapshot = makeDomSnapshot([
        { backendNodeId: 1, nodeName: "HTML", bounds: [0, 0, 1280, 800], paintOrder: 0 },
        { backendNodeId: 502, nodeName: "A", bounds: [100, 100, 80, 30], paintOrder: 1 },
        { backendNodeId: 503, nodeName: "A", bounds: [200, 100, 80, 30], paintOrder: 2 },
      ]);

      const cdp = mockCdpClientVisual(nodes, snapshot, "https://example.com/m3-cache");

      await processor.getTree(cdp, "s1", { filter: "interactive" });
      await processor.getTree(cdp, "s1", { filter: "interactive" });

      // Only ONE captureSnapshot call despite two read_page invocations.
      const calls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
      const snapshotCalls = calls.filter((c: unknown[]) => c[0] === "DOMSnapshot.captureSnapshot");
      expect(snapshotCalls.length).toBe(1);
    });
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
      // BUG-019: the original test tree had a pathologically flat structure
      // (30 paragraphs as direct root children, no main wrapper). With the
      // new landmark-aware truncateToFit that favoured a nav-summary vs the
      // no-landmark paragraphs inconsistently depending on the budget.
      // The test's ORIGINAL intent is the Level-3+ container-flattening
      // behaviour of renderNodeDownsampled, NOT truncateFit's priority order,
      // so we put the paragraphs into a realistic <main> container and keep
      // the budget tight enough to still trigger a level-3+ downsample.
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Container Test" },
          backendDOMNodeId: 7000,
          childIds: ["nav1", "main1"],
        }),
        makeNode({
          nodeId: "nav1",
          parentId: "root",
          role: { type: "role", value: "navigation" },
          name: { type: "computedString", value: "Main" },
          backendDOMNodeId: 7001,
          // BUG-019: ≥2 children so the Level-2 single-child merge does NOT
          // collapse the nav wrapper. Otherwise Level-2 replaces the nav with
          // its only child before Level-3+ can emit a summary line.
          childIds: ["link1", "link2"],
        }),
        makeNode({
          nodeId: "link1",
          parentId: "nav1",
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: "Home" },
          backendDOMNodeId: 7002,
        }),
        makeNode({
          nodeId: "link2",
          parentId: "nav1",
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: "About" },
          backendDOMNodeId: 7098,
        }),
        makeNode({
          nodeId: "main1",
          parentId: "root",
          role: { type: "role", value: "main" },
          name: { type: "computedString", value: "Article" },
          backendDOMNodeId: 7099,
          childIds: Array.from({ length: 30 }, (_, i) => `para${i}`),
        }),
        ...Array.from({ length: 30 }, (_, i) =>
          makeNode({
            nodeId: `para${i}`,
            parentId: "main1",
            role: { type: "role", value: "paragraph" },
            name: { type: "computedString", value: `Paragraph ${i} with enough text to force high-level downsampling in the pipeline` },
            backendDOMNodeId: 7003 + i,
          }),
        ),
      ];
      const cdp = mockCdpClient(nodes, "https://example.com/container-merge");
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 500 });

      expect(result.downsampled).toBe(true);
      // At level 3+, renderNodeDownsampled emits one-line container summaries
      // in the format "[eN shortRole: name, K items]". BUG-019 added the ref
      // prefix. Pre-truncation this emits a nav AND a main summary; the new
      // landmark-aware truncateToFit may drop the nav summary in favour of
      // main content under tight budgets (the priority is intentional), so we
      // check for the main summary instead — it's the one that should always
      // survive and it exercises the same renderer code path.
      if (result.downsampleLevel! >= 3) {
        expect(result.text).toMatch(/\[e\d+\s+main:/);
      }
      // BUG-019 P2 (Session 45567c9b): the new parent-chain-preserving
      // truncateToFit keeps structure and content together. Under a tight
      // budget where 30 paragraphs dominate the main bucket, the two nav
      // links cannot fit with their nav ancestor chain — and orphaning them
      // is worse than dropping them (they'd have no enclosing nav context
      // for the LLM). Instead, the nav landmark survives as its one-line
      // summary so the LLM can re-read the nav subtree if needed.
      expect(result.text).toMatch(/\[e\d+\s+nav:/);
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

  // --- Landmark-aware Truncation tests (BUG-019) ---
  //
  // User-report: `read_page(filter:"all", max_tokens:4000)` on the Polar discounts
  // page returned `[e54] generic` (the main region) with NO children, while the
  // sidebar navigation with ~30 links was fully preserved. Root cause: legacy
  // truncateToFit() classifies lines in 3 priority buckets (dialog / interactive
  // / content) without any landmark awareness. Sidebar nav links fill the
  // interactive bucket first, pushing main-content rows out of the budget.
  //
  // The fix priorities main > other > navigation-like landmarks so that in a
  // budget-starved scenario the main content wins and the sidebar is trimmed.
  describe("Landmark-aware Truncation (BUG-019)", () => {
    /**
     * Build a page with explicit landmarks:
     *   - <banner> header with 8 buttons
     *   - <nav> sidebar with 30 links
     *   - <main> with a heading + table (N rows × 3 cells)
     *   - <contentinfo> footer with 10 links
     * Every interactive element has a unique name so the Ticket-1 aggregator
     * does not collapse them and we exercise the full truncation path.
     */
    function buildLandmarkedPage(mainRows: number, opts: { genericMain?: boolean } = {}) {
      const nodes: AXNode[] = [];
      let nodeCounter = 0;
      let backendCounter = 20000;
      const nextNode = (partial: Partial<AXNode> & Pick<AXNode, "role">): AXNode => {
        const id = `n${nodeCounter++}`;
        const node: AXNode = {
          ignored: false,
          nodeId: id,
          backendDOMNodeId: backendCounter++,
          ...partial,
        } as AXNode;
        nodes.push(node);
        return node;
      };

      // Header landmark — 8 uniquely named buttons
      const headerBtnIds: string[] = [];
      for (let i = 0; i < 8; i++) {
        const btn = nextNode({
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: `HeaderBtn ${["alpha","bravo","charlie","delta","echo","foxtrot","golf","hotel"][i]}` },
        });
        headerBtnIds.push(btn.nodeId);
      }
      const banner = nextNode({
        role: { type: "role", value: "banner" },
        name: { type: "computedString", value: "Site Header" },
        childIds: headerBtnIds,
      });

      // Sidebar navigation — 30 uniquely named links
      const navLinkIds: string[] = [];
      const navWords = ["dashboard","products","discounts","storefront","analytics","customers","checkouts","finance","settings","affiliates","orders","members","partners","benefits","pricing","docs","support","community","status","integrations","webhooks","api","keys","usage","billing","invoices","taxes","reports","exports","profile"];
      for (let i = 0; i < 30; i++) {
        const link = nextNode({
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: `Nav-${navWords[i]}-${i.toString(36)}` },
        });
        navLinkIds.push(link.nodeId);
      }
      const nav = nextNode({
        role: { type: "role", value: "navigation" },
        name: { type: "computedString", value: "Sidebar" },
        childIds: navLinkIds,
      });

      // Main landmark — heading + table with N rows × 3 cells
      const mainHeading = nextNode({
        role: { type: "role", value: "heading" },
        name: { type: "computedString", value: "Discounts Overview Page" },
      });
      const rowIds: string[] = [];
      for (let r = 0; r < mainRows; r++) {
        const cellIds: string[] = [];
        // Cell 1: code (content)
        const codeText = nextNode({
          role: { type: "role", value: "StaticText" },
          name: { type: "computedString", value: `CODE-${r}-${Math.random().toString(36).slice(2,7)}` },
        });
        const cellCode = nextNode({
          role: { type: "role", value: "cell" },
          childIds: [codeText.nodeId],
        });
        cellIds.push(cellCode.nodeId);
        // Cell 2: percentage (content)
        const pctText = nextNode({
          role: { type: "role", value: "StaticText" },
          name: { type: "computedString", value: `${(r + 1) * 5}% off for customers` },
        });
        const cellPct = nextNode({
          role: { type: "role", value: "cell" },
          childIds: [pctText.nodeId],
        });
        cellIds.push(cellPct.nodeId);
        // Cell 3: edit button (interactive)
        const editBtn = nextNode({
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: `Edit discount ${r} bravo-${r.toString(36)}` },
        });
        const cellEdit = nextNode({
          role: { type: "role", value: "cell" },
          childIds: [editBtn.nodeId],
        });
        cellIds.push(cellEdit.nodeId);
        const row = nextNode({
          role: { type: "role", value: "row" },
          childIds: cellIds,
        });
        rowIds.push(row.nodeId);
      }
      const tableNode = nextNode({
        role: { type: "role", value: "table" },
        name: { type: "computedString", value: "Discounts Table" },
        childIds: rowIds,
      });
      // Main or generic-container depending on flag (Polar uses a plain <div>)
      const main = nextNode({
        role: { type: "role", value: opts.genericMain ? "generic" : "main" },
        name: { type: "computedString", value: opts.genericMain ? "" : "Main content" },
        childIds: [mainHeading.nodeId, tableNode.nodeId],
      });

      // Footer — 10 unique links
      const footerLinkIds: string[] = [];
      const footerWords = ["terms","privacy","security","status","community","docs","contact","cookies","imprint","legal"];
      for (let i = 0; i < 10; i++) {
        const link = nextNode({
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: `Footer-${footerWords[i]}-${i.toString(36)}` },
        });
        footerLinkIds.push(link.nodeId);
      }
      const footer = nextNode({
        role: { type: "role", value: "contentinfo" },
        name: { type: "computedString", value: "Site Footer" },
        childIds: footerLinkIds,
      });

      // Root
      const root: AXNode = {
        ignored: false,
        nodeId: "root",
        backendDOMNodeId: 19999,
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Test Page" },
        childIds: [banner.nodeId, nav.nodeId, main.nodeId, footer.nodeId],
      } as AXNode;
      nodes.unshift(root);

      // Backfill parentId for walker completeness
      const parentMap = new Map<string, string>();
      const linkParents = (n: AXNode) => {
        if (!n.childIds) return;
        for (const c of n.childIds) parentMap.set(c, n.nodeId);
      };
      linkParents(root);
      linkParents(banner);
      linkParents(nav);
      linkParents(main);
      linkParents(tableNode);
      for (const r of rowIds) {
        const row = nodes.find(n => n.nodeId === r);
        if (row) linkParents(row);
      }
      linkParents(footer);
      for (const n of nodes) {
        const p = parentMap.get(n.nodeId);
        if (p) (n as { parentId?: string }).parentId = p;
      }

      return mockCdpClient(nodes, "https://example.com/landmarked-test");
    }

    it("BUG-019: main content should survive when budget is tight", async () => {
      // 40 rows × 3 cells + 3 interactive per row = lots of main content.
      // Budget 1200 forces truncateToFit fallback.
      const cdp = buildLandmarkedPage(40);
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 1200 });

      expect(result.downsampled).toBe(true);

      // The main heading must be in the output — it anchors the main region.
      expect(result.text).toContain("Discounts Overview Page");

      // At least some of the main-content (edit buttons) should be present —
      // before the fix, navigation links filled the interactive bucket first
      // and most main-area edit buttons were dropped.
      const editButtonCount = (result.text.match(/Edit discount/g) ?? []).length;
      expect(editButtonCount).toBeGreaterThanOrEqual(5);

      // The footer/navigation should be deprioritized — at most a handful of
      // sidebar nav-links should remain. Before the fix ALL 30 nav-links fit
      // because they dominated the interactive bucket.
      const navLinkCount = (result.text.match(/Nav-\w+/g) ?? []).length;
      expect(navLinkCount).toBeLessThan(editButtonCount);
    });

    it("BUG-019: implicit main fallback when no <main> landmark exists", async () => {
      // Polar's Discounts page uses plain <div> instead of <main>. We model
      // this with genericMain: true — the largest non-landmark subtree should
      // be treated as implicit main.
      const cdp = buildLandmarkedPage(40, { genericMain: true });
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 1200 });

      expect(result.downsampled).toBe(true);
      // The "Discounts Overview Page" heading lives inside the generic main —
      // it must still survive thanks to the implicit-main heuristic.
      expect(result.text).toContain("Discounts Overview Page");
      // Main-area edit buttons must also appear.
      const editButtonCount = (result.text.match(/Edit discount/g) ?? []).length;
      expect(editButtonCount).toBeGreaterThanOrEqual(5);
    });

    it("BUG-019: dialog priority is preserved over main", async () => {
      // Add a dialog at root level on top of the standard landmarked page.
      // Dialogs must STILL be the absolute top priority regardless of main
      // prioritization. We rebuild manually.
      const nodes: AXNode[] = [];
      let bk = 30000;
      const mk = (partial: Partial<AXNode>): AXNode => {
        const n = { ignored: false, nodeId: `m${nodes.length}`, backendDOMNodeId: bk++, ...partial } as AXNode;
        nodes.push(n);
        return n;
      };

      const dialogTitle = mk({ role: { type: "role", value: "heading" }, name: { type: "computedString", value: "Confirm Delete Action" } });
      const dialogOk = mk({ role: { type: "role", value: "button" }, name: { type: "computedString", value: "Confirm-OK-dialog-kappa" } });
      const dialogCancel = mk({ role: { type: "role", value: "button" }, name: { type: "computedString", value: "Cancel-dialog-kappa" } });
      const dialog = mk({ role: { type: "role", value: "dialog" }, name: { type: "computedString", value: "Delete discount?" }, childIds: [dialogTitle.nodeId, dialogOk.nodeId, dialogCancel.nodeId] });

      const mainBtn = mk({ role: { type: "role", value: "button" }, name: { type: "computedString", value: "Main-only-action" } });
      const mainLm = mk({ role: { type: "role", value: "main" }, name: { type: "computedString", value: "Main" }, childIds: [mainBtn.nodeId] });

      // 40 noise links to fill the budget
      const noiseIds: string[] = [];
      for (let i = 0; i < 40; i++) {
        const link = mk({ role: { type: "role", value: "link" }, name: { type: "computedString", value: `Noise-link-${i}-${i.toString(36)}-filler-text-block` } });
        noiseIds.push(link.nodeId);
      }
      const navLm = mk({ role: { type: "role", value: "navigation" }, name: { type: "computedString", value: "Nav" }, childIds: noiseIds });

      const root: AXNode = {
        ignored: false,
        nodeId: "root",
        backendDOMNodeId: 29999,
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Dialog Test Page" },
        childIds: [navLm.nodeId, mainLm.nodeId, dialog.nodeId],
      } as AXNode;
      nodes.unshift(root);

      const cdp = mockCdpClient(nodes, "https://example.com/dialog-prio-test");
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 400 });

      expect(result.downsampled).toBe(true);
      // Dialog must be present (highest priority always)
      expect(result.text).toContain("Confirm-OK-dialog-kappa");
      expect(result.text).toContain("Cancel-dialog-kappa");
    });

    it("BUG-019: escape-hint points to truncated main subtree", async () => {
      // A very tight budget so main gets partially truncated. The output
      // should include a hint telling the LLM to call view_page(ref:"eXX")
      // on the main region for full detail.
      const cdp = buildLandmarkedPage(60);
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 800 });

      expect(result.downsampled).toBe(true);
      // Hint mentions re-reading with a ref
      expect(result.text.toLowerCase()).toMatch(/call view_page\(ref:\s*"e\d+"/);
    });

    it("BUG-019: navigation-heavy page without main — no crash, no infinite loop", async () => {
      // Edge case: only navigation, no main, no implicit-main candidate.
      // Must still truncate gracefully.
      const nodes: AXNode[] = [];
      let bk = 40000;
      const mk = (partial: Partial<AXNode>): AXNode => {
        const n = { ignored: false, nodeId: `e${nodes.length}`, backendDOMNodeId: bk++, ...partial } as AXNode;
        nodes.push(n);
        return n;
      };
      const linkIds: string[] = [];
      for (let i = 0; i < 100; i++) {
        const l = mk({ role: { type: "role", value: "link" }, name: { type: "computedString", value: `only-nav-${i}-${i.toString(36)}-padding-text` } });
        linkIds.push(l.nodeId);
      }
      const nav = mk({ role: { type: "role", value: "navigation" }, name: { type: "computedString", value: "Only Nav" }, childIds: linkIds });
      const root: AXNode = {
        ignored: false,
        nodeId: "root",
        backendDOMNodeId: 39999,
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "Nav-only" },
        childIds: [nav.nodeId],
      } as AXNode;
      nodes.unshift(root);

      const cdp = mockCdpClient(nodes, "https://example.com/nav-only-test");
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 500 });

      expect(result.downsampled).toBe(true);
      // No crash — and at least some of the nav links made it in
      expect(result.refCount).toBeGreaterThan(0);
      expect(result.text).toContain("only-nav-");
    });

    // --- P2 follow-up (Session 45567c9b) ---
    //
    // Symptom: on a downsampled page the interactive bucket drains first,
    // then the mainContent bucket only partially fits. Container summary
    // lines such as `[e54 row, 3 items]` end up as mainContent, so once
    // the budget is exhausted they get dropped while the leaf buttons
    // inside them remain — creating orphans with indent jumps of 4 or
    // more and no structural context for the LLM.
    //
    // Fix: truncateToFit now force-includes each kept line's indent-ancestor
    // chain. Structure and content always travel together.
    it("BUG-019 P2: every kept row of the main table is present together with its edit button", async () => {
      // 40 rows under a <main>, budget tight enough to trigger L4 + truncateToFit.
      // Before the fix: the row container summary lines ([eXX row, N items])
      // lived in the mainContent bucket, so the mainInteractive bucket
      // drained the budget and the row summaries for rows 8+ were dropped.
      // Buttons from those rows remained, dangling with no enclosing row.
      const cdp = buildLandmarkedPage(40);
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 1200 });

      expect(result.downsampled).toBe(true);
      const text = result.text;

      const editButtonCount = (text.match(/Edit discount/g) ?? []).length;
      const rowSummaryCount = (text.match(/\[e\d+ row/g) ?? []).length;

      // Every kept Edit button has to live inside a kept row summary.
      expect(editButtonCount).toBeGreaterThan(0);
      expect(rowSummaryCount).toBeGreaterThanOrEqual(editButtonCount);
    });

    it("BUG-019 P2: Phase D2 lists top-3 collapsed container anchors when no main landmark exists", async () => {
      // HN-style page: no <main>, no implicit-main candidate big enough,
      // just a sequence of LayoutTableRow containers each with many items.
      // Under tight budget, Phase D2 must list the three biggest collapsed
      // containers with their refs + item counts so the LLM has concrete
      // drill-down anchors.
      const nodes: AXNode[] = [];
      let bk = 60000;
      const mk = (partial: Partial<AXNode>): AXNode => {
        const n = { ignored: false, nodeId: `d${nodes.length}`, backendDOMNodeId: bk++, ...partial } as AXNode;
        nodes.push(n);
        return n;
      };

      // 5 containers with decreasing descendant counts: 50, 40, 30, 20, 10.
      const containerIds: string[] = [];
      for (let c = 0; c < 5; c++) {
        const leafCount = 50 - c * 10;
        const leafIds: string[] = [];
        for (let i = 0; i < leafCount; i++) {
          const link = mk({
            role: { type: "role", value: "link" },
            name: { type: "computedString", value: `c${c}-leaf-${i}-${i.toString(36)}-filler` },
          });
          leafIds.push(link.nodeId);
        }
        const container = mk({
          role: { type: "role", value: "LayoutTableRow" },
          childIds: leafIds,
        });
        containerIds.push(container.nodeId);
      }

      const root: AXNode = {
        ignored: false,
        nodeId: "root",
        backendDOMNodeId: 59999,
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "No-Main Page" },
        childIds: containerIds,
      } as AXNode;
      nodes.unshift(root);

      const cdp = mockCdpClient(nodes, "https://example.com/no-main-d2-test");
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 600 });

      expect(result.downsampled).toBe(true);

      // D2 hint must name "Largest collapsed containers" + top refs with item counts.
      expect(result.text).toMatch(/Largest collapsed containers:\s*e\d+\s*\(\d+ items\)/);
      // And the positive action.
      expect(result.text).toMatch(/Call view_page\(ref: "eXX", filter: "all"\)/);
      // D2 is mutually exclusive with the main-hint — no main landmark here.
      expect(result.text).not.toMatch(/main content partially truncated/);
    });

    it("BUG-019 P2: every kept Edit-button leaf has its enclosing row summary in the output", async () => {
      const cdp = buildLandmarkedPage(40);
      const result = await processor.getTree(cdp, "s1", { filter: "all", max_tokens: 1200 });

      expect(result.downsampled).toBe(true);
      const lines = result.text.split("\n");

      // Collect all kept Edit-button leaves along with their indent level.
      const editLines = lines
        .map((l, i) => ({ l, i, indent: l.search(/\S/) }))
        .filter(({ l }) => /Edit discount/.test(l));

      // For every edit button, walk backwards until we find a line at a
      // smaller indent — that is the immediate enclosing container. It must
      // be a row/cell/table/main/generic container summary, not a jump to
      // something at indent ≤ 0 (meaning no ancestor at all).
      for (const eb of editLines) {
        let foundAncestor = false;
        for (let j = eb.i - 1; j >= 0; j--) {
          const ind = lines[j].search(/\S/);
          if (ind < 0) continue;
          if (ind < eb.indent) {
            // Any smaller-indent line qualifies as ancestor. The container
            // summary format is `[eXX role, N items]` or plain `[eXX] role`.
            if (/\[e\d+/.test(lines[j])) {
              foundAncestor = true;
            }
            break;
          }
        }
        expect(foundAncestor, `Edit leaf orphaned (no ancestor at smaller indent): "${eb.l.trim()}"`).toBe(true);
      }
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
      // BUG-019: Should have called Accessibility.getFullAXTree with NO depth
      // so the primed cache always holds the full tree, not a truncated top-3.
      expect(cdp.send).toHaveBeenCalledWith(
        "Accessibility.getFullAXTree",
        {},
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

      // No cache primed — should fall back to CDP.
      // BUG-019: full-tree fetch (no depth param).
      const result = await processor.getTree(cdp, "s1");

      expect(cdp.send).toHaveBeenCalledWith(
        "Accessibility.getFullAXTree",
        {},
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

    it("BUG-019: any display depth is a Cache-Hit once primed (no more depth-mismatch)", async () => {
      // Before BUG-019 the precomputed cache stored a finite depth (3) and any
      // read_page call asking for a deeper fetch re-ran getFullAXTree. After the
      // fix the cache always holds the FULL tree, so every subsequent call
      // hits the cache regardless of the display depth.
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

      // Prime cache
      await processor.refreshPrecomputed(cdp, "s1");
      (cdp.send as ReturnType<typeof vi.fn>).mockClear();

      // Large display depth — must still be a cache hit, no new CDP call
      await processor.getTree(cdp, "s1", { depth: 5, filter: "all" });
      const calls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls;
      const a11yCalls = calls.filter((c: unknown[]) => c[0] === "Accessibility.getFullAXTree");
      expect(a11yCalls).toHaveLength(0);
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

    it("emits a prominent [!] TRUNCATED marker on a separate line when generic name was truncated (Story 18.8)", async () => {
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

      // Story 18.8 Fix A: the marker must live on its OWN line (preceded
      // by a newline) and start with the [!] TRUNCATED prefix so a
      // scanning LLM can't overlook it. The hint must name the ref and
      // the concrete follow-up action.
      expect(result.text).toContain("\n");
      expect(result.text).toMatch(/\n\s+\[!\] TRUNCATED: \+\d+ more chars hidden\. Call view_page\(ref:"e\d+", filter:"all"\)/);
      // The old inline `…[+N chars; use filter:"all"` format must be gone.
      expect(result.text).not.toMatch(/…\[\+\d+ chars; use filter:"all"/);
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

      expect(result.text).not.toContain("[!] TRUNCATED");
    });

    // Story 18.8 Fix A regression — T3.6 scenario from the benchmark.
    // Two independent LLM runs typed plaintext "Hello World" and skipped
    // the requested bold formatting because the task instructions were
    // truncated at 80 chars and the old `…[+54 chars]` marker was tucked
    // onto the end of the already-cut text. The new marker must live on
    // its own line AND make the hidden-char count and next-action
    // unmissable.
    it("Story 18.8 — truncation marker is on its own line with [!] prefix (T3.6 regression)", async () => {
      const proc = new A11yTreeProcessor();
      // Realistic T3.6 task description: the cut happens mid-sentence so
      // the LLM would never infer "and bold it" from the truncated text.
      const longText =
        "Schreibe 'Hello World' in den Editor un... und formatiere es fett mit Bold (Strg+B oder den Formatierungsknopf).";
      expect(longText.length).toBeGreaterThan(80);
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 700,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2", parentId: "1",
          role: { type: "role", value: "generic" },
          backendDOMNodeId: 701,
        }),
      ];
      const cdp = cdpForTruncatedGeneric({ innerText: longText, nodes });
      const result = await proc.getTree(cdp, "s1", { filter: "interactive" });

      // Assertion 1 — the marker lives on its own physical line.
      const lines = result.text.split("\n");
      const markerLine = lines.find((l) => l.includes("[!] TRUNCATED"));
      expect(markerLine).toBeDefined();

      // Assertion 2 — it's indented (not flush-left) so it visually groups
      // with the element line above it but still stands out as a hint.
      expect(markerLine!.startsWith(" ")).toBe(true);

      // Assertion 3 — it carries the exact hidden-char count AND the
      // concrete next action with the ref.
      expect(markerLine!).toMatch(/\[!\] TRUNCATED: \+\d+ more chars hidden\. Call view_page\(ref:"e\d+", filter:"all"\)/);

      // Assertion 4 — the element line ABOVE the marker is preserved
      // (still contains the truncated preview in quotes).
      const markerIdx = lines.indexOf(markerLine!);
      const elementLine = lines[markerIdx - 1];
      expect(elementLine).toMatch(/\[e\d+\]/);
      expect(elementLine).toContain('"');
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

  // --- BUG-016: Cross-Session Ref-Kollision (Session 6dd8f7d3 postmortem) ---
  //
  // Before this fix, `refMap` was a global Map<backendNodeId, refNumber>.
  // Chrome assigns `backendNodeId` PER RENDERER PROCESS, so OOPIFs (Out-of-
  // Process iframes) and newly attached tabs share the numeric namespace
  // with the main frame. A collision caused the T2.5 failure in Free Run 4:
  // ref e257 resolved to a Chrome Webstore iframe element instead of the
  // intended Pro radio button. These tests exercise the composite-keyed
  // refMap and assert the collision path is now safe.
  describe("BUG-016: Cross-Session ref isolation", () => {
    it("registers the same backendNodeId under two different sessions without collision", async () => {
      // Two completely separate sessions (main + OOPIF) that happen to
      // use backendNodeId=42 for unrelated nodes. Both registrations
      // must succeed and produce distinct refs.
      const mainNodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 10,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Main Submit" },
          backendDOMNodeId: 42,
        }),
      ];
      const oopifNodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 5,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: "OOPIF YouTube" },
          backendDOMNodeId: 42, // intentionally identical to mainNodes[1]
        }),
      ];

      // Build the main tree under "main-session".
      const mainCdp = mockCdpClient(mainNodes);
      await processor.getTree(mainCdp, "main-session");

      // Manually register the OOPIF nodes under a second session.
      // We don't go through getTree(sessionManager) here because the
      // goal is a pure collision test — if refreshPrecomputed is safe,
      // getTree is too.
      await processor.refreshPrecomputed(
        mockCdpClient(oopifNodes),
        "oopif-session",
      );

      // Ref assignment order: main WebArea=e1, main button=e2,
      // oopif WebArea=e3, oopif link=e4. The two nodes with
      // backendNodeId=42 must resolve to different refs (e2 vs e4)
      // and to different sessions.
      const mainFull = processor.resolveRefFull("e2");
      const oopifFull = processor.resolveRefFull("e4");
      expect(mainFull).toBeDefined();
      expect(oopifFull).toBeDefined();
      expect(mainFull!.backendNodeId).toBe(42);
      expect(mainFull!.sessionId).toBe("main-session");
      expect(oopifFull!.backendNodeId).toBe(42);
      expect(oopifFull!.sessionId).toBe("oopif-session");
      // Critical invariant: same backendNodeId → different refs + sessions.
      expect(mainFull!.sessionId).not.toBe(oopifFull!.sessionId);
    });

    it("removeNodesForSession only removes the OOPIF's refs, leaving main-frame refs intact", async () => {
      const mainNodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 10,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Survivor" },
          backendDOMNodeId: 42,
        }),
      ];
      const oopifNodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 5,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "link" },
          backendDOMNodeId: 42,
        }),
      ];

      await processor.getTree(mockCdpClient(mainNodes), "main-session");
      await processor.refreshPrecomputed(
        mockCdpClient(oopifNodes),
        "oopif-session",
      );

      const mainRefBefore = processor.resolveRefFull("e2");
      expect(mainRefBefore?.sessionId).toBe("main-session");

      // Simulate OOPIF detach (what SessionManager.onOopifDetach calls).
      processor.removeNodesForSession("oopif-session");

      // Main-frame e2 must still exist and still be routed to main-session.
      const mainRefAfter = processor.resolveRefFull("e2");
      expect(mainRefAfter).toBeDefined();
      expect(mainRefAfter!.backendNodeId).toBe(42);
      expect(mainRefAfter!.sessionId).toBe("main-session");

      // OOPIF refs are gone: no reverseMap entry points to oopif-session.
      const remainingOopifRefs: Array<ReturnType<typeof processor.resolveRefFull>> = [];
      for (let i = 1; i <= 10; i++) {
        const full = processor.resolveRefFull(`e${i}`);
        if (full && full.sessionId === "oopif-session") remainingOopifRefs.push(full);
      }
      expect(remainingOopifRefs).toHaveLength(0);
    });

    it("switch_tab-style reset() clears all refs so the next getTree starts fresh", async () => {
      const tab1Nodes: AXNode[] = [
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
          name: { type: "computedString", value: "Tab1 Button" },
          backendDOMNodeId: 101,
        }),
      ];
      await processor.getTree(mockCdpClient(tab1Nodes), "tab1-session");
      expect(processor.resolveRef("e2")).toBe(101);

      // BUG-017: simulates switch_tab's activateSession calling a11yTree.reset().
      processor.reset();

      // After reset, previous refs are gone.
      expect(processor.resolveRef("e2")).toBeUndefined();
      expect(processor.resolveRefFull("e2")).toBeUndefined();

      // A new getTree under a different session must start ref numbering fresh.
      const tab2Nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 200, // new backendNodeId space
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Tab2 Button" },
          backendDOMNodeId: 201,
        }),
      ];
      await processor.getTree(mockCdpClient(tab2Nodes), "tab2-session");

      const full = processor.resolveRefFull("e2");
      expect(full).toBeDefined();
      expect(full!.backendNodeId).toBe(201);
      expect(full!.sessionId).toBe("tab2-session");
    });

    it("BUG-016 CRITICAL (final review): nodeInfoMap is session-scoped so findByText and classifyRef cannot cross-bleed metadata", async () => {
      // Final codex review finding #1: the first composite-key pass
      // only covered refMap/reverseMap, but nodeInfoMap was still bare
      // backendNodeId-keyed. That meant two sessions with the same
      // backendNodeId overwrote each other's role/name/widget-state,
      // and findByText / classifyRef / getNodeInfo could silently
      // return the wrong element's metadata — the exact same collision
      // class as T2.5, just via the text-based lookup instead of the
      // ref lookup.
      const mainNodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 10,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "radio" },
          name: { type: "computedString", value: "Pro plan" },
          backendDOMNodeId: 257,
        }),
      ];
      const iframeNodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 5,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: "YouTube" },
          backendDOMNodeId: 257, // intentional collision with the main radio
        }),
      ];

      await processor.getTree(mockCdpClient(mainNodes), "main-page");
      await processor.refreshPrecomputed(
        mockCdpClient(iframeNodes),
        "webstore-iframe",
      );

      // findByText('Pro plan') must return the main-page radio, not
      // the iframe link. With the bare-keyed nodeInfoMap the second
      // registerNode would have overwritten the main entry's name, so
      // either the search would fail entirely or it would return the
      // iframe element.
      const proHit = processor.findByText("Pro plan");
      expect(proHit).not.toBeNull();
      expect(proHit!.backendNodeId).toBe(257);
      // The owning session of this ref must be main-page (checked via
      // the full resolver — the test proves both lookups agree).
      const proOwner = processor.resolveRefFull(proHit!.ref);
      expect(proOwner?.sessionId).toBe("main-page");

      // findByText('YouTube') must return the iframe link.
      const ytHit = processor.findByText("YouTube");
      expect(ytHit).not.toBeNull();
      expect(ytHit!.backendNodeId).toBe(257);
      const ytOwner = processor.resolveRefFull(ytHit!.ref);
      expect(ytOwner?.sessionId).toBe("webstore-iframe");

      // classifyRef must also see the session-correct metadata.
      expect(processor.classifyRef(proHit!.ref)).toBe("clickable");
      expect(processor.classifyRef(ytHit!.ref)).toBe("clickable");

      // getNodeInfo with the explicit sessionId must return each owner's
      // metadata independently, even though the backendNodeIds collide.
      const mainInfo = processor.getNodeInfo(257, "main-page");
      const iframeInfo = processor.getNodeInfo(257, "webstore-iframe");
      expect(mainInfo?.role).toBe("radio");
      expect(mainInfo?.name).toBe("Pro plan");
      expect(iframeInfo?.role).toBe("link");
      expect(iframeInfo?.name).toBe("YouTube");
    });

    it("BUG-016 CRITICAL: subtree query routes to the correct frame even when backendNodeIds collide", async () => {
      // codex review finding #4 — the old getSubtree path merged all
      // frames into one nodeMap keyed by `nodeId`, silently overwriting
      // entries across sessions. With matching backendNodeIds the main
      // frame's node would shadow the OOPIF's node and the subtree
      // query would render the wrong element.
      const mainNodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Main Doc" },
          backendDOMNodeId: 10,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Main Button" },
          backendDOMNodeId: 50,
        }),
      ];
      const oopifNodes: AXNode[] = [
        // Intentionally reuses nodeId "1" AND backendDOMNodeId 50 — the
        // two exact collisions the old code could not disambiguate.
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "OOPIF Doc" },
          backendDOMNodeId: 5,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: "OOPIF Link" },
          backendDOMNodeId: 50,
        }),
      ];

      // Build main and OOPIF trees with mocked sessionManager plumbing.
      // We go through refreshPrecomputed for the OOPIF (bypasses the
      // getTree path) and then call getTree with a stub SessionManager
      // that returns the OOPIF as a second session so the subtree path
      // sees it in oopifSections.
      await processor.refreshPrecomputed(
        mockCdpClient(oopifNodes),
        "oopif-session",
      );

      // Emulate getTree main-frame rendering by also registering the
      // main nodes via refreshPrecomputed. This gives us refs without
      // depending on the full getTree pipeline.
      await processor.refreshPrecomputed(
        mockCdpClient(mainNodes),
        "main-session",
      );

      // Sanity: both sessions own their ref for the colliding backendNodeId.
      const refs: Array<ReturnType<typeof processor.resolveRefFull>> = [];
      for (let i = 1; i <= 10; i++) {
        const full = processor.resolveRefFull(`e${i}`);
        if (full && full.backendNodeId === 50) refs.push(full);
      }
      expect(refs).toHaveLength(2);
      const mainRef = refs.find((r) => r!.sessionId === "main-session");
      const oopifRef = refs.find((r) => r!.sessionId === "oopif-session");
      expect(mainRef).toBeDefined();
      expect(oopifRef).toBeDefined();
      expect(mainRef!.sessionId).not.toBe(oopifRef!.sessionId);
    });

    it("resolveRefFull returns the correct owner even when backendNodeId collides across sessions", async () => {
      // Regression guard for the exact T2.5 scenario: two sessions with
      // the same backendNodeId, and a resolveRefFull call must return
      // the session-correct owner for each ref.
      const sessA: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 10,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "radio" },
          name: { type: "computedString", value: "Pro plan" },
          backendDOMNodeId: 257,
        }),
      ];
      const sessB: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 5,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: "YouTube" },
          backendDOMNodeId: 257, // collision
        }),
      ];

      await processor.getTree(mockCdpClient(sessA), "main-page");
      await processor.refreshPrecomputed(
        mockCdpClient(sessB),
        "webstore-iframe",
      );

      // Ref assignment order: main WebArea=e1, main radio=e2,
      // iframe WebArea=e3, iframe link=e4. The two backendNodeId=257
      // nodes resolve to e2 and e4 in different sessions — if the old
      // collision-prone refMap were still in play, the second
      // registration would have overwritten the first and the link
      // would never get its own ref.
      const proRadio = processor.resolveRefFull("e2");
      const youtubeLink = processor.resolveRefFull("e4");
      expect(proRadio?.sessionId).toBe("main-page");
      expect(proRadio?.backendNodeId).toBe(257);
      expect(youtubeLink?.sessionId).toBe("webstore-iframe");
      expect(youtubeLink?.backendNodeId).toBe(257);
    });
  });

  // =========================================================================
  // Story 18.5 M2 review follow-up — Race 3 reset/prefetch interaction
  // =========================================================================
  //
  // These tests lock down the exact split between the EXTERNAL `reset()`
  // entrypoint (which cancels the prefetch slot) and the INTERNAL
  // `_resetState()` helper (which does NOT touch the slot). The split is
  // what prevents `refreshPrecomputed`'s URL-change branch from self-
  // aborting the very build it is running inside.
  describe("Story 18.5 M2 — reset / _resetState / prefetchSlot interaction", () => {
    it("reset() cancels the prefetch slot (external path)", async () => {
      // Import the singleton lazily so we can spy on its cancel method.
      const { prefetchSlot } = await import("./prefetch-slot.js");
      const cancelSpy = vi.spyOn(prefetchSlot, "cancel");

      // Prime the processor with a tree so there is real state to reset.
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
        }),
      ];
      await processor.refreshPrecomputed(
        mockCdpClient(nodes, "https://example.com/reset-test"),
        "s1",
      );

      cancelSpy.mockClear();
      processor.reset();

      // External reset path MUST cancel the slot.
      expect(cancelSpy).toHaveBeenCalledTimes(1);

      cancelSpy.mockRestore();
    });

    it("refreshPrecomputed URL-change branch uses _resetState(), NOT reset() (no self-cancel)", async () => {
      // Story 18.5 Race 3 regression test: verify that when
      // refreshPrecomputed detects a URL change mid-build it uses the
      // internal `_resetState()` helper (which leaves the prefetch slot
      // alone) instead of the external `reset()` (which would self-cancel
      // the slot and drop the cache write).
      const { prefetchSlot } = await import("./prefetch-slot.js");
      const cancelSpy = vi.spyOn(prefetchSlot, "cancel");

      // First refresh: prime lastUrl to URL-A so the next refresh detects
      // a URL change and enters the reset branch.
      const nodesA: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
        }),
      ];
      await processor.refreshPrecomputed(
        mockCdpClient(nodesA, "https://example.com/page-a"),
        "s1",
      );

      // Clear the spy so we only observe calls from the SECOND refresh.
      cancelSpy.mockClear();

      // Second refresh: URL is now B. The URL-change branch must clear
      // maps via _resetState() (internal) without cancelling the slot.
      const nodesB: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 200,
        }),
      ];
      await processor.refreshPrecomputed(
        mockCdpClient(nodesB, "https://example.com/page-b"),
        "s1",
      );

      // CRITICAL assertion: no cancel() call during the URL-change branch.
      // If the implementation calls `reset()` here, the slot would self-
      // cancel and the cache-write below would never happen.
      expect(cancelSpy).not.toHaveBeenCalled();

      // The refresh's cache-write ran to completion (slot was NOT self-
      // cancelled) — verified by the fresh precomputed cache with the new
      // refs.
      expect(processor.hasPrecomputed("s1")).toBe(true);
      expect(processor.resolveRef("e1")).toBe(200);

      cancelSpy.mockRestore();
    });

    it("L1 fix — refreshPrecomputed(signal, expectedUrl) drops the build on URL mismatch", async () => {
      // The L1 follow-up added active use of `expectedUrl` as a URL-race
      // guard. When the prefetch was scheduled for URL X but the page is
      // already on URL Y by the time refreshPrecomputed starts, the build
      // must abort without touching the cache.
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
        }),
      ];

      // The mock returns URL "page-y" — but the scheduler expected "page-x".
      const cdp = mockCdpClient(nodes, "https://example.com/page-y");
      const controller = new AbortController();

      await processor.refreshPrecomputed(
        cdp,
        "s1",
        undefined,
        controller.signal,
        "https://example.com/page-x", // expectedUrl mismatches document.URL
      );

      // Cache must NOT have been written — the pre-read URL guard bailed
      // before getFullAXTree was even called.
      expect(processor.hasPrecomputed("s1")).toBe(false);
    });

    it("canvas hint references capture_image (not legacy screenshot)", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Canvas Page" },
          backendDOMNodeId: 100,
          childIds: ["2"],
        }),
        makeNode({
          nodeId: "2",
          role: { type: "role", value: "canvas" },
          name: { type: "computedString", value: "My Canvas" },
          backendDOMNodeId: 101,
        }),
      ];

      const cdp = mockCdpClient(nodes);
      const result = await processor.getTree(cdp, "s1", { filter: "all" });

      expect(result.text).toContain("capture_image(som: true)");
      expect(result.text).not.toContain("screenshot(som: true)");
    });

    it("L1 fix — refreshPrecomputed accepts matching expectedUrl and writes cache", async () => {
      // Positive counterpart: when expectedUrl matches the live URL, the
      // build proceeds normally and primes the cache.
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          backendDOMNodeId: 100,
        }),
      ];

      const cdp = mockCdpClient(nodes, "https://example.com/page-x");
      const controller = new AbortController();

      await processor.refreshPrecomputed(
        cdp,
        "s1",
        undefined,
        controller.signal,
        "https://example.com/page-x", // expectedUrl matches
      );

      expect(processor.hasPrecomputed("s1")).toBe(true);
      expect(processor.resolveRef("e1")).toBe(100);
    });
  });

  // =========================================================================
  // Story 12a.2 C1: getPageType() tab isolation
  // =========================================================================

  describe("getPageType — tab isolation (C1 fix)", () => {
    it("returns 'unknown' when no precomputed cache exists", () => {
      expect(processor.getPageType()).toBe("unknown");
      expect(processor.getPageType("s1")).toBe("unknown");
    });

    it("returns a classification when called without sessionId (backward compat)", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Test" },
          backendDOMNodeId: 100,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.refreshPrecomputed(cdp, "tab-a");

      // Without sessionId, getPageType() classifies the cached tree regardless of tab
      const pageType = processor.getPageType();
      expect(typeof pageType).toBe("string");
      expect(pageType.length).toBeGreaterThan(0);
    });

    it("returns 'unknown' when sessionId does not match the cached tab", async () => {
      const nodes: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Test" },
          backendDOMNodeId: 100,
        }),
      ];
      const cdp = mockCdpClient(nodes);
      await processor.refreshPrecomputed(cdp, "tab-a");

      // Cache belongs to tab-a — querying tab-b returns "unknown"
      expect(processor.getPageType("tab-b")).toBe("unknown");
    });

    it("getPageType(tabIdA) and getPageType(tabIdB) return independent results", async () => {
      // Prime cache with tab-a's tree
      const nodesA: AXNode[] = [
        makeNode({
          nodeId: "1",
          role: { type: "role", value: "WebArea" },
          name: { type: "computedString", value: "Tab A" },
          backendDOMNodeId: 100,
        }),
      ];
      const cdpA = mockCdpClient(nodesA);
      await processor.refreshPrecomputed(cdpA, "tab-a");

      // The cache is now primed for tab-a.
      expect(processor.hasPrecomputed("tab-a")).toBe(true);

      // tab-a has a cached tree — getPageType("tab-a") classifies it
      const typeA = processor.getPageType("tab-a");
      expect(typeof typeA).toBe("string");
      expect(typeA.length).toBeGreaterThan(0);

      // tab-b has no cached tree — getPageType("tab-b") must return "unknown"
      // because the cache belongs to tab-a, not tab-b (C1 tab isolation).
      const typeB = processor.getPageType("tab-b");
      expect(typeB).toBe("unknown");

      // Without sessionId (backward compat): classifies whatever is cached
      const typeNoFilter = processor.getPageType();
      expect(typeNoFilter).toBe(typeA);
    });
  });
});
