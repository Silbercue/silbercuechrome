import type { Rule, RuleMatch, StepContext } from "./types.js";
import { RefNotFoundError } from "../tools/element-utils.js";

/**
 * Deterministic rule engine for the Operator.
 * Evaluates conditions against the current step context
 * and returns the highest-priority matching rule.
 */
export class RuleEngine {
  private _rules: Rule[] = [];

  constructor() {
    // Default rules (sorted by priority descending during evaluate)
    this._rules = [
      // Rule 1 (Prio 100): Dismiss unexpected dialogs
      {
        condition: { type: "dialog-present" },
        action: { type: "dismiss-dialog" },
        priority: 100,
      },
      // Rule 2 (Prio 50): Auto-scroll when element not found
      {
        condition: { type: "element-not-found" },
        action: { type: "scroll-to", ref: "", maxAttempts: 3 },
        priority: 50,
      },
    ];
  }

  /**
   * Evaluate the current step context against all rules.
   * Returns the highest-priority matching rule, or null if none match.
   */
  evaluate(context: StepContext): RuleMatch | null {
    // Sort by priority descending (highest first)
    const sorted = [...this._rules].sort((a, b) => b.priority - a.priority);

    for (const rule of sorted) {
      if (this._matches(rule, context)) {
        return { rule, confidence: 1.0 as 1.0 };
      }
    }
    return null;
  }

  /**
   * Add a custom rule. Rules are evaluated by priority (highest first).
   */
  addRule(rule: Rule): void {
    this._rules.push(rule);
  }

  /**
   * Remove all rules matching the given condition type.
   */
  removeRule(conditionType: string): void {
    this._rules = this._rules.filter((r) => r.condition.type !== conditionType);
  }

  /**
   * Return a read-only snapshot of current rules.
   */
  getRules(): readonly Rule[] {
    return [...this._rules];
  }

  private _matches(rule: Rule, context: StepContext): boolean {
    const cond = rule.condition;

    switch (cond.type) {
      case "dialog-present":
        if (!context.dialogPresent) return false;
        // If dialogType is specified, must match
        if (cond.dialogType && cond.dialogType !== context.dialogPresent.type) return false;
        return true;

      case "element-not-found": {
        // Match thrown RefNotFoundError exception
        const thrownRefError = context.error instanceof RefNotFoundError;
        // Match isError tool response containing "not found" (real production path)
        const isErrorRefNotFound =
          context.isErrorResponse === true &&
          !!context.errorText &&
          /not found/i.test(context.errorText);
        if (!thrownRefError && !isErrorRefNotFound) return false;
        // If ref is specified in condition, must match the ref in params
        if (cond.ref && cond.ref !== context.params.ref) return false;
        return true;
      }

      case "element-visible":
        // Element is visible when there's no error and tool is a click/type action
        if (context.error) return false;
        if (!context.params.ref) return false;
        // If ref is specified in condition, must match
        if (cond.ref && cond.ref !== context.params.ref) return false;
        return true;

      case "always":
        return true;

      default:
        return false;
    }
  }
}
