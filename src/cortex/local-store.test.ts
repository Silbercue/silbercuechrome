/**
 * Story 12.2 (Task 4.1): LocalStore — Merkle Append-Only Log Tests.
 *
 * Covers all acceptance criteria:
 *  - AC #1: append() persists patterns to JSONL and updates tree head
 *  - AC #2: Inclusion proofs are verifiable for every leaf
 *  - AC #3: Manipulation is detected (hash mismatch)
 *  - AC #4: RFC-6962-compatible hashing (0x00/0x01 prefixes)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { LocalStore } from "./local-store.js";
import type { CortexPattern, SignedTreeHead } from "./cortex-types.js";

/** Helper: create a minimal valid CortexPattern (Story 12a.2: pageType-based). */
function makePattern(pageType = "data_table", idx = 0): CortexPattern {
  return {
    pageType: `${pageType}_${idx}`,
    toolSequence: ["navigate", "view_page"],
    outcome: "success",
    contentHash: `hash${String(idx).padStart(12, "0")}`,
    timestamp: 1700000000000 + idx,
  };
}

describe("LocalStore (Story 12.2)", () => {
  let tmpDir: string;
  let store: LocalStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "merkle-test-"));
    store = new LocalStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // AC #1: append() and getAll()
  // =========================================================================

  it("append() adds pattern to JSONL and updates tree head (AC #1)", async () => {
    const pattern = makePattern();
    await store.append(pattern);

    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].pageType).toBe("data_table_0");

    const head = await store.getTreeHead();
    expect(head.treeSize).toBe(1);
    expect(head.rootHash).not.toBe("");
    expect(head.timestamp).toBeGreaterThan(0);
  });

  it("getAll() reads all patterns correctly", async () => {
    await store.append(makePattern("login", 0));
    await store.append(makePattern("signup", 1));
    await store.append(makePattern("checkout", 2));

    const all = await store.getAll();
    expect(all).toHaveLength(3);
    expect(all[0].pageType).toBe("login_0");
    expect(all[1].pageType).toBe("signup_1");
    expect(all[2].pageType).toBe("checkout_2");
  });

  it("getTreeHead() returns correct root hash", async () => {
    await store.append(makePattern("login", 0));
    const head1 = await store.getTreeHead();
    expect(head1.treeSize).toBe(1);

    await store.append(makePattern("signup", 1));
    const head2 = await store.getTreeHead();
    expect(head2.treeSize).toBe(2);
    expect(head2.rootHash).not.toBe(head1.rootHash);
  });

  // =========================================================================
  // AC #2: Inclusion proofs
  // =========================================================================

  it("getInclusionProof() returns valid proof for every leaf index (AC #2)", async () => {
    // Build a tree with 5 patterns
    for (let i = 0; i < 5; i++) {
      await store.append(makePattern("test", i));
    }

    const head = await store.getTreeHead();
    const patterns = await store.getAll();

    for (let i = 0; i < 5; i++) {
      const proof = await store.getInclusionProof(i);
      expect(proof.leafIndex).toBe(i);
      expect(proof.treeSize).toBe(5);
      expect(proof.hashes.length).toBeGreaterThan(0);

      // Compute the leaf hash for this pattern
      const leafHash = store._hashLeaf(patterns[i]);

      // Verify the proof
      const valid = LocalStore.verifyInclusionProof(proof, leafHash, head.rootHash);
      expect(valid).toBe(true);
    }
  });

  it("verifyInclusionProof() returns true for valid proof (AC #2)", async () => {
    await store.append(makePattern("article", 0));
    await store.append(makePattern("form_simple", 1));

    const head = await store.getTreeHead();
    const patterns = await store.getAll();
    const proof = await store.getInclusionProof(0);
    const leafHash = store._hashLeaf(patterns[0]);

    expect(LocalStore.verifyInclusionProof(proof, leafHash, head.rootHash)).toBe(true);
  });

  it("verifyInclusionProof() returns false for tampered proof (AC #3)", async () => {
    await store.append(makePattern("article", 0));
    await store.append(makePattern("form_simple", 1));

    const head = await store.getTreeHead();
    const patterns = await store.getAll();
    const proof = await store.getInclusionProof(0);
    const leafHash = store._hashLeaf(patterns[0]);

    // Tamper with one hash in the proof
    const tamperedProof = {
      ...proof,
      hashes: proof.hashes.map((h) => h.replace(/^./, "0")),
    };
    expect(LocalStore.verifyInclusionProof(tamperedProof, leafHash, head.rootHash)).toBe(
      false,
    );
  });

  // =========================================================================
  // AC #3: Integrity verification detects manipulation
  // =========================================================================

  it("verifyIntegrity() detects manipulated JSONL entries (AC #3)", async () => {
    await store.append(makePattern("article", 0));
    await store.append(makePattern("form_simple", 1));

    // Tamper with the JSONL file
    const jsonlPath = join(tmpDir, "patterns.jsonl");
    let content = await readFile(jsonlPath, "utf-8");
    content = content.replace('"article_0"', '"evil_0"');
    await writeFile(jsonlPath, content, "utf-8");

    const result = await store.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Root hash mismatch");
  });

  it("verifyIntegrity() returns valid=true for unmanipulated log (AC #3)", async () => {
    await store.append(makePattern("article", 0));
    await store.append(makePattern("form_simple", 1));
    await store.append(makePattern("settings", 2));

    const result = await store.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // =========================================================================
  // AC #4: RFC-6962 hashing compliance
  // =========================================================================

  it("leaf hash follows RFC-6962: SHA-256(0x00 || data) (AC #4)", () => {
    const pattern = makePattern("profile", 42);
    const leafHash = store._hashLeaf(pattern);

    // Manually compute the expected hash
    const canonical = JSON.stringify(pattern, Object.keys(pattern).sort());
    const expected = createHash("sha256")
      .update(Buffer.from([0x00]))
      .update(Buffer.from(canonical, "utf-8"))
      .digest("hex");

    expect(leafHash).toBe(expected);
  });

  it("interior hash follows RFC-6962: SHA-256(0x01 || left || right) (AC #4)", () => {
    const left = "a".repeat(64); // fake 256-bit hash
    const right = "b".repeat(64);
    const result = store._hashPair(left, right);

    const expected = createHash("sha256")
      .update(Buffer.from([0x01]))
      .update(Buffer.from(left, "hex"))
      .update(Buffer.from(right, "hex"))
      .digest("hex");

    expect(result).toBe(expected);
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  it("empty log: getTreeHead() returns treeSize 0", async () => {
    const head = await store.getTreeHead();
    expect(head.treeSize).toBe(0);
    expect(head.rootHash).toBe("");
    expect(head.timestamp).toBe(0);
  });

  it("empty log: getAll() returns empty array", async () => {
    const patterns = await store.getAll();
    expect(patterns).toHaveLength(0);
  });

  it("multiple appends: tree grows correctly", async () => {
    const heads: SignedTreeHead[] = [];

    for (let i = 0; i < 7; i++) {
      await store.append(makePattern("navigation", i));
      heads.push(await store.getTreeHead());
    }

    // Each append should increase tree size by 1
    for (let i = 0; i < 7; i++) {
      expect(heads[i].treeSize).toBe(i + 1);
    }

    // Root hashes should all differ
    const roots = heads.map((h) => h.rootHash);
    const uniqueRoots = new Set(roots);
    expect(uniqueRoots.size).toBe(7);
  });

  it("odd leaf count: RFC-6962 split works correctly", async () => {
    // 3 leaves → RFC-6962 split: k=2, left=[0,1], right=[2]
    await store.append(makePattern("article", 0));
    await store.append(makePattern("form_simple", 1));
    await store.append(makePattern("settings", 2));

    const head = await store.getTreeHead();
    expect(head.treeSize).toBe(3);
    expect(head.rootHash).toHaveLength(64); // SHA-256 hex length

    // All 3 leaves should have valid inclusion proofs
    const patterns = await store.getAll();
    for (let i = 0; i < 3; i++) {
      const proof = await store.getInclusionProof(i);
      const leafHash = store._hashLeaf(patterns[i]);
      expect(LocalStore.verifyInclusionProof(proof, leafHash, head.rootHash)).toBe(true);
    }
  });

  it("single leaf: inclusion proof works", async () => {
    await store.append(makePattern("unknown", 0));
    const head = await store.getTreeHead();
    const patterns = await store.getAll();

    const proof = await store.getInclusionProof(0);
    expect(proof.hashes).toHaveLength(0);

    const leafHash = store._hashLeaf(patterns[0]);
    // For a single-leaf tree, the root IS the leaf hash
    expect(leafHash).toBe(head.rootHash);
    expect(LocalStore.verifyInclusionProof(proof, leafHash, head.rootHash)).toBe(true);
  });

  it("out-of-range leaf index returns empty proof", async () => {
    await store.append(makePattern("article", 0));
    const proof = await store.getInclusionProof(99);
    expect(proof.hashes).toHaveLength(0);
    expect(proof.leafIndex).toBe(99);
  });

  it("constructor respects dataDir option", async () => {
    const customDir = await mkdtemp(join(tmpdir(), "merkle-custom-"));
    const customStore = new LocalStore({ dataDir: customDir });

    await customStore.append(makePattern("checkout", 0));
    const all = await customStore.getAll();
    expect(all).toHaveLength(1);

    await rm(customDir, { recursive: true, force: true });
  });

  it("handles corrupt JSONL lines gracefully", async () => {
    await store.append(makePattern("search_form", 0));

    // Inject a corrupt line
    const jsonlPath = join(tmpDir, "patterns.jsonl");
    let content = await readFile(jsonlPath, "utf-8");
    content += "this is not valid json\n";
    await writeFile(jsonlPath, content, "utf-8");

    // Append another valid pattern
    await store.append(makePattern("dashboard", 1));

    // getAll should skip the corrupt line
    const all = await store.getAll();
    // We have: original good pattern, corrupt line (skipped), also-good pattern
    // But append re-reads ALL patterns and rebuilds — the corrupt line is skipped
    // so the tree head reflects only the 2 valid patterns
    const validPatterns = all.filter((p) => p.pageType === "search_form_0" || p.pageType === "dashboard_1");
    expect(validPatterns).toHaveLength(2);
  });

  it("verifyInclusionProof returns false for empty tree", () => {
    const proof = { leafIndex: 0, treeSize: 0, hashes: [] };
    expect(LocalStore.verifyInclusionProof(proof, "abc", "abc")).toBe(false);
  });

  it("verifyIntegrity on empty log returns valid", async () => {
    const result = await store.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("deterministic: same pattern always produces same leaf hash", () => {
    const p = makePattern("media", 7);
    const h1 = store._hashLeaf(p);
    const h2 = store._hashLeaf(p);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("different patterns produce different leaf hashes", () => {
    const h1 = store._hashLeaf(makePattern("article", 0));
    const h2 = store._hashLeaf(makePattern("form_simple", 1));
    expect(h1).not.toBe(h2);
  });

  it("inclusion proof for power-of-two leaf count", async () => {
    // 4 leaves — perfectly balanced tree
    for (let i = 0; i < 4; i++) {
      await store.append(makePattern("login", i));
    }

    const head = await store.getTreeHead();
    const patterns = await store.getAll();

    for (let i = 0; i < 4; i++) {
      const proof = await store.getInclusionProof(i);
      const leafHash = store._hashLeaf(patterns[i]);
      expect(LocalStore.verifyInclusionProof(proof, leafHash, head.rootHash)).toBe(true);
    }
  });

  it("inclusion proof for large tree (16 leaves)", async () => {
    for (let i = 0; i < 16; i++) {
      await store.append(makePattern("mfa", i));
    }

    const head = await store.getTreeHead();
    const patterns = await store.getAll();

    // Verify every single leaf
    for (let i = 0; i < 16; i++) {
      const proof = await store.getInclusionProof(i);
      const leafHash = store._hashLeaf(patterns[i]);
      expect(LocalStore.verifyInclusionProof(proof, leafHash, head.rootHash)).toBe(true);
    }
  });

  // =========================================================================
  // M2: Negative tests for verifyInclusionProof
  // =========================================================================

  it("verifyInclusionProof returns false for leafIndex >= treeSize (M2)", () => {
    const proof = { leafIndex: 5, treeSize: 5, hashes: ["a".repeat(64)] };
    expect(LocalStore.verifyInclusionProof(proof, "b".repeat(64), "c".repeat(64))).toBe(false);
  });

  it("verifyInclusionProof returns false for leafIndex < 0 (M2)", () => {
    const proof = { leafIndex: -1, treeSize: 5, hashes: ["a".repeat(64)] };
    expect(LocalStore.verifyInclusionProof(proof, "b".repeat(64), "c".repeat(64))).toBe(false);
  });

  it("verifyInclusionProof returns false for empty proof with treeSize > 1 (M2)", () => {
    const proof = { leafIndex: 0, treeSize: 5, hashes: [] };
    expect(LocalStore.verifyInclusionProof(proof, "b".repeat(64), "c".repeat(64))).toBe(false);
  });

  it("verifyInclusionProof returns false for proof with wrong hashes (M2)", async () => {
    // Build a real tree then corrupt the proof hashes
    for (let i = 0; i < 4; i++) {
      await store.append(makePattern("error", i));
    }
    const head = await store.getTreeHead();
    const patterns = await store.getAll();
    const proof = await store.getInclusionProof(0);
    const leafHash = store._hashLeaf(patterns[0]);

    // Replace all proof hashes with garbage
    const corruptProof = {
      ...proof,
      hashes: proof.hashes.map(() => "f".repeat(64)),
    };
    expect(LocalStore.verifyInclusionProof(corruptProof, leafHash, head.rootHash)).toBe(false);
  });

  // =========================================================================
  // H3: verifyIntegrity detects manipulated empty-log tree head
  // =========================================================================

  it("verifyIntegrity detects forged tree head on empty log (H3)", async () => {
    // Write a fake tree head to an empty store
    const fakeHead = { treeSize: 5, rootHash: "a".repeat(64), timestamp: 123 };
    const { writeFile: wf } = await import("node:fs/promises");
    await store.append(makePattern("form_wizard", 0)); // ensure dir exists
    // Now remove the patterns file to simulate empty log with forged head
    const { rm: rmF } = await import("node:fs/promises");
    await rmF(join(tmpDir, "patterns.jsonl"));
    await wf(join(tmpDir, "tree-head.json"), JSON.stringify(fakeHead), "utf-8");

    const result = await store.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Non-empty tree head for empty log");
  });

  // =========================================================================
  // H4: Concurrent appends are serialized
  // =========================================================================

  it("concurrent appends do not corrupt the log (H4)", async () => {
    // Fire 5 appends concurrently
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(store.append(makePattern("search_results", i)));
    }
    await Promise.all(promises);

    const all = await store.getAll();
    expect(all).toHaveLength(5);

    const result = await store.verifyIntegrity();
    expect(result.valid).toBe(true);
  });

  // =========================================================================
  // H5: Dedup does not create duplicate JSONL entries
  // =========================================================================

  it("dedup: same pageType updates in-place, no extra JSONL line (H5)", async () => {
    const p1 = makePattern("login", 0);
    const p2: CortexPattern = { ...p1, contentHash: "updatedHash00000", timestamp: p1.timestamp + 1 };

    await store.append(p1);
    await store.append(p2);

    const all = await store.getAll();
    // Should be 1, not 2 — dedup replaced the entry
    expect(all).toHaveLength(1);
    expect(all[0].contentHash).toBe("updatedHash00000");

    const result = await store.verifyIntegrity();
    expect(result.valid).toBe(true);
  });

  // =========================================================================
  // M3: append gracefully handles errors
  // =========================================================================

  it("append does not throw on file system errors (M3)", async () => {
    const badStore = new LocalStore({ dataDir: "/dev/null/impossible-path" });
    // Should not throw — error is swallowed and debug-logged
    await expect(badStore.append(makePattern("error", 0))).resolves.toBeUndefined();
  });

  // =========================================================================
  // Story 12a.2: Legacy JSONL entries without pageType are skipped
  // =========================================================================

  it("skips legacy entries without pageType when reading (Story 12a.2)", async () => {
    // Write a legacy-format entry (domain/pathPattern, no pageType)
    const jsonlPath = join(tmpDir, "patterns.jsonl");
    const legacyEntry = JSON.stringify({
      domain: "legacy.com",
      pathPattern: "/old/path",
      toolSequence: ["navigate", "view_page"],
      outcome: "success",
      contentHash: "legacyhash000000",
      timestamp: 1700000000000,
    });
    const newEntry = JSON.stringify({
      pageType: "login_0",
      toolSequence: ["navigate", "view_page", "click"],
      outcome: "success",
      contentHash: "newhash000000000",
      timestamp: 1700000001000,
    });
    await writeFile(jsonlPath, legacyEntry + "\n" + newEntry + "\n", "utf-8");

    const all = await store.getAll();
    // Legacy entry should be skipped, only the new-format entry remains
    expect(all).toHaveLength(1);
    expect(all[0].pageType).toBe("login_0");
  });
});
