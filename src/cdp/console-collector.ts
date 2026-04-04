import type { CdpClient } from "./cdp-client.js";
import { debug } from "./debug.js";

// --- Types ---

export interface ConsoleLogEntry {
  level: "info" | "warning" | "error" | "debug";
  text: string;
  timestamp: number;
  source: "console" | "exception";
}

export interface ConsoleCollectorOptions {
  maxEntries?: number;
}

// --- Level Mapping ---

const LEVEL_MAP: Record<string, ConsoleLogEntry["level"]> = {
  log: "info",
  info: "info",
  debug: "debug",
  warning: "warning",
  error: "error",
  assert: "error",
  trace: "info",
};

function mapLevel(type: string): ConsoleLogEntry["level"] {
  return LEVEL_MAP[type] ?? "info";
}

// --- Text Extraction ---

interface RemoteObject {
  type?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

function remoteObjectToString(obj: RemoteObject): string {
  if (obj.value !== undefined) return String(obj.value);
  if (obj.unserializableValue) return obj.unserializableValue;
  if (obj.description) return obj.description;
  return String(obj.type);
}

// --- ConsoleCollector ---

export class ConsoleCollector {
  private _buffer: ConsoleLogEntry[] = [];
  private _maxEntries: number;
  private _cdpClient: CdpClient;
  private _sessionId: string;
  private _consoleCallback: ((params: unknown) => void) | null = null;
  private _exceptionCallback: ((params: unknown) => void) | null = null;
  private _initialized = false;

  constructor(cdpClient: CdpClient, sessionId: string, options?: ConsoleCollectorOptions) {
    this._cdpClient = cdpClient;
    this._sessionId = sessionId;
    this._maxEntries = options?.maxEntries ?? 1000;
  }

  /**
   * Start listening for Runtime.consoleAPICalled and Runtime.exceptionThrown events.
   */
  init(): void {
    if (this._initialized) return;
    this._initialized = true;

    this._consoleCallback = (params: unknown) => {
      this._onConsoleAPICalled(params);
    };
    this._exceptionCallback = (params: unknown) => {
      this._onExceptionThrown(params);
    };

    this._cdpClient.on("Runtime.consoleAPICalled", this._consoleCallback, this._sessionId);
    this._cdpClient.on("Runtime.exceptionThrown", this._exceptionCallback, this._sessionId);
    debug("ConsoleCollector initialized on session %s", this._sessionId);
  }

  /**
   * Remove event listeners. Buffer is preserved.
   */
  detach(): void {
    this._initialized = false;
    if (this._consoleCallback) {
      this._cdpClient.off("Runtime.consoleAPICalled", this._consoleCallback);
      this._consoleCallback = null;
    }
    if (this._exceptionCallback) {
      this._cdpClient.off("Runtime.exceptionThrown", this._exceptionCallback);
      this._exceptionCallback = null;
    }
    debug("ConsoleCollector detached");
  }

  /**
   * Re-initialize after reconnect or tab switch.
   * Buffer is cleared on reinit (new page context = new logs).
   */
  reinit(cdpClient: CdpClient, sessionId: string): void {
    this.detach();
    this._cdpClient = cdpClient;
    this._sessionId = sessionId;
    this._buffer = [];
    this.init();
  }

  /**
   * Return a copy of all buffered log entries.
   */
  getAll(): ConsoleLogEntry[] {
    return [...this._buffer];
  }

  /**
   * Return filtered log entries. Both filters are combined with AND.
   * Throws if the regex pattern is invalid.
   */
  getFiltered(level?: string, pattern?: string): ConsoleLogEntry[] {
    if (!level && !pattern) return this.getAll();

    let regex: RegExp | undefined;
    if (pattern) {
      regex = new RegExp(pattern);
    }

    return this._buffer.filter((entry) => {
      if (level && entry.level !== level) return false;
      if (regex && !regex.test(entry.text)) return false;
      return true;
    });
  }

  /**
   * Clear the log buffer.
   */
  clear(): void {
    this._buffer = [];
  }

  /**
   * Current number of entries in the buffer.
   */
  get count(): number {
    return this._buffer.length;
  }

  // --- Internal ---

  private _pushEntry(entry: ConsoleLogEntry): void {
    if (this._buffer.length >= this._maxEntries) {
      this._buffer.shift();
    }
    this._buffer.push(entry);
  }

  private _onConsoleAPICalled(params: unknown): void {
    const p = params as {
      type?: string;
      args?: RemoteObject[];
      timestamp?: number;
    };

    const text = (p.args ?? []).map(remoteObjectToString).join(" ");

    this._pushEntry({
      level: mapLevel(p.type ?? "log"),
      text,
      timestamp: performance.now(),
      source: "console",
    });
  }

  private _onExceptionThrown(params: unknown): void {
    const p = params as {
      timestamp?: number;
      exceptionDetails?: {
        text?: string;
        exception?: {
          description?: string;
        };
      };
    };

    const text =
      p.exceptionDetails?.exception?.description ??
      p.exceptionDetails?.text ??
      "Unknown exception";

    this._pushEntry({
      level: "error",
      text,
      timestamp: performance.now(),
      source: "exception",
    });
  }
}
