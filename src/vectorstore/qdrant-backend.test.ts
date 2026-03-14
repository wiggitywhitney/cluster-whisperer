// ABOUTME: Unit tests for QdrantBackend OTel span instrumentation
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
import { stringToUuidV5 } from "./qdrant-backend";

// ---------------------------------------------------------------------------
// Mock @qdrant/js-client-rest — we test span creation, not Qdrant behavior
// ---------------------------------------------------------------------------

const { mockQdrantClient } = vi.hoisted(() => {
  const mockQdrantClient = {
    createCollection: vi.fn().mockResolvedValue(true),
    getCollection: vi.fn().mockResolvedValue({ status: "green" }),
    upsert: vi.fn().mockResolvedValue({ status: "completed" }),
    query: vi.fn().mockResolvedValue({
      points: [
        {
          id: "some-uuid-1",
          score: 0.9,
          payload: { _originalId: "doc-1", document: "text-1", kind: "Deployment" },
        },
        {
          id: "some-uuid-2",
          score: 0.7,
          payload: { _originalId: "doc-2", document: "text-2", kind: "Service" },
        },
      ],
    }),
    scroll: vi.fn().mockResolvedValue({
      points: [
        {
          id: "some-uuid-1",
          payload: { _originalId: "doc-1", document: "text-1", kind: "Deployment" },
        },
      ],
    }),
    delete: vi.fn().mockResolvedValue({ status: "completed" }),
    collectionExists: vi.fn().mockResolvedValue({ exists: false }),
  };
  return { mockQdrantClient };
});

vi.mock("@qdrant/js-client-rest", () => {
  const MockQdrantClient = vi.fn().mockImplementation(function () {
    Object.assign(this, mockQdrantClient);
  });
  return { QdrantClient: MockQdrantClient };
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
  mockQdrantClient.createCollection.mockClear();
  mockQdrantClient.getCollection.mockClear();
  mockQdrantClient.collectionExists.mockClear().mockResolvedValue({ exists: false });
  mockQdrantClient.upsert.mockClear();
  mockQdrantClient.query.mockClear().mockResolvedValue({
    points: [
      {
        id: "some-uuid-1",
        score: 0.9,
        payload: { _originalId: "doc-1", document: "text-1", kind: "Deployment" },
      },
      {
        id: "some-uuid-2",
        score: 0.7,
        payload: { _originalId: "doc-2", document: "text-2", kind: "Service" },
      },
    ],
  });
  mockQdrantClient.scroll.mockClear().mockResolvedValue({
    points: [
      {
        id: "some-uuid-1",
        payload: { _originalId: "doc-1", document: "text-1", kind: "Deployment" },
      },
    ],
  });
  mockQdrantClient.delete.mockClear();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  // Reset active context to prevent parent-child leakage between tests
  context.disable();
});

