// ABOUTME: Unit tests for kubectl-apply core tool
// ABOUTME: Tests YAML parsing, catalog validation, and apply execution using TDD

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VectorStore, SearchResult } from "../../vectorstore";

// ---------------------------------------------------------------------------
// Mock child_process — we test tool logic, not kubectl behavior
// ---------------------------------------------------------------------------

const mockSpawnSync = vi.fn();
vi.mock("child_process", () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

// ---------------------------------------------------------------------------
// Mock tracing — no-op tracer for unit tests
// ---------------------------------------------------------------------------

vi.mock("../../tracing", () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) => {
      const noopSpan = {
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
      };
      return fn(noopSpan);
    },
  }),
}));

// ---------------------------------------------------------------------------
// Helper: create a mock VectorStore
// ---------------------------------------------------------------------------

function createMockVectorStore(overrides?: Partial<VectorStore>): VectorStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    keywordSearch: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Helper: create a SearchResult representing an approved resource in the catalog.
 */
function makeCatalogEntry(kind: string, apiGroup: string): SearchResult {
  return {
    id: `${apiGroup}/${kind}`,
    text: `${kind} is a Kubernetes resource in the ${apiGroup} API group.`,
    metadata: { kind, apiGroup },
    score: -1,
  };
}

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

