#!/usr/bin/env node
/**
 * mcp-server.ts - MCP server entry point for cluster-whisperer
 *
 * What is this file?
 * This is the entry point for the MCP (Model Context Protocol) server. When an
 * MCP client like Claude Code connects, it spawns this process. The server
 * exposes our investigate tool over stdio.
 *
 * How it works:
 * 1. Create an McpServer with our server info
 * 2. Register the investigate tool (wraps our LangGraph agent)
 * 3. Start the stdio transport (reads JSON-RPC from stdin, writes to stdout)
 * 4. Wait for the client to send tool requests
 *
 * Why a single investigate tool instead of low-level kubectl tools?
 * - Complete traces: One MCP call = one trace with all tool calls nested
 * - Better UX: Ask questions, get answers (same as CLI mode)
 * - Proper observability: See the full investigation flow in Datadog
 *
 * The investigate tool wraps the same LangGraph agent used by the CLI, so
 * MCP clients get the same investigation capabilities.
 */

// Initialize OpenTelemetry tracing before any other imports
// This ensures the tracer provider is registered before any instrumented code runs
import "./tracing";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerInvestigateTool } from "./tools/mcp";

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

  // Register the investigate tool with the server
  // This single tool wraps our LangGraph agent for complete investigations
  registerInvestigateTool(server);

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
