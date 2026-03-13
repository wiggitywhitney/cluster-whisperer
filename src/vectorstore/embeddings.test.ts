// ABOUTME: Unit tests for VoyageEmbedding OTel span instrumentation
// ABOUTME: Verifies embed() creates spans with correct GenAI semconv and custom attributes

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trace, SpanKind, SpanStatusCode, context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
// Pre-import the module under test at the top level to avoid slow dynamic imports.
// The vi.mock("voyageai") above is hoisted, so this import gets the mocked version.
import { VoyageEmbedding } from "./embeddings";

// ---------------------------------------------------------------------------
// Mock voyageai module — we test span creation, not Voyage AI behavior
// ---------------------------------------------------------------------------

const mockEmbed = vi.fn().mockResolvedValue({
  data: [
    { embedding: [0.1, 0.2, 0.3], index: 0 },
    { embedding: [0.4, 0.5, 0.6], index: 1 },
  ],
});

vi.mock("voyageai", () => {
  const MockVoyageAIClient = vi.fn().mockImplementation(function () {
    // @ts-expect-error — mock instance property
    this.embed = mockEmbed;
  });
  return { VoyageAIClient: MockVoyageAIClient };
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
  mockEmbed.mockClear();
  mockEmbed.mockResolvedValue({
    data: [
      { embedding: [0.1, 0.2, 0.3], index: 0 },
      { embedding: [0.4, 0.5, 0.6], index: 1 },
    ],
  });
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  // Reset active context to prevent parent-child leakage between tests
  context.disable();
});

// ---------------------------------------------------------------------------
// Helper: create a VoyageEmbedding instance
// ---------------------------------------------------------------------------

function createEmbedder(model?: string) {
  return new VoyageEmbedding({ apiKey: "test-key", model });
}

function getSpans(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

function getSpanByName(name: string): ReadableSpan | undefined {
  return getSpans().find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// embed() span
// ---------------------------------------------------------------------------

describe("embed() span", () => {
  it("creates a span named cluster-whisperer.embedding.embed", async () => {
    const embedder = createEmbedder();

    await embedder.embed(["hello", "world"]);

    const span = getSpanByName("cluster-whisperer.embedding.embed");
    expect(span).toBeDefined();
  });

  it("sets span kind to CLIENT", async () => {
    const embedder = createEmbedder();

    await embedder.embed(["hello", "world"]);

    const span = getSpanByName("cluster-whisperer.embedding.embed")!;
    expect(span.kind).toBe(SpanKind.CLIENT);
  });

  it("sets GenAI semconv attributes", async () => {
    const embedder = createEmbedder();

    await embedder.embed(["hello", "world"]);

    const span = getSpanByName("cluster-whisperer.embedding.embed")!;
    expect(span.attributes["gen_ai.operation.name"]).toBe("embeddings");
    expect(span.attributes["gen_ai.request.model"]).toBe("voyage-4");
  });

  it("sets gen_ai.request.model to the configured model", async () => {
    mockEmbed.mockResolvedValueOnce({
      data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
    });
    const embedder = createEmbedder("voyage-code-3");

    await embedder.embed(["hello"]);

    const span = getSpanByName("cluster-whisperer.embedding.embed")!;
    expect(span.attributes["gen_ai.request.model"]).toBe("voyage-code-3");
  });

  it("sets input_count custom attribute", async () => {
    mockEmbed.mockResolvedValueOnce({
      data: [
        { embedding: [0.1, 0.2, 0.3], index: 0 },
        { embedding: [0.4, 0.5, 0.6], index: 1 },
        { embedding: [0.7, 0.8, 0.9], index: 2 },
      ],
    });
    const embedder = createEmbedder();

    await embedder.embed(["one", "two", "three"]);

    const span = getSpanByName("cluster-whisperer.embedding.embed")!;
    expect(span.attributes["cluster_whisperer.embedding.input_count"]).toBe(3);
  });

  it("sets dimensions custom attribute from response", async () => {
    const embedder = createEmbedder();

    await embedder.embed(["hello", "world"]);

    const span = getSpanByName("cluster-whisperer.embedding.embed")!;
    // Mock returns 3-dimensional vectors
    expect(span.attributes["cluster_whisperer.embedding.dimensions"]).toBe(3);
  });

  it("sets span status to OK on success", async () => {
    const embedder = createEmbedder();

    await embedder.embed(["hello", "world"]);

    const span = getSpanByName("cluster-whisperer.embedding.embed")!;
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("sets span status to ERROR on API failure", async () => {
    const embedder = createEmbedder();
    mockEmbed.mockRejectedValueOnce(new Error("Voyage API rate limit exceeded"));

    await expect(embedder.embed(["hello"])).rejects.toThrow(
      "Voyage API rate limit exceeded"
    );

    const span = getSpanByName("cluster-whisperer.embedding.embed")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("Voyage API rate limit exceeded");
    expect(span.events.length).toBeGreaterThan(0); // recordException creates an event
  });

  it("sets span status to ERROR when response has no data", async () => {
    const embedder = createEmbedder();
    mockEmbed.mockResolvedValueOnce({ data: undefined });

    await expect(embedder.embed(["hello"])).rejects.toThrow(
      "Voyage AI returned no embedding data"
    );

    const span = getSpanByName("cluster-whisperer.embedding.embed")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("sets span status to ERROR when response count mismatches", async () => {
    const embedder = createEmbedder();
    mockEmbed.mockResolvedValueOnce({
      data: [{ embedding: [0.1, 0.2], index: 0 }],
    });

    await expect(embedder.embed(["hello", "world"])).rejects.toThrow(
      "Voyage AI returned 1 embeddings for 2 inputs"
    );

    const span = getSpanByName("cluster-whisperer.embedding.embed")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("returns embedding vectors correctly", async () => {
    const embedder = createEmbedder();

    const result = await embedder.embed(["hello", "world"]);

    expect(result).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
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

  it("embed() still works when tracing is disabled", async () => {
    const embedder = createEmbedder();

    const result = await embedder.embed(["hello", "world"]);
    expect(result).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);

    // No spans exported (no-op tracer)
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
