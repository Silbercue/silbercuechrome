import { describe, it, expect } from "vitest";
import { RuleEngine } from "./rule-engine.js";
import type { StepContext, Rule } from "./types.js";
import { RefNotFoundError } from "../tools/element-utils.js";

describe("RuleEngine", () => {
  describe("default rules", () => {
    it("has 2 default rules after construction", () => {
      const engine = new RuleEngine();
      const rules = engine.getRules();
      expect(rules).toHaveLength(2);
    });

    it("default rules have correct priorities: dialog(100), element-not-found(50)", () => {
      const engine = new RuleEngine();
      const rules = engine.getRules();
      const priorities = rules.map((r) => ({ type: r.condition.type, priority: r.priority }));
      expect(priorities).toContainEqual({ type: "dialog-present", priority: 100 });
      expect(priorities).toContainEqual({ type: "element-not-found", priority: 50 });
    });
  });

  describe("evaluate() — priority ordering", () => {
    it("returns highest-priority matching rule when multiple match", () => {
      const engine = new RuleEngine();
      // Context with both dialog AND element-not-found error
      const context: StepContext = {
        tool: "click",
        params: { ref: "e5" },
        error: new RefNotFoundError("Element e5 not found"),
        dialogPresent: { type: "alert", message: "Are you sure?" },
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).not.toBeNull();
      // Dialog (prio 100) should win over element-not-found (prio 50)
      expect(match!.rule.condition.type).toBe("dialog-present");
      expect(match!.rule.action.type).toBe("dismiss-dialog");
      expect(match!.confidence).toBe(1.0);
    });
  });

  describe("evaluate() — returns null when no rule matches", () => {
    it("returns null when no conditions are met", () => {
      const engine = new RuleEngine();
      // Context with no error, no dialog, no ref → nothing matches
      const context: StepContext = {
        tool: "navigate",
        params: { url: "https://example.com" },
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).toBeNull();
    });

    it("returns null after removing all rules", () => {
      const engine = new RuleEngine();
      engine.removeRule("dialog-present");
      engine.removeRule("element-not-found");

      const context: StepContext = {
        tool: "click",
        params: { ref: "e5" },
        dialogPresent: { type: "alert", message: "test" },
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).toBeNull();
    });
  });

  describe("evaluate() — dialog-present condition", () => {
    it("matches when dialog is present", () => {
      const engine = new RuleEngine();
      const context: StepContext = {
        tool: "click",
        params: { ref: "e1" },
        dialogPresent: { type: "alert", message: "Hello" },
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).not.toBeNull();
      expect(match!.rule.condition.type).toBe("dialog-present");
      expect(match!.rule.action.type).toBe("dismiss-dialog");
    });

    it("does not match dialog condition when no dialog is present", () => {
      const engine = new RuleEngine();
      // Remove other rules to isolate dialog test
      engine.removeRule("element-not-found");
      engine.removeRule("element-visible");

      const context: StepContext = {
        tool: "click",
        params: { ref: "e1" },
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).toBeNull();
    });

    it("matches specific dialogType when specified", () => {
      const engine = new RuleEngine();
      engine.removeRule("dialog-present"); // remove default
      engine.addRule({
        condition: { type: "dialog-present", dialogType: "confirm" },
        action: { type: "accept-dialog" },
        priority: 100,
      });

      // Confirm dialog → matches
      const matchConfirm = engine.evaluate({
        tool: "click",
        params: {},
        dialogPresent: { type: "confirm", message: "OK?" },
        retryCount: 0,
      });
      expect(matchConfirm).not.toBeNull();
      expect(matchConfirm!.rule.action.type).toBe("accept-dialog");

      // Alert dialog → does NOT match (dialogType mismatch)
      const matchAlert = engine.evaluate({
        tool: "click",
        params: {},
        dialogPresent: { type: "alert", message: "Info" },
        retryCount: 0,
      });
      expect(matchAlert).toBeNull();
    });
  });

  describe("evaluate() — element-not-found condition", () => {
    it("matches when error is RefNotFoundError", () => {
      const engine = new RuleEngine();
      // Remove dialog rule so we can test element-not-found in isolation
      engine.removeRule("dialog-present");

      const context: StepContext = {
        tool: "click",
        params: { ref: "e99" },
        error: new RefNotFoundError("Element e99 not found"),
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).not.toBeNull();
      expect(match!.rule.condition.type).toBe("element-not-found");
      expect(match!.rule.action.type).toBe("scroll-to");
    });

    it("does not match when error is a regular Error (not RefNotFoundError)", () => {
      const engine = new RuleEngine();
      engine.removeRule("dialog-present");
      engine.removeRule("element-visible");

      const context: StepContext = {
        tool: "click",
        params: { ref: "e5" },
        error: new Error("CDP timeout"),
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).toBeNull();
    });

    it("does not match when there is no error", () => {
      const engine = new RuleEngine();
      engine.removeRule("dialog-present");
      engine.removeRule("element-visible");

      const context: StepContext = {
        tool: "click",
        params: { ref: "e5" },
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).toBeNull();
    });
  });

  describe("evaluate() — element-not-found via isErrorResponse (C2)", () => {
    it("matches when isErrorResponse is true and errorText contains 'not found'", () => {
      const engine = new RuleEngine();
      engine.removeRule("dialog-present");

      const context: StepContext = {
        tool: "click",
        params: { ref: "e5" },
        isErrorResponse: true,
        errorText: "Element e5 not found.",
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).not.toBeNull();
      expect(match!.rule.condition.type).toBe("element-not-found");
      expect(match!.rule.action.type).toBe("scroll-to");
    });

    it("does not match isErrorResponse when errorText does not contain 'not found'", () => {
      const engine = new RuleEngine();
      engine.removeRule("dialog-present");

      const context: StepContext = {
        tool: "click",
        params: { ref: "e5" },
        isErrorResponse: true,
        errorText: "CDP session disconnected",
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).toBeNull();
    });

    it("matches isErrorResponse with case-insensitive 'Not Found' text", () => {
      const engine = new RuleEngine();
      engine.removeRule("dialog-present");

      const context: StepContext = {
        tool: "click",
        params: { ref: "e99" },
        isErrorResponse: true,
        errorText: "Element e99 Not Found. Did you mean e5?",
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).not.toBeNull();
      expect(match!.rule.condition.type).toBe("element-not-found");
    });
  });

  describe("addRule() / removeRule()", () => {
    it("addRule adds a custom rule that is evaluated", () => {
      const engine = new RuleEngine();
      engine.addRule({
        condition: { type: "always" },
        action: { type: "fail-step", reason: "testing" },
        priority: 200, // highest
      });

      const context: StepContext = {
        tool: "click",
        params: {},
        retryCount: 0,
      };

      const match = engine.evaluate(context);
      expect(match).not.toBeNull();
      expect(match!.rule.condition.type).toBe("always");
      expect(match!.rule.action.type).toBe("fail-step");
    });

    it("removeRule removes all rules with matching condition type", () => {
      const engine = new RuleEngine();
      expect(engine.getRules().some((r) => r.condition.type === "dialog-present")).toBe(true);

      engine.removeRule("dialog-present");

      expect(engine.getRules().some((r) => r.condition.type === "dialog-present")).toBe(false);
    });

    it("removeRule with non-existent type does nothing", () => {
      const engine = new RuleEngine();
      const countBefore = engine.getRules().length;
      engine.removeRule("non-existent-type");
      expect(engine.getRules().length).toBe(countBefore);
    });
  });

  describe("getRules()", () => {
    it("returns a copy (mutations do not affect the engine)", () => {
      const engine = new RuleEngine();
      const rules = engine.getRules();
      const originalLength = rules.length;

      // getRules returns readonly, but we can cast to test immutability
      // The engine should not be affected
      engine.addRule({
        condition: { type: "always" },
        action: { type: "skip-step" },
        priority: 1,
      });

      // Original snapshot should remain unchanged
      expect(rules.length).toBe(originalLength);
      // But a new call should reflect the addition
      expect(engine.getRules().length).toBe(originalLength + 1);
    });
  });

  describe("evaluate() — always condition", () => {
    it("always condition matches any context", () => {
      const engine = new RuleEngine();
      // Remove all default rules
      engine.removeRule("dialog-present");
      engine.removeRule("element-not-found");

      engine.addRule({
        condition: { type: "always" },
        action: { type: "skip-step" },
        priority: 1,
      });

      const context: StepContext = {
        tool: "navigate",
        params: { url: "https://example.com" },
        retryCount: 5,
      };

      const match = engine.evaluate(context);
      expect(match).not.toBeNull();
      expect(match!.rule.condition.type).toBe("always");
    });
  });
});
