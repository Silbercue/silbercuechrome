import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrefetchSlot } from "./prefetch-slot.js";

/**
 * Story 18.5 — Unit-Tests fuer `PrefetchSlot`.
 *
 * Die Slot-Klasse ist absichtlich ohne CDP-Mocks testbar — der Build-Callback
 * ist ein normales Promise, das den AbortSignal selbst liest. Tests fokussieren
 * auf Lifecycle (schedule/cancel), Race-Conditions (Identity-Check, Slot-Reset),
 * und Fehler-Absorption (AC-5).
 *
 * Jeder Test installiert einen `unhandledRejection`-Spy, damit verpasste
 * Catch-Ketten als harter Test-Fail rotaufleuchten — sonst wuerden sie als
 * stiller Node-Crash erst in CI erscheinen (siehe Dev Notes "Testing
 * Standards" der Story).
 *
 * Story 18.5 H1 fix (Race 5 reentrancy): Nach dem Fix startet der Build in
 * einem `setImmediate()`-Tick, NICHT synchron im schedule()-Stack. Tests die
 * auf build-Seitenzustand (z.B. den AbortSignal-Ref) nach einem schedule()
 * zugreifen, muessen ZUERST einen Immediate-Tick abwarten.
 */

/**
 * Wartet auf genau einen `setImmediate`-Tick. Nach diesem await-Aufruf ist
 * der Build-Callback eines direkt davor gestarteten `schedule()`-Aufrufs
 * garantiert synchron gestartet (der Callback selbst kann noch `await`en,
 * das ist Sache des Callbacks).
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("PrefetchSlot (Story 18.5)", () => {
  let slot: PrefetchSlot;
  let unhandledRejections: unknown[];
  const unhandledHandler = (err: unknown): void => {
    unhandledRejections.push(err);
  };

  beforeEach(() => {
    slot = new PrefetchSlot();
    unhandledRejections = [];
    process.on("unhandledRejection", unhandledHandler);
  });

  afterEach(() => {
    process.off("unhandledRejection", unhandledHandler);
    expect(unhandledRejections).toHaveLength(0);
  });

  // Test 1 — Happy-Path: Build-Callback wird genau einmal aufgerufen,
  // und nach Abschluss ist der Slot leer.
  it("schedule runs the build callback once", async () => {
    const build = vi.fn(async (_signal: AbortSignal, _expectedUrl: string) => {
      // No-op: sofort fertig.
    });

    const done = slot.schedule(build, "session-A", "https://example.com/a");
    // _active wird SYNCHRON in schedule() gesetzt, auch wenn der Build
    // selbst erst im setImmediate-Tick startet.
    expect(slot.isActive).toBe(true);
    expect(slot.activeSessionId).toBe("session-A");

    await done;

    expect(build).toHaveBeenCalledTimes(1);
    expect(slot.isActive).toBe(false);
    expect(slot.activeSessionId).toBeUndefined();
  });

  // Test 2 — Slot 2 cancelt Slot 1 via AbortSignal. Slot 1 bekommt
  // `signal.aborted === true`, Slot 2 uebernimmt.
  it("second schedule aborts first via AbortSignal", async () => {
    let firstSignal: AbortSignal | undefined;
    let firstResolve: (() => void) | undefined;

    const firstBuild = vi.fn(
      (signal: AbortSignal, _expectedUrl: string) =>
        new Promise<void>((resolve) => {
          firstSignal = signal;
          firstResolve = resolve;
          // Bewusst NICHT resolven — erst durch das spaetere firstResolve().
        }),
    );

    const firstDone = slot.schedule(firstBuild, "session-A", "https://example.com/a");
    expect(slot.isActive).toBe(true);

    // Story 18.5 H1: Build laeuft in setImmediate-Tick — wir muessen den
    // Tick abwarten, bevor firstSignal gesetzt ist.
    await tick();
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(false);

    // Slot 2 schiebt Slot 1 raus.
    let secondSignal: AbortSignal | undefined;
    const secondBuild = vi.fn(async (signal: AbortSignal, _expectedUrl: string) => {
      secondSignal = signal;
    });
    const secondDone = slot.schedule(secondBuild, "session-A", "https://example.com/a");

    // Schritt 1 von schedule() war synchron: abort() auf dem vorherigen
    // Slot ist bereits gefeuert, also ist firstSignal jetzt aborted.
    expect(firstSignal?.aborted).toBe(true);
    // Aktiv ist Slot 2 (mit neuer slotId).
    expect(slot.isActive).toBe(true);

    // Nach dem Tick ist secondBuild tatsaechlich gestartet.
    await tick();
    expect(secondSignal).toBeDefined();
    expect(secondSignal?.aborted).toBe(false);

    // Slot 1 zu Ende laufen lassen — sein Resolve ist nach dem Abort egal.
    firstResolve?.();
    await firstDone;
    await secondDone;

    expect(firstBuild).toHaveBeenCalledTimes(1);
    expect(secondBuild).toHaveBeenCalledTimes(1);
    // Nach beiden Promises ist der Slot leer.
    expect(slot.isActive).toBe(false);
  });

  // Test 3 — Race-Test (Race 2 im Story-18.5-Race-Katalog):
  // Slot 1 ist abgebrochen, sein Build resolved JETZT. Slot 2 darf
  // dadurch NICHT aus `_active` entfernt werden.
  it("aborted slot's build completion does NOT clear the new slot", async () => {
    let firstResolve: (() => void) | undefined;
    const firstBuild = vi.fn(
      (_signal: AbortSignal, _expectedUrl: string) =>
        new Promise<void>((resolve) => {
          firstResolve = resolve;
        }),
    );

    const firstDone = slot.schedule(firstBuild, "session-A", "https://example.com/a");
    await tick(); // Slot 1 Build ist gestartet.

    // Slot 2 (haengt ebenfalls) — verhindert dass Slot 2s Build sofort
    // resolved und uns die Identity-Pruefung verwischt.
    let secondResolve: (() => void) | undefined;
    const secondBuild = vi.fn(
      (_signal: AbortSignal, _expectedUrl: string) =>
        new Promise<void>((resolve) => {
          secondResolve = resolve;
        }),
    );
    const secondDone = slot.schedule(secondBuild, "session-B", "https://example.com/b");

    // Slot 2 ist jetzt der aktive (synchron im schedule() gesetzt).
    expect(slot.isActive).toBe(true);
    expect(slot.activeSessionId).toBe("session-B");

    await tick(); // Slot 2 Build ist gestartet.

    // Slot 1 resolved JETZT (nach dem Abort, nach dem Slot-Wechsel).
    firstResolve?.();
    await firstDone;

    // Slot 2 muss IMMER NOCH aktiv sein — Identity-Check verhindert
    // dass das Cleanup von Slot 1 den Slot 2 wegloescht.
    expect(slot.isActive).toBe(true);
    expect(slot.activeSessionId).toBe("session-B");

    // Aufraeumen.
    secondResolve?.();
    await secondDone;
    expect(slot.isActive).toBe(false);
  });

  // Test 4 — `cancel()` auf einem aktiven Slot leert ihn und feuert den
  // Abort.
  it("cancel empties the slot and aborts the build", async () => {
    let signalRef: AbortSignal | undefined;
    let buildResolve: (() => void) | undefined;
    const build = vi.fn(
      (signal: AbortSignal, _expectedUrl: string) =>
        new Promise<void>((resolve) => {
          signalRef = signal;
          buildResolve = resolve;
        }),
    );

    const done = slot.schedule(build, "session-A", "https://example.com/a");
    expect(slot.isActive).toBe(true);

    // Build startet im setImmediate-Tick — wir warten darauf, damit
    // signalRef zugewiesen ist.
    await tick();
    expect(signalRef).toBeDefined();
    expect(signalRef?.aborted).toBe(false);

    slot.cancel();

    expect(slot.isActive).toBe(false);
    expect(signalRef?.aborted).toBe(true);

    // Den haengenden Build sauber abschliessen — sonst leakt ein Promise
    // ueber die Test-Grenze und der unhandledRejection-Spy koennte spaeter
    // anschlagen.
    buildResolve?.();
    await done;
  });

  // Test 5 — `cancel()` auf einem leeren Slot ist ein No-op.
  it("cancel on empty slot is a no-op", () => {
    expect(slot.isActive).toBe(false);
    // Darf nicht werfen.
    expect(() => slot.cancel()).not.toThrow();
    expect(slot.isActive).toBe(false);
  });

  // Test 6 — Build wirft (sync und async) — Fehler werden absorbiert,
  // Slot wird trotzdem leer, KEIN unhandledRejection.
  it("build errors are absorbed, slot cleans up", async () => {
    // Async-Throw
    const asyncFailBuild = vi.fn(async (_signal: AbortSignal, _expectedUrl: string) => {
      throw new Error("async build boom");
    });
    const asyncDone = slot.schedule(asyncFailBuild, "session-A", "https://example.com/a");
    await asyncDone;
    expect(slot.isActive).toBe(false);

    // Sync-Throw — der `(async () => build(signal))()`-Wrap muss das in
    // einen Reject umwandeln, sonst leakt es als unhandledRejection.
    const syncFailBuild = vi.fn((_signal: AbortSignal, _expectedUrl: string): Promise<void> => {
      throw new Error("sync build boom");
    });
    const syncDone = slot.schedule(syncFailBuild, "session-B", "https://example.com/b");
    await syncDone;
    expect(slot.isActive).toBe(false);

    expect(asyncFailBuild).toHaveBeenCalledTimes(1);
    expect(syncFailBuild).toHaveBeenCalledTimes(1);

    // Der unhandledRejection-Spy in afterEach wird das verifizieren.
  });

  // Bonus — AbortError im Build wird stumm geschluckt (nicht als Fehler
  // geloggt). Wir haben keinen direkten Hook auf debug(), aber wir koennen
  // verifizieren dass der Slot sauber zurueckkommt und kein unhandledRejection
  // entsteht.
  it("AbortError in build is swallowed silently", async () => {
    const build = vi.fn(async (_signal: AbortSignal, _expectedUrl: string) => {
      // Sofort werfen wie ein abgebrochener fetch.
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const done = slot.schedule(build, "session-A", "https://example.com/a");
    await done;
    expect(slot.isActive).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Story 18.5 H1 review follow-up — Race 5 reentrancy regression test
  // ---------------------------------------------------------------------
  //
  // Scenario: The first build calls `slot.schedule()` from WITHIN its own
  // body (simulating a refactor gone wrong — a reentrant schedule). The
  // reentrant call must produce a wohldefiniertes slot state: the outer
  // slot must be gone, the inner slot must be the active one, and no
  // orphaned slot may linger.
  //
  // Before the H1 fix the outer `schedule()` would overwrite `_active`
  // AFTER the inner `schedule()` had already replaced it, clobbering the
  // inner slot into `null` and leaving it orphaned.
  //
  // After the H1 fix `_active` is set SYNCHRONOUSLY before the build runs,
  // AND the build runs in a `setImmediate()` tick — so a reentrant schedule
  // from inside the build sees a consistent `_active` and replaces it via
  // the normal cancel+set cycle. The identity-check via slotId in the
  // cleanup chain prevents an aborted slot's late `finally` from deleting
  // its successor.
  it("H1 fix — reentrant schedule from inside build is safe", async () => {
    let outerSignal: AbortSignal | undefined;
    let innerSignal: AbortSignal | undefined;
    let innerResolve: (() => void) | undefined;

    const innerBuild = vi.fn(
      (signal: AbortSignal, _expectedUrl: string) =>
        new Promise<void>((resolve) => {
          innerSignal = signal;
          innerResolve = resolve;
        }),
    );

    const outerBuild = vi.fn(async (signal: AbortSignal, _expectedUrl: string) => {
      outerSignal = signal;
      // Reentrant schedule from within the outer build. This models a
      // refactor where the build accidentally triggers a nested schedule.
      // It MUST NOT produce an orphaned slot.
      slot.schedule(innerBuild, "session-inner", "https://example.com/inner");
    });

    const outerDone = slot.schedule(outerBuild, "session-outer", "https://example.com/outer");
    expect(slot.activeSessionId).toBe("session-outer");

    // Outer build runs in setImmediate — after the first tick its body
    // has executed, called schedule(innerBuild), and completed.
    await tick();
    expect(outerBuild).toHaveBeenCalledTimes(1);
    // The inner slot is now the active one (the outer abort-controller
    // was fired when the inner schedule() replaced it).
    expect(slot.activeSessionId).toBe("session-inner");
    expect(outerSignal).toBeDefined();
    expect(outerSignal?.aborted).toBe(true);

    // Outer build's async body has now returned (the outer build was a
    // no-op after the reentrant schedule). Its cleanup chain will fire
    // after the next microtask — that cleanup's identity-check must see
    // that the inner slot has taken over and must NOT clear _active.
    await outerDone;
    // Inner slot MUST still be active after outer's cleanup ran.
    expect(slot.isActive).toBe(true);
    expect(slot.activeSessionId).toBe("session-inner");

    // Now release the inner build's tick so its build-body runs.
    await tick();
    expect(innerBuild).toHaveBeenCalledTimes(1);
    expect(innerSignal).toBeDefined();

    // Finish the inner build — the slot must then empty out cleanly.
    innerResolve?.();
    // Wait for the inner slot's cleanup chain.
    // One more tick for the microtask-based finally chain.
    await tick();
    await tick();
    expect(slot.isActive).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Story 18.5 M2 review follow-up — Race 3 cancel while build is running
  // ---------------------------------------------------------------------
  //
  // Scenario: An external cancel() fires while the build is hanging on a
  // slow operation. The slot must be aborted, the slot must be idle
  // afterwards, and no cache-write-like side effect may complete after
  // cancel(). The only way for the build body to "write a side effect"
  // in this unit test is to resolve and then observe its signal.aborted
  // state — if the build body respects the signal, no side effect runs
  // after the abort.
  it("M2 fix — external cancel during running build aborts and idles the slot", async () => {
    let signalRef: AbortSignal | undefined;
    let releaseBuild: (() => void) | undefined;
    let postCancelCacheWrites = 0;

    const build = vi.fn(
      (signal: AbortSignal, _expectedUrl: string) =>
        new Promise<void>((resolve) => {
          signalRef = signal;
          releaseBuild = () => {
            // Simuliere einen Cache-Write, der nur laeuft wenn der Signal
            // nicht aborted ist — genau so wie refreshPrecomputed es macht.
            if (!signal.aborted) {
              postCancelCacheWrites++;
            }
            resolve();
          };
        }),
    );

    const done = slot.schedule(build, "session-A", "https://example.com/a");

    // Wait for the build to start and capture its signal ref.
    await tick();
    expect(signalRef).toBeDefined();
    expect(signalRef?.aborted).toBe(false);
    expect(slot.isActive).toBe(true);

    // External cancel — fires while build is hanging.
    slot.cancel();

    // After cancel: slot is empty, signal is aborted.
    expect(slot.isActive).toBe(false);
    expect(signalRef?.aborted).toBe(true);

    // Release the build — its post-abort cache-write branch must NOT run,
    // because the signal is aborted.
    releaseBuild?.();
    await done;

    expect(postCancelCacheWrites).toBe(0);
    expect(slot.isActive).toBe(false);
  });
});
