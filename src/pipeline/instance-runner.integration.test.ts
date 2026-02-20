/**
 * instance-runner.integration.test.ts - Integration tests for the instance sync runner (PRD #26 M4)
 *
 * Tests the full instance sync pipeline end-to-end: discover → delete stale → store → search.
 * Uses mock kubectl (controlled test data) but real Chroma + Voyage AI for storage
 * and search. This validates that the runner correctly wires the pipeline stages
 * together with real data flowing between them.
 *
 * Unlike the capability runner integration test, this one does NOT require
 * ANTHROPIC_API_KEY because instance sync has no LLM inference step.
 *
 * Requires:
 * - VOYAGE_API_KEY environment variable set (for embeddings)
 * - Chroma running at http://localhost:8000 (or CHROMA_URL)
 *
 * These tests are slower (~10-20 seconds) and cost real API credits.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { syncInstances } from "./instance-runner";
import {
  ChromaBackend,
  VoyageEmbedding,
  INSTANCES_COLLECTION,
} from "../vectorstore";
import type { VectorStore } from "../vectorstore";

// ---------------------------------------------------------------------------
// Skip check
// ---------------------------------------------------------------------------

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
// Mock kubectl — returns a demo cluster with realistic resource data
// ---------------------------------------------------------------------------

/**
 * Canned output for `kubectl api-resources -o wide`.
 * Three resource types: Deployments, Services, and StatefulSets.
 */
const API_RESOURCES_OUTPUT = [
  "NAME            SHORTNAMES   APIVERSION   NAMESPACED   KIND           VERBS                                                        CATEGORIES",
  "deployments     deploy       apps/v1      true         Deployment     create,delete,deletecollection,get,list,patch,update,watch   all",
  "services        svc          v1           true         Service        create,delete,deletecollection,get,list,patch,update,watch   all",
  "statefulsets    sts          apps/v1      true         StatefulSet    create,delete,deletecollection,get,list,patch,update,watch   all",
].join("\n");

/**
 * Canned kubectl get output for Deployments.
 * Two deployments: nginx (default) and api-gateway (production).
 */
const DEPLOYMENTS_OUTPUT = JSON.stringify({
  apiVersion: "v1",
  kind: "List",
  items: [
    {
      metadata: {
        name: "nginx",
        namespace: "default",
        labels: { app: "nginx", tier: "frontend" },
        annotations: {
          description: "Web server for handling HTTP traffic",
          "kubectl.kubernetes.io/last-applied-configuration": "...",
        },
        creationTimestamp: "2026-01-15T10:00:00Z",
      },
    },
    {
      metadata: {
        name: "api-gateway",
        namespace: "production",
        labels: { app: "api-gateway", tier: "backend" },
        annotations: {
          description: "API gateway service handling request routing",
        },
        creationTimestamp: "2026-01-15T10:01:00Z",
      },
    },
  ],
});

/**
 * Canned kubectl get output for Services.
 * One service: nginx-svc in default namespace.
 */
const SERVICES_OUTPUT = JSON.stringify({
  apiVersion: "v1",
  kind: "List",
  items: [
    {
      metadata: {
        name: "nginx-svc",
        namespace: "default",
        labels: { app: "nginx" },
        annotations: {},
        creationTimestamp: "2026-01-15T10:02:00Z",
      },
    },
  ],
});

/**
 * Canned kubectl get output for StatefulSets.
 * One statefulset: postgres-primary in production namespace.
 */
const STATEFULSETS_OUTPUT = JSON.stringify({
  apiVersion: "v1",
  kind: "List",
  items: [
    {
      metadata: {
        name: "postgres-primary",
        namespace: "production",
        labels: { app: "postgresql", role: "primary" },
        annotations: {
          description: "Primary PostgreSQL database instance",
        },
        creationTimestamp: "2026-01-15T10:03:00Z",
      },
    },
  ],
});

/**
 * Mock kubectl that returns canned responses based on the command arguments.
 * Matches the `(args: string[]) => { output: string; isError: boolean }` signature
 * expected by InstanceDiscoveryOptions.kubectl.
 */
