// ABOUTME: Unit tests for HTTP OTel tracing middleware (PRD #37 M5)
// ABOUTME: Verifies span creation, HTTP semconv attributes, W3C context propagation, and health probe opt-out

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
  trace,
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { tracingMiddleware } from "./tracing-middleware";
import { createApp } from "./server";
import { createMockVectorStore, makeInstance } from "./test-helpers";

// ---------------------------------------------------------------------------
// OTel test infrastructure — same pattern as chroma-backend.test.ts
// ---------------------------------------------------------------------------

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

beforeEach(() => {
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  // Register W3C propagator so propagation.extract() works in tests
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
  vi.unstubAllEnvs();
});

function getSpans(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

function getSpanByName(name: string): ReadableSpan | undefined {
  return getSpans().find((s) => s.name === name);
}

/**
 * Creates a minimal Hono app with the tracing middleware and a test route.
 * The route returns a JSON response with the given status code.
 */
function createTestApp(options?: {
  statusCode?: number;
  errorRoute?: boolean;
}): Hono {
  const app = new Hono();
  app.use("*", tracingMiddleware());

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", (c) => c.json({ status: "ok" }));

  app.get("/test", (c) => {
    return c.json({ result: "ok" }, (options?.statusCode ?? 200) as 200);
  });

  app.post("/api/v1/instances/sync", (c) => {
    if (options?.errorRoute) {
      return c.json({ error: "Internal error" }, 500);
    }
    return c.json({ status: "ok" }, (options?.statusCode ?? 200) as 200);
  });

  if (options?.errorRoute) {
    app.get("/throws", () => {
      throw new Error("unhandled route error");
    });
  }

  return app;
}

// ---------------------------------------------------------------------------
// Span creation
// ---------------------------------------------------------------------------

describe("HTTP tracing middleware", () => {
  describe("span creation", () => {
    it("creates a span named cluster-whisperer.http.request", async () => {
      const app = createTestApp();
      await app.request("/test");

      const span = getSpanByName("cluster-whisperer.http.request");
      expect(span).toBeDefined();
    });

    it("sets span kind to SERVER", async () => {
      const app = createTestApp();
      await app.request("/test");

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.kind).toBe(SpanKind.SERVER);
    });

    it("creates one span per request", async () => {
      const app = createTestApp();
      await app.request("/test");
      await app.request("/test");

      const spans = getSpans().filter(
        (s) => s.name === "cluster-whisperer.http.request"
      );
      expect(spans).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // HTTP semconv attributes
  // ---------------------------------------------------------------------------

  describe("HTTP semconv attributes", () => {
    it("sets http.request.method", async () => {
      const app = createTestApp();
      await app.request("/test");

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.attributes["http.request.method"]).toBe("GET");
    });

    it("sets http.request.method for POST", async () => {
      const app = createTestApp();
      await app.request("/api/v1/instances/sync", { method: "POST" });

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.attributes["http.request.method"]).toBe("POST");
    });

    it("sets url.path", async () => {
      const app = createTestApp();
      await app.request("/api/v1/instances/sync", { method: "POST" });

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.attributes["url.path"]).toBe("/api/v1/instances/sync");
    });

    it("sets http.response.status_code for 200", async () => {
      const app = createTestApp();
      await app.request("/test");

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.attributes["http.response.status_code"]).toBe(200);
    });

    it("sets http.response.status_code for 500", async () => {
      const app = createTestApp({ statusCode: 500, errorRoute: true });
      await app.request("/api/v1/instances/sync", { method: "POST" });

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.attributes["http.response.status_code"]).toBe(500);
    });

    it("sets http.route", async () => {
      const app = createTestApp();
      await app.request("/api/v1/instances/sync", { method: "POST" });

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.attributes["http.route"]).toBe("/api/v1/instances/sync");
    });
  });

  // ---------------------------------------------------------------------------
  // Span status
  // ---------------------------------------------------------------------------

  describe("span status", () => {
    it("sets OK status for 2xx responses", async () => {
      const app = createTestApp();
      await app.request("/test");

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it("sets OK status for 4xx responses", async () => {
      const app = createTestApp();
      // 404 from unknown route
      await app.request("/nonexistent");

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it("sets ERROR status for 5xx responses", async () => {
      const app = createTestApp({ statusCode: 500, errorRoute: true });
      await app.request("/api/v1/instances/sync", { method: "POST" });

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });
  });

  // ---------------------------------------------------------------------------
  // W3C Trace Context propagation
  // ---------------------------------------------------------------------------

  describe("W3C Trace Context propagation", () => {
    it("extracts traceparent header to create child span", async () => {
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const parentSpanId = "00f067aa0ba902b7";
      const traceparent = `00-${traceId}-${parentSpanId}-01`;

      const app = createTestApp();
      await app.request("/test", {
        headers: { traceparent },
      });

      const span = getSpanByName("cluster-whisperer.http.request")!;
      // The span should belong to the same trace
      expect(span.spanContext().traceId).toBe(traceId);
      // The span's parent should be the incoming span
      expect(span.parentSpanContext?.spanId).toBe(parentSpanId);
    });

    it("creates a new trace when no traceparent header is present", async () => {
      const app = createTestApp();
      await app.request("/test");

      const span = getSpanByName("cluster-whisperer.http.request")!;
      // Span should have a valid trace ID (not zero)
      expect(span.spanContext().traceId).not.toBe(
        "00000000000000000000000000000000"
      );
      // No remote parent when no incoming context
      expect(span.parentSpanContext?.isRemote).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Health probe span opt-out
  // ---------------------------------------------------------------------------

  describe("health probe spans", () => {
    it("creates spans for /healthz by default", async () => {
      const app = createTestApp();
      await app.request("/healthz");

      const span = getSpanByName("cluster-whisperer.http.request");
      expect(span).toBeDefined();
      expect(span!.attributes["url.path"]).toBe("/healthz");
    });

    it("creates spans for /readyz by default", async () => {
      const app = createTestApp();
      await app.request("/readyz");

      const span = getSpanByName("cluster-whisperer.http.request");
      expect(span).toBeDefined();
      expect(span!.attributes["url.path"]).toBe("/readyz");
    });

    it("skips spans for /healthz when OTEL_HTTP_HEALTH_SPANS=false", async () => {
      vi.stubEnv("OTEL_HTTP_HEALTH_SPANS", "false");
      const app = createTestApp();
      await app.request("/healthz");

      const span = getSpanByName("cluster-whisperer.http.request");
      expect(span).toBeUndefined();
    });

    it("skips spans for /readyz when OTEL_HTTP_HEALTH_SPANS=false", async () => {
      vi.stubEnv("OTEL_HTTP_HEALTH_SPANS", "false");
      const app = createTestApp();
      await app.request("/readyz");

      const span = getSpanByName("cluster-whisperer.http.request");
      expect(span).toBeUndefined();
    });

    it("still creates spans for non-health routes when OTEL_HTTP_HEALTH_SPANS=false", async () => {
      vi.stubEnv("OTEL_HTTP_HEALTH_SPANS", "false");
      const app = createTestApp();
      await app.request("/test");

      const span = getSpanByName("cluster-whisperer.http.request");
      expect(span).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Custom sync attributes (set by route handlers on the active span)
  // ---------------------------------------------------------------------------

  describe("custom sync attributes", () => {
    /** Helper to POST JSON to the sync endpoint via the full app */
    function postSync(
      app: ReturnType<typeof createApp>,
      body: unknown
    ) {
      return app.request("/api/v1/instances/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("sets upsert_count and delete_count on instance sync span", async () => {
      const mockStore = createMockVectorStore();
      const app = createApp({ vectorStore: mockStore });

      await postSync(app, {
        upserts: [makeInstance(), makeInstance({ id: "default/apps/v1/Deployment/redis" })],
        deletes: ["default/apps/v1/Deployment/old"],
      });

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.attributes["cluster_whisperer.sync.upsert_count"]).toBe(2);
      expect(span.attributes["cluster_whisperer.sync.delete_count"]).toBe(1);
    });

    it("sets zero counts for empty arrays", async () => {
      const mockStore = createMockVectorStore();
      const app = createApp({ vectorStore: mockStore });

      await postSync(app, { upserts: [], deletes: [] });

      const span = getSpanByName("cluster-whisperer.http.request")!;
      expect(span.attributes["cluster_whisperer.sync.upsert_count"]).toBe(0);
      expect(span.attributes["cluster_whisperer.sync.delete_count"]).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // No-op tracer (tracing disabled)
  // ---------------------------------------------------------------------------

  describe("no-op tracer (tracing disabled)", () => {
    beforeEach(async () => {
      await provider.shutdown();
      trace.disable();
    });

    it("routes still work when tracing is disabled", async () => {
      const app = createTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: "ok" });
    });

    it("no spans exported when tracing is disabled", async () => {
      const app = createTestApp();
      await app.request("/test");

      expect(getSpans()).toHaveLength(0);
    });
  });
});
