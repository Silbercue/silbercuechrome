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

  // Test 3: Depth limitation
  it("should respect depth parameter", async () => {
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
    const result = await processor.getTree(cdp, "s1", { depth: 1 });

    expect(result.depth).toBe(1);
    // CDP depth parameter is passed through
    expect(cdp.send).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      { depth: 1 },
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
});
