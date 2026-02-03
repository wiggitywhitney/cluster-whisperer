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
import { withMcpRequestTracing } from "../../tracing/context-bridge";

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
  // Wrapped with MCP request tracing (root span) and tool tracing (nested span)
  // Hierarchy: cluster-whisperer.mcp.kubectl_get → kubectl_get.tool → kubectl subprocess
  server.registerTool(
    "kubectl_get",
    {
      description: kubectlGetDescription,
      inputSchema: kubectlGetSchema.shape,
    },
    async (input: KubectlGetInput) => {
      return withMcpRequestTracing(
        "kubectl_get",
        input as Record<string, unknown>,
        async () => {
          return withToolTracing(
            "kubectl_get",
            async (toolInput: KubectlGetInput) => {
              const { output, isError } = await kubectlGet(toolInput);
              return {
                content: [{ type: "text" as const, text: output }],
                isError,
              };
            }
          )(input);
        }
      );
    }
  );

  // kubectl_describe - Get detailed resource information
  // Wrapped with MCP request tracing (root span) and tool tracing (nested span)
  // Hierarchy: cluster-whisperer.mcp.kubectl_describe → kubectl_describe.tool → kubectl subprocess
  server.registerTool(
    "kubectl_describe",
    {
      description: kubectlDescribeDescription,
      inputSchema: kubectlDescribeSchema.shape,
    },
    async (input: KubectlDescribeInput) => {
      return withMcpRequestTracing(
        "kubectl_describe",
        input as Record<string, unknown>,
        async () => {
          return withToolTracing(
            "kubectl_describe",
            async (toolInput: KubectlDescribeInput) => {
              const { output, isError } = await kubectlDescribe(toolInput);
              return {
                content: [{ type: "text" as const, text: output }],
                isError,
              };
            }
          )(input);
        }
      );
    }
  );

  // kubectl_logs - Get container logs
  // Wrapped with MCP request tracing (root span) and tool tracing (nested span)
  // Hierarchy: cluster-whisperer.mcp.kubectl_logs → kubectl_logs.tool → kubectl subprocess
  server.registerTool(
    "kubectl_logs",
    {
      description: kubectlLogsDescription,
      inputSchema: kubectlLogsSchema.shape,
    },
    async (input: KubectlLogsInput) => {
      return withMcpRequestTracing(
        "kubectl_logs",
        input as Record<string, unknown>,
        async () => {
          return withToolTracing(
            "kubectl_logs",
            async (toolInput: KubectlLogsInput) => {
              const { output, isError } = await kubectlLogs(toolInput);
              return {
                content: [{ type: "text" as const, text: output }],
                isError,
              };
            }
          )(input);
        }
      );
    }
  );
}
