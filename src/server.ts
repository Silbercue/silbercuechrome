import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserSession } from "./cdp/browser-session.js";
import { resolveAutoLaunch } from "./cdp/chrome-launcher.js";
import { ToolRegistry } from "./registry.js";
import { VERSION } from "./version.js";
import { ScriptApiServer } from "./transport/script-api-server.js";
import { hintMatcher } from "./cortex/hint-matcher.js";
import { loadCommunityMarkov } from "./cortex/community-loader.js";
import { markovTable } from "./cortex/markov-table.js";

/**
 * MCP server bootstrap — lazy-launch architecture.
 *
 * Unlike the previous eager-launch flow (which spawned Chrome at startup
 * and broke the "my browser window pops up every time Claude Code starts"
 * UX), this entry point creates no CDP connection at all. The BrowserSession
 * is instantiated in a dormant state; the first tool call that needs Chrome
 * triggers `ensureReady()` inside the registry's tool wrapper, which lazily
 * launches Chrome (or attaches to an existing instance on port 9222).
 *
 * See `src/cdp/browser-session.ts` for the full lifecycle + retry policy.
 */

/**
 * Story 12.4: Build the MCP server instructions string.
 *
 * When patternCount > 0 a "Cortex: N patterns loaded." line is appended
 * so the LLM agent knows cortex knowledge is available before the first
 * page visit. When 0 patterns exist the cortex line is omitted entirely.
 */
export function buildInstructions(patternCount: number): string {
  const base = [
    "Public Browser controls a real Chrome browser via CDP.",
    "",
    "Workflow: virtual_desk → navigate (to open a page) → view_page (read) → click/type/fill_form (act) → view_page (verify the result).",
    "",
    "CRITICAL — view_page vs capture_image:",
    "- To see what is on the page: ALWAYS call view_page. It returns text + element refs for click/type.",
    "- capture_image is ONLY for CSS layout checks, canvas content, or when the user explicitly asks for a screenshot.",
    "- Do NOT call capture_image to read text, find buttons, check errors, or see page state — that is view_page.",
    "- capture_image cannot return element refs, so you cannot click anything you see in it.",
    "",
    "Other rules:",
    "- After every interaction, use view_page again to verify the result before proceeding.",
    "- fill_form beats multiple type calls for any form with 2+ fields.",
    "- For multi-step workflows, use run_plan to execute N steps in one call.",
    "- evaluate is for JS computation and style mutations (.style.X = ...) — not for CSS reading or element discovery.",
    "- Avoid evaluate as default recovery after click/type errors — call view_page for fresh refs and retry with the dedicated tool.",
    "",
    "Script API: `pip install publicbrowser` gives you a Python library for deterministic browser automation without an LLM. Scripts route through the same tool handlers as MCP (Shared Core). Usage: `from publicbrowser import Chrome; chrome = Chrome.connect(); page = chrome.new_page()` — then `page.navigate()`, `page.click()`, `page.fill()`, `page.evaluate()` etc. Auto-starts the server. Add `--script` to the MCP args for parallel MCP + Script access.",
  ].join("\n");

  if (patternCount > 0) {
    return base + `\nCortex: ${patternCount} patterns loaded.`;
  }
  return base;
}

export interface StartServerOptions {
  /** Attach-only mode: connect to existing Chrome, no auto-launch, no reconnect. */
  attach?: boolean;
  /**
   * Story 9.1: Script-mode flag. Signals the MCP server that external CDP
   * clients (e.g. Python Script API) are expected on port 9222. The server
   * uses set-based ownership tracking so externally created tabs are
   * ignored by MCP tools (switch_tab, virtual_desk, navigate).
   */
  script?: boolean;
}

