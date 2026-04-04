import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDialogHandler } from "./handle-dialog.js";
import type { DialogHandler, DialogEvent } from "../cdp/dialog-handler.js";

// --- Mock DialogHandler ---

function createMockDialogHandler(): {
  dialogHandler: DialogHandler;
  pushHandler: ReturnType<typeof vi.fn>;
  consumeNotifications: ReturnType<typeof vi.fn>;
} {
  const pushHandler = vi.fn();
  const consumeNotifications = vi.fn<[], DialogEvent[]>().mockReturnValue([]);

  const dialogHandler = {
    pushHandler,
    popHandler: vi.fn(),
    consumeNotifications,
    pendingCount: 0,
    init: vi.fn(),
    detach: vi.fn(),
    reinit: vi.fn(),
  } as unknown as DialogHandler;

  return { dialogHandler, pushHandler, consumeNotifications };
}

describe("handleDialogHandler", () => {
  let mock: ReturnType<typeof createMockDialogHandler>;

  beforeEach(() => {
    mock = createMockDialogHandler();
  });

  it("action accept pushes autoAccept handler", async () => {
    const result = await handleDialogHandler(
      { action: "accept" },
      mock.dialogHandler,
    );

    expect(mock.pushHandler).toHaveBeenCalledWith({
      autoAccept: true,
      promptText: undefined,
      timeoutMs: 0,
    });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("accepted");
  });

  it("action accept with text pushes handler with promptText", async () => {
    const result = await handleDialogHandler(
      { action: "accept", text: "My Answer" },
      mock.dialogHandler,
    );

    expect(mock.pushHandler).toHaveBeenCalledWith({
      autoAccept: true,
      promptText: "My Answer",
      timeoutMs: 0,
    });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("My Answer");
  });

  it("action dismiss pushes autoAccept=false handler", async () => {
    const result = await handleDialogHandler(
      { action: "dismiss" },
      mock.dialogHandler,
    );

    expect(mock.pushHandler).toHaveBeenCalledWith({
      autoAccept: false,
      timeoutMs: 0,
    });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("dismissed");
  });

  it("action get_status returns pending notifications", async () => {
    const dialogEvents: DialogEvent[] = [
      { type: "alert", message: "Hello!", url: "https://example.com" },
      { type: "confirm", message: "Sure?", url: "https://example.com" },
    ];
    mock.consumeNotifications.mockReturnValueOnce(dialogEvents);

    const result = await handleDialogHandler(
      { action: "get_status" },
      mock.dialogHandler,
    );

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe("alert");
    expect(parsed[1].type).toBe("confirm");
  });

  it("action get_status returns empty message when no dialogs", async () => {
    mock.consumeNotifications.mockReturnValueOnce([]);

    const result = await handleDialogHandler(
      { action: "get_status" },
      mock.dialogHandler,
    );

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toBe("No dialogs occurred");
  });
});
