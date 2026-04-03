import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import type { CdpTransport } from "./transport.js";

const OPCODES = {
  TEXT: 0x1,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export class WebSocketTransport implements CdpTransport {
  private _connected = true;
  private _messageCallback: ((message: string) => void) | null = null;
  private _errorCallback: ((error: Error) => void) | null = null;
  private _closeCallback: (() => void) | null = null;
  private _recvBuffer = Buffer.alloc(0);

  private constructor(private readonly socket: Socket) {
    this.socket.on("data", (chunk: Buffer) => this._onData(chunk));
    this.socket.on("error", (err: Error) => this._errorCallback?.(err));
    this.socket.on("close", () => {
      this._connected = false;
      this._closeCallback?.();
    });
  }

  static async connect(
    url: string,
    options?: { timeoutMs?: number },
  ): Promise<WebSocketTransport> {
    const parsed = new URL(url);
    const key = randomBytes(16).toString("base64");
    const timeoutMs = options?.timeoutMs ?? 30_000;

    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(new Error(`WebSocket connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const req = httpRequest({
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
        },
      });

      req.on("upgrade", (_res, socket) => {
        if (settled) {
          socket.destroy();
          return;
        }
        clearTimeout(timer);
        settled = true;

        const expectedAccept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-5AB0DC85B411")
          .digest("base64");
        const actualAccept = _res.headers["sec-websocket-accept"];

        if (actualAccept !== expectedAccept) {
          socket.destroy();
          reject(new Error("WebSocket handshake failed: invalid Sec-WebSocket-Accept"));
          return;
        }

        resolve(new WebSocketTransport(socket));
      });

      req.on("response", (res) => {
        if (settled) return;
        clearTimeout(timer);
        settled = true;
        reject(
          new Error(`WebSocket handshake failed: server returned HTTP ${res.statusCode}`),
        );
        req.destroy();
      });

      req.on("error", (err) => {
        if (settled) return;
        clearTimeout(timer);
        settled = true;
        reject(err);
      });

      req.end();
    });
  }

  get connected(): boolean {
    return this._connected;
  }

  send(message: string): boolean {
    if (!this._connected) return false;
    const payload = Buffer.from(message, "utf-8");
    const frame = this._encodeFrame(OPCODES.TEXT, payload);
    return this.socket.write(frame);
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
    if (!this._connected) return;
    this._connected = false;
    const closeFrame = this._encodeFrame(OPCODES.CLOSE, Buffer.alloc(0));
    this.socket.write(closeFrame);
    this.socket.end();
  }

  private _onData(chunk: Buffer): void {
    this._recvBuffer = Buffer.concat([this._recvBuffer, chunk]);

    while (this._recvBuffer.length >= 2) {
      const result = this._decodeFrame(this._recvBuffer);
      if (!result) break;

      const { opcode, payload, bytesConsumed } = result;
      this._recvBuffer = this._recvBuffer.subarray(bytesConsumed);

      switch (opcode) {
        case OPCODES.TEXT:
          this._messageCallback?.(payload.toString("utf-8"));
          break;
        case OPCODES.CLOSE:
          this._connected = false;
          // Send close frame back
          this.socket.write(this._encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
          this.socket.end();
          break;
        case OPCODES.PING:
          this.socket.write(this._encodeFrame(OPCODES.PONG, payload));
          break;
        case OPCODES.PONG:
          // Ignore unsolicited pongs
          break;
      }
    }
  }

  private _decodeFrame(
    buf: Buffer,
  ): { opcode: number; payload: Buffer; bytesConsumed: number } | null {
    if (buf.length < 2) return null;

    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let payloadLength = buf[1] & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (buf.length < 4) return null;
      payloadLength = buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (buf.length < 10) return null;
      // Read as BigInt, but CDP messages won't exceed Number.MAX_SAFE_INTEGER
      payloadLength = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }

    if (masked) {
      if (buf.length < offset + 4 + payloadLength) return null;
      const maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i++) {
        payload[i] = buf[offset + i] ^ maskKey[i % 4];
      }
      return { opcode, payload, bytesConsumed: offset + payloadLength };
    }

    if (buf.length < offset + payloadLength) return null;
    const payload = buf.subarray(offset, offset + payloadLength);
    return { opcode, payload: Buffer.from(payload), bytesConsumed: offset + payloadLength };
  }

  private _encodeFrame(opcode: number, payload: Buffer): Buffer {
    const mask = randomBytes(4);
    const payloadLength = payload.length;
    let header: Buffer;

    if (payloadLength < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode; // FIN + opcode
      header[1] = 0x80 | payloadLength; // MASK + length
      mask.copy(header, 2);
    } else if (payloadLength < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payloadLength, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payloadLength), 2);
      mask.copy(header, 10);
    }

    const maskedPayload = Buffer.alloc(payloadLength);
    for (let i = 0; i < payloadLength; i++) {
      maskedPayload[i] = payload[i] ^ mask[i % 4];
    }

    return Buffer.concat([header, maskedPayload]);
  }
}
