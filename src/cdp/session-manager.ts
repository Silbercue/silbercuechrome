import type { CdpClient } from "./cdp-client.js";
import { debug } from "./debug.js";
import { wrapCdpError } from "../tools/error-utils.js";

// --- Types ---

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

interface AttachedToTargetParams {
  sessionId: string;
  targetInfo: TargetInfo;
  waitingForDebugger: boolean;
}

interface DetachedFromTargetParams {
  sessionId: string;
  targetId?: string;
}

export interface SessionInfo {
  sessionId: string;
  frameId: string;
  url: string;
  isMain: boolean;
}

// --- SessionManager ---

export class SessionManager {
  private _frameToSession = new Map<string, string>(); // frameId → sessionId
  private _sessionToFrame = new Map<string, string>(); // sessionId → frameId
  private _sessionToUrl = new Map<string, string>(); // sessionId → url
  private _nodeToSession = new Map<string, string>(); // "${sessionId}:${backendNodeId}" → sessionId
  private _mainSessionId: string;
  private _cdpClient: CdpClient;
  private _onOopifDetachCallback: ((sessionId: string) => void) | null = null;

  // Store bound callbacks for cleanup
  private _onAttachedBound: ((params: unknown) => void) | null = null;
  private _onDetachedBound: ((params: unknown) => void) | null = null;

  constructor(cdpClient: CdpClient, mainSessionId: string) {
    this._cdpClient = cdpClient;
    this._mainSessionId = mainSessionId;
  }

  get mainSessionId(): string {
    return this._mainSessionId;
  }

  /**
   * Register a callback to be invoked when an OOPIF session is detached.
   * Used by A11yTreeProcessor to clean up ref-maps (H1).
   */
  onOopifDetach(callback: (sessionId: string) => void): void {
    this._onOopifDetachCallback = callback;
  }

  /**
   * Returns the session for a given backendNodeId.
   * Searches all registered composite keys for this backendNodeId.
   * Falls back to main session if node is not registered (graceful degradation).
   */
  getSessionForNode(backendNodeId: number): string {
    // Search for any key ending with `:${backendNodeId}`
    for (const [key, sid] of this._nodeToSession.entries()) {
      const colonIdx = key.lastIndexOf(":");
      if (colonIdx !== -1 && parseInt(key.slice(colonIdx + 1), 10) === backendNodeId) {
        return sid;
      }
    }
    return this._mainSessionId;
  }

  /**
   * Register a node's session association using composite key.
   * Key format: "${sessionId}:${backendNodeId}" to avoid collisions between OOPIF sessions.
   * Called by A11yTreeProcessor when building the tree.
   */
  registerNode(backendNodeId: number, sessionId: string): void {
    this._nodeToSession.set(`${sessionId}:${backendNodeId}`, sessionId);
  }

  /**
   * Returns all active sessions (main + OOPIFs).
   */
  getAllSessions(): SessionInfo[] {
    const sessions: SessionInfo[] = [
      {
        sessionId: this._mainSessionId,
        frameId: "main",
        url: "",
        isMain: true,
      },
    ];

    for (const [sessionId, frameId] of this._sessionToFrame.entries()) {
      sessions.push({
        sessionId,
        frameId,
        url: this._sessionToUrl.get(sessionId) ?? "",
        isMain: false,
      });
    }

    return sessions;
  }

