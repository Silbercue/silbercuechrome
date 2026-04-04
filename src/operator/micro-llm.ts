import type { MicroLlmProvider, MicroLlmRequest, MicroLlmResponse, MicroLlmConfig } from "./types.js";
import { buildMicroLlmPrompt, parseDecisionResponse } from "./micro-llm-prompt.js";

// --- Factory ---

/**
 * Create a MicroLlmProvider from environment variables.
 *
 * Env vars:
 *   SILBERCUE_MICRO_LLM_ENDPOINT  → endpoint (required for OllamaMicroLlm; if unset → NullMicroLlm)
 *   SILBERCUE_MICRO_LLM_MODEL     → model (default: "qwen2.5:3b")
 *   SILBERCUE_MICRO_LLM_TIMEOUT   → timeoutMs (default: 500)
 *   SILBERCUE_MICRO_LLM_MIN_CONFIDENCE → minConfidence (default: 0.6)
 */
export function createMicroLlmFromEnv(): MicroLlmProvider {
  const endpoint = process.env.SILBERCUE_MICRO_LLM_ENDPOINT;
  if (!endpoint) {
    return new NullMicroLlm();
  }
  // M3: Use explicit undefined checks instead of || to preserve valid boundary values (e.g. 0)
  const rawModel = process.env.SILBERCUE_MICRO_LLM_MODEL;
  const rawTimeout = process.env.SILBERCUE_MICRO_LLM_TIMEOUT;
  const rawMinConfidence = process.env.SILBERCUE_MICRO_LLM_MIN_CONFIDENCE;

  const parsedTimeout = rawTimeout !== undefined && rawTimeout !== null
    ? parseInt(rawTimeout, 10)
    : NaN;
  const parsedMinConfidence = rawMinConfidence !== undefined && rawMinConfidence !== null
    ? parseFloat(rawMinConfidence)
    : NaN;

  const config: MicroLlmConfig = {
    endpoint,
    model: rawModel !== undefined && rawModel !== null ? rawModel : "qwen2.5:3b",
    timeoutMs: Number.isFinite(parsedTimeout) ? parsedTimeout : 500,
    minConfidence: Number.isFinite(parsedMinConfidence) ? parsedMinConfidence : 0.6,
  };
  return new OllamaMicroLlm(config);
}

// --- Custom Error Classes ---

export class MicroLlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`Micro-LLM timeout after ${ms}ms`);
    this.name = "MicroLlmTimeoutError";
  }
}

export class MicroLlmUnavailableError extends Error {
  constructor(reason: string) {
    super(`Micro-LLM unavailable: ${reason}`);
    this.name = "MicroLlmUnavailableError";
  }
}

// --- OllamaMicroLlm ---

/**
 * MicroLlmProvider implementation backed by a local Ollama instance.
 * Uses built-in fetch() (Node.js 18+) — no external HTTP dependencies.
 */
export class OllamaMicroLlm implements MicroLlmProvider {
  private _config: MicroLlmConfig;

  constructor(config: MicroLlmConfig) {
    this._config = config;
  }

  /**
   * Check if Ollama is reachable and the configured model is available.
   * GET /api/tags with 1s timeout.
   */
  async isAvailable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const res = await fetch(`${this._config.endpoint}/api/tags`, {
        signal: controller.signal,
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      const models = data.models ?? [];
      return models.some((m) => m.name === this._config.model);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a micro-decision request to Ollama /api/generate.
   * Enforces timeout via AbortController.
   */
  async decide(request: MicroLlmRequest): Promise<MicroLlmResponse> {
    const prompt = buildMicroLlmPrompt(request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._config.timeoutMs);
    const start = performance.now();

    try {
      const res = await fetch(`${this._config.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this._config.model,
          prompt,
          stream: false,
          options: { temperature: 0.1 },
        }),
        signal: controller.signal,
      });

      const latencyMs = Math.round(performance.now() - start);

      if (!res.ok) {
        throw new MicroLlmUnavailableError(`HTTP ${res.status}`);
      }

      const data = (await res.json()) as { response?: string };
      const raw = data.response ?? "";

      return parseDecisionResponse(raw, request.possibleActions, latencyMs);
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start);
      if (err instanceof MicroLlmUnavailableError) throw err;
      if (err instanceof MicroLlmTimeoutError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new MicroLlmTimeoutError(this._config.timeoutMs);
      }
      throw new MicroLlmUnavailableError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- NullMicroLlm ---

/**
 * Null-object implementation used when no Micro-LLM is configured.
 * isAvailable() always returns false, decide() always throws.
 */
export class NullMicroLlm implements MicroLlmProvider {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async decide(_request: MicroLlmRequest): Promise<MicroLlmResponse> {
    throw new MicroLlmUnavailableError("no provider configured");
  }
}
