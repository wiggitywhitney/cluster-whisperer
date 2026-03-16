// ABOUTME: ReAct agent that answers Kubernetes questions using kubectl and vector search tools.
// ABOUTME: Implements the agentic loop with extended thinking, recursion limit, and graceful exit.

/**
 * investigator.ts - The agentic loop that answers questions about Kubernetes
 *
 * What is an "agentic loop"?
 * Instead of running a fixed sequence of commands, an agent decides what to do
 * at each step based on what it's learned so far. It loops: think → act → observe
 * → think again → ... until it has enough information to answer.
 *
 * This is called the ReAct pattern (Reason + Act). The agent:
 * 1. Reasons about what it knows and what it needs to find out
 * 2. Acts by calling a tool (like kubectl_get)
 * 3. Observes the result
 * 4. Repeats until it can answer the question
 *
 * What parts are LangChain?
 * - ChatAnthropic: LangChain's wrapper for calling Claude
 * - createReactAgent: LangChain's implementation of the ReAct loop
 * - The tools array: LangChain binds these to the agent
 * - LangChain methods like .invoke() and .streamEvents() come built into the
 *   object returned by createReactAgent (no extra import needed)
 *
 * Everything else is plain TypeScript - reading files, exporting functions.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import * as fs from "fs";
import * as path from "path";
import { kubectlTools, createKubectlTools, createVectorTools, createApplyTools } from "../tools/langchain";
import {
  VoyageEmbedding,
  createVectorStore,
  DEFAULT_VECTOR_BACKEND,
  type VectorBackendType,
} from "../vectorstore";
import { DEFAULT_TOOL_GROUPS, type ToolGroup } from "../tools/tool-groups";

/**
 * The Anthropic model used by the investigator agent.
 * Exported so tracing code can reference the same model in span attributes.
 */
export const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

/**
 * Maximum number of agent reasoning steps before forcing termination.
 *
 * LangGraph's recursionLimit is passed at execution time (.invoke/.streamEvents),
 * not at agent creation. The default is 25, but we make it explicit and export
 * it so both the CLI (streamEvents) and MCP (invoke) use the same limit.
 *
 * Why 50? Normal investigations use 5-10 tool calls. Complex demo flows
 * (vector search → failed deploy → retry → describe → more searches) can
 * exceed 25 steps. 50 is generous enough for multi-step Act 3 flows while
 * still preventing runaway loops.
 */
export const RECURSION_LIMIT = 50;

/**
 * Result from invoking the investigator agent.
 *
 * This structured result separates the different parts of the agent's response:
 * - answer: The final text response to display to the user
 * - thinking: Array of thinking blocks showing the agent's reasoning process
 * - isError: Whether the investigation failed (for MCP error signaling)
 *
 * Why separate thinking from answer?
 * MCP clients can't render thinking blocks specially - they just see text.
 * By separating them, MCP tools can put thinking in trace attributes (for
 * observability) while returning only the answer in the MCP response.
 */
export interface InvestigationResult {
  answer: string;
  thinking: string[];
  isError: boolean;
}

/**
 * Path to the system prompt file.
 *
 * Why a separate file?
 * The system prompt tells the agent how to behave - its role, investigation
 * approach, and response format. Keeping it in a markdown file makes it easy
 * to iterate on the prompt without touching code. You can tweak the wording,
 * add examples, or adjust the tone without recompiling.
 *
 * Why path.join with __dirname?
 * When the code runs, __dirname is the directory containing this file.
 * We go up two levels (src/agent → src → project root) then into prompts/.
 * This works regardless of where you run the command from.
 */
const promptPath = path.join(__dirname, "../../prompts/investigator.md");

/**
 * Cached system prompt - loaded lazily on first use.
 *
 * Why lazy loading?
 * If we read the file at module import time and it's missing, Node.js throws
 * a cryptic ENOENT error before our code can show a friendly message. By
 * loading lazily, we can catch the error and provide helpful guidance.
 */
