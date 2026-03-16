#!/usr/bin/env node
// ABOUTME: CLI entry point for cluster-whisperer — handles investigate, sync, and serve subcommands.
// ABOUTME: Parses CLI arguments, orchestrates agent invocation, and flushes OTel traces on exit.

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
import { gracefulExit } from "./tracing";

import * as path from "node:path";
import { Command, Option } from "commander";
import { execSync } from "child_process";
import { truncate } from "./agent/investigator";
import { createAgent } from "./agent/agent-factory";
import { parseAgentType, DEFAULT_AGENT_TYPE } from "./agent/agent-types";
import { withAgentTracing, setTraceOutput } from "./tracing/context-bridge";
import { parseToolGroups, DEFAULT_TOOL_GROUPS } from "./tools/tool-groups";
import {
  parseVectorBackend,
  DEFAULT_VECTOR_BACKEND,
  createVectorStore,
  VoyageEmbedding,
  MultiBackendVectorStore,
} from "./vectorstore";
import type { VectorStore } from "./vectorstore";
import {
  syncCapabilities,
  discoverResources,
  inferCapabilities,
  storeCapabilities,
} from "./pipeline";
import { syncInstances } from "./pipeline/instance-runner";
import { executeKubectl } from "./utils/kubectl";
import type { AgentEvent } from "./agent/agent-events";

/**
 * Creates a kubectl executor bound to a specific kubeconfig path.
 * Used by sync commands to honor CLUSTER_WHISPERER_KUBECONFIG.
 * The returned function matches the DiscoveryOptions.kubectl signature.
 */
function createBoundKubectl(kubeconfig?: string) {
  if (!kubeconfig) return undefined;
  return (args: string[]) => executeKubectl(args, { kubeconfig });
}
import { createApp, startServer } from "./api/server";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

/**
 * Validates that kubectl is available.
 * Both the investigate and sync commands need kubectl.
 */
async function validateKubectl(): Promise<void> {
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
    await gracefulExit(1);
  }
}

/**
 * Validates that the Anthropic API key is set.
 * Both the investigate agent and the sync inference pipeline need it.
 */
async function validateAnthropicKey(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
    console.error("");
    console.error("Export your API key:");
    console.error("  export ANTHROPIC_API_KEY=your-key-here");
    await gracefulExit(1);
  }
}

/**
 * Validates that the Voyage AI API key is set.
 * Only the sync command needs this (for embedding capability descriptions).
 */
async function validateVoyageKey(): Promise<void> {
  if (!process.env.VOYAGE_API_KEY) {
    console.error("Error: VOYAGE_API_KEY environment variable is not set.");
    console.error("");
    console.error("Export your API key:");
    console.error("  export VOYAGE_API_KEY=your-key-here");
    await gracefulExit(1);
  }
}

/**
 * Validates environment for the investigate command.
 */
async function validateInvestigateEnvironment(): Promise<void> {
  await validateAnthropicKey();
  await validateKubectl();
}

/**
 * Validates environment for the sync command.
 * Needs everything investigate needs, plus Voyage AI for embeddings.
 */
async function validateSyncEnvironment(): Promise<void> {
  await validateAnthropicKey();
  await validateVoyageKey();
  await validateKubectl();
}

/**
 * Validates environment for the sync-instances command.
 * Needs Voyage AI for embeddings and kubectl for cluster access.
 * Does NOT need Anthropic — instance sync has no LLM inference step.
 */
async function validateInstanceSyncEnvironment(): Promise<void> {
  await validateVoyageKey();
  await validateKubectl();
}

/**
 * Validates environment for the serve command.
 * Needs Voyage AI for embeddings (upserts go through the embedding pipeline).
 * Needs Anthropic for capability inference (CRD scan triggers LLM calls).
 */
async function validateServeEnvironment(): Promise<void> {
  await validateVoyageKey();
  await validateAnthropicKey();
}

