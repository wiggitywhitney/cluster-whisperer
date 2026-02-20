/**
 * semantic-bridge.integration.test.ts - Tests the "semantic bridge" pattern (PRD #26 M4)
 *
 * Validates that capabilities (PRD #25) and instances (PRD #26) work together
 * to answer questions like "what databases are running?":
 *
 * 1. Search capabilities collection for "database" → finds relevant resource types
 * 2. Extract kinds from capability results (e.g., StatefulSet, SQL)
 * 3. Filter instances collection by those kinds → finds actual running instances
 *
 * Uses hand-crafted fixtures for both collections (no LLM calls needed).
 * Requires Chroma + VOYAGE_API_KEY for real embedding and search.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { capabilityToDocument } from "./storage";
import { instanceToDocument } from "./instance-storage";
import type { ResourceCapability } from "./types";
import type { ResourceInstance } from "./types";
import {
  ChromaBackend,
  VoyageEmbedding,
  type VectorStore,
} from "../vectorstore";

// ---------------------------------------------------------------------------
// Skip check
// ---------------------------------------------------------------------------

/**
 * Check if integration test dependencies are available.
 * Needs a running Chroma server and a Voyage AI API key.
 * No ANTHROPIC_API_KEY needed — we use hand-crafted fixtures, not LLM inference.
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

  return false;
}

const skipReason = await shouldSkip();

// ---------------------------------------------------------------------------
// Capability fixtures — resource *types* with LLM-inferred descriptions
// ---------------------------------------------------------------------------

/**
 * StatefulSet capability — should match "database", "stateful" queries.
 * In a real cluster, the LLM would infer this from kubectl explain output.
 */
const STATEFULSET_CAPABILITY: ResourceCapability = {
  resourceName: "statefulsets.apps",
  apiVersion: "apps/v1",
  group: "apps",
  kind: "StatefulSet",
  capabilities: [
    "stateful",
    "database",
    "persistent-storage",
    "ordered-deployment",
  ],
  providers: [],
  complexity: "medium",
  description:
    "Manages stateful applications that require stable network identities and persistent storage. Commonly used for databases, message queues, and other data-intensive workloads.",
  useCase:
    "Deploy databases like PostgreSQL or MySQL that need persistent volumes and stable pod hostnames.",
  confidence: 0.95,
};

/**
 * Deployment capability — should match "web server", "stateless" queries.
 */
const DEPLOYMENT_CAPABILITY: ResourceCapability = {
  resourceName: "deployments.apps",
  apiVersion: "apps/v1",
  group: "apps",
  kind: "Deployment",
  capabilities: [
    "stateless",
    "rolling-update",
    "web-server",
    "scaling",
    "replica-management",
  ],
  providers: [],
  complexity: "low",
  description:
    "Manages stateless application deployments with rolling updates and scaling. The most common way to run web servers, APIs, and microservices on Kubernetes.",
  useCase:
    "Deploy and manage stateless web applications, APIs, and microservices with automatic rollout and rollback.",
  confidence: 0.98,
};

/**
 * SQL CRD capability — should match "database", "managed database" queries.
 * Represents a Crossplane composite resource for cloud databases.
 */
const SQL_CAPABILITY: ResourceCapability = {
  resourceName: "sqls.devopstoolkit.live",
  apiVersion: "devopstoolkit.live/v1beta1",
  group: "devopstoolkit.live",
  kind: "SQL",
  capabilities: [
    "database",
    "managed-database",
    "postgresql",
    "mysql",
    "cloud-database",
  ],
  providers: ["aws", "gcp", "azure"],
  complexity: "high",
  description:
    "Composite resource claim for provisioning managed SQL databases across cloud providers. Supports PostgreSQL and MySQL engines with configurable storage and backups.",
  useCase:
    "Request a managed database from any supported cloud provider using a single, provider-agnostic API.",
  confidence: 0.92,
};

const ALL_CAPABILITIES = [
  STATEFULSET_CAPABILITY,
  DEPLOYMENT_CAPABILITY,
  SQL_CAPABILITY,
];

// ---------------------------------------------------------------------------
// Instance fixtures — running resource *instances* in the cluster
// ---------------------------------------------------------------------------

/**
 * A PostgreSQL StatefulSet running in production.
 * Should be found when the bridge resolves "database" → StatefulSet kind.
 */
const POSTGRES_INSTANCE: ResourceInstance = {
  id: "production/apps/v1/StatefulSet/postgres-primary",
  namespace: "production",
  name: "postgres-primary",
  kind: "StatefulSet",
  apiVersion: "apps/v1",
  apiGroup: "apps",
  labels: { app: "postgresql", role: "primary" },
  annotations: { description: "Primary PostgreSQL database instance" },
  createdAt: "2026-01-15T10:00:00Z",
};

/**
 * A Redis StatefulSet in production — also a StatefulSet, but a cache not a database.
 * Tests that the bridge returns all StatefulSets, not just databases.
 */
