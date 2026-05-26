import { z } from "zod";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import { wrapCdpError } from "./error-utils.js";

/**
 * Story 22.4 — set_page_data.
 *
 * Schreibt grosse Payloads (>1 MB) transparent in den Page-Context und legt
 * sie unter `window.__pb_data[key]` ab. Notwendig, weil Chrome's CDP-
 * WebSocket ein hartes Limit von 1 MB pro Message hat
 * (`kDefaultMaxBufferSize = 1_048_576`, kein Fragmentation-Support). Ein
 * `Runtime.evaluate({ expression: "window.x = '<base64>'" })` mit einer
 * grossen String-Literal bringt die WS-Connection silent zum Abreissen.
 *
 * Strategie: Server splittet die Daten in Chunks von ~500 KB (raw → ~670 KB
 * base64, sicher unter dem 1 MB Limit). Pro Chunk EIN sequenzieller
 * `Runtime.evaluate`-Call (CDP WebSocket ist FIFO — parallele Calls auf
 * denselben `window`-Slot waeren ein Race auf V8-Seite). Erstes evaluate
 * legt den Slot an, mittlere haengen den base64-String an, ein finales
 * evaluate dekodiert ihn (bei `binary` → ArrayBuffer, sonst String) und
 * setzt `window.__pb_data['<key>__complete'] = true`.
 *
 * Race-Detection: Beim Start snapshotten wir die Main-Frame-ID. Wenn
 * `Page.frameNavigated`, `Runtime.executionContextDestroyed` oder
 * `Runtime.executionContextsCleared` waehrend des Chunkings feuert, wird
 * der Loop sofort abgebrochen — die Slot waere sonst nach dem Navigieren
 * leer und die Daten in einem toten Context.
 *
 * Key-Injection: `key` landet im `evaluate`-Expression-String, deshalb
 * strenge Whitelist `^[a-zA-Z_][a-zA-Z0-9_]*$` (Schema-Level).
 */

// --- Schema ---

const KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const sourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inline"),
    data: z.string().describe("The payload as a string (base64 or utf-8)"),
  }),
  z.object({
    type: z.literal("file"),
    path: z.string().describe("Absolute file path — the server reads the file as binary"),
  }),
]);

export const setPageDataSchema = z.object({
  key: z
    .string()
    .regex(
      KEY_REGEX,
      "key must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (JS identifier) — special characters are rejected to prevent injection into the page's evaluate expression",
    )
    .describe("Property name under window.__pb_data (JS identifier — letters, digits, underscore; cannot start with digit)"),
  source: sourceSchema.describe(
    "Where to read the payload from. type 'inline' → pass `data` as a string. type 'file' → pass absolute `path`; the server reads the file as binary.",
  ),
  encoding: z
    .enum(["base64", "utf8", "binary"])
    .optional()
    .describe(
      "Encoding interpretation. 'utf8' (default for inline) keeps the data as a string. 'binary' (default for file) decodes to ArrayBuffer in the page so apps can pass it to FileReader / Blob / fetch body. 'base64' keeps the base64 string as-is (the page can decode it itself).",
    ),
  chunkSize: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Raw bytes per chunk before base64 encoding. Default 500_000 (~670 KB base64, safe under CDP's 1 MB-per-message limit). Capped at 700_000 (~933 KB base64) to leave safety margin.",
    ),
});

export type SetPageDataParams = z.infer<typeof setPageDataSchema>;

// --- Constants ---

/** Default raw chunk size before base64 encoding. ~670 KB base64. */
export const DEFAULT_CHUNK_SIZE = 500_000;

/**
 * Hard cap on chunk size. 700_000 raw → ~933 KB base64, leaves headroom
 * under the 1 MB CDP WebSocket limit even with the wrapping expression
 * overhead.
 */
export const MAX_CHUNK_SIZE = 700_000;

/**
 * Hard cap on file size for the `file` source (100 MB). Prevents OOM / DoS
 * via a tool call that points at a multi-gigabyte file. The page itself
 * would not survive larger payloads anyway (each chunk = ~1 MB CDP message,
 * 100 MB = 100+ sequential round-trips already at the practical limit).
 */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

