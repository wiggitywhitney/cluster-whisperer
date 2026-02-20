/**
 * instance-storage.integration.test.ts - Integration tests for instance storage and search (PRD #26 M2)
 *
 * Tests the full storage and search flow against real Chroma and Voyage AI.
 * Stores diverse test instances, then verifies that semantic search,
 * keyword search, and metadata filtering all return the correct results.
 *
 * Requires:
 * - Chroma running at http://localhost:8000 (or CHROMA_URL)
 * - VOYAGE_API_KEY environment variable set
 *
 * These tests are slower (~5-10 seconds) and cost real API credits.
 * They create a unique test collection per run and clean up after.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { instanceToDocument, storeInstances } from "./instance-storage";
import type { ResourceInstance } from "./types";
import { ChromaBackend, VoyageEmbedding, INSTANCES_COLLECTION } from "../vectorstore";
import type { VectorStore } from "../vectorstore";

// ---------------------------------------------------------------------------
// Skip check
// ---------------------------------------------------------------------------

/**
 * Check if integration test dependencies are available.
 * Needs both a running Chroma server and a Voyage AI API key.
 */
async function shouldSkip(): Promise<string | false> {
  if (!process.env.VOYAGE_API_KEY) {
    return "VOYAGE_API_KEY not set";
  }

  // Check if Chroma is reachable
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

  return false;
}

const skipReason = await shouldSkip();

// ---------------------------------------------------------------------------
// Test fixtures — diverse instances for search validation
// ---------------------------------------------------------------------------

/**
 * An nginx Deployment — should match "nginx", "web server" queries.
 */
const NGINX_DEPLOYMENT: ResourceInstance = {
  id: "default/apps/v1/Deployment/nginx",
  namespace: "default",
  name: "nginx",
  kind: "Deployment",
  apiVersion: "apps/v1",
  apiGroup: "apps",
  labels: { app: "nginx", tier: "frontend" },
  annotations: { description: "Web server for handling HTTP traffic" },
  createdAt: "2026-01-15T10:00:00Z",
};

/**
 * An nginx Service — should also match "nginx" queries.
 */
const NGINX_SERVICE: ResourceInstance = {
  id: "default/v1/Service/nginx",
  namespace: "default",
  name: "nginx",
  kind: "Service",
  apiVersion: "v1",
  apiGroup: "",
  labels: { app: "nginx" },
  annotations: {},
  createdAt: "2026-01-15T10:01:00Z",
};

/**
 * A Redis Deployment in production — should match "redis", "cache" queries.
 */
const REDIS_DEPLOYMENT: ResourceInstance = {
  id: "production/apps/v1/Deployment/redis-cache",
  namespace: "production",
  name: "redis-cache",
  kind: "Deployment",
  apiVersion: "apps/v1",
  apiGroup: "apps",
  labels: { app: "redis", component: "cache" },
  annotations: { description: "In-memory data store used as a cache layer" },
  createdAt: "2026-01-15T10:02:00Z",
};

/**
 * A PostgreSQL StatefulSet — should match "database", "postgres" queries.
 */
const POSTGRES_STATEFULSET: ResourceInstance = {
  id: "production/apps/v1/StatefulSet/postgres-primary",
  namespace: "production",
  name: "postgres-primary",
  kind: "StatefulSet",
  apiVersion: "apps/v1",
  apiGroup: "apps",
  labels: { app: "postgresql", role: "primary" },
  annotations: { description: "Primary PostgreSQL database instance" },
  createdAt: "2026-01-15T10:03:00Z",
};

/**
 * A cluster-scoped Namespace — should match namespace queries.
 */
const KUBE_SYSTEM_NAMESPACE: ResourceInstance = {
  id: "_cluster/v1/Namespace/kube-system",
  namespace: "_cluster",
  name: "kube-system",
  kind: "Namespace",
  apiVersion: "v1",
  apiGroup: "",
  labels: { "kubernetes.io/metadata.name": "kube-system" },
  annotations: {},
  createdAt: "2026-01-01T00:00:00Z",
};

const ALL_INSTANCES = [
  NGINX_DEPLOYMENT,
  NGINX_SERVICE,
  REDIS_DEPLOYMENT,
  POSTGRES_STATEFULSET,
  KUBE_SYSTEM_NAMESPACE,
];

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

/**
 * Use a unique collection name per test run to avoid collisions.
 * The collection is cleaned up in afterAll.
 */
const TEST_COLLECTION = `test-instances-${Date.now()}`;

