/**
 * Unit tests for scripts/publish.ts
 *
 * Mocks child_process.execFileSync and fs functions — no real CLI calls.
 * NOTE: All shell execution in publish.ts uses execFileSync (not execSync)
 * to prevent shell injection. Tests mock execFileSync accordingly.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { PhaseResult, PublishOptions, RepoContext } from "./publish.js";

// ── Mocks ─────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

// Import after mocks are set up
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import {
  parseArgs,
  run,
  runOrNull,
  phase1_checkRepoStatus,
  phase2_commitAndPush,
  phase3_combinedBuild,
  phase4_versionTag,
  phase5_publishAndRelease,
  phase6_verify,
  main,
  CONFIG,
} from "./publish.js";

// Use the same BRANCH/REMOTE as the script under test, so that env-overrides
// (SILBERCUE_PUBLISH_BRANCH / SILBERCUE_PUBLISH_REMOTE) propagate to the tests.
const BRANCH = CONFIG.BRANCH;
const REMOTE = CONFIG.REMOTE;

const mockExecFileSync = execFileSync as Mock;
const mockReadFileSync = readFileSync as Mock;
const mockExistsSync = existsSync as Mock;

const FREE_REPO = "/repos/free";
const PRO_REPO = "/repos/pro";

// ── Helpers ───────────────────────────────────────────────────────────

function makeContext(overrides?: Partial<RepoContext>): RepoContext {
  return {
    freeRepo: FREE_REPO,
    proRepo: PRO_REPO,
    proRepoExists: false,
    version: "0.1.0",
    tag: "v0.1.0",
    ...overrides,
  };
}

function dryRunOpts(overrides?: Partial<PublishOptions>): PublishOptions {
  return { dryRun: true, skipNpm: false, skipGithub: false, ...overrides };
}

function realOpts(overrides?: Partial<PublishOptions>): PublishOptions {
  return { dryRun: false, skipNpm: false, skipGithub: false, ...overrides };
}

/**
 * Setup execFileSync mock with a command-pattern lookup.
 * Each entry maps [cmd, ...argSubstrings] to a return value.
 */
function setupMock(
  responses: Array<{ match: string[]; result: string }>,
  fallback = "",
): void {
  mockExecFileSync.mockImplementation(
    (cmd: string, args: string[], _opts: unknown) => {
      for (const r of responses) {
        const fullArgs = [cmd, ...args].join(" ");
        if (r.match.every((m) => fullArgs.includes(m))) {
          return r.result;
        }
      }
      return fallback;
    },
  );
}

/**
 * Setup execFileSync to throw for specific command patterns.
 */
function setupMockWithErrors(
  responses: Array<{ match: string[]; result?: string; error?: string }>,
  fallback = "",
): void {
  mockExecFileSync.mockImplementation(
    (cmd: string, args: string[], _opts: unknown) => {
      for (const r of responses) {
        const fullArgs = [cmd, ...args].join(" ");
        if (r.match.every((m) => fullArgs.includes(m))) {
          if (r.error) {
            throw new Error(r.error);
          }
          return r.result ?? "";
        }
      }
      return fallback;
    },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("parses --dry-run flag", () => {
    expect(parseArgs(["--dry-run"])).toEqual({
      dryRun: true,
      skipNpm: false,
      skipGithub: false,
    });
  });

  it("parses --skip-npm flag", () => {
    expect(parseArgs(["--skip-npm"])).toEqual({
      dryRun: false,
      skipNpm: true,
      skipGithub: false,
    });
  });

  it("parses --skip-github flag", () => {
    expect(parseArgs(["--skip-github"])).toEqual({
      dryRun: false,
      skipNpm: false,
      skipGithub: true,
    });
  });

  it("parses all flags combined", () => {
    expect(parseArgs(["--dry-run", "--skip-npm", "--skip-github"])).toEqual({
      dryRun: true,
      skipNpm: true,
      skipGithub: true,
    });
  });

  it("returns all false for no flags", () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      skipNpm: false,
      skipGithub: false,
    });
  });
});

