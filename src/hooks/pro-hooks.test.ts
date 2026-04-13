import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerProHooks, getProHooks, proFeatureError } from "./pro-hooks.js";
import type {
  ProHooks,
  ToolRegistryPublic,
  A11yTreePublic,
  A11yTreeDiffs,
} from "./pro-hooks.js";
import type { LicenseStatus } from "../license/license-status.js";
import type { ToolResponse } from "../types.js";
import type { PlanStep } from "../plan/plan-executor.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SnapshotMap, DOMChange } from "../cache/a11y-tree.js";

describe("ProHooks", () => {
  // Reset between tests — clean state
  beforeEach(() => {
    registerProHooks({});
  });

  it("default hooks are an empty object (all properties undefined)", () => {
    const hooks = getProHooks();
    expect(hooks).toEqual({});
    expect(hooks.featureGate).toBeUndefined();
    expect(hooks.enhanceTool).toBeUndefined();
    expect(hooks.onToolResult).toBeUndefined();
  });

  it("registerProHooks sets new hooks", () => {
    const gate = (toolName: string) => ({ allowed: toolName !== "dom_snapshot" });
    registerProHooks({ featureGate: gate });

    const hooks = getProHooks();
    expect(hooks.featureGate).toBe(gate);
    expect(hooks.enhanceTool).toBeUndefined();
    expect(hooks.onToolResult).toBeUndefined();
  });

  it("getProHooks returns the registered hooks", () => {
    const myHooks: ProHooks = {
      featureGate: () => ({ allowed: true }),
      enhanceTool: (_name, params) => params,
      onToolResult: async (_name, result, _ctx) => result,
    };
    registerProHooks(myHooks);

    const hooks = getProHooks();
    expect(hooks.featureGate).toBe(myHooks.featureGate);
    expect(hooks.enhanceTool).toBe(myHooks.enhanceTool);
    expect(hooks.onToolResult).toBe(myHooks.onToolResult);
  });

  it("multiple registerProHooks calls — last one wins", () => {
    const first = () => ({ allowed: false });
    const second = () => ({ allowed: true });

    registerProHooks({ featureGate: first });
    expect(getProHooks().featureGate).toBe(first);

    registerProHooks({ featureGate: second });
    expect(getProHooks().featureGate).toBe(second);
  });

  it("registerProHooks with empty object resets hooks", () => {
    registerProHooks({ featureGate: () => ({ allowed: true }) });
    expect(getProHooks().featureGate).toBeDefined();

    registerProHooks({});
    expect(getProHooks().featureGate).toBeUndefined();
  });

  it("featureGate hook returns gate result with optional message", () => {
    registerProHooks({
      featureGate: (toolName) => {
        if (toolName === "dom_snapshot") {
          return { allowed: false, message: "dom_snapshot requires Pro license" };
        }
        return { allowed: true };
      },
    });

    const hooks = getProHooks();
    const blocked = hooks.featureGate!("dom_snapshot");
    expect(blocked.allowed).toBe(false);
    expect(blocked.message).toBe("dom_snapshot requires Pro license");

    const allowed = hooks.featureGate!("evaluate");
    expect(allowed.allowed).toBe(true);
    expect(allowed.message).toBeUndefined();
  });

  it("enhanceTool hook can modify params", () => {
    registerProHooks({
      enhanceTool: (_name, params) => ({ ...params, enhanced: true }),
    });

    const result = getProHooks().enhanceTool!("evaluate", { expression: "1+1" });
    expect(result).toEqual({ expression: "1+1", enhanced: true });
  });

  it("enhanceTool hook can return null for no change", () => {
    registerProHooks({
      enhanceTool: () => null,
    });

    const result = getProHooks().enhanceTool!("evaluate", { expression: "1+1" });
    expect(result).toBeNull();
  });

  // --- Story 15.3: onToolResult Hook (Async + Context-Parameter) ---

  /**
   * Shared mock factory for the a11yTree/A11yTreeDiffs/context objects used
   * by the onToolResult tests. Keeps the setup DRY and lets each test
   * override only the fields it cares about.
   */
  const makeMockA11yTree = (): A11yTreePublic => ({
    classifyRef: vi.fn().mockReturnValue("static"),
    getSnapshotMap: vi.fn().mockReturnValue(new Map() as SnapshotMap),
    getCompactSnapshot: vi.fn().mockReturnValue(null),
    refreshPrecomputed: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    currentUrl: "https://example.com",
    // Story 15.3 (AC #5): diff methods live on the A11yTreePublic facade too
    diffSnapshots: vi.fn().mockReturnValue([] as DOMChange[]),
    formatDomDiff: vi.fn().mockReturnValue(null),
  });

  const makeMockA11yTreeDiffs = (): A11yTreeDiffs => ({
    diffSnapshots: vi.fn().mockReturnValue([] as DOMChange[]),
    formatDomDiff: vi.fn().mockReturnValue(null),
  });

  const makeHookContext = (
    overrides: Partial<Parameters<NonNullable<ProHooks["onToolResult"]>>[2]> = {},
  ): Parameters<NonNullable<ProHooks["onToolResult"]>>[2] => ({
    a11yTree: makeMockA11yTree(),
    a11yTreeDiffs: makeMockA11yTreeDiffs(),
    waitForAXChange: vi.fn().mockResolvedValue(true),
    cdpClient: { send: vi.fn() } as unknown as CdpClient,
    sessionId: "session-1",
    sessionManager: undefined,
    ...overrides,
  });

  it("onToolResult hook can modify response (new async signature with context)", async () => {
    registerProHooks({
      onToolResult: async (_name, result, _ctx) => ({
        ...result,
        content: [...result.content, { type: "text" as const, text: "enhanced" }],
      }),
    });

    const original: ToolResponse = {
      content: [{ type: "text" as const, text: "original" }],
      _meta: { elapsedMs: 10, method: "evaluate" },
    };
    const ctx = makeHookContext();
    const modified = await getProHooks().onToolResult!("evaluate", original, ctx);
    expect(modified.content).toHaveLength(2);
    expect((modified.content[1] as { text: string }).text).toBe("enhanced");
  });

  it("onToolResult is undefined by default", () => {
    const hooks = getProHooks();
    expect(hooks.onToolResult).toBeUndefined();
  });

  it("onToolResult can be registered and retrieved", async () => {
    const mockFn = vi.fn().mockImplementation(
      async (_name, result, _ctx) => result,
    );
    registerProHooks({ onToolResult: mockFn });

    const hooks = getProHooks();
    expect(hooks.onToolResult).toBe(mockFn);
  });

  it("onToolResult works alongside other hooks", () => {
    const gate = () => ({ allowed: true });
    const enhance = (_n: string, p: Record<string, unknown>) => p;
    const result: ProHooks["onToolResult"] = async (_name, r, _ctx) => r;
    const provider: ProHooks["provideLicenseStatus"] = async () => ({
      isPro: () => true,
    });

    registerProHooks({
      featureGate: gate,
      enhanceTool: enhance,
      onToolResult: result,
      provideLicenseStatus: provider,
    });

    const hooks = getProHooks();
    expect(hooks.featureGate).toBe(gate);
    expect(hooks.enhanceTool).toBe(enhance);
    expect(hooks.onToolResult).toBe(result);
    expect(hooks.provideLicenseStatus).toBe(provider);
  });

  it("onToolResult is cleared when hooks are reset", () => {
    registerProHooks({
      onToolResult: async (_name, result, _ctx) => result,
    });
    expect(getProHooks().onToolResult).toBeDefined();

    registerProHooks({});
    expect(getProHooks().onToolResult).toBeUndefined();
  });

  it("onToolResult receives context parameter with a11yTree", async () => {
    const mockA11yTree = makeMockA11yTree();
    (mockA11yTree.classifyRef as ReturnType<typeof vi.fn>).mockReturnValue(
      "clickable",
    );

    const captured: { classification?: string } = {};
    registerProHooks({
      onToolResult: async (_name, result, ctx) => {
        captured.classification = ctx.a11yTree.classifyRef("e1");
        return result;
      },
    });

    const result: ToolResponse = {
      content: [{ type: "text" as const, text: "ok" }],
      _meta: { elapsedMs: 1, method: "click" },
    };
    const ctx = makeHookContext({ a11yTree: mockA11yTree });
    await getProHooks().onToolResult!("click", result, ctx);

    expect(mockA11yTree.classifyRef).toHaveBeenCalledWith("e1");
    expect(captured.classification).toBe("clickable");
  });

  it("onToolResult can call waitForAXChange via context parameter", async () => {
    const waitMock = vi.fn().mockResolvedValue(true);
    registerProHooks({
      onToolResult: async (_name, result, ctx) => {
        await ctx.waitForAXChange?.(350);
        return result;
      },
    });

    const result: ToolResponse = {
      content: [{ type: "text" as const, text: "ok" }],
      _meta: { elapsedMs: 1, method: "click" },
    };
    const ctx = makeHookContext({ waitForAXChange: waitMock });
    await getProHooks().onToolResult!("click", result, ctx);

    expect(waitMock).toHaveBeenCalledWith(350);
  });

  it("onToolResult can return enhanced response asynchronously", async () => {
    registerProHooks({
      onToolResult: async (_name, result, _ctx) => {
        // Simulate an async CDP call before enriching
        await Promise.resolve();
        return {
          ...result,
          content: [
            ...result.content,
            { type: "text" as const, text: "[diff] +button#submit" },
          ],
        };
      },
    });

    const result: ToolResponse = {
      content: [{ type: "text" as const, text: "clicked" }],
      _meta: { elapsedMs: 5, method: "click" },
    };
    const ctx = makeHookContext();
    const enriched = await getProHooks().onToolResult!("click", result, ctx);

    expect(enriched.content).toHaveLength(2);
    expect((enriched.content[1] as { text: string }).text).toBe(
      "[diff] +button#submit",
    );
  });

  // --- Story 9.6: proFeatureError ---

  it("proFeatureError returns warm marketing message for dom_snapshot", () => {
    const result = proFeatureError("dom_snapshot");

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    // Must name the tool and flag it as Pro
    expect(text).toContain("dom_snapshot (Pro)");
    // Must briefly describe what the Pro tool does
    expect(text).toMatch(/DOM tree snapshot/i);
    // Must mention the Free alternative so the LLM can continue
    expect(text).toContain("view_page");
    // Must provide a clear upgrade path
    expect(text).toContain("Upgrade:");
    expect(text).toContain("silbercuechrome license activate");
    expect(result._meta).toEqual({ elapsedMs: 0, method: "dom_snapshot" });
  });

  it("proFeatureError returns warm marketing message for virtual_desk", () => {
    const result = proFeatureError("virtual_desk");
    const text = (result.content[0] as { text: string }).text;

    expect(result.isError).toBe(true);
    expect(text).toContain("virtual_desk (Pro)");
    // Describes the value proposition
    expect(text).toMatch(/window layout|multi-tab/i);
    // Points to the Free alternative
    expect(text).toContain("tab_status");
    // Upgrade path
    expect(text).toContain("Upgrade:");
  });

  it("proFeatureError returns warm marketing message for switch_tab", () => {
    const result = proFeatureError("switch_tab");
    const text = (result.content[0] as { text: string }).text;

    expect(result.isError).toBe(true);
    expect(text).toContain("switch_tab (Pro)");
    expect(text).toMatch(/multi-tab workflows/i);
    expect(text).toContain("navigate");
    expect(text).toContain("Upgrade:");
  });

  it("proFeatureError falls back to generic message for unknown tool names", () => {
    // Tools like `parallel` and `use_operator` from run_plan use the generic
    // fallback since they're not traditional tool names but feature flags.
    const result = proFeatureError("some_future_tool");

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("some_future_tool is a Pro feature");
    expect(result._meta!.method).toBe("some_future_tool");
  });

  // --- Story 15.5: provideLicenseStatus Hook ---

  it("provideLicenseStatus is undefined by default", () => {
    const hooks = getProHooks();
    expect(hooks.provideLicenseStatus).toBeUndefined();
  });

  it("provideLicenseStatus can be registered and retrieved", async () => {
    const mockStatus: LicenseStatus = { isPro: () => true };
    const provider = async () => mockStatus;

    registerProHooks({ provideLicenseStatus: provider });

    const hooks = getProHooks();
    expect(hooks.provideLicenseStatus).toBe(provider);

    const status = await hooks.provideLicenseStatus!();
    expect(status.isPro()).toBe(true);
  });

  it("provideLicenseStatus works alongside other hooks", () => {
    const gate = () => ({ allowed: true });
    const provider = async (): Promise<LicenseStatus> => ({ isPro: () => false });

    registerProHooks({ featureGate: gate, provideLicenseStatus: provider });

    const hooks = getProHooks();
    expect(hooks.featureGate).toBe(gate);
    expect(hooks.provideLicenseStatus).toBe(provider);
  });

  it("provideLicenseStatus is cleared when hooks are reset", async () => {
    const provider = async (): Promise<LicenseStatus> => ({ isPro: () => true });
    registerProHooks({ provideLicenseStatus: provider });
    expect(getProHooks().provideLicenseStatus).toBeDefined();

    registerProHooks({});
    expect(getProHooks().provideLicenseStatus).toBeUndefined();
  });

  // --- Story 15.4: executeParallel Hook ---

  it("executeParallel is undefined by default", () => {
    const hooks = getProHooks();
    expect(hooks.executeParallel).toBeUndefined();
  });

  it("executeParallel can be registered and retrieved", async () => {
    const mockResponse: ToolResponse = {
      content: [{ type: "text", text: "parallel done" }],
      _meta: { elapsedMs: 10, method: "run_plan", parallel: true },
    };
    const impl = vi.fn().mockResolvedValue(mockResponse);

    registerProHooks({ executeParallel: impl });

    const hooks = getProHooks();
    expect(hooks.executeParallel).toBe(impl);

    const groups: Array<{ tab: string; steps: PlanStep[] }> = [
      { tab: "tab-a", steps: [{ tool: "navigate", params: { url: "https://a.com" } }] },
    ];
    const factory = async (_tabId: string) => ({
      executeTool: async (_name: string, _params: Record<string, unknown>): Promise<ToolResponse> => ({
        content: [{ type: "text", text: "ok" }],
        _meta: { elapsedMs: 1, method: "navigate" },
      }),
    });

    const result = await hooks.executeParallel!(groups, factory, {
      errorStrategy: "abort",
      concurrencyLimit: 5,
    });

    expect(impl).toHaveBeenCalledWith(groups, factory, {
      errorStrategy: "abort",
      concurrencyLimit: 5,
    });
    expect(result).toBe(mockResponse);
  });

  it("executeParallel works alongside other hooks", () => {
    const gate = () => ({ allowed: true });
    const impl = async (): Promise<ToolResponse> => ({
      content: [],
      _meta: { elapsedMs: 0, method: "run_plan" },
    });

    registerProHooks({ featureGate: gate, executeParallel: impl });

    const hooks = getProHooks();
    expect(hooks.featureGate).toBe(gate);
    expect(hooks.executeParallel).toBe(impl);
  });

  it("executeParallel is cleared when hooks are reset", async () => {
    const impl = async (): Promise<ToolResponse> => ({
      content: [],
      _meta: { elapsedMs: 0, method: "run_plan" },
    });
    registerProHooks({ executeParallel: impl });
    expect(getProHooks().executeParallel).toBeDefined();

    registerProHooks({});
    expect(getProHooks().executeParallel).toBeUndefined();
  });

  // --- Story 15.2: registerProTools Hook ---

  it("registerProTools is undefined by default", () => {
    const hooks = getProHooks();
    expect(hooks.registerProTools).toBeUndefined();
  });

  it("registerProTools can be registered and retrieved", () => {
    const impl = vi.fn((_registry: ToolRegistryPublic) => {
      /* Pro-Repo would call registry.registerTool(...) here */
    });

    registerProHooks({ registerProTools: impl });

    const hooks = getProHooks();
    expect(hooks.registerProTools).toBe(impl);

    // Simulate Free-Repo calling the hook with a fake registry
    const fakeRegistry: ToolRegistryPublic = {
      registerTool: vi.fn(),
      cdpClient: { send: vi.fn() } as unknown as CdpClient,
      sessionId: "session-1",
      sessionManager: undefined,
    };
    hooks.registerProTools!(fakeRegistry);
    expect(impl).toHaveBeenCalledWith(fakeRegistry);
  });

  it("registerProTools works alongside other hooks", () => {
    const gate = () => ({ allowed: true });
    const registerImpl = (_registry: ToolRegistryPublic) => {
      /* no-op */
    };

    registerProHooks({ featureGate: gate, registerProTools: registerImpl });

    const hooks = getProHooks();
    expect(hooks.featureGate).toBe(gate);
    expect(hooks.registerProTools).toBe(registerImpl);
  });

  it("registerProTools is cleared when hooks are reset", () => {
    registerProHooks({ registerProTools: () => { /* no-op */ } });
    expect(getProHooks().registerProTools).toBeDefined();

    registerProHooks({});
    expect(getProHooks().registerProTools).toBeUndefined();
  });

  // --- Story 15.2: enhanceEvaluateResult Hook ---

  it("enhanceEvaluateResult is undefined by default", () => {
    const hooks = getProHooks();
    expect(hooks.enhanceEvaluateResult).toBeUndefined();
  });

  it("enhanceEvaluateResult can be registered and retrieved", async () => {
    const enhanced: ToolResponse = {
      content: [
        { type: "text", text: "result" },
        { type: "text", text: "Visual: 100x50 -> 200x50" },
        { type: "image", data: "fakeBase64", mimeType: "image/webp" },
      ],
      _meta: { elapsedMs: 20, method: "evaluate", visualFeedback: true },
    };
    const impl = vi.fn().mockResolvedValue(enhanced);

    registerProHooks({ enhanceEvaluateResult: impl });

    const hooks = getProHooks();
    expect(hooks.enhanceEvaluateResult).toBe(impl);

    const fakeCdp = { send: vi.fn() } as unknown as CdpClient;
    const base: ToolResponse = {
      content: [{ type: "text", text: "result" }],
      _meta: { elapsedMs: 10, method: "evaluate" },
    };
    const result = await hooks.enhanceEvaluateResult!(
      "el.style.width = '200px'",
      base,
      { cdpClient: fakeCdp, sessionId: "sess-1" },
    );

    expect(impl).toHaveBeenCalledWith(
      "el.style.width = '200px'",
      base,
      { cdpClient: fakeCdp, sessionId: "sess-1" },
    );
    expect(result).toBe(enhanced);
  });

  it("enhanceEvaluateResult is cleared when hooks are reset", async () => {
    const impl = async (
      _expression: string,
      result: ToolResponse,
    ): Promise<ToolResponse> => result;
    registerProHooks({ enhanceEvaluateResult: impl });
    expect(getProHooks().enhanceEvaluateResult).toBeDefined();

    registerProHooks({});
    expect(getProHooks().enhanceEvaluateResult).toBeUndefined();
  });
});
