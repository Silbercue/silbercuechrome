export interface ToolMeta {
  [key: string]: unknown;
  elapsedMs: number;
  method: string;
}

export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<ToolContentBlock>;
  isError?: boolean;
  _meta?: ToolMeta;
}

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

export type TransportType = "pipe" | "websocket";

/**
 * Story 18.1: Options-Objekt fuer `ToolRegistry.executeTool()`.
 *
 * Wurde eingefuehrt, um `run_plan` zu erlauben, den `onToolResult`-Hook
 * (Ambient Context) fuer Zwischen-Steps zu unterdruecken. Das Flag ist
 * strikt opt-in — Default (`undefined` oder leeres Objekt) laesst das
 * bestehende Verhalten unveraendert.
 *
 * Fuer neue Flags: hier andocken, nicht die `executeTool`-Signatur weiter
 * verbreitern.
 *
 * @see docs/friction-fixes.md#FR-033
 */
export interface ExecuteToolOptions {
  /**
   * Wenn `true`, wird der `onToolResult`-Pro-Hook (DOM-Diff, Compact-Snapshot,
   * u.a.) **nicht** ueber das Tool-Ergebnis gelegt. `a11yTree.reset()` auf
   * Navigate, Dialog-Notifications und Relaunch-Notices laufen weiterhin —
   * nur die Ambient-Context-Anreicherung wird uebersprungen.
   *
   * `run_plan` setzt das Flag auf alle Zwischen-Steps, um 2000+ Tokens und
   * 1000+ ms pro Plan zu sparen. Am Plan-Ende wird der Hook genau einmal
   * ueber das letzte Step-Ergebnis gelegt (Aggregations-Hook).
   */
  skipOnToolResultHook?: boolean;
}
