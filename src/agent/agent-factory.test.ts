// ABOUTME: Unit tests for the agent factory — verifies routing to correct agent framework
// ABOUTME: Tests langgraph agent creation and vercel "not implemented" error

/**
 * Tests for the agent factory module.
 *
 * The factory routes agent creation based on the --agent CLI flag:
 * - "langgraph" creates the existing LangGraph investigator agent
 * - "vercel" throws a "not yet implemented" error (placeholder for PRD #49)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so the mock is available during vi.mock hoisting
const { mockCreateReactAgent } = vi.hoisted(() => ({
  mockCreateReactAgent: vi.fn().mockReturnValue({
    invoke: vi.fn(),
    stream: vi.fn(),
    streamEvents: vi.fn(),
  }),
}));

vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: mockCreateReactAgent,
}));

vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: class MockChatAnthropic {
    constructor() {
      // No-op mock constructor
    }
  },
}));

vi.mock("@langchain/core/messages", () => ({
  HumanMessage: vi.fn().mockImplementation((content: string) => ({
    content,
  })),
}));

vi.mock("../vectorstore", () => ({
  ChromaBackend: class MockChromaBackend {
    initialize = vi.fn();
    similaritySearch = vi.fn();
    keywordSearch = vi.fn();
    addDocuments = vi.fn();
    deleteCollection = vi.fn();
  },
  VoyageEmbedding: class MockVoyageEmbedding {},
  CAPABILITIES_COLLECTION: "capabilities",
  INSTANCES_COLLECTION: "instances",
}));

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
}));

describe("createAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("creates a LangGraph agent when agentType is 'langgraph'", async () => {
    const { createAgent } = await import("./agent-factory");

    const agent = createAgent({ agentType: "langgraph" });

    expect(agent).toBeDefined();
    expect(mockCreateReactAgent).toHaveBeenCalledTimes(1);
  });

  it("passes tool groups through to LangGraph agent", async () => {
    const { createAgent } = await import("./agent-factory");

    createAgent({ agentType: "langgraph", toolGroups: ["kubectl"] });

    const callArgs = mockCreateReactAgent.mock.calls[0][0];
    const toolNames = callArgs.tools.map((t: { name: string }) => t.name);

    expect(callArgs.tools).toHaveLength(3);
    expect(toolNames).toContain("kubectl_get");
    expect(toolNames).not.toContain("vector_search");
  });

  it("throws 'not yet implemented' for vercel agent type", async () => {
    const { createAgent } = await import("./agent-factory");

    expect(() => createAgent({ agentType: "vercel" })).toThrow(
      /not yet implemented/i
    );
  });

  it("defaults to langgraph when no agentType is specified", async () => {
    const { createAgent } = await import("./agent-factory");

    const agent = createAgent({});

    expect(agent).toBeDefined();
    expect(mockCreateReactAgent).toHaveBeenCalledTimes(1);
  });
});
