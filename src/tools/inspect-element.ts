import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement } from "./element-utils.js";
import { RefNotFoundError } from "../cache/a11y-tree.js";
import { buildRefNotFoundError } from "./element-utils.js";
import { wrapCdpError } from "./error-utils.js";

// --- Schema ---

export const inspectElementSchema = z.object({
  selector: z
    .string()
    .describe("CSS selector or element ref (e.g. 'e5') to inspect"),
  styles: z
    .array(z.string())
    .optional()
    .describe(
      "Filter: only return these CSS properties. Supports wildcards: 'flex*' matches flex-direction, flex-wrap, etc. Default: layout-relevant properties.",
    ),
  include_rules: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Include matched CSS rules with source file:line (default: true)",
    ),
  include_inherited: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Include inherited styles from parent elements, max 3 levels (default: true)",
    ),
});

export type InspectElementParams = z.infer<typeof inspectElementSchema>;

// --- Default layout-relevant properties ---

const DEFAULT_PROPERTIES = new Set([
  "display",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "grid-template-columns",
  "grid-template-rows",
  "grid-gap",
  "gap",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "overflow",
  "overflow-x",
  "overflow-y",
  "text-align",
  "font-size",
  "font-weight",
  "line-height",
  "color",
  "background-color",
  "border",
  "box-sizing",
]);

// --- CDP Response Types ---

interface CSSProperty {
  name: string;
  value: string;
  important?: boolean;
  implicit?: boolean;
  parsedOk?: boolean;
  disabled?: boolean;
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
}

interface CSSStyle {
  styleSheetId?: string;
  cssProperties: CSSProperty[];
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
}

interface SelectorValue {
  text: string;
}

interface CSSRule {
  styleSheetId?: string;
  selectorList: { selectors: SelectorValue[]; text: string };
  origin: "regular" | "user-agent" | "injected" | "inspector";
  style: CSSStyle;
}

interface RuleMatch {
  rule: CSSRule;
  matchingSelectors: number[];
}

interface InheritedStyleEntry {
  inlineStyle?: CSSStyle;
  matchedCSSRules: RuleMatch[];
}

interface MatchedStylesResponse {
  inlineStyle?: CSSStyle;
  matchedCSSRules: RuleMatch[];
  inherited: InheritedStyleEntry[];
}

interface ComputedStyleProperty {
  name: string;
  value: string;
}

interface ComputedStyleResponse {
  computedStyle: ComputedStyleProperty[];
}

interface StyleSheetHeader {
  styleSheetId: string;
  sourceURL: string;
  isInline: boolean;
  startLine: number;
}

// --- Property filter ---

/** Build a property matcher from the styles filter array. Supports wildcards like "flex*". */
export function buildPropertyMatcher(styles?: string[]): (name: string) => boolean {
  if (!styles || styles.length === 0) {
    return (name: string) => DEFAULT_PROPERTIES.has(name);
  }
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const s of styles) {
    if (s.endsWith("*")) {
      prefixes.push(s.slice(0, -1));
    } else {
      exact.add(s);
    }
  }
  return (name: string) =>
    exact.has(name) || prefixes.some((p) => name.startsWith(p));
}

// --- Source URL shortener ---

/** Extract filename from a full URL: "https://example.com/css/styles.css" → "styles.css" */
export function shortenSourceUrl(url: string): string {
  if (!url) return "<inline>";
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    // Keep last 2 path segments for context: "css/styles.css"
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 2) return parts.join("/") || url;
    return parts.slice(-2).join("/");
  } catch {
    // Not a valid URL — return as-is (e.g. blob: or data: URLs)
    return url;
  }
}

// --- Handler ---

