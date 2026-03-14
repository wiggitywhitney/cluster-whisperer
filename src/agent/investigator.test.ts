// ABOUTME: Tests for the investigator agent configuration.
// ABOUTME: Verifies agent creation, recursion limit, and caching behavior.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — intercept agent creation and invocation to inspect config
// ---------------------------------------------------------------------------

const { createReactAgentSpy, invokeSpy } = vi.hoisted(() => {
  const invokeSpy = vi.fn().mockResolvedValue({
    messages: [{ content: "test answer" }],
  });
  const spy = vi.fn().mockReturnValue({
    invoke: invokeSpy,
    streamEvents: vi.fn(),
  });
  return { createReactAgentSpy: spy, invokeSpy };
});

vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: createReactAgentSpy,
}));

vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: vi.fn().mockImplementation(function () {
    return { model: "mock" };
  }),
}));

vi.mock("@langchain/core/messages", () => ({
  HumanMessage: vi.fn().mockImplementation(function (content: string) {
    return { content };
  }),
}));

vi.mock("../tools/langchain", () => ({
  kubectlTools: [{ name: "kubectl_get" }],
  createVectorTools: vi.fn().mockReturnValue([]),
}));

vi.mock("../vectorstore", () => ({
  VoyageEmbedding: vi.fn().mockImplementation(function () {}),
  ChromaBackend: vi.fn().mockImplementation(function () {}),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    readFileSync: vi.fn().mockReturnValue("You are a Kubernetes investigator."),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  createReactAgentSpy.mockClear();
  invokeSpy.mockClear();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe("getInvestigatorAgent", () => {
  it("caches the agent on subsequent calls", async () => {
    const { getInvestigatorAgent } = await import("./investigator");

    const first = getInvestigatorAgent();
    const second = getInvestigatorAgent();

    expect(first).toBe(second);
    expect(createReactAgentSpy).toHaveBeenCalledOnce();
  });
});

describe("RECURSION_LIMIT", () => {
  it("exports a recursion limit constant", async () => {
    const { RECURSION_LIMIT } = await import("./investigator");
    expect(RECURSION_LIMIT).toBe(50);
  });
});

describe("invokeInvestigator", () => {
  it("passes recursionLimit to agent.invoke", async () => {
    const { invokeInvestigator, RECURSION_LIMIT } = await import(
      "./investigator"
    );

    await invokeInvestigator("what pods are running?");

    expect(invokeSpy).toHaveBeenCalledOnce();
    expect(invokeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recursionLimit: RECURSION_LIMIT })
    );
  });
});