// --- Helpers ---

/**
 * Reads the source into a Buffer. Throws for path errors so the handler
 * can return a structured error response BEFORE any CDP calls run.
 */
export function readSource(
  source: SetPageDataParams["source"],
  encoding: SetPageDataParams["encoding"],
): Buffer {
  if (source.type === "inline") {
    const enc = encoding ?? "utf8";
    if (enc === "base64") {
      return Buffer.from(source.data, "base64");
    }
    if (enc === "binary") {
      // Inline + binary: the data is interpreted as raw bytes encoded as
      // a JS string. The most common path is base64 — fall back to that.
      return Buffer.from(source.data, "base64");
    }
    return Buffer.from(source.data, "utf8");
  }
  // file source
  if (!isAbsolute(source.path)) {
    const err: NodeJS.ErrnoException = Object.assign(
      new Error(`Relative path not allowed: "${source.path}". Please use an absolute path (e.g. /Users/…/file.bin).`),
      { code: "ERR_RELATIVE_PATH" },
    );
    throw err;
  }
  // Use lstatSync so we (a) detect symlinks via isFile()===false, (b) avoid
  // the TOCTOU race between existsSync + readFileSync, and (c) capture the
  // size BEFORE reading so we can enforce MAX_FILE_SIZE. lstat surfaces the
  // ENOENT directly with a clear errno; we normalize the message for the
  // user-facing case.
  let stat;
  try {
    stat = lstatSync(source.path);
  } catch (statErr) {
    const code = (statErr as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      const err: NodeJS.ErrnoException = Object.assign(
        new Error(`File not found: ${source.path}`),
        { code: "ENOENT" },
      );
      throw err;
    }
    throw statErr;
  }
  if (!stat.isFile()) {
    // Symlinks, directories, device nodes, FIFOs, sockets — all rejected.
    // Symlinks could point at /dev/zero (infinite read) or /etc/shadow
    // (info leak); device files block on read. Regular files only.
    const err: NodeJS.ErrnoException = Object.assign(
      new Error(`Not a regular file: ${source.path} (symlinks, directories, devices and FIFOs are rejected).`),
      { code: "ERR_NOT_A_FILE" },
    );
    throw err;
  }
  if (stat.size > MAX_FILE_SIZE) {
    const err: NodeJS.ErrnoException = Object.assign(
      new Error(
        `File too large: ${stat.size.toLocaleString("en-US")} bytes exceeds the ${MAX_FILE_SIZE.toLocaleString("en-US")}-byte (100 MB) cap. Split the payload or stream it differently.`,
      ),
      { code: "ERR_FILE_TOO_LARGE" },
    );
    throw err;
  }
  return readFileSync(source.path);
}

/**
 * Splits a Buffer into chunks. Each non-final chunk is sized to a multiple
 * of 3 raw bytes so its base64 encoding has NO padding (`=`) characters —
 * critical because the server concatenates the per-chunk base64 strings
 * server-side AND the page re-concatenates them via `+=`. If any non-final
 * chunk had padding in the middle of the resulting stream, `atob` /
 * `Uint8Array.fromBase64` would throw "Invalid character" or `Buffer.from
 * (_, 'base64')` would silently truncate at the first `=`. Only the final
 * chunk is allowed to have padding because it is the end of the stream.
 *
 * Caller passes a "max raw bytes per chunk" budget; we round down to the
 * next multiple of 3 (e.g. 500_000 → 499_998 = 166_666 * 3). The trailing
 * chunk takes whatever bytes remain and may be smaller (and the only one
 * whose base64 encoding may include padding).
 */
export function chunkBuffer(buf: Buffer, maxChunkSize: number): Buffer[] {
  if (buf.length === 0) return [Buffer.alloc(0)];
  // Round down to a multiple of 3 raw bytes — see doc comment above.
  const chunkSize = Math.max(3, Math.floor(maxChunkSize / 3) * 3);
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunkSize) {
    chunks.push(buf.subarray(i, Math.min(i + chunkSize, buf.length)));
  }
  return chunks;
}

