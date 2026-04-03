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
