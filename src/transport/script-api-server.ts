/**
 * Story 9.7: Script API Gateway (Server-Seite).
 *
 * HTTP-Server auf localhost:9223 der Python-Scripts Zugriff auf die
 * SilbercueChrome Tool-Implementierungen gibt — selber Code-Pfad wie MCP.
 *
 * Routes:
 *   POST /session/create  → neuen Tab erstellen, Session-Token zurückgeben
 *   POST /session/close   → Tab schließen, Session aufräumen
 *   POST /tool/{name}     → Tool via registry.executeTool() ausführen
 *
 * Nur aktiv wenn `--script` Flag gesetzt ist.
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import type { IBrowserSession } from "../cdp/browser-session.js";
import type { ToolResponse } from "../types.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface SessionInfo {
  sessionToken: string;
  targetId: string;
  cdpSessionId: string;
  lastSeen: number;
}

/**
 * Minimal interface for the ToolRegistry — only the method we actually call.
 * Avoids importing the full class (keeps coupling low).
 */
export interface ScriptApiToolRegistry {
  executeTool(
    name: string,
    params: Record<string, unknown>,
    sessionIdOverride?: string,
  ): Promise<ToolResponse>;
  hasHandler(name: string): boolean;
}

export interface ScriptApiServerOptions {
  port?: number;
  registry: ScriptApiToolRegistry;
  browserSession: IBrowserSession;
}

// ── Session Store ──────────────────────────────────────────────────────

export class SessionStore {
  private readonly _sessions = new Map<string, SessionInfo>();

  create(targetId: string, cdpSessionId: string): SessionInfo {
    const sessionToken = crypto.randomUUID();
    const info: SessionInfo = {
      sessionToken,
      targetId,
      cdpSessionId,
      lastSeen: Date.now(),
    };
    this._sessions.set(sessionToken, info);
    return info;
  }

  get(token: string): SessionInfo | undefined {
    return this._sessions.get(token);
  }

  touch(token: string): void {
    const info = this._sessions.get(token);
    if (info) {
      info.lastSeen = Date.now();
    }
  }

  delete(token: string): SessionInfo | undefined {
    const info = this._sessions.get(token);
    if (info) {
      this._sessions.delete(token);
    }
    return info;
  }

  /** Returns all sessions where `Date.now() - lastSeen > maxAgeMs`. */
  getOrphans(maxAgeMs: number): SessionInfo[] {
    const now = Date.now();
    const orphans: SessionInfo[] = [];
    for (const info of this._sessions.values()) {
      if (now - info.lastSeen > maxAgeMs) {
        orphans.push(info);
      }
    }
    return orphans;
  }

  /** Returns all sessions (for shutdown cleanup). */
  all(): SessionInfo[] {
    return [...this._sessions.values()];
  }

  get size(): number {
    return this._sessions.size;
  }
}

// ── Per-Session Call Queue ──────────────────────────────────────────────

/**
 * Simple serial queue per session. CDP commands on a single session must
 * be serialized — parallel calls on the same tab lead to races.
 */
class SessionQueue {
  private readonly _queues = new Map<string, Promise<void>>();

  async enqueue<T>(sessionToken: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._queues.get(sessionToken) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this._queues.set(sessionToken, next);

    // Wait for previous call to finish, then run ours.
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
      // Clean up queue entry if it's the last one.
      if (this._queues.get(sessionToken) === next) {
        this._queues.delete(sessionToken);
      }
    }
  }
}

// ── Script API Server ──────────────────────────────────────────────────

const ORPHAN_CHECK_INTERVAL_MS = 10_000;
const ORPHAN_TIMEOUT_MS = 30_000;
const DEFAULT_PORT = 9223;
const MAX_BODY_BYTES = 1_048_576; // 1 MB

export class ScriptApiServer {
  private _server: http.Server | null = null;
  private _orphanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly _port: number;
  private readonly _registry: ScriptApiToolRegistry;
  private readonly _browserSession: IBrowserSession;
  readonly sessionStore = new SessionStore();
  private readonly _queue = new SessionQueue();

