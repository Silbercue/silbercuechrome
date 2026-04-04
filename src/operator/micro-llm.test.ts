import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaMicroLlm, NullMicroLlm, MicroLlmTimeoutError, MicroLlmUnavailableError, createMicroLlmFromEnv } from "./micro-llm.js";
import type { MicroLlmConfig, MicroLlmRequest, MicroLlmAction } from "./types.js";

const DEFAULT_CONFIG: MicroLlmConfig = {
  endpoint: "http://localhost:11434",
  model: "qwen2.5:3b",
  timeoutMs: 500,
  minConfidence: 0.6,
};

function createRequest(overrides?: Partial<MicroLlmRequest>): MicroLlmRequest {
  return {
    a11ySnippet: "button 'Submit' [e5]\ntext 'Email' [e6]",
    stepContext: { tool: "click", params: { ref: "e5" } },
    errorDescription: "Element e5 not found",
    possibleActions: [
      { type: "click-alternative", description: "Click a different element" },
      { type: "skip-step" },
      { type: "fail-step", reason: "No suitable element found" },
    ],
    ...overrides,
  };
}

describe("OllamaMicroLlm", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("isAvailable()", () => {
    it("returns true when endpoint is reachable and model is listed", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { name: "qwen2.5:3b" },
            { name: "phi3:mini" },
          ],
        }),
      }));

      const llm = new OllamaMicroLlm(DEFAULT_CONFIG);
      const result = await llm.isAvailable();

      expect(result).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/tags",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns false when model is not in the list", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ name: "llama3:latest" }],
        }),
      }));

      const llm = new OllamaMicroLlm(DEFAULT_CONFIG);
      const result = await llm.isAvailable();

      expect(result).toBe(false);
    });

    it("returns false on network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const llm = new OllamaMicroLlm(DEFAULT_CONFIG);
      const result = await llm.isAvailable();

      expect(result).toBe(false);
    });

    it("returns false on HTTP error status", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }));

      const llm = new OllamaMicroLlm(DEFAULT_CONFIG);
      const result = await llm.isAvailable();

      expect(result).toBe(false);
    });

    it("returns false on timeout (abort)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        // Simulate slow response — check for abort signal
        return new Promise((_resolve, reject) => {
          const signal = opts.signal as AbortSignal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("AbortError");
              err.name = "AbortError";
              reject(err);
            });
          }
          // Never resolve — let the timeout (1s) kick in
        });
      }));

      const llm = new OllamaMicroLlm(DEFAULT_CONFIG);
      const result = await llm.isAvailable();

      expect(result).toBe(false);
    }, 3000);
  });

  describe("decide()", () => {
    it("parses correct JSON response from Ollama", async () => {
      const ollamaResponse = {
        response: '{"action_index": 0, "alternative_ref": "e7", "confidence": 0.85}',
        done: true,
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ollamaResponse,
      }));

      const llm = new OllamaMicroLlm(DEFAULT_CONFIG);
      const request = createRequest();
      const result = await llm.decide(request);

      expect(result.action).toEqual(request.possibleActions[0]);
      expect(result.alternativeRef).toBe("e7");
      expect(result.confidence).toBe(0.85);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("sends correct request body to Ollama /api/generate", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: '{"action_index": 1, "alternative_ref": null, "confidence": 0.7}',
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const llm = new OllamaMicroLlm(DEFAULT_CONFIG);
      await llm.decide(createRequest());

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/generate",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining('"model":"qwen2.5:3b"'),
        }),
      );

      // Verify body contains stream: false and temperature: 0.1
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.stream).toBe(false);
      expect(callBody.options.temperature).toBe(0.1);
    });

    it("throws MicroLlmTimeoutError on timeout", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = opts.signal as AbortSignal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted.");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      }));

      const config = { ...DEFAULT_CONFIG, timeoutMs: 50 };
      const llm = new OllamaMicroLlm(config);

      await expect(llm.decide(createRequest())).rejects.toThrow(MicroLlmTimeoutError);
      await expect(llm.decide(createRequest())).rejects.toThrow("Micro-LLM timeout after 50ms");
    }, 3000);

    it("throws MicroLlmUnavailableError on network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const llm = new OllamaMicroLlm(DEFAULT_CONFIG);

      await expect(llm.decide(createRequest())).rejects.toThrow(MicroLlmUnavailableError);
    });

    it("throws MicroLlmUnavailableError on HTTP error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      }));

      const llm = new OllamaMicroLlm(DEFAULT_CONFIG);

      await expect(llm.decide(createRequest())).rejects.toThrow(MicroLlmUnavailableError);
      await expect(llm.decide(createRequest())).rejects.toThrow("HTTP 503");
    });

    it("returns fail-step with confidence 0 on unparseable response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: "I'm not sure what to do here..." }),
      }));

      const llm = new OllamaMicroLlm(DEFAULT_CONFIG);
      const result = await llm.decide(createRequest());

      expect(result.action.type).toBe("fail-step");
      expect(result.confidence).toBe(0);
    });
  });
});

