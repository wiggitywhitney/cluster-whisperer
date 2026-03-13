// ABOUTME: Integration tests for QdrantBackend against a real Qdrant instance
// ABOUTME: Tests full lifecycle: initialize, store, search, keywordSearch, delete
/**
 * qdrant-backend.integration.test.ts - Integration tests for QdrantBackend
 *
 * Tests the full VectorStore lifecycle against a real Qdrant instance.
 * Verifies that the QdrantBackend correctly creates collections, stores
 * documents with embeddings, and retrieves them via vector search and
 * keyword/metadata filtering.
 *
 * Requires:
 * - Qdrant running at http://localhost:6333 (or QDRANT_URL)
 * - VOYAGE_API_KEY environment variable set
 *
 * These tests are slower (~5-10 seconds) and cost real API credits.
 * They create a unique test collection per run and clean up after.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QdrantBackend } from "./qdrant-backend";
import { VoyageEmbedding } from "./embeddings";
import type { VectorStore, VectorDocument } from "./types";

// ---------------------------------------------------------------------------
// Skip check
// ---------------------------------------------------------------------------

/**
 * Check if integration test dependencies are available.
 * Needs both a running Qdrant server and a Voyage AI API key.
 */
async function shouldSkip(): Promise<string | false> {
  if (!process.env.VOYAGE_API_KEY) {
    return "VOYAGE_API_KEY not set";
  }

  const qdrantUrl = process.env.QDRANT_URL ?? "http://localhost:6333";
  try {
    const response = await fetch(`${qdrantUrl}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return `Qdrant not healthy at ${qdrantUrl} (status ${response.status})`;
    }
  } catch {
    return `Qdrant not reachable at ${qdrantUrl}`;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

/**
 * Test documents representing Kubernetes resource capabilities.
 * Chosen to have distinct semantic meanings for search verification.
 */
const TEST_DOCUMENTS: VectorDocument[] = [
  {
    id: "apps/v1/Deployment",
    text: "Deployment manages a set of identical pods, ensuring a specified number of replicas are running. Supports rolling updates and rollbacks for zero-downtime deployments.",
    metadata: { kind: "Deployment", apiGroup: "apps", complexity: "basic" },
  },
  {
    id: "v1/Service",
    text: "Service provides stable network endpoints for accessing a set of pods. Supports ClusterIP, NodePort, and LoadBalancer types for internal and external traffic routing.",
    metadata: { kind: "Service", apiGroup: "", complexity: "basic" },
  },
  {
    id: "sql.cnrm.cloud.google.com/v1beta1/SQLInstance",
    text: "SQLInstance provisions and manages a Cloud SQL database instance. Supports PostgreSQL, MySQL, and SQL Server with automated backups, high availability, and maintenance windows.",
    metadata: {
      kind: "SQLInstance",
      apiGroup: "sql.cnrm.cloud.google.com",
      complexity: "advanced",
    },
  },
  {
    id: "batch/v1/CronJob",
    text: "CronJob creates Jobs on a repeating schedule. Useful for periodic tasks like database backups, report generation, and cleanup operations.",
    metadata: { kind: "CronJob", apiGroup: "batch", complexity: "basic" },
  },
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("QdrantBackend integration", () => {
  let skipReason: string | false;
  let backend: VectorStore;
  const collectionName = `test-qdrant-${Date.now()}`;

  beforeAll(async () => {
    skipReason = await shouldSkip();
    if (skipReason) return;

    const embedder = new VoyageEmbedding();
    backend = new QdrantBackend(embedder, {
      qdrantUrl: process.env.QDRANT_URL,
      vectorSize: 1024, // voyage-4 produces 1024-dimensional vectors
    });

    // Initialize collection and store test data
    await backend.initialize(collectionName, { distanceMetric: "cosine" });
    await backend.store(collectionName, TEST_DOCUMENTS);

    // Brief pause for Qdrant to index the points
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 30000);

  afterAll(async () => {
    if (skipReason) return;

    // Clean up: delete all test documents
    try {
      await backend.delete(
        collectionName,
        TEST_DOCUMENTS.map((d) => d.id)
      );
    } catch {
      // Best-effort cleanup
    }
  });

  // ---------------------------------------------------------------------------
  // Semantic search
  // ---------------------------------------------------------------------------

  it("finds database-related resources via semantic search", async () => {
    if (skipReason) return expect(true).toBe(true); // skip

    const results = await backend.search(collectionName, "managed database", {
      nResults: 2,
    });

    expect(results.length).toBeGreaterThan(0);
    // SQLInstance should be the top result for "managed database"
    expect(results[0].id).toBe(
      "sql.cnrm.cloud.google.com/v1beta1/SQLInstance"
    );
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].metadata.kind).toBe("SQLInstance");
  });

  it("finds networking resources via semantic search", async () => {
    if (skipReason) return expect(true).toBe(true); // skip

    const results = await backend.search(
      collectionName,
      "network load balancer traffic routing",
      { nResults: 2 }
    );

    expect(results.length).toBeGreaterThan(0);
    // Service should rank high for networking queries
    expect(results[0].id).toBe("v1/Service");
  });

  // ---------------------------------------------------------------------------
  // Semantic search with metadata filter
  // ---------------------------------------------------------------------------

  it("filters semantic search by metadata", async () => {
    if (skipReason) return expect(true).toBe(true); // skip

    const results = await backend.search(collectionName, "database backup", {
      nResults: 5,
      where: { complexity: "basic" },
    });

    // All results should be "basic" complexity
    for (const result of results) {
      expect(result.metadata.complexity).toBe("basic");
    }
    // SQLInstance (advanced) should NOT appear
    expect(results.map((r) => r.id)).not.toContain(
      "sql.cnrm.cloud.google.com/v1beta1/SQLInstance"
    );
  });

  // ---------------------------------------------------------------------------
  // Keyword search (metadata-only filtering)
  // ---------------------------------------------------------------------------

  it("filters by metadata without keyword", async () => {
    if (skipReason) return expect(true).toBe(true); // skip

    const results = await backend.keywordSearch(collectionName, undefined, {
      where: { kind: "Deployment" },
    });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("apps/v1/Deployment");
    expect(results[0].score).toBe(-1); // no vector comparison
  });

  it("filters by multiple metadata fields", async () => {
    if (skipReason) return expect(true).toBe(true); // skip

    const results = await backend.keywordSearch(collectionName, undefined, {
      where: { kind: "CronJob", apiGroup: "batch" },
    });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("batch/v1/CronJob");
  });

  // ---------------------------------------------------------------------------
  // Keyword search (text matching)
  // ---------------------------------------------------------------------------

  it("finds documents by keyword in text", async () => {
    if (skipReason) return expect(true).toBe(true); // skip

    const results = await backend.keywordSearch(collectionName, "backups");

    expect(results.length).toBeGreaterThan(0);
    // Both SQLInstance and CronJob mention backups
    const ids = results.map((r) => r.id);
    expect(
      ids.includes("sql.cnrm.cloud.google.com/v1beta1/SQLInstance") ||
        ids.includes("batch/v1/CronJob")
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  it("deletes a document and confirms it is gone", async () => {
    if (skipReason) return expect(true).toBe(true); // skip

    // Store a temporary document
    const tempDoc: VectorDocument = {
      id: "test/temp/ToDelete",
      text: "Temporary document for delete test",
      metadata: { kind: "Temporary", apiGroup: "test", complexity: "basic" },
    };
    await backend.store(collectionName, [tempDoc]);

    // Verify it exists
    const before = await backend.keywordSearch(collectionName, undefined, {
      where: { kind: "Temporary" },
    });
    expect(before.length).toBe(1);

    // Delete it
    await backend.delete(collectionName, ["test/temp/ToDelete"]);

    // Brief pause for Qdrant to process the delete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify it's gone
    const after = await backend.keywordSearch(collectionName, undefined, {
      where: { kind: "Temporary" },
    });
    expect(after.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Idempotent initialize
  // ---------------------------------------------------------------------------

  it("initialize is idempotent — calling twice does not error", async () => {
    if (skipReason) return expect(true).toBe(true); // skip

    // Second initialize on the same collection should not throw
    await expect(
      backend.initialize(collectionName, { distanceMetric: "cosine" })
    ).resolves.not.toThrow();
  });
});
