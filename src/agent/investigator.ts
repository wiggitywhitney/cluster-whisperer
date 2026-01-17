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

/**
 * Load the system prompt from a separate file.
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
const systemPrompt = fs.readFileSync(promptPath, "utf8");

/**
 * The language model that powers the agent.
 *
 * Why Claude Sonnet?
 * It's a good balance of capability and speed for this use case. Opus would be
 * more capable but slower and more expensive. Haiku would be faster but might
 * miss nuances in complex investigations.
 *
 * Why temperature: 0?
 * Temperature controls randomness. At 0, the model gives the most deterministic
 * response - it picks the most likely next token every time. For investigation
 * tasks, we want consistent, predictable behavior rather than creative variation.
 */
const model = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
  temperature: 0,
});

/**
 * The agent - combines the model, tools, and system prompt into a reasoning loop.
 *
 * createReactAgent handles the loop mechanics:
 * - Sends the user's question plus system prompt to the model
 * - If the model wants to call a tool, executes it and feeds back the result
 * - Keeps looping until the model produces a final answer (no more tool calls)
 *
 * The returned object (investigatorAgent) has LangChain methods built in:
 * - investigatorAgent.invoke() - run and return final result
 * - investigatorAgent.stream() - stream output chunks
 * - investigatorAgent.streamEvents() - stream detailed internal events (used in index.ts)
 *
 * stateModifier injects our system prompt at the start of every conversation.
 * This is how we tell the agent "you are a Kubernetes investigator" without
 * the user having to say it.
 */
export const investigatorAgent = createReactAgent({
  llm: model,
  tools: [kubectlGetTool],
  stateModifier: systemPrompt,
});

/**
 * Truncates a string to a maximum length, adding "..." if truncated.
 *
 * Why truncate?
 * kubectl output can be very long (imagine 100 pods, or verbose describe output).
 * When displaying tool results in the terminal, we want enough to understand
 * what happened without flooding the screen. 2000 chars shows about 20-25 lines
 * of typical kubectl output - enough to see patterns without overwhelming.
 *
 * @param text - The string to truncate
 * @param maxLength - Maximum length (default 2000)
 * @returns The truncated string with "..." suffix if it was shortened
 */
export function truncate(text: string, maxLength: number = 2000): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "...";
}
