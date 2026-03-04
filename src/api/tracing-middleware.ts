// ABOUTME: Hono middleware that creates OTel SERVER spans for each HTTP request (PRD #37 M5)
// ABOUTME: Sets HTTP semconv attributes, propagates W3C Trace Context, and optionally skips health probe spans

import type { MiddlewareHandler } from "hono";
import {
  SpanKind,
  SpanStatusCode,
  propagation,
  context,
} from "@opentelemetry/api";
import { getTracer } from "../tracing";

/**
 * Paths that are considered health probes.
 *
 * When OTEL_HTTP_HEALTH_SPANS=false, these paths are excluded from
 * span creation to reduce noise from Kubernetes liveness/readiness checks.
 */
const HEALTH_PATHS = new Set(["/healthz", "/readyz"]);

/**
 * Custom getter for extracting W3C Trace Context from Fetch API Headers.
 *
 * The OTel propagation API needs a getter object that knows how to read
 * from the carrier type. Hono uses the standard Fetch API Headers object,
 * which has .get() and .keys() methods.
 */
const headerGetter = {
  get(carrier: Headers, key: string): string | undefined {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier: Headers): string[] {
    return [...carrier.keys()];
  },
};

/**
 * Creates a Hono middleware that wraps each incoming HTTP request in an
 * OTel span with HTTP semantic convention attributes.
 *
 * What it does:
 * 1. Extracts W3C Trace Context (traceparent/tracestate) from incoming headers
 *    so spans are parented to the caller's trace (e.g., k8s-vectordb-sync)
 * 2. Creates a SERVER span named "cluster-whisperer.http.request"
 * 3. Sets HTTP semconv attributes: method, path, status code, route
 * 4. Sets span status based on response code (5xx = ERROR, else OK)
 *
 * When tracing is disabled, getTracer() returns a no-op tracer and
 * startActiveSpan still calls the handler — zero overhead.
 *
 * Health probe opt-out:
 * Set OTEL_HTTP_HEALTH_SPANS=false to skip span creation for /healthz
 * and /readyz. Default is to create spans for all requests.
 */
export function tracingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;

    // Skip spans for health probes if opted out
    if (
      HEALTH_PATHS.has(path) &&
      process.env.OTEL_HTTP_HEALTH_SPANS === "false"
    ) {
      return next();
    }

    const tracer = getTracer();

    // Extract W3C Trace Context from incoming request headers.
    // If the caller (e.g., k8s-vectordb-sync) sent traceparent/tracestate
    // headers, this makes our span a child of their trace.
    const incomingContext = propagation.extract(
      context.active(),
      c.req.raw.headers,
      headerGetter
    );

    return tracer.startActiveSpan(
      "cluster-whisperer.http.request",
      { kind: SpanKind.SERVER },
      incomingContext,
      async (span) => {
        // Set request attributes before handler runs
        span.setAttribute("http.request.method", c.req.method);
        span.setAttribute("url.path", path);

        try {
          await next();

          // Set response attributes after handler completes
          const statusCode = c.res.status;
          span.setAttribute("http.response.status_code", statusCode);
          span.setAttribute("http.route", path);

          if (statusCode >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error as Error);
          throw error;
        } finally {
          span.end();
        }
      }
    );
  };
}
