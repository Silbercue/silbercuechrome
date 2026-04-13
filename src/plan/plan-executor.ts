import type { ToolRegistry } from "../registry.js";
import type { ToolResponse, ToolContentBlock, ToolMeta } from "../types.js";
import type { VarsMap } from "./plan-variables.js";
import { substituteVars, extractResultValue } from "./plan-variables.js";
import { evaluateCondition } from "./plan-conditions.js";
import type { PlanStateStore } from "./plan-state-store.js";

export type ErrorStrategy = "abort" | "continue" | "capture_image";

export interface SuspendConfig {
  /** Frage an den Agent */
  question?: string;
  /** Context-Typ: "capture_image" erzeugt automatisch einen Screenshot */
  context?: "capture_image";
  /** Bedingung: Plan pausiert NACH Step-Ausfuehrung wenn Bedingung true */
  condition?: string;
}

export interface PlanStep {
  tool: string;
  params?: Record<string, unknown>;
  saveAs?: string;
  if?: string;
  suspend?: SuspendConfig;
}

export interface StepResult {
  step: number;
  tool: string;
  result: ToolResponse;
  skipped?: boolean;
  condition?: string;
  /**
   * Story 18.2 (M1-Fix): Resolved step params (nach Variable-Substitution).
   * Wird fuer die gehaertete Ref-Extraktion in `formatStepLine` benoetigt —
   * bare-`eN`-Matches werden nur akzeptiert, wenn sie mit einem Ref aus
   * `params.ref` / `params.target_ref` / `params.element_ref` uebereinstimmen.
   */
  params?: Record<string, unknown>;
}

export interface PlanOptions {
  vars?: VarsMap;
  errorStrategy?: ErrorStrategy;
  /** Fuer Resume: der gespeicherte Plan-State */
  resumeState?: {
    suspendedAtIndex: number;
    completedResults: StepResult[];
    vars: VarsMap;
    answer: string;
  };
}

export interface SuspendedPlanResponse {
  status: "suspended";
  planId: string;
  question: string;
  completedSteps: StepResult[];
  screenshot?: string;
  _meta?: ToolMeta;
}

/** executePlan kann jetzt entweder ToolResponse oder SuspendedPlanResponse zurueckgeben */
export type PlanExecutionResult = ToolResponse | SuspendedPlanResponse;

const DEFAULT_SUSPEND_QUESTION = "Plan paused -- condition met. How should we proceed?";

/**
 * Story 18.2: Maximale Laenge des Kurztext-Suffix in der Aggregations-Zeile
 * fuer erfolgreiche Steps ohne extrahierbaren Ref. 80 Zeichen ist ein
 * Kompromiss zwischen "passt in eine Terminal-Zeile" und "Ref-freie Tools
 * koennen ihre Erfolgsmeldung noch erkennbar mitgeben".
 */
const STEP_LINE_COMPACT_MAX_CHARS = 80;

