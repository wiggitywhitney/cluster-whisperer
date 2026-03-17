// ABOUTME: Vercel AI SDK agent that investigates Kubernetes clusters using streamText with Claude.
// ABOUTME: Implements InvestigationAgent — translates fullStream parts into AgentEvent objects.

/**
 * vercel-agent.ts - Vercel AI SDK implementation of the InvestigationAgent
 *
 * This agent uses the Vercel AI SDK's streamText() to run a multi-step
 * investigation with Claude. It produces the same AgentEvent objects as the
 * LangGraph adapter, so the CLI renders both agents identically.
 *
 * How it works:
 * 1. Constructs tools from the Vercel tool factories (src/tools/vercel/)
 * 2. Loads the shared system prompt (prompts/investigator.md)
 * 3. If threadId provided, loads prior messages and uses multi-turn mode
 * 4. Calls streamText() with Claude, tools, extended thinking, and telemetry
 * 5. Iterates over fullStream and translates each part to an AgentEvent:
 *    - reasoning-delta → thinking event
 *    - tool-call → tool_start event
 *    - tool-result → tool_result event
 *    - text-delta → accumulates into final_answer
 *    - finish-step with "stop" → emits accumulated text as final_answer
 *
 * Key configuration (from M1 research):
 * - stopWhen: stepCountIs(50) — matches RECURSION_LIMIT from investigator.ts
 * - Extended thinking with interleaved-thinking-2025-05-14 beta header
 * - experimental_telemetry for Vercel SDK span generation
 *
 * Property name note (vercel/ai#8756):
 * The SDK has a known inconsistency where delta properties may be named
 * `delta`, `textDelta`, or `text` depending on the API layer. The code
 * uses `part.delta` based on M1 research. If TypeScript types diverge
 * from runtime values, check `part.textDelta` as a fallback.
 */