const { kubectlApply, kubectlApplySchema, parseManifestMetadata } = await import(
  "./kubectl-apply"
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kubectlApplySchema", () => {
  it("accepts a valid YAML manifest string", () => {
    const result = kubectlApplySchema.safeParse({
      manifest: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: test",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty manifest", () => {
    const result = kubectlApplySchema.safeParse({ manifest: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing manifest field", () => {
    const result = kubectlApplySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("parseManifestMetadata", () => {
  it("extracts kind and apiGroup from a standard Kubernetes manifest", () => {
    const manifest = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: nginx",
    ].join("\n");

    const result = parseManifestMetadata(manifest);
    expect(result).toEqual({ kind: "Deployment", apiGroup: "apps" });
  });

  it("extracts kind and apiGroup from a CRD with multi-segment apiVersion", () => {
    const manifest = [
      "apiVersion: acid.zalan.do/v1",
      "kind: postgresql",
      "metadata:",
      "  name: my-db",
    ].join("\n");

    const result = parseManifestMetadata(manifest);
    expect(result).toEqual({ kind: "postgresql", apiGroup: "acid.zalan.do" });
  });

  it("handles core API resources (apiVersion: v1) with empty apiGroup", () => {
    const manifest = [
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: my-config",
    ].join("\n");

    const result = parseManifestMetadata(manifest);
    expect(result).toEqual({ kind: "ConfigMap", apiGroup: "" });
  });

  it("returns error for invalid YAML", () => {
    const result = parseManifestMetadata("not: valid: yaml: {{{");
    expect(result).toHaveProperty("error");
  });

  it("returns error when kind is missing", () => {
    const manifest = "apiVersion: v1\nmetadata:\n  name: test";
    const result = parseManifestMetadata(manifest);
    expect(result).toHaveProperty("error");
  });

  it("returns error when apiVersion is missing", () => {
    const manifest = "kind: Deployment\nmetadata:\n  name: test";
    const result = parseManifestMetadata(manifest);
    expect(result).toHaveProperty("error");
  });

  it("rejects multi-document YAML to prevent resource smuggling", () => {
    const manifest = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: first",
      "---",
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: second",
    ].join("\n");

    const result = parseManifestMetadata(manifest);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Multi-document YAML");
  });

  it("handles a manifest starting with --- (single document)", () => {
    const manifest = [
      "---",
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: nginx",
    ].join("\n");

    const result = parseManifestMetadata(manifest);
    expect(result).toEqual({ kind: "Deployment", apiGroup: "apps" });
  });
});

describe("kubectlApply", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  const deploymentManifest = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: nginx",
    "spec:",
    "  replicas: 1",
  ].join("\n");

  const configMapManifest = [
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata:",
    "  name: my-config",
    "data:",
    "  key: value",
  ].join("\n");

  describe("catalog validation", () => {
    it("applies the resource when it exists in the capabilities catalog", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("Deployment", "apps"),
        ]),
      });

      mockSpawnSync.mockReturnValue({
        stdout: "deployment.apps/nginx created",
        stderr: "",
        status: 0,
        error: null,
      });

      const result = await kubectlApply(vectorStore, { manifest: deploymentManifest });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("nginx created");

      // Verify keywordSearch was called with correct filters
      expect(vectorStore.keywordSearch).toHaveBeenCalledWith(
        "capabilities",
        undefined,
        expect.objectContaining({
          where: expect.objectContaining({ kind: "Deployment", apiGroup: "apps" }),
        })
      );
    });

    it("rejects resources not found in the capabilities catalog", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([]),
      });

      const result = await kubectlApply(vectorStore, { manifest: deploymentManifest });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("not in the approved platform catalog");
      expect(result.output).toContain("Deployment");
      expect(result.output).toContain("apps");

      // kubectl should NOT have been called
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it("handles core API resources (apiGroup empty string) in catalog lookup", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("ConfigMap", ""),
        ]),
      });

      mockSpawnSync.mockReturnValue({
        stdout: "configmap/my-config created",
        stderr: "",
        status: 0,
        error: null,
      });

      const result = await kubectlApply(vectorStore, { manifest: configMapManifest });

      expect(result.isError).toBe(false);
      expect(vectorStore.keywordSearch).toHaveBeenCalledWith(
        "capabilities",
        undefined,
        expect.objectContaining({
          where: expect.objectContaining({ kind: "ConfigMap", apiGroup: "" }),
        })
      );
    });

    it("returns error when vectorStore query fails", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockRejectedValue(new Error("Connection refused")),
      });

      const result = await kubectlApply(vectorStore, { manifest: deploymentManifest });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Catalog validation failed");
      expect(result.output).toContain("Connection refused");
    });
  });

  describe("YAML parsing errors", () => {
    it("returns error for invalid YAML", async () => {
      const vectorStore = createMockVectorStore();

      const result = await kubectlApply(vectorStore, { manifest: "not: valid: {{{" });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Failed to parse YAML manifest");
    });

    it("returns error when kind is missing from manifest", async () => {
      const vectorStore = createMockVectorStore();

      const result = await kubectlApply(vectorStore, {
        manifest: "apiVersion: v1\nmetadata:\n  name: test",
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("kind");
    });
  });

  describe("kubectl execution", () => {
    it("pipes the manifest to kubectl apply via stdin", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("Deployment", "apps"),
        ]),
      });

      mockSpawnSync.mockReturnValue({
        stdout: "deployment.apps/nginx created",
        stderr: "",
        status: 0,
        error: null,
      });

      await kubectlApply(vectorStore, { manifest: deploymentManifest });

      // Verify kubectl was called with apply -f - and stdin input
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "kubectl",
        ["apply", "-f", "-"],
        expect.objectContaining({
          input: deploymentManifest,
          encoding: "utf-8",
        })
      );
    });

    it("returns error when kubectl apply fails", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("Deployment", "apps"),
        ]),
      });

      mockSpawnSync.mockReturnValue({
        stdout: "",
        stderr: "error: unable to recognize STDIN",
        status: 1,
        error: null,
      });

      const result = await kubectlApply(vectorStore, { manifest: deploymentManifest });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("unable to recognize STDIN");
    });

    it("returns error when kubectl spawn fails", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("Deployment", "apps"),
        ]),
      });

      mockSpawnSync.mockReturnValue({
        stdout: "",
        stderr: "",
        status: null,
        error: new Error("ENOENT"),
      });

      const result = await kubectlApply(vectorStore, { manifest: deploymentManifest });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("ENOENT");
    });
  });

  describe("namespace handling", () => {
    it("passes namespace flag when manifest specifies a namespace", async () => {
      const namespacedManifest = [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: nginx",
        "  namespace: production",
      ].join("\n");

      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("Deployment", "apps"),
        ]),
      });

      mockSpawnSync.mockReturnValue({
        stdout: "deployment.apps/nginx created",
        stderr: "",
        status: 0,
        error: null,
      });

      await kubectlApply(vectorStore, { manifest: namespacedManifest });

      // kubectl apply -f - handles namespace from the manifest itself,
      // so we just pass the full manifest via stdin
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "kubectl",
        ["apply", "-f", "-"],
        expect.objectContaining({ input: namespacedManifest })
      );
    });
  });

  describe("kubeconfig pass-through", () => {
    it("prepends --kubeconfig to kubectl args when kubeconfig option is provided", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("Deployment", "apps"),
        ]),
      });

      mockSpawnSync.mockReturnValue({
        stdout: "deployment.apps/nginx created",
        stderr: "",
        status: 0,
        error: null,
      });

      await kubectlApply(vectorStore, { manifest: deploymentManifest }, {
        kubeconfig: "/home/demo/.kube/config-cluster-whisperer",
      });

      // Verify --kubeconfig is prepended to the args
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "kubectl",
        ["--kubeconfig", "/home/demo/.kube/config-cluster-whisperer", "apply", "-f", "-"],
        expect.objectContaining({
          input: deploymentManifest,
          encoding: "utf-8",
        })
      );
    });

    it("does not include --kubeconfig when option is not provided", async () => {
      const vectorStore = createMockVectorStore({
        keywordSearch: vi.fn().mockResolvedValue([
          makeCatalogEntry("Deployment", "apps"),
        ]),
      });

      mockSpawnSync.mockReturnValue({
        stdout: "deployment.apps/nginx created",
        stderr: "",
        status: 0,
        error: null,
      });

      await kubectlApply(vectorStore, { manifest: deploymentManifest });

      // Verify --kubeconfig is NOT in the args
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "kubectl",
        ["apply", "-f", "-"],
        expect.objectContaining({
          input: deploymentManifest,
          encoding: "utf-8",
        })
      );
    });
  });
});
