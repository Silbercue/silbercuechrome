import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement } from "./element-utils.js";
import { RefNotFoundError } from "../cache/a11y-tree.js";
import { wrapCdpError } from "./error-utils.js";

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
      "CSS selector to click immediately when 'until' condition is met (for timing-critical actions). Only used with 'until'.",
    ),
  click_first: z
    .string()
    .optional()
    .describe(
      "CSS selector to click AFTER the observer is set up but BEFORE collection starts. Use to trigger the changes you want to observe (e.g. 'Start Mutations' button).",
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
 */
export function buildCollectFunction(
  duration: number,
  interval: number,
  collect: "text" | "attributes" | "all",
  clickFirstSelector?: string,
): string {
  const observerConfig = buildMutationObserverConfig(collect);
  const clickFirstCode = clickFirstSelector
    ? `var cf = document.querySelector(${JSON.stringify(clickFirstSelector)}); if (cf) cf.click();`
    : "";
  return `function() {
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
 */
export function buildUntilFunction(
  untilExpression: string,
  timeout: number,
  interval: number,
  collect: "text" | "attributes" | "all",
  thenClickSelector?: string,
  clickFirstSelector?: string,
): string {
  const observerConfig = buildMutationObserverConfig(collect);
  const clickCode = thenClickSelector
    ? `var clickTarget = document.querySelector(${JSON.stringify(thenClickSelector)});
    if (clickTarget) clickTarget.click();`
    : "";
  const clickFirstCode = clickFirstSelector
    ? `var cf = document.querySelector(${JSON.stringify(clickFirstSelector)}); if (cf) cf.click();`
    : "";

  return `function() {
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
        resolve({ met: true, value: el.textContent, changes: changes, clicked: ${thenClickSelector ? "!!clickTarget" : "false"} });
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
      ref: /^e\d+$/.test(params.selector) ? params.selector : undefined,
      selector: /^e\d+$/.test(params.selector) ? undefined : params.selector,
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
      );
    } else {
      functionDeclaration = buildCollectFunction(
        effectiveTimeout,
        params.interval,
        params.collect,
        params.click_first,
      );
    }

    const cdpResult = await cdpClient.send<{
      result: { value: CollectResult | UntilResult };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration,
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
