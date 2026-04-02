import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";

describe("ToolRegistry", () => {
  it("should be instantiable with an McpServer", () => {
    const registry = new ToolRegistry({} as never);
    expect(registry).toBeDefined();
    expect(registry).toBeInstanceOf(ToolRegistry);
  });

  it("should have a registerAll method", () => {
    const registry = new ToolRegistry({} as never);
    expect(typeof registry.registerAll).toBe("function");
  });
});
