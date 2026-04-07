/**
 * Story 15.6: Regressions-Tests — Free-Tier-Benchmark
 *
 * Dieser Test stellt sicher, dass nach der Pro-Feature-Extraktion
 * (Stories 15.1–15.5) das Free-Repo weiterhin sauber funktioniert und
 * entfernte Features einen deterministischen `proFeatureError()` liefern
 * statt Crashes/Undefined-Exceptions.
 *
 * Fokus (Acceptance Criteria Story 15.6):
 * - AC #3: inspect_element ist NICHT in tools/list registriert
 * - AC #4: run_plan mit `parallel` → proFeatureError
 * - AC #5: run_plan mit `use_operator: true` → proFeatureError
 * - AC #6: switch_tab / virtual_desk / dom_snapshot ohne featureGate → proFeatureError
 * - AC #7: evaluate mit Style-Change-Expression liefert KEIN Visual-Feedback-Bild
 *
 * Diese Tests laufen OHNE Pro-Hooks (`registerProHooks({})` in beforeEach),
 * simulieren also einen frischen Free-Repo-Zustand.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ToolRegistry } from "./registry.js";
import { registerProHooks } from "./hooks/pro-hooks.js";
import { runPlanHandler } from "./tools/run-plan.js";
import type { RunPlanParams } from "./tools/run-plan.js";
import type { ToolResponse } from "./types.js";
import { evaluateHandler } from "./tools/evaluate.js";
import type { CdpClient } from "./cdp/cdp-client.js";

function textOf(result: ToolResponse): string {
  const block = result.content?.[0];
  if (!block || block.type !== "text") return "";
  return block.text ?? "";
}

function hasImage(result: ToolResponse): boolean {
  return (result.content ?? []).some((c) => c.type === "image");
}

describe("Free-Tier Pro-Feature-Fallback Regressions (Story 15.6)", () => {
  beforeEach(() => {
    // Simulate a clean Free-Repo — no Pro-Hooks registered.
    registerProHooks({});
  });

  afterEach(() => {
    // M1-Fix (Code-Review 15.6): Globalen Hook-State explizit zuruecksetzen,
    // damit kein Pro-Hook-Leakage in andere Test-Dateien passiert (z.B. wenn
    // ein Test im Suite-Verlauf doch einen Hook setzt).
    registerProHooks({});
  });

  // -------------------------------------------------------------
  // AC #3 — inspect_element MUST NOT be in tools/list
  // -------------------------------------------------------------
  describe("inspect_element (AC #3)", () => {
    it("is NOT registered in tools/list when no registerProTools hook is set", () => {
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();

      const inspectCall = toolFn.mock.calls.find(
        (call: unknown[]) => call[0] === "inspect_element",
      );
      expect(inspectCall).toBeUndefined();
    });

    it("Free-Tier tool registration excludes Pro-Tools but keeps free tools", () => {
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = {} as never;

      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();

      // M1-Fix (Code-Review 15.6): Statt fragiler Exact-Count-Assertion eine
      // semantische Pruefung — Pro-Tools (`inspect_element`) duerfen nicht
      // registriert sein, freie Kerntools (`evaluate`) muessen vorhanden sein.
      const registeredNames = toolFn.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      expect(registeredNames).not.toContain("inspect_element");
      expect(registeredNames).toContain("evaluate");
      // Lower-bound sanity check — die Free-Registry hat deutlich mehr als
      // ein Handvoll Tools, und ein versehentlich leerer registerAll() darf
      // nicht durchrutschen.
      expect(registeredNames.length).toBeGreaterThan(10);
    });
  });

  // -------------------------------------------------------------
  // AC #4 — run_plan parallel → proFeatureError
  // -------------------------------------------------------------
  describe("run_plan parallel (AC #4)", () => {
    it("returns Pro-Feature error for parallel parameter", async () => {
      const registry = {
        executeTool: vi.fn(),
      } as unknown as ToolRegistry;

      const params = {
        parallel: [
          {
            tab: "t1",
            steps: [{ tool: "evaluate", params: { expression: "1+1" } }],
          },
        ],
      } as unknown as RunPlanParams;

      const result = (await runPlanHandler(params, registry)) as ToolResponse;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("parallel ist ein Pro-Feature");
      // The helper's canonical message must be present so clients can parse it.
      expect(textOf(result)).toContain("silbercuechrome license activate");
    });

    it("does not crash when parallel is provided without deps (no undefined deref)", async () => {
      const registry = {
        executeTool: vi.fn(),
      } as unknown as ToolRegistry;

      const params = {
        parallel: [
          {
            tab: "t1",
            steps: [{ tool: "evaluate", params: { expression: "1+1" } }],
          },
        ],
      } as unknown as RunPlanParams;

      await expect(runPlanHandler(params, registry)).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------
  // AC #5 — run_plan use_operator: true → proFeatureError
  // -------------------------------------------------------------
  describe("run_plan use_operator (AC #5)", () => {
    it("returns Pro-Feature error for use_operator: true", async () => {
      const registry = {
        executeTool: vi.fn(),
      } as unknown as ToolRegistry;

      const params = {
        use_operator: true,
        steps: [],
      } as unknown as RunPlanParams;

      const result = (await runPlanHandler(params, registry)) as ToolResponse;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("use_operator ist ein Pro-Feature");
      expect(textOf(result)).toContain("silbercuechrome license activate");
    });

    it("returns Pro-Feature error BEFORE mode validation (no 'mutually exclusive' message)", async () => {
      const registry = {
        executeTool: vi.fn(),
      } as unknown as ToolRegistry;

      // No steps/parallel/resume — with use_operator the Pro-Feature gate
      // must fire before the mutual-exclusion validator, otherwise the LLM
      // gets a confusing "one of ..." error instead of a clear Pro hint.
      const params = { use_operator: true } as unknown as RunPlanParams;

      const result = (await runPlanHandler(params, registry)) as ToolResponse;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("use_operator ist ein Pro-Feature");
      expect(textOf(result)).not.toContain(
        "Eines von 'steps', 'parallel' oder 'resume' muss angegeben werden",
      );
    });
  });

  // -------------------------------------------------------------
  // AC #6 — switch_tab / virtual_desk / dom_snapshot ohne featureGate
  //          → proFeatureError (default gate from registerAll())
  // -------------------------------------------------------------
  describe("switch_tab / virtual_desk / dom_snapshot default gate (AC #6)", () => {
    function buildRegistryForGating() {
      const toolFn = vi.fn();
      const mockServer = { tool: toolFn } as never;
      const mockCdpClient = { send: vi.fn() } as unknown as CdpClient;
      const registry = new ToolRegistry(
        mockServer,
        mockCdpClient,
        "session-1",
        {} as never,
      );
      registry.registerAll();
      return registry;
    }

    it("dom_snapshot via executeTool returns Pro-Feature error", async () => {
      const registry = buildRegistryForGating();
      const result = await registry.executeTool("dom_snapshot", { ref: "e1" });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("dom_snapshot ist ein Pro-Feature");
      expect(textOf(result)).toContain("silbercuechrome license activate");
    });

    it("switch_tab via executeTool returns Pro-Feature error", async () => {
      const registry = buildRegistryForGating();
      const result = await registry.executeTool("switch_tab", {
        action: "open",
        url: "about:blank",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("switch_tab ist ein Pro-Feature");
      expect(textOf(result)).toContain("silbercuechrome license activate");
    });

    it("virtual_desk via executeTool returns Pro-Feature error", async () => {
      const registry = buildRegistryForGating();
      const result = await registry.executeTool("virtual_desk", {});

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("virtual_desk ist ein Pro-Feature");
      expect(textOf(result)).toContain("silbercuechrome license activate");
    });

    it("none of the gated calls crash (no thrown exception, no undefined deref)", async () => {
      const registry = buildRegistryForGating();
      await expect(
        registry.executeTool("dom_snapshot", { ref: "e1" }),
      ).resolves.toBeDefined();
      await expect(
        registry.executeTool("switch_tab", { action: "open", url: "about:blank" }),
      ).resolves.toBeDefined();
      await expect(
        registry.executeTool("virtual_desk", {}),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------
  // AC #7 — evaluate with style-change expression returns NO image
  //          (Visual Feedback is Pro, enhanceEvaluateResult hook absent)
  // -------------------------------------------------------------
  describe("evaluate style-change has no Visual Feedback (AC #7)", () => {
    function mockCdp(
      result: { type: string; value?: unknown } = {
        type: "string",
        value: "red",
      },
    ): CdpClient {
      return {
        send: vi.fn(async () => ({ result })),
      } as unknown as CdpClient;
    }

    it("does not inject a screenshot for body style-change", async () => {
      const cdp = mockCdp();
      const response = await evaluateHandler(
        {
          expression: "document.body.style.color = 'red'",
          await_promise: true,
        },
        cdp,
      );

      expect(response.isError).toBeFalsy();
      expect(hasImage(response)).toBe(false);
      // Only the plain text result — no extra content blocks from the hook.
      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe("text");
    });

    it("does not inject a screenshot for querySelector style-change", async () => {
      const cdp = mockCdp();
      const response = await evaluateHandler(
        {
          expression:
            "document.querySelector('#t1-1-btn').style.border = '3px solid red'",
          await_promise: true,
        },
        cdp,
      );

      expect(response.isError).toBeFalsy();
      expect(hasImage(response)).toBe(false);
    });

    it("does not inject a screenshot for a read-only expression either", async () => {
      const cdp = mockCdp({ type: "string", value: "hello" });
      const response = await evaluateHandler(
        { expression: "document.title", await_promise: true },
        cdp,
      );

      expect(response.isError).toBeFalsy();
      expect(hasImage(response)).toBe(false);
    });

    it("does not crash when the expression would normally trigger Visual Feedback", async () => {
      const cdp = mockCdp();
      await expect(
        evaluateHandler(
          {
            expression:
              "document.querySelector('#t1-1-btn').style.backgroundColor = 'yellow'",
            await_promise: true,
          },
          cdp,
        ),
      ).resolves.toBeDefined();
    });
  });
});
