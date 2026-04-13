import type { ToolResponse } from "../types.js";
import type { LicenseStatus } from "../license/license-status.js";
import type { PlanStep, ErrorStrategy } from "../plan/plan-executor.js";
import type { VarsMap } from "../plan/plan-variables.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ElementClassification, SnapshotMap, DOMChange } from "../cache/a11y-tree.js";

/**
 * Story 15.2: Minimales Public-Interface, das das Pro-Repo verwendet,
 * um zusaetzliche MCP-Tools zu registrieren. Dependency Inversion — das
 * Pro-Repo muss nicht die volle `ToolRegistry`-Klasse kennen.
 */
export interface ToolRegistryPublic {
  /**
   * Registriert ein neues MCP-Tool in der Free-Repo-Registry.
   * Wird vom Pro-Repo ueber den `registerProTools`-Hook aufgerufen.
   */
  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (
      params: Record<string, unknown>,
      sessionIdOverride?: string,
    ) => Promise<ToolResponse>,
  ): void;

  /** Story 16.4: CDP-Client fuer Pro-Tool-Handler (z.B. inspect_element). */
  readonly cdpClient: CdpClient;
  /** Story 16.4: Aktuelle SessionId — aendert sich bei Tab-Wechsel/Reconnect. */
  readonly sessionId: string;
  /** Story 16.4: SessionManager fuer OOPIF-Support (optional). */
  readonly sessionManager?: SessionManager;
}

/**
 * Story 15.3: Public-Interface fuer den a11yTree-Cache.
 * Das Pro-Repo verwendet diese Methoden im onToolResult-Hook fuer die
 * 3-Stufen-Klick-Analyse (classifyRef → waitForAXChange → diffSnapshots → formatDomDiff).
 *
 * `diffSnapshots` und `formatDomDiff` sind logisch Static-Methoden des
 * Tree-Processors, werden aber ZUSAETZLICH hier exponiert, damit das Pro-Repo
 * die gesamte 3-Stufen-Analyse ueber ein einziges `context.a11yTree`-Objekt
 * fahren kann (siehe AC #5).
 */
export interface A11yTreePublic {
  /** Klassifiziert ein Ref (widget-state/clickable/disabled/static). 0 CDP-Calls. */
  classifyRef(ref: string): ElementClassification;
  /** Leichtgewichtiger Snapshot fuer DOM-Diff. 0 CDP-Calls. */
  getSnapshotMap(): SnapshotMap;
  /** Compact Snapshot mit Headings/Alerts/Interaktiven Elementen. 0 CDP-Calls. */
  getCompactSnapshot(maxTokens?: number): string | null;
  /** Haelt den Tree frisch — liest via CDP Accessibility.getFullAXTree. */
  refreshPrecomputed(client: CdpClient, sessionId: string, manager?: SessionManager): Promise<void>;
  /** Setzt den Cache zurueck (bei Navigate oder SPA-Route-Wechsel). */
  reset(): void;
  /** Aktuelle URL des letzten Refreshs — fuer Diff-Header. */
  readonly currentUrl: string;
  /** Berechnet den Diff zweier Snapshots (delegiert an A11yTreeProcessor). */
  diffSnapshots(before: SnapshotMap, after: SnapshotMap): DOMChange[];
  /** Formatiert einen Diff als LLM-taugliche Kontextzeile. */
  formatDomDiff(changes: DOMChange[], url?: string): string | null;
  /**
   * FR-022 (P3 fix): Refs whose owning backendNodeId was still present in
   * the AX tree at the most recent `refreshPrecomputed()` pass. The default
   * `onToolResult` hook uses this to recognise REMOVED nodes — `reverseMap`
   * itself never evicts old refs (so the LLM can keep stale refs around to
   * react to them), so the diff logic needs an independent "still alive"
   * signal. Returns an empty set if no refresh has run since the last reset.
   */
  getActiveRefs(): Set<number>;
}

/**
 * Story 15.3: Public-Interface fuer die Static-Methoden des Tree-Processors.
 * `diffSnapshots` und `formatDomDiff` sind Static-Methoden auf `A11yTreeProcessor`;
 * sie werden als separates Objekt im Hook-Context uebergeben, um die Instance-API
 * (`A11yTreePublic`) sauber getrennt zu halten.
 *
 * Hinweis: Die gleichen Methoden sind auch direkt auf `A11yTreePublic`
 * verfuegbar — `A11yTreeDiffs` bleibt als Backward-Compat-Alias erhalten.
 */
export interface A11yTreeDiffs {
  diffSnapshots(before: SnapshotMap, after: SnapshotMap): DOMChange[];
  formatDomDiff(changes: DOMChange[], url?: string): string | null;
}

