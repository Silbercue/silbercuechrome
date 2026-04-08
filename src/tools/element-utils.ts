import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import { a11yTree, RefNotFoundError } from "../cache/a11y-tree.js";
import { selectorCache } from "../cache/selector-cache.js";
import { wrapCdpError } from "./error-utils.js";
import { debug } from "../cdp/debug.js";

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
    // --- Selector-Cache Check (Story 7.5) ---
    const cached = selectorCache.get(target.ref);
    if (cached) {
      // M1 fix: Verify cached sessionId still matches current session
      const currentSessionForNode = sessionManager?.getSessionForNode(cached.backendNodeId) ?? sessionId;
      const sessionMatch = cached.sessionId === currentSessionForNode;
      if (!sessionMatch) {
        debug("SelectorCache: session mismatch for %s (cached=%s, current=%s), treating as miss", target.ref, cached.sessionId, currentSessionForNode);
        // Fall through to normal resolution — session changed
      } else {
        try {
          const resolved = await cdpClient.send<{ object: { objectId: string } }>(
            "DOM.resolveNode",
            { backendNodeId: cached.backendNodeId },
            currentSessionForNode,
          );
          const info = a11yTree.getNodeInfo(cached.backendNodeId);
          debug("SelectorCache: hit for %s (backendNodeId=%d)", target.ref, cached.backendNodeId);
          return {
            backendNodeId: cached.backendNodeId,
            objectId: resolved.object.objectId,
            role: info?.role ?? "",
            name: info?.name ?? "",
            resolvedVia: "ref",
            resolvedSessionId: currentSessionForNode,
          };
        } catch {
          // Stale cache entry — node no longer in DOM. Remove and fall through.
          debug("SelectorCache: stale entry for %s, invalidating", target.ref);
          selectorCache.invalidate();
        }
      }
    }

    // --- Normal Ref Resolution ---
    const backendNodeId = a11yTree.resolveRef(target.ref);
    if (backendNodeId === undefined) {
      throw new RefNotFoundError(`Element ${target.ref} not found.`);
    }
    // Determine the correct session for this node (main or OOPIF)
    const targetSessionId = sessionManager?.getSessionForNode(backendNodeId) ?? sessionId;

    // Safety net: ensure DOM domain is enabled before resolveNode.
    // DOM.getDocument implicitly enables DOM and is idempotent.
    try {
      await cdpClient.send("DOM.getDocument", { depth: 0 }, targetSessionId);
    } catch {
      // Best-effort — resolveNode may still work with backendNodeId
    }

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
      // Distinguish "DOM not enabled" from actual stale refs
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("DOM agent needs to be enabled")) {
        throw new Error(`DOM domain not enabled for session — this is a server bug, not a stale ref. Try calling read_page first or report this issue.`);
      }
      throw new RefNotFoundError(
        `Element ${target.ref} not found (stale ref — node no longer in DOM).`,
      );
    }
    // Get role/name directly from nodeInfoMap via backendNodeId
    const info = a11yTree.getNodeInfo(backendNodeId);

    // Cache the resolved ref for future lookups (Story 7.5)
    // H1 fix: Pass URL + nodeCount so set() can compute on-the-fly fingerprint
    // when no fingerprint is active yet (first resolution after navigation)
    selectorCache.set(target.ref, backendNodeId, targetSessionId, a11yTree.currentUrl, a11yTree.refCount);

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
// Roles that are useless as suggestions when their name is empty (BUG-013)
const CONTAINER_ROLES = new Set(["generic", "group", "none", "Section", "div"]);

export function buildRefNotFoundError(
  ref: string,
  roleFilter?: Set<string>,
): string {
  const suggestion = a11yTree.findClosestRef(ref, roleFilter);

  // FR-004 + BUG-013: Detect stale / useless suggestions.
  // — no suggestion at all
  // — suggestion ref equals the requested ref (safety-net)
  // — suggestion is an unnamed container (e.g. generic '') — not actionable
  const isUseless =
    !suggestion ||
    suggestion.ref === ref ||
    (!suggestion.name && CONTAINER_ROLES.has(suggestion.role));

  if (isUseless) {
    return `Element ${ref} not found — refs may be stale after page navigation or DOM changes. Use read_page to get fresh refs, or use a CSS selector instead.`;
  }

  return `Element ${ref} not found. Did you mean ${suggestion.ref} (${suggestion.role} '${suggestion.name}')?`;
}

export { RefNotFoundError } from "../cache/a11y-tree.js";
