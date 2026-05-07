import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, copyFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  /** Launch Chrome in headless mode (default: false — browser is visible by default) */
  headless?: boolean;
  /** Chrome user-data-dir (root). When set with profileDirectory, launches with a real profile. */
  profilePath?: string;
  /** Chrome --profile-directory value (e.g. "Profile 1"). Requires profilePath. */
  profileDirectory?: string;
  /** Whether this is a real user profile (preserves extensions, sync, etc.) */
  isRealProfile?: boolean;
  /**
   * Whether ChromeConnection should attempt a background reconnect loop
   * when the CDP transport closes or the Chrome child process exits.
   *
   * - `true` (default) — legacy behaviour: 5 retry attempts with exponential
   *   backoff, fired automatically from the onClose handler.
   * - `false` — no background retries. Disconnect only flips `status` to
   *   `"disconnected"` and the next caller (typically `BrowserSession.
   *   ensureReady()`) is responsible for recovery. This is the mode used
   *   by the lazy-launch architecture to avoid racing with its own
   *   smart-retry policy.
   */
  autoReconnect?: boolean;
}

export interface LaunchOptions {
  headless?: boolean;
  /** Wenn gesetzt: Chrome nutzt dieses Verzeichnis als user-data-dir statt eines Temp-Verzeichnisses */
  profilePath?: string;
  /** Chrome --profile-directory value (e.g. "Profile 1"). Requires profilePath. */
  profileDirectory?: string;
  /** Real user profile: don't disable extensions/sync. */
  isRealProfile?: boolean;
  /** CDP debugging port for --remote-debugging-port flag (default: 9222) */
  port?: number;
}

interface LaunchResult {
  cdpClient: CdpClient;
  transport: CdpTransport;
  process: ChildProcess;
  transportType: TransportType;
}

// ── AutoLaunch Resolution (Story 10.2) ────────────────────────────────

/**
 * Resolve the autoLaunch setting from environment variables.
 * Pure function — no side effects, fully testable.
 *
 * - SILBERCUE_CHROME_AUTO_LAUNCH=true  → always auto-launch
 * - SILBERCUE_CHROME_AUTO_LAUNCH=false → never auto-launch
 * - unset → default: auto-launch (zero-config UX for new users)
 *
 * The `_headless` parameter is kept for backwards-compat with call-sites,
 * but no longer influences the default — auto-launch is the standard path.
 */
