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
       * Event types we care about:
       * - on_tool_start: Agent decided to call a tool, shows name and args
       * - on_tool_end: Tool finished, shows the result
       * - on_chat_model_end: Model finished generating, capture final answer
       *
       * There are many other event types (on_chain_start, on_llm_stream, etc.)
       * but these three give us the visibility we need without noise.
       */
      for await (const event of eventStream) {
        if (event.event === "on_tool_start") {
          // Agent is calling a tool - show which one and with what arguments
          // event.data.input contains the tool arguments
          const toolName = event.name;
          const toolInput = event.data.input;

          // The input might be nested in an 'input' property if it was serialized
          let args = toolInput;
          try {
            if (typeof toolInput === "object" && toolInput?.input) {
              args = JSON.parse(toolInput.input);
            }
          } catch {
            // If parsing fails, use the raw input - better than crashing
          }

          console.log(`🔧 Tool: ${toolName}`);
          console.log(`   Args: ${JSON.stringify(args)}`);
        }

        if (event.event === "on_tool_end") {
          // Tool finished - show the result (truncated to avoid flooding terminal)
          // event.data.output is a ToolMessage object with a .content property
          const output = event.data.output;
          const content = output?.content ?? output;
          console.log(`   Result:\n${truncate(String(content), 1100)}`);
          console.log(); // blank line between tool calls
        }

        if (event.event === "on_chat_model_end") {
          // Model finished generating - capture the response for final display
          // The output contains the message(s) the model produced
          // Content might be a string or an array of content blocks
          //
          // With extended thinking enabled, content includes both:
          // - type: "thinking" blocks - Claude's reasoning process
          // - type: "text" blocks - the actual response text
          const output = event.data.output;
          if (output?.content) {
            const content = output.content;
            if (typeof content === "string") {
              finalAnswer = content;
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "thinking") {
                  // Display thinking content so users can see the reasoning
                  // \x1b[3m starts italic, \x1b[0m resets formatting
                  console.log(`\x1b[3mThinking: ${block.thinking}\x1b[0m\n`);
                } else if (block.type === "text") {
                  // Capture text for final answer display
                  finalAnswer += block.text;
                }
              }
            }
          }
        }
      }

      // Display the final answer with a separator for visibility
      if (finalAnswer) {
        console.log("─".repeat(60));
        console.log("Answer:");
        console.log(finalAnswer);
        console.log();
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
