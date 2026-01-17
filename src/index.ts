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

import { Command } from "commander";
import { HumanMessage } from "@langchain/core/messages";
import { investigatorAgent, truncate } from "./agent/investigator";

/**
 * Main function - sets up the CLI and runs the agent
 *
 * Why async?
 * The agent streams events as it works. We use `for await` to process
 * each event as it arrives, which requires an async context.
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
      console.log(`\nQuestion: ${question}\n`);

      /**
       * Stream events from the agent as it works.
       *
       * streamEvents() is a LangChain method that comes built into
       * investigatorAgent (see src/agent/investigator.ts for details).
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
      const eventStream = investigatorAgent.streamEvents(
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
          const args =
            typeof toolInput === "object" && toolInput?.input
              ? JSON.parse(toolInput.input)
              : toolInput;

          console.log(`🔧 Tool: ${toolName}`);
          console.log(`   Args: ${JSON.stringify(args)}`);
        }

        if (event.event === "on_tool_end") {
          // Tool finished - show the result (truncated to avoid flooding terminal)
          // event.data.output is a ToolMessage object with a .content property
          const output = event.data.output;
          const content = output?.content ?? output;
          console.log(`   Result:\n${truncate(String(content), 2000)}`);
          console.log(); // blank line between tool calls
        }

        if (event.event === "on_chat_model_end") {
          // Model finished generating - capture the response for final display
          // The output contains the message(s) the model produced
          // Content might be a string or an array of content blocks
          const output = event.data.output;
          if (output?.content) {
            const content = output.content;
            if (typeof content === "string") {
              finalAnswer = content;
            } else if (Array.isArray(content)) {
              // Claude returns content as array of blocks, extract text
              finalAnswer = content
                .filter((block: { type: string }) => block.type === "text")
                .map((block: { text: string }) => block.text)
                .join("\n");
            }
          }
        }
      }

      // Display the final answer
      if (finalAnswer) {
        console.log("📋 Answer:");
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
