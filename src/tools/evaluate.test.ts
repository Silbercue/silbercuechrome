import { describe, it, expect, vi } from "vitest";
import { evaluateHandler, evaluateSchema, wrapInIIFE } from "./evaluate.js";
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

  it("should auto-wrap top-level const/let/class in IIFE before sending to CDP", async () => {
    const sendFn = vi.fn(async () => ({
      result: { type: "string", value: "ok" },
    }));
    const cdp = mockCdpClient(sendFn);

    await evaluateHandler(
      { expression: 'const x = 1;\nreturn x;', await_promise: true },
      cdp,
    );

    const sentExpression = sendFn.mock.calls[0][1]?.expression as string;
    expect(sentExpression).toContain("(() => {");
    expect(sentExpression).toContain("const x = 1;");
    expect(sentExpression).toContain("})()");
  });

  it("should NOT auto-wrap expressions without top-level declarations", async () => {
    const sendFn = vi.fn(async () => ({
      result: { type: "number", value: 42 },
    }));
    const cdp = mockCdpClient(sendFn);

    await evaluateHandler(
      { expression: "document.title", await_promise: true },
      cdp,
    );

    const sentExpression = sendFn.mock.calls[0][1]?.expression as string;
    expect(sentExpression).toBe("document.title");
  });
});

