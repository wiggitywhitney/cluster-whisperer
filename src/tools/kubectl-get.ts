/**
 * kubectl-get.ts - Tool for listing Kubernetes resources
 *
 * What is a "tool" in LangChain?
 * A tool is a function that an AI agent can call. The agent reads the tool's
 * description and schema to understand what it does and how to call it.
 * When the agent decides to use a tool, LangChain handles the plumbing:
 * parsing the agent's request, validating inputs, calling the function.
 *
 * Why the `tool` function?
 * LangChain's `tool` helper is the simplest way to define tools. You give it
 * a function with a Zod schema for its arguments, and it creates a tool the
 * agent can use. Clean, minimal boilerplate.
 *
 * Why is the description so detailed?
 * The description is the agent's only documentation for the tool. A good
 * description helps the agent know WHEN to use the tool and HOW to use it.
 * Think of it like API documentation for your AI teammate.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { executeKubectl } from "../utils/kubectl";

/**
 * Input schema for kubectl_get tool.
 *
 * Why Zod?
 * Zod validates the inputs at runtime. If the agent passes invalid arguments
 * (like forgetting a required field), Zod catches it with a clear error.
 * It also generates the JSON schema that tells the agent what inputs are expected.
 *
 * Why these specific fields?
 * - resource: Required. "pods", "deployments", "services", etc.
 * - namespace: Optional. If omitted, queries the current context's namespace.
 * - name: Optional. If provided, gets a specific resource instead of listing all.
 *
 * The .describe() calls add documentation that the agent can read to understand
 * each parameter's purpose.
 */
const kubectlGetSchema = z.object({
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
 * kubectl_get tool - Lists Kubernetes resources
 *
 * This is the tool object that gets passed to the LangChain agent.
 * The agent uses the name and description to decide when to call it.
 *
 * The `tool` function takes:
 * 1. An async function that does the work
 * 2. An options object with name, description, and schema
 */
export const kubectlGetTool = tool(
  async (input: z.infer<typeof kubectlGetSchema>) => {
    const { resource, namespace, name } = input;
    // Build the kubectl command arguments
    // Start with "get" and the resource type
    const args: string[] = ["get", resource];

    // Add namespace flag if specified
    // "-A" means "all namespaces", otherwise "-n <namespace>" for a specific one
    if (namespace === "all") {
      args.push("-A");
    } else if (namespace) {
      args.push("-n", namespace);
    }

    // Add resource name if looking for a specific one
    if (name) {
      args.push(name);
    }

    // Execute kubectl and return the output
    // The agent will see this output and can reason about what it means
    return executeKubectl(args);
  },
  {
    name: "kubectl_get",
    description: `List Kubernetes resources in TABLE FORMAT (compact, one line per resource).

Returns columns like NAME, STATUS, READY, AGE. Use this to:
- See what resources exist in a namespace or cluster
- Check basic status (Running, Pending, CrashLoopBackOff, etc.)
- Find resources that need further investigation

For detailed information about a specific resource (events, configuration,
conditions), use kubectl_describe instead.

Common resources: pods, deployments, services, nodes, configmaps, namespaces.`,
    schema: kubectlGetSchema,
  }
);
