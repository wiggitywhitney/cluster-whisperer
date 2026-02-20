#!/usr/bin/env node
/**
 * index.ts - CLI entry point for cluster-whisperer
 *
 * What this file does:
 * This is the main entry point when you run the cluster-whisperer command.
 * It supports two modes:
 *
 * 1. Ask a question (default):
 *    cluster-whisperer "what pods are running?"
 *    Sends the question to the investigator agent and streams the response.
 *
 * 2. Sync capabilities:
 *    cluster-whisperer sync
 *    Scans the cluster's CRDs, infers what each one does via LLM, and stores
 *    the descriptions in the vector database for semantic search.
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
import { syncCapabilities } from "./pipeline";
import { syncInstances } from "./pipeline/instance-runner";
import { ChromaBackend, VoyageEmbedding } from "./vectorstore";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

/**
 * Validates that kubectl is available.
 * Both the investigate and sync commands need kubectl.
 */
function validateKubectl(): void {
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
 * Validates that the Anthropic API key is set.
 * Both the investigate agent and the sync inference pipeline need it.
 */
function validateAnthropicKey(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
    console.error("");
    console.error("Export your API key:");
    console.error("  export ANTHROPIC_API_KEY=your-key-here");
    process.exit(1);
  }
}

/**
 * Validates that the Voyage AI API key is set.
 * Only the sync command needs this (for embedding capability descriptions).
 */
function validateVoyageKey(): void {
  if (!process.env.VOYAGE_API_KEY) {
    console.error("Error: VOYAGE_API_KEY environment variable is not set.");
    console.error("");
    console.error("Export your API key:");
    console.error("  export VOYAGE_API_KEY=your-key-here");
    process.exit(1);
  }
}

/**
 * Validates environment for the investigate command.
 */
function validateInvestigateEnvironment(): void {
  validateAnthropicKey();
  validateKubectl();
}

/**
 * Validates environment for the sync command.
 * Needs everything investigate needs, plus Voyage AI for embeddings.
 */
function validateSyncEnvironment(): void {
  validateAnthropicKey();
  validateVoyageKey();
  validateKubectl();
}

/**
 * Validates environment for the sync-instances command.
 * Needs Voyage AI for embeddings and kubectl for cluster access.
 * Does NOT need Anthropic — instance sync has no LLM inference step.
 */
function validateInstanceSyncEnvironment(): void {
  validateVoyageKey();
  validateKubectl();
}

/**
 * Main function - sets up the CLI with investigate (default) and sync subcommands
 */
async function main() {
  const program = new Command();

  program
    .name("cluster-whisperer")
    .description(
      "AI agent that answers natural language questions about Kubernetes clusters"
    )
    .version("0.1.0");

  // -------------------------------------------------------------------------
  // Default command: ask a question
  // -------------------------------------------------------------------------

  program
    .argument("<question>", "Natural language question about your cluster")
    .action(async (question: string) => {
      // Validate environment before doing anything else
      validateInvestigateEnvironment();

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

  // -------------------------------------------------------------------------
  // Sync subcommand: populate vector DB with capability descriptions
  // -------------------------------------------------------------------------

  program
    .command("sync")
    .description(
      "Scan cluster CRDs and sync capability descriptions to the vector database"
    )
    .option("--dry-run", "Discover and infer capabilities without storing them")
    .option(
      "--chroma-url <url>",
      "Chroma server URL (default: CHROMA_URL env or http://localhost:8000)"
    )
    .action(async (options: { dryRun?: boolean; chromaUrl?: string }) => {
      validateSyncEnvironment();

      // Create the vector store with Voyage AI embeddings
      const embedder = new VoyageEmbedding();
      const vectorStore = new ChromaBackend(embedder, {
        chromaUrl: options.chromaUrl,
      });

      console.log("\nStarting capability sync...\n"); // eslint-disable-line no-console

      try {
        const result = await syncCapabilities({
          vectorStore,
          dryRun: options.dryRun,
        });

        // Exit with non-zero code if nothing was discovered (likely a cluster issue)
        if (result.discovered === 0) {
          console.error("\nNo resources discovered. Is kubectl connected to a cluster?");
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ECONNREFUSED") || message.includes("fetch")) {
          console.error(`\nChroma connection failed: ${message}`);
          console.error("Is Chroma running? Check --chroma-url or CHROMA_URL.");
        } else if (message.includes("API key") || message.includes("401") || message.includes("authentication")) {
          console.error(`\nAPI key error: ${message}`);
          console.error("Check ANTHROPIC_API_KEY and VOYAGE_API_KEY environment variables.");
        } else {
          console.error(`\nSync failed: ${message}`);
        }
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // Sync-instances subcommand: populate vector DB with resource instance metadata
  // -------------------------------------------------------------------------

  program
    .command("sync-instances")
    .description(
      "Sync resource instance metadata from the cluster to the vector database"
    )
    .option("--dry-run", "Discover instances without storing them")
    .option(
      "--chroma-url <url>",
      "Chroma server URL (default: CHROMA_URL env or http://localhost:8000)"
    )
    .action(async (options: { dryRun?: boolean; chromaUrl?: string }) => {
      validateInstanceSyncEnvironment();

      // Create the vector store with Voyage AI embeddings
      const embedder = new VoyageEmbedding();
      const vectorStore = new ChromaBackend(embedder, {
        chromaUrl: options.chromaUrl,
      });

      console.log("\nStarting instance sync...\n"); // eslint-disable-line no-console

      try {
        const result = await syncInstances({
          vectorStore,
          dryRun: options.dryRun,
        });

        // Exit with non-zero code if nothing was discovered (likely a cluster issue)
        if (result.discovered === 0) {
          console.error("\nNo instances discovered. Is kubectl connected to a cluster?");
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ECONNREFUSED") || message.includes("fetch")) {
          console.error(`\nChroma connection failed: ${message}`);
          console.error("Is Chroma running? Check --chroma-url or CHROMA_URL.");
        } else if (message.includes("API key") || message.includes("401") || message.includes("authentication")) {
          console.error(`\nAPI key error: ${message}`);
          console.error("Check VOYAGE_API_KEY environment variable.");
        } else {
          console.error(`\nSync failed: ${message}`);
        }
        process.exit(1);
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
