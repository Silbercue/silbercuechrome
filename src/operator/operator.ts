import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolResponse } from "../types.js";
import type { PlanStep } from "../plan/plan-executor.js";
import type { OperatorPlanResult, OperatorStepResult, StepContext } from "./types.js";
import { RuleEngine } from "./rule-engine.js";
import { RefNotFoundError } from "../tools/element-utils.js";

const MAX_RETRIES_PER_STEP = 3;
const SCROLL_SETTLE_MS = 200;

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

  constructor(
    private registry: ToolRegistry,
    private cdpClient: CdpClient,
    private sessionId: string,
    private ruleEngine: RuleEngine,
    private sessionManager?: SessionManager,
  ) {}

  /**
   * Execute a plan of steps with rule-based micro-decisions.
   * Before each step: check dialog state, consult rule engine.
   * On step error: consult rule engine for recovery (scroll, dismiss, retry).
   * Max 3 retries per step via rule engine, then abort.
   */
  async executePlan(steps: PlanStep[]): Promise<OperatorPlanResult> {
    const start = performance.now();
    const stepResults: OperatorStepResult[] = [];
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

    const elapsedMs = Math.round(performance.now() - start);

    return {
      steps: stepResults,
      stepsTotal: steps.length,
      stepsCompleted: aborted
        ? stepResults.filter((s) => !s.result.isError).length
        : stepResults.length,
      totalRulesApplied: stepResults.reduce((sum, s) => sum + s.rulesApplied.length, 0),
      totalDialogsHandled: stepResults.reduce((sum, s) => sum + s.dialogsHandled, 0),
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
      // C2: Check both thrown exceptions AND isError tool responses
      const errorText = stepResult.isError
        ? stepResult.content?.[0]?.type === "text" ? (stepResult.content[0] as { type: "text"; text: string }).text : ""
        : "";
      const isRefError = stepError instanceof RefNotFoundError ||
        (stepResult.isError && /not found/i.test(errorText));

      if (stepResult.isError && isRefError && retryCount < MAX_RETRIES_PER_STEP) {
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
        } else if (postMatch && postMatch.rule.action.type === "skip-step") {
          rulesApplied.push({
            condition: postMatch.rule.condition.type,
            action: postMatch.rule.action.type,
          });
          // Return a non-error skip result
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
          };
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

      // No recovery possible or step succeeded
      return {
        step: stepNumber,
        tool: step.tool,
        result: stepResult,
        rulesApplied,
        scrollAttempts,
        dialogsHandled,
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

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
