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

  it("should register evaluate, navigate, read_page, screenshot, wait_for, click, type, tab_status, and switch_tab tools via server.tool()", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;
    const mockCdpClient = {} as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1", {} as never);
    registry.registerAll();

    expect(toolFn).toHaveBeenCalledTimes(9);
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
      "Click an element by A11y-Tree ref (e.g. 'e5') or CSS selector, waits for page to settle",
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
  });

  it("updateSession changes sessionId for subsequent tool calls", () => {
    const registry = new ToolRegistry({} as never, {} as never, "session-1", {} as never);
    expect(registry.sessionId).toBe("session-1");

    registry.updateSession("session-2");
    expect(registry.sessionId).toBe("session-2");
  });
});
