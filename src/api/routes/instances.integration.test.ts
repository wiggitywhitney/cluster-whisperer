/**
 * instances.integration.test.ts - Contract integration tests for sync endpoint (PRD #35 M5)
 *
 * Tests the full sync endpoint pipeline against real ChromaDB and Voyage AI.
 * POSTs to the endpoint via app.request() and verifies documents are actually
 * stored in (or deleted from) the vector database.
 *
 * These tests mirror the k8s-vectordb-sync controller's contract tests — the
 * controller verifies it sends correct requests; these tests verify the endpoint
 * handles them correctly and produces the expected side effects.
 *
 * Requires:
 * - Chroma running at http://localhost:8000 (or CHROMA_URL)
 * - VOYAGE_API_KEY environment variable set
 *
 * These tests are slower (~10-20 seconds) and cost real API credits.
 * They write to the shared "instances" collection using unique test-prefixed
 * IDs, and clean up in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../server";
import { ChromaBackend, VoyageEmbedding, INSTANCES_COLLECTION } from "../../vectorstore";
import type { VectorStore } from "../../vectorstore";

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
// Test fixtures — unique IDs per run to avoid collisions
// ---------------------------------------------------------------------------

/** Unique prefix for this test run to avoid collisions with concurrent runs */
const TEST_PREFIX = `test-${Date.now()}`;

/** All test document IDs created during this run — tracked for afterAll cleanup */
const allTestIds: string[] = [];

/**
 * Creates a valid resource instance payload with a unique test-prefixed ID.
 * Automatically tracks the ID for cleanup in afterAll.
 */
function makeTestInstance(overrides: Record<string, unknown> = {}) {
  const id =
    (overrides.id as string) ??
    `${TEST_PREFIX}/apps/v1/Deployment/nginx`;
  allTestIds.push(id);
  return {
    id,
    namespace: "default",
    name: "nginx",
    kind: "Deployment",
    apiVersion: "apps/v1",
    apiGroup: "apps",
    labels: { app: "nginx", tier: "frontend" },
    annotations: { description: "Main web server" },
    createdAt: "2026-02-20T10:00:00Z",
    ...overrides,
  };
}

