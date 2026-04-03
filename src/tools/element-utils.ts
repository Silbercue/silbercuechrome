import type { CdpClient } from "../cdp/cdp-client.js";
import { a11yTree, RefNotFoundError } from "../cache/a11y-tree.js";

// --- Public Types ---

export interface ResolvedElement {
  backendNodeId: number;
  objectId: string;
  role: string;
  name: string;
  resolvedVia: "ref" | "css";
}

export interface ElementTarget {
  ref?: string;
  selector?: string;
}

// --- Element Resolution ---

/**
 * Resolve an element target (ref or CSS selector) to a ResolvedElement.
 * When both ref and selector are given, ref takes priority.
 * Throws RefNotFoundError when a ref cannot be resolved.
 */
export async function resolveElement(
  cdpClient: CdpClient,
  sessionId: string,
  target: ElementTarget,
): Promise<ResolvedElement> {
  // Ref path (preferred)
  if (target.ref) {
    const backendNodeId = a11yTree.resolveRef(target.ref);
    if (backendNodeId === undefined) {
      throw new RefNotFoundError(`Element ${target.ref} not found.`);
    }
    // Get objectId via DOM.resolveNode — may fail for stale refs (node removed from DOM)
    let resolved: { object: { objectId: string } };
    try {
      resolved = await cdpClient.send<{ object: { objectId: string } }>(
        "DOM.resolveNode",
        { backendNodeId },
        sessionId,
      );
    } catch {
      throw new RefNotFoundError(
        `Element ${target.ref} not found (stale ref — node no longer in DOM).`,
      );
    }
    // Get role/name directly from nodeInfoMap via backendNodeId
    const info = a11yTree.getNodeInfo(backendNodeId);
    return {
      backendNodeId,
      objectId: resolved.object.objectId,
      role: info?.role ?? "",
      name: info?.name ?? "",
      resolvedVia: "ref",
    };
  }

  // CSS path
  const doc = await cdpClient.send<{ root: { nodeId: number } }>(
    "DOM.getDocument",
    { depth: 0 },
    sessionId,
  );
  const queryResult = await cdpClient.send<{ nodeId: number }>(
    "DOM.querySelector",
    { nodeId: doc.root.nodeId, selector: target.selector! },
    sessionId,
  );
  if (queryResult.nodeId === 0) {
    throw new Error(`Element not found for selector '${target.selector}'`);
  }
  const desc = await cdpClient.send<{ node: { backendNodeId: number } }>(
    "DOM.describeNode",
    { nodeId: queryResult.nodeId },
    sessionId,
  );
  // Get objectId
  const resolved = await cdpClient.send<{ object: { objectId: string } }>(
    "DOM.resolveNode",
    { backendNodeId: desc.node.backendNodeId },
    sessionId,
  );
  return {
    backendNodeId: desc.node.backendNodeId,
    objectId: resolved.object.objectId,
    role: "",    // role not reliably available via CSS path
    name: "",    // name not reliably available via CSS path
    resolvedVia: "css",
  };
}

// --- Contextual Error Messages ---

/**
 * Build a contextual "did you mean?" error message for a missing ref.
 * When roleFilter is provided, only suggests elements matching those roles.
 */
export function buildRefNotFoundError(
  ref: string,
  roleFilter?: Set<string>,
): string {
  const suggestion = a11yTree.findClosestRef(ref, roleFilter);
  let errorText = `Element ${ref} not found.`;
  if (suggestion) {
    errorText += ` Did you mean ${suggestion.ref} (${suggestion.role} '${suggestion.name}')?`;
  }
  return errorText;
}

export { RefNotFoundError } from "../cache/a11y-tree.js";