const REDIS_STATEFULSET_INSTANCE: ResourceInstance = {
  id: "production/apps/v1/StatefulSet/redis-cluster",
  namespace: "production",
  name: "redis-cluster",
  kind: "StatefulSet",
  apiVersion: "apps/v1",
  apiGroup: "apps",
  labels: { app: "redis", component: "cache" },
  annotations: { description: "Redis cluster for caching" },
  createdAt: "2026-01-15T10:01:00Z",
};

/**
 * An nginx Deployment — should NOT be found by a "database" bridge query.
 */
const NGINX_INSTANCE: ResourceInstance = {
  id: "default/apps/v1/Deployment/nginx",
  namespace: "default",
  name: "nginx",
  kind: "Deployment",
  apiVersion: "apps/v1",
  apiGroup: "apps",
  labels: { app: "nginx", tier: "frontend" },
  annotations: { description: "Web server for handling HTTP traffic" },
  createdAt: "2026-01-15T10:02:00Z",
};

/**
 * An API gateway Deployment in production.
 * Should be found when the bridge resolves "web server" → Deployment kind.
 */
const API_GATEWAY_INSTANCE: ResourceInstance = {
  id: "production/apps/v1/Deployment/api-gateway",
  namespace: "production",
  name: "api-gateway",
  kind: "Deployment",
  apiVersion: "apps/v1",
  apiGroup: "apps",
  labels: { app: "api-gateway", tier: "backend" },
  annotations: { description: "API gateway service handling request routing" },
  createdAt: "2026-01-15T10:03:00Z",
};

/**
 * A Crossplane SQL instance — should be found by "database" bridge via SQL kind.
 */
const SQL_INSTANCE: ResourceInstance = {
  id: "production/devopstoolkit.live/v1beta1/SQL/my-app-db",
  namespace: "production",
  name: "my-app-db",
  kind: "SQL",
  apiVersion: "devopstoolkit.live/v1beta1",
  apiGroup: "devopstoolkit.live",
  labels: { app: "my-app", "database-engine": "postgresql" },
  annotations: { description: "Managed PostgreSQL database for my-app" },
  createdAt: "2026-01-15T10:04:00Z",
};

const ALL_INSTANCES = [
  POSTGRES_INSTANCE,
  REDIS_STATEFULSET_INSTANCE,
  NGINX_INSTANCE,
  API_GATEWAY_INSTANCE,
  SQL_INSTANCE,
];

// ---------------------------------------------------------------------------
// Test collections — unique per run to avoid collisions
// ---------------------------------------------------------------------------