let cachedPrompt: string | null = null;

function getSystemPrompt(): string {
  if (!cachedPrompt) {
    try {
      cachedPrompt = fs.readFileSync(promptPath, "utf8");
    } catch {
      console.error(`Error: Could not load system prompt from ${promptPath}`);
      console.error("");
      console.error("Make sure prompts/investigator.md exists in the project root.");
      // process.exit(1) is intentional here: getSystemPrompt is synchronous and
      // this is a fatal startup error — no traces are in flight yet, so losing
      // the flush is acceptable. Using async gracefulExit would race with callers.
      process.exit(1);
    }
  }
  return cachedPrompt;
}

/**
 * Creates vector tools if the Voyage API key is available.
 *
 * Returns an empty array if VOYAGE_API_KEY is not set, so the agent
 * still works with kubectl tools for cluster investigation. This is
 * extracted as a separate function so the tools array in createReactAgent
 * is built in a single spread expression — avoiding TypeScript narrowing
 * issues with let/reassign.
 */
/**
 * Creates vector search and apply tools that share the same VectorStore instance.
 *
 * Both tool types need a VectorStore:
 * - Vector tools: for similarity and keyword search across collections
 * - Apply tools: for catalog validation (querying capabilities collection)
 *
 * Sharing the same instance means a single connection to the vector DB.
 * Both tools independently ensure their collections are initialized.
 *
 * Returns { vectorTools, applyTools } — either may be empty if VOYAGE_API_KEY
 * is not set (the agent still works with kubectl-only investigation).
 */
function createVectorAndApplyToolsSafe(
  vectorBackend: VectorBackendType = DEFAULT_VECTOR_BACKEND,
  kubectlOpts?: { kubeconfig?: string }
) {
  if (!process.env.VOYAGE_API_KEY) {
    console.debug("Vector and apply tools disabled: VOYAGE_API_KEY is not set"); // eslint-disable-line no-console
    return { vectorTools: [], applyTools: [] };
  }

  const embedder = new VoyageEmbedding();
  const vectorStore = createVectorStore(embedder, vectorBackend);
  return {
    vectorTools: createVectorTools(vectorStore),
    applyTools: createApplyTools(vectorStore, kubectlOpts),
  };
}

/**
 * Options for configuring the investigator agent.
 */
export interface InvestigatorOptions {
  /**
   * Which tool groups to include in the agent.
   * Defaults to DEFAULT_TOOL_GROUPS (kubectl, vector) for backwards compatibility.
   *
   * Groups:
   * - kubectl: kubectl_get, kubectl_describe, kubectl_logs
   * - vector: vector_search
   * - apply: kubectl_apply
   */
  toolGroups?: ToolGroup[];
  /**
   * Which vector database backend to use for vector and apply tools.
   * Defaults to "chroma" for backwards compatibility.
   */
  vectorBackend?: VectorBackendType;
  /**
   * Path to a kubeconfig file for kubectl operations.
   * When set, all kubectl tools pass --kubeconfig to their subprocess calls.
   * This enables the demo governance narrative: the presenter's shell has no
   * KUBECONFIG, but the agent has cluster access via this path.
   */
  kubeconfig?: string;
  /**
   * Checkpointer for conversation memory persistence.
   * When provided, the agent saves conversation state after each step
   * so multi-turn conversations work across CLI invocations.
   */
  checkpointer?: MemorySaver;
}

/**
 * Cached agents keyed by a deterministic string derived from options.
 *
 * Why a Map instead of a single cached instance?
 * Different callers may request different tool groups, vector backends, or
 * kubeconfig paths. A single cached agent would silently return an agent
 * configured for the first caller's options, ignoring subsequent callers'
 * requirements. The Map keys on the relevant options so each unique
 * configuration gets its own cached agent.
 *
 * Why lazy creation?
 * The ChatAnthropic constructor validates the API key immediately. If we create
 * the agent at module load time (when this file is imported), it throws before
 * our startup validation can show a friendly error message. By creating the
 * agent lazily, we let index.ts validate the environment first.
 */
