import type { CdpTransport } from "../transport/transport.js";
import type { CdpError } from "./protocol.js";

export interface CdpClientOptions {
  timeoutMs?: number;
}

type EventCallback = (params: unknown, sessionId?: string) => void;

interface RegisteredListener {
  callback: EventCallback;
  sessionId?: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpClient {
  private _nextId = 1;
  private readonly _pending = new Map<number, PendingCall>();
  private readonly _listeners = new Map<string, Set<RegisteredListener>>();
  private readonly _onceListeners = new Map<string, Set<RegisteredListener>>();
  private readonly _timeoutMs: number;
  private _closed = false;

  constructor(
    private readonly transport: CdpTransport,
    options?: CdpClientOptions,
  ) {
    this._timeoutMs = options?.timeoutMs ?? 30_000;

    this.transport.onMessage((raw) => this._dispatch(raw));

    this.transport.onError((err) => {
      this._rejectAll(new Error(`Transport error: ${err.message}`));
    });

    this.transport.onClose(() => {
      this._rejectAll(new Error("Transport closed unexpectedly"));
    });
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    if (this._closed) {
      return Promise.reject(new Error("CdpClient is closed"));
    }
    if (!this.transport.connected) {
      return Promise.reject(new Error("Transport is not connected"));
    }

    const id = this._nextId++;
    const message: Record<string, unknown> = { id, method };
    if (params !== undefined) message.params = params;
    if (sessionId !== undefined) message.sessionId = sessionId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP call "${method}" timed out after ${this._timeoutMs}ms`));
      }, this._timeoutMs);

      this._pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      // send() returning false means backpressure, not failure —
      // data is still queued. Actual errors come via onError/onClose.
      this.transport.send(JSON.stringify(message));
    });
  }

  on(method: string, callback: EventCallback, sessionId?: string): void {
    let set = this._listeners.get(method);
    if (!set) {
      set = new Set();
      this._listeners.set(method, set);
    }
    set.add({ callback, sessionId });
  }

  once(method: string, callback: EventCallback, sessionId?: string): void {
    let set = this._onceListeners.get(method);
    if (!set) {
      set = new Set();
      this._onceListeners.set(method, set);
    }
    set.add({ callback, sessionId });
  }

  off(method: string, callback: EventCallback): void {
    for (const map of [this._listeners, this._onceListeners]) {
      const set = map.get(method);
      if (set) {
        for (const entry of set) {
          if (entry.callback === callback) {
            set.delete(entry);
            break;
          }
        }
      }
    }
  }

  async close(): Promise<void> {
    this._closed = true;
    this._rejectAll(new Error("CdpClient closed"));
    await this.transport.close();
  }

  private _dispatch(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if ("id" in msg && typeof msg.id === "number") {
      // Response
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) {
        const cdpErr = msg.error as CdpError;
        pending.reject(
          new Error(`CDP error ${cdpErr.code}: ${cdpErr.message}`),
        );
      } else {
        pending.resolve(msg.result);
      }
    } else if ("method" in msg && typeof msg.method === "string") {
      // Event
      const eventMethod = msg.method;
      const params = msg.params;
      const sessionId = msg.sessionId as string | undefined;

      const listeners = this._listeners.get(eventMethod);
      if (listeners) {
        for (const entry of listeners) {
          if (entry.sessionId === undefined || entry.sessionId === sessionId) {
            entry.callback(params, sessionId);
          }
        }
      }

      const onceListeners = this._onceListeners.get(eventMethod);
      if (onceListeners) {
        const toRemove: RegisteredListener[] = [];
        for (const entry of onceListeners) {
          if (entry.sessionId === undefined || entry.sessionId === sessionId) {
            entry.callback(params, sessionId);
            toRemove.push(entry);
          }
        }
        for (const entry of toRemove) {
          onceListeners.delete(entry);
        }
      }
    }
  }

  private _rejectAll(error: Error): void {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this._pending.delete(id);
    }
  }
}
