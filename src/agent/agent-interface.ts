// ABOUTME: Defines the InvestigationAgent interface — the contract both agent frameworks implement.
// ABOUTME: The CLI calls investigate() and gets an AsyncGenerator of AgentEvent objects.

/**
 * agent-interface.ts - Shared interface for agent implementations
 *
 * Both the LangGraph agent (via LangGraphAdapter) and the Vercel agent implement
 * this interface. The CLI and agent factory work with this contract, never with
 * framework-specific types.
 *
 * Why AsyncGenerator instead of a callback or Observable?
 * - AsyncGenerator maps naturally to `for await (const event of ...)` in the CLI
 * - It's built into JavaScript — no library dependency
 * - It supports backpressure (the producer pauses when the consumer is busy)
 * - Both LangGraph's `streamEvents()` and Vercel's `fullStream` can be
 *   transformed into AsyncGenerator without buffering
 */

import type { AgentEvent } from "./agent-events";

/**
 * Options for an investigation.
 */
export interface InvestigateOptions {
  /**
   * Conversation thread ID for multi-turn memory.
   * When provided, the agent loads prior conversation state and saves
   * new state after the investigation completes. Each agent framework
   * handles persistence internally (LangGraph uses MemorySaver files,
   * Vercel uses ModelMessage JSON files).
   */
  threadId?: string;

  /**
   * AbortSignal for cancelling a running investigation.
   * When the signal fires, the agent stops streaming and exits cleanly
   * without saving conversation state. Wire to an AbortController in
   * the caller (e.g., the CLI's SIGINT handler).
   */
  signal?: AbortSignal;
}

/**
 * The contract that all agent implementations must satisfy.
 *
 * The CLI creates an agent via the factory, then calls investigate()
 * to stream events. The rendering logic is framework-agnostic — it
 * only knows about AgentEvent types.
 */
export interface InvestigationAgent {
  /**
   * Investigate a question about the Kubernetes cluster.
   *
   * Returns an AsyncGenerator that yields AgentEvent objects as the agent
   * works. The generator completes when the agent produces a final answer
   * or reaches its recursion limit.
   *
   * Memory lifecycle (when threadId is provided):
   * 1. Load prior conversation state from disk
   * 2. Run the investigation with that context
   * 3. Save updated conversation state to disk
   *
   * @param question - Natural language question about the cluster
   * @param options - Optional investigation configuration (threadId for memory)
   * @yields AgentEvent objects in order: thinking → tool_start → tool_result → ... → final_answer
   */
  investigate(
    question: string,
    options?: InvestigateOptions
  ): AsyncGenerator<AgentEvent>;
}
