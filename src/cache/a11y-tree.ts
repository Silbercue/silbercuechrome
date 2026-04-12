import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager, SessionInfo } from "../cdp/session-manager.js";
import { wrapCdpError } from "../tools/error-utils.js";
import { CLICKABLE_TAGS, CLICKABLE_ROLES, COMPUTED_STYLES } from "../tools/visual-constants.js";
import { EMULATED_WIDTH, EMULATED_HEIGHT } from "../cdp/emulation.js";
import { debug } from "../cdp/debug.js";
import { prefetchSlot } from "./prefetch-slot.js";

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
  /** FR-022: Number of content nodes (StaticText, paragraph, cell, etc.) with visible text that were hidden by filter:interactive. */
  hiddenContentCount?: number;
}

// --- Visual Enrichment Types ---

interface VisualInfo {
  bounds: { x: number; y: number; w: number; h: number };
  isClickable: boolean;
  isVisible: boolean;
  /** Story 18.4: marked true by the paint-order occlusion pass if another
   *  clickable element with a higher paintOrder covers this element's centre
   *  point. Occluded nodes are filtered out of read_page output for all
   *  filter modes. */
  occluded: boolean;
  /** Story 18.4: raw paintOrder value from DOMSnapshot.captureSnapshot
   *  (higher = painted later = visually on top). Kept on VisualInfo so tests
   *  and debug tooling can inspect the resolved stacking order without
   *  re-reading the snapshot. */
  paintOrder: number;
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
    /** Story 18.4: optional because older snapshots and test mocks may omit
     *  the field; captureSnapshot emits it when `includePaintOrder: true`
     *  which `fetchVisualData` sets unconditionally. */
    paintOrders?: number[];
  };
}

interface CaptureSnapshotResponse {
  documents: SnapshotDocument[];
  strings: string[];
}

// --- Errors ---

/**
 * Story 18.4 review H1: tagged error thrown by `fetchVisualData` when
 * `DOMSnapshot.captureSnapshot` succeeds but omits the `paintOrders` array.
 * This is a documented Chrome CDP regression mode (see deferred-work.md).
 * The caller (getTree) catches this specifically so the one-time warning
 * (review H2) can differentiate "Chrome doesn't support it" vs "CDP
 * returned a malformed response".
 */
class PaintOrderUnavailableError extends Error {
  readonly reason = "missing-paint-orders" as const;
  constructor(message: string) {
    super(message);
    this.name = "PaintOrderUnavailableError";
  }
}

// --- Constants ---

/** BUG-009: Safety cap to prevent oversized responses that MCP clients truncate silently.
 *  ~200KB chars ≈ 50K tokens. Large enough for normal pages, prevents 855KB+ responses. */
const DEFAULT_MAX_TOKENS = 50_000;

/** FR-026: Interactive-only default token cap.
 *  Large DOMs (100+ interactive elements) produce overwhelming flat lists.
 *  Cap at 2000 tokens and let the LLM drill into collapsed sections. */
const DEFAULT_INTERACTIVE_MAX_TOKENS = 2_000;

/** Story 18.8 — Tool-Steering fixes for two-benchmark-run regressions.
 *
 *  These marker constants solve a recurring LLM-friction pattern: signals
 *  that a human dev would notice at a glance (a trailing `(disabled)` or
 *  `…[+N chars]`) slip past an LLM scanning token-by-token. The LLM either
 *  parses them as normal text or stops reading at the ellipsis. Both runs
 *  T3.6 (truncated task description) and T4.4 (initially-disabled input)
 *  failed for this exact reason — in two independent benchmark sessions.
 *
 *  Fix strategy: promote the hint out of the element line into a separate
 *  high-contrast marker. For truncation that means a new indented line
 *  starting with a `[!]` prefix and a concrete next-action. For disabled
 *  state that means a leading `[DISABLED]` prefix BEFORE the role so the
 *  LLM sees it as the very first token of the element, not an easy-to-miss
 *  suffix.
 */

/** Prefix marker for disabled elements. Sits BEFORE `[e42] textbox …` so
 *  the LLM sees "cannot interact" as the first token of the line rather
 *  than an afterthought appended to the tail. */
const DISABLED_PREFIX = "[DISABLED] ";

/** Prominent marker used when a text-node name was truncated by FR-H5
 *  enrichment (see {@link NodeInfo.nameFullLength}). Rendered as a second
 *  physical line beneath the element, indented and starting with `[!]` so
 *  a scanning LLM cannot mistake it for normal element content. */
const TRUNCATION_MARKER_PREFIX = "[!] TRUNCATED";

// Story 18.4: named indices into the `styles[]` tuple emitted by
// DOMSnapshot.captureSnapshot. Order is locked by visual-constants.ts
// COMPUTED_STYLES. Invariant 5 (no magic numbers) — do NOT inline these
// indices inside fetchVisualData or the occlusion pass.
const STYLE_IDX_DISPLAY = 0;
const STYLE_IDX_VISIBILITY = 1;
const STYLE_IDX_POINTER_EVENTS = 7;

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
  nameFullLength?: number; // FR-021: Full innerText length when name was truncated by FR-H5 enrichment (80-char cap)
}

export class A11yTreeProcessor {
  // BUG-016: refMap is keyed by COMPOSITE `${sessionId}:${backendNodeId}`.
  // Chrome's `backendNodeId` is unique per renderer process, not globally —
  // Out-of-Process iframes (and new tabs) have their own namespace and can
  // collide with the main frame. The composite key makes the mapping
  // collision-free across CDP sessions. `nextRef` stays global so that
  // exposed refs (e1, e2, ...) remain unique across the entire user output.
  private refMap = new Map<string, number>(); // `${sessionId}:${backendNodeId}` → refNumber
  private reverseMap = new Map<number, { backendNodeId: number; sessionId: string }>(); // refNumber → owner
  // Story 13a.2: Extended with widget-state props for pre-click classification
  // BUG-016 follow-up (final codex review CRITICAL #1): nodeInfoMap must
  // also be session-scoped. When main frame and an OOPIF share a
  // backendNodeId, a bare-keyed map lets the second registration
  // overwrite the first element's role/name/widget-state — so
  // `findByText`, `classifyRef`, and `getNodeInfo` silently return the
  // wrong element. Same collision class as the T2.5 bug, just via
  // metadata instead of the ref lookup.
  private nodeInfoMap = new Map<string, NodeInfo>(); // `${sessionId}:${backendDOMNodeId}` → NodeInfo
  private sessionNodeMap = new Map<string, Set<number>>(); // sessionId → Set<backendDOMNodeId>
  private nextRef = 1;
  private lastUrl = "";

  // BUG-016: Set by getTree/downsample* for the duration of a render pass so
  // that deep render helpers (which only carry backendNodeId) can still look
  // up the composite refMap key. Always restored to "" after the pass.
  private _renderSessionId = "";

  // Precomputed cache state (Story 7.4)
  private _precomputedNodes: AXNode[] | null = null;
  private _precomputedUrl = "";
  private _precomputedSessionId = "";
  // BUG-019: Cache was primed with a finite depth (3) which made subsequent
  // `read_page(filter:"all")` calls fall through to the fallback path whenever
  // the requested cdpFetchDepth exceeded 3. Now that all CDP fetches are
  // depth-unlimited, the primed cache is always considered "at least as deep"
  // as any future request (Infinity satisfies every inequality).
  private _precomputedDepth = Infinity;

  // Story 13.1: Ambient Page Context — cache version counter
  // Increments on every cache change (refresh, reset, invalidation).
  // Registry compares this against _lastSentVersion to decide whether to attach page context.
  private _cacheVersion = 0;

  // Story 18.4 review H2: emit the paint-order-unavailable warning at most
  // once per processor instance. Without this guard every read_page call
  // would spam the log with the same line on Chrome builds that silently
  // drop `paintOrders` from DOMSnapshot.
  private _paintOrderWarningEmitted = false;

  // Story 18.4 review M3: cache the most recent visual/occlusion result so
  // rapid-fire read_page calls against the same AX-tree version don't
  // re-run DOMSnapshot.captureSnapshot. Keyed by { cacheVersion, sessionId,
  // filter } — filter is part of the key because the occlusion pass
  // pre-filters its target set per filter mode (review M4). Invalidated
  // whenever the A11y cache version increments (reset, navigate, refresh).
  private _lastVisualCache: {
    cacheVersion: number;
    sessionId: string;
    filter: string;
    visualMap: Map<number, VisualInfo> | undefined;
    visualDataFailed: boolean;
  } | null = null;

  // FR-022 (P3 fix): Refs that were observed in the most recent
  // refreshPrecomputed() pass — i.e. the refs that still point at a node
  // present in the live AX tree right after the refresh. Used by the
  // default `onToolResult` hook to detect REMOVED nodes (refs whose owner
  // backendNodeId disappeared between two refreshes). reverseMap itself
  // never evicts old refs by design (so the LLM can keep stale refs around
  // long enough to react to them), so the diff logic needs an independent
  // signal to know which refs are still live.
  private _activeRefsAfterRefresh: Set<number> = new Set();

  /** Story 13.1: Current cache version — increments on every state change */
  get cacheVersion(): number {
    return this._cacheVersion;
  }

  reset(): void {
    // Story 18.5: Cancel any in-flight speculative prefetch BEFORE clearing
    // the maps. If the prefetch finished after we cleared but before we
    // cancelled, its writes would land in the freshly-emptied state with
    // stale ref numbers (Race 3 in the Story-18.5 race-condition catalogue).
    //
    // Important: only the EXTERNAL `reset()` cancels the slot. The slot's
    // own build re-uses `_resetState()` directly (without the cancel) when
    // it discovers a URL change inside refreshPrecomputed — otherwise the
    // build would self-abort and never write its result. See Story 18.5
    // race-condition note "self-cancel during URL-change reset".
    prefetchSlot.cancel();
    this._resetState();
  }

  /**
   * Story 18.5: Internal map-clearing helper used by `reset()` and by
   * `refreshPrecomputed` when it detects a URL change mid-build. Does NOT
   * touch the prefetch slot — calling `prefetchSlot.cancel()` from inside
   * the slot's own build would self-abort the in-flight build before its
   * cache write, defeating the entire prefetch.
   */
  private _resetState(): void {
    this.refMap.clear();
    this.reverseMap.clear();
    this.nodeInfoMap.clear();
    this.sessionNodeMap.clear();
    this._activeRefsAfterRefresh = new Set();
    this.nextRef = 1;
    this.lastUrl = "";
    this._renderSessionId = "";
    this._lastVisualCache = null; // Story 18.4 M3
    this._paintOrderWarningEmitted = false; // Story 18.4 H2 — fresh session, re-arm warning
    this._cacheVersion++;
    this.invalidatePrecomputed();
  }

  /**
   * FR-022 (P3 fix): Snapshot of refs that were observed in the most recent
   * `refreshPrecomputed()` pass. The default `onToolResult` hook compares
   * the pre-click snapshot map against this set to derive REMOVED nodes
   * for refs whose owning backendNodeId disappeared from the live AX tree.
   *
   * Returns an empty set when no refresh has run yet (or after `reset()`).
   * The returned set is a copy — callers may mutate it freely.
   */
  getActiveRefs(): Set<number> {
    return new Set(this._activeRefsAfterRefresh);
  }

  /**
   * BUG-016: Build a composite key for the refMap from backendNodeId and
   * sessionId. Centralizing this avoids template-string sprawl.
   */
  private refKey(backendNodeId: number, sessionId: string): string {
    return `${sessionId}:${backendNodeId}`;
  }

  /**
   * BUG-016: Look up a refNumber by backendNodeId. Caller preference order:
   *   1. Explicit `sessionId` argument (most precise — collision-free).
   *   2. `_renderSessionId` (set by the active render pass).
   *   3. Linear scan across all sessions — backward-compat fallback for
   *      legacy callers that never knew about sessionId. Returns the FIRST
   *      composite-key match. Not collision-safe under OOPIF duplication,
   *      but keeps existing tests and tools working. Prefer the explicit
   *      form in new code.
   */
  private refLookup(backendNodeId: number, sessionId?: string): number | undefined {
    const sid = sessionId ?? this._renderSessionId;
    if (sid) {
      return this.refMap.get(this.refKey(backendNodeId, sid));
    }
    // Fallback: linear scan. Keys look like `${sessionId}:${backendNodeId}`.
    const suffix = `:${backendNodeId}`;
    for (const [key, refNum] of this.refMap) {
      if (key.endsWith(suffix)) return refNum;
    }
    return undefined;
  }

