/**
 * tool-tracing.ts - OpenTelemetry instrumentation for MCP tool calls
 *
 * What this file does:
 * Provides a wrapper function that adds tracing to any MCP tool handler.
 * When a tool is called, it creates a span with timing, inputs, and success/failure info.
 *
 * Why a wrapper pattern?
 * Following Viktor's approach from dot-ai. Instead of duplicating tracing code in each
 * tool handler, we wrap handlers with this function. This keeps tracing logic DRY and
 * separates the observability concern from the tool logic.
 *
 * Attribute strategy (from docs/opentelemetry-research.md Section 6):
 * We include BOTH Viktor's attributes AND OTel semantic conventions. This enables:
 * - Head-to-head comparison queries using Viktor's naming (for KubeCon demo)
 * - Standards compliance using semconv (for tooling compatibility)
 */

import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { getTracer } from "./index";

/**
 * MCP tool result with isError flag - used to check tool success.
 * We only need the isError property for tracing; the rest passes through.
 */
interface ResultWithError {
  isError?: boolean;
}

/**
 * Wraps an MCP tool handler with OpenTelemetry tracing.
 *
 * Creates a span for each tool invocation with:
 * - Span name: "execute_tool {toolName}" (following semconv pattern)
 * - Span kind: INTERNAL (business logic, not an outbound call)
 * - Attributes: Both Viktor's and semconv naming (see below)
 *
 * Attributes captured:
 * | Attribute                    | Source  | Description                    |
 * |------------------------------|---------|--------------------------------|
 * | gen_ai.tool.name             | Both    | Tool name (e.g., kubectl_get)  |
 * | gen_ai.tool.input            | Viktor  | JSON stringified input args    |
 * | gen_ai.tool.call.arguments   | Semconv | JSON stringified input args    |
 * | gen_ai.tool.duration_ms      | Viktor  | Execution time in milliseconds |
 * | gen_ai.tool.success          | Viktor  | true if tool succeeded         |
 *
 * Error handling:
 * - Exceptions (thrown errors): recorded with span.recordException(), status ERROR
 * - Tool failures (isError: true): gen_ai.tool.success = false, span status stays OK
 *   (The tool worked correctly - it's kubectl that failed)
 *
 * @param toolName - The name of the tool (e.g., "kubectl_get")
 * @param handler - The async function that executes the tool logic
 * @returns A wrapped handler that traces the execution
 */
export function withToolTracing<TInput, TResult extends ResultWithError>(
  toolName: string,
  handler: (input: TInput) => Promise<TResult>
): (input: TInput) => Promise<TResult> {
  return async (input: TInput): Promise<TResult> => {
    const tracer = getTracer();
    const startTime = Date.now();

    // Create span manually so we can use context.with() for proper async propagation
    // startActiveSpan with async callbacks doesn't reliably propagate context
    const span = tracer.startSpan(`execute_tool ${toolName}`, {
      kind: SpanKind.INTERNAL,
    });

    // Set input attributes before execution
    // Both Viktor's naming and semconv for comparison capability
    const inputJson = JSON.stringify(input, null, 2);
    span.setAttribute("gen_ai.tool.name", toolName);
    span.setAttribute("gen_ai.tool.input", inputJson); // Viktor
    span.setAttribute("gen_ai.tool.call.arguments", inputJson); // Semconv

    // Use context.with() to ensure the span is active for all nested operations
    // This is the key fix - it properly propagates context across await boundaries
    const activeContext = trace.setSpan(context.active(), span);

    return context.with(activeContext, async () => {
      try {
        // Execute the actual tool handler (kubectl calls will inherit this context)
        const result = await handler(input);

        // Calculate duration and set post-execution attributes
        const durationMs = Date.now() - startTime;
        span.setAttribute("gen_ai.tool.duration_ms", durationMs);

        // Tool success is based on isError flag (from kubectl exit code)
        // If isError is true, the tool worked but kubectl failed
        const success = !result.isError;
        span.setAttribute("gen_ai.tool.success", success);

        // Span status stays OK even if kubectl failed - the tool executed correctly
        span.setStatus({ code: SpanStatusCode.OK });

        return result;
      } catch (error) {
        // Actual exception - the tool itself failed to execute
        const durationMs = Date.now() - startTime;
        span.setAttribute("gen_ai.tool.duration_ms", durationMs);
        span.setAttribute("gen_ai.tool.success", false);

        // Record the exception for debugging
        if (error instanceof Error) {
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
        } else {
          span.recordException(new Error(String(error)));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: String(error),
          });
        }

        throw error;
      } finally {
        span.end();
      }
    });
  };
}
