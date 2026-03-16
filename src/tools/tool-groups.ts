// ABOUTME: Parses and validates the --tools CLI flag for tool-group filtering
// ABOUTME: Maps group names (kubectl, vector, apply) to tool arrays for agent construction

/**
 * Tool-group parsing for the --tools CLI flag.
 *
 * The "Choose Your Own Adventure" demo uses progressive tool capabilities:
 * - Act 2: --tools kubectl (investigation only)
 * - Act 3: --tools kubectl,vector,apply (full capabilities)
 *
 * This module parses the comma-separated flag value and validates that
 * each group name is recognized. The default (kubectl,vector) preserves
 * backwards compatibility with the existing agent behavior.
 */

/**
 * Valid tool group names that the --tools flag accepts.
 *
 * Each group maps to one or more LangChain tools:
 * - kubectl: kubectl_get, kubectl_describe, kubectl_logs
 * - vector: vector_search
 * - apply: kubectl_apply
 */
export const VALID_TOOL_GROUPS = ["kubectl", "vector", "apply"] as const;

/**
 * TypeScript type for a valid tool group name.
 * Derived from the VALID_TOOL_GROUPS array so the type stays in sync.
 */
export type ToolGroup = (typeof VALID_TOOL_GROUPS)[number];

/**
 * Default tool groups when --tools is not specified.
 * kubectl + vector matches the existing agent behavior (before this flag existed).
 */
export const DEFAULT_TOOL_GROUPS: ToolGroup[] = ["kubectl", "vector"];

/**
 * Parses a comma-separated tool group string into a validated array.
 *
 * @param input - Comma-separated group names (e.g., "kubectl,vector,apply")
 * @returns Array of validated, deduplicated ToolGroup values
 * @throws Error if any group name is unrecognized or input is empty
 *
 * @example
 * parseToolGroups("kubectl,vector") // → ["kubectl", "vector"]
 * parseToolGroups("kubectl")        // → ["kubectl"]
 * parseToolGroups("bogus")          // throws: Unknown tool group: "bogus"
 */
export function parseToolGroups(input: string): ToolGroup[] {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(
      `Must specify at least one tool group. Valid groups: ${VALID_TOOL_GROUPS.join(", ")}`
    );
  }

  const groups = trimmed.split(",").map((g) => g.trim());
  const seen = new Set<ToolGroup>();

  for (const group of groups) {
    if (!VALID_TOOL_GROUPS.includes(group as ToolGroup)) {
      throw new Error(
        `Unknown tool group: "${group}". Valid groups: ${VALID_TOOL_GROUPS.join(", ")}`
      );
    }
    seen.add(group as ToolGroup);
  }

  return [...seen];
}
