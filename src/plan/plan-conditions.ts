import type { VarsMap } from "./plan-variables.js";

// --- Token types ---

type TokenType =
  | "variable"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "operator"
  | "lparen"
  | "rparen"
  | "not"
  | "eof";

interface Token {
  type: TokenType;
  value: unknown;
  raw: string;
}

// --- Tokenizer ---

const OPERATORS = ["===", "!==", "==", "!=", ">=", "<=", "&&", "||", ">", "<"] as const;

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expression.length) {
    // Skip whitespace
    if (/\s/.test(expression[i])) {
      i++;
      continue;
    }

    // Parentheses
    if (expression[i] === "(") {
      tokens.push({ type: "lparen", value: "(", raw: "(" });
      i++;
      continue;
    }
    if (expression[i] === ")") {
      tokens.push({ type: "rparen", value: ")", raw: ")" });
      i++;
      continue;
    }

    // Operators (multi-char first)
    let matchedOp = false;
    for (const op of OPERATORS) {
      if (expression.startsWith(op, i)) {
        tokens.push({ type: "operator", value: op, raw: op });
        i += op.length;
        matchedOp = true;
        break;
      }
    }
    if (matchedOp) continue;

    // NOT operator (! not followed by =)
    if (expression[i] === "!" && expression[i + 1] !== "=") {
      tokens.push({ type: "not", value: "!", raw: "!" });
      i++;
      continue;
    }

    // Variable: $varName
    if (expression[i] === "$") {
      const match = expression.slice(i).match(/^\$(\w+)/);
      if (match) {
        tokens.push({ type: "variable", value: match[1], raw: match[0] });
        i += match[0].length;
        continue;
      }
    }

    // String literals (single or double quoted)
    if (expression[i] === "'" || expression[i] === '"') {
      const quote = expression[i];
      let str = "";
      i++; // skip opening quote
      while (i < expression.length && expression[i] !== quote) {
        if (expression[i] === "\\" && i + 1 < expression.length) {
          str += expression[i + 1];
          i += 2;
        } else {
          str += expression[i];
          i++;
        }
      }
      if (i >= expression.length) {
        throw new Error(`Unterminated string literal starting at position ${i - str.length - 1}`);
      }
      i++; // skip closing quote
      tokens.push({ type: "string", value: str, raw: `${quote}${str}${quote}` });
      continue;
    }

    // Number literals (including negative)
    const numMatch = expression.slice(i).match(/^-?\d+(\.\d+)?/);
    if (numMatch) {
      // Make sure a negative number isn't just a minus operator
      // A negative number is valid at start, after an operator, after lparen, or after 'not'
      const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      const isNegativeNum = expression[i] === "-"
        ? (!prev || prev.type === "operator" || prev.type === "lparen" || prev.type === "not")
        : true;

      if (isNegativeNum) {
        tokens.push({ type: "number", value: Number(numMatch[0]), raw: numMatch[0] });
        i += numMatch[0].length;
        continue;
      }
    }

    // Boolean and null keywords
    if (expression.startsWith("true", i) && !/\w/.test(expression[i + 4] || "")) {
      tokens.push({ type: "boolean", value: true, raw: "true" });
      i += 4;
      continue;
    }
    if (expression.startsWith("false", i) && !/\w/.test(expression[i + 5] || "")) {
      tokens.push({ type: "boolean", value: false, raw: "false" });
      i += 5;
      continue;
    }
    if (expression.startsWith("null", i) && !/\w/.test(expression[i + 4] || "")) {
      tokens.push({ type: "null", value: null, raw: "null" });
      i += 4;
      continue;
    }

    // Unknown character — error
    throw new Error(`Unexpected character '${expression[i]}' at position ${i}`);
  }

  tokens.push({ type: "eof", value: null, raw: "" });
  return tokens;
}

// --- Recursive Descent Parser ---

class Parser {
  private pos = 0;

  constructor(
    private tokens: Token[],
    private vars: VarsMap,
  ) {}

  parse(): unknown {
    const result = this.parseOr();
    if (this.current().type !== "eof") {
      throw new Error(`Unexpected token '${this.current().raw}' at end of expression`);
    }
    return result;
  }

  private current(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.current().type === "operator" && this.current().value === "||") {
      this.advance();
      const right = this.parseAnd();
      left = left || right;
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseComparison();
    while (this.current().type === "operator" && this.current().value === "&&") {
      this.advance();
      const right = this.parseComparison();
      left = left && right;
    }
    return left;
  }

  private parseComparison(): unknown {
    let left = this.parseUnary();
    const compOps = ["===", "==", "!==", "!=", ">", "<", ">=", "<="];
    while (this.current().type === "operator" && compOps.includes(this.current().value as string)) {
      const op = this.advance().value as string;
      const right = this.parseUnary();
      left = this.applyComparison(left, op, right);
    }
    return left;
  }

  private parseUnary(): unknown {
    if (this.current().type === "not") {
      this.advance();
      const operand = this.parseUnary();
      return !operand;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): unknown {
    const token = this.current();

    if (token.type === "lparen") {
      this.advance(); // skip (
      const value = this.parseOr();
      if (this.current().type !== "rparen") {
        throw new Error("Expected closing parenthesis");
      }
      this.advance(); // skip )
      return value;
    }

    if (token.type === "variable") {
      this.advance();
      const varName = token.value as string;
      return varName in this.vars ? this.vars[varName] : undefined;
    }

    if (token.type === "string") {
      this.advance();
      return token.value;
    }

    if (token.type === "number") {
      this.advance();
      return token.value;
    }

    if (token.type === "boolean") {
      this.advance();
      return token.value;
    }

    if (token.type === "null") {
      this.advance();
      return null;
    }

    throw new Error(`Unexpected token '${token.raw}'`);
  }

  private applyComparison(left: unknown, op: string, right: unknown): boolean {
    switch (op) {
      case "===": return left === right;
      case "==": return left == right;
      case "!==": return left !== right;
      case "!=": return left != right;
      case ">": return (left as number) > (right as number);
      case "<": return (left as number) < (right as number);
      case ">=": return (left as number) >= (right as number);
      case "<=": return (left as number) <= (right as number);
      default: return false;
    }
  }
}

/**
 * Evaluate a simple condition expression against the vars map.
 * Supports: ==, ===, !=, !==, >, <, >=, <=, &&, ||, !
 * Variables via $varName syntax.
 * String literals via single or double quotes.
 * Number literals, boolean literals (true/false), null.
 *
 * SECURITY: No dynamic code evaluation. Parser-based.
 * Unknown variables evaluate to undefined.
 */
export function evaluateCondition(
  expression: string,
  vars: VarsMap,
): boolean {
  // Empty expression → true (step executes)
  if (!expression || expression.trim() === "") {
    return true;
  }

  try {
    const tokens = tokenize(expression.trim());
    const parser = new Parser(tokens, vars);
    const result = parser.parse();
    return !!result;
  } catch (err) {
    console.error(
      `[plan-conditions] Invalid expression: "${expression}" — ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
