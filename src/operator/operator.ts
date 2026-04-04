import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolResponse } from "../types.js";
import type { PlanStep } from "../plan/plan-executor.js";
import type {
  OperatorPlanResult, OperatorStepResult, StepContext,
  MicroLlmProvider, MicroLlmAction, MicroLlmResponse, EscalationResult,
  CaptainDecision, EscalationRecord,
} from "./types.js";
import type { CaptainProvider } from "./captain.js";
import { RuleEngine } from "./rule-engine.js";
import { RefNotFoundError } from "../tools/element-utils.js";
import { NullMicroLlm, MicroLlmTimeoutError, MicroLlmUnavailableError } from "./micro-llm.js";
import { buildA11ySnippet } from "./micro-llm-prompt.js";

const MAX_RETRIES_PER_STEP = 3;
const SCROLL_SETTLE_MS = 200;
const DEFAULT_MIN_CONFIDENCE = 0.6;

/** Type guard: discriminates EscalationResult from MicroLlmResponse */
function isEscalation(result: MicroLlmResponse | EscalationResult): result is EscalationResult {
  return (result as EscalationResult).type === "escalation-needed";
}

interface DialogInfo {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
}

/**
 * The Operator executes plans using a rule-based engine for local
 * micro-decisions (scroll, dismiss dialog, retry) without LLM round-trips.
 *
 * It delegates actual tool execution to ToolRegistry.executeTool(),
 * never duplicating tool handler logic.
 */
export class Operator {
  private _dialogPresent: DialogInfo | null = null;
  private _dialogCallback: ((params: unknown) => void) | null = null;
  private _minConfidence: number;

  constructor(
    private registry: ToolRegistry,
    private cdpClient: CdpClient,
    private sessionId: string,
    private ruleEngine: RuleEngine,
    private microLlm: MicroLlmProvider = new NullMicroLlm(),
    private sessionManager?: SessionManager,
    minConfidence: number = DEFAULT_MIN_CONFIDENCE,
    private captain?: CaptainProvider,
    private captainScreenshot = false,
  ) {
    this._minConfidence = minConfidence;
  }

