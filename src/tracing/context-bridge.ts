/**
 * context-bridge.ts - Bridge OpenTelemetry context across async boundaries
 *
 * What this file does:
 * LangGraph's execution model breaks Node.js async context propagation, causing
 * tool spans to end up in separate traces instead of nesting under the workflow.
 * This module uses AsyncLocalStorage to manually bridge the context gap.
 *
 * Why is this needed?
 * OpenLLMetry-JS doesn't officially support LangGraph (GitHub Issue #476).
 * When LangGraph calls tool handlers, the OpenTelemetry async context is lost.
 * Our solution: store the root context at agent invocation, retrieve it in tools.
 *
 * Workaround status:
 * This is a temporary workaround. The Python SDK fixed the same issue in PR #3206:
 * https://github.com/traceloop/openllmetry/pull/3206
 * When the JS SDK gets a similar fix, this file can be removed.
 * Track progress: https://github.com/traceloop/openllmetry-js/issues/476
 *
 * Architecture:
 *   1. Before calling agent.streamEvents(), we create a root span
 *   2. Store that span's context in AsyncLocalStorage
 *   3. Tool handlers retrieve this context and use it as their parent
 *   4. Result: all tool spans nest under the root investigation span
 *
 * Trace hierarchy achieved:
 *   cluster-whisperer.investigate (our root span)
 *   ├── kubectl_get.tool (properly parented)
 *   │   └── kubectl get pods
 *   ├── kubectl_describe.tool
 *   │   └── kubectl describe pod
 *   └── ...
 */

