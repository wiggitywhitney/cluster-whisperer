// ABOUTME: Wraps the LangGraph agent's streamEvents() output into the AgentEvent interface.
// ABOUTME: Encapsulates LangGraph-specific event parsing and conversation memory lifecycle.

/**
 * langgraph-adapter.ts - Adapts the LangGraph agent to the InvestigationAgent interface
 *
 * Why an adapter instead of modifying the LangGraph agent directly?
 * The LangGraph agent (investigator.ts) is also used by the MCP server via
 * invokeInvestigator(). Modifying its return type would break MCP. The adapter
 * wraps the agent's streamEvents() output and translates LangGraph's v2 event
 * format into the framework-agnostic AgentEvent union type.
 *
 * The translation extracts the event parsing logic that was previously in
 * src/index.ts (the CLI event loop). Now the CLI just does:
 *   for await (const event of agent.investigate(question)) { ... }
 * instead of parsing on_chain_stream chunks directly.
 *
 * Memory lifecycle:
 * The adapter encapsulates LangGraph's MemorySaver-based conversation memory.
 * When a threadId is provided, it loads the checkpointer before the agent run
 * and saves it after. The CLI never touches MemorySaver or file-checkpointer.
 */

import { HumanMessage } from "@langchain/core/messages";
import { getInvestigatorAgent, RECURSION_LIMIT } from "./investigator";
import { loadCheckpointer, saveCheckpointer } from "./file-checkpointer";
import type { AgentEvent } from "./agent-events";
import type { InvestigationAgent, InvestigateOptions } from "./agent-interface";
import type { ToolGroup } from "../tools/tool-groups";
import type { VectorBackendType } from "../vectorstore";

/**
 * Options for constructing the LangGraphAdapter.
 * These mirror the agent factory options minus the checkpointer
 * (which is now handled internally per-investigation).
 */
export interface LangGraphAdapterOptions {
  toolGroups?: ToolGroup[];
  vectorBackend?: VectorBackendType;
  kubeconfig?: string;
}

/**
 * Adapts the LangGraph ReAct agent to the shared InvestigationAgent interface.
 *
 * Translates LangGraph's v2 streamEvents format:
 * - on_chain_stream { chunk.agent.messages[].content[].type === "thinking" } → ThinkingEvent
 * - on_chain_stream { chunk.agent.messages[].tool_calls } → ToolStartEvent
 * - on_chain_stream { chunk.tools.messages } → ToolResultEvent
 * - on_chain_stream { chunk.agent.messages without tool_calls } → FinalAnswerEvent
 */
export class LangGraphAdapter implements InvestigationAgent {
  private readonly options: LangGraphAdapterOptions;

  constructor(options: LangGraphAdapterOptions) {
    this.options = options;
  }

  /**
   * Investigate a question by streaming AgentEvent objects.
   *
   * Creates the LangGraph agent, optionally loads conversation memory,
   * iterates over streamEvents(), translates each chunk to AgentEvent,
   * and saves memory after completion.
   */
  async *investigate(
    question: string,
    options?: InvestigateOptions
  ): AsyncGenerator<AgentEvent> {
    const threadId = options?.threadId;
    const signal = options?.signal;

    // Bail out immediately if the signal is already aborted before we do anything
    if (signal?.aborted) return;

    // Load conversation memory if a thread ID is provided
    const checkpointer = threadId ? loadCheckpointer(threadId) : undefined;

    // Create the LangGraph agent with the appropriate configuration
    const agent = getInvestigatorAgent({
      toolGroups: this.options.toolGroups,
      vectorBackend: this.options.vectorBackend,
      kubeconfig: this.options.kubeconfig,
      checkpointer,
    });

    // Stream events from the LangGraph agent
    const eventStream = agent.streamEvents(
      { messages: [new HumanMessage(question)] },
      {
        version: "v2",
        recursionLimit: RECURSION_LIMIT,
        ...(threadId ? { configurable: { thread_id: threadId } } : {}),
      }
    );

    // Translate LangGraph v2 events into AgentEvent objects
    for await (const event of eventStream) {
      if (signal?.aborted) break;
      if (event.event !== "on_chain_stream") continue;

      const chunk = event.data?.chunk;
      if (!chunk) continue;

      // Agent message: thinking blocks, tool calls, or final answer
      if (chunk.agent?.messages) {
        for (const msg of chunk.agent.messages) {
          const content = msg.content;

          // Extract thinking blocks from content array
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "thinking" && block.thinking) {
                if (signal?.aborted) return;
                yield { type: "thinking", content: block.thinking };
              }
            }
          }

          // Tool calls = intermediate step
          if (msg.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
              if (signal?.aborted) return;
              yield {
                type: "tool_start",
                toolName: tc.name,
                args: tc.args,
              };
            }
          } else {
            // No tool calls = final answer. Extract text from content blocks.
            let answer = "";
            if (typeof content === "string") {
              answer = content;
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text") {
                  answer += block.text;
                }
              }
            }

            if (answer.trim()) {
              if (signal?.aborted) return;
              yield { type: "final_answer", content: answer };
            }
          }
        }
      }

      // Tool result: output from a tool execution
      if (chunk.tools?.messages) {
        for (const msg of chunk.tools.messages) {
          if (signal?.aborted) return;
          yield {
            type: "tool_result",
            toolName: msg.name ?? "unknown",
            result: String(msg.content),
          };
        }
      }
    }

    // Save conversation memory after the investigation completes (skip if aborted)
    if (checkpointer && threadId && !signal?.aborted) {
      saveCheckpointer(checkpointer, threadId);
    }
  }
}
