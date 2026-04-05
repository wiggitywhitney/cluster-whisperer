// ABOUTME: Unit tests for MCP tool registration — covers native kubectl and apply tool registration
// ABOUTME: Tests the MCP wrapper layer that exposes tools to MCP clients (kubectl_get, describe, logs, vector_search, apply)

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

import { spawnSync } from "child_process";
import {
  registerApplyTool,
  registerGetTool,
  registerDescribeTool,
  registerLogsTool,
  registerVectorSearchTool,
} from "./index";
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

describe("registerGetTool", () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
  });

  it("registers a tool named kubectl_get", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerGetTool(mockServer as any);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      "kubectl_get",
      expect.objectContaining({
        description: expect.any(String),
      }),
      expect.any(Function)
    );
  });

  it("handler returns pod list on success", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerGetTool(mockServer as any);
    const handler = mockServer.registeredTools.get("kubectl_get")!.handler;

    vi.mocked(spawnSync).mockReturnValueOnce({
      stdout: "NAME     READY   STATUS    RESTARTS   AGE\nnginx    1/1     Running   0          5d\n",
      stderr: "",
      status: 0,
      error: null,
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    const result = await handler({ resource: "pods" });

    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringContaining("nginx") }],
      isError: false,
    });
  });

  it("handler returns isError: true when kubectl fails", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerGetTool(mockServer as any);
    const handler = mockServer.registeredTools.get("kubectl_get")!.handler;

    vi.mocked(spawnSync).mockReturnValueOnce({
      stdout: "",
      stderr: "Error from server (NotFound): pods not found",
      status: 1,
      error: null,
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    const result = await handler({ resource: "pods" });

    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringContaining("Error") }],
      isError: true,
    });
  });
});

describe("registerDescribeTool", () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
  });

  it("registers a tool named kubectl_describe", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerDescribeTool(mockServer as any);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      "kubectl_describe",
      expect.objectContaining({
        description: expect.any(String),
      }),
      expect.any(Function)
    );
  });

  it("handler returns resource details on success", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerDescribeTool(mockServer as any);
    const handler = mockServer.registeredTools.get("kubectl_describe")!.handler;

    vi.mocked(spawnSync).mockReturnValueOnce({
      stdout: "Name:         nginx\nNamespace:    default\nEvents:\n  Normal  Scheduled  5d  default-scheduler  Successfully assigned\n",
      stderr: "",
      status: 0,
      error: null,
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    const result = await handler({ resource: "pod", name: "nginx" });

    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringContaining("nginx") }],
      isError: false,
    });
  });
});

describe("registerLogsTool", () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
  });

  it("registers a tool named kubectl_logs", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerLogsTool(mockServer as any);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      "kubectl_logs",
      expect.objectContaining({
        description: expect.any(String),
      }),
      expect.any(Function)
    );
  });

  it("handler returns log output on success", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerLogsTool(mockServer as any);
    const handler = mockServer.registeredTools.get("kubectl_logs")!.handler;

    vi.mocked(spawnSync).mockReturnValueOnce({
      stdout: "2026-04-05T10:00:00Z INFO Server started\n2026-04-05T10:00:01Z ERROR connection refused\n",
      stderr: "",
      status: 0,
      error: null,
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    const result = await handler({ pod: "nginx", namespace: "default" });

    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringContaining("Server started") }],
      isError: false,
    });
  });
});

describe("registerVectorSearchTool", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let mockVectorStore: VectorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
    mockVectorStore = createMockVectorStore({
      keywordSearch: vi.fn().mockResolvedValue([
        {
          id: "platform.acme.io/v1alpha1/ManagedService",
          text: "ManagedService resource for provisioning databases",
          metadata: { kind: "ManagedService", apiGroup: "platform.acme.io" },
          score: -1,
        },
      ]),
    });
  });

  it("registers a tool named vector_search", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerVectorSearchTool(mockServer as any, mockVectorStore);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      "vector_search",
      expect.objectContaining({
        description: expect.any(String),
      }),
      expect.any(Function)
    );
  });

  it("handler returns search results on success", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerVectorSearchTool(mockServer as any, mockVectorStore);
    const handler = mockServer.registeredTools.get("vector_search")!.handler;

    const result = await handler({ keyword: "database", collection: "capabilities" });

    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringContaining("ManagedService") }],
      isError: false,
    });
  });

  it("handler returns isError: true when search fails", async () => {
    const failingStore = createMockVectorStore({
      keywordSearch: vi.fn().mockRejectedValue(new Error("Chroma connection refused")),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerVectorSearchTool(mockServer as any, failingStore);
    const handler = mockServer.registeredTools.get("vector_search")!.handler;

    const result = await handler({ keyword: "database", collection: "capabilities" });

    // vector_search catches errors internally and returns an error string
    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringContaining("failed") }],
      isError: false,
    });
  });
});

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
