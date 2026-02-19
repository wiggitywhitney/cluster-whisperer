/**
 * runner.integration.test.ts - Integration tests for the sync pipeline runner (M4)
 *
 * Tests the full sync pipeline end-to-end: discover -> infer -> store -> search.
 * Uses mock kubectl (to control cost — just 3 resources) but real Haiku for
 * inference, and real Chroma + Voyage AI for storage and search.
 *
 * This validates that the runner correctly wires the three pipeline stages
 * together with real data flowing between them.
 *
 * Requires:
 * - ANTHROPIC_API_KEY environment variable set (for Haiku inference)
 * - VOYAGE_API_KEY environment variable set (for embeddings)
 * - Chroma running at http://localhost:8000 (or CHROMA_URL)
 *
 * These tests are slower (~30-60 seconds) and cost real API credits.
 */

import { describe, it, expect, afterAll } from "vitest";
import { syncCapabilities } from "./runner";
import {
  ChromaBackend,
  VoyageEmbedding,
  CAPABILITIES_COLLECTION,
} from "../vectorstore";
import type { VectorStore } from "../vectorstore";

// ---------------------------------------------------------------------------
// Skip check
// ---------------------------------------------------------------------------

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
// Mock kubectl — returns a small set of resources to keep costs low
// ---------------------------------------------------------------------------

/**
 * Canned output for `kubectl api-resources -o wide`.
 * Three resources: a CRD (SQL), a core resource (ConfigMap), and a networking resource (Ingress).
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
 * Matches the `(args: string[]) => { output: string; isError: boolean }` signature
 * expected by DiscoveryOptions.kubectl.
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
    // Extract the resource name from "explain <name> --recursive"
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
// Integration tests
// ---------------------------------------------------------------------------

/**
 * Use a unique collection name per test run to avoid collisions
 * with other tests or real data.
 */
const TEST_COLLECTION = `test-sync-runner-${Date.now()}`;

/**
 * Track stored resource IDs for cleanup.
 */
const storedIds: string[] = [];

describe.skipIf(!!skipReason)("syncCapabilities (integration)", () => {
  if (skipReason) {
    it.skip(`skipped: ${skipReason}`, () => {});
    return;
  }

  let vectorStore: VectorStore;

  afterAll(async () => {
    // Clean up test data
    if (vectorStore && storedIds.length > 0) {
      try {
        await vectorStore.delete(TEST_COLLECTION, storedIds);
      } catch {
        // Best-effort cleanup
      }
    }
  });

  it("runs the full pipeline: discover -> infer -> store -> search", async () => {
    // Create real vector store
    const embedder = new VoyageEmbedding();
    const chromaBackend = new ChromaBackend(embedder);
    vectorStore = chromaBackend;

    // Initialize the test collection
    await vectorStore.initialize(TEST_COLLECTION, { distanceMetric: "cosine" });

    // Run the sync pipeline with mock kubectl but real Haiku + Chroma + Voyage.
    // Override the collection by passing a custom vectorStore that's already
    // initialized with our test collection. The storeCapabilities function
    // uses CAPABILITIES_COLLECTION, but since we pass our vectorStore which
    // has our test collection initialized, we need to work around this.
    //
    // For this integration test, we use the real CAPABILITIES_COLLECTION
    // since storeCapabilities hardcodes it. We'll clean up after.
    const progressMessages: string[] = [];

    const result = await syncCapabilities({
      vectorStore: chromaBackend,
      discoveryOptions: { kubectl: mockKubectl },
      // Use default Haiku model (real LLM calls)
      onProgress: (msg) => {
        progressMessages.push(msg);
        // Show progress during test for visibility
        console.log(`  [sync] ${msg}`); // eslint-disable-line no-console
      },
    });

    // Track IDs for cleanup (storeCapabilities uses CAPABILITIES_COLLECTION)
    storedIds.push(
      "sqls.devopstoolkit.live",
      "configmaps",
      "ingresses.networking.k8s.io"
    );

    // Verify SyncResult counts
    expect(result.discovered).toBe(3);
    expect(result.inferred).toBe(3);
    expect(result.stored).toBe(3);

    // Verify progress was reported throughout
    expect(progressMessages.length).toBeGreaterThan(5);
    const hasSyncComplete = progressMessages.some((m) =>
      m.includes("Sync complete")
    );
    expect(hasSyncComplete).toBe(true);

    // Verify search works — "database" should find the SQL CRD
    const searchResults = await vectorStore.search(
      CAPABILITIES_COLLECTION,
      "database",
      { nResults: 5 }
    );
    expect(searchResults.length).toBeGreaterThan(0);
    const sqlResult = searchResults.find(
      (r) => r.id === "sqls.devopstoolkit.live"
    );
    expect(sqlResult).toBeDefined();
  }, 120_000); // 2 minute timeout — LLM inference for 3 resources

  it("supports dry-run mode (no storage)", async () => {
    const progressMessages: string[] = [];

    const result = await syncCapabilities({
      vectorStore: vectorStore,
      discoveryOptions: { kubectl: mockKubectl },
      dryRun: true,
      onProgress: (msg) => progressMessages.push(msg),
    });

    // Discovery and inference still run
    expect(result.discovered).toBe(3);
    expect(result.inferred).toBe(3);
    // But nothing was stored
    expect(result.stored).toBe(0);

    // Progress should mention dry run
    const dryRunMessage = progressMessages.find((m) =>
      m.toLowerCase().includes("dry run")
    );
    expect(dryRunMessage).toBeDefined();
  }, 120_000);
});
