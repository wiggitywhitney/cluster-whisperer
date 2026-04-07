// ABOUTME: Unit tests for MCP tool registration — covers investigate and apply tool registration
// ABOUTME: Tests the MCP wrapper layer that exposes tools to MCP clients

/**
 * Tests for MCP tool registration
 *
 * These tests verify that MCP tools are registered correctly with the
 * McpServer. They don't test the full MCP protocol — just that our
 * registration code passes the right metadata and handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the investigator module
vi.mock("../../agent/investigator", () => ({
  invokeInvestigator: vi.fn().mockResolvedValue({
    answer: "Test answer",
    thinking: [],
    isError: false,
  }),
}));

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
    stdout: "managedservice.platform.acme.io/youchoose-db created\n",
    stderr: "",
    status: 0,
    error: null,
  })),
}));

import { registerApplyTool } from "./index";

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

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
  });

  it("registers a tool named kubectl_apply", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerApplyTool(mockServer as any);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      "kubectl_apply",
      expect.objectContaining({
        description: expect.any(String),
      }),
      expect.any(Function)
    );
  });

  it("handler returns MCP-formatted response on success", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerApplyTool(mockServer as any);

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

  it("handler returns isError: true when kubectl fails", async () => {
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerApplyTool(mockServer as any);

    const handler = mockServer.registeredTools.get("kubectl_apply")!.handler;
    const result = await handler({
      manifest: `apiVersion: v1
kind: ConfigMap
metadata:
  name: test-config`,
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("admission webhook"),
        },
      ],
      isError: true,
    });
  });
});