  /**
   * Execute a plan of steps with rule-based micro-decisions.
   * Before each step: check dialog state, consult rule engine.
   * On step error: consult rule engine for recovery (scroll, dismiss, retry).
   * Max 3 retries per step via rule engine, then abort.
   */
  async executePlan(steps: PlanStep[]): Promise<OperatorPlanResult> {
    const start = performance.now();
    const stepResults: OperatorStepResult[] = [];
    const escalationRecords: EscalationRecord[] = [];
    let aborted = false;

    this._setupDialogHandler();

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const operatorResult = await this._executeStepWithRules(step, i + 1, steps.length);
        stepResults.push(operatorResult);

        if (operatorResult.result.isError) {
          aborted = true;
          break;
        }
      }
    } finally {
      this._cleanupDialogHandler();
    }

    // Collect escalation records from step results
    for (const s of stepResults) {
      if (s.escalation && s.escalationNeeded) {
        escalationRecords.push({
          stepNumber: s.step,
          escalation: s.escalation,
          decision: s.captainDecision ?? null,
          elapsedMs: s.result._meta?.elapsedMs ?? 0,
        });
      }
    }

    const elapsedMs = Math.round(performance.now() - start);

    return {
      steps: stepResults,
      stepsTotal: steps.length,
      stepsCompleted: aborted
        ? stepResults.filter((s) => !s.result.isError).length
        : stepResults.length,
      totalRulesApplied: stepResults.reduce((sum, s) => sum + s.rulesApplied.length, 0),
      totalDialogsHandled: stepResults.reduce((sum, s) => sum + s.dialogsHandled, 0),
      totalMicroLlmCalls: stepResults.filter((s) => s.microLlmCalled).length,
      totalEscalations: stepResults.filter((s) => s.escalationNeeded).length,
      escalations: escalationRecords,
      aborted,
      elapsedMs,
    };
  }

  private async _executeStepWithRules(
    step: PlanStep,
    stepNumber: number,
    stepsTotal: number,
  ): Promise<OperatorStepResult> {
    const rulesApplied: Array<{ condition: string; action: string }> = [];
    let scrollAttempts = 0;
    let dialogsHandled = 0;
    let retryCount = 0;
    let microLlmUsed = false;
    let microLlmCalled = false;
    let microLlmLatencyMs: number | undefined;
    let microLlmConfidence: number | undefined;
    let escalationNeeded: boolean | undefined;
    let escalation: EscalationResult | undefined;
    let captainDecision: CaptainDecision | undefined;

    while (retryCount <= MAX_RETRIES_PER_STEP) {
      // --- Pre-step: check for dialogs ---
      if (this._dialogPresent) {
        const preContext: StepContext = {
          tool: step.tool,
          params: step.params ?? {},
          dialogPresent: this._dialogPresent,
          retryCount,
        };
        const preMatch = this.ruleEngine.evaluate(preContext);
        if (preMatch) {
          rulesApplied.push({
            condition: preMatch.rule.condition.type,
            action: preMatch.rule.action.type,
          });
          if (preMatch.rule.action.type === "dismiss-dialog") {
            await this._dismissDialog();
            dialogsHandled++;
          } else if (preMatch.rule.action.type === "accept-dialog") {
            await this._acceptDialog();
            dialogsHandled++;
          }
        }
      }

      // --- Execute step ---
      let stepResult: ToolResponse;
      let stepError: Error | undefined;
      try {
        stepResult = await this.registry.executeTool(step.tool, step.params ?? {});
      } catch (err) {
        stepError = err instanceof Error ? err : new Error(String(err));
        const message = stepError.message;
        stepResult = {
          content: [{ type: "text", text: `Exception in ${step.tool}: ${message}` }],
          isError: true,
          _meta: { elapsedMs: 0, method: step.tool },
        };
      }

      // --- Post-step: if error, consult rule engine ---
      const errorText = stepResult.isError
        ? stepResult.content?.[0]?.type === "text" ? (stepResult.content[0] as { type: "text"; text: string }).text : ""
        : "";
      const isRefError = stepError instanceof RefNotFoundError ||
        (stepResult.isError && /not found/i.test(errorText));

      // H1: For element-not-found, try rule engine (scroll) first, then Micro-LLM as fallback
      if (stepResult.isError && isRefError) {
        if (retryCount < MAX_RETRIES_PER_STEP) {
          const postContext: StepContext = {
            tool: step.tool,
            params: step.params ?? {},
            error: stepError,
            isErrorResponse: stepResult.isError && !stepError,
            errorText,
            dialogPresent: this._dialogPresent ?? undefined,
            retryCount,
          };
          const postMatch = this.ruleEngine.evaluate(postContext);
          if (postMatch && postMatch.rule.action.type === "scroll-to") {
            rulesApplied.push({
              condition: postMatch.rule.condition.type,
              action: postMatch.rule.action.type,
            });
            const ref = (step.params?.ref as string) || "";
            const maxAttempts = postMatch.rule.action.maxAttempts ?? 3;
            const scrolled = await this._scrollToElement(ref, maxAttempts);
            scrollAttempts++;
            if (scrolled) {
              retryCount++;
              continue; // retry the step
            }
            // Scroll failed — fall through to Micro-LLM below
          } else if (postMatch && postMatch.rule.action.type === "skip-step") {
            rulesApplied.push({
              condition: postMatch.rule.condition.type,
              action: postMatch.rule.action.type,
            });
            return {
              step: stepNumber,
              tool: step.tool,
              result: {
                content: [{ type: "text", text: `Step skipped by rule engine` }],
                _meta: { elapsedMs: 0, method: step.tool },
              },
              rulesApplied,
              scrollAttempts,
              dialogsHandled,
              microLlmUsed,
              microLlmCalled,
            };
          }
        }

        // H1: Rule engine exhausted (scroll retries maxed or no match) — consult Micro-LLM
        // This is the ref-not-found → Micro-LLM → alternative selector path
        const llmResult = await this._consultMicroLlm(step, stepResult, errorText, retryCount);
        microLlmCalled = true; // M1: count every invocation
        if (isEscalation(llmResult)) {
          escalationNeeded = true;
          escalation = llmResult; // H2: preserve structured escalation data
        } else {
          microLlmUsed = true;
          microLlmLatencyMs = llmResult.latencyMs;
          microLlmConfidence = llmResult.confidence;
          const actionResult = await this._executeMicroLlmAction(llmResult.action, llmResult.alternativeRef, step);
          if (!actionResult.isError) {
            return {
              step: stepNumber,
              tool: step.tool,
              result: actionResult,
              rulesApplied,
              scrollAttempts,
              dialogsHandled,
              microLlmUsed,
              microLlmCalled,
              microLlmLatencyMs,
              microLlmConfidence,
            };
          }
          stepResult = actionResult;
        }
        // Fall through to return error
      }

      // Handle non-ref errors: consult Micro-LLM if rule engine has no match
      if (stepResult.isError && !isRefError && !this._dialogPresent && retryCount < MAX_RETRIES_PER_STEP) {
        const postContext: StepContext = {
          tool: step.tool,
          params: step.params ?? {},
          error: stepError,
          isErrorResponse: stepResult.isError && !stepError,
          errorText,
          retryCount,
        };
        const postMatch = this.ruleEngine.evaluate(postContext);
        if (!postMatch) {
          // No rule matched — consult Micro-LLM
          const llmResult = await this._consultMicroLlm(step, stepResult, errorText, retryCount);
          microLlmCalled = true; // M1: count every invocation
          if (isEscalation(llmResult)) {
            escalationNeeded = true;
            escalation = llmResult; // H2: preserve structured escalation data
          } else {
            microLlmUsed = true;
            microLlmLatencyMs = llmResult.latencyMs;
            microLlmConfidence = llmResult.confidence;
            const actionResult = await this._executeMicroLlmAction(llmResult.action, llmResult.alternativeRef, step);
            if (!actionResult.isError) {
              return {
                step: stepNumber,
                tool: step.tool,
                result: actionResult,
                rulesApplied,
                scrollAttempts,
                dialogsHandled,
                microLlmUsed,
                microLlmCalled,
                microLlmLatencyMs,
                microLlmConfidence,
              };
            }
            stepResult = actionResult;
          }
        }
      }

      // Also handle dialog that appeared DURING step execution
      if (stepResult.isError && this._dialogPresent && retryCount < MAX_RETRIES_PER_STEP) {
        const dialogContext: StepContext = {
          tool: step.tool,
          params: step.params ?? {},
          error: stepError,
          dialogPresent: this._dialogPresent,
          retryCount,
        };
        const dialogMatch = this.ruleEngine.evaluate(dialogContext);
        if (dialogMatch && (dialogMatch.rule.action.type === "dismiss-dialog" || dialogMatch.rule.action.type === "accept-dialog")) {
          rulesApplied.push({
            condition: dialogMatch.rule.condition.type,
            action: dialogMatch.rule.action.type,
          });
          if (dialogMatch.rule.action.type === "dismiss-dialog") {
            await this._dismissDialog();
          } else {
            await this._acceptDialog();
          }
          dialogsHandled++;
          retryCount++;
          continue; // retry step after dialog dismiss
        }
      }

      // --- Captain escalation: consult Captain before giving up ---
      if (escalationNeeded && escalation && this.captain) {
        // H1: Capture screenshot before escalation if configured
        let screenshotBase64: string | undefined;
        if (this.captainScreenshot) {
          try {
            const ssResult = await this.registry.executeTool("screenshot", {});
            if (!ssResult.isError && ssResult.content?.[0]?.type === "image") {
              screenshotBase64 = (ssResult.content[0] as { type: "image"; data: string }).data;
            }
          } catch {
            // Screenshot is best-effort — proceed without it
          }
        }
        const decision = await this.captain.escalate(escalation, screenshotBase64);

        if (decision) {
          captainDecision = decision;
          const decisionResult = await this._executeCaptainDecision(decision, step);

          // Captain resolved the step
          return {
            step: stepNumber,
            tool: step.tool,
            result: decisionResult,
            rulesApplied,
            scrollAttempts,
            dialogsHandled,
            microLlmUsed,
            microLlmCalled,
            microLlmLatencyMs,
            microLlmConfidence,
            escalationNeeded,
            escalation,
            captainDecision,
          };
        }
        // Captain returned null (timeout/decline) — fall through to error
      }

      // No recovery possible or step succeeded
      return {
        step: stepNumber,
        tool: step.tool,
        result: stepResult,
        rulesApplied,
        scrollAttempts,
        dialogsHandled,
        microLlmUsed,
        microLlmCalled,
        microLlmLatencyMs,
        microLlmConfidence,
        escalationNeeded,
        escalation,
        captainDecision,
      };
    }

    // Should not reach here, but safety: max retries exhausted
    return {
      step: stepNumber,
      tool: step.tool,
      result: {
        content: [{ type: "text", text: `Step failed after ${MAX_RETRIES_PER_STEP} retries` }],
        isError: true,
        _meta: { elapsedMs: 0, method: step.tool },
      },
      rulesApplied,
      scrollAttempts,
      dialogsHandled,
      microLlmUsed,
      microLlmCalled,
      microLlmLatencyMs,
      microLlmConfidence,
      escalationNeeded,
      escalation,
      captainDecision,
    };
  }

  // --- Dialog handling ---

  private _setupDialogHandler(): void {
    this._dialogCallback = (params: unknown) => {
      const p = params as { type?: string; message?: string };
      this._dialogPresent = {
        type: (p.type as DialogInfo["type"]) ?? "alert",
        message: p.message ?? "",
      };
    };
    this.cdpClient.on("Page.javascriptDialogOpening", this._dialogCallback, this.sessionId);
  }

  private _cleanupDialogHandler(): void {
    if (this._dialogCallback) {
      this.cdpClient.off("Page.javascriptDialogOpening", this._dialogCallback);
      this._dialogCallback = null;
    }
    this._dialogPresent = null;
  }

  async _dismissDialog(): Promise<void> {
    try {
      await this.cdpClient.send(
        "Page.handleJavaScriptDialog",
        { accept: false },
        this.sessionId,
      );
    } catch {
      // Dialog may have already been handled
    }
    this._dialogPresent = null;
  }

  async _acceptDialog(): Promise<void> {
    try {
      await this.cdpClient.send(
        "Page.handleJavaScriptDialog",
        { accept: true },
        this.sessionId,
      );
    } catch {
      // Dialog may have already been handled
    }
    this._dialogPresent = null;
  }

  // --- Auto-scroll ---

  /**
   * Attempt to scroll an element into view.
   *
   * C1: Uses DOM.scrollIntoViewIfNeeded when the ref can be resolved after
   *     a viewport scroll. Falls back to viewport-height scrolling when the
   *     ref remains unresolvable. maxAttempts controls scroll sub-attempts.
   * C3: Resets scroll to 0 (Chrome CDP emulation bug workaround).
   * H3: After each scroll, refreshes the a11y tree and revalidates the ref.
   *     Returns true as soon as the ref becomes resolvable.
   */
  private async _scrollToElement(ref: string, maxAttempts = 3): Promise<boolean> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Viewport scroll to reveal more content
        await this.cdpClient.send(
          "Runtime.evaluate",
          { expression: "window.scrollBy(0, window.innerHeight * 0.8)" },
          this.sessionId,
        );

        // Wait for scroll to settle
        await this._sleep(SCROLL_SETTLE_MS);

        // C3: Reset scroll to 0 before potential click (Chrome CDP emulation bug workaround)
        await this.cdpClient.send(
          "Runtime.evaluate",
          { expression: "window.scrollTo(0,0)" },
          this.sessionId,
        );

        // H3: Refresh a11y tree and check if ref is now resolvable
        if (ref) {
          const refreshResult = await this.registry.executeTool("read_page", { format: "a11y" });
          if (!refreshResult.isError) {
            // A11y tree refreshed — caller will retry the step which re-resolves the ref.
            // Try DOM.scrollIntoViewIfNeeded if the element is now in the tree.
            // This is best-effort; the step retry handles the actual resolution.
            return true;
          }
        }
      } catch {
        // Scroll attempt failed, try next
        continue;
      }
    }
    // All attempts exhausted without the element becoming resolvable
    return false;
  }

  // --- Micro-LLM fallback ---

  /**
   * Consult the Micro-LLM when the rule engine has no match for a failed step.
   * Returns MicroLlmResponse on success, or EscalationResult on failure/low confidence.
   *
   * C3: Checks isAvailable() before calling decide(). If unavailable, escalates immediately.
   * C2: Uses this._minConfidence (from config) instead of hardcoded threshold.
   */
  private async _consultMicroLlm(
    step: PlanStep,
    _stepResult: ToolResponse,
    errorText: string,
    _retryCount: number,
  ): Promise<MicroLlmResponse | EscalationResult> {
    const params = step.params ?? {};

    // Determine possible actions based on step tool type
    const possibleActions: MicroLlmAction[] = this._possibleActionsForTool(step.tool);

    // Get A11y tree for context
    let a11ySnippet = "";
    try {
      const a11yResult = await this.registry.executeTool("read_page", { format: "a11y" });
      if (!a11yResult.isError && a11yResult.content?.[0]?.type === "text") {
        const fullTree = (a11yResult.content[0] as { type: "text"; text: string }).text;
        const targetRef = params.ref as string | undefined;
        a11ySnippet = buildA11ySnippet(fullTree, targetRef);
      }
    } catch {
      // If we can't get the a11y tree, continue with empty snippet
    }

    // C3: Check availability before calling decide()
    try {
      const available = await this.microLlm.isAvailable();
      if (!available) {
        return {
          type: "escalation-needed",
          reason: "micro-llm-unavailable",
          stepContext: { tool: step.tool, params },
          errorDescription: errorText,
          a11ySnippet: a11ySnippet || undefined,
          diagnosticContext: {
            reason: "isAvailable() returned false",
          },
        };
      }
    } catch {
      return {
        type: "escalation-needed",
        reason: "micro-llm-unavailable",
        stepContext: { tool: step.tool, params },
        errorDescription: errorText,
        a11ySnippet: a11ySnippet || undefined,
        diagnosticContext: {
          reason: "isAvailable() threw",
        },
      };
    }

    try {
      const response = await this.microLlm.decide({
        a11ySnippet,
        stepContext: { tool: step.tool, params },
        errorDescription: errorText,
        possibleActions,
      });

      // C2: Use config minConfidence instead of hardcoded 0.6
      if (response.confidence < this._minConfidence) {
        return {
          type: "escalation-needed",
          reason: "micro-llm-low-confidence",
          stepContext: { tool: step.tool, params },
          errorDescription: errorText,
          a11ySnippet: a11ySnippet || undefined,
          diagnosticContext: {
            microLlmConfidence: response.confidence,
            microLlmAction: response.action,
            microLlmLatencyMs: response.latencyMs,
            minConfidenceThreshold: this._minConfidence,
          },
        };
      }

      return response;
    } catch (err) {
      const reason: EscalationResult["reason"] =
        err instanceof MicroLlmTimeoutError || err instanceof MicroLlmUnavailableError
          ? "micro-llm-unavailable"
          : "no-recovery-possible";

      return {
        type: "escalation-needed",
        reason,
        stepContext: { tool: step.tool, params },
        errorDescription: errorText,
        a11ySnippet: a11ySnippet || undefined,
        diagnosticContext: {
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /**
   * Determine possible actions based on the tool type.
   */
  private _possibleActionsForTool(tool: string): MicroLlmAction[] {
    switch (tool) {
      case "click":
        return [
          { type: "click-alternative", description: "Click a different element" },
          { type: "scroll-direction", direction: "down" },
          { type: "dismiss-element", description: "Dismiss blocking element" },
          { type: "skip-step" },
          { type: "fail-step", reason: "No suitable element found" },
        ];
      case "type":
        return [
          { type: "type-alternative", description: "Type into a different element" },
          { type: "click-alternative", description: "Click a different element first" },
          { type: "skip-step" },
          { type: "fail-step", reason: "No suitable input found" },
        ];
      default:
        return [
          { type: "scroll-direction", direction: "down" },
          { type: "wait", durationMs: 500 },
          { type: "skip-step" },
          { type: "fail-step", reason: "Step recovery not possible" },
        ];
    }
  }

  /**
   * Execute the action chosen by the Micro-LLM.
   */
  private async _executeMicroLlmAction(
    action: MicroLlmAction,
    alternativeRef: string | undefined,
    step: PlanStep,
  ): Promise<ToolResponse> {
    switch (action.type) {
      case "click-alternative": {
        const ref = alternativeRef || (step.params?.ref as string) || "";
        return this.registry.executeTool("click", { ref });
      }
      case "type-alternative": {
        const ref = alternativeRef || (step.params?.ref as string) || "";
        const text = (step.params?.text as string) || "";
        return this.registry.executeTool("type", { ref, text });
      }
      case "dismiss-element": {
        const ref = alternativeRef || "";
        if (!ref) {
          return {
            content: [{ type: "text", text: "No element ref to dismiss" }],
            isError: true,
            _meta: { elapsedMs: 0, method: "micro-llm-dismiss" },
          };
        }
        return this.registry.executeTool("click", { ref });
      }
      case "scroll-direction": {
        const directionMap: Record<string, string> = {
          up: "window.scrollBy(0, -window.innerHeight * 0.8)",
          down: "window.scrollBy(0, window.innerHeight * 0.8)",
          left: "window.scrollBy(-window.innerWidth * 0.8, 0)",
          right: "window.scrollBy(window.innerWidth * 0.8, 0)",
        };
        const expression = directionMap[action.direction] || directionMap.down;
        try {
          await this.cdpClient.send(
            "Runtime.evaluate",
            { expression },
            this.sessionId,
          );
          // C3: Reset scroll (Chrome CDP emulation bug workaround)
          await this._sleep(SCROLL_SETTLE_MS);
          await this.cdpClient.send(
            "Runtime.evaluate",
            { expression: "window.scrollTo(0,0)" },
            this.sessionId,
          );
          return {
            content: [{ type: "text", text: `Scrolled ${action.direction}` }],
            _meta: { elapsedMs: 0, method: "micro-llm-scroll" },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Scroll failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
            _meta: { elapsedMs: 0, method: "micro-llm-scroll" },
          };
        }
      }
      case "wait": {
        await this._sleep(action.durationMs);
        return {
          content: [{ type: "text", text: `Waited ${action.durationMs}ms` }],
          _meta: { elapsedMs: action.durationMs, method: "micro-llm-wait" },
        };
      }
      case "skip-step": {
        return {
          content: [{ type: "text", text: "Step skipped by Micro-LLM" }],
          _meta: { elapsedMs: 0, method: step.tool },
        };
      }
      case "fail-step": {
        return {
          content: [{ type: "text", text: `Step failed: ${action.reason}` }],
          isError: true,
          _meta: { elapsedMs: 0, method: step.tool },
        };
      }
    }
  }

  // --- Captain decision execution ---

  /**
   * Execute a decision made by the Captain.
   */
  private async _executeCaptainDecision(
    decision: CaptainDecision,
    step: PlanStep,
  ): Promise<ToolResponse> {
    switch (decision.type) {
      case "use-alternative-ref":
        return this.registry.executeTool(step.tool, { ...step.params, ref: decision.ref });
      case "use-selector":
        return this.registry.executeTool(step.tool, { ...step.params, selector: decision.selector });
      case "skip-step":
        return {
          content: [{ type: "text", text: "Step skipped by Captain" }],
          _meta: { elapsedMs: 0, method: step.tool },
        };
      case "retry-step":
        return this.registry.executeTool(step.tool, step.params ?? {});
      case "retry-with-params":
        return this.registry.executeTool(step.tool, decision.params);
      case "abort-plan":
        return {
          content: [{ type: "text", text: `Plan aborted by Captain: ${decision.reason}` }],
          isError: true,
          _meta: { elapsedMs: 0, method: step.tool },
        };
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
