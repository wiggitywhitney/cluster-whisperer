// ABOUTME: Unit tests for syncInstances OTel span instrumentation
// ABOUTME: Verifies parent/child span tree with pipeline attributes for instance sync

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

vi.mock("./instance-discovery", () => ({
  discoverInstances: vi.fn(),
}));
vi.mock("./instance-storage", () => ({
  storeInstances: vi.fn(),
}));

import { syncInstances } from "./instance-runner";
import { discoverInstances } from "./instance-discovery";
import { storeInstances } from "./instance-storage";
import type { VectorStore } from "../vectorstore";

// Cast mocked functions
const mockedDiscover = discoverInstances as ReturnType<typeof vi.fn>;
const mockedStore = storeInstances as ReturnType<typeof vi.fn>;

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

  // Default mock behavior: 2 discovered, storage succeeds
  mockedDiscover.mockResolvedValue([
    { id: "default/apps/v1/Deployment/nginx", name: "nginx" },
    { id: "default/v1/Service/redis", name: "redis" },
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

function createMockVectorStore(): VectorStore & {
  initialize: ReturnType<typeof vi.fn>;
  keywordSearch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
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
// Parent span: cluster-whisperer.pipeline.sync-instances
// ---------------------------------------------------------------------------

describe("syncInstances parent span", () => {
  it("creates a span named cluster-whisperer.pipeline.sync-instances", async () => {
    await syncInstances({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-instances");
    expect(span).toBeDefined();
  });

  it("sets pipeline.name attribute to sync-instances", async () => {
    await syncInstances({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-instances")!;
    expect(span.attributes["cluster_whisperer.pipeline.name"]).toBe(
      "sync-instances"
    );
  });

  it("sets pipeline.dry_run to false when not a dry run", async () => {
    await syncInstances({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-instances")!;
    expect(span.attributes["cluster_whisperer.pipeline.dry_run"]).toBe(false);
  });

  it("sets pipeline.dry_run to true when dry run", async () => {
    await syncInstances({
      vectorStore: createMockVectorStore(),
      dryRun: true,
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-instances")!;
    expect(span.attributes["cluster_whisperer.pipeline.dry_run"]).toBe(true);
  });

  it("sets discovered_count attribute from discovery results", async () => {
    mockedDiscover.mockResolvedValue([
      { id: "a", name: "a" },
      { id: "b", name: "b" },
      { id: "c", name: "c" },
    ]);

    await syncInstances({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-instances")!;
    expect(span.attributes["cluster_whisperer.pipeline.discovered_count"]).toBe(3);
  });

  it("sets stored_count attribute from storage results", async () => {
    mockedDiscover.mockResolvedValue([
      { id: "a", name: "a" },
      { id: "b", name: "b" },
    ]);

    await syncInstances({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-instances")!;
    expect(span.attributes["cluster_whisperer.pipeline.stored_count"]).toBe(2);
  });

  it("sets deleted_count attribute from stale cleanup", async () => {
    mockedDiscover.mockResolvedValue([
      { id: "default/apps/v1/Deployment/nginx", name: "nginx" },
    ]);
    const mockVectorStore = createMockVectorStore();
    // DB has nginx + stale doc
    mockVectorStore.keywordSearch.mockResolvedValue([
      { id: "default/apps/v1/Deployment/nginx", text: "", metadata: {}, score: -1 },
      { id: "default/apps/v1/Deployment/old", text: "", metadata: {}, score: -1 },
    ]);

    await syncInstances({
      vectorStore: mockVectorStore,
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-instances")!;
    expect(span.attributes["cluster_whisperer.pipeline.deleted_count"]).toBe(1);
  });

  it("sets stored_count to 0 and deleted_count to 0 when dry run", async () => {
    await syncInstances({
      vectorStore: createMockVectorStore(),
      dryRun: true,
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-instances")!;
    expect(span.attributes["cluster_whisperer.pipeline.stored_count"]).toBe(0);
    expect(span.attributes["cluster_whisperer.pipeline.deleted_count"]).toBe(0);
  });

  it("sets OK status on success", async () => {
    await syncInstances({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.sync-instances")!;
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("sets ERROR status and records exception on failure", async () => {
    mockedDiscover.mockRejectedValue(new Error("kubectl not found"));

    await expect(
      syncInstances({
        vectorStore: createMockVectorStore(),
        onProgress: () => {},
      })
    ).rejects.toThrow("kubectl not found");

    const span = getSpanByName("cluster-whisperer.pipeline.sync-instances")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toContain("kubectl not found");
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Child stage spans
// ---------------------------------------------------------------------------

describe("syncInstances child stage spans", () => {
  it("creates a discovery child span", async () => {
    await syncInstances({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.discovery");
    expect(span).toBeDefined();
    expect(span!.attributes["cluster_whisperer.pipeline.stage"]).toBe("discovery");
  });

  it("creates a stale-cleanup child span when not dry run", async () => {
    await syncInstances({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.stale-cleanup");
    expect(span).toBeDefined();
    expect(span!.attributes["cluster_whisperer.pipeline.stage"]).toBe("stale-cleanup");
  });

  it("creates a storage child span when not dry run", async () => {
    await syncInstances({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const span = getSpanByName("cluster-whisperer.pipeline.storage");
    expect(span).toBeDefined();
    expect(span!.attributes["cluster_whisperer.pipeline.stage"]).toBe("storage");
  });

  it("does not create stale-cleanup or storage child spans when dry run", async () => {
    await syncInstances({
      vectorStore: createMockVectorStore(),
      dryRun: true,
      onProgress: () => {},
    });

    expect(getSpanByName("cluster-whisperer.pipeline.stale-cleanup")).toBeUndefined();
    expect(getSpanByName("cluster-whisperer.pipeline.storage")).toBeUndefined();
  });

  it("child spans are parented to the pipeline span", async () => {
    await syncInstances({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    const parent = getSpanByName("cluster-whisperer.pipeline.sync-instances")!;
    const discovery = getSpanByName("cluster-whisperer.pipeline.discovery")!;
    const staleCleanup = getSpanByName("cluster-whisperer.pipeline.stale-cleanup")!;
    const storage = getSpanByName("cluster-whisperer.pipeline.storage")!;

    const parentSpanId = parent.spanContext().spanId;
    expect(discovery.parentSpanContext?.spanId).toBe(parentSpanId);
    expect(staleCleanup.parentSpanContext?.spanId).toBe(parentSpanId);
    expect(storage.parentSpanContext?.spanId).toBe(parentSpanId);
  });

  it("sets ERROR status on stage span when stage fails", async () => {
    mockedDiscover.mockRejectedValue(new Error("kubectl timeout"));

    await expect(
      syncInstances({
        vectorStore: createMockVectorStore(),
        onProgress: () => {},
      })
    ).rejects.toThrow("kubectl timeout");

    // Discovery should be ERROR
    const discovery = getSpanByName("cluster-whisperer.pipeline.discovery")!;
    expect(discovery.status.code).toBe(SpanStatusCode.ERROR);
    expect(discovery.events.some((e) => e.name === "exception")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No-op tracer (tracing disabled)
// ---------------------------------------------------------------------------

describe("syncInstances no-op tracer (tracing disabled)", () => {
  beforeEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it("functions correctly without spans when tracing is disabled", async () => {
    const result = await syncInstances({
      vectorStore: createMockVectorStore(),
      onProgress: () => {},
    });

    expect(result.discovered).toBe(2);
    expect(result.stored).toBe(2);
    expect(result.deleted).toBe(0);
  });
});
