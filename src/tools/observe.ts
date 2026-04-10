import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement } from "./element-utils.js";
import { RefNotFoundError } from "../cache/a11y-tree.js";
import { wrapCdpError } from "./error-utils.js";

// --- Ref detection ---

const REF_RE = /^e\d+$/;

// --- Schema ---

export const observeSchema = z.object({
  selector: z
    .string()
    .describe("CSS selector or element ref (e.g. 'e5') of the element to observe"),
  duration: z
    .number()
    .optional()
    .describe(
      "Collect all changes for this many ms, then return them. Mutually exclusive with 'until'. Default: 5000",
    ),
  until: z
    .string()
    .optional()
    .describe(
      "JS expression evaluated on each change — stops when it returns true. Variable 'el' is the observed element. Example: el.textContent === '8'",
    ),
  then_click: z
    .string()
    .optional()
    .describe(
      "CSS selector or element ref (e.g. 'e5') to click immediately when 'until' condition is met (for timing-critical actions). Only used with 'until'.",
    ),
  click_first: z
    .string()
    .optional()
    .describe(
      "CSS selector or element ref (e.g. 'e5') to click AFTER the observer is set up but BEFORE collection starts. Use to trigger the changes you want to observe (e.g. 'Start Mutations' button).",
    ),
  collect: z
    .enum(["text", "attributes", "all"])
    .optional()
    .default("text")
    .describe(
      "What to collect: 'text' for textContent changes, 'attributes' for attribute changes, 'all' for both (default: 'text')",
    ),
  interval: z
    .number()
    .optional()
    .default(100)
    .describe("Polling interval in ms for change detection fallback (default: 100)"),
  timeout: z
    .number()
    .optional()
    .default(10000)
    .describe("Maximum observation time in ms (default: 10000, max: 25000)"),
});

export type ObserveParams = z.infer<typeof observeSchema>;

// --- Max timeout to stay under CDP 30s limit ---
const MAX_TIMEOUT_MS = 25000;

// --- JS function builders ---

/**
 * Build the observer function for "collect" mode.
 * Runs for `duration` ms, collects all text/attribute changes.
 *
 * When clickFirstIsArg is true, click_first was resolved server-side to an
 * objectId and will be passed as the first function argument (a real DOM node).
 * Otherwise clickFirstSelector is used as a CSS selector via querySelector.
 */
export function buildCollectFunction(
  duration: number,
  interval: number,
  collect: "text" | "attributes" | "all",
  clickFirstSelector?: string,
  clickFirstIsArg?: boolean,
): string {
  const observerConfig = buildMutationObserverConfig(collect);

  // click_first code: either use the function argument or querySelector
  let clickFirstCode: string;
  if (clickFirstIsArg) {
    // Element comes as first function argument — always valid (resolved server-side)
    clickFirstCode = "if (clickFirstEl) clickFirstEl.click();";
  } else if (clickFirstSelector) {
    // CSS selector path — throw on miss instead of silent fail
    clickFirstCode = `var cf = document.querySelector(${JSON.stringify(clickFirstSelector)});
    if (!cf) throw new Error('click_first: element not found for selector ' + ${JSON.stringify(JSON.stringify(clickFirstSelector))});
    cf.click();`;
  } else {
    clickFirstCode = "";
  }

  // Function signature: add clickFirstEl param when needed
  const params = clickFirstIsArg ? "clickFirstEl" : "";

  return `function(${params}) {
  var el = this;
  var changes = [];
  var lastText = el.textContent;
  var lastAttrs = {};
  var attrs = el.attributes;
  for (var i = 0; i < attrs.length; i++) lastAttrs[attrs[i].name] = attrs[i].value;

  function checkText() {
    var text = el.textContent;
    if (text !== lastText) {
      changes.push({ type: "text", value: text });
      lastText = text;
    }
  }
  function checkAttrs() {
    var a = el.attributes;
    for (var i = 0; i < a.length; i++) {
      if (lastAttrs[a[i].name] !== a[i].value) {
        changes.push({ type: "attribute", name: a[i].name, value: a[i].value, old: lastAttrs[a[i].name] || null });
        lastAttrs[a[i].name] = a[i].value;
      }
    }
  }
  function check() {
    ${collect === "text" ? "checkText();" : collect === "attributes" ? "checkAttrs();" : "checkText(); checkAttrs();"}
  }

  return new Promise(function(resolve) {
    var observer = new MutationObserver(check);
    observer.observe(el, ${JSON.stringify(observerConfig)});
    var poll = setInterval(check, ${interval});
    ${clickFirstCode}
    setTimeout(function() {
      observer.disconnect();
      clearInterval(poll);
      check();
      resolve({ changes: changes, count: changes.length });
    }, ${duration});
  });
}`;
}

