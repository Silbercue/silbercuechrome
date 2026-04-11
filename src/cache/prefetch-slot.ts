import { debug } from "../cdp/debug.js";

/**
 * Story 18.5 — Speculative Prefetch waehrend LLM-Denkzeit.
 *
 * `PrefetchSlot` haelt **maximal einen** aktiven Background-Build pro
 * Instanz. Ein neuer `schedule()`-Aufruf cancelt den vorherigen Build via
 * `AbortController` und ersetzt ihn atomar. Errors werden absorbiert (siehe
 * AC-5) — der Slot ist eine Fire-and-forget-Infrastruktur und darf den
 * Foreground-Tool-Pfad niemals beeinflussen.
 *
 * Lifecycle-Regeln:
 *  - **Genau ein Slot** pro Instanz. Slot 2 cancelt Slot 1 atomar.
 *  - **Identity-Check** via monoton steigender `slotId`: ein abgebrochener
 *    Slot darf den Nachfolger NICHT aus `_active` loeschen.
 *  - **Atomarer schedule():** `_active` wird synchron gesetzt, BEVOR der
 *    Build ueberhaupt startet. Der tatsaechliche Build-Aufruf laeuft in
 *    einem `setImmediate()` eine Tick spaeter, sodass ein reentranter
 *    `schedule()`-Aufruf aus dem Build-Callback heraus einen klar
 *    definierten Slot-State vorfindet (Race 5 im Story-18.5-Race-Katalog).
 *  - **Sync-Error-Wrap:** Der Build laeuft in einem `(async () => ...)()`
 *    Wrapper — eine synchrone Exception im Build wird zu einem Promise-
 *    Reject, sodass kein `unhandledRejection` entsteht (Race 6).
 *  - **AbortController** ist die einzige Cancel-API — kein eigenes Flag-System.
 *
 * Der Slot ist ohne CDP-Mocks testbar — der Build-Callback ist ein
 * beliebiges Promise, das den Signal selbst checken muss.
 */

interface ActiveSlot {
  /** Monotone Slot-ID fuer Identity-Check im Cleanup-Pfad. */
  slotId: number;
  abortController: AbortController;
  sessionId: string;
  /** URL vor Build-Start (stripped Hash) — dem Build-Callback als Guard uebergeben. */
  expectedUrl: string;
  /** Promise das aufloest wenn der Slot komplett durchgelaufen ist (inkl. Cleanup). */
  donePromise: Promise<void>;
}

/**
 * Signatur des Build-Callbacks. Zweites Argument `expectedUrl` wird vom Slot
 * durchgereicht, sodass der Callback vor dem Cache-Write pruefen kann, ob
 * sich die Page-URL seit dem Schedule geaendert hat (Story 18.5 L1 fix —
 * aktive Nutzung von `expectedUrl` als URL-Race-Guard).
 */
export type PrefetchBuild = (
  signal: AbortSignal,
  expectedUrl: string,
) => Promise<void>;

export class PrefetchSlot {
  private _active: ActiveSlot | null = null;
  private _nextSlotId = 0;

  /** Story 18.5 — Test-only: gibt an ob aktuell ein Slot lebt. */
  get isActive(): boolean {
    return this._active !== null;
  }

  /** Story 18.5 — Test-only: Session-ID des aktiven Slots (oder undefined). */
  get activeSessionId(): string | undefined {
    return this._active?.sessionId;
  }

