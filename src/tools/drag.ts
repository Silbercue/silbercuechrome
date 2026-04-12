import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { wrapCdpError } from "./error-utils.js";

/**
 * Story 18.6 (FR-028) — Drag&Drop-Primitive via CDP (native Mouse-Path).
 *
 * Fuehrt eine native Maus-Drag-Sequenz ueber CDP aus:
 *
 *   mousePressed(source) → N × mouseMoved(interpolated, buttons:1) → mouseReleased(target)
 *
 * Der Schluessel fuer HTML5-Drag-Kompatibilitaet ist `buttons: 1` waehrend
 * der `mouseMoved`-Phase — das signalisiert dem Rendering-Engine, dass die
 * Maustaste gedrueckt ist.
 *
 * ## Scope und Limits
 *
 * Dieses Tool implementiert **nur die native Maus-Drag-Sequenz**:
 *  - `mousePressed` → N × `mouseMoved` (buttons:1) → `mouseReleased`
 *  - Funktioniert fuer CSS-basierte Drag-Operationen: Slider-Thumbs,
 *    Resize-Handles, Text-Selection, CSS-Grid-Drag, viele Kanban-Libs die
 *    auf Mouse-Events setzen (z.B. SortableJS im "mouse"-Modus).
 *
 * Fuer die **HTML5 Drag&Drop API** (`draggable="true"`-Elemente, native
 * `dragstart`/`dragover`/`drop`-Events, React DnD mit HTML5Backend,
 * Vuedraggable, ng2-dnd, SortableJS im HTML5-Modus) ist dieses Tool
 * **NICHT** geeignet. Chromium feuert die HTML5-Drag-Events NICHT
 * automatisch aus einer reinen CDP-`mouseMoved`-Sequenz — dafuer muesste
 * zusaetzlich `Input.dispatchDragEvent` verwendet werden, was hier aktuell
 * nicht implementiert ist. Die HTML5-Drag-Pfad-Unterstuetzung ist als
 * Folge-Arbeit in `docs/deferred-work.md#fr-031` vermerkt.
 *
 * Wer HTML5-Drag&Drop auf Framework-Seiten automatisieren muss, kann
 * alternativ ueber `evaluate` einen `DragEvent`-Dispatch-Fallback bauen —
 * das ist aber der letzte Schrei aus dem Katalog und umgeht das
 * Framework-State-Management nicht sauber.
 *
 * Das Tool ist absichtlich NICHT im Default-Tool-Set (Story 18.3). Drag
 * ist eine Nische-Operation (CSS-Slider, Resize-Handles, Mouse-basierte
 * Reorder-Listen) und die Tool-Definition-Overhead-Kosten stehen im
 * Default-Set in keinem Verhaeltnis zur Nutzungsfrequenz. Nutzung ueber
 * `SILBERCUE_CHROME_FULL_TOOLS=true` oder ueber `run_plan`-Dispatch.
 *
 * @see docs/friction-fixes.md#FR-028
 * @see docs/deferred-work.md FR-031 (HTML5 dragstart/drop — Follow-up)
 */

// Mindest-Schritte fuer HTML5-Drag-Event-Kompatibilitaet. Unter 5 Schritten
// erkennen moderne Drag-Libs (React DnD, Vuedraggable, ng2-dnd) die
// `dragover`-Events nicht zuverlaessig. Mehr Schritte erhoehen die
// Kompatibilitaet auf Kosten von Wall-Clock-Latenz.
const DRAG_MIN_STEPS = 5;
const DRAG_DEFAULT_STEPS = 10;

export const dragSchema = z.object({
  from_ref: z.string().optional().describe("A11y-Tree source ref (e.g. 'e5')"),
  from_selector: z.string().optional().describe("CSS selector for source element"),
  from_x: z.number().optional().describe("Source X coord (viewport px) — alternative zu Ref"),
  from_y: z.number().optional().describe("Source Y coord (viewport px) — alternative zu Ref"),
  to_ref: z.string().optional().describe("A11y-Tree target ref (e.g. 'e7')"),
  to_selector: z.string().optional().describe("CSS selector for target element"),
  to_x: z.number().optional().describe("Target X coord (viewport px)"),
  to_y: z.number().optional().describe("Target Y coord (viewport px)"),
  steps: z
    .number()
    .int()
    .min(DRAG_MIN_STEPS)
    .default(DRAG_DEFAULT_STEPS)
    .describe("Anzahl mouseMoved-Events zwischen press und release (min 5 fuer HTML5-dragover)"),
});

export type DragParams = z.infer<typeof dragSchema>;

/** Aufloesung eines Drag-Endpoints zu Viewport-Koordinaten. */
interface DragPoint {
  x: number;
  y: number;
}

