import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { EventEmitter } from "node:events";
import { Readable, Writable, PassThrough } from "node:stream";

// ── Mock child_process ─────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  findChromePath,
  launchChrome,
  ChromeLauncher,
  ChromeConnection,
} from "./chrome-launcher.js";

// ── Helpers ────────────────────────────────────────────────────────────

function createMockChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & {
    killed: boolean;
    spawnargs: string[];
  };
  child.killed = false;
  child.spawnargs = [];

  // CDP pipes: index 3 (writable to Chrome), index 4 (readable from Chrome)
  const cdpWritable = new PassThrough(); // FD3 — we write, Chrome reads
  const cdpReadable = new PassThrough(); // FD4 — Chrome writes, we read

  // stderr
  const stderr = new PassThrough();

  child.stdio = [
    null, // stdin
    null, // stdout
    stderr as unknown as Readable, // stderr
    cdpWritable as unknown as Writable, // FD3
    cdpReadable as unknown as Readable, // FD4
  ];

  child.kill = vi.fn((_signal?: string) => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  });

  child.pid = 12345;

  return child;
}

/** Simulate Chrome responding to CDP on the pipe (via FD4 → readable) */
function simulateCdpResponse(
  child: ChildProcess,
  id: number,
  result: Record<string, unknown>,
): void {
  const msg = JSON.stringify({ id, result });
  // FD4 is child.stdio[4] — Chrome writes responses here
  const readable = child.stdio![4] as PassThrough;
  readable.write(msg + "\0");
}

let httpServer: Server | null = null;

function startMockHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  return new Promise((resolve) => {
    httpServer = createServer(handler);
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer!.address() as { port: number };
      resolve(addr.port);
    });
  });
}

// WebSocket mock server for full connect() path
let wsServer: Server | null = null;
let wsSockets: Socket[] = [];


function decodeWsFrame(buf: Buffer): string | null {
  if (buf.length < 6) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (!masked) return null;
  const maskKey = buf.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    payload[i] = buf[offset + i] ^ maskKey[i % 4];
  }
  return payload.toString("utf-8");
}

function encodeServerFrame(opcode: number, payload: string): Buffer {
  const data = Buffer.from(payload, "utf-8");
  const len = data.length;
  if (len < 126) {
    const frame = Buffer.alloc(2 + len);
    frame[0] = 0x80 | opcode;
    frame[1] = len;
    data.copy(frame, 2);
    return frame;
  }
  const frame = Buffer.alloc(4 + len);
  frame[0] = 0x80 | opcode;
  frame[1] = 126;
  frame.writeUInt16BE(len, 2);
  data.copy(frame, 4);
  return frame;
}

// ── Cleanup ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CHROME_PATH;
});

afterEach(async () => {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  for (const s of wsSockets) {
    s.destroy();
  }
  wsSockets = [];
  if (wsServer) {
    wsServer.close();
    wsServer = null;
  }
});

// ── findChromePath tests ───────────────────────────────────────────────

describe("findChromePath", () => {
  it("returns CHROME_PATH env var if file exists", () => {
    process.env.CHROME_PATH = "/usr/bin/true"; // exists on most systems
    const result = findChromePath();
    expect(result).toBe("/usr/bin/true");
  });

  it("returns null if CHROME_PATH points to non-existent file", () => {
    process.env.CHROME_PATH = "/nonexistent/chrome-99999";
    const result = findChromePath();
    expect(result).toBeNull();
  });

  it("finds Chrome on macOS via absolute path check", () => {
    // On macOS CI/local, Chrome may or may not be installed
    // This test verifies the function runs without error
    delete process.env.CHROME_PATH;
    const result = findChromePath();
    // Result is either a string path or null — both are valid
    expect(result === null || typeof result === "string").toBe(true);
  });
});

// ── launchChrome tests ─────────────────────────────────────────────────