/**
 * Determines the effective encoding for the destination slot. Inline
 * sources default to utf8; file sources default to binary.
 */
export function resolveEncoding(
  source: SetPageDataParams["source"],
  encoding: SetPageDataParams["encoding"],
): "base64" | "utf8" | "binary" {
  if (encoding) return encoding;
  return source.type === "file" ? "binary" : "utf8";
}

interface RuntimeEvaluateResult {
  result: { type: string; value?: unknown };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

interface FrameTree {
  frameTree: { frame: { id: string } };
}

/**
 * Builds the JavaScript expression for finalizing the slot. base64 → string
 * or ArrayBuffer depending on encoding.
 *
 * Uses `Uint8Array.fromBase64()` when available (Chrome 130+) and falls back
 * to `atob` + charCodeAt loop for older Chromes.
 */
export function buildFinalizeExpression(key: string, encoding: "base64" | "utf8" | "binary"): string {
  if (encoding === "binary") {
    // Decode the accumulated base64 string into a Uint8Array, then expose
    // its ArrayBuffer (apps can wrap it in a Blob/File without an extra
    // copy). The Uint8Array.fromBase64 path is the fast modern API; the
    // atob path is a defensive fallback so the tool works in any Chrome
    // the user might be attached to.
    return `(function(){
      var slot = window.__pb_data['${key}'];
      var u8;
      if (typeof Uint8Array.fromBase64 === 'function') {
        u8 = Uint8Array.fromBase64(slot);
      } else {
        var bin = atob(slot);
        u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      }
      window.__pb_data['${key}'] = u8.buffer;
      window.__pb_data['${key}__complete'] = true;
      return u8.buffer.byteLength;
    })()`;
  }
  if (encoding === "utf8") {
    // The slot still holds the accumulated base64 string of the utf-8
    // bytes — decode it once into the original UTF-8 string so apps see
    // the readable content.
    return `(function(){
      var slot = window.__pb_data['${key}'];
      var bin = atob(slot);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      window.__pb_data['${key}'] = new TextDecoder('utf-8').decode(bytes);
      window.__pb_data['${key}__complete'] = true;
      return window.__pb_data['${key}'].length;
    })()`;
  }
  // base64: keep the accumulated base64 string as-is.
  return `(function(){
    window.__pb_data['${key}__complete'] = true;
    return window.__pb_data['${key}'].length;
  })()`;
}

/**
 * Builds the init expression. Ensures `window.__pb_data` exists and resets
 * the target slot to an empty string + clears the `__complete` flag.
 */
export function buildInitExpression(key: string): string {
  return `(function(){
    (window.__pb_data = window.__pb_data || {});
    window.__pb_data['${key}'] = '';
    window.__pb_data['${key}__complete'] = false;
    return true;
  })()`;
}

/**
 * Builds the chunk-append expression. Appends one base64-encoded chunk to
 * the slot. Sequential — caller awaits each call.
 */
export function buildAppendExpression(key: string, chunkB64: string): string {
  return `(function(){
    window.__pb_data['${key}'] += '${chunkB64}';
    return window.__pb_data['${key}'].length;
  })()`;
}

/**
 * Builds the verify expression. Re-reads `window.__pb_data[key]` and reports
 * its observable size (ArrayBuffer.byteLength, String.length depending on
 * encoding). Server compares against the expected value to catch silent
 * truncation / encoding mismatches before declaring success.
 */
export function buildVerifyExpression(key: string): string {
  return `(function(){
    var slot = window.__pb_data['${key}'];
    if (slot && typeof slot === 'object' && typeof slot.byteLength === 'number') return slot.byteLength;
    if (typeof slot === 'string') return slot.length;
    return -1;
  })()`;
}

/**
 * Computes the expected size of the finalized slot in the page so the
 * server can verify the roundtrip after `finalize`.
 *
 * - `binary` → ArrayBuffer.byteLength = raw buffer length
 * - `utf8`   → decoded string's `.length` (UTF-16 code units) — for non-
 *              ASCII payloads this is NOT the same as the byte length, so
 *              we decode here to get the authoritative value
 * - `base64` → length of the base64 string (= what the page sees, since we
 *              never decode for the `base64` encoding)
 */
export function expectedFinalizedSize(
  buf: Buffer,
  encoding: "base64" | "utf8" | "binary",
): number {
  if (encoding === "binary") return buf.length;
  if (encoding === "utf8") return buf.toString("utf8").length;
  // base64: server-side concatenation produces the same string the page sees.
  return buf.toString("base64").length;
}

class FrameInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameInvalidatedError";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// --- Main handler ---

export async function setPageDataHandler(
  params: SetPageDataParams,
  cdpClient: CdpClient,
  sessionId?: string,
): Promise<ToolResponse> {
  const start = performance.now();
  const method = "set_page_data";

  // 1. Read + validate the source BEFORE any CDP calls.
  let buf: Buffer;
  try {
    buf = readSource(params.source, params.encoding);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      _meta: { elapsedMs: Math.round(performance.now() - start), method },
    };
  }

