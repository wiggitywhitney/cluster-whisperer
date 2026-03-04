// ABOUTME: Unit tests for syncCapabilities OTel span instrumentation
// ABOUTME: Verifies parent/child span tree with pipeline attributes for capability sync

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trace, SpanStatusCode, context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

// ---------------------------------------------------------------------------
// Mock pipeline stage modules — we test span creation, not stage behavior
// ---------------------------------------------------------------------------

vi.mock("./discovery", () => ({
  discoverResources: vi.fn(),
}));
vi.mock("./inference", () => ({
  inferCapabilities: vi.fn(),
}));
vi.mock("./storage", () => ({
  storeCapabilities: vi.fn(),
}));

import { syncCapabilities } from "./runner";
import { discoverResources } from "./discovery";
import { inferCapabilities } from "./inference";
import { storeCapabilities } from "./storage";
import type { VectorStore } from "../vectorstore";

// Cast mocked functions
const mockedDiscover = discoverResources as ReturnType<typeof vi.fn>;
const mockedInfer = inferCapabilities as ReturnType<typeof vi.fn>;
const mockedStore = storeCapabilities as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// OTel test infrastructure — in-memory span exporter captures spans
// ---------------------------------------------------------------------------

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

beforeEach(() => {
  // AsyncLocalStorageContextManager is required for parent-child span propagation
  // across async boundaries (startActiveSpan with async callbacks)
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);

  // Default mock behavior: 2 discovered, 2 inferred, storage succeeds
  mockedDiscover.mockResolvedValue([
    { name: "sqls.devopstoolkit.live", kind: "SQL" },
    { name: "configmaps", kind: "ConfigMap" },
  ]);
  mockedInfer.mockResolvedValue([
    { resourceName: "sqls.devopstoolkit.live" },
    { resourceName: "configmaps" },
  ]);
  mockedStore.mockResolvedValue(undefined);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockVectorStore(): VectorStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    keywordSearch: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function getSpans(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

function getSpanByName(name: string): ReadableSpan | undefined {
  return getSpans().find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// Parent span: cluster-whisperer.pipeline.sync-capabilities
// ---------------------------------------------------------------------------

describe("syncCapabilities parent span", () => {
  it("creates a span named cluster-whisperer.pipeline.sync-capabilities", async () => {
    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-capabilities");
    expect(span).toBeDefined();
  });

  it("sets pipeline.name attribute to sync-capabilities", async () => {
    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-capabilities")!;
    expect(span.attributes["cluster_whisperer.pipeline.name"]).toBe(
      "sync-capabilities"
    );
  });

  it("sets pipeline.dry_run to false when not a dry run", async () => {
    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-capabilities")!;
    expect(span.attributes["cluster_whisperer.pipeline.dry_run"]).toBe(false);
  });

  it("sets pipeline.dry_run to true when dry run", async () => {
    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      dryRun: true,
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-capabilities")!;
    expect(span.attributes["cluster_whisperer.pipeline.dry_run"]).toBe(true);
  });

  it("sets discovered_count attribute from discovery results", async () => {
    mockedDiscover.mockResolvedValue([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ]);
    mockedInfer.mockResolvedValue([]);

    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-capabilities")!;
    expect(span.attributes["cluster_whisperer.pipeline.discovered_count"]).toBe(3);
  });

  it("sets inferred_count attribute from inference results", async () => {
    mockedDiscover.mockResolvedValue([{ name: "a" }]);
    mockedInfer.mockResolvedValue([
      { resourceName: "a" },
      { resourceName: "b" },
    ]);

    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-capabilities")!;
    expect(span.attributes["cluster_whisperer.pipeline.inferred_count"]).toBe(2);
  });

  it("sets stored_count attribute from storage results", async () => {
    mockedDiscover.mockResolvedValue([{ name: "a" }]);
    mockedInfer.mockResolvedValue([{ resourceName: "a" }]);

    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-capabilities")!;
    expect(span.attributes["cluster_whisperer.pipeline.stored_count"]).toBe(1);
  });

  it("sets stored_count to 0 when dry run", async () => {
    mockedDiscover.mockResolvedValue([{ name: "a" }]);
    mockedInfer.mockResolvedValue([{ resourceName: "a" }]);

    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      dryRun: true,
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-capabilities")!;
    expect(span.attributes["cluster_whisperer.pipeline.stored_count"]).toBe(0);
  });

  it("sets OK status on success", async () => {
    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-capabilities")!;
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("sets ERROR status and records exception on failure", async () => {
    mockedDiscover.mockRejectedValue(new Error("kubectl not found"));

    await expect(
      syncCapabilities({
        vectorStore: createMockVectorStore(),
        onProgress: () => {},
      })
    ).rejects.toThrow("kubectl not found");

    const span = getSpanByName("cluster-whisperer.pipeline.sync-capabilities")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toContain("kubectl not found");
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Child stage spans
// ---------------------------------------------------------------------------

describe("syncCapabilities child stage spans", () => {
  it("creates a discovery child span", async () => {
    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.discovery");
    expect(span).toBeDefined();
    expect(span!.attributes["cluster_whisperer.pipeline.stage"]).toBe("discovery");
  });

  it("creates an inference child span", async () => {
    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.inference");
    expect(span).toBeDefined();
    expect(span!.attributes["cluster_whisperer.pipeline.stage"]).toBe("inference");
  });

  it("creates a storage child span when not dry run", async () => {
    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.storage");
    expect(span).toBeDefined();
    expect(span!.attributes["cluster_whisperer.pipeline.stage"]).toBe("storage");
  });

  it("does not create a storage child span when dry run", async () => {
    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      dryRun: true,
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.storage");
    expect(span).toBeUndefined();
  });

  it("child spans are parented to the pipeline span", async () => {
    await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const parent = getSpanByName("cluster-whisperer.pipeline.sync-capabilities")!;
    const discovery = getSpanByName("cluster-whisperer.pipeline.discovery")!;
    const inference = getSpanByName("cluster-whisperer.pipeline.inference")!;
    const storage = getSpanByName("cluster-whisperer.pipeline.storage")!;

    const parentSpanId = parent.spanContext().spanId;
    expect(discovery.parentSpanContext?.spanId).toBe(parentSpanId);
    expect(inference.parentSpanContext?.spanId).toBe(parentSpanId);
    expect(storage.parentSpanContext?.spanId).toBe(parentSpanId);
  });

  it("sets ERROR status on stage span when stage fails", async () => {
    mockedInfer.mockRejectedValue(new Error("LLM unavailable"));

    await expect(
      syncCapabilities({
        vectorStore: createMockVectorStore(),
        onProgress: () => {},
      })
    ).rejects.toThrow("LLM unavailable");

    // Discovery should succeed
    const discovery = getSpanByName("cluster-whisperer.pipeline.discovery")!;
    expect(discovery.status.code).toBe(SpanStatusCode.OK);

    // Inference should be ERROR
    const inference = getSpanByName("cluster-whisperer.pipeline.inference")!;
    expect(inference.status.code).toBe(SpanStatusCode.ERROR);
    expect(inference.events.some((e) => e.name === "exception")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No-op tracer (tracing disabled)
// ---------------------------------------------------------------------------

describe("syncCapabilities no-op tracer (tracing disabled)", () => {
  beforeEach(async () => {
    // Disable provider to simulate no-op tracer
    await provider.shutdown();
    trace.disable();
  });

  it("functions correctly without spans when tracing is disabled", async () => {
    const result = await syncCapabilities({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    expect(result.discovered).toBe(2);
    expect(result.inferred).toBe(2);
    expect(result.stored).toBe(2);

    // No spans should be exported when tracing is disabled
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
