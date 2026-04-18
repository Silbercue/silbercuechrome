import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import { wrapCdpError } from "./error-utils.js";
import { getProHooks } from "../hooks/pro-hooks.js";
import {
  FLAG_QUERY_SELECTOR,
  hasQuerySelectorPattern,
  toolSequence,
} from "../telemetry/tool-sequence.js";

/**
 * Detects top-level const/let/class declarations and wraps the expression in
 * an IIFE to avoid "Identifier has already been declared" errors across
 * repeated Runtime.evaluate calls (which share the global scope).
 *
 * The last ExpressionStatement is automatically returned so callers still
 * get the evaluation result.
 */
export function wrapInIIFE(expression: string): string {
  // Quick check: does the code need IIFE wrapping?
  // - const/let/class declarations (would collide across repeated evaluate calls)
  // - top-level return statements (illegal outside function body)
  // - top-level await (FR-H3: illegal outside async function)
  const hasDeclarations = /^[ \t]*(const|let|class)\s/m.test(expression);
  const hasTopLevelReturn = /^[ \t]*return\s/m.test(expression);
  const hasTopLevelAwait = /\bawait\b/.test(expression);
  if (!hasDeclarations && !hasTopLevelReturn && !hasTopLevelAwait) return expression;

  // Already wrapped in an IIFE? Don't double-wrap.
  const trimmed = expression.trim();
  if (/^\([\s\S]*\)\s*\(\s*\)\s*;?\s*$/.test(trimmed)) return expression;

  // FR-H3: Use async IIFE when code contains await
  const asyncPrefix = hasTopLevelAwait ? "async " : "";

  // If code already has explicit return statements, just wrap in IIFE — don't insert return.
  if (hasTopLevelReturn) {
    return `(${asyncPrefix}() => {\n${expression}\n})()`;
  }

  // Insert `return` before the last expression statement so the IIFE
  // returns its value (arrow function block bodies don't auto-return).
  const lines = expression.split("\n");

  // FR-001: Use bracket-depth tracking to find the START of the last multi-line expression.
  // Walk backwards from the last line, tracking depth of () {} [].
  // When depth reaches 0, we've found the start of the expression.
  let depth = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line.startsWith("//")) continue;

    // Count brackets right-to-left (we're scanning backwards)
    for (let c = line.length - 1; c >= 0; c--) {
      const ch = line[c];
      if (ch === ")" || ch === "}" || ch === "]") depth++;
      else if (ch === "(" || ch === "{" || ch === "[") depth--;
    }

    // depth > 0 means we're still inside a multi-line expression — keep walking up
    if (depth > 0) continue;

    // Found the start of the last complete expression/statement.
    if (/^(const|let|var|if|for|while|switch|try|throw|return|class|function)\b/.test(line)) {
      // It's a statement keyword — check for trailing expression after last ;
      const lastSemi = line.lastIndexOf(";");
      if (lastSemi >= 0 && lastSemi < line.length - 1) {
        const trailing = line.substring(lastSemi + 1).trim();
        if (trailing && !/^(const|let|var|if|for|while|switch|try|throw|return|class|function)\b/.test(trailing)) {
          const indent = lines[i].match(/^(\s*)/)?.[1] ?? "";
          lines[i] = indent + line.substring(0, lastSemi + 1);
          lines.splice(i + 1, 0, indent + "return " + trailing);
        }
      }
      break;
    }

    // Pure expression — prepend return
    const indent = lines[i].match(/^(\s*)/)?.[1] ?? "";
    lines[i] = indent + "return " + lines[i].trimStart();
    break;
  }

  return `(${asyncPrefix}() => {\n${lines.join("\n")}\n})()`;
}

export const evaluateSchema = z.object({
  expression: z.string().describe("JavaScript code to execute in the page context"),
  await_promise: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to await Promise results"),
});

/**
 * FR-024: Detect common evaluate anti-patterns where a dedicated tool would be better.
 * Returns a hint string appended to the evaluate result, or null if no pattern matched.
 * Intent: "what you did isn't wrong, but there's a more reliable tool for this".
 *
 * Design: be specific enough to avoid false positives on legitimate DOM work
 * (e.g. `document.querySelector('.card').style.width = '200px'` is NOT an
 * anti-pattern — it's a style edit that no other tool covers).
 */
