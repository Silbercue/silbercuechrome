import { describe, it, expect } from "vitest";
import { substituteVars, extractResultValue } from "./plan-variables.js";
import type { ToolResponse } from "../types.js";

describe("substituteVars", () => {
  it("replaces $var in string value with variable value", () => {
    const result = substituteVars(
      { url: "$myUrl" },
      { myUrl: "https://example.com" },
    );
    expect(result).toEqual({ url: "https://example.com" });
  });

  it("replaces $var inline in longer string", () => {
    const result = substituteVars(
      { greeting: "Hello $name!" },
      { name: "World" },
    );
    expect(result).toEqual({ greeting: "Hello World!" });
  });

  it("preserves type for whole-string $var replacement", () => {
    const result = substituteVars({ count: "$num" }, { num: 42 });
    expect(result).toEqual({ count: 42 });
    expect(typeof result.count).toBe("number");
  });

  it("preserves boolean type for whole-string $var", () => {
    const result = substituteVars({ flag: "$enabled" }, { enabled: true });
    expect(result).toEqual({ flag: true });
    expect(typeof result.flag).toBe("boolean");
  });

  it("handles nested objects recursively", () => {
    const result = substituteVars(
      { opts: { url: "$url" } },
      { url: "https://test.com" },
    );
    expect(result).toEqual({ opts: { url: "https://test.com" } });
  });

  it("handles arrays", () => {
    const result = substituteVars(
      { items: ["$a", "$b"] },
      { a: "x", b: "y" },
    );
    expect(result).toEqual({ items: ["x", "y"] });
  });

  it("leaves unresolved $var as-is", () => {
    const result = substituteVars({ url: "$unknown" }, {});
    expect(result).toEqual({ url: "$unknown" });
  });

  it("empty vars returns params unchanged", () => {
    const params = { url: "https://example.com", count: 5 };
    const result = substituteVars(params, {});
    expect(result).toEqual(params);
  });

  it("no $var references returns params unchanged", () => {
    const params = { url: "https://example.com", flag: true };
    const result = substituteVars(params, { unused: "value" });
    expect(result).toEqual(params);
  });

  it("multiple $var references in same string", () => {
    const result = substituteVars(
      { path: "$base/$page" },
      { base: "/api", page: "users" },
    );
    expect(result).toEqual({ path: "/api/users" });
  });

  it("preserves object type for whole-string $var replacement", () => {
    const obj = { nested: true };
    const result = substituteVars({ data: "$obj" }, { obj });
    expect(result).toEqual({ data: { nested: true } });
  });

  it("handles null and undefined in vars", () => {
    const result = substituteVars({ a: "$x", b: "$y" }, { x: null, y: undefined });
    expect(result.a).toBe(null);
    expect(result.b).toBe(undefined);
  });

  it("does not substitute non-string values", () => {
    const result = substituteVars({ count: 42, flag: true, empty: null }, { count: 99 });
    expect(result).toEqual({ count: 42, flag: true, empty: null });
  });
});

describe("extractResultValue", () => {
  it("extracts text from ToolResponse", () => {
    const response: ToolResponse = {
      content: [{ type: "text", text: "Hello World" }],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe("Hello World");
  });

  it("parses JSON result", () => {
    const response: ToolResponse = {
      content: [{ type: "text", text: '{"key":"value"}' }],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toEqual({ key: "value" });
  });

  it("returns raw text for non-JSON", () => {
    const response: ToolResponse = {
      content: [{ type: "text", text: "not json" }],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe("not json");
  });

  it("returns empty string for empty response", () => {
    const response: ToolResponse = {
      content: [],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe("");
  });

  it("concatenates multiple text blocks", () => {
    const response: ToolResponse = {
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe("line1\nline2");
  });

  it("ignores non-text content blocks", () => {
    const response: ToolResponse = {
      content: [
        { type: "text", text: "text" },
        { type: "image", data: "base64", mimeType: "image/png" },
      ],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe("text");
  });

  it("parses number JSON result", () => {
    const response: ToolResponse = {
      content: [{ type: "text", text: "42" }],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe(42);
  });
});
