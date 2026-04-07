#!/usr/bin/env npx tsx
/**
 * Publish Pipeline — Dual-Repo Release Script
 *
 * 6-Phase workflow:
 *   Phase 1: Repo status check (versions, git clean, branch, prerequisites)
 *   Phase 2: Commit & Push (sync both repos with remote)
 *   Phase 3: Combined Build (free build + tests, optional pro build)
 *   Phase 4: Version Tag (set annotated tags on both repos)
 *   Phase 5: npm Publish + GitHub Release
 *   Phase 6: Verify (check npm registry, GitHub release, git tags)
 *
 * Usage:
 *   npx tsx scripts/publish.ts [--dry-run] [--skip-npm] [--skip-github]
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Configuration ─────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const CONFIG = {
  FREE_REPO: resolve(__dirname, ".."),
  PRO_REPO: resolve(__dirname, "../../silbercuechrome-pro"),
  NPM_PACKAGE: "@silbercuechrome/mcp",
  GITHUB_REPO_FREE: "Silbercue/SilbercueChrome",
  GITHUB_REPO_PRO: "Silbercue/SilbercueChromePro",
  /**
   * Default git branch fuer beide Repos.
   * Override per Env-Var `SILBERCUE_PUBLISH_BRANCH` (z.B. fuer Test-Branches).
   * Realitaet 2026-04: master (nicht main).
   */
  BRANCH: process.env.SILBERCUE_PUBLISH_BRANCH ?? "master",
  /**
   * Default git remote fuer push/pull/ls-remote.
   * Override per Env-Var `SILBERCUE_PUBLISH_REMOTE`.
   */
  REMOTE: process.env.SILBERCUE_PUBLISH_REMOTE ?? "origin",
} as const;

// ── Types ─────────────────────────────────────────────────────────────

export interface PhaseResult {
  success: boolean;
  message: string;
}

export interface PublishOptions {
  dryRun: boolean;
  skipNpm: boolean;
  skipGithub: boolean;
}

export interface RepoContext {
  freeRepo: string;
  proRepo: string;
  proRepoExists: boolean;
  version: string;
  tag: string;
}

// ── CLI Argument Parsing ──────────────────────────────────────────────

export function parseArgs(argv: string[]): PublishOptions {
  return {
    dryRun: argv.includes("--dry-run"),
    skipNpm: argv.includes("--skip-npm"),
    skipGithub: argv.includes("--skip-github"),
  };
}

// ── Shell Execution Helpers ───────────────────────────────────────────
// NOTE: These use execFileSync (not execSync) to prevent shell injection.
// Arguments are passed as arrays, never interpolated into a shell command.

/** Execute a command via execFileSync and return trimmed stdout. Throws on non-zero exit. */
export function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Execute a command via execFileSync, returning null on failure instead of throwing. */
export function runOrNull(
  cmd: string,
  args: string[],
  cwd: string,
): string | null {
  try {
    return run(cmd, args, cwd);
  } catch {
    return null;
  }
}

// ── Logging ───────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(msg);
}

function logPhase(phase: number, name: string): void {
  log(`\n${"=".repeat(60)}`);
  log(`Phase ${phase}/6: ${name}`);
  log("=".repeat(60));
}

// ── Phase 1: Repo Status ─────────────────────────────────────────────

