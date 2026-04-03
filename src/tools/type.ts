import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";

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

// --- Constants ---

const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

// --- Helpers ---

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

// --- Main handler ---

export async function typeHandler(
  params: TypeParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

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
    try {
      await cdpClient.send(
        "DOM.focus",
        { backendNodeId: element.backendNodeId },
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
    if (params.text.length > 0) {
      await cdpClient.send("Input.insertText", { text: params.text }, targetSession);
    }

    // Step 6: Success response
    const elapsedMs = Math.round(performance.now() - start);
    const displayName = element.name
      ? `${element.role} '${element.name}'`
      : (params.ref ?? params.selector);
    return {
      content: [
        {
          type: "text",
          text: `Typed "${truncate(params.text, 50)}" into ${displayName}`,
        },
      ],
      _meta: { elapsedMs, method: "type", cleared: params.clear },
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
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `type failed: ${message}` }],
      isError: true,
      _meta: { elapsedMs, method: "type" },
    };
  }
}