// ---------------------------------------------------------------------------
// Helper: create a QdrantBackend with mock embedder
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
  const { QdrantBackend } = await import("./qdrant-backend");
  const emb = embedder ?? createMockEmbedder();
  const backend = new QdrantBackend(emb, {
    qdrantUrl: "http://localhost:6333",
    vectorSize: 3,
  });
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
    expect(span.attributes["db.system"]).toBe("qdrant");
    expect(span.attributes["db.operation.name"]).toBe("create_collection");
    expect(span.attributes["db.collection.name"]).toBe("test-collection");
  });

  it("sets span status to OK on success", async () => {
    await createInitializedBackend();

    const span = getSpanByName("cluster-whisperer.vectorstore.initialize")!;
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("skips creation when collection already exists", async () => {
    mockQdrantClient.collectionExists.mockResolvedValueOnce({ exists: true });
    await createInitializedBackend();

    expect(mockQdrantClient.createCollection).not.toHaveBeenCalled();
    const span = getSpanByName("cluster-whisperer.vectorstore.initialize")!;
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("sets span status to ERROR on failure", async () => {
    mockQdrantClient.collectionExists.mockRejectedValueOnce(
      new Error("Connection refused")
    );

    const { QdrantBackend } = await import("./qdrant-backend");
    const embedder = createMockEmbedder();
    const backend = new QdrantBackend(embedder, {
      qdrantUrl: "http://localhost:6333",
      vectorSize: 3,
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
    expect(span.attributes["db.system"]).toBe("qdrant");
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
    expect(
      span.attributes["cluster_whisperer.vectorstore.document_count"]
    ).toBe(2);
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
    mockQdrantClient.upsert.mockRejectedValueOnce(
      new Error("Qdrant upsert failed")
    );

    await expect(
      backend.store("test-collection", [
        { id: "doc-1", text: "hello", metadata: { kind: "Pod" } },
      ])
    ).rejects.toThrow("Qdrant upsert failed");

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
    expect(span.attributes["db.system"]).toBe("qdrant");
    expect(span.attributes["db.operation.name"]).toBe("query");
    expect(span.attributes["db.collection.name"]).toBe("test-collection");
  });

  it("sets result_count custom attribute", async () => {
    const { backend } = await createInitializedBackend();

    await backend.search("test-collection", "managed database");

    const span = getSpanByName("cluster-whisperer.vectorstore.search")!;
    expect(span.attributes["cluster_whisperer.vectorstore.result_count"]).toBe(
      2
    );
  });

  it("sets span kind to CLIENT", async () => {
    const { backend } = await createInitializedBackend();

    await backend.search("test-collection", "managed database");

    const span = getSpanByName("cluster-whisperer.vectorstore.search")!;
    expect(span.kind).toBe(SpanKind.CLIENT);
  });

  it("sets span status to ERROR on failure", async () => {
    const { backend } = await createInitializedBackend();
    mockQdrantClient.query.mockRejectedValueOnce(
      new Error("Qdrant query failed")
    );

    await expect(
      backend.search("test-collection", "managed database")
    ).rejects.toThrow("Qdrant query failed");

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

    const span = getSpanByName(
      "cluster-whisperer.vectorstore.keyword_search"
    )!;
    expect(span.attributes["db.system"]).toBe("qdrant");
    expect(span.attributes["db.operation.name"]).toBe("scroll");
    expect(span.attributes["db.collection.name"]).toBe("test-collection");
  });

  it("sets result_count custom attribute", async () => {
    const { backend } = await createInitializedBackend();

    await backend.keywordSearch("test-collection", "backup");

    const span = getSpanByName(
      "cluster-whisperer.vectorstore.keyword_search"
    )!;
    expect(span.attributes["cluster_whisperer.vectorstore.result_count"]).toBe(
      1
    );
  });

  it("sets span kind to CLIENT", async () => {
    const { backend } = await createInitializedBackend();

    await backend.keywordSearch("test-collection", "backup");

    const span = getSpanByName(
      "cluster-whisperer.vectorstore.keyword_search"
    )!;
    expect(span.kind).toBe(SpanKind.CLIENT);
  });

  it("sets span status to ERROR on failure", async () => {
    const { backend } = await createInitializedBackend();
    mockQdrantClient.scroll.mockRejectedValueOnce(
      new Error("Qdrant scroll failed")
    );

    await expect(
      backend.keywordSearch("test-collection", "backup")
    ).rejects.toThrow("Qdrant scroll failed");

    const span = getSpanByName(
      "cluster-whisperer.vectorstore.keyword_search"
    )!;
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
    expect(span.attributes["db.system"]).toBe("qdrant");
    expect(span.attributes["db.operation.name"]).toBe("delete");
    expect(span.attributes["db.collection.name"]).toBe("test-collection");
  });

  it("sets document_count custom attribute", async () => {
    const { backend } = await createInitializedBackend();

    await backend.delete("test-collection", ["doc-1", "doc-2", "doc-3"]);

    const span = getSpanByName("cluster-whisperer.vectorstore.delete")!;
    expect(
      span.attributes["cluster_whisperer.vectorstore.document_count"]
    ).toBe(3);
  });

  it("sets span kind to CLIENT", async () => {
    const { backend } = await createInitializedBackend();

    await backend.delete("test-collection", ["doc-1"]);

    const span = getSpanByName("cluster-whisperer.vectorstore.delete")!;
    expect(span.kind).toBe(SpanKind.CLIENT);
  });

  it("sets span status to ERROR on failure", async () => {
    const { backend } = await createInitializedBackend();
    mockQdrantClient.delete.mockRejectedValueOnce(
      new Error("Qdrant delete failed")
    );

    await expect(
      backend.delete("test-collection", ["doc-1"])
    ).rejects.toThrow("Qdrant delete failed");

    const span = getSpanByName("cluster-whisperer.vectorstore.delete")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});

// ---------------------------------------------------------------------------
// Filter translation
// ---------------------------------------------------------------------------

describe("filter translation", () => {
  it("translates where metadata filters to Qdrant must conditions", async () => {
    const { backend } = await createInitializedBackend();

    await backend.keywordSearch("test-collection", undefined, {
      where: { kind: "Deployment", apiGroup: "apps" },
    });

    const scrollCall = mockQdrantClient.scroll.mock.calls[0];
    expect(scrollCall[1].filter).toEqual({
      must: [
        { key: "kind", match: { value: "Deployment" } },
        { key: "apiGroup", match: { value: "apps" } },
      ],
    });
  });

  it("translates single where filter to Qdrant must condition", async () => {
    const { backend } = await createInitializedBackend();

    await backend.search("test-collection", "database", {
      where: { kind: "Deployment" },
    });

    const queryCall = mockQdrantClient.query.mock.calls[0];
    expect(queryCall[1].filter).toEqual({
      must: [{ key: "kind", match: { value: "Deployment" } }],
    });
  });

  it("adds document text filter for keyword search", async () => {
    const { backend } = await createInitializedBackend();

    await backend.keywordSearch("test-collection", "backup");

    const scrollCall = mockQdrantClient.scroll.mock.calls[0];
    expect(scrollCall[1].filter).toEqual({
      must: [{ key: "document", match: { text: "backup" } }],
    });
  });

  it("combines keyword and metadata filters", async () => {
    const { backend } = await createInitializedBackend();

    await backend.keywordSearch("test-collection", "backup", {
      where: { kind: "Deployment" },
    });

    const scrollCall = mockQdrantClient.scroll.mock.calls[0];
    expect(scrollCall[1].filter).toEqual({
      must: [
        { key: "document", match: { text: "backup" } },
        { key: "kind", match: { value: "Deployment" } },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// UUID v5 ID conversion
// ---------------------------------------------------------------------------

describe("stringToUuidV5", () => {
  it("produces a valid UUID format", () => {
    const uuid = stringToUuidV5("configmaps");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("is deterministic — same input always produces same UUID", () => {
    const a = stringToUuidV5("deployments.apps");
    const b = stringToUuidV5("deployments.apps");
    expect(a).toBe(b);
  });

  it("produces different UUIDs for different inputs", () => {
    const a = stringToUuidV5("configmaps");
    const b = stringToUuidV5("deployments.apps");
    expect(a).not.toBe(b);
  });

  it("handles resource names with slashes (instance IDs)", () => {
    const uuid = stringToUuidV5("default/apps/v1/Deployment/nginx");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

describe("store() UUID ID conversion", () => {
  it("converts string IDs to UUIDs before upserting", async () => {
    const { backend } = await createInitializedBackend();

    await backend.store("test-collection", [
      { id: "my-resource", text: "hello", metadata: { kind: "Pod" } },
    ]);

    const upsertCall = mockQdrantClient.upsert.mock.calls[0];
    const points = upsertCall[1].points;
    // ID should be a UUID, not the original string
    expect(points[0].id).toBe(stringToUuidV5("my-resource"));
    expect(points[0].id).not.toBe("my-resource");
  });

  it("includes _originalId in payload for retrieval", async () => {
    const { backend } = await createInitializedBackend();

    await backend.store("test-collection", [
      { id: "my-resource", text: "hello", metadata: { kind: "Pod" } },
    ]);

    const upsertCall = mockQdrantClient.upsert.mock.calls[0];
    const points = upsertCall[1].points;
    expect(points[0].payload._originalId).toBe("my-resource");
  });
});

describe("search() returns original string IDs", () => {
  it("returns _originalId from payload as the result id", async () => {
    const { backend } = await createInitializedBackend();
    const results = await backend.search("test-collection", "managed database");

    expect(results[0].id).toBe("doc-1");
    expect(results[1].id).toBe("doc-2");
  });

  it("does not include _originalId in result metadata", async () => {
    const { backend } = await createInitializedBackend();
    const results = await backend.search("test-collection", "managed database");

    expect(results[0].metadata).not.toHaveProperty("_originalId");
  });
});

describe("keywordSearch() returns original string IDs", () => {
  it("returns _originalId from payload as the result id", async () => {
    const { backend } = await createInitializedBackend();
    const results = await backend.keywordSearch("test-collection", "backup");

    expect(results[0].id).toBe("doc-1");
  });

  it("does not include _originalId in result metadata", async () => {
    const { backend } = await createInitializedBackend();
    const results = await backend.keywordSearch("test-collection", "backup");

    expect(results[0].metadata).not.toHaveProperty("_originalId");
  });
});

describe("delete() converts IDs to UUIDs", () => {
  it("converts string IDs to UUIDs before deleting", async () => {
    const { backend } = await createInitializedBackend();

    await backend.delete("test-collection", ["doc-1", "doc-2"]);

    const deleteCall = mockQdrantClient.delete.mock.calls[0];
    expect(deleteCall[1].points).toEqual([
      stringToUuidV5("doc-1"),
      stringToUuidV5("doc-2"),
    ]);
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

    const keywordResults = await backend.keywordSearch(
      "test-collection",
      "hello"
    );
    expect(keywordResults).toHaveLength(1);

    await backend.delete("test-collection", ["doc-1"]);

    // No spans exported (no-op tracer)
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
