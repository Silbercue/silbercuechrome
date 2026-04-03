import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { PipeTransport } from "./pipe-transport.js";

function createMockStreams() {
  const readable = new PassThrough();
  const writable = new PassThrough();
  return { readable, writable };
}

describe("PipeTransport", () => {
  it("should start connected", () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    expect(transport.connected).toBe(true);
  });

  it("should send message with null-byte delimiter", () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    const chunks: string[] = [];
    writable.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));

    transport.send('{"id":1,"method":"Page.navigate"}');

    expect(chunks).toEqual(['{"id":1,"method":"Page.navigate"}\0']);
  });

  it("should receive complete messages split by null-byte", async () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    const messages: string[] = [];
    transport.onMessage((msg) => messages.push(msg));

    readable.push('{"id":1,"result":{}}\0');

    await new Promise((r) => setTimeout(r, 10));
    expect(messages).toEqual(['{"id":1,"result":{}}']);
  });

  it("should handle multiple messages in one chunk", async () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    const messages: string[] = [];
    transport.onMessage((msg) => messages.push(msg));

    readable.push('{"id":1}\0{"id":2}\0');

    await new Promise((r) => setTimeout(r, 10));
    expect(messages).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("should buffer partial messages across chunks", async () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    const messages: string[] = [];
    transport.onMessage((msg) => messages.push(msg));

    readable.push('{"id":1,"met');
    readable.push('hod":"test"}\0');

    await new Promise((r) => setTimeout(r, 10));
    expect(messages).toEqual(['{"id":1,"method":"test"}']);
  });

  it("should ignore empty fragments between null-bytes", async () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    const messages: string[] = [];
    transport.onMessage((msg) => messages.push(msg));

    readable.push('{"id":1}\0\0{"id":2}\0');

    await new Promise((r) => setTimeout(r, 10));
    expect(messages).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("should return false on send when disconnected", async () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    await transport.close();

    expect(transport.send("test")).toBe(false);
    expect(transport.connected).toBe(false);
  });

  it("should propagate readable stream errors", async () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    const errorCb = vi.fn();
    transport.onError(errorCb);

    readable.destroy(new Error("pipe broken"));

    await new Promise((r) => setTimeout(r, 10));
    expect(errorCb).toHaveBeenCalledWith(expect.objectContaining({ message: "pipe broken" }));
  });

  it("should propagate writable stream errors", async () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    const errorCb = vi.fn();
    transport.onError(errorCb);

    writable.destroy(new Error("write failed"));

    await new Promise((r) => setTimeout(r, 10));
    expect(errorCb).toHaveBeenCalledWith(expect.objectContaining({ message: "write failed" }));
  });

  it("should call onClose when readable stream closes", async () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    const closeCb = vi.fn();
    transport.onClose(closeCb);

    readable.destroy();

    await new Promise((r) => setTimeout(r, 10));
    expect(closeCb).toHaveBeenCalled();
    expect(transport.connected).toBe(false);
  });

  it("should call onClose when writable stream closes unexpectedly", async () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    const closeCb = vi.fn();
    transport.onClose(closeCb);

    writable.destroy();

    await new Promise((r) => setTimeout(r, 10));
    expect(closeCb).toHaveBeenCalled();
    expect(transport.connected).toBe(false);
  });

  it("should only fire onClose once when both streams close", async () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);
    const closeCb = vi.fn();
    transport.onClose(closeCb);

    readable.destroy();
    writable.destroy();

    await new Promise((r) => setTimeout(r, 10));
    expect(closeCb).toHaveBeenCalledTimes(1);
  });

  it("should close both streams on close()", async () => {
    const { readable, writable } = createMockStreams();
    const transport = new PipeTransport(readable, writable);

    await transport.close();

    expect(transport.connected).toBe(false);
    expect(readable.destroyed).toBe(true);
  });
});