describe("run / runOrNull", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("run returns trimmed stdout", () => {
    mockExecFileSync.mockReturnValue("  hello world  \n");
    expect(run("echo", ["hello"], "/tmp")).toBe("hello world");
  });

  it("run throws on failure", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    expect(() => run("bad", ["cmd"], "/tmp")).toThrow("command failed");
  });

  it("runOrNull returns null on failure", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("fail");
    });
    expect(runOrNull("bad", ["cmd"], "/tmp")).toBeNull();
  });

  it("runOrNull returns value on success", () => {
    mockExecFileSync.mockReturnValue("ok\n");
    expect(runOrNull("good", ["cmd"], "/tmp")).toBe("ok");
  });
});

describe("phase1_checkRepoStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails when git is not available", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = phase1_checkRepoStatus(FREE_REPO, PRO_REPO);
    expect(result.success).toBe(false);
    expect(result.message).toBe("git CLI not found");
  });

  it("fails when npm is not authenticated", () => {
    setupMockWithErrors([
      { match: ["git", "--version"], result: "git version 2.40" },
      { match: ["npm", "whoami"], error: "not logged in" },
    ]);

    const result = phase1_checkRepoStatus(FREE_REPO, PRO_REPO);
    expect(result.success).toBe(false);
    expect(result.message).toContain("npm not authenticated");
  });

  it("fails when gh is not authenticated", () => {
    setupMockWithErrors([
      { match: ["git", "--version"], result: "git version 2.40" },
      { match: ["npm", "whoami"], result: "julian" },
      { match: ["gh", "auth", "status"], error: "not logged in" },
    ]);

    const result = phase1_checkRepoStatus(FREE_REPO, PRO_REPO);
    expect(result.success).toBe(false);
    expect(result.message).toContain("gh CLI not authenticated");
  });

  it("fails when free repo has dirty working directory", () => {
    setupMock([
      { match: ["git", "--version"], result: "git version 2.40" },
      { match: ["npm", "whoami"], result: "julian" },
      { match: ["gh", "auth", "status"], result: "Logged in" },
      { match: ["git", "status", "--porcelain"], result: "M src/index.ts" },
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "0.1.0" }));

    const result = phase1_checkRepoStatus(FREE_REPO, PRO_REPO);
    expect(result.success).toBe(false);
    expect(result.message).toContain("uncommitted changes");
  });

  it("fails when free repo is not on configured branch", () => {
    setupMock([
      { match: ["git", "--version"], result: "git version 2.40" },
      { match: ["npm", "whoami"], result: "julian" },
      { match: ["gh", "auth", "status"], result: "Logged in" },
      { match: ["git", "status", "--porcelain"], result: "" },
      { match: ["git", "rev-parse", "--abbrev-ref"], result: "feature/xyz" },
      { match: ["git", "remote", "get-url"], result: `git@github.com:foo/bar.git` },
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "0.1.0" }));

    const result = phase1_checkRepoStatus(FREE_REPO, PRO_REPO);
    expect(result.success).toBe(false);
    expect(result.message).toContain("feature/xyz");
    expect(result.message).toContain(`expected '${BRANCH}'`);
  });

  it("detects version mismatch between free and pro repos (AC #2)", () => {
    mockExecFileSync.mockImplementation(
      (cmd: string, args: string[], _opts: { cwd: string }) => {
        const fullArgs = [cmd, ...args].join(" ");
        if (fullArgs.includes("--version")) return "git version 2.40";
        if (fullArgs.includes("whoami")) return "julian";
        if (fullArgs.includes("auth status")) return "Logged in";
        if (fullArgs.includes("--porcelain")) return "";
        if (fullArgs.includes("--abbrev-ref")) return BRANCH;
        if (fullArgs.includes("remote get-url")) return "git@github.com:foo/bar.git";
        return "";
      },
    );

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes(FREE_REPO)) {
        return JSON.stringify({ version: "1.2.3" });
      }
      return JSON.stringify({ version: "1.2.4" });
    });

    const result = phase1_checkRepoStatus(FREE_REPO, PRO_REPO);
    expect(result.success).toBe(false);
    expect(result.message).toBe("Version mismatch: free=1.2.3, pro=1.2.4");
  });

  it("succeeds for free-only release when pro repo does not exist", () => {
    setupMock([
      { match: ["git", "--version"], result: "git version 2.40" },
      { match: ["npm", "whoami"], result: "julian" },
      { match: ["gh", "auth", "status"], result: "Logged in" },
      { match: ["git", "status", "--porcelain"], result: "" },
      { match: ["git", "rev-parse", "--abbrev-ref"], result: BRANCH },
      { match: ["git", "remote", "get-url"], result: "git@github.com:foo/bar.git" },
    ]);

    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes(PRO_REPO)) return false;
      return true;
    });
    // Phase 0: package.json must NOT be private — Phase 1 throws otherwise.
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ version: "0.1.0", private: false }),
    );

    const result = phase1_checkRepoStatus(FREE_REPO, PRO_REPO);
    expect(result.success).toBe(true);
    expect(result.context).toBeDefined();
    expect(result.context!.proRepoExists).toBe(false);
    expect(result.context!.version).toBe("0.1.0");
    expect(result.context!.tag).toBe("v0.1.0");
  });

  it("throws when free package.json has private:true", () => {
    setupMock([
      { match: ["git", "--version"], result: "git version 2.40" },
      { match: ["npm", "whoami"], result: "julian" },
      { match: ["gh", "auth", "status"], result: "Logged in" },
      { match: ["git", "status", "--porcelain"], result: "" },
      { match: ["git", "rev-parse", "--abbrev-ref"], result: BRANCH },
      { match: ["git", "remote", "get-url"], result: "git@github.com:foo/bar.git" },
    ]);

    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes(PRO_REPO)) return false;
      return true;
    });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ version: "0.1.0", private: true }),
    );

    expect(() => phase1_checkRepoStatus(FREE_REPO, PRO_REPO)).toThrow(/private/);
  });

  it("fails when free repo has no configured remote", () => {
    setupMockWithErrors([
      { match: ["git", "--version"], result: "git version 2.40" },
      { match: ["npm", "whoami"], result: "julian" },
      { match: ["gh", "auth", "status"], result: "Logged in" },
      { match: ["git", "status", "--porcelain"], result: "" },
      { match: ["git", "rev-parse", "--abbrev-ref"], result: BRANCH },
      { match: ["git", "remote", "get-url"], error: "No such remote" },
    ]);

    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes(PRO_REPO)) return false;
      return true;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "0.1.0" }));

    const result = phase1_checkRepoStatus(FREE_REPO, PRO_REPO);
    expect(result.success).toBe(false);
    expect(result.message).toContain("no '" + REMOTE + "' remote");
  });

  it("succeeds with both repos in sync", () => {
    mockExecFileSync.mockImplementation(
      (cmd: string, args: string[], _opts: { cwd: string }) => {
        const fullArgs = [cmd, ...args].join(" ");
        if (fullArgs.includes("--version")) return "git version 2.40";
        if (fullArgs.includes("whoami")) return "julian";
        if (fullArgs.includes("auth status")) return "Logged in";
        if (fullArgs.includes("--porcelain")) return "";
        if (fullArgs.includes("--abbrev-ref")) return BRANCH;
        if (fullArgs.includes("remote get-url")) return "git@github.com:foo/bar.git";
        return "";
      },
    );
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "0.1.0" }));

    const result = phase1_checkRepoStatus(FREE_REPO, PRO_REPO);
    expect(result.success).toBe(true);
    expect(result.context!.proRepoExists).toBe(true);
    expect(result.context!.version).toBe("0.1.0");
  });
});