// M3: createMicroLlmFromEnv respects boundary values
describe("createMicroLlmFromEnv()", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "SILBERCUE_MICRO_LLM_ENDPOINT",
    "SILBERCUE_MICRO_LLM_MODEL",
    "SILBERCUE_MICRO_LLM_TIMEOUT",
    "SILBERCUE_MICRO_LLM_MIN_CONFIDENCE",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns NullMicroLlm when endpoint is not set", () => {
    const llm = createMicroLlmFromEnv();
    expect(llm).toBeInstanceOf(NullMicroLlm);
  });

  it("returns OllamaMicroLlm when endpoint is set", () => {
    process.env.SILBERCUE_MICRO_LLM_ENDPOINT = "http://localhost:11434";
    const llm = createMicroLlmFromEnv();
    expect(llm).toBeInstanceOf(OllamaMicroLlm);
  });

  // M3: "0" should not be overwritten to default
  it("preserves minConfidence=0 instead of falling back to default (M3)", () => {
    process.env.SILBERCUE_MICRO_LLM_ENDPOINT = "http://localhost:11434";
    process.env.SILBERCUE_MICRO_LLM_MIN_CONFIDENCE = "0";
    const llm = createMicroLlmFromEnv();
    // Access internal config via decide() behavior — if minConfidence were 0.6 (default),
    // a 0.3-confidence response would be rejected. With 0, it should pass.
    // We can check via the config directly since OllamaMicroLlm stores it.
    expect(llm).toBeInstanceOf(OllamaMicroLlm);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((llm as any)._config.minConfidence).toBe(0);
  });

  it("preserves timeoutMs=0 as 0 instead of falling back to default (M3)", () => {
    process.env.SILBERCUE_MICRO_LLM_ENDPOINT = "http://localhost:11434";
    process.env.SILBERCUE_MICRO_LLM_TIMEOUT = "0";
    const llm = createMicroLlmFromEnv();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((llm as any)._config.timeoutMs).toBe(0);
  });

  it("uses defaults for unset optional values", () => {
    process.env.SILBERCUE_MICRO_LLM_ENDPOINT = "http://localhost:11434";
    const llm = createMicroLlmFromEnv();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = (llm as any)._config;
    expect(config.model).toBe("qwen2.5:3b");
    expect(config.timeoutMs).toBe(500);
    expect(config.minConfidence).toBe(0.6);
  });
});

describe("NullMicroLlm", () => {
  it("isAvailable() always returns false", async () => {
    const llm = new NullMicroLlm();
    expect(await llm.isAvailable()).toBe(false);
  });

  it("decide() always throws MicroLlmUnavailableError", async () => {
    const llm = new NullMicroLlm();

    await expect(llm.decide(createRequest())).rejects.toThrow(MicroLlmUnavailableError);
    await expect(llm.decide(createRequest())).rejects.toThrow("no provider configured");
  });
});
