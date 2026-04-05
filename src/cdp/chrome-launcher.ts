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
  /** Pfad zu einem echten Chrome-Profil (user-data-dir). Opt-in: nur gesetzt = aktiv. */
  profilePath?: string;
}

export interface LaunchOptions {
  headless?: boolean;
  /** Wenn gesetzt: Chrome nutzt dieses Verzeichnis als user-data-dir statt eines Temp-Verzeichnisses */
  profilePath?: string;
}

interface LaunchResult {
  cdpClient: CdpClient;
  transport: PipeTransport;
  process: ChildProcess;
  transportType: "pipe";
}

// ── AutoLaunch Resolution (Story 10.2) ────────────────────────────────

/**
 * Resolve the autoLaunch setting from environment variables and headless mode.
 * Pure function — no side effects, fully testable.
 *
 * - SILBERCUE_CHROME_AUTO_LAUNCH=true  → always auto-launch
 * - SILBERCUE_CHROME_AUTO_LAUNCH=false → never auto-launch
 * - unset → auto-launch when headless (server mode), skip when headed (developer mode)
 */
export function resolveAutoLaunch(
  env: Record<string, string | undefined>,
  headless: boolean,
): boolean {
  const val = env.SILBERCUE_CHROME_AUTO_LAUNCH;
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  if (val === undefined) {
    // Default: autoLaunch = true when headless (server mode), false when headed (developer mode)
    return headless;
  }
  // Invalid env value (e.g. "foo", "bar") → safe default: no auto-launch
  return false;
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

  let userDataDir: string;
  let tmpDir: string | undefined;

  if (options?.profilePath) {
    // Validate that the profile path exists
    if (!existsSync(options.profilePath)) {
      throw new Error(
        `Chrome profile path does not exist: ${options.profilePath}`,
      );
    }
    userDataDir = options.profilePath;
    // No tmpDir — profile directory must NEVER be deleted
  } else {
    // Default: isolated temp profile
    tmpDir = join(
      tmpdir(),
      `silbercuechrome-${randomBytes(4).toString("hex")}`,
    );
    await mkdir(tmpDir, { recursive: true });
    userDataDir = tmpDir;
  }

  const flags = [...CHROME_FLAGS, `--user-data-dir=${userDataDir}`];
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
    // B1: 5s pipe startup timeout (NFR11/NFR14 compliance)
    await Promise.race([
      cdpClient.send("Browser.getVersion"),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Chrome startup timed out after 5s")),
          5_000,
        ),
      ),
    ]);

    return { cdpClient, transport, process: child, transportType: "pipe" };
  } catch (err) {
    // Cleanup on failure — only delete temp directories, NEVER profile directories
    child.kill();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
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
  timeoutMs = 500,
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

  // Reconnect fields (Story 5.2)
  private _cdpClient: CdpClient;
  private _transport: CdpTransport;
  private _childProcess: ChildProcess | undefined;
  private _tmpDir: string | undefined;
  private _reconnecting = false;
  private _onReconnect: ((connection: ChromeConnection) => Promise<void>) | null = null;
  private readonly _headless: boolean;
  private readonly _port: number;
  private readonly _profilePath: string | undefined;

  constructor(
    cdpClient: CdpClient,
    transport: CdpTransport,
    public readonly transportType: TransportType,
    childProcess: ChildProcess | undefined,
    tmpDir: string | undefined,
    _launcher?: ChromeLauncher,
    port?: number,
    headless?: boolean,
    profilePath?: string,
  ) {
    this._cdpClient = cdpClient;
    this._transport = transport;
    this._childProcess = childProcess;
    this._tmpDir = tmpDir;
    this._port = port ?? 9222;
    this._headless = headless ?? true;
    this._profilePath = profilePath;

    // C1 fix: Passive status tracking via CdpClient.onClose —
    // detects unexpected transport close (WebSocket drop, pipe break)
    this._setupOnClose(cdpClient);

    if (this._childProcess) {
      this._setupChildProcessHandlers(this._childProcess);
    }
  }

  get cdpClient(): CdpClient {
    return this._cdpClient;
  }

  get transport(): CdpTransport {
    return this._transport;
  }

  get childProcess(): ChildProcess | undefined {
    return this._childProcess;
  }

  /** Register a callback to be invoked after successful reconnect for re-wiring */
  onReconnect(callback: (connection: ChromeConnection) => Promise<void>): void {
    this._onReconnect = callback;
  }

  /**
   * Attempt to reconnect to Chrome with exponential backoff.
   * BUG-004 fix: No race window (_reconnecting stays true during entire loop),
   * failed transports are cleaned up, and onReconnect errors don't short-circuit.
   * Returns true if reconnect succeeded, false otherwise.
   */
  async reconnect(): Promise<boolean> {
    if (this._reconnecting || this._closed) return false;
    this._reconnecting = true;
    this.status = "reconnecting";

    // Best-effort close old client/transport
    try {
      await this._cdpClient.close();
    } catch {
      /* best-effort */
    }

    const maxAttempts = 5;
    const baseDelay = 500; // Exponential backoff: 500, 1000, 2000, 4000ms

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // B2: Check _closed inside the loop so close() during reconnect aborts immediately
      if (this._closed) {
        this._reconnecting = false;
        return false;
      }

      if (attempt > 1) {
        const delay = baseDelay * Math.pow(2, attempt - 2);
        await new Promise((r) => setTimeout(r, delay));
        // B2: Re-check after the pause — close() may have been called while waiting
        if (this._closed) {
          this._reconnecting = false;
          return false;
        }
        // BUG-004: Clean up transport from previous failed attempt to prevent leaks
        try {
          await this._cdpClient.close();
        } catch {
          /* best-effort */
        }
      }

      try {
        if (this.transportType === "websocket") {
          // WebSocket reconnect: Chrome is still running, reconnect to same port
          // B1: fetchJsonVersion uses 500ms default, WebSocket connect 2s
          const versionInfo = await fetchJsonVersion(this._port);
          if (!versionInfo.webSocketDebuggerUrl) {
            throw new Error("Missing webSocketDebuggerUrl");
          }
          const wsUrl = versionInfo.webSocketDebuggerUrl as string;
          const newTransport = await WebSocketTransport.connect(wsUrl, { timeoutMs: 2000 });
          const newClient = new CdpClient(newTransport);
          await newClient.send("Browser.getVersion");

          this._transport = newTransport;
          this._cdpClient = newClient;
        } else {
          // Pipe reconnect: Chrome process is dead, relaunch
          const result = await launchChrome({ headless: this._headless, profilePath: this._profilePath });
          this._transport = result.transport;
          this._cdpClient = result.cdpClient;

          // Clean up old child process handlers
          if (this._exitHandler) {
            globalThis.process.removeListener("exit", this._exitHandler);
            this._exitHandler = null;
          }

          this._childProcess = result.process;

          if (this._profilePath) {
            // Profile path: no tmpDir — profile directory must NEVER be deleted
            this._tmpDir = undefined;
          } else {
            const tmpDirFlag = result.process.spawnargs.find((a) =>
              a.startsWith("--user-data-dir="),
            );
            this._tmpDir = tmpDirFlag?.split("=")[1];
          }

          // Setup handlers for new child process
          this._setupChildProcessHandlers(this._childProcess);
        }

        // Setup onClose for the new CdpClient to detect future disconnects
        this._setupOnClose(this._cdpClient);

        // Invoke onReconnect callback BEFORE setting status to connected.
        // BUG-004 fix: If callback fails, DON'T throw — let the loop continue
        // to the next attempt. _reconnecting stays true (no race window).
        if (this._onReconnect) {
          await this._onReconnect(this);
        }

        this.status = "connected";
        this._reconnecting = false;

        debug("Reconnect succeeded on attempt %d", attempt);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debug("Reconnect attempt %d/%d failed: %s", attempt, maxAttempts, msg);
      }
    }

    this.status = "disconnected";
    this._reconnecting = false;
    debug("All %d reconnect attempts failed", maxAttempts);
    return false;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.status = "disconnected";

    // Remove process listeners to prevent accumulation
    if (this._exitHandler)
      globalThis.process.removeListener("exit", this._exitHandler);

    // Close CDP client (which closes the transport)
    await this._cdpClient.close();

    // Terminate child process if we launched it
    if (this._childProcess && !this._childProcess.killed) {
      if (globalThis.process.platform === "win32") {
        // H3 fix: On Windows, kill() sends taskkill — no SIGTERM/SIGKILL distinction
        this._childProcess.kill();
      } else {
        // POSIX: SIGTERM first, force SIGKILL after 5s
        this._childProcess.kill("SIGTERM");
        const forceTimer = setTimeout(() => {
          if (!this._childProcess!.killed) {
            this._childProcess!.kill("SIGKILL");
          }
        }, 5000);
        forceTimer.unref();
        this._childProcess.once("exit", () => clearTimeout(forceTimer));
      }
    }

    // Clean up tmp user-data-dir
    if (this._tmpDir) {
      await rm(this._tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Register onClose callback on a CdpClient to trigger reconnect on unexpected disconnect.
   *  BUG-004 fix: fired-flag prevents handler accumulation across reconnect attempts. */
  private _setupOnClose(client: CdpClient): void {
    let fired = false;
    client.onClose(() => {
      if (fired || this._closed) return;
      fired = true;
      this.status = "disconnected";
      // Fire-and-forget reconnect
      this.reconnect().catch((err) => {
        debug("Reconnect error: %s", err instanceof Error ? err.message : String(err));
      });
    });
  }

  /** Setup child process exit handler and global exit cleanup */
  private _setupChildProcessHandlers(child: ChildProcess): void {
    // Track status on child process exit + trigger reconnect
    child.on("exit", () => {
      if (this._closed) return; // deliberate shutdown
      this.status = "disconnected";
      debug("Chrome process exited, attempting relaunch...");
      this.reconnect().catch((err) => {
        debug("Reconnect after crash error: %s", err instanceof Error ? err.message : String(err));
      });
    });

    // H4 fix: Only register 'exit' handler for sync cleanup
    this._exitHandler = () => {
      if (this._closed) return;
      this._childProcess?.kill();
    };
    globalThis.process.on("exit", this._exitHandler);
  }
}

// ── ChromeLauncher (Task 4) ───────────────────────────────────────────

export class ChromeLauncher {
  private readonly _port: number;
  private readonly _autoLaunch: boolean;
  private readonly _headless: boolean;
  private readonly _profilePath: string | undefined;

  constructor(options?: ChromeConnectionOptions) {
    this._port = options?.port ?? 9222;
    this._autoLaunch = options?.autoLaunch ?? true;
    this._headless = options?.headless ?? true;
    this._profilePath = options?.profilePath;
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
    const result = await launchChrome({ headless: this._headless, profilePath: this._profilePath });

    // Extract tmpDir from the spawn args — only for temp profiles (no profilePath)
    let tmpDir: string | undefined;
    if (!this._profilePath) {
      const tmpDirFlag = result.process.spawnargs.find((a) =>
        a.startsWith("--user-data-dir="),
      );
      tmpDir = tmpDirFlag?.split("=")[1];
    }

    const connection = new ChromeConnection(
      result.cdpClient,
      result.transport,
      result.transportType,
      result.process,
      tmpDir,
      this,
      this._port,
      this._headless,
      this._profilePath,
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

    if (this._profilePath) {
      debug("Connected via WebSocket to existing Chrome — profilePath ignored (only affects Auto-Launch)");
    } else {
      debug("Connected via WebSocket");
    }
    return new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
      this,
      port,
      this._headless,
    );
  }
}
