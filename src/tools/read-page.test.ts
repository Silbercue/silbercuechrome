import { describe, it, expect, vi, beforeEach } from "vitest";
import { readPageSchema, readPageHandler } from "./read-page.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import { a11yTree } from "../cache/a11y-tree.js";
import type { AXNode } from "../cache/a11y-tree.js";

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
});
