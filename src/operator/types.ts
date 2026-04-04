import type { ToolResponse, ToolContentBlock } from "../types.js";

// --- Rule Definitions ---

export interface Rule {
  condition: RuleCondition;
  action: RuleAction;
  priority: number; // higher number = higher priority
}

export type RuleCondition =
  | { type: "element-visible"; ref: string }
  | { type: "element-not-found"; ref?: string }
  | { type: "dialog-present"; dialogType?: "alert" | "confirm" | "prompt" | "beforeunload" }
  | { type: "always" };

export type RuleAction =
  | { type: "click"; ref: string }
  | { type: "scroll-to"; ref: string; maxAttempts?: number }
  | { type: "dismiss-dialog" }
  | { type: "accept-dialog" }
  | { type: "skip-step" }
  | { type: "fail-step"; reason: string };

export interface RuleMatch {
  rule: Rule;
  confidence: 1.0; // Rule-Engine is always deterministic
}

// --- Step Context ---

export interface StepContext {
  tool: string;
  params: Record<string, unknown>;
  error?: Error;
  /** Tool returned isError response (not thrown exception) */
  isErrorResponse?: boolean;
  /** Text from isError response content */
  errorText?: string;
  dialogPresent?: {
    type: "alert" | "confirm" | "prompt" | "beforeunload";
    message: string;
  };
  retryCount: number;
}

// --- Operator Results ---

export interface OperatorStepResult {
  step: number;
  tool: string;
  result: ToolResponse;
  rulesApplied: Array<{ condition: string; action: string }>;
  scrollAttempts: number;
  dialogsHandled: number;
}

export interface OperatorPlanResult {
  steps: OperatorStepResult[];
  stepsTotal: number;
  stepsCompleted: number;
  totalRulesApplied: number;
  totalDialogsHandled: number;
  aborted: boolean;
  elapsedMs: number;
}
