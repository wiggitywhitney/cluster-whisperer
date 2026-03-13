// ABOUTME: Parses and validates the --agent CLI flag for agent framework selection
// ABOUTME: Maps agent type names (langgraph, vercel) to the agent factory

/**
 * Agent-type parsing for the --agent CLI flag.
 *
 * The "Choose Your Own Adventure" demo can switch between agent frameworks:
 * - langgraph: The existing LangGraph-based ReAct agent (default)
 * - vercel: Vercel AI SDK agent (PRD #49, not yet implemented)
 *
 * This module parses the flag value and validates that the agent type
 * is recognized. The default (langgraph) preserves backwards compatibility.
 */

/**
 * Valid agent type names that the --agent flag accepts.
 *
 * Each type maps to a different agent framework:
 * - langgraph: LangGraph createReactAgent (current implementation)
 * - vercel: Vercel AI SDK (placeholder for PRD #49)
 */
export const VALID_AGENT_TYPES = ["langgraph", "vercel"] as const;

/**
 * TypeScript type for a valid agent type name.
 * Derived from the VALID_AGENT_TYPES array so the type stays in sync.
 */
export type AgentType = (typeof VALID_AGENT_TYPES)[number];

/**
 * Default agent type when --agent is not specified.
 * LangGraph matches the existing behavior (before this flag existed).
 */
export const DEFAULT_AGENT_TYPE: AgentType = "langgraph";

/**
 * Parses an agent type string into a validated AgentType.
 *
 * @param input - Agent type name (e.g., "langgraph" or "vercel")
 * @returns Validated AgentType value
 * @throws Error if the agent type is unrecognized or input is empty
 *
 * @example
 * parseAgentType("langgraph") // → "langgraph"
 * parseAgentType("vercel")    // → "vercel"
 * parseAgentType("openai")    // throws: Unknown agent type: "openai"
 */
export function parseAgentType(input: string): AgentType {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(
      `Must specify an agent type. Valid types: ${VALID_AGENT_TYPES.join(", ")}`
    );
  }

  if (!VALID_AGENT_TYPES.includes(trimmed as AgentType)) {
    throw new Error(
      `Unknown agent type: "${trimmed}". Valid types: ${VALID_AGENT_TYPES.join(", ")}`
    );
  }

  return trimmed as AgentType;
}
