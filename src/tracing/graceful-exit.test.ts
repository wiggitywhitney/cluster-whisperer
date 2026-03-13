// ABOUTME: Tests for gracefulExit helper that flushes OTel traces before process.exit().
// ABOUTME: Verifies flush is called when tracing is enabled and skipped when disabled.

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
// gracefulExit tests
// ---------------------------------------------------------------------------

describe("gracefulExit", () => {
  it("calls forceFlush before process.exit when tracing is enabled", async () => {
    process.env.OTEL_TRACING_ENABLED = "true";
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    const tracing = await import("./index");
    await tracing.gracefulExit(1);

    expect(mockConfig.traceloopSpy.forceFlush).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("calls process.exit without forceFlush when tracing is disabled", async () => {
    // Tracing disabled (default — no OTEL_TRACING_ENABLED)
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    const tracing = await import("./index");
    await tracing.gracefulExit(0);

    expect(mockConfig.traceloopSpy.forceFlush).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("still exits if forceFlush throws", async () => {
    process.env.OTEL_TRACING_ENABLED = "true";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockConfig.traceloopSpy.forceFlush.mockRejectedValueOnce(
      new Error("flush failed")
    );

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    const tracing = await import("./index");
    await tracing.gracefulExit(1);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("defaults to exit code 1 when no code is provided", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    const tracing = await import("./index");
    await tracing.gracefulExit();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
