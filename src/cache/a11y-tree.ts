import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager, SessionInfo } from "../cdp/session-manager.js";
import { wrapCdpError } from "../tools/error-utils.js";
import { CLICKABLE_TAGS, CLICKABLE_ROLES, COMPUTED_STYLES } from "../tools/visual-constants.js";
import { EMULATED_WIDTH, EMULATED_HEIGHT } from "../cdp/emulation.js";
import { debug } from "../cdp/debug.js";

/** Strip hash fragment from URL for navigation comparison.
 *  Hash-only changes (anchor navigation) should NOT reset refs. */
function stripHash(url: string): string {
  const idx = url.indexOf("#");
  return idx === -1 ? url : url.slice(0, idx);
}

// --- CDP A11y Types ---

interface AXValue {
  type: string;
  value: unknown;
}

interface AXProperty {
  name: string;
  value: AXValue;
}

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  frameId?: string;
}

// --- Public Types ---

export interface TreeOptions {
  depth?: number;
  ref?: string;
  filter?: "interactive" | "all" | "landmark" | "visual";
  max_tokens?: number;
  /** Bypass precomputed cache and fetch fresh data from CDP (fixes stale data after SPA navigation) */
  fresh?: boolean;
}

export interface TreeResult {
  text: string;
  refCount: number;
  depth: number;
  tokenCount: number;
  pageUrl: string;
  hasVisualData?: boolean;
  downsampled?: boolean;
  originalTokens?: number;
  downsampleLevel?: number;
}

// --- Visual Enrichment Types ---

interface VisualInfo {
  bounds: { x: number; y: number; w: number; h: number };
  isClickable: boolean;
  isVisible: boolean;
}

interface SnapshotDocument {
  nodes: {
    backendNodeId: number[];
    nodeName: number[];
  };
  layout: {
    nodeIndex: number[];
    bounds: number[][];
    styles: number[][];
  };
}

interface CaptureSnapshotResponse {
  documents: SnapshotDocument[];
  strings: string[];
}

// --- Constants ---

/** BUG-009: Safety cap to prevent oversized responses that MCP clients truncate silently.
 *  ~200KB chars ≈ 50K tokens. Large enough for normal pages, prevents 855KB+ responses. */
const DEFAULT_MAX_TOKENS = 50_000;

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
]);

// Story 13a.2: Roles included in enriched compact snapshot for LLM orientation
const CONTEXT_ROLES = new Set([
  "heading",
  "alert",
  "status",
]);

// Story 13a.2: Element classification for pre-click ambient context decision
export type ElementClassification = "widget-state" | "clickable" | "disabled" | "static";

// FR-002: DOM-Diff types for post-action change detection
export interface DOMChange {
  type: "added" | "removed" | "changed";
  ref: string;        // e.g. "e42"
  role: string;       // a11y role
  before?: string;    // old text (for "changed")
  after: string;      // new text (for "added" / "changed")
}

export type SnapshotMap = Map<number, string>;  // refNum → "role\0name"

// --- Element Classification for Downsampling (D2Snap) ---

type ElementClass = "interactive" | "content" | "container";

const CONTAINER_ROLES = new Set([
  "generic", "group", "region", "list", "listbox",
  "navigation", "complementary", "main", "banner",
  "contentinfo", "form", "search", "toolbar", "tablist",
  "menu", "menubar", "tree", "grid", "table",
  "rowgroup", "row", "treegrid",
]);

const CONTENT_ROLES = new Set([
  "heading", "paragraph", "text", "StaticText", "img",
  "figure", "blockquote", "code", "listitem", "cell",
  "columnheader", "rowheader", "caption", "definition",
  "term", "note", "math", "status", "log", "marquee",
  "timer", "alert",
]);

function classifyElement(role: string): ElementClass {
  if (INTERACTIVE_ROLES.has(role)) return "interactive";
  if (CONTENT_ROLES.has(role)) return "content";
  return "container"; // Default: everything else is container
}

/** Token estimation for structured A11y output.
 *  Ratio ~3.5 chars/token accounts for short tokens (brackets, refs, keywords).
 *  FR-H8: Tighter ratio ensures max_tokens is a reliable upper bound. */
function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 3.5);
}

const LANDMARK_ROLES = new Set([
  "banner",
  "navigation",
  "main",
  "complementary",
  "contentinfo",
  "search",
  "form",
  "region",
]);

// Story 13a.2: Extract NodeInfo from AXNode including widget-state properties
function extractNodeInfo(node: AXNode): NodeInfo {
  const info: NodeInfo = {
    role: (node.role?.value as string) ?? "",
    name: (node.name?.value as string) ?? "",
  };
  if (node.properties) {
    for (const prop of node.properties) {
      switch (prop.name) {
        case "expanded": info.expanded = prop.value.value as boolean; break;
        case "hasPopup": info.hasPopup = prop.value.value as string; break;
        case "checked": info.checked = prop.value.value as boolean; break;
        case "pressed": info.pressed = prop.value.value as boolean; break;
        case "disabled": info.disabled = prop.value.value as boolean; break;
        case "focusable": info.focusable = prop.value.value as boolean; break;
        case "level": info.level = prop.value.value as number; break;
      }
    }
  }
  return info;
}

// --- A11yTreeProcessor ---

export interface ClosestRefSuggestion {
  ref: string;        // e.g. "e5"
  role: string;       // e.g. "button"
  name: string;       // e.g. "Absenden"
}

// Story 13a.2: Extended node info for pre-click classification and enriched snapshots
interface NodeInfo {
  role: string;
  name: string;
  expanded?: boolean;
  hasPopup?: string;    // e.g. "menu", "dialog", "listbox"
  checked?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  focusable?: boolean;
  level?: number;       // heading level (1-6)
  htmlId?: string;      // FR-004: HTML id attribute for evaluate selectors
  isClickable?: boolean; // FR-005: Has onclick handler (for non-interactive roles like columnheader)
  linkTarget?: string;  // FR-002: target attribute for links (e.g. "_blank")
  isScrollable?: boolean; // FR-001: Container has overflow-y auto/scroll and scrollHeight > clientHeight
}

export class A11yTreeProcessor {
  private refMap = new Map<number, number>(); // backendDOMNodeId → refNumber
  private reverseMap = new Map<number, number>(); // refNumber → backendDOMNodeId
  // Story 13a.2: Extended with widget-state props for pre-click classification
  private nodeInfoMap = new Map<number, NodeInfo>(); // backendDOMNodeId → NodeInfo
  private sessionNodeMap = new Map<string, Set<number>>(); // sessionId → Set<backendDOMNodeId>
  private nextRef = 1;
  private lastUrl = "";

  // Precomputed cache state (Story 7.4)
  private _precomputedNodes: AXNode[] | null = null;
  private _precomputedUrl = "";
  private _precomputedSessionId = "";
  private _precomputedDepth = 3;

  // Story 13.1: Ambient Page Context — cache version counter
  // Increments on every cache change (refresh, reset, invalidation).
  // Registry compares this against _lastSentVersion to decide whether to attach page context.
  private _cacheVersion = 0;

  /** Story 13.1: Current cache version — increments on every state change */
  get cacheVersion(): number {
    return this._cacheVersion;
  }

  reset(): void {
    this.refMap.clear();
    this.reverseMap.clear();
    this.nodeInfoMap.clear();
    this.sessionNodeMap.clear();
    this.nextRef = 1;
    this.lastUrl = "";
    this._cacheVersion++;
    this.invalidatePrecomputed();
  }

  /** Invalidiert den Precomputed-Cache (z.B. nach Navigation oder Reconnect) */
  invalidatePrecomputed(): void {
    this._precomputedNodes = null;
    this._precomputedUrl = "";
    this._precomputedSessionId = "";
    this._precomputedDepth = 3;
    this._cacheVersion++;
  }

