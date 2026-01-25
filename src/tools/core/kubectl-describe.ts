/**
 * kubectl-describe core - Shared logic for getting detailed resource information
 *
 * This module contains the pure business logic for kubectl describe, separate
 * from any framework. The killer feature of describe is the Events section -
 * it shows what Kubernetes has been doing with the resource.
 *
 * When to use describe vs get?
 * - get: Lists resources in a compact table. "What exists?"
 * - describe: Shows detailed info about ONE resource. "Why isn't this working?"
 */

import { z } from "zod";
import { executeKubectl } from "../../utils/kubectl";

/**
 * Input schema for kubectl describe.
 *
 * Why is 'name' required here but optional in kubectl_get?
 * You describe a SPECIFIC resource to see its details. You can't describe
 * "all pods" usefully. The agent must first use kubectl_get to find the
 * resource name, then kubectl_describe with that specific name.
 */
export const kubectlDescribeSchema = z.object({
  resource: z
    .string()
    .describe(
      "The type of Kubernetes resource (e.g., 'pod', 'deployment', 'service', 'node')"
    ),
  name: z
    .string()
    .describe(
      "The name of the specific resource to describe (required - use kubectl_get first to find resource names)"
    ),
  namespace: z
    .string()
    .optional()
    .describe(
      "The namespace containing the resource. Omit to use the current context's default namespace"
    ),
});

/**
 * TypeScript type derived from the schema.
 */
export type KubectlDescribeInput = z.infer<typeof kubectlDescribeSchema>;

/**
 * Tool description for LLMs.
 * Emphasizes the Events section since that's where troubleshooting gold lives.
 */
export const kubectlDescribeDescription = `Get detailed information about a specific Kubernetes resource.

Returns comprehensive details including:
- Configuration (labels, annotations, containers, volumes)
- Current status and conditions
- Events (CRITICAL for troubleshooting - shows what Kubernetes is doing)

The Events section at the bottom shows recent activity: scheduling decisions,
image pulls, container starts/crashes, probe failures. When something isn't
working, check Events first - they explain WHY from Kubernetes' perspective.

Use kubectl_get first to find resource names, then kubectl_describe for details.`;

/**
 * Execute kubectl describe with the given parameters.
 *
 * @param input - Validated input matching kubectlDescribeSchema
 * @returns kubectl output as a string (detailed resource information)
 */
export async function kubectlDescribe(input: KubectlDescribeInput): Promise<string> {
  const { resource, name, namespace } = input;

  // Build kubectl arguments: kubectl describe <resource> <name> [-n namespace]
  const args: string[] = ["describe", resource, name];

  if (namespace) {
    args.push("-n", namespace);
  }

  return executeKubectl(args);
}
