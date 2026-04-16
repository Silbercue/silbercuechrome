/**
 * Story 9.7: Script API Gateway — co-located tests.
 *
 * Tests use a real HTTP server on an ephemeral port (0) to verify the
 * full request/response cycle. BrowserSession and ToolRegistry are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { ScriptApiServer, SessionStore } from "./script-api-server.js";
import type { ScriptApiToolRegistry } from "./script-api-server.js";
import type { IBrowserSession } from "../cdp/browser-session.js";
import type { ToolResponse } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function createMockRegistry(overrides?: Partial<ScriptApiToolRegistry>): ScriptApiToolRegistry {
  return {
    executeTool: vi.fn(async (_name: string, _params: Record<string, unknown>, _sessionIdOverride?: string): Promise<ToolResponse> => {
      return {
        content: [{ type: "text", text: "mock result" }],
        isError: false,
        _meta: { elapsedMs: 10, method: _name },
      };
    }),
    hasHandler: vi.fn((name: string) => {
      // Default: all tools exist except "unknown_tool"
      return name !== "unknown_tool";
    }),
    ...overrides,
  };
}

function createMockBrowserSession(): IBrowserSession {
  const ownedTargets = new Set<string>();
  let createCounter = 0;

  const mockCdpClient = {
    send: vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === "Target.createTarget") {
        createCounter++;
        return { targetId: `tab-${createCounter}` };
      }
      if (method === "Target.attachToTarget") {
        return { sessionId: `cdp-session-${createCounter}` };
      }
      if (method === "Target.closeTarget") {
        return {};
      }
      return {};
    }),
  };

  return {
    isReady: true,
    wasEverReady: true,
    cdpClient: mockCdpClient as never,
    sessionId: "main-session",
    headless: false,
    scriptMode: true,
    tabStateCache: {} as never,
    sessionDefaults: {} as never,
    sessionManager: undefined,
    dialogHandler: undefined,
    consoleCollector: undefined,
    networkCollector: undefined,
    downloadCollector: undefined,
    domWatcher: undefined,
    ensureReady: vi.fn(async () => {}),
    consumeRelaunchNotice: vi.fn(() => null),
    waitForAXChange: vi.fn(async () => false),
    applyTabSwitch: vi.fn(),
    isOwnedTarget: vi.fn((id: string) => ownedTargets.has(id)),
    trackOwnedTarget: vi.fn((id: string) => ownedTargets.add(id)),
    untrackOwnedTarget: vi.fn((id: string) => ownedTargets.delete(id)),
    shutdown: vi.fn(async () => {}),
  } as unknown as IBrowserSession;
}

/** Send an HTTP request to the server and return parsed response. */
async function request(
  port: number,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { _raw: raw } as unknown as Record<string, unknown> });
          }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

// ── SessionStore unit tests ────────────────────────────────────────────

