import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CdpClient } from "../cdp/cdp-client.js";
import {
  setPageDataSchema,
  setPageDataHandler,
  readSource,
  chunkBuffer,
  resolveEncoding,
  buildInitExpression,
  buildAppendExpression,
  buildFinalizeExpression,
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
} from "./set-page-data.js";
import type { SetPageDataParams } from "./set-page-data.js";

// --- Mock node:fs ---

vi.mock("node:fs", () => ({
  lstatSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { lstatSync, readFileSync } from "node:fs";
const mockLstatSync = vi.mocked(lstatSync);
const mockReadFileSync = vi.mocked(readFileSync);

/**
 * Convenience helper: returns a minimal `fs.Stats`-shaped object describing
 * a regular file of `size` bytes. Only fields the production code touches
 * are populated — TypeScript's `Stats` shape gets a `Partial` cast.
 */
function statsForFile(size: number): import("node:fs").Stats {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size,
  } as unknown as import("node:fs").Stats;
}

function statsForKind(kind: "symlink" | "directory" | "device" | "fifo"): import("node:fs").Stats {
  return {
    isFile: () => false,
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
    isBlockDevice: () => kind === "device",
    isCharacterDevice: () => false,
    isFIFO: () => kind === "fifo",
    isSocket: () => false,
    size: 0,
  } as unknown as import("node:fs").Stats;
}

function enoentError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = Object.assign(new Error("ENOENT"), {
    code: "ENOENT",
  });
  return err;
}

// --- Mock CDP client ---

type EventCallback = (params: unknown, sessionId?: string) => void;

interface MockCdpSetup {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
  /**
   * Simulates a CDP event dispatch. Replicates `CdpClient._dispatch`'s
   * session-scoping: only listeners whose subscribed sessionId is `undefined`
   * or matches `eventSessionId` receive the callback. Passing no
   * `eventSessionId` keeps the default behaviour (matches all listeners) —
   * useful for legacy tests that do not care about session scoping.
   */
  fireEvent: (method: string, params: unknown, eventSessionId?: string) => void;
}

/**
 * Optional verify-size to be returned by the default `Runtime.evaluate`
 * mock when it sees the verify-shape expression (built by
 * buildVerifyExpression). Tests that drive a real end-to-end run set this
 * to the value the production handler will compute via
 * `expectedFinalizedSize(buf, encoding)` so the post-finalize verify passes.
 */
interface DefaultMockOptions {
  verifySize?: number;
}

function createMockCdp(
  overrides: Record<string, unknown> = {},
  opts: DefaultMockOptions = {},
): MockCdpSetup {
  const defaultResponses: Record<string, unknown> = {
    "Page.getFrameTree": { frameTree: { frame: { id: "main-frame-1" } } },
    ...overrides,
  };

  const listeners = new Map<string, Set<{ callback: EventCallback; sessionId?: string }>>();

  const sendFn = vi.fn(async (method: string, params?: unknown) => {
    if (method === "Runtime.evaluate") {
      // If the test injected a custom response under "Runtime.evaluate"
      // (e.g. throws an exception), prefer that. Otherwise dispatch by
      // expression shape: the verify call gets the configured size, all
      // other calls (init / append / finalize) get a placeholder number.
      if ("Runtime.evaluate" in defaultResponses) {
        const val = defaultResponses["Runtime.evaluate"];
        if (typeof val === "function") return (val as (p?: unknown) => unknown)(params);
        return val;
      }
      const expr = (params as { expression?: string } | undefined)?.expression ?? "";
      const isVerify = /typeof slot\.byteLength === 'number'/.test(expr);
      if (isVerify && opts.verifySize !== undefined) {
        return { result: { type: "number", value: opts.verifySize } };
      }
      return { result: { type: "number", value: 1 } };
    }
    if (method in defaultResponses) {
      const val = defaultResponses[method];
      if (typeof val === "function") return (val as (p?: unknown) => unknown)(params);
      return val;
    }
    return {};
  });

  const onFn = vi.fn((method: string, callback: EventCallback, sessionId?: string) => {
    let set = listeners.get(method);
    if (!set) {
      set = new Set();
      listeners.set(method, set);
    }
    set.add({ callback, sessionId });
  });

  const offFn = vi.fn((method: string, callback: EventCallback) => {
    const set = listeners.get(method);
    if (set) {
      for (const entry of set) {
        if (entry.callback === callback) {
          set.delete(entry);
          break;
        }
      }
    }
  });

  const cdpClient = {
    send: sendFn,
    on: onFn,
    once: vi.fn(),
    off: offFn,
  } as unknown as CdpClient;

  const fireEvent = (method: string, params: unknown, eventSessionId?: string) => {
    const set = listeners.get(method);
    if (!set) return;
    for (const entry of set) {
      // Match the real dispatcher's session-scoping (see CdpClient._dispatch):
      // a listener fires when it was subscribed without a session filter OR
      // when the incoming event matches its subscribed sessionId.
      if (eventSessionId !== undefined) {
        if (entry.sessionId !== undefined && entry.sessionId !== eventSessionId) {
          continue;
        }
      }
      entry.callback(params, eventSessionId ?? entry.sessionId);
    }
  };

  return { cdpClient, sendFn, fireEvent };
}

// =====================================================================
// Schema tests
// =====================================================================

describe("setPageDataSchema", () => {
  it("accepts inline source with valid key", () => {
    const result = setPageDataSchema.parse({
      key: "scan_image_1",
      source: { type: "inline", data: "aGVsbG8=" },
    });
    expect(result.key).toBe("scan_image_1");
    expect(result.source.type).toBe("inline");
  });

  it("accepts file source with absolute path", () => {
    const result = setPageDataSchema.parse({
      key: "blob",
      source: { type: "file", path: "/tmp/payload.bin" },
      encoding: "binary",
    });
    expect(result.source.type).toBe("file");
    if (result.source.type === "file") {
      expect(result.source.path).toBe("/tmp/payload.bin");
    }
    expect(result.encoding).toBe("binary");
  });

  it("rejects key with special characters (curly brace)", () => {
    expect(() =>
      setPageDataSchema.parse({
        key: "evil{",
        source: { type: "inline", data: "x" },
      }),
    ).toThrow();
  });

  it("rejects key with quote injection", () => {
    expect(() =>
      setPageDataSchema.parse({
        key: "'); evil(); ('",
        source: { type: "inline", data: "x" },
      }),
    ).toThrow();
  });

  it("rejects key with whitespace", () => {
    expect(() =>
      setPageDataSchema.parse({
        key: "my key",
        source: { type: "inline", data: "x" },
      }),
    ).toThrow();
  });

  it("rejects key starting with a digit", () => {
    expect(() =>
      setPageDataSchema.parse({
        key: "1key",
        source: { type: "inline", data: "x" },
      }),
    ).toThrow();
  });

  it("rejects key with hyphen", () => {
    expect(() =>
      setPageDataSchema.parse({
        key: "my-key",
        source: { type: "inline", data: "x" },
      }),
    ).toThrow();
  });

  it("rejects key with bracket", () => {
    expect(() =>
      setPageDataSchema.parse({
        key: "my[0]",
        source: { type: "inline", data: "x" },
      }),
    ).toThrow();
  });

  it("accepts encoding 'binary'", () => {
    const r = setPageDataSchema.parse({
      key: "k",
      source: { type: "inline", data: "x" },
      encoding: "binary",
    });
    expect(r.encoding).toBe("binary");
  });

  it("accepts encoding 'utf8'", () => {
    const r = setPageDataSchema.parse({
      key: "k",
      source: { type: "inline", data: "x" },
      encoding: "utf8",
    });
    expect(r.encoding).toBe("utf8");
  });

  it("accepts encoding 'base64'", () => {
    const r = setPageDataSchema.parse({
      key: "k",
      source: { type: "inline", data: "x" },
      encoding: "base64",
    });
    expect(r.encoding).toBe("base64");
  });

  it("rejects unknown encoding", () => {
    expect(() =>
      setPageDataSchema.parse({
        key: "k",
        source: { type: "inline", data: "x" },
        encoding: "hex",
      }),
    ).toThrow();
  });

  it("rejects negative chunkSize", () => {
    expect(() =>
      setPageDataSchema.parse({
        key: "k",
        source: { type: "inline", data: "x" },
        chunkSize: -1,
      }),
    ).toThrow();
  });
});

// =====================================================================
// readSource tests
// =====================================================================

describe("readSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads inline utf8 data", () => {
    const buf = readSource({ type: "inline", data: "Hello" }, "utf8");
    expect(buf.toString("utf8")).toBe("Hello");
  });

  it("reads inline base64 data", () => {
    const original = Buffer.from("Hello world");
    const buf = readSource(
      { type: "inline", data: original.toString("base64") },
      "base64",
    );
    expect(buf.equals(original)).toBe(true);
  });

  it("reads inline binary data (interprets as base64)", () => {
    const original = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const buf = readSource(
      { type: "inline", data: original.toString("base64") },
      "binary",
    );
    expect(buf.equals(original)).toBe(true);
  });

  it("defaults inline to utf8 when encoding omitted", () => {
    const buf = readSource({ type: "inline", data: "Hi" }, undefined);
    expect(buf.toString("utf8")).toBe("Hi");
  });

  it("reads from absolute file path", () => {
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const buf = readSource({ type: "file", path: "/tmp/p.bin" }, "binary");
    expect(buf.equals(payload)).toBe(true);
    expect(mockLstatSync).toHaveBeenCalledWith("/tmp/p.bin");
    expect(mockReadFileSync).toHaveBeenCalledWith("/tmp/p.bin");
  });

  it("throws when file does not exist (lstat ENOENT)", () => {
    mockLstatSync.mockImplementation(() => {
      throw enoentError();
    });
    expect(() =>
      readSource({ type: "file", path: "/tmp/missing.bin" }, "binary"),
    ).toThrow(/File not found/);
  });

  it("throws on relative path", () => {
    expect(() =>
      readSource({ type: "file", path: "relative/path.bin" }, "binary"),
    ).toThrow(/Relative path not allowed/);
  });

  it("rejects symlinks (security)", () => {
    mockLstatSync.mockReturnValue(statsForKind("symlink"));
    expect(() =>
      readSource({ type: "file", path: "/tmp/link.bin" }, "binary"),
    ).toThrow(/Not a regular file/);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("rejects directories", () => {
    mockLstatSync.mockReturnValue(statsForKind("directory"));
    expect(() =>
      readSource({ type: "file", path: "/tmp/somedir" }, "binary"),
    ).toThrow(/Not a regular file/);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("rejects FIFOs / device files", () => {
    mockLstatSync.mockReturnValue(statsForKind("fifo"));
    expect(() =>
      readSource({ type: "file", path: "/tmp/fifo" }, "binary"),
    ).toThrow(/Not a regular file/);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("rejects files larger than MAX_FILE_SIZE (OOM-DoS guard)", () => {
    // 100 MB + 1 byte → over the cap. We do NOT actually allocate that
    // buffer — readFileSync is never reached.
    mockLstatSync.mockReturnValue(statsForFile(100 * 1024 * 1024 + 1));
    expect(() =>
      readSource({ type: "file", path: "/tmp/huge.bin" }, "binary"),
    ).toThrow(/File too large/);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });
});

// =====================================================================
// chunkBuffer tests
// =====================================================================

describe("chunkBuffer", () => {
  it("returns single chunk for small buffer", () => {
    const buf = Buffer.from([1, 2, 3]);
    const chunks = chunkBuffer(buf, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].equals(buf)).toBe(true);
  });

  it("rounds chunkSize down to multiple of 3 (C1 padding-free)", () => {
    // chunkSize=100 → effectively 99 (= 33 * 3, multiple of 3 so base64
    // encodes with no padding mid-stream)
    const buf = Buffer.alloc(300, 0xaa);
    const chunks = chunkBuffer(buf, 100);
    // 300 / 99 → 4 chunks (99 + 99 + 99 + 3)
    expect(chunks).toHaveLength(4);
    expect(chunks[0].length).toBe(99);
    expect(chunks[1].length).toBe(99);
    expect(chunks[2].length).toBe(99);
    expect(chunks[3].length).toBe(3);
    // All non-final chunks must be multiples of 3 → no base64 padding.
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].length % 3).toBe(0);
      expect(chunks[i].toString("base64")).not.toMatch(/=/);
    }
  });

  it("handles trailing partial chunk that is not multiple of 3", () => {
    const buf = Buffer.alloc(250, 0x55);
    const chunks = chunkBuffer(buf, 100);
    // 250 / 99 → 99 + 99 + 52 = 3 chunks
    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(99);
    expect(chunks[1].length).toBe(99);
    expect(chunks[2].length).toBe(52);
    // Final chunk MAY have padding — verify that's the only chunk that could
    expect(chunks[0].toString("base64")).not.toMatch(/=/);
    expect(chunks[1].toString("base64")).not.toMatch(/=/);
  });

  it("returns single empty chunk for empty buffer", () => {
    const chunks = chunkBuffer(Buffer.alloc(0), 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(0);
  });

  it("default chunkSize 500_000 rounds to 499_998 (= 166_666 * 3)", () => {
    // 1.6 MB → expect 4 chunks: 3 * 499_998 + 100_006 = 1_600_000
    const buf = Buffer.alloc(1_600_000, 0x33);
    const chunks = chunkBuffer(buf, 500_000);
    expect(chunks).toHaveLength(4);
    expect(chunks[0].length).toBe(499_998);
    expect(chunks[1].length).toBe(499_998);
    expect(chunks[2].length).toBe(499_998);
    expect(chunks[3].length).toBe(100_006);
    // Non-final chunks must base64-encode without `=` padding.
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].toString("base64")).not.toMatch(/=/);
    }
  });

  it("clamps tiny chunkSize to at least 3 (floor of multiple-of-3)", () => {
    // chunkSize=2 → would round down to 0 (Math.floor(2/3)*3 = 0). The
    // helper must clamp to 3 to keep forward progress + base64 alignment.
    const buf = Buffer.alloc(7, 0xff);
    const chunks = chunkBuffer(buf, 2);
    // chunkSize effectively = 3 → 3, 3, 1
    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(3);
    expect(chunks[1].length).toBe(3);
    expect(chunks[2].length).toBe(1);
  });
});

