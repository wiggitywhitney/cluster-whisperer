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
 * Attribute strategy (from docs/opentelemetry-research.md Section 10):
 * We use OTel GenAI semantic conventions for full Datadog LLM Observability support.
 * See PRD #11 for the semconv compliance work.
 */

import { randomUUID } from "crypto";
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
 * - Attributes: OTel GenAI semantic conventions (see below)
 *
 * Attributes captured (OTel GenAI semconv):
 * | Attribute                    | Required?   | Description                    |
 * |------------------------------|-------------|--------------------------------|
 * | gen_ai.operation.name        | Required    | Always "execute_tool"          |
 * | gen_ai.tool.name             | Required    | Tool name (e.g., kubectl_get)  |
 * | gen_ai.tool.type             | Recommended | Always "function"              |
 * | gen_ai.tool.call.id          | Recommended | Unique UUID per invocation     |
 * | gen_ai.tool.call.arguments   | Required    | JSON stringified input args    |
 *
 * Error handling:
 * - Exceptions (thrown errors): recorded with span.recordException(), status ERROR
 * - Tool failures (isError: true): span status stays OK (the tool worked, kubectl failed)
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

    // Create span manually so we can use context.with() for proper async propagation
    // startActiveSpan with async callbacks doesn't reliably propagate context
    const span = tracer.startSpan(`execute_tool ${toolName}`, {
      kind: SpanKind.INTERNAL,
    });

    // Set attributes before execution (OTel GenAI semconv)
    const inputJson = JSON.stringify(input, null, 2);
    span.setAttribute("gen_ai.operation.name", "execute_tool"); // Required
    span.setAttribute("gen_ai.tool.name", toolName); // Required
    span.setAttribute("gen_ai.tool.type", "function"); // Recommended
    span.setAttribute("gen_ai.tool.call.id", randomUUID()); // Recommended
    span.setAttribute("gen_ai.tool.call.arguments", inputJson); // Required

    // Use context.with() to ensure the span is active for all nested operations
    // This is the key fix - it properly propagates context across await boundaries
    const activeContext = trace.setSpan(context.active(), span);

    return context.with(activeContext, async () => {
      try {
        // Execute the actual tool handler (kubectl calls will inherit this context)
        const result = await handler(input);

        // Span status stays OK even if kubectl failed - the tool executed correctly
        // (Duration is captured by span timing; success/failure by span status)
        span.setStatus({ code: SpanStatusCode.OK });

        return result;
      } catch (error) {
        // Actual exception - the tool itself failed to execute
        // (Duration is captured by span timing; success/failure by span status)
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