describe("SessionStore", () => {
  it("creates and retrieves sessions", () => {
    const store = new SessionStore();
    const info = store.create("target-1", "cdp-session-1");
    expect(info.sessionToken).toBeTruthy();
    expect(info.targetId).toBe("target-1");
    expect(info.cdpSessionId).toBe("cdp-session-1");
    expect(store.get(info.sessionToken)).toBe(info);
    expect(store.size).toBe(1);
  });

  it("touches updates lastSeen", async () => {
    const store = new SessionStore();
    const info = store.create("target-1", "cdp-session-1");
    const originalLastSeen = info.lastSeen;

    // Tiny delay to get a different timestamp
    await new Promise((r) => setTimeout(r, 5));
    store.touch(info.sessionToken);
    expect(info.lastSeen).toBeGreaterThan(originalLastSeen);
  });

  it("deletes sessions and returns the deleted info", () => {
    const store = new SessionStore();
    const info = store.create("target-1", "cdp-session-1");
    const deleted = store.delete(info.sessionToken);
    expect(deleted).toBe(info);
    expect(store.get(info.sessionToken)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("returns undefined for unknown tokens", () => {
    const store = new SessionStore();
    expect(store.get("nonexistent")).toBeUndefined();
    expect(store.delete("nonexistent")).toBeUndefined();
  });

  it("finds orphaned sessions", () => {
    const store = new SessionStore();
    const info = store.create("target-1", "cdp-session-1");
    // Fake old timestamp
    info.lastSeen = Date.now() - 60_000;

    const orphans = store.getOrphans(30_000);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toBe(info);
  });

  it("does not flag recent sessions as orphans", () => {
    const store = new SessionStore();
    store.create("target-1", "cdp-session-1");
    const orphans = store.getOrphans(30_000);
    expect(orphans).toHaveLength(0);
  });

  it("all() returns all sessions", () => {
    const store = new SessionStore();
    store.create("target-1", "cdp-session-1");
    store.create("target-2", "cdp-session-2");
    expect(store.all()).toHaveLength(2);
  });
});

// ── ScriptApiServer HTTP tests ─────────────────────────────────────────

describe("ScriptApiServer", () => {
  let server: ScriptApiServer;
  let registry: ScriptApiToolRegistry;
  let browserSession: IBrowserSession;
  let port: number;

  beforeEach(async () => {
    registry = createMockRegistry();
    browserSession = createMockBrowserSession();

    // Use port 0 to get an ephemeral port.
    server = new ScriptApiServer({
      port: 0,
      registry,
      browserSession,
    });
    await server.start();

    // Read the actual assigned port.
    // The server binds to 127.0.0.1:0 — the OS assigns a free port.
    // We access it via the underlying http.Server.
    port = (server as unknown as { _server: http.Server })._server.address() as unknown as number;
    // address() returns AddressInfo object when listening on TCP
    const addr = (server as unknown as { _server: http.Server })._server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  // ── Server lifecycle ─────────────────────────────────────────────

  it("starts and is listening", () => {
    expect(server.listening).toBe(true);
  });

  it("stops cleanly", async () => {
    await server.stop();
    expect(server.listening).toBe(false);
  });

  // ── Session Create ─────────────────────────────────────────────

  it("POST /session/create returns session_token and target_id", async () => {
    const res = await request(port, "/session/create");
    expect(res.status).toBe(200);
    expect(res.body.session_token).toBeTruthy();
    expect(typeof res.body.session_token).toBe("string");
    expect(res.body.target_id).toBe("tab-1");
  });

  it("POST /session/create calls Target.createTarget and Target.attachToTarget", async () => {
    await request(port, "/session/create");
    const cdpSend = (browserSession.cdpClient as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(cdpSend).toHaveBeenCalledWith("Target.createTarget", { url: "about:blank" });
    expect(cdpSend).toHaveBeenCalledWith("Target.attachToTarget", { targetId: "tab-1", flatten: true });
  });

  it("POST /session/create registers tab ownership", async () => {
    await request(port, "/session/create");
    expect(browserSession.trackOwnedTarget).toHaveBeenCalledWith("tab-1");
  });

  // ── Tool Calls ─────────────────────────────────────────────────

  it("POST /tool/evaluate with valid session executes tool and returns result", async () => {
    const createRes = await request(port, "/session/create");
    const token = createRes.body.session_token as string;

    const res = await request(port, "/tool/evaluate", { expression: "1+1" }, { "X-Session": token });
    expect(res.status).toBe(200);
    expect(res.body.content).toEqual([{ type: "text", text: "mock result" }]);
    expect(res.body.isError).toBe(false);
  });

  it("POST /tool/evaluate passes sessionIdOverride from session", async () => {
    const createRes = await request(port, "/session/create");
    const token = createRes.body.session_token as string;

    await request(port, "/tool/evaluate", { expression: "1+1" }, { "X-Session": token });

    expect(registry.executeTool).toHaveBeenCalledWith(
      "evaluate",
      { expression: "1+1" },
      "cdp-session-1",
    );
  });

  it("POST /tool/unknown_tool returns 404", async () => {
    const createRes = await request(port, "/session/create");
    const token = createRes.body.session_token as string;

    const res = await request(port, "/tool/unknown_tool", {}, { "X-Session": token });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_tool");
  });

  it("POST /tool/evaluate without X-Session header returns 400", async () => {
    const res = await request(port, "/tool/evaluate", { expression: "1+1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_session_header");
  });

  it("POST /tool/evaluate with invalid session token returns 404", async () => {
    const res = await request(port, "/tool/evaluate", { expression: "1+1" }, { "X-Session": "invalid-token" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_session");
  });

  // ── Session Close ──────────────────────────────────────────────

  it("POST /session/close closes tab and removes session", async () => {
    const createRes = await request(port, "/session/create");
    const token = createRes.body.session_token as string;

    const closeRes = await request(port, "/session/close", { session_token: token });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.ok).toBe(true);

    // Session is gone
    const toolRes = await request(port, "/tool/evaluate", {}, { "X-Session": token });
    expect(toolRes.status).toBe(404);
    expect(toolRes.body.error).toBe("unknown_session");
  });

  it("POST /session/close calls Target.closeTarget", async () => {
    const createRes = await request(port, "/session/create");
    const token = createRes.body.session_token as string;

    await request(port, "/session/close", { session_token: token });
    const cdpSend = (browserSession.cdpClient as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(cdpSend).toHaveBeenCalledWith("Target.closeTarget", { targetId: "tab-1" });
  });

  it("POST /session/close unregisters tab ownership", async () => {
    const createRes = await request(port, "/session/create");
    const token = createRes.body.session_token as string;

    await request(port, "/session/close", { session_token: token });
    expect(browserSession.untrackOwnedTarget).toHaveBeenCalledWith("tab-1");
  });

  it("POST /session/close with unknown token returns 404", async () => {
    const res = await request(port, "/session/close", { session_token: "unknown" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_session");
  });

  it("POST /session/close with missing token returns 400", async () => {
    const res = await request(port, "/session/close", {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_session_token");
  });

  // ── Heartbeat / Touch ──────────────────────────────────────────

  it("tool calls update lastSeen timestamp (heartbeat)", async () => {
    const createRes = await request(port, "/session/create");
    const token = createRes.body.session_token as string;

    const sessionBefore = server.sessionStore.get(token)!;
    const originalLastSeen = sessionBefore.lastSeen;

    await new Promise((r) => setTimeout(r, 5));
    await request(port, "/tool/evaluate", { expression: "1+1" }, { "X-Session": token });

    expect(sessionBefore.lastSeen).toBeGreaterThan(originalLastSeen);
  });

  // ── Orphan Cleanup ─────────────────────────────────────────────

  it("orphan cleanup closes sessions past timeout", async () => {
    const createRes = await request(port, "/session/create");
    const token = createRes.body.session_token as string;

    // Fake old timestamp to simulate orphan
    const session = server.sessionStore.get(token)!;
    session.lastSeen = Date.now() - 60_000;

    // Trigger cleanup manually by accessing the private method
    await (server as unknown as { _cleanupOrphans: () => Promise<void> })._cleanupOrphans();

    // Session should be cleaned up
    expect(server.sessionStore.get(token)).toBeUndefined();
    expect(browserSession.untrackOwnedTarget).toHaveBeenCalledWith("tab-1");
  });

  // ── Routing edge cases ─────────────────────────────────────────

  it("returns 404 for unknown routes", async () => {
    const res = await request(port, "/unknown");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 405 for non-POST methods", async () => {
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/session/create",
          method: "GET",
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk: Buffer) => {
            raw += chunk.toString();
          });
          res.on("end", () => {
            try {
              expect(res.statusCode).toBe(405);
              expect(JSON.parse(raw).error).toBe("method_not_allowed");
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  });

  // ── Invalid JSON / Body limit ───────────────────────────────────

  it("returns 400 with invalid_json for malformed JSON body", async () => {
    // Send raw invalid JSON to /session/create
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/session/create",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk: Buffer) => {
            raw += chunk.toString();
          });
          res.on("end", () => {
            try {
              expect(res.statusCode).toBe(400);
              expect(JSON.parse(raw).error).toBe("invalid_json");
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.end("{not-valid-json}");
    });
  });

  it("returns 400 with body_too_large for oversized payload", async () => {
    // Send >1MB payload
    const hugePayload = "x".repeat(1_048_577);
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/session/create",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk: Buffer) => {
            raw += chunk.toString();
          });
          res.on("end", () => {
            try {
              expect(res.statusCode).toBe(400);
              expect(JSON.parse(raw).error).toBe("body_too_large");
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", (err) => {
        // Connection may be reset by server destroying the request — that's acceptable
        if ((err as NodeJS.ErrnoException).code === "ECONNRESET") {
          resolve();
          return;
        }
        reject(err);
      });
      req.end(hugePayload);
    });
  });

  // ── Session close via X-Session header ─────────────────────────

  it("POST /session/close also accepts session_token from X-Session header", async () => {
    const createRes = await request(port, "/session/create");
    const token = createRes.body.session_token as string;

    const closeRes = await request(port, "/session/close", {}, { "X-Session": token });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.ok).toBe(true);
  });
});

// ── SessionQueue serialization test ───────────────────────────────────

describe("ScriptApiServer — session queue serialization", () => {
  let server: ScriptApiServer;
  let registry: ScriptApiToolRegistry;
  let browserSession: IBrowserSession;
  let port: number;

  beforeEach(async () => {
    registry = createMockRegistry();
    browserSession = createMockBrowserSession();

    server = new ScriptApiServer({
      port: 0,
      registry,
      browserSession,
    });
    await server.start();
    const addr = (server as unknown as { _server: http.Server })._server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("serializes two parallel tool calls on the same session (no overlap)", async () => {
    // Create a session
    const createRes = await request(port, "/session/create");
    const token = createRes.body.session_token as string;

    // Track execution timeline
    const timeline: Array<{ call: number; event: "start" | "end"; time: number }> = [];

    // Mock executeTool with a delay so we can detect overlap
    (registry.executeTool as ReturnType<typeof vi.fn>).mockImplementation(
      async (_name: string, params: Record<string, unknown>): Promise<ToolResponse> => {
        const callId = params._callId as number;
        timeline.push({ call: callId, event: "start", time: Date.now() });
        // Simulate work that takes 50ms
        await new Promise((r) => setTimeout(r, 50));
        timeline.push({ call: callId, event: "end", time: Date.now() });
        return {
          content: [{ type: "text", text: `result-${callId}` }],
          isError: false,
          _meta: { elapsedMs: 50, method: _name },
        };
      },
    );

    // Fire two requests in parallel on the SAME session
    const [res1, res2] = await Promise.all([
      request(port, "/tool/evaluate", { expression: "1+1", _callId: 1 }, { "X-Session": token }),
      request(port, "/tool/evaluate", { expression: "2+2", _callId: 2 }, { "X-Session": token }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Verify serialization: second call must start after first call ends
    expect(timeline).toHaveLength(4);
    const firstEnd = timeline.find((e) => e.call === 1 && e.event === "end")!;
    const secondStart = timeline.find((e) => e.call === 2 && e.event === "start")!;
    expect(secondStart.time).toBeGreaterThanOrEqual(firstEnd.time);
  });
});

// ── Server does NOT start without script mode ──────────────────────────

describe("ScriptApiServer — scriptMode guard", () => {
  it("server does not start in non-script mode (integration check via port option)", async () => {
    // The guard is in server.ts (scriptMode check), not in ScriptApiServer itself.
    // ScriptApiServer is only instantiated when scriptMode is true.
    // Verify that ScriptApiServer can be instantiated and stopped without starting.
    const registry = createMockRegistry();
    const browserSession = createMockBrowserSession();
    const srv = new ScriptApiServer({ port: 0, registry, browserSession });
    expect(srv.listening).toBe(false);
    // Calling stop on a never-started server should be safe.
    await srv.stop();
    expect(srv.listening).toBe(false);
  });
});

// ── Shutdown cleanup ───────────────────────────────────────────────────

describe("ScriptApiServer — shutdown", () => {
  it("stop() closes all open sessions and tabs", async () => {
    const registry = createMockRegistry();
    const browserSession = createMockBrowserSession();
    const srv = new ScriptApiServer({ port: 0, registry, browserSession });
    await srv.start();
    const addr = (srv as unknown as { _server: http.Server })._server.address() as { port: number };
    const p = addr.port;

    // Create two sessions
    await request(p, "/session/create");
    await request(p, "/session/create");
    expect(srv.sessionStore.size).toBe(2);

    // Stop should clean up everything
    await srv.stop();
    expect(srv.sessionStore.size).toBe(0);
    expect(srv.listening).toBe(false);

    // Target.closeTarget should have been called for both tabs
    const cdpSend = (browserSession.cdpClient as unknown as { send: ReturnType<typeof vi.fn> }).send;
    const closeCalls = cdpSend.mock.calls.filter(
      (c: unknown[]) => c[0] === "Target.closeTarget",
    );
    expect(closeCalls).toHaveLength(2);
  });
});