/** Erweiterungspunkte fuer Pro-Features. */
export interface ProHooks {
  /** Prueft ob ein Tool im aktuellen Lizenz-Tier ausfuehrbar ist. */
  featureGate?: (toolName: string) => { allowed: boolean; message?: string };
  /** Modifiziert Tool-Parameter vor der Ausfuehrung. Null = keine Aenderung. */
  enhanceTool?: (toolName: string, params: Record<string, unknown>) => Record<string, unknown> | null;
  /**
   * Story 15.3: Modifiziert die Tool-Response nach der Ausfuehrung —
   * zentrales Ambient-Context-Enrichment-Hook. Async + Context-Parameter.
   *
   * Breaking Change gegenueber der alten Sync-Signatur `(name, result) => ToolResponse`.
   * Der Pro-Repo implementiert hier die 3-Stufen-Klick-Analyse
   * (classifyRef → waitForAXChange → diffSnapshots → formatDomDiff).
   */
  onToolResult?: (
    toolName: string,
    result: ToolResponse,
    context: {
      a11yTree: A11yTreePublic;
      a11yTreeDiffs: A11yTreeDiffs;
      waitForAXChange?: (timeoutMs: number) => Promise<boolean>;
      cdpClient: CdpClient;
      sessionId: string;
      sessionManager?: SessionManager;
    },
  ) => Promise<ToolResponse>;
  /** Liefert den LicenseStatus — Pro-Repo injiziert hier den LicenseValidator. */
  provideLicenseStatus?: () => Promise<LicenseStatus>;
  /** Pro-Repo registriert hier die Multi-Tab-Parallel-Engine (Story 15.4). */
  executeParallel?: (
    groups: Array<{ tab: string; steps: PlanStep[] }>,
    registryFactory: (tabTargetId: string) => Promise<{
      executeTool: (name: string, params: Record<string, unknown>) => Promise<ToolResponse>;
    }>,
    options?: { vars?: VarsMap; errorStrategy?: ErrorStrategy; concurrencyLimit?: number },
  ) => Promise<ToolResponse>;
  /**
   * Story 15.2: Pro-Repo registriert hier zusaetzliche MCP-Tools
   * (z.B. inspect_element). Wird einmalig waehrend
   * `ToolRegistry.registerAll()` aufgerufen.
   */
  registerProTools?: (registry: ToolRegistryPublic) => void;
  /**
   * Story 15.2: Pro-Repo modifiziert das evaluate-Result fuer
   * Visual Feedback (Geometry-Diff + Clip-Screenshot). Wird nur
   * fuer erfolgreiche Eval-Calls aufgerufen.
   */
  enhanceEvaluateResult?: (
    expression: string,
    result: ToolResponse,
    context: { cdpClient: CdpClient; sessionId?: string },
  ) => Promise<ToolResponse>;
}

let _hooks: ProHooks = {};

/** Registriert Pro-Hook-Implementierungen. Aufgerufen vom Pro-Repo vor startServer(). */
export function registerProHooks(hooks: ProHooks): void {
  _hooks = hooks;
}

/** Gibt die aktuell registrierten Hooks zurueck. */
export function getProHooks(): ProHooks {
  return _hooks;
}

/**
 * Warm, marketing-oriented error messages for Pro-gated tools.
 *
 * A Free-tier user is likely to hit these as their first point of contact
 * (virtual_desk is listed first in the workflow instruction, so the LLM
 * tends to call it immediately). Each message therefore follows the same
 * three-line structure: (1) a short sentence that explains what the Pro
 * tool actually does, (2) the Free alternative so the LLM can keep
 * working without hitting a dead end, (3) a clear upgrade pointer.
 *
 * All messages are English — they are consumed by the LLM (which then
 * translates for the end user as needed) and must stay consistent with
 * the rest of the MCP tool descriptions, which are English throughout.
 *
 * The generic fallback at the bottom covers non-tool Pro flags such as
 * `parallel` and `use_operator` from run_plan — those are internal
 * feature flags, not user-facing tools, and do not need marketing prose.
 */
const PRO_FEATURE_MESSAGES: Record<string, string> = {
  virtual_desk: [
    "virtual_desk (Pro) — shows all open Chrome windows and tabs at a glance: window layout, tab IDs for switch_tab, which tab is active, and the state of each tab. Ideal for keeping track of multi-tab workflows.",
    "Free: use tab_status for URL / title / state of the active tab.",
    "Upgrade: silbercuechrome license activate <key>",
  ].join("\n\n"),
  switch_tab: [
    "switch_tab (Pro) — open, switch between, or close tabs without disturbing the active page. Perfect for clean multi-tab workflows.",
    "Free: use navigate(url) — it reuses the active tab instead.",
    "Upgrade: silbercuechrome license activate <key>",
  ].join("\n\n"),
  dom_snapshot: [
    "dom_snapshot (Pro) — full DOM tree snapshot with every attribute and computed style for deep page inspection.",
    "Free: use view_page (accessibility tree, ~10-30x cheaper) — it covers most use cases.",
    "Upgrade: silbercuechrome license activate <key>",
  ].join("\n\n"),
  observe: [
    "observe (Pro) — watch DOM elements for changes in real time using MutationObserver + polling. Essential for testing and monitoring dynamic content.",
    "Free: use wait_for to wait for a specific condition instead.",
    "Upgrade: silbercuechrome license activate <key>",
  ].join("\n\n"),
  console_logs: [
    "console_logs (Pro) — retrieve and filter browser console output (errors, warnings, logs). Essential for debugging web applications.",
    "Free: use evaluate('console.log(...)') to log values, but retrieval of existing console output requires Pro.",
    "Upgrade: silbercuechrome license activate <key>",
  ].join("\n\n"),
  network_monitor: [
    "network_monitor (Pro) — monitor, capture and filter network requests and responses. Essential for API debugging and performance analysis.",
    "Free: use wait_for('network_idle') to wait for network activity to settle.",
    "Upgrade: silbercuechrome license activate <key>",
  ].join("\n\n"),
};

/** Unified Pro-feature error response. */
export function proFeatureError(toolName: string): ToolResponse {
  const text =
    PRO_FEATURE_MESSAGES[toolName] ??
    `${toolName} is a Pro feature — activate with 'silbercuechrome license activate <key>'`;
  return {
    content: [{ type: "text", text }],
    isError: true,
    _meta: { elapsedMs: 0, method: toolName },
  };
}