export async function executePlan(
  steps: PlanStep[],
  registry: ToolRegistry,
  options?: PlanOptions,
  stateStore?: PlanStateStore,
): Promise<PlanExecutionResult> {
  const start = performance.now();
  let results: StepResult[] = [];
  const vars: VarsMap = { ...(options?.vars ?? {}) };
  const errorStrategy: ErrorStrategy = options?.errorStrategy ?? "abort";
  let startIndex = 0;
  let isResumeFirstStep = false;

  // --- Resume: restore state from previous suspend ---
  if (options?.resumeState) {
    const rs = options.resumeState;
    Object.assign(vars, rs.vars);
    vars["answer"] = rs.answer;
    results = [...rs.completedResults];
    startIndex = rs.suspendedAtIndex;
    isResumeFirstStep = true;
  }

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];

    // --- Conditional: evaluate if clause ---
    if (step.if !== undefined && step.if !== "") {
      const conditionResult = evaluateCondition(step.if, vars);
      if (!conditionResult) {
        results.push({
          step: i + 1,
          tool: step.tool,
          result: {
            content: [{ type: "text", text: `Skipped: condition "${step.if}" was false` }],
            _meta: { elapsedMs: 0, method: step.tool },
          },
          skipped: true,
          condition: step.if,
        });
        continue;
      }
    }

    // --- Pre-Suspend (without condition): pause BEFORE step execution ---
    // Skip pre-suspend on the first step of a resume (agent already answered)
    if (step.suspend && !step.suspend.condition && !isResumeFirstStep) {
      if (!stateStore) {
        console.warn("[plan-executor] suspend config on step but no stateStore provided — ignoring suspend");
      } else {
        const question = step.suspend.question ?? DEFAULT_SUSPEND_QUESTION;
        let screenshot: string | undefined;
        if (step.suspend.context === "capture_image") {
          try {
            const ssResult = await registry.executeTool("capture_image", {});
            if (!ssResult.isError) {
              for (const block of ssResult.content) {
                if (block.type === "image") {
                  screenshot = (block as { type: "image"; data: string }).data;
                  break;
                }
              }
            }
          } catch {
            // Screenshot is best-effort
          }
        }
        const planId = stateStore.suspend({
          steps,
          suspendedAtIndex: i,
          vars: { ...vars },
          errorStrategy,
          completedResults: [...results],
          question,
        });
        return {
          status: "suspended",
          planId,
          question,
          completedSteps: [...results],
          screenshot,
          _meta: {
            elapsedMs: Math.round(performance.now() - start),
            method: "run_plan",
          },
        } satisfies SuspendedPlanResponse;
      }
    }

    // Reset resume-first-step flag after pre-suspend check
    isResumeFirstStep = false;

    // --- Variable substitution ---
    const resolvedParams = step.params
      ? substituteVars(step.params, vars)
      : {};

    // --- Execute step ---
    // Story 18.1: `skipOnToolResultHook` unterdrueckt den Ambient-Context-
    // Hook fuer Zwischen-Steps. Der Hook wird stattdessen einmalig am
    // Plan-Ende ueber das letzte Step-Ergebnis aufgerufen (siehe unten
    // `runAggregationHook`).
    let stepResult: ToolResponse;
    try {
      stepResult = await registry.executeTool(step.tool, resolvedParams, undefined, {
        skipOnToolResultHook: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stepResult = {
        content: [{ type: "text", text: `Exception in ${step.tool}: ${message}` }],
        isError: true,
        _meta: { elapsedMs: 0, method: step.tool },
      };
    }

    // --- saveAs: store result as variable ---
    if (!stepResult.isError && step.saveAs) {
      vars[step.saveAs] = extractResultValue(stepResult);
    }

    results.push({
      step: i + 1,
      tool: step.tool,
      result: stepResult,
      params: resolvedParams,
    });

    // --- Post-Suspend (with condition): pause AFTER step execution if condition is true ---
    if (step.suspend?.condition && !stepResult.isError) {
      const suspendConditionResult = evaluateCondition(step.suspend.condition, vars);
      if (suspendConditionResult) {
        if (!stateStore) {
          console.warn("[plan-executor] suspend condition met but no stateStore provided — ignoring suspend");
        } else {
          const question = step.suspend.question ?? DEFAULT_SUSPEND_QUESTION;
          let screenshot: string | undefined;
          if (step.suspend.context === "capture_image") {
            try {
              const ssResult = await registry.executeTool("capture_image", {});
              if (!ssResult.isError) {
                for (const block of ssResult.content) {
                  if (block.type === "image") {
                    screenshot = (block as { type: "image"; data: string }).data;
                    break;
                  }
                }
              }
            } catch {
              // Screenshot is best-effort
            }
          }
          const planId = stateStore.suspend({
            steps,
            suspendedAtIndex: i + 1,
            vars: { ...vars },
            errorStrategy,
            completedResults: [...results],
            question,
          });
          return {
            status: "suspended",
            planId,
            question,
            completedSteps: [...results],
            screenshot,
            _meta: {
              elapsedMs: Math.round(performance.now() - start),
              method: "run_plan",
            },
          } satisfies SuspendedPlanResponse;
        }
      }
    }

    // --- Error handling based on strategy ---
    if (stepResult.isError) {
      if (errorStrategy === "abort") {
        return buildPlanResponse(results, steps.length, start, true, errorStrategy);
      }

      if (errorStrategy === "capture_image") {
        // Take screenshot and append to the failed step
        try {
          const screenshotResult = await registry.executeTool("capture_image", {});
          // Append screenshot content to the failed step's result
          const lastResult = results[results.length - 1];
          if (!screenshotResult.isError) {
            for (const block of screenshotResult.content) {
              if (block.type === "image") {
                lastResult.result = {
                  ...lastResult.result,
                  content: [...lastResult.result.content, block],
                };
              }
            }
          }
        } catch {
          // Screenshot is best-effort
        }
        return buildPlanResponse(results, steps.length, start, true, errorStrategy);
      }

      // errorStrategy === "continue": just keep going
    }
  }

  // Story 18.1 (AC-2): Aggregations-Hook — genau einmal am Plan-Ende ueber
  // das letzte Step-Ergebnis, damit der LLM den finalen Seitenzustand sieht.
  // Pre-Suspend und Error-Abbrueche sind bereits via `return` oben
  // ausgestiegen; wir sind hier nur nach dem kompletten Happy-Path oder bei
  // `errorStrategy: "continue"` mit gemischten Ergebnissen.
  //
  // AC-2.4 (M1-Fix, Code-Review 18.1): Der Hook laeuft nur, wenn der letzte
  // Step eine *Transition* war — d.h. ein Tool, das den Seitenzustand
  // geaendert hat und `_meta.elementClass` gesetzt hat. Die einzigen Tools,
  // die `elementClass` setzen, sind `click` (src/tools/click.ts:359) und
  // `type` (src/tools/type.ts:310) — exakt die Tools, deren `classifyRef`
  // Ergebnis "clickable" oder "widget-state" ist. Fuer `wait_for`,
  // `view_page`, `capture_image`, `evaluate` oder `navigate` feuert der Hook
  // NICHT, weil dort kein Transition-DOM-Diff noetig ist und der Pro-Repo-
  // Hook nur zusaetzliche Tokens produzieren wuerde.
  //
  // Zusaetzliche Guards: Kein Hook bei `skipped` oder `isError` — dann
  // bleibt das Verhalten identisch zur Baseline und der LLM sieht keinen
  // irrefuehrenden DOM-Diff ueber einen fehlgeschlagenen Step.
  // Story 18.2: Aggregations-Hook-Output wird *nach* der Hook-Ausfuehrung aus
  // dem letzten Step-Result herausgeschnitten und separat an
  // `buildPlanResponse` uebergeben. Ohne diesen Cut wuerden die
  // Hook-Output-Bloecke (DOM-Diff, Compact-Snapshot, ...) in der
  // Ein-Zeilen-Aggregation des letzten Steps verschwinden, weil
  // `formatStepLine` nur den ersten text-Block / die ersten 80 Chars
  // beruecksichtigt. Der Aggregations-Overlay wird stattdessen am Plan-Ende
  // als eigener Block-Schwanz angehaengt — der LLM bekommt seinen finalen
  // Seitenzustand wie zuvor, aber alle anderen Step-Outputs sind
  // verschmaelert.
  let aggregationOverlay: ToolContentBlock[] = [];
  const lastStep = results.length > 0 ? results[results.length - 1] : undefined;
  if (lastStep && !lastStep.skipped && !lastStep.result.isError) {
    const elementClass = lastStep.result._meta?.elementClass;
    const isTransitionTool = elementClass === "clickable" || elementClass === "widget-state";
    if (isTransitionTool) {
      // H1-Fix (Review 18.2): Reference-Set-Based-Diffing statt
      // `slice(contentLengthBefore)`. Der bisherige Schnitt hat IMPLIZIT
      // angenommen, dass `runAggregationHook` neue Bloecke per `push` am Ende
      // anfuegt. Wenn eine zukuenftige Hook-Variante stattdessen `unshift`
      // oder `splice(0, ...)` verwendet, waere der Overlay-Block der alte
      // Step-Text und die Step-Line wuerde den Hook-Text enthalten.
      //
      // Stattdessen: Wir merken uns die Referenz-Identitaet aller Bloecke
      // VOR dem Hook-Call, und filtern NACH dem Hook-Call alle Bloecke
      // heraus, die NICHT im Set waren. Das funktioniert unabhaengig von
      // push/unshift/splice und bewahrt die vom Hook gewaehlte Einfuege-
      // Reihenfolge im Overlay.
      const existingBlocks = new Set<ToolContentBlock>(lastStep.result.content);
      // Story 20.1: Force synchronous diff in the aggregation hook.
      // Without this flag the default onToolResult hook would schedule a
      // deferred (background) diff — but at plan-end we need the diff
      // inline in the response, so we explicitly request sync mode.
      if (lastStep.result._meta) {
        lastStep.result._meta.syncDiff = true;
      }
      try {
        await registry.runAggregationHook(lastStep.result, lastStep.tool);
      } catch {
        // Aggregations-Hook ist best-effort — schluckt eigene Fehler, damit
        // der Plan-Response nicht wegen eines Hook-Fehlers kippt.
      }
      const afterBlocks = lastStep.result.content;
      const newBlocks = afterBlocks.filter((b) => !existingBlocks.has(b));
      if (newBlocks.length > 0) {
        aggregationOverlay = newBlocks;
        // Hook-Output aus dem Step-Result herausschneiden, damit
        // `formatStepLine` ihn nicht in der Ein-Zeilen-Aggregation rendert.
        // Wir behalten die urspruenglichen Bloecke in ihrer urspruenglichen
        // Position (Set-Membership-Filter).
        lastStep.result = {
          ...lastStep.result,
          content: afterBlocks.filter((b) => existingBlocks.has(b)),
        };
      }
    }
  }

  return buildPlanResponse(
    results,
    steps.length,
    start,
    false,
    errorStrategy,
    aggregationOverlay,
  );
}

