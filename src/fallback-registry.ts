/**
 * Fallback Registry — Tool declarations for the Fallback (direct-primitive) mode.
 *
 * When no card matches the current page, the Operator switches to Fallback mode.
 * This module provides the tool names, descriptions, and Zod schemas for the
 * Fallback tool set. Handler implementations are NOT duplicated here — they
 * live in the `_handlers` map of ToolRegistry and are reused.
 *
 * Module Boundaries (strict):
 *   - MAY import: src/tools/*.ts (schemas and descriptions only)
 *   - MAY import: zod
 *   - MUST NOT import: src/registry.ts (no backward dependency)
 *   - MUST NOT import: src/operator/ (no operator dependency)
 *   - MUST NOT import: src/cdp/ (no CDP access)
 *
 * @see Story 19.8, Task 1
 */

import { z } from "zod";
import { clickSchema } from "./tools/click.js";
import { typeSchema } from "./tools/type.js";
import { readPageSchema } from "./tools/read-page.js";
import { waitForSchema } from "./tools/wait-for.js";
import { screenshotSchema } from "./tools/screenshot.js";

// ---------------------------------------------------------------------------
// Fallback Tool Names (Subtask 1.2)
// ---------------------------------------------------------------------------

/**
 * The six tools exposed in Fallback mode: virtual_desk (session management,
 * always available) plus five interaction primitives.
 *
 * evaluate is intentionally excluded — it encourages the LLM to bypass
 * dedicated tools and spirals into JS-heavy workarounds.
 */
export const FALLBACK_TOOL_NAMES: readonly string[] = [
  "virtual_desk",
  "click",
  "type",
  "read_page",
  "wait_for",
  "screenshot",
] as const;

// ---------------------------------------------------------------------------
// O(1) Lookup Set (Subtask 1.5)
// ---------------------------------------------------------------------------

/** Set for O(1) membership checks — analogous to DEFAULT_TOOL_SET in registry.ts. */
export const FALLBACK_TOOL_SET: ReadonlySet<string> = new Set(FALLBACK_TOOL_NAMES);

// ---------------------------------------------------------------------------
// FallbackToolEntry Interface (Subtask 1.3)
// ---------------------------------------------------------------------------

/** Declarative tool entry — schema + metadata, no handler. */
export interface FallbackToolEntry {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
}

// ---------------------------------------------------------------------------
// Tool Descriptions — Single Source of Truth (Story 19.8 H2 fix)
// ---------------------------------------------------------------------------

/**
 * Descriptions for the Fallback primitives. This is the SINGLE SOURCE OF TRUTH
 * for schemas and descriptions of click, type, read_page, wait_for, screenshot.
 * registry.ts imports these via getFallbackTools() — no inline duplication.
 *
 * virtual_desk is listed here for getFallbackTools() completeness, but its
 * registration in registry.ts uses its own dedicated shape/description
 * (because it's in both DEFAULT_TOOL_SET and FALLBACK_TOOL_SET).
 */
const FALLBACK_DESCRIPTIONS: Record<string, string> = {
  virtual_desk:
    "PRIMARY orientation tool — call first in every new session, after reconnect, or when unsure. Lists all tabs with IDs, URLs, state. Use returned IDs with switch_tab(tab: '<id>') instead of opening duplicates via navigate. Cheap, call liberally.",
  click:
    "Click an element by ref, CSS selector, or viewport coordinates. Dispatches real CDP mouse events (mouseMoved/mousePressed/mouseReleased). For canvas or pixel-precise targets, use x+y coordinates instead of ref. If the click opens a new tab, the response reports it automatically. The response already includes the DOM diff (NEW/REMOVED/CHANGED lines) — inspect those changes for success/failure signals instead of following up with evaluate to re-check state. If click fails with a stale-ref error, call read_page for fresh refs and retry.",
  type:
    "Type text into an input field identified by ref or CSS selector. For special keys (Enter, Escape, Tab, arrows) or shortcuts (Ctrl+K), use press_key instead. On stale-ref errors, call read_page for fresh refs and retry.",
  read_page:
    "PRIMARY tool for page understanding — call after navigate/switch_tab before any interaction. Returns accessibility tree with stable refs (e.g. 'e5') that you pass to click/type. Use this to read visible text too — not evaluate/querySelector. Default filter:'interactive' hides static text; for cells/paragraphs/labels call read_page(ref: 'eN', filter: 'all'). ~10-30x cheaper than screenshot.",
  wait_for:
    "Wait for a condition: element visible, network idle, or JS expression true",
  screenshot:
    "Capture a WebP image of the page (max 800px, <100KB). You CANNOT use screenshots as input for click/type — use read_page for element refs. Only use for visual verification, canvas pages, or explicit user requests. ~10-30x more tokens than read_page.",
};

// ---------------------------------------------------------------------------
// Tool Schemas (Fallback-specific subsets of the full schemas)
// ---------------------------------------------------------------------------

/**
 * Fallback schemas — exact subsets of the full schemas from src/tools/*.
 * Only the most important parameters are exposed to keep the Fallback mode
 * token-efficient.
 */
const FALLBACK_SCHEMAS: Record<string, Record<string, z.ZodTypeAny>> = {
  virtual_desk: {},
  click: {
    ref: clickSchema.shape.ref,
    selector: clickSchema.shape.selector,
    text: clickSchema.shape.text,
    x: clickSchema.shape.x,
    y: clickSchema.shape.y,
  },
  type: {
    ref: typeSchema.shape.ref,
    selector: typeSchema.shape.selector,
    text: typeSchema.shape.text,
    clear: typeSchema.shape.clear,
  },
  read_page: {
    depth: readPageSchema.shape.depth,
    ref: readPageSchema.shape.ref,
    filter: readPageSchema.shape.filter,
    max_tokens: readPageSchema.shape.max_tokens,
  },
  wait_for: {
    condition: waitForSchema.shape.condition,
    selector: waitForSchema.shape.selector,
    expression: waitForSchema.shape.expression,
    timeout: waitForSchema.shape.timeout,
  },
  screenshot: {
    full_page: screenshotSchema.shape.full_page,
    som: screenshotSchema.shape.som,
  },
};

// ---------------------------------------------------------------------------
// Public API (Subtask 1.4)
// ---------------------------------------------------------------------------

/**
 * Returns the Fallback tool declarations — schemas and descriptions.
 * No handler code — handlers come from `_handlers` map in ToolRegistry.
 */
export function getFallbackTools(): FallbackToolEntry[] {
  return FALLBACK_TOOL_NAMES.map((name) => ({
    name,
    description: FALLBACK_DESCRIPTIONS[name] ?? "",
    schema: FALLBACK_SCHEMAS[name] ?? {},
  }));
}
