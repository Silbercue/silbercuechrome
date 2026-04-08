import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { wrapCdpError } from "./error-utils.js";
import { a11yTree } from "../cache/a11y-tree.js";

// --- Schema (Task 2) ---

export const typeSchema = z.object({
  ref: z
    .string()
    .optional()
    .describe("Element reference from read_page (e.g. 'e12') — preferred over selector"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector as fallback (e.g. 'input[name=email]')"),
  text: z
    .string()
    .describe("Text to type into the element"),
  clear: z
    .boolean()
    .optional()
    .default(false)
    .describe("Clear existing field content before typing (default: false)"),
});

export type TypeParams = z.infer<typeof typeSchema>;

/**
 * Story 16.5: Optional human-type callback injected via the `enhanceTool`
 * Pro-Hook. When present, this replaces the raw `Input.insertText` with a
 * realistic per-character typing sequence from the Pro-Repo Human Touch
 * module. The Free-Repo itself does NOT contain any Human-Touch logic.
 */
export type HumanTypeFn = (
  cdpClient: CdpClient,
  sessionId: string,
  text: string,
) => Promise<void>;

// --- Constants ---

const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** FR-023: Emit a fill_form hint after this many consecutive type calls within the window. */
const FILL_FORM_HINT_THRESHOLD = 2;
/** FR-023: Time window (ms) in which consecutive type calls are considered "in the same form session". */
const FILL_FORM_HINT_WINDOW_MS = 10_000;

// --- Helpers ---

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

// --- FR-023: Session-scoped detector for consecutive type calls ---
// Tracks recent type calls per CDP session so we can hint at fill_form
// when the LLM is filling multiple fields via single type calls.
interface TypeStreakState {
  count: number;
  lastAt: number;
  hintShown: boolean;
}
const typeStreaks = new Map<string, TypeStreakState>();

/** Exported for unit tests — clears the streak state. */
export function _resetTypeStreaks(): void {
  typeStreaks.clear();
}

function recordTypeCallAndMaybeHint(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const now = Date.now();
  const existing = typeStreaks.get(sessionId);
  if (existing && now - existing.lastAt <= FILL_FORM_HINT_WINDOW_MS) {
    existing.count += 1;
    existing.lastAt = now;
    if (existing.count >= FILL_FORM_HINT_THRESHOLD && !existing.hintShown) {
      existing.hintShown = true;
      return `\n\nTip: ${existing.count} consecutive type calls in ${Math.round(FILL_FORM_HINT_WINDOW_MS / 1000)}s — next time try fill_form({ fields: [...] }) for one-round-trip form fills. It handles text inputs, <select>, checkbox, and radio natively, so you don't need evaluate or separate click calls.`;
    }
    return null;
  }
  typeStreaks.set(sessionId, { count: 1, lastAt: now, hintShown: false });
  return null;
}

// --- Main handler ---

export async function typeHandler(
  params: TypeParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

  // Story 16.5: Extract optional humanType callback injected by the
  // `enhanceTool` Pro-Hook. The field is NOT part of the Zod schema — it is
  // read from the raw params map via type-guard and stripped from the params
  // object before downstream code uses it.
  const rawParams = params as unknown as Record<string, unknown>;
  const maybeHuman = rawParams.humanType;
  const humanType: HumanTypeFn | undefined =
    typeof maybeHuman === "function" ? (maybeHuman as HumanTypeFn) : undefined;
  if ("humanType" in rawParams) {
    const { humanType: _humanType, ...rest } = rawParams;
    void _humanType;
    params = rest as unknown as TypeParams;
  }

  // Validation: require text parameter (defensive — Zod enforces this at schema level,
  // but handler may be called directly without schema parsing)
  if (params.text === undefined || params.text === null) {
    return {
      content: [
        {
          type: "text",
          text: "type requires a 'text' parameter",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "type" },
    };
  }

  // Validation: require at least ref or selector
  if (!params.ref && !params.selector) {
    return {
      content: [
        {
          type: "text",
          text: "type requires either 'ref' or 'selector' to identify the target element",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "type" },
    };
  }

  try {
    // Step 1: Resolve element (ref preferred over selector, with OOPIF routing)
    const target = params.ref ? { ref: params.ref } : { selector: params.selector };
    const element = await resolveElement(cdpClient, sessionId!, target, sessionManager);
    const targetSession = element.resolvedSessionId;

    // Step 2: Role check — only for ref-resolved elements (CSS path skips check)
    if (element.resolvedVia === "ref" && element.role && !INPUT_ROLES.has(element.role)) {
      const elapsedMs = Math.round(performance.now() - start);
      return {
        content: [
          {
            type: "text",
            text: `Element ${params.ref} is not a text input (role: ${element.role}). Expected textbox, searchbox, combobox, or spinbutton.`,
          },
        ],
        isError: true,
        _meta: { elapsedMs, method: "type" },
      };
    }

    // Step 3: Focus the element (use resolved session for OOPIF)
    // Try DOM.focus first, fall back to JS this.focus() for Shadow-DOM/post-mutation nodes (BUG-006)
    try {
      await cdpClient.send(
        "DOM.focus",
        { backendNodeId: element.backendNodeId },
        targetSession,
      );
    } catch {
      // Fallback: JS focus via Runtime.callFunctionOn (handles Shadow-DOM and stale backendNodeIds)
      try {
        await cdpClient.send(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: "function() { this.focus(); }",
            objectId: element.objectId,
            silent: true,
          },
          targetSession,
        );
      } catch {
        const elapsedMs = Math.round(performance.now() - start);
        return {
          content: [
            {
              type: "text",
              text: `Could not focus element ${params.ref ?? params.selector}. Element may be hidden or not focusable.`,
            },
          ],
          isError: true,
          _meta: { elapsedMs, method: "type" },
        };
      }
    }

    // Step 4: Clear field if requested (use resolved session for OOPIF)
    if (params.clear) {
      await cdpClient.send(
        "Runtime.callFunctionOn",
        {
          objectId: element.objectId,
          functionDeclaration:
            "function() { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }",
          returnByValue: true,
        },
        targetSession,
      );
    }

    // Step 5: Insert text (use resolved session for OOPIF — no auto-settle)
    // Story 16.5: If humanType callback is injected, delegate to it.
    if (params.text.length > 0) {
      if (humanType) {
        await humanType(cdpClient, targetSession, params.text);
      } else {
        await cdpClient.send("Input.insertText", { text: params.text }, targetSession);
      }
    }

    // Step 6: Success response
    const elapsedMs = Math.round(performance.now() - start);
    const displayName = element.name
      ? `${element.role} '${element.name}'`
      : (params.ref ?? params.selector);
    // FR-023: Emit fill_form hint once per streak when the LLM makes consecutive type calls
    const fillFormHint = recordTypeCallAndMaybeHint(sessionId) ?? "";
    return {
      content: [
        {
          type: "text",
          text: `Typed "${truncate(params.text, 50)}" into ${displayName}${fillFormHint}`,
        },
      ],
      _meta: { elapsedMs, method: "type", cleared: params.clear, elementClass: params.ref ? a11yTree.classifyRef(params.ref) : "clickable" },
    };
  } catch (err) {
    // RefNotFoundError — contextual error with input-field alternatives
    if (err instanceof RefNotFoundError && params.ref) {
      const errorText = buildRefNotFoundError(params.ref, INPUT_ROLES);
      return {
        content: [{ type: "text", text: errorText }],
        isError: true,
        _meta: { elapsedMs: 0, method: "type" },
      };
    }

    // Generic error
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "type") }],
      isError: true,
      _meta: { elapsedMs, method: "type" },
    };
  }
}
