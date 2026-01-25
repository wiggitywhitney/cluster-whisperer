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
} from "../core";

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
  server.registerTool(
    "kubectl_get",
    {
      description: kubectlGetDescription,
      inputSchema: kubectlGetSchema.shape,
    },
    async (input) => {
      const result = await kubectlGet(input);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  // kubectl_describe - Get detailed resource information
  server.registerTool(
    "kubectl_describe",
    {
      description: kubectlDescribeDescription,
      inputSchema: kubectlDescribeSchema.shape,
    },
    async (input) => {
      const result = await kubectlDescribe(input);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  // kubectl_logs - Get container logs
  server.registerTool(
    "kubectl_logs",
    {
      description: kubectlLogsDescription,
      inputSchema: kubectlLogsSchema.shape,
    },
    async (input) => {
      const result = await kubectlLogs(input);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );
}