  /**
   * Initialize auto-attach and discover existing iFrames.
   * H3: Also discovers already-existing OOPIF targets on startup.
   */
  async init(): Promise<void> {
    // Register event listeners
    this._onAttachedBound = (params: unknown) =>
      this._onAttached(params as AttachedToTargetParams);
    this._onDetachedBound = (params: unknown) =>
      this._onDetached(params as DetachedFromTargetParams);

    this._cdpClient.on("Target.attachedToTarget", this._onAttachedBound);
    this._cdpClient.on("Target.detachedFromTarget", this._onDetachedBound);

    // Enable auto-attach on the page session — only iFrames of THIS page
    try {
      await this._cdpClient.send(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
        this._mainSessionId,
      );
    } catch (err) {
      debug("SessionManager: setAutoAttach failed: %s", wrapCdpError(err, "SessionManager.init"));
      throw err;
    }

    // H3: Discover already-existing iframe targets and attach to them
    try {
      const { targetInfos } = await this._cdpClient.send<{ targetInfos: TargetInfo[] }>(
        "Target.getTargets",
      );
      const existingIframes = targetInfos.filter((t) => t.type === "iframe");

      for (const iframe of existingIframes) {
        // Check if we already have this target attached (auto-attach may have fired)
        if (this._frameToSession.has(iframe.targetId)) continue;

        try {
          const { sessionId } = await this._cdpClient.send<{ sessionId: string }>(
            "Target.attachToTarget",
            { targetId: iframe.targetId, flatten: true },
          );
          // Process as if it were an auto-attach event
          await this._onAttached({
            sessionId,
            targetInfo: iframe,
            waitingForDebugger: false,
          });
        } catch (err) {
          debug("SessionManager: failed to attach existing iframe %s: %s", iframe.url, err);
        }
      }
    } catch (err) {
      // Non-fatal: auto-attach will still catch new iframes
      debug("SessionManager: Target.getTargets failed during init: %s", wrapCdpError(err, "SessionManager.init"));
    }

    debug("SessionManager initialized (auto-attach enabled on session %s, %d existing OOPIFs)", this._mainSessionId, this._sessionToFrame.size);
  }

  /**
   * Handle Target.attachedToTarget event.
   */
  private async _onAttached(params: AttachedToTargetParams): Promise<void> {
    const { sessionId, targetInfo } = params;

    // Only handle iframe targets
    if (targetInfo.type !== "iframe") {
      debug("SessionManager ignoring non-iframe target: %s (type: %s)", targetInfo.url, targetInfo.type);
      return;
    }

    // Store session mapping
    this._sessionToFrame.set(sessionId, targetInfo.targetId);
    this._frameToSession.set(targetInfo.targetId, sessionId);
    this._sessionToUrl.set(sessionId, targetInfo.url);

    // Enable required CDP domains on the OOPIF session
    try {
      await Promise.all([
        this._cdpClient.send("Accessibility.enable", {}, sessionId),
        this._cdpClient.send("DOM.enable", {}, sessionId),
        this._cdpClient.send("Runtime.enable", {}, sessionId),
      ]);
      debug("OOPIF attached: %s (session: %s)", targetInfo.url, sessionId);
    } catch (err) {
      debug("OOPIF domain enable failed for %s: %s", targetInfo.url, wrapCdpError(err, "SessionManager._onAttached"));
      // Clean up on failure
      this._sessionToFrame.delete(sessionId);
      this._frameToSession.delete(targetInfo.targetId);
      this._sessionToUrl.delete(sessionId);
    }
  }

  /**
   * Handle Target.detachedFromTarget event.
   */
  private _onDetached(params: DetachedFromTargetParams): void {
    const { sessionId } = params;

    // Remove all nodes associated with this session from nodeToSession map
    for (const [key, sid] of this._nodeToSession.entries()) {
      if (sid === sessionId) {
        this._nodeToSession.delete(key);
      }
    }

    // Notify cleanup callback (H1: allows A11yTreeProcessor to clean ref-maps)
    if (this._onOopifDetachCallback) {
      this._onOopifDetachCallback(sessionId);
    }

    // Remove session from frame maps
    const frameId = this._sessionToFrame.get(sessionId);
    if (frameId) {
      this._frameToSession.delete(frameId);
    }
    this._sessionToFrame.delete(sessionId);
    this._sessionToUrl.delete(sessionId);

    debug("OOPIF detached: %s", sessionId);
  }

  /**
   * Clean up event listeners and clear all state.
   */
  detach(): void {
    if (this._onAttachedBound) {
      this._cdpClient.off("Target.attachedToTarget", this._onAttachedBound);
      this._onAttachedBound = null;
    }
    if (this._onDetachedBound) {
      this._cdpClient.off("Target.detachedFromTarget", this._onDetachedBound);
      this._onDetachedBound = null;
    }

    this._frameToSession.clear();
    this._sessionToFrame.clear();
    this._sessionToUrl.clear();
    this._nodeToSession.clear();
  }

  /**
   * Re-initialize after reconnect with new CDP client and session.
   */
  async reinit(cdpClient: CdpClient, mainSessionId: string): Promise<void> {
    this.detach();
    this._cdpClient = cdpClient;
    this._mainSessionId = mainSessionId;
    await this.init();
  }
}