/**
 * Build the observer function for "until" mode.
 * Waits until a JS condition is met, optionally clicks a target element.
 *
 * clickFirstIsArg / thenClickIsArg: when true, the corresponding element was
 * resolved server-side and is passed as a function argument instead of using
 * querySelector.  Argument order: (clickFirstEl?, thenClickEl?)
 */
export function buildUntilFunction(
  untilExpression: string,
  timeout: number,
  interval: number,
  collect: "text" | "attributes" | "all",
  thenClickSelector?: string,
  clickFirstSelector?: string,
  clickFirstIsArg?: boolean,
  thenClickIsArg?: boolean,
): string {
  const observerConfig = buildMutationObserverConfig(collect);

  // then_click code
  let clickCode: string;
  if (thenClickIsArg) {
    clickCode = "if (thenClickEl) thenClickEl.click();";
  } else if (thenClickSelector) {
    clickCode = `var clickTarget = document.querySelector(${JSON.stringify(thenClickSelector)});
    if (!clickTarget) throw new Error('then_click: element not found for selector ' + ${JSON.stringify(JSON.stringify(thenClickSelector))});
    clickTarget.click();`;
  } else {
    clickCode = "";
  }

  // click_first code
  let clickFirstCode: string;
  if (clickFirstIsArg) {
    clickFirstCode = "if (clickFirstEl) clickFirstEl.click();";
  } else if (clickFirstSelector) {
    clickFirstCode = `var cf = document.querySelector(${JSON.stringify(clickFirstSelector)});
    if (!cf) throw new Error('click_first: element not found for selector ' + ${JSON.stringify(JSON.stringify(clickFirstSelector))});
    cf.click();`;
  } else {
    clickFirstCode = "";
  }

  // Build function parameter list — order: clickFirstEl, thenClickEl
  const paramList: string[] = [];
  if (clickFirstIsArg) paramList.push("clickFirstEl");
  if (thenClickIsArg) paramList.push("thenClickEl");
  const params = paramList.join(", ");

  // "clicked" result: for arg-resolved then_click, always true (server validated);
  // for CSS selector, check if querySelector succeeded (but we now throw on miss,
  // so it's always true if we reach that line)
  const clickedExpr = thenClickIsArg
    ? "true"
    : thenClickSelector
      ? "!!clickTarget"
      : "false";

  return `function(${params}) {
  var el = this;
  var changes = [];
  var lastText = el.textContent;
  var lastAttrs = {};
  var attrs = el.attributes;
  for (var i = 0; i < attrs.length; i++) lastAttrs[attrs[i].name] = attrs[i].value;

  function checkText() {
    var text = el.textContent;
    if (text !== lastText) {
      changes.push({ type: "text", value: text });
      lastText = text;
    }
  }
  function checkAttrs() {
    var a = el.attributes;
    for (var i = 0; i < a.length; i++) {
      if (lastAttrs[a[i].name] !== a[i].value) {
        changes.push({ type: "attribute", name: a[i].name, value: a[i].value, old: lastAttrs[a[i].name] || null });
        lastAttrs[a[i].name] = a[i].value;
      }
    }
  }
  function checkChanges() {
    ${collect === "text" ? "checkText();" : collect === "attributes" ? "checkAttrs();" : "checkText(); checkAttrs();"}
  }

  return new Promise(function(resolve) {
    var done = false;
    function check() {
      if (done) return;
      checkChanges();
      if (${untilExpression}) {
        done = true;
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
        ${clickCode}
        resolve({ met: true, value: el.textContent, changes: changes, clicked: ${clickedExpr} });
      }
    }

    var observer = new MutationObserver(check);
    observer.observe(el, ${JSON.stringify(observerConfig)});
    var poll = setInterval(check, ${interval});
    ${clickFirstCode}
    check();
    var timer = setTimeout(function() {
      if (done) return;
      done = true;
      observer.disconnect();
      clearInterval(poll);
      resolve({ met: false, value: el.textContent, changes: changes, clicked: false });
    }, ${timeout});
  });
}`;
}

