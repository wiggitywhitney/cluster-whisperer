// ABOUTME: Integration tests for backend factory — verifies both backends produce equivalent results
// ABOUTME: Tests that pipeline populates both Chroma and Qdrant with identical data and search behavior

/**
 * backend-factory.integration.test.ts - Cross-backend equivalence tests
 *
 * Verifies PRD #48 M6 requirements:
 * - Pipeline populates both backends with identical data
 * - Agent produces equivalent search results from both backends
 *
 * Requires:
 * - Chroma running at http://localhost:8000 (or CHROMA_URL)
 * - Qdrant running at http://localhost:6333 (or QDRANT_URL)
 * - VOYAGE_API_KEY environment variable set
 *
 * These tests are slower (~10-15 seconds) and cost real API credits.
 * Each run creates unique test collections and cleans up after.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createVectorStore } from "./backend-factory";
import { VoyageEmbedding } from "./embeddings";
import type { VectorStore, VectorDocument, SearchResult } from "./types";

// ---------------------------------------------------------------------------
// Skip check — needs BOTH backends available
// ---------------------------------------------------------------------------

/**
 * Check if all integration test dependencies are available.
 * Needs Chroma, Qdrant, and Voyage AI API key.
 */
async function shouldSkip(): Promise<string | false> {
  if (!process.env.VOYAGE_API_KEY) {
    return "VOYAGE_API_KEY not set";
  }

  const chromaUrl = process.env.CHROMA_URL ?? "http://localhost:8000";
  try {
    const response = await fetch(`${chromaUrl}/api/v2/heartbeat`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return `Chroma not healthy at ${chromaUrl} (status ${response.status})`;
    }
  } catch {
    return `Chroma not reachable at ${chromaUrl}`;
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
// Test data — same documents stored in both backends
// ---------------------------------------------------------------------------

/**
 * Test documents representing Kubernetes resource capabilities.
 * Chosen to have distinct semantic meanings for search equivalence verification.
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

describe("Backend factory cross-backend equivalence", () => {
  let skipReason: string | false;
  let chromaBackend: VectorStore;
  let qdrantBackend: VectorStore;
  const testId = Date.now();
  const chromaCollection = `test-factory-chroma-${testId}`;
  const qdrantCollection = `test-factory-qdrant-${testId}`;

  beforeAll(async () => {
    skipReason = await shouldSkip();
    if (skipReason) return;

    // Create both backends through the factory (same embedder instance)
    const embedder = new VoyageEmbedding();
    chromaBackend = createVectorStore(embedder, "chroma");
    qdrantBackend = createVectorStore(embedder, "qdrant");

    // Initialize and populate both backends with identical data
    await chromaBackend.initialize(chromaCollection, {
      distanceMetric: "cosine",
    });
    await qdrantBackend.initialize(qdrantCollection, {
      distanceMetric: "cosine",
    });

    await chromaBackend.store(chromaCollection, TEST_DOCUMENTS);
    await qdrantBackend.store(qdrantCollection, TEST_DOCUMENTS);

    // Brief pause for indexing
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }, 60000);

  afterAll(async () => {
    if (skipReason) return;

    // Clean up test documents from both backends
    const ids = TEST_DOCUMENTS.map((d) => d.id);
    try {
      await chromaBackend.delete(chromaCollection, ids);
    } catch {
      // Best-effort cleanup
    }
    try {
      await qdrantBackend.delete(qdrantCollection, ids);
    } catch {
      // Best-effort cleanup
    }
  });

  // ---------------------------------------------------------------------------
  // Semantic search equivalence
  // ---------------------------------------------------------------------------

  it("both backends return the same top result for 'managed database'", async () => {
    if (skipReason) return expect(true).toBe(true);

    const chromaResults = await chromaBackend.search(
      chromaCollection,
      "managed database",
      { nResults: 2 }
    );
    const qdrantResults = await qdrantBackend.search(
      qdrantCollection,
      "managed database",
      { nResults: 2 }
    );

    expect(chromaResults.length).toBeGreaterThan(0);
    expect(qdrantResults.length).toBeGreaterThan(0);

    // Both should rank SQLInstance first for "managed database"
    expect(chromaResults[0].id).toBe(
      "sql.cnrm.cloud.google.com/v1beta1/SQLInstance"
    );
    expect(qdrantResults[0].id).toBe(
      "sql.cnrm.cloud.google.com/v1beta1/SQLInstance"
    );
  });

  it("both backends return the same top result for 'network traffic routing'", async () => {
    if (skipReason) return expect(true).toBe(true);

    const chromaResults = await chromaBackend.search(
      chromaCollection,
      "network load balancer traffic routing",
      { nResults: 2 }
    );
    const qdrantResults = await qdrantBackend.search(
      qdrantCollection,
      "network load balancer traffic routing",
      { nResults: 2 }
    );

    expect(chromaResults.length).toBeGreaterThan(0);
    expect(qdrantResults.length).toBeGreaterThan(0);

    // Both should rank Service first for networking queries
    expect(chromaResults[0].id).toBe("v1/Service");
    expect(qdrantResults[0].id).toBe("v1/Service");
  });

  it("both backends return identical result sets for broad queries", async () => {
    if (skipReason) return expect(true).toBe(true);

    const chromaResults = await chromaBackend.search(
      chromaCollection,
      "kubernetes resource management",
      { nResults: 4 }
    );
    const qdrantResults = await qdrantBackend.search(
      qdrantCollection,
      "kubernetes resource management",
      { nResults: 4 }
    );

    // Both should return all 4 documents
    expect(chromaResults.length).toBe(4);
    expect(qdrantResults.length).toBe(4);

    // Same IDs in the results (order may differ for middle ranks)
    const chromaIds = chromaResults.map((r: SearchResult) => r.id).sort();
    const qdrantIds = qdrantResults.map((r: SearchResult) => r.id).sort();
    expect(chromaIds).toEqual(qdrantIds);
  });

  // ---------------------------------------------------------------------------
  // Metadata filter equivalence
  // ---------------------------------------------------------------------------

  it("both backends return the same results for metadata-only filter", async () => {
    if (skipReason) return expect(true).toBe(true);

    const chromaResults = await chromaBackend.keywordSearch(
      chromaCollection,
      undefined,
      { where: { kind: "Deployment" } }
    );
    const qdrantResults = await qdrantBackend.keywordSearch(
      qdrantCollection,
      undefined,
      { where: { kind: "Deployment" } }
    );

    expect(chromaResults.length).toBe(1);
    expect(qdrantResults.length).toBe(1);
    expect(chromaResults[0].id).toBe("apps/v1/Deployment");
    expect(qdrantResults[0].id).toBe("apps/v1/Deployment");
  });

  it("both backends filter by multiple metadata fields identically", async () => {
    if (skipReason) return expect(true).toBe(true);

    const chromaResults = await chromaBackend.keywordSearch(
      chromaCollection,
      undefined,
      { where: { kind: "CronJob", apiGroup: "batch" } }
    );
    const qdrantResults = await qdrantBackend.keywordSearch(
      qdrantCollection,
      undefined,
      { where: { kind: "CronJob", apiGroup: "batch" } }
    );

    expect(chromaResults.length).toBe(1);
    expect(qdrantResults.length).toBe(1);
    expect(chromaResults[0].id).toBe("batch/v1/CronJob");
    expect(qdrantResults[0].id).toBe("batch/v1/CronJob");
  });

  // ---------------------------------------------------------------------------
  // Semantic search with filter equivalence
  // ---------------------------------------------------------------------------

  it("both backends apply metadata filters to semantic search identically", async () => {
    if (skipReason) return expect(true).toBe(true);

    const chromaResults = await chromaBackend.search(
      chromaCollection,
      "database backup",
      { nResults: 5, where: { complexity: "basic" } }
    );
    const qdrantResults = await qdrantBackend.search(
      qdrantCollection,
      "database backup",
      { nResults: 5, where: { complexity: "basic" } }
    );

    // Both should exclude SQLInstance (advanced complexity)
    const chromaIds = chromaResults.map((r: SearchResult) => r.id);
    const qdrantIds = qdrantResults.map((r: SearchResult) => r.id);

    expect(chromaIds).not.toContain(
      "sql.cnrm.cloud.google.com/v1beta1/SQLInstance"
    );
    expect(qdrantIds).not.toContain(
      "sql.cnrm.cloud.google.com/v1beta1/SQLInstance"
    );

    // Same filtered result set
    expect(chromaIds.sort()).toEqual(qdrantIds.sort());
  });

  // ---------------------------------------------------------------------------
  // Factory routing verification
  // ---------------------------------------------------------------------------

  it("createVectorStore routes to distinct backend implementations", async () => {
    if (skipReason) return expect(true).toBe(true);

    // Verify the backends are distinct instances by checking constructor names
    expect(chromaBackend.constructor.name).toBe("ChromaBackend");
    expect(qdrantBackend.constructor.name).toBe("QdrantBackend");
  });
});
