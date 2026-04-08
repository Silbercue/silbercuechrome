import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { a11yTree } from "../cache/a11y-tree.js";
import { selectorCache } from "../cache/selector-cache.js";
import type { AXNode } from "../cache/a11y-tree.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";

vi.mock("../cdp/debug.js", () => ({
  debug: vi.fn(),
}));

// --- Helpers ---

function mockCdpClient(
  resolveNodeResult = { object: { objectId: "obj-1" } },
  otherResults: Record<string, unknown> = {},
): CdpClient {
  return {
    send: vi.fn().mockImplementation((method: string) => {
      if (method === "DOM.resolveNode") {
        return Promise.resolve(resolveNodeResult);
      }
      if (method === "DOM.getDocument") {
        return Promise.resolve(otherResults["DOM.getDocument"] ?? { root: { nodeId: 1 } });
      }
      if (method === "DOM.querySelector") {
        return Promise.resolve(otherResults["DOM.querySelector"] ?? { nodeId: 10 });
      }
      if (method === "DOM.describeNode") {
        return Promise.resolve(otherResults["DOM.describeNode"] ?? { node: { backendNodeId: 42 } });
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

function mockCdpForTree(nodes: AXNode[], url = "https://example.com"): CdpClient {
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

// --- Tests ---

describe("resolveElement", () => {
  beforeEach(() => {
    a11yTree.reset();
    // BUG-016: selectorCache is a module-level singleton; carry-over from
    // prior tests would hit the cache branch before resolveRefFull runs
    // and mask routing regressions.
    selectorCache.invalidate();
  });

  it("resolves ref to backendNodeId and objectId on main session", async () => {
    // Set up refs via getTree
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
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "main-session");

    // Now resolve
    const cdp = mockCdpClient();
    const result = await resolveElement(cdp, "main-session", { ref: "e2" });

    expect(result.backendNodeId).toBe(101);
    expect(result.objectId).toBe("obj-1");
    expect(result.resolvedVia).toBe("ref");
    expect(result.resolvedSessionId).toBe("main-session");
    expect(result.role).toBe("button");
    expect(result.name).toBe("OK");
  });

  it("BUG-016: routes to OOPIF session from resolveRefFull owner info", async () => {
    // Set up a node under main-session via getTree.
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
        name: { type: "computedString", value: "Email" },
        backendDOMNodeId: 201,
      }),
    ];
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "oopif-session-1");

    // With the composite-key schema, routing is driven directly by
    // resolveRefFull — no linear scan in SessionManager is needed.
    const full = a11yTree.resolveRefFull("e2");
    expect(full).toEqual({ backendNodeId: 201, sessionId: "oopif-session-1" });

    const cdp = mockCdpClient();
    const result = await resolveElement(cdp, "main-session", { ref: "e2" });

    // resolveElement MUST route DOM.resolveNode to the OOPIF session stored
    // in the refMap, not to the `sessionId` parameter it was called with.
    expect(result.resolvedSessionId).toBe("oopif-session-1");
    expect(cdp.send).toHaveBeenCalledWith(
      "DOM.resolveNode",
      { backendNodeId: 201 },
      "oopif-session-1",
    );
  });

  it("BUG-016: routes to main session when the node was registered under main", async () => {
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
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "main-session");

    const cdp = mockCdpClient();
    const result = await resolveElement(cdp, "main-session", { ref: "e2" });

    expect(result.resolvedSessionId).toBe("main-session");
  });

  it("throws RefNotFoundError for unknown ref", async () => {
    const cdp = mockCdpClient();
    await expect(resolveElement(cdp, "s1", { ref: "e999" })).rejects.toThrow(RefNotFoundError);
  });

  it("throws RefNotFoundError for stale DOM node", async () => {
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
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "s1");

    // DOM.resolveNode throws
    const cdp = {
      send: vi.fn().mockRejectedValue(new Error("No node with given id found")),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    await expect(resolveElement(cdp, "s1", { ref: "e2" })).rejects.toThrow("stale ref");
  });

  it("throws descriptive error when DOM agent is not enabled", async () => {
    const nodes: AXNode[] = [
      makeNode({ nodeId: "1", role: { type: "role", value: "rootWebArea" }, backendDOMNodeId: 100 }),
      makeNode({
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        backendDOMNodeId: 101,
      }),
    ];
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "s1");

    // DOM.getDocument succeeds but DOM.resolveNode throws "DOM agent needs to be enabled"
    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "DOM.getDocument") return Promise.resolve({ root: { nodeId: 1 } });
        if (method === "DOM.resolveNode") return Promise.reject(new Error("CDP error -32000: DOM agent needs to be enabled first."));
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    await expect(resolveElement(cdp, "s1", { ref: "e2" })).rejects.toThrow("DOM domain not enabled");
  });

  it("resolves CSS selector on main session", async () => {
    const cdp = mockCdpClient(
      { object: { objectId: "obj-css" } },
      {
        "DOM.getDocument": { root: { nodeId: 1 } },
        "DOM.querySelector": { nodeId: 10 },
        "DOM.describeNode": { node: { backendNodeId: 42 } },
      },
    );

    const result = await resolveElement(cdp, "main-session", { selector: "#btn" });

    expect(result.backendNodeId).toBe(42);
    expect(result.objectId).toBe("obj-css");
    expect(result.resolvedVia).toBe("css");
    expect(result.resolvedSessionId).toBe("main-session");
  });
});

