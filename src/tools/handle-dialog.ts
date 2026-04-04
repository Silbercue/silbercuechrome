import { z } from "zod";
import type { DialogHandler } from "../cdp/dialog-handler.js";
import type { ToolResponse } from "../types.js";

export const handleDialogSchema = z.object({
  action: z.enum(["accept", "dismiss", "get_status"]).describe(
    "accept: accept the next dialog, dismiss: dismiss/cancel it, get_status: check pending dialogs",
  ),
  text: z.string().optional().describe(
    "Text to enter in prompt dialogs (only used with action: accept)",
  ),
});

export type HandleDialogParams = z.infer<typeof handleDialogSchema>;

export async function handleDialogHandler(
  params: HandleDialogParams,
  dialogHandler: DialogHandler,
): Promise<ToolResponse> {
  const start = performance.now();

  switch (params.action) {
    case "accept": {
      const config = {
        autoAccept: true,
        promptText: params.text,
        timeoutMs: 0,
      };
      dialogHandler.pushHandler(config);

      const message = params.text
        ? `Dialog handler configured: next dialog will be accepted with text: '${params.text}'`
        : "Dialog handler configured: next dialog will be accepted";

      return {
        content: [{ type: "text", text: message }],
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "handle_dialog" },
      };
    }

    case "dismiss": {
      dialogHandler.pushHandler({
        autoAccept: false,
        timeoutMs: 0,
      });

      return {
        content: [{ type: "text", text: "Dialog handler configured: next dialog will be dismissed" }],
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "handle_dialog" },
      };
    }

    case "get_status": {
      const notifications = dialogHandler.consumeNotifications();

      if (notifications.length === 0) {
        return {
          content: [{ type: "text", text: "No dialogs occurred" }],
          _meta: { elapsedMs: Math.round(performance.now() - start), method: "handle_dialog" },
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(notifications, null, 2) }],
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "handle_dialog" },
      };
    }
  }
}
