/**
 * kubectl-describe.ts - Tool for getting detailed information about Kubernetes resources
 *
 * When to use kubectl_describe vs kubectl_get?
 * - kubectl_get: Lists resources in a compact table. Good for "what exists?"
 * - kubectl_describe: Shows detailed info about ONE resource. Good for "why isn't this working?"
 *
 * The killer feature of describe is the Events section at the bottom. Events show
 * what Kubernetes has been doing with the resource - scheduling decisions, image
 * pulls, container crashes, etc. When something isn't working, Events tell you why.
 *
 * Why is the description so directive?
 * The agent reads tool descriptions to decide which tool to use. By explicitly
 * saying "use kubectl_get first to find resources, then kubectl_describe for details"
 * we guide the agent toward an effective investigation flow.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { executeKubectl } from "../utils/kubectl";

/**
 * Input schema for kubectl_describe tool.
 *
 * Why is 'name' required here but optional in kubectl_get?
 * You describe a SPECIFIC resource to see its details. You can't describe "all pods"
 * in a useful way. So the agent must first use kubectl_get to find the resource name,
 * then use kubectl_describe with that specific name.
 *
 * This natural constraint creates the investigation flow we want:
 * 1. kubectl_get pods → sees "payments-api-7d4f9" is CrashLoopBackOff
 * 2. kubectl_describe pod payments-api-7d4f9 → sees Events showing OOMKilled
 */
const kubectlDescribeSchema = z.object({
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
 * kubectl_describe tool - Gets detailed information about a specific Kubernetes resource
 *
 * The description is crafted to guide the agent:
 * 1. Explains what describe returns (config, status, events, relationships)
 * 2. Emphasizes the Events section for troubleshooting
 * 3. Tells the agent to use kubectl_get first to find resource names
 */
export const kubectlDescribeTool = tool(
  async (input: z.infer<typeof kubectlDescribeSchema>) => {
    const { resource, name, namespace } = input;

    // Build the kubectl command arguments
    // Format: kubectl describe <resource> <name> [-n namespace]
    const args: string[] = ["describe", resource, name];

    // Add namespace flag if specified
    if (namespace) {
      args.push("-n", namespace);
    }

    // Execute kubectl and return the output
    // The agent will see detailed info including the Events section
    return executeKubectl(args);
  },
  {
    name: "kubectl_describe",
    description: `Get detailed information about a specific Kubernetes resource.

Returns comprehensive details including:
- Configuration (labels, annotations, containers, volumes)
- Current status and conditions
- Events (CRITICAL for troubleshooting - shows what Kubernetes is doing)

The Events section at the bottom shows recent activity: scheduling decisions,
image pulls, container starts/crashes, probe failures. When something isn't
working, check Events first - they explain WHY from Kubernetes' perspective.

Use kubectl_get first to find resource names, then kubectl_describe for details.`,
    schema: kubectlDescribeSchema,
  }
);
