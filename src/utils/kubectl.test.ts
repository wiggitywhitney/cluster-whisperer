// ABOUTME: Unit tests for kubectl utility — kubeconfig support and sensitive arg redaction.
// ABOUTME: Verifies --kubeconfig prepending and redactSensitiveArgs edge cases.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process and tracing for executeKubectl tests
// ---------------------------------------------------------------------------

const mockSpawnSync = vi.fn();
vi.mock("child_process", () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

vi.mock("../tracing", () => ({
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

// Dynamic import after mocks
const { executeKubectl, redactSensitiveArgs } = await import("./kubectl");

describe("executeKubectl kubeconfig support", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it("prepends --kubeconfig to args when kubeconfig option is provided", () => {
    mockSpawnSync.mockReturnValue({
      stdout: "NAME   READY   STATUS\nnginx  1/1     Running\n",
      stderr: "",
      status: 0,
      error: null,
    });

    executeKubectl(["get", "pods", "-n", "default"], {
      kubeconfig: "/home/demo/.kube/config-cluster-whisperer",
    });

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "kubectl",
      ["--kubeconfig", "/home/demo/.kube/config-cluster-whisperer", "get", "pods", "-n", "default"],
      expect.objectContaining({ encoding: "utf-8" })
    );
  });

  it("does not prepend --kubeconfig when option is not provided", () => {
    mockSpawnSync.mockReturnValue({
      stdout: "NAME   READY   STATUS\nnginx  1/1     Running\n",
      stderr: "",
      status: 0,
      error: null,
    });

    executeKubectl(["get", "pods", "-n", "default"]);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "kubectl",
      ["get", "pods", "-n", "default"],
      expect.objectContaining({ encoding: "utf-8" })
    );
  });

  it("does not prepend --kubeconfig when options object has no kubeconfig", () => {
    mockSpawnSync.mockReturnValue({
      stdout: "",
      stderr: "",
      status: 0,
      error: null,
    });

    executeKubectl(["get", "pods"], {});

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "kubectl",
      ["get", "pods"],
      expect.objectContaining({ encoding: "utf-8" })
    );
  });

  it("returns successful result when kubectl succeeds", () => {
    const expectedOutput = "NAME   READY   STATUS\nnginx  1/1     Running\n";
    mockSpawnSync.mockReturnValue({
      stdout: expectedOutput,
      stderr: "",
      status: 0,
      error: null,
    });

    const result = executeKubectl(["get", "pods"]);

    expect(result.isError).toBe(false);
    expect(result.output).toBe(expectedOutput);
  });

  it("returns error result when kubectl fails", () => {
    mockSpawnSync.mockReturnValue({
      stdout: "",
      stderr: "error: the server doesn't have a resource type \"bogus\"",
      status: 1,
      error: null,
    });

    const result = executeKubectl(["get", "bogus"]);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("bogus");
  });
});

describe("redactSensitiveArgs", () => {
  it("passes through non-sensitive args unchanged", () => {
    const args = ["get", "pods", "-n", "default"];
    expect(redactSensitiveArgs(args)).toEqual(args);
  });

  it("redacts --token value", () => {
    const args = ["get", "pods", "--token", "secret-value"];
    expect(redactSensitiveArgs(args)).toEqual([
      "get",
      "pods",
      "--token",
      "[REDACTED]",
    ]);
  });

  it("redacts --token=value format", () => {
    const args = ["get", "pods", "--token=secret-value"];
    expect(redactSensitiveArgs(args)).toEqual([
      "get",
      "pods",
      "--token=[REDACTED]",
    ]);
  });

  it("does not redact args that merely contain 'token' as a substring", () => {
    const args = [
      "get",
      "pods",
      "--tokenizer=something",
    ];
    expect(redactSensitiveArgs(args)).toEqual([
      "get",
      "pods",
      "--tokenizer=something",
    ]);
  });
});
