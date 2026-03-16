// ABOUTME: Unit tests for VercelSpanProcessor — verifies gen_ai.operation.name enrichment for Datadog LLM Obs layers.
// ABOUTME: Tests that Vercel SDK spans get correct operation names based on ai.operationId attribute.

/**
 * Tests for the VercelSpanProcessor.
 *
 * The processor enriches Vercel AI SDK spans with gen_ai.operation.name so
 * Datadog LLM Observability classifies them into the correct layers:
 * - ai.streamText.doStream → gen_ai.operation.name: "chat" → Datadog: llm
 * - ai.streamText → gen_ai.operation.name: "invoke_agent" → Datadog: agent
 * - ai.toolCall → already has execute_tool, no change needed
 *
 * See docs/research/49-m7-datadog-llmobs-otel-mapping.md for the full
 * Datadog mapping table and rationale (Decisions 16-19).
 */

import { describe, it, expect, vi } from "vitest";
import { VercelSpanProcessor } from "./vercel-span-processor";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/**
 * Create a mock span that simulates OTel SDK Span behavior.
 * The processor reads span name via casting to ReadableSpan,
 * and reads/writes attributes via getAttribute/setAttribute.
 */
function createMockSpan(
  name: string,
  initialAttributes: Record<string, unknown> = {}
) {
  const attributes: Record<string, unknown> = { ...initialAttributes };

  return {
    // ReadableSpan interface — processor reads span name and attributes via cast
    name,
    attributes,
    // Span interface — processor sets attributes
    setAttribute: vi.fn((key: string, value: unknown) => {
      attributes[key] = value;
    }),
  };
}

describe("VercelSpanProcessor", () => {
  const processor = new VercelSpanProcessor();
  const emptyContext = {} as never;

  describe("onStart — LLM span enrichment", () => {
    it("adds gen_ai.operation.name 'chat' to ai.streamText.doStream spans", () => {
      const span = createMockSpan("text.stream", {
        "ai.operationId": "ai.streamText.doStream",
      });

      processor.onStart(span as never, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(
        "gen_ai.operation.name",
        "chat"
      );
    });

    it("does not overwrite existing gen_ai.operation.name", () => {
      const span = createMockSpan("text.stream", {
        "ai.operationId": "ai.streamText.doStream",
        "gen_ai.operation.name": "text_completion",
      });

      processor.onStart(span as never, emptyContext);

      // Should not be called — attribute already exists
      expect(span.setAttribute).not.toHaveBeenCalledWith(
        "gen_ai.operation.name",
        expect.anything()
      );
    });
  });

  describe("onStart — Agent span enrichment", () => {
    it("adds gen_ai.operation.name 'invoke_agent' to ai.streamText spans", () => {
      const span = createMockSpan("vercel.agent", {
        "ai.operationId": "ai.streamText",
      });

      processor.onStart(span as never, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(
        "gen_ai.operation.name",
        "invoke_agent"
      );
    });

    it("adds gen_ai.agent.name to ai.streamText spans", () => {
      const span = createMockSpan("vercel.agent", {
        "ai.operationId": "ai.streamText",
      });

      processor.onStart(span as never, emptyContext);

      expect(span.setAttribute).toHaveBeenCalledWith(
        "gen_ai.agent.name",
        "cluster-whisperer"
      );
    });

    it("does not overwrite existing gen_ai.operation.name on agent spans", () => {
      const span = createMockSpan("vercel.agent", {
        "ai.operationId": "ai.streamText",
        "gen_ai.operation.name": "create_agent",
      });

      processor.onStart(span as never, emptyContext);

      expect(span.setAttribute).not.toHaveBeenCalledWith(
        "gen_ai.operation.name",
        expect.anything()
      );
    });
  });

  describe("onStart — non-Vercel spans", () => {
    it("does not modify spans without ai.operationId", () => {
      const span = createMockSpan("anthropic.chat", {});

      processor.onStart(span as never, emptyContext);

      expect(span.setAttribute).not.toHaveBeenCalled();
    });

    it("does not modify ai.toolCall spans (already have execute_tool)", () => {
      const span = createMockSpan("cluster-whisperer-investigate", {
        "ai.operationId": "ai.toolCall",
        "gen_ai.operation.name": "execute_tool",
      });

      processor.onStart(span as never, emptyContext);

      // setAttribute should not be called for gen_ai.operation.name
      expect(span.setAttribute).not.toHaveBeenCalledWith(
        "gen_ai.operation.name",
        expect.anything()
      );
    });

    it("does not modify our withToolTracing spans", () => {
      const span = createMockSpan("kubectl_get.tool", {
        "gen_ai.operation.name": "execute_tool",
      });

      processor.onStart(span as never, emptyContext);

      expect(span.setAttribute).not.toHaveBeenCalled();
    });

    it("does not modify LangChain workflow spans", () => {
      const span = createMockSpan("CompiledStateGraph.workflow", {
        "traceloop.span.kind": "workflow",
      });

      processor.onStart(span as never, emptyContext);

      expect(span.setAttribute).not.toHaveBeenCalled();
    });
  });

  describe("SpanProcessor interface compliance", () => {
    it("implements onEnd as no-op", () => {
      const span = createMockSpan("test") as unknown as ReadableSpan;
      expect(() => processor.onEnd(span)).not.toThrow();
    });

    it("implements shutdown", async () => {
      await expect(processor.shutdown()).resolves.toBeUndefined();
    });

    it("implements forceFlush", async () => {
      await expect(processor.forceFlush()).resolves.toBeUndefined();
    });
  });
});
