import type { Readable, Writable } from "node:stream";
import type { CdpTransport } from "./transport.js";

export class PipeTransport implements CdpTransport {
  private _connected = true;
  private _buffer = "";
  private _messageCallback: ((message: string) => void) | null = null;
  private _errorCallback: ((error: Error) => void) | null = null;
  private _closeCallback: (() => void) | null = null;

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
  ) {
    this.readable.on("data", (chunk: Buffer) => {
      this._buffer += chunk.toString();
      const parts = this._buffer.split("\0");
      this._buffer = parts.pop()!;
      for (const part of parts) {
        if (part.length > 0 && this._messageCallback) {
          this._messageCallback(part);
        }
      }
    });

    this.readable.on("error", (err: Error) => {
      this._errorCallback?.(err);
    });

    this.writable.on("error", (err: Error) => {
      this._errorCallback?.(err);
    });

    this.readable.on("close", () => {
      if (!this._connected) return;
      this._connected = false;
      this._closeCallback?.();
    });

    this.writable.on("close", () => {
      if (!this._connected) return;
      this._connected = false;
      this._closeCallback?.();
    });
  }

  get connected(): boolean {
    return this._connected;
  }

  send(message: string): boolean {
    if (!this._connected) return false;
    return this.writable.write(message + "\0");
  }

  onMessage(cb: (message: string) => void): void {
    this._messageCallback = cb;
  }

  onError(cb: (error: Error) => void): void {
    this._errorCallback = cb;
  }

  onClose(cb: () => void): void {
    this._closeCallback = cb;
  }

  async close(): Promise<void> {
    this._connected = false;
    this.readable.destroy();
    this.writable.end();
  }
}
