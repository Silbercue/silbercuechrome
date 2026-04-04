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
  microLlmUsed: boolean;
  microLlmCalled: boolean;
  microLlmLatencyMs?: number;
  microLlmConfidence?: number;
  escalationNeeded?: boolean;
  /** Structured escalation data for the Captain (Story 8.3) */
  escalation?: EscalationResult;
  /** Captain decision if escalation was resolved by Captain */
  captainDecision?: CaptainDecision;
  /** Step was skipped due to a conditional (Story 6.4) */
  skipped?: boolean;
  /** The condition expression that caused the skip (Story 6.4) */
  condition?: string;
}

export interface OperatorPlanResult {
  steps: OperatorStepResult[];
  stepsTotal: number;
  stepsCompleted: number;
  totalRulesApplied: number;
  totalDialogsHandled: number;
  /** Count of ALL Micro-LLM invocations (including timeout, low-confidence) */
  totalMicroLlmCalls: number;
  totalEscalations: number;
  /** Detailed escalation records (Story 8.3) */
  escalations: EscalationRecord[];
  aborted: boolean;
  elapsedMs: number;
}

// --- Micro-LLM Definitions ---

export interface MicroLlmProvider {
  /** Trifft eine Mikro-Entscheidung basierend auf A11y-Kontext und Step-Info */
  decide(request: MicroLlmRequest): Promise<MicroLlmResponse>;
  /** Prueft ob der Provider verfuegbar ist (Ollama laeuft, Modell geladen) */
  isAvailable(): Promise<boolean>;
}

export interface MicroLlmRequest {
  /** Kompakter A11y-Tree-Ausschnitt (~500 Tokens) */
  a11ySnippet: string;
  /** Welches Tool + welche Params versucht wurden */
  stepContext: { tool: string; params: Record<string, unknown> };
  /** Fehlerbeschreibung (warum Rule-Engine nicht griff) */
  errorDescription: string;
  /** Moegliche Aktionen die das LLM waehlen kann */
  possibleActions: MicroLlmAction[];
}

export type MicroLlmAction =
  | { type: "click-alternative"; description: string }
  | { type: "type-alternative"; description: string }
  | { type: "dismiss-element"; description: string }
  | { type: "scroll-direction"; direction: "up" | "down" | "left" | "right" }
  | { type: "wait"; durationMs: number }
  | { type: "skip-step" }
  | { type: "fail-step"; reason: string };

export interface MicroLlmResponse {
  action: MicroLlmAction;
  /** Alternativer Ref-String wenn das LLM einen vorschlaegt */
  alternativeRef?: string;
  /** Konfidenz-Score 0.0-1.0 */
  confidence: number;
  /** Latenz der LLM-Inferenz in ms */
  latencyMs: number;
}

export interface MicroLlmConfig {
  endpoint: string;          // z.B. "http://localhost:11434" (Ollama)
  model: string;             // z.B. "qwen2.5:3b" oder "phi3:mini"
  timeoutMs: number;         // Default: 500
  minConfidence: number;     // Default: 0.6 — darunter Eskalation
}

export interface EscalationResult {
  type: "escalation-needed";
  reason: "micro-llm-unavailable" | "micro-llm-low-confidence" | "no-recovery-possible";
  stepContext: { tool: string; params: Record<string, unknown> };
  errorDescription: string;
  a11ySnippet?: string;
  /** Alles was der Captain braeuchte um eine Entscheidung zu treffen */
  diagnosticContext: Record<string, unknown>;
}

// --- Captain Definitions (Story 8.3) ---

export type CaptainDecision =
  | { type: "use-alternative-ref"; ref: string }
  | { type: "use-selector"; selector: string }
  | { type: "skip-step" }
  | { type: "retry-step" }
  | { type: "retry-with-params"; params: Record<string, unknown> }
  | { type: "abort-plan"; reason: string };

export interface EscalationRecord {
  stepNumber: number;
  escalation: EscalationResult;
  decision: CaptainDecision | null; // null = Timeout or Decline
  elapsedMs: number;
}

export interface CaptainEscalationConfig {
  enabled: boolean;          // Default: true wenn MCP Elicitation verfuegbar
  timeoutMs: number;         // Default: 30000
  includeScreenshot: boolean; // Default: false (Token-schwergewichtig)
}
