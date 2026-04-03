export interface ToolMeta {
  elapsedMs: number;
  method: string;
}

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  _meta?: ToolMeta;
}

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

export type TransportType = "pipe" | "websocket";
