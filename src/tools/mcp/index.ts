/**
 * MCP tool registration for kubectl operations
 *
 * This module registers the core kubectl functions as MCP tools. The MCP server
 * imports from here to expose tools to MCP clients like Claude Code or Cursor.
 *
 * How MCP tools work:
 * MCP (Model Context Protocol) is a standard for AI tools. An MCP server exposes
 * tools that any MCP client can call. The client's LLM (Claude, GPT, etc.) sees
 * the tool descriptions and decides when to use them - just like our CLI agent.
 *
 * The difference from CLI:
 * - CLI: Our LangChain agent does the reasoning and calls tools
 * - MCP: External client's LLM does the reasoning and calls our tools via MCP
 *
 * Same tools, different orchestrator.
 *
 * API Note:
 * We use registerTool() which is the recommended MCP SDK method. The older tool()
 * method is deprecated. registerTool() takes a config object with inputSchema
 * instead of separate positional arguments.
 *
 * Error Handling:
 * MCP tool responses can include an `isError: true` flag to signal errors to clients.
 * Our kubectl utility returns a structured result `{ output, isError }` where isError
 * is determined by kubectl's exit code, not by inspecting the output content. This
 * avoids false positives when legitimate output (like application logs) contains
 * error messages. MCP clients can distinguish between:
 * - Successful results (even if output contains "Error" in application logs)
 * - Actual kubectl failures (e.g., namespace not found, permission denied)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  kubectlGet,
  kubectlGetSchema,
  kubectlGetDescription,
  kubectlDescribe,
  kubectlDescribeSchema,
  kubectlDescribeDescription,
  kubectlLogs,
  kubectlLogsSchema,
  kubectlLogsDescription,
  type KubectlGetInput,
  type KubectlDescribeInput,
  type KubectlLogsInput,
} from "../core";
import { withToolTracing } from "../../tracing/tool-tracing";

/**
 * Registers all kubectl tools with an MCP server.
 *
 * Why a registration function instead of exporting tools directly?
 * MCP servers need tools registered via server.registerTool(). This function
 * takes a server instance and registers all our tools with it. The mcp-server.ts
 * entry point creates the server, calls this function, then starts transport.
 *
 * @param server - The McpServer instance to register tools with
 */
export function registerKubectlTools(server: McpServer): void {
  // kubectl_get - List resources in table format
  // Wrapped with tracing to create spans for observability
  server.registerTool(
    "kubectl_get",
    {
      description: kubectlGetDescription,
      inputSchema: kubectlGetSchema.shape,
    },
    withToolTracing("kubectl_get", async (input: KubectlGetInput) => {
      const { output, isError } = await kubectlGet(input);
      return {
        content: [{ type: "text", text: output }],
        isError,
      };
    })
  );

  // kubectl_describe - Get detailed resource information
  // Wrapped with tracing to create spans for observability
  server.registerTool(
    "kubectl_describe",
    {
      description: kubectlDescribeDescription,
      inputSchema: kubectlDescribeSchema.shape,
    },
    withToolTracing("kubectl_describe", async (input: KubectlDescribeInput) => {
      const { output, isError } = await kubectlDescribe(input);
      return {
        content: [{ type: "text", text: output }],
        isError,
      };
    })
  );

  // kubectl_logs - Get container logs
  // Wrapped with tracing to create spans for observability
  server.registerTool(
    "kubectl_logs",
    {
      description: kubectlLogsDescription,
      inputSchema: kubectlLogsSchema.shape,
    },
    withToolTracing("kubectl_logs", async (input: KubectlLogsInput) => {
      const { output, isError } = await kubectlLogs(input);
      return {
        content: [{ type: "text", text: output }],
        isError,
      };
    })
  );
}
