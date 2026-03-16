// ABOUTME: Unit tests for the Vercel AI SDK agent — verifies streamText config and fullStream→AgentEvent translation.
// ABOUTME: Mocks the AI SDK to test event mapping without making real LLM calls.

/**
 * Tests for the Vercel AI SDK agent implementation.
 *
 * These tests verify:
 * 1. streamText is called with the correct model, prompt, tools, and config
 * 2. fullStream parts are correctly translated to AgentEvent objects
 * 3. Extended thinking (reasoning-delta, part.text) parts produce thinking events
 * 4. Tool calls (part.input) and results (part.output) are properly mapped
 * 5. Text deltas (part.text) accumulate into a final_answer on finish-step
 * 6. Edge case: text buffer emitted when stream ends without finish-step
 *
 * SDK 6 property names (vercel/ai#8756):
 * - reasoning-delta: text (not delta)
 * - text-delta: text (not delta)
 * - tool-call: input (not args)
 * - tool-result: output (not result)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "./agent-events";

// ─── Mocks ──────────────────────────────────────────────────────────────────

/**
 * Mock fullStream — an async iterable of stream parts.
 * Each test sets this to an array of parts to simulate SDK behavior.
 */
let mockStreamParts: Array<Record<string, unknown>> = [];

/**
 * Mock streamText — captures the call args and returns a mock result
 * with a fullStream that yields the parts from mockStreamParts.
 */
const mockStreamText = vi.fn().mockImplementation(() => ({
  fullStream: (async function* () {
    for (const part of mockStreamParts) {
      yield part;
    }
  })(),
}));

const mockStepCountIs = vi.fn().mockReturnValue("step-count-predicate");

vi.mock("ai", () => ({
  streamText: mockStreamText,
  stepCountIs: mockStepCountIs,
  tool: vi.fn((def: Record<string, unknown>) => def),
}));

const mockAnthropicProvider = vi.fn().mockReturnValue("mock-anthropic-model");

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: mockAnthropicProvider,
}));

/**
 * Mock @opentelemetry/api — provides a fake tracer that we can verify
 * was passed to experimental_telemetry.tracer in the streamText call.
 */
const mockTracer = { startSpan: vi.fn(), startActiveSpan: vi.fn() };
const mockGetTracer = vi.fn().mockReturnValue(mockTracer);

vi.mock("@opentelemetry/api", () => ({
  trace: { getTracer: mockGetTracer },
}));

// Mock the Vercel tool factories
vi.mock("../tools/vercel", () => ({
  createKubectlTools: vi.fn().mockReturnValue({
    kubectl_get: { description: "mock kubectl_get" },
    kubectl_describe: { description: "mock kubectl_describe" },
    kubectl_logs: { description: "mock kubectl_logs" },
  }),
  createVectorTools: vi.fn().mockReturnValue({
    vector_search: { description: "mock vector_search" },
  }),
  createApplyTools: vi.fn().mockReturnValue({
    kubectl_apply: { description: "mock kubectl_apply" },
  }),
}));

// Mock the vector store module
vi.mock("../vectorstore", () => ({
  VoyageEmbedding: class MockVoyageEmbedding {},
  createVectorStore: vi.fn().mockReturnValue({
    initialize: vi.fn(),
    store: vi.fn(),
    search: vi.fn(),
    keywordSearch: vi.fn(),
    delete: vi.fn(),
  }),
  DEFAULT_VECTOR_BACKEND: "chroma",
}));

// Mock tracing (no-op for unit tests)
vi.mock("../tracing/tool-tracing", () => ({
  withToolTracing: (_meta: unknown, fn: Function) => fn,
}));

vi.mock("../tracing", () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: Function) => {
      const mockSpan = {
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
      };
      return fn(mockSpan);
    },
  }),
  isCaptureAiPayloads: false,
}));

