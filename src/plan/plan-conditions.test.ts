import { describe, it, expect, vi } from "vitest";
import { evaluateCondition } from "./plan-conditions.js";

describe("evaluateCondition", () => {
  it("string equality: $var === 'value'", () => {
    expect(evaluateCondition("$pageTitle === 'Login'", { pageTitle: "Login" })).toBe(true);
    expect(evaluateCondition("$pageTitle === 'Login'", { pageTitle: "Home" })).toBe(false);
  });

  it("string inequality: $var !== 'value'", () => {
    expect(evaluateCondition("$pageTitle !== 'Login'", { pageTitle: "Home" })).toBe(true);
    expect(evaluateCondition("$pageTitle !== 'Login'", { pageTitle: "Login" })).toBe(false);
  });

  it("numeric comparison: $count > 0", () => {
    expect(evaluateCondition("$count > 0", { count: 5 })).toBe(true);
    expect(evaluateCondition("$count > 0", { count: 0 })).toBe(false);
    expect(evaluateCondition("$count > 0", { count: -1 })).toBe(false);
  });

  it("numeric comparison: $count <= 10", () => {
    expect(evaluateCondition("$count <= 10", { count: 10 })).toBe(true);
    expect(evaluateCondition("$count <= 10", { count: 5 })).toBe(true);
    expect(evaluateCondition("$count <= 10", { count: 11 })).toBe(false);
  });

  it("boolean variable: truthy check on $isLoggedIn", () => {
    expect(evaluateCondition("$isLoggedIn", { isLoggedIn: true })).toBe(true);
    expect(evaluateCondition("$isLoggedIn", { isLoggedIn: false })).toBe(false);
  });

  it("negation: !$isLoggedIn", () => {
    expect(evaluateCondition("!$isLoggedIn", { isLoggedIn: false })).toBe(true);
    expect(evaluateCondition("!$isLoggedIn", { isLoggedIn: true })).toBe(false);
  });

  it("combined: $isLoggedIn && $count > 0", () => {
    expect(evaluateCondition("$isLoggedIn && $count > 0", { isLoggedIn: true, count: 5 })).toBe(true);
    expect(evaluateCondition("$isLoggedIn && $count > 0", { isLoggedIn: false, count: 5 })).toBe(false);
    expect(evaluateCondition("$isLoggedIn && $count > 0", { isLoggedIn: true, count: 0 })).toBe(false);
  });

  it("or operator: $a || $b", () => {
    expect(evaluateCondition("$a || $b", { a: true, b: false })).toBe(true);
    expect(evaluateCondition("$a || $b", { a: false, b: true })).toBe(true);
    expect(evaluateCondition("$a || $b", { a: false, b: false })).toBe(false);
  });

  it("parentheses: ($a || $b) && $c", () => {
    expect(evaluateCondition("($a || $b) && $c", { a: true, b: false, c: true })).toBe(true);
    expect(evaluateCondition("($a || $b) && $c", { a: true, b: false, c: false })).toBe(false);
    expect(evaluateCondition("($a || $b) && $c", { a: false, b: false, c: true })).toBe(false);
  });

  it("undefined variable evaluates to undefined", () => {
    expect(evaluateCondition("$undefinedVar === 'x'", {})).toBe(false);
    expect(evaluateCondition("$undefinedVar", {})).toBe(false);
  });

  it("empty expression returns true", () => {
    expect(evaluateCondition("", {})).toBe(true);
    expect(evaluateCondition("  ", {})).toBe(true);
  });

  it("invalid expression returns false with console.error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(evaluateCondition("$a @@ $b", { a: 1, b: 2 })).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("number literal comparison: $count === 42", () => {
    expect(evaluateCondition("$count === 42", { count: 42 })).toBe(true);
    expect(evaluateCondition("$count === 42", { count: 43 })).toBe(false);
  });

  it("null comparison: $val === null", () => {
    expect(evaluateCondition("$val === null", { val: null })).toBe(true);
    expect(evaluateCondition("$val === null", { val: "something" })).toBe(false);
  });

  it("loose equality: $val == null covers undefined", () => {
    expect(evaluateCondition("$val == null", { val: null })).toBe(true);
    expect(evaluateCondition("$val == null", { val: undefined })).toBe(true);
    expect(evaluateCondition("$val == null", {})).toBe(true);
    expect(evaluateCondition("$val == null", { val: "something" })).toBe(false);
  });

  it("double-quoted strings: $var === \"value\"", () => {
    expect(evaluateCondition('$var === "hello"', { var: "hello" })).toBe(true);
    expect(evaluateCondition('$var === "hello"', { var: "world" })).toBe(false);
  });

  it("float number comparison", () => {
    expect(evaluateCondition("$val > 3.14", { val: 4 })).toBe(true);
    expect(evaluateCondition("$val > 3.14", { val: 3 })).toBe(false);
  });

  it("boolean literal comparison", () => {
    expect(evaluateCondition("$flag === true", { flag: true })).toBe(true);
    expect(evaluateCondition("$flag === false", { flag: false })).toBe(true);
    expect(evaluateCondition("$flag === true", { flag: false })).toBe(false);
  });

  it("complex nested expression", () => {
    const vars = { a: true, b: false, c: 10, d: "yes" };
    expect(evaluateCondition("($a && !$b) || ($c > 20)", vars)).toBe(true);
    expect(evaluateCondition("!$a || ($c < 5 && $d === 'yes')", vars)).toBe(false);
  });

  it("negative number literal", () => {
    expect(evaluateCondition("$val > -5", { val: 0 })).toBe(true);
    expect(evaluateCondition("$val > -5", { val: -10 })).toBe(false);
  });

  // M2: Error handling for malformed expressions
  it("unterminated single-quoted string returns false", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(evaluateCondition("$a === 'abc", { a: "abc" })).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("unterminated double-quoted string returns false", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(evaluateCondition('$a === "abc', { a: "abc" })).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("unbalanced parentheses (missing closing) returns false", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(evaluateCondition("($a === $b", { a: 1, b: 1 })).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("empty parentheses returns false", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(evaluateCondition("()", {})).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
