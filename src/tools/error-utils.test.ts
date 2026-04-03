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

  it("passes through non-connection errors with tool name prefix", () => {
    const result = wrapCdpError(new Error("Some other error"), "read_page");
    expect(result).toBe("read_page failed: Some other error");
  });

  it("handles non-Error objects", () => {
    const result = wrapCdpError("string error", "screenshot");
    expect(result).toBe("screenshot failed: string error");
  });
});