describe("phase2_commitAndPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports repos already in sync", () => {
    setupMock([
      { match: ["git", "log", `${REMOTE}/${BRANCH}..HEAD`], result: "" },
    ]);

    const result = phase2_commitAndPush(makeContext(), realOpts());
    expect(result.success).toBe(true);
    expect(result.message).toBe("Repos synced with remote");
  });

  it("pushes when commits are ahead", () => {
    setupMock([
      {
        match: ["git", "log", `${REMOTE}/${BRANCH}..HEAD`],
        result: "abc1234 some commit",
      },
      { match: ["git", "push", REMOTE, BRANCH], result: "" },
    ]);

    const result = phase2_commitAndPush(makeContext(), realOpts());
    expect(result.success).toBe(true);
  });

  it("dry-run does not push", () => {
    setupMock([
      {
        match: ["git", "log", `${REMOTE}/${BRANCH}..HEAD`],
        result: "abc1234 some commit",
      },
    ]);

    const result = phase2_commitAndPush(makeContext(), dryRunOpts());
    expect(result.success).toBe(true);
    // Should not have called push
    const pushCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[]).includes("push"),
    );
    expect(pushCalls).toHaveLength(0);
  });

  it("fails when push errors", () => {
    setupMockWithErrors([
      {
        match: ["git", "log", `${REMOTE}/${BRANCH}..HEAD`],
        result: "abc1234 some commit",
      },
      {
        match: ["git", "push", REMOTE, BRANCH],
        error: "rejected non-fast-forward",
      },
    ]);

    const result = phase2_commitAndPush(makeContext(), realOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain("Push failed");
    expect(result.message).toContain("free");
  });
});

