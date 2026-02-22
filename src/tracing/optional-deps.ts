/**
 * optional-deps.ts - Dynamic loaders for optional OTel SDK packages
 *
 * Wraps CJS require() calls for optional peer dependencies in try/catch.
 * Returns the module on success or null when the package isn't installed.
 *
 * Why a separate module?
 * - Isolates CJS require() from the rest of the codebase
 * - Makes the tracing module testable: tests can vi.mock("./optional-deps")
 *   to simulate packages being absent, which Vitest can intercept (unlike
 *   raw require() calls that go through Node's native CJS resolver)
 * - Each loader function clearly documents which package it loads and why
 */

/**
 * Load @traceloop/node-server-sdk (OpenLLMetry).
 * Provides auto-instrumentation for LLM calls and the TracerProvider.
 */
export function loadTraceloop(): typeof import("@traceloop/node-server-sdk") | null {
  try {
    return require("@traceloop/node-server-sdk");
  } catch {
    return null;
  }
}

/**
 * Load @opentelemetry/sdk-trace-node.
 * Provides ConsoleSpanExporter for development tracing output.
 */
export function loadSdkTraceNode(): typeof import("@opentelemetry/sdk-trace-node") | null {
  try {
    return require("@opentelemetry/sdk-trace-node");
  } catch {
    return null;
  }
}

/**
 * Load @opentelemetry/exporter-trace-otlp-proto.
 * Provides OTLPTraceExporter for sending spans to OTLP backends (Datadog, Jaeger).
 */
export function loadExporterOtlpProto(): typeof import("@opentelemetry/exporter-trace-otlp-proto") | null {
  try {
    return require("@opentelemetry/exporter-trace-otlp-proto");
  } catch {
    return null;
  }
}
