import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { CdpClient } from "./cdp-client.js";
import type { CdpTransport } from "../transport/transport.js";
import { PipeTransport } from "../transport/pipe-transport.js";
import { WebSocketTransport } from "../transport/websocket-transport.js";
import { debug } from "./debug.js";
import type { ConnectionStatus, TransportType } from "../types.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface ChromeConnectionOptions {
  /** Port for WebSocket discovery (default: 9222) */
  port?: number;
  /** Auto-launch Chrome if no running instance found (default: true) */
  autoLaunch?: boolean;
  /** Launch Chrome in headless mode (default: true) */
  headless?: boolean;
}

export interface LaunchOptions {
  headless?: boolean;
}

interface LaunchResult {
  cdpClient: CdpClient;
  transport: PipeTransport;
  process: ChildProcess;
  transportType: "pipe";
}

// ── Chrome Path Detection (Task 1) ────────────────────────────────────

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "google-chrome",
    "google-chrome-stable",
    "chromium-browser",
    "chromium",
  ],
  win32: [
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

export function findChromePath(): string | null {
  // CHROME_PATH env override
  const envPath = process.env.CHROME_PATH;
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    return null;
  }

  const platform = process.platform;
  const candidates = CHROME_PATHS[platform];
  if (!candidates) return null;

  if (platform === "linux") {
    // Linux: executable names — resolve via `which`
    for (const name of candidates) {
      try {
        const resolved = execFileSync("which", [name], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (resolved) return resolved;
      } catch {
        // not found, try next
      }
    }
    return null;
  }

  // macOS / Windows: absolute paths — check existence
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ── Chrome Spawn with CDP-Pipe (Task 2) ───────────────────────────────

const CHROME_FLAGS = [
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--mute-audio",
];

export async function launchChrome(
  options?: LaunchOptions,
): Promise<LaunchResult> {
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      "Chrome not found. Install Chrome or set CHROME_PATH environment variable.",
    );
  }

  const tmpDir = join(
    tmpdir(),
    `silbercuechrome-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(tmpDir, { recursive: true });

  const flags = [...CHROME_FLAGS, `--user-data-dir=${tmpDir}`];
  if (options?.headless !== false) {
    flags.unshift("--headless");
  }

  debug("Spawning Chrome: %s %s", chromePath, flags.join(" "));

  const child = spawn(chromePath, flags, {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });

  try {
    const cdpReadable = child.stdio[4] as Readable;
    const cdpWritable = child.stdio[3] as Writable;
    const transport = new PipeTransport(cdpReadable, cdpWritable);
    const cdpClient = new CdpClient(transport);

    // Wait for Chrome to be ready — Browser.getVersion must succeed
    await Promise.race([
      cdpClient.send("Browser.getVersion"),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Chrome startup timed out after 10s")),
          10_000,
        ),
      ),
    ]);

    return { cdpClient, transport, process: child, transportType: "pipe" };
  } catch (err) {
    // Cleanup on failure
    child.kill();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ── WebSocket Discovery (Task 3) ──────────────────────────────────────

interface VersionResponse {
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

async function fetchJsonVersion(
  port: number,
  timeoutMs = 2000,
): Promise<VersionResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`/json/version request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/json/version",
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        if (settled) return;

        if (res.statusCode !== 200) {
          clearTimeout(timer);
          settled = true;
          reject(
            new Error(
              `/json/version returned HTTP ${res.statusCode}`,
            ),
          );
          res.resume();
          return;
        }

        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          if (settled) return;
          clearTimeout(timer);
          settled = true;
          try {
            const parsed: unknown = JSON.parse(body);
            if (typeof parsed !== "object" || parsed === null) {
              reject(new Error("/json/version returned invalid JSON"));
              return;
            }
            resolve(parsed as VersionResponse);
          } catch {
            reject(new Error("/json/version returned invalid JSON"));
          }
        });
      },
    );

    req.on("error", (err) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(err);
    });

    req.end();
  });
}

// ── ChromeConnection (Task 4 + Task 6) ────────────────────────────────

export class ChromeConnection {
  public status: ConnectionStatus = "connected";

