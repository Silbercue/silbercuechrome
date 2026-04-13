import { describe, it, expect } from "vitest";
import { wrapCdpError } from "./error-utils.js";

describe("wrapCdpError", () => {
  it("wraps 'CdpClient is closed' into friendly reconnect message", () => {
    const result = wrapCdpError(new Error("CdpClient is closed"), "evaluate");
    expect(result).toBe("CDP connection lost. The server is attempting to reconnect. Retry your request in a few seconds.");
  });

  it("wraps 'CdpClient closed' (without 'is') into friendly reconnect message", () => {
    const result = wrapCdpError(new Error("CdpClient closed"), "evaluate");
    expect(result).toBe("CDP connection lost. The server is attempting to reconnect. Retry your request in a few seconds.");
  });

  it("wraps 'Transport is not connected' into friendly reconnect message", () => {
    const result = wrapCdpError(new Error("Transport is not connected"), "navigate");
    expect(result).toBe("CDP connection lost. The server is attempting to reconnect. Retry your request in a few seconds.");
  });

  it("wraps 'Transport closed unexpectedly' into friendly reconnect message", () => {
    const result = wrapCdpError(new Error("Transport closed unexpectedly"), "click");
    expect(result).toBe("CDP connection lost. The server is attempting to reconnect. Retry your request in a few seconds.");
  });

  it("wraps 'Session with given id not found' with virtual_desk hint", () => {
    const result = wrapCdpError(new Error("CDP error -32000: Session with given id not found"), "click");
    expect(result).toBe("click failed: CDP error -32000: Session with given id not found. Use virtual_desk to discover available tabs and reconnect.");
  });

  it("wraps 'No target with given id found' with virtual_desk hint", () => {
    const result = wrapCdpError(new Error("CDP error -32000: No target with given id found"), "navigate");
    expect(result).toBe("navigate failed: CDP error -32000: No target with given id found. Use virtual_desk to discover available tabs and reconnect.");
  });

  it("passes through non-connection errors with tool name prefix", () => {
    const result = wrapCdpError(new Error("Some other error"), "view_page");
    expect(result).toBe("view_page failed: Some other error");
  });

  it("handles non-Error objects", () => {
    const result = wrapCdpError("string error", "capture_image");
    expect(result).toBe("capture_image failed: string error");
  });

  // FR-003: invisible element errors
  it("wraps 'Node does not have a layout object' into LLM-friendly not-visible message", () => {
    const result = wrapCdpError(
      new Error("CDP error -32000: Node does not have a layout object"),
      "click",
      "e51",
    );
    expect(result).toContain("click failed:");
    expect(result).toContain("e51");
    expect(result).toContain("not visible");
    expect(result).toContain("display:none");
    expect(result).not.toContain("-32000");
  });

  it("wraps 'Could not compute content quads' into LLM-friendly not-visible message", () => {
    const result = wrapCdpError(
      new Error("CDP error -32000: Could not compute content quads for the node"),
      "click",
      "#hidden-btn",
    );
    expect(result).toContain("click failed:");
    expect(result).toContain("#hidden-btn");
    expect(result).toContain("not visible");
  });

  it("uses generic element hint when no elementHint is provided for layout error", () => {
    const result = wrapCdpError(
      new Error("Node does not have a layout object"),
      "click",
    );
    expect(result).toContain("target element");
    expect(result).toContain("not visible");
  });
});
