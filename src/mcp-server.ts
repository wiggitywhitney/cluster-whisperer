#!/usr/bin/env node
/**
 * mcp-server.ts - MCP server entry point for cluster-whisperer
 *
 * What is this file?
 * This is the entry point for the MCP (Model Context Protocol) server. When an
 * MCP client like Claude Code connects, it spawns this process. The server
 * exposes our kubectl tools over stdio, letting the client's LLM use them.
 *
 * How it works:
 * 1. Create an McpServer with our server info
 * 2. Register all kubectl tools (get, describe, logs)
 * 3. Start the stdio transport (reads JSON-RPC from stdin, writes to stdout)
 * 4. Wait for the client to send tool requests
 *
 * CLI Agent vs MCP Server:
 * - CLI Agent (index.ts): Has its own reasoning. You ask a question, it decides
 *   which tools to call, interprets results, and gives you an answer.
 * - MCP Server (this file): Just tools. The client's LLM (Claude in Claude Code)
 *   does the reasoning and decides which tools to call.
 *
 * Same underlying tools, different orchestration model.
 */

// Initialize OpenTelemetry tracing before any other imports
// This ensures the tracer provider is registered before any instrumented code runs
import "./tracing";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerKubectlTools } from "./tools/mcp";

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

  // Register all kubectl tools with the server
  // After this, clients can call kubectl_get, kubectl_describe, kubectl_logs
  registerKubectlTools(server);

  // Create stdio transport - communicates via stdin/stdout
  // This is how local MCP servers work: the client spawns this process
  // and sends JSON-RPC messages over stdio
  const transport = new StdioServerTransport();

  // Connect the server to the transport and start listening
  // This blocks until the client disconnects
  await server.connect(transport);
}

// Run the server
main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
