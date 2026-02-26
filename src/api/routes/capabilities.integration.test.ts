/**
 * capabilities.integration.test.ts - Integration tests for capability scan endpoint (PRD #42 M4)
 *
 * Tests the full scan endpoint pipeline against real ChromaDB and Voyage AI.
 * POSTs to the endpoint via app.request() and verifies capabilities are actually
 * stored in (or deleted from) the vector database.
 *
 * Unlike the instance sync integration tests (which verify synchronously after
 * a 200 response), the capability scan endpoint returns 202 immediately and
 * processes in the background. These tests poll ChromaDB via vi.waitFor() to
 * verify the background pipeline completes.
 *
 * Requires:
 * - Chroma running at http://localhost:8000 (or CHROMA_URL)
 * - ANTHROPIC_API_KEY environment variable set (for LLM inference on upserts)
 * - VOYAGE_API_KEY environment variable set (for embeddings)
 *
 * These tests are slower (~60-120 seconds) and cost real API credits.
 * Upsert tests call Haiku for inference (~3 resources). Delete and contract
 * tests avoid LLM calls by seeding data directly via storeCapabilities().
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "../server";
import {
  ChromaBackend,
  VoyageEmbedding,
  CAPABILITIES_COLLECTION,
} from "../../vectorstore";
import type { VectorStore } from "../../vectorstore";
import { discoverResources } from "../../pipeline/discovery";
import { inferCapabilities } from "../../pipeline/inference";
import { storeCapabilities } from "../../pipeline/storage";
import type { ResourceCapability, DiscoveryOptions } from "../../pipeline/types";

// ---------------------------------------------------------------------------
// Skip check
// ---------------------------------------------------------------------------

/**
 * Check if integration test dependencies are available.
 * Needs a running Chroma server and both API keys (Anthropic for LLM
 * inference, Voyage for embeddings).
 */
async function shouldSkip(): Promise<string | false> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return "ANTHROPIC_API_KEY not set";
  }
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
// Mock kubectl — same canned resources as runner.integration.test.ts
// ---------------------------------------------------------------------------

/**
 * Canned output for `kubectl api-resources -o wide`.
 * Three resources: a CRD (SQL), a core resource (ConfigMap), and a
 * networking resource (Ingress). Reused from runner.integration.test.ts.
 */
const API_RESOURCES_OUTPUT = [
  "NAME            SHORTNAMES   APIVERSION                       NAMESPACED   KIND        VERBS                                                        CATEGORIES",
  "sqls                         devopstoolkit.live/v1beta1       true         SQL         delete,deletecollection,get,list,patch,create,update,watch   ",
  "configmaps      cm           v1                               true         ConfigMap   create,delete,deletecollection,get,list,patch,update,watch   all",
  "ingresses       ing          networking.k8s.io/v1             true         Ingress     create,delete,deletecollection,get,list,patch,update,watch   ",
].join("\n");

/**
 * Canned output for `kubectl get crd -o json`.
 * Only the SQL resource is a CRD.
 */
const CRD_LIST_OUTPUT = JSON.stringify({
  items: [{ metadata: { name: "sqls.devopstoolkit.live" } }],
});

/**
 * Canned kubectl explain output for each resource.
 * Abbreviated schemas — enough for Haiku to infer capabilities.
 */
const EXPLAIN_OUTPUTS: Record<string, string> = {
  "sqls.devopstoolkit.live": [
    "KIND:     SQL",
    "VERSION:  devopstoolkit.live/v1beta1",
    "",
    "DESCRIPTION:",
    "  SQL is a composite resource claim for provisioning managed SQL databases.",
    "  Supports PostgreSQL and MySQL engines across AWS, GCP, and Azure.",
    "",
    "FIELDS:",
    "  spec\t<Object>",
    "    engine\t<string> -required- (postgresql | mysql)",
    "    size\t<string> (small | medium | large)",
    "    version\t<string>",
    "  status\t<Object>",
    "    connectionDetails\t<Object>",
    "      host\t<string>",
    "      port\t<integer>",
  ].join("\n"),
  configmaps: [
    "KIND:     ConfigMap",
    "VERSION:  v1",
    "",
    "DESCRIPTION:",
    "  ConfigMap holds configuration data for pods to consume.",
    "",
    "FIELDS:",
    "  data\t<map[string]string>",
    "  binaryData\t<map[string]string>",
    "  immutable\t<boolean>",
  ].join("\n"),
  "ingresses.networking.k8s.io": [
    "KIND:     Ingress",
    "VERSION:  networking.k8s.io/v1",
    "",
    "DESCRIPTION:",
    "  Ingress is a collection of rules that allow inbound connections to reach services.",
    "",
    "FIELDS:",
    "  spec\t<Object>",
    "    rules\t<[]Object>",
    "      host\t<string>",
    "      http\t<Object>",
    "        paths\t<[]Object>",
    "          path\t<string>",
    "          pathType\t<string>",
    "          backend\t<Object>",
    "    tls\t<[]Object>",
    "      hosts\t<[]string>",
    "      secretName\t<string>",
  ].join("\n"),
};

