import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { a11yTree } from "../cache/a11y-tree.js";
import type { AXNode } from "../cache/a11y-tree.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";

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

  it("routes to OOPIF session via sessionManager", async () => {
    // Set up refs
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
    await a11yTree.getTree(treeCdp, "main-session");

    const cdp = mockCdpClient();
    const sessionManager = {
      getSessionForNode: vi.fn().mockReturnValue("oopif-session-1"),
    } as unknown as SessionManager;

    const result = await resolveElement(cdp, "main-session", { ref: "e2" }, sessionManager);

    expect(sessionManager.getSessionForNode).toHaveBeenCalledWith(201);
    expect(result.resolvedSessionId).toBe("oopif-session-1");
    // DOM.resolveNode should have been called on the OOPIF session
    expect(cdp.send).toHaveBeenCalledWith(
      "DOM.resolveNode",
      { backendNodeId: 201 },
      "oopif-session-1",
    );
  });

  it("falls back to main session when sessionManager returns main", async () => {
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
    const sessionManager = {
      getSessionForNode: vi.fn().mockReturnValue("main-session"),
    } as unknown as SessionManager;

    const result = await resolveElement(cdp, "main-session", { ref: "e2" }, sessionManager);

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

  it("returns plain error message when no refs exist", () => {
    const error = buildRefNotFoundError("e1");
    expect(error).toContain("e1 not found");
    expect(error).not.toContain("Did you mean");
  });
});
