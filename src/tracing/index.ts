/**
 * tracing/index.ts - OpenTelemetry initialization for cluster-whisperer
 *
 * What this file does:
 * Sets up OpenTelemetry tracing so we can see what's happening inside the agent.
 * Traces show the flow of operations: which tools were called, how long they took,
 * and where errors occurred.
 *
 * Why OpenTelemetry?
 * OTel is an open standard for observability. By using it, our traces can be sent
 * to any compatible backend (Jaeger, Datadog, Honeycomb, etc.) without code changes.
 *
 * Opt-in by default:
 * Tracing is disabled unless OTEL_TRACING_ENABLED=true. When disabled, the OTel API
 * returns a "no-op" tracer that does nothing - zero performance overhead.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { trace, Tracer } from "@opentelemetry/api";

/**
 * Configuration constants
 *
 * These could be read from package.json, but hardcoding keeps things simple
 * for this learning-focused project.
 */
const SERVICE_NAME = "cluster-whisperer";
const SERVICE_VERSION = "0.1.0";

/**
 * Check if tracing is enabled via environment variable.
 *
 * Why opt-in rather than opt-out?
 * - Development is quieter by default (no trace spam in console)
 * - Users explicitly choose when they want observability
 * - Follows Viktor's pattern from dot-ai
 */
const isTracingEnabled = process.env.OTEL_TRACING_ENABLED === "true";

/**
 * The SDK instance, stored so we can shut it down gracefully.
 * Undefined if tracing is disabled.
 */
let sdk: NodeSDK | undefined;

/**
 * Initialize the OpenTelemetry SDK if tracing is enabled.
 *
 * What happens here:
 * 1. Create a Resource that identifies our service (name, version)
 * 2. Configure a ConsoleSpanExporter for development visibility
 * 3. Start the SDK, which registers a global TracerProvider
 *
 * After this runs, any call to trace.getTracer() will return a working tracer.
 */
if (isTracingEnabled) {
  console.log("[OTel] Initializing OpenTelemetry tracing...");

  sdk = new NodeSDK({
    // Resource: metadata about this service that appears on every span
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    }),

    // Use SimpleSpanProcessor for immediate span export during development
    // BatchSpanProcessor (default with traceExporter) batches spans for efficiency,
    // but delays output by up to 5 seconds. SimpleSpanProcessor exports immediately,
    // which is better for development debugging.
    // M5 will add OTLP exporter option for production backends like Datadog
    spanProcessor: new SimpleSpanProcessor(new ConsoleSpanExporter()),

    // No auto-instrumentation - we instrument manually at business logic boundaries
    // Auto-instrumentation handles HTTP/DB libraries, but our spans are for
    // MCP tool calls and kubectl subprocess execution
    instrumentations: [],
  });

  sdk.start();
  console.log(`[OTel] Tracing enabled for ${SERVICE_NAME} v${SERVICE_VERSION}`);

  /**
   * Graceful shutdown: flush any pending spans before process exits.
   *
   * Why this matters:
   * Spans are batched and sent periodically. If the process exits abruptly,
   * buffered spans might be lost. This ensures everything gets exported.
   */
  const shutdown = async () => {
    try {
      await sdk?.shutdown();
      console.log("[OTel] Tracing shut down gracefully");
    } catch (error) {
      console.error("[OTel] Error shutting down tracing:", error);
    }
  };

  // Handle common termination signals
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * Get a tracer for creating spans.
 *
 * Why a function instead of exporting the tracer directly?
 * - The tracer should be obtained at the point of use, not at import time
 * - This avoids initialization timing issues
 * - When tracing is disabled, this returns a no-op tracer (safe to call, does nothing)
 *
 * Usage in other modules:
 * ```typescript
 * import { getTracer } from './tracing';
 * const tracer = getTracer();
 * tracer.startActiveSpan('myOperation', (span) => { ... });
 * ```
 */
export function getTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
}