/**
 * Mock kubectl that returns canned responses based on the command arguments.
 * Matches the `(args: string[]) => { output: string; isError: boolean }`
 * signature expected by DiscoveryOptions.kubectl.
 */
function mockKubectl(args: string[]): { output: string; isError: boolean } {
  const command = args.join(" ");

  if (command.includes("api-resources")) {
    return { output: API_RESOURCES_OUTPUT, isError: false };
  }
  if (command.includes("get crd")) {
    return { output: CRD_LIST_OUTPUT, isError: false };
  }
  if (command.includes("explain")) {
    const resourceName = args[1];
    const output = EXPLAIN_OUTPUTS[resourceName];
    if (output) {
      return { output, isError: false };
    }
    return { output: `error: resource "${resourceName}" not found`, isError: true };
  }

  return { output: `unknown command: ${command}`, isError: true };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** All capability IDs created during this test run — tracked for afterAll cleanup */
const allTestIds: string[] = [];

/**
 * Wraps discoverResources with the mock kubectl injected.
 * The endpoint passes DiscoveryOptions through, so we merge the mock
 * kubectl into whatever options the route handler provides.
 */
function mockDiscoverResources(options?: DiscoveryOptions) {
  return discoverResources({ ...options, kubectl: mockKubectl });
}

/**
 * Hardcoded capabilities for seeding the delete and mixed tests.
 * These bypass LLM inference entirely — storeCapabilities() only needs
 * valid ResourceCapability[] objects to embed and store.
 */
function makeSeededCapabilities(
  overrides: Array<Partial<ResourceCapability> & { resourceName: string }>
): ResourceCapability[] {
  return overrides.map((o) => ({
    apiVersion: "test/v1",
    group: "test",
    kind: "TestResource",
    capabilities: ["test-capability"],
    providers: [],
    complexity: "low" as const,
    description: "Seeded for integration test",
    useCase: "Testing delete behavior",
    confidence: 0.9,
    ...o,
  }));
}

/** Helper to POST JSON to the scan endpoint */
function postScan(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/v1/capabilities/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe.skipIf(!!skipReason)(
  "capability scan endpoint (integration)",
  () => {
    let vectorStore: VectorStore;
    let app: ReturnType<typeof createApp>;

    beforeAll(async () => {
      const embedder = new VoyageEmbedding();
      vectorStore = new ChromaBackend(embedder);

      // Initialize the capabilities collection (idempotent)
      await vectorStore.initialize(CAPABILITIES_COLLECTION, {
        distanceMetric: "cosine",
      });

      // Create the app with real pipeline functions and mock kubectl
      app = createApp({
        vectorStore,
        capabilities: {
          vectorStore,
          discoverResources: mockDiscoverResources,
          inferCapabilities,
          storeCapabilities,
        },
      });
    }, 30_000);

    afterAll(async () => {
      // Clean up all test documents — best-effort
      try {
        const uniqueIds = [...new Set(allTestIds)];
        if (uniqueIds.length > 0) {
          await vectorStore.delete(CAPABILITIES_COLLECTION, uniqueIds);
        }
      } catch {
        // Best-effort cleanup — test documents will be orphaned if this fails
      }
    });

    // -----------------------------------------------------------------------
    // Upserts — POST scan payload, wait for background pipeline, verify in DB
    // -----------------------------------------------------------------------

    describe("upserts", () => {
      it("stores inferred capabilities in ChromaDB after async processing", async () => {
        const res = await postScan(app, {
          upserts: [
            "sqls.devopstoolkit.live",
            "configmaps",
            "ingresses.networking.k8s.io",
          ],
        });

        // Endpoint returns 202 immediately — pipeline runs in background
        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body).toEqual({
          status: "accepted",
          upserts: 3,
          deletes: 0,
        });

        // Track IDs for cleanup
        const expectedIds = [
          "sqls.devopstoolkit.live",
          "configmaps",
          "ingresses.networking.k8s.io",
        ];
        allTestIds.push(...expectedIds);

        // Poll ChromaDB until all 3 capabilities are stored.
        // The background pipeline runs discover → infer (Haiku) → store,
        // which takes ~15-30 seconds for 3 resources.
        await vi.waitFor(
          async () => {
            const results = await vectorStore.search(
              CAPABILITIES_COLLECTION,
              "database configuration networking",
              { nResults: 20 }
            );
            const storedIds = results.map((r) => r.id);
            for (const id of expectedIds) {
              expect(storedIds).toContain(id);
            }
          },
          { timeout: 90_000, interval: 2_000 }
        );

        // Verify semantic search works — "database" should find the SQL CRD
        const dbResults = await vectorStore.search(
          CAPABILITIES_COLLECTION,
          "database",
          { nResults: 5 }
        );
        const sqlResult = dbResults.find(
          (r) => r.id === "sqls.devopstoolkit.live"
        );
        expect(sqlResult).toBeDefined();
        expect(sqlResult!.metadata.kind).toBe("SQL");
      }, 120_000);
    });

    // -----------------------------------------------------------------------
    // Deletes — seed capabilities directly, delete via endpoint, verify removal
    // -----------------------------------------------------------------------

    describe("deletes", () => {
      it("removes capabilities from ChromaDB after async processing", async () => {
        // Seed capabilities directly via storeCapabilities() — no LLM needed
        const seeded = makeSeededCapabilities([
          { resourceName: "delete-test-1.example.io", kind: "DeleteTest1" },
          { resourceName: "delete-test-2.example.io", kind: "DeleteTest2" },
        ]);
        await storeCapabilities(seeded, vectorStore, {
          onProgress: () => {},
        });
        allTestIds.push("delete-test-1.example.io", "delete-test-2.example.io");

        // Verify they exist before deleting
        const beforeResults = await vectorStore.keywordSearch(
          CAPABILITIES_COLLECTION,
          "Seeded for integration test",
          { nResults: 10 }
        );
        expect(
          beforeResults.find((r) => r.id === "delete-test-1.example.io")
        ).toBeDefined();
        expect(
          beforeResults.find((r) => r.id === "delete-test-2.example.io")
        ).toBeDefined();

        // Delete via the endpoint
        const res = await postScan(app, {
          deletes: ["delete-test-1.example.io", "delete-test-2.example.io"],
        });

        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body).toEqual({
          status: "accepted",
          upserts: 0,
          deletes: 2,
        });

        // Poll until both documents are gone
        await vi.waitFor(
          async () => {
            const afterResults = await vectorStore.keywordSearch(
              CAPABILITIES_COLLECTION,
              "Seeded for integration test",
              { nResults: 10 }
            );
            expect(
              afterResults.find((r) => r.id === "delete-test-1.example.io")
            ).toBeUndefined();
            expect(
              afterResults.find((r) => r.id === "delete-test-2.example.io")
            ).toBeUndefined();
          },
          { timeout: 15_000, interval: 1_000 }
        );
      }, 30_000);
    });

    // -----------------------------------------------------------------------
    // Mixed — upserts + deletes in same request
    // -----------------------------------------------------------------------

    describe("mixed upserts + deletes", () => {
      it("processes both operations and reaches correct final state", async () => {
        // Seed a capability that will be deleted in the mixed request
        const seeded = makeSeededCapabilities([
          { resourceName: "mixed-delete.example.io", kind: "MixedDelete" },
        ]);
        await storeCapabilities(seeded, vectorStore, {
          onProgress: () => {},
        });
        allTestIds.push("mixed-delete.example.io");

        // Verify the seeded doc exists before the mixed request
        const beforeResults = await vectorStore.keywordSearch(
          CAPABILITIES_COLLECTION,
          "MixedDelete",
          { nResults: 10 }
        );
        expect(
          beforeResults.find((r) => r.id === "mixed-delete.example.io")
        ).toBeDefined();

        // POST mixed payload: delete the seeded doc, upsert via real pipeline
        const res = await postScan(app, {
          upserts: ["sqls.devopstoolkit.live"],
          deletes: ["mixed-delete.example.io"],
        });

        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body).toEqual({
          status: "accepted",
          upserts: 1,
          deletes: 1,
        });

        allTestIds.push("sqls.devopstoolkit.live");

        // Poll until BOTH conditions are true atomically:
        // - deleted doc is gone
        // - upserted doc is present
        // Checking both together prevents a race where we pass on upserts
        // before deletes have finished processing (or vice versa).
        await vi.waitFor(
          async () => {
            // Check delete: seeded doc should be gone
            const deleteCheck = await vectorStore.keywordSearch(
              CAPABILITIES_COLLECTION,
              "MixedDelete",
              { nResults: 10 }
            );
            expect(
              deleteCheck.find((r) => r.id === "mixed-delete.example.io")
            ).toBeUndefined();

            // Check upsert: SQL capability should be present
            const upsertCheck = await vectorStore.search(
              CAPABILITIES_COLLECTION,
              "database",
              { nResults: 10 }
            );
            expect(
              upsertCheck.find((r) => r.id === "sqls.devopstoolkit.live")
            ).toBeDefined();
          },
          { timeout: 90_000, interval: 2_000 }
        );
      }, 120_000);
    });

    // -----------------------------------------------------------------------
    // Contract tests — payload format matching controller expectations
    // -----------------------------------------------------------------------

    describe("controller payload contract", () => {
      /**
       * Controller expectations for the capability scan endpoint:
       *
       * | Behavior                  | Expected                  | HTTP Code |
       * |---------------------------|---------------------------|-----------|
       * | Valid payload accepted     | Controller moves on       | 202       |
       * | Bad request                | Controller does NOT retry | 400       |
       * | Empty payload              | Tolerated                 | 202       |
       * | Go nil slices (null)       | Treated as empty arrays   | 202       |
       */

      it("accepts Go nil slices (JSON null) for upserts and deletes", async () => {
        const res = await postScan(app, {
          upserts: null,
          deletes: null,
        });

        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body).toEqual({
          status: "accepted",
          upserts: 0,
          deletes: 0,
        });
      }, 15_000);

      it("accepts empty object payload", async () => {
        const res = await postScan(app, {});

        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body).toEqual({
          status: "accepted",
          upserts: 0,
          deletes: 0,
        });
      }, 15_000);

      it("accepts explicitly empty arrays", async () => {
        const res = await postScan(app, { upserts: [], deletes: [] });

        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body).toEqual({
          status: "accepted",
          upserts: 0,
          deletes: 0,
        });
      }, 15_000);

      it("accepts fully qualified CRD names (controller format)", async () => {
        // The controller sends fully qualified names from CRD metadata
        const res = await postScan(app, {
          upserts: [
            "certificates.cert-manager.io",
            "issuers.cert-manager.io",
            "clusterissuers.cert-manager.io",
          ],
        });

        // 202 means the payload was accepted — pipeline processes in background
        // (will fail in background because mock kubectl doesn't know these
        // resources, but the HTTP contract is what we're testing here)
        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body).toEqual({
          status: "accepted",
          upserts: 3,
          deletes: 0,
        });
      }, 15_000);

      it("returns 400 for invalid payload (controller no-retry path)", async () => {
        const res = await postScan(app, {
          upserts: [123, true],
        });
        expect(res.status).toBe(400);
      }, 15_000);

      it("returns 400 for non-object payload", async () => {
        const res = await postScan(app, "not an object");
        expect(res.status).toBe(400);
      }, 15_000);

      it("returns 400 for malformed JSON", async () => {
        const res = await app.request("/api/v1/capabilities/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{broken json",
        });
        expect(res.status).toBe(400);
      }, 15_000);
    });

    // -----------------------------------------------------------------------
    // Response code contract — 202 response shape
    // -----------------------------------------------------------------------

    describe("response shape contract", () => {
      it("returns counts from payload, not from processing results", async () => {
        // The 202 response reports what was *requested*, not what succeeded.
        // Processing happens in the background — the controller uses the
        // counts to confirm its payload was received intact.
        const res = await postScan(app, {
          upserts: ["a.example.io", "b.example.io"],
          deletes: ["c.example.io"],
        });

        expect(res.status).toBe(202);
        const body = await res.json();
        expect(body).toEqual({
          status: "accepted",
          upserts: 2,
          deletes: 1,
        });
      }, 15_000);
    });
  }
);