function mockKubectl(args: string[]): { output: string; isError: boolean } {
  const command = args.join(" ");

  if (command.includes("api-resources")) {
    return { output: API_RESOURCES_OUTPUT, isError: false };
  }

  // kubectl get <type> -A -o json
  if (command.includes("get deployments")) {
    return { output: DEPLOYMENTS_OUTPUT, isError: false };
  }
  if (command.includes("get services")) {
    return { output: SERVICES_OUTPUT, isError: false };
  }
  if (command.includes("get statefulsets")) {
    return { output: STATEFULSETS_OUTPUT, isError: false };
  }

  return { output: `unknown command: ${command}`, isError: true };
}

/**
 * Mock kubectl for the "after deletion" scenario — same as above but without
 * the postgres StatefulSet (simulates it being deleted from the cluster).
 */
function mockKubectlAfterDeletion(
  args: string[]
): { output: string; isError: boolean } {
  const command = args.join(" ");

  if (command.includes("api-resources")) {
    return { output: API_RESOURCES_OUTPUT, isError: false };
  }
  if (command.includes("get deployments")) {
    return { output: DEPLOYMENTS_OUTPUT, isError: false };
  }
  if (command.includes("get services")) {
    return { output: SERVICES_OUTPUT, isError: false };
  }
  if (command.includes("get statefulsets")) {
    // Empty list — postgres was deleted from the cluster
    return {
      output: JSON.stringify({ apiVersion: "v1", kind: "List", items: [] }),
      isError: false,
    };
  }

  return { output: `unknown command: ${command}`, isError: true };
}

// ---------------------------------------------------------------------------
// Expected instance IDs for assertions
// ---------------------------------------------------------------------------

const NGINX_DEPLOYMENT_ID = "default/apps/v1/Deployment/nginx";
const API_GATEWAY_ID = "production/apps/v1/Deployment/api-gateway";
const NGINX_SERVICE_ID = "default/v1/Service/nginx-svc";
const POSTGRES_ID = "production/apps/v1/StatefulSet/postgres-primary";

