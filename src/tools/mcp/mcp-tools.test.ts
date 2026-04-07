// ABOUTME: Unit tests for MCP tool registration — covers native kubectl and apply tool registration
// ABOUTME: Tests the MCP wrapper layer that exposes tools to MCP clients (kubectl_get, describe, logs, vector_search, apply, apply_dryrun)

/**
 * Tests for MCP tool registration
 *
 * These tests verify that MCP tools are registered correctly with the
 * McpServer. They don't test the full MCP protocol — just that our
 * registration code passes the right metadata and handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mcpModule from "./index";
import { SessionStore } from "./session-store";

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
  registerDryrunTool,
  registerGetTool,
  registerDescribeTool,
  registerLogsTool,
  registerVectorSearchTool,
  registerInvestigatePrompt,
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
  const registeredPrompts: Map<
    string,
    { config: unknown; handler: Function }
  > = new Map();

  return {
    registerTool: vi.fn(
      (name: string, metadata: unknown, handler: Function) => {
        registeredTools.set(name, { metadata, handler });
      }
    ),
    registerPrompt: vi.fn(
      (name: string, config: unknown, handler: Function) => {
        registeredPrompts.set(name, { config, handler });
      }
    ),
    registeredTools,
    registeredPrompts,
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

    // vectorSearch catches errors internally and returns a descriptive string (not an MCP error)
    // so the AI can read the message and gracefully try kubectl tools instead
    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringContaining("failed") }],
      isError: false,
    });
  });
});

describe("registerDryrunTool", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let sessionStore: SessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
    sessionStore = new SessionStore();
  });

  it("registers a tool named kubectl_apply_dryrun", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerDryrunTool(mockServer as any, sessionStore);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      "kubectl_apply_dryrun",
      expect.objectContaining({
        description: expect.stringContaining("dry-run"),
      }),
      expect.any(Function)
    );
  });

  it("handler returns sessionId and output on successful dry-run", async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      stdout: "managedservice.platform.acme.io/youchoose-db configured (dry run)\n",
      stderr: "",
      status: 0,
      error: null,
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerDryrunTool(mockServer as any, sessionStore);
    const handler = mockServer.registeredTools.get("kubectl_apply_dryrun")!.handler;

    const result = await handler({
      manifest: "apiVersion: platform.acme.io/v1alpha1\nkind: ManagedService\nmetadata:\n  name: youchoose-db",
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("sessionId");
  });

  it("handler returns isError: true when dry-run fails", async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      stdout: "",
      stderr: "Error from server: admission webhook rejected",
      status: 1,
      error: null,
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerDryrunTool(mockServer as any, sessionStore);
    const handler = mockServer.registeredTools.get("kubectl_apply_dryrun")!.handler;

    const result = await handler({
      manifest: "apiVersion: platform.acme.io/v1alpha1\nkind: ManagedService\nmetadata:\n  name: test",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rejected");
  });
});

describe("registerApplyTool", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let mockVectorStore: VectorStore;
  let sessionStore: SessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
    sessionStore = new SessionStore();
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
    registerApplyTool(mockServer as any, mockVectorStore, sessionStore);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      "kubectl_apply",
      expect.objectContaining({
        description: expect.stringContaining("sessionId"),
      }),
      expect.any(Function)
    );
  });

  it("handler returns success when sessionId is valid and catalog approves", async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      stdout: "managedservice.platform.acme.io/youchoose-db created\n",
      stderr: "",
      status: 0,
      error: null,
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    // Pre-populate session store with a manifest
    const manifest = `apiVersion: platform.acme.io/v1alpha1
kind: ManagedService
metadata:
  name: youchoose-db`;
    const sessionId = sessionStore.store(manifest);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerApplyTool(mockServer as any, mockVectorStore, sessionStore);
    const handler = mockServer.registeredTools.get("kubectl_apply")!.handler;

    const result = await handler({ sessionId });

    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringContaining("created") }],
      isError: false,
    });
  });

  it("handler returns isError: true when sessionId is not found", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerApplyTool(mockServer as any, mockVectorStore, sessionStore);
    const handler = mockServer.registeredTools.get("kubectl_apply")!.handler;

    const result = await handler({ sessionId: "nonexistent-session-id" });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("kubectl_apply_dryrun"),
        },
      ],
      isError: true,
    });
  });

  it("handler returns isError: true when sessionId is already consumed", async () => {
    const manifest = `apiVersion: platform.acme.io/v1alpha1
kind: ManagedService
metadata:
  name: youchoose-db`;
    const sessionId = sessionStore.store(manifest);
    sessionStore.consume(sessionId); // consume it manually

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerApplyTool(mockServer as any, mockVectorStore, sessionStore);
    const handler = mockServer.registeredTools.get("kubectl_apply")!.handler;

    const result = await handler({ sessionId });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kubectl_apply_dryrun");
  });

  it("handler returns isError: true for catalog rejection", async () => {
    const emptyStore = createMockVectorStore({
      keywordSearch: vi.fn().mockResolvedValue([]),
    });

    // Use a custom-group manifest (passes built-in guard, fails catalog check)
    const manifest = `apiVersion: widgets.example.com/v1beta1
kind: Widget
metadata:
  name: test-widget`;
    const sessionId = sessionStore.store(manifest);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerApplyTool(mockServer as any, emptyStore, sessionStore);
    const handler = mockServer.registeredTools.get("kubectl_apply")!.handler;

    const result = await handler({ sessionId });

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

  it("session is consumed after successful apply (single-use)", async () => {
    vi.mocked(spawnSync).mockReturnValue({
      stdout: "created\n",
      stderr: "",
      status: 0,
      error: null,
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    const manifest = `apiVersion: platform.acme.io/v1alpha1
kind: ManagedService
metadata:
  name: youchoose-db`;
    const sessionId = sessionStore.store(manifest);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerApplyTool(mockServer as any, mockVectorStore, sessionStore);
    const handler = mockServer.registeredTools.get("kubectl_apply")!.handler;

    await handler({ sessionId }); // first apply
    const secondResult = await handler({ sessionId }); // second apply — session consumed

    expect(secondResult.isError).toBe(true);
    expect(secondResult.content[0].text).toContain("kubectl_apply_dryrun");
  });
});

describe("registerInvestigatePrompt", () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
  });

  it("registers a prompt named investigate-cluster", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerInvestigatePrompt(mockServer as any, "# Investigation Strategy\n\nUse kubectl tools.");

    expect(mockServer.registerPrompt).toHaveBeenCalledWith(
      "investigate-cluster",
      expect.objectContaining({
        description: expect.any(String),
      }),
      expect.any(Function)
    );
  });

  it("prompt callback returns messages containing the provided content", async () => {
    const content = "# Investigation Strategy\n\nStart with kubectl_get pods.";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerInvestigatePrompt(mockServer as any, content);
    const handler = mockServer.registeredPrompts.get("investigate-cluster")!.handler;

    const result = await handler();

    expect(result).toEqual({
      messages: [
        {
          role: "user",
          content: { type: "text", text: content },
        },
      ],
    });
  });

  it("prompt description mentions investigation strategy", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerInvestigatePrompt(mockServer as any, "some content");

    const config = mockServer.registerPrompt.mock.calls[0]?.[1] as { description: string };
    expect(config.description.toLowerCase()).toContain("investigat");
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