export async function inspectElementHandler(
  params: InspectElementParams,
  cdpClient: CdpClient,
  sessionId: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = Date.now();
  const target = params.selector.startsWith("e") && /^e\d+$/.test(params.selector)
    ? { ref: params.selector }
    : { selector: params.selector };

  // 1. Resolve element
  let resolved;
  try {
    resolved = await resolveElement(cdpClient, sessionId, target, sessionManager);
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      return {
        content: [{ type: "text", text: buildRefNotFoundError(target.ref ?? target.selector!) }],
        isError: true,
        _meta: { elapsedMs: Date.now() - start, method: "inspect_element" },
      };
    }
    return {
      content: [{ type: "text", text: wrapCdpError(err, "inspect_element", params.selector) }],
      isError: true,
      _meta: { elapsedMs: Date.now() - start, method: "inspect_element" },
    };
  }

  const { backendNodeId, objectId, resolvedSessionId } = resolved;

  // 2. Enable CSS domain (idempotent)
  await cdpClient.send("CSS.enable", {}, resolvedSessionId);

  // 3. Convert objectId → nodeId (CSS APIs require DOM.NodeId)
  let nodeId: number;
  try {
    await cdpClient.send("DOM.getDocument", { depth: 0 }, resolvedSessionId);
    const requestResult = await cdpClient.send<{ nodeId: number }>(
      "DOM.requestNode",
      { objectId },
      resolvedSessionId,
    );
    nodeId = requestResult.nodeId;
    if (!nodeId || nodeId === 0) {
      throw new Error("DOM.requestNode returned invalid nodeId");
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: wrapCdpError(err, "inspect_element", params.selector) }],
      isError: true,
      _meta: { elapsedMs: Date.now() - start, method: "inspect_element" },
    };
  }

  // 4. Collect stylesheet headers for source resolution
  const stylesheetMap = new Map<string, StyleSheetHeader>();
  const onStyleSheetAdded = (params: unknown) => {
    const event = params as { header: StyleSheetHeader };
    if (event?.header?.styleSheetId) {
      stylesheetMap.set(event.header.styleSheetId, event.header);
    }
  };
  cdpClient.on("CSS.styleSheetAdded", onStyleSheetAdded, resolvedSessionId);

  // Re-enable to trigger styleSheetAdded events for existing sheets
  try {
    await cdpClient.send("CSS.disable", {}, resolvedSessionId);
    await cdpClient.send("CSS.enable", {}, resolvedSessionId);
  } catch {
    // Best-effort — source resolution may be incomplete
  }

  // 5. Fetch CSS data + geometry in parallel
  let computedResponse: ComputedStyleResponse;
  let matchedResponse: MatchedStylesResponse | undefined;
  let geometry: { x: number; y: number; width: number; height: number } | undefined;

  try {
    const promises: Promise<unknown>[] = [
      cdpClient.send<ComputedStyleResponse>(
        "CSS.getComputedStyleForNode",
        { nodeId },
        resolvedSessionId,
      ),
    ];

    if (params.include_rules) {
      promises.push(
        cdpClient.send<MatchedStylesResponse>(
          "CSS.getMatchedStylesForNode",
          { nodeId },
          resolvedSessionId,
        ),
      );
    }

    // Geometry via getBoundingClientRect
    promises.push(
      cdpClient.send<{ result: { value: { x: number; y: number; width: number; height: number } } }>(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: `function() {
            var r = this.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
          }`,
          objectId,
          returnByValue: true,
        },
        resolvedSessionId,
      ).then((r) => (r as { result: { value: { x: number; y: number; width: number; height: number } } }).result.value),
    );

    const results = await Promise.all(promises);
    computedResponse = results[0] as ComputedStyleResponse;
    if (params.include_rules) {
      matchedResponse = results[1] as MatchedStylesResponse;
      geometry = results[2] as typeof geometry;
    } else {
      geometry = results[1] as typeof geometry;
    }
  } catch (err) {
    // Clean up listener
    cdpClient.off("CSS.styleSheetAdded", onStyleSheetAdded);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "inspect_element", params.selector) }],
      isError: true,
      _meta: { elapsedMs: Date.now() - start, method: "inspect_element" },
    };
  }

  // Clean up listener
  cdpClient.off("CSS.styleSheetAdded", onStyleSheetAdded);

  // 6. Get element tag + id + classes + ancestor chain (for inherited labels)
  let elementInfo = "";
  let ancestorLabels: string[] = [];
  try {
    const descResult = await cdpClient.send<{
      result: { value: { self: string; ancestors: string[] } };
    }>(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: `function() {
          function label(el) {
            if (!el || !el.tagName) return '';
            var s = el.tagName.toLowerCase();
            if (el.id) s += '#' + el.id;
            if (el.className && typeof el.className === 'string') {
              s += el.className.split(/\\s+/).filter(Boolean).map(function(c){return '.'+c}).join('');
            }
            return s;
          }
          var ancestors = [];
          var p = this.parentElement;
          for (var i = 0; i < 5 && p; i++) {
            ancestors.push(label(p));
            p = p.parentElement;
          }
          return { self: label(this), ancestors: ancestors };
        }`,
        objectId,
        returnByValue: true,
      },
      resolvedSessionId,
    );
    elementInfo = descResult.result.value.self || "element";
    ancestorLabels = descResult.result.value.ancestors || [];
  } catch {
    elementInfo = "element";
  }

  // 7. Format output
  const matcher = buildPropertyMatcher(params.styles);
  const lines: string[] = [];

  // Header
  if (geometry) {
    lines.push(`Element: ${elementInfo} (${geometry.width}x${geometry.height} at ${geometry.x},${geometry.y})`);
  } else {
    lines.push(`Element: ${elementInfo}`);
  }

  // Computed styles
  const computedFiltered = computedResponse.computedStyle.filter(
    (p) => matcher(p.name) && p.value !== "" && p.value !== "initial" && p.value !== "normal" && p.value !== "none" && p.value !== "auto" && p.value !== "0px",
  );
  // Special case: always include display even if "none" (that's important debugging info)
  const displayProp = computedResponse.computedStyle.find((p) => p.name === "display");
  if (displayProp && matcher("display") && !computedFiltered.some((p) => p.name === "display")) {
    computedFiltered.unshift(displayProp);
  }

  if (computedFiltered.length > 0) {
    lines.push("");
    lines.push("Computed:");
    // Group into rows of 3-4 for compactness
    const row: string[] = [];
    for (const p of computedFiltered) {
      row.push(`${p.name}: ${p.value}`);
      if (row.length >= 3) {
        lines.push(`  ${row.join(" | ")}`);
        row.length = 0;
      }
    }
    if (row.length > 0) {
      lines.push(`  ${row.join(" | ")}`);
    }
  }

  // Matched CSS rules
  if (matchedResponse && params.include_rules) {
    const authorRules = matchedResponse.matchedCSSRules.filter(
      (rm) => rm.rule.origin === "regular" || rm.rule.origin === "injected",
    );

    // Inline styles
    if (matchedResponse.inlineStyle) {
      const inlineProps = matchedResponse.inlineStyle.cssProperties.filter(
        (p) => !p.implicit && p.parsedOk !== false && matcher(p.name),
      );
      if (inlineProps.length > 0) {
        lines.push("");
        lines.push("Rules:");
        const propsStr = inlineProps.map((p) => `${p.name}: ${p.value}${p.important ? " !important" : ""}`).join("; ");
        lines.push(`  [inline] { ${propsStr} }`);
      }
    }

    if (authorRules.length > 0) {
      if (!lines.includes("Rules:")) {
        lines.push("");
        lines.push("Rules:");
      }
      for (const rm of authorRules) {
        const rule = rm.rule;
        // Extract matching selector(s)
        const matchingSelectors = rm.matchingSelectors
          .map((idx) => rule.selectorList.selectors[idx]?.text)
          .filter(Boolean)
          .join(", ");

        // Filter properties
        const props = rule.style.cssProperties.filter(
          (p) => !p.implicit && p.parsedOk !== false && !p.disabled && matcher(p.name),
        );
        if (props.length === 0) continue;

        const propsStr = props
          .map((p) => `${p.name}: ${p.value}${p.important ? " !important" : ""}`)
          .join("; ");
        lines.push(`  ${matchingSelectors} { ${propsStr} }`);

        // Source file
        const sheetId = rule.styleSheetId ?? rule.style.styleSheetId;
        if (sheetId) {
          const header = stylesheetMap.get(sheetId);
          const source = header ? shortenSourceUrl(header.sourceURL) : `sheet:${sheetId}`;
          const line = rule.style.range?.startLine;
          lines.push(`    <- ${source}${line !== undefined ? `:${line + 1}` : ""}`);
        }
      }
    }
  }

  // Inherited styles
  if (matchedResponse && params.include_inherited && matchedResponse.inherited?.length > 0) {
    const inheritedLines: string[] = [];
    const maxLevels = Math.min(matchedResponse.inherited.length, 3);

    for (let i = 0; i < maxLevels; i++) {
      const entry = matchedResponse.inherited[i];
      const parentRules = entry.matchedCSSRules.filter(
        (rm) => rm.rule.origin === "regular" || rm.rule.origin === "injected",
      );

      // Collect all inheritable properties from this ancestor
      const inheritedProps: Array<{ name: string; value: string; source?: string }> = [];

      // From inline style
      if (entry.inlineStyle) {
        for (const p of entry.inlineStyle.cssProperties) {
          if (!p.implicit && p.parsedOk !== false && matcher(p.name)) {
            inheritedProps.push({ name: p.name, value: p.value });
          }
        }
      }

      // From matched rules
      for (const rm of parentRules) {
        const sheetId = rm.rule.styleSheetId ?? rm.rule.style.styleSheetId;
        const header = sheetId ? stylesheetMap.get(sheetId) : undefined;
        const source = header ? shortenSourceUrl(header.sourceURL) : undefined;
        const lineNum = rm.rule.style.range?.startLine;
        const sourceStr = source ? `${source}${lineNum !== undefined ? `:${lineNum + 1}` : ""}` : undefined;

        for (const p of rm.rule.style.cssProperties) {
          if (!p.implicit && p.parsedOk !== false && !p.disabled && matcher(p.name)) {
            inheritedProps.push({ name: p.name, value: p.value, source: sourceStr });
          }
        }
      }

      if (inheritedProps.length === 0) continue;

      // Use actual DOM element label from ancestor chain
      const ancestorLabel = ancestorLabels[i] || `parent[${i}]`;

      const propsStr = inheritedProps.map((p) => `${p.name}: ${p.value}`).join(" | ");
      inheritedLines.push(`  ${ancestorLabel} -> ${propsStr}`);

      // Add source from the first rule that has one
      const firstSource = inheritedProps.find((p) => p.source)?.source;
      if (firstSource) {
        inheritedLines.push(`    <- ${firstSource}`);
      }
    }

    if (inheritedLines.length > 0) {
      lines.push("");
      lines.push("Inherited:");
      lines.push(...inheritedLines);
    }
  }

  const text = lines.join("\n");
  return {
    content: [{ type: "text", text }],
    _meta: { elapsedMs: Date.now() - start, method: "inspect_element" },
  };
}
