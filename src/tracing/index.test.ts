/**
 * index.test.ts - Unit tests for tracing module dynamic import fallback
 *
 * Tests the graceful degradation behavior of src/tracing/index.ts when
 * optional OTel SDK packages are absent, and the initialization behavior
 * when they're present.
 *
 * Each test resets the module registry (vi.resetModules) and re-imports
 * the tracing module, since initialization runs at module load time.
 *
 * Mocking strategy:
 * The source uses optional-deps.ts to load optional packages via require().
 * We mock that module (ESM import, interceptable by Vitest) rather than
 * mocking the npm packages directly (CJS require, not interceptable).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock configuration
//
// vi.hoisted() creates state accessible from hoisted vi.mock() factories.
// Each test sets mockConfig before importing the tracing module.
// vi.resetModules() ensures the mock factory re-runs on each fresh import.
// ---------------------------------------------------------------------------

const { mockConfig } = vi.hoisted(() => {
  const traceloopSpy = {
    initialize: vi.fn(),
    withTool: vi.fn((_config: unknown, fn: () => unknown) => fn()),
    forceFlush: vi.fn().mockResolvedValue(undefined),
    getTraceloopTracer: vi.fn(),
  };
  // Use regular functions (not arrows) so they work as constructors with `new`
  const consoleSpanExporterSpy = vi.fn().mockImplementation(function () {});
  const otlpTraceExporterSpy = vi.fn().mockImplementation(function () {});

  return {
    mockConfig: {
      /** Whether loadTraceloop() returns the mock SDK or null */
      traceloopAvailable: true,
      /** Whether loadSdkTraceNode() returns the mock module or null */
      sdkTraceNodeAvailable: true,
      /** Whether loadExporterOtlpProto() returns the mock module or null */
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

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

/** Snapshot of process.env before tests run, restored after each test */
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();

  // Clean tracing-related env vars for deterministic tests
  delete process.env.OTEL_TRACING_ENABLED;
  delete process.env.OTEL_CAPTURE_AI_PAYLOADS;
  delete process.env.OTEL_EXPORTER_TYPE;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  // Reset mock spy state
  mockConfig.traceloopSpy.initialize.mockClear();
  mockConfig.traceloopSpy.withTool.mockClear();
  mockConfig.traceloopSpy.forceFlush.mockClear();
  mockConfig.consoleSpanExporterSpy.mockClear();
  mockConfig.otlpTraceExporterSpy.mockClear();

  // Default: all packages available
  mockConfig.traceloopAvailable = true;
  mockConfig.sdkTraceNodeAvailable = true;
  mockConfig.exporterOtlpProtoAvailable = true;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// SDK packages absent
// ---------------------------------------------------------------------------

describe("SDK packages absent", () => {
  beforeEach(() => {
    mockConfig.traceloopAvailable = false;
    mockConfig.sdkTraceNodeAvailable = false;
    mockConfig.exporterOtlpProtoAvailable = false;
  });

  it("loads without errors when all optional packages are missing", async () => {
    const tracing = await import("./index");
    expect(tracing.withTool).toBeTypeOf("function");
    expect(tracing.getTracer).toBeTypeOf("function");
  });

  it("withTool calls handler directly as passthrough", async () => {
    const tracing = await import("./index");
    const handler = vi.fn().mockResolvedValue("test-result");

    const result = await tracing.withTool({ name: "test_tool" }, handler);

    expect(result).toBe("test-result");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("getTracer returns a tracer with standard OTel methods", async () => {
    const tracing = await import("./index");
    const tracer = tracing.getTracer();

    expect(tracer).toBeDefined();
    expect(tracer.startActiveSpan).toBeTypeOf("function");
    expect(tracer.startSpan).toBeTypeOf("function");
  });

  it("logs warning when OTEL_TRACING_ENABLED=true but SDK absent", async () => {
    process.env.OTEL_TRACING_ENABLED = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("./index");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "@traceloop/node-server-sdk is not installed"
      )
    );
  });

  it("does not log warning when tracing is disabled", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("./index");

    const otelWarnings = warnSpy.mock.calls
      .flat()
      .filter((msg) => typeof msg === "string" && msg.includes("[OTel]"));
    expect(otelWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SDK packages present, tracing disabled
// ---------------------------------------------------------------------------

describe("SDK packages present, tracing disabled", () => {
  it("does not initialize tracing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./index");

    const initMessages = logSpy.mock.calls
      .flat()
      .filter(
        (msg) => typeof msg === "string" && msg.includes("Initializing")
      );
    expect(initMessages).toHaveLength(0);
  });

  it("does not call traceloop.initialize", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./index");

    expect(mockConfig.traceloopSpy.initialize).not.toHaveBeenCalled();
  });

  it("withTool delegates to traceloop (no-op spans without TracerProvider)", async () => {
    const tracing = await import("./index");

    const result = await tracing.withTool(
      { name: "test" },
      async () => "delegated"
    );

    expect(result).toBe("delegated");
    expect(mockConfig.traceloopSpy.withTool).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// SDK packages present, tracing enabled
// ---------------------------------------------------------------------------

describe("SDK packages present, tracing enabled", () => {
  beforeEach(() => {
    process.env.OTEL_TRACING_ENABLED = "true";
  });

  it("calls traceloop.initialize with expected configuration", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./index");

    expect(mockConfig.traceloopSpy.initialize).toHaveBeenCalledOnce();
    expect(mockConfig.traceloopSpy.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: "cluster-whisperer",
        disableBatch: true,
        traceContent: false,
        silenceInitializationMessage: true,
      })
    );
  });

  it("passes exporter to traceloop.initialize", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./index");

    const initCall = mockConfig.traceloopSpy.initialize.mock.calls[0][0];
    expect(initCall.exporter).toBeDefined();
  });

  it("passes ToolDefinitionsProcessor to traceloop.initialize", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./index");

    const initCall = mockConfig.traceloopSpy.initialize.mock.calls[0][0];
    expect(initCall.processor).toBeDefined();
    expect(initCall.processor.constructor.name).toBe(
      "ToolDefinitionsProcessor"
    );
  });

  it("logs initialization messages", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./index");

    const messages = logSpy.mock.calls
      .flat()
      .filter((msg) => typeof msg === "string" && msg.includes("[OTel]"));
    expect(messages).toContainEqual(
      expect.stringContaining("Initializing")
    );
    expect(messages).toContainEqual(
      expect.stringContaining("Tracing enabled")
    );
    expect(messages).toContainEqual(
      expect.stringContaining("OpenLLMetry initialized")
    );
  });

  it("enables content capture when OTEL_CAPTURE_AI_PAYLOADS=true", async () => {
    process.env.OTEL_CAPTURE_AI_PAYLOADS = "true";
    vi.spyOn(console, "log").mockImplementation(() => {});

    const tracing = await import("./index");

    expect(tracing.isCaptureAiPayloads).toBe(true);
    expect(mockConfig.traceloopSpy.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ traceContent: true })
    );
  });
});

