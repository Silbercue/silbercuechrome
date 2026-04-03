import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { WebSocketTransport } from "./websocket-transport.js";

let server: Server | null = null;
let activeSockets: Socket[] = [];

function startMockWsServer(
  onConnection?: (socket: Socket) => void,
): Promise<{ port: number; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  return new Promise((resolve) => {
    server = createServer();
    server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"] as string;
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-5AB0DC85B411")
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          "\r\n",
      );

      sockets.push(socket as Socket);
      activeSockets.push(socket as Socket);
      onConnection?.(socket as Socket);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      resolve({ port: addr.port, sockets });
    });
  });
}

function encodeServerFrame(opcode: number, payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  const len = data.length;

  if (len < 126) {
    const frame = Buffer.alloc(2 + len);
    frame[0] = 0x80 | opcode;
    frame[1] = len; // No mask from server
    data.copy(frame, 2);
    return frame;
  } else if (len < 65536) {
    const frame = Buffer.alloc(4 + len);
    frame[0] = 0x80 | opcode;
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
    data.copy(frame, 4);
    return frame;
  } else {
    const frame = Buffer.alloc(10 + len);
    frame[0] = 0x80 | opcode;
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    data.copy(frame, 10);
    return frame;
  }
}

function decodeClientFrame(buf: Buffer): { opcode: number; payload: Buffer } {
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLength = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    payloadLength = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    payloadLength = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLength);
    for (let i = 0; i < payloadLength; i++) {
      payload[i] = buf[offset + i] ^ maskKey[i % 4];
    }
    return { opcode, payload };
  }

  return { opcode, payload: buf.subarray(offset, offset + payloadLength) };
}

