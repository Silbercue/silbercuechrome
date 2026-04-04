import { randomUUID } from "node:crypto";
import type { PlanStep, StepResult, ErrorStrategy } from "./plan-executor.js";
import type { VarsMap } from "./plan-variables.js";

export interface SuspendedPlanState {
  planId: string;
  steps: PlanStep[];
  /** Index des Steps an dem der Plan pausiert wurde (naechster auszufuehrender Step) */
  suspendedAtIndex: number;
  vars: VarsMap;
  errorStrategy: ErrorStrategy;
  completedResults: StepResult[];
  question: string;
  createdAt: number;
}

export class PlanStateStore {
  private store = new Map<string, SuspendedPlanState>();
  private readonly ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /** Suspend speichert den Plan-State und gibt eine planId zurueck */
  suspend(state: Omit<SuspendedPlanState, "planId" | "createdAt">): string {
    this.cleanup();
    const planId = randomUUID();
    this.store.set(planId, {
      ...state,
      planId,
      createdAt: Date.now(),
    });
    return planId;
  }

  /** Resume laedt und entfernt den Plan-State. Gibt null zurueck wenn abgelaufen oder nicht gefunden. */
  resume(planId: string): SuspendedPlanState | null {
    this.cleanup();
    const state = this.store.get(planId);
    if (!state) {
      return null;
    }
    // TTL check (>= so that TTL=0 expires immediately)
    if (Date.now() - state.createdAt >= this.ttlMs) {
      this.store.delete(planId);
      return null;
    }
    this.store.delete(planId);
    return state;
  }

  /** Bereinigt abgelaufene Eintraege (aufgerufen bei suspend) */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, state] of this.store) {
      if (now - state.createdAt >= this.ttlMs) {
        this.store.delete(id);
      }
    }
  }
}
