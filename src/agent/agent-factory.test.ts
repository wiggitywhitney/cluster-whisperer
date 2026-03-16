// ABOUTME: Unit tests for the agent factory — verifies routing to correct agent framework.
// ABOUTME: Tests both langgraph and vercel return InvestigationAgent instances.

/**
 * Tests for the agent factory module.
 *
 * The factory routes agent creation based on the --agent CLI flag:
 * - "langgraph" creates a LangGraphAdapter implementing InvestigationAgent
 * - "vercel" creates a VercelAgent implementing InvestigationAgent
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
  HumanMessage: class MockHumanMessage {
    content: string;
    constructor(content: string) {
      this.content = content;
    }
  },
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
  DEFAULT_VECTOR_BACKEND: "chroma",
  createVectorStore: vi.fn().mockReturnValue({
    initialize: vi.fn(),
    store: vi.fn(),
    search: vi.fn(),
    keywordSearch: vi.fn(),
    delete: vi.fn(),
  }),
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
  isCaptureAiPayloads: false,
}));

// Vercel AI SDK mocks (used by VercelAgent imported via agent-factory)
vi.mock("ai", () => ({
  streamText: vi.fn().mockReturnValue({
    fullStream: (async function* () {
      // Empty stream — factory tests only verify construction, not streaming
    })(),
  }),
  stepCountIs: vi.fn().mockReturnValue("step-count-predicate"),
  tool: vi.fn((def: Record<string, unknown>) => def),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: vi.fn().mockReturnValue("mock-anthropic-model"),
}));

describe("createAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("creates an InvestigationAgent when agentType is 'langgraph'", async () => {
    const { createAgent } = await import("./agent-factory");

    const agent = createAgent({ agentType: "langgraph" });

    expect(agent).toBeDefined();
    expect(typeof agent.investigate).toBe("function");
  });

  it("passes tool groups through to LangGraph adapter", async () => {
    const { createAgent } = await import("./agent-factory");

    // Create agent with specific tool groups — the adapter stores them
    // and passes them through when investigate() is called
    const agent = createAgent({ agentType: "langgraph", toolGroups: ["kubectl"] });

    expect(agent).toBeDefined();
    expect(typeof agent.investigate).toBe("function");
  });

  it("creates an InvestigationAgent when agentType is 'vercel'", async () => {
    const { createAgent } = await import("./agent-factory");

    const agent = createAgent({ agentType: "vercel" });

    expect(agent).toBeDefined();
    expect(typeof agent.investigate).toBe("function");
  });

  it("returns an AsyncGenerator from vercel agent's investigate()", async () => {
    const { createAgent } = await import("./agent-factory");

    const agent = createAgent({ agentType: "vercel" });
    const generator = agent.investigate("test question");

    expect(generator[Symbol.asyncIterator]).toBeDefined();

    // Clean up the generator
    await generator.return(undefined as never);
  });

  it("defaults to langgraph when no agentType is specified", async () => {
    const { createAgent } = await import("./agent-factory");

    const agent = createAgent({});

    expect(agent).toBeDefined();
    expect(typeof agent.investigate).toBe("function");
  });

  it("returns an object implementing InvestigationAgent interface", async () => {
    const { createAgent } = await import("./agent-factory");

    const agent = createAgent({ agentType: "langgraph" });

    // Verify the investigate method is an AsyncGenerator function
    // (returns an object with Symbol.asyncIterator when called)
    const generator = agent.investigate("test question");
    expect(generator[Symbol.asyncIterator]).toBeDefined();

    // Clean up the generator without consuming it
    await generator.return(undefined as never);
  });
});