describe("phase3_combinedBuild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dry-run skips actual build", () => {
    const result = phase3_combinedBuild(makeContext(), dryRunOpts());
    expect(result.success).toBe(true);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("free-only build succeeds without pro repo", () => {
    setupMock([
      { match: ["npm", "run", "build"], result: "" },
      { match: ["npm", "test"], result: "" },
    ]);

    const result = phase3_combinedBuild(makeContext(), realOpts());
    expect(result.success).toBe(true);
    expect(result.buildArtifact).toBeUndefined();
  });

  it("fails when build fails", () => {
    setupMockWithErrors([
      { match: ["npm", "run", "build"], error: "tsc error" },
    ]);

    const result = phase3_combinedBuild(makeContext(), realOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain("Free tier build failed");
  });

  it("fails when tests fail", () => {
    setupMockWithErrors([
      { match: ["npm", "run", "build"], result: "" },
      { match: ["npm", "test"], error: "3 tests failed" },
    ]);

    const result = phase3_combinedBuild(makeContext(), realOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain("Tests failed");
  });

  it("builds pro repo and creates combined binary", () => {
    const ctx = makeContext({ proRepoExists: true });
    mockExecFileSync.mockImplementation(
      (cmd: string, args: string[], _opts: { cwd: string }) => {
        const fullArgs = [cmd, ...args].join(" ");
        if (fullArgs.includes("npm pack --json")) {
          return JSON.stringify([{ filename: "silbercuechrome-pro-0.1.0.tgz", size: 12345 }]);
        }
        return "";
      },
    );

    const result = phase3_combinedBuild(ctx, realOpts());
    expect(result.success).toBe(true);
    expect(result.buildArtifact).toContain("silbercuechrome-pro-0.1.0.tgz");
  });

  it("fails with clear message when npm pack returns non-array", () => {
    const ctx = makeContext({ proRepoExists: true });
    mockExecFileSync.mockImplementation(
      (cmd: string, args: string[], _opts: { cwd: string }) => {
        const fullArgs = [cmd, ...args].join(" ");
        if (fullArgs.includes("npm pack --json")) {
          return JSON.stringify({ filename: "test.tgz", size: 100 });
        }
        return "";
      },
    );

    const result = phase3_combinedBuild(ctx, realOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain("unexpected format");
  });

  it("fails with clear message when npm pack entry lacks required fields", () => {
    const ctx = makeContext({ proRepoExists: true });
    mockExecFileSync.mockImplementation(
      (cmd: string, args: string[], _opts: { cwd: string }) => {
        const fullArgs = [cmd, ...args].join(" ");
        if (fullArgs.includes("npm pack --json")) {
          return JSON.stringify([{ name: "pkg" }]);
        }
        return "";
      },
    );

    const result = phase3_combinedBuild(ctx, realOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain("missing required fields");
  });
});

describe("phase4_versionTag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates new tag on free repo", () => {
    setupMock([
      { match: ["git", "tag", "-l"], result: "" },
      { match: ["git", "tag", "-a"], result: "" },
      { match: ["git", "push", REMOTE], result: "" },
    ]);

    const result = phase4_versionTag(makeContext(), realOpts());
    expect(result.success).toBe(true);
    expect(result.message).toContain("v0.1.0");
  });

  it("replaces existing tag (idempotent re-run, AC #4)", () => {
    setupMock([
      { match: ["git", "tag", "-l"], result: "v0.1.0" },
      { match: ["git", "tag", "-d"], result: "" },
      { match: ["git", "push", REMOTE, ":refs/tags/"], result: "" },
      { match: ["git", "tag", "-a"], result: "" },
      { match: ["git", "push", REMOTE, "v0.1.0"], result: "" },
    ]);

    const result = phase4_versionTag(makeContext(), realOpts());
    expect(result.success).toBe(true);

    // Verify tag -d was called
    const deleteCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[]).includes("-d"),
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
  });

  it("dry-run does not create or push tags", () => {
    setupMock([
      { match: ["git", "tag", "-l"], result: "" },
    ]);

    const result = phase4_versionTag(makeContext(), dryRunOpts());
    expect(result.success).toBe(true);

    // Verify no tag creation or push
    const tagCreateCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[]).includes("-a"),
    );
    expect(tagCreateCalls).toHaveLength(0);
  });

  it("sets tags on both repos when pro exists", () => {
    const ctx = makeContext({ proRepoExists: true });
    setupMock([
      { match: ["git", "tag", "-l"], result: "" },
      { match: ["git", "tag", "-a"], result: "" },
      { match: ["git", "push", REMOTE], result: "" },
    ]);

    const result = phase4_versionTag(ctx, realOpts());
    expect(result.success).toBe(true);

    // Verify tag -a called twice (once per repo)
    const tagCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[]).includes("-a"),
    );
    expect(tagCalls).toHaveLength(2);
  });
});