export function resolveAutoLaunch(
  env: Record<string, string | undefined>,
  _headless: boolean,
): boolean {
  const val = env.SILBERCUE_CHROME_AUTO_LAUNCH;
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  if (val === undefined) {
    // Default: always auto-launch — user gets zero-config UX
    return true;
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

// ── Chrome Spawn (Task 2) ────────────────────────────────────────────

const CHROME_FLAGS_CORE = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--enable-features=CDPScreenshotNewSurface",
  "--mute-audio",
  "--disable-blink-features=AutomationControlled",
];

const CHROME_FLAGS_ISOLATED = [
  "--disable-extensions",
  "--disable-sync",
];

/**
 * Poll /json/version until Chrome responds, then connect via WebSocket.
 * Used for real profile launches where --remote-debugging-pipe is not available.
 */
async function pollAndConnectWebSocket(
  port: number,
  child: ChildProcess,
  timeoutMs: number,
): Promise<CdpTransport> {
  const start = Date.now();
  const pollInterval = 500;
  let lastError: Error | undefined;

  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited with code ${child.exitCode} before CDP was ready`);
    }
    try {
      const versionInfo = await fetchJsonVersion(port, 2000);
      if (versionInfo.webSocketDebuggerUrl) {
        return WebSocketTransport.connect(versionInfo.webSocketDebuggerUrl as string, { timeoutMs: 5000 });
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw lastError ?? new Error(`Chrome did not respond on port ${port} within ${timeoutMs}ms`);
}

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
  const isRealProfile = options?.isRealProfile ?? false;

  if (isRealProfile && options?.profilePath && options?.profileDirectory) {
    // Real profile: Chrome rejects --remote-debugging-port on the default
    // user-data-dir. Workaround: create a wrapper dir that symlinks the
    // profile folder. Chrome sees a "non-default" dir but uses the real data.
    if (!existsSync(options.profilePath)) {
      throw new Error(
        `Chrome profile path does not exist: ${options.profilePath}`,
      );
    }
    const profileSubdir = join(options.profilePath, options.profileDirectory);
    if (!existsSync(profileSubdir)) {
      throw new Error(
        `Chrome profile directory does not exist: ${profileSubdir}`,
      );
    }
    tmpDir = join(
      tmpdir(),
      `public-browser-profile-${randomBytes(4).toString("hex")}`,
    );
    await mkdir(tmpDir, { recursive: true });

    // Copy Local State (profile metadata) and create First Run marker
    const localStatePath = join(options.profilePath, "Local State");
    if (existsSync(localStatePath)) {
      copyFileSync(localStatePath, join(tmpDir, "Local State"));
    }
    writeFileSync(join(tmpDir, "First Run"), "");

    // Symlink the actual profile directory into the wrapper
    symlinkSync(profileSubdir, join(tmpDir, options.profileDirectory));

    userDataDir = tmpDir;
  } else if (options?.profilePath) {
    // Raw path mode (backward compat)
    if (!existsSync(options.profilePath)) {
      throw new Error(
        `Chrome profile path does not exist: ${options.profilePath}`,
      );
    }
    userDataDir = options.profilePath;
  } else {
    // Default: isolated temp profile
    tmpDir = join(
      tmpdir(),
      `public-browser-${randomBytes(4).toString("hex")}`,
    );
    await mkdir(tmpDir, { recursive: true });
    userDataDir = tmpDir;
  }

  const port = options?.port ?? 9222;
  const baseFlags = isRealProfile
    ? [...CHROME_FLAGS_CORE]
    : [...CHROME_FLAGS_CORE, ...CHROME_FLAGS_ISOLATED];

  // Real profiles: WebSocket only (Chrome rejects --remote-debugging-pipe
  // with the default user-data-dir). Temp profiles: pipe for lower latency.
  if (!isRealProfile) {
    baseFlags.unshift("--remote-debugging-pipe");
  }

  const flags = [...baseFlags, `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`];

  if (options?.profileDirectory) {
    flags.push(`--profile-directory=${options.profileDirectory}`);
  }

  if (options?.headless !== false) {
    flags.unshift("--headless=new");
  }

  debug("Spawning Chrome: %s %s", chromePath, flags.join(" "));

  // stdio layout: real profiles don't use pipe FDs 3/4
  const stdioConfig: ("ignore" | "pipe")[] = isRealProfile
    ? ["ignore", "ignore", "pipe"]
    : ["ignore", "ignore", "pipe", "pipe", "pipe"];

  const child = spawn(chromePath, flags, {
    stdio: stdioConfig,
  });

  try {
    if (isRealProfile) {
      // WebSocket path: poll /json/version until Chrome is ready, then connect
      const wsTransport = await pollAndConnectWebSocket(port, child, 15_000);
      const cdpClient = new CdpClient(wsTransport);
      await cdpClient.send("Browser.getVersion");
      return { cdpClient, transport: wsTransport, process: child, transportType: "websocket" as TransportType };
    }

    // Pipe path (default for temp profiles)
    const cdpReadable = child.stdio[4] as Readable;
    const cdpWritable = child.stdio[3] as Writable;
    const transport = new PipeTransport(cdpReadable, cdpWritable);
    const cdpClient = new CdpClient(transport);

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
  private readonly _autoReconnect: boolean;

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
    autoReconnect?: boolean,
  ) {
    this._cdpClient = cdpClient;
    this._transport = transport;
    this._childProcess = childProcess;
    this._tmpDir = tmpDir;
    this._port = port ?? 9222;
    this._headless = headless ?? false;
    this._profilePath = profilePath;
    // Default to true for legacy callers (chrome-launcher.test.ts still
    // exercises the background-retry path). BrowserSession passes `false`.
    this._autoReconnect = autoReconnect ?? true;

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

  get headless(): boolean {
    return this._headless;
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
          const result = await launchChrome({ headless: this._headless, profilePath: this._profilePath, port: this._port });
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
   *  BUG-004 fix: fired-flag prevents handler accumulation across reconnect attempts.
   *  Lazy-launch refactor: background reconnect is skipped when autoReconnect is false. */
  private _setupOnClose(client: CdpClient): void {
    let fired = false;
    client.onClose(() => {
      if (fired || this._closed) return;
      fired = true;
      this.status = "disconnected";
      if (!this._autoReconnect) return;
      // Fire-and-forget reconnect
      this.reconnect().catch((err) => {
        debug("Reconnect error: %s", err instanceof Error ? err.message : String(err));
      });
    });
  }

  /** Setup child process exit handler and global exit cleanup */
  private _setupChildProcessHandlers(child: ChildProcess): void {
    // Track status on child process exit + (optionally) trigger reconnect.
    child.on("exit", () => {
      if (this._closed) return; // deliberate shutdown
      this.status = "disconnected";
      if (!this._autoReconnect) return;
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
  private readonly _profileDirectory: string | undefined;
  private readonly _isRealProfile: boolean;
  private readonly _autoReconnect: boolean;

  constructor(options?: ChromeConnectionOptions) {
    this._port = options?.port ?? 9222;
    this._autoLaunch = options?.autoLaunch ?? true;
    this._headless = options?.headless ?? false;
    this._profilePath = options?.profilePath;
    this._profileDirectory = options?.profileDirectory;
    this._isRealProfile = options?.isRealProfile ?? false;
    this._autoReconnect = options?.autoReconnect ?? true;
  }

  /**
   * WebSocket-only connect — probiert ausschliesslich den existierenden
   * Chrome auf Port 9222 zu erreichen. Faellt NICHT auf Auto-Launch zurueck.
   *
   * Wird vom BrowserSession-Retry-Loop genutzt, wenn wir nach einem
   * Verbindungsverlust versuchen, dieselbe Chrome-Instanz wieder zu erwischen
   * (statt eine frische zu launchen und damit die User-Session zu verlieren).
   */
  async connectToExistingChrome(): Promise<ChromeConnection> {
    debug("Trying WebSocket-only on port %d...", this._port);
    return this._connectViaWebSocket(this._port);
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
    const result = await launchChrome({
      headless: this._headless,
      profilePath: this._profilePath,
      profileDirectory: this._profileDirectory,
      isRealProfile: this._isRealProfile,
      port: this._port,
    });

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
      this._autoReconnect,
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

    // Auto-detect headless from /json/version Browser field.
    // Headed Chrome reports "Chrome/...", headless reports "HeadlessChrome/...".
    const browserString = typeof versionInfo.Browser === "string" ? versionInfo.Browser : "";
    const detectedHeadless = browserString.includes("HeadlessChrome");
    if (detectedHeadless !== this._headless) {
      debug("Headless auto-detected=%s (Browser: %s), overriding env setting=%s", detectedHeadless, browserString, this._headless);
    }

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
      detectedHeadless,
      undefined, // profilePath ignored for WebSocket path
      this._autoReconnect,
    );
  }
}