/**
 * Story 18.2 (FR-034): Verschmaelert die Step-Render-Schleife auf eine
 * kompakte Ein-Zeilen-Aggregation pro erfolgreichem Step.
 *
 * **OK-Steps:** `[i/N] OK tool (Xms): ref=eK` ODER `[i/N] OK tool (Xms):
 * <kurztext>` (max. STEP_LINE_COMPACT_MAX_CHARS Zeichen, erste Zeile). Image-
 * Bloecke aus erfolgreichen Steps werden NICHT in den Plan-Response uebernommen
 * — sie sind der Token-Killer in Plaenen mit `capture_image` als Zwischen-Step.
 *
 * **FAIL-Steps:** behalten die Vollform — alle text-Bloecke joined mit `\n`,
 * plus Image-Bloecke (z.B. vom `errorStrategy: "capture_image"`-Pfad). Die
 * Vollform ist Pflicht, weil der LLM den ganzen Fehler-Kontext braucht, um zu
 * entscheiden, was zu tun ist.
 *
 * **SKIP-Steps:** unveraendert (`[i/N] SKIP tool (condition: <expr>)`).
 *
 * **Aggregations-Overlay:** Story 18.1 fuegt am Plan-Ende einen einmaligen
 * DOM-Diff-/Compact-Snapshot-Block an. Story 18.2 nimmt diese Bloecke aus dem
 * letzten Step-Result heraus (siehe `executePlan`) und uebergibt sie als
 * separates Argument, damit sie nicht in die Ein-Zeilen-Aggregation des
 * letzten Steps gequetscht werden.
 *
 * @see docs/friction-fixes.md#FR-034
 */