/**
 * Creates a VectorStore for sync operations.
 *
 * When no explicit --vector-backend is set and both chroma-url and qdrant-url
 * are available, creates a MultiBackendVectorStore that writes to both backends
 * from a single pipeline run — avoiding duplicate LLM inference costs.
 *
 * When --vector-backend is explicitly set, or only one URL is available,
 * creates a single-backend VectorStore (existing behavior).
 */
function createSyncVectorStore(options: {
  vectorBackend?: string;
  chromaUrl?: string;
  qdrantUrl?: string;
}): VectorStore {
  const embedder = new VoyageEmbedding();

  // Explicit backend selection — use single backend
  if (options.vectorBackend) {
    const backendType = parseVectorBackend(options.vectorBackend);
    return createVectorStore(embedder, backendType, {
      chromaUrl: options.chromaUrl,
      qdrantUrl: options.qdrantUrl,
    });
  }

  // Both URLs available — use multi-backend to populate both at once
  if (options.chromaUrl && options.qdrantUrl) {
    console.log("Both Chroma and Qdrant URLs detected — syncing to both backends"); // eslint-disable-line no-console
    const chroma = createVectorStore(embedder, "chroma", {
      chromaUrl: options.chromaUrl,
    });
    const qdrant = createVectorStore(embedder, "qdrant", {
      qdrantUrl: options.qdrantUrl,
    });
    return new MultiBackendVectorStore([chroma, qdrant]);
  }

  // Default — single backend (backwards compatible)
  return createVectorStore(embedder, DEFAULT_VECTOR_BACKEND, {
    chromaUrl: options.chromaUrl,
    qdrantUrl: options.qdrantUrl,
  });
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
    .addOption(
      new Option("--tools <groups>", `Comma-separated tool groups: kubectl, vector, apply (default: ${DEFAULT_TOOL_GROUPS.join(",")})`)
        .env("CLUSTER_WHISPERER_TOOLS")
    )
    .addOption(
      new Option("--agent <type>", `Agent framework: langgraph, vercel (default: ${DEFAULT_AGENT_TYPE})`)
        .env("CLUSTER_WHISPERER_AGENT")
    )
    .addOption(
      new Option("--vector-backend <backend>", `Vector database backend: chroma, qdrant (default: ${DEFAULT_VECTOR_BACKEND})`)
        .env("CLUSTER_WHISPERER_VECTOR_BACKEND")
    )
    .addOption(
      new Option("--thread <id>", "Conversation thread ID for multi-turn memory. Same ID resumes prior conversation.")
        .env("CLUSTER_WHISPERER_THREAD")
    )
    .action(async (question: string, options: { tools?: string; agent?: string; vectorBackend?: string; thread?: string }) => {
      // Validate environment before doing anything else
      await validateInvestigateEnvironment();

      // Parse tool groups from --tools flag (or use defaults)
      const toolGroups = options.tools
        ? parseToolGroups(options.tools)
        : DEFAULT_TOOL_GROUPS;

      // Parse agent type from --agent flag (or use default)
      const agentType = options.agent
        ? parseAgentType(options.agent)
        : DEFAULT_AGENT_TYPE;

      // Parse vector backend from --vector-backend flag (or use default)
      const vectorBackend = options.vectorBackend
        ? parseVectorBackend(options.vectorBackend)
        : DEFAULT_VECTOR_BACKEND;

      // Read kubeconfig from env var (demo governance: agent has cluster access, shell does not)
      const kubeconfig = process.env.CLUSTER_WHISPERER_KUBECONFIG || undefined;

      // Thread ID for multi-turn conversation memory
      const threadId = options.thread;

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
         * Create the agent and stream framework-agnostic AgentEvent objects.
         *
         * The agent factory returns an InvestigationAgent that abstracts over
         * the framework (LangGraph or Vercel AI SDK). The CLI only sees
         * AgentEvent objects — thinking, tool_start, tool_result, final_answer.
         *
         * Conversation memory is handled inside each agent's investigate()
         * method. The CLI just passes the threadId through.
         */
        const agent = createAgent({ agentType, toolGroups, vectorBackend, kubeconfig });

        /**
         * Track the final answer so we can display it at the end.
         * The agent might produce multiple messages, but we want the last
         * AI message which contains the summary answer.
         */
        let finalAnswer = "";

        /**
         * Process AgentEvent objects as they stream in.
         *
         * Each event type maps to a specific CLI display:
         * - thinking: Claude's reasoning (italic text)
         * - tool_start: Tool call with name and args (🔧 prefix)
         * - tool_result: Tool output (indented, truncated)
         * - final_answer: Agent's conclusion (after separator)
         */
        for await (const event of agent.investigate(question, { threadId }) as AsyncGenerator<AgentEvent>) {
          switch (event.type) {
            case "thinking":
              // Display thinking so users can see the reasoning process
              // \x1b[3m starts italic, \x1b[0m resets formatting
              console.log(`\x1b[3mThinking: ${event.content}\x1b[0m\n`);
              break;

            case "tool_start":
              console.log(`🔧 Tool: ${event.toolName}`);
              console.log(`   Args: ${JSON.stringify(event.args)}`);
              break;

            case "tool_result":
              console.log(`   Result:\n${truncate(event.result, 1100)}`);
              console.log(); // blank line between tool calls
              break;

            case "final_answer":
              finalAnswer = event.content;
              break;
          }
        }

        // Display the final answer with a separator for visibility
        if (finalAnswer !== undefined && finalAnswer !== "") {
          // Record output on the trace for LLM Observability visibility
          setTraceOutput(finalAnswer);

          console.log("─".repeat(60));
          console.log("Answer:");
          console.log(finalAnswer);
          console.log();
        } else {
          console.log("─".repeat(60)); // eslint-disable-line no-console
          console.log("The agent completed without producing a final answer."); // eslint-disable-line no-console
          console.log(); // eslint-disable-line no-console
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
    .option("--no-cache", "Disable inference caching (re-infer all resources)")
    .addOption(
      new Option("--chroma-url <url>", "Chroma server URL (default: http://localhost:8000)")
        .env("CLUSTER_WHISPERER_CHROMA_URL")
    )
    .addOption(
      new Option("--qdrant-url <url>", "Qdrant server URL (default: http://localhost:6333)")
        .env("CLUSTER_WHISPERER_QDRANT_URL")
    )
    .addOption(
      new Option("--vector-backend <backend>", `Vector database backend: chroma, qdrant (default: ${DEFAULT_VECTOR_BACKEND})`)
        .env("CLUSTER_WHISPERER_VECTOR_BACKEND")
    )
    .action(async (options: { dryRun?: boolean; cache?: boolean; chromaUrl?: string; qdrantUrl?: string; vectorBackend?: string }) => {
      await validateSyncEnvironment();

      const vectorStore = createSyncVectorStore(options);

      // Cache is enabled by default (--no-cache disables it).
      // Commander's --no-cache sets options.cache to false.
      const cacheDir = options.cache !== false
        ? path.join(process.cwd(), "data", "inference-cache")
        : undefined;

      if (cacheDir) {
        console.log(`Inference cache: ${cacheDir}`); // eslint-disable-line no-console
      } else {
        console.log("Inference cache: disabled"); // eslint-disable-line no-console
      }

      console.log("\nStarting capability sync...\n"); // eslint-disable-line no-console

      const kubeconfig = process.env.CLUSTER_WHISPERER_KUBECONFIG || undefined;
      const kubectl = createBoundKubectl(kubeconfig);

      try {
        const result = await syncCapabilities({
          vectorStore,
          dryRun: options.dryRun,
          cacheDir,
          ...(kubectl ? { discoveryOptions: { kubectl } } : {}),
        });

        // Exit with non-zero code if nothing was discovered (likely a cluster issue)
        if (result.discovered === 0) {
          console.error("\nNo resources discovered. Is kubectl connected to a cluster?");
          await gracefulExit(1);
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
        await gracefulExit(1);
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
    .addOption(
      new Option("--chroma-url <url>", "Chroma server URL (default: http://localhost:8000)")
        .env("CLUSTER_WHISPERER_CHROMA_URL")
    )
    .addOption(
      new Option("--qdrant-url <url>", "Qdrant server URL (default: http://localhost:6333)")
        .env("CLUSTER_WHISPERER_QDRANT_URL")
    )
    .addOption(
      new Option("--vector-backend <backend>", `Vector database backend: chroma, qdrant (default: ${DEFAULT_VECTOR_BACKEND})`)
        .env("CLUSTER_WHISPERER_VECTOR_BACKEND")
    )
    .action(async (options: { dryRun?: boolean; chromaUrl?: string; qdrantUrl?: string; vectorBackend?: string }) => {
      await validateInstanceSyncEnvironment();

      const vectorStore = createSyncVectorStore(options);

      const kubeconfig = process.env.CLUSTER_WHISPERER_KUBECONFIG || undefined;
      const kubectl = createBoundKubectl(kubeconfig);

      console.log("\nStarting instance sync...\n"); // eslint-disable-line no-console

      try {
        const result = await syncInstances({
          vectorStore,
          dryRun: options.dryRun,
          ...(kubectl ? { discoveryOptions: { kubectl } } : {}),
        });

        // Exit with non-zero code if nothing was discovered (likely a cluster issue)
        if (result.discovered === 0) {
          console.error("\nNo instances discovered. Is kubectl connected to a cluster?");
          await gracefulExit(1);
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
        await gracefulExit(1);
      }
    });

  // -------------------------------------------------------------------------
  // Serve subcommand: start HTTP server for receiving instance sync payloads
  // -------------------------------------------------------------------------

  program
    .command("serve")
    .description(
      "Start HTTP server to receive instance sync from k8s-vectordb-sync controller"
    )
    .option("--port <number>", "HTTP server port", "3000")
    .addOption(
      new Option("--chroma-url <url>", "Chroma server URL (default: http://localhost:8000)")
        .env("CLUSTER_WHISPERER_CHROMA_URL")
    )
    .addOption(
      new Option("--qdrant-url <url>", "Qdrant server URL (default: http://localhost:6333)")
        .env("CLUSTER_WHISPERER_QDRANT_URL")
    )
    .addOption(
      new Option("--vector-backend <backend>", `Vector database backend: chroma, qdrant (default: ${DEFAULT_VECTOR_BACKEND})`)
        .env("CLUSTER_WHISPERER_VECTOR_BACKEND")
    )
    .action(async (options: { port: string; chromaUrl?: string; qdrantUrl?: string; vectorBackend?: string }) => {
      await validateServeEnvironment();

      const port = parseInt(options.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Error: Invalid port number: ${options.port}`);
        await gracefulExit(1);
      }

      // Parse vector backend from --vector-backend flag (or use default)
      const backendType = options.vectorBackend
        ? parseVectorBackend(options.vectorBackend)
        : DEFAULT_VECTOR_BACKEND;

      // Create the vector store with Voyage AI embeddings
      const embedder = new VoyageEmbedding();
      const vectorStore = createVectorStore(embedder, backendType, {
        chromaUrl: options.chromaUrl,
        qdrantUrl: options.qdrantUrl,
      });

      const app = createApp({
        vectorStore,
        capabilities: {
          vectorStore,
          discoverResources,
          inferCapabilities,
          storeCapabilities,
        },
      });
      const server = startServer(app, { port });

      // Graceful shutdown on SIGTERM (Kubernetes sends this before killing the pod)
      process.on("SIGTERM", () => {
        console.log("\nReceived SIGTERM, shutting down..."); // eslint-disable-line no-console
        server.close(async () => {
          await gracefulExit(0);
        });
      });
    });

  await program.parseAsync(process.argv);
}

main().catch(async (error) => {
  console.error("Error:", error.message);
  await gracefulExit(1);
});
