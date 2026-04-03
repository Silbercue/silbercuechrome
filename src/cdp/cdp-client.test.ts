import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CdpTransport } from "../transport/transport.js";
import { CdpClient } from "./cdp-client.js";

class MockTransport implements CdpTransport {
  connected = true;
  private _messageCallback: ((message: string) => void) | null = null;
  private _errorCallback: ((error: Error) => void) | null = null;
  private _closeCallback: (() => void) | null = null;
  readonly sent: string[] = [];

  send(message: string): boolean {
    if (!this.connected) return false;
    this.sent.push(message);
    return true;
  }

  onMessage(cb: (message: string) => void): void {
    this._messageCallback = cb;
  }

  onError(cb: (error: Error) => void): void {
    this._errorCallback = cb;
  }

  onClose(cb: () => void): void {
    this._closeCallback = cb;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  // Test helpers
  simulateMessage(msg: string): void {
    this._messageCallback?.(msg);
  }

  simulateError(err: Error): void {
    this._errorCallback?.(err);
  }

  simulateClose(): void {
    this._closeCallback?.();
  }
}

describe("CdpClient", () => {
  let transport: MockTransport;
  let client: CdpClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = new CdpClient(transport);
  });

  describe("send", () => {
    it("should send serialized CDP request with auto-increment ID", () => {
      client.send("Page.navigate", { url: "https://example.com" });
      client.send("Runtime.evaluate", { expression: "1+1" });

      expect(transport.sent).toHaveLength(2);
      const msg1 = JSON.parse(transport.sent[0]);
      const msg2 = JSON.parse(transport.sent[1]);

      expect(msg1).toEqual({ id: 1, method: "Page.navigate", params: { url: "https://example.com" } });
      expect(msg2).toEqual({ id: 2, method: "Runtime.evaluate", params: { expression: "1+1" } });
    });

    it("should include sessionId when provided", () => {
      client.send("DOM.getDocument", {}, "TARGET_SESSION");

      const msg = JSON.parse(transport.sent[0]);
      expect(msg.sessionId).toBe("TARGET_SESSION");
    });

    it("should omit params and sessionId when not provided", () => {
      client.send("Page.reload");

      const msg = JSON.parse(transport.sent[0]);
      expect(msg).toEqual({ id: 1, method: "Page.reload" });
      expect("params" in msg).toBe(false);
      expect("sessionId" in msg).toBe(false);
    });

    it("should resolve with result on success response", async () => {
      const promise = client.send("Page.navigate", { url: "https://example.com" });

      transport.simulateMessage(JSON.stringify({ id: 1, result: { frameId: "abc" } }));

      const result = await promise;
      expect(result).toEqual({ frameId: "abc" });
    });

    it("should reject on CDP error response", async () => {
      const promise = client.send("Page.navigate", { url: "invalid" });

      transport.simulateMessage(
        JSON.stringify({ id: 1, error: { code: -32000, message: "Cannot navigate" } }),
      );

      await expect(promise).rejects.toThrow("CDP error -32000: Cannot navigate");
    });

    it("should reject on timeout", async () => {
      vi.useFakeTimers();
      const client30 = new CdpClient(transport, { timeoutMs: 100 });

      const promise = client30.send("Page.navigate");

      vi.advanceTimersByTime(100);

      await expect(promise).rejects.toThrow('CDP call "Page.navigate" timed out after 100ms');
      vi.useRealTimers();
    });

    it("should reject when transport is not connected", async () => {
      transport.connected = false;

      await expect(client.send("Page.navigate")).rejects.toThrow(
        "Transport is not connected",
      );
    });

    it("should reject when client is closed", async () => {
      await client.close();

      await expect(client.send("Page.navigate")).rejects.toThrow("CdpClient is closed");
    });
  });

