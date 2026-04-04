export interface SessionDefaultsOptions {
  promoteThreshold?: number;  // Default: 3 — Anzahl identischer Calls bevor Vorschlag
  slidingWindowSize?: number; // Default: 10 — letzte N Calls fuer Auto-Promote
}

export interface PromoteSuggestion {
  param: string;       // z.B. "tab"
  value: unknown;      // z.B. "tab-abc123"
  count: number;       // Wie oft hintereinander verwendet
  tool: string;        // Welches Tool den Param nutzte
}

export class SessionDefaults {
  private _defaults: Map<string, unknown>;
  private _callHistory: Array<{ tool: string; params: Record<string, unknown> }>;
  private _promoteThreshold: number;
  private _slidingWindowSize: number;
  private _pendingSuggestions: PromoteSuggestion[];

  constructor(options?: SessionDefaultsOptions) {
    this._defaults = new Map();
    this._callHistory = [];
    this._promoteThreshold = options?.promoteThreshold ?? 3;
    this._slidingWindowSize = options?.slidingWindowSize ?? 10;
    this._pendingSuggestions = [];
  }

  // --- Default-Verwaltung ---

  setDefault(param: string, value: unknown): void {
    if (value === null) {
      this._defaults.delete(param);
    } else {
      this._defaults.set(param, value);
    }
  }

  getDefault(param: string): unknown | undefined {
    return this._defaults.get(param);
  }

  getAllDefaults(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this._defaults) {
      result[key] = value;
    }
    return result;
  }

  clearAll(): void {
    this._defaults.clear();
    this._callHistory = [];
    this._pendingSuggestions = [];
  }

  // --- Default-Resolution (Kernmethode) ---

  resolveParams(tool: string, params: Record<string, unknown>): Record<string, unknown> {
    const resolved = { ...params };
    for (const [key, defaultValue] of this._defaults) {
      if (resolved[key] === undefined) {
        resolved[key] = defaultValue;
      }
    }
    return resolved;
  }

  // --- Auto-Promote-Tracking ---

  trackCall(tool: string, params: Record<string, unknown>): void {
    this._callHistory.push({ tool, params });
    // Front-trunc: keep only the last _slidingWindowSize entries
    if (this._callHistory.length > this._slidingWindowSize) {
      this._callHistory = this._callHistory.slice(-this._slidingWindowSize);
    }
    this._analyzeForPromotions();
  }

  getSuggestions(): PromoteSuggestion[] {
    return [...this._pendingSuggestions];
  }

  applyAllSuggestions(): Record<string, unknown> {
    const applied: Record<string, unknown> = {};
    for (const suggestion of this._pendingSuggestions) {
      this.setDefault(suggestion.param, suggestion.value);
      applied[suggestion.param] = suggestion.value;
    }
    this._pendingSuggestions = [];
    return applied;
  }

  // --- Private ---

  private _analyzeForPromotions(): void {
    // Collect all param names from the call history
    const paramNames = new Set<string>();
    for (const call of this._callHistory) {
      for (const key of Object.keys(call.params)) {
        paramNames.add(key);
      }
    }

    const newSuggestions: PromoteSuggestion[] = [];

    for (const param of paramNames) {
      // Skip if already a default
      if (this._defaults.has(param)) continue;

      // Count consecutive identical values from the END of the history
      let count = 0;
      let lastValue: unknown = undefined;
      let lastTool = "";

      for (let i = this._callHistory.length - 1; i >= 0; i--) {
        const call = this._callHistory[i];
        const value = call.params[param];

        // Skip calls that don't have this param
        if (value === undefined) break;

        // Only compare primitives (string, number, boolean)
        if (typeof value === "object" || typeof value === "function" || typeof value === "symbol") break;

        if (count === 0) {
          lastValue = value;
          lastTool = call.tool;
          count = 1;
        } else if (value === lastValue) {
          count++;
        } else {
          break;
        }
      }

      if (count >= this._promoteThreshold) {
        newSuggestions.push({
          param,
          value: lastValue,
          count,
          tool: lastTool,
        });
      }
    }

    // Merge new suggestions into pending (update count for existing param, add new ones)
    for (const newSugg of newSuggestions) {
      const existingIdx = this._pendingSuggestions.findIndex((s) => s.param === newSugg.param);
      if (existingIdx >= 0) {
        this._pendingSuggestions[existingIdx] = newSugg;
      } else {
        this._pendingSuggestions.push(newSugg);
      }
    }

    // Remove suggestions for params that dropped below threshold or changed value
    this._pendingSuggestions = this._pendingSuggestions.filter(
      (s) => newSuggestions.some((n) => n.param === s.param),
    );
  }
}
