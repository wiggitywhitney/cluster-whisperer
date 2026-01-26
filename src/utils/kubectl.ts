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
 */

import { spawnSync } from "child_process";

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
 * Executes a kubectl command and returns a structured result.
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
  // Build the full command for display purposes (logging only, not execution)
  const command = `kubectl ${args.join(" ")}`;

  // spawnSync bypasses the shell - each array element is a separate argument.
  // This prevents shell injection even if args contain malicious characters.
  const result = spawnSync("kubectl", args, {
    encoding: "utf-8", // Return strings instead of Buffers
    timeout: 30000, // 30 second timeout to avoid hanging
  });

  // Handle spawn errors (e.g., kubectl not found)
  if (result.error) {
    return {
      output: `Error executing "${command}": ${result.error.message}`,
      isError: true,
    };
  }

  // Handle non-zero exit codes (e.g., resource not found, permission denied)
  if (result.status !== 0) {
    const errorMessage = result.stderr || "Unknown error";
    return {
      output: `Error executing "${command}": ${errorMessage}`,
      isError: true,
    };
  }

  return {
    output: result.stdout,
    isError: false,
  };
}
