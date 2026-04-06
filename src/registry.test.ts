import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { LicenseStatus } from "./license/license-status.js";
import type { FreeTierConfig } from "./license/free-tier-config.js";
import { registerProHooks } from "./hooks/pro-hooks.js";
import { SessionDefaults } from "./cache/session-defaults.js";

describe("ToolRegistry", () => {
  // Story 9.5: Reset Pro hooks between tests
  beforeEach(() => {
    registerProHooks({});
  });

  it("should be instantiable with McpServer, CdpClient, sessionId, and TabStateCache", () => {
    const registry = new ToolRegistry({} as never, {} as never, "session-1", {} as never);
    expect(registry).toBeDefined();
    expect(registry).toBeInstanceOf(ToolRegistry);
  });

  it("should have a registerAll method", () => {
    const registry = new ToolRegistry({} as never, {} as never, "session-1", {} as never);
    expect(typeof registry.registerAll).toBe("function");
  });

  it("should register evaluate, navigate, read_page, screenshot, wait_for, click, type, tab_status, switch_tab, virtual_desk, and run_plan tools via server.tool()", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;
    const mockCdpClient = {} as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    expect(toolFn).toHaveBeenCalledTimes(16);
    expect(toolFn).toHaveBeenCalledWith(
      "evaluate",
      "Execute JavaScript in the browser page context and return the result. Scope is shared between calls — top-level const/let/class are auto-wrapped in IIFE to prevent redeclaration errors. Tip: if/else blocks may return undefined — use ternary (a ? b : c) or explicit return for reliable values. Prefer the click tool over element.click() in JS — click dispatches the full pointer event chain (pointerdown → mousedown → pointerup → mouseup → click) which works with custom widgets that only listen to mousedown/pointerdown.",
      expect.objectContaining({
        expression: expect.anything(),
        await_promise: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "navigate",
      "Navigate to a URL or go back, waits for page to settle before returning",
      expect.objectContaining({
        url: expect.anything(),
        action: expect.anything(),
        settle_ms: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "read_page",
      "Read page content via accessibility tree with stable element refs",
      expect.objectContaining({
        depth: expect.anything(),
        ref: expect.anything(),
        filter: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "screenshot",
      "Take a compressed WebP screenshot of the current page (max 800px wide, <100KB)",
      expect.objectContaining({
        full_page: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "wait_for",
      "Wait for a condition: element visible, network idle, or JS expression true",
      expect.objectContaining({
        condition: expect.anything(),
        selector: expect.anything(),
        expression: expect.anything(),
        timeout: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "click",
      "Click an element by ref, CSS selector, or viewport coordinates. Dispatches real CDP mouse events (mouseMoved/mousePressed/mouseReleased). For canvas or pixel-precise targets, use x+y coordinates instead of ref. If the click opens a new tab, the response reports it automatically.",
      expect.objectContaining({
        ref: expect.anything(),
        selector: expect.anything(),
        x: expect.anything(),
        y: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "type",
      "Type text into an input field identified by ref or CSS selector. For special keys (Enter, Escape, Tab, arrows) or shortcuts (Ctrl+K), use press_key instead.",
      expect.objectContaining({
        ref: expect.anything(),
        selector: expect.anything(),
        text: expect.anything(),
        clear: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "tab_status",
      "Get cached tab state: URL, title, DOM-ready status, console errors. Instant from cache.",
      {},
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "switch_tab",
      "Open, switch to, or close browser tabs",
      expect.objectContaining({
        action: expect.anything(),
        url: expect.anything(),
        tab: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "virtual_desk",
      "Lists all open tabs with IDs and state. Use this first when starting a session, after reconnect, or when a tab session is lost. Then use switch_tab(tab: \"<id>\") to switch to an existing tab.",
      {},
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "dom_snapshot",
      "Get a compact visual snapshot of the page: element positions, colors, z-order, clickability. Mapped to read_page refs.",
      expect.objectContaining({
        ref: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "file_upload",
      "Upload file(s) to a file input element. Provide ref or CSS selector to identify the <input type='file'>, and absolute path(s) to the file(s).",
      expect.objectContaining({
        ref: expect.anything(),
        selector: expect.anything(),
        path: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "fill_form",
      "Fill a complete form with one call. Each field needs ref or CSS selector plus value. Supports text inputs, selects, checkboxes, and radio buttons. Partial errors do not abort — each field reports its own status.",
      expect.objectContaining({
        fields: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "run_plan",
      "Execute a sequential plan of tool steps server-side. Supports variables ($varName), conditions (if), saveAs, error strategies (abort/continue/screenshot), suspend/resume, and parallel tab execution (Pro). Use parallel: [{ tab, steps }] for multi-tab workflows.",
      expect.objectContaining({
        steps: expect.anything(),
        parallel: expect.anything(),
        use_operator: expect.anything(),
        resume: expect.anything(),
      }),
      expect.any(Function),
    );
  });

  it("updateSession changes sessionId for subsequent tool calls", () => {
    const registry = new ToolRegistry({} as never, {} as never, "session-1", {} as never);
    expect(registry.sessionId).toBe("session-1");

    registry.updateSession("session-2");
    expect(registry.sessionId).toBe("session-2");
  });

  it("executeTool dispatches to correct handler", async () => {
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "number", value: 42 },
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("evaluate", {
      expression: "21*2",
      await_promise: true,
    });

    expect(result).toBeDefined();
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toHaveProperty("text", "42");
  });

  it("executeTool returns error for unknown tool", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("nonexistent", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty("text", "Unknown tool: nonexistent");
    expect(result._meta).toEqual({
      elapsedMs: 0,
      method: "nonexistent",
      response_bytes: Buffer.byteLength(JSON.stringify(result.content), "utf8"),
    });
  });

  it("executeTool does not expose run_plan itself (no recursion)", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("run_plan", { steps: [] });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty("text", "Unknown tool: run_plan");
  });

  it("updateClient swaps cdpClient and sessionId", () => {
    const oldClient = { send: vi.fn() } as never;
    const newClient = { send: vi.fn().mockResolvedValue({ result: { type: "number", value: 99 } }) } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, oldClient, "session-old", {} as never);

    registry.updateClient(newClient, "session-new");

    expect(registry.sessionId).toBe("session-new");
  });

  it("tool handlers use new cdpClient after updateClient", async () => {
    const oldClient = {
      send: vi.fn().mockResolvedValue({ result: { type: "string", value: "old" } }),
    } as never;
    const newClient = {
      send: vi.fn().mockResolvedValue({ result: { type: "string", value: "new" } }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, oldClient, "session-old", {} as never);
    registry.registerAll();

    // Swap to new client
    registry.updateClient(newClient, "session-new");

    // Execute a tool — should use the new client
    const result = await registry.executeTool("evaluate", {
      expression: "test",
      await_promise: false,
    });

    expect(result).toBeDefined();
    // The new client's send should have been called, not the old one
    expect((newClient as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalled();
  });

  it("connectionStatus returns status from callback", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never, () => "reconnecting");

    expect(registry.connectionStatus).toBe("reconnecting");
  });

  it("connectionStatus defaults to connected when no callback", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);

    expect(registry.connectionStatus).toBe("connected");
  });

  // --- Story 6.1: Dialog notification injection tests (C1) ---

  it("executeTool injects dialog notifications into tool response", async () => {
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "number", value: 42 },
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    // Mock DialogHandler that returns pending notifications
    const mockDialogHandler = {
      consumeNotifications: vi.fn().mockReturnValue([
        { type: "alert", message: "Hello!", url: "https://example.com" },
      ]),
      pushHandler: vi.fn(),
      popHandler: vi.fn(),
      pendingCount: 1,
      init: vi.fn(),
      detach: vi.fn(),
      reinit: vi.fn(),
    } as never;

    const registry = new ToolRegistry(
      mockServer,
      mockCdpClient,
      "session-1",
      {} as never,
      undefined,
      undefined,
      mockDialogHandler,
    );
    registry.registerAll();

    const result = await registry.executeTool("evaluate", {
      expression: "21*2",
      await_promise: true,
    });

    expect(result).toBeDefined();
    expect(result.isError).toBeFalsy();
    // First content block is the tool result
    expect(result.content[0]).toHaveProperty("text", "42");
    // Second content block should be the injected dialog notification
    expect(result.content.length).toBeGreaterThanOrEqual(2);
    expect((result.content[1] as { text: string }).text).toContain('[dialog] alert: "Hello!"');
  });

  // --- Story 9.1: Registry wiring for licenseStatus and freeTierConfig (C4) ---

  it("constructor accepts licenseStatus and freeTierConfig, wiring them to run_plan handler", async () => {
    // Create a mock CdpClient that returns results for evaluate calls
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "number", value: 1 },
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    // Free tier license with custom limit of 2
    const license: LicenseStatus = { isPro: () => false };
    const config: FreeTierConfig = { runPlanLimit: 2 };

    const registry = new ToolRegistry(
      mockServer,
      mockCdpClient,
      "session-1",
      {} as never,
      undefined,
      undefined,
      undefined,
      license,
      config,
    );
    registry.registerAll();

    // Execute run_plan indirectly: the handler is registered via server.tool,
    // so we call the callback captured by the mock. The last server.tool call is run_plan.
    const runPlanCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "run_plan",
    );
    expect(runPlanCall).toBeDefined();

    // The handler is the last argument in the server.tool call
    const runPlanCallback = runPlanCall![runPlanCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }>;

    // Run a plan with 4 steps — free tier limit is 2, so only 2 should execute
    const result = await runPlanCallback({
      steps: [
        { tool: "evaluate", params: { expression: "1" } },
        { tool: "evaluate", params: { expression: "2" } },
        { tool: "evaluate", params: { expression: "3" } },
        { tool: "evaluate", params: { expression: "4" } },
      ],
      use_operator: false,
    });

    expect(result._meta).toBeDefined();
    expect(result._meta!.truncated).toBe(true);
    expect(result._meta!.limit).toBe(2);
    expect(result._meta!.total).toBe(4);
  });

  it("Pro license does not truncate steps in run_plan", async () => {
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "number", value: 1 },
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    // Pro license — no truncation expected
    const license: LicenseStatus = { isPro: () => true };
    const config: FreeTierConfig = { runPlanLimit: 2 };

    const registry = new ToolRegistry(
      mockServer,
      mockCdpClient,
      "session-1",
      {} as never,
      undefined,
      undefined,
      undefined,
      license,
      config,
    );
    registry.registerAll();

    const runPlanCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "run_plan",
    );
    const runPlanCallback = runPlanCall![runPlanCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }>;

    const result = await runPlanCallback({
      steps: [
        { tool: "evaluate", params: { expression: "1" } },
        { tool: "evaluate", params: { expression: "2" } },
        { tool: "evaluate", params: { expression: "3" } },
        { tool: "evaluate", params: { expression: "4" } },
      ],
      use_operator: false,
    });

    // Pro license: all 4 steps executed, no truncation
    expect(result._meta).toBeDefined();
    expect(result._meta!.truncated).toBeUndefined();
    expect(result._meta!.stepsCompleted).toBe(4);
  });

  // --- Story 9.5: Feature-Gate Hook integration tests ---

  it("wrapWithGate blocks tool when featureGate returns { allowed: false }", async () => {
    registerProHooks({
      featureGate: (toolName) => {
        if (toolName === "dom_snapshot") {
          return { allowed: false, message: "dom_snapshot requires Pro license" };
        }
        return { allowed: true };
      },
    });

    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;
    const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);

    // Import getProHooks to pass to wrapWithGate
    const { getProHooks } = await import("./hooks/pro-hooks.js");
    const hooks = getProHooks();

    const innerHandler = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "snapshot data" }],
      _meta: { elapsedMs: 50, method: "dom_snapshot" },
    });

    const gated = registry.wrapWithGate("dom_snapshot", innerHandler, hooks);
    const result = await gated({});

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty("text", "dom_snapshot requires Pro license");
    expect(result._meta).toEqual({ elapsedMs: 0, method: "dom_snapshot" });
    // Inner handler should NOT have been called
    expect(innerHandler).not.toHaveBeenCalled();
  });

  it("wrapWithGate allows tool when featureGate returns { allowed: true }", async () => {
    registerProHooks({
      featureGate: () => ({ allowed: true }),
    });

    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;
    const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);

    const { getProHooks } = await import("./hooks/pro-hooks.js");
    const hooks = getProHooks();

    const expectedResponse = {
      content: [{ type: "text" as const, text: "snapshot data" }],
      _meta: { elapsedMs: 50, method: "dom_snapshot" },
    };
    const innerHandler = vi.fn().mockResolvedValue(expectedResponse);

    const gated = registry.wrapWithGate("dom_snapshot", innerHandler, hooks);
    const result = await gated({ ref: "e1" });

    expect(result).toBe(expectedResponse);
    expect(innerHandler).toHaveBeenCalledWith({ ref: "e1" });
  });

  it("wrapWithGate passes through when no featureGate hook is registered", async () => {
    // Default empty hooks — no featureGate
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;
    const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);

    const { getProHooks } = await import("./hooks/pro-hooks.js");
    const hooks = getProHooks();

    const expectedResponse = {
      content: [{ type: "text" as const, text: "result" }],
      _meta: { elapsedMs: 10, method: "evaluate" },
    };
    const innerHandler = vi.fn().mockResolvedValue(expectedResponse);

    const gated = registry.wrapWithGate("evaluate", innerHandler, hooks);
    const result = await gated({ expression: "1+1" });

    expect(result).toBe(expectedResponse);
    expect(innerHandler).toHaveBeenCalledWith({ expression: "1+1" });
  });

  it("wrapWithGate uses default message when featureGate returns no message", async () => {
    registerProHooks({
      featureGate: () => ({ allowed: false }),
    });

    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;
    const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);

    const { getProHooks } = await import("./hooks/pro-hooks.js");
    const hooks = getProHooks();

    const innerHandler = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "data" }],
    });

    const gated = registry.wrapWithGate("my_tool", innerHandler, hooks);
    const result = await gated({});

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty("text", "my_tool ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'");
  });

  // --- Story 9.6: dom_snapshot Pro-Feature-Gate ---

  it("dom_snapshot is registered in server.tool() regardless of license tier (discoverability)", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    // Free tier — dom_snapshot should still be registered
    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    const domSnapshotCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "dom_snapshot",
    );
    expect(domSnapshotCall).toBeDefined();
    expect(domSnapshotCall![1]).toBe(
      "Get a compact visual snapshot of the page: element positions, colors, z-order, clickability. Mapped to read_page refs.",
    );
  });

  it("Free-Tier: dom_snapshot via MCP returns isError with Pro-Feature message", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    // Find the dom_snapshot callback registered via server.tool()
    const domSnapshotCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "dom_snapshot",
    );
    expect(domSnapshotCall).toBeDefined();

    const domSnapshotCallback = domSnapshotCall![domSnapshotCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean; _meta?: Record<string, unknown> }>;

    const result = await domSnapshotCallback({ ref: "e1" });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty(
      "text",
      "dom_snapshot ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'",
    );
  });

  it("Free-Tier: dom_snapshot via executeTool (run_plan path) returns isError with Pro-Feature message", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    const result = await registry.executeTool("dom_snapshot", { ref: "e1" });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty(
      "text",
      "dom_snapshot ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'",
    );
  });

  it("Pro-Tier: dom_snapshot via executeTool is NOT blocked by feature gate", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => true };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    // Verify the gate allows the call by checking that the response is NOT the
    // Pro-Feature error message. The handler itself may fail due to missing CDP mock,
    // but that's a handler error — not a gate block.
    const result = await registry.executeTool("dom_snapshot", {});

    // The gate-blocked message is very specific — verify it's NOT that
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("ist ein Pro-Feature");
  });

  // --- Story 7.2: network_monitor registration with NetworkCollector ---

  it("network_monitor is registered when NetworkCollector is provided", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    // Provide a mock NetworkCollector as the 11th constructor argument
    const mockNetworkCollector = {
      isMonitoring: false,
      start: vi.fn(),
      stop: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      getFiltered: vi.fn().mockReturnValue([]),
      count: 0,
    } as never;

    const registry = new ToolRegistry(
      mockServer,
      {} as never,
      "session-1",
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mockNetworkCollector,
    );
    registry.registerAll();

    const networkMonitorCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "network_monitor",
    );
    expect(networkMonitorCall).toBeDefined();
    expect(networkMonitorCall![1]).toBe(
      "Monitor network requests: start recording, retrieve recorded requests (with optional filter/pattern), or stop and return all collected data.",
    );
  });

  it("network_monitor is NOT registered when no NetworkCollector is provided", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);
    registry.registerAll();

    const networkMonitorCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "network_monitor",
    );
    expect(networkMonitorCall).toBeUndefined();
  });

  it("featureGate is NOT registered when a featureGate hook already exists (Pro-Repo override)", async () => {
    // Simulate Pro-Repo registering its own featureGate before registerAll()
    const customGate = vi.fn().mockReturnValue({ allowed: true });
    registerProHooks({ featureGate: customGate });

    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    // The custom gate should still be the active one (not overwritten)
    const { getProHooks } = await import("./hooks/pro-hooks.js");
    const hooks = getProHooks();
    expect(hooks.featureGate).toBe(customGate);
  });

  // --- Story 7.3 M2: wrap-Pipeline Integration Tests with SessionDefaults ---

  it("wrap pipeline resolves session defaults into tool params (MCP path)", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    // Create a CdpClient mock that captures the expression it receives
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "string", value: "ok" },
      }),
    } as never;

    const sessionDefaults = new SessionDefaults();
    sessionDefaults.setDefault("await_promise", true);

    const registry = new ToolRegistry(
      mockServer,
      mockCdpClient,
      "session-1",
      {} as never,
      undefined, // getConnectionStatus
      undefined, // sessionManager
      undefined, // dialogHandler
      undefined, // licenseStatus
      undefined, // freeTierConfig
      undefined, // consoleCollector
      undefined, // networkCollector
      sessionDefaults,
    );
    registry.registerAll();

    // Find the evaluate callback registered via server.tool()
    const evaluateCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "evaluate",
    );
    expect(evaluateCall).toBeDefined();

    const evaluateCallback = evaluateCall![evaluateCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }>;

    // Call evaluate WITHOUT await_promise — the default should be injected
    const result = await evaluateCallback({ expression: "1+1" });

    expect(result).toBeDefined();
    expect(result._meta).toBeDefined();
    // The CdpClient.send should have received the resolved params including await_promise
    const sendCalls = (mockCdpClient as { send: ReturnType<typeof vi.fn> }).send.mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    // Runtime.evaluate should have awaitPromise: true (resolved from session default)
    const evalCall = sendCalls.find((c: unknown[]) => c[0] === "Runtime.evaluate");
    expect(evalCall).toBeDefined();
    expect(evalCall![1].awaitPromise).toBe(true);
  });

  it("wrap pipeline injects suggestion into _meta after threshold calls (MCP path)", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "number", value: 42 },
      }),
    } as never;

    const sessionDefaults = new SessionDefaults({ promoteThreshold: 3 });

    const registry = new ToolRegistry(
      mockServer,
      mockCdpClient,
      "session-1",
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionDefaults,
    );
    registry.registerAll();

    // Find the evaluate callback
    const evaluateCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "evaluate",
    );
    const evaluateCallback = evaluateCall![evaluateCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }>;

    // Call 3 times with the same await_promise value to trigger suggestion
    await evaluateCallback({ expression: "1", await_promise: true });
    await evaluateCallback({ expression: "2", await_promise: true });
    const result = await evaluateCallback({ expression: "3", await_promise: true });

    expect(result._meta).toBeDefined();
    expect(result._meta!.suggestion).toBeDefined();
    expect(result._meta!.suggestion).toContain("await_promise");
    expect(result._meta!.suggestion).toContain("configure_session");
  });

  it("H2: configure_session does not run through trackCall (no pollution of call history)", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const sessionDefaults = new SessionDefaults({ promoteThreshold: 3 });

    const registry = new ToolRegistry(
      mockServer,
      {} as never,
      "session-1",
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionDefaults,
    );
    registry.registerAll();

    // Build up 2 consecutive calls with same param
    sessionDefaults.trackCall("click", { ref: "e5" });
    sessionDefaults.trackCall("click", { ref: "e5" });

    // Now call configure_session via executeTool — should NOT pollute call history
    const configureCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "configure_session",
    );
    expect(configureCall).toBeDefined();
    const configureCallback = configureCall![configureCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }>;

    await configureCallback({});

    // Track one more click — if configure_session polluted history,
    // consecutive count would be broken
    sessionDefaults.trackCall("click", { ref: "e5" });

    const suggestions = sessionDefaults.getSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].param).toBe("ref");
    expect(suggestions[0].count).toBe(3);
  });

  it("H3: handle_dialog goes through wrap pipeline (gets defaults and suggestions)", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const sessionDefaults = new SessionDefaults();

    const mockDialogHandler = {
      consumeNotifications: vi.fn().mockReturnValue([]),
      pushHandler: vi.fn(),
      popHandler: vi.fn(),
      pendingCount: 0,
      init: vi.fn(),
      detach: vi.fn(),
      reinit: vi.fn(),
      getStatus: vi.fn().mockReturnValue({ mode: "auto", queue: [] }),
    } as never;

    const registry = new ToolRegistry(
      mockServer,
      {} as never,
      "session-1",
      {} as never,
      undefined,
      undefined,
      mockDialogHandler,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionDefaults,
    );
    registry.registerAll();

    // Verify handle_dialog is registered (it should be now via wrap)
    const handleDialogCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "handle_dialog",
    );
    expect(handleDialogCall).toBeDefined();

    const handleDialogCallback = handleDialogCall![handleDialogCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }>;

    // Call handle_dialog — it should go through wrap and track the call
    const result = await handleDialogCallback({ action: "get_status" });
    expect(result).toBeDefined();
    // The call should have been tracked in sessionDefaults
    // (We can't directly inspect call history, but we can verify by calling
    // getSuggestions — no suggestions expected after 1 call)
    expect(sessionDefaults.getSuggestions()).toEqual([]);
  });

  // --- Story 7.6: sessionIdOverride in executeTool ---

  it("executeTool with sessionIdOverride passes override to handler", async () => {
    const sendCalls: Array<{ method: string; sessionId?: string }> = [];
    const mockCdpClient = {
      send: vi.fn(async (method: string, _params?: unknown, sessionId?: string) => {
        sendCalls.push({ method, sessionId });
        return { result: { type: "number", value: 42 } };
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "global-session", {} as never);
    registry.registerAll();

    // Call with sessionIdOverride
    const result = await registry.executeTool("evaluate", {
      expression: "1+1",
      await_promise: false,
    }, "override-session");

    expect(result).toBeDefined();
    // The CDP send call should use the override session, not the global one
    const evalCall = sendCalls.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall).toBeDefined();
    expect(evalCall!.sessionId).toBe("override-session");
  });

  it("executeTool without override uses global session", async () => {
    const sendCalls: Array<{ method: string; sessionId?: string }> = [];
    const mockCdpClient = {
      send: vi.fn(async (method: string, _params?: unknown, sessionId?: string) => {
        sendCalls.push({ method, sessionId });
        return { result: { type: "number", value: 42 } };
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "global-session", {} as never);
    registry.registerAll();

    // Call without override
    await registry.executeTool("evaluate", {
      expression: "1+1",
      await_promise: false,
    });

    const evalCall = sendCalls.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall).toBeDefined();
    expect(evalCall!.sessionId).toBe("global-session");
  });

  it("parallel executeTool calls with different overrides do not interfere", async () => {
    const sessionIdLog: string[] = [];
    const mockCdpClient = {
      send: vi.fn(async (method: string, _params?: unknown, sessionId?: string) => {
        if (method === "Runtime.evaluate") {
          sessionIdLog.push(sessionId ?? "none");
          // Simulate async work
          await new Promise((r) => setTimeout(r, 5));
        }
        return { result: { type: "number", value: 42 } };
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "global-session", {} as never);
    registry.registerAll();

    // Run two executeTool calls in parallel with different overrides
    await Promise.all([
      registry.executeTool("evaluate", { expression: "1", await_promise: false }, "session-A"),
      registry.executeTool("evaluate", { expression: "2", await_promise: false }, "session-B"),
    ]);

    // Both sessions should appear without interference
    expect(sessionIdLog).toContain("session-A");
    expect(sessionIdLog).toContain("session-B");
    expect(sessionIdLog).not.toContain("global-session");
  });

  // --- Story 7.6 Review Fixes: C1, C2, H3 ---

  it("C1: dom_snapshot with sessionIdOverride uses the override (not the global session)", async () => {
    // Reset hooks so the default featureGate is registered fresh based on the license
    registerProHooks({});

    const sendCalls: Array<{ method: string; sessionId?: string }> = [];
    const mockCdpClient = {
      send: vi.fn(async (method: string, _params?: unknown, sessionId?: string) => {
        sendCalls.push({ method, sessionId });
        // Return a URL for Runtime.evaluate (a11y tree navigation detection)
        if (method === "Runtime.evaluate") {
          return { result: { value: "https://c1-test.com" } };
        }
        // Return empty snapshot for DOMSnapshot.captureSnapshot
        if (method === "DOMSnapshot.captureSnapshot") {
          return { documents: [], strings: [] };
        }
        // Return empty a11y tree
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: [] };
        }
        return {};
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    // Pro license to bypass the feature gate
    const license: LicenseStatus = { isPro: () => true };

    const registry = new ToolRegistry(
      mockServer, mockCdpClient, "global-session", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    const result = await registry.executeTool("dom_snapshot", {}, "tab-session-override");

    // Verify we were not blocked by a feature gate
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("Pro-Feature");

    // The DOMSnapshot.captureSnapshot call should use the override session
    const snapshotCall = sendCalls.find((c) => c.method === "DOMSnapshot.captureSnapshot");
    expect(snapshotCall).toBeDefined();
    expect(snapshotCall!.sessionId).toBe("tab-session-override");
  });

  it("C2: handle_dialog with sessionIdOverride accepts the override parameter", async () => {
    const mockDialogHandler = {
      consumeNotifications: vi.fn().mockReturnValue([]),
      pushHandler: vi.fn(),
      popHandler: vi.fn(),
      pendingCount: 0,
      init: vi.fn(),
      detach: vi.fn(),
      reinit: vi.fn(),
      getStatus: vi.fn().mockReturnValue({ mode: "auto", queue: [] }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(
      mockServer,
      {} as never,
      "global-session",
      {} as never,
      undefined,
      undefined,
      mockDialogHandler,
    );
    registry.registerAll();

    // handle_dialog should execute without error when sessionIdOverride is provided
    const result = await registry.executeTool("handle_dialog", { action: "get_status" }, "tab-session-override");

    expect(result).toBeDefined();
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("No dialogs"));
  });

  it("H3: switch_tab in parallel context (sessionIdOverride set) is blocked", async () => {
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({}),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    // Story 9.9: Use Pro license so the feature gate passes and the parallel check is reached
    const license: LicenseStatus = { isPro: () => true };
    const registry = new ToolRegistry(
      mockServer, mockCdpClient, "global-session", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    // switch_tab with sessionIdOverride should be blocked
    const result = await registry.executeTool("switch_tab", { action: "list" }, "tab-session-override");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("parallelen Plan-Gruppen nicht erlaubt"));
  });

  // --- Story 9.9: Pro-Feature-Gates for switch_tab, virtual_desk, Human Touch ---

  it("Free-Tier: switch_tab via MCP returns isError with Pro-Feature message", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    const switchTabCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "switch_tab",
    );
    expect(switchTabCall).toBeDefined();

    const switchTabCallback = switchTabCall![switchTabCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean; _meta?: Record<string, unknown> }>;

    const result = await switchTabCallback({ action: "list" });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty(
      "text",
      "switch_tab ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'",
    );
  });

  it("Free-Tier: virtual_desk via MCP returns isError with Pro-Feature message", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    const virtualDeskCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "virtual_desk",
    );
    expect(virtualDeskCall).toBeDefined();

    const virtualDeskCallback = virtualDeskCall![virtualDeskCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean; _meta?: Record<string, unknown> }>;

    const result = await virtualDeskCallback({});

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty(
      "text",
      "virtual_desk ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'",
    );
  });

  it("Free-Tier: switch_tab via executeTool (run_plan path) returns isError with Pro-Feature message", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    const result = await registry.executeTool("switch_tab", { action: "list" });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty(
      "text",
      "switch_tab ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'",
    );
  });

  it("Free-Tier: virtual_desk via executeTool (run_plan path) returns isError with Pro-Feature message", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    const result = await registry.executeTool("virtual_desk", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty(
      "text",
      "virtual_desk ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'",
    );
  });

  it("Pro-Tier: switch_tab via executeTool is NOT blocked by feature gate", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => true };
    // Mock CDP client — handler will fail due to incomplete mock, but we only
    // need to verify the gate does NOT block the call
    const mockCdpClient = {
      send: vi.fn().mockImplementation(async () => {
        throw new Error("mock CDP not available");
      }),
    } as never;
    const registry = new ToolRegistry(
      mockServer, mockCdpClient, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    // Use "open" action — the handler will fail on CDP call, which is caught
    // by its internal try/catch and returned as isError with a CDP error message
    const result = await registry.executeTool("switch_tab", { action: "open" });

    // The gate-blocked message is very specific — verify it's NOT that
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("ist ein Pro-Feature");
  });

  it("Pro-Tier: virtual_desk via executeTool is NOT blocked by feature gate", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => true };
    // Mock CDP client that returns enough data for virtual_desk
    const mockCdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Target.getTargets") {
          return { targetInfos: [] };
        }
        return {};
      }),
    } as never;
    const registry = new ToolRegistry(
      mockServer, mockCdpClient, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    // The handler may fail due to incomplete CDP mock, but verify it's NOT the gate message
    const result = await registry.executeTool("virtual_desk", {});

    if (result.content[0]) {
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain("ist ein Pro-Feature");
    }
  });

  it("switch_tab is registered in server.tool() regardless of license tier (discoverability)", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    const switchTabCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "switch_tab",
    );
    expect(switchTabCall).toBeDefined();
    expect(switchTabCall![1]).toBe("Open, switch to, or close browser tabs");
  });

  it("virtual_desk is registered in server.tool() regardless of license tier (discoverability)", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    const virtualDeskCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "virtual_desk",
    );
    expect(virtualDeskCall).toBeDefined();
    expect(virtualDeskCall![1]).toBe(
      "Lists all open tabs with IDs and state. Use this first when starting a session, after reconnect, or when a tab session is lost. Then use switch_tab(tab: \"<id>\") to switch to an existing tab.",
    );
  });

  it("Free-Tier: Human Touch enabled is silently downgraded to disabled", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };

    // Set env vars to enable Human Touch
    const originalHT = process.env.SILBERCUE_HUMAN_TOUCH;
    const originalHTS = process.env.SILBERCUE_HUMAN_TOUCH_SPEED;
    process.env.SILBERCUE_HUMAN_TOUCH = "true";
    process.env.SILBERCUE_HUMAN_TOUCH_SPEED = "fast";

    try {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const registry = new ToolRegistry(
        mockServer, {} as never, "session-1", {} as never,
        undefined, undefined, undefined, license,
      );
      registry.registerAll();

      // Should log the downgrade message
      expect(consoleSpy).toHaveBeenCalledWith(
        "SilbercueChrome human touch disabled (Pro feature — activate with 'silbercuechrome license activate <key>')",
      );
      // Should NOT log the "enabled" message
      const enabledCall = consoleSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("human touch enabled"),
      );
      expect(enabledCall).toBeUndefined();

      consoleSpy.mockRestore();
    } finally {
      // Restore env vars
      if (originalHT === undefined) delete process.env.SILBERCUE_HUMAN_TOUCH;
      else process.env.SILBERCUE_HUMAN_TOUCH = originalHT;
      if (originalHTS === undefined) delete process.env.SILBERCUE_HUMAN_TOUCH_SPEED;
      else process.env.SILBERCUE_HUMAN_TOUCH_SPEED = originalHTS;
    }
  });

  it("Pro-Tier: Human Touch enabled stays enabled", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => true };

    // Set env vars to enable Human Touch
    const originalHT = process.env.SILBERCUE_HUMAN_TOUCH;
    const originalHTS = process.env.SILBERCUE_HUMAN_TOUCH_SPEED;
    process.env.SILBERCUE_HUMAN_TOUCH = "true";
    process.env.SILBERCUE_HUMAN_TOUCH_SPEED = "normal";

    try {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const registry = new ToolRegistry(
        mockServer, {} as never, "session-1", {} as never,
        undefined, undefined, undefined, license,
      );
      registry.registerAll();

      // Should NOT log the downgrade message
      const disabledCall = consoleSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("human touch disabled"),
      );
      expect(disabledCall).toBeUndefined();

      // Should log the "enabled" message
      expect(consoleSpy).toHaveBeenCalledWith(
        "SilbercueChrome human touch enabled (speed: normal)",
      );

      consoleSpy.mockRestore();
    } finally {
      if (originalHT === undefined) delete process.env.SILBERCUE_HUMAN_TOUCH;
      else process.env.SILBERCUE_HUMAN_TOUCH = originalHT;
      if (originalHTS === undefined) delete process.env.SILBERCUE_HUMAN_TOUCH_SPEED;
      else process.env.SILBERCUE_HUMAN_TOUCH_SPEED = originalHTS;
    }
  });

  it("Free-Tier: switch_tab gate fires BEFORE parallel check (sessionIdOverride)", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    // Call switch_tab with sessionIdOverride — Free tier should get Pro-Feature error, NOT parallel block
    const result = await registry.executeTool("switch_tab", { action: "list" }, "tab-override");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty(
      "text",
      "switch_tab ist ein Pro-Feature — aktiviere mit 'silbercuechrome license activate <key>'",
    );
    // Explicitly NOT the parallel error
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("parallelen Plan-Gruppen");
  });

  // --- Story 12.1: _meta.response_bytes in all tool responses ---

  it("executeTool injects response_bytes as positive number into _meta", async () => {
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "number", value: 42 },
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("evaluate", {
      expression: "21*2",
      await_promise: true,
    });

    expect(result._meta).toBeDefined();
    expect(result._meta!.response_bytes).toBeDefined();
    expect(typeof result._meta!.response_bytes).toBe("number");
    expect(result._meta!.response_bytes as number).toBeGreaterThan(0);
  });

  it("response_bytes matches Buffer.byteLength of serialized content array", async () => {
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "number", value: 42 },
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("evaluate", {
      expression: "21*2",
      await_promise: true,
    });

    const expectedBytes = Buffer.byteLength(JSON.stringify(result.content), "utf8");
    expect(result._meta!.response_bytes).toBe(expectedBytes);
  });

  it("existing _meta fields (elapsedMs, method) are preserved alongside response_bytes", async () => {
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "number", value: 42 },
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("evaluate", {
      expression: "21*2",
      await_promise: true,
    });

    expect(result._meta).toBeDefined();
    expect(result._meta!.elapsedMs).toBeDefined();
    expect(typeof result._meta!.elapsedMs).toBe("number");
    expect(result._meta!.method).toBe("evaluate");
    expect(result._meta!.response_bytes).toBeDefined();
  });

  it("error response (unknown tool) has response_bytes > 0", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("nonexistent", {});
    expect(result._meta).toBeDefined();
    expect(result._meta!.response_bytes).toBeDefined();
    expect(typeof result._meta!.response_bytes).toBe("number");
    expect(result._meta!.response_bytes as number).toBeGreaterThan(0);

    // Verify the value matches the serialized content
    const expectedBytes = Buffer.byteLength(JSON.stringify(result.content), "utf8");
    expect(result._meta!.response_bytes).toBe(expectedBytes);
  });

  it("minimal valid tool response has response_bytes > 0", async () => {
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "string", value: "" },
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    // evaluate with an empty string result — minimal valid response
    const result = await registry.executeTool("evaluate", {
      expression: "''",
      await_promise: false,
    });

    expect(result.isError).toBeFalsy();
    expect(result._meta).toBeDefined();
    expect(result._meta!.response_bytes).toBeDefined();
    expect(typeof result._meta!.response_bytes).toBe("number");
    expect(result._meta!.response_bytes as number).toBeGreaterThan(0);

    // Verify the value matches the serialized content
    const expectedBytes = Buffer.byteLength(JSON.stringify(result.content), "utf8");
    expect(result._meta!.response_bytes).toBe(expectedBytes);
  });

  it("gate-blocked response has response_bytes in executeTool path", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const license: LicenseStatus = { isPro: () => false };
    const registry = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    // dom_snapshot is blocked for free tier — but executeTool still injects response_bytes
    const result = await registry.executeTool("dom_snapshot", { ref: "e1" });

    expect(result.isError).toBe(true);
    expect(result._meta).toBeDefined();
    expect(result._meta!.response_bytes).toBeDefined();
    expect(result._meta!.response_bytes as number).toBeGreaterThan(0);

    // Verify the value is correct
    const expectedBytes = Buffer.byteLength(JSON.stringify(result.content), "utf8");
    expect(result._meta!.response_bytes).toBe(expectedBytes);
  });

  it("response_bytes via MCP path (server.tool callback) is injected correctly", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "string", value: "hello world" },
      }),
    } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    // Find the evaluate callback registered via server.tool()
    const evaluateCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "evaluate",
    );
    expect(evaluateCall).toBeDefined();

    const evaluateCallback = evaluateCall![evaluateCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }>;

    const result = await evaluateCallback({ expression: "'hello world'", await_promise: false });

    expect(result._meta).toBeDefined();
    expect(result._meta!.response_bytes).toBeDefined();
    expect(typeof result._meta!.response_bytes).toBe("number");
    expect(result._meta!.response_bytes as number).toBeGreaterThan(0);

    // Verify the value matches
    const expectedBytes = Buffer.byteLength(JSON.stringify(result.content), "utf8");
    expect(result._meta!.response_bytes).toBe(expectedBytes);
  });

  it("response_bytes with image content (screenshot-like) has correct byte count via MCP path", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    // Create a fake base64 image data string
    const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    // Mock CDP client that returns a base64 screenshot
    const mockCdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Page.captureScreenshot") {
          return { data: fakeBase64 };
        }
        // Return dimensions for viewport check
        if (method === "Runtime.evaluate") {
          return { result: { type: "object", value: { width: 800, height: 600 } } };
        }
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 },
            cssContentSize: { width: 800, height: 600, x: 0, y: 0 },
            cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0, zoom: 1, scale: 1 },
          };
        }
        return {};
      }),
    } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    // Find the screenshot callback registered via server.tool()
    const screenshotCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "screenshot",
    );
    expect(screenshotCall).toBeDefined();

    const screenshotCallback = screenshotCall![screenshotCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; _meta?: Record<string, unknown> }>;

    const result = await screenshotCallback({});

    // Verify response contains image content
    const imageBlock = result.content.find((c) => c.type === "image");
    expect(imageBlock).toBeDefined();

    // Verify response_bytes is set and matches the serialized content
    expect(result._meta).toBeDefined();
    expect(result._meta!.response_bytes).toBeDefined();
    expect(typeof result._meta!.response_bytes).toBe("number");
    const expectedBytes = Buffer.byteLength(JSON.stringify(result.content), "utf8");
    expect(result._meta!.response_bytes).toBe(expectedBytes);
    // Image content serialized should be significantly larger than a simple text response
    expect(result._meta!.response_bytes as number).toBeGreaterThan(100);
  });

  // --- Story 12.2: _meta.estimated_tokens in read_page and dom_snapshot ---

  it("read_page via executeTool has estimated_tokens as positive number", async () => {
    const mockCdpClient = {
      send: vi.fn().mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: [{ nodeId: "1", role: { value: "rootWebArea" }, name: { value: "Test" }, properties: [], childIds: [] }] };
        }
        if (method === "Runtime.evaluate") {
          // Return a valid URL for the page
          return { result: { type: "string", value: "http://localhost/" } };
        }
        if (method === "DOM.getDocument") {
          return { root: { nodeId: 1 } };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: "obj1" } };
        }
        return {};
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("read_page", {});

    expect(result._meta).toBeDefined();
    expect(result._meta!.estimated_tokens).toBeDefined();
    expect(typeof result._meta!.estimated_tokens).toBe("number");
    expect(result._meta!.estimated_tokens as number).toBeGreaterThan(0);
  });

  it("dom_snapshot via executeTool has estimated_tokens as positive number", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    // dom_snapshot is Pro-gated; use a Pro license
    const license: LicenseStatus = { isPro: () => true };
    const mockCdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "DOMSnapshot.captureSnapshot") {
          return {
            documents: [{
              documentURL: "http://localhost/",
              nodes: { nodeName: ["#document", "HTML", "BODY", "DIV"], nodeType: [9, 1, 1, 1], backendNodeId: [1, 2, 3, 4], parentIndex: [-1, 0, 1, 2], nodeValue: [-1, -1, -1, -1], textValue: { index: [], value: [] }, inputValue: { index: [], value: [] }, inputChecked: { index: [] }, optionSelected: { index: [] }, contentDocumentIndex: { index: [] }, pseudoType: { index: [], value: [] }, isClickable: { index: [] }, currentSourceURL: { index: [], value: [] } },
              layout: { nodeIndex: [2, 3], bounds: [[0, 0, 800, 600], [0, 0, 100, 50]], styles: [[], []], text: [-1, -1], stackingContexts: { index: [] } },
              textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
            }],
            strings: [],
          };
        }
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: [{ nodeId: "1", role: { value: "rootWebArea" }, name: { value: "Test" }, properties: [], childIds: [], backendDOMNodeId: 1 }] };
        }
        if (method === "Runtime.evaluate") {
          return { result: { type: "string", value: "http://localhost/" } };
        }
        return {};
      }),
    } as never;

    const registry = new ToolRegistry(
      mockServer, mockCdpClient, "session-1", {} as never,
      undefined, undefined, undefined, license,
    );
    registry.registerAll();

    const result = await registry.executeTool("dom_snapshot", {});

    expect(result._meta).toBeDefined();
    expect(result._meta!.estimated_tokens).toBeDefined();
    expect(typeof result._meta!.estimated_tokens).toBe("number");
    expect(result._meta!.estimated_tokens as number).toBeGreaterThan(0);
  });

  it("estimated_tokens equals Math.ceil(response_bytes / 4)", async () => {
    const mockCdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: [{ nodeId: "1", role: { value: "rootWebArea" }, name: { value: "Test" }, properties: [], childIds: [] }] };
        }
        if (method === "Runtime.evaluate") {
          return { result: { type: "string", value: "http://localhost/" } };
        }
        if (method === "DOM.getDocument") {
          return { root: { nodeId: 1 } };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: "obj1" } };
        }
        return {};
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("read_page", {});

    expect(result._meta).toBeDefined();
    const responseBytes = result._meta!.response_bytes as number;
    const estimatedTokens = result._meta!.estimated_tokens as number;
    expect(estimatedTokens).toBe(Math.ceil(responseBytes / 4));
  });

  it("navigate via executeTool has NO estimated_tokens in _meta", async () => {
    const mockCdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Page.navigate") {
          return { frameId: "frame1" };
        }
        if (method === "Runtime.evaluate") {
          return { result: { type: "string", value: "complete" } };
        }
        return {};
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("navigate", { url: "http://example.com" });

    expect(result._meta).toBeDefined();
    expect(result._meta!.response_bytes).toBeDefined();
    expect(result._meta!.estimated_tokens).toBeUndefined();
  });

  it("click via executeTool has NO estimated_tokens in _meta", async () => {
    const mockCdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: [{ nodeId: "1", role: { value: "rootWebArea" }, name: { value: "Test" }, properties: [], childIds: ["2"], backendDOMNodeId: 1 }, { nodeId: "2", role: { value: "button" }, name: { value: "Click me" }, properties: [], childIds: [], backendDOMNodeId: 2 }] };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: "obj1" } };
        }
        if (method === "Runtime.callFunctionOn") {
          return { result: { type: "object", value: { x: 100, y: 100, width: 50, height: 20 } } };
        }
        if (method === "Input.dispatchMouseEvent") {
          return {};
        }
        if (method === "Runtime.evaluate") {
          return { result: { type: "string", value: "http://localhost/" } };
        }
        return {};
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("click", { ref: "e2" });

    expect(result._meta).toBeDefined();
    expect(result._meta!.response_bytes).toBeDefined();
    expect(result._meta!.estimated_tokens).toBeUndefined();
  });

  it("read_page via MCP path (server.tool callback) has estimated_tokens", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const mockCdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: [{ nodeId: "1", role: { value: "rootWebArea" }, name: { value: "Test" }, properties: [], childIds: [] }] };
        }
        if (method === "Runtime.evaluate") {
          return { result: { type: "string", value: "http://localhost/" } };
        }
        if (method === "DOM.getDocument") {
          return { root: { nodeId: 1 } };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: "obj1" } };
        }
        return {};
      }),
    } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    // Find the read_page callback registered via server.tool()
    const readPageCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "read_page",
    );
    expect(readPageCall).toBeDefined();

    const readPageCallback = readPageCall![readPageCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }>;

    const result = await readPageCallback({});

    expect(result._meta).toBeDefined();
    expect(result._meta!.estimated_tokens).toBeDefined();
    expect(typeof result._meta!.estimated_tokens).toBe("number");
    expect(result._meta!.estimated_tokens as number).toBeGreaterThan(0);
    expect(result._meta!.estimated_tokens).toBe(Math.ceil((result._meta!.response_bytes as number) / 4));
  });

  it("existing _meta fields are preserved alongside estimated_tokens", async () => {
    const mockCdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: [{ nodeId: "1", role: { value: "rootWebArea" }, name: { value: "Test" }, properties: [], childIds: [] }] };
        }
        if (method === "Runtime.evaluate") {
          return { result: { type: "string", value: "http://localhost/" } };
        }
        if (method === "DOM.getDocument") {
          return { root: { nodeId: 1 } };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: "obj1" } };
        }
        return {};
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("read_page", {});

    expect(result._meta).toBeDefined();
    // Existing fields preserved
    expect(result._meta!.elapsedMs).toBeDefined();
    expect(typeof result._meta!.elapsedMs).toBe("number");
    expect(result._meta!.method).toBe("read_page");
    expect(result._meta!.response_bytes).toBeDefined();
    // New field added
    expect(result._meta!.estimated_tokens).toBeDefined();
    expect(typeof result._meta!.estimated_tokens).toBe("number");
  });

  it("response_bytes via MCP path with sessionDefaults is injected correctly", async () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { type: "number", value: 42 },
      }),
    } as never;

    const sessionDefaults = new SessionDefaults();

    const registry = new ToolRegistry(
      mockServer,
      mockCdpClient,
      "session-1",
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionDefaults,
    );
    registry.registerAll();

    // Find the evaluate callback registered via server.tool()
    const evaluateCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "evaluate",
    );
    expect(evaluateCall).toBeDefined();

    const evaluateCallback = evaluateCall![evaluateCall!.length - 1] as (
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }>;

    const result = await evaluateCallback({ expression: "42", await_promise: true });

    expect(result._meta).toBeDefined();
    expect(result._meta!.response_bytes).toBeDefined();
    expect(typeof result._meta!.response_bytes).toBe("number");
    expect(result._meta!.response_bytes as number).toBeGreaterThan(0);

    // Verify the value matches the serialized content
    const expectedBytes = Buffer.byteLength(JSON.stringify(result.content), "utf8");
    expect(result._meta!.response_bytes).toBe(expectedBytes);
  });
});