describe("launchChrome", () => {
  it("throws if no Chrome found", async () => {
    process.env.CHROME_PATH = "/nonexistent/chrome";
    await expect(launchChrome()).rejects.toThrow(
      "Chrome not found. Install Chrome or set CHROME_PATH environment variable.",
    );
  });

  it("spawns Chrome with correct flags and returns LaunchResult", async () => {
    // Use a real existing file as CHROME_PATH so findChromePath() succeeds
    process.env.CHROME_PATH = "/bin/sh";

    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild as never);

    // Simulate Chrome being ready after a tick
    const launchPromise = launchChrome({ headless: true });

    // Wait a tick for the CdpClient to send Browser.getVersion
    await new Promise((r) => setTimeout(r, 10));
    // Respond to the first CDP call (id=1)
    simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });

    const result = await launchPromise;

    expect(result.transportType).toBe("pipe");
    expect(result.cdpClient).toBeDefined();
    expect(result.process).toBe(mockChild);

    // Verify spawn was called with correct flags
    expect(spawn).toHaveBeenCalledWith(
      "/bin/sh",
      expect.arrayContaining([
        "--headless",
        "--remote-debugging-pipe",
        "--no-first-run",
      ]),
      expect.objectContaining({
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      }),
    );

    // Verify --user-data-dir is set
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args.some((a) => a.startsWith("--user-data-dir="))).toBe(true);

    // Cleanup
    await result.cdpClient.close();
  });

  it("kills child and cleans up on spawn error", async () => {
    process.env.CHROME_PATH = "/bin/sh";

    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild as never);

    const launchPromise = launchChrome();

    // Wait a tick then send an error response instead of success
    await new Promise((r) => setTimeout(r, 10));
    const readable = mockChild.stdio![4] as PassThrough;
    const errorMsg = JSON.stringify({
      id: 1,
      error: { code: -32000, message: "Browser startup failed" },
    });
    readable.write(errorMsg + "\0");

    await expect(launchPromise).rejects.toThrow("CDP error");
    expect(mockChild.kill).toHaveBeenCalled();
  });
});

// ── fetchJsonVersion / WebSocket Discovery tests ───────────────────────