  /**
   * BUG-016: Existence check against the composite refMap with the same
   * precedence rules as `refLookup`.
   */
  private refExists(backendNodeId: number, sessionId?: string): boolean {
    const sid = sessionId ?? this._renderSessionId;
    if (sid) {
      return this.refMap.has(this.refKey(backendNodeId, sid));
    }
    const suffix = `:${backendNodeId}`;
    for (const key of this.refMap.keys()) {
      if (key.endsWith(suffix)) return true;
    }
    return false;
  }

  /**
   * BUG-016 follow-up: composite-key lookup for nodeInfoMap. Same
   * precedence rules as `refLookup` — explicit sessionId wins, then the
   * active render session, then a linear-scan fallback (first match).
   * The linear scan is only safe in the absence of collisions; prefer
   * passing sessionId (or setting _renderSessionId) at call sites that
   * touch OOPIFs.
   */
  private nodeInfoLookup(backendNodeId: number, sessionId?: string): NodeInfo | undefined {
    const sid = sessionId ?? this._renderSessionId;
    if (sid) {
      return this.nodeInfoMap.get(this.refKey(backendNodeId, sid));
    }
    const suffix = `:${backendNodeId}`;
    for (const [key, info] of this.nodeInfoMap) {
      if (key.endsWith(suffix)) return info;
    }
    return undefined;
  }

  /**
   * BUG-016 follow-up: composite-key write for nodeInfoMap. Callers
   * that build the tree already carry the owning sessionId, so the
   * write is always unambiguous.
   */
  private nodeInfoSet(backendNodeId: number, sessionId: string, info: NodeInfo): void {
    this.nodeInfoMap.set(this.refKey(backendNodeId, sessionId), info);
  }

  /** Invalidiert den Precomputed-Cache (z.B. nach Navigation oder Reconnect) */
  invalidatePrecomputed(): void {
    this._precomputedNodes = null;
    this._precomputedUrl = "";
    this._precomputedSessionId = "";
    this._precomputedDepth = Infinity; // BUG-019: matches constructor default
    // FR-022: invalidating the precomputed cache also drops the
    // most-recent active-refs snapshot — without a fresh refresh there is
    // no authoritative "live tree" left to compare against.
    this._activeRefsAfterRefresh = new Set();
    // Story 18.4 M3: the occlusion cache piggybacks on _cacheVersion, so
    // bumping the version below is sufficient — but drop the reference
    // eagerly so the old map can be GC'd.
    this._lastVisualCache = null;
    this._cacheVersion++;
  }