afterEach(async () => {
  for (const s of activeSockets) {
    if (!s.destroyed) s.destroy();
  }
  activeSockets = [];
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe("WebSocketTransport", () => {
  it("should connect via HTTP upgrade handshake", async () => {
    const { port } = await startMockWsServer();
    const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/devtools`);

    expect(transport.connected).toBe(true);
    await transport.close();
  });

  it("should send masked text frames", async () => {
    const received: Buffer[] = [];
    const { port } = await startMockWsServer((socket) => {
      socket.on("data", (chunk) => received.push(chunk));
    });

    const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/devtools`);
    transport.send('{"id":1,"method":"Page.navigate"}');

    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBeGreaterThanOrEqual(1);

    const decoded = decodeClientFrame(received[0]);
    expect(decoded.opcode).toBe(0x1); // Text frame
    expect(decoded.payload.toString()).toBe('{"id":1,"method":"Page.navigate"}');

    await transport.close();
  });

  it("should receive text messages from server", async () => {
    const { port, sockets } = await startMockWsServer();
    const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/devtools`);

    const messages: string[] = [];
    transport.onMessage((msg) => messages.push(msg));

    await new Promise((r) => setTimeout(r, 20));
    sockets[0].write(encodeServerFrame(0x1, '{"id":1,"result":{}}'));

    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toEqual(['{"id":1,"result":{}}']);

    await transport.close();
  });

  it("should handle multiple messages", async () => {
    const { port, sockets } = await startMockWsServer();
    const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/devtools`);

    const messages: string[] = [];
    transport.onMessage((msg) => messages.push(msg));

    await new Promise((r) => setTimeout(r, 20));
    sockets[0].write(encodeServerFrame(0x1, '{"id":1}'));
    sockets[0].write(encodeServerFrame(0x1, '{"id":2}'));

    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toEqual(['{"id":1}', '{"id":2}']);

    await transport.close();
  });

  it("should respond to ping with pong", async () => {
    const received: Buffer[] = [];
    const { port, sockets } = await startMockWsServer((socket) => {
      socket.on("data", (chunk) => received.push(chunk));
    });

    const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/devtools`);

    await new Promise((r) => setTimeout(r, 20));
    // Send ping from server
    const pingPayload = Buffer.from("heartbeat");
    sockets[0].write(encodeServerFrame(0x9, pingPayload));

    await new Promise((r) => setTimeout(r, 50));

    // Find the pong response (skip any other frames)
    const pongFrame = received.find((buf) => {
      const opcode = buf[0] & 0x0f;
      return opcode === 0xa; // Pong
    });
    expect(pongFrame).toBeDefined();

    const decoded = decodeClientFrame(pongFrame!);
    expect(decoded.opcode).toBe(0xa);
    expect(decoded.payload.toString()).toBe("heartbeat");

    await transport.close();
  });

  it("should handle server close frame", async () => {
    const { port, sockets } = await startMockWsServer();
    const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/devtools`);

    const closeCalled = new Promise<void>((resolve) => {
      transport.onClose(() => resolve());
    });

    await new Promise((r) => setTimeout(r, 20));
    sockets[0].write(encodeServerFrame(0x8, Buffer.alloc(0)));
    sockets[0].end();

    await closeCalled;
    expect(transport.connected).toBe(false);
  });

  it("should return false on send when disconnected", async () => {
    const { port } = await startMockWsServer();
    const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/devtools`);

    await transport.close();

    expect(transport.send("test")).toBe(false);
  });

  it("should handle extended payload length (16-bit)", async () => {
    const { port, sockets } = await startMockWsServer();
    const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/devtools`);

    const messages: string[] = [];
    transport.onMessage((msg) => messages.push(msg));

    // Create a payload > 125 bytes
    const largePayload = JSON.stringify({ data: "x".repeat(200) });

    await new Promise((r) => setTimeout(r, 20));
    sockets[0].write(encodeServerFrame(0x1, largePayload));

    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toEqual([largePayload]);

    await transport.close();
  });

  it("should handle extended payload length (64-bit)", async () => {
    const { port, sockets } = await startMockWsServer();
    const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/devtools`);

    const messages: string[] = [];
    transport.onMessage((msg) => messages.push(msg));

    // Create a payload > 65535 bytes to trigger 64-bit length encoding
    const largePayload = JSON.stringify({ data: "x".repeat(70000) });

    await new Promise((r) => setTimeout(r, 20));
    sockets[0].write(encodeServerFrame(0x1, largePayload));

    await new Promise((r) => setTimeout(r, 100));
    expect(messages).toEqual([largePayload]);

    await transport.close();
  });

  it("should timeout if server does not respond to upgrade", async () => {
    // Server that accepts connections but never sends upgrade response
    const hangingServer = createServer();
    hangingServer.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => hangingServer.on("listening", resolve));
    const addr = hangingServer.address() as { port: number };

    await expect(
      WebSocketTransport.connect(`ws://127.0.0.1:${addr.port}/devtools`, { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/i);

    await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
  });

  it("should reject on non-101 HTTP response", async () => {
    // Server that responds with 403 instead of upgrading
    const badServer = createServer((req, res) => {
      res.writeHead(403);
      res.end("Forbidden");
    });
    badServer.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => badServer.on("listening", resolve));
    const addr = badServer.address() as { port: number };

    await expect(
      WebSocketTransport.connect(`ws://127.0.0.1:${addr.port}/devtools`),
    ).rejects.toThrow(/HTTP 403/);

    await new Promise<void>((resolve) => badServer.close(() => resolve()));
  });

  it("should propagate socket errors via onError", async () => {
    const { port, sockets } = await startMockWsServer();
    const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${port}/devtools`);

    const errorCalled = new Promise<Error>((resolve) => {
      transport.onError((err) => resolve(err));
    });

    await new Promise((r) => setTimeout(r, 20));
    // resetAndDestroy sends RST which causes ECONNRESET on client
    sockets[0].resetAndDestroy();

    const err = await errorCalled;
    expect(err.message).toMatch(/ECONNRESET|connection reset/i);
  });
});