describe("wrapInIIFE", () => {
  it("should wrap code with top-level const and return last expression", () => {
    const result = wrapInIIFE('const x = 1;\nx;');
    expect(result).toContain("(() => {");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("return x;");
  });

  it("should wrap code with top-level let and return last expression", () => {
    const result = wrapInIIFE('let y = 2;\ny;');
    expect(result).toContain("(() => {");
    expect(result).toContain("return y;");
  });

  it("should wrap code with top-level class and return last expression", () => {
    const result = wrapInIIFE('class Foo {}\nnew Foo();');
    expect(result).toContain("(() => {");
    expect(result).toContain("return new Foo();");
  });

  it("should NOT wrap code without declarations", () => {
    expect(wrapInIIFE("document.title")).toBe("document.title");
    expect(wrapInIIFE("1 + 1")).toBe("1 + 1");
    expect(wrapInIIFE("var x = 1")).toBe("var x = 1");
  });

  it("should NOT wrap code that is already an IIFE", () => {
    const iife = "(() => { const x = 1; return x; })()";
    expect(wrapInIIFE(iife)).toBe(iife);
  });

  it("should wrap const that appears after other statements", () => {
    const result = wrapInIIFE('document.title;\nconst x = 1;');
    expect(result).toContain("(() => {");
    // Last line is a const declaration — no return inserted (it's a statement, not an expression)
  });

  it("should wrap indented const/let declarations", () => {
    const result = wrapInIIFE('  const x = 1;\n  x;');
    expect(result).toContain("(() => {");
    expect(result).toContain("return x;");
  });

  it("should handle the real-world benchmark scenario (repeated calls)", () => {
    const call1 = 'const container = document.querySelector("#t2-2-list");\ncontainer?.textContent;';
    const call2 = 'const section = document.querySelector("[data-test=\\"2.2\\"]");\nsection?.textContent;';

    const wrapped1 = wrapInIIFE(call1);
    const wrapped2 = wrapInIIFE(call2);

    expect(wrapped1).toContain("(() => {");
    expect(wrapped2).toContain("(() => {");
    expect(wrapped1).toContain("return container?.textContent;");
    expect(wrapped2).toContain("return section?.textContent;");
  });

  it("should return JSON.stringify result", () => {
    const code = 'const x = 42;\nJSON.stringify({x})';
    const result = wrapInIIFE(code);
    expect(result).toContain("return JSON.stringify({x})");
  });

  it("should preserve indentation on return insertion", () => {
    const code = '  const x = 1;\n  x + 1';
    const result = wrapInIIFE(code);
    expect(result).toContain("  return x + 1");
  });

  it("should skip trailing comments and blank lines", () => {
    const code = 'const x = 1;\nx + 1\n// done\n';
    const result = wrapInIIFE(code);
    expect(result).toContain("return x + 1");
  });

  it("should not insert return before closing brace", () => {
    const code = 'const fn = () => { return 1; };\nfn()';
    const result = wrapInIIFE(code);
    expect(result).toContain("return fn()");
  });

  it("should extract trailing expression from single-line const", () => {
    const result = wrapInIIFE('const x = 42; x + 1');
    expect(result).toContain("const x = 42;");
    expect(result).toContain("return x + 1");
  });

  it("should handle single-line with JSON.stringify", () => {
    const result = wrapInIIFE('const obj = {a: 1}; JSON.stringify(obj)');
    expect(result).toContain("const obj = {a: 1};");
    expect(result).toContain("return JSON.stringify(obj)");
  });

  // FR-001: Multi-line expression tests
  it("should insert return at start of multi-line JSON.stringify, not at });", () => {
    const code = `const card = document.querySelector('.card');
JSON.stringify({
  id: card?.id,
  text: card?.textContent
});`;
    const result = wrapInIIFE(code);
    expect(result).toContain("return JSON.stringify({");
    expect(result).not.toContain("return });");
  });

  it("should handle multi-line function call ending with })", () => {
    const code = `const items = document.querySelectorAll('li');
items.forEach(item => {
  item.click();
})`;
    const result = wrapInIIFE(code);
    // forEach returns undefined, but the return should be on forEach line, not })
    expect(result).toContain("return items.forEach(");
    expect(result).not.toContain("return })");
  });

  it("should handle nested brackets in multi-line expression", () => {
    const code = `const el = document.body;
JSON.stringify({
  a: [1, 2, {nested: true}],
  b: ({x: 1})
});`;
    const result = wrapInIIFE(code);
    expect(result).toContain("return JSON.stringify({");
  });

  // FR-001: Explicit return statement tests
  it("should wrap code with explicit top-level return", () => {
    const result = wrapInIIFE("return document.title;");
    expect(result).toContain("(() => {");
    expect(result).toContain("return document.title;");
    expect(result).toContain("})()");
  });

  it("should wrap code with return after setup", () => {
    const code = `const x = 1;
const y = 2;
return x + y;`;
    const result = wrapInIIFE(code);
    expect(result).toContain("(() => {");
    expect(result).toContain("return x + y;");
    // Should NOT double-insert return
    expect(result).not.toContain("return return");
  });

  it("should NOT wrap return inside a callback (no declarations)", () => {
    // return is inside an arrow function body, not at line start → no wrap needed
    const code = "arr.map(x => { return x * 2; })";
    const result = wrapInIIFE(code);
    expect(result).toBe(code); // unchanged
  });

  // FR-011: await-Regression — Patterns die vorher nicht erkannt wurden
  it("should use async IIFE for destructuring await", () => {
    const code = `const { data } = await fetch('/api').then(r => r.json());\ndata;`;
    const result = wrapInIIFE(code);
    expect(result).toContain("(async () => {");
    expect(result).toContain("return data;");
  });

  it("should use async IIFE for array destructuring await", () => {
    const code = `const [a, b] = await Promise.all([fetch('/a'), fetch('/b')]);\n[a, b];`;
    const result = wrapInIIFE(code);
    expect(result).toContain("(async () => {");
  });

  it("should use async IIFE for parenthesized await", () => {
    const code = `const x = (await fetch('/api')).status;\nx;`;
    const result = wrapInIIFE(code);
    expect(result).toContain("(async () => {");
  });

  it("should use async IIFE for the T4.5 MutationObserver pattern", () => {
    const code = `const values = [];
const target = document.getElementById('t4-5-value');
const observer = new MutationObserver(() => {
  const v = target.textContent;
  if (v !== '---' && !values.includes(v)) values.push(v);
});
observer.observe(target, {childList: true, subtree: true});
await new Promise(r => setTimeout(r, 3500));
observer.disconnect();
values.join(',');`;
    const result = wrapInIIFE(code);
    expect(result).toContain("(async () => {");
    expect(result).toContain("return values.join(',');");
  });

  it("should NOT use async IIFE when await is absent", () => {
    const code = `const x = 1;\nx;`;
    const result = wrapInIIFE(code);
    expect(result).toContain("(() => {");
    expect(result).not.toContain("async");
  });

  it("should handle the exact T3.4 failure case from benchmark", () => {
    const code = `const card = [...document.querySelectorAll('.test-card')].find(c => c.querySelector('.test-id')?.textContent === 'T3.4');
const canvas = card?.querySelector('canvas');
JSON.stringify({
  canvasId: canvas?.id,
  width: canvas?.width,
  height: canvas?.height,
  circlePos: typeof R !== 'undefined' ? {x: R.canvasX, y: R.canvasY, r: R.canvasR} : 'no R object'
});`;
    const result = wrapInIIFE(code);
    expect(result).toContain("return JSON.stringify({");
    expect(result).not.toContain("return });");
    // Verify it's valid JS structure
    expect(result).toMatch(/^\(\(\) => \{[\s\S]*\}\)\(\)$/);
  });
});