const ALL_INSTANCE_IDS = [
  NGINX_DEPLOYMENT_ID,
  API_GATEWAY_ID,
  NGINX_SERVICE_ID,
  POSTGRES_ID,
];

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe.skipIf(!!skipReason)("syncInstances (integration)", () => {
  let vectorStore: VectorStore;

  beforeAll(async () => {
    const embedder = new VoyageEmbedding();
    vectorStore = new ChromaBackend(embedder);
  });

  afterAll(async () => {
    // Clean up all instance documents we may have created
    if (vectorStore) {
      try {
        await vectorStore.delete(INSTANCES_COLLECTION, ALL_INSTANCE_IDS);
      } catch {
        // Best-effort cleanup
      }
    }
  });

  it("runs the full pipeline: discover → store → search", async () => {
    const progressMessages: string[] = [];

    const result = await syncInstances({
      vectorStore,
      discoveryOptions: { kubectl: mockKubectl },
      onProgress: (msg) => {
        progressMessages.push(msg);
        console.log(`  [sync] ${msg}`); // eslint-disable-line no-console
      },
    });

    // Verify SyncInstancesResult counts
    expect(result.discovered).toBe(4);
    expect(result.stored).toBe(4);

    // Verify progress was reported throughout
    expect(progressMessages.length).toBeGreaterThan(3);
    expect(progressMessages.some((m) => m.includes("Sync complete"))).toBe(
      true
    );

    // Verify semantic search works — "nginx" should find the nginx instances
    const nginxResults = await vectorStore.search(
      INSTANCES_COLLECTION,
      "nginx",
      { nResults: 5 }
    );
    expect(nginxResults.length).toBeGreaterThan(0);

    const nginxIds = nginxResults
      .filter((r) => (r.metadata.name as string).includes("nginx"))
      .map((r) => r.id);
    expect(nginxIds).toContain(NGINX_DEPLOYMENT_ID);
    expect(nginxIds).toContain(NGINX_SERVICE_ID);

    // Verify metadata filtering — find all Deployments
    const deploymentResults = await vectorStore.search(
      INSTANCES_COLLECTION,
      "resource",
      { nResults: 10, where: { kind: "Deployment" } }
    );
    expect(deploymentResults.length).toBe(2);
    const deploymentIds = deploymentResults.map((r) => r.id);
    expect(deploymentIds).toContain(NGINX_DEPLOYMENT_ID);
    expect(deploymentIds).toContain(API_GATEWAY_ID);

    // Verify "database" search finds postgres
    const dbResults = await vectorStore.search(
      INSTANCES_COLLECTION,
      "database",
      { nResults: 5 }
    );
    const postgresResult = dbResults.find((r) => r.id === POSTGRES_ID);
    expect(postgresResult).toBeDefined();
  }, 60_000);

  it("supports dry-run mode (discover without storing)", async () => {
    const progressMessages: string[] = [];

    const result = await syncInstances({
      vectorStore,
      discoveryOptions: { kubectl: mockKubectl },
      dryRun: true,
      onProgress: (msg) => progressMessages.push(msg),
    });

    // Discovery still runs
    expect(result.discovered).toBe(4);
    // But nothing was stored or deleted
    expect(result.stored).toBe(0);
    expect(result.deleted).toBe(0);

    // Progress should mention dry run
    const dryRunMessage = progressMessages.find((m) =>
      m.toLowerCase().includes("dry run")
    );
    expect(dryRunMessage).toBeDefined();
  }, 30_000);

  it("cleans up stale instances when resources are deleted from the cluster", async () => {
    // Step 1: Sync with all 4 instances (if not already stored from the first test)
    await syncInstances({
      vectorStore,
      discoveryOptions: { kubectl: mockKubectl },
      onProgress: () => {},
    });

    // Verify postgres exists in the DB
    const beforeResults = await vectorStore.search(
      INSTANCES_COLLECTION,
      "postgresql database",
      { nResults: 5, where: { kind: "StatefulSet" } }
    );
    const postgresBefore = beforeResults.find((r) => r.id === POSTGRES_ID);
    expect(postgresBefore).toBeDefined();

    // Step 2: Re-sync with the "after deletion" mock where postgres is gone
    const progressMessages: string[] = [];
    const result = await syncInstances({
      vectorStore,
      discoveryOptions: { kubectl: mockKubectlAfterDeletion },
      onProgress: (msg) => {
        progressMessages.push(msg);
        console.log(`  [stale-cleanup] ${msg}`); // eslint-disable-line no-console
      },
    });

    // Should discover only 3 instances (postgres was deleted from cluster)
    expect(result.discovered).toBe(3);
    expect(result.stored).toBe(3);
    // At least one stale instance should have been deleted (postgres).
    // The exact count may be higher if other integration tests wrote to
    // the shared INSTANCES_COLLECTION during parallel execution.
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    // Verify progress mentioned stale cleanup
    expect(progressMessages.some((m) => m.includes("stale"))).toBe(true);

    // Verify postgres is no longer searchable
    const afterResults = await vectorStore.keywordSearch(
      INSTANCES_COLLECTION,
      "postgres-primary",
      { nResults: 10 }
    );
    const postgresAfter = afterResults.find((r) => r.id === POSTGRES_ID);
    expect(postgresAfter).toBeUndefined();

    // Verify the remaining 3 instances are still searchable
    const remainingResults = await vectorStore.keywordSearch(
      INSTANCES_COLLECTION,
      undefined,
      { nResults: 10 }
    );
    const remainingIds = remainingResults.map((r) => r.id);
    expect(remainingIds).toContain(NGINX_DEPLOYMENT_ID);
    expect(remainingIds).toContain(API_GATEWAY_ID);
    expect(remainingIds).toContain(NGINX_SERVICE_ID);
  }, 60_000);
});
