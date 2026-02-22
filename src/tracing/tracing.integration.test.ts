/**
 * tracing.integration.test.ts - Integration tests for the tracing stack
 *
 * Tests the full tracing module interaction: index.ts (initialization) →
 * tool-tracing.ts (withToolTracing) → context-bridge.ts (withAgentTracing).
 *
 * Two scenarios:
 * 1. SDK absent: All tracing functions work without crashes (graceful no-op)
 * 2. SDK present: Tracing initialization works and handlers execute correctly
 *
 * These tests mock optional-deps.ts and the agent investigator module
 * (to avoid loading heavy LangChain dependencies) but test real interactions
 * between the tracing modules.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock configuration
// ---------------------------------------------------------------------------

const { mockConfig } = vi.hoisted(() => {
  const traceloopSpy = {
    initialize: vi.fn(),
    withTool: vi.fn((_config: unknown, fn: () => unknown) => fn()),
    forceFlush: vi.fn().mockResolvedValue(undefined),
    getTraceloopTracer: vi.fn(),
  };
  // Use regular functions so they work as constructors with `new`
  const consoleSpanExporterSpy = vi.fn().mockImplementation(function () {});
  const otlpTraceExporterSpy = vi.fn().mockImplementation(function () {});

  return {
    mockConfig: {
      traceloopAvailable: true,
      sdkTraceNodeAvailable: true,
      exporterOtlpProtoAvailable: true,
      traceloopSpy,
      consoleSpanExporterSpy,
      otlpTraceExporterSpy,
    },
  };
});

vi.mock("./optional-deps", () => ({
  loadTraceloop: () =>
    mockConfig.traceloopAvailable ? mockConfig.traceloopSpy : null,
  loadSdkTraceNode: () =>
    mockConfig.sdkTraceNodeAvailable
      ? { ConsoleSpanExporter: mockConfig.consoleSpanExporterSpy }
      : null,
  loadExporterOtlpProto: () =>
    mockConfig.exporterOtlpProtoAvailable
      ? { OTLPTraceExporter: mockConfig.otlpTraceExporterSpy }
      : null,
}));

// Mock the investigator module to avoid loading LangChain/Anthropic deps
vi.mock("../agent/investigator", () => ({
  ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
}));

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();

  delete process.env.OTEL_TRACING_ENABLED;
  delete process.env.OTEL_CAPTURE_AI_PAYLOADS;
  delete process.env.OTEL_EXPORTER_TYPE;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  mockConfig.traceloopSpy.initialize.mockClear();
  mockConfig.traceloopSpy.withTool.mockClear();
  mockConfig.traceloopSpy.forceFlush.mockClear();
  mockConfig.consoleSpanExporterSpy.mockClear();
  mockConfig.otlpTraceExporterSpy.mockClear();

  mockConfig.traceloopAvailable = true;
  mockConfig.sdkTraceNodeAvailable = true;
  mockConfig.exporterOtlpProtoAvailable = true;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// Integration: SDK absent, full tracing stack
// ---------------------------------------------------------------------------

describe("SDK absent - full tracing stack", () => {
  beforeEach(() => {
    mockConfig.traceloopAvailable = false;
    mockConfig.sdkTraceNodeAvailable = false;
    mockConfig.exporterOtlpProtoAvailable = false;
  });

  it("withToolTracing executes handler and returns result", async () => {
    const { withToolTracing } = await import("./tool-tracing");

    const handler = vi.fn().mockResolvedValue("kubectl-output");
    const traced = withToolTracing(
      { name: "kubectl_get", description: "List Kubernetes resources" },
      handler
    );

    const result = await traced({ resource: "pods" });

    expect(result).toBe("kubectl-output");
    expect(handler).toHaveBeenCalledWith({ resource: "pods" });
  });

  it("withAgentTracing executes function and returns result", async () => {
    const { withAgentTracing } = await import("./context-bridge");

    const result = await withAgentTracing(
      "What pods are running?",
      async () => "investigation-complete"
    );

    expect(result).toBe("investigation-complete");
  });

  it("withAgentTracing propagates errors from the agent function", async () => {
    const { withAgentTracing } = await import("./context-bridge");

    await expect(
      withAgentTracing("test question", async () => {
        throw new Error("Agent failed");
      })
    ).rejects.toThrow("Agent failed");
  });

  it("withMcpRequestTracing executes function and returns result", async () => {
    const { withMcpRequestTracing } = await import("./context-bridge");

    const mcpResult = {
      content: [{ type: "text" as const, text: "Found 3 pods" }],
    };

    const result = await withMcpRequestTracing(
      "kubectl_get",
      { resource: "pods" },
      async () => mcpResult
    );

    expect(result).toEqual(mcpResult);
  });

  it("full flow: withAgentTracing wrapping withToolTracing", async () => {
    const { withAgentTracing } = await import("./context-bridge");
    const { withToolTracing } = await import("./tool-tracing");

    const handler = vi.fn().mockResolvedValue("pod-list");
    const tracedTool = withToolTracing(
      { name: "kubectl_get", description: "List Kubernetes resources" },
      handler
    );

    const result = await withAgentTracing(
      "What pods are running?",
      async () => tracedTool({ resource: "pods" })
    );

    expect(result).toBe("pod-list");
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Integration: SDK present, full tracing stack
// ---------------------------------------------------------------------------

describe("SDK present - full tracing stack", () => {
  beforeEach(() => {
    process.env.OTEL_TRACING_ENABLED = "true";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("initializes tracing and executes withToolTracing handler", async () => {
    const { withToolTracing } = await import("./tool-tracing");

    const handler = vi.fn().mockResolvedValue("kubectl-output");
    const traced = withToolTracing(
      { name: "kubectl_get", description: "List Kubernetes resources" },
      handler
    );

    const result = await traced({ resource: "pods" });

    expect(mockConfig.traceloopSpy.initialize).toHaveBeenCalledOnce();
    expect(result).toBe("kubectl-output");
  });

  it("initializes tracing and executes withAgentTracing", async () => {
    const { withAgentTracing } = await import("./context-bridge");

    const result = await withAgentTracing(
      "What pods are running?",
      async () => "investigation-result"
    );

    expect(mockConfig.traceloopSpy.initialize).toHaveBeenCalledOnce();
    expect(result).toBe("investigation-result");
  });

  it("full flow: agent tracing wrapping tool tracing with initialization", async () => {
    const { withAgentTracing } = await import("./context-bridge");
    const { withToolTracing } = await import("./tool-tracing");

    const handler = vi.fn().mockResolvedValue("pod-list");
    const tracedTool = withToolTracing(
      { name: "kubectl_get", description: "List Kubernetes resources" },
      handler
    );

    const result = await withAgentTracing(
      "What pods are running?",
      async () => tracedTool({ resource: "pods" })
    );

    expect(mockConfig.traceloopSpy.initialize).toHaveBeenCalledOnce();
    expect(result).toBe("pod-list");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("withMcpRequestTracing handles error results without crashing", async () => {
    const { withMcpRequestTracing } = await import("./context-bridge");

    const errorResult = {
      content: [{ type: "text" as const, text: "kubectl: not found" }],
      isError: true,
    };

    const result = await withMcpRequestTracing(
      "kubectl_get",
      { resource: "pods" },
      async () => errorResult
    );

    expect(result).toEqual(errorResult);
  });
});
