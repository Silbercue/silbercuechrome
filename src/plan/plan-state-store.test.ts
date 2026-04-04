import { describe, it, expect } from "vitest";
import { PlanStateStore } from "./plan-state-store.js";
import type { ErrorStrategy } from "./plan-executor.js";

function makeSuspendInput() {
  return {
    steps: [
      { tool: "navigate", params: { url: "https://example.com" } },
      { tool: "click", params: { ref: "e5" } },
      { tool: "type", params: { ref: "e10", text: "hello" } },
    ],
    suspendedAtIndex: 1,
    vars: { url: "https://example.com" },
    errorStrategy: "abort" as ErrorStrategy,
    completedResults: [
      {
        step: 1,
        tool: "navigate",
        result: {
          content: [{ type: "text" as const, text: "Navigated" }],
          _meta: { elapsedMs: 10, method: "navigate" },
        },
      },
    ],
    question: "Welches Element soll geklickt werden?",
  };
}

describe("PlanStateStore", () => {
  it("suspend stores state and returns planId", () => {
    const store = new PlanStateStore();
    const planId = store.suspend(makeSuspendInput());

    expect(typeof planId).toBe("string");
    expect(planId.length).toBeGreaterThan(0);
  });

  it("resume returns stored state and removes it", () => {
    const store = new PlanStateStore();
    const input = makeSuspendInput();
    const planId = store.suspend(input);

    const state = store.resume(planId);
    expect(state).not.toBeNull();
    expect(state!.planId).toBe(planId);
    expect(state!.steps).toEqual(input.steps);
    expect(state!.suspendedAtIndex).toBe(1);
    expect(state!.vars).toEqual(input.vars);
    expect(state!.errorStrategy).toBe("abort");
    expect(state!.completedResults).toEqual(input.completedResults);
    expect(state!.question).toBe("Welches Element soll geklickt werden?");
    expect(typeof state!.createdAt).toBe("number");

    // Second resume should return null (already consumed)
    const second = store.resume(planId);
    expect(second).toBeNull();
  });

  it("resume returns null for unknown planId", () => {
    const store = new PlanStateStore();
    const result = store.resume("nonexistent-id-12345");
    expect(result).toBeNull();
  });

  it("resume returns null for expired plan", () => {
    const store = new PlanStateStore(0); // TTL=0ms → expired immediately
    const planId = store.suspend(makeSuspendInput());

    const state = store.resume(planId);
    expect(state).toBeNull();
  });

  it("cleanup removes expired entries on suspend", async () => {
    const store = new PlanStateStore(50); // TTL=50ms
    const planId1 = store.suspend(makeSuspendInput());
    const planId2 = store.suspend(makeSuspendInput());

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // New suspend triggers cleanup of expired entries
    const planId3 = store.suspend(makeSuspendInput());

    // Old plans should be gone
    expect(store.resume(planId1)).toBeNull();
    expect(store.resume(planId2)).toBeNull();

    // New plan should still be valid
    const state3 = store.resume(planId3);
    expect(state3).not.toBeNull();
    expect(state3!.planId).toBe(planId3);
  });

  it("planId is unique across suspends", () => {
    const store = new PlanStateStore();
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      ids.add(store.suspend(makeSuspendInput()));
    }

    expect(ids.size).toBe(100);
  });
});