// =====================================================================
// End-to-end byte-roundtrip — catches the C1 padding regression directly.
// =====================================================================

describe("chunked base64 roundtrip (C1 regression test)", () => {
  /**
   * Helper that mimics the exact wire steps the production handler does:
   * 1. Split the buffer with chunkBuffer
   * 2. base64-encode EACH chunk independently (this is the C1 hazard —
   *    pre-fix, this produced `=` chars in the middle of the stream)
   * 3. Concatenate the per-chunk base64 strings exactly like the page's
   *    `window.__pb_data[key] += <chunkB64>` does
   * 4. Decode the concatenated string back into bytes (the page's
   *    finalize step does the same — `atob` / `Uint8Array.fromBase64`)
   * 5. Return the decoded buffer for byte-for-byte comparison
   */
  function chunkedBase64Roundtrip(buf: Buffer, chunkSize: number): Buffer {
    const chunks = chunkBuffer(buf, chunkSize);
    const concatenated = chunks.map((c) => c.toString("base64")).join("");
    // `Buffer.from(_, 'base64')` is what Node's atob equivalent does. If a
    // middle chunk produced `=` padding, this call silently truncates at
    // the first `=` (Node's documented behaviour). The post-C1-fix
    // chunking aligns to multiples of 3 so this cannot happen.
    return Buffer.from(concatenated, "base64");
  }

  it("1.6 MB random payload roundtrips byte-for-byte (chunkSize=500_000)", () => {
    // Deterministic pseudo-random bytes — avoids depending on `crypto` and
    // makes failures reproducible. We use a simple LCG.
    const buf = Buffer.alloc(1_600_000);
    let s = 0x12345678;
    for (let i = 0; i < buf.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      buf[i] = s & 0xff;
    }
    const decoded = chunkedBase64Roundtrip(buf, 500_000);
    expect(decoded.length).toBe(buf.length);
    expect(decoded.equals(buf)).toBe(true);
  });

  it("boundary length mod 3 == 0 roundtrips", () => {
    const buf = Buffer.alloc(999_999); // exactly divisible by 3
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) & 0xff;
    const decoded = chunkedBase64Roundtrip(buf, 500_000);
    expect(decoded.equals(buf)).toBe(true);
  });

  it("boundary length mod 3 == 1 roundtrips", () => {
    const buf = Buffer.alloc(1_000_000); // 999_999 + 1, mod 3 == 1
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 73 + 11) & 0xff;
    const decoded = chunkedBase64Roundtrip(buf, 500_000);
    expect(decoded.equals(buf)).toBe(true);
  });

  it("boundary length mod 3 == 2 roundtrips", () => {
    const buf = Buffer.alloc(1_000_001); // mod 3 == 2
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 97 + 13) & 0xff;
    const decoded = chunkedBase64Roundtrip(buf, 500_000);
    expect(decoded.equals(buf)).toBe(true);
  });

  it("crossing many chunk boundaries (small chunkSize=10) roundtrips", () => {
    // Stress-test: 1037 bytes / chunkSize=10 → effective 9 → 116 chunks.
    // Lots of chunk boundaries, several different mod-3 residues across
    // the trailing chunks — anything padding-related blows up here.
    const buf = Buffer.alloc(1037);
    for (let i = 0; i < buf.length; i++) buf[i] = (i ^ 0x5a) & 0xff;
    const decoded = chunkedBase64Roundtrip(buf, 10);
    expect(decoded.equals(buf)).toBe(true);
  });

  it("middle chunks contain NO base64 `=` padding (C1 invariant)", () => {
    // Direct check on the chunker output: only the trailing chunk may have
    // padding, every other chunk encodes cleanly to a base64 string ending
    // in a non-`=` character.
    const buf = Buffer.alloc(2_000_000, 0xc3);
    const chunks = chunkBuffer(buf, 500_000);
    for (let i = 0; i < chunks.length - 1; i++) {
      const b64 = chunks[i].toString("base64");
      expect(b64).not.toMatch(/=/);
    }
  });
});

