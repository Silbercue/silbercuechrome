import { z } from "zod";
import type { SessionDefaults } from "../cache/session-defaults.js";
import type { ToolResponse } from "../types.js";

export const configureSessionSchema = z.object({
  defaults: z.record(z.unknown())
    .optional()
    .describe("Set session defaults. Keys: param names (tab, timeout, etc.). Values: default values. null removes a default."),
  autoPromote: z.boolean()
    .optional()
    .describe("If true, apply all current auto-promote suggestions as defaults"),
});

export type ConfigureSessionParams = z.infer<typeof configureSessionSchema>;

export async function configureSessionHandler(
  params: ConfigureSessionParams,
  sessionDefaults: SessionDefaults,
): Promise<ToolResponse> {
  const start = performance.now();

  // H4 fix: Process defaults and autoPromote independently (no early return)
  let applied: Record<string, unknown> | undefined;

  // defaults gesetzt → Defaults aktualisieren
  if (params.defaults) {
    for (const [key, value] of Object.entries(params.defaults)) {
      sessionDefaults.setDefault(key, value);
    }
  }

  // autoPromote: true → alle Vorschlaege als Defaults uebernehmen
  if (params.autoPromote) {
    applied = sessionDefaults.applyAllSuggestions();
  }

  // Build response based on what was requested
  if (params.defaults !== undefined || params.autoPromote) {
    const payload: Record<string, unknown> = {
      defaults: sessionDefaults.getAllDefaults(),
    };
    if (applied !== undefined) {
      payload.applied = applied;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      _meta: { elapsedMs: Math.round(performance.now() - start), method: "configure_session" },
    };
  }

  // Keine Parameter → aktuelle Defaults + Vorschlaege abfragen
  return {
    content: [{ type: "text", text: JSON.stringify({
      defaults: sessionDefaults.getAllDefaults(),
      autoPromote: sessionDefaults.getSuggestions(),
    }) }],
    _meta: { elapsedMs: Math.round(performance.now() - start), method: "configure_session" },
  };
}
