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
import { withTool, isCaptureAiPayloads } from "./index";
import { withStoredContext } from "./context-bridge";

/**
 * Configuration for tool tracing.
 *
 * Extends beyond OpenLLMetry's DecoratorConfig to include OTel GenAI
 * semantic convention fields. The name is used by both OpenLLMetry's
 * withTool() and our gen_ai.tool.name attribute. The description maps
 * to gen_ai.tool.description for Datadog's LLM Observability metadata panel.
 */
interface ToolConfig {
  name: string;
  description: string;
}

/**
 * Wraps a tool handler with OpenTelemetry tracing using OpenLLMetry's withTool.
 *
 * This is the official way to create tool spans that integrate with OpenLLMetry's
 * auto-instrumented LLM spans. The wrapper:
 * - Creates a span for each tool invocation
 * - Automatically parents it under the active LLM span (if any)
 * - Sets OTel GenAI semantic convention attributes for Datadog LLM Observability
 * - Propagates trace context to nested spans (like kubectl subprocess calls)
 *
 * @param config - Tool configuration (name and description)
 * @param handler - The async function that executes the tool logic
 * @returns A wrapped handler that traces the execution
 *
 * @example
 * ```typescript
 * const tracedHandler = withToolTracing(
 *   { name: "kubectl_get", description: "List Kubernetes resources..." },
 *   async (input) => {
 *     return executeKubectl(["get", input.resource]);
 *   }
 * );
 * ```
 */
export function withToolTracing<TInput, TResult>(
  config: ToolConfig,
  handler: (input: TInput) => Promise<TResult>
): (input: TInput) => Promise<TResult> {
  return async (input: TInput): Promise<TResult> => {
    // Use withStoredContext to restore the parent context that LangGraph broke
    // This ensures the tool span parents under the root investigation span
    return withStoredContext(() => {
      // Use OpenLLMetry's withTool wrapper inside the restored context
      // This creates a properly-parented span and handles context propagation
      return withTool({ name: config.name }, async () => {
        // Add OTel GenAI semantic convention attributes to the span that
        // withTool() just created. This makes tool spans visible in Datadog's
        // LLM Observability view, which requires gen_ai.* attributes.
        // We keep both namespaces: traceloop.* (set by withTool) for OpenLLMetry
        // ecosystem compatibility + gen_ai.* for OTel GenAI spec compliance.
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
          activeSpan.setAttribute("gen_ai.operation.name", "execute_tool");
          activeSpan.setAttribute("gen_ai.tool.name", config.name);
          activeSpan.setAttribute("gen_ai.tool.type", "function");
          activeSpan.setAttribute("gen_ai.tool.call.id", randomUUID());
          activeSpan.setAttribute("gen_ai.tool.description", config.description);

          // Opt-in content attributes: tool input as JSON string
          // Gated behind OTEL_CAPTURE_AI_PAYLOADS to prevent accidental data exposure
          if (isCaptureAiPayloads) {
            activeSpan.setAttribute(
              "gen_ai.tool.call.arguments",
              JSON.stringify(input)
            );
          }
        }

        const result = await handler(input);

        // Opt-in content attribute: tool output as string
        // Set after execution so we capture the actual result
        if (activeSpan && isCaptureAiPayloads) {
          activeSpan.setAttribute(
            "gen_ai.tool.call.result",
            typeof result === "string" ? result : JSON.stringify(result)
          );
        }

        return result;
      });
    });
  };
}
