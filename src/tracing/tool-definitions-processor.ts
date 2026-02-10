/**
 * tool-definitions-processor.ts - Injects tool definitions into LLM chat spans
 *
 * What this file does:
 * Adds gen_ai.tool.definitions to the anthropic.chat spans created by OpenLLMetry's
 * auto-instrumentation. This tells observability tools (like Datadog's LLM Observability)
 * which tools were available to the LLM during each reasoning step.
 *
 * Why a SpanProcessor?
 * The anthropic.chat spans are created by OpenLLMetry's Anthropic SDK instrumentation —
 * we don't control their creation. A SpanProcessor intercepts spans at creation time,
 * letting us add attributes to spans we didn't create.
 *
 * How it works:
 * 1. OpenLLMetry creates an "anthropic.chat" span when the Anthropic SDK makes an API call
 * 2. Our processor's onStart() fires, checks the span name
 * 3. If it matches, we set gen_ai.tool.definitions with the tool definitions JSON
 * 4. Datadog maps this to meta.tool_definitions in the LLM Observability view
 *
 * Registration:
 * Passed to traceloop.initialize() via the `processor` option in src/tracing/index.ts.
 * OpenLLMetry adds it alongside its own internal processor, so both run on every span.
 *
 * Lazy imports:
 * Tool metadata (descriptions, schemas) is imported lazily via require() inside
 * getToolDefinitionsJson() instead of top-level imports. This breaks a circular
 * dependency chain: tracing/index → this file → tools/core → utils/kubectl →
 * tracing/index. By the time the first anthropic.chat span fires, all modules
 * are fully initialized and the require() returns complete exports.
 */

import type { Span, Context } from "@opentelemetry/api";
import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";

/** Cached JSON string — computed once on first LLM span, then reused */
let cachedToolDefinitionsJson: string | null = null;

/**
 * Build the tool definitions JSON string from core tool metadata.
 *
 * Uses the OpenAI-style format (type: "function" with nested function object)
 * which is the standard format across LLM observability tools. The parameters
 * field contains JSON Schema converted from each tool's Zod schema.
 *
 * Uses lazy require() to avoid circular dependency at module load time.
 * The result is cached — tool definitions are static and don't change at runtime.
 */
function getToolDefinitionsJson(): string {
  if (!cachedToolDefinitionsJson) {
    // Lazy imports to break circular dependency (see module docstring)
    const { zodToJsonSchema } = require("zod-to-json-schema");
    const core = require("../tools/core");

    const tools = [
      {
        name: "kubectl_get",
        description: core.kubectlGetDescription,
        schema: core.kubectlGetSchema,
      },
      {
        name: "kubectl_describe",
        description: core.kubectlDescribeDescription,
        schema: core.kubectlDescribeSchema,
      },
      {
        name: "kubectl_logs",
        description: core.kubectlLogsDescription,
        schema: core.kubectlLogsSchema,
      },
    ];

    cachedToolDefinitionsJson = JSON.stringify(
      tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: zodToJsonSchema(tool.schema),
        },
      }))
    );
  }

  return cachedToolDefinitionsJson;
}

/**
 * SpanProcessor that adds gen_ai.tool.definitions to LLM chat spans.
 *
 * Intercepts spans named "anthropic.chat" (created by OpenLLMetry's auto-instrumentation
 * of the Anthropic SDK) and sets the gen_ai.tool.definitions attribute with a JSON array
 * describing all available kubectl tools.
 *
 * Why "anthropic.chat"?
 * OpenLLMetry names its Anthropic SDK spans "anthropic.chat". These correspond to each
 * LLM API call the agent makes during the ReAct loop. Each call includes the available
 * tools, so each span should document what tools were available.
 */
export class ToolDefinitionsProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    // The OTel API Span type doesn't expose .name, but the SDK's internal
    // SpanImpl does. We cast to ReadableSpan (which has .name) to check it.
    const spanName = (span as unknown as ReadableSpan).name;

    if (spanName === "anthropic.chat") {
      span.setAttribute("gen_ai.tool.definitions", getToolDefinitionsJson());
    }
  }

  onEnd(_span: ReadableSpan): void {}
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}
