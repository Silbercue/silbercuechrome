/**
 * Story 12.1 / 12a.2: Pattern Recorder — Cortex Phase 1.
 *
 * Records successful tool-call sequences as patterns that the Cortex can
 * learn from. Session-scoped ring-buffer design modelled after
 * `telemetry/tool-sequence.ts`.
 *
 * Integration: called from `hooks/default-on-tool-result.ts` after every
 * successful tool call. The recorder is a passive observer — it NEVER
 * modifies the tool response or throws errors that could disrupt the
 * tool flow.
 *
 * Story 12a.2: Patterns are now keyed by pageType (from page-classifier.ts)
 * instead of domain/pathPattern. The page type is determined from the
 * A11y-Tree before record() is called.
 *
 * Privacy (NFR21): Only pageType, tool names, outcome, content-hash,
 * and timestamp are stored. No full URLs, no query parameters, no auth
 * tokens, no page content.
 *
 * Persistence is NOT handled here — patterns are kept in memory only.
 * Story 12.2 (Merkle Log) will consume `emittedPatterns` for persistence.
 */
import { createHash } from "node:crypto";
import { debug } from "../cdp/debug.js";
import type { CortexPattern, ToolCallEvent } from "./cortex-types.js";
import {
  MIN_SEQUENCE_LENGTH,
  MAX_SEQUENCE_LENGTH,
  SEQUENCE_TIMEOUT_MS,
} from "./cortex-types.js";
import type { LocalStore } from "./local-store.js";

/** Maximum number of events kept in the ring buffer (same as ToolSequenceTracker). */
const MAX_BUFFER_SIZE = 64;

/** Maximum number of emitted patterns kept in memory before oldest are discarded. */
const MAX_EMITTED_PATTERNS = 1000;

/** Regex to extract a URL from navigate response text. */
const URL_FROM_RESPONSE_RE = /https?:\/\/[^\s)]+/;

/** Per-session state for the pattern recorder's ring buffer. */
interface SessionState {
  buffer: ToolCallEvent[];
  eventIds: number[];
  eventCounter: number;
  lastEmittedNavigateId: number;
}

export class PatternRecorder {
  /** Session-scoped buffers (same design as ToolSequenceTracker.bySession). */
  private _bySession = new Map<string, SessionState>();

  /** Collected patterns (consumed by Story 12.2 for persistence). */
  readonly emittedPatterns: CortexPattern[] = [];

  /** Optional persistent store (Story 12.2 — Merkle append-only log). */
  private readonly _localStore?: LocalStore;

  constructor(localStore?: LocalStore) {
    this._localStore = localStore;
  }

  /** Get or create session state for the given sessionId. */
  private _getSession(sessionId: string): SessionState {
    let state = this._bySession.get(sessionId);
    if (!state) {
      state = { buffer: [], eventIds: [], eventCounter: 0, lastEmittedNavigateId: -1 };
      this._bySession.set(sessionId, state);
    }
    return state;
  }

