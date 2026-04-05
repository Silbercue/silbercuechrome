import { describe, it, expect, vi } from "vitest";
import { evaluateHandler, evaluateSchema } from "./evaluate.js";
import type { CdpClient } from "../cdp/cdp-client.js";

function mockCdpClient(
  sendFn: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): CdpClient {
  return { send: sendFn } as unknown as CdpClient;
}

describe("evaluateSchema", () => {
  it("should accept expression string", () => {
    const result = evaluateSchema.parse({ expression: "1+1" });
    expect(result.expression).toBe("1+1");
    expect(result.await_promise).toBe(true);
  });

  it("should default await_promise to true", () => {
    const result = evaluateSchema.parse({ expression: "foo" });
    expect(result.await_promise).toBe(true);
  });

  it("should accept await_promise false", () => {
    const result = evaluateSchema.parse({ expression: "foo", await_promise: false });
    expect(result.await_promise).toBe(false);
  });
});

describe("evaluateHandler", () => {
  it("should return string result from document.title", async () => {
    const cdp = mockCdpClient(async () => ({
      result: { type: "string", value: "Google" },
    }));

    const response = await evaluateHandler({ expression: "document.title", await_promise: true }, cdp);

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toBe('"Google"');
    expect(response._meta?.method).toBe("evaluate");
    expect(response._meta?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("should return JSON object result", async () => {
    const cdp = mockCdpClient(async () => ({
      result: { type: "object", value: { a: 1, b: 2 } },
    }));

    const response = await evaluateHandler({ expression: "({a:1,b:2})", await_promise: true }, cdp);

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toBe('{"a":1,"b":2}');
  });

  it("should return number result", async () => {
    const cdp = mockCdpClient(async () => ({
      result: { type: "number", value: 42 },
    }));

    const response = await evaluateHandler({ expression: "21*2", await_promise: true }, cdp);

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toBe("42");
  });

  it("should return 'undefined' for void expressions", async () => {
    const cdp = mockCdpClient(async () => ({
      result: { type: "undefined" },
    }));

    const response = await evaluateHandler({ expression: "void 0", await_promise: true }, cdp);

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toBe("undefined");
  });

  it("should return isError true for JS exceptions", async () => {
    const cdp = mockCdpClient(async () => ({
      result: {
        type: "object",
        subtype: "error",
        className: "TypeError",
        description: "TypeError: Cannot read properties of undefined (reading 'foo')",
      },
      exceptionDetails: {
        exceptionId: 1,
        text: "Uncaught",
        exception: {
          type: "object",
          subtype: "error",
          className: "TypeError",
          description: "TypeError: Cannot read properties of undefined (reading 'foo')",
        },
      },
    }));

    const response = await evaluateHandler(
      { expression: "undeclaredVar.foo", await_promise: true },
      cdp,
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("TypeError");
    expect(response._meta?.method).toBe("evaluate");
  });

  it("should use exceptionDetails.text as fallback error message", async () => {
    const cdp = mockCdpClient(async () => ({
      result: { type: "object", subtype: "error" },
      exceptionDetails: {
        exceptionId: 1,
        text: "Uncaught SyntaxError: Unexpected token",
      },
    }));

    const response = await evaluateHandler(
      { expression: "if(", await_promise: true },
      cdp,
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe("Uncaught SyntaxError: Unexpected token");
  });

  it("should handle Promise result with await_promise true", async () => {
    const cdp = mockCdpClient(async () => ({
      result: { type: "number", value: 42 },
    }));

    const response = await evaluateHandler(
      { expression: "Promise.resolve(42)", await_promise: true },
      cdp,
    );

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toBe("42");
  });

  it("should pass awaitPromise param to CDP", async () => {
    const sendFn = vi.fn(async () => ({
      result: { type: "number", value: 1 },
    }));
    const cdp = mockCdpClient(sendFn);

    await evaluateHandler({ expression: "1", await_promise: false }, cdp);

    expect(sendFn).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: "1",
      returnByValue: true,
      awaitPromise: false,
    }, undefined);
  });

  it("should return isError for non-serializable results (e.g. DOM nodes)", async () => {
    const cdp = mockCdpClient(async () => ({
      result: { type: "object", subtype: "node", className: "HTMLBodyElement", description: "body" },
    }));

    const response = await evaluateHandler({ expression: "document.body", await_promise: true }, cdp);

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("not serializable");
    expect(response.content[0].text).toContain("body");
    expect(response._meta?.method).toBe("evaluate");
  });

  it("should return isError true when CDP call fails", async () => {
    const cdp = mockCdpClient(async () => {
      throw new Error("Transport closed unexpectedly");
    });

    const response = await evaluateHandler({ expression: "1+1", await_promise: true }, cdp);

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("CDP connection lost");
    expect(response._meta?.method).toBe("evaluate");
  });

  it("should include _meta with elapsedMs and method in all responses", async () => {
    const cdp = mockCdpClient(async () => ({
      result: { type: "boolean", value: true },
    }));

    const response = await evaluateHandler({ expression: "true", await_promise: true }, cdp);

    expect(response._meta).toBeDefined();
    expect(response._meta!.method).toBe("evaluate");
    expect(typeof response._meta!.elapsedMs).toBe("number");
    expect(response._meta!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("should return boolean result as JSON", async () => {
    const cdp = mockCdpClient(async () => ({
      result: { type: "boolean", value: false },
    }));

    const response = await evaluateHandler({ expression: "false", await_promise: true }, cdp);

    expect(response.content[0].text).toBe("false");
  });

  it("should return null result as JSON", async () => {
    const cdp = mockCdpClient(async () => ({
      result: { type: "object", value: null },
    }));

    const response = await evaluateHandler({ expression: "null", await_promise: true }, cdp);

    expect(response.content[0].text).toBe("null");
  });
});
