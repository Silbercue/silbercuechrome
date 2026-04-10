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
export async function startServer(): Promise<void> {
  // 1. Read environment — no Chrome is touched here.
  const profilePath = process.env.SILBERCUE_CHROME_PROFILE || undefined;
  const headlessEnv = process.env.SILBERCUE_CHROME_HEADLESS === "true";
  const autoLaunch = resolveAutoLaunch(
    process.env as Record<string, string | undefined>,
    headlessEnv,
  );

  if (profilePath) {
    console.error(`SilbercueChrome using Chrome profile: ${profilePath}`);
  }

  // 2. Create the lazy BrowserSession. No launch yet.
  const browserSession = new BrowserSession({
    profilePath,
    headless: headlessEnv,
    autoLaunch,
  });

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
      version: "0.1.0",
    },
    {
      instructions: [
        "SilbercueChrome controls a real Chrome browser via CDP.",
        "",
        "Workflow: virtual_desk → switch_tab (or navigate) → read_page → click/type/fill_form using refs.",
        "",
        "Token-efficiency rules:",
        "- read_page (accessibility tree with refs like 'e5') is 10-30x cheaper than screenshot.",
        "- Screenshots CANNOT drive click/type — only read_page returns usable element refs.",
        "- fill_form beats multiple type calls for any form with 2+ fields.",
        "- CSS debugging: use inspect_element(selector) — returns computed styles, CSS rules with source:line, cascade, AND a visual clip screenshot. Do NOT use evaluate(getComputedStyle) for CSS inspection.",
        "- evaluate is for JS computation and style mutations (.style.X = ...) — not for CSS reading or element discovery.",
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

  // 7. Graceful shutdown — BrowserSession.shutdown() is idempotent and a
  //    no-op if Chrome was never launched.
  const shutdown = async () => {
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