  /**
   * Hintergrund-Refresh: Laedt A11y-Tree und speichert als Cache.
   *
   * Story 18.5: Optionaler `signal`-Parameter erlaubt es dem Speculative-
   * Prefetch-Pfad, einen laufenden Build von aussen abzubrechen. Wenn der
   * Signal vor einem Cache-Write feuert, wird das Ergebnis verworfen und
   * der Cache bleibt unveraendert. Bestehende Aufrufer (Pro-Repo-Hook,
   * BrowserSession.dom-watcher-callback, Tests) ueberspringen den Parameter
   * und verhalten sich exakt wie vor Story 18.5.
   *
   * URL-Race (Story 18.5 AC-3): Zwischen dem URL-Fetch zu Beginn und dem
   * Cache-Write am Ende kann die Page weiter navigieren. Vor dem Cache-Write
   * wird die URL erneut gegen den Stand vom Anfang verglichen — bei Mismatch
   * werden die frischen Nodes verworfen und der Cache bleibt leer/alt.
   *
   * Story 18.5 L1 fix: Optionaler `expectedUrl`-Parameter aktiviert den
   * PrefetchSlot-seitigen URL-Guard. Wenn gesetzt, prueft `refreshPrecomputed`
   * bereits am Anfang UND nochmal direkt vor dem Cache-Write, ob die aktuelle
   * Page-URL zum Schedule-Zeitpunkt-URL passt. Weicht sie ab (stripped Hash),
   * wird der Build verworfen — die URL hat sich zwischen Schedule und Cache-
   * Write geaendert und der frische Stand gehoert nicht in den Cache des
   * aktuellen Navigationsziels.
   */
  async refreshPrecomputed(
    cdpClient: CdpClient,
    sessionId: string,
    sessionManager?: SessionManager,
    signal?: AbortSignal,
    expectedUrl?: string,
  ): Promise<void> {
    // Story 18.5: Frueher Abort-Check — wenn der Slot bereits abgebrochen
    // wurde, bevor wir ueberhaupt anfangen, sofort exit.
    if (signal?.aborted) return;

    // 1. URL pruefen — wenn sich die Basis-URL (ohne Hash) geaendert hat, reset() aufrufen
    //    Hash-only-Aenderungen (z.B. /#step-alpha → /#step-beta) behalten Refs,
    //    da das DOM bei Anchor-Navigation identisch bleibt.
    const urlResult = await cdpClient.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression: "document.URL", returnByValue: true },
      sessionId,
    );
    if (signal?.aborted) return;
    const startUrl = urlResult.result.value;

    // Story 18.5 L1: Pre-Read-Check — wenn der Slot einen nicht-leeren
    // `expectedUrl` mitgegeben hat (d.h. wir laufen im Prefetch-Pfad UND
    // der Scheduler kannte bereits eine Zielseiten-URL) und die aktuelle
    // Page-URL schon beim Start nicht mehr passt, sofort aufgeben. Der
    // Slot-Trigger dachte, wir pre-fetchen URL X, aber die Page ist
    // bereits auf Y — der Cache-Write wuerde den falschen URL-Stand cachen.
    //
    // Leerer String ("") ist KEIN Mismatch: nach `a11yTree.reset()`
    // (z.B. vom navigate-onToolResult-Hook) ist `currentUrl` leer, und
    // der Registry-Trigger ruft `schedule(..., expectedUrl="")`. In dem
    // Fall haben wir keine Referenz-URL und fallen auf den Start-URL-
    // basierten Re-Check weiter unten zurueck.
    if (
      expectedUrl !== undefined
      && expectedUrl !== ""
      && stripHash(startUrl) !== stripHash(expectedUrl)
    ) {
      debug(
        "A11yTreeProcessor: prefetch expectedUrl mismatch (expected %s, current %s), aborting build",
        expectedUrl,
        startUrl,
      );
      return;
    }
    if (stripHash(startUrl) !== stripHash(this.lastUrl)) {
      // Story 18.5: Use the internal helper instead of `reset()` so the
      // slot's own AbortController is NOT cancelled — see _resetState()
      // doc and the "self-cancel" note in the Story-18.5 race-condition
      // catalogue. The slot's identity-check in PrefetchSlot.schedule()
      // protects a NEXT-scheduled slot from being clobbered, so the
      // missing cancel here is safe.
      this._resetState();
    }
    this.lastUrl = startUrl;

    // 2. A11y-Tree via CDP laden — no depth limit (BUG-019).
    // The precomputed cache previously primed only the top 3 levels, so any
    // subsequent read_page call that fell back to the cache was pre-truncated
    // before the first line of render code ran.
    const result = await cdpClient.send<{ nodes: AXNode[] }>(
      "Accessibility.getFullAXTree",
      {},
      sessionId,
    );
    if (signal?.aborted) return;
    if (!result.nodes || result.nodes.length === 0) return;

    // 3. Ref-IDs zuweisen (STABIL — bestehende Refs bleiben, neue bekommen neue Nummern)
    // BUG-016: composite-key writes — a backendNodeId from a different
    // session never overwrites an existing entry.
    // FR-022: track which refs were observed in this refresh pass so that
    // the default onToolResult hook can detect REMOVED nodes via getActiveRefs().
    const observedRefs = new Set<number>();
    for (const node of result.nodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) continue;
      const key = this.refKey(node.backendDOMNodeId, sessionId);
      let refNum = this.refMap.get(key);
      if (refNum === undefined) {
        refNum = this.nextRef++;
        this.refMap.set(key, refNum);
        this.reverseMap.set(refNum, { backendNodeId: node.backendDOMNodeId, sessionId });
      }
      observedRefs.add(refNum);
      // Composite-keyed write so cross-session nodes with the same
      // backendNodeId do not clobber each other's role/name metadata.
      this.nodeInfoSet(node.backendDOMNodeId, sessionId, extractNodeInfo(node));
      if (!this.sessionNodeMap.has(sessionId)) {
        this.sessionNodeMap.set(sessionId, new Set());
      }
      this.sessionNodeMap.get(sessionId)!.add(node.backendDOMNodeId);
      sessionManager?.registerNode(node.backendDOMNodeId, sessionId);
    }
    this._activeRefsAfterRefresh = observedRefs;

    // Story 18.5: Abort-Check unmittelbar vor dem Cache-Write. Wenn der
    // Slot zwischen getFullAXTree und hier abgebrochen wurde (z.B. durch
    // einen neuen navigate auf URL B), darf der frische Stand NICHT in
    // den Cache geschrieben werden — sonst sieht der naechste read_page
    // die Slot-1-Daten statt der erwarteten Slot-2-Daten.
    if (signal?.aborted) return;

    // Story 18.5 (AC-3): URL-Race-Pruefung. Zwischen dem Start-URL-Fetch
    // (oben) und JETZT kann die Page weiter navigiert sein — z.B. weil ein
    // click() einen Redirect ausgeloest hat oder ein paralleler navigate
    // gefeuert wurde. Vor dem Cache-Write die URL erneut fetchen und mit
    // dem Start-URL vergleichen. Bei Mismatch: alle frischen Nodes
    // verwerfen, Cache bleibt unangetastet, kein Fehler.
    //
    // Story 18.5 L1 fix: Wenn der Slot einen NICHT-leeren expectedUrl
    // mitgegeben hat, wird die Pruefung gegen diesen Stand durchgefuehrt —
    // das ist der stabilere Referenzpunkt, weil er den Zeitpunkt des
    // Schedule-Aufrufs markiert (also VOR dem Start von refreshPrecomputed).
    // Bei leerem expectedUrl (z.B. direkt nach `reset()` im navigate-Hook)
    // fallen wir auf startUrl zurueck, wie vor der L1-Aenderung.
    const recheckResult = await cdpClient.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression: "document.URL", returnByValue: true },
      sessionId,
    );
    if (signal?.aborted) return;
    const recheckUrl = recheckResult.result.value;
    const referenceUrl = (expectedUrl !== undefined && expectedUrl !== "")
      ? expectedUrl
      : startUrl;
    if (stripHash(recheckUrl) !== stripHash(referenceUrl)) {
      debug(
        "A11yTreeProcessor: URL changed during refreshPrecomputed (%s → %s), dropping result",
        referenceUrl,
        recheckUrl,
      );
      return;
    }

    // 4. Cache speichern — BUG-019: primed with Infinity so subsequent
    // cdpFetchDepth <= _precomputedDepth comparisons are always satisfied.
    this._precomputedNodes = result.nodes;
    this._precomputedUrl = startUrl;
    this._precomputedSessionId = sessionId;
    this._precomputedDepth = Infinity;
    this._cacheVersion++;

    // 5. Register root node for Accessibility.nodesUpdated tracking (Story 13a.2 fix).
    // getFullAXTree does NOT populate Chrome's nodes_requested_ set, so nodesUpdated
    // never fires. A single getRootAXNode call registers the root — 1 extra CDP call.
    if (signal?.aborted) return;
    try {
      await cdpClient.send("Accessibility.getRootAXNode", {}, sessionId);
    } catch {
      // Non-critical — nodesUpdated won't work but everything else still does
      debug("A11yTreeProcessor: getRootAXNode failed (nodesUpdated tracking disabled)");
    }

    // 6. FR-004 + FR-005: Enrich nodes with HTML attributes and click listeners
    if (signal?.aborted) return;
    await this._enrichNodeMetadata(cdpClient, sessionId);

    // Phase 3: FR-001 — detect scrollable containers (1 CDP call total)
    if (signal?.aborted) return;
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

    // BUG-016: delete composite-key entries only. Another session's
    // identical backendNodeId is untouched because the key differs.
    // Both refMap and nodeInfoMap are session-scoped now, so the cleanup
    // is straightforward — no need to check "is this node still owned
    // by another session" before deleting metadata.
    for (const backendNodeId of nodeIds) {
      const key = this.refKey(backendNodeId, sessionId);
      const refNum = this.refMap.get(key);
      if (refNum !== undefined) {
        this.reverseMap.delete(refNum);
      }
      this.refMap.delete(key);
      this.nodeInfoMap.delete(key);
    }
    this.sessionNodeMap.delete(sessionId);
  }

  /**
   * BUG-016: Legacy backward-compat — returns only the backendNodeId for a
   * ref. Prefer `resolveRefFull` when you also need the owning sessionId,
   * which every caller that routes CDP commands does. Kept so tests and
   * non-critical callers don't need to change.
   */
  resolveRef(ref: string): number | undefined {
    return this.resolveRefFull(ref)?.backendNodeId;
  }

  /**
   * BUG-016: Returns both backendNodeId AND the owning sessionId for a
   * ref, eliminating the SessionManager-linear-scan in the hot path.
   * This is the canonical lookup for click/type/fill_form and any caller
   * that sends a CDP command that must be routed to the correct session.
   */
  resolveRefFull(ref: string): { backendNodeId: number; sessionId: string } | undefined {
    const match = ref.match(/^e(\d+)$/);
    if (!match) return undefined;
    const refNum = parseInt(match[1], 10);
    return this.reverseMap.get(refNum);
  }

  /**
   * BUG-016 follow-up: takes an optional `sessionId` so callers that
   * already know the owning session can pin the lookup unambiguously.
   * Omitting `sessionId` falls back to the composite-aware linear scan
   * (first match wins) for legacy callers and tests.
   */
  getNodeInfo(backendNodeId: number, sessionId?: string): NodeInfo | undefined {
    return this.nodeInfoLookup(backendNodeId, sessionId);
  }

  /**
   * UX-001: Find an element by visible text (name). Returns ref string and backendNodeId.
   * Matching priority: exact → case-insensitive exact → partial substring.
   * Within each tier, interactive roles (button, link, etc.) are preferred.
   */
  findByText(text: string): { ref: string; backendNodeId: number } | null {
    if (!text || this.reverseMap.size === 0) return null;

    const lower = text.toLowerCase();
    type Candidate = { refNum: number; backendNodeId: number; interactive: boolean };
    const exact: Candidate[] = [];
    const iexact: Candidate[] = [];
    const partial: Candidate[] = [];

    // BUG-016 follow-up: iterate reverseMap which already owns the
    // session context. nodeInfoLookup(bid, sessionId) routes to the
    // owner session's metadata — no cross-session collisions possible.
    for (const [refNum, owner] of this.reverseMap) {
      const info = this.nodeInfoLookup(owner.backendNodeId, owner.sessionId);
      if (!info || !info.name) continue;
      const interactive = INTERACTIVE_ROLES.has(info.role) || !!info.isClickable;
      const cand = { refNum, backendNodeId: owner.backendNodeId, interactive };
      if (info.name === text) {
        exact.push(cand);
      } else if (info.name.toLowerCase() === lower) {
        iexact.push(cand);
      } else if (info.name.toLowerCase().includes(lower)) {
        partial.push(cand);
      }
    }

    // Pick best candidate: prefer interactive, then lowest refNum (most stable)
    const pick = (candidates: Candidate[]) => {
      const interactive = candidates.filter(c => c.interactive);
      const best = (interactive.length > 0 ? interactive : candidates)
        .sort((a, b) => a.refNum - b.refNum)[0];
      return best ? { ref: `e${best.refNum}`, backendNodeId: best.backendNodeId } : null;
    };

    return pick(exact) ?? pick(iexact) ?? pick(partial);
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

  /**
   * BUG-016: Now takes an optional sessionId so composite-key lookups are
   * unambiguous. When sessionId is omitted we fall back to the current
   * render pass (`_renderSessionId`) — this keeps legacy callers in the
   * render/downsample pipeline working without rewiring every signature.
   */
  getRefForBackendNodeId(backendNodeId: number, sessionId?: string): string | undefined {
    const refNum = this.refLookup(backendNodeId, sessionId);
    return refNum !== undefined ? `e${refNum}` : undefined;
  }

  /**
   * Story 18.4 review H1: `PaintOrderUnavailableError` signals the specific
   * Chrome-bug mode where `DOMSnapshot.captureSnapshot` returns successfully
   * but omits (or empties) `documents[0].layout.paintOrders`. `getTree`
   * routes this into the same visualDataFailed fallback as a thrown CDP
   * error, plus emits a one-time structured warning via `reason`.
   */
  private async fetchVisualData(
    cdpClient: CdpClient,
    sessionId: string,
    filter: string,
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

    // Story 18.4 review H1: explicit Chrome-bug guard. When captureSnapshot
    // succeeds but `layout.paintOrders` is missing/empty, the occlusion
    // pass would silently degrade to a no-op (every element gets paintOrder
    // 0 and no candidate ever exceeds any other — read_page ships the full
    // unfiltered tree while claiming to be filtered). Throwing a tagged
    // error here routes the call into the same visualDataFailed fallback
    // that the thrown-CDP-error path already uses, and `getTree`'s catch
    // block reads the `reason` tag to emit the one-time H2 warning.
    const paintOrders = doc?.layout?.paintOrders;
    if (!Array.isArray(paintOrders) || paintOrders.length === 0) {
      throw new PaintOrderUnavailableError(
        "DOMSnapshot returned no paintOrders array — Chrome CDP regression",
      );
    }

    // Build layout index map: nodeIndex → layoutIndex
    const layoutMap = new Map<number, number>();
    for (let li = 0; li < doc.layout.nodeIndex.length; li++) {
      layoutMap.set(doc.layout.nodeIndex[li], li);
    }

    // BUG-016 follow-up: set render session context for the duration of
    // this DOMSnapshot walk so computeIsClickable (and any future helper
    // that resolves metadata by bare backendNodeId) sees the correct
    // session via nodeInfoLookup.
    const previousRenderSession = this._renderSessionId;
    this._renderSessionId = sessionId;

    const totalNodes = doc.nodes.backendNodeId.length;

    // Story 18.4: collect paint-order candidates in parallel with the
    // visual enrichment walk so the occlusion pass can run over a single
    // compact array instead of re-iterating doc.layout.
    type OcclusionCandidate = {
      backendNodeId: number;
      x: number;
      y: number;
      w: number;
      h: number;
      cx: number;
      cy: number;
      paintOrder: number;
      pointerEventsAuto: boolean;
    };
    const candidates: OcclusionCandidate[] = [];

    for (let ni = 0; ni < totalNodes; ni++) {
      const backendNodeId = doc.nodes.backendNodeId[ni];

      // Only process nodes that have a ref (i.e., are in the A11y tree).
      // BUG-016: composite-key lookup — `sessionId` is the parameter of
      // this method, guaranteeing the correct namespace for main-frame
      // DOMSnapshot data.
      if (!this.refExists(backendNodeId, sessionId)) continue;

      const li = layoutMap.get(ni);

      // No layout → hidden element
      if (li === undefined) {
        visualMap.set(backendNodeId, {
          bounds: { x: 0, y: 0, w: 0, h: 0 },
          isClickable: this.computeIsClickable(ni, backendNodeId, doc, strings),
          isVisible: false,
          occluded: false,
          paintOrder: 0,
        });
        continue;
      }

      // Read bounds
      const boundsArr = doc.layout.bounds[li];
      if (!boundsArr || boundsArr.length < 4) continue;

      const [x, y, w, h] = boundsArr;

      // Read computed styles: named indices from STYLE_IDX_* constants
      // (Invariant 5 — no magic numbers). Order is locked by COMPUTED_STYLES.
      const styleProps = doc.layout.styles[li] ?? [];
      const displayVal = this.getSnapshotString(strings, styleProps[STYLE_IDX_DISPLAY]);
      const visibilityVal = this.getSnapshotString(strings, styleProps[STYLE_IDX_VISIBILITY]);
      const pointerEventsVal = this.getSnapshotString(strings, styleProps[STYLE_IDX_POINTER_EVENTS]);

      // isVisible calculation
      const isVisible =
        displayVal !== "none" &&
        visibilityVal !== "hidden" &&
        w >= 1 && h >= 1 &&
        x + w > 0 && y + h > 0 &&
        x < EMULATED_WIDTH && y < EMULATED_HEIGHT;

      const isClickable = this.computeIsClickable(ni, backendNodeId, doc, strings);

      // Story 18.4: paintOrder is optional in the response type; default 0
      // keeps parity with the pre-18.4 behaviour when DOMSnapshot does not
      // emit paint orders (e.g. older Chrome builds, unit-test mocks).
      const paintOrder = doc.layout.paintOrders?.[li] ?? 0;

      // `pointer-events: none` is the only computed value that makes an
      // element invisible to hit-testing. Everything else (auto, visible,
      // visiblePainted, all, ...) blocks clicks. Missing value = default =
      // auto, so we treat `undefined`/empty as "blocks clicks".
      const pointerEventsAuto = pointerEventsVal !== "none";

      const roundedX = Math.round(x);
      const roundedY = Math.round(y);
      const roundedW = Math.round(w);
      const roundedH = Math.round(h);

      visualMap.set(backendNodeId, {
        bounds: {
          x: roundedX,
          y: roundedY,
          w: roundedW,
          h: roundedH,
        },
        isClickable,
        isVisible,
        occluded: false,
        paintOrder,
      });

      // Story 18.4: only visible candidates participate in the occlusion
      // check. Hidden elements (display: none, 0 size) are already
      // filtered, adding them would waste cycles.
      if (isVisible) {
        candidates.push({
          backendNodeId,
          x: roundedX,
          y: roundedY,
          w: roundedW,
          h: roundedH,
          cx: roundedX + roundedW / 2,
          cy: roundedY + roundedH / 2,
          paintOrder,
          pointerEventsAuto,
        });
      }
    }

    // Story 18.4: paint-order occlusion pass.
    //
    // Algorithm: for every visible candidate whose centre is not blocked
    // by pointer-events: none, check if any OTHER candidate with a higher
    // paintOrder AND pointer-events != none covers that centre point.
    // This mirrors what `document.elementFromPoint(cx, cy)` returns at
    // click dispatch time — the semantically same test Chrome runs for
    // Input.dispatchMouseEvent.
    //
    // Review M4: the target loop iterates only over candidates that could
    // survive the active filter. For `filter: "interactive"` that collapses
    // a 500-node page down to ~20-30 likely-interactive nodes before the
    // O(N^2) occlusion check, because a filtered-out element wouldn't make
    // it into renderNode's output anyway. The OCCLUDER list is unchanged —
    // every visible pointerEventsAuto candidate still counts, so modal
    // overlays that don't themselves pass the filter (e.g. a div behind a
    // close button) still hide the elements under them.
    //
    // Design decisions (Story 18.4 Dev Notes):
    // - Centre-point probe, not full-box overlap — matches click dispatch
    //   semantics and keeps partially-covered elements clickable.
    // - Only clickable occluders count — `pointer-events: none` overlays
    //   do NOT occlude, because Chrome's hit-test walks through them.
    // - We do NOT mark as occluded a candidate that itself has
    //   `pointer-events: none`; such an element cannot be clicked anyway,
    //   and the A11y node above it (modal close button etc.) stays in the
    //   tree because it is addressable through its own ref.
    const occludersByPaintOrder = [...candidates]
      .filter((c) => c.pointerEventsAuto)
      .sort((a, b) => b.paintOrder - a.paintOrder); // highest paint order first

    // Review M4: pre-filter targets to the set of candidates that could
    // survive the active read_page filter. For "all" / "visual" we keep
    // the full candidate set (filter-neutral). For "interactive" we keep
    // candidates whose a11y role is interactive, or whose nodeInfo flags
    // them as clickable (onclick / event listener). For "landmark" we
    // keep landmark-role candidates. This is a LOWER BOUND on what the
    // renderer will actually emit — some filtered-out elements may still
    // participate, but the savings are already dramatic (500→30 targets
    // is the typical shape for interactive on big SPA pages).
    let targets: OcclusionCandidate[];
    if (filter === "interactive") {
      targets = candidates.filter((c) => {
        const info = this.nodeInfoLookup(c.backendNodeId, sessionId);
        if (!info) return false;
        return INTERACTIVE_ROLES.has(info.role) || info.isClickable === true;
      });
    } else if (filter === "landmark") {
      targets = candidates.filter((c) => {
        const info = this.nodeInfoLookup(c.backendNodeId, sessionId);
        return info ? LANDMARK_ROLES.has(info.role) : false;
      });
    } else {
      // "all" and "visual" keep every candidate.
      targets = candidates;
    }

    for (const target of targets) {
      for (const occluder of occludersByPaintOrder) {
        if (occluder.paintOrder <= target.paintOrder) break; // sorted descending — no more higher occluders
        if (occluder.backendNodeId === target.backendNodeId) continue;
        // Is target's centre inside occluder's bounds?
        if (
          target.cx >= occluder.x &&
          target.cx <= occluder.x + occluder.w &&
          target.cy >= occluder.y &&
          target.cy <= occluder.y + occluder.h
        ) {
          const vi = visualMap.get(target.backendNodeId);
          if (vi) vi.occluded = true;
          break;
        }
      }
    }

    this._renderSessionId = previousRenderSession;
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
      // BUG-016 follow-up: only iterate nodes owned by THIS session.
      // sessionNodeMap already partitions per session, so we can filter
      // without touching other sessions' metadata.
      const ownedBackendIds = this.sessionNodeMap.get(sessionId);
      if (!ownedBackendIds || ownedBackendIds.size === 0) return;
      const interactiveNodes: number[] = [];
      const checkClickNodes: number[] = [];
      for (const backendNodeId of ownedBackendIds) {
        const info = this.nodeInfoLookup(backendNodeId, sessionId);
        if (!info) continue;
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
            const info = this.nodeInfoLookup(backendNodeId, sessionId);
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
      const clickCandidates = checkClickNodes.filter(id => !this.nodeInfoLookup(id, sessionId)?.isClickable);
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
              const info = this.nodeInfoLookup(backendNodeId, sessionId);
              if (info) info.isClickable = true;
            }
            await cdpClient.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
          } catch { /* ignore — some nodes can't be resolved */ }
        }));
      }
      // Phase 3: FR-H5 — Enrich unnamed clickable generics with innerText.
      // Separate pass with fresh resolveNode to avoid stale objectId issues.
      // BUG-016 follow-up: iterate THIS session's owned nodes only so we
      // never read metadata that belongs to a parallel OOPIF.
      const unnamedClickables: Array<[number, NodeInfo]> = [];
      for (const backendNodeId of ownedBackendIds) {
        const info = this.nodeInfoLookup(backendNodeId, sessionId);
        if (info && info.isClickable && !info.name && POTENTIALLY_CLICKABLE_ROLES.has(info.role)) {
          unnamedClickables.push([backendNodeId, info]);
        }
      }
      if (unnamedClickables.length > 0 && unnamedClickables.length <= 100) {
        await Promise.allSettled(unnamedClickables.map(async ([backendNodeId, info]) => {
          try {
            const resolved = await cdpClient.send<{ object: { objectId?: string } }>(
              "DOM.resolveNode", { backendNodeId }, sessionId,
            );
            const oid = resolved.object?.objectId;
            if (!oid) return;
            // FR-021: Fetch truncated text AND full length so formatLine can show a truncation marker.
            // Separator \x00 avoids JSON/object marshalling overhead — one string roundtrip, simple split.
            const textResult = await cdpClient.send<{ result: { value?: string } }>(
              "Runtime.callFunctionOn",
              { functionDeclaration: "function(){const t=(this.innerText||this.textContent||'');return t.slice(0,80)+'\\x00'+t.length}", objectId: oid, returnByValue: true },
              sessionId,
            );
            if (textResult.result.value) {
              const sep = textResult.result.value.indexOf("\x00");
              if (sep >= 0) {
                const truncated = textResult.result.value.slice(0, sep);
                const fullLength = parseInt(textResult.result.value.slice(sep + 1), 10);
                if (truncated) {
                  info.name = truncated;
                  if (Number.isFinite(fullLength) && fullLength > truncated.length) {
                    info.nameFullLength = fullLength;
                  }
                }
              } else {
                info.name = textResult.result.value; // Legacy fallback
              }
            }
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

    // Role from A11y tree nodeInfoMap.
    // BUG-016 follow-up: this helper is called from fetchVisualData
    // which already runs per-session, so _renderSessionId is not
    // reliable here. Instead pass through the session-aware lookup;
    // the caller context lives in fetchVisualData below.
    const nodeInfo = this.nodeInfoLookup(backendNodeId);
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
    // BUG-016 follow-up: session-scoped metadata lookup via owner.
    const candidates: Array<{ refNum: number; backendNodeId: number; role: string; name: string }> = [];
    for (const [refNum, owner] of this.reverseMap.entries()) {
      const info = this.nodeInfoLookup(owner.backendNodeId, owner.sessionId);
      const role = info?.role ?? "";
      if (roleFilter && !roleFilter.has(role)) continue;
      candidates.push({ refNum, backendNodeId: owner.backendNodeId, role, name: info?.name ?? "" });
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

    // BUG-019: No CDP depth limit.
    //
    // Prior versions passed Accessibility.getFullAXTree({depth: Math.max(depth, 10)})
    // which hard-capped the fetch at tree-level 10. Real-world SPAs (Polar admin,
    // HackerNews story list, Wikipedia articles, most dashboards) nest their main
    // content at levels 11+. Everything beyond the cap came back with empty
    // childIds, so renderNode produced e.g. "[e44] generic" with zero children
    // while a subsequent read_page(ref: "e44") re-rooted the walk at e44 and
    // found 100+ descendants.
    //
    // CDP semantics (chromedevtools.github.io/devtools-protocol/tot/Accessibility/):
    //   "depth: The maximum depth at which descendants of the root node should
    //    be retrieved. If omitted, the full tree is returned."
    //
    // We therefore OMIT `depth` at the wire level (undefined in the CDP params).
    // The display-`depth` option still controls rendering indent — that was never
    // a fetch concern, just a formatting concern.
    //
    // The `cdpFetchDepth` variable below is kept as a cache-invalidation sentinel:
    // `Infinity` means "fetched with no limit", so any future request for a
    // smaller display depth is automatically a cache hit.
    const cdpFetchDepth = Infinity;

    // Navigation detection — reset refs on real navigation (path change),
    // but preserve refs on hash-only changes (anchor navigation).
    const urlResult = await cdpClient.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression: "document.URL", returnByValue: true },
      sessionId,
    );
    const currentUrl = urlResult.result.value;
    if (stripHash(currentUrl) !== stripHash(this.lastUrl)) {
      // BUG-016 follow-up (final review MEDIUM #4): also clear
      // sessionNodeMap and _renderSessionId so stale session-ownership
      // can't influence the next round of cleanup/render decisions.
      // Otherwise removeNodesForSession would still "know" about
      // backendNodeIds that belonged to the previous document.
      this.refMap.clear();
      this.reverseMap.clear();
      this.nodeInfoMap.clear();
      this.sessionNodeMap.clear();
      this._renderSessionId = "";
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
      // Fetch A11y tree from CDP — main frame (fallback / cache miss).
      // BUG-019: No depth parameter — see the cdpFetchDepth comment above.
      // Omitting `depth` makes CDP return the full tree; any depth cap would
      // silently truncate deeply nested main-content subtrees (Polar tables,
      // HackerNews rows, Wikipedia articles, etc.).
      const result = await cdpClient.send<{ nodes: AXNode[] }>(
        "Accessibility.getFullAXTree",
        {},
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
    // BUG-016: composite-key so OOPIF backendNodeIds can't collide with main.
    for (const node of nodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) continue;
      const key = this.refKey(node.backendDOMNodeId, sessionId);
      if (!this.refMap.has(key)) {
        const refNum = this.nextRef++;
        this.refMap.set(key, refNum);
        this.reverseMap.set(refNum, { backendNodeId: node.backendDOMNodeId, sessionId });
      }
      // Always update nodeInfoMap with latest role/name — composite-keyed
      // so cross-session collisions don't clobber metadata.
      this.nodeInfoSet(node.backendDOMNodeId, sessionId, extractNodeInfo(node));
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
              // BUG-019: No depth — fetch full OOPIF tree. Nested iframes on
              // modern sites (Stripe Elements, embedded YouTube, etc.) have
              // the same level-cap problem as the main frame.
              const oopifResult = await cdpClient.send<{ nodes: AXNode[] }>(
                "Accessibility.getFullAXTree",
                {},
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
            // BUG-016: OOPIF backendNodeIds live in a different per-process
            // namespace and must be keyed by the OOPIF's sessionId to avoid
            // colliding with the main frame.
            for (const node of oopifResult.nodes) {
              // Add to nodeMap with session-prefixed keys to avoid collisions
              nodeMap.set(`${oopifResult.sessionId}:${node.nodeId}`, node);
              if (node.ignored || node.backendDOMNodeId === undefined) continue;
              const oopifKey = this.refKey(node.backendDOMNodeId, oopifResult.sessionId);
              if (!this.refMap.has(oopifKey)) {
                const refNum = this.nextRef++;
                this.refMap.set(oopifKey, refNum);
                this.reverseMap.set(refNum, {
                  backendNodeId: node.backendDOMNodeId,
                  sessionId: oopifResult.sessionId,
                });
              }
              this.nodeInfoSet(node.backendDOMNodeId, oopifResult.sessionId, {
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

    // FR-023: Inline same-origin iframe A11y trees so LLM sees iframe content
    // directly in read_page instead of a blind "(use evaluate to access iframe content)" hint.
    // Same-origin frames (including srcdoc and about:blank) share the main renderer process,
    // so we fetch their AX trees via getFullAXTree({frameId}) on the main session.
    // Their backendDOMNodeIds are unique within the main session's namespace → use main sessionId as key.
    try {
      const frameTreeResult = await cdpClient.send<{
        frameTree: {
          frame: { id: string; url: string; securityOrigin: string; parentId?: string; name?: string };
          childFrames?: Array<{
            frame: { id: string; url: string; securityOrigin: string; parentId?: string; name?: string };
            childFrames?: unknown[];
          }>;
        };
      }>("Page.getFrameTree", {}, sessionId);

      const mainOrigin = frameTreeResult.frameTree.frame.securityOrigin;
      const mainFrameId = frameTreeResult.frameTree.frame.id;

      // Collect all same-origin child frames recursively
      interface FrameInfo {
        id: string;
        url: string;
        securityOrigin: string;
        name?: string;
      }
      const sameOriginFrames: FrameInfo[] = [];

      const collectSameOriginFrames = (childFrames: unknown[] | undefined): void => {
        if (!childFrames) return;
        for (const child of childFrames as Array<{
          frame: { id: string; url: string; securityOrigin: string; name?: string };
          childFrames?: unknown[];
        }>) {
          const frame = child.frame;
          if (frame.id === mainFrameId) continue; // skip main frame
          // Same-origin classification: srcdoc, about:blank, or matching origin
          const isSameOrigin =
            frame.url === "about:srcdoc" ||
            frame.url === "about:blank" ||
            frame.securityOrigin === mainOrigin;
          if (isSameOrigin) {
            sameOriginFrames.push(frame);
          }
          // Recurse into nested frames regardless — a cross-origin frame's child
          // could be same-origin again (but that's handled by OOPIF sessions already,
          // so we only recurse same-origin subtrees to avoid duplicates with OOPIF handling)
          if (isSameOrigin) {
            collectSameOriginFrames(child.childFrames);
          }
        }
      };
      collectSameOriginFrames(frameTreeResult.frameTree.childFrames);

      // Fetch AX trees for each same-origin child frame
      if (sameOriginFrames.length > 0) {
        // Deduplicate: skip frames already covered by OOPIF sessions
        const oopifFrameIds = new Set(
          sessionManager?.getAllSessions()
            .filter((s: SessionInfo) => !s.isMain)
            .map((s: SessionInfo) => s.frameId) ?? [],
        );

        const inlineResults = await Promise.all(
          sameOriginFrames
            .filter((f) => !oopifFrameIds.has(f.id))
            .map(async (frame) => {
              try {
                const result = await cdpClient.send<{ nodes: AXNode[] }>(
                  "Accessibility.getFullAXTree",
                  { frameId: frame.id },
                  sessionId,
                );
                return { url: frame.url, nodes: result.nodes ?? [], sessionId, frameId: frame.id };
              } catch {
                // Frame may have been removed between getFrameTree and getFullAXTree
                return { url: frame.url, nodes: [] as AXNode[], sessionId, frameId: frame.id };
              }
            }),
        );

        for (const inlineResult of inlineResults) {
          if (inlineResult.nodes.length > 0) {
            oopifSections.push({
              url: inlineResult.url,
              nodes: inlineResult.nodes,
              sessionId: inlineResult.sessionId, // main session — same renderer process
            });

            // Register refs for inline iframe nodes using main sessionId
            for (const node of inlineResult.nodes) {
              if (node.ignored || node.backendDOMNodeId === undefined) continue;
              const key = this.refKey(node.backendDOMNodeId, sessionId);
              if (!this.refMap.has(key)) {
                const refNum = this.nextRef++;
                this.refMap.set(key, refNum);
                this.reverseMap.set(refNum, {
                  backendNodeId: node.backendDOMNodeId,
                  sessionId,
                });
              }
              this.nodeInfoSet(node.backendDOMNodeId, sessionId, extractNodeInfo(node));
              if (!this.sessionNodeMap.has(sessionId)) {
                this.sessionNodeMap.set(sessionId, new Set());
              }
              this.sessionNodeMap.get(sessionId)!.add(node.backendDOMNodeId);
              sessionManager?.registerNode(node.backendDOMNodeId, sessionId);
            }
          }
        }
      }
    } catch {
      // Page.getFrameTree may fail on special pages (devtools://, chrome://, etc.)
      // or if the page navigated between calls. Gracefully degrade — main frame
      // and OOPIF trees are already captured above.
      debug("A11yTreeProcessor: Page.getFrameTree failed, skipping same-origin iframe inlining");
    }

    // FR-H5: Enrich nodes with HTML attributes + event listener detection.
    // Runs in getTree() so read_page(filter: "interactive") sees clickable divs/listItems.
    await this._enrichNodeMetadata(cdpClient, sessionId);

    // Story 18.4: visual data is now fetched for ALL filter modes, not just
    // "visual". We need the paint-order metadata to filter occluded elements
    // out of the rendered output, regardless of filter. Rendering of
    // visual annotations (bounds, click, vis) still only happens for
    // filter === "visual" — see renderNode / renderNodeDownsampled.
    //
    // The visualDataFailed fallback remains unchanged: if
    // DOMSnapshot.captureSnapshot throws (older Chrome, restricted pages),
    // getTree gracefully degrades to an unfiltered tree.
    //
    // Review M3: results are cached per (cacheVersion, sessionId, filter)
    // tuple. Rapid-fire read_page calls against the same AX-tree state
    // hit the cache and skip the CDP round-trip entirely. Any change that
    // bumps `_cacheVersion` (reset, navigate, refresh) drops the cache.
    //
    // Review H1+H2: the H1 guard inside fetchVisualData throws
    // PaintOrderUnavailableError when captureSnapshot returns a payload
    // without `paintOrders`. We route that into the same visualDataFailed
    // fallback as a real CDP error, but differentiate the log reason so
    // the one-time warning below tells operators whether Chrome rejected
    // the call or regressed silently.
    let visualMap: Map<number, VisualInfo> | undefined;
    let visualDataFailed = false;
    const cached = this._lastVisualCache;
    if (
      !options.fresh
      && cached
      && cached.cacheVersion === this._cacheVersion
      && cached.sessionId === sessionId
      && cached.filter === filter
    ) {
      visualMap = cached.visualMap;
      visualDataFailed = cached.visualDataFailed;
      debug("A11yTreeProcessor: visual cache hit (v%d, %s)", this._cacheVersion, filter);
    } else {
      try {
        visualMap = await this.fetchVisualData(cdpClient, sessionId, filter);
      } catch (err) {
        // M1: DOMSnapshot may fail on certain pages — fall back to tree without visual data.
        // Review H2: emit a one-time structured warning so silent Chrome
        // regressions don't hide in production logs. We keep the warning
        // to `console.warn` instead of the project debug() channel
        // because debug() is behind an opt-in env var.
        visualMap = undefined;
        visualDataFailed = true;
        if (!this._paintOrderWarningEmitted) {
          const reason = err instanceof PaintOrderUnavailableError
            ? err.reason
            : "capture-snapshot-failed";
          console.warn(
            `[silbercuechrome] Paint-order filtering unavailable (${reason}). ` +
            `read_page will fall back to the unfiltered A11y tree for this session. ` +
            `This indicates a Chrome CDP DOMSnapshot regression — please report ` +
            `at https://github.com/silbercue/silbercuechrome/issues with Chrome version.`,
          );
          this._paintOrderWarningEmitted = true;
        }
      }
      // Store in cache regardless of success/failure so a subsequent
      // read_page in the same tree state doesn't repeat the work (and
      // doesn't re-emit the warning even if _paintOrderWarningEmitted
      // were ever reset).
      this._lastVisualCache = {
        cacheVersion: this._cacheVersion,
        sessionId,
        filter,
        visualMap,
        visualDataFailed,
      };
    }

    // Handle subtree query
    if (options.ref) {
      // BUG-016 (codex review, CRITICAL #4): the old "combine main + all
      // OOPIFs into one nodeMap" strategy was broken. Chrome reuses short
      // `nodeId` strings ("1", "2", ...) per session, so merging two
      // sessions' nodeMaps silently overwrote entries. Worse, the
      // `nodes.find(n => n.backendDOMNodeId === targetId)` lookup in
      // getSubtree returned the FIRST match — under a backendNodeId
      // collision between main and an OOPIF, that was the wrong frame.
      //
      // Fix: pick the correct frame up-front using the ref's owner
      // sessionId, then build the nodeMap from that frame's nodes only.
      const full = this.resolveRefFull(options.ref);
      if (!full) {
        const availableRefs = this.getAvailableRefsRange();
        const suggestion = this.suggestClosestRef(options.ref);
        let errorText = `Element ${options.ref} not found.`;
        if (availableRefs) errorText += ` Available refs: ${availableRefs}.`;
        if (suggestion) errorText += ` Did you mean ${suggestion}?`;
        throw new RefNotFoundError(errorText);
      }

      let frameNodes: AXNode[];
      if (full.sessionId === sessionId) {
        frameNodes = nodes;
      } else {
        const section = oopifSections.find((s) => s.sessionId === full.sessionId);
        if (!section) {
          throw new RefNotFoundError(
            `Element ${options.ref} belongs to a session that is no longer attached.`,
          );
        }
        frameNodes = section.nodes;
      }

      const frameNodeMap = new Map<string, AXNode>();
      for (const node of frameNodes) {
        frameNodeMap.set(node.nodeId, node);
      }
      return this.getSubtree(
        options.ref,
        frameNodeMap,
        frameNodes,
        filter,
        depth,
        visualMap,
        visualDataFailed,
        options.max_tokens,
      );
    }

    // Get page title from root node
    const pageTitle = this.getPageTitle(nodes);

    // Build tree text from root (main frame)
    const root = nodes[0];
    const lines: string[] = [];
    // Ticket-1: Pre-scan the whole tree (main + OOPIFs) to identify groups
    // of ≥10 same-class leaves that should collapse into summary lines.
    // Must run BEFORE renderNode so anchors/suppressed ids are visible to
    // every walk path.
    // BUG-016: set render session so helpers (renderNode, prepareAggregateGroups,
    // etc.) can resolve backendNodeId → ref via the composite-keyed refMap.
    this._renderSessionId = sessionId;
    try {
      this.prepareAggregateGroups(root, nodeMap, oopifSections, filter);
      this.renderNode(root, nodeMap, 0, filter, lines, visualMap);
    } finally {
      this._renderSessionId = "";
    }

    // Append OOPIF sections
    for (const section of oopifSections) {
      const oopifNodeMap = new Map<string, AXNode>();
      for (const node of section.nodes) {
        oopifNodeMap.set(node.nodeId, node);
      }
      lines.push(`--- iframe: ${section.url} ---`);
      if (section.nodes.length > 0) {
        // BUG-016: switch render session context for this OOPIF.
        this._renderSessionId = section.sessionId;
        try {
          this.renderNode(section.nodes[0], oopifNodeMap, 0, filter, lines, visualMap);
        } finally {
          this._renderSessionId = "";
        }
      }
    }
    this.clearAggregateGroups();

    // H5: Count only actual element lines, not separator lines (--- iframe: ... ---)
    const refCount = lines.filter((l) => !l.startsWith("--- ")).length;

    // FR-022: Count content nodes (StaticText/paragraph/etc.) hidden by filter:interactive,
    // so read-page.ts can append a hint pointing the LLM at filter:'all' instead of evaluate.
    const hiddenContentCount = filter === "interactive"
      ? this.countHiddenContentNodes(root, nodeMap, oopifSections)
      : undefined;

    const text = this.formatHeader(pageTitle, refCount, filter, depth)
      + (lines.length > 0 ? "\n\n" + lines.join("\n") : "");

    // Token-Budget Downsampling — explicit max_tokens, filter-specific default, or BUG-009 safety cap
    const effectiveMaxTokens = options.max_tokens
      ?? (filter === "interactive" ? DEFAULT_INTERACTIVE_MAX_TOKENS : DEFAULT_MAX_TOKENS);
    const currentTokens = estimateTokens(text);
    if (currentTokens > effectiveMaxTokens) {
      // BUG-016: re-establish render session for downsample's main-frame
      // render passes. downsampleTree manages OOPIF session context internally.
      this._renderSessionId = sessionId;
      const downsampled = this.downsampleTree(
        root, nodeMap, filter, effectiveMaxTokens,
        oopifSections, visualMap,
      );
      this._renderSessionId = "";
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
        ...(hiddenContentCount !== undefined ? { hiddenContentCount } : {}),
      };
    }

    return {
      text,
      refCount,
      depth,
      tokenCount: currentTokens,
      pageUrl: this.lastUrl,
      ...(filter === "visual" ? { hasVisualData: !visualDataFailed } : {}),
      ...(hiddenContentCount !== undefined ? { hiddenContentCount } : {}),
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
    // BUG-016: downsampleTree is always called from getTree(), which has
    // already captured the main-frame sessionId in `_renderSessionId`.
    // However, downsampleTree may be retried across multiple levels and
    // restores `_renderSessionId` after each OOPIF section — we re-set it
    // back to the main session at each iteration to stay robust.
    const mainSessionId = this._renderSessionId;

    // Try levels 0-4 sequentially until budget is met
    for (let level = 0; level <= 4; level++) {
      const lines: string[] = [];
      this._renderSessionId = mainSessionId;
      try {
        this.renderNodeDownsampled(root, nodeMap, 0, filter, lines, level, visualMap);
      } finally {
        this._renderSessionId = "";
      }

      // Append OOPIF sections
      for (const section of oopifSections) {
        const oopifNodeMap = new Map<string, AXNode>();
        for (const node of section.nodes) {
          oopifNodeMap.set(node.nodeId, node);
        }
        lines.push(`--- iframe: ${section.url} ---`);
        if (section.nodes.length > 0) {
          this._renderSessionId = section.sessionId;
          try {
            this.renderNodeDownsampled(section.nodes[0], oopifNodeMap, 0, filter, lines, level, visualMap);
          } finally {
            this._renderSessionId = "";
          }
        }
      }

      const refCount = lines.filter((l) => !l.startsWith("--- ")).length;
      // Estimate tokens including a header estimate (~60 chars)
      const estimatedTotal = estimateTokens(lines.join("\n")) + 15;
      if (estimatedTotal <= maxTokens) {
        this._renderSessionId = mainSessionId; // restore for caller
        return { lines, refCount, level };
      }
    }

    // Level 4 still too large → truncate as last resort
    const lines: string[] = [];
    this._renderSessionId = mainSessionId;
    try {
      this.renderNodeDownsampled(root, nodeMap, 0, filter, lines, 4, visualMap);
    } finally {
      this._renderSessionId = "";
    }

    // Append OOPIF sections
    for (const section of oopifSections) {
      const oopifNodeMap = new Map<string, AXNode>();
      for (const node of section.nodes) {
        oopifNodeMap.set(node.nodeId, node);
      }
      lines.push(`--- iframe: ${section.url} ---`);
      if (section.nodes.length > 0) {
        this._renderSessionId = section.sessionId;
        try {
          this.renderNodeDownsampled(section.nodes[0], oopifNodeMap, 0, filter, lines, 4, visualMap);
        } finally {
          this._renderSessionId = "";
        }
      }
    }

    this._renderSessionId = mainSessionId; // restore for caller
    return this.truncateToFit(lines, maxTokens);
  }

  /**
   * BUG-019 landmark-aware truncation.
   *
   * Legacy behavior bucketed every line into one of three global pools
   * (dialog > interactive > content). Sidebar navigation links and header
   * buttons were treated exactly the same as main-content buttons, so on a
   * typical SPA the 30-link sidebar dominated the interactive bucket and
   * pushed the actual main-area table cells out of the budget.
   *
   * New behavior: every line is tagged with its primary landmark ancestor
   * (tracked via an indent stack, same approach as the existing dialog
   * tracking). The priority matrix becomes:
   *
   *   0. Dialogs (absolute priority — must never be dropped)
   *   1. Main / implicit-main interactive
   *   2. Main / implicit-main content
   *   3. No-landmark-ancestor interactive
   *   4. No-landmark-ancestor content
   *   5. Navigation / banner / complementary / contentinfo interactive
   *   6. Navigation / banner / complementary / contentinfo content
   *
   * "Implicit main": many real-world sites (Polar, most Next.js dashboards)
   * wrap their main content in a plain <div role="generic"> instead of a
   * proper <main>. We pick the biggest non-landmark subtree at the root
   * level as the implicit main so its subtree gets buckets 1+2 instead of
   * buckets 3+4.
   *
   * When the main landmark is itself partially truncated we append a hint
   * that tells the LLM exactly which ref to re-read for the full subtree.
   */
  private truncateToFit(
    lines: string[],
    maxTokens: number,
  ): { lines: string[]; refCount: number; level: number } {
    // --- Phase A: Categorise lines by landmark ancestor + element class ----

    // Landmark stack entry: landmark kind + the indent level at which it started.
    type LandmarkKind = "main" | "dialog" | "nav-like" | "other";
    type StackEntry = { kind: LandmarkKind; indent: number; ref?: number };

    const NAV_LIKE_ROLES = new Set([
      "navigation",
      "banner",
      "complementary",
      "contentinfo",
      "search",
    ]);

    // Level 3/4 downsampling replaces containers with `[shortRole: name, N items]`
    // summary lines. shortContainerRole() produces these short names — we need
    // the reverse mapping so truncateToFit can still recognise which bucket
    // those summary lines belong to.
    const SUMMARY_ROLE_TO_LANDMARK: Record<string, "main" | "nav-like" | "other"> = {
      main: "main",
      nav: "nav-like",
      aside: "nav-like",
      footer: "nav-like",
      header: "nav-like",
      search: "nav-like",
      // "div" / "group" / "region" / "form" etc. stay "other" — they can legitimately
      // live inside main and shouldn't be auto-demoted.
    };

    // Parse either
    //   "[eNN] rolename"            (normal line), or
    //   "[eNN shortRole: name, N items]" (downsample summary line — BUG-019)
    //
    // Legacy summaries without a ref are still supported for forward-compat
    // (and for any subtree downsamples that re-enter this path).
    const parseHeader = (line: string): {
      ref?: number;
      role: string;
      summaryLandmark?: "main" | "nav-like" | "other";
    } => {
      // Normal render line
      const m = line.match(/\[e(\d+)\]\s+(\S+)/);
      if (m) return { ref: Number(m[1]), role: m[2] };
      // Summary with ref
      const sRef = line.match(/^\s*\[e(\d+)\s+([a-z]+)(?::\s[^,]*)?,\s*\d+\s+items\]/);
      if (sRef) {
        return {
          ref: Number(sRef[1]),
          role: sRef[2],
          summaryLandmark: SUMMARY_ROLE_TO_LANDMARK[sRef[2]],
        };
      }
      // Legacy summary without ref
      const sLegacy = line.match(/^\s*\[([a-z]+)(?::\s[^,]*)?,\s*\d+\s+items\]/);
      if (sLegacy) {
        return { role: sLegacy[1], summaryLandmark: SUMMARY_ROLE_TO_LANDMARK[sLegacy[1]] };
      }
      return { role: "" };
    };

    // Indent of a content line ("  " = indent level 1 etc.). Returns 0 for
    // lines without leading whitespace or for separator lines.
    const indentOf = (line: string): number => {
      if (line.startsWith("--- ") || line.startsWith("...")) return -1;
      return line.search(/\S/);
    };

    // --- Implicit main detection --------------------------------------------
    //
    // If no explicit role=main ever appears at root level, we pick the largest
    // non-landmark root container (biggest descendant count inside its indent
    // block) as the implicit main. "Root level" here means indent 0 or 2
    // because the RootWebArea line itself lives at indent 0 and its children
    // live at indent 2 (generic root wrappers push the structure down).
    let hasExplicitMain = false;
    for (const line of lines) {
      const { role } = parseHeader(line);
      if (role === "main") { hasExplicitMain = true; break; }
    }

    let implicitMainRef: number | undefined;
    let implicitMainIndent = -1;
    let implicitMainRefLocalMax: number | undefined; // deepest ref within implicit main
    if (!hasExplicitMain) {
      // Find the shallowest non-separator line and use its indent as the "root level"
      let rootIndent = -1;
      for (const line of lines) {
        const ind = indentOf(line);
        if (ind < 0) continue;
        if (rootIndent < 0 || ind < rootIndent) rootIndent = ind;
      }
      if (rootIndent >= 0) {
        // Walk candidates at rootIndent + 2 (children of the root webarea)
        const childIndent = rootIndent + 2;
        const candidates: Array<{ ref: number; start: number; end: number }> = [];
        for (let i = 0; i < lines.length; i++) {
          const ind = indentOf(lines[i]);
          if (ind !== childIndent) continue;
          const { ref, role } = parseHeader(lines[i]);
          if (ref === undefined) continue;
          // Skip known landmarks — only non-landmark containers are candidates.
          if (NAV_LIKE_ROLES.has(role) || role === "main" || role === "dialog" || role === "alertdialog") continue;
          // Compute end of this candidate's block (next line at same or shallower indent)
          let end = lines.length;
          for (let j = i + 1; j < lines.length; j++) {
            const jIndent = indentOf(lines[j]);
            if (jIndent >= 0 && jIndent <= childIndent) { end = j; break; }
          }
          candidates.push({ ref, start: i, end });
        }
        // Pick candidate with the most descendants.
        candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start));
        if (candidates.length > 0 && (candidates[0].end - candidates[0].start) >= 3) {
          implicitMainRef = candidates[0].ref;
          implicitMainIndent = childIndent;
        }
      }
    }

    // Priority buckets — indices refer to positions in `lines`.
    type Bucket = Array<{ line: string; idx: number }>;
    const buckets: Record<string, Bucket> = {
      dialog: [],
      mainInteractive: [],
      mainContent: [],
      otherInteractive: [],
      otherContent: [],
      navInteractive: [],
      navContent: [],
    };

    // Landmark stack — topmost entry wins.
    const stack: StackEntry[] = [];
    const topKind = (): LandmarkKind => (stack.length > 0 ? stack[stack.length - 1].kind : "other");
    // Track which ref represents the main landmark currently on the stack.
    // First match wins (outermost enclosing main).
    let explicitMainRef: number | undefined;
    let mainLandmarkTruncated = false;
    let keptInsideMain = 0;
    let totalInsideMain = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("--- ")) {
        // OOPIF separator — include regardless, counts as content.
        buckets.otherContent.push({ line, idx: i });
        continue;
      }
      const indent = indentOf(line);
      // Pop stack entries whose indent is no longer an ancestor.
      while (stack.length > 0 && indent >= 0 && indent <= stack[stack.length - 1].indent) {
        stack.pop();
      }

      const { ref, role, summaryLandmark } = parseHeader(line);

      // Enter new landmark?
      if (role === "dialog" || role === "alertdialog") {
        stack.push({ kind: "dialog", indent, ref });
      } else if (role === "main") {
        stack.push({ kind: "main", indent, ref });
        if (explicitMainRef === undefined) explicitMainRef = ref;
      } else if (NAV_LIKE_ROLES.has(role)) {
        stack.push({ kind: "nav-like", indent, ref });
      } else if (!hasExplicitMain && ref !== undefined && ref === implicitMainRef) {
        // Implicit main landmark entry — this specific ref becomes the main anchor.
        stack.push({ kind: "main", indent, ref });
      } else if (summaryLandmark) {
        // Downsample-summary line (e.g. `[e54 nav: Sidebar, 30 items]`) —
        // treat as landmark boundary so its children inherit the right bucket.
        stack.push({ kind: summaryLandmark, indent, ref });
        if (summaryLandmark === "main" && explicitMainRef === undefined && ref !== undefined) {
          explicitMainRef = ref;
        }
      }

      const landmark = topKind();
      const isInteractive = INTERACTIVE_ROLES.has(role) && role !== "option";

      if (landmark === "main") {
        totalInsideMain++;
        if (implicitMainRefLocalMax === undefined || (ref !== undefined && ref > implicitMainRefLocalMax)) {
          implicitMainRefLocalMax = ref ?? implicitMainRefLocalMax;
        }
      }

      if (landmark === "dialog") {
        buckets.dialog.push({ line, idx: i });
      } else if (landmark === "main") {
        (isInteractive ? buckets.mainInteractive : buckets.mainContent).push({ line, idx: i });
      } else if (landmark === "nav-like") {
        (isInteractive ? buckets.navInteractive : buckets.navContent).push({ line, idx: i });
      } else {
        (isInteractive ? buckets.otherInteractive : buckets.otherContent).push({ line, idx: i });
      }
    }

    // --- Phase A.5: Precompute each line's indent-ancestor chain ----------
    //
    // BUG-019 P2 follow-up (Session 45567c9b): bucketing splits container
    // summary lines (mainContent) from the interactive leaves inside them
    // (mainInteractive). Under a tight budget the interactive bucket fills
    // first and drains the remaining budget, so the container summary lines
    // that provide structural context get dropped — producing orphaned
    // leaves with indent jumps of 4+ and no parent chain for the LLM to
    // understand where they live.
    //
    // Every line here records its indent-ancestor chain (top-down order of
    // `lines` indices). `consume()` force-includes any missing ancestors
    // when it keeps a line, so structure and content always travel
    // together. Ancestors may live in any bucket (or no bucket at all, in
    // the case of indent-carrying root wrappers) — all that matters is
    // that the visual nesting stays intact.
    const parentChain: number[][] = new Array(lines.length);
    {
      const stack: Array<{ idx: number; indent: number }> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("--- ") || line.startsWith("...")) {
          parentChain[i] = [];
          continue;
        }
        const ind = indentOf(line);
        if (ind < 0) {
          parentChain[i] = [];
          continue;
        }
        while (stack.length > 0 && stack[stack.length - 1].indent >= ind) {
          stack.pop();
        }
        parentChain[i] = stack.map((e) => e.idx);
        stack.push({ idx: i, indent: ind });
      }
    }

    // --- Phase B: Fill buckets in priority order ---------------------------

    const result: string[] = [];
    const addedIndices = new Set<number>();
    let tokensSoFar = 15; // header estimate
    const headroom = 40; // leave room for hint + truncation marker

    const consume = (bucket: Bucket): boolean => {
      let anyDropped = false;
      for (const { line, idx } of bucket) {
        if (addedIndices.has(idx)) continue;

        // Determine any ancestors that aren't yet in the output — these
        // must be force-included together with the line to preserve
        // structural context (see parentChain comment above).
        const missingAncestors: number[] = [];
        let ancestorTokens = 0;
        for (const ai of parentChain[idx]) {
          if (!addedIndices.has(ai)) {
            missingAncestors.push(ai);
            ancestorTokens += estimateTokens(lines[ai] + "\n");
          }
        }

        const lineTokens = estimateTokens(line + "\n");
        if (tokensSoFar + lineTokens + ancestorTokens > maxTokens - headroom) {
          anyDropped = true;
          continue;
        }

        // Add missing ancestors top-down, then the line itself.
        for (const ai of missingAncestors) {
          result.push(lines[ai]);
          addedIndices.add(ai);
          tokensSoFar += estimateTokens(lines[ai] + "\n");
        }
        result.push(line);
        addedIndices.add(idx);
        tokensSoFar += lineTokens;
      }
      return !anyDropped;
    };

    consume(buckets.dialog);
    const mainInteractiveComplete = consume(buckets.mainInteractive);
    const mainContentComplete = consume(buckets.mainContent);
    consume(buckets.otherInteractive);
    consume(buckets.otherContent);
    consume(buckets.navInteractive);
    consume(buckets.navContent);

    if (!mainInteractiveComplete || !mainContentComplete) {
      mainLandmarkTruncated = true;
    }
    keptInsideMain = buckets.mainInteractive.filter((e) => addedIndices.has(e.idx)).length
      + buckets.mainContent.filter((e) => addedIndices.has(e.idx)).length;

    // --- Phase C: Re-sort by original index so document order is preserved --
    const sortedResult = [...addedIndices]
      .sort((a, b) => a - b)
      .map((i) => lines[i]);

    const omitted = lines.length - addedIndices.size;
    if (omitted > 0) {
      sortedResult.push(`... (truncated, ${omitted} elements omitted)`);
    }

    // --- Phase D: Escape-hint ---------------------------------------------
    //
    // Two variants so the LLM always gets a concrete positive next step when
    // content was dropped (Session 45567c9b research: positive + actionable
    // hints outperform negative framing and are more reliable than
    // description-level hints under token pressure):
    //
    // D1 — explicit or implicit main was detected AND partially truncated:
    //      point directly at the main ref.
    // D2 — no main landmark at all (HN-style LayoutTable pages) BUT there
    //      are collapsed container summary lines in the kept output: list
    //      the three biggest by item count as drill-down anchors so the LLM
    //      knows which refs are worth expanding.
    const mainAnchorRef = explicitMainRef ?? implicitMainRef;
    if (mainLandmarkTruncated && mainAnchorRef !== undefined && totalInsideMain > keptInsideMain) {
      sortedResult.push(
        `\nNote: main content partially truncated (${keptInsideMain}/${totalInsideMain} elements kept). ` +
        `Call read_page(ref: "e${mainAnchorRef}", filter: "all") for the full main subtree.`,
      );
    } else if (omitted > 0) {
      // No main-landmark anchor — gather the biggest collapsed container
      // summaries that DID survive the truncation so the LLM has concrete
      // refs to drill into. Summary lines look like `[eNN shortRole[: name], K items]`.
      // Role can be lowercase (`div`, `nav`) OR PascalCase from CDP
      // (`LayoutTableRow`, `RootWebArea`) — accept both.
      const summaryPattern = /\[e(\d+)\s+[A-Za-z]+(?::\s[^,]*)?,\s*(\d+)\s+items\]/;
      const anchors: Array<{ ref: number; items: number }> = [];
      for (const line of sortedResult) {
        const m = line.match(summaryPattern);
        if (m) anchors.push({ ref: Number(m[1]), items: Number(m[2]) });
      }
      if (anchors.length > 0) {
        anchors.sort((a, b) => b.items - a.items);
        const top = anchors.slice(0, 3)
          .map((a) => `e${a.ref} (${a.items} items)`)
          .join(", ");
        sortedResult.push(
          `\nNote: ${omitted} elements collapsed into summary lines. ` +
          `Largest collapsed containers: ${top}. ` +
          `Call read_page(ref: "eXX", filter: "all") on one of these refs to expand that subtree.`,
        );
      }
    }

    const refCount = sortedResult.filter(
      (l) => !l.startsWith("--- ") && !l.startsWith("...") && !l.startsWith("\nNote:"),
    ).length;
    return { lines: sortedResult, refCount, level: 4 };
  }

  /** C2: Trim body lines from the end (content first) until budget is met */
  private trimBodyToFit(lines: string[], bodyBudgetTokens: number): string[] {
    if (bodyBudgetTokens <= 0) return [];

    // Session 45567c9b: Preserve trailing "Note:" escape-hint lines that
    // truncateToFit appended. Without this, the Phase-D drill-down hints
    // (main-landmark or top-3 collapsed containers) get silently trimmed
    // because they're non-interactive, which is the opposite of what we
    // want — the hint is the most important line for LLM recovery.
    const trailingNotes: string[] = [];
    const workLines = [...lines];
    while (workLines.length > 0) {
      const last = workLines[workLines.length - 1];
      if (last.trimStart().startsWith("Note:") || last.startsWith("\nNote:")) {
        trailingNotes.unshift(workLines.pop()!);
      } else {
        break;
      }
    }
    // Also pull the `... (truncated, N omitted)` marker so it stays at the
    // bottom after trimming the body.
    let truncationMarker: string | undefined;
    if (workLines.length > 0 && workLines[workLines.length - 1].startsWith("...")) {
      truncationMarker = workLines.pop();
    }

    // Reserve budget for the preserved trailing annotations — they are
    // small but the budget check must account for them.
    const notesText = [truncationMarker ?? "", ...trailingNotes].filter(Boolean).join("\n");
    const notesTokens = notesText ? estimateTokens(notesText + "\n") : 0;
    const effectiveBudget = Math.max(0, bodyBudgetTokens - notesTokens);

    // Separate interactive and content lines (same as before)
    const interactiveIndices = new Set<number>();
    for (let i = 0; i < workLines.length; i++) {
      const line = workLines[i];
      const roleMatch = line.match(/\[e\d+\]\s+(\S+)/);
      const role = roleMatch ? roleMatch[1] : "";
      if (INTERACTIVE_ROLES.has(role)) {
        interactiveIndices.add(i);
      }
    }

    // Try removing content lines from the end first
    const result = [...workLines];
    while (estimateTokens(result.join("\n")) > effectiveBudget && result.length > 0) {
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

    // Re-append the preserved annotations at the bottom.
    if (truncationMarker !== undefined) result.push(truncationMarker);
    for (const note of trailingNotes) result.push(note);
    return result;
  }

  /** Story 18.4: centralised visual annotation appender. Only emits the
   *  `[x,y WxH] click vis` (or `[hidden]`) suffix when filter === "visual".
   *  For other filters the visualMap is used solely for occlusion checks —
   *  its bounds/click/visible flags must NOT leak into the rendered output. */
  private appendVisualAnnotation(
    line: string,
    filter: string,
    visualMap: Map<number, VisualInfo> | undefined,
    backendNodeId: number,
  ): string {
    if (!visualMap || filter !== "visual") return line;
    const vi = visualMap.get(backendNodeId);
    if (vi && vi.bounds.w > 0 && vi.bounds.h > 0) {
      let annotated = `${line} [${vi.bounds.x},${vi.bounds.y} ${vi.bounds.w}x${vi.bounds.h}]`;
      if (vi.isClickable) annotated += " click";
      if (vi.isVisible) annotated += " vis";
      return annotated;
    }
    return `${line} [hidden]`;
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

    // Story 18.4: paint-order occlusion filter — same semantics as
    // renderNode. Skip the line but keep walking children so that
    // higher-z-index descendants remain visible.
    if (visualMap) {
      const vi = visualMap.get(node.backendDOMNodeId);
      if (vi?.occluded) {
        this.renderChildrenDownsampled(node, nodeMap, indentLevel, filter, lines, level, visualMap);
        return;
      }
    }

    // BUG-016: composite-key lookup via `_renderSessionId` set by getTree().
    const refNum = this.refLookup(node.backendDOMNodeId);
    if (refNum === undefined) {
      this.renderChildrenDownsampled(node, nodeMap, indentLevel, filter, lines, level, visualMap);
      return;
    }

    const indent = "  ".repeat(indentLevel);

    if (elementClass === "interactive") {
      // Interactive: ALWAYS fully preserved
      let line = this.formatLine(indent, refNum, role, node, nodeMap);
      line = this.appendVisualAnnotation(line, filter, visualMap, node.backendDOMNodeId);
      lines.push(line);
      this.renderChildrenDownsampled(node, nodeMap, indentLevel + 1, filter, lines, level, visualMap);
    } else if (elementClass === "content") {
      if (level < 4) {
        // Content at levels 0-3: unchanged
        let line = this.formatLine(indent, refNum, role, node, nodeMap);
        line = this.appendVisualAnnotation(line, filter, visualMap, node.backendDOMNodeId);
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
        line = this.appendVisualAnnotation(line, filter, visualMap, node.backendDOMNodeId);
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
        line = this.appendVisualAnnotation(line, filter, visualMap, node.backendDOMNodeId);
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
        line = this.appendVisualAnnotation(line, filter, visualMap, node.backendDOMNodeId);
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
        // BUG-019: include the ref in summary lines so landmark-aware
        // truncateToFit can still attribute downsampled subtrees to their
        // main/nav/other bucket AND so the escape-hint can point the LLM at
        // the exact ref to re-read for full detail.
        lines.push(`${indent}[e${refNum} ${shortRole}${nameStr}, ${childCount} items]`);

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
    // BUG-016: resolveRefFull returns owner session alongside backendNodeId
    // so subtree rendering can set `_renderSessionId` correctly. Without
    // this, renderNode's refLookup would miss every composite-key entry.
    const full = this.resolveRefFull(ref);
    if (!full) {
      const availableRefs = this.getAvailableRefsRange();
      const suggestion = this.suggestClosestRef(ref);
      let errorText = `Element ${ref} not found.`;
      if (availableRefs) errorText += ` Available refs: ${availableRefs}.`;
      if (suggestion) errorText += ` Did you mean ${suggestion}?`;
      throw new RefNotFoundError(errorText);
    }
    const backendId = full.backendNodeId;

    // Find the AXNode with this backendDOMNodeId
    const targetNode = nodes.find((n) => n.backendDOMNodeId === backendId);
    if (!targetNode) {
      throw new RefNotFoundError(`Element ${ref} not found in current tree.`);
    }

    const lines: string[] = [];
    this._renderSessionId = full.sessionId;
    try {
      this.renderNode(targetNode, nodeMap, 0, filter, lines, visualMap);
    } finally {
      this._renderSessionId = "";
    }

    const refCount = lines.length;
    const header = `Subtree for ${ref} — ${refCount} elements`;
    const text = header + "\n\n" + lines.join("\n");

    // H2: Apply downsampling when max_tokens is set and subtree exceeds budget
    if (maxTokens) {
      const currentTokens = estimateTokens(text);
      if (currentTokens > maxTokens) {
        // Downsample the subtree using the same pipeline.
        // BUG-016: propagate the owner session so the downsample render
        // pipeline uses the correct composite-key scope.
        this._renderSessionId = full.sessionId;
        const downsampled = this.downsampleSubtree(
          targetNode, nodeMap, filter, maxTokens, visualMap,
        );
        this._renderSessionId = "";
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

    // Ticket-1 global aggregation: suppressed members produce no line AND
    // no recursion — they are guaranteed leaves by prepareAggregateGroups.
    if (
      node.backendDOMNodeId !== undefined &&
      this._aggregateSuppressed?.has(node.backendDOMNodeId)
    ) {
      return;
    }
    // Anchor members emit the collapse summary at their position instead of
    // the normal formatLine output, then return (leaves have no children
    // worth rendering).
    if (node.backendDOMNodeId !== undefined) {
      const anchor = this._aggregateAnchors?.get(node.backendDOMNodeId);
      if (anchor) {
        this.emitAggregateLine(anchor, indentLevel, lines);
        return;
      }
    }

    // Story 18.4: paint-order occlusion filter. If this node is covered by
    // a higher-paintOrder clickable element, skip the line — but still
    // render children, because a child may itself have a higher paintOrder
    // (position: absolute + z-index: 999 on a button inside a covered
    // container is still clickable). See Dev Notes section "Warum Children
    // nicht automatisch ueberspringen".
    let isOccluded = false;
    if (visualMap && node.backendDOMNodeId !== undefined) {
      const vi = visualMap.get(node.backendDOMNodeId);
      if (vi?.occluded) isOccluded = true;
    }

    if (!isOccluded && passesFilter && node.backendDOMNodeId !== undefined) {
      // BUG-016: composite-key lookup via `_renderSessionId`.
      const refNum = this.refLookup(node.backendDOMNodeId);
      if (refNum !== undefined) {
        const indent = "  ".repeat(indentLevel);
        let line = this.formatLine(indent, refNum, role, node, nodeMap);
        // Story 18.4: appendVisualAnnotation is a no-op unless filter ===
        // "visual". Other filters use visualMap solely for occlusion info.
        line = this.appendVisualAnnotation(line, filter, visualMap, node.backendDOMNodeId);
        lines.push(line);
      }
    }

    // Always render children (even if this node didn't pass filter OR was
    // occluded). Story 18.4: when an occluded node is skipped we do NOT
    // advance the indent level — it mirrors the existing `node.ignored`
    // path above, so children inherit the position of the skipped parent.
    const nextIndent = (!isOccluded && passesFilter) ? indentLevel + 1 : indentLevel;
    this.renderChildren(node, nodeMap, nextIndent, filter, lines, visualMap);
  }

  /**
   * Ticket-1 / Token-Aggregation: minimum number of same-class leaf elements
   * inside the rendered subtree before they are collapsed into one summary
   * line at the first occurrence. Set to 10 so we never aggregate small or
   * medium lists (button bars, nav menus, dialog actions) but reliably catch
   * large generated lists like the 240-button benchmark page, even when they
   * are interleaved with headings/paragraphs/links.
   */
  private static readonly AGGREGATE_MIN_COUNT = 10;

  /**
   * Ticket-1: Per-render state built by {@link prepareAggregateGroups}. Keys
   * the first backendDOMNodeId of a ≥10-member aggregation bucket to the
   * info needed to emit the summary line. Null when no aggregation pass has
   * been executed (e.g. during subtree renders or tests that bypass getTree).
   */
  private _aggregateAnchors: Map<number, {
    count: number;
    role: string;
    firstName: string;
    lastName: string;
    firstRef: number;
    lastRef: number;
  }> | null = null;

  /**
   * Ticket-1: All non-first member backendDOMNodeIds for ≥10-member buckets.
   * renderNode skips any node whose backendDOMNodeId is in this set — the
   * line they would have produced is already covered by the anchor's
   * summary line.
   */
  private _aggregateSuppressed: Set<number> | null = null;

  /**
   * Ticket-1: Build a stable aggregation key for a leaf element. Two
   * sibling leaves share an aggregation class iff their keys are equal:
   *
   *   - Identical role.
   *   - Either an identical name (e.g. 50× "Submit") OR an identical
   *     name prefix once a trailing run of digits is stripped
   *     (e.g. "Action 1" / "Action 240" → key "button::Action ").
   *
   * Returns null when the element shouldn't participate in aggregation
   * (no role at all). Empty/missing names are treated as their own key
   * so unnamed buttons within a row still group together.
   */
  private aggregationKey(role: string, name: string): string | null {
    if (!role) return null;
    if (!name) return `${role}::`;
    const m = name.match(/^(.+?)(\d+)$/);
    if (m) return `${role}::${m[1]}`;
    return `${role}::${name}`;
  }

  /**
   * Ticket-1: A child is a "renderable leaf" for aggregation purposes if
   * it would emit exactly one line under the current filter and carries
   * no descendants that would also render. We only need to look one level
   * deep — text wrappers like <span> / <strong> inside a <button> are
   * either ignored or non-interactive and never produce their own line.
   */
  private isRenderableLeaf(
    node: AXNode,
    nodeMap: Map<string, AXNode>,
    filter: string,
  ): boolean {
    if (node.ignored) return false;
    if (node.backendDOMNodeId === undefined) return false;
    // BUG-016: composite-key existence check via `_renderSessionId`.
    if (!this.refExists(node.backendDOMNodeId)) return false;
    const role = this.getRole(node);
    if (!this.passesFilter(node, role, filter)) return false;
    if (!node.childIds || node.childIds.length === 0) return true;
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (!child || child.ignored) continue;
      if (child.backendDOMNodeId === undefined) continue;
      const childRole = this.getRole(child);
      if (this.passesFilter(child, childRole, filter)) {
        // The child would render its own line → parent is not a leaf.
        return false;
      }
    }
    return true;
  }

  /**
   * Ticket-1: Walk the renderable subtree (main + OOPIFs) and compute which
   * leaves should be collapsed into summary lines. Leaves are bucketed by
   * aggregation key; any bucket with ≥{@link AGGREGATE_MIN_COUNT} members
   * becomes a collapse group. The first member in DOM order becomes the
   * "anchor" (its position emits the summary line) and the rest land in
   * the suppressed set so renderNode skips them.
   *
   * This runs independently of the ≥10-consecutive-siblings assumption,
   * which is why it catches the T4.7 benchmark case where 120 "Action N"
   * buttons are interleaved with headings, paragraphs, and inputs inside
   * 60 sections that share a single DOM parent.
   */
  private prepareAggregateGroups(
    root: AXNode,
    nodeMap: Map<string, AXNode>,
    oopifSections: Array<{ url: string; nodes: AXNode[]; sessionId: string }>,
    filter: string,
  ): void {
    // BUG-016: Track which session each aggregated node belongs to so the
    // composite-keyed refMap can resolve its ref correctly. A single bucket
    // may legitimately span multiple sessions when they share the same
    // role+name signature — in that case we bail out of aggregation to keep
    // things simple (aggregation is a rendering optimization, not a
    // correctness requirement).
    type BucketEntry = { node: AXNode; sessionId: string };
    const buckets = new Map<string, BucketEntry[]>();

    const walk = (node: AXNode, map: Map<string, AXNode>, sid: string): void => {
      if (
        !node.ignored &&
        node.backendDOMNodeId !== undefined &&
        this.isRenderableLeaf(node, map, filter)
      ) {
        const role = this.getRole(node);
        const name = (node.name?.value as string | undefined) ?? "";
        const key = this.aggregationKey(role, name);
        if (key !== null) {
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = [];
            buckets.set(key, bucket);
          }
          bucket.push({ node, sessionId: sid });
          // Leaves by definition have no renderable descendants — skip recursion.
          return;
        }
      }
      if (node.childIds) {
        for (const childId of node.childIds) {
          const child = map.get(childId);
          if (child) walk(child, map, sid);
        }
      }
    };

    // Main frame walk — use the main render session set by getTree().
    walk(root, nodeMap, this._renderSessionId);
    for (const section of oopifSections) {
      const oopifMap = new Map<string, AXNode>();
      for (const n of section.nodes) oopifMap.set(n.nodeId, n);
      if (section.nodes.length > 0) walk(section.nodes[0], oopifMap, section.sessionId);
    }

    this._aggregateAnchors = new Map();
    this._aggregateSuppressed = new Set();
    for (const bucket of buckets.values()) {
      if (bucket.length < A11yTreeProcessor.AGGREGATE_MIN_COUNT) continue;
      // Skip mixed-session buckets — aggregation assumes a contiguous
      // ref-range, which mixed sessions cannot guarantee.
      const firstSid = bucket[0].sessionId;
      if (bucket.some((b) => b.sessionId !== firstSid)) continue;
      const first = bucket[0].node;
      const last = bucket[bucket.length - 1].node;
      const firstId = first.backendDOMNodeId!;
      const firstRef = this.refLookup(firstId, firstSid);
      const lastRef = this.refLookup(last.backendDOMNodeId!, firstSid);
      if (firstRef === undefined || lastRef === undefined) continue;
      this._aggregateAnchors.set(firstId, {
        count: bucket.length,
        role: this.getRole(first),
        firstName: (first.name?.value as string | undefined) ?? "",
        lastName: (last.name?.value as string | undefined) ?? "",
        firstRef,
        lastRef,
      });
      for (let i = 1; i < bucket.length; i++) {
        this._aggregateSuppressed.add(bucket[i].node.backendDOMNodeId!);
      }
    }
  }

  /** Reset the per-render aggregation state set up by prepareAggregateGroups. */
  private clearAggregateGroups(): void {
    this._aggregateAnchors = null;
    this._aggregateSuppressed = null;
  }

  /**
   * Ticket-1: Emit the summary line for a collapse-group anchor. Format is
   * intentionally compact and still carries the addressable ref band so the
   * LLM can click({ ref: "eN" }) on any individual element inside it.
   */
  private emitAggregateLine(
    anchor: { count: number; role: string; firstName: string; lastName: string; firstRef: number; lastRef: number },
    indentLevel: number,
    lines: string[],
  ): void {
    const indent = "  ".repeat(indentLevel);
    let line = `${indent}[e${anchor.firstRef}..e${anchor.lastRef}] ${anchor.count}× ${anchor.role}`;
    if (anchor.firstName && anchor.lastName && anchor.firstName !== anchor.lastName) {
      line += ` "${anchor.firstName}" .. "${anchor.lastName}"`;
    } else if (anchor.firstName) {
      line += ` "${anchor.firstName}"`;
    }
    lines.push(line);
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

  /** FR-022: Count content nodes with visible text that would be hidden by filter:interactive.
   *  Used to append a hint in read-page.ts that points the LLM at filter:'all' instead of evaluate. */
  private countHiddenContentNodes(
    root: AXNode,
    nodeMap: Map<string, AXNode>,
    oopifSections: Array<{ url: string; nodes: AXNode[]; sessionId: string }>,
  ): number {
    let count = 0;
    const walk = (node: AXNode, map: Map<string, AXNode>): void => {
      if (node.ignored) {
        // Still walk ignored children — they may wrap visible content
      } else {
        const role = (node.role?.value as string) ?? "";
        if (CONTENT_ROLES.has(role)) {
          const name = (node.name?.value as string | undefined) ?? "";
          // Only count nodes with actual visible text content
          if (name && name.trim().length > 0) {
            count++;
          }
        }
      }
      if (node.childIds) {
        for (const childId of node.childIds) {
          const child = map.get(childId);
          if (child) walk(child, map);
        }
      }
    };
    walk(root, nodeMap);
    for (const section of oopifSections) {
      const oopifNodeMap = new Map<string, AXNode>();
      for (const n of section.nodes) oopifNodeMap.set(n.nodeId, n);
      if (section.nodes.length > 0) walk(section.nodes[0], oopifNodeMap);
    }
    return count;
  }

  private getRole(node: AXNode): string {
    return (node.role?.value as string) ?? "";
  }

  private passesFilter(node: AXNode, role: string, filter: string): boolean {
    if (filter === "all") return true;
    if (filter === "landmark") return LANDMARK_ROLES.has(role);
    // interactive and visual filters use the same element selection
    if (INTERACTIVE_ROLES.has(role)) return true;
    // FR-005: Elements with onclick handlers (e.g. sortable table headers).
    // BUG-016 follow-up: session-scoped lookup via _renderSessionId.
    if (node.backendDOMNodeId !== undefined) {
      const info = this.nodeInfoLookup(node.backendDOMNodeId);
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
    // BUG-016 follow-up: all nodeInfoMap reads route through the
    // session-aware nodeInfoLookup so render output cannot bleed
    // metadata across OOPIFs with colliding backendNodeIds.
    const backendNodeId = node.backendDOMNodeId;
    const htmlId = backendNodeId !== undefined ? this.nodeInfoLookup(backendNodeId)?.htmlId : undefined;
    const idSuffix = htmlId ? `#${htmlId}` : "";

    // Story 18.8 Fix B: disabled state is promoted to a LEADING prefix
    // (before the ref/role) so a scanning LLM sees "cannot interact" as the
    // very first token of the element line. The old `(disabled)` suffix at
    // the end of the line was routinely overlooked — two benchmark runs
    // failed T4.4 because both LLMs typed into disabled inputs.
    let isDisabled = false;
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "disabled" && prop.value.value === true) {
          isDisabled = true;
          break;
        }
      }
    }
    const disabledPrefix = isDisabled ? DISABLED_PREFIX : "";
    let line = `${indent}${disabledPrefix}[e${refNum}] ${role}${idSuffix}`;

    // Story 18.8 Fix A: when the name was truncated, we track it here and
    // append the prominent marker on a SEPARATE line below — done once the
    // rest of the element annotations are in place.
    let truncationExtra: number | undefined;

    // FR-H5: Prefer AXNode name, fall back to nodeInfoMap (enriched by Phase 3 for clickable generics)
    const name = (node.name?.value as string | undefined)
      || (backendNodeId !== undefined ? this.nodeInfoLookup(backendNodeId)?.name : undefined);
    if (name) {
      line += ` "${name}"`;
      // FR-021: Signal truncation so the LLM knows hidden text exists (reached for evaluate otherwise)
      if (backendNodeId !== undefined) {
        const fullLen = this.nodeInfoLookup(backendNodeId)?.nameFullLength;
        if (fullLen && fullLen > name.length) {
          truncationExtra = fullLen - name.length;
        }
      }
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
    // FR-023: Same-origin iframe content is now inlined below as a "--- iframe: ... ---" section.
    // Only show the "use evaluate" hint for cross-origin iframes whose content couldn't be inlined.
    if (role === "Iframe") {
      line += " (content shown below)";
    }

    // FR-008: Canvas is opaque — direct LLM to use screenshot(som: true)
    if (role === "canvas" || role === "Canvas") {
      line += " ⚠ Canvas content is pixels, not DOM. Use screenshot(som: true) to see what's inside.";
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
        const linkInfo = this.nodeInfoLookup(backendNodeId);
        if (linkInfo?.linkTarget === "_blank") {
          line += " (opens new tab)";
        }
      }
    }

    // Story 18.8 Fix B: disabled state is emitted as a LEADING prefix above
    // (see `disabledPrefix` near the top of formatLine). No tail suffix.

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
    // FR-026: skip for textbox — textboxes are editable by definition, saves ~10 chars each
    if (role !== "textbox" && node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "editable" && prop.value.value && prop.value.value !== "inherit") {
          line += " (editable)";
          break;
        }
      }
    }

    // FR-001: scrollable container annotation
    if (backendNodeId !== undefined) {
      const scrollInfo = this.nodeInfoLookup(backendNodeId);
      if (scrollInfo?.isScrollable) {
        line += " (scrollable)";
      }
    }

    // Story 18.8 Fix A: emit the truncation hint as a SECOND physical line
    // under the element. The line starts with `[!] TRUNCATED` which is
    // high-contrast enough that a scanning LLM cannot mistake it for a
    // normal tree entry — and it restates the ref so the next-action is
    // self-contained even without re-scanning the parent line. Rendered
    // inline via `\n` because `lines.push(line)` later joins with `\n`
    // (see `lines.join("\n")` in renderNodes / truncateToFit).
    if (truncationExtra !== undefined) {
      line += `\n${indent}  ${TRUNCATION_MARKER_PREFIX}: +${truncationExtra} more chars hidden. Call read_page(ref:"e${refNum}", filter:"all") to read the full text.`;
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
    // BUG-016 follow-up: owner carries sessionId so nodeInfoLookup routes
    // to the correct session's metadata without cross-session bleed.
    const owner = this.reverseMap.get(refNum);
    if (!owner) return "static";
    const info = this.nodeInfoLookup(owner.backendNodeId, owner.sessionId);
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

    // BUG-016 follow-up: route through nodeInfoLookup so metadata is
    // session-scoped.
    for (const [refNum, owner] of sortedRefs) {
      const info = this.nodeInfoLookup(owner.backendNodeId, owner.sessionId);
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
    // BUG-016 follow-up: route through nodeInfoLookup so metadata is
    // session-scoped.
    for (const [refNum, owner] of this.reverseMap) {
      const info = this.nodeInfoLookup(owner.backendNodeId, owner.sessionId);
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

    // BUG-016 follow-up: session-scoped metadata lookup.
    for (const [refNum, owner] of sortedRefs) {
      const info = this.nodeInfoLookup(owner.backendNodeId, owner.sessionId);
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
        const remaining = sortedRefs.filter(([, o]) => INTERACTIVE_ROLES.has(this.nodeInfoLookup(o.backendNodeId, o.sessionId)?.role ?? "")).length - interactiveLines.length;
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
