// ABOUTME: Unit tests for ChromaBackend OTel span instrumentation
// ABOUTME: Verifies each method creates spans with correct DB semconv and custom attributes

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trace, SpanKind, SpanStatusCode, context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import type { EmbeddingFunction } from "./types";
// Pre-import the module under test at the top level to avoid slow dynamic imports.
// The vi.mock("chromadb") above is hoisted, so this import gets the mocked version.
import { ChromaBackend } from "./chroma-backend";

// ---------------------------------------------------------------------------
// Mock chromadb module — we test span creation, not Chroma behavior
// ---------------------------------------------------------------------------

const { mockCollection } = vi.hoisted(() => {
  const mockCollection = {
    upsert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({
      ids: [["doc-1", "doc-2"]],
      documents: [["text-1", "text-2"]],
      metadatas: [[{ kind: "Deployment" }, { kind: "Service" }]],
      distances: [[0.1, 0.3]],
    }),
    get: vi.fn().mockResolvedValue({
      ids: ["doc-1"],
      documents: ["text-1"],
      metadatas: [{ kind: "Deployment" }],
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return { mockCollection };
});

vi.mock("chromadb", () => {
  // Use a regular function (not arrow) so it works as a constructor with `new`
  const MockChromaClient = vi.fn().mockImplementation(function () {
    // @ts-expect-error — mock instance property
    this.getOrCreateCollection = vi.fn().mockResolvedValue(mockCollection);
  });
  return { ChromaClient: MockChromaClient };
});

// ---------------------------------------------------------------------------
// OTel test infrastructure — in-memory span exporter captures spans for assertions
// ---------------------------------------------------------------------------

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  // Register as global so getTracer() in the module under test uses our provider
  trace.setGlobalTracerProvider(provider);

  // Reset mocks
  mockCollection.upsert.mockClear();
  mockCollection.query.mockClear();
  mockCollection.get.mockClear();
  mockCollection.delete.mockClear();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  // Reset active context to prevent parent-child leakage between tests
  context.disable();
});

// ---------------------------------------------------------------------------
// Helper: create a ChromaBackend with mock embedder
// ---------------------------------------------------------------------------

function createMockEmbedder(): EmbeddingFunction {
  return {
    embed: vi.fn().mockResolvedValue([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]),
  };
}

async function createInitializedBackend(embedder?: EmbeddingFunction) {
  const emb = embedder ?? createMockEmbedder();
  const backend = new ChromaBackend(emb, { chromaUrl: "http://localhost:8000" });
  await backend.initialize("test-collection", { distanceMetric: "cosine" });
  return { backend, embedder: emb };
}

/**
 * Gets all finished spans from the in-memory exporter.
 */
function getSpans(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

function getSpanByName(name: string): ReadableSpan | undefined {
  return getSpans().find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// initialize() span
// ---------------------------------------------------------------------------

describe("initialize() span", () => {
  it("creates a span named cluster-whisperer.vectorstore.initialize", async () => {
    await createInitializedBackend();

    const span = getSpanByName("cluster-whisperer.vectorstore.initialize");
    expect(span).toBeDefined();
  });

  it("sets span kind to CLIENT", async () => {
    await createInitializedBackend();

    const span = getSpanByName("cluster-whisperer.vectorstore.initialize")!;
    expect(span.kind).toBe(SpanKind.CLIENT);
  });

  it("sets DB semconv attributes", async () => {
    await createInitializedBackend();

    const span = getSpanByName("cluster-whisperer.vectorstore.initialize")!;
    expect(span.attributes["db.system"]).toBe("chromadb");
    expect(span.attributes["db.operation.name"]).toBe("get_or_create_collection");
    expect(span.attributes["db.collection.name"]).toBe("test-collection");
  });

  it("sets span status to OK on success", async () => {
    await createInitializedBackend();

    const span = getSpanByName("cluster-whisperer.vectorstore.initialize")!;
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("sets span status to ERROR on failure", async () => {
    const { ChromaClient } = await import("chromadb");
    vi.mocked(ChromaClient).mockImplementationOnce(function () {
      // @ts-expect-error — mock instance property
      this.getOrCreateCollection = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));
    } as never);

    const embedder = createMockEmbedder();
    const backend = new ChromaBackend(embedder, {
      chromaUrl: "http://localhost:8000",
    });

    await expect(
      backend.initialize("test-collection", { distanceMetric: "cosine" })
    ).rejects.toThrow("Connection refused");

    const span = getSpanByName("cluster-whisperer.vectorstore.initialize")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("Connection refused");
    expect(span.events.length).toBeGreaterThan(0); // recordException creates an event
  });
});

// ---------------------------------------------------------------------------
// store() span
// ---------------------------------------------------------------------------

describe("store() span", () => {
  it("creates a span named cluster-whisperer.vectorstore.store", async () => {
    const { backend } = await createInitializedBackend();

    await backend.store("test-collection", [
      { id: "doc-1", text: "hello", metadata: { kind: "Pod" } },
    ]);

    const span = getSpanByName("cluster-whisperer.vectorstore.store");
    expect(span).toBeDefined();
  });

  it("sets DB semconv attributes", async () => {
    const { backend } = await createInitializedBackend();

    await backend.store("test-collection", [
      { id: "doc-1", text: "hello", metadata: { kind: "Pod" } },
    ]);

    const span = getSpanByName("cluster-whisperer.vectorstore.store")!;
    expect(span.attributes["db.system"]).toBe("chromadb");
    expect(span.attributes["db.operation.name"]).toBe("upsert");
    expect(span.attributes["db.collection.name"]).toBe("test-collection");
  });

  it("sets document_count custom attribute", async () => {
    const { backend } = await createInitializedBackend();

    await backend.store("test-collection", [
      { id: "doc-1", text: "hello", metadata: { kind: "Pod" } },
      { id: "doc-2", text: "world", metadata: { kind: "Service" } },
    ]);

    const span = getSpanByName("cluster-whisperer.vectorstore.store")!;
    expect(span.attributes["cluster_whisperer.vectorstore.document_count"]).toBe(2);
  });

  it("sets span kind to CLIENT", async () => {
    const { backend } = await createInitializedBackend();

    await backend.store("test-collection", [
      { id: "doc-1", text: "hello", metadata: { kind: "Pod" } },
    ]);

    const span = getSpanByName("cluster-whisperer.vectorstore.store")!;
    expect(span.kind).toBe(SpanKind.CLIENT);
  });

  it("does not create a span for empty document array", async () => {
    const { backend } = await createInitializedBackend();

    await backend.store("test-collection", []);

    const span = getSpanByName("cluster-whisperer.vectorstore.store");
    expect(span).toBeUndefined();
  });

  it("sets span status to ERROR on failure", async () => {
    const { backend } = await createInitializedBackend();
    mockCollection.upsert.mockRejectedValueOnce(new Error("Chroma upsert failed"));

    await expect(
      backend.store("test-collection", [
        { id: "doc-1", text: "hello", metadata: { kind: "Pod" } },
      ])
    ).rejects.toThrow("Chroma upsert failed");

    const span = getSpanByName("cluster-whisperer.vectorstore.store")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});

// ---------------------------------------------------------------------------
// search() span
// ---------------------------------------------------------------------------

describe("search() span", () => {
  it("creates a span named cluster-whisperer.vectorstore.search", async () => {
    const { backend } = await createInitializedBackend();

    await backend.search("test-collection", "managed database");

    const span = getSpanByName("cluster-whisperer.vectorstore.search");
    expect(span).toBeDefined();
  });

  it("sets DB semconv attributes", async () => {
    const { backend } = await createInitializedBackend();

    await backend.search("test-collection", "managed database");

    const span = getSpanByName("cluster-whisperer.vectorstore.search")!;
    expect(span.attributes["db.system"]).toBe("chromadb");
    expect(span.attributes["db.operation.name"]).toBe("query");
    expect(span.attributes["db.collection.name"]).toBe("test-collection");
  });

  it("sets result_count custom attribute", async () => {
    const { backend } = await createInitializedBackend();

    await backend.search("test-collection", "managed database");

    const span = getSpanByName("cluster-whisperer.vectorstore.search")!;
    expect(span.attributes["cluster_whisperer.vectorstore.result_count"]).toBe(2);
  });

  it("sets span kind to CLIENT", async () => {
    const { backend } = await createInitializedBackend();

    await backend.search("test-collection", "managed database");

    const span = getSpanByName("cluster-whisperer.vectorstore.search")!;
    expect(span.kind).toBe(SpanKind.CLIENT);
  });

  it("sets span status to ERROR on failure", async () => {
    const { backend } = await createInitializedBackend();
    mockCollection.query.mockRejectedValueOnce(new Error("Chroma query failed"));

    await expect(
      backend.search("test-collection", "managed database")
    ).rejects.toThrow("Chroma query failed");

    const span = getSpanByName("cluster-whisperer.vectorstore.search")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});

// ---------------------------------------------------------------------------
// keywordSearch() span
// ---------------------------------------------------------------------------

describe("keywordSearch() span", () => {
  it("creates a span named cluster-whisperer.vectorstore.keyword_search", async () => {
    const { backend } = await createInitializedBackend();

    await backend.keywordSearch("test-collection", "backup");

    const span = getSpanByName("cluster-whisperer.vectorstore.keyword_search");
    expect(span).toBeDefined();
  });

  it("sets DB semconv attributes", async () => {
    const { backend } = await createInitializedBackend();

    await backend.keywordSearch("test-collection", "backup");

    const span = getSpanByName("cluster-whisperer.vectorstore.keyword_search")!;
    expect(span.attributes["db.system"]).toBe("chromadb");
    expect(span.attributes["db.operation.name"]).toBe("get");
    expect(span.attributes["db.collection.name"]).toBe("test-collection");
  });

  it("sets result_count custom attribute", async () => {
    const { backend } = await createInitializedBackend();

    await backend.keywordSearch("test-collection", "backup");

    const span = getSpanByName("cluster-whisperer.vectorstore.keyword_search")!;
    expect(span.attributes["cluster_whisperer.vectorstore.result_count"]).toBe(1);
  });

  it("sets span kind to CLIENT", async () => {
    const { backend } = await createInitializedBackend();

    await backend.keywordSearch("test-collection", "backup");

    const span = getSpanByName("cluster-whisperer.vectorstore.keyword_search")!;
    expect(span.kind).toBe(SpanKind.CLIENT);
  });

  it("sets span status to ERROR on failure", async () => {
    const { backend } = await createInitializedBackend();
    mockCollection.get.mockRejectedValueOnce(new Error("Chroma get failed"));

    await expect(
      backend.keywordSearch("test-collection", "backup")
    ).rejects.toThrow("Chroma get failed");

    const span = getSpanByName("cluster-whisperer.vectorstore.keyword_search")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});

// ---------------------------------------------------------------------------
// delete() span
// ---------------------------------------------------------------------------

describe("delete() span", () => {
  it("creates a span named cluster-whisperer.vectorstore.delete", async () => {
    const { backend } = await createInitializedBackend();

    await backend.delete("test-collection", ["doc-1", "doc-2"]);

    const span = getSpanByName("cluster-whisperer.vectorstore.delete");
    expect(span).toBeDefined();
  });

  it("sets DB semconv attributes", async () => {
    const { backend } = await createInitializedBackend();

    await backend.delete("test-collection", ["doc-1"]);

    const span = getSpanByName("cluster-whisperer.vectorstore.delete")!;
    expect(span.attributes["db.system"]).toBe("chromadb");
    expect(span.attributes["db.operation.name"]).toBe("delete");
    expect(span.attributes["db.collection.name"]).toBe("test-collection");
  });

  it("sets document_count custom attribute", async () => {
    const { backend } = await createInitializedBackend();

    await backend.delete("test-collection", ["doc-1", "doc-2", "doc-3"]);

    const span = getSpanByName("cluster-whisperer.vectorstore.delete")!;
    expect(span.attributes["cluster_whisperer.vectorstore.document_count"]).toBe(3);
  });

  it("sets span kind to CLIENT", async () => {
    const { backend } = await createInitializedBackend();

    await backend.delete("test-collection", ["doc-1"]);

    const span = getSpanByName("cluster-whisperer.vectorstore.delete")!;
    expect(span.kind).toBe(SpanKind.CLIENT);
  });

  it("sets span status to ERROR on failure", async () => {
    const { backend } = await createInitializedBackend();
    mockCollection.delete.mockRejectedValueOnce(new Error("Chroma delete failed"));

    await expect(
      backend.delete("test-collection", ["doc-1"])
    ).rejects.toThrow("Chroma delete failed");

    const span = getSpanByName("cluster-whisperer.vectorstore.delete")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});

// ---------------------------------------------------------------------------
// No-op tracer behavior (tracing disabled)
// ---------------------------------------------------------------------------

describe("no-op tracer (tracing disabled)", () => {
  beforeEach(async () => {
    // Disable the global provider so getTracer() returns no-op
    await provider.shutdown();
    trace.disable();
  });

  it("methods still work when tracing is disabled", async () => {
    const { backend } = await createInitializedBackend();

    // All methods should work without errors even with no-op tracer
    await backend.store("test-collection", [
      { id: "doc-1", text: "hello", metadata: { kind: "Pod" } },
    ]);
    const searchResults = await backend.search("test-collection", "hello");
    expect(searchResults).toHaveLength(2);

    const keywordResults = await backend.keywordSearch("test-collection", "hello");
    expect(keywordResults).toHaveLength(1);

    await backend.delete("test-collection", ["doc-1"]);

    // No spans exported (no-op tracer)
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
