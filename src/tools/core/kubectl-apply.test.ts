// ABOUTME: Unit tests for kubectl-apply core tool
// ABOUTME: Tests YAML parsing, kubectl execution, and Kyverno error surfacing using TDD

import { describe, it, expect, vi, beforeEach } from "vitest";

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

  const managedServiceManifest = [
    "apiVersion: platform.acme.io/v1alpha1",
    "kind: ManagedService",
    "metadata:",
    "  name: youchoose-db",
    "spec:",
    "  engine: postgresql",
  ].join("\n");

  describe("successful apply", () => {
    it("applies the manifest and returns kubectl output", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "managedservice.platform.acme.io/youchoose-db created",
        stderr: "",
        status: 0,
        error: null,
      });

      const result = await kubectlApply({ manifest: managedServiceManifest });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("youchoose-db created");
    });

    it("applies any resource type — admission enforcement is Kyverno's job", async () => {
      const configMapManifest = [
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: my-config",
        "data:",
        "  key: value",
      ].join("\n");

      mockSpawnSync.mockReturnValue({
        stdout: "configmap/my-config created",
        stderr: "",
        status: 0,
        error: null,
      });

      const result = await kubectlApply({ manifest: configMapManifest });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("my-config created");
    });
  });

  describe("Kyverno admission rejection", () => {
    it("surfaces Kyverno rejection error from kubectl stderr", async () => {
      const kyvernoError = [
        `Error from server: admission webhook "validate.kyverno.svc" denied the request:`,
        `[require-approved-resources] Only ManagedService resources from platform.acme.io are allowed through the cluster whisperer agent.`,
      ].join("\n");

      mockSpawnSync.mockReturnValue({
        stdout: "",
        stderr: kyvernoError,
        status: 1,
        error: null,
      });

      const result = await kubectlApply({ manifest: managedServiceManifest });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("admission webhook");
      expect(result.output).toContain("require-approved-resources");
    });
  });

  describe("YAML parsing errors", () => {
    it("returns error for invalid YAML", async () => {
      const result = await kubectlApply({ manifest: "not: valid: {{{" });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Failed to parse YAML manifest");
    });

    it("returns error when kind is missing from manifest", async () => {
      const result = await kubectlApply({
        manifest: "apiVersion: v1\nmetadata:\n  name: test",
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("kind");
    });
  });

  describe("kubectl execution", () => {
    it("pipes the manifest to kubectl apply via stdin", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "managedservice.platform.acme.io/youchoose-db created",
        stderr: "",
        status: 0,
        error: null,
      });

      await kubectlApply({ manifest: managedServiceManifest });

      // Verify kubectl was called with apply -f - and stdin input
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "kubectl",
        ["apply", "-f", "-"],
        expect.objectContaining({
          input: managedServiceManifest,
          encoding: "utf-8",
        })
      );
    });

    it("returns error when kubectl apply fails", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "",
        stderr: "error: unable to recognize STDIN",
        status: 1,
        error: null,
      });

      const result = await kubectlApply({ manifest: managedServiceManifest });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("unable to recognize STDIN");
    });

    it("returns error when kubectl spawn fails", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "",
        stderr: "",
        status: null,
        error: new Error("ENOENT"),
      });

      const result = await kubectlApply({ manifest: managedServiceManifest });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("ENOENT");
    });
  });

  describe("namespace handling", () => {
    it("passes namespace from manifest to kubectl via stdin", async () => {
      const namespacedManifest = [
        "apiVersion: platform.acme.io/v1alpha1",
        "kind: ManagedService",
        "metadata:",
        "  name: youchoose-db",
        "  namespace: production",
        "spec:",
        "  engine: postgresql",
      ].join("\n");

      mockSpawnSync.mockReturnValue({
        stdout: "managedservice.platform.acme.io/youchoose-db created",
        stderr: "",
        status: 0,
        error: null,
      });

      await kubectlApply({ manifest: namespacedManifest });

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
      mockSpawnSync.mockReturnValue({
        stdout: "managedservice.platform.acme.io/youchoose-db created",
        stderr: "",
        status: 0,
        error: null,
      });

      await kubectlApply({ manifest: managedServiceManifest }, {
        kubeconfig: "/home/demo/.kube/config-cluster-whisperer",
      });

      // Verify --kubeconfig is prepended to the args
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "kubectl",
        ["--kubeconfig", "/home/demo/.kube/config-cluster-whisperer", "apply", "-f", "-"],
        expect.objectContaining({
          input: managedServiceManifest,
          encoding: "utf-8",
        })
      );
    });

    it("does not include --kubeconfig when option is not provided", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "managedservice.platform.acme.io/youchoose-db created",
        stderr: "",
        status: 0,
        error: null,
      });

      await kubectlApply({ manifest: managedServiceManifest });

      // Verify --kubeconfig is NOT in the args
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "kubectl",
        ["apply", "-f", "-"],
        expect.objectContaining({
          input: managedServiceManifest,
          encoding: "utf-8",
        })
      );
    });
  });
});