// ---------------------------------------------------------------------------
// createSpanExporter edge cases (exercised indirectly via module load)
// ---------------------------------------------------------------------------

describe("createSpanExporter", () => {
  beforeEach(() => {
    process.env.OTEL_TRACING_ENABLED = "true";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("throws when OTLP exporter requested but package missing", async () => {
    process.env.OTEL_EXPORTER_TYPE = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    mockConfig.exporterOtlpProtoAvailable = false;

    await expect(import("./index")).rejects.toThrow(
      "OTEL_EXPORTER_TYPE=otlp requires @opentelemetry/exporter-trace-otlp-proto"
    );
  });

  it("throws when OTLP exporter requested without endpoint", async () => {
    process.env.OTEL_EXPORTER_TYPE = "otlp";

    await expect(import("./index")).rejects.toThrow(
      "OTEL_EXPORTER_OTLP_ENDPOINT is required"
    );
  });

  it("throws when console exporter requested but sdk-trace-node missing", async () => {
    process.env.OTEL_EXPORTER_TYPE = "console";
    mockConfig.sdkTraceNodeAvailable = false;

    await expect(import("./index")).rejects.toThrow(
      "Console exporter requires @opentelemetry/sdk-trace-node"
    );
  });

  it("throws for unsupported exporter type", async () => {
    process.env.OTEL_EXPORTER_TYPE = "invalid";

    await expect(import("./index")).rejects.toThrow(
      'Unsupported OTEL_EXPORTER_TYPE: "invalid"'
    );
  });

  it("creates OTLP exporter with /v1/traces appended", async () => {
    process.env.OTEL_EXPORTER_TYPE = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    await import("./index");

    expect(mockConfig.otlpTraceExporterSpy).toHaveBeenCalledWith({
      url: "http://localhost:4318/v1/traces",
    });
  });

  it("normalizes trailing slash in OTLP endpoint", async () => {
    process.env.OTEL_EXPORTER_TYPE = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/";

    await import("./index");

    expect(mockConfig.otlpTraceExporterSpy).toHaveBeenCalledWith({
      url: "http://localhost:4318/v1/traces",
    });
  });

  it("does not duplicate /v1/traces if already in endpoint", async () => {
    process.env.OTEL_EXPORTER_TYPE = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
      "http://localhost:4318/v1/traces";

    await import("./index");

    expect(mockConfig.otlpTraceExporterSpy).toHaveBeenCalledWith({
      url: "http://localhost:4318/v1/traces",
    });
  });
});

// ---------------------------------------------------------------------------
// isCaptureAiPayloads environment variable handling
// ---------------------------------------------------------------------------

describe("isCaptureAiPayloads", () => {
  it("defaults to false when OTEL_CAPTURE_AI_PAYLOADS is unset", async () => {
    const tracing = await import("./index");
    expect(tracing.isCaptureAiPayloads).toBe(false);
  });

  it("is true when OTEL_CAPTURE_AI_PAYLOADS=true", async () => {
    process.env.OTEL_CAPTURE_AI_PAYLOADS = "true";
    const tracing = await import("./index");
    expect(tracing.isCaptureAiPayloads).toBe(true);
  });

  it("is false for non-true values like 'yes'", async () => {
    process.env.OTEL_CAPTURE_AI_PAYLOADS = "yes";
    const tracing = await import("./index");
    expect(tracing.isCaptureAiPayloads).toBe(false);
  });
});
