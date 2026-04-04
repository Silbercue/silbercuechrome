import { describe, it, expect, vi, beforeEach } from "vitest";
import { consoleLogsHandler } from "./console-logs.js";
import type { ConsoleCollector, ConsoleLogEntry } from "../cdp/console-collector.js";

// --- Mock ConsoleCollector ---

function createMockCollector(entries: ConsoleLogEntry[] = []): {
  collector: ConsoleCollector;
  getAllFn: ReturnType<typeof vi.fn>;
  getFilteredFn: ReturnType<typeof vi.fn>;
  clearFn: ReturnType<typeof vi.fn>;
} {
  const getAllFn = vi.fn<[], ConsoleLogEntry[]>().mockReturnValue([...entries]);
  const getFilteredFn = vi.fn<[string?, string?], ConsoleLogEntry[]>().mockImplementation(
    (level?: string, pattern?: string) => {
      let result = [...entries];
      if (level) result = result.filter((e) => e.level === level);
      if (pattern) {
        const re = new RegExp(pattern);
        result = result.filter((e) => re.test(e.text));
      }
      return result;
    },
  );
  const clearFn = vi.fn();

  const collector = {
    getAll: getAllFn,
    getFiltered: getFilteredFn,
    clear: clearFn,
    count: entries.length,
    init: vi.fn(),
    detach: vi.fn(),
    reinit: vi.fn(),
  } as unknown as ConsoleCollector;

  return { collector, getAllFn, getFilteredFn, clearFn };
}

const SAMPLE_LOGS: ConsoleLogEntry[] = [
  { level: "info", text: "[MyApp] loaded", timestamp: 100, source: "console" },
  { level: "warning", text: "deprecated API call", timestamp: 200, source: "console" },
  { level: "error", text: "ReferenceError: x is not defined", timestamp: 300, source: "exception" },
  { level: "info", text: "[MyApp] ready", timestamp: 400, source: "console" },
  { level: "debug", text: "debug trace", timestamp: 500, source: "console" },
];

describe("consoleLogsHandler", () => {
  let mock: ReturnType<typeof createMockCollector>;

  beforeEach(() => {
    mock = createMockCollector(SAMPLE_LOGS);
  });

  it("without parameters: returns all logs as JSON with count in _meta", async () => {
    const result = await consoleLogsHandler(
      { clear: false },
      mock.collector,
    );

    expect(result.isError).toBeFalsy();
    expect(mock.getAllFn).toHaveBeenCalled();

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toHaveLength(5);
    expect(result._meta?.count).toBe(5);
  });

  it("level filter: returns only matching logs", async () => {
    const result = await consoleLogsHandler(
      { level: "error", clear: false },
      mock.collector,
    );

    expect(result.isError).toBeFalsy();
    expect(mock.getFilteredFn).toHaveBeenCalledWith("error", undefined);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].level).toBe("error");
  });

  it("pattern filter: matches per regex", async () => {
    const result = await consoleLogsHandler(
      { pattern: "\\[MyApp\\]", clear: false },
      mock.collector,
    );

    expect(result.isError).toBeFalsy();
    expect(mock.getFilteredFn).toHaveBeenCalledWith(undefined, "\\[MyApp\\]");

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toHaveLength(2);
  });

  it("level + pattern combined", async () => {
    const result = await consoleLogsHandler(
      { level: "info", pattern: "\\[MyApp\\]", clear: false },
      mock.collector,
    );

    expect(result.isError).toBeFalsy();
    expect(mock.getFilteredFn).toHaveBeenCalledWith("info", "\\[MyApp\\]");

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toHaveLength(2);
    parsed.forEach((entry: ConsoleLogEntry) => {
      expect(entry.level).toBe("info");
      expect(entry.text).toMatch(/\[MyApp\]/);
    });
  });

  it("clear: true clears buffer after retrieval", async () => {
    const result = await consoleLogsHandler(
      { clear: true },
      mock.collector,
    );

    expect(result.isError).toBeFalsy();
    expect(mock.clearFn).toHaveBeenCalled();

    // Logs should still be in the response (cleared AFTER retrieval)
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toHaveLength(5);
  });

  it("empty buffer: returns empty array, no error", async () => {
    const emptyMock = createMockCollector([]);

    const result = await consoleLogsHandler(
      { clear: false },
      emptyMock.collector,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual([]);
    expect(result._meta?.count).toBe(0);
  });

  it("invalid regex pattern: isError with error message", async () => {
    // Make getFiltered throw for invalid regex
    mock.getFilteredFn.mockImplementation(() => {
      throw new SyntaxError("Invalid regular expression: /[invalid/: Unterminated character class");
    });

    const result = await consoleLogsHandler(
      { pattern: "[invalid", clear: false },
      mock.collector,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Invalid regex pattern");
  });

  it("_meta contains elapsedMs and method: console_logs", async () => {
    const result = await consoleLogsHandler(
      { clear: false },
      mock.collector,
    );

    expect(result._meta).toBeDefined();
    expect(result._meta?.method).toBe("console_logs");
    expect(typeof result._meta?.elapsedMs).toBe("number");
  });
});
