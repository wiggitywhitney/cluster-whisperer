// ABOUTME: Unit tests for the LangGraphAdapter — verifies translation of LangGraph events to AgentEvent.
// ABOUTME: Mocks the LangGraph agent's streamEvents() and checkpointer lifecycle.

/**
 * Tests for the LangGraphAdapter.
 *
 * The adapter translates LangGraph's v2 streamEvents format into the
 * framework-agnostic AgentEvent union type. These tests verify each
 * event translation path:
 * - thinking blocks → ThinkingEvent
 * - tool_calls → ToolStartEvent
 * - tool result messages → ToolResultEvent
 * - text blocks without tool_calls → FinalAnswerEvent
 *
 * Memory lifecycle tests verify that the adapter handles conversation
 * persistence internally (load before, save after).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "./agent-events";

// Mock file-checkpointer before importing the adapter
vi.mock("./file-checkpointer", () => ({
  loadCheckpointer: vi.fn().mockReturnValue({
    storage: {},
    writes: {},
  }),
  saveCheckpointer: vi.fn(),
}));

// Mock the investigator module
const mockStreamEvents = vi.fn();
const mockGetInvestigatorAgent = vi.fn().mockReturnValue({
  streamEvents: mockStreamEvents,
});

vi.mock("./investigator", () => ({
  getInvestigatorAgent: (...args: unknown[]) => mockGetInvestigatorAgent(...args),
  RECURSION_LIMIT: 50,
  truncate: (text: string, maxLength: number = 1100) =>
    text.length <= maxLength ? text : text.slice(0, maxLength) + "...",
}));

vi.mock("@langchain/core/messages", () => ({
  HumanMessage: class MockHumanMessage {
    content: string;
    constructor(content: string) {
      this.content = content;
    }
  },
}));

describe("LangGraphAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper: creates a mock async iterable from an array of LangGraph events.
   * This simulates the streamEvents() output.
   */
  function mockEventStream(events: Array<{ event: string; data?: unknown }>) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
    };
  }

  /**
   * Helper: collects all AgentEvent objects from an AsyncGenerator.
   */
  async function collectEvents(
    gen: AsyncGenerator<AgentEvent>
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of gen) {
      events.push(event);
    }
    return events;
  }

  it("emits thinking event for thinking content blocks", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  {
                    content: [
                      { type: "thinking", thinking: "Let me check the pods" },
                    ],
                    tool_calls: [{ name: "kubectl_get", args: { resource: "pods" } }],
                  },
                ],
              },
            },
          },
        },
        // Final answer to complete the generator
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  {
                    content: [{ type: "text", text: "Here are the pods." }],
                  },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const adapter = new LangGraphAdapter({});
    const events = await collectEvents(adapter.investigate("What pods?"));

    const thinkingEvents = events.filter((e) => e.type === "thinking");
    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0]).toEqual({
      type: "thinking",
      content: "Let me check the pods",
    });
  });

  it("emits tool_start event for tool_calls", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  {
                    content: [{ type: "text", text: "" }],
                    tool_calls: [
                      {
                        name: "kubectl_get",
                        args: { resource: "pods", namespace: "default" },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  { content: [{ type: "text", text: "Done." }] },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const adapter = new LangGraphAdapter({});
    const events = await collectEvents(adapter.investigate("What pods?"));

    const toolStartEvents = events.filter((e) => e.type === "tool_start");
    expect(toolStartEvents).toHaveLength(1);
    expect(toolStartEvents[0]).toEqual({
      type: "tool_start",
      toolName: "kubectl_get",
      args: { resource: "pods", namespace: "default" },
    });
  });

  it("emits tool_result event for tool result messages", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              tools: {
                messages: [
                  { content: "NAME   READY   STATUS\npod-1   1/1     Running", name: "kubectl_get" },
                ],
              },
            },
          },
        },
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  { content: [{ type: "text", text: "Pods are running." }] },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const adapter = new LangGraphAdapter({});
    const events = await collectEvents(adapter.investigate("What pods?"));

    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    expect(toolResultEvents).toHaveLength(1);
    expect(toolResultEvents[0]).toEqual({
      type: "tool_result",
      toolName: "kubectl_get",
      result: "NAME   READY   STATUS\npod-1   1/1     Running",
    });
  });

  it("emits final_answer event for text blocks without tool_calls", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  {
                    content: [
                      { type: "text", text: "There are 3 pods running." },
                    ],
                  },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const adapter = new LangGraphAdapter({});
    const events = await collectEvents(adapter.investigate("What pods?"));

    const finalEvents = events.filter((e) => e.type === "final_answer");
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0]).toEqual({
      type: "final_answer",
      content: "There are 3 pods running.",
    });
  });

  it("handles string content as final_answer", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  {
                    content: "Simple string answer",
                  },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const adapter = new LangGraphAdapter({});
    const events = await collectEvents(adapter.investigate("What pods?"));

    const finalEvents = events.filter((e) => e.type === "final_answer");
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0]).toEqual({
      type: "final_answer",
      content: "Simple string answer",
    });
  });

  it("does not emit final_answer for whitespace-only content", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  {
                    content: [{ type: "text", text: "   \n  " }],
                  },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const adapter = new LangGraphAdapter({});
    const events = await collectEvents(adapter.investigate("test"));

    const finalEvents = events.filter((e) => e.type === "final_answer");
    expect(finalEvents).toHaveLength(0);
  });

  it("emits events in correct order for a full investigation", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        // Step 1: Agent thinks and decides to call kubectl_get
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  {
                    content: [
                      { type: "thinking", thinking: "I should check the pods" },
                    ],
                    tool_calls: [
                      { name: "kubectl_get", args: { resource: "pods" } },
                    ],
                  },
                ],
              },
            },
          },
        },
        // Step 2: Tool returns result
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              tools: {
                messages: [
                  { content: "pod-1  Running", name: "kubectl_get" },
                ],
              },
            },
          },
        },
        // Step 3: Agent produces final answer
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  {
                    content: [
                      { type: "thinking", thinking: "The pod looks healthy" },
                      { type: "text", text: "Your pod is running fine." },
                    ],
                  },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const adapter = new LangGraphAdapter({});
    const events = await collectEvents(adapter.investigate("How's my pod?"));

    expect(events.map((e) => e.type)).toEqual([
      "thinking",
      "tool_start",
      "tool_result",
      "thinking",
      "final_answer",
    ]);
  });

  it("skips non on_chain_stream events", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        { event: "on_chat_model_start", data: {} },
        { event: "on_tool_start", data: {} },
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  { content: [{ type: "text", text: "Answer." }] },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const adapter = new LangGraphAdapter({});
    const events = await collectEvents(adapter.investigate("Question?"));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("final_answer");
  });

  it("loads and saves checkpointer when threadId is provided", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  { content: [{ type: "text", text: "Answer." }] },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const { loadCheckpointer, saveCheckpointer } = await import(
      "./file-checkpointer"
    );

    const adapter = new LangGraphAdapter({});
    const events = await collectEvents(
      adapter.investigate("Question?", { threadId: "test-thread" })
    );

    expect(events).toHaveLength(1);
    expect(loadCheckpointer).toHaveBeenCalledWith("test-thread");
    expect(saveCheckpointer).toHaveBeenCalledWith(
      expect.anything(),
      "test-thread"
    );
  });

  it("does not use checkpointer when threadId is not provided", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  { content: [{ type: "text", text: "Answer." }] },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const { loadCheckpointer, saveCheckpointer } = await import(
      "./file-checkpointer"
    );

    const adapter = new LangGraphAdapter({});
    await collectEvents(adapter.investigate("Question?"));

    expect(loadCheckpointer).not.toHaveBeenCalled();
    expect(saveCheckpointer).not.toHaveBeenCalled();
  });

  it("passes agent options through to getInvestigatorAgent", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  { content: [{ type: "text", text: "Done." }] },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const adapter = new LangGraphAdapter({
      toolGroups: ["kubectl", "vector"],
      vectorBackend: "qdrant",
      kubeconfig: "/path/to/kubeconfig",
    });
    await collectEvents(adapter.investigate("Question?"));

    expect(mockGetInvestigatorAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        toolGroups: ["kubectl", "vector"],
        vectorBackend: "qdrant",
        kubeconfig: "/path/to/kubeconfig",
      })
    );
  });

  it("handles multiple tool_calls in a single message", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  {
                    content: [],
                    tool_calls: [
                      { name: "kubectl_get", args: { resource: "pods" } },
                      { name: "kubectl_get", args: { resource: "services" } },
                    ],
                  },
                ],
              },
            },
          },
        },
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  { content: [{ type: "text", text: "Done." }] },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const adapter = new LangGraphAdapter({});
    const events = await collectEvents(adapter.investigate("Question?"));

    const toolStarts = events.filter((e) => e.type === "tool_start");
    expect(toolStarts).toHaveLength(2);
  });

  it("handles tool result with name from message", async () => {
    mockStreamEvents.mockReturnValue(
      mockEventStream([
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              tools: {
                messages: [
                  { content: "result data", name: "kubectl_describe" },
                ],
              },
            },
          },
        },
        {
          event: "on_chain_stream",
          data: {
            chunk: {
              agent: {
                messages: [
                  { content: [{ type: "text", text: "Done." }] },
                ],
              },
            },
          },
        },
      ])
    );

    const { LangGraphAdapter } = await import("./langgraph-adapter");
    const adapter = new LangGraphAdapter({});
    const events = await collectEvents(adapter.investigate("Describe pod"));

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toEqual({
      type: "tool_result",
      toolName: "kubectl_describe",
      result: "result data",
    });
  });
});