export function phase1_checkRepoStatus(
  freeRepo: string,
  proRepo: string,
  opts?: PublishOptions,
): PhaseResult & { context?: RepoContext } {
  // 1. Check git is available
  if (runOrNull("git", ["--version"], freeRepo) === null) {
    return { success: false, message: "git CLI not found" };
  }

  // 2. Check npm is available and user is logged in (skip in dry-run or --skip-npm)
  if (!opts?.dryRun && !opts?.skipNpm) {
    if (runOrNull("npm", ["whoami"], freeRepo) === null) {
      return {
        success: false,
        message: "npm not authenticated. Run 'npm login' first.",
      };
    }
  }

  // 3. Check gh CLI is available and authenticated (skip in dry-run or --skip-github)
  if (!opts?.dryRun && !opts?.skipGithub) {
    if (runOrNull("gh", ["auth", "status"], freeRepo) === null) {
      return {
        success: false,
        message: "gh CLI not authenticated. Run 'gh auth login' first.",
      };
    }
  }

  // 4. Read free repo version
  const freePkgPath = resolve(freeRepo, "package.json");
  if (!existsSync(freePkgPath)) {
    return {
      success: false,
      message: `Free repo package.json not found at ${freePkgPath}`,
    };
  }
  const freePkg = JSON.parse(readFileSync(freePkgPath, "utf-8"));
  const freeVersion: string = freePkg.version;

  // 5. Check free repo git status
  const freeStatus = run("git", ["status", "--porcelain"], freeRepo);
  if (freeStatus !== "") {
    return {
      success: false,
      message: `Free repo has uncommitted changes:\n${freeStatus}`,
    };
  }

  // 6. Check free repo branch
  const freeBranch = run(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    freeRepo,
  );
  if (freeBranch !== CONFIG.BRANCH) {
    return {
      success: false,
      message: `Free repo is on branch '${freeBranch}', expected '${CONFIG.BRANCH}' (override via SILBERCUE_PUBLISH_BRANCH)`,
    };
  }

  // 6b. Check free repo remote exists
  const freeRemoteUrl = runOrNull(
    "git",
    ["remote", "get-url", CONFIG.REMOTE],
    freeRepo,
  );
  if (freeRemoteUrl === null) {
    return {
      success: false,
      message: `Free repo has no '${CONFIG.REMOTE}' remote configured. Set up with: git -C ${freeRepo} remote add ${CONFIG.REMOTE} <url> (or override remote name via SILBERCUE_PUBLISH_REMOTE)`,
    };
  }

  // 7. Pro repo checks (optional)
  const proRepoExists = existsSync(proRepo);
  if (proRepoExists) {
    const proPkgPath = resolve(proRepo, "package.json");
    if (!existsSync(proPkgPath)) {
      return {
        success: false,
        message: `Pro repo exists but package.json not found at ${proPkgPath}`,
      };
    }
    const proPkg = JSON.parse(readFileSync(proPkgPath, "utf-8"));
    const proVersion: string = proPkg.version;

    // Version mismatch check (AC #2)
    if (freeVersion !== proVersion) {
      return {
        success: false,
        message: `Version mismatch: free=${freeVersion}, pro=${proVersion}`,
      };
    }

    // Pro repo git status
    const proStatus = run("git", ["status", "--porcelain"], proRepo);
    if (proStatus !== "") {
      return {
        success: false,
        message: `Pro repo has uncommitted changes:\n${proStatus}`,
      };
    }

    // Pro repo branch
    const proBranch = run(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      proRepo,
    );
    if (proBranch !== CONFIG.BRANCH) {
      return {
        success: false,
        message: `Pro repo is on branch '${proBranch}', expected '${CONFIG.BRANCH}' (override via SILBERCUE_PUBLISH_BRANCH)`,
      };
    }

    // Pro repo remote exists
    const proRemoteUrl = runOrNull(
      "git",
      ["remote", "get-url", CONFIG.REMOTE],
      proRepo,
    );
    if (proRemoteUrl === null) {
      return {
        success: false,
        message: `Pro repo has no '${CONFIG.REMOTE}' remote configured. Set up with: git -C ${proRepo} remote add ${CONFIG.REMOTE} <url> (or override remote name via SILBERCUE_PUBLISH_REMOTE)`,
      };
    }

    log(`  Pro repo found at ${proRepo} (v${proVersion})`);
  } else {
    log("  Pro repo not found — Free-Only release");
  }

  const version = freeVersion;
  const tag = `v${version}`;

  // 8. Hard-fail when free package.json is still marked private:true
  // (Phase 0 setzt das auf false; falls jemand das versehentlich rueckgaengig macht,
  // wuerde npm publish spaeter mit einem nichtssagenden EPRIVATE failen — lieber
  // hier mit klarer Message stoppen.)
  if (freePkg.private === true) {
    throw new Error(
      `Free package.json has "private": true — npm publish would fail. Set "private": false before publishing.`,
    );
  }

  log(`  Version: ${version}`);
  log(`  Tag: ${tag}`);

  return {
    success: true,
    message: `Repo status OK (v${version})`,
    context: {
      freeRepo,
      proRepo,
      proRepoExists,
      version,
      tag,
    },
  };
}

// ── Phase 2: Commit & Push ───────────────────────────────────────────

