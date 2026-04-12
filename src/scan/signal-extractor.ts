/**
 * Signal Extractor — first layer of the Scan-Match-Pipeline.
 *
 * Extracts structural signals from AXNode arrays (A11y-Tree data).
 * Produces a typed Signal[] that the Aggregator/Matcher (Story 19.4) can
 * compare against Card structure_signature entries.
 *
 * Module Boundaries:
 *   - MAY import: src/cache/ (AXNode type)
 *   - MUST NOT import: src/operator/, src/cards/, src/audit/, src/tools/
 */

import type { AXNode } from "../cache/a11y-tree.js";
import type { Signal, SignalType, ExtractionResult } from "./signal-types.js";

// ---------------------------------------------------------------------------
// Named Constants — Invariante 5 (Solo-Pflegbarkeit)
// ---------------------------------------------------------------------------

/** Maximum number of deduplicated signals in the output (Token-Budget). */
const MAX_SIGNALS = 60;

/** Base confidence weight for role signals (ARIA role detection). */
const ROLE_BASE_WEIGHT = 0.7;

/** Base confidence weight for attribute signals (HTML/ARIA properties). */
const ATTRIBUTE_BASE_WEIGHT = 0.6;

/** Base confidence weight for structure signals (parent-child relationships). */
const STRUCTURE_BASE_WEIGHT = 0.5;

/** Base confidence weight for name-pattern signals (label presence). */
const NAME_PATTERN_BASE_WEIGHT = 0.3;

/** Minimum number of same-role siblings to emit a siblings signal. */
const MIN_SIBLING_COUNT = 3;

/** Weight boost factor for signals that appear more than once (structural repetition). */
const REPETITION_WEIGHT_BOOST = 0.15;

/** Maximum weight after repetition boost (capped at 1). */
const MAX_WEIGHT = 1;

/** Precision factor for rounding extraction time (2 decimal places). */
const TIME_PRECISION_FACTOR = 100;

/**
 * Set of ARIA roles relevant for card recognition.
 * Not all 118 Chromium roles are interesting — only those that
 * help identify page patterns (forms, search, articles, lists, nav).
 */
const INTERESTING_ROLES: ReadonlySet<string> = new Set([
  "form",
  "search",
  "list",
  "listitem",
  "article",
  "textbox",
  "button",
  "navigation",
  "main",
  "heading",
  "link",
  "complementary",
  "contentinfo",
  "banner",
  "region",
  "dialog",
  "alertdialog",
  "table",
  "row",
  "cell",
  "combobox",
  "checkbox",
  "radio",
  "tab",
  "tablist",
  "tabpanel",
  "menu",
  "menuitem",
  "tree",
  "treeitem",
  "grid",
  "separator",
]);

/**
 * Set of AXNode property names that produce attribute signals.
 * Maps to AXProperty.name (ARIA properties without "aria-" prefix).
 */
const INTERESTING_PROPERTIES: ReadonlySet<string> = new Set([
  "type",
  "autocomplete",
  "checked",
  "expanded",
  "hasPopup",
  "inputMode",
  "pressed",
  "selected",
  "disabled",
  "required",
  "multiline",
  "readonly",
]);

/**
 * Allowlist of known structural values for each property.
 * Only values in these sets are emitted as signals — unknown values
 * (URLs, domains, free-text content) are filtered out (Invariante 2).
 *
 * Properties not listed here use boolean-only extraction (true/false).
 */
const PROPERTY_VALUE_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["type", new Set([
    "password", "submit", "email", "text", "search", "tel", "url",
    "number", "checkbox", "radio", "file", "hidden", "reset", "button",
    "date", "time", "datetime-local", "month", "week", "range", "color",
  ])],
  ["autocomplete", new Set([
    "on", "off", "username", "current-password", "new-password",
    "email", "tel", "name", "given-name", "family-name",
    "organization", "street-address", "address-line1", "address-line2",
    "address-level1", "address-level2", "country", "country-name",
    "postal-code", "cc-name", "cc-number", "cc-exp", "cc-exp-month",
    "cc-exp-year", "cc-csc", "cc-type", "bday", "bday-day",
    "bday-month", "bday-year", "sex", "language", "one-time-code",
  ])],
  ["hasPopup", new Set([
    "true", "menu", "listbox", "tree", "grid", "dialog",
  ])],
  ["inputMode", new Set([
    "text", "decimal", "numeric", "tel", "search", "email", "url", "none",
  ])],
]);

