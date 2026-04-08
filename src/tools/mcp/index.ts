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
 * - "kubectl_get"           — list Kubernetes resources
 * - "kubectl_describe"      — detailed info about a specific resource
 * - "kubectl_logs"          — get container logs from a pod
 * - "vector_search"         — discover resources via the vector database
 * - "kubectl_apply_dryrun"  — validate manifest, store in session state, return sessionId
 * - "kubectl_apply"         — apply using sessionId (Layer 2 session state gate)
 *
 * Guardrails:
 * - Layer 1: Tool descriptions tell the AI what's in scope (prompt guidance)
 * - Layer 2: Session state gate — kubectl_apply accepts sessionId only (this module)
 * - Layer 3: ServiceAccount RBAC limits what the cluster will permit (PRD #120 M5)
 * - Layer 4: Kyverno admission control (PRD #121)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
  kubectlApplyDescription,
  kubectlApplyDryrun,
  kubectlApplyDryrunSchema,
  kubectlApplyDryrunDescription,
  type KubectlApplyDryrunInput,
  type KubectlOptions,
} from "../core";
import type { VectorStore } from "../../vectorstore";
import { withMcpRequestTracing } from "../../tracing/context-bridge";
import type { SessionStore } from "./session-store";

/**
 * Input schema for the MCP kubectl_apply tool.
 *
 * Accepts only a sessionId — not a manifest directly. The manifest was
 * stored in session state by kubectl_apply_dryrun and is retrieved here.
 * This prevents the AI from passing arbitrary YAML at apply time.
 */
const mcpKubectlApplySchema = z.object({
  sessionId: z
    .string()
    .min(1, "sessionId cannot be empty")
    .describe(
      "The session ID returned by kubectl_apply_dryrun. Required — kubectl_apply will not accept a manifest directly."
    ),
});

type McpKubectlApplyInput = z.infer<typeof mcpKubectlApplySchema>;

/**
 * Tool description for the MCP kubectl_apply tool.
 *
 * Describes the sessionId-based workflow and explains why direct manifest
 * input is not accepted (Layer 2 session state gate).
 */
const mcpKubectlApplyDescription = `Deploy a Kubernetes resource using a validated session.

IMPORTANT: This tool requires a sessionId from kubectl_apply_dryrun. It does NOT accept a manifest directly. The manifest was already validated and stored when you called kubectl_apply_dryrun.

Workflow:
1. Use vector_search to discover available resource types
2. Construct a YAML manifest for an approved resource type
3. Call kubectl_apply_dryrun — validates the manifest, returns a sessionId
4. Call this tool (kubectl_apply) with the sessionId to deploy

The catalog validation stays in place: only resource types in the capabilities catalog can be deployed. Kyverno (PRD #121) will add an additional cluster-level enforcement layer.`;

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
 * available in this cluster. Use this before kubectl_apply_dryrun to find the
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
          try {
            const output = await vectorSearch(vectorStore, input);
            return {
              content: [{ type: "text" as const, text: output }],
              isError: false,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Vector search failed: ${message}` }],
              isError: true,
            };
          }
        }
      );
    }
  );
}

/**
 * Registers the investigate-cluster prompt with an MCP server.
 *
 * This exposes the Kubernetes investigation strategy from prompts/investigator.md
 * as an MCP prompt resource. MCP clients (e.g. Claude Code) can invoke this prompt
 * to load the multi-step investigation strategy into their context.
 *
 * Research note (PRD #120 M3.5): MCP prompts are pull-based — the user must
 * explicitly invoke the prompt (e.g. via /mcp or a slash command). They are NOT
 * automatically applied as a system prompt to every conversation. This differs from
 * the LangGraph agent, which always has investigator.md baked into its system prompt.
 *
 * @param server - The McpServer instance to register the prompt with
 * @param content - The investigation strategy prompt content (from prompts/investigator.md)
 */
export function registerInvestigatePrompt(
  server: McpServer,
  content: string
): void {
  server.registerPrompt(
    "investigate-cluster",
    {
      description:
        "Load the Kubernetes cluster investigation strategy. Invoke this prompt to get step-by-step guidance on how to investigate cluster issues, discover platform capabilities, and deploy resources using the native kubectl tools.",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: content },
        },
      ],
    })
  );
}

/**
 * Registers the kubectl_apply_dryrun tool with an MCP server.
 *
 * This is Layer 2 of the guardrails design (PRD #120 M4). It validates a
 * manifest via kubectl dry-run and stores it in session state, returning a
 * sessionId. The AI must pass this sessionId to kubectl_apply — it cannot
 * pass arbitrary YAML at apply time.
 *
 * @param server - The McpServer instance to register the tool with
 * @param sessionStore - The shared SessionStore for this server instance
 * @param options - Optional kubectl configuration (e.g., kubeconfig path)
 */
export function registerDryrunTool(
  server: McpServer,
  sessionStore: SessionStore,
  options?: KubectlOptions
): void {
  server.registerTool(
    "kubectl_apply_dryrun",
    {
      description: kubectlApplyDryrunDescription,
      inputSchema: kubectlApplyDryrunSchema.shape,
    },
    async (input: KubectlApplyDryrunInput) => {
      return withMcpRequestTracing(
        "kubectl_apply_dryrun",
        // Redact manifest from traces — full YAML should not appear in span attributes
        { manifest: "[REDACTED]" } as Record<string, unknown>,
        async () => {
          const result = await kubectlApplyDryrun(input, sessionStore, options);

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
 * Registers the kubectl_apply tool with an MCP server.
 *
 * This is the apply side of the Layer 2 session state gate (PRD #120 M4).
 * The tool accepts a sessionId only — it reads the manifest from session state
 * (stored by kubectl_apply_dryrun) rather than accepting AI-generated YAML at
 * call time. The AI cannot inject arbitrary YAML at apply time.
 *
 * Kyverno handles admission enforcement at the cluster level (PRD #121 M3).
 *
 * @param server - The McpServer instance to register the tool with
 * @param sessionStore - The shared SessionStore for session state lookup
 * @param options - Optional kubectl configuration (e.g., kubeconfig path)
 */
export function registerApplyTool(
  server: McpServer,
  sessionStore: SessionStore,
  options?: KubectlOptions
): void {
  server.registerTool(
    "kubectl_apply",
    {
      description: mcpKubectlApplyDescription,
      inputSchema: mcpKubectlApplySchema.shape,
    },
    async (input: McpKubectlApplyInput) => {
      return withMcpRequestTracing(
        "kubectl_apply",
        // Redact sessionId from traces — it is a one-time capability token
        { sessionId: "[REDACTED]" } as Record<string, unknown>,
        async () => {
          // Peek at the session without consuming it — consume only after successful apply
          // so transient failures or catalog rejections leave the session intact for retry.
          const manifest = sessionStore.peek(input.sessionId);

          if (manifest === undefined) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Session not found or already used. Call kubectl_apply_dryrun first to validate your manifest and get a sessionId.`,
                },
              ],
              isError: true,
            };
          }

          // Kyverno enforces admission policy at the cluster level (PRD #121 M3)
          const result = await kubectlApply({ manifest }, options);

          // Consume session only on success — leave intact on failure so the AI can retry
          if (!result.isError) {
            sessionStore.consume(input.sessionId);
          }

          return {
            content: [{ type: "text" as const, text: result.output }],
            isError: result.isError,
          };
        }
      );
    }
  );
}
