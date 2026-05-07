import { z } from "zod";
import type { SessionDefaults } from "../cache/session-defaults.js";
import type { ToolResponse } from "../types.js";
import { discoverProfiles } from "../cdp/chrome-profiles.js";

export const configureSessionSchema = z.object({
  defaults: z.record(z.unknown())
    .optional()
    .describe("Set session defaults. Keys: param names (tab, timeout, etc.). Values: default values. null removes a default."),
  autoPromote: z.boolean()
    .optional()
    .describe("If true, apply all current auto-promote suggestions as defaults"),
  profile: z.string()
    .optional()
    .describe("Chrome profile name (e.g. \"Julian\", \"Business\"). Only works BEFORE the first browser interaction. Use `public-browser profiles` to list available profiles."),
});

export type ConfigureSessionParams = z.infer<typeof configureSessionSchema>;

export async function configureSessionHandler(
  params: ConfigureSessionParams,
  sessionDefaults: SessionDefaults,
  browserReady?: boolean,
): Promise<ToolResponse> {
  const start = performance.now();

  // Profile parameter: reject if browser is already running
  if (params.profile !== undefined) {
    if (browserReady) {
      const profiles = discoverProfiles();
      const available = profiles.map((p) => `"${p.name}"`).join(", ");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Cannot change Chrome profile after browser is already running. Set the profile before the first browser interaction, or restart with --profile or PUBLIC_BROWSER_PROFILE env var.",
            available_profiles: available,
          }),
        }],
        isError: true,
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "configure_session" },
      };
    }
    sessionDefaults.setDefault("_profile", params.profile);
  }

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