describe.skipIf(!!skipReason)("instance storage and search (integration)", () => {
  let vectorStore: VectorStore;
  let chromaBackend: ChromaBackend;

  beforeAll(async () => {
    const embedder = new VoyageEmbedding();
    chromaBackend = new ChromaBackend(embedder);
    vectorStore = chromaBackend;

    // Initialize collection and store test instances
    await vectorStore.initialize(TEST_COLLECTION, {
      distanceMetric: "cosine",
    });

    const documents = ALL_INSTANCES.map(instanceToDocument);
    await vectorStore.store(TEST_COLLECTION, documents);
  }, 30_000);

  afterAll(async () => {
    // Clean up test collection by deleting all document IDs
    try {
      const ids = ALL_INSTANCES.map((i) => i.id);
      await vectorStore.delete(TEST_COLLECTION, ids);
    } catch {
      // Best-effort cleanup — test collection will be abandoned if this fails
    }
  });

  // -------------------------------------------------------------------------
  // Semantic search — "nginx" finds nginx deployments/pods/services
  // -------------------------------------------------------------------------

  it("finds nginx instances when searching for 'nginx'", async () => {
    const results = await vectorStore.search(TEST_COLLECTION, "nginx", {
      nResults: 5,
    });

    expect(results.length).toBeGreaterThan(0);

    // Both nginx Deployment and nginx Service should appear
    const nginxIds = results
      .filter((r) => r.metadata.name === "nginx")
      .map((r) => r.id);
    expect(nginxIds).toContain("default/apps/v1/Deployment/nginx");
    expect(nginxIds).toContain("default/v1/Service/nginx");
  }, 15_000);

  it("finds database instances when searching for 'database'", async () => {
    const results = await vectorStore.search(TEST_COLLECTION, "database", {
      nResults: 5,
    });

    expect(results.length).toBeGreaterThan(0);

    // PostgreSQL should be near the top for a "database" query
    const postgresResult = results.find(
      (r) => r.id === "production/apps/v1/StatefulSet/postgres-primary"
    );
    expect(postgresResult).toBeDefined();
  }, 15_000);

  it("finds cache instances when searching for 'cache'", async () => {
    const results = await vectorStore.search(TEST_COLLECTION, "cache", {
      nResults: 5,
    });

    expect(results.length).toBeGreaterThan(0);

    // Redis should appear for "cache" queries
    const redisResult = results.find(
      (r) => r.id === "production/apps/v1/Deployment/redis-cache"
    );
    expect(redisResult).toBeDefined();
  }, 15_000);

  // -------------------------------------------------------------------------
  // Metadata filtering — "all Deployments in namespace default"
  // -------------------------------------------------------------------------

  it("filters by kind to find all Deployments", async () => {
    const results = await vectorStore.search(TEST_COLLECTION, "resource", {
      nResults: 10,
      where: { kind: "Deployment" },
    });

    // Should return exactly the nginx and redis Deployments
    expect(results.length).toBe(2);
    const kinds = results.map((r) => r.metadata.kind);
    expect(kinds.every((k) => k === "Deployment")).toBe(true);
  }, 15_000);

  it("filters by namespace to find all resources in default", async () => {
    const results = await vectorStore.search(TEST_COLLECTION, "resource", {
      nResults: 10,
      where: { namespace: "default" },
    });

    // Should return nginx Deployment and nginx Service (both in default)
    expect(results.length).toBe(2);
    const namespaces = results.map((r) => r.metadata.namespace);
    expect(namespaces.every((n) => n === "default")).toBe(true);
  }, 15_000);

  it("combines kind and namespace filters", async () => {
    const results = await vectorStore.search(TEST_COLLECTION, "resource", {
      nResults: 10,
      where: {
        $and: [{ kind: { $eq: "Deployment" } }, { namespace: { $eq: "default" } }],
      },
    });

    // Should return only the nginx Deployment (Deployment + default namespace)
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("default/apps/v1/Deployment/nginx");
  }, 15_000);

  it("filters by apiGroup metadata", async () => {
    const results = await vectorStore.search(TEST_COLLECTION, "resource", {
      nResults: 10,
      where: { apiGroup: "apps" },
    });

    // Should return nginx Deployment, redis Deployment, and postgres StatefulSet
    expect(results.length).toBe(3);
    const apiGroups = results.map((r) => r.metadata.apiGroup);
    expect(apiGroups.every((g) => g === "apps")).toBe(true);
  }, 15_000);

  // -------------------------------------------------------------------------
  // Combined semantic + filter
  // -------------------------------------------------------------------------

  it("combines semantic search with namespace filter", async () => {
    // Search for "database" but only in production namespace
    const results = await vectorStore.search(
      TEST_COLLECTION,
      "database",
      {
        nResults: 10,
        where: { namespace: "production" },
      }
    );

    // Should find postgres in production but not nginx in default
    expect(results.length).toBeGreaterThan(0);
    const namespaces = results.map((r) => r.metadata.namespace);
    expect(namespaces.every((n) => n === "production")).toBe(true);
  }, 15_000);

  // -------------------------------------------------------------------------
  // Keyword search
  // -------------------------------------------------------------------------

  it("finds instances by keyword substring match", async () => {
    const results = await vectorStore.keywordSearch(
      TEST_COLLECTION,
      "redis",
      { nResults: 10 }
    );

    expect(results.length).toBeGreaterThan(0);
    const redisResult = results.find(
      (r) => r.id === "production/apps/v1/Deployment/redis-cache"
    );
    expect(redisResult).toBeDefined();
  }, 15_000);

  // -------------------------------------------------------------------------
  // storeInstances orchestrator
  // -------------------------------------------------------------------------

  it("stores instances and reports progress via orchestrator", async () => {
    const progressMessages: string[] = [];

    // Use a separate collection for orchestrator test
    const orchestratorCollection = `test-instances-orchestrator-${Date.now()}`;

    // Temporarily override INSTANCES_COLLECTION by calling storeInstances
    // directly — it uses the hardcoded collection constant
    await storeInstances(
      [NGINX_DEPLOYMENT, REDIS_DEPLOYMENT],
      vectorStore,
      { onProgress: (msg) => progressMessages.push(msg) }
    );

    // Verify progress was reported
    expect(progressMessages.length).toBeGreaterThan(0);
    expect(progressMessages.some((m) => m.includes("Storing"))).toBe(true);

    // Verify documents were stored by searching the instances collection
    const results = await vectorStore.search(
      INSTANCES_COLLECTION,
      "nginx",
      { nResults: 5 }
    );
    expect(results.length).toBeGreaterThan(0);
    const nginxResult = results.find(
      (r) => r.id === "default/apps/v1/Deployment/nginx"
    );
    expect(nginxResult).toBeDefined();

    // Clean up
    try {
      await vectorStore.delete(INSTANCES_COLLECTION, [
        NGINX_DEPLOYMENT.id,
        REDIS_DEPLOYMENT.id,
      ]);
    } catch {
      // Best-effort cleanup
    }
  }, 30_000);
});
