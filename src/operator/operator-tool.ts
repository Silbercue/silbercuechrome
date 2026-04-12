/**
 * Operator Tool — MCP-Tool-Handler fuer den 2-Call Kartentisch-Loop.
 *
 * Two call modes:
 *   1. operator() — Scan → Offer (Karten-Angebot)
 *   2. operator(card, params) — Execute → Result + POST_EXECUTION_SCAN
 *
 * This is the single try/catch boundary for the entire operator pipeline
 * (Invariante 4). All downstream modules return errors as values.
 *
 * Module Boundaries:
 *   - MAY import: src/operator/ (state-machine, return-builder, return-serializer,
 *                 events, config, fallback-messages, execution-bundling)
 *   - MAY import: src/scan/ (extractSignals, aggregateSignals, matchAllCards)
 *   - MAY import: src/cards/ (loadAll, Card)
 *   - MAY import: src/cache/ (AXNode type)
 *   - MAY import: zod
 *   - MUST NOT import: src/cdp/ (CDP access via injected dependencies)
 *   - MUST NOT import: src/registry.ts (no backward dependency)
 */

import { z, ZodError } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { AXNode } from "../cache/a11y-tree.js";
import type { ToolResponse, ToolContentBlock } from "../types.js";
import type { MatchResult, AggregatedCluster } from "../scan/match-types.js";
import type { Card } from "../cards/card-schema.js";
import { extractSignals } from "../scan/signal-extractor.js";
import { aggregateSignals } from "../scan/aggregator.js";
import { matchAllCards } from "../scan/matcher.js";
import { loadAll as loadAllCards } from "../cards/card-loader.js";
import { OperatorStateMachine } from "./state-machine.js";
import {
  buildOfferReturn,
  buildResultReturn,
} from "./return-builder.js";
import type { PageContext, AnnotatedMatch, CardInfo } from "./return-builder.js";
import { serializeOfferReturn, serializeResultReturn } from "./return-serializer.js";
import { executeCard } from "./execution-bundling.js";
import type { ToolDispatcher, ExecutionStep } from "./execution-bundling.js";
import { FALLBACK_NO_MATCH, formatFallbackMessage, FALLBACK_EXECUTION_FAILED } from "./fallback-messages.js";
import { POST_EXECUTION_SCAN_DELAY_MS } from "./config.js";

import path from "node:path";

// ---------------------------------------------------------------------------
// Zod Input Schema (Subtask 1.2, AC-8)
// ---------------------------------------------------------------------------

/**
 * H3 fix: Zod schema for fallback text validation.
 * Ensures fallback messages are non-empty strings before they go out.
 */
const FallbackTextSchema = z.string().min(1);

/**
 * Operator input: empty for Scan-Flow, card+params for Execute-Flow.
 */
export const OperatorInputSchema = z.object({
  card: z.string().optional(),
  params: z.record(z.string()).optional(),
});

export type OperatorInput = z.infer<typeof OperatorInputSchema>;

/**
 * Zod shape for MCP server.tool() registration.
 * Matches the OperatorInputSchema properties.
 */
export const operatorZodShape = {
  card: OperatorInputSchema.shape.card,
  params: OperatorInputSchema.shape.params,
};

// ---------------------------------------------------------------------------
// Dependencies Interface (injected by registry.ts)
// ---------------------------------------------------------------------------

/**
 * External dependencies injected by the registry closure.
 * Keeps operator-tool.ts free from src/cdp/ and src/registry.ts imports.
 */