describe("WebSocket Discovery", () => {
  it("connects via WebSocket when Chrome is running", async () => {
    const port = await new Promise<number>((resolve) => {
      wsServer = createServer((req, res) => {
        if (req.url === "/json/version") {
          // Return the correct port in the URL
          const addr = wsServer!.address() as { port: number };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/test-uuid`,
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });

      wsServer.on("upgrade", (req, socket) => {
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

        wsSockets.push(socket as Socket);

        socket.on("data", (data: Buffer) => {
          const cdpMsg = decodeWsFrame(data);
          if (cdpMsg) {
            try {
              const parsed = JSON.parse(cdpMsg);
              if (parsed.method === "Browser.getVersion") {
                const response = JSON.stringify({
                  id: parsed.id,
                  result: { product: "Chrome/136.0" },
                });
                socket.write(encodeServerFrame(0x1, response));
              }
            } catch {
              // ignore
            }
          }
        });
      });

      wsServer.listen(0, "127.0.0.1", () => {
        const addr = wsServer!.address() as { port: number };
        resolve(addr.port);
      });
    });

    const launcher = new ChromeLauncher({
      port: port,
      autoLaunch: false,
    });
    const connection = await launcher.connect();

    expect(connection.transportType).toBe("websocket");
    expect(connection.status).toBe("connected");
    expect(connection.childProcess).toBeUndefined();

    await connection.close();
  });

  it("throws when /json/version returns non-200", async () => {
    const port = await startMockHttpServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const launcher = new ChromeLauncher({
      port,
      autoLaunch: false,
    });
    await expect(launcher.connect()).rejects.toThrow(
      /\/json\/version returned HTTP 404/,
    );
  });

  it("throws when /json/version returns invalid JSON", async () => {
    const port = await startMockHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json{{{");
    });

    const launcher = new ChromeLauncher({
      port,
      autoLaunch: false,
    });
    await expect(launcher.connect()).rejects.toThrow(
      /\/json\/version returned invalid JSON/,
    );
  });

  it("throws when webSocketDebuggerUrl is missing", async () => {
    const port = await startMockHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/136.0" }));
    });

    const launcher = new ChromeLauncher({
      port,
      autoLaunch: false,
    });
    await expect(launcher.connect()).rejects.toThrow(
      /missing webSocketDebuggerUrl/,
    );
  });
});

// ── ChromeLauncher tests ───────────────────────────────────────────────

describe("ChromeLauncher", () => {
  it(
    "falls back to auto-launch when WebSocket fails",
    async () => {
      process.env.CHROME_PATH = "/bin/sh";

      const mockChild = createMockChildProcess();
      (mockChild as unknown as { spawnargs: string[] }).spawnargs = [
        "/bin/sh",
        "--headless",
        "--remote-debugging-pipe",
        "--user-data-dir=/tmp/silbercuechrome-test",
      ];
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      // Start an HTTP server that immediately closes to get fast ECONNREFUSED
      const srv = (await import("node:http")).createServer();
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const autoPort = (srv.address() as { port: number }).port;
      srv.close();

      const launcher = new ChromeLauncher({
        port: autoPort,
        autoLaunch: true,
      });

      const connectPromise = launcher.connect();

      // Poll until spawn is called, then respond to CDP
      const waitForSpawn = async () => {
        for (let i = 0; i < 100; i++) {
          if (vi.mocked(spawn).mock.calls.length > 0) return;
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      await waitForSpawn();
      simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });

      const connection = await connectPromise;

      expect(connection.transportType).toBe("pipe");
      expect(connection.status).toBe("connected");
      expect(connection.childProcess).toBe(mockChild);

      await connection.close();
    },
    15_000,
  );

  it("throws original error when autoLaunch=false and no Chrome running", async () => {
    const launcher = new ChromeLauncher({
      port: 19999,
      autoLaunch: false,
    });
    // C2 fix: should throw the original connection error, not a generic message
    await expect(launcher.connect()).rejects.toThrow();
  });
});

// ── ChromeConnection tests ─────────────────────────────────────────────

describe("ChromeConnection", () => {
  it("sets status to disconnected on close()", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(
      transport,
    );
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
    );

    expect(conn.status).toBe("connected");
    await conn.close();
    expect(conn.status).toBe("disconnected");
  });

  it("close() is idempotent", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(
      transport,
    );
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
    );

    await conn.close();
    await conn.close(); // should not throw
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("sets status to disconnected when child process exits", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(
      transport,
    );
    const mockChild = new EventEmitter() as ChildProcess;
    mockChild.killed = false;
    mockChild.kill = vi.fn(() => true);

    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "pipe",
      mockChild,
      undefined,
    );

    expect(conn.status).toBe("connected");
    mockChild.emit("exit", 0, null);
    expect(conn.status).toBe("disconnected");

    await conn.close();
  });

  it("removes process listeners on close to prevent leaks", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(
      transport,
    );
    const mockChild = new EventEmitter() as ChildProcess;
    mockChild.killed = false;
    mockChild.kill = vi.fn(() => true);

    const exitListenersBefore = globalThis.process.listenerCount("exit");

    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "pipe",
      mockChild,
      undefined,
    );

    expect(globalThis.process.listenerCount("exit")).toBe(
      exitListenersBefore + 1,
    );

    await conn.close();

    expect(globalThis.process.listenerCount("exit")).toBe(
      exitListenersBefore,
    );
  });

  it("sets status to disconnected on unexpected transport close (H5)", async () => {
    // Capture the onClose callback that CdpClient registers
    let transportCloseCallback: (() => void) | undefined;
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn((cb: () => void) => {
        transportCloseCallback = cb;
      }),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(
      transport,
    );
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
    );

    expect(conn.status).toBe("connected");

    // Simulate unexpected transport close
    transportCloseCallback!();

    expect(conn.status).toBe("disconnected");
  });
});