async function resolvePointFromRef(
  cdpClient: CdpClient,
  sessionId: string,
  ref: string | undefined,
  selector: string | undefined,
  sessionManager: SessionManager | undefined,
): Promise<DragPoint> {
  const target = ref ? { ref } : { selector: selector! };
  const element = await resolveElement(cdpClient, sessionId, target, sessionManager);

  // getContentQuads liefert Viewport-relative Koordinaten — identisch zum
  // Muster in src/tools/click.ts:96-108.
  const quadsResult = await cdpClient.send<{ quads: number[][] }>(
    "DOM.getContentQuads",
    { backendNodeId: element.backendNodeId },
    element.resolvedSessionId,
  );
  if (!quadsResult.quads || quadsResult.quads.length === 0) {
    throw new Error(`Element ${ref ?? selector} has no visible layout quads — not draggable`);
  }
  const q = quadsResult.quads[0];
  return {
    x: (q[0] + q[2] + q[4] + q[6]) / 4,
    y: (q[1] + q[3] + q[5] + q[7]) / 4,
  };
}

export async function dragHandler(
  params: DragParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

  // --- Validation ---------------------------------------------------------
  const hasFromRef = !!params.from_ref || !!params.from_selector;
  const hasFromCoord = params.from_x !== undefined && params.from_y !== undefined;
  if (!hasFromRef && !hasFromCoord) {
    return {
      content: [
        {
          type: "text",
          text: "drag requires either 'from_ref'/'from_selector' or 'from_x'+'from_y' as source",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "drag" },
    };
  }
  const hasToRef = !!params.to_ref || !!params.to_selector;
  const hasToCoord = params.to_x !== undefined && params.to_y !== undefined;
  if (!hasToRef && !hasToCoord) {
    return {
      content: [
        {
          type: "text",
          text: "drag requires either 'to_ref'/'to_selector' or 'to_x'+'to_y' as target",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "drag" },
    };
  }

  // Story 18.6 review fix (M4): Handler-level guard for `steps`.
  //
  // The Zod schema (`dragSchema`) enforces `.min(DRAG_MIN_STEPS)`, but
  // `executeTool` / `run_plan` can dispatch with raw params that bypass
  // Zod validation (the run_plan path forwards the `params` object
  // directly to `_handlers.get("drag")` without re-parsing through the
  // schema). A steps < 5 call would silently produce fewer mouseMoved
  // events and break HTML5 dragover granularity. Defense-in-depth: check
  // here at the handler entry point too.
  if (params.steps !== undefined && params.steps < DRAG_MIN_STEPS) {
    return {
      content: [
        {
          type: "text",
          text: `drag.steps must be >= ${DRAG_MIN_STEPS} for stable native events (got ${params.steps}). Increase steps or omit the field to use the default of ${DRAG_DEFAULT_STEPS}.`,
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "drag" },
    };
  }

  try {
    // --- Resolve source + target Punkte ---------------------------------
    const from: DragPoint = hasFromCoord
      ? { x: params.from_x!, y: params.from_y! }
      : await resolvePointFromRef(cdpClient, sessionId!, params.from_ref, params.from_selector, sessionManager);
    const to: DragPoint = hasToCoord
      ? { x: params.to_x!, y: params.to_y! }
      : await resolvePointFromRef(cdpClient, sessionId!, params.to_ref, params.to_selector, sessionManager);

    const steps = params.steps ?? DRAG_DEFAULT_STEPS;

    // --- CDP-Drag-Sequenz -----------------------------------------------
    //
    // Schritt 1: mousePressed auf Source — startet den Drag.
    await cdpClient.send(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: from.x,
        y: from.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      },
      sessionId,
    );

    // Schritt 2: N × mouseMoved auf interpolierten Koordinaten mit
    // `buttons: 1` (die Maustaste ist gedrueckt). Chromium feuert
    // dragstart/dragover waehrend dieser Sequenz, wenn das Source-Element
    // `draggable="true"` ist.
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      await cdpClient.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x,
          y,
          button: "left",
          buttons: 1,
        },
        sessionId,
      );
    }

    // Schritt 3: mouseReleased auf Target — beendet den Drag.
    await cdpClient.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x: to.x,
        y: to.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      },
      sessionId,
    );

    const elapsedMs = Math.round(performance.now() - start);
    const sourceLabel = params.from_ref ?? params.from_selector ?? `(${params.from_x},${params.from_y})`;
    const targetLabel = params.to_ref ?? params.to_selector ?? `(${params.to_x},${params.to_y})`;
    return {
      content: [
        {
          type: "text",
          text: `Dragged ${sourceLabel} to ${targetLabel} at (${Math.round(to.x)}, ${Math.round(to.y)}) over ${steps} steps`,
        },
      ],
      _meta: {
        elapsedMs,
        method: "drag",
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        steps,
      },
    };
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      const badRef = params.from_ref ?? params.to_ref ?? "";
      return {
        content: [{ type: "text", text: buildRefNotFoundError(badRef) }],
        isError: true,
        _meta: { elapsedMs: 0, method: "drag" },
      };
    }
    const elapsedMs = Math.round(performance.now() - start);
    const hint = params.from_ref ?? params.from_selector ?? "drag source";
    return {
      content: [{ type: "text", text: wrapCdpError(err, "drag", hint) }],
      isError: true,
      _meta: { elapsedMs, method: "drag" },
    };
  }
}