const TEST_CAPABILITIES = `test-bridge-capabilities-${Date.now()}`;
const TEST_INSTANCES = `test-bridge-instances-${Date.now()}`;

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe.skipIf(!!skipReason)("semantic bridge (integration)", () => {
  let vectorStore: VectorStore;

  beforeAll(async () => {
    const embedder = new VoyageEmbedding();
    vectorStore = new ChromaBackend(embedder);

    // Initialize both collections
    await vectorStore.initialize(TEST_CAPABILITIES, {
      distanceMetric: "cosine",
    });
    await vectorStore.initialize(TEST_INSTANCES, {
      distanceMetric: "cosine",
    });

    // Store capabilities and instances
    const capDocs = ALL_CAPABILITIES.map(capabilityToDocument);
    await vectorStore.store(TEST_CAPABILITIES, capDocs);

    const instDocs = ALL_INSTANCES.map(instanceToDocument);
    await vectorStore.store(TEST_INSTANCES, instDocs);
  }, 30_000);

  afterAll(async () => {
    // Clean up both collections
    try {
      await vectorStore.delete(
        TEST_CAPABILITIES,
        ALL_CAPABILITIES.map((c) => c.resourceName)
      );
    } catch {
      // Best-effort cleanup
    }
    try {
      await vectorStore.delete(
        TEST_INSTANCES,
        ALL_INSTANCES.map((i) => i.id)
      );
    } catch {
      // Best-effort cleanup
    }
  });

  // -------------------------------------------------------------------------
  // Core semantic bridge tests
  // -------------------------------------------------------------------------

  it("bridges 'database' query: capabilities → instance kinds → running instances", async () => {
    // Step 1: Search capabilities for "database"
    // Limit to top 2 results — in a real cluster with 150+ types, the agent
    // would focus on the most relevant matches, not use every result.
    const capResults = await vectorStore.search(
      TEST_CAPABILITIES,
      "database",
      { nResults: 2 }
    );

    expect(capResults.length).toBe(2);

    // StatefulSet and SQL should be the top 2 matches for "database"
    const matchedKinds = capResults.map((r) => r.metadata.kind as string);
    expect(matchedKinds).toContain("StatefulSet");
    expect(matchedKinds).toContain("SQL");

    // Step 2: Use those kinds to filter instances
    // Build a $or filter for all matched kinds
    const kindFilter = {
      $or: matchedKinds.map((kind) => ({ kind: { $eq: kind } })),
    };

    const instanceResults = await vectorStore.search(
      TEST_INSTANCES,
      "database",
      { nResults: 10, where: kindFilter }
    );

    // Step 3: Verify results — should find StatefulSets and SQL instances
    expect(instanceResults.length).toBeGreaterThan(0);

    const instanceIds = instanceResults.map((r) => r.id);

    // PostgreSQL StatefulSet should be found
    expect(instanceIds).toContain(
      "production/apps/v1/StatefulSet/postgres-primary"
    );

    // SQL CRD instance should be found
    expect(instanceIds).toContain(
      "production/devopstoolkit.live/v1beta1/SQL/my-app-db"
    );

    // Nginx Deployment should NOT be in the results (Deployment kind wasn't
    // in the top 2 capability matches for "database")
    expect(instanceIds).not.toContain("default/apps/v1/Deployment/nginx");
  }, 30_000);

  it("bridges 'web server' query: capabilities → Deployment kind → running Deployments", async () => {
    // Step 1: Search capabilities for "web server"
    const capResults = await vectorStore.search(
      TEST_CAPABILITIES,
      "web server",
      { nResults: 5 }
    );

    expect(capResults.length).toBeGreaterThan(0);

    // Deployment should be the top match for "web server"
    const topKind = capResults[0].metadata.kind;
    expect(topKind).toBe("Deployment");

    // Step 2: Filter instances by Deployment kind
    const instanceResults = await vectorStore.search(
      TEST_INSTANCES,
      "web server",
      { nResults: 10, where: { kind: "Deployment" } }
    );

    // Step 3: Verify — should find Deployments but not StatefulSets or SQL
    expect(instanceResults.length).toBeGreaterThan(0);

    const instanceKinds = instanceResults.map(
      (r) => r.metadata.kind as string
    );
    expect(instanceKinds.every((k) => k === "Deployment")).toBe(true);

    const instanceIds = instanceResults.map((r) => r.id);
    expect(instanceIds).toContain("default/apps/v1/Deployment/nginx");
    expect(instanceIds).toContain(
      "production/apps/v1/Deployment/api-gateway"
    );

    // StatefulSets and SQL should not appear
    expect(instanceIds).not.toContain(
      "production/apps/v1/StatefulSet/postgres-primary"
    );
  }, 30_000);

  // -------------------------------------------------------------------------
  // Bridge with namespace scoping
  // -------------------------------------------------------------------------

  it("bridges with namespace filter: 'database in production'", async () => {
    // Step 1: Find database-related kinds via capabilities
    const capResults = await vectorStore.search(
      TEST_CAPABILITIES,
      "database",
      { nResults: 5 }
    );

    const matchedKinds = capResults.map((r) => r.metadata.kind as string);
    expect(matchedKinds).toContain("StatefulSet");

    // Step 2: Filter instances by kind AND namespace
    // Combine kind filter from capabilities with namespace filter from user query
    const kindConditions = matchedKinds.map((kind) => ({
      kind: { $eq: kind },
    }));

    const instanceResults = await vectorStore.search(
      TEST_INSTANCES,
      "database",
      {
        nResults: 10,
        where: {
          $and: [
            { $or: kindConditions },
            { namespace: { $eq: "production" } },
          ],
        },
      }
    );

    // Step 3: All results should be in the production namespace
    expect(instanceResults.length).toBeGreaterThan(0);
    const namespaces = instanceResults.map(
      (r) => r.metadata.namespace as string
    );
    expect(namespaces.every((n) => n === "production")).toBe(true);

    // Postgres and SQL should both be found (both in production)
    const instanceIds = instanceResults.map((r) => r.id);
    expect(instanceIds).toContain(
      "production/apps/v1/StatefulSet/postgres-primary"
    );
    expect(instanceIds).toContain(
      "production/devopstoolkit.live/v1beta1/SQL/my-app-db"
    );
  }, 30_000);

  // -------------------------------------------------------------------------
  // Direct instance search (no bridge needed)
  // -------------------------------------------------------------------------

  it("finds instances directly when the user names a specific resource", async () => {
    // When a user asks "where is my nginx?", no bridge is needed —
    // search the instances collection directly
    const results = await vectorStore.search(TEST_INSTANCES, "nginx", {
      nResults: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("default/apps/v1/Deployment/nginx");
  }, 15_000);

  it("finds instances by description annotation", async () => {
    // Annotations like "Primary PostgreSQL database instance" are in the
    // embedding text, so semantic search should match them
    const results = await vectorStore.search(
      TEST_INSTANCES,
      "primary database instance",
      { nResults: 5 }
    );

    expect(results.length).toBeGreaterThan(0);

    const postgresResult = results.find(
      (r) => r.id === "production/apps/v1/StatefulSet/postgres-primary"
    );
    expect(postgresResult).toBeDefined();
  }, 15_000);
});