export async function startServer(options?: StartServerOptions): Promise<void> {
  const attachMode = options?.attach ?? false;
  const scriptMode = options?.script ?? false;

  // 1. Read environment — no Chrome is touched here.
  const profilePath = process.env.SILBERCUE_CHROME_PROFILE || undefined;
  const headlessEnv = process.env.SILBERCUE_CHROME_HEADLESS === "true";
  const autoLaunch = attachMode
    ? false
    : resolveAutoLaunch(
        process.env as Record<string, string | undefined>,
        headlessEnv,
      );

  if (profilePath) {
    console.error(`Public Browser using Chrome profile: ${profilePath}`);
  }

  // 2. Create the lazy BrowserSession. No launch yet.
  //    In attach mode: autoLaunch = false (set above), attachMode flag
  //    for tab-lifecycle cleanup. autoReconnect is already false by default
  //    in BrowserSession constructor — no need to set it explicitly.
  const browserSession = new BrowserSession({
    profilePath,
    headless: headlessEnv,
    autoLaunch,
    attachMode,
    scriptMode,
  });

  // 2b. Attach mode: eagerly validate that Chrome is reachable. Fail fast
  //     with a clear stderr message + exit 1 instead of silently waiting
  //     for the first tool call to surface an opaque launch error.
  if (attachMode) {
    try {
      await browserSession.ensureReady();
      console.error("Public Browser --attach: connected to Chrome on port 9222");
    } catch {
      console.error(
        [
          "Error: --attach failed — Chrome not reachable on port 9222.",
          "Make sure Chrome is running with remote debugging enabled,",
          "or that another Public Browser instance (e.g. via Claude Code) is active.",
        ].join("\n"),
      );
      process.exit(1);
    }
  }

  // 2c. Script mode: log to stderr for operator visibility.
  if (scriptMode) {
    console.error("Public Browser --script: external CDP clients expected, tab ownership tracking enabled");
  }

  // 3. Story 12.4: Load cortex patterns BEFORE McpServer construction so
  //    the pattern count can be included in the instructions string.
  //    Hard 2s timeout (NFR19: cortex must not delay server start > 2s).
  //    On timeout or error: patternCount = 0 → no cortex line in instructions.
  await Promise.race([
    hintMatcher.refreshAsync(),
    new Promise((r) => setTimeout(r, 2000)),
  ]);

  // 3a. Story 12a.6: Merge community Markov table after local data is loaded.
  //     Local data has higher weights from usage and takes precedence via
  //     merge semantics (max-weight). Community data fills gaps.
  const communityTable = loadCommunityMarkov();
  if (communityTable) {
    markovTable.merge(communityTable);
  }

  // 3b. Create the MCP server with dynamic instructions.
  const server = new McpServer(
    {
      name: "public-browser",
      version: VERSION,
    },
    {
      instructions: buildInstructions(hintMatcher.patternCount),
    },
  );

  // 4. Create the ToolRegistry — it reads cdpClient/sessionId lazily from
  //    BrowserSession via getters, so no connection is required here.
  const registry = new ToolRegistry(
    server,
    browserSession,
  );
  registry.registerAll();

  // 5. Start the stdio transport. This is the point at which Claude Code
  //    sees us come online — still no Chrome has been launched.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Public Browser MCP server running on stdio (lazy launch enabled)");

  // 5b. Story 9.7: Script API Gateway — HTTP server on port 9223.
  //     Only started when --script flag is active. Failure to bind the
  //     port is non-fatal: MCP continues to work, only the Script API
  //     is unavailable.
  let scriptApiServer: ScriptApiServer | null = null;
  if (scriptMode) {
    scriptApiServer = new ScriptApiServer({
      registry,
      browserSession,
    });
    try {
      await scriptApiServer.start();
    } catch {
      // Port-in-use or other bind error — already logged inside start().
      scriptApiServer = null;
    }
  }

  // 6. Graceful shutdown — BrowserSession.shutdown() is idempotent and a
  //    no-op if Chrome was never launched.
  const shutdown = async () => {
    // Story 9.7: Stop Script API server first (closes all sessions/tabs).
    if (scriptApiServer) {
      try {
        await scriptApiServer.stop();
      } catch {
        /* best effort */
      }
    }
    try {
      await browserSession.shutdown();
    } catch {
      /* best effort */
    }
    try {
      await server.close();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