// Mock fs for system prompt loading
vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue("You are a Kubernetes investigator."),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("VercelAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStreamParts = [];
  });

  describe("streamText configuration", () => {
    it("calls streamText with correct model, prompt, and config", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      mockStreamParts = [
        { type: "text-delta", text: "Hello" },
        { type: "finish-step", finishReason: "stop" },
      ];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("What pods are running?")) {
        events.push(event);
      }

      // Verify streamText was called
      expect(mockStreamText).toHaveBeenCalledOnce();

      const callArgs = mockStreamText.mock.calls[0][0];

      // Model: anthropic provider with correct model ID
      expect(mockAnthropicProvider).toHaveBeenCalledWith("claude-sonnet-4-20250514");
      expect(callArgs.model).toBe("mock-anthropic-model");

      // System prompt loaded from file
      expect(callArgs.system).toBe("You are a Kubernetes investigator.");

      // Single-turn: uses prompt (not messages)
      expect(callArgs.prompt).toBe("What pods are running?");

      // Step limit matches RECURSION_LIMIT (50)
      expect(mockStepCountIs).toHaveBeenCalledWith(50);
      expect(callArgs.stopWhen).toBe("step-count-predicate");

      // Extended thinking enabled
      expect(callArgs.providerOptions.anthropic.thinking).toEqual({
        type: "enabled",
        budgetTokens: 4000,
      });
      expect(callArgs.providerOptions.anthropic.headers).toEqual({
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      });

      // Telemetry enabled with our tracer for context propagation
      expect(callArgs.experimental_telemetry.isEnabled).toBe(true);
      expect(callArgs.experimental_telemetry.functionId).toBe(
        "cluster-whisperer-investigate"
      );
      expect(mockGetTracer).toHaveBeenCalledWith("ai");
      expect(callArgs.experimental_telemetry.tracer).toBe(mockTracer);
    });

    it("passes kubectl tools when toolGroups includes kubectl", async () => {
      const { VercelAgent } = await import("./vercel-agent");
      const { createKubectlTools } = await import("../tools/vercel");

      mockStreamParts = [
        { type: "text-delta", text: "Done" },
        { type: "finish-step", finishReason: "stop" },
      ];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("test")) {
        events.push(event);
      }

      expect(createKubectlTools).toHaveBeenCalled();

      const callArgs = mockStreamText.mock.calls[0][0];
      expect(callArgs.tools).toHaveProperty("kubectl_get");
      expect(callArgs.tools).toHaveProperty("kubectl_describe");
      expect(callArgs.tools).toHaveProperty("kubectl_logs");
    });

    it("passes vector and apply tools when requested", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      // Ensure VOYAGE_API_KEY is set for vector tool creation
      const origKey = process.env.VOYAGE_API_KEY;
      process.env.VOYAGE_API_KEY = "test-key";

      try {
        mockStreamParts = [
          { type: "text-delta", text: "Done" },
          { type: "finish-step", finishReason: "stop" },
        ];

        const agent = new VercelAgent({
          toolGroups: ["kubectl", "vector", "apply"],
        });
        const events: AgentEvent[] = [];
        for await (const event of agent.investigate("test")) {
          events.push(event);
        }

        const callArgs = mockStreamText.mock.calls[0][0];
        expect(callArgs.tools).toHaveProperty("kubectl_get");
        expect(callArgs.tools).toHaveProperty("vector_search");
        expect(callArgs.tools).toHaveProperty("kubectl_apply");
      } finally {
        process.env.VOYAGE_API_KEY = origKey;
      }
    });

    it("passes kubeconfig to kubectl tool factory", async () => {
      const { VercelAgent } = await import("./vercel-agent");
      const { createKubectlTools } = await import("../tools/vercel");

      mockStreamParts = [
        { type: "text-delta", text: "Done" },
        { type: "finish-step", finishReason: "stop" },
      ];

      const agent = new VercelAgent({
        toolGroups: ["kubectl"],
        kubeconfig: "/path/to/kubeconfig",
      });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("test")) {
        events.push(event);
      }

      expect(createKubectlTools).toHaveBeenCalledWith({
        kubeconfig: "/path/to/kubeconfig",
      });
    });
  });

  describe("fullStream → AgentEvent translation", () => {
    it("translates reasoning-delta to thinking event", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      mockStreamParts = [
        { type: "reasoning-delta", text: "Let me check the pods..." },
        { type: "text-delta", text: "Here are the pods." },
        { type: "finish-step", finishReason: "stop" },
      ];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("What pods are running?")) {
        events.push(event);
      }

      expect(events[0]).toEqual({
        type: "thinking",
        content: "Let me check the pods...",
      });
    });

    it("buffers multiple reasoning-delta fragments into a single thinking event", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      // Simulate the Vercel SDK streaming behavior where thinking arrives
      // as many small fragments (one per API chunk)
      mockStreamParts = [
        { type: "reasoning-delta", text: "The user is asking " },
        { type: "reasoning-delta", text: "me to investigate " },
        { type: "reasoning-delta", text: "their application." },
        { type: "tool-call", toolName: "kubectl_get", toolCallId: "call-1", input: { resource: "pods" } },
        { type: "finish-step", finishReason: "tool-calls" },
        { type: "tool-result", toolName: "kubectl_get", toolCallId: "call-1", output: "pod-1 Running" },
        { type: "reasoning-delta", text: "Now I see " },
        { type: "reasoning-delta", text: "the pods are fine." },
        { type: "text-delta", text: "All good." },
        { type: "finish-step", finishReason: "stop" },
      ];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("What's wrong?")) {
        events.push(event);
      }

      // Should produce exactly 2 thinking events (one per thought block),
      // not 5 (one per fragment)
      const thinkingEvents = events.filter((e) => e.type === "thinking");
      expect(thinkingEvents).toHaveLength(2);
      expect(thinkingEvents[0]).toEqual({
        type: "thinking",
        content: "The user is asking me to investigate their application.",
      });
      expect(thinkingEvents[1]).toEqual({
        type: "thinking",
        content: "Now I see the pods are fine.",
      });
    });

    it("translates tool-call to tool_start event", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      mockStreamParts = [
        {
          type: "tool-call",
          toolName: "kubectl_get",
          toolCallId: "call-123",
          input: { resource: "pods", namespace: "default" },
        },
        {
          type: "tool-result",
          toolName: "kubectl_get",
          toolCallId: "call-123",
          output: "NAME  READY  STATUS\npod-1  1/1  Running",
        },
        { type: "text-delta", text: "The pods are running." },
        { type: "finish-step", finishReason: "stop" },
      ];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("What pods are running?")) {
        events.push(event);
      }

      expect(events[0]).toEqual({
        type: "tool_start",
        toolName: "kubectl_get",
        args: { resource: "pods", namespace: "default" },
      });
    });

    it("translates tool-result to tool_result event", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      mockStreamParts = [
        {
          type: "tool-call",
          toolName: "kubectl_get",
          toolCallId: "call-123",
          input: { resource: "pods" },
        },
        {
          type: "tool-result",
          toolName: "kubectl_get",
          toolCallId: "call-123",
          output: "NAME  READY  STATUS\npod-1  1/1  Running",
        },
        { type: "text-delta", text: "Done" },
        { type: "finish-step", finishReason: "stop" },
      ];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("test")) {
        events.push(event);
      }

      expect(events[1]).toEqual({
        type: "tool_result",
        toolName: "kubectl_get",
        result: "NAME  READY  STATUS\npod-1  1/1  Running",
      });
    });

    it("accumulates text-delta into final_answer on finish-step with stop", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      mockStreamParts = [
        { type: "text-delta", text: "The cluster " },
        { type: "text-delta", text: "looks healthy." },
        { type: "finish-step", finishReason: "stop" },
      ];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("test")) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "final_answer", content: "The cluster looks healthy." },
      ]);
    });

    it("does not emit final_answer on finish-step with tool-calls reason", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      mockStreamParts = [
        { type: "text-delta", text: "Let me check..." },
        { type: "finish-step", finishReason: "tool-calls" },
        {
          type: "tool-call",
          toolName: "kubectl_get",
          toolCallId: "call-1",
          input: { resource: "pods" },
        },
        {
          type: "tool-result",
          toolName: "kubectl_get",
          toolCallId: "call-1",
          output: "pods list",
        },
        { type: "text-delta", text: "All good." },
        { type: "finish-step", finishReason: "stop" },
      ];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("test")) {
        events.push(event);
      }

      // The first text-delta ("Let me check...") should be cleared on tool-calls finish
      // Only the final "All good." should become a final_answer
      const finalAnswers = events.filter((e) => e.type === "final_answer");
      expect(finalAnswers).toHaveLength(1);
      expect(finalAnswers[0]).toEqual({
        type: "final_answer",
        content: "All good.",
      });
    });

    it("emits buffered text as final_answer when stream ends without finish-step", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      mockStreamParts = [
        { type: "text-delta", text: "Final text without finish." },
      ];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("test")) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "final_answer", content: "Final text without finish." },
      ]);
    });

    it("handles a complete multi-step investigation flow", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      mockStreamParts = [
        // Step 1: thinking + tool call
        { type: "reasoning-delta", text: "I should check the pods first." },
        {
          type: "tool-call",
          toolName: "kubectl_get",
          toolCallId: "call-1",
          input: { resource: "pods", namespace: "all" },
        },
        { type: "finish-step", finishReason: "tool-calls" },

        // Tool result
        {
          type: "tool-result",
          toolName: "kubectl_get",
          toolCallId: "call-1",
          output: "pod-1 CrashLoopBackOff",
        },

        // Step 2: thinking + describe
        { type: "reasoning-delta", text: "pod-1 is crashing. Let me describe it." },
        {
          type: "tool-call",
          toolName: "kubectl_describe",
          toolCallId: "call-2",
          input: { resource: "pod", name: "pod-1" },
        },
        { type: "finish-step", finishReason: "tool-calls" },

        {
          type: "tool-result",
          toolName: "kubectl_describe",
          toolCallId: "call-2",
          output: "Error: missing database connection",
        },

        // Step 3: final answer
        {
          type: "reasoning-delta",
          text: "The database connection is missing.",
        },
        { type: "text-delta", text: "Your pod is crashing because " },
        { type: "text-delta", text: "the database is not configured." },
        { type: "finish-step", finishReason: "stop" },
      ];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("Why is my app broken?")) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "thinking", content: "I should check the pods first." },
        {
          type: "tool_start",
          toolName: "kubectl_get",
          args: { resource: "pods", namespace: "all" },
        },
        {
          type: "tool_result",
          toolName: "kubectl_get",
          result: "pod-1 CrashLoopBackOff",
        },
        { type: "thinking", content: "pod-1 is crashing. Let me describe it." },
        {
          type: "tool_start",
          toolName: "kubectl_describe",
          args: { resource: "pod", name: "pod-1" },
        },
        {
          type: "tool_result",
          toolName: "kubectl_describe",
          result: "Error: missing database connection",
        },
        { type: "thinking", content: "The database connection is missing." },
        {
          type: "final_answer",
          content:
            "Your pod is crashing because the database is not configured.",
        },
      ]);
    });

    it("stringifies non-string tool results", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      mockStreamParts = [
        {
          type: "tool-call",
          toolName: "kubectl_get",
          toolCallId: "call-1",
          input: { resource: "pods" },
        },
        {
          type: "tool-result",
          toolName: "kubectl_get",
          toolCallId: "call-1",
          output: { name: "pod-1", status: "Running" },
        },
        { type: "text-delta", text: "Done" },
        { type: "finish-step", finishReason: "stop" },
      ];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const events: AgentEvent[] = [];
      for await (const event of agent.investigate("test")) {
        events.push(event);
      }

      const toolResult = events.find((e) => e.type === "tool_result");
      expect(toolResult).toBeDefined();
      // Non-string result should be stringified
      expect(typeof (toolResult as { result: string }).result).toBe("string");
    });
  });

  describe("investigate() method contract", () => {
    it("returns an AsyncGenerator", async () => {
      const { VercelAgent } = await import("./vercel-agent");

      mockStreamParts = [];

      const agent = new VercelAgent({ toolGroups: ["kubectl"] });
      const generator = agent.investigate("test");

      expect(generator[Symbol.asyncIterator]).toBeDefined();

      // Clean up the generator
      await generator.return(undefined as never);
    });
  });
});