/** Helper to POST JSON to the sync endpoint */
function postSync(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/v1/instances/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe.skipIf(!!skipReason)(
  "sync endpoint contract tests (integration)",
  () => {
    let vectorStore: VectorStore;
    let app: ReturnType<typeof createApp>;

    beforeAll(async () => {
      const embedder = new VoyageEmbedding();
      vectorStore = new ChromaBackend(embedder);

      // Initialize the instances collection (idempotent — safe to repeat)
      await vectorStore.initialize(INSTANCES_COLLECTION, {
        distanceMetric: "cosine",
      });

      // Create the app with the real vector store
      app = createApp({ vectorStore });
    }, 30_000);

    afterAll(async () => {
      // Clean up all test documents — best-effort
      try {
        const uniqueIds = [...new Set(allTestIds)];
        if (uniqueIds.length > 0) {
          await vectorStore.delete(INSTANCES_COLLECTION, uniqueIds);
        }
      } catch {
        // Best-effort cleanup — test documents will be orphaned if this fails
      }
    });

    // -----------------------------------------------------------------------
    // Upserts — POST upserts and verify documents land in ChromaDB
    // -----------------------------------------------------------------------

    describe("upserts", () => {
      it("stores upserted instances in ChromaDB", async () => {
        const instance = makeTestInstance({
          id: `${TEST_PREFIX}/apps/v1/Deployment/upsert-test`,
          name: "upsert-test",
          annotations: { description: "Integration test upsert verification" },
        });

        const res = await postSync(app, { upserts: [instance] });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ status: "ok", upserted: 1, deleted: 0 });

        // Verify the document actually exists in ChromaDB
        const results = await vectorStore.keywordSearch(
          INSTANCES_COLLECTION,
          "upsert-test",
          { nResults: 10 }
        );
        const stored = results.find((r) => r.id === instance.id);
        expect(stored).toBeDefined();
        expect(stored!.metadata.name).toBe("upsert-test");
        expect(stored!.metadata.kind).toBe("Deployment");
        expect(stored!.metadata.namespace).toBe("default");
      }, 30_000);

      it("stores multiple upserted instances", async () => {
        const nginx = makeTestInstance({
          id: `${TEST_PREFIX}/apps/v1/Deployment/multi-upsert-1`,
          name: "multi-upsert-1",
          annotations: { description: "First multi-upsert test instance" },
        });
        const redis = makeTestInstance({
          id: `${TEST_PREFIX}/apps/v1/Deployment/multi-upsert-2`,
          name: "multi-upsert-2",
          labels: { app: "redis" },
          annotations: { description: "Second multi-upsert test instance" },
        });

        const res = await postSync(app, { upserts: [nginx, redis] });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ status: "ok", upserted: 2, deleted: 0 });

        // Verify both documents exist in ChromaDB
        const results = await vectorStore.keywordSearch(
          INSTANCES_COLLECTION,
          "multi-upsert",
          { nResults: 10 }
        );
        const ids = results.map((r) => r.id);
        expect(ids).toContain(nginx.id);
        expect(ids).toContain(redis.id);
      }, 30_000);
    });

    // -----------------------------------------------------------------------
    // Deletes — seed docs via endpoint, POST deletes, verify removal
    // -----------------------------------------------------------------------

    describe("deletes", () => {
      it("removes deleted instances from ChromaDB", async () => {
        // Seed a document via the endpoint
        const instance = makeTestInstance({
          id: `${TEST_PREFIX}/apps/v1/Deployment/delete-test`,
          name: "delete-test",
          annotations: { description: "Will be deleted in integration test" },
        });
        const seedRes = await postSync(app, { upserts: [instance] });
        expect(seedRes.status).toBe(200);

        // Verify it exists before deleting
        const beforeResults = await vectorStore.keywordSearch(
          INSTANCES_COLLECTION,
          "delete-test",
          { nResults: 10 }
        );
        expect(beforeResults.find((r) => r.id === instance.id)).toBeDefined();

        // Delete via the endpoint
        const deleteRes = await postSync(app, {
          deletes: [instance.id],
        });

        expect(deleteRes.status).toBe(200);
        const body = await deleteRes.json();
        expect(body).toEqual({ status: "ok", upserted: 0, deleted: 1 });

        // Verify it's gone from ChromaDB
        const afterResults = await vectorStore.keywordSearch(
          INSTANCES_COLLECTION,
          "delete-test",
          { nResults: 10 }
        );
        expect(afterResults.find((r) => r.id === instance.id)).toBeUndefined();
      }, 30_000);
    });

    // -----------------------------------------------------------------------
    // Mixed — upserts + deletes in same request
    // -----------------------------------------------------------------------

    describe("mixed upserts + deletes", () => {
      it("processes both operations in one request", async () => {
        // Seed a document that will be deleted in the mixed request
        const toDelete = makeTestInstance({
          id: `${TEST_PREFIX}/apps/v1/Deployment/mixed-delete`,
          name: "mixed-delete",
          annotations: { description: "Will be deleted in mixed payload test" },
        });
        const seedRes = await postSync(app, { upserts: [toDelete] });
        expect(seedRes.status).toBe(200);

        // POST a mixed payload: delete the seeded doc, upsert a new one
        const toUpsert = makeTestInstance({
          id: `${TEST_PREFIX}/apps/v1/Deployment/mixed-upsert`,
          name: "mixed-upsert",
          annotations: { description: "Created in mixed payload test" },
        });

        const res = await postSync(app, {
          upserts: [toUpsert],
          deletes: [toDelete.id],
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ status: "ok", upserted: 1, deleted: 1 });

        // Verify: deleted doc is gone
        const deleteCheck = await vectorStore.keywordSearch(
          INSTANCES_COLLECTION,
          "mixed-delete",
          { nResults: 10 }
        );
        expect(
          deleteCheck.find((r) => r.id === toDelete.id)
        ).toBeUndefined();

        // Verify: upserted doc exists
        const upsertCheck = await vectorStore.keywordSearch(
          INSTANCES_COLLECTION,
          "mixed-upsert",
          { nResults: 10 }
        );
        expect(
          upsertCheck.find((r) => r.id === toUpsert.id)
        ).toBeDefined();
      }, 30_000);
    });

    // -----------------------------------------------------------------------
    // Empty payload — endpoint must tolerate even though controller skips
    // -----------------------------------------------------------------------

    describe("empty payloads", () => {
      it("returns 200 for empty object payload", async () => {
        const res = await postSync(app, {});

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ status: "ok", upserted: 0, deleted: 0 });
      }, 15_000);

      it("returns 200 for explicitly empty arrays", async () => {
        const res = await postSync(app, { upserts: [], deletes: [] });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ status: "ok", upserted: 0, deleted: 0 });
      }, 15_000);
    });

    // -----------------------------------------------------------------------
    // Validation — 400 for bad requests (controller won't retry)
    // -----------------------------------------------------------------------

    describe("validation errors (400 — controller does not retry)", () => {
      it("returns 400 for malformed JSON", async () => {
        const res = await app.request("/api/v1/instances/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{broken json",
        });

        expect(res.status).toBe(400);
      }, 15_000);

      it("returns 400 for invalid payload schema", async () => {
        const res = await postSync(app, {
          upserts: [{ notValid: true }],
        });

        expect(res.status).toBe(400);
      }, 15_000);

      it("returns 400 for non-object payload", async () => {
        const res = await postSync(app, "not an object");

        expect(res.status).toBe(400);
      }, 15_000);
    });

    // -----------------------------------------------------------------------
    // Response code contract — matches k8s-vectordb-sync expectations
    // -----------------------------------------------------------------------

    describe("response code contract (mirrors controller expectations)", () => {
      /**
       * Controller expectations from k8s-vectordb-sync PRD #1 M3:
       *
       * | Behavior                    | Expected                  | HTTP Code |
       * |-----------------------------|---------------------------|-----------|
       * | Valid payload accepted       | Controller gets success   | 200       |
       * | Bad request                  | Controller does NOT retry | 4xx       |
       * | Transient failure (DB down)  | Controller retries        | 5xx       |
       * | Empty payload                | Tolerated if sent         | 200       |
       *
       * The 5xx path is tested in unit tests (instances.test.ts) via a mocked
       * vector store that rejects with errors. Integration tests can't reliably
       * trigger real DB failures, so we verify the 200 and 400 paths here.
       */

      it("returns 200 for valid payload (controller success path)", async () => {
        const instance = makeTestInstance({
          id: `${TEST_PREFIX}/apps/v1/Deployment/contract-200`,
          name: "contract-200",
          annotations: { description: "Contract test for 200 response" },
        });

        const res = await postSync(app, { upserts: [instance] });
        expect(res.status).toBe(200);
      }, 30_000);

      it("returns 400 for invalid payload (controller no-retry path)", async () => {
        const res = await postSync(app, {
          upserts: [{ bad: "shape" }],
        });
        expect(res.status).toBe(400);
      }, 15_000);

      it("returns 200 for empty payload (defensive tolerance)", async () => {
        const res = await postSync(app, {});
        expect(res.status).toBe(200);
      }, 15_000);
    });
  }
);
