import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { a11yTree } from "../cache/a11y-tree.js";
import { wrapCdpError } from "./error-utils.js";
import { EMULATED_WIDTH, EMULATED_HEIGHT } from "../cdp/emulation.js";
import { CLICKABLE_TAGS, CLICKABLE_ROLES, COMPUTED_STYLES } from "./visual-constants.js";

// --- Schema ---

export const domSnapshotSchema = z.object({
  ref: z
    .string()
    .optional()
    .describe("Element ref (e.g. 'e42') to get subtree snapshot for"),
});

export type DomSnapshotParams = z.infer<typeof domSnapshotSchema>;

// --- CDP Response Types ---

interface SnapshotDocument {
  documentURL: number;
  nodes: {
    parentIndex: number[];
    nodeType: number[];
    nodeName: number[];
    nodeValue: number[];
    backendNodeId: number[];
    attributes: number[][];
  };
  layout: {
    nodeIndex: number[];
    bounds: number[][];
    text: number[];
    styles: number[][];
    paintOrders: number[];
    offsetRects: number[][];
    clientRects: number[][];
    blendedBackgroundColors: number[];
  };
}

interface CaptureSnapshotResponse {
  documents: SnapshotDocument[];
  strings: string[];
}

// --- Constants ---

const INTERACTIVE_TAGS = new Set([
  "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA",
  "IMG", "H1", "H2", "H3", "H4", "H5", "H6", "LABEL",
]);

const INTERACTIVE_ROLES = new Set([
  "button", "link", "checkbox", "tab", "menuitem",
  "radio", "switch", "slider", "option", "treeitem",
  "textbox", "searchbox", "combobox", "spinbutton",
  "menuitemcheckbox", "menuitemradio",
]);

const MAX_ELEMENTS = 150;
const MIN_SIZE = 10;

// --- Pipeline Element ---

interface PipelineElement {
  nodeIndex: number;
  layoutIndex: number;
  tag: string;
  role: string;
  name: string;
  ref: string;
  bounds: { x: number; y: number; w: number; h: number };
  styles: Record<string, string>;
  isClickable: boolean;
  paintOrder: number;
  zIndex: number | null;
}

// --- Helpers ---

function getStringAt(strings: string[], index: number): string {
  if (index < 0 || index >= strings.length) return "";
  return strings[index];
}

function extractRole(attributes: number[], strings: string[]): string {
  // attributes = [nameIdx, valueIdx, nameIdx, valueIdx, ...]
  for (let i = 0; i < attributes.length - 1; i += 2) {
    if (getStringAt(strings, attributes[i]) === "role") {
      return getStringAt(strings, attributes[i + 1]);
    }
  }
  return "";
}

function hasExplicitRole(attributes: number[], strings: string[]): boolean {
  for (let i = 0; i < attributes.length - 1; i += 2) {
    if (getStringAt(strings, attributes[i]) === "role") return true;
  }
  return false;
}

// --- Handler ---

