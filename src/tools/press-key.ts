import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";

// --- Schema ---

export const pressKeySchema = z.object({
  key: z
    .string()
    .describe("Key to press — e.g. 'Enter', 'Escape', 'Tab', 'a', 'ArrowDown', 'F1'. For printable characters use the character itself."),
  ref: z
    .string()
    .optional()
    .describe("Element ref to focus before pressing key (e.g. 'e5')"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector to focus before pressing key (e.g. '#search-input')"),
  modifiers: z
    .array(z.enum(["ctrl", "shift", "alt", "meta"]))
    .optional()
    .describe("Modifier keys to hold during key press (e.g. ['ctrl', 'shift'] for Ctrl+Shift+key)"),
});

export type PressKeyParams = z.infer<typeof pressKeySchema>;

// --- Key definitions ---

interface KeyDef {
  code: string;
  keyCode: number;
  text?: string;
}

const SPECIAL_KEYS: Record<string, KeyDef> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { code: "Space", keyCode: 32, text: " " },
  " ": { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  F1: { code: "F1", keyCode: 112 },
  F2: { code: "F2", keyCode: 113 },
  F3: { code: "F3", keyCode: 114 },
  F4: { code: "F4", keyCode: 115 },
  F5: { code: "F5", keyCode: 116 },
  F6: { code: "F6", keyCode: 117 },
  F7: { code: "F7", keyCode: 118 },
  F8: { code: "F8", keyCode: 119 },
  F9: { code: "F9", keyCode: 120 },
  F10: { code: "F10", keyCode: 121 },
  F11: { code: "F11", keyCode: 122 },
  F12: { code: "F12", keyCode: 123 },
};

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
};

/** Resolve a key string to its CDP key definition */
export function resolveKey(key: string): { key: string; def: KeyDef } {
  // Special key (Enter, Escape, etc.)
  if (SPECIAL_KEYS[key]) {
    return { key, def: SPECIAL_KEYS[key] };
  }

  // Single character
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code = upper.charCodeAt(0);

    // a-z / A-Z
    if (code >= 65 && code <= 90) {
      return {
        key,
        def: { code: `Key${upper}`, keyCode: code, text: key },
      };
    }
    // 0-9
    if (code >= 48 && code <= 57) {
      return {
        key,
        def: { code: `Digit${key}`, keyCode: code, text: key },
      };
    }
    // Other printable characters
    return {
      key,
      def: { code: "", keyCode: key.charCodeAt(0), text: key },
    };
  }

  // Unknown key — pass through as-is
  return { key, def: { code: key, keyCode: 0 } };
}

// --- Handler ---

export async function pressKeyHandler(
  params: PressKeyParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

  // Focus target element if ref or selector provided
  let effectiveSessionId = sessionId;
  if (params.ref || params.selector) {
    try {
      const target = params.ref ? { ref: params.ref } : { selector: params.selector };
      const element = await resolveElement(cdpClient, sessionId!, target, sessionManager);
      effectiveSessionId = element.resolvedSessionId;

      await cdpClient.send(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: "function() { this.focus(); }",
          objectId: element.objectId,
          returnByValue: false,
        },
        element.resolvedSessionId,
      );
    } catch (err) {
      if (err instanceof RefNotFoundError && params.ref) {
        return {
          content: [{ type: "text", text: buildRefNotFoundError(params.ref) }],
          isError: true,
          _meta: { elapsedMs: Math.round(performance.now() - start), method: "press_key" },
        };
      }
      throw err;
    }
  }

  const { key, def } = resolveKey(params.key);
  const modBits = (params.modifiers ?? []).reduce((acc, m) => acc | MODIFIER_BITS[m], 0);

  // Suppress text output when modifier keys are held (Ctrl+K should not type "k")
  const hasModifier = modBits > 0;
  const text = hasModifier ? undefined : def.text;

  // keyDown
  await cdpClient.send(
    "Input.dispatchKeyEvent",
    {
      type: text ? "keyDown" : "rawKeyDown",
      modifiers: modBits,
      key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      ...(text ? { text } : {}),
    },
    effectiveSessionId,
  );

  // char event for printable characters (without modifiers)
  if (text) {
    await cdpClient.send(
      "Input.dispatchKeyEvent",
      {
        type: "char",
        modifiers: modBits,
        key,
        code: def.code,
        text,
      },
      effectiveSessionId,
    );
  }

  // keyUp
  await cdpClient.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyUp",
      modifiers: modBits,
      key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
    },
    effectiveSessionId,
  );

  const elapsedMs = Math.round(performance.now() - start);
  const modStr = params.modifiers?.length ? params.modifiers.join("+") + "+" : "";
  const targetStr = params.ref ? ` on ${params.ref}` : params.selector ? ` on ${params.selector}` : "";
  return {
    content: [{ type: "text", text: `Pressed ${modStr}${params.key}${targetStr}` }],
    _meta: { elapsedMs, method: "press_key" },
  };
}
