/**
 * kubectl-logs.ts - Tool for getting container logs from pods
 *
 * When to use kubectl_logs vs kubectl_describe?
 * - kubectl_describe: Shows Kubernetes' perspective - events, scheduling, resource status
 * - kubectl_logs: Shows the application's perspective - what's happening INSIDE the container
 *
 * Logs are essential for debugging application-level issues: crashes, errors, startup
 * failures, request handling problems. When a pod is in CrashLoopBackOff, describe
 * shows you "container exited with code 1" but logs show you the actual stack trace.
 *
 * Why the args array?
 * kubectl logs has many useful flags. Rather than hardcoding each one as a separate
 * parameter, we use an args array that accepts any valid kubectl logs flags. This
 * follows Viktor's pattern from dot-ai - flexible and future-proof.
 *
 * Common args the agent might use:
 * - ["--previous"]: Get logs from the PREVIOUS container instance (crashed/restarted)
 * - ["--tail=50"]: Limit to last 50 lines (useful for verbose applications)
 * - ["-c", "sidecar"]: Specify which container in a multi-container pod
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { executeKubectl } from "../utils/kubectl";

/**
 * Input schema for kubectl_logs tool.
 *
 * Why is namespace required (not optional)?
 * Unlike kubectl_get which can list across all namespaces, logs always come from
 * a specific pod in a specific namespace. Making it required prevents confusion
 * and ensures the agent explicitly specifies where to look.
 *
 * Why an args array instead of individual parameters?
 * kubectl logs has many flags (--previous, --tail, -c, --since, --timestamps, etc.).
 * An args array lets the agent use any of them without us having to define each one.
 * The description tells the agent which flags are most useful for investigation.
 */
const kubectlLogsSchema = z.object({
  pod: z
    .string()
    .describe(
      "The pod name to get logs from (use kubectl_get to find pod names first)"
    ),
  namespace: z
    .string()
    .describe(
      "The namespace containing the pod (required for logs)"
    ),
  args: z
    .array(z.string())
    .optional()
    .describe(
      'Optional flags: ["--previous"] for crashed containers, ["--tail=50"] to limit lines, ["-c", "container-name"] for multi-container pods'
    ),
});

/**
 * kubectl_logs tool - Gets container logs from a pod
 *
 * The description is crafted to:
 * 1. Contrast with kubectl_describe (K8s perspective vs app perspective)
 * 2. Emphasize --previous for debugging crashes
 * 3. Position logs as the final step in the investigation flow
 */
export const kubectlLogsTool = tool(
  async (input: z.infer<typeof kubectlLogsSchema>) => {
    const { pod, namespace, args: extraArgs } = input;

    // Build the kubectl command arguments
    // Format: kubectl logs <pod> -n <namespace> [...extraArgs]
    const args: string[] = ["logs", pod, "-n", namespace];

    // Append any extra args (--previous, --tail=N, -c container, etc.)
    // But reject namespace flags - use the namespace parameter instead
    if (extraArgs && extraArgs.length > 0) {
      for (const arg of extraArgs) {
        if (arg === "-n" || arg === "--namespace" || arg.startsWith("--namespace=")) {
          return "Error: Do not pass -n/--namespace in args; use the namespace parameter instead.";
        }
      }
      args.push(...extraArgs);
    }

    // Execute kubectl and return the output
    // The agent will see the application logs and can identify errors/crashes
    return executeKubectl(args);
  },
  {
    name: "kubectl_logs",
    description: `Get container logs from a pod. Shows the APPLICATION's perspective.

While kubectl_describe shows Kubernetes events (scheduling, image pulls, restarts),
logs show what's happening INSIDE the container: application errors, stack traces,
startup messages, request handling.

CRITICAL: Use --previous flag for crashed/restarted containers. When a pod is in
CrashLoopBackOff, the current container may have just started (empty logs). The
--previous flag gets logs from the crashed instance - where the actual error is.

Common investigation flow:
1. kubectl_get → find pod in CrashLoopBackOff
2. kubectl_describe → see "Back-off restarting failed container" in Events
3. kubectl_logs --previous → see the actual crash/error message

Other useful flags:
- --tail=N: Limit to last N lines (for verbose apps)
- -c <name>: Specify container in multi-container pods`,
    schema: kubectlLogsSchema,
  }
);
