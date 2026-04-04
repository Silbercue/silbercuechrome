import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { wrapCdpError } from "./error-utils.js";

// --- Schema (Task 1.1) ---

export const fileUploadSchema = z.object({
  ref: z
    .string()
    .optional()
    .describe("A11y-Tree element ref (e.g. 'e8') — preferred over selector"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector (e.g. 'input[type=file]') — fallback when ref is not available"),
  path: z
    .union([z.string(), z.array(z.string()).min(1)])
    .describe("Absolute file path(s) to upload. String for single file, array for multiple files."),
});

export type FileUploadParams = z.infer<typeof fileUploadSchema>;

// --- Helpers (Task 1.3) ---

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Main handler (Task 1.2) ---

export async function fileUploadHandler(
  params: FileUploadParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

  // Step 1: Validate ref/selector — at least one must be provided
  if (!params.ref && !params.selector) {
    return {
      content: [
        {
          type: "text",
          text: "file_upload requires either 'ref' or 'selector' to identify the target element",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "file_upload" },
    };
  }

  // Step 2: Normalize paths — string or array → always string[]
  const filePaths = Array.isArray(params.path) ? params.path : [params.path];

  // Step 2b: Validate all paths are absolute
  for (const filePath of filePaths) {
    if (!isAbsolute(filePath)) {
      const elapsedMs = Math.round(performance.now() - start);
      return {
        content: [
          {
            type: "text",
            text: `Relativer Pfad nicht erlaubt: "${filePath}". Bitte absoluten Pfad verwenden (z.B. /Users/…/datei.pdf).`,
          },
        ],
        isError: true,
        _meta: { elapsedMs, method: "file_upload" },
      };
    }
  }

  // Step 3: Validate all file paths exist BEFORE any CDP calls
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) {
      const elapsedMs = Math.round(performance.now() - start);
      return {
        content: [
          {
            type: "text",
            text: `Datei nicht gefunden: ${filePath}`,
          },
        ],
        isError: true,
        _meta: { elapsedMs, method: "file_upload" },
      };
    }
  }

  try {
    // Step 4: Resolve element (ref preferred over selector, with OOPIF routing)
    const target = params.ref ? { ref: params.ref } : { selector: params.selector };
    const element = await resolveElement(cdpClient, sessionId!, target, sessionManager);
    const targetSession = element.resolvedSessionId;

    // Step 5: File-Input validation — check if element is <input type="file">
    const tagCheck = await cdpClient.send<{ result: { value: string } }>(
      "Runtime.callFunctionOn",
      {
        objectId: element.objectId,
        functionDeclaration: `function() {
          return this.tagName + '|' + this.type;
        }`,
        returnByValue: true,
      },
      targetSession,
    );
    const [tagName, inputType] = tagCheck.result.value.split("|");

    if (tagName !== "INPUT" || inputType !== "file") {
      // Search for nearest file input in DOM for helpful error message
      const hint = await cdpClient.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const fi = document.querySelector('input[type=file]');
            if (!fi) return '';
            return fi.name || fi.id || fi.getAttribute('aria-label') || 'unnamed';
          })()`,
          returnByValue: true,
        },
        targetSession,
      );

      const elapsedMs = Math.round(performance.now() - start);
      let errorText = `Element ${params.ref ?? params.selector} ist kein File-Input (${tagName.toLowerCase()} ${inputType || ""}).`;
      if (hint.result.value) {
        errorText += ` Naechstes File-Input im DOM: ${hint.result.value}`;
      }
      return {
        content: [{ type: "text", text: errorText.trimEnd() }],
        isError: true,
        _meta: { elapsedMs, method: "file_upload" },
      };
    }

    // Step 6: Multiple-validation — reject multiple files when input doesn't have multiple attribute
    if (filePaths.length > 1) {
      const multiCheck = await cdpClient.send<{ result: { value: boolean } }>(
        "Runtime.callFunctionOn",
        {
          objectId: element.objectId,
          functionDeclaration: "function() { return this.multiple; }",
          returnByValue: true,
        },
        targetSession,
      );

      if (!multiCheck.result.value) {
        const elapsedMs = Math.round(performance.now() - start);
        return {
          content: [
            {
              type: "text",
              text: "File-Input akzeptiert keine mehrfachen Dateien (multiple nicht gesetzt). Nur eine Datei hochladen.",
            },
          ],
          isError: true,
          _meta: { elapsedMs, method: "file_upload" },
        };
      }
    }

    // Step 7: Execute upload via CDP DOM.setFileInputFiles
    await cdpClient.send(
      "DOM.setFileInputFiles",
      { files: filePaths, backendNodeId: element.backendNodeId },
      targetSession,
    );

    // Step 8: Get file sizes and build success response
    const fileDetails = filePaths.map((fp) => {
      const size = statSync(fp).size;
      return `- ${basename(fp)} (${formatFileSize(size)})`;
    });

    const elapsedMs = Math.round(performance.now() - start);
    const displayName = element.name
      ? `${element.role} '${element.name}'`
      : (params.ref ?? params.selector);
    const fileWord = filePaths.length === 1 ? "file" : "files";

    return {
      content: [
        {
          type: "text",
          text: `Uploaded ${filePaths.length} ${fileWord} to ${displayName}:\n${fileDetails.join("\n")}`,
        },
      ],
      _meta: { elapsedMs, method: "file_upload" },
    };
  } catch (err) {
    // RefNotFoundError — contextual error with "did you mean?" suggestion
    if (err instanceof RefNotFoundError && params.ref) {
      const errorText = buildRefNotFoundError(params.ref);
      return {
        content: [{ type: "text", text: errorText }],
        isError: true,
        _meta: { elapsedMs: 0, method: "file_upload" },
      };
    }

    // CDP connection errors — wrap for user-friendly message (consistent with other tools)
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "file_upload") }],
      isError: true,
      _meta: { elapsedMs, method: "file_upload" },
    };
  }
}
