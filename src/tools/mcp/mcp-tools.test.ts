// ABOUTME: Unit tests for MCP tool registration — covers native kubectl and apply tool registration
// ABOUTME: Tests the MCP wrapper layer that exposes tools to MCP clients

/**
 * Tests for MCP tool registration
 *
 * These tests verify that MCP tools are registered correctly with the
 * McpServer. They don't test the full MCP protocol — just that our
 * registration code passes the right metadata and handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mcpModule from "./index";

// Mock the tracing modules
vi.mock("../../tracing/context-bridge", () => ({
  withMcpRequestTracing: (
    _name: string,
    _input: unknown,
    fn: () => unknown
  ) => fn(),
  setTraceOutput: vi.fn(),
}));

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

vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({
    stdout: "deployment.apps/nginx created\n",
    stderr: "",
    status: 0,
    error: null,
  })),
}));

import { registerApplyTool } from "./index";
import type { VectorStore } from "../../vectorstore";

/**
 * Creates a mock VectorStore for testing.
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

/**
 * Creates a mock McpServer that captures tool registrations.
 */
function createMockServer() {
  const registeredTools: Map<
    string,
    { metadata: unknown; handler: Function }
  > = new Map();

  return {
    registerTool: vi.fn(
      (name: string, metadata: unknown, handler: Function) => {
        registeredTools.set(name, { metadata, handler });
      }
    ),
    registeredTools,
  };
}

describe("registerApplyTool", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let mockVectorStore: VectorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
    mockVectorStore = createMockVectorStore({
      keywordSearch: vi.fn().mockResolvedValue([
        {
          id: "1",
          document: "ManagedService resource",
          metadata: { kind: "ManagedService", apiGroup: "platform.acme.io" },
        },
      ]),
    });
  });

  it("registers a tool named kubectl_apply", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerApplyTool(mockServer as any, mockVectorStore);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      "kubectl_apply",
      expect.objectContaining({
        description: expect.stringContaining("catalog"),
      }),
      expect.any(Function)
    );
  });

  it("handler returns MCP-formatted response on success", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerApplyTool(mockServer as any, mockVectorStore);

    const handler = mockServer.registeredTools.get("kubectl_apply")!.handler;
    const result = await handler({
      manifest: `apiVersion: platform.acme.io/v1alpha1
kind: ManagedService
metadata:
  name: youchoose-db`,
    });

    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringContaining("created") }],
      isError: false,
    });
  });

  it("handler returns isError: true for catalog rejection", async () => {
    const emptyStore = createMockVectorStore({
      keywordSearch: vi.fn().mockResolvedValue([]),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerApplyTool(mockServer as any, emptyStore);

    const handler = mockServer.registeredTools.get("kubectl_apply")!.handler;
    const result = await handler({
      manifest: `apiVersion: widgets.example.com/v1beta1
kind: Widget
metadata:
  name: test-widget`,
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("not in the approved platform catalog"),
        },
      ],
      isError: true,
    });
  });
});

describe("MCP module exports", () => {
  it("does not export registerInvestigateTool (investigate wrapper removed in PRD #120 M2)", () => {
    // The investigate tool wrapped the LangGraph agent — removed so the MCP
    // server exposes native kubectl tools instead. This test ensures the
    // wrapper is gone and cannot be accidentally re-added.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mcpModule as any).registerInvestigateTool).toBeUndefined();
  });
});
