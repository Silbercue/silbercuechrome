export interface CdpTransport {
  send(message: string): boolean;
  onMessage(cb: (message: string) => void): void;
  onError(cb: (error: Error) => void): void;
  onClose(cb: () => void): void;
  close(): Promise<void>;
  readonly connected: boolean;
}
