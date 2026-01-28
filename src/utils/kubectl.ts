/**
 * kubectl.ts - Executes kubectl commands as subprocesses
 *
 * How it works:
 * 1. Takes an array of kubectl arguments (e.g., ["get", "pods", "-n", "default"])
 * 2. Spawns kubectl as a child process
 * 3. Returns the output as a string, or an error message if it fails
 *
 * Why spawnSync instead of execSync?
 * Both are synchronous (block until complete), but they differ in how they
 * handle arguments:
 *
 * - execSync(string): Passes the string to a shell (/bin/sh -c "...").
 *   This means shell metacharacters like ; | ` $() are interpreted.
 *   If args contained ["get", "pods; rm -rf /"], the shell would see TWO
 *   commands: "kubectl get pods" AND "rm -rf /". This is shell injection.
 *
 * - spawnSync(cmd, args[]): Bypasses the shell entirely. Each array element
 *   becomes a separate argument to the process. The string "pods; rm -rf /"
 *   is passed as a single argument to kubectl, which safely fails with
 *   "resource not found" instead of executing the injected command.
 *
 * Rule of thumb: Always use spawnSync with an args array when the arguments
 * come from any external source (user input, API calls, AI agents).
 *
 * OpenTelemetry instrumentation:
 * Each kubectl execution creates a span with both Viktor's attributes (for
 * KubeCon demo comparison) and OTel semconv attributes (for standards compliance).
 * See docs/opentelemetry-research.md Section 6 for attribute mapping details.
 */

import { spawnSync } from "child_process";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "../tracing";

/**
 * Result from executing a kubectl command.
 *
 * Why a structured result instead of just a string?
 * MCP tool responses include an `isError` flag to signal failures to clients.
 * Previously we detected errors by checking if output started with "Error",
 * but this caused false positives when legitimate output (like application logs)
 * contained error messages. By returning the error state explicitly based on
 * kubectl's exit code, we avoid content-based detection entirely.
 */
export interface KubectlResult {
  output: string;
  isError: boolean;
}

/**
 * Metadata extracted from kubectl args for tracing attributes.
 * We parse this from the args array to create meaningful span names
 * and attributes without changing the executeKubectl API.
 */
interface KubectlMetadata {
  operation: string; // get, describe, logs
  resource: string; // pods, deployments, etc.
  namespace: string | undefined; // from -n flag
}

/**
 * Extracts operation metadata from kubectl args for tracing.
 *
 * Kubectl commands follow predictable patterns:
 * - kubectl get pods -n default     → operation=get, resource=pods
 * - kubectl describe pod nginx      → operation=describe, resource=pod
 * - kubectl logs nginx -n default   → operation=logs, resource=nginx (pod name)
 *
 * @param args - kubectl arguments (without "kubectl" itself)
 * @returns Metadata for span naming and attributes
 */
function extractKubectlMetadata(args: string[]): KubectlMetadata {
  // Operation is always the first argument
  const operation = args[0] || "unknown";

  // Resource is typically the second argument
  // For logs, this is the pod name; for get/describe, it's the resource type
  const resource = args[1] || "unknown";

  // Find namespace from -n or --namespace flag
  let namespaceIndex = args.indexOf("-n");
  if (namespaceIndex === -1) {
    namespaceIndex = args.indexOf("--namespace");
  }
  const namespace =
    namespaceIndex !== -1 && args[namespaceIndex + 1]
      ? args[namespaceIndex + 1]
      : undefined;

  return { operation, resource, namespace };
}

/**
 * Executes a kubectl command and returns a structured result.
 *
 * Creates an OpenTelemetry span for the kubectl subprocess execution with:
 * - Span name: "kubectl {operation} {resource}" (e.g., "kubectl get pods")
 * - Span kind: CLIENT (outbound subprocess call)
 * - Attributes: Both Viktor's k8s.* and OTel semconv process.* attributes
 *
 * The span is automatically parented under the active MCP tool span (if any),
 * creating the hierarchy: execute_tool kubectl_get → kubectl get pods
 *
 * @param args - Array of arguments to pass to kubectl (e.g., ["get", "pods"])
 * @returns Object with output string and isError flag based on exit code
 *
 * Example:
 *   executeKubectl(["get", "pods", "-n", "default"])
 *   // Returns: { output: "NAME  READY  STATUS...", isError: false }
 *
 *   executeKubectl(["get", "nonexistent"])
 *   // Returns: { output: "Error executing...", isError: true }
 */
export function executeKubectl(args: string[]): KubectlResult {
  const tracer = getTracer();
  const metadata = extractKubectlMetadata(args);
  const startTime = Date.now();

  // Build the full command for display purposes (logging only, not execution)
  const command = `kubectl ${args.join(" ")}`;

  // Span name follows Viktor's pattern: "kubectl {operation} {resource}"
  // SpanKind.CLIENT = outbound call (we're calling kubectl subprocess)
  return tracer.startActiveSpan(
    `kubectl ${metadata.operation} ${metadata.resource}`,
    { kind: SpanKind.CLIENT },
    (span) => {
      // Set pre-execution attributes
      // Viktor's k8s.* attributes for KubeCon comparison
      span.setAttribute("k8s.client", "kubectl");
      span.setAttribute("k8s.operation", metadata.operation);
      span.setAttribute("k8s.resource", metadata.resource);
      span.setAttribute("k8s.args", args.join(" "));
      if (metadata.namespace) {
        span.setAttribute("k8s.namespace", metadata.namespace);
      }

      // OTel semconv process.* attributes for standards compliance
      span.setAttribute("process.executable.name", "kubectl");
      span.setAttribute("process.command_args", ["kubectl", ...args]);

      try {
        // spawnSync bypasses the shell - each array element is a separate argument.
        // This prevents shell injection even if args contain malicious characters.
        const result = spawnSync("kubectl", args, {
          encoding: "utf-8", // Return strings instead of Buffers
          timeout: 30000, // 30 second timeout to avoid hanging
        });

        // Calculate duration for Viktor's attribute
        const durationMs = Date.now() - startTime;
        span.setAttribute("k8s.duration_ms", durationMs);

        // Handle spawn errors (e.g., kubectl not found)
        if (result.error) {
          span.setAttribute("process.exit.code", -1);
          span.setAttribute("error.type", result.error.name);
          span.recordException(result.error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: result.error.message,
          });

          return {
            output: `Error executing "${command}": ${result.error.message}`,
            isError: true,
          };
        }

        // Set exit code (semconv attribute)
        span.setAttribute("process.exit.code", result.status ?? -1);

        // Handle non-zero exit codes (e.g., resource not found, permission denied)
        if (result.status !== 0) {
          const errorMessage = result.stderr || "Unknown error";
          span.setAttribute("error.type", "KubectlError");
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorMessage,
          });

          return {
            output: `Error executing "${command}": ${errorMessage}`,
            isError: true,
          };
        }

        // Success case
        span.setStatus({ code: SpanStatusCode.OK });

        return {
          output: result.stdout,
          isError: false,
        };
      } catch (error) {
        // Unexpected error during execution
        const durationMs = Date.now() - startTime;
        span.setAttribute("k8s.duration_ms", durationMs);
        span.setAttribute("process.exit.code", -1);

        if (error instanceof Error) {
          span.setAttribute("error.type", error.name);
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
        } else {
          span.setAttribute("error.type", "UnknownError");
          span.recordException(new Error(String(error)));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: String(error),
          });
        }

        return {
          output: `Error executing "${command}": ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      } finally {
        span.end();
      }
    }
  );
}