function buildPlanResponse(
  results: StepResult[],
  stepsTotal: number,
  startTime: number,
  aborted: boolean,
  errorStrategy: ErrorStrategy = "abort",
  aggregationOverlay: ToolContentBlock[] = [],
): ToolResponse {
  const elapsedMs = Math.round(performance.now() - startTime);
  const contentBlocks: Array<ToolContentBlock> = [];

  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (const r of results) {
    if (r.skipped) {
      skipCount++;
      contentBlocks.push({
        type: "text",
        text: `[${r.step}/${stepsTotal}] SKIP ${r.tool} (condition: ${r.condition})`,
      });
      continue;
    }

    if (r.result.isError) {
      failCount++;
      appendErrorContext(contentBlocks, r, stepsTotal);
      continue;
    }

    okCount++;
    contentBlocks.push({
      type: "text",
      text: formatStepLine(r, stepsTotal),
    });
    // Story 18.2: image-Bloecke aus erfolgreichen Steps werden NICHT mehr
    // propagiert. Wer ein Screenshot-Image im Plan-Response braucht, muss
    // entweder den Screenshot ausserhalb des Plans aufrufen oder den
    // `errorStrategy: "capture_image"`-Pfad nutzen (Image bleibt am Fehler-
    // Step erhalten via `appendErrorContext`).
  }

  // Story 18.2: Aggregations-Overlay (DOM-Diff/Compact-Snapshot vom letzten
  // Step) wird als eigener Block-Schwanz angehaengt — vor den Footer-Zeilen,
  // damit der LLM den finalen Seitenzustand zwischen Step-Liste und Footer
  // sieht.
  for (const block of aggregationOverlay) {
    contentBlocks.push(block);
  }

  if (aborted) {
    contentBlocks.push({
      type: "text",
      text: `\nPlan aborted at step ${results.length}/${stepsTotal}`,
    });
  }

  // Summary for continue strategy with errors
  if (errorStrategy === "continue" && failCount > 0 && !aborted) {
    const parts = [`${okCount}/${stepsTotal} OK`, `${failCount} FAIL`];
    if (skipCount > 0) parts.push(`${skipCount} SKIP`);
    contentBlocks.push({
      type: "text",
      text: `\nPlan completed with errors: ${parts.join(", ")}`,
    });
  }

  // Determine isError:
  // - abort/capture_image: aborted flag
  // - continue: only if ALL executed (non-skipped) steps failed
  const executedCount = okCount + failCount;
  const isError =
    errorStrategy === "continue" && !aborted
      ? executedCount > 0 && failCount === executedCount
      : aborted;

  return {
    content: contentBlocks,
    isError: isError || undefined,
    _meta: {
      elapsedMs,
      method: "run_plan",
      stepsTotal,
      stepsCompleted: okCount,
    },
  };
}

