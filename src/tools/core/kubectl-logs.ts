/**
 * kubectl-logs core - Shared logic for getting container logs
 *
 * This module contains the pure business logic for kubectl logs. Logs show
 * the APPLICATION's perspective - what's happening INSIDE the container.
 *
 * When to use logs vs describe?
 * - describe: Kubernetes' perspective (events, scheduling, resource status)
 * - logs: Application's perspective (errors, stack traces, startup messages)
 *
 * When a pod is in CrashLoopBackOff, describe shows "container exited with
 * code 1" but logs show the actual stack trace that caused the crash.
 */

import { z } from "zod";
import { executeKubectl } from "../../utils/kubectl";

/**
 * Input schema for kubectl logs.
 *
 * Why is namespace required (not optional)?
 * Unlike kubectl_get which can list across all namespaces, logs always come
 * from a specific pod in a specific namespace. Making it required prevents
 * confusion and ensures the agent explicitly specifies where to look.
 *
 * Why an args array instead of individual parameters?
 * kubectl logs has many flags (--previous, --tail, -c, --since, etc.).
 * An args array lets the agent use any of them without us defining each one.
 */
export const kubectlLogsSchema = z.object({
  pod: z
    .string()
    .describe(
      "The pod name to get logs from (use kubectl_get to find pod names first)"
    ),
  namespace: z
    .string()
    .describe("The namespace containing the pod (required for logs)"),
  args: z
    .array(z.string())
    .optional()
    .describe(
      'Optional flags: ["--previous"] for crashed containers, ["--tail=50"] to limit lines, ["-c", "container-name"] for multi-container pods'
    ),
});

/**
 * TypeScript type derived from the schema.
 */
export type KubectlLogsInput = z.infer<typeof kubectlLogsSchema>;

/**
 * Tool description for LLMs.
 * Emphasizes --previous flag since that's critical for debugging crashes.
 */
export const kubectlLogsDescription = `Get container logs from a pod. Shows the APPLICATION's perspective.

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
- -c <name>: Specify container in multi-container pods`;

/**
 * Execute kubectl logs with the given parameters.
 *
 * @param input - Validated input matching kubectlLogsSchema
 * @returns kubectl output as a string (container logs)
 */
export async function kubectlLogs(input: KubectlLogsInput): Promise<string> {
  const { pod, namespace, args: extraArgs } = input;

  // Build kubectl arguments: kubectl logs <pod> -n <namespace> [...extraArgs]
  const args: string[] = ["logs", pod, "-n", namespace];

  // Append extra args, but reject namespace flags (use the parameter instead)
  if (extraArgs && extraArgs.length > 0) {
    for (const arg of extraArgs) {
      if (arg === "-n" || arg === "--namespace" || arg.startsWith("--namespace=")) {
        return "Error: Do not pass -n/--namespace in args; use the namespace parameter instead.";
      }
    }
    args.push(...extraArgs);
  }

  return executeKubectl(args);
}
