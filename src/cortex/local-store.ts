/**
 * Story 12.2: Local Merkle Append-Only Log.
 *
 * Provides cryptographically secured persistence for CortexPatterns using
 * an RFC-6962-compatible Merkle hash tree. Patterns are stored in a JSONL
 * file (append-only), and the current tree head is kept in a separate JSON
 * file for fast integrity checks.
 *
 * Design principles:
 *  - Append-only: patterns.jsonl is never overwritten, only appended to.
 *  - No external dependencies: only node:crypto, node:fs/promises, node:path, node:os.
 *  - Passive consumer: never throws errors that could disrupt the tool flow.
 *  - RFC-6962 Section 2.1 compliant hashing (0x00 leaf prefix, 0x01 interior prefix).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { debug } from "../cdp/debug.js";
import type {
  CortexPattern,
  SignedTreeHead,
  MerkleInclusionProof,
  LocalStoreOptions,
} from "./cortex-types.js";

const PATTERNS_FILE = "patterns.jsonl";
const TREE_HEAD_FILE = "tree-head.json";

/**
 * RFC-6962: largest power of 2 strictly less than n.
 * Used to split the leaf set when building the Merkle tree.
 * Example: n=5 → 4, n=7 → 4, n=9 → 8.
 */
function largestPowerOfTwoLessThan(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Default empty tree head returned when no data exists. */
const EMPTY_TREE_HEAD: SignedTreeHead = {
  treeSize: 0,
  rootHash: "",
  timestamp: 0,
};

export class LocalStore {
  private readonly _dataDir: string;
  private _dirEnsured = false;

  constructor(options?: LocalStoreOptions) {
    this._dataDir =
      options?.dataDir ??
      process.env.PUBLIC_BROWSER_CORTEX_DIR ??
      join(homedir(), ".public-browser", "cortex");
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** H4: Promise chain to serialize concurrent appends. */
  private _writeQueue: Promise<void> = Promise.resolve();

  /**
   * Append a pattern to the JSONL log and update the Merkle tree head.
   * Append-only: the patterns file is never overwritten.
   * H4: Serialized via _writeQueue to prevent race conditions.
   */
  async append(pattern: CortexPattern): Promise<void> {
    this._writeQueue = this._writeQueue.then(() => this._doAppend(pattern));
    return this._writeQueue;
  }

  /**
   * Internal append implementation — runs inside the serialized write queue.
   * M3: Wrapped in try/catch for graceful degradation.
   */
  private async _doAppend(pattern: CortexPattern): Promise<void> {
    try {
      await this._ensureDir();

      // H5: Check for dedup — same pageType means update in-place,
      // do NOT write a new JSONL entry. Only the in-memory state is updated.
      // Story 12a.2: Dedup key changed from domain+pathPattern to pageType.
      const existing = await this._readPatternsRaw();
      const dupIdx = existing.findIndex(
        (p) => p.pageType === pattern.pageType,
      );
      if (dupIdx >= 0) {
        // Replace in-memory only — rewrite the full file to keep persistence consistent.
        // H2 fix: Atomic write via temp file + rename (same pattern as _writeTreeHead).
        // A crash during writeFile would corrupt the JSONL; rename() is atomic on POSIX.
        existing[dupIdx] = pattern;
        const content = existing.map((p) => JSON.stringify(p)).join("\n") + "\n";
        const target = join(this._dataDir, PATTERNS_FILE);
        const tmp = target + "." + randomBytes(4).toString("hex") + ".tmp";
        await writeFile(tmp, content, "utf-8");
        await rename(tmp, target);
      } else {
        const line = JSON.stringify(pattern) + "\n";
        await appendFile(join(this._dataDir, PATTERNS_FILE), line, "utf-8");
      }

      // Recompute tree head from all leaves
      const patterns = await this._readPatternsRaw();
      const leafHashes = patterns.map((p) => this._hashLeaf(p));
      const rootHash = this._buildTree(leafHashes);
      const head: SignedTreeHead = {
        treeSize: patterns.length,
        rootHash,
        timestamp: Date.now(),
      };
      await this._writeTreeHead(head);
    } catch (err) {
      // M3: graceful degradation — log and swallow
      debug(
        "[local-store] append failed: %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Read all patterns from the JSONL file. */
  async getAll(): Promise<CortexPattern[]> {
    await this._ensureDir();
    return this._readPatternsRaw();
  }

  /** Read the current Signed Tree Head. */
  async getTreeHead(): Promise<SignedTreeHead> {
    try {
      const raw = await readFile(join(this._dataDir, TREE_HEAD_FILE), "utf-8");
      const parsed = JSON.parse(raw) as SignedTreeHead;
      return parsed;
    } catch {
      return { ...EMPTY_TREE_HEAD };
    }
  }

  /**
   * Compute an RFC-6962-compatible inclusion proof for the given leaf index.
   * The proof consists of the sibling sub-tree hashes needed to recompute
   * the path from the leaf to the root, matching the recursive _buildTree split.
   */
  async getInclusionProof(leafIndex: number): Promise<MerkleInclusionProof> {
    const patterns = await this._readPatternsRaw();
    const leafHashes = patterns.map((p) => this._hashLeaf(p));

    if (leafIndex < 0 || leafIndex >= leafHashes.length) {
      return { leafIndex, treeSize: leafHashes.length, hashes: [] };
    }

    const hashes: string[] = [];
    this._collectProof(leafHashes, leafIndex, hashes);

    return {
      leafIndex,
      treeSize: leafHashes.length,
      hashes,
    };
  }

  /**
   * Recursively collect the inclusion proof hashes mirroring _buildTree.
   * At each split point (k = largest power of 2 < n), the proof includes
   * the hash of the subtree that does NOT contain the target leaf.
   *
   * Order: bottom-up (deepest sibling first) so that verifyInclusionProof
   * can walk from leaf to root in natural order.
   */
  private _collectProof(hashes: string[], targetIdx: number, proof: string[]): void {
    if (hashes.length <= 1) return;

    const k = largestPowerOfTwoLessThan(hashes.length);
    if (targetIdx < k) {
      // Target is in the left subtree — recurse first, then add right subtree hash
      this._collectProof(hashes.slice(0, k), targetIdx, proof);
      proof.push(this._buildTree(hashes.slice(k)));
    } else {
      // Target is in the right subtree — recurse first, then add left subtree hash
      this._collectProof(hashes.slice(k), targetIdx - k, proof);
      proof.push(this._buildTree(hashes.slice(0, k)));
    }
  }

  /**
   * Verify an inclusion proof against a root hash.
   * Static method — can be called without a LocalStore instance.
   *
   * The proof mirrors the RFC-6962 recursive tree structure:
   * at each level, the sibling sub-tree hash is combined with
   * the running hash. The side (left/right) depends on whether
   * the target index falls in the left or right subtree at each split.
   *
   * @returns true if the proof is valid, false if manipulation is detected.
   */
  static verifyInclusionProof(
    proof: MerkleInclusionProof,
    leafHash: string,
    rootHash: string,
  ): boolean {
    // H2: Input validation
    if (proof.treeSize <= 0) return false;
    if (proof.leafIndex < 0 || proof.leafIndex >= proof.treeSize) return false;
    if (proof.treeSize === 1) return leafHash === rootHash && proof.hashes.length === 0;

    // For treeSize > 1, we need at least one proof hash
    if (proof.hashes.length === 0) return false;

    // The proof is ordered bottom-up (deepest sibling first).
    // To verify, we reconstruct the path from leaf to root.
    // First, compute the sequence of (subtreeSize, side) from root to leaf,
    // then reverse it to walk bottom-up.
    const steps: Array<{ n: number; leftSide: boolean }> = [];
    let n = proof.treeSize;
    let idx = proof.leafIndex;
    while (n > 1) {
      const k = LocalStore._largestPowerOfTwoLessThan(n);
      if (idx < k) {
        steps.push({ n, leftSide: true });
        n = k;
      } else {
        steps.push({ n, leftSide: false });
        idx -= k;
        n = n - k;
      }
    }

    // Proof length must match the number of steps
    if (proof.hashes.length !== steps.length) return false;

    // Walk bottom-up: proof[0] is the sibling at the deepest level
    let current = leafHash;
    for (let i = 0; i < proof.hashes.length; i++) {
      // steps are top-down, proof is bottom-up — use reverse index for steps
      const step = steps[steps.length - 1 - i];
      if (step.leftSide) {
        // Target was in left subtree, sibling is right subtree hash
        current = LocalStore._hashPairStatic(current, proof.hashes[i]);
      } else {
        // Target was in right subtree, sibling is left subtree hash
        current = LocalStore._hashPairStatic(proof.hashes[i], current);
      }
    }

    return current === rootHash;
  }

  /** Static version of largestPowerOfTwoLessThan for use in verifyInclusionProof. */
  private static _largestPowerOfTwoLessThan(n: number): number {
    return largestPowerOfTwoLessThan(n);
  }

  /**
   * Full integrity verification: re-hash all leaves, rebuild the tree,
   * and compare against the stored tree head.
   */
  async verifyIntegrity(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    let patterns: CortexPattern[];
    try {
      patterns = await this._readPatternsRaw();
    } catch (err) {
      return {
        valid: false,
        errors: [`Failed to read patterns: ${err instanceof Error ? err.message : String(err)}`],
      };
    }

    let storedHead: SignedTreeHead;
    try {
      storedHead = await this.getTreeHead();
    } catch (err) {
      return {
        valid: false,
        errors: [
          `Failed to read tree head: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }

    // H3: Explicit empty-log check — rootHash must be "" and treeSize must be 0
    if (patterns.length === 0) {
      if (storedHead.treeSize !== 0 || storedHead.rootHash !== "") {
        errors.push("Non-empty tree head for empty log — possible manipulation");
      }
      return { valid: errors.length === 0, errors };
    }

    // Check tree size matches
    if (storedHead.treeSize !== patterns.length) {
      errors.push(
        `Tree size mismatch: stored ${storedHead.treeSize}, actual ${patterns.length}`,
      );
    }

    // Recompute root hash from leaves
    const leafHashes = patterns.map((p) => this._hashLeaf(p));
    const computedRoot = this._buildTree(leafHashes);
    if (computedRoot !== storedHead.rootHash) {
      errors.push(
        `Root hash mismatch: stored ${storedHead.rootHash}, computed ${computedRoot}`,
      );
    }

    return { valid: errors.length === 0, errors };
  }

  // =========================================================================
  // Private — Hashing (RFC 6962 Section 2.1)
  // =========================================================================

  /**
   * RFC-6962 Leaf hash: SHA-256(0x00 || leaf_data).
   * The 0x00 prefix distinguishes leaf hashes from interior hashes,
   * preventing second-preimage attacks.
   */
  _hashLeaf(pattern: CortexPattern): string {
    const data = Buffer.from(this._canonicalJson(pattern), "utf-8");
    const hash = createHash("sha256");
    hash.update(Buffer.from([0x00]));
    hash.update(data);
    return hash.digest("hex");
  }

  /**
   * RFC-6962 Interior node hash: SHA-256(0x01 || left || right).
   * The 0x01 prefix is the boundary between leaf and interior hashes.
   */
  _hashPair(left: string, right: string): string {
    return LocalStore._hashPairStatic(left, right);
  }

  /** Static version for use in verifyInclusionProof. */
  private static _hashPairStatic(left: string, right: string): string {
    const hash = createHash("sha256");
    hash.update(Buffer.from([0x01]));
    hash.update(Buffer.from(left, "hex"));
    hash.update(Buffer.from(right, "hex"));
    return hash.digest("hex");
  }

  /**
   * Build a Merkle tree from leaf hashes and return the root hash.
   * RFC-6962 Section 2.1 compliant: uses largest power of two less than n
   * to split, NOT leaf duplication.
   *
   * MTH({})       = SHA-256("")  (we return "" for empty)
   * MTH({d(0)})   = SHA-256(0x00 || d(0))  (leaf hash, already computed)
   * MTH(D[n])     = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n]))
   *                 where k = largest power of 2 less than n
   */
  _buildTree(leafHashes: string[]): string {
    if (leafHashes.length === 0) return "";
    if (leafHashes.length === 1) return leafHashes[0];

    const k = largestPowerOfTwoLessThan(leafHashes.length);
    const left = this._buildTree(leafHashes.slice(0, k));
    const right = this._buildTree(leafHashes.slice(k));
    return this._hashPair(left, right);
  }

  // =========================================================================
  // Private — File I/O
  // =========================================================================

  /** Ensure the data directory exists (lazy, only on first write/read). */
  private async _ensureDir(): Promise<void> {
    if (this._dirEnsured) return;
    await mkdir(this._dataDir, { recursive: true });
    this._dirEnsured = true;
  }

  /**
   * Read all patterns from the JSONL file, skipping corrupt lines.
   *
   * Story 12a.2: Also skips legacy entries that lack the `pageType` field
   * (old domain/pathPattern format). This provides a clean transition
   * without migration code — old entries are simply ignored.
   */
  private async _readPatternsRaw(): Promise<CortexPattern[]> {
    let raw: string;
    try {
      raw = await readFile(join(this._dataDir, PATTERNS_FILE), "utf-8");
    } catch {
      return [];
    }

    const patterns: CortexPattern[] = [];
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        // Story 12a.2: Skip legacy entries without pageType field
        if (!parsed.pageType) {
          debug("[local-store] Skipping legacy entry without pageType");
          continue;
        }
        patterns.push(parsed as CortexPattern);
      } catch {
        debug("[local-store] Skipping corrupt JSONL line: %s", line.slice(0, 80));
      }
    }
    return patterns;
  }

  /** Atomically write the tree head (write to temp, then rename). */
  private async _writeTreeHead(head: SignedTreeHead): Promise<void> {
    const target = join(this._dataDir, TREE_HEAD_FILE);
    const tmp = target + "." + randomBytes(4).toString("hex") + ".tmp";
    await writeFile(tmp, JSON.stringify(head, null, 2) + "\n", "utf-8");
    await rename(tmp, target);
  }

  /**
   * Canonical JSON serialization: keys sorted alphabetically.
   * This ensures deterministic hashing regardless of property insertion order.
   */
  private _canonicalJson(obj: CortexPattern): string {
    return JSON.stringify(obj, Object.keys(obj).sort());
  }
}