// =====================================================================
// resolveEncoding tests
// =====================================================================

describe("resolveEncoding", () => {
  it("defaults inline to utf8", () => {
    expect(resolveEncoding({ type: "inline", data: "x" }, undefined)).toBe("utf8");
  });

  it("defaults file to binary", () => {
    expect(resolveEncoding({ type: "file", path: "/tmp/x" }, undefined)).toBe("binary");
  });

  it("honors explicit encoding", () => {
    expect(resolveEncoding({ type: "inline", data: "x" }, "base64")).toBe("base64");
    expect(resolveEncoding({ type: "file", path: "/tmp/x" }, "utf8")).toBe("utf8");
  });
});

// =====================================================================
// Expression builder tests
// =====================================================================

describe("buildInitExpression", () => {
  it("creates the global container and resets the slot", () => {
    const expr = buildInitExpression("mykey");
    expect(expr).toContain("window.__pb_data");
    expect(expr).toContain("window.__pb_data['mykey'] = ''");
    expect(expr).toContain("window.__pb_data['mykey__complete'] = false");
  });
});

describe("buildAppendExpression", () => {
  it("appends a chunk to the slot", () => {
    const expr = buildAppendExpression("mykey", "QUJDREVG");
    expect(expr).toContain("window.__pb_data['mykey'] += 'QUJDREVG'");
  });
});

