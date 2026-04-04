import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileUploadSchema, fileUploadHandler, formatFileSize } from "./file-upload.js";
import type { FileUploadParams } from "./file-upload.js";
import type { CdpClient } from "../cdp/cdp-client.js";

// --- Mock element-utils ---

vi.mock("./element-utils.js", () => {
  class RefNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RefNotFoundError";
    }
  }
  return {
    resolveElement: vi.fn(),
    buildRefNotFoundError: vi.fn(),
    RefNotFoundError,
  };
});

import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
const mockResolveElement = vi.mocked(resolveElement);
const mockBuildRefNotFoundError = vi.mocked(buildRefNotFoundError);

// --- Mock node:fs ---

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

import { existsSync, statSync } from "node:fs";
const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);

// --- Mock CDP client ---

type EventCallback = (params: unknown, sessionId?: string) => void;

interface MockCdpSetup {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
}

function createMockCdp(overrides: Record<string, unknown> = {}): MockCdpSetup {
  const defaultResponses: Record<string, unknown> = {
    "Runtime.callFunctionOn": { result: { value: "INPUT|file" } },
    "Runtime.evaluate": { result: { value: "" } },
    "DOM.setFileInputFiles": {},
    ...overrides,
  };

  const listeners = new Map<string, Set<{ callback: EventCallback; sessionId?: string }>>();

  const sendFn = vi.fn(async (method: string) => {
    if (method in defaultResponses) {
      const val = defaultResponses[method];
      if (typeof val === "function") return (val as () => unknown)();
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

  return { cdpClient, sendFn };
}

// --- Helper: default resolved file input element ---

function mockFileInput(
  overrides: Partial<{
    backendNodeId: number;
    objectId: string;
    role: string;
    name: string;
    resolvedSessionId: string;
    resolvedVia: "ref" | "css";
  }> = {},
) {
  return {
    backendNodeId: 42,
    objectId: "obj-42",
    role: "button",
    name: "Upload",
    resolvedVia: "ref" as const,
    resolvedSessionId: "s1",
    ...overrides,
  };
}

// ============================================================
// Schema tests
// ============================================================

describe("fileUploadSchema", () => {
  it("should accept ref + single path", () => {
    const result = fileUploadSchema.parse({ ref: "e8", path: "/tmp/test.pdf" });
    expect(result.ref).toBe("e8");
    expect(result.path).toBe("/tmp/test.pdf");
  });

  it("should accept selector + path array", () => {
    const result = fileUploadSchema.parse({
      selector: "input[type=file]",
      path: ["/tmp/a.pdf", "/tmp/b.jpg"],
    });
    expect(result.selector).toBe("input[type=file]");
    expect(result.path).toEqual(["/tmp/a.pdf", "/tmp/b.jpg"]);
  });

  it("should require path", () => {
    expect(() => fileUploadSchema.parse({ ref: "e8" })).toThrow();
  });

  it("should reject empty path array", () => {
    expect(() => fileUploadSchema.parse({ ref: "e8", path: [] })).toThrow();
  });
});

// ============================================================
// formatFileSize tests
// ============================================================

describe("formatFileSize", () => {
  it("formats bytes correctly", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
  });

  it("formats KB correctly", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(460800)).toBe("450.0 KB");
  });

  it("formats MB correctly", () => {
    expect(formatFileSize(1048576)).toBe("1.0 MB");
    expect(formatFileSize(2202009)).toBe("2.1 MB");
  });
});

// ============================================================
// Handler tests
// ============================================================

