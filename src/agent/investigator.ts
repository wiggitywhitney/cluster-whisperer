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
import { HumanMessage } from "@langchain/core/messages";
import * as fs from "fs";
import * as path from "path";
import { kubectlTools, createVectorTools } from "../tools/langchain";
import { ChromaBackend, VoyageEmbedding } from "../vectorstore";

/**
 * The Anthropic model used by the investigator agent.
 * Exported so tracing code can reference the same model in span attributes.
 */
export const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

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
function createVectorToolsSafe() {
  try {
    const embedder = new VoyageEmbedding();
    const vectorStore = new ChromaBackend(embedder);
    return createVectorTools(vectorStore);
  } catch {
    // VoyageEmbedding requires VOYAGE_API_KEY. If not set, skip vector tools.
    return [];
  }
}

/**
 * Cached agent instance - created lazily on first use.
 *
 * Why lazy creation?
 * The ChatAnthropic constructor validates the API key immediately. If we create
 * the agent at module load time (when this file is imported), it throws before
 * our startup validation can show a friendly error message. By creating the
 * agent lazily, we let index.ts validate the environment first.
 */
let cachedAgent: ReturnType<typeof createReactAgent> | null = null;

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
 */
export function getInvestigatorAgent() {
  if (!cachedAgent) {
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

    // Create vector search tools with lazy-initialized Chroma backend.
    // The VoyageEmbedding and ChromaBackend are instantiated here but don't
    // connect to Chroma until the first vector tool call (lazy initialization).
    // If VOYAGE_API_KEY is not set, VoyageEmbedding throws — so we catch that
    // and skip vector tools, keeping the agent functional with kubectl only.
    const vectorTools = createVectorToolsSafe();

    cachedAgent = createReactAgent({
      llm: model,
      tools: [...kubectlTools, ...vectorTools],
      stateModifier: getSystemPrompt(),
    });
  }
  return cachedAgent;
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
    const result = await agent.invoke({
      messages: [new HumanMessage(question)],
    });

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