const agentCache = new Map<string, ReturnType<typeof createReactAgent>>();

/**
 * Build a deterministic cache key from the options that affect agent construction.
 *
 * Sorting toolGroups ensures ["kubectl","vector"] and ["vector","kubectl"]
 * produce the same key.
 */
function buildCacheKey(options?: InvestigatorOptions): string {
  const toolGroups = [...(options?.toolGroups ?? DEFAULT_TOOL_GROUPS)].sort();
  const vectorBackend = options?.vectorBackend ?? DEFAULT_VECTOR_BACKEND;
  const kubeconfig = options?.kubeconfig ?? "";
  return `${toolGroups.join(",")}|${vectorBackend}|${kubeconfig}`;
}

/**
 * Gets the investigator agent, creating it on first call.
 *
 * The agent combines the model, tools, and system prompt into a reasoning loop.
 *
 * createReactAgent handles the loop mechanics:
 * - Sends the user's question plus system prompt to the model
 * - If the model wants to call a tool, executes it and feeds back the result
 * - Keeps looping until the model produces a final answer (no more tool calls)
 *
 * The returned object has LangChain methods built in:
 * - agent.invoke() - run and return final result
 * - agent.stream() - stream output chunks
 * - agent.streamEvents() - stream detailed internal events (used in index.ts)
 *
 * stateModifier injects our system prompt at the start of every conversation.
 * This is how we tell the agent "you are a Kubernetes investigator" without
 * the user having to say it.
 *
 * Why Claude Sonnet?
 * It's a good balance of capability and speed for this use case. Opus would be
 * more capable but slower and more expensive. Haiku would be faster but might
 * miss nuances in complex investigations.
 *
 * Why extended thinking?
 * Extended thinking lets Claude show its reasoning process - the "why" behind
 * each decision. This is valuable for learning and debugging. Users can see
 * how the agent thinks through problems, not just what actions it takes.
 *
 * Configuration constraints:
 * - budget_tokens: How many tokens Claude can use for thinking (min 1024)
 * - maxTokens: Must be greater than budget_tokens
 * - temperature: Cannot be set when using extended thinking (API requirement)
 *
 * @param options - Optional configuration for tool selection
 */
