// ABOUTME: Truncates large tool results to fit within LLM context windows.
// ABOUTME: Keeps both head and tail of output so Events sections (at the bottom of kubectl describe) aren't lost.

/**
 * Truncates tool result text to prevent context window overflow.
 *
 * Why head + tail instead of just head?
 * kubectl describe puts Events at the bottom — that's the most useful section
 * for troubleshooting. A naive head-only truncation would cut off the gold.
 * Keeping both ends preserves the resource metadata (top) and Events (bottom),
 * while trimming the verbose middle (OpenAPI schemas, base64 certs, etc.).
 *
 * Why 50,000 characters?
 * ~12,500 tokens. Large enough that normal kubectl output (pods, services,
 * logs, resource describes) is never truncated. Only fires for degenerate
 * cases like Crossplane CRD describes with full OpenAPI validation schemas.
 * Even with 3 large results hitting the cap, total is ~37.5K tokens —
 * well within a 200K context window.
 *
 * @param text - The full tool output
 * @param maxChars - Maximum characters to keep (default 50,000)
 * @returns The original text if under the limit, or head + tail with a gap marker
 */
export function truncateToolResult(
  text: string,
  maxChars: number = 50000
): string {
  if (text.length <= maxChars) {
    return text;
  }

  // Reserve space for the separator message (~100 chars)
  const separatorBudget = 100;
  const keepEach = Math.floor((maxChars - separatorBudget) / 2);
  const head = text.slice(0, keepEach);
  const tail = text.slice(-keepEach);
  const omitted = text.length - keepEach * 2;

  return `${head}\n\n... [${omitted} characters omitted to fit context window] ...\n\n${tail}`;
}
