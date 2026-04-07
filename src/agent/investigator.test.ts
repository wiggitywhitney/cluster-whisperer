// ABOUTME: Unit tests for the investigator agent — verifies tool wiring and agent construction.
// ABOUTME: Tests that kubectl, vector, and apply tools are properly included in the agent.

/**
 * Tests for the investigator agent construction
 *
 * These tests verify that the agent is wired correctly with the right tools.
 * They don't test the full agent loop (that requires an LLM) — they test
 * the construction and tool configuration.
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

vi.mock("@langchain/anthropic", () => {
  return {
    ChatAnthropic: class MockChatAnthropic {
      constructor() {
        // No-op mock constructor
      }
    },
  };
});

vi.mock("@langchain/core/messages", () => ({
  HumanMessage: vi.fn().mockImplementation((content: string) => ({
    content,
  })),
}));

// Mock the vectorstore module to avoid needing VOYAGE_API_KEY.
// Must use class syntax (not arrow functions) because the code uses `new`.
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

// Mock tracing
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

describe("getInvestigatorAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module registry so the cached agent is cleared between tests
    vi.resetModules();
    // Set VOYAGE_API_KEY so createVectorToolsSafe doesn't short-circuit
    process.env.VOYAGE_API_KEY = "test-key";
  });

  it("creates an agent with default tools (kubectl + vector)", async () => {
    // Dynamic import after module reset to get a fresh module instance
    const { getInvestigatorAgent } = await import("./investigator");

    getInvestigatorAgent();

    expect(mockCreateReactAgent).toHaveBeenCalledTimes(1);

    const callArgs = mockCreateReactAgent.mock.calls[0][0];
    const tools = callArgs.tools;
    const toolNames = tools.map(
      (t: { name: string }) => t.name
    );

    // Default tool groups: kubectl + vector (4 tools, no apply)
    expect(tools).toHaveLength(4);
    expect(toolNames).toContain("kubectl_get");
    expect(toolNames).toContain("kubectl_describe");
    expect(toolNames).toContain("kubectl_logs");
    expect(toolNames).toContain("vector_search");
    expect(toolNames).not.toContain("kubectl_apply");
  });

  it("includes a system prompt", async () => {
    const { getInvestigatorAgent } = await import("./investigator");

    getInvestigatorAgent();

    const callArgs = mockCreateReactAgent.mock.calls[0][0];
    // Uses `prompt` (not deprecated `stateModifier`) per LangGraph v0.2.46+
    expect(callArgs.prompt).toBeTruthy();
    expect(callArgs.prompt).toContain("Kubernetes");
    expect(callArgs.stateModifier).toBeUndefined();
  });

  it("filters to kubectl-only when toolGroups is ['kubectl']", async () => {
    const { getInvestigatorAgent } = await import("./investigator");

    getInvestigatorAgent({ toolGroups: ["kubectl"] });

    const callArgs = mockCreateReactAgent.mock.calls[0][0];
    const toolNames = callArgs.tools.map((t: { name: string }) => t.name);

    expect(callArgs.tools).toHaveLength(3);
    expect(toolNames).toContain("kubectl_get");
    expect(toolNames).toContain("kubectl_describe");
    expect(toolNames).toContain("kubectl_logs");
    expect(toolNames).not.toContain("vector_search");
    expect(toolNames).not.toContain("kubectl_apply");
  });

  it("includes all tools when toolGroups is ['kubectl', 'vector', 'apply']", async () => {
    const { getInvestigatorAgent } = await import("./investigator");

    getInvestigatorAgent({ toolGroups: ["kubectl", "vector", "apply"] });

    const callArgs = mockCreateReactAgent.mock.calls[0][0];
    const toolNames = callArgs.tools.map((t: { name: string }) => t.name);

    expect(callArgs.tools).toHaveLength(5);
    expect(toolNames).toContain("kubectl_get");
    expect(toolNames).toContain("kubectl_describe");
    expect(toolNames).toContain("kubectl_logs");
    expect(toolNames).toContain("vector_search");
    expect(toolNames).toContain("kubectl_apply");
  });

  it("uses default groups (kubectl,vector) when no options provided", async () => {
    const { getInvestigatorAgent } = await import("./investigator");

    getInvestigatorAgent();

    const callArgs = mockCreateReactAgent.mock.calls[0][0];
    const toolNames = callArgs.tools.map((t: { name: string }) => t.name);

    // Default: kubectl + vector (backwards compatible, no apply)
    expect(toolNames).toContain("kubectl_get");
    expect(toolNames).toContain("kubectl_describe");
    expect(toolNames).toContain("kubectl_logs");
    expect(toolNames).toContain("vector_search");
    expect(toolNames).not.toContain("kubectl_apply");
  });
});
