// ABOUTME: Unit tests for LangChain tool wrappers — covers apply tool factory and graceful degradation
// ABOUTME: Tests the thin wrapper layer between core functions and LangChain agent integration

/**
 * Tests for LangChain tool wrappers
 *
 * These tests verify the LangChain-specific wrapper behavior:
 * - Factory creation (createApplyTools)
 * - Graceful degradation when vector DB is unavailable
 * - Tool metadata (name, description, schema)
 *
 * Core logic (YAML parsing, catalog validation) is tested in core/kubectl-apply.test.ts.
 * These tests focus on the LangChain integration layer.
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
    stdout: "deployment.apps/nginx created\n",
    stderr: "",
    status: 0,
    error: null,
  })),
}));

import { createApplyTools } from "./index";
import type { VectorStore } from "../../vectorstore";

/**
 * Creates a mock VectorStore for testing.
 * Mirrors the helper in core/kubectl-apply.test.ts.
 */
function createMockVectorStore(
  overrides: Partial<VectorStore> = {}
): VectorStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    similaritySearch: vi.fn().mockResolvedValue([]),
    keywordSearch: vi.fn().mockResolvedValue([]),
    addDocuments: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("createApplyTools", () => {
  let mockVectorStore: VectorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVectorStore = createMockVectorStore({
      keywordSearch: vi.fn().mockResolvedValue([
        {
          id: "1",
          document: "Deployment resource",
          metadata: { kind: "Deployment", apiGroup: "apps" },
        },
      ]),
    });
  });

  it("returns an array with one tool", () => {
    const tools = createApplyTools(mockVectorStore);
    expect(tools).toHaveLength(1);
  });

  it("creates a tool named kubectl_apply", () => {
    const tools = createApplyTools(mockVectorStore);
    expect(tools[0].name).toBe("kubectl_apply");
  });

  it("tool has a description", () => {
    const tools = createApplyTools(mockVectorStore);
    expect(tools[0].description).toBeTruthy();
    expect(tools[0].description).toContain("catalog");
  });

  it("tool invocation calls core kubectlApply with the vectorStore", async () => {
    const tools = createApplyTools(mockVectorStore);
    const applyTool = tools[0];

    const manifest = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-nginx`;

    const result = await applyTool.invoke({ manifest });

    // Core function should have queried the catalog
    expect(mockVectorStore.keywordSearch).toHaveBeenCalledWith(
      "capabilities",
      undefined,
      expect.objectContaining({
        where: { kind: "Deployment", apiGroup: "apps" },
      })
    );

    // Should return the kubectl output string
    expect(result).toContain("created");
  });

  it("returns catalog validation error when vector DB is unreachable", async () => {
    const unreachableStore = createMockVectorStore({
      keywordSearch: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    const tools = createApplyTools(unreachableStore);
    const result = await tools[0].invoke({
      manifest: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: test`,
    });

    // Core function catches the error and returns a structured message
    expect(result).toContain("Catalog validation failed");
  });

  it("returns error message for non-connection errors", async () => {
    const brokenStore = createMockVectorStore({
      keywordSearch: vi.fn().mockRejectedValue(new Error("Invalid query")),
    });

    const tools = createApplyTools(brokenStore);
    const result = await tools[0].invoke({
      manifest: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: test`,
    });

    // Non-connection errors pass through from core
    expect(result).toContain("Invalid query");
  });

  it("returns parse error for invalid YAML", async () => {
    const tools = createApplyTools(mockVectorStore);
    const result = await tools[0].invoke({ manifest: "not: valid: yaml: [" });

    expect(result).toContain("Failed to parse YAML");
  });

  it("returns catalog rejection for unapproved resources", async () => {
    const emptyStore = createMockVectorStore({
      keywordSearch: vi.fn().mockResolvedValue([]),
    });

    const tools = createApplyTools(emptyStore);
    const result = await tools[0].invoke({
      manifest: `apiVersion: v1
kind: Secret
metadata:
  name: test-secret`,
    });

    expect(result).toContain("not in the approved platform catalog");
  });
});