  constructor(options: ScriptApiServerOptions) {
    this._port = options.port ?? (Number(process.env.SILBERCUE_SCRIPT_PORT) || DEFAULT_PORT);
    this._registry = options.registry;
    this._browserSession = options.browserSession;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
        if (err.code === "ECONNRESET" || !socket.writable) return;
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(
            `SilbercueChrome --script: Port ${this._port} already in use. Script API not available. MCP continues to work normally.`,
          );
          reject(err);
          return;
        }
        console.error(`SilbercueChrome --script: HTTP server error: ${err.message}`);
      });

      server.listen(this._port, "127.0.0.1", () => {
        this._server = server;
        this._startOrphanCleanup();
        console.error(`SilbercueChrome --script: Script API listening on http://localhost:${this._port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // 1. Stop orphan cleanup.
    if (this._orphanTimer) {
      clearInterval(this._orphanTimer);
      this._orphanTimer = null;
    }

    // 2. Close all sessions (best-effort tab cleanup).
    await this._closeAllSessions();

    // 3. Shut down HTTP server.
    if (this._server) {
      const server = this._server;
      this._server = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }

  get port(): number {
    return this._port;
  }

  get listening(): boolean {
    return this._server !== null && this._server.listening;
  }

  // ── Request Router ─────────────────────────────────────────────────

  private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // Only POST is supported.
    if (method !== "POST") {
      this._sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    // Route.
    if (pathname === "/session/create") {
      this._readBody(req, (raw) => {
        const body = this._parseJson(raw, res);
        if (body !== null) this._handleSessionCreate(body, res);
      });
      return;
    }

    if (pathname === "/session/close") {
      this._readBody(req, (raw) => {
        const body = this._parseJson(raw, res);
        if (body !== null) this._handleSessionClose(body, req, res);
      });
      return;
    }

    // /tool/{name}
    const toolMatch = pathname.match(/^\/tool\/([a-z_]+)$/);
    if (toolMatch) {
      const toolName = toolMatch[1];
      this._readBody(req, (raw) => {
        const body = this._parseJson(raw, res);
        if (body !== null) this._handleToolCall(toolName, body, req, res);
      });
      return;
    }

    this._sendJson(res, 404, { error: "not_found" });
  }

  // ── Session Create ─────────────────────────────────────────────────

  private async _handleSessionCreate(_body: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    try {
      // Ensure Chrome is running.
      await this._browserSession.ensureReady();

      const cdpClient = this._browserSession.cdpClient;

      // 1. Create a new tab.
      const { targetId } = await cdpClient.send<{ targetId: string }>(
        "Target.createTarget",
        { url: "about:blank" },
      );

      // 2. Attach to the tab (flatten = true, always).
      const { sessionId: cdpSessionId } = await cdpClient.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
      );

      // 3. Register tab ownership so MCP tools don't see it.
      this._browserSession.trackOwnedTarget(targetId);

      // 4. Store session.
      const session = this.sessionStore.create(targetId, cdpSessionId);

      this._sendJson(res, 200, {
        session_token: session.sessionToken,
        target_id: session.targetId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`SilbercueChrome --script: session/create failed: ${msg}`);
      this._sendJson(res, 500, { error: "session_create_failed", message: msg });
    }
  }

  // ── Session Close ──────────────────────────────────────────────────

  private async _handleSessionClose(body: Record<string, unknown>, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = (body.session_token as string) || req.headers["x-session"] as string;
    if (!token) {
      this._sendJson(res, 400, { error: "missing_session_token" });
      return;
    }

    const session = this.sessionStore.delete(token);
    if (!session) {
      this._sendJson(res, 404, { error: "unknown_session" });
      return;
    }

    await this._closeTab(session);
    this._sendJson(res, 200, { ok: true });
  }

  // ── Tool Call ──────────────────────────────────────────────────────

  private async _handleToolCall(
    toolName: string,
    body: Record<string, unknown>,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Validate session header.
    const token = req.headers["x-session"] as string;
    if (!token) {
      this._sendJson(res, 400, { error: "missing_session_header" });
      return;
    }

    const session = this.sessionStore.get(token);
    if (!session) {
      this._sendJson(res, 404, { error: "unknown_session" });
      return;
    }

    // Touch heartbeat.
    this.sessionStore.touch(token);

    // Check if tool exists.
    if (!this._registry.hasHandler(toolName)) {
      this._sendJson(res, 404, { error: "unknown_tool", tool: toolName });
      return;
    }

    // Execute tool via shared core — serialized per session.
    try {
      const result = await this._queue.enqueue(token, () =>
        this._registry.executeTool(toolName, body, session.cdpSessionId),
      );

      this._sendJson(res, 200, {
        content: result.content,
        isError: result.isError ?? false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`SilbercueChrome --script: tool/${toolName} failed: ${msg}`);
      this._sendJson(res, 500, { error: "tool_execution_failed", message: msg });
    }
  }

  // ── Orphan Cleanup ─────────────────────────────────────────────────

  private _startOrphanCleanup(): void {
    this._orphanTimer = setInterval(() => {
      void this._cleanupOrphans();
    }, ORPHAN_CHECK_INTERVAL_MS);
    // Don't keep the process alive just for orphan cleanup.
    if (this._orphanTimer.unref) {
      this._orphanTimer.unref();
    }
  }

  private async _cleanupOrphans(): Promise<void> {
    const orphans = this.sessionStore.getOrphans(ORPHAN_TIMEOUT_MS);
    for (const orphan of orphans) {
      console.error(`SilbercueChrome --script: cleaning up orphaned session ${orphan.sessionToken.slice(0, 8)}…`);
      this.sessionStore.delete(orphan.sessionToken);
      await this._closeTab(orphan);
    }
  }

  // ── Tab Management ─────────────────────────────────────────────────

  private async _closeTab(session: SessionInfo): Promise<void> {
    try {
      this._browserSession.untrackOwnedTarget(session.targetId);
      const cdpClient = this._browserSession.cdpClient;
      await cdpClient.send("Target.closeTarget", { targetId: session.targetId });
    } catch {
      // Best effort — tab may already be closed by the user.
    }
  }

  private async _closeAllSessions(): Promise<void> {
    const sessions = this.sessionStore.all();
    for (const session of sessions) {
      this.sessionStore.delete(session.sessionToken);
      await this._closeTab(session);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private _readBody(req: http.IncomingMessage, handler: (raw: string | null) => void): void {
    let raw = "";
    let bytes = 0;
    let destroyed = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_BODY_BYTES) {
        destroyed = true;
        req.destroy();
        handler(null);
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!destroyed) {
        handler(raw);
      }
    });
  }

  /**
   * Parse raw body string into JSON object.
   * Returns null (and sends HTTP 400) on size-limit breach or invalid JSON.
   */
  private _parseJson(raw: string | null, res: http.ServerResponse): Record<string, unknown> | null {
    // Body exceeded MAX_BODY_BYTES — _readBody already destroyed the request.
    if (raw === null) {
      this._sendJson(res, 400, { error: "body_too_large" });
      return null;
    }
    if (raw.length === 0) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this._sendJson(res, 400, { error: "invalid_json" });
      return null;
    }
  }

  private _sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}
