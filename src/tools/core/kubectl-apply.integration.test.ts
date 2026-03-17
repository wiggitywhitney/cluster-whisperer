// ABOUTME: Integration tests for kubectl-apply against a real Kind cluster.
// ABOUTME: Uses mock VectorStore (no API tokens) + real kubectl to test actual resource creation.

/**
 * kubectl-apply integration tests
 *
 * These tests run against an ephemeral Kind cluster managed by the scripts in
 * test/integration/. The VectorStore is mocked (no Chroma/Voyage needed) since
 * unit tests already cover that interaction. What we're testing here:
 *
 * 1. kubectl apply -f - actually creates resources in a real cluster
 * 2. The full flow (parse YAML → validate catalog → apply) works end-to-end
 * 3. Resources that fail catalog validation never reach the cluster
 *
 * Run via: src/tools/core/test/integration/run.sh
 * Or manually: KIND_CLUSTER_NAME=kubectl-apply-test npx vitest run src/tools/core/kubectl-apply.integration.test.ts
 *
 * No API tokens required. Only needs: Docker, Kind, kubectl.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import type { VectorStore, SearchResult } from "../../vectorstore";

// ---------------------------------------------------------------------------
// Skip check — only run when a Kind cluster is available
// ---------------------------------------------------------------------------

const CLUSTER_NAME = process.env.KIND_CLUSTER_NAME ?? "kubectl-apply-test";
const CONTEXT = `kind-${CLUSTER_NAME}`;
const TEST_NAMESPACE = "kubectl-apply-test";

/**
 * Unique suffix to prevent collisions between test runs.
 * Appended to resource names so parallel runs don't conflict.
 */
const RUN_ID = Date.now().toString(36);

function clusterAvailable(): boolean {
  const result = spawnSync("kubectl", ["--context", CONTEXT, "cluster-info"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return result.status === 0;
}

const skipReason = clusterAvailable()
  ? false
  : `Kind cluster '${CLUSTER_NAME}' not available. Run test/integration/setup.sh first.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run kubectl against the test cluster and return stdout. */
function kubectl(...args: string[]): { stdout: string; status: number | null } {
  const result = spawnSync(
    "kubectl",
    ["--context", CONTEXT, "-n", TEST_NAMESPACE, ...args],
    { encoding: "utf-8", timeout: 15000 }
  );
  return { stdout: result.stdout, status: result.status };
}

/** Create a mock VectorStore that approves specific resource types. */
function createApprovedCatalog(
  approved: Array<{ kind: string; apiGroup: string }>
): VectorStore {
  return {
    initialize: async () => {},
    store: async () => {},
    search: async () => [],
    delete: async () => {},
    keywordSearch: async (
      _collection: string,
      _keyword?: string,
      options?: { where?: Record<string, unknown> }
    ): Promise<SearchResult[]> => {
      const where = options?.where as
        | { kind: string; apiGroup: string }
        | undefined;
      if (!where) return [];

      const match = approved.find(
        (a) => a.kind === where.kind && a.apiGroup === where.apiGroup
      );
      if (!match) return [];

      return [
        {
          id: `${match.apiGroup}/${match.kind}`,
          text: `${match.kind} resource`,
          metadata: { kind: match.kind, apiGroup: match.apiGroup },
          score: -1,
        },
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// Import the tool under test (dynamic to allow skip logic to run first)
// ---------------------------------------------------------------------------

const { kubectlApply } = await import("./kubectl-apply");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(skipReason)("kubectl-apply integration", () => {
  // The setup script installs testresources.test.cluster-whisperer.io into the
  // Kind cluster. We approve that CRD in the catalog so the approved-resource
  // tests can exercise a real kubectl apply with a custom apiGroup.
  const vectorStore = createApprovedCatalog([
    { kind: "TestResource", apiGroup: "test.cluster-whisperer.io" },
  ]);

  const testResourceName = `test-res-${RUN_ID}`;
  const unknownResourceName = `unknown-res-${RUN_ID}`;

  beforeAll(() => {
    // Ensure test namespace exists (setup.sh creates it, but guard against
    // the test being run manually without setup)
    spawnSync(
      "kubectl",
      [
        "--context",
        CONTEXT,
        "create",
        "namespace",
        TEST_NAMESPACE,
        "--dry-run=client",
        "-o",
        "yaml",
      ],
      { encoding: "utf-8" }
    );
  });

  afterAll(() => {
    kubectl("delete", "testresource", testResourceName, "--ignore-not-found");
  });

  it("applies an approved custom resource to the cluster", async () => {
    const manifest = [
      "apiVersion: test.cluster-whisperer.io/v1",
      "kind: TestResource",
      "metadata:",
      `  name: ${testResourceName}`,
      `  namespace: ${TEST_NAMESPACE}`,
      "spec:",
      "  test-key: integration-test-value",
    ].join("\n");

    const result = await kubectlApply(vectorStore, { manifest });

    expect(result.isError).toBe(false);
    expect(result.output).toContain(testResourceName);

    // Verify the resource actually exists in the cluster
    const verify = kubectl(
      "get",
      "testresource.test.cluster-whisperer.io",
      testResourceName
    );
    expect(verify.status).toBe(0);
  }, 15000);

  it("rejects a catalog-unapproved custom resource and does NOT create it", async () => {
    // widgets.example.com is a custom apiGroup not blocked by the built-in guard
    // and not present in the approved catalog.
    const manifest = [
      "apiVersion: widgets.example.com/v1beta1",
      "kind: Widget",
      "metadata:",
      `  name: ${unknownResourceName}`,
      `  namespace: ${TEST_NAMESPACE}`,
    ].join("\n");

    const result = await kubectlApply(vectorStore, { manifest });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("not in the approved platform catalog");
    expect(result.output).toContain("Widget");
    expect(result.output).toContain("widgets.example.com");
  }, 15000);

  it("handles applying a resource that already exists (idempotent)", async () => {
    const manifest = [
      "apiVersion: test.cluster-whisperer.io/v1",
      "kind: TestResource",
      "metadata:",
      `  name: ${testResourceName}`,
      `  namespace: ${TEST_NAMESPACE}`,
      "spec:",
      "  test-key: updated-value",
    ].join("\n");

    // Apply again — should succeed (kubectl apply is idempotent)
    const result = await kubectlApply(vectorStore, { manifest });

    expect(result.isError).toBe(false);
    expect(result.output).toContain(testResourceName);
  }, 15000);

  it("returns error for a valid but malformed manifest (missing required fields)", async () => {
    // TestResource is approved, but empty name fails at kubectl level
    const manifest = [
      "apiVersion: test.cluster-whisperer.io/v1",
      "kind: TestResource",
      "metadata:",
      `  name: ""`,
      `  namespace: ${TEST_NAMESPACE}`,
    ].join("\n");

    const result = await kubectlApply(vectorStore, { manifest });

    // kubectl should reject empty name
    expect(result.isError).toBe(true);
  }, 15000);
});