  /**
   * Plant einen neuen Background-Build. Wenn bereits ein Slot lebt, wird
   * er via AbortController gecancelt und ersetzt — atomar im synchronen
   * Teil dieser Methode (kein `await` zwischen `abort()` und Slot-Reset).
   *
   * **Atomare Sequenz (Story 18.5 H1 fix):**
   *  1. Alten Slot synchron cancelln (falls vorhanden).
   *  2. Neuen Slot-State (slotId, controller, metadata) synchron setzen.
   *  3. ERST DANN den Build in einem naechsten Event-Loop-Tick starten
   *     (`setImmediate`). Damit sieht ein reentranter `schedule()`-Call
   *     aus dem Build-Callback heraus immer einen wohldefinierten Slot-
   *     State — das Race-5-Loch ist geschlossen.
   *
   * Das zurueckgegebene Promise ist **nur fuer Tests** sichtbar. Production
   * code wartet NICHT auf den Build.
   *
   * Errors im Build werden absorbiert (Story 18.5 AC-5):
   *  - `AbortError` ist ein erwarteter Zustand und wird stumm geschluckt.
   *  - Andere Fehler werden via `debug()` einmal geloggt, dann verworfen.
   *
   * @param build Asynchroner Build-Callback. Bekommt den AbortSignal und
   *              den `expectedUrl` (URL zum Schedule-Zeitpunkt), sodass er
   *              vor Cache-Writes eine URL-Race-Pruefung machen kann.
   * @param sessionId Session-ID, fuer die der Build laeuft.
   * @param expectedUrl URL beim Schedule-Zeitpunkt (Stripped-Hash). Wird dem
   *                    Build-Callback durchgereicht — Story 18.5 L1 fix macht
   *                    aus dem frueheren Dokumentations-Feld einen aktiven
   *                    URL-Race-Guard.
   */
  schedule(
    build: PrefetchBuild,
    sessionId: string,
    expectedUrl: string,
  ): Promise<void> {
    // 1. Vorherigen Slot synchron cancelln und entfernen.
    //    KEIN `await` zwischen abort() und Neuset — sonst koennten
    //    konkurrierende Schedule-Aufrufe sich verschachteln.
    if (this._active !== null) {
      try {
        this._active.abortController.abort();
      } catch {
        // AbortController.abort() wirft nicht in modernen Node-Versionen,
        // aber defensiv: ein Throw hier darf keinen neuen Slot blockieren.
      }
      this._active = null;
    }

    // 2. Neuen Slot-State atomar setzen — BEVOR der Build startet. Damit
    //    sieht ein reentranter `schedule()`-Call aus dem Build-Callback
    //    heraus einen konsistenten Slot-State und kann den neuen Slot
    //    sauber replacen (Story 18.5 H1 fix).
    const slotId = ++this._nextSlotId;
    const abortController = new AbortController();
    const signal = abortController.signal;

    // 3. Cleanup + Build werden in einem zusammenhaengenden Promise gebaut,
    //    aber der tatsaechliche build()-Aufruf passiert in setImmediate —
    //    d.h. im naechsten Event-Loop-Tick, nicht synchron im schedule()-
    //    Stack. Das macht die schedule()-Methode vollstaendig reentranz-
    //    sicher (Race 5 aus dem Story-18.5-Race-Katalog).
    const donePromise = new Promise<void>((resolveDone) => {
      setImmediate(() => {
        // Sync-Wrap: selbst eine synchrone Exception im build() wird zu
        // einem Promise-Reject (Race 6 aus dem Story-18.5-Race-Katalog).
        const wrapped = (async () => build(signal, expectedUrl))();
        wrapped
          .catch((err: unknown) => {
            // Story 18.5 AC-5: Fehler absorbieren. AbortError ist ein
            // erwarteter Zustand, alle anderen Fehler werden einmal
            // geloggt.
            if (isAbortError(err)) return;
            debug(
              "PrefetchSlot: build failed, dropping result: %s",
              err instanceof Error ? err.message : String(err),
            );
          })
          .finally(() => {
            // Identity-Check via slotId (Race 2 — Slot-Identity-Kollision).
            // Nur aufraeumen, wenn DIESER Slot noch aktiv ist — ein
            // spaeterer schedule() hat vielleicht schon einen neuen Slot
            // mit hoeherer slotId installiert, den wir NICHT loeschen
            // duerfen.
            if (this._active !== null && this._active.slotId === slotId) {
              this._active = null;
            }
            resolveDone();
          });
      });
    });

    const slot: ActiveSlot = {
      slotId,
      abortController,
      sessionId,
      expectedUrl,
      donePromise,
    };
    this._active = slot;

    // 4. Den finalen Promise an den Aufrufer zurueckgeben — Tests koennen
    //    darauf awaiten, Production-Code MUSS das ignorieren (fire-and-
    //    forget). Der Promise rejected NIE — alle Fehler sind in der
    //    `.catch()`-Kette bereits abgefangen.
    return donePromise;
  }

  /**
   * Sofort den aktiven Slot abbrechen und freigeben. Idempotent — ein
   * Aufruf auf einem leeren Slot ist ein No-op.
   *
   * Wird aus `a11yTree.reset()` aufgerufen, wenn der Cache invalidiert
   * wird (z.B. bei Navigation), damit ein noch laufender Prefetch nicht
   * auf die obsolet gewordene Session-Struktur schreibt.
   */
  cancel(): void {
    if (this._active === null) return;
    try {
      this._active.abortController.abort();
    } catch {
      // siehe schedule()
    }
    this._active = null;
  }
}

/**
 * Erkennt einen AbortError egal ob er von `AbortController.abort()`,
 * `signal.throwIfAborted()` oder einer eigenen Implementation stammt.
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError";
  }
  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: unknown }).name;
    return name === "AbortError";
  }
  return false;
}

/**
 * Modulweite Singleton-Instanz. Wird vom Registry-Trigger und von
 * `a11yTree.reset()` als gemeinsamer State genutzt — analog zur
 * Singleton-Strategie von `a11yTree` selbst.
 */
export const prefetchSlot = new PrefetchSlot();
