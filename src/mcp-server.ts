#!/usr/bin/env node
// ABOUTME: MCP server entry point — exposes native kubectl tool handlers over stdio for MCP clients.
// ABOUTME: Uses gracefulExit to flush OTel traces before exiting on errors.

/**
 * mcp-server.ts - MCP server entry point for cluster-whisperer
 *
 * What is this file?
 * This is the entry point for the MCP (Model Context Protocol) server. When an
 * MCP client like Claude Code connects, it spawns this process. The server
 * exposes native kubectl tool handlers over stdio.
 *
 * How it works:
 * 1. Create an McpServer with our server info
 * 2. Register native kubectl tool handlers (kubectl_get, kubectl_describe, etc.)
 * 3. Start the stdio transport (reads JSON-RPC from stdin, writes to stdout)
 * 4. Wait for the client to send tool requests
 *
 * Architecture (PRD #120):
 * The MCP server exposes low-level kubectl tools directly. The AI coding
 * assistant (e.g. Claude Code) reasons about which tools to call and what
 * to do with the results — no LangGraph agent is invoked. Guardrails live
 * at the cluster level via ServiceAccount RBAC (M5) and Kyverno (PRD #121).
 */

// Initialize OpenTelemetry tracing before any other imports
// This ensures the tracer provider is registered before any instrumented code runs
import "./tracing";
import { gracefulExit } from "./tracing";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerGetTool,
  registerDescribeTool,
  registerLogsTool,
  registerVectorSearchTool,
  registerApplyTool,
  registerDryrunTool,
  registerInvestigatePrompt,
} from "./tools/mcp";
import { SessionStore } from "./tools/mcp/session-store";
import * as fs from "fs";
import * as path from "path";
import {
  createVectorStore,
  VoyageEmbedding,
  DEFAULT_VECTOR_BACKEND,
} from "./vectorstore";

/**
 * Creates and starts the MCP server.
 *
 * Why async?
 * The transport connection is asynchronous. We await it to ensure the server
 * is fully connected before the function returns.
 */
async function main(): Promise<void> {
  // Create the MCP server with metadata
  // Clients see this info when they connect (name, version)
  const server = new McpServer({
    name: "cluster-whisperer",
    version: "0.1.0",
  });

  // Read kubeconfig from env var for local/demo mode.
  // In-cluster mode (production) omits this and uses the ServiceAccount instead.
  const kubeconfig = process.env.CLUSTER_WHISPERER_KUBECONFIG || undefined;

  // Initialize vector store for vector_search and kubectl_apply (catalog validation).
  // Uses the default backend (chroma). The VOYAGE_API_KEY env var must be set
  // for semantic (embedding-based) searches; keyword-only searches work without it.
  const embedder = new VoyageEmbedding();
  const vectorStore = createVectorStore(embedder, DEFAULT_VECTOR_BACKEND, {
    chromaUrl: process.env.CHROMA_URL,
  });

  // Connect to existing collections (getOrCreateCollection — idempotent).
  // The sync pipeline populates these; the MCP server reads from them.
  await vectorStore.initialize("capabilities", { distanceMetric: "cosine" });
  await vectorStore.initialize("instances", { distanceMetric: "cosine" });

  // Create the session store singleton for the Layer 2 session state gate (PRD #120 M4).
  // Shared between kubectl_apply_dryrun and kubectl_apply — one store per server instance.
  const sessionStore = new SessionStore();

  // Register native read-only kubectl tool handlers (PRD #120 M3)
  registerGetTool(server, { kubeconfig });
  registerDescribeTool(server, { kubeconfig });
  registerLogsTool(server, { kubeconfig });
  registerVectorSearchTool(server, vectorStore);

  // Register the Layer 2 session state gate (PRD #120 M4):
  // - kubectl_apply_dryrun validates the manifest and stores it; returns sessionId
  // - kubectl_apply reads the manifest from session state via sessionId; catalog validation stays
  registerDryrunTool(server, sessionStore, { kubeconfig });
  registerApplyTool(server, vectorStore, sessionStore, { kubeconfig });

  // Register the investigate-cluster prompt resource (PRD #120 M3.5).
  // The prompt exposes the investigator.md strategy so MCP clients can invoke it
  // to load investigation guidance into their context on demand.
  // Path resolution: __dirname is dist/ at runtime, so ../prompts/ reaches the project root.
  const investigatorPath = path.join(__dirname, "..", "prompts", "investigator.md");
  const investigatorContent = fs.readFileSync(investigatorPath, "utf-8");
  registerInvestigatePrompt(server, investigatorContent);

  // Create stdio transport - communicates via stdin/stdout
  // This is how local MCP servers work: the client spawns this process
  // and sends JSON-RPC messages over stdio
  const transport = new StdioServerTransport();

  // Connect the server to the transport and start listening
  // This blocks until the client disconnects
  await server.connect(transport);
}

// Run the server
main().catch(async (error) => {
  console.error("MCP server error:", error);
  await gracefulExit(1);
});
