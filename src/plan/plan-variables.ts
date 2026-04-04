import type { ToolResponse } from "../types.js";

export type VarsMap = Record<string, unknown>;

const VAR_PATTERN = /\$(\w+)/g;
const EXACT_VAR_PATTERN = /^\$(\w+)$/;

/**
 * Substitute $var references in a params object.
 * Replaces string values matching "$varName" pattern with the value from vars.
 * Supports nested objects and arrays.
 * Unresolved $var references remain as-is (no error — the tool will handle invalid params).
 */
export function substituteVars(
  params: Record<string, unknown>,
  vars: VarsMap,
): Record<string, unknown> {
  return substituteObject(params, vars) as Record<string, unknown>;
}

function substituteValue(value: unknown, vars: VarsMap): unknown {
  if (typeof value === "string") {
    // Whole-string replacement: preserves type (number, boolean, object, etc.)
    const exactMatch = value.match(EXACT_VAR_PATTERN);
    if (exactMatch) {
      const varName = exactMatch[1];
      if (varName in vars) {
        return vars[varName];
      }
      return value; // unresolved — keep as-is
    }

    // Inline replacement: string interpolation
    if (VAR_PATTERN.test(value)) {
      // Reset lastIndex since we used .test()
      VAR_PATTERN.lastIndex = 0;
      return value.replace(VAR_PATTERN, (match, varName: string) => {
        if (varName in vars) {
          return String(vars[varName]);
        }
        return match; // unresolved — keep as-is
      });
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteValue(item, vars));
  }

  if (value !== null && typeof value === "object") {
    return substituteObject(value as Record<string, unknown>, vars);
  }

  return value;
}

function substituteObject(
  obj: Record<string, unknown>,
  vars: VarsMap,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = substituteValue(obj[key], vars);
  }
  return result;
}

/**
 * Extract the text content from a ToolResponse for saveAs.
 * Concatenates all text content blocks into a single string.
 * If the text is valid JSON, parse it and return the parsed value.
 * Otherwise return the raw text string.
 */
export function extractResultValue(result: ToolResponse): unknown {
  const textParts = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text);

  if (textParts.length === 0) {
    return "";
  }

  const text = textParts.join("\n");

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
