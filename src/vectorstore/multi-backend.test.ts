// ABOUTME: Unit tests for MultiBackendVectorStore
// ABOUTME: Verifies write delegation to all backends, read delegation to first, and fail-fast behavior

/**
 * Tests for the MultiBackendVectorStore class.
 *
 * The multi-backend wrapper is used during sync operations to populate
 * both Chroma and Qdrant from a single pipeline run — avoiding duplicate
 * LLM inference costs.
 *
 * Key behaviors:
 * - Writes (initialize, store, delete) delegate to ALL backends in parallel
 * - Reads (search, keywordSearch) delegate to the FIRST backend only
 * - Fail-fast: if any backend errors, the whole operation rejects
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MultiBackendVectorStore } from "./multi-backend";
import type {
  VectorStore,
  VectorDocument,
  SearchResult,
  CollectionOptions,
} from "./types";

/** Creates a mock VectorStore with all methods stubbed */
function createMockBackend(): VectorStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    keywordSearch: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

const testDocs: VectorDocument[] = [
  { id: "doc-1", text: "Test document one", metadata: { kind: "Deployment" } },
  { id: "doc-2", text: "Test document two", metadata: { kind: "Service" } },
];

const testResults: SearchResult[] = [
  {
    id: "doc-1",
    text: "Test document one",
    metadata: { kind: "Deployment" },
    score: 0.1,
  },
];

const testOptions: CollectionOptions = { distanceMetric: "cosine" };

describe("MultiBackendVectorStore", () => {
  let backend1: VectorStore;
  let backend2: VectorStore;
  let multi: MultiBackendVectorStore;

  beforeEach(() => {
    backend1 = createMockBackend();
    backend2 = createMockBackend();
    multi = new MultiBackendVectorStore([backend1, backend2]);
  });

  describe("constructor", () => {
    it("throws if no backends are provided", () => {
      expect(() => new MultiBackendVectorStore([])).toThrow(
        "MultiBackendVectorStore requires at least one backend"
      );
    });

    it("accepts a single backend", () => {
      const single = new MultiBackendVectorStore([backend1]);
      expect(single).toBeDefined();
    });
  });

  describe("initialize (write operation)", () => {
    it("delegates to all backends in parallel", async () => {
      await multi.initialize("capabilities", testOptions);

      expect(backend1.initialize).toHaveBeenCalledWith(
        "capabilities",
        testOptions
      );
      expect(backend2.initialize).toHaveBeenCalledWith(
        "capabilities",
        testOptions
      );
    });

    it("rejects if any backend fails", async () => {
      vi.mocked(backend2.initialize).mockRejectedValue(
        new Error("Qdrant connection refused")
      );

      await expect(
        multi.initialize("capabilities", testOptions)
      ).rejects.toThrow("Qdrant connection refused");
    });
  });

  describe("store (write operation)", () => {
    it("delegates to all backends in parallel", async () => {
      await multi.store("capabilities", testDocs);

      expect(backend1.store).toHaveBeenCalledWith("capabilities", testDocs);
      expect(backend2.store).toHaveBeenCalledWith("capabilities", testDocs);
    });

    it("rejects if any backend fails", async () => {
      vi.mocked(backend1.store).mockRejectedValue(
        new Error("Chroma disk full")
      );

      await expect(multi.store("capabilities", testDocs)).rejects.toThrow(
        "Chroma disk full"
      );
    });
  });

  describe("delete (write operation)", () => {
    it("delegates to all backends in parallel", async () => {
      const ids = ["doc-1", "doc-2"];
      await multi.delete("capabilities", ids);

      expect(backend1.delete).toHaveBeenCalledWith("capabilities", ids);
      expect(backend2.delete).toHaveBeenCalledWith("capabilities", ids);
    });

    it("rejects if any backend fails", async () => {
      vi.mocked(backend2.delete).mockRejectedValue(
        new Error("Qdrant timeout")
      );

      await expect(multi.delete("capabilities", ["doc-1"])).rejects.toThrow(
        "Qdrant timeout"
      );
    });
  });

  describe("search (read operation)", () => {
    it("delegates to the first backend only", async () => {
      vi.mocked(backend1.search).mockResolvedValue(testResults);

      const results = await multi.search("capabilities", "database");

      expect(backend1.search).toHaveBeenCalledWith(
        "capabilities",
        "database",
        undefined
      );
      expect(backend2.search).not.toHaveBeenCalled();
      expect(results).toEqual(testResults);
    });

    it("passes search options to the first backend", async () => {
      const opts = { nResults: 5, where: { kind: "Deployment" } };
      await multi.search("capabilities", "database", opts);

      expect(backend1.search).toHaveBeenCalledWith(
        "capabilities",
        "database",
        opts
      );
    });
  });

  describe("keywordSearch (read operation)", () => {
    it("delegates to the first backend only", async () => {
      vi.mocked(backend1.keywordSearch).mockResolvedValue(testResults);

      const results = await multi.keywordSearch("capabilities", "deploy");

      expect(backend1.keywordSearch).toHaveBeenCalledWith(
        "capabilities",
        "deploy",
        undefined
      );
      expect(backend2.keywordSearch).not.toHaveBeenCalled();
      expect(results).toEqual(testResults);
    });

    it("passes search options to the first backend", async () => {
      const opts = { nResults: 10, where: { kind: "Service" } };
      await multi.keywordSearch("capabilities", undefined, opts);

      expect(backend1.keywordSearch).toHaveBeenCalledWith(
        "capabilities",
        undefined,
        opts
      );
    });
  });

  describe("parallel execution", () => {
    it("runs write operations concurrently, not sequentially", async () => {
      const order: string[] = [];

      vi.mocked(backend1.store).mockImplementation(async () => {
        order.push("b1-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("b1-end");
      });

      vi.mocked(backend2.store).mockImplementation(async () => {
        order.push("b2-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("b2-end");
      });

      await multi.store("capabilities", testDocs);

      // Both should start before either ends (parallel execution)
      expect(order.indexOf("b1-start")).toBeLessThan(order.indexOf("b1-end"));
      expect(order.indexOf("b2-start")).toBeLessThan(order.indexOf("b2-end"));
      // Both start before any end
      const firstEnd = Math.min(
        order.indexOf("b1-end"),
        order.indexOf("b2-end")
      );
      expect(order.indexOf("b1-start")).toBeLessThan(firstEnd);
      expect(order.indexOf("b2-start")).toBeLessThan(firstEnd);
    });
  });

  describe("with three backends", () => {
    it("delegates writes to all three backends", async () => {
      const backend3 = createMockBackend();
      const triple = new MultiBackendVectorStore([
        backend1,
        backend2,
        backend3,
      ]);

      await triple.store("capabilities", testDocs);

      expect(backend1.store).toHaveBeenCalledWith("capabilities", testDocs);
      expect(backend2.store).toHaveBeenCalledWith("capabilities", testDocs);
      expect(backend3.store).toHaveBeenCalledWith("capabilities", testDocs);
    });

    it("reads from the first backend only", async () => {
      const backend3 = createMockBackend();
      const triple = new MultiBackendVectorStore([
        backend1,
        backend2,
        backend3,
      ]);

      await triple.search("capabilities", "query");

      expect(backend1.search).toHaveBeenCalled();
      expect(backend2.search).not.toHaveBeenCalled();
      expect(backend3.search).not.toHaveBeenCalled();
    });
  });
});
