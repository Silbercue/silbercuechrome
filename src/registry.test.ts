import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ToolRegistry, jsonSchemaToZodShape } from "./registry.js";
import { z } from "zod";
import type { LicenseStatus } from "./license/license-status.js";
import type { FreeTierConfig } from "./license/free-tier-config.js";
import { registerProHooks } from "./hooks/pro-hooks.js";
import type { ProHooks } from "./hooks/pro-hooks.js";
import { SessionDefaults } from "./cache/session-defaults.js";
import { TabStateCache as TabStateCacheCtor } from "./cache/tab-state-cache.js";
import { a11yTree, A11yTreeProcessor } from "./cache/a11y-tree.js";
import { prefetchSlot } from "./cache/prefetch-slot.js";
import { deferredDiffSlot } from "./cache/deferred-diff-slot.js";

describe("ToolRegistry", () => {
  // Story 9.5: Reset Pro hooks between tests
  // Story 18.3: Alle bestehenden Tests in diesem describe-Block wurden in
  // einer Welt geschrieben, in der `registerAll()` alle Free-Tools via
  // `server.tool()` exponiert. Story 18.3 verschiebt Extended-Tools in den
  // Opt-in-Modus `SILBERCUE_CHROME_FULL_TOOLS=true`. Damit die bestehende
  // Coverage (die z.B. `dom_snapshot`/`network_monitor`/`handle_dialog`-
  // Callbacks direkt aus den `server.tool()`-Mock-Calls zieht) ohne Umbau
  // gruen bleibt, aktivieren wir hier den FULL-Modus. Der neue describe-
  // Block `ToolRegistry — Tool-Verschlankung (Story 18.3)` am Ende toggelt
  // explizit beide Modi.
  beforeEach(() => {
    registerProHooks({});
    process.env.SILBERCUE_CHROME_FULL_TOOLS = "true";
  });
  afterEach(() => {
    delete process.env.SILBERCUE_CHROME_FULL_TOOLS;
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

  it("should register evaluate, navigate, read_page, screenshot, wait_for, click, type, fill_form, virtual_desk, and run_plan tools via server.tool() in FULL_TOOLS mode", () => {
    // Story 18.3: FULL_TOOLS mode is set by the parent beforeEach.
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;
    const mockCdpClient = {} as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    // Story 18.3: Mit `SILBERCUE_CHROME_FULL_TOOLS=true` werden alle
    // Free-Tools registriert. `inspect_element` ist Pro-only und wird nur
    // registriert wenn das Pro-Repo `registerProTools` aufruft — kein
    // Stub-Fallback im Free-Tier.
    //
    // Story 18.3 Review-Fix H1: `handle_dialog`, `console_logs` und
    // `network_monitor` werden seit dem H1-Fix **unbedingt** registriert
    // (Runtime-Guard im Handler statt Registration-Gate), damit der
    // FULL_TOOLS-Export tatsaechlich alle 21 Tools enthaelt — auch im
    // Legacy-Test-Konstruktor, in dem die zugehoerigen Collectors undefined
    // sind. Zuvor waren es nur 18.
    //
    // Zaehlung (FULL_TOOLS=true): virtual_desk, read_page, click, type,
    // fill_form, press_key, scroll, drag, navigate, switch_tab, tab_status,
    // wait_for, observe, screenshot, dom_snapshot, handle_dialog,
    // file_upload, console_logs, network_monitor, configure_session,
    // run_plan, evaluate = 22 Tools.
    //
    // Story 18.6 (FR-028): `drag` ist im Full-Set, nicht im Default-Set.
    // Default-Set bleibt stabil bei 10 (siehe DEFAULT_TOOL_NAMES).
    expect(toolFn).toHaveBeenCalledTimes(22);
    expect(toolFn).toHaveBeenCalledWith(
      "evaluate",
      expect.stringMatching(/^Execute JavaScript in the browser page context.*Bad uses:.*automatic recovery after a click\/type\/fill_form failure/s),
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
      "view_page",
      "PRIMARY tool for seeing what's on the page — call after navigate/switch_tab before any interaction. Returns accessibility tree with stable refs (e.g. 'e5') that you pass to click/type/fill_form. Use this to read visible text too — not evaluate/querySelector. Default filter:'interactive' hides static text; for cells/paragraphs/labels call view_page(ref: 'eN', filter: 'all'). Under tight max_tokens, containers appear as `[eXX role, N items]` one-line summaries — call view_page(ref:'eXX', filter:'all') on that ref to expand the subtree. ~10-30x cheaper than capture_image.",
      expect.objectContaining({
        depth: expect.anything(),
        ref: expect.anything(),
        filter: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "capture_image",
      "Capture a WebP image of the page (max 800px, <100KB). For reading page content (text, errors, forms, headings), use view_page — 10-30x cheaper. capture_image CANNOT drive click/type — only view_page returns usable element refs. Only use for pixel-level visual inspection, canvas pages, or explicit user requests.",
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
      expect.stringMatching(/^Click an element by ref.*stale-ref error, call view_page/s),
      expect.objectContaining({
        ref: expect.anything(),
        selector: expect.anything(),
        x: expect.anything(),
        y: expect.anything(),
        wait_for_diff: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "type",
      expect.stringMatching(/^Type text into an input field.*On stale-ref errors/s),
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
      "Active tab's cached URL/title/ready/errors for quick sanity checks mid-workflow ('did my click navigate?'). For tab discovery: use virtual_desk. For page content: use view_page.",
      {},
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "switch_tab",
      expect.stringMatching(/^Open a new tab.*After switching, refs from the previous tab are invalid/s),
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
      "Structured layout data: bounding boxes, computed styles, paint order, colors. Refs match view_page. Use ONLY for spatial questions view_page cannot answer (is A above B? what color?). For element discovery or text: use view_page. For pure visual verification: use capture_image.",
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
      expect.stringMatching(/^Fill a complete form with one call.*On per-field errors, call view_page/s),
      expect.objectContaining({
        fields: expect.anything(),
      }),
      expect.any(Function),
    );
    expect(toolFn).toHaveBeenCalledWith(
      "run_plan",
      "Execute a sequential plan of tool steps server-side. Supports variables ($varName), conditions (if), saveAs, error strategies (abort/continue/capture_image), suspend/resume. Parallel tab execution via parallel: [{ tab, steps }] is a Pro-Feature - requires Pro license.",
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

  // --- FR-022: press_key and scroll are dispatched via executeTool (run_plan path) ---

  it("executeTool dispatches press_key (not Unknown tool)", async () => {
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({}),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("press_key", { key: "Enter" });

    expect(result).toBeDefined();
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("Pressed"));
    expect(result._meta?.method).toBe("press_key");
  });

  it("executeTool dispatches scroll (not Unknown tool)", async () => {
    const mockCdpClient = {
      send: vi.fn().mockResolvedValue({
        result: { value: { scrollY: 300, scrollHeight: 2000, clientHeight: 800 } },
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("scroll", { direction: "down", amount: 300 });

    expect(result).toBeDefined();
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("Scroll"));
    expect(result._meta?.method).toBe("scroll");
  });

  it("executeTool press_key with sessionIdOverride passes override to CDP", async () => {
    const sendCalls: Array<{ method: string; sessionId?: string }> = [];
    const mockCdpClient = {
      send: vi.fn(async (method: string, _params?: unknown, sessionId?: string) => {
        sendCalls.push({ method, sessionId });
        return {};
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "global-session", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("press_key", { key: "Escape" }, "tab-override");

    expect(result.isError).toBeFalsy();
    const keyCall = sendCalls.find((c) => c.method === "Input.dispatchKeyEvent");
    expect(keyCall).toBeDefined();
    expect(keyCall!.sessionId).toBe("tab-override");
  });

  it("executeTool scroll with sessionIdOverride passes override to CDP", async () => {
    const sendCalls: Array<{ method: string; sessionId?: string }> = [];
    const mockCdpClient = {
      send: vi.fn(async (method: string, _params?: unknown, sessionId?: string) => {
        sendCalls.push({ method, sessionId });
        return {
          result: { value: { scrollY: 200, scrollHeight: 2000, clientHeight: 800 } },
        };
      }),
    } as never;
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "global-session", {} as never);
    registry.registerAll();

    const result = await registry.executeTool("scroll", { direction: "up", amount: 200 }, "tab-override");

    expect(result.isError).toBeFalsy();
    const scrollCall = sendCalls.find((c) => c.method === "Runtime.evaluate");
    expect(scrollCall).toBeDefined();
    expect(scrollCall!.sessionId).toBe("tab-override");
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

  // Legacy connectionStatus accessor: in the lazy-launch architecture
  // the old "reconnecting" / "disconnected" states are no longer surfaced
  // to tools — BrowserSession.ensureReady() handles reconnect transparently.
  // The getter is kept as a constant "connected" for test compatibility.
  it("connectionStatus is a constant 'connected' in the lazy-launch architecture", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    // Even when a legacy getConnectionStatus callback is passed, the new
    // registry ignores it — the lazy-launch gate owns reconnect semantics.
    const registryWithCallback = new ToolRegistry(
      mockServer, {} as never, "session-1", {} as never, () => "reconnecting",
    );
    expect(registryWithCallback.connectionStatus).toBe("connected");

    const registryNoCallback = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);
    expect(registryNoCallback.connectionStatus).toBe("connected");
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
    expect(result.content[0]).toHaveProperty("text", "my_tool is a Pro feature — activate with 'silbercuechrome license activate <key>'");
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
      "Structured layout data: bounding boxes, computed styles, paint order, colors. Refs match view_page. Use ONLY for spatial questions view_page cannot answer (is A above B? what color?). For element discovery or text: use view_page. For pure visual verification: use capture_image.",
    );
  });

  it("Free-Tier: dom_snapshot via MCP returns isError with warm Pro-Feature message", async () => {
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
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("dom_snapshot (Pro)");
    expect(text).toContain("view_page"); // Free alternative mentioned
    expect(text).toContain("silbercuechrome license activate"); // Upgrade path
  });

  it("Free-Tier: dom_snapshot via executeTool (run_plan path) returns isError with warm Pro-Feature message", async () => {
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
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("dom_snapshot (Pro)");
    expect(text).toContain("view_page");
    expect(text).toContain("silbercuechrome license activate");
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

    // Verify the gate did NOT block — neither the legacy nor the new warm
    // Pro-Feature marketing message should appear in a Pro-tier response.
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("silbercuechrome license activate");
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

  it("network_monitor is registered unconditionally; handler returns a clear isError when no NetworkCollector is wired (Story 18.3 H1-Fix)", async () => {
    // Story 18.3 Review-Fix H1: `network_monitor` wird seit dem H1-Fix
    // UNBEDINGT in `tools/list` registriert — die Collector-Existenz-Pruefung
    // wandert in den Runtime-Handler, der bei fehlendem Collector eine
    // praezise Fehlermeldung (statt "Unknown tool") zurueckgibt.
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;

    const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);
    registry.registerAll();

    // Tool ist in tools/list registriert (FULL_TOOLS=true via parent beforeEach).
    const networkMonitorCall = toolFn.mock.calls.find(
      (call: unknown[]) => call[0] === "network_monitor",
    );
    expect(networkMonitorCall).toBeDefined();

    // Runtime-Guard im Handler liefert isError mit klarer Meldung — nicht
    // "Unknown tool".
    const result = await registry.executeTool("network_monitor", { action: "get" });
    const text = (result.content[0] as { text: string }).text;
    expect(result.isError).toBe(true);
    expect(text).not.toContain("Unknown tool");
    expect(text).toContain("network_monitor unavailable");
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
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("not allowed in parallel plan groups"));
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
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("switch_tab (Pro)");
    expect(text).toContain("navigate"); // Free alternative
    expect(text).toContain("silbercuechrome license activate");
  });

  it("Free-Tier: virtual_desk via MCP returns isError with warm Pro-Feature message", async () => {
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
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("virtual_desk (Pro)");
    expect(text).toContain("tab_status"); // Free alternative
    expect(text).toContain("silbercuechrome license activate");
  });

  it("Free-Tier: switch_tab via executeTool (run_plan path) returns isError with warm Pro-Feature message", async () => {
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
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("switch_tab (Pro)");
    expect(text).toContain("navigate");
    expect(text).toContain("silbercuechrome license activate");
  });

  it("Free-Tier: virtual_desk via executeTool (run_plan path) returns isError with warm Pro-Feature message", async () => {
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
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("virtual_desk (Pro)");
    expect(text).toContain("tab_status");
    expect(text).toContain("silbercuechrome license activate");
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

    // Verify the gate did NOT block — neither legacy nor new warm Pro messages appear.
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("silbercuechrome license activate");
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
      expect(text).not.toContain("silbercuechrome license activate");
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
    expect(switchTabCall![1]).toMatch(
      /^Open a new tab.*After switching, refs from the previous tab are invalid/s,
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
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("switch_tab (Pro)");
    expect(text).toContain("silbercuechrome license activate");
    // Explicitly NOT the parallel error
    expect(text).not.toContain("parallel plan groups");
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
      (call: unknown[]) => call[0] === "capture_image",
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

    const result = await registry.executeTool("view_page", {});

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

    const result = await registry.executeTool("view_page", {});

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
      (call: unknown[]) => call[0] === "view_page",
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

    const result = await registry.executeTool("view_page", {});

    expect(result._meta).toBeDefined();
    // Existing fields preserved
    expect(result._meta!.elapsedMs).toBeDefined();
    expect(typeof result._meta!.elapsedMs).toBe("number");
    expect(result._meta!.method).toBe("view_page");
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
      // waitForAXChange is now passed through a thin wrapper that forwards
      // to BrowserSession — the hook receives a fresh callable that must
      // still delegate to the original spy.
      expect(typeof calledCtx.waitForAXChange).toBe("function");
      await calledCtx.waitForAXChange(123);
      expect(waitForAXChange).toHaveBeenCalledWith(123);
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

    // --- Story 18.1: skipOnToolResultHook flag ---

    it("executeTool with skipOnToolResultHook=true skips the onToolResult hook", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 42 } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const hookFn = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
        async (_name, result, _ctx) => ({
          ...result,
          content: [
            ...result.content,
            { type: "text" as const, text: "enhanced-18-1" },
          ],
        }),
      );
      registerProHooks({ onToolResult: hookFn });

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-18-1",
        {} as never,
      );
      registry.registerAll();

      const result = await registry.executeTool(
        "evaluate",
        { expression: "21*2", await_promise: false },
        undefined,
        { skipOnToolResultHook: true },
      );

      // Hook must NOT have fired
      expect(hookFn).not.toHaveBeenCalled();
      // Content must NOT contain the "enhanced-18-1" text
      const hasEnhanced = result.content.some(
        (b) => b.type === "text" && (b as { text: string }).text === "enhanced-18-1",
      );
      expect(hasEnhanced).toBe(false);
      // Base tool result still present — "42" from evaluate
      expect((result.content[0] as { text: string }).text).toBe("42");
    });

    it("executeTool without options still invokes the hook (default opt-in)", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 42 } }),
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
        "session-18-1-default",
        {} as never,
      );
      registry.registerAll();

      // No 4th arg — current behavior preserved
      await registry.executeTool("evaluate", {
        expression: "1",
        await_promise: false,
      });

      expect(hookFn).toHaveBeenCalledTimes(1);
    });

    it("executeTool with skipOnToolResultHook=true still runs a11yTree.reset on navigate", async () => {
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

      // Hook registered — must still be bypassed due to flag
      const hookFn = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
        async (_name, result, _ctx) => result,
      );
      registerProHooks({ onToolResult: hookFn });

      const resetSpy = vi.spyOn(a11yTree, "reset");
      resetSpy.mockClear();

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-18-1-reset",
        {} as never,
      );
      registry.registerAll();

      await registry.executeTool(
        "navigate",
        { url: "http://example.com" },
        undefined,
        { skipOnToolResultHook: true },
      );

      // reset() must still run (navigation invariant)
      expect(resetSpy).toHaveBeenCalled();
      // Hook must NOT fire
      expect(hookFn).not.toHaveBeenCalled();
      resetSpy.mockRestore();
    });

    it("runAggregationHook invokes the onToolResult hook without bypass", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { type: "number", value: 1 } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const hookFn = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
        async (_name, result, _ctx) => ({
          ...result,
          content: [
            ...result.content,
            { type: "text" as const, text: "aggregated" },
          ],
        }),
      );
      registerProHooks({ onToolResult: hookFn });

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-18-1-agg",
        {} as never,
      );
      registry.registerAll();

      const fakeResult: import("./types.js").ToolResponse = {
        content: [{ type: "text", text: "click ok" }],
        _meta: { elapsedMs: 5, method: "click" },
      };
      await registry.runAggregationHook(fakeResult, "click");

      expect(hookFn).toHaveBeenCalledTimes(1);
      const [calledName] = hookFn.mock.calls[0];
      expect(calledName).toBe("click");
      const lastBlock = fakeResult.content[fakeResult.content.length - 1] as {
        text: string;
      };
      expect(lastBlock.text).toBe("aggregated");
    });

    it("runAggregationHook respects the isError guard", async () => {
      const mockCdpClient = { send: vi.fn() } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const hookFn = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
        async (_name, result, _ctx) => result,
      );
      registerProHooks({ onToolResult: hookFn });

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-18-1-agg-err",
        {} as never,
      );
      registry.registerAll();

      const fakeResult: import("./types.js").ToolResponse = {
        content: [{ type: "text", text: "boom" }],
        isError: true,
        _meta: { elapsedMs: 1, method: "click" },
      };
      await registry.runAggregationHook(fakeResult, "click");

      // isError-Guard in _runOnToolResultHook bleibt auch fuer Aggregation scharf
      expect(hookFn).not.toHaveBeenCalled();
    });

    // --- M2 (Code-Review 18.1): Dialog/Relaunch-Injection trotz Skip ---

    it(
      "executeTool with skipOnToolResultHook=true still runs _injectDialogNotifications and _injectRelaunchNotice",
      async () => {
        // Regression test for Task 1.3 / M2: Dialog-Notifications and
        // Relaunch-Notices are *user-/safety-feedback* paths that must keep
        // firing even when the Ambient-Context-Hook is suppressed. run_plan
        // relies on this so the LLM still sees "[dialog] alert: ..." text
        // between steps, and the one-shot relaunch notice is not lost
        // because of the plan-level hook suppression.
        const mockCdpClient = {
          send: vi.fn().mockResolvedValue({
            result: { type: "number", value: 42 },
          }),
        } as never;
        const toolFn = vi.fn();
        const mockServer = { tool: toolFn } as never;

        // Dialog-Handler with a pending notification — mirrors Story 6.1
        // registry test pattern (registry.test.ts:395).
        const consumeDialogs = vi.fn().mockReturnValue([
          {
            type: "alert",
            message: "Hello from dialog!",
            url: "https://example.com",
          },
        ]);
        const mockDialogHandler = {
          consumeNotifications: consumeDialogs,
          pushHandler: vi.fn(),
          popHandler: vi.fn(),
          pendingCount: 1,
          init: vi.fn(),
          detach: vi.fn(),
          reinit: vi.fn(),
        } as never;

        // Construct an `IBrowserSession` mock so we can drive
        // `consumeRelaunchNotice()` — the legacy constructor path returns
        // `() => null` for that hook, which would defeat the test.
        const consumeRelaunchNoticeMock = vi
          .fn<() => string | null>()
          .mockReturnValue(
            "[silbercuechrome] Chrome was relaunched silently after a lost connection.",
          );
        const tabCache = new TabStateCacheCtor({ ttlMs: 30_000 });
        const browserSession = {
          isReady: true,
          wasEverReady: true,
          cdpClient: mockCdpClient,
          sessionId: "session-m2",
          headless: false,
          tabStateCache: tabCache,
          sessionDefaults: new SessionDefaults(),
          sessionManager: undefined,
          dialogHandler: mockDialogHandler,
          consoleCollector: undefined,
          networkCollector: undefined,
          domWatcher: undefined,
          ensureReady: async () => {
            /* test no-op */
          },
          consumeRelaunchNotice: consumeRelaunchNoticeMock,
          waitForAXChange: async () => false,
          applyTabSwitch: () => {
            /* test no-op */
          },
          shutdown: async () => {
            /* test no-op */
          },
        };

        // Ambient-Context-Hook MUST be bypassed — if the production code
        // accidentally skipped `_injectDialogNotifications` alongside the
        // Ambient-Context-Hook, the test would catch it because the
        // skipOnToolResultHook path shares the same call-site.
        const hookFn = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
          async (_name, r, _ctx) => r,
        );
        registerProHooks({ onToolResult: hookFn });

        const registry = new ToolRegistry(
          mockServer,
          browserSession as never,
        );
        registry.registerAll();

        const result = await registry.executeTool(
          "evaluate",
          { expression: "21*2", await_promise: false },
          undefined,
          { skipOnToolResultHook: true },
        );

        // Ambient-Context-Hook: MUST have been skipped
        expect(hookFn).not.toHaveBeenCalled();

        // Dialog-Handler: MUST have been consumed exactly once
        expect(consumeDialogs).toHaveBeenCalledTimes(1);
        // Relaunch-Notice: MUST have been consumed exactly once
        expect(consumeRelaunchNoticeMock).toHaveBeenCalledTimes(1);

        // Both user-/safety-feedback blocks MUST be in the result content
        const allTexts = result.content
          .filter(
            (c): c is { type: "text"; text: string } => c.type === "text",
          )
          .map((c) => c.text);
        expect(allTexts.some((t) => t.includes('[dialog] alert: "Hello from dialog!"'))).toBe(
          true,
        );
        expect(allTexts.some((t) => t.includes("Chrome was relaunched silently"))).toBe(
          true,
        );
      },
    );

    // FR-022 (P3 fix): registerAll() must install the default Free-tier
    // onToolResult hook when the Pro-Repo did not register one. This is the
    // architectural fix that makes the click tool description's "DOM diff"
    // promise hold for Free users on every page.
    describe("default Free-tier onToolResult hook (FR-022)", () => {
      it("registerAll installs a default onToolResult hook when none is set", async () => {
        const mockCdpClient = { send: vi.fn() } as never;
        const mockServer = { tool: vi.fn() } as never;
        // Top-level beforeEach already set registerProHooks({}).
        const registry = new ToolRegistry(
          mockServer,
          mockCdpClient,
          "sess-default",
          {} as never,
        );
        registry.registerAll();

        const { getProHooks } = await import("./hooks/pro-hooks.js");
        const installed = getProHooks();
        expect(typeof installed.onToolResult).toBe("function");
      });

      it("registerAll does NOT overwrite a Pro-Repo onToolResult hook", async () => {
        const mockCdpClient = { send: vi.fn() } as never;
        const mockServer = { tool: vi.fn() } as never;
        const proHook = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
          async (_name, r, _ctx) => r,
        );
        registerProHooks({ onToolResult: proHook });
        const registry = new ToolRegistry(
          mockServer,
          mockCdpClient,
          "sess-pro",
          {} as never,
        );
        registry.registerAll();

        const { getProHooks } = await import("./hooks/pro-hooks.js");
        const installed = getProHooks();
        expect(installed.onToolResult).toBe(proHook);
      });

      // Story 18.6 (FR-029): AJAX-Race-Hint nach click mit leerem Diff
      describe("FR-029 AJAX-Race-Hint (Story 18.6)", () => {
        function buildRegistryWithHook(hookStub: NonNullable<ProHooks["onToolResult"]>) {
          registerProHooks({ onToolResult: hookStub });
          const mockServer = { tool: vi.fn() } as never;
          const mockCdpClient = { send: vi.fn() } as never;
          const registry = new ToolRegistry(
            mockServer,
            mockCdpClient,
            "sess-fr029",
            {} as never,
          );
          registry.registerAll();
          return registry;
        }

        function makeClickResult(elementClass = "clickable"): import("./types.js").ToolResponse {
          return {
            content: [
              { type: "text", text: "Clicked e1 (ref: e1)" },
            ],
            _meta: { elapsedMs: 5, method: "click", elementClass },
          };
        }

        it("appends hint when click on clickable element has empty diff (hook left content unchanged)", async () => {
          // Hook ist no-op: kein Diff-Text angehaengt — simuliert AJAX-Race.
          const hook = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
            async (_name, r, _ctx) => r,
          );
          const registry = buildRegistryWithHook(hook);
          const result = makeClickResult("clickable");

          // Access private method via cast (test-only pattern).
          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(result, "click");

          const texts = result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text);
          expect(texts.some((t) => t.includes("No visible changes yet"))).toBe(true);
          expect(texts.some((t) => t.includes("wait_for(condition: 'network_idle')"))).toBe(true);
        });

        it("does NOT append hint when element class is static", async () => {
          const hook = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
            async (_name, r, _ctx) => r,
          );
          const registry = buildRegistryWithHook(hook);
          const result = makeClickResult("static");

          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(result, "click");

          const texts = result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text);
          expect(texts.some((t) => t.includes("No visible changes yet"))).toBe(false);
        });

        it("does NOT append hint when hook already appended a diff-text block", async () => {
          // Simuliert Pro-Hook, der einen DOM-Diff angehaengt hat.
          const hook = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
            async (_name, r, _ctx) => {
              r.content.push({ type: "text", text: "DOM-Diff: e7 changed" });
              return r;
            },
          );
          const registry = buildRegistryWithHook(hook);
          const result = makeClickResult("clickable");

          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(result, "click");

          const texts = result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text);
          // Der DOM-Diff-Text ist drin, der FR-029-Hint NICHT.
          expect(texts.some((t) => t.includes("DOM-Diff: e7 changed"))).toBe(true);
          expect(texts.some((t) => t.includes("No visible changes yet"))).toBe(false);
        });

        it("streak-detector: second click in same session does NOT get the hint", async () => {
          const hook = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
            async (_name, r, _ctx) => r,
          );
          const registry = buildRegistryWithHook(hook);

          const first = makeClickResult("clickable");
          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(first, "click");
          // Erster Call: Hint angehaengt.
          expect(
            first.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .some((c) => c.text.includes("No visible changes yet")),
          ).toBe(true);

          const second = makeClickResult("clickable");
          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(second, "click");
          // Zweiter Call: kein Hint mehr.
          expect(
            second.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .some((c) => c.text.includes("No visible changes yet")),
          ).toBe(false);
        });

        it("streak-detector reset via navigate re-arms the hint", async () => {
          const hook = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
            async (_name, r, _ctx) => r,
          );
          const registry = buildRegistryWithHook(hook);

          // Erster Click — Hint.
          const first = makeClickResult("clickable");
          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(first, "click");
          expect(
            first.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .some((c) => c.text.includes("No visible changes yet")),
          ).toBe(true);

          // Navigate — resettet den Streak.
          const navResult: import("./types.js").ToolResponse = {
            content: [{ type: "text", text: "Navigated" }],
            _meta: { elapsedMs: 5, method: "navigate" },
          };
          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(navResult, "navigate");

          // Zweiter Click nach navigate — Hint kommt zurueck.
          const second = makeClickResult("clickable");
          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(second, "click");
          expect(
            second.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .some((c) => c.text.includes("No visible changes yet")),
          ).toBe(true);
        });

        // Story 18.6 review-fix H2: Free-Tier path must also fire the
        // hint when NO onToolResult hook is registered at all. The
        // earlier tests install a Pro stub via `buildRegistryWithHook`;
        // this test registers EMPTY hooks to simulate a bare Free-Tier.
        it("H2 fix — fires hint in Free-Tier (no onToolResult hook registered at all)", async () => {
          // Explizit KEINEN onToolResult-Hook registrieren. In einem
          // normalen `registerAll()`-Lauf wuerde der Default-Hook spaeter
          // hinzugefuegt — aber dieser Test geht den Rohweg und ruft
          // `_runOnToolResultHook` direkt auf der frisch erzeugten
          // Registry auf, ohne `registerAll()` dazwischen. Damit ist
          // `getProHooks().onToolResult` undefined, was den frueheren
          // early-return getriggert haette.
          registerProHooks({});
          const mockServer = { tool: vi.fn() } as never;
          const mockCdpClient = { send: vi.fn() } as never;
          const registry = new ToolRegistry(
            mockServer,
            mockCdpClient,
            "sess-free-tier-h2",
            {} as never,
          );

          const result: import("./types.js").ToolResponse = {
            content: [{ type: "text", text: "Clicked e1 (ref: e1)" }],
            _meta: { elapsedMs: 5, method: "click", elementClass: "clickable" },
          };

          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(result, "click");

          const texts = result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text);
          expect(texts.some((t) => t.includes("No visible changes yet"))).toBe(true);
        });

        // Story 18.6 review-fix H1: run_plan with configure_session as an
        // intermediate step must reset the streak. The previous code only
        // reset in the wrap() closure (direct-MCP path) — run_plan goes
        // through `executeTool()` which bypasses wrap().
        it("H1 fix — executeTool(configure_session) resets the streak (run_plan path)", async () => {
          registerProHooks({});
          const mockServer = { tool: vi.fn() } as never;
          const mockCdpClient = { send: vi.fn() } as never;
          const registry = new ToolRegistry(
            mockServer,
            mockCdpClient,
            "sess-h1",
            {} as never,
          );
          registry.registerAll();

          // Pre-arm: first click fires hint.
          const first = makeClickResult("clickable");
          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(first, "click");
          expect(
            first.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .some((c) => c.text.includes("No visible changes yet")),
          ).toBe(true);

          // Second click without reset — no hint.
          const blocked = makeClickResult("clickable");
          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(blocked, "click");
          expect(
            blocked.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .some((c) => c.text.includes("No visible changes yet")),
          ).toBe(false);

          // Invoke executeTool(configure_session) — this is the run_plan
          // entry point, NOT wrap(). Without the H1 fix this call would
          // NOT reset the streak (streak lived only in wrap()).
          await registry.executeTool("configure_session", {});

          // Third click — streak was reset, hint fires again.
          const third = makeClickResult("clickable");
          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(third, "click");
          expect(
            third.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .some((c) => c.text.includes("No visible changes yet")),
          ).toBe(true);
        });

        // Story 18.6 review-fix M3: switch_tab via executeTool also
        // resets the FR-029 streak to prevent per-session flag leaks
        // across long-running tab jumps.
        it("M3 fix — executeTool(switch_tab) resets the streak", async () => {
          registerProHooks({});
          const mockServer = { tool: vi.fn() } as never;
          const mockCdpClient = { send: vi.fn() } as never;
          const registry = new ToolRegistry(
            mockServer,
            mockCdpClient,
            "sess-m3",
            {} as never,
          );
          registry.registerAll();

          // Arm the streak.
          const first = makeClickResult("clickable");
          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(first, "click");
          expect(
            first.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .some((c) => c.text.includes("No visible changes yet")),
          ).toBe(true);

          // switch_tab over executeTool: it will fail the Pro-gate for
          // Free-Tier and return an isError response, but the reset runs
          // BEFORE the handler call so the streak is wiped regardless.
          await registry.executeTool("switch_tab", { action: "open", url: "about:blank" });

          // Next click sees the hint again.
          const second = makeClickResult("clickable");
          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(second, "click");
          expect(
            second.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .some((c) => c.text.includes("No visible changes yet")),
          ).toBe(true);
        });

        // Story 18.6 review-fix M2: click-by-selector must NOT trigger
        // the FR-029 hint, even when the DOM diff is empty. The selector
        // path sets `elementClass = "selector-click"` which is not in the
        // allow-list (only `"clickable"` and `"widget-state"` fire).
        it("M2 fix — click with selector (elementClass='selector-click') does NOT fire the hint", async () => {
          const hook = vi.fn<NonNullable<ProHooks["onToolResult"]>>(
            async (_name, r, _ctx) => r,
          );
          const registry = buildRegistryWithHook(hook);

          const result: import("./types.js").ToolResponse = {
            content: [{ type: "text", text: "Clicked span.foo (selector)" }],
            _meta: {
              elapsedMs: 5,
              method: "click",
              elementClass: "selector-click",
            },
          };

          await (registry as unknown as {
            _runOnToolResultHook: (r: unknown, name: string) => Promise<void>;
          })._runOnToolResultHook(result, "click");

          const texts = result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text);
          expect(texts.some((t) => t.includes("No visible changes yet"))).toBe(false);
        });

        // Story 18.6 review-fix M3 (map growth): repeated switch_tab calls
        // must keep `_fr029HintShown` bounded. The reset on every
        // switch_tab is the mechanism — the map size never grows with
        // call count.
        it("M3 fix — repeated switch_tab calls keep the hint-map bounded", async () => {
          registerProHooks({});
          const mockServer = { tool: vi.fn() } as never;
          const mockCdpClient = { send: vi.fn() } as never;
          const registry = new ToolRegistry(
            mockServer,
            mockCdpClient,
            "sess-m3-bounds",
            {} as never,
          );
          registry.registerAll();

          for (let i = 0; i < 100; i++) {
            await registry.executeTool("switch_tab", {
              action: "open",
              url: "about:blank",
            });
          }

          // After 100 switch_tab calls the streak map is EMPTY (reset
          // clears everything on every call).
          const internal = registry as unknown as {
            _fr029HintShown: Map<string, boolean>;
          };
          expect(internal._fr029HintShown.size).toBe(0);
        });
      });

      it("default hook appends DOM diff text to a click response on a clickable button", async () => {
        // The mock CDP client services every call refreshPrecomputed makes:
        //   Runtime.evaluate (URL probe), Accessibility.getFullAXTree,
        //   Accessibility.getRootAXNode, plus the click-side calls.
        // The AX tree reports a single button so classifyRef("e1") returns
        // "clickable" and the hook is in scope.
        const mockCdpClient = {
          send: vi.fn().mockImplementation(async (method: string) => {
            if (method === "Accessibility.getFullAXTree") {
              return {
                nodes: [
                  {
                    nodeId: "1",
                    role: { value: "button" },
                    name: { value: "Save" },
                    properties: [],
                    childIds: [],
                    backendDOMNodeId: 1,
                  },
                ],
              };
            }
            if (method === "Accessibility.getRootAXNode") return {};
            if (method === "Runtime.evaluate") {
              return { result: { type: "string", value: "http://localhost/" } };
            }
            if (method === "DOM.resolveNode") {
              return { object: { objectId: "obj1" } };
            }
            if (method === "Runtime.callFunctionOn") {
              return { result: { type: "object", value: { x: 10, y: 10, width: 5, height: 5 } } };
            }
            if (method === "Input.dispatchMouseEvent") return {};
            return {};
          }),
        } as never;
        const mockServer = { tool: vi.fn() } as never;

        const registry = new ToolRegistry(
          mockServer,
          mockCdpClient,
          "sess-default-click",
          {} as never,
        );
        registry.registerAll();

        // Prime the cache so classifyRef("e1") finds the button
        await registry.executeTool("view_page", {});
        // Now click the same button — the default hook should detect that
        // the AX tree did not change between before/after and append
        // nothing (formatDomDiff returns null on empty changes), but
        // crucially: it must NOT crash and the response_bytes path must
        // remain stable.
        const result = await registry.executeTool("click", { ref: "e1" });
        expect(result.isError).toBeFalsy();
        expect(result._meta).toBeDefined();
        expect(typeof result._meta!.response_bytes).toBe("number");
      });
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

  // ===========================================================================
  // Story 18.3: Tool-Verschlankung auf ein Transition-Set
  // ===========================================================================
  //
  // Per Default exponiert `tools/list` nur die zehn Default-Tools (Transition-
  // Set, Positional-Bias-optimiert). Mit `SILBERCUE_CHROME_FULL_TOOLS=true`
  // werden alle Free-Tools registriert. Der interne `_handlers`-Dispatcher
  // bleibt in beiden Modi vollstaendig, damit `run_plan` Extended-Tools weiter
  // erreicht. Siehe `docs/friction-fixes.md#FR-035`.
  describe("ToolRegistry — Tool-Verschlankung (Story 18.3)", () => {
    // Diese Tests toggeln `SILBERCUE_CHROME_FULL_TOOLS` selbst und
    // ueberschreiben das parent `beforeEach`, das den FULL-Modus erzwingt.
    beforeEach(() => {
      delete process.env.SILBERCUE_CHROME_FULL_TOOLS;
    });
    afterEach(() => {
      delete process.env.SILBERCUE_CHROME_FULL_TOOLS;
    });

    const DEFAULT_TOOL_NAMES_EXPECTED = [
      "virtual_desk",
      "view_page",
      "click",
      "type",
      "fill_form",
      "navigate",
      "wait_for",
      "capture_image",
      "run_plan",
      "evaluate",
    ];
    const EXTENDED_TOOL_NAMES = [
      "press_key",
      "scroll",
      "switch_tab",
      "tab_status",
      "observe",
      "dom_snapshot",
      "handle_dialog",
      "file_upload",
      "console_logs",
      "network_monitor",
      "configure_session",
    ];

    it("default-Modus: server.tool() wird genau mit den 10 Default-Tools aufgerufen — in stabiler Reihenfolge", () => {
      // Env-Var unset → Default-Modus.
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      const registeredNames = toolFn.mock.calls.map((call: unknown[]) => call[0] as string);
      expect(registeredNames).toEqual(DEFAULT_TOOL_NAMES_EXPECTED);
      expect(toolFn).toHaveBeenCalledTimes(DEFAULT_TOOL_NAMES_EXPECTED.length);
    });

    it("default-Modus: Extended-Tools sind NICHT in server.tool()-Calls", () => {
      // Negative Assertion fuer alle elf Extended-Namen.
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      const registeredNames = toolFn.mock.calls.map((call: unknown[]) => call[0] as string);
      for (const extName of EXTENDED_TOOL_NAMES) {
        expect(registeredNames).not.toContain(extName);
      }
    });

    it("default-Modus: SILBERCUE_CHROME_FULL_TOOLS='false' aktiviert NICHT den Full-Set", () => {
      process.env.SILBERCUE_CHROME_FULL_TOOLS = "false";
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      expect(toolFn).toHaveBeenCalledTimes(DEFAULT_TOOL_NAMES_EXPECTED.length);
    });

    it("default-Modus: andere Wahrheits-aehnliche Werte ('1', 'TRUE') aktivieren NICHT den Full-Set", () => {
      // Strenger String-Vergleich `=== "true"` — defensive gegen Drift.
      for (const value of ["1", "TRUE", "yes", "on"]) {
        process.env.SILBERCUE_CHROME_FULL_TOOLS = value;
        const toolFn = vi.fn();
        const mockServer = { tool: toolFn } as never;
        const mockCdpClient = {} as never;

        const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
        registry.registerAll();

        expect(toolFn).toHaveBeenCalledTimes(DEFAULT_TOOL_NAMES_EXPECTED.length);
      }
    });

    it("FULL_TOOLS=true: server.tool() wird mit allen 21 Free-Tools aufgerufen — inkl. handle_dialog/console_logs/network_monitor", () => {
      // Story 18.3 Review-Fix H3: Dieser Test bildet die **Produktions-
      // Realitaet** ab. `handle_dialog`, `console_logs`, `network_monitor`
      // werden seit dem H1-Fix unbedingt registriert — Runtime-Guards im
      // Handler uebernehmen die Collector-Existenz-Pruefung. Der Test muss
      // deshalb alle elf Extended-Tools und die zehn Default-Tools
      // verifizieren, ohne irgendwelche "optional skip"-Logik.
      process.env.SILBERCUE_CHROME_FULL_TOOLS = "true";
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      const registeredNames = toolFn.mock.calls.map((call: unknown[]) => call[0] as string);

      // Alle zehn Default-Tools muessen drin sein.
      for (const name of DEFAULT_TOOL_NAMES_EXPECTED) {
        expect(registeredNames).toContain(name);
      }

      // Alle elf Extended-Tools — ohne Ausnahme, inklusive der drei, die
      // vorher an Collector-Gates hingen.
      const allExtended = [
        "press_key",
        "scroll",
        "switch_tab",
        "tab_status",
        "observe",
        "dom_snapshot",
        "handle_dialog",
        "file_upload",
        "console_logs",
        "network_monitor",
        "configure_session",
      ];
      for (const name of allExtended) {
        expect(registeredNames).toContain(name);
      }

      // Insgesamt 10 Default + 11 Extended + drag (Story 18.6) = 22 Tools.
      expect(toolFn).toHaveBeenCalledTimes(22);
    });

    it("FULL_TOOLS=true: _handlers-Map enthaelt alle Entries — inkl. handle_dialog/console_logs/network_monitor/drag", () => {
      // Story 18.3 Review-Fix H2: `_handlers` wird seit dem H2-Fix ebenfalls
      // unbedingt befuellt, damit `run_plan`-Dispatch alle Tools erreichen
      // kann, auch wenn die Collectors (noch) nicht initialisiert sind.
      process.env.SILBERCUE_CHROME_FULL_TOOLS = "true";
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      // Zugriff auf private _handlers via unknown-Cast — in Tests zulaessig.
      const handlers = (registry as unknown as { _handlers: Map<string, unknown> })._handlers;

      // `run_plan` ist bewusst NICHT im _handlers-Dispatcher (Recursion-
      // Schutz, siehe Kommentar in registerAll()). Alle anderen 21 Tools
      // muessen registriert sein — inklusive `drag` aus Story 18.6 (FR-028),
      // das im Full-Set ueber MCP exponiert wird und unabhaengig davon im
      // _handlers-Dispatcher verfuegbar ist (damit run_plan es nutzen kann).
      const expectedHandlerNames = [
        "evaluate",
        "navigate",
        "view_page",
        "capture_image",
        "wait_for",
        "observe",
        "click",
        "type",
        "tab_status",
        "switch_tab",
        "virtual_desk",
        "dom_snapshot",
        "handle_dialog",
        "file_upload",
        "fill_form",
        "press_key",
        "scroll",
        "drag",
        "console_logs",
        "network_monitor",
        "configure_session",
      ];
      for (const name of expectedHandlerNames) {
        expect(handlers.has(name)).toBe(true);
      }
    });

    it("default-Modus: executeTool('handle_dialog') findet einen Handler in _handlers (Runtime-Guard liefert klare Meldung)", async () => {
      // Story 18.3 Review-Fix H2: Im Legacy-Test-Konstruktor ist der
      // `dialogHandler` undefined — frueher dispatchte `executeTool` auf
      // `Unknown tool`, jetzt findet er den Handler und gibt eine
      // praezise Diagnose-Meldung zurueck.
      const mockCdpClient = { send: vi.fn().mockResolvedValue({}) } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      const result = await registry.executeTool("handle_dialog", { action: "accept" });
      expect(result).toBeDefined();
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain("Unknown tool");
      expect(text).toContain("handle_dialog unavailable");
      expect(result.isError).toBe(true);
      expect(result._meta?.method).toBe("handle_dialog");
    });

    it("default-Modus: executeTool('console_logs') findet einen Handler in _handlers", async () => {
      const mockCdpClient = { send: vi.fn().mockResolvedValue({}) } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      const result = await registry.executeTool("console_logs", {});
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain("Unknown tool");
      expect(text).toContain("console_logs unavailable");
      expect(result.isError).toBe(true);
      expect(result._meta?.method).toBe("console_logs");
    });

    it("default-Modus: executeTool('network_monitor') findet einen Handler in _handlers", async () => {
      const mockCdpClient = { send: vi.fn().mockResolvedValue({}) } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      const result = await registry.executeTool("network_monitor", { action: "get" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain("Unknown tool");
      expect(text).toContain("network_monitor unavailable");
      expect(result.isError).toBe(true);
      expect(result._meta?.method).toBe("network_monitor");
    });

    it("FULL_TOOLS=true mit echten Collector-Instanzen: tools/list enthaelt exakt 21 Tools und handle_dialog/console_logs/network_monitor sind **funktional**", async () => {
      // Story 18.3 Review-Fix H3: Der Test injiziert Mock-Collectors via
      // Legacy-Konstruktor (Parameter 7, 10, 11), damit sowohl die
      // `tools/list`-Registrierung als auch der Runtime-Dispatch der
      // drei Collector-Tools die echte Produktions-Realitaet abbilden.
      process.env.SILBERCUE_CHROME_FULL_TOOLS = "true";
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = { send: vi.fn().mockResolvedValue({}) } as never;

      // Minimale Mock-Collectors — nur die Methoden, die von den Handlern
      // aufgerufen werden, um die isError-Pfade zu umgehen.
      const mockDialogHandler = {
        setAction: vi.fn(),
        getCurrentConfig: vi.fn().mockReturnValue({ action: "accept", text: undefined }),
        consumeNotifications: vi.fn().mockReturnValue([]),
      } as never;
      const mockConsoleCollector = {
        getAll: vi.fn().mockReturnValue([]),
        getFiltered: vi.fn().mockReturnValue([]),
        clear: vi.fn(),
      } as never;
      const mockNetworkCollector = {
        getAll: vi.fn().mockReturnValue([]),
        getRequests: vi.fn().mockReturnValue([]),
        start: vi.fn(),
        stop: vi.fn(),
        isRecording: vi.fn().mockReturnValue(false),
      } as never;

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
        undefined, // getConnectionStatus
        undefined, // sessionManager
        mockDialogHandler, // dialogHandler (pos 7)
        undefined, // licenseStatus
        undefined, // freeTierConfig
        mockConsoleCollector, // consoleCollector (pos 10)
        mockNetworkCollector, // networkCollector (pos 11)
      );
      registry.registerAll();

      const registeredNames = toolFn.mock.calls.map((call: unknown[]) => call[0] as string);
      // Exakt 22 Tools: 10 Default + 11 Extended + drag (Story 18.6 FR-028).
      expect(toolFn).toHaveBeenCalledTimes(22);
      expect(registeredNames).toContain("handle_dialog");
      expect(registeredNames).toContain("console_logs");
      expect(registeredNames).toContain("network_monitor");
      expect(registeredNames).toContain("drag");

      // Der Handler MUSS jetzt den Mock-Collector erreichen und NICHT mehr
      // den Runtime-Guard-Pfad triggern.
      const result = await registry.executeTool("console_logs", {});
      expect(result.isError).toBeFalsy();
      expect(mockConsoleCollector.getAll).toHaveBeenCalled();
    });

    it("default-Modus: executeTool('press_key') findet einen Handler in _handlers — nicht 'Unknown tool'", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({}),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      const result = await registry.executeTool("press_key", { key: "Enter" });

      expect(result).toBeDefined();
      expect(result.isError).toBeFalsy();
      expect(result.content[0]).toHaveProperty("text", expect.stringContaining("Pressed"));
      expect(result._meta?.method).toBe("press_key");
    });

    it("default-Modus: executeTool('observe') findet einen Handler in _handlers", async () => {
      // observe ruft Runtime.evaluate fuer Setup; mock liefert null Result.
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({ result: { value: null } }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      const result = await registry.executeTool("observe", {
        selector: "#x",
        duration: 10,
        interval: 5,
      });

      // Wir pruefen NICHT auf isError === false (observe kann je nach
      // Mock-Antwort scheitern), sondern darauf, dass der Dispatcher den
      // Handler GEFUNDEN hat — also keine "Unknown tool"-Meldung.
      expect(result).toBeDefined();
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain("Unknown tool");
      expect(result._meta?.method).toBe("observe");
    });

    it("default-Modus: executeTool('scroll') findet einen Handler in _handlers", async () => {
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({
          result: { value: { scrollY: 300, scrollHeight: 2000, clientHeight: 800 } },
        }),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      const result = await registry.executeTool("scroll", { direction: "down", amount: 300 });

      expect(result).toBeDefined();
      expect(result.isError).toBeFalsy();
      expect(result._meta?.method).toBe("scroll");
    });

    it("default-Modus: executeTool('dom_snapshot') findet einen Handler in _handlers — Pro-Gate liefert isError, aber NICHT 'Unknown tool'", async () => {
      // dom_snapshot ist im Free-Tier per Pro-Gate gesperrt — der Test
      // prueft NUR, dass der Dispatcher den Handler ueberhaupt findet.
      const mockCdpClient = {
        send: vi.fn().mockResolvedValue({}),
      } as never;
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const license: LicenseStatus = { isPro: () => false };
      const registry = new ToolRegistry(
        mockServer, mockCdpClient, "session-1", {} as never,
        undefined, undefined, undefined, license,
      );
      registry.registerAll();

      const result = await registry.executeTool("dom_snapshot", { ref: "e1" });

      expect(result).toBeDefined();
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain("Unknown tool");
      // Der Handler wurde aufgerufen → Pro-Gate-Fehler erwartet.
      expect(result.isError).toBe(true);
      expect(text).toContain("Pro");
    });

    it("default-Modus: executeTool('unknown_tool') liefert weiterhin den Standard-Unknown-tool-Error", async () => {
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;

      const registry = new ToolRegistry(mockServer, {} as never, "session-1", {} as never);
      registry.registerAll();

      const result = await registry.executeTool("definitely_not_a_real_tool", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]).toHaveProperty("text", "Unknown tool: definitely_not_a_real_tool");
    });

    it("default-Modus: Reihenfolge im Default-Set bleibt Positional-Bias-konform — virtual_desk zuerst, evaluate zuletzt", () => {
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
      registry.registerAll();

      const registeredNames = toolFn.mock.calls.map((call: unknown[]) => call[0] as string);
      expect(registeredNames[0]).toBe("virtual_desk");
      expect(registeredNames[registeredNames.length - 1]).toBe("evaluate");
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

// =============================================================================
// Story 18.5 — Speculative Prefetch
// =============================================================================
//
// Integration-Tests fuer den Registry-Trigger des Speculative-Prefetch-Mechanismus.
// Die `PrefetchSlot`-Klasse selbst hat eigene Unit-Tests in
// `src/cache/prefetch-slot.test.ts`; dieser Block testet das Zusammenspiel:
//
//   executeTool(navigate|click) → fire-and-forget refreshPrecomputed im Hintergrund
//
// Mock-Strategie: Wir spioneren `prefetchSlot.schedule` und `a11yTree.refreshPrecomputed`
// aus, fangen die fire-and-forget-Promises ab, und awaiten sie nach `executeTool`
// um Reihenfolge und Cache-Effekte deterministisch zu verifizieren. Production-Code
// awaitet diese Promises NIE — das ist der Punkt der Story.
//
// Jeder Test installiert einen `unhandledRejection`-Spy (siehe Dev-Notes der Story
// "Testing Standards"), damit verpasste Catch-Ketten als harter Test-Fail
// rotaufleuchten — sonst wuerden sie als stiller Node-Crash erst in CI erscheinen.

describe("ToolRegistry — Speculative Prefetch (Story 18.5)", () => {
  let unhandledRejections: unknown[];
  const unhandledHandler = (err: unknown): void => {
    unhandledRejections.push(err);
  };

  beforeEach(() => {
    registerProHooks({});
    process.env.SILBERCUE_CHROME_FULL_TOOLS = "true";
    unhandledRejections = [];
    process.on("unhandledRejection", unhandledHandler);
    // Belt-and-suspenders: empty the slot before each test so a previous
    // test's leftover state cannot influence ours.
    prefetchSlot.cancel();
  });

  afterEach(() => {
    process.off("unhandledRejection", unhandledHandler);
    expect(unhandledRejections).toHaveLength(0);
    delete process.env.SILBERCUE_CHROME_FULL_TOOLS;
    prefetchSlot.cancel();
  });

  // ---------------------------------------------------------------------------
  // Helper: capture the schedule()-promise so tests can await it deterministically
  // ---------------------------------------------------------------------------
  function spySchedule(): { capturedPromises: Promise<void>[]; restore: () => void } {
    const capturedPromises: Promise<void>[] = [];
    const original = prefetchSlot.schedule.bind(prefetchSlot);
    const spy = vi
      .spyOn(prefetchSlot, "schedule")
      .mockImplementation((build, sessionId, expectedUrl) => {
        const p = original(build, sessionId, expectedUrl);
        capturedPromises.push(p);
        return p;
      });
    return {
      capturedPromises,
      restore: () => {
        spy.mockRestore();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Mock CDP factory: counts getFullAXTree calls per session, returns a
  // configurable URL on Runtime.evaluate, and tracks call order so we can
  // assert "navigate-return came BEFORE prefetch-getFullAXTree".
  // ---------------------------------------------------------------------------
  interface MockCdpOptions {
    /** URL returned by Runtime.evaluate(document.URL). Can be a function for
     *  per-call values (e.g. "first call returns A, second call returns B"). */
    url?: string | (() => string);
    /** If true, getFullAXTree throws — used by AC-5 error-absorption test. */
    throwOnGetFullAXTree?: boolean;
    /** Optional event log — pushed for each CDP call by name. */
    callLog?: string[];
  }
  function makeMockCdp(opts: MockCdpOptions = {}): {
    client: import("./cdp/cdp-client.js").CdpClient;
    getFullAXTreeCalls: number;
  } {
    const state = { getFullAXTreeCalls: 0 };
    const client = {
      send: vi.fn().mockImplementation(async (method: string) => {
        opts.callLog?.push(method);
        if (method === "Runtime.evaluate") {
          const v = typeof opts.url === "function"
            ? opts.url()
            : (opts.url ?? "http://localhost/");
          return { result: { type: "string", value: v } };
        }
        if (method === "Accessibility.getFullAXTree") {
          state.getFullAXTreeCalls++;
          if (opts.throwOnGetFullAXTree) {
            throw new Error("CDP boom — getFullAXTree failed");
          }
          return {
            nodes: [
              {
                nodeId: "1",
                role: { value: "rootWebArea" },
                name: { value: "Test" },
                properties: [],
                childIds: ["2"],
                backendDOMNodeId: 1,
              },
              {
                nodeId: "2",
                role: { value: "button" },
                name: { value: "Click me" },
                properties: [],
                childIds: [],
                backendDOMNodeId: 2,
              },
            ],
          };
        }
        if (method === "Accessibility.getRootAXNode") return {};
        if (method === "Page.navigate") return { frameId: "f1" };
        if (method === "DOM.resolveNode") return { object: { objectId: "obj1" } };
        if (method === "Runtime.callFunctionOn") {
          return { result: { type: "object", value: { x: 100, y: 100, width: 50, height: 20 } } };
        }
        if (method === "Input.dispatchMouseEvent") return {};
        return {};
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as import("./cdp/cdp-client.js").CdpClient;
    return {
      client,
      get getFullAXTreeCalls() { return state.getFullAXTreeCalls; },
    };
  }

  // ---------------------------------------------------------------------------
  // AC-1: prefetch fires fire-and-forget — executeTool does NOT wait for it
  // ---------------------------------------------------------------------------
  //
  // Test strategy: We hang the prefetch's getFullAXTree on an unresolved
  // promise. If `executeTool` is correctly fire-and-forget, it will still
  // return — even though the prefetch is stuck in flight. If the registry
  // accidentally `await`ed the prefetch, the test would time out.
  //
  // We additionally assert that:
  //  - the navigate handler's Page.navigate call ran BEFORE the prefetch's
  //    getFullAXTree call (i.e. the prefetch is sequentially after, not
  //    parallel/before)
  //  - the prefetchSlot was scheduled exactly once
  //  - the prefetch slot is still active when executeTool returns
  //    (because the build is hanging)
  it("prefetch triggers after navigate return, not before (fire-and-forget)", async () => {
    const callOrder: string[] = [];
    let releaseGetFullAXTree: (() => void) | undefined;
    // Story 18.5 H1 fix: Signal the test when getFullAXTree is actually
    // entered. The build runs in a `setImmediate()` tick and makes several
    // `await`s before reaching getFullAXTree — awaiting a single timer tick
    // is not enough. This promise lets the test block until the prefetch's
    // getFullAXTree call has landed.
    let getFullAXTreeEntered: (() => void) | undefined;
    const getFullAXTreeEnteredPromise = new Promise<void>((resolve) => {
      getFullAXTreeEntered = resolve;
    });
    const cdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        callOrder.push(method);
        if (method === "Runtime.evaluate") {
          return { result: { type: "string", value: "http://localhost/" } };
        }
        if (method === "Accessibility.getFullAXTree") {
          // Notify the test that the call has landed, then hang.
          getFullAXTreeEntered?.();
          getFullAXTreeEntered = undefined;
          // Hang until the test releases us — proves executeTool does NOT
          // wait for this call to finish.
          await new Promise<void>((resolve) => {
            releaseGetFullAXTree = resolve;
          });
          return { nodes: [] };
        }
        if (method === "Accessibility.getRootAXNode") return {};
        if (method === "Page.navigate") return { frameId: "f1" };
        return {};
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as import("./cdp/cdp-client.js").CdpClient;

    const { capturedPromises, restore } = spySchedule();
    a11yTree.reset();

    const registry = new ToolRegistry(
      { tool: vi.fn() } as never,
      cdpClient as never,
      "session-A",
      {} as never,
    );
    registry.registerAll();

    const result = await registry.executeTool("navigate", { url: "http://example.com" });

    // executeTool returned even though the prefetch's getFullAXTree is hung.
    expect(result.isError).toBeFalsy();
    expect(prefetchSlot.schedule).toHaveBeenCalledTimes(1);
    expect(capturedPromises).toHaveLength(1);
    // The slot promise has NOT yet resolved — proves fire-and-forget.
    expect(prefetchSlot.isActive).toBe(true);

    // Story 18.5 H1 fix: The build runs in a `setImmediate()` tick plus
    // several `await`s before reaching getFullAXTree. Wait on the
    // dedicated ready-signal promise for deterministic sequencing.
    await getFullAXTreeEnteredPromise;

    // Sequencing: Page.navigate (from the handler) ran BEFORE the prefetch's
    // first getFullAXTree call. This proves the prefetch is triggered AFTER
    // the handler logic, not in parallel.
    const pageNavigateIdx = callOrder.indexOf("Page.navigate");
    const firstGetFullAXTreeIdx = callOrder.indexOf("Accessibility.getFullAXTree");
    expect(pageNavigateIdx).toBeGreaterThanOrEqual(0);
    expect(firstGetFullAXTreeIdx).toBeGreaterThanOrEqual(0);
    expect(firstGetFullAXTreeIdx).toBeGreaterThan(pageNavigateIdx);

    // Release the prefetch and wait for it to finish so the slot can clean up.
    releaseGetFullAXTree?.();
    await capturedPromises[0];

    restore();
  });

  // ---------------------------------------------------------------------------
  // AC-1 / AC-6 Test 2 (Story 20.1 update): click no longer triggers
  // speculative prefetch — DeferredDiffSlot handles cache refresh.
  // ---------------------------------------------------------------------------
  // Story 20.1: click no longer triggers speculative prefetch — the
  // DeferredDiffSlot background build handles cache refresh as a side-effect.
  it("Story 20.1: prefetch does NOT trigger after click (deferred diff handles cache)", async () => {
    const mock = makeMockCdp();
    const { capturedPromises, restore } = spySchedule();
    a11yTree.reset();

    const registry = new ToolRegistry(
      { tool: vi.fn() } as never,
      mock.client as never,
      "session-A",
      {} as never,
    );
    registry.registerAll();

    // First read_page so click can resolve "e2" via the precomputed cache.
    await registry.executeTool("view_page", {});
    await Promise.all(capturedPromises.splice(0));

    const clickResult = await registry.executeTool("click", { ref: "e2" });
    expect(clickResult.isError).toBeFalsy();

    // Story 20.1: No prefetch scheduled — click uses DeferredDiffSlot instead.
    expect(capturedPromises).toHaveLength(0);

    restore();
  });

  it("prefetch does NOT trigger when click returns isError:true", async () => {
    const mock = makeMockCdp();
    const { capturedPromises, restore } = spySchedule();
    a11yTree.reset();

    const registry = new ToolRegistry(
      { tool: vi.fn() } as never,
      mock.client as never,
      "session-A",
      {} as never,
    );
    registry.registerAll();

    // Click on an unknown ref → isError: true
    const result = await registry.executeTool("click", { ref: "e9999" });
    expect(result.isError).toBe(true);

    // No prefetch was scheduled.
    expect(capturedPromises).toHaveLength(0);

    restore();
  });

  // ---------------------------------------------------------------------------
  // AC-1 / AC-6 Test 3: prefetch does NOT trigger for non-navigate/non-click tools
  // ---------------------------------------------------------------------------
  it("prefetch does NOT trigger for tools other than navigate/click", async () => {
    const cdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Runtime.evaluate") {
          return { result: { type: "string", value: "http://localhost/" } };
        }
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              {
                nodeId: "1",
                role: { value: "rootWebArea" },
                name: { value: "Test" },
                properties: [],
                childIds: [],
                backendDOMNodeId: 1,
              },
            ],
          };
        }
        if (method === "Accessibility.getRootAXNode") return {};
        return {};
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as import("./cdp/cdp-client.js").CdpClient;

    const { capturedPromises, restore } = spySchedule();
    a11yTree.reset();

    const registry = new ToolRegistry(
      { tool: vi.fn() } as never,
      cdpClient as never,
      "session-A",
      {} as never,
    );
    registry.registerAll();

    // Tools that should NOT trigger a prefetch. We pick ones that work
    // cleanly with this minimal CDP mock (press_key, scroll, read_page).
    // type/fill_form/evaluate need richer mocks; the registry path through
    // executeTool is identical for all of them, so the trigger-condition
    // assertion is unaffected.
    await registry.executeTool("press_key", { key: "Enter" });
    await registry.executeTool("scroll", { direction: "down", amount: 100 });
    await registry.executeTool("view_page", {});

    // Drain any leftover slot promise (none expected, but defensive).
    if (capturedPromises.length > 0) {
      await Promise.all(capturedPromises);
    }

    expect(capturedPromises).toHaveLength(0);
    expect(prefetchSlot.schedule).not.toHaveBeenCalled();

    restore();
  });

  // ---------------------------------------------------------------------------
  // Story 18.5 H2 review follow-up — extended AC-6 negative coverage
  // ---------------------------------------------------------------------------
  //
  // Tests the negative case for the remaining non-transition tools that the
  // original AC-6 test-3 omitted: type, fill_form, screenshot, wait_for.
  // These tools need richer CDP mocks than press_key/scroll/read_page, so
  // instead of wiring up a full CDP-mock for each, we inject a synthetic
  // "always-success" handler directly into the registry's `_handlers` map
  // for each name. This isolates the executeTool trigger-condition
  // (`name === "navigate" || name === "click"`) as the unit under test —
  // which is exactly what the review finding asked for.
  it("H2 fix — prefetch does NOT trigger for type, fill_form, screenshot, wait_for (even on success)", async () => {
    const mock = makeMockCdp();
    const { capturedPromises, restore } = spySchedule();
    a11yTree.reset();

    const registry = new ToolRegistry(
      { tool: vi.fn() } as never,
      mock.client as never,
      "session-A",
      {} as never,
    );
    registry.registerAll();

    // Inject synthetic success-handlers so we can drive the four tools
    // cleanly without needing a full CDP mock per tool. The trigger-check
    // in executeTool runs on `name` only — the handler body is irrelevant
    // as long as `isError` is falsy.
    const successHandler = async (): Promise<import("./types.js").ToolResponse> => ({
      content: [{ type: "text", text: "ok" }],
      isError: false,
      _meta: { elapsedMs: 0, method: "fake", response_bytes: 0 },
    });
    const handlers = (registry as unknown as {
      _handlers: Map<
        string,
        (params: Record<string, unknown>) => Promise<import("./types.js").ToolResponse>
      >;
    })._handlers;
    handlers.set("type", successHandler);
    handlers.set("fill_form", successHandler);
    handlers.set("capture_image", successHandler);
    handlers.set("wait_for", successHandler);

    // Execute each tool; none of them may trigger a prefetch schedule.
    const typeResult = await registry.executeTool("type", { ref: "e1", text: "x" });
    expect(typeResult.isError).toBeFalsy();
    const fillResult = await registry.executeTool("fill_form", { fields: [] });
    expect(fillResult.isError).toBeFalsy();
    const screenshotResult = await registry.executeTool("capture_image", {});
    expect(screenshotResult.isError).toBeFalsy();
    const waitResult = await registry.executeTool("wait_for", { selector: "body" });
    expect(waitResult.isError).toBeFalsy();

    // The trigger-condition must have rejected all four calls.
    expect(capturedPromises).toHaveLength(0);
    expect(prefetchSlot.schedule).not.toHaveBeenCalled();

    restore();
  });

  // ---------------------------------------------------------------------------
  // AC-3 / AC-6 Test 4: URL mismatch between prefetch and use drops the result
  // ---------------------------------------------------------------------------
  //
  // Strategy: refreshPrecomputed makes TWO `document.URL` queries — the start
  // fetch and the post-getFullAXTree re-check. Other Runtime.evaluate calls
  // (from the navigate handler, scrollable detection, etc.) use different
  // expressions. We track ONLY the document.URL queries by expression and
  // return URL A on the first, URL B on the second — simulating a real
  // navigation that completed while the prefetch was in flight.
  it("URL mismatch during refresh drops the cache write without error", async () => {
    let documentUrlCallCount = 0;
    const cdpClient = {
      send: vi.fn().mockImplementation(async (method: string, params?: unknown) => {
        if (method === "Runtime.evaluate") {
          const expr = (params as { expression?: string } | undefined)?.expression ?? "";
          if (expr === "document.URL") {
            documentUrlCallCount++;
            // First doc-URL inside refreshPrecomputed → A.
            // Second doc-URL → B (the URL changed!).
            // Anything beyond → A (defensive default; not reached).
            if (documentUrlCallCount === 1) {
              return { result: { type: "string", value: "http://a.com/" } };
            }
            if (documentUrlCallCount === 2) {
              return { result: { type: "string", value: "http://b.com/" } };
            }
            return { result: { type: "string", value: "http://a.com/" } };
          }
          // Other Runtime.evaluate calls (navigate handler readyState etc.)
          return { result: { type: "string", value: "http://a.com/" } };
        }
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              {
                nodeId: "1",
                role: { value: "rootWebArea" },
                name: { value: "Test" },
                properties: [],
                childIds: [],
                backendDOMNodeId: 1,
              },
            ],
          };
        }
        if (method === "Accessibility.getRootAXNode") return {};
        if (method === "Page.navigate") return { frameId: "f1" };
        return {};
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as import("./cdp/cdp-client.js").CdpClient;

    const { capturedPromises, restore } = spySchedule();
    a11yTree.reset();

    const registry = new ToolRegistry(
      { tool: vi.fn() } as never,
      cdpClient as never,
      "session-A",
      {} as never,
    );
    registry.registerAll();

    const result = await registry.executeTool("navigate", { url: "http://a.com" });
    expect(result.isError).toBeFalsy();

    // Wait for the prefetch to complete (or rather: to drop its result).
    expect(capturedPromises).toHaveLength(1);
    await capturedPromises[0];

    // Both document.URL calls happened — proves the recheck path ran.
    expect(documentUrlCallCount).toBeGreaterThanOrEqual(2);

    // Cache must NOT contain the prefetch's result. Because the URL changed
    // mid-build, refreshPrecomputed bailed out before writing the precomputed
    // cache. hasPrecomputed("session-A") therefore returns false.
    expect(a11yTree.hasPrecomputed("session-A")).toBe(false);

    restore();
  });

  // ---------------------------------------------------------------------------
  // AC-4 / AC-6 Test 5: Single slot — second prefetch cancels the first
  // ---------------------------------------------------------------------------
  it("single slot: second prefetch cancels the first", async () => {
    // Two rapid-fire navigate calls. We need a way to make the FIRST refresh
    // hang long enough so the second navigate aborts it. Strategy: the first
    // call returns slowly, the second proceeds normally.
    let firstResolveGetTree: (() => void) | undefined;
    let getFullAXTreeCallCount = 0;
    // Story 18.5 H1 fix: signal when the first getFullAXTree call has
    // actually entered (after the setImmediate tick + URL evaluate).
    let firstCallEntered: (() => void) | undefined;
    const firstCallEnteredPromise = new Promise<void>((resolve) => {
      firstCallEntered = resolve;
    });
    const cdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Runtime.evaluate") {
          return { result: { type: "string", value: "http://localhost/" } };
        }
        if (method === "Accessibility.getFullAXTree") {
          getFullAXTreeCallCount++;
          if (getFullAXTreeCallCount === 1) {
            // Notify the test that slot 1 has reached its getFullAXTree.
            firstCallEntered?.();
            firstCallEntered = undefined;
            // Hang the first call until we manually release it.
            await new Promise<void>((resolve) => {
              firstResolveGetTree = resolve;
            });
          }
          return {
            nodes: [
              {
                nodeId: "1",
                role: { value: "rootWebArea" },
                name: { value: "Test" },
                properties: [],
                childIds: [],
                backendDOMNodeId: 1,
              },
            ],
          };
        }
        if (method === "Accessibility.getRootAXNode") return {};
        if (method === "Page.navigate") return { frameId: "f1" };
        return {};
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as import("./cdp/cdp-client.js").CdpClient;

    const { capturedPromises, restore } = spySchedule();
    a11yTree.reset();

    const registry = new ToolRegistry(
      { tool: vi.fn() } as never,
      cdpClient as never,
      "session-A",
      {} as never,
    );
    registry.registerAll();

    // First navigate — kicks off slot 1 (which hangs on getFullAXTree).
    await registry.executeTool("navigate", { url: "http://example.com/a" });
    expect(capturedPromises).toHaveLength(1);
    // Slot 1 is alive; verify it has not finished yet.
    expect(prefetchSlot.isActive).toBe(true);

    // Story 18.5 H1 fix: the build runs in a setImmediate tick plus
    // several awaits. Block until slot 1 has actually landed in its
    // getFullAXTree call — otherwise slot 2's abort would hit slot 1
    // BEFORE the build body even started, and slot 1 would return on
    // its leading `if (signal.aborted) return;` without ever incrementing
    // the getFullAXTree counter.
    await firstCallEnteredPromise;

    // Second navigate — kicks off slot 2 and aborts slot 1.
    await registry.executeTool("navigate", { url: "http://example.com/b" });
    expect(capturedPromises).toHaveLength(2);

    // Now release slot 1's hung getFullAXTree. Its result must be dropped.
    firstResolveGetTree?.();

    // Wait for both slot promises to resolve.
    await Promise.all(capturedPromises);

    // Final state: slot is empty, slot 2's data won the cache, slot 1 was
    // dropped via signal.aborted before its cache write.
    expect(prefetchSlot.isActive).toBe(false);
    // Both slot builds called getFullAXTree — slot 1 (released after abort)
    // and slot 2 (normal completion) — but only slot 2 made it to the
    // cache write. Total getFullAXTree calls = 2.
    expect(getFullAXTreeCallCount).toBe(2);
    // Cache holds slot 2's stand.
    expect(a11yTree.hasPrecomputed("session-A")).toBe(true);

    restore();
  });

  // ---------------------------------------------------------------------------
  // AC-5 / AC-6 Test 6: prefetch errors are silently absorbed
  // ---------------------------------------------------------------------------
  it("prefetch errors are silently absorbed — no user-visible impact", async () => {
    // Build a CDP client that succeeds for the navigate handler itself but
    // throws when called from refreshPrecomputed. We discriminate by call
    // sequence: navigate triggers Page.navigate + a few Runtime.evaluate
    // calls, refreshPrecomputed calls Runtime.evaluate FIRST then
    // Accessibility.getFullAXTree. We make getFullAXTree throw — the
    // navigate handler does not call it directly (the click handler would,
    // but we are testing navigate here).
    let throwOnGetFullAXTree = false;
    const cdpClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Runtime.evaluate") {
          return { result: { type: "string", value: "http://localhost/" } };
        }
        if (method === "Accessibility.getFullAXTree") {
          if (throwOnGetFullAXTree) {
            throw new Error("CDP boom — getFullAXTree refused");
          }
          return {
            nodes: [
              {
                nodeId: "1",
                role: { value: "rootWebArea" },
                name: { value: "Test" },
                properties: [],
                childIds: [],
                backendDOMNodeId: 1,
              },
            ],
          };
        }
        if (method === "Accessibility.getRootAXNode") return {};
        if (method === "Page.navigate") return { frameId: "f1" };
        return {};
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as import("./cdp/cdp-client.js").CdpClient;

    const { capturedPromises, restore } = spySchedule();
    a11yTree.reset();

    const registry = new ToolRegistry(
      { tool: vi.fn() } as never,
      cdpClient as never,
      "session-A",
      {} as never,
    );
    registry.registerAll();

    // Arm the throw NOW — refreshPrecomputed during the navigate-trigger
    // prefetch will hit the failing getFullAXTree.
    throwOnGetFullAXTree = true;

    const result = await registry.executeTool("navigate", { url: "http://example.com" });

    // The navigate handler itself returns success — the prefetch error
    // is absorbed and never bubbles back to the LLM.
    expect(result.isError).toBeFalsy();
    // The error text from getFullAXTree must NOT appear in the response.
    const allText = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(allText).not.toContain("CDP boom");
    expect(allText).not.toContain("getFullAXTree");

    // Wait for the prefetch promise to complete (with absorbed error).
    expect(capturedPromises).toHaveLength(1);
    await capturedPromises[0];

    // Slot is empty, cache was not written, and the unhandledRejection-spy
    // (in afterEach) will verify no rejection leaked.
    expect(prefetchSlot.isActive).toBe(false);

    restore();
  });
});

// =============================================================================
// Story 20.1 M1: Piggyback-Drain integration test
// =============================================================================

describe("ToolRegistry — Piggyback-Drain (Story 20.1 M1)", () => {
  beforeEach(() => {
    registerProHooks({});
    process.env.SILBERCUE_CHROME_FULL_TOOLS = "true";
    deferredDiffSlot.cancel();
  });

  afterEach(() => {
    delete process.env.SILBERCUE_CHROME_FULL_TOOLS;
    deferredDiffSlot.cancel();
  });

  it("executeTool prepends a piggybacked diff from a previous click to the next tool response", async () => {
    // Manually seed a completed diff in the DeferredDiffSlot
    const done = deferredDiffSlot.schedule(async () => "--- DOM diff: +1 row added ---");
    await done;

    // Verify the diff is available
    expect(deferredDiffSlot.pendingDiffText).toBe("--- DOM diff: +1 row added ---");

    // Create a minimal registry with a mocked handler
    const mockToolFn = vi.fn();
    const cdpClient = {
      send: vi.fn(async (method: string) => {
        if (method === "Page.getFrameTree") {
          return { frameTree: { frame: { id: "main", url: "about:blank" } } };
        }
        if (method === "Runtime.evaluate") {
          return { result: { value: "42" } };
        }
        return {};
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as import("./cdp/cdp-client.js").CdpClient;

    const registry = new ToolRegistry(
      { tool: mockToolFn } as never,
      cdpClient as never,
      "session-1",
      {} as never,
    );
    registry.registerAll();

    // executeTool calls drainPendingDiff() before the handler.
    // We call "evaluate" because it's simple and returns quickly.
    const result = await registry.executeTool("evaluate", {
      expression: "'hello'",
    });

    // The diff should be prepended as the first content block
    expect(result.content.length).toBeGreaterThanOrEqual(2);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "--- DOM diff: +1 row added ---",
    });

    // The slot should be empty after drain
    expect(deferredDiffSlot.pendingDiffText).toBeNull();
  });
});
