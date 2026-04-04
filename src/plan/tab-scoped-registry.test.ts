import { describe, it, expect, vi } from "vitest";
import { createTabScopedRegistry } from "./tab-scoped-registry.js";
import type { ToolRegistry } from "../registry.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";

function createMockCdpClient(): CdpClient {
  return {
    send: vi.fn().mockResolvedValue({ sessionId: "tab-session-123" }),
  } as unknown as CdpClient;
}

function createMockRegistry(): ToolRegistry {
  return {
    executeTool: vi.fn(async (_name: string, _params: Record<string, unknown>, _sessionIdOverride?: string): Promise<ToolResponse> => ({
      content: [{ type: "text", text: "executed" }],
      _meta: { elapsedMs: 5, method: _name },
    })),
  } as unknown as ToolRegistry;
}

describe("createTabScopedRegistry (Story 7.6)", () => {
  it("attaches to target tab and enables CDP domains", async () => {
    const cdpClient = createMockCdpClient();
    const registry = createMockRegistry();

    await createTabScopedRegistry(registry, cdpClient, "target-abc");

    const sendMock = cdpClient.send as ReturnType<typeof vi.fn>;
    // First call: attachToTarget
    expect(sendMock).toHaveBeenCalledWith(
      "Target.attachToTarget",
      { targetId: "target-abc", flatten: true },
    );
    // Second call: Runtime.enable on the tab session
    expect(sendMock).toHaveBeenCalledWith("Runtime.enable", {}, "tab-session-123");
    // Third call: Accessibility.enable on the tab session
    expect(sendMock).toHaveBeenCalledWith("Accessibility.enable", {}, "tab-session-123");
  });

  it("routes executeTool through the tab session", async () => {
    const cdpClient = createMockCdpClient();
    const registry = createMockRegistry();

    const tabRegistry = await createTabScopedRegistry(registry, cdpClient, "target-xyz");
    await tabRegistry.executeTool("navigate", { url: "https://example.com" });

    expect(registry.executeTool).toHaveBeenCalledWith(
      "navigate",
      { url: "https://example.com" },
      "tab-session-123",
    );
  });

  it("does not mutate the base registry", async () => {
    const cdpClient = createMockCdpClient();
    const registry = createMockRegistry();

    const tabRegistry = await createTabScopedRegistry(registry, cdpClient, "target-abc");

    // The returned wrapper is a different object
    expect(tabRegistry).not.toBe(registry);

    // executeTool on tabRegistry passes sessionIdOverride
    await tabRegistry.executeTool("click", { ref: "e1" });
    expect(registry.executeTool).toHaveBeenCalledWith("click", { ref: "e1" }, "tab-session-123");
  });

  it("multiple tab registries get independent sessions", async () => {
    let callCount = 0;
    const cdpClient = {
      send: vi.fn(async (method: string) => {
        if (method === "Target.attachToTarget") {
          callCount++;
          return { sessionId: `session-${callCount}` };
        }
        return {};
      }),
    } as unknown as CdpClient;

    const registry = createMockRegistry();

    const tab1 = await createTabScopedRegistry(registry, cdpClient, "target-1");
    const tab2 = await createTabScopedRegistry(registry, cdpClient, "target-2");

    await tab1.executeTool("navigate", { url: "https://a.com" });
    await tab2.executeTool("navigate", { url: "https://b.com" });

    const calls = (registry.executeTool as ReturnType<typeof vi.fn>).mock.calls;
    // tab1 uses session-1, tab2 uses session-2
    expect(calls[0][2]).toBe("session-1");
    expect(calls[1][2]).toBe("session-2");
  });
});
