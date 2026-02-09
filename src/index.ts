#!/usr/bin/env node
/**
 * index.ts - CLI entry point for cluster-whisperer
 *
 * What this file does:
 * This is the main entry point when you run the cluster-whisperer command.
 * It takes a natural language question, sends it to the agent, and streams
 * the investigation process to the terminal so you can see what's happening.
 *
 * The shebang (#!/usr/bin/env node):
 * This line tells the OS to run this file with Node.js.
 * It's what makes `cluster-whisperer "question"` work after npm link.
 */

// Initialize OpenTelemetry tracing before any other imports
// This ensures the tracer provider is registered before any instrumented code runs
import "./tracing";

import { Command } from "commander";
import { HumanMessage } from "@langchain/core/messages";
import { execSync } from "child_process";
import { getInvestigatorAgent, truncate } from "./agent/investigator";
import { withAgentTracing, setTraceOutput } from "./tracing/context-bridge";

/**
 * Validates that the environment is properly configured before running the agent.
 *
 * Why validate upfront?
 * It's better to fail fast with a clear message than to get a cryptic error
 * deep in the LangChain stack. These checks catch the most common setup issues.
 */
function validateEnvironment(): void {
  // Check for Anthropic API key - required for the LLM
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
    console.error("");
    console.error("Export your API key:");
    console.error("  export ANTHROPIC_API_KEY=your-key-here");
    process.exit(1);
  }

  // Check that kubectl is available
  try {
    execSync("kubectl version --client", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    console.error("Error: kubectl is not installed or not in PATH.");
    console.error("");
    console.error("Install kubectl:");
    console.error("  https://kubernetes.io/docs/tasks/tools/");
    process.exit(1);
  }
}

/**
 * Main function - sets up the CLI and runs the agent
 */
async function main() {
  const program = new Command();

  program
    .name("cluster-whisperer")
    .description(
      "AI agent that answers natural language questions about Kubernetes clusters"
    )
    .version("0.1.0");

  program
    .argument("<question>", "Natural language question about your cluster")
    .action(async (question: string) => {
      // Validate environment before doing anything else
      validateEnvironment();

      console.log(`\nQuestion: ${question}\n`);

      /**
       * Wrap the entire agent invocation with tracing.
       *
       * withAgentTracing creates a root span and stores its context in
       * AsyncLocalStorage. This bridges the context gap that LangGraph creates,
       * ensuring tool spans properly nest under this root span.
       *
       * See src/tracing/context-bridge.ts for details on the workaround.
       */
      await withAgentTracing(question, async () => {
        /**
         * Stream events from the agent as it works.
         *
         * streamEvents() is a LangChain method that comes built into
         * the agent (see src/agent/investigator.ts for details).
         *
         * Why streamEvents instead of invoke?
         * invoke() waits until the agent is completely done, then returns the
         * final result. streamEvents() gives us a live feed of what's happening:
         * - When the agent decides to call a tool
         * - What arguments it passes
         * - What result it gets back
         *
         * This visibility is valuable for learning (see how the agent thinks)
         * and debugging (understand why it made certain choices).
         *
         * The version: "v2" parameter specifies the event format. v2 is the
         * current recommended format for LangGraph agents.
         */
        const eventStream = getInvestigatorAgent().streamEvents(
          { messages: [new HumanMessage(question)] },
          { version: "v2" }
        );

        /**
         * Track the final answer so we can display it at the end.
         * The agent might produce multiple messages, but we want the last
         * AI message which contains the summary answer.
         */
        let finalAnswer = "";

        /**
         * Process events as they stream in.
         *
         * LangGraph v2 streamEvents() emits on_chain_stream events, each
         * containing a chunk with one key indicating its source:
         * - "agent": AI message with content blocks and optional tool_calls
         * - "tools": Tool result message with string content
         *
         * The agent messages contain an array of content blocks:
         * - { type: "thinking", thinking: "..." } - Claude's reasoning process
         * - { type: "text", text: "..." } - response text shown to the user
         * - { type: "tool_use", ... } - tool call (also in msg.tool_calls)
         *
         * When the agent message has tool_calls, it's an intermediate step.
         * When it has no tool_calls, it's the final answer.
         */
        for await (const event of eventStream) {
          if (event.event !== "on_chain_stream") continue;

          const chunk = event.data?.chunk;
          if (!chunk) continue;

          // Agent message: AI decided something (tool call or final answer)
          if (chunk.agent?.messages) {
            for (const msg of chunk.agent.messages) {
              const content = msg.content;

              // Process content blocks (thinking, text, tool_use)
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "thinking") {
                    // Display thinking so users can see the reasoning process
                    // \x1b[3m starts italic, \x1b[0m resets formatting
                    console.log(`\x1b[3mThinking: ${block.thinking}\x1b[0m\n`);
                  }
                }
              }

              // Show tool calls if present (intermediate step)
              if (msg.tool_calls?.length) {
                for (const tc of msg.tool_calls) {
                  console.log(`🔧 Tool: ${tc.name}`);
                  console.log(`   Args: ${JSON.stringify(tc.args)}`);
                }
              } else {
                // No tool calls = final answer. Extract text from content blocks.
                finalAnswer = "";
                if (typeof content === "string") {
                  finalAnswer = content;
                } else if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block.type === "text") {
                      finalAnswer += block.text;
                    }
                  }
                }
              }
            }
          }

          // Tool result: kubectl output from a tool execution
          if (chunk.tools?.messages) {
            for (const msg of chunk.tools.messages) {
              console.log(`   Result:\n${truncate(String(msg.content), 1100)}`);
              console.log(); // blank line between tool calls
            }
          }
        }

        // Display the final answer with a separator for visibility
        if (finalAnswer) {
          // Record output on the trace for LLM Observability visibility
          setTraceOutput(finalAnswer);

          console.log("─".repeat(60));
          console.log("Answer:");
          console.log(finalAnswer);
          console.log();
        }
      });
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
