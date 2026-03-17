// ABOUTME: Unit tests for Vercel AI SDK tool wrappers — covers all 5 tools and 3 factory functions
// ABOUTME: Tests the thin wrapper layer between core functions and Vercel AI SDK agent integration

/**
 * Tests for Vercel AI SDK tool wrappers
 *
 * These tests verify the Vercel-specific wrapper behavior:
 * - Factory creation (createKubectlTools, createVectorTools, createApplyTools)
 * - Tool metadata (description, inputSchema)
 * - Execute delegation to core functions
 * - Graceful degradation when vector DB is unavailable
 * - Return type is Record<string, Tool> (not arrays like LangChain)
 *
 * Core logic (kubectl execution, YAML parsing, catalog validation) is tested
 * in core/*.test.ts. These tests focus on the Vercel integration layer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the tracing module before imports — pass through the handler unchanged
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
    stdout: "NAME        READY   STATUS    RESTARTS   AGE\nnginx-pod   1/1     Running   0          5d\n",
    stderr: "",
    status: 0,
    error: null,
  })),
}));

import {
  createKubectlTools,
  createVectorTools,
  createApplyTools,
} from "./index";
import type { VectorStore } from "../../vectorstore";
import {
  kubectlGetDescription,
  kubectlDescribeDescription,
  kubectlLogsDescription,
  kubectlGetSchema,
  kubectlDescribeSchema,
  kubectlLogsSchema,
  vectorSearchDescription,
  vectorSearchSchema,
  kubectlApplyDescription,
  kubectlApplySchema,
} from "../core";

/**
 * Creates a mock VectorStore for testing.
 * Uses the actual VectorStore interface methods (search, keywordSearch, etc.)
 */
function createMockVectorStore(
  overrides: Partial<VectorStore> = {}
): VectorStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    keywordSearch: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// --- createKubectlTools ---

describe("createKubectlTools", () => {
  it("returns a Record with three tools", () => {
    const tools = createKubectlTools();
    expect(Object.keys(tools)).toHaveLength(3);
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["kubectl_get", "kubectl_describe", "kubectl_logs"])
    );
  });

  it("kubectl_get has correct description", () => {
    const tools = createKubectlTools();
    expect(tools.kubectl_get.description).toBe(kubectlGetDescription);
  });

  it("kubectl_describe has correct description", () => {
    const tools = createKubectlTools();
    expect(tools.kubectl_describe.description).toBe(kubectlDescribeDescription);
  });

  it("kubectl_logs has correct description", () => {
    const tools = createKubectlTools();
    expect(tools.kubectl_logs.description).toBe(kubectlLogsDescription);
  });

  it("kubectl_get has correct inputSchema", () => {
    const tools = createKubectlTools();
    expect(tools.kubectl_get.inputSchema).toBe(kubectlGetSchema);
  });

  it("kubectl_describe has correct inputSchema", () => {
    const tools = createKubectlTools();
    expect(tools.kubectl_describe.inputSchema).toBe(kubectlDescribeSchema);
  });

  it("kubectl_logs has correct inputSchema", () => {
    const tools = createKubectlTools();
    expect(tools.kubectl_logs.inputSchema).toBe(kubectlLogsSchema);
  });

  it("kubectl_get execute delegates to core function", async () => {
    const tools = createKubectlTools();
    const result = await tools.kubectl_get.execute(
      { resource: "pods", namespace: "default" },
      { toolCallId: "test-1", messages: [], abortSignal: undefined as unknown as AbortSignal }
    );
    expect(result).toContain("nginx-pod");
  });

  it("kubectl_get passes kubeconfig option through", async () => {
    const { spawnSync } = await import("child_process");
    const tools = createKubectlTools({ kubeconfig: "/tmp/test.kubeconfig" });
    await tools.kubectl_get.execute(
      { resource: "pods" },
      { toolCallId: "test-2", messages: [], abortSignal: undefined as unknown as AbortSignal }
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "kubectl",
      expect.arrayContaining(["--kubeconfig", "/tmp/test.kubeconfig"]),
      expect.any(Object)
    );
  });
});

// --- createVectorTools ---

