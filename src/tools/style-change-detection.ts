/**
 * Heuristic detection of style-changing evaluate expressions.
 * Used by evaluate handler to auto-attach visual feedback (screenshot + geometry diff).
 */

// --- Style-Change Patterns (conservative — prefer false negatives over false positives) ---

// Patterns tested against stripped code (string content removed)
const STRIPPED_PATTERNS: RegExp[] = [
  /\.style\s*\./, // element.style.color = 'red'
  /\.style\s*=/, // element.style = 'color: red'
  /\.cssText\s*=/, // element.style.cssText = '...'
  /classList\s*\.\s*add\s*\(/, // element.classList.add('active')
  /classList\s*\.\s*remove\s*\(/, // element.classList.remove('active')
  /classList\s*\.\s*toggle\s*\(/, // element.classList.toggle('active')
  /classList\s*\.\s*replace\s*\(/, // element.classList.replace('old', 'new')
  /\.setProperty\s*\(/, // element.style.setProperty('color', 'red')
];

// Patterns tested against original code (need string argument content)
const RAW_PATTERNS: RegExp[] = [
  /setAttribute\s*\(\s*['"]style['"]/, // element.setAttribute('style', '...')
];

/**
 * Strips string literals (single, double, template) and single-line comments
 * from JS code so that patterns inside strings/comments don't cause false positives.
 */
function stripStringsAndComments(code: string): string {
  return code
    .replace(/\/\/.*$/gm, "") // single-line comments
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, "``"); // template literals
}

/**
 * Detects whether a JS expression modifies CSS/styles.
 * Pure string analysis — no CDP calls.
 * Strips string literals and comments before matching to avoid false positives.
 * setAttribute('style') is matched against original code (needs string argument content).
 */
export function isStyleChange(expression: string): boolean {
  const stripped = stripStringsAndComments(expression);
  return STRIPPED_PATTERNS.some((p) => p.test(stripped))
    || RAW_PATTERNS.some((p) => p.test(expression));
}

// --- Selector Extraction ---

const SELECTOR_PATTERNS: RegExp[] = [
  /querySelector(?:All)?\s*\(\s*'([^']+)'\s*\)/, // querySelector('.foo') — single-quoted
  /querySelector(?:All)?\s*\(\s*"([^"]+)"\s*\)/, // querySelector(".foo") — double-quoted
  /getElementById\s*\(\s*'([^']+)'\s*\)/, // getElementById('foo')
  /getElementById\s*\(\s*"([^"]+)"\s*\)/, // getElementById("foo")
  /getElementsByClassName\s*\(\s*'([^']+)'\s*\)/, // getElementsByClassName('foo')
  /getElementsByClassName\s*\(\s*"([^"]+)"\s*\)/, // getElementsByClassName("foo")
];

/**
 * Extracts the CSS selector from an evaluate expression.
 * Returns the first match, or null if no selector is identifiable.
 *
 * For getElementById, returns '#id'. For getElementsByClassName, returns '.className'.
 */
export function extractSelector(expression: string): string | null {
  for (const pattern of SELECTOR_PATTERNS) {
    const match = pattern.exec(expression);
    if (!match) continue;

    const raw = match[1];
    const source = match[0];

    // getElementById → prepend '#'
    if (source.includes("getElementById")) {
      return `#${raw}`;
    }

    // getElementsByClassName → prepend '.'
    if (source.includes("getElementsByClassName")) {
      return `.${raw}`;
    }

    // querySelector/querySelectorAll — raw is already a CSS selector
    return raw;
  }

  return null;
}

// --- Geometry Diff ---

export interface BoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Formats a compact geometry diff string.
 * Always returns a string — AC-5 requires geometry info whenever the element is identifiable.
 */
export function formatGeometryDiff(
  selector: string,
  before: BoundingRect,
  after: BoundingRect,
): string {
  const wChanged = before.width !== after.width;
  const hChanged = before.height !== after.height;
  const xChanged = before.x !== after.x;
  const yChanged = before.y !== after.y;

  if (!wChanged && !hChanged && !xChanged && !yChanged) {
    return `Visual: ${selector} unchanged ${Math.round(after.width)}×${Math.round(after.height)}px`;
  }

  const parts: string[] = [];

  if (wChanged || hChanged) {
    parts.push(
      `${Math.round(before.width)}×${Math.round(before.height)} → ${Math.round(after.width)}×${Math.round(after.height)}px`,
    );
  }

  if (xChanged || yChanged) {
    parts.push(
      `pos (${Math.round(before.x)},${Math.round(before.y)}) → (${Math.round(after.x)},${Math.round(after.y)})`,
    );
  }

  return `Visual: ${selector} ${parts.join(", ")}`;
}
