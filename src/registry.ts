import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CdpClient } from "./cdp/cdp-client.js";
import type { TabStateCache } from "./cache/tab-state-cache.js";
import { evaluateSchema, evaluateHandler } from "./tools/evaluate.js";
import type { EvaluateParams } from "./tools/evaluate.js";
import { navigateSchema, navigateHandler } from "./tools/navigate.js";
import type { NavigateParams } from "./tools/navigate.js";
import { readPageSchema, readPageHandler } from "./tools/read-page.js";
import type { ReadPageParams } from "./tools/read-page.js";
import { screenshotSchema, screenshotHandler } from "./tools/screenshot.js";
import type { ScreenshotParams } from "./tools/screenshot.js";
import { waitForSchema, waitForHandler } from "./tools/wait-for.js";
import type { WaitForParams } from "./tools/wait-for.js";
import { clickSchema, clickHandler } from "./tools/click.js";
import type { ClickParams } from "./tools/click.js";
import { typeSchema, typeHandler } from "./tools/type.js";
import type { TypeParams } from "./tools/type.js";
import { tabStatusHandler } from "./tools/tab-status.js";
import type { TabStatusParams } from "./tools/tab-status.js";
import { switchTabSchema, switchTabHandler } from "./tools/switch-tab.js";
import type { SwitchTabParams } from "./tools/switch-tab.js";

export class ToolRegistry {
  private _sessionId: string;

  constructor(
    private server: McpServer,
    private cdpClient: CdpClient,
    sessionId: string,
    private _tabStateCache: TabStateCache,
  ) {
    this._sessionId = sessionId;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  updateSession(sessionId: string): void {
    this._sessionId = sessionId;
  }

  registerAll(): void {
    this.server.tool(
      "evaluate",
      "Execute JavaScript in the browser page context and return the result",
      {
        expression: evaluateSchema.shape.expression,
        await_promise: evaluateSchema.shape.await_promise,
      },
      async (params) => {
        return evaluateHandler(params as unknown as EvaluateParams, this.cdpClient, this.sessionId);
      },
    );

    this.server.tool(
      "navigate",
      "Navigate to a URL or go back, waits for page to settle before returning",
      {
        url: navigateSchema.shape.url,
        action: navigateSchema.shape.action,
        settle_ms: navigateSchema.shape.settle_ms,
      },
      async (params) => {
        return navigateHandler(params as unknown as NavigateParams, this.cdpClient, this.sessionId);
      },
    );

    this.server.tool(
      "read_page",
      "Read page content via accessibility tree with stable element refs",
      {
        depth: readPageSchema.shape.depth,
        ref: readPageSchema.shape.ref,
        filter: readPageSchema.shape.filter,
      },
      async (params) => {
        return readPageHandler(params as unknown as ReadPageParams, this.cdpClient, this.sessionId);
      },
    );

    this.server.tool(
      "screenshot",
      "Take a compressed WebP screenshot of the current page (max 800px wide, <100KB)",
      {
        full_page: screenshotSchema.shape.full_page,
      },
      async (params) => {
        return screenshotHandler(params as unknown as ScreenshotParams, this.cdpClient, this.sessionId);
      },
    );

    this.server.tool(
      "wait_for",
      "Wait for a condition: element visible, network idle, or JS expression true",
      {
        condition: waitForSchema.shape.condition,
        selector: waitForSchema.shape.selector,
        expression: waitForSchema.shape.expression,
        timeout: waitForSchema.shape.timeout,
      },
      async (params) => {
        return waitForHandler(params as unknown as WaitForParams, this.cdpClient, this.sessionId);
      },
    );

    this.server.tool(
      "click",
      "Click an element by A11y-Tree ref (e.g. 'e5') or CSS selector, waits for page to settle",
      {
        ref: clickSchema.shape.ref,
        selector: clickSchema.shape.selector,
      },
      async (params) => {
        return clickHandler(params as unknown as ClickParams, this.cdpClient, this.sessionId);
      },
    );

    this.server.tool(
      "type",
      "Type text into an input field identified by ref or CSS selector",
      {
        ref: typeSchema.shape.ref,
        selector: typeSchema.shape.selector,
        text: typeSchema.shape.text,
        clear: typeSchema.shape.clear,
      },
      async (params) => {
        return typeHandler(params as unknown as TypeParams, this.cdpClient, this.sessionId);
      },
    );

    this.server.tool(
      "tab_status",
      "Get cached tab state: URL, title, DOM-ready status, console errors. Instant from cache.",
      {},
      async (params) => {
        return tabStatusHandler(
          params as unknown as TabStatusParams,
          this.cdpClient,
          this.sessionId,
          this._tabStateCache,
        );
      },
    );

    this.server.tool(
      "switch_tab",
      "Open, switch to, or close browser tabs",
      {
        action: switchTabSchema.shape.action,
        url: switchTabSchema.shape.url,
        tab_id: switchTabSchema.shape.tab_id,
      },
      async (params) => {
        return switchTabHandler(
          params as unknown as SwitchTabParams,
          this.cdpClient,
          this.sessionId,
          this._tabStateCache,
          (newSessionId) => {
            this.updateSession(newSessionId);
          },
        );
      },
    );
  }
}
