import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry, jsonSchemaToZodShape } from "./registry.js";
import { z } from "zod";
import type { LicenseStatus } from "./license/license-status.js";
import type { FreeTierConfig } from "./license/free-tier-config.js";
import { registerProHooks } from "./hooks/pro-hooks.js";
import type { ProHooks } from "./hooks/pro-hooks.js";
import { SessionDefaults } from "./cache/session-defaults.js";
import { a11yTree, A11yTreeProcessor } from "./cache/a11y-tree.js";

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

    // Story 15.2: 17 Free-Tools. `inspect_element` is Pro-only and is
    // only registered when the Pro-Repo calls `registerProTools` — no
    // stub fallback in the Free tier.
    expect(toolFn).toHaveBeenCalledTimes(17);
    expect(toolFn).toHaveBeenCalledWith(
      "evaluate",
      "Execute JavaScript in the browser page context and return the result. Use this to COMPUTE values or trigger side effects no other tool covers — NOT to discover elements. If you're using querySelector/getElementById/innerText to find interactive elements or read visible text, prefer read_page (stable refs survive DOM changes, selectors don't) or fill_form. Common anti-patterns that evaluate will detect and hint you about: DOM-queried buttons/inputs, .innerText/.textContent reads, .click()/.scrollIntoView(), Tests.*.toString() introspection. Scope is shared between calls — top-level const/let/class are auto-wrapped in IIFE. If/else blocks may return undefined — use ternary (a ? b : c) or explicit return.",
      expect.objectContaining({
        expression: expect.anything(),
        await_promise: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "navigate",
      "Navigate the ACTIVE tab to a URL (or action:'back'). Waits for settle. WARNING: overwrites the user's active tab — always call virtual_desk FIRST to check what's open; if the right tab exists, use switch_tab instead. First call per session is auto-redirected to virtual_desk.",
      expect.objectContaining({
        url: expect.anything(),
        action: expect.anything(),
        settle_ms: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "read_page",
      "PRIMARY tool for page understanding — call after navigate/switch_tab before any interaction. Returns accessibility tree with stable refs (e.g. 'e5') that you pass to click/type/fill_form. Use this to read visible text too — not evaluate/querySelector. Default filter:'interactive' hides static text; for cells/paragraphs/labels call read_page(ref: 'eN', filter: 'all'). ~10-30x cheaper than screenshot.",
      expect.objectContaining({
        depth: expect.anything(),
        ref: expect.anything(),
        filter: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "screenshot",
      "Capture a WebP image of the page (max 800px, <100KB). You CANNOT use screenshots as input for click/type — use read_page for element refs. Only use for visual verification, canvas pages, or explicit user requests. ~10-30x more tokens than read_page.",
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
      "Click an element by ref, CSS selector, or viewport coordinates. Dispatches real CDP mouse events (mouseMoved/mousePressed/mouseReleased). For canvas or pixel-precise targets, use x+y coordinates instead of ref. If the click opens a new tab, the response reports it automatically. The response already includes the DOM diff (NEW/REMOVED/CHANGED lines) — inspect those changes for success/failure signals instead of following up with evaluate to re-check state.",
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
      "Type text into an input field identified by ref or CSS selector. For multiple fields in the same form, prefer fill_form — it handles text inputs, <select>, checkbox, and radio in one round-trip and is more reliable than N separate type calls. For special keys (Enter, Escape, Tab, arrows) or shortcuts (Ctrl+K), use press_key instead.",
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
      "Active tab's cached URL/title/ready/errors for quick sanity checks mid-workflow ('did my click navigate?'). For tab discovery: use virtual_desk. For page content: use read_page.",
      {},
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "switch_tab",
      "Open a new tab, switch to an existing tab by ID (from virtual_desk), or close a tab. Prefer 'open' over navigate when you don't want to touch the user's active tab.",
      expect.objectContaining({
        action: expect.anything(),
        url: expect.anything(),
        tab: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "virtual_desk",
      "PRIMARY orientation tool — call first in every new session, after reconnect, or when unsure. Lists all tabs with IDs, URLs, state. Use returned IDs with switch_tab(tab: '<id>') instead of opening duplicates via navigate. Cheap, call liberally.",
      {},
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "dom_snapshot",
      "Structured layout data: bounding boxes, computed styles, paint order, colors. Refs match read_page. Use ONLY for spatial questions read_page cannot answer (is A above B? what color?). For element discovery or text: use read_page. For pure visual verification: use screenshot.",
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
      "Fill a complete form with one call — the preferred way to submit any form with 2+ fields. Each field needs ref or CSS selector plus value. Supports text inputs, <select> (by value or visible label), checkboxes (boolean), and radio buttons. Use this INSTEAD of multiple type calls or evaluate-setting select.value: one round-trip, partial errors do not abort, each field reports its own status.",
      expect.objectContaining({
        fields: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "run_plan",
      "Execute a sequential plan of tool steps server-side. Supports variables ($varName), conditions (if), saveAs, error strategies (abort/continue/screenshot), suspend/resume. Parallel tab execution via parallel: [{ tab, steps }] is a Pro-Feature - requires Pro license.",
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
      "Structured layout data: bounding boxes, computed styles, paint order, colors. Refs match read_page. Use ONLY for spatial questions read_page cannot answer (is A above B? what color?). For element discovery or text: use read_page. For pure visual verification: use screenshot.",
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
    // Filter out overlay status calls (awaitPromise: false) to find the actual evaluate tool call
    const evalCall = sendCalls.find((c: unknown[]) => c[0] === "Runtime.evaluate" && c[1]?.awaitPromise === true);
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
    expect(switchTabCall![1]).toBe(
      "Open a new tab, switch to an existing tab by ID (from virtual_desk), or close a tab. Prefer 'open' over navigate when you don't want to touch the user's active tab.",
    );
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
      "PRIMARY orientation tool — call first in every new session, after reconnect, or when unsure. Lists all tabs with IDs, URLs, state. Use returned IDs with switch_tab(tab: '<id>') instead of opening duplicates via navigate. Cheap, call liberally.",
    );
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

  // -----------------------------------------------------------------
  // Story 15.2 — Pro-Tool registration lifecycle (H1, H2, M1)
  // -----------------------------------------------------------------
  describe("Pro-Tool registration lifecycle (Story 15.2)", () => {
    it("calls registerProTools hook DURING registerAll()", () => {
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      const registerProTools = vi.fn();
      registerProHooks({ registerProTools });

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      // The hook was invoked exactly once, with the registry itself as
      // its argument (ToolRegistryPublic interface).
      expect(registerProTools).toHaveBeenCalledTimes(1);
      expect(registerProTools).toHaveBeenCalledWith(registry);
    });

    it("allows registerTool() to be called from inside registerProTools and exposes the tool via server.tool()", () => {
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      const handler = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        _meta: { elapsedMs: 1, method: "inspect_element" },
      }));

      registerProHooks({
        registerProTools: (reg) => {
          reg.registerTool(
            "inspect_element",
            "Inspect CSS + geometry (Pro)",
            { selector: { type: "string" } },
            handler,
          );
        },
      });

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      // inspect_element was registered through the delegate, so it shows
      // up in server.tool() calls (= tools/list).
      const inspectCall = toolFn.mock.calls.find(
        (call: unknown[]) => call[0] === "inspect_element",
      );
      expect(inspectCall).toBeDefined();
      expect(inspectCall![1]).toBe("Inspect CSS + geometry (Pro)");
    });

    it("does NOT register inspect_element in tools/list when no registerProTools hook is set", () => {
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      // Explicitly empty hooks — no Pro-Repo loaded.
      registerProHooks({});

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      const inspectCall = toolFn.mock.calls.find(
        (call: unknown[]) => call[0] === "inspect_element",
      );
      // AC #8: No stub, no Pro-Feature error tool — inspect_element is
      // simply absent from tools/list in the Free tier.
      expect(inspectCall).toBeUndefined();
    });

    it("throws when registerTool() is called AFTER registerAll() (lifecycle — H2)", () => {
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      let leakedRegistry: import("./hooks/pro-hooks.js").ToolRegistryPublic | null = null;
      registerProHooks({
        registerProTools: (reg) => {
          // Leak the registry reference so the test can call registerTool()
          // *after* registerAll() has finished.
          leakedRegistry = reg;
        },
      });

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      // registerAll() is now finished — the delegate must be cleared,
      // so the leaked reference must refuse further tool registrations.
      expect(leakedRegistry).not.toBeNull();
      expect(() =>
        leakedRegistry!.registerTool(
          "late_tool",
          "Registered too late",
          {},
          async () => ({
            content: [{ type: "text" as const, text: "nope" }],
            _meta: { elapsedMs: 0, method: "late_tool" },
          }),
        ),
      ).toThrow(/registerTool\(\) can only be called during registerAll\(\) \/ registerProTools/);

      // And the tool must NOT have been forwarded to server.tool().
      const lateCall = toolFn.mock.calls.find(
        (call: unknown[]) => call[0] === "late_tool",
      );
      expect(lateCall).toBeUndefined();
    });

    it("throws when registerTool() is called on a fresh registry BEFORE registerAll()", () => {
      const mockServer = { tool: vi.fn() } as never;
      const mockCdpClient = {} as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);

      expect(() =>
        registry.registerTool(
          "too_early",
          "No delegate yet",
          {},
          async () => ({
            content: [{ type: "text" as const, text: "nope" }],
            _meta: { elapsedMs: 0, method: "too_early" },
          }),
        ),
      ).toThrow(/registerTool\(\) can only be called during registerAll\(\) \/ registerProTools/);
    });
  });

  // --- Story 15.3: onToolResult hook integration ---

  describe("onToolResult hook integration (Story 15.3)", () => {
    beforeEach(() => {
      registerProHooks({});
    });

    it("executeTool invokes onToolResult hook with context parameter", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 42 } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const waitForAXChange = vi.fn().mockResolvedValue(true);

      const hookFn = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
        async (_name, result, _ctx) => ({
          ...result,
          content: [
            ...result.content,
            { type: "text" as const, text: "enhanced" },
          ],
        }),
      );
      registerProHooks({ onToolResult: hookFn });

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
        undefined,
        waitForAXChange,
      );
      registry.registerAll();

      const result = await registry.executeTool("evaluate", {
        expression: "21*2",
        await_promise: false,
      });

      expect(hookFn).toHaveBeenCalledTimes(1);
      const [calledName, calledResult, calledCtx] = hookFn.mock.calls[0];
      expect(calledName).toBe("evaluate");
      expect(calledResult).toBeDefined();
      // Story 15.3 (AC #5): a11yTree is a unified facade exposing both
      // instance methods AND the static diff/format methods.
      expect(typeof calledCtx.a11yTree.classifyRef).toBe("function");
      expect(typeof calledCtx.a11yTree.getSnapshotMap).toBe("function");
      expect(typeof calledCtx.a11yTree.refreshPrecomputed).toBe("function");
      expect(typeof calledCtx.a11yTree.reset).toBe("function");
      expect(typeof calledCtx.a11yTree.diffSnapshots).toBe("function");
      expect(typeof calledCtx.a11yTree.formatDomDiff).toBe("function");
      expect(calledCtx.a11yTree.diffSnapshots).toBe(A11yTreeProcessor.diffSnapshots);
      expect(calledCtx.a11yTree.formatDomDiff).toBe(A11yTreeProcessor.formatDomDiff);
      expect(calledCtx.a11yTreeDiffs).toBe(A11yTreeProcessor);
      expect(calledCtx.waitForAXChange).toBe(waitForAXChange);
      expect(calledCtx.cdpClient).toBe(mockCdpClient);
      expect(calledCtx.sessionId).toBe("session-1");
      expect(calledCtx.sessionManager).toBeUndefined();

      // Hook result was merged into the original via Object.assign
      expect(result.content.length).toBeGreaterThanOrEqual(2);
      const lastBlock = result.content[result.content.length - 1] as {
        text: string;
      };
      expect(lastBlock.text).toBe("enhanced");
    });

    it("executeTool skips onToolResult hook when result.isError is true", async () => {
      // Mock cdpClient that makes evaluate fail with isError
      const mockCdpClient = {
        send: vi.fn().mockRejectedValue(new Error("boom")),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const hookFn = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
        async (_name, result, _ctx) => result,
      );
      registerProHooks({ onToolResult: hookFn });

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();

      const result = await registry.executeTool("evaluate", {
        expression: "throw new Error()",
        await_promise: false,
      });

      expect(result.isError).toBe(true);
      expect(hookFn).not.toHaveBeenCalled();
    });

    it("executeTool does not invoke hook when no onToolResult is registered", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 42 } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      // Explicitly empty hooks
      registerProHooks({});

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();

      const result = await registry.executeTool("evaluate", {
        expression: "21*2",
        await_promise: false,
      });

      // Free-tier default: no ambient context injected
      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { text: string }).text).toBe("42");
      // Only the tool result content block should remain
      expect(result.content).toHaveLength(1);
    });

    it("executeTool calls a11yTree.reset() when tool is navigate (even without hook)", async () => {
      const mockCdpClient = {
        send: vi.fn().mockImplementation(async (method: string) => {
          if (method === "Page.navigate") return { frameId: "frame1" };
          if (method === "Runtime.evaluate")
            return { result: { type: "string", value: "complete" } };
          return {};
        }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      // No hook registered
      registerProHooks({});

      const resetSpy = vi.spyOn(a11yTree, "reset");
      resetSpy.mockClear();

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();

      await registry.executeTool("navigate", { url: "http://example.com" });

      expect(resetSpy).toHaveBeenCalled();
      resetSpy.mockRestore();
    });

    it("executeTool calls a11yTree.reset() before invoking hook for navigate", async () => {
      const mockCdpClient = {
        send: vi.fn().mockImplementation(async (method: string) => {
          if (method === "Page.navigate") return { frameId: "frame1" };
          if (method === "Runtime.evaluate")
            return { result: { type: "string", value: "complete" } };
          return {};
        }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const resetSpy = vi.spyOn(a11yTree, "reset");
      resetSpy.mockClear();

      const hookFn = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
        async (_name, result, _ctx) => result,
      );
      registerProHooks({ onToolResult: hookFn });

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();

      await registry.executeTool("navigate", { url: "http://example.com" });

      expect(resetSpy).toHaveBeenCalled();
      expect(hookFn).toHaveBeenCalledTimes(1);

      // Assert call order: reset ran before the hook
      const resetOrder = resetSpy.mock.invocationCallOrder[0];
      const hookOrder = hookFn.mock.invocationCallOrder[0];
      expect(resetOrder).toBeLessThan(hookOrder);
      resetSpy.mockRestore();
    });

    it("executeTool passes waitForAXChange callback to hook context", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 1 } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const waitForAXChange = vi.fn().mockResolvedValue(true);

      const hookFn = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
        async (_name, result, ctx) => {
          await ctx.waitForAXChange?.(500);
          return result;
        },
      );
      registerProHooks({ onToolResult: hookFn });

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
        undefined,
        waitForAXChange,
      );
      registry.registerAll();

      await registry.executeTool("evaluate", {
        expression: "1",
        await_promise: false,
      });

      expect(waitForAXChange).toHaveBeenCalledWith(500);
    });

    it("executeTool passes sessionId and cdpClient to hook context", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 1 } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const captured: {
        sessionId?: string;
        cdpClient?: unknown;
      } = {};
      registerProHooks({
        onToolResult: async (_name, result, ctx) => {
          captured.sessionId = ctx.sessionId;
          captured.cdpClient = ctx.cdpClient;
          return result;
        },
      });

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-42",
        {} as never,
      );
      registry.registerAll();

      await registry.executeTool("evaluate", {
        expression: "1",
        await_promise: false,
      });

      expect(captured.sessionId).toBe("session-42");
      expect(captured.cdpClient).toBe(mockCdpClient);
    });

    // M2: wrap-callsite coverage — the onToolResult hook must also fire on
    // the direct server.tool() path (wrap closure), not only via executeTool.
    it("wrap (MCP path, no sessionDefaults) invokes onToolResult hook", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "string", value: "wrapped" } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const hookFn = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
        async (_name, result, _ctx) => ({
          ...result,
          content: [
            ...result.content,
            { type: "text" as const, text: "wrap-enhanced" },
          ],
        }),
      );
      registerProHooks({ onToolResult: hookFn });

      // No sessionDefaults — exercises the early-return wrap branch
      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-wrap-1",
        {} as never,
      );
      registry.registerAll();

      const evaluateCall = toolFn.mock.calls.find(
        (call: unknown[]) => call[0] === "evaluate",
      );
      expect(evaluateCall).toBeDefined();
      const evaluateCallback = evaluateCall![evaluateCall!.length - 1] as (
        params: Record<string, unknown>,
      ) => Promise<{
        content: Array<{ type: string; text?: string }>;
        _meta?: Record<string, unknown>;
      }>;

      const result = await evaluateCallback({
        expression: "'wrapped'",
        await_promise: false,
      });

      expect(hookFn).toHaveBeenCalledTimes(1);
      const [calledName, , calledCtx] = hookFn.mock.calls[0];
      expect(calledName).toBe("evaluate");
      expect(calledCtx.sessionId).toBe("session-wrap-1");
      expect(calledCtx.cdpClient).toBe(mockCdpClient);
      // Hook-merged content appended
      const lastBlock = result.content[result.content.length - 1] as {
        text: string;
      };
      expect(lastBlock.text).toBe("wrap-enhanced");
      // M1: response_bytes was still injected (proves _meta ref is stable)
      expect(result._meta).toBeDefined();
      expect(typeof result._meta!.response_bytes).toBe("number");
    });

    it("wrap (MCP path, with sessionDefaults) invokes onToolResult hook", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "string", value: "wrapped2" } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const hookFn = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
        async (_name, result, _ctx) => ({
          ...result,
          content: [
            ...result.content,
            { type: "text" as const, text: "wrap-enhanced-sd" },
          ],
        }),
      );
      registerProHooks({ onToolResult: hookFn });

      const sessionDefaults = new SessionDefaults();

      // With sessionDefaults — exercises the other wrap branch
      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-wrap-2",
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

      const evaluateCall = toolFn.mock.calls.find(
        (call: unknown[]) => call[0] === "evaluate",
      );
      expect(evaluateCall).toBeDefined();
      const evaluateCallback = evaluateCall![evaluateCall!.length - 1] as (
        params: Record<string, unknown>,
      ) => Promise<{
        content: Array<{ type: string; text?: string }>;
        _meta?: Record<string, unknown>;
      }>;

      const result = await evaluateCallback({
        expression: "'wrapped2'",
        await_promise: false,
      });

      expect(hookFn).toHaveBeenCalledTimes(1);
      const [calledName, , calledCtx] = hookFn.mock.calls[0];
      expect(calledName).toBe("evaluate");
      expect(calledCtx.sessionId).toBe("session-wrap-2");
      // Hook-merged content appended
      const lastBlock = result.content[result.content.length - 1] as {
        text: string;
      };
      expect(lastBlock.text).toBe("wrap-enhanced-sd");
      // M1: response_bytes still injected on original _meta ref
      expect(result._meta).toBeDefined();
      expect(typeof result._meta!.response_bytes).toBe("number");
    });

    // M1: Guard regression — hook returning a new _meta object must not
    // detach downstream mutations. Verify via executeTool path (simpler setup).
    it("executeTool keeps original _meta reference when hook returns new _meta", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 7 } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      // Hook returns a fresh object with a NEW _meta — this used to
      // silently detach downstream injections (response_bytes, suggestion).
      registerProHooks({
        onToolResult: async (_name, result, _ctx) => ({
          ...result,
          _meta: { elapsedMs: 999, method: "hijacked" },
        }),
      });

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-meta",
        {} as never,
      );
      registry.registerAll();

      const result = await registry.executeTool("evaluate", {
        expression: "7",
        await_promise: false,
      });

      // Original _meta must survive (not overwritten by hook)
      expect(result._meta).toBeDefined();
      expect(result._meta!.method).toBe("evaluate");
      // response_bytes must have been injected on the original _meta
      expect(typeof result._meta!.response_bytes).toBe("number");
      expect((result._meta!.response_bytes as number) > 0).toBe(true);
    });
  });

  // --- Story 16.5: enhanceTool hook wiring ---
  describe("enhanceTool hook", () => {
    it("enhanceTool hook is invoked during wrap() path (server.tool direct call)", async () => {
      const enhanceToolSpy = vi.fn().mockReturnValue(null);
      registerProHooks({ enhanceTool: enhanceToolSpy });

      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 1 } }),
      } as never;
      let registeredEvaluateHandler:
        | ((params: Record<string, unknown>) => Promise<unknown>)
        | null = null;
      const toolFn = vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
        if (name === "evaluate") {
          registeredEvaluateHandler = handler as typeof registeredEvaluateHandler;
        }
      });
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();

      expect(registeredEvaluateHandler).not.toBeNull();
      // Invoke via the server.tool()-registered wrap() closure (MCP direct path)
      await registeredEvaluateHandler!({
        expression: "1",
        await_promise: false,
      });

      expect(enhanceToolSpy).toHaveBeenCalled();
      const call = enhanceToolSpy.mock.calls[0];
      expect(call[0]).toBe("evaluate");
      expect(call[1]).toEqual(
        expect.objectContaining({ expression: "1", await_promise: false }),
      );
    });

    it("enhanceTool return value replaces params passed to handler (wrap path)", async () => {
      // The hook substitutes the expression entirely. We assert that the
      // substituted expression — NOT the original — reaches the CDP layer,
      // which proves that the new params object returned by the hook was
      // actually forwarded to the handler.
      const enhanceToolSpy = vi
        .fn()
        .mockImplementation((name: string, params: Record<string, unknown>) => {
          if (name !== "evaluate") return null;
          return { ...params, expression: "ENHANCED_EXPR" };
        });
      registerProHooks({ enhanceTool: enhanceToolSpy });

      const sendSpy = vi.fn().mockResolvedValue({
        result: { type: "number", value: 1 },
      });
      const mockCdpClient = { send: sendSpy } as never;
      let registeredEvaluateHandler:
        | ((params: Record<string, unknown>) => Promise<unknown>)
        | null = null;
      const toolFn = vi.fn((name: string, _d: string, _s: unknown, handler: unknown) => {
        if (name === "evaluate") {
          registeredEvaluateHandler = handler as typeof registeredEvaluateHandler;
        }
      });
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();

      await registeredEvaluateHandler!({
        expression: "ORIGINAL_EXPR",
        await_promise: false,
      });

      expect(enhanceToolSpy).toHaveBeenCalled();
      // The handler MUST have been called with the enhanced params:
      // Runtime.evaluate is dispatched with the substituted expression.
      // (Filter to user-driven evaluate calls — internal session-overlay sniffs
      // also use Runtime.evaluate but pass different shape.)
      const evaluateCalls = sendSpy.mock.calls.filter(
        (c) =>
          c[0] === "Runtime.evaluate" &&
          typeof (c[1] as { expression?: string }).expression === "string" &&
          ((c[1] as { expression: string }).expression === "ENHANCED_EXPR" ||
            (c[1] as { expression: string }).expression === "ORIGINAL_EXPR"),
      );
      expect(evaluateCalls.length).toBe(1);
      const evalArgs = evaluateCalls[0][1] as { expression: string };
      expect(evalArgs.expression).toBe("ENHANCED_EXPR");
      // And NOT with the original expression — proving substitution happened.
      const calledWithOriginal = sendSpy.mock.calls.some(
        (c) =>
          c[0] === "Runtime.evaluate" &&
          (c[1] as { expression?: string }).expression === "ORIGINAL_EXPR",
      );
      expect(calledWithOriginal).toBe(false);
    });

    it("enhanceTool returning null leaves params unchanged (wrap path)", async () => {
      const enhanceToolSpy = vi.fn().mockReturnValue(null);
      registerProHooks({ enhanceTool: enhanceToolSpy });

      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 1 } }),
      } as never;
      let registeredEvaluateHandler:
        | ((params: Record<string, unknown>) => Promise<unknown>)
        | null = null;
      const toolFn = vi.fn((name: string, _d: string, _s: unknown, handler: unknown) => {
        if (name === "evaluate") {
          registeredEvaluateHandler = handler as typeof registeredEvaluateHandler;
        }
      });
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();

      const result = await registeredEvaluateHandler!({
        expression: "1",
        await_promise: false,
      });

      expect(enhanceToolSpy).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("enhanceTool hook is invoked during executeTool() path (run_plan)", async () => {
      const enhanceToolSpy = vi.fn().mockReturnValue(null);
      registerProHooks({ enhanceTool: enhanceToolSpy });

      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 42 } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();

      await registry.executeTool("evaluate", {
        expression: "1",
        await_promise: false,
      });

      // Must have been called at least once for evaluate (ignore featureGate etc.)
      const evaluateCalls = enhanceToolSpy.mock.calls.filter(
        (c) => c[0] === "evaluate",
      );
      expect(evaluateCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("executeTool runs normally when no enhanceTool hook is registered", async () => {
      // Default empty hooks — no enhanceTool
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 7 } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();

      const result = await registry.executeTool("evaluate", {
        expression: "7",
        await_promise: false,
      });

      expect(result).toBeDefined();
      expect(result.isError).toBeFalsy();
    });
  });
});

