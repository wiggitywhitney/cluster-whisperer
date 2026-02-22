/**
 * optional-deps.ts - Dynamic loaders for optional OTel SDK packages
 *
 * Wraps CJS require() calls for optional peer dependencies in try/catch.
 * Returns the module on success or null when the package isn't installed.
 * Rethrows non-MODULE_NOT_FOUND errors so real faults (syntax errors,
 * permission issues, broken installations) surface during startup.
 *
 * Why a separate module?
 * - Isolates CJS require() from the rest of the codebase
 * - Makes the tracing module testable: tests can vi.mock("./optional-deps")
 *   to simulate packages being absent, which Vitest can intercept (unlike
 *   raw require() calls that go through Node's native CJS resolver)
 * - Each loader function clearly documents which package it loads and why
 */

/**
 * Returns true if the error is a MODULE_NOT_FOUND for the expected package.
 * Other errors (syntax errors, permission issues, broken transitive deps)
 * should propagate so they're visible during startup.
 */
function isModuleNotFound(error: unknown, packageName: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" &&
    error.message.includes(packageName)
  );
}

/**
 * Load @traceloop/node-server-sdk (OpenLLMetry).
 * Provides auto-instrumentation for LLM calls and the TracerProvider.
 */
export function loadTraceloop(): typeof import("@traceloop/node-server-sdk") | null {
  try {
    return require("@traceloop/node-server-sdk");
  } catch (error) {
    if (isModuleNotFound(error, "@traceloop/node-server-sdk")) return null;
    throw error;
  }
}

/**
 * Load @opentelemetry/sdk-trace-node.
 * Provides ConsoleSpanExporter for development tracing output.
 */
export function loadSdkTraceNode(): typeof import("@opentelemetry/sdk-trace-node") | null {
  try {
    return require("@opentelemetry/sdk-trace-node");
  } catch (error) {
    if (isModuleNotFound(error, "@opentelemetry/sdk-trace-node")) return null;
    throw error;
  }
}

/**
 * Load @opentelemetry/exporter-trace-otlp-proto.
 * Provides OTLPTraceExporter for sending spans to OTLP backends (Datadog, Jaeger).
 */
export function loadExporterOtlpProto(): typeof import("@opentelemetry/exporter-trace-otlp-proto") | null {
  try {
    return require("@opentelemetry/exporter-trace-otlp-proto");
  } catch (error) {
    if (isModuleNotFound(error, "@opentelemetry/exporter-trace-otlp-proto")) return null;
    throw error;
  }
}