export interface OperatorDeps {
  /**
   * C1 fix: Returns raw AXNode[] — uses a11yTree cache when available,
   * falls back to CDP. The caller (registry.ts) wires this to
   * a11yTree.getPrecomputedNodes() with CDP fallback.
   */
  getAXNodes: () => Promise<AXNode[]>;
  /** Tab state cache for page context (title, url) */
  tabStateCache: { get: (targetId: string) => { title?: string; url?: string } | null; activeTargetId: string | null };
  /** Session manager for OOPIF */
  sessionManager?: unknown;
  /** Click handler from src/tools/ */
  clickHandler: (params: Record<string, unknown>) => Promise<ToolResponse>;
  /** Fill form handler from src/tools/ */
  fillFormHandler: (params: Record<string, unknown>) => Promise<ToolResponse>;
  /** Press key handler from src/tools/ */
  pressKeyHandler: (params: Record<string, unknown>) => Promise<ToolResponse>;
  /** Scroll handler from src/tools/ */
  scrollHandler: (params: Record<string, unknown>) => Promise<ToolResponse>;
  /** Settle function — waits for page to settle */
  settle: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Card Library Caching
// ---------------------------------------------------------------------------

/** Cached card library — loaded once per process. */
let _cardCache: Map<string, Card> | null = null;

/** Overridable cards directory — for testing. */
let _cardsDirOverride: string | null = null;

function getCardsDir(): string {
  if (_cardsDirOverride) return _cardsDirOverride;
  // Cards live at <project-root>/cards/ regardless of whether we run from
  // src/ (vitest) or build/ (production).
  return path.resolve(process.cwd(), "cards");
}

function loadCards(): Map<string, Card> {
  if (!_cardCache) {
    _cardCache = loadAllCards(getCardsDir());
  }
  return _cardCache;
}

/** Reset card cache — for testing only. */
export function _resetCardCache(): void {
  _cardCache = null;
}

/** Override cards directory — for testing only. */
export function _setCardsDir(dir: string | null): void {
  _cardsDirOverride = dir;
  _cardCache = null;
}

// ---------------------------------------------------------------------------
// ToolDispatcher Adapter (Task 2, AC-4)
// ---------------------------------------------------------------------------

/**
 * H1 fix: Detect whether a target is a ref (e.g. 'e5') or a CSS selector.
 * Seed cards use CSS selectors as targets; refs follow the pattern /^e\d+$/.
 */
const REF_PATTERN = /^e\d+$/;

function targetParam(target: string): { ref: string } | { selector: string } {
  return REF_PATTERN.test(target) ? { ref: target } : { selector: target };
}

/**
 * Concrete ToolDispatcher that delegates to the existing tool handlers.
 * Each method returns void on success or throws on error — the execution
 * bundling module wraps them in try/catch.
 */
function createToolDispatcher(deps: OperatorDeps): ToolDispatcher {
  return {
    async click(target: string): Promise<void> {
      const result = await deps.clickHandler(targetParam(target));
      if (result.isError) {
        throw new Error(`click failed: ${extractTextFromResponse(result)}`);
      }
    },

    async fill(target: string, value: string): Promise<void> {
      const result = await deps.fillFormHandler({
        fields: [{ ...targetParam(target), value }],
      });
      if (result.isError) {
        throw new Error(`fill failed: ${extractTextFromResponse(result)}`);
      }
    },

    async pressKey(key: string): Promise<void> {
      const result = await deps.pressKeyHandler({ key });
      if (result.isError) {
        throw new Error(`press_key failed: ${extractTextFromResponse(result)}`);
      }
    },

    async scroll(target: string, direction: string): Promise<void> {
      const result = await deps.scrollHandler({ ...targetParam(target), direction });
      if (result.isError) {
        throw new Error(`scroll failed: ${extractTextFromResponse(result)}`);
      }
    },

    async waitForSettle(): Promise<boolean> {
      return deps.settle();
    },
  };
}

/** Extract first text block from a ToolResponse. */
function extractTextFromResponse(result: ToolResponse): string {
  for (const block of result.content) {
    if (block.type === "text") return block.text;
  }
  return "unknown error";
}

// ---------------------------------------------------------------------------
// Page Context Builder
// ---------------------------------------------------------------------------

function getPageContext(deps: OperatorDeps): PageContext {
  const activeId = deps.tabStateCache.activeTargetId;
  if (activeId) {
    const cached = deps.tabStateCache.get(activeId);
    if (cached) {
      return {
        title: cached.title ?? "Untitled",
        url: cached.url ?? "about:blank",
      };
    }
  }
  return { title: "Untitled", url: "about:blank" };
}

// ---------------------------------------------------------------------------
// Scan Pipeline
// ---------------------------------------------------------------------------

/**
 * C1 fix: Fetch AXNodes via injected getAXNodes(), which uses the
 * a11yTree precomputed cache when available and falls back to CDP.
 */
async function fetchAXNodes(deps: OperatorDeps): Promise<AXNode[]> {
  return deps.getAXNodes();
}

interface ScanResult {
  nodes: AXNode[];
  matchedAnnotations: AnnotatedMatch[];
  matchResults: MatchResult[];
  hasMatch: boolean;
}

function runScanPipeline(nodes: AXNode[], cards: Map<string, Card>): ScanResult {
  // 1. Extract signals from A11y-Tree
  const extraction = extractSignals(nodes);
  const signals = extraction.signals;

  // 2. Aggregate into clusters
  const clusters = aggregateSignals(signals);

  // 3. Match cards against signals
  const cardArray = Array.from(cards.values());
  const matchResults = matchAllCards(cardArray, signals);

  // 4. Build AnnotatedMatch[] for matched cards only
  const matchedAnnotations: AnnotatedMatch[] = [];

  for (const mr of matchResults) {
    if (!mr.matched) continue;
    const card = cards.get(mr.cardId);
    if (!card) continue;

    // Find best cluster for this card match
    const bestCluster = findBestCluster(clusters, mr);

    const cardInfo: CardInfo = {
      id: card.id,
      name: card.name,
      description: card.description,
      parameters: card.parameters,
    };

    matchedAnnotations.push({
      matchResult: mr,
      cardInfo,
      cluster: bestCluster,
    });
  }

  return {
    nodes,
    matchedAnnotations,
    matchResults,
    hasMatch: matchedAnnotations.length > 0,
  };
}

/**
 * Find the best cluster for a given match result.
 * M1 fix: Uses the match result's signal_breakdown to score clusters
 * by how many matched signals they contain, rather than blindly
 * picking the largest cluster.
 */
function findBestCluster(clusters: AggregatedCluster[], mr: MatchResult): AggregatedCluster {
  if (clusters.length === 0) {
    return { nodeIds: [], signals: [], dominantTypes: [] };
  }

  // Build a set of matched signal identifiers from the match result
  const matchedSignals = new Set(
    mr.signal_breakdown
      .filter(s => s.matched)
      .map(s => s.signal),
  );

  // Score each cluster by how many of its signals overlap with the match
  let best = clusters[0]!;
  let bestOverlap = 0;

  for (const c of clusters) {
    let overlap = 0;
    for (const sig of c.signals) {
      // Cluster signals may be in various formats; check if any matched signal
      // is a substring or exact match (e.g. "role:form" vs "role:form")
      const sigKey = typeof sig === "string" ? sig : `${(sig as { type?: string }).type ?? ""}:${(sig as { value?: string }).value ?? ""}`;
      if (matchedSignals.has(sigKey)) overlap++;
    }
    if (overlap > bestOverlap || (overlap === bestOverlap && c.signals.length > best.signals.length)) {
      best = c;
      bestOverlap = overlap;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Public API — operatorHandler (Task 1, AC-2, AC-3)
// ---------------------------------------------------------------------------

/**
 * Operator MCP Tool Handler.
 *
 * This is the single try/catch boundary for the entire operator pipeline.
 *
 * @param args - Parsed input (empty for scan, card+params for execute)
 * @param deps - Injected dependencies from registry.ts closure
 * @returns MCP ToolResponse with serialized offer or result
 */
export async function operatorHandler(
  args: Record<string, unknown>,
  deps: OperatorDeps,
): Promise<ToolResponse> {
  const start = performance.now();
  const method = "operator";

  try {
    // Parse input via Zod (AC-8)
    const input = OperatorInputSchema.parse(args);

    if (input.card) {
      // Execute-Flow
      return await executeFlow(input.card, input.params ?? {}, deps, start, method);
    } else {
      // Scan-Flow
      return await scanFlow(deps, start, method);
    }
  } catch (err) {
    // C4 fix: Propagate errors as McpError (MCP SDK convention).
    // The SDK catches McpError and converts it to a JSON-RPC error response.
    if (err instanceof ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Operator input validation failed: ${err.issues.map(i => i.message).join(", ")}`,
      );
    }

    throw new McpError(
      ErrorCode.InternalError,
      `Operator error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Scan-Flow (Subtask 1.5)
// ---------------------------------------------------------------------------

async function scanFlow(
  deps: OperatorDeps,
  start: number,
  method: string,
): Promise<ToolResponse> {
  const sm = new OperatorStateMachine();

  // IDLE → SCANNING
  sm.transition({ type: "ScanStarted" });

  const nodes = await fetchAXNodes(deps);
  const cards = loadCards();
  const scan = runScanPipeline(nodes, cards);

  if (!scan.hasMatch) {
    // SCANNING → FALLBACK (ScanCompleted with hasMatch=false routes directly to FALLBACK)
    sm.transition({ type: "ScanCompleted", matchResults: scan.matchResults, hasMatch: false });

    // H3 fix: Validate fallback text through Zod before returning.
    const text = FallbackTextSchema.parse(FALLBACK_NO_MATCH);
    const elapsedMs = Math.round(performance.now() - start);
    const content: ToolContentBlock[] = [{ type: "text", text }];
    return {
      content,
      _meta: {
        elapsedMs,
        method,
        response_bytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
        fallback: true,
      },
    };
  }

  // SCANNING → AWAITING_SELECTION
  sm.transition({ type: "ScanCompleted", matchResults: scan.matchResults, hasMatch: true });

  const pageContext = getPageContext(deps);
  const offer = buildOfferReturn(pageContext, scan.matchedAnnotations, scan.nodes);
  const text = serializeOfferReturn(offer);

  const elapsedMs = Math.round(performance.now() - start);
  const content: ToolContentBlock[] = [{ type: "text", text }];
  return {
    content,
    _meta: {
      elapsedMs,
      method,
      response_bytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
    },
  };
}

// ---------------------------------------------------------------------------
// Execute-Flow (Subtask 1.6)
// ---------------------------------------------------------------------------

async function executeFlow(
  cardId: string,
  params: Record<string, string>,
  deps: OperatorDeps,
  start: number,
  method: string,
): Promise<ToolResponse> {
  const sm = new OperatorStateMachine();
  const cards = loadCards();
  const card = cards.get(cardId);

  if (!card) {
    const text = `Unknown card: "${cardId}". Available cards: ${Array.from(cards.keys()).join(", ")}`;
    const elapsedMs = Math.round(performance.now() - start);
    const content: ToolContentBlock[] = [{ type: "text", text }];
    return {
      content,
      isError: true,
      _meta: {
        elapsedMs,
        method,
        response_bytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
      },
    };
  }

  // Convert card execution sequence to ExecutionStep[]
  const steps: ExecutionStep[] = card.executionSequence.map(s => ({
    action: s.action,
    target: s.target,
    value: s.value,
    paramRef: s.paramRef,
  }));

  // State machine: IDLE → SCANNING → AWAITING_SELECTION → EXECUTING
  sm.transition({ type: "ScanStarted" });
  sm.transition({ type: "ScanCompleted", matchResults: [], hasMatch: true });
  sm.transition({
    type: "CardSelected",
    cardId: card.id,
    params,
    stepsTotal: steps.length,
  });

  const dispatcher = createToolDispatcher(deps);

  const execResult = await executeCard(
    { steps, cardId: card.id, params, stateMachine: sm },
    dispatcher,
  );

  // POST_EXECUTION_SCAN (Subtask 1.7)
  // Wait briefly for the page to settle before re-scanning
  await new Promise(resolve => setTimeout(resolve, POST_EXECUTION_SCAN_DELAY_MS));

  const nodes = await fetchAXNodes(deps);
  const scan = runScanPipeline(nodes, cards);

  // Transition post-scan
  if (sm.getState() === "POST_EXECUTION_SCAN") {
    sm.transition({
      type: "PostScanCompleted",
      matchResults: scan.matchResults,
      hasMatch: scan.hasMatch,
    });
  }

  const pageContext = getPageContext(deps);
  const result = buildResultReturn(
    card.name,
    params,
    execResult.stepsCompleted,
    execResult.stepsTotal,
    pageContext,
    nodes,
    execResult.error,
  );
  let text = serializeResultReturn(result);

  // If the post-scan found new cards, append the offer
  if (scan.hasMatch) {
    const offer = buildOfferReturn(pageContext, scan.matchedAnnotations, scan.nodes);
    text += "\n\n" + serializeOfferReturn(offer);
  }

  const elapsedMs = Math.round(performance.now() - start);
  const content: ToolContentBlock[] = [{ type: "text", text }];
  return {
    content,
    _meta: {
      elapsedMs,
      method,
      response_bytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
    },
  };
}