  private _exitHandler: (() => void) | null = null;
  private _closed = false;

  constructor(
    public readonly cdpClient: CdpClient,
    public readonly transport: CdpTransport,
    public readonly transportType: TransportType,
    public readonly childProcess: ChildProcess | undefined,
    private readonly _tmpDir: string | undefined,
  ) {
    // C1 fix: Passive status tracking via CdpClient.onClose —
    // detects unexpected transport close (WebSocket drop, pipe break)
    this.cdpClient.onClose(() => {
      this.status = "disconnected";
    });

    if (this.childProcess) {
      // Track status on child process exit
      this.childProcess.on("exit", () => {
        this.status = "disconnected";
      });

      // H4 fix: Only register 'exit' handler for sync cleanup —
      // no SIGINT/SIGTERM handlers that call process.exit()
      this._exitHandler = () => {
        if (this._closed) return;
        this.childProcess?.kill();
      };
      globalThis.process.on("exit", this._exitHandler);
    }
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.status = "disconnected";

    // Remove process listeners to prevent accumulation
    if (this._exitHandler)
      globalThis.process.removeListener("exit", this._exitHandler);

    // Close CDP client (which closes the transport)
    await this.cdpClient.close();

    // Terminate child process if we launched it
    if (this.childProcess && !this.childProcess.killed) {
      if (globalThis.process.platform === "win32") {
        // H3 fix: On Windows, kill() sends taskkill — no SIGTERM/SIGKILL distinction
        this.childProcess.kill();
      } else {
        // POSIX: SIGTERM first, force SIGKILL after 5s
        this.childProcess.kill("SIGTERM");
        const forceTimer = setTimeout(() => {
          if (!this.childProcess!.killed) {
            this.childProcess!.kill("SIGKILL");
          }
        }, 5000);
        forceTimer.unref();
        this.childProcess.once("exit", () => clearTimeout(forceTimer));
      }
    }

    // Clean up tmp user-data-dir
    if (this._tmpDir) {
      await rm(this._tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ── ChromeLauncher (Task 4) ───────────────────────────────────────────

export class ChromeLauncher {
  private readonly _port: number;
  private readonly _autoLaunch: boolean;
  private readonly _headless: boolean;

  constructor(options?: ChromeConnectionOptions) {
    this._port = options?.port ?? 9222;
    this._autoLaunch = options?.autoLaunch ?? true;
    this._headless = options?.headless ?? true;
  }

  async connect(): Promise<ChromeConnection> {
    // 1. Try WebSocket to existing Chrome
    debug("Trying WebSocket on port %d...", this._port);
    let wsError: Error | undefined;
    try {
      return await this._connectViaWebSocket(this._port);
    } catch (err) {
      wsError = err instanceof Error ? err : new Error(String(err));
      debug("WebSocket failed: %s", wsError.message);
    }

    // 2. Auto-launch if enabled
    // C2 fix: preserve original error for better diagnostics
    if (!this._autoLaunch) {
      throw wsError!;
    }

    debug("Launching Chrome...");
    const result = await launchChrome({ headless: this._headless });

    // Extract tmpDir from the spawn args
    const tmpDirFlag = result.process.spawnargs.find((a) =>
      a.startsWith("--user-data-dir="),
    );
    const tmpDir = tmpDirFlag?.split("=")[1];

    const connection = new ChromeConnection(
      result.cdpClient,
      result.transport,
      result.transportType,
      result.process,
      tmpDir,
    );

    debug("Connected via pipe");
    return connection;
  }

  private async _connectViaWebSocket(
    port: number,
  ): Promise<ChromeConnection> {
    const versionInfo = await fetchJsonVersion(port);

    if (!versionInfo.webSocketDebuggerUrl) {
      throw new Error(
        "/json/version response missing webSocketDebuggerUrl field",
      );
    }

    const wsUrl = versionInfo.webSocketDebuggerUrl as string;
    const transport = await WebSocketTransport.connect(wsUrl, {
      timeoutMs: 5000,
    });
    const cdpClient = new CdpClient(transport);

    // Verify connection
    await cdpClient.send("Browser.getVersion");

    debug("Connected via WebSocket");
    return new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
    );
  }
}
