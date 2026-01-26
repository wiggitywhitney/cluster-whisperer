/**
 * kubectl-get core - Shared logic for listing Kubernetes resources
 *
 * This module contains the pure business logic for kubectl get, separate from
 * any framework (LangChain, MCP). Both the CLI agent and MCP server import
 * from here, ensuring consistent behavior across interfaces.
 *
 * Why separate core logic?
 * - CLI uses LangChain's tool() wrapper
 * - MCP uses @modelcontextprotocol/sdk's tool registration
 * - Both need the same schema validation and kubectl execution
 * - Extracting the core avoids duplicating logic and keeps behavior consistent
 */

import { z } from "zod";
import { executeKubectl, KubectlResult } from "../../utils/kubectl";

/**
 * Input schema for kubectl get.
 *
 * Why Zod?
 * Zod validates inputs at runtime and generates JSON Schema for tool definitions.
 * Both LangChain and MCP use this same schema, just wrapped differently.
 *
 * Fields:
 * - resource: Required. What kind of thing to list (pods, deployments, etc.)
 * - namespace: Optional. Where to look. Omit for current context, "all" for everywhere.
 * - name: Optional. Get one specific resource instead of listing all.
 */
export const kubectlGetSchema = z.object({
  resource: z
    .string()
    .describe(
      "The type of Kubernetes resource to list (e.g., 'pods', 'deployments', 'services', 'nodes')"
    ),
  namespace: z
    .string()
    .optional()
    .describe(
      "The namespace to query. Omit to use the current context's default namespace, or use 'all' for all namespaces"
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Specific resource name to get. Omit to list all resources of this type"
    ),
});

/**
 * TypeScript type derived from the schema.
 * Use this to get compile-time type checking for inputs.
 */
export type KubectlGetInput = z.infer<typeof kubectlGetSchema>;

/**
 * Tool description for LLMs.
 * Both LangChain and MCP tools use this same description so the AI
 * understands when and how to use the tool, regardless of which
 * interface it's accessing.
 */
export const kubectlGetDescription = `List Kubernetes resources in TABLE FORMAT (compact, one line per resource).

Returns columns like NAME, STATUS, READY, AGE. Use this to:
- See what resources exist in a namespace or cluster
- Check basic status (Running, Pending, CrashLoopBackOff, etc.)
- Find resources that need further investigation

For detailed information about a specific resource (events, configuration,
conditions), use kubectl_describe instead.

Common resources: pods, deployments, services, nodes, configmaps, namespaces.`;

/**
 * Execute kubectl get with the given parameters.
 *
 * This is the actual work - building the command and running it.
 * Framework wrappers (LangChain, MCP) call this function.
 *
 * @param input - Validated input matching kubectlGetSchema
 * @returns KubectlResult with output string and isError flag
 */
export async function kubectlGet(input: KubectlGetInput): Promise<KubectlResult> {
  const { resource, namespace, name } = input;

  // Build kubectl arguments: kubectl get <resource> [name] [-n namespace | -A]
  const args: string[] = ["get", resource];

  // Handle namespace: "all" means all namespaces, otherwise specific namespace
  if (namespace === "all") {
    args.push("-A");
  } else if (namespace) {
    args.push("-n", namespace);
  }

  // Add specific resource name if provided
  if (name) {
    args.push(name);
  }

  return executeKubectl(args);
}