  const encoding = resolveEncoding(params.source, params.encoding);
  // Cap chunk size to the hard limit so an aggressive caller cannot punch
  // through the safety margin.
  const requestedChunk = params.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkSize = Math.min(Math.max(requestedChunk, 1), MAX_CHUNK_SIZE);
  const chunks = chunkBuffer(buf, chunkSize);

  // 2. Snapshot the current main-frame id so we can detect a navigation
  // race during chunking.
  let initialFrameId: string | undefined;
  try {
    const tree = await cdpClient.send<FrameTree>("Page.getFrameTree", {}, sessionId);
    initialFrameId = tree.frameTree.frame.id;
  } catch {
    // Page domain may not be available (legacy test path / weird target).
    // Continue without frame-race detection — the event handlers below
    // still trip on context-destroyed / context-cleared.
  }

  // 3. Wire navigation-race + context-destroyed listeners. These flip a
  // shared abort flag that the chunk-loop checks after every call.
  let aborted = false;
  let abortReason = "";

  type FrameNavigatedParams = { frame?: { id?: string; parentId?: string } };
  type ExecCtxDestroyedParams = { executionContextId?: number };

  const onFrameNavigated = (raw: unknown): void => {
    const p = raw as FrameNavigatedParams | undefined;
    const frame = p?.frame;
    if (!frame || !frame.id) return;
    // Main frame only (no parentId). Sub-frame navigations do not invalidate
    // window.__pb_data on the main document.
    if (frame.parentId) return;
    if (initialFrameId && frame.id === initialFrameId) {
      // Same frame, but Page.frameNavigated also fires for in-frame doc
      // swaps (e.g. cross-origin redirects keep the same frameId). When the
      // ordering of frameNavigated vs executionContext events is not
      // deterministic, we treat the frameNavigated event itself as the
      // signal of a hard nav.
      aborted = true;
      abortReason = `page navigated during chunking (frameId ${frame.id}, same id but new document)`;
      return;
    }
    aborted = true;
    abortReason = `page navigated during chunking (frameId changed to ${frame.id})`;
  };

  const onExecCtxDestroyed = (raw: unknown): void => {
    const p = raw as ExecCtxDestroyedParams | undefined;
    if (p?.executionContextId === undefined) return;
    aborted = true;
    abortReason = "execution context destroyed during chunking";
  };

  const onExecCtxCleared = (): void => {
    aborted = true;
    abortReason = "all execution contexts cleared during chunking";
  };

  cdpClient.on("Page.frameNavigated", onFrameNavigated, sessionId);
  cdpClient.on("Runtime.executionContextDestroyed", onExecCtxDestroyed, sessionId);
  cdpClient.on("Runtime.executionContextsCleared", onExecCtxCleared, sessionId);