/**
 * Story 18.2: Extrahiert den ersten Ref (`e1`, `e2`, ..., `eN`) aus einem
 * Step-Tool-Text. Bevorzugt das `ref=eN`-Praefix-Format (klare Tool-Output-
 * Konvention), faellt auf das blanke `eN` zurueck (z.B. `"Clicked element
 * e5"`). Returnt `undefined` wenn kein Match — dann nutzt `formatStepLine`
 * den Kurztext-Pfad.
 *
 * **M1-Haertung (Review 18.2):** Der bare `\b(e\d+)\b`-Pattern ist per-se
 * ambig — SilbercueChrome-Refs beginnen bei `e1` und haben keine harte
 * Obergrenze (siehe `src/cache/a11y-tree.ts:450` — `this.nextRef++`). Ein
 * freier Token wie `e500` im Fehler-Text koennte also faelschlich als Ref
 * interpretiert werden. Haertung:
 *
 *   1. `ref=eN` per Praefix-Regex wird IMMER akzeptiert (explizite Tool-
 *      Output-Konvention, kein False-Positive-Risiko).
 *   2. Bare `eN` wird NUR akzeptiert, wenn `expectedRef` (aus den Step-
 *      Params `ref` / `target_ref` / `element_ref`) mit dem gefundenen
 *      Token uebereinstimmt. Das eliminiert False Positives wie `e500` in
 *      "HTTP error 500" oder fremde Refs in Error-Texten.
 *   3. `e2e` matched **nicht**, weil `\b(e\d+)\b` an `2` → `e` keinen
 *      Word-Boundary findet (beides Word-Chars). Getestet in
 *      plan-executor.test.ts ("e2e inside e2e-test is not extracted").
 *
 * Bewusst kein try/catch — `String.prototype.match` ist eine pure Funktion
 * ohne Exception-Pfade (Invariante 4: Fallback als State, nicht als Exception).
 */
function extractFirstRef(text: string, expectedRef?: string): string | undefined {
  const prefixMatch = text.match(/\bref=(e\d+)\b/);
  if (prefixMatch) return prefixMatch[1];
  if (!expectedRef) return undefined;
  // Bare-Ref nur akzeptieren, wenn er exakt mit dem Step-Params-Ref
  // uebereinstimmt — haertet gegen False-Positive-Tokens im Fehler-Text.
  const bareRegex = new RegExp(`\\b(${escapeRegex(expectedRef)})\\b`);
  const bareMatch = text.match(bareRegex);
  return bareMatch ? bareMatch[1] : undefined;
}

