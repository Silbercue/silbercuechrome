import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager, SessionInfo } from "../cdp/session-manager.js";
import { wrapCdpError } from "../tools/error-utils.js";

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
  filter?: "interactive" | "all" | "landmark";
}

export interface TreeResult {
  text: string;
  refCount: number;
  depth: number;
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

  reset(): void {
    this.refMap.clear();
    this.reverseMap.clear();
    this.nodeInfoMap.clear();
    this.sessionNodeMap.clear();
    this.nextRef = 1;
    this.lastUrl = "";
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
    }

    // Fetch A11y tree from CDP — main frame
    const result = await cdpClient.send<{ nodes: AXNode[] }>(
      "Accessibility.getFullAXTree",
      { depth },
      sessionId,
    );
    const nodes = result.nodes;

    if (!nodes || nodes.length === 0) {
      return { text: this.formatHeader("", 0, filter, depth), refCount: 0, depth };
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
      return this.getSubtree(options.ref, combinedNodeMap, allNodes, filter, depth);
    }

    // Get page title from root node
    const pageTitle = this.getPageTitle(nodes);

    // Build tree text from root (main frame)
    const root = nodes[0];
    const lines: string[] = [];
    this.renderNode(root, nodeMap, 0, filter, lines);

    // Append OOPIF sections
    for (const section of oopifSections) {
      const oopifNodeMap = new Map<string, AXNode>();
      for (const node of section.nodes) {
        oopifNodeMap.set(node.nodeId, node);
      }
      lines.push(`--- iframe: ${section.url} ---`);
      if (section.nodes.length > 0) {
        this.renderNode(section.nodes[0], oopifNodeMap, 0, filter, lines);
      }
    }

    // H5: Count only actual element lines, not separator lines (--- iframe: ... ---)
    const refCount = lines.filter((l) => !l.startsWith("--- ")).length;
    const text = this.formatHeader(pageTitle, refCount, filter, depth)
      + (lines.length > 0 ? "\n\n" + lines.join("\n") : "");

    return { text, refCount, depth };
  }

  private getSubtree(
    ref: string,
    nodeMap: Map<string, AXNode>,
    nodes: AXNode[],
    filter: string,
    depth: number,
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
    this.renderNode(targetNode, nodeMap, 0, filter, lines);

    const refCount = lines.length;
    const text = `Subtree for ${ref} — ${refCount} elements\n\n` + lines.join("\n");

    return { text, refCount, depth };
  }

  private renderNode(
    node: AXNode,
    nodeMap: Map<string, AXNode>,
    indentLevel: number,
    filter: string,
    lines: string[],
  ): void {
    if (node.ignored) {
      // Ignored nodes: skip but process children at same indent level
      this.renderChildren(node, nodeMap, indentLevel, filter, lines);
      return;
    }

    const role = this.getRole(node);
    const passesFilter = this.passesFilter(node, role, filter);

    if (passesFilter && node.backendDOMNodeId !== undefined) {
      const refNum = this.refMap.get(node.backendDOMNodeId);
      if (refNum !== undefined) {
        const indent = "  ".repeat(indentLevel);
        const line = this.formatLine(indent, refNum, role, node);
        lines.push(line);
      }
    }

    // Always render children (even if this node didn't pass filter)
    const nextIndent = passesFilter ? indentLevel + 1 : indentLevel;
    this.renderChildren(node, nodeMap, nextIndent, filter, lines);
  }

  private renderChildren(
    node: AXNode,
    nodeMap: Map<string, AXNode>,
    indentLevel: number,
    filter: string,
    lines: string[],
  ): void {
    if (!node.childIds) return;
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (child) {
        this.renderNode(child, nodeMap, indentLevel, filter, lines);
      }
    }
  }

  private getRole(node: AXNode): string {
    return (node.role?.value as string) ?? "";
  }

  private passesFilter(node: AXNode, role: string, filter: string): boolean {
    if (filter === "all") return true;
    if (filter === "landmark") return LANDMARK_ROLES.has(role);
    // interactive filter
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
