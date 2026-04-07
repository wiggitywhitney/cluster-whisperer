// ABOUTME: Unit tests for kubectl-apply-dryrun core tool
// ABOUTME: Tests dry-run execution, success/failure paths, and kubeconfig pass-through

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionStore } from "../mcp/session-store";

// ---------------------------------------------------------------------------
// Mock child_process — test logic, not kubectl behavior
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
    startActiveSpan: (
      _name: string,
      _opts: unknown,
      fn: (span: unknown) => unknown
    ) => {
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
// Import after mocks
// ---------------------------------------------------------------------------

const { kubectlApplyDryrun, kubectlApplyDryrunSchema } = await import(
  "./kubectl-apply-dryrun"
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kubectlApplyDryrunSchema", () => {
  it("accepts a valid YAML manifest string", () => {
    const result = kubectlApplyDryrunSchema.safeParse({
      manifest:
        "apiVersion: platform.acme.io/v1alpha1\nkind: ManagedService\nmetadata:\n  name: test",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty manifest", () => {
    const result = kubectlApplyDryrunSchema.safeParse({ manifest: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing manifest field", () => {
    const result = kubectlApplyDryrunSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("kubectlApplyDryrun", () => {
  const validManifest = [
    "apiVersion: platform.acme.io/v1alpha1",
    "kind: ManagedService",
    "metadata:",
    "  name: youchoose-db",
    "spec:",
    "  engine: postgresql",
  ].join("\n");

  let sessionStore: SessionStore;

  beforeEach(() => {
    mockSpawnSync.mockReset();
    sessionStore = new SessionStore();
  });

  describe("successful dry-run", () => {
    it("returns sessionId and output when kubectl dry-run succeeds", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "managedservice.platform.acme.io/youchoose-db configured (dry run)\n",
        stderr: "",
        status: 0,
        error: null,
      });

      const result = await kubectlApplyDryrun({ manifest: validManifest }, sessionStore);

      expect(result.isError).toBe(false);
      expect(result.sessionId).toBeDefined();
      expect(typeof result.sessionId).toBe("string");
      expect(result.output).toContain("dry run");
    });

    it("calls kubectl with --dry-run=server flag", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "managedservice.platform.acme.io/youchoose-db configured (dry run)\n",
        stderr: "",
        status: 0,
        error: null,
      });

      await kubectlApplyDryrun({ manifest: validManifest }, sessionStore);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "kubectl",
        expect.arrayContaining(["apply", "--dry-run=server", "-f", "-"]),
        expect.objectContaining({
          input: validManifest,
          encoding: "utf-8",
        })
      );
    });

    it("stores the manifest in the session store", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "configured (dry run)\n",
        stderr: "",
        status: 0,
        error: null,
      });

      const result = await kubectlApplyDryrun({ manifest: validManifest }, sessionStore);

      // The session should be retrievable from the store
      expect(result.sessionId).toBeDefined();
      const stored = sessionStore.peek(result.sessionId!);
      expect(stored).toBe(validManifest);
    });

    it("passes kubeconfig when option is provided", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "configured (dry run)\n",
        stderr: "",
        status: 0,
        error: null,
      });

      await kubectlApplyDryrun(
        { manifest: validManifest },
        sessionStore,
        { kubeconfig: "/home/demo/.kube/config" }
      );

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "kubectl",
        expect.arrayContaining(["--kubeconfig", "/home/demo/.kube/config"]),
        expect.any(Object)
      );
    });

    it("does not include --kubeconfig when option is not provided", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "configured (dry run)\n",
        stderr: "",
        status: 0,
        error: null,
      });

      await kubectlApplyDryrun({ manifest: validManifest }, sessionStore);

      const args = mockSpawnSync.mock.calls[0]?.[1] as string[];
      expect(args).not.toContain("--kubeconfig");
    });
  });

  describe("failed dry-run", () => {
    it("returns error with no sessionId when kubectl dry-run fails", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "",
        stderr: "Error from server: admission webhook rejected manifest",
        status: 1,
        error: null,
      });

      const result = await kubectlApplyDryrun({ manifest: validManifest }, sessionStore);

      expect(result.isError).toBe(true);
      expect(result.sessionId).toBeUndefined();
      expect(result.output).toContain("rejected manifest");
    });

    it("does not store anything in session when dry-run fails", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "",
        stderr: "Error from server: rejected",
        status: 1,
        error: null,
      });

      const storeSpy = vi.spyOn(sessionStore, "store");
      await kubectlApplyDryrun({ manifest: validManifest }, sessionStore);

      expect(storeSpy).not.toHaveBeenCalled();
    });

    it("returns error when kubectl spawn fails (e.g., not installed)", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "",
        stderr: "",
        status: null,
        error: new Error("ENOENT"),
      });

      const result = await kubectlApplyDryrun({ manifest: validManifest }, sessionStore);

      expect(result.isError).toBe(true);
      expect(result.sessionId).toBeUndefined();
      expect(result.output).toContain("ENOENT");
    });

    it("returns error for invalid YAML manifest without calling kubectl", async () => {
      const result = await kubectlApplyDryrun(
        { manifest: "not: valid: yaml: {{{" },
        sessionStore
      );

      expect(result.isError).toBe(true);
      expect(result.sessionId).toBeUndefined();
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });
  });

  describe("session ID uniqueness", () => {
    it("returns a different session ID each time dry-run succeeds", async () => {
      mockSpawnSync.mockReturnValue({
        stdout: "configured (dry run)\n",
        stderr: "",
        status: 0,
        error: null,
      });

      const result1 = await kubectlApplyDryrun({ manifest: validManifest }, sessionStore);
      const result2 = await kubectlApplyDryrun({ manifest: validManifest }, sessionStore);

      expect(result1.sessionId).not.toBe(result2.sessionId);
    });
  });
});
