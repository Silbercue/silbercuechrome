/**
 * Virtual Desk Tool — thin wrapper for the Operator default tool set.
 *
 * Delegates directly to the existing virtualDeskHandler in src/tools/virtual-desk.ts.
 * Registered as one of the two top-level tools (alongside operator) in the
 * standard mode (Story 19.7, AC-5).
 *
 * Module Boundaries:
 *   - MAY import: src/tools/virtual-desk.ts (delegation target)
 *   - MUST NOT import: src/cdp/, src/registry.ts, src/operator/ (no backward deps)
 */

import { z } from "zod";

/**
 * Empty schema — virtual_desk takes no parameters.
 */
export const virtualDeskOperatorSchema = z.object({});

export type VirtualDeskOperatorParams = z.infer<typeof virtualDeskOperatorSchema>;

/**
 * Zod shape for MCP server.tool() registration.
 */
export const virtualDeskOperatorZodShape = {};