export function detectEvaluateAntiPattern(expression: string): string | null {
  const hints: string[] = [];

  // Pattern 1A: Bulk element discovery via querySelectorAll / getElementsByXxx.
  // This is read_page's core job — stable refs survive, selectors don't.
  const bulkDiscovery =
    /\bdocument\.(querySelectorAll|getElementsByTagName|getElementsByClassName|getElementsByName)\b/.test(expression);

  // Pattern 1B: querySelector with a bare interactive tag selector (e.g. 'button', 'input').
  // Someone using tag selectors is almost always discovering interactive elements.
  const querySelectorForTag =
    /\bdocument\.querySelector\s*\(\s*['"`](button|input|select|textarea|form|label|a)\b/i.test(expression);

  // Pattern 1C: query-then-interact — get element by ID/selector, then use it as an interactive target
  // (click/focus/submit/value/checked/selectedIndex). This is click/type/fill_form territory.
  // Allowed through: .style.*, .classList.*, .dataset.*, .scrollTop — those are handled elsewhere.
  const queryThenInteract =
    /\bdocument\.(querySelector|getElementById)\s*\([^)]*\)\s*(?:\?\.)?\s*\.(click\s*\(|focus\s*\(|blur\s*\(|submit\s*\(|value\b|checked\b|selectedIndex\b|disabled\b|selected\b)/.test(expression);

  if (bulkDiscovery || querySelectorForTag || queryThenInteract) {
    hints.push(
      "Interactive elements (buttons, links, inputs) are already surfaced as stable refs by view_page. Try click(ref: 'eN') or fill_form(fields: [...]) instead of DOM queries — refs survive layout changes, selectors don't.",
    );
  }

  // Pattern 2: Reading innerText/textContent to extract visible text.
  // filter:'all' on a subtree ref exposes the same text without a second round-trip.
  // Require a leading dot so that string literals mentioning the word don't trigger.
  if (/[.?]\s*(innerText|textContent)\b(?!\s*=)/.test(expression)) {
    hints.push(
      "Reading .innerText/.textContent? The a11y tree already contains visible text. Try view_page(ref: 'eN', filter: 'all') — table cells, static codes, paragraphs all show up with stable refs.",
    );
  }

  // Pattern 3: Inspecting function source via .toString() on a Tests.* / test harness function.
  // This is usually "the LLM is reverse-engineering the test instead of reading the UI".
  if (/\b(Tests?|Benchmark|Spec)\b[\w.]*\.toString\s*\(\s*\)/.test(expression) ||
      /\bfunction[\s\S]{0,80}\.toString\s*\(\s*\)/.test(expression)) {
    hints.push(
      "Reading test/function source via .toString()? The visible UI usually has the task description (e.g. .test-desc text). Try view_page(ref, filter:'all') first — don't debug the test harness.",
    );
  }

  // Pattern 4: Scrolling via element.scrollIntoView() or container.scrollTop = N.
  // The scroll tool handles both patterns with ref-based targeting and smooth fallback.
  if (/\.scrollIntoView\s*\(/.test(expression) ||
      /\.scrollTop\s*=\s*\d/.test(expression)) {
    hints.push(
      "Scrolling via JS? The scroll tool supports ref/selector and container scrolling — scroll(ref: 'eN') or scroll(container_ref: 'eN', direction: 'down').",
    );
  }

  // Pattern 5: Dispatching click events via .click() or dispatchEvent(new MouseEvent).
  // The click tool fires the full CDP pointer event chain which works with widgets
  // that only listen to pointerdown/mousedown.
  if (/\.click\s*\(\s*\)/.test(expression) ||
      /dispatchEvent\s*\(\s*new\s+(Mouse|Pointer)Event/.test(expression)) {
    hints.push(
      "Dispatching click via JS? The click tool fires the full CDP pointer chain (pointerdown → mousedown → pointerup → mouseup → click), which works with custom widgets that DOM .click() silently skips.",
    );
  }

  // Pattern 6: CSS inspection via getComputedStyle / getBoundingClientRect without
  // style mutation. inspect_element (Pro) returns computed styles, matched CSS rules
  // with source:line, cascade, inherited styles, AND a visual clip screenshot — all
  // in one call, no JS needed.
  if (/getComputedStyle|getBoundingClientRect|\.offsetWidth|\.offsetHeight|\.clientWidth|\.clientHeight/.test(expression)) {
    // Only hint when the expression is reading CSS, not mutating it.
    // Style mutations (element.style.X = ...) are a valid evaluate use case.
    const isStyleMutation = /\.style\s*[.=]|\.cssText\s*=|classList\s*\.\s*(add|remove|toggle|replace)\s*\(|\.setProperty\s*\(|setAttribute\s*\(\s*['"]style['"]/.test(expression);
    if (!isStyleMutation) {
      hints.push(
        "Reading CSS/layout via JS? inspect_element(selector) returns computed styles, matched CSS rules with source:line, cascade, inherited styles, and a visual clip screenshot — all in one call. Try inspect_element(selector: '.my-class', styles: ['width', 'height', 'padding']).",
      );
    }
  }

  // Pattern 7: Dialog/alert handling via JS override.
  // handle_dialog uses CDP Page.javascriptDialogOpening and works even when the
  // dialog blocks JS execution. evaluate-based overrides only prevent future
  // dialogs, they can't dismiss one that's already open.
  if (/\bwindow\.(alert|confirm|prompt)\s*=/.test(expression) ||
      /\balert\s*\(\s*['"`]/.test(expression)) {
    hints.push(
      "Handling browser dialogs? Use handle_dialog(action: 'dismiss') or handle_dialog(action: 'accept') — it hooks into CDP Page.javascriptDialogOpening and works even when the dialog blocks JS execution. evaluate-based overrides (window.alert = ...) only prevent future dialogs.",
    );
  }

  // Pattern 8: Page-level scrolling via window.scrollTo/scrollBy.
  // Distinct from Pattern 4 (scrollIntoView on elements). The scroll tool
  // tracks scrollHeight growth, which is critical for detecting lazy-loaded
  // content on infinite-scroll pages.
  if (/\bwindow\.scroll(To|By)\s*\(/.test(expression) ||
      /\bdocument\.(documentElement|body)\.scroll(Top|Height)\s*[=+]/.test(expression)) {
    // Don't fire if we already hinted Pattern 4 (scrollIntoView)
    if (!/\.scrollIntoView\s*\(/.test(expression)) {
      hints.push(
        "Scrolling the page? Use scroll(direction: 'down', amount: 500) — it returns current position and whether new content loaded (scrollHeight grew by Npx). For infinite-scroll pages: repeat scroll calls until scrollHeight stabilizes.",
      );
    }
  }

  // Pattern 9: Authenticated fetch — detect auth-fumbling patterns.
  // Plain fetch() is a valid evaluate use case. But when the expression
  // includes auth-related signals (headers, tokens, credentials, CSRF),
  // the LLM is likely struggling with authentication — guide it.
  const hasFetch = /\bfetch\s*\(/.test(expression) || /new\s+XMLHttpRequest\s*\(/.test(expression);
  const hasAuthSignals = /\b(credentials|Authorization|x-.*token|xsrf|csrf|X-Requested-With)\b/i.test(expression);
  if (hasFetch && hasAuthSignals) {
    hints.push(
      "Struggling with authenticated requests? For same-origin fetch: cookies are sent automatically with { credentials: 'include' }. CSRF/XSRF tokens are typically in sessionStorage (check sessionStorage.getItem('...')). For discovering API endpoints: use network_monitor(action: 'start') before clicking the button, then network_monitor(action: 'get', pattern: 'api') to see captured URLs.",
    );
  }

  if (hints.length === 0) return null;
  return "\n\nTip: " + hints.join("\n\nTip: ");
}

export type EvaluateParams = z.infer<typeof evaluateSchema>;

interface RuntimeEvaluateResult {
  result: {
    type: string;
    subtype?: string;
    value?: unknown;
    description?: string;
    className?: string;
  };
  exceptionDetails?: {
    exceptionId: number;
    text: string;
    exception?: {
      type: string;
      subtype?: string;
      className?: string;
      description?: string;
    };
  };
}

export async function evaluateHandler(
  params: EvaluateParams,
  cdpClient: CdpClient,
  sessionId?: string,
): Promise<ToolResponse> {
  const start = performance.now();

  try {
    // --- Execute expression ---
    const wrappedExpression = wrapInIIFE(params.expression);

    const cdpResult = await cdpClient.send<RuntimeEvaluateResult>(
      "Runtime.evaluate",
      {
        expression: wrappedExpression,
        returnByValue: true,
        awaitPromise: params.await_promise,
      },
      sessionId,
    );

    const elapsedMs = Math.round(performance.now() - start);

    // Check for JS exception
    if (cdpResult.exceptionDetails) {
      const details = cdpResult.exceptionDetails;
      const message =
        details.exception?.description || details.text || "Unknown JavaScript error";
      return {
        content: [{ type: "text", text: message }],
        isError: true,
        _meta: { elapsedMs, method: "evaluate" },
      };
    }

    // Extract result value
    const resultValue = cdpResult.result;
    let text: string;
    if (resultValue.type === "undefined") {
      text = "undefined";
    } else if (resultValue.value === undefined) {
      // Non-serializable result (e.g. DOM nodes) — returnByValue couldn't serialize
      const desc = resultValue.description || resultValue.className || resultValue.subtype || resultValue.type;
      return {
        content: [{ type: "text", text: `Result not serializable: ${desc}` }],
        isError: true,
        _meta: { elapsedMs, method: "evaluate" },
      };
    } else {
      text = JSON.stringify(resultValue.value);
    }

    // FR-024: Detect evaluate anti-patterns and append actionable hints so the
    // LLM learns better defaults over time. The result stays correct — this is
    // a "what you did isn't wrong, but there's a better tool" nudge.
    const antiPatternHint = detectEvaluateAntiPattern(params.expression);

    // BUG-018: Anti-Spiral telemetry — record the call BEFORE reading the
    // streak so the current call is part of the count. Flag the event when
    // the expression contains a DOM-query pattern typical of route-around
    // workarounds after a tool failure. Session-scoped so parallel tab
    // groups (Story 7.6) don't contaminate each other.
    //
    // FR-045: record the raw expression alongside the flag so the
    // tracker can do context-sensitive classification at Tier 2/3.
    const qsFlag = hasQuerySelectorPattern(params.expression)
      ? new Set([FLAG_QUERY_SELECTOR])
      : undefined;
    toolSequence.record("evaluate", qsFlag, sessionId, params.expression);

    // FR-045 — 3-Tier escalation against evaluate-streak "Context Rot".
    //  - Tier 0: no hint.
    //  - Tier 1 (qs streak 3-4): sachlicher Stale-Ref hint (appended).
    //  - Tier 2 (streak 5-7): variierender context-sensitive hint (appended).
    //  - Tier 3 (streak 8-11): isError: true, JS result embedded in hint.
    //  - Tier 4 (streak >=12): isError: true, JS result NOT delivered.
    const streakResponse = toolSequence.evaluateStreakResponse(
      sessionId,
      params.expression,
    );

    let finalText: string;
    let isError = false;

    if (streakResponse.tier >= 4) {
      // Hard-refuse: drop the result, return only the refusal text.
      finalText = streakResponse.text;
      isError = true;
    } else if (streakResponse.tier === 3) {
      // Preserve the JS result inside the Tier-3 payload so the agent
      // still sees what it computed, but flag the response as an error
      // so the MCP client surfaces the self-correction signal. Truncate
      // to 500 chars to keep the stop-hint visually dominant even for
      // huge JSON blobs.
      const truncatedResult =
        text.length > 500 ? text.slice(0, 500) + "... (truncated)" : text;
      finalText = streakResponse.text.replace("<result>", truncatedResult);
      isError = true;
    } else {
      // Tier 0/1/2: normal path — append anti-pattern hint + streak text.
      finalText = text + (antiPatternHint ?? "") + (streakResponse.text ?? "");
    }

    const baseResult: ToolResponse = {
      content: [{ type: "text", text: finalText }],
      ...(isError ? { isError: true } : {}),
      _meta: {
        elapsedMs: Math.round(performance.now() - start),
        method: "evaluate",
      },
    };

    // Story 15.2: Visual Feedback (Geometry-Diff + Clip-Screenshot) is a
    // Pro-Feature. The Pro-Repo registers `enhanceEvaluateResult` via
    // `registerProHooks(...)` to inject geometry + screenshot data. When
    // no Pro-Repo is loaded, the plain text result is returned unchanged.
    //
    // Code-Review M2: The hook is defensively wrapped in try/catch. Any
    // exception (sync throw or rejected Promise) falls back to `baseResult`
    // so that a buggy Pro-Repo cannot crash the evaluate tool.
    //
    // FR-045: skip Pro enhancement when the Tier-3/4 streak response has
    // flipped the result to isError. The STOP/REFUSE payload must stay
    // visually dominant — no geometry diff or clip screenshot should be
    // appended that could drown out the self-correction signal.
    const hooks = getProHooks();
    if (hooks.enhanceEvaluateResult && !isError) {
      try {
        return await hooks.enhanceEvaluateResult(params.expression, baseResult, {
          cdpClient,
          sessionId,
        });
      } catch {
        return baseResult;
      }
    }

    return baseResult;
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "evaluate") }],
      isError: true,
      _meta: { elapsedMs, method: "evaluate" },
    };
  }
}