  try {
    // 4. Init the slot (sequential — never parallel; the FIFO contract
    // on the WS guarantees ordering, parallel writes to the same slot
    // would race in V8).
    await runEvaluate(cdpClient, sessionId, buildInitExpression(params.key));
    if (aborted) throw new FrameInvalidatedError(abortReason);

    // 5. Append each chunk as base64 — same encoding for all paths;
    // the finalize expression handles the decode.
    let totalAppended = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunkB64 = chunks[i].toString("base64");
      await runEvaluate(cdpClient, sessionId, buildAppendExpression(params.key, chunkB64));
      totalAppended += chunks[i].length;
      if (aborted) throw new FrameInvalidatedError(abortReason);
    }

    // 6. Finalize — decode the slot (binary → ArrayBuffer, utf8 → String,
    // base64 → keep) and mark __complete = true.
    await runEvaluate(
      cdpClient,
      sessionId,
      buildFinalizeExpression(params.key, encoding),
    );

    // 7. Verify — re-read the slot size from the page and compare it
    // against the server-side expected value. This catches silent
    // truncation (e.g. `Buffer.from(_, 'base64')` stopping at the first
    // `=`), atob exceptions that left the slot in a half-decoded state,
    // and any future regressions in the chunking math. Throw on mismatch
    // so the tool reports `isError: true` instead of falsely "Success".
    const verifyResult = await runEvaluate(
      cdpClient,
      sessionId,
      buildVerifyExpression(params.key),
    );
    const actualSize = typeof verifyResult === "number" ? verifyResult : -1;
    const expectedSize = expectedFinalizedSize(buf, encoding);
    if (actualSize !== expectedSize) {
      throw new Error(
        `set_page_data verify failed: expected ${encoding === "binary" ? `${expectedSize} bytes` : `${expectedSize} chars`} in window.__pb_data['${params.key}'], got ${actualSize}. The page slot is in an inconsistent state — the chunked write did not round-trip correctly. Encoding=${encoding}, chunks=${chunks.length}.`,
      );
    }

    const elapsedMs = Math.round(performance.now() - start);
    const chunkWord = chunks.length === 1 ? "chunk" : "chunks";

    return {
      content: [
        {
          type: "text",
          text: `Wrote ${formatBytes(buf.length)} (${buf.length.toLocaleString("en-US")} bytes) to window.__pb_data['${params.key}'] in ${chunks.length} ${chunkWord} (${elapsedMs} ms). Encoding: ${encoding}. Verified slot size in page: ${actualSize}. Check window.__pb_data['${params.key}__complete'] === true to confirm.`,
        },
      ],
      _meta: {
        elapsedMs,
        method,
        bytesWritten: buf.length,
        chunks: chunks.length,
        encoding,
      },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    if (err instanceof FrameInvalidatedError) {
      return {
        content: [
          {
            type: "text",
            text: `set_page_data aborted: ${err.message}. The page navigated (or its execution context was torn down) while data was being chunked — window.__pb_data may be partial or gone. Retry after the new page has settled, or wrap set_page_data + the consumer call in a single sequence without intervening navigation.`,
          },
        ],
        isError: true,
        _meta: { elapsedMs, method },
      };
    }
    return {
      content: [{ type: "text", text: wrapCdpError(err, method) }],
      isError: true,
      _meta: { elapsedMs, method },
    };
  } finally {
    cdpClient.off("Page.frameNavigated", onFrameNavigated);
    cdpClient.off("Runtime.executionContextDestroyed", onExecCtxDestroyed);
    cdpClient.off("Runtime.executionContextsCleared", onExecCtxCleared);
  }
}

/**
 * Sends one `Runtime.evaluate` call and unwraps the result. Throws on a
 * JS exception — the caller decides whether to treat that as fatal or
 * recoverable.
 */
async function runEvaluate(
  cdpClient: CdpClient,
  sessionId: string | undefined,
  expression: string,
): Promise<unknown> {
  const res = await cdpClient.send<RuntimeEvaluateResult>(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
    },
    sessionId,
  );
  if (res.exceptionDetails) {
    const desc =
      res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    throw new Error(`Runtime.evaluate threw: ${desc}`);
  }
  return res.result.value;
}