describe("createVectorTools", () => {
  let mockVectorStore: VectorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVectorStore = createMockVectorStore({
      search: vi.fn().mockResolvedValue([
        {
          id: "1",
          text: "PostgreSQL managed database",
          metadata: { kind: "PostgreSQL", apiGroup: "acid.zalan.do" },
          score: 0.1,
        },
      ]),
    });
  });

  it("returns a Record with one tool", () => {
    const tools = createVectorTools(mockVectorStore);
    expect(Object.keys(tools)).toHaveLength(1);
    expect(Object.keys(tools)).toContain("vector_search");
  });

  it("vector_search has correct description", () => {
    const tools = createVectorTools(mockVectorStore);
    expect(tools.vector_search.description).toBe(vectorSearchDescription);
  });

  it("vector_search has correct inputSchema", () => {
    const tools = createVectorTools(mockVectorStore);
    expect(tools.vector_search.inputSchema).toBe(vectorSearchSchema);
  });

  it("vector_search execute delegates to core function", async () => {
    const tools = createVectorTools(mockVectorStore);
    const result = await tools.vector_search.execute(
      { query: "managed database", collection: "capabilities" },
      { toolCallId: "test-3", messages: [], abortSignal: undefined as unknown as AbortSignal }
    );
    expect(mockVectorStore.search).toHaveBeenCalledWith(
      "capabilities",
      "managed database",
      expect.objectContaining({ nResults: 5 })
    );
    expect(result).toContain("PostgreSQL");
  });

  it("returns graceful message when vector DB is unreachable", async () => {
    const unreachableStore = createMockVectorStore({
      initialize: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const tools = createVectorTools(unreachableStore);
    const result = await tools.vector_search.execute(
      { query: "database", collection: "capabilities" },
      { toolCallId: "test-4", messages: [], abortSignal: undefined as unknown as AbortSignal }
    );
    expect(result).toContain("Vector database is not available");
  });

  it("re-throws non-connection errors from initialization", async () => {
    // Non-connectivity errors (e.g., permission denied) should propagate,
    // not be swallowed into a string result
    const brokenStore = createMockVectorStore({
      initialize: vi.fn().mockRejectedValue(new Error("Permission denied: cannot access collection")),
    });
    const tools = createVectorTools(brokenStore);
    await expect(
      tools.vector_search.execute(
        { query: "database", collection: "capabilities" },
        { toolCallId: "test-5", messages: [], abortSignal: undefined as unknown as AbortSignal }
      )
    ).rejects.toThrow("Permission denied: cannot access collection");
  });
});

// --- createApplyTools ---

describe("createApplyTools", () => {
  let mockVectorStore: VectorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVectorStore = createMockVectorStore({
      keywordSearch: vi.fn().mockResolvedValue([
        {
          id: "1",
          text: "ManagedService resource",
          metadata: { kind: "ManagedService", apiGroup: "platform.acme.io" },
          score: -1,
        },
      ]),
    });
  });

  it("returns a Record with one tool", () => {
    const tools = createApplyTools(mockVectorStore);
    expect(Object.keys(tools)).toHaveLength(1);
    expect(Object.keys(tools)).toContain("kubectl_apply");
  });

  it("kubectl_apply has correct description", () => {
    const tools = createApplyTools(mockVectorStore);
    expect(tools.kubectl_apply.description).toBe(kubectlApplyDescription);
  });

  it("kubectl_apply has correct inputSchema", () => {
    const tools = createApplyTools(mockVectorStore);
    expect(tools.kubectl_apply.inputSchema).toBe(kubectlApplySchema);
  });

  it("kubectl_apply execute delegates to core function", async () => {
    const { spawnSync } = await import("child_process");
    (spawnSync as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      stdout: "managedservice.platform.acme.io/youchoose-db created\n",
      stderr: "",
      status: 0,
      error: null,
    });

    const manifest = `apiVersion: platform.acme.io/v1alpha1
kind: ManagedService
metadata:
  name: youchoose-db`;

    const tools = createApplyTools(mockVectorStore);
    const result = await tools.kubectl_apply.execute(
      { manifest },
      { toolCallId: "test-6", messages: [], abortSignal: undefined as unknown as AbortSignal }
    );

    // Core function should have queried the catalog
    expect(mockVectorStore.keywordSearch).toHaveBeenCalledWith(
      "capabilities",
      undefined,
      expect.objectContaining({
        where: { kind: "ManagedService", apiGroup: "platform.acme.io" },
      })
    );
    expect(result).toContain("created");
  });

  it("returns graceful message when vector DB is unreachable for catalog validation", async () => {
    const unreachableStore = createMockVectorStore({
      keywordSearch: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const tools = createApplyTools(unreachableStore);
    const result = await tools.kubectl_apply.execute(
      {
        manifest: `apiVersion: widgets.example.com/v1beta1
kind: Widget
metadata:
  name: test`,
      },
      { toolCallId: "test-7", messages: [], abortSignal: undefined as unknown as AbortSignal }
    );
    // The core function handles ECONNREFUSED within catalog validation
    expect(result).toContain("Catalog validation failed");
  });

  it("returns catalog rejection for unapproved resources", async () => {
    const emptyStore = createMockVectorStore({
      keywordSearch: vi.fn().mockResolvedValue([]),
    });
    const tools = createApplyTools(emptyStore);
    const result = await tools.kubectl_apply.execute(
      {
        manifest: `apiVersion: widgets.example.com/v1beta1
kind: Widget
metadata:
  name: test-widget`,
      },
      { toolCallId: "test-8", messages: [], abortSignal: undefined as unknown as AbortSignal }
    );
    expect(result).toContain("not in the approved platform catalog");
  });

  it("returns parse error for invalid YAML", async () => {
    const tools = createApplyTools(mockVectorStore);
    const result = await tools.kubectl_apply.execute(
      { manifest: "not: valid: yaml: [" },
      { toolCallId: "test-9", messages: [], abortSignal: undefined as unknown as AbortSignal }
    );
    expect(result).toContain("Failed to parse YAML");
  });
});
