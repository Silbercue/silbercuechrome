/**
 * Story 12.1 (Task 4.1): Type-shape validation for cortex types.
 *
 * Verifies that CortexPattern and ToolCallEvent interfaces contain all
 * required fields and that constants are exported with correct values.
 */
import { describe, it, expect } from "vitest";
import type {
  CortexPattern,
  ToolCallEvent,
  MerkleNode,
  MerkleInclusionProof,
  SignedTreeHead,
  LocalStoreOptions,
} from "./cortex-types.js";
import {
  MIN_SEQUENCE_LENGTH,
  MAX_SEQUENCE_LENGTH,
  SEQUENCE_TIMEOUT_MS,
} from "./cortex-types.js";

describe("cortex-types (Story 12.1)", () => {
  describe("CortexPattern shape", () => {
    it("has all required fields with correct types", () => {
      const pattern: CortexPattern = {
        domain: "example.com",
        pathPattern: "/users/:id/profile",
        toolSequence: ["navigate", "view_page", "click"],
        outcome: "success",
        contentHash: "a1b2c3d4e5f6a7b8",
        timestamp: Date.now(),
      };

      expect(pattern.domain).toBe("example.com");
      expect(pattern.pathPattern).toBe("/users/:id/profile");
      expect(pattern.toolSequence).toEqual(["navigate", "view_page", "click"]);
      expect(pattern.outcome).toBe("success");
      expect(pattern.contentHash).toBe("a1b2c3d4e5f6a7b8");
      expect(typeof pattern.timestamp).toBe("number");
    });

    it("outcome is constrained to 'success'", () => {
      const pattern: CortexPattern = {
        domain: "test.com",
        pathPattern: "/",
        toolSequence: ["navigate", "view_page"],
        outcome: "success",
        contentHash: "0000000000000000",
        timestamp: 0,
      };
      expect(pattern.outcome).toBe("success");
    });
  });

  describe("ToolCallEvent shape", () => {
    it("has all required fields with correct types", () => {
      const event: ToolCallEvent = {
        toolName: "click",
        timestamp: Date.now(),
        domain: "example.com",
        path: "/users/123/profile",
        contentHash: "a1b2c3d4e5f6a7b8",
      };

      expect(event.toolName).toBe("click");
      expect(typeof event.timestamp).toBe("number");
      expect(event.domain).toBe("example.com");
      expect(event.path).toBe("/users/123/profile");
      expect(event.contentHash).toBe("a1b2c3d4e5f6a7b8");
    });
  });

  // ==========================================================================
  // Story 12.2: Merkle Log Type Shapes
  // ==========================================================================

  describe("MerkleNode shape (Story 12.2)", () => {
    it("has hash, left, and right fields", () => {
      const leaf: MerkleNode = { hash: "abc123", left: null, right: null };
      expect(leaf.hash).toBe("abc123");
      expect(leaf.left).toBeNull();
      expect(leaf.right).toBeNull();
    });

    it("supports nested tree structure", () => {
      const left: MerkleNode = { hash: "left", left: null, right: null };
      const right: MerkleNode = { hash: "right", left: null, right: null };
      const parent: MerkleNode = { hash: "parent", left, right };

      expect(parent.left).toBe(left);
      expect(parent.right).toBe(right);
    });
  });

  describe("MerkleInclusionProof shape (Story 12.2)", () => {
    it("has leafIndex, treeSize, and hashes fields", () => {
      const proof: MerkleInclusionProof = {
        leafIndex: 3,
        treeSize: 8,
        hashes: ["aaa", "bbb", "ccc"],
      };
      expect(proof.leafIndex).toBe(3);
      expect(proof.treeSize).toBe(8);
      expect(proof.hashes).toEqual(["aaa", "bbb", "ccc"]);
    });

    it("empty proof is valid shape", () => {
      const proof: MerkleInclusionProof = {
        leafIndex: 0,
        treeSize: 1,
        hashes: [],
      };
      expect(proof.hashes).toHaveLength(0);
    });
  });

  describe("SignedTreeHead shape (Story 12.2)", () => {
    it("has treeSize, rootHash, and timestamp fields", () => {
      const sth: SignedTreeHead = {
        treeSize: 42,
        rootHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        timestamp: 1700000000000,
      };
      expect(sth.treeSize).toBe(42);
      expect(sth.rootHash).toHaveLength(64);
      expect(sth.timestamp).toBe(1700000000000);
    });

    it("empty tree head uses conventional defaults", () => {
      const sth: SignedTreeHead = {
        treeSize: 0,
        rootHash: "",
        timestamp: 0,
      };
      expect(sth.treeSize).toBe(0);
      expect(sth.rootHash).toBe("");
    });
  });

  describe("LocalStoreOptions shape (Story 12.2)", () => {
    it("dataDir is optional", () => {
      const opts: LocalStoreOptions = {};
      expect(opts.dataDir).toBeUndefined();
    });

    it("accepts a custom dataDir", () => {
      const opts: LocalStoreOptions = { dataDir: "/tmp/cortex-test" };
      expect(opts.dataDir).toBe("/tmp/cortex-test");
    });
  });

  describe("Constants", () => {
    it("MIN_SEQUENCE_LENGTH is 2", () => {
      expect(MIN_SEQUENCE_LENGTH).toBe(2);
    });

    it("MAX_SEQUENCE_LENGTH is 20", () => {
      expect(MAX_SEQUENCE_LENGTH).toBe(20);
    });

    it("SEQUENCE_TIMEOUT_MS is 60_000", () => {
      expect(SEQUENCE_TIMEOUT_MS).toBe(60_000);
    });
  });
});