  /** Hintergrund-Refresh: Laedt A11y-Tree und speichert als Cache */
  async refreshPrecomputed(
    cdpClient: CdpClient,
    sessionId: string,
    sessionManager?: SessionManager,
  ): Promise<void> {
    // 1. URL pruefen — wenn sich die Basis-URL (ohne Hash) geaendert hat, reset() aufrufen
    //    Hash-only-Aenderungen (z.B. /#step-alpha → /#step-beta) behalten Refs,
    //    da das DOM bei Anchor-Navigation identisch bleibt.
    const urlResult = await cdpClient.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression: "document.URL", returnByValue: true },
      sessionId,
    );
    const currentUrl = urlResult.result.value;
    if (stripHash(currentUrl) !== stripHash(this.lastUrl)) {
      this.reset();
    }
    this.lastUrl = currentUrl;

    // 2. A11y-Tree via CDP laden (same depth as default getTree)
    const result = await cdpClient.send<{ nodes: AXNode[] }>(
      "Accessibility.getFullAXTree",
      { depth: 3 },
      sessionId,
    );
    if (!result.nodes || result.nodes.length === 0) return;

    // 3. Ref-IDs zuweisen (STABIL — bestehende Refs bleiben, neue bekommen neue Nummern)
    for (const node of result.nodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) continue;
      if (!this.refMap.has(node.backendDOMNodeId)) {
        const refNum = this.nextRef++;
        this.refMap.set(node.backendDOMNodeId, refNum);
        this.reverseMap.set(refNum, node.backendDOMNodeId);
      }
      this.nodeInfoMap.set(node.backendDOMNodeId, extractNodeInfo(node));
      if (!this.sessionNodeMap.has(sessionId)) {
        this.sessionNodeMap.set(sessionId, new Set());
      }
      this.sessionNodeMap.get(sessionId)!.add(node.backendDOMNodeId);
      sessionManager?.registerNode(node.backendDOMNodeId, sessionId);
    }

    // 4. Cache speichern
    this._precomputedNodes = result.nodes;
    this._precomputedUrl = currentUrl;
    this._precomputedSessionId = sessionId;
    this._precomputedDepth = 3;
    this._cacheVersion++;

    // 5. Register root node for Accessibility.nodesUpdated tracking (Story 13a.2 fix).
    // getFullAXTree does NOT populate Chrome's nodes_requested_ set, so nodesUpdated
    // never fires. A single getRootAXNode call registers the root — 1 extra CDP call.
    try {
      await cdpClient.send("Accessibility.getRootAXNode", {}, sessionId);
    } catch {
      // Non-critical — nodesUpdated won't work but everything else still does
      debug("A11yTreeProcessor: getRootAXNode failed (nodesUpdated tracking disabled)");
    }

    // 6. FR-004 + FR-005: Enrich nodes with HTML attributes and click listeners
    await this._enrichNodeMetadata(cdpClient, sessionId);

    // Phase 3: FR-001 — detect scrollable containers (1 CDP call total)
    try {
      const scrollResult = await cdpClient.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        {
          expression: `JSON.stringify([...document.querySelectorAll('*')].filter(el => { const s = getComputedStyle(el); return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight; }).map(el => el.id).filter(Boolean))`,
          returnByValue: true,
        },
        sessionId,
      );
      const scrollableIds: string[] = JSON.parse(scrollResult.result.value || "[]");
      for (const id of scrollableIds) {
        for (const [backendNodeId, info] of this.nodeInfoMap) {
          if (info.htmlId === id) {
            info.isScrollable = true;
            break;
          }
        }
      }
    } catch {
      // Non-critical — scrollable annotation is nice-to-have
    }

    debug("A11yTreeProcessor: precomputed cache refreshed, %d nodes cached (v%d)", result.nodes.length, this._cacheVersion);
  }

  /** Prueft ob ein gueltiger Precomputed-Cache vorliegt */
  hasPrecomputed(sessionId: string): boolean {
    return this._precomputedNodes !== null
      && this._precomputedSessionId === sessionId;
  }

  /**
   * H1: Remove all node references for a detached OOPIF session.
   * Called when an OOPIF frame navigates away or is destroyed.
   */
  removeNodesForSession(sessionId: string): void {
    const nodeIds = this.sessionNodeMap.get(sessionId);
    if (!nodeIds) return;

    for (const backendNodeId of nodeIds) {
      const refNum = this.refMap.get(backendNodeId);
      if (refNum !== undefined) {
        this.reverseMap.delete(refNum);
      }
      this.refMap.delete(backendNodeId);
      this.nodeInfoMap.delete(backendNodeId);
    }
    this.sessionNodeMap.delete(sessionId);
  }

  resolveRef(ref: string): number | undefined {
    const match = ref.match(/^e(\d+)$/);
    if (!match) return undefined;
    const refNum = parseInt(match[1], 10);
    return this.reverseMap.get(refNum);
  }

  getNodeInfo(backendNodeId: number): { role: string; name: string } | undefined {
    return this.nodeInfoMap.get(backendNodeId);
  }

  /** Returns true if the ref map has been populated (i.e. getTree was called at least once). */
  hasRefs(): boolean {
    return this.refMap.size > 0;
  }

  /** Number of currently assigned refs (for DOM fingerprinting, Story 7.5) */
  get refCount(): number {
    return this.refMap.size;
  }

  /** Current page URL (for on-the-fly fingerprint computation, Story 7.5 H1 fix) */
  get currentUrl(): string {
    return this.lastUrl;
  }

  getRefForBackendNodeId(backendNodeId: number): string | undefined {
    const refNum = this.refMap.get(backendNodeId);
    return refNum !== undefined ? `e${refNum}` : undefined;
  }

  private async fetchVisualData(
    cdpClient: CdpClient,
    sessionId: string,
  ): Promise<Map<number, VisualInfo>> {
    const snapshot = await cdpClient.send<CaptureSnapshotResponse>(
      "DOMSnapshot.captureSnapshot",
      {
        computedStyles: [...COMPUTED_STYLES],
        includeDOMRects: true,
        includeBlendedBackgroundColors: true,
        includePaintOrder: true,
      },
      sessionId,
    );

    const visualMap = new Map<number, VisualInfo>();

    if (!snapshot.documents || snapshot.documents.length === 0) {
      return visualMap;
    }

    const doc = snapshot.documents[0];
    const strings = snapshot.strings;

    // Build layout index map: nodeIndex → layoutIndex
    const layoutMap = new Map<number, number>();
    for (let li = 0; li < doc.layout.nodeIndex.length; li++) {
      layoutMap.set(doc.layout.nodeIndex[li], li);
    }

    const totalNodes = doc.nodes.backendNodeId.length;

    for (let ni = 0; ni < totalNodes; ni++) {
      const backendNodeId = doc.nodes.backendNodeId[ni];

      // Only process nodes that have a ref (i.e., are in the A11y tree)
      if (!this.refMap.has(backendNodeId)) continue;

      const li = layoutMap.get(ni);

      // No layout → hidden element
      if (li === undefined) {
        visualMap.set(backendNodeId, {
          bounds: { x: 0, y: 0, w: 0, h: 0 },
          isClickable: this.computeIsClickable(ni, backendNodeId, doc, strings),
          isVisible: false,
        });
        continue;
      }

      // Read bounds
      const boundsArr = doc.layout.bounds[li];
      if (!boundsArr || boundsArr.length < 4) continue;

      const [x, y, w, h] = boundsArr;

      // Read computed styles: display, visibility are at indices 0, 1
      const styleProps = doc.layout.styles[li] ?? [];
      const displayVal = this.getSnapshotString(strings, styleProps[0]);
      const visibilityVal = this.getSnapshotString(strings, styleProps[1]);

      // isVisible calculation
      const isVisible =
        displayVal !== "none" &&
        visibilityVal !== "hidden" &&
        w >= 1 && h >= 1 &&
        x + w > 0 && y + h > 0 &&
        x < EMULATED_WIDTH && y < EMULATED_HEIGHT;

      const isClickable = this.computeIsClickable(ni, backendNodeId, doc, strings);

      visualMap.set(backendNodeId, {
        bounds: {
          x: Math.round(x),
          y: Math.round(y),
          w: Math.round(w),
          h: Math.round(h),
        },
        isClickable,
        isVisible,
      });
    }

    return visualMap;
  }

  /**
   * FR-H5: Enrich nodeInfoMap with HTML attributes (IDs, onclick) and event listeners.
   * Phase 1: DOM.describeNode for HTML IDs + inline onclick detection
   * Phase 2: DOMDebugger.getEventListeners for non-interactive nodes (mousedown, click, pointerdown)
   * Called from both refreshPrecomputed() and getTree() so read_page always has full data.
   */
  private async _enrichNodeMetadata(cdpClient: CdpClient, sessionId: string): Promise<void> {
    const POTENTIALLY_CLICKABLE_ROLES = new Set(["columnheader", "rowheader", "cell", "generic", "listitem"]);
    try {
      const interactiveNodes: number[] = [];
      const checkClickNodes: number[] = [];
      for (const [backendNodeId, info] of this.nodeInfoMap) {
        if (INTERACTIVE_ROLES.has(info.role) || CONTEXT_ROLES.has(info.role)) {
          interactiveNodes.push(backendNodeId);
        } else if (POTENTIALLY_CLICKABLE_ROLES.has(info.role)) {
          interactiveNodes.push(backendNodeId);
          checkClickNodes.push(backendNodeId);
        }
      }

      // Phase 1: Batch DOM.describeNode — extract HTML IDs + inline onclick
      if (interactiveNodes.length > 0 && interactiveNodes.length <= 500) {
        await Promise.allSettled(interactiveNodes.map(async (backendNodeId) => {
          try {
            const desc = await cdpClient.send<{ node: { attributes?: string[] } }>(
              "DOM.describeNode", { backendNodeId, depth: 0 }, sessionId,
            );
            const attrs = desc.node?.attributes;
            if (!attrs) return;
            const info = this.nodeInfoMap.get(backendNodeId);
            if (!info) return;
            for (let i = 0; i < attrs.length; i += 2) {
              if (attrs[i] === "id" && attrs[i + 1]) {
                info.htmlId = attrs[i + 1];
              }
              if (attrs[i] === "onclick") {
                info.isClickable = true;
              }
              if (attrs[i] === "target" && attrs[i + 1]) {
                info.linkTarget = attrs[i + 1];
              }
            }
          } catch { /* ignore — text nodes etc. don't support describeNode */ }
        }));
      }

      // Phase 2: DOMDebugger.getEventListeners for non-interactive nodes without onclick attribute.
      // Detects addEventListener, React synthetic events, jQuery — anything that registered a click handler.
      const clickCandidates = checkClickNodes.filter(id => !this.nodeInfoMap.get(id)?.isClickable);
      if (clickCandidates.length > 0 && clickCandidates.length <= 200) {
        await Promise.allSettled(clickCandidates.map(async (backendNodeId) => {
          try {
            const resolved = await cdpClient.send<{ object: { objectId?: string } }>(
              "DOM.resolveNode", { backendNodeId }, sessionId,
            );
            const objectId = resolved.object?.objectId;
            if (!objectId) return;
            const result = await cdpClient.send<{ listeners: Array<{ type: string }> }>(
              "DOMDebugger.getEventListeners", { objectId }, sessionId,
            );
            if (result.listeners?.some(l => l.type === "click" || l.type === "mousedown" || l.type === "pointerdown")) {
              const info = this.nodeInfoMap.get(backendNodeId);
              if (info) info.isClickable = true;
            }
            await cdpClient.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
          } catch { /* ignore — some nodes can't be resolved */ }
        }));
      }
      // Phase 3: FR-H5 — Enrich unnamed clickable generics with innerText.
      // Separate pass with fresh resolveNode to avoid stale objectId issues.
      const unnamedClickables = [...this.nodeInfoMap.entries()]
        .filter(([, info]) => info.isClickable && !info.name && POTENTIALLY_CLICKABLE_ROLES.has(info.role));
      if (unnamedClickables.length > 0 && unnamedClickables.length <= 100) {
        await Promise.allSettled(unnamedClickables.map(async ([backendNodeId, info]) => {
          try {
            const resolved = await cdpClient.send<{ object: { objectId?: string } }>(
              "DOM.resolveNode", { backendNodeId }, sessionId,
            );
            const oid = resolved.object?.objectId;
            if (!oid) return;
            const textResult = await cdpClient.send<{ result: { value?: string } }>(
              "Runtime.callFunctionOn",
              { functionDeclaration: "function(){return(this.innerText||this.textContent||'').slice(0,80)}", objectId: oid, returnByValue: true },
              sessionId,
            );
            if (textResult.result.value) info.name = textResult.result.value;
            await cdpClient.send("Runtime.releaseObject", { objectId: oid }, sessionId).catch(() => {});
          } catch { /* non-critical */ }
        }));
      }
    } catch {
      // Non-critical — IDs and clickability are nice-to-have
    }
  }

  private computeIsClickable(
    nodeIndex: number,
    backendNodeId: number,
    doc: SnapshotDocument,
    strings: string[],
  ): boolean {
    // Tag from DOMSnapshot
    const tag = this.getSnapshotString(strings, doc.nodes.nodeName[nodeIndex]);
    if (CLICKABLE_TAGS.has(tag)) return true;

    // Role from A11y tree nodeInfoMap
    const nodeInfo = this.nodeInfoMap.get(backendNodeId);
    if (nodeInfo && CLICKABLE_ROLES.has(nodeInfo.role)) return true;

    return false;
  }

  private getSnapshotString(strings: string[], index: number): string {
    if (index === undefined || index < 0 || index >= strings.length) return "";
    return strings[index];
  }

  findClosestRef(ref: string, roleFilter?: Set<string>): ClosestRefSuggestion | null {
    const match = ref.match(/^e(\d+)$/);
    if (!match || this.reverseMap.size === 0) return null;
    const requested = parseInt(match[1], 10);

    // Build candidate list, optionally filtered by role
    const candidates: Array<{ refNum: number; backendNodeId: number; role: string; name: string }> = [];
    for (const [refNum, backendNodeId] of this.reverseMap.entries()) {
      const info = this.nodeInfoMap.get(backendNodeId);
      const role = info?.role ?? "";
      if (roleFilter && !roleFilter.has(role)) continue;
      candidates.push({ refNum, backendNodeId, role, name: info?.name ?? "" });
    }

    if (candidates.length === 0) return null;

    let closest = candidates[0];
    let minDist = Math.abs(requested - closest.refNum);
    for (const c of candidates) {
      const dist = Math.abs(requested - c.refNum);
      if (dist < minDist) {
        closest = c;
        minDist = dist;
      }
    }

    return {
      ref: `e${closest.refNum}`,
      role: closest.role,
      name: closest.name,
    };
  }

  async getTree(
    cdpClient: CdpClient,
    sessionId: string,
    options: TreeOptions = {},
    sessionManager?: SessionManager,
  ): Promise<TreeResult> {
    const depth = options.depth ?? 3;
    const filter = options.filter ?? "interactive";

    // FR-002: Separate CDP fetch depth from display depth.
    // Interactive/visual filters need deeper fetch to find elements nested beyond display depth.
    // "all" fetches depth+2 so leaf nodes' text children (StaticText) are always included —
    // without this, elements like <strong> at the depth limit appear empty.
    // "landmark" uses moderate depth.
    const cdpFetchDepth = (filter === "interactive" || filter === "visual")
      ? Math.max(depth, 10)
      : filter === "landmark"
        ? Math.max(depth, 6)
        : depth + 2;

    // Navigation detection — reset refs on real navigation (path change),
    // but preserve refs on hash-only changes (anchor navigation).
    const urlResult = await cdpClient.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression: "document.URL", returnByValue: true },
      sessionId,
    );
    const currentUrl = urlResult.result.value;
    if (stripHash(currentUrl) !== stripHash(this.lastUrl)) {
      this.refMap.clear();
      this.reverseMap.clear();
      this.nodeInfoMap.clear();
      this.nextRef = 1;
      this.invalidatePrecomputed();
    }
    this.lastUrl = currentUrl;

    // Precomputed cache check — bypass CDP call if cache is valid (Story 7.4)
    // Subtree queries (options.ref) always load fresh — cached tree may not have full depth
    // M1: Depth mismatch → cache miss (cached depth must be >= requested depth)
    // Story 13a.2 fix: fresh=true bypasses cache (read_page after SPA navigation)
    let nodes: AXNode[];
    if (
      !options.fresh
      && this._precomputedNodes
      && this._precomputedSessionId === sessionId
      && currentUrl === this._precomputedUrl
      && !options.ref
      && cdpFetchDepth <= this._precomputedDepth
    ) {
      nodes = this._precomputedNodes;
      debug("A11yTreeProcessor: precomputed cache hit");
    } else {
      // Fetch A11y tree from CDP — main frame (fallback / cache miss)
      // FR-002: Use cdpFetchDepth (not display depth) so interactive/visual filters find deeply nested elements
      const result = await cdpClient.send<{ nodes: AXNode[] }>(
        "Accessibility.getFullAXTree",
        { depth: cdpFetchDepth },
        sessionId,
      );
      nodes = result.nodes;

      // H1: Prime precomputed cache on fallback (AC #5)
      // Only prime if this is a full-tree query (no ref) with valid nodes
      if (!options.ref && nodes && nodes.length > 0) {
        this._precomputedNodes = nodes;
        this._precomputedUrl = currentUrl;
        this._precomputedSessionId = sessionId;
        this._precomputedDepth = cdpFetchDepth;
        debug("A11yTreeProcessor: cache primed from fallback, %d nodes", nodes.length);
      }
    }

    if (!nodes || nodes.length === 0) {
      const emptyText = this.formatHeader("", 0, filter, depth);
      return {
        text: emptyText,
        refCount: 0,
        depth,
        tokenCount: estimateTokens(emptyText),
        pageUrl: this.lastUrl,
        ...(filter === "visual" ? { hasVisualData: false } : {}),
      };
    }

    // Build nodeId → AXNode map
    const nodeMap = new Map<string, AXNode>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
    }

    // Assign refs to all non-ignored nodes with backendDOMNodeId (main frame)
    for (const node of nodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) continue;
      if (!this.refMap.has(node.backendDOMNodeId)) {
        const refNum = this.nextRef++;
        this.refMap.set(node.backendDOMNodeId, refNum);
        this.reverseMap.set(refNum, node.backendDOMNodeId);
      }
      // Always update nodeInfoMap with latest role/name
      this.nodeInfoMap.set(node.backendDOMNodeId, extractNodeInfo(node));
      // Track which session owns this node (H1: for cleanup on detach)
      if (!this.sessionNodeMap.has(sessionId)) {
        this.sessionNodeMap.set(sessionId, new Set());
      }
      this.sessionNodeMap.get(sessionId)!.add(node.backendDOMNodeId);
      // Register node with SessionManager for main frame
      sessionManager?.registerNode(node.backendDOMNodeId, sessionId);
    }

    // Fetch OOPIF A11y trees if SessionManager is available
    const oopifSections: Array<{ url: string; nodes: AXNode[]; sessionId: string }> = [];
    if (sessionManager) {
      const sessions = sessionManager.getAllSessions();
      const oopifSessions = sessions.filter((s: SessionInfo) => !s.isMain);

      if (oopifSessions.length > 0) {
        const oopifResults = await Promise.all(
          oopifSessions.map(async (s: SessionInfo) => {
            try {
              const oopifResult = await cdpClient.send<{ nodes: AXNode[] }>(
                "Accessibility.getFullAXTree",
                { depth: cdpFetchDepth },
                s.sessionId,
              );
              return { url: s.url, nodes: oopifResult.nodes ?? [], sessionId: s.sessionId };
            } catch (err) {
              // M1: OOPIF may have been detached between getAllSessions and fetch
              wrapCdpError(err, "A11yTreeProcessor.getTree(OOPIF)");
              return { url: s.url, nodes: [] as AXNode[], sessionId: s.sessionId };
            }
          }),
        );

        for (const oopifResult of oopifResults) {
          if (oopifResult.nodes.length > 0) {
            oopifSections.push(oopifResult);

            // Assign refs and register nodes for OOPIF
            for (const node of oopifResult.nodes) {
              // Add to nodeMap with session-prefixed keys to avoid collisions
              nodeMap.set(`${oopifResult.sessionId}:${node.nodeId}`, node);
              if (node.ignored || node.backendDOMNodeId === undefined) continue;
              if (!this.refMap.has(node.backendDOMNodeId)) {
                const refNum = this.nextRef++;
                this.refMap.set(node.backendDOMNodeId, refNum);
                this.reverseMap.set(refNum, node.backendDOMNodeId);
              }
              this.nodeInfoMap.set(node.backendDOMNodeId, {
                role: (node.role?.value as string) ?? "",
                name: (node.name?.value as string) ?? "",
              });
              // Track which session owns this node (H1: for cleanup on detach)
              if (!this.sessionNodeMap.has(oopifResult.sessionId)) {
                this.sessionNodeMap.set(oopifResult.sessionId, new Set());
              }
              this.sessionNodeMap.get(oopifResult.sessionId)!.add(node.backendDOMNodeId);
              sessionManager.registerNode(node.backendDOMNodeId, oopifResult.sessionId);
            }
          }
        }
      }
    }

    // FR-H5: Enrich nodes with HTML attributes + event listener detection.
    // Runs in getTree() so read_page(filter: "interactive") sees clickable divs/listItems.
    await this._enrichNodeMetadata(cdpClient, sessionId);

    // Fetch visual data only for "visual" filter — zero overhead for other filters
    let visualMap: Map<number, VisualInfo> | undefined;
    let visualDataFailed = false;
    if (filter === "visual") {
      try {
        visualMap = await this.fetchVisualData(cdpClient, sessionId);
      } catch {
        // M1: DOMSnapshot may fail on certain pages — fall back to tree without visual data
        visualMap = undefined;
        visualDataFailed = true;
      }
    }

    // Handle subtree query
    if (options.ref) {
      // For subtree, search across all nodes (main + OOPIF)
      const allNodes = [...nodes];
      for (const section of oopifSections) {
        allNodes.push(...section.nodes);
      }
      // Build a combined nodeMap for subtree
      const combinedNodeMap = new Map<string, AXNode>();
      for (const node of allNodes) {
        combinedNodeMap.set(node.nodeId, node);
      }
      return this.getSubtree(options.ref, combinedNodeMap, allNodes, filter, depth, visualMap, visualDataFailed, options.max_tokens);
    }

    // Get page title from root node
    const pageTitle = this.getPageTitle(nodes);

    // Build tree text from root (main frame)
    const root = nodes[0];
    const lines: string[] = [];
    this.renderNode(root, nodeMap, 0, filter, lines, visualMap);

    // Append OOPIF sections
    for (const section of oopifSections) {
      const oopifNodeMap = new Map<string, AXNode>();
      for (const node of section.nodes) {
        oopifNodeMap.set(node.nodeId, node);
      }
      lines.push(`--- iframe: ${section.url} ---`);
      if (section.nodes.length > 0) {
        this.renderNode(section.nodes[0], oopifNodeMap, 0, filter, lines, visualMap);
      }
    }

    // H5: Count only actual element lines, not separator lines (--- iframe: ... ---)
    const refCount = lines.filter((l) => !l.startsWith("--- ")).length;
    const text = this.formatHeader(pageTitle, refCount, filter, depth)
      + (lines.length > 0 ? "\n\n" + lines.join("\n") : "");

    // Token-Budget Downsampling — explicit max_tokens or BUG-009 safety cap
    const effectiveMaxTokens = options.max_tokens ?? DEFAULT_MAX_TOKENS;
    const currentTokens = estimateTokens(text);
    if (currentTokens > effectiveMaxTokens) {
      const downsampled = this.downsampleTree(
        root, nodeMap, filter, effectiveMaxTokens,
        oopifSections, visualMap,
      );
      const dsHeader = this.formatDownsampledHeader(
        pageTitle, downsampled.refCount, filter, depth,
        currentTokens, downsampled.level,
      );
      // C2: Final budget check — trim body if header+body exceeds budget
      let dsBody = downsampled.lines.join("\n");
      const fullText = dsHeader + (dsBody ? "\n\n" + dsBody : "");
      if (estimateTokens(fullText) > effectiveMaxTokens && dsBody) {
        const headerTokens = estimateTokens(dsHeader + "\n\n");
        const bodyBudget = effectiveMaxTokens - headerTokens;
        const trimmed = this.trimBodyToFit(downsampled.lines, bodyBudget);
        dsBody = trimmed.join("\n");
      }
      const dsText = dsHeader + (dsBody ? "\n\n" + dsBody : "");
      return {
        text: dsText,
        refCount: downsampled.refCount,
        depth,
        tokenCount: estimateTokens(dsText),
        pageUrl: this.lastUrl,
        downsampled: true,
        originalTokens: currentTokens,
        downsampleLevel: downsampled.level,
        ...(filter === "visual" ? { hasVisualData: !visualDataFailed } : {}),
      };
    }

    return {
      text,
      refCount,
      depth,
      tokenCount: currentTokens,
      pageUrl: this.lastUrl,
      ...(filter === "visual" ? { hasVisualData: !visualDataFailed } : {}),
    };
  }

  // --- Downsampling Pipeline (D2Snap) ---

  private downsampleTree(
    root: AXNode,
    nodeMap: Map<string, AXNode>,
    filter: string,
    maxTokens: number,
    oopifSections: Array<{ url: string; nodes: AXNode[]; sessionId: string }>,
    visualMap?: Map<number, VisualInfo>,
  ): { lines: string[]; refCount: number; level: number } {
    // Try levels 0-4 sequentially until budget is met
    for (let level = 0; level <= 4; level++) {
      const lines: string[] = [];
      this.renderNodeDownsampled(root, nodeMap, 0, filter, lines, level, visualMap);

      // Append OOPIF sections
      for (const section of oopifSections) {
        const oopifNodeMap = new Map<string, AXNode>();
        for (const node of section.nodes) {
          oopifNodeMap.set(node.nodeId, node);
        }
        lines.push(`--- iframe: ${section.url} ---`);
        if (section.nodes.length > 0) {
          this.renderNodeDownsampled(section.nodes[0], oopifNodeMap, 0, filter, lines, level, visualMap);
        }
      }

      const refCount = lines.filter((l) => !l.startsWith("--- ")).length;
      // Estimate tokens including a header estimate (~60 chars)
      const estimatedTotal = estimateTokens(lines.join("\n")) + 15;
      if (estimatedTotal <= maxTokens) {
        return { lines, refCount, level };
      }
    }

    // Level 4 still too large → truncate as last resort
    const lines: string[] = [];
    this.renderNodeDownsampled(root, nodeMap, 0, filter, lines, 4, visualMap);

    // Append OOPIF sections
    for (const section of oopifSections) {
      const oopifNodeMap = new Map<string, AXNode>();
      for (const node of section.nodes) {
        oopifNodeMap.set(node.nodeId, node);
      }
      lines.push(`--- iframe: ${section.url} ---`);
      if (section.nodes.length > 0) {
        this.renderNodeDownsampled(section.nodes[0], oopifNodeMap, 0, filter, lines, 4, visualMap);
      }
    }

    return this.truncateToFit(lines, maxTokens);
  }

  private truncateToFit(
    lines: string[],
    maxTokens: number,
  ): { lines: string[]; refCount: number; level: number } {
    // C3: Prioritize interactive elements — collect them first, then fill with content
    const interactiveLines: Array<{ line: string; idx: number }> = [];
    const contentLines: Array<{ line: string; idx: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Lines containing ref IDs (e.g. [e42]) are interactive/important elements
      if (/\[e\d+\]/.test(line)) {
        // Check if it's an interactive element by looking for interactive role keywords
        const roleMatch = line.match(/\[e\d+\]\s+(\S+)/);
        const role = roleMatch ? roleMatch[1] : "";
        if (INTERACTIVE_ROLES.has(role)) {
          interactiveLines.push({ line, idx: i });
        } else {
          contentLines.push({ line, idx: i });
        }
      } else {
        contentLines.push({ line, idx: i });
      }
    }

    // Build result: interactive first, then fill with content
    const result: string[] = [];
    let tokensSoFar = 15; // header estimate
    const addedIndices = new Set<number>();

    // Phase 1: Add all interactive elements (preserve order)
    for (const { line, idx } of interactiveLines) {
      const lineTokens = estimateTokens(line + "\n");
      if (tokensSoFar + lineTokens > maxTokens - 15) break;
      result.push(line);
      addedIndices.add(idx);
      tokensSoFar += lineTokens;
    }

    // Phase 2: Fill remaining budget with content lines (preserve order)
    for (const { line, idx } of contentLines) {
      const lineTokens = estimateTokens(line + "\n");
      if (tokensSoFar + lineTokens > maxTokens - 15) break;
      result.push(line);
      addedIndices.add(idx);
      tokensSoFar += lineTokens;
    }

    // Add truncation marker if lines were omitted
    const omitted = lines.length - addedIndices.size;
    if (omitted > 0) {
      result.push(`... (truncated, ${omitted} elements omitted)`);
    }

    // Re-sort by original index to maintain document order
    const sortedResult = result
      .filter((l) => !l.startsWith("..."))
      .map((l) => {
        // Find original index
        const origIdx = lines.indexOf(l);
        return { line: l, idx: origIdx };
      })
      .sort((a, b) => a.idx - b.idx)
      .map((entry) => entry.line);

    // Append truncation marker at the end
    if (omitted > 0) {
      sortedResult.push(`... (truncated, ${omitted} elements omitted)`);
    }

    const refCount = sortedResult.filter((l) => !l.startsWith("--- ") && !l.startsWith("...")).length;
    return { lines: sortedResult, refCount, level: 4 };
  }

  /** C2: Trim body lines from the end (content first) until budget is met */
  private trimBodyToFit(lines: string[], bodyBudgetTokens: number): string[] {
    if (bodyBudgetTokens <= 0) return [];

    // Separate interactive and content lines
    const interactiveIndices = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const roleMatch = line.match(/\[e\d+\]\s+(\S+)/);
      const role = roleMatch ? roleMatch[1] : "";
      if (INTERACTIVE_ROLES.has(role)) {
        interactiveIndices.add(i);
      }
    }

    // Try removing content lines from the end first
    const result = [...lines];
    while (estimateTokens(result.join("\n")) > bodyBudgetTokens && result.length > 0) {
      // Find last non-interactive line to remove
      let removedContent = false;
      for (let i = result.length - 1; i >= 0; i--) {
        const roleMatch = result[i].match(/\[e\d+\]\s+(\S+)/);
        const role = roleMatch ? roleMatch[1] : "";
        if (!INTERACTIVE_ROLES.has(role)) {
          result.splice(i, 1);
          removedContent = true;
          break;
        }
      }
      // If only interactive lines remain and still over budget, remove from end
      if (!removedContent) {
        result.pop();
      }
    }
    return result;
  }

  private renderNodeDownsampled(
    node: AXNode,
    nodeMap: Map<string, AXNode>,
    indentLevel: number,
    filter: string,
    lines: string[],
    level: number,
    visualMap?: Map<number, VisualInfo>,
  ): void {
    if (node.ignored) {
      this.renderChildrenDownsampled(node, nodeMap, indentLevel, filter, lines, level, visualMap);
      return;
    }

    const role = this.getRole(node);
    const elementClass = classifyElement(role);
    const passesFilter = this.passesFilter(node, role, filter);

    if (!passesFilter) {
      // Not passing filter — skip but process children at same indent
      this.renderChildrenDownsampled(node, nodeMap, indentLevel, filter, lines, level, visualMap);
      return;
    }

    if (node.backendDOMNodeId === undefined) {
      this.renderChildrenDownsampled(node, nodeMap, indentLevel, filter, lines, level, visualMap);
      return;
    }

    const refNum = this.refMap.get(node.backendDOMNodeId);
    if (refNum === undefined) {
      this.renderChildrenDownsampled(node, nodeMap, indentLevel, filter, lines, level, visualMap);
      return;
    }

    const indent = "  ".repeat(indentLevel);

    if (elementClass === "interactive") {
      // Interactive: ALWAYS fully preserved
      let line = this.formatLine(indent, refNum, role, node, nodeMap);
      if (visualMap) {
        const vi = visualMap.get(node.backendDOMNodeId);
        if (vi && vi.bounds.w > 0 && vi.bounds.h > 0) {
          line += ` [${vi.bounds.x},${vi.bounds.y} ${vi.bounds.w}x${vi.bounds.h}]`;
          if (vi.isClickable) line += " click";
          if (vi.isVisible) line += " vis";
        } else {
          line += " [hidden]";
        }
      }
      lines.push(line);
      this.renderChildrenDownsampled(node, nodeMap, indentLevel + 1, filter, lines, level, visualMap);
    } else if (elementClass === "content") {
      if (level < 4) {
        // Content at levels 0-3: unchanged
        let line = this.formatLine(indent, refNum, role, node, nodeMap);
        if (visualMap) {
          const vi = visualMap.get(node.backendDOMNodeId);
          if (vi && vi.bounds.w > 0 && vi.bounds.h > 0) {
            line += ` [${vi.bounds.x},${vi.bounds.y} ${vi.bounds.w}x${vi.bounds.h}]`;
            if (vi.isClickable) line += " click";
            if (vi.isVisible) line += " vis";
          } else {
            line += " [hidden]";
          }
        }
        lines.push(line);
        this.renderChildrenDownsampled(node, nodeMap, indentLevel + 1, filter, lines, level, visualMap);
      } else {
        // Content at level 4: compact Markdown
        const name = (node.name?.value as string) ?? "";
        if (role === "heading") {
          lines.push(`${indent}# ${name} (e${refNum})`);
        } else if (role === "listitem") {
          const truncName = name.length > 100 ? name.slice(0, 97) + "..." : name;
          lines.push(`${indent}- ${truncName} (e${refNum})`);
        } else {
          // paragraph, StaticText, img, etc.
          const truncName = name.length > 100 ? name.slice(0, 97) + "..." : name;
          if (truncName) {
            lines.push(`${indent}${truncName} (e${refNum})`);
          }
        }
        // Still render children for content nodes (they may have interactive children)
        this.renderChildrenDownsampled(node, nodeMap, indentLevel + 1, filter, lines, level, visualMap);
      }
    } else {
      // Container
      if (level === 0) {
        // Level 0: no merging, render normally
        let line = this.formatLine(indent, refNum, role, node, nodeMap);
        if (visualMap) {
          const vi = visualMap.get(node.backendDOMNodeId);
          if (vi && vi.bounds.w > 0 && vi.bounds.h > 0) {
            line += ` [${vi.bounds.x},${vi.bounds.y} ${vi.bounds.w}x${vi.bounds.h}]`;
            if (vi.isClickable) line += " click";
            if (vi.isVisible) line += " vis";
          } else {
            line += " [hidden]";
          }
        }
        lines.push(line);
        this.renderChildrenDownsampled(node, nodeMap, indentLevel + 1, filter, lines, level, visualMap);
      } else if (level === 1) {
        // Level 1: remove empty containers (no children)
        const childCount = this.countVisibleChildren(node, nodeMap);
        if (childCount === 0) {
          // H3: Even if no visible direct children, check for interactive descendants
          if (this.hasInteractiveDescendants(node, nodeMap)) {
            this.renderChildrenDownsampled(node, nodeMap, indentLevel, filter, lines, level, visualMap);
          }
          return;
        }
        let line = this.formatLine(indent, refNum, role, node, nodeMap);
        if (visualMap) {
          const vi = visualMap.get(node.backendDOMNodeId);
          if (vi && vi.bounds.w > 0 && vi.bounds.h > 0) {
            line += ` [${vi.bounds.x},${vi.bounds.y} ${vi.bounds.w}x${vi.bounds.h}]`;
            if (vi.isClickable) line += " click";
            if (vi.isVisible) line += " vis";
          } else {
            line += " [hidden]";
          }
        }
        lines.push(line);
        this.renderChildrenDownsampled(node, nodeMap, indentLevel + 1, filter, lines, level, visualMap);
      } else if (level === 2) {
        // Level 2: single-child containers merged (child takes container's level)
        const children = this.getVisibleChildren(node, nodeMap);
        if (children.length === 0) {
          // H3: Check for interactive descendants before removing
          if (this.hasInteractiveDescendants(node, nodeMap)) {
            this.renderChildrenDownsampled(node, nodeMap, indentLevel, filter, lines, level, visualMap);
          }
          return;
        }
        if (children.length === 1) {
          // Merge: child at container's indent level
          this.renderNodeDownsampled(children[0], nodeMap, indentLevel, filter, lines, level, visualMap);
          return;
        }
        // Multiple children: keep container but render children
        let line = this.formatLine(indent, refNum, role, node, nodeMap);
        if (visualMap) {
          const vi = visualMap.get(node.backendDOMNodeId);
          if (vi && vi.bounds.w > 0 && vi.bounds.h > 0) {
            line += ` [${vi.bounds.x},${vi.bounds.y} ${vi.bounds.w}x${vi.bounds.h}]`;
            if (vi.isClickable) line += " click";
            if (vi.isVisible) line += " vis";
          } else {
            line += " [hidden]";
          }
        }
        lines.push(line);
        this.renderChildrenDownsampled(node, nodeMap, indentLevel + 1, filter, lines, level, visualMap);
      } else {
        // Level 3-4: container chains flattened, containers as one-line summary
        const childCount = this.countDescendantElements(node, nodeMap, filter);
        if (childCount === 0) {
          // H3: Even with 0 filtered descendants, check for interactive ones
          if (this.hasInteractiveDescendants(node, nodeMap)) {
            this.renderChildrenDownsampled(node, nodeMap, indentLevel, filter, lines, level, visualMap);
          }
          return;
        }

        const name = (node.name?.value as string) ?? "";
        const shortRole = this.shortContainerRole(role);
        const nameStr = name ? `: ${name}` : "";
        lines.push(`${indent}[${shortRole}${nameStr}, ${childCount} items]`);

        // Children rendered at indentLevel + 1
        this.renderChildrenDownsampled(node, nodeMap, indentLevel + 1, filter, lines, level, visualMap);
      }
    }
  }

  private renderChildrenDownsampled(
    node: AXNode,
    nodeMap: Map<string, AXNode>,
    indentLevel: number,
    filter: string,
    lines: string[],
    level: number,
    visualMap?: Map<number, VisualInfo>,
  ): void {
    if (!node.childIds) return;
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (child) {
        this.renderNodeDownsampled(child, nodeMap, indentLevel, filter, lines, level, visualMap);
      }
    }
  }

  private countVisibleChildren(node: AXNode, nodeMap: Map<string, AXNode>): number {
    if (!node.childIds) return 0;
    let count = 0;
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (child && !child.ignored) count++;
    }
    return count;
  }

  private getVisibleChildren(node: AXNode, nodeMap: Map<string, AXNode>): AXNode[] {
    if (!node.childIds) return [];
    const children: AXNode[] = [];
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (child && !child.ignored) children.push(child);
    }
    return children;
  }

  private countDescendantElements(
    node: AXNode,
    nodeMap: Map<string, AXNode>,
    filter: string,
  ): number {
    if (!node.childIds) return 0;
    let count = 0;
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (!child || child.ignored) continue;
      const role = this.getRole(child);
      if (this.passesFilter(child, role, filter)) count++;
      count += this.countDescendantElements(child, nodeMap, filter);
    }
    return count;
  }

  /** H3: Check if a node has any interactive descendants (recursive) */
  private hasInteractiveDescendants(node: AXNode, nodeMap: Map<string, AXNode>): boolean {
    if (!node.childIds) return false;
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (!child) continue;
      const role = this.getRole(child);
      if (INTERACTIVE_ROLES.has(role) && !child.ignored) return true;
      if (this.hasInteractiveDescendants(child, nodeMap)) return true;
    }
    return false;
  }

  private shortContainerRole(role: string): string {
    const shortcuts: Record<string, string> = {
      navigation: "nav",
      complementary: "aside",
      contentinfo: "footer",
      banner: "header",
      generic: "div",
      group: "group",
      region: "region",
      form: "form",
      search: "search",
      toolbar: "toolbar",
      tablist: "tabs",
      menu: "menu",
      menubar: "menubar",
      list: "list",
      listbox: "listbox",
      tree: "tree",
      grid: "grid",
      table: "table",
      main: "main",
      rowgroup: "rowgroup",
      row: "row",
      treegrid: "treegrid",
    };
    return shortcuts[role] ?? role;
  }

  private formatDownsampledHeader(
    title: string,
    count: number,
    filter: string,
    depth: number,
    originalTokens: number,
    level: number,
  ): string {
    const titlePart = title ? `Page: ${title}` : "Page";
    return `${titlePart} — ${count} ${filter} elements (depth ${depth}, downsampled L${level} from ~${originalTokens} tokens)`;
  }

  private getSubtree(
    ref: string,
    nodeMap: Map<string, AXNode>,
    nodes: AXNode[],
    filter: string,
    depth: number,
    visualMap?: Map<number, VisualInfo>,
    visualDataFailed = false,
    maxTokens?: number,
  ): TreeResult {
    const backendId = this.resolveRef(ref);
    if (backendId === undefined) {
      const availableRefs = this.getAvailableRefsRange();
      const suggestion = this.suggestClosestRef(ref);
      let errorText = `Element ${ref} not found.`;
      if (availableRefs) errorText += ` Available refs: ${availableRefs}.`;
      if (suggestion) errorText += ` Did you mean ${suggestion}?`;
      throw new RefNotFoundError(errorText);
    }

    // Find the AXNode with this backendDOMNodeId
    const targetNode = nodes.find((n) => n.backendDOMNodeId === backendId);
    if (!targetNode) {
      throw new RefNotFoundError(`Element ${ref} not found in current tree.`);
    }

    const lines: string[] = [];
    this.renderNode(targetNode, nodeMap, 0, filter, lines, visualMap);

    const refCount = lines.length;
    const header = `Subtree for ${ref} — ${refCount} elements`;
    const text = header + "\n\n" + lines.join("\n");

    // H2: Apply downsampling when max_tokens is set and subtree exceeds budget
    if (maxTokens) {
      const currentTokens = estimateTokens(text);
      if (currentTokens > maxTokens) {
        // Downsample the subtree using the same pipeline
        const downsampled = this.downsampleSubtree(
          targetNode, nodeMap, filter, maxTokens, visualMap,
        );
        const dsHeader = `Subtree for ${ref} — ${downsampled.refCount} elements (downsampled L${downsampled.level} from ~${currentTokens} tokens)`;
        // C2: Final budget check on subtree too
        let dsBody = downsampled.lines.join("\n");
        const fullText = dsHeader + (dsBody ? "\n\n" + dsBody : "");
        if (estimateTokens(fullText) > maxTokens && dsBody) {
          const headerTokens = estimateTokens(dsHeader + "\n\n");
          const bodyBudget = maxTokens - headerTokens;
          const trimmed = this.trimBodyToFit(downsampled.lines, bodyBudget);
          dsBody = trimmed.join("\n");
        }
        const dsText = dsHeader + (dsBody ? "\n\n" + dsBody : "");
        return {
          text: dsText,
          refCount: downsampled.refCount,
          depth,
          tokenCount: estimateTokens(dsText),
          pageUrl: this.lastUrl,
          downsampled: true,
          originalTokens: currentTokens,
          downsampleLevel: downsampled.level,
          ...(filter === "visual" ? { hasVisualData: !visualDataFailed } : {}),
        };
      }
    }

    return {
      text,
      refCount,
      depth,
      tokenCount: estimateTokens(text),
      pageUrl: this.lastUrl,
      ...(filter === "visual" ? { hasVisualData: !visualDataFailed } : {}),
    };
  }

  /** H2: Downsample a subtree (same algorithm as downsampleTree but for a single root) */
  private downsampleSubtree(
    root: AXNode,
    nodeMap: Map<string, AXNode>,
    filter: string,
    maxTokens: number,
    visualMap?: Map<number, VisualInfo>,
  ): { lines: string[]; refCount: number; level: number } {
    for (let level = 0; level <= 4; level++) {
      const lines: string[] = [];
      this.renderNodeDownsampled(root, nodeMap, 0, filter, lines, level, visualMap);

      const refCount = lines.filter((l) => !l.startsWith("--- ")).length;
      const estimatedTotal = estimateTokens(lines.join("\n")) + 15;
      if (estimatedTotal <= maxTokens) {
        return { lines, refCount, level };
      }
    }

    // Level 4 still too large — truncate as last resort
    const lines: string[] = [];
    this.renderNodeDownsampled(root, nodeMap, 0, filter, lines, 4, visualMap);
    return this.truncateToFit(lines, maxTokens);
  }

  /** BUG-001: Find the nearest heading sibling before this node in parent's children */
  private findSectionHeading(node: AXNode, nodeMap: Map<string, AXNode>): string | null {
    if (!node.parentId) return null;
    const parent = nodeMap.get(node.parentId);
    if (!parent?.childIds) return null;
    const myIdx = parent.childIds.indexOf(node.nodeId);
    for (let i = myIdx - 1; i >= 0; i--) {
      const sibling = nodeMap.get(parent.childIds[i]);
      if (!sibling) continue;
      const siblingRole = this.getRole(sibling);
      if (siblingRole === "heading") {
        const name = sibling.name?.value as string;
        if (name) return name;
      }
    }
    return null;
  }

  private renderNode(
    node: AXNode,
    nodeMap: Map<string, AXNode>,
    indentLevel: number,
    filter: string,
    lines: string[],
    visualMap?: Map<number, VisualInfo>,
  ): void {
    if (node.ignored) {
      // Ignored nodes: skip but process children at same indent level
      this.renderChildren(node, nodeMap, indentLevel, filter, lines, visualMap);
      return;
    }

    const role = this.getRole(node);
    const passesFilter = this.passesFilter(node, role, filter);

    if (passesFilter && node.backendDOMNodeId !== undefined) {
      const refNum = this.refMap.get(node.backendDOMNodeId);
      if (refNum !== undefined) {
        const indent = "  ".repeat(indentLevel);
        let line = this.formatLine(indent, refNum, role, node, nodeMap);

        // Append visual info if visualMap is provided
        if (visualMap) {
          const vi = visualMap.get(node.backendDOMNodeId);
          if (vi && vi.bounds.w > 0 && vi.bounds.h > 0) {
            line += ` [${vi.bounds.x},${vi.bounds.y} ${vi.bounds.w}x${vi.bounds.h}]`;
            if (vi.isClickable) line += " click";
            if (vi.isVisible) line += " vis";
          } else {
            line += " [hidden]";
          }
        }

        lines.push(line);
      }
    }

    // Always render children (even if this node didn't pass filter)
    const nextIndent = passesFilter ? indentLevel + 1 : indentLevel;
    this.renderChildren(node, nodeMap, nextIndent, filter, lines, visualMap);
  }

  private renderChildren(
    node: AXNode,
    nodeMap: Map<string, AXNode>,
    indentLevel: number,
    filter: string,
    lines: string[],
    visualMap?: Map<number, VisualInfo>,
  ): void {
    if (!node.childIds) return;
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (child) {
        this.renderNode(child, nodeMap, indentLevel, filter, lines, visualMap);
      }
    }
  }

  private getRole(node: AXNode): string {
    return (node.role?.value as string) ?? "";
  }

  private passesFilter(node: AXNode, role: string, filter: string): boolean {
    if (filter === "all") return true;
    if (filter === "landmark") return LANDMARK_ROLES.has(role);
    // interactive and visual filters use the same element selection
    if (INTERACTIVE_ROLES.has(role)) return true;
    // FR-005: Elements with onclick handlers (e.g. sortable table headers)
    if (node.backendDOMNodeId !== undefined) {
      const info = this.nodeInfoMap.get(node.backendDOMNodeId);
      if (info?.isClickable) return true;
    }
    // Check focusable property
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "focusable" && prop.value.value === true) return true;
      }
    }
    return false;
  }

  private formatLine(indent: string, refNum: number, role: string, node: AXNode, nodeMap?: Map<string, AXNode>): string {
    // FR-004: Append HTML id if available
    const backendNodeId = node.backendDOMNodeId;
    const htmlId = backendNodeId !== undefined ? this.nodeInfoMap.get(backendNodeId)?.htmlId : undefined;
    const idSuffix = htmlId ? `#${htmlId}` : "";
    let line = `${indent}[e${refNum}] ${role}${idSuffix}`;

    // FR-H5: Prefer AXNode name, fall back to nodeInfoMap (enriched by Phase 3 for clickable generics)
    const name = (node.name?.value as string | undefined)
      || (backendNodeId !== undefined ? this.nodeInfoMap.get(backendNodeId)?.name : undefined);
    if (name) {
      line += ` "${name}"`;
    }

    const value = node.value?.value as string | undefined;
    if (value !== undefined && value !== "") {
      line += ` value="${value}"`;
    }

    // BUG-001: Annotate tables with nearest heading for disambiguation
    if (role === "table" && nodeMap) {
      const sectionHeading = this.findSectionHeading(node, nodeMap);
      if (sectionHeading) {
        line += ` (section: "${sectionHeading}")`;
      }
    }

    // FR-003: iframe content hint
    if (role === "Iframe") {
      line += " (use evaluate to access iframe content)";
    }

    // URL for links — shorten to path to save tokens
    if (role === "link" && node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "url" && prop.value.value) {
          line += ` → ${shortenUrl(String(prop.value.value))}`;
          break;
        }
      }
      // FR-002: target=_blank annotation
      if (backendNodeId !== undefined) {
        const linkInfo = this.nodeInfoMap.get(backendNodeId);
        if (linkInfo?.linkTarget === "_blank") {
          line += " (opens new tab)";
        }
      }
    }

    // Disabled marker
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "disabled" && prop.value.value === true) {
          line += " (disabled)";
          break;
        }
      }
    }

    // FR-H6: Tab selected state — helps LLM understand which tab panel is visible
    if (role === "tab" && node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "selected" && prop.value.value === true) {
          line += " (selected)";
          break;
        }
      }
    }

    // FR-006: contenteditable annotation
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "editable" && prop.value.value && prop.value.value !== "inherit") {
          line += " (editable)";
          break;
        }
      }
    }

    // FR-001: scrollable container annotation
    if (backendNodeId !== undefined) {
      const scrollInfo = this.nodeInfoMap.get(backendNodeId);
      if (scrollInfo?.isScrollable) {
        line += " (scrollable)";
      }
    }

    return line;
  }

  private formatHeader(title: string, count: number, filter: string, depth: number): string {
    const titlePart = title ? `Page: ${title}` : "Page";
    return `${titlePart} — ${count} ${filter} elements (depth ${depth})`;
  }

  private getPageTitle(nodes: AXNode[]): string {
    // Root node (WebArea) usually has the page title as name
    if (nodes.length > 0) {
      const root = nodes[0];
      if (!root.ignored) {
        const name = root.name?.value as string | undefined;
        if (name) return name;
      }
    }
    return "";
  }

  private getAvailableRefsRange(): string | null {
    if (this.reverseMap.size === 0) return null;
    const refs = [...this.reverseMap.keys()].sort((a, b) => a - b);
    return `e${refs[0]}-e${refs[refs.length - 1]}`;
  }

  private suggestClosestRef(ref: string): string | null {
    const match = ref.match(/^e(\d+)$/);
    if (!match || this.reverseMap.size === 0) return null;
    const requested = parseInt(match[1], 10);
    const refs = [...this.reverseMap.keys()].sort((a, b) => a - b);
    let closest = refs[0];
    let minDist = Math.abs(requested - closest);
    for (const r of refs) {
      const dist = Math.abs(requested - r);
      if (dist < minDist) {
        closest = r;
        minDist = dist;
      }
    }
    return `e${closest}`;
  }

  /**
   * Story 13a.2: Classify a ref for pre-click ambient context decision.
   * Returns classification based on cached AXNode properties (0 CDP calls).
   */
  classifyRef(ref: string): ElementClassification {
    const match = ref.match(/^e?(\d+)$/);
    if (!match) return "static";
    const refNum = parseInt(match[1], 10);
    const backendNodeId = this.reverseMap.get(refNum);
    if (backendNodeId === undefined) return "static";
    const info = this.nodeInfoMap.get(backendNodeId);
    if (!info) return "static";
    if (info.disabled) return "disabled";
    // hasPopup can be "false" (string) — only classify as widget-state for truthy popup types
    if (info.expanded !== undefined
      || (info.hasPopup !== undefined && info.hasPopup !== "false")
      || info.checked !== undefined
      || info.pressed !== undefined) return "widget-state";
    if (INTERACTIVE_ROLES.has(info.role) || info.isClickable) return "clickable";
    return "static";
  }

  /**
   * FR-008: Return a compact list of known interactive elements for error hints.
   * Used when a CSS selector fails to provide the LLM with actionable alternatives.
   * ZERO CDP calls — purely in-memory from cached nodeInfoMap.
   */
  getInteractiveElements(limit = 8): string[] {
    if (this.reverseMap.size === 0) return [];

    const lines: string[] = [];
    const sortedRefs = [...this.reverseMap.entries()].sort((a, b) => a[0] - b[0]);

    for (const [refNum, backendNodeId] of sortedRefs) {
      const info = this.nodeInfoMap.get(backendNodeId);
      if (!info || !(INTERACTIVE_ROLES.has(info.role) || info.isClickable)) continue;
      const name = info.name ? ` '${info.name}'` : "";
      const idSuffix = info.htmlId ? `#${info.htmlId}` : "";
      lines.push(`[e${refNum}] ${info.role}${idSuffix}${name}`);
      if (lines.length >= limit) break;
    }

    return lines;
  }

  /**
   * FR-002: Lightweight snapshot map for DOM-Diff.
   * Returns Map<refNum, "role\0name"> for all nodes with a name.
   * ZERO CDP calls — purely in-memory.
   */
  getSnapshotMap(): SnapshotMap {
    const map: SnapshotMap = new Map();
    for (const [refNum, backendNodeId] of this.reverseMap) {
      const info = this.nodeInfoMap.get(backendNodeId);
      if (!info || (!info.name && !CONTEXT_ROLES.has(info.role) && !INTERACTIVE_ROLES.has(info.role) && !info.isClickable)) continue;
      map.set(refNum, `${info.role}\0${info.name ?? ""}`);
    }
    return map;
  }

  /**
   * FR-002: Compute diff between two snapshot maps.
   * Returns only meaningful changes (role+name), ignoring nodes without names.
   */
  static diffSnapshots(before: SnapshotMap, after: SnapshotMap): DOMChange[] {
    const changes: DOMChange[] = [];

    // Changed or removed
    for (const [refNum, beforeVal] of before) {
      const afterVal = after.get(refNum);
      if (afterVal === undefined) {
        // Node removed
        const [role, name] = beforeVal.split("\0");
        if (name) {  // Only report if it had visible content
          changes.push({ type: "removed", ref: `e${refNum}`, role, after: "", before: name });
        }
      } else if (afterVal !== beforeVal) {
        // Node changed
        const [roleBefore, nameBefore] = beforeVal.split("\0");
        const [roleAfter, nameAfter] = afterVal.split("\0");
        // Only report if the *name* (visible text) actually changed
        if (nameBefore !== nameAfter) {
          changes.push({
            type: "changed",
            ref: `e${refNum}`,
            role: roleAfter || roleBefore,
            before: nameBefore,
            after: nameAfter,
          });
        }
      }
    }

    // Added
    for (const [refNum, afterVal] of after) {
      if (!before.has(refNum)) {
        const [role, name] = afterVal.split("\0");
        if (name) {  // Only report if it has visible content
          changes.push({ type: "added", ref: `e${refNum}`, role, after: name });
        }
      }
    }

    return changes;
  }

  /**
   * FR-002: Format DOM changes as compact context string for LLM.
   * Prioritizes alerts/status, then shows changes near the action, caps at ~30 lines.
   */
  static formatDomDiff(changes: DOMChange[], url?: string): string | null {
    if (changes.length === 0) return null;

    // Sort: alerts/status first, then added, then changed, then removed
    const priority = (c: DOMChange) => {
      if (c.role === "alert" || c.role === "status") return 0;
      if (c.type === "added") return 1;
      if (c.type === "changed") return 2;
      return 3;
    };
    changes.sort((a, b) => priority(a) - priority(b));

    const lines: string[] = [];
    const urlSuffix = url ? ` — ${shortenUrl(url)}` : "";
    lines.push(`--- Action Result (${changes.length} changes)${urlSuffix} ---`);

    const maxLines = 30;
    for (const c of changes.slice(0, maxLines)) {
      const refTag = INTERACTIVE_ROLES.has(c.role) || CONTEXT_ROLES.has(c.role)
        ? `[${c.ref}] ` : "";

      if (c.type === "added") {
        const roleLabel = c.role === "alert" || c.role === "status" ? c.role : c.role;
        lines.push(` NEW    ${refTag}${roleLabel} "${c.after}"`);
      } else if (c.type === "changed") {
        lines.push(` CHANGED ${refTag}${c.role} "${c.before}" → "${c.after}"`);
      } else {
        lines.push(` REMOVED ${refTag}${c.role} "${c.before}"`);
      }
    }

    if (changes.length > maxLines) {
      lines.push(`... (${changes.length - maxLines} more changes)`);
    }

    return lines.join("\n");
  }

  /**
   * Story 13a.2: Enriched compact snapshot with headings, alerts, status
   * plus interactive elements. ZERO CDP calls — purely in-memory.
   */
  getCompactSnapshot(maxTokens = 2000): string | null {
    if (this.reverseMap.size === 0) return null;

    const contextLines: string[] = [];
    const interactiveLines: string[] = [];
    let tokensSoFar = 0;

    const sortedRefs = [...this.reverseMap.entries()].sort((a, b) => a[0] - b[0]);

    for (const [refNum, backendNodeId] of sortedRefs) {
      const info = this.nodeInfoMap.get(backendNodeId);
      if (!info) continue;

      let line: string | null = null;

      // Story 13a.2: Context roles (headings, alerts, status) for orientation
      if (CONTEXT_ROLES.has(info.role)) {
        if (info.role === "heading" && info.name) {
          const lvl = info.level ?? 1;
          line = `[h${lvl}] "${info.name}"`;
        } else if ((info.role === "alert" || info.role === "status") && info.name) {
          line = `[${info.role}] "${info.name}"`;
        }
        if (line) {
          const lineTokens = Math.ceil(line.length / 4);
          if (tokensSoFar + lineTokens <= maxTokens) {
            contextLines.push(line);
            tokensSoFar += lineTokens;
          }
        }
        continue;
      }

      // Interactive elements (existing behavior) + FR-005: onclick-clickable elements
      if (!INTERACTIVE_ROLES.has(info.role) && !info.isClickable) continue;

      const name = info.name ? ` '${info.name}'` : "";
      const idSuffix = info.htmlId ? `#${info.htmlId}` : "";
      line = `[e${refNum}] ${info.role}${idSuffix}${name}`;
      const lineTokens = Math.ceil(line.length / 4);

      if (tokensSoFar + lineTokens > maxTokens) {
        const remaining = sortedRefs.filter(([, id]) => INTERACTIVE_ROLES.has(this.nodeInfoMap.get(id)?.role ?? "")).length - interactiveLines.length;
        interactiveLines.push(`... (${remaining} more)`);
        break;
      }

      interactiveLines.push(line);
      tokensSoFar += lineTokens;
    }

    if (contextLines.length === 0 && interactiveLines.length === 0) return null;

    const url = this.lastUrl ? ` — ${shortenUrl(this.lastUrl)}` : "";
    const parts: string[] = [];
    const counts = interactiveLines.length > 0 ? `${interactiveLines.length} interactive` : `${contextLines.length} context`;
    parts.push(`--- Page Context (${counts})${url} ---`);
    if (contextLines.length > 0) parts.push(...contextLines);
    if (interactiveLines.length > 0) parts.push(...interactiveLines);
    return parts.join("\n");
  }
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return url;
  }
}

export class RefNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefNotFoundError";
  }
}

export const a11yTree = new A11yTreeProcessor();