export function phase2_commitAndPush(
  ctx: RepoContext,
  opts: PublishOptions,
): PhaseResult {
  const repos: Array<{ name: string; path: string }> = [
    { name: "free", path: ctx.freeRepo },
  ];
  if (ctx.proRepoExists) {
    repos.push({ name: "pro", path: ctx.proRepo });
  }

  for (const repo of repos) {
    const ahead = run(
      "git",
      ["log", `${CONFIG.REMOTE}/${CONFIG.BRANCH}..HEAD`, "--oneline"],
      repo.path,
    );
    if (ahead === "") {
      log(`  ${repo.name} repo: already in sync with remote`);
      continue;
    }

    log(`  ${repo.name} repo: ${ahead.split("\n").length} commit(s) ahead`);

    if (opts.dryRun) {
      log(
        `  [DRY-RUN] Would push ${repo.name} repo to ${CONFIG.REMOTE}/${CONFIG.BRANCH}`,
      );
      continue;
    }

    try {
      run("git", ["push", CONFIG.REMOTE, CONFIG.BRANCH], repo.path);
      log(`  ${repo.name} repo: pushed to ${CONFIG.REMOTE}/${CONFIG.BRANCH}`);
    } catch (err) {
      return {
        success: false,
        message: `Push failed for ${repo.name} repo: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { success: true, message: "Repos synced with remote" };
}

// ── Phase 3: Combined Build ──────────────────────────────────────────

export function phase3_combinedBuild(
  ctx: RepoContext,
  opts: PublishOptions,
): PhaseResult & { buildArtifact?: string } {
  // 3.1 Free build
  log("  Building free tier...");
  if (opts.dryRun) {
    log("  [DRY-RUN] Would run: npm run build");
    log("  [DRY-RUN] Would run: npm test");
  } else {
    try {
      run("npm", ["run", "build"], ctx.freeRepo);
      log("  Free tier build OK");
    } catch (err) {
      return {
        success: false,
        message: `Free tier build failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 3.2 Tests
    log("  Running tests...");
    try {
      run("npm", ["test"], ctx.freeRepo);
      log("  Tests passed");
    } catch (err) {
      return {
        success: false,
        message: `Tests failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 3.3 Pro build (if pro repo exists)
  let buildArtifact: string | undefined;
  if (ctx.proRepoExists) {
    log("  Building pro tier...");
    if (opts.dryRun) {
      log("  [DRY-RUN] Would run: npm install (pro repo)");
      log("  [DRY-RUN] Would build pro tier");
      log("  [DRY-RUN] Would run: npm pack");
    } else {
      // 3.3a Pro repo haengt als `file:../SilbercueChrome` am Free-Repo.
      // Bei jedem Free-Build kann sich `build/` aendern; ohne `npm install`
      // bekommt das Pro-Repo veraltete Free-Artefakte. Daher VOR `npm run build`
      // im Pro-Repo immer ein `npm install` ausfuehren.
      try {
        run("npm", ["install"], ctx.proRepo);
        log("  Pro tier dependencies installed (incl. file:../SilbercueChrome)");
      } catch (err) {
        return {
          success: false,
          message: `Pro tier npm install failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      try {
        run("npm", ["run", "build"], ctx.proRepo);
        log("  Pro tier build OK");
      } catch (err) {
        return {
          success: false,
          message: `Pro tier build failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // 3.4 Combined npm tarball (not a standalone binary; Node SEA build
      // kommt in Phase 3 separat)
      try {
        const packOutput = run("npm", ["pack", "--json"], ctx.proRepo);
        const packInfo = JSON.parse(packOutput);

        // Shape validation: must be an array with at least one element containing filename and size
        if (!Array.isArray(packInfo) || packInfo.length === 0) {
          return {
            success: false,
            message: `npm pack returned unexpected format: expected JSON array, got ${typeof packInfo === "object" ? JSON.stringify(packInfo).slice(0, 100) : typeof packInfo}`,
          };
        }
        if (!packInfo[0].filename || typeof packInfo[0].size !== "number") {
          return {
            success: false,
            message: `npm pack entry missing required fields (filename, size): ${JSON.stringify(packInfo[0]).slice(0, 100)}`,
          };
        }

        buildArtifact = resolve(ctx.proRepo, packInfo[0].filename);
        log(`  Combined npm tarball created: ${buildArtifact}`);
      } catch (err) {
        return {
          success: false,
          message: `npm pack failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  } else {
    log("  No pro repo — skipping combined build");
  }

  return {
    success: true,
    message: "Build successful",
    buildArtifact,
  };
}

// ── Phase 4: Version Tag ─────────────────────────────────────────────

export function phase4_versionTag(
  ctx: RepoContext,
  opts: PublishOptions,
): PhaseResult {
  const repos: Array<{ name: string; path: string }> = [
    { name: "free", path: ctx.freeRepo },
  ];
  if (ctx.proRepoExists) {
    repos.push({ name: "pro", path: ctx.proRepo });
  }

  for (const repo of repos) {
    // Check if tag already exists locally
    const existingTag = runOrNull("git", ["tag", "-l", ctx.tag], repo.path);

    if (existingTag && existingTag !== "") {
      log(`  ${repo.name} repo: tag ${ctx.tag} already exists — replacing`);
      if (!opts.dryRun) {
        // Delete local tag
        runOrNull("git", ["tag", "-d", ctx.tag], repo.path);
        // Delete remote tag (may not exist)
        runOrNull(
          "git",
          ["push", CONFIG.REMOTE, `:refs/tags/${ctx.tag}`],
          repo.path,
        );
      } else {
        log(`  [DRY-RUN] Would delete existing tag ${ctx.tag}`);
      }
    }

    if (opts.dryRun) {
      log(
        `  [DRY-RUN] Would create annotated tag ${ctx.tag} on ${repo.name} repo`,
      );
      log(`  [DRY-RUN] Would push tag ${ctx.tag} to ${CONFIG.REMOTE}`);
      continue;
    }

    // Create annotated tag
    try {
      run(
        "git",
        ["tag", "-a", ctx.tag, "-m", `Release ${ctx.tag}`],
        repo.path,
      );
      log(`  ${repo.name} repo: tag ${ctx.tag} created`);
    } catch (err) {
      return {
        success: false,
        message: `Tag creation failed for ${repo.name} repo: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Push tag
    try {
      run("git", ["push", CONFIG.REMOTE, ctx.tag], repo.path);
      log(`  ${repo.name} repo: tag ${ctx.tag} pushed`);
    } catch (err) {
      return {
        success: false,
        message: `Tag push failed for ${repo.name} repo: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { success: true, message: `Tag ${ctx.tag} set on all repos` };
}

// ── Phase 5: npm Publish + GitHub Release ────────────────────────────

export function phase5_publishAndRelease(
  ctx: RepoContext,
  opts: PublishOptions,
  buildArtifact?: string,
): PhaseResult {
  // 5.1 npm publish
  if (!opts.skipNpm) {
    if (opts.dryRun) {
      log("  [DRY-RUN] Would run: npm publish --access public");
    } else {
      log("  Publishing to npm...");
      try {
        run("npm", ["publish", "--access", "public"], ctx.freeRepo);
        log(`  Published ${CONFIG.NPM_PACKAGE}@${ctx.version} to npm`);
      } catch (err) {
        return {
          success: false,
          message: `npm publish failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  } else {
    log("  Skipping npm publish (--skip-npm)");
  }

  // 5.2 GitHub Release
  // TODO Phase 5: Pro-Tarball als private GitHub Release im Pro-Repo hochladen,
  // nicht als public Asset des Free-Repos. Aktuell wird `buildArtifact` (Pro-Tarball)
  // an den FREE-Release angehaengt — das wuerde Pro-Code public machen, sobald die
  // Free-Repo-Releases sichtbar sind. Bis dahin: Pro-Tarball nicht uploaden, oder
  // separates `gh release create --repo CONFIG.GITHUB_REPO_PRO` mit private visibility.
  if (!opts.skipGithub) {
    if (opts.dryRun) {
      log(`  [DRY-RUN] Would create GitHub release ${ctx.tag}`);
      if (buildArtifact) {
        log(`  [DRY-RUN] Would upload asset: ${buildArtifact}`);
      }
    } else {
      log("  Creating GitHub release...");

      // Check if release already exists
      const existingRelease = runOrNull(
        "gh",
        ["release", "view", ctx.tag, "--repo", CONFIG.GITHUB_REPO_FREE],
        ctx.freeRepo,
      );

      if (existingRelease !== null) {
        log(`  Release ${ctx.tag} already exists — deleting for re-create`);
        try {
          run(
            "gh",
            [
              "release",
              "delete",
              ctx.tag,
              "-y",
              "--repo",
              CONFIG.GITHUB_REPO_FREE,
            ],
            ctx.freeRepo,
          );
        } catch {
          // Ignore delete errors — release might be partially created
        }
      }

      try {
        run(
          "gh",
          [
            "release",
            "create",
            ctx.tag,
            "--title",
            ctx.tag,
            "--generate-notes",
            "--repo",
            CONFIG.GITHUB_REPO_FREE,
          ],
          ctx.freeRepo,
        );
        log(`  GitHub release ${ctx.tag} created`);
      } catch (err) {
        return {
          success: false,
          message: `GitHub release creation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Upload build artifact if available
      if (buildArtifact) {
        try {
          run(
            "gh",
            [
              "release",
              "upload",
              ctx.tag,
              buildArtifact,
              "--clobber",
              "--repo",
              CONFIG.GITHUB_REPO_FREE,
            ],
            ctx.freeRepo,
          );
          log(`  Asset uploaded: ${buildArtifact}`);
        } catch (err) {
          return {
            success: false,
            message: `Asset upload failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }
  } else {
    log("  Skipping GitHub release (--skip-github)");
  }

  return { success: true, message: "Publish & release complete" };
}

// ── Phase 6: Verify ──────────────────────────────────────────────────

export function phase6_verify(
  ctx: RepoContext,
  opts: PublishOptions,
): PhaseResult {
  const warnings: string[] = [];

  if (opts.dryRun) {
    log("  [DRY-RUN] Skipping verification");
    return { success: true, message: "Dry-run — verification skipped" };
  }

  // 6.1 npm registry check
  if (!opts.skipNpm) {
    const npmView = runOrNull(
      "npm",
      ["view", `${CONFIG.NPM_PACKAGE}@${ctx.version}`, "version"],
      ctx.freeRepo,
    );
    if (npmView === ctx.version) {
      log(`  npm: ${CONFIG.NPM_PACKAGE}@${ctx.version} verified`);
    } else {
      warnings.push(
        `npm: expected ${ctx.version}, got ${npmView ?? "not found"}`,
      );
    }
  }

  // 6.2 GitHub release check
  if (!opts.skipGithub) {
    const ghView = runOrNull(
      "gh",
      [
        "release",
        "view",
        ctx.tag,
        "--repo",
        CONFIG.GITHUB_REPO_FREE,
        "--json",
        "tagName",
        "-q",
        ".tagName",
      ],
      ctx.freeRepo,
    );
    if (ghView === ctx.tag) {
      log(`  GitHub: release ${ctx.tag} verified`);
    } else {
      warnings.push(
        `GitHub: release ${ctx.tag} not found (got ${ghView ?? "null"})`,
      );
    }
  }

  // 6.3 Git tags check
  const repos: Array<{ name: string; path: string }> = [
    { name: "free", path: ctx.freeRepo },
  ];
  if (ctx.proRepoExists) {
    repos.push({ name: "pro", path: ctx.proRepo });
  }

  for (const repo of repos) {
    const remoteTags = runOrNull(
      "git",
      ["ls-remote", "--tags", CONFIG.REMOTE, ctx.tag],
      repo.path,
    );
    if (remoteTags && remoteTags.includes(ctx.tag)) {
      log(`  Git: tag ${ctx.tag} on ${repo.name} remote verified`);
    } else {
      warnings.push(`Git: tag ${ctx.tag} not found on ${repo.name} remote`);
    }
  }

  // 6.4 Asset count
  let assetCount = 0;
  if (!opts.skipGithub) {
    const assetsJson = runOrNull(
      "gh",
      [
        "release",
        "view",
        ctx.tag,
        "--repo",
        CONFIG.GITHUB_REPO_FREE,
        "--json",
        "assets",
        "-q",
        ".assets | length",
      ],
      ctx.freeRepo,
    );
    if (assetsJson !== null) {
      assetCount = parseInt(assetsJson, 10) || 0;
    }
  }

  // 6.5 Summary
  log("");
  log("  ── Release Summary ──");
  log(`  Version:  ${ctx.version}`);
  log(`  npm:      https://www.npmjs.com/package/${CONFIG.NPM_PACKAGE}`);
  log(
    `  GitHub:   https://github.com/${CONFIG.GITHUB_REPO_FREE}/releases/tag/${ctx.tag}`,
  );
  if (!opts.skipGithub) {
    log(`  Assets:   ${assetCount}`);
  }
  if (ctx.proRepoExists) {
    log(`  Pro repo: synced`);
  }

  if (warnings.length > 0) {
    log("");
    log("  WARNINGS:");
    for (const w of warnings) {
      log(`    - ${w}`);
    }
    return {
      success: true,
      message: `Verification completed with ${warnings.length} warning(s)`,
    };
  }

  return { success: true, message: "All verifications passed" };
}

// ── Main Pipeline ────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv): Promise<void> {
  const opts = parseArgs(argv);

  log("SilbercueChrome Publish Pipeline");
  if (opts.dryRun) log("MODE: DRY-RUN (no destructive operations)");
  if (opts.skipNpm) log("FLAG: --skip-npm");
  if (opts.skipGithub) log("FLAG: --skip-github");

  // Phase 1
  logPhase(1, "Repo Status Check");
  let p1: PhaseResult & { context?: RepoContext };
  try {
    p1 = phase1_checkRepoStatus(CONFIG.FREE_REPO, CONFIG.PRO_REPO, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFATAL: Phase 1 fehlgeschlagen: ${msg}`);
    process.exitCode = 1;
    return;
  }
  log(`  Result: ${p1.message}`);
  if (!p1.success) {
    console.error(`\nFATAL: Phase 1 fehlgeschlagen: ${p1.message}`);
    process.exitCode = 1;
    return;
  }
  const ctx = p1.context!;

  // Phase 2
  logPhase(2, "Commit & Push");
  let p2: PhaseResult;
  try {
    p2 = phase2_commitAndPush(ctx, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFATAL: Phase 2 fehlgeschlagen: ${msg}`);
    process.exitCode = 1;
    return;
  }
  log(`  Result: ${p2.message}`);
  if (!p2.success) {
    console.error(`\nFATAL: Phase 2 fehlgeschlagen: ${p2.message}`);
    process.exitCode = 1;
    return;
  }

  // Phase 3
  logPhase(3, "Combined Build");
  let p3: PhaseResult & { buildArtifact?: string };
  try {
    p3 = phase3_combinedBuild(ctx, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFATAL: Phase 3 fehlgeschlagen: ${msg}`);
    process.exitCode = 1;
    return;
  }
  log(`  Result: ${p3.message}`);
  if (!p3.success) {
    console.error(`\nFATAL: Phase 3 fehlgeschlagen: ${p3.message}`);
    process.exitCode = 1;
    return;
  }

  // Phase 4
  logPhase(4, "Version Tag");
  let p4: PhaseResult;
  try {
    p4 = phase4_versionTag(ctx, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFATAL: Phase 4 fehlgeschlagen: ${msg}`);
    process.exitCode = 1;
    return;
  }
  log(`  Result: ${p4.message}`);
  if (!p4.success) {
    console.error(`\nFATAL: Phase 4 fehlgeschlagen: ${p4.message}`);
    process.exitCode = 1;
    return;
  }

  // Phase 5
  logPhase(5, "npm Publish + GitHub Release");
  let p5: PhaseResult;
  try {
    p5 = phase5_publishAndRelease(ctx, opts, p3.buildArtifact);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFATAL: Phase 5 fehlgeschlagen: ${msg}`);
    process.exitCode = 1;
    return;
  }
  log(`  Result: ${p5.message}`);
  if (!p5.success) {
    console.error(`\nFATAL: Phase 5 fehlgeschlagen: ${p5.message}`);
    process.exitCode = 1;
    return;
  }

  // Phase 6
  logPhase(6, "Verify");
  let p6: PhaseResult;
  try {
    p6 = phase6_verify(ctx, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFATAL: Phase 6 fehlgeschlagen: ${msg}`);
    process.exitCode = 1;
    return;
  }
  log(`  Result: ${p6.message}`);
  if (!p6.success) {
    console.error(`\nFATAL: Phase 6 fehlgeschlagen: ${p6.message}`);
    process.exitCode = 1;
    return;
  }

  log(`\nRelease ${ctx.tag} complete!`);
}

// ── Run ───────────────────────────────────────────────────────────────

// Only run main when executed directly (not imported by tests)
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("publish.ts") ||
    process.argv[1].endsWith("publish.js"));

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Unhandled error:", err);
    process.exitCode = 1;
  });
}