// ---------------------------------------------------------------------------
// Extraction Logic
// ---------------------------------------------------------------------------

/**
 * Extract structural signals from an array of AXNodes.
 *
 * Produces a deduplicated, weight-sorted Signal[] suitable for card matching.
 * Does NOT include URLs, content strings, or PII (Invariante 2).
 *
 * @tokens max 800
 * @param nodes - Raw AXNode array from the A11y-Tree cache
 * @returns ExtractionResult with signals and metadata
 */
export function extractSignals(nodes: AXNode[]): ExtractionResult {
  const t0 = performance.now();

  if (nodes.length === 0) {
    return {
      signals: [],
      metadata: { nodeCount: 0, extractionTimeMs: 0, signalCount: 0 },
    };
  }

  // Build lookup maps for structure analysis
  const nodeMap = new Map<string, AXNode>();
  for (const node of nodes) {
    if (!node.ignored) {
      nodeMap.set(node.nodeId, node);
    }
  }

  // Collect raw signals (before deduplication)
  const rawSignals: Signal[] = [];

  for (const node of nodes) {
    if (node.ignored) continue;

    // --- Role Signals ---
    extractRoleSignal(node, rawSignals);

    // --- Attribute Signals ---
    extractAttributeSignals(node, rawSignals);

    // --- Name-Pattern Signals ---
    extractNamePatternSignal(node, rawSignals);
  }

  // --- Structure Signals (require full tree context) ---
  extractStructureSignals(nodes, nodeMap, rawSignals);

  // Deduplicate, boost, cap
  const deduped = deduplicateSignals(rawSignals);
  const capped = capSignals(deduped);

  const elapsed = performance.now() - t0;
  return {
    signals: capped,
    metadata: {
      nodeCount: nodes.length,
      extractionTimeMs: Math.round(elapsed * TIME_PRECISION_FACTOR) / TIME_PRECISION_FACTOR,
      signalCount: capped.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-Node Extractors
// ---------------------------------------------------------------------------

function extractRoleSignal(node: AXNode, out: Signal[]): void {
  const roleValue = node.role?.value;
  if (typeof roleValue !== "string") return;
  if (!INTERESTING_ROLES.has(roleValue)) return;

  out.push({
    type: "role" as SignalType,
    signal: `role:${roleValue}`,
    nodeId: node.nodeId,
    weight: ROLE_BASE_WEIGHT,
  });
}

function extractAttributeSignals(node: AXNode, out: Signal[]): void {
  if (!node.properties) return;

  for (const prop of node.properties) {
    if (!INTERESTING_PROPERTIES.has(prop.name)) continue;

    const val = prop.value?.value;
    // Skip boolean false and empty values — only signal presence of truthy attributes
    if (val === false || val === "" || val === undefined || val === null) continue;

    // Boolean properties: emit "propName:true"
    if (typeof val === "boolean") {
      out.push({
        type: "attribute" as SignalType,
        signal: `${prop.name}:true`,
        nodeId: node.nodeId,
        weight: ATTRIBUTE_BASE_WEIGHT,
      });
      continue;
    }

    // String properties: sanitize against allowlist (Invariante 2)
    const strVal = String(val);
    const allowlist = PROPERTY_VALUE_ALLOWLIST.get(prop.name);
    if (allowlist) {
      // Only emit if value is in the allowlist — blocks URLs, domains, content strings
      if (!allowlist.has(strVal)) continue;
    } else {
      // Properties without an allowlist are boolean-only — skip string values
      continue;
    }

    out.push({
      type: "attribute" as SignalType,
      signal: `${prop.name}:${strVal}`,
      nodeId: node.nodeId,
      weight: ATTRIBUTE_BASE_WEIGHT,
    });
  }
}

function extractNamePatternSignal(node: AXNode, out: Signal[]): void {
  const nameValue = node.name?.value;
  if (typeof nameValue !== "string" || nameValue.trim() === "") return;

  // Only emit presence — never the actual text content (Invariante 2)
  out.push({
    type: "name-pattern" as SignalType,
    signal: "has-name:true",
    nodeId: node.nodeId,
    weight: NAME_PATTERN_BASE_WEIGHT,
  });
}

// ---------------------------------------------------------------------------
// Structure Signal Extraction
// ---------------------------------------------------------------------------

function extractStructureSignals(
  nodes: AXNode[],
  nodeMap: Map<string, AXNode>,
  out: Signal[],
): void {
  // Track which parent-role relationships we've already emitted signals for
  // to avoid per-node duplication in the raw list (dedup handles cross-node)
  for (const node of nodes) {
    if (node.ignored) continue;
    if (!node.parentId) continue;

    const parent = nodeMap.get(node.parentId);
    if (!parent) continue;

    const parentRole = parent.role?.value;
    if (typeof parentRole !== "string") continue;
    if (!INTERESTING_ROLES.has(parentRole)) continue;

    out.push({
      type: "structure" as SignalType,
      signal: `parent:${parentRole}`,
      nodeId: node.nodeId,
      weight: STRUCTURE_BASE_WEIGHT,
    });
  }

  // Sibling counting: for each parent, count children with same role
  const parentChildRoles = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    if (node.ignored) continue;
    if (!node.parentId) continue;

    const roleValue = node.role?.value;
    if (typeof roleValue !== "string") continue;

    let roleCounts = parentChildRoles.get(node.parentId);
    if (!roleCounts) {
      roleCounts = new Map<string, number>();
      parentChildRoles.set(node.parentId, roleCounts);
    }
    roleCounts.set(roleValue, (roleCounts.get(roleValue) ?? 0) + 1);
  }

  for (const [parentNodeId, roleCounts] of parentChildRoles) {
    for (const [role, count] of roleCounts) {
      if (count < MIN_SIBLING_COUNT) continue;
      out.push({
        type: "structure" as SignalType,
        signal: `siblings:${role}:${count}`,
        nodeId: parentNodeId,
        weight: STRUCTURE_BASE_WEIGHT,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Deduplication & Capping
// ---------------------------------------------------------------------------

function deduplicateSignals(rawSignals: Signal[]): Signal[] {
  const groups = new Map<string, Signal>();

  for (const sig of rawSignals) {
    const existing = groups.get(sig.signal);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      // Boost weight for repeated signals (structural repetition is a strong signal)
      existing.weight = Math.min(
        existing.weight + REPETITION_WEIGHT_BOOST,
        MAX_WEIGHT,
      );
    } else {
      groups.set(sig.signal, { ...sig, count: 1 });
    }
  }

  return Array.from(groups.values());
}

function capSignals(signals: Signal[]): Signal[] {
  if (signals.length <= MAX_SIGNALS) {
    // Sort by weight descending even when under cap
    return signals.sort((a, b) => b.weight - a.weight);
  }

  return signals
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_SIGNALS);
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  MAX_SIGNALS,
  ROLE_BASE_WEIGHT,
  ATTRIBUTE_BASE_WEIGHT,
  STRUCTURE_BASE_WEIGHT,
  NAME_PATTERN_BASE_WEIGHT,
  MIN_SIBLING_COUNT,
  REPETITION_WEIGHT_BOOST,
  MAX_WEIGHT,
  TIME_PRECISION_FACTOR,
  INTERESTING_ROLES,
  INTERESTING_PROPERTIES,
  PROPERTY_VALUE_ALLOWLIST,
};
