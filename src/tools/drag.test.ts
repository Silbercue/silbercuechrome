/**
 * Tests for `drag` tool (Story 18.6 FR-028).
 *
 * Mocked-CDP tests — no real Chrome. Verifies:
 *  1. Happy-Path Ref→Ref: CDP event sequence mousePressed → N×mouseMoved → mouseReleased
 *     mit korrekten Koordinaten aus den aufgeloesten Ref-Bounds
 *  2. Happy-Path Coord→Coord: identische CDP-Sequenz mit rohen Koordinaten
 *  3. Interpolation: `steps: 15` erzeugt 15 mouseMoved-Events auf einer geraden Linie
 *  4. Error-Pfad: ungueltiges from_ref liefert isError ohne CDP-Send-Calls
 *  5. Validierung: fehlendes Source ODER Target liefert isError
 *  6. Handler-Guard (M4): steps < 5 liefert isError auch via executeTool/run_plan
 *  7. HTML5-Drag-Limit: dragstart wird NICHT gefeuert aus reinen Mouse-Events
 *     (dokumentiert die Scope-Reduktion explizit als Test)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { dragHandler, dragSchema } from "./drag.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import { a11yTree } from "../cache/a11y-tree.js";
import * as elementUtils from "./element-utils.js";
import { RefNotFoundError } from "./element-utils.js";

describe("drag tool (Story 18.6 FR-028)", () => {
  beforeEach(() => {
    a11yTree.reset();
  });

  function mockCdpForDrag(): {
    cdp: CdpClient;
    sendMock: ReturnType<typeof vi.fn>;
  } {
    const sendMock = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
      if (method === "DOM.getContentQuads") {
        // Liefert Quads um den Mittelpunkt (100, 100)
        return { quads: [[95, 95, 105, 95, 105, 105, 95, 105]] };
      }
      if (method === "Input.dispatchMouseEvent") return {};
      return {};
    });
    return { cdp: { send: sendMock } as unknown as CdpClient, sendMock };
  }

  it("zod schema parses default steps=10 when omitted", () => {
    const parsed = dragSchema.parse({ from_x: 0, from_y: 0, to_x: 10, to_y: 10 });
    expect(parsed.steps).toBe(10);
  });

  it("zod schema rejects steps<5", () => {
    expect(() =>
      dragSchema.parse({ from_x: 0, from_y: 0, to_x: 10, to_y: 10, steps: 3 }),
    ).toThrow();
  });

  it("happy path with coordinates: dispatches press → 10×moved → released", async () => {
    const { cdp, sendMock } = mockCdpForDrag();
    const result = await dragHandler(
      { from_x: 0, from_y: 0, to_x: 100, to_y: 100, steps: 10 },
      cdp,
      "sess-1",
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");

    // Filter out only the Input.dispatchMouseEvent calls
    const mouseCalls = sendMock.mock.calls.filter(
      (c) => c[0] === "Input.dispatchMouseEvent",
    );
    // 1 mousePressed + 10 mouseMoved + 1 mouseReleased = 12 Events
    expect(mouseCalls.length).toBe(12);
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: "mousePressed", buttons: 1 });
    expect(mouseCalls[11]?.[1]).toMatchObject({ type: "mouseReleased", buttons: 0 });
    // Alle dazwischen sind mouseMoved mit buttons:1 (Maustaste gedrueckt)
    for (let i = 1; i <= 10; i++) {
      expect(mouseCalls[i]?.[1]).toMatchObject({ type: "mouseMoved", buttons: 1 });
    }
  });

  it("interpolation: steps=15 produces 15 mouseMoved events with linearly spaced coords", async () => {
    const { cdp, sendMock } = mockCdpForDrag();
    await dragHandler(
      { from_x: 0, from_y: 0, to_x: 150, to_y: 0, steps: 15 },
      cdp,
      "sess-1",
    );

    const movedCalls = sendMock.mock.calls
      .filter((c) => c[0] === "Input.dispatchMouseEvent")
      .filter((c) => (c[1] as { type: string }).type === "mouseMoved");

    expect(movedCalls.length).toBe(15);
    // Erster Move: t=1/15 → x=10
    expect((movedCalls[0]?.[1] as { x: number }).x).toBeCloseTo(10, 5);
    // Mittig: t=7/15 → x=70
    expect((movedCalls[6]?.[1] as { x: number }).x).toBeCloseTo(70, 5);
    // Letzter: t=15/15 → x=150
    expect((movedCalls[14]?.[1] as { x: number }).x).toBeCloseTo(150, 5);
  });

  it("error path: invalid from_ref returns isError, no CDP dispatchMouseEvent called", async () => {
    const { cdp, sendMock } = mockCdpForDrag();

    // Lass resolveElement mit RefNotFoundError scheitern. Da kein Cache
    // fuer 'e999' existiert, wirft `a11yTree.resolveRefFull` und die
    // Element-Utils mappen das auf RefNotFoundError.
    const result = await dragHandler(
      { from_ref: "e999", to_x: 100, to_y: 100 },
      cdp,
      "sess-1",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");

    const mouseCalls = sendMock.mock.calls.filter(
      (c) => c[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseCalls.length).toBe(0);
  });

  it("validation: missing source returns isError", async () => {
    const { cdp } = mockCdpForDrag();
    const result = await dragHandler(
      { to_x: 10, to_y: 10 },
      cdp,
      "sess-1",
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("source");
  });

  it("validation: missing target returns isError", async () => {
    const { cdp } = mockCdpForDrag();
    const result = await dragHandler(
      { from_x: 0, from_y: 0 },
      cdp,
      "sess-1",
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("target");
  });

  it("response content includes 'Dragged' and step count", async () => {
    const { cdp } = mockCdpForDrag();
    const result = await dragHandler(
      { from_x: 0, from_y: 0, to_x: 50, to_y: 50, steps: 8 },
      cdp,
      "sess-1",
    );

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Dragged");
    expect(text).toContain("8 steps");
  });

  it("RefNotFoundError is caught and mapped to buildRefNotFoundError text", async () => {
    const sendMock = vi.fn(async () => {
      throw new RefNotFoundError("Element e42 not found.");
    });
    const cdp = { send: sendMock } as unknown as CdpClient;

    const result = await dragHandler(
      { from_ref: "e42", to_x: 100, to_y: 100 },
      cdp,
      "sess-1",
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    // buildRefNotFoundError-Text enthaelt den Ref und einen Hint
    expect(text).toContain("e42");
  });

  // Story 18.6 review-fix C2: Happy-Path Ref→Ref
  //
  // Der urspruengliche Test-Katalog deckte nur Koord-zu-Koord und die
  // Ref-Fehlerpfade ab. Dieser Test verifiziert AC-1 Test-Anforderung (1)
  // explizit: ein erfolgreicher drag({from_ref, to_ref}) loest die
  // resolveElement-Pipeline aus, ruft DOM.getContentQuads fuer beide
  // Refs auf und dispatcht die CDP-Sequenz mit den aus den Quads
  // berechneten Mittelpunkt-Koordinaten.
  it("happy path ref→ref: resolves both refs via resolveElement and dispatches press → 10×moved → released with computed coords", async () => {
    // resolveElement mocken, damit es fuer e5 und e8 unterschiedliche
    // Backend-Node-IDs liefert. Der echte Pfad geht ueber den a11yTree-
    // Cache; hier ueberspringen wir den Cache komplett und geben direkte
    // ResolvedElement-Objekte zurueck.
    const resolveSpy = vi
      .spyOn(elementUtils, "resolveElement")
      .mockImplementation(async (_cdp, sessionId, target) => {
        const ref = (target as { ref?: string }).ref;
        if (ref === "e5") {
          return {
            backendNodeId: 101,
            objectId: "obj-101",
            role: "listitem",
            name: "Source card",
            resolvedVia: "ref",
            resolvedSessionId: sessionId,
          };
        }
        if (ref === "e8") {
          return {
            backendNodeId: 202,
            objectId: "obj-202",
            role: "list",
            name: "Target column",
            resolvedVia: "ref",
            resolvedSessionId: sessionId,
          };
        }
        throw new RefNotFoundError(`Unexpected ref ${ref}`);
      });

    // CDP-Mock: verschiedenen Quads pro backendNodeId liefern, damit
    // die Mittelpunkt-Berechnung im Test eindeutig verifizierbar ist.
    // e5 (backendNodeId=101) → Quad mit Mittelpunkt (50, 50)
    // e8 (backendNodeId=202) → Quad mit Mittelpunkt (250, 150)
    const sendMock = vi.fn(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === "DOM.getContentQuads") {
          const backendId = params?.backendNodeId as number;
          if (backendId === 101) {
            // Quad around center (50, 50): corners at (40,40)(60,40)(60,60)(40,60)
            return { quads: [[40, 40, 60, 40, 60, 60, 40, 60]] };
          }
          if (backendId === 202) {
            // Quad around center (250, 150)
            return { quads: [[240, 140, 260, 140, 260, 160, 240, 160]] };
          }
          return { quads: [[0, 0, 0, 0, 0, 0, 0, 0]] };
        }
        if (method === "Input.dispatchMouseEvent") return {};
        return {};
      },
    );
    const cdp = { send: sendMock } as unknown as CdpClient;

    try {
      const result = await dragHandler(
        { from_ref: "e5", to_ref: "e8", steps: 10 },
        cdp,
        "sess-ref",
      );

      expect(result.isError).toBeFalsy();

      // resolveElement muss fuer beide Refs gerufen worden sein.
      expect(resolveSpy).toHaveBeenCalledTimes(2);
      expect(resolveSpy.mock.calls[0]?.[2]).toMatchObject({ ref: "e5" });
      expect(resolveSpy.mock.calls[1]?.[2]).toMatchObject({ ref: "e8" });

      const mouseCalls = sendMock.mock.calls.filter(
        (c) => c[0] === "Input.dispatchMouseEvent",
      );
      // 1 mousePressed + 10 mouseMoved + 1 mouseReleased = 12 Events
      expect(mouseCalls.length).toBe(12);

      // mousePressed auf Source-Mittelpunkt (50, 50)
      expect(mouseCalls[0]?.[1]).toMatchObject({
        type: "mousePressed",
        x: 50,
        y: 50,
        buttons: 1,
      });

      // mouseReleased auf Target-Mittelpunkt (250, 150)
      expect(mouseCalls[11]?.[1]).toMatchObject({
        type: "mouseReleased",
        x: 250,
        y: 150,
        buttons: 0,
      });

      // Erster mouseMoved liegt auf t=1/10 der Linie zwischen Source
      // (50, 50) und Target (250, 150) → x=70, y=60
      expect((mouseCalls[1]?.[1] as { x: number; y: number }).x).toBeCloseTo(70, 5);
      expect((mouseCalls[1]?.[1] as { x: number; y: number }).y).toBeCloseTo(60, 5);

      // Letzter mouseMoved liegt auf t=1 → Target
      expect((mouseCalls[10]?.[1] as { x: number; y: number }).x).toBeCloseTo(250, 5);
      expect((mouseCalls[10]?.[1] as { x: number; y: number }).y).toBeCloseTo(150, 5);

      // Response mentions both refs
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("e5");
      expect(text).toContain("e8");
      expect(text).toContain("Dragged");
    } finally {
      resolveSpy.mockRestore();
    }
  });

  // Story 18.6 review-fix M4: steps < 5 must be rejected even when the
  // call bypasses Zod validation (e.g. run_plan dispatches raw params
  // through _handlers.get("drag") without re-parsing).
  it("handler-guard: steps < 5 returns isError even when Zod is bypassed", async () => {
    const { cdp, sendMock } = mockCdpForDrag();

    // Simuliere den executeTool/run_plan-Pfad: rohe Params an den Handler
    // ohne vorherige dragSchema.parse()-Validation. Type-Cast, weil Zod
    // sonst den steps=2 bei der Schema-Ebene abfangen wuerde.
    const rawParams = {
      from_x: 0,
      from_y: 0,
      to_x: 100,
      to_y: 100,
      steps: 2,
    } as unknown as Parameters<typeof dragHandler>[0];

    const result = await dragHandler(rawParams, cdp, "sess-m4");

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("steps");
    expect(text).toContain(">= 5");

    // Keine CDP-Calls duerfen passiert sein — der Guard feuert VOR
    // resolveElement und VOR dem ersten dispatchMouseEvent.
    const mouseCalls = sendMock.mock.calls.filter(
      (c) => c[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseCalls.length).toBe(0);
  });

  // Story 18.6 review-fix M1: Scope-Reduktion auf native Mouse-Drag
  //
  // Dieser Test dokumentiert explizit die Limitation: die reine CDP-
  // Mouse-Event-Sequenz feuert KEINE HTML5-`dragstart`/`drop`-Events. Die
  // Tool-Description und die FR-028-Sektion in docs/friction-fixes.md
  // verweisen darauf. Der Test ist ein Regression-Guard gegen einen
  // zukuenftigen Versuch, HTML5-Drag stillschweigend zu versprechen.
  it("HTML5 drag limit: dispatches only Input.dispatchMouseEvent (no Input.dispatchDragEvent, no DispatchEvent)", async () => {
    const { cdp, sendMock } = mockCdpForDrag();

    await dragHandler(
      { from_x: 0, from_y: 0, to_x: 50, to_y: 50, steps: 5 },
      cdp,
      "sess-html5",
    );

    const methods = sendMock.mock.calls.map((c) => c[0] as string);
    // Reine Mouse-Sequenz — kein dispatchDragEvent, kein Runtime.evaluate
    // mit manuell dispatchten DragEvents.
    expect(methods).not.toContain("Input.dispatchDragEvent");
    const dispatchEventCalls = methods.filter(
      (m) => m === "Input.dispatchDragEvent",
    );
    expect(dispatchEventCalls.length).toBe(0);

    // Die Sequenz enthaelt nur die drei Event-Typen aus der Mouse-Pipeline
    const mouseEventTypes = sendMock.mock.calls
      .filter((c) => c[0] === "Input.dispatchMouseEvent")
      .map((c) => (c[1] as { type: string }).type);
    const uniqueTypes = new Set(mouseEventTypes);
    expect(uniqueTypes).toEqual(new Set(["mousePressed", "mouseMoved", "mouseReleased"]));
  });
});
