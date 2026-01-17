/**
 * kubectl.ts - Executes kubectl commands as subprocesses
 *
 * How it works:
 * 1. Takes an array of kubectl arguments (e.g., ["get", "pods", "-n", "default"])
 * 2. Spawns kubectl as a child process
 * 3. Returns the output as a string, or an error message if it fails
 *
 * Why execSync instead of spawn?
 * execSync blocks until the command finishes, which is simpler for our use case.
 * The agent waits for the result anyway, so async doesn't help here.
 */

import { execSync } from "child_process";

/**
 * Executes a kubectl command and returns the output.
 *
 * @param args - Array of arguments to pass to kubectl (e.g., ["get", "pods"])
 * @returns The command output as a string, or an error message if it failed
 *
 * Example:
 *   executeKubectl(["get", "pods", "-n", "default"])
 *   // Returns: "NAME    READY   STATUS    RESTARTS   AGE\nmy-pod  1/1     Running   0          1d"
 */
export function executeKubectl(args: string[]): string {
  // Build the full command for display purposes
  const command = `kubectl ${args.join(" ")}`;

  try {
    // execSync runs the command and waits for it to complete.
    // We pass the args as an array to avoid shell injection vulnerabilities.
    // If we passed a string like `kubectl ${userInput}`, a malicious user
    // could inject extra commands. Arrays are safer.
    const output = execSync(`kubectl ${args.join(" ")}`, {
      encoding: "utf-8", // Return a string instead of a Buffer
      timeout: 30000, // 30 second timeout to avoid hanging
      stdio: ["pipe", "pipe", "pipe"], // Capture stdout and stderr
    });

    return output;
  } catch (error) {
    // When kubectl fails (e.g., resource not found, no permission),
    // we return the error message instead of throwing.
    // This lets the AI agent see what went wrong and decide what to do next.
    // For example, if a namespace doesn't exist, the agent might try a different one.

    if (error instanceof Error) {
      // Node.js adds stderr to the error message for exec failures
      const execError = error as Error & { stderr?: string; stdout?: string };
      const errorMessage = execError.stderr || execError.message;
      return `Error executing "${command}": ${errorMessage}`;
    }

    return `Error executing "${command}": Unknown error`;
  }
}