describe("buildRefNotFoundError", () => {
  beforeEach(() => {
    a11yTree.reset();
  });

  it("returns error message with suggestion when refs exist", async () => {
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
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "s1");

    const error = buildRefNotFoundError("e99");
    expect(error).toContain("e99 not found");
    expect(error).toContain("Did you mean");
  });

  it("returns error message with role-filtered suggestion", async () => {
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
        name: { type: "computedString", value: "Click" },
        backendDOMNodeId: 101,
      }),
      makeNode({
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Search" },
        backendDOMNodeId: 102,
      }),
    ];
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "s1");

    const error = buildRefNotFoundError("e99", new Set(["textbox"]));
    expect(error).toContain("Did you mean");
    expect(error).toContain("textbox");
  });

  it("returns stale-refs message when no refs exist (findClosestRef returns null)", () => {
    const error = buildRefNotFoundError("e1");
    expect(error).toContain("e1 not found");
    expect(error).toContain("possibly stale");
    expect(error).toContain("read_page");
    expect(error).not.toContain("Did you mean");
  });

  it("returns stale-refs message when suggestion ref equals requested ref", async () => {
    // This is a safety-net case — if the ref is in the reverseMap but
    // resolveRef failed elsewhere, the suggestion would echo back the same ref.
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
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "s1");

    // e2 exists in the tree — findClosestRef("e2") returns { ref: "e2", ... }
    const error = buildRefNotFoundError("e2");
    expect(error).toContain("e2 not found");
    expect(error).toContain("possibly stale");
    expect(error).not.toContain("Did you mean");
  });

  it("returns stale-refs message when suggestion is an unnamed container (generic '')", async () => {
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
        name: { type: "computedString", value: "" },
        backendDOMNodeId: 101,
      }),
    ];
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "s1");

    // e99 doesn't exist — closest is e2 (generic '') which is useless
    const error = buildRefNotFoundError("e99");
    expect(error).toContain("e99 not found");
    expect(error).toContain("possibly stale");
    expect(error).not.toContain("Did you mean");
  });

  it("returns 'Did you mean' when suggestion is a meaningful element", async () => {
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
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "Home" },
        backendDOMNodeId: 101,
      }),
    ];
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "s1");

    const error = buildRefNotFoundError("e99");
    expect(error).toContain("e99 not found");
    expect(error).toContain("Did you mean e2 (link 'Home')");
    expect(error).not.toContain("stale");
  });
});

// --- Selector Cache Integration (Story 7.5) ---

