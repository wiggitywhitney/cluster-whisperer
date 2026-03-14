// ABOUTME: Quiet mode utility for suppressing non-essential console output during demos.
// ABOUTME: Checks CLUSTER_WHISPERER_QUIET env var to gate OTel init and Chroma warnings.

/**
 * Check if quiet mode is enabled via environment variable.
 *
 * When enabled, non-essential console output is suppressed:
 * - [OTel] initialization messages
 * - Chroma SDK deprecation warnings
 *
 * Agent thinking, tool calls, and answers are always visible.
 *
 * Usage:
 *   CLUSTER_WHISPERER_QUIET=true cluster-whisperer "what pods are running?"
 */
export function isQuietMode(): boolean {
  const val = process.env.CLUSTER_WHISPERER_QUIET;
  return val === "true" || val === "1";
}
