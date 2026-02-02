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
 *
 * Exporter options:
 * - console (default): Prints spans to stdout, useful for development
 * - otlp: Sends spans via OTLP protocol to a collector (Datadog Agent, Jaeger, etc.)
 *
 * Architecture: OpenLLMetry owns the TracerProvider
 * We let OpenLLMetry (@traceloop/node-server-sdk) create and manage the TracerProvider.
 * This avoids conflicts - OTel has a single global TracerProvider, and if multiple
 * libraries create their own, spans don't correlate properly.
 *
 * We pass our exporter to OpenLLMetry, and use their wrappers (withTool) and
 * tracer (getTraceloopTracer) for our custom spans. This ensures all spans -
 * both auto-instrumented LLM calls and our manual tool/kubectl spans - share
 * the same trace context and export destination.
 */

import * as traceloop from "@traceloop/node-server-sdk";
import {
  ConsoleSpanExporter,
  SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Tracer } from "@opentelemetry/api";

/**
 * Configuration constants
 *
 * These could be read from package.json, but hardcoding keeps things simple
 * for this learning-focused project.
 */
const SERVICE_NAME = "cluster-whisperer";

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
 * Check if trace content capture is enabled.
 *
 * When enabled, prompts, completions, and embeddings are captured in span attributes.
 * This can expose sensitive user data in telemetry pipelines.
 *
 * SECURITY: Default to false to prevent accidental data exposure.
 * Only enable for development/debugging with non-sensitive data.
 */
const isTraceContentEnabled =
  process.env.OTEL_TRACE_CONTENT_ENABLED === "true";

/**
 * Exporter type: "console" for development, "otlp" for production backends.
 *
 * When using "otlp", you must also set OTEL_EXPORTER_OTLP_ENDPOINT to the
 * collector URL (e.g., http://localhost:4318 for Datadog Agent or Jaeger).
 *
 * This design is backend-agnostic: the same code works with any OTLP-compatible
 * backend. For KubeCon demo, changing the endpoint switches between Datadog and Jaeger.
 */
const exporterType = process.env.OTEL_EXPORTER_TYPE || "console";

/**
 * Create the appropriate span exporter based on configuration.
 *
 * Console exporter: Prints spans to stdout in a readable format.
 * Great for development and debugging.
 *
 * OTLP exporter: Sends spans over HTTP/protobuf to an OTLP collector.
 * Works with Datadog Agent (port 4318), Jaeger, or any OTLP-compatible backend.
 */
function createSpanExporter(): SpanExporter {
  if (exporterType === "otlp") {
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!endpoint) {
      throw new Error(
        "OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_EXPORTER_TYPE=otlp. " +
          "Set it to your collector URL (e.g., http://localhost:4318 for Datadog Agent)."
      );
    }
    // Normalize: strip trailing slashes to avoid double-slash in URL
    const base = endpoint.replace(/\/+$/, "");
    const url = base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
    console.log(`[OTel] Using OTLP exporter → ${base}`);
    return new OTLPTraceExporter({ url });
  }

  if (exporterType !== "console") {
    throw new Error(
      `Unsupported OTEL_EXPORTER_TYPE: "${exporterType}". Valid options: "console", "otlp".`
    );
  }

  console.log("[OTel] Using console exporter");
  return new ConsoleSpanExporter();
}

/**
 * Initialize tracing if enabled.
 *
 * Key architecture decision: OpenLLMetry owns the TracerProvider.
 *
 * OpenLLMetry internally creates a NodeSDK and registers the global TracerProvider.
 * By passing our exporter to OpenLLMetry, we ensure:
 * 1. All spans (auto-instrumented LLM + our manual tool/kubectl) use the same exporter
 * 2. No TracerProvider conflicts - only one provider exists
 * 3. Proper parent-child relationships across all span types
 *
 * This follows the OTel best practice: let one library own the TracerProvider
 * and configure it through that library's options.
 */
if (isTracingEnabled) {
  console.log("[OTel] Initializing OpenTelemetry tracing...");

  const exporter = createSpanExporter();

  /**
   * Initialize OpenLLMetry with our exporter.
   *
   * OpenLLMetry auto-instruments LangChain and Anthropic SDK calls, creating spans with:
   * - gen_ai.request.model (e.g., "claude-sonnet-4-20250514")
   * - gen_ai.provider.name (e.g., "anthropic")
   * - gen_ai.usage.input_tokens / output_tokens
   * - gen_ai.operation.name (e.g., "chat")
   *
   * By passing our exporter, these auto-instrumented spans go to the same
   * destination as our manual tool and kubectl spans.
   */
  traceloop.initialize({
    appName: SERVICE_NAME,
    // Use our exporter - this is the key to unified tracing
    exporter: exporter,
    // Disable batching for immediate export - better for development and short-lived CLI
    disableBatch: true,
    // Capture prompt/completion content only when explicitly enabled (security: default false)
    traceContent: isTraceContentEnabled,
    // Silence the default "Traceloop exporting traces to..." message
    silenceInitializationMessage: true,
  });

  console.log(`[OTel] Tracing enabled for ${SERVICE_NAME}`);
  console.log("[OTel] OpenLLMetry initialized for LLM instrumentation");

  /**
   * Graceful shutdown: flush pending spans before process exits.
   *
   * Why this matters:
   * Even with disableBatch: true, there may be spans in flight when the process
   * exits. forceFlush ensures they're exported before shutdown.
   *
   * Note: The @traceloop/node-server-sdk v0.22.x only exports forceFlush(),
   * not a shutdown() method. forceFlush() is sufficient for our CLI use case.
   */
  const shutdown = async () => {
    try {
      await traceloop.forceFlush();
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
 * Uses the standard OpenTelemetry API to get a tracer from the global
 * TracerProvider (which OpenLLMetry registered during initialization).
 * This is the stable, documented approach that ensures our custom spans
 * correlate with auto-instrumented LLM spans.
 *
 * When tracing is disabled, the global TracerProvider returns a no-op tracer
 * (safe to call, does nothing).
 *
 * Usage in other modules:
 * ```typescript
 * import { getTracer } from './tracing';
 * const tracer = getTracer();
 * tracer.startActiveSpan('myOperation', (span) => { ... });
 * ```
 */
export function getTracer(): Tracer {
  // Use standard OTel API - this returns the tracer from whatever
  // TracerProvider is registered globally (OpenLLMetry's when tracing is enabled,
  // or a no-op when disabled)
  const { trace } = require("@opentelemetry/api");
  return trace.getTracer(SERVICE_NAME);
}

/**
 * Re-export OpenLLMetry's withTool for use in tool-tracing.ts
 *
 * This wrapper creates properly-parented spans for tool executions.
 * It's the official way to create tool spans that integrate with OpenLLMetry's
 * auto-instrumented LLM spans.
 */
export const withTool = traceloop.withTool;

/**
 * Export trace content flag for use in context-bridge.ts
 *
 * When false, sensitive content (user questions, agent outputs) should not
 * be written to span attributes to prevent data exposure.
 */
export { isTraceContentEnabled };