describe("buildFinalizeExpression", () => {
  it("binary encoding contains Uint8Array decode + buffer + fallback", () => {
    const expr = buildFinalizeExpression("blob", "binary");
    expect(expr).toContain("Uint8Array.fromBase64");
    expect(expr).toContain("atob"); // fallback
    expect(expr).toContain("new Uint8Array");
    expect(expr).toContain(".buffer");
    expect(expr).toContain("window.__pb_data['blob__complete'] = true");
  });

  it("utf8 encoding decodes via TextDecoder, no ArrayBuffer", () => {
    const expr = buildFinalizeExpression("payload", "utf8");
    expect(expr).toContain("TextDecoder");
    expect(expr).not.toContain("u8.buffer");
    expect(expr).toContain("window.__pb_data['payload__complete'] = true");
  });

  it("base64 encoding keeps the string as-is", () => {
    const expr = buildFinalizeExpression("b64", "base64");
    expect(expr).not.toContain("TextDecoder");
    expect(expr).not.toContain("Uint8Array");
    expect(expr).not.toContain("atob");
    expect(expr).toContain("window.__pb_data['b64__complete'] = true");
  });
});

// =====================================================================
// Handler tests
// =====================================================================

describe("setPageDataHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("single-chunk path: 300 KB payload → init + 1 chunk + finalize + verify = 4 evaluate calls + 1 getFrameTree", async () => {
    const payload = Buffer.alloc(300_000, 0x42);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient, sendFn } = createMockCdp({}, { verifySize: payload.length });

    const params: SetPageDataParams = {
      key: "payload300",
      source: { type: "file", path: "/tmp/300k.bin" },
      encoding: "binary",
    };

    const result = await setPageDataHandler(params, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    const evalCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Runtime.evaluate");
    expect(evalCalls).toHaveLength(4); // init + 1 chunk + finalize + verify
    const frameCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Page.getFrameTree");
    expect(frameCalls).toHaveLength(1);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("300,000 bytes");
    expect(text).toContain("__pb_data['payload300']");
    expect(text).toContain("1 chunk");
    expect(text).toContain("Encoding: binary");
  });

  it("multi-chunk path: 1.6 MB payload, chunkSize 500 KB → init + 4 chunks + finalize + verify = 7 evaluate calls", async () => {
    const payload = Buffer.alloc(1_600_000, 0x01);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient, sendFn } = createMockCdp({}, { verifySize: payload.length });

    const params: SetPageDataParams = {
      key: "big",
      source: { type: "file", path: "/tmp/1_6mb.bin" },
      encoding: "binary",
      chunkSize: 500_000,
    };

    const result = await setPageDataHandler(params, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    const evalCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Runtime.evaluate");
    // chunkSize=500_000 rounds to 499_998 (= 166_666*3, multiple of 3 to keep
    // base64 padding-free across the concatenation). 1_600_000 / 499_998 →
    // 3 full chunks + trailing 100_006 = 4 chunks.
    // init + 4 chunks + finalize + verify = 7
    expect(evalCalls).toHaveLength(7);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("4 chunks");
  });

  it("file source: missing file → ENOENT error BEFORE any CDP calls", async () => {
    mockLstatSync.mockImplementation(() => {
      throw enoentError();
    });
    const { cdpClient, sendFn } = createMockCdp();

    const params: SetPageDataParams = {
      key: "k",
      source: { type: "file", path: "/tmp/missing.bin" },
      encoding: "binary",
    };

    const result = await setPageDataHandler(params, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("File not found");
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("file source: relative path is rejected BEFORE any CDP calls", async () => {
    const { cdpClient, sendFn } = createMockCdp();

    const params: SetPageDataParams = {
      key: "k",
      source: { type: "file", path: "relative/path.bin" },
      encoding: "binary",
    };

    const result = await setPageDataHandler(params, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Relative path not allowed");
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("encoding='binary' finalize uses Uint8Array.fromBase64 + ArrayBuffer", async () => {
    const payload = Buffer.from([1, 2, 3]);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient, sendFn } = createMockCdp({}, { verifySize: payload.length });

    await setPageDataHandler(
      {
        key: "bin",
        source: { type: "file", path: "/tmp/x.bin" },
        encoding: "binary",
      },
      cdpClient,
      "s1",
    );

    const evalCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Runtime.evaluate");
    // Order: init, append, finalize, verify. Pick the finalize (last but one).
    const finalizeArgs = evalCalls[evalCalls.length - 2][1] as { expression: string };
    expect(finalizeArgs.expression).toContain("Uint8Array.fromBase64");
    expect(finalizeArgs.expression).toContain("u8.buffer");
  });

  it("encoding='utf8' finalize does NOT use Uint8Array.fromBase64 nor ArrayBuffer", async () => {
    // expectedFinalizedSize for utf8 = `Buffer.from("Hello","utf8").toString("utf8").length` = 5
    const { cdpClient, sendFn } = createMockCdp({}, { verifySize: 5 });

    await setPageDataHandler(
      {
        key: "txt",
        source: { type: "inline", data: "Hello" },
        encoding: "utf8",
      },
      cdpClient,
      "s1",
    );

    const evalCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Runtime.evaluate");
    // Order: init, append, finalize, verify. Pick the finalize (penultimate).
    const finalizeArgs = evalCalls[evalCalls.length - 2][1] as { expression: string };
    expect(finalizeArgs.expression).not.toContain("u8.buffer");
    expect(finalizeArgs.expression).toContain("TextDecoder");
  });

  it("uses default chunkSize when omitted", async () => {
    // Payload > DEFAULT_CHUNK_SIZE (rounded to 499_998) → expect 2 chunks.
    const payload = Buffer.alloc(DEFAULT_CHUNK_SIZE + 1000, 0x77);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);
    // file source default encoding = "binary" → verify is the buf length
    const { cdpClient, sendFn } = createMockCdp({}, { verifySize: payload.length });

    const result = await setPageDataHandler(
      {
        key: "k",
        source: { type: "file", path: "/tmp/p.bin" },
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
    const evalCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Runtime.evaluate");
    // init + 2 chunks + finalize + verify = 5
    expect(evalCalls).toHaveLength(5);
  });

  it("caps chunkSize at MAX_CHUNK_SIZE", async () => {
    // chunkSize is capped at MAX_CHUNK_SIZE (700_000) and then rounded down
    // to a multiple of 3 → 699_999 (= 233_333 * 3). 2 * 699_999 = 1_399_998
    // (1_399_998 / 699_999 = 2.0 exactly) — split into 2 chunks even when
    // the caller asked for 5_000_000.
    const payload = Buffer.alloc(699_999 * 2, 0x99);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient, sendFn } = createMockCdp({}, { verifySize: payload.length });

    await setPageDataHandler(
      {
        key: "k",
        source: { type: "file", path: "/tmp/p.bin" },
        encoding: "binary",
        chunkSize: 5_000_000, // caller tries to exceed the cap
      },
      cdpClient,
      "s1",
    );

    const evalCalls = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Runtime.evaluate");
    // init (1) + 2 chunks + finalize (1) + verify (1) = 5 calls
    expect(evalCalls).toHaveLength(5);
  });

  it("inline source with base64 encoding decodes payload before chunking", async () => {
    // 1 byte of data encoded as base64 is "AA==". We want to verify the
    // Buffer length matches the decoded bytes (1), not the base64 string length (4).
    const original = Buffer.from([0xab, 0xcd, 0xef]);
    // encoding=base64 → expectedFinalizedSize is the length of the
    // base64 string the page sees. For a 3-byte buffer that's 4 chars
    // (no padding because 3 is a multiple of 3).
    const expectedVerify = original.toString("base64").length;
    const { cdpClient, sendFn } = createMockCdp({}, { verifySize: expectedVerify });

    const result = await setPageDataHandler(
      {
        key: "hex",
        source: { type: "inline", data: original.toString("base64") },
        encoding: "base64",
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("3 bytes");
    // One chunk (3 bytes is well under any chunk size)
    expect(text).toContain("1 chunk");
    expect(sendFn).toHaveBeenCalled();
  });

  it("registers Page.frameNavigated, Runtime.executionContextDestroyed, executionContextsCleared listeners with session scope", async () => {
    const { cdpClient } = createMockCdp({}, { verifySize: 1 });
    const onFn = vi.mocked(cdpClient.on);

    await setPageDataHandler(
      { key: "k", source: { type: "inline", data: "x" } },
      cdpClient,
      "s1",
    );

    const calls = onFn.mock.calls;
    const eventNames = calls.map((c) => c[0]);
    expect(eventNames).toContain("Page.frameNavigated");
    expect(eventNames).toContain("Runtime.executionContextDestroyed");
    expect(eventNames).toContain("Runtime.executionContextsCleared");
    // M3: each listener must subscribe to the same sessionId that the
    // handler is using for its evaluate calls — otherwise events on other
    // sessions would falsely abort this one.
    for (const call of calls) {
      expect(call[2]).toBe("s1");
    }
  });

  it("unregisters all listeners after completion", async () => {
    const { cdpClient } = createMockCdp({}, { verifySize: 1 });
    const offFn = vi.mocked(cdpClient.off);

    await setPageDataHandler(
      { key: "k", source: { type: "inline", data: "x" } },
      cdpClient,
      "s1",
    );

    const eventNames = offFn.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain("Page.frameNavigated");
    expect(eventNames).toContain("Runtime.executionContextDestroyed");
    expect(eventNames).toContain("Runtime.executionContextsCleared");
  });

  it("unregisters listeners even when an error occurs (finally cleanup)", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    sendFn.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame-1" } } };
      }
      if (method === "Runtime.evaluate") {
        // Trigger an error mid-flow so the handler hits the catch branch.
        return {
          result: { type: "undefined" },
          exceptionDetails: { text: "boom", exception: { description: "Error: boom" } },
        };
      }
      return {};
    });
    const offFn = vi.mocked(cdpClient.off);

    const result = await setPageDataHandler(
      { key: "k", source: { type: "inline", data: "x" } },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    const eventNames = offFn.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain("Page.frameNavigated");
    expect(eventNames).toContain("Runtime.executionContextDestroyed");
    expect(eventNames).toContain("Runtime.executionContextsCleared");
  });

  it("aborts when Page.frameNavigated fires for a different main frame mid-chunking", async () => {
    // Use a payload that requires multiple chunks so the listener has time to fire
    const payload = Buffer.alloc(1_500_000, 0xab);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient, fireEvent, sendFn } = createMockCdp();

    // After the init evaluate, simulate a frame navigation by firing the event.
    // Each Runtime.evaluate call increments the counter.
    let callCount = 0;
    sendFn.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame-1" } } };
      }
      if (method === "Runtime.evaluate") {
        callCount++;
        if (callCount === 2) {
          // Simulate frame navigation BEFORE returning from the second
          // evaluate call (after init, mid-chunk-append).
          fireEvent("Page.frameNavigated", { frame: { id: "new-frame", parentId: undefined } });
        }
        return { result: { type: "number", value: callCount } };
      }
      return {};
    });

    const result = await setPageDataHandler(
      {
        key: "k",
        source: { type: "file", path: "/tmp/big.bin" },
        encoding: "binary",
        chunkSize: 500_000,
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("aborted");
    expect((result.content[0] as { text: string }).text).toContain("navigated");
  });

  it("M3: IGNORES Page.frameNavigated for a subframe (parentId set) mid-chunking", async () => {
    const payload = Buffer.alloc(1_500_000, 0xab);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient, fireEvent, sendFn } = createMockCdp({}, { verifySize: payload.length });

    let callCount = 0;
    sendFn.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame-1" } } };
      }
      if (method === "Runtime.evaluate") {
        callCount++;
        if (callCount === 2) {
          // Subframe navigation — must NOT abort.
          fireEvent("Page.frameNavigated", {
            frame: { id: "iframe-1", parentId: "main-frame-1" },
          });
        }
        const expr = (params as { expression?: string } | undefined)?.expression ?? "";
        if (/typeof slot\.byteLength === 'number'/.test(expr)) {
          return { result: { type: "number", value: payload.length } };
        }
        return { result: { type: "number", value: callCount } };
      }
      return {};
    });

    const result = await setPageDataHandler(
      {
        key: "k",
        source: { type: "file", path: "/tmp/big.bin" },
        encoding: "binary",
        chunkSize: 500_000,
      },
      cdpClient,
      "s1",
    );

    // Subframe nav is NOT a reason to abort — the call must succeed.
    expect(result.isError).toBeUndefined();
  });

  it("M3: IGNORES events that target a different sessionId", async () => {
    const payload = Buffer.alloc(1_500_000, 0xab);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient, fireEvent, sendFn } = createMockCdp({}, { verifySize: payload.length });

    let callCount = 0;
    sendFn.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame-1" } } };
      }
      if (method === "Runtime.evaluate") {
        callCount++;
        if (callCount === 2) {
          // Frame navigation in a DIFFERENT session — should not affect us.
          fireEvent(
            "Page.frameNavigated",
            { frame: { id: "another-frame", parentId: undefined } },
            "other-session",
          );
          // Same goes for execution-context destroyed on another session.
          fireEvent("Runtime.executionContextDestroyed", { executionContextId: 99 }, "other-session");
          fireEvent("Runtime.executionContextsCleared", {}, "other-session");
        }
        const expr = (params as { expression?: string } | undefined)?.expression ?? "";
        if (/typeof slot\.byteLength === 'number'/.test(expr)) {
          return { result: { type: "number", value: payload.length } };
        }
        return { result: { type: "number", value: callCount } };
      }
      return {};
    });

    const result = await setPageDataHandler(
      {
        key: "k",
        source: { type: "file", path: "/tmp/big.bin" },
        encoding: "binary",
        chunkSize: 500_000,
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
  });

  it("M3: IGNORES Runtime.executionContextDestroyed without executionContextId payload (malformed event)", async () => {
    const payload = Buffer.alloc(1_500_000, 0xab);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient, fireEvent, sendFn } = createMockCdp({}, { verifySize: payload.length });

    let callCount = 0;
    sendFn.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame-1" } } };
      }
      if (method === "Runtime.evaluate") {
        callCount++;
        if (callCount === 2) {
          // Missing executionContextId — handler should not abort.
          fireEvent("Runtime.executionContextDestroyed", {});
        }
        const expr = (params as { expression?: string } | undefined)?.expression ?? "";
        if (/typeof slot\.byteLength === 'number'/.test(expr)) {
          return { result: { type: "number", value: payload.length } };
        }
        return { result: { type: "number", value: callCount } };
      }
      return {};
    });

    const result = await setPageDataHandler(
      {
        key: "k",
        source: { type: "file", path: "/tmp/big.bin" },
        encoding: "binary",
        chunkSize: 500_000,
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
  });

  it("aborts when Runtime.executionContextDestroyed fires mid-chunking", async () => {
    const payload = Buffer.alloc(1_500_000, 0xcd);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient, fireEvent, sendFn } = createMockCdp();

    let callCount = 0;
    sendFn.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame-1" } } };
      }
      if (method === "Runtime.evaluate") {
        callCount++;
        if (callCount === 2) {
          fireEvent("Runtime.executionContextDestroyed", { executionContextId: 42 });
        }
        return { result: { type: "number", value: callCount } };
      }
      return {};
    });

    const result = await setPageDataHandler(
      {
        key: "k",
        source: { type: "file", path: "/tmp/big.bin" },
        encoding: "binary",
        chunkSize: 500_000,
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("aborted");
    expect((result.content[0] as { text: string }).text).toContain("context");
  });

  it("aborts when Runtime.executionContextsCleared fires mid-chunking", async () => {
    const payload = Buffer.alloc(1_500_000, 0xef);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient, fireEvent, sendFn } = createMockCdp();

    let callCount = 0;
    sendFn.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame-1" } } };
      }
      if (method === "Runtime.evaluate") {
        callCount++;
        if (callCount === 2) {
          fireEvent("Runtime.executionContextsCleared", {});
        }
        return { result: { type: "number", value: callCount } };
      }
      return {};
    });

    const result = await setPageDataHandler(
      {
        key: "k",
        source: { type: "file", path: "/tmp/big.bin" },
        encoding: "binary",
        chunkSize: 500_000,
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("aborted");
  });

  it("propagates Runtime.evaluate exceptions through wrapCdpError", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    sendFn.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame-1" } } };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: { type: "undefined" },
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "TypeError: Cannot assign" },
          },
        };
      }
      return {};
    });

    const result = await setPageDataHandler(
      { key: "k", source: { type: "inline", data: "x" } },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("TypeError");
  });

  it("succeeds when Page.getFrameTree is unavailable (legacy / weird target)", async () => {
    // Some CDP targets do not expose Page domain — the handler must still work,
    // just without the initial frame-id snapshot.
    const { cdpClient, sendFn } = createMockCdp();
    sendFn.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree") {
        throw new Error("'Page.getFrameTree' wasn't found");
      }
      if (method === "Runtime.evaluate") {
        return { result: { type: "number", value: 1 } };
      }
      return {};
    });

    const result = await setPageDataHandler(
      { key: "k", source: { type: "inline", data: "x" } },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
  });

  it("rejects key with injection-attempt characters at schema level (defense-in-depth)", () => {
    // We already test the schema separately, but this confirms the handler
    // path itself cannot be reached with a malicious key — Zod throws on
    // the way in.
    expect(() =>
      setPageDataSchema.parse({
        key: "k'; window.evil=true; '",
        source: { type: "inline", data: "x" },
      }),
    ).toThrow();
  });

  it("H1: verify-size mismatch → isError=true even when chunking otherwise looked OK", async () => {
    // Simulate the silent-truncation bug: chunking completes, finalize
    // returns OK, but the page reports a slot smaller than what we sent.
    // The handler must reject the call instead of falsely "Success".
    const payload = Buffer.alloc(300_000, 0x42);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient, sendFn } = createMockCdp();
    sendFn.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame-1" } } };
      }
      if (method === "Runtime.evaluate") {
        const expr = (params as { expression?: string } | undefined)?.expression ?? "";
        // Verify expression returns a TRUNCATED size → mismatch → throw.
        if (/typeof slot\.byteLength === 'number'/.test(expr)) {
          return { result: { type: "number", value: 1 } };
        }
        return { result: { type: "number", value: 1 } };
      }
      return {};
    });

    const result = await setPageDataHandler(
      {
        key: "k",
        source: { type: "file", path: "/tmp/p.bin" },
        encoding: "binary",
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/verify failed/i);
    expect(text).toContain("300000");
  });

  it("H1: success path reports the verified slot size in the response text", async () => {
    const payload = Buffer.alloc(300_000, 0x42);
    mockLstatSync.mockReturnValue(statsForFile(payload.length));
    mockReadFileSync.mockReturnValue(payload);

    const { cdpClient } = createMockCdp({}, { verifySize: payload.length });

    const result = await setPageDataHandler(
      {
        key: "k",
        source: { type: "file", path: "/tmp/p.bin" },
        encoding: "binary",
      },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`Verified slot size in page: ${payload.length}`);
  });
});
