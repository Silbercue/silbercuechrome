import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { wrapCdpError } from "./error-utils.js";

// --- Constants ---

/** Roles relevant for form fields — used to filter "Did you mean?" suggestions */
const FORM_FIELD_ROLES = new Set([
  "textbox", "searchbox", "combobox", "spinbutton",
  "checkbox", "radio", "listbox", "switch",
]);

// --- Schema (Task 1.1) ---

const fieldSchema = z.object({
  ref: z
    .string()
    .optional()
    .describe("A11y-Tree element ref (e.g. 'e5') — preferred over selector"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector (e.g. '#email') — fallback when ref is not available"),
  value: z
    .union([z.string(), z.boolean(), z.number()])
    .describe("Value to set: string for text/select, boolean for checkbox/radio, number coerced to string"),
});

export const fillFormSchema = z.object({
  fields: z
    .array(fieldSchema)
    .min(1)
    .describe("Array of fields to fill. Each field needs ref or selector plus value."),
});

export type FillFormParams = z.infer<typeof fillFormSchema>;

// --- Types ---

interface FieldResult {
  ref?: string;
  selector?: string;
  status: "ok" | "error";
  message?: string;
  displayName?: string;
  value?: string | boolean | number;
}

interface ElementTypeInfo {
  tag: string;
  type: string;
  checked: boolean;
}

// --- Helpers ---

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

function fieldIdentifier(field: { ref?: string; selector?: string }): string {
  return field.ref ?? field.selector ?? "unknown";
}

// --- Element type detection (Task 1.2, step 3) ---

async function getElementTypeInfo(
  cdpClient: CdpClient,
  objectId: string,
  sessionId: string,
): Promise<ElementTypeInfo> {
  const typeInfo = await cdpClient.send<{ result: { value: string } }>(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function() {
        var tag = this.tagName;
        var type = (this.type || '').toLowerCase();
        var checked = !!this.checked;
        return JSON.stringify({ tag: tag, type: type, checked: checked });
      }`,
      returnByValue: true,
    },
    sessionId,
  );
  return JSON.parse(typeInfo.result.value) as ElementTypeInfo;
}

// --- Select handler (Task 1.2, step 4A — AC #2) ---

async function fillSelect(
  cdpClient: CdpClient,
  objectId: string,
  sessionId: string,
  value: string,
): Promise<void> {
  await cdpClient.send(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function(val) {
        var opts = Array.from(this.options);
        var match = opts.find(function(o) { return o.value === val || o.textContent.trim() === val; });
        if (!match) {
          var available = opts.map(function(o) { return o.textContent.trim() || o.value; }).filter(Boolean);
          throw new Error('Option not found: ' + val + ' — available: [' + available.join(', ') + ']');
        }
        this.value = match.value;
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value }],
      returnByValue: true,
    },
    sessionId,
  );
}

// --- Checkbox/Radio click handler (Task 1.2, step 4B — AC #3) ---

async function clickCheckboxOrRadio(
  cdpClient: CdpClient,
  sessionId: string,
  backendNodeId: number,
): Promise<void> {
  // Step 1: Reset scroll to origin (same pattern as click.ts)
  await cdpClient.send(
    "Runtime.evaluate",
    { expression: "window.scrollTo(0,0)" },
    sessionId,
  );

  // Step 2: Scroll element into view
  await cdpClient.send(
    "DOM.scrollIntoViewIfNeeded",
    { backendNodeId },
    sessionId,
  );

  // Step 3: Get viewport-relative center via DOM.getContentQuads
  const quadsResult = await cdpClient.send<{ quads: number[][] }>(
    "DOM.getContentQuads",
    { backendNodeId },
    sessionId,
  );
  if (!quadsResult.quads || quadsResult.quads.length === 0) {
    throw new Error("Element has no visible layout quads");
  }
  const q = quadsResult.quads[0];
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;

  // Step 4: Dispatch mouse events
  await cdpClient.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", clickCount: 1 },
    sessionId,
  );
  await cdpClient.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
    sessionId,
  );
}

// --- Text input handler (Task 1.2, step 4C — AC #1) ---

async function fillTextInput(
  cdpClient: CdpClient,
  sessionId: string,
  backendNodeId: number,
  objectId: string,
  value: string,
): Promise<void> {
  // Step 1: Focus
  await cdpClient.send(
    "DOM.focus",
    { backendNodeId },
    sessionId,
  );

  // Step 2: Clear (always — fill_form sets definitive values)
  await cdpClient.send(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration:
        "function() { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }",
      returnByValue: true,
    },
    sessionId,
  );

  // Step 3: Type text
  if (value.length > 0) {
    await cdpClient.send("Input.insertText", { text: value }, sessionId);
  }
}

// --- Main handler (Task 1.2) ---

export async function fillFormHandler(
  params: FillFormParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();
  const results: FieldResult[] = [];

  // Process fields sequentially (CDP commands are not parallelizable on same tab)
  for (const field of params.fields) {
    const id = fieldIdentifier(field);

    // Step 1: Validate ref/selector — at least one must be set
    if (!field.ref && !field.selector) {
      results.push({
        ref: field.ref,
        selector: field.selector,
        status: "error",
        message: "Field needs either 'ref' or 'selector'",
        value: field.value,
      });
      continue;
    }

    try {
      // Step 2: Resolve element
      const target = field.ref ? { ref: field.ref } : { selector: field.selector };
      const element = await resolveElement(cdpClient, sessionId!, target, sessionManager);
      const targetSession = element.resolvedSessionId;

      // Step 3: Determine element type via DOM inspection
      const info = await getElementTypeInfo(cdpClient, element.objectId, targetSession);

      // Build display name for response
      const displayName = element.name
        ? `${element.role} '${element.name}'`
        : id;

      // Step 4: Dispatch based on element type
      if (info.tag === "SELECT") {
        // --- SELECT ---
        await fillSelect(cdpClient, element.objectId, targetSession, String(field.value));
        results.push({
          ref: field.ref,
          selector: field.selector,
          status: "ok",
          displayName,
          value: field.value,
        });
      } else if (
        info.tag === "INPUT" &&
        (info.type === "checkbox" || info.type === "radio")
      ) {
        // --- CHECKBOX / RADIO ---
        const desiredChecked = !!field.value;
        if (desiredChecked !== info.checked) {
          await clickCheckboxOrRadio(cdpClient, targetSession, element.backendNodeId);
        }
        results.push({
          ref: field.ref,
          selector: field.selector,
          status: "ok",
          displayName,
          value: field.value,
        });
      } else if (info.tag === "INPUT" && info.type === "file") {
        // --- FILE INPUT — not supported, point to file_upload tool ---
        results.push({
          ref: field.ref,
          selector: field.selector,
          status: "error",
          message: `Field ${id} is a file input — use the file_upload tool instead of fill_form`,
          value: field.value,
        });
        continue;
      } else {
        // --- TEXT INPUT (default) ---
        const textValue = String(field.value);
        await fillTextInput(
          cdpClient,
          targetSession,
          element.backendNodeId,
          element.objectId,
          textValue,
        );
        results.push({
          ref: field.ref,
          selector: field.selector,
          status: "ok",
          displayName,
          value: field.value,
        });
      }
    } catch (err) {
      // RefNotFoundError — contextual "did you mean?" error
      if (err instanceof RefNotFoundError && field.ref) {
        const errorText = buildRefNotFoundError(field.ref, FORM_FIELD_ROLES);
        results.push({
          ref: field.ref,
          selector: field.selector,
          status: "error",
          message: errorText,
          value: field.value,
        });
        continue;
      }

      // CDP connection error or other — wrap and continue
      const message = wrapCdpError(err, "fill_form");
      results.push({
        ref: field.ref,
        selector: field.selector,
        status: "error",
        message,
        value: field.value,
      });
    }
  }

  // --- Build response (Task 1.3) ---
  const elapsedMs = Math.round(performance.now() - start);
  const okCount = results.filter((r) => r.status === "ok").length;
  const errorCount = results.filter((r) => r.status === "error").length;
  const totalCount = results.length;

  // Format response lines
  const lines: string[] = [];

  if (errorCount === 0) {
    lines.push(`Filled ${okCount} fields:`);
  } else {
    lines.push(`Filled ${okCount}/${totalCount} fields (${errorCount} error${errorCount > 1 ? "s" : ""}):`);
  }

  for (const r of results) {
    const id = r.ref ?? r.selector ?? "unknown";
    if (r.status === "ok") {
      const displayValue = typeof r.value === "boolean"
        ? String(r.value)
        : `"${truncate(String(r.value ?? ""), 50)}"`;
      const name = r.displayName ?? id;
      lines.push(`- ${id} (${name}): ${displayValue} \u2713`);
    } else {
      lines.push(`- ${id}: ${r.message}`);
    }
  }

  const allFailed = okCount === 0;

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    ...(allFailed ? { isError: true } : {}),
    _meta: { elapsedMs, method: "fill_form" },
  };
}