export async function domSnapshotHandler(
  params: DomSnapshotParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();
  const method = "dom_snapshot";

  try {
    // Ensure A11y refs exist — only trigger getTree if it has never been loaded
    if (!a11yTree.hasRefs()) {
      try {
        await a11yTree.getTree(cdpClient, sessionId!, {}, sessionManager);
      } catch {
        // Non-fatal: proceed without refs if a11y tree fetch fails
      }
    }

    // CDP call
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

    if (!snapshot.documents || snapshot.documents.length === 0) {
      const elapsedMs = Math.round(performance.now() - start);
      return {
        content: [{ type: "text", text: "[]" }],
        _meta: { elapsedMs, method, elementCount: 0, filteredFrom: 0 },
      };
    }

    const doc = snapshot.documents[0];
    const strings = snapshot.strings;
    const totalNodes = doc.nodes.backendNodeId.length;

    // Resolve subtree constraint if ref is given
    let subtreeAncestorIndex: number | undefined;
    let subtreeDescendants: Set<number> | undefined;

    if (params.ref) {
      const targetBackendNodeId = a11yTree.resolveRef(params.ref);
      if (targetBackendNodeId === undefined) {
        const elapsedMs = Math.round(performance.now() - start);
        return {
          content: [{ type: "text", text: `Element ${params.ref} not found.` }],
          isError: true,
          _meta: { elapsedMs, method },
        };
      }

      // Find the node index for this backendNodeId
      for (let i = 0; i < doc.nodes.backendNodeId.length; i++) {
        if (doc.nodes.backendNodeId[i] === targetBackendNodeId) {
          subtreeAncestorIndex = i;
          break;
        }
      }

      if (subtreeAncestorIndex === undefined) {
        const elapsedMs = Math.round(performance.now() - start);
        return {
          content: [{ type: "text", text: `Element ${params.ref} not found in DOM snapshot.` }],
          isError: true,
          _meta: { elapsedMs, method },
        };
      }

      // Collect all descendants via parent→children index, then BFS
      const childrenOf = new Map<number, number[]>();
      for (let i = 0; i < doc.nodes.parentIndex.length; i++) {
        const parent = doc.nodes.parentIndex[i];
        if (parent < 0) continue;
        let children = childrenOf.get(parent);
        if (!children) {
          children = [];
          childrenOf.set(parent, children);
        }
        children.push(i);
      }

      subtreeDescendants = new Set<number>();
      const queue = [subtreeAncestorIndex];
      while (queue.length > 0) {
        const idx = queue.pop()!;
        subtreeDescendants.add(idx);
        const kids = childrenOf.get(idx);
        if (kids) {
          for (const kid of kids) queue.push(kid);
        }
      }
    }

    // Build layout index map: nodeIndex → layoutIndex
    const layoutMap = new Map<number, number>();
    for (let li = 0; li < doc.layout.nodeIndex.length; li++) {
      layoutMap.set(doc.layout.nodeIndex[li], li);
    }

    // --- 6-Stage Filter Pipeline ---
    const pipeline: PipelineElement[] = [];

    for (let ni = 0; ni < totalNodes; ni++) {
      // Subtree filter: skip nodes not in subtree
      if (subtreeDescendants && !subtreeDescendants.has(ni)) continue;

      // Stage 1: Simplification — tag whitelist + explicit role
      const tag = getStringAt(strings, doc.nodes.nodeName[ni]);
      const attrs = doc.nodes.attributes[ni] ?? [];
      const role = extractRole(attrs, strings);

      if (!INTERACTIVE_TAGS.has(tag) && !hasExplicitRole(attrs, strings) && !INTERACTIVE_ROLES.has(role)) {
        continue;
      }

      // Must have layout data
      const li = layoutMap.get(ni);
      if (li === undefined) continue;

      // Stage 2: Visibility Filter
      const styleProps = doc.layout.styles[li] ?? [];
      // computedStyles order matches COMPUTED_STYLES: display, visibility, color, bg-color, font-size, position, z-index
      const displayVal = getStringAt(strings, styleProps[0]);
      const visibilityVal = getStringAt(strings, styleProps[1]);

      if (displayVal === "none" || visibilityVal === "hidden") continue;

      // Stage 3: BBox Filter
      const boundsArr = doc.layout.bounds[li];
      if (!boundsArr || boundsArr.length < 4) continue;

      const [x, y, w, h] = boundsArr;
      if (w < 1 || h < 1) continue;
      if (x + w < 0 || y + h < 0 || x > EMULATED_WIDTH || y > EMULATED_HEIGHT) continue;

      // Stage 4: Size Filter (skip for explicitly requested ref subtree root)
      const isSubtreeRoot = subtreeAncestorIndex !== undefined && ni === subtreeAncestorIndex;
      if (!isSubtreeRoot && (w < MIN_SIZE || h < MIN_SIZE)) continue;

      // Stage 5: Ref assignment
      // BUG-016: dom_snapshot runs against the main frame session only;
      // pass sessionId so composite-keyed refMap lookup works.
      const backendNodeId = doc.nodes.backendNodeId[ni];
      const ref = a11yTree.getRefForBackendNodeId(backendNodeId, sessionId);
      if (!ref) continue;

      // Get a11y node info for name
      const nodeInfo = a11yTree.getNodeInfo(backendNodeId);

      // Collect styles
      const colorVal = getStringAt(strings, styleProps[2]);
      const bgColorVal = getStringAt(strings, styleProps[3]);
      const fontSizeVal = getStringAt(strings, styleProps[4]);
      // styleProps[5] = position, styleProps[6] = z-index
      const zIndexVal = getStringAt(strings, styleProps[6]);

      const styles: Record<string, string> = {};
      if (colorVal) styles.color = colorVal;
      if (bgColorVal) styles.bg = bgColorVal;
      if (fontSizeVal) styles.fontSize = fontSizeVal;

      // isClickable heuristic (Task 4)
      const isClickable = CLICKABLE_TAGS.has(tag) || CLICKABLE_ROLES.has(role);

      const paintOrder = doc.layout.paintOrders[li] ?? 0;

      const zIndex = (zIndexVal && zIndexVal !== "auto") ? parseInt(zIndexVal, 10) : null;

      pipeline.push({
        nodeIndex: ni,
        layoutIndex: li,
        tag: tag.toLowerCase(),
        role: role || (nodeInfo?.role ?? ""),
        name: nodeInfo?.name ?? "",
        ref,
        bounds: {
          x: Math.round(x),
          y: Math.round(y),
          w: Math.round(w),
          h: Math.round(h),
        },
        styles,
        isClickable,
        paintOrder,
        zIndex,
      });
    }

    // Stage 6: Token Budget Guard
    let elements = pipeline;
    if (elements.length > MAX_ELEMENTS) {
      // Prioritize interactive elements, then by paintOrder
      elements.sort((a, b) => {
        if (a.isClickable !== b.isClickable) return a.isClickable ? -1 : 1;
        return b.paintOrder - a.paintOrder;
      });
      elements = elements.slice(0, MAX_ELEMENTS);
    }

    // Format compact output
    const output = elements.map((el) => ({
      ref: el.ref,
      tag: el.tag,
      role: el.role,
      name: el.name,
      bounds: el.bounds,
      styles: el.styles,
      isClickable: el.isClickable,
      paintOrder: el.paintOrder,
      zIndex: el.zIndex,
    }));

    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      _meta: {
        elapsedMs,
        method,
        elementCount: output.length,
        filteredFrom: totalNodes,
      },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "dom_snapshot") }],
      isError: true,
      _meta: { elapsedMs, method },
    };
  }
}