function buildMutationObserverConfig(
  collect: "text" | "attributes" | "all",
): Record<string, boolean> {
  const config: Record<string, boolean> = { subtree: true };
  if (collect === "text" || collect === "all") {
    config.childList = true;
    config.characterData = true;
  }
  if (collect === "attributes" || collect === "all") {
    config.attributes = true;
  }
  return config;
}

// --- Response formatting ---

interface CollectResult {
  changes: Array<{ type: string; value?: string; name?: string; old?: string | null }>;
  count: number;
}

interface UntilResult {
  met: boolean;
  value: string;
  changes: Array<{ type: string; value?: string; name?: string; old?: string | null }>;
  clicked: boolean;
}

function formatCollectResponse(result: CollectResult, elapsedMs: number): ToolResponse {
  const textChanges = result.changes.filter((c) => c.type === "text").map((c) => c.value);
  const attrChanges = result.changes.filter((c) => c.type === "attribute");

  const lines: string[] = [];
  if (textChanges.length > 0) {
    lines.push(`Text changes (${textChanges.length}): ${textChanges.join(", ")}`);
  }
  if (attrChanges.length > 0) {
    lines.push(
      `Attribute changes (${attrChanges.length}): ${attrChanges.map((c) => `${c.name}: ${c.old} → ${c.value}`).join(", ")}`,
    );
  }
  if (lines.length === 0) {
    lines.push("No changes detected during observation period.");
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    _meta: {
      elapsedMs,
      method: "observe",
      mode: "collect",
      changeCount: result.count,
      textChanges,
    },
  };
}

function formatUntilResponse(
  result: UntilResult,
  elapsedMs: number,
  thenClickSelector?: string,
): ToolResponse {
  const lines: string[] = [];

  if (result.met) {
    lines.push(`Condition met after ${elapsedMs}ms — value: "${result.value}"`);
    if (result.clicked && thenClickSelector) {
      lines.push(`Clicked ${thenClickSelector}`);
    }
  } else {
    lines.push(
      `Timeout — condition not met. Current value: "${result.value}"`,
    );
  }

  const textChanges = result.changes.filter((c) => c.type === "text").map((c) => c.value);
  if (textChanges.length > 0) {
    lines.push(`Changes observed (${textChanges.length}): ${textChanges.join(", ")}`);
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: !result.met ? true : undefined,
    _meta: {
      elapsedMs,
      method: "observe",
      mode: "until",
      conditionMet: result.met,
      clicked: result.clicked,
      textChanges,
    },
  };
}

// --- Main handler ---

