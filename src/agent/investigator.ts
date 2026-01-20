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
import * as fs from "fs";
import * as path from "path";
import { kubectlGetTool } from "../tools/kubectl-get";
import { kubectlDescribeTool } from "../tools/kubectl-describe";
import { kubectlLogsTool } from "../tools/kubectl-logs";

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
      model: "claude-sonnet-4-20250514",
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

    cachedAgent = createReactAgent({
      llm: model,
      tools: [kubectlGetTool, kubectlDescribeTool, kubectlLogsTool],
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
