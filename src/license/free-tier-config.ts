/**
 * Free-Tier configuration.
 * Story 9.1: Configurable limits for free-tier usage.
 */
export interface FreeTierConfig {
  /** Maximum number of steps allowed in a single run_plan call (Free Tier) */
  runPlanLimit: number;
}

export const DEFAULT_FREE_TIER_CONFIG: FreeTierConfig = {
  runPlanLimit: 3,
};

/**
 * Load FreeTierConfig from environment variables with fallback to defaults.
 * Env: SILBERCUECHROME_FREE_TIER_RUN_PLAN_LIMIT (positive integer)
 */
export function loadFreeTierConfig(): FreeTierConfig {
  const raw = process.env.SILBERCUECHROME_FREE_TIER_RUN_PLAN_LIMIT;
  if (raw === undefined || raw === "") {
    return { ...DEFAULT_FREE_TIER_CONFIG };
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ...DEFAULT_FREE_TIER_CONFIG };
  }
  return { runPlanLimit: parsed };
}
