#!/usr/bin/env node
/**
 * Tool-Definitions Token Counter
 * Starts the MCP server, calls listTools(), and reports per-tool token estimates.
 * Budget: 5000 tokens (NFR4). Exit 1 on budget exceeded.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BUDGET = 5000;
const TIMEOUT_MS = 15_000;
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

const timeoutTimer = setTimeout(() => {
  console.error("ERROR: token-count timed out after 15 s (connect/listTools hung)");
  process.exit(1);
}, TIMEOUT_MS);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
});

const client = new Client({ name: "token-count", version: "1.0.0" });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();

  clearTimeout(timeoutTimer);

  // Per-tool estimates (for display/sorting)
  const perTool = tools.map((t) => ({
    name: t.name,
    tokens: Math.ceil(
      JSON.stringify({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }).length / 4
    ),
  }));

  perTool.sort((a, b) => b.tokens - a.tokens);

  // Total on the full serialised array (includes array overhead)
  const total = Math.ceil(JSON.stringify(tools).length / 4);

  // Output
  console.log(`\n${BOLD}Tool-Definitions Token Count${RESET}`);
  console.log("\u2550".repeat(39));

  for (const t of perTool) {
    console.log(`  ${t.name.padEnd(22)} ~${String(t.tokens).padStart(4)} tokens`);
  }

  console.log("\u2500".repeat(39));
  console.log(`  ${"TOTAL".padEnd(22)} ~${String(total).padStart(4)} tokens`);
  console.log(`  ${"BUDGET".padEnd(22)}  ${String(BUDGET).padStart(4)} tokens`);

  const pass = total < BUDGET;
  const statusText = pass
    ? `${GREEN}PASS \u2713${RESET}`
    : `${RED}FAIL \u2717${RESET}`;
  console.log(`  ${"STATUS".padEnd(22)}  ${statusText}`);
  console.log("\u2550".repeat(39) + "\n");

  process.exit(pass ? 0 : 1);
} finally {
  clearTimeout(timeoutTimer);
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
