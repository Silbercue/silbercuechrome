export interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpResponse {
  id: number;
  result?: unknown;
  error?: CdpError;
}

export interface CdpEvent {
  method: string;
  params?: unknown;
  sessionId?: string;
}

export interface CdpError {
  code: number;
  message: string;
}