describe("fileUploadHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Validation tests ---

  it("returns error when neither ref nor selector provided", async () => {
    const { cdpClient } = createMockCdp();
    const result = await fileUploadHandler(
      { path: "/tmp/test.pdf" } as FileUploadParams,
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("file_upload requires either 'ref' or 'selector'"),
      }),
    );
    expect(result._meta?.elapsedMs).toBe(0);
    expect(result._meta?.method).toBe("file_upload");
  });

  // --- File path validation tests (AC #4) ---

  it("returns error when file path does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const { cdpClient } = createMockCdp();

    const result = await fileUploadHandler(
      { ref: "e8", path: "/tmp/test.pdf" },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "Datei nicht gefunden: /tmp/test.pdf",
      }),
    );
    expect(result._meta?.method).toBe("file_upload");
  });

  it("validates all file paths before upload", async () => {
    // First file exists, second does not
    mockExistsSync.mockImplementation((p) => p === "/tmp/a.pdf");
    const { cdpClient, sendFn } = createMockCdp();

    const result = await fileUploadHandler(
      { ref: "e8", path: ["/tmp/a.pdf", "/tmp/missing.pdf", "/tmp/c.pdf"] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "Datei nicht gefunden: /tmp/missing.pdf",
      }),
    );
    // Upload should NOT have been executed
    const uploadCalls = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "DOM.setFileInputFiles",
    );
    expect(uploadCalls).toHaveLength(0);
  });

  // --- Single file upload tests (AC #1) ---

  it("uploads single file via ref to file input", async () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 1258291 } as ReturnType<typeof statSync>);
    mockResolveElement.mockResolvedValue(mockFileInput());
    const { cdpClient, sendFn } = createMockCdp();

    const result = await fileUploadHandler(
      { ref: "e8", path: "/tmp/test.pdf" },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Uploaded 1 file"),
      }),
    );
    expect((result.content[0] as { text: string }).text).toContain("test.pdf");
    expect((result.content[0] as { text: string }).text).toContain("1.2 MB");
    expect(result._meta?.method).toBe("file_upload");

    // Verify DOM.setFileInputFiles was called with correct params
    expect(sendFn).toHaveBeenCalledWith(
      "DOM.setFileInputFiles",
      { files: ["/tmp/test.pdf"], backendNodeId: 42 },
      "s1",
    );
  });

  it("uploads single file via CSS selector", async () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 5120 } as ReturnType<typeof statSync>);
    mockResolveElement.mockResolvedValue(
      mockFileInput({ resolvedVia: "css", role: "", name: "" }),
    );
    const { cdpClient } = createMockCdp();

    const result = await fileUploadHandler(
      { selector: "input[type=file]", path: "/tmp/doc.csv" },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("Uploaded 1 file to input[type=file]");
    expect((result.content[0] as { text: string }).text).toContain("doc.csv");
    expect((result.content[0] as { text: string }).text).toContain("5.0 KB");

    expect(mockResolveElement).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      { selector: "input[type=file]" },
      undefined,
    );
  });

  // --- Multiple file upload tests (AC #2) ---

  it("uploads multiple files when input has multiple attribute", async () => {
    mockExistsSync.mockReturnValue(true);
    const sizes: Record<string, number> = {
      "/tmp/report.pdf": 2202009,
      "/tmp/photo.jpg": 460800,
      "/tmp/data.csv": 12288,
    };
    mockStatSync.mockImplementation(
      (p) => ({ size: sizes[p as string] || 0 }) as ReturnType<typeof statSync>,
    );
    mockResolveElement.mockResolvedValue(mockFileInput());

    // sendFn needs to return different values for different Runtime.callFunctionOn calls
    let callFnCount = 0;
    const { cdpClient, sendFn } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        callFnCount++;
        // First call: tagName check → INPUT|file
        if (callFnCount === 1) return { result: { value: "INPUT|file" } };
        // Second call: multiple check → true
        return { result: { value: true } };
      },
    });

    const result = await fileUploadHandler(
      { ref: "e8", path: ["/tmp/report.pdf", "/tmp/photo.jpg", "/tmp/data.csv"] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Uploaded 3 files");
    expect(text).toContain("report.pdf (2.1 MB)");
    expect(text).toContain("photo.jpg (450.0 KB)");
    expect(text).toContain("data.csv (12.0 KB)");

    // Verify DOM.setFileInputFiles was called with all 3 paths
    expect(sendFn).toHaveBeenCalledWith(
      "DOM.setFileInputFiles",
      {
        files: ["/tmp/report.pdf", "/tmp/photo.jpg", "/tmp/data.csv"],
        backendNodeId: 42,
      },
      "s1",
    );
  });

  it("returns error when multiple files but input not multiple", async () => {
    mockExistsSync.mockReturnValue(true);
    mockResolveElement.mockResolvedValue(mockFileInput());

    let callFnCount = 0;
    const { cdpClient } = createMockCdp({
      "Runtime.callFunctionOn": () => {
        callFnCount++;
        if (callFnCount === 1) return { result: { value: "INPUT|file" } };
        return { result: { value: false } };
      },
    });

    const result = await fileUploadHandler(
      { ref: "e8", path: ["/tmp/a.pdf", "/tmp/b.pdf"] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("multiple"),
      }),
    );
  });

  // --- Element type validation tests (AC #3) ---

  it("returns error when element is not a file input", async () => {
    mockExistsSync.mockReturnValue(true);
    mockResolveElement.mockResolvedValue(mockFileInput());
    const { cdpClient } = createMockCdp({
      "Runtime.callFunctionOn": { result: { value: "DIV|" } },
    });

    const result = await fileUploadHandler(
      { ref: "e8", path: "/tmp/test.pdf" },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("kein File-Input");
    expect((result.content[0] as { text: string }).text).toContain("div");
  });

  it("returns contextual error with nearest file input hint", async () => {
    mockExistsSync.mockReturnValue(true);
    mockResolveElement.mockResolvedValue(mockFileInput());
    const { cdpClient } = createMockCdp({
      "Runtime.callFunctionOn": { result: { value: "BUTTON|submit" } },
      "Runtime.evaluate": { result: { value: "document-upload" } },
    });

    const result = await fileUploadHandler(
      { ref: "e8", path: "/tmp/test.pdf" },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("kein File-Input");
    expect(text).toContain("document-upload");
  });

  // --- RefNotFoundError tests ---

  it("returns error for stale ref (node removed from DOM)", async () => {
    mockExistsSync.mockReturnValue(true);
    mockResolveElement.mockRejectedValue(
      new RefNotFoundError("Element e8 not found (stale ref)."),
    );
    mockBuildRefNotFoundError.mockReturnValue(
      "Element e8 not found. Did you mean e12 (button 'Upload')?",
    );
    const { cdpClient } = createMockCdp();

    const result = await fileUploadHandler(
      { ref: "e8", path: "/tmp/test.pdf" },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "Element e8 not found. Did you mean e12 (button 'Upload')?",
      }),
    );
    expect(mockBuildRefNotFoundError).toHaveBeenCalledWith("e8");
  });

  // --- CDP connection error tests (wrapCdpError integration) ---

  it("wraps CdpClient-closed error via wrapCdpError", async () => {
    mockExistsSync.mockReturnValue(true);
    mockResolveElement.mockRejectedValue(new Error("CdpClient is closed"));
    const { cdpClient } = createMockCdp();

    const result = await fileUploadHandler(
      { ref: "e8", path: "/tmp/test.pdf" },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(
      "CDP connection lost. The server is attempting to reconnect. Retry your request in a few seconds.",
    );
  });

  it("wraps Transport-closed error via wrapCdpError", async () => {
    mockExistsSync.mockReturnValue(true);
    mockResolveElement.mockRejectedValue(new Error("Transport closed unexpectedly"));
    const { cdpClient } = createMockCdp();

    const result = await fileUploadHandler(
      { ref: "e8", path: "/tmp/test.pdf" },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(
      "CDP connection lost. The server is attempting to reconnect. Retry your request in a few seconds.",
    );
  });

  it("wraps unknown CDP error with tool name via wrapCdpError", async () => {
    mockExistsSync.mockReturnValue(true);
    mockResolveElement.mockRejectedValue(new Error("Something unexpected"));
    const { cdpClient } = createMockCdp();

    const result = await fileUploadHandler(
      { ref: "e8", path: "/tmp/test.pdf" },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(
      "file_upload failed: Something unexpected",
    );
  });

  // --- Relative path validation tests (M1) ---

  it("returns error for relative path (single string)", async () => {
    const { cdpClient } = createMockCdp();

    const result = await fileUploadHandler(
      { ref: "e8", path: "relative/test.pdf" },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Relativer Pfad nicht erlaubt");
    expect((result.content[0] as { text: string }).text).toContain("relative/test.pdf");
    expect((result.content[0] as { text: string }).text).toContain("absoluten Pfad");
  });

  it("returns error for relative path in array", async () => {
    const { cdpClient } = createMockCdp();

    const result = await fileUploadHandler(
      { ref: "e8", path: ["/tmp/ok.pdf", "docs/relative.pdf"] },
      cdpClient,
      "s1",
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Relativer Pfad nicht erlaubt");
    expect((result.content[0] as { text: string }).text).toContain("docs/relative.pdf");
  });
});