describe("Selector Cache Integration", () => {
  beforeEach(() => {
    a11yTree.reset();
    selectorCache.invalidate();
  });

  it("Cache-Hit: resolveElement() uses cached backendNodeId (no resolveRef call)", async () => {
    // Set up refs via getTree
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
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "main-session");

    // Set up cache with valid fingerprint
    const fp = selectorCache.computeFingerprint("https://example.com", a11yTree.refCount);
    selectorCache.updateFingerprint(fp);
    selectorCache.set("e2", 101, "main-session");

    // Spy on resolveRef to verify it's NOT called for cache hits
    const resolveRefSpy = vi.spyOn(a11yTree, "resolveRef");

    const cdp = mockCdpClient();
    const result = await resolveElement(cdp, "main-session", { ref: "e2" });

    expect(result.backendNodeId).toBe(101);
    expect(result.objectId).toBe("obj-1");
    expect(result.resolvedVia).toBe("ref");
    expect(resolveRefSpy).not.toHaveBeenCalled();

    resolveRefSpy.mockRestore();
  });

  it("Cache-Hit: DOM.resolveNode error invalidates cache and falls back to normal path", async () => {
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
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "main-session");

    // Set up cache
    const fp = selectorCache.computeFingerprint("https://example.com", a11yTree.refCount);
    selectorCache.updateFingerprint(fp);
    selectorCache.set("e2", 101, "main-session");

    // First call to DOM.resolveNode fails (stale cache), second succeeds (normal path)
    let callCount = 0;
    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "DOM.resolveNode") {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error("No node with given id found"));
          }
          return Promise.resolve({ object: { objectId: "obj-fallback" } });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await resolveElement(cdp, "main-session", { ref: "e2" });

    // Should have fallen back to normal path
    expect(result.objectId).toBe("obj-fallback");
    // H1 fix: After invalidation, the normal path re-caches the entry
    // with an on-the-fly fingerprint, so cache size is 1 (not 0)
    expect(selectorCache.getStats().size).toBe(1);
  });

  it("Cache-Miss: resolveElement() caches result after successful resolution", async () => {
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
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "main-session");

    // Set fingerprint but don't populate cache
    const fp = selectorCache.computeFingerprint("https://example.com", a11yTree.refCount);
    selectorCache.updateFingerprint(fp);

    const cdp = mockCdpClient();
    await resolveElement(cdp, "main-session", { ref: "e2" });

    // Cache should now have the entry
    const cached = selectorCache.get("e2");
    expect(cached).toBeDefined();
    expect(cached!.backendNodeId).toBe(101);
  });

  it("CSS path: is not cached", async () => {
    const fp = selectorCache.computeFingerprint("https://example.com", 10);
    selectorCache.updateFingerprint(fp);

    const cdp = mockCdpClient(
      { object: { objectId: "obj-css" } },
      {
        "DOM.getDocument": { root: { nodeId: 1 } },
        "DOM.querySelector": { nodeId: 10 },
        "DOM.describeNode": { node: { backendNodeId: 42 } },
      },
    );

    await resolveElement(cdp, "main-session", { selector: "#btn" });

    // Cache should be empty — CSS path is not cached
    expect(selectorCache.getStats().size).toBe(0);
  });

  // --- H1 fix: on-the-fly fingerprint when none is active ---

  it("H1: first resolution after navigation caches with on-the-fly fingerprint", async () => {
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
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "main-session");

    // NO fingerprint set — simulates fresh state after navigation
    // (DomWatcher has not yet completed debounced refresh)
    expect(selectorCache.getStats().fingerprint).toBe("");

    const cdp = mockCdpClient();
    await resolveElement(cdp, "main-session", { ref: "e2" });

    // Cache should have the entry with an on-the-fly fingerprint
    expect(selectorCache.getStats().size).toBe(1);
    expect(selectorCache.getStats().fingerprint).not.toBe("");
    const cached = selectorCache.get("e2");
    expect(cached).toBeDefined();
    expect(cached!.backendNodeId).toBe(101);
  });

  // --- M1 fix: session mismatch invalidates cache hit ---

  it("BUG-016: cache hit with stale session falls through to fresh refMap lookup", async () => {
    // The tree is built under main-session. refMap therefore owns the
    // node under main-session. If a cache entry accidentally claims an
    // unrelated session, resolveElement must fall through and use the
    // refMap owner — this prevents silent-wrong session routing.
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
    const treeCdp = mockCdpForTree(nodes);
    await a11yTree.getTree(treeCdp, "main-session");

    // Plant a cache entry with a stale session.
    const fp = selectorCache.computeFingerprint("https://example.com", a11yTree.refCount);
    selectorCache.updateFingerprint(fp);
    selectorCache.set("e2", 101, "old-session");

    const cdp = mockCdpClient();
    const sessionManager = {
      getSessionForNode: vi.fn().mockReturnValue("main-session"),
    } as unknown as SessionManager;

    const result = await resolveElement(cdp, "main-session", { ref: "e2" }, sessionManager);

    // Falls through cache, hits refMap, routes to the owner session
    // (main-session) — NOT the stale "old-session" in the cache.
    expect(result.resolvedSessionId).toBe("main-session");
    expect(result.backendNodeId).toBe(101);
    // The fresh cache entry should be updated with the correct session.
    const cached = selectorCache.get("e2");
    expect(cached).toBeDefined();
    expect(cached!.sessionId).toBe("main-session");
  });
});
