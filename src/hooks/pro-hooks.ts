import type { ToolResponse } from "../types.js";
import type { LicenseStatus } from "../license/license-status.js";
import type { PlanStep, ErrorStrategy } from "../plan/plan-executor.js";
import type { VarsMap } from "../plan/plan-variables.js";

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