/**
 * Story 18.2 (M1-Fix): Escaped regex-Metacharakter. Der Erwartungswert
 * `expectedRef` ist zwar heute immer `eN` (reine ASCII-Alphanumerik), aber
 * wir wollen die Funktion robust gegen zukuenftige Ref-Formate halten.
 */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Story 18.2 (M1-Fix): Extrahiert einen erwarteten Ref aus Step-Params.
 * Die haeufigsten Keys sind `ref` (click, type, scroll), `target_ref` und
 * `element_ref`. Wenn keiner der Keys ein `eN`-foermiges String-Value
 * traegt, returnt `undefined` → nur Praefix-Format wird akzeptiert.
 */
function extractExpectedRefFromParams(
  params: Record<string, unknown> | undefined,
): string | undefined {
  if (!params) return undefined;
  const candidates = ["ref", "target_ref", "element_ref"] as const;
  for (const key of candidates) {
    const value = params[key];
    if (typeof value === "string" && /^e\d+$/.test(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * Story 18.2: Formatiert ein **erfolgreiches** Step-Result als
 * Ein-Zeilen-Aggregation. Logik:
 *
 *  - **Kein text-Block:** `[i/N] OK tool (Xms): <no-output>`
 *  - **Ref erkannt:** `[i/N] OK tool (Xms): ref=eK`
 *  - **Sonst:** `[i/N] OK tool (Xms): <kurztext>` mit Kurztext = erste Zeile
 *    des ersten text-Blocks, max. STEP_LINE_COMPACT_MAX_CHARS Zeichen.
 *
 * Image-Bloecke werden hier nicht angefasst — der Aufrufer entscheidet, ob
 * sie propagiert werden (Story 18.2: nicht fuer OK-Steps).
 */
function formatStepLine(stepResult: StepResult, stepsTotal: number): string {
  const stepMs = stepResult.result._meta?.elapsedMs ?? 0;
  const prefix = `[${stepResult.step}/${stepsTotal}] OK ${stepResult.tool} (${stepMs}ms):`;

  const allText = stepResult.result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  if (!allText) {
    return `${prefix} <no-output>`;
  }

  const expectedRef = extractExpectedRefFromParams(stepResult.params);
  const ref = extractFirstRef(allText, expectedRef);
  if (ref) {
    return `${prefix} ref=${ref}`;
  }

  // Kurztext-Fallback: erste Zeile, max STEP_LINE_COMPACT_MAX_CHARS Zeichen
  const firstLine = allText.split("\n")[0];
  const compact =
    firstLine.length > STEP_LINE_COMPACT_MAX_CHARS
      ? firstLine.slice(0, STEP_LINE_COMPACT_MAX_CHARS - 3) + "..."
      : firstLine;
  return `${prefix} ${compact}`;
}

/**
 * Story 18.2: Fehler-Steps behalten die Vollform — alle text-Bloecke werden
 * in eine Zeile mit `\n`-Separator gequetscht (wie heute), und alle
 * Non-Text-Bloecke (z.B. Screenshot-Image vom `errorStrategy: "capture_image"`-
 * Pfad) werden separat angehaengt. Begruendung: AC-4 — der LLM braucht den
 * vollen Fehler-Kontext, um zu entscheiden, was zu tun ist.
 */
function appendErrorContext(
  contentBlocks: Array<ToolContentBlock>,
  stepResult: StepResult,
  stepsTotal: number,
): void {
  const stepMs = stepResult.result._meta?.elapsedMs ?? 0;
  const textParts = stepResult.result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  contentBlocks.push({
    type: "text",
    text: `[${stepResult.step}/${stepsTotal}] FAIL ${stepResult.tool} (${stepMs}ms): ${textParts}`,
  });

  for (const block of stepResult.result.content) {
    if (block.type !== "text") {
      contentBlocks.push(block);
    }
  }
}