describe("phase5_publishAndRelease", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dry-run does not publish or create release", () => {
    const result = phase5_publishAndRelease(
      makeContext(),
      dryRunOpts(),
    );
    expect(result.success).toBe(true);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("skips npm when --skip-npm", () => {
    setupMockWithErrors([
      { match: ["gh", "release", "view"], error: "not found" },
      { match: ["gh", "release", "create"], result: "" },
    ]);

    const result = phase5_publishAndRelease(
      makeContext(),
      realOpts({ skipNpm: true }),
    );
    expect(result.success).toBe(true);

    const npmCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "npm",
    );
    expect(npmCalls).toHaveLength(0);
  });

  it("skips github when --skip-github", () => {
    setupMock([
      { match: ["npm", "publish"], result: "" },
    ]);

    const result = phase5_publishAndRelease(
      makeContext(),
      realOpts({ skipGithub: true }),
    );
    expect(result.success).toBe(true);

    const ghCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "gh",
    );
    expect(ghCalls).toHaveLength(0);
  });

  it("fails when npm publish fails (AC #3)", () => {
    setupMockWithErrors([
      { match: ["npm", "publish"], error: "403 private package" },
    ]);

    const result = phase5_publishAndRelease(makeContext(), realOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain("npm publish failed");
  });

  it("deletes existing release before re-creating (AC #4)", () => {
    setupMock([
      { match: ["npm", "publish"], result: "" },
      { match: ["gh", "release", "view"], result: "tag: v0.1.0" },
      { match: ["gh", "release", "delete"], result: "" },
      { match: ["gh", "release", "create"], result: "" },
    ]);

    const result = phase5_publishAndRelease(makeContext(), realOpts());
    expect(result.success).toBe(true);

    const deleteCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "gh" &&
        (c[1] as string[]).includes("delete"),
    );
    expect(deleteCalls).toHaveLength(1);
  });

  it("uploads build artifact with --clobber", () => {
    setupMockWithErrors([
      { match: ["npm", "publish"], result: "" },
      { match: ["gh", "release", "view"], error: "not found" },
      { match: ["gh", "release", "create"], result: "" },
      { match: ["gh", "release", "upload"], result: "" },
    ]);

    const result = phase5_publishAndRelease(
      makeContext(),
      realOpts(),
      "/path/to/binary.tgz",
    );
    expect(result.success).toBe(true);

    const uploadCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "gh" &&
        (c[1] as string[]).includes("upload"),
    );
    expect(uploadCalls).toHaveLength(1);
    expect((uploadCalls[0][1] as string[]).join(" ")).toContain("--clobber");
  });
});

