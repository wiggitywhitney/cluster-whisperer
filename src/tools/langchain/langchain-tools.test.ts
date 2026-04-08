// ABOUTME: Unit tests for LangChain tool wrappers — covers apply tool factory
// ABOUTME: Tests the thin wrapper layer between core functions and LangChain agent integration

/**
 * Tests for LangChain tool wrappers
 *
 * These tests verify the LangChain-specific wrapper behavior:
 * - Factory creation (createApplyTools)
 * - Tool metadata (name, description, schema)
 * - Tool invocation passes through to core and returns output
 *
 * Core logic (YAML parsing, kubectl execution, Kyverno error surfacing) is
 * tested in core/kubectl-apply.test.ts. These tests focus on the LangChain
 * integration layer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the tracing module before imports
vi.mock("../../tracing/tool-tracing", () => ({
  withToolTracing: (_meta: unknown, fn: Function) => fn,
}));

// Mock the tracing module
vi.mock("../../tracing", () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: Function) => {
      const mockSpan = {
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
      };
      return fn(mockSpan);
    },
  }),
}));

// Mock child_process for kubectl calls
vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({
    stdout: "managedservice.platform.acme.io/youchoose-db created\n",
    stderr: "",
    status: 0,
    error: null,
  })),
}));

import { createApplyTools } from "./index";

describe("createApplyTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an array with one tool", () => {
    const tools = createApplyTools();
    expect(tools).toHaveLength(1);
  });

  it("creates a tool named kubectl_apply", () => {
    const tools = createApplyTools();
    expect(tools[0].name).toBe("kubectl_apply");
  });

  it("tool has a description", () => {
    const tools = createApplyTools();
    expect(tools[0].description).toBeTruthy();
  });

  it("tool invocation calls kubectl and returns output", async () => {
    const tools = createApplyTools();
    const applyTool = tools[0];

    const manifest = `apiVersion: platform.acme.io/v1alpha1
kind: ManagedService
metadata:
  name: youchoose-db`;

    const result = await applyTool.invoke({ manifest });

    // Should return the kubectl output string
    expect(result).toContain("created");
  });

  it("returns parse error for invalid YAML", async () => {
    const tools = createApplyTools();
    const result = await tools[0].invoke({ manifest: "not: valid: yaml: [" });

    expect(result).toContain("Failed to parse YAML");
  });

  it("surfaces Kyverno rejection from kubectl stderr", async () => {
    const { spawnSync } = await import("child_process");
    vi.mocked(spawnSync).mockReturnValueOnce({
      stdout: "",
      stderr: `Error from server: admission webhook "validate.kyverno.svc" denied the request: [require-approved-resources] Only ManagedService resources are allowed.`,
      status: 1,
      error: null,
      pid: 0,
      output: [],
      signal: null,
    });

    const tools = createApplyTools();
    const result = await tools[0].invoke({
      manifest: `apiVersion: v1
kind: ConfigMap
metadata:
  name: test-config`,
    });

    expect(result).toContain("admission webhook");
  });
});
