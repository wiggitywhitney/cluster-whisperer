// ABOUTME: SpanProcessor that enriches Vercel AI SDK spans with gen_ai.operation.name for Datadog LLM Obs.
// ABOUTME: Maps ai.operationId to correct Datadog layers: doStream→llm, streamText→agent.

/**
 * vercel-span-processor.ts - Enriches Vercel SDK spans for Datadog LLM Observability
 *
 * What this file does:
 * Adds gen_ai.operation.name to Vercel AI SDK spans so Datadog classifies them
 * into the correct LLM Observability layers (agent, llm, tool, workflow).
 *
 * Why a SpanProcessor?
 * The Vercel AI SDK's experimental_telemetry creates spans with rich gen_ai.*
 * attributes (model, tokens, messages) but does NOT set gen_ai.operation.name.
 * Without this attribute, Datadog defaults all spans to "workflow" regardless
 * of their actual role. A SpanProcessor intercepts spans at creation time,
 * letting us add the missing attribute to spans we didn't create.
 *
 * How it works:
 * 1. SDK creates a span (e.g., text.stream) with ai.operationId attribute
 * 2. Our processor's onStart() fires, reads ai.operationId
 * 3. Maps the operation to the correct gen_ai.operation.name:
 *    - ai.streamText.doStream → "chat" → Datadog: llm layer
 *    - ai.streamText → "invoke_agent" → Datadog: agent layer
 *    - ai.toolCall → already has "execute_tool", skip
 * 4. Datadog ingests the span and classifies it correctly
 *
 * The mapping is based on the Datadog OTel instrumentation docs:
 * https://docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/
 * See also: docs/research/49-m7-datadog-llmobs-otel-mapping.md
 *
 * Registration:
 * Passed to traceloop.initialize() via the `processor` option in src/tracing/index.ts,
 * composed with the existing ToolDefinitionsProcessor using a MultiSpanProcessor.
 */

import type { Span, Context } from "@opentelemetry/api";
import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";

/**
 * SpanProcessor that adds gen_ai.operation.name to Vercel AI SDK spans.
 *
 * Intercepts spans with ai.operationId attributes (set by the SDK's
 * experimental_telemetry) and adds the gen_ai.operation.name that Datadog
 * uses for LLM Observability layer classification.
 *
 * Does NOT modify spans that already have gen_ai.operation.name set —
 * this prevents conflicts with our withToolTracing spans and any future
 * SDK versions that set the attribute themselves.
 */
export class VercelSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    // ReadableSpan exposes attributes; OTel API Span does not.
    // Cast to access the attributes map directly.
    const readableSpan = span as unknown as ReadableSpan;
    const attributes = readableSpan.attributes ?? {};

    const operationId = attributes["ai.operationId"];
    if (!operationId) return;

    // Skip if gen_ai.operation.name is already set (e.g., ai.toolCall spans
    // that the SDK already marks as execute_tool, or our withToolTracing spans)
    if (attributes["gen_ai.operation.name"]) return;

    if (operationId === "ai.streamText.doStream") {
      // Per-step LLM call — classify as "chat" → Datadog: llm layer
      span.setAttribute("gen_ai.operation.name", "chat");
    } else if (operationId === "ai.streamText") {
      // Outer agent wrapper — classify as "invoke_agent" → Datadog: agent layer
      span.setAttribute("gen_ai.operation.name", "invoke_agent");
      span.setAttribute("gen_ai.agent.name", "cluster-whisperer");
    }
  }

  onEnd(_span: ReadableSpan): void {}
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}