describe("phase6_verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dry-run skips verification", () => {
    const result = phase6_verify(makeContext(), dryRunOpts());
    expect(result.success).toBe(true);
    expect(result.message).toContain("Dry-run");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("succeeds when all checks pass", () => {
    const ctx = makeContext();
    setupMock([
      { match: ["npm", "view"], result: "0.1.0" },
      { match: ["gh", "release", "view"], result: "v0.1.0" },
      { match: ["git", "ls-remote", "--tags"], result: "abc123\trefs/tags/v0.1.0" },
    ]);

    const result = phase6_verify(ctx, realOpts());
    expect(result.success).toBe(true);
    expect(result.message).toBe("All verifications passed");
  });

  it("returns warnings (not failure) when checks fail", () => {
    const ctx = makeContext();
    setupMockWithErrors([
      { match: ["npm", "view"], error: "not found" },
      { match: ["gh", "release", "view"], error: "not found" },
      { match: ["git", "ls-remote"], result: "" },
    ]);

    const result = phase6_verify(ctx, realOpts());
    // Phase 6 warns but does not fail
    expect(result.success).toBe(true);
    expect(result.message).toContain("warning");
  });

  it("skips npm check with --skip-npm", () => {
    setupMockWithErrors([
      { match: ["gh", "release", "view"], error: "not found" },
      { match: ["git", "ls-remote"], result: "abc123\trefs/tags/v0.1.0" },
    ]);

    const result = phase6_verify(
      makeContext(),
      realOpts({ skipNpm: true }),
    );
    expect(result.success).toBe(true);

    const npmCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "npm",
    );
    expect(npmCalls).toHaveLength(0);
  });

  it("skips github check with --skip-github", () => {
    setupMock([
      { match: ["npm", "view"], result: "0.1.0" },
      { match: ["git", "ls-remote"], result: "abc123\trefs/tags/v0.1.0" },
    ]);

    const result = phase6_verify(
      makeContext(),
      realOpts({ skipGithub: true }),
    );
    expect(result.success).toBe(true);

    const ghCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "gh",
    );
    expect(ghCalls).toHaveLength(0);
  });
});

describe("error reporting format (AC #3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("phase2 reports which phase failed", () => {
    setupMockWithErrors([
      {
        match: ["git", "log", `${REMOTE}/${BRANCH}..HEAD`],
        result: "abc commit",
      },
      {
        match: ["git", "push"],
        error: "rejected",
      },
    ]);

    const result = phase2_commitAndPush(makeContext(), realOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain("Push failed");
    expect(result.message).toContain("free repo");
  });

  it("phase3 reports build failure clearly", () => {
    setupMockWithErrors([
      { match: ["npm", "run", "build"], error: "TS2304: Cannot find name" },
    ]);

    const result = phase3_combinedBuild(makeContext(), realOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain("Free tier build failed");
  });

  it("phase4 reports tag creation failure", () => {
    setupMockWithErrors([
      { match: ["git", "tag", "-l"], result: "" },
      { match: ["git", "tag", "-a"], error: "fatal: tag already exists" },
    ]);

    const result = phase4_versionTag(makeContext(), realOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain("Tag creation failed");
  });
});

