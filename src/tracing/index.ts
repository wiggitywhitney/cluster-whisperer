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
 * Graceful degradation:
 * OTel SDK packages (@traceloop/node-server-sdk, @opentelemetry/sdk-trace-node, etc.)
 * are optional peer dependencies loaded via dynamic require(). When absent, tracing
 * initialization is skipped and the OTel API returns no-op implementations.
 * This allows consumers to choose whether to install telemetry support.
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

import { trace, type Tracer } from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import { ToolDefinitionsProcessor } from "./tool-definitions-processor";
import {
  loadTraceloop,
  loadSdkTraceNode,
  loadExporterOtlpProto,
} from "./optional-deps";

/**
 * Optional OTel SDK packages loaded at module init time.
 *
 * These packages are optional peer dependencies — consumers who don't want
 * telemetry don't need to install them. The loaders in optional-deps.ts
 * wrap require() in try/catch so the module loads successfully when absent.
 *
 * When missing:
 * - traceloop = null → no auto-instrumentation, withTool is a passthrough
 * - sdkTraceNode = null → no ConsoleSpanExporter available
 * - exporterOtlpProto = null → no OTLPTraceExporter available
 */
const traceloop = loadTraceloop();
const sdkTraceNode = loadSdkTraceNode();
const exporterOtlpProto = loadExporterOtlpProto();

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
const isCaptureAiPayloads =
  process.env.OTEL_CAPTURE_AI_PAYLOADS === "true";

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
 * Only called inside the initialization block when @traceloop/node-server-sdk
 * is available. Checks for specific exporter packages and provides clear error
 * messages if the requested exporter type requires a package that isn't installed.
 *
 * Console exporter: Prints spans to stdout in a readable format.
 * Great for development and debugging.
 *
 * OTLP exporter: Sends spans over HTTP/protobuf to an OTLP collector.
 * Works with Datadog Agent (port 4318), Jaeger, or any OTLP-compatible backend.
 */
function createSpanExporter(): SpanExporter {
  if (exporterType === "otlp") {
    if (!exporterOtlpProto) {
      throw new Error(
        "OTEL_EXPORTER_TYPE=otlp requires @opentelemetry/exporter-trace-otlp-proto. " +
          "Install it: npm install @opentelemetry/exporter-trace-otlp-proto"
      );
    }
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
    return new exporterOtlpProto.OTLPTraceExporter({ url });
  }

  if (exporterType !== "console") {
    throw new Error(
      `Unsupported OTEL_EXPORTER_TYPE: "${exporterType}". Valid options: "console", "otlp".`
    );
  }

  if (!sdkTraceNode) {
    throw new Error(
      "Console exporter requires @opentelemetry/sdk-trace-node. " +
        "Install it: npm install @opentelemetry/sdk-trace-node"
    );
  }

  console.log("[OTel] Using console exporter");
  return new sdkTraceNode.ConsoleSpanExporter();
}

/**
 * Initialize tracing if enabled and SDK packages are available.
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
 *
 * When @traceloop/node-server-sdk is not installed, initialization is skipped
 * and all tracing calls fall through to the OTel API's built-in no-ops.
 */
if (isTracingEnabled) {
  if (!traceloop) {
    console.warn(
      "[OTel] OTEL_TRACING_ENABLED=true but @traceloop/node-server-sdk is not installed. " +
        "Tracing will be no-op. Install SDK packages for full telemetry."
    );
  } else {
    console.log("[OTel] Initializing OpenTelemetry tracing..."); // eslint-disable-line no-console

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
      traceContent: isCaptureAiPayloads,
      // Silence the default "Traceloop exporting traces to..." message
      silenceInitializationMessage: true,
      // Custom SpanProcessor that adds gen_ai.tool.definitions to LLM chat spans.
      // OpenLLMetry's auto-instrumentation creates anthropic.chat spans but doesn't
      // include tool definitions — our processor fills that gap for LLM Observability.
      processor: new ToolDefinitionsProcessor(),
    });

    console.log(`[OTel] Tracing enabled for ${SERVICE_NAME}`); // eslint-disable-line no-console
    console.log("[OTel] OpenLLMetry initialized for LLM instrumentation"); // eslint-disable-line no-console

    /**
     * Graceful shutdown: flush pending spans before process exits.
     *
     * Why this matters:
     * Even with disableBatch: true, there may be spans in flight when the process
     * exits. forceFlush ensures they're exported before shutdown.
     *
     * Note: The @traceloop/node-server-sdk v0.22.x only exports forceFlush(),
     * not a shutdown() method. forceFlush() is sufficient for our CLI use case.
     *
     * The const binding captures the traceloop reference at init time, ensuring
     * the shutdown handler always references the SDK instance used for initialization.
     */
    const traceloopSdk = traceloop;
    const shutdown = async () => {
      try {
        await traceloopSdk.forceFlush();
        console.log("[OTel] Tracing shut down gracefully"); // eslint-disable-line no-console
      } catch (error) {
        console.error("[OTel] Error shutting down tracing:", error);
      }
    };

    // Handle common termination signals
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }
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
  return trace.getTracer(SERVICE_NAME);
}

/**
 * Re-export OpenLLMetry's withTool for use in tool-tracing.ts
 *
 * When @traceloop/node-server-sdk is installed, this delegates to OpenLLMetry's
 * withTool which creates properly-parented spans for tool executions.
 * When the SDK is absent, this is a passthrough that calls the function directly —
 * the OTel API's no-op tracer handles span creation safely.
 */
export function withTool<T>(
  config: { name: string },
  fn: () => Promise<T>
): Promise<T> {
  if (traceloop) {
    return traceloop.withTool(config, fn);
  }
  return fn();
}

/**
 * Export AI payload capture flag for use in context-bridge.ts
 *
 * When false, AI interaction payloads (user prompts, model completions,
 * tool arguments, tool return values) are not written to span attributes.
 */
export { isCaptureAiPayloads };
