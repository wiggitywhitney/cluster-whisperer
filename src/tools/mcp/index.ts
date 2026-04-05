// ABOUTME: MCP tool registration for cluster-whisperer — native kubectl tool handlers
// ABOUTME: Exposes direct kubectl operations to MCP clients; guardrails live at the cluster level

/**
 * MCP tool registration for cluster-whisperer
 *
 * This module registers native kubectl tool handlers for MCP clients.
 * Each handler calls the shared core functions in src/tools/core/ directly —
 * no LangGraph agent is invoked. The AI coding assistant (e.g. Claude Code)
 * reasons about which tools to call and what to do with the results.
 *
 * Tools registered here:
 * - "kubectl_get"      — list Kubernetes resources
 * - "kubectl_describe" — detailed info about a specific resource
 * - "kubectl_logs"     — get container logs from a pod
 * - "vector_search"    — discover resources via the vector database
 * - "kubectl_apply"    — apply a manifest; validates against the platform catalog
 *                        (catalog validation will be replaced by Kyverno in PRD #121)
 *
 * Guardrails:
 * - Layer 1: Tool descriptions tell the AI what's in scope (prompt guidance)
 * - Layer 3: ServiceAccount RBAC limits what the cluster will permit (PRD #120 M5)
 * - Layer 4: Kyverno admission control (PRD #121)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  kubectlGet,
  kubectlGetSchema,
  kubectlGetDescription,
  type KubectlGetInput,
  kubectlDescribe,
  kubectlDescribeSchema,
  kubectlDescribeDescription,
  type KubectlDescribeInput,
  kubectlLogs,
  kubectlLogsSchema,
  kubectlLogsDescription,
  type KubectlLogsInput,
  vectorSearch,
  vectorSearchSchema,
  vectorSearchDescription,
  type VectorSearchInput,
  kubectlApply,
  kubectlApplySchema,
  kubectlApplyDescription,
  type KubectlApplyInput,
  type KubectlOptions,
} from "../core";
import type { VectorStore } from "../../vectorstore";
import { withMcpRequestTracing } from "../../tracing/context-bridge";

/**
 * Registers the kubectl_get tool with an MCP server.
 *
 * Lists Kubernetes resources in table format. The AI coding assistant uses
 * this to discover what's running in the cluster before investigating specific
 * resources with kubectl_describe.
 *
 * @param server - The McpServer instance to register the tool with
 * @param options - Optional kubectl configuration (e.g., kubeconfig path)
 */
export function registerGetTool(
  server: McpServer,
  options?: KubectlOptions
): void {
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
          const result = await kubectlGet(input, options);

          return {
            content: [{ type: "text" as const, text: result.output }],
            isError: result.isError,
          };
        }
      );
    }
  );
}

/**
 * Registers the kubectl_describe tool with an MCP server.
 *
 * Returns detailed information about a specific resource, including the Events
 * section — the most important data for troubleshooting. The AI coding assistant
 * uses this after kubectl_get to investigate a specific resource's status.
 *
 * @param server - The McpServer instance to register the tool with
 * @param options - Optional kubectl configuration (e.g., kubeconfig path)
 */
export function registerDescribeTool(
  server: McpServer,
  options?: KubectlOptions
): void {
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
          const result = await kubectlDescribe(input, options);

          return {
            content: [{ type: "text" as const, text: result.output }],
            isError: result.isError,
          };
        }
      );
    }
  );
}

/**
 * Registers the kubectl_logs tool with an MCP server.
 *
 * Returns container logs from a pod, showing the application's perspective.
 * Use --previous flag via the args parameter to get logs from a crashed
 * container when debugging CrashLoopBackOff pods.
 *
 * @param server - The McpServer instance to register the tool with
 * @param options - Optional kubectl configuration (e.g., kubeconfig path)
 */
export function registerLogsTool(
  server: McpServer,
  options?: KubectlOptions
): void {
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
          const result = await kubectlLogs(input, options);

          return {
            content: [{ type: "text" as const, text: result.output }],
            isError: result.isError,
          };
        }
      );
    }
  );
}

/**
 * Registers the vector_search tool with an MCP server.
 *
 * Searches the vector database to discover what Kubernetes resources are
 * available in this cluster. Use this before kubectl_apply to find the
 * correct resource type for a given need (e.g., "managed database").
 *
 * @param server - The McpServer instance to register the tool with
 * @param vectorStore - An initialized VectorStore for searching
 */
export function registerVectorSearchTool(
  server: McpServer,
  vectorStore: VectorStore
): void {
  server.registerTool(
    "vector_search",
    {
      description: vectorSearchDescription,
      inputSchema: vectorSearchSchema.shape,
    },
    async (input: VectorSearchInput) => {
      return withMcpRequestTracing(
        "vector_search",
        input as Record<string, unknown>,
        async () => {
          const output = await vectorSearch(vectorStore, input);

          return {
            content: [{ type: "text" as const, text: output }],
            isError: false,
          };
        }
      );
    }
  );
}

/**
 * Registers the kubectl_apply tool with an MCP server.
 *
 * Unlike the investigate tool (which wraps the agent), this is a direct tool
 * that takes a YAML manifest and applies it to the cluster. MCP clients can
 * use this when they already know what resource to deploy.
 *
 * The tool validates against the platform catalog before applying — only
 * resource types in the capabilities collection are allowed.
 *
 * @param server - The McpServer instance to register the tool with
 * @param vectorStore - An initialized VectorStore for catalog validation
 */
export function registerApplyTool(
  server: McpServer,
  vectorStore: VectorStore
): void {
  server.registerTool(
    "kubectl_apply",
    {
      description: kubectlApplyDescription,
      inputSchema: kubectlApplySchema.shape,
    },
    async (input: KubectlApplyInput) => {
      return withMcpRequestTracing(
        "kubectl_apply",
        input as Record<string, unknown>,
        async () => {
          const result = await kubectlApply(vectorStore, input);

          return {
            content: [{ type: "text" as const, text: result.output }],
            isError: result.isError,
          };
        }
      );
    }
  );
}