export async function observeHandler(
  params: ObserveParams,
  cdpClient: CdpClient,
  sessionId: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

  // Validation: need either duration or until
  if (params.duration === undefined && !params.until) {
    return {
      content: [
        {
          type: "text",
          text: "observe requires either 'duration' (collect mode) or 'until' (condition mode)",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "observe" },
    };
  }

  if (params.duration !== undefined && params.until) {
    return {
      content: [
        {
          type: "text",
          text: "observe: 'duration' and 'until' are mutually exclusive — use one or the other",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "observe" },
    };
  }

  if (params.then_click && !params.until) {
    return {
      content: [
        {
          type: "text",
          text: "observe: 'then_click' requires 'until' — it clicks when the condition is met",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "observe" },
    };
  }

  // Cap timeout at MAX_TIMEOUT_MS to stay under CDP 30s limit
  const effectiveTimeout = Math.min(
    params.duration ?? params.timeout,
    MAX_TIMEOUT_MS,
  );

  // Resolve the target element
  let objectId: string;
  let resolvedSessionId: string;
  try {
    const resolved = await resolveElement(cdpClient, sessionId, {
      ref: REF_RE.test(params.selector) ? params.selector : undefined,
      selector: REF_RE.test(params.selector) ? undefined : params.selector,
    }, sessionManager);
    objectId = resolved.objectId;
    resolvedSessionId = resolved.resolvedSessionId;
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    if (err instanceof RefNotFoundError) {
      return {
        content: [{ type: "text", text: `observe: ${err.message}` }],
        isError: true,
        _meta: { elapsedMs, method: "observe" },
      };
    }
    return {
      content: [{ type: "text", text: wrapCdpError(err, "observe") }],
      isError: true,
      _meta: { elapsedMs, method: "observe" },
    };
  }

  // --- Resolve click_first / then_click refs (FR-021) ---
  let clickFirstIsArg = false;
  let clickFirstObjectId: string | undefined;
  let thenClickIsArg = false;
  let thenClickObjectId: string | undefined;

  if (params.click_first && REF_RE.test(params.click_first)) {
    try {
      const resolved = await resolveElement(cdpClient, sessionId, {
        ref: params.click_first,
      }, sessionManager);
      clickFirstObjectId = resolved.objectId;
      clickFirstIsArg = true;
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - start);
      const msg = err instanceof RefNotFoundError
        ? `observe: click_first ${err.message}`
        : `observe: click_first ref resolution failed — ${err instanceof Error ? err.message : String(err)}`;
      return {
        content: [{ type: "text", text: msg }],
        isError: true,
        _meta: { elapsedMs, method: "observe" },
      };
    }
  }

  if (params.then_click && REF_RE.test(params.then_click)) {
    try {
      const resolved = await resolveElement(cdpClient, sessionId, {
        ref: params.then_click,
      }, sessionManager);
      thenClickObjectId = resolved.objectId;
      thenClickIsArg = true;
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - start);
      const msg = err instanceof RefNotFoundError
        ? `observe: then_click ${err.message}`
        : `observe: then_click ref resolution failed — ${err instanceof Error ? err.message : String(err)}`;
      return {
        content: [{ type: "text", text: msg }],
        isError: true,
        _meta: { elapsedMs, method: "observe" },
      };
    }
  }

  // Build and execute the observer function
  try {
    let functionDeclaration: string;

    if (params.until) {
      functionDeclaration = buildUntilFunction(
        params.until,
        effectiveTimeout,
        params.interval,
        params.collect,
        params.then_click,
        params.click_first,
        clickFirstIsArg,
        thenClickIsArg,
      );
    } else {
      functionDeclaration = buildCollectFunction(
        effectiveTimeout,
        params.interval,
        params.collect,
        params.click_first,
        clickFirstIsArg,
      );
    }

    // Build arguments array for callFunctionOn — objectIds for ref-resolved elements
    const callArgs: Array<{ objectId: string }> = [];
    if (clickFirstIsArg && clickFirstObjectId) {
      callArgs.push({ objectId: clickFirstObjectId });
    }
    if (thenClickIsArg && thenClickObjectId) {
      callArgs.push({ objectId: thenClickObjectId });
    }

    const cdpResult = await cdpClient.send<{
      result: { value: CollectResult | UntilResult };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration,
        arguments: callArgs.length > 0 ? callArgs : undefined,
        returnByValue: true,
        awaitPromise: true,
      },
      resolvedSessionId,
    );

    const elapsedMs = Math.round(performance.now() - start);

    // Check for JS exception
    if (cdpResult.exceptionDetails) {
      const desc =
        cdpResult.exceptionDetails.exception?.description ??
        cdpResult.exceptionDetails.text ??
        "Unknown JS error";
      return {
        content: [{ type: "text", text: `observe JS error: ${desc}` }],
        isError: true,
        _meta: { elapsedMs, method: "observe" },
      };
    }

    const result = cdpResult.result.value;

    if (params.until) {
      return formatUntilResponse(result as UntilResult, elapsedMs, params.then_click);
    }
    return formatCollectResponse(result as CollectResult, elapsedMs);
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "observe") }],
      isError: true,
      _meta: { elapsedMs, method: "observe" },
    };
  }
}