import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import {
  Context,
  context,
  trace,
  Span,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import { getTracer, isCaptureAiPayloads } from "./index";

/**
 * MCP tool result format per Model Context Protocol specification.
 *
 * MCP tools return results as a content array with optional error flag.
 * The isError flag signals logical errors (e.g., kubectl failed) without
 * throwing exceptions, allowing the MCP client to handle errors gracefully.
 *
 * Type compatibility notes:
 * - `type: "text"` uses literal type to satisfy MCP SDK's strict typing
 * - Index signature `[key: string]: unknown` allows arbitrary extra fields
 *   (MCP SDK's CallToolResult requires this for extensibility)
 */
export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * AsyncLocalStorage instance for storing trace context.
 *
 * AsyncLocalStorage is Node.js's solution for passing context through async
 * operations. It's what OpenTelemetry uses internally, but LangGraph breaks
 * the chain. We create our own storage to bridge the gap.
 */
const contextStorage = new AsyncLocalStorage<Context>();

/**
 * Store for the root span so we can add output attribute after completion.
 */
const rootSpanStorage = new AsyncLocalStorage<Span>();

/**
 * Set the output on the root investigation span.
 * Call this after the agent completes to populate OUTPUT in LLM Observability.
 *
 * Only writes the attribute if OTEL_CAPTURE_AI_PAYLOADS=true to prevent
 * sensitive data from being exported to telemetry backends.
 *
 * @param output - The final answer or output to record
 */
export function setTraceOutput(output: string): void {
  const span = rootSpanStorage.getStore();
  if (span && isCaptureAiPayloads) {
    span.setAttribute("traceloop.entity.output", output);
  }
}

/**
 * Get the stored trace context.
 *
 * Returns the context stored during agent invocation, or the current
 * active context if none was stored (fallback for non-agent scenarios).
 */
export function getStoredContext(): Context {
  return contextStorage.getStore() ?? context.active();
}

/**
 * Run a function with the stored context as the active context.
 *
 * This is the key function for fixing trace propagation. When a tool handler
 * calls this, the stored context becomes active, and any spans created inside
 * will properly parent under the root span.
 *
 * @param fn - The function to run with the stored context
 * @returns The result of the function
 */
export function withStoredContext<T>(fn: () => T): T {
  const storedCtx = getStoredContext();
  return context.with(storedCtx, fn);
}

/**
 * Run an agent invocation with proper trace context bridging.
 *
 * This is the main entry point for traced agent invocations. It:
 * 1. Creates a root span for the entire investigation
 * 2. Stores the context in AsyncLocalStorage
 * 3. Runs the agent function
 * 4. Properly ends the span with success/error status
 *
 * @param question - The user's question (used in span attributes)
 * @param fn - The async function that runs the agent
 * @returns The result of the agent function
 *
 * @example
 * ```typescript
 * await withAgentTracing("Find broken pods", async () => {
 *   for await (const event of agent.streamEvents(...)) {
 *     // Process events
 *   }
 * });
 * ```
 */
export async function withAgentTracing<T>(
  question: string,
  fn: () => Promise<T>
): Promise<T> {
  const tracer = getTracer();

  // Create a root span for the entire investigation
  // Build attributes conditionally - only include content if trace content is enabled
  const attributes: Record<string, string> = {
    "cluster_whisperer.service.operation": "investigate",
    "traceloop.span.kind": "workflow",
    "traceloop.entity.name": "investigate",
  };

  // Only include user question and entity input if trace content capture is enabled
  // This prevents sensitive data from being exported to telemetry backends
  if (isCaptureAiPayloads) {
    attributes["cluster_whisperer.user.question"] = question;
    attributes["traceloop.entity.input"] = question;
  }

  return tracer.startActiveSpan(
    "cluster-whisperer.investigate",
    {
      kind: SpanKind.INTERNAL,
      attributes,
    },
    async (span: Span) => {
      // Store this context in AsyncLocalStorage so tool handlers can access it
      // This bridges the context gap that LangGraph creates
      const currentContext = trace.setSpan(context.active(), span);

      try {
        // Run the agent function with both context and span stored in AsyncLocalStorage
        // The span storage allows setTraceOutput() to add the OUTPUT attribute later
        const result = await rootSpanStorage.run(span, () =>
          contextStorage.run(currentContext, fn)
        );
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        // Record the error on the span
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Run an MCP tool request with proper trace context bridging.
 *
 * This is the entry point for traced MCP tool invocations. It mirrors
 * withAgentTracing() but with MCP-specific attributes:
 * - GenAI semantic conventions for Datadog LLM Observability integration
 * - MCP-specific attributes (mcp.tool.name)
 * - Tool input/output instead of user question
 *
 * MCP Result Handling:
 * MCP tools return `{ content: [...], isError?: boolean }`. The isError flag
 * signals logical errors (e.g., kubectl command failed) without throwing.
 * This function inspects the result to set appropriate span status:
 * - isError=true → SpanStatusCode.ERROR with message from content
 * - isError=false/undefined → SpanStatusCode.OK
 *
 * The span hierarchy for MCP mode:
 *   cluster-whisperer.mcp.<toolName> (this root span)
 *   └── <toolName>.tool (created by withToolTracing)
 *       └── kubectl <op> <resource> (subprocess span)
 *
 * @param toolName - The MCP tool name (e.g., "kubectl_get")
 * @param input - The tool input parameters
 * @param fn - The async function that executes the tool
 * @returns The MCP tool result with content array and optional error flag
 *
 * @example
 * ```typescript
 * const result = await withMcpRequestTracing("kubectl_get", { resource: "pods" }, async () => {
 *   return withToolTracing("kubectl_get", async () => {
 *     return kubectlGet(input);
 *   })(input);
 * });
 * ```
 */
export async function withMcpRequestTracing(
  toolName: string,
  input: Record<string, unknown>,
  fn: () => Promise<McpToolResult>
): Promise<McpToolResult> {
  const tracer = getTracer();

  // Build attributes for MCP tool execution
  // Combines OpenLLMetry conventions with GenAI semantic conventions
  const attributes: Record<string, string> = {
    // OpenLLMetry conventions (for Traceloop ecosystem compatibility)
    "cluster_whisperer.service.operation": toolName,
    "traceloop.span.kind": "workflow",
    "traceloop.entity.name": toolName,
    // MCP-specific identification (namespaced to avoid conflicts)
    "cluster_whisperer.mcp.tool.name": toolName,
    // GenAI semantic conventions (for Datadog LLM Observability)
    // See: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.type": "function",
    "gen_ai.tool.call.id": randomUUID(),
  };

  // Only include tool input if trace content capture is enabled
  // This prevents sensitive data from being exported to telemetry backends
  if (isCaptureAiPayloads) {
    attributes["traceloop.entity.input"] = JSON.stringify(input);
  }

  return tracer.startActiveSpan(
    `cluster-whisperer.mcp.${toolName}`,
    {
      kind: SpanKind.INTERNAL,
      attributes,
    },
    async (span: Span) => {
      // Store context in AsyncLocalStorage for child span parenting
      // This bridges the context gap so tool spans nest properly
      const currentContext = trace.setSpan(context.active(), span);

      try {
        // Run the tool function with both context and span stored
        const result = await rootSpanStorage.run(span, () =>
          contextStorage.run(currentContext, fn)
        );

        // Extract text content from MCP result for output attribute and error message
        const textContent = result.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n");

        // Check MCP error flag - logical error without exception
        // kubectl failures (non-zero exit) set isError=true but don't throw
        if (result.isError) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: textContent || "MCP tool returned error",
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        // Record output content if trace content capture is enabled
        if (isCaptureAiPayloads && textContent) {
          span.setAttribute("traceloop.entity.output", textContent);
        }

        return result;
      } catch (error) {
        // Record thrown exceptions (different from MCP isError flag)
        // This handles unexpected errors like network failures or bugs
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      } finally {
        span.end();
      }
    }
  );
}