import { streamText, stepCountIs, type ToolSet, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { trace } from "@opentelemetry/api";
import * as fs from "fs";
import * as path from "path";
import { ANTHROPIC_MODEL, RECURSION_LIMIT } from "./investigator";
import type { AgentEvent } from "./agent-events";
import type { InvestigationAgent, InvestigateOptions } from "./agent-interface";
import type { ToolGroup } from "../tools/tool-groups";
import { DEFAULT_TOOL_GROUPS } from "../tools/tool-groups";
import {
  VoyageEmbedding,
  createVectorStore,
  DEFAULT_VECTOR_BACKEND,
  type VectorBackendType,
} from "../vectorstore";
import {
  createKubectlTools,
  createVectorTools,
  createApplyTools,
} from "../tools/vercel";
import { loadVercelThread, saveVercelThread } from "./vercel-thread-store";

/**
 * Options for constructing the VercelAgent.
 * Mirrors the LangGraphAdapter options for consistent factory API.
 */
export interface VercelAgentOptions {
  toolGroups?: ToolGroup[];
  vectorBackend?: VectorBackendType;
  kubeconfig?: string;
}

/**
 * Path to the system prompt file.
 * Same path calculation as investigator.ts — goes up two levels from
 * src/agent/ to the project root, then into prompts/.
 */
const promptPath = path.join(__dirname, "../../prompts/investigator.md");

/**
 * Cached system prompt — loaded lazily on first use.
 * Matches the lazy-loading pattern in investigator.ts.
 */
let cachedPrompt: string | null = null;

function getSystemPrompt(): string {
  if (!cachedPrompt) {
    try {
      cachedPrompt = fs.readFileSync(promptPath, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not load system prompt from ${promptPath}. ` +
        `Make sure prompts/investigator.md exists in the project root. ` +
        `(${detail})`
      );
    }
  }
  return cachedPrompt;
}

/**
 * Vercel AI SDK agent implementing the shared InvestigationAgent interface.
 *
 * Uses streamText() with Claude for multi-step reasoning, tool calls, and
 * extended thinking. Produces the same AgentEvent objects as LangGraphAdapter
 * so the CLI output is identical regardless of which agent is running.
 */
export class VercelAgent implements InvestigationAgent {
  private readonly options: VercelAgentOptions;

  constructor(options: VercelAgentOptions) {
    this.options = options;
  }

  /**
   * Investigate a question by streaming AgentEvent objects.
   *
   * Builds the tool set from factories, calls streamText(), and translates
   * fullStream parts into AgentEvent objects.
   *
   * Memory lifecycle (when threadId is provided):
   * 1. Load prior ModelMessage[] from data/threads/vercel-<threadId>.json
   * 2. Build messages array: [...prior, { role: 'user', content: question }]
   * 3. Call streamText with messages (multi-turn) instead of prompt (single-turn)
   * 4. After stream, save full history via result.response.messages
   *
   * The fullStream → AgentEvent mapping:
   * - 'reasoning-delta' (delta) → { type: 'thinking', content }
   * - 'tool-call' (toolName, args) → { type: 'tool_start', toolName, args }
   * - 'tool-result' (toolName, result) → { type: 'tool_result', toolName, result }
   * - 'text-delta' (delta) → accumulated into textBuffer
   * - 'finish-step' with finishReason 'stop' → { type: 'final_answer', content: textBuffer }
   */
  async *investigate(
    question: string,
    options?: InvestigateOptions
  ): AsyncGenerator<AgentEvent> {
    const toolGroups = this.options.toolGroups ?? DEFAULT_TOOL_GROUPS;
    const threadId = options?.threadId;

    // Build the tools Record<string, Tool> from Vercel tool factories
    const tools = this.buildTools(toolGroups);

    // Load the shared system prompt
    const systemPrompt = getSystemPrompt();

    // Load prior conversation messages if a thread ID is provided
    const priorMessages: ModelMessage[] = threadId
      ? loadVercelThread(threadId)
      : [];

    // Build the input messages — prior history + new user question
    const inputMessages: ModelMessage[] = [
      ...priorMessages,
      { role: "user", content: question },
    ];

    // Call streamText — use messages (multi-turn) when we have history,
    // prompt (single-turn) otherwise. System prompt is always passed via
    // the system parameter, NOT in the messages array.
    const result = streamText({
      model: anthropic(ANTHROPIC_MODEL),
      system: systemPrompt,
      ...(threadId
        ? { messages: inputMessages }
        : { prompt: question }),
      tools,
      stopWhen: stepCountIs(RECURSION_LIMIT),
      ...(options?.signal ? { abortSignal: options.signal } : {}),
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 4000 },
          headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" },
        },
      },
      experimental_telemetry: {
        isEnabled: true,
        functionId: "cluster-whisperer-investigate",
        metadata: { agent: "vercel" },
        tracer: trace.getTracer("ai"),
      },
    });

    // Translate fullStream parts into AgentEvent objects.
    // We buffer both thinking and text fragments, flushing when the stream
    // transitions to a different event type. This produces one ThinkingEvent
    // per thought block (matching LangGraph's behavior) instead of one per
    // streaming chunk.
    let textBuffer = "";
    let thinkingBuffer = "";

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta":
          // Extended thinking — Claude's reasoning between steps.
          // SDK 6 types: part.text (not part.delta — see vercel/ai#8756).
          // Accumulate fragments; flush when a non-thinking part arrives.
          thinkingBuffer += part.text;
          break;

        case "tool-call":
          // Flush any buffered thinking before the tool call
          if (thinkingBuffer) {
            yield { type: "thinking", content: thinkingBuffer };
            thinkingBuffer = "";
          }
          // Agent decided to call a tool.
          // SDK 6 types: part.toolName, part.input (not part.args).
          yield {
            type: "tool_start",
            toolName: part.toolName,
            args: part.input as Record<string, unknown>,
          };
          break;

        case "tool-result":
          // Flush any buffered thinking before the tool result
          if (thinkingBuffer) {
            yield { type: "thinking", content: thinkingBuffer };
            thinkingBuffer = "";
          }
          // Tool returned a result.
          // SDK 6 types: part.toolName, part.output (not part.result).
          yield {
            type: "tool_result",
            toolName: part.toolName,
            result: String(part.output),
          };
          break;

        case "text-delta":
          // Flush any buffered thinking before text accumulation
          if (thinkingBuffer) {
            yield { type: "thinking", content: thinkingBuffer };
            thinkingBuffer = "";
          }
          // Accumulate text deltas for the final answer.
          // SDK 6 types: part.text (not part.delta — see vercel/ai#8756).
          textBuffer += part.text;
          break;

        case "tool-error":
          // Tool execution threw an error at the SDK level.
          // Surface as a tool_result with the error message so the agent
          // can reason about the failure (matching LangGraph behavior).
          if (thinkingBuffer) {
            yield { type: "thinking", content: thinkingBuffer };
            thinkingBuffer = "";
          }
          yield {
            type: "tool_result",
            toolName: part.toolName,
            result: `Tool error: ${String(part.error)}`,
          };
          break;

        case "error":
          // Stream-level error — the SDK encountered an unrecoverable failure.
          // Throw so withAgentTracing marks the span as failed.
          if (thinkingBuffer) {
            yield { type: "thinking", content: thinkingBuffer };
            thinkingBuffer = "";
          }
          throw part.error instanceof Error
            ? part.error
            : new Error(String(part.error));

        case "finish-step":
          // Flush any buffered thinking at step boundaries
          if (thinkingBuffer) {
            yield { type: "thinking", content: thinkingBuffer };
            thinkingBuffer = "";
          }
          if (part.finishReason === "stop" && textBuffer) {
            // Final step — emit accumulated text as the agent's answer.
            yield { type: "final_answer", content: textBuffer };
            textBuffer = "";
          } else {
            // Non-final step (e.g., tool-calls) — clear the buffer.
            // Text before a tool call is intermediate reasoning, not an answer.
            textBuffer = "";
          }
          break;
      }
    }

    // Edge case: stream ended without flushing buffers
    if (thinkingBuffer) {
      yield { type: "thinking", content: thinkingBuffer };
    }
    if (textBuffer) {
      yield { type: "final_answer", content: textBuffer };
    }

    // Save conversation memory after investigation completes (skip if aborted).
    // result.response gives us the assistant + tool messages from all steps.
    if (threadId && !options?.signal?.aborted) {
      const response = await result.response;
      const fullHistory: ModelMessage[] = [
        ...inputMessages,
        ...response.messages,
      ];
      saveVercelThread(fullHistory, threadId);
    }
  }

  /**
   * Build the Record<string, Tool> for streamText from the selected tool groups.
   *
   * Mirrors the tool construction in investigator.ts but uses Vercel tool factories
   * instead of LangChain factories. Each factory returns Record<string, Tool>
   * which we merge via object spread.
   */
  private buildTools(toolGroups: ToolGroup[]): ToolSet {
    let tools: ToolSet = {};

    const kubectlOpts = this.options.kubeconfig
      ? { kubeconfig: this.options.kubeconfig }
      : undefined;

    if (toolGroups.includes("kubectl")) {
      tools = { ...tools, ...createKubectlTools(kubectlOpts) };
    }

    // Vector and apply tools share a VectorStore instance.
    // Only create the shared backend if either group is requested.
    if (toolGroups.includes("vector") || toolGroups.includes("apply")) {
      if (process.env.VOYAGE_API_KEY) {
        const embedder = new VoyageEmbedding();
        const vectorStore = createVectorStore(
          embedder,
          this.options.vectorBackend ?? DEFAULT_VECTOR_BACKEND
        );

        if (toolGroups.includes("vector")) {
          tools = { ...tools, ...createVectorTools(vectorStore) };
        }
        if (toolGroups.includes("apply")) {
          tools = { ...tools, ...createApplyTools(vectorStore, kubectlOpts) };
        }
      } else {
        console.debug("Vector and apply tools disabled: VOYAGE_API_KEY is not set"); // eslint-disable-line no-console
      }
    }

    return tools;
  }
}