describe("auth-check skip behavior (H1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("--dry-run skips npm whoami and gh auth status", () => {
    setupMock([
      { match: ["git", "--version"], result: "git version 2.40" },
      { match: ["git", "status", "--porcelain"], result: "" },
      { match: ["git", "rev-parse", "--abbrev-ref"], result: BRANCH },
      { match: ["git", "remote", "get-url"], result: "git@github.com:foo/bar.git" },
    ]);

    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes(PRO_REPO)) return false;
      return true;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "0.1.0" }));

    const result = phase1_checkRepoStatus(FREE_REPO, PRO_REPO, dryRunOpts());
    expect(result.success).toBe(true);

    // Verify npm whoami was NOT called
    const npmCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "npm" &&
        (c[1] as string[]).includes("whoami"),
    );
    expect(npmCalls).toHaveLength(0);

    // Verify gh auth status was NOT called
    const ghCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "gh" &&
        (c[1] as string[]).includes("auth"),
    );
    expect(ghCalls).toHaveLength(0);
  });

  it("--skip-npm skips npm whoami but still checks gh auth", () => {
    setupMock([
      { match: ["git", "--version"], result: "git version 2.40" },
      { match: ["gh", "auth", "status"], result: "Logged in" },
      { match: ["git", "status", "--porcelain"], result: "" },
      { match: ["git", "rev-parse", "--abbrev-ref"], result: BRANCH },
      { match: ["git", "remote", "get-url"], result: "git@github.com:foo/bar.git" },
    ]);

    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes(PRO_REPO)) return false;
      return true;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "0.1.0" }));

    const result = phase1_checkRepoStatus(
      FREE_REPO,
      PRO_REPO,
      realOpts({ skipNpm: true }),
    );
    expect(result.success).toBe(true);

    // Verify npm whoami was NOT called
    const npmCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "npm" &&
        (c[1] as string[]).includes("whoami"),
    );
    expect(npmCalls).toHaveLength(0);

    // Verify gh auth status WAS called
    const ghCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "gh" &&
        (c[1] as string[]).includes("auth"),
    );
    expect(ghCalls).toHaveLength(1);
  });

  it("--skip-github skips gh auth but still checks npm whoami", () => {
    setupMock([
      { match: ["git", "--version"], result: "git version 2.40" },
      { match: ["npm", "whoami"], result: "julian" },
      { match: ["git", "status", "--porcelain"], result: "" },
      { match: ["git", "rev-parse", "--abbrev-ref"], result: BRANCH },
      { match: ["git", "remote", "get-url"], result: "git@github.com:foo/bar.git" },
    ]);

    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes(PRO_REPO)) return false;
      return true;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "0.1.0" }));

    const result = phase1_checkRepoStatus(
      FREE_REPO,
      PRO_REPO,
      realOpts({ skipGithub: true }),
    );
    expect(result.success).toBe(true);

    // Verify gh auth status was NOT called
    const ghCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "gh" &&
        (c[1] as string[]).includes("auth"),
    );
    expect(ghCalls).toHaveLength(0);

    // Verify npm whoami WAS called
    const npmCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "npm" &&
        (c[1] as string[]).includes("whoami"),
    );
    expect(npmCalls).toHaveLength(1);
  });
});

describe("phase-specific error messages in main (H2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("main reports phase-specific error when phase1 throws unexpectedly", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Make git --version throw an unexpected error (not via runOrNull pattern)
    mockExecFileSync.mockImplementation(() => {
      throw new Error("unexpected crash");
    });

    await main(["node", "publish.ts"]);

    const fatalCalls = errorSpy.mock.calls
      .map((c) => c[0])
      .filter((msg: string) => typeof msg === "string" && msg.includes("Phase 1 fehlgeschlagen"));
    expect(fatalCalls.length).toBeGreaterThan(0);

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});
