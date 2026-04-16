import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserSession } from "./cdp/browser-session.js";
import { resolveAutoLaunch } from "./cdp/chrome-launcher.js";
import { ToolRegistry } from "./registry.js";
import { setTierLabel, setLicenseInfo } from "./overlay/session-overlay.js";
import { FreeTierLicenseStatus } from "./license/license-status.js";
import type { LicenseStatus } from "./license/license-status.js";
import { loadFreeTierConfig } from "./license/free-tier-config.js";
import { getProHooks } from "./hooks/pro-hooks.js";
import { VERSION } from "./version.js";
import { ScriptApiServer } from "./transport/script-api-server.js";

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
    console.error(`SilbercueChrome using Chrome profile: ${profilePath}`);
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
      console.error("SilbercueChrome --attach: connected to Chrome on port 9222");
    } catch {
      console.error(
        [
          "Error: --attach failed — Chrome not reachable on port 9222.",
          "Make sure Chrome is running with remote debugging enabled,",
          "or that another SilbercueChrome instance (e.g. via Claude Code) is active.",
        ].join("\n"),
      );
      process.exit(1);
    }
  }

  // 2c. Script mode: log to stderr for operator visibility.
  if (scriptMode) {
    console.error("SilbercueChrome --script: external CDP clients expected, tab ownership tracking enabled");
  }

  // 3. Resolve licence status (pure metadata — no CDP calls).
  const hooks = getProHooks();
  let licenseStatus: LicenseStatus = new FreeTierLicenseStatus();
  if (hooks.provideLicenseStatus) {
    try {
      licenseStatus = await hooks.provideLicenseStatus();
    } catch {
      // Fallback to Free Tier
    }
  }
  const freeTierConfig = loadFreeTierConfig();
  setTierLabel(licenseStatus.isPro());
  setLicenseInfo(undefined, undefined, undefined);

  // 4. Create the MCP server.
  const server = new McpServer(
    {
      name: "silbercuechrome",
      version: VERSION,
    },
    {
      instructions: [
        "SilbercueChrome controls a real Chrome browser via CDP.",
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
        "- For multi-step workflows, use run_plan to execute N steps in one call (Free: 3 steps, Pro: unlimited).",
        "- evaluate is for JS computation and style mutations (.style.X = ...) — not for CSS reading or element discovery.",
        "- Avoid evaluate as default recovery after click/type errors — call view_page for fresh refs and retry with the dedicated tool.",
      ].join("\n"),
    },
  );

  // 5. Create the ToolRegistry — it reads cdpClient/sessionId lazily from
  //    BrowserSession via getters, so no connection is required here.
  const registry = new ToolRegistry(
    server,
    browserSession,
    licenseStatus,
    freeTierConfig,
  );
  registry.registerAll();

  // 6. Start the stdio transport. This is the point at which Claude Code
  //    sees us come online — still no Chrome has been launched.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SilbercueChrome MCP server running on stdio (lazy launch enabled)");

  // 6b. Story 9.7: Script API Gateway — HTTP server on port 9223.
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

  // 7. Graceful shutdown — BrowserSession.shutdown() is idempotent and a
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
