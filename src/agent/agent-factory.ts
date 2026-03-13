// ABOUTME: Routes agent creation to the correct framework based on --agent flag
// ABOUTME: Currently supports langgraph; vercel is a placeholder for PRD #49

/**
 * Agent factory — constructs the right agent based on the --agent CLI flag.
 *
 * This factory decouples the CLI from specific agent implementations.
 * When PRD #49 adds the Vercel agent, it plugs in here without touching
 * the CLI or event streaming code.
 *
 * Currently supported:
 * - langgraph: Delegates to getInvestigatorAgent() (the existing agent)
 * - vercel: Throws "not yet implemented" (placeholder for PRD #49)
 */

import { getInvestigatorAgent } from "./investigator";
import { DEFAULT_AGENT_TYPE, type AgentType } from "./agent-types";
import { type ToolGroup } from "../tools/tool-groups";

/**
 * Options for creating an agent via the factory.
 */
export interface CreateAgentOptions {
  /** Which agent framework to use. Defaults to "langgraph". */
  agentType?: AgentType;
  /** Which tool groups to include. Passed through to the agent constructor. */
  toolGroups?: ToolGroup[];
}

/**
 * Creates an agent using the specified framework.
 *
 * @param options - Agent type and tool group configuration
 * @returns The constructed agent (currently always a LangGraph agent)
 * @throws Error if the requested agent type is not yet implemented
 */
export function createAgent(options: CreateAgentOptions = {}) {
  const agentType = options.agentType ?? DEFAULT_AGENT_TYPE;

  switch (agentType) {
    case "langgraph":
      return getInvestigatorAgent({ toolGroups: options.toolGroups });

    case "vercel":
      throw new Error(
        "Vercel agent is not yet implemented. See PRD #49 for the implementation plan."
      );

    default: {
      // Exhaustive check — TypeScript will error if a new AgentType is added
      // without handling it here
      const _exhaustive: never = agentType;
      throw new Error(`Unknown agent type: ${_exhaustive}`);
    }
  }
}
