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
  CortexHint,
  HintMatchResult,
  TelemetryPayload,
  TelemetryConfig,
} from "./cortex-types.js";
import {
  MIN_SEQUENCE_LENGTH,
  MAX_SEQUENCE_LENGTH,
  SEQUENCE_TIMEOUT_MS,
  TELEMETRY_RATE_LIMIT_MS,
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

  // ==========================================================================
  // Story 12.3: Cortex Hint Type Shapes
  // ==========================================================================

  describe("CortexHint shape (Story 12.3)", () => {
    it("has all required fields with correct types", () => {
      const hint: CortexHint = {
        toolSequence: ["navigate", "view_page", "click", "wait_for"],
        successRate: 1.0,
        installationCount: 3,
        pathPattern: "/users/:id/profile",
        domain: "dashboard.example.com",
      };

      expect(hint.toolSequence).toEqual(["navigate", "view_page", "click", "wait_for"]);
      expect(hint.successRate).toBe(1.0);
      expect(hint.installationCount).toBe(3);
      expect(hint.pathPattern).toBe("/users/:id/profile");
      expect(hint.domain).toBe("dashboard.example.com");
    });

    it("successRate is between 0 and 1", () => {
      const hint: CortexHint = {
        toolSequence: ["navigate", "view_page"],
        successRate: 0.75,
        installationCount: 4,
        pathPattern: "/",
        domain: "example.com",
      };
      expect(hint.successRate).toBeGreaterThanOrEqual(0);
      expect(hint.successRate).toBeLessThanOrEqual(1);
    });
  });

  describe("HintMatchResult shape (Story 12.3)", () => {
    it("has hints array and matchCount", () => {
      const result: HintMatchResult = {
        hints: [{
          toolSequence: ["navigate", "view_page"],
          successRate: 1.0,
          installationCount: 1,
          pathPattern: "/dashboard",
          domain: "example.com",
        }],
        matchCount: 1,
      };

      expect(result.hints).toHaveLength(1);
      expect(result.matchCount).toBe(1);
    });

    it("empty result has empty hints and zero matchCount", () => {
      const result: HintMatchResult = {
        hints: [],
        matchCount: 0,
      };

      expect(result.hints).toHaveLength(0);
      expect(result.matchCount).toBe(0);
    });
  });

  // ==========================================================================
  // Story 12.5: Telemetry Upload Type Shapes
  // ==========================================================================

  describe("TelemetryPayload shape (Story 12.5)", () => {
    it("has all required fields with correct types", () => {
      const payload: TelemetryPayload = {
        domain: "example.com",
        pathPattern: "/users/:id/profile",
        toolSequence: ["navigate", "view_page", "click"],
        successRate: 1.0,
        contentHash: "a1b2c3d4e5f6a7b8",
        timestamp: 1700000000000,
      };

      expect(payload.domain).toBe("example.com");
      expect(payload.pathPattern).toBe("/users/:id/profile");
      expect(payload.toolSequence).toEqual(["navigate", "view_page", "click"]);
      expect(payload.successRate).toBe(1.0);
      expect(payload.contentHash).toBe("a1b2c3d4e5f6a7b8");
      expect(typeof payload.timestamp).toBe("number");
    });

    it("contains exactly 6 whitelisted fields (NFR21)", () => {
      const payload: TelemetryPayload = {
        domain: "test.com",
        pathPattern: "/",
        toolSequence: ["navigate", "view_page"],
        successRate: 1.0,
        contentHash: "0000000000000000",
        timestamp: 0,
      };
      const keys = Object.keys(payload);
      expect(keys).toHaveLength(6);
      expect(keys.sort()).toEqual(
        ["contentHash", "domain", "pathPattern", "successRate", "timestamp", "toolSequence"],
      );
    });
  });

  describe("TelemetryConfig shape (Story 12.5)", () => {
    it("has enabled, endpoint, and rateLimitMs fields", () => {
      const config: TelemetryConfig = {
        enabled: false,
        endpoint: "https://cortex.public-browser.dev/v1/patterns",
        rateLimitMs: 60_000,
      };

      expect(config.enabled).toBe(false);
      expect(config.endpoint).toBe("https://cortex.public-browser.dev/v1/patterns");
      expect(config.rateLimitMs).toBe(60_000);
    });

    it("enabled defaults to false in typical usage", () => {
      const config: TelemetryConfig = {
        enabled: false,
        endpoint: "https://example.com/v1/patterns",
        rateLimitMs: 60_000,
      };
      expect(config.enabled).toBe(false);
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

    it("TELEMETRY_RATE_LIMIT_MS is 60_000 (Story 12.5)", () => {
      expect(TELEMETRY_RATE_LIMIT_MS).toBe(60_000);
    });
  });
});
