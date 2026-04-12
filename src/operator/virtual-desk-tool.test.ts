/**
 * Virtual Desk Tool Unit Tests (Story 19.7, Task 7)
 *
 * Tests that the virtual_desk wrapper has an empty schema
 * and that it re-exports the correct types for registration.
 */

import { describe, it, expect } from "vitest";
import { virtualDeskOperatorSchema, virtualDeskOperatorZodShape } from "./virtual-desk-tool.js";

describe("virtual-desk-tool", () => {
  // Subtask 7.3: Schema is empty, no parameters expected
  it("schema accepts empty object", () => {
    const parsed = virtualDeskOperatorSchema.parse({});
    expect(parsed).toEqual({});
  });

  // L1 fix: Corrected description — z.object({}) strips unknown keys, does not reject them
  it("schema strips unknown properties (non-strict default)", () => {
    const parsed = virtualDeskOperatorSchema.parse({ unknown_prop: "test" });
    // z.object({}) in non-strict mode strips extra keys silently
    expect(parsed).toEqual({});
  });

  it("zod shape for MCP registration is an empty object", () => {
    expect(virtualDeskOperatorZodShape).toEqual({});
  });
});