  describe("event routing", () => {
    it("should route events to on() listeners", () => {
      const cb = vi.fn();
      client.on("Page.loadEventFired", cb);

      transport.simulateMessage(
        JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1234 } }),
      );

      expect(cb).toHaveBeenCalledWith({ timestamp: 1234 }, undefined);
    });

    it("should route events with sessionId", () => {
      const cb = vi.fn();
      client.on("Network.requestWillBeSent", cb);

      transport.simulateMessage(
        JSON.stringify({
          method: "Network.requestWillBeSent",
          params: { requestId: "1" },
          sessionId: "TARGET",
        }),
      );

      expect(cb).toHaveBeenCalledWith({ requestId: "1" }, "TARGET");
    });

    it("should support multiple listeners for same event", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      client.on("Page.loadEventFired", cb1);
      client.on("Page.loadEventFired", cb2);

      transport.simulateMessage(
        JSON.stringify({ method: "Page.loadEventFired", params: {} }),
      );

      expect(cb1).toHaveBeenCalled();
      expect(cb2).toHaveBeenCalled();
    });

    it("should fire once() listener only once", () => {
      const cb = vi.fn();
      client.once("Page.loadEventFired", cb);

      transport.simulateMessage(
        JSON.stringify({ method: "Page.loadEventFired", params: {} }),
      );
      transport.simulateMessage(
        JSON.stringify({ method: "Page.loadEventFired", params: {} }),
      );

      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("should remove listener with off()", () => {
      const cb = vi.fn();
      client.on("Page.loadEventFired", cb);
      client.off("Page.loadEventFired", cb);

      transport.simulateMessage(
        JSON.stringify({ method: "Page.loadEventFired", params: {} }),
      );

      expect(cb).not.toHaveBeenCalled();
    });

    it("should handle events without params", () => {
      const cb = vi.fn();
      client.on("Page.loadEventFired", cb);

      transport.simulateMessage(JSON.stringify({ method: "Page.loadEventFired" }));

      expect(cb).toHaveBeenCalledWith(undefined, undefined);
    });

    it("should filter events by sessionId when provided", () => {
      const cb = vi.fn();
      client.on("Network.requestWillBeSent", cb, "SESSION_A");

      // Event with matching sessionId — should fire
      transport.simulateMessage(
        JSON.stringify({
          method: "Network.requestWillBeSent",
          params: { requestId: "1" },
          sessionId: "SESSION_A",
        }),
      );

      // Event with different sessionId — should NOT fire
      transport.simulateMessage(
        JSON.stringify({
          method: "Network.requestWillBeSent",
          params: { requestId: "2" },
          sessionId: "SESSION_B",
        }),
      );

      // Event without sessionId — should NOT fire
      transport.simulateMessage(
        JSON.stringify({
          method: "Network.requestWillBeSent",
          params: { requestId: "3" },
        }),
      );

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({ requestId: "1" }, "SESSION_A");
    });

    it("should filter once() events by sessionId", () => {
      const cb = vi.fn();
      client.once("Page.loadEventFired", cb, "SESSION_X");

      // Non-matching — should not fire, should not consume the listener
      transport.simulateMessage(
        JSON.stringify({ method: "Page.loadEventFired", params: {}, sessionId: "OTHER" }),
      );
      expect(cb).not.toHaveBeenCalled();

      // Matching — should fire and consume
      transport.simulateMessage(
        JSON.stringify({ method: "Page.loadEventFired", params: { ts: 1 }, sessionId: "SESSION_X" }),
      );
      expect(cb).toHaveBeenCalledTimes(1);

      // Second matching — should NOT fire (already consumed)
      transport.simulateMessage(
        JSON.stringify({ method: "Page.loadEventFired", params: { ts: 2 }, sessionId: "SESSION_X" }),
      );
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("should receive all events when no sessionId filter is set", () => {
      const cb = vi.fn();
      client.on("Page.loadEventFired", cb);

      transport.simulateMessage(
        JSON.stringify({ method: "Page.loadEventFired", params: {}, sessionId: "A" }),
      );
      transport.simulateMessage(
        JSON.stringify({ method: "Page.loadEventFired", params: {} }),
      );

      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  describe("error handling", () => {
    it("should reject all pending calls on transport error", async () => {
      const p1 = client.send("Page.navigate");
      const p2 = client.send("Runtime.evaluate");

      transport.simulateError(new Error("pipe broken"));

      await expect(p1).rejects.toThrow("Transport error: pipe broken");
      await expect(p2).rejects.toThrow("Transport error: pipe broken");
    });

    it("should reject all pending calls on transport close", async () => {
      const p1 = client.send("Page.navigate");

      transport.simulateClose();

      await expect(p1).rejects.toThrow("Transport closed unexpectedly");
    });

    it("should reject all pending calls on client close", async () => {
      const p1 = client.send("Page.navigate");

      await client.close();

      await expect(p1).rejects.toThrow("CdpClient closed");
    });

    it("should ignore invalid JSON messages", () => {
      expect(() => transport.simulateMessage("not json")).not.toThrow();
    });

    it("should ignore responses with unknown IDs", () => {
      expect(() =>
        transport.simulateMessage(JSON.stringify({ id: 999, result: {} })),
      ).not.toThrow();
    });
  });
});
