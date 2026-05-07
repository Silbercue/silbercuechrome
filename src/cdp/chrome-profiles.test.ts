import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import {
  getChromeUserDataDir,
  discoverProfiles,
  resolveProfileSpec,
  isChromeRunningWithProfile,
} from "./chrome-profiles.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readlinkSync: vi.fn(),
  lstatSync: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => "/Users/testuser"),
    platform: vi.fn(() => "darwin"),
  };
});

const CHROME_ROOT = "/Users/testuser/Library/Application Support/Google/Chrome";

const MOCK_LOCAL_STATE = JSON.stringify({
  profile: {
    info_cache: {
      Default: { name: "Personal" },
      "Profile 1": { name: "Julian" },
      "Profile 5": { name: "Business" },
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset platform/homedir to macOS defaults after tests that change them
  vi.mocked(platform).mockReturnValue("darwin");
  vi.mocked(homedir).mockReturnValue("/Users/testuser");
});

describe("getChromeUserDataDir", () => {
  it("returns macOS Chrome path when it exists", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(getChromeUserDataDir()).toBe(CHROME_ROOT);
  });

  it("returns undefined when Chrome dir does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(getChromeUserDataDir()).toBeUndefined();
  });

  it("returns Linux path on linux platform", () => {
    vi.mocked(platform).mockReturnValue("linux");
    vi.mocked(existsSync).mockReturnValue(true);
    expect(getChromeUserDataDir()).toBe("/Users/testuser/.config/google-chrome");
  });

  it("returns Windows path on win32 platform", () => {
    vi.mocked(platform).mockReturnValue("win32");
    vi.mocked(existsSync).mockReturnValue(true);
    const expected = join("/Users/testuser", "AppData", "Local", "Google", "Chrome", "User Data");
    expect(getChromeUserDataDir()).toBe(expected);
  });
});

describe("discoverProfiles", () => {
  it("returns profiles from Local State", () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const ps = String(p);
      return ps === CHROME_ROOT
        || ps === join(CHROME_ROOT, "Local State")
        || ps === join(CHROME_ROOT, "Default")
        || ps === join(CHROME_ROOT, "Profile 1")
        || ps === join(CHROME_ROOT, "Profile 5");
    });
    vi.mocked(readFileSync).mockReturnValue(MOCK_LOCAL_STATE);

    const profiles = discoverProfiles(CHROME_ROOT);
    expect(profiles).toHaveLength(3);
    expect(profiles.map((p) => p.name)).toEqual(["Business", "Julian", "Personal"]);
    expect(profiles.find((p) => p.name === "Julian")?.directory).toBe("Profile 1");
  });

  it("returns empty array when Local State is missing", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(discoverProfiles(CHROME_ROOT)).toEqual([]);
  });

  it("skips profiles whose directories don't exist", () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const ps = String(p);
      return ps === CHROME_ROOT
        || ps === join(CHROME_ROOT, "Local State")
        || ps === join(CHROME_ROOT, "Default");
    });
    vi.mocked(readFileSync).mockReturnValue(MOCK_LOCAL_STATE);

    const profiles = discoverProfiles(CHROME_ROOT);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("Personal");
  });

  it("returns empty array on invalid JSON", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not json");
    expect(discoverProfiles(CHROME_ROOT)).toEqual([]);
  });

  it("uses default name when profile has no name field", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      profile: { info_cache: { "Profile 3": {} } },
    }));

    const profiles = discoverProfiles(CHROME_ROOT);
    expect(profiles[0].name).toBe("Profile 3");
  });
});

describe("resolveProfileSpec", () => {
  const setupMockProfiles = () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const ps = String(p);
      return ps === CHROME_ROOT
        || ps === join(CHROME_ROOT, "Local State")
        || ps === join(CHROME_ROOT, "Default")
        || ps === join(CHROME_ROOT, "Profile 1")
        || ps === join(CHROME_ROOT, "Profile 5");
    });
    vi.mocked(readFileSync).mockReturnValue(MOCK_LOCAL_STATE);
  };

  it("resolves a friendly name to userDataDir + profileDirectory", () => {
    setupMockProfiles();
    const result = resolveProfileSpec("Julian");
    expect(result.userDataDir).toBe(CHROME_ROOT);
    expect(result.profileDirectory).toBe("Profile 1");
    expect(result.isRealProfile).toBe(true);
  });

  it("is case-insensitive for profile names", () => {
    setupMockProfiles();
    const result = resolveProfileSpec("julian");
    expect(result.profileDirectory).toBe("Profile 1");
  });

  it("resolves by directory name too", () => {
    setupMockProfiles();
    const result = resolveProfileSpec("Profile 5");
    expect(result.profileDirectory).toBe("Profile 5");
  });

  it("resolves absolute path as raw userDataDir (backward compat)", () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p) === "/custom/chrome/profile";
    });
    const result = resolveProfileSpec("/custom/chrome/profile");
    expect(result.userDataDir).toBe("/custom/chrome/profile");
    expect(result.profileDirectory).toBe("Default");
    expect(result.isRealProfile).toBe(true);
  });

  it("throws when profile name is not found", () => {
    setupMockProfiles();
    expect(() => resolveProfileSpec("NonExistent")).toThrow(/Cannot resolve profile "NonExistent"/);
  });

  it("throws when Chrome user data dir doesn't exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => resolveProfileSpec("Julian")).toThrow(/Chrome user data directory not found/);
  });

  it("includes available profiles in error message", () => {
    setupMockProfiles();
    try {
      resolveProfileSpec("Wrong");
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('"Julian"');
      expect(msg).toContain('"Business"');
    }
  });
});

describe("isChromeRunningWithProfile", () => {
  it("returns false when no lock file exists", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(isChromeRunningWithProfile(CHROME_ROOT)).toBe(false);
  });

  it("returns true when lock file exists and process is alive", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(lstatSync).mockReturnValue({
      isSymbolicLink: () => true,
    } as ReturnType<typeof lstatSync>);
    vi.mocked(readlinkSync).mockReturnValue(`hostname-${process.pid}`);

    expect(isChromeRunningWithProfile(CHROME_ROOT)).toBe(true);
  });

  it("returns false when lock file exists but process is dead", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(lstatSync).mockReturnValue({
      isSymbolicLink: () => true,
    } as ReturnType<typeof lstatSync>);
    vi.mocked(readlinkSync).mockReturnValue("hostname-99999999");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });

    expect(isChromeRunningWithProfile(CHROME_ROOT)).toBe(false);
    killSpy.mockRestore();
  });

  it("returns true when lock file exists but is not a symlink", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(lstatSync).mockReturnValue({
      isSymbolicLink: () => false,
    } as ReturnType<typeof lstatSync>);

    expect(isChromeRunningWithProfile(CHROME_ROOT)).toBe(true);
  });
});
