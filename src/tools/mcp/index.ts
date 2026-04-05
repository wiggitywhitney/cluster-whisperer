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
 * - "kubectl_apply" — applies a Kubernetes manifest; validates against the
 *   platform catalog before applying (catalog validation will be replaced by
 *   Kyverno admission control in PRD #121)
 *
 * Guardrails:
 * - Layer 1: Tool descriptions tell the AI what's in scope (prompt guidance)
 * - Layer 3: ServiceAccount RBAC limits what the cluster will permit (PRD #120 M5)
 * - Layer 4: Kyverno admission control (PRD #121)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  kubectlApply,
  kubectlApplySchema,
  kubectlApplyDescription,
  type KubectlApplyInput,
} from "../core";
import type { VectorStore } from "../../vectorstore";
import { withMcpRequestTracing } from "../../tracing/context-bridge";

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
