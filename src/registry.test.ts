import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "./registry.js";

describe("ToolRegistry", () => {
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

    expect(toolFn).toHaveBeenCalledTimes(13);
    expect(toolFn).toHaveBeenCalledWith(
      "evaluate",
      "Execute JavaScript in the browser page context and return the result",
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
      "Click an element by A11y-Tree ref (e.g. 'e5') or CSS selector. Returns immediately after click — use wait_for if the click triggers navigation or async content loading.",
      expect.objectContaining({
        ref: expect.anything(),
        selector: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "type",
      "Type text into an input field identified by ref or CSS selector",
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
        tab_id: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "virtual_desk",
      "Compact overview of all open browser tabs with state (URL, title, loading status, active/inactive)",
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
      "run_plan",
      "Execute a sequential plan of tool steps server-side. N steps = 1 LLM round-trip. Aborts on first error and returns partial results. Set use_operator=true for adaptive error recovery.",
      expect.objectContaining({
        steps: expect.anything(),
        use_operator: expect.anything(),
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
    expect(result._meta).toEqual({ elapsedMs: 0, method: "nonexistent" });
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
});