// Story 16.4 H2/H3/M1: Unit-Tests fuer den JSON-Schema → Zod-Shape Konverter,
// der von `_registerProToolDelegate` benutzt wird, um Pro-Repo Tool-Schemas
// in MCP-SDK-kompatible Zod-Shapes zu uebersetzen.
describe("jsonSchemaToZodShape", () => {
  it("converts string, boolean, number primitives", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        name: { type: "string" },
        active: { type: "boolean" },
        count: { type: "number" },
      },
      required: ["name", "active", "count"],
    });

    const obj = z.object(shape);
    expect(obj.parse({ name: "x", active: true, count: 1.5 })).toEqual({
      name: "x",
      active: true,
      count: 1.5,
    });
    expect(() => obj.parse({ name: 1, active: true, count: 1 })).toThrow();
  });

  it("converts string with enum to z.enum", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "slow"] },
      },
      required: ["mode"],
    });

    const obj = z.object(shape);
    expect(obj.parse({ mode: "fast" })).toEqual({ mode: "fast" });
    expect(obj.parse({ mode: "slow" })).toEqual({ mode: "slow" });
    expect(() => obj.parse({ mode: "medium" })).toThrow();
  });

  it("converts integer to z.number().int()", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        port: { type: "integer" },
      },
      required: ["port"],
    });

    const obj = z.object(shape);
    expect(obj.parse({ port: 9222 })).toEqual({ port: 9222 });
    // Floats must be rejected
    expect(() => obj.parse({ port: 9222.5 })).toThrow();
  });

  it("converts array-of-string and array-of-object", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              label: { type: "string" },
            },
            required: ["id", "label"],
          },
        },
      },
      required: ["tags", "items"],
    });

    const obj = z.object(shape);
    const parsed = obj.parse({
      tags: ["a", "b"],
      items: [
        { id: 1, label: "one" },
        { id: 2, label: "two" },
      ],
    });
    expect(parsed.tags).toEqual(["a", "b"]);
    expect(parsed.items).toHaveLength(2);
    // Reject array entries with wrong shape
    expect(() =>
      obj.parse({ tags: ["a"], items: [{ id: "not-int", label: "x" }] }),
    ).toThrow();
  });

  it("converts nested object schemas recursively", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "integer" },
          },
          required: ["name"],
        },
      },
      required: ["user"],
    });

    const obj = z.object(shape);
    expect(obj.parse({ user: { name: "Alice", age: 30 } })).toEqual({
      user: { name: "Alice", age: 30 },
    });
    // Nested optional: age may be omitted (no default, not required)
    expect(obj.parse({ user: { name: "Bob" } })).toEqual({
      user: { name: "Bob" },
    });
    // Nested required: name must exist
    expect(() => obj.parse({ user: {} })).toThrow();
  });

  it("applies defaults via .default() (no .optional() chained) and falls back when undefined", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        verbose: { type: "boolean", default: true },
        level: { type: "integer", default: 3 },
      },
      // verbose & level are NOT in required — but they have defaults,
      // so the result should still always include them.
      required: [],
    });

    const obj = z.object(shape);
    // Default is applied when input omits the field
    expect(obj.parse({})).toEqual({ verbose: true, level: 3 });
    // Explicit value overrides default
    expect(obj.parse({ verbose: false, level: 7 })).toEqual({
      verbose: false,
      level: 7,
    });
    // The field schema itself must be a ZodDefault, NOT a ZodOptional that
    // wraps a ZodDefault. (Reviewer H3: .default().optional() is wrong.)
    expect(shape.verbose).toBeInstanceOf(z.ZodDefault);
    expect(shape.level).toBeInstanceOf(z.ZodDefault);
  });

  it("treats fields not in `required` (and without default) as optional", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        must: { type: "string" },
        maybe: { type: "string" },
      },
      required: ["must"],
    });

    const obj = z.object(shape);
    expect(obj.parse({ must: "hello" })).toEqual({ must: "hello" });
    expect(obj.parse({ must: "hello", maybe: "world" })).toEqual({
      must: "hello",
      maybe: "world",
    });
    expect(() => obj.parse({})).toThrow();
    // Schema-level: maybe is wrapped in ZodOptional, must is not
    expect(shape.maybe).toBeInstanceOf(z.ZodOptional);
    expect(shape.must).not.toBeInstanceOf(z.ZodOptional);
  });

  it("falls back to z.unknown() for unrecognized types", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        weird: { type: "fancy-thing" as unknown as string },
      },
      required: ["weird"],
    });

    const obj = z.object(shape);
    // z.unknown() accepts anything
    expect(obj.parse({ weird: { a: 1 } })).toEqual({ weird: { a: 1 } });
    expect(obj.parse({ weird: "string" })).toEqual({ weird: "string" });
    expect(obj.parse({ weird: 42 })).toEqual({ weird: 42 });
  });
});
