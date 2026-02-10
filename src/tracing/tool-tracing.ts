/**
 * tool-tracing.ts - OpenTelemetry instrumentation for tool calls
 *
 * What this file does:
 * Provides a wrapper function that adds tracing to any tool handler (MCP or LangChain).
 * When a tool is called, it creates a span with timing, inputs, and success/failure info.
 *
 * Architecture: Uses OpenLLMetry's withTool wrapper + context bridge
 * We use OpenLLMetry's official withTool function, but wrap it with our context bridge
 * to fix LangGraph's broken async context propagation.
 *
 * Why the context bridge?
 * LangGraph breaks Node.js async context, so tool spans end up orphaned in separate
 * traces. Our withStoredContext restores the parent context that was stored at agent
 * invocation, ensuring proper nesting:
 *
 *   cluster-whisperer.investigate (context-bridge root span)
 *   └── kubectl_get.tool (our withTool wrapper, properly parented)
 *       └── kubectl get pods (kubectl.ts span)
 *
 * Workaround status:
 * This is a temporary fix until OpenLLMetry-JS supports LangGraph natively.
 * Track progress: https://github.com/traceloop/openllmetry-js/issues/476
 *
 * The withTool wrapper handles:
 * - Creating spans with proper parent context
 * - Setting span attributes according to OpenLLMetry conventions
 * - Error handling and status codes
 * - Async context propagation
 */

import { trace } from "@opentelemetry/api";
import { randomUUID } from "crypto";
import { withTool } from "./index";
import { withStoredContext } from "./context-bridge";

/**
 * Configuration for OpenLLMetry's withTool wrapper.
 *
 * OpenLLMetry's DecoratorConfig interface accepts:
 * - name: The tool name (required)
 * - version: Optional version number
 * - associationProperties: Optional key-value pairs for correlation
 * - traceContent: Whether to capture input/output content
 * - inputParameters: Parameters to log (we avoid this for privacy)
 */
interface ToolConfig {
  name: string;
}

/**
 * Wraps a tool handler with OpenTelemetry tracing using OpenLLMetry's withTool.
 *
 * This is the official way to create tool spans that integrate with OpenLLMetry's
 * auto-instrumented LLM spans. The wrapper:
 * - Creates a span for each tool invocation
 * - Automatically parents it under the active LLM span (if any)
 * - Propagates trace context to nested spans (like kubectl subprocess calls)
 *
 * @param toolName - The name of the tool (e.g., "kubectl_get")
 * @param handler - The async function that executes the tool logic
 * @returns A wrapped handler that traces the execution
 *
 * @example
 * ```typescript
 * const tracedHandler = withToolTracing("kubectl_get", async (input) => {
 *   return executeKubectl(["get", input.resource]);
 * });
 * ```
 */
export function withToolTracing<TInput, TResult>(
  toolName: string,
  handler: (input: TInput) => Promise<TResult>
): (input: TInput) => Promise<TResult> {
  return async (input: TInput): Promise<TResult> => {
    // Use withStoredContext to restore the parent context that LangGraph broke
    // This ensures the tool span parents under the root investigation span
    return withStoredContext(() => {
      // Use OpenLLMetry's withTool wrapper inside the restored context
      // This creates a properly-parented span and handles context propagation
      return withTool({ name: toolName }, async () => {
        // Add OTel GenAI semantic convention attributes to the span that
        // withTool() just created. This makes tool spans visible in Datadog's
        // LLM Observability view, which requires gen_ai.* attributes.
        // We keep both namespaces: traceloop.* (set by withTool) for OpenLLMetry
        // ecosystem compatibility + gen_ai.* for OTel GenAI spec compliance.
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
          activeSpan.setAttribute("gen_ai.operation.name", "execute_tool");
          activeSpan.setAttribute("gen_ai.tool.name", toolName);
          activeSpan.setAttribute("gen_ai.tool.type", "function");
          activeSpan.setAttribute("gen_ai.tool.call.id", randomUUID());
        }

        return handler(input);
      });
    });
  };
}
