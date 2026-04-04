import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import type { EscalationResult, CaptainDecision, CaptainEscalationConfig } from "./types.js";

/**
 * Captain — last-resort escalation to the MCP client (Agent/Human) when
 * neither Rule-Engine nor Micro-LLM can decide with sufficient confidence.
 *
 * Uses MCP Elicitation API (form mode) to present the escalation context
 * and collect a decision.
 */
export class Captain {
  constructor(
    private _server: Server,
    private _config: CaptainEscalationConfig,
  ) {}

  /**
   * Escalate to the Captain (MCP client) and wait for a decision.
   * Returns CaptainDecision on accept, null on decline/cancel/timeout.
   */
  async escalate(escalation: EscalationResult, screenshot?: string): Promise<CaptainDecision | null> {
    const message = this._buildEscalationMessage(escalation, screenshot);
    const requestedSchema = this._buildDecisionSchema();

    try {
      const result = await this._server.elicitInput(
        {
          mode: "form",
          message,
          requestedSchema,
        },
        {
          signal: AbortSignal.timeout(this._config.timeoutMs),
        },
      );

      if (result.action === "accept") {
        return this._parseDecision(result.content);
      }

      // decline or cancel → no decision
      return null;
    } catch {
      // Timeout (AbortError) or any other error → no decision
      return null;
    }
  }

  /** Format the escalation as a readable message for the MCP client/Captain. */
  _buildEscalationMessage(escalation: EscalationResult, screenshot?: string): string {
    const parts: string[] = [
      "OPERATOR ESCALATION — Step failed, decision required",
      "",
      `Tool: ${escalation.stepContext.tool}`,
      `Parameters: ${JSON.stringify(escalation.stepContext.params)}`,
      `Error: ${escalation.errorDescription}`,
      "",
      "Previous attempts:",
      `- Rule-Engine: no match`,
      `- Micro-LLM: ${escalation.reason}`,
    ];

    if (Object.keys(escalation.diagnosticContext).length > 0) {
      parts.push(`- Diagnostics: ${JSON.stringify(escalation.diagnosticContext)}`);
    }

    if (escalation.a11ySnippet) {
      parts.push("", "A11y context:", escalation.a11ySnippet);
    }

    if (screenshot) {
      parts.push("", "[Screenshot attached]");
    }

    return parts.join("\n");
  }

  /** Build the MCP Elicitation form schema for Captain decisions. */
  _buildDecisionSchema(): ElicitRequestFormParams["requestedSchema"] {
    return {
      type: "object" as const,
      properties: {
        decision_type: {
          type: "string" as const,
          title: "Decision",
          description: "What should the Operator do?",
          enum: [
            "use-alternative-ref",
            "use-selector",
            "skip-step",
            "retry-step",
            "retry-with-params",
            "abort-plan",
          ],
        },
        ref_or_selector: {
          type: "string" as const,
          title: "Ref or Selector",
          description: "Ref-ID or CSS selector (only for use-alternative-ref / use-selector)",
        },
        abort_reason: {
          type: "string" as const,
          title: "Abort Reason",
          description: "Reason for aborting (only for abort-plan)",
        },
      },
      required: ["decision_type"],
    };
  }

  /** Parse the elicitation result content into a CaptainDecision. */
  _parseDecision(content?: Record<string, string | number | boolean | string[]>): CaptainDecision | null {
    if (!content) return null;

    const decisionType = content.decision_type as string | undefined;
    if (!decisionType) return null;

    switch (decisionType) {
      case "use-alternative-ref": {
        const ref = content.ref_or_selector as string | undefined;
        if (!ref) return null;
        return { type: "use-alternative-ref", ref };
      }
      case "use-selector": {
        const selector = content.ref_or_selector as string | undefined;
        if (!selector) return null;
        return { type: "use-selector", selector };
      }
      case "skip-step":
        return { type: "skip-step" };
      case "retry-step":
        return { type: "retry-step" };
      case "retry-with-params":
        // retry-with-params requires structured params — not expressible via flat form,
        // so treat as retry-step (safe fallback)
        return { type: "retry-step" };
      case "abort-plan": {
        const reason = (content.abort_reason as string) || "Aborted by Captain";
        return { type: "abort-plan", reason };
      }
      default:
        return null;
    }
  }
}

/**
 * Null-object implementation used when Elicitation is not supported by the MCP client.
 * escalate() always returns null (timeout behavior).
 */
export class NullCaptain {
  async escalate(_escalation: EscalationResult, _screenshot?: string): Promise<CaptainDecision | null> {
    return null;
  }
}

/** Captain interface for dependency injection / testing */
export interface CaptainProvider {
  escalate(escalation: EscalationResult, screenshot?: string): Promise<CaptainDecision | null>;
}
