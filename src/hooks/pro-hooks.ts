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

/** Einheitliche Pro-Feature Error-Response. */
export function proFeatureError(toolName: string): ToolResponse {
  return {
    content: [{ type: "text", text: `${toolName} ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'` }],
    isError: true,
    _meta: { elapsedMs: 0, method: toolName },
  };
}