export function getInvestigatorAgent(options?: InvestigatorOptions) {
  // When a checkpointer is provided, always create a fresh agent — the
  // checkpointer is per-thread and can't be shared with a cached agent.
  const cacheKey = buildCacheKey(options);
  if (!agentCache.has(cacheKey) || options?.checkpointer) {
    const toolGroups = options?.toolGroups ?? DEFAULT_TOOL_GROUPS;
    const vectorBackend = options?.vectorBackend ?? DEFAULT_VECTOR_BACKEND;

    const model = new ChatAnthropic({
      model: ANTHROPIC_MODEL,
      maxTokens: 10000,
      thinking: { type: "enabled", budget_tokens: 4000 },
      // Enable interleaved thinking so Claude can reason between tool calls
      // Without this, thinking only happens at the start of each turn
      clientOptions: {
        defaultHeaders: {
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
      },
    });

    // Build the tools array based on selected tool groups.
    // Each group maps to one or more LangChain tools.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [];

    // Build kubectl options from kubeconfig if provided
    const kubectlOpts = options?.kubeconfig ? { kubeconfig: options.kubeconfig } : undefined;

    if (toolGroups.includes("kubectl")) {
      // Use factory when kubeconfig is provided, static export otherwise
      tools.push(...(kubectlOpts ? createKubectlTools(kubectlOpts) : kubectlTools));
    }

    // Vector and apply tools share a VectorStore instance (single connection).
    // Only create the shared backend if either group is requested.
    if (toolGroups.includes("vector") || toolGroups.includes("apply")) {
      const { vectorTools, applyTools } = createVectorAndApplyToolsSafe(vectorBackend, kubectlOpts);

      if (toolGroups.includes("vector")) {
        tools.push(...vectorTools);
      }
      if (toolGroups.includes("apply")) {
        tools.push(...applyTools);
      }
    }

    const agent = createReactAgent({
      llm: model,
      tools,
      stateModifier: getSystemPrompt(),
      // Checkpointer enables conversation memory — the agent saves state
      // after each step so multi-turn conversations persist across CLI invocations.
      // Without a checkpointer, each invocation starts fresh (one-shot mode).
      ...(options?.checkpointer ? { checkpointer: options.checkpointer } : {}),
    });

    // Only cache when no checkpointer — checkpointers are per-thread
    if (!options?.checkpointer) {
      agentCache.set(cacheKey, agent);
    }

    return agent;
  }
  return agentCache.get(cacheKey)!;
}

/**
 * Truncates a string to a maximum length, adding "..." if truncated.
 *
 * Why truncate?
 * kubectl output can be very long (imagine 100 pods, or verbose describe output).
 * When displaying tool results in the terminal, we want enough to understand
 * what happened without flooding the screen. The thinking content is the main
 * focus, so tool results just need enough context to follow along.
 *
 * @param text - The string to truncate
 * @param maxLength - Maximum length (default 1100)
 * @returns The truncated string with "..." suffix if it was shortened
 */
export function truncate(text: string, maxLength: number = 1100): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "...";
}

/**
 * Invokes the investigator agent and returns a structured result.
 *
 * This function is designed for MCP mode where we need the complete result
 * rather than streaming events. It:
 * 1. Calls agent.invoke() instead of agent.streamEvents()
 * 2. Extracts the last message from the conversation
 * 3. Parses content blocks to separate thinking from the answer
 *
 * Why invoke() instead of streamEvents()?
 * - streamEvents() is great for CLI where we display progress in real-time
 * - invoke() is simpler when we just need the final result
 * - MCP tools return a single response, not a stream
 *
 * Content block parsing:
 * With extended thinking enabled, Claude returns an array of content blocks:
 * - { type: "thinking", thinking: "..." } - reasoning process
 * - { type: "text", text: "..." } - actual response text
 *
 * @param question - The user's natural language question about their cluster
 * @returns Structured result with answer, thinking array, and error flag
 */
export async function invokeInvestigator(
  question: string
): Promise<InvestigationResult> {
  try {
    // Get the cached agent instance (same one used by CLI)
    const agent = getInvestigatorAgent();

    // Invoke the agent with the user's question
    // This runs the full ReAct loop until the agent produces a final answer
    // recursionLimit caps iterations to prevent runaway loops
    const result = await agent.invoke(
      { messages: [new HumanMessage(question)] },
      { recursionLimit: RECURSION_LIMIT }
    );

    // Extract the last message from the conversation
    // The agent produces a series of messages; the last AI message has our answer
    const messages = result.messages;
    const lastMessage = messages[messages.length - 1];

    // Parse content blocks to separate thinking from answer
    const thinking: string[] = [];
    let answer = "";

    const content = lastMessage?.content;
    if (typeof content === "string") {
      // Simple string content (no extended thinking)
      answer = content;
    } else if (Array.isArray(content)) {
      // Array of content blocks with extended thinking
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block
        ) {
          if (block.type === "thinking" && "thinking" in block) {
            thinking.push(String(block.thinking));
          } else if (block.type === "text" && "text" in block) {
            answer += String(block.text);
          }
        }
      }
    }

    return {
      answer,
      thinking,
      isError: false,
    };
  } catch (error) {
    // Return error as structured result instead of throwing
    // This allows MCP to signal errors via isError flag
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      answer: `Investigation failed: ${errorMessage}`,
      thinking: [],
      isError: true,
    };
  }
}
