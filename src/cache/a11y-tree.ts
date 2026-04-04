import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager, SessionInfo } from "../cdp/session-manager.js";
import { wrapCdpError } from "../tools/error-utils.js";
import { CLICKABLE_TAGS, CLICKABLE_ROLES, COMPUTED_STYLES } from "../tools/visual-constants.js";
import { EMULATED_WIDTH, EMULATED_HEIGHT } from "../cdp/emulation.js";
import { debug } from "../cdp/debug.js";

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
}

export interface TreeResult {
  text: string;
  refCount: number;
  depth: number;
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

/** Conservative token estimation: ~4 chars per token for structured A11y output */
function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
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

// --- A11yTreeProcessor ---

export interface ClosestRefSuggestion {
  ref: string;        // e.g. "e5"
  role: string;       // e.g. "button"
  name: string;       // e.g. "Absenden"
}

export class A11yTreeProcessor {
  private refMap = new Map<number, number>(); // backendDOMNodeId → refNumber
  private reverseMap = new Map<number, number>(); // refNumber → backendDOMNodeId
  private nodeInfoMap = new Map<number, { role: string; name: string }>(); // backendDOMNodeId → { role, name }
  private sessionNodeMap = new Map<string, Set<number>>(); // sessionId → Set<backendDOMNodeId>
  private nextRef = 1;
  private lastUrl = "";

  // Precomputed cache state (Story 7.4)
  private _precomputedNodes: AXNode[] | null = null;
  private _precomputedUrl = "";
  private _precomputedSessionId = "";
  private _precomputedDepth = 3;

  reset(): void {
    this.refMap.clear();
    this.reverseMap.clear();
    this.nodeInfoMap.clear();
    this.sessionNodeMap.clear();
    this.nextRef = 1;
    this.lastUrl = "";
    this.invalidatePrecomputed();
  }

  /** Invalidiert den Precomputed-Cache (z.B. nach Navigation oder Reconnect) */
  invalidatePrecomputed(): void {
    this._precomputedNodes = null;
    this._precomputedUrl = "";
    this._precomputedSessionId = "";
    this._precomputedDepth = 3;
  }

  /** Hintergrund-Refresh: Laedt A11y-Tree und speichert als Cache */
  async refreshPrecomputed(
    cdpClient: CdpClient,
    sessionId: string,
    sessionManager?: SessionManager,
  ): Promise<void> {
    // 1. URL pruefen — wenn sich die URL geaendert hat, reset() aufrufen
    const urlResult = await cdpClient.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression: "document.URL", returnByValue: true },
      sessionId,
    );
    const currentUrl = urlResult.result.value;
    if (currentUrl !== this.lastUrl) {
      this.reset();
      this.lastUrl = currentUrl;
    }

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
      this.nodeInfoMap.set(node.backendDOMNodeId, {
        role: (node.role?.value as string) ?? "",
        name: (node.name?.value as string) ?? "",
      });
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

    debug("A11yTreeProcessor: precomputed cache refreshed, %d nodes cached", result.nodes.length);
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

    // Navigation detection — reset refs on URL change
    const urlResult = await cdpClient.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression: "document.URL", returnByValue: true },
      sessionId,
    );
    const currentUrl = urlResult.result.value;
    if (currentUrl !== this.lastUrl) {
      this.refMap.clear();
      this.reverseMap.clear();
      this.nodeInfoMap.clear();
      this.nextRef = 1;
      this.lastUrl = currentUrl;
      this.invalidatePrecomputed();
    }

    // Precomputed cache check — bypass CDP call if cache is valid (Story 7.4)
    // Subtree queries (options.ref) always load fresh — cached tree may not have full depth
    // M1: Depth mismatch → cache miss (cached depth must be >= requested depth)
    let nodes: AXNode[];
    if (
      this._precomputedNodes
      && this._precomputedSessionId === sessionId
      && currentUrl === this._precomputedUrl
      && !options.ref
      && depth <= this._precomputedDepth
    ) {
      nodes = this._precomputedNodes;
      debug("A11yTreeProcessor: precomputed cache hit");
    } else {
      // Fetch A11y tree from CDP — main frame (fallback / cache miss)
      const result = await cdpClient.send<{ nodes: AXNode[] }>(
        "Accessibility.getFullAXTree",
        { depth },
        sessionId,
      );
      nodes = result.nodes;

      // H1: Prime precomputed cache on fallback (AC #5)
      // Only prime if this is a full-tree query (no ref) with valid nodes
      if (!options.ref && nodes && nodes.length > 0) {
        this._precomputedNodes = nodes;
        this._precomputedUrl = currentUrl;
        this._precomputedSessionId = sessionId;
        this._precomputedDepth = depth;
        debug("A11yTreeProcessor: cache primed from fallback, %d nodes", nodes.length);
      }
    }

    if (!nodes || nodes.length === 0) {
      return {
        text: this.formatHeader("", 0, filter, depth),
        refCount: 0,
        depth,
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
      this.nodeInfoMap.set(node.backendDOMNodeId, {
        role: (node.role?.value as string) ?? "",
        name: (node.name?.value as string) ?? "",
      });
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
                { depth },
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

    // Token-Budget Downsampling
    if (options.max_tokens) {
      const currentTokens = estimateTokens(text);
      if (currentTokens > options.max_tokens) {
        const downsampled = this.downsampleTree(
          root, nodeMap, filter, options.max_tokens,
          oopifSections, visualMap,
        );
        const dsHeader = this.formatDownsampledHeader(
          pageTitle, downsampled.refCount, filter, depth,
          currentTokens, downsampled.level,
        );
        // C2: Final budget check — trim body if header+body exceeds budget
        let dsBody = downsampled.lines.join("\n");
        const fullText = dsHeader + (dsBody ? "\n\n" + dsBody : "");
        if (estimateTokens(fullText) > options.max_tokens && dsBody) {
          const headerTokens = estimateTokens(dsHeader + "\n\n");
          const bodyBudget = options.max_tokens - headerTokens;
          const trimmed = this.trimBodyToFit(downsampled.lines, bodyBudget);
          dsBody = trimmed.join("\n");
        }
        const dsText = dsHeader + (dsBody ? "\n\n" + dsBody : "");
        return {
          text: dsText,
          refCount: downsampled.refCount,
          depth,
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
      let line = this.formatLine(indent, refNum, role, node);
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
        let line = this.formatLine(indent, refNum, role, node);
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
        let line = this.formatLine(indent, refNum, role, node);
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
        let line = this.formatLine(indent, refNum, role, node);
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
        let line = this.formatLine(indent, refNum, role, node);
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
        let line = this.formatLine(indent, refNum, role, node);

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
    // Check focusable property
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "focusable" && prop.value.value === true) return true;
      }
    }
    return false;
  }

  private formatLine(indent: string, refNum: number, role: string, node: AXNode): string {
    let line = `${indent}[e${refNum}] ${role}`;

    const name = node.name?.value as string | undefined;
    if (name) {
      line += ` "${name}"`;
    }

    const value = node.value?.value as string | undefined;
    if (value !== undefined && value !== "") {
      line += ` value="${value}"`;
    }

    // URL for links — shorten to path to save tokens
    if (role === "link" && node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "url" && prop.value.value) {
          line += ` → ${shortenUrl(String(prop.value.value))}`;
          break;
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