  /**
   * Record a successful tool call. Appends to the session's ring buffer
   * and checks whether a recordable sequence has formed.
   *
   * Story 12a.2: Takes pageType instead of domain/path. The pageType is
   * determined by the page-classifier before this method is called.
   *
   * @param toolName - Name of the tool that was called.
   * @param pageType - Page type classification from page-classifier (e.g. "login", "unknown").
   * @param contentHash - Truncated SHA-256 of the response content.
   * @param sessionId - Session scope for the buffer (from context.sessionId).
   */
  record(toolName: string, pageType: string, contentHash: string, sessionId = "__default__"): void {
    try {
      const session = this._getSession(sessionId);

      const event: ToolCallEvent = {
        toolName,
        timestamp: Date.now(),
        pageType,
        contentHash,
      };

      session.buffer.push(event);
      session.eventIds.push(++session.eventCounter);
      if (session.buffer.length > MAX_BUFFER_SIZE) {
        const excess = session.buffer.length - MAX_BUFFER_SIZE;
        session.buffer.splice(0, excess);
        session.eventIds.splice(0, excess);
      }

      this._maybeEmitPattern(session);
    } catch (err) {
      // The recorder must NEVER throw — it is a passive observer.
      debug("[pattern-recorder] record() threw: %s", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Extract a URL from the navigate tool's response text.
   *
   * The navigate handler writes the destination URL into the response
   * (e.g. "Navigated to https://example.com/page"). Since
   * `a11yTree.reset()` runs BEFORE the onToolResult hook fires,
   * `context.a11yTree.currentUrl` is empty for navigate calls. This
   * method provides the fallback.
   */
  static extractUrlFromResponse(responseText: string): URL | null {
    const match = URL_FROM_RESPONSE_RE.exec(responseText);
    if (!match) return null;
    try {
      return new URL(match[0]);
    } catch {
      return null;
    }
  }

  /**
   * Check whether the most recent events form a recordable sequence.
   *
   * A recordable sequence:
   *  1. Starts with "navigate"
   *  2. Has at least MIN_SEQUENCE_LENGTH tools
   *  3. All events fall within SEQUENCE_TIMEOUT_MS
   *  4. Has at most MAX_SEQUENCE_LENGTH tools
   */
  private _maybeEmitPattern(session: SessionState): void {
    const now = Date.now();
    const cutoff = now - SEQUENCE_TIMEOUT_MS;

    // Walk backwards from the most recent event to find the latest "navigate"
    let navigateIdx = -1;
    for (let i = session.buffer.length - 1; i >= 0; i--) {
      const ev = session.buffer[i];
      if (ev.timestamp < cutoff) break; // too old, stop searching
      if (ev.toolName === "navigate") {
        navigateIdx = i;
        break;
      }
    }

    if (navigateIdx < 0) return; // no navigate found within the time window

    // Extract the sequence from navigate to the end of the buffer
    const sequenceEvents = session.buffer.slice(navigateIdx);

    // Enforce length constraints
    if (sequenceEvents.length < MIN_SEQUENCE_LENGTH) return;
    if (sequenceEvents.length > MAX_SEQUENCE_LENGTH) return;

    // Verify all events are within the time window
    const firstTimestamp = sequenceEvents[0].timestamp;
    const lastTimestamp = sequenceEvents[sequenceEvents.length - 1].timestamp;
    if (lastTimestamp - firstTimestamp > SEQUENCE_TIMEOUT_MS) return;

    // Use the last event's data for the pattern metadata.
    // Story 12a.2: pageType from the LAST event (after view_page/click, when
    // the A11y-Tree is populated) — the navigate event has "unknown" because
    // the tree is empty after reset().
    const lastEvent = sequenceEvents[sequenceEvents.length - 1];

    const pattern: CortexPattern = {
      pageType: lastEvent.pageType,
      toolSequence: sequenceEvents.map((e: ToolCallEvent) => e.toolName),
      outcome: "success",
      contentHash: lastEvent.contentHash,
      timestamp: now,
    };

    // Deduplicate: if the same navigate-start already emitted a pattern,
    // replace it with the longer version instead of appending a new entry.
    const navEventId = session.eventIds[navigateIdx];
    if (navEventId === session.lastEmittedNavigateId && this.emittedPatterns.length > 0) {
      this.emittedPatterns[this.emittedPatterns.length - 1] = pattern;
    } else {
      this.emittedPatterns.push(pattern);
      session.lastEmittedNavigateId = navEventId;

      // M3: Cap emittedPatterns to prevent unbounded growth.
      if (this.emittedPatterns.length > MAX_EMITTED_PATTERNS) {
        this.emittedPatterns.splice(0, this.emittedPatterns.length - MAX_EMITTED_PATTERNS);
      }
    }

    // Story 12.2: fire-and-forget persistence to Merkle log.
    // Errors are caught and debug-logged — never disrupt the tool flow.
    if (this._localStore) {
      this._localStore.append(pattern).catch((err: unknown) => {
        debug(
          "[pattern-recorder] localStore.append() failed: %s",
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    // Story 12.3: Refresh the hint-matcher index after a new pattern is emitted.
    // Dynamic import to break circular dependency (hint-matcher imports
    // patternRecorder.emittedPatterns; pattern-recorder needs to refresh
    // hint-matcher). Fire-and-forget — errors are debug-logged.
    import("./hint-matcher.js")
      .then((m) => m.hintMatcher.refresh())
      .catch((err: unknown) => {
        debug(
          "[pattern-recorder] hintMatcher refresh failed: %s",
          err instanceof Error ? err.message : String(err),
        );
      });

    // Story 12.5: Opt-in telemetry upload after pattern emission.
    // Dynamic import (same approach as hint-matcher) to avoid circular
    // dependencies and lazy-load the module. Fire-and-forget.
    import("./telemetry-upload.js")
      .then((m) => m.telemetryUploader.maybeUpload(pattern))
      .catch((err: unknown) => {
        debug(
          "[pattern-recorder] telemetry upload failed: %s",
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  /**
   * Compute a truncated SHA-256 content hash (16 hex characters).
   * Deterministic — same input always produces the same hash.
   */
  static computeContentHash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }
}

/**
 * Module-level singleton (same pattern as `toolSequence` in telemetry/tool-sequence.ts).
 *
 * Story 12.2: The singleton is constructed with a LocalStore instance using
 * the default data directory. The dynamic import avoids circular dependencies
 * and keeps the module loadable even if the fs layer has issues.
 */
let _singletonStore: LocalStore | undefined;
try {
  // Dynamic require at module scope — LocalStore constructor is sync (no I/O).
  // Using a variable import to avoid issues with the type-only import above.
  const { LocalStore: LS } = await import("./local-store.js");
  _singletonStore = new LS();
} catch (err) {
  debug(
    "[pattern-recorder] Failed to initialise LocalStore for singleton: %s",
    err instanceof Error ? err.message : String(err),
  );
}

export const patternRecorder = new PatternRecorder(_singletonStore);
