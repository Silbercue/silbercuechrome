import type { ToolResponse } from "../types.js";
import type { LicenseStatus } from "../license/license-status.js";
import type { PlanStep, ErrorStrategy } from "../plan/plan-executor.js";
import type { VarsMap } from "../plan/plan-variables.js";
import type { CdpClient } from "../cdp/cdp-client.js";

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

/** Erweiterungspunkte fuer Pro-Features. */
export interface ProHooks {
  /** Prueft ob ein Tool im aktuellen Lizenz-Tier ausfuehrbar ist. */
  featureGate?: (toolName: string) => { allowed: boolean; message?: string };
  /** Modifiziert Tool-Parameter vor der Ausfuehrung. Null = keine Aenderung. */
  enhanceTool?: (toolName: string, params: Record<string, unknown>) => Record<string, unknown> | null;
  /** Modifiziert die Tool-Response nach der Ausfuehrung. */
  onToolResult?: (toolName: string, result: ToolResponse) => ToolResponse;
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
