import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import { a11yTree, RefNotFoundError } from "../cache/a11y-tree.js";
import { wrapCdpError } from "./error-utils.js";

// --- Public Types ---

export interface ResolvedElement {
  backendNodeId: number;
  objectId: string;
  role: string;
  name: string;
  resolvedVia: "ref" | "css";
  resolvedSessionId: string;
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
 * When sessionManager is provided, routes to the correct OOPIF session.
 */
export async function resolveElement(
  cdpClient: CdpClient,
  sessionId: string,
  target: ElementTarget,
  sessionManager?: SessionManager,
): Promise<ResolvedElement> {
  // Ref path (preferred)
  if (target.ref) {
    const backendNodeId = a11yTree.resolveRef(target.ref);
    if (backendNodeId === undefined) {
      throw new RefNotFoundError(`Element ${target.ref} not found.`);
    }
    // Determine the correct session for this node (main or OOPIF)
    const targetSessionId = sessionManager?.getSessionForNode(backendNodeId) ?? sessionId;

    // Get objectId via DOM.resolveNode — may fail for stale refs (node removed from DOM)
    let resolved: { object: { objectId: string } };
    try {
      resolved = await cdpClient.send<{ object: { objectId: string } }>(
        "DOM.resolveNode",
        { backendNodeId },
        targetSessionId,
      );
    } catch (err) {
      // M1: Distinguish CDP connection errors from stale refs
      const wrapped = wrapCdpError(err, "resolveElement");
      if (wrapped.startsWith("CDP connection lost")) {
        throw new Error(wrapped);
      }
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
      resolvedSessionId: targetSessionId,
    };
  }

  // CSS path — always main frame (CSS selectors don't work cross-frame)
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
    resolvedSessionId: sessionId,
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
