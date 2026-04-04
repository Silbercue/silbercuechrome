import type { CdpClient } from "./cdp-client.js";
import { debug } from "./debug.js";

// --- Types ---

export interface DialogEvent {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
  url: string;
}

export interface DialogHandlerConfig {
  autoAccept: boolean;
  promptText?: string;
  timeoutMs: number;
}

// --- DialogHandler ---

export class DialogHandler {
  private _cdpClient: CdpClient;
  private _sessionId: string;
  private _callback: ((params: unknown) => void) | null = null;
  private _pendingNotifications: DialogEvent[] = [];
  private _handlerStack: DialogHandlerConfig[] = [];
  private _defaultTimeoutMs: number = 3000;
  private _pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  private _initialized = false;

  constructor(cdpClient: CdpClient, sessionId: string, timeoutMs?: number) {
    this._cdpClient = cdpClient;
    this._sessionId = sessionId;
    if (timeoutMs !== undefined) {
      this._defaultTimeoutMs = timeoutMs;
    }
  }

  /**
   * Start listening for Page.javascriptDialogOpening events.
   */
  init(): void {
    if (this._initialized) return;
    this._initialized = true;
    this._callback = (params: unknown) => {
      this._onDialogOpening(params);
    };
    this._cdpClient.on("Page.javascriptDialogOpening", this._callback, this._sessionId);
    debug("DialogHandler initialized on session %s", this._sessionId);
  }

  /**
   * Remove event listener and clear handler stack.
   */
  detach(): void {
    this._initialized = false;
    if (this._callback) {
      this._cdpClient.off("Page.javascriptDialogOpening", this._callback);
      this._callback = null;
    }
    // Clear any pending auto-dismiss timers
    for (const timer of this._pendingTimers) {
      clearTimeout(timer);
    }
    this._pendingTimers.clear();
    this._handlerStack = [];
    debug("DialogHandler detached");
  }

  /**
   * Re-initialize after reconnect or tab switch.
   * Preserves pending notifications (tab-switch should not lose them).
   */
  reinit(cdpClient: CdpClient, sessionId: string): void {
    this.detach();
    this._cdpClient = cdpClient;
    this._sessionId = sessionId;
    this.init();
  }

  /**
   * Push a handler onto the stack. The topmost handler is used for the next dialog.
   */
  pushHandler(config: DialogHandlerConfig): void {
    this._handlerStack.push(config);
  }

  /**
   * Remove and return the topmost handler from the stack.
   */
  popHandler(): DialogHandlerConfig | undefined {
    return this._handlerStack.pop();
  }

  /**
   * Return buffered dialog notifications and clear the buffer.
   */
  consumeNotifications(): DialogEvent[] {
    const copy = [...this._pendingNotifications];
    this._pendingNotifications = [];
    return copy;
  }

  /**
   * Number of buffered notifications.
   */
  get pendingCount(): number {
    return this._pendingNotifications.length;
  }

  // --- Internal ---

  private _onDialogOpening(params: unknown): void {
    const p = params as {
      type?: string;
      message?: string;
      defaultPrompt?: string;
      url?: string;
      hasBrowserHandler?: boolean;
    };

    const event: DialogEvent = {
      type: (p.type as DialogEvent["type"]) ?? "alert",
      message: p.message ?? "",
      defaultPrompt: p.defaultPrompt,
      url: p.url ?? "",
    };

    // Buffer notification for next tool response
    this._pendingNotifications.push(event);

    // Check handler stack (topmost wins, pop after use — fire-and-forget)
    const handler = this._handlerStack.pop();

    if (handler) {
      // Handler configured — respond immediately
      const cdpParams: { accept: boolean; promptText?: string } = {
        accept: handler.autoAccept,
      };
      // Only include promptText for prompt dialogs
      if (event.type === "prompt" && handler.promptText !== undefined) {
        cdpParams.promptText = handler.promptText;
      }

      this._handleDialog(cdpParams, event);
    } else {
      // No handler configured — auto-dismiss after timeout
      // beforeunload MUST always be accepted, otherwise navigation is blocked
      const accept = event.type === "beforeunload";
      const timer = setTimeout(() => {
        this._pendingTimers.delete(timer);
        this._handleDialog({ accept }, event);
        debug("Dialog auto-dismissed after %dms: %s", this._defaultTimeoutMs, event.message);
      }, this._defaultTimeoutMs);
      this._pendingTimers.add(timer);
    }
  }

  private _handleDialog(
    cdpParams: { accept: boolean; promptText?: string },
    event: DialogEvent,
  ): void {
    // CRITICAL: try/catch — dialog may already have been handled by other code
    this._cdpClient
      .send("Page.handleJavaScriptDialog", cdpParams, this._sessionId)
      .catch(() => {
        debug("Dialog already handled or dismissed: %s (%s)", event.type, event.message);
      });
  }
}
